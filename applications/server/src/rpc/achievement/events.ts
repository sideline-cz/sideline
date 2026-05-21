import { AchievementRpcEvents, type AchievementSyncEvent } from '@sideline/domain';
import { Data, Effect } from 'effect';
import {
  type AchievementSyncEventRow,
  AchievementSyncEventsRepository,
} from '~/repositories/AchievementSyncEventsRepository.js';

export class EventPropertyMissing extends Data.TaggedError('AchievementEventPropertyMissing')<{
  id: AchievementSyncEvent.AchievementSyncEventId;
  property: string;
}> {
  errorMessage = () =>
    `Property "${this.property}" is missing for achievement event with id "${this.id}"`;

  log = () => Effect.logError(this.errorMessage());

  markFailed = () =>
    AchievementSyncEventsRepository.asEffect().pipe(
      Effect.flatMap((repository) => repository.markFailed(this.id, this.errorMessage())),
    );

  static handle = (e: EventPropertyMissing) => e.log().pipe(Effect.tap(() => e.markFailed()));
}

export const constructEvent = (
  row: AchievementSyncEventRow,
): Effect.Effect<AchievementRpcEvents.AchievementEarnedEvent, EventPropertyMissing> =>
  Effect.succeed(
    new AchievementRpcEvents.AchievementEarnedEvent({
      id: row.id,
      team_id: row.team_id,
      guild_id: row.guild_id,
      team_member_id: row.team_member_id,
      achievement_slug: row.achievement_slug,
      discord_user_id: row.discord_user_id,
      achievement_channel_id: row.achievement_channel_id,
      discord_role_id: row.discord_role_id,
    }),
  );
