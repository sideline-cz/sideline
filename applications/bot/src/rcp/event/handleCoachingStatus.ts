import type { EventRpcEvents } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Option, Schema } from 'effect';
import { guildLocale } from '~/locale.js';
import { DfxGuild } from '~/schemas.js';

const decodeGuild = Schema.decodeUnknownSync(DfxGuild);
const CLAIMED_COLOR = 0x57f287; // green (claimed style)

export const handleCoachingStatus = (event: EventRpcEvents.CoachingStatusEvent) =>
  Option.match(event.discord_target_channel_id, {
    onNone: () =>
      Effect.logWarning(
        `handleCoachingStatus: no target channel resolved for event ${event.event_id}, skipping`,
      ),
    onSome: (channelId) =>
      Effect.Do.pipe(
        Effect.bind('rest', () => DiscordREST.asEffect()),
        Effect.bind('guild', ({ rest }) =>
          rest.getGuild(event.guild_id).pipe(Effect.map(decodeGuild)),
        ),
        Effect.flatMap(({ rest, guild }) => {
          const locale = guildLocale({ guild_locale: guild.preferred_locale });

          const coachDisplay = Option.match(event.claimed_by_display_name, {
            onNone: () => '—',
            onSome: (name) => name,
          });

          const coachMention = Option.match(event.claimed_by_discord_id, {
            onNone: () => coachDisplay,
            onSome: (discordId) => `<@${discordId}>`,
          });

          return rest
            .createMessage(channelId, {
              embeds: [
                {
                  title: m.bot_coaching_status_title({}, { locale }),
                  description: m.bot_coaching_status_description(
                    { coach: coachMention },
                    { locale },
                  ),
                  color: CLAIMED_COLOR,
                  fields: [
                    {
                      name: m.bot_coaching_status_coach_field({}, { locale }),
                      value: coachDisplay,
                      inline: true,
                    },
                  ],
                },
              ],
            })
            .pipe(
              Effect.tap((msg) =>
                Effect.logInfo(
                  `Posted coaching status for "${event.title}" to channel ${channelId}, message ${msg.id}`,
                ),
              ),
              Effect.asVoid,
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `handleCoachingStatus: failed to post coaching status for event ${event.event_id}`,
                  cause,
                ),
              ),
            );
        }),
      ),
  });
