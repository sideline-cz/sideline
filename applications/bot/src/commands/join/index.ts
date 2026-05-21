import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { joinHandler } from './handler.js';

export const JoinCommand = Ix.global(
  {
    name: 'join',
    description: m.bot_join_description({}, { locale: 'en' }),
    description_localizations: { cs: m.bot_join_description({}, { locale: 'cs' }) },
    dm_permission: false,
    options: [
      {
        type: DiscordTypes.ApplicationCommandOptionType.USER,
        name: 'user',
        description: m.bot_join_user_option_description({}, { locale: 'en' }),
        description_localizations: {
          cs: m.bot_join_user_option_description({}, { locale: 'cs' }),
        },
        required: false,
      },
      {
        type: DiscordTypes.ApplicationCommandOptionType.ROLE,
        name: 'role',
        description: m.bot_join_role_option_description({}, { locale: 'en' }),
        description_localizations: {
          cs: m.bot_join_role_option_description({}, { locale: 'cs' }),
        },
        required: false,
      },
    ],
  } as const,
  joinHandler,
);
