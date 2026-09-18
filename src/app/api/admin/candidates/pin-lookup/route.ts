import { NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import { toCamelCase } from "@/lib/caseConvert";
import { requireAdmin } from "@/lib/adminAuth";

// Purpose-built for the "student forgot their 6-digit PIN on exam day"
// scenario -- every other admin candidate route deliberately EXCLUDES
// access_pin from its select() (see the comment on CANDIDATE_COLUMNS in
// /api/admin/candidates/route.ts), and rightly so: it's a login credential,
// not something that should show up in a general roster view. This route is
// the one deliberate, narrow exception -- admin-gated exactly like every
// other /api/admin/* route, and scoped to a search query so it never dumps
// a full candidate list with PINs attached.
//
// access_pin is stored and compared as plain text already (see
// /api/auth/exam-login/route.ts's `.eq("access_pin", ...)`) -- this route
// doesn't introduce a new class of exposure, it just gives an admin who
// already has full database access a fast way to look up what a panicking
// candidate has forgotten, without needing to open Supabase directly.
const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS = 20;

export async function GET(req: Request) {
  try {
    const unauthorized = await requireAdmin();
    if (unauthorized) return unauthorized;

    const { searchParams } = new URL(req.url);
    const query = (searchParams.get("query") || "").trim();
    const driveId = searchParams.get("driveId");

    if (query.length < MIN_QUERY_LENGTH) {
      return NextResponse.json({ success: true, candidates: [] }, { status: 200 });
    }

    let dbQuery = supabase
      .from("candidates")
      .select("id,name,email,college_roll_number,access_pin,stage,drive_id,drives(title)")
      .or(`name.ilike.%${query}%,email.ilike.%${query}%,college_roll_number.ilike.%${query}%`)
      .order("name", { ascending: true })
      .limit(MAX_RESULTS);

    if (driveId) {
      dbQuery = dbQuery.eq("drive_id", driveId);
    }

    const { data: candidates, error } = await dbQuery;
    if (error) throw error;

    // Server-side log only (no dedicated audit table -- this app has no
    // per-admin identity beyond a single shared passphrase, see
    // src/app/api/auth/admin-login/route.ts, so "who" would just say
    // "admin" either way). Matches the existing logging style used for
    // other sensitive one-off admin actions (candidate reset).
    console.log(`[Admin] PIN lookup: query="${query}"${driveId ? ` driveId=${driveId}` : ""} -- ${candidates?.length || 0} match(es)`);

    const flattened = (candidates || []).map((c: any) => ({
      ...c,
      drive_title: c.drives?.title || null,
      drives: undefined,
    }));

    return NextResponse.json({ success: true, candidates: toCamelCase(flattened) }, { status: 200 });
  } catch (error: any) {
    console.error("PIN Lookup Failure:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
