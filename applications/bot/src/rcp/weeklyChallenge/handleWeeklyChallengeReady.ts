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
      // NOTE: on 404 the handler returns Effect.void. The outer Effect.catchAll in
      // ProcessorService will NOT fire, so the row is marked PROCESSED, not
      // failed. This matches the achievement & weekly-summary precedent — a
      // permanently-gone channel cannot be retried into existence, so further
      // attempts would be wasted.
      // Effect.suspend is required here: in Effect v4, calling rest.createMessage(...)
      // eagerly creates a fixed Effect value. Effect.retry re-executes the same Effect
      // description — without suspend, it would replay the same frozen value rather than
      // re-calling createMessage. Effect.suspend defers the call so each retry invokes
      // createMessage afresh (the canonical handleAchievementEarned pattern uses
      // Effect.suspend for the same reason).
      return Effect.suspend(() => rest.createMessage(event.channelId, { embeds: [embed] })).pipe(
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
    Effect.tap(() =>
      Effect.logInfo(
        `Posted weekly challenge embed to channel ${event.channelId} for team ${event.teamId}`,
      ),
    ),
    Effect.asVoid,
  );
