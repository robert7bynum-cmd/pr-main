/**
 * The one message the database raises when a report needs a member number and
 * has none. Raised by submit_report, file_report, record_member_no and
 * resolve_report (20260906180000); matched here by the member form and the
 * staff actions so each can say it in its own words. Matching on text is
 * brittle, so scripts/test-nonce.mts holds the migration to this string.
 */
export const MEMBER_NO_NEEDED = "A member number is needed for this request.";

export function isMemberNoNeeded(message: string | undefined | null): boolean {
  return Boolean(message && message.includes(MEMBER_NO_NEEDED));
}
