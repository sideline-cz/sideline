import {
  type Achievement,
  AchievementRpcGroup,
  type AchievementSyncEvent,
  type CustomAchievement,
  type Discord,
  type Team,
} from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { Array, Effect, flow, Option, Result } from 'effect';
import { AchievementRoleMappingsRepository } from '~/repositories/AchievementRoleMappingsRepository.js';
import { AchievementSyncEventsRepository } from '~/repositories/AchievementSyncEventsRepository.js';
import { CustomAchievementsRepository } from '~/repositories/CustomAchievementsRepository.js';
import { constructEvent, EventPropertyMissing } from './events.js';

export const AchievementRpcLive = Effect.Do.pipe(
  Effect.bind('syncEvents', () => AchievementSyncEventsRepository.asEffect()),
  Effect.bind('roleMappings', () => AchievementRoleMappingsRepository.asEffect()),
  Effect.bind('customs', () => CustomAchievementsRepository.asEffect()),
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
  Effect.let(
    'Achievement/UpsertBuiltInRoleMapping',
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
  Effect.let(
    'Achievement/UpsertCustomRoleMapping',
    ({ customs }) =>
      ({
        team_id,
        custom_achievement_id,
        discord_role_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly custom_achievement_id: CustomAchievement.CustomAchievementId;
        readonly discord_role_id: Discord.Snowflake;
      }) =>
        customs.setRoleMapping(team_id, custom_achievement_id, Option.some(discord_role_id)),
  ),
  Bind.remove('syncEvents'),
  Bind.remove('roleMappings'),
  Bind.remove('customs'),
  (handlers) => AchievementRpcGroup.AchievementRpcGroup.toLayer(handlers),
);
