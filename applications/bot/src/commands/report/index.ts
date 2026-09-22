import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { reportHandler } from './handler.js';

export const ReportCommand = Ix.global(
  {
    name: 'report',
    name_localizations: { cs: 'nahlasit' },
    description: m.bot_report_cmd_desc({}, { locale: 'en' }),
    description_localizations: { cs: m.bot_report_cmd_desc({}, { locale: 'cs' }) },
    options: [
      {
        type: DiscordTypes.ApplicationCommandOptionType.STRING,
        name: 'type',
        name_localizations: { cs: 'typ' },
        description: m.bot_report_type_option_desc({}, { locale: 'en' }),
        description_localizations: { cs: m.bot_report_type_option_desc({}, { locale: 'cs' }) },
        required: true as const,
        choices: [
          {
            name: m.bot_report_type_bug({}, { locale: 'en' }),
            name_localizations: { cs: m.bot_report_type_bug({}, { locale: 'cs' }) },
            value: 'bug',
          },
          {
            name: m.bot_report_type_feature({}, { locale: 'en' }),
            name_localizations: { cs: m.bot_report_type_feature({}, { locale: 'cs' }) },
            value: 'feature',
          },
        ],
      },
    ],
  } as const,
  reportHandler,
);
