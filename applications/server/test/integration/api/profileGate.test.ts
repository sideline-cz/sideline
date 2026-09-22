// TDD mode — Task 3 of `.work-plans/discord-full-onboarding.md`, the real-SQL half.
//
// `ProfileGate.test.ts` (mocked) proves the HANDLER-level ordering; this file proves the SQL:
// the `TeamMemberLookup` / `MembershipWithRole` widening (`LEFT JOIN team_settings`, the new
// `is_profile_complete` / `require_complete_profile` columns) is a real schema change a mock
// cannot catch if the join is wrong. `requireCompleteProfile` does not exist yet, so every case
// below expects a real DB WRITE (an inserted RSVP row / claimed training / reserved seat) to be
// present when it must be ABSENT — a real, meaningful red against real Postgres.
//
// Pattern: `SmallApi` (`HttpApi.make('api').add(<Group>)`) for the HTTP half — see
// `dashboardTimezoneGuard.test.ts` / `teamSettingsReanchor.test.ts` for why this avoids mocking
// the other ~30 unrelated `ApiLive` groups. Real repositories throughout (`TestPgClient`); only
// `SessionsRepository` (an in-memory token→user map — auth is not the subject here) and
// `EventRosterProvisioningService`/`EventRostersRepository`/`EventRosterRequestsRepository`
// (`MockEventRosterLayers` — a heavy, unrelated best-effort side-service) are mocked, following
// `EventRsvp.test.ts`'s own precedent for that same service.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Event, Team, TeamMember, User } from '@sideline/domain';
import { CarpoolRpcGroup, EventRpcGroup, EventRsvpApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { RpcTest } from 'effect/unstable/rpc';
import { SqlClient } from 'effect/unstable/sql';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { EventRsvpApiLive } from '~/api/event-rsvp.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { CarpoolsRepository } from '~/repositories/CarpoolsRepository.js';
import { ChannelEventDividersRepository } from '~/repositories/ChannelEventDividersRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventRosterRequestsRepository } from '~/repositories/EventRosterRequestsRepository.js';
import { EventRostersRepository } from '~/repositories/EventRostersRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { CarpoolsRpcLive } from '~/rpc/carpool/index.js';
import { EventsRpcLive } from '~/rpc/event/index.js';
import { EventRosterProvisioningService } from '~/services/EventRosterProvisioningService.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

// ---------------------------------------------------------------------------
// HTTP half — `submitRsvp` via a `SmallApi` containing only `EventRsvpApiGroup`.
// ---------------------------------------------------------------------------

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

// The heavy, unrelated best-effort roster-provisioning side-call — mocked out exactly like
// `EventRsvp.test.ts` mocks it, so it never needs its own real dependency chain here.
const MockEventRosterServiceOnly = Layer.mergeAll(
  Layer.succeed(EventRostersRepository, {
    findByEventId: () => Effect.succeed(Option.none()),
    link: () => Effect.die(new Error('Not implemented')),
    unlink: () => Effect.void,
    setAutoApprove: () => Effect.void,
    saveThreadIfAbsent: () => Effect.succeed(Option.none()),
    clearThread: () => Effect.void,
  } as any),
  Layer.succeed(EventRosterRequestsRepository, {
    findByEventAndMember: () => Effect.succeed(Option.none()),
    upsertApproved: () => Effect.die(new Error('Not implemented')),
    upsertPending: () => Effect.die(new Error('Not implemented')),
    claimDecision: () => Effect.succeed(Option.none()),
    cancel: () => Effect.succeed(Option.none()),
    saveMessageId: () => Effect.void,
    findPendingByEvent: () => Effect.succeed([]),
    findPendingByRoster: () => Effect.succeed([]),
    wasMemberBefore: () => Effect.succeed(false),
    findById: () => Effect.succeed(Option.none()),
  } as any),
  Layer.succeed(EventRosterProvisioningService, {
    onRsvp: () => Effect.void,
    approve: () => Effect.die(new Error('Not implemented')),
    decline: () => Effect.die(new Error('Not implemented')),
    backfill: () => Effect.succeed({ added: 0, cancelled: 0 }),
  } as any),
);

const RealEventRepos = Layer.mergeAll(
  UsersRepository.Default,
  TeamsRepository.Default,
  TeamMembersRepository.Default,
  EventsRepository.Default,
  EventRsvpsRepository.Default,
  TeamSettingsRepository.Default,
  GroupsRepository.Default,
);

const HttpTestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(EventRsvpApiLive),
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(MockEventRosterServiceOnly),
  Layer.provide(RealEventRepos),
  Layer.provideMerge(TestPgClient),
);

// Same underlying Postgres, no HTTP — for direct seeding.
const SeedLayer = RealEventRepos.pipe(Layer.provideMerge(TestPgClient));

let handler: (...args: any) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  const app = HttpRouter.toWebHandler(HttpTestLayer);
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
// Seed helpers — shared by the HTTP and RPC halves, all run through `SeedLayer` (real Postgres).
// ---------------------------------------------------------------------------

const createUser = (discordId: string, username: string, complete: boolean) =>
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
    Effect.flatMap((user) =>
      complete
        ? UsersRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.completeProfile({
                id: user.id,
                name: Option.some('Complete User'),
                birth_date: Option.some(DateTime.makeUnsafe('2000-01-01')),
                gender: Option.some('male'),
              }),
            ),
          )
        : Effect.succeed(user),
    ),
  );

const createTeam = (guildId: string, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Profile Gate Integration Test Team',
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
  );

const addMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
  );

// `TeamSettingsRepository.upsert` does not accept `requireCompleteProfile` yet (Task 3 is
// unimplemented) — `upsert` first to create the row with every other default, then set the
// column directly. `seedTeamSettings(teamId, undefined)` skips the upsert entirely, leaving NO
// `team_settings` row at all — the real-NULL branch case.
const seedTeamSettings = (teamId: Team.TeamId, requireCompleteProfile: boolean | undefined) => {
  if (requireCompleteProfile === undefined) return Effect.void;
  return Effect.Do.pipe(
    Effect.tap(() =>
      TeamSettingsRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.upsert({ teamId, eventHorizonDays: 30, minPlayersThreshold: 5 }),
        ),
      ),
    ),
    Effect.tap(() =>
      SqlClient.SqlClient.asEffect().pipe(
        Effect.flatMap(
          (sql) =>
            sql`UPDATE team_settings SET require_complete_profile = ${requireCompleteProfile} WHERE team_id = ${teamId}`,
        ),
      ),
    ),
  );
};

const createOpenEvent = (teamId: Team.TeamId, createdBy: TeamMember.TeamMemberId) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        trainingTypeId: Option.none(),
        eventType: 'training',
        title: 'Profile Gate Integration Test Training',
        description: Option.none(),
        startAt: DateTime.makeUnsafe(
          `${DateTime.formatIsoDateUtc(DateTime.add(DateTime.nowUnsafe(), { years: 3 }))}T18:00:00Z`,
        ),
        endAt: Option.none(),
        location: Option.none(),
        createdBy,
      }),
    ),
  );

const countRsvpRows = (eventId: Event.EventId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{ count: string }>`SELECT count(*) FROM event_rsvps WHERE event_id = ${eventId}`,
    ),
    Effect.map((rows) => Number(rows[0]?.count ?? '0')),
  );

// ---------------------------------------------------------------------------
// HTTP submitRsvp
// ---------------------------------------------------------------------------

const seedHttpScenario = (params: {
  requireCompleteProfile: boolean | undefined;
  incomplete: boolean;
}) =>
  Effect.Do.pipe(
    Effect.bind('user', () =>
      createUser('941100000000000001', 'http-profile-gate-user', !params.incomplete),
    ),
    Effect.bind('team', ({ user }) => createTeam('941100000000000101', user.id)),
    Effect.tap(({ team }) => seedTeamSettings(team.id, params.requireCompleteProfile)),
    Effect.bind('member', ({ team, user }) => addMember(team.id, user.id)),
    Effect.bind('event', ({ team, member }) =>
      createOpenEvent(team.id, (member as unknown as { id: TeamMember.TeamMemberId }).id),
    ),
    Effect.bind('token', () =>
      Effect.sync(() => {
        const token = `http-token-${Math.random()}`;
        return token;
      }),
    ),
    Effect.tap(({ token, user }) =>
      Effect.sync(() => {
        sessionsStore.set(token, user.id);
      }),
    ),
    Effect.provide(SeedLayer),
  );

describe('Integration — HTTP submitRsvp profile gate (Task 3, real SQL)', () => {
  it.effect(
    'setting on, profile incomplete → 403 EventRsvpProfileIncomplete, zero RSVP rows written',
    () =>
      Effect.Do.pipe(
        Effect.bind('scenario', () =>
          seedHttpScenario({ requireCompleteProfile: true, incomplete: true }),
        ),
        Effect.bind('response', ({ scenario }) =>
          Effect.promise(() =>
            handler(
              new Request(
                `http://localhost/teams/${scenario.team.id}/events/${scenario.event.id}/rsvp`,
                {
                  method: 'PUT',
                  headers: {
                    Authorization: `Bearer ${scenario.token}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({ response: 'yes', message: null }),
                },
              ),
            ),
          ),
        ),
        // `response.json()` on a 204 (no body) throws "Unexpected end of JSON input" — before Task 3
        // this handler still succeeds (204), so the body must be read defensively rather than
        // assumed to be the 403 JSON error payload the test expects post-implementation.
        Effect.bind('body', ({ response }) =>
          Effect.promise(() => (response.status === 204 ? Promise.resolve(null) : response.json())),
        ),
        Effect.bind('rowCount', ({ scenario }) =>
          countRsvpRows(scenario.event.id).pipe(Effect.provide(SeedLayer)),
        ),
        Effect.tap(({ response, body, rowCount }) =>
          Effect.sync(() => {
            expect(response.status).toBe(403);
            expect(body?._tag).toBe(new EventRsvpApi.RsvpProfileIncomplete()._tag);
            expect(rowCount).toBe(0);
          }),
        ),
      ),
  );

  it.effect('no team_settings row at all → success (the real-NULL LEFT JOIN branch)', () =>
    Effect.Do.pipe(
      Effect.bind('scenario', () =>
        seedHttpScenario({ requireCompleteProfile: undefined, incomplete: true }),
      ),
      Effect.bind('response', ({ scenario }) =>
        Effect.promise(() =>
          handler(
            new Request(
              `http://localhost/teams/${scenario.team.id}/events/${scenario.event.id}/rsvp`,
              {
                method: 'PUT',
                headers: {
                  Authorization: `Bearer ${scenario.token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ response: 'yes', message: null }),
              },
            ),
          ),
        ),
      ),
      Effect.tap(({ response }) =>
        Effect.sync(() => {
          expect(response.status).toBe(204);
        }),
      ),
    ),
  );
});

// ---------------------------------------------------------------------------
// RPC — `Event/SubmitRsvp` / `Event/ClaimTraining` via real repositories.
// ---------------------------------------------------------------------------

const RealEventRpcRepos = Layer.mergeAll(
  EventsRepository.Default,
  EventRsvpsRepository.Default,
  EventSyncEventsRepository.Default,
  TeamMembersRepository.Default,
  GroupsRepository.Default,
  TrainingTypesRepository.Default,
  TeamsRepository.Default,
  TeamSettingsRepository.Default,
  ChannelEventDividersRepository.Default,
  DiscordChannelMappingRepository.Default,
);

const EventRpcTestLayer = EventsRpcLive.pipe(
  Layer.provide(RealEventRpcRepos),
  Layer.provide(MockEventRosterServiceOnly),
  Layer.provideMerge(TestPgClient),
);

const callEventRpc = <T>(name: string, payload: Record<string, unknown>) =>
  Effect.scoped(
    (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap((rpc: any) => rpc[name](payload) as Effect.Effect<T, unknown, never>),
      Effect.result,
    ),
  ).pipe(Effect.provide(EventRpcTestLayer));

describe('Integration — RPC Event/SubmitRsvp + Event/ClaimTraining profile gate (Task 3, real SQL)', () => {
  it.effect(
    'Event/SubmitRsvp: setting on, profile incomplete → RsvpProfileIncomplete, zero RSVP rows written',
    () =>
      Effect.Do.pipe(
        Effect.bind('user', () =>
          createUser('941200000000000001', 'rpc-submit-incomplete', false).pipe(
            Effect.provide(SeedLayer),
          ),
        ),
        Effect.bind('team', ({ user }) =>
          createTeam('941200000000000101', user.id).pipe(Effect.provide(SeedLayer)),
        ),
        Effect.tap(({ team }) => seedTeamSettings(team.id, true).pipe(Effect.provide(SeedLayer))),
        Effect.bind('member', ({ team, user }) =>
          addMember(team.id, user.id).pipe(Effect.provide(SeedLayer)),
        ),
        Effect.bind('event', ({ team, member }) =>
          createOpenEvent(team.id, (member as unknown as { id: TeamMember.TeamMemberId }).id).pipe(
            Effect.provide(SeedLayer),
          ),
        ),
        Effect.bind('result', ({ team, event, user }) =>
          callEventRpc('Event/SubmitRsvp', {
            event_id: event.id,
            team_id: team.id,
            discord_user_id: user.discord_id,
            response: 'yes',
            message: Option.none(),
            clearMessage: false,
          }),
        ),
        Effect.bind('rowCount', ({ event }) =>
          countRsvpRows(event.id).pipe(Effect.provide(SeedLayer)),
        ),
        Effect.tap(({ result, rowCount }) =>
          Effect.sync(() => {
            expect(result._tag).toBe('Failure');
            if (result._tag === 'Failure') {
              expect((result.failure as { _tag: string })._tag).toBe('RsvpProfileIncomplete');
            }
            expect(rowCount).toBe(0);
          }),
        ),
      ),
  );

  it.effect(
    'Event/ClaimTraining: setting on, profile incomplete → ClaimProfileIncomplete, event stays unclaimed',
    () =>
      Effect.Do.pipe(
        Effect.bind('user', () =>
          createUser('941200000000000002', 'rpc-claim-incomplete', false).pipe(
            Effect.provide(SeedLayer),
          ),
        ),
        Effect.bind('team', ({ user }) =>
          createTeam('941200000000000102', user.id).pipe(Effect.provide(SeedLayer)),
        ),
        Effect.tap(({ team }) => seedTeamSettings(team.id, true).pipe(Effect.provide(SeedLayer))),
        Effect.bind('member', ({ team, user }) =>
          addMember(team.id, user.id).pipe(Effect.provide(SeedLayer)),
        ),
        // The caller must be a descendant member of the event's owner group, or
        // `ClaimNotOwnerGroupMember` fires before the gate ever gets a chance to run — real group +
        // real membership, so this precondition is genuinely satisfied rather than assumed.
        Effect.bind('ownerGroup', ({ team }) =>
          GroupsRepository.asEffect()
            .pipe(
              Effect.andThen((repo) =>
                repo.insertGroup(team.id, 'Coaches', Option.none(), Option.none(), Option.none()),
              ),
            )
            .pipe(Effect.provide(SeedLayer)),
        ),
        Effect.tap(({ ownerGroup, member }) =>
          GroupsRepository.asEffect()
            .pipe(
              Effect.andThen((repo) =>
                repo.addMemberById(
                  ownerGroup.id,
                  (member as unknown as { id: TeamMember.TeamMemberId }).id,
                ),
              ),
            )
            .pipe(Effect.provide(SeedLayer)),
        ),
        Effect.bind('event', ({ team, member, ownerGroup }) =>
          EventsRepository.asEffect()
            .pipe(
              Effect.andThen((repo) =>
                repo.insertEvent({
                  teamId: team.id,
                  trainingTypeId: Option.none(),
                  eventType: 'training',
                  title: 'Claimable Training',
                  description: Option.none(),
                  startAt: DateTime.makeUnsafe(
                    `${DateTime.formatIsoDateUtc(DateTime.add(DateTime.nowUnsafe(), { years: 3 }))}T18:00:00Z`,
                  ),
                  endAt: Option.none(),
                  location: Option.none(),
                  createdBy: (member as unknown as { id: TeamMember.TeamMemberId }).id,
                  ownerGroupId: Option.some(ownerGroup.id),
                }),
              ),
            )
            .pipe(Effect.provide(SeedLayer)),
        ),
        Effect.bind('result', ({ team, event, user }) =>
          callEventRpc('Event/ClaimTraining', {
            event_id: event.id,
            team_id: team.id,
            discord_user_id: user.discord_id,
          }),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            expect(result._tag).toBe('Failure');
            if (result._tag === 'Failure') {
              const tag = (result.failure as { _tag: string })._tag;
              expect(tag).toBe('ClaimProfileIncomplete');
            }
          }),
        ),
      ),
  );
});

// ---------------------------------------------------------------------------
// RPC — `Carpool/ReserveSeat` via real repositories.
// ---------------------------------------------------------------------------

const RealCarpoolRpcRepos = Layer.mergeAll(
  CarpoolsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
);

const CarpoolRpcTestLayer = CarpoolsRpcLive.pipe(
  Layer.provide(RealCarpoolRpcRepos),
  Layer.provideMerge(TestPgClient),
);

// `SeedLayer` (used by `createUser`/`createTeam`/`addMember`) does not carry
// `CarpoolsRepository` — a separate seed layer for the carpool-specific setup below.
const CarpoolSeedLayer = RealCarpoolRpcRepos.pipe(Layer.provideMerge(TestPgClient));

const callCarpoolRpc = <T>(name: string, payload: Record<string, unknown>) =>
  Effect.scoped(
    (RpcTest.makeClient(CarpoolRpcGroup.CarpoolRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap((rpc: any) => rpc[name](payload) as Effect.Effect<T, unknown, never>),
      Effect.result,
    ),
  ).pipe(Effect.provide(CarpoolRpcTestLayer));

describe('Integration — RPC Carpool/ReserveSeat profile gate (Task 3, real SQL)', () => {
  it.effect('setting on, profile incomplete → CarpoolProfileIncomplete, seat stays free', () =>
    Effect.Do.pipe(
      Effect.bind('driver', () =>
        createUser('941300000000000001', 'carpool-driver', true).pipe(Effect.provide(SeedLayer)),
      ),
      Effect.bind('team', ({ driver }) =>
        createTeam('941300000000000101', driver.id).pipe(Effect.provide(SeedLayer)),
      ),
      Effect.tap(({ team }) => seedTeamSettings(team.id, true).pipe(Effect.provide(SeedLayer))),
      Effect.bind('driverMember', ({ team, driver }) =>
        addMember(team.id, driver.id).pipe(Effect.provide(SeedLayer)),
      ),
      Effect.bind('passenger', () =>
        createUser('941300000000000002', 'carpool-passenger', false).pipe(
          Effect.provide(SeedLayer),
        ),
      ),
      Effect.tap(({ team, passenger }) =>
        addMember(team.id, passenger.id).pipe(Effect.provide(SeedLayer)),
      ),
      Effect.bind('carpool', ({ team, driverMember }) =>
        CarpoolsRepository.asEffect()
          .pipe(
            Effect.andThen((repo) =>
              repo.createCarpool({
                teamId: team.id,
                eventId: Option.none(),
                guildId: team.guild_id,
                channelId: '941300000000000901' as Discord.Snowflake,
                createdBy: (driverMember as unknown as { id: TeamMember.TeamMemberId }).id,
              }),
            ),
          )
          .pipe(Effect.provide(CarpoolSeedLayer)),
      ),
      Effect.bind('car', ({ carpool, driverMember }) =>
        CarpoolsRepository.asEffect()
          .pipe(
            Effect.andThen((repo) =>
              repo.addCar({
                carpoolId: carpool.id,
                ownerTeamMemberId: (driverMember as unknown as { id: TeamMember.TeamMemberId }).id,
                capacity: 4,
                note: Option.none(),
              }),
            ),
          )
          .pipe(Effect.provide(CarpoolSeedLayer)),
      ),
      Effect.bind('result', ({ team, passenger, car }) =>
        callCarpoolRpc('Carpool/ReserveSeat', {
          guild_id: team.guild_id,
          discord_user_id: passenger.discord_id,
          car_id: car.car_id,
        }),
      ),
      Effect.bind('seatCount', ({ car }) =>
        SqlClient.SqlClient.asEffect()
          .pipe(
            Effect.flatMap(
              (sql) =>
                sql<{
                  count: string;
                }>`SELECT count(*) FROM carpool_seats WHERE car_id = ${car.car_id}`,
            ),
            Effect.map((rows) => Number(rows[0]?.count ?? '0')),
          )
          .pipe(Effect.provide(SeedLayer)),
      ),
      Effect.tap(({ result, seatCount }) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect((result.failure as { _tag: string })._tag).toBe('CarpoolProfileIncomplete');
          }
          expect(seatCount).toBe(0);
        }),
      ),
    ),
  );
});
