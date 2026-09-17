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
  // An order the kitchen could not fill. Closing it 'resolved' would count a
  // member who got nothing as a member who was served (20260917100000).
  cannot_fulfil: "Couldn't fulfil it",
} as const;

export type CloseReason = keyof typeof CLOSE_REASONS;

export function isCloseReason(v: unknown): v is CloseReason {
  return typeof v === "string" && v in CLOSE_REASONS;
}

/**
 * The reasons worth offering for one kind of thing.
 *
 * "Not a real issue" is meaningless about a hot dog, and "Couldn't fulfil it"
 * is meaningless about a broken sprinkler. Both stay valid in the database —
 * this only decides which pills a person is shown.
 */
export function closeReasonsFor(kind: string | undefined): CloseReason[] {
  return kind === "order"
    ? ["cannot_fulfil", "duplicate"]
    : ["invalid", "duplicate", "no_action_needed"];
}
