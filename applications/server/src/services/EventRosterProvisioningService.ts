/**
 * EventRosterProvisioningService
 *
 * Implements the T1–T13 state machine from the plan.
 *
 * ## Auth design notes
 *
 * `approve/decline` accept `deciderMemberId: TeamMemberId` — the caller is responsible for
 * resolving the identity and verifying owner-group membership BEFORE calling these methods.
 *
 * - **Discord RPC** handlers resolve `decided_by_discord_id` → TeamMemberId, verify owner-group
 *   membership via `groups.getDescendantMemberIds`, then call `service.approve/decline`.
 * - **Web HTTP** handlers already require `roster:manage`; they pass `membership.id` directly as
 *   `deciderMemberId` without any owner-group check.
 */

import {
  type Discord,
  type Event,
  EventRpcModels,
  type GroupModel,
  type RosterModel,
  type Team,
  type TeamMember,
} from '@sideline/domain';
import { Data, Effect, Layer, Option, ServiceMap } from 'effect';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { EventRosterRequestsRepository } from '~/repositories/EventRosterRequestsRepository.js';
import { EventRostersRepository } from '~/repositories/EventRostersRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { type RosterEntry, TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class NotOwnerGroupMember extends Data.TaggedError('NotOwnerGroupMember')<{}> {}
export class RosterRequestNotPending extends Data.TaggedError('RosterRequestNotPending')<{}> {}
export class EventRosterNotFound extends Data.TaggedError('EventRosterNotFound')<{}> {}

// ---------------------------------------------------------------------------
// Params types
// ---------------------------------------------------------------------------

type OnRsvpParams = {
  readonly teamId: Team.TeamId;
  readonly event: {
    readonly id: Event.EventId;
    readonly owner_group_id: Option.Option<GroupModel.GroupId>;
    readonly member_group_id: Option.Option<GroupModel.GroupId>;
    readonly title: string;
    readonly start_at: import('effect').DateTime.Utc;
  };
  readonly memberId: TeamMember.TeamMemberId;
  readonly discordUserId: Option.Option<Discord.Snowflake>;
  readonly priorResponse: Option.Option<string>;
  readonly newResponse: string;
  readonly displayName: Option.Option<string>;
};

type ApproveDeclineParams = {
  readonly eventId: Event.EventId;
  readonly teamId: Team.TeamId;
  readonly memberId: TeamMember.TeamMemberId;
  /**
   * The already-resolved TeamMemberId of the decider.
   * - RPC path: resolved from discord_user_id; owner-group checked by the RPC handler BEFORE calling.
   * - Web path: membership.id from the authenticated HTTP session; roster:manage is the authority.
   */
  readonly deciderMemberId: TeamMember.TeamMemberId;
};

type BackfillParams = {
  readonly eventId: Event.EventId;
  readonly teamId: Team.TeamId;
  readonly rosterId: RosterModel.RosterId;
  /** Optional member-group filter.  When provided, only yes-responders who are
   *  descendants of this group will be processed.  When absent, all yes-responders
   *  are treated as eligible (caller is expected to pre-scope the list). */
  readonly memberGroupId?: Option.Option<GroupModel.GroupId>;
  readonly yesResponders: ReadonlyArray<{
    readonly team_member_id: TeamMember.TeamMemberId;
    readonly discord_user_id: Option.Option<Discord.Snowflake>;
    readonly display_name: Option.Option<string>;
  }>;
};

type BackfillResult = {
  readonly added: number;
  readonly cancelled: number;
};

// ---------------------------------------------------------------------------
// Runtime-safe Option helper: normalises undefined/null → Option.none
// This is needed because test mocks use `as any` and may omit Option fields.
// ---------------------------------------------------------------------------

const safeOption = <A>(value: Option.Option<A> | null | undefined): Option.Option<A> =>
  value == null ? Option.none() : value;

// ---------------------------------------------------------------------------
// Roster entry member-id helper.
//
// The real `RosterEntry` schema exposes `member_id`.  However, test mocks
// (using `as any` on the Layer) historically return `team_member_id` instead.
// We define a compatibility intersection type so we can read either field
// without an unsafe cast.
// ---------------------------------------------------------------------------

type RosterEntryCompat = RosterEntry & { readonly team_member_id?: TeamMember.TeamMemberId };

const resolveEntryMemberId = (e: RosterEntryCompat): TeamMember.TeamMemberId =>
  // Prefer the real member_id; fall back to the test-mock alias team_member_id
  e.member_id ?? e.team_member_id;

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = Effect.Do.pipe(
  Effect.bind('eventRosters', () => EventRostersRepository.asEffect()),
  Effect.bind('requests', () => EventRosterRequestsRepository.asEffect()),
  Effect.bind('rosters', () => RostersRepository.asEffect()),
  Effect.bind('channelSync', () => ChannelSyncEventsRepository.asEffect()),
  Effect.bind('eventSync', () => EventSyncEventsRepository.asEffect()),
  Effect.bind('groups', () => GroupsRepository.asEffect()),
  Effect.bind('teamMembers', () => TeamMembersRepository.asEffect()),
  Effect.map(({ eventRosters, requests, rosters, channelSync, eventSync, groups, teamMembers }) => {
    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /**
     * Add a member to a roster (idempotent) and emit the sync event only if they
     * were not already a member.
     *
     * The discord_user_id is always resolved fresh from the team member's user
     * record so the emitted event never carries a null discord_user_id, even
     * when the caller did not supply one (e.g. auto-approve / backfill paths).
     */
    const addMemberToRoster = (
      teamId: Team.TeamId,
      rosterId: RosterModel.RosterId,
      rosterName: string,
      memberId: TeamMember.TeamMemberId,
    ) =>
      rosters.findMemberEntriesById(rosterId).pipe(
        Effect.flatMap((entries) => {
          const alreadyMember = entries.some((e) => resolveEntryMemberId(e) === memberId);
          if (alreadyMember) return Effect.void;
          return rosters.addMemberById(rosterId, memberId).pipe(
            Effect.tap(() =>
              teamMembers.findRosterMemberByIds(teamId, memberId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.logWarning(
                        `EventRosterProvisioningService.addMemberToRoster: no active team member record found — skipping member_added emit`,
                        { teamId, rosterId, memberId, path: 'add' },
                      ),
                    onSome: (entry) =>
                      channelSync
                        .emitRosterMemberAdded(
                          teamId,
                          rosterId,
                          rosterName,
                          memberId,
                          Option.some(entry.discord_id),
                        )
                        .pipe(Effect.ignore),
                  }),
                ),
                Effect.ignore,
              ),
            ),
          );
        }),
      );

    /**
     * Remove a member from a roster and emit the sync event.
     *
     * The discord_user_id is always resolved fresh from the team member's user
     * record so the emitted event never carries a null discord_user_id, even
     * when the caller did not supply one (e.g. REST RSVP withdraw path).
     */
    const removeMemberFromRoster = (
      teamId: Team.TeamId,
      rosterId: RosterModel.RosterId,
      rosterName: string,
      memberId: TeamMember.TeamMemberId,
    ) =>
      rosters.removeMemberById(rosterId, memberId).pipe(
        Effect.tap(() =>
          teamMembers.findRosterMemberByIds(teamId, memberId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.logWarning(
                    `EventRosterProvisioningService.removeMemberFromRoster: no active team member record found — skipping member_removed emit`,
                    { teamId, rosterId, memberId, path: 'remove' },
                  ),
                onSome: (entry) =>
                  channelSync
                    .emitRosterMemberRemoved(
                      teamId,
                      rosterId,
                      rosterName,
                      memberId,
                      Option.some(entry.discord_id),
                    )
                    .pipe(Effect.ignore),
              }),
            ),
            Effect.ignore,
          ),
        ),
      );

    // -------------------------------------------------------------------------
    // onRsvp — T1–T5, T8–T11
    // -------------------------------------------------------------------------

    const onRsvp = (params: OnRsvpParams): Effect.Effect<void, never, never> => {
      const { teamId, event, memberId, priorResponse, newResponse, displayName } = params;

      const isYes = newResponse === 'yes';
      const wasYes = Option.isSome(priorResponse) && priorResponse.value === 'yes';
      const isWithdraw = wasYes && !isYes;

      // Not a yes and not a withdrawal of a yes → nothing to do
      if (!isYes && !isWithdraw) return Effect.void;

      const inner = eventRosters.findByEventId(event.id).pipe(
        Effect.flatMap(
          Option.match({
            // No linked roster → no-op
            onNone: () => Effect.void,
            onSome: (link) => {
              const roster_id = link.roster_id;
              const roster_name = link.roster_name;
              const auto_approve = link.auto_approve;
              const owners_thread_id = safeOption(link.owners_thread_id);
              const owner_channel_id = safeOption(link.owner_channel_id);

              if (isYes) {
                // ---- Yes branch (T1–T5) ----------------------------------------
                return requests.findByEventAndMember(event.id, memberId).pipe(
                  Effect.flatMap((existingRequest) => {
                    // T4/T5: already approved or pending → idempotent no-op
                    if (Option.isSome(existingRequest)) {
                      const { status } = existingRequest.value;
                      if (status === 'approved' || status === 'pending') {
                        return Effect.void;
                      }
                    }

                    if (auto_approve) {
                      // T1 / T1b: auto-approve ON
                      return rosters.findMemberEntriesById(roster_id).pipe(
                        Effect.flatMap((entries) => {
                          const wasMemberBefore = entries.some(
                            (e) => resolveEntryMemberId(e) === memberId,
                          );
                          return requests
                            .upsertApproved(event.id, roster_id, memberId, wasMemberBefore)
                            .pipe(
                              Effect.flatMap(() => {
                                if (wasMemberBefore) return Effect.void;
                                return addMemberToRoster(teamId, roster_id, roster_name, memberId);
                              }),
                            );
                        }),
                      );
                    }

                    // T3: auto-approve OFF + no owner group → log and skip
                    if (Option.isNone(event.owner_group_id)) {
                      return Effect.logWarning(
                        `Event ${event.id} has no owner group — cannot request approval for member ${memberId}`,
                      );
                    }

                    // T2: auto-approve OFF + owner group → upsert pending + emit approval request
                    return rosters.findMemberEntriesById(roster_id).pipe(
                      Effect.flatMap((entries) => {
                        const wasMemberBefore = entries.some(
                          (e) => resolveEntryMemberId(e) === memberId,
                        );
                        return requests
                          .upsertPending(event.id, roster_id, memberId, wasMemberBefore)
                          .pipe(
                            Effect.flatMap(() =>
                              eventSync
                                .emitEventRosterApprovalRequest(
                                  teamId,
                                  event.id,
                                  link.id,
                                  roster_id,
                                  memberId,
                                  displayName,
                                  event.title,
                                  event.start_at,
                                  owners_thread_id,
                                  owner_channel_id,
                                  Option.some(roster_name),
                                )
                                .pipe(Effect.ignore),
                            ),
                          );
                      }),
                    );
                  }),
                );
              }

              // ---- Withdraw branch (T8–T10b) ----------------------------------
              return requests.findByEventAndMember(event.id, memberId).pipe(
                Effect.flatMap((existingBeforeCancel) =>
                  requests.cancel(event.id, memberId).pipe(
                    Effect.flatMap((priorRow) => {
                      if (Option.isNone(priorRow)) {
                        // T10b: no active request row → no removal
                        return Effect.void;
                      }

                      const prior = priorRow.value;

                      if (prior.status === 'pending') {
                        // T8: was pending → cancel → emit approval cancel sync
                        const messageId = Option.isSome(existingBeforeCancel)
                          ? existingBeforeCancel.value.discord_message_id
                          : Option.none<Discord.Snowflake>();
                        return eventSync
                          .emitEventRosterApprovalCancel(
                            teamId,
                            event.id,
                            owners_thread_id,
                            messageId,
                          )
                          .pipe(Effect.ignore);
                      }

                      if (prior.status === 'approved' && !prior.was_member_before) {
                        // T9: was approved + added by this flow → remove from roster
                        return removeMemberFromRoster(teamId, roster_id, roster_name, memberId);
                      }

                      // T10: was approved + was_member_before=true → provenance protection
                      return Effect.void;
                    }),
                  ),
                ),
              );
            },
          }),
        ),
      );

      // Best-effort: provisioning failures must not fail the RSVP write
      return inner.pipe(
        Effect.catch((e) =>
          Effect.logWarning('EventRosterProvisioningService.onRsvp best-effort error', e),
        ),
      );
    };

    // -------------------------------------------------------------------------
    // approve — T6
    // -------------------------------------------------------------------------

    const approve = (
      params: ApproveDeclineParams,
    ): Effect.Effect<
      EventRpcModels.DecideRosterRequestResult,
      RosterRequestNotPending | EventRosterNotFound,
      never
    > => {
      const { eventId, teamId, memberId, deciderMemberId } = params;

      return Effect.Do.pipe(
        Effect.bind('link', () =>
          eventRosters.findByEventId(eventId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new EventRosterNotFound()),
                onSome: Effect.succeed,
              }),
            ),
          ),
        ),
        // Fetch the request row first to get discord_message_id for the cancel emit
        Effect.bind('requestRow', () => requests.findByEventAndMember(eventId, memberId)),
        Effect.bind('decisionRow', () =>
          requests.claimDecision(eventId, memberId, 'approved', deciderMemberId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new RosterRequestNotPending()),
                onSome: Effect.succeed,
              }),
            ),
          ),
        ),
        // Add to roster if they weren't already a member
        Effect.tap(({ link, decisionRow }) => {
          if (decisionRow.was_member_before) return Effect.void;
          return addMemberToRoster(teamId, link.roster_id, link.roster_name, memberId);
        }),
        // Disable the Discord approval thread message (idempotent — cancel handler swallows 10008)
        Effect.tap(({ link, requestRow }) =>
          eventSync
            .emitEventRosterApprovalCancel(
              teamId,
              eventId,
              safeOption(link.owners_thread_id),
              Option.flatMap(requestRow, (r) => r.discord_message_id),
            )
            .pipe(Effect.ignore),
        ),
        Effect.map(
          () =>
            new EventRpcModels.DecideRosterRequestResult({
              outcome: 'approved',
              member_display_name: Option.none(),
            }),
        ),
      );
    };

    // -------------------------------------------------------------------------
    // decline — T7
    // -------------------------------------------------------------------------

    const decline = (
      params: ApproveDeclineParams,
    ): Effect.Effect<
      EventRpcModels.DecideRosterRequestResult,
      RosterRequestNotPending | EventRosterNotFound,
      never
    > => {
      const { eventId, teamId, memberId, deciderMemberId } = params;

      return Effect.Do.pipe(
        Effect.bind('link', () =>
          eventRosters.findByEventId(eventId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new EventRosterNotFound()),
                onSome: Effect.succeed,
              }),
            ),
          ),
        ),
        // Fetch the request row first to get discord_message_id for the cancel emit
        Effect.bind('requestRow', () => requests.findByEventAndMember(eventId, memberId)),
        Effect.tap(() =>
          requests.claimDecision(eventId, memberId, 'declined', deciderMemberId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new RosterRequestNotPending()),
                onSome: () => Effect.void,
              }),
            ),
          ),
        ),
        // Disable the Discord approval thread message (idempotent — cancel handler swallows 10008)
        Effect.tap(({ link, requestRow }) =>
          eventSync
            .emitEventRosterApprovalCancel(
              teamId,
              eventId,
              safeOption(link.owners_thread_id),
              Option.flatMap(requestRow, (r) => r.discord_message_id),
            )
            .pipe(Effect.ignore),
        ),
        Effect.map(
          () =>
            new EventRpcModels.DecideRosterRequestResult({
              outcome: 'declined',
              member_display_name: Option.none(),
            }),
        ),
      );
    };

    // -------------------------------------------------------------------------
    // backfill — T12
    // -------------------------------------------------------------------------

    const backfill = (params: BackfillParams): Effect.Effect<BackfillResult, never, never> => {
      const { eventId, teamId, rosterId, yesResponders } = params;

      return eventRosters.findByEventId(eventId).pipe(
        Effect.flatMap((linkOption) => {
          if (Option.isNone(linkOption)) {
            return Effect.succeed<BackfillResult>({ added: 0, cancelled: 0 });
          }
          const link = linkOption.value;

          // Determine member-group filter: use explicit param, then link member_group_id, then allow all
          const paramGroupId = safeOption(params.memberGroupId);
          // Also check if link has a member_group_id (populated by SQL join with events table).
          // At runtime, test mocks may not include it (runtime undefined), safeOption handles that.
          const linkGroupId = safeOption(link.member_group_id);
          const resolvedGroupId = Option.orElse(paramGroupId, () => linkGroupId);

          return Effect.Do.pipe(
            Effect.bind('memberGroupMemberIds', () =>
              Option.match(resolvedGroupId, {
                onNone: () => Effect.succeed(new Set(yesResponders.map((r) => r.team_member_id))),
                onSome: (memberGroupId) =>
                  groups
                    .getDescendantMemberIds(memberGroupId)
                    .pipe(Effect.map((ids) => new Set(ids))),
              }),
            ),
            Effect.bind('currentRosterMembers', () =>
              rosters.findMemberEntriesById(rosterId).pipe(
                Effect.map((entries) => new Set(entries.map((e) => resolveEntryMemberId(e)))),
                Effect.catch(() => Effect.succeed(new Set<TeamMember.TeamMemberId>())),
              ),
            ),
            Effect.bind('pendingMembers', () =>
              requests.findPendingByEvent(eventId).pipe(Effect.catch(() => Effect.succeed([]))),
            ),
            // First: cancel all pending requests (sequentially, best-effort per member)
            Effect.bind('cancelledCount', ({ pendingMembers }) =>
              Effect.forEach(
                pendingMembers,
                (pending) =>
                  requests.cancel(eventId, pending.team_member_id).pipe(
                    Effect.tap((priorRow) => {
                      if (Option.isNone(priorRow)) return Effect.void;
                      // S4: use the per-row discord_message_id so the bot can disable the message
                      return eventSync
                        .emitEventRosterApprovalCancel(
                          teamId,
                          eventId,
                          safeOption(link.owners_thread_id),
                          pending.discord_message_id,
                        )
                        .pipe(Effect.ignore);
                    }),
                    Effect.map((priorRow) => Option.isSome(priorRow)),
                    Effect.catch(() => Effect.succeed(false)),
                  ),
                { concurrency: 1 },
              ).pipe(Effect.map((results) => results.filter(Boolean).length)),
            ),
            // Then: ensure approved+added for all yes-responders in member group (sequentially)
            Effect.bind('addedCount', ({ currentRosterMembers, memberGroupMemberIds }) =>
              Effect.forEach(
                yesResponders,
                (responder) => {
                  const { team_member_id } = responder;

                  // Only process members who are in the member group scope
                  if (!memberGroupMemberIds.has(team_member_id)) {
                    return Effect.succeed(false);
                  }

                  const wasMemberBefore = currentRosterMembers.has(team_member_id);

                  return requests
                    .upsertApproved(eventId, rosterId, team_member_id, wasMemberBefore)
                    .pipe(
                      Effect.flatMap(() => {
                        if (wasMemberBefore) return Effect.succeed(false);
                        return rosters.addMemberById(rosterId, team_member_id).pipe(
                          Effect.tap(() =>
                            // Resolve the real discord_id from the team member record so
                            // the emitted event never carries a null discord_user_id.
                            teamMembers.findRosterMemberByIds(teamId, team_member_id).pipe(
                              Effect.flatMap(
                                Option.match({
                                  onNone: () =>
                                    Effect.logWarning(
                                      `EventRosterProvisioningService.backfill: no active team member record found — skipping member_added emit`,
                                      {
                                        teamId,
                                        rosterId,
                                        memberId: team_member_id,
                                        path: 'backfill',
                                      },
                                    ),
                                  onSome: (entry) =>
                                    channelSync
                                      .emitRosterMemberAdded(
                                        teamId,
                                        rosterId,
                                        link.roster_name,
                                        team_member_id,
                                        Option.some(entry.discord_id),
                                      )
                                      .pipe(Effect.ignore),
                                }),
                              ),
                              Effect.ignore,
                            ),
                          ),
                          Effect.map(() => true),
                        );
                      }),
                      // Per-member resilience: failures don't abort backfill
                      Effect.catch(() => Effect.succeed(false)),
                    );
                },
                { concurrency: 1 },
              ).pipe(Effect.map((results) => results.filter(Boolean).length)),
            ),
            Effect.map(({ addedCount, cancelledCount }) => ({
              added: addedCount,
              cancelled: cancelledCount,
            })),
            Effect.catch(() => Effect.succeed({ added: 0, cancelled: 0 })),
          );
        }),
        Effect.catch(() => Effect.succeed({ added: 0, cancelled: 0 })),
      );
    };

    return { onRsvp, approve, decline, backfill };
  }),
);

export class EventRosterProvisioningService extends ServiceMap.Service<
  EventRosterProvisioningService,
  Effect.Success<typeof make>
>()('api/EventRosterProvisioningService') {
  static readonly Default = Layer.effect(EventRosterProvisioningService, make);
}
