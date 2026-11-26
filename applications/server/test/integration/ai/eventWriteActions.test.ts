// The AI assistant's event write actions (update, cancel, attendance) on real Postgres. Propose
// runs through `proposeAction` with real repositories; confirm and reject run through the real
// `AiChatApiLive` handler. Harness mirrors `discordWriteActions.test.ts`.
//
// Under test: propose writes ONLY the proposal row; the permission is checked at propose and
// again at confirm, and so is the row gate (owner group) the HTTP handlers apply.

import { describe, expect, it } from '@effect/vitest';
import type { AiActionProposal, Discord, Team, TeamMember, User } from '@sideline/domain';
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
import { EventRosterProvisioningService } from '~/services/EventRosterProvisioningService.js';
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
  // Roster provisioning after an RSVP is best-effort and has its own tests; a no-op here.
  Layer.provide(
    Layer.succeed(EventRosterProvisioningService, { onRsvp: () => Effect.void } as never),
  ),
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
    return { memberId: tm.id, roleId: role.id, token, ctx: yield* ctx, refreshCtx: ctx };
  });

const insertEvent = (
  teamId: Team.TeamId,
  createdBy: TeamMember.TeamMemberId,
  overrides: {
    readonly title: string;
    readonly eventType?: string;
    readonly startAt: DateTime.Utc;
    readonly ownerGroupId?: Option.Option<string>;
  },
) =>
  EventsRepository.asEffect().pipe(
    Effect.flatMap((events) =>
      events.insertEvent({
        teamId,
        trainingTypeId: Option.none(),
        eventType: overrides.eventType ?? 'training',
        title: overrides.title,
        description: Option.none(),
        startAt: overrides.startAt,
        endAt: Option.some(DateTime.add(overrides.startAt, { hours: 2 })),
        location: Option.some('Old field'),
        createdBy,
        ownerGroupId: overrides.ownerGroupId ?? Option.none(),
      }),
    ),
    Effect.orDie,
  );

const inDays = (days: number) => DateTime.add(DateTime.nowUnsafe(), { days });

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
  const captain = yield* member(teamA.id, '910000000000000901', 'Captain');
  const player = yield* member(teamA.id, '910000000000000902', 'Player');
  const player2 = yield* member(teamA.id, '910000000000000903', 'Player');
  const adminB = yield* member(teamB.id, '920000000000000900', 'Admin');

  const groups = yield* GroupsRepository.asEffect();
  const coaches = yield* groups
    .insertGroup(teamA.id, 'Coaches', Option.none(), Option.none(), Option.none())
    .pipe(Effect.orDie);
  yield* groups.addMemberById(coaches.id, captain.memberId).pipe(Effect.orDie);

  const upcoming = yield* insertEvent(teamA.id, admin.memberId, {
    title: 'Thursday practice',
    startAt: inDays(7),
  });
  // Owned by a group the captain is NOT in.
  const otherGroup = yield* groups
    .insertGroup(teamA.id, 'Elite', Option.none(), Option.none(), Option.none())
    .pipe(Effect.orDie);
  const elite = yield* insertEvent(teamA.id, admin.memberId, {
    title: 'Elite practice',
    startAt: inDays(7),
    ownerGroupId: Option.some(otherGroup.id),
  });
  const coached = yield* insertEvent(teamA.id, admin.memberId, {
    title: 'Coached practice',
    startAt: inDays(7),
    ownerGroupId: Option.some(coaches.id),
  });
  const started = yield* insertEvent(teamA.id, admin.memberId, {
    title: 'Monday practice',
    startAt: DateTime.subtract(DateTime.nowUnsafe(), { hours: 1 }),
  });
  const foreign = yield* insertEvent(teamB.id, adminB.memberId, {
    title: 'B practice',
    startAt: inDays(7),
  });
  return {
    sql,
    teamA,
    admin,
    captain,
    player,
    player2,
    coaches,
    upcoming,
    elite,
    coached,
    started,
    foreign,
  };
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

const eventRow = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ title: string; location: string | null; status: string }>`
      SELECT title, location, status FROM events WHERE id = ${id}
    `;
    return row;
  });

const summaryValue = (
  summary: ReadonlyArray<AiChatApi.ProposalField>,
  key: AiChatApi.ProposalFieldKey,
) => summary.find((f) => f.key === key)?.value;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AI event write actions on real Postgres', () => {
  it.effect('visibleTools: a Player sees none of the event write tools; an Admin sees all', () =>
    Effect.gen(function* () {
      const { admin, player } = yield* setup;
      const names = (ctx: ToolContext) => visibleTools(ctx).map((t) => t.name);
      const tools = ['propose_update_event', 'propose_cancel_event', 'propose_mark_attendance'];
      for (const t of tools) {
        expect(names(player.ctx)).not.toContain(t);
        expect(names(admin.ctx)).toContain(t);
      }
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('update_event: propose writes nothing but the proposal; confirm applies it', () =>
    Effect.gen(function* () {
      const { teamA, admin, upcoming } = yield* setup;
      const { proposalId, summary } = yield* proposeOk(
        'update_event',
        { eventId: upcoming.id, title: 'Friday practice', location: 'New field' },
        admin.ctx,
      );
      expect(summaryValue(summary, 'title')).toEqual({ type: 'text', value: 'Friday practice' });
      expect(summaryValue(summary, 'location')).toEqual({ type: 'text', value: 'New field' });
      expect(yield* eventRow(upcoming.id)).toMatchObject({ title: 'Thursday practice' });

      const response = yield* confirm(teamA.id, proposalId, admin.token);
      expect(response.status).toBe(200);
      expect(yield* json(response)).toEqual({ status: 'applied' });
      expect(yield* eventRow(upcoming.id)).toMatchObject({
        title: 'Friday practice',
        location: 'New field',
      });
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('update_event: an end before the start is refused at propose', () =>
    Effect.gen(function* () {
      const { admin, upcoming } = yield* setup;
      const outcome = yield* proposeAction(
        'update_event',
        { eventId: upcoming.id, endAt: DateTime.formatIso(inDays(1)) },
        admin.ctx,
      );
      expect(outcome.result).toMatchObject({ error: 'invalid_arguments' });
      expect(yield* proposalCount).toBe(0);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('cancel_event: reject changes nothing; confirm cancels', () =>
    Effect.gen(function* () {
      const { teamA, admin, upcoming } = yield* setup;
      const first = yield* proposeOk('cancel_event', { eventId: upcoming.id }, admin.ctx);
      expect((yield* reject(teamA.id, first.proposalId, admin.token)).status).toBe(204);
      expect(yield* eventRow(upcoming.id)).toMatchObject({ status: 'active' });

      const second = yield* proposeOk('cancel_event', { eventId: upcoming.id }, admin.ctx);
      const response = yield* confirm(teamA.id, second.proposalId, admin.token);
      expect(response.status).toBe(200);
      expect(yield* eventRow(upcoming.id)).toMatchObject({ status: 'cancelled' });
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('a Player is refused at propose (permission), nothing written', () =>
    Effect.gen(function* () {
      const { player, upcoming } = yield* setup;
      const outcome = yield* proposeAction('cancel_event', { eventId: upcoming.id }, player.ctx);
      expect(outcome.result).toEqual({ error: 'forbidden', permission: 'event:cancel' });
      expect(yield* proposalCount).toBe(0);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect("a Captain is refused for an event of a group they don't coach (row gate)", () =>
    Effect.gen(function* () {
      const { captain, elite, coached } = yield* setup;
      for (const action of ['cancel_event', 'update_event'] as const) {
        const outcome = yield* proposeAction(
          action,
          { eventId: elite.id, ...(action === 'update_event' ? { title: 'X' } : {}) },
          captain.ctx,
        );
        expect(outcome.result).toMatchObject({ error: 'invalid_arguments' });
        expect(JSON.stringify(outcome.result)).toContain('forbidden');
      }
      expect(yield* proposalCount).toBe(0);
      // Their own group's event is fine.
      yield* proposeOk('cancel_event', { eventId: coached.id }, captain.ctx);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect("another team's event is not found", () =>
    Effect.gen(function* () {
      const { admin, foreign } = yield* setup;
      for (const action of ['cancel_event', 'mark_attendance'] as const) {
        const outcome = yield* proposeAction(
          action,
          { eventId: foreign.id, ...(action === 'mark_attendance' ? { present: ['x'] } : {}) },
          admin.ctx,
        );
        expect(outcome.result).toEqual({
          error: 'invalid_arguments',
          detail: 'eventId: no such event in this team',
        });
      }
      expect(yield* eventRow(foreign.id)).toMatchObject({ status: 'active' });
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('confirm re-checks the permission: role lost event:cancel -> 403, unchanged', () =>
    Effect.gen(function* () {
      const { sql, teamA, captain, coached } = yield* setup;
      const { proposalId } = yield* proposeOk('cancel_event', { eventId: coached.id }, captain.ctx);
      yield* sql`DELETE FROM role_permissions WHERE role_id = ${captain.roleId} AND permission = 'event:cancel'`;
      const response = yield* confirm(teamA.id, proposalId, captain.token);
      expect(response.status).toBe(403);
      expect(yield* json(response)).toEqual({ _tag: 'AiProposalActionForbidden' });
      expect(yield* eventRow(coached.id)).toMatchObject({ status: 'active' });
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('confirm re-checks the row gate: left the owner group -> 403, unchanged', () =>
    Effect.gen(function* () {
      const { sql, teamA, captain, coached, coaches } = yield* setup;
      const { proposalId } = yield* proposeOk(
        'update_event',
        { eventId: coached.id, title: 'Renamed' },
        captain.ctx,
      );
      yield* sql`DELETE FROM group_members WHERE group_id = ${coaches.id} AND team_member_id = ${captain.memberId}`;
      const response = yield* confirm(teamA.id, proposalId, captain.token);
      expect(response.status).toBe(403);
      expect(yield* eventRow(coached.id)).toMatchObject({ title: 'Coached practice' });
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('mark_attendance: names resolve, the card lists both sides, confirm saves it', () =>
    Effect.gen(function* () {
      const { sql, teamA, admin, player, player2, started } = yield* setup;
      yield* EventRsvpsRepository.asEffect().pipe(
        Effect.flatMap((r) => r.upsertRsvp(started.id, player.memberId, 'yes', Option.none())),
        Effect.orDie,
      );
      const { proposalId, summary } = yield* proposeOk(
        'mark_attendance',
        {
          eventId: started.id,
          present: ['player-910000000000000903'],
          absent: ['player-910000000000000902'],
        },
        admin.ctx,
      );
      const present = summaryValue(summary, 'present');
      const absent = summaryValue(summary, 'absent');
      expect(present).toMatchObject({ type: 'text' });
      expect(JSON.stringify(present)).toContain('player-910000000000000903');
      expect(JSON.stringify(absent)).toContain('player-910000000000000902');
      expect(yield* sql`SELECT 1 FROM event_attendance`).toHaveLength(0);

      const response = yield* confirm(teamA.id, proposalId, admin.token);
      expect(response.status).toBe(200);
      const rows = yield* sql<{ team_member_id: string; present: boolean }>`
        SELECT team_member_id, present FROM event_attendance WHERE event_id = ${started.id}
      `;
      expect(rows.find((r) => r.team_member_id === player2.memberId)?.present).toBe(true);
      expect(rows.find((r) => r.team_member_id === player.memberId)?.present).toBe(false);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('mark_attendance: a training that has not started is refused', () =>
    Effect.gen(function* () {
      const { admin, upcoming } = yield* setup;
      const outcome = yield* proposeAction(
        'mark_attendance',
        { eventId: upcoming.id, present: ['admin-910000000000000900'] },
        admin.ctx,
      );
      expect(outcome.result).toMatchObject({ error: 'invalid_arguments' });
      expect(yield* proposalCount).toBe(0);
    }).pipe(Effect.provide(SeedLayer)),
  );
});

describe('set_my_rsvp on real Postgres', () => {
  const rsvpRows = (eventId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ team_member_id: string; response: string; message: string | null }>`
        SELECT team_member_id, response, message FROM event_rsvps WHERE event_id = ${eventId}
      `;
    });

  it.effect('every member sees it; propose writes nothing; confirm sets ONLY the caller', () =>
    Effect.gen(function* () {
      const { teamA, admin, player, upcoming } = yield* setup;
      expect(visibleTools(player.ctx).map((t) => t.name)).toContain('propose_set_my_rsvp');

      // An extra member field is not a parameter: it is ignored, never honoured.
      const { proposalId, summary } = yield* proposeOk(
        'set_my_rsvp',
        { eventId: upcoming.id, response: 'yes', memberId: admin.memberId },
        player.ctx,
      );
      expect(summaryValue(summary, 'response')).toEqual({ type: 'rsvpResponse', value: 'yes' });
      expect(yield* rsvpRows(upcoming.id)).toHaveLength(0);

      const response = yield* confirm(teamA.id, proposalId, player.token);
      expect(response.status).toBe(200);
      expect(yield* json(response)).toEqual({ status: 'applied' });
      const rows = yield* rsvpRows(upcoming.id);
      expect(rows).toEqual([{ team_member_id: player.memberId, response: 'yes', message: null }]);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('the same rules as the web: note required, deadline, profile completeness', () =>
    Effect.gen(function* () {
      const { sql, teamA, player, upcoming, started } = yield* setup;
      const refusal = (args: Record<string, unknown>, ctx: ToolContext) =>
        proposeAction('set_my_rsvp', args, ctx).pipe(
          Effect.map((o) => o.result as { error?: string; detail?: string }),
        );

      const noNote = yield* refusal({ eventId: upcoming.id, response: 'maybe' }, player.ctx);
      expect(noNote).toMatchObject({ error: 'invalid_arguments' });
      expect(noNote.detail).toContain('message');
      yield* proposeOk(
        'set_my_rsvp',
        { eventId: upcoming.id, response: 'maybe', message: 'if work allows' },
        player.ctx,
      );

      const late = yield* refusal({ eventId: started.id, response: 'yes' }, player.ctx);
      expect(late.detail).toContain('closed');

      yield* sql`
        INSERT INTO team_settings (team_id, require_complete_profile) VALUES (${teamA.id}, true)
        ON CONFLICT (team_id) DO UPDATE SET require_complete_profile = true
      `;
      yield* sql`UPDATE users SET is_profile_complete = false`;
      const incomplete = yield* refusal(
        { eventId: upcoming.id, response: 'yes' },
        yield* player.refreshCtx,
      );
      expect(incomplete.detail).toContain('profile');
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('confirm re-checks: event cancelled after propose -> 404, no RSVP written', () =>
    Effect.gen(function* () {
      const { sql, teamA, player, upcoming } = yield* setup;
      const { proposalId } = yield* proposeOk(
        'set_my_rsvp',
        { eventId: upcoming.id, response: 'no' },
        player.ctx,
      );
      yield* sql`UPDATE events SET status = 'cancelled' WHERE id = ${upcoming.id}`;
      const response = yield* confirm(teamA.id, proposalId, player.token);
      expect(response.status).toBe(404);
      expect(yield* rsvpRows(upcoming.id)).toHaveLength(0);
    }).pipe(Effect.provide(SeedLayer)),
  );
});
