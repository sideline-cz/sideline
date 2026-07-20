import {
  Achievement,
  CustomAchievement,
  Discord,
  type RoleProvisionRpcGroup,
} from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, Effect, Option, Schema } from 'effect';
import { retryPolicy } from '~/rest/utils.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeSync(Discord.Snowflake);
const decodeAchievementSlug = Schema.decodeUnknownSync(Achievement.AchievementSlug);
const decodeCustomAchievementId = Schema.decodeUnknownSync(CustomAchievement.CustomAchievementId);

const resolveRoleId = (guildId: string, desiredName: string) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('existingRoles', ({ rest }) =>
      rest.listGuildRoles(guildId).pipe(Effect.retry(retryPolicy)),
    ),
    Effect.flatMap(({ rest, existingRoles }) => {
      const found = Array.findFirst(existingRoles, (role) => role.name === desiredName);
      return Option.match(found, {
        onSome: (role) => Effect.succeed(decodeSnowflake(role.id)),
        onNone: () =>
          rest.createGuildRole(guildId, { name: desiredName, permissions: 0 }).pipe(
            Effect.retry(retryPolicy),
            Effect.map((role) => decodeSnowflake(role.id)),
          ),
      });
    }),
  );

export const handleProvisionRole = (event: RoleProvisionRpcGroup.UnprocessedRoleProvisionEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('roleId', () => resolveRoleId(event.guild_id, event.desired_name)),
    Effect.tap(({ rpc, roleId }) => {
      if (event.kind === 'builtin_achievement') {
        return rpc['Achievement/UpsertBuiltInRoleMapping']({
          team_id: event.team_id,
          achievement_slug: decodeAchievementSlug(event.ref_id),
          discord_role_id: roleId,
        });
      }
      return rpc['Achievement/UpsertCustomRoleMapping']({
        team_id: event.team_id,
        custom_achievement_id: decodeCustomAchievementId(event.ref_id),
        discord_role_id: roleId,
      });
    }),
    Effect.tap(({ roleId }) =>
      Effect.logInfo(
        `Provisioned Discord role ${roleId} ("${event.desired_name}") for ${event.kind} ${event.ref_id} in guild ${event.guild_id}`,
      ),
    ),
    Effect.asVoid,
  );
