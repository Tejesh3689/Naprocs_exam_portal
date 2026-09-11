import { NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import crypto from "crypto";
import { formatToIST } from "@/lib/time";
import { sweepIfExpired } from "@/lib/examTiming";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    // Accepts either the candidate's email or their college_roll_number in
    // one field -- auto-detected by "@", mirroring loginIdentifierSchema in
    // src/lib/validators.ts. `email` is still accepted for any older client
    // that hasn't picked up the identifier field yet.
    const identifier = body.identifier ?? body.email;
    const { accessPin } = body;

    if (!identifier || !accessPin) {
      return NextResponse.json({ error: "Email/Roll Number and Access PIN are required" }, { status: 400 });
    }

    const rawIdentifier = String(identifier).trim();
    const isEmailIdentifier = rawIdentifier.includes("@");
    const lookupField = isEmailIdentifier ? "email" : "college_roll_number";
    // Matches the normalization applied at registration time (lowercase
    // email, uppercase roll number) and the backfill in
    // supabase/migrations/008_normalize_candidate_identifiers.sql.
    const lookupValue = isEmailIdentifier ? rawIdentifier.toLowerCase() : rawIdentifier.toUpperCase();

    // 1. Find Candidate First to get their Drive Association
    const { data: candidate, error: candidateError } = await supabase
      .from("candidates")
      .select("*")
      .eq(lookupField, lookupValue)
      .eq("access_pin", String(accessPin).trim())
      .maybeSingle();
    if (candidateError) throw candidateError;
    if (!candidate) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    // 2. Fetch Associated Drive and Enforce Specific Scheduling Window
    const { data: drive, error: driveError } = await supabase
      .from("drives")
      .select("*")
      .eq("id", candidate.drive_id)
      .maybeSingle();
    if (driveError) throw driveError;
    if (!drive) {
      return NextResponse.json({ error: "Your recruitment drive record is missing. Please contact admin." }, { status: 404 });
    }

    if (!drive.is_exam_active) {
      return NextResponse.json({
        error: "The assessment portal for your batch is currently deactivated."
      }, { status: 403 });
    }

    const now = new Date();
    const GRACE_PERIOD = 2 * 60 * 1000; // 2 minutes buffer
    const PRE_EXAM_WINDOW_MS = 10 * 60 * 1000; // candidates may log in this far ahead of exam_start

    if (drive.exam_start) {
      const examStart = new Date(drive.exam_start);
      const windowOpensAt = new Date(examStart.getTime() - PRE_EXAM_WINDOW_MS);
      if (now < windowOpensAt) {
        // Message keeps the literal phrase "opens on" -- the frontend
        // string-matches on it to decide which error card to show.
        return NextResponse.json({
          error: `Your assessment portal opens on ${formatToIST(windowOpensAt)}`
        }, { status: 403 });
      }
    }
    if (drive.exam_end && now.getTime() > new Date(drive.exam_end).getTime() + GRACE_PERIOD) {
      return NextResponse.json({
        error: "The assessment window for your batch has closed."
      }, { status: 403 });
    }

    // 2a. Lazy-sweep: if this candidate has a session the server considers
    // abandoned (past its deadline, never submitted -- browser closed
    // mid-exam), finalize it now instead of letting them land back on a
    // dead dashboard. This is what actually surfaces abandoned sessions to
    // admins as COMPLETED/ABANDONED_TIMEOUT instead of stuck IN_PROGRESS
    // forever -- see src/lib/examTiming.ts.
    //
    // Not `.maybeSingle()`: duplicate IN_PROGRESS rows for one candidate are
    // a real, reproduced scenario (see the matching fix + comment in
    // src/app/api/exam/questions/route.ts) -- `.maybeSingle()` here would
    // silently discard its error and just skip the sweep entirely for an
    // affected candidate (this destructure doesn't even check `error`),
    // rather than crash, but still means an abandoned duplicate never gets
    // swept. Same oldest-row-is-canonical resolution as the other call site.
    const { data: activeSessions } = await supabase
      .from("exam_sessions")
      .select("*")
      .eq("candidate_id", candidate.id)
      .eq("status", "IN_PROGRESS")
      .order("created_at", { ascending: true });
    const activeSession = activeSessions?.[0] || null;
    if (activeSession) {
      const { swept } = await sweepIfExpired(activeSession);
      if (swept) {
        // Reuses the exact same "Assessment Received" dead-end card the
        // frontend already shows for a genuinely-completed exam (matched by
        // this NOT containing "opens on"/"scheduled" -- see exam/page.tsx's
        // onSubmit) -- accurate messaging either way: this candidate's
        // attempt is over and finalized, whether by their own submit or by
        // the server's abandoned-session sweep.
        return NextResponse.json({
          error: "Your previous assessment session has expired due to inactivity or the time limit. Please contact your administrator.",
          name: candidate.name,
          collegeRollNumber: candidate.college_roll_number
        }, { status: 403 });
      }
    }

    // 3. Multi-Device Security Layer
    const SESSION_EXPIRY_SECONDS = 120; // 2 minutes

    if (candidate.last_active_at) {
      const timeSinceLastActive = (now.getTime() - new Date(candidate.last_active_at).getTime()) / 1000;
      if (timeSinceLastActive < SESSION_EXPIRY_SECONDS) {
        return NextResponse.json({
          error: "Active session detected on another device. Please wait 2 minutes for the previous session to expire or close other tabs.",
          name: candidate.name,
          collegeRollNumber: candidate.college_roll_number
        }, { status: 409 });
      }
    }

    // Generate a simple mock pseudo-token for the session
    const token = crypto.randomBytes(32).toString('hex');

    // Claim the session
    const { error: claimError } = await supabase
      .from("candidates")
      .update({ last_active_at: now.toISOString(), current_session_id: token })
      .eq("id", candidate.id);
    if (claimError) throw claimError;

    return NextResponse.json(
      {
        success: true,
        candidateId: candidate.id,
        name: candidate.name,
        email: candidate.email,
        collegeRollNumber: candidate.college_roll_number,
        token,
        webcamProctoringEnabled: drive.webcam_proctoring_enabled ?? false,
        examStart: drive.exam_start,
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error("Login Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
