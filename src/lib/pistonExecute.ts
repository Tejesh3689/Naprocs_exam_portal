// Multi-language code execution via a self-hosted Piston instance
// (https://github.com/engineer-man/piston). Researched and verified live:
// the public Piston API went whitelist-only as of 2026-02-15, so
// PISTON_API_URL must point at a self-hosted instance (Docker: `docker run
// -d --privileged -p 2000:2000 -v piston_data:/piston
// ghcr.io/engineer-man/piston`, then install each language package via
// `POST /api/v2/packages`). Requires a Docker-capable host in production
// (Railway/Render/self-host; NOT serverless-only platforms like Netlify).

import crypto from "crypto";

const PISTON_API_URL = process.env.PISTON_API_URL || "http://localhost:2000";

// The self-hosted Piston droplet (naprocs-piston-server, DigitalOcean
// s-1vcpu-1gb -- 1 vCPU, ~1GB RAM) is now configured with
// PISTON_MAX_CONCURRENT_JOBS=3 and a 128MB per-job memory limit (see the
// droplet's `docker run` env, applied 2026-09-11) -- previously it ran on
// Piston's defaults (64 concurrent jobs, UNLIMITED memory per job), which is
// exactly why even 4 concurrent Java executions (JVM being the heaviest
// per-job footprint) silently OOM-killed the whole box, and 300 concurrent
// Python executions buried it entirely (~92% timed out). See
// scripts_loadtest/ load-test results from that incident.
//
// This in-process semaphore mirrors that same cap on OUR side: without it,
// a burst of concurrent candidates each fire their own outbound request to
// Piston immediately, all landing in Piston's internal queue at once, each
// one independently racing our OWN client-side abort timeout below -- which
// is exactly what caused genuine (queued, not actually failing) executions
// to get killed by OUR OWN client before Piston even started them, once the
// concurrency cap went in. Queueing here instead means only
// MAX_CONCURRENT_PISTON_CALLS requests are ever in flight to Piston at once;
// everyone else waits in an ordered in-process queue with a generous but
// bounded wait, and gets a clear "busy, try again" error instead of a false
// timeout if that wait is exceeded.
//
// Caveat: this is a single Node process's in-memory queue. If this app is
// ever horizontally scaled to multiple server instances, each instance
// enforces this cap independently (not coordinated globally) -- fine at
// today's scale, but revisit (e.g. a shared Redis-backed semaphore) if that
// changes.
// 2026-09-17: droplet upgraded 1vcpu/1gb -> 2vcpu/2gb (s-2vcpu-2gb), Piston's
// own PISTON_MAX_CONCURRENT_JOBS raised 3 -> 7 to match -- keep these two in
// sync; this is a client-side mirror of that same box's real capacity.
const MAX_CONCURRENT_PISTON_CALLS = 7;
const MAX_QUEUE_WAIT_MS = 25_000;
let activePistonCalls = 0;

// Two-tier queue, not one FIFO list: a candidate's optional "Run Tests"
// click and the server's OWN authoritative re-grading during final submit
// (examTiming.ts) used to compete for slots as equals. The one that actually
// determines a score should never be stuck behind exploratory pre-checks
// during a synchronized-submission burst -- so `high` (final-grading calls)
// is always drained before `normal` (interactive evaluate calls).
export type PistonPriority = "high" | "normal";
const pistonWaitQueues: Record<PistonPriority, Array<() => void>> = { high: [], normal: [] };

function releaseNextInQueue() {
  activePistonCalls--;
  const next = pistonWaitQueues.high.shift() || pistonWaitQueues.normal.shift();
  if (next) next();
}

// Acquires a concurrency slot, or throws a clear, honest "busy" error if one
// doesn't free up within MAX_QUEUE_WAIT_MS. Always resolves with a release
// function -- callers MUST call it (in a `finally`) once done.
async function acquirePistonSlot(priority: PistonPriority): Promise<() => void> {
  if (activePistonCalls < MAX_CONCURRENT_PISTON_CALLS) {
    activePistonCalls++;
    return () => releaseNextInQueue();
  }

  return new Promise((resolve, reject) => {
    const queue = pistonWaitQueues[priority];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = queue.indexOf(onTurn);
      if (idx !== -1) queue.splice(idx, 1);
      reject(new Error("The code execution service is currently very busy handling other submissions. Please wait a moment and try again."));
    }, MAX_QUEUE_WAIT_MS);

    function onTurn() {
      if (settled) return; // already timed out; let the next queued caller take the slot instead
      settled = true;
      clearTimeout(timer);
      activePistonCalls++;
      resolve(() => releaseNextInQueue());
    }

    queue.push(onTurn);
  });
}

// Maps our app's language identifiers to Piston's language name, the pinned
// version actually installed, and the filename Piston needs (Java requires
// the public class name to match the filename exactly).
const LANGUAGE_CONFIG: Record<string, { language: string; version: string; filename: string }> = {
  python: { language: "python", version: "3.10.0", filename: "main.py" },
  java: { language: "java", version: "15.0.2", filename: "Main.java" },
  c: { language: "c", version: "10.2.0", filename: "main.c" },
  cpp: { language: "c++", version: "10.2.0", filename: "main.cpp" },
};

export function isPistonLanguage(language: string | undefined | null): language is keyof typeof LANGUAGE_CONFIG {
  return !!language && language in LANGUAGE_CONFIG;
}

export interface PistonResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function executeOnce(language: string, code: string, stdin: string, timeoutMs: number, priority: PistonPriority): Promise<PistonResult> {
  const config = LANGUAGE_CONFIG[language];
  if (!config) throw new Error(`Unsupported Piston language: ${language}`);

  // Wait for a concurrency slot BEFORE starting the network call/timeout
  // clock below -- this is what keeps a burst of candidates from all
  // landing in Piston's own internal queue simultaneously, each one
  // independently racing (and losing to) the abort timer while genuinely
  // still waiting its turn, not actually failing.
  const releaseSlot = await acquirePistonSlot(priority);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.PISTON_API_KEY) {
      headers["Authorization"] = `Bearer ${process.env.PISTON_API_KEY}`;
    }

    const res = await fetch(`${PISTON_API_URL}/api/v2/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        language: config.language,
        version: config.version,
        files: [{ name: config.filename, content: code }],
        stdin,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({} as any));
      throw new Error(errBody.message || `Execution service returned status ${res.status}`);
    }

    const data = await res.json();

    // Some Piston versions report a separate `compile` step for compiled
    // languages; if it failed, surface that instead of a (nonexistent) run.
    if (data.compile && data.compile.code !== 0) {
      return { stdout: "", stderr: data.compile.stderr || data.compile.output || "Compilation failed", exitCode: data.compile.code };
    }

    return {
      stdout: data.run?.stdout || "",
      stderr: data.run?.stderr || "",
      exitCode: data.run?.code ?? 1,
    };
  } catch (e: any) {
    if (e.name === "AbortError") {
      return { stdout: "", stderr: "Execution timed out.", exitCode: 124 };
    }
    throw e;
  } finally {
    clearTimeout(timer);
    releaseSlot();
  }
}

// Found via a real candidate's submission + reproduction: this self-hosted
// Piston setup occasionally returns a clean exit (code 0, no stderr) with
// completely empty stdout, on a program that should always print something --
// a byte-identical retry of the exact same request then succeeds normally.
// 12/12 isolated direct calls (sequential and concurrent) never reproduced it,
// but real usage did -- consistent with transient infra flakiness (container
// job-cleanup timing under Docker Desktop's virtualization), not a code bug.
// A retry costs nothing for genuinely-broken candidate code (it'll just fail
// again, identically) but protects a genuinely-correct answer from being
// marked wrong by infrastructure noise -- same reasoning as the Supabase
// Storage 429 retry (SUPABASE_MIGRATION.md).
function looksSuspiciouslyEmpty(result: PistonResult): boolean {
  return result.exitCode === 0 && result.stdout.trim() === "" && result.stderr.trim() === "";
}

// Content-addressed result cache: (language, code, stdin) deterministically
// produces the same (stdout, stderr, exitCode) for well-behaved programs (no
// wall-clock/random-without-seed dependence -- a safe assumption for the
// simple stdin->stdout exam questions this judges). A candidate very
// commonly hits Piston twice for the SAME unchanged code: once via their own
// "Run Tests" click, then again when examTiming.ts re-grades authoritatively
// at final submit -- exactly the highest-contention moment (a synchronized
// submission burst). A cache hit skips the concurrency queue and the network
// call entirely. Also naturally dedupes identical submissions across
// DIFFERENT candidates (e.g. everyone's unchanged starter-code boilerplate).
// Deliberately NOT keyed by candidate/session -- purely by content, so this
// needs no plumbing through either call site.
const MAX_CACHE_ENTRIES = 2000;
const resultCache = new Map<string, PistonResult>();

function cacheKeyFor(language: string, code: string, stdin: string): string {
  return crypto.createHash("sha256").update(language).update("\0").update(code).update("\0").update(stdin).digest("hex");
}

function rememberResult(key: string, result: PistonResult) {
  if (resultCache.size >= MAX_CACHE_ENTRIES) {
    // Map preserves insertion order -- .keys().next().value is the oldest
    // entry, giving a simple FIFO eviction with no extra bookkeeping.
    const oldest = resultCache.keys().next().value;
    if (oldest !== undefined) resultCache.delete(oldest);
  }
  resultCache.set(key, result);
}

// Full-program, stdin -> stdout execution (the code receives `stdin` as
// standard input and must print its answer to standard output) -- the
// standard convention for multi-language judges, and the only one that's
// portable across Python/Java/C/C++ without per-language question authoring.
// 20s, not the previous 8s: this timeout now covers only the ACTUAL Piston
// round-trip (compile + run) once acquirePistonSlot() above has already
// granted a concurrency slot -- queue *waiting* time is handled separately
// (MAX_QUEUE_WAIT_MS above), so this just needs to comfortably cover
// PISTON_COMPILE_TIMEOUT (10s) + PISTON_RUN_TIMEOUT (8s) worst case without
// the two clocks fighting each other.
//
// `priority`: 'high' for the server's own authoritative re-grading
// (examTiming.ts, at final submit) so it can never get stuck in queue behind
// a candidate's optional "Run Tests" pre-check (`normal`, the default) during
// a synchronized-submission burst -- see the two-tier queue above.
export async function executeViaPiston(
  language: string,
  code: string,
  stdin: string,
  timeoutMs = 20_000,
  priority: PistonPriority = "normal"
): Promise<PistonResult> {
  const key = cacheKeyFor(language, code, stdin);
  const cached = resultCache.get(key);
  if (cached) return cached;

  let lastResult: PistonResult | null = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    const result = await executeOnce(language, code, stdin, timeoutMs, priority);
    // exitCode 124 is executeOnce's own sentinel for "the request was
    // aborted by OUR per-call timeout" (AbortController firing) -- a
    // transient infra symptom under contention, not a deterministic function
    // of the code, exactly like "suspiciously empty" below. Found by a full
    // 388-candidate/776-coding-submission rehearsal (2026-09-14): under
    // heavy load this returns NORMALLY (not thrown), so it used to sail past
    // the cache-eligibility check and get remembered as if it were the
    // code's real output -- meaning one bad timeout during a candidate's own
    // "Run Tests" click would replay as a permanent wrong answer at final
    // submit too, even minutes later once Piston had fully recovered, with
    // no self-heal. (Genuinely busy-queue rejections are a separate, already
    // safe path -- acquirePistonSlot's timeout THROWS, which skips this
    // caching logic entirely rather than reaching here.)
    const isTransientInfraSymptom = looksSuspiciouslyEmpty(result) || result.exitCode === 124;
    if (!isTransientInfraSymptom) {
      rememberResult(key, result);
      return result;
    }
    lastResult = result;
    await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 150));
  }
  // Every retry hit a transient infra symptom -- deliberately NOT cached: a
  // later call for this same code should get a fresh attempt rather than
  // being stuck replaying the same glitch forever.
  return lastResult!;
}
