import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { assistantHandler } from './handler.js';

export const AssistantCommand = Ix.global(
  {
    name: 'assistant',
    name_localizations: { cs: 'asistent' },
    description: m.bot_assistant_description({}, { locale: 'en' }),
    description_localizations: { cs: m.bot_assistant_description({}, { locale: 'cs' }) },
    dm_permission: false,
    options: [
      {
        type: DiscordTypes.ApplicationCommandOptionType.STRING,
        name: 'visibility',
        name_localizations: { cs: 'viditelnost' },
        description: m.bot_assistant_visibility_option_description({}, { locale: 'en' }),
        description_localizations: {
          cs: m.bot_assistant_visibility_option_description({}, { locale: 'cs' }),
        },
        required: false,
        choices: [
          {
            name: m.bot_assistant_visibility_private({}, { locale: 'en' }),
            name_localizations: { cs: m.bot_assistant_visibility_private({}, { locale: 'cs' }) },
            value: 'private',
          },
          {
            name: m.bot_assistant_visibility_public({}, { locale: 'en' }),
            name_localizations: { cs: m.bot_assistant_visibility_public({}, { locale: 'cs' }) },
            value: 'public',
          },
        ],
      },
    ],
  } as const,
  assistantHandler,
);
