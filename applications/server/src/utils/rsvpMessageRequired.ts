import { EventRsvp } from '@sideline/domain';
import { Option } from 'effect';

/**
 * `coming_later` and `maybe` both REQUIRE a non-empty comment — see
 * `EventRsvp.rsvpResponseRequiresMessage` for which responses and why. The upsert itself does
 * `COALESCE(${message}, event_rsvps.message)`, so an existing note is preserved when the
 * caller submits `message: null` again (e.g. an idempotent button re-click) — the guard
 * must evaluate the *effective* (post-COALESCE) value, not just the submitted one.
 *
 * Rejects iff the response requires a note AND the effective stored message would be blank:
 * - `clearMessage` explicitly requests clearing the message, OR
 * - the submitted message is blank/absent AND there is no prior non-blank message to fall back to.
 *
 * ⚠ Pass the EFFECTIVE clear flag (see `isLeavingRequiredNoteResponse` below), not the raw one
 * submitted by the client. The two used to be interchangeable here because only `coming_later`
 * required a note, so the clearing rule could only ever fire for a response this guard ignored.
 * Now that `maybe` requires one too they overlap: `coming_later` → `maybe` with no new message
 * clears the old note AND lands on a response that demands one, so a guard reading the raw flag
 * would wave through a `maybe` row with `message = NULL`.
 */
export const isRsvpMessageRequiredAndMissing = (
  response: EventRsvp.RsvpResponse,
  clearMessage: boolean,
  submittedMessage: Option.Option<string>,
  priorMessage: Option.Option<string>,
): boolean => {
  if (!EventRsvp.rsvpResponseRequiresMessage(response)) return false;
  if (clearMessage) return true;

  const submitted = Option.filter(submittedMessage, (message) => message.trim().length > 0);
  const effective = Option.isSome(submitted) ? submitted : priorMessage;
  return Option.isNone(effective);
};

/**
 * A mandatory note answers a question specific to the response it was written for — "when will
 * you arrive" for `coming_later`, "what does it depend on" for `maybe`. It must not survive the
 * member moving to a DIFFERENT response: carrying it over renders nonsense like
 * `Nevím 💬 dorazím v 19:00`.
 *
 * The upsert's `COALESCE(${message}, event_rsvps.message)` preserves the old note whenever a
 * caller submits no message, which is exactly what the bot does on an instant-submit button. So
 * the clearing is derived server-side rather than left to each client: returns true iff the
 * member is leaving a note-requiring response for a different one without supplying a
 * replacement.
 *
 * Both write surfaces MUST route through this — `Event/SubmitRsvp` (RPC) and `submitRsvp`
 * (HTTP) — or the two disagree for the same transition depending on which client made it. Feed
 * the result into `isRsvpMessageRequiredAndMissing` above, so that switching between two
 * note-requiring responses without a new note is rejected rather than silently blanked.
 */
export const isLeavingRequiredNoteResponse = (
  response: EventRsvp.RsvpResponse,
  submittedMessage: Option.Option<string>,
  priorResponse: Option.Option<EventRsvp.RsvpResponse>,
): boolean =>
  Option.isNone(Option.filter(submittedMessage, (message) => message.trim().length > 0)) &&
  Option.isSome(
    Option.filter(
      priorResponse,
      (prior) => prior !== response && EventRsvp.rsvpResponseRequiresMessage(prior),
    ),
  );
