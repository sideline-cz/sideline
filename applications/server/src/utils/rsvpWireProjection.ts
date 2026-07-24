import type { EventRsvp } from '@sideline/domain';

/**
 * Projects a stored `RsvpResponse` (which may be the new `'coming_later'` full-attendance
 * value) onto the legacy 3-value wire vocabulary (`'yes' | 'no' | 'maybe'`).
 *
 * Several RPC read DTOs (`RsvpAttendeeEntry.response`, `UpcomingEventForUserEntry.my_response`)
 * are intentionally still restricted to the legacy 3 literals so that already-deployed
 * web/bot clients — bundling the previous schema — never decode an unrecognized value.
 * `coming_later` is full attendance, but on these legacy read surfaces it must present as
 * `'maybe'` this release.
 */
export const projectRsvpResponseToLegacy = (
  response: EventRsvp.RsvpResponse,
): 'yes' | 'no' | 'maybe' => (response === 'coming_later' ? 'maybe' : response);
