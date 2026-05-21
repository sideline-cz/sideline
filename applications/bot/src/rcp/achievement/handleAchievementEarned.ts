import type { AchievementRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Option } from 'effect';
import { buildAchievementEmbed } from '~/rest/achievements/buildAchievementEmbed.js';
import { retryPolicy } from '~/rest/utils.js';

const grantRole = (event: AchievementRpcEvents.AchievementEarnedEvent, roleId: string) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('granted', ({ rest }) =>
      rest.addGuildMemberRole(event.guild_id, event.discord_user_id, roleId).pipe(
        Effect.retry(retryPolicy),
        Effect.as(true),
        Effect.catchTag('ErrorResponse', (err) =>
          err.response.status === 404
            ? Effect.logWarning(
                `Achievement role ${roleId} not found (404) in guild ${event.guild_id}, skipping role grant`,
              ).pipe(Effect.as(false))
            : Effect.fail(err),
        ),
      ),
    ),
    Effect.tap(({ granted }) =>
      granted
        ? Effect.logInfo(
            `Granted achievement role ${roleId} to user ${event.discord_user_id} in guild ${event.guild_id}`,
          )
        : Effect.void,
    ),
    Effect.map(({ granted }) => granted),
  );

const postEmbed = (
  event: AchievementRpcEvents.AchievementEarnedEvent,
  channelId: string,
  roleGranted: boolean,
) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.tap(({ rest }) => {
      const embed = buildAchievementEmbed({
        slug: event.achievement_slug,
        discord_user_id: event.discord_user_id,
        discord_role_id: roleGranted ? event.discord_role_id : Option.none(),
        earned_at: new Date(),
        locale: 'en',
      });

      const roleId = Option.getOrUndefined(event.discord_role_id);
      const content = `<@${event.discord_user_id}>`;
      const allowed_mentions = {
        parse: [] as [],
        users: [event.discord_user_id],
        roles: roleId !== undefined ? [roleId] : [],
      };

      return rest.createMessage(channelId, { content, embeds: [embed], allowed_mentions }).pipe(
        Effect.retry(retryPolicy),
        Effect.catchTag('ErrorResponse', (err) =>
          err.response.status === 404
            ? Effect.logWarning(
                `Achievement channel ${channelId} not found (404) in guild ${event.guild_id}, skipping embed`,
              )
            : Effect.fail(err),
        ),
      );
    }),
    Effect.tap(() =>
      Effect.logInfo(
        `Posted achievement embed for ${event.achievement_slug} to channel ${channelId} in guild ${event.guild_id}`,
      ),
    ),
    Effect.asVoid,
  );

export const handleAchievementEarned = (event: AchievementRpcEvents.AchievementEarnedEvent) =>
  Effect.Do.pipe(
    // grantedRoleId is Some(roleId) only if a role was configured AND successfully granted.
    Effect.bind('grantedRoleId', () =>
      Option.match(event.discord_role_id, {
        onNone: () => Effect.succeed(Option.none<string>()),
        onSome: (roleId) =>
          grantRole(event, roleId).pipe(
            Effect.map((granted) => (granted ? Option.some(roleId) : Option.none<string>())),
          ),
      }),
    ),
    Effect.tap(({ grantedRoleId }) =>
      Option.match(event.achievement_channel_id, {
        onNone: () =>
          Option.match(grantedRoleId, {
            onNone: () =>
              Option.isNone(event.discord_role_id)
                ? Effect.logInfo(
                    `No role or channel configured for achievement ${event.achievement_slug} in guild ${event.guild_id}, nothing to do`,
                  )
                : Effect.void,
            onSome: (roleId) =>
              Effect.logInfo(
                `Granted achievement role ${roleId}; skipped embed (achievement channel not configured) for guild ${event.guild_id}`,
              ),
          }),
        onSome: (channelId) => postEmbed(event, channelId, Option.isSome(grantedRoleId)),
      }),
    ),
    Effect.asVoid,
  );
