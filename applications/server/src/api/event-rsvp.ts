import {
  Auth,
  DisplayName,
  type Event,
  type EventRsvp,
  EventRsvpApi,
  type GroupModel,
  type TeamMember,
} from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Array, DateTime, Effect, Metric, Option, pipe, type ServiceMap } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership, requirePermission } from '~/api/permissions.js';
import { rsvpSubmissionsTotal } from '~/metrics.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { EventRosterProvisioningService } from '~/services/EventRosterProvisioningService.js';
import { eventAcceptsRsvp } from '~/utils/allDayRsvpWindow.js';
import {
  isLeavingRequiredNoteResponse,
  isRsvpMessageRequiredAndMissing,
} from '~/utils/rsvpMessageRequired.js';

type RsvpCounts = Effect.Success<
  ReturnType<ServiceMap.Service.Shape<typeof EventRsvpsRepository>['countRsvpsByEventId']>
>;

/** `countRsvpsByEventId` only returns rows for responses that someone actually picked. */
const countFor = (counts: RsvpCounts, response: EventRsvp.RsvpResponse): number =>
  pipe(
    counts,
    Array.findFirst((c) => c.response === response),
    Option.map((c) => c.count),
    Option.getOrElse(() => 0),
  );

const forbidden = new EventRsvpApi.Forbidden();
const notFound = new EventRsvpApi.EventNotFound();
const deadlinePassed = new EventRsvpApi.RsvpDeadlinePassed();
const messageRequired = new EventRsvpApi.RsvpMessageRequired();

const checkGroupAccess = (
  groups: ServiceMap.Service.Shape<typeof GroupsRepository>,
  memberId: TeamMember.TeamMemberId,
  groupId: Option.Option<GroupModel.GroupId>,
): Effect.Effect<boolean, never, never> => {
  if (Option.isNone(groupId)) return Effect.succeed(true);
  return groups
    .getDescendantMemberIds(groupId.value)
    .pipe(Effect.map((memberIds) => Array.contains(memberIds, memberId)));
};

const markPersonalMessagesDirtyBestEffort = (
  events: ServiceMap.Service.Shape<typeof EventsRepository>,
  eventId: Event.EventId,
) =>
  events
    .markEventPersonalMessagesDirty(eventId)
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning('Failed to mark personal messages dirty', cause),
      ),
    );

const buildRsvpDetail = (
  rsvps: ServiceMap.Service.Shape<typeof EventRsvpsRepository>,
  eventId: Parameters<
    ServiceMap.Service.Shape<typeof EventRsvpsRepository>['findRsvpsByEventId']
  >[0],
  myMemberId: Parameters<
    ServiceMap.Service.Shape<typeof EventRsvpsRepository>['findRsvpByEventAndMember']
  >[1],
  canRsvp: boolean,
  minPlayersThreshold: number,
) =>
  Effect.Do.pipe(
    Effect.bind('allRsvps', () => rsvps.findRsvpsByEventId(eventId)),
    Effect.bind('myRsvp', () => rsvps.findRsvpByEventAndMember(eventId, myMemberId)),
    Effect.bind('counts', () => rsvps.countRsvpsByEventId(eventId)),
    Effect.map(
      ({ allRsvps, myRsvp, counts }) =>
        new EventRsvpApi.EventRsvpDetail({
          myResponse: Option.map(myRsvp, (my) => my.response),
          myMessage: Option.flatMap(myRsvp, (my) => my.message),
          rsvps: Array.map(
            allRsvps,
            (r) =>
              new EventRsvpApi.RsvpEntry({
                teamMemberId: r.team_member_id,
                memberName: r.member_name,
                username: r.username,
                response: r.response,
                message: r.message,
                displayName: Option.getOrElse(
                  DisplayName.pickDisplayName({
                    name: r.member_name,
                    nickname: r.nickname,
                    displayName: r.display_name,
                    username: r.username,
                  }),
                  () => '—',
                ),
              }),
          ),
          yesCount: countFor(counts, 'yes'),
          noCount: countFor(counts, 'no'),
          maybeCount: countFor(counts, 'maybe'),
          comingLaterCount: countFor(counts, 'coming_later'),
          canRsvp,
          minPlayersThreshold,
        }),
    ),
  );

export const EventRsvpApiLive = HttpApiBuilder.group(Api, 'eventRsvp', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('events', () => EventsRepository.asEffect()),
    Effect.bind('rsvps', () => EventRsvpsRepository.asEffect()),
    Effect.bind('teamSettings', () => TeamSettingsRepository.asEffect()),
    Effect.bind('groups', () => GroupsRepository.asEffect()),
    Effect.bind('provisioning', () => EventRosterProvisioningService.asEffect()),
    Effect.map(({ members, events, rsvps, teamSettings, groups, provisioning }) =>
      handlers
        .handle('getRsvps', ({ params: { teamId, eventId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.bind('event', () =>
              events.findEventByIdWithDetails(eventId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(notFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ event }) =>
              event.team_id !== teamId ? Effect.fail(notFound) : Effect.void,
            ),
            Effect.bind('settings', () => teamSettings.findByTeamId(teamId)),
            Effect.bind('isGroupMember', ({ event, membership }) =>
              checkGroupAccess(groups, membership.id, event.member_group_id),
            ),
            Effect.flatMap(({ event, membership, settings, isGroupMember }) =>
              buildRsvpDetail(
                rsvps,
                eventId,
                membership.id,
                eventAcceptsRsvp(event, event.timezone, DateTime.nowUnsafe()) && isGroupMember,
                Option.match(settings, {
                  onNone: () => 0,
                  onSome: (s) => s.min_players_threshold,
                }),
              ),
            ),
          ),
        )
        .handle('submitRsvp', ({ params: { teamId, eventId }, payload }) => {
          // This surface has no `clearMessage` flag (the bot's RPC one does), so the two intents
          // ride on the message field itself: `null` means "leave the stored note alone" — the
          // repository's `COALESCE(message, event_rsvps.message)` keeps it, which an idempotent
          // button re-click relies on — while an explicitly blank string means "clear it". Without
          // that distinction the clearing branch is unreachable over HTTP and the web UI can never
          // remove a note. A blank clear on `coming_later` is still rejected by the guard below.
          const clearMessage =
            Option.isSome(payload.message) && payload.message.value.trim().length === 0;
          const note = clearMessage ? Option.none() : payload.message;
          return Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.bind('event', () =>
              events.findEventByIdWithDetails(eventId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(notFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ event }) =>
              event.team_id !== teamId ? Effect.fail(notFound) : Effect.void,
            ),
            // Cancelled stays `notFound` — the pre-existing vocabulary for this
            // surface — while every other closed case (an all-day event past its
            // last local day, or a timed event past its deadline) is
            // `deadlinePassed` via `eventAcceptsRsvp`. Only the started + all-day
            // case newly succeeds here.
            Effect.tap(({ event }) =>
              event.status === 'cancelled' ? Effect.fail(notFound) : Effect.void,
            ),
            Effect.tap(({ event }) =>
              !eventAcceptsRsvp(event, event.timezone, DateTime.nowUnsafe())
                ? Effect.fail(deadlinePassed)
                : Effect.void,
            ),
            Effect.tap(({ event, membership }) =>
              checkGroupAccess(groups, membership.id, event.member_group_id).pipe(
                Effect.flatMap((isMember) => (isMember ? Effect.void : Effect.fail(forbidden))),
              ),
            ),
            Effect.bind('priorRsvp', ({ membership }) =>
              rsvps.findRsvpByEventAndMember(eventId, membership.id),
            ),
            // Leaving a note-requiring response (`coming_later` / `maybe`) for a different one
            // must not carry its mandatory note onto the new response. Derived here rather than
            // alongside `clearMessage` above because it needs `priorRsvp`, which is only bound
            // once membership is known. Mirrors the RPC `Event/SubmitRsvp` handler so both write
            // surfaces agree on the same transition — the web client sends a blank string, but
            // any other caller sending `message: null` would otherwise keep a stale
            // "dorazím v 19:00" attached to its "Nevím".
            Effect.let(
              'effectiveClear',
              ({ priorRsvp }) =>
                clearMessage ||
                isLeavingRequiredNoteResponse(
                  payload.response,
                  note,
                  Option.map(priorRsvp, (r) => r.response),
                ),
            ),
            // Consumes `effectiveClear`, not the raw flag — see `rsvpMessageRequired.ts`.
            Effect.tap(({ priorRsvp, effectiveClear }) =>
              isRsvpMessageRequiredAndMissing(
                payload.response,
                effectiveClear,
                note,
                Option.flatMap(priorRsvp, (r) => r.message),
              )
                ? Effect.fail(messageRequired)
                : Effect.void,
            ),
            Effect.bind('upsertResult', ({ membership, effectiveClear }) =>
              rsvps.upsertRsvp(eventId, membership.id, payload.response, note, effectiveClear).pipe(
                Effect.catchTag(
                  'NoSuchElementError',
                  LogicError.withMessage(() => 'Failed upserting RSVP — no row returned'),
                ),
                Effect.tap(() =>
                  Metric.update(
                    Metric.withAttributes(rsvpSubmissionsTotal, { response: payload.response }),
                    1,
                  ),
                ),
              ),
            ),
            // Best-effort: reset missed RSVP streak on any response
            Effect.tap(({ membership }) =>
              members
                .resetMissedRsvps(membership.id)
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning('Failed to reset missed RSVPs, continuing', cause),
                  ),
                ),
            ),
            // Best-effort: trigger roster provisioning after RSVP
            Effect.tap(({ event, membership, upsertResult }) =>
              provisioning.onRsvp({
                teamId,
                event: {
                  id: eventId,
                  owner_group_id: event.owner_group_id,
                  member_group_id: event.member_group_id,
                  title: event.title,
                  start_at: event.start_at,
                  all_day: event.all_day,
                },
                memberId: membership.id,
                discordUserId: Option.none(),
                priorResponse: upsertResult.priorResponse,
                newResponse: payload.response,
                displayName: Option.none(),
              }),
            ),
            Effect.tap(({ event }) => markPersonalMessagesDirtyBestEffort(events, event.id)),
            Effect.asVoid,
          );
        })
        .handle('getNonResponders', ({ params: { teamId, eventId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'event:edit', forbidden)),
            Effect.bind('event', () =>
              events.findEventByIdWithDetails(eventId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(notFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ event }) =>
              event.team_id !== teamId ? Effect.fail(notFound) : Effect.void,
            ),
            Effect.bind('settings', () => teamSettings.findByTeamId(teamId)),
            Effect.bind('nonResponders', ({ event, settings }) =>
              rsvps.findNonRespondersByEventId(
                eventId,
                teamId,
                event.member_group_id,
                Option.match(settings, { onNone: () => 4, onSome: (s) => s.max_missed_rsvps }),
              ),
            ),
            Effect.map(
              ({ nonResponders }) =>
                new EventRsvpApi.NonRespondersResponse({
                  nonResponders: Array.map(
                    nonResponders,
                    (nr) =>
                      new EventRsvpApi.NonResponderEntry({
                        teamMemberId: nr.team_member_id,
                        memberName: nr.member_name,
                        username: nr.username,
                        displayName: Option.getOrElse(
                          DisplayName.pickDisplayName({
                            name: nr.member_name,
                            nickname: nr.nickname,
                            displayName: nr.display_name,
                            username: nr.username,
                          }),
                          () => '—',
                        ),
                      }),
                  ),
                }),
            ),
          ),
        ),
    ),
  ),
);
