import "server-only";

import { headers } from "next/headers";

/**
 * Where an emailed link should bring someone back to.
 *
 * The origin the caller is on right now, which is the right answer for every
 * emailed link: a manager inviting someone is on the club's real site when
 * they press the button, and so is a locked-out staff member asking for a way
 * back in. The link only works if this origin is on the Supabase project's
 * redirect allow-list; otherwise Supabase quietly sends the person to its
 * configured Site URL instead, which on a fresh project is localhost — the
 * reason the first invitations ever sent from this app would have gone
 * nowhere.
 *
 * One implementation. It was private to app/actions/staff.ts until the login
 * page needed it too, and two copies of "where does the link land" would drift
 * exactly when a domain changes.
 */
export async function callbackUrl(next: string): Promise<string> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("host") ?? "localhost:3000";
  return `${proto}://${host}/auth/callback?next=${encodeURIComponent(next)}`;
}
