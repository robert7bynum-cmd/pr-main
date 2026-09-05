import { redirect } from "next/navigation";
import { getMe } from "@/lib/queue/actions-db";
import { PushSetup } from "@/components/staff/push-setup";

/**
 * Asked once, during setup, rather than from a card in the queue.
 *
 * A browser prompts for notification permission once per site and remembers the
 * answer; someone who waves it away mid-shift has to go into browser settings
 * to undo that. So the ask belongs at the moment a person is being set up and
 * paying attention, with a sentence explaining what they are agreeing to —
 * not competing with a fairway full of work.
 *
 * Consent cannot be skipped, and it is not ours to skip: there is no API that
 * subscribes a device without the person agreeing, in any browser. What we can
 * decide is whether we ask well.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Alerts — ProResponse" };

export default async function NotificationsSetupPage() {
  const me = await getMe();
  if (!me) redirect("/login");

  return (
    <main className="app-ground flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-[25rem] rounded-card border border-line bg-surface-raised px-7 py-9 shadow-pop">
        <p className="text-[11px] uppercase tracking-[0.2em] text-ink-muted">
          {me.course_name}
        </p>
        <PushSetup variant="onboarding" />
      </div>
    </main>
  );
}
