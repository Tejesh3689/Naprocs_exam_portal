// Pre-exam readiness check: drives the REAL deployed app through a full
// synchronized exam cycle at the REAL nap_klu_2026 scale/config (via
// seed_readiness.mjs's disposable drive) -- 30 MCQ + 2 Coding questions,
// HIGH proctoring severity, every phase fired as one genuinely concurrent
// batch across all candidates.
//
// Usage: node run_readiness.mjs <BASE_URL>
import { loadState, fireAllConcurrently, printPhaseReport } from "./_lib.mjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.argv[2];
if (!BASE_URL) {
  console.error("Usage: node run_readiness.mjs <BASE_URL>");
  process.exit(1);
}

const state = loadState();
console.log(`Loaded state: ${state.candidates.length} candidates on drive ${state.driveId} ("${state.driveTitle}")`);
console.log(`Target: ${BASE_URL}\n`);

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

const SOLUTIONS_SUM = {
  javascript: "function sum(a, b) {\n  return a + b;\n}\n",
  python: "data = input().strip()\nparts = [int(x) for x in data.split(',')]\nprint(sum(parts))\n",
  java: "import java.util.*;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in);\n    long sum = 0;\n    for (String p : sc.nextLine().trim().split(\",\")) sum += Long.parseLong(p.trim());\n    System.out.println(sum);\n  }\n}\n",
  c: "#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\nint main(void) {\n  char buf[1024];\n  fgets(buf, sizeof(buf), stdin);\n  long sum = 0;\n  char *tok = strtok(buf, \",\");\n  while (tok) { sum += atol(tok); tok = strtok(NULL, \",\"); }\n  printf(\"%ld\\n\", sum);\n  return 0;\n}\n",
  cpp: "#include <iostream>\n#include <sstream>\nusing namespace std;\nint main() {\n  string line; getline(cin, line);\n  stringstream ss(line); string tok; long sum = 0;\n  while (getline(ss, tok, ',')) sum += stol(tok);\n  cout << sum << endl;\n  return 0;\n}\n",
};
const SOLUTIONS_PRODUCT = {
  javascript: "function product(a, b) {\n  return a * b;\n}\n",
  python: "data = input().strip()\nparts = [int(x) for x in data.split(',')]\np = 1\nfor x in parts: p *= x\nprint(p)\n",
  java: "import java.util.*;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in);\n    long p = 1;\n    for (String s : sc.nextLine().trim().split(\",\")) p *= Long.parseLong(s.trim());\n    System.out.println(p);\n  }\n}\n",
  c: "#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\nint main(void) {\n  char buf[1024];\n  fgets(buf, sizeof(buf), stdin);\n  long p = 1;\n  char *tok = strtok(buf, \",\");\n  while (tok) { p *= atol(tok); tok = strtok(NULL, \",\"); }\n  printf(\"%ld\\n\", p);\n  return 0;\n}\n",
  cpp: "#include <iostream>\n#include <sstream>\nusing namespace std;\nint main() {\n  string line; getline(cin, line);\n  stringstream ss(line); string tok; long p = 1;\n  while (getline(ss, tok, ',')) p *= stol(tok);\n  cout << p << endl;\n  return 0;\n}\n",
};
const LANGUAGES = Object.keys(SOLUTIONS_SUM);

const t0 = Date.now();
function mark(label) {
  console.log(`\n[t+${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);
}

// ---------- Phase 0: confirm HIGH-severity settings actually resolve correctly ----------
mark("Phase 0: verify a sample candidate's resolved settings match nap_klu_2026's real config");
{
  const sample = state.candidates[0];
  const r = await getJson(`/api/exam/questions?candidateId=${sample.candidateId}`);
  const s = r.body.settings || {};
  const ok = s.proctoringSeverity === "HIGH" && s.maxCheatWarnings === 3 && s.webcamProctoringEnabled === true;
  console.log(`  proctoringSeverity=${s.proctoringSeverity} maxCheatWarnings=${s.maxCheatWarnings} webcamProctoringEnabled=${s.webcamProctoringEnabled} -- ${ok ? "MATCHES real drive config" : "MISMATCH -- investigate"}`);
  // undo this probe session so it doesn't count in the later synchronized burst
  state.candidates = state.candidates; // (no-op; this candidate proceeds normally through the real phases too)
}

// ---------- Phase 1: synchronized login ----------
mark("Phase 1: login (388 candidates, same instant)");
const loginReport = await fireAllConcurrently(state.candidates, async (c) => {
  const { status, body } = await postJson("/api/auth/exam-login", { identifier: c.identifier, accessPin: c.accessPin });
  return { status, body };
});
printPhaseReport("Login", loginReport);

// ---------- Phase 2: synchronized questions fetch ----------
mark("Phase 2: GET /api/exam/questions (388 candidates, same instant)");
const questionsReport = await fireAllConcurrently(state.candidates, async (c) => {
  const { status, body } = await getJson(`/api/exam/questions?candidateId=${c.candidateId}`);
  return { status, body };
});
printPhaseReport("Questions fetch", questionsReport);

const bankFailures = questionsReport.results.filter((r) => r.body?.code === "INSUFFICIENT_QUESTION_BANK" || r.body?.code === "UNRESOLVABLE_SESSION_QUESTIONS");
if (bankFailures.length > 0) console.error(`\n!!! ${bankFailures.length} candidates hit the question-bank guard -- unexpected against a freshly-seeded drive.`);

for (let i = 0; i < state.candidates.length; i++) {
  const r = questionsReport.results[i];
  state.candidates[i].sessionId = r.body?.sessionId || null;
  state.candidates[i].mcqQuestions = (r.body?.questions || []).filter((q) => q.type === "MCQ");
  state.candidates[i].codingQuestions = (r.body?.questions || []).filter((q) => q.type === "CODING");
}

// ---------- Phase 3: answer all 30 MCQs via /api/exam/sync ----------
mark("Phase 3: 30 MCQ answers via /api/exam/sync (388 candidates, same instant)");
const syncReport = await fireAllConcurrently(state.candidates, async (c) => {
  if (!c.sessionId) return { status: 0, body: { skipped: true } };
  const responses = {};
  for (const q of c.mcqQuestions) {
    const key = state.mcqAnswerKey.find((k) => k.title === q.title);
    const selectedOption = key ? q.options.find((o) => o === key.correctText) : q.options?.[0];
    responses[q._id ?? q.id] = { selectedOption };
  }
  const { status, body } = await postJson("/api/exam/sync", { sessionId: c.sessionId, candidateId: c.candidateId, incomingResponses: responses });
  c._mcqResponses = responses;
  return { status, body };
});
printPhaseReport("MCQ sync (30 questions)", syncReport);

// ---------- Phase 4: stage transition ----------
mark("Phase 4: MCQ_SUBMIT stage transition (388 candidates, same instant)");
const transitionReport = await fireAllConcurrently(state.candidates, async (c) => {
  if (!c.sessionId) return { status: 0, body: { skipped: true } };
  const { status, body } = await postJson("/api/exam/submit", { sessionId: c.sessionId, candidateId: c.candidateId, finalResponses: c._mcqResponses || {}, stageAction: "MCQ_SUBMIT" });
  return { status, body };
});
printPhaseReport("Stage transition", transitionReport);

// ---------- Phase 5: coding "Run Test Suite" for BOTH coding questions -- the real brutal case (2x Piston load vs earlier tests) ----------
mark("Phase 5: /api/exam/evaluate for BOTH coding questions x 388 candidates, ALL AT ONCE (real coding_count=2 load -- hits Piston)");
const evalJobs = [];
for (let i = 0; i < state.candidates.length; i++) {
  const c = state.candidates[i];
  const lang = LANGUAGES[i % LANGUAGES.length];
  c._language = lang;
  for (const q of c.codingQuestions) {
    const isProduct = q.title?.includes("Product");
    const code = isProduct ? SOLUTIONS_PRODUCT[lang] : SOLUTIONS_SUM[lang];
    evalJobs.push({ candidateIdx: i, questionId: q._id ?? q.id, code, lang, isProduct });
  }
}
console.log(`  ${evalJobs.length} total evaluate calls queued (${state.candidates.length} candidates x up to 2 coding questions each)`);
const evalStart = Date.now();
const evalResults = await Promise.all(
  evalJobs.map(async (job) => {
    const t = Date.now();
    const { status, body } = await postJson("/api/exam/evaluate", { studentCode: job.code, questionId: job.questionId, language: job.lang });
    return { ...job, status, body, elapsed: Date.now() - t };
  })
);
const evalElapsed = Date.now() - evalStart;
const evalSuccess = evalResults.filter((r) => r.status === 200).length;
const evalAllPassed = evalResults.filter((r) => r.body?.results?.every((x) => x.passed)).length;
console.log(`  === Coding evaluate (${evalJobs.length} calls) ===`);
console.log(`  ${evalSuccess}/${evalResults.length} HTTP 200, ${evalAllPassed}/${evalResults.length} fully passed, total wall time ${(evalElapsed / 1000).toFixed(1)}s`);
const evalByLang = {};
for (const r of evalResults) {
  if (!evalByLang[r.lang]) evalByLang[r.lang] = { total: 0, passed: 0 };
  evalByLang[r.lang].total++;
  if (r.body?.results?.every((x) => x.passed)) evalByLang[r.lang].passed++;
}
console.log("  By language:", evalByLang);

// attach results back for the final submit phase
for (const job of evalJobs) {
  const c = state.candidates[job.candidateIdx];
  c._codingResponses = c._codingResponses || {};
  c._codingResponses[job.questionId] = { language: job.lang, codeStr: job.code };
}

// ---------- Phase 6: synchronized FINAL submit (both coding answers + MCQs, ALL AT ONCE) ----------
mark("Phase 6: final /api/exam/submit -- 388 candidates, SAME INSTANT (synchronized time-up simulation)");
const finalReport = await fireAllConcurrently(state.candidates, async (c) => {
  if (!c.sessionId) return { status: 0, body: { skipped: true } };
  const finalResponses = { ...(c._mcqResponses || {}), ...(c._codingResponses || {}) };
  const { status, body } = await postJson("/api/exam/submit", { sessionId: c.sessionId, candidateId: c.candidateId, finalResponses, reason: "MANUAL" });
  return { status, body };
});
printPhaseReport("Final submit", finalReport);

const scoreDistribution = {};
for (const r of finalReport.results) {
  const key = r.body?.finalScore === undefined ? "NO_RESPONSE" : String(r.body.finalScore);
  scoreDistribution[key] = (scoreDistribution[key] || 0) + 1;
}
console.log("  Final score distribution (100 = every MCQ + both coding questions graded correctly):", scoreDistribution);

// ---------- Phase 7: proctoring event ingestion under load (webcam_proctoring_enabled=true) ----------
mark("Phase 7: /api/exam/proctoring SNAPSHOT events, 100 candidates concurrently (real webcam-proctoring-enabled load)");
const proctoringSample = state.candidates.slice(0, 100);
const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const proctoringReport = await fireAllConcurrently(proctoringSample, async (c) => {
  const { status, body } = await postJson("/api/exam/proctoring", {
    sessionId: c.sessionId, candidateId: c.candidateId, eventType: "SNAPSHOT", snapshotBase64: tinyPngBase64,
  });
  return { status, body };
});
printPhaseReport("Proctoring snapshot ingestion (100 concurrent)", proctoringReport);

const totalMs = Date.now() - t0;
console.log(`\n=== DONE in ${(totalMs / 1000).toFixed(1)}s ===`);

const summary = {
  baseUrl: BASE_URL,
  candidateCount: state.candidates.length,
  driveId: state.driveId,
  totalDurationMs: totalMs,
  phases: {
    login: { total: loginReport.total, success: loginReport.successCount, errors: loginReport.errorCount, latency: loginReport.latency },
    questions: { total: questionsReport.total, success: questionsReport.successCount, errors: questionsReport.errorCount, latency: questionsReport.latency, bankFailures: bankFailures.length },
    mcqSync: { total: syncReport.total, success: syncReport.successCount, errors: syncReport.errorCount, latency: syncReport.latency },
    stageTransition: { total: transitionReport.total, success: transitionReport.successCount, errors: transitionReport.errorCount, latency: transitionReport.latency },
    codingEvaluate: { total: evalResults.length, success: evalSuccess, fullyPassed: evalAllPassed, wallTimeMs: evalElapsed, byLanguage: evalByLang },
    finalSubmit: { total: finalReport.total, success: finalReport.successCount, errors: finalReport.errorCount, latency: finalReport.latency },
    proctoring: { total: proctoringReport.total, success: proctoringReport.successCount, errors: proctoringReport.errorCount, latency: proctoringReport.latency },
  },
  scoreDistribution,
};
const outFile = path.join(__dirname, `readiness_report_${state.runTag}.json`);
fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
console.log(`\nFull report written to ${outFile}`);
