// T-R1 (`.work-plans/configurable-default-roles.md`) — the resolve expression
// (`TeamMembersRepository.getDefaultRoleId`) and `RolesRepository.setDefaultRole`, against real
// Postgres. Pattern: `EventRsvpsRepository.missed-rsvps.test.ts`.

import { describe, expect, it } from '@effect/vitest';
import type { Role, Team } from '@sideline/domain';
import { Deferred, Effect, Fiber, Layer, Option } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, secondTestPgClient, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  RolesRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const seedTeam = (suffix: string) =>
  Effect.gen(function* () {
    const user = yield* createUser(`owner-dr-${suffix}`);
    return yield* createTeam(nextDiscordId(), user.id);
  });

const seedRoles = (teamId: Team.TeamId) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.seedTeamRolesWithPermissions(teamId)),
  );

const findRoleByName = (teamId: Team.TeamId, name: string) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findRoleByTeamAndName(teamId, name)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new Error(`role "${name}" not found`)),
        onSome: (r) => Effect.succeed(r.id),
      }),
    ),
  );

const insertCustomRole = (teamId: Team.TeamId, name: string) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.insertRole(teamId, name)),
    Effect.map((r) => r.id),
  );

const archiveRole = (roleId: Role.RoleId) =>
  RolesRepository.asEffect().pipe(Effect.andThen((repo) => repo.archiveRoleById(roleId)));

const setDefaultRole = (roleId: Role.RoleId) =>
  RolesRepository.asEffect().pipe(Effect.andThen((repo) => repo.setDefaultRole(roleId)));

const clearAllDefaults = (teamId: Team.TeamId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) => sql`UPDATE roles SET is_default = false WHERE team_id = ${teamId}`),
  );

/** The resolver call under test — the `Result` carries `{ id, name }`. */
const getDefaultRole = (teamId: Team.TeamId) =>
  TeamMembersRepository.asEffect().pipe(Effect.andThen((repo) => repo.getDefaultRoleId(teamId)));

const readDefaultRows = (teamId: Team.TeamId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{ id: string; name: string }>`
        SELECT id, name FROM roles WHERE team_id = ${teamId} AND is_default = true
      `,
    ),
  );

describe('TeamMembersRepository.getDefaultRoleId — the resolve expression', () => {
  it.effect('1. a seeded team with no configured default resolves built-in Player', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('r1');
      yield* seedRoles(team.id);

      const result = yield* getDefaultRole(team.id);

      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) expect(result.value.name).toBe('Player');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('2. a configured default (Guest) wins over the built-in Player fallback', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('r2');
      yield* seedRoles(team.id);
      const guestId = yield* insertCustomRole(team.id, 'Guest');
      yield* setDefaultRole(guestId);

      const result = yield* getDefaultRole(team.id);

      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) expect(result.value.name).toBe('Guest');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    '3. zero-defaults fallback — clearing every is_default row still resolves built-in Player',
    () =>
      Effect.gen(function* () {
        const team = yield* seedTeam('r3');
        yield* seedRoles(team.id);
        yield* clearAllDefaults(team.id);

        const result = yield* getDefaultRole(team.id);

        expect(Option.isSome(result)).toBe(true);
        if (Option.isSome(result)) expect(result.value.name).toBe('Player');
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4. no configured default and no built-in Player → None', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('r4');
      yield* seedRoles(team.id);
      yield* clearAllDefaults(team.id);
      const playerId = yield* findRoleByName(team.id, 'Player');
      yield* archiveRole(playerId);

      const result = yield* getDefaultRole(team.id);

      expect(Option.isNone(result)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('5. an archived configured default is ignored — falls back to built-in Player', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('r5');
      yield* seedRoles(team.id);
      const guestId = yield* insertCustomRole(team.id, 'Guest');
      yield* setDefaultRole(guestId);
      yield* archiveRole(guestId);

      const result = yield* getDefaultRole(team.id);

      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) expect(result.value.name).toBe('Player');
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('RolesRepository.setDefaultRole', () => {
  it.effect(
    '6. moves the flag atomically — exactly one is_default row remains, and it is the new one. ' +
      'FAILS if the two UPDATEs collapse into `SET is_default = (id = $roleId)` (unique-index violation)',
    () =>
      Effect.gen(function* () {
        const team = yield* seedTeam('r6');
        yield* seedRoles(team.id);
        const playerId = yield* findRoleByName(team.id, 'Player');
        // Establish "Player is the configured default" explicitly — this suite is
        // repository-level and does not depend on the backfill migration having run.
        const sql = yield* SqlClient.SqlClient.asEffect();
        yield* sql`UPDATE roles SET is_default = true WHERE id = ${playerId}`;
        const guestId = yield* insertCustomRole(team.id, 'Guest');

        yield* setDefaultRole(guestId);

        const rows = yield* readDefaultRows(team.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.id).toBe(guestId);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    '7. two CONCURRENT setDefaultRole calls on the same team both succeed — exactly one is_default row remains. ' +
      'FAILS if the FOR UPDATE lock is dropped (the transaction alone does not serialize under READ COMMITTED)',
    () =>
      Effect.scoped(
        // `it.effect` auto-provides a virtual `TestClock` (`@effect/vitest`'s `TestEnv`), under
        // which a bare `Effect.sleep` never resolves without an explicit `TestClock.adjust` — this
        // test needs a GENUINE elapsed-time gap, so it opts back into the live clock via
        // `TestClock.withLive` (same pattern as `BankSyncConfigRepository.test.ts`'s 102b /
        // 102b negative control).
        TestClock.withLive(
          Effect.gen(function* () {
            const team = yield* seedTeam('r7');
            yield* seedRoles(team.id);
            const roleA = yield* insertCustomRole(team.id, 'Guest');
            const roleB = yield* insertCustomRole(team.id, 'Volunteer');

            const rolesA = yield* RolesRepository.asEffect();
            const sql2 = yield* secondTestPgClient;
            const rolesB = yield* RolesRepository.asEffect().pipe(
              Effect.provide(RolesRepository.Default),
              Effect.provideService(SqlClient.SqlClient, sql2),
            );

            // F6 (review): a bare double-fork with no barrier lets A's whole transaction commit
            // before B's even opens one — the two calls never actually overlap, and the test
            // would pass identically with `lockTeamRolesQuery` deleted (it did, see the review
            // note). A THIRD connection grabs a `FOR UPDATE` lock across every role row of the
            // team — the exact row set `lockTeamRolesQuery` itself locks — and holds it via a
            // `Deferred` barrier. A's and B's own first row-touching statement (whichever it is,
            // WITH or WITHOUT `lockTeamRolesQuery`) genuinely blocks behind that lock, so both
            // transactions are queued up and released together — forcing real, not hoped-for,
            // overlap. Same technique as `BankTransactionUnmatch.test.ts`'s parked-connection race.
            const sql3 = yield* secondTestPgClient;
            const holding = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const barrierFiber = yield* Effect.forkChild(
              sql3.withTransaction(
                Effect.Do.pipe(
                  Effect.tap(
                    () => sql3`SELECT id FROM roles WHERE team_id = ${team.id} FOR UPDATE`,
                  ),
                  Effect.tap(() => Deferred.succeed(holding, undefined)),
                  Effect.tap(() => Deferred.await(release)),
                  Effect.asVoid,
                ),
              ),
            );
            yield* Deferred.await(holding);

            const fiberA = yield* Effect.forkChild(Effect.exit(rolesA.setDefaultRole(roleA)));
            const fiberB = yield* Effect.forkChild(Effect.exit(rolesB.setDefaultRole(roleB)));
            // Let both A and B actually issue their first statement and start blocking on the
            // barrier's lock before releasing it.
            yield* Effect.sleep('100 millis');
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(barrierFiber);

            const exitA = yield* Fiber.join(fiberA);
            const exitB = yield* Fiber.join(fiberB);

            expect(exitA._tag).toBe('Success');
            expect(exitB._tag).toBe('Success');

            const rows = yield* readDefaultRows(team.id);
            expect(rows).toHaveLength(1);
          }),
        ),
      ).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "8. cannot cross tenants — a roleId from team B leaves team A's configured default untouched",
    () =>
      Effect.gen(function* () {
        const teamA = yield* seedTeam('r8a');
        const teamB = yield* seedTeam('r8b');
        yield* seedRoles(teamA.id);
        yield* seedRoles(teamB.id);
        const guestA = yield* insertCustomRole(teamA.id, 'Guest');
        yield* setDefaultRole(guestA);
        const guestB = yield* insertCustomRole(teamB.id, 'Guest');

        // The repository derives the team from the ROLE ROW, never from a caller-supplied
        // teamId — so calling it with team B's role can only ever touch team B.
        yield* setDefaultRole(guestB);

        const rowsA = yield* readDefaultRows(teamA.id);
        expect(rowsA).toHaveLength(1);
        expect(rowsA[0]?.id).toBe(guestA);
      }).pipe(Effect.provide(TestLayer)),
  );
});
