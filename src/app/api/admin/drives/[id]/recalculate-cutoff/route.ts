import { NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import { toCamelCase } from "@/lib/caseConvert";
import { requireAdmin } from "@/lib/adminAuth";

// Backs the "Recalculate Tech Round Eligibility" flow on the drives page --
// lets an admin change a drive's passing_cutoff AFTER the exam and have
// already-finalized candidates re-evaluated against it, without ever
// touching a candidate whose stage reflects a human decision instead of the
// original score-vs-cutoff check. See
// supabase/migrations/011_candidate_stage_source.sql for why that
// distinction (`stage_source`) exists.
//
// Only ever considers candidates currently sitting in EXAM_COMPLETED or
// TECH_ROUND with stage_source = 'AUTO_CUTOFF' -- anyone an admin has since
// dragged, evaluated, or rejected is 'MANUAL' and permanently out of scope
// here, regardless of which direction the cutoff moves.
//
// Raising the cutoff never auto-demotes anyone out of TECH_ROUND -- it only
// surfaces them as "no longer meets cutoff" for the admin to decide by hand
// (a candidate may already have been told they qualified, or have an
// interview scheduled). Lowering the cutoff DOES auto-promote newly
// qualifying EXAM_COMPLETED candidates into TECH_ROUND -- there's no
// downside to that direction, nobody's expectations get walked back.

async function computeImpact(driveId: string) {
  const { data: drive, error: driveError } = await supabase
    .from("drives")
    .select("id,passing_cutoff")
    .eq("id", driveId)
    .maybeSingle();
  if (driveError) throw driveError;
  if (!drive) return { notFound: true as const };

  const cutoff = drive.passing_cutoff;

  const { data: candidates, error: candError } = await supabase
    .from("candidates")
    .select("id,name,college_roll_number,exam_score,stage,stage_source")
    .eq("drive_id", driveId)
    .in("stage", ["EXAM_COMPLETED", "TECH_ROUND"]);
  if (candError) throw candError;

  const eligible = (candidates || []).filter((c) => c.stage_source === "AUTO_CUTOFF");
  const manualExcluded = (candidates || []).filter((c) => c.stage_source !== "AUTO_CUTOFF");

  const newlyQualifying = eligible.filter((c) => c.stage === "EXAM_COMPLETED" && c.exam_score >= cutoff);
  const noLongerQualifying = eligible.filter((c) => c.stage === "TECH_ROUND" && c.exam_score < cutoff);
  const unaffectedCount = eligible.length - newlyQualifying.length - noLongerQualifying.length;

  // Deliberately raw (snake_case, real `id`) -- callers that need to feed
  // these ids back into a `.in("id", ...)` update must not camelCase first
  // (toCamelCase renames `id` -> `_id`). Convert only at the JSON-response
  // boundary, in GET/POST below.
  return {
    notFound: false as const,
    cutoff,
    newlyQualifying,
    noLongerQualifying,
    unaffectedCount,
    manualExcludedCount: manualExcluded.length,
  };
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const unauthorized = await requireAdmin();
    if (unauthorized) return unauthorized;

    const { id: driveId } = await context.params;
    const impact = await computeImpact(driveId);
    if (impact.notFound) return NextResponse.json({ error: "Drive not found" }, { status: 404 });

    return NextResponse.json(
      {
        success: true,
        cutoff: impact.cutoff,
        newlyQualifying: toCamelCase(impact.newlyQualifying),
        noLongerQualifying: toCamelCase(impact.noLongerQualifying),
        unaffectedCount: impact.unaffectedCount,
        manualExcludedCount: impact.manualExcludedCount,
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error("Cutoff Recalculation Preview Failure:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const unauthorized = await requireAdmin();
    if (unauthorized) return unauthorized;

    const { id: driveId } = await context.params;
    // Recompute fresh rather than trusting a candidate-ids list from the
    // client's earlier preview call -- avoids acting on a stale snapshot if
    // anything changed (a new submission finalized, an admin manually moved
    // someone) in the gap between preview and confirm.
    const impact = await computeImpact(driveId);
    if (impact.notFound) return NextResponse.json({ error: "Drive not found" }, { status: 404 });

    const idsToPromote = impact.newlyQualifying.map((c) => c.id);
    if (idsToPromote.length > 0) {
      const { error: updateError } = await supabase
        .from("candidates")
        .update({ stage: "TECH_ROUND", stage_recalculated_at: new Date().toISOString() })
        .in("id", idsToPromote);
      if (updateError) throw updateError;
    }

    return NextResponse.json(
      {
        success: true,
        cutoff: impact.cutoff,
        movedToTechRound: toCamelCase(impact.newlyQualifying),
        flaggedForReview: toCamelCase(impact.noLongerQualifying),
        unaffectedCount: impact.unaffectedCount,
        manualExcludedCount: impact.manualExcludedCount,
        message:
          idsToPromote.length > 0
            ? `${idsToPromote.length} candidate(s) moved to Tech Round.`
            : "No candidates newly qualified -- nothing to move.",
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error("Cutoff Recalculation Apply Failure:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
