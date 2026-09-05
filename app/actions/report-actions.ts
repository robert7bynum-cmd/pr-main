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
): Promise<ActionResult> {
  if (!internalNote.trim()) {
    return { ok: false, message: "Add a short note about what you did." };
  }

  await callFn("resolve_report", {
    p_report_id: reportId,
    p_actor: await currentStaffId(),
    p_internal_note: internalNote.trim(),
    // ProResponse is an operations tool: nothing goes back to the member.
    p_member_message: null,
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

/**
 * Hand a report to a named person.
 *
 * The database resets the acknowledgement clock, so the message says so — a
 * supervisor who thinks they have just recorded that the work is done, rather
 * than that it now belongs to someone else, will be surprised by the escalation
 * that follows.
 */
export async function assignAction(
  reportId: string,
  assigneeId: string,
): Promise<ActionResult> {
  if (!assigneeId) return { ok: false, message: "Pick someone." };

  const row = await callFn("assign_report", {
    p_report_id: reportId,
    p_actor: await currentStaffId(),
    p_assignee: assigneeId,
  });

  revalidatePath("/app");

  if (row && row.ok === false) {
    return { ok: false, message: `${row.assignee_name ?? "They"} already has this` };
  }
  return { ok: true, message: `Handed to ${row?.assignee_name ?? "them"}` };
}
