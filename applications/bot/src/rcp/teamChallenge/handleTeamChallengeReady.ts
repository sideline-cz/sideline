import type { TeamChallengeSyncEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, type Option } from 'effect';
import { buildTeamChallengeEmbed } from '~/rest/teamChallenge/buildTeamChallengeEmbed.js';
import { retryPolicy } from '~/rest/utils.js';

export const handleTeamChallengeReady = (
  event: TeamChallengeSyncEvents.UnprocessedTeamChallengeEvent,
  webUrl: Option.Option<string>,
) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.tap(({ rest }) => {
      // TODO(part-3 or later): plumb team.onboarding_locale through
      // UnprocessedTeamChallengeEvent. For MVP, product is Czech-primary.
      const embed = buildTeamChallengeEmbed({
        title: event.title,
        kind: event.kind,
        description: event.description,
        startDate: event.startDate,
        endDate: event.endDate,
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
      // failed. This matches the achievement & weekly-summary precedent.
      //
      // Effect.suspend is required here: in Effect v4, Effect.retry re-executes
      // the same Effect description. Without Effect.suspend, rest.createMessage(...)
      // is called eagerly and produces a fixed value; retries replay that frozen
      // value rather than re-invoking createMessage.
      return Effect.suspend(() => rest.createMessage(event.channelId, { embeds: [embed] })).pipe(
        Effect.tap(() =>
          Effect.logInfo(
            `Posted team challenge embed to channel ${event.channelId} for team ${event.teamId}`,
          ),
        ),
        Effect.catchTag('ErrorResponse', (err) =>
          err.response.status === 404
            ? Effect.logWarning(
                `Team challenge event ${event.id} skipped: channel ${event.channelId} not found (404), team ${event.teamId}`,
              )
            : Effect.fail(err),
        ),
        Effect.retry(retryPolicy),
      );
    }),
    Effect.asVoid,
  );
