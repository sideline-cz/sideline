import { type Discord, Discord as DiscordSchema } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array as Arr, Effect, Option, Schema } from 'effect';
import { guildLocale, type Locale } from '~/locale.js';
import { DfxGuild } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { reorderChannelMessages } from './reorderChannelMessages.js';

const decodeGuild = Schema.decodeUnknownEffect(DfxGuild);
const decodeSnowflake = Schema.decodeEffect(DiscordSchema.Snowflake);

/**
 * On bot startup, scan every channel with stored event messages and trigger
 * a reorder. For each channel, performs a bulk `listMessages` fetch first.
 * Any entry whose stored `discord_message_id` is absent from the bulk response
 * has its snowflake overridden to `Option.none()`, forcing the prefix algorithm
 * inside `reorderChannelMessages` to recreate that message with a new ID
 * persisted to the database.
 */
export const recoverDeletedMessages = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('rest', () => DiscordREST.asEffect()),
  Effect.bind('channels', ({ rpc }) => rpc['Event/GetChannelsWithStoredMessages']()),
  Effect.tap(({ channels }) =>
    Effect.logInfo(
      `Startup recovery: scanning ${channels.length} channel(s) with stored event messages`,
    ),
  ),
  Effect.flatMap(({ rpc, rest, channels }) =>
    Effect.all(
      Arr.map(channels, ({ discord_channel_id, guild_id }) => {
        const localeEffect = rest.getGuild(guild_id).pipe(
          Effect.flatMap(decodeGuild),
          Effect.map((g) => guildLocale({ guild_locale: g.preferred_locale })),
          Effect.catch(() => Effect.succeed<Locale>('en')),
        );

        // Bulk-fetch existing Discord messages for this channel (up to 100)
        const bulkFetchEffect = rest.listMessages(discord_channel_id, { limit: 100 }).pipe(
          Effect.flatMap((msgs) =>
            Effect.all(msgs.map((msg) => decodeSnowflake(msg.id).pipe(Effect.option))),
          ),
          Effect.map((maybeSfs) => new Set(maybeSfs.filter(Option.isSome).map((o) => o.value))),
          Effect.catch(() => Effect.succeed(new Set<Discord.Snowflake>())),
        );

        const entriesEffect = rpc['Event/GetChannelEvents']({ discord_channel_id });

        return Effect.all([localeEffect, bulkFetchEffect, entriesEffect]).pipe(
          Effect.flatMap(([locale, presentIds, entries]) => {
            // Build overrides: entries missing from Discord get Option.none()
            const overrides = new Map<string, Option.Option<Discord.Snowflake>>(
              entries
                .filter((e) => !presentIds.has(e.discord_message_id))
                .map((e) => [e.event_id, Option.none<Discord.Snowflake>()] as const),
            );

            return reorderChannelMessages(
              discord_channel_id,
              locale,
              overrides.size > 0 ? overrides : undefined,
            );
          }),
          Effect.tapError((e) =>
            Effect.logWarning(`Startup recovery failed for channel ${discord_channel_id}`, e),
          ),
          Effect.exit,
          Effect.asVoid,
        );
      }),
      { concurrency: 3 },
    ),
  ),
  Effect.asVoid,
);
