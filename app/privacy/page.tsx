/**
 * The privacy notice a member can read from the placard form.
 *
 * One page for every club, written plainly: what the form collects, why, who
 * sees it, how long it is kept, and how to have it removed. The retention
 * period is the club's own setting (default 90 days; purge_expired in
 * 20260906170000 is what enforces it), so the number here is described as the
 * club's, not stated as a promise this page cannot keep on its own.
 */
export const metadata = { title: "How we use this — ProResponse" };

const h = "mt-8 text-[11px] uppercase tracking-[0.14em] text-ink-subtle";
const p = "mt-2 text-[15px] leading-relaxed text-ink-secondary";

export default function PrivacyPage() {
  return (
    <main className="app-ground flex min-h-dvh items-start justify-center px-6 py-12">
      <div className="w-full max-w-[32rem] rounded-card border border-line bg-surface-raised px-7 py-9 shadow-pop">
        <p className="text-[11px] uppercase tracking-[0.2em] text-ink-muted">ProResponse</p>
        <h1 className="mt-4 font-display text-[1.9rem] leading-tight tracking-tight">
          How we use what you tell us
        </h1>
        <div className="mt-4 h-0.5 w-8 rounded-pill bg-accent" />

        <p className={`${p} mt-5`}>
          When you scan a sign on the course and send a report, it goes to the
          club&rsquo;s own team. No app, no account, and nothing about you is
          needed for the report to be dealt with.
        </p>

        <h2 className={h}>What the form collects</h2>
        <p className={p}>
          What you wrote, the hole or place you scanned, the time, and a photo
          if you added one. Your name, mobile number, email and member number are
          optional, and the form works without them.
        </p>

        <h2 className={h}>Why</h2>
        <p className={p}>
          So the right team is told, and so someone can ask you a question about
          the report if they need to. That is the only reason your contact
          details are asked for.
        </p>

        <h2 className={h}>Who sees it</h2>
        <p className={p}>
          Staff at the club you reported to. Never other members, and never
          another club. ProResponse hosts the system for the club and does not
          use your details for anything of its own.
        </p>

        <h2 className={h}>How long it is kept</h2>
        <p className={p}>
          Your name, number and email are removed automatically after the
          club&rsquo;s retention period &mdash; 90 days unless the club has set
          a different one. The report itself is kept without them, so the club
          can see which holes and problems come up over time, and the record
          shows that the details were removed and when.
        </p>

        <h2 className={h}>Selling or sharing</h2>
        <p className={p}>
          Your details are not sold, and they are not shared with anyone outside
          the club or the services that run this system for it.
        </p>

        <h2 className={h}>Having it removed sooner</h2>
        <p className={p}>
          Ask the club. Your report was sent to their team, and they hold your
          details; a request to remove them before the retention period ends
          goes to the club, not to ProResponse.
        </p>

        <p className="mt-8 text-[12px] leading-relaxed text-ink-subtle">
          This notice applies to every club using ProResponse.
        </p>
      </div>
    </main>
  );
}
