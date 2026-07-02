import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Array, Effect, Option, pipe } from 'effect';
import { userLocale } from '~/locale.js';

export const createHandler = Interaction.asEffect().pipe(
  Effect.map((interaction) => {
    const locale = userLocale(interaction);
    const guildId = interaction.guild_id;

    if (!guildId) {
      return Ix.response({
        type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: m.bot_event_no_guild({}, { locale }),
          flags: DiscordTypes.MessageFlags.Ephemeral,
        },
      });
    }

    const data = interaction.data;
    // For subcommands, options are nested: data.options[0] = "create" subcommand,
    // and the actual options (type, training_type) are in data.options[0].options
    const subCommand = data && 'options' in data ? data.options?.[0] : undefined;
    const options = subCommand && 'options' in subCommand ? [...(subCommand.options ?? [])] : [];
    const eventType = pipe(
      options,
      Array.findFirst((o) => o.name === 'type'),
      Option.flatMap((o) => ('value' in o ? Option.some(String(o.value)) : Option.none())),
      Option.getOrElse(() => 'other'),
    );
    const trainingTypeId = pipe(
      options,
      Array.findFirst((o) => o.name === 'training_type'),
      Option.flatMap((o) => ('value' in o ? Option.some(String(o.value)) : Option.none())),
      Option.getOrElse(() => ''),
    );

    return Ix.response({
      type: DiscordTypes.InteractionCallbackTypes.MODAL,
      data: {
        custom_id: `event-create:${eventType}:${trainingTypeId}`,
        title: m.bot_event_modal_title({}, { locale }),
        components: [
          UI.row([
            UI.textInput({
              custom_id: 'event_title',
              label: m.bot_event_title_label({}, { locale }),
              style: 1, // style 1 = Short
              required: true,
              max_length: 100,
            }),
          ]),
          UI.row([
            UI.textInput({
              custom_id: 'event_start',
              label: m.bot_event_start_label({}, { locale }),
              style: 1, // style 1 = Short
              required: true,
              placeholder: m.bot_event_start_placeholder({}, { locale }),
              max_length: 16,
            }),
          ]),
          UI.row([
            UI.textInput({
              custom_id: 'event_end',
              label: m.bot_event_end_label({}, { locale }),
              style: 1, // style 1 = Short
              required: false,
              placeholder: m.bot_event_end_placeholder({}, { locale }),
              max_length: 16,
            }),
          ]),
          UI.row([
            UI.textInput({
              custom_id: 'event_location',
              label: m.bot_event_location_label({}, { locale }),
              style: 1, // style 1 = Short
              required: false,
              placeholder: m.bot_event_location_placeholder({}, { locale }),
              max_length: 200,
            }),
          ]),
          UI.row([
            UI.textInput({
              custom_id: 'event_description',
              label: m.bot_event_description_label({}, { locale }),
              style: 2, // style 2 = Paragraph
              required: false,
              max_length: 1000,
            }),
          ]),
        ],
      },
    });
  }),
);
