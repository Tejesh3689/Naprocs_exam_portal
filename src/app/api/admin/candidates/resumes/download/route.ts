import { NextResponse } from "next/server";
import { ZipArchive } from "archiver";
import supabase from "@/lib/supabase";
import { requireAdmin } from "@/lib/adminAuth";

// archiver needs Node's zlib/stream -- not available on the Edge runtime.
export const runtime = "nodejs";

// Buffers the whole zip in memory (see buildZipBuffer below) rather than
// streaming it out incrementally. Fine for a Tech Round-sized batch (a
// filtered subset of exam-takers, not an entire drive); revisit with a
// streaming response if this is ever asked to zip hundreds of resumes at
// once. The hard cap below is the immediate safeguard against that.
const MAX_CANDIDATES_PER_REQUEST = 500;

function sanitizeSegment(input: string | null | undefined, fallback: string): string {
  const cleaned = (input || "").trim().replace(/[^a-zA-Z0-9-_]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

function buildZipBuffer(entries: { name: string; buffer: Buffer }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", (err: Error) => reject(err));
    for (const entry of entries) {
      archive.append(entry.buffer, { name: entry.name });
    }
    archive.finalize();
  });
}

export async function POST(req: Request) {
  try {
    const unauthorized = await requireAdmin();
    if (unauthorized) return unauthorized;

    const { candidateIds } = await req.json();
    if (!candidateIds || !Array.isArray(candidateIds) || candidateIds.length === 0) {
      return NextResponse.json({ error: "No candidates specified" }, { status: 400 });
    }
    if (candidateIds.length > MAX_CANDIDATES_PER_REQUEST) {
      return NextResponse.json(
        { error: `Too many candidates requested at once (max ${MAX_CANDIDATES_PER_REQUEST})` },
        { status: 400 }
      );
    }

    const { data: candidates, error } = await supabase
      .from("candidates")
      .select("id,name,college_roll_number,resume_url")
      .in("id", candidateIds);
    if (error) throw error;

    const withResume = (candidates || []).filter((c: any) => !!c.resume_url);
    const skippedNoResume = (candidates || []).length - withResume.length;

    if (withResume.length === 0) {
      return NextResponse.json({ error: "None of the selected candidates have a resume on file" }, { status: 404 });
    }

    // Download each resume from the private bucket, tolerating individual
    // failures (a stale/missing storage object shouldn't fail the whole
    // batch) -- via allSettled rather than Promise.all.
    const results = await Promise.allSettled(
      withResume.map(async (c: any) => {
        const { data, error: dlError } = await supabase.storage.from("resumes").download(c.resume_url);
        if (dlError || !data) throw dlError || new Error("Empty download");
        const buffer = Buffer.from(await data.arrayBuffer());
        const roll = sanitizeSegment(c.college_roll_number, c.id);
        const name = sanitizeSegment(c.name, "candidate");
        return { id: c.id as string, name: `${roll}_${name}.pdf`, buffer };
      })
    );

    const fetched: { id: string; name: string; buffer: Buffer }[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") fetched.push(r.value);
    }
    const totalSkipped = skippedNoResume + (results.length - fetched.length);

    if (fetched.length === 0) {
      return NextResponse.json({ error: "Failed to retrieve any resume files" }, { status: 502 });
    }

    // De-duplicate filenames (two candidates could share a sanitized
    // roll+name after stripping special characters) before they collide as
    // zip entries.
    const usedNames = new Set<string>();
    const namedEntries = fetched.map(({ id, name, buffer }) => {
      let finalName = name;
      if (usedNames.has(finalName)) {
        finalName = `${name.replace(/\.pdf$/, "")}_${id.slice(0, 6)}.pdf`;
      }
      usedNames.add(finalName);
      return { name: finalName, buffer };
    });

    if (namedEntries.length === 1) {
      const only = namedEntries[0];
      return new NextResponse(new Blob([new Uint8Array(only.buffer)]), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${only.name}"`,
          "X-Skipped-Count": String(totalSkipped),
        },
      });
    }

    const zipBuffer = await buildZipBuffer(namedEntries);
    return new NextResponse(new Blob([new Uint8Array(zipBuffer)]), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="tech-round-resumes.zip"`,
        "X-Skipped-Count": String(totalSkipped),
      },
    });
  } catch (error: any) {
    console.error("Resume bulk download failure:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
