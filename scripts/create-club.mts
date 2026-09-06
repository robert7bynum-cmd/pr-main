/**
 * Create a club. Until this existed the seed was the only thing that had ever
 * made a course, and a second club meant hand-written SQL against production.
 *
 *   npm run club:create -- <slug> "<Name>" <IANA tz> <owner email> "<Owner name>"
 *   npm run club:create -- pine-valley "Pine Valley Golf Club" America/New_York gm@pinevalley.com "Jane Doe"
 *
 * create_club (20260906170000) builds the club row, the seven departments and
 * ten routing rules from docs/taxonomy.md, and a pending owner. It is granted to
 * the service role only, so this runs with SUPABASE_SERVICE_ROLE_KEY from
 * .env.local and nowhere else. The owner is then invited by email; their first
 * sign-in claims the pending profile.
 *
 * If the mailer refuses (the built-in one caps invitations per hour), the club
 * and the pending owner still exist and nothing needs undoing. Running the same
 * command again finds the club by slug, sees the owner still unclaimed, and
 * only re-sends the email. (`npm run invite` is not the retry: it attaches the
 * person to the FIRST club in the database, which is not this one.)
 *
 * Prints ids and next steps. Never prints a key or a link that signs in.
 */
import { createClient } from "@supabase/supabase-js";

const [slug, name, timezone, ownerEmail, ownerName] = process.argv.slice(2);
if (!slug || !name || !timezone || !ownerEmail || !ownerName) {
  console.error('usage: npm run club:create -- <slug> "<Name>" <IANA tz> <owner email> "<Owner name>"');
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (.env.local)");
  process.exit(1);
}

const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

let courseId: string;
const { data, error } = await admin.rpc("create_club", {
  p_slug: slug,
  p_name: name,
  p_timezone: timezone,
  p_owner_email: ownerEmail,
  p_owner_name: ownerName,
});

if (!error && data) {
  courseId = String(data);
  console.log(`created ${name} (${slug})`);
  console.log(`  course id: ${courseId}`);
  console.log(`  7 departments and 10 routing rules from docs/taxonomy.md`);
  console.log(`  pending owner: ${ownerName} <${ownerEmail}>`);
} else if (error && /already exists/.test(error.message)) {
  // A re-run after a failed email. Only proceed when this is the same owner,
  // still waiting: anything else is a different request wearing an old slug.
  const { data: rows, error: lookup } = await admin
    .from("pending_profiles")
    .select("course_id, claimed_at, courses!inner(slug)")
    .eq("courses.slug", slug)
    .ilike("email", ownerEmail)
    .eq("role", "owner");
  const pending = (rows as { course_id: string; claimed_at: string | null }[] | null)?.[0];
  if (lookup || !pending) {
    console.error(`${slug} already exists and ${ownerEmail} is not its pending owner: ${lookup?.message ?? "nothing to retry"}`);
    process.exit(1);
  }
  if (pending.claimed_at) {
    console.log(`${slug} already exists and ${ownerEmail} has already signed in. Nothing to do.`);
    process.exit(0);
  }
  courseId = pending.course_id;
  console.log(`${slug} already exists (course id ${courseId}); the owner has not signed in yet.`);
  console.log(`  re-sending the invitation only.`);
} else {
  console.error(`could not create ${slug}: ${error?.message ?? "no id returned"}`);
  process.exit(1);
}

// The invitation. The callback page keeps `next` on this site, and
// /account/password is where a new account chooses its first password.
const appUrl = (process.env.PUBLIC_APP_URL ?? "https://pr-main-dun.vercel.app").replace(/\/+$/, "");
const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(ownerEmail, {
  data: { must_change_password: true },
  redirectTo: `${appUrl}/auth/callback?next=/account/password`,
});

if (inviteError) {
  console.log(`\ninvitation email NOT sent: ${inviteError.message}`);
  console.log(`  the club and the pending owner profile exist; nothing needs to be undone.`);
  console.log(`  when the mailer will take it again, run this same command again and only the email is retried.`);
  process.exit(2);
}

console.log(`\ninvitation sent to ${ownerEmail}`);
console.log(`\nnext steps`);
console.log(`  1. the owner opens the email, sets a password, and lands in the club`);
console.log(`  2. in /app/settings they set the placard address, quiet hours and retention`);
console.log(`  3. in /app/locations they add holes and facilities, then print from /app/placards`);
console.log(`  4. in /app/staff they invite the rest of the team`);
