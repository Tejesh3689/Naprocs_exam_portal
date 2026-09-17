import { NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import { toCamelCase } from "@/lib/caseConvert";
import { requireAdmin } from "@/lib/adminAuth";
import { sweepIfExpired } from "@/lib/examTiming";

// Backs the unified admin/control-center "Live Monitoring" page. Replaces
// having to visit two separate pages (Control Center for activity/stage/
// cheat-warnings, Proctoring Overview for webcam flags/snapshots) to get
// the full picture of one candidate -- and, unlike either of those, this
// includes candidates who are still mid-exam (stage never leaves
// EXAM_PENDING until final submit), not just ones who've already finished.
//
// Three flat queries, no N+1: candidates for the drive, their exam_sessions
// (status/start_time/deadline), and their proctoring_events aggregated by
// type + latest timestamp.
const CANDIDATE_COLUMNS =
  "id,name,email,college_roll_number,stage,exam_score,cheat_warnings,last_active_at,last_reset_at";

const ACTIVE_WINDOW_MS = 120_000; // matches the existing convention (control-center, exam-login concurrency lock)

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const unauthorized = await requireAdmin();
    if (unauthorized) return unauthorized;

    const { id: driveId } = await context.params;

    let { data: candidates, error: candidatesError } = await supabase
      .from("candidates")
      .select(CANDIDATE_COLUMNS)
      .eq("drive_id", driveId)
      .order("exam_score", { ascending: false });
    if (candidatesError) throw candidatesError;

    const candidateIds = (candidates || []).map((c) => c.id);

    // Most-recent exam_sessions row per candidate. NOTE: a candidate can, in
    // practice, end up with more than one row (found 2026-09-17, post
    // nap_klu_2026: a stray extra /api/exam/questions request arriving after
    // the drive's exam window had already closed used to create a second,
    // born-already-expired session -- see the window-close guard added to
    // that route) -- picking the latest by start_time here is a real
    // defensive need, not just a hedge.
    let sessionByCandidateId: Record<string, { id: string; status: string; start_time: string; deadline: string | null; responses: any; candidate_id: string }> = {};
    if (candidateIds.length > 0) {
      const { data: sessions, error: sessionsError } = await supabase
        .from("exam_sessions")
        .select("id,candidate_id,status,start_time,deadline,responses")
        .in("candidate_id", candidateIds)
        .order("start_time", { ascending: false });
      if (sessionsError) throw sessionsError;
      for (const s of sessions || []) {
        if (!sessionByCandidateId[s.candidate_id]) {
          sessionByCandidateId[s.candidate_id] = s;
        }
      }

      // Proactive sweep (2026-09-17 fix): this route's own doc comment always
      // said "no cron required -- call this from ... the admin live-monitor
      // view" so an abandoned session gets finalized as soon as ANYTHING
      // looks at it, but this route never actually did. That gap is exactly
      // why nap_klu_2026 had dozens of candidates left permanently
      // IN_PROGRESS, ungraded, past their deadline -- nothing ever revisited
      // them once their own browser tab stopped making requests. Since an
      // admin's Live Monitoring page already polls this endpoint every 30s
      // during a live exam (see PROCTORING_RULEBOOK.md), this closes the gap
      // with no new infrastructure: any session that's gone stale gets
      // finalized within one polling interval of the admin having this page
      // open, not "whenever that specific candidate happens to come back".
      const inProgress = Object.values(sessionByCandidateId).filter((s) => s.status === "IN_PROGRESS");
      if (inProgress.length > 0) {
        await Promise.allSettled(inProgress.map((s) => sweepIfExpired(s)));
        // Re-fetch sessions AND candidates: sweeping just finalized some
        // rows (status -> COMPLETED) and, via finalizeSession, updated those
        // candidates' exam_score/stage -- both of which were already read
        // above, before the sweep ran. Without this, this same response
        // would show a candidate as freshly-swept in `session_status` while
        // still reporting their pre-sweep (stale) score/stage right next to it.
        const [{ data: freshSessions, error: freshSessionsError }, { data: freshCandidates, error: freshCandidatesError }] = await Promise.all([
          supabase.from("exam_sessions").select("id,candidate_id,status,start_time,deadline,responses").in("candidate_id", candidateIds).order("start_time", { ascending: false }),
          supabase.from("candidates").select(CANDIDATE_COLUMNS).eq("drive_id", driveId).order("exam_score", { ascending: false }),
        ]);
        if (freshSessionsError) throw freshSessionsError;
        if (freshCandidatesError) throw freshCandidatesError;
        candidates = freshCandidates;
        sessionByCandidateId = {};
        for (const s of freshSessions || []) {
          if (!sessionByCandidateId[s.candidate_id]) {
            sessionByCandidateId[s.candidate_id] = s;
          }
        }
      }
    }

    // Proctoring flag counts + latest snapshot timestamp per candidate.
    const proctoringByCandidateId: Record<
      string,
      { snapshotCount: number; noFace: number; multipleFaces: number; lookingAway: number; highNoise: number; latestSnapshotAt: string | null }
    > = {};
    for (const id of candidateIds) {
      proctoringByCandidateId[id] = { snapshotCount: 0, noFace: 0, multipleFaces: 0, lookingAway: 0, highNoise: 0, latestSnapshotAt: null };
    }
    if (candidateIds.length > 0) {
      const { data: events, error: eventsError } = await supabase
        .from("proctoring_events")
        .select("candidate_id,event_type,created_at")
        .in("candidate_id", candidateIds);
      if (eventsError) throw eventsError;

      for (const e of events || []) {
        const bucket = proctoringByCandidateId[e.candidate_id];
        if (!bucket) continue;
        bucket.snapshotCount += 1;
        if (e.event_type === "NO_FACE") bucket.noFace += 1;
        else if (e.event_type === "MULTIPLE_FACES") bucket.multipleFaces += 1;
        else if (e.event_type === "LOOKING_AWAY") bucket.lookingAway += 1;
        else if (e.event_type === "HIGH_NOISE") bucket.highNoise += 1;
        if (!bucket.latestSnapshotAt || e.created_at > bucket.latestSnapshotAt) {
          bucket.latestSnapshotAt = e.created_at;
        }
      }
    }

    const now = Date.now();
    const roster = (candidates || []).map((c) => {
      const session = sessionByCandidateId[c.id] || null;
      const isActiveNow = !!c.last_active_at && now - new Date(c.last_active_at).getTime() < ACTIVE_WINDOW_MS;

      const writingStatus: "WRITING" | "COMPLETED" | "NOT_STARTED" =
        c.stage !== "EXAM_PENDING" ? "COMPLETED" : session?.status === "IN_PROGRESS" ? "WRITING" : "NOT_STARTED";

      return {
        ...c,
        is_active_now: isActiveNow,
        session_status: session?.status ?? null,
        session_start_time: session?.start_time ?? null,
        session_deadline: session?.deadline ?? null,
        writing_status: writingStatus,
        ...proctoringByCandidateId[c.id],
      };
    });

    return NextResponse.json({ success: true, candidates: toCamelCase(roster) }, { status: 200 });
  } catch (error: any) {
    console.error("Live Monitor Aggregation Failure:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
