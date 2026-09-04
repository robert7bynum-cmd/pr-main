import "server-only";

import { devDb, usingDevDb } from "@/lib/dev-db";

export interface Today {
  open_now: number;
  filed_today: number;
  resolved_today: number;
  median_ack_minutes: number | null;
  median_resolve_minutes: number | null;
}
export interface Daily { day: string; filed: number }
export interface ByDept {
  key: string; name: string; open_now: number;
  total_30d: number; median_resolve_minutes: number | null;
}
export interface Recurring {
  location: string; category: string; occurrences: number; most_recent: string;
}
export interface ByPerson {
  profile_id: string;
  full_name: string; resolved_30d: number; median_handling_minutes: number | null;
}

async function all<T>(view: string, order = ""): Promise<T[]> {
  if (usingDevDb()) {
    const db = await devDb();
    return (await db.query<T>(`select * from ${view} ${order}`)).rows;
  }
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data, error } = await supabase.from(view).select("*");
  if (error) throw new Error(`${view}: ${error.message}`);
  return (data ?? []) as T[];
}

export async function getDashboard() {
  const [today, daily, byDept, recurring, byPerson] = await Promise.all([
    all<Today>("dashboard_today"),
    all<Daily>("dashboard_daily"),
    all<ByDept>("dashboard_by_department"),
    all<Recurring>("dashboard_recurring"),
    all<ByPerson>("dashboard_by_person"),
  ]);

  // Dates arrive as Date from PGlite and strings from PostgREST; normalise so
  // the chart does not have to care which database it is talking to.
  const day = (v: unknown) =>
    v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

  return {
    today: today[0] ?? null,
    daily: daily
      .map((d) => ({ ...d, day: day(d.day) }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    byDept: byDept.sort((a, b) => b.open_now - a.open_now || b.total_30d - a.total_30d),
    recurring: recurring.sort((a, b) => b.occurrences - a.occurrences).slice(0, 8),
    byPerson: byPerson.sort((a, b) => b.resolved_30d - a.resolved_30d).slice(0, 8),
  };
}
