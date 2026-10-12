import * as m from '@sideline/i18n/messages';
import { DateTime } from 'effect';
import type { Locale } from '~/locale.js';

/**
 * How far before an event's start its RSVPs lock, as display copy — "(3 h before start)".
 *
 * Derived from the two instants the card already carries rather than from a new wire field:
 * `rsvp_closes_at` is exactly `start_at - rsvp_lock_hours_before` (see
 * `server/src/utils/allDayRsvpWindow.ts#rsvpClosesAtOf`), so the offset is recoverable without
 * the server sending the hours a second time.
 *
 * This answers a DIFFERENT question from the `R`-style timestamp beside it. That one is
 * relative to the viewer's now and changes as the deadline approaches ("in 2 days" → "20 hours
 * ago"); this is a property of the team's settings and is the same for everyone, always. It is
 * the thing a member cannot otherwise learn from the card: whether they are looking at a team
 * that closes RSVPs a day ahead or one that takes them until kickoff.
 *
 * Whole days once the offset is a clean multiple of 24 — the configurable range tops out at
 * 336 hours, and "168 h before start" is a worse way to say one week. A non-multiple (36 h)
 * stays in hours rather than rounding, because a wrong deadline is worse than a long one.
 *
 * The unit abbreviations dodge Czech plural agreement (1 hodina / 2 hodiny / 5 hodin), which
 * would otherwise need plural-form machinery for a parenthetical.
 */
export const formatRsvpLockOffset = (
  startAt: DateTime.Utc,
  closesAt: DateTime.Utc,
  locale: Locale,
): string => {
  const hours = Math.round(
    (DateTime.toEpochMillis(startAt) - DateTime.toEpochMillis(closesAt)) / 3_600_000,
  );

  // Non-positive covers both `rsvp_lock_hours_before = 0` and the unreachable-but-cheap case of
  // a deadline at or after start. Either way there is no lead time to report.
  if (hours <= 0) return m.bot_embed_rsvp_lock_offset_at_start({}, { locale });

  return hours % 24 === 0
    ? m.bot_embed_rsvp_lock_offset_days({ days: String(hours / 24) }, { locale })
    : m.bot_embed_rsvp_lock_offset_hours({ hours: String(hours) }, { locale });
};
