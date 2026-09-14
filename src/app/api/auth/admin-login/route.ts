import { NextResponse } from "next/server";
import { SignJWT } from "jose";
import { parseJsonBody } from "@/lib/parseJsonBody";
import { isRateLimited, getClientIp } from "@/lib/rateLimit";

export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req);
    if (body instanceof NextResponse) return body;
    const { passphrase } = body;

    // Brute-force guard (external security review, 2026-09-14): one shared
    // passphrase, no usernames, previously zero throttling -- gates the
    // entire admin surface (candidate PII, resumes, results). IP-only (no
    // per-admin identity to key on until V-04's multi-account work happens).
    // Tighter than exam-login's threshold since far fewer legitimate people
    // ever hit this endpoint. See src/lib/rateLimit.ts for the fail-open
    // guarantee.
    if (isRateLimited(`admin-login:ip:${getClientIp(req)}`, 10, 10 * 60_000)) {
      return NextResponse.json(
        { error: "Too many login attempts. Please wait a few minutes and try again." },
        { status: 429 }
      );
    }

    const secretPassphrase = process.env.ADMIN_SECRET_PASSPHRASE;

    if (!secretPassphrase) {
       return NextResponse.json({ error: "Server misconfiguration. Admin secret not set." }, { status: 500 });
    }

    if (passphrase !== secretPassphrase) {
       return NextResponse.json({ error: "Invalid generic credentials" }, { status: 401 });
    }

    // Sign the JWT bridging Next.js generic Edge limits
    const secret = new TextEncoder().encode(secretPassphrase);
    const alg = 'HS256';

    // Session length: 2 hours, not 24. A 24h cookie on a shared lab/kiosk
    // computer (the normal way this app gets used on a recruitment drive
    // day -- an admin sets up the drive on a shared machine, then students
    // use that same browser for /exam) stays valid long after the admin's
    // actual work is done. Anyone who later uses that same browser can
    // reach /admin with zero credentials just by navigating there, because
    // the cookie is still valid -- proxy.ts (src/proxy.ts) correctly
    // verifies it as a real signed session, since nothing distinguishes
    // "the admin is still here" from "the admin was here 20 hours ago and
    // forgot to sign out." 2h caps that exposure window to the length of a
    // normal setup session instead of most of a day.
    const SESSION_MAX_AGE_SECONDS = 60 * 60 * 2;

    const jwt = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg })
      .setIssuedAt()
      .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
      .sign(secret);

    // Formulate a generic strict cookie mapped response
    const response = NextResponse.json({ success: true, message: "Authentication payload validated" }, { status: 200 });

    response.cookies.set('adminAuthToken', jwt, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: SESSION_MAX_AGE_SECONDS,
      path: '/'
    });

    return response;

  } catch (error: any) {
    console.error("Admin Credential Parsing Error:", error);
    return NextResponse.json({ error: "Internal Server Fault" }, { status: 500 });
  }
}
