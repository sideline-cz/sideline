import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import { infoHandler } from './handler.js';

export const InfoCommand = Ix.global(
  {
    name: 'info',
    description: m.bot_info_description({}, { locale: 'en' }),
    description_localizations: { cs: m.bot_info_description({}, { locale: 'cs' }) },
  } as const,
  infoHandler,
);
