// Regression: roster endpoints are routed `/teams/:teamId/rosters/:rosterId/...` but used to look
// the roster up by id alone. A member holding `roster:view` / `roster:manage` in team A could read
// or change team B's roster by putting team A's id and team B's roster id in the URL (or, for
// `linkEventRoster`, team B's roster id in the body). The event-roster link endpoints had the same
// gap for `:eventId`. Every such request must now 404 — exactly as if the resource did not exist —
// and leave team B's data untouched.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Role, Team, TeamMember, User } from '@sideline/domain';
import { EventRosterApi, Roster } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { SqlClient } from 'effect/unstable/sql';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { EventRosterApiLive } from '~/api/event-roster.js';
import { RosterApiLive } from '~/api/roster.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { EventRosterRequestsRepository } from '~/repositories/EventRosterRequestsRepository.js';
import { EventRostersRepository } from '~/repositories/EventRostersRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { EventRosterProvisioningService } from '~/services/EventRosterProvisioningService.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const SmallApi = HttpApi.make('api')
  .add(Roster.RosterApiGroup)
  .add(EventRosterApi.EventRosterApiGroup);

let sessionsStore: Map<string, User.UserId>;

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
} as any);

// approve/decline must be refused before they ever reach the provisioning service.
const noopMockLayer = <T>(tag: T) =>
  Layer.succeed(tag as any, new Proxy({}, { get: () => () => Effect.void }));

const RealRepos = Layer.mergeAll(
  UsersRepository.Default,
  TeamsRepository.Default,
  TeamMembersRepository.Default,
  RolesRepository.Default,
  GroupsRepository.Default,
  RostersRepository.Default,
  TeamSettingsRepository.Default,
  ChannelSyncEventsRepository.Default,
  DiscordChannelsRepository.Default,
  DiscordChannelMappingRepository.Default,
  EventsRepository.Default,
  EventRostersRepository.Default,
  EventRosterRequestsRepository.Default,
  EventRsvpsRepository.Default,
  EventSyncEventsRepository.Default,
);

const TestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(RosterApiLive),
  Layer.provide(EventRosterApiLive),
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(noopMockLayer(EventRosterProvisioningService)),
  Layer.provide(RealRepos),
  Layer.provideMerge(TestPgClient),
);

const SeedLayer = RealRepos.pipe(Layer.provideMerge(TestPgClient));

let handler: (...args: any) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  const app = HttpRouter.toWebHandler(TestLayer);
  handler = app.handler;
  dispose = app.dispose;
});

afterAll(async () => {
  await dispose();
});

beforeEach(async () => {
  await cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise);
  sessionsStore = new Map();
});

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId as Discord.Snowflake,
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
    Effect.map((u) => u.id),
  );

const createTeam = (guildId: string, createdBy: User.UserId, name: string) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name,
        guild_id: guildId as Discord.Snowflake,
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
    Effect.map((t) => t.id),
  );

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
    Effect.map((tm) => tm.id),
  );

const grantPermissions = (
  teamId: Team.TeamId,
  memberId: TeamMember.TeamMemberId,
  permissions: ReadonlyArray<Role.Permission>,
) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((roles) =>
      roles.insertRole(teamId, 'Roster Manager').pipe(
        Effect.tap((role) => roles.setRolePermissions(role.id, permissions)),
        Effect.andThen((role) =>
          TeamMembersRepository.asEffect().pipe(
            Effect.andThen((members) => members.assignRole(memberId, role.id)),
          ),
        ),
      ),
    ),
  );

const createRoster = (teamId: Team.TeamId, name: string) =>
  RostersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        team_id: teamId,
        name,
        active: true,
        color: Option.none(),
        emoji: Option.none(),
      }),
    ),
    Effect.map((r) => r.id),
  );

const createEvent = (teamId: Team.TeamId, createdBy: TeamMember.TeamMemberId) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'tournament',
        title: 'Tournament',
        description: Option.none(),
        startAt: DateTime.fromDateUnsafe(new Date('2099-07-01T10:00:00Z')),
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy,
      }),
    ),
    Effect.map((e) => e.id),
  );

// Team A: the attacker, with `roster:view` + `roster:manage` there. Team B: a victim team the
// attacker is not a member of, with a roster linked to an event and one pending roster request.
const seedFixture = () =>
  Effect.Do.pipe(
    Effect.bind('attackerUserId', () => createUser('820000000000000001', 'cross-team-attacker')),
    Effect.bind('victimUserId', () => createUser('820000000000000002', 'cross-team-victim')),
    Effect.bind('teamA', ({ attackerUserId }) =>
      createTeam('821010101010101010', attackerUserId, 'Team A'),
    ),
    Effect.bind('teamB', ({ victimUserId }) =>
      createTeam('822020202020202020', victimUserId, 'Team B'),
    ),
    Effect.bind('attackerMemberId', ({ teamA, attackerUserId }) =>
      addTeamMember(teamA, attackerUserId),
    ),
    Effect.tap(({ teamA, attackerMemberId }) =>
      grantPermissions(teamA, attackerMemberId, ['roster:view', 'roster:manage']),
    ),
    Effect.bind('eventA', ({ teamA, attackerMemberId }) => createEvent(teamA, attackerMemberId)),
    Effect.bind('victimMemberId', ({ teamB, victimUserId }) => addTeamMember(teamB, victimUserId)),
    Effect.bind('rosterB', ({ teamB }) => createRoster(teamB, 'Team B Squad')),
    Effect.bind('eventB', ({ teamB, victimMemberId }) => createEvent(teamB, victimMemberId)),
    Effect.tap(({ eventB, rosterB }) =>
      EventRostersRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.link({ eventId: eventB, rosterId: rosterB, autoApprove: false }),
        ),
      ),
    ),
    Effect.tap(({ eventB, rosterB, victimMemberId }) =>
      EventRosterRequestsRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.upsertPending(eventB, rosterB, victimMemberId, false)),
      ),
    ),
    Effect.bind('requestB', ({ eventB, victimMemberId }) =>
      EventRosterRequestsRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findByEventAndMember(eventB, victimMemberId)),
        Effect.map(Option.getOrThrow),
      ),
    ),
    Effect.provide(SeedLayer),
    Effect.runPromise,
  );

const query = <A extends object>(
  f: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>,
) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(f),
    Effect.provide(TestPgClient),
    Effect.runPromise,
  );

const send = (method: string, path: string, body?: unknown) =>
  handler(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        Authorization: 'Bearer attacker-token',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }),
  );

describe('roster endpoints refuse a roster that belongs to another team', () => {
  it('404s every /teams/A/rosters/<B roster> endpoint and leaves team B untouched', async () => {
    const f = await seedFixture();
    sessionsStore.set('attacker-token', f.attackerUserId);
    const base = `/teams/${f.teamA}/rosters/${f.rosterB}`;

    expect((await send('GET', base)).status).toBe(404);
    expect(
      (await send('PATCH', base, { name: 'pwned', active: null, color: null, emoji: null })).status,
    ).toBe(404);
    expect((await send('POST', `${base}/channel`)).status).toBe(404);
    expect((await send('POST', `${base}/sync-role-members`)).status).toBe(404);
    expect((await send('DELETE', base)).status).toBe(404);

    const rosters = await query<{ name: string; active: boolean }>(
      (sql) => sql`SELECT name, active FROM rosters WHERE id = ${f.rosterB}`,
    );
    expect(rosters).toEqual([{ name: 'Team B Squad', active: true }]);
    const syncEvents = await query<{ id: string }>(
      (sql) => sql`SELECT id FROM channel_sync_events WHERE roster_id = ${f.rosterB}`,
    );
    expect(syncEvents).toEqual([]);
  });

  it('404s the roster-request endpoints and leaves the pending request alone', async () => {
    const f = await seedFixture();
    sessionsStore.set('attacker-token', f.attackerUserId);
    const base = `/teams/${f.teamA}/rosters/${f.rosterB}/requests`;

    expect((await send('GET', base)).status).toBe(404);
    expect((await send('POST', `${base}/${f.requestB.id}/approve`)).status).toBe(404);
    expect((await send('POST', `${base}/${f.requestB.id}/decline`)).status).toBe(404);

    const requests = await query<{ status: string }>(
      (sql) => sql`SELECT status FROM event_roster_requests WHERE id = ${f.requestB.id}`,
    );
    expect(requests).toEqual([{ status: 'pending' }]);
  });

  it('404s linking a team A event to a team B roster', async () => {
    const f = await seedFixture();
    sessionsStore.set('attacker-token', f.attackerUserId);

    const response = await send('POST', `/teams/${f.teamA}/events/${f.eventA}/roster`, {
      rosterId: f.rosterB,
      autoApprove: true,
    });
    expect(response.status).toBe(404);

    const links = await query<{ id: string }>(
      (sql) => sql`SELECT id FROM event_rosters WHERE event_id = ${f.eventA}`,
    );
    expect(links).toEqual([]);
  });

  it('404s reading, patching and unlinking a team B event roster link through team A', async () => {
    const f = await seedFixture();
    sessionsStore.set('attacker-token', f.attackerUserId);
    const path = `/teams/${f.teamA}/events/${f.eventB}/roster`;

    expect((await send('GET', path)).status).toBe(404);
    expect((await send('PATCH', path, { autoApprove: true })).status).toBe(404);
    expect((await send('DELETE', path)).status).toBe(404);

    const links = await query<{ auto_approve: boolean }>(
      (sql) => sql`SELECT auto_approve FROM event_rosters WHERE event_id = ${f.eventB}`,
    );
    expect(links).toEqual([{ auto_approve: false }]);
    const requests = await query<{ status: string }>(
      (sql) => sql`SELECT status FROM event_roster_requests WHERE id = ${f.requestB.id}`,
    );
    expect(requests).toEqual([{ status: 'pending' }]);
  });
});
