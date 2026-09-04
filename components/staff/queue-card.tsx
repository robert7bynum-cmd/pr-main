import type { QueueRow } from "@/lib/queue/reports";
import { CardActions } from "./card-actions";

/**
 * One report, sized for a phone held one-handed outdoors.
 *
 * High contrast and large type are functional requirements here, not taste:
 * this gets read in direct sun by someone wearing gloves.
 */

const URGENCY: Record<string, { label: string; bar: string; chip: string }> = {
  urgent: { label: "Urgent", bar: "bg-red-600",    chip: "bg-red-600 text-white" },
  high:   { label: "High",   bar: "bg-amber-500",  chip: "bg-amber-500 text-black" },
  normal: { label: "",       bar: "bg-black/15",   chip: "" },
  low:    { label: "",       bar: "bg-black/10",   chip: "" },
};

const STATUS_LABEL: Record<string, string> = {
  new: "New",
  triaged: "Unclaimed",
  acknowledged: "Claimed",
  in_progress: "In progress",
  scheduled: "Scheduled",
};

function age(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h}h ${minutes % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function QueueCard({ row }: { row: QueueRow }) {
  const u = URGENCY[row.urgency] ?? URGENCY.normal;
  const unclaimed = !row.claimed_by;

  return (
    <article className="relative overflow-hidden rounded-2xl border border-black/10 bg-white">
      <div className={`absolute inset-y-0 left-0 w-1.5 ${u.bar}`} />

      <div className="pl-5 pr-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <a href={`/app/report/${row.id}`} className="block">
              <h2 className="text-[1.6rem] font-semibold leading-none tracking-tight underline-offset-4 hover:underline">
                {row.hole_number ? `Hole ${row.hole_number}` : row.location_name}
              </h2>
            </a>
            <p className="mt-1.5 text-[13px] text-black/50">
              {row.department_name ?? "Unrouted"}
              {row.claimed_by_name ? ` · ${row.claimed_by_name}` : ""}
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1.5">
            {u.label && (
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${u.chip}`}>
                {u.label}
              </span>
            )}
            {/* Overdue is stated plainly rather than colour-coded alone —
                colour is unreliable in bright sun. */}
            <span className={`text-[13px] tabular-nums ${row.ack_overdue ? "font-semibold text-red-600" : "text-black/45"}`}>
              {age(row.minutes_open)}{row.ack_overdue ? " overdue" : ""}
            </span>
          </div>
        </div>

        {/* The member's own words, never the AI summary. */}
        <p className="mt-3 text-[16px] leading-snug text-black/85">{row.body}</p>

        <div className="mt-3.5 flex items-center gap-2">
          <span className="rounded-md bg-black/[0.05] px-2 py-1 text-[12px] text-black/60">
            {STATUS_LABEL[row.status] ?? row.status}
          </span>
          {row.scheduled_for && (
            <span className="rounded-md bg-black/[0.05] px-2 py-1 text-[12px] text-black/60">
              Scheduled {row.scheduled_for}
            </span>
          )}
          {unclaimed && (
            <span className="ml-auto text-[12px] font-medium text-black/40">
              Nobody has this
            </span>
          )}
        </div>

        <CardActions reportId={row.id} claimed={!!row.claimed_by} />
      </div>
    </article>
  );
}
