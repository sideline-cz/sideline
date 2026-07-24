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
