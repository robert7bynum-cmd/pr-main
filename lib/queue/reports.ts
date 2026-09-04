import "server-only";

import { devDb, usingDevDb } from "@/lib/dev-db";

/**
 * Reading the staff queue.
 *
 * Both paths select from the same `staff_queue` view, so the dev database and
 * Supabase return identical shapes and the UI cannot drift between them.
 */
export interface QueueRow {
  id: string;
  status: string;
  urgency: "low" | "normal" | "high" | "urgent";
  category: string | null;
  body: string;
  ai_summary: string | null;
  created_at: string;
  acknowledged_at: string | null;
  claimed_by: string | null;
  claimed_by_name: string | null;
  scheduled_for: string | null;
  location_name: string;
  hole_number: number | null;
  department_name: string | null;
  department_key: string | null;
  minutes_open: number;
  ack_overdue: boolean;
}

// Scheduled work sinks to the bottom: it is handled, just not today, and it
// should never outrank something happening on the course right now. Within
// each group: urgent first, then whatever has been waiting longest —
// deliberately not "newest first", because the oldest unhandled report is the
// one that embarrasses the club and a queue that buries it is worse than none.
const ORDER = `order by
  case when status = 'scheduled' then 1 else 0 end,
  case urgency when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
  minutes_open desc`;

/**
 * PGlite hands back Date objects where PostgREST hands back strings. Normalise
 * here so the two paths are genuinely interchangeable and the UI never has to
 * know which database it is talking to.
 */
function normalise(row: Record<string, unknown>): QueueRow {
  const iso = (v: unknown) =>
    v instanceof Date ? v.toISOString() : (v as string | null);
  const day = (v: unknown) =>
    v instanceof Date ? v.toISOString().slice(0, 10) : (v as string | null);

  return {
    ...(row as unknown as QueueRow),
    created_at: iso(row.created_at) as string,
    acknowledged_at: iso(row.acknowledged_at),
    scheduled_for: day(row.scheduled_for),
  };
}

export async function getQueue(departmentKey?: string): Promise<QueueRow[]> {
  if (usingDevDb()) {
    const db = await devDb();
    const where = departmentKey ? `where department_key = $1` : ``;
    const res = await db.query<Record<string, unknown>>(
      `select * from staff_queue ${where} ${ORDER}`,
      departmentKey ? [departmentKey] : [],
    );
    return res.rows.map(normalise);
  }

  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  let q = supabase.from("staff_queue").select("*");
  if (departmentKey) q = q.eq("department_key", departmentKey);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const rank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
  const sched = (r: QueueRow) => (r.status === "scheduled" ? 1 : 0);
  return ((data ?? []) as Record<string, unknown>[]).map(normalise).sort(
    (a, b) =>
      sched(a) - sched(b) ||
      rank[a.urgency] - rank[b.urgency] ||
      b.minutes_open - a.minutes_open,
  );
}

export interface DepartmentCount {
  key: string;
  name: string;
  open: number;
}

export async function getDepartmentCounts(): Promise<DepartmentCount[]> {
  const rows = await getQueue();
  const map = new Map<string, DepartmentCount>();
  for (const r of rows) {
    if (!r.department_key) continue;
    const entry = map.get(r.department_key) ?? {
      key: r.department_key,
      name: r.department_name ?? r.department_key,
      open: 0,
    };
    entry.open++;
    map.set(r.department_key, entry);
  }
  return [...map.values()].sort((a, b) => b.open - a.open);
}

export interface TimelineEvent {
  type: string;
  actor_name: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface ReportDetail extends QueueRow {
  resolution_note: string | null;
  member_message: string | null;
  resolved_by_name: string | null;
  events: TimelineEvent[];
}

const DETAIL_SQL = `
  select r.id, r.status::text as status, r.urgency::text as urgency, r.category,
         r.body, r.ai_summary, r.created_at, r.acknowledged_at, r.claimed_by,
         r.scheduled_for, r.resolution_note, r.member_message,
         l.name as location_name, l.hole_number,
         d.name as department_name, d.key as department_key,
         cp.full_name as claimed_by_name, rp.full_name as resolved_by_name,
         (extract(epoch from (now() - r.created_at)) / 60)::int as minutes_open,
         false as ack_overdue
    from reports r
    join locations l on l.id = r.location_id
    left join departments d on d.id = r.department_id
    left join profiles cp on cp.id = r.claimed_by
    left join profiles rp on rp.id = r.resolved_by
   where r.id = $1`;

const EVENTS_SQL = `
  select e.type::text as type, p.full_name as actor_name, e.payload, e.created_at
    from report_events e
    left join profiles p on p.id = e.actor_id
   where e.report_id = $1
   order by e.created_at, e.id`;

export async function getReportDetail(id: string): Promise<ReportDetail | null> {
  if (usingDevDb()) {
    const db = await devDb();
    const r = await db.query<Record<string, unknown>>(DETAIL_SQL, [id]);
    if (!r.rows.length) return null;
    const ev = await db.query<Record<string, unknown>>(EVENTS_SQL, [id]);
    return {
      ...(normalise(r.rows[0]) as ReportDetail),
      resolution_note: r.rows[0].resolution_note as string | null,
      member_message: r.rows[0].member_message as string | null,
      resolved_by_name: r.rows[0].resolved_by_name as string | null,
      events: ev.rows.map((e) => ({
        type: e.type as string,
        actor_name: e.actor_name as string | null,
        payload: e.payload as Record<string, unknown> | null,
        created_at:
          e.created_at instanceof Date ? e.created_at.toISOString() : String(e.created_at),
      })),
    };
  }

  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();

  // RLS scopes both of these to the caller's club, so a report id from another
  // club simply returns nothing.
  const [{ data: rows }, { data: events }] = await Promise.all([
    supabase.from("reports").select(
      "id,status,urgency,category,body,ai_summary,created_at,acknowledged_at,claimed_by,scheduled_for,resolution_note,member_message,location_id,department_id,resolved_by",
    ).eq("id", id).limit(1),
    supabase.from("report_events").select("type,payload,created_at,actor_id")
      .eq("report_id", id).order("created_at"),
  ]);
  if (!rows?.length) return null;

  const row = rows[0] as Record<string, unknown>;
  const [{ data: loc }, { data: dept }, { data: people }] = await Promise.all([
    supabase.from("locations").select("name,hole_number").eq("id", row.location_id).limit(1),
    row.department_id
      ? supabase.from("departments").select("name,key").eq("id", row.department_id).limit(1)
      : Promise.resolve({ data: null }),
    supabase.from("profiles").select("id,full_name"),
  ]);

  const nameOf = (uid: unknown) =>
    (people ?? []).find((p) => (p as { id: string }).id === uid)?.full_name ?? null;

  const created = String(row.created_at);
  return {
    ...(row as unknown as QueueRow),
    location_name: loc?.[0]?.name ?? "",
    hole_number: loc?.[0]?.hole_number ?? null,
    department_name: dept?.[0]?.name ?? null,
    department_key: dept?.[0]?.key ?? null,
    claimed_by_name: nameOf(row.claimed_by),
    resolved_by_name: nameOf(row.resolved_by),
    resolution_note: row.resolution_note as string | null,
    member_message: row.member_message as string | null,
    minutes_open: Math.round((Date.now() - new Date(created).getTime()) / 60000),
    ack_overdue: false,
    events: (events ?? []).map((e) => {
      const ev = e as Record<string, unknown>;
      return {
        type: String(ev.type),
        actor_name: nameOf(ev.actor_id),
        payload: ev.payload as Record<string, unknown> | null,
        created_at: String(ev.created_at),
      };
    }),
  } as ReportDetail;
}
