import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { classifyReport } from "./classify";

/**
 * The triage worker.
 *
 * Deliberately thin: claiming, routing, recipient resolution, idempotency and
 * backoff all live in SQL (see 20260904090000_routing.sql) where they are one
 * transaction and are covered by scripts/test-routing.mts. This function's only
 * real job is classification, which is the part that cannot be done in the
 * database.
 *
 * Two callers, same code path:
 *   - the DB webhook, fired on insert — the fast path, ~1s
 *   - the pg_cron sweeper, every 30-60s — the guarantee
 * Both are safe to run concurrently: claim_triage_batch uses SKIP LOCKED, and
 * route_report is idempotent on report_id.
 */
export interface TriageRunResult {
  claimed: number;
  routed: number;
  failed: number;
  unstaffed: number;
}

export async function runTriage(limit = 10): Promise<TriageRunResult> {
  const db = createAdminClient();
  const result: TriageRunResult = { claimed: 0, routed: 0, failed: 0, unstaffed: 0 };

  const { data: batch, error: claimError } = await db.rpc("claim_triage_batch", {
    p_limit: limit,
  });
  if (claimError) throw new Error(`claim failed: ${claimError.message}`);

  const items = (batch ?? []) as { report_id: string; body: string }[];
  result.claimed = items.length;

  for (const item of items) {
    try {
      const c = await classifyReport(item.body);

      const { data, error } = await db.rpc("route_report", {
        p_report_id: item.report_id,
        p_category: c.category,
        p_urgency: c.urgency,
        p_summary: c.summary,
        p_confidence: c.confidence,
        p_source: c.source,
      });
      if (error) throw new Error(error.message);

      const row = (data as { reason: string }[] | null)?.[0];
      result.routed++;
      if (row?.reason === "unstaffed_all_leadership") result.unstaffed++;
    } catch (err) {
      // Hand the item back for retry with backoff. After five attempts it parks
      // in dead_letter — visible and alertable, rather than silently gone.
      result.failed++;
      await db.rpc("fail_triage", {
        p_report_id: item.report_id,
        p_error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
