import type { ClubReadiness } from "@/lib/queue/onboarding";

/**
 * The few things a brand-new club still has to do.
 *
 * Shown only while something is genuinely outstanding, and only to the people
 * who can act on it. Every line is answered from live data — there is no
 * dismiss, because a club that dismissed this would be a club whose members
 * scan a sign and reach nobody.
 *
 * Printing is a link rather than a checkbox: nothing records that a sheet was
 * printed, so a box for it could never tick.
 */
export function FirstRunChecklist({
  readiness,
  courseName,
}: {
  readiness: ClubReadiness;
  courseName: string;
}) {
  if (readiness.ready) return null;

  const steps = [
    {
      done: readiness.hasTeam,
      title: "Invite your team",
      detail: readiness.hasTeam
        ? `${readiness.staffCount} people can see the queue.`
        : "You are the only person here, so every report comes to you.",
      href: "/app/staff",
      action: "Add staff",
    },
    {
      done: readiness.canBeAlerted,
      title: "Turn on alerts",
      detail: readiness.canBeAlerted
        ? `${readiness.reachableCount} of ${readiness.staffCount} can be reached.`
        : "Nobody here can receive a notification yet, so reports arrive unseen.",
      href: "/app/account",
      action: "Turn on",
    },
    {
      done: readiness.hasSignAddress,
      title: "Set the address for your signs",
      detail: readiness.hasSignAddress
        ? "Placards will print with your own address."
        : "A placard's code is printed permanently, so this has to be right before any sign is made.",
      href: "/app/settings",
      action: "Set it",
    },
  ];

  const remaining = steps.filter((s) => !s.done).length;

  return (
    <section className="mb-6 rounded-card border border-accent-border bg-accent-surface px-5 py-5">
      <h2 className="font-display text-[17px] tracking-tight">
        {courseName} is nearly ready
      </h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
        {readiness.locationCount} places on the course already have a code a
        member can scan. {remaining === 1 ? "One thing" : `${remaining} things`}{" "}
        left before those codes reach anyone.
      </p>

      <ol className="mt-4 space-y-2.5">
        {steps.map((s) => (
          <li key={s.title} className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${
                s.done
                  ? "border-accent-strong bg-accent-strong text-ink-on-accent"
                  : "border-line-strong text-ink-subtle"
              }`}
            >
              {s.done ? "✓" : ""}
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block text-[14px] font-medium ${s.done ? "text-ink-muted line-through" : "text-ink"}`}>
                {s.title}
              </span>
              <span className="block text-[13px] leading-relaxed text-ink-secondary">
                {s.detail}
              </span>
            </span>
            {!s.done && (
              <a
                href={s.href}
                className="shrink-0 rounded-control border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink-secondary hover:border-line-strong"
              >
                {s.action}
              </a>
            )}
          </li>
        ))}
      </ol>

      <p className="mt-4 text-[13px] text-ink-secondary">
        Once the address is set,{" "}
        <a href="/app/placards" className="underline underline-offset-4 hover:text-ink">
          print your placards
        </a>{" "}
        and put them out on the course.
      </p>
    </section>
  );
}
