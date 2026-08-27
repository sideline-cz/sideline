import type { RulesQuizRpcGroup } from '@sideline/domain';
import { text } from '@sideline/rules';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect } from 'effect';
import type { Locale } from '~/locale.js';
import { buildQuizMessage, truncate } from '~/rest/rules/buildQuizMessage.js';
import { scenarioById } from '~/rest/rules/pickScenario.js';
import { retryPolicy } from '~/rest/utils.js';

/** Discord thread names are capped at 100 characters. */
const THREAD_NAME_MAX = 100;

/**
 * Posts one scheduled situation to a team's nominated channel and opens a
 * public thread on it.
 *
 * **The thread is where discussion goes; the message stays clean.** Each
 * participant's own answers remain ephemeral (they press the button and get a
 * private chain — see `interactions/rules.ts`), so the thread is for arguing
 * about the ruling afterwards, which is the part worth keeping and the part
 * that would otherwise bury the channel.
 *
 * Thread creation is deliberately NOT fatal: if it fails — missing
 * `CreatePublicThreads`, a thread already there from a retry, an archived
 * channel — the situation has still been posted and is still answerable, so
 * the event is marked processed rather than retried. Retrying would repost
 * the situation, which is worse than a missing thread.
 *
 * The guild locale is used throughout: this message is permanent and visible
 * to the whole channel.
 */
export const handleQuizDue = (event: RulesQuizRpcGroup.RulesQuizPendingEvent, locale: Locale) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('scenario', () => {
      const scenario = scenarioById(event.scenario_id);
      return scenario === undefined
        ? Effect.fail(new Error(`Unknown scenario id ${event.scenario_id}`))
        : Effect.succeed(scenario);
    }),
    Effect.bind('message', ({ rest, scenario }) => {
      const { embeds, components } = buildQuizMessage(scenario, locale);
      return rest
        .createMessage(event.channel_id, {
          embeds: [...embeds],
          components: [...components],
        })
        .pipe(Effect.retry(retryPolicy));
    }),
    Effect.tap(({ rest, scenario, message }) =>
      rest
        .createThreadFromMessage(event.channel_id, message.id, {
          name: truncate(text(scenario.title, locale), THREAD_NAME_MAX),
          // 1440 = 24h. Long enough for a day's discussion, short enough that
          // a channel does not accumulate open threads indefinitely.
          auto_archive_duration: 1440,
        })
        .pipe(
          Effect.asVoid,
          // See the doc above: a missing thread must not cause the situation
          // to be posted twice.
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `RulesQuiz: posted ${event.scenario_id} but could not open a thread in ${event.channel_id}`,
              cause,
            ),
          ),
        ),
    ),
    Effect.tap(({ scenario }) =>
      Effect.logInfo(
        `RulesQuiz: posted ${scenario.id} to ${event.channel_id} for team ${event.team_id}`,
      ),
    ),
    Effect.asVoid,
  );
