import {
  AchievementApi,
  ActivityLogApi,
  ActivityStatsApi,
  ActivityTypeApi,
  AgeThresholdApi,
  Auth,
  DashboardApi,
  EventApi,
  EventRsvpApi,
  EventSeriesApi,
  ExpenseApi,
  FinanceApi,
  GroupApi,
  ICalApi,
  Invite,
  LeaderboardApi,
  NotificationApi,
  OnboardingApi,
  RoleApi,
  Roster,
  TeamApi,
  TeamSettingsApi,
  TrainingTypeApi,
  Translations,
  VersionApi,
  WeeklyChallengeApi,
  WeeklySummaryApi,
} from '@sideline/domain';
import { Effect, Option, ServiceMap } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { HttpApi, HttpApiClient } from 'effect/unstable/httpapi';
import { getToken } from '~/lib/token';

export type ClientConfigService = {
  readonly baseUrl: string;
};

export class ClientConfig extends ServiceMap.Service<ClientConfig, ClientConfigService>()(
  'api/ClientConfig',
) {}

class ClientApi extends HttpApi.make('api')
  .add(AchievementApi.AchievementApiGroup)
  .add(ActivityLogApi.ActivityLogApiGroup)
  .add(ActivityTypeApi.ActivityTypeApiGroup)
  .add(ActivityStatsApi.ActivityStatsApiGroup)
  .add(AgeThresholdApi.AgeThresholdApiGroup)
  .add(Auth.AuthApiGroup)
  .add(DashboardApi.DashboardApiGroup)
  .add(Invite.InviteApiGroup)
  .add(LeaderboardApi.LeaderboardApiGroup)
  .add(NotificationApi.NotificationApiGroup)
  .add(RoleApi.RoleApiGroup)
  .add(Roster.RosterApiGroup)
  .add(EventApi.EventApiGroup)
  .add(EventRsvpApi.EventRsvpApiGroup)
  .add(EventSeriesApi.EventSeriesApiGroup)
  .add(ExpenseApi.ExpenseApiGroup)
  .add(FinanceApi.FinanceApiGroup)
  .add(GroupApi.GroupApiGroup)
  .add(ICalApi.ICalApiGroup)
  .add(TeamApi.TeamApiGroup)
  .add(TeamSettingsApi.TeamSettingsApiGroup)
  .add(TrainingTypeApi.TrainingTypeApiGroup)
  .add(Translations.TranslationsApiGroup)
  .add(VersionApi.VersionApiGroup)
  .add(OnboardingApi.OnboardingApiGroup)
  .add(WeeklySummaryApi.WeeklySummaryApiGroup)
  .add(WeeklyChallengeApi.WeeklyChallengeApiGroup) {}

export const client = ClientConfig.asEffect().pipe(
  Effect.flatMap(({ baseUrl }) =>
    HttpApiClient.make(ClientApi, {
      baseUrl: baseUrl,
      transformClient: (client) =>
        HttpClient.mapRequestEffect(client, (request) =>
          Effect.map(
            getToken,
            Option.match({
              onSome: (token) => HttpClientRequest.bearerToken(request, token),
              onNone: () => request,
            }),
          ),
        ),
    }),
  ),
  Effect.provide(FetchHttpClient.layer),
);
