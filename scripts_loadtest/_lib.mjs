// Shared helpers for the load-test scripts (seed.mjs / run.mjs / cleanup.mjs).
// Reads Supabase service-role credentials straight from the project's local
// .env, exactly like scripts_incident/*.mjs already does -- these scripts
// talk directly to the production Supabase project to seed/clean up
// disposable test data, while run.mjs separately drives the real deployed
// app over HTTP to exercise the actual server code paths (Next.js API
// routes, Piston) under load.
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env");
const env = fs.readFileSync(envPath, "utf8");
const get = (k) => {
  const m = env.match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
};

export const supabase = createClient(get("SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"));

export const STATE_FILE = path.join(__dirname, "loadtest_state.json");

export function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error(`No ${STATE_FILE} found -- run seed.mjs first.`);
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

// Percentile helper for latency reporting.
export function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
  return sortedArr[idx];
}

export function summarizeLatencies(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    avg: sorted.length ? Math.round(sum / sorted.length) : 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

// Runs `fn(item, index)` for every item in `items`, all truly concurrently
// (a single Promise.all -- no batching/throttling), because the entire point
// of this test is genuine simultaneity ("600 students start at the same
// time"). Returns { results, latencies, statusCounts, errors } where
// `results` preserves input order and never throws -- every outcome
// (success, HTTP error, network error) is captured as data.
export async function fireAllConcurrently(items, fn) {
  const results = await Promise.all(
    items.map(async (item, i) => {
      const start = Date.now();
      try {
        const outcome = await fn(item, i);
        return { ok: true, index: i, latencyMs: Date.now() - start, ...outcome };
      } catch (e) {
        return { ok: false, index: i, latencyMs: Date.now() - start, error: e.message || String(e) };
      }
    })
  );

  const latencies = results.map((r) => r.latencyMs);
  const statusCounts = {};
  let errorCount = 0;
  const sampleErrors = [];
  for (const r of results) {
    const key = r.ok ? String(r.status ?? "200") : "NETWORK_ERROR";
    statusCounts[key] = (statusCounts[key] || 0) + 1;
    if (!r.ok || (r.status && r.status >= 400)) {
      errorCount++;
      if (sampleErrors.length < 10) sampleErrors.push({ index: r.index, status: r.status, error: r.error || r.body?.error });
    }
  }

  return {
    results,
    total: results.length,
    errorCount,
    successCount: results.length - errorCount,
    statusCounts,
    sampleErrors,
    latency: summarizeLatencies(latencies),
  };
}

export function printPhaseReport(phaseName, report) {
  console.log(`\n=== ${phaseName} ===`);
  console.log(`  ${report.successCount}/${report.total} succeeded, ${report.errorCount} errors`);
  console.log(`  status breakdown:`, report.statusCounts);
  console.log(`  latency (ms): min=${report.latency.min} avg=${report.latency.avg} p50=${report.latency.p50} p95=${report.latency.p95} p99=${report.latency.p99} max=${report.latency.max}`);
  if (report.sampleErrors.length > 0) {
    console.log(`  sample errors:`, JSON.stringify(report.sampleErrors, null, 2));
  }
}
