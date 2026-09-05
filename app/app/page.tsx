import { redirect } from "next/navigation";
import { getQueue, getDepartmentCounts } from "@/lib/queue/reports";
import { getMe } from "@/lib/queue/actions-db";
import { QueueCard } from "@/components/staff/queue-card";
import { QueueLive } from "@/components/staff/queue-live";
import { PushSetup } from "@/components/staff/push-setup";

export const dynamic = "force-dynamic";
export const metadata = { title: "Queue — ProResponse" };

export default async function StaffQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ dept?: string; station?: string; scope?: string }>;
}) {
  const { dept, station, scope } = await searchParams;

  // No profile means either not signed in, or signed in with an address the
  // club never invited. Both land on the sign-in page; neither is told which,
  // so an outsider cannot probe for whether a club exists here.
  const me = await getMe();
  if (!me) redirect("/login");

  // Management can widen to the whole course; for everyone else the two views
  // return the same rows, so the toggle is only shown where it means something.
  const isManagement = ["manager", "owner"].includes(me.role);
  const view: "mine" | "all" = scope === "all" ? "all" : "mine";

  const [rows, departments] = await Promise.all([
    getQueue(dept, view),
    getDepartmentCounts(view),
  ]);

  const overdue = rows.filter((r) => r.ack_overdue).length;

  // Newest by filing time, not queue position: the queue is ordered by urgency,
  // so its first card is usually not the most recent arrival.
  const newest = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

  return (
    <main>
      <div className="mx-auto max-w-[34rem] px-4 pb-24">
        <header className="pt-8 pb-4">
          <div className="flex items-baseline justify-between">
            <h1 className="text-[1.35rem] font-semibold tracking-tight">Open reports</h1>
            <div className="flex flex-col items-end gap-1">
              <span className="text-[13px] tabular-nums text-ink-muted">
                {rows.length} open{overdue > 0 ? ` · ${overdue} overdue` : ""}
              </span>
              <QueueLive
                courseId={me.course_id}
                station={station === "1"}
                newestId={newest?.id ?? null}
                newestBody={newest?.body ?? null}
              />
            </div>
          </div>

          {/* Department filter. Staff see their own departments in the real
              build; showing all of them is a demo affordance. */}
          {isManagement && (
            <div className="mt-3 flex gap-2">
              <FilterChip href="/app" label="My departments" count={null} active={view === "mine"} />
              <FilterChip href="/app?scope=all" label="Whole course" count={null} active={view === "all"} />
            </div>
          )}

          <nav className="mt-3 -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
            <FilterChip
              href={view === "all" ? "/app?scope=all" : "/app"}
              label="All" count={null} active={!dept}
            />
            {departments.map((d) => (
              <FilterChip
                key={d.key}
                href={`/app?dept=${d.key}${view === "all" ? "&scope=all" : ""}`}
                label={d.name}
                count={d.open}
                active={dept === d.key}
              />
            ))}
          </nav>
        </header>

        <div className="mb-3">
          <PushSetup />
        </div>

        {rows.length === 0 ? (
          <p className="rounded-2xl border border-line bg-surface-raised px-5 py-10 text-center text-[15px] text-ink-muted">
            {view === "mine" && !isManagement
              ? "Nothing for your team right now."
              : "Nothing open here. The course is quiet."}
          </p>
        ) : (
          <div className="space-y-2.5">
            {rows.map((row) => (
              <QueueCard key={row.id} row={row} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function FilterChip({
  href, label, count, active,
}: { href: string; label: string; count: number | null; active: boolean }) {
  return (
    <a
      href={href}
      className={`shrink-0 rounded-full px-3.5 py-2 text-[13px] font-medium transition ${
        active ? "bg-ink text-surface" : "bg-surface-raised text-ink-secondary border border-line"
      }`}
    >
      {label}
      {count !== null && <span className="ml-1.5 tabular-nums opacity-60">{count}</span>}
    </a>
  );
}
