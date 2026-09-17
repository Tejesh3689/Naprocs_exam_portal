import { NextResponse } from "next/server";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import supabase from "@/lib/supabase";
import { requireAdmin } from "@/lib/adminAuth";
import { formatToIST } from "@/lib/time";

// jsPDF resolves to its dedicated Node build via package.json's "node"
// export condition -- no browser/DOM dependency needed for a plain
// text+table PDF like this one.
export const runtime = "nodejs";

function sanitizeFilenameSegment(input: string | null | undefined, fallback: string): string {
  const cleaned = (input || "").trim().replace(/[^a-zA-Z0-9-_]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

// Mirrors tech-round-report/route.ts, scoped to HR_ROUND instead. Same
// deliberately narrow select() -- name + roll number + email only, nothing
// else from the candidates row. There's no automatic score-based cutoff
// feeding entry into HR_ROUND (unlike EXAM_COMPLETED -> TECH_ROUND, which
// has exam_score/passing_cutoff) -- every candidate here got there via a
// manual admin decision, so this is a read-only roster export only, with no
// "recalculate eligibility" counterpart.
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const unauthorized = await requireAdmin();
    if (unauthorized) return unauthorized;

    const { id: driveId } = await context.params;

    const { data: drive, error: driveError } = await supabase
      .from("drives")
      .select("id,title")
      .eq("id", driveId)
      .maybeSingle();
    if (driveError) throw driveError;
    if (!drive) return NextResponse.json({ error: "Drive not found" }, { status: 404 });

    const { data: candidates, error: candError } = await supabase
      .from("candidates")
      .select("name,email,college_roll_number")
      .eq("drive_id", driveId)
      .eq("stage", "HR_ROUND")
      .order("name", { ascending: true });
    if (candError) throw candError;

    const doc = new jsPDF();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text(`${drive.title} -- HR Round Selection List`, 14, 20);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text(`Generated: ${formatToIST(new Date())}`, 14, 28);
    doc.text(`Total selected: ${candidates?.length || 0}`, 14, 34);

    if (!candidates || candidates.length === 0) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(11);
      doc.text("No candidates currently in HR Round for this drive.", 14, 48);
    } else {
      const rows = candidates.map((c: any, i: number) => [
        String(i + 1),
        c.name || "--",
        c.college_roll_number || "--",
        c.email || "--",
      ]);
      autoTable(doc, {
        startY: 40,
        head: [["#", "Name", "College Roll Number", "Email"]],
        body: rows,
        theme: "grid",
        headStyles: { fillColor: [46, 204, 113], textColor: [255, 255, 255] },
        alternateRowStyles: { fillColor: [240, 255, 240] },
        styles: { fontSize: 9 },
      });
    }

    const pdfBuffer = Buffer.from(doc.output("arraybuffer"));
    const filename = `${sanitizeFilenameSegment(drive.title, "drive")}_hr_round_list.pdf`;

    return new NextResponse(new Blob([new Uint8Array(pdfBuffer)]), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error: any) {
    console.error("HR Round report generation failure:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
