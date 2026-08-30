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

/**
 * The client-facing subset of `Onboarding.InviteGeneratorErrorCode`. `'expired'` is never here
 * — `JoinStatus.state` carries it (CC-3). Name is permanent, not `LegacyInviteGeneratorErrorCode`:
 * this is not a legacy artefact awaiting deletion, it is the permanent client contract (only
 * `'bot_not_in_guild'` joins it later, in PR-9). See
 * `applications/server/src/utils/inviteErrorWireProjection.ts` for the projection applied at the
 * `getJoinStatus` read boundary. Model: `EventRsvpApi.ts` `LegacyRsvpResponse` /
 * `rsvpWireProjection.ts`.
 */
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

/**
 * HTTP API for the Rules Trainer's per-user progress (Phase 2 of
 * `docs/plans/rules-trainer.md`) and team leaderboard (Phase 3a).
 * HTTP, not RPC, because this is a web-facing feature — RPC groups in this
 * package are bot-only.
 *
 * `submitAttempt` and `myProgress` are caller-scoped: there is no team
 * parameter and no cross-user lookup, so (like `ICalApiGroup`'s
 * `/me/ical-token`) neither endpoint declares a custom error beyond what
 * `AuthMiddleware` already provides (401 on missing/invalid token).
 * `myProgress` is named per "Caller-Scoped Reads"
 * (`applications/server/AGENTS.md`) — the query is always scoped to the
 * authenticated user, never to a caller-supplied id.
 *
 * `getRulesLeaderboard` is different: it is team-scoped (a `teamId` param,
 * per `getLeaderboard` in `LeaderboardApi.ts`), not caller-scoped, so it is
 * NOT named `my*` even though the plan decided visibility is "self and
 * captains only" (see `RulesLeaderboardResponse.scope` below) — the query
 * still ranks the whole team before filtering, it does not merely look up
 * the caller. Because it is team-scoped, non-membership must 403, so —
 * unlike the two caller-scoped endpoints above — it DOES declare a custom
 * error (`RulesLeaderboardForbidden`).
 */
export * as RulesTrainerApi from './api/RulesTrainerApi.js';

export * as TeamApi from './api/TeamApi.js';

export * as TeamChallengeApi from './api/TeamChallengeApi.js';

export * as TeamGenerationApi from './api/TeamGenerationApi.js';

/**
 * Scheduled rules quiz. `None` = off, which is every team until someone
 * nominates a channel.
 *
 * All three decode TOLERANTLY (missing key → default) rather than as plain
 * required fields, because web bundles a FROZEN copy of these schemas: a new
 * bundle served against a server that predates these columns would otherwise
 * fail to decode team settings entirely, taking the whole settings page down
 * rather than just hiding one section. Same reasoning as
 * `discordEventsChannelId` above.
 *
 * NOT `rulesChannelId` — `teams.rules_channel_id` is the onboarding
 * code-of-conduct channel and is a different feature.
 */
export * as TeamSettingsApi from './api/TeamSettingsApi.js';

export * as TrainingTypeApi from './api/TrainingTypeApi.js';

export * as Translations from './api/Translations.js';

export * as VersionApi from './api/VersionApi.js';

export * as WeeklySummaryApi from './api/WeeklySummaryApi.js';

/**
 * The code-defined achievement catalogue: `AchievementSlug`, `ACHIEVEMENTS`
 * (threshold-based, evaluated from `AchievementEvaluationInput`), and the
 * exhaustive `BUILT_IN_ENGLISH_NAMES`/`BUILT_IN_RULE_KINDS` records every
 * slug must appear in — omitting an entry is a compile error, which is the
 * point (see `docs/plans/rules-trainer.md`'s Phase 3 step 15).
 */
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

export * as PersonalEventChannel from './models/PersonalEventChannel.js';

export * as PersonalEventMessage from './models/PersonalEventMessage.js';

export * as PersonalEventOverflowCategory from './models/PersonalEventOverflowCategory.js';

export * as PlayerRating from './models/PlayerRating.js';

export * as Poll from './models/Poll.js';

export * as Role from './models/Role.js';

export * as RoleGroup from './models/RoleGroup.js';

export * as RoleSyncEvent from './models/RoleSyncEvent.js';

export * as RosterMemberModel from './models/RosterMemberModel.js';

export * as RosterModel from './models/RosterModel.js';

/**
 * Rules Trainer team leaderboard ranking — pure algorithm module (no Effect).
 *
 * Mirrors `models/Leaderboard.ts`'s `rankLeaderboard` shape deliberately, so
 * the web UI (a future slice) can reuse the same table/row components for
 * both boards. It lives in `@sideline/domain`, not `@sideline/rules`,
 * because it ranks domain DTOs (`teamMemberId`, `displayName`-adjacent
 * fields) rather than rules content — `@sideline/rules` stays free of wire
 * concerns (see `packages/rules/AGENTS.md`).
 *
 * Ranks by `strength` (decayed mastery, `@sideline/rules`'s
 * `engine/mastery.ts`) descending, then `masteredCount` descending, then an
 * explicit `teamMemberId` ascending tiebreaker — required by
 * `packages/domain/AGENTS.md`'s Pure Algorithm Module rules so the output is
 * a deterministic total order rather than dependent on input order (two
 * members who have never practised both rank identically on
 * strength/masteredCount, and without the id tiebreaker their relative
 * order would depend on array insertion order, which itself depends on
 * arbitrary SQL row order).
 *
 * Assigns `rank: index + 1` — distinct sequential ranks, matching
 * `rankLeaderboard`; ties in strength/masteredCount do NOT share a rank,
 * the id tiebreaker always produces a strict order.
 */
export * as RulesLeaderboard from './models/RulesLeaderboard.js';

/**
 * Rows for the Rules Trainer's per-user progress (`rules_attempts` +
 * `rules_scenario_results`) — see `docs/plans/rules-trainer.md` Phase 2 and
 * `packages/rules/src/engine/mastery.ts`.
 *
 * This module intentionally does NOT import `@sideline/rules`: `ScenarioId`
 * there is a plain TS brand from a non-Effect package (no `Schema`), and
 * `Level` is a plain `1 | 2 | ... | 9` union — neither needs an Effect
 * schema to cross this boundary, so `scenario_id` decodes as `Schema.String`
 * and package levels decode as the local `Level` schema below. Keeping the
 * two packages decoupled means `@sideline/rules` (browser + Node, zero I/O)
 * never has to know about `@sideline/domain`'s wire/HTTP concerns.
 *
 * `RulesPackageMastery` / `RulesOverallMastery` mirror `PackageMastery` /
 * the return type of `overallMastery` in `@sideline/rules`'s
 * `engine/mastery.ts` field-for-field so the server (follow-up PR) can map
 * the pure computation onto the wire DTO 1:1, with no renaming in between.
 */
export * as RulesProgress from './models/RulesProgress.js';

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
/**
 * The TRUE (unprojected) stored response, additive alongside the legacy
 * `my_response` above. `my_response` intentionally stays pinned to the
 * legacy 3-value vocabulary for wire safety (see `rsvpWireProjection.ts`),
 * but bot-side logic that must distinguish a real `coming_later` RSVP from a
 * legacy `maybe` (e.g. which message-management buttons to render) needs
 * the unprojected value. Uses `OptionFromOptionalKey` (not `OptionFromNullOr`)
 * so a rolling deploy where the bot updates before the server — and briefly
 * decodes a response from an older producer that omits this key entirely —
 * tolerates the missing key as `Option.none()` instead of a hard decode
 * failure.
 */
export * as EventRpcModels from './rpc/event/EventRpcModels.js';
export * as FinanceRpcEvents from './rpc/finance/FinanceRpcEvents.js';
export * as FinanceRpcGroup from './rpc/finance/FinanceRpcGroup.js';
export * as FinanceRpcModels from './rpc/finance/FinanceRpcModels.js';
export * as GuildRpcGroup from './rpc/guild/GuildRpcGroup.js';
export * as GuildRpcModels from './rpc/guild/GuildRpcModels.js';
/**
 * PR-2 wire expand (CC-1: "the bot is the decoder"). Two additive, tolerant fields so an
 * old bot bundling the pre-PR-2 schema keeps decoding this batch RPC's success payload:
 *
 * - `welcome_channel_id` tolerates both a missing key (an old server never sent it) and an
 *   explicit `null` (a PR-3+ server, once the `welcome_channel_id IS NOT NULL` guard in
 *   `findPending` is lifted) — both decode to `Option.none()`.
 * - `bot_present` decodes a missing key (an old server never sent it) as `true`, the
 *   behaviour-preserving default before PR-3 adds the real "is the bot actually in this
 *   guild" gate.
 *
 * This release (PR-2) the server still only ever emits a non-null `welcome_channel_id` and
 * never emits `bot_present: false` — see `InviteAcceptancesRepository.findPending`'s
 * temporary wire guard. Nothing behaves differently yet; only the schema is widened.
 */
export * as InviteRpcGroup from './rpc/invite/InviteRpcGroup.js';
export * as PersonalEventsRpcGroup from './rpc/personalEvents/PersonalEventsRpcGroup.js';
export * as PollRpcGroup from './rpc/poll/PollRpcGroup.js';
export * as PollRpcModels from './rpc/poll/PollRpcModels.js';
export * as RoleRpcEvents from './rpc/role/RoleRpcEvents.js';
export * as RoleRpcGroup from './rpc/role/RoleRpcGroup.js';
export * as RoleRpcModels from './rpc/role/RoleRpcModels.js';
export * as RoleProvisionRpcGroup from './rpc/roleProvision/RoleProvisionRpcGroup.js';
/**
 * The bot's user-scoped write path into the rules trainer.
 *
 * The web trainer submits over HTTP, authenticated by the caller's session
 * (`RulesTrainerApi`'s `AuthMiddleware`). The bot has no user session — it
 * authenticates as itself — so it cannot use that endpoint at all. It
 * instead passes the acting participant's `discord_user_id` and the server
 * resolves it to a `users` row, exactly as `Carpool/LeaveCarpool` does.
 *
 * That resolution is the whole security boundary here: a Discord snowflake
 * arrives from an interaction Discord itself signed, and only ever maps to
 * the one account that has linked it.
 *
 * ⚠️ Scoring is **not** a trust boundary on either path — the honour-system
 * decision in `docs/plans/rules-trainer.md` applies identically. Picks are
 * re-scored server-side against the real chain because that keeps ONE
 * definition of a score, not because the client is distrusted.
 */
export * as RulesRpcGroup from './rpc/rules/RulesRpcGroup.js';
/**
 * The scheduled rules quiz outbox, drained by the bot.
 *
 * Same three-call shape as every other sync feed here — fetch pending, mark
 * processed, mark failed — because the bot's `ProcessorService` pattern is
 * built around exactly that and a fourth shape would earn nothing.
 *
 * `MarkFailed` deliberately does NOT consume the event: the row stays
 * unprocessed so the next poll retries it. A Discord blip must not silently
 * cost a team its quiz, and `attempts`/`last_error` are what make a
 * permanently-broken event visible instead of invisible.
 */
export * as RulesQuizRpcGroup from './rpc/rulesQuiz/RulesQuizRpcGroup.js';
export * as SyncRpcs from './rpc/SyncRpcs.js';

export * as SummarizeRpcGroup from './rpc/summarize/SummarizeRpcGroup.js';

export * as SummarizeRpcModels from './rpc/summarize/SummarizeRpcModels.js';

export * as TeamChallengeRpcGroup from './rpc/teamChallenge/TeamChallengeRpcGroup.js';

export * as TeamChallengeSyncEvents from './rpc/teamChallenge/TeamChallengeSyncEvents.js';

export * as WeeklySummaryRpcEvents from './rpc/weeklySummary/WeeklySummaryRpcEvents.js';

export * as WeeklySummaryRpcGroup from './rpc/weeklySummary/WeeklySummaryRpcGroup.js';
