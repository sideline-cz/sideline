// Spec for the read-only AI tool executors, the tool registry, and the
// `current_datetime` tool's wiring — plan `.work-plans/ai-app-interaction.md`
// §8 / §13.3.
//
// Contract this file pins down (`src/services/ai/toolTypes.ts`,
// `src/services/ai/readTools.ts` and `src/services/ai/registry.ts` implement against it):
//
//   - `ToolContext` (toolTypes.ts): `{ teamId, membership, teamTimezone, canSeeGroup }`.
//   - `makeCanSeeGroup(groupsRepoShape, membershipId)` (toolTypes.ts): builds the
//     per-request memoized `canSeeGroup` closure described in plan §8. It takes a
//     plain repository SHAPE (the `ServiceMap.Service.Shape<typeof GroupsRepository>`
//     object), exactly like `checkGroupAccess` in `src/api/scoping.ts` — not an
//     Effect `Layer` — so a test can hand it a hand-rolled counting stub with no
//     `Effect.provide` ceremony.
//   - Each read tool is exported from readTools.ts as `(args, ctx) => Effect<ToolExecutionResult>`
//     where `ToolExecutionResult = { result: unknown; hits: ReadonlyArray<AiChatApi.SearchHit> }`
//     (`.work-plans/command-palette-search.md` §B — `SearchHit` is `EntityRef` minus the
//     per-turn `ref` token; `ChatAgent` mints that token and constructs `EntityRef`).
//     `args` is the ALREADY-DECODED, plain-optional args object (`Schema.optionalKey`
//     fields are absent-or-present, never `Option`-wrapped) — decoding raw JSON tool-call
//     arguments against each tool's `Schema` is the registry/ChatAgent's job (§13.4),
//     not the executor's. Every executor's Effect never fails (`E = never`): permission
//     and not-found outcomes are ENCODED as the `result` value, e.g.
//     `{ error: 'forbidden', permission: 'member:view' }` / `{ error: 'not_found' }`.
//   - Tools needing a repository pull it from the ambient Effect context via
//     `XRepository.asEffect()` (the same pattern every `HttpApiBuilder.group` handler
//     uses) — tests provide a `Layer.succeed(XRepository, ...)` mock, per
//     `applications/server/AGENTS.md` → "HttpApi Mock-Layer Cascade". `list_events`
//     needs ONLY `EventsRepository` — the group-visibility check goes through
//     `ctx.canSeeGroup`, which already closes over `GroupsRepository`, so the
//     executor itself never resolves `GroupsRepository` from context.
//   - List tools wrap their model-facing rows as `{ items: [...] }`; the single-row
//     `list_events` `eventId` path and `current_datetime` return their fields directly
//     (no wrapper) per plan §8's table.
//   - `registry.ts` exports `ALL_TOOLS` (6 entries: `current_datetime`, `list_events`,
//     `list_training_types`, `list_groups`, `list_members`, `list_rosters`), each
//     `{ name, description, parameters, schema }` where `parameters` is the
//     `toToolParameters(schema)`-derived JSON Schema (built once, eagerly, at module
//     load — see `jsonSchema.ts`), and `visibleTools(ctx): ReadonlyArray<LlmToolDefinition>`
//     filtering `ALL_TOOLS` down to what `ctx.membership` may call.
//
// Flagged ambiguities / deviations from the plan doc, resolved here (see the
// tester's final report for the long version):
//   - The plan's §8 "Projections" section says `toEventInfo` moves into a new
//     `src/api/eventProjection.ts`. The step-1 commit already landed in this working
//     tree WITHOUT that extraction — `toEventInfo` is exported directly from
//     `src/api/event.ts` (see `git diff HEAD -- applications/server/src/api/event.ts`).
//     This file imports it from there, matching what actually exists on disk.
//   - The exact per-row "model-facing" JSON shape (beyond the member allow-list and
//     the group leak-test's named fields) is not pinned by the plan text. This file
//     fixes: events -> `{ ref, title, status, startAt }`, training types ->
//     `{ ref, name }`, groups -> `{ ref, name, emoji, color, memberCount }`,
//     members -> `{ ref, displayName, jerseyNumber, roleNames, active }` (the plan's
//     own example), rosters -> `{ ref, name, memberCount, active }`.
//   - `list_groups`'s `EntityRef.group` is a full `GroupApi.GroupInfo`, which carries
//     `discordChannelProvisioning`. The AI tool is not wired to
//     `ChannelSyncEventsRepository` (the plan's own backing-call table for
//     `list_groups` lists only `GroupsRepository.findGroupsByTeamId`), so this file
//     assumes the executor passes `discordChannelProvisioning: false` rather than
//     adding an undocumented repository dependency. Not asserted directly here (no
//     test in this file relies on that field's value), but it affects what a correct
//     `toGroupInfo(...)` call site looks like.
//   - `list_rosters` similarly is assumed to call `toRosterInfo(row, row.member_count,
//     [], false)` — no live Discord channel-name resolution — since the model-facing
//     allow-list has no use for it and the plan's backing-call table lists only
//     `RostersRepository.findByTeamId`.

import { describe, expect, it } from '@effect/vitest';
import type {
  ActivityLog,
  ActivityType,
  Discord,
  Event,
  EventRsvp,
  Fee,
  GroupModel,
  MembershipPlan,
  Role,
  RosterModel,
  Team,
  TeamMember,
  TrainingType,
  User,
} from '@sideline/domain';
import { DateTime, Effect, Layer, Option, Schema, type ServiceMap } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { toEventInfo } from '~/api/event.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { AiActionProposalsRepository } from '~/repositories/AiActionProposalsRepository.js';
import { EventAttendanceRepository } from '~/repositories/EventAttendanceRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventsRepository, EventWithDetails } from '~/repositories/EventsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { FinanceOverviewRepository } from '~/repositories/FinanceOverviewRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { MembershipPlansRepository } from '~/repositories/MembershipPlansRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import {
  MembershipWithRole,
  RosterEntry,
  TeamMembersRepository,
} from '~/repositories/TeamMembersRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { ProposeCreateEventArgs } from '~/services/ai/actions.js';
import { toToolParameters } from '~/services/ai/jsonSchema.js';
import {
  currentDatetime,
  getFinanceOverview,
  listActivityLogs,
  listEventAttendance,
  listEventRsvps,
  listEvents,
  listFees,
  listGroups,
  listMembers,
  listMembershipPlans,
  listRosters,
  listTrainingTypes,
} from '~/services/ai/readTools.js';
import { ALL_TOOLS, visibleTools } from '~/services/ai/registry.js';
import { makeCanSeeGroup, type ToolContext } from '~/services/ai/toolTypes.js';
import { proposeAction } from '~/services/ai/writeTools.js';

// ---------------------------------------------------------------------------
// Test ids
// ---------------------------------------------------------------------------

const TEAM_A = '00000000-0000-0000-0000-00000000a001' as Team.TeamId;
const TEAM_B = '00000000-0000-0000-0000-00000000b001' as Team.TeamId;

const MEMBER_A1 = '00000000-0000-0000-0000-0000000a0001' as TeamMember.TeamMemberId;
const USER_1 = 'user-1' as User.UserId;

const GROUP_A1 = '00000000-0000-0000-0000-0000000ga001' as GroupModel.GroupId;
const GROUP_A2 = '00000000-0000-0000-0000-0000000ga002' as GroupModel.GroupId;

const EVENT_A1 = '00000000-0000-0000-0000-0000000ea001' as Event.EventId;
const EVENT_A2 = '00000000-0000-0000-0000-0000000ea002' as Event.EventId;
const EVENT_A3 = '00000000-0000-0000-0000-0000000ea003' as Event.EventId;
const EVENT_B1 = '00000000-0000-0000-0000-0000000eb001' as Event.EventId;

const TT_A1 = '00000000-0000-0000-0000-0000000ta001' as TrainingType.TrainingTypeId;
const TT_B1 = '00000000-0000-0000-0000-0000000tb001' as TrainingType.TrainingTypeId;

const ROSTER_A1 = '00000000-0000-0000-0000-0000000ra001' as RosterModel.RosterId;
const ROSTER_B1 = '00000000-0000-0000-0000-0000000rb001' as RosterModel.RosterId;

// --- ids added for the six database read tools (plan half 2) ---------------

const MEMBER_A2 = '00000000-0000-0000-0000-0000000a0002' as TeamMember.TeamMemberId;
const MEMBER_B1 = '00000000-0000-0000-0000-0000000b0001' as TeamMember.TeamMemberId;
const USER_2 = 'user-2' as User.UserId;

const FEE_A1 = '00000000-0000-0000-0000-0000000fa001' as Fee.FeeId;
const FEE_B1 = '00000000-0000-0000-0000-0000000fb001' as Fee.FeeId;

const PLAN_A1 = '00000000-0000-0000-0000-0000000pa001' as MembershipPlan.MembershipPlanId;
const PLAN_B1 = '00000000-0000-0000-0000-0000000pb001' as MembershipPlan.MembershipPlanId;

const LOG_A1 = '00000000-0000-0000-0000-0000000la001' as ActivityLog.ActivityLogId;
const LOG_A2 = '00000000-0000-0000-0000-0000000la002' as ActivityLog.ActivityLogId;
const LOG_B1 = '00000000-0000-0000-0000-0000000lb001' as ActivityLog.ActivityLogId;
const ACTIVITY_TYPE_A1 = '00000000-0000-0000-0000-0000000aa001' as ActivityType.ActivityTypeId;

const CZK = 'CZK' as Fee.CurrencyCode;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

interface EventOverrides {
  readonly id?: Event.EventId;
  readonly team_id?: Team.TeamId;
  readonly title?: string;
  readonly status?: Event.EventStatus;
  readonly member_group_id?: Option.Option<GroupModel.GroupId>;
  // `list_event_attendance` gates on THIS column; `list_event_rsvps` gates on `member_group_id`.
  // The two are independently settable here precisely so a test can make them disagree.
  readonly owner_group_id?: Option.Option<GroupModel.GroupId>;
}

const buildEvent = (overrides: EventOverrides = {}): EventWithDetails =>
  new EventWithDetails({
    id: overrides.id ?? EVENT_A1,
    team_id: overrides.team_id ?? TEAM_A,
    training_type_id: Option.none(),
    event_type: 'training',
    title: overrides.title ?? 'Practice',
    description: Option.none(),
    image_url: Option.none(),
    start_at: DateTime.makeUnsafe(Date.parse('2026-06-01T10:00:00.000Z')),
    end_at: Option.none(),
    location: Option.none(),
    location_url: Option.none(),
    status: overrides.status ?? 'active',
    created_by: MEMBER_A1,
    training_type_name: Option.none(),
    event_type_id: Option.none(),
    event_type_name: Option.none(),
    event_type_color: Option.none(),
    created_by_name: Option.none(),
    series_id: Option.none(),
    series_modified: false,
    owner_group_id: overrides.owner_group_id ?? Option.none(),
    owner_group_name: Option.none(),
    member_group_id: overrides.member_group_id ?? Option.none(),
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
    rsvp_lock_hours_before: Option.none(),
  });

interface MembershipOverrides {
  readonly id?: TeamMember.TeamMemberId;
  readonly team_id?: Team.TeamId;
  readonly permissions?: ReadonlyArray<Role.Permission>;
}

const buildMembership = (overrides: MembershipOverrides = {}): MembershipWithRole =>
  new MembershipWithRole({
    id: overrides.id ?? MEMBER_A1,
    team_id: overrides.team_id ?? TEAM_A,
    user_id: USER_1,
    active: true,
    role_names: ['Player'],
    permissions: overrides.permissions ?? [],
    is_profile_complete: true,
    require_complete_profile: Option.none(),
  });

const buildCtx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  teamId: TEAM_A,
  membership: buildMembership(),
  teamTimezone: 'Europe/Prague',
  canSeeGroup: () => Effect.succeed(true),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Mock repository layers
// ---------------------------------------------------------------------------

const makeEventsLayer = (rows: ReadonlyArray<EventWithDetails>) =>
  Layer.succeed(EventsRepository, {
    findEventsByTeamId: (teamId: Team.TeamId) =>
      Effect.succeed(rows.filter((r) => r.team_id === teamId)),
    findEventByIdWithDetails: (id: Event.EventId) =>
      Effect.succeed(Option.fromNullishOr(rows.find((r) => r.id === id))),
  } as never);

interface GroupRow {
  readonly id: GroupModel.GroupId;
  readonly team_id: Team.TeamId;
  readonly parent_id: Option.Option<GroupModel.GroupId>;
  readonly name: string;
  readonly emoji: Option.Option<string>;
  readonly color: Option.Option<string>;
  readonly member_count: number;
  readonly created_at: Date;
}

const buildGroupRow = (overrides: Partial<GroupRow> = {}): GroupRow => ({
  id: overrides.id ?? GROUP_A1,
  team_id: overrides.team_id ?? TEAM_A,
  parent_id: overrides.parent_id ?? Option.none(),
  name: overrides.name ?? 'Alpha Squad',
  emoji: overrides.emoji ?? Option.some('🦅'),
  color: overrides.color ?? Option.some('#ff0000'),
  member_count: overrides.member_count ?? 12,
  created_at: overrides.created_at ?? new Date('2026-01-01T00:00:00.000Z'),
});

const makeGroupsLayer = (rows: ReadonlyArray<GroupRow>) =>
  Layer.succeed(GroupsRepository, {
    findGroupsByTeamId: (teamId: Team.TeamId) =>
      Effect.succeed(rows.filter((r) => r.team_id === teamId)),
    // `create_event.propose` (`services/ai/actions.ts`) validates every referenced group id
    // in-team via this method — NOT `findGroupsByTeamId` (a different call for a different tool).
    // Reads from the SAME `rows` array so a test can seed both list_groups AND propose fixtures
    // from one call site.
    findGroupById: (id: GroupModel.GroupId) =>
      Effect.succeed(Option.fromNullishOr(rows.find((r) => r.id === id))),
  } as never);

interface TrainingTypeRow {
  readonly id: TrainingType.TrainingTypeId;
  readonly team_id: Team.TeamId;
  readonly name: string;
  readonly owner_group_name: Option.Option<string>;
  readonly member_group_name: Option.Option<string>;
  // Only consulted by `create_event.propose`'s inheritance resolution (`resolveEventGroups`) —
  // the plain `list_training_types` tool never reads these.
  readonly owner_group_id?: Option.Option<GroupModel.GroupId>;
  readonly member_group_id?: Option.Option<GroupModel.GroupId>;
}

const buildTrainingTypeRow = (overrides: Partial<TrainingTypeRow> = {}): TrainingTypeRow => ({
  id: overrides.id ?? TT_A1,
  team_id: overrides.team_id ?? TEAM_A,
  name: overrides.name ?? 'Fitness',
  owner_group_name: overrides.owner_group_name ?? Option.none(),
  member_group_name: overrides.member_group_name ?? Option.none(),
  owner_group_id: overrides.owner_group_id ?? Option.none(),
  member_group_id: overrides.member_group_id ?? Option.none(),
});

const makeTrainingTypesLayer = (rows: ReadonlyArray<TrainingTypeRow>) =>
  Layer.succeed(TrainingTypesRepository, {
    findTrainingTypesByTeamId: (teamId: Team.TeamId) =>
      Effect.succeed(rows.filter((r) => r.team_id === teamId)),
    // See `makeGroupsLayer`'s comment above — same reasoning, `create_event.propose` uses this
    // method, `list_training_types` uses `findTrainingTypesByTeamId`.
    findTrainingTypeById: (id: TrainingType.TrainingTypeId) =>
      Effect.succeed(Option.fromNullishOr(rows.find((r) => r.id === id))),
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

const buildRosterRow = (overrides: Partial<RosterRow> = {}): RosterRow => ({
  id: overrides.id ?? ROSTER_A1,
  team_id: overrides.team_id ?? TEAM_A,
  name: overrides.name ?? 'First Team',
  active: overrides.active ?? true,
  color: overrides.color ?? Option.none(),
  emoji: overrides.emoji ?? Option.none(),
  member_count: overrides.member_count ?? 18,
  created_at: overrides.created_at ?? DateTime.makeUnsafe(Date.parse('2026-01-01T00:00:00.000Z')),
  discord_channel_id: overrides.discord_channel_id ?? Option.none(),
});

const makeRostersLayer = (rows: ReadonlyArray<RosterRow>) =>
  Layer.succeed(RostersRepository, {
    findByTeamId: (teamId: Team.TeamId) => Effect.succeed(rows.filter((r) => r.team_id === teamId)),
  } as never);

interface RosterEntryOverrides {
  readonly member_id?: TeamMember.TeamMemberId;
  readonly discord_id?: Discord.Snowflake;
  readonly name?: Option.Option<string>;
  readonly avatar?: Option.Option<string>;
  readonly jersey_number?: Option.Option<number>;
  readonly active?: boolean;
  readonly user_id?: User.UserId;
  readonly username?: string;
}

const buildRosterEntry = (overrides: RosterEntryOverrides = {}): RosterEntry =>
  new RosterEntry({
    member_id: overrides.member_id ?? MEMBER_A1,
    user_id: overrides.user_id ?? USER_1,
    discord_id: overrides.discord_id ?? ('123456789012345678' as Discord.Snowflake),
    role_names: ['Player'],
    permissions: [],
    effective_roles: [],
    name: overrides.name ?? Option.some('Alice'),
    birth_date: Option.some('2000-01-01'),
    gender: Option.some('female' as User.Gender),
    jersey_number: overrides.jersey_number ?? Option.some(7),
    username: overrides.username ?? 'alice#0001',
    avatar: overrides.avatar ?? Option.some('abcd1234'),
    discord_nickname: Option.none(),
    discord_display_name: Option.none(),
    joined_at: '2024-01-01T00:00:00.000Z',
    active: overrides.active ?? true,
  });

const makeMembersLayer = (byTeam: ReadonlyMap<Team.TeamId, ReadonlyArray<RosterEntry>>) =>
  Layer.succeed(TeamMembersRepository, {
    findRosterByTeam: (teamId: string) => Effect.succeed(byTeam.get(teamId as Team.TeamId) ?? []),
    // The team-scoped single-member resolver (`TeamMembersRepository.findRosterMemberByIds`,
    // src/repositories/TeamMembersRepository.ts:565). `list_activity_logs` must route a
    // model-supplied `memberId` through THIS before it ever touches `ActivityLogsRepository`,
    // which is scoped by member id alone and knows nothing about teams.
    findRosterMemberByIds: (teamId: Team.TeamId, memberId: TeamMember.TeamMemberId) =>
      Effect.succeed(
        Option.fromNullishOr((byTeam.get(teamId) ?? []).find((m) => m.member_id === memberId)),
      ),
  } as never);

const itemsOf = (result: unknown): ReadonlyArray<Record<string, unknown>> =>
  (result as { items: ReadonlyArray<Record<string, unknown>> }).items;

// ---------------------------------------------------------------------------
// Mock repository layers for the six database read tools (plan half 2).
//
// Every one of these is a COUNTING stub: it returns `{ layer, calls }` and records the arguments
// of each call. "The result was empty" is NOT the assertion that matters for the two
// event-scoped tools — `EventRsvpsRepository.findRsvpsByEventId` and
// `EventAttendanceRepository.findAttendanceForEvent` both take an eventId ALONE and are not
// team-scoped, so an executor that calls them with an unvalidated model-supplied id has already
// read another club's rows by the time it filters. `calls` is what pins "never asked".
// ---------------------------------------------------------------------------

interface FeeRowLike {
  readonly id: Fee.FeeId;
  readonly team_id: Team.TeamId;
  readonly name: string;
  readonly description: Option.Option<string>;
  readonly amount_minor: Fee.AmountMinor;
  readonly currency: Fee.CurrencyCode;
  readonly due_at: Option.Option<DateTime.Utc>;
  readonly recurrence: 'one_off' | 'monthly';
  readonly target_scope: 'team' | 'group' | 'member';
  readonly created_at: DateTime.Utc;
  readonly updated_at: DateTime.Utc;
  readonly archived_at: Option.Option<DateTime.Utc>;
  readonly assignment_count: number;
  readonly paid_count: number;
  readonly pending_count: number;
  readonly overdue_count: number;
}

const buildFeeRow = (overrides: Partial<FeeRowLike> = {}): FeeRowLike => ({
  id: overrides.id ?? FEE_A1,
  team_id: overrides.team_id ?? TEAM_A,
  name: overrides.name ?? 'Spring membership',
  description: overrides.description ?? Option.some('Covers March to June'),
  amount_minor: (overrides.amount_minor ?? 150000) as Fee.AmountMinor,
  currency: overrides.currency ?? CZK,
  due_at: overrides.due_at ?? Option.some(DateTime.makeUnsafe(Date.parse('2026-03-01T00:00:00Z'))),
  recurrence: overrides.recurrence ?? 'one_off',
  target_scope: overrides.target_scope ?? 'team',
  created_at: overrides.created_at ?? DateTime.makeUnsafe(Date.parse('2026-01-01T00:00:00Z')),
  updated_at: overrides.updated_at ?? DateTime.makeUnsafe(Date.parse('2026-01-01T00:00:00Z')),
  archived_at: overrides.archived_at ?? Option.none(),
  assignment_count: overrides.assignment_count ?? 3,
  paid_count: overrides.paid_count ?? 1,
  pending_count: overrides.pending_count ?? 1,
  overdue_count: overrides.overdue_count ?? 1,
});

const makeFeesLayer = (rows: ReadonlyArray<FeeRowLike>) => {
  const calls: Array<Team.TeamId> = [];
  const layer = Layer.succeed(FeesRepository, {
    listByTeam: (teamId: Team.TeamId) => {
      calls.push(teamId);
      return Effect.succeed(rows.filter((r) => r.team_id === teamId));
    },
  } as never);
  return { layer, calls };
};

interface OverviewRowLike {
  readonly teamMemberId: TeamMember.TeamMemberId;
  readonly memberName: Option.Option<string>;
  readonly currency: Fee.CurrencyCode;
  readonly totalDueMinor: number;
  readonly totalPaidMinor: number;
  readonly overdueCount: number;
  readonly pendingCount: number;
  readonly paidCount: number;
  readonly creditMinor: number;
}

const buildOverviewRow = (overrides: Partial<OverviewRowLike> = {}): OverviewRowLike => ({
  teamMemberId: overrides.teamMemberId ?? MEMBER_A1,
  memberName: overrides.memberName ?? Option.some('Alice'),
  currency: overrides.currency ?? CZK,
  totalDueMinor: overrides.totalDueMinor ?? 150000,
  totalPaidMinor: overrides.totalPaidMinor ?? 50000,
  overdueCount: overrides.overdueCount ?? 1,
  pendingCount: overrides.pendingCount ?? 2,
  paidCount: overrides.paidCount ?? 3,
  creditMinor: overrides.creditMinor ?? 0,
});

const makeFinanceOverviewLayer = (
  byTeam: ReadonlyMap<Team.TeamId, ReadonlyArray<OverviewRowLike>>,
) => {
  const calls: Array<Team.TeamId> = [];
  const layer = Layer.succeed(FinanceOverviewRepository, {
    overviewByTeam: (teamId: Team.TeamId) => {
      calls.push(teamId);
      return Effect.succeed(byTeam.get(teamId) ?? []);
    },
    // `myStatus` is the OTHER overview read (`api/finance.ts`'s self-service endpoint). The spec
    // pins `overviewByTeam`; if an implementation reaches for this one instead the test must
    // notice rather than silently pass, so it dies.
    myStatus: () => Effect.die(new Error('get_finance_overview must use overviewByTeam')),
  } as never);
  return { layer, calls };
};

interface RsvpRowLike {
  readonly team_member_id: TeamMember.TeamMemberId;
  readonly response: EventRsvp.RsvpResponse;
  readonly message: Option.Option<string>;
  readonly member_name: Option.Option<string>;
  readonly username: Option.Option<string>;
  readonly nickname: Option.Option<string>;
  readonly display_name: Option.Option<string>;
}

const buildRsvpRow = (overrides: Partial<RsvpRowLike> = {}): RsvpRowLike => ({
  team_member_id: overrides.team_member_id ?? MEMBER_A1,
  response: overrides.response ?? ('yes' as EventRsvp.RsvpResponse),
  message: overrides.message ?? Option.some('Running 10 minutes late'),
  member_name: overrides.member_name ?? Option.some('Alice'),
  username: overrides.username ?? Option.some('alice#0001'),
  nickname: overrides.nickname ?? Option.none(),
  display_name: overrides.display_name ?? Option.none(),
});

const makeRsvpsLayer = (byEvent: ReadonlyMap<Event.EventId, ReadonlyArray<RsvpRowLike>>) => {
  const calls: Array<Event.EventId> = [];
  const layer = Layer.succeed(EventRsvpsRepository, {
    findRsvpsByEventId: (eventId: Event.EventId) => {
      calls.push(eventId);
      return Effect.succeed(byEvent.get(eventId) ?? []);
    },
  } as never);
  return { layer, calls };
};

interface AttendanceRowLike {
  readonly team_member_id: TeamMember.TeamMemberId;
  readonly member_name: Option.Option<string>;
  readonly nickname: Option.Option<string>;
  readonly username: Option.Option<string>;
  readonly display_name: Option.Option<string>;
  readonly rsvp_response: Option.Option<EventRsvp.RsvpResponse>;
  readonly present: boolean;
  readonly confirmed_at: Option.Option<DateTime.Utc>;
}

const buildAttendanceRow = (overrides: Partial<AttendanceRowLike> = {}): AttendanceRowLike => ({
  team_member_id: overrides.team_member_id ?? MEMBER_A1,
  member_name: overrides.member_name ?? Option.some('Alice'),
  nickname: overrides.nickname ?? Option.none(),
  username: overrides.username ?? Option.some('alice#0001'),
  display_name: overrides.display_name ?? Option.none(),
  rsvp_response: overrides.rsvp_response ?? Option.some('yes' as EventRsvp.RsvpResponse),
  present: overrides.present ?? true,
  confirmed_at:
    overrides.confirmed_at ?? Option.some(DateTime.makeUnsafe(Date.parse('2026-06-01T12:00:00Z'))),
});

const makeAttendanceLayer = (
  byEvent: ReadonlyMap<Event.EventId, ReadonlyArray<AttendanceRowLike>>,
) => {
  const calls: Array<Event.EventId> = [];
  const layer = Layer.succeed(EventAttendanceRepository, {
    findAttendanceForEvent: (eventId: Event.EventId) => {
      calls.push(eventId);
      return Effect.succeed(byEvent.get(eventId) ?? []);
    },
  } as never);
  return { layer, calls };
};

interface ActivityLogRowLike {
  readonly id: ActivityLog.ActivityLogId;
  readonly team_member_id: TeamMember.TeamMemberId;
  readonly activity_type_id: ActivityType.ActivityTypeId;
  readonly activity_type_name: string;
  readonly activity_type_emoji: Option.Option<string>;
  readonly logged_at: string;
  readonly duration_minutes: Option.Option<number>;
  readonly note: Option.Option<string>;
  readonly source: 'manual' | 'auto';
}

const buildActivityLogRow = (overrides: Partial<ActivityLogRowLike> = {}): ActivityLogRowLike => ({
  id: overrides.id ?? LOG_A1,
  team_member_id: overrides.team_member_id ?? MEMBER_A1,
  activity_type_id: overrides.activity_type_id ?? ACTIVITY_TYPE_A1,
  activity_type_name: overrides.activity_type_name ?? 'Gym',
  activity_type_emoji: overrides.activity_type_emoji ?? Option.some('🏋️'),
  logged_at: overrides.logged_at ?? '2026-05-01T18:00:00.000Z',
  duration_minutes: overrides.duration_minutes ?? Option.some(60),
  note: overrides.note ?? Option.some('Leg day'),
  source: overrides.source ?? 'manual',
});

/** Both `findByMember` and `findByTeamMember` are stubbed and share one `calls` array: the
 *  repository is scoped by MEMBER ID alone either way (src/repositories/ActivityLogsRepository.ts
 *  :159-163), so which of the two an implementation picks does not change the tenancy question —
 *  only whether a foreign member id reaches it at all. */
const makeActivityLogsLayer = (rows: ReadonlyArray<ActivityLogRowLike>) => {
  const calls: Array<TeamMember.TeamMemberId> = [];
  const forMember = (memberId: TeamMember.TeamMemberId) => {
    calls.push(memberId);
    return Effect.succeed(rows.filter((r) => r.team_member_id === memberId));
  };
  const layer = Layer.succeed(ActivityLogsRepository, {
    findByMember: forMember,
    findByTeamMember: forMember,
  } as never);
  return { layer, calls };
};

interface MembershipPlanRowLike {
  readonly id: MembershipPlan.MembershipPlanId;
  readonly team_id: Team.TeamId;
  readonly name: Option.Option<string>;
  readonly price_minor: Fee.AmountMinor;
  readonly currency: Fee.CurrencyCode;
  readonly price_per_training_minor: Fee.AmountMinor;
  readonly free_trainings_included: number;
  readonly is_default: boolean;
}

const buildMembershipPlanRow = (
  overrides: Partial<MembershipPlanRowLike> = {},
): MembershipPlanRowLike => ({
  id: overrides.id ?? PLAN_A1,
  team_id: overrides.team_id ?? TEAM_A,
  name: overrides.name ?? Option.some('Full season'),
  price_minor: (overrides.price_minor ?? 500000) as Fee.AmountMinor,
  currency: overrides.currency ?? CZK,
  price_per_training_minor: (overrides.price_per_training_minor ?? 0) as Fee.AmountMinor,
  free_trainings_included: overrides.free_trainings_included ?? 0,
  is_default: overrides.is_default ?? true,
});

const SEASONS_A = {
  current_season: Option.some({
    starts_at: DateTime.makeUnsafe(Date.parse('2026-01-01T00:00:00Z')),
    selection_deadline: Option.some(DateTime.makeUnsafe(Date.parse('2026-02-01T00:00:00Z'))),
    expires_at: Option.some(DateTime.makeUnsafe(Date.parse('2026-12-31T00:00:00Z'))),
  }),
  next_season: Option.none(),
};

const makeMembershipPlansLayer = (rows: ReadonlyArray<MembershipPlanRowLike>) => {
  const calls: Array<Team.TeamId> = [];
  const assignmentCalls: Array<Team.TeamId> = [];
  const layer = Layer.succeed(MembershipPlansRepository, {
    findMembershipPlansByTeamId: (teamId: Team.TeamId) => {
      calls.push(teamId);
      return Effect.succeed(rows.filter((r) => r.team_id === teamId));
    },
    findSeasons: () => Effect.succeed(SEASONS_A),
    // The per-member tier roster. `api/membership-plan.ts:108` returns it ONLY to a caller
    // holding `finance:manage_fees`; the tool must project it away ENTIRELY rather than
    // re-derive that rule, so this must never be reached.
    findPlanAssignments: (teamId: Team.TeamId) => {
      assignmentCalls.push(teamId);
      return Effect.succeed([
        {
          member_id: MEMBER_A1,
          membership_plan_id: Option.some(PLAN_A1),
          name: Option.some('Alice Rosterleak'),
          discord_nickname: Option.none(),
          discord_display_name: Option.none(),
          username: 'alice#0001',
        },
      ]);
    },
  } as never);
  return { layer, calls, assignmentCalls };
};

/** The keys no model-facing row from ANY tool may carry (plan "Invariants" §5). */
const PII_KEYS = [
  'email',
  'birthDate',
  'birth_date',
  'gender',
  'discordId',
  'discord_id',
  'userId',
  'user_id',
  'permissions',
];

const expectNoPii = (row: Record<string, unknown>): void => {
  const keys = Object.keys(row);
  for (const key of PII_KEYS) {
    expect(keys).not.toContain(key);
  }
};

// ---------------------------------------------------------------------------
// list_events
// ---------------------------------------------------------------------------

describe('list_events', () => {
  it.effect('returns only rows for ctx.teamId when the repository holds two teams', () =>
    Effect.gen(function* () {
      const rowA = buildEvent({ id: EVENT_A1, team_id: TEAM_A, title: 'Team A practice' });
      const rowB = buildEvent({ id: EVENT_B1, team_id: TEAM_B, title: 'Team B practice' });
      const ctx = buildCtx();
      const outcome = yield* listEvents({}, ctx).pipe(
        Effect.provide(makeEventsLayer([rowA, rowB])),
      );
      const items = itemsOf(outcome.result);
      expect(items).toHaveLength(1);
      expect(outcome.hits).toHaveLength(1);
      const [ref] = outcome.hits;
      expect(ref?.kind).toBe('event');
      if (ref?.kind === 'event') {
        expect(ref.event.eventId).toBe(EVENT_A1);
      }
    }),
  );

  it.effect(
    '(2a) no team:manage, includeAllGroups absent: an invisible-group event is excluded',
    () =>
      Effect.gen(function* () {
        const row = buildEvent({ id: EVENT_A1, member_group_id: Option.some(GROUP_A1) });
        const ctx = buildCtx({
          membership: buildMembership({ permissions: [] }),
          canSeeGroup: () => Effect.succeed(false),
        });
        const outcome = yield* listEvents({}, ctx).pipe(Effect.provide(makeEventsLayer([row])));
        expect(itemsOf(outcome.result)).toHaveLength(0);
        expect(outcome.hits).toHaveLength(0);
      }),
  );

  it.effect('(2b) no team:manage, includeAllGroups:true: still excluded', () =>
    Effect.gen(function* () {
      const row = buildEvent({ id: EVENT_A1, member_group_id: Option.some(GROUP_A1) });
      const ctx = buildCtx({
        membership: buildMembership({ permissions: [] }),
        canSeeGroup: () => Effect.succeed(false),
      });
      const outcome = yield* listEvents({ includeAllGroups: true }, ctx).pipe(
        Effect.provide(makeEventsLayer([row])),
      );
      expect(itemsOf(outcome.result)).toHaveLength(0);
    }),
  );

  it.effect(
    '(2c) team:manage held but includeAllGroups absent: still excluded — the regression the paraphrase got wrong',
    () =>
      Effect.gen(function* () {
        const row = buildEvent({ id: EVENT_A1, member_group_id: Option.some(GROUP_A1) });
        const ctx = buildCtx({
          membership: buildMembership({ permissions: ['team:manage'] }),
          canSeeGroup: () => Effect.succeed(false),
        });
        const outcome = yield* listEvents({}, ctx).pipe(Effect.provide(makeEventsLayer([row])));
        expect(itemsOf(outcome.result)).toHaveLength(0);
      }),
  );

  it.effect('(2d) team:manage AND includeAllGroups:true: included', () =>
    Effect.gen(function* () {
      const row = buildEvent({ id: EVENT_A1, member_group_id: Option.some(GROUP_A1) });
      const ctx = buildCtx({
        membership: buildMembership({ permissions: ['team:manage'] }),
        canSeeGroup: () => Effect.succeed(false),
      });
      const outcome = yield* listEvents({ includeAllGroups: true }, ctx).pipe(
        Effect.provide(makeEventsLayer([row])),
      );
      expect(itemsOf(outcome.result)).toHaveLength(1);
      expect(outcome.hits).toHaveLength(1);
    }),
  );

  it.effect(
    'memoizes canSeeGroup per request: exactly one repository call per distinct group (10 events, 2 groups)',
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const groupsRepoShape = {
          getDescendantMemberIds: (groupId: GroupModel.GroupId) => {
            calls += 1;
            return Effect.succeed(groupId === GROUP_A1 ? [MEMBER_A1] : []);
          },
        } as unknown as ServiceMap.Service.Shape<typeof GroupsRepository>;

        const canSeeGroup = makeCanSeeGroup(groupsRepoShape, MEMBER_A1);

        const rows = [
          ...Array.from({ length: 5 }, (_, i) =>
            buildEvent({
              id: `00000000-0000-0000-0000-0000000e1a${String(i).padStart(2, '0')}` as Event.EventId,
              member_group_id: Option.some(GROUP_A1),
            }),
          ),
          ...Array.from({ length: 5 }, (_, i) =>
            buildEvent({
              id: `00000000-0000-0000-0000-0000000e2a${String(i).padStart(2, '0')}` as Event.EventId,
              member_group_id: Option.some(GROUP_A2),
            }),
          ),
        ];

        const ctx = buildCtx({ canSeeGroup });
        const outcome = yield* listEvents({}, ctx).pipe(Effect.provide(makeEventsLayer(rows)));

        expect(calls).toBe(2);
        expect(itemsOf(outcome.result)).toHaveLength(5);
        expect(outcome.hits).toHaveLength(5);
      }),
  );

  it.effect('eventId in another team: not_found, never forbidden, no title leak', () =>
    Effect.gen(function* () {
      const foreignRow = buildEvent({
        id: EVENT_B1,
        team_id: TEAM_B,
        title: 'Secret Team B Event',
      });
      const ctx = buildCtx();
      const outcome = yield* listEvents({ eventId: EVENT_B1 }, ctx).pipe(
        Effect.provide(makeEventsLayer([foreignRow])),
      );
      expect(outcome.result).toEqual({ error: 'not_found' });
      expect(outcome.hits).toHaveLength(0);
      const json = JSON.stringify(outcome.result);
      expect(json).not.toContain('Secret Team B Event');
      expect(json).not.toContain('forbidden');
    }),
  );

  it.effect(
    'eventId in this team but an invisible group: not_found via the same ctx.canSeeGroup check',
    () =>
      Effect.gen(function* () {
        const row = buildEvent({
          id: EVENT_A1,
          team_id: TEAM_A,
          member_group_id: Option.some(GROUP_A1),
          title: 'Hidden Group Event',
        });
        const ctx = buildCtx({ canSeeGroup: () => Effect.succeed(false) });
        const outcome = yield* listEvents({ eventId: EVENT_A1 }, ctx).pipe(
          Effect.provide(makeEventsLayer([row])),
        );
        expect(outcome.result).toEqual({ error: 'not_found' });
        expect(outcome.hits).toHaveLength(0);
      }),
  );

  it.effect(
    "eventId path: team:manage bypasses ctx.canSeeGroup entirely, mirroring getEvent's isAdmin " +
      'skip (api/event.ts:348-356) EXACTLY — a caller who can manage the team sees the event ' +
      'regardless of its group. `includeAllGroups` plays no part in this: the eventId path ' +
      'ignores every other filter (CONCERN 6 fix — a previous draft applied ctx.canSeeGroup ' +
      'unconditionally here, STRICTER than the real getEvent endpoint for admins).',
    () =>
      Effect.gen(function* () {
        const row = buildEvent({
          id: EVENT_A1,
          team_id: TEAM_A,
          member_group_id: Option.some(GROUP_A1),
        });
        const ctx = buildCtx({
          membership: buildMembership({ permissions: ['team:manage'] }),
          canSeeGroup: () => Effect.succeed(false),
        });
        const outcome = yield* listEvents({ eventId: EVENT_A1 }, ctx).pipe(
          Effect.provide(makeEventsLayer([row])),
        );
        expect(outcome.result).not.toEqual({ error: 'not_found' });
        expect(outcome.hits).toHaveLength(1);
        const [ref] = outcome.hits;
        expect(ref?.kind).toBe('event');
        if (ref?.kind === 'event') {
          expect(ref.event.eventId).toBe(EVENT_A1);
        }
      }),
  );

  it.effect('eventId happy path: exactly one row, every other filter ignored', () =>
    Effect.gen(function* () {
      const row = buildEvent({
        id: EVENT_A1,
        team_id: TEAM_A,
        status: 'active',
        title: 'Visible Event',
      });
      const ctx = buildCtx();
      const outcome = yield* listEvents(
        {
          eventId: EVENT_A1,
          from: '2099-01-01',
          to: '2099-01-02',
          status: 'cancelled',
          query: 'nonsense',
          limit: 1,
        },
        ctx,
      ).pipe(Effect.provide(makeEventsLayer([row])));
      const items = itemsOf(outcome.result);
      expect(items).toHaveLength(1);
      expect(outcome.hits).toHaveLength(1);
      const [ref] = outcome.hits;
      expect(ref?.kind).toBe('event');
      if (ref?.kind === 'event') {
        expect(ref.event).toEqual(toEventInfo(row));
      }
    }),
  );

  it.effect(
    // Per-row token MINTING is `ChatAgent`'s job, not the executor's — a `SearchHit` carries no
    // `ref` at all (`.work-plans/command-palette-search.md` §B; `toolTypes.ts#buildListResult`'s
    // header comment; `refTokens.ts`). `ChatAgent.remapCallReferences` (`ChatAgent.ts:364-383`)
    // relies on a POSITIONAL invariant instead: `hits[i]` and `items[i]` must describe the SAME
    // row, so it can stamp token `i` onto both by index. That is what this test pins — not `ref`
    // equality (both used to be the SAME inert placeholder regardless of row, which made the old
    // `item?.ref === reference.ref` assertion here pass even if `toHit`/`toItem` were fed
    // different rows).
    'pairs each model-facing row with its SearchHit by position (same title on both)',
    () =>
      Effect.gen(function* () {
        const rows = [
          buildEvent({ id: EVENT_A1, title: 'One' }),
          buildEvent({ id: EVENT_A2, title: 'Two' }),
          buildEvent({ id: EVENT_A3, title: 'Three' }),
        ];
        const ctx = buildCtx();
        const outcome = yield* listEvents({}, ctx).pipe(Effect.provide(makeEventsLayer(rows)));

        expect(outcome.hits).toHaveLength(3);
        const items = itemsOf(outcome.result);
        expect(items).toHaveLength(3);
        for (let i = 0; i < rows.length; i += 1) {
          const hit = outcome.hits[i];
          const item = items[i];
          expect(hit?.kind).toBe('event');
          if (hit?.kind === 'event') {
            expect(hit.event).toEqual(toEventInfo(rows[i]));
            expect(item?.title).toBe(hit.event.title);
          }
        }
      }),
  );
});

// ---------------------------------------------------------------------------
// list_training_types / list_groups / list_rosters — team scoping + gates
// ---------------------------------------------------------------------------

describe('list_training_types', () => {
  it.effect('returns only rows for ctx.teamId', () =>
    Effect.gen(function* () {
      const rowA = buildTrainingTypeRow({ id: TT_A1, team_id: TEAM_A, name: 'Fitness' });
      const rowB = buildTrainingTypeRow({ id: TT_B1, team_id: TEAM_B, name: 'Tactics' });
      const ctx = buildCtx();
      const outcome = yield* listTrainingTypes({}, ctx).pipe(
        Effect.provide(makeTrainingTypesLayer([rowA, rowB])),
      );
      expect(itemsOf(outcome.result)).toHaveLength(1);
      expect(outcome.hits).toHaveLength(1);
      expect(outcome.hits[0]).toMatchObject({ kind: 'trainingType' });
    }),
  );
});

describe('list_groups', () => {
  it.effect('gated on group:manage — returns only rows for ctx.teamId when authorized', () =>
    Effect.gen(function* () {
      const rowA = buildGroupRow({ id: GROUP_A1, team_id: TEAM_A, name: 'Alpha' });
      const rowB = buildGroupRow({
        id: '00000000-0000-0000-0000-0000000gb001' as GroupModel.GroupId,
        team_id: TEAM_B,
        name: 'Bravo',
      });
      const ctx = buildCtx({ membership: buildMembership({ permissions: ['group:manage'] }) });
      const outcome = yield* listGroups({}, ctx).pipe(
        Effect.provide(makeGroupsLayer([rowA, rowB])),
      );
      expect(itemsOf(outcome.result)).toHaveLength(1);
      expect(outcome.hits).toHaveLength(1);
      expect(outcome.hits[0]).toMatchObject({ kind: 'group' });
    }),
  );

  it.effect('without group:manage: forbidden — the real endpoint gate (group.ts:60-62)', () =>
    Effect.gen(function* () {
      const ctx = buildCtx({ membership: buildMembership({ permissions: [] }) });
      const outcome = yield* listGroups({}, ctx).pipe(Effect.provide(makeGroupsLayer([])));
      expect(outcome.result).toEqual({ error: 'forbidden', permission: 'group:manage' });
      expect(outcome.hits).toHaveLength(0);
    }),
  );

  it.effect(
    'leaks no group fields and mints no references to a plain player (9b — this was a real leak in review)',
    () =>
      Effect.gen(function* () {
        const row = buildGroupRow({
          id: GROUP_A1,
          team_id: TEAM_A,
          name: 'Alpha Squad',
          emoji: Option.some('🦅'),
          color: Option.some('#ff0000'),
          member_count: 12,
        });
        const ctx = buildCtx({ membership: buildMembership({ permissions: [] }) });
        const outcome = yield* listGroups({}, ctx).pipe(Effect.provide(makeGroupsLayer([row])));

        expect(outcome.result).toEqual({ error: 'forbidden', permission: 'group:manage' });
        expect(outcome.hits).toHaveLength(0);

        const json = JSON.stringify(outcome.result);
        for (const leak of ['Alpha Squad', 'emoji', 'color', 'memberCount', '🦅', '#ff0000']) {
          expect(json).not.toContain(leak);
        }
      }),
  );
});

describe('list_rosters', () => {
  it.effect('gated on roster:view — returns only rows for ctx.teamId when authorized', () =>
    Effect.gen(function* () {
      const rowA = buildRosterRow({ id: ROSTER_A1, team_id: TEAM_A, name: 'First Team' });
      const rowB = buildRosterRow({ id: ROSTER_B1, team_id: TEAM_B, name: 'Reserves' });
      const ctx = buildCtx({ membership: buildMembership({ permissions: ['roster:view'] }) });
      const outcome = yield* listRosters({}, ctx).pipe(
        Effect.provide(makeRostersLayer([rowA, rowB])),
      );
      expect(itemsOf(outcome.result)).toHaveLength(1);
      expect(outcome.hits).toHaveLength(1);
      expect(outcome.hits[0]).toMatchObject({ kind: 'roster' });
    }),
  );

  it.effect('without roster:view: forbidden', () =>
    Effect.gen(function* () {
      const ctx = buildCtx({ membership: buildMembership({ permissions: [] }) });
      const outcome = yield* listRosters({}, ctx).pipe(Effect.provide(makeRostersLayer([])));
      expect(outcome.result).toEqual({ error: 'forbidden', permission: 'roster:view' });
      expect(outcome.hits).toHaveLength(0);
    }),
  );
});

// ---------------------------------------------------------------------------
// list_members — PII allow-list + gate
// ---------------------------------------------------------------------------

describe('list_members', () => {
  it.effect('model-facing rows carry no PII keys (Object.keys, not a spot check)', () =>
    Effect.gen(function* () {
      const entry = buildRosterEntry({ discord_id: '123456789012345678' as Discord.Snowflake });
      const ctx = buildCtx({ membership: buildMembership({ permissions: ['member:view'] }) });
      const outcome = yield* listMembers({}, ctx).pipe(
        Effect.provide(makeMembersLayer(new Map([[TEAM_A, [entry]]]))),
      );
      const items = itemsOf(outcome.result);
      expect(items).toHaveLength(1);
      const keys = Object.keys(items[0] ?? {});
      for (const forbiddenKey of [
        'discord_id',
        'discordId',
        'birth_date',
        'birthDate',
        'gender',
        'email',
        'user_id',
        'userId',
        'username',
        'permissions',
      ]) {
        expect(keys).not.toContain(forbiddenKey);
      }
    }),
  );

  it.effect('EntityRef has no discordId and a well-formed or absent avatarUrl', () =>
    Effect.gen(function* () {
      const withAvatar = buildRosterEntry({
        member_id: MEMBER_A1,
        discord_id: '999999999999999999' as Discord.Snowflake,
        avatar: Option.some('abcd1234'),
      });
      const ctx = buildCtx({ membership: buildMembership({ permissions: ['member:view'] }) });
      const outcome = yield* listMembers({}, ctx).pipe(
        Effect.provide(makeMembersLayer(new Map([[TEAM_A, [withAvatar]]]))),
      );
      const [ref] = outcome.hits;
      expect(ref?.kind).toBe('member');
      if (ref?.kind === 'member') {
        expect(Object.keys(ref)).not.toContain('discordId');
        expect(Option.isSome(ref.avatarUrl)).toBe(true);
        if (Option.isSome(ref.avatarUrl)) {
          expect(ref.avatarUrl.value).toMatch(
            /^https:\/\/cdn\.discordapp\.com\/avatars\/999999999999999999\/abcd1234\.png\?size=32$/,
          );
        }
      }
    }),
  );

  it.effect('EntityRef.avatarUrl is None when the member has no avatar', () =>
    Effect.gen(function* () {
      const noAvatar = buildRosterEntry({ avatar: Option.none() });
      const ctx = buildCtx({ membership: buildMembership({ permissions: ['member:view'] }) });
      const outcome = yield* listMembers({}, ctx).pipe(
        Effect.provide(makeMembersLayer(new Map([[TEAM_A, [noAvatar]]]))),
      );
      const [ref] = outcome.hits;
      if (ref?.kind === 'member') {
        expect(Option.isNone(ref.avatarUrl)).toBe(true);
      }
    }),
  );

  it.effect('without member:view: forbidden', () =>
    Effect.gen(function* () {
      const ctx = buildCtx({ membership: buildMembership({ permissions: [] }) });
      const outcome = yield* listMembers({}, ctx).pipe(Effect.provide(makeMembersLayer(new Map())));
      expect(outcome.result).toEqual({ error: 'forbidden', permission: 'member:view' });
      expect(outcome.hits).toHaveLength(0);
    }),
  );
});

// ===========================================================================
// The six database read tools — plan `.dev-loop/plan.md` half 2 / `.dev-loop/spec.md`.
//
// Gates, verified against the handlers they mirror:
//   list_fees                finance:view            api/finance.ts:184
//   get_finance_overview     finance:view            api/finance.ts:376
//   list_event_rsvps         membership + canSeeGroup(event.member_group_id)   api/event-rsvp.ts:154
//   list_event_attendance    membership + canSeeGroup(event.owner_group_id)    api/event-attendance.ts:61
//   list_activity_logs       membership only         api/activity-logs.ts:35
//   list_membership_plans    membership only, roster projected away   api/membership-plan.ts:108
//
// Every forbidden-path case below calls the EXECUTOR directly. `visibleTools(ctx)` hiding the
// tool is NOT the boundary: `dispatchOneCall` (`ChatAgent.ts`) resolves every call against the
// full `ALL_TOOLS` catalogue regardless of what this turn's `tools` array contained, and the
// PROVIDER can emit a call that was never offered.
// ===========================================================================

const canSeeOnlyGroup =
  (visible: GroupModel.GroupId) => (groupId: Option.Option<GroupModel.GroupId>) =>
    Effect.succeed(Option.match(groupId, { onNone: () => true, onSome: (id) => id === visible }));

// ---------------------------------------------------------------------------
// list_fees — finance:view
// ---------------------------------------------------------------------------

describe('list_fees', () => {
  it.effect(
    'EXECUTOR refuses a caller without finance:view — forbidden, repository never queried, no fee name leaked',
    () =>
      Effect.gen(function* () {
        const fees = makeFeesLayer([buildFeeRow({ name: 'Spring membership' })]);
        const ctx = buildCtx({ membership: buildMembership({ permissions: [] }) });
        const outcome = yield* listFees({}, ctx).pipe(Effect.provide(fees.layer));

        expect(outcome.result).toEqual({ error: 'forbidden', permission: 'finance:view' });
        expect(outcome.hits).toEqual([]);
        expect(fees.calls).toEqual([]);
        expect(JSON.stringify(outcome.result)).not.toContain('Spring membership');
      }),
  );

  it.effect('with finance:view: scoped to ctx.teamId, never another team', () =>
    Effect.gen(function* () {
      const fees = makeFeesLayer([
        buildFeeRow({ id: FEE_A1, team_id: TEAM_A, name: 'Team A dues' }),
        buildFeeRow({ id: FEE_B1, team_id: TEAM_B, name: 'Team B dues' }),
      ]);
      const ctx = buildCtx({ membership: buildMembership({ permissions: ['finance:view'] }) });
      const outcome = yield* listFees({}, ctx).pipe(Effect.provide(fees.layer));

      expect(fees.calls).toEqual([TEAM_A]);
      const items = itemsOf(outcome.result);
      expect(items).toHaveLength(1);
      expect(JSON.stringify(outcome.result)).not.toContain('Team B dues');
    }),
  );

  it.effect('model-facing row carries no PII and no raw ids', () =>
    Effect.gen(function* () {
      const fees = makeFeesLayer([buildFeeRow({ id: FEE_A1 })]);
      const ctx = buildCtx({ membership: buildMembership({ permissions: ['finance:view'] }) });
      const outcome = yield* listFees({}, ctx).pipe(Effect.provide(fees.layer));

      const [item] = itemsOf(outcome.result);
      expect(item).toBeDefined();
      expectNoPii(item ?? {});
      expect(item?.name).toBe('Spring membership');
      expect(item?.amountMinor).toBe(150000);
      expect(item?.currency).toBe('CZK');
      // No reference cards for the new tools (`.dev-loop/spec.md`: no new `SearchHit` kind).
      expect(outcome.hits).toEqual([]);
    }),
  );
});

// ---------------------------------------------------------------------------
// get_finance_overview — finance:view
// ---------------------------------------------------------------------------

describe('get_finance_overview', () => {
  it.effect(
    'EXECUTOR refuses a caller without finance:view — forbidden, repository never queried, no member name leaked',
    () =>
      Effect.gen(function* () {
        const overview = makeFinanceOverviewLayer(
          new Map([[TEAM_A, [buildOverviewRow({ memberName: Option.some('Alice') })]]]),
        );
        const ctx = buildCtx({ membership: buildMembership({ permissions: [] }) });
        const outcome = yield* getFinanceOverview({}, ctx).pipe(Effect.provide(overview.layer));

        expect(outcome.result).toEqual({ error: 'forbidden', permission: 'finance:view' });
        expect(outcome.hits).toEqual([]);
        expect(overview.calls).toEqual([]);
        expect(JSON.stringify(outcome.result)).not.toContain('Alice');
      }),
  );

  it.effect(
    'with finance:view: overviewByTeam called with ctx.teamId, rows projected per spec',
    () =>
      Effect.gen(function* () {
        const overview = makeFinanceOverviewLayer(
          new Map([
            [TEAM_A, [buildOverviewRow({ memberName: Option.some('Alice') })]],
            [TEAM_B, [buildOverviewRow({ memberName: Option.some('Bob of Team B') })]],
          ]),
        );
        const ctx = buildCtx({ membership: buildMembership({ permissions: ['finance:view'] }) });
        const outcome = yield* getFinanceOverview({}, ctx).pipe(Effect.provide(overview.layer));

        expect(overview.calls).toEqual([TEAM_A]);
        const [item] = itemsOf(outcome.result);
        expect(item).toBeDefined();
        expectNoPii(item ?? {});
        expect(item?.memberName).toBe('Alice');
        expect(item?.totalDueMinor).toBe(150000);
        expect(item?.totalPaidMinor).toBe(50000);
        expect(item?.overdueCount).toBe(1);
        expect(item?.pendingCount).toBe(2);
        expect(item?.paidCount).toBe(3);
        expect(item?.creditMinor).toBe(0);
        expect(JSON.stringify(outcome.result)).not.toContain('Bob of Team B');
        expect(outcome.hits).toEqual([]);
      }),
  );
});

// ---------------------------------------------------------------------------
// list_membership_plans — membership only, roster PROJECTED AWAY
// ---------------------------------------------------------------------------

describe('list_membership_plans', () => {
  it.effect('membership-only: a caller holding zero permissions still gets the plans', () =>
    Effect.gen(function* () {
      const plans = makeMembershipPlansLayer([buildMembershipPlanRow({ id: PLAN_A1 })]);
      const ctx = buildCtx({ membership: buildMembership({ permissions: [] }) });
      const outcome = yield* listMembershipPlans({}, ctx).pipe(Effect.provide(plans.layer));

      expect(outcome.result).not.toMatchObject({ error: 'forbidden' });
      expect(itemsOf(outcome.result)).toHaveLength(1);
      expect(plans.calls).toEqual([TEAM_A]);
    }),
  );

  it.effect('scoped to ctx.teamId — another team’s plan never appears', () =>
    Effect.gen(function* () {
      const plans = makeMembershipPlansLayer([
        buildMembershipPlanRow({ id: PLAN_A1, team_id: TEAM_A, name: Option.some('Team A plan') }),
        buildMembershipPlanRow({ id: PLAN_B1, team_id: TEAM_B, name: Option.some('Team B plan') }),
      ]);
      const ctx = buildCtx();
      const outcome = yield* listMembershipPlans({}, ctx).pipe(Effect.provide(plans.layer));

      expect(itemsOf(outcome.result)).toHaveLength(1);
      expect(JSON.stringify(outcome.result)).not.toContain('Team B plan');
    }),
  );

  it.effect(
    'PRIVACY: the per-member roster is projected away even for a caller holding finance:manage_fees — findPlanAssignments is NEVER called',
    () =>
      Effect.gen(function* () {
        const plans = makeMembershipPlansLayer([buildMembershipPlanRow({ id: PLAN_A1 })]);
        const ctx = buildCtx({
          membership: buildMembership({
            permissions: ['finance:view', 'finance:manage_fees', 'member:view', 'team:manage'],
          }),
        });
        const outcome = yield* listMembershipPlans({}, ctx).pipe(Effect.provide(plans.layer));

        expect(plans.assignmentCalls).toEqual([]);
        const json = JSON.stringify(outcome.result);
        expect(json).not.toContain('Alice Rosterleak');
        expect(json).not.toContain('alice#0001');
        for (const rosterKey of ['assignments', 'members', 'roster', 'memberId', 'member_id']) {
          expect(json).not.toContain(rosterKey);
        }
      }),
  );

  it.effect('carries the team seasons and no PII', () =>
    Effect.gen(function* () {
      const plans = makeMembershipPlansLayer([buildMembershipPlanRow({ id: PLAN_A1 })]);
      const ctx = buildCtx();
      const outcome = yield* listMembershipPlans({}, ctx).pipe(Effect.provide(plans.layer));

      const [item] = itemsOf(outcome.result);
      expect(item).toBeDefined();
      expectNoPii(item ?? {});
      expect(item?.name).toBe('Full season');
      expect(item?.priceMinor).toBe(500000);
      expect(item?.currency).toBe('CZK');
      expect((outcome.result as { seasons?: unknown }).seasons).toBeDefined();
      expect(outcome.hits).toEqual([]);
    }),
  );
});

// ---------------------------------------------------------------------------
// list_activity_logs — membership only; self-scoped by default
// ---------------------------------------------------------------------------

describe('list_activity_logs', () => {
  it.effect(
    'no memberId: scopes to ctx.membership.id — NOT the whole team (a teammate’s log never appears)',
    () =>
      Effect.gen(function* () {
        const logs = makeActivityLogsLayer([
          buildActivityLogRow({ id: LOG_A1, team_member_id: MEMBER_A1, note: Option.some('Mine') }),
          buildActivityLogRow({
            id: LOG_A2,
            team_member_id: MEMBER_A2,
            note: Option.some('Teammate secret'),
          }),
        ]);
        const members = makeMembersLayer(
          new Map([
            [
              TEAM_A,
              [
                buildRosterEntry({ member_id: MEMBER_A1, name: Option.some('Alice') }),
                buildRosterEntry({
                  member_id: MEMBER_A2,
                  user_id: USER_2,
                  name: Option.some('Bob'),
                  discord_id: '222222222222222222' as Discord.Snowflake,
                }),
              ],
            ],
          ]),
        );
        const ctx = buildCtx({ membership: buildMembership({ id: MEMBER_A1, permissions: [] }) });
        const outcome = yield* listActivityLogs({}, ctx).pipe(
          Effect.provide(Layer.mergeAll(logs.layer, members)),
        );

        expect(logs.calls).toEqual([MEMBER_A1]);
        expect(itemsOf(outcome.result)).toHaveLength(1);
        expect(JSON.stringify(outcome.result)).not.toContain('Teammate secret');
      }),
  );

  it.effect(
    'TENANCY: a memberId from another team returns not_found and the logs repository is NEVER called with it',
    () =>
      Effect.gen(function* () {
        const logs = makeActivityLogsLayer([
          buildActivityLogRow({
            id: LOG_B1,
            team_member_id: MEMBER_B1,
            note: Option.some('Another club’s training'),
          }),
        ]);
        const members = makeMembersLayer(
          new Map([
            [TEAM_A, [buildRosterEntry({ member_id: MEMBER_A1 })]],
            [
              TEAM_B,
              [
                buildRosterEntry({
                  member_id: MEMBER_B1,
                  user_id: USER_2,
                  name: Option.some('Foreign Member'),
                  discord_id: '333333333333333333' as Discord.Snowflake,
                }),
              ],
            ],
          ]),
        );
        const ctx = buildCtx();
        const outcome = yield* listActivityLogs({ memberId: MEMBER_B1 }, ctx).pipe(
          Effect.provide(Layer.mergeAll(logs.layer, members)),
        );

        expect(logs.calls).toEqual([]);
        expect(outcome.result).toEqual({ error: 'not_found' });
        expect(outcome.hits).toEqual([]);
        expect(JSON.stringify(outcome.result)).not.toContain('forbidden');
      }),
  );

  it.effect('model-facing row shape, no PII', () =>
    Effect.gen(function* () {
      const logs = makeActivityLogsLayer([
        buildActivityLogRow({ id: LOG_A1, team_member_id: MEMBER_A1 }),
      ]);
      const members = makeMembersLayer(
        new Map([
          [TEAM_A, [buildRosterEntry({ member_id: MEMBER_A1, name: Option.some('Alice') })]],
        ]),
      );
      const ctx = buildCtx({ membership: buildMembership({ id: MEMBER_A1, permissions: [] }) });
      const outcome = yield* listActivityLogs({}, ctx).pipe(
        Effect.provide(Layer.mergeAll(logs.layer, members)),
      );

      const [item] = itemsOf(outcome.result);
      expect(item).toBeDefined();
      expectNoPii(item ?? {});
      expect(item?.displayName).toBe('Alice');
      expect(item?.activityTypeName).toBe('Gym');
      expect(item?.durationMinutes).toBe(60);
      expect(item?.note).toBe('Leg day');
      expect(outcome.hits).toEqual([]);
    }),
  );
});

// ---------------------------------------------------------------------------
// list_event_rsvps — membership + canSeeGroup(event.MEMBER_group_id)
// ---------------------------------------------------------------------------

describe('list_event_rsvps', () => {
  it.effect(
    'TENANCY: an eventId belonging to another team returns not_found and findRsvpsByEventId is NEVER called',
    () =>
      Effect.gen(function* () {
        const foreignEvent = buildEvent({
          id: EVENT_B1,
          team_id: TEAM_B,
          title: 'Secret Team B Event',
        });
        const rsvps = makeRsvpsLayer(
          new Map([[EVENT_B1, [buildRsvpRow({ member_name: Option.some('Foreign Player') })]]]),
        );
        const ctx = buildCtx();
        const outcome = yield* listEventRsvps({ eventId: EVENT_B1 }, ctx).pipe(
          Effect.provide(Layer.mergeAll(makeEventsLayer([foreignEvent]), rsvps.layer)),
        );

        // Not "the result was empty" — the repository is scoped by eventId ALONE, so the only
        // safe assertion is that it was never asked.
        expect(rsvps.calls).toEqual([]);
        expect(outcome.result).toEqual({ error: 'not_found' });
        expect(outcome.hits).toEqual([]);
        const json = JSON.stringify(outcome.result);
        expect(json).not.toContain('forbidden');
        expect(json).not.toContain('Foreign Player');
      }),
  );

  it.effect(
    'an event in an invisible member group returns not_found, repository never called',
    () =>
      Effect.gen(function* () {
        const event = buildEvent({ id: EVENT_A1, member_group_id: Option.some(GROUP_A1) });
        const rsvps = makeRsvpsLayer(new Map([[EVENT_A1, [buildRsvpRow({})]]]));
        const ctx = buildCtx({ canSeeGroup: () => Effect.succeed(false) });
        const outcome = yield* listEventRsvps({ eventId: EVENT_A1 }, ctx).pipe(
          Effect.provide(Layer.mergeAll(makeEventsLayer([event]), rsvps.layer)),
        );

        expect(rsvps.calls).toEqual([]);
        expect(outcome.result).toEqual({ error: 'not_found' });
      }),
  );

  it.effect(
    'COLUMN GATE: gates on member_group_id — visible member group + INVISIBLE owner group still returns rows',
    () =>
      Effect.gen(function* () {
        // If an implementation reads `owner_group_id` here (the attendance column), this event
        // gates on GROUP_A2, which the caller cannot see, and the test goes red.
        const event = buildEvent({
          id: EVENT_A2,
          member_group_id: Option.some(GROUP_A1),
          owner_group_id: Option.some(GROUP_A2),
        });
        const rsvps = makeRsvpsLayer(
          new Map([[EVENT_A2, [buildRsvpRow({ member_name: Option.some('Alice') })]]]),
        );
        const ctx = buildCtx({ canSeeGroup: canSeeOnlyGroup(GROUP_A1) });
        const outcome = yield* listEventRsvps({ eventId: EVENT_A2 }, ctx).pipe(
          Effect.provide(Layer.mergeAll(makeEventsLayer([event]), rsvps.layer)),
        );

        expect(rsvps.calls).toEqual([EVENT_A2]);
        expect(itemsOf(outcome.result)).toHaveLength(1);
      }),
  );

  it.effect(
    'COLUMN GATE (mirror): INVISIBLE member group + visible owner group returns not_found',
    () =>
      Effect.gen(function* () {
        const event = buildEvent({
          id: EVENT_A3,
          member_group_id: Option.some(GROUP_A2),
          owner_group_id: Option.some(GROUP_A1),
        });
        const rsvps = makeRsvpsLayer(new Map([[EVENT_A3, [buildRsvpRow({})]]]));
        const ctx = buildCtx({ canSeeGroup: canSeeOnlyGroup(GROUP_A1) });
        const outcome = yield* listEventRsvps({ eventId: EVENT_A3 }, ctx).pipe(
          Effect.provide(Layer.mergeAll(makeEventsLayer([event]), rsvps.layer)),
        );

        expect(rsvps.calls).toEqual([]);
        expect(outcome.result).toEqual({ error: 'not_found' });
      }),
  );

  it.effect('model-facing row is { displayName, response, message } and carries no PII', () =>
    Effect.gen(function* () {
      const event = buildEvent({ id: EVENT_A1 });
      const rsvps = makeRsvpsLayer(
        new Map([
          [
            EVENT_A1,
            [
              buildRsvpRow({
                member_name: Option.some('Alice'),
                response: 'yes' as EventRsvp.RsvpResponse,
                message: Option.some('Running 10 minutes late'),
              }),
            ],
          ],
        ]),
      );
      const ctx = buildCtx({ membership: buildMembership({ permissions: [] }) });
      const outcome = yield* listEventRsvps({ eventId: EVENT_A1 }, ctx).pipe(
        Effect.provide(Layer.mergeAll(makeEventsLayer([event]), rsvps.layer)),
      );

      const [item] = itemsOf(outcome.result);
      expect(item).toBeDefined();
      expectNoPii(item ?? {});
      expect(Object.keys(item ?? {}).sort()).toEqual(['displayName', 'message', 'response']);
      expect(item?.displayName).toBe('Alice');
      expect(item?.response).toBe('yes');
      expect(outcome.hits).toEqual([]);
    }),
  );
});

// ---------------------------------------------------------------------------
// list_event_attendance — membership + canSeeGroup(event.OWNER_group_id)
//
// `EventAttendanceRepository.findAttendanceForEvent` takes an eventId ALONE and is NOT
// team-scoped (src/repositories/EventAttendanceRepository.ts:176). The event lookup through
// `EventsRepository`, scoped to `ctx.teamId`, is the ONLY thing between the model and another
// club's attendance sheet.
// ---------------------------------------------------------------------------

describe('list_event_attendance', () => {
  it.effect(
    'TENANCY: an eventId belonging to another team returns not_found and findAttendanceForEvent is NEVER called',
    () =>
      Effect.gen(function* () {
        const foreignEvent = buildEvent({
          id: EVENT_B1,
          team_id: TEAM_B,
          title: 'Secret Team B Event',
        });
        const attendance = makeAttendanceLayer(
          new Map([
            [EVENT_B1, [buildAttendanceRow({ member_name: Option.some('Foreign Player') })]],
          ]),
        );
        const ctx = buildCtx();
        const outcome = yield* listEventAttendance({ eventId: EVENT_B1 }, ctx).pipe(
          Effect.provide(Layer.mergeAll(makeEventsLayer([foreignEvent]), attendance.layer)),
        );

        expect(attendance.calls).toEqual([]);
        expect(outcome.result).toEqual({ error: 'not_found' });
        expect(outcome.hits).toEqual([]);
        const json = JSON.stringify(outcome.result);
        expect(json).not.toContain('forbidden');
        expect(json).not.toContain('Foreign Player');
      }),
  );

  it.effect('an unknown eventId returns not_found and the repository is never called', () =>
    Effect.gen(function* () {
      const attendance = makeAttendanceLayer(new Map());
      const ctx = buildCtx();
      const outcome = yield* listEventAttendance({ eventId: EVENT_B1 }, ctx).pipe(
        Effect.provide(Layer.mergeAll(makeEventsLayer([]), attendance.layer)),
      );

      expect(attendance.calls).toEqual([]);
      expect(outcome.result).toEqual({ error: 'not_found' });
    }),
  );

  it.effect(
    'COLUMN GATE: gates on owner_group_id — visible owner group + INVISIBLE member group still returns rows',
    () =>
      Effect.gen(function* () {
        const event = buildEvent({
          id: EVENT_A3,
          member_group_id: Option.some(GROUP_A2),
          owner_group_id: Option.some(GROUP_A1),
        });
        const attendance = makeAttendanceLayer(
          new Map([[EVENT_A3, [buildAttendanceRow({ member_name: Option.some('Alice') })]]]),
        );
        const ctx = buildCtx({ canSeeGroup: canSeeOnlyGroup(GROUP_A1) });
        const outcome = yield* listEventAttendance({ eventId: EVENT_A3 }, ctx).pipe(
          Effect.provide(Layer.mergeAll(makeEventsLayer([event]), attendance.layer)),
        );

        expect(attendance.calls).toEqual([EVENT_A3]);
        expect(itemsOf(outcome.result)).toHaveLength(1);
      }),
  );

  it.effect(
    'COLUMN GATE (mirror): INVISIBLE owner group + visible member group returns not_found',
    () =>
      Effect.gen(function* () {
        const event = buildEvent({
          id: EVENT_A2,
          member_group_id: Option.some(GROUP_A1),
          owner_group_id: Option.some(GROUP_A2),
        });
        const attendance = makeAttendanceLayer(new Map([[EVENT_A2, [buildAttendanceRow({})]]]));
        const ctx = buildCtx({ canSeeGroup: canSeeOnlyGroup(GROUP_A1) });
        const outcome = yield* listEventAttendance({ eventId: EVENT_A2 }, ctx).pipe(
          Effect.provide(Layer.mergeAll(makeEventsLayer([event]), attendance.layer)),
        );

        expect(attendance.calls).toEqual([]);
        expect(outcome.result).toEqual({ error: 'not_found' });
      }),
  );

  it.effect('model-facing row is { displayName, present } and carries no PII', () =>
    Effect.gen(function* () {
      const event = buildEvent({ id: EVENT_A1 });
      const attendance = makeAttendanceLayer(
        new Map([
          [EVENT_A1, [buildAttendanceRow({ member_name: Option.some('Alice'), present: true })]],
        ]),
      );
      const ctx = buildCtx({ membership: buildMembership({ permissions: [] }) });
      const outcome = yield* listEventAttendance({ eventId: EVENT_A1 }, ctx).pipe(
        Effect.provide(Layer.mergeAll(makeEventsLayer([event]), attendance.layer)),
      );

      const [item] = itemsOf(outcome.result);
      expect(item).toBeDefined();
      expectNoPii(item ?? {});
      expect(Object.keys(item ?? {}).sort()).toEqual(['displayName', 'present']);
      expect(item?.displayName).toBe('Alice');
      expect(item?.present).toBe(true);
      expect(outcome.hits).toEqual([]);
    }),
  );
});

// ---------------------------------------------------------------------------
// visibleTools + registry parity + current_datetime wiring
// ---------------------------------------------------------------------------

describe('visibleTools', () => {
  it.effect(
    'omits group:manage/member:view/roster:view-gated tools for a bare player, includes them for an admin',
    () =>
      Effect.sync(() => {
        const player = buildCtx({ membership: buildMembership({ permissions: [] }) });
        const admin = buildCtx({
          membership: buildMembership({
            permissions: ['member:view', 'roster:view', 'group:manage', 'team:manage'],
          }),
        });

        const playerNames = visibleTools(player).map((t) => t.name);
        const adminNames = visibleTools(admin).map((t) => t.name);

        expect(playerNames).not.toContain('list_members');
        expect(playerNames).not.toContain('list_rosters');
        expect(playerNames).not.toContain('list_groups');
        expect(playerNames).not.toContain('propose_create_event');
        // Neither fixture holds `finance:view`.
        expect(playerNames).not.toContain('list_fees');
        expect(playerNames).not.toContain('get_finance_overview');
        expect([...playerNames].sort()).toEqual([
          'current_datetime',
          'list_activity_logs',
          'list_event_attendance',
          'list_event_rsvps',
          'list_events',
          'list_membership_plans',
          'list_training_types',
          'search_docs',
        ]);

        // Neither fixture holds `event:create` — `propose_create_event` is built FROM the
        // registry (`registry.ts`) with permission `ACTION_REGISTRY.create_event.permission`,
        // gated independently of `team:manage`/`group:manage`.
        expect(adminNames).not.toContain('propose_create_event');
        expect([...adminNames].sort()).toEqual([
          'current_datetime',
          'list_activity_logs',
          'list_event_attendance',
          'list_event_rsvps',
          'list_events',
          'list_groups',
          'list_members',
          'list_membership_plans',
          'list_rosters',
          'list_training_types',
          'search_docs',
        ]);
      }),
  );

  it.effect('includes propose_create_event only for a caller holding event:create', () =>
    Effect.sync(() => {
      const creator = buildCtx({
        membership: buildMembership({ permissions: ['event:create'] }),
      });
      const names = visibleTools(creator).map((t) => t.name);
      expect(names).toContain('propose_create_event');
    }),
  );

  it.effect('includes the finance:view tools only for a caller holding finance:view', () =>
    Effect.sync(() => {
      const treasurer = buildCtx({
        membership: buildMembership({ permissions: ['finance:view'] }),
      });
      const names = visibleTools(treasurer).map((t) => t.name);
      expect(names).toContain('list_fees');
      expect(names).toContain('get_finance_overview');
    }),
  );

  it.effect('search_docs is UNGATED — offered to a caller holding zero permissions', () =>
    Effect.sync(() => {
      const player = buildCtx({ membership: buildMembership({ permissions: [] }) });
      expect(visibleTools(player).map((t) => t.name)).toContain('search_docs');
      const def = ALL_TOOLS.find((t) => t.name === 'search_docs');
      expect(def).toBeDefined();
      expect(Option.isNone(def?.requiredPermission ?? Option.some('team:manage'))).toBe(true);
    }),
  );
});

describe('ALL_TOOLS — registry / JSON Schema invariants (parameterized, §13.3/10)', () => {
  it.effect('every tool has a well-formed, unique, flat, additionalProperties:false schema', () =>
    Effect.sync(() => {
      // 13 read tools (the original 6, plus `search_docs` and the six database read tools of
      // `.dev-loop/plan.md`) + 1 `propose_<action>` per `ACTION_REGISTRY` entry (currently just
      // `propose_create_event`) — built FROM the registry (`registry.ts`), so this count moves
      // in lockstep with `AiActionName.literals`.
      expect(ALL_TOOLS.length).toBe(14);
      expect(ALL_TOOLS.map((t) => t.name)).toContain('propose_create_event');
      for (const added of [
        'search_docs',
        'list_fees',
        'get_finance_overview',
        'list_event_rsvps',
        'list_event_attendance',
        'list_activity_logs',
        'list_membership_plans',
      ]) {
        expect(ALL_TOOLS.map((t) => t.name)).toContain(added);
      }
      const seenNames = new Set<string>();
      for (const tool of ALL_TOOLS) {
        expect((tool.parameters as Record<string, unknown>).additionalProperties).toBe(false);

        const json = JSON.stringify(tool.parameters);
        expect(json).not.toContain('NaN');
        expect(json).not.toContain('anyOf');
        expect(json).not.toContain('allOf');

        const properties =
          ((tool.parameters as Record<string, unknown>).properties as
            | Record<string, unknown>
            | undefined) ?? {};
        const required =
          ((tool.parameters as Record<string, unknown>).required as
            | ReadonlyArray<string>
            | undefined) ?? [];
        for (const key of required) {
          expect(Object.keys(properties)).toContain(key);
        }

        expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(seenNames.has(tool.name)).toBe(false);
        seenNames.add(tool.name);

        expect(tool.description.length).toBeGreaterThan(0);
      }
    }),
  );

  it.effect(
    'no drift: every tool.parameters is exactly toToolParameters(tool.schema), recomputed independently',
    () =>
      Effect.sync(() => {
        for (const tool of ALL_TOOLS) {
          const recomputed = toToolParameters(tool.schema);
          expect(tool.parameters).toEqual(recomputed);
        }
      }),
  );

  it.effect(
    // `registry.ts`'s header states it as a doc contract; nothing asserted it. The team, the
    // caller's permissions and the team's timezone all come from `ToolContext`, resolved in
    // `api/ai-chat.ts` BEFORE the model runs — the model must have no vocabulary in which to
    // name another team. One `teamId` parameter on one tool undoes every cross-team test above.
    'no tool parameter schema contains a teamId (or team_id) field, anywhere in the derived JSON Schema',
    () =>
      Effect.sync(() => {
        for (const tool of ALL_TOOLS) {
          const properties =
            ((tool.parameters as Record<string, unknown>).properties as
              | Record<string, unknown>
              | undefined) ?? {};
          expect(Object.keys(properties)).not.toContain('teamId');
          expect(Object.keys(properties)).not.toContain('team_id');
          // Nested too — a `Schema.Struct` parameter would hide it from the flat key check.
          const json = JSON.stringify(tool.parameters);
          expect(json).not.toContain('teamId');
          expect(json).not.toContain('team_id');
        }
      }),
  );
});

describe('current_datetime (tool wiring — see ai/currentDatetime.test.ts for the full zone table)', () => {
  it.effect('returns the team-zoned snapshot with no references, gated only on membership', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(new Date('2026-01-15T12:00:00.000Z').getTime());
      const ctx = buildCtx({ teamTimezone: 'Europe/Prague' });
      const outcome = yield* currentDatetime({}, ctx);
      expect(outcome.hits).toHaveLength(0);
      const result = outcome.result as {
        teamTimezone: string;
        todayTeamLocal: string;
        utcOffsetMinutes: number;
      };
      expect(result.teamTimezone).toBe('Europe/Prague');
      expect(result.todayTeamLocal).toBe('2026-01-15');
      expect(result.utcOffsetMinutes).toBe(60);
    }),
  );
});

// ---------------------------------------------------------------------------
// propose_create_event — `writeTools.ts#proposeAction` + `actions.ts#proposeCreateEvent`.
// plan §16 / §3.
// ---------------------------------------------------------------------------

const makeProposalsLayer = () => {
  const inserted: Array<{
    readonly team_id: Team.TeamId;
    readonly user_id: unknown;
    readonly action: string;
    readonly payload_json: string;
  }> = [];
  let seq = 0;
  const layer = Layer.succeed(AiActionProposalsRepository, {
    insert: (params: (typeof inserted)[number]) => {
      seq += 1;
      inserted.push(params);
      return Effect.succeed({
        id: `00000000-0000-1000-8000-${String(seq).padStart(12, '0')}` as never,
        expires_at: DateTime.add(DateTime.nowUnsafe(), { minutes: 15 }),
      });
    },
    lockForConfirm: () => Effect.die(new Error('unused in aiTools.test.ts')),
    claim: () => Effect.die(new Error('unused in aiTools.test.ts')),
    deleteForUser: () => Effect.die(new Error('unused in aiTools.test.ts')),
  } as never);
  return { layer, inserted };
};

const CREATOR_CTX_OVERRIDES = { permissions: ['event:create' as Role.Permission] };

const minimalCreateEventArgs = (overrides: Record<string, unknown> = {}) => ({
  title: 'AI Practice',
  eventType: 'training',
  startAt: '2026-06-01T10:00:00.000Z',
  ...overrides,
});

const runPropose = (
  rawArgs: unknown,
  ctx: ToolContext,
  fixtures: {
    readonly groups?: ReadonlyArray<GroupRow>;
    readonly trainingTypes?: ReadonlyArray<TrainingTypeRow>;
    readonly proposals?: ReturnType<typeof makeProposalsLayer>;
  } = {},
) => {
  const proposals = fixtures.proposals ?? makeProposalsLayer();
  return proposeAction('create_event', rawArgs, ctx).pipe(
    Effect.provide(
      Layer.mergeAll(
        makeGroupsLayer(fixtures.groups ?? []),
        makeTrainingTypesLayer(fixtures.trainingTypes ?? []),
        proposals.layer,
      ),
    ),
  );
};

describe('propose_create_event (writeTools.ts#proposeAction)', () => {
  it.effect(
    'caller without event:create -> {error:"forbidden",permission:"event:create"}, no row inserted',
    () =>
      Effect.gen(function* () {
        const proposals = makeProposalsLayer();
        const outcome = yield* runPropose(minimalCreateEventArgs(), buildCtx(), { proposals });
        expect(outcome.result).toEqual({ error: 'forbidden', permission: 'event:create' });
        expect(outcome.hits).toEqual([]);
        expect(proposals.inserted).toHaveLength(0);
      }),
  );

  it.effect('ownerGroupId from another team -> invalid_arguments, no insert', () =>
    Effect.gen(function* () {
      const foreignGroup = buildGroupRow({ id: GROUP_A1, team_id: TEAM_B });
      const proposals = makeProposalsLayer();
      const ctx = buildCtx({ membership: buildMembership(CREATOR_CTX_OVERRIDES) });
      const outcome = yield* runPropose(minimalCreateEventArgs({ ownerGroupId: GROUP_A1 }), ctx, {
        groups: [foreignGroup],
        proposals,
      });
      expect(outcome.result).toEqual({
        error: 'invalid_arguments',
        detail: 'ownerGroupId: no such group in this team',
      });
      expect(proposals.inserted).toHaveLength(0);
    }),
  );

  it.effect(
    'memberGroupId from another team -> invalid_arguments, no insert (separately from ownerGroupId)',
    () =>
      Effect.gen(function* () {
        const foreignGroup = buildGroupRow({ id: GROUP_A2, team_id: TEAM_B });
        const proposals = makeProposalsLayer();
        const ctx = buildCtx({ membership: buildMembership(CREATOR_CTX_OVERRIDES) });
        const outcome = yield* runPropose(
          minimalCreateEventArgs({ memberGroupId: GROUP_A2 }),
          ctx,
          { groups: [foreignGroup], proposals },
        );
        expect(outcome.result).toEqual({
          error: 'invalid_arguments',
          detail: 'memberGroupId: no such group in this team',
        });
        expect(proposals.inserted).toHaveLength(0);
      }),
  );

  it.effect(
    'a group id that does not exist at all gets the BYTE-EQUAL message to the cross-team case — never distinguished',
    () =>
      Effect.gen(function* () {
        const foreignGroup = buildGroupRow({ id: GROUP_A1, team_id: TEAM_B });
        const ctx = buildCtx({ membership: buildMembership(CREATOR_CTX_OVERRIDES) });

        const crossTeam = yield* runPropose(
          minimalCreateEventArgs({ ownerGroupId: GROUP_A1 }),
          ctx,
          {
            groups: [foreignGroup],
          },
        );
        const nonexistent = yield* runPropose(
          minimalCreateEventArgs({ ownerGroupId: GROUP_A1 }),
          ctx,
          { groups: [] },
        );
        expect(nonexistent.result).toEqual(crossTeam.result);
      }),
  );

  it.effect('trainingTypeId from another team -> invalid_arguments, no insert', () =>
    Effect.gen(function* () {
      const foreignTT = buildTrainingTypeRow({ id: TT_A1, team_id: TEAM_B });
      const proposals = makeProposalsLayer();
      const ctx = buildCtx({ membership: buildMembership(CREATOR_CTX_OVERRIDES) });
      const outcome = yield* runPropose(minimalCreateEventArgs({ trainingTypeId: TT_A1 }), ctx, {
        trainingTypes: [foreignTT],
        proposals,
      });
      expect(outcome.result).toEqual({
        error: 'invalid_arguments',
        detail: 'trainingTypeId: no such training type in this team',
      });
      expect(proposals.inserted).toHaveLength(0);
    }),
  );

  it.effect(
    'happy path: exactly one insert, the stored JSON round-trips through ProposeCreateEventArgs, the model-facing result carries no payload fields, hits is empty',
    () =>
      Effect.gen(function* () {
        const proposals = makeProposalsLayer();
        const ctx = buildCtx({ membership: buildMembership(CREATOR_CTX_OVERRIDES) });
        const outcome = yield* runPropose(minimalCreateEventArgs(), ctx, { proposals });

        expect(proposals.inserted).toHaveLength(1);
        const stored = proposals.inserted[0];
        expect(stored?.action).toBe('create_event');
        const reparsed = JSON.parse(stored?.payload_json ?? '{}') as unknown;
        const decoded = Schema.decodeUnknownSync(ProposeCreateEventArgs)(reparsed);
        expect(decoded.title).toBe('AI Practice');

        expect(outcome.hits).toEqual([]);
        const result = outcome.result as Record<string, unknown>;
        expect(Object.keys(result).sort()).toEqual(['proposalId', 'status']);
        expect(result.status).toBe('proposed');
        expect(typeof result.proposalId).toBe('string');
      }),
  );

  it.effect(
    'no groups supplied but a training type that has them: the returned summary shows the INHERITED group names',
    () =>
      Effect.gen(function* () {
        const ownerGroup = buildGroupRow({ id: GROUP_A1, team_id: TEAM_A, name: 'Owner Squad' });
        const memberGroup = buildGroupRow({ id: GROUP_A2, team_id: TEAM_A, name: 'Member Squad' });
        const tt = buildTrainingTypeRow({
          id: TT_A1,
          team_id: TEAM_A,
          owner_group_id: Option.some(GROUP_A1),
          member_group_id: Option.some(GROUP_A2),
        });
        const ctx = buildCtx({ membership: buildMembership(CREATOR_CTX_OVERRIDES) });
        const outcome = yield* runPropose(minimalCreateEventArgs({ trainingTypeId: TT_A1 }), ctx, {
          groups: [ownerGroup, memberGroup],
          trainingTypes: [tt],
        });

        expect(outcome.proposal).toBeDefined();
        const summary = outcome.proposal?.summary ?? [];
        const ownerField = summary.find((f) => f.key === 'ownerGroup');
        const memberField = summary.find((f) => f.key === 'memberGroup');
        expect(ownerField?.value).toEqual({ type: 'text', value: 'Owner Squad' });
        expect(memberField?.value).toEqual({ type: 'text', value: 'Member Squad' });
      }),
  );
});
