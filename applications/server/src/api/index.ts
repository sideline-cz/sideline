import { Layer } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { AchievementApiLive } from '~/api/achievement.js';
import { ActivityLogApiLive } from '~/api/activity-logs.js';
import { ActivityStatsApiLive } from '~/api/activity-stats.js';
import { ActivityTypeApiLive } from '~/api/activity-type.js';
import { AgeThresholdApiLive } from '~/api/age-threshold.js';
import { Api } from '~/api/api.js';
import { AuthApiLive } from '~/api/auth.js';
import { DashboardApiLive } from '~/api/dashboard.js';
import { EventApiLive } from '~/api/event.js';
import { EventRsvpApiLive } from '~/api/event-rsvp.js';
import { EventSeriesApiLive } from '~/api/event-series.js';
import { ExpenseApiLive } from '~/api/expenses.js';
import { FinanceApiLive } from '~/api/finance.js';
import { GroupApiLive } from '~/api/group.js';
import { ICalApiLive } from '~/api/ical.js';
import { InviteApiLive } from '~/api/invite.js';
import { LeaderboardApiLive } from '~/api/leaderboard.js';
import { NotificationApiLive } from '~/api/notification.js';
import { OnboardingApiLive } from '~/api/onboarding.js';
import { RoleApiLive } from '~/api/role.js';
import { RosterApiLive } from '~/api/roster.js';
import { TeamApiLive } from '~/api/team.js';
import { TeamSettingsApiLive } from '~/api/team-settings.js';
import { TrainingTypeApiLive } from '~/api/training-type.js';
import { TranslationsApiLive } from '~/api/translations.js';
import { VersionApiLive } from '~/api/version.js';
import { WeeklySummaryApiLive } from '~/api/weekly-summary.js';

export const ApiLive = HttpApiBuilder.layer(Api, { openapiPath: '/docs/openapi.json' })
  .pipe(
    Layer.provide(AchievementApiLive),
    Layer.provide(ActivityLogApiLive),
    Layer.provide(ActivityStatsApiLive),
    Layer.provide(ActivityTypeApiLive),
    Layer.provide(DashboardApiLive),
    Layer.provide(LeaderboardApiLive),
    Layer.provide(AgeThresholdApiLive),
    Layer.provide(AuthApiLive),
    Layer.provide(EventApiLive),
    Layer.provide(EventRsvpApiLive),
    Layer.provide(EventSeriesApiLive),
    Layer.provide(ExpenseApiLive),
    Layer.provide(FinanceApiLive),
    Layer.provide(GroupApiLive),
    Layer.provide(ICalApiLive),
    Layer.provide(InviteApiLive),
    Layer.provide(NotificationApiLive),
    Layer.provide(OnboardingApiLive),
    Layer.provide(RosterApiLive),
    Layer.provide(RoleApiLive),
  )
  .pipe(
    Layer.provide(TeamApiLive),
    Layer.provide(TeamSettingsApiLive),
    Layer.provide(TrainingTypeApiLive),
    Layer.provide(TranslationsApiLive),
    Layer.provide(VersionApiLive),
    Layer.provide(WeeklySummaryApiLive),
  );

export { Redirect } from '~/api/redirect.js';
