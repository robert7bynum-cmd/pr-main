"use server";

import { isLang, t, type Lang } from "@/lib/i18n/member";
import { isMemberNoNeeded } from "@/lib/queue/member-number";

/**
 * A member ordering food and drink from where they are standing.
 *
 * The second and last write a member is allowed to make. Goes through the
 * submit_order RPC, which validates the placard, consumes the scan nonce,
 * refuses without a member number, and — because the member already said what
 * this is — routes it to the food and beverage team inside the same
 * transaction rather than leaving it for the classifier.
 *
 * Deliberately not a variant of submitReport: an order and a fault are
 * different things to say, and folding them into one action with a flag is how
 * the member's screen ends up asking "what did you notice?" about a hot dog.
 */
export interface OrderResult {
  ok: boolean;
  error?: string;
  /** No member number was given; the field is marked and focused. */
  needsMemberNo?: boolean;
}

export async function submitOrder(formData: FormData): Promise<OrderResult> {
  const token = String(formData.get("token") ?? "");
  const nonce = String(formData.get("nonce") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  const memberNo = String(formData.get("memberNo") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const rawLang = formData.get("language");
  const language: Lang = isLang(rawLang) ? rawLang : "en";
  const s = t(language);

  // Both checked here as well as in the RPC: the member should not lose a
  // round trip to learn they left the number blank, and the RPC must still
  // refuse for anything that does not come through this form.
  if (body.length < 3) return { ok: false, error: s.errorOrderBody };
  if (!memberNo) return { ok: false, error: s.errorOrderMemberNo, needsMemberNo: true };

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    if (process.env.NODE_ENV === "production") {
      return { ok: false, error: "Ordering is temporarily unavailable." };
    }
    return { ok: true };
  }

  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();

  const send = (n: string) =>
    supabase.rpc("submit_order", {
      p_token: token,
      p_nonce: n,
      p_body: body,
      p_member_no: memberNo,
      p_name: name || null,
      p_phone: phone || null,
      p_language: language,
    });

  let { error } = await send(nonce);

  // Same staleness recovery as a report, and for the same reason: a phone that
  // slept with the order half-typed must not lose it. issue_scan_nonce runs
  // the same placard checks and the same per-placard limiter, so re-issuing
  // once costs nothing in safety. Exactly one retry.
  if (error && error.message?.includes("This form has expired")) {
    const { data: fresh, error: mintError } = await supabase.rpc("issue_scan_nonce", {
      p_token: token,
    });
    if (mintError || !fresh) {
      return { ok: false, error: mintError?.message || s.errorFallback };
    }
    ({ error } = await send(fresh as string));
  }

  if (error) {
    if (isMemberNoNeeded(error.message)) {
      return { ok: false, error: s.errorOrderMemberNo, needsMemberNo: true };
    }
    // The RPC raises plain-language messages for everything a member can
    // cause — an empty order, a dead placard, flood control, a club that has
    // closed ordering, and nobody on duty to take it.
    return { ok: false, error: error.message || s.errorFallback };
  }

  return { ok: true };
}
