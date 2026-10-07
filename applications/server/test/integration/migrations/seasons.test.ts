// Migration test for `1793900000_create_seasons.ts` ("Give a season real dates").
//
// Scaffolded from the two closest precedents: `membershipPlans.test.ts` (new table + seed trigger
// + idempotent backfill) and `membershipSelection.test.ts` (information_schema assertions, and its
// documented approach of re-issuing a backfill statement by hand against rows seeded AFTER the
// migration ran — `globalSetup` runs migrations before any test row exists, so a backfill can
// never be observed in situ).
//
// TDD: written BEFORE the migration exists. Every case here fails until
// `packages/migrations/src/before/1793900000_create_seasons.ts` lands AND
// `packages/migrations` is rebuilt — `globalSetup.ts:6` imports the COMPILED migrations from
// `packages/migrations/dist`, with no vitest alias to `src`.
//
// Three blocks, in this order: SCHEMA (what the DDL left behind), BACKFILL DATA (the Step-2
// statement re-issued verbatim), GATE RULE (`governing_season_id` + `selection_is_open`). The
// third is the highest-value block in the whole feature: two shipped-in-a-plan gate rules died
// here, and its case table is the only thing standing between the codebase and a third.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';
import {
  daysFromNow,
  governingSeasonId,
  readSeasons,
  type SeasonFixtureRow,
  selectionIsOpen,
  setSeasons,
} from '../seasonFixtures.js';

const TestLayer = Layer.mergeAll(
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const seedTeam = Effect.Do.pipe(
  Effect.bind('owner', () => createUser('seasons-owner')),
  Effect.bind('team', ({ owner }) => createTeam(nextDiscordId(), owner.id)),
  Effect.map(({ team }) => team),
);

/** Inserts a membership plan with full control over `expires_at` / `archived_at`. Raw SQL on
 * purpose: `insertMembershipPlan` no longer carries `expires_at` after Task 3, and the backfill
 * cases are precisely about that column's VALUES. The column itself survives Release A (plan N5). */
const insertPlanRaw = (
  teamId: string,
  name: string,
  opts: { expiresAt?: Date | null; archivedAt?: Date | null } = {},
) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        INSERT INTO membership_plans
          (team_id, name, currency, price_minor, price_per_training_minor, expires_at, archived_at)
        VALUES (${teamId}, ${name}, 'CZK', 0, 0, ${opts.expiresAt ?? null}, ${opts.archivedAt ?? null})
      `,
    ),
  );

/** The Step-2 backfill statement, VERBATIM. If the migration's own text and this one ever drift,
 * these tests stop testing the migration — keep them byte-identical. */
const runBackfill = SqlClient.SqlClient.asEffect().pipe(
  Effect.andThen(
    (sql) => sql`
      INSERT INTO seasons (team_id, starts_at, selection_deadline, expires_at)
      SELECT
        t.id,
        now(),
        t.membership_selection_deadline,
        (
          SELECT MAX(mp.expires_at)
          FROM membership_plans mp
          WHERE mp.team_id = t.id
            AND mp.archived_at IS NULL
            AND mp.expires_at > now()
        )
      FROM teams t
      WHERE NOT EXISTS (SELECT 1 FROM seasons s WHERE s.team_id = t.id)
    `,
  ),
);

/** Drops the auto-seeded season so the hand-run backfill has an empty slot to fill — the state
 * production was actually in when the migration ran. */
const clearSeasons = (teamId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) => sql`DELETE FROM seasons WHERE team_id = ${teamId}`),
  );

const setTeamDeadline = (teamId: string, at: Date | null) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`UPDATE teams SET membership_selection_deadline = ${at} WHERE id = ${teamId}`,
    ),
  );

// Fixed instants. Constructed once, never re-derived from a fresh `new Date()` inside a case.
const FAR_FUTURE = new Date(Date.UTC(2099, 5, 15, 12));
// The PRODUCTION value, verbatim — team `e2686d09` "Poletíme!" carries exactly this on all three
// of its active plans. Noon-UTC, because a human picked 2027-02-01 in the old web field and
// `dateOnlyToUtcNoon` anchored it there. Case 11 exists so nobody ever deletes it.
const PRODUCTION_PLAN_EXPIRY = new Date('2027-02-01T12:00:00.000Z');

// ---------------------------------------------------------------------------
// 1-9. Schema — what the DDL leaves behind
// ---------------------------------------------------------------------------

describe('seasons — table shape', () => {
  // Case 1.
  it.effect('starts_at is a NOT NULL timestamptz', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql<{ data_type: string; is_nullable: string }>`
        SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'seasons' AND column_name = 'starts_at'
      `;

      expect(cols).toHaveLength(1);
      // TIMESTAMPTZ, never a DATE bucket: unlike `fees.period_start` (a team-local month KEY)
      // this is compared against now().
      expect(cols[0]?.data_type).toBe('timestamp with time zone');
      expect(cols[0]?.is_nullable).toBe('NO');
    }).pipe(Effect.provide(TestLayer)),
  );

  // Case 2. NULL is a MEANINGFUL value on both — "no deadline" / "never ends" — so a DEFAULT
  // would silently invent a date the manager never entered.
  it.effect('selection_deadline and expires_at are nullable timestamptz with no DEFAULT', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'seasons'
          AND column_name IN ('selection_deadline', 'expires_at')
        ORDER BY column_name
      `;

      expect(cols).toHaveLength(2);
      for (const col of cols) {
        expect(col.data_type).toBe('timestamp with time zone');
        expect(col.is_nullable).toBe('YES');
        expect(col.column_default).toBeNull();
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  // Case 3. Same query shape as `membershipSelection.test.ts:84-101`.
  it.effect("the team_id foreign key's delete rule is CASCADE", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const rules = yield* sql<{ delete_rule: string }>`
        SELECT rc.delete_rule
        FROM information_schema.referential_constraints rc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = rc.constraint_name
        WHERE kcu.table_schema = 'public'
          AND kcu.table_name = 'seasons'
          AND kcu.column_name = 'team_id'
      `;

      expect(rules).toHaveLength(1);
      expect(rules[0]?.delete_rule).toBe('CASCADE');
    }).pipe(Effect.provide(TestLayer)),
  );

  // Case 4. The UNIQUE is not decoration: it is the tie-break that makes "the greatest starts_at
  // not after now()" a FUNCTION rather than a choice, and it is the index both candidate
  // subqueries ride.
  it.effect('UNIQUE (team_id, starts_at) rejects a duplicate start for the same team', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();
      const at = daysFromNow(30);
      yield* sql`INSERT INTO seasons (team_id, starts_at) VALUES (${team.id}, ${at})`;

      const result = yield* Effect.result(
        sql`INSERT INTO seasons (team_id, starts_at) VALUES (${team.id}, ${at})`,
      );

      expect(result._tag).toBe('Failure');
      expect(JSON.stringify(result)).toContain('23505');
    }).pipe(Effect.provide(TestLayer)),
  );

  // Case 5. The ONLY ordering the DB enforces. There is deliberately no `starts_at <
  // selection_deadline` CHECK — "season starts 1 Sep, pick your plan by 15 Sep" is a real club —
  // and no `selection_deadline <= expires_at` CHECK either (test 22 stores that row on purpose).
  it.effect('CHECK (expires_at > starts_at) rejects an expiry before the start', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();

      const result = yield* Effect.result(
        sql`
          INSERT INTO seasons (team_id, starts_at, expires_at)
          VALUES (${team.id}, ${daysFromNow(30)}, ${daysFromNow(10)})
        `,
      );

      expect(result._tag).toBe('Failure');
      expect(JSON.stringify(result)).toContain('23514');
    }).pipe(Effect.provide(TestLayer)),
  );

  // Case 5b, free: the deadline may legally sit AFTER the expiry and BEFORE the start. The gate
  // tests the two dates independently, so both orders are meaningful and neither may be blocked.
  it.effect('a deadline after the expiry, and one before the start, are both accepted', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();

      const deadlineAfterExpiry = yield* Effect.result(
        sql`
          INSERT INTO seasons (team_id, starts_at, selection_deadline, expires_at)
          VALUES (${team.id}, ${daysFromNow(10)}, ${daysFromNow(90)}, ${daysFromNow(60)})
        `,
      );
      const deadlineBeforeStart = yield* Effect.result(
        sql`
          INSERT INTO seasons (team_id, starts_at, selection_deadline, expires_at)
          VALUES (${team.id}, ${daysFromNow(200)}, ${daysFromNow(150)}, NULL)
        `,
      );

      expect(deadlineAfterExpiry._tag).toBe('Success');
      expect(deadlineBeforeStart._tag).toBe('Success');
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('seasons — the plan-level free-trainings anchor is gone', () => {
  // Case 6.
  it.effect('membership_plans.free_trainings_anchor_at no longer exists', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'membership_plans'
          AND column_name = 'free_trainings_anchor_at'
      `;
      expect(cols).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  // Case 7. Trigger BEFORE function: `pg_trigger.tgfoid` is a hard dependency, so dropping the
  // function first would need CASCADE. Both halves asserted, because dropping only one leaves a
  // live object that the next `CREATE OR REPLACE` of the other silently resurrects.
  it.effect('neither the stamp trigger nor its function survives', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const triggers = yield* sql<{ tgname: string }>`
        SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'membership_plans'
          AND t.tgname = 'membership_plans_stamp_free_trainings_anchor_trg'
      `;
      const procs = yield* sql<{ proname: string }>`
        SELECT proname FROM pg_proc WHERE proname = 'membership_plans_stamp_free_trainings_anchor'
      `;

      expect(triggers).toEqual([]);
      expect(procs).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  // Case 8. Duplicated from `membershipPlanFreeTrainings.test.ts:181-190` ON PURPOSE. A
  // `CREATE OR REPLACE FUNCTION` with a different ARGUMENT COUNT creates a SECOND function and
  // leaves the old body live for the old arity — and `recompute_training_period_fees` is plpgsql,
  // so its three call sites carry no `pg_depend` edge and would fail at RUNTIME with 42883,
  // inside a money-writing trigger. There is no behavioural proxy for this one.
  it.effect('training_period_charges is still a single, non-overloaded function', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM pg_proc WHERE proname = 'training_period_charges'
      `;
      expect(Number(rows[0]?.count)).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  // Case 9. ONE assertion, deliberately. `prosrc` is TEXT, so it does not follow a column drop —
  // this proves the body was actually replaced. A "contains `seasons`" assertion is satisfied by
  // any mention and an `ORDER BY s.starts_at DESC` substring check breaks on a reformat while
  // passing the drift it claims to catch; the real pin on the new body is BEHAVIOURAL and lives
  // in `trainingPeriodCharges.test.ts` (period alignment, one allowance per month, never two).
  //
  // COMMENTS ARE STRIPPED FIRST, and that is a correction to the spec rather than a loosening.
  // The new body's own docblock NAMES the dropped column, to explain what replaced it — which is
  // exactly the comment the next person reading `prosrc` in psql needs. A raw substring check
  // cannot tell a READ from an EXPLANATION, so it would force the migration to stop documenting
  // itself. Stripping `--` comments leaves the assertion testing the one thing it is for: that no
  // SQL expression still references a column that no longer exists.
  it.effect("training_period_charges' CODE no longer references free_trainings_anchor_at", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ prosrc: string }>`
        SELECT prosrc FROM pg_proc WHERE proname = 'training_period_charges'
      `;
      const code = (rows[0]?.prosrc ?? '')
        .split('\n')
        .map((line) => line.replace(/--.*$/, ''))
        .join('\n');
      expect(code).not.toContain('free_trainings_anchor_at');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 10-18. The Step-2 backfill, re-issued by hand
// ---------------------------------------------------------------------------

describe('seasons — Step 2 backfill', () => {
  // Case 10. `.getTime()`, never string equality: a timezone-formatted round trip can differ as a
  // string while naming the same instant, and the AC is about not LOSING the date.
  it.effect("carries the team's membership_selection_deadline EXACTLY", () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const deadline = new Date('2026-08-25T21:59:59.999Z');
      yield* setTeamDeadline(team.id, deadline);
      yield* clearSeasons(team.id);

      yield* runBackfill;

      const seasons = yield* readSeasons(team.id);
      expect(seasons).toHaveLength(1);
      expect(seasons[0]?.selection_deadline?.getTime()).toBe(deadline.getTime());
    }).pipe(Effect.provide(TestLayer)),
  );

  // Case 11. THE REGRESSION THIS WHOLE STEP EXISTS TO PREVENT, and the production shape:
  // team `e2686d09` has THREE active plans all carrying the SAME `expires_at`. One expiry shared
  // by every active plan in a team is not per-plan expiry — it is a season expiry the product had
  // no word for. The first draft of the plan set `seasons.expires_at = NULL` and would have
  // deleted a date a human deliberately entered, with no replacement. Without this test a future
  // "simplify the correlated subquery" PR does it again, silently.
  it.effect(
    'carries the expiry THREE ACTIVE PLANS SHARE — the production shape (team e2686d09)',
    () =>
      Effect.gen(function* () {
        const team = yield* seedTeam;
        for (const name of ['Adult', 'Student', 'Junior']) {
          yield* insertPlanRaw(team.id, name, { expiresAt: PRODUCTION_PLAN_EXPIRY });
        }
        yield* clearSeasons(team.id);

        yield* runBackfill;

        const seasons = yield* readSeasons(team.id);
        expect(seasons).toHaveLength(1);
        expect(seasons[0]?.expires_at?.getTime()).toBe(PRODUCTION_PLAN_EXPIRY.getTime());
      }).pipe(Effect.provide(TestLayer)),
  );

  // Case 12. MAX over zero rows is NULL. Not now(), not a sentinel — two of the three production
  // teams are in exactly this state and a sentinel would newly close their selection.
  it.effect('with no plan expiries at all, seasons.expires_at is NULL', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      yield* insertPlanRaw(team.id, 'Adult', { expiresAt: null });
      yield* clearSeasons(team.id);

      yield* runBackfill;

      const seasons = yield* readSeasons(team.id);
      expect(seasons).toHaveLength(1);
      expect(seasons[0]?.expires_at).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  // Case 13. THE DIRECTION TEST. Expiry CLOSES selection, so the latest date can only ever keep a
  // club open at least as long as any individual plan's would have; MIN could lock a team out on
  // day one. This migration must never close a club's selection earlier than their own data said,
  // and MAX is the only choice with that property. Nothing else pins the direction.
  it.effect('with several distinct plan expiries, it takes the MAX — never the MIN', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const earlier = new Date('2027-01-01T12:00:00.000Z');
      const later = new Date('2027-06-01T12:00:00.000Z');
      yield* insertPlanRaw(team.id, 'Adult', { expiresAt: earlier });
      yield* insertPlanRaw(team.id, 'Student', { expiresAt: later });
      yield* clearSeasons(team.id);

      yield* runBackfill;

      const seasons = yield* readSeasons(team.id);
      expect(seasons[0]?.expires_at?.getTime()).toBe(later.getTime());
    }).pipe(Effect.provide(TestLayer)),
  );

  // Case 14. An archived plan's expiry is not a live statement of intent — the plan is already
  // invisible to selection, so its date must not govern the whole team.
  it.effect('an ARCHIVED plan’s far-future expiry is excluded', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      yield* insertPlanRaw(team.id, 'Retired', {
        expiresAt: FAR_FUTURE,
        archivedAt: new Date(),
      });
      yield* insertPlanRaw(team.id, 'Adult', { expiresAt: null });
      yield* clearSeasons(team.id);

      yield* runBackfill;

      const seasons = yield* readSeasons(team.id);
      expect(seasons[0]?.expires_at).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  // Case 15. The `expires_at > now()` predicate's ONLY guard, and it guards two things at once:
  //   (a) `membership_plans.expires_at` was never enforced anywhere, so carrying a stale date
  //       would newly CLOSE that team's selection at the migration instant — the exact mirror of
  //       AC 5's "without any team losing its current deadline silently";
  //   (b) more urgently, `CHECK (expires_at > starts_at)` plus `starts_at = now()` means a
  //       carried PAST expiry raises 23514 and ABORTS THE WHOLE MIGRATION — and `MigrateBefore`
  //       runs inside server boot, so the container never starts, for every team.
  // Measured 2026-10-07: no production team has a past-dated plan expiry. Defensive, and kept.
  it.effect('a PAST plan expiry is NOT carried (and so cannot trip the CHECK)', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      yield* insertPlanRaw(team.id, 'Adult', { expiresAt: daysFromNow(-1) });
      yield* clearSeasons(team.id);

      const result = yield* Effect.result(runBackfill);

      expect(result._tag, 'the backfill must not raise 23514').toBe('Success');
      const seasons = yield* readSeasons(team.id);
      expect(seasons).toHaveLength(1);
      expect(seasons[0]?.expires_at).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  // Case 16. The `WHERE NOT EXISTS` fact guard (never a value guard — see
  // `packages/migrations/AGENTS.md:76-88`).
  it.effect('is idempotent: a second run adds no row and changes no date', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const deadline = new Date('2026-08-25T21:59:59.999Z');
      yield* setTeamDeadline(team.id, deadline);
      yield* insertPlanRaw(team.id, 'Adult', { expiresAt: PRODUCTION_PLAN_EXPIRY });
      yield* clearSeasons(team.id);
      yield* runBackfill;
      const before = yield* readSeasons(team.id);

      yield* runBackfill;

      const after = yield* readSeasons(team.id);
      expect(after).toHaveLength(1);
      expect(after[0]?.id).toBe(before[0]?.id);
      expect(after[0]?.selection_deadline?.getTime()).toBe(deadline.getTime());
      expect(after[0]?.expires_at?.getTime()).toBe(PRODUCTION_PLAN_EXPIRY.getTime());
    }).pipe(Effect.provide(TestLayer)),
  );

  // Case 18. NULL stays NULL — copied verbatim, never re-anchored, never shifted.
  it.effect('a team with a NULL deadline backfills to a NULL selection_deadline', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      yield* setTeamDeadline(team.id, null);
      yield* clearSeasons(team.id);

      yield* runBackfill;

      const seasons = yield* readSeasons(team.id);
      expect(seasons).toHaveLength(1);
      expect(seasons[0]?.selection_deadline).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );
});

// Case 17. What turns "every team has at least one season" from a backfill SNAPSHOT into a real
// invariant — and the reason no query downstream carries a zero-season branch.
describe('seasons — seed_first_season_trg (AFTER INSERT ON teams)', () => {
  it.effect(
    'a newly created team gets exactly one season, starting now, with both dates NULL',
    () =>
      Effect.gen(function* () {
        const before = Date.now();
        const team = yield* seedTeam;

        const seasons = yield* readSeasons(team.id);
        expect(seasons).toHaveLength(1);
        const season = seasons[0];
        if (season === undefined) throw new Error('expected a seeded season');
        expect(season.selection_deadline).toBeNull();
        expect(season.expires_at).toBeNull();
        expect(season.starts_at.getTime()).toBeGreaterThanOrEqual(before - 60_000);
        expect(season.starts_at.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 19. The gate rule — governing_season_id + selection_is_open
// ---------------------------------------------------------------------------
//
// THE TWO-CANDIDATE RULE, restated so this file is readable on its own:
//
//   current  := the season with the GREATEST starts_at <= now()      (may not exist)
//   next     := the season with the LEAST    starts_at >  now()      (may not exist)
//   open(s)  := (deadline IS NULL OR deadline > now()) AND (expires_at IS NULL OR expires_at > now())
//   selection_open(team) := no seasons OR open(current) OR open(next)
//   governing            := first OPEN of (current, next), else current, else next
//
// Two earlier rules shipped inside a plan and both were wrong:
//   v1 "the season in effect governs"   — made rollover unreachable: a future season's deadline
//                                         expires before that season is ever current.
//   v2 "ANY season with an open window" — a FINISHED season with a NULL deadline held selection
//                                         open forever, for every season the club will ever have.
// 19b and 19c are those two bugs written as regression tests. Do not delete them to "simplify".

interface GateCase {
  readonly label: string;
  /** `key` names the row so the expectation can say WHICH season governs without an id. */
  readonly seasons: ReadonlyArray<SeasonFixtureRow & { readonly key: string }>;
  readonly open: boolean;
  readonly governing: string | null;
}

const GATE_CASES: ReadonlyArray<GateCase> = [
  {
    // Degenerate, and unreachable in production thanks to `seed_first_season_trg` — the COALESCE
    // is a one-token net, not a supported state.
    label: 'no seasons at all -> open, nothing governs',
    seasons: [],
    open: true,
    governing: null,
  },
  {
    label: 'one season, deadline in the future, not expired -> open, governs itself',
    seasons: [{ key: 'current', startsAt: daysFromNow(-30), deadline: daysFromNow(30) }],
    open: true,
    governing: 'current',
  },
  {
    // STILL governs itself when shut: the consumer needs the date to render WHICH date closed it.
    label: 'one season, deadline passed -> CLOSED, still governs itself',
    seasons: [{ key: 'current', startsAt: daysFromNow(-30), deadline: daysFromNow(-1) }],
    open: false,
    governing: 'current',
  },
  {
    // Decision 3, at the gate: advancing past a season's expiry closes selection.
    label: 'one season, expired -> CLOSED, still governs itself',
    seasons: [{ key: 'current', startsAt: daysFromNow(-60), expiresAt: daysFromNow(-1) }],
    open: false,
    governing: 'current',
  },
  {
    // THE TIMELINE FIX, and the case rule v1 could not express at all.
    //
    // FALSIFIED AND RESTORED, measured 2026-10-07 against the PG17 testcontainer. Replacing
    // `governing_season_id` with rule v1's current-season-only form:
    //
    //   [WITH FIX]    selection_is_open = true  | next governs = true
    //   [FIX REMOVED] selection_is_open = false | next governs = false
    //   [RESTORED]    selection_is_open = true  | next governs = true
    //
    // This case has been WATCHED going red. Every other row in this table stayed green under the
    // broken form, which is exactly why this one has to exist.
    label: 'current expired + next with an open deadline -> OPEN, and NEXT governs',
    seasons: [
      { key: 'current', startsAt: daysFromNow(-365), expiresAt: daysFromNow(-1) },
      { key: 'next', startsAt: daysFromNow(21), deadline: daysFromNow(7) },
    ],
    open: true,
    governing: 'next',
  },
  {
    label: 'current expired + next also shut -> closed, CURRENT governs',
    seasons: [
      { key: 'current', startsAt: daysFromNow(-365), expiresAt: daysFromNow(-1) },
      { key: 'next', startsAt: daysFromNow(21), deadline: daysFromNow(-2) },
    ],
    open: false,
    governing: 'current',
  },
  {
    // A stale future season cannot close a team that is open TODAY.
    label: 'current open + next with a passed deadline -> open, CURRENT governs',
    seasons: [
      { key: 'current', startsAt: daysFromNow(-30), deadline: daysFromNow(30) },
      { key: 'next', startsAt: daysFromNow(60), deadline: daysFromNow(-2) },
    ],
    open: true,
    governing: 'current',
  },
  {
    // LEGAL AND DELIBERATE: "season starts 1 Sep, pick your plan by 15 Sep" is a real club. There
    // is no `starts < deadline` CHECK and the web must not invent one.
    label: 'a deadline AFTER its own starts_at -> open until that deadline',
    seasons: [{ key: 'current', startsAt: daysFromNow(-5), deadline: daysFromNow(10) }],
    open: true,
    governing: 'current',
  },
];

describe('seasons — the selection gate, every case in the table', () => {
  it.effect.each(GATE_CASES)('$label', (testCase) =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      yield* setSeasons(team.id, testCase.seasons);

      const open = yield* selectionIsOpen(team.id);
      const governing = yield* governingSeasonId(team.id);

      expect(open, 'selection_is_open').toBe(testCase.open);

      if (testCase.governing === null) {
        expect(governing, 'governing_season_id').toBeNull();
      } else {
        const rows = yield* readSeasons(team.id);
        const expected = testCase.seasons.find((s) => s.key === testCase.governing);
        if (expected === undefined) throw new Error(`no fixture row keyed ${testCase.governing}`);
        const match = rows.find((r) => r.starts_at.getTime() === expected.startsAt.getTime());
        expect(match, `no stored row at ${expected.startsAt.toISOString()}`).toBeDefined();
        expect(governing, `governing should be "${testCase.governing}"`).toBe(match?.id);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  // Case 19b. `next` is the EARLIEST future season, NEVER the latest — the single reason a third,
  // far-future season cannot reopen selection today. A `DESC` typo on the second candidate
  // subquery passes EVERY case in the table above and is invisible to all of them. It is also
  // precisely rule v2's bug class.
  it.effect('a far-future THIRD season cannot reopen selection — next is the EARLIEST', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const s2Start = daysFromNow(30);
      const s3Start = daysFromNow(365);
      yield* setSeasons(team.id, [
        { startsAt: daysFromNow(-365), expiresAt: daysFromNow(-1) }, // current, finished
        { startsAt: s2Start, deadline: daysFromNow(-2) }, // S2 — queued, already shut
        { startsAt: s3Start, deadline: daysFromNow(400) }, // S3 — wide open, beyond the horizon
      ]);

      const open = yield* selectionIsOpen(team.id);
      const governing = yield* governingSeasonId(team.id);

      expect(open, 'S3 must not reopen selection').toBe(false);
      const rows = yield* readSeasons(team.id);
      const s3 = rows.find((r) => r.starts_at.getTime() === s3Start.getTime());
      expect(governing, 'S3 is beyond the horizon and can never govern').not.toBe(s3?.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  // Case 19c. RULE v2, WRITTEN AS A REGRESSION TEST. A finished season with a NULL
  // `selection_deadline` means "that season never had a deadline" — v2's
  // `bool_or(deadline IS NULL) -> NULL -> open forever` let exactly this row hold selection open
  // permanently, so the deadline that actually mattered could never bind. Reachable from the UI
  // today: set an expiry and leave the deadline empty.
  it.effect('a FINISHED season with a NULL deadline does not hold selection open forever', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      yield* setSeasons(team.id, [
        { startsAt: daysFromNow(-365), deadline: null, expiresAt: daysFromNow(-1) },
      ]);

      expect(yield* selectionIsOpen(team.id)).toBe(false);
    }).pipe(Effect.provide(TestLayer)),
  );
});
