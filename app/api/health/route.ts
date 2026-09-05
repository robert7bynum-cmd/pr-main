import { createAdminClient } from "@/lib/supabase/admin";
import { deploymentRef } from "@/lib/deployment";

/**
 * What is this deployment, and can it reach its database?
 *
 * With a preview per branch there is now more than one running copy of this
 * app, and the question "which one am I looking at, and which database is it
 * pointed at" stops being obvious. Opening the app cannot answer it: a preview
 * wired to nothing looks like a preview wired to production right up until a
 * page fails to load.
 *
 * Returns configuration and reachability only — no secrets, and no row data.
 * The Supabase host it names is already in the client bundle.
 */
export const dynamic = "force-dynamic";

async function pushConfigured(): Promise<boolean> {
  if (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim()) return true;
  if (process.env.VAPID_PUBLIC_KEY?.trim()) return true;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return false;
  try {
    const { data } = await createAdminClient()
      .from("app_settings").select("value").eq("key", "vapid_public_key").maybeSingle();
    return Boolean(data?.value?.trim());
  } catch {
    return false;
  }
}

export async function GET() {
  const ref = deploymentRef();

  // A HEAD count: proves the credentials work and the database answers,
  // without reading anybody's data.
  let database: "ok" | "unreachable" | "not-configured" = "not-configured";
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { error } = await createAdminClient()
        .from("courses")
        .select("id", { head: true, count: "exact" });
      database = error ? "unreachable" : "ok";
    } catch {
      database = "unreachable";
    }
  }

  const body = {
    ...ref,
    database,
    // Which project, not which key. The host is public either way.
    supabase: process.env.NEXT_PUBLIC_SUPABASE_URL
      ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host
      : null,
    // Both are preview-shaped footguns, so say plainly whether they are on.
    // One-click demo sign-in was removed outright rather than switched off.
    // An environment variable that turns anyone with the URL into staff is a
    // thing somebody flips back on; deleted code is not.
    demoSignIn: false,
    // Whether a browser can actually subscribe, which is no longer the same
    // question as "is the build variable set" — the key is read from
    // app_settings now, so reporting the variable would have said "no" while
    // push worked perfectly well.
    push: await pushConfigured(),
    /**
     * pg_cron calls one fixed URL held in app_settings, so triage and
     * escalation only ever run against whichever deployment that names —
     * never against a preview. Said here because a preview that quietly
     * routes nothing is indistinguishable from one that works.
     */
    scheduledWork: ref.env === "production" ? "if app_settings.worker_url points here" : "no — cron never targets a preview",
  };

  return Response.json(body, {
    status: database === "unreachable" ? 503 : 200,
    headers: { "cache-control": "no-store" },
  });
}
