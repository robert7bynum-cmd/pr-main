"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface SettingsResult { ok: boolean; message: string }

/**
 * Club configuration: the settings screen and the locations screen.
 *
 * Every one of these calls a SECURITY DEFINER function that holds the guards
 * itself — club scoping, the management check, what makes an address
 * printable, what makes a location retirable. Nothing here decides who may do
 * what; a different client could not skip the check by not going through this
 * file. Each function also writes its own admin_events row, so the record of
 * who changed the placard address is made beside the change, not by the
 * caller remembering to.
 */
const PAGES = ["/app/settings", "/app/locations", "/app/placards"];

async function call<T>(
  fn: string, args: Record<string, unknown>,
): Promise<{ data: T | null; error: string | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { data: null, error: error.message };
  for (const p of PAGES) revalidatePath(p);
  return { data: data as T, error: null };
}

export interface CourseSettingsInput {
  name: string;
  timezone: string;
  publicUrl: string;
  quietStart: string;
  quietEnd: string;
}

export async function saveCourseSettings(input: CourseSettingsInput): Promise<SettingsResult> {
  const { data, error } = await call<number>("update_course_settings", {
    p_name: input.name.trim(),
    p_timezone: input.timezone.trim(),
    p_public_url: input.publicUrl.trim() || null,
    p_quiet_start: input.quietStart.trim() || null,
    p_quiet_end: input.quietEnd.trim() || null,
  });
  if (error) return { ok: false, message: error };
  const changed = Number(data ?? 0);
  return {
    ok: true,
    message: changed === 0 ? "No changes to save." :
      changed === 1 ? "Saved 1 change." : `Saved ${changed} changes.`,
  };
}

export interface LocationInput {
  id: string | null;
  kind: string;
  holeNumber: number | null;
  name: string;
  sortOrder: number | null;
}

export async function saveLocation(input: LocationInput): Promise<SettingsResult> {
  const { error } = await call<string>("upsert_location", {
    p_id: input.id,
    p_kind: input.kind,
    p_hole_number: input.holeNumber,
    p_name: input.name.trim(),
    p_sort_order: input.sortOrder,
  });
  if (error) return { ok: false, message: error };
  return { ok: true, message: input.id ? "Saved." : `Added ${input.name.trim()}.` };
}

export async function setLocationActive(id: string, active: boolean): Promise<SettingsResult> {
  const { error } = await call<null>("set_location_active", { p_id: id, p_active: active });
  if (error) return { ok: false, message: error };
  return { ok: true, message: active ? "Restored." : "Retired. Its sign no longer works." };
}

export interface DepartmentInput {
  id: string | null;
  key: string;
  name: string;
  sortOrder: number | null;
}

export async function saveDepartment(input: DepartmentInput): Promise<SettingsResult> {
  const { error } = await call<string>("upsert_department", {
    p_id: input.id,
    p_key: input.key.trim().toLowerCase(),
    p_name: input.name.trim(),
    p_sort_order: input.sortOrder,
  });
  if (error) return { ok: false, message: error };
  return { ok: true, message: input.id ? "Saved." : `Added ${input.name.trim()}.` };
}

/**
 * Replaces a location's code. The token is never returned to the browser: the
 * placard page renders it into a QR, and a manager has no reason to see the
 * string itself. What comes back is the prefix the locations screen shows.
 */
export async function mintPlacard(locationId: string): Promise<SettingsResult & { prefix?: string }> {
  const { data, error } = await call<string>("mint_placard", { p_location_id: locationId });
  if (error) return { ok: false, message: error };
  return {
    ok: true,
    prefix: String(data ?? "").slice(0, 6),
    message: "New code issued. The old sign has stopped working — print the new one and replace it.",
  };
}
