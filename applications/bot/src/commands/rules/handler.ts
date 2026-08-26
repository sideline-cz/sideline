import * as m from '@sideline/i18n/messages';
import type { Level } from '@sideline/rules';
import { LEVELS } from '@sideline/rules';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Metric } from 'effect';
import { guildLocale, userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { asRecord } from '~/rest/recordProbe.js';
import { buildQuizMessage } from '~/rest/rules/buildQuizMessage.js';
import { pickScenario } from '~/rest/rules/pickScenario.js';

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
 * `/rules` — posts one situation to the channel as a shared quiz.
 *
 * Answers synchronously with `CHANNEL_MESSAGE_WITH_SOURCE` and no fork: the
 * content is already in memory (see `pickScenario.ts`), so there is no I/O
 * racing the 3-second ack, and therefore no deferred reply and no
 * `forkDetach` backstop to get wrong.
 *
 * Locale is deliberately split, per `applications/bot/AGENTS.md`: this
 * message is permanent and visible to the whole channel, so it renders in
 * the **guild** locale. The ephemeral chain each participant opens from it
 * renders in their own **user** locale — see `interactions/rules.ts`.
 */
export const rulesHandler = Interaction.asEffect().pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'command' }),
      1,
    ),
  ),
  Effect.map((interaction) => {
    const scenario = pickScenario(packageOption(interaction));

    if (!scenario) {
      // Only reachable if the level filter matches nothing — surfaced rather
      // than silently answering with a scenario from a different package.
      return Ix.response({
        type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: m.bot_rules_none_found({}, { locale: userLocale(interaction) }),
          flags: DiscordTypes.MessageFlags.Ephemeral,
        },
      });
    }

    const { embeds, components } = buildQuizMessage(scenario, guildLocale(interaction));

    return Ix.response({
      type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { embeds: [...embeds], components: [...components] },
    });
  }),
);
