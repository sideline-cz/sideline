// The AI assistant's group and roster write actions on real Postgres. Harness mirrors
// `eventWriteActions.test.ts`.
//
// Under test: propose writes ONLY the proposal row; confirm writes the change AND queues its
// Discord sync event, and answers 202 queued; the permission is checked at propose and at
// confirm; another team's roster or group is never reachable.

import { describe, expect, it } from '@effect/vitest';
import type { AiActionProposal, Discord, Team, User } from '@sideline/domain';
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
import { EventAttendanceRepository } from '~/repositories/EventAttendanceRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { NotificationsRepository } from '~/repositories/NotificationsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamChannelAccessRepository } from '~/repositories/TeamChannelAccessRepository.js';
import { TeamChannelsRepository } from '~/repositories/TeamChannelsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { AiChatEnabledConfig } from '~/services/AiChatEnabledConfig.js';
import { visibleTools } from '~/services/ai/registry.js';
import type { ToolContext } from '~/services/ai/toolTypes.js';
import { proposeAction } from '~/services/ai/writeTools.js';
import { addRosterMemberForMemberTx } from '~/services/GroupRosterWrites.js';
import { LlmClient } from '~/services/LlmClient.js';
import { MockChatAgentLayer, MockChatRateLimiterLayer } from '../../mocks/aiChatMocks.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

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
  EventAttendanceRepository.Default,
  EventRsvpsRepository.Default,
  NotificationsRepository.Default,
  RostersRepository.Default,
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

const HandlerLayer = HttpApiBuilder.layer(HttpApi.make('api').add(AiChatApi.AiChatApiGroup)).pipe(
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

/** A member of `teamId` holding the built-in `roleName`, with a tool context and a token. */
const member = (teamId: Team.TeamId, discordId: string, roleName: 'Admin' | 'Captain' | 'Player') =>
  Effect.gen(function* () {
    const userId = yield* createUser(discordId, `${roleName.toLowerCase()}-${discordId}`);
    const members = yield* TeamMembersRepository.asEffect();
    const tm = yield* members.addMember({
      team_id: teamId,
      user_id: userId,
      active: true,
      joined_at: undefined,
    });
    const roles = yield* RolesRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.findRolesByTeamId(teamId)),
    );
    const role = roles.find((r) => r.name === roleName);
    if (!role) return yield* Effect.die(new Error(`built-in role ${roleName} not seeded`));
    yield* members.assignRole(tm.id, role.id);
    const token = `token-${discordId}`;
    sessionsStore.set(token, userId);
    const ctx = Effect.gen(function* () {
      const membership = yield* members
        .findMembershipByIds(teamId, userId)
        .pipe(Effect.map(Option.getOrThrow));
      const c: ToolContext = {
        teamId,
        membership,
        teamTimezone: 'Europe/Prague',
        canSeeGroup: () => Effect.succeed(true),
      };
      return c;
    });
    return { memberId: tm.id, roleId: role.id, token, ctx: yield* ctx };
  });

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ownerA = yield* createUser('910000000000000001', 'owner-a');
  const teamA = yield* createTeam(sf('910000000000000000'), ownerA, 'A team');
  const ownerB = yield* createUser('920000000000000001', 'owner-b');
  const teamB = yield* createTeam(sf('920000000000000000'), ownerB, 'B team');
  for (const t of [teamA, teamB]) {
    yield* RolesRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.seedTeamRolesWithPermissions(t.id)),
    );
  }
  const admin = yield* member(teamA.id, '910000000000000900', 'Admin');
  const player = yield* member(teamA.id, '910000000000000902', 'Player');
  const groups = yield* GroupsRepository.asEffect();
  const u12 = yield* groups
    .insertGroup(teamA.id, 'U12', Option.none(), Option.none(), Option.none())
    .pipe(Effect.orDie);
  const rosters = yield* RostersRepository.asEffect();
  const firstTeam = yield* rosters
    .insert({
      team_id: teamA.id,
      name: 'First team',
      active: true,
      color: Option.none(),
      emoji: Option.none(),
    })
    .pipe(Effect.orDie);
  // Team B's roster: neither the name lookup nor its id may reach it from team A.
  const bSquad = yield* rosters
    .insert({
      team_id: teamB.id,
      name: 'B squad',
      active: true,
      color: Option.none(),
      emoji: Option.none(),
    })
    .pipe(Effect.orDie);
  return { sql, teamA, admin, player, u12, firstTeam, bSquad };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const proposalCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ n: number }>`SELECT COUNT(*)::int AS n FROM ai_action_proposals`;
  return row?.n;
});

const proposeOk = (action: AiActionProposal.AiActionName, args: unknown, ctx: ToolContext) =>
  proposeAction(action, args, ctx).pipe(
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

const syncEvents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ n: number }>`SELECT COUNT(*)::int AS n FROM channel_sync_events`;
  return row?.n ?? 0;
});

const PLAYER = 'player-910000000000000902';

describe('AI group and roster write actions on real Postgres', () => {
  it.effect('visibleTools: a Player sees none of them; an Admin sees all six', () =>
    Effect.gen(function* () {
      const { admin, player } = yield* setup;
      const names = (ctx: ToolContext) => visibleTools(ctx).map((t) => t.name);
      for (const t of [
        'propose_create_group',
        'propose_add_group_member',
        'propose_remove_group_member',
        'propose_create_roster',
        'propose_add_roster_member',
        'propose_remove_roster_member',
      ]) {
        expect(names(player.ctx)).not.toContain(t);
        expect(names(admin.ctx)).toContain(t);
      }
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('add_group_member: propose writes only the proposal; confirm adds and queues', () =>
    Effect.gen(function* () {
      const { sql, teamA, admin, player, u12 } = yield* setup;
      const before = yield* syncEvents;
      const { proposalId, summary } = yield* proposeOk(
        'add_group_member',
        { group: 'u12', member: PLAYER },
        admin.ctx,
      );
      expect(summary.map((f) => f.key)).toEqual(['group', 'member']);
      expect(yield* syncEvents).toBe(before);
      expect(yield* sql`SELECT 1 FROM group_members WHERE group_id = ${u12.id}`).toHaveLength(0);

      const response = yield* confirm(teamA.id, proposalId, admin.token);
      expect(response.status).toBe(202);
      expect(yield* json(response)).toEqual({ status: 'queued' });
      const rows = yield* sql<{ team_member_id: string }>`
        SELECT team_member_id FROM group_members WHERE group_id = ${u12.id}
      `;
      expect(rows.map((r) => r.team_member_id)).toEqual([player.memberId]);
      expect(yield* syncEvents).toBeGreaterThan(before);

      // Adding again is refused at propose.
      const again = yield* proposeAction(
        'add_group_member',
        { group: 'U12', member: PLAYER },
        admin.ctx,
      );
      expect(again.result).toMatchObject({ error: 'invalid_arguments' });
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('remove_roster_member: refused when not on it; reject leaves it; confirm removes', () =>
    Effect.gen(function* () {
      const { sql, teamA, admin, player, firstTeam } = yield* setup;
      const notOn = yield* proposeAction(
        'remove_roster_member',
        { roster: 'First team', member: PLAYER },
        admin.ctx,
      );
      expect(notOn.result).toMatchObject({ error: 'invalid_arguments' });

      yield* RostersRepository.asEffect().pipe(
        Effect.flatMap((r) => r.addMemberById(firstTeam.id, player.memberId)),
        Effect.orDie,
      );
      const first = yield* proposeOk(
        'remove_roster_member',
        { roster: 'First team', member: PLAYER },
        admin.ctx,
      );
      expect((yield* reject(teamA.id, first.proposalId, admin.token)).status).toBe(204);
      expect(
        yield* sql`SELECT 1 FROM roster_members WHERE roster_id = ${firstTeam.id}`,
      ).toHaveLength(1);

      const second = yield* proposeOk(
        'remove_roster_member',
        { roster: 'First team', member: PLAYER },
        admin.ctx,
      );
      const response = yield* confirm(teamA.id, second.proposalId, admin.token);
      expect(response.status).toBe(202);
      expect(
        yield* sql`SELECT 1 FROM roster_members WHERE roster_id = ${firstTeam.id}`,
      ).toHaveLength(0);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect("another team's roster is not found by name", () =>
    Effect.gen(function* () {
      const { admin } = yield* setup;
      const outcome = yield* proposeAction(
        'add_roster_member',
        { roster: 'B squad', member: PLAYER },
        admin.ctx,
      );
      expect(outcome.result).toEqual({
        error: 'invalid_arguments',
        detail: 'roster: no roster with that name',
      });
      expect(yield* proposalCount).toBe(0);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect("the shared write (HTTP and AI) refuses another team's roster id", () =>
    Effect.gen(function* () {
      const { sql, teamA, admin, player, bSquad } = yield* setup;
      const error = yield* addRosterMemberForMemberTx({
        teamId: teamA.id,
        membership: admin.ctx.membership,
        rosterId: bSquad.id,
        memberId: player.memberId,
      }).pipe(Effect.flip);
      expect(error._tag).toBe('RosterNotFound');
      expect(yield* sql`SELECT 1 FROM roster_members WHERE roster_id = ${bSquad.id}`).toHaveLength(
        0,
      );
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect(
    'create_group and create_roster: confirm creates the row and queues its Discord sync',
    () =>
      Effect.gen(function* () {
        const { sql, teamA, admin } = yield* setup;
        const taken = yield* proposeAction('create_group', { name: 'u12' }, admin.ctx);
        expect(taken.result).toMatchObject({ error: 'invalid_arguments' });

        const group = yield* proposeOk('create_group', { name: 'U14', emoji: '⚽' }, admin.ctx);
        expect((yield* confirm(teamA.id, group.proposalId, admin.token)).status).toBe(202);
        expect(
          yield* sql`SELECT 1 FROM groups WHERE team_id = ${teamA.id} AND name = 'U14'`,
        ).toHaveLength(1);

        const before = yield* syncEvents;
        const roster = yield* proposeOk('create_roster', { name: 'Second team' }, admin.ctx);
        expect((yield* confirm(teamA.id, roster.proposalId, admin.token)).status).toBe(202);
        expect(
          yield* sql`SELECT 1 FROM rosters WHERE team_id = ${teamA.id} AND name = 'Second team'`,
        ).toHaveLength(1);
        expect(yield* syncEvents).toBeGreaterThan(before);
      }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('create_roster with channel creation off: 200 applied, nothing queued', () =>
    Effect.gen(function* () {
      const { sql, teamA, admin } = yield* setup;
      yield* sql`
        INSERT INTO team_settings (team_id, create_discord_channel_on_roster)
        VALUES (${teamA.id}, false)
      `;
      const before = yield* syncEvents;
      const roster = yield* proposeOk('create_roster', { name: 'Quiet team' }, admin.ctx);
      const response = yield* confirm(teamA.id, roster.proposalId, admin.token);
      expect(response.status).toBe(200);
      expect(yield* json(response)).toEqual({ status: 'applied' });
      expect(yield* syncEvents).toBe(before);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect(
    'a Player is refused at propose; confirm re-checks after the role loses group:manage',
    () =>
      Effect.gen(function* () {
        const { sql, teamA, admin, player } = yield* setup;
        const refused = yield* proposeAction('create_group', { name: 'X' }, player.ctx);
        expect(refused.result).toEqual({ error: 'forbidden', permission: 'group:manage' });

        const { proposalId } = yield* proposeOk(
          'add_group_member',
          { group: 'U12', member: PLAYER },
          admin.ctx,
        );
        yield* sql`DELETE FROM role_permissions WHERE role_id = ${admin.roleId} AND permission = 'group:manage'`;
        const response = yield* confirm(teamA.id, proposalId, admin.token);
        expect(response.status).toBe(403);
        expect(yield* sql`SELECT 1 FROM group_members`).toHaveLength(0);
      }).pipe(Effect.provide(SeedLayer)),
  );
});
