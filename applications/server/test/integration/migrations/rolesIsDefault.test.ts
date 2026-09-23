// T-M1 (`.work-plans/configurable-default-roles.md`) — migration
// `1792500001_add_roles_is_default.ts`.
//
// Harness follows `addTeamSettingsRequireCompleteProfile.test.ts` (static default-import of the
// migration module from `dist`, `TestPgClient`, `beforeEach(cleanDatabase)`).
//
// `RolesRepository.initTeamRoles` (spliced through `seedRoles` below) already sets
// `is_default = true` for the built-in Player row at seed time — so cases 1-3 clear it back to
// `false` with `clearIsDefault` right before `runMigration()`. Without that, the migration's
// `AND is_default = false` guard matches zero rows and the backfill `UPDATE` could be deleted
// entirely without failing any of those three assertions.

import { describe, expect, it } from '@effect/vitest';
import type { Team } from '@sideline/domain';
import { SqlErrors } from '@sideline/effect-lib';
import migrateAddRolesIsDefault from '@sideline/migrations/before/1792500001_add_roles_is_default';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamsRepository.Default,
  UsersRepository.Default,
  RolesRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

/** Each reference re-runs the same idempotent effect, so this also covers the idempotency case. */
const runMigration = () => migrateAddRolesIsDefault;

const seedTeam = (suffix: string) =>
  Effect.gen(function* () {
    const user = yield* createUser(`owner-mrid-${suffix}`);
    return yield* createTeam(nextDiscordId(), user.id);
  });

const seedRoles = (teamId: Team.TeamId) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.seedTeamRolesWithPermissions(teamId)),
  );

type RoleDefaultRow = {
  id: string;
  name: string;
  is_built_in: boolean;
  is_default: boolean;
  is_archived: boolean;
};

const readRoles = (teamId: Team.TeamId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<RoleDefaultRow>`
        SELECT id, name, is_built_in, is_default, is_archived FROM roles WHERE team_id = ${teamId}
      `,
    ),
  );

const readDefaultRoles = (teamId: Team.TeamId) =>
  readRoles(teamId).pipe(Effect.map((rows) => rows.filter((r) => r.is_default)));

/** `initTeamRoles` already sets `is_default = true` on the seeded built-in Player — clear it so
 * the migration's own backfill (guarded by `AND is_default = false`) is the thing under test,
 * not a no-op re-affirming state the seed already produced. Mirrors
 * `addTeamSettingsRequireCompleteProfile.test.ts`'s `dropColumn` trap-avoidance. */
const clearIsDefault = (teamId: Team.TeamId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) => sql`UPDATE roles SET is_default = false WHERE team_id = ${teamId}`),
  );

const deleteBuiltInPlayerRole = (teamId: Team.TeamId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) =>
        sql`DELETE FROM roles WHERE team_id = ${teamId} AND name = 'Player' AND is_built_in = true`,
    ),
  );

/** A CUSTOM (non-built-in) role named 'Player' — `idx_roles_team_name` (full unique on
 * `(team_id, name)`) means this can only exist once the built-in row is gone. */
const insertCustomPlayerRole = (teamId: Team.TeamId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{ id: string }>`
        INSERT INTO roles (team_id, name, is_built_in) VALUES (${teamId}, 'Player', false)
        RETURNING id
      `,
    ),
    Effect.map((rows) => rows[0]?.id),
  );

/** Raw UPDATE, bypassing the repository — sets `is_default = true` directly, to drive the
 * unique-index cases regardless of caller shape. */
const rawSetDefault = (roleId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) => sql`UPDATE roles SET is_default = true WHERE id = ${roleId}`),
  );

const rawArchive = (roleId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) => sql`UPDATE roles SET is_archived = true WHERE id = ${roleId}`),
  );

describe('migration 1792500000 — roles.is_default', () => {
  it.effect(
    '1. backfills built-in Player — exactly one is_default row per team, named Player',
    () =>
      Effect.gen(function* () {
        const teamA = yield* seedTeam('m1a');
        const teamB = yield* seedTeam('m1b');
        yield* seedRoles(teamA.id);
        yield* seedRoles(teamB.id);
        yield* clearIsDefault(teamA.id);
        yield* clearIsDefault(teamB.id);

        yield* runMigration();

        const defaultsA = yield* readDefaultRoles(teamA.id);
        const defaultsB = yield* readDefaultRoles(teamB.id);
        expect(defaultsA).toHaveLength(1);
        expect(defaultsA[0]?.name).toBe('Player');
        expect(defaultsB).toHaveLength(1);
        expect(defaultsB[0]?.name).toBe('Player');
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    '2. the predicate pins is_built_in, not just the name — a custom (non-built-in) "Player" row is never backfilled',
    () =>
      Effect.gen(function* () {
        const team = yield* seedTeam('m2');
        yield* seedRoles(team.id);
        yield* clearIsDefault(team.id);
        // Remove the built-in Player, replace it with a CUSTOM role of the same name —
        // `idx_roles_team_name` (full unique on (team_id, name)) makes this the only way both
        // can be reached; a custom role alongside the built-in Player is unreachable.
        yield* deleteBuiltInPlayerRole(team.id);
        yield* insertCustomPlayerRole(team.id);

        yield* runMigration();

        const defaults = yield* readDefaultRoles(team.id);
        expect(defaults).toHaveLength(0);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    '3. idempotent — running the body twice leaves exactly one default per team, no error',
    () =>
      Effect.gen(function* () {
        const team = yield* seedTeam('m3');
        yield* seedRoles(team.id);
        yield* clearIsDefault(team.id);

        yield* runMigration();
        yield* runMigration();

        const defaults = yield* readDefaultRoles(team.id);
        expect(defaults).toHaveLength(1);
        expect(defaults[0]?.name).toBe('Player');
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4. the unique index rejects a second default for the same team (23505)', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('m4');
      yield* seedRoles(team.id);
      yield* runMigration();

      const roles = yield* readRoles(team.id);
      const nonDefault = roles.find((r) => !r.is_default);
      if (!nonDefault) throw new Error('expected a second, non-default role to exist');

      const sql = yield* SqlClient.SqlClient.asEffect();
      const result = yield* Effect.result(
        rawSetDefault(nonDefault.id).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      );

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(SqlErrors.isUniqueViolation(result.failure)).toBe(true);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    '5. archived rows do not occupy the slot — archiving the default then setting another succeeds',
    () =>
      Effect.gen(function* () {
        const team = yield* seedTeam('m5');
        yield* seedRoles(team.id);
        yield* runMigration();

        const before = yield* readRoles(team.id);
        const currentDefault = before.find((r) => r.is_default);
        const another = before.find((r) => !r.is_default);
        if (!currentDefault || !another)
          throw new Error('expected both a default and a non-default role');

        // Archive the current default WITHOUT clearing `is_default` — the partial index
        // (`WHERE is_default AND NOT is_archived`) must exclude it from the slot regardless.
        yield* rawArchive(currentDefault.id);
        // Setting a second role's is_default must now succeed — no 23505.
        yield* rawSetDefault(another.id);

        const after = yield* readRoles(team.id);
        const stillDefault = after.find((r) => r.id === another.id);
        expect(stillDefault?.is_default).toBe(true);
      }).pipe(Effect.provide(TestLayer)),
  );
});
