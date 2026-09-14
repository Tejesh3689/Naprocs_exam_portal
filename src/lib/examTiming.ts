import supabase from "@/lib/supabase";
import { isPistonLanguage, executeViaPiston } from "@/lib/pistonExecute";

// Grace window after a session's deadline before the server treats it as
// truly over -- matches the pre-existing 2-minute network-grace convention
// already used for the drive-wide cutoff check and the multi-device lock.
export const SUBMIT_GRACE_MS = 120_000;

export type EndReason =
  | "MANUAL"
  | "TIME_EXPIRED"
  | "VIOLATION_HIGH_SEVERITY"
  | "VIOLATION_MEDIUM_CAP"
  | "ABANDONED_TIMEOUT";

const VALID_END_REASONS: EndReason[] = [
  "MANUAL",
  "TIME_EXPIRED",
  "VIOLATION_HIGH_SEVERITY",
  "VIOLATION_MEDIUM_CAP",
  "ABANDONED_TIMEOUT",
];

export function coerceEndReason(value: unknown): EndReason {
  return VALID_END_REASONS.includes(value as EndReason) ? (value as EndReason) : "MANUAL";
}

/**
 * Returns a session's authoritative deadline, computing and persisting it
 * once if missing -- self-heals rows created before the `deadline` column
 * existed, or any row the migration's backfill missed. Formula: start_time +
 * drive.exam_duration, capped by the drive's shared exam_end window. This is
 * the exact rule the client used to (re)compute on every mount; now it's
 * computed exactly once, server-side, and never recomputed.
 */
export async function ensureSessionDeadline(session: any, drive: any): Promise<Date> {
  if (session.deadline) return new Date(session.deadline);

  const startMs = new Date(session.start_time).getTime();
  const durationMs = (drive?.exam_duration || 0) * 60_000;
  const driveEndMs = drive?.exam_end ? new Date(drive.exam_end).getTime() : Infinity;
  const deadlineIso = new Date(Math.min(startMs + durationMs, driveEndMs)).toISOString();

  const { error } = await supabase
    .from("exam_sessions")
    .update({ deadline: deadlineIso })
    .eq("id", session.id);
  if (error) throw error;

  session.deadline = deadlineIso;
  return new Date(deadlineIso);
}

export function isPastDeadline(deadline: Date, graceMs: number = SUBMIT_GRACE_MS): boolean {
  return Date.now() > deadline.getTime() + graceMs;
}

// Strips ALL whitespace per line, not just leading/trailing: found live the
// night before the nap_klu_2026 exam -- a correct Python solution to an
// array-returning question printed `[1, 4]` (Python's default list repr)
// against an expected output authored as `[1,4]` (no space), and a plain
// `.trim()` only strips the ends, not that internal comma-space -- a
// semantically correct answer graded wrong purely on language-idiomatic
// formatting. Newlines still separate distinct output lines; only
// within-line whitespace is removed, which is safe since no genuine test
// case in this app relies on internal spacing to distinguish two different
// valid answers.
const robustNormalizeOutput = (s: string) =>
  (s || "")
    .toString()
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim().replace(/\s+/g, ""))
    .filter((l) => l !== "")
    .join("\n")
    .toLowerCase();

export type FinalizeResult =
  | {
      success: true;
      alreadyFinalized: boolean;
      finalScore: number;
      stage: string;
      qualifiesForNextRound?: boolean;
      cutoff?: number | null;
    }
  | { success: false; notFound: true };

/**
 * Idempotent, server-authoritative "end this exam session" pipeline --
 * extracted from the old inline "Full Completion" branch of
 * /api/exam/submit so it can be called from more than one place (a normal
 * candidate submit, and the lazy abandoned-session sweep below). The
 * completing update is scoped to status='IN_PROGRESS', so a second call for
 * an already-finalized session (e.g. a HIGH-severity violation firing the
 * same tick as timer expiry) is a safe no-op that reports the existing
 * score/stage instead of erroring or double-scoring.
 */
export async function finalizeSession(params: {
  sessionId: string;
  candidateId: string;
  driveDoc: any;
  finalResponses: Record<string, any>;
  reason: EndReason;
}): Promise<FinalizeResult> {
  const { sessionId, candidateId, driveDoc, finalResponses, reason } = params;

  const { data: session, error: completionError } = await supabase
    .from("exam_sessions")
    .update({ responses: finalResponses, status: "COMPLETED", end_reason: reason })
    .eq("id", sessionId)
    .eq("status", "IN_PROGRESS")
    .select()
    .maybeSingle();
  if (completionError) throw completionError;

  if (!session) {
    const { data: existingSession } = await supabase
      .from("exam_sessions")
      .select("id")
      .eq("id", sessionId)
      .maybeSingle();
    if (!existingSession) return { success: false, notFound: true };

    const { data: existingCandidate } = await supabase
      .from("candidates")
      .select("exam_score, stage")
      .eq("id", candidateId)
      .maybeSingle();
    return {
      success: true,
      alreadyFinalized: true,
      finalScore: existingCandidate?.exam_score ?? 0,
      stage: existingCandidate?.stage ?? "EXAM_COMPLETED",
    };
  }

  // ---- Scoring (unchanged from the original submit/route.ts logic) ----
  const { data: assignedQuestions, error: assignedError } = await supabase
    .from("questions")
    .select("*")
    .in("id", session.question_ids || []);
  if (assignedError) throw assignedError;

  let evaluationPool = assignedQuestions || [];
  if (evaluationPool.length === 0) {
    const { data: fallbackQuestions, error: fallbackError } = await supabase
      .from("questions")
      .select("*")
      .in("id", Object.keys(finalResponses));
    if (fallbackError) throw fallbackError;
    evaluationPool = fallbackQuestions || [];
  }

  let totalScore = 0;
  const maximumPossibleScore = evaluationPool.length * 10; // 10 points per module

  const vm = await import("node:vm");

  for (const q of evaluationPool) {
    const userRes = finalResponses[q.id];

    if (q.type === "MCQ") {
      const isCorrectIndex = typeof q.correct_answer === "number" || !isNaN(Number(q.correct_answer));
      const expectedText = isCorrectIndex ? q.options[Number(q.correct_answer)] : q.correct_answer;

      if (userRes && (userRes.selectedOption === expectedText || userRes.selectedOption === q.correct_answer)) {
        totalScore += 10;
      }
    } else if (q.type === "CODING") {
      const rawCode: string | undefined = userRes?.codeStr;
      const studentCode = rawCode || q.boilerplate_code || "";
      const testCases = q.test_cases || [];
      const language = userRes?.language;

      if (testCases.length === 0) continue;

      // A candidate who never actually wrote/submitted their own code for
      // this question (rawCode empty/absent -- e.g. selected a language but
      // ran out of time before typing anything) can never legitimately pass
      // any test case. Skip Piston entirely rather than falling back to
      // running the JS boilerplate stub as if it were their answer -- for a
      // Piston language that isn't even valid source in that language, and
      // either way the outcome (0 passed) isn't in question. Pure load
      // reduction: one less wasted execution per untouched submission,
      // exactly the "make less load for Piston" ask.
      if (isPistonLanguage(language) && !rawCode?.trim()) {
        finalResponses[q.id] = { ...userRes, testsPassed: 0, totalTests: testCases.length };
        continue;
      }

      if (isPistonLanguage(language)) {
        let passedCount = 0;
        let hadInfraFailure = false;
        for (const tc of testCases) {
          try {
            // 'high' priority: this IS the authoritative score, computed at
            // the one moment every candidate's Piston calls converge (a
            // synchronized final submit) -- must never queue behind other
            // candidates' optional "Run Tests" pre-checks. See
            // pistonExecute.ts's two-tier queue.
            const { stdout, exitCode } = await executeViaPiston(language, studentCode, (tc.input || "").toString(), undefined, "high");
            // exitCode 124 is pistonExecute.ts's own sentinel for "our
            // per-call timeout fired" -- executeViaPiston already retries
            // this internally a couple of times, but if it STILL comes back
            // this way after those retries, that's infra contention, not a
            // wrong-answer verdict, exactly like a thrown error below.
            if (exitCode === 124) {
              hadInfraFailure = true;
            } else {
              const actual = stdout.trim();
              if (exitCode === 0 && robustNormalizeOutput(actual) === robustNormalizeOutput(tc.expectedOutput)) {
                passedCount++;
              }
            }
          } catch (e: any) {
            console.error(`Piston Scoring Failure for Q ${q.id}:`, e.message);
            hadInfraFailure = true;
          }
        }
        // This re-grading pass is the one moment ALL candidates hit Piston at
        // once (a synchronized final submit, e.g. everyone's time expiring
        // together) -- exactly the load pattern that saturates the
        // self-hosted Piston droplet's (still limited, see pistonExecute.ts)
        // concurrency budget. A thrown error here means Piston genuinely
        // couldn't be reached/was too busy for that test case -- NOT that the
        // code was wrong -- so don't let it silently outscore-downgrade a
        // candidate who already proved their code correct via their own
        // earlier "Run Tests" click. Only trusts the client's prior result
        // when it's actually HIGHER than this (degraded) recount, and only
        // when an infra failure was actually observed -- mirrors the same
        // fallback-to-client-reported-testsPassed pattern already used below
        // for the JS vm path's total-failure case.
        if (hadInfraFailure && typeof userRes?.testsPassed === "number" && userRes.testsPassed > passedCount) {
          passedCount = userRes.testsPassed;
        }
        totalScore += Math.floor((passedCount / testCases.length) * 10);
        finalResponses[q.id] = { ...userRes, testsPassed: passedCount, totalTests: testCases.length };
        continue;
      }

      const funcMatch = studentCode.match(/function\s+([a-zA-Z0-9_$]+)/);
      const entryPoint = funcMatch ? funcMatch[1] : null;

      const wrappedCode = `
        (function(global) {
          global.RESULTS = [];
          const cases = ${JSON.stringify(testCases)};
          const entry = "${entryPoint}";

          for (let i = 0; i < cases.length; i++) {
             const tc = cases[i];
             const res = { index: i, actual: null, error: null };

             global.STDOUT = [];
             global.STDIN_CONTENT = (tc.input || "").toString();

             try {
                (function() {
                  ${studentCode}
                  if (global.STDOUT.length === 0 && entry && typeof eval(entry) === 'function') {
                     let args = [];
                     const rawInput = (tc.input || "").trim();

                     try {
                       if (rawInput.startsWith('[') || rawInput.startsWith('{')) {
                         args = [JSON.parse(rawInput)];
                       } else {
                         throw new Error("Force comma split");
                       }
                     } catch(e) {
                       args = rawInput.split(',').map(v => {
                          const s = v.trim();
                          if (!isNaN(s) && s !== "" && !s.startsWith("0b") && !s.startsWith("0x")) return Number(s);
                          if (s === 'true') return true;
                          if (s === 'false') return false;
                          return s;
                       });
                     }

                     let retValue = eval(entry)(...args);
                     if (retValue !== undefined) {
                        if (Array.isArray(retValue) || (retValue !== null && typeof retValue === 'object')) {
                           retValue = JSON.stringify(retValue);
                        }
                        global.STDOUT.push(String(retValue));
                     }
                  }
                })();
                res.actual = global.STDOUT.join('\\n').trim();
             } catch(e) {
                res.error = e.message;
             }
             global.RESULTS.push(res);
          }
        })(this);
      `;

      const sandbox: any = {
        RESULTS: null,
        STDOUT: [],
        STDIN_CONTENT: "",
        Buffer: Buffer,
        require: (id: string) => {
          if (id === "fs") {
            return {
              readFileSync: (fd: any) => {
                if (fd === 0 || fd === "/dev/stdin") return sandbox.STDIN_CONTENT;
                throw new Error("FS restricted");
              },
            };
          }
          throw new Error("Module restricted");
        },
        console: {
          log: (...args: any[]) => {
            sandbox.STDOUT.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
          },
          info: (...args: any[]) => sandbox.console.log(...args),
          error: (...args: any[]) => sandbox.console.log(...args),
          warn: (...args: any[]) => sandbox.console.log(...args),
        },
        process: {
          stdout: { write: (s: string) => sandbox.STDOUT.push(s) },
        },
      };

      try {
        const context = vm.createContext(sandbox);
        const script = new vm.Script(wrappedCode);
        script.runInContext(context, { timeout: 3500 });

        const results = sandbox.RESULTS;

        if (results && Array.isArray(results)) {
          let passedCount = 0;
          results.forEach((r: any, idx: number) => {
            const tc = testCases[idx];
            const expectedNorm = robustNormalizeOutput(tc.expectedOutput);
            const actualNorm = robustNormalizeOutput(r.actual);
            if (actualNorm === expectedNorm && !r.error) {
              passedCount++;
            }
          });
          totalScore += Math.floor((passedCount / testCases.length) * 10);
          finalResponses[q.id] = { ...userRes, testsPassed: passedCount, totalTests: testCases.length };
        }
      } catch (e: any) {
        console.error(`Scoring VM Failure for Q ${q.id}:`, e.message);
        // If execution fails, fall back to the client's reported testsPassed
        // -- usually means the code was invalid or timed out.
        if (userRes && userRes.testsPassed > 0) {
          totalScore += Math.floor((userRes.testsPassed / userRes.totalTests) * 10);
        }
      }
    }
  }

  const percentileScore = maximumPossibleScore > 0 ? Math.floor((totalScore / maximumPossibleScore) * 100) : 0;

  // The completing update above stored finalResponses BEFORE this scoring
  // loop filled in the authoritative testsPassed/totalTests for coding
  // answers (needed the session row back first to know which questions to
  // grade). Persist the corrected copy now so the exam-report reads figures
  // that actually match the score just computed.
  const { error: responsesPatchError } = await supabase
    .from("exam_sessions")
    .update({ responses: finalResponses })
    .eq("id", sessionId);
  if (responsesPatchError) throw responsesPatchError;

  // Automatic cutoff-based advancement: a candidate who meets or beats the
  // drive's passing_cutoff skips straight to TECH_ROUND instead of sitting
  // in EXAM_COMPLETED waiting on a manual drag. Below cutoff: unchanged --
  // stays EXAM_COMPLETED for an admin to review by hand.
  const cutoff = driveDoc?.passing_cutoff;
  const qualifiesForNextRound = typeof cutoff === "number" && percentileScore >= cutoff;
  const finalStage = qualifiesForNextRound ? "TECH_ROUND" : "EXAM_COMPLETED";

  const { error: patchError } = await supabase
    .from("candidates")
    .update({ exam_score: percentileScore, stage: finalStage })
    .eq("id", candidateId);
  if (patchError) throw patchError;

  return {
    success: true,
    alreadyFinalized: false,
    finalScore: percentileScore,
    stage: finalStage,
    qualifiesForNextRound,
    cutoff,
  };
}

/**
 * Lazy-sweep entry point: a no-op unless the session is IN_PROGRESS and past
 * its deadline+grace. Call this from every route that ever touches a
 * session (questions load, sync heartbeat, submit, login, and the admin
 * live-monitor view) so an abandoned session -- browser closed mid-exam,
 * nobody ever hits submit -- gets finalized the next time ANYTHING looks at
 * it. No cron or scheduled job required.
 */
export async function sweepIfExpired(session: any): Promise<{ swept: boolean }> {
  if (!session || session.status !== "IN_PROGRESS") return { swept: false };

  const { data: candidateDoc } = await supabase
    .from("candidates")
    .select("*")
    .eq("id", session.candidate_id)
    .maybeSingle();
  if (!candidateDoc) return { swept: false };

  const { data: driveDoc } = await supabase
    .from("drives")
    .select("*")
    .eq("id", candidateDoc.drive_id)
    .maybeSingle();
  if (!driveDoc) return { swept: false };

  const deadline = await ensureSessionDeadline(session, driveDoc);
  if (!isPastDeadline(deadline)) return { swept: false };

  const result = await finalizeSession({
    sessionId: session.id,
    candidateId: candidateDoc.id,
    driveDoc,
    finalResponses: session.responses || {},
    reason: "ABANDONED_TIMEOUT",
  });
  return { swept: result.success };
}
