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
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findRoleByTeamAndName(teamId, 'Player')),
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

// ---------------------------------------------------------------------------
// T-R2 (`.work-plans/configurable-default-roles.md`) — the regression BLOCKER 1 describes.
// `findNonRespondersByEventId` / `incrementMissedForEventNonRespondersByEventId` gate on
// built-in Player today. Once a team configures a custom default (e.g. Poletime's Guest), a
// member holding ONLY that default must still be treated as an eligible new-member population —
// otherwise RSVP reminders and the missed-RSVP counter silently stop tracking them.
//
// Direct repository access (not the HTTP endpoint above): `incrementMissedForEventNonResponders`
// has no HTTP surface in this SmallApi, so both queries are exercised the same way for symmetry.
//
// Cases 1 and 3 pin the shared predicate (`holdsDefaultRoleWhere` in `effectiveRoles.ts`) now
// unioning `eff.is_default` in with the built-in Player fallback. Cases 2 and 4 are regression
// pins: they held on `main` before this change (the query already excluded Captain-only and
// already included Player-only) and must keep holding now that the predicate is a union.
// ---------------------------------------------------------------------------

const getCaptainRoleId = (teamId: Team.TeamId) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findRoleByTeamAndName(teamId, 'Captain')),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new Error('Captain role not found')),
        onSome: (r) => Effect.succeed(r.id),
      }),
    ),
  );

const insertGuestRole = (teamId: Team.TeamId) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.insertRole(teamId, 'Guest')),
    Effect.map((r) => r.id),
  );

const setTeamDefaultRole = (roleId: Role.RoleId) =>
  RolesRepository.asEffect().pipe(Effect.andThen((repo) => repo.setDefaultRole(roleId)));

const getMissedRsvps = (memberId: TeamMember.TeamMemberId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql<{ missed_rsvps: number }>`SELECT missed_rsvps FROM team_members WHERE id = ${memberId}`,
    ),
    Effect.map((rows) => rows[0]?.missed_rsvps ?? -1),
  );

/**
 * Team with a CUSTOM default (Guest, not built-in Player) plus three members:
 *   - guestMember: holds ONLY the configured default (Guest)
 *   - legacyMember: holds ONLY the built-in Player (never re-assigned after the switch)
 *   - captainMember: holds ONLY Captain (neither the default nor Player)
 */
const seedDefaultRoleRsvpFixture = () =>
  Effect.Do.pipe(
    Effect.bind('ownerUserId', () => createUser('890000000000000101', 'owner-dr-rsvp')),
    Effect.bind('team', ({ ownerUserId }) =>
      createTeam('890000000000000110' as Discord.Snowflake, ownerUserId),
    ),
    Effect.tap(({ team }) => seedRoles(team.id)),
    Effect.bind('playerRoleId', ({ team }) => getPlayerRoleId(team.id)),
    Effect.bind('captainRoleId', ({ team }) => getCaptainRoleId(team.id)),
    Effect.bind('guestRoleId', ({ team }) => insertGuestRole(team.id)),
    Effect.tap(({ guestRoleId }) => setTeamDefaultRole(guestRoleId)),

    Effect.bind('guestUserId', () => createUser('890000000000000102', 'guest-only-dr')),
    Effect.bind('guestMember', ({ team, guestUserId }) => addTeamMember(team.id, guestUserId)),
    Effect.tap(({ guestMember, guestRoleId }) => assignRole(guestMember.id, guestRoleId)),

    Effect.bind('legacyUserId', () => createUser('890000000000000103', 'legacy-player-dr')),
    Effect.bind('legacyMember', ({ team, legacyUserId }) => addTeamMember(team.id, legacyUserId)),
    Effect.tap(({ legacyMember, playerRoleId }) => assignRole(legacyMember.id, playerRoleId)),

    Effect.bind('captainUserId', () => createUser('890000000000000104', 'captain-only-dr')),
    Effect.bind('captainMember', ({ team, captainUserId }) =>
      addTeamMember(team.id, captainUserId),
    ),
    Effect.tap(({ captainMember, captainRoleId }) => assignRole(captainMember.id, captainRoleId)),

    Effect.bind('event', ({ team, guestMember }) => createEvent(team.id, guestMember.id)),
  );

describe('EventRsvpsRepository — RSVP eligibility follows the configured default role (T-R2, BLOCKER 1)', () => {
  it.effect(
    '1. a member holding ONLY the configured default (Guest) appears as a non-responder',
    () =>
      seedDefaultRoleRsvpFixture().pipe(
        Effect.bind('nonResponders', ({ event, team }) =>
          EventRsvpsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.findNonRespondersByEventId(event.id, team.id, Option.none(), 4),
            ),
          ),
        ),
        Effect.tap(({ nonResponders, guestMember }) =>
          Effect.sync(() => {
            expect(nonResponders.map((r) => r.team_member_id)).toContain(guestMember.id);
          }),
        ),
        Effect.provide(SeedLayer),
      ),
  );

  it.effect(
    '2. a legacy member holding only built-in Player STILL appears after the default moves to Guest (union, not a priority pick)',
    () =>
      seedDefaultRoleRsvpFixture().pipe(
        Effect.bind('nonResponders', ({ event, team }) =>
          EventRsvpsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.findNonRespondersByEventId(event.id, team.id, Option.none(), 4),
            ),
          ),
        ),
        Effect.tap(({ nonResponders, legacyMember }) =>
          Effect.sync(() => {
            expect(nonResponders.map((r) => r.team_member_id)).toContain(legacyMember.id);
          }),
        ),
        Effect.provide(SeedLayer),
      ),
  );

  it.effect('3. incrementMissedForEventNonResponders increments the Guest-only member', () =>
    seedDefaultRoleRsvpFixture().pipe(
      Effect.tap(({ event, team }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.incrementMissedForEventNonRespondersByEventId(event.id, team.id, Option.none()),
          ),
        ),
      ),
      Effect.bind('missed', ({ guestMember }) => getMissedRsvps(guestMember.id)),
      Effect.tap(({ missed }) =>
        Effect.sync(() => {
          expect(missed).toBe(1);
        }),
      ),
      Effect.provide(SeedLayer),
    ),
  );

  it.effect(
    '4. a member holding only Captain (neither default nor Player) still does NOT appear',
    () =>
      seedDefaultRoleRsvpFixture().pipe(
        Effect.bind('nonResponders', ({ event, team }) =>
          EventRsvpsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.findNonRespondersByEventId(event.id, team.id, Option.none(), 4),
            ),
          ),
        ),
        Effect.tap(({ nonResponders, captainMember }) =>
          Effect.sync(() => {
            expect(nonResponders.map((r) => r.team_member_id)).not.toContain(captainMember.id);
          }),
        ),
        Effect.provide(SeedLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// The stranded-cohort bug: a team's SECOND default change.
//
// `holdsDefaultRoleWhere` (`is_default OR built-in Player`) covered the FIRST change for free —
// every pre-existing member still held Player — and dropped the cohort in between on the second:
// they hold only the superseded custom role, which is no longer `is_default` and was never
// `Player`. The RSVP queries now splice `holdsRsvpEligibleRoleWhere` (the sticky
// `roles.was_default`) instead, so every cohort a team ever created stays covered.
//
// The resolver deliberately did NOT move to `was_default` — case 3 below pins that a superseded
// ex-default does not compete with the new default for the one join-time slot.
// ---------------------------------------------------------------------------

const seedSecondDefaultChangeFixture = () =>
  seedDefaultRoleRsvpFixture().pipe(
    Effect.bind('observerRoleId', ({ team }) =>
      RolesRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.insertRole(team.id, 'Observer')),
        Effect.map((r) => r.id),
      ),
    ),
    Effect.tap(({ observerRoleId }) => setTeamDefaultRole(observerRoleId)),
    Effect.bind('observerUserId', () => createUser('890000000000000105', 'observer-only-dr')),
    Effect.bind('observerMember', ({ team, observerUserId }) =>
      addTeamMember(team.id, observerUserId),
    ),
    Effect.tap(({ observerMember, observerRoleId }) =>
      assignRole(observerMember.id, observerRoleId),
    ),
  );

describe('EventRsvpsRepository — a second default change does not strand the previous cohort', () => {
  it.effect(
    '1. the Guest cohort STILL appears as non-responders after the default moves Guest → Observer',
    () =>
      seedSecondDefaultChangeFixture().pipe(
        Effect.bind('nonResponders', ({ event, team }) =>
          EventRsvpsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.findNonRespondersByEventId(event.id, team.id, Option.none(), 4),
            ),
          ),
        ),
        Effect.tap(({ nonResponders, guestMember, legacyMember, observerMember, captainMember }) =>
          Effect.sync(() => {
            const ids = nonResponders.map((r) => r.team_member_id);
            expect(ids).toContain(guestMember.id);
            expect(ids).toContain(legacyMember.id);
            expect(ids).toContain(observerMember.id);
            expect(ids).not.toContain(captainMember.id);
          }),
        ),
        Effect.provide(SeedLayer),
      ),
  );

  it.effect('2. the Guest cohort keeps accruing missed_rsvps after the second change', () =>
    seedSecondDefaultChangeFixture().pipe(
      Effect.tap(({ event, team }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.incrementMissedForEventNonRespondersByEventId(event.id, team.id, Option.none()),
          ),
        ),
      ),
      Effect.bind('missed', ({ guestMember }) => getMissedRsvps(guestMember.id)),
      Effect.tap(({ missed }) =>
        Effect.sync(() => {
          expect(missed).toBe(1);
        }),
      ),
      Effect.provide(SeedLayer),
    ),
  );

  it.effect('3. the join-time resolver still picks the CURRENT default, not a superseded one', () =>
    seedSecondDefaultChangeFixture().pipe(
      Effect.bind('resolved', ({ team }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.getDefaultRoleId(team.id)),
        ),
      ),
      Effect.tap(({ resolved, observerRoleId }) =>
        Effect.sync(() => {
          expect(Option.getOrNull(resolved)?.id).toBe(observerRoleId);
        }),
      ),
      Effect.provide(SeedLayer),
    ),
  );
});
