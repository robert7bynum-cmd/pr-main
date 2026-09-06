/**
 * The CSV a general manager downloads.
 *
 * Two things must hold and neither is visible in a browser: a cell can never
 * run as a formula when the file is opened, and the member's words and the
 * staff's private notes can never be in it. Pure functions, so both are
 * checked without Supabase.
 */
import {
  EXPORT_COLUMNS, buildCsv, csvCell, csvHeader, csvLine, formatInZone, minutesBetween,
} from "../lib/export/csv";

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`); };

console.log("escaping");
check("plain text passes through", csvCell("Hole 7") === "Hole 7");
check("null is empty", csvCell(null) === "" && csvCell(undefined) === "");
check("a number is a number", csvCell(12) === "12" && csvCell(0) === "0");
check("a comma is quoted", csvCell("bunker, left") === '"bunker, left"');
check("a quote is doubled and quoted", csvCell('the "green"') === '"the ""green"""');
check("a newline is quoted", csvCell("line one\nline two") === '"line one\nline two"');
check("a carriage return is neutralised and quoted", csvCell("\rx") === "\"'\rx\"");

console.log("\nformula injection");
for (const p of ["=", "+", "-", "@", "\t"]) {
  const out = csvCell(`${p}HYPERLINK("x")`);
  check(`a cell starting with ${JSON.stringify(p)} is prefixed with a quote`,
    out.replace(/^"/, "").startsWith("'" + p), out);
}
check("=1+1 does not compute", csvCell("=1+1") === "'=1+1");
check("a negative number as a number is not a formula", csvCell(-5) === "-5");
check("a hole named -6 is text", csvCell("-6").startsWith("'"));
check("an inner = is not touched", csvCell("a=b") === "a=b");

console.log("\ncolumns");
check("the header is the column list in order",
  csvHeader() === "id,created_at,location,hole,category,urgency,source,filed_by_name,status,acknowledged_at,resolved_at,resolved_by_name,minutes_to_ack,minutes_to_resolve,escalation_level,close_reason");
check("sixteen columns", EXPORT_COLUMNS.length === 16);
for (const forbidden of ["body", "resolution_note", "member_message", "reporter_name", "reporter_phone", "reporter_member_no", "reporter_email", "email", "tracking_token", "ai_raw"]) {
  check(`${forbidden} is not a column`, !(EXPORT_COLUMNS as readonly string[]).includes(forbidden));
}

const row = {
  id: "r1", created_at: "2026-09-06 08:00:00", location: "Hole 7", hole: 7,
  category: "course_maintenance", urgency: "high", source: "member_qr", filed_by_name: null,
  status: "resolved", acknowledged_at: "2026-09-06 08:04:00", resolved_at: "2026-09-06 08:40:00",
  resolved_by_name: "Dana Ruiz", minutes_to_ack: 4, minutes_to_resolve: 40,
  escalation_level: 0, close_reason: "fixed",
  // What must never come out, even when it goes in.
  body: "SECRET-MEMBER-WORDS my phone is 555-0100",
  resolution_note: "SECRET-INTERNAL-NOTE member was rude",
  reporter_phone: "555-0100",
  member_message: "SECRET-MEMBER-MESSAGE",
};
const line = csvLine(row);
check("a line has one cell per column", line.split(",").length === EXPORT_COLUMNS.length, line);
check("cells are in column order",
  line === "r1,2026-09-06 08:00:00,Hole 7,7,course_maintenance,high,member_qr,,resolved,2026-09-06 08:04:00,2026-09-06 08:40:00,Dana Ruiz,4,40,0,fixed", line);

console.log("\nwhat never leaves");
const csv = buildCsv([row, { ...row, id: "r2", body: "=cmd|' /C calc'!A0" }]);
check("the member's words are not in the file", !csv.includes("SECRET-MEMBER-WORDS"));
check("the internal note is not in the file", !csv.includes("SECRET-INTERNAL-NOTE"));
check("the member message is not in the file", !csv.includes("SECRET-MEMBER-MESSAGE"));
check("the reporter's phone is not in the file", !csv.includes("555-0100"));
check("a formula smuggled in a forbidden key is not in the file", !csv.includes("calc"));
check("the file is header plus two rows, CRLF", csv.split("\r\n").length === 4 && csv.endsWith("\r\n"));
check("an empty export is just the header", buildCsv([]) === csvHeader() + "\r\n");

console.log("\nclocks");
check("minutes between", minutesBetween("2026-09-06T08:00:00Z", "2026-09-06T08:41:30Z") === 42);
check("no ack, no number", minutesBetween("2026-09-06T08:00:00Z", null) === null);
check("garbage, no number", minutesBetween("nope", "2026-09-06T08:00:00Z") === null);
check("a UTC instant reads as the club's wall clock",
  formatInZone("2026-09-06T12:00:00Z", "America/New_York") === "2026-09-06 08:00:00",
  formatInZone("2026-09-06T12:00:00Z", "America/New_York"));
check("and crosses midnight the right way",
  formatInZone("2026-09-06T03:30:00Z", "America/Los_Angeles") === "2026-09-05 20:30:00",
  formatInZone("2026-09-06T03:30:00Z", "America/Los_Angeles"));
check("midnight is 00, not 24",
  formatInZone("2026-09-06T04:00:00Z", "America/New_York") === "2026-09-06 00:00:00",
  formatInZone("2026-09-06T04:00:00Z", "America/New_York"));
check("an unknown zone falls back to UTC and says so",
  formatInZone("2026-09-06T12:00:00Z", "Mars/Olympus") === "2026-09-06 12:00:00 UTC",
  formatInZone("2026-09-06T12:00:00Z", "Mars/Olympus"));
check("a missing timestamp is an empty cell", formatInZone(null, "UTC") === "");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
