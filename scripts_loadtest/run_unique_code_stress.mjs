// Follow-up to run_readiness.mjs: that harness reuses only 10 distinct code
// variants (2 problems x 5 languages), so after the first few calls nearly
// everything is a content-addressed cache hit in pistonExecute.ts -- it
// doesn't stress real Piston capacity, which is what actually changed with
// the droplet resize (1vcpu/1gb, PISTON_MAX_CONCURRENT_JOBS=3 -> 2vcpu/2gb,
// =7). Real candidates each write meaningfully different code, so most of
// their executions are genuine cache MISSES that actually hit Piston.
//
// This script fires a same-instant burst of genuinely-unique code (a random
// per-call comment token defeats the sha256 content-address cache) at the
// real deployed app's /api/exam/evaluate, to measure actual post-upgrade
// Piston throughput/error-rate under a realistic "everyone submits distinct
// code at once" burst.
//
// Usage: node run_unique_code_stress.mjs <BASE_URL> <concurrentCalls>
import { loadState } from "./_lib.mjs";

const BASE_URL = process.argv[2];
const N = parseInt(process.argv[3] || "200", 10);
if (!BASE_URL) {
  console.error("Usage: node run_unique_code_stress.mjs <BASE_URL> <concurrentCalls>");
  process.exit(1);
}

const state = loadState();
const questionId = state.codingQuestionIds[0];

const LANG_TEMPLATES = {
  python: (tok) => `# ${tok}\ndata = input().strip()\nparts = [int(x) for x in data.split(',')]\nprint(sum(parts))\n`,
  javascript: (tok) => `// ${tok}\nfunction sum(a, b) {\n  return a + b;\n}\n`,
  java: (tok) => `// ${tok}\nimport java.util.*;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in);\n    long sum = 0;\n    for (String p : sc.nextLine().trim().split(",")) sum += Long.parseLong(p.trim());\n    System.out.println(sum);\n  }\n}\n`,
  c: (tok) => `// ${tok}\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\nint main(void) {\n  char buf[1024];\n  fgets(buf, sizeof(buf), stdin);\n  long sum = 0;\n  char *tok = strtok(buf, ",");\n  while (tok) { sum += atol(tok); tok = strtok(NULL, ","); }\n  printf("%ld\\n", sum);\n  return 0;\n}\n`,
  cpp: (tok) => `// ${tok}\n#include <iostream>\n#include <sstream>\nusing namespace std;\nint main() {\n  string line; getline(cin, line);\n  stringstream ss(line); string t; long sum = 0;\n  while (getline(ss, t, ',')) sum += stol(t);\n  cout << sum << endl;\n  return 0;\n}\n`,
};
const LANGUAGES = Object.keys(LANG_TEMPLATES);

async function postJson(urlPath, body) {
  const t = Date.now();
  try {
    const res = await fetch(`${BASE_URL}${urlPath}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json, elapsed: Date.now() - t };
  } catch (e) {
    return { status: 0, body: { error: String(e) }, elapsed: Date.now() - t };
  }
}

console.log(`Firing ${N} genuinely-unique, same-instant /api/exam/evaluate calls (defeats content-address cache) at ${BASE_URL}`);
console.log(`Target question: ${questionId}\n`);

const jobs = Array.from({ length: N }, (_, i) => {
  const lang = LANGUAGES[i % LANGUAGES.length];
  const tok = `stress-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`;
  return { lang, code: LANG_TEMPLATES[lang](tok) };
});

const t0 = Date.now();
const results = await Promise.all(
  jobs.map((job) => postJson("/api/exam/evaluate", { studentCode: job.code, questionId, language: job.lang }))
);
const totalMs = Date.now() - t0;

const success = results.filter((r) => r.status === 200);
const timeouts = results.filter((r) => r.body?.error && /busy|timeout|try again/i.test(JSON.stringify(r.body)));
const errors = results.filter((r) => r.status !== 200);
const passed = results.filter((r) => r.body?.results?.every?.((x) => x.passed));

const latencies = success.map((r) => r.elapsed).sort((a, b) => a - b);
const pct = (p) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] : null;

console.log(`=== Unique-code stress (${N} genuinely distinct, same-instant calls) ===`);
console.log(`  ${success.length}/${N} HTTP 200, ${errors.length} non-200, ${timeouts.length} explicit busy/timeout responses`);
console.log(`  ${passed.length}/${N} fully passed (expected: all, since each is a correct solution)`);
console.log(`  total wall time: ${(totalMs / 1000).toFixed(1)}s`);
console.log(`  latency (ms): min=${latencies[0]} avg=${Math.round(latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1))} p50=${pct(50)} p95=${pct(95)} p99=${pct(99)} max=${latencies[latencies.length - 1]}`);
if (errors.length > 0) {
  console.log(`  sample error bodies:`, errors.slice(0, 3).map((r) => r.body));
}
