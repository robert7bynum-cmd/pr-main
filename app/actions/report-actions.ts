"use server";

import { revalidatePath } from "next/cache";
import { callFn, currentStaffId, getMe } from "@/lib/queue/actions-db";
import { getDepartments } from "@/lib/queue/reports";
import { CLOSE_REASONS, isCloseReason } from "@/lib/queue/close-reasons";

export interface ActionResult {
  ok: boolean;
  message?: string;
}

export async function acknowledgeAction(reportId: string): Promise<ActionResult> {
  // A shared counter login never claims in its own name: "Pro Shop Counter"
  // resolving a report answers "who handled it" with nobody. The card already
  // offers a station "Who's taking this?" instead, but a browser tab open since
  // before that change would still send this — so the refusal lives here too.
  const me = await getMe();
  if (me?.account_kind === "station") {
    return {
      ok: false,
      message: "Pick who is taking this — a shared login cannot claim in its own name.",
    };
  }

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

/**
 * The database's refusals, in words a person on the course can act on.
 *
 * Every function below is guarded by assert_actor, which raises for a report
 * at another club, a deactivated caller, or a department that is not the
 * club's. Those messages are written for a log; these are for a phone.
 */
function refusal(e: unknown): ActionResult {
  const msg = e instanceof Error ? e.message : String(e);
  if (/department not found/i.test(msg)) {
    return { ok: false, message: "That department isn't at this club." };
  }
  if (/report not found/i.test(msg)) {
    return { ok: false, message: "This report is no longer here." };
  }
  if (/signed-in user|attributed to the person/i.test(msg)) {
    return { ok: false, message: "Sign in again to do that." };
  }
  return { ok: false, message: msg };
}

/** The pages an action can be taken from are both re-read. */
function refresh(reportId: string) {
  revalidatePath("/app");
  revalidatePath(`/app/report/${reportId}`);
}

/**
 * Wrong triage, fixed in one tap.
 *
 * The report goes to another department, its claim is dropped, and that
 * department is paged — all inside reroute_report. The 'reassigned' event it
 * writes is also the best signal the club has for tuning routing_rules: every
 * re-route is a rule that pointed at the wrong team.
 */
export async function rerouteAction(
  reportId: string,
  departmentId: string,
): Promise<ActionResult> {
  if (!departmentId) return { ok: false, message: "Pick a department." };

  // Under RLS this list is the caller's own club, so the name shown is never
  // one from elsewhere — and reroute_report refuses a foreign id regardless.
  const target = (await getDepartments()).find((d) => d.id === departmentId);
  if (!target) return { ok: false, message: "That department isn't at this club." };

  try {
    await callFn("reroute_report", {
      p_report_id: reportId,
      p_actor: await currentStaffId(),
      p_department_id: departmentId,
    });
  } catch (e) {
    return refusal(e);
  }

  refresh(reportId);
  return { ok: true, message: `Sent to ${target.name}` };
}

/**
 * Closed with nothing done, and the reason written down.
 *
 * A prank, a duplicate, or a report of something already fine is not "resolved"
 * — counting it as one would let a joke placard scan drag the club's
 * resolve-time median down. closed_no_action keeps it out of that number.
 */
export async function closeAction(
  reportId: string,
  reason: string,
): Promise<ActionResult> {
  if (!isCloseReason(reason)) return { ok: false, message: "Pick a reason." };

  try {
    await callFn("close_no_action", {
      p_report_id: reportId,
      p_actor: await currentStaffId(),
      p_reason: reason,
    });
  } catch (e) {
    return refusal(e);
  }

  refresh(reportId);
  return { ok: true, message: `Closed — ${CLOSE_REASONS[reason]}` };
}

/** "I'm on it now": the report is in progress, and claimed by whoever said so. */
export async function startAction(reportId: string): Promise<ActionResult> {
  try {
    await callFn("start_report", {
      p_report_id: reportId,
      p_actor: await currentStaffId(),
    });
  } catch (e) {
    return refusal(e);
  }

  refresh(reportId);
  return { ok: true, message: "Started" };
}
