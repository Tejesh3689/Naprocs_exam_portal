import { NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import crypto from "crypto";
import { formatToIST } from "@/lib/time";
import { sweepIfExpired } from "@/lib/examTiming";
import { parseJsonBody } from "@/lib/parseJsonBody";
import { isRateLimited, getClientIp } from "@/lib/rateLimit";

export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req);
    if (body instanceof NextResponse) return body;
    // Accepts either the candidate's email or their college_roll_number in
    // one field -- auto-detected by "@", mirroring loginIdentifierSchema in
    // src/lib/validators.ts. `email` is still accepted for any older client
    // that hasn't picked up the identifier field yet.
    const identifier = body.identifier ?? body.email;
    const { accessPin, existingToken } = body;

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

    // Brute-force guard (external security review, 2026-09-14): the 6-digit
    // PIN has only 10^6 combinations and was completely unthrottled. Two
    // independent limits -- keyed on the specific identifier being targeted
    // (catches "guess every PIN for this one candidate": the real threat,
    // and a low threshold here is exactly what stops it -- 10 guesses/10min
    // makes exhausting 10^6 combinations take ~139 days) and on the client
    // IP (catches "guess across many DIFFERENT candidates from one source").
    //
    // The IP threshold was found, via a full-scale rehearsal (2026-09-14,
    // 388 simulated candidates against production ahead of the real
    // nap_klu_2026 exam), to be dangerously miscalibrated at 30/10min: 373 of
    // 388 got locked out immediately, because an entire exam hall/campus
    // network's candidates very plausibly share one NAT'd public IP -- a
    // realistic scenario this threshold treated as an attack. Raised to
    // 2000/10min: still low enough to eventually catch a genuinely
    // runaway automated flood, but high enough that no real exam cohort
    // sharing a network should ever hit it. The per-identifier limit above
    // is what actually stops PIN brute-forcing; this IP limit is a loose
    // backstop, not the primary defense, and must never be the tighter one.
    if (
      isRateLimited(`exam-login:id:${lookupValue}`, 10, 10 * 60_000) ||
      isRateLimited(`exam-login:ip:${getClientIp(req)}`, 2000, 10 * 60_000)
    ) {
      return NextResponse.json(
        { error: "Too many login attempts. Please wait a few minutes and try again." },
        { status: 429 }
      );
    }

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
    //
    // `last_active_at` is refreshed both by this route AND by every
    // /api/exam/sync autosave tick during normal exam-taking -- so a
    // legitimately reconnecting candidate (page reload after a wifi drop,
    // laptop sleep, browser crash-recovery) ALWAYS looks "recently active"
    // here, indistinguishable from a second device, purely because their own
    // browser was working correctly moments before it reloaded. Found live
    // post-nap_klu_2026: this was locking out genuine single-device
    // reconnects with a false "Concurrency Lock" for up to 2 minutes.
    //
    // `existingToken` breaks that tie: the exam store persists the token this
    // route issues to localStorage (see src/store/examStore.ts), so a
    // reloaded tab on the SAME browser can send it right back. If it matches
    // this candidate's current_session_id exactly, this genuinely is the
    // same device proving its own prior identity -- crypto.randomBytes(32)
    // is not guessable, so this is a real proof, not just a claim -- and the
    // reconnect is let straight through, skipping the block entirely. A
    // different device (a friend trying to log in with a shared PIN) has no
    // way to have this token, so it's still blocked exactly as before.
    const SESSION_EXPIRY_SECONDS = 120; // 2 minutes
    const isSameDeviceReconnect = !!existingToken && existingToken === candidate.current_session_id;

    if (!isSameDeviceReconnect && candidate.last_active_at) {
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
