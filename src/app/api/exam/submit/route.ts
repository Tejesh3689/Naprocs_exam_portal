import { NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import { ensureSessionDeadline, isPastDeadline, finalizeSession, coerceEndReason } from "@/lib/examTiming";
import { parseJsonBody } from "@/lib/parseJsonBody";

export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req);
    if (body instanceof NextResponse) return body;
    const { sessionId, candidateId, finalResponses, stageAction, reason } = body;

    if (!sessionId || !candidateId) {
      return NextResponse.json({ error: "Missing identity constraints" }, { status: 400 });
    }

    // 0. Hard Time Limit Enforcement (Server-Side Safety)
    const { data: candidateDoc, error: candidateError } = await supabase
      .from("candidates").select("*").eq("id", candidateId).maybeSingle();
    if (candidateError) throw candidateError;

    if (!candidateDoc) {
       return NextResponse.json({ error: "Candidate identity mismatch" }, { status: 401 });
    }

    const { data: driveDoc, error: driveError } = await supabase
      .from("drives").select("*").eq("id", candidateDoc.drive_id).maybeSingle();
    if (driveError) throw driveError;

    if (driveDoc && driveDoc.exam_end) {
       const now = new Date();
       const cutoff = new Date(new Date(driveDoc.exam_end).getTime() + 120000); // 2 minute network grace period
       if (now > cutoff) {
          return NextResponse.json({
             error: "Assessment window strictly expired.",
             details: "The global cutoff time for this drive has passed. Contact your administrator."
          }, { status: 403 });
       }
    }

    // 1. Handle Stage Transition (MCQ -> CODING)
    if (stageAction === 'MCQ_SUBMIT') {
       const { data: session, error: transitionError } = await supabase
         .from("exam_sessions")
         .update({ responses: finalResponses, current_stage: 'CODING' })
         .eq("id", sessionId)
         .eq("status", "IN_PROGRESS") // guard against updating an already-finalized session
         .select()
         .maybeSingle();
       if (transitionError) throw transitionError;

       if (!session) {
          return NextResponse.json({ error: "Session already finalized" }, { status: 409 });
       }

       return NextResponse.json({
          success: true,
          message: "MCQ Stage Submitted. Proceeding to Coding Section.",
          nextStage: 'CODING'
       }, { status: 200 });
    }

    // 2. Full Completion (CODING -> END). Grading/scoring is idempotent and
    // shared with the lazy abandoned-session sweep -- see src/lib/examTiming.ts.
    const { data: sessionDoc, error: sessionLookupError } = await supabase
      .from("exam_sessions").select("*").eq("id", sessionId).maybeSingle();
    if (sessionLookupError) throw sessionLookupError;

    if (!sessionDoc) {
      return NextResponse.json({ error: "Session invalidation error" }, { status: 404 });
    }

    // Resolve the end reason server-side rather than trusting the client
    // outright: a submit that arrives honestly late (background-tab
    // throttling delayed the client's own timer) is still graded and
    // accepted, just correctly tagged as time-expired instead of manual.
    const deadline = await ensureSessionDeadline(sessionDoc, driveDoc);
    const resolvedReason = isPastDeadline(deadline) ? "TIME_EXPIRED" : coerceEndReason(reason);

    const result = await finalizeSession({
      sessionId,
      candidateId,
      driveDoc,
      finalResponses: finalResponses || {},
      reason: resolvedReason,
    });

    if (!result.success) {
      return NextResponse.json({ error: "Session invalidation error" }, { status: 404 });
    }

    return NextResponse.json({
       success: true,
       finalScore: result.finalScore,
       stage: result.stage,
       message: result.qualifiesForNextRound
         ? `Assessment fully evaluated. Score met the ${result.cutoff}% cutoff -- advanced to Tech Round.`
         : "Assessment fully evaluated and synced."
    }, { status: 200 });

  } catch (error: any) {
    console.error("Exam Final Submit Pipeline Failure:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
