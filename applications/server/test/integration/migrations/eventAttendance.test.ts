// Migration test for `1793100000_create_event_attendance.ts` (Slice 3a of "Setup
// memberships" — the attendance record). Pattern: `membershipSelection.test.ts` — asserts the
// SCHEMA this migration leaves behind (columns, FK delete rules, constraints), never Postgres's
// own enforcement in the abstract.
//
// The centerpiece is the ONE-DIRECTIONAL CHECK regression test below: the migration's own
// comment claims a two-sided `(confirmed_at IS NULL) = (confirmed_by IS NULL)` would break
// `ON DELETE SET NULL` on `confirmed_by` with an opaque 23514. That claim was verified by
// temporarily swapping the CHECK for the two-sided form, rebuilding `packages/migrations`, and
// re-running this file — see the tester's report for the RED/GREEN transcript.

import { describe, expect, it } from '@effect/vitest';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createTeamMember, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
  EventsRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// A team, one member to serve as `created_by`, and one training event — the minimum needed to
// satisfy `event_attendance`'s two NOT NULL foreign keys.
const seedEventFixture = Effect.Do.pipe(
  Effect.bind('owner', () => createUser('event-attendance-owner')),
  Effect.bind('team', ({ owner }) => createTeam(nextDiscordId(), owner.id)),
  Effect.bind('creatorUser', () => createUser('event-attendance-creator')),
  Effect.bind('creator', ({ team, creatorUser }) => createTeamMember(team.id, creatorUser.id)),
  Effect.bind('event', ({ team, creator }) =>
    EventsRepository.asEffect().pipe(
      Effect.andThen((repo) =>
        repo.insertEvent({
          teamId: team.id,
          eventType: 'training',
          title: 'Attendance migration fixture',
          description: Option.none(),
          startAt: DateTime.makeUnsafe('2024-01-01T18:00:00.000Z'),
          endAt: Option.none(),
          location: Option.none(),
          createdBy: creator.id,
          trainingTypeId: Option.none(),
        }),
      ),
    ),
  ),
);

const seedTwoMembers = seedEventFixture.pipe(
  Effect.bind('memberAUser', () => createUser('event-attendance-a')),
  Effect.bind('memberA', ({ team, memberAUser }) => createTeamMember(team.id, memberAUser.id)),
  Effect.bind('memberBUser', () => createUser('event-attendance-b')),
  Effect.bind('memberB', ({ team, memberBUser }) => createTeamMember(team.id, memberBUser.id)),
);

describe('event_attendance — table shape', () => {
  it.effect('exists; present is NOT NULL with no default; confirmed_at/confirmed_by nullable', () =>
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
        WHERE table_schema = 'public' AND table_name = 'event_attendance'
          AND column_name IN ('present', 'confirmed_at', 'confirmed_by')
      `;

      const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));

      expect(byName.present?.data_type).toBe('boolean');
      expect(byName.present?.is_nullable).toBe('NO');
      expect(byName.present?.column_default).toBeNull();

      expect(byName.confirmed_at?.data_type).toBe('timestamp with time zone');
      expect(byName.confirmed_at?.is_nullable).toBe('YES');

      expect(byName.confirmed_by?.data_type).toBe('uuid');
      expect(byName.confirmed_by?.is_nullable).toBe('YES');
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('event_attendance — FK delete rules', () => {
  it.effect('event_id CASCADE, team_member_id CASCADE, confirmed_by SET NULL', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const rules = yield* sql<{ column_name: string; delete_rule: string }>`
          SELECT kcu.column_name, rc.delete_rule
          FROM information_schema.referential_constraints rc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_name = rc.constraint_name
          WHERE kcu.table_schema = 'public'
            AND kcu.table_name = 'event_attendance'
          ORDER BY kcu.column_name
        `;

      const byColumn = Object.fromEntries(rules.map((r) => [r.column_name, r.delete_rule]));

      expect(byColumn.event_id).toBe('CASCADE');
      expect(byColumn.team_member_id).toBe('CASCADE');
      expect(byColumn.confirmed_by).toBe('SET NULL');
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('event_attendance — UNIQUE (event_id, team_member_id)', () => {
  it.effect('a duplicate insert raises 23505', () =>
    Effect.gen(function* () {
      const { event, memberA } = yield* seedTwoMembers;
      const sql = yield* SqlClient.SqlClient.asEffect();

      yield* sql`INSERT INTO event_attendance (event_id, team_member_id, present)
                 VALUES (${event.id}, ${memberA.id}, true)`;

      const result = yield* Effect.result(
        sql`INSERT INTO event_attendance (event_id, team_member_id, present)
            VALUES (${event.id}, ${memberA.id}, false)`,
      );

      expect(result._tag).toBe('Failure');
      expect(JSON.stringify(result).toLowerCase()).toContain('23505');
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('event_attendance — one-directional CHECK, exercised against the confirming member delete', () => {
  it.effect(
    'deleting the CONFIRMING member (referenced via confirmed_by) succeeds, and leaves the ' +
      'row with confirmed_at STILL SET and confirmed_by NULL. Regression test for the ' +
      'deliberately one-directional CHECK — a two-sided ' +
      '`(confirmed_at IS NULL) = (confirmed_by IS NULL)` would make this DELETE fail with ' +
      '23514, because Postgres runs ON DELETE SET NULL as an UPDATE that re-evaluates the ' +
      'CHECK. Verified by temporarily swapping the CHECK for the two-sided form, rebuilding ' +
      'packages/migrations, and re-running this test (see tester report for the transcript).',
    () =>
      Effect.gen(function* () {
        const { event, memberA, memberB } = yield* seedTwoMembers;
        const sql = yield* SqlClient.SqlClient.asEffect();

        // memberB confirms memberA's attendance.
        yield* sql`
          INSERT INTO event_attendance (event_id, team_member_id, present, confirmed_at, confirmed_by)
          VALUES (${event.id}, ${memberA.id}, true, now(), ${memberB.id})
        `;

        const deleteResult = yield* Effect.result(
          sql`DELETE FROM team_members WHERE id = ${memberB.id}`,
        );
        expect(deleteResult._tag).toBe('Success');

        const rows = yield* sql<{ confirmed_at: Date | null; confirmed_by: string | null }>`
          SELECT confirmed_at, confirmed_by FROM event_attendance
          WHERE event_id = ${event.id} AND team_member_id = ${memberA.id}
        `;

        expect(rows).toHaveLength(1);
        expect(rows[0]?.confirmed_at).not.toBeNull();
        expect(rows[0]?.confirmed_by).toBeNull();
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'the one-directional CHECK still bites where it should: confirmed_by set with ' +
      'confirmed_at NULL raises 23514',
    () =>
      Effect.gen(function* () {
        const { event, memberA, memberB } = yield* seedTwoMembers;
        const sql = yield* SqlClient.SqlClient.asEffect();

        const result = yield* Effect.result(
          sql`
            INSERT INTO event_attendance (event_id, team_member_id, present, confirmed_at, confirmed_by)
            VALUES (${event.id}, ${memberA.id}, true, NULL, ${memberB.id})
          `,
        );

        expect(result._tag).toBe('Failure');
        expect(JSON.stringify(result).toLowerCase()).toContain('23514');
      }).pipe(Effect.provide(TestLayer)),
  );
});
