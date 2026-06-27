import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { summarizeHandler } from './handler.js';

export const SummarizeCommand = Ix.global(
  {
    name: 'summarize',
    name_localizations: { cs: 'shrnout' },
    description: m.bot_summarize_description({}, { locale: 'en' }),
    description_localizations: { cs: m.bot_summarize_description({}, { locale: 'cs' }) },
    dm_permission: false,
    options: [
      {
        type: DiscordTypes.ApplicationCommandOptionType.INTEGER,
        name: 'messages',
        name_localizations: { cs: 'zpravy' },
        description: m.bot_summarize_messages_option_description({}, { locale: 'en' }),
        description_localizations: {
          cs: m.bot_summarize_messages_option_description({}, { locale: 'cs' }),
        },
        required: false,
        min_value: 1,
        max_value: 200,
      },
      {
        type: DiscordTypes.ApplicationCommandOptionType.STRING,
        name: 'since',
        name_localizations: { cs: 'od' },
        description: m.bot_summarize_since_option_description({}, { locale: 'en' }),
        description_localizations: {
          cs: m.bot_summarize_since_option_description({}, { locale: 'cs' }),
        },
        required: false,
      },
    ],
  } as const,
  summarizeHandler,
);
