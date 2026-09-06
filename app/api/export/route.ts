import { createClient } from "@/lib/supabase/server";
import {
  csvHeader,
  csvLine,
  formatInZone,
  minutesBetween,
  type ExportRow,
} from "@/lib/export/csv";

/**
 * A club's reports as a CSV file, for the manager who asks for their data out.
 *
 * Session client only, so RLS scopes every read to the caller's own club, and
 * management only, because the file names who resolved what and how long they
 * took — the same per-person data the dashboard keeps behind the same check.
 *
 * NOT in the file, on purpose: `body` (the member's words), `resolution_note`
 * (internal, never leaves the queue), and every reporter contact column. The
 * select below does not ask for them, and lib/export/csv.ts would drop them
 * even if it did. See the comment at the top of that file.
 */
export const dynamic = "force-dynamic";

const WINDOWS = new Set([30, 90, 365]);

// Excel opens a UTF-8 file with a byte-order mark as UTF-8 and one without as
// the local code page, which turns "Restroom — Hole 6" into garbage.
const BOM = "\uFEFF";

export async function GET(req: Request) {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return new Response("Export needs Supabase; not available in this environment.", {
      status: 503, headers: { "cache-control": "no-store" },
    });
  }

  const raw = new URL(req.url).searchParams.get("days");
  const days = raw === null ? 30 : Number(raw);
  if (!WINDOWS.has(days)) {
    return new Response("days must be 30, 90 or 365", {
      status: 400, headers: { "cache-control": "no-store" },
    });
  }

  const supabase = await createClient();
  const { data: meData, error: meError } = await supabase.rpc("me");
  const me = (Array.isArray(meData) ? meData[0] : meData) as
    | { role: string; course_id: string }
    | null
    | undefined;
  if (meError || !me) {
    return new Response("Sign in first.", { status: 401, headers: { "cache-control": "no-store" } });
  }
  if (!["manager", "owner"].includes(me.role)) {
    return new Response("Export is for management.", {
      status: 403, headers: { "cache-control": "no-store" },
    });
  }

  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  // RLS confines all four of these to the caller's club, the same way
  // getReportDetail joins by hand instead of through PostgREST embedding.
  const [{ data: reports, error }, { data: courses }, { data: locations }, { data: people }] =
    await Promise.all([
      supabase
        .from("reports")
        .select(
          "id,created_at,location_id,category,urgency,source,filed_by,status,acknowledged_at,resolved_at,resolved_by,escalation_level,close_reason",
        )
        .gte("created_at", since)
        .order("created_at"),
      supabase.from("courses").select("slug,timezone").eq("id", me.course_id).limit(1),
      supabase.from("locations").select("id,name,hole_number"),
      supabase.from("profiles").select("id,full_name"),
    ]);
  if (error) {
    return new Response(`Could not read reports: ${error.message}`, {
      status: 500, headers: { "cache-control": "no-store" },
    });
  }

  const course = courses?.[0] as { slug: string; timezone: string } | undefined;
  const tz = course?.timezone || "UTC";
  const slug = course?.slug || "club";

  const locOf = new Map(
    (locations ?? []).map((l) => {
      const r = l as { id: string; name: string; hole_number: number | null };
      return [r.id, r] as const;
    }),
  );
  const nameOf = new Map(
    (people ?? []).map((p) => {
      const r = p as { id: string; full_name: string };
      return [r.id, r.full_name] as const;
    }),
  );

  const rows: ExportRow[] = (reports ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    const loc = locOf.get(String(row.location_id));
    return {
      id: String(row.id),
      created_at: formatInZone(row.created_at, tz),
      location: loc?.name ?? "",
      hole: loc?.hole_number ?? null,
      category: (row.category as string | null) ?? null,
      urgency: String(row.urgency),
      source: String(row.source),
      filed_by_name: row.filed_by ? (nameOf.get(String(row.filed_by)) ?? null) : null,
      status: String(row.status),
      acknowledged_at: formatInZone(row.acknowledged_at, tz),
      resolved_at: formatInZone(row.resolved_at, tz),
      resolved_by_name: row.resolved_by ? (nameOf.get(String(row.resolved_by)) ?? null) : null,
      minutes_to_ack: minutesBetween(row.created_at, row.acknowledged_at),
      minutes_to_resolve: minutesBetween(row.created_at, row.resolved_at),
      escalation_level: Number(row.escalation_level ?? 0),
      close_reason: (row.close_reason as string | null) ?? null,
    };
  });

  // Streamed a line at a time; a year of a busy club is thousands of rows and
  // there is no reason to hold the whole file in memory first.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(BOM + csvHeader() + "\r\n"));
      for (const row of rows) controller.enqueue(encoder.encode(csvLine(row) + "\r\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="proresponse-${slug}-${days}d.csv"`,
      "cache-control": "no-store",
    },
  });
}
