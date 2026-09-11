// TDD mode — PR 3 of the all-day-Discord-start-time plan (§12 step 5).
//
// `applications/server/src/api/team-settings.ts`'s `updateTeamSettings` does
// not re-anchor all-day events when a team's timezone changes yet. Every test
// below is expected to FAIL until the developer adds, inside the SAME
// transaction as the settings upsert (§12 step 5b), an `UPDATE events ...`
// gated on:
//   - `team_id = <this team>`
//   - `all_day = TRUE`
//   - `all_day_anchored` (§12 step 5d — the blocker-level guard: a pre-PR-3
//     noon-UTC sentinel is NOT an anchored instant, and re-anchoring it with
//     this formula loses a day permanently)
//   - `oldTz <> newTz` (§12 step 5a — otherwise every unrelated settings save
//     takes row locks on every all-day event of the team)
// computing `oldTz` as the team's settings row before this save (or the
// column default `'Europe/Prague'` if this is the team's first settings save
// at all — §12 step 5c, the `onNone` branch).
//
// This is a Postgres integration test (testcontainers). It boots only the
// `teamSettings` HTTP group — see the `SmallApi` comment below for why that
// does not require mocking the other ~30 unrelated API groups `ApiLive`
// bundles — backed by REAL repositories (`TeamSettingsRepository`,
// `TeamMembersRepository`, `TeamsRepository`, `UsersRepository`,
// `EventsRepository`, `RolesRepository`), because the SQL semantics under
// test (`date_trunc(... AT TIME ZONE oldTz) AT TIME ZONE newTz`, and the
// `all_day_anchored` gate) cannot be faithfully exercised by a mock.
//
// Every "reanchor to X" literal below was verified directly against a real
// Postgres 17 instance (`date_trunc('day', ts AT TIME ZONE oldTz) AT TIME
// ZONE newTz`), not hand-computed.
//
// ⚠ TDD note — this file also depends on `all_day_anchored` existing
// (`EventsRepository.allDayAnchored.test.ts` covers that migration directly).
// Until it does, ALL THREE tests below fail at `seedEvent`'s setup step with
// "column all_day_anchored does not exist" — a real, correctly-ordered
// prerequisite failure, not yet a statement about §12 step 5's re-anchor
// logic. Once the migration lands, the suite re-settles into its intended
// signal: the first two tests (genuine timezone changes) go red for the
// right reason — the stored instant does not move — while the third
// ("saving an UNRELATED setting...") already passes, because with no
// re-anchor logic at all an unrelated save trivially leaves every event
// untouched. That third case is a regression guard, not an acceptance test;
// it does NOT by itself prove the `oldTz <> newTz` lock-avoidance gate from
// §12 step 5a exists (that gate's benefit is fewer row locks taken, which is
// not observable through query results — see the comment on that test).

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, TeamMember, User } from '@sideline/domain';
import { TeamSettingsApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { SqlClient } from 'effect/unstable/sql';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { TeamSettingsApiLive } from '~/api/team-settings.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

// See `eventAllDayAnchor.test.ts` for the full explanation of why a `SmallApi`
// containing only the group under test is sufficient: `HttpApiGroup.key` is
// derived from the group's own `identifier` alone (effect@4.0.0-beta.40
// HttpApiGroup.js:82), not from whichever `HttpApi` object it was `.add`ed to,
// so `TeamSettingsApiLive` (built against the real, full `Api`) registers its
// routes under the same key `HttpApiBuilder.layer(SmallApi, ...)` looks for.
const SmallApi = HttpApi.make('api').add(TeamSettingsApi.TeamSettingsApiGroup);

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
  TeamSettingsRepository.Default,
  EventsRepository.Default,
);

const TestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(TeamSettingsApiLive),
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(RealRepos),
  Layer.provideMerge(TestPgClient),
);

// A separate layer instance for direct repository access (seeding + raw SQL
// assertions) — same underlying Postgres, no HTTP involved.
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
// Seeding helpers (mirrors EventRsvpsRepository.missed-rsvps.test.ts's pattern)
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
        name: 'Reanchor Test Team',
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

const addAdminMember = (teamId: Team.TeamId, userId: User.UserId) =>
  Effect.Do.pipe(
    Effect.bind('tm', () =>
      TeamMembersRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
        ),
      ),
    ),
    Effect.tap(() =>
      RolesRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.seedTeamRolesWithPermissions(teamId)),
      ),
    ),
    Effect.bind('adminRole', () =>
      RolesRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findRoleByTeamAndName(teamId, 'Admin')),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new Error('Admin role not found')),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
    Effect.tap(({ tm, adminRole }) =>
      TeamMembersRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.assignRole((tm as any).id, adminRole.id)),
      ),
    ),
    Effect.map(({ tm }) => (tm as any).id as TeamMember.TeamMemberId),
  );

/** Seeds an event via the real repository, then overwrites `start_at`/
 * `all_day`/`all_day_anchored` directly with raw SQL — the repository's own
 * `insertEvent` does not yet stamp the flag (that is a SEPARATE PR 3
 * obligation, covered by `EventsRepository.allDayAnchored.test.ts`), and this
 * file needs full control over the "already anchored" vs "still a sentinel"
 * distinction regardless of whether that stamp is implemented yet. */
const seedEvent = (
  teamId: Team.TeamId,
  createdBy: TeamMember.TeamMemberId,
  opts: { allDay: boolean; anchored: boolean; startAtIso: string; endAtIso?: string },
) =>
  Effect.Do.pipe(
    Effect.bind('inserted', () =>
      EventsRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.insertEvent({
            teamId,
            eventType: 'tournament',
            title: opts.allDay ? 'All-day event' : 'Timed event',
            description: Option.none(),
            startAt: DateTime.makeUnsafe(opts.startAtIso),
            endAt: opts.endAtIso ? Option.some(DateTime.makeUnsafe(opts.endAtIso)) : Option.none(),
            location: Option.none(),
            ownerGroupId: Option.none(),
            memberGroupId: Option.none(),
            trainingTypeId: Option.none(),
            seriesId: Option.none(),
            createdBy,
            allDay: opts.allDay,
          }),
        ),
      ),
    ),
    Effect.tap(({ inserted }) =>
      SqlClient.SqlClient.asEffect().pipe(
        Effect.flatMap((sql) =>
          sql.unsafe(
            `UPDATE events SET all_day = ${opts.allDay}, all_day_anchored = ${opts.anchored} WHERE id = '${inserted.id}'`,
          ),
        ),
      ),
    ),
    Effect.map(({ inserted }) => inserted.id as string),
  );

const readStartAt = (eventId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      sql.unsafe<{ start_at: Date }>(`SELECT start_at FROM events WHERE id = '${eventId}'`),
    ),
    Effect.map((rows) => {
      const row = rows.at(0);
      if (!row) throw new Error(`Event ${eventId} not found`);
      return row.start_at.toISOString();
    }),
  );

const readPersonalMessagesDirtyAt = (eventId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      sql.unsafe<{ personal_messages_dirty_at: Date | null }>(
        `SELECT personal_messages_dirty_at FROM events WHERE id = '${eventId}'`,
      ),
    ),
    Effect.map((rows) => {
      const row = rows.at(0);
      if (!row) throw new Error(`Event ${eventId} not found`);
      return row.personal_messages_dirty_at;
    }),
  );

const setPersonalMessagesDirtyAt = (eventId: string, value: Date) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      sql.unsafe(
        `UPDATE events SET personal_messages_dirty_at = '${value.toISOString()}' WHERE id = '${eventId}'`,
      ),
    ),
  );

const HOST = 'http://localhost';

const patchSettings = (teamId: Team.TeamId, body: Record<string, unknown>) =>
  handler(
    new Request(`${HOST}/teams/${teamId}/settings`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const setup = (guildId: Discord.Snowflake) =>
  Effect.Do.pipe(
    Effect.bind('ownerId', () => createUser(guildId, `owner-${guildId}`)),
    Effect.bind('team', ({ ownerId }) => createTeam(guildId, ownerId)),
    Effect.bind('memberId', ({ team, ownerId }) => addAdminMember(team.id, ownerId)),
    Effect.tap(({ ownerId }) => Effect.sync(() => sessionsStore.set('admin-token', ownerId))),
    Effect.map(({ team, memberId }) => ({ teamId: team.id, memberId })),
    Effect.provide(SeedLayer),
    Effect.runPromise,
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('team-settings timezone change re-anchors all-day events (PR 3, plan §12 step 5)', () => {
  it.effect(
    'changing Europe/Prague → Asia/Tokyo re-anchors an ALREADY-anchored all-day event, ' +
      'leaves an UNANCHORED sentinel and a TIMED event untouched',
    () =>
      Effect.gen(function* () {
        const guildId = '330000000000000001' as Discord.Snowflake;
        const { teamId, memberId } = yield* Effect.promise(() => setup(guildId));

        yield* TeamSettingsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert({
              teamId,
              eventHorizonDays: 14,
              minPlayersThreshold: 0,
              timezone: 'Europe/Prague',
            }),
          ),
        );

        // Already anchored to Prague midnight of 2026-07-15.
        const anchoredId = yield* seedEvent(teamId, memberId, {
          allDay: true,
          anchored: true,
          startAtIso: '2026-07-14T22:00:00Z',
        });
        // A pre-PR-3 sentinel: all_day = true but NEVER anchored.
        const sentinelId = yield* seedEvent(teamId, memberId, {
          allDay: true,
          anchored: false,
          startAtIso: '2026-07-15T12:00:00Z',
        });
        // A timed event — must never be touched by a timezone change.
        const timedId = yield* seedEvent(teamId, memberId, {
          allDay: false,
          anchored: false,
          startAtIso: '2026-07-15T18:00:00Z',
        });

        const response = yield* Effect.promise(() =>
          patchSettings(teamId, { timezone: 'Asia/Tokyo' }),
        );
        expect(response.status).toBe(200);

        const anchoredAfter = yield* readStartAt(anchoredId);
        const sentinelAfter = yield* readStartAt(sentinelId);
        const timedAfter = yield* readStartAt(timedId);

        // date_trunc('day', '2026-07-14T22:00:00Z' AT TIME ZONE 'Europe/Prague')
        //   AT TIME ZONE 'Asia/Tokyo' — verified directly against Postgres 17.
        expect(anchoredAfter).toBe('2026-07-14T15:00:00.000Z');
        // Never touched: it is not anchored yet (§12 step 5d's blocker guard).
        expect(sentinelAfter).toBe('2026-07-15T12:00:00.000Z');
        // Never touched: it is not all-day.
        expect(timedAfter).toBe('2026-07-15T18:00:00.000Z');
      }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect(
    "a team's FIRST settings save (no prior team_settings row) assumes the OLD " +
      "timezone was the column default 'Europe/Prague' (§12 step 5c)",
    () =>
      Effect.gen(function* () {
        const guildId = '330000000000000002' as Discord.Snowflake;
        const { teamId, memberId } = yield* Effect.promise(() => setup(guildId));
        // Deliberately no `TeamSettingsRepository.upsert` call — this team has
        // NO team_settings row, so `updateTeamSettings` takes the `onNone`
        // branch (`api/team-settings.ts:106-`).

        const anchoredId = yield* seedEvent(teamId, memberId, {
          allDay: true,
          anchored: true,
          startAtIso: '2026-07-14T22:00:00Z', // Prague midnight of 2026-07-15
        });

        const response = yield* Effect.promise(() =>
          patchSettings(teamId, { timezone: 'America/New_York' }),
        );
        expect(response.status).toBe(200);

        const after = yield* readStartAt(anchoredId);
        // date_trunc('day', '2026-07-14T22:00:00Z' AT TIME ZONE 'Europe/Prague')
        //   AT TIME ZONE 'America/New_York' — verified directly against Postgres 17.
        expect(after).toBe('2026-07-15T04:00:00.000Z');
      }).pipe(Effect.provide(SeedLayer)),
  );

  // ⚠ Value-level regression guard only — see the file header's TDD note.
  // `oldTz <> newTz` is mathematically a no-op on an already-anchored row
  // (re-anchoring to the SAME zone reproduces the same instant), so this
  // passes whether or not the gate exists; its purpose per §12 step 5a is
  // avoiding an unnecessary row lock on every all-day event whenever an
  // unrelated setting is saved, which is not observable through the stored
  // `start_at` value. Kept as a value-level sanity check regardless.
  it.effect(
    'saving an UNRELATED setting with the timezone unchanged does not move an ' +
      'already-anchored all-day event (§12 step 5a — the oldTz <> newTz gate)',
    () =>
      Effect.gen(function* () {
        const guildId = '330000000000000003' as Discord.Snowflake;
        const { teamId, memberId } = yield* Effect.promise(() => setup(guildId));

        yield* TeamSettingsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert({
              teamId,
              eventHorizonDays: 14,
              minPlayersThreshold: 0,
              timezone: 'Europe/Prague',
            }),
          ),
        );

        const anchoredId = yield* seedEvent(teamId, memberId, {
          allDay: true,
          anchored: true,
          startAtIso: '2026-07-14T22:00:00Z',
        });

        // Change a wholly unrelated setting, timezone omitted (so it stays
        // 'Europe/Prague' — merged in the `onSome` branch's
        // `Option.getOrElse(payload.timezone, () => s.timezone)`).
        const response = yield* Effect.promise(() =>
          patchSettings(teamId, { minPlayersThreshold: 5 }),
        );
        expect(response.status).toBe(200);

        const after = yield* readStartAt(anchoredId);
        expect(after).toBe('2026-07-14T22:00:00.000Z');
      }).pipe(Effect.provide(SeedLayer)),
  );
});

// S5 review finding: re-anchoring a team's all-day events must also mark
// their personal messages dirty, matching `markTeamUpcomingPersonalMessagesDirty`'s
// `IS NULL` guard — otherwise every `<t:start_at:R>` already rendered into a
// personal-channel message stays hours off until something else dirties the row.
describe('team-settings timezone change marks re-anchored events personal-messages-dirty', () => {
  it.effect(
    'a timezone change marks a re-anchored all-day event dirty, but leaves an ' +
      'unanchored sentinel and a timed event untouched',
    () =>
      Effect.gen(function* () {
        const guildId = '330000000000000004' as Discord.Snowflake;
        const { teamId, memberId } = yield* Effect.promise(() => setup(guildId));

        yield* TeamSettingsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert({
              teamId,
              eventHorizonDays: 14,
              minPlayersThreshold: 0,
              timezone: 'Europe/Prague',
            }),
          ),
        );

        const anchoredId = yield* seedEvent(teamId, memberId, {
          allDay: true,
          anchored: true,
          startAtIso: '2026-07-14T22:00:00Z',
        });
        const sentinelId = yield* seedEvent(teamId, memberId, {
          allDay: true,
          anchored: false,
          startAtIso: '2026-07-15T12:00:00Z',
        });
        const timedId = yield* seedEvent(teamId, memberId, {
          allDay: false,
          anchored: false,
          startAtIso: '2026-07-15T18:00:00Z',
        });

        expect(yield* readPersonalMessagesDirtyAt(anchoredId)).toBeNull();

        const response = yield* Effect.promise(() =>
          patchSettings(teamId, { timezone: 'Asia/Tokyo' }),
        );
        expect(response.status).toBe(200);

        expect(yield* readPersonalMessagesDirtyAt(anchoredId)).not.toBeNull();
        expect(yield* readPersonalMessagesDirtyAt(sentinelId)).toBeNull();
        expect(yield* readPersonalMessagesDirtyAt(timedId)).toBeNull();
      }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect(
    'does not clobber an already-dirty event with a fresher timestamp (IS NULL guard)',
    () =>
      Effect.gen(function* () {
        const guildId = '330000000000000005' as Discord.Snowflake;
        const { teamId, memberId } = yield* Effect.promise(() => setup(guildId));

        yield* TeamSettingsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert({
              teamId,
              eventHorizonDays: 14,
              minPlayersThreshold: 0,
              timezone: 'Europe/Prague',
            }),
          ),
        );

        const anchoredId = yield* seedEvent(teamId, memberId, {
          allDay: true,
          anchored: true,
          startAtIso: '2026-07-14T22:00:00Z',
        });

        const alreadyDirtyAt = new Date('2020-01-01T00:00:00.000Z');
        yield* setPersonalMessagesDirtyAt(anchoredId, alreadyDirtyAt);

        const response = yield* Effect.promise(() =>
          patchSettings(teamId, { timezone: 'Asia/Tokyo' }),
        );
        expect(response.status).toBe(200);

        const after = yield* readPersonalMessagesDirtyAt(anchoredId);
        expect(after?.toISOString()).toBe(alreadyDirtyAt.toISOString());
      }).pipe(Effect.provide(SeedLayer)),
  );
});
