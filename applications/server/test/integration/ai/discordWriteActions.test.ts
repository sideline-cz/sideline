// The three Discord write actions of the AI assistant on real Postgres (plan `.dev-loop/plan.md`,
// Test Specification 10-19b). Propose runs through `proposeAction` with real repositories; confirm
// and reject run through the real `AiChatApiLive` handler.
//
// The hard rule under test: propose writes ONLY the `ai_action_proposals` row; reject, expiry,
// every refusal and every drift at confirm write nothing else. Confirm only QUEUES the change
// (one `channel_sync_events` row the bot polls). `counts()` pins the "nothing else" half.
//
// Fixture helpers mirror `discordReadTools.test.ts`; the HTTP harness mirrors
// `test/integration/api/groupAssignRoleCrossTeam.test.ts`.

import { describe, expect, it } from '@effect/vitest';
import type {
  AiActionProposal,
  ChannelSyncEvent,
  Discord,
  Team,
  TeamMember,
  User,
} from '@sideline/domain';
import { AiChatApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { SqlClient } from 'effect/unstable/sql';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { AiChatApiLive } from '~/api/ai-chat.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { AiActionProposalsRepository } from '~/repositories/AiActionProposalsRepository.js';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamChannelAccessRepository } from '~/repositories/TeamChannelAccessRepository.js';
import { TeamChannelsRepository } from '~/repositories/TeamChannelsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { AiChatEnabledConfig } from '~/services/AiChatEnabledConfig.js';
import { listDiscordChannels } from '~/services/ai/readTools.js';
import type { ToolContext } from '~/services/ai/toolTypes.js';
import { proposeAction } from '~/services/ai/writeTools.js';
import { LlmClient } from '~/services/LlmClient.js';
import { MockChatAgentLayer, MockChatRateLimiterLayer } from '../../mocks/aiChatMocks.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const RealRepos = Layer.mergeAll(
  UsersRepository.Default,
  TeamsRepository.Default,
  TeamMembersRepository.Default,
  RolesRepository.Default,
  GroupsRepository.Default,
  TrainingTypesRepository.Default,
  TeamSettingsRepository.Default,
  TeamChannelsRepository.Default,
  TeamChannelAccessRepository.Default,
  ChannelSyncEventsRepository.Default,
  DiscordChannelMappingRepository.Default,
  DiscordChannelsRepository.Default,
  BotGuildsRepository.Default,
  AiActionProposalsRepository.Default,
  EventsRepository.Default,
  EventSyncEventsRepository.Default,
);

const SeedLayer = RealRepos.pipe(Layer.provideMerge(TestPgClient));

const sessionsStore = new Map<string, User.UserId>();

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

const SmallApi = HttpApi.make('api').add(AiChatApi.AiChatApiGroup);

const HandlerLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(AiChatApiLive),
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(MockChatAgentLayer),
  Layer.provide(MockChatRateLimiterLayer),
  Layer.provide(LlmClient.Default),
  Layer.provide(Layer.succeed(AiChatEnabledConfig, { asEffect: Effect.succeed(true) })),
  Layer.provide(RealRepos),
  Layer.provideMerge(TestPgClient),
);

let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  const app = HttpRouter.toWebHandler(HandlerLayer);
  handler = app.handler as (request: Request) => Promise<Response>;
  dispose = app.dispose;
});

afterAll(async () => {
  await dispose();
});

beforeEach(async () => {
  await cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise);
  sessionsStore.clear();
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const sf = (s: string) => s as Discord.Snowflake;

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: sf(discordId),
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
    Effect.map((u) => u.id),
  );

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId, name: string) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name,
        guild_id: guildId,
        created_by: createdBy,
        description: Option.none(),
        sport: Option.none(),
        logo_url: Option.none(),
        created_at: undefined,
        updated_at: undefined,
        welcome_channel_id: Option.none(),
        system_log_channel_id: Option.none(),
        welcome_message_template: Option.none(),
        rules_channel_id: Option.none(),
        achievement_channel_id: Option.none(),
        onboarding_rules_role_id: Option.none(),
        onboarding_rules_prompt_id: Option.none(),
        onboarding_locale: 'en',
        onboarding_synced_at: Option.none(),
        onboarding_sync_status: 'pending',
        onboarding_sync_error: Option.none(),
      }),
    ),
  );

const insertGroup = (teamId: Team.TeamId, name: string) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertGroup(teamId, name, Option.none(), Option.none(), Option.none()),
    ),
    Effect.map((g) => g.id),
    Effect.orDie,
  );

/**
 * One team with its Discord guild synced (`bot_guilds` row):
 * - Discord: category `<label>-archive` (type 4, set as the team's archive category), text
 *   channels `<label>-general` and `<label>-old`.
 * - Sideline channels: `<label>-general` (linked), `<label>-old` (archived), `<label>-new`
 *   (no Discord id yet).
 * - Groups: `U20` (with a Discord role), `Seniors` (VIEW on `<label>-general`), `Kids`, `KIDS`.
 * `digit` keeps the Discord ids of the two teams apart (`teams.guild_id` is UNIQUE).
 */
const seedDiscordTeam = (digit: string, label: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = (n: string) => sf(`9${digit}000000000000${n}`);
    const guildId = id('0000');
    const ownerId = yield* createUser(id('0001'), `${label}-owner`);
    const team = yield* createTeam(guildId, ownerId, `${label} team`);
    yield* RolesRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.seedTeamRolesWithPermissions(team.id)),
    );
    yield* BotGuildsRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.upsert(guildId, `${label} guild`)),
    );

    const archiveCategoryId = id('0100');
    const generalDiscordId = id('0101');
    yield* DiscordChannelsRepository.asEffect().pipe(
      Effect.andThen((repo) =>
        repo.syncChannels(guildId, [
          {
            channel_id: archiveCategoryId,
            name: `${label}-archive`,
            type: 4,
            parent_id: Option.none(),
          },
          {
            channel_id: generalDiscordId,
            name: `${label}-general`,
            type: 0,
            parent_id: Option.none(),
          },
          { channel_id: id('0102'), name: `${label}-old`, type: 0, parent_id: Option.none() },
        ]),
      ),
    );
    yield* sql`
      INSERT INTO team_settings (team_id, discord_archive_category_id)
      VALUES (${team.id}, ${archiveCategoryId})
    `;

    const channelRows = yield* sql<{ id: string; name: string }>`
      INSERT INTO team_channels (team_id, name, discord_channel_id, archived) VALUES
        (${team.id}, ${`${label}-general`}, ${generalDiscordId}, false),
        (${team.id}, ${`${label}-old`}, ${id('0102')}, true),
        (${team.id}, ${`${label}-new`}, NULL, false)
      RETURNING id, name
    `;
    const channelId = (name: string) => {
      const row = channelRows.find((r) => r.name === `${label}-${name}`);
      if (row === undefined) throw new Error(`seed: no channel ${name}`);
      return row.id;
    };

    const u20RoleId = id('0200');
    const u20 = yield* insertGroup(team.id, 'U20');
    yield* DiscordChannelMappingRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.insertRoleOnly(team.id, u20, u20RoleId)),
    );
    const seniors = yield* insertGroup(team.id, 'Seniors');
    yield* DiscordChannelMappingRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.insertRoleOnly(team.id, seniors, id('0201'))),
    );
    yield* sql`
      INSERT INTO team_channel_access (team_channel_id, group_id, access_level)
      VALUES (${channelId('general')}, ${seniors}, 'VIEW')
    `;
    const kids = yield* insertGroup(team.id, 'Kids');
    const kidsUpper = yield* insertGroup(team.id, 'KIDS');

    return {
      team,
      guildId,
      id,
      archiveCategoryId,
      generalDiscordId,
      generalId: channelId('general'),
      u20,
      u20RoleId,
      kids,
      kidsUpper,
    };
  });

/** A new member of `teamId` with only the built-in `roleName`; a session token for HTTP. */
const memberWithBuiltInRole = (
  teamId: Team.TeamId,
  discordId: Discord.Snowflake,
  roleName: 'Player' | 'Admin',
) =>
  Effect.gen(function* () {
    const userId = yield* createUser(discordId, `${roleName.toLowerCase()}-${discordId}`);
    const memberId: TeamMember.TeamMemberId = yield* TeamMembersRepository.asEffect().pipe(
      Effect.andThen((repo) =>
        repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
      ),
      Effect.map((tm) => tm.id),
    );
    const roles = yield* RolesRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.findRolesByTeamId(teamId)),
    );
    const role = roles.find((r) => r.name === roleName);
    if (!role) return yield* Effect.die(new Error(`built-in role ${roleName} not seeded`));
    yield* TeamMembersRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.assignRole(memberId, role.id)),
    );
    const membership = yield* TeamMembersRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.findMembershipByIds(teamId, userId)),
      Effect.map(Option.getOrThrow),
    );
    const ctx: ToolContext = {
      teamId,
      membership,
      teamTimezone: 'Europe/Prague',
      canSeeGroup: () => Effect.succeed(true),
    };
    const token = `token-${discordId}`;
    sessionsStore.set(token, userId);
    return { ctx, token };
  });

/** Team A + team B, and an Admin of team A (the built-in Admin holds both permissions). */
const setup = Effect.gen(function* () {
  const a = yield* seedDiscordTeam('1', 'A');
  yield* seedDiscordTeam('2', 'B');
  const admin = yield* memberWithBuiltInRole(a.team.id, a.id('0900'), 'Admin');
  return { a, admin };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Row counts of the three tables a confirmed Discord change writes to. */
const counts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ events: number; channels: number; access: number }>`
    SELECT
      (SELECT COUNT(*)::int FROM channel_sync_events) AS events,
      (SELECT COUNT(*)::int FROM team_channels) AS channels,
      (SELECT COUNT(*)::int FROM team_channel_access) AS access
  `;
  return row;
});

const proposalRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ id: string; action: string; payload: string; consumed_at: Date | null }>`
    SELECT id, action, payload::text AS payload, consumed_at FROM ai_action_proposals
  `;
});

const propose = (action: AiActionProposal.AiActionName, args: unknown, ctx: ToolContext) =>
  proposeAction(action, args, ctx);

/** Propose and require success; returns the proposal id and the card summary. */
const proposeOk = (action: AiActionProposal.AiActionName, args: unknown, ctx: ToolContext) =>
  propose(action, args, ctx).pipe(
    Effect.map((outcome) => {
      const result = outcome.result as { status?: string; proposalId?: string };
      expect(result, JSON.stringify(outcome.result)).toMatchObject({ status: 'proposed' });
      return { proposalId: result.proposalId as string, summary: outcome.proposal?.summary ?? [] };
    }),
  );

const post = (url: string, token: string) =>
  Effect.promise(() =>
    handler(new Request(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })),
  );

const confirm = (teamId: Team.TeamId, proposalId: string, token: string) =>
  post(`http://localhost/teams/${teamId}/ai/proposals/${proposalId}/confirm`, token);

const reject = (teamId: Team.TeamId, proposalId: string, token: string) =>
  post(`http://localhost/teams/${teamId}/ai/proposals/${proposalId}/reject`, token);

const json = (response: Response) => Effect.promise(() => response.json() as Promise<unknown>);

const channelStatus = (ctx: ToolContext, name: string) =>
  listDiscordChannels({}, ctx).pipe(
    Effect.map(
      (outcome) =>
        (outcome.result as { items: ReadonlyArray<Record<string, unknown>> }).items.find(
          (i) => i.name === name,
        )?.syncStatus,
    ),
  );

const summaryValue = (
  summary: ReadonlyArray<AiChatApi.ProposalField>,
  key: AiChatApi.ProposalFieldKey,
) => summary.find((f) => f.key === key)?.value;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Discord write actions on real Postgres', () => {
  // 10. Propose writes nothing but the proposal row.
  for (const { action, args } of [
    { action: 'create_discord_channel', args: { name: 'A-parents' } },
    {
      action: 'set_discord_channel_access',
      args: { channel: 'A-general', group: 'U20', access: 'EDIT' },
    },
    { action: 'archive_discord_channel', args: { channel: 'A-general' } },
  ] as const) {
    it.effect(`propose ${action}: one proposal row, nothing else written`, () =>
      Effect.gen(function* () {
        const { admin } = yield* setup;
        const before = yield* counts;

        yield* proposeOk(action, args, admin.ctx);

        const rows = yield* proposalRows;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.action).toBe(action);
        expect(yield* counts).toEqual(before);
      }).pipe(Effect.provide(SeedLayer)),
    );
  }

  // 11. Every refusal: the expected error, no proposal row, nothing else written.
  const refusals: ReadonlyArray<{
    readonly name: string;
    readonly setup?: (
      sql: SqlClient.SqlClient,
      a: Effect.Success<ReturnType<typeof seedDiscordTeam>>,
    ) => Effect.Effect<unknown, unknown>;
    readonly action: AiActionProposal.AiActionName;
    readonly args: unknown;
    readonly error: 'invalid_arguments' | 'discord_not_connected';
    readonly detail?: (detail: string) => void;
  }> = [
    {
      name: 'create with an existing active name',
      action: 'create_discord_channel',
      args: { name: 'A-general' },
      error: 'invalid_arguments',
    },
    {
      name: 'create whose formatted Discord name is longer than 100 characters',
      action: 'create_discord_channel',
      args: { name: 'x'.repeat(99), emoji: '🏆' },
      error: 'invalid_arguments',
      detail: (d) => expect(d.startsWith('name:')).toBe(true),
    },
    {
      name: 'access for a channel of team B',
      action: 'set_discord_channel_access',
      args: { channel: 'B-general', group: 'U20', access: 'EDIT' },
      error: 'invalid_arguments',
    },
    {
      name: 'access equal to the current level',
      action: 'set_discord_channel_access',
      args: { channel: 'A-general', group: 'Seniors', access: 'VIEW' },
      error: 'invalid_arguments',
    },
    {
      name: 'access for a group name that matches two groups only case-insensitively',
      action: 'set_discord_channel_access',
      args: { channel: 'A-general', group: 'kids', access: 'VIEW' },
      error: 'invalid_arguments',
      detail: (d) => expect(d).toContain('several'),
    },
    {
      name: 'archive of an archived channel',
      action: 'archive_discord_channel',
      args: { channel: 'A-old' },
      error: 'invalid_arguments',
    },
    {
      name: 'archive of a channel that is not in Discord yet',
      action: 'archive_discord_channel',
      args: { channel: 'A-new' },
      error: 'invalid_arguments',
      detail: (d) => expect(d).toContain('not in Discord yet'),
    },
    {
      name: 'archive with no archive category set',
      setup: (sql, a) =>
        sql`UPDATE team_settings SET discord_archive_category_id = NULL WHERE team_id = ${a.team.id}`,
      action: 'archive_discord_channel',
      args: { channel: 'A-general' },
      error: 'invalid_arguments',
      detail: (d) => expect(d).toContain('no archive category'),
    },
    {
      name: 'archive when the archive category is gone from Discord',
      setup: (sql, a) =>
        sql`DELETE FROM discord_channels WHERE channel_id = ${a.archiveCategoryId}`,
      action: 'archive_discord_channel',
      args: { channel: 'A-general' },
      error: 'invalid_arguments',
      detail: (d) => expect(d).toContain('no longer exists'),
    },
    ...(
      [
        ['create_discord_channel', { name: 'A-parents' }],
        ['set_discord_channel_access', { channel: 'A-general', group: 'U20', access: 'EDIT' }],
        ['archive_discord_channel', { channel: 'A-general' }],
      ] as const
    ).map(([action, args]) => ({
      name: `${action} when the bot is not in the guild`,
      setup: (sql: SqlClient.SqlClient, a: Effect.Success<ReturnType<typeof seedDiscordTeam>>) =>
        sql`DELETE FROM bot_guilds WHERE guild_id = ${a.guildId}`,
      action,
      args,
      error: 'discord_not_connected' as const,
    })),
  ];

  for (const refusal of refusals) {
    it.effect(`refuses: ${refusal.name}`, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { a, admin } = yield* setup;
        if (refusal.setup) yield* refusal.setup(sql, a).pipe(Effect.orDie);
        const before = yield* counts;

        const outcome = yield* propose(refusal.action, refusal.args, admin.ctx);

        const result = outcome.result as { error?: string; detail?: string };
        expect(result.error, JSON.stringify(result)).toBe(refusal.error);
        refusal.detail?.(result.detail ?? '');
        expect(outcome.proposal).toBeUndefined();
        expect(yield* proposalRows).toHaveLength(0);
        expect(yield* counts).toEqual(before);
      }).pipe(Effect.provide(SeedLayer)),
    );
  }

  // 11b. An exact name wins over a case-insensitive one.
  it.effect('access for group KIDS (exact) stores the KIDS group, not Kids', () =>
    Effect.gen(function* () {
      const { a, admin } = yield* setup;
      yield* proposeOk(
        'set_discord_channel_access',
        { channel: 'A-general', group: 'KIDS', access: 'VIEW' },
        admin.ctx,
      );
      const [row] = yield* proposalRows;
      const payload = JSON.parse(row?.payload ?? '{}') as { groupId?: string };
      expect(payload.groupId).toBe(a.kidsUpper);
      expect(payload.groupId).not.toBe(a.kids);
    }).pipe(Effect.provide(SeedLayer)),
  );

  // 12. Permission gate on real seeded roles.
  it.effect('a Player is refused (forbidden) and no proposal row is written', () =>
    Effect.gen(function* () {
      const { a } = yield* setup;
      const player = yield* memberWithBuiltInRole(a.team.id, a.id('0901'), 'Player');
      const outcome = yield* propose('create_discord_channel', { name: 'A-parents' }, player.ctx);
      expect((outcome.result as { error?: string }).error).toBe('forbidden');
      expect(yield* proposalRows).toHaveLength(0);
    }).pipe(Effect.provide(SeedLayer)),
  );

  // 13. Reject writes nothing.
  it.effect('reject: 204, proposal row gone, nothing else written', () =>
    Effect.gen(function* () {
      const { a, admin } = yield* setup;
      const { proposalId } = yield* proposeOk(
        'archive_discord_channel',
        { channel: 'A-general' },
        admin.ctx,
      );
      const before = yield* counts;

      const response = yield* reject(a.team.id, proposalId, admin.token);

      expect(response.status).toBe(204);
      expect(yield* proposalRows).toHaveLength(0);
      expect(yield* counts).toEqual(before);
    }).pipe(Effect.provide(SeedLayer)),
  );

  // 14. Expiry writes nothing.
  it.effect('expired: confirm is 410 and nothing is written', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { a, admin } = yield* setup;
      const { proposalId } = yield* proposeOk(
        'archive_discord_channel',
        { channel: 'A-general' },
        admin.ctx,
      );
      // `created_at` moves too: the table CHECKs `expires_at > created_at`.
      yield* sql`
        UPDATE ai_action_proposals
        SET created_at = now() - interval '20 minutes', expires_at = now() - interval '1 minute'
        WHERE id = ${proposalId}
      `;
      const before = yield* counts;

      const response = yield* confirm(a.team.id, proposalId, admin.token);

      expect(response.status).toBe(410);
      expect(yield* counts).toEqual(before);
    }).pipe(Effect.provide(SeedLayer)),
  );

  // 15 + 19 (first half). Create: queued, then the pending flag.
  it.effect('approve create_discord_channel: 202 queued, one channel_created event, pending', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { a, admin } = yield* setup;
      const { proposalId, summary } = yield* proposeOk(
        'create_discord_channel',
        { name: 'A-parents' },
        admin.ctx,
      );
      const discordName = summaryValue(summary, 'discordName');
      expect(discordName?.type).toBe('text');
      const formatted = (discordName as { value: string }).value;
      expect(formatted).toContain('A-parents');
      expect(summary.map((f) => f.key)).not.toContain('category');

      const response = yield* confirm(a.team.id, proposalId, admin.token);
      expect(response.status).toBe(202);
      expect(yield* json(response)).toEqual({ status: 'queued' });

      const channels = yield* sql<{ id: string; category: string | null }>`
        SELECT id, category FROM team_channels WHERE team_id = ${a.team.id} AND name = 'A-parents'
      `;
      expect(channels).toHaveLength(1);
      expect(channels[0]?.category).toBeNull();
      const events = yield* sql<{
        event_type: string;
        entity_type: string;
        team_channel_id: string | null;
        discord_channel_name: string | null;
        processed_at: Date | null;
      }>`
        SELECT event_type, entity_type, team_channel_id, discord_channel_name, processed_at
        FROM channel_sync_events
      `;
      expect(events).toEqual([
        {
          event_type: 'channel_created',
          entity_type: 'managed',
          team_channel_id: channels[0]?.id,
          discord_channel_name: formatted,
          processed_at: null,
        },
      ]);

      // 19: queued and not applied → pending; processed but not mirrored yet → not_on_discord.
      expect(yield* channelStatus(admin.ctx, 'A-parents')).toBe('pending');
      yield* sql`UPDATE channel_sync_events SET processed_at = now()`;
      expect(yield* channelStatus(admin.ctx, 'A-parents')).toBe('not_on_discord');
    }).pipe(Effect.provide(SeedLayer)),
  );

  // 16 + 19 (second half). Grant, then revoke; the revoke row marks the channel pending.
  it.effect('approve set_discord_channel_access: EDIT grant, then NONE revoke', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { a, admin } = yield* setup;

      const grant = yield* proposeOk(
        'set_discord_channel_access',
        { channel: 'A-general', group: 'U20', access: 'EDIT' },
        admin.ctx,
      );
      const granted = yield* confirm(a.team.id, grant.proposalId, admin.token);
      expect(granted.status).toBe(202);

      const access = yield* sql<{ access_level: string }>`
        SELECT access_level FROM team_channel_access
        WHERE team_channel_id = ${a.generalId} AND group_id = ${a.u20}
      `;
      expect(access).toEqual([{ access_level: 'EDIT' }]);
      const added = yield* sql<{ discord_role_id: string | null; access_level: string | null }>`
        SELECT discord_role_id, access_level FROM channel_sync_events
        WHERE event_type = 'member_added' AND entity_type = 'managed'
      `;
      expect(added).toEqual([{ discord_role_id: a.u20RoleId, access_level: 'EDIT' }]);

      // The bot applied the grant; only the revoke below stays unprocessed.
      yield* sql`UPDATE channel_sync_events SET processed_at = now()`;

      const revoke = yield* proposeOk(
        'set_discord_channel_access',
        { channel: 'A-general', group: 'U20', access: 'NONE' },
        admin.ctx,
      );
      const revoked = yield* confirm(a.team.id, revoke.proposalId, admin.token);
      expect(revoked.status).toBe(202);

      const after = yield* sql`
        SELECT 1 FROM team_channel_access
        WHERE team_channel_id = ${a.generalId} AND group_id = ${a.u20}
      `;
      expect(after).toHaveLength(0);
      const removed = yield* sql<{ existing_channel_id: string | null }>`
        SELECT existing_channel_id FROM channel_sync_events
        WHERE event_type = 'member_removed' AND entity_type = 'managed'
      `;
      expect(removed).toEqual([{ existing_channel_id: a.generalDiscordId }]);

      // 19: the revoke row has no team_channel_id; it matches through existing_channel_id.
      expect(yield* channelStatus(admin.ctx, 'A-general')).toBe('pending');
    }).pipe(Effect.provide(SeedLayer)),
  );

  // 17. Archive.
  it.effect('approve archive_discord_channel: archived, one channel_archived event', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { a, admin } = yield* setup;
      const { proposalId, summary } = yield* proposeOk(
        'archive_discord_channel',
        { channel: 'A-general' },
        admin.ctx,
      );
      expect(summaryValue(summary, 'archiveCategory')).toEqual({
        type: 'text',
        value: 'A-archive',
      });

      const response = yield* confirm(a.team.id, proposalId, admin.token);
      expect(response.status).toBe(202);

      const [channel] = yield* sql<{ archived: boolean }>`
        SELECT archived FROM team_channels WHERE id = ${a.generalId}
      `;
      expect(channel?.archived).toBe(true);
      const events = yield* sql<{
        archive_category_id: string | null;
        existing_channel_id: string | null;
      }>`
        SELECT archive_category_id, existing_channel_id FROM channel_sync_events
        WHERE event_type = 'channel_archived' AND entity_type = 'managed'
      `;
      expect(events).toEqual([
        { archive_category_id: a.archiveCategoryId, existing_channel_id: a.generalDiscordId },
      ]);
    }).pipe(Effect.provide(SeedLayer)),
  );

  // 18. Drift between propose and confirm: 404, nothing written, proposal still unclaimed.
  const drifts: ReadonlyArray<{
    readonly name: string;
    readonly mutate: (
      sql: SqlClient.SqlClient,
      a: Effect.Success<ReturnType<typeof seedDiscordTeam>>,
    ) => Effect.Effect<unknown, unknown>;
  }> = [
    {
      name: 'the channel was archived',
      mutate: (sql, a) => sql`UPDATE team_channels SET archived = true WHERE id = ${a.generalId}`,
    },
    {
      name: 'the archive category was unset',
      mutate: (sql, a) =>
        sql`UPDATE team_settings SET discord_archive_category_id = NULL WHERE team_id = ${a.team.id}`,
    },
    {
      name: 'the archive category was deleted in Discord',
      mutate: (sql, a) =>
        sql`DELETE FROM discord_channels WHERE channel_id = ${a.archiveCategoryId}`,
    },
    {
      name: 'the channel lost its Discord id',
      mutate: (sql, a) =>
        sql`UPDATE team_channels SET discord_channel_id = NULL WHERE id = ${a.generalId}`,
    },
  ];

  for (const drift of drifts) {
    it.effect(`archive confirm after drift (${drift.name}): 404, nothing written`, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { a, admin } = yield* setup;
        const { proposalId } = yield* proposeOk(
          'archive_discord_channel',
          { channel: 'A-general' },
          admin.ctx,
        );
        yield* drift.mutate(sql, a).pipe(Effect.orDie);
        const before = yield* counts;
        const [archivedBefore] = yield* sql<{ archived: boolean }>`
          SELECT archived FROM team_channels WHERE id = ${a.generalId}
        `;

        const response = yield* confirm(a.team.id, proposalId, admin.token);

        expect(response.status).toBe(404);
        expect(yield* json(response)).toEqual({ _tag: 'AiProposalNotFound' });
        expect(yield* counts).toEqual(before);
        const [archivedAfter] = yield* sql<{ archived: boolean }>`
          SELECT archived FROM team_channels WHERE id = ${a.generalId}
        `;
        expect(archivedAfter).toEqual(archivedBefore);
        const [row] = yield* proposalRows;
        expect(row?.consumed_at).toBeNull();
      }).pipe(Effect.provide(SeedLayer)),
    );
  }

  // 19b. Failed flag, and a retried success that is no longer failed.
  it.effect(
    'list_discord_channels: failed after a permanent failure, synced after a retried success',
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { a, admin } = yield* setup;
        const syncEvents = yield* ChannelSyncEventsRepository.asEffect();
        yield* syncEvents.emitManagedChannelCreated({
          teamId: a.team.id,
          teamChannelId: a.generalId as never,
          discordChannelName: 'A-general',
        });
        const [event] = yield* sql<{ id: ChannelSyncEvent.ChannelSyncEventId }>`
        SELECT id FROM channel_sync_events
      `;
        const eventId = event?.id as ChannelSyncEvent.ChannelSyncEventId;

        // Permanent failure: processed, with an error.
        yield* sql`
        UPDATE channel_sync_events SET processed_at = now(), error = 'Missing Access'
        WHERE id = ${eventId}
      `;
        expect(yield* channelStatus(admin.ctx, 'A-general')).toBe('failed');

        // Transient failure: error set, not processed → the bot retries it.
        yield* sql`
        UPDATE channel_sync_events SET processed_at = NULL, error = 'timeout' WHERE id = ${eventId}
      `;
        expect(yield* channelStatus(admin.ctx, 'A-general')).toBe('pending');

        // The retry succeeds: markProcessed must clear the stale error.
        yield* syncEvents.markProcessed(eventId);
        expect(yield* channelStatus(admin.ctx, 'A-general')).toBe('synced');
      }).pipe(Effect.provide(SeedLayer)),
  );
});
