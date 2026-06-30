import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { createHandler } from './create.js';
import { listHandler } from './list.js';
import { refreshHandler } from './refresh.js';

export const EventCommand = Ix.global(
  {
    name: 'event',
    description: 'Manage events',
    description_localizations: { cs: 'Správa událostí' },
    options: [
      {
        type: DiscordTypes.ApplicationCommandOptionType.SUB_COMMAND,
        name: 'create',
        name_localizations: { cs: 'vytvořit' },
        description: 'Create a new event',
        description_localizations: { cs: 'Vytvořit novou událost' },
        options: [
          {
            name: 'type',
            description: 'Type of event',
            description_localizations: { cs: 'Typ události' },
            type: DiscordTypes.ApplicationCommandOptionType.STRING,
            required: true as const,
            choices: [
              { name: 'Training', name_localizations: { cs: 'Trénink' }, value: 'training' },
              { name: 'Match', name_localizations: { cs: 'Zápas' }, value: 'match' },
              { name: 'Tournament', name_localizations: { cs: 'Turnaj' }, value: 'tournament' },
              { name: 'Meeting', name_localizations: { cs: 'Schůzka' }, value: 'meeting' },
              { name: 'Social', name_localizations: { cs: 'Společenská' }, value: 'social' },
              { name: 'Other', name_localizations: { cs: 'Jiné' }, value: 'other' },
            ],
          },
          {
            name: 'training_type',
            description: 'Training type (only for training events)',
            description_localizations: { cs: 'Typ tréninku (pouze pro tréninkové události)' },
            type: DiscordTypes.ApplicationCommandOptionType.STRING,
            required: false as const,
            autocomplete: true as const,
          },
        ],
      },
      {
        type: DiscordTypes.ApplicationCommandOptionType.SUB_COMMAND,
        name: 'list',
        name_localizations: { cs: 'seznam' },
        description: 'List upcoming events',
        description_localizations: { cs: 'Zobrazit nadcházející události' },
      },
      {
        type: DiscordTypes.ApplicationCommandOptionType.SUB_COMMAND,
        name: 'refresh',
        name_localizations: { cs: 'obnovit' },
        // Visible to everyone; access is gated at runtime (own personal channel = anyone,
        // others' personal channels + the global channel = team:manage admins). Subcommands
        // can't carry default_member_permissions, so the gate lives in refreshHandler.
        description: m.bot_refresh_events_description({}, { locale: 'en' }),
        description_localizations: { cs: m.bot_refresh_events_description({}, { locale: 'cs' }) },
      },
    ],
  } as const,
  (ix) =>
    ix.subCommands({
      create: createHandler,
      list: listHandler,
      refresh: refreshHandler,
    }),
);
