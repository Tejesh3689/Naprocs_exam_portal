import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Lets the dev server serve HMR/dev assets when accessed through an ngrok
  // tunnel (needed for testing the real webcam flow from another laptop) --
  // dev-only; production builds don't have this cross-origin restriction.
  allowedDevOrigins: ["avid-lake-snowbird.ngrok-free.dev"],

  // Stops Next.js advertising itself via `x-powered-by: Next.js` on every
  // response -- cheap stack-fingerprinting reduction, no behavior change.
  poweredByHeader: false,

  // Security headers found genuinely missing entirely (external security
  // review, 2026-09-14, pre-exam hardening pass). Deliberately NOT including
  // a Content-Security-Policy or Strict-Transport-Security here yet -- both
  // need careful, tested allowlisting (Monaco/TipTap/MediaPipe/fonts for CSP;
  // HSTS is a long-lived browser-cached commitment) that shouldn't be rushed
  // the night before a live ~260-candidate exam. These four are additive and
  // safe: they only ever restrict how OTHER origins may treat responses from
  // this app, never how this app renders its own content.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Prevents this app (including the proctored exam UI) from being
          // framed by any origin -- clickjacking mitigation. Purely a
          // response-header restriction on being framed by others; has no
          // effect on this app's own <iframe> (e.g. the admin resume viewer)
          // embedding external content.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
