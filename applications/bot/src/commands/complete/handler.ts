import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Array, Effect, Option, pipe } from 'effect';
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

    const data = interaction.data;
    const options = data && 'options' in data ? [...(data.options ?? [])] : [];
    const gender = pipe(
      options,
      Array.findFirst((o) => o.name === 'gender'),
      Option.flatMap((o) => ('value' in o ? Option.some(String(o.value)) : Option.none())),
      Option.getOrElse(() => 'other'),
    );

    return Ix.response({
      type: DiscordTypes.InteractionCallbackTypes.MODAL,
      data: {
        custom_id: `profile-complete:${gender}`,
        title: m.bot_complete_modal_title({}, { locale }),
        components: [
          UI.row([
            UI.textInput({
              custom_id: 'profile_name',
              label: m.bot_complete_name_label({}, { locale }),
              style: DiscordTypes.TextInputStyleTypes.SHORT,
              required: true,
              placeholder: m.bot_complete_name_placeholder({}, { locale }),
              max_length: 100,
            }),
          ]),
          UI.row([
            UI.textInput({
              custom_id: 'profile_birth_date',
              label: m.bot_complete_birth_date_label({}, { locale }),
              style: DiscordTypes.TextInputStyleTypes.SHORT,
              required: true,
              placeholder: m.bot_complete_birth_date_placeholder({}, { locale }),
              max_length: 10,
            }),
          ]),
          UI.row([
            UI.textInput({
              custom_id: 'profile_jersey_number',
              label: m.bot_complete_jersey_label({}, { locale }),
              style: DiscordTypes.TextInputStyleTypes.SHORT,
              required: false,
              placeholder: m.bot_complete_jersey_placeholder({}, { locale }),
              max_length: 2,
            }),
          ]),
        ],
      },
    });
  }),
);
