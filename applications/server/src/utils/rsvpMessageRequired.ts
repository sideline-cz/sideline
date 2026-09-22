import type { EventRsvp } from '@sideline/domain';
import { Option } from 'effect';

/**
 * `coming_later` is a full-attendance response that REQUIRES a non-empty comment (so
 * teammates know when to expect the player). The upsert itself does
 * `COALESCE(${message}, event_rsvps.message)`, so an existing note is preserved when the
 * caller submits `message: null` again (e.g. an idempotent button re-click) — the guard
 * must evaluate the *effective* (post-COALESCE) value, not just the submitted one.
 *
 * Rejects iff `response === 'coming_later'` AND the effective stored message would be blank:
 * - `clearMessage` explicitly requests clearing the message, OR
 * - the submitted message is blank/absent AND there is no prior non-blank message to fall back to.
 */
export const isRsvpMessageRequiredAndMissing = (
  response: EventRsvp.RsvpResponse,
  clearMessage: boolean,
  submittedMessage: Option.Option<string>,
  priorMessage: Option.Option<string>,
): boolean => {
  if (response !== 'coming_later') return false;
  if (clearMessage) return true;

  const submitted = Option.filter(submittedMessage, (message) => message.trim().length > 0);
  const effective = Option.isSome(submitted) ? submitted : priorMessage;
  return Option.isNone(effective);
};

/**
 * The mirror of the guard above, for the opposite transition. A `coming_later` note is
 * MANDATORY and answers "when will you arrive", so it must not survive the member leaving
 * that response — carrying it over renders nonsense like `Nevím 💬 dorazím v 19:00`.
 *
 * The upsert's `COALESCE(${message}, event_rsvps.message)` preserves the old note whenever a
 * caller submits no message, which is exactly what the bot does on an instant-submit button.
 * So the clearing has to be derived server-side rather than left to each client: returns true
 * iff the member is leaving `coming_later` and supplied no replacement note.
 *
 * Both write surfaces MUST route through this — `Event/SubmitRsvp` (RPC) and `submitRsvp`
 * (HTTP) — or the two disagree for the same transition depending on which client made it.
 */
export const isLeavingComingLaterWithoutNewMessage = (
  response: EventRsvp.RsvpResponse,
  submittedMessage: Option.Option<string>,
  priorResponse: Option.Option<EventRsvp.RsvpResponse>,
): boolean =>
  response !== 'coming_later' &&
  Option.isNone(Option.filter(submittedMessage, (message) => message.trim().length > 0)) &&
  Option.contains(priorResponse, 'coming_later');
