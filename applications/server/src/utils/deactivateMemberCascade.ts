import type { Discord, GroupModel, RosterModel, Team, TeamMember } from '@sideline/domain';
import { Effect, Option } from 'effect';
import type { SqlClient } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

export type CascadeDeps = {
  readonly sql: SqlClient.SqlClient;
  readonly members: {
    readonly findById: (
      id: TeamMember.TeamMemberId,
    ) => Effect.Effect<Option.Option<{ readonly active: boolean }>, never>;
    readonly deactivateMemberByIds: (
      teamId: Team.TeamId,
      memberId: TeamMember.TeamMemberId,
    ) => Effect.Effect<void, never>;
    readonly hasOtherActiveManager: (
      teamId: Team.TeamId,
      excludeMemberId: TeamMember.TeamMemberId,
    ) => Effect.Effect<boolean, never>;
  };
  readonly rosters: {
    readonly findRosterIdsByMember: (
      memberId: TeamMember.TeamMemberId,
    ) => Effect.Effect<readonly RosterModel.RosterId[], never>;
    readonly findRosterById: (
      rosterId: RosterModel.RosterId,
    ) => Effect.Effect<Option.Option<{ readonly name: string }>, never>;
    readonly removeAllForMember: (memberId: TeamMember.TeamMemberId) => Effect.Effect<void, never>;
  };
  readonly groups: {
    readonly findGroupIdsByMember: (
      memberId: TeamMember.TeamMemberId,
    ) => Effect.Effect<readonly GroupModel.GroupId[], never>;
    readonly findGroupById: (
      groupId: GroupModel.GroupId,
    ) => Effect.Effect<Option.Option<{ readonly name: string }>, never>;
    readonly getAncestors: (
      groupId: GroupModel.GroupId,
    ) => Effect.Effect<
      readonly { readonly id: GroupModel.GroupId; readonly name: string }[],
      never
    >;
    readonly removeAllForMember: (memberId: TeamMember.TeamMemberId) => Effect.Effect<void, never>;
  };
  readonly channelSync: {
    readonly emitRosterMemberRemoved: (
      teamId: Team.TeamId,
      rosterId: RosterModel.RosterId,
      rosterName: string,
      memberId: TeamMember.TeamMemberId,
      discordUserId: Option.Option<Discord.Snowflake>,
    ) => Effect.Effect<void, never>;
    readonly emitMemberRemoved: (
      teamId: Team.TeamId,
      groupId: GroupModel.GroupId,
      groupName: string,
      memberId: TeamMember.TeamMemberId,
      discordUserId: Discord.Snowflake,
    ) => Effect.Effect<void, never>;
  };
};

export type DeactivateMemberCascadeResult =
  | { readonly deactivated: true }
  | { readonly deactivated: false; readonly reason: 'already_inactive' | 'last_admin' };

/**
 * Deactivate a team member and cascade all side effects inside a single transaction:
 * 1. Guard: if already inactive → no-op, returns { deactivated: false, reason: 'already_inactive' }.
 * 2. Owner guard: if this is the last active manager of the team → no-op + warning,
 *    returns { deactivated: false, reason: 'last_admin' }.
 * 3. Capture roster + group ids BEFORE deleting.
 * 4. Emit `member_removed` channel-sync events for all rosters and groups (including ancestor groups).
 * 5. Deactivate the team_members row.
 * 6. Hard-delete roster + group memberships.
 * Returns { deactivated: true } on success.
 */
export const deactivateMemberAndCascade = (
  deps: CascadeDeps,
  teamId: Team.TeamId,
  memberId: TeamMember.TeamMemberId,
  memberHoldsManage: boolean,
  discordUserId: Discord.Snowflake,
): Effect.Effect<DeactivateMemberCascadeResult, never> => {
  const txBody: Effect.Effect<DeactivateMemberCascadeResult> = Effect.Do.pipe(
    // Serialize cascades for the same team to prevent a race where two managers
    // leave simultaneously, both pass hasOtherActiveManager, and both deactivate
    // → zero managers remain.
    Effect.tap(() =>
      deps.sql`SELECT pg_advisory_xact_lock(hashtext(${teamId}))`.pipe(catchSqlErrors),
    ),
    Effect.bind('memberRow', () => deps.members.findById(memberId)),
    Effect.flatMap(({ memberRow }) => {
      if (Option.isNone(memberRow) || !memberRow.value.active) {
        return Effect.succeed<DeactivateMemberCascadeResult>({
          deactivated: false,
          reason: 'already_inactive',
        });
      }
      return Effect.Do.pipe(
        Effect.bind('hasOtherManager', () =>
          memberHoldsManage
            ? deps.members.hasOtherActiveManager(teamId, memberId)
            : Effect.succeed(true),
        ),
        Effect.flatMap(({ hasOtherManager }) => {
          if (!hasOtherManager) {
            return Effect.logWarning(
              `deactivateMemberAndCascade: member ${memberId} is the last active manager of team ${teamId}; skipping deactivation to avoid orphaning the team`,
            ).pipe(
              Effect.as<DeactivateMemberCascadeResult>({
                deactivated: false,
                reason: 'last_admin',
              }),
            );
          }
          return Effect.Do.pipe(
            // Capture roster + group memberships BEFORE deleting them (needed for emit payloads)
            Effect.bind('rosterIds', () => deps.rosters.findRosterIdsByMember(memberId)),
            Effect.bind('groupIds', () => deps.groups.findGroupIdsByMember(memberId)),
            // Emit member_removed events for rosters
            Effect.tap(({ rosterIds }) =>
              Effect.forEach(
                rosterIds,
                (rosterId) =>
                  deps.rosters.findRosterById(rosterId).pipe(
                    Effect.flatMap(
                      Option.match({
                        onNone: () => Effect.void,
                        onSome: (roster) =>
                          deps.channelSync.emitRosterMemberRemoved(
                            teamId,
                            rosterId,
                            roster.name,
                            memberId,
                            Option.some(discordUserId),
                          ),
                      }),
                    ),
                  ),
                { concurrency: 'unbounded' },
              ),
            ),
            // Emit member_removed events for groups + ancestor groups
            Effect.tap(({ groupIds }) =>
              Effect.forEach(
                groupIds,
                (groupId) =>
                  deps.groups.findGroupById(groupId).pipe(
                    Effect.flatMap(
                      Option.match({
                        onNone: () => Effect.void,
                        onSome: (group) =>
                          Effect.all(
                            [
                              deps.channelSync.emitMemberRemoved(
                                teamId,
                                groupId,
                                group.name,
                                memberId,
                                discordUserId,
                              ),
                              deps.groups
                                .getAncestors(groupId)
                                .pipe(
                                  Effect.flatMap((ancestors) =>
                                    Effect.forEach(ancestors, (ancestor) =>
                                      deps.channelSync.emitMemberRemoved(
                                        teamId,
                                        ancestor.id,
                                        ancestor.name,
                                        memberId,
                                        discordUserId,
                                      ),
                                    ),
                                  ),
                                ),
                            ],
                            { concurrency: 'unbounded' },
                          ),
                      }),
                    ),
                  ),
                { concurrency: 'unbounded' },
              ),
            ),
            // Deactivate the member row
            Effect.tap(() => deps.members.deactivateMemberByIds(teamId, memberId)),
            // Hard-delete group and roster memberships (AFTER emits)
            Effect.tap(() => deps.groups.removeAllForMember(memberId)),
            Effect.tap(() => deps.rosters.removeAllForMember(memberId)),
            Effect.as<DeactivateMemberCascadeResult>({ deactivated: true }),
          );
        }),
      );
    }),
  );

  return deps.sql.withTransaction(txBody).pipe(catchSqlErrors);
};
