"use server";

/**
 * The one write a member is allowed to make.
 *
 * Goes through the submit_report RPC, which validates the placard token,
 * rate-limits, and commits the report and its triage_queue row in a single
 * transaction. Anonymous callers have no table privileges at all, so this
 * function is the entire member-facing surface area of the database.
 */
export interface SubmitResult {
  ok: boolean;
  trackingToken?: string;
  error?: string;
}

export async function submitReport(formData: FormData): Promise<SubmitResult> {
  const token = String(formData.get("token") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const memberNo = String(formData.get("memberNo") ?? "").trim();
  const smsOptIn = formData.get("smsOptIn") === "on";

  if (body.length < 3) {
    return { ok: false, error: "Please describe the issue." };
  }

  // Until Supabase exists, accept the submission so the flow is reviewable.
  // Never in production — a member's report must not vanish into a no-op.
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    if (process.env.NODE_ENV === "production") {
      return { ok: false, error: "Reporting is temporarily unavailable." };
    }
    return { ok: true, trackingToken: "dev-preview" };
  }

  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("submit_report", {
    p_token: token,
    p_body: body,
    p_name: name || null,
    p_phone: phone || null,
    p_member_no: memberNo || null,
    p_sms_opt_in: smsOptIn,
    p_language: "en",
  });

  if (error) {
    // The RPC raises friendly messages for the cases a member can cause
    // (empty body, dead placard, flood control); anything else is ours.
    return { ok: false, error: error.message || "Something went wrong. Please try again." };
  }

  return { ok: true, trackingToken: data?.[0]?.tracking_token };
}
