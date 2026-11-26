/**
 * The web `submitRsvp` body, shared by the HTTP handler (`api/event-rsvp.ts`) and the AI write
 * path (`services/ai/actions.ts`, `set_my_rsvp`). Always the CALLER's own RSVP: there is no
 * member parameter. Same split as `EventWrites.ts`: `checkRsvpSubmittable` is every guard without
 * the write, `submitRsvpTx` is guards + write (no `sql.withTransaction`, the caller owns it), and
 * `emitRsvpSideEffects` is the best-effort work that must run AFTER commit — each step swallows
 * its own failure, and a failed statement inside a Postgres transaction aborts it.
 */
import {
  type Event,
  type EventRsvp,
  EventRsvpApi,
  type Team,
  type TeamMember,
} from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { DateTime, Effect, Metric, Option } from 'effect';
import { markPersonalMessagesDirtyBestEffort } from '~/api/event.js';
import { checkGroupAccess } from '~/api/scoping.js';
import { rsvpSubmissionsTotal } from '~/metrics.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventsRepository, type EventWithDetails } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import {
  type MembershipWithRole,
  TeamMembersRepository,
} from '~/repositories/TeamMembersRepository.js';
import { EventRosterProvisioningService } from '~/services/EventRosterProvisioningService.js';
import { eventRsvpOpen } from '~/utils/allDayRsvpWindow.js';
import { requireCompleteProfile } from '~/utils/requireCompleteProfile.js';
import {
  isLeavingRequiredNoteResponse,
  isRsvpMessageRequiredAndMissing,
} from '~/utils/rsvpMessageRequired.js';

export interface SubmitRsvpArgs {
  readonly teamId: Team.TeamId;
  readonly membership: MembershipWithRole;
  readonly isProfileComplete: boolean;
  readonly eventId: Event.EventId;
  readonly response: EventRsvp.RsvpResponse;
  /** As sent: `None` keeps the stored note, a blank string clears it. */
  readonly message: Option.Option<string>;
}

const forbidden = new EventRsvpApi.Forbidden();
const notFound = new EventRsvpApi.EventNotFound();

/** Every `submitRsvp` guard, no write. */
export const checkRsvpSubmittable = (args: SubmitRsvpArgs) => {
  // `None` means "leave the stored note alone" (an idempotent re-click relies on it); an
  // explicitly blank string means "clear it".
  const clearMessage = Option.isSome(args.message) && args.message.value.trim().length === 0;
  const note = clearMessage ? Option.none<string>() : args.message;
  return Effect.Do.pipe(
    // Before any other precondition, so an incomplete profile reports as itself.
    Effect.tap(() =>
      requireCompleteProfile({
        requiredByTeam: Option.getOrElse(args.membership.require_complete_profile, () => false),
        isProfileComplete: args.isProfileComplete,
        incomplete: new EventRsvpApi.RsvpProfileIncomplete(),
      }),
    ),
    Effect.bind('event', () =>
      EventsRepository.asEffect().pipe(
        Effect.flatMap((events) => events.findEventByIdWithDetails(args.eventId)),
        Effect.flatMap(
          (found): Effect.Effect<EventWithDetails, EventRsvpApi.EventNotFound> =>
            Option.isSome(found) && found.value.team_id === args.teamId
              ? Effect.succeed(found.value)
              : Effect.fail(notFound),
        ),
      ),
    ),
    // Cancelled stays `notFound`; every other closed case is `deadlinePassed` via `eventRsvpOpen`.
    Effect.tap(({ event }) => (event.status === 'cancelled' ? Effect.fail(notFound) : Effect.void)),
    Effect.tap(({ event }) =>
      !eventRsvpOpen(event, event.timezone, DateTime.nowUnsafe())
        ? Effect.fail(new EventRsvpApi.RsvpDeadlinePassed())
        : Effect.void,
    ),
    Effect.tap(({ event }) =>
      GroupsRepository.asEffect().pipe(
        Effect.flatMap((groups) =>
          checkGroupAccess(groups, args.membership.id, event.member_group_id),
        ),
        Effect.flatMap((isMember) => (isMember ? Effect.void : Effect.fail(forbidden))),
      ),
    ),
    Effect.bind('priorRsvp', () =>
      EventRsvpsRepository.asEffect().pipe(
        Effect.flatMap((rsvps) => rsvps.findRsvpByEventAndMember(args.eventId, args.membership.id)),
      ),
    ),
    // Leaving a note-requiring response for a different one must not carry its note along.
    // Mirrors the RPC `Event/SubmitRsvp` handler.
    Effect.let(
      'effectiveClear',
      ({ priorRsvp }) =>
        clearMessage ||
        isLeavingRequiredNoteResponse(
          args.response,
          note,
          Option.map(priorRsvp, (r) => r.response),
        ),
    ),
    // Consumes `effectiveClear`, not the raw flag — see `rsvpMessageRequired.ts`.
    Effect.tap(({ priorRsvp, effectiveClear }) =>
      isRsvpMessageRequiredAndMissing(
        args.response,
        effectiveClear,
        note,
        Option.flatMap(priorRsvp, (r) => r.message),
      )
        ? Effect.fail(new EventRsvpApi.RsvpMessageRequired())
        : Effect.void,
    ),
    Effect.map(({ event, priorRsvp, effectiveClear }) => ({
      event,
      priorRsvp,
      effectiveClear,
      note,
    })),
  );
};

export const submitRsvpTx = (args: SubmitRsvpArgs) =>
  checkRsvpSubmittable(args).pipe(
    Effect.flatMap(({ event, effectiveClear, note }) =>
      EventRsvpsRepository.asEffect().pipe(
        Effect.flatMap((rsvps) =>
          rsvps.upsertRsvp(args.eventId, args.membership.id, args.response, note, effectiveClear),
        ),
        Effect.catchTag(
          'NoSuchElementError',
          LogicError.withMessage(() => 'Failed upserting RSVP — no row returned'),
        ),
        Effect.tap(() =>
          Metric.update(
            Metric.withAttributes(rsvpSubmissionsTotal, { response: args.response }),
            1,
          ),
        ),
        Effect.map((upsertResult) => ({
          event,
          memberId: args.membership.id,
          response: args.response,
          priorResponse: upsertResult.priorResponse,
        })),
      ),
    ),
  );

/** After commit, in the handler's original order. Every step is best-effort. */
export const emitRsvpSideEffects = (
  teamId: Team.TeamId,
  submitted: {
    readonly event: EventWithDetails;
    readonly memberId: TeamMember.TeamMemberId;
    readonly response: EventRsvp.RsvpResponse;
    readonly priorResponse: Effect.Success<ReturnType<typeof submitRsvpTx>>['priorResponse'];
  },
) =>
  Effect.Do.pipe(
    Effect.tap(() =>
      TeamMembersRepository.asEffect().pipe(
        Effect.flatMap((members) => members.resetMissedRsvps(submitted.memberId)),
        Effect.catchCause((cause) =>
          Effect.logWarning('Failed to reset missed RSVPs, continuing', cause),
        ),
      ),
    ),
    Effect.tap(() =>
      EventRosterProvisioningService.asEffect().pipe(
        Effect.flatMap((provisioning) =>
          provisioning.onRsvp({
            teamId,
            event: {
              id: submitted.event.id,
              owner_group_id: submitted.event.owner_group_id,
              member_group_id: submitted.event.member_group_id,
              title: submitted.event.title,
              start_at: submitted.event.start_at,
              all_day: submitted.event.all_day,
            },
            memberId: submitted.memberId,
            discordUserId: Option.none(),
            priorResponse: submitted.priorResponse,
            newResponse: submitted.response,
            displayName: Option.none(),
          }),
        ),
      ),
    ),
    Effect.tap(() =>
      EventsRepository.asEffect().pipe(
        Effect.flatMap((events) => markPersonalMessagesDirtyBestEffort(events, submitted.event.id)),
      ),
    ),
    Effect.asVoid,
  );
