/**
 * Why a report was closed without anyone doing anything.
 *
 * Mirrors the `close_reason` enum in 20260903120100_reports.sql. Shared by the
 * server action that validates a reason and the client that offers them, so
 * the pills a person can press and the values the database accepts cannot
 * drift apart. A plain module on purpose: a "use server" file may only export
 * async functions, and the client component has to import this too.
 */
export const CLOSE_REASONS = {
  invalid: "Not a real issue",
  duplicate: "Duplicate",
  no_action_needed: "Nothing to do",
} as const;

export type CloseReason = keyof typeof CLOSE_REASONS;

export function isCloseReason(v: unknown): v is CloseReason {
  return typeof v === "string" && v in CLOSE_REASONS;
}
