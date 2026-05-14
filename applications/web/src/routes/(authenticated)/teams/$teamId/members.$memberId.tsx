import type { ActivityLog, Auth, Role } from '@sideline/domain';
import { ActivityLogApi, type ActivityType, Team, TeamMember } from '@sideline/domain';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import React from 'react';
import type { PlayerEditValues } from '~/components/pages/PlayerDetailPage';
import { PlayerDetailPage } from '~/components/pages/PlayerDetailPage';
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
        Effect.all({
          player: api.roster.getMember({ params: { teamId, memberId } }),
          myTeams: api.auth.myTeams(),
          roles: api.role.listRoles({ params: { teamId } }),
          activityStats: api.activityStats.getMemberStats({ params: { teamId, memberId } }),
          activityLogs: api.activityLog.listLogs({ params: { teamId, memberId } }).pipe(
            Effect.map((r) => ({ isOwnProfile: true as boolean, logs: r.logs })),
            Effect.catch(() =>
              Effect.succeed({ isOwnProfile: false as boolean, logs: [] as const }),
            ),
          ),
          activityTypes: api.activityType.listActivityTypes({ params: { teamId } }),
        }),
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
  const navigate = useNavigate();
  const router = useRouter();
  const run = useRun();
  const {
    player,
    myTeams,
    roles: roleListResponse,
    activityStats,
    activityLogs,
    activityTypes: fetchedActivityTypes,
  } = Route.useLoaderData();
  const roles = roleListResponse.roles;

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
        navigate({ to: '/teams/$teamId/members', params: { teamId: teamIdRaw } });
      }
    },
    [teamId, memberId, teamIdRaw, navigate, run],
  );

  const handleAssignRole = React.useCallback(
    async (roleId: string) => {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.role.assignRole({
            params: { teamId, memberId },
            payload: { roleId: roleId as Role.RoleId },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('roles_assignFailed'))),
        run({ success: tr('role_roleAssigned') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [teamId, memberId, run, router],
  );

  const handleUnassignRole = React.useCallback(
    async (roleId: string) => {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.role.unassignRole({
            params: { teamId, memberId, roleId: roleId as Role.RoleId },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('roles_unassignFailed'))),
        run({ success: tr('role_roleUnassigned') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [teamId, memberId, run, router],
  );

  const handleCreateLog = React.useCallback(
    async (input: {
      activityTypeId: ActivityType.ActivityTypeId;
      durationMinutes: Option.Option<number>;
      note: Option.Option<string>;
    }) => {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.activityLog.createLog({
            params: { teamId, memberId },
            payload: {
              activityTypeId: input.activityTypeId,
              durationMinutes: input.durationMinutes,
              note: input.note,
            },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('activityLog_logFailed'))),
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
            },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('activityLog_updateFailed'))),
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

  return (
    <PlayerDetailPage
      teamId={teamIdRaw}
      player={player}
      canEdit={canEdit}
      canManageRoles={canManageRoles}
      availableRoles={roles}
      activityStats={activityStats}
      achievements={activityStats.achievements}
      isOwnProfile={activityLogs.isOwnProfile}
      activityLogs={new ActivityLogApi.ActivityLogListResponse({ logs: activityLogs.logs })}
      activityTypes={activityTypes}
      onSave={handleSave}
      onAssignRole={handleAssignRole}
      onUnassignRole={handleUnassignRole}
      onCreateLog={handleCreateLog}
      onUpdateLog={handleUpdateLog}
      onDeleteLog={handleDeleteLog}
    />
  );
}
