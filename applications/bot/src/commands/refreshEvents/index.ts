import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { refreshEventsHandler } from './handler.js';

export const RefreshEventsCommand = Ix.global(
  {
    name: 'refresh-events',
    name_localizations: { cs: 'obnovit-udalosti' },
    description: m.bot_refresh_events_description({}, { locale: 'en' }),
    description_localizations: { cs: m.bot_refresh_events_description({}, { locale: 'cs' }) },
    // Captain-only: ManageEvents (1n << 9n = 512) gates the elevated commands
    // (matches /training, /carpool). Hides it from regular members in the UI.
    default_member_permissions: Number(DiscordTypes.Permissions.ManageEvents),
    dm_permission: false,
  } as const,
  refreshEventsHandler,
);
