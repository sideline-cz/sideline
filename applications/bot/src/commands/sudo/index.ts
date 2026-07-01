import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import { sudoHandler } from './handler.js';

export const SudoCommand = Ix.global(
  {
    name: 'sudo',
    name_localizations: { cs: 'sudo' },
    description: m.bot_sudo_cmd_desc({}, { locale: 'en' }),
    description_localizations: { cs: m.bot_sudo_cmd_desc({}, { locale: 'cs' }) },
    // No `default_member_permissions`: authorization is enforced server-side via
    // `Guild/CheckTeamAdmin` (team:manage permission), not via Discord's own
    // permission bits. Gating on Administrator here would hide the command from
    // team admins who don't already hold Discord Administrator.
    dm_permission: false,
  } as const,
  sudoHandler,
);
