import type { Event } from '@sideline/domain';
import { DateTime, Option } from 'effect';

/**
 * R1: an all-day event is RSVP-able through the end of its last day in the
 * team's timezone, even though its `status` flips to `'started'` at team-local
 * midnight (the anchor move, plan §10/§12). This module MUST stay in lock-step
 * with `eventVisibleNow`/`eventVisibleAt` in `repositories/eventVisibility.ts`
 * — if the two disagree the bot renders live RSVP buttons that error on every
 * press (BL1), or a read surface hides an event the write path would still
 * accept.
 *
 * **Boundary and clock caveat.** The SQL predicate is `start_at >= now()`; the
 * timed branch below therefore uses `DateTime.isLessThanOrEqualTo(now,
 * start_at)`, not a strict `isLessThan` — at the exact instant `now ==
 * start_at` a timed event is still RSVP-able, matching the read path. The SQL
 * reads the DATABASE clock (`now()`); this module reads the APPLICATION clock
 * (`DateTime.nowUnsafe()` at the call site). They cannot be made identical —
 * at a sub-second boundary the two may disagree for the duration of clock
 * skew. Acceptable: the consequence is one rejected RSVP with a correct error
 * message, retried by a second click.
 *
 * **The lock-step requirement covers `eventAcceptsRsvp` ONLY.** The configurable
 * RSVP deadline added `eventRsvpOpen`/`rsvpClosesAtOf` at the bottom of this
 * module, and they deliberately have NO SQL twin anywhere: a locked event is
 * still VISIBLE, so `eventVisibleNow` and friends stay byte-identical. That is
 * safe in the only direction that matters because `eventRsvpOpen` is
 * `eventAcceptsRsvp && …` — strictly narrower, never wider, on either branch.
 * SQL resolves only WHICH lock number applies (`repositories/lockResolution.ts`);
 * every comparison against `now` lives in this module.
 *
 * The filename now undersells the module — it holds the general RSVP gate, not
 * just the all-day window. Left alone: a rename is churn across six importers.
 */

/**
 * The instant at which this all-day event's last LOCAL day is fully over:
 * local midnight of `end_at`'s (or `start_at`'s, if no `end_at`) calendar
 * date, plus one local day — the TypeScript twin of
 * `eventVisibility.ts#eventEndOfLastLocalDay`.
 *
 * An invalid `team_settings.timezone` must not reach `setZoneNamedUnsafe`
 * unguarded — `DateTime.setZoneNamed` returns `Option.none()` for an invalid
 * IANA id, and `setZoneNamedUnsafe` throws `IllegalArgumentError` (a defect,
 * not a typed failure) if called directly on bad input. `team_settings.timezone`
 * is free-form `TEXT`, so an invalid value is reachable — fall back explicitly
 * to `'Europe/Prague'`, the same literal the SQL `COALESCE` and the column
 * default use, so the two halves still agree on the fallback.
 */
export const endOfLastLocalDay = (
  event: {
    readonly start_at: DateTime.Utc;
    readonly end_at: Option.Option<DateTime.Utc>;
  },
  timezone: string,
): DateTime.Zoned => {
  const base = Option.getOrElse(event.end_at, () => event.start_at);
  const zoned = Option.getOrElse(DateTime.setZoneNamed(base, timezone), () =>
    DateTime.setZoneNamedUnsafe(base, 'Europe/Prague'),
  );
  return DateTime.add(zoned, { days: 1 });
};

/**
 * The all-day branch of the RSVP gate.
 *
 * **The status guard is mandatory.** Without `event.status === 'active' ||
 * event.status === 'started'`, a CANCELLED all-day event on its own local day
 * would start accepting RSVPs — exactly the TS/SQL drift this module exists
 * to prevent, because `eventVisibleNow`'s all-day branch also requires
 * `status IN ('active', 'started')`.
 */
export const allDayStillRsvpable = (
  event: {
    readonly all_day: boolean;
    readonly status: Event.EventStatus;
    readonly start_at: DateTime.Utc;
    readonly end_at: Option.Option<DateTime.Utc>;
  },
  timezone: string,
  now: DateTime.Utc,
): boolean =>
  // Truthy check, not `=== true`: `all_day` is a required, non-optional
  // `boolean` on the real DB-decoded `EventWithDetails`, but callers that
  // build a same-shaped object by hand (older RSVP fixtures predating PR 4)
  // may leave it `undefined`, which must read exactly as `false` — the
  // pre-PR-4, timed-event behaviour.
  !!event.all_day &&
  (event.status === 'active' || event.status === 'started') &&
  DateTime.isLessThan(now, endOfLastLocalDay(event, timezone));

/**
 * The full RSVP-acceptance gate. Replaces the previous
 * `status === 'active' && !isEventPastDeadline(start_at)` check at every call
 * site (plan §4.5): `rpc/event/index.ts` (`Event/GetRsvpCounts`'s `canRsvp`,
 * `Event/SubmitRsvp`) and `api/event-rsvp.ts` (`getRsvps`, `submitRsvp`, via
 * the former `isEventPastDeadline` helper, now folded in here).
 */
export const eventAcceptsRsvp = (
  event: {
    readonly all_day: boolean;
    readonly status: Event.EventStatus;
    readonly start_at: DateTime.Utc;
    readonly end_at: Option.Option<DateTime.Utc>;
  },
  timezone: string,
  now: DateTime.Utc,
): boolean =>
  (!event.all_day &&
    event.status === 'active' &&
    DateTime.isLessThanOrEqualTo(now, event.start_at)) ||
  allDayStillRsvpable(event, timezone, now);

/**
 * The instant RSVPs close, or `None` when this event has no lock configured.
 *
 * Pure ABSOLUTE arithmetic — no timezone, because `start_at` is already the
 * event's start on both branches (an all-day event's `start_at` is team-local
 * midnight of day 1 since the anchor move). A DST transition between
 * `closesAt` and `start_at` therefore does not move the deadline: "24 hours
 * before" means 24 hours, not "the same wall clock yesterday".
 *
 * Exported because FOUR surfaces render this instant (the web panel, the
 * Discord card, and both upcoming-events producers) while `eventRsvpOpen`
 * below enforces it. They must never disagree, so the subtraction exists
 * exactly once — here.
 *
 * `rsvp_lock_hours_before` is optional on the STRUCTURAL type but not on the
 * DB-decoded `EventWithDetails`: hand-built fixtures across the server suite
 * omit it, and `undefined` must read as `Option.none()`. The `?? Option.none()`
 * is load-bearing, not defensive styling — `Option.match(undefined, …)` throws.
 * Same reasoning as the `!!event.all_day` truthy check two functions up.
 */
export const rsvpClosesAtOf = (event: {
  readonly start_at: DateTime.Utc;
  readonly rsvp_lock_hours_before?: Option.Option<number>;
}): Option.Option<DateTime.Utc> =>
  Option.map(event.rsvp_lock_hours_before ?? Option.none(), (hours) =>
    DateTime.subtract(event.start_at, { hours }),
  );

/**
 * The RSVP gate for the FOUR RSVP sites: `api/event-rsvp.ts`'s `getRsvps` and
 * `submitRsvp`, and `rpc/event/index.ts`'s `Event/GetRsvpCounts` and
 * `Event/SubmitRsvp`.
 *
 * **The gate SPLITS here, deliberately.** The six edit/cancel sites in
 * `api/event.ts` (`canEdit`, `canCancel`, and the `updateEvent`/`cancelEvent`
 * write guards) keep calling `eventAcceptsRsvp` — folding the lock into that
 * shared function instead would make an event uneditable and uncancellable for
 * the whole lock window, so a captain could not cancel a rained-off match
 * three hours before kickoff. That failure has no type error and no other
 * failing test; `test/Event.test.ts`'s T3 block is what stands in front of it.
 *
 * Strictly NARROWER than `eventAcceptsRsvp` by construction (it is a
 * conjunction with it), so the lockstep requirement with `eventVisibility.ts`
 * that the module header states is preserved: a locked event stays VISIBLE,
 * and this gate can never be open where the visibility twin is shut. The
 * reverse — visible but locked — is precisely what this feature means, which
 * is why this half has NO SQL twin at any call site. SQL only ever resolves
 * WHICH number applies (`repositories/lockResolution.ts`); every comparison
 * against `now` happens here.
 */
export const eventRsvpOpen = (
  event: {
    readonly all_day: boolean;
    readonly status: Event.EventStatus;
    readonly start_at: DateTime.Utc;
    readonly end_at: Option.Option<DateTime.Utc>;
    readonly rsvp_lock_hours_before?: Option.Option<number>;
  },
  timezone: string,
  now: DateTime.Utc,
): boolean =>
  eventAcceptsRsvp(event, timezone, now) &&
  Option.match(rsvpClosesAtOf(event), {
    onNone: () => true,
    // Strict: at the advertised instant RSVPs are already closed. Unlike the
    // `<=` in `eventAcceptsRsvp`'s timed branch, this condition has no SQL
    // twin to match, so "before the deadline" is read literally.
    onSome: (closesAt) => DateTime.isLessThan(now, closesAt),
  });
