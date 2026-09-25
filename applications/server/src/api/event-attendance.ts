import { Auth, DisplayName, EventAttendanceApi } from '@sideline/domain';
import { Array, Effect, Layer, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { hasPermission, requireMembership, requirePermission } from '~/api/permissions.js';
import { checkGroupAccess } from '~/api/scoping.js';
import { EventAttendanceRepository } from '~/repositories/EventAttendanceRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';

const forbidden = new EventAttendanceApi.Forbidden();
const notFound = new EventAttendanceApi.EventNotFound();
const notConfirmable = new EventAttendanceApi.AttendanceNotConfirmable();

// `event.event_type === 'training'` is trigger-owned (see AGENTS.md ownership statement) — every
// event this endpoint is ever called for either genuinely is a training or genuinely isn't, so
// this is a stable read, never a race with the write side.
const notTrainingResponse = new EventAttendanceApi.EventAttendanceResponse({
  canConfirm: false,
  confirmedAt: Option.none(),
  entries: [],
});

export const EventAttendanceApiLive = HttpApiBuilder.group(Api, 'eventAttendance', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('events', () => EventsRepository.asEffect()),
    Effect.bind('groups', () => GroupsRepository.asEffect()),
    Effect.bind('attendance', () => EventAttendanceRepository.asEffect()),
    Effect.map(({ members, events, groups, attendance }) =>
      handlers
        // Any member who can see the event may read it — the web loader calls this for EVERY
        // event on the page, so a non-training event returns 200 with an empty/unconfirmable
        // response rather than 403/404 (either would log a warning per page view for the vast
        // majority of events, which aren't trainings).
        .handle('getEventAttendance', ({ params: { teamId, eventId } }) =>
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
            Effect.flatMap(({ event, membership }) => {
              if (event.event_type !== 'training') return Effect.succeed(notTrainingResponse);
              const isAdmin = hasPermission(membership, 'team:manage');
              return Effect.Do.pipe(
                Effect.bind('isOwnerGroupMember', () =>
                  checkGroupAccess(groups, membership.id, event.owner_group_id),
                ),
                Effect.let(
                  'canConfirm',
                  ({ isOwnerGroupMember }) =>
                    hasPermission(membership, 'event:edit') && (isAdmin || isOwnerGroupMember),
                ),
                // Deliberately NOT a 403 for a member who may not see the list. The web event
                // page loads this for EVERY event, so failing here would log a warning on every
                // page view by every ordinary player. They get the same empty shape a
                // non-training event returns: `canConfirm: false`, no entries. Reading the list
                // needs either the confirm right or `finance:view` (the Treasurer bills from it
                // and fields "why was I charged"). A member seeing their OWN attendance is a
                // separate surface and belongs with the charge, not here.
                Effect.bind('rows', ({ canConfirm }) =>
                  canConfirm || hasPermission(membership, 'finance:view')
                    ? attendance.findAttendanceForEvent(eventId)
                    : Effect.succeed([]),
                ),
                Effect.map(
                  ({ canConfirm, rows }) =>
                    new EventAttendanceApi.EventAttendanceResponse({
                      canConfirm,
                      confirmedAt: Option.flatMap(
                        Array.findFirst(rows, (row) => Option.isSome(row.confirmed_at)),
                        (row) => row.confirmed_at,
                      ),
                      entries: Array.map(
                        rows,
                        (row) =>
                          new EventAttendanceApi.EventAttendanceEntry({
                            teamMemberId: row.team_member_id,
                            displayName: Option.getOrElse(
                              DisplayName.pickDisplayName({
                                name: row.member_name,
                                nickname: row.nickname,
                                displayName: row.display_name,
                                username: row.username,
                              }),
                              () => '—',
                            ),
                            rsvpResponse: row.rsvp_response,
                            present: row.present,
                          }),
                      ),
                    }),
                ),
              );
            }),
          ),
        )
        .handle('confirmEventAttendance', ({ params: { teamId, eventId }, payload }) =>
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
            // Deliberately NOT `EventDetail.canEdit` — that expression is additionally gated on
            // `eventAcceptsRsvp(...)`, which is false for every STARTED event, i.e. false for
            // exactly the events attendance can be confirmed on. Copy of the bare permission
            // expression at `api/event.ts`'s `getEvent` handler instead.
            Effect.bind('isOwnerGroupMember', ({ event, membership }) =>
              checkGroupAccess(groups, membership.id, event.owner_group_id),
            ),
            Effect.tap(({ membership, isOwnerGroupMember }) =>
              hasPermission(membership, 'event:edit') &&
              (hasPermission(membership, 'team:manage') || isOwnerGroupMember)
                ? Effect.void
                : Effect.fail(forbidden),
            ),
            Effect.bind('rowsAffected', ({ membership }) =>
              attendance.confirmAttendance({
                event_id: eventId,
                team_id: teamId,
                confirmed_by: membership.id,
                entries: Array.map(payload.entries, (entry) => ({
                  team_member_id: entry.teamMemberId,
                  present: entry.present,
                })),
              }),
            ),
            Effect.flatMap(({ rowsAffected }) =>
              rowsAffected === 0 ? Effect.fail(notConfirmable) : Effect.void,
            ),
          ),
        ),
    ),
  ),
).pipe(Layer.provide(EventAttendanceRepository.Default));
