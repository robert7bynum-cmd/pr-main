import "server-only";

import { callFn } from "@/lib/queue/actions-db";

/**
 * What a club still has to do before it can actually receive a report.
 *
 * The answer comes from `club_readiness()`, a single database function, so
 * there is one implementation rather than the two this module's neighbours
 * carry (one for the offline harness, one for Supabase). The checklist cannot
 * be marked complete while the club is still unreachable, because it reads
 * live state instead of a flag.
 */
export interface ClubReadiness {
  hasTeam: boolean;
  canBeAlerted: boolean;
  hasSignAddress: boolean;
  staffCount: number;
  reachableCount: number;
  locationCount: number;
  /** True when every step is done; the checklist hides itself. */
  ready: boolean;
}

export async function getClubReadiness(): Promise<ClubReadiness | null> {
  // Null when the function is not there yet. Code deploys the moment main
  // moves; migrations are applied separately, so for a window the two
  // disagree — and the staff queue must not break over a checklist. Null
  // hides it, which is the right answer for an established club anyway.
  let row: Record<string, unknown> | null = null;
  try {
    row = (await callFn("club_readiness", {})) as Record<string, unknown> | null;
  } catch {
    return null;
  }
  if (!row) return null;

  const r: ClubReadiness = {
    hasTeam: row.has_team === true,
    canBeAlerted: row.can_be_alerted === true,
    hasSignAddress: row.has_sign_address === true,
    staffCount: Number(row.staff_count ?? 0),
    reachableCount: Number(row.reachable_count ?? 0),
    locationCount: Number(row.location_count ?? 0),
    ready: false,
  };
  r.ready = r.hasTeam && r.canBeAlerted && r.hasSignAddress;
  return r;
}
