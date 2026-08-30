import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { RoleId } from '~/models/Role.js';
import { TeamId } from '~/models/Team.js';

export const DiscordRoleMappingId = Schema.String.pipe(Schema.brand('DiscordRoleMappingId'));
export type DiscordRoleMappingId = typeof DiscordRoleMappingId.Type;

export class DiscordRoleMapping extends Model.Class<DiscordRoleMapping>('DiscordRoleMapping')({
  id: Model.Generated(DiscordRoleMappingId),
  team_id: TeamId,
  role_id: RoleId,
  discord_role_id: Schema.String,
  /** `true` when this mapping points at a pre-existing Discord role the bot adopted rather than
   * created (`ensureMapping`'s tier 2). The bot must never delete or strip the underlying Discord
   * role for an adopted mapping — see blocker 2 in the PR-6 fix plan. */
  adopted: Schema.Boolean,
  created_at: Model.DateTimeInsertFromDate,
}) {}
