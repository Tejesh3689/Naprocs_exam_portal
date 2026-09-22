// Pre-exam readiness test for tomorrow's VVIT drives, using the REAL
// question content (25 aptitude/CS MCQs + 2 genuinely hard coding problems:
// weighted job scheduling DP, and a delay-constrained shortest path) cloned
// read-only from the real NAP_VVIT_9:00-9:45 drive into a disposable drive.
// Neither real VVIT drive is touched -- only read from once, to copy content.
//
// 60 candidates (comfortably above any plausible single-slot batch size)
// across the same five real-life cohorts used for the klu readiness check:
//   A (40): happy path -- correct solutions, python/javascript mix
//   B (8):  wrong logic on one coding problem + some wrong MCQs
//   C (6):  deliberately broken code (empty/infinite-loop/syntax-error/huge output)
//   D (3):  proctoring cap hit mid-exam (HIGH severity here, so this is an
//           instant-terminate single violation, not a warning-cap)
//   E (3):  abandon after MCQs, deadline forced into the past, verifying the
//           auto-submit sweep
//
// Usage: node vvit_readiness_test.mjs <BASE_URL>
import { supabase, saveState, fireAllConcurrently, printPhaseReport } from "./_lib.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

const BASE_URL = process.argv[2];
if (!BASE_URL) {
  console.error("Usage: node vvit_readiness_test.mjs <BASE_URL>");
  process.exit(1);
}

const SOURCE_DRIVE_ID = "fa0401f2-4019-47f6-a5f7-72c93b107632"; // NAP_VVIT_9:00-9:45 (real)
const runTag = Date.now().toString(36);

// Node's own fetch (undici) cannot establish a TCP connection to this host
// in this sandboxed network -- DNS resolution succeeds (dns.lookup returns a
// NAT64-synthesized IPv6 address) but the actual connect times out every
// time, while curl reaches the exact same address reliably. Shelling out to
// curl sidesteps whatever undici-specific NAT64/TLS quirk is happening here,
// without needing to debug the sandbox's network stack further.
let reqCounter = 0;
async function curlRequest(method, urlPath, body) {
  const args = ["-s", "-w", "\n__STATUS__%{http_code}", "-X", method, `${BASE_URL}${urlPath}`, "--max-time", "25"];
  let tmpFile = null;
  if (body !== undefined) {
    tmpFile = path.join(os.tmpdir(), `vvit_req_${process.pid}_${reqCounter++}_${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(body));
    args.push("-H", "Content-Type: application/json", "--data", `@${tmpFile}`);
  }
  try {
    const { stdout } = await execFileAsync("curl", args, { maxBuffer: 20 * 1024 * 1024 });
    const idx = stdout.lastIndexOf("__STATUS__");
    const rawBody = stdout.slice(0, idx);
    const status = parseInt(stdout.slice(idx + "__STATUS__".length).trim(), 10);
    let json = {};
    try { json = JSON.parse(rawBody); } catch { /* non-JSON response */ }
    return { status, body: json };
  } catch (e) {
    // curl itself failing (exit 28 = --max-time exceeded, or any other
    // transport-level failure) must never crash the whole batch -- this is
    // exactly the "judge busy / connection dropped" case a real candidate's
    // browser would hit too. Surface it as a normal failed-request result
    // instead of an uncaught exception killing every other in-flight call.
    return { status: 0, body: { error: `curl transport failure: ${e.message?.split("\n")[0] || e.code}` } };
  } finally {
    if (tmpFile) fs.unlink(tmpFile, () => {});
  }
}
async function postJson(urlPath, body) {
  return curlRequest("POST", urlPath, body);
}
async function getJson(urlPath) {
  return curlRequest("GET", urlPath);
}

const t0 = Date.now();
function mark(label) {
  console.log(`\n[t+${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);
}

// ---------- Step 1: clone real VVIT content (read-only) ----------
mark("Step 1: reading real NAP_VVIT_9:00-9:45 question bank (read-only) and cloning into a disposable drive");
const { data: sourceQuestions, error: sourceErr } = await supabase.from("questions").select("*").eq("drive_id", SOURCE_DRIVE_ID);
if (sourceErr) throw sourceErr;
const sourceMcqs = sourceQuestions.filter((q) => q.type === "MCQ");
const sourceCoding = sourceQuestions.filter((q) => q.type === "CODING");
console.log(`  Read ${sourceMcqs.length} real MCQs and ${sourceCoding.length} real coding problems.`);
if (sourceCoding.length !== 2) throw new Error(`Expected 2 real coding problems, found ${sourceCoding.length}`);

const now = new Date();
const { data: drive, error: driveError } = await supabase
  .from("drives")
  .insert({
    title: `VVIT_READINESS_${runTag}`,
    slug: `vvit-readiness-${runTag}`,
    exam_duration: 20,
    passing_cutoff: 75,
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
    webcam_proctoring_enabled: false,
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
console.log(`  Cloned ${mcqRows.length} MCQs + ${codingRows.length} coding questions.`);

const codingByTitle = {};
for (const q of codingRows) codingByTitle[q.title] = q;
const JOBSCHED = codingByTitle[sourceCoding.find((q) => q.title.includes("Job Scheduling")).title];
const SHORTPATH = codingByTitle[sourceCoding.find((q) => q.title.includes("Shortest Path")).title];

const mcqAnswerKey = sourceMcqs.map((q) => ({ title: q.title, correctText: q.options[Number(q.correct_answer)] ?? q.correct_answer }));

// ---------- Verified-correct solutions (independently confirmed against every test case, including hidden, before this run) ----------
const CORRECT = {
  python: {
    [JOBSCHED.id]: "import ast\njobs = ast.literal_eval(input().strip())\njobs.sort(key=lambda j: j[1])\nn = len(jobs)\nends = [j[1] for j in jobs]\ndp = [0]*n\nfor i in range(n):\n    start, end, profit = jobs[i]\n    lo, hi, j = 0, i-1, -1\n    while lo <= hi:\n        mid = (lo+hi)//2\n        if ends[mid] <= start:\n            j = mid\n            lo = mid+1\n        else:\n            hi = mid-1\n    incl = profit + (dp[j] if j != -1 else 0)\n    excl = dp[i-1] if i > 0 else 0\n    dp[i] = max(incl, excl)\nprint(dp[-1] if n>0 else 0)\n",
    [SHORTPATH.id]: "import json, heapq\ndata = json.loads(input().strip())\nn = data['n']; edges = data['edges']; source = data['source']; destination = data['destination']; maxDelay = data['maxDelay']\nadj = [[] for _ in range(n)]\nfor u,v,cost,delay in edges:\n    adj[u].append((v,cost,delay))\nheap = [(0, source, 0)]\nseen = set()\nanswer = -1\nwhile heap:\n    cost, node, delay = heapq.heappop(heap)\n    if node == destination:\n        answer = cost\n        break\n    key = (node, delay)\n    if key in seen:\n        continue\n    seen.add(key)\n    for v, ecost, edelay in adj[node]:\n        ndelay = delay + edelay\n        if ndelay <= maxDelay:\n            heapq.heappush(heap, (cost+ecost, v, ndelay))\nprint(answer)\n",
  },
  javascript: {
    [JOBSCHED.id]: "function maxProfit(input) {\n  const jobs = input.slice().sort((a,b)=>a[1]-b[1]);\n  const n = jobs.length;\n  const ends = jobs.map(j=>j[1]);\n  const dp = new Array(n).fill(0);\n  function findLast(start, hiIdx) {\n    let lo=0, hi=hiIdx, res=-1;\n    while (lo<=hi) {\n      const mid=(lo+hi)>>1;\n      if (ends[mid]<=start) { res=mid; lo=mid+1; } else hi=mid-1;\n    }\n    return res;\n  }\n  for (let i=0;i<n;i++){\n    const [start,end,profit]=jobs[i];\n    const j = findLast(start, i-1);\n    const incl = profit + (j!==-1?dp[j]:0);\n    const excl = i>0?dp[i-1]:0;\n    dp[i]=Math.max(incl,excl);\n  }\n  return n>0?dp[n-1]:0;\n}",
    [SHORTPATH.id]: "function restrictedShortestPath(input) {\n  const { n, edges, source, destination, maxDelay } = input;\n  const adj = Array.from({length:n},()=>[]);\n  for (const [u,v,cost,delay] of edges) adj[u].push([v,cost,delay]);\n  let heap = [[0, source, 0]];\n  const seen = new Set();\n  while (heap.length) {\n    heap.sort((a,b)=>a[0]-b[0]);\n    const [cost, node, delay] = heap.shift();\n    if (node === destination) return cost;\n    const key = node+\",\"+delay;\n    if (seen.has(key)) continue;\n    seen.add(key);\n    for (const [v,ecost,edelay] of adj[node]) {\n      const ndelay = delay+edelay;\n      if (ndelay <= maxDelay) heap.push([cost+ecost, v, ndelay]);\n    }\n  }\n  return -1;\n}",
  },
  // Compiled-language candidates: verified-correct solution for JOBSCHED
  // only (mirrors realistic behavior -- attempt the easier of two hard
  // problems in a language with more setup overhead, leave the other
  // blank). This is what actually exercises the known compiled-language
  // concurrency limits under real load, which the earlier python/js-only
  // readiness run never touched.
  java: {
    [JOBSCHED.id]: "import java.util.*;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in);\n    String line = sc.nextLine().trim();\n    line = line.substring(1, line.length()-1);\n    List<int[]> jobs = new ArrayList<>();\n    String[] parts = line.split(\"\\\\],\\\\[\");\n    for (String p : parts) {\n      String clean = p.replace(\"[\", \"\").replace(\"]\", \"\");\n      String[] nums = clean.split(\",\");\n      int start = Integer.parseInt(nums[0].trim());\n      int end = Integer.parseInt(nums[1].trim());\n      int profit = Integer.parseInt(nums[2].trim());\n      jobs.add(new int[]{start, end, profit});\n    }\n    jobs.sort((a,b) -> a[1]-b[1]);\n    int n = jobs.size();\n    int[] ends = new int[n];\n    for (int i=0;i<n;i++) ends[i]=jobs.get(i)[1];\n    long[] dp = new long[n];\n    for (int i=0;i<n;i++) {\n      int start = jobs.get(i)[0], profit = jobs.get(i)[2];\n      int lo=0, hi=i-1, j=-1;\n      while (lo<=hi) {\n        int mid=(lo+hi)/2;\n        if (ends[mid]<=start) { j=mid; lo=mid+1; } else hi=mid-1;\n      }\n      long incl = profit + (j!=-1?dp[j]:0);\n      long excl = i>0?dp[i-1]:0;\n      dp[i] = Math.max(incl, excl);\n    }\n    System.out.println(n>0?dp[n-1]:0);\n  }\n}\n",
  },
  c: {
    [JOBSCHED.id]: "#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <ctype.h>\n\ntypedef struct { long start,end,profit; } Job;\n\nint cmp(const void* a, const void* b) {\n  long d = ((Job*)a)->end - ((Job*)b)->end;\n  return d < 0 ? -1 : (d > 0 ? 1 : 0);\n}\n\nint main(void) {\n  char buf[8192];\n  fgets(buf, sizeof(buf), stdin);\n  Job jobs[2000];\n  int n = 0;\n  char* p = buf;\n  while (*p) {\n    if (isdigit((unsigned char)*p) || *p=='-') {\n      long a,b,c;\n      int consumed=0;\n      if (sscanf(p, \"%ld,%ld,%ld%n\", &a,&b,&c,&consumed) == 3) {\n        jobs[n].start=a; jobs[n].end=b; jobs[n].profit=c;\n        n++;\n        p += consumed;\n        continue;\n      }\n    }\n    p++;\n  }\n  qsort(jobs, n, sizeof(Job), cmp);\n  long dp[2000];\n  long ends[2000];\n  for (int i=0;i<n;i++) ends[i]=jobs[i].end;\n  for (int i=0;i<n;i++) {\n    int lo=0,hi=i-1,j=-1;\n    while (lo<=hi) {\n      int mid=(lo+hi)/2;\n      if (ends[mid]<=jobs[i].start) { j=mid; lo=mid+1; } else hi=mid-1;\n    }\n    long incl = jobs[i].profit + (j!=-1?dp[j]:0);\n    long excl = i>0?dp[i-1]:0;\n    dp[i] = incl>excl?incl:excl;\n  }\n  printf(\"%ld\\n\", n>0?dp[n-1]:0);\n  return 0;\n}\n",
  },
  cpp: {
    [JOBSCHED.id]: "#include <bits/stdc++.h>\nusing namespace std;\nint main() {\n  string line; getline(cin, line);\n  vector<array<long,3>> jobs;\n  int i = 0, n = line.size();\n  while (i < n) {\n    if (isdigit((unsigned char)line[i]) || line[i]=='-') {\n      long a,b,c;\n      int consumed=0;\n      if (sscanf(line.c_str()+i, \"%ld,%ld,%ld%n\", &a,&b,&c,&consumed) == 3) {\n        jobs.push_back({a,b,c});\n        i += consumed;\n        continue;\n      }\n    }\n    i++;\n  }\n  sort(jobs.begin(), jobs.end(), [](const array<long,3>&a, const array<long,3>&b){ return a[1]<b[1]; });\n  int m = jobs.size();\n  vector<long> dp(m,0), ends(m);\n  for (int k=0;k<m;k++) ends[k]=jobs[k][1];\n  for (int k=0;k<m;k++) {\n    long start=jobs[k][0], profit=jobs[k][2];\n    int lo=0,hi=k-1,j=-1;\n    while (lo<=hi) {\n      int mid=(lo+hi)/2;\n      if (ends[mid]<=start) { j=mid; lo=mid+1; } else hi=mid-1;\n    }\n    long incl = profit + (j!=-1?dp[j]:0);\n    long excl = k>0?dp[k-1]:0;\n    dp[k] = max(incl,excl);\n  }\n  cout << (m>0?dp[m-1]:0) << endl;\n  return 0;\n}\n",
  },
};
const WRONG_LOGIC_JOBSCHED_PY = "import ast\njobs = ast.literal_eval(input().strip())\njobs.sort(key=lambda j: j[1])\nn = len(jobs)\nends = [j[1] for j in jobs]\ndp = [0]*n\nfor i in range(n):\n    start, end, profit = jobs[i]\n    lo, hi, j = 0, i-1, -1\n    while lo <= hi:\n        mid = (lo+hi)//2\n        if ends[mid] < start:\n            j = mid\n            lo = mid+1\n        else:\n            hi = mid-1\n    incl = profit + (dp[j] if j != -1 else 0)\n    excl = dp[i-1] if i > 0 else 0\n    dp[i] = max(incl, excl)\nprint(dp[-1] if n>0 else 0)\n"; // bug: strict < instead of <=, mishandles touching intervals
const BROKEN = {
  empty: "",
  infiniteLoop: "while True:\n    pass\n",
  syntaxError: "def broken(:\n    print(1)\n",
  hugeOutput: "print(list(range(200000)))\n",
};

console.log(`\nSolutions verified against every test case (including hidden) before this run. Job-scheduling=${JOBSCHED.id} Shortest-path=${SHORTPATH.id}`);

// ---------- Step 2: seed N candidates (default 60, override via argv[3]) ----------
const N = parseInt(process.argv[3] || "60", 10);
mark(`Step 2: seeding ${N} candidates`);
const FIXED_PIN = "123456";
const candidateInserts = Array.from({ length: N }, (_, i) => ({
  drive_id: drive.id,
  name: `VVIT Readiness Candidate ${i}`,
  email: `vvit.readiness.${runTag}.${i}@naprocs-loadtest.invalid`,
  phone: "9999999999",
  college_roll_number: `VVITREADY-${runTag}-${i}`.toUpperCase(),
  access_pin: FIXED_PIN,
  stage: "EXAM_PENDING",
}));
const CHUNK = 200;
const insertedCandidates = [];
for (let i = 0; i < candidateInserts.length; i += CHUNK) {
  const chunk = candidateInserts.slice(i, i + CHUNK);
  const { data, error: candInsertErr } = await supabase.from("candidates").insert(chunk).select("id,email,college_roll_number");
  if (candInsertErr) throw candInsertErr;
  insertedCandidates.push(...data);
}
console.log(`  Inserted ${insertedCandidates.length} candidates.`);

// Cohort proportions scaled off the same ratios as the original 60-candidate
// run (A=67%, B=13%, C=10%, D=5%, E=5%).
const cohortBounds = {
  A: Math.round(N * 0.667),
  B: Math.round(N * 0.133),
  C: Math.round(N * 0.1),
  D: Math.round(N * 0.05),
};
const aEnd = cohortBounds.A;
const bEnd = aEnd + cohortBounds.B;
const cEnd = bEnd + cohortBounds.C;
const dEnd = cEnd + cohortBounds.D;
const candidates = insertedCandidates.map((c, i) => {
  let cohort;
  if (i < aEnd) cohort = "A";
  else if (i < bEnd) cohort = "B";
  else if (i < cEnd) cohort = "C";
  else if (i < dEnd) cohort = "D";
  else cohort = "E";
  return { candidateId: c.id, identifier: c.college_roll_number, accessPin: FIXED_PIN, cohort, idx: i };
});
// Realistic language mix for cohort A, including compiled languages this
// time (java/c/cpp) -- the earlier 60-candidate run only used python/js,
// which never exercised the compiled-language concurrency limits already
// known from the dedicated Piston stress test earlier this project.
const A_LANG_WEIGHTS = [
  ["python", 0.45],
  ["javascript", 0.25],
  ["java", 0.15],
  ["cpp", 0.1],
  ["c", 0.05],
];
const A_LANGS = [];
for (const [lang, weight] of A_LANG_WEIGHTS) {
  const count = Math.round(cohortBounds.A * weight);
  for (let i = 0; i < count; i++) A_LANGS.push(lang);
}
while (A_LANGS.length < cohortBounds.A) A_LANGS.push("python");
let aCounter = 0;
for (const c of candidates) {
  if (c.cohort === "A") { c.language = A_LANGS[aCounter % A_LANGS.length]; aCounter++; }
  else c.language = "python";
}
const brokenVariants = Object.keys(BROKEN);
console.log(`  Cohorts: A=${cohortBounds.A} B=${cohortBounds.B} C=${cohortBounds.C} D=${cohortBounds.D} E=${N - dEnd}`);
console.log(`  Cohort A language mix:`, Object.fromEntries(A_LANG_WEIGHTS.map(([l]) => [l, A_LANGS.filter((x) => x === l).length])));

saveState({ runTag, driveId: drive.id, codingQuestionIds: [JOBSCHED.id, SHORTPATH.id] });

mark("Phase 0: verify resolved settings match real VVIT config (HIGH severity, cap 3, 25 MCQ / 2 Coding)");
{
  const r = await getJson(`/api/exam/questions?candidateId=${candidates[0].candidateId}`);
  const s = r.body.settings || {};
  const qCount = (r.body.questions || []).length;
  console.log(`  proctoringSeverity=${s.proctoringSeverity} maxCheatWarnings=${s.maxCheatWarnings} questionCount=${qCount} -- ${s.proctoringSeverity === "HIGH" && qCount === 27 ? "OK" : "CHECK"}`);
}

mark("Phase 1: login (60 candidates, same instant)");
const loginReport = await fireAllConcurrently(candidates, async (c) => {
  const { status, body } = await postJson("/api/auth/exam-login", { identifier: c.identifier, accessPin: c.accessPin });
  return { status, body };
});
printPhaseReport("Login", loginReport);

mark("Phase 2: GET /api/exam/questions (60 candidates, same instant)");
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

mark("Phase 3: real MCQ answers via /api/exam/sync (60 candidates, same instant)");
const syncReport = await fireAllConcurrently(candidates, async (c) => {
  if (!c.sessionId) return { status: 0, body: { skipped: true } };
  const responses = {};
  c.mcqQuestions.forEach((q, qi) => {
    const key = mcqAnswerKey.find((k) => k.title === q.title);
    const wantWrong = c.cohort === "B" && qi % 5 === 0;
    const selectedOption = wantWrong ? q.options.find((o) => o !== key?.correctText) : key ? q.options.find((o) => o === key.correctText) : q.options?.[0];
    responses[q._id ?? q.id] = { selectedOption };
  });
  const { status, body } = await postJson("/api/exam/sync", { sessionId: c.sessionId, candidateId: c.candidateId, incomingResponses: responses });
  c._mcqResponses = responses;
  return { status, body };
});
printPhaseReport("MCQ sync (real VVIT MCQs)", syncReport);

mark("Phase 4: MCQ_SUBMIT stage transition (60 candidates, same instant)");
const transitionReport = await fireAllConcurrently(candidates, async (c) => {
  if (!c.sessionId) return { status: 0, body: { skipped: true } };
  const { status, body } = await postJson("/api/exam/submit", { sessionId: c.sessionId, candidateId: c.candidateId, finalResponses: c._mcqResponses || {}, stageAction: "MCQ_SUBMIT" });
  return { status, body };
});
printPhaseReport("Stage transition", transitionReport);

const cohortE = candidates.filter((c) => c.cohort === "E");
const activeForCoding = candidates.filter((c) => c.cohort !== "E");

mark(`Phase 5: interactive Run Tests across real hard coding problems for ${activeForCoding.length} active candidates`);
const runTestJobs = [];
for (const c of activeForCoding) {
  for (const q of c.codingQuestions) {
    const qid = q._id ?? q.id;
    let code;
    if (c.cohort === "A") code = CORRECT[c.language]?.[qid];
    else if (c.cohort === "B") code = qid === JOBSCHED.id ? WRONG_LOGIC_JOBSCHED_PY : CORRECT.python[qid];
    else if (c.cohort === "C") code = qid === JOBSCHED.id ? BROKEN[brokenVariants[c.idx % brokenVariants.length]] : "";
    else if (c.cohort === "D") code = qid === JOBSCHED.id ? CORRECT.python[qid] : "";
    if (code === undefined) code = "";
    runTestJobs.push({ candidate: c, questionId: qid, code, language: c.language });
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

for (const job of runTestJobs) {
  const c = job.candidate;
  c._codingResponses = c._codingResponses || {};
  c._codingResponses[job.questionId] = { language: job.language, codeStr: job.code };
}

mark("Checking cohort C (broken code) resilience");
{
  const cohortCResults = runTestResults.filter((r) => r.candidate.cohort === "C" && r.code);
  let crashed = 0, gracefulError = 0, unexpectedPass = 0;
  for (const r of cohortCResults) {
    if (r.status !== 200) { crashed++; continue; }
    const allPassed = r.body?.results?.every?.((x) => x.passed);
    if (allPassed) unexpectedPass++; else gracefulError++;
  }
  console.log(`  ${cohortCResults.length} broken submissions: ${crashed} crashed (BAD), ${gracefulError} gracefully marked not-passed (expected), ${unexpectedPass} unexpectedly passed (investigate)`);
}

mark("Phase 6: cohort D -- HIGH-severity instant-terminate mid-exam");
const cohortD = candidates.filter((c) => c.cohort === "D");
const terminationReport = await fireAllConcurrently(cohortD, async (c) => {
  const finalResponses = { ...(c._mcqResponses || {}), ...(c._codingResponses || {}) };
  const { status, body } = await postJson("/api/exam/submit", { sessionId: c.sessionId, candidateId: c.candidateId, finalResponses, reason: "VIOLATION_HIGH_SEVERITY" });
  return { status, body };
});
printPhaseReport("Cohort D forced termination (HIGH-severity violation)", terminationReport);

mark("Phase 7: final /api/exam/submit for cohorts A/B/C -- same instant (synchronized time-up simulation)");
const finalCandidates = candidates.filter((c) => c.cohort === "A" || c.cohort === "B" || c.cohort === "C");
const finalReport = await fireAllConcurrently(finalCandidates, async (c) => {
  const finalResponses = { ...(c._mcqResponses || {}), ...(c._codingResponses || {}) };
  const { status, body } = await postJson("/api/exam/submit", { sessionId: c.sessionId, candidateId: c.candidateId, finalResponses, reason: "MANUAL" });
  return { status, body };
});
printPhaseReport("Final submit (cohorts A/B/C)", finalReport);

mark("Phase 8: cohort E -- forcing deadlines into the past and checking the sweep");
const cohortESessionIds = cohortE.map((c) => c.sessionId).filter(Boolean);
if (cohortESessionIds.length > 0) {
  const pastDeadline = new Date(Date.now() - 5 * 60_000).toISOString();
  const { error: forceExpireErr } = await supabase.from("exam_sessions").update({ deadline: pastDeadline }).in("id", cohortESessionIds);
  if (forceExpireErr) throw forceExpireErr;
  const fallback = await fireAllConcurrently(cohortE, async (c) => {
    const { status, body } = await getJson(`/api/exam/questions?candidateId=${c.candidateId}`);
    return { status, body };
  });
  printPhaseReport("Cohort E lazy-sweep via /api/exam/questions", fallback);
}

mark("Verification: reading actual final state from the database");
const { data: finalCandidateRows, error: verifyErr } = await supabase.from("candidates").select("id,stage,exam_score,cheat_warnings").eq("drive_id", drive.id);
if (verifyErr) throw verifyErr;
const { data: finalSessionRows, error: verifySessErr } = await supabase.from("exam_sessions").select("candidate_id,status,end_reason").in("candidate_id", candidates.map((c) => c.candidateId));
if (verifySessErr) throw verifySessErr;
const sessionByCand = {};
for (const s of finalSessionRows) sessionByCand[s.candidate_id] = s;

const byCohort = { A: [], B: [], C: [], D: [], E: [] };
for (const c of candidates) {
  const cand = finalCandidateRows.find((r) => r.id === c.candidateId);
  const sess = sessionByCand[c.candidateId];
  byCohort[c.cohort].push({ score: cand?.exam_score, sessionStatus: sess?.status });
}
function summarizeCohort(label, rows, expectDesc) {
  const scores = rows.map((r) => r.score).filter((s) => typeof s === "number");
  const completed = rows.filter((r) => r.sessionStatus === "COMPLETED").length;
  const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : "n/a";
  console.log(`  Cohort ${label} (${expectDesc}): ${rows.length} candidates, ${completed}/${rows.length} COMPLETED, score avg=${avg} min=${scores.length ? Math.min(...scores) : "n/a"} max=${scores.length ? Math.max(...scores) : "n/a"}`);
}
summarizeCohort("A", byCohort.A, "happy path, expect high scores");
summarizeCohort("B", byCohort.B, "one wrong coding + some wrong MCQs");
summarizeCohort("C", byCohort.C, "broken code, MCQ credit intact");
summarizeCohort("D", byCohort.D, "HIGH-severity terminated mid-exam");
summarizeCohort("E", byCohort.E, "abandoned -- must ALL be COMPLETED, not stuck");

const stuckE = byCohort.E.filter((r) => r.sessionStatus !== "COMPLETED");
console.log(`\n${stuckE.length === 0 ? "PASS" : "FAIL"}: cohort E stuck-in-progress count = ${stuckE.length} (must be 0)`);

console.log(`\n=== DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s ===`);
console.log(`Drive ${drive.id} ("${drive.title}") -- run cleanup.mjs next.`);
