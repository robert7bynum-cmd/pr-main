import "server-only";

import { createClient } from "@/lib/supabase/server";

export interface RosterRow {
  profile_id: string;
  full_name: string;
  email: string | null;
  role: string;
  active: boolean;
  on_duty: boolean;
  account_kind: string;
  departments: string[];
  resolved_30d: number;
}

export interface Department { id: string; key: string; name: string }

export interface PendingInvite {
  id: string;
  email: string;
  full_name: string;
  role: string;
  created_at: string;
}

export async function getStaffPage() {
  const supabase = await createClient();
  const [{ data: roster }, { data: departments }, { data: pending }] = await Promise.all([
    supabase.rpc("staff_roster"),
    supabase.from("departments").select("id, key, name").order("sort_order"),
    supabase.from("pending_profiles").select("id, email, full_name, role, created_at")
      .is("claimed_at", null).order("created_at", { ascending: false }),
  ]);

  return {
    roster: (roster ?? []) as RosterRow[],
    departments: (departments ?? []) as Department[],
    // Someone invited who has never signed in is a gap a manager should see —
    // they think that person is covered and they are not.
    pending: (pending ?? []) as PendingInvite[],
  };
}
