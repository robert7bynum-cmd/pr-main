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

// Urgent first, then whatever has been waiting longest. Deliberately not
// "newest first" — the oldest unhandled report is the one that embarrasses
// the club, and a queue that buries it is worse than no queue.
const ORDER = `order by
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
  return ((data ?? []) as Record<string, unknown>[]).map(normalise).sort(
    (a, b) => rank[a.urgency] - rank[b.urgency] || b.minutes_open - a.minutes_open,
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
