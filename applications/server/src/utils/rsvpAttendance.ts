/**
 * A response counts as full attendance for roster provisioning / auto-approve backfill
 * purposes: `'yes'`, the newer `'coming_later'` (full attendance with an expected-late note),
 * and the legacy `'maybe'` value.
 */
export const isAttendingRsvpResponse = (response: string): boolean =>
  response === 'yes' || response === 'coming_later' || response === 'maybe';
