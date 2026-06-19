import type { EventRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Option, Schema } from 'effect';
import { guildLocale } from '~/locale.js';
import { buildGeneratedTeamsEmbed } from '~/rest/events/buildGeneratedTeamsEmbed.js';
import { DfxGuild } from '~/schemas.js';

const decodeGuild = Schema.decodeUnknownSync(DfxGuild);

export const handleTeamsGenerated = (event: EventRpcEvents.TeamsGeneratedEvent) =>
  Option.match(event.discord_target_channel_id, {
    onNone: () =>
      Effect.logWarning(
        `handleTeamsGenerated: no target channel resolved for event ${event.event_id}, skipping`,
      ),
    onSome: (channelId) =>
      Effect.Do.pipe(
        Effect.bind('rest', () => DiscordREST.asEffect()),
        Effect.bind('guild', ({ rest }) =>
          rest.getGuild(event.guild_id).pipe(Effect.map(decodeGuild)),
        ),
        Effect.flatMap(({ rest, guild }) => {
          const locale = guildLocale({ guild_locale: guild.preferred_locale });
          const embed = buildGeneratedTeamsEmbed(event, locale);

          return rest
            .createMessage(channelId, { embeds: [embed], allowed_mentions: { parse: [] } })
            .pipe(
              Effect.tap((msg) =>
                Effect.logInfo(
                  `Posted generated teams for "${event.title}" to channel ${channelId}, message ${msg.id}`,
                ),
              ),
              Effect.asVoid,
              // Best-effort post: log and swallow failures, matching every sibling sync-event
              // handler (handleCoachingStatus, handleCreated, …). The outbox row is still
              // marked processed; Discord delivery is not retried by design.
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `handleTeamsGenerated: failed to post teams for event ${event.event_id}`,
                  cause,
                ),
              ),
            );
        }),
      ),
  });
