import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { pollHandler } from './handler.js';

export const PollCommand = Ix.global(
  {
    name: 'poll',
    name_localizations: { cs: 'anketa' },
    description: m.bot_poll_cmd_desc({}, { locale: 'en' }),
    description_localizations: { cs: m.bot_poll_cmd_desc({}, { locale: 'cs' }) },
    // Hides the command from non-captains in the Discord UI.
    // ManageEvents (1n << 9n = 512) is a conservative gate for captains.
    default_member_permissions: Number(DiscordTypes.Permissions.ManageEvents),
    dm_permission: false,
    options: [
      {
        name: 'question',
        name_localizations: { cs: 'otázka' },
        description: m.bot_poll_opt_question_desc({}, { locale: 'en' }),
        description_localizations: { cs: m.bot_poll_opt_question_desc({}, { locale: 'cs' }) },
        type: DiscordTypes.ApplicationCommandOptionType.STRING,
        required: true as const,
      },
      {
        name: 'options',
        name_localizations: { cs: 'možnosti' },
        description: m.bot_poll_opt_options_desc({}, { locale: 'en' }),
        description_localizations: { cs: m.bot_poll_opt_options_desc({}, { locale: 'cs' }) },
        type: DiscordTypes.ApplicationCommandOptionType.STRING,
        required: true as const,
      },
      {
        name: 'multiple',
        name_localizations: { cs: 'více_možností' },
        description: m.bot_poll_opt_multiple_desc({}, { locale: 'en' }),
        description_localizations: { cs: m.bot_poll_opt_multiple_desc({}, { locale: 'cs' }) },
        type: DiscordTypes.ApplicationCommandOptionType.BOOLEAN,
        required: false as const,
      },
      {
        name: 'deadline',
        name_localizations: { cs: 'uzávěrka' },
        description: m.bot_poll_opt_deadline_desc({}, { locale: 'en' }),
        description_localizations: { cs: m.bot_poll_opt_deadline_desc({}, { locale: 'cs' }) },
        type: DiscordTypes.ApplicationCommandOptionType.STRING,
        required: false as const,
      },
      {
        name: 'allowed_role',
        name_localizations: { cs: 'povolená_role' },
        description: m.bot_poll_opt_allowed_role_desc({}, { locale: 'en' }),
        description_localizations: { cs: m.bot_poll_opt_allowed_role_desc({}, { locale: 'cs' }) },
        type: DiscordTypes.ApplicationCommandOptionType.ROLE,
        required: false as const,
      },
    ],
  } as const,
  pollHandler,
);
