import { NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import { requireAdmin } from "@/lib/adminAuth";

const VALID_STAGES = ['EXAM_PENDING', 'EXAM_COMPLETED', 'TECH_ROUND', 'HR_ROUND', 'SELECTED', 'REJECTED'];

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const unauthorized = await requireAdmin();
    if (unauthorized) return unauthorized;

    const params = await context.params;
    const { id } = params;
    const { stage } = await req.json();

    if (!stage || !VALID_STAGES.includes(stage)) {
      return NextResponse.json({ error: "Invalid stage descriptor mapped" }, { status: 400 });
    }

    // A drag in the Kanban board is an explicit human decision -- mark it
    // MANUAL so a future cutoff recalculation (see
    // /api/admin/drives/[id]/recalculate-cutoff) never overrides it.
    const { data: updatedCandidate, error } = await supabase
      .from("candidates")
      .update({ stage, stage_source: "MANUAL" })
      .eq("id", id)
      .select()
      .maybeSingle();

    if (error) throw error;

    if (!updatedCandidate) {
      return NextResponse.json({ error: "Candidate reference null" }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      stage: updatedCandidate.stage,
      message: "Stage mapping mutated seamlessly."
    }, { status: 200 });

  } catch (error: any) {
    console.error("Mutation Stage Failure:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
