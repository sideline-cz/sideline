import {
  ActivityRpcGroup,
  ActivityRpcModels,
  ActivityStats,
  ActivityType,
  type Discord,
  Leaderboard,
} from '@sideline/domain';
import { Bind, Options } from '@sideline/effect-lib';
import { DateTime, Effect, Option, Schema } from 'effect';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { ActivityTypesRepository } from '~/repositories/ActivityTypesRepository.js';
import { LeaderboardRepository } from '~/repositories/LeaderboardRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { AchievementEvaluator } from '~/services/AchievementEvaluator.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ActivityRpcLive = Effect.Do.pipe(
  Effect.bind('teams', () => TeamsRepository.asEffect()),
  Effect.bind('users', () => UsersRepository.asEffect()),
  Effect.bind('members', () => TeamMembersRepository.asEffect()),
  Effect.bind('activityLogs', () => ActivityLogsRepository.asEffect()),
  Effect.bind('activityTypes', () => ActivityTypesRepository.asEffect()),
  Effect.bind('leaderboardRepo', () => LeaderboardRepository.asEffect()),
  Effect.bind('evaluatorOpt', () => Effect.serviceOption(AchievementEvaluator)),
  Effect.let(
    'Activity/LogActivity',
    ({ teams, users, members, activityLogs, activityTypes, evaluatorOpt }) =>
      ({
        guild_id,
        discord_user_id,
        activity_type,
        duration_minutes,
        note,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly activity_type: string;
        readonly duration_minutes: Option.Option<number>;
        readonly note: Option.Option<string>;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () =>
            teams
              .findByGuildId(guild_id)
              .pipe(
                Effect.flatMap(
                  Options.toEffect(() => new ActivityRpcModels.ActivityGuildNotFound()),
                ),
              ),
          ),
          Effect.bind('user', () =>
            users
              .findByDiscordId(discord_user_id)
              .pipe(
                Effect.flatMap(
                  Options.toEffect(() => new ActivityRpcModels.ActivityMemberNotFound()),
                ),
              ),
          ),
          Effect.bind('member', ({ team, user }) =>
            members
              .findMembershipByIds(team.id, user.id)
              .pipe(
                Effect.flatMap(
                  Options.toEffect(() => new ActivityRpcModels.ActivityMemberNotFound()),
                ),
              ),
          ),
          Effect.tap(({ member }) =>
            member.active
              ? Effect.void
              : Effect.fail(new ActivityRpcModels.ActivityMemberNotFound()),
          ),
          // Resolve activity type: UUID → findByIdScoped (tenant isolation); slug → findBySlug
          Effect.bind('activityType', ({ team }) => {
            if (UUID_REGEX.test(activity_type)) {
              return activityTypes
                .findByIdScoped(
                  Schema.decodeSync(ActivityType.ActivityTypeId)(activity_type),
                  team.id,
                )
                .pipe(
                  Effect.flatMap(
                    Options.toEffect(() => new ActivityRpcModels.ActivityTypeNotFound()),
                  ),
                );
            }
            return activityTypes
              .findBySlug(activity_type)
              .pipe(
                Effect.flatMap(
                  Options.toEffect(() => new ActivityRpcModels.ActivityTypeNotFound()),
                ),
              );
          }),
          Effect.bind('inserted', ({ member, activityType }) =>
            activityLogs.insert({
              team_member_id: member.id,
              activity_type_id: activityType.id,
              logged_at: DateTime.toDateUtc(DateTime.nowUnsafe()),
              duration_minutes,
              note,
              source: 'manual',
            }),
          ),
          Effect.tap(({ member }) =>
            Option.match(evaluatorOpt, {
              onNone: () => Effect.void,
              onSome: (ev) =>
                ev
                  .evaluate(member.id)
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning('Achievement evaluation failed', cause),
                    ),
                  ),
            }),
          ),
          Effect.map(
            ({ inserted }) =>
              new ActivityRpcModels.LogActivityResult({
                id: inserted.id,
                activity_type_id: inserted.activity_type_id,
                logged_at: inserted.logged_at,
              }),
          ),
        ),
  ),
  Effect.let(
    'Activity/GetStats',
    ({ teams, users, members, activityLogs }) =>
      ({
        guild_id,
        discord_user_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () =>
            teams
              .findByGuildId(guild_id)
              .pipe(
                Effect.flatMap(
                  Options.toEffect(() => new ActivityRpcModels.ActivityGuildNotFound()),
                ),
              ),
          ),
          Effect.bind('user', () =>
            users
              .findByDiscordId(discord_user_id)
              .pipe(
                Effect.flatMap(
                  Options.toEffect(() => new ActivityRpcModels.ActivityMemberNotFound()),
                ),
              ),
          ),
          Effect.bind('member', ({ team, user }) =>
            members
              .findMembershipByIds(team.id, user.id)
              .pipe(
                Effect.flatMap(
                  Options.toEffect(() => new ActivityRpcModels.ActivityMemberNotFound()),
                ),
              ),
          ),
          Effect.tap(({ member }) =>
            member.active
              ? Effect.void
              : Effect.fail(new ActivityRpcModels.ActivityMemberNotFound()),
          ),
          Effect.bind('rows', ({ member }) => activityLogs.findByTeamMember(member.id)),
          Effect.map(({ rows }) => {
            const stats = ActivityStats.calculateStats(rows, ActivityStats.todayInPrague());
            return new ActivityRpcModels.GetStatsResult({
              current_streak: stats.currentStreak,
              longest_streak: stats.longestStreak,
              total_activities: stats.totalActivities,
              total_duration_minutes: stats.totalDurationMinutes,
              counts: stats.counts.map((c) => ({
                activity_type_id: c.activityTypeId,
                activity_type_name: c.activityTypeName,
                count: c.count,
              })),
            });
          }),
        ),
  ),
  Effect.let(
    'Activity/GetLeaderboard',
    ({ teams, users, members, leaderboardRepo }) =>
      ({
        guild_id,
        discord_user_id,
        limit,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly limit: Option.Option<number>;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () =>
            teams
              .findByGuildId(guild_id)
              .pipe(
                Effect.flatMap(
                  Options.toEffect(() => new ActivityRpcModels.ActivityGuildNotFound()),
                ),
              ),
          ),
          Effect.bind('user', () =>
            users
              .findByDiscordId(discord_user_id)
              .pipe(
                Effect.flatMap(
                  Options.toEffect(() => new ActivityRpcModels.ActivityMemberNotFound()),
                ),
              ),
          ),
          Effect.bind('member', ({ team, user }) =>
            members
              .findMembershipByIds(team.id, user.id)
              .pipe(
                Effect.flatMap(
                  Options.toEffect(() => new ActivityRpcModels.ActivityMemberNotFound()),
                ),
              ),
          ),
          Effect.tap(({ member }) =>
            member.active
              ? Effect.void
              : Effect.fail(new ActivityRpcModels.ActivityMemberNotFound()),
          ),
          Effect.bind('rows', ({ team }) =>
            leaderboardRepo.getLeaderboard(team.id, Option.none(), 'all'),
          ),
          Effect.map(({ member, rows }) => {
            const today = ActivityStats.todayInPrague();
            const maxEntries = Option.getOrElse(limit, () => 10);

            const memberData = rows.map((row) => {
              const streaks = ActivityStats.calculateStreaks(row.activity_dates, today);
              return {
                teamMemberId: row.team_member_id,
                userId: row.user_id,
                username: row.username,
                totalActivities: row.total_activities,
                totalDurationMinutes: row.total_duration_minutes,
                currentStreak: streaks.currentStreak,
                longestStreak: streaks.longestStreak,
              };
            });

            const ranked = Leaderboard.rankLeaderboard(memberData);
            const limited = ranked.slice(0, maxEntries);

            const requestingEntry = ranked.find((e) => e.teamMemberId === member.id);

            const entries = limited.map(
              (entry) =>
                new ActivityRpcModels.LeaderboardEntryResult({
                  rank: entry.rank,
                  team_member_id: entry.teamMemberId,
                  username: entry.username,
                  total_activities: entry.totalActivities,
                  total_duration_minutes: entry.totalDurationMinutes,
                  current_streak: entry.currentStreak,
                  longest_streak: entry.longestStreak,
                }),
            );

            const requestingUserEntry = requestingEntry
              ? Option.some(
                  new ActivityRpcModels.LeaderboardEntryResult({
                    rank: requestingEntry.rank,
                    team_member_id: requestingEntry.teamMemberId,
                    username: requestingEntry.username,
                    total_activities: requestingEntry.totalActivities,
                    total_duration_minutes: requestingEntry.totalDurationMinutes,
                    current_streak: requestingEntry.currentStreak,
                    longest_streak: requestingEntry.longestStreak,
                  }),
                )
              : Option.none();

            return new ActivityRpcModels.GetLeaderboardResult({
              entries,
              requesting_user_rank: Option.map(requestingUserEntry, (e) => e.rank),
              requesting_user_entry: requestingUserEntry,
            });
          }),
        ),
  ),
  Effect.let(
    'Activity/GetActivityTypesByGuild',
    ({ teams, activityTypes }) =>
      ({ guild_id }: { readonly guild_id: Discord.Snowflake }) =>
        Effect.Do.pipe(
          Effect.bind('team', () =>
            teams
              .findByGuildId(guild_id)
              .pipe(
                Effect.flatMap(
                  Options.toEffect(() => new ActivityRpcModels.ActivityGuildNotFound()),
                ),
              ),
          ),
          Effect.bind('types', ({ team }) => activityTypes.findByTeamId(team.id)),
          Effect.map(({ types }) =>
            types
              .filter((t) => Option.getOrNull(t.slug) !== 'training')
              .map(
                (t) =>
                  new ActivityRpcModels.ActivityTypeChoice({
                    id: t.id,
                    name: t.name,
                    slug: t.slug,
                    emoji: Option.map(t.emoji, (e) => e as string),
                    isGlobal: Option.isNone(t.team_id),
                  }),
              ),
          ),
        ),
  ),
  Bind.remove('teams'),
  Bind.remove('users'),
  Bind.remove('members'),
  Bind.remove('activityLogs'),
  Bind.remove('activityTypes'),
  Bind.remove('leaderboardRepo'),
  Bind.remove('evaluatorOpt'),
  (handlers) => ActivityRpcGroup.ActivityRpcGroup.toLayer(handlers),
);
