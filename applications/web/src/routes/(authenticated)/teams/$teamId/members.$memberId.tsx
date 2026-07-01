import type { ActivityLog, Auth, GroupApi } from '@sideline/domain';
import {
  ActivityLogApi,
  type ActivityType,
  GroupModel,
  Role,
  Roster,
  RosterModel,
  Team,
  TeamMember,
} from '@sideline/domain';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import React from 'react';
import type { PlayerEditValues } from '~/components/pages/PlayerDetailPage';
import { PlayerDetailPage } from '~/components/pages/PlayerDetailPage';
import type { Client } from '~/lib/runtime';
import { ApiClient, ClientError, useRun, warnAndCatchAll } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/members/$memberId')({
  ssr: false,
  component: MemberDetailRoute,
  loader: async ({ params, context }) => {
    const teamId = Schema.decodeSync(Team.TeamId)(params.teamId);
    const memberId = Schema.decodeSync(TeamMember.TeamMemberId)(params.memberId);
    return ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.auth.myTeams().pipe(
          Effect.flatMap((myTeams) => {
            const myPermissions =
              myTeams.find((t: Auth.UserTeam) => t.teamId === params.teamId)?.permissions ?? [];
            const canEdit = myPermissions.includes('member:edit');
            const canViewRosters = myPermissions.includes('roster:view');
            const canManageGroups = myPermissions.includes('group:manage');
            return Effect.all({
              player: api.roster.getMember({ params: { teamId, memberId } }),
              myTeams: Effect.succeed(myTeams),
              roles: api.role.listRoles({ params: { teamId } }),
              activityStats: api.activityStats.getMemberStats({ params: { teamId, memberId } }),
              activityLogs: api.activityLog.listLogs({ params: { teamId, memberId } }).pipe(
                Effect.map((r) => ({ isOwnProfile: true as boolean, logs: r.logs })),
                Effect.catch(() =>
                  Effect.succeed({ isOwnProfile: false as boolean, logs: [] as const }),
                ),
              ),
              activityTypes: api.activityType.listActivityTypes({ params: { teamId } }),
              rating: canEdit
                ? api.playerRating.getMemberRating({ params: { teamId, memberId } }).pipe(
                    Effect.tapError((e) => Effect.logWarning('Failed to load member rating', e)),
                    Effect.catch(() => Effect.succeed(undefined)),
                  )
                : Effect.succeed(undefined),
              rosterList: canViewRosters
                ? api.roster.listRosters({ params: { teamId } })
                : Effect.succeed(new Roster.RosterListResponse({ canManage: false, rosters: [] })),
              memberRosters: api.roster.listMemberRosters({ params: { teamId, memberId } }),
              groups: canManageGroups
                ? api.group.listGroups({ params: { teamId } })
                : Effect.succeed([]),
              memberGroups: api.group.listMemberGroups({ params: { teamId, memberId } }),
            });
          }),
        ),
      ),
      warnAndCatchAll,
      context.run,
    );
  },
});

function MemberDetailRoute() {
  const { teamId: teamIdRaw, memberId: memberIdRaw } = Route.useParams();
  const teamId = Schema.decodeSync(Team.TeamId)(teamIdRaw);
  const memberId = Schema.decodeSync(TeamMember.TeamMemberId)(memberIdRaw);
  const router = useRouter();
  const run = useRun();
  const {
    player,
    myTeams,
    roles: roleListResponse,
    activityStats,
    activityLogs,
    activityTypes: fetchedActivityTypes,
    rating,
    rosterList,
    memberRosters,
    groups,
    memberGroups,
  } = Route.useLoaderData();
  const roles = roleListResponse.roles;

  const memberRosterIds = new Set(memberRosters.map((r: Roster.RosterInfo) => r.rosterId));
  const assignableRosters = rosterList.rosters.filter(
    (r: Roster.RosterInfo) => !memberRosterIds.has(r.rosterId),
  );
  const memberGroupIds = new Set(memberGroups.map((g: GroupApi.GroupInfo) => g.groupId));
  const assignableGroups = groups.filter((g: GroupApi.GroupInfo) => !memberGroupIds.has(g.groupId));

  const activityTypes = React.useMemo(
    () =>
      fetchedActivityTypes.activityTypes.filter(
        (t: { slug: Option.Option<string> }) =>
          Option.isNone(t.slug) || t.slug.value !== 'training',
      ),
    [fetchedActivityTypes],
  );

  // Use the current user's permissions for this team, not the target player's
  const myPermissions =
    myTeams.find((t: Auth.UserTeam) => t.teamId === teamIdRaw)?.permissions ?? [];
  const canEdit = myPermissions.includes('member:edit');
  const canManageRoles = myPermissions.includes('role:manage' as Role.Permission);
  const canManageRosters = myPermissions.includes('roster:manage');
  const canManageGroups = myPermissions.includes('group:manage');
  const canRemoveMember = myPermissions.includes('member:remove');

  // Shared shape for the mutation handlers below: run an API call through the Effect
  // runtime, map failures to a ClientError with the given message, show a success toast,
  // and invalidate the route loader data on success. Returns whether the call succeeded.
  const runMutation = React.useCallback(
    async (options: {
      readonly apiCall: (api: Client) => Effect.Effect<unknown, unknown>;
      readonly errorMessage: string;
      readonly successMessage: string;
    }): Promise<boolean> => {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap(options.apiCall),
        Effect.mapError(() => ClientError.make(options.errorMessage)),
        run({ success: options.successMessage }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
        return true;
      }
      return false;
    },
    [run, router],
  );

  const handleSave = React.useCallback(
    async (values: PlayerEditValues) => {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.roster.updateMember({
            params: { teamId, memberId },
            payload: {
              name: Option.fromNullishOr(values.name),
              birthDate: values.birthDate ? Option.some(values.birthDate) : Option.none(),
              gender: Option.fromNullishOr(values.gender),
              jerseyNumber: Option.fromNullishOr(values.jerseyNumber),
            },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('members_saveFailed'))),
        run({ success: tr('members_playerSaved') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
        return true;
      }
      return false;
    },
    [teamId, memberId, run, router],
  );

  const handleAssignRole = React.useCallback(
    async (roleId: string) => {
      await runMutation({
        apiCall: (api) =>
          api.role.assignRole({
            params: { teamId, memberId },
            payload: { roleId: Schema.decodeSync(Role.RoleId)(roleId) },
          }),
        errorMessage: tr('roles_assignFailed'),
        successMessage: tr('role_roleAssigned'),
      });
    },
    [teamId, memberId, runMutation],
  );

  const handleUnassignRole = React.useCallback(
    async (roleId: string) => {
      await runMutation({
        apiCall: (api) =>
          api.role.unassignRole({
            params: { teamId, memberId, roleId: Schema.decodeSync(Role.RoleId)(roleId) },
          }),
        errorMessage: tr('roles_unassignFailed'),
        successMessage: tr('role_roleUnassigned'),
      });
    },
    [teamId, memberId, runMutation],
  );

  const handleAddToRoster = React.useCallback(
    async (rosterIdRaw: string) => {
      await runMutation({
        apiCall: (api) =>
          api.roster.addRosterMember({
            params: { teamId, rosterId: Schema.decodeSync(RosterModel.RosterId)(rosterIdRaw) },
            payload: { memberId },
          }),
        errorMessage: tr('roster_updateFailed'),
        successMessage: tr('roster_memberAdded'),
      });
    },
    [teamId, memberId, runMutation],
  );

  const handleRemoveFromRoster = React.useCallback(
    async (rosterIdRaw: string) => {
      await runMutation({
        apiCall: (api) =>
          api.roster.removeRosterMember({
            params: {
              teamId,
              rosterId: Schema.decodeSync(RosterModel.RosterId)(rosterIdRaw),
              memberId,
            },
          }),
        errorMessage: tr('roster_updateFailed'),
        successMessage: tr('roster_memberRemoved'),
      });
    },
    [teamId, memberId, runMutation],
  );

  const handleAddToGroup = React.useCallback(
    async (groupIdRaw: string) => {
      await runMutation({
        apiCall: (api) =>
          api.group.addGroupMember({
            params: { teamId, groupId: Schema.decodeSync(GroupModel.GroupId)(groupIdRaw) },
            payload: { memberId },
          }),
        errorMessage: tr('group_updateFailed'),
        successMessage: tr('group_memberAdded'),
      });
    },
    [teamId, memberId, runMutation],
  );

  const handleRemoveFromGroup = React.useCallback(
    async (groupIdRaw: string) => {
      await runMutation({
        apiCall: (api) =>
          api.group.removeGroupMember({
            params: {
              teamId,
              groupId: Schema.decodeSync(GroupModel.GroupId)(groupIdRaw),
              memberId,
            },
          }),
        errorMessage: tr('group_updateFailed'),
        successMessage: tr('group_memberRemoved'),
      });
    },
    [teamId, memberId, runMutation],
  );

  const handleDeactivate = React.useCallback(
    () =>
      runMutation({
        apiCall: (api) => api.roster.deactivateMember({ params: { teamId, memberId } }),
        errorMessage: tr('members_deactivateFailed'),
        successMessage: tr('members_deactivated'),
      }),
    [teamId, memberId, runMutation],
  );

  const handleReactivate = React.useCallback(
    () =>
      runMutation({
        apiCall: (api) => api.roster.reactivateMember({ params: { teamId, memberId } }),
        errorMessage: tr('members_reactivateFailed'),
        successMessage: tr('members_reactivated'),
      }),
    [teamId, memberId, runMutation],
  );

  const handleCreateLog = React.useCallback(
    async (input: {
      activityTypeId: ActivityType.ActivityTypeId;
      durationMinutes: Option.Option<number>;
      note: Option.Option<string>;
      loggedAtDate: Option.Option<string>;
    }) => {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.activityLog.createLog({
            params: { teamId, memberId },
            payload: {
              activityTypeId: input.activityTypeId,
              durationMinutes: input.durationMinutes,
              note: input.note,
              loggedAtDate: input.loggedAtDate,
            },
          }),
        ),
        Effect.catchTag('ActivityLogInvalidLoggedAtDate', () =>
          Effect.fail(ClientError.make(tr('activityLog_invalidDate'))),
        ),
        Effect.mapError((err) =>
          err._tag === 'ClientError' ? err : ClientError.make(tr('activityLog_logFailed')),
        ),
        run({ success: tr('activityLog_logged') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [teamId, memberId, run, router],
  );

  const handleUpdateLog = React.useCallback(
    async (
      logId: ActivityLog.ActivityLogId,
      input: {
        activityTypeId: Option.Option<ActivityType.ActivityTypeId>;
        durationMinutes: Option.Option<Option.Option<number>>;
        note: Option.Option<Option.Option<string>>;
        loggedAtDate: Option.Option<string>;
      },
    ) => {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.activityLog.updateLog({
            params: { teamId, memberId, logId },
            payload: {
              activityTypeId: input.activityTypeId,
              durationMinutes: input.durationMinutes,
              note: input.note,
              loggedAtDate: input.loggedAtDate,
            },
          }),
        ),
        Effect.catchTag('ActivityLogInvalidLoggedAtDate', () =>
          Effect.fail(ClientError.make(tr('activityLog_invalidDate'))),
        ),
        Effect.mapError((err) =>
          err._tag === 'ClientError' ? err : ClientError.make(tr('activityLog_updateFailed')),
        ),
        run({ success: tr('activityLog_updated') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [teamId, memberId, run, router],
  );

  const handleDeleteLog = React.useCallback(
    async (logId: ActivityLog.ActivityLogId) => {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.activityLog.deleteLog({
            params: { teamId, memberId, logId },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('activityLog_deleteFailed'))),
        run({ success: tr('activityLog_deleted') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [teamId, memberId, run, router],
  );

  const handleRefresh = React.useCallback(() => {
    router.invalidate();
  }, [router]);

  return (
    <PlayerDetailPage
      teamId={teamIdRaw}
      player={player}
      canEdit={canEdit}
      canManageRoles={canManageRoles}
      availableRoles={roles}
      memberRosters={memberRosters}
      assignableRosters={assignableRosters}
      memberGroups={memberGroups}
      assignableGroups={assignableGroups}
      canManageRosters={canManageRosters}
      canManageGroups={canManageGroups}
      canRemoveMember={canRemoveMember}
      activityStats={activityStats}
      achievements={activityStats.achievements}
      isOwnProfile={activityLogs.isOwnProfile}
      activityLogs={new ActivityLogApi.ActivityLogListResponse({ logs: activityLogs.logs })}
      activityTypes={activityTypes}
      rating={rating}
      teamMemberId={memberIdRaw}
      onRefresh={handleRefresh}
      onSave={handleSave}
      onAssignRole={handleAssignRole}
      onUnassignRole={handleUnassignRole}
      onAddToRoster={handleAddToRoster}
      onRemoveFromRoster={handleRemoveFromRoster}
      onAddToGroup={handleAddToGroup}
      onRemoveFromGroup={handleRemoveFromGroup}
      onDeactivate={handleDeactivate}
      onReactivate={handleReactivate}
      onCreateLog={handleCreateLog}
      onUpdateLog={handleUpdateLog}
      onDeleteLog={handleDeleteLog}
    />
  );
}
