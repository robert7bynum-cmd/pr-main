"use server";

import { redirect } from "next/navigation";
import { createClient as createServer } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * One-click sign-in for the demo personas.
 *
 * Issues an ordinary Supabase session — it generates a magic-link token
 * server-side and verifies it immediately, so there is no email round-trip and
 * no password anywhere. The app itself has no special demo path; these are
 * normal users with normal RLS.
 *
 * Gated by DEMO_SIGNIN. Leave it unset and this refuses, so the button cannot
 * become a way into a real club's data.
 */
export async function demoSignIn(email: string) {
  if (process.env.DEMO_SIGNIN !== "true") {
    throw new Error("demo sign-in is disabled");
  }

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (error || !data.properties?.hashed_token) {
    throw new Error(error?.message ?? "could not generate a demo session");
  }

  const supabase = await createServer();
  const { error: verifyError } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: data.properties.hashed_token,
  });
  if (verifyError) throw new Error(verifyError.message);

  await supabase.rpc("claim_profile");
  redirect("/app");
}

export async function demoEnabled() {
  return process.env.DEMO_SIGNIN === "true";
}
