import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { completeHandler } from './handler.js';

export const CompleteCommand = Ix.global(
  {
    name: 'complete',
    name_localizations: { cs: 'dokoncit' },
    description: m.bot_complete_cmd_desc({}, { locale: 'en' }),
    description_localizations: { cs: m.bot_complete_cmd_desc({}, { locale: 'cs' }) },
    dm_permission: false,
    options: [
      {
        type: DiscordTypes.ApplicationCommandOptionType.STRING,
        name: 'gender',
        name_localizations: { cs: 'pohlavi' },
        description: m.bot_complete_gender_option_desc({}, { locale: 'en' }),
        description_localizations: {
          cs: m.bot_complete_gender_option_desc({}, { locale: 'cs' }),
        },
        required: true as const,
        choices: [
          {
            name: m.gender_male({}, { locale: 'en' }),
            name_localizations: { cs: m.gender_male({}, { locale: 'cs' }) },
            value: 'male',
          },
          {
            name: m.gender_female({}, { locale: 'en' }),
            name_localizations: { cs: m.gender_female({}, { locale: 'cs' }) },
            value: 'female',
          },
          {
            name: m.gender_other({}, { locale: 'en' }),
            name_localizations: { cs: m.gender_other({}, { locale: 'cs' }) },
            value: 'other',
          },
        ],
      },
    ],
  } as const,
  completeHandler,
);
