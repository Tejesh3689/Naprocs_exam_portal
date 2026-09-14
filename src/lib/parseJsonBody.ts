import { NextResponse } from "next/server";

// Every POST route already wraps its whole body in one outer try/catch that
// falls through to a generic 500 on ANY thrown error -- including a
// malformed/truncated JSON body, which `req.json()` rejects with a SyntaxError
// indistinguishable (to that outer catch) from a real server fault. Found by
// an external security review (2026-09-14): this isn't a stability risk (the
// exception is already caught, no crash, no stack trace leaked) but it is a
// clarity gap -- a client sending garbage gets the same opaque
// "Internal Server Error" as an actual bug.
//
// Usage (drop-in, no other change to the route's existing logic/error shape):
//   const body = await parseJsonBody(req);
//   if (body instanceof NextResponse) return body;
//   const { foo, bar } = body;
export async function parseJsonBody(req: Request): Promise<any | NextResponse> {
  try {
    return await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body -- expected valid JSON." }, { status: 400 });
  }
}
