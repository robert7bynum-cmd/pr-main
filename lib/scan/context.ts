import "server-only";

/**
 * Resolving a placard token to its club and location.
 *
 * Talks to the get_scan_context RPC when Supabase is configured. Until the
 * project exists, it falls back to a local fixture so the member-facing page
 * can be built and reviewed. The fallback is dev-only and refuses to run in
 * production, so a misconfigured deploy fails loudly instead of quietly
 * serving fake club data to a real member.
 */
export interface ScanContext {
  /** Single-use token for this scan; submitting consumes it. */
  nonce: string;
  courseId: string;
  courseName: string;
  courseSlug: string;
  locationId: string;
  locationName: string;
  holeNumber: number | null;
  branding: Branding;
}

import { DEFAULT_BRANDING, type Branding } from "@/lib/branding";

export type { Branding };

function fallback(token: string): ScanContext | null {
  if (process.env.NODE_ENV === "production") return null;

  // Mirrors the tokens in supabase/seed.sql: bh-h01..bh-h18 plus facilities.
  const hole = /^bh-h(\d{2})$/.exec(token);
  const facilities: Record<string, string> = {
    "bh-range": "Practice Range",
    "bh-clubhouse": "Clubhouse",
    "bh-cartbarn": "Cart Barn",
    "bh-halfway": "Halfway House",
    "bh-restroom-6": "Restroom — Hole 6",
    "bh-restroom-13": "Restroom — Hole 13",
  };

  let locationName: string;
  let holeNumber: number | null = null;

  if (hole) {
    holeNumber = Number(hole[1]);
    locationName = `Hole ${holeNumber}`;
  } else if (facilities[token]) {
    locationName = facilities[token];
  } else {
    return null;
  }

  return {
    nonce: "dev-nonce",
    courseId: "demo",
    courseName: "Beacon Hill Golf Club",
    courseSlug: "beacon-hill",
    locationId: `demo-${token}`,
    locationName,
    holeNumber,
    branding: DEFAULT_BRANDING,
  };
}

export async function getScanContext(token: string): Promise<ScanContext | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return fallback(token);

  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const [{ data, error }, { data: nonce, error: nonceError }] = await Promise.all([
    supabase.rpc("get_scan_context", { p_token: token }),
    supabase.rpc("issue_scan_nonce", { p_token: token }),
  ]);

  if (error || !data?.length || nonceError || !nonce) return null;

  const row = data[0];
  const branding = (row.settings?.branding ?? {}) as Partial<Branding>;

  return {
    nonce: nonce as string,
    courseId: row.course_id,
    courseName: row.course_name,
    courseSlug: row.course_slug,
    locationId: row.location_id,
    locationName: row.location_name,
    holeNumber: row.hole_number,
    branding: { ...DEFAULT_BRANDING, ...branding },
  };
}
