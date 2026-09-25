// Slice 3a of "Setup memberships" — the event-attendance HTTP routes (`api/event-attendance.ts`),
// backed by real repositories over a real Postgres instance. Pattern:
// `membershipPlans.test.ts` — a `SmallApi` built from just the one group under test, a mocked
// `SessionsRepository` for auth, and every other repository real.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Event, GroupModel, Role, Team, TeamMember, User } from '@sideline/domain';
import { EventAttendanceApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { SqlClient } from 'effect/unstable/sql';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { EventAttendanceApiLive } from '~/api/event-attendance.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const SmallApi = HttpApi.make('api').add(EventAttendanceApi.EventAttendanceApiGroup);

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

const RealRepos = Layer.mergeAll(
  UsersRepository.Default,
  TeamsRepository.Default,
  TeamMembersRepository.Default,
  RolesRepository.Default,
  GroupsRepository.Default,
  EventsRepository.Default,
);

const TestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(EventAttendanceApiLive),
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockSessionsRepositoryLayer),
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

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

let discordIdCounter = 880_000_000_000_000_000n;
const nextDiscordId = (): Discord.Snowflake => (discordIdCounter++).toString() as Discord.Snowflake;

const createUser = (username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: nextDiscordId(),
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
    Effect.map((u) => u.id),
  );

const createTeam = (createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Attendance API Team',
        guild_id: nextDiscordId(),
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

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
    Effect.map((tm) => tm.id),
  );

const createRoleWithPermissions = (
  teamId: Team.TeamId,
  name: string,
  permissions: ReadonlyArray<Role.Permission>,
) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertRole(teamId, name).pipe(
        Effect.tap((role) => repo.setRolePermissions(role.id, permissions)),
        Effect.map((role) => role.id),
      ),
    ),
  );

const assignRoleDirect = (memberId: TeamMember.TeamMemberId, roleId: Role.RoleId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.assignRole(memberId, roleId)),
  );

const createGroup = (teamId: Team.TeamId, name: string) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertGroup(teamId, name, Option.none(), Option.none(), Option.none()),
    ),
  );

const addGroupMember = (groupId: GroupModel.GroupId, teamMemberId: TeamMember.TeamMemberId) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.addMemberById(groupId, teamMemberId)),
  );

/** Raw RSVP insert. Guarantees the member is a candidate via the `OR EXISTS (event_rsvps)`
 * escape hatch, independent of whatever role the fixture happened to assign. */
const insertRsvp = (eventId: Event.EventId, memberId: TeamMember.TeamMemberId, response: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        INSERT INTO event_rsvps (event_id, team_member_id, response)
        VALUES (${eventId}, ${memberId}, ${response})
      `,
    ),
  );

const PAST = DateTime.makeUnsafe('2024-01-01T18:00:00.000Z');
const FUTURE = DateTime.makeUnsafe('2099-12-31T18:00:00.000Z');

const createEvent = (
  teamId: Team.TeamId,
  createdBy: TeamMember.TeamMemberId,
  options: {
    readonly ownerGroupId?: Option.Option<GroupModel.GroupId>;
    readonly startAt?: DateTime.Utc;
    readonly eventType?: string;
  } = {},
) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: options.eventType ?? 'training',
        title: 'Attendance API Test Event',
        description: Option.none(),
        startAt: options.startAt ?? PAST,
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId: options.ownerGroupId ?? Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy,
      }),
    ),
  );

const cancelEvent = (eventId: string) =>
  EventsRepository.asEffect().pipe(Effect.andThen((repo) => repo.cancelEvent(eventId as never)));

const runSeeded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SeedLayer)) as Effect.Effect<A, E, never>);

/** A fresh team, a "creator" member (also used as event creator), plus an actor member whose
 * own custom role carries exactly `withPermissions`. */
const seedFixture = (withPermissions: ReadonlyArray<Role.Permission> = []) =>
  runSeeded(
    Effect.Do.pipe(
      Effect.bind('creatorUserId', () => createUser('att-api-creator')),
      Effect.bind('team', ({ creatorUserId }) => createTeam(creatorUserId)),
      Effect.bind('creatorMemberId', ({ team, creatorUserId }) =>
        addTeamMember(team.id, creatorUserId),
      ),
      Effect.bind('actorUserId', () => createUser('att-api-actor')),
      Effect.bind('actorMemberId', ({ team, actorUserId }) => addTeamMember(team.id, actorUserId)),
      Effect.bind('roleId', ({ team }) =>
        createRoleWithPermissions(team.id, 'Actor role', withPermissions),
      ),
      Effect.tap(({ actorMemberId, roleId }) => assignRoleDirect(actorMemberId, roleId)),
    ),
  );

const rawAttendanceRows = (eventId: string) =>
  runSeeded(
    SqlClient.SqlClient.asEffect().pipe(
      Effect.andThen(
        (sql) =>
          sql<{
            team_member_id: string;
            present: boolean;
          }>`SELECT team_member_id, present FROM event_attendance WHERE event_id = ${eventId}`,
      ),
    ),
  );

const asJson = async (response: Response) => response.json();

const getAttendance = (teamId: string, eventId: string, token: string) =>
  handler(
    new Request(`http://localhost/teams/${teamId}/events/${eventId}/attendance`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );

const putAttendance = (
  teamId: string,
  eventId: string,
  token: string,
  entries: ReadonlyArray<{ teamMemberId: string; present: boolean }>,
) =>
  handler(
    new Request(`http://localhost/teams/${teamId}/events/${eventId}/attendance`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    }),
  );

// ---------------------------------------------------------------------------
// 22-23. Read access
// ---------------------------------------------------------------------------

describe('GET /teams/:teamId/events/:eventId/attendance — read access', () => {
  it('a plain member (no event:edit, no finance:view) gets 200, canConfirm false, entries returned', async () => {
    const fixture = await seedFixture([]);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const event = await runSeeded(createEvent(fixture.team.id, fixture.creatorMemberId));

    const response = await getAttendance(fixture.team.id, event.id, 'actor-token');

    // NOT a 403: the web event page loads this for every event, so failing here would log a
    // warning on every page view by every ordinary player. They get the same empty shape a
    // non-training event returns. Asserting entries is EMPTY, not merely an array — that is
    // what distinguishes "allowed to read nothing" from "allowed to read the list".
    expect(response.status).toBe(200);
    const body = await asJson(response);
    expect(body.canConfirm).toBe(false);
    expect(body.entries).toEqual([]);
  });

  it('a member with finance:view only (Treasurer shape) gets 200, canConfirm false, and CAN read the list', async () => {
    const fixture = await seedFixture(['finance:view']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const event = await runSeeded(createEvent(fixture.team.id, fixture.creatorMemberId));
    // Guarantees at least one candidate regardless of the fixture's role shape, so the
    // assertion below discriminates the read gate rather than an empty population.
    await runSeeded(insertRsvp(event.id, fixture.actorMemberId, 'yes'));

    const response = await getAttendance(fixture.team.id, event.id, 'actor-token');

    expect(response.status).toBe(200);
    expect((await asJson(response)).canConfirm).toBe(false);
  });

  it('the finance:view read actually returns rows where a plain member gets none', async () => {
    const plain = await seedFixture([]);
    const treasurer = await seedFixture(['finance:view']);
    sessionsStore.set('plain-token', plain.actorUserId);
    sessionsStore.set('treasurer-token', treasurer.actorUserId);
    const plainEvent = await runSeeded(createEvent(plain.team.id, plain.creatorMemberId));
    const treasurerEvent = await runSeeded(
      createEvent(treasurer.team.id, treasurer.creatorMemberId),
    );
    await runSeeded(insertRsvp(plainEvent.id, plain.actorMemberId, 'yes'));
    await runSeeded(insertRsvp(treasurerEvent.id, treasurer.actorMemberId, 'yes'));

    const plainBody = await asJson(
      await getAttendance(plain.team.id, plainEvent.id, 'plain-token'),
    );
    const treasurerBody = await asJson(
      await getAttendance(treasurer.team.id, treasurerEvent.id, 'treasurer-token'),
    );

    expect(plainBody.entries).toEqual([]);
    expect(treasurerBody.entries.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 24-26. Owner-group-scoped confirm permission
// ---------------------------------------------------------------------------

describe('event-attendance — owner-group-scoped confirm permission', () => {
  it('a Captain (event:edit) IN the owner group: GET canConfirm true, PUT 204', async () => {
    const fixture = await seedFixture(['event:edit']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const ownerGroup = await runSeeded(createGroup(fixture.team.id, 'Owner Group'));
    await runSeeded(addGroupMember(ownerGroup.id, fixture.actorMemberId as never));
    const event = await runSeeded(
      createEvent(fixture.team.id, fixture.creatorMemberId, {
        ownerGroupId: Option.some(ownerGroup.id),
      }),
    );

    const getResponse = await getAttendance(fixture.team.id, event.id, 'actor-token');
    expect(getResponse.status).toBe(200);
    const getBody = await asJson(getResponse);
    expect(getBody.canConfirm).toBe(true);

    const putResponse = await putAttendance(fixture.team.id, event.id, 'actor-token', [
      { teamMemberId: fixture.creatorMemberId, present: true },
    ]);
    expect(putResponse.status).toBe(204);
  });

  it('a Captain (event:edit) OUTSIDE the owner group, not admin: PUT 403', async () => {
    const fixture = await seedFixture(['event:edit']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const ownerGroup = await runSeeded(createGroup(fixture.team.id, 'Owner Group'));
    // actor is deliberately NOT added to ownerGroup.
    const event = await runSeeded(
      createEvent(fixture.team.id, fixture.creatorMemberId, {
        ownerGroupId: Option.some(ownerGroup.id),
      }),
    );

    const response = await putAttendance(fixture.team.id, event.id, 'actor-token', [
      { teamMemberId: fixture.creatorMemberId, present: true },
    ]);

    expect(response.status).toBe(403);
  });

  it('a Treasurer (finance:manage_fees, no event:edit): PUT 403', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const event = await runSeeded(createEvent(fixture.team.id, fixture.creatorMemberId));

    const response = await putAttendance(fixture.team.id, event.id, 'actor-token', [
      { teamMemberId: fixture.creatorMemberId, present: true },
    ]);

    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 27. Non-member
// ---------------------------------------------------------------------------

describe('event-attendance — non-member access', () => {
  it('a non-member gets 403 on GET', async () => {
    const fixture = await seedFixture([]);
    const outsiderUserId = await runSeeded(createUser('att-api-outsider'));
    sessionsStore.set('outsider-token', outsiderUserId);
    const event = await runSeeded(createEvent(fixture.team.id, fixture.creatorMemberId));

    const response = await getAttendance(fixture.team.id, event.id, 'outsider-token');

    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 28-29. Event-state guards
// ---------------------------------------------------------------------------

describe('event-attendance — event-state guards', () => {
  it(
    'a NON-TRAINING event: GET 200 with canConfirm false and entries [] (not a 403/404 — the ' +
      'web loader calls this for every event); PUT 409',
    async () => {
      const fixture = await seedFixture(['event:edit']);
      sessionsStore.set('actor-token', fixture.actorUserId);
      const event = await runSeeded(
        createEvent(fixture.team.id, fixture.creatorMemberId, { eventType: 'match' }),
      );

      const getResponse = await getAttendance(fixture.team.id, event.id, 'actor-token');
      expect(getResponse.status).toBe(200);
      const getBody = await asJson(getResponse);
      expect(getBody.canConfirm).toBe(false);
      expect(getBody.entries).toEqual([]);

      const putResponse = await putAttendance(fixture.team.id, event.id, 'actor-token', [
        { teamMemberId: fixture.creatorMemberId, present: true },
      ]);
      expect(putResponse.status).toBe(409);
    },
  );

  it('a CANCELLED event: PUT 409', async () => {
    const fixture = await seedFixture(['event:edit']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const event = await runSeeded(createEvent(fixture.team.id, fixture.creatorMemberId));
    await runSeeded(cancelEvent(event.id));

    const response = await putAttendance(fixture.team.id, event.id, 'actor-token', [
      { teamMemberId: fixture.creatorMemberId, present: true },
    ]);

    expect(response.status).toBe(409);
  });

  it('a FUTURE-dated event: PUT 409', async () => {
    const fixture = await seedFixture(['event:edit']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const event = await runSeeded(
      createEvent(fixture.team.id, fixture.creatorMemberId, { startAt: FUTURE }),
    );

    const response = await putAttendance(fixture.team.id, event.id, 'actor-token', [
      { teamMemberId: fixture.creatorMemberId, present: true },
    ]);

    expect(response.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// 30. Cross-team event id -> 404
// ---------------------------------------------------------------------------

describe('event-attendance — cross-team event id is 404, not a leak', () => {
  it('GET and PUT with an event belonging to ANOTHER team both -> 404', async () => {
    const fixtureA = await seedFixture(['event:edit']);
    const fixtureB = await seedFixture(['event:edit']);
    const eventB = await runSeeded(createEvent(fixtureB.team.id, fixtureB.creatorMemberId));
    sessionsStore.set('actor-a-token', fixtureA.actorUserId);

    const getResponse = await getAttendance(fixtureA.team.id, eventB.id, 'actor-a-token');
    expect(getResponse.status).toBe(404);

    const putResponse = await putAttendance(fixtureA.team.id, eventB.id, 'actor-a-token', [
      { teamMemberId: fixtureA.creatorMemberId, present: true },
    ]);
    expect(putResponse.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 31-32. Round-trip and re-confirm idempotency
// ---------------------------------------------------------------------------

describe('event-attendance — PUT then GET round-trip', () => {
  it('confirmed present/absent values come back, confirmedAt is set', async () => {
    const fixture = await seedFixture(['event:edit']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const presentUserId = await runSeeded(createUser('att-api-present'));
    const presentMemberId = await runSeeded(addTeamMember(fixture.team.id, presentUserId));
    const absentUserId = await runSeeded(createUser('att-api-absent'));
    const absentMemberId = await runSeeded(addTeamMember(fixture.team.id, absentUserId));
    const event = await runSeeded(createEvent(fixture.team.id, fixture.creatorMemberId));

    const putResponse = await putAttendance(fixture.team.id, event.id, 'actor-token', [
      { teamMemberId: presentMemberId, present: true },
      { teamMemberId: absentMemberId, present: false },
    ]);
    expect(putResponse.status).toBe(204);

    const getResponse = await getAttendance(fixture.team.id, event.id, 'actor-token');
    expect(getResponse.status).toBe(200);
    const body = await asJson(getResponse);
    expect(body.confirmedAt).not.toBeNull();
    const present = body.entries.find(
      (e: { teamMemberId: string }) => e.teamMemberId === presentMemberId,
    );
    const absent = body.entries.find(
      (e: { teamMemberId: string }) => e.teamMemberId === absentMemberId,
    );
    expect(present.present).toBe(true);
    expect(absent.present).toBe(false);
  });

  it('re-confirming with different values is idempotent in shape: row count unchanged, values updated', async () => {
    const fixture = await seedFixture(['event:edit']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const memberUserId = await runSeeded(createUser('att-api-reconfirm'));
    const memberId = await runSeeded(addTeamMember(fixture.team.id, memberUserId));
    const event = await runSeeded(createEvent(fixture.team.id, fixture.creatorMemberId));

    const first = await putAttendance(fixture.team.id, event.id, 'actor-token', [
      { teamMemberId: memberId, present: true },
    ]);
    expect(first.status).toBe(204);
    const rowsAfterFirst = await rawAttendanceRows(event.id);
    expect(rowsAfterFirst).toHaveLength(1);

    const second = await putAttendance(fixture.team.id, event.id, 'actor-token', [
      { teamMemberId: memberId, present: false },
    ]);
    expect(second.status).toBe(204);
    const rowsAfterSecond = await rawAttendanceRows(event.id);
    expect(rowsAfterSecond).toHaveLength(1);
    expect(rowsAfterSecond[0]?.present).toBe(false);
  });
});
