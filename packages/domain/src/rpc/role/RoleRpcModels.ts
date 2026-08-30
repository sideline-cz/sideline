import { Schema } from 'effect';
import { Discord, DiscordRoleMapping, Role, Team } from '~/index.js';

export class RoleMapping extends Schema.Class<RoleMapping>('RoleMapping')({
  id: DiscordRoleMapping.DiscordRoleMappingId,
  team_id: Team.TeamId,
  role_id: Role.RoleId,
  discord_role_id: Discord.Snowflake,
  /** `true` when `discord_role_id` points at a pre-existing Discord role the bot adopted rather
   * than created. See `packages/domain/src/models/DiscordRoleMapping.ts`. */
  adopted: Schema.Boolean,
}) {}

/** `Role/UpsertMapping` violated `UNIQUE(team_id, discord_role_id)` — another Sideline role in
 * the same team is already mapped to this Discord role (reachable via a Sideline role rename
 * followed by a second role adopting the same Discord role, since no `role_renamed` event exists
 * to clear the stale mapping first). The caller should fall through to creating a fresh role
 * rather than treat this as terminal. */
export class DiscordRoleAlreadyMapped extends Schema.TaggedErrorClass<DiscordRoleAlreadyMapped>()(
  'DiscordRoleAlreadyMapped',
  {},
) {}
