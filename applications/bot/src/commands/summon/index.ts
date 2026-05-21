import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { summonHandler } from './handler.js';

export const SummonCommand = Ix.global(
  {
    name: 'summon',
    name_localizations: { cs: 'přivolat' },
    description: m.bot_summon_description({}, { locale: 'en' }),
    description_localizations: { cs: m.bot_summon_description({}, { locale: 'cs' }) },
    // Hides the command from members who lack Manage Threads in the Discord
    // UI; the handler also re-checks at runtime as a safety net.
    // `ManageThreads` (1n << 34n = 17_179_869_184) fits comfortably inside
    // Number.MAX_SAFE_INTEGER, so the bigint→number conversion is lossless.
    default_member_permissions: Number(DiscordTypes.Permissions.ManageThreads),
    dm_permission: false,
    options: [
      {
        type: DiscordTypes.ApplicationCommandOptionType.USER,
        name: 'user',
        description: m.bot_summon_user_option_description({}, { locale: 'en' }),
        description_localizations: {
          cs: m.bot_summon_user_option_description({}, { locale: 'cs' }),
        },
        required: false,
      },
      {
        type: DiscordTypes.ApplicationCommandOptionType.ROLE,
        name: 'role',
        description: m.bot_summon_role_option_description({}, { locale: 'en' }),
        description_localizations: {
          cs: m.bot_summon_role_option_description({}, { locale: 'cs' }),
        },
        required: false,
      },
    ],
  } as const,
  summonHandler,
);
