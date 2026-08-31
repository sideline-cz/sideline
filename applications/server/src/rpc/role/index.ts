import {
  type Discord,
  type Role,
  type RoleApi,
  RoleRpcGroup,
  RoleRpcModels,
  type RoleSyncEvent,
  type Team,
  type TeamMember,
} from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { Array, Data, type DateTime, Effect, flow, Option, Result, type ServiceMap } from 'effect';
import { DiscordRoleMappingRepository } from '~/repositories/DiscordRoleMappingRepository.js';
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { constructEvent, EventPropertyMissing } from './events.js';

class NoChanges extends Data.TaggedError('NoChanges')<{
  count: 0;
}> {
  static make = () => new NoChanges({ count: 0 });
}

// Blocker (whole-series review of `fix/discord-onboarding-webapp`, commit 46806427): the
// per-member Discord-role provenance write. Only reached from `Role/MarkEventProcessed` — i.e.
// only after the bot's REST call to Discord actually succeeded (`processed_at` was just set) — so
// a terminally-failed event (`Role/MarkEventFailed`) never touches `member_role_grants`, and
// `role_created` / `role_deleted` (team-scoped, no `team_member_id`) never do either.
// `reconcileMemberDiscordRoles.ts` / `syncMemberDiscordRoles.ts` are the readers.
const applyGrantProvenance = (
  members: ServiceMap.Service.Shape<typeof TeamMembersRepository>,
  teamMemberId: TeamMember.TeamMemberId,
  roleId: Role.RoleId,
  eventType: RoleSyncEvent.RoleSyncEventType,
) => {
  if (eventType === 'role_assigned') return members.recordRoleGrant(teamMemberId, roleId);
  if (eventType === 'role_unassigned') return members.clearRoleGrant(teamMemberId, roleId);
  return Effect.void;
};

export const RolesRpcLive = Effect.Do.pipe(
  Effect.bind('syncEvents', () => RoleSyncEventsRepository.asEffect()),
  Effect.bind('mappings', () => DiscordRoleMappingRepository.asEffect()),
  Effect.bind('members', () => TeamMembersRepository.asEffect()),
  Effect.let(
    'Role/GetUnprocessedEvents',
    ({ syncEvents }) =>
      ({ limit }: { readonly limit: number }) =>
        syncEvents.findUnprocessed(limit).pipe(
          Effect.map(
            Array.map(
              flow(
                constructEvent,
                Effect.tapError(Effect.logError),
                Effect.tapErrorTag('EventPropertyMissing', EventPropertyMissing.handle),
                Effect.result,
              ),
            ),
          ),
          Effect.tap((arr) =>
            Array.isArrayEmpty(arr) ? Effect.fail(NoChanges.make()) : Effect.void,
          ),
          Effect.tap((events) =>
            Effect.logInfo(`Collected ${events.length} role events from database.`),
          ),
          Effect.flatMap(Effect.all),
          Effect.tap(flow(Array.filterMap(Result.flip), Array.map(Effect.logError), Effect.all)),
          Effect.map(Array.filterMap((r) => r)),
          Effect.tap((events) =>
            Effect.logInfo(`Successfully mapped ${events.length} role events from database.`),
          ),
          Effect.catchTag('NoChanges', () => Effect.succeed(Array.empty())),
        ),
  ),
  Effect.let(
    'Role/MarkEventProcessed',
    ({ syncEvents, members }) =>
      ({
        id,
        tick_started_at,
      }: {
        readonly id: RoleSyncEvent.RoleSyncEventId;
        readonly tick_started_at: DateTime.Utc;
      }) =>
        syncEvents.markProcessed(id, tick_started_at).pipe(
          Effect.flatMap((result) =>
            Option.match(result.team_member_id, {
              onNone: () => Effect.void,
              onSome: (teamMemberId) =>
                applyGrantProvenance(members, teamMemberId, result.role_id, result.event_type),
            }),
          ),
          Effect.asVoid,
        ),
  ),
  Effect.let(
    'Role/MarkEventFailed',
    ({ syncEvents }) =>
      ({
        id,
        error,
        error_code,
      }: {
        readonly id: RoleSyncEvent.RoleSyncEventId;
        readonly error: string;
        readonly error_code: Option.Option<RoleApi.DiscordSyncErrorCode>;
      }) =>
        syncEvents.markFailed(id, error, error_code),
  ),
  Effect.let(
    'Role/GetMapping',
    ({ mappings }) =>
      ({ team_id, role_id }: { readonly team_id: Team.TeamId; readonly role_id: Role.RoleId }) =>
        mappings.findByRoleId(team_id, role_id).pipe(
          Effect.map(
            Option.map(
              (m) =>
                new RoleRpcModels.RoleMapping({
                  id: m.id,
                  team_id: m.team_id,
                  role_id: m.role_id,
                  discord_role_id: m.discord_role_id,
                  adopted: m.adopted,
                }),
            ),
          ),
        ),
  ),
  Effect.let(
    'Role/UpsertMapping',
    ({ mappings }) =>
      ({
        team_id,
        role_id,
        discord_role_id,
        adopted,
      }: {
        readonly team_id: Team.TeamId;
        readonly role_id: Role.RoleId;
        readonly discord_role_id: Discord.Snowflake;
        readonly adopted: boolean;
      }) =>
        mappings.insert(team_id, role_id, discord_role_id, adopted),
  ),
  Effect.let(
    'Role/DeleteMapping',
    ({ mappings }) =>
      ({ team_id, role_id }: { readonly team_id: Team.TeamId; readonly role_id: Role.RoleId }) =>
        mappings.deleteByRoleId(team_id, role_id),
  ),
  Bind.remove('syncEvents'),
  Bind.remove('mappings'),
  Bind.remove('members'),
  (handlers) => RoleRpcGroup.RoleRpcGroup.toLayer(handlers),
);
