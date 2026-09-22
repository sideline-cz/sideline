// Plan §10.2 — the migration half of "Nastavitelná docházka" (configurable attendance).
//
// Covers `1792200000_add_team_member_event_preferences.ts` and
// `1792200001_personal_event_channels_bucket.ts`. These assert the SCHEMA the two
// migrations leave behind, not repository behaviour — the repository is covered by
// `../repositories/PersonalEventChannelsRepository.test.ts`.
//
// The load-bearing property here is backward compatibility: a club that upgrades must
// keep every existing personal channel, stay in combined mode, and generate no rename
// or re-provisioning churn. A regression in the defaults below is invisible in the
// repository tests (which always write `bucket` explicitly) and would only surface as
// an estate-wide channel churn in production.

import { describe, expect, it } from '@effect/vitest';
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

const seedMember = Effect.gen(function* () {
  const owner = yield* createUser('bucket-owner');
  const team = yield* createTeam(nextDiscordId(), owner.id);
  const user = yield* createUser('bucket-member');
  const member = yield* createTeamMember(team.id, user.id);
  return { team, member };
});

// ---------------------------------------------------------------------------
// 1792200000 — the three preference columns and their defaults
// ---------------------------------------------------------------------------

describe('team_members event-preference columns (1792200000)', () => {
  it.effect('a member inserted without preferences gets the documented defaults', () =>
    Effect.gen(function* () {
      const { member } = yield* seedMember;
      const sql = yield* SqlClient.SqlClient.asEffect();

      const rows = yield* sql<{
        show_attendee_list: boolean;
        rsvp_reminder_dms: boolean;
        personal_channels_split: boolean;
      }>`SELECT show_attendee_list, rsvp_reminder_dms, personal_channels_split
           FROM team_members WHERE id = ${member.id}`;

      // Defaults must preserve today's behaviour for every existing member: the
      // attendee list is shown, reminder DMs are sent, and channels stay combined.
      expect(rows[0]?.show_attendee_list).toBe(true);
      expect(rows[0]?.rsvp_reminder_dms).toBe(true);
      expect(rows[0]?.personal_channels_split).toBe(false);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('all three columns are NOT NULL', () =>
    Effect.gen(function* () {
      const { member } = yield* seedMember;
      const sql = yield* SqlClient.SqlClient.asEffect();

      for (const column of ['show_attendee_list', 'rsvp_reminder_dms', 'personal_channels_split']) {
        const result = yield* Effect.result(
          sql.unsafe(`UPDATE team_members SET ${column} = NULL WHERE id = '${member.id}'`),
        );
        expect(result._tag).toBe('Failure');
      }
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 1792200001 — bucket column, widened uniqueness, dropped legacy constraint
// ---------------------------------------------------------------------------

describe('personal_event_channels.bucket (1792200001)', () => {
  it.effect("an existing-style row inserted without a bucket defaults to 'all'", () =>
    Effect.gen(function* () {
      const { team, member } = yield* seedMember;
      const sql = yield* SqlClient.SqlClient.asEffect();

      // Deliberately omits `bucket` — this is the shape every pre-migration row has.
      yield* sql`INSERT INTO personal_event_channels (team_id, team_member_id, discord_channel_id)
                 VALUES (${team.id}, ${member.id}, ${nextDiscordId()})`;

      const rows = yield* sql<{
        bucket: string;
      }>`SELECT bucket FROM personal_event_channels WHERE team_member_id = ${member.id}`;

      expect(rows[0]?.bucket).toBe('all');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('the same member may hold one row per bucket (uniqueness widened)', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seedMember;
      const sql = yield* SqlClient.SqlClient.asEffect();

      for (const bucket of ['training', 'tournament', 'other'] as const) {
        yield* sql`INSERT INTO personal_event_channels (team_id, team_member_id, bucket, discord_channel_id)
                   VALUES (${team.id}, ${member.id}, ${bucket}, ${nextDiscordId()})`;
      }

      const rows = yield* sql<{
        bucket: string;
      }>`SELECT bucket FROM personal_event_channels WHERE team_member_id = ${member.id} ORDER BY bucket`;

      // Three rows for one member is exactly what the OLD unique constraint forbade.
      expect(rows.map((r) => r.bucket)).toEqual(['other', 'tournament', 'training']);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('the same (member, bucket) pair still collides', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seedMember;
      const sql = yield* SqlClient.SqlClient.asEffect();

      yield* sql`INSERT INTO personal_event_channels (team_id, team_member_id, bucket, discord_channel_id)
                 VALUES (${team.id}, ${member.id}, 'training', ${nextDiscordId()})`;

      const result = yield* Effect.result(
        sql`INSERT INTO personal_event_channels (team_id, team_member_id, bucket, discord_channel_id)
            VALUES (${team.id}, ${member.id}, 'training', ${nextDiscordId()})`,
      );

      // Widening uniqueness must not mean losing it — this is what stops a racing
      // provisioning pass from creating two Discord channels for one bucket.
      expect(result._tag).toBe('Failure');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('the legacy (team_id, team_member_id) unique constraint is gone', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();

      const rows = yield* sql<{ conname: string }>`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'personal_event_channels'::regclass AND contype = 'u'`;

      expect(rows.map((r) => r.conname)).not.toContain(
        'personal_event_channels_team_id_team_member_id_key',
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('an unknown bucket is rejected', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seedMember;
      const sql = yield* SqlClient.SqlClient.asEffect();

      const result = yield* Effect.result(
        sql`INSERT INTO personal_event_channels (team_id, team_member_id, bucket, discord_channel_id)
            VALUES (${team.id}, ${member.id}, 'scrimmage', ${nextDiscordId()})`,
      );

      // `bucket` is a routing key; an unconstrained value would silently strand a
      // member's events in a channel nothing ever reads.
      expect(result._tag).toBe('Failure');
    }).pipe(Effect.provide(TestLayer)),
  );
});
