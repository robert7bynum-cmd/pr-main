"use server";

import { revalidatePath } from "next/cache";
import { callFn, currentStaffId } from "@/lib/queue/actions-db";

export interface ActionResult {
  ok: boolean;
  message?: string;
}

export async function acknowledgeAction(reportId: string): Promise<ActionResult> {
  const actor = await currentStaffId();
  const row = await callFn("acknowledge_report", {
    p_report_id: reportId,
    p_actor: actor,
  });

  revalidatePath("/app");

  // Refused because someone already owns it — say who, don't fail silently.
  if (row && row.ok === false) {
    return { ok: false, message: `${row.claimed_by_name ?? "Someone else"} already has this` };
  }
  return { ok: true, message: "Claimed" };
}

export async function resolveAction(
  reportId: string,
  internalNote: string,
  memberMessage: string | null,
): Promise<ActionResult> {
  if (!internalNote.trim()) {
    return { ok: false, message: "Add a short note about what you did." };
  }

  await callFn("resolve_report", {
    p_report_id: reportId,
    p_actor: await currentStaffId(),
    p_internal_note: internalNote.trim(),
    // Empty means the member hears nothing — an explicit choice, not a default.
    p_member_message: memberMessage?.trim() ? memberMessage.trim() : null,
  });

  revalidatePath("/app");
  return { ok: true, message: "Resolved" };
}

export async function scheduleAction(
  reportId: string,
  date: string,
): Promise<ActionResult> {
  if (!date) return { ok: false, message: "Pick a date." };
  await callFn("schedule_report", {
    p_report_id: reportId,
    p_actor: await currentStaffId(),
    p_date: date,
    p_note: null,
  });
  revalidatePath("/app");
  return { ok: true, message: `Scheduled for ${date}` };
}
