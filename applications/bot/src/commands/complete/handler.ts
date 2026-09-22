import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect } from 'effect';
import { buildProfileCompleteModal } from '~/commands/complete/modal.js';
import { userLocale } from '~/locale.js';

export const completeHandler = Interaction.asEffect().pipe(
  Effect.map((interaction) => {
    const locale = userLocale(interaction);
    const guildId = interaction.guild_id;

    if (!guildId) {
      return Ix.response({
        type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: m.bot_complete_no_guild({}, { locale }),
          flags: DiscordTypes.MessageFlags.Ephemeral,
        },
      });
    }

    return Ix.response({
      type: DiscordTypes.InteractionCallbackTypes.MODAL,
      data: buildProfileCompleteModal(locale),
    });
  }),
);
