import {
  type Achievement,
  AchievementRpcGroup,
  type AchievementSyncEvent,
  type Discord,
  type Team,
} from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { Array, Effect, flow, Result } from 'effect';
import { AchievementRoleMappingsRepository } from '~/repositories/AchievementRoleMappingsRepository.js';
import { AchievementSyncEventsRepository } from '~/repositories/AchievementSyncEventsRepository.js';
import { constructEvent, EventPropertyMissing } from './events.js';

export const AchievementRpcLive = Effect.Do.pipe(
  Effect.bind('syncEvents', () => AchievementSyncEventsRepository.asEffect()),
  Effect.bind('roleMappings', () => AchievementRoleMappingsRepository.asEffect()),
  Effect.let(
    'Achievement/GetUnprocessedEvents',
    ({ syncEvents }) =>
      ({ limit }: { readonly limit: number }) =>
        syncEvents.findUnprocessed(limit).pipe(
          Effect.map(
            Array.map(
              flow(
                constructEvent,
                Effect.tapError(Effect.logError),
                Effect.tapErrorTag('AchievementEventPropertyMissing', EventPropertyMissing.handle),
                Effect.result,
              ),
            ),
          ),
          Effect.flatMap(Effect.all),
          Effect.tap(flow(Array.filterMap(Result.flip), Array.map(Effect.logError), Effect.all)),
          Effect.map(Array.filterMap((r) => r)),
          Effect.tap((events) =>
            Effect.logInfo(
              `Successfully mapped ${events.length} achievement events from database.`,
            ),
          ),
        ),
  ),
  Effect.let(
    'Achievement/MarkEventProcessed',
    ({ syncEvents }) =>
      ({ id }: { readonly id: AchievementSyncEvent.AchievementSyncEventId }) =>
        syncEvents.markProcessed(id),
  ),
  Effect.let(
    'Achievement/MarkEventFailed',
    ({ syncEvents }) =>
      ({
        id,
        error,
      }: {
        readonly id: AchievementSyncEvent.AchievementSyncEventId;
        readonly error: string;
      }) =>
        syncEvents.markFailed(id, error),
  ),
  Effect.let(
    'Achievement/GetRoleMapping',
    ({ roleMappings }) =>
      ({
        team_id,
        achievement_slug,
      }: {
        readonly team_id: Team.TeamId;
        readonly achievement_slug: Achievement.AchievementSlug;
      }) =>
        roleMappings.findByTeamAndSlug(team_id, achievement_slug),
  ),
  Effect.let(
    'Achievement/UpsertRoleMapping',
    ({ roleMappings }) =>
      ({
        team_id,
        achievement_slug,
        discord_role_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly achievement_slug: Achievement.AchievementSlug;
        readonly discord_role_id: Discord.Snowflake;
      }) =>
        roleMappings.upsert(team_id, achievement_slug, discord_role_id),
  ),
  Bind.remove('syncEvents'),
  Bind.remove('roleMappings'),
  (handlers) => AchievementRpcGroup.AchievementRpcGroup.toLayer(handlers),
);
