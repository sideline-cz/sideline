/**
 * The **public** half of the Discord rules quiz: one message in the channel
 * carrying the situation and a single button that opens each participant's
 * own private chain.
 *
 * This message is shared, so it renders **only** what is safe for everyone
 * to see at once — the setup and the question, never a step, never a
 * verdict. That is the spoiler gate expressed as a message boundary: the
 * public message is frozen at the equivalent of `qAt`, and everything past
 * it lives in the ephemeral follow-up (see `buildChainMessage.ts`).
 *
 * It also carries no per-user state whatsoever, per the "per-user actions on
 * a shared board message" rule in `applications/bot/AGENTS.md`: the button's
 * `custom_id` encodes the scenario id and nothing else, and the acting
 * participant is resolved server-side from the interaction.
 */

import * as m from '@sideline/i18n/messages';
import type { Scenario } from '@sideline/rules';
import { text } from '@sideline/rules';
import { UI } from 'dfx';
import * as Discord from 'dfx/types';
import type { Locale } from '~/locale.js';
import { encodeStartId } from './quizState.js';

/** Discord blurple, matching the poll board. */
const COLOR_QUIZ = 0x5865f2;

const EMBED_TITLE_MAX = 256;
const EMBED_FIELD_VALUE_MAX = 1024;

export const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

export const buildQuizMessage = (
  scenario: Scenario,
  locale: Locale,
): {
  embeds: ReadonlyArray<Discord.RichEmbed>;
  components: ReadonlyArray<Discord.ActionRowComponentForMessageRequest>;
} => {
  const embed: Discord.RichEmbed = {
    title: truncate(`📜 ${text(scenario.title, locale)}`, EMBED_TITLE_MAX),
    color: COLOR_QUIZ,
    fields: [
      {
        name: m.rules_situation({}, { locale }),
        value: truncate(text(scenario.situation, locale), EMBED_FIELD_VALUE_MAX),
      },
      {
        name: m.rules_yourRole({}, { locale }),
        value: truncate(text(scenario.role, locale), EMBED_FIELD_VALUE_MAX),
      },
      {
        name: text(scenario.question, locale).slice(0, EMBED_TITLE_MAX),
        // The question is the field NAME so it reads as the prompt; the value
        // carries the call to action, since a field with an empty value is
        // rejected by Discord.
        value: m.bot_rules_quiz_prompt({}, { locale }),
      },
    ],
    footer: { text: m.bot_rules_quiz_footer({}, { locale }) },
  };

  const components: ReadonlyArray<Discord.ActionRowComponentForMessageRequest> = [
    UI.row([
      UI.button({
        style: Discord.ButtonStyleTypes.PRIMARY,
        label: m.bot_rules_answer_button({}, { locale }),
        custom_id: encodeStartId(scenario.id),
      }),
    ]),
  ];

  return { embeds: [embed], components };
};
