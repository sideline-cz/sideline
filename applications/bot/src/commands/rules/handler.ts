import * as m from '@sideline/i18n/messages';
import type { Level } from '@sideline/rules';
import { LEVELS } from '@sideline/rules';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Metric, Option } from 'effect';
import { userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { asRecord } from '~/rest/recordProbe.js';
import { buildChainMessage } from '~/rest/rules/buildChainMessage.js';
import { quizPerms } from '~/rest/rules/perms.js';
import { pickScenario } from '~/rest/rules/pickScenario.js';
import { replayAnswer } from '~/rest/rules/quizState.js';
import { interactionUserId } from '~/schemas.js';

/** `@sideline/rules` has no runtime `Level` guard — `isLevel` lives in
 * `applications/web/src/lib/rules/level.ts` and is web-local. This is the
 * bot's own, checked against the package's `LEVELS` so it cannot drift if a
 * tenth package is ever authored. */
const isLevel = (value: number): value is Level => (LEVELS as readonly number[]).includes(value);

/** The chosen `package` option, or `undefined` for "any package". Reads the
 * raw options array the same way `pollHandler` does. */
const packageOption = (interaction: DiscordTypes.APIInteraction): Level | undefined => {
  const data = asRecord(interaction.data);
  const options: unknown = data?.options;
  if (!Array.isArray(options)) return undefined;
  for (const raw of options) {
    const opt = asRecord(raw);
    if (opt?.name !== 'package') continue;
    const value = Number(opt.value);
    return Number.isInteger(value) && isLevel(value) ? value : undefined;
  }
  return undefined;
};

/**
 * `/rules` — one situation, **private to whoever ran it**, opening straight
 * into their own chain.
 *
 * Ephemeral and single-step by design: the invoker already chose to
 * practise, so a public card with a "start" button would put a wasted click
 * in front of them and their picks in front of everyone else. The SHARED
 * form of the quiz — public question, one button, per-participant private
 * chains — is what the scheduled channel post produces (see
 * `RulesQuizSyncService` in the bot and `RulesQuizCron` on the server); the
 * two surfaces share `buildChainMessage`, so a chain answered from either
 * behaves identically.
 *
 * Answers synchronously with no fork: content is already in memory (see
 * `pickScenario.ts`), so there is no I/O racing the 3-second ack, and
 * therefore no deferred reply and no `forkDetach` backstop to get wrong.
 * Renders in the **user** locale — an ephemeral message has one reader.
 */
export const rulesHandler = Interaction.asEffect().pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'command' }),
      1,
    ),
  ),
  Effect.map((interaction) => {
    const locale = userLocale(interaction);
    const scenario = pickScenario(packageOption(interaction));
    const userId = interactionUserId(interaction);

    if (!scenario || Option.isNone(userId)) {
      // No scenario is only reachable if the level filter matches nothing —
      // surfaced rather than silently answering from a different package.
      return Ix.response({
        type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: m.bot_rules_none_found({}, { locale }),
          flags: DiscordTypes.MessageFlags.Ephemeral,
        },
      });
    }

    const { embeds, components } = buildChainMessage(
      scenario,
      replayAnswer(scenario, []),
      quizPerms(scenario, userId.value),
      locale,
    );

    return Ix.response({
      type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [...embeds],
        components: [...components],
        flags: DiscordTypes.MessageFlags.Ephemeral,
      },
    });
  }),
);
