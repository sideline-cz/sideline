import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { generateHandler } from './generate.js';
import { resultHandler } from './result.js';

export const TrainingCommand = Ix.global(
  {
    name: 'training',
    description: 'Training tools',
    description_localizations: { cs: 'Tréninkové nástroje' },
    // Hides the command from non-captains/coaches in the Discord UI.
    // ManageEvents (1n << 9n = 512) gates captain-only commands.
    default_member_permissions: Number(DiscordTypes.Permissions.ManageEvents),
    dm_permission: false,
    options: [
      {
        type: DiscordTypes.ApplicationCommandOptionType.SUB_COMMAND,
        name: 'result',
        name_localizations: { cs: 'výsledek' },
        description: m.bot_training_result_description({}, { locale: 'en' }),
        description_localizations: {
          cs: m.bot_training_result_description({}, { locale: 'cs' }),
        },
        options: [
          {
            name: 'event',
            description: m.bot_training_result_event_description({}, { locale: 'en' }),
            description_localizations: {
              cs: m.bot_training_result_event_description({}, { locale: 'cs' }),
            },
            type: DiscordTypes.ApplicationCommandOptionType.STRING,
            required: true as const,
            autocomplete: true as const,
          },
        ],
      },
      {
        type: DiscordTypes.ApplicationCommandOptionType.SUB_COMMAND,
        name: 'generate',
        name_localizations: { cs: 'generovat' },
        description: m.bot_training_generate_description({}, { locale: 'en' }),
        description_localizations: {
          cs: m.bot_training_generate_description({}, { locale: 'cs' }),
        },
        options: [
          {
            name: 'event',
            description: m.bot_training_generate_event_description({}, { locale: 'en' }),
            description_localizations: {
              cs: m.bot_training_generate_event_description({}, { locale: 'cs' }),
            },
            type: DiscordTypes.ApplicationCommandOptionType.STRING,
            required: true as const,
            autocomplete: true as const,
          },
        ],
      },
    ],
  } as const,
  (ix) =>
    ix.subCommands({
      result: resultHandler,
      generate: generateHandler,
    }),
);
