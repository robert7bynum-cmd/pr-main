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
 * The authenticated staff member, always. An action attributed to a guessed
 * actor would poison exactly the accountability data this product is sold on,
 * so this throws rather than falling back to anyone.
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

  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error("not signed in");
  return data.user.id;
}

export interface Me {
  profile_id: string;
  full_name: string;
  role: string;
  course_name: string;
  on_duty: boolean;
}

/** The signed-in staff member, or null if they have no profile at this club. */
export async function getMe(): Promise<Me | null> {
  if (usingDevDb()) {
    const db = await devDb();
    const res = await db.query<Me>(
      `select p.id as profile_id, p.full_name, p.role::text as role,
              c.name as course_name, p.on_duty
         from profiles p join courses c on c.id = p.course_id
        where p.account_kind = 'individual' and p.active
        order by case p.role when 'supervisor' then 0 else 1 end limit 1`,
    );
    return res.rows[0] ?? null;
  }

  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("me");
  if (error) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return (row as Me) ?? null;
}
