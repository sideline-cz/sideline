// Migration test for `1792800000_create_membership_plans.ts`. Modeled on
// `eventTypes.test.ts`: asserts the SCHEMA and trigger behaviour the migration leaves
// behind — the per-team seeding trigger, the idempotent backfill, and the partial
// unique index's archived-row carve-out — never Postgres's own CHECK/CASCADE
// enforcement, which is not our logic to test.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

type MembershipPlanRow = {
  id: string;
  team_id: string;
  name: string | null;
  price_minor: string;
  price_per_training_minor: string;
  currency: string;
  is_default: boolean;
  archived_at: Date | null;
};

const getPlans = (teamId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<MembershipPlanRow>`
        SELECT id, team_id, name, price_minor, price_per_training_minor, currency,
               is_default, archived_at
        FROM membership_plans WHERE team_id = ${teamId} ORDER BY created_at ASC
      `,
    ),
  );

const seedTeam = Effect.Do.pipe(
  Effect.bind('owner', () => createUser('membership-plans-owner')),
  Effect.bind('team', ({ owner }) => createTeam(nextDiscordId(), owner.id)),
  Effect.map(({ team }) => team),
);

describe('membership_plans — per-team seeding (AFTER INSERT ON teams trigger)', () => {
  it.effect('a newly created team is seeded with exactly one default plan', () =>
    Effect.Do.pipe(
      Effect.bind('team', () => seedTeam),
      Effect.bind('rows', ({ team }) => getPlans(team.id)),
      Effect.tap(({ rows }) =>
        Effect.sync(() => {
          expect(rows).toHaveLength(1);
          const plan = rows[0];
          expect(plan?.is_default).toBe(true);
          expect(plan?.name).toBeNull();
          expect(plan?.price_minor).toBe('0');
          expect(plan?.price_per_training_minor).toBe('0');
          expect(plan?.currency).toBe('CZK');
          expect(plan?.archived_at).toBeNull();
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('membership_plans — Step 2 backfill is idempotent', () => {
  it.effect('re-running the seed INSERT for an already-seeded team is a no-op', () =>
    Effect.Do.pipe(
      Effect.bind('team', () => seedTeam),
      Effect.bind('before', ({ team }) => getPlans(team.id)),
      // The literal Step 2 statement from the migration, re-run by hand.
      Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
      Effect.tap(
        ({ sql }) => sql`
          INSERT INTO membership_plans (team_id, name, currency, is_default)
          SELECT t.id, NULL, 'CZK', true FROM teams t
          WHERE NOT EXISTS (SELECT 1 FROM membership_plans mp WHERE mp.team_id = t.id)
        `,
      ),
      Effect.bind('after', ({ team }) => getPlans(team.id)),
      Effect.tap(({ before, after }) =>
        Effect.sync(() => {
          expect(after).toHaveLength(1);
          expect(before).toHaveLength(1);
          expect(after[0]?.id).toBe(before[0]?.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('membership_plans — idx_membership_plans_team_default', () => {
  it.effect('rejects a second active default for the same team', () =>
    Effect.Do.pipe(
      Effect.bind('team', () => seedTeam),
      Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
      Effect.bind('result', ({ sql, team }) =>
        sql`
          INSERT INTO membership_plans (team_id, name, currency, is_default)
          VALUES (${team.id}, 'Second default', 'CZK', true)
        `.pipe(Effect.result),
      ),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'an ARCHIVED default does not occupy the slot — a new active default can be inserted',
    () =>
      Effect.Do.pipe(
        Effect.bind('team', () => seedTeam),
        Effect.bind('seeded', ({ team }) => getPlans(team.id)),
        Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
        Effect.tap(
          ({ sql, seeded }) =>
            sql`UPDATE membership_plans SET archived_at = now() WHERE id = ${seeded[0]?.id}`,
        ),
        Effect.bind('result', ({ sql, team }) =>
          sql`
          INSERT INTO membership_plans (team_id, name, currency, is_default)
          VALUES (${team.id}, 'New default', 'CZK', true)
        `.pipe(Effect.result),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            expect(result._tag).toBe('Success');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
