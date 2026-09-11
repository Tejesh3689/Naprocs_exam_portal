// Drives the REAL deployed app (over HTTP) through a full exam cycle for
// every seeded candidate, with each phase fired as one genuinely-concurrent
// batch (see fireAllConcurrently in _lib.mjs) -- this is what simulates
// "600 students start at the same time" and "600 students end at the same
// time" rather than a steady trickle.
//
// Usage: node run.mjs <BASE_URL>
//   node run.mjs https://naprocsexamportal-production.up.railway.app
import { loadState, fireAllConcurrently, printPhaseReport } from "./_lib.mjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.argv[2];
if (!BASE_URL) {
  console.error("Usage: node run.mjs <BASE_URL>");
  process.exit(1);
}

const state = loadState();
console.log(`Loaded state: ${state.candidates.length} candidates on drive ${state.driveId} ("${state.driveTitle}")`);
console.log(`Target: ${BASE_URL}\n`);

async function postJson(urlPath, body) {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function getJson(urlPath) {
  const res = await fetch(`${BASE_URL}${urlPath}`);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

// One correct solution per language, verified against seed.mjs's exact test
// cases ("3,4"->7, "10,20"->30, "-5,5"->0). Round-robin assignment spreads
// real concurrent load across all 5 supported languages -- javascript stays
// in-process (vm), the other four hit the self-hosted Piston instance.
const SOLUTIONS = {
  javascript: "function sum(a, b) {\n  return a + b;\n}\n",
  python: "data = input().strip()\nparts = [int(x) for x in data.split(',')]\nprint(sum(parts))\n",
  java: "import java.util.*;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in);\n    String line = sc.hasNextLine() ? sc.nextLine() : \"\";\n    long sum = 0;\n    for (String p : line.trim().split(\",\")) sum += Long.parseLong(p.trim());\n    System.out.println(sum);\n  }\n}\n",
  c: "#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\nint main(void) {\n  char buf[1024];\n  if (!fgets(buf, sizeof(buf), stdin)) return 0;\n  long sum = 0;\n  char *tok = strtok(buf, \",\");\n  while (tok) { sum += atol(tok); tok = strtok(NULL, \",\"); }\n  printf(\"%ld\\n\", sum);\n  return 0;\n}\n",
  cpp: "#include <iostream>\n#include <sstream>\n#include <string>\nusing namespace std;\nint main() {\n  string line;\n  getline(cin, line);\n  stringstream ss(line);\n  string tok;\n  long sum = 0;\n  while (getline(ss, tok, ',')) sum += stol(tok);\n  cout << sum << endl;\n  return 0;\n}\n",
};
// Re-widened to all languages (2026-09-11) after fixing Piston: the droplet
// now runs with PISTON_MAX_CONCURRENT_JOBS=3 + a 128MB per-job memory limit
// (was unlimited-memory/64-concurrent defaults, which is why this used to
// OOM-kill under trivial load), and pistonExecute.ts added a matching
// in-process concurrency gate + realistic timeout so genuinely-queued (not
// actually-failed) executions don't get killed by our own client first.
// Confirmed via direct testing: 6 concurrent Java submissions now all score
// 100% correctly (just slower -- ~40-60s instead of instant). Expect
// meaningfully higher latency at real scale on this still-small ($6/mo,
// 1vCPU/1GB) droplet -- that's an accepted, honest tradeoff (slow-but-correct
// or a clear "busy, try again") over the old silent-wrong-score failure mode.
const LANGUAGES = Object.keys(SOLUTIONS);

const t0 = Date.now();
const timeline = [];
function mark(label) {
  const t = Date.now() - t0;
  timeline.push({ label, elapsedMs: t });
  console.log(`\n[t+${(t / 1000).toFixed(1)}s] ${label}`);
}

// ---------- Phase 1: synchronized login ----------
mark("Phase 1: login (all candidates, same instant)");
const loginReport = await fireAllConcurrently(state.candidates, async (c) => {
  const { status, body } = await postJson("/api/auth/exam-login", {
    identifier: c.identifier,
    accessPin: c.accessPin,
  });
  return { status, body };
});
printPhaseReport("Login", loginReport);

// ---------- Phase 2: synchronized questions fetch (the exact code path that broke) ----------
mark("Phase 2: GET /api/exam/questions (all candidates, same instant)");
const questionsReport = await fireAllConcurrently(state.candidates, async (c) => {
  const { status, body } = await getJson(`/api/exam/questions?candidateId=${c.candidateId}`);
  return { status, body };
});
printPhaseReport("Questions fetch", questionsReport);

// Flag specifically the failure modes this whole exercise exists to catch.
const emptyBankHits = questionsReport.results.filter((r) => r.body?.code === "EMPTY_QUESTION_BANK" || r.body?.code === "UNRESOLVABLE_SESSION_QUESTIONS");
if (emptyBankHits.length > 0) {
  console.error(`\n!!! ${emptyBankHits.length} candidates hit the empty-question-bank guard -- this should never happen against a freshly-seeded drive. Investigate before proceeding.`);
}

// Attach resolved session info + question data back onto each candidate for later phases.
for (let i = 0; i < state.candidates.length; i++) {
  const r = questionsReport.results[i];
  state.candidates[i].sessionId = r.body?.sessionId || null;
  state.candidates[i].mcqQuestions = (r.body?.questions || []).filter((q) => q.type === "MCQ");
  state.candidates[i].codingQuestion = (r.body?.questions || []).find((q) => q.type === "CODING") || null;
}

// ---------- Phase 3: answer MCQs via /api/exam/sync ----------
mark("Phase 3: MCQ answers via /api/exam/sync (all candidates, same instant)");
const syncReport = await fireAllConcurrently(state.candidates, async (c) => {
  if (!c.sessionId) return { status: 0, body: { skipped: true } };
  const responses = {};
  for (const q of c.mcqQuestions) {
    const key = state.mcqAnswerKey.find((k) => k.title === q.title);
    const selectedOption = key ? q.options.find((o) => o === key.correctText) : q.options?.[0];
    responses[q._id ?? q.id] = { selectedOption };
  }
  const { status, body } = await postJson("/api/exam/sync", {
    sessionId: c.sessionId,
    candidateId: c.candidateId,
    incomingResponses: responses,
  });
  c._mcqResponses = responses;
  return { status, body };
});
printPhaseReport("MCQ sync", syncReport);

// ---------- Phase 4: MCQ -> CODING stage transition ----------
mark("Phase 4: MCQ_SUBMIT stage transition (all candidates, same instant)");
const transitionReport = await fireAllConcurrently(state.candidates, async (c) => {
  if (!c.sessionId) return { status: 0, body: { skipped: true } };
  const { status, body } = await postJson("/api/exam/submit", {
    sessionId: c.sessionId,
    candidateId: c.candidateId,
    finalResponses: c._mcqResponses || {},
    stageAction: "MCQ_SUBMIT",
  });
  return { status, body };
});
printPhaseReport("Stage transition", transitionReport);

// ---------- Phase 5: coding "Run Test Suite" via /api/exam/evaluate (hits Piston for real) ----------
mark("Phase 5: /api/exam/evaluate coding run (all candidates, same instant -- hits Piston)");
const evaluateReport = await fireAllConcurrently(state.candidates, async (c, i) => {
  if (!c.codingQuestion) return { status: 0, body: { skipped: true } };
  const language = LANGUAGES[i % LANGUAGES.length];
  const studentCode = SOLUTIONS[language];
  c._language = language;
  c._studentCode = studentCode;
  const { status, body } = await postJson("/api/exam/evaluate", {
    studentCode,
    questionId: c.codingQuestion._id ?? c.codingQuestion.id,
    language,
  });
  return { status, body };
});
printPhaseReport("Coding evaluate (Piston)", evaluateReport);

// HTTP 200 alone doesn't mean the code actually ran correctly -- Piston under
// concurrent load can silently fail individual test-case executions (timeout,
// transient container contention) while the route still returns a normal
// success response with `passed: false` entries. Since every submitted
// solution here is independently verified correct, ANY non-100% pass rate at
// this scale is a Piston-under-load signal, not a bad solution.
const evalPassRateByLanguage = {};
for (let i = 0; i < state.candidates.length; i++) {
  const c = state.candidates[i];
  const r = evaluateReport.results[i];
  const results = r?.body?.results || [];
  const passed = results.filter((x) => x.passed).length;
  const total = results.length;
  const lang = c._language || "unknown";
  if (!evalPassRateByLanguage[lang]) evalPassRateByLanguage[lang] = { candidates: 0, fullyPassed: 0, totalTestCases: 0, passedTestCases: 0 };
  evalPassRateByLanguage[lang].candidates++;
  evalPassRateByLanguage[lang].totalTestCases += total;
  evalPassRateByLanguage[lang].passedTestCases += passed;
  if (total > 0 && passed === total) evalPassRateByLanguage[lang].fullyPassed++;
}
console.log("  Piston correctness by language (every solution is known-correct -- any shortfall is infra, not logic):");
for (const [lang, s] of Object.entries(evalPassRateByLanguage)) {
  console.log(`    ${lang}: ${s.fullyPassed}/${s.candidates} candidates fully passed | ${s.passedTestCases}/${s.totalTestCases} test cases passed`);
}

// ---------- Phase 6: synchronized FINAL submit (server re-runs Piston again for scoring) ----------
mark("Phase 6: final /api/exam/submit (all candidates, SAME INSTANT -- simulates synchronized time-up)");
const finalReport = await fireAllConcurrently(state.candidates, async (c) => {
  if (!c.sessionId) return { status: 0, body: { skipped: true } };
  const finalResponses = { ...(c._mcqResponses || {}) };
  if (c.codingQuestion) {
    finalResponses[c.codingQuestion._id ?? c.codingQuestion.id] = {
      codeStr: c._studentCode,
      language: c._language,
    };
  }
  const { status, body } = await postJson("/api/exam/submit", {
    sessionId: c.sessionId,
    candidateId: c.candidateId,
    finalResponses,
    reason: "MANUAL",
  });
  return { status, body };
});
printPhaseReport("Final submit", finalReport);

// Score distribution -- every candidate answered every MCQ correctly and
// submitted a known-correct coding solution, so 100% is the only "clean"
// outcome. Anything else at final-submit time (which re-runs Piston server-side
// AGAIN, independent of Phase 5's run) is graded-under-load evidence.
const scoreDistribution = {};
const scoreByLanguage = {};
for (let i = 0; i < state.candidates.length; i++) {
  const c = state.candidates[i];
  const r = finalReport.results[i];
  const score = r?.body?.finalScore;
  const key = score === undefined ? "NO_RESPONSE" : String(score);
  scoreDistribution[key] = (scoreDistribution[key] || 0) + 1;
  const lang = c._language || "unknown";
  if (!scoreByLanguage[lang]) scoreByLanguage[lang] = {};
  scoreByLanguage[lang][key] = (scoreByLanguage[lang][key] || 0) + 1;
}
console.log("  Final score distribution (100 = every MCQ + coding test case graded correctly):", scoreDistribution);
console.log("  Score distribution by language:", scoreByLanguage);

const totalMs = Date.now() - t0;
console.log(`\n=== DONE in ${(totalMs / 1000).toFixed(1)}s ===`);

const summary = {
  baseUrl: BASE_URL,
  candidateCount: state.candidates.length,
  driveId: state.driveId,
  totalDurationMs: totalMs,
  timeline,
  phases: {
    login: { total: loginReport.total, success: loginReport.successCount, errors: loginReport.errorCount, statusCounts: loginReport.statusCounts, latency: loginReport.latency, sampleErrors: loginReport.sampleErrors },
    questions: { total: questionsReport.total, success: questionsReport.successCount, errors: questionsReport.errorCount, statusCounts: questionsReport.statusCounts, latency: questionsReport.latency, sampleErrors: questionsReport.sampleErrors, emptyBankHits: emptyBankHits.length },
    mcqSync: { total: syncReport.total, success: syncReport.successCount, errors: syncReport.errorCount, statusCounts: syncReport.statusCounts, latency: syncReport.latency, sampleErrors: syncReport.sampleErrors },
    stageTransition: { total: transitionReport.total, success: transitionReport.successCount, errors: transitionReport.errorCount, statusCounts: transitionReport.statusCounts, latency: transitionReport.latency, sampleErrors: transitionReport.sampleErrors },
    codingEvaluate: { total: evaluateReport.total, success: evaluateReport.successCount, errors: evaluateReport.errorCount, statusCounts: evaluateReport.statusCounts, latency: evaluateReport.latency, sampleErrors: evaluateReport.sampleErrors },
    finalSubmit: { total: finalReport.total, success: finalReport.successCount, errors: finalReport.errorCount, statusCounts: finalReport.statusCounts, latency: finalReport.latency, sampleErrors: finalReport.sampleErrors },
  },
  pistonCorrectnessByLanguage: evalPassRateByLanguage,
  scoreDistribution,
  scoreByLanguage,
};

const outFile = path.join(__dirname, `report_${state.runTag}.json`);
fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
console.log(`\nFull report written to ${outFile}`);
