/**
 * Event update / cancel / attendance-confirm bodies shared by the HTTP handlers (`api/event.ts`,
 * `api/event-attendance.ts`) and the AI write path (`services/ai/actions.ts`). Same split as
 * `EventCreation.ts`: the `*Tx` functions are the guarded write only, with no
 * `sql.withTransaction` (the caller owns it), and the best-effort emitters run AFTER commit. They
 * swallow their own failures, and a failed statement inside a Postgres transaction aborts it.
 *
 * The `check*` functions are the same guards without the write, so a propose refuses early for
 * the same reason the confirm would.
 */
import {
  type Event,
  EventApi,
  EventAttendanceApi,
  type Team,
  type TeamMember,
  type TrainingType,
} from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import * as m from '@sideline/i18n/messages';
import { DateTime, Effect, Option } from 'effect';
import {
  markPersonalMessagesDirtyBestEffort,
  mergeAllDayEndAt,
  mergeAllDayInstant,
} from '~/api/event.js';
import { hasPermission, requirePermission } from '~/api/permissions.js';
import { checkCoachScoping, checkGroupAccess, checkTrainingTypeOwnerGroup } from '~/api/scoping.js';
import { EventAttendanceRepository } from '~/repositories/EventAttendanceRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventsRepository, type EventWithDetails } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { NotificationsRepository } from '~/repositories/NotificationsRepository.js';
import type { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { eventAcceptsRsvp } from '~/utils/allDayRsvpWindow.js';

const forbidden = new EventApi.Forbidden();
const notFound = new EventApi.EventNotFound();
const notActive = new EventApi.EventNotActive();

export interface EventWriteArgs {
  readonly teamId: Team.TeamId;
  readonly membership: MembershipWithRole;
  readonly eventId: Event.EventId;
}

const findEventInTeam = <E>(teamId: Team.TeamId, eventId: Event.EventId, onMissing: E) =>
  EventsRepository.asEffect().pipe(
    Effect.flatMap((events) => events.findEventByIdWithDetails(eventId)),
    Effect.flatMap(
      (found): Effect.Effect<EventWithDetails, E> =>
        Option.isSome(found) && found.value.team_id === teamId
          ? Effect.succeed(found.value)
          : Effect.fail(onMissing),
    ),
  );

/** The guards `updateEvent` and `cancelEvent` share, in the handlers' original order. */
const checkOpenOwnedEvent = (
  args: EventWriteArgs,
  isAdmin: boolean,
  trainingTypeId: (existing: EventWithDetails) => Option.Option<TrainingType.TrainingTypeId>,
) =>
  Effect.Do.pipe(
    Effect.bind('events', () => EventsRepository.asEffect()),
    Effect.bind('groups', () => GroupsRepository.asEffect()),
    Effect.bind('existing', () => findEventInTeam(args.teamId, args.eventId, notFound)),
    // `eventAcceptsRsvp`, NOT `eventRsvpOpen`: the configurable RSVP deadline narrows the RSVP
    // gate only; edit and cancel stay available inside the lock window.
    Effect.tap(({ existing }) =>
      !eventAcceptsRsvp(existing, existing.timezone, DateTime.nowUnsafe())
        ? Effect.fail(notActive)
        : Effect.void,
    ),
    Effect.tap(({ existing, groups }) =>
      isAdmin
        ? Effect.void
        : checkGroupAccess(groups, args.membership.id, existing.owner_group_id).pipe(
            Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail(forbidden))),
          ),
    ),
    Effect.tap(({ existing, events }) =>
      checkCoachScoping(events, args.membership.id, trainingTypeId(existing), isAdmin, forbidden),
    ),
    Effect.map(({ existing }) => existing),
  );

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

const mergedTrainingTypeId =
  (payload: EventApi.UpdateEventRequest) => (existing: EventWithDetails) =>
    Option.match(payload.trainingTypeId, {
      onNone: () => existing.training_type_id,
      onSome: (v) => v,
    });

/** Every `updateEvent` guard, no write. Returns the event as it is now. */
export const checkEventUpdatable = (
  args: EventWriteArgs & { payload: EventApi.UpdateEventRequest },
) =>
  Effect.Do.pipe(
    Effect.tap(() => requirePermission(args.membership, 'event:edit', forbidden)),
    Effect.let('isAdmin', () => hasPermission(args.membership, 'team:manage')),
    Effect.bind('existing', ({ isAdmin }) =>
      checkOpenOwnedEvent(args, isAdmin, mergedTrainingTypeId(args.payload)),
    ),
    Effect.tap(({ existing, isAdmin }) =>
      Effect.Do.pipe(
        Effect.bind('trainingTypes', () => TrainingTypesRepository.asEffect()),
        Effect.bind('groups', () => GroupsRepository.asEffect()),
        Effect.flatMap(({ trainingTypes, groups }) =>
          checkTrainingTypeOwnerGroup(
            trainingTypes,
            groups,
            args.membership.id,
            mergedTrainingTypeId(args.payload)(existing),
            isAdmin,
            forbidden,
            args.teamId,
          ),
        ),
      ),
    ),
    Effect.map(({ existing }) => existing),
  );

/** The whole `updateEvent` write. Returns the re-read row; the caller marks personal messages
 *  dirty after commit. */
export const updateEventForMemberTx = (
  args: EventWriteArgs & { payload: EventApi.UpdateEventRequest },
) =>
  Effect.Do.pipe(
    Effect.bind('events', () => EventsRepository.asEffect()),
    Effect.bind('teamZone', () =>
      TeamSettingsRepository.asEffect().pipe(
        Effect.flatMap((s) => s.findByTeamId(args.teamId)),
        Effect.map(
          Option.match({
            onNone: () => 'Europe/Prague',
            onSome: (s) => s.timezone,
          }),
        ),
      ),
    ),
    Effect.bind('existing', () => checkEventUpdatable(args)),
    Effect.let('mergedLocation', ({ existing }) =>
      Option.getOrElse(args.payload.location, () => existing.location),
    ),
    Effect.let('mergedLocationUrl', ({ existing }) =>
      Option.getOrElse(args.payload.locationUrl, () => existing.location_url),
    ),
    Effect.tap(({ mergedLocation, mergedLocationUrl }) =>
      Option.isSome(mergedLocationUrl) && Option.isNone(mergedLocation)
        ? Effect.fail(forbidden)
        : Effect.void,
    ),
    Effect.tap(({ events, existing, mergedLocation, mergedLocationUrl, teamZone }) => {
      const { payload } = args;
      const mergedAllDay = Option.getOrElse(payload.allDay, () => existing.all_day);
      return events.updateEvent({
        id: args.eventId,
        title: Option.getOrElse(payload.title, () => existing.title),
        eventType: Option.getOrElse(payload.eventType, () => existing.event_type),
        // Raw passthrough, NOT merged against `existing.event_type_id` — `None` means "no change
        // requested" and the repository's `COALESCE` keeps the existing column value.
        eventTypeId: payload.eventTypeId,
        trainingTypeId: mergedTrainingTypeId(payload)(existing),
        description: Option.match(payload.description, {
          onNone: () => existing.description,
          onSome: (v) => v,
        }),
        imageUrl: Option.match(payload.imageUrl, {
          onNone: () => existing.image_url,
          onSome: (v) => v,
        }),
        // Five-row merge, plan §12 step 4 — see `mergeAllDayInstant`/`mergeAllDayEndAt`.
        startAt: mergeAllDayInstant(
          payload.startAt,
          existing.start_at,
          mergedAllDay,
          existing.all_day,
          teamZone,
        ),
        endAt: mergeAllDayEndAt(
          payload.endAt,
          existing.end_at,
          mergedAllDay,
          existing.all_day,
          teamZone,
        ),
        location: mergedLocation,
        locationUrl: mergedLocationUrl,
        ownerGroupId: Option.match(payload.ownerGroupId, {
          onNone: () => existing.owner_group_id,
          onSome: (v) => v,
        }),
        memberGroupId: Option.match(payload.memberGroupId, {
          onNone: () => existing.member_group_id,
          onSome: (v) => v,
        }),
        allDay: mergedAllDay,
      });
    }),
    Effect.tap(({ events, existing }) =>
      Option.isSome(existing.series_id)
        ? events.markEventSeriesModified(args.eventId)
        : Effect.void,
    ),
    Effect.flatMap(({ events }) => events.findEventByIdWithDetails(args.eventId)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(notFound),
        onSome: Effect.succeed,
      }),
    ),
    Effect.catchTag(
      'NoSuchElementError',
      LogicError.withMessage(() => 'Failed updating event — no row returned'),
    ),
  );

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/** Every `cancelEvent` guard, no write. Returns the event as it is now. */
export const checkEventCancellable = (args: EventWriteArgs) =>
  requirePermission(args.membership, 'event:cancel', forbidden).pipe(
    Effect.andThen(
      checkOpenOwnedEvent(
        args,
        hasPermission(args.membership, 'team:manage'),
        (existing) => existing.training_type_id,
      ),
    ),
  );

export const cancelEventForMemberTx = (args: EventWriteArgs) =>
  checkEventCancellable(args).pipe(
    Effect.tap(() =>
      EventsRepository.asEffect().pipe(
        Effect.flatMap((events) => events.cancelEvent(args.eventId)),
      ),
    ),
  );

/** After commit. Only people who said they were coming are told: a "no" or a silence means the
 *  event was already not in their plans. */
export const emitEventCancelledSideEffects = (teamId: Team.TeamId, existing: EventWithDetails) =>
  Effect.Do.pipe(
    Effect.bind('events', () => EventsRepository.asEffect()),
    Effect.bind('rsvps', () => EventRsvpsRepository.asEffect()),
    Effect.bind('notifications', () => NotificationsRepository.asEffect()),
    Effect.tap(({ rsvps, notifications }) =>
      rsvps.findAttendingMemberIdsByEventId(existing.id).pipe(
        Effect.flatMap((memberIds) =>
          notifications.notifyMembers(
            teamId,
            memberIds,
            'event_cancelled',
            `/teams/${teamId}/events/${existing.id}`,
            (locale) => ({
              title: m.notification_eventCancelled_title({}, { locale }),
              body: m.notification_eventCancelled_body({ title: existing.title }, { locale }),
            }),
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning('Failed to notify attendees of cancellation', cause),
        ),
      ),
    ),
    Effect.tap(({ events }) => markPersonalMessagesDirtyBestEffort(events, existing.id)),
    Effect.asVoid,
  );

// ---------------------------------------------------------------------------
// Attendance confirm
// ---------------------------------------------------------------------------

const attendanceForbidden = new EventAttendanceApi.Forbidden();

/** `confirmEventAttendance`'s permission gate: `event:edit` and (`team:manage` or a member of the
 *  owner group). Deliberately NOT `EventDetail.canEdit`, which is also gated on
 *  `eventAcceptsRsvp` — false for every STARTED event, i.e. exactly the ones attendance is for. */
export const checkAttendanceConfirmable = (args: EventWriteArgs) =>
  Effect.Do.pipe(
    Effect.tap(() => requirePermission(args.membership, 'event:edit', attendanceForbidden)),
    Effect.bind('event', () =>
      findEventInTeam(args.teamId, args.eventId, new EventAttendanceApi.EventNotFound()),
    ),
    Effect.bind('isOwnerGroupMember', ({ event }) =>
      GroupsRepository.asEffect().pipe(
        Effect.flatMap((groups) =>
          checkGroupAccess(groups, args.membership.id, event.owner_group_id),
        ),
      ),
    ),
    Effect.tap(({ isOwnerGroupMember }) =>
      hasPermission(args.membership, 'team:manage') || isOwnerGroupMember
        ? Effect.void
        : Effect.fail(attendanceForbidden),
    ),
    Effect.map(({ event }) => event),
  );

/** One statement: the repository folds the event guards (training, not cancelled, started) into
 *  the INSERT, so zero rows means it refused. */
export const confirmAttendanceForMember = (
  args: EventWriteArgs & {
    readonly entries: ReadonlyArray<{
      readonly teamMemberId: TeamMember.TeamMemberId;
      readonly present: boolean;
    }>;
  },
) =>
  checkAttendanceConfirmable(args).pipe(
    Effect.andThen(EventAttendanceRepository.asEffect()),
    Effect.flatMap((attendance) =>
      attendance.confirmAttendance({
        event_id: args.eventId,
        team_id: args.teamId,
        confirmed_by: args.membership.id,
        entries: args.entries.map((entry) => ({
          team_member_id: entry.teamMemberId,
          present: entry.present,
        })),
      }),
    ),
    Effect.flatMap((rowsAffected) =>
      rowsAffected === 0
        ? Effect.fail(new EventAttendanceApi.AttendanceNotConfirmable())
        : Effect.void,
    ),
  );
