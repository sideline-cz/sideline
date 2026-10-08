import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import { statusHandler } from './statusHandler.js';

// Flat, not `/finance status`: `status` was the only subcommand this command ever had, so it was
// pure typing with nothing to disambiguate. The old subcommand (and its `cs: stav` alias)
// disappears from Discord on the next command registration.
export const FinanceCommand = Ix.global(
  {
    name: 'finance',
    description: m.bot_finance_command_description({}, { locale: 'en' }),
    description_localizations: { cs: m.bot_finance_command_description({}, { locale: 'cs' }) },
  } as const,
  statusHandler,
);
