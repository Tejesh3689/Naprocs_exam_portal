import { NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import crypto from "crypto";
import { parseJsonBody } from "@/lib/parseJsonBody";

const VALID_EVENT_TYPES = ["SNAPSHOT", "NO_FACE", "MULTIPLE_FACES", "LOOKING_AWAY", "HIGH_NOISE"];

export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req);
    if (body instanceof NextResponse) return body;
    const { sessionId, candidateId, eventType, snapshotBase64 } = body;

    if (!sessionId || !candidateId || !eventType || !snapshotBase64) {
      return NextResponse.json({ error: "Invalid proctoring event structure" }, { status: 400 });
    }
    if (!VALID_EVENT_TYPES.includes(eventType)) {
      return NextResponse.json({ error: "Unknown event type" }, { status: 400 });
    }

    // Same IN_PROGRESS-only guard as /api/exam/sync -- an evidence snapshot
    // or violation that lands after the candidate has already submitted is a
    // no-op, not an error: there's no live session left to attach it to.
    const { data: session, error: sessionError } = await supabase
      .from("exam_sessions")
      .select("id")
      .eq("id", sessionId)
      .eq("status", "IN_PROGRESS")
      .maybeSingle();
    if (sessionError) throw sessionError;
    if (!session) {
      return NextResponse.json({ success: true, skipped: "session not in progress" }, { status: 200 });
    }

    const { data: candidate, error: candidateError } = await supabase
      .from("candidates")
      .select("drive_id")
      .eq("id", candidateId)
      .maybeSingle();
    if (candidateError) throw candidateError;
    if (!candidate) {
      return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
    }

    // Client sends a bare base64 JPEG with the data: prefix already
    // stripped -- strip it defensively anyway in case a caller forgets.
    const base64Data = snapshotBase64.includes(",") ? snapshotBase64.split(",")[1] : snapshotBase64;
    const buffer = Buffer.from(base64Data, "base64");
    const snapshotPath = `${candidate.drive_id}/${candidateId}/${crypto.randomUUID()}.jpg`;

    const { error: uploadError } = await supabase.storage
      .from("proctoring-snapshots")
      .upload(snapshotPath, buffer, { contentType: "image/jpeg" });
    if (uploadError) throw uploadError;

    const { error: insertError } = await supabase.from("proctoring_events").insert({
      candidate_id: candidateId,
      session_id: sessionId,
      event_type: eventType,
      snapshot_path: snapshotPath,
    });
    if (insertError) throw insertError;

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error: any) {
    console.error("Proctoring Event Fault:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
