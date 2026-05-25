import { TeamChallengeSyncEvents } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { DateTime, Effect } from 'effect';
import { formatDateUtc } from '~/helpers/teamChallenge.js';
import { TeamChallengeRepository } from '~/repositories/TeamChallengeRepository.js';

// ---------------------------------------------------------------------------
// Sync events RPC handlers (TeamChallengeSyncEventsRpcGroup)
//
// Handles outbox-drain for team challenge announcement events consumed by the
// bot. User-facing CRUD is handled through the HTTP API.
// ---------------------------------------------------------------------------

export const TeamChallengeSyncEventsRpcLive = Effect.Do.pipe(
  Effect.bind('challenges', () => TeamChallengeRepository.asEffect()),
  Effect.let(
    'TeamChallenge/GetUnprocessedTeamChallengeEvents',
    ({ challenges }) =>
      () =>
        challenges.listUnprocessedDueEvents().pipe(
          Effect.map((rows) =>
            rows.map(
              (row) =>
                new TeamChallengeSyncEvents.UnprocessedTeamChallengeEvent({
                  id: row.id,
                  teamId: row.team_id,
                  challengeId: row.challenge_id,
                  channelId: row.channel_id,
                  scheduledFor: DateTime.makeUnsafe(row.scheduled_for.getTime()),
                  attempts: row.attempts,
                  title: row.title,
                  kind: row.kind,
                  description: row.description,
                  startDate: formatDateUtc(row.start_date),
                  endDate: formatDateUtc(row.end_date),
                }),
            ),
          ),
        ),
  ),
  Effect.let(
    'TeamChallenge/MarkTeamChallengeProcessed',
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
    'TeamChallenge/MarkTeamChallengeFailed',
    ({ challenges }) =>
      ({ eventId, error }: { readonly eventId: string; readonly error: string }) =>
        challenges.markFailed(eventId, error),
  ),
  Bind.remove('challenges'),
  (handlers) => TeamChallengeSyncEvents.TeamChallengeSyncEventsRpcGroup.toLayer(handlers),
);
