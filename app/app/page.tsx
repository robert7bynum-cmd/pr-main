import { redirect } from "next/navigation";
import { getQueue, getDepartmentCounts, getTeam, getDepartments } from "@/lib/queue/reports";
import { getMe } from "@/lib/queue/actions-db";
import { Badge } from "@/components/ui/badge";
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

  // A shared counter login lands on the board built for it: big type, sound
  // on by default, screen kept awake. Only this route redirects — a station
  // can still open a report or the account page. Done here rather than in the
  // layout because a layout cannot see which path it is rendering.
  if (me.account_kind === "station") redirect("/app/station");

  const view: "mine" | "all" = scope === "all" ? "all" : "mine";

  const [rows, departments, team, allDepartments] = await Promise.all([
    getQueue(dept, view),
    getDepartmentCounts(view),
    // Once per page, not once per card.
    getTeam(),
    getDepartments(),
  ]);

  // An empty personal queue and a broken app look identical, and that is not a
  // cosmetic problem: someone filed a report from a placard, watched the queue
  // stay empty, and reasonably concluded nothing worked. It was working — the
  // report had routed to a department they are not in.
  //
  // So when there is nothing for you, find out whether there is nothing at all,
  // and say which. Only in that case: on a busy queue this second read is
  // pointless, and the whole reason my_queue exists is that busy is normal.
  const elsewhere =
    rows.length === 0 && view === "mine" ? (await getQueue(undefined, "all")).length : 0;

  const overdue = rows.filter((r) => r.ack_overdue).length;

  // Newest by filing time, not queue position: the queue is ordered by urgency,
  // so its first card is usually not the most recent arrival.
  const newest = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

  return (
    <main>
      <div className="mx-auto max-w-[34rem] px-5 pb-28">
        <header className="pt-9 pb-5">
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="font-display text-[1.6rem] tracking-tight">Open reports</h1>
            <div className="flex flex-col items-end gap-1.5">
              {/* Staff spot most problems first. One tap from the queue to
                  filing, for everyone signed in, not just management. */}
              <Badge
                variant="default"
                size="lg"
                className="h-9 shrink-0 px-4 font-medium shadow-card"
                render={<a href="/app/file" />}
              >
                Report an issue
              </Badge>
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

          {/* Offered to everyone, not just management. The default stays
              scoped — a groundskeeper should not have to read pro shop items to
              find their own — but being unable to look at all is what turned
              "nothing routed to me" into "this app is broken". staff_queue is
              already readable by any signed-in staff member and RLS still
              confines it to their own club, so this shows nothing that was not
              already theirs to see. */}
          <div className="mt-5 flex gap-2">
            <FilterChip href="/app" label="My departments" count={null} active={view === "mine"} />
            <FilterChip href="/app?scope=all" label="Whole course" count={null} active={view === "all"} />
          </div>

          <nav className="mt-2.5 -mx-5 flex gap-2 overflow-x-auto px-5 pb-1">
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

        <div className="mb-4">
          <PushSetup />
        </div>

        {rows.length === 0 ? (
          <div className="rounded-card border border-line bg-surface-raised px-6 py-12 text-center shadow-card">
            <p className="text-[15px] leading-relaxed text-ink-muted">
              {elsewhere > 0
                ? "Nothing for your team right now."
                : "Nothing open here. The course is quiet."}
            </p>
            {elsewhere > 0 && (
              <p className="mt-3 text-[13px] leading-relaxed text-ink-subtle">
                {elsewhere} open {elsewhere === 1 ? "report" : "reports"} elsewhere on the course.{" "}
                <a href="/app?scope=all" className="underline underline-offset-2">
                  See the whole course
                </a>
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {rows.map((row) => (
              <QueueCard
                key={row.id} row={row} team={team} departments={allDepartments}
                meId={me.profile_id} meKind={me.account_kind}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

/**
 * A filter is a badge you can tap, so it is literally the Badge — with the
 * height pushed up to a thumb-sized target, because these are pressed with a
 * work glove on.
 */
function FilterChip({
  href, label, count, active,
}: { href: string; label: string; count: number | null; active: boolean }) {
  return (
    <Badge
      variant={active ? "default" : "neutral"}
      size="lg"
      className={`h-9 shrink-0 px-4 font-medium ${active ? "shadow-card" : "bg-surface-raised"}`}
      render={<a href={href} />}
    >
      {label}
      {count !== null && <span className="tabular-nums opacity-70">{count}</span>}
    </Badge>
  );
}
