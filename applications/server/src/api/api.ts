import {
  AchievementApi,
  ActivityLogApi,
  ActivityStatsApi,
  AgeThresholdApi,
  Auth,
  DashboardApi,
  EventApi,
  EventRsvpApi,
  EventSeriesApi,
  GroupApi,
  ICalApi,
  Invite,
  LeaderboardApi,
  NotificationApi,
  RoleApi,
  Roster,
  TeamApi,
  TeamSettingsApi,
  TrainingTypeApi,
} from '@sideline/domain';
import { HttpApi } from 'effect/unstable/httpapi';
import { env } from '~/env.js';

export const Api = HttpApi.make('api')
  .add(AchievementApi.AchievementApiGroup)
  .add(ActivityLogApi.ActivityLogApiGroup)
  .add(ActivityStatsApi.ActivityStatsApiGroup)
  .add(LeaderboardApi.LeaderboardApiGroup)
  .add(AgeThresholdApi.AgeThresholdApiGroup)
  .add(Auth.AuthApiGroup)
  .add(DashboardApi.DashboardApiGroup)
  .add(EventApi.EventApiGroup)
  .add(EventRsvpApi.EventRsvpApiGroup)
  .add(EventSeriesApi.EventSeriesApiGroup)
  .add(GroupApi.GroupApiGroup)
  .add(ICalApi.ICalApiGroup)
  .add(Invite.InviteApiGroup)
  .add(NotificationApi.NotificationApiGroup)
  .add(Roster.RosterApiGroup)
  .add(RoleApi.RoleApiGroup)
  .add(TeamApi.TeamApiGroup)
  .add(TeamSettingsApi.TeamSettingsApiGroup)
  .add(TrainingTypeApi.TrainingTypeApiGroup)
  .prefix(env.API_PREFIX as '/${string}');
