// Shared `seasons` fixture builders for the "Give a season real dates" suite. Kept out of
// `helpers.ts` (generic to the whole integration suite) and out of `bankSyncFixtures.ts` (the
// bank-sync graph) because every file that touches the selection gate needs exactly this one
// helper and nothing else.
//
// WHY THIS EXISTS AT ALL — the trap it closes, stated once:
//
//   `seed_first_season_trg` gives every newly created team a season at `starts_at = now()`, and
//   `CHECK (expires_at IS NULL OR expires_at > starts_at)` forces a season that has ALREADY
//   expired to carry a PAST `starts_at`. A past `starts_at` is LESS than the seeded row's, so the
//   seeded, always-open season remains `current` and answers the gate — the past-expiring row a
//   test just inserted is simply ignored. A "selection is closed" case written without this
//   helper FAILS; a "selection is open" case PASSES FOR THE WRONG REASON.
//
// So: every season-sensitive case routes through `setSeasons`, which REPLACES the team's season
// set rather than adding to it.
//
// Plural on purpose — the gate is a two-candidate rule (`current` = greatest `starts_at <= now()`,
// `next` = the EARLIEST `starts_at > now()`), so most cases need both rows.
//
// There is deliberately NO clock helper here. `TestClock` moves Effect's virtual clock, never
// Postgres `now()`, and every gate in this feature is SQL-side. Past-dating rows through this
// function is the only way to "advance past a date".

import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export interface SeasonFixtureRow {
  readonly startsAt: Date;
  /** Omitted or `null` = no deadline (selection never closes on a deadline for this season). */
  readonly deadline?: Date | null;
  /** Omitted or `null` = the season never ends on its own. */
  readonly expiresAt?: Date | null;
}

/**
 * REPLACES every season of `teamId` with `rows`, in one go.
 *
 * CAUTION in `trainingPeriodCharges.test.ts`: each INSERT fires `seasons_recompute_trg`, whose
 * `fees` EXISTS pre-check PASSES once a training fee shell exists for the open period — so
 * arranging a fixture after seeding fees silently rewrites money rows. Arrange seasons BEFORE
 * seeding fees, or assert against the post-recompute state deliberately.
 */
export const setSeasons = (teamId: string, rows: ReadonlyArray<SeasonFixtureRow>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient.asEffect();
    yield* sql`DELETE FROM seasons WHERE team_id = ${teamId}`;
    for (const row of rows) {
      yield* sql`
        INSERT INTO seasons (team_id, starts_at, selection_deadline, expires_at)
        VALUES (${teamId}, ${row.startsAt}, ${row.deadline ?? null}, ${row.expiresAt ?? null})
      `;
    }
  });

/** The team's season rows, oldest start first. Raw columns only — there is no `SeasonsRepository`
 * in this release and nothing puts a season id on the wire. */
export const readSeasons = (teamId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<{
        id: string;
        starts_at: Date;
        selection_deadline: Date | null;
        expires_at: Date | null;
      }>`
        SELECT id::text AS id, starts_at, selection_deadline, expires_at
        FROM seasons WHERE team_id = ${teamId} ORDER BY starts_at ASC
      `,
    ),
  );

/** `SELECT selection_is_open($1)` — the gate, as the member's PUT evaluates it. */
export const selectionIsOpen = (teamId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<{ open: boolean }>`SELECT selection_is_open(${teamId}::uuid) AS open`,
    ),
    Effect.map((rows) => rows[0]?.open ?? null),
  );

/** `SELECT governing_season_id($1)` — WHICH season answers for the team right now. */
export const governingSeasonId = (teamId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<{ id: string | null }>`
        SELECT governing_season_id(${teamId}::uuid)::text AS id
      `,
    ),
    Effect.map((rows) => rows[0]?.id ?? null),
  );

// Offsets used by every gate case. Fixed, module-level, derived from ONE `Date.now()` — never a
// fresh `new Date()` per assertion, or a slow CI box can straddle a boundary mid-test.
const NOW = Date.now();
export const daysFromNow = (days: number) => new Date(NOW + days * 24 * 60 * 60 * 1000);
