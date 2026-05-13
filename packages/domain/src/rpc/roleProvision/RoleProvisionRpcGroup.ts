import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as Discord from '../../models/Discord.js';
import * as Team from '../../models/Team.js';

export const RoleProvisionEventId = Schema.String.pipe(Schema.brand('RoleProvisionEventId'));
export type RoleProvisionEventId = typeof RoleProvisionEventId.Type;

export const RoleProvisionKind = Schema.Literals(['builtin_achievement', 'custom_achievement']);
export type RoleProvisionKind = typeof RoleProvisionKind.Type;

export class UnprocessedRoleProvisionEvent extends Schema.Class<UnprocessedRoleProvisionEvent>(
  'UnprocessedRoleProvisionEvent',
)({
  id: RoleProvisionEventId,
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  kind: RoleProvisionKind,
  ref_id: Schema.String,
  desired_name: Schema.String,
}) {}

export const RoleProvisionRpcGroup = RpcGroup.make(
  Rpc.make('GetUnprocessedEvents', {
    payload: { limit: Schema.Number },
    success: Schema.Array(UnprocessedRoleProvisionEvent),
  }),
  Rpc.make('MarkProcessed', {
    payload: { id: RoleProvisionEventId },
  }),
  Rpc.make('MarkFailed', {
    payload: { id: RoleProvisionEventId, error: Schema.String },
  }),
).prefix('RoleProvision/');
