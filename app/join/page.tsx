import { createAdminClient } from "@/lib/supabase/admin";
import { JoinButton } from "@/components/staff/join-button";

/**
 * Where an invitation link lands.
 *
 * Rendering this page spends nothing. That is the entire point: a link sent by
 * text or email is fetched before a human ever taps it — iMessage building a
 * preview, Outlook Safe Links, whatever scanner sits in front of a club's
 * mailbox — and an invitation consumed on page load is one that is dead by the
 * time it is opened. Nothing happens until somebody presses the button.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Join your club — ProResponse" };

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const { t } = await searchParams;

  let name: string | null = null;
  let club: string | null = null;
  let valid = false;

  if (t) {
    const { data } = await createAdminClient().rpc("peek_staff_invite", { p_token: t });
    const row = (data as { full_name: string; course_name: string; valid: boolean }[] | null)?.[0];
    if (row) { name = row.full_name; club = row.course_name; valid = row.valid; }
  }

  return (
    <main className="app-ground flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-[25rem] rounded-card border border-line bg-surface-raised px-7 py-9 shadow-pop">
        <p className="text-[11px] uppercase tracking-[0.2em] text-ink-muted">
          {club ?? "ProResponse"}
        </p>
        <h1 className="mt-4 font-display text-[1.9rem] leading-tight tracking-tight">
          {valid ? (name ? `Hello, ${name}` : "Set up your account") : "This invitation has expired"}
        </h1>
        <div className="mt-4 h-0.5 w-8 rounded-pill bg-accent" />

        {valid ? (
          <>
            <p className="mt-5 text-[15px] leading-relaxed text-ink-secondary">
              {club} has set you up on ProResponse. Choose a password and you are
              in — it takes a moment.
            </p>
            <div className="mt-7">
              <JoinButton token={t!} />
            </div>
          </>
        ) : (
          <>
            <p className="mt-5 text-[15px] leading-relaxed text-ink-secondary">
              {t
                ? "It has already been used, or it is more than seven days old. Ask your manager to send another — it only takes them a moment."
                : "That link is missing its invitation code. Ask your manager to send it again."}
            </p>
            <a
              href="/login"
              className="mt-7 inline-block rounded-control border border-line bg-surface px-4 py-3 text-[14px] text-ink-secondary"
            >
              Go to sign in
            </a>
          </>
        )}
      </div>
    </main>
  );
}
