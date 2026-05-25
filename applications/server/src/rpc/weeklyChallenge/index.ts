import { WeeklyChallengeSyncEvents } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { DateTime, Effect } from 'effect';
import { WeeklyChallengeRepository } from '~/repositories/WeeklyChallengeRepository.js';

// ---------------------------------------------------------------------------
// Sync events RPC handlers (WeeklyChallengeSyncEventsRpcGroup)
//
// Only the outbox-drain group is exposed on the internal bot↔server channel.
// User-facing CRUD (List/Create/UpdateTitleDescription/Delete/Mark/Unmark)
// will be wired through the HTTP API in a follow-up PR (Part 2/3), with
// session-based authentication and captain-only authorisation.
// ---------------------------------------------------------------------------

export const WeeklyChallengeSyncEventsRpcLive = Effect.Do.pipe(
  Effect.bind('challenges', () => WeeklyChallengeRepository.asEffect()),
  Effect.let(
    'WeeklyChallenge/GetUnprocessedWeeklyChallengeEvents',
    ({ challenges }) =>
      () =>
        challenges.listUnprocessedDueEvents().pipe(
          Effect.map((rows) =>
            rows.map(
              (row) =>
                new WeeklyChallengeSyncEvents.UnprocessedWeeklyChallengeEvent({
                  id: row.id,
                  teamId: row.team_id,
                  challengeId: row.challenge_id,
                  channelId: row.channel_id,
                  scheduledFor: DateTime.makeUnsafe(row.scheduled_for.getTime()),
                  attempts: row.attempts,
                  title: row.title,
                  kind: row.kind,
                  description: row.description,
                  weekStartDate: row.week_start_date.toISOString().split('T')[0] ?? '',
                  weekEndDate:
                    new Date(row.week_start_date.getTime() + 6 * 24 * 60 * 60 * 1000)
                      .toISOString()
                      .split('T')[0] ?? '',
                }),
            ),
          ),
        ),
  ),
  Effect.let(
    'WeeklyChallenge/MarkWeeklyChallengeProcessed',
    ({ challenges }) =>
      ({
        eventId,
        deliveredAt,
      }: {
        readonly eventId: string;
        readonly deliveredAt: DateTime.Utc;
      }) =>
        challenges.markProcessed(eventId, new Date(deliveredAt.epochMilliseconds)),
  ),
  Effect.let(
    'WeeklyChallenge/MarkWeeklyChallengeFailed',
    ({ challenges }) =>
      ({ eventId, error }: { readonly eventId: string; readonly error: string }) =>
        challenges.markFailed(eventId, error),
  ),
  Bind.remove('challenges'),
  (handlers) => WeeklyChallengeSyncEvents.WeeklyChallengeSyncEventsRpcGroup.toLayer(handlers),
);
