import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import { Discord, Role, RoleSyncEvent, Team } from '~/index.js';
import { UnprocessedRoleEvent } from './RoleRpcEvents.js';
import { DiscordRoleAlreadyMapped, RoleMapping } from './RoleRpcModels.js';

export const RoleRpcGroup = RpcGroup.make(
  Rpc.make('GetUnprocessedEvents', {
    payload: { limit: Schema.Number },
    success: Schema.Array(UnprocessedRoleEvent),
  }),
  Rpc.make('MarkEventProcessed', {
    payload: { id: RoleSyncEvent.RoleSyncEventId },
  }),
  Rpc.make('MarkEventFailed', {
    payload: { id: RoleSyncEvent.RoleSyncEventId, error: Schema.String },
  }),
  Rpc.make('GetMapping', {
    payload: { team_id: Team.TeamId, role_id: Role.RoleId },
    success: Schema.OptionFromNullOr(RoleMapping),
  }),
  Rpc.make('UpsertMapping', {
    payload: {
      team_id: Team.TeamId,
      role_id: Role.RoleId,
      discord_role_id: Discord.Snowflake,
      // `withDecodingDefaultKey` (not `Schema.Boolean` alone) so a not-yet-upgraded bot that omits
      // this key during a rolling deploy still decodes — defaulting to `false` (bot-created) is
      // the pre-blocker-2 behavior, never less safe than before this fix shipped.
      adopted: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(() => false)),
    },
    error: DiscordRoleAlreadyMapped,
  }),

  Rpc.make('DeleteMapping', {
    payload: { team_id: Team.TeamId, role_id: Role.RoleId },
  }),
).prefix('Role/');
