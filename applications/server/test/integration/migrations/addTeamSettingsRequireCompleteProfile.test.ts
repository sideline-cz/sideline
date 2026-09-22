// `1792110000_add_team_settings_require_complete_profile.ts` — the per-team switch for the
// profile-completeness gate (`.work-plans/discord-full-onboarding.md`, Task 1).
//
// This column's `DEFAULT false` is the ENTIRE anti-lockout guarantee for the feature. The gate
// reads `is_profile_complete`, which is plausibly `false` for most of every Discord-native
// roster — members who joined through a Discord invite and never had a reason to finish a
// profile. If this column ever shipped defaulting to `true`, or nullable-and-read-as-true,
// deploying the release would lock most of the user base out of RSVP, training claims and
// carpool seats at once. That is why the safety lives in a DB default rather than in a code
// path, and why it is worth a migration test of its own: `requireCompleteProfile`'s `onNone`
// branch protects a MISSING ROW, which is a different thing from this column's default.
//
// Harness follows `addSeriesTimesTeamLocalFlag.test.ts` (deep default-import of the migration
// module from `dist`, `TestPgClient`, `beforeEach(cleanDatabase)`) and seeds `team_settings`
// the way `teamSettingsTimezoneCheck.test.ts` does.

import { describe, expect, it } from '@effect/vitest';
import addTeamSettingsRequireCompleteProfile from '@sideline/migrations/before/1792110000_add_team_settings_require_complete_profile';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(TeamsRepository.Default, UsersRepository.Default).pipe(
  Layer.provideMerge(TestPgClient),
);

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const seedTeam = Effect.gen(function* () {
  const user = yield* createUser('owner');
  return yield* createTeam(nextDiscordId(), user.id);
});

/** Each reference is a fresh execution, so the same helper covers the idempotency case. */
const runMigration = () => addTeamSettingsRequireCompleteProfile;

/**
 * The integration database is bootstrapped by running the FULL migration set — including this
 * one — before any test's `beforeEach(cleanDatabase)`, and `cleanDatabase` truncates ROWS, not
 * columns. So without this drop, the "adds the column" test would silently exercise
 * `ADD COLUMN IF NOT EXISTS`'s no-op path (the third test's actual subject) instead of the ADD
 * path its name claims. Same trap, and same remedy, as `addSeriesTimesTeamLocalFlag.test.ts`.
 */
const dropColumn = () =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql`ALTER TABLE team_settings DROP COLUMN IF EXISTS require_complete_profile`,
    ),
  );

/** Inserts a `team_settings` row WITHOUT naming the new column — the shape every writer
 * produced before this migration existed, so the DB default is what is under test. */
const insertSettingsWithoutColumn = (teamId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) =>
        sql`INSERT INTO team_settings (team_id, timezone) VALUES (${teamId}, 'Europe/Prague')`,
    ),
  );

const readRequireCompleteProfile = (teamId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) =>
        sql<{
          require_complete_profile: boolean;
        }>`SELECT require_complete_profile FROM team_settings WHERE team_id = ${teamId}`,
    ),
    Effect.map((rows) => {
      const row = rows[0];
      if (!row) throw new Error(`team_settings for ${teamId} not found`);
      return row.require_complete_profile;
    }),
  );

describe('migration 1792110000 — team_settings.require_complete_profile', () => {
  it.effect('1. adds the column, defaulting FALSE for a row inserted without naming it', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      yield* dropColumn();
      yield* runMigration();
      yield* insertSettingsWithoutColumn(team.id);
      // FALSE, not TRUE. This single assertion is what stands between a deploy and locking
      // every member with an unfinished profile out of RSVP on every existing team.
      expect(yield* readRequireCompleteProfile(team.id)).toBe(false);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('2. is NOT NULL — an explicit NULL is rejected rather than stored', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();
      // A nullable column would be worse than a wrong default: `require_complete_profile`
      // decodes through `Schema.OptionFromNullOr`, so a stored NULL is indistinguishable from
      // the LEFT JOIN miss that means "this team has no settings row", and the gate would read
      // it as off for a team that had deliberately turned it on.
      const result = yield* Effect.result(
        sql`INSERT INTO team_settings (team_id, timezone, require_complete_profile)
            VALUES (${team.id}, 'Europe/Prague', NULL)`,
      );
      expect(result._tag).toBe('Failure');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('3. idempotent — a second run is a no-op and preserves an opted-in team', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`INSERT INTO team_settings (team_id, timezone, require_complete_profile)
                 VALUES (${team.id}, 'Europe/Prague', true)`;
      yield* runMigration();
      // Must not throw ("column already exists") and must not reset a captain's opt-in back to
      // the column default — re-running migrations is routine, and silently switching the gate
      // off for a team that had enabled it would be invisible until someone noticed the gate
      // had stopped working.
      expect(yield* readRequireCompleteProfile(team.id)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );
});
