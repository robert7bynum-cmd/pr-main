/**
 * Whose job a report is, derived rather than read off `status`.
 *
 * Its own module, with no server-only import, because this is a decision worth
 * testing and it could not be tested where it was — the same reason the placard
 * address moved out of the query that fetches placards.
 */
/** "2026-09-08" reads as a database row on a phone; "Sep 8" reads as a day. */
function day(iso: string) {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Whose job this is, from the facts rather than from `status`.
 *
 * Handing a report to somebody sets claimed_by and clears acknowledged_at, so
 * that their response clock starts when THEY pick it up rather than inheriting
 * the last person's. That puts the row back in `triaged`, and a badge reading
 * status alone then said "Unclaimed" directly beneath the name of the person it
 * had just been given to.
 *
 * The status enum has no word for "assigned, not yet picked up", and adding one
 * would mean every other read learning about it. These two columns already say
 * it between them: claimed_by is who owns it, acknowledged_at is whether they
 * have taken it on.
 */
export function ownership(row: {
  status: string;
  claimed_by: string | null;
  acknowledged_at: string | null;
  scheduled_for: string | null;
}): { label: string; tone: "status" | "high" | "low" } {
  if (row.scheduled_for) return { label: `Scheduled ${day(row.scheduled_for)}`, tone: "status" };
  if (row.status === "in_progress") return { label: "In progress", tone: "status" };
  if (!row.claimed_by) return { label: "Unclaimed", tone: "low" };
  // Given to someone who has not yet said they have it. Worth a louder tone
  // than "claimed": this is the state escalation is counting against.
  if (!row.acknowledged_at) return { label: "Waiting on them", tone: "high" };
  return { label: "Claimed", tone: "status" };
}
