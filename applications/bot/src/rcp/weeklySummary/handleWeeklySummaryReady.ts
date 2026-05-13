import type { WeeklySummaryRpcEvents } from '@sideline/domain';
import { WeeklySummary } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Schema } from 'effect';
import { retryPolicy } from '~/rest/utils.js';
import { buildWeeklySummaryEmbed } from '~/rest/weeklySummary/buildWeeklySummaryEmbed.js';

export const handleWeeklySummaryReady = (event: WeeklySummaryRpcEvents.WeeklySummaryReadyEvent) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('digest', () =>
      Schema.decodeUnknownEffect(WeeklySummary.WeeklySummaryDigest)(event.payload).pipe(
        Effect.mapError((e) => new Error(`Failed to decode weekly summary payload: ${String(e)}`)),
      ),
    ),
    Effect.tap(({ rest, digest }) => {
      const { embeds } = buildWeeklySummaryEmbed({
        week: digest.week,
        teamSummary: digest.teamSummary,
        locale: 'en',
      });
      return rest.createMessage(event.channel_id, { embeds }).pipe(
        Effect.retry(retryPolicy),
        Effect.catchTag('ErrorResponse', (err) =>
          err.response.status === 404
            ? Effect.logWarning(
                `Weekly summary channel ${event.channel_id} not found (404) for team ${event.team_id}, skipping`,
              )
            : Effect.fail(err),
        ),
      );
    }),
    Effect.tap(() =>
      Effect.logInfo(
        `Posted weekly summary embed to channel ${event.channel_id} for team ${event.team_id}`,
      ),
    ),
    Effect.asVoid,
  );
