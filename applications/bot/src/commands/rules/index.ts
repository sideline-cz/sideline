import * as m from '@sideline/i18n/messages';
import { LEVEL_META, LEVELS } from '@sideline/rules';
import * as Ix from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { rulesHandler } from './handler.js';

/**
 * `/rules` — post a WFDF rules situation to the channel as a shared quiz.
 *
 * Not admin-gated: unlike `/poll`, this creates nothing and changes nothing,
 * so any member may start one.
 *
 * ⚠️ **Every `description` here — and every `description_localizations`
 * entry — must stay ≤100 characters.** An over-length description in ANY
 * locale makes Discord reject the *entire* command registration with a 400
 * and crash-loops the bot, with no error surfacing in logs. There is a guard
 * test covering this; keep it passing.
 */
export const RulesCommand = Ix.global(
  {
    name: 'rules',
    name_localizations: { cs: 'pravidla' },
    description: m.bot_rules_cmd_desc({}, { locale: 'en' }),
    description_localizations: { cs: m.bot_rules_cmd_desc({}, { locale: 'cs' }) },
    dm_permission: false,
    options: [
      {
        name: 'package',
        name_localizations: { cs: 'balíček' },
        description: m.bot_rules_opt_package_desc({}, { locale: 'en' }),
        description_localizations: { cs: m.bot_rules_opt_package_desc({}, { locale: 'cs' }) },
        type: DiscordTypes.ApplicationCommandOptionType.INTEGER,
        required: false as const,
        // Nine packages, well inside Discord's 25-choice ceiling, so the
        // whole set is offered as choices rather than needing autocomplete.
        choices: LEVELS.map((level) => ({
          name: LEVEL_META[level].name.en,
          name_localizations: { cs: LEVEL_META[level].name.cs },
          value: level,
        })),
      },
    ],
  } as const,
  rulesHandler,
);
