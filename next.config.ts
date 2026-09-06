import type { NextConfig } from "next";

/**
 * Response headers every route carries.
 *
 * None of these existed before, so a page could be framed by another site,
 * a browser could sniff a response into a script, and a link out of the app
 * carried the full report URL as its referrer. Each header below closes one
 * of those; none of them can break a page that was working.
 *
 * No Content-Security-Policy, deliberately. Next inlines styles and scripts,
 * the service worker registers push, and the queue holds a Supabase realtime
 * websocket open — a CSP that gets any one of those wrong breaks push or
 * realtime *silently*: the page renders, the console fills, and nobody is
 * paged. A CSP is worth having, but it is a measured change (report-only
 * first, read the violations, then enforce), not a line added beside these.
 */
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // PGlite ships its extensions as .tar.gz assets loaded from disk at runtime.
  // Bundling rewrites those paths and the extension can no longer be found, so
  // it has to stay external. Dev-only dependency; see lib/dev-db.ts.
  serverExternalPackages: ["@electric-sql/pglite"],
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
