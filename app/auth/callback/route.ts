import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Magic-link landing. Exchanges the code for a session, then claims the staff
 * profile their club created for them.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  if (!code) return NextResponse.redirect(`${origin}/login?error=1`);

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(`${origin}/login?error=1`);

  // Links this auth user to the profile their manager created. A signed-in
  // stranger with no invitation simply gets no profile, and RLS shows them
  // nothing — rather than an error that tells them the club exists.
  await supabase.rpc("claim_profile");

  return NextResponse.redirect(`${origin}/app`);
}
