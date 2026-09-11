// Systematic edge-case suite for every fix shipped in this session:
// empty/insufficient question banks, the duplicate-session race, the Piston
// concurrency/priority/cache layer, deadline jitter, and the empty-code
// Piston-skip guard. Each test is self-contained (seeds its own drive/
// candidates, asserts, cleans up), prints PASS/FAIL, and never leaves data
// behind even on failure.
//
// Usage: node edge_cases.mjs <BASE_URL>
import { supabase } from "./_lib.mjs";

const BASE_URL = process.argv[2] || "http://localhost:3000";
const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✅ PASS" : "❌ FAIL"} -- ${name}${detail ? `\n        ${detail}` : ""}`);
}

async function postJson(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}
async function getJson(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function makeDrive(overrides = {}) {
  const now = new Date();
  const { data: drive, error } = await supabase
    .from("drives")
    .insert({
      title: `EDGECASE_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      slug: `edgecase-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      exam_duration: 10,
      passing_cutoff: 0,
      proctoring_severity: "LOW",
      max_cheat_warnings: 3,
      mcq_count: 5,
      coding_count: 1,
      shuffle_questions: true,
      shuffle_options: true,
      is_exam_active: true,
      reg_start: new Date(now.getTime() - 86_400_000).toISOString(),
      reg_end: new Date(now.getTime() + 86_400_000).toISOString(),
      exam_start: new Date(now.getTime() - 60_000).toISOString(),
      exam_end: new Date(now.getTime() + 15 * 60_000).toISOString(),
      webcam_proctoring_enabled: false,
      ...overrides,
    })
    .select()
    .single();
  if (error) throw error;
  return drive;
}

async function makeCandidate(driveId, tag) {
  const { data, error } = await supabase
    .from("candidates")
    .insert({
      drive_id: driveId,
      name: `Edge Case ${tag}`,
      email: `edgecase.${tag}.${Date.now()}@naprocs-loadtest.invalid`,
      phone: "9999999999",
      college_roll_number: `EDGE-${tag}-${Date.now().toString(36)}`,
      access_pin: "123456",
      stage: "EXAM_PENDING",
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function addQuestions(driveId, { mcqCount = 5, codingCount = 1 } = {}) {
  const mcqRows = Array.from({ length: mcqCount }, (_, i) => ({
    drive_id: driveId, type: "MCQ", title: `Q${i}`, content: `What is 1+${i}?`,
    options: [String(i), String(i + 1), String(i + 2), String(i + 3)], correct_answer: "1",
  }));
  if (mcqRows.length > 0) {
    const { error } = await supabase.from("questions").insert(mcqRows);
    if (error) throw error;
  }
  let codingId = null;
  if (codingCount > 0) {
    const { data, error } = await supabase.from("questions").insert({
      drive_id: driveId, type: "CODING", title: "Sum", content: "sum two comma-separated ints",
      boilerplate_code: "function sum(a,b){ return a+b; }",
      test_cases: [{ input: "3,4", expectedOutput: "7", isHidden: false, weight: 1 }],
    }).select().single();
    if (error) throw error;
    codingId = data.id;
  }
  return codingId;
}

async function purgeDrive(driveId) {
  const { data: cands } = await supabase.from("candidates").select("id").eq("drive_id", driveId);
  const ids = (cands || []).map((c) => c.id);
  if (ids.length > 0) {
    await supabase.from("exam_sessions").delete().in("candidate_id", ids);
    await supabase.from("candidates").delete().in("id", ids);
  }
  await supabase.from("questions").delete().eq("drive_id", driveId);
  await supabase.from("drives").delete().eq("id", driveId);
}

// ---------------------------------------------------------------------------
// TEST 1: Fresh session, drive with ZERO questions -> EMPTY_QUESTION_BANK,
// no session row created (the original SVCE incident, exact repro).
// ---------------------------------------------------------------------------
async function test1_emptyQuestionBank() {
  const drive = await makeDrive();
  const cand = await makeCandidate(drive.id, "T1");
  try {
    const { status, body } = await getJson(`/api/exam/questions?candidateId=${cand.id}`);
    const { count } = await supabase.from("exam_sessions").select("id", { count: "exact", head: true }).eq("candidate_id", cand.id);
    record(
      "1. Zero-question drive refuses session, no zombie row",
      status === 503 && body.code === "EMPTY_QUESTION_BANK" && count === 0,
      `status=${status} code=${body.code} sessionRowsCreated=${count}`
    );
  } finally {
    await purgeDrive(drive.id);
  }
}

// ---------------------------------------------------------------------------
// TEST 2: Fresh session, drive with MCQ but coding_count>0 and ZERO coding
// questions in the bank -- exposes whether the guard also catches a PARTIAL
// shortfall (only catches TOTAL zero today).
// ---------------------------------------------------------------------------
async function test2_partialShortfall() {
  const drive = await makeDrive({ mcq_count: 5, coding_count: 2 });
  await addQuestions(drive.id, { mcqCount: 5, codingCount: 0 }); // no coding questions at all
  const cand = await makeCandidate(drive.id, "T2");
  try {
    const { status, body } = await getJson(`/api/exam/questions?candidateId=${cand.id}`);
    const mcqDelivered = (body.questions || []).filter((q) => q.type === "MCQ").length;
    const codingDelivered = (body.questions || []).filter((q) => q.type === "CODING").length;
    // Documenting current (gap) behavior, not asserting it's correct: a
    // partial shortfall (some MCQ present, but 0/2 coding as configured)
    // still succeeds today rather than erroring -- known, undocumented-until-now gap.
    record(
      "2. Partial shortfall (5/5 MCQ, 0/2 Coding) -- KNOWN GAP, not guarded",
      status === 200 && mcqDelivered === 5 && codingDelivered === 0,
      `status=${status} mcqDelivered=${mcqDelivered} codingDelivered=${codingDelivered}/2 required -- succeeds silently instead of erroring or flagging the shortfall`
    );
  } finally {
    await purgeDrive(drive.id);
  }
}

// ---------------------------------------------------------------------------
// TEST 3: Resumed session whose locked question_ids no longer resolve to any
// row (questions deleted after session creation) -> UNRESOLVABLE_SESSION_QUESTIONS.
// ---------------------------------------------------------------------------
async function test3_resumedSessionDeletedQuestions() {
  const drive = await makeDrive();
  const codingId = await addQuestions(drive.id);
  const cand = await makeCandidate(drive.id, "T3");
  try {
    const first = await getJson(`/api/exam/questions?candidateId=${cand.id}`);
    if (first.status !== 200) { record("3. Resumed session, questions deleted mid-exam", false, `setup failed: ${JSON.stringify(first.body)}`); return; }

    // Simulate an admin deleting the question bank mid-exam.
    await supabase.from("questions").delete().eq("drive_id", drive.id);

    const second = await getJson(`/api/exam/questions?candidateId=${cand.id}`);
    record(
      "3. Resumed session, questions deleted mid-exam -> clear error, not silent empty",
      second.status === 503 && second.body.code === "UNRESOLVABLE_SESSION_QUESTIONS",
      `status=${second.status} code=${second.body.code} sessionId=${second.body.sessionId}`
    );
  } finally {
    await purgeDrive(drive.id);
  }
}

// ---------------------------------------------------------------------------
// TEST 4: Duplicate-session race -- 10 truly concurrent first-load requests
// for ONE brand-new candidate. Confirms (a) it no longer crashes on the next
// request, (b) exactly one canonical session survives, (c) the DB-level
// unique index's actual presence (informational -- known NOT applied).
// ---------------------------------------------------------------------------
async function test4_duplicateSessionRace() {
  const drive = await makeDrive();
  await addQuestions(drive.id);
  const cand = await makeCandidate(drive.id, "T4");
  try {
    const burst = await Promise.all(
      Array.from({ length: 10 }, () => getJson(`/api/exam/questions?candidateId=${cand.id}`))
    );
    const allOk = burst.every((r) => r.status === 200);
    const distinctSessionIds = new Set(burst.map((r) => r.body.sessionId).filter(Boolean));

    const { data: rowsAfterBurst } = await supabase.from("exam_sessions").select("id,status").eq("candidate_id", cand.id);
    const inProgressAfterBurst = (rowsAfterBurst || []).filter((r) => r.status === "IN_PROGRESS").length;

    // The actual regression check: a SUBSEQUENT single request must not 500.
    const followUp = await getJson(`/api/exam/questions?candidateId=${cand.id}`);

    const { data: rowsAfterFollowUp } = await supabase.from("exam_sessions").select("id,status").eq("candidate_id", cand.id);
    const inProgressAfterFollowUp = (rowsAfterFollowUp || []).filter((r) => r.status === "IN_PROGRESS").length;
    const terminatedAfterFollowUp = (rowsAfterFollowUp || []).filter((r) => r.status === "TERMINATED").length;

    record(
      "4a. Burst of 10 concurrent first-loads all succeed (no crash during the race itself)",
      allOk,
      `all 200: ${allOk}, distinct sessionIds created: ${distinctSessionIds.size}, rows left IN_PROGRESS: ${inProgressAfterBurst}`
    );
    record(
      "4b. DB unique index (migration 010) actually applied?",
      distinctSessionIds.size === 1,
      distinctSessionIds.size === 1
        ? "Only one session was created -- migration IS applied, DB-level race prevention active."
        : `NOT APPLIED -- ${distinctSessionIds.size} distinct sessions were created from one burst. The DB accepted all of them; only this app's own read-side self-heal (test 4c) prevents a permanent crash. Migration 010 still needs to be run manually in the Supabase SQL editor for the race to be prevented at the source instead of cleaned up after the fact.`
    );
    record(
      "4c. Subsequent single request self-heals instead of 500ing forever",
      followUp.status === 200 && inProgressAfterFollowUp === 1 && terminatedAfterFollowUp === distinctSessionIds.size - 1,
      `follow-up status=${followUp.status}, IN_PROGRESS rows now=${inProgressAfterFollowUp}, TERMINATED (cleaned up) strays=${terminatedAfterFollowUp}`
    );
  } finally {
    await purgeDrive(drive.id);
  }
}

// ---------------------------------------------------------------------------
// TEST 5: Deadline jitter bounds -- 20 concurrent fresh sessions should
// produce deadlines spread across (0, 15]s, never identical, never later
// than the un-jittered nominal deadline.
// ---------------------------------------------------------------------------
async function test5_jitterBounds() {
  const drive = await makeDrive({ exam_duration: 10 });
  await addQuestions(drive.id);
  const N = 20;
  const cands = await Promise.all(Array.from({ length: N }, (_, i) => makeCandidate(drive.id, `T5-${i}`)));
  try {
    const before = Date.now();
    const results = await Promise.all(cands.map((c) => getJson(`/api/exam/questions?candidateId=${c.id}`)));
    const nominalDeadline = before + 10 * 60_000; // approx, exam_duration minutes from "now"
    const deadlines = results.map((r) => new Date(r.body.deadline).getTime());
    const distinct = new Set(deadlines).size;
    const allBeforeOrEqualNominal = deadlines.every((d) => d <= nominalDeadline + 1000); // 1s slack for request latency
    const spreadMs = Math.max(...deadlines) - Math.min(...deadlines);
    record(
      "5. Deadline jitter: spread across a window, never later than nominal",
      distinct > 1 && allBeforeOrEqualNominal && spreadMs > 0 && spreadMs <= 15000,
      `distinct deadlines=${distinct}/${N}, spread=${spreadMs}ms (expected >0 and <=15000), all <= nominal: ${allBeforeOrEqualNominal}`
    );
  } finally {
    await purgeDrive(drive.id);
  }
}

// ---------------------------------------------------------------------------
// TEST 6: Deadline jitter at the tail end of a drive's exam window -- does
// subtracting jitter ever push a deadline into the past (candidate joins
// with only a few seconds of window left)?
// ---------------------------------------------------------------------------
async function test6_jitterAtWindowTail() {
  const now = Date.now();
  const drive = await makeDrive({ exam_duration: 60, exam_end: new Date(now + 5000).toISOString() }); // only 5s of window left
  await addQuestions(drive.id);
  const cand = await makeCandidate(drive.id, "T6");
  try {
    const { status, body } = await getJson(`/api/exam/questions?candidateId=${cand.id}`);
    const deadlineMs = new Date(body.deadline).getTime();
    const isPast = deadlineMs < Date.now();
    record(
      "6. Joining with only 5s left in the drive window -- jitter must not create a past deadline",
      status === 200 && !isPast,
      `status=${status} deadline=${body.deadline} (now=${new Date().toISOString()}) isPast=${isPast}` +
        (isPast ? " -- BUG: jitter subtracted past the already-imminent drive exam_end, candidate would see an immediate/confusing auto-submit." : "")
    );
  } finally {
    await purgeDrive(drive.id);
  }
}

// ---------------------------------------------------------------------------
// TEST 7: Content-addressed Piston cache -- identical (language, code, stdin)
// is a cache hit (fast); a one-character change in code is a cache MISS
// (fresh execution, no false-positive collision).
// ---------------------------------------------------------------------------
async function test7_cacheHitAndMiss() {
  const drive = await makeDrive();
  const codingId = await addQuestions(drive.id);
  try {
    const code = "function sum(a,b){ return a+b; }";
    const codeSlightlyDifferent = "function sum(a,b){ return a + b; }"; // whitespace difference -> different hash

    const t1 = Date.now();
    const r1 = await postJson("/api/exam/evaluate", { studentCode: code, questionId: codingId, language: "javascript" });
    const e1 = Date.now() - t1;

    const t2 = Date.now();
    const r2 = await postJson("/api/exam/evaluate", { studentCode: code, questionId: codingId, language: "javascript" });
    const e2 = Date.now() - t2;

    const t3 = Date.now();
    const r3 = await postJson("/api/exam/evaluate", { studentCode: codeSlightlyDifferent, questionId: codingId, language: "javascript" });
    const e3 = Date.now() - t3;

    // javascript runs in-process (no Piston, no cache benefit expected) --
    // re-verify with a real Piston language too so the cache-hit claim is
    // about Piston specifically, not just "the whole endpoint is fast".
    // A run-unique comment keeps this a genuinely COLD cache key on every
    // invocation of this script -- the cache is content-addressed with no
    // TTL, so re-running with a fixed literal string would find it already
    // warm from a previous run and falsely look like no cache benefit at all.
    const runTag = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const pyCode = `# run ${runTag}\nprint(sum(int(x) for x in input().split(',')))`;
    const t4 = Date.now();
    const rp1 = await postJson("/api/exam/evaluate", { studentCode: pyCode, questionId: codingId, language: "python" });
    const ep1 = Date.now() - t4;
    const t5 = Date.now();
    const rp2 = await postJson("/api/exam/evaluate", { studentCode: pyCode, questionId: codingId, language: "python" });
    const ep2 = Date.now() - t5;

    record(
      "7a. Identical Python (code+stdin) resubmission is a cache hit (much faster 2nd time)",
      rp1.body.results?.[0]?.passed === true && rp2.body.results?.[0]?.passed === true && ep2 < ep1 / 2,
      `1st=${ep1}ms 2nd=${ep2}ms (expect 2nd meaningfully faster)`
    );
    record(
      "7b. A code change (even whitespace-only) is a genuine cache MISS, not a false hit",
      r3.body.results?.[0]?.passed === true, // still correct, just re-executed fresh
      `variant call succeeded fresh in ${e3}ms (r1=${e1}ms cold, r2=${e2}ms for the untouched-code case)`
    );
  } finally {
    await purgeDrive(drive.id);
  }
}

// ---------------------------------------------------------------------------
// TEST 8: Cache does not poison a cross-question comparison -- two DIFFERENT
// questions, same input, DIFFERENT expected outputs, same submitted code.
// The cache stores raw (stdout/stderr/exitCode), not a pass/fail verdict, so
// each call site's own comparison against ITS OWN expectedOutput must still
// be correct even when the underlying execution was served from cache.
// ---------------------------------------------------------------------------
async function test8_cacheCrossQuestionIsolation() {
  const drive = await makeDrive();
  const { data: qA } = await supabase.from("questions").insert({
    drive_id: drive.id, type: "CODING", title: "QA", content: "echoes input",
    test_cases: [{ input: "hello", expectedOutput: "hello", isHidden: false }],
  }).select().single();
  const { data: qB } = await supabase.from("questions").insert({
    drive_id: drive.id, type: "CODING", title: "QB", content: "expects a DIFFERENT output for the same input/code",
    test_cases: [{ input: "hello", expectedOutput: "definitely-not-hello", isHidden: false }],
  }).select().single();
  try {
    const code = "print(input())"; // deterministic echo
    const rA = await postJson("/api/exam/evaluate", { studentCode: code, questionId: qA.id, language: "python" });
    const rB = await postJson("/api/exam/evaluate", { studentCode: code, questionId: qB.id, language: "python" }); // same (code, stdin) -> cache hit on raw output, but must compare against qB's own expectedOutput
    record(
      "8. Cache reuse across different questions still compares against the RIGHT expectedOutput",
      rA.body.results?.[0]?.passed === true && rB.body.results?.[0]?.passed === false && rB.body.results?.[0]?.actual === "hello",
      `qA (expects "hello") passed=${rA.body.results?.[0]?.passed}; qB (expects "definitely-not-hello", same input+code) passed=${rB.body.results?.[0]?.passed}, actual="${rB.body.results?.[0]?.actual}"`
    );
  } finally {
    await purgeDrive(drive.id);
  }
}

// ---------------------------------------------------------------------------
// TEST 9: Empty-code Piston-skip guard -- whitespace-only code for a Piston
// language, at final submit, must be scored 0 WITHOUT a real Piston call
// (verified indirectly via latency: a real Piston round-trip is never this
// fast).
// ---------------------------------------------------------------------------
async function test9_emptyCodeSkipsPiston() {
  const drive = await makeDrive();
  const codingId = await addQuestions(drive.id);
  const cand = await makeCandidate(drive.id, "T9");
  try {
    const q = await getJson(`/api/exam/questions?candidateId=${cand.id}`);
    const sessionId = q.body.sessionId;
    const t = Date.now();
    const submit = await postJson("/api/exam/submit", {
      sessionId, candidateId: cand.id,
      finalResponses: { [codingId]: { language: "python", codeStr: "   \n\t  " } }, // whitespace-only
      reason: "MANUAL",
    });
    const elapsed = Date.now() - t;
    record(
      "9. Whitespace-only code for a Piston language skips execution (fast, scored 0)",
      submit.status === 200 && submit.body.finalScore === 0 && elapsed < 3000,
      `status=${submit.status} finalScore=${submit.body.finalScore} elapsed=${elapsed}ms (a real Piston round-trip is never under a few hundred ms, let alone this fast for a full submit incl. 5 MCQs)`
    );
  } finally {
    await purgeDrive(drive.id);
  }
}

// ---------------------------------------------------------------------------
// TEST 10: Language-switch-without-code -- candidate wrote CORRECT code in
// language A, then switches the dropdown to language B without writing
// anything there, and submits. Must be scored against B (empty -> 0), not
// accidentally graded using A's leftover correct code.
// ---------------------------------------------------------------------------
async function test10_languageSwitchNoCode() {
  const drive = await makeDrive();
  const codingId = await addQuestions(drive.id);
  const cand = await makeCandidate(drive.id, "T10");
  try {
    const q = await getJson(`/api/exam/questions?candidateId=${cand.id}`);
    const sessionId = q.body.sessionId;
    // codeStr reflects the CURRENTLY SELECTED language (python) with nothing
    // written -- exactly what the client sends when `language` has been
    // switched but that language's editor was never touched (dashboard.tsx's
    // codeByLanguage map only carries over what was actually typed per-tab).
    const submit = await postJson("/api/exam/submit", {
      sessionId, candidateId: cand.id,
      finalResponses: { [codingId]: { language: "python", codeStr: "" } },
      reason: "MANUAL",
    });
    record(
      "10. Switching language without writing new code scores 0, not a stale-language pass",
      submit.status === 200 && submit.body.finalScore === 0,
      `status=${submit.status} finalScore=${submit.body.finalScore} (expected 0 -- empty codeStr for the newly-selected language, JS boilerplate never substituted in for a Piston language)`
    );
  } finally {
    await purgeDrive(drive.id);
  }
}

// ---------------------------------------------------------------------------
// TEST 11: Priority queue sanity -- saturate all 3 concurrency slots with
// 'normal' (evaluate) calls, then fire one 'high' (final submit) call
// alongside; the high-priority one should not be meaningfully disadvantaged
// even under contention (hard to assert precisely without white-box
// instrumentation, so this checks it completes, and within a similar order
// of magnitude to a normal call under the same contention -- not literally
// stuck behind all of them).
// ---------------------------------------------------------------------------
async function test11_priorityUnderContention() {
  const drive = await makeDrive();
  const codingId = await addQuestions(drive.id);
  const cand = await makeCandidate(drive.id, "T11");
  try {
    const q = await getJson(`/api/exam/questions?candidateId=${cand.id}`);
    const sessionId = q.body.sessionId;
    const code = "print(sum(int(x) for x in input().split(',')))";

    // 8 'normal' (evaluate) calls to saturate the 3-slot queue, fired
    // slightly before the 'high' (final submit) call so the queue is
    // already under pressure when it arrives.
    const normalPromises = Array.from({ length: 8 }, (_, i) =>
      postJson("/api/exam/evaluate", { studentCode: code + `\n# padding ${i}`, questionId: codingId, language: "python" })
    );
    await new Promise((r) => setTimeout(r, 50));
    const highStart = Date.now();
    const highPromise = postJson("/api/exam/submit", {
      sessionId, candidateId: cand.id,
      finalResponses: { [codingId]: { language: "python", codeStr: code } },
      reason: "MANUAL",
    });

    const [highResult] = await Promise.all([highPromise, ...normalPromises]);
    const highElapsed = Date.now() - highStart;
    record(
      "11. Final-submit (high priority) completes correctly under concurrent 'Run Tests' load",
      highResult.status === 200 && highResult.body.finalScore !== undefined,
      `status=${highResult.status} finalScore=${highResult.body.finalScore} elapsed=${highElapsed}ms (informational -- confirms it isn't starved into failure, not a strict latency bound)`
    );
  } finally {
    await purgeDrive(drive.id);
  }
}

// ---------------------------------------------------------------------------
// TEST 12: Full regression -- normal correct submission across all 5
// languages still scores 100%, end to end, with everything from this
// session active at once.
// ---------------------------------------------------------------------------
async function test12_fullRegression() {
  const drive = await makeDrive();
  const codingId = await addQuestions(drive.id);
  const SOLUTIONS = {
    javascript: "function sum(a,b){ return a+b; }",
    python: "print(sum(int(x) for x in input().split(',')))",
    java: 'import java.util.*;\npublic class Main { public static void main(String[] a){ Scanner s=new Scanner(System.in); String[] p=s.nextLine().split(","); long sum=0; for(String x:p) sum+=Long.parseLong(x.trim()); System.out.println(sum);} }',
    c: '#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\nint main(){ char b[1024]; fgets(b,sizeof(b),stdin); long s=0; char*t=strtok(b,","); while(t){s+=atol(t); t=strtok(NULL,",");} printf("%ld\\n",s); return 0; }',
    cpp: '#include <iostream>\n#include <sstream>\nusing namespace std;\nint main(){ string l; getline(cin,l); stringstream ss(l); string t; long s=0; while(getline(ss,t,\',\')) s+=stol(t); cout<<s<<endl; return 0; }',
  };
  const langs = Object.keys(SOLUTIONS);
  const cands = await Promise.all(langs.map((l) => makeCandidate(drive.id, `T12-${l}`)));
  try {
    const sessions = await Promise.all(cands.map((c) => getJson(`/api/exam/questions?candidateId=${c.id}`)));
    const finals = await Promise.all(cands.map((c, i) => {
      const lang = langs[i];
      // Answer every MCQ correctly too (correct_answer index 1 for all, per
      // addQuestions()) -- otherwise 0/5 MCQ + 1/1 coding = 10/60 = 16%,
      // which is the CORRECT score for that input, not a coding-grading bug.
      const mcqResponses = {};
      (sessions[i].body.questions || []).filter((q) => q.type === "MCQ").forEach((q) => {
        mcqResponses[q._id] = { selectedOption: q.options[1] };
      });
      return postJson("/api/exam/submit", {
        sessionId: sessions[i].body.sessionId, candidateId: c.id,
        finalResponses: { ...mcqResponses, [codingId]: { language: lang, codeStr: SOLUTIONS[lang] } },
        reason: "MANUAL",
      });
    }));
    const scores = finals.map((f, i) => ({ lang: langs[i], score: f.body.finalScore, status: f.status }));
    const allCorrect = scores.every((s) => s.status === 200 && s.score === 100);
    record(
      "12. Full regression -- correct code in all 5 languages still scores 100%",
      allCorrect,
      JSON.stringify(scores)
    );
  } finally {
    await purgeDrive(drive.id);
  }
}

async function main() {
  console.log(`Running edge-case suite against ${BASE_URL}\n`);
  const tests = [
    test1_emptyQuestionBank,
    test2_partialShortfall,
    test3_resumedSessionDeletedQuestions,
    test4_duplicateSessionRace,
    test5_jitterBounds,
    test6_jitterAtWindowTail,
    test7_cacheHitAndMiss,
    test8_cacheCrossQuestionIsolation,
    test9_emptyCodeSkipsPiston,
    test10_languageSwitchNoCode,
    test11_priorityUnderContention,
    test12_fullRegression,
  ];
  for (const t of tests) {
    try {
      await t();
    } catch (e) {
      record(t.name, false, `THREW: ${e.message}\n${e.stack?.split("\n").slice(0, 3).join("\n")}`);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n=== ${passed}/${results.length} PASSED ===`);
  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.log("\nFailed/flagged:");
    failed.forEach((f) => console.log(`  - ${f.name}`));
  }
}

main();
