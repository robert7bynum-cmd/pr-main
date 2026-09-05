import type { QueueRow } from "@/lib/queue/reports";
import { Badge } from "@/components/ui/badge";
import { CardActions } from "./card-actions";
import type { Teammate } from "@/lib/queue/reports";

/**
 * One report, sized for a phone held one-handed outdoors.
 *
 * High contrast and large type are functional requirements here, not taste:
 * this gets read in direct sun by someone wearing gloves.
 *
 * Five things have to be answerable without reading a sentence — where, how
 * urgent, whose job, how old, and whether it has blown its SLA. Each of those
 * is a labelled badge or a number, never a colour on its own: the bar down the
 * left edge repeats the urgency for people scanning a list, but it is a
 * repetition, and nothing is only the bar.
 */

const URGENCY: Record<
  string,
  { label: string; bar: string; tone: "urgent" | "high" | "normal" | "low"; loud: boolean }
> = {
  urgent: { label: "Urgent", bar: "bg-urgent",      tone: "urgent", loud: true  },
  high:   { label: "High",   bar: "bg-high",        tone: "high",   loud: true  },
  normal: { label: "Normal", bar: "bg-neutral-bar", tone: "normal", loud: false },
  low:    { label: "Low",    bar: "bg-quiet-bar",   tone: "low",    loud: false },
};

const STATUS_LABEL: Record<string, string> = {
  new: "New",
  triaged: "Unclaimed",
  acknowledged: "Claimed",
  in_progress: "In progress",
  scheduled: "Scheduled",
};

/** "2026-09-08" reads as a database row on a phone; "Sep 8" reads as a day. */
function day(iso: string) {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function age(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h}h ${minutes % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function QueueCard({
  row, team, meId,
}: { row: QueueRow; team: Teammate[]; meId: string }) {
  const u = URGENCY[row.urgency] ?? URGENCY.normal;
  const unclaimed = !row.claimed_by;

  return (
    <article className="relative overflow-hidden rounded-card border border-line bg-surface-raised shadow-card">
      <div className={`absolute inset-y-0 left-0 w-1.5 ${u.bar}`} />

      <div className="py-5 pl-7 pr-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <a href={`/app/report/${row.id}`} className="block">
              <h2 className="font-display text-[1.7rem] leading-none tracking-tight underline-offset-[6px] hover:underline">
                {row.hole_number ? `Hole ${row.hole_number}` : row.location_name}
              </h2>
            </a>
            {row.claimed_by_name && (
              <p className="mt-2 text-[13px] text-ink-muted">{row.claimed_by_name}</p>
            )}
          </div>

          <Badge variant={u.tone} size={u.loud ? "loud" : "default"} className="shrink-0">
            {u.label}
          </Badge>
        </div>

        {/* The member's own words, never the AI summary. */}
        <p className="mt-4 text-[16px] leading-relaxed text-ink">{row.body}</p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Badge variant="department">{row.department_name ?? "Unrouted"}</Badge>

          {/* One badge per fact. "Scheduled" beside "Scheduled 2026-09-08", and
              "Unclaimed" beside "Nobody has this", are each the same thing said
              twice — and on a 390px card every wasted badge pushes the age onto
              another line. */}
          {row.scheduled_for ? (
            <Badge variant="status">Scheduled {day(row.scheduled_for)}</Badge>
          ) : (
            <Badge variant="status">{STATUS_LABEL[row.status] ?? row.status}</Badge>
          )}
          {unclaimed && row.status !== "triaged" && (
            <Badge variant="low">Nobody has this</Badge>
          )}

          {/* Overdue is stated plainly rather than colour-coded alone —
              colour is unreliable in bright sun. */}
          <span className="ml-auto shrink-0">
            {row.ack_overdue ? (
              <Badge variant="urgent" className="tabular-nums">
                {age(row.minutes_open)} overdue
              </Badge>
            ) : (
              <span className="text-[13px] tabular-nums text-ink-muted">
                {age(row.minutes_open)}
              </span>
            )}
          </span>
        </div>

        <CardActions reportId={row.id} claimed={!!row.claimed_by} team={team} meId={meId} />
      </div>
    </article>
  );
}
