import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { statusHandler } from './statusHandler.js';

export const FinanceCommand = Ix.global(
  {
    name: 'finance',
    description: m.bot_finance_command_description({}, { locale: 'en' }),
    description_localizations: { cs: m.bot_finance_command_description({}, { locale: 'cs' }) },
    options: [
      {
        type: DiscordTypes.ApplicationCommandOptionType.SUB_COMMAND,
        name: 'status',
        name_localizations: { cs: 'stav' },
        description: m.bot_finance_status_description({}, { locale: 'en' }),
        description_localizations: {
          cs: m.bot_finance_status_description({}, { locale: 'cs' }),
        },
      },
    ],
  } as const,
  (ix) =>
    ix.subCommands({
      status: statusHandler,
    }),
);
