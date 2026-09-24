export * as ApiGroup from './ApiGroup.js';

export * as AchievementApi from './api/AchievementApi.js';

export * as ActivityLogApi from './api/ActivityLogApi.js';

export * as ActivityStatsApi from './api/ActivityStatsApi.js';

export * as ActivityTypeApi from './api/ActivityTypeApi.js';

export * as AgeThresholdApi from './api/AgeThresholdApi.js';

/**
 * The read-only in-app AI assistant (plan §3): one capabilities endpoint and one chat
 * endpoint, team-scoped. `EntityRef` is the typed view-model union every card in the answer
 * is rendered from — the model never controls a fact the user can act on, only which
 * server-held entity is shown and which sentence mentions it. `degradedReason` is a closed
 * union resolved client-side through a label map, never a sentinel embedded in `answer`.
 */
export * as AiChatApi from './api/AiChatApi.js';

/**
 * Tri-state, and `'unknown'` renders NOTHING (PR-9 / CC-15, designer §3.6) — never a boolean.
 * A hard gate on an unknown signal bounces the entire existing user base (the day-one state for
 * every member of every team, since the bot has to observe guild membership before anyone can be
 * `'connected'` or `'not_connected'`), so `'unknown'` is a first-class state, not a default that
 * degrades to `false`. Populated in `auth.myTeams`
 * (`applications/server/src/api/auth.ts`) from `team_members.discord_joined_at` (PR-8):
 * non-null → `'connected'`; null AND the team's guild has `bot_guilds.members_backfilled_at`
 * non-null → `'not_connected'`; otherwise `'unknown'`. A guild whose member list was never
 * provably read completely must never be interpreted as "nobody is connected".
 * `withDecodingDefaultKey` keeps an old server payload (no `discordJoined` key at all) decoding
 * safely in a new browser as `'unknown'` — the safe, inert default.
 */
export * as Auth from './api/Auth.js';

/**
 * Config view returned to web clients. Never carries the Fio token — `fioTokenSet` is the only
 * signal of whether one is stored. `status` / `expiringSoon` are computed server-side (D11) and
 * must be rendered as-is, never re-derived on the client.
 */
export * as BankSyncApi from './api/BankSyncApi.js';

export * as ChannelApi from './api/ChannelApi.js';

/**
 * Derived team-local calendar date (`YYYY-MM-DD`), plan §11.2/§11.3. `Option.none()`
 * means the key was absent (old-server skew) and the reader falls back to
 * `formatUtcDate(startAt)`. Deliberately `OptionFromOptionalKey`, never a plain string
 * defaulted to `''` — see `EventApi.EventInfo.startDate`'s doc comment.
 */
export * as DashboardApi from './api/DashboardApi.js';

export * as DashboardLayoutApi from './api/DashboardLayoutApi.js';

/**
 * Config view returned to web clients — inbound_token and imap_secret_encrypted are intentionally omitted.
 */
export * as EmailForwardingApi from './api/EmailForwardingApi.js';

/**
 * Derived team-local calendar date (`YYYY-MM-DD`), projected server-side from
 * `startAt`/`endAt` and the team's timezone (plan §11.2/§11.3). `Option.none()`
 * means the key was entirely absent — an old server during a rolling deploy — and
 * every reader must fall back to `formatUtcDate(startAt)`. Deliberately
 * `OptionFromOptionalKey`, never a plain string defaulted to `''`: an empty-string
 * sentinel would make the web calendar's `key >= startDate && key <= endDate`
 * bucketing false for every real key and silently drop the event from the grid.
 */
export * as EventApi from './api/EventApi.js';

export * as EventRosterApi from './api/EventRosterApi.js';

export * as EventRsvpApi from './api/EventRsvpApi.js';

export * as EventSeriesApi from './api/EventSeriesApi.js';

export * as EventTypeApi from './api/EventTypeApi.js';

export * as ExpenseApi from './api/ExpenseApi.js';

export * as FinanceApi from './api/FinanceApi.js';

export * as GlobalAdminApi from './api/GlobalAdminApi.js';

export * as GroupApi from './api/GroupApi.js';

export * as ICalApi from './api/ICalApi.js';

/**
 * The client-facing subset of `Onboarding.InviteGeneratorErrorCode`. `'expired'` is never here
 * — `JoinStatus.state` carries it (CC-3). Name is permanent, not `LegacyInviteGeneratorErrorCode`:
 * this is not a legacy artefact awaiting deletion, it is the permanent client contract.
 * `'bot_not_in_guild'` joined in PR-9, once the server bundles the widened stored enum (PR-2) and
 * every browser that could receive it does too (CC-3's three-release schedule). See
 * `applications/server/src/utils/inviteErrorWireProjection.ts` for the projection applied at the
 * `getJoinStatus` read boundary.
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

/**
 * One role effectively held by a roster player, tagged with how it was granted:
 * `'direct'` (a `member_roles` row), `'inherited'` (via a `role_groups` group, possibly
 * through an ancestor group), or `'both'` (both at once — see `RosterPlayer.effectiveRoles`).
 */
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

/**
 * The command-palette search endpoint (`.work-plans/command-palette-search.md` §A). Calls the
 * same five AI read-tool executors the in-app assistant uses (`applications/server/src/services/
 * ai/readTools.ts`), so the permission gates are the same function calls, not a second copy.
 * `SearchHit` is defined in `AiChatApi.ts` and re-exported here, per the shared-schema
 * convention (`packages/domain/AGENTS.md` → "Shared Schemas Across API Contracts").
 */
export * as SearchApi from './api/SearchApi.js';

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

export * as AiActionProposal from './models/AiActionProposal.js';

/**
 * D11 — computed server-side by the pure `bankSyncStatus` ladder (`applications/server`) and
 * sent to the client as a literal; the web must never re-derive it. `'expiring_soon'` is
 * deliberately NOT a member of this union — token expiry is additive
 * (`BankSyncConfigView.expiringSoon: boolean`), never a rank of this ladder, because a token
 * that is both expiring AND failing must report both facts, not just one.
 *
 * `'account_mismatch'` outranks `'invalid'`: the token demonstrably works, it is the *account*
 * that is wrong, so telling the treasurer to replace the token is the wrong instruction. The
 * poller sets it via `last_error_code = 'account_mismatch'` when it refuses to ingest a statement
 * whose `info.iban` disagrees with the configured account, and it is terminal — no retry count and
 * no elapsed time clear it. A config edit does NOT clear it either (the row's
 * `consecutive_failure_count`/`next_attempt_at` reset on save, but `last_error_code` survives);
 * what actually clears the rank is the next successful poll's `recordSuccess`. It shares a literal
 * name with `BankSyncApi.BankSyncTestStatus`'s member and nothing else: that union is one probe's
 * verdict, this one is the state of automatic importing.
 */
export * as BankSyncConfig from './models/BankSyncConfig.js';

/**
 * D15 — the single source of truth for the DB `CHECK`, the matching engine, and the web's
 * closed `Record`. Exactly these nine literals; `possible_duplicate` is deliberately absent — it
 * is a hint carried alongside `no_open_assignment` (step 2.5 of the matching engine), never a
 * `match_reason` on its own.
 */
export * as BankTransaction from './models/BankTransaction.js';

export * as Carpool from './models/Carpool.js';

export * as ChannelSyncEvent from './models/ChannelSyncEvent.js';

export * as CustomAchievement from './models/CustomAchievement.js';

/**
 * Czech IBAN construction and the Czech bank-account modulo-11 checksum.
 *
 * Pure algorithm module — see `packages/domain/AGENTS.md` ("Pure Algorithm Modules").
 *
 * ## IBAN construction (`buildCzIban`)
 *
 * ```
 * BBAN  = bankCode(4, zero-padded) + prefix(6, zero-padded) + accountNumber(10, zero-padded)
 * check = 98 - (BigInt(BBAN + "1235" + "00") % 97n)   // "CZ" -> C=12, Z=35
 * IBAN  = "CZ" + String(check).padStart(2, "0") + BBAN   // length 24
 * ```
 *
 * **Bank code FIRST, then prefix, then account** — prefix-first is the classic bug (see the
 * paired test's "prefix-first regression" case). `BigInt` is mandatory: the rearranged numeric
 * string is 26 digits and overflows `Number`'s safe integer range.
 *
 * Verified vectors (do NOT use the IBANs printed in Fio's own PDF or the `fiobank` npm
 * package's fixtures as test vectors — they are anonymised data with un-recomputed check
 * digits and fail mod-97):
 *   - `19-2000145399/0800` → `CZ6508000000192000145399`
 *   - `1265098001/5500` → `CZ5855000000001265098001`
 *   - `76327632/0300` → `CZ7603000000000076327632`
 *   - `2703474850/2010` → `CZ7120100000002703474850`
 *   - `123456-2703474850/2010` → `CZ6920101234562703474850`
 *
 * ## Account modulo-11 checksum (`isValidCzAccountNumber`)
 *
 * Weights `[10, 5, 8, 4, 2, 1]` (prefix, zero-padded to 6 digits) and
 * `[6, 3, 7, 9, 10, 5, 8, 4, 2, 1]` (account number, zero-padded to 10 digits) are paired
 * left-to-right with the zero-padded digit string (the padding is on the left, so the last
 * weight in each array always lands on the units digit) — each weighted sum must be
 * `≡ 0 (mod 11)`, checked independently for the prefix and the account number.
 */
export * as CzIban from './models/CzIban.js';

/**
 * The Czech IČO (organisation identifier) checksum — a DIFFERENT algorithm from the bank-account
 * modulo-11 checksum in `CzIban.ts` (different weights, different modulus handling).
 *
 * Pure algorithm module — see `packages/domain/AGENTS.md` ("Pure Algorithm Modules").
 *
 * ```
 * digits d1..d8
 * sum   = 8*d1 + 7*d2 + 6*d3 + 5*d4 + 4*d5 + 3*d6 + 2*d7
 * r     = sum mod 11
 * check = (11 - r) mod 10      -- must equal d8
 * ```
 *
 * The check digit is written as that single expression, NOT a branch ladder
 * (`if r = 0 then 1 elsif r = 1 then 0 ...`) — it is already correct for every edge case
 * (`r=0 → 1`, `r=1 → 0`, `r=10 → 1`) precisely because it is expressed this way, and a
 * hand-written ladder is exactly where those edge cases get typed wrong.
 *
 * Verified vectors: `61858374` (sum 183, r 7, c 4), `45244782` (sum 152, r 9, c 2),
 * `45274649` (sum 156, r 2, c 9).
 */
export * as CzIco from './models/CzIco.js';

export * as Discord from './models/Discord.js';

export * as DiscordChannelMapping from './models/DiscordChannelMapping.js';

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

export * as EventType from './models/EventType.js';

export * as Expense from './models/Expense.js';

export * as Fee from './models/Fee.js';

export * as FeeAssignment from './models/FeeAssignment.js';

export * as GroupModel from './models/GroupModel.js';

export * as ICalToken from './models/ICalToken.js';

export * as InviteAcceptance from './models/InviteAcceptance.js';

export * as Leaderboard from './models/Leaderboard.js';

export * as MemberCredit from './models/MemberCredit.js';

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

/**
 * Pure allocation of a settle-all payment across a member's outstanding fee assignments
 * plus their credit balance.
 *
 * Pure algorithm module — see `packages/domain/AGENTS.md` ("Pure Algorithm Modules"). Shared,
 * unmodified, by the client's settlement preview and the server's
 * `MemberCreditsRepository.settle` (the `CzIban` / `Spayd` precedent) — "preview and server
 * must agree" is a type-level fact, not a convention.
 *
 * Candidates are sorted `effectiveDueAt` ascending with `Option.none()` last, tie-broken by
 * `assignmentId` ascending. The credit pool is drained to exhaustion before the cash pool,
 * walking candidates in that same order. Integer minor units only — no division, no
 * `Math.round`/`Math.floor` beyond the explicit `Math.max(0, …)` clamps below.
 */
export * as SettlementPlan from './models/SettlementPlan.js';

/**
 * SPAYD (Short Payment Descriptor, v1.0) string builder for Czech payment QR codes.
 *
 * Pure algorithm module — see `packages/domain/AGENTS.md` ("Pure Algorithm Modules").
 *
 * Format: `SPD*1.0*KEY:value*KEY:value*` — only `ACC` is mandatory; keys are uppercase; there is
 * no whitespace around values. Key emission order (this module's own convention, mirroring the
 * SPAYD 1.0 spec's documented key list): `ACC, AM, CC, RN, DT, MSG, X-VS, X-SS, X-KS`.
 *
 * Guaranteed-supported keys: `ACC`, `AM`, `CC`, `DT`, `MSG`, `X-VS`, `X-SS`, `X-KS`. `RN` is NOT
 * guaranteed by every reader — it is emitted for readability only; reconciliation is always done
 * on `X-VS`.
 *
 * | Key | Limit |
 * |---|---|
 * | `ACC` | 46 (`IBAN` or `IBAN+BIC`) |
 * | `AM` | 10 chars, max 2 dp, `.` separator, max `9999999.99`; both decimals always present |
 * | `CC` | exactly 3 |
 * | `DT` | exactly 8, `YYYYMMDD` |
 * | `MSG` | 60 |
 * | `X-VS` / `X-SS` / `X-KS` | 10 integer chars |
 *
 * Over-length values are silently truncated FROM THE LEFT by some readers, so limits are
 * enforced here rather than trusted to the reader. `MSG` is budgeted and truncated by
 * `toSpaydMessage` BEFORE `buildSpayd` is called — a fee name that does not fit must never turn
 * into "no QR at all" (see `toSpaydMessage`'s doc comment). `buildSpayd` itself still rejects an
 * over-length `MSG` — that path exists only to catch a future caller that skips the budget step.
 * `X-VS` is always a hard reject over 10 chars: a truncated variable symbol is a mis-credited
 * payment, which is strictly worse than no QR.
 *
 * Escaping is targeted percent-encoding: `%` → `%25` (must run first, it is the escape
 * character itself) and `*` → `%2A` (the field separator). `:` is explicitly left unescaped.
 * `CRC32` is deliberately never emitted — rarely produced, widely ignored by readers, and a
 * mis-canonicalised one is worse than none.
 *
 * Amount formatting never round-trips through a float — see `formatAmountMajor`.
 */
export * as Spayd from './models/Spayd.js';

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
 * Drives the personal-message "Dnes"/"Today" marker (plan §4.6): an all-day event whose
 * `status` has flipped to `'started'` is currently running, so the renderer swaps the
 * relative `<t:S:R>` timestamp for a static "today" label instead. Defaulted on decode
 * (not required on the wire) so a rolling deploy where the server hasn't shipped this
 * field yet degrades to the pre-existing `<t:S:R>` rendering rather than a hard decode
 * failure — see `TeamSettingsApi.ts:79` for the same `withDecodingDefaultKey` precedent.
 */
export * as EventRpcModels from './rpc/event/EventRpcModels.js';
/**
 * D11 / T10b — the T-14/T-7/T-1 Discord DM to the treasurer that a connected Fio token is about
 * to expire (`token_created_at + 180d`). Emitted by `BankTokenExpiryCron` into its own outbox
 * table (`bank_token_expiry_events`, migration `1792000004`) — `payment_reminder_sync_events`
 * cannot be reused, it is FK'd to `fee_assignments` with several NOT NULL columns this event has
 * no equivalent for.
 */
export * as FinanceRpcEvents from './rpc/finance/FinanceRpcEvents.js';
export * as FinanceRpcGroup from './rpc/finance/FinanceRpcGroup.js';
/**
 * T10 — the payment QR delivered by the bot alongside a reminder DM. `spayd` is the raw SPAYD
 * payload (for debugging / a text fallback); `png_base64` is the rendered QR image the bot
 * attaches via `attachment://<filename>`.
 */
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
 * PR-2 itself only widened the schema — the server still only ever emitted a non-null
 * `welcome_channel_id`. That is no longer true (stale comment fixed, whole-series review of
 * `fix/discord-onboarding-webapp`): PR-3 lifted `findPending`'s `welcome_channel_id IS NOT NULL`
 * guard, so the server now genuinely emits `null` for a team with no welcome channel configured,
 * and `bot_present: false` for a guild the bot has never joined. Both fields decode for real now
 * — this schema is not just tolerant, it is load-bearing. See
 * `InviteAcceptancesRepository.findPending` for the current query.
 */
export * as InviteRpcGroup from './rpc/invite/InviteRpcGroup.js';
export * as PersonalEventsRpcGroup from './rpc/personalEvents/PersonalEventsRpcGroup.js';
export * as PollRpcGroup from './rpc/poll/PollRpcGroup.js';
export * as PollRpcModels from './rpc/poll/PollRpcModels.js';
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
