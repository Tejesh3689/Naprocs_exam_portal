// Real-content, real-scale, edge-case-heavy readiness test.
//
// Unlike seed_readiness.mjs (synthetic "N+1" MCQs, toy sum/product coding
// problems), this test CLONES the actual nap_klu_2026 question bank -- 30
// real aptitude MCQs and 3 real algorithmic coding problems (array/grid
// processing) -- into a disposable drive, so both the Piston load profile
// (real compile times, real output sizes) and the grading correctness check
// (does a genuinely correct solution to a genuinely hard problem actually
// score correctly) reflect the real exam, not a simplified stand-in.
// nap_klu_2026 itself is never touched -- only read from, once, to copy its
// question content into a brand-new drive/candidate set.
//
// 150 candidates split into five cohorts that mirror how a real batch
// actually behaves and covers the fixes shipped this session:
//   A (100): happy path -- correct solutions, realistic language mix
//   B (15):  wrong/partial logic -- verifies partial scoring is honest
//   C (10):  deliberately broken code -- empty / infinite loop / syntax
//            error / huge output -- verifies graceful handling, no crash
//   D (10):  proctoring cap hit mid-exam -- verifies partial-progress grading
//            on a forced termination
//   E (15):  abandon after MCQs, deadline forced into the past, never call
//            submit -- verifies the live-monitor proactive sweep (the actual
//            "exam not auto-submitting" bug fixed post-KLU) finalizes them
//
// Usage: node real_scale_edge_test.mjs <BASE_URL>
import { supabase, saveState, fireAllConcurrently, printPhaseReport } from "./_lib.mjs";

const BASE_URL = process.argv[2];
if (!BASE_URL) {
  console.error("Usage: node real_scale_edge_test.mjs <BASE_URL>");
  process.exit(1);
}

const KLU_DRIVE_ID = "c340f0e5-ba8f-40be-b0bf-c2d2f797da2d";
const runTag = Date.now().toString(36);

async function postJson(urlPath, body) {
  const res = await fetch(`${BASE_URL}${urlPath}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}
async function getJson(urlPath) {
  const res = await fetch(`${BASE_URL}${urlPath}`);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

const t0 = Date.now();
function mark(label) {
  console.log(`\n[t+${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);
}

// ---------- Step 1: clone real klu question content (read-only against klu) ----------
mark("Step 1: reading real nap_klu_2026 question bank (read-only) and cloning into a disposable drive");
const { data: sourceQuestions, error: sourceErr } = await supabase.from("questions").select("*").eq("drive_id", KLU_DRIVE_ID);
if (sourceErr) throw sourceErr;
const sourceMcqs = sourceQuestions.filter((q) => q.type === "MCQ");
const sourceCoding = sourceQuestions.filter((q) => q.type === "CODING");
console.log(`  Read ${sourceMcqs.length} real MCQs and ${sourceCoding.length} real coding problems from nap_klu_2026.`);
if (sourceCoding.length !== 3) throw new Error(`Expected 3 real coding problems, found ${sourceCoding.length} -- aborting, script assumes the 3 known klu problems.`);

const now = new Date();
const { data: drive, error: driveError } = await supabase
  .from("drives")
  .insert({
    title: `REALSCALE_${runTag}`,
    slug: `realscale-${runTag}`,
    exam_duration: 20,
    passing_cutoff: 70,
    proctoring_severity: "HIGH",
    max_cheat_warnings: 3,
    mcq_count: sourceMcqs.length,
    coding_count: sourceCoding.length,
    shuffle_questions: true,
    shuffle_options: true,
    is_exam_active: true,
    reg_start: new Date(now.getTime() - 86_400_000).toISOString(),
    reg_end: new Date(now.getTime() + 86_400_000).toISOString(),
    exam_start: new Date(now.getTime() - 60_000).toISOString(),
    exam_end: new Date(now.getTime() + 30 * 60_000).toISOString(),
    webcam_proctoring_enabled: true,
  })
  .select()
  .single();
if (driveError) throw driveError;
console.log(`  Disposable drive created: ${drive.id} ("${drive.title}")`);

const { data: mcqRows, error: mcqInsertErr } = await supabase
  .from("questions")
  .insert(sourceMcqs.map((q) => ({ drive_id: drive.id, type: "MCQ", title: q.title, content: q.content, options: q.options, correct_answer: q.correct_answer })))
  .select();
if (mcqInsertErr) throw mcqInsertErr;

const { data: codingRows, error: codingInsertErr } = await supabase
  .from("questions")
  .insert(sourceCoding.map((q) => ({ drive_id: drive.id, type: "CODING", title: q.title, content: q.content, boilerplate_code: q.boilerplate_code, test_cases: q.test_cases })))
  .select();
if (codingInsertErr) throw codingInsertErr;
console.log(`  Cloned ${mcqRows.length} MCQs + ${codingRows.length} coding questions into the disposable drive.`);

// Map cloned coding rows back to which real klu problem they are, by title
// (title strings are stable identifiers here since we just cloned them).
const codingByTitle = {};
for (const q of codingRows) codingByTitle[q.title] = q;
const P1 = codingByTitle[sourceCoding.find((q) => q.title.includes("Inventory")).title]; // Inventory Restock Alerts
const P2 = codingByTitle[sourceCoding.find((q) => q.title.includes("Clean Monitoring")).title]; // Longest Clean Monitoring Window
const P3 = codingByTitle[sourceCoding.find((q) => q.title.includes("Server Cluster")).title]; // Server Cluster Count
console.log(`  P1=${P1.id} P2=${P2.id} P3=${P3.id}`);

const mcqAnswerKey = sourceMcqs.map((q, i) => ({ title: q.title, correctText: q.options[Number(q.correct_answer)] ?? q.correct_answer }));

// ---------- Real, correct solutions per language (genuinely solve the real problems) ----------
const CORRECT = {
  python: {
    [P1.id]: `import ast\nstock = ast.literal_eval(input().strip())\navg = sum(stock)/len(stock) if stock else 0\nprint([i for i,v in enumerate(stock) if v < avg])\n`,
    [P2.id]: `import ast\narr = ast.literal_eval(input().strip())\nseen = {}\nleft = 0\nbest = 0\nfor right, v in enumerate(arr):\n    if v in seen and seen[v] >= left:\n        left = seen[v] + 1\n    seen[v] = right\n    best = max(best, right - left + 1)\nprint(best)\n`,
    [P3.id]: `import ast\ngrid, k = ast.literal_eval(input().strip())\nrows = len(grid)\ncols = len(grid[0]) if rows else 0\nvisited = [[False]*cols for _ in range(rows)]\ncount = 0\nfor r in range(rows):\n    for c in range(cols):\n        if grid[r][c] == 1 and not visited[r][c]:\n            stack = [(r,c)]\n            visited[r][c] = True\n            size = 0\n            while stack:\n                cr, cc = stack.pop()\n                size += 1\n                for dr, dc in [(-1,0),(1,0),(0,-1),(0,1)]:\n                    nr, nc = cr+dr, cc+dc\n                    if 0<=nr<rows and 0<=nc<cols and grid[nr][nc]==1 and not visited[nr][nc]:\n                        visited[nr][nc] = True\n                        stack.append((nr,nc))\n            if size >= k:\n                count += 1\nprint(count)\n`,
  },
  javascript: {
    [P1.id]: `function restockAlerts(input) {\n  const stock = input;\n  const avg = stock.length ? stock.reduce((a,b)=>a+b,0)/stock.length : 0;\n  const result = [];\n  for (let i=0;i<stock.length;i++) if (stock[i] < avg) result.push(i);\n  return result;\n}`,
    [P2.id]: `function longestCleanWindow(input) {\n  const arr = input;\n  let seen = {}, left = 0, best = 0;\n  for (let right=0; right<arr.length; right++) {\n    const v = arr[right];\n    if (seen[v] !== undefined && seen[v] >= left) left = seen[v]+1;\n    seen[v] = right;\n    best = Math.max(best, right-left+1);\n  }\n  return best;\n}`,
    [P3.id]: `function countClusters(input) {\n  const [grid, k] = input;\n  const rows = grid.length, cols = rows ? grid[0].length : 0;\n  const visited = Array.from({length:rows},()=>Array(cols).fill(false));\n  let count=0;\n  for (let r=0;r<rows;r++) for (let c=0;c<cols;c++) {\n    if (grid[r][c]===1 && !visited[r][c]) {\n      let stack=[[r,c]]; visited[r][c]=true; let size=0;\n      while(stack.length){\n        const [cr,cc]=stack.pop(); size++;\n        for (const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {\n          const nr=cr+dr, nc=cc+dc;\n          if (nr>=0&&nr<rows&&nc>=0&&nc<cols&&grid[nr][nc]===1&&!visited[nr][nc]) { visited[nr][nc]=true; stack.push([nr,nc]); }\n        }\n      }\n      if (size>=k) count++;\n    }\n  }\n  return count;\n}`,
  },
  java: {
    [P1.id]: `import java.util.*;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in);\n    String line = sc.nextLine().trim();\n    line = line.substring(1, line.length()-1);\n    String[] parts = line.isEmpty() ? new String[0] : line.split(",");\n    int n = parts.length;\n    int[] stock = new int[n];\n    long sum = 0;\n    for (int i=0;i<n;i++){ stock[i]=Integer.parseInt(parts[i].trim()); sum+=stock[i]; }\n    double avg = n==0?0:(double)sum/n;\n    List<Integer> result = new ArrayList<>();\n    for (int i=0;i<n;i++) if (stock[i] < avg) result.add(i);\n    StringBuilder sb = new StringBuilder("[");\n    for (int i=0;i<result.size();i++){ if(i>0) sb.append(","); sb.append(result.get(i)); }\n    sb.append("]");\n    System.out.println(sb.toString());\n  }\n}\n`,
  },
  c: {
    [P1.id]: `#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\nint main(void) {\n  char buf[4096];\n  fgets(buf, sizeof(buf), stdin);\n  char *p = buf;\n  while (*p == '[') p++;\n  int stock[1000], n = 0;\n  char *tok = strtok(p, ",]");\n  while (tok) { stock[n++] = atoi(tok); tok = strtok(NULL, ",]"); }\n  long sum = 0; for (int i=0;i<n;i++) sum += stock[i];\n  double avg = n ? (double)sum/n : 0;\n  printf("[");\n  int first = 1;\n  for (int i=0;i<n;i++) if (stock[i] < avg) { if(!first) printf(","); printf("%d", i); first = 0; }\n  printf("]\\n");\n  return 0;\n}\n`,
  },
  cpp: {
    [P1.id]: `#include <bits/stdc++.h>\nusing namespace std;\nint main() {\n  string line; getline(cin, line);\n  string inner = line.substr(1, line.size()-2);\n  stringstream ss(inner); string tok; vector<long> stock;\n  while (getline(ss, tok, ',')) if (!tok.empty()) stock.push_back(stol(tok));\n  double avg = stock.empty() ? 0 : accumulate(stock.begin(), stock.end(), 0.0) / stock.size();\n  cout << "[";\n  bool first = true;\n  for (size_t i=0;i<stock.size();i++) if (stock[i] < avg) { if(!first) cout << ","; cout << i; first = false; }\n  cout << "]" << endl;\n  return 0;\n}\n`,
  },
};

// Cohort B: plausible wrong logic -- off-by-one on the "strictly less than
// average" condition (uses <= instead of <), a mistake a real candidate could
// easily make, which changes the answer on any test case with a value equal
// to the average.
const WRONG_LOGIC_P1_PY = `import ast\nstock = ast.literal_eval(input().strip())\navg = sum(stock)/len(stock) if stock else 0\nprint([i for i,v in enumerate(stock) if v <= avg])\n`; // off-by-one bug

// Cohort C: deliberately broken submissions.
const BROKEN = {
  empty: ``,
  infiniteLoop: `while True:\n    pass\n`,
  syntaxError: `def broken(:\n    print(1)\n`,
  hugeOutput: `print(list(range(200000)))\n`,
};

console.log(`\nMCQ answer key ready (${mcqAnswerKey.length} entries). Correct solutions ready for python/javascript/java/c/cpp.`);

// ---------- Step 2: seed 150 candidates ----------
mark("Step 2: seeding 150 candidates");
const FIXED_PIN = "123456";
const candidateInserts = Array.from({ length: 150 }, (_, i) => ({
  drive_id: drive.id,
  name: `RealScale Candidate ${i}`,
  email: `realscale.${runTag}.${i}@naprocs-loadtest.invalid`,
  phone: "9999999999",
  college_roll_number: `REAL-${runTag}-${i}`.toUpperCase(),
  access_pin: FIXED_PIN,
  stage: "EXAM_PENDING",
}));
const { data: insertedCandidates, error: candInsertErr } = await supabase.from("candidates").insert(candidateInserts).select("id,email,college_roll_number");
if (candInsertErr) throw candInsertErr;
console.log(`  Inserted ${insertedCandidates.length} candidates.`);

// Assign cohorts: A[0..99] happy path, B[100..114] wrong logic, C[115..124]
// broken code, D[125..134] proctoring cap, E[135..149] abandoned.
const candidates = insertedCandidates.map((c, i) => {
  let cohort;
  if (i < 100) cohort = "A";
  else if (i < 115) cohort = "B";
  else if (i < 125) cohort = "C";
  else if (i < 135) cohort = "D";
  else cohort = "E";
  return { candidateId: c.id, identifier: c.college_roll_number, accessPin: FIXED_PIN, cohort, idx: i };
});

// Language assignment within cohort A: realistic mix, python-heavy.
const A_LANGS = [];
for (let i = 0; i < 50; i++) A_LANGS.push("python");
for (let i = 0; i < 30; i++) A_LANGS.push("javascript");
for (let i = 0; i < 10; i++) A_LANGS.push("java");
for (let i = 0; i < 5; i++) A_LANGS.push("c");
for (let i = 0; i < 5; i++) A_LANGS.push("cpp");

let aCounter = 0;
for (const c of candidates) {
  if (c.cohort === "A") { c.language = A_LANGS[aCounter]; aCounter++; }
  else if (c.cohort === "B") c.language = "python";
  else if (c.cohort === "C") c.language = "python";
  else if (c.cohort === "D") c.language = "python";
  else c.language = "python";
}
const brokenVariants = Object.keys(BROKEN);

saveState({ runTag, driveId: drive.id, codingQuestionIds: [P1.id, P2.id, P3.id] }); // minimal, for cleanup.mjs compatibility

// ---------- Phase 0: sanity check settings resolve correctly ----------
mark("Phase 0: verify resolved settings match real klu config (HIGH severity, cap 3, webcam on, 30 MCQ / 3 Coding)");
{
  const r = await getJson(`/api/exam/questions?candidateId=${candidates[0].candidateId}`);
  const s = r.body.settings || {};
  const qCount = (r.body.questions || []).length;
  console.log(`  proctoringSeverity=${s.proctoringSeverity} maxCheatWarnings=${s.maxCheatWarnings} webcam=${s.webcamProctoringEnabled} questionCount=${qCount} -- ${s.proctoringSeverity === "HIGH" && qCount === 33 ? "OK" : "CHECK"}`);
}

// ---------- Phase 1: synchronized login (all 150) ----------
mark("Phase 1: login (150 candidates, same instant)");
const loginReport = await fireAllConcurrently(candidates, async (c) => {
  const { status, body } = await postJson("/api/auth/exam-login", { identifier: c.identifier, accessPin: c.accessPin });
  return { status, body };
});
printPhaseReport("Login", loginReport);

// ---------- Phase 2: synchronized questions fetch ----------
mark("Phase 2: GET /api/exam/questions (150 candidates, same instant)");
const questionsReport = await fireAllConcurrently(candidates, async (c) => {
  const { status, body } = await getJson(`/api/exam/questions?candidateId=${c.candidateId}`);
  return { status, body };
});
printPhaseReport("Questions fetch", questionsReport);
for (let i = 0; i < candidates.length; i++) {
  const r = questionsReport.results[i];
  candidates[i].sessionId = r.body?.sessionId || null;
  candidates[i].mcqQuestions = (r.body?.questions || []).filter((q) => q.type === "MCQ");
  candidates[i].codingQuestions = (r.body?.questions || []).filter((q) => q.type === "CODING");
}

// ---------- Phase 3: answer all real MCQs (mostly correct; cohort B gets a few wrong on purpose) ----------
mark("Phase 3: real MCQ answers via /api/exam/sync (150 candidates, same instant)");
const syncReport = await fireAllConcurrently(candidates, async (c) => {
  if (!c.sessionId) return { status: 0, body: { skipped: true } };
  const responses = {};
  c.mcqQuestions.forEach((q, qi) => {
    const key = mcqAnswerKey.find((k) => k.title === q.title);
    const wantWrong = c.cohort === "B" && qi % 5 === 0; // ~6 wrong MCQs for cohort B, realistic partial performance
    const selectedOption = wantWrong ? q.options.find((o) => o !== key?.correctText) : key ? q.options.find((o) => o === key.correctText) : q.options?.[0];
    responses[q._id ?? q.id] = { selectedOption };
  });
  const { status, body } = await postJson("/api/exam/sync", { sessionId: c.sessionId, candidateId: c.candidateId, incomingResponses: responses });
  c._mcqResponses = responses;
  return { status, body };
});
printPhaseReport("MCQ sync (real klu MCQs)", syncReport);

// ---------- Phase 4: MCQ stage transition ----------
mark("Phase 4: MCQ_SUBMIT stage transition (150 candidates, same instant)");
const transitionReport = await fireAllConcurrently(candidates, async (c) => {
  if (!c.sessionId) return { status: 0, body: { skipped: true } };
  const { status, body } = await postJson("/api/exam/submit", { sessionId: c.sessionId, candidateId: c.candidateId, finalResponses: c._mcqResponses || {}, stageAction: "MCQ_SUBMIT" });
  return { status, body };
});
printPhaseReport("Stage transition", transitionReport);

// ---------- Cohort E splits off here: abandon now, never touch coding, never submit ----------
const cohortE = candidates.filter((c) => c.cohort === "E");
const activeForCoding = candidates.filter((c) => c.cohort !== "E");

// ---------- Phase 5: interactive "Run Tests" pass (normal priority) -- real candidate behavior before final submit ----------
mark(`Phase 5: interactive Run Tests across real coding problems for ${activeForCoding.length} active candidates (cohorts A/B/C/D)`);
const runTestJobs = [];
for (const c of activeForCoding) {
  for (const q of c.codingQuestions) {
    let code;
    if (c.cohort === "A") {
      code = CORRECT[c.language]?.[q._id ?? q.id];
      if (code === undefined) code = ""; // compiled-lang candidates: only attempt P1, leave P2/P3 blank -- realistic
    } else if (c.cohort === "B") {
      code = q.title.includes("Inventory") ? WRONG_LOGIC_P1_PY : CORRECT.python[q._id ?? q.id];
    } else if (c.cohort === "C") {
      // Rotate through the 4 broken variants; only attempt P1 (this is a
      // resilience test, not a correctness test -- P2/P3 left blank).
      if (!q.title.includes("Inventory")) { code = ""; }
      else code = BROKEN[brokenVariants[c.idx % brokenVariants.length]];
    } else if (c.cohort === "D") {
      // Cohort D gets terminated mid-exam below -- give them a correct P1
      // attempt so we can verify partial credit survives a forced
      // termination, then never let them reach P2/P3.
      code = q.title.includes("Inventory") ? CORRECT.python[q._id ?? q.id] : "";
    }
    if (code === undefined) code = "";
    runTestJobs.push({ candidate: c, questionId: q._id ?? q.id, code, language: c.language });
  }
}
console.log(`  ${runTestJobs.length} interactive evaluate calls queued.`);
const runTestStart = Date.now();
const runTestResults = await Promise.all(
  runTestJobs.map(async (job) => {
    if (!job.code) return { ...job, status: 0, body: { skipped: "no attempt" }, elapsed: 0 };
    const t = Date.now();
    const { status, body } = await postJson("/api/exam/evaluate", { studentCode: job.code, questionId: job.questionId, language: job.language });
    return { ...job, status, body, elapsed: Date.now() - t };
  })
);
const runTestElapsed = Date.now() - runTestStart;
const attempted = runTestResults.filter((r) => r.code);
const httpOk = attempted.filter((r) => r.status === 200);
console.log(`  === Interactive Run Tests (${attempted.length} attempted, ${runTestJobs.length - attempted.length} skipped as "no attempt") ===`);
console.log(`  ${httpOk.length}/${attempted.length} HTTP 200, wall time ${(runTestElapsed / 1000).toFixed(1)}s`);
const nonOk = attempted.filter((r) => r.status !== 200);
if (nonOk.length > 0) console.log(`  non-200 samples:`, nonOk.slice(0, 5).map((r) => ({ cohort: r.candidate.cohort, status: r.status, body: r.body })));

// Attach responses for the final submit / cohort-D-termination phases.
for (const job of runTestJobs) {
  const c = job.candidate;
  c._codingResponses = c._codingResponses || {};
  c._codingResponses[job.questionId] = { language: job.language, codeStr: job.code };
}

// ---------- Cohort C resilience check: verify broken submissions came back as graceful non-crashes ----------
mark("Checking cohort C (broken code) resilience");
{
  const cohortCResults = runTestResults.filter((r) => r.candidate.cohort === "C" && r.code);
  let crashed = 0, gracefulError = 0, unexpectedPass = 0;
  for (const r of cohortCResults) {
    if (r.status !== 200) { crashed++; continue; }
    const allPassed = r.body?.results?.every?.((x) => x.passed);
    if (allPassed) unexpectedPass++; else gracefulError++;
  }
  console.log(`  ${cohortCResults.length} broken submissions: ${crashed} crashed (HTTP != 200, BAD), ${gracefulError} gracefully marked not-passed (expected), ${unexpectedPass} unexpectedly passed (investigate)`);
}

// ---------- Phase 6: cohort D -- proctoring cap hit mid-exam, forced termination ----------
mark("Phase 6: cohort D -- simulate proctoring cap breach mid-exam (persist warnings then terminate submit)");
const cohortD = candidates.filter((c) => c.cohort === "D");
const terminationReport = await fireAllConcurrently(cohortD, async (c) => {
  // Mirror dashboard/page.tsx's real client behavior: persist the warning
  // count via /api/exam/sync first (as persistCheatWarning does), then the
  // reactive cap-check fires handleViolationSubmit -- which is just
  // /api/exam/submit with a VIOLATION_* reason and whatever partial
  // responses exist so far (here: their one P1 attempt, nothing else).
  await postJson("/api/exam/sync", { sessionId: c.sessionId, candidateId: c.candidateId, incomingResponses: c._mcqResponses, cheatWarnings: 3 });
  const finalResponses = { ...(c._mcqResponses || {}), ...(c._codingResponses || {}) };
  const { status, body } = await postJson("/api/exam/submit", { sessionId: c.sessionId, candidateId: c.candidateId, finalResponses, reason: "VIOLATION_MEDIUM_CAP" });
  return { status, body };
});
printPhaseReport("Cohort D forced termination (proctoring cap)", terminationReport);

// ---------- Phase 7: cohorts A/B/C synchronized final submit ----------
mark("Phase 7: final /api/exam/submit for cohorts A/B/C -- same instant (synchronized time-up simulation)");
const finalCandidates = candidates.filter((c) => c.cohort === "A" || c.cohort === "B" || c.cohort === "C");
const finalReport = await fireAllConcurrently(finalCandidates, async (c) => {
  const finalResponses = { ...(c._mcqResponses || {}), ...(c._codingResponses || {}) };
  const { status, body } = await postJson("/api/exam/submit", { sessionId: c.sessionId, candidateId: c.candidateId, finalResponses, reason: "MANUAL" });
  return { status, body };
});
printPhaseReport("Final submit (cohorts A/B/C)", finalReport);

// ---------- Phase 8: cohort E -- force deadline into the past, verify the live-monitor proactive sweep finalizes them ----------
mark("Phase 8: cohort E -- forcing deadlines into the past (simulating abandoned sessions) and checking the proactive sweep");
const cohortESessionIds = cohortE.map((c) => c.sessionId).filter(Boolean);
if (cohortESessionIds.length > 0) {
  const pastDeadline = new Date(Date.now() - 5 * 60_000).toISOString();
  const { error: forceExpireErr } = await supabase.from("exam_sessions").update({ deadline: pastDeadline }).in("id", cohortESessionIds);
  if (forceExpireErr) throw forceExpireErr;
  console.log(`  Forced ${cohortESessionIds.length} cohort-E sessions' deadlines to ${pastDeadline} (5 min in the past). They will NOT call /api/exam/submit themselves.`);

  // Hit the live-monitor endpoint, exactly as an admin's Live Monitoring page
  // polling every 30s during a real exam would -- this is the actual code
  // path fixed post-KLU (previously this route never swept at all).
  const liveMonitorResp = await getJson(`/api/admin/drives/${drive.id}/live-monitor`);
  console.log(`  live-monitor status=${liveMonitorResp.status}`);
  if (liveMonitorResp.status === 401 || liveMonitorResp.status === 403) {
    console.log(`  live-monitor requires admin auth (expected without a logged-in admin session) -- falling back to directly verifying the sweep would still trigger on the candidate's own next request instead.`);
    // Fallback: a candidate's own next /api/exam/questions call (lazy sweep)
    // should also catch this -- exercises the OTHER half of the fix.
    const fallback = await fireAllConcurrently(cohortE, async (c) => {
      const { status, body } = await getJson(`/api/exam/questions?candidateId=${c.candidateId}`);
      return { status, body };
    });
    printPhaseReport("Cohort E fallback lazy-sweep via /api/exam/questions", fallback);
  }
}

// ---------- Verification: read real outcomes back from the DB, not just HTTP status ----------
mark("Verification: reading actual final state from the database");
const { data: finalCandidateRows, error: verifyErr } = await supabase
  .from("candidates")
  .select("id,stage,exam_score,cheat_warnings")
  .eq("drive_id", drive.id);
if (verifyErr) throw verifyErr;
const { data: finalSessionRows, error: verifySessErr } = await supabase
  .from("exam_sessions")
  .select("candidate_id,status,end_reason")
  .in("candidate_id", candidates.map((c) => c.candidateId));
if (verifySessErr) throw verifySessErr;
const sessionByCand = {};
for (const s of finalSessionRows) sessionByCand[s.candidate_id] = s;

const byCohort = { A: [], B: [], C: [], D: [], E: [] };
for (const c of candidates) {
  const cand = finalCandidateRows.find((r) => r.id === c.candidateId);
  const sess = sessionByCand[c.candidateId];
  byCohort[c.cohort].push({ score: cand?.exam_score, stage: cand?.stage, sessionStatus: sess?.status, endReason: sess?.end_reason });
}

function summarizeCohort(label, rows, expectDesc) {
  const scores = rows.map((r) => r.score).filter((s) => typeof s === "number");
  const completed = rows.filter((r) => r.sessionStatus === "COMPLETED").length;
  const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : "n/a";
  const min = scores.length ? Math.min(...scores) : "n/a";
  const max = scores.length ? Math.max(...scores) : "n/a";
  console.log(`  Cohort ${label} (${expectDesc}): ${rows.length} candidates, ${completed}/${rows.length} sessions COMPLETED, score avg=${avg} min=${min} max=${max}`);
}
summarizeCohort("A", byCohort.A, "happy path, expect high scores");
summarizeCohort("B", byCohort.B, "wrong logic + some wrong MCQs, expect partial scores below A");
summarizeCohort("C", byCohort.C, "broken code, expect low coding credit but MCQ credit intact, no crashes");
summarizeCohort("D", byCohort.D, "terminated mid-exam by proctoring cap, expect partial credit for what was answered");
summarizeCohort("E", byCohort.E, "abandoned, deadline forced into the past -- expect ALL swept to COMPLETED, not stuck IN_PROGRESS");

const stuckE = byCohort.E.filter((r) => r.sessionStatus !== "COMPLETED");
console.log(`\n${stuckE.length === 0 ? "PASS" : "FAIL"}: cohort E stuck-in-progress count = ${stuckE.length} (must be 0 -- this is the actual auto-submit bug fixed post-KLU)`);

const totalMs = Date.now() - t0;
console.log(`\n=== DONE in ${(totalMs / 1000).toFixed(1)}s ===`);
console.log(`\nDrive left in place for inspection: ${drive.id} ("${drive.title}"). Run cleanup manually when done (see cleanup script pattern) -- state saved to loadtest_state.json.`);
