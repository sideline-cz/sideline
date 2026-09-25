// Migration test for `1792900000_membership_selection.ts` (Slice 2 of "Setup memberships").
// Pattern: `membershipPlans.test.ts` (the Slice 1 migration suite) — asserts the SCHEMA this
// migration leaves behind, never Postgres's own CASCADE/CHECK enforcement in the abstract.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { MembershipPlansRepository } from '~/repositories/MembershipPlansRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
  MembershipPlansRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const seedTeam = Effect.Do.pipe(
  Effect.bind('owner', () => createUser('membership-selection-owner')),
  Effect.bind('team', ({ owner }) => createTeam(nextDiscordId(), owner.id)),
  Effect.map(({ team }) => team),
);

// A team + one member on it, plus a SECOND, non-default plan for the team (the seeded default
// plan already exists via the per-team seeding trigger).
const seedTeamMemberAndPlan = Effect.Do.pipe(
  Effect.bind('team', () => seedTeam),
  Effect.bind('memberUser', () => createUser('membership-selection-member')),
  Effect.bind('member', ({ team, memberUser }) =>
    TeamMembersRepository.asEffect().pipe(
      Effect.andThen((repo) =>
        repo.addMember({ team_id: team.id, user_id: memberUser.id, active: true } as never),
      ),
    ),
  ),
  Effect.bind('plan', ({ team }) =>
    MembershipPlansRepository.asEffect().pipe(
      Effect.andThen((repo) =>
        repo.insertMembershipPlan({
          team_id: team.id,
          name: Option.some('Plan B' as never),
          price_minor: 1000 as never,
          currency: 'CZK' as never,
          price_per_training_minor: 0 as never,
          expires_at: Option.none(),
        }),
      ),
    ),
  ),
);

describe('membership_selection — team_members.membership_plan_id column', () => {
  it.effect('exists, is a nullable uuid with no DEFAULT', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql<{
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>`
        SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'team_members'
          AND column_name = 'membership_plan_id'
      `;

      expect(cols).toHaveLength(1);
      expect(cols[0]?.data_type).toBe('uuid');
      expect(cols[0]?.is_nullable).toBe('YES');
      // No DEFAULT means every row this migration leaves behind is NULL — there is no
      // backfill, and there cannot be one, because no row predates this migration having a
      // non-NULL value to backfill FROM. This is the honest, checkable version of that claim;
      // a test that seeds a team AFTER migrations run and asserts NULL cannot tell "no
      // backfill" apart from "no rows existed yet to backfill".
      expect(cols[0]?.column_default).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("its foreign key's delete rule is SET NULL, not RESTRICT or CASCADE", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const rules = yield* sql<{ delete_rule: string }>`
        SELECT rc.delete_rule
        FROM information_schema.referential_constraints rc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = rc.constraint_name
        WHERE kcu.table_schema = 'public'
          AND kcu.table_name = 'team_members'
          AND kcu.column_name = 'membership_plan_id'
      `;

      expect(rules).toHaveLength(1);
      expect(rules[0]?.delete_rule).toBe('SET NULL');
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('membership_selection — teams.membership_selection_deadline column', () => {
  it.effect('exists, is a nullable timestamptz', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql<{
        data_type: string;
        is_nullable: string;
      }>`
        SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'teams'
          AND column_name = 'membership_selection_deadline'
      `;

      expect(cols).toHaveLength(1);
      expect(cols[0]?.data_type).toBe('timestamp with time zone');
      expect(cols[0]?.is_nullable).toBe('YES');
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('membership_selection — team delete survives a chosen plan', () => {
  it.effect(
    'DELETE FROM teams succeeds, and leaves nothing behind, when a member of that same team ' +
      'has chosen one of its plans. NOTE: this does NOT discriminate SET NULL from RESTRICT — ' +
      'it was measured green under both. Non-deferrable FK triggers fire at the END of the ' +
      'enclosing statement, by which point the `team_members.team_id -> teams` cascade has ' +
      'already removed the referencing row, so the RESTRICT check finds nothing. The guard ' +
      'against a regression to RESTRICT is the `delete_rule` assertion above; this test pins ' +
      'the end state (team and its rows fully gone) and nothing more.',
    () =>
      Effect.gen(function* () {
        const { team, member, plan } = yield* seedTeamMemberAndPlan;
        const sql = yield* SqlClient.SqlClient.asEffect();

        yield* sql`UPDATE team_members SET membership_plan_id = ${plan.id} WHERE id = ${member.id}`;

        const result = yield* sql`DELETE FROM teams WHERE id = ${team.id}`.pipe(Effect.result);
        expect(result._tag).toBe('Success');

        const remainingTeams = yield* sql`SELECT id FROM teams WHERE id = ${team.id}`;
        const remainingMembers = yield* sql`SELECT id FROM team_members WHERE team_id = ${team.id}`;
        const remainingPlans =
          yield* sql`SELECT id FROM membership_plans WHERE team_id = ${team.id}`;

        expect(remainingTeams).toHaveLength(0);
        expect(remainingMembers).toHaveLength(0);
        expect(remainingPlans).toHaveLength(0);
      }).pipe(Effect.provide(TestLayer)),
  );
});
