import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Metric } from 'effect';
import { userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { APP_VERSION } from '~/version.js';

export const infoHandler = Interaction.asEffect().pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'command' }),
      1,
    ),
  ),
  Effect.flatMap((interaction) => {
    const locale = userLocale(interaction);

    return Effect.Do.pipe(
      Effect.bind('rpc', () => SyncRpc.asEffect()),
      Effect.bind('serverVersion', ({ rpc }) =>
        rpc['BotInfo/GetServerVersion'](undefined).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning('Failed to fetch server version', cause).pipe(Effect.as('unknown')),
          ),
        ),
      ),
      Effect.map(({ serverVersion }) =>
        Ix.response({
          type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            embeds: [
              {
                title: 'Sideline',
                url: 'https://majksa.com',
                color: 0x5865f2,
                description: m.bot_info_embed_description({}, { locale }),
                fields: [
                  {
                    name: m.bot_info_field_bot({}, { locale }),
                    value: APP_VERSION,
                    inline: true,
                  },
                  {
                    name: m.bot_info_field_server({}, { locale }),
                    value: serverVersion,
                    inline: true,
                  },
                  {
                    name: m.bot_info_field_author({}, { locale }),
                    value: '[majksa](https://majksa.com)',
                    inline: true,
                  },
                ],
                footer: { text: m.bot_info_footer({}, { locale }) },
              },
            ],
            flags: DiscordTypes.MessageFlags.Ephemeral,
          },
        }),
      ),
    );
  }),
  Effect.withSpan('command/info'),
);
