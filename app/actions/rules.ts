"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface RuleInput {
  category: string;
  department_id: string;
  ack_sla_minutes: number;
  resolve_sla_minutes: number;
}

/**
 * Saves the whole table at once. The guards — club scoping, department
 * ownership, SLA bounds — are enforced in the database function, not here.
 */
export async function saveRoutingRules(
  rules: RuleInput[],
): Promise<{ ok: boolean; message: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("update_routing_rules", { p_rules: rules });

  if (error) return { ok: false, message: error.message };
  revalidatePath("/app/rules");

  const changed = Number(data ?? 0);
  return {
    ok: true,
    message: changed === 0 ? "No changes to save." :
      changed === 1 ? "Saved 1 change." : `Saved ${changed} changes.`,
  };
}
