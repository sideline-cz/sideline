import {
  Auth,
  DisplayName,
  type EventRsvp,
  EventRsvpApi,
  type GroupModel,
  type TeamMember,
} from '@sideline/domain';
import { Array, DateTime, Effect, Option, pipe, type ServiceMap } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { hasPermission, requireMembership, requirePermission } from '~/api/permissions.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { emitRsvpSideEffects, submitRsvpTx } from '~/services/RsvpWrites.js';
import { eventRsvpOpen, rsvpClosesAtOf } from '~/utils/allDayRsvpWindow.js';
import {
  attendingGenderCountsFor,
  foldAttendingGenderCounts,
} from '~/utils/attendingGenderCounts.js';

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

const buildRsvpDetail = (
  rsvps: ServiceMap.Service.Shape<typeof EventRsvpsRepository>,
  eventId: Parameters<
    ServiceMap.Service.Shape<typeof EventRsvpsRepository>['findRsvpsByEventId']
  >[0],
  myMemberId: Parameters<
    ServiceMap.Service.Shape<typeof EventRsvpsRepository>['findRsvpByEventAndMember']
  >[1],
  canRsvp: boolean,
  rsvpClosesAt: Option.Option<DateTime.Utc>,
  minPlayersThreshold: number,
  // Gender is personal data, so the aggregate rides the same gate as the per-person gender
  // icon `PlayerCard.tsx` already renders. `false` omits the key entirely rather than
  // sending zeroes, which would be indistinguishable from "nobody is going".
  canViewMembers: boolean,
) =>
  Effect.Do.pipe(
    Effect.bind('allRsvps', () => rsvps.findRsvpsByEventId(eventId)),
    Effect.bind('myRsvp', () => rsvps.findRsvpByEventAndMember(eventId, myMemberId)),
    Effect.bind('counts', () => rsvps.countRsvpsByEventId(eventId)),
    Effect.bind('genderRows', () =>
      canViewMembers
        ? rsvps.countAttendingGendersByEventIds([eventId])
        : Effect.succeed([] as const),
    ),
    Effect.map(
      ({ allRsvps, myRsvp, counts, genderRows }) =>
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
          rsvpClosesAt,
          minPlayersThreshold,
          attendingGenderCounts: attendingGenderCountsFor(
            foldAttendingGenderCounts(genderRows),
            eventId,
          ),
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
    Effect.map(({ members, events, rsvps, teamSettings, groups }) =>
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
                eventRsvpOpen(event, event.timezone, DateTime.nowUnsafe()) && isGroupMember,
                // Sent whenever a lock APPLIES and the viewer is invited — NOT only when the
                // deadline is why `canRsvp` is false. It is `Some` on an open event days out too
                // (that is what renders "RSVP closes in 3 days"), which `test/EventRsvp.test.ts`
                // case 8 pins. The one thing it encodes is invitation: a member outside the
                // event's `member_group` must never be told "RSVPs closed at 18:00" — RSVPs are
                // open for everyone else; they simply aren't invited. Narrowing a `Some` to "the
                // deadline passed" is the CALLER's job, off `!canRsvp`.
                isGroupMember ? rsvpClosesAtOf(event) : Option.none(),
                Option.match(settings, {
                  onNone: () => 0,
                  onSome: (s) => s.min_players_threshold,
                }),
                hasPermission(membership, 'member:view'),
              ),
            ),
          ),
        )
        .handle('submitRsvp', ({ params: { teamId, eventId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.flatMap(({ currentUser, membership }) =>
              submitRsvpTx({
                teamId,
                membership,
                isProfileComplete: currentUser.isProfileComplete,
                eventId,
                response: payload.response,
                message: payload.message,
              }),
            ),
            Effect.flatMap((submitted) => emitRsvpSideEffects(teamId, submitted)),
          ),
        )
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
