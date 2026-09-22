/**
 * A response counts as full attendance for roster provisioning / auto-approve backfill
 * purposes: `'yes'`, and `'coming_later'` (full attendance with an expected-late note).
 * `'maybe'` is now the "Nevím" ("Not sure") response — explicitly NOT attendance.
 */
export const isAttendingRsvpResponse = (response: string): boolean =>
  response === 'yes' || response === 'coming_later';
