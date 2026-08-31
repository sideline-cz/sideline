import {
  type Discord,
  type Role,
  type RoleApi,
  RoleRpcGroup,
  RoleRpcModels,
  type RoleSyncEvent,
  type Team,
} from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { Array, Data, Effect, flow, Option, Result } from 'effect';
import { DiscordRoleMappingRepository } from '~/repositories/DiscordRoleMappingRepository.js';
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { constructEvent, EventPropertyMissing } from './events.js';

class NoChanges extends Data.TaggedError('NoChanges')<{
  count: 0;
}> {
  static make = () => new NoChanges({ count: 0 });
}

export const RolesRpcLive = Effect.Do.pipe(
  Effect.bind('syncEvents', () => RoleSyncEventsRepository.asEffect()),
  Effect.bind('mappings', () => DiscordRoleMappingRepository.asEffect()),
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
    ({ syncEvents }) =>
      ({ id }: { readonly id: RoleSyncEvent.RoleSyncEventId }) =>
        syncEvents.markProcessed(id),
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
  (handlers) => RoleRpcGroup.RoleRpcGroup.toLayer(handlers),
);
