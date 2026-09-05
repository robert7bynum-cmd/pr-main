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
  error?: string;
}

export async function submitReport(formData: FormData): Promise<SubmitResult> {
  const token = String(formData.get("token") ?? "");
  const nonce = String(formData.get("nonce") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const memberNo = String(formData.get("memberNo") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();

  if (body.length < 3) {
    return { ok: false, error: "Please describe the issue." };
  }

  // Until Supabase exists, accept the submission so the flow is reviewable.
  // Never in production — a member's report must not vanish into a no-op.
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    if (process.env.NODE_ENV === "production") {
      return { ok: false, error: "Reporting is temporarily unavailable." };
    }
    return { ok: true };
  }

  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();

  const send = (n: string) =>
    supabase.rpc("submit_report", {
      p_token: token,
      p_nonce: n,
      p_body: body,
      p_name: name || null,
      p_phone: phone || null,
      p_email: email || null,
      p_member_no: memberNo || null,
      p_language: "en",
    });

  let { error } = await send(nonce);

  // A nonce goes stale after two hours and is consumed on first use. A phone
  // that slept with the form open, a bfcache restore, or a second tap on send
  // therefore arrives holding a dead nonce — and the member loses everything
  // they typed to a message telling them to go scan the placard again.
  //
  // That is the wrong trade. The nonce exists to stop someone scripting the
  // endpoint off a photographed placard, and the control that actually does
  // that work is the per-placard rate limit inside issue_scan_nonce. Minting a
  // fresh nonce here runs that same limiter and the same active-placard check,
  // so re-issuing once costs nothing in safety and turns a lost report into a
  // filed one. Exactly one retry: if the fresh nonce fails too, the cause is
  // not staleness and the real error belongs in front of the member.
  if (error && isStaleNonce(error.message)) {
    const { data: fresh, error: mintError } = await supabase.rpc("issue_scan_nonce", {
      p_token: token,
    });
    if (mintError || !fresh) {
      return {
        ok: false,
        error: mintError?.message || "Something went wrong. Please try again.",
      };
    }
    ({ error } = await send(fresh as string));
  }

  if (error) {
    // The RPC raises friendly messages for the cases a member can cause
    // (empty body, dead placard, flood control); anything else is ours.
    return { ok: false, error: error.message || "Something went wrong. Please try again." };
  }

  return { ok: true };
}

/**
 * Matches the message submit_report raises when the nonce is missing, already
 * consumed, or older than two hours. Matching on text is brittle, so the RPC
 * and this string are changed together — the test in scripts/test-nonce.mts
 * fails if they drift apart.
 */
function isStaleNonce(message: string | undefined): boolean {
  return Boolean(message && message.includes("This form has expired"));
}
