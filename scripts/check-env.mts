/**
 * Build preflight. Runs before `next build`, everywhere, including on Vercel.
 *
 * Preview deployments made this necessary. A missing NEXT_PUBLIC_ variable is
 * not a build error — Next inlines `undefined` into the client bundle and the
 * deployment goes green — so the first sign of a mis-configured environment
 * would be a blank screen on someone's phone. A deploy that cannot work should
 * fail at the point it is built, not the point it is opened.
 *
 * It also refuses the two mistakes that would be expensive rather than
 * annoying: shipping the service-role key to the browser, and leaving the demo
 * sign-in buttons enabled on production.
 *
 * Values are never printed. Everything here checks length and prefix.
 */
import { readFileSync } from "node:fs";

// `next build` loads .env.local itself, but this runs first and does not
// inherit that. Parsed rather than shelled out to so the check behaves the
// same locally and on Vercel, where the file does not exist.
function loadLocalEnv() {
  let raw: string;
  try {
    raw = readFileSync(".env.local", "utf8");
  } catch {
    return; // Vercel, CI — the environment is already populated.
  }
  for (const line of raw.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (process.env[key] === undefined) {
      process.env[key] = value.trim().replace(/^["']|["']$/g, "");
    }
  }
}
loadLocalEnv();

const env = process.env.VERCEL_ENV ?? "development";
const problems: string[] = [];
const warnings: string[] = [];

function present(name: string): string | null {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : null;
}

// --- Required to serve a single request ------------------------------------

const REQUIRED = [
  ["NEXT_PUBLIC_SUPABASE_URL", "the app has no database to talk to"],
  ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "every signed-in page fails to load"],
  ["SUPABASE_SERVICE_ROLE_KEY", "triage, routing and staff actions all throw"],
] as const;

for (const [name, consequence] of REQUIRED) {
  if (!present(name)) problems.push(`${name} is not set — ${consequence}.`);
}

// Web push is the whole notification path. Missing on a preview is survivable
// and worth knowing about; missing in production means nobody gets paged.
if (!present("NEXT_PUBLIC_VAPID_PUBLIC_KEY")) {
  const msg = "NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set — staff cannot subscribe to push.";
  if (env === "production") problems.push(msg);
  else warnings.push(msg);
}

// --- Refusals ---------------------------------------------------------------

/**
 * A service-role key must never reach the browser. Supabase issues both the
 * new `sb_secret_…` format and legacy JWTs whose payload carries the role, so
 * both are checked. This exact paste — a secret key onto the NEXT_PUBLIC_ line
 * — has happened here once already.
 */
function looksSecret(value: string): boolean {
  if (value.startsWith("sb_secret_")) return true;
  if (value.startsWith("eyJ")) {
    try {
      const payload = JSON.parse(Buffer.from(value.split(".")[1], "base64").toString());
      return payload.role === "service_role";
    } catch {
      return false;
    }
  }
  return false;
}

for (const [name, value] of Object.entries(process.env)) {
  if (!name.startsWith("NEXT_PUBLIC_") || !value) continue;
  if (looksSecret(value)) {
    problems.push(
      `${name} holds what looks like a service-role key. NEXT_PUBLIC_ variables ` +
        `are inlined into the client bundle — this would hand every visitor full ` +
        `database access. Refusing to build.`,
    );
  }
}

const anon = present("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const service = present("SUPABASE_SERVICE_ROLE_KEY");
if (anon && service && anon === service) {
  problems.push(
    "SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_ANON_KEY are the same value — " +
      "one of them is wrong, and either way the server has the privileges it should not " +
      "or the browser has privileges it must not.",
  );
}

/**
 * The demo personas are one click into a supervisor's queue with no password.
 * Correct on a preview, catastrophic on a real club's production deployment.
 */
if (present("DEMO_SIGNIN") === "true" && env === "production") {
  problems.push(
    "DEMO_SIGNIN=true in the production environment. The one-click demo personas " +
      "would let anyone who reaches the login page sign in as staff. Set it on " +
      "Preview only.",
  );
}

const url = present("NEXT_PUBLIC_SUPABASE_URL");
if (url && !/^https:\/\/[^/]+\.supabase\.(co|in)$/.test(url)) {
  warnings.push(`NEXT_PUBLIC_SUPABASE_URL is not the usual https://<ref>.supabase.co shape.`);
}

// --- Report -----------------------------------------------------------------

const label =
  env === "development" ? "local" : `${env}${process.env.VERCEL_GIT_COMMIT_REF ? ` (${process.env.VERCEL_GIT_COMMIT_REF})` : ""}`;

for (const w of warnings) console.warn(`  warn  ${w}`);

if (problems.length > 0) {
  console.error(`\n  Environment check failed for ${label}:\n`);
  for (const p of problems) console.error(`  ✗  ${p}`);
  console.error(
    `\n  Set these under Vercel → Project → Settings → Environment Variables,\n` +
      `  scoped to the environment named above. See docs/deploying.md.\n`,
  );
  process.exit(1);
}

console.log(`  env   ${label}: ${REQUIRED.length} required variables present${warnings.length ? `, ${warnings.length} warning(s)` : ""}`);
