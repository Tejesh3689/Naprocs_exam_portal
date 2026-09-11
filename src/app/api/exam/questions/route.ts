import { NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import { toCamelCase } from "@/lib/caseConvert";
import { ensureSessionDeadline, sweepIfExpired } from "@/lib/examTiming";

// Rulebook rule #7: Mongo's { $sample: { size: n } } aggregation replaced with
// an in-app random sample. Question banks per drive are small (tens, not
// thousands), so fetch-all + shuffle is simpler than maintaining a Postgres
// RPC function for no real benefit at this scale, and this only runs once per
// candidate (session creation), not on the hot path.
function sampleRandom<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const candidateId = searchParams.get("candidateId");

    if (!candidateId) {
      return NextResponse.json({ error: "Candidate identity required for session initialization" }, { status: 400 });
    }

    // 1. Fetch Candidate & Drive
    const { data: candidate, error: candidateError } = await supabase
      .from("candidates").select("*").eq("id", candidateId).maybeSingle();
    if (candidateError) throw candidateError;
    if (!candidate) {
      return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
    }

    const { data: drive, error: driveError } = await supabase
      .from("drives").select("*").eq("id", candidate.drive_id).maybeSingle();
    if (driveError) throw driveError;
    if (!drive) {
      return NextResponse.json({ error: "Associated recruitment drive not found" }, { status: 404 });
    }

    // 2. Initialize or Resume Exam Session
    const { data: existingSession, error: sessionLookupError } = await supabase
      .from("exam_sessions").select("*").eq("candidate_id", candidateId).eq("status", "IN_PROGRESS").maybeSingle();
    if (sessionLookupError) throw sessionLookupError;

    // Lazy-sweep: if this "in progress" session actually ran past its
    // deadline (browser was closed, tab was backgrounded and throttled past
    // the grace window, etc.), finalize it now rather than silently handing
    // the candidate a fresh full-duration attempt on reload. Re-attempts are
    // an explicit admin action (Live Monitoring "Re-attempt" button), never
    // an automatic side effect of refreshing a dead tab.
    if (existingSession) {
      const { swept } = await sweepIfExpired(existingSession);
      if (swept) {
        return NextResponse.json(
          { error: "Your exam session has expired.", expired: true },
          { status: 410 }
        );
      }
    }

    let session = existingSession;
    let questionsToDeliver: any[] = [];

    if (!session) {
      // 2.1 Get Global Defaults for Fallback
      const { data: globalSettings } = await supabase.from("settings").select("*").limit(1).maybeSingle();

      const mcqCount = drive.mcq_count || globalSettings?.mcq_count || 15;
      const codingCount = drive.coding_count || globalSettings?.coding_count || 2;

      // PERFORM RANDOM POOLING (First time session initialization)
      const { data: mcqPool, error: mcqPoolError } = await supabase
        .from("questions").select("*").eq("drive_id", drive.id).eq("type", "MCQ");
      if (mcqPoolError) throw mcqPoolError;

      const { data: codingPoolAll, error: codingPoolAllError } = await supabase
        .from("questions").select("*").eq("drive_id", drive.id).eq("type", "CODING");
      if (codingPoolAllError) throw codingPoolAllError;

      const poolMcqs = sampleRandom(mcqPool || [], mcqCount);
      const poolCoding = sampleRandom(codingPoolAll || [], codingCount);

      questionsToDeliver = [...poolMcqs, ...poolCoding];

      // Hard guard against the 2026-09-09 SVCE incident: a drive whose
      // question bank was never populated (or had its questions uploaded to
      // a *different* drive by mistake) used to silently get a session
      // pinned to `question_ids: []`, then `success: true, questions: []`
      // forever after -- indistinguishable from "still loading" on the
      // client, with no self-heal and no way for the candidate to recover.
      // Refuse to create the session at all in that case: better to send a
      // clear, actionable error than to let every future reload/retry
      // re-resolve the same permanently-empty pick list. See
      // PROCTORING_RULEBOOK.md-adjacent incident notes for the full story.
      if (questionsToDeliver.length === 0) {
        console.error(
          `Empty question bank for drive ${drive.id} ("${drive.title}") -- candidate ${candidateId} blocked from starting.`
        );
        return NextResponse.json(
          {
            error:
              "This exam's question bank isn't ready yet. Please do not retry -- contact your administrator with this drive name and the current time.",
            code: "EMPTY_QUESTION_BANK",
            driveTitle: drive.title,
          },
          { status: 503 }
        );
      }

      // Compute the authoritative deadline once, at creation, rather than
      // leaving the client to (re)derive it from the drive's shared
      // exam_end on every mount -- see src/lib/examTiming.ts.
      const startTime = new Date();
      const durationMs = (drive.exam_duration || 0) * 60_000;
      const driveEndMs = drive.exam_end ? new Date(drive.exam_end).getTime() : Infinity;
      // Deadline jitter: shave 0-15s off (never add) each candidate's own
      // deadline, chosen once here and then fixed for the life of the
      // session. Without this, a cohort that all started together times out
      // at the EXACT same instant -- their client-side auto-submit
      // (dashboard.tsx's timeLeft===0 effect) and the resulting Piston
      // re-grading burst all land in the same millisecond, which is exactly
      // the synchronized-end scenario that saturates the self-hosted Piston
      // droplet's still-limited concurrency (see pistonExecute.ts). Spreading
      // a few hundred candidates' actual time-up moments across a 15s window
      // costs each of them a negligible, undetectable sliver of their exam
      // duration, in exchange for a meaningfully smaller peak burst.
      const JITTER_MAX_MS = 15_000;
      const jitterMs = Math.floor(Math.random() * JITTER_MAX_MS);
      const deadline = new Date(Math.min(startTime.getTime() + durationMs, driveEndMs) - jitterMs);

      // Store the specific IDs in the session so they don't change on refresh.
      // Guarded against a race where two near-simultaneous requests for the
      // same candidate (StrictMode double-fire, a slow network prompting a
      // second attempt, two open tabs) both see "no existing session" and
      // both try to INSERT one: `exam_sessions_one_in_progress_idx` (see
      // migration 010) makes that a unique-violation instead of two rows,
      // and the loser here just re-fetches the winner's session rather than
      // failing outright.
      const { data: newSession, error: createSessionError } = await supabase
        .from("exam_sessions")
        .insert({
          candidate_id: candidateId,
          status: "IN_PROGRESS",
          start_time: startTime.toISOString(),
          deadline: deadline.toISOString(),
          responses: {},
          question_ids: questionsToDeliver.map((q) => q.id),
        })
        .select()
        .single();

      if (createSessionError) {
        if (createSessionError.code === "23505") {
          const { data: winnerSession, error: refetchError } = await supabase
            .from("exam_sessions")
            .select("*")
            .eq("candidate_id", candidateId)
            .eq("status", "IN_PROGRESS")
            .maybeSingle();
          if (refetchError) throw refetchError;
          if (!winnerSession) throw createSessionError;
          session = winnerSession;
          // The winning request locked in its own (independently sampled)
          // question_ids -- resolve *those*, not this request's discarded
          // poolMcqs/poolCoding, so both concurrent callers converge on one
          // consistent question set.
          const winnerIds: string[] = winnerSession.question_ids || [];
          const { data: winnerQuestions, error: winnerQErr } = await supabase
            .from("questions").select("*").in("id", winnerIds);
          if (winnerQErr) throw winnerQErr;
          questionsToDeliver = winnerQuestions || [];
        } else {
          throw createSessionError;
        }
      } else {
        session = newSession;
      }
    } else {
      // Self-heal: legacy sessions created before the `deadline` column
      // existed won't have one yet -- compute and persist it now so the
      // client always gets an authoritative value to seed its countdown
      // from, on this load and every future one.
      await ensureSessionDeadline(session, drive);

      // RESUME: Fetch the exact questions already picked for this student
      const pickedIds: string[] = session.question_ids || [];

      if (pickedIds.length > 0) {
        const { data: pickedQuestions, error: pickedError } = await supabase
          .from("questions").select("*").in("id", pickedIds);
        if (pickedError) throw pickedError;
        questionsToDeliver = pickedQuestions || [];

        // SESSION REPAIR (Self-Healing):
        // If the session is at MCQ stage or just transitioned to CODING, check if it's missing
        // coding questions but the drive configuration expects them.
        const hasCoding = questionsToDeliver.some((q) => q.type === "CODING");
        const expectedCoding = drive.coding_count || 0;

        if (!hasCoding && expectedCoding > 0) {
          console.log(`Self-Healing: Pooling missing coding questions for session ${session.id}`);
          const { data: codingPool, error: codingPoolError } = await supabase
            .from("questions").select("*").eq("drive_id", drive.id).eq("type", "CODING");
          if (codingPoolError) throw codingPoolError;

          const poolCoding = sampleRandom(codingPool || [], expectedCoding);

          if (poolCoding.length > 0) {
            const newIds = poolCoding.map((q) => q.id);
            // Update database session so it persists for future reloads
            const { error: updateError } = await supabase
              .from("exam_sessions")
              .update({ question_ids: [...pickedIds, ...newIds] })
              .eq("id", session.id);
            if (updateError) throw updateError;
            // Append to current delivery
            questionsToDeliver = [...questionsToDeliver, ...poolCoding];
          }
        }
      } else {
        // Fallback for legacy sessions: Assign all current drive questions
        const { data: allQuestions, error: allError } = await supabase
          .from("questions").select("*").eq("drive_id", drive.id);
        if (allError) throw allError;
        questionsToDeliver = allQuestions || [];

        // Update session with these IDs to "lock" them now
        const { error: updateError } = await supabase
          .from("exam_sessions")
          .update({ question_ids: questionsToDeliver.map((q) => q.id) })
          .eq("id", session.id);
        if (updateError) throw updateError;
      }
    }

    // Same guard as the fresh-session path above, covering the resume branch:
    // a session already locked to a `question_ids` list that no longer
    // resolves to any real rows (deleted questions, or a session created
    // during the empty-bank window before this fix existed) must not be
    // handed back as `success: true, questions: []` either -- that is
    // exactly the permanently-stuck-on-reload symptom from the SVCE
    // incident, and unlike the fresh-session case there's no "just don't
    // create it" option since the session already exists.
    if (questionsToDeliver.length === 0) {
      console.error(
        `Session ${session.id} for candidate ${candidateId} resolved to zero questions on resume (drive ${drive.id}, "${drive.title}").`
      );
      return NextResponse.json(
        {
          error:
            "Your exam questions could not be loaded. Please do not retry -- contact your administrator with this session ID.",
          code: "UNRESOLVABLE_SESSION_QUESTIONS",
          sessionId: session.id,
        },
        { status: 503 }
      );
    }

    // 3. Mapping payload for the client (Removing Correct Answers + Hashing Hidden Tests)
    const sanitizedQuestions = questionsToDeliver.map((qRow: any) => {
      const safeQuestion: any = toCamelCase(qRow);

      // If MCQ: Scrub the Correct Answer
      if (safeQuestion.type === 'MCQ') {
        delete safeQuestion.correctAnswer;
      }

      // If Coding: Handle the TestCases
      if (safeQuestion.type === 'CODING' && Array.isArray(safeQuestion.testCases)) {
        safeQuestion.testCases = safeQuestion.testCases.map((tc: any) => {
          if (tc.isHidden) {
            return { ...tc, expectedOutput: "[ PRIVATE TEST CASE ]" };
          }
          return tc;
        });
      }

      return safeQuestion;
    });

    // 4. Resolve Settings Hierarchy: Drive > Global Defaults
    const { data: globalSettingsForMerge } = await supabase.from("settings").select("*").limit(1).maybeSingle();
    const driveObj = toCamelCase(drive);

    // Merge logic: If drive has these proctoring fields, they override global.
    // Otherwise fallback to global or model defaults.
    const resolvedSettings = {
      ...driveObj,
      maxCheatWarnings: drive.max_cheat_warnings ?? globalSettingsForMerge?.max_cheat_warnings ?? 3,
      proctoringSeverity: drive.proctoring_severity ?? globalSettingsForMerge?.proctoring_sensitivity ?? 'MEDIUM'
    };

    return NextResponse.json({
      success: true,
      questions: sanitizedQuestions,
      settings: resolvedSettings, // Return merged settings for frontend consumption
      sessionId: session.id,
      currentStage: session.current_stage || 'MCQ',
      existingResponses: session.responses || {},
      deadline: session.deadline
    }, { status: 200 });

  } catch (error: any) {
    console.error("Exam Fetch Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
