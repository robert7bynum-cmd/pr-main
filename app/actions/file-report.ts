"use server";

import { revalidatePath } from "next/cache";
import { callFn } from "@/lib/queue/actions-db";

/**
 * A staff member filing a report themselves.
 *
 * Goes through the file_report RPC, which takes the filer from the session —
 * never from this form — and commits the report and its triage_queue row in
 * one transaction, exactly as the member path does. From the row down the two
 * are the same report: triage, routing, escalation and push do not know which
 * door it came in by.
 */
export interface FileResult {
  ok: boolean;
  error?: string;
  reportId?: string;
}

export async function fileReport(formData: FormData): Promise<FileResult> {
  const locationId = String(formData.get("locationId") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const byPhone = formData.get("byPhone") === "on";
  const name = String(formData.get("name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();

  if (!locationId) return { ok: false, error: "Pick where the problem is." };
  if (body.length < 3) return { ok: false, error: "Please describe the issue." };

  try {
    const row = await callFn("file_report", {
      p_location_id: locationId,
      p_body: body,
      p_source: byPhone ? "phone_relay" : "staff",
      p_reporter_name: byPhone && name ? name : null,
      p_reporter_phone: byPhone && phone ? phone : null,
    });

    // PostgREST hands a scalar-returning function back as the bare value; the
    // dev path's `select * from file_report(...)` hands back a one-column row.
    const reportId =
      typeof row === "string" ? row : ((row?.file_report as string | undefined) ?? null);
    if (!reportId) {
      return { ok: false, error: "The report was not saved. Please try again." };
    }

    revalidatePath("/app");
    return { ok: true, reportId };
  } catch (e) {
    // The RPC raises plain-language messages for everything a person can
    // cause (empty body, a location not at their club); anything else is ours.
    return { ok: false, error: (e as Error).message || "Something went wrong. Please try again." };
  }
}
