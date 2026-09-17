// Focused, real-life-shaped test suite for the auto-submit machinery:
// - the two independent server-side sweeps for abandoned sessions
//   (admin's live-monitor poll, and a candidate's own next request)
// - the duplicate-IN_PROGRESS-session recovery path (the actual historical
//   nap_klu_2026 failure mode)
// - proctoring-triggered auto-submit (HIGH instant-terminate, and
//   MEDIUM/LOW warning-cap-triggered)
// - a synchronized mass timer-expiry burst under real Piston load, run the
//   exact way the FIXED client code now does it (concurrent evaluate calls,
//   8s bounded, then submit) -- this is the actual bug-3 regression target
// - a racing double-submit (client auto-submit and a stray manual submit
//   landing at nearly the same instant)
// - two regression checks: a genuinely-too-late submit must still be
//   rejected, and a genuinely-different device must still be blocked by the
//   concurrency lock -- proving the recent fixes didn't loosen either
//   safety boundary while fixing the false-positive cases
//
// Each test seeds its own tiny disposable drive/candidate(s), asserts, and
// cleans up after itself (even on failure) -- never leaves data behind.
//
// Usage: node auto_submit_edge_test.mjs <BASE_URL>
import { supabase } from "./_lib.mjs";

const BASE_URL = process.argv[2] || "http://localhost:3000";
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} -- ${name}${detail ? `\n       ${detail}` : ""}`);
}

async function postJson(path, body, extraHeaders = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...extraHeaders }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json, headers: res.headers };
}
async function getJson(path, extraHeaders = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: extraHeaders });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

let driveCounter = 0;
async function makeDrive(overrides = {}) {
  const now = new Date();
  driveCounter++;
  const tag = `${Date.now().toString(36)}-${driveCounter}`;
  const { data: drive, error } = await supabase
    .from("drives")
    .insert({
      title: `AUTOSUBMIT_TEST_${tag}`,
      slug: `autosubmit-test-${tag}`,
      exam_duration: 10,
      passing_cutoff: 0,
      proctoring_severity: "MEDIUM",
      max_cheat_warnings: 3,
      mcq_count: 2,
      coding_count: 1,
      shuffle_questions: false,
      shuffle_options: false,
      is_exam_active: true,
      reg_start: new Date(now.getTime() - 86_400_000).toISOString(),
      reg_end: new Date(now.getTime() + 86_400_000).toISOString(),
      exam_start: new Date(now.getTime() - 60_000).toISOString(),
      exam_end: new Date(now.getTime() + 20 * 60_000).toISOString(),
      webcam_proctoring_enabled: false,
      ...overrides,
    })
    .select()
    .single();
  if (error) throw error;

  const { data: mcqs, error: mcqErr } = await supabase
    .from("questions")
    .insert([
      { drive_id: drive.id, type: "MCQ", title: "Q1", content: "1+1=?", options: ["1", "2", "3", "4"], correct_answer: "2" },
      { drive_id: drive.id, type: "MCQ", title: "Q2", content: "2+2=?", options: ["3", "4", "5", "6"], correct_answer: "4" },
    ])
    .select();
  if (mcqErr) throw mcqErr;

  const { data: coding, error: codingErr } = await supabase
    .from("questions")
    .insert([
      {
        drive_id: drive.id,
        type: "CODING",
        title: "Double It",
        content: "Read an integer n, print 2*n.",
        // Deliberately a non-functional stub (mirrors every real boilerplate
        // in this app -- see the real nap_klu_2026 questions, e.g.
        // "function restockAlerts(input) {\n    // input is the stock array\n\n}").
        // examTiming.ts's JS-language grading path falls back to running
        // `boilerplate_code` verbatim when a candidate never touched a
        // coding question -- safe in every real exam because the stub never
        // does anything, but if it accidentally were a working solution
        // (like an earlier draft of this fixture had), an untouched
        // candidate would silently get free credit. Keep this stub
        // non-functional so this suite's "untouched question" tests
        // actually exercise the real 0-credit path, not that edge case.
        boilerplate_code: "function doubleIt(input) {\n  // TODO: implement\n}",
        test_cases: [
          { input: "5", expectedOutput: "10", isHidden: false },
          { input: "7", expectedOutput: "14", isHidden: true },
        ],
      },
    ])
    .select();
  if (codingErr) throw codingErr;

  return { drive, mcqs, coding: coding[0] };
}

async function makeCandidate(driveId, tag) {
  const { data, error } = await supabase
    .from("candidates")
    .insert({
      drive_id: driveId,
      name: `AutoSubmit Test ${tag}`,
      email: `autosubmit.${tag}@naprocs-loadtest.invalid`,
      phone: "9999999999",
      college_roll_number: `ASUB-${tag}`.toUpperCase(),
      access_pin: "123456",
      stage: "EXAM_PENDING",
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function cleanupDrive(driveId) {
  const { data: cands } = await supabase.from("candidates").select("id").eq("drive_id", driveId);
  const ids = (cands || []).map((c) => c.id);
  if (ids.length > 0) await supabase.from("exam_sessions").delete().in("candidate_id", ids);
  await supabase.from("candidates").delete().eq("drive_id", driveId);
  await supabase.from("questions").delete().eq("drive_id", driveId);
  await supabase.from("drives").delete().eq("id", driveId);
}

async function loginAndFetchQuestions(candidate) {
  const login = await postJson("/api/auth/exam-login", { identifier: candidate.college_roll_number, accessPin: "123456" });
  const q = await getJson(`/api/exam/questions?candidateId=${candidate.id}`);
  return { loginBody: login.body, questionsBody: q.body };
}

// ============================================================
// Test 1: lazy sweep via a candidate's own next request (no admin involved)
// ============================================================
async function test1() {
  const ctx = await makeDrive();
  try {
    const cand = await makeCandidate(ctx.drive.id, "t1");
    const { questionsBody } = await loginAndFetchQuestions(cand);
    if (!questionsBody.sessionId) return record("1. Lazy sweep via candidate's own next request", false, "No session created on initial fetch");

    // Simulate abandonment: force the deadline into the past, as if this
    // candidate's browser died mid-exam and never called submit.
    const pastDeadline = new Date(Date.now() - 5 * 60_000).toISOString();
    await supabase.from("exam_sessions").update({ deadline: pastDeadline }).eq("id", questionsBody.sessionId);

    // Their next request (a re-login attempt, or their app retrying the
    // questions fetch) should trigger the lazy sweep and finalize them.
    const retry = await getJson(`/api/exam/questions?candidateId=${cand.id}`);
    const { data: session } = await supabase.from("exam_sessions").select("status,end_reason").eq("id", questionsBody.sessionId).single();
    const { data: candRow } = await supabase.from("candidates").select("stage,exam_score").eq("id", cand.id).single();

    const pass = retry.body.expired === true && session.status === "COMPLETED" && candRow.stage !== "EXAM_PENDING";
    record("1. Lazy sweep via candidate's own next request", pass, `retry.expired=${retry.body.expired} session.status=${session.status} end_reason=${session.end_reason} candidate.stage=${candRow.stage} score=${candRow.exam_score}`);
  } finally {
    await cleanupDrive(ctx.drive.id);
  }
}

// ============================================================
// Test 2: proactive sweep via admin's live-monitor poll
// ============================================================
async function test2() {
  const ctx = await makeDrive();
  try {
    const cand = await makeCandidate(ctx.drive.id, "t2");
    const { questionsBody } = await loginAndFetchQuestions(cand);
    if (!questionsBody.sessionId) return record("2. Proactive sweep via admin live-monitor poll", false, "No session created on initial fetch");

    const pastDeadline = new Date(Date.now() - 5 * 60_000).toISOString();
    await supabase.from("exam_sessions").update({ deadline: pastDeadline }).eq("id", questionsBody.sessionId);

    const adminLogin = await postJson("/api/auth/admin-login", { passphrase: process.env.ADMIN_SECRET_PASSPHRASE_TEST || undefined });
    // Fall back to reading the real passphrase from .env the same way _lib.mjs does.
    let cookie = null;
    if (adminLogin.status !== 200) {
      const fs = await import("fs");
      const envText = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
      const m = envText.match(/^ADMIN_SECRET_PASSPHRASE=(.*)$/m);
      const passphrase = m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
      const retryLogin = await fetch(`${BASE_URL}/api/auth/admin-login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passphrase }) });
      cookie = retryLogin.headers.get("set-cookie");
    } else {
      cookie = adminLogin.headers.get("set-cookie");
    }
    if (!cookie) return record("2. Proactive sweep via admin live-monitor poll", false, "Could not obtain admin session cookie -- check ADMIN_SECRET_PASSPHRASE in .env");

    const liveMonitor = await getJson(`/api/admin/drives/${ctx.drive.id}/live-monitor`, { Cookie: cookie });
    const { data: session } = await supabase.from("exam_sessions").select("status,end_reason").eq("id", questionsBody.sessionId).single();

    const pass = liveMonitor.status === 200 && session.status === "COMPLETED";
    record("2. Proactive sweep via admin live-monitor poll", pass, `liveMonitor.status=${liveMonitor.status} session.status=${session.status} end_reason=${session.end_reason}`);
  } finally {
    await cleanupDrive(ctx.drive.id);
  }
}

// ============================================================
// Test 3: duplicate IN_PROGRESS sessions -- oldest-canonical sweep (the
// actual nap_klu_2026 failure shape)
// ============================================================
async function test3() {
  const ctx = await makeDrive();
  try {
    const cand = await makeCandidate(ctx.drive.id, "t3");
    const { questionsBody: q1 } = await loginAndFetchQuestions(cand);
    if (!q1.sessionId) return record("3. Duplicate IN_PROGRESS sessions -- oldest-canonical sweep", false, "No first session created");

    // Attempt to directly insert a SECOND, newer IN_PROGRESS session row for
    // the same candidate -- simulating the historical duplicate-session bug
    // (a stray request creating a second row instead of reusing the
    // existing one). supabase/migrations/010_exam_session_uniqueness.sql
    // added a unique partial index specifically to make this impossible at
    // the database level -- so the EXPECTED outcome here is that this
    // insert itself gets rejected (23505), not that the app has to recover
    // from a duplicate after the fact. That's a strictly stronger
    // guarantee than "the sweep resolves it gracefully".
    const { error: dupErr } = await supabase
      .from("exam_sessions")
      .insert({
        candidate_id: cand.id,
        status: "IN_PROGRESS",
        start_time: new Date().toISOString(),
        deadline: new Date(Date.now() - 5 * 60_000).toISOString(),
        current_stage: "MCQ",
        responses: {},
        question_ids: q1.questions?.map((qq) => qq._id ?? qq.id) || [],
      });

    const constraintBlockedIt = dupErr?.code === "23505";

    // Whether or not the duplicate insert was blocked, the real end-to-end
    // property still matters: a fresh login attempt must not crash and must
    // not leave anything stuck IN_PROGRESS past its deadline.
    await supabase.from("exam_sessions").update({ deadline: new Date(Date.now() - 5 * 60_000).toISOString() }).eq("id", q1.sessionId);
    const relogin = await postJson("/api/auth/exam-login", { identifier: cand.college_roll_number, accessPin: "123456" });
    const { data: sessions } = await supabase.from("exam_sessions").select("id,status").eq("candidate_id", cand.id);
    const stillInProgress = (sessions || []).filter((s) => s.status === "IN_PROGRESS").length;

    const pass = constraintBlockedIt && relogin.status !== 500 && stillInProgress === 0;
    record(
      "3. Duplicate IN_PROGRESS sessions -- blocked at the DB, sweep still safe",
      pass,
      `duplicate insert blocked by unique constraint=${constraintBlockedIt} (error: ${dupErr?.message || "none -- unexpected, duplicate was allowed through"}) relogin.status=${relogin.status} sessions=${sessions.length} stillInProgress=${stillInProgress}`
    );
  } finally {
    await cleanupDrive(ctx.drive.id);
  }
}

// ============================================================
// Test 4: proctoring-triggered auto-submit -- HIGH severity instant
// termination mid-exam, partial progress preserved
// ============================================================
async function test4() {
  const ctx = await makeDrive({ proctoring_severity: "HIGH" });
  try {
    const cand = await makeCandidate(ctx.drive.id, "t4");
    const { questionsBody } = await loginAndFetchQuestions(cand);
    if (!questionsBody.sessionId) return record("4. Proctoring HIGH-severity instant-terminate auto-submit", false, "No session created");

    const mcqs = (questionsBody.questions || []).filter((q) => q.type === "MCQ");
    const responses = { [mcqs[0]._id]: { selectedOption: mcqs[0].options[1] } }; // answer only the first MCQ, matching "caught mid-exam"

    // Mirrors dashboard/page.tsx's handleViolationSubmit for a HIGH-severity
    // hit: persistCheatWarning(1) then an immediate FULL_SUBMIT with reason
    // VIOLATION_HIGH_SEVERITY, carrying only whatever was answered so far.
    const submit = await postJson("/api/exam/submit", {
      sessionId: questionsBody.sessionId,
      candidateId: cand.id,
      finalResponses: responses,
      reason: "VIOLATION_HIGH_SEVERITY",
    });
    const { data: session } = await supabase.from("exam_sessions").select("status,end_reason").eq("id", questionsBody.sessionId).single();
    const { data: candRow } = await supabase.from("candidates").select("exam_score").eq("id", cand.id).single();

    // exam_score is a PERCENTAGE (floor(totalScore/maximumPossibleScore*100)),
    // not raw points -- 1 of 3 questions (2 MCQ + 1 coding, 10 raw pts each,
    // 30 max) correct, coding untouched -- 10/30 = 33%.
    const pass = submit.status === 200 && session.status === "COMPLETED" && session.end_reason === "VIOLATION_HIGH_SEVERITY" && candRow.exam_score === 33;
    record("4. Proctoring HIGH-severity instant-terminate auto-submit", pass, `submit.status=${submit.status} session.status=${session.status} end_reason=${session.end_reason} score=${candRow.exam_score} (expect 33 -- 1 correct MCQ of 3 questions, nothing else attempted)`);
  } finally {
    await cleanupDrive(ctx.drive.id);
  }
}

// ============================================================
// Test 5: MEDIUM-severity warning-cap auto-submit (3 warnings -> forced
// submit), also mid-exam with partial progress
// ============================================================
async function test5() {
  const ctx = await makeDrive({ proctoring_severity: "MEDIUM", max_cheat_warnings: 3 });
  try {
    const cand = await makeCandidate(ctx.drive.id, "t5");
    const { questionsBody } = await loginAndFetchQuestions(cand);
    if (!questionsBody.sessionId) return record("5. MEDIUM-severity warning-cap auto-submit", false, "No session created");

    const mcqs = (questionsBody.questions || []).filter((q) => q.type === "MCQ");
    const responses = { [mcqs[0]._id]: { selectedOption: mcqs[0].options[1] }, [mcqs[1]._id]: { selectedOption: mcqs[1].options[1] } };

    // Mirrors persistCheatWarning(3) followed by the reactive cap-check's
    // handleViolationSubmit("Max Warnings Exceeded", 'VIOLATION_MEDIUM_CAP').
    await postJson("/api/exam/sync", { sessionId: questionsBody.sessionId, candidateId: cand.id, incomingResponses: responses, cheatWarnings: 3 });
    const submit = await postJson("/api/exam/submit", {
      sessionId: questionsBody.sessionId,
      candidateId: cand.id,
      finalResponses: responses,
      reason: "VIOLATION_MEDIUM_CAP",
    });
    const { data: session } = await supabase.from("exam_sessions").select("status,end_reason").eq("id", questionsBody.sessionId).single();
    const { data: candRow } = await supabase.from("candidates").select("exam_score,cheat_warnings").eq("id", cand.id).single();

    // Both MCQs correct, coding untouched -- 20/30 raw = 66% (percentage, see test 4's comment).
    const pass = submit.status === 200 && session.status === "COMPLETED" && session.end_reason === "VIOLATION_MEDIUM_CAP" && candRow.cheat_warnings === 3 && candRow.exam_score === 66;
    record("5. MEDIUM-severity warning-cap auto-submit", pass, `submit.status=${submit.status} session.status=${session.status} end_reason=${session.end_reason} cheat_warnings=${candRow.cheat_warnings} score=${candRow.exam_score} (expect 66)`);
  } finally {
    await cleanupDrive(ctx.drive.id);
  }
}

// ============================================================
// Test 6: synchronized mass timer-expiry burst, replaying the FIXED
// client behavior exactly (concurrent evaluate calls, 8s bounded, then
// submit) under real simultaneous Piston load -- the actual bug-3 target.
// ============================================================
async function test6(N = 40) {
  const ctx = await makeDrive();
  const candidateIds = [];
  try {
    const candidates = [];
    for (let i = 0; i < N; i++) candidates.push(await makeCandidate(ctx.drive.id, `t6-${i}`));
    candidateIds.push(...candidates.map((c) => c.id));

    const sessions = [];
    for (const cand of candidates) {
      const { questionsBody } = await loginAndFetchQuestions(cand);
      sessions.push({ cand, sessionId: questionsBody.sessionId, questions: questionsBody.questions });
    }
    const missingSession = sessions.filter((s) => !s.sessionId);
    if (missingSession.length > 0) return record("6. Synchronized mass timer-expiry (fixed client behavior replayed)", false, `${missingSession.length}/${N} candidates never got a session`);

    // Everyone answers MCQs and writes a correct coding solution, then their
    // shared timer hits zero AT THE SAME INSTANT -- replay the fixed client
    // sequence: concurrent evaluate (8s bounded) across all N candidates'
    // coding question, THEN submit, all fired together.
    const t0 = Date.now();
    const outcomes = await Promise.all(sessions.map(async ({ cand, sessionId, questions }) => {
      const mcqs = (questions || []).filter((q) => q.type === "MCQ");
      const coding = (questions || []).filter((q) => q.type === "CODING")[0];
      const responses = {};
      mcqs.forEach((q) => { responses[q._id] = { selectedOption: q.options[1] }; });
      const code = "function doubleIt(input) { return input * 2; }";
      responses[coding._id] = { language: "javascript", codeStr: code };

      // Concurrent, 8s-bounded pre-submit evaluate -- exactly what
      // dashboard.tsx's handleSubmit now does.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const evalRes = await fetch(`${BASE_URL}/api/exam/evaluate`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ studentCode: code, questionId: coding._id, language: "javascript" }),
        });
        const evalData = await evalRes.json().catch(() => ({}));
        if (evalData.success) {
          const passed = (evalData.results || []).filter((r) => r.passed).length;
          responses[coding._id] = { ...responses[coding._id], testsPassed: passed, totalTests: (coding.test_cases || []).length };
        }
      } catch { /* bounded timeout hit -- fine, submit proceeds without it, exactly as designed */ }
      finally { clearTimeout(timeout); }

      const submit = await postJson("/api/exam/submit", { sessionId, candidateId: cand.id, finalResponses: responses, reason: "TIME_EXPIRED" });
      return { candId: cand.id, status: submit.status, error: submit.body?.error };
    }));
    const elapsed = Date.now() - t0;

    const rejectedAsExpired = outcomes.filter((o) => o.error === "Assessment window strictly expired.");
    const otherErrors = outcomes.filter((o) => o.status !== 200 && o.error !== "Assessment window strictly expired.");
    const { data: finalSessions } = await supabase.from("exam_sessions").select("candidate_id,status").in("candidate_id", candidateIds);
    const notCompleted = (finalSessions || []).filter((s) => s.status !== "COMPLETED");

    const pass = rejectedAsExpired.length === 0 && otherErrors.length === 0 && notCompleted.length === 0;
    record(
      "6. Synchronized mass timer-expiry (fixed client behavior replayed)",
      pass,
      `${N} candidates, total wall time ${(elapsed / 1000).toFixed(1)}s -- rejected-as-expired=${rejectedAsExpired.length} other-errors=${otherErrors.length} not-completed=${notCompleted.length}`
    );
    if (otherErrors.length > 0) console.log("   sample other errors:", otherErrors.slice(0, 3));
  } finally {
    await cleanupDrive(ctx.drive.id);
  }
}

// ============================================================
// Test 7: racing double-submit -- client auto-submit and a stray manual
// submit landing at nearly the same instant for the SAME session
// ============================================================
async function test7() {
  const ctx = await makeDrive();
  try {
    const cand = await makeCandidate(ctx.drive.id, "t7");
    const { questionsBody } = await loginAndFetchQuestions(cand);
    if (!questionsBody.sessionId) return record("7. Racing double-submit (idempotency)", false, "No session created");

    const mcqs = (questionsBody.questions || []).filter((q) => q.type === "MCQ");
    const responses = { [mcqs[0]._id]: { selectedOption: mcqs[0].options[1] } };

    const [r1, r2] = await Promise.all([
      postJson("/api/exam/submit", { sessionId: questionsBody.sessionId, candidateId: cand.id, finalResponses: responses, reason: "TIME_EXPIRED" }),
      postJson("/api/exam/submit", { sessionId: questionsBody.sessionId, candidateId: cand.id, finalResponses: responses, reason: "MANUAL" }),
    ]);
    const { data: session } = await supabase.from("exam_sessions").select("status").eq("id", questionsBody.sessionId).single();
    const { data: candRow } = await supabase.from("candidates").select("exam_score").eq("id", cand.id).single();

    const bothOk = r1.status === 200 && r2.status === 200;
    const pass = bothOk && session.status === "COMPLETED" && candRow.exam_score === 33; // 1/3 questions correct = 33%, see test 4's comment
    record("7. Racing double-submit (idempotency)", pass, `r1.status=${r1.status} r2.status=${r2.status} session.status=${session.status} score=${candRow.exam_score} (expect 33 -- both calls return 200, but only one score, not double-counted)`);
  } finally {
    await cleanupDrive(ctx.drive.id);
  }
}

// ============================================================
// Regression 8: a genuinely-too-late submit (past the 2-minute grace) must
// still be correctly rejected -- didn't accidentally loosen this
// ============================================================
async function test8() {
  const ctx = await makeDrive({ exam_end: new Date(Date.now() - 10 * 60_000).toISOString() });
  try {
    const cand = await makeCandidate(ctx.drive.id, "t8");
    // Can't log in normally (window already closed) -- insert the session
    // directly to isolate the submit-time check itself.
    const { data: session, error } = await supabase
      .from("exam_sessions")
      .insert({ candidate_id: cand.id, status: "IN_PROGRESS", start_time: new Date(Date.now() - 15 * 60_000).toISOString(), current_stage: "CODING", responses: {} })
      .select()
      .single();
    if (error) throw error;

    const submit = await postJson("/api/exam/submit", { sessionId: session.id, candidateId: cand.id, finalResponses: {}, reason: "MANUAL" });
    const pass = submit.status === 403 && /expired/i.test(submit.body?.error || "");
    record("8. Regression: genuinely-too-late submit still rejected", pass, `submit.status=${submit.status} error="${submit.body?.error}"`);
  } finally {
    await cleanupDrive(ctx.drive.id);
  }
}

// ============================================================
// Regression 9: a genuinely different device is still blocked by the
// concurrency lock (the reconnect-token fix must not have loosened this)
// ============================================================
async function test9() {
  const ctx = await makeDrive();
  try {
    const cand = await makeCandidate(ctx.drive.id, "t9");
    const first = await postJson("/api/auth/exam-login", { identifier: cand.college_roll_number, accessPin: "123456" });
    const second = await postJson("/api/auth/exam-login", { identifier: cand.college_roll_number, accessPin: "123456" }); // no existingToken -- a real second device has no way to have one
    const pass = first.status === 200 && second.status === 409;
    record("9. Regression: different device still blocked by concurrency lock", pass, `first.status=${first.status} second.status=${second.status}`);
  } finally {
    await cleanupDrive(ctx.drive.id);
  }
}

console.log(`Running auto-submit edge-case suite against ${BASE_URL}\n`);
await test1();
await test2();
await test3();
await test4();
await test5();
await test6(40);
await test7();
await test8();
await test9();

const passCount = results.filter((r) => r.pass).length;
console.log(`\n=== ${passCount}/${results.length} PASSED ===`);
if (passCount !== results.length) {
  console.log("Failures:", results.filter((r) => !r.pass).map((r) => r.name));
  process.exitCode = 1;
}
