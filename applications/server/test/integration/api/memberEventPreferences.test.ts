// Nastavitelná docházka (plan §5.6, §6.4, §6.5, §10.2). `getMyEventPreferences`
// / `updateMyEventPreferences` (`/teams/:teamId/me/event-preferences`) are the
// server contract the web card is built on (`design.md` §A). Covers:
//   1. GET defaults for a fresh member.
//   2. personalChannelsAvailable reflects team_settings.discord_personal_events_category_id.
//   2b. personalChannelsAvailable is advisory — GET/PATCH keep working when it's false.
//   3. PATCH persists all three fields; response is a real MemberEventPreferences.
//   4. PATCH changing showAttendeeList dirties upcoming/active events, not past/cancelled.
//   5. PATCH changing only rsvpReminderDms/personalChannelsSplit leaves the dirty mark alone (S6).
//   6. Non-member → 403; cross-team isolation.
//
// Real HTTP handler, real Postgres — the "SmallApi" pattern.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { TeamApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { SqlClient } from 'effect/unstable/sql';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { TeamApiLive } from '~/api/team.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const SmallApi = HttpApi.make('api').add(TeamApi.TeamApiGroup);

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
  BotGuildsRepository.Default,
  TeamSettingsRepository.Default,
  EventsRepository.Default,
);

const TestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(TeamApiLive),
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

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Event Preferences Test Team',
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

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
  );

const setTeamPersonalEventsCategory = (
  teamId: Team.TeamId,
  categoryId: Option.Option<Discord.Snowflake>,
) =>
  TeamSettingsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsert({
        teamId,
        eventHorizonDays: 30,
        minPlayersThreshold: 0,
        discordPersonalEventsCategoryId: categoryId,
      }),
    ),
  );

const insertUpcomingEvent = (teamId: Team.TeamId, createdBy: any) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'training',
        title: 'Upcoming Event',
        description: Option.none(),
        startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy,
      }),
    ),
  );

const insertPastEvent = (teamId: Team.TeamId, createdBy: any) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'training',
        title: 'Past Event',
        description: Option.none(),
        startAt: DateTime.fromDateUnsafe(new Date('2020-01-01T18:00:00Z')),
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy,
      }),
    ),
  );

const insertCancelledEvent = (teamId: Team.TeamId, createdBy: any) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo
        .insertEvent({
          teamId,
          eventType: 'training',
          title: 'Cancelled Event',
          description: Option.none(),
          startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
          endAt: Option.none(),
          location: Option.none(),
          ownerGroupId: Option.none(),
          memberGroupId: Option.none(),
          trainingTypeId: Option.none(),
          seriesId: Option.none(),
          createdBy,
        })
        .pipe(Effect.tap((event) => repo.cancelEvent(event.id))),
    ),
  );

const getDirtyAt = (eventId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql<{ personal_messages_dirty_at: Date | null }>`
        SELECT personal_messages_dirty_at FROM events WHERE id = ${eventId}
      `.pipe(Effect.map((rows) => rows[0]?.personal_messages_dirty_at ?? null)),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /teams/:teamId/me/event-preferences', () => {
  it('a fresh member reads the column defaults', async () => {
    const seed = await Effect.Do.pipe(
      Effect.bind('userId', () => createUser('910000000000000001', 'prefs-fresh')),
      Effect.bind('team', ({ userId }) =>
        createTeam('910000000000000010' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.tap(({ team }) =>
        setTeamPersonalEventsCategory(
          team.id,
          Option.some('910999999999999999' as Discord.Snowflake),
        ),
      ),
      Effect.provide(SeedLayer),
      Effect.runPromise,
    );
    sessionsStore.set('token-1', seed.userId);

    const response = await handler(
      new Request(`http://localhost/teams/${seed.team.id}/me/event-preferences`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token-1' },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      showAttendeeList: true,
      rsvpReminderDms: true,
      personalChannelsSplit: false,
      personalChannelsAvailable: true,
    });
  });

  it('personalChannelsAvailable is false when no category is configured, true when it is', async () => {
    const seed = await Effect.Do.pipe(
      Effect.bind('userId', () => createUser('911000000000000001', 'prefs-avail')),
      Effect.bind('team', ({ userId }) =>
        createTeam('911000000000000010' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.provide(SeedLayer),
      Effect.runPromise,
    );
    sessionsStore.set('token-2', seed.userId);

    const noCategoryResponse = await handler(
      new Request(`http://localhost/teams/${seed.team.id}/me/event-preferences`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token-2' },
      }),
    );
    expect((await noCategoryResponse.json()).personalChannelsAvailable).toBe(false);

    await setTeamPersonalEventsCategory(
      seed.team.id,
      Option.some('911999999999999999' as Discord.Snowflake),
    ).pipe(Effect.provide(SeedLayer), Effect.runPromise);

    const withCategoryResponse = await handler(
      new Request(`http://localhost/teams/${seed.team.id}/me/event-preferences`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token-2' },
      }),
    );
    expect((await withCategoryResponse.json()).personalChannelsAvailable).toBe(true);
  });

  it('personalChannelsAvailable: false → GET still returns showAttendeeList/rsvpReminderDms, and PATCH still persists all three fields (advisory only, plan §6.5)', async () => {
    const seed = await Effect.Do.pipe(
      Effect.bind('userId', () => createUser('912000000000000001', 'prefs-noavail')),
      Effect.bind('team', ({ userId }) =>
        createTeam('912000000000000010' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.provide(SeedLayer),
      Effect.runPromise,
    );
    sessionsStore.set('token-3', seed.userId);

    const getResponse = await handler(
      new Request(`http://localhost/teams/${seed.team.id}/me/event-preferences`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token-3' },
      }),
    );
    const getBody = await getResponse.json();
    expect(getBody.personalChannelsAvailable).toBe(false);
    expect(getBody.showAttendeeList).toBe(true);
    expect(getBody.rsvpReminderDms).toBe(true);

    const patchResponse = await handler(
      new Request(`http://localhost/teams/${seed.team.id}/me/event-preferences`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer token-3', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          showAttendeeList: false,
          rsvpReminderDms: false,
          personalChannelsSplit: true,
        }),
      }),
    );
    expect(patchResponse.status).toBe(200);
    const patchBody = await patchResponse.json();
    expect(patchBody).toMatchObject({
      showAttendeeList: false,
      rsvpReminderDms: false,
      personalChannelsSplit: true,
      personalChannelsAvailable: false,
    });
  });
});

describe('PATCH /teams/:teamId/me/event-preferences', () => {
  it('persists all three fields; the response is a real MemberEventPreferences instance', async () => {
    const seed = await Effect.Do.pipe(
      Effect.bind('userId', () => createUser('913000000000000001', 'prefs-patch')),
      Effect.bind('team', ({ userId }) =>
        createTeam('913000000000000010' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.provide(SeedLayer),
      Effect.runPromise,
    );
    sessionsStore.set('token-4', seed.userId);

    const response = await handler(
      new Request(`http://localhost/teams/${seed.team.id}/me/event-preferences`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer token-4', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          showAttendeeList: false,
          rsvpReminderDms: false,
          personalChannelsSplit: true,
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.showAttendeeList).toBe(false);
    expect(body.rsvpReminderDms).toBe(false);
    expect(body.personalChannelsSplit).toBe(true);

    // Persisted, not just echoed — a subsequent GET reads the same values back.
    const getResponse = await handler(
      new Request(`http://localhost/teams/${seed.team.id}/me/event-preferences`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token-4' },
      }),
    );
    const getBody = await getResponse.json();
    expect(getBody.showAttendeeList).toBe(false);
    expect(getBody.rsvpReminderDms).toBe(false);
    expect(getBody.personalChannelsSplit).toBe(true);
  });

  it("changing showAttendeeList sets personal_messages_dirty_at on the team's upcoming/active events, and NOT on past/cancelled ones", async () => {
    const seed = await Effect.Do.pipe(
      Effect.bind('userId', () => createUser('914000000000000001', 'prefs-dirty')),
      Effect.bind('team', ({ userId }) =>
        createTeam('914000000000000010' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('upcoming', ({ team, member }) => insertUpcomingEvent(team.id, member.id)),
      Effect.bind('past', ({ team, member }) => insertPastEvent(team.id, member.id)),
      Effect.bind('cancelled', ({ team, member }) => insertCancelledEvent(team.id, member.id)),
      Effect.provide(SeedLayer),
      Effect.runPromise,
    );
    sessionsStore.set('token-5', seed.userId);

    const response = await handler(
      new Request(`http://localhost/teams/${seed.team.id}/me/event-preferences`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer token-5', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          showAttendeeList: false, // changed from the default true
          rsvpReminderDms: true,
          personalChannelsSplit: false,
        }),
      }),
    );
    expect(response.status).toBe(200);

    const upcomingDirty = await getDirtyAt(seed.upcoming.id).pipe(
      Effect.provide(SeedLayer),
      Effect.runPromise,
    );
    const pastDirty = await getDirtyAt(seed.past.id).pipe(
      Effect.provide(SeedLayer),
      Effect.runPromise,
    );
    const cancelledDirty = await getDirtyAt(seed.cancelled.id).pipe(
      Effect.provide(SeedLayer),
      Effect.runPromise,
    );

    expect(upcomingDirty).not.toBeNull();
    expect(pastDirty).toBeNull();
    expect(cancelledDirty).toBeNull();
  });

  it('S6: changing ONLY rsvpReminderDms or ONLY personalChannelsSplit leaves personal_messages_dirty_at untouched', async () => {
    const seed = await Effect.Do.pipe(
      Effect.bind('userId', () => createUser('915000000000000001', 'prefs-s6')),
      Effect.bind('team', ({ userId }) =>
        createTeam('915000000000000010' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('upcoming', ({ team, member }) => insertUpcomingEvent(team.id, member.id)),
      Effect.provide(SeedLayer),
      Effect.runPromise,
    );
    sessionsStore.set('token-6', seed.userId);

    // showAttendeeList stays at its current value (true, unchanged); only the other two flip.
    const response = await handler(
      new Request(`http://localhost/teams/${seed.team.id}/me/event-preferences`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer token-6', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          showAttendeeList: true,
          rsvpReminderDms: false,
          personalChannelsSplit: true,
        }),
      }),
    );
    expect(response.status).toBe(200);

    const dirty = await getDirtyAt(seed.upcoming.id).pipe(
      Effect.provide(SeedLayer),
      Effect.runPromise,
    );
    expect(dirty).toBeNull();
  });

  it("a non-member gets 403; a member of team A cannot read team B's preferences", async () => {
    const seed = await Effect.Do.pipe(
      Effect.bind('userA', () => createUser('916000000000000001', 'prefs-cross-a')),
      Effect.bind('userB', () => createUser('916000000000000002', 'prefs-cross-b')),
      Effect.bind('teamA', ({ userA }) =>
        createTeam('916000000000000010' as Discord.Snowflake, userA),
      ),
      Effect.bind('teamB', ({ userB }) =>
        createTeam('916000000000000011' as Discord.Snowflake, userB),
      ),
      Effect.tap(({ teamA, userA }) => addTeamMember(teamA.id, userA)),
      // userB is a member of teamB only, NOT teamA.
      Effect.tap(({ teamB, userB }) => addTeamMember(teamB.id, userB)),
      Effect.provide(SeedLayer),
      Effect.runPromise,
    );
    sessionsStore.set('token-b', seed.userB);

    const response = await handler(
      new Request(`http://localhost/teams/${seed.teamA.id}/me/event-preferences`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token-b' },
      }),
    );
    expect(response.status).toBe(403);
  });
});
