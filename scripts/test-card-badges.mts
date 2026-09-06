/**
 * What the card says about whose job a report is.
 *
 * This went wrong the moment assignment existed. Handing a report to somebody
 * sets claimed_by and clears acknowledged_at so their response clock starts
 * when they pick it up — which returns the row to 'triaged'. A badge reading
 * status alone then said "Unclaimed" directly underneath the name of the person
 * it had just been handed to.
 *
 * Pure function, so the contradiction is checkable without a browser: the two
 * things the card renders must never disagree.
 */
import { ownership } from "@/lib/queue/ownership";

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`); };

const row = (o: Partial<Parameters<typeof ownership>[0]>) => ({
  status: "triaged", claimed_by: null, acknowledged_at: null, scheduled_for: null, ...o,
});

console.log("whose job is it");
check("nobody has it", ownership(row({})).label === "Unclaimed");
check("someone picked it up",
  ownership(row({ status: "acknowledged", claimed_by: "p1", acknowledged_at: "2026-09-06T10:00:00Z" })).label === "Claimed");
check("work has started",
  ownership(row({ status: "in_progress", claimed_by: "p1", acknowledged_at: "2026-09-06T10:00:00Z" })).label === "In progress");
check("it is booked for a day",
  ownership(row({ scheduled_for: "2026-09-08" })).label.startsWith("Scheduled"));

console.log("\nthe state assignment creates");
const handed = ownership(row({ status: "triaged", claimed_by: "p2", acknowledged_at: null }));
check("a report handed over does not read as unclaimed", handed.label !== "Unclaimed", handed.label);
check("it says somebody is expected to pick it up", handed.label === "Waiting on them", handed.label);
check("and is toned to stand out, since escalation is counting", handed.tone === "high", handed.tone);

console.log("\nthe badge never contradicts the name beside it");
for (const [label, r] of [
  ["handed over", row({ claimed_by: "p2", acknowledged_at: null })],
  ["picked up", row({ status: "acknowledged", claimed_by: "p2", acknowledged_at: "2026-09-06T10:00:00Z" })],
  ["in progress", row({ status: "in_progress", claimed_by: "p2", acknowledged_at: "2026-09-06T10:00:00Z" })],
] as const) {
  // A card showing a person's name must never also say nobody has it.
  check(`${label}: a named owner is never called unclaimed`,
    ownership(r).label !== "Unclaimed", ownership(r).label);
}
check("and with no owner it does not name one",
  ownership(row({ claimed_by: null })).label === "Unclaimed");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
