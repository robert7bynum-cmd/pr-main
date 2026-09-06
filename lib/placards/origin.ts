/**
 * Deciding what address goes inside a printed QR code.
 *
 * Deliberately its own module with no server-only import and no database
 * access. This is the one output of the system that becomes a physical object
 * bolted to a tee box, so the decision is worth being able to test on its own —
 * and it could not be while it lived beside the query that fetches placards.
 */
/**
 * Where a placard's QR code should point.
 *
 * This used to be the origin of whatever request rendered the page, on the
 * reasoning that guessing is how you print against the wrong host. The
 * reasoning was right and the conclusion was backwards: reading the request
 * host IS the guess. Open the page on a laptop and every code encodes
 * localhost:3000 — which is what happened, and a warning above the sheet did
 * not stop it, because a warning is not a control when the output is a physical
 * object.
 *
 * Nor does production save you. Vercel's own URL for this deployment is
 * pr-main-git-main-<scope>.vercel.app, not the short alias a club actually
 * uses, so printing from the right machine still bakes in the wrong address —
 * and a custom domain later would break every sign.
 *
 * So the address is a stored decision. `settings.public_url` is what the club
 * says its address is; everything else is a fallback for a database that has
 * not been told yet.
 */
export function resolvePlacardOrigin(
  settings: { public_url?: string | null } | null | undefined,
  requestOrigin: string,
): { origin: string; source: "configured" | "deployment" | "request" } {
  const stored = settings?.public_url?.trim().replace(/\/+$/, "");
  if (stored) return { origin: stored, source: "configured" };

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return { origin: `https://${vercel}`, source: "deployment" };

  return { origin: requestOrigin, source: "request" };
}

/**
 * The two shapes of address that must never reach a sign, as regex source.
 *
 * Exported as strings rather than RegExp objects because the same rule runs in
 * the database: update_course_settings refuses to store one of these, so a
 * manager cannot type localhost into the settings screen and have the placard
 * page dutifully render it. Two copies of one rule drift, so the migration
 * carries these two strings verbatim and scripts/test-placard-origin.mts
 * asserts on the migration text that they are still byte-for-byte the same.
 *
 * HOST is matched against the address with its scheme removed — both sides
 * strip `https?://` first — so the pattern itself contains nothing that needs
 * escaping differently in a JavaScript regex and a Postgres string literal.
 */
export const UNPRINTABLE_HOST_PATTERN = String.raw`^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|$|/)`;
export const UNPRINTABLE_PREVIEW_PATTERN = String.raw`-git-[^.]+\.vercel\.app`;

const SCHEME = /^https?:\/\//i;
const UNPRINTABLE_HOST = new RegExp(UNPRINTABLE_HOST_PATTERN, "i");
const UNPRINTABLE_PREVIEW = new RegExp(UNPRINTABLE_PREVIEW_PATTERN, "i");

/**
 * Is this an address it would be a mistake to commit to a printed sign?
 *
 * A localhost code is dead the moment it leaves the laptop. A preview code dies
 * when the branch does. Both are worth refusing to print rather than warning
 * about, because the cost of the mistake is replacing signs on a golf course.
 */
export function isUnprintableOrigin(origin: string): boolean {
  return UNPRINTABLE_HOST.test(origin.replace(SCHEME, "")) || UNPRINTABLE_PREVIEW.test(origin);
}
