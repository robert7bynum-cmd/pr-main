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
 * Is this an address it would be a mistake to commit to a printed sign?
 *
 * A localhost code is dead the moment it leaves the laptop. A preview code dies
 * when the branch does. Both are worth refusing to print rather than warning
 * about, because the cost of the mistake is replacing signs on a golf course.
 */
export function isUnprintableOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|$|\/)/i.test(origin)
    || /-git-[^.]+\.vercel\.app/i.test(origin);
}
