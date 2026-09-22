/**
 * Event-creation composition shared by the HTTP handler (`api/event.ts`) and the AI write path
 * (`services/ai/actions.ts`, `create_event`). Deliberately NOT in `api/event.ts` — that would
 * drag `api/api.ts` + `HttpApiBuilder` into the AI tool graph
 * (`services/ai/actions.ts` -> `api/event.ts` -> …).
 *
 * `createEventForMemberTx` is the transactional write ONLY — no `sql.withTransaction` in here,
 * the caller owns it (this codebase's "Tx body split" rule). `emitEventCreatedSideEffects` is the
 * two best-effort emitters and MUST run AFTER any enclosing transaction commits: both
 * `emitTrainingClaimRequestIfApplicable` and `markPersonalMessagesDirtyBestEffort` swallow their
 * own failures as defects (`Effect.catchDefect`/`Effect.catchCause`), and a failed statement
 * inside a Postgres transaction aborts it — running either INSIDE the transaction would let a
 * swallowed defect silently degrade a COMMIT into a ROLLBACK, so confirm/create would report
 * success for a write that never happened. `createEventForMember` is the non-transactional
 * standalone composition the plain HTTP handler uses.
 */
import { EventApi, type GroupModel, type Team } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Option } from 'effect';
import { anchorAllDay, markPersonalMessagesDirtyBestEffort } from '~/api/event.js';
import { hasPermission, requirePermission } from '~/api/permissions.js';
import { checkCoachScoping, checkTrainingTypeOwnerGroup } from '~/api/scoping.js';
import type { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import type { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { type EventRow, EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import type { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { emitTrainingClaimRequestIfApplicable } from '~/services/TrainingClaimEmitter.js';

const forbidden = new EventApi.Forbidden();

/**
 * The group-inheritance rule, PURE and shared by `create_event`'s `propose` (which shows what
 * confirm will actually write) and `createEventForMemberTx` (which writes it). Extracted from
 * `event.ts`'s original inline `resolvedGroups` binding so a card/confirm divergence is a
 * compile-time impossibility — one function, two callers.
 */
export const resolveEventGroups = (args: {
  readonly payloadOwnerGroupId: Option.Option<GroupModel.GroupId>;
  readonly payloadMemberGroupId: Option.Option<GroupModel.GroupId>;
  readonly trainingType: Option.Option<{
    readonly owner_group_id: Option.Option<GroupModel.GroupId>;
    readonly member_group_id: Option.Option<GroupModel.GroupId>;
  }>;
}): {
  readonly ownerGroupId: Option.Option<GroupModel.GroupId>;
  readonly memberGroupId: Option.Option<GroupModel.GroupId>;
} =>
  Option.isSome(args.payloadOwnerGroupId) || Option.isSome(args.payloadMemberGroupId)
    ? { ownerGroupId: args.payloadOwnerGroupId, memberGroupId: args.payloadMemberGroupId }
    : Option.match(args.trainingType, {
        onNone: () => ({
          ownerGroupId: args.payloadOwnerGroupId,
          memberGroupId: args.payloadMemberGroupId,
        }),
        onSome: (tt) => ({ ownerGroupId: tt.owner_group_id, memberGroupId: tt.member_group_id }),
      });

/**
 * Everything that must commit atomically with the event row: permission + scoping checks, group
 * inheritance, the insert itself. NO `sql.withTransaction` here — the caller owns it.
 *
 * Note the short-circuit reproduced from the original handler: `TrainingTypesRepository.
 * findTrainingTypeById` is NOT called at all when the payload already sets an owner or member
 * group id — `resolveEventGroups` takes an already-resolved `Option<trainingType>` precisely so
 * each caller can preserve that guard instead of paying an unconditional extra query on every
 * create that names an explicit group. Do not "simplify" this into an unconditional fetch.
 */
export const createEventForMemberTx = (args: {
  readonly teamId: Team.TeamId;
  readonly membership: MembershipWithRole;
  readonly payload: EventApi.CreateEventRequest;
}): Effect.Effect<
  EventRow,
  EventApi.Forbidden,
  EventsRepository | GroupsRepository | TrainingTypesRepository | TeamSettingsRepository
> =>
  Effect.Do.pipe(
    Effect.bind('events', () => EventsRepository.asEffect()),
    Effect.bind('groups', () => GroupsRepository.asEffect()),
    Effect.bind('trainingTypes', () => TrainingTypesRepository.asEffect()),
    Effect.bind('teamSettings', () => TeamSettingsRepository.asEffect()),
    Effect.tap(() => requirePermission(args.membership, 'event:create', forbidden)),
    Effect.bind('teamZone', ({ teamSettings }) =>
      teamSettings.findByTeamId(args.teamId).pipe(
        Effect.map(
          Option.match({
            onNone: () => 'Europe/Prague',
            onSome: (s) => s.timezone,
          }),
        ),
      ),
    ),
    Effect.let('isAdmin', () => hasPermission(args.membership, 'team:manage')),
    Effect.tap(({ events, isAdmin }) =>
      checkCoachScoping(
        events,
        args.membership.id,
        args.payload.trainingTypeId,
        isAdmin,
        forbidden,
      ),
    ),
    Effect.tap(({ trainingTypes, groups, isAdmin }) =>
      checkTrainingTypeOwnerGroup(
        trainingTypes,
        groups,
        args.membership.id,
        args.payload.trainingTypeId,
        isAdmin,
        forbidden,
        args.teamId,
      ),
    ),
    // Inherit groups from training type if not provided — see the short-circuit note above.
    Effect.bind('resolvedGroups', ({ trainingTypes }) => {
      const hasOwner = Option.isSome(args.payload.ownerGroupId);
      const hasMember = Option.isSome(args.payload.memberGroupId);
      if (hasOwner || hasMember || Option.isNone(args.payload.trainingTypeId)) {
        return Effect.succeed(
          resolveEventGroups({
            payloadOwnerGroupId: args.payload.ownerGroupId,
            payloadMemberGroupId: args.payload.memberGroupId,
            trainingType: Option.none(),
          }),
        );
      }
      return trainingTypes.findTrainingTypeById(args.payload.trainingTypeId.value).pipe(
        Effect.map((trainingType) =>
          resolveEventGroups({
            payloadOwnerGroupId: args.payload.ownerGroupId,
            payloadMemberGroupId: args.payload.memberGroupId,
            trainingType,
          }),
        ),
      );
    }),
    Effect.bind('event', ({ events, resolvedGroups, teamZone }) =>
      events.insertEvent({
        teamId: args.teamId,
        trainingTypeId: args.payload.trainingTypeId,
        // Legacy path: an old web build sends `eventType` only. `eventTypeId` alone (no kind)
        // falls back to `'other'` here — harmless whenever the id is valid for this team, since
        // the trigger overwrites `event_type` from the row's own `kind` regardless of what we
        // send; it only matters for a foreign/invalid id, which the trigger discards anyway.
        eventType: Option.getOrElse(args.payload.eventType, () => 'other' as const),
        eventTypeId: args.payload.eventTypeId,
        title: args.payload.title,
        description: args.payload.description,
        imageUrl: args.payload.imageUrl,
        startAt: args.payload.allDay
          ? anchorAllDay(args.payload.startAt, teamZone)
          : args.payload.startAt,
        endAt: args.payload.allDay
          ? Option.map(args.payload.endAt, (v) => anchorAllDay(v, teamZone))
          : args.payload.endAt,
        location: args.payload.location,
        locationUrl: args.payload.locationUrl,
        createdBy: args.membership.id,
        ownerGroupId: resolvedGroups.ownerGroupId,
        memberGroupId: resolvedGroups.memberGroupId,
        allDay: args.payload.allDay,
      }),
    ),
    Effect.map(({ event }) => event),
    Effect.catchTag(
      'NoSuchElementError',
      LogicError.withMessage(() => 'Failed creating event — no row returned'),
    ),
  );

/**
 * The two best-effort emitters. MUST run AFTER any enclosing transaction commits — see the
 * module doc comment for why running either inside the transaction would be actively dangerous,
 * not merely wasteful.
 */
export const emitEventCreatedSideEffects = (
  teamId: Team.TeamId,
  event: EventRow,
): Effect.Effect<
  void,
  never,
  | EventSyncEventsRepository
  | DiscordChannelMappingRepository
  | TeamSettingsRepository
  | EventsRepository
> =>
  Effect.Do.pipe(
    Effect.bind('events', () => EventsRepository.asEffect()),
    Effect.tap(() =>
      emitTrainingClaimRequestIfApplicable({
        teamId,
        eventId: event.id,
        eventType: event.event_type,
        ownerGroupId: event.owner_group_id,
        title: event.title,
        description: event.description,
        startAt: event.start_at,
        endAt: event.end_at,
        location: event.location,
        locationUrl: event.location_url,
        allDay: event.all_day,
      }),
    ),
    Effect.tap(({ events }) => markPersonalMessagesDirtyBestEffort(events, event.id)),
    Effect.asVoid,
  );

/** Standalone composition for the plain HTTP handler — transaction + best-effort emitters. */
export const createEventForMember = (args: {
  readonly teamId: Team.TeamId;
  readonly membership: MembershipWithRole;
  readonly payload: EventApi.CreateEventRequest;
}): Effect.Effect<
  EventRow,
  EventApi.Forbidden,
  | EventsRepository
  | GroupsRepository
  | TrainingTypesRepository
  | TeamSettingsRepository
  | EventSyncEventsRepository
  | DiscordChannelMappingRepository
> =>
  createEventForMemberTx(args).pipe(
    Effect.tap((event) => emitEventCreatedSideEffects(args.teamId, event)),
  );
