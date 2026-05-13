import * as Ix from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { leaderboardHandler } from './leaderboard.js';
import { logHandler } from './log.js';
import { statsHandler } from './stats.js';

export const MakanickoCommand = Ix.global(
  {
    name: 'makanicko',
    description: 'Activity tracking',
    description_localizations: { cs: 'Sledování aktivit' },
    options: [
      {
        type: DiscordTypes.ApplicationCommandOptionType.SUB_COMMAND,
        name: 'log',
        name_localizations: { cs: 'zaznamenat' },
        description: 'Log an activity',
        description_localizations: { cs: 'Zaznamenat aktivitu' },
        options: [
          {
            name: 'activity',
            description: 'Activity type',
            description_localizations: { cs: 'Typ aktivity' },
            type: DiscordTypes.ApplicationCommandOptionType.STRING,
            required: true as const,
            autocomplete: true as const,
          },
          {
            name: 'duration',
            description: 'Duration in minutes',
            description_localizations: { cs: 'Délka v minutách' },
            type: DiscordTypes.ApplicationCommandOptionType.INTEGER,
            required: false as const,
            min_value: 1,
            max_value: 1440,
          },
          {
            name: 'note',
            description: 'Note',
            description_localizations: { cs: 'Poznámka' },
            type: DiscordTypes.ApplicationCommandOptionType.STRING,
            required: false as const,
          },
        ],
      },
      {
        type: DiscordTypes.ApplicationCommandOptionType.SUB_COMMAND,
        name: 'stats',
        name_localizations: { cs: 'statistiky' },
        description: 'View your activity stats and streaks',
        description_localizations: { cs: 'Zobrazit statistiky aktivit a série' },
      },
      {
        type: DiscordTypes.ApplicationCommandOptionType.SUB_COMMAND,
        name: 'leaderboard',
        name_localizations: { cs: 'zebricek' },
        description: 'View the team leaderboard',
        description_localizations: { cs: 'Zobrazit týmový žebříček' },
      },
    ],
  } as const,
  (ix) =>
    ix.subCommands({
      log: logHandler,
      stats: statsHandler,
      leaderboard: leaderboardHandler,
    }),
);
