import "server-only";

import { devDb, usingDevDb } from "@/lib/dev-db";

/**
 * Calling a report action, against whichever database is configured.
 *
 * Both paths invoke the same SQL functions, so behaviour is identical and the
 * transitions stay covered by scripts/test-actions.mts.
 */
export async function callFn(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (usingDevDb()) {
    const db = await devDb();
    const keys = Object.keys(args);
    const params = keys.map((_, i) => `$${i + 1}`).join(", ");
    const res = await db.query<Record<string, unknown>>(
      `select * from ${name}(${params})`,
      keys.map((k) => args[k]),
    );
    return res.rows[0] ?? null;
  }

  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? (data[0] ?? null) : (data as Record<string, unknown> | null);
}

/**
 * Who is acting.
 *
 * Real auth (magic link) is the next chunk. Until then the dev database picks a
 * supervisor so actions are attributable and the event trail is realistic.
 * Refuses to guess in production — an unattributed action would poison the
 * accountability data this product is sold on.
 */
export async function currentStaffId(): Promise<string> {
  if (usingDevDb()) {
    const db = await devDb();
    const res = await db.query<{ id: string }>(
      `select id from profiles where account_kind = 'individual' and active
        order by case role when 'supervisor' then 0 else 1 end limit 1`,
    );
    return res.rows[0].id;
  }
  throw new Error("staff authentication is not wired up yet");
}
