// Minimal in-process rate limiter for the two unauthenticated auth endpoints
// (exam-login's 6-digit PIN, admin-login's shared passphrase) -- an external
// security review (2026-09-14) confirmed neither had ANY throttling, making
// both brute-forceable with no lockout, no CAPTCHA, no delay.
//
// Deliberately simple and generous, not a general-purpose rate limiter:
// - Fixed-window counter, in-process Map -- same single-Railway-instance
//   assumption already made for the Piston concurrency semaphore
//   (src/lib/pistonExecute.ts). If this app is ever horizontally scaled,
//   each instance enforces its own counters independently; revisit with a
//   shared store (Redis/Upstash) if that changes.
// - FAILS OPEN: any error inside the check itself is swallowed and treated
//   as "not limited". A bug in this file must never be able to lock a real
//   candidate out of a live exam -- that would recreate the exact kind of
//   harm this whole hardening pass exists to prevent, just via a different
//   mechanism. A determined attacker getting a few extra free attempts
//   during a rare internal error is a fully acceptable tradeoff against that.
// - Thresholds are deliberately generous (tens of attempts, not single
//   digits) -- this exists to stop a scripted brute-force loop hammering one
//   identifier hundreds/thousands of times, not to second-guess a nervous
//   student mistyping their PIN or roll number a few times.

type Bucket = { count: number; windowStart: number };
const buckets = new Map<string, Bucket>();

// Crude memory cap for a long-running process across many drives/days --
// evicts the oldest entries (Map preserves insertion order) once exceeded.
const MAX_BUCKETS = 50_000;

function pruneIfNeeded() {
  if (buckets.size <= MAX_BUCKETS) return;
  const excess = buckets.size - MAX_BUCKETS + 1000;
  let removed = 0;
  for (const key of buckets.keys()) {
    if (removed >= excess) break;
    buckets.delete(key);
    removed++;
  }
}

/**
 * Returns true if `key` has exceeded `maxAttempts` within the last `windowMs`
 * (and records this call as one more attempt against that key either way).
 * Never throws -- fails open (returns false) on any internal error.
 */
export function isRateLimited(key: string, maxAttempts: number, windowMs: number): boolean {
  try {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart > windowMs) {
      bucket = { count: 0, windowStart: now };
      buckets.set(key, bucket);
    }
    bucket.count++;
    pruneIfNeeded();
    return bucket.count > maxAttempts;
  } catch {
    return false;
  }
}

/**
 * Best-effort real client IP behind Railway's proxy (which sets
 * x-forwarded-for). Falls back to a constant so callers still get a stable
 * (if shared) bucket key rather than crashing when the header is absent
 * (e.g. local dev).
 */
export function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}
