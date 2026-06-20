export * as ApiGroup from './ApiGroup.js';

export * as AchievementApi from './api/AchievementApi.js';

export * as ActivityLogApi from './api/ActivityLogApi.js';

export * as ActivityStatsApi from './api/ActivityStatsApi.js';

export * as ActivityTypeApi from './api/ActivityTypeApi.js';

export * as AgeThresholdApi from './api/AgeThresholdApi.js';

export * as Auth from './api/Auth.js';

export * as ChannelApi from './api/ChannelApi.js';

export * as DashboardApi from './api/DashboardApi.js';

export * as DashboardLayoutApi from './api/DashboardLayoutApi.js';

/**
 * Config view returned to web clients — inbound_token and imap_secret_encrypted are intentionally omitted.
 */
export * as EmailForwardingApi from './api/EmailForwardingApi.js';

export * as EventApi from './api/EventApi.js';

export * as EventRosterApi from './api/EventRosterApi.js';

export * as EventRsvpApi from './api/EventRsvpApi.js';

export * as EventSeriesApi from './api/EventSeriesApi.js';

export * as ExpenseApi from './api/ExpenseApi.js';

export * as FinanceApi from './api/FinanceApi.js';

export * as GlobalAdminApi from './api/GlobalAdminApi.js';

export * as GroupApi from './api/GroupApi.js';

export * as ICalApi from './api/ICalApi.js';

export * as Invite from './api/Invite.js';

export * as LeaderboardApi from './api/LeaderboardApi.js';

export * as NotificationApi from './api/NotificationApi.js';

export * as OnboardingApi from './api/OnboardingApi.js';

export * as PlayerRatingApi from './api/PlayerRatingApi.js';

/**
 * Field state classification for cross-field schema filters.
 *
 * - `'absent'`  — field is not in the request (Option.none on a single-Option create field, or Option.none outer on a double-Option update field). Encoded form: key is `undefined`.
 * - `'clearing'` — field is in the request and is being set to "no value" (null on a single-Option create field, or Option.some(Option.none()) on a double-Option update field). Encoded form: value is `null`.
 * - `'setting'`  — field is in the request and is being set to a concrete value. Encoded form: a non-null value.
 */
export * as RequestFilters from './api/RequestFilters.js';

export * as RoleApi from './api/RoleApi.js';

export * as Roster from './api/Roster.js';

export * as TeamApi from './api/TeamApi.js';

export * as TeamChallengeApi from './api/TeamChallengeApi.js';

export * as TeamGenerationApi from './api/TeamGenerationApi.js';

export * as TeamSettingsApi from './api/TeamSettingsApi.js';

export * as TrainingTypeApi from './api/TrainingTypeApi.js';

export * as Translations from './api/Translations.js';

export * as VersionApi from './api/VersionApi.js';

export * as WeeklySummaryApi from './api/WeeklySummaryApi.js';

export * as Achievement from './models/Achievement.js';

export * as AchievementSyncEvent from './models/AchievementSyncEvent.js';

export * as ActivityLog from './models/ActivityLog.js';

/**
 * Formats a `Date` as a Prague-local `YYYY-MM-DD` string.
 * Uses `Intl.DateTimeFormat('en-CA', ...)` which guarantees ISO 8601 ordering.
 */
export * as ActivityLogDate from './models/ActivityLogDate.js';

export * as ActivityStats from './models/ActivityStats.js';

export * as ActivityType from './models/ActivityType.js';

export * as AgeThresholdRule from './models/AgeThresholdRule.js';

export * as Carpool from './models/Carpool.js';

export * as ChannelSyncEvent from './models/ChannelSyncEvent.js';

export * as CustomAchievement from './models/CustomAchievement.js';

export * as Discord from './models/Discord.js';

export * as DiscordChannelMapping from './models/DiscordChannelMapping.js';

export * as DiscordRoleMapping from './models/DiscordRoleMapping.js';

/**
 * The four name slots used to resolve a display name.
 * Precedence: profile name → Discord nickname → Discord display name → username.
 */
export * as DisplayName from './models/DisplayName.js';

export * as EarnedAchievement from './models/EarnedAchievement.js';

/**
 * Compute per-player rating updates for a team game.
 *
 * Each player's K-factor is determined individually and ratings are rounded to
 * the nearest integer. Per-player K-factor + integer rounding means exact
 * zero-sum is NOT guaranteed; this is intentional (same as chess Elo).
 * Ratings are floored at 0 — a long losing streak cannot produce a negative rating.
 */
export * as Elo from './models/Elo.js';

export * as EmailForwarding from './models/EmailForwarding.js';

export * as Event from './models/Event.js';

export * as EventRosterModel from './models/EventRosterModel.js';

export * as EventRsvp from './models/EventRsvp.js';

export * as EventSeries from './models/EventSeries.js';

export * as Expense from './models/Expense.js';

export * as Fee from './models/Fee.js';

export * as FeeAssignment from './models/FeeAssignment.js';

export * as GroupModel from './models/GroupModel.js';

export * as ICalToken from './models/ICalToken.js';

export * as InviteAcceptance from './models/InviteAcceptance.js';

export * as Leaderboard from './models/Leaderboard.js';

export * as MemberRole from './models/MemberRole.js';

export * as Notification from './models/Notification.js';

export * as OAuthConnection from './models/OAuthConnection.js';

export * as Onboarding from './models/Onboarding.js';

export * as Payment from './models/Payment.js';

export * as PaymentReminder from './models/PaymentReminder.js';

export * as PlayerRating from './models/PlayerRating.js';

export * as Role from './models/Role.js';

export * as RoleGroup from './models/RoleGroup.js';

export * as RoleSyncEvent from './models/RoleSyncEvent.js';

export * as RosterMemberModel from './models/RosterMemberModel.js';

export * as RosterModel from './models/RosterModel.js';

export * as Session from './models/Session.js';

export * as Team from './models/Team.js';

export * as TeamChallenge from './models/TeamChallenge.js';

export * as TeamChannel from './models/TeamChannel.js';

export * as TeamChannelAccess from './models/TeamChannelAccess.js';

export * as TeamGenerationConfig from './models/TeamGenerationConfig.js';

/**
 * Balanced Training Team Generator — pure algorithm module (no Effect).
 *
 * Phase 1 — seed: players are sorted by rating descending (ties broken by teamMemberId
 * ascending) and distributed via snake-draft into N teams: round 0 goes 0→N-1, round 1
 * goes N-1→0, alternating. This guarantees the max size difference between any two teams
 * is at most 1 when player count is not divisible by teamCount. The ordering is fully
 * deterministic because ties are broken by teamMemberId ascending — a stable, explicit
 * total order that requires no randomness.
 *
 * Phase 2 — hill-climbing local search: all single cross-team swaps are evaluated; the
 * best cost-reducing swap is applied; the process repeats until no improvement is found
 * or maxIterations is reached. Ties in cost are broken deterministically: first by the
 * smaller of the two member ids (min(idI, idJ) ascending), then by the larger
 * (max(idI, idJ) ascending). The ids used for tie-breaking are captured at the moment the
 * candidate swap is evaluated — never re-read from mutable array state.
 *
 * Cost function (fully normalized so weights are comparable):
 *   cost = wElo * clamp(ratingSpread / SCALE_ELO, 0, 1)
 *        + wSize * sizeImbalanceTerm   [constant under equal-size swaps — see note below]
 *        + wGender * (genderImbalance / maxGenderImbalance)
 *
 * Size-term note: snake-draft guarantees team sizes differ by at most 1. Because the local
 * search only performs equal-size 1-for-1 swaps the size imbalance never changes during
 * Phase 2, so weightSize does not influence swap selection in the current implementation
 * (reserved for future move operations that change team sizes).
 *
 * Unknown gender is counted for size balance but excluded from the gender penalty.
 */
export * as TeamGenerator from './models/TeamGenerator.js';

export * as TeamInvite from './models/TeamInvite.js';

export * as TeamMember from './models/TeamMember.js';

export * as TeamOnboardingToken from './models/TeamOnboardingToken.js';

export * as TeamSettings from './models/TeamSettings.js';

export * as TrainingGame from './models/TrainingGame.js';

export * as TrainingType from './models/TrainingType.js';

export * as User from './models/User.js';

/**
 * Shared payload schema for the weekly_summary_sync_events queue.
 * The cron encodes this; the bot handler decodes it.
 */
export * as WeeklySummary from './models/WeeklySummary.js';
export * as AchievementRpcEvents from './rpc/achievement/AchievementRpcEvents.js';
export * as AchievementRpcGroup from './rpc/achievement/AchievementRpcGroup.js';
export * as ActivityRpcGroup from './rpc/activity/ActivityRpcGroup.js';
export * as ActivityRpcModels from './rpc/activity/ActivityRpcModels.js';
export * as BotInfoRpcGroup from './rpc/botInfo/BotInfoRpcGroup.js';
export * as CarpoolRpcGroup from './rpc/carpool/CarpoolRpcGroup.js';
export * as CarpoolRpcModels from './rpc/carpool/CarpoolRpcModels.js';
export * as ChannelRpcEvents from './rpc/channel/ChannelRpcEvents.js';
export * as ChannelRpcGroup from './rpc/channel/ChannelRpcGroup.js';
export * as ChannelRpcModels from './rpc/channel/ChannelRpcModels.js';
export * as EmailRpcEvents from './rpc/email/EmailRpcEvents.js';
export * as EmailRpcGroup from './rpc/email/EmailRpcGroup.js';
export * as EmailRpcModels from './rpc/email/EmailRpcModels.js';
export * as EventRpcEvents from './rpc/event/EventRpcEvents.js';
export * as EventRpcGroup from './rpc/event/EventRpcGroup.js';
export * as EventRpcModels from './rpc/event/EventRpcModels.js';
export * as FinanceRpcEvents from './rpc/finance/FinanceRpcEvents.js';
export * as FinanceRpcGroup from './rpc/finance/FinanceRpcGroup.js';
export * as FinanceRpcModels from './rpc/finance/FinanceRpcModels.js';
export * as GuildRpcGroup from './rpc/guild/GuildRpcGroup.js';
export * as InviteRpcGroup from './rpc/invite/InviteRpcGroup.js';
export * as RoleRpcEvents from './rpc/role/RoleRpcEvents.js';
export * as RoleRpcGroup from './rpc/role/RoleRpcGroup.js';
export * as RoleRpcModels from './rpc/role/RoleRpcModels.js';
export * as RoleProvisionRpcGroup from './rpc/roleProvision/RoleProvisionRpcGroup.js';
export * as SyncRpcs from './rpc/SyncRpcs.js';

export * as TeamChallengeRpcGroup from './rpc/teamChallenge/TeamChallengeRpcGroup.js';

export * as TeamChallengeSyncEvents from './rpc/teamChallenge/TeamChallengeSyncEvents.js';

export * as WeeklySummaryRpcEvents from './rpc/weeklySummary/WeeklySummaryRpcEvents.js';

export * as WeeklySummaryRpcGroup from './rpc/weeklySummary/WeeklySummaryRpcGroup.js';
