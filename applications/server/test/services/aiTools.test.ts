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
import { DateTime, Effect, Layer, Option, type ServiceMap } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { toEventInfo } from '~/api/event.js';
import { EventsRepository, EventWithDetails } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import {
  MembershipWithRole,
  RosterEntry,
  TeamMembersRepository,
} from '~/repositories/TeamMembersRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { toToolParameters } from '~/services/ai/jsonSchema.js';
import {
  currentDatetime,
  listEvents,
  listGroups,
  listMembers,
  listRosters,
  listTrainingTypes,
} from '~/services/ai/readTools.js';
import { ALL_TOOLS, visibleTools } from '~/services/ai/registry.js';
import { makeCanSeeGroup, type ToolContext } from '~/services/ai/toolTypes.js';

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

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

interface EventOverrides {
  readonly id?: Event.EventId;
  readonly team_id?: Team.TeamId;
  readonly title?: string;
  readonly status?: Event.EventStatus;
  readonly member_group_id?: Option.Option<GroupModel.GroupId>;
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
    created_by_name: Option.none(),
    series_id: Option.none(),
    series_modified: false,
    owner_group_id: Option.none(),
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
  } as never);

interface TrainingTypeRow {
  readonly id: TrainingType.TrainingTypeId;
  readonly team_id: Team.TeamId;
  readonly name: string;
  readonly owner_group_name: Option.Option<string>;
  readonly member_group_name: Option.Option<string>;
}

const buildTrainingTypeRow = (overrides: Partial<TrainingTypeRow> = {}): TrainingTypeRow => ({
  id: overrides.id ?? TT_A1,
  team_id: overrides.team_id ?? TEAM_A,
  name: overrides.name ?? 'Fitness',
  owner_group_name: overrides.owner_group_name ?? Option.none(),
  member_group_name: overrides.member_group_name ?? Option.none(),
});

const makeTrainingTypesLayer = (rows: ReadonlyArray<TrainingTypeRow>) =>
  Layer.succeed(TrainingTypesRepository, {
    findTrainingTypesByTeamId: (teamId: Team.TeamId) =>
      Effect.succeed(rows.filter((r) => r.team_id === teamId)),
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
}

const buildRosterEntry = (overrides: RosterEntryOverrides = {}): RosterEntry =>
  new RosterEntry({
    member_id: overrides.member_id ?? MEMBER_A1,
    user_id: USER_1,
    discord_id: overrides.discord_id ?? ('123456789012345678' as Discord.Snowflake),
    role_names: ['Player'],
    permissions: [],
    effective_roles: [],
    name: overrides.name ?? Option.some('Alice'),
    birth_date: Option.some('2000-01-01'),
    gender: Option.some('female' as User.Gender),
    jersey_number: overrides.jersey_number ?? Option.some(7),
    username: 'alice#0001',
    avatar: overrides.avatar ?? Option.some('abcd1234'),
    discord_nickname: Option.none(),
    discord_display_name: Option.none(),
    joined_at: '2024-01-01T00:00:00.000Z',
    active: overrides.active ?? true,
  });

const makeMembersLayer = (byTeam: ReadonlyMap<Team.TeamId, ReadonlyArray<RosterEntry>>) =>
  Layer.succeed(TeamMembersRepository, {
    findRosterByTeam: (teamId: string) => Effect.succeed(byTeam.get(teamId as Team.TeamId) ?? []),
  } as never);

const itemsOf = (result: unknown): ReadonlyArray<Record<string, unknown>> =>
  (result as { items: ReadonlyArray<Record<string, unknown>> }).items;

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
        expect([...playerNames].sort()).toEqual([
          'current_datetime',
          'list_events',
          'list_training_types',
        ]);

        expect([...adminNames].sort()).toEqual([
          'current_datetime',
          'list_events',
          'list_groups',
          'list_members',
          'list_rosters',
          'list_training_types',
        ]);
      }),
  );
});

describe('ALL_TOOLS — registry / JSON Schema invariants (parameterized, §13.3/10)', () => {
  it.effect('every tool has a well-formed, unique, flat, additionalProperties:false schema', () =>
    Effect.sync(() => {
      expect(ALL_TOOLS.length).toBe(6);
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
