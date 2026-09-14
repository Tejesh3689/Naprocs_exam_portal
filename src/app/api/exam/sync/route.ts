import { NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import { sweepIfExpired } from "@/lib/examTiming";
import { parseJsonBody } from "@/lib/parseJsonBody";

export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req);
    if (body instanceof NextResponse) return body;
    const { sessionId, candidateId, incomingResponses, cheatWarnings } = body;

    if (!sessionId || !candidateId || !incomingResponses) {
      return NextResponse.json({ error: "Invalid sync ping structure" }, { status: 400 });
    }

    // Lazy-sweep safety net: a backgrounded tab's client-side timer can be
    // throttled by the browser and miss its own deadline, but this 60s
    // heartbeat still arrives roughly on schedule. If the session is
    // already past its deadline, finalize it here instead of blindly
    // accepting a stale sync write -- the client's own timer will
    // independently reach 0 next time the tab is visible and call submit,
    // which then hits finalizeSession's idempotent alreadyFinalized path.
    const { data: sessionForSweep } = await supabase
      .from("exam_sessions").select("*").eq("id", sessionId).maybeSingle();
    if (sessionForSweep?.status === "IN_PROGRESS") {
      const { swept } = await sweepIfExpired(sessionForSweep);
      if (swept) {
        return NextResponse.json({ success: true, expired: true, timestamp: Date.now() }, { status: 200 });
      }
    }

    // Ping the lightweight update -- scoped to IN_PROGRESS so a sync ping
    // that lands after the candidate has already submitted can't clobber
    // the authoritative, server-graded responses written by /api/exam/submit
    // with a stale client-side snapshot (this raced with a real candidate's
    // final submit and erased her graded coding result -- see
    // SUPABASE_MIGRATION.md). Once COMPLETED/TERMINATED, this is a no-op.
    const { data: syncedSession, error: syncError } = await supabase
      .from("exam_sessions")
      .update({ responses: incomingResponses })
      .eq("id", sessionId)
      .eq("status", "IN_PROGRESS")
      .select()
      .maybeSingle();
    if (syncError) throw syncError;

    if (!syncedSession) {
      // Either the session doesn't exist, or (far more commonly) it just
      // isn't IN_PROGRESS anymore -- the candidate already submitted. Not
      // an error: the heartbeat below still records last-active for the
      // (now-finished) session, and there's nothing left to sync.
      const { error: heartbeatOnlyError } = await supabase
        .from("candidates")
        .update({ last_active_at: new Date().toISOString() })
        .eq("id", candidateId);
      if (heartbeatOnlyError) throw heartbeatOnlyError;
      return NextResponse.json({ success: true, timestamp: Date.now(), skipped: "session not in progress" }, { status: 200 });
    }

    // Update Heartbeat to maintain concurrency lock, and persist any
    // proctoring violation count immediately (not just on the next tick --
    // this used to live only in client-side state and never reached the DB).
    const candidateUpdate: Record<string, any> = { last_active_at: new Date().toISOString() };
    if (typeof cheatWarnings === 'number') {
      candidateUpdate.cheat_warnings = cheatWarnings;
    }
    const { error: heartbeatError } = await supabase
      .from("candidates")
      .update(candidateUpdate)
      .eq("id", candidateId);
    if (heartbeatError) throw heartbeatError;

    return NextResponse.json({ success: true, timestamp: Date.now() }, { status: 200 });

  } catch (error: any) {
    console.error("Exam Sync Fault:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
