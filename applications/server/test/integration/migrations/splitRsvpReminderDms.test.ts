// Migration `1794400000_split_rsvp_reminder_dms.ts` — one reminder-DM flag becomes three.
//
// The failure that matters is silent: a member who turned reminder DMs off must NOT come out
// of the migration re-subscribed to any bucket. The test DB is already migrated, so each case
// drops the three new columns first and then re-runs the migration against seeded rows —
// otherwise the backfill `UPDATE` could be deleted and every case would still pass on the
// column DEFAULT alone.

import { describe, expect, it } from '@effect/vitest';
import type { TeamMember } from '@sideline/domain';
import migrateSplitRsvpReminderDms from '@sideline/migrations/before/1794400000_split_rsvp_reminder_dms';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createTeamMember, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const dropBucketColumns = SqlClient.SqlClient.asEffect().pipe(
  Effect.flatMap(
    (sql) => sql`
      ALTER TABLE team_members
        DROP COLUMN IF EXISTS rsvp_dms_training,
        DROP COLUMN IF EXISTS rsvp_dms_tournament,
        DROP COLUMN IF EXISTS rsvp_dms_other
    `,
  ),
);

const seedMember = (suffix: string, legacyValue: boolean) =>
  Effect.gen(function* () {
    const owner = yield* createUser(`split-owner-${suffix}`);
    const team = yield* createTeam(nextDiscordId(), owner.id);
    const user = yield* createUser(`split-member-${suffix}`);
    const member = yield* createTeamMember(team.id, user.id);
    const sql = yield* SqlClient.SqlClient.asEffect();
    yield* sql`UPDATE team_members SET rsvp_reminder_dms = ${legacyValue} WHERE id = ${member.id}`;
    return member.id;
  });

type BucketRow = {
  rsvp_dms_training: boolean;
  rsvp_dms_tournament: boolean;
  rsvp_dms_other: boolean;
};

const readBuckets = (memberId: TeamMember.TeamMemberId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<BucketRow>`
        SELECT rsvp_dms_training, rsvp_dms_tournament, rsvp_dms_other
        FROM team_members WHERE id = ${memberId}
      `,
    ),
    Effect.map((rows) => rows[0]),
  );

const allOff = { rsvp_dms_training: false, rsvp_dms_tournament: false, rsvp_dms_other: false };
const allOn = { rsvp_dms_training: true, rsvp_dms_tournament: true, rsvp_dms_other: true };

describe('1794400000_split_rsvp_reminder_dms', () => {
  it.effect('rsvp_reminder_dms = false → opted OUT of all three buckets; true → in all three', () =>
    Effect.gen(function* () {
      const optedOut = yield* seedMember('out', false);
      const optedIn = yield* seedMember('in', true);

      yield* dropBucketColumns;
      yield* migrateSplitRsvpReminderDms;

      expect(yield* readBuckets(optedOut)).toEqual(allOff);
      expect(yield* readBuckets(optedIn)).toEqual(allOn);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a re-run never re-subscribes an opt-out and never overwrites a bucket choice', () =>
    Effect.gen(function* () {
      const optedOut = yield* seedMember('rerun-out', false);
      const partial = yield* seedMember('rerun-partial', true);

      yield* dropBucketColumns;
      yield* migrateSplitRsvpReminderDms;
      const sql = yield* SqlClient.SqlClient.asEffect();
      // A member who later silenced only tournaments (the OR keeps the legacy flag true).
      yield* sql`UPDATE team_members SET rsvp_dms_tournament = false WHERE id = ${partial}`;
      yield* migrateSplitRsvpReminderDms;

      expect(yield* readBuckets(optedOut)).toEqual(allOff);
      expect(yield* readBuckets(partial)).toEqual({ ...allOn, rsvp_dms_tournament: false });
    }).pipe(Effect.provide(TestLayer)),
  );
});
