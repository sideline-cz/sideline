import { Auth, EventRosterApi, type RosterModel } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership, requirePermission } from '~/api/permissions.js';
import { EventRosterRequestsRepository } from '~/repositories/EventRosterRequestsRepository.js';
import { EventRostersRepository } from '~/repositories/EventRostersRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { EventRosterProvisioningService } from '~/services/EventRosterProvisioningService.js';
import { isAttendingRsvpResponse } from '~/utils/rsvpAttendance.js';

const forbidden = new EventRosterApi.Forbidden();
const eventNotFound = new EventRosterApi.EventNotFound();
const rosterNotFound = new EventRosterApi.RosterNotFound();
const alreadyLinked = new EventRosterApi.AlreadyLinked();
const requestNotFound = new EventRosterApi.RequestNotFound();
const requestAlreadyHandled = new EventRosterApi.RequestAlreadyHandled();

export const EventRosterApiLive = HttpApiBuilder.group(Api, 'eventRoster', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('events', () => EventsRepository.asEffect()),
    Effect.bind('eventRosters', () => EventRostersRepository.asEffect()),
    Effect.bind('requests', () => EventRosterRequestsRepository.asEffect()),
    Effect.bind('rsvps', () => EventRsvpsRepository.asEffect()),
    Effect.bind('rosters', () => RostersRepository.asEffect()),
    Effect.bind('provisioning', () => EventRosterProvisioningService.asEffect()),
    Effect.bind('eventSync', () => EventSyncEventsRepository.asEffect()),
    Effect.map(
      ({ members, events, eventRosters, requests, rsvps, rosters, provisioning, eventSync }) =>
        handlers
          .handle('getEventRosterLink', ({ params: { teamId, eventId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.flatMap(() =>
                eventRosters
                  .findByEventId(eventId)
                  .pipe(Effect.map((link) => Option.map(link, (l) => toEventRosterLink(l)))),
              ),
            ),
          )
          .handle('linkEventRoster', ({ params: { teamId, eventId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'roster:manage', forbidden),
              ),
              Effect.bind('event', () =>
                events.findEventByIdWithDetails(eventId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(eventNotFound),
                      onSome: (ev) =>
                        ev.team_id === teamId ? Effect.succeed(ev) : Effect.fail(eventNotFound),
                    }),
                  ),
                ),
              ),
              Effect.bind('roster', () =>
                rosters.findRosterById(payload.rosterId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(rosterNotFound),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.bind('row', () =>
                eventRosters
                  .link({
                    eventId,
                    rosterId: payload.rosterId,
                    autoApprove: payload.autoApprove,
                  })
                  .pipe(
                    Effect.catchTag('EventRosterAlreadyLinked', () => Effect.fail(alreadyLinked)),
                  ),
              ),
              Effect.map(
                ({ row, roster, event }) =>
                  new EventRosterApi.EventRosterLink({
                    eventRosterId: row.id,
                    eventId: row.event_id,
                    rosterId: row.roster_id,
                    rosterName: roster.name,
                    autoApprove: row.auto_approve,
                    hasOwnerGroup: Option.isSome(event.owner_group_id),
                    memberCount: 0,
                    backfillAdded: Option.none(),
                    backfillCancelled: Option.none(),
                  }),
              ),
            ),
          )
          .handle('createAndLinkRoster', ({ params: { teamId, eventId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'roster:manage', forbidden),
              ),
              Effect.bind('event', () =>
                events.findEventByIdWithDetails(eventId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(eventNotFound),
                      onSome: (ev) =>
                        ev.team_id === teamId ? Effect.succeed(ev) : Effect.fail(eventNotFound),
                    }),
                  ),
                ),
              ),
              Effect.bind('roster', () =>
                rosters
                  .insert({
                    team_id: teamId,
                    name: payload.name,
                    active: true,
                    color: payload.color,
                    emoji: payload.emoji,
                  })
                  .pipe(
                    Effect.catchTag(
                      'NoSuchElementError',
                      LogicError.withMessage(() => 'Failed creating roster — no row returned'),
                    ),
                  ),
              ),
              Effect.bind('row', ({ roster }) =>
                eventRosters
                  .link({
                    eventId,
                    rosterId: roster.id,
                    autoApprove: payload.autoApprove,
                  })
                  .pipe(
                    Effect.catchTag('EventRosterAlreadyLinked', () => Effect.fail(alreadyLinked)),
                  ),
              ),
              Effect.map(
                ({ row, roster, event }) =>
                  new EventRosterApi.EventRosterLink({
                    eventRosterId: row.id,
                    eventId: row.event_id,
                    rosterId: row.roster_id,
                    rosterName: roster.name,
                    autoApprove: row.auto_approve,
                    hasOwnerGroup: Option.isSome(event.owner_group_id),
                    memberCount: 0,
                    backfillAdded: Option.none(),
                    backfillCancelled: Option.none(),
                  }),
              ),
            ),
          )
          .handle('patchEventRosterLink', ({ params: { teamId, eventId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'roster:manage', forbidden),
              ),
              Effect.bind('link', () =>
                eventRosters.findByEventId(eventId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(eventNotFound),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(() => eventRosters.setAutoApprove(eventId, payload.autoApprove)),
              // If toggling auto_approve ON from OFF, run backfill
              Effect.bind('backfillResult', ({ link }) => {
                if (!payload.autoApprove || link.auto_approve) return Effect.succeed(undefined);
                return rsvps.findRsvpsByEventId(eventId).pipe(
                  Effect.flatMap((allRsvps) => {
                    const yesResponders = allRsvps
                      .filter((r) => isAttendingRsvpResponse(r.response))
                      .map((r) => ({
                        team_member_id: r.team_member_id,
                        discord_user_id:
                          Option.none<import('@sideline/domain').Discord.Snowflake>(),
                        display_name: r.display_name,
                      }));
                    return provisioning
                      .backfill({
                        eventId,
                        teamId,
                        rosterId: link.roster_id,
                        yesResponders,
                      })
                      .pipe(Effect.map((r) => r));
                  }),
                );
              }),
              Effect.map(({ link, backfillResult }) =>
                toEventRosterLink({ ...link, auto_approve: payload.autoApprove }, backfillResult),
              ),
            ),
          )
          .handle('unlinkEventRoster', ({ params: { teamId, eventId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'roster:manage', forbidden),
              ),
              // Resolve the link first so we can emit the thread-delete with owners_thread_id
              Effect.bind('link', () =>
                eventRosters.findByEventId(eventId).pipe(Effect.map(Option.getOrUndefined)),
              ),
              // Cancel all pending requests and emit per-message cancel events (best-effort)
              Effect.tap(({ link }) =>
                requests.findPendingByEvent(eventId).pipe(
                  Effect.flatMap((pendingMembers) =>
                    Effect.forEach(
                      pendingMembers,
                      (pending) =>
                        requests.cancel(eventId, pending.team_member_id).pipe(
                          Effect.tap((priorRow) => {
                            if (Option.isNone(priorRow)) return Effect.void;
                            return eventSync
                              .emitEventRosterApprovalCancel(
                                teamId,
                                eventId,
                                link ? link.owners_thread_id : Option.none(),
                                pending.discord_message_id,
                              )
                              .pipe(Effect.ignore);
                          }),
                          Effect.ignore,
                        ),
                      { concurrency: 1 },
                    ),
                  ),
                  Effect.ignore,
                ),
              ),
              // Emit thread-delete so the bot removes the approval thread
              Effect.tap(({ link }) => {
                if (!link) return Effect.void;
                return eventSync
                  .emitEventRosterThreadDelete(teamId, eventId, link.owners_thread_id)
                  .pipe(Effect.ignore);
              }),
              Effect.tap(() => eventRosters.unlink(eventId)),
              Effect.asVoid,
            ),
          )
          .handle('listRosterRequests', ({ params: { teamId, rosterId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'roster:manage', forbidden),
              ),
              Effect.flatMap(() =>
                requests.findPendingByRoster(rosterId).pipe(
                  Effect.map((pending) =>
                    pending.map(
                      (r) =>
                        new EventRosterApi.PendingRequestView({
                          requestId: r.id,
                          eventId: r.event_id,
                          eventTitle: r.event_title,
                          candidateMemberId: r.team_member_id,
                          candidateName: r.display_name,
                          requestedAt: r.requested_at,
                        }),
                    ),
                  ),
                ),
              ),
            ),
          )
          .handle('approveRosterRequest', ({ params: { teamId, rosterId, requestId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'roster:manage', forbidden),
              ),
              Effect.bind('request', () =>
                requests.findById(requestId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(requestNotFound),
                      onSome: (req) =>
                        req.roster_id === rosterId
                          ? Effect.succeed(req)
                          : Effect.fail(requestNotFound),
                    }),
                  ),
                ),
              ),
              Effect.flatMap(({ membership, request }) =>
                provisioning
                  .approve({
                    eventId: request.event_id,
                    teamId,
                    memberId: request.team_member_id,
                    // Web authority: roster:manage — no owner-group check needed
                    deciderMemberId: membership.id,
                  })
                  .pipe(
                    Effect.catchTag('RosterRequestNotPending', () =>
                      Effect.fail(requestAlreadyHandled),
                    ),
                    Effect.catchTag('EventRosterNotFound', () => Effect.fail(requestNotFound)),
                    Effect.map(
                      (result) =>
                        new EventRosterApi.ApproveDeclineResult({
                          outcome: result.outcome,
                          memberDisplayName: result.member_display_name,
                        }),
                    ),
                  ),
              ),
            ),
          )
          .handle('declineRosterRequest', ({ params: { teamId, rosterId, requestId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'roster:manage', forbidden),
              ),
              Effect.bind('request', () =>
                requests.findById(requestId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(requestNotFound),
                      onSome: (req) =>
                        req.roster_id === rosterId
                          ? Effect.succeed(req)
                          : Effect.fail(requestNotFound),
                    }),
                  ),
                ),
              ),
              Effect.flatMap(({ membership, request }) =>
                provisioning
                  .decline({
                    eventId: request.event_id,
                    teamId,
                    memberId: request.team_member_id,
                    // Web authority: roster:manage — no owner-group check needed
                    deciderMemberId: membership.id,
                  })
                  .pipe(
                    Effect.catchTag('RosterRequestNotPending', () =>
                      Effect.fail(requestAlreadyHandled),
                    ),
                    Effect.catchTag('EventRosterNotFound', () => Effect.fail(requestNotFound)),
                    Effect.map(
                      (result) =>
                        new EventRosterApi.ApproveDeclineResult({
                          outcome: result.outcome,
                          memberDisplayName: result.member_display_name,
                        }),
                    ),
                  ),
              ),
            ),
          ),
    ),
  ),
);

const toEventRosterLink = (
  link: {
    readonly id: import('@sideline/domain').EventRosterModel.EventRosterId;
    readonly event_id: import('@sideline/domain').Event.EventId;
    readonly roster_id: RosterModel.RosterId;
    readonly auto_approve: boolean;
    readonly roster_name: string;
    readonly owner_group_id: Option.Option<unknown>;
    readonly member_count: number;
  },
  backfill?: { readonly added: number; readonly cancelled: number },
): EventRosterApi.EventRosterLink =>
  new EventRosterApi.EventRosterLink({
    eventRosterId: link.id,
    eventId: link.event_id,
    rosterId: link.roster_id,
    rosterName: link.roster_name,
    autoApprove: link.auto_approve,
    hasOwnerGroup: Option.isSome(link.owner_group_id),
    memberCount: link.member_count,
    backfillAdded: backfill !== undefined ? Option.some(backfill.added) : Option.none(),
    backfillCancelled: backfill !== undefined ? Option.some(backfill.cancelled) : Option.none(),
  });
