import { redirect } from "next/navigation";
import { getMe } from "@/lib/queue/actions-db";
import { getReportDetail, getTeam, getDepartments, type TimelineEvent } from "@/lib/queue/reports";
import { CLOSE_REASONS, isCloseReason } from "@/lib/queue/close-reasons";
import { Badge } from "@/components/ui/badge";
import { CardActions } from "@/components/staff/card-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Report — ProResponse" };

/**
 * One report's full history.
 *
 * This is just report_events rendered, which is close to free to build and is
 * what settles every "nobody told us about that" conversation — the club can
 * show exactly who was notified, when, and what happened next.
 */
const EVENT_LABEL: Record<string, string> = {
  created: "Reported by a member",
  triaged: "Categorised",
  routed: "Sent to the team",
  notified: "Team notified",
  acknowledged: "Picked up",
  scheduled: "Scheduled",
  escalated: "Escalated",
  unstaffed: "Nobody on duty — escalated to management",
  reassigned: "Handed over",
  note: "Note",
  resolved: "Resolved",
  verified: "Verified",
  reopened: "Reopened",
};

/**
 * Three actions share event types with others and are told apart by payload:
 * start_report and close_no_action both write 'note', and a re-route to a
 * department is 'reassigned' like a hand-over to a person. Without this every
 * one of them reads "Note", and a history that says "Note · Note · Note" has
 * settled nothing.
 */
function eventLabel(e: TimelineEvent): string {
  const p = e.payload ?? {};
  if (e.type === "note") {
    if (typeof p.closed_no_action === "string") {
      const reason = p.closed_no_action;
      return `Closed without action — ${isCloseReason(reason) ? CLOSE_REASONS[reason] : reason}`;
    }
    if (p.note === "started work") return "Work started";
  }
  if (e.type === "reassigned" && p.kind !== "person") return "Sent to another team";
  return EVENT_LABEL[e.type] ?? e.type;
}

const time = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });

export default async function ReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const me = await getMe();
  if (!me) redirect("/login");

  const r = await getReportDetail(id);

  // Still somebody's job. The same actions as the queue card sit under the
  // report here, so a person who arrived from a notification link does not
  // have to go back to the queue to act on it.
  const open = r ? !["resolved", "closed_no_action"].includes(r.status) : false;
  const [team, departments] = open
    ? await Promise.all([getTeam(), getDepartments()])
    : [[], []];

  // A report that is gone is not a broken address. It can disappear from under
  // somebody legitimately — resolved and cleared by a colleague, or removed —
  // and a queue open on a phone can be a minute out of date. A raw 404 tells a
  // groundskeeper the app is broken; this tells them what happened and puts
  // them one tap from the queue.
  if (!r) {
    return (
      <main className="app-ground flex min-h-dvh items-center justify-center px-6 py-12">
        <div className="w-full max-w-[25rem] rounded-card border border-line bg-surface-raised px-7 py-9 shadow-pop">
          <p className="text-[11px] uppercase tracking-[0.2em] text-ink-muted">
            {me.course_name}
          </p>
          <h1 className="mt-4 font-display text-[1.9rem] leading-tight tracking-tight">
            This report is no longer here
          </h1>
          <div className="mt-4 h-0.5 w-8 rounded-pill bg-accent" />
          <p className="mt-5 text-[15px] leading-relaxed text-ink-secondary">
            It was probably closed by someone else while you had this open. If
            you were part-way through something, check the queue — it may
            already be handled.
          </p>
          <a
            href="/app"
            className="mt-7 inline-block rounded-control bg-accent-strong px-4 py-3.5 text-[15px] font-medium text-ink-on-accent shadow-card"
          >
            Back to open reports
          </a>
        </div>
      </main>
    );
  }

  return (
    <main>
      <div className="mx-auto max-w-[34rem] px-5 pt-6 pb-24">
        <a
          href="/app"
          className="inline-block text-[13px] text-ink-muted underline-offset-4 hover:text-ink-secondary hover:underline"
        >
          ← Open reports
        </a>

        <div className="mt-4 rounded-card border border-line bg-surface-raised px-6 py-6 shadow-card">
          <h1 className="font-display text-[1.85rem] leading-none tracking-tight">
            {r.hole_number ? `Hole ${r.hole_number}` : r.location_name}
          </h1>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Badge variant="department">{r.department_name ?? "Unrouted"}</Badge>
            <Badge variant="status">{time(r.created_at)}</Badge>
          </div>
          <p className="mt-5 text-[16px] leading-relaxed text-ink">{r.body}</p>
          {open && (
            <CardActions
              reportId={r.id}
              claimed={!!r.claimed_by}
              status={r.status}
              departmentKey={r.department_key}
              team={team}
              departments={departments}
              meId={me.profile_id}
            />
          )}
        </div>

        {r.resolution_note && (
          <div className="mt-4 rounded-card border border-line bg-surface-raised px-6 py-5 shadow-card">
            <Badge variant="low" size="sm">Internal note</Badge>
            <p className="mt-3 text-[15px] leading-relaxed text-ink">
              {r.resolution_note}
            </p>
            {r.resolved_by_name && (
              <p className="mt-3 text-[12px] text-ink-muted">{r.resolved_by_name}</p>
            )}
          </div>
        )}

        <div className="mt-4 rounded-card border border-line bg-surface-raised px-6 py-6 shadow-card">
          <p className="text-[11px] uppercase tracking-[0.14em] text-ink-subtle">History</p>
          <ol className="mt-5 space-y-0">
            {r.events.map((e, i) => (
              <li key={i} className="relative flex gap-4 pb-6 last:pb-0">
                {/* Connector line, stopping at the last entry. */}
                {i < r.events.length - 1 && (
                  <span className="absolute left-[5px] top-3.5 h-full w-px bg-line-strong" />
                )}
                <span className="relative mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-accent ring-4 ring-surface-raised" />
                <div className="min-w-0">
                  <p className="text-[14px] leading-tight">
                    {eventLabel(e)}
                    {e.actor_name && (
                      <span className="text-ink-muted"> · {e.actor_name}</span>
                    )}
                  </p>
                  <p className="mt-1 text-[12px] text-ink-muted">{time(e.created_at)}</p>
                  {e.type === "routed" && e.payload?.recipients != null && (
                    <p className="mt-0.5 text-[12px] text-ink-muted">
                      {String(e.payload.recipients)} notified
                      {e.payload.reason === "unstaffed_all_leadership"
                        ? " — nobody was on duty"
                        : ""}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </main>
  );
}
