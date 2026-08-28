/**
 * The Discord rules quiz's interaction handlers.
 *
 * Shape (owner's design, recorded in `docs/plans/rules-trainer.md`): the
 * `/rules` command posts **one public message** carrying the situation and a
 * single button; pressing that button opens the presser's **own ephemeral
 * chain**. The public message never changes and never shows an answer, so a
 * channel of people can work the same situation simultaneously without
 * seeing each other's picks — the failure mode Sideline has been bitten by
 * before, and the reason `applications/bot/AGENTS.md` carries the "per-user
 * actions on a shared board message" rule.
 *
 * **Only the final press of a chain does any I/O.** Opening a chain and
 * every mid-chain press are pure computation over content already in memory
 * (`pickScenario.ts`), so they answer inline and never risk the 3-second
 * ack. The press that COMPLETES a chain submits the attempt, so that one
 * defers and resolves from a detached fork — with the terminal defect
 * backstop `applications/bot/AGENTS.md` requires of every deferred reply.
 *
 * Both handlers reply in the **user** locale, not the guild's: an ephemeral
 * message has exactly one reader.
 */
import * as m from '@sideline/i18n/messages';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Metric, Option } from 'effect';
import { userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { asRecord } from '~/rest/recordProbe.js';
import { buildChainMessage } from '~/rest/rules/buildChainMessage.js';
import { quizPerms } from '~/rest/rules/perms.js';
import { scenarioById } from '~/rest/rules/pickScenario.js';
import {
  decodeStartId,
  decodeStepId,
  QUIZ_START_PREFIX,
  QUIZ_STEP_PREFIX,
  replayAnswer,
} from '~/rest/rules/quizState.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const customIdOf = (interaction: DiscordTypes.APIInteraction): string => {
  const value = asRecord(interaction.data)?.custom_id;
  return typeof value === 'string' ? value : '';
};

const countInteraction = Metric.update(
  Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'component' }),
  1,
);

/** Type 6 — acknowledges the press and edits the presser's own ephemeral in
 * place once the fork resolves. Same shape poll-vote uses. */
const deferredUpdateMessage = Ix.response({
  type: DiscordTypes.InteractionCallbackTypes.DEFERRED_UPDATE_MESSAGE,
});

type RestError = Effect.Error<ReturnType<DiscordRestService['updateOriginalWebhookMessage']>>;

type WebhookUpdatePayload = Parameters<
  DiscordRestService['updateOriginalWebhookMessage']
>[2]['payload'];

/** Resolve the deferred ephemeral, logging and swallowing REST failures —
 * there is nowhere left to report them to. */
const replyWebhook = (
  rest: DiscordRestService,
  interaction: DiscordTypes.APIInteraction,
  payload: WebhookUpdatePayload,
  /** The resolution clip, once this participant's chain is done. Empty until
   * then, and empty whenever `RULES_GIF_DIR` is unset (dev, tests). */
  files: ReadonlyArray<File> = [],
) => {
  const update = rest
    .updateOriginalWebhookMessage(interaction.application_id, interaction.token, { payload })
    .pipe(
      Effect.catchTag(['ErrorResponse', 'HttpClientError', 'RatelimitedResponse'], (e: RestError) =>
        Effect.logError('Failed to update rules chain message', e),
      ),
    );
  return files.length === 0 ? update : rest.withFiles([...files])(update);
};

/** A stale or hand-crafted `custom_id` — reply ephemerally rather than
 * failing the interaction, which would show Discord's generic red error. */
const staleReply = (interaction: DiscordTypes.APIInteraction) =>
  Ix.response({
    type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: m.bot_rules_stale({}, { locale: userLocale(interaction) }),
      flags: DiscordTypes.MessageFlags.Ephemeral,
    },
  });

/**
 * `rules-start:<scenarioId>` — opens the presser's private chain.
 *
 * Responds with a NEW ephemeral message rather than updating the public one,
 * which is the whole point: the shared message is left untouched for
 * everyone else still thinking.
 */
export const RulesStartButton = Interaction.asEffect().pipe(
  Effect.tap(() => countInteraction),
  Effect.map((interaction) => {
    const scenarioId = decodeStartId(customIdOf(interaction));
    const scenario = scenarioId === undefined ? undefined : scenarioById(scenarioId);
    const userId = interactionUserId(interaction);
    if (!scenario || Option.isNone(userId)) return staleReply(interaction);

    const perms = quizPerms(scenario, userId.value);
    const answer = replayAnswer(scenario, []);
    const { embeds, components } = buildChainMessage(
      scenario,
      answer,
      perms,
      userLocale(interaction),
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

export const RulesStartButtonReg = Ix.messageComponent(
  Ix.idStartsWith(QUIZ_START_PREFIX),
  RulesStartButton,
);

/**
 * `rules-step:<scenarioId>:<picks>` — one option press.
 *
 * `picks` already includes the pick this button represents (see
 * `quizState.ts`), so the handler is a pure render of the resulting state:
 * decode, replay, re-render. `UPDATE_MESSAGE` edits the presser's own
 * ephemeral in place, so a chain stays one message rather than a stack.
 *
 * The permutation is re-derived from `(scenario, userId)` rather than
 * stored, so it is identical on every press of the same chain — see
 * `perms.ts` for why that matters.
 */
export const RulesStepButton = Effect.Do.pipe(
  Effect.tap(() => countInteraction),
  Effect.bind('interaction', () => Interaction.asEffect()),
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('rest', () => DiscordREST.asEffect()),
  Effect.flatMap(({ interaction, rpc, rest }) => {
    const decoded = decodeStepId(customIdOf(interaction));
    const scenario = decoded === undefined ? undefined : scenarioById(decoded.scenarioId);
    const userId = interactionUserId(interaction);
    if (!decoded || !scenario || Option.isNone(userId)) {
      return Effect.succeed(staleReply(interaction));
    }

    const locale = userLocale(interaction);
    const perms = quizPerms(scenario, userId.value);
    const answer = replayAnswer(scenario, decoded.picks);
    const render = (saveNote?: string) =>
      buildChainMessage(scenario, answer, perms, locale, saveNote);

    // Mid-chain: pure render, answered inline. Only the FINAL press has any
    // I/O, so the common case never pays for a deferred round trip.
    if (!answer.done) {
      const { embeds, components } = render();
      return Effect.succeed(
        Ix.response({
          type: DiscordTypes.InteractionCallbackTypes.UPDATE_MESSAGE,
          data: { embeds: [...embeds], components: [...components] },
        }),
      );
    }

    // The chain just completed. Submit it, then render the outcome — the
    // save note is only ever written from a RESOLVED submit, so "saved" is
    // never shown optimistically.
    const submitAndRender = rpc['Rules/SubmitAttempt']({
      discord_user_id: userId.value,
      mode: 'practice',
      packages: [scenario.level],
      results: [
        {
          scenario_id: scenario.id,
          steps: answer.steps.map((s) => Option.fromNullOr(s.pick)),
        },
      ],
    }).pipe(
      Effect.map(() => m.bot_rules_saved({}, { locale })),
      // An unlinked account is an ordinary outcome, not a failure — most
      // Discord members have never signed in to Sideline.
      Effect.catchTag('RulesUserNotLinked', () =>
        Effect.succeed(m.bot_rules_not_linked({}, { locale })),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning('Rules attempt submit failed', cause).pipe(
          Effect.as(m.bot_rules_save_failed({}, { locale })),
        ),
      ),
      Effect.flatMap((saveNote) => {
        const { embeds, components, files } = render(saveNote);
        return replyWebhook(
          rest,
          interaction,
          { embeds: [...embeds], components: [...components] },
          files,
        );
      }),
      // Terminal defect backstop for a detached fork resolving a deferred
      // reply (`applications/bot/AGENTS.md`): the tail above already handles
      // every typed failure, so what remains is an untagged defect — which
      // would die in the forked fiber and leave the deferred update hanging
      // with the chain's last spinner state.
      Effect.catchDefect((defect) =>
        Effect.logError('Rules attempt submit defect', defect).pipe(
          Effect.flatMap(() => {
            const { embeds, components, files } = render(m.bot_rules_save_failed({}, { locale }));
            return replyWebhook(
              rest,
              interaction,
              { embeds: [...embeds], components: [...components] },
              files,
            );
          }),
        ),
      ),
    );

    return Effect.as(Effect.forkDetach(submitAndRender), deferredUpdateMessage);
  }),
);

export const RulesStepButtonReg = Ix.messageComponent(
  Ix.idStartsWith(QUIZ_STEP_PREFIX),
  RulesStepButton,
);
