import type { User } from '@sideline/domain';
import { Option } from 'effect';
import { isAttendingRsvpResponse } from '~/utils/rsvpAttendance.js';

// The ONE place the attendance rule meets gender. Three callers fold through this —
// `api/event-rsvp.ts` (web event page), `rpc/event/index.ts` and `rpc/guild/index.ts` (both
// Discord card producers) — so a fourth RSVP response can never pick up a different rule on
// one surface and not the others. The SQL that feeds it is deliberately raw and unbucketed;
// `isAttendingRsvpResponse` below is the only definition of "going" in this path.
//
// Line comments, not JSDoc: the barrel codegen hoists a file's first doc block onto its
// `export * as` re-export.

// `event_id` is a plain string, not the branded `Event.EventId`: a brand is compile-time
// only, Map keys are strings at runtime, and the two producers read `event_id` off raw
// inline query schemas that never brand it. Branded ids are assignable to `string`, so the
// web caller passes its `Event.EventId` straight through.
export interface AttendingGenderCountRow {
  readonly event_id: string;
  readonly response: string;
  readonly gender: Option.Option<User.Gender>;
  readonly count: number;
}

const emptyCounts = (): User.GenderCounts => ({ male: 0, female: 0, other: 0, unknown: 0 });

// `users.gender` is NULLABLE and in production NULL is the largest bucket (46% of active
// members on the reference team), so a missing gender is a real category — `unknown` — and
// never a dropped row.
const bucketOf = (gender: Option.Option<User.Gender>): keyof User.GenderCounts =>
  Option.getOrElse(gender, () => 'unknown' as const);

export const foldAttendingGenderCounts = (
  rows: ReadonlyArray<AttendingGenderCountRow>,
): Map<string, User.GenderCounts> => {
  const byEvent = new Map<string, User.GenderCounts>();
  for (const row of rows) {
    if (!isAttendingRsvpResponse(row.response)) continue;
    const counts = byEvent.get(row.event_id) ?? emptyCounts();
    const bucket = bucketOf(row.gender);
    byEvent.set(row.event_id, { ...counts, [bucket]: counts[bucket] + row.count });
  }
  return byEvent;
};

// Events with no attending RSVPs are absent from the fold's map rather than present with four
// zeroes. Callers render nothing in that case, so the distinction never reaches a user — but
// `Option.none()` keeps "nobody is going" and "everybody going has an unknown gender" from
// collapsing into the same payload.
export const attendingGenderCountsFor = (
  byEvent: Map<string, User.GenderCounts>,
  eventId: string,
): Option.Option<User.GenderCounts> => Option.fromNullishOr(byEvent.get(eventId));
