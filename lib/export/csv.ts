/**
 * Turning report rows into a CSV a general manager can open in Excel.
 *
 * Pure: no database, no request. The route in app/api/export fetches and this
 * file formats, so the escaping rules are testable without Supabase
 * (scripts/test-export.mts) and the route stays a dozen lines of plumbing.
 *
 * What is deliberately NOT here — and cannot be added by accident:
 *
 *   - `body`: the member's own words. Names, phone numbers and grievances get
 *     typed into that box; it is PII-adjacent and it stays in the app.
 *   - `resolution_note`: staff write these candidly. The rule across the
 *     codebase is that an internal note never reaches anyone outside the
 *     queue, and a spreadsheet forwarded to a board is outside the queue.
 *   - `reporter_name`, `reporter_phone`, `reporter_member_no`, `email`,
 *     `tracking_token`: the member's contact details and their private link.
 *
 * The output is a whitelist projection: EXPORT_COLUMNS names every column that
 * can appear, and buildCsv reads only those keys off each row. A row carrying
 * `body` produces a file without it — there is no code path that copies an
 * unknown key through.
 */

export const EXPORT_COLUMNS = [
  "id",
  "created_at",
  "location",
  "hole",
  "category",
  "urgency",
  "source",
  "filed_by_name",
  "status",
  "acknowledged_at",
  "resolved_at",
  "resolved_by_name",
  "minutes_to_ack",
  "minutes_to_resolve",
  "escalation_level",
  "close_reason",
] as const;

export type ExportColumn = (typeof EXPORT_COLUMNS)[number];

export type ExportRow = Partial<Record<ExportColumn, string | number | null | undefined>>;

/**
 * One cell, safe for a spreadsheet.
 *
 * Two hazards. RFC 4180: a quote, comma or line break inside a value has to
 * be quoted, and quotes doubled. And formula injection: a cell beginning with
 * = + - or @ is executed by Excel and Sheets when the file is opened, so a
 * member who types "=HYPERLINK(...)" into a report — or a category named
 * "-safety" — would run in the GM's spreadsheet. A leading apostrophe makes
 * the spreadsheet read it as text; tab and carriage return are neutralised for
 * the same reason.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  // A real number is never a formula; only text can smuggle one in.
  if (typeof value === "number") return String(value);
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvHeader(): string {
  return EXPORT_COLUMNS.join(",");
}

/** One data line, columns in EXPORT_COLUMNS order, nothing else. */
export function csvLine(row: ExportRow): string {
  return EXPORT_COLUMNS.map((c) => csvCell(row[c])).join(",");
}

/** Header plus every row, CRLF-terminated as RFC 4180 asks. */
export function buildCsv(rows: ExportRow[]): string {
  return [csvHeader(), ...rows.map(csvLine)].join("\r\n") + "\r\n";
}

/** Whole minutes between two timestamps, or null if either is missing. */
export function minutesBetween(from: unknown, to: unknown): number | null {
  if (!from || !to) return null;
  const a = new Date(String(from)).getTime();
  const b = new Date(String(to)).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 60000);
}

/**
 * A timestamp as the club's wall clock: `2026-09-06 14:03:05`.
 *
 * A GM reading "created 03:12" needs that to be their 03:12, not UTC's. The
 * course's timezone comes from `courses.timezone`; an unknown zone name falls
 * back to UTC and says so in the cell rather than throwing the whole export
 * away over one setting.
 */
export function formatInZone(iso: unknown, timeZone: string): string {
  if (!iso) return "";
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return "";
  let fmt: Intl.DateTimeFormat;
  let suffix = "";
  try {
    fmt = zoneFormatter(timeZone);
  } catch {
    fmt = zoneFormatter("UTC");
    suffix = " UTC";
  }
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  // Intl reports midnight as "24" under hourCycle h23 on some engines.
  const hour = p.hour === "24" ? "00" : p.hour;
  return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute}:${p.second}${suffix}`;
}

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}
