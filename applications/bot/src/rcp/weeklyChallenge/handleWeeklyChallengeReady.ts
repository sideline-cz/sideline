import type { WeeklyChallengeSyncEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, type Option } from 'effect';
import { retryPolicy } from '~/rest/utils.js';
import { buildWeeklyChallengeEmbed } from '~/rest/weeklyChallenge/buildWeeklyChallengeEmbed.js';

export const handleWeeklyChallengeReady = (
  event: WeeklyChallengeSyncEvents.UnprocessedWeeklyChallengeEvent,
  webUrl: Option.Option<string>,
) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.tap(({ rest }) => {
      // TODO(part-3 or later): plumb team.onboarding_locale through
      // UnprocessedWeeklyChallengeEvent. For MVP, product is Czech-primary.
      const embed = buildWeeklyChallengeEmbed({
        title: event.title,
        kind: event.kind,
        description: event.description,
        weekStartDate: event.weekStartDate,
        weekEndDate: event.weekEndDate,
        teamId: event.teamId,
        webUrl,
        locale: 'cs',
      });

      // Order: short-circuit 404 BEFORE Effect.retry. A deleted channel is a
      // permanent failure; retrying only delays the worker. Other Discord
      // permission codes (e.g. 50001 / 50013) intentionally bubble through the
      // retry policy — the server-side 5-attempt cap eventually terminates them
      // by ceasing to return the row.
      //
      // NOTE: on 404 the handler returns Effect.void. The outer Effect.catch in
      // ProcessorService will NOT fire, so the row is marked PROCESSED, not
      // failed. This matches the achievement & weekly-summary precedent — a
      // permanently-gone channel cannot be retried into existence, so further
      // attempts would be wasted.
      //
      // Effect.suspend is required here: in Effect v4, Effect.retry re-executes
      // the same Effect description. Without Effect.suspend, rest.createMessage(...)
      // is called eagerly and produces a fixed value; retries replay that frozen
      // value rather than re-invoking createMessage. Effect.suspend defers the call
      // so each retry actually re-invokes createMessage. handleAchievementEarned
      // does NOT use Effect.suspend, so its retry-on-5xx path has a latent bug
      // (no retry-count test exists there). This handler uses Effect.suspend based
      // on empirical testing with Effect v4 beta.
      return Effect.suspend(() => rest.createMessage(event.channelId, { embeds: [embed] })).pipe(
        Effect.tap(() =>
          Effect.logInfo(
            `Posted weekly challenge embed to channel ${event.channelId} for team ${event.teamId}`,
          ),
        ),
        Effect.catchTag('ErrorResponse', (err) =>
          err.response.status === 404
            ? Effect.logWarning(
                `Weekly challenge event ${event.id} skipped: channel ${event.channelId} not found (404), team ${event.teamId}`,
              )
            : Effect.fail(err),
        ),
        Effect.retry(retryPolicy),
      );
    }),
    Effect.asVoid,
  );
