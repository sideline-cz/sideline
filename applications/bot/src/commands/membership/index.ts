import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import { membershipHandler } from './handler.js';

export const MembershipCommand = Ix.global(
  {
    name: 'membership',
    name_localizations: { cs: 'clenstvi' },
    description: m.bot_membership_command_description({}, { locale: 'en' }),
    description_localizations: {
      cs: m.bot_membership_command_description({}, { locale: 'cs' }),
    },
    // Option C (`AGENTS.md` → Admin-Gating): NO `default_member_permissions`. The gate is
    // Sideline's own `finance:manage_fees`, which the handler reads off the RPC view — a
    // Discord-native gate would hide the command from exactly the treasurer who needs it, since
    // owning the club's money implies no Discord server permission at all.
    dm_permission: false,
    options: [],
  } as const,
  membershipHandler,
);
