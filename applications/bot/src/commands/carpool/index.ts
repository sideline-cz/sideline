import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { carpoolHandler } from './handler.js';

export const CarpoolCommand = Ix.global(
  {
    name: 'carpool',
    name_localizations: { cs: 'doprava' },
    description: m.bot_carpool_cmd_desc({}, { locale: 'en' }),
    description_localizations: { cs: m.bot_carpool_cmd_desc({}, { locale: 'cs' }) },
    // Hides the command from non-captains in the Discord UI.
    // ManageEvents (1n << 9n = 512) is a conservative gate for captains.
    default_member_permissions: Number(DiscordTypes.Permissions.ManageEvents),
    dm_permission: false,
  } as const,
  carpoolHandler,
);
