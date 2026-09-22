import { Discord as DiscordSchemas } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import { DiscordREST } from 'dfx/DiscordREST';
import * as Discord from 'dfx/types';
import { Effect, Option, Schema } from 'effect';
import { buildVerifyButton } from '~/interactions/profile-verify.js';
import type { Locale } from '~/locale.js';
import { isPermanentError } from '~/rest/discordErrors.js';
import { CHANNEL_ACCESS_VIEW, HIDDEN } from '~/rest/permissions.js';
import { allow, deny, retryPolicy } from '~/rest/utils.js';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);

const DEFAULT_WELCOME_COLOR = 0x5865f2;

const findByName = (
  channels: ReadonlyArray<{ readonly id: string; readonly name?: string | null }>,
  name: string,
) => channels.find((c) => c.name === name);

/**
 * The one bot-owned, permanent, read-only channel that hides itself from everyone
 * except the unverified role (Deliverable D / Task 10). Resolved by name — no
 * `teams.verify_channel_id` column, on purpose (design-spec ask #8, declined in the
 * plan): one less API field and one less thing to keep in sync with a captain who
 * renames or deletes the channel.
 *
 * On create only: two permission overwrites (`@everyone` fully hidden; the
 * unverified role gets view + read-history, no send/react/threads — both from the
 * existing `~/rest/permissions.js` constants, no new ones added) and one pinned
 * intro embed carrying the verify button. Per the design spec: never delete the
 * message, never garbage-collect the channel.
 *
 * A permanent Discord error (typically missing `MANAGE_CHANNELS`) logs a warning and
 * resolves `None` — this must never fail the member's join. Transient errors retry
 * with the existing `retryPolicy`, matching `createChannelWithRole.ts`'s discipline.
 */
export const ensureVerificationChannel = (
  guildId: DiscordSchemas.Snowflake,
  unverifiedRoleId: DiscordSchemas.Snowflake,
  locale: Locale,
) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('channels', ({ rest }) => rest.listGuildChannels(guildId)),
    Effect.flatMap(({ rest, channels }) => {
      const name = m.bot_verify_channel_name({}, { locale });
      const existing = findByName(channels, name);
      if (existing !== undefined) {
        return Effect.succeed(Option.some(decodeSnowflake(existing.id)));
      }

      return Effect.suspend(() =>
        rest.createGuildChannel(guildId, {
          name,
          type: Discord.ChannelTypes.GUILD_TEXT,
          topic: m.bot_verify_channel_topic({}, { locale }),
          permission_overwrites: [
            { id: guildId, type: Discord.ChannelPermissionOverwrites.ROLE, deny: deny(HIDDEN) },
            {
              id: unverifiedRoleId,
              type: Discord.ChannelPermissionOverwrites.ROLE,
              allow: allow(CHANNEL_ACCESS_VIEW),
              deny: deny(CHANNEL_ACCESS_VIEW),
            },
          ],
        }),
      ).pipe(
        Effect.retry({ schedule: retryPolicy, while: (e) => !isPermanentError(e) }),
        Effect.tap((channel) =>
          Effect.logInfo(
            `Auto-created Discord verify channel "${channel.name}" (${channel.id}) in guild ${guildId}`,
          ),
        ),
        Effect.flatMap((channel) => {
          const channelId = decodeSnowflake(channel.id);
          return rest
            .createMessage(channelId, {
              embeds: [
                {
                  color: DEFAULT_WELCOME_COLOR,
                  title: m.bot_verify_intro_title({}, { locale }),
                  description: m.bot_verify_intro_description({}, { locale }),
                  fields: [
                    {
                      name: m.bot_verify_intro_unlocks_name({}, { locale }),
                      value: m.bot_verify_intro_unlocks_value({}, { locale }),
                    },
                    {
                      name: m.bot_verify_intro_why_name({}, { locale }),
                      value: m.bot_verify_intro_why_value({}, { locale }),
                    },
                  ],
                  footer: { text: m.bot_verify_intro_footer({}, { locale }) },
                },
              ],
              components: [UI.row([buildVerifyButton(locale)])],
            })
            .pipe(
              Effect.retry(retryPolicy),
              Effect.tap((message) =>
                rest.createPin(channelId, message.id).pipe(Effect.retry(retryPolicy)),
              ),
              Effect.as(channelId),
            );
        }),
        Effect.map(Option.some),
        Effect.catchIf(isPermanentError, (error) =>
          Effect.logWarning(
            `Failed to create verify channel in guild ${guildId} (missing MANAGE_CHANNELS?): ${String(error)}`,
          ).pipe(Effect.as(Option.none<DiscordSchemas.Snowflake>())),
        ),
      );
    }),
  );
