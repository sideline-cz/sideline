// Nastavitelná docházka (plan §6.7, §10.2, Setting 2 non-interference). The
// `event:edit`-gated `getNonResponders` endpoint (`api/event-rsvp.ts:290`)
// shares `findNonResponders` with `Event/GetRsvpReminderSummary`, but the
// `rsvp_reminder_dms` opt-out filter lives ONLY in the reminder-summary
// handler (plan §6.7). This test is the guard that fails if someone later
// "DRYs" that filter down into `findNonResponders` itself: the organiser must
// still see BOTH the opted-out and the opted-in non-responder.
//
// Real HTTP handler, real Postgres — the "SmallApi containing only the group
// under test" pattern established by `rosterDeactivateGroupManager.test.ts` /
// `teamSettingsReanchor.test.ts`.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Role, Team, TeamMember, User } from '@sideline/domain';
import { EventRsvpApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { SqlClient } from 'effect/unstable/sql';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { EventRsvpApiLive } from '~/api/event-rsvp.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
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

const SmallApi = HttpApi.make('api').add(EventRsvpApi.EventRsvpApiGroup);

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
  EventRsvpsRepository.Default,
  TeamSettingsRepository.Default,
  EventRostersRepository.Default,
  EventRosterRequestsRepository.Default,
  RostersRepository.Default,
  ChannelSyncEventsRepository.Default,
  EventSyncEventsRepository.Default,
);

const TestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(EventRsvpApiLive),
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(EventRosterProvisioningService.Default),
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
        name: 'Non-Responders Test Team',
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

const seedRoles = (teamId: Team.TeamId) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.seedTeamRolesWithPermissions(teamId)),
  );

const getPlayerRoleId = (teamId: Team.TeamId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.getPlayerRoleId(teamId)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new Error('Player role not found')),
        onSome: (r) => Effect.succeed(r.id),
      }),
    ),
  );

const assignRole = (memberId: TeamMember.TeamMemberId, roleId: Role.RoleId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.assignRole(memberId, roleId)),
  );

/** A dedicated role carrying ONLY `event:edit`, for the organiser/caller. */
const createEventEditRole = (teamId: Team.TeamId) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo
        .insertRole(teamId, 'Organiser')
        .pipe(Effect.tap((role) => repo.setRolePermissions(role.id, ['event:edit']))),
    ),
  );

const setReminderDms = (memberId: TeamMember.TeamMemberId, value: boolean) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql`UPDATE team_members SET rsvp_reminder_dms = ${value} WHERE id = ${memberId}`.pipe(
        Effect.asVoid,
      ),
    ),
  );

const createEvent = (teamId: Team.TeamId, createdBy: TeamMember.TeamMemberId) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'training',
        title: 'Non-Responders Test Event',
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

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const seedFixture = () =>
  Effect.Do.pipe(
    Effect.bind('organiserUserId', () => createUser('890000000000000001', 'organiser-nr')),
    Effect.bind('team', ({ organiserUserId }) =>
      createTeam('890000000000000010' as Discord.Snowflake, organiserUserId),
    ),
    Effect.tap(({ team }) => seedRoles(team.id)),
    Effect.bind('playerRoleId', ({ team }) => getPlayerRoleId(team.id)),
    Effect.bind('eventEditRoleId', ({ team }) => createEventEditRole(team.id)),
    Effect.bind('organiserMember', ({ team, organiserUserId }) =>
      addTeamMember(team.id, organiserUserId),
    ),
    Effect.tap(({ organiserMember, eventEditRoleId }) =>
      assignRole(organiserMember.id, eventEditRoleId.id),
    ),
    Effect.bind('optedOutUserId', () => createUser('890000000000000002', 'opted-out-nr')),
    Effect.bind('optedOutMember', ({ team, optedOutUserId }) =>
      addTeamMember(team.id, optedOutUserId),
    ),
    Effect.tap(({ optedOutMember, playerRoleId }) => assignRole(optedOutMember.id, playerRoleId)),
    Effect.tap(({ optedOutMember }) => setReminderDms(optedOutMember.id, false)),
    Effect.bind('optedInUserId', () => createUser('890000000000000003', 'opted-in-nr')),
    Effect.bind('optedInMember', ({ team, optedInUserId }) =>
      addTeamMember(team.id, optedInUserId),
    ),
    Effect.tap(({ optedInMember, playerRoleId }) => assignRole(optedInMember.id, playerRoleId)),
    // optedInMember stays at the column default (true).
    Effect.bind('event', ({ team, organiserMember }) => createEvent(team.id, organiserMember.id)),
  ).pipe(Effect.provide(SeedLayer), Effect.runPromise);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /teams/:teamId/events/:eventId/rsvps/non-responders — Setting 2 non-interference', () => {
  it('returns BOTH the opted-out and the opted-in non-responder — the organiser still sees everyone who has not answered', async () => {
    const fixture = await seedFixture();
    sessionsStore.set('organiser-token', fixture.organiserUserId);

    const response = await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/events/${fixture.event.id}/rsvps/non-responders`,
        { method: 'GET', headers: { Authorization: 'Bearer organiser-token' } },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      nonResponders: ReadonlyArray<{ teamMemberId: string }>;
    };
    const ids = body.nonResponders.map((r) => r.teamMemberId);
    expect(ids).toContain(fixture.optedOutMember.id);
    expect(ids).toContain(fixture.optedInMember.id);
    expect(ids).toHaveLength(2);
  });
});
