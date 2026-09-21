// TDD — written BEFORE `applications/server/src/api/search.ts` exists
// (`.work-plans/command-palette-search.md` §F.3). `applications/server/src/api/api.ts` (the
// domain-level `HttpApi.make('api')` object) does not yet declare `SearchApi.SearchApiGroup`, and
// `applications/server/src/api/index.ts` (`ApiLive`) does not yet provide a `SearchApiLive`
// handler for it — both are part of the developer's job, alongside creating `search.ts` itself.
// Because this file uses the FULL production `ApiLive` (per §F.3's explicit instruction to model
// this on `ai-chat.test.ts`, NOT the lightweight "SmallApi" harness §F.4 uses), it does NOT import
// anything from `~/api/search.js` directly — unlike `searchRanking.test.ts` (§F.2), which imports
// `rankAndCap` and therefore fails at module-resolution time. Every case below currently fails
// instead because `GET /teams/:teamId/search` 404s (the route does not exist on `Api` yet) — every
// `expect(response.status).toBe(...)` observes 404 instead of the documented status. That is this
// file's TDD-red state. Once the developer creates `search.ts` (exporting `SearchApiLive`), adds
// `SearchApi.SearchApiGroup` to `Api` (`api.ts`), and adds `Layer.provide(SearchApiLive)` to
// `ApiLive` (`index.ts`) — exactly how every other group in this file's `CommonLayers` is wired —
// this file exercises the real handler with no changes needed.
//
// Harness: mirrors `test/api/ai-chat.test.ts`'s `CommonLayers` (full `ApiLive` +
// `AuthMiddlewareLive` + mock repositories, real HTTP round-trip via `HttpRouter.toWebHandler`).
// Plain `vitest`, not `it.effect` — matches every existing `test/api/*.test.ts` file, whose
// harness deals in `Promise<Response>`.
//
// **The harness is the point** (§F.3): a real round-trip exercises the actual
// `Schema.Array(SearchHit)` encode. Every mocked repository below returns rows shaped exactly
// like the real SQL rows (`EventWithDetails`, `RosterEntry`, plain row records for
// groups/rosters/training-types) — the same fixture shapes `test/services/aiTools.test.ts` uses
// for the read-tool executors these handlers call directly. `expect(response.status).toBe(200)`
// (or the documented error status) is asserted on every case — an encode failure would otherwise
// surface as a 500 with every later field read `undefined`.
//
// `GroupsRepository.getDescendantMemberIds` is mocked as a FLAT lookup keyed by group id — it does
// NOT model the ancestor/descendant walk the real recursive CTE performs (`applications/server/
// AGENTS.md` mock rule 4). The real-SQL recursion is `test/integration/api/search.test.ts` (§F.4)'s
// job. Here, no persona is ever a member of `GROUP_RESTRICTED`, so every persona's `canSeeGroup`
// check against it resolves `false` — which is exactly what cases 10/11 need.
//
// Design decisions / assumptions this file makes that the plan does not pin down directly (per
// the task's instruction to flag disagreements rather than silently guess):
//
//   1. **`search.ts` calls `listAllEvents` directly, not the `listEvents` dispatcher.** Per the
//      task brief's own "known gap" note: `listEvents` (readTools.ts) takes an optional `eventId`
//      and, when absent, delegates to the currently-UNEXPORTED `listAllEvents`. Search never has
//      an `eventId`, so this file assumes the implementer exports `listAllEvents` and calls it
//      with an `EntityReadContext` (no `teamTimezone` needed — that type's own doc comment says
//      as much). This file only exercises the HTTP surface, so this assumption is untestable from
//      here directly; it is inherited from the task brief, not independently re-derived.
//   2. **Search calls each of the five executors with `{ query: q }`, aggregates every returned
//      `hit`, and only THEN calls `rankAndCap(allHits, q, todayIso)` for ranking/bucketing/
//      capping — not filtering.** This matches `searchRanking.test.ts`'s own fixtures, whose every
//      input hit already matches the query string under test; `rankAndCap` is never shown
//      filtering out a non-match there. This file's cap case (16) therefore seeds every over-cap
//      row so it ALREADY matches the query substring `'alpha'`, relying on each executor's own
//      `applyQueryFilter`/`matchesQuery` (readTools.ts) to do the real filtering — `rankAndCap` is
//      only trusted here to trim the aggregate down to the caps, per F.2.
//   3. **No `todayIso`/clock assertions here.** F.2 (`searchRanking.test.ts`) owns date-bucket
//      ordering. This file only asserts presence/absence of hits by kind, never their relative
//      order, so no fixture date is load-bearing against `rankAndCap`'s "today" notion.

import type {
  Auth,
  Discord,
  Event,
  GroupModel,
  Role,
  RosterModel,
  Team,
  TeamMember,
  TrainingType,
  User,
} from '@sideline/domain';
import { OAuth2Tokens } from 'arctic';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpClient, HttpClientResponse, HttpRouter, HttpServer } from 'effect/unstable/http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiLive } from '~/api/index.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { AchievementRoleMappingsRepository } from '~/repositories/AchievementRoleMappingsRepository.js';
import { AchievementSettingsRepository } from '~/repositories/AchievementSettingsRepository.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { ActivityTypesRepository } from '~/repositories/ActivityTypesRepository.js';
import { AgeThresholdRepository } from '~/repositories/AgeThresholdRepository.js';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { CustomAchievementsRepository } from '~/repositories/CustomAchievementsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordRoleProvisionEventsRepository } from '~/repositories/DiscordRoleProvisionEventsRepository.js';
import { DiscordRolesRepository } from '~/repositories/DiscordRolesRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventSeriesRepository } from '~/repositories/EventSeriesRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository, EventWithDetails } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { ICalTokensRepository } from '~/repositories/ICalTokensRepository.js';
import { InviteAcceptancesRepository } from '~/repositories/InviteAcceptancesRepository.js';
import { LeaderboardRepository } from '~/repositories/LeaderboardRepository.js';
import { NotificationsRepository } from '~/repositories/NotificationsRepository.js';
import { OAuthConnectionsRepository } from '~/repositories/OAuthConnectionsRepository.js';
import { PendingGuildJoinsRepository } from '~/repositories/PendingGuildJoinsRepository.js';
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamInvitesRepository } from '~/repositories/TeamInvitesRepository.js';
import type { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';
import { RosterEntry, TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { AchievementPreview } from '~/services/AchievementPreview.js';
import { AgeCheckService } from '~/services/AgeCheckService.js';
import { AiChatEnabledConfig } from '~/services/AiChatEnabledConfig.js';
import { BotInfoStore } from '~/services/BotInfoStore.js';
import { DiscordJoinEnforcementConfig } from '~/services/DiscordJoinEnforcementConfig.js';
import { DiscordOAuth } from '~/services/DiscordOAuth.js';
import { GlobalAdminAllowlist } from '~/services/GlobalAdminAllowlist.js';
import { LlmClient } from '~/services/LlmClient.js';
import { MockChatAgentLayer, MockChatRateLimiterLayer } from '../mocks/aiChatMocks.js';
import { MockBankSyncLayers, MockGenericSqlClientLayer } from '../mocks/bankSyncMocks.js';
import { MockChannelManagementLayers } from '../mocks/channelMocks.js';
import { MockDashboardLayoutsRepositoryLayer } from '../mocks/dashboardLayoutMocks.js';
import { MockEmailLayers } from '../mocks/emailMocks.js';
import { MockEventRosterLayers } from '../mocks/eventRosterMocks.js';
import { MockFinanceLayers } from '../mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from '../mocks/onboardingMocks.js';
import { MockPlayerRatingsRepositoryLayer } from '../mocks/playerRatingMocks.js';
import { MockRulesAttemptsRepositoryLayer } from '../mocks/rulesTrainerMocks.js';
import { MockTeamChallengeRepositoryLayer } from '../mocks/teamChallengeMocks.js';
import { MockTranslationsLayers } from '../mocks/translationMocks.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------
const TEAM_A = '00000000-0000-0000-0000-0000000a0010' as Team.TeamId;
const TEAM_B = '00000000-0000-0000-0000-0000000b0010' as Team.TeamId;

const USER_PLAIN = '00000000-0000-0000-0000-000000001001' as Auth.UserId;
const USER_ADMIN = '00000000-0000-0000-0000-000000001002' as Auth.UserId;
const USER_MEMBER_VIEW = '00000000-0000-0000-0000-000000001003' as Auth.UserId;
const USER_GROUP_MANAGE = '00000000-0000-0000-0000-000000001004' as Auth.UserId;
const USER_ROSTER_VIEW = '00000000-0000-0000-0000-000000001005' as Auth.UserId;
const USER_NON_MEMBER = '00000000-0000-0000-0000-000000001006' as Auth.UserId;
const USER_TEAM_B = '00000000-0000-0000-0000-000000001007' as Auth.UserId;

const MEMBER_PLAIN = '00000000-0000-0000-0000-000000002001' as TeamMember.TeamMemberId;
const MEMBER_ADMIN = '00000000-0000-0000-0000-000000002002' as TeamMember.TeamMemberId;
const MEMBER_MEMBER_VIEW = '00000000-0000-0000-0000-000000002003' as TeamMember.TeamMemberId;
const MEMBER_GROUP_MANAGE = '00000000-0000-0000-0000-000000002004' as TeamMember.TeamMemberId;
const MEMBER_ROSTER_VIEW = '00000000-0000-0000-0000-000000002005' as TeamMember.TeamMemberId;
const MEMBER_TEAM_B = '00000000-0000-0000-0000-000000002007' as TeamMember.TeamMemberId;
// Someone in GROUP_RESTRICTED, but never a token holder in this suite — exists purely so the
// group is non-empty; no persona below is ever a member of it (that's the point of cases 10/11).
const MEMBER_IN_RESTRICTED_GROUP =
  '00000000-0000-0000-0000-000000002099' as TeamMember.TeamMemberId;

const GROUP_ALPHA = '00000000-0000-0000-0000-000000003001' as GroupModel.GroupId;
const GROUP_ALPHA_B = '00000000-0000-0000-0000-000000003002' as GroupModel.GroupId;
const GROUP_RESTRICTED = '00000000-0000-0000-0000-000000003099' as GroupModel.GroupId;

const EVENT_UNGROUPED = '00000000-0000-0000-0000-0000000e4001' as Event.EventId;
const EVENT_RESTRICTED = '00000000-0000-0000-0000-0000000e4002' as Event.EventId;
const EVENT_B = '00000000-0000-0000-0000-0000000e4003' as Event.EventId;

const TT_ALPHA = '00000000-0000-0000-0000-0000000t5001' as TrainingType.TrainingTypeId;
const TT_ALPHA_B = '00000000-0000-0000-0000-0000000t5002' as TrainingType.TrainingTypeId;

const ROSTER_ALPHA = '00000000-0000-0000-0000-0000000r6001' as RosterModel.RosterId;
const ROSTER_ALPHA_B = '00000000-0000-0000-0000-0000000r6002' as RosterModel.RosterId;

const MEMBER_ROW_ALPHA = '00000000-0000-0000-0000-000000007001' as TeamMember.TeamMemberId;
const MEMBER_ROW_ALPHA_B = '00000000-0000-0000-0000-000000007002' as TeamMember.TeamMemberId;

// Marks TEAM_B's fixtures unmistakably, while still containing 'alpha' so the same query matches
// them too — case 2 / case 3 assert this marker never appears in a TEAM_A response.
const B_ONLY_MARKER = 'OnlyInB';

const PERM_ADMIN: readonly Role.Permission[] = [
  'team:manage',
  'group:manage',
  'member:view',
  'roster:view',
];
const PERM_MEMBER_VIEW: readonly Role.Permission[] = ['member:view'];
const PERM_GROUP_MANAGE: readonly Role.Permission[] = ['group:manage'];
const PERM_ROSTER_VIEW: readonly Role.Permission[] = ['roster:view'];
const PERM_NONE: readonly Role.Permission[] = [];

// ---------------------------------------------------------------------------
// Sessions / users / memberships (mirrors ai-chat.test.ts's stateful maps)
// ---------------------------------------------------------------------------

const sessionsStore = new Map<string, Auth.UserId>([
  ['plain-token', USER_PLAIN],
  ['admin-token', USER_ADMIN],
  ['member-view-token', USER_MEMBER_VIEW],
  ['group-manage-token', USER_GROUP_MANAGE],
  ['roster-view-token', USER_ROSTER_VIEW],
  ['non-member-token', USER_NON_MEMBER],
  ['team-b-token', USER_TEAM_B],
]);

const membership = (
  id: TeamMember.TeamMemberId,
  teamId: Team.TeamId,
  userId: Auth.UserId,
  permissions: readonly Role.Permission[],
): MembershipWithRole =>
  ({
    id,
    team_id: teamId,
    user_id: userId,
    active: true,
    role_names: ['Custom'],
    permissions,
  }) as MembershipWithRole;

const membersStore = new Map<TeamMember.TeamMemberId, MembershipWithRole>([
  [MEMBER_PLAIN, membership(MEMBER_PLAIN, TEAM_A, USER_PLAIN, PERM_NONE)],
  [MEMBER_ADMIN, membership(MEMBER_ADMIN, TEAM_A, USER_ADMIN, PERM_ADMIN)],
  [MEMBER_MEMBER_VIEW, membership(MEMBER_MEMBER_VIEW, TEAM_A, USER_MEMBER_VIEW, PERM_MEMBER_VIEW)],
  [
    MEMBER_GROUP_MANAGE,
    membership(MEMBER_GROUP_MANAGE, TEAM_A, USER_GROUP_MANAGE, PERM_GROUP_MANAGE),
  ],
  [MEMBER_ROSTER_VIEW, membership(MEMBER_ROSTER_VIEW, TEAM_A, USER_ROSTER_VIEW, PERM_ROSTER_VIEW)],
  [MEMBER_TEAM_B, membership(MEMBER_TEAM_B, TEAM_B, USER_TEAM_B, PERM_ADMIN)],
]);

const MockSessionsRepositoryLayer = Layer.succeed(SessionsRepository, {
  findByToken: (token: string) => {
    const userId = sessionsStore.get(token);
    if (!userId) return Effect.succeed(Option.none());
    return Effect.succeed(
      Option.some({
        id: 'session-1',
        user_id: userId,
        token,
        expires_at: DateTime.nowUnsafe(),
        created_at: DateTime.nowUnsafe(),
      }),
    );
  },
  create: () => Effect.die(new Error('Not implemented')),
  deleteByToken: () => Effect.void,
} as never);

const testUserShape = (id: Auth.UserId) => ({
  id,
  discord_id: `${id}`.slice(-10),
  username: `user-${id}`,
  avatar: Option.none<string>(),
  is_profile_complete: true,
  name: Option.none<string>(),
  birth_date: Option.none(),
  gender: Option.none<'male' | 'female' | 'other'>(),
  locale: 'en' as const,
  discord_display_name: Option.none<string>(),
  discord_nickname: Option.none<string>(),
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
});

const MockUsersRepositoryLayer = Layer.succeed(UsersRepository, {
  findById: (id: Auth.UserId) => Effect.succeed(Option.some(testUserShape(id))),
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.die(new Error('Not implemented')),
  completeProfile: () => Effect.die(new Error('Not implemented')),
  updateLocale: () => Effect.die(new Error('Not implemented')),
  updateAdminProfile: () => Effect.die(new Error('Not implemented')),
} as never);

const testTeam = (id: Team.TeamId) => ({
  id,
  name: 'Search Test Team',
  guild_id: `${id}`.slice(-18) as Discord.Snowflake,
  created_by: USER_ADMIN,
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
});

const MockTeamsRepositoryLayer = Layer.succeed(TeamsRepository, {
  findById: (id: Team.TeamId) =>
    id === TEAM_A || id === TEAM_B
      ? Effect.succeed(Option.some(testTeam(id)))
      : Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  findByGuildId: () => Effect.succeed(Option.none()),
} as never);

const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  findMembershipByIds: (teamId: Team.TeamId, userId: Auth.UserId) => {
    const found = Array.from(membersStore.values()).find(
      (m) => m.team_id === teamId && m.user_id === userId,
    );
    return Effect.succeed(found ? Option.some(found) : Option.none());
  },
  findByTeam: () => Effect.succeed([]),
  findByUser: (userId: Auth.UserId) =>
    Effect.succeed(Array.from(membersStore.values()).filter((m) => m.user_id === userId)),
  findRosterByTeam: (teamId: Team.TeamId) => Effect.succeed(rosterEntriesByTeam.get(teamId) ?? []),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  addMember: () => Effect.die(new Error('Not implemented')),
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  getPlayerRoleId: () => Effect.succeed(Option.none()),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
} as never);

// ---------------------------------------------------------------------------
// Search-relevant data fixtures
// ---------------------------------------------------------------------------

const buildEvent = (
  id: Event.EventId,
  teamId: Team.TeamId,
  title: string,
  memberGroupId: Option.Option<GroupModel.GroupId>,
): EventWithDetails =>
  new EventWithDetails({
    id,
    team_id: teamId,
    training_type_id: Option.none(),
    event_type: 'training',
    title,
    description: Option.none(),
    image_url: Option.none(),
    start_at: DateTime.makeUnsafe('2026-06-01T10:00:00.000Z'),
    end_at: Option.none(),
    location: Option.none(),
    location_url: Option.none(),
    status: 'active',
    created_by: MEMBER_ADMIN,
    training_type_name: Option.none(),
    created_by_name: Option.none(),
    series_id: Option.none(),
    series_modified: false,
    owner_group_id: Option.none(),
    owner_group_name: Option.none(),
    member_group_id: memberGroupId,
    member_group_name: Option.none(),
    reminder_sent_at: Option.none(),
    claimed_by: Option.none(),
    claimer_name: Option.none(),
    claim_discord_channel_id: Option.none(),
    claim_discord_message_id: Option.none(),
    all_day: false,
    personal_messages_dirty_at: Option.none(),
    start_date: '2026-06-01',
    end_date: '2026-06-01',
    timezone: 'Europe/Prague',
  });

const capEvents = Array.from({ length: 7 }, (_, i) =>
  buildEvent(
    `00000000-0000-0000-0000-0000000e5${String(i).padStart(3, '0')}` as Event.EventId,
    TEAM_A,
    `Alpha Cap Event ${i}`,
    Option.none(),
  ),
);

const eventRows: ReadonlyArray<EventWithDetails> = [
  buildEvent(EVENT_UNGROUPED, TEAM_A, 'Alpha Practice', Option.none()),
  buildEvent(EVENT_RESTRICTED, TEAM_A, 'Alpha Restricted', Option.some(GROUP_RESTRICTED)),
  buildEvent(EVENT_B, TEAM_B, `Alpha ${B_ONLY_MARKER} Event`, Option.none()),
  ...capEvents,
];

const MockEventsRepositoryLayer = Layer.succeed(EventsRepository, {
  findEventsByTeamId: (teamId: Team.TeamId) =>
    Effect.succeed(eventRows.filter((r) => r.team_id === teamId)),
  findEventByIdWithDetails: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  cancel: () => Effect.void,
  findScopedTrainingTypeIds: () => Effect.succeed([]),
  getScopedTrainingTypeIds: () => Effect.succeed([]),
} as never);

interface GroupRow {
  readonly id: GroupModel.GroupId;
  readonly team_id: Team.TeamId;
  readonly parent_id: Option.Option<GroupModel.GroupId>;
  readonly name: string;
  readonly emoji: Option.Option<string>;
  readonly color: Option.Option<string>;
  readonly member_count: number;
}

const groupRows: ReadonlyArray<GroupRow> = [
  {
    id: GROUP_ALPHA,
    team_id: TEAM_A,
    parent_id: Option.none(),
    name: 'Alpha Squad',
    emoji: Option.none(),
    color: Option.none(),
    member_count: 3,
  },
  {
    id: GROUP_RESTRICTED,
    team_id: TEAM_A,
    parent_id: Option.none(),
    name: 'Restricted Group',
    emoji: Option.none(),
    color: Option.none(),
    member_count: 1,
  },
  {
    id: GROUP_ALPHA_B,
    team_id: TEAM_B,
    parent_id: Option.none(),
    name: `Alpha ${B_ONLY_MARKER} Group`,
    emoji: Option.none(),
    color: Option.none(),
    member_count: 1,
  },
];

// Flat, non-recursive: `GROUP_RESTRICTED` contains only `MEMBER_IN_RESTRICTED_GROUP`, who holds
// no session token in this suite — every persona below is therefore excluded from it. See the
// header comment for why this does not model the real ancestor walk (that's §F.4).
const descendantMemberIdsByGroup = new Map<
  GroupModel.GroupId,
  ReadonlyArray<TeamMember.TeamMemberId>
>([
  [GROUP_RESTRICTED, [MEMBER_IN_RESTRICTED_GROUP]],
  [GROUP_ALPHA, []],
  [GROUP_ALPHA_B, []],
]);

const MockGroupsRepositoryLayer = Layer.succeed(GroupsRepository, {
  findGroupsByTeamId: (teamId: Team.TeamId) =>
    Effect.succeed(groupRows.filter((g) => g.team_id === teamId)),
  findGroupById: () => Effect.succeed(Option.none()),
  insertGroup: () => Effect.die(new Error('Not implemented')),
  updateGroupById: () => Effect.die(new Error('Not implemented')),
  archiveGroupById: () => Effect.void,
  moveGroup: () => Effect.die(new Error('Not implemented')),
  findMembersByGroupId: () => Effect.succeed([]),
  addMemberById: () => Effect.void,
  removeMemberById: () => Effect.void,
  getRolesForGroup: () => Effect.succeed([]),
  getMemberCount: () => Effect.succeed(0),
  getChildren: () => Effect.succeed([]),
  getAncestorIds: () => Effect.succeed([]),
  getDescendantMemberIds: (groupId: GroupModel.GroupId) =>
    Effect.succeed(descendantMemberIdsByGroup.get(groupId) ?? []),
} as never);

interface TrainingTypeRow {
  readonly id: TrainingType.TrainingTypeId;
  readonly team_id: Team.TeamId;
  readonly name: string;
  readonly owner_group_name: Option.Option<string>;
  readonly member_group_name: Option.Option<string>;
}

const trainingTypeRows: ReadonlyArray<TrainingTypeRow> = [
  {
    id: TT_ALPHA,
    team_id: TEAM_A,
    name: 'Alpha Fitness',
    owner_group_name: Option.none(),
    member_group_name: Option.none(),
  },
  {
    id: TT_ALPHA_B,
    team_id: TEAM_B,
    name: `Alpha ${B_ONLY_MARKER} Fitness`,
    owner_group_name: Option.none(),
    member_group_name: Option.none(),
  },
];

const MockTrainingTypesRepositoryLayer = Layer.succeed(TrainingTypesRepository, {
  findTrainingTypesByTeamId: (teamId: Team.TeamId) =>
    Effect.succeed(trainingTypeRows.filter((t) => t.team_id === teamId)),
  findById: () => Effect.succeed(Option.none()),
  findByIdWithGroup: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  deleteTrainingType: () => Effect.void,
} as never);

interface RosterRow {
  readonly id: RosterModel.RosterId;
  readonly team_id: Team.TeamId;
  readonly name: string;
  readonly active: boolean;
  readonly color: Option.Option<string>;
  readonly emoji: Option.Option<string>;
  readonly member_count: number;
  readonly created_at: DateTime.Utc;
  readonly discord_channel_id: Option.Option<Discord.Snowflake>;
}

const rosterRows: ReadonlyArray<RosterRow> = [
  {
    id: ROSTER_ALPHA,
    team_id: TEAM_A,
    name: 'Alpha Roster',
    active: true,
    color: Option.none(),
    emoji: Option.none(),
    member_count: 5,
    created_at: DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'),
    discord_channel_id: Option.none(),
  },
  {
    id: ROSTER_ALPHA_B,
    team_id: TEAM_B,
    name: `Alpha ${B_ONLY_MARKER} Roster`,
    active: true,
    color: Option.none(),
    emoji: Option.none(),
    member_count: 5,
    created_at: DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'),
    discord_channel_id: Option.none(),
  },
];

const MockRostersRepositoryLayer = Layer.succeed(RostersRepository, {
  findByTeamId: (teamId: Team.TeamId) =>
    Effect.succeed(rosterRows.filter((r) => r.team_id === teamId)),
  findRosterById: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  delete: () => Effect.void,
  findMemberEntriesById: () => Effect.succeed([]),
  addMemberById: () => Effect.void,
  removeMemberById: () => Effect.void,
} as never);

const buildRosterEntry = (memberId: TeamMember.TeamMemberId, displayName: string): RosterEntry =>
  new RosterEntry({
    member_id: memberId,
    user_id: USER_PLAIN,
    discord_id: '123456789012345678' as Discord.Snowflake,
    role_names: ['Player'],
    permissions: [],
    effective_roles: [],
    name: Option.some(displayName),
    birth_date: Option.some('2000-01-01'),
    gender: Option.some('female' as User.Gender),
    jersey_number: Option.some(7),
    username: 'alpha#0001',
    avatar: Option.some('abcd1234'),
    discord_nickname: Option.none(),
    discord_display_name: Option.none(),
    joined_at: '2024-01-01T00:00:00.000Z',
    active: true,
  });

const capMemberRows = Array.from({ length: 9 }, (_, i) =>
  buildRosterEntry(
    `00000000-0000-0000-0000-000000008${String(i).padStart(3, '0')}` as TeamMember.TeamMemberId,
    `Alpha Cap Member ${i}`,
  ),
);

const rosterEntriesByTeam = new Map<Team.TeamId, ReadonlyArray<RosterEntry>>([
  [TEAM_A, [buildRosterEntry(MEMBER_ROW_ALPHA, 'Alpha Member'), ...capMemberRows]],
  [TEAM_B, [buildRosterEntry(MEMBER_ROW_ALPHA_B, `Alpha ${B_ONLY_MARKER} Member`)]],
]);

// ---------------------------------------------------------------------------
// Everything else `ApiLive` needs — static noops, copied from ai-chat.test.ts's `CommonLayers`
// (this suite exercises none of it).
// ---------------------------------------------------------------------------

const MockDiscordOAuthLayer = Layer.succeed(DiscordOAuth, {
  _tag: 'api/DiscordOAuth',
  createAuthorizationURL: () =>
    Effect.succeed(new URL('https://discord.com/oauth2/authorize?client_id=test')),
  validateAuthorizationCode: () =>
    Effect.succeed(
      new OAuth2Tokens({ access_token: 'mock-access-token', refresh_token: 'mock-refresh-token' }),
    ),
} as never);

const MockHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ id: '12345', username: 'testuser', avatar: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  ),
);

const MockActivityTypesRepositoryLayer = Layer.succeed(ActivityTypesRepository, {
  findBySlug: () => Effect.succeed(Option.none()),
  findByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
  findByIdScoped: () => Effect.succeed(Option.none()),
  findByNameInScope: () => Effect.succeed(Option.none()),
  insertCustom: () => Effect.die(new Error('Not implemented')),
  updateCustom: () => Effect.die(new Error('Not implemented')),
  deleteCustom: () => Effect.void,
  countLogsForType: () => Effect.succeed(0),
} as never);

const MockActivityLogsRepositoryLayer = Layer.succeed(ActivityLogsRepository, {
  insert: () => Effect.die(new Error('not implemented')),
  findByTeamMember: () => Effect.succeed([]),
} as never);

const MockLeaderboardRepositoryLayer = Layer.succeed(LeaderboardRepository, {
  getLeaderboard: () => Effect.succeed([]),
} as never);

const MockRolesRepositoryLayer = Layer.succeed(RolesRepository, {
  findRolesByTeamId: () => Effect.succeed([]),
  findRoleById: () => Effect.succeed(Option.none()),
  getPermissionsForRoleId: () => Effect.succeed([]),
  insertRole: () => Effect.die(new Error('Not implemented')),
  updateRole: () => Effect.die(new Error('Not implemented')),
  archiveRoleById: () => Effect.void,
  setRolePermissions: () => Effect.void,
  initializeTeamRoles: () => Effect.void,
  findRoleByTeamAndName: () => Effect.succeed(Option.none()),
  seedTeamRolesWithPermissions: () => Effect.succeed([]),
  getMemberCountForRole: () => Effect.succeed(0),
  findGroupsForRole: () => Effect.succeed([]),
  assignRoleToGroup: () => Effect.void,
  unassignRoleFromGroup: () => Effect.void,
} as never);

const MockAgeThresholdRepositoryLayer = Layer.succeed(AgeThresholdRepository, {
  findByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  updateRule: () => Effect.die(new Error('Not implemented')),
  deleteRule: () => Effect.void,
  findAllTeamsWithRules: () => Effect.succeed([]),
  findMembersWithBirthYears: () => Effect.succeed([]),
  findRulesByTeamId: () => Effect.succeed([]),
  findRuleById: () => Effect.succeed(Option.none()),
  insertRule: () => Effect.die(new Error('Not implemented')),
  updateRuleById: () => Effect.die(new Error('Not implemented')),
  deleteRuleById: () => Effect.void,
  getAllTeamsWithRules: () => Effect.succeed([]),
  getMembersForAutoAssignment: () => Effect.succeed([]),
} as never);

const MockNotificationsRepositoryLayer = Layer.succeed(NotificationsRepository, {
  findByUserId: () => Effect.succeed([]),
  insertOne: () => Effect.die(new Error('Not implemented')),
  markOneAsRead: () => Effect.void,
  markAllRead: () => Effect.void,
  findOneById: () => Effect.succeed(Option.none()),
  findByUser: () => Effect.succeed([]),
  insert: () => Effect.die(new Error('Not implemented')),
  insertBulk: () => Effect.void,
  markAsRead: () => Effect.void,
  markAllAsRead: () => Effect.void,
  findById: () => Effect.succeed(Option.none()),
} as never);

const MockAgeCheckServiceLayer = Layer.succeed(AgeCheckService, {
  evaluateTeam: () => Effect.succeed([]),
  evaluate: () => Effect.succeed([]),
} as never);

const MockRoleSyncEventsRepositoryLayer = Layer.succeed(RoleSyncEventsRepository, {
  emitRoleCreated: () => Effect.void,
  emitRoleDeleted: () => Effect.void,
  emitRoleAssigned: () => Effect.void,
  emitRoleUnassigned: () => Effect.void,
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
} as never);

const MockChannelSyncEventsRepositoryLayer = Layer.succeed(ChannelSyncEventsRepository, {
  emitChannelCreated: () => Effect.void,
  emitChannelDeleted: () => Effect.void,
  emitMemberAdded: () => Effect.void,
  emitMemberRemoved: () => Effect.void,
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
  hasUnprocessedForGroups: () => Effect.succeed([]),
  hasUnprocessedForRosters: () => Effect.succeed([]),
} as never);

const MockEventSyncEventsRepositoryLayer = Layer.succeed(EventSyncEventsRepository, {
  emitEventCreated: () => Effect.void,
  emitEventUpdated: () => Effect.void,
  emitEventCancelled: () => Effect.void,
  emitRsvpReminder: () => Effect.void,
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
} as never);

const MockDiscordChannelMappingRepositoryLayer = Layer.succeed(DiscordChannelMappingRepository, {
  findByGroupId: () => Effect.succeed(Option.none()),
  insert: () => Effect.void,
  insertWithoutRole: () => Effect.void,
  deleteByGroupId: () => Effect.void,
  findAllByTeamId: () => Effect.succeed([]),
  findAllByTeam: () => Effect.succeed([]),
} as never);

const MockOAuthConnectionsRepositoryLayer = Layer.succeed(OAuthConnectionsRepository, {
  upsertConnection: () => Effect.die(new Error('Not implemented')),
  upsert: () => Effect.die(new Error('Not implemented')),
  findByUserAndProvider: () => Effect.succeed(Option.none()),
  findByUser: () => Effect.succeed(Option.none()),
  findAccessToken: () => Effect.succeed(Option.some({ access_token: 'mock-access-token' })),
  getAccessToken: () => Effect.succeed('mock-access-token'),
} as never);

const MockDiscordChannelsRepositoryLayer = Layer.succeed(DiscordChannelsRepository, {
  syncChannels: () => Effect.void,
  findByGuildId: () => Effect.succeed([]),
} as never);

const MockDiscordRolesRepositoryLayer = Layer.succeed(
  DiscordRolesRepository,
  new Proxy({} as never, { get: () => () => Effect.void }),
);

const MockEventSeriesRepositoryLayer = Layer.succeed(EventSeriesRepository, {
  insertSeries: () => Effect.die(new Error('Not implemented')),
  findByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
  updateSeries: () => Effect.die(new Error('Not implemented')),
  cancelSeries: () => Effect.void,
} as never);

const MockEventRsvpsRepositoryLayer = Layer.succeed(EventRsvpsRepository, {
  findByEventId: () => Effect.succeed([]),
  findByEventAndMember: () => Effect.succeed(Option.none()),
  upsert: () => Effect.die(new Error('Not implemented')),
  countByEventId: () => Effect.succeed([]),
} as never);

const MockICalTokensRepositoryLayer = Layer.succeed(ICalTokensRepository, {
  findByToken: () => Effect.succeed(Option.none()),
  findByUserId: () => Effect.succeed(Option.none()),
  create: () =>
    Effect.succeed({
      id: 'ical-id',
      user_id: 'user-id',
      token: 'ical-token',
      created_at: new Date(),
    }),
  regenerate: () =>
    Effect.succeed({
      id: 'ical-id',
      user_id: 'user-id',
      token: 'ical-token-new',
      created_at: new Date(),
    }),
} as never);

const MockTeamInvitesRepositoryLayer = Layer.succeed(TeamInvitesRepository, {
  findByCode: () => Effect.succeed(Option.none()),
  findByTeam: () => Effect.succeed([]),
  create: () => Effect.die(new Error('Not implemented')),
  deactivateByTeam: () => Effect.void,
  deactivateByTeamExcept: () => Effect.void,
} as never);

const MockAchievementAdminLayers = Layer.mergeAll(
  Layer.succeed(AchievementRoleMappingsRepository, {
    findAllByTeam: () => Effect.succeed([]),
    upsert: () => Effect.void,
    delete: () => Effect.void,
  } as never),
  Layer.succeed(AchievementSettingsRepository, {
    findOverridesByTeam: () => Effect.succeed(new Map()),
    upsertOverride: () => Effect.void,
    deleteOverride: () => Effect.void,
  } as never),
  Layer.succeed(CustomAchievementsRepository, {
    findByTeam: () => Effect.succeed([]),
    findById: () => Effect.succeed(Option.none()),
    insert: () => Effect.die(new Error('Not implemented')),
    update: () => Effect.die(new Error('Not implemented')),
    delete: () => Effect.void,
    setRoleMapping: () => Effect.void,
  } as never),
  Layer.succeed(DiscordRoleProvisionEventsRepository, {
    enqueue: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
  } as never),
  Layer.succeed(AchievementPreview, {
    preview: () =>
      Effect.succeed({ qualifyingCount: 0, removedMembers: [], botCanManageRoles: true }),
  } as never),
);

// AI-chat-specific noop mocks (this suite never touches those endpoints, but `ApiLive` still
// requires them — the same "HttpApi Mock-Layer Cascade" every `ApiLive`-providing test pays).
const MockAiChatLayers = Layer.mergeAll(
  MockChatAgentLayer,
  MockChatRateLimiterLayer,
  LlmClient.Default,
  AiChatEnabledConfig.Default,
);

const CommonLayers = ApiLive.pipe(
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockDiscordOAuthLayer),
  Layer.provide(MockUsersRepositoryLayer),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(MockTeamsRepositoryLayer),
  Layer.provide(MockTeamMembersRepositoryLayer),
  Layer.provide(
    Layer.merge(
      Layer.merge(
        Layer.merge(MockRostersRepositoryLayer, MockActivityLogsRepositoryLayer),
        MockActivityTypesRepositoryLayer,
      ),
      MockLeaderboardRepositoryLayer,
    ),
  ),
  Layer.provide(
    Layer.merge(
      MockTeamInvitesRepositoryLayer,
      Layer.merge(
        Layer.succeed(PendingGuildJoinsRepository, {
          enqueue: () => Effect.void,
          listPending: () => Effect.succeed([]),
          markDone: () => Effect.void,
          markFailed: () => Effect.void,
        } as never),
        Layer.succeed(InviteAcceptancesRepository, {} as never),
      ),
    ),
  ),
  Layer.provide(MockRolesRepositoryLayer),
  Layer.provide(MockGroupsRepositoryLayer),
  Layer.provide(MockTrainingTypesRepositoryLayer),
  Layer.provide(MockHttpClientLayer),
  Layer.provide(MockAgeCheckServiceLayer),
  Layer.provide(MockAgeThresholdRepositoryLayer),
  Layer.provide(Layer.merge(MockNotificationsRepositoryLayer, MockRoleSyncEventsRepositoryLayer)),
  Layer.provide(
    Layer.merge(MockChannelSyncEventsRepositoryLayer, MockEventSyncEventsRepositoryLayer),
  ),
  Layer.provide(
    Layer.merge(MockDiscordChannelMappingRepositoryLayer, MockICalTokensRepositoryLayer),
  ),
  Layer.provide(
    Layer.merge(
      Layer.merge(
        Layer.merge(
          Layer.merge(
            Layer.merge(
              Layer.merge(MockEventsRepositoryLayer, MockEventRsvpsRepositoryLayer),
              Layer.succeed(BotGuildsRepository, {
                upsert: () => Effect.void,
                remove: () => Effect.void,
                exists: () => Effect.succeed(false),
                findAll: () => Effect.succeed([]),
              } as never),
            ),
            Layer.merge(MockDiscordChannelsRepositoryLayer, MockDiscordRolesRepositoryLayer),
          ),
          MockEventSeriesRepositoryLayer,
        ),
        Layer.succeed(TeamSettingsRepository, {
          findByTeam: () => Effect.succeed(Option.none()),
          findByTeamId: () => Effect.succeed(Option.none()),
          upsertSettings: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
          upsert: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
          getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
          getHorizonDays: () => Effect.succeed(30),
        } as never),
      ),
      MockOAuthConnectionsRepositoryLayer,
    ),
  ),
  Layer.provide(MockAchievementAdminLayers),
)
  .pipe(Layer.provide(MockAiChatLayers))
  .pipe(Layer.provide(MockBankSyncLayers))
  .pipe(Layer.provide(MockGenericSqlClientLayer))
  .pipe(Layer.provide(MockFinanceLayers))
  .pipe(Layer.provide(MockTranslationsLayers))
  .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
  .pipe(Layer.provide(MockTeamChallengeRepositoryLayer))
  .pipe(Layer.provide(MockPlayerRatingsRepositoryLayer))
  .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
  .pipe(Layer.provide(MockRulesAttemptsRepositoryLayer))
  .pipe(Layer.provide(MockChannelManagementLayers))
  .pipe(Layer.provide(MockEmailLayers))
  .pipe(Layer.provide(MockEventRosterLayers))
  .pipe(Layer.provide(BotInfoStore.Default))
  .pipe(Layer.provide(DiscordJoinEnforcementConfig.Default))
  .pipe(
    Layer.provide(
      Layer.succeed(GlobalAdminAllowlist, { asEffect: Effect.succeed(new Set<string>()) } as never),
    ),
  );

interface TestApp {
  readonly handler: (...args: any) => Promise<Response>;
  readonly dispose: () => Promise<void>;
}

let app: TestApp;

beforeAll(() => {
  app = HttpRouter.toWebHandler(CommonLayers);
});

afterAll(async () => {
  await app.dispose();
});

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

const HOST = 'http://localhost';

const searchUrl = (teamId: Team.TeamId, query: string | undefined) =>
  query === undefined
    ? `${HOST}/teams/${teamId}/search`
    : `${HOST}/teams/${teamId}/search?q=${encodeURIComponent(query)}`;

const search = (teamId: Team.TeamId, token: string, query: string | undefined) =>
  app.handler(
    new Request(searchUrl(teamId, query), { headers: { Authorization: `Bearer ${token}` } }),
  );

const kindsOf = (body: ReadonlyArray<{ kind: string }>) => body.map((h) => h.kind);
const hasKind = (body: ReadonlyArray<{ kind: string }>, kind: string) =>
  kindsOf(body).includes(kind);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Search API', () => {
  // Case 1
  it('returns 403 SearchForbidden for a non-member', async () => {
    const response = await search(TEAM_A, 'non-member-token', 'alpha');
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body._tag).toBe('SearchForbidden');
  });

  // Case 2
  it("a team A member querying team B's id gets 403, and the body carries none of team B's names", async () => {
    const response = await search(TEAM_B, 'plain-token', 'alpha');
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(text).not.toContain(B_ONLY_MARKER);
  });

  // Case 3
  it('admin (all permissions), q=alpha: at least one hit of each of the five kinds', async () => {
    const response = await search(TEAM_A, 'admin-token', 'alpha');
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReadonlyArray<{ kind: string }>;
    for (const kind of ['event', 'member', 'group', 'roster', 'trainingType']) {
      expect(hasKind(body, kind)).toBe(true);
    }
    expect(JSON.stringify(body)).not.toContain(B_ONLY_MARKER);
  });

  // Cases 4/5 — member:view pairing, SAME query and fixtures.
  describe('member:view gate (paired)', () => {
    it('4: WITH member:view, the matching member hit is present', async () => {
      const response = await search(TEAM_A, 'member-view-token', 'alpha');
      expect(response.status).toBe(200);
      const body = (await response.json()) as ReadonlyArray<{ kind: string }>;
      expect(hasKind(body, 'member')).toBe(true);
    });

    it('5: WITHOUT member:view (same query/fixtures): 200, zero member hits, other kinds present', async () => {
      const response = await search(TEAM_A, 'plain-token', 'alpha');
      expect(response.status).toBe(200);
      const body = (await response.json()) as ReadonlyArray<{ kind: string }>;
      expect(hasKind(body, 'member')).toBe(false);
      expect(hasKind(body, 'event')).toBe(true);
      expect(hasKind(body, 'trainingType')).toBe(true);
    });
  });

  // Cases 6/7 — group:manage pairing.
  describe('group:manage gate (paired)', () => {
    it('6: WITH group:manage, the matching group hit is present', async () => {
      const response = await search(TEAM_A, 'group-manage-token', 'alpha');
      expect(response.status).toBe(200);
      const body = (await response.json()) as ReadonlyArray<{ kind: string }>;
      expect(hasKind(body, 'group')).toBe(true);
    });

    it('7: WITHOUT group:manage (same query/fixtures): 200, zero group hits, other kinds present', async () => {
      const response = await search(TEAM_A, 'plain-token', 'alpha');
      expect(response.status).toBe(200);
      const body = (await response.json()) as ReadonlyArray<{ kind: string }>;
      expect(hasKind(body, 'group')).toBe(false);
      expect(hasKind(body, 'event')).toBe(true);
      expect(hasKind(body, 'trainingType')).toBe(true);
    });
  });

  // Cases 8/9 — roster:view pairing.
  describe('roster:view gate (paired)', () => {
    it('8: WITH roster:view, the matching roster hit is present', async () => {
      const response = await search(TEAM_A, 'roster-view-token', 'alpha');
      expect(response.status).toBe(200);
      const body = (await response.json()) as ReadonlyArray<{ kind: string }>;
      expect(hasKind(body, 'roster')).toBe(true);
    });

    it('9: WITHOUT roster:view (same query/fixtures): 200, zero roster hits, other kinds present', async () => {
      const response = await search(TEAM_A, 'plain-token', 'alpha');
      expect(response.status).toBe(200);
      const body = (await response.json()) as ReadonlyArray<{ kind: string }>;
      expect(hasKind(body, 'roster')).toBe(false);
      expect(hasKind(body, 'event')).toBe(true);
      expect(hasKind(body, 'trainingType')).toBe(true);
    });
  });

  // Cases 10/11 — the event group filter applies to EVERY caller, including team:manage. A
  // review blocker: search never passes `includeAllGroups`, so `readTools.ts`'s
  // `wantsAll && canViewAll ? list : filter(...canSeeGroup...)` takes the FILTER branch for
  // admins too — an admin sees only the ungrouped event, identical to a plain member. A future
  // change passing `includeAllGroups: true` here would hand admins a cross-group list the events
  // page only gives on `?all=1` — that is a CONTRACT CHANGE, not a bug fix, and must not happen
  // silently under cover of "fixing" this test.
  describe('event group filter applies uniformly, even to team:manage (10/11)', () => {
    it('10: plain member sees only the ungrouped alpha event, not the one in an invisible group', async () => {
      const response = await search(TEAM_A, 'plain-token', 'Alpha ');
      expect(response.status).toBe(200);
      const body = (await response.json()) as ReadonlyArray<{
        kind: string;
        event?: { title: string };
      }>;
      const eventTitles = body.filter((h) => h.kind === 'event').map((h) => h.event?.title);
      expect(eventTitles).toContain('Alpha Practice');
      expect(eventTitles).not.toContain('Alpha Restricted');
    });

    it('11: team:manage caller, SAME fixtures — identical result: only the ungrouped event', async () => {
      const response = await search(TEAM_A, 'admin-token', 'Alpha ');
      expect(response.status).toBe(200);
      const body = (await response.json()) as ReadonlyArray<{
        kind: string;
        event?: { title: string };
      }>;
      const eventTitles = body.filter((h) => h.kind === 'event').map((h) => h.event?.title);
      expect(eventTitles).toContain('Alpha Practice');
      expect(eventTitles).not.toContain('Alpha Restricted');
    });
  });

  // Case 12/13/14 — wire validation and the empty-result path.
  describe('wire validation', () => {
    it('12: q omitted -> 400', async () => {
      const response = await search(TEAM_A, 'admin-token', undefined);
      expect(response.status).toBe(400);
    });

    it("q='' (below the 1-char minimum) -> 400", async () => {
      const response = await search(TEAM_A, 'admin-token', '');
      expect(response.status).toBe(400);
    });

    it('13: q at 101 chars -> 400', async () => {
      const response = await search(TEAM_A, 'admin-token', 'a'.repeat(101));
      expect(response.status).toBe(400);
    });

    it('q at 100 chars (the boundary) is accepted -> 200', async () => {
      const response = await search(TEAM_A, 'admin-token', 'a'.repeat(100));
      expect(response.status).toBe(200);
    });

    it('14: q matching nothing -> 200, []', async () => {
      const response = await search(TEAM_A, 'admin-token', 'zzznomatchzzz');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual([]);
    });
  });

  // Case 15 — the member allow-list, re-asserted on this surface.
  it('15: no member hit carries discordId, userId, username, email, birthDate, gender or permissions', async () => {
    const response = await search(TEAM_A, 'member-view-token', 'alpha');
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReadonlyArray<Record<string, unknown>>;
    const memberHit = body.find((h) => h.kind === 'member');
    expect(memberHit).toBeDefined();
    const forbiddenKeys = [
      'discordId',
      'userId',
      'username',
      'email',
      'birthDate',
      'gender',
      'permissions',
    ];
    for (const key of forbiddenKeys) {
      expect(Object.keys(memberHit ?? {})).not.toContain(key);
    }
  });

  // Case 16 — caps.
  it('16: 9 matching members and 7 matching events cap at exactly 5 each, 10 total', async () => {
    const response = await search(TEAM_A, 'admin-token', 'Alpha Cap');
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReadonlyArray<{ kind: string }>;
    const memberHits = body.filter((h) => h.kind === 'member');
    const eventHits = body.filter((h) => h.kind === 'event');
    expect(memberHits.length).toBe(5);
    expect(eventHits.length).toBe(5);
    expect(body.length).toBe(10);
  });
});
