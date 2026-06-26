/**
 * Regression test for the multi-row batch INSERT helpers in
 * ChannelSyncEventsRepository.
 *
 * `sql.join(',')` defaults to `addParens = true`, which wraps the whole VALUES
 * list in an extra outer pair of parentheses. With a SINGLE row the helper
 * returns the row unwrapped (so single-row inserts work), but with TWO OR MORE
 * rows it produces `VALUES ((row1),(row2))` — which Postgres reads as one row
 * with composite expressions, failing with "INSERT has more target columns than
 * expressions". This surfaced as "Failed to start Discord role sync" on the
 * group detail page whenever the sync produced more than one event row.
 *
 * The unit tests mock these emitters, so the broken SQL only shows up against a
 * real database. Each case below inserts >1 row to lock in the fix.
 */

import { describe, expect, it } from '@effect/vitest';
import type { Discord, GroupModel, TeamChannel, TeamMember, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { constructEvent } from '~/rpc/channel/events.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  ChannelSyncEventsRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId,
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
    Effect.map((u) => u.id),
  );

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Repro Team',
        guild_id: guildId,
        created_by: createdBy,
        description: Option.none(),
        sport: Option.none(),
        logo_url: Option.none(),
        created_at: undefined,
        updated_at: undefined,
        welcome_channel_id: Option.none(),
        system_log_channel_id: Option.none(),
        welcome_message_template: Option.none(),
        rules_channel_id: Option.none(),
        overview_channel_id: Option.none(),
        achievement_channel_id: Option.none(),
        onboarding_rules_role_id: Option.none(),
        onboarding_rules_prompt_id: Option.none(),
        onboarding_locale: 'en',
        onboarding_synced_at: Option.none(),
        onboarding_sync_status: 'pending',
        onboarding_sync_error: Option.none(),
      }),
    ),
  );

const setup = Effect.gen(function* () {
  const u = yield* createUser('900000000000000001', 'creator');
  const team = yield* createTeam('900000000000000099' as Discord.Snowflake, u);
  return team.id;
});

const countEvents = SqlClient.SqlClient.asEffect().pipe(
  Effect.andThen(
    (sql) => sql<{ count: number }>`SELECT COUNT(*)::int AS count FROM channel_sync_events`,
  ),
  Effect.map((rows) => rows[0]?.count ?? 0),
);

const groupEntry = (n: number) => ({
  groupId: '00000000-0000-0000-0000-0000000000a1' as GroupModel.GroupId,
  groupName: 'G',
  teamMemberId: `00000000-0000-0000-0000-00000000000${n}` as TeamMember.TeamMemberId,
  discordUserId: `90000000000000000${n}` as Discord.Snowflake,
});

const grantEntry = (n: number) => ({
  teamChannelId: `00000000-0000-0000-0000-0000000000b${n}` as TeamChannel.TeamChannelId,
  discordChannelId: `80000000000000000${n}` as Discord.Snowflake,
  discordRoleId: `70000000000000000${n}` as Discord.Snowflake,
  accessLevel: 'VIEW' as const,
});

const revokeEntry = (n: number) => ({
  discordChannelId: `80000000000000000${n}` as Discord.Snowflake,
  discordRoleId: `70000000000000000${n}` as Discord.Snowflake,
});

describe('ChannelSyncEventsRepository batch inserts (multi-row)', () => {
  it.effect('emitMembersAddedBatch inserts multiple rows', () =>
    Effect.gen(function* () {
      const teamId = yield* setup;
      const repo = yield* ChannelSyncEventsRepository.asEffect();
      yield* repo.emitMembersAddedBatch({
        teamId,
        entries: [groupEntry(1), groupEntry(2), groupEntry(3)],
      });
      expect(yield* countEvents).toBe(3);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('emitMembersRemovedBatch inserts multiple rows', () =>
    Effect.gen(function* () {
      const teamId = yield* setup;
      const repo = yield* ChannelSyncEventsRepository.asEffect();
      yield* repo.emitMembersRemovedBatch({
        teamId,
        entries: [groupEntry(1), groupEntry(2)],
      });
      expect(yield* countEvents).toBe(2);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('emitManagedAccessGrantedBatch inserts multiple rows', () =>
    Effect.gen(function* () {
      const teamId = yield* setup;
      const repo = yield* ChannelSyncEventsRepository.asEffect();
      yield* repo.emitManagedAccessGrantedBatch({
        teamId,
        entries: [grantEntry(1), grantEntry(2)],
      });
      expect(yield* countEvents).toBe(2);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('emitManagedAccessRevokedBatch inserts multiple rows', () =>
    Effect.gen(function* () {
      const teamId = yield* setup;
      const repo = yield* ChannelSyncEventsRepository.asEffect();
      yield* repo.emitManagedAccessRevokedBatch({
        teamId,
        entries: [revokeEntry(1), revokeEntry(2)],
      });
      expect(yield* countEvents).toBe(2);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// =============================================================================
// ROSTER target_category_id round-trip tests
//
// Verifies the new `targetCategoryId` trailing parameter on emitRosterChannelCreated
// is persisted to (and reconstructed from) the `target_category_id` column.
//
// These tests are expected to FAIL until:
//   1. emitRosterChannelCreated gains the `targetCategoryId` trailing param
//   2. The `target_category_id` column exists in channel_sync_events
//   3. constructEvent/findUnprocessed deserialises the column back into the event
// =============================================================================

// Helper: read target_category_id from channel_sync_events (single row)
const readTargetCategoryId = SqlClient.SqlClient.asEffect().pipe(
  Effect.andThen(
    (sql) =>
      sql<{ val: string | null }>`
        SELECT target_category_id AS val FROM channel_sync_events LIMIT 1
      `,
  ),
  Effect.map((rows) => rows[0]?.val ?? null),
);

// Helper: read all target_category_id values ordered by id
const readAllTargetCategoryIds = SqlClient.SqlClient.asEffect().pipe(
  Effect.andThen(
    (sql) =>
      sql<{ val: string | null }>`
        SELECT target_category_id AS val FROM channel_sync_events ORDER BY created_at ASC
      `,
  ),
  Effect.map((rows) => rows.map((r) => r.val)),
);

describe('ChannelSyncEventsRepository — roster target_category_id round-trip', () => {
  /**
   * RC1: emitRosterChannelCreated with targetCategoryId=Some(cat123)
   *      → target_category_id column = "cat123000000000000"
   */
  it.effect(
    'RC1: emitRosterChannelCreated with targetCategoryId=Some(cat123) → target_category_id column persisted',
    () =>
      Effect.gen(function* () {
        const teamId = yield* setup;
        const repo = yield* ChannelSyncEventsRepository.asEffect();

        yield* repo.emitRosterChannelCreated(
          teamId,
          '00000000-0000-0000-0000-000000000030' as any,
          'Test Roster',
          Option.none(),
          '🏐│Test Roster',
          '🏐 Test Roster',
          Option.none(),
          Option.some('cat123000000000000' as Discord.Snowflake),
        );

        expect(yield* countEvents).toBe(1);
        const storedVal = yield* readTargetCategoryId;
        expect(storedVal).toBe('cat123000000000000');
      }).pipe(Effect.provide(TestLayer)),
  );

  /**
   * RC2: constructEvent reconstructs RosterChannelCreatedEvent.target_category_id = Some(cat123)
   *      from the stored row. Uses constructEvent (server-side rpc builder) as the bot does.
   */
  it.effect(
    'RC2: constructEvent reconstructs target_category_id=Some(cat123) from stored row',
    () =>
      Effect.gen(function* () {
        const teamId = yield* setup;
        const repo = yield* ChannelSyncEventsRepository.asEffect();

        yield* repo.emitRosterChannelCreated(
          teamId,
          '00000000-0000-0000-0000-000000000030' as any,
          'Test Roster',
          Option.none(),
          '🏐│Test Roster',
          '🏐 Test Roster',
          Option.none(),
          Option.some('cat123000000000000' as Discord.Snowflake),
        );

        const rows = yield* repo.findUnprocessed(10);
        expect(rows).toHaveLength(1);

        // Construct the typed event from the raw EventRow
        const typedEvent = yield* constructEvent(rows[0]!);
        expect(typedEvent._tag).toBe('roster_channel_created');

        if (typedEvent._tag === 'roster_channel_created') {
          expect(Option.isSome(typedEvent.target_category_id)).toBe(true);
          expect((typedEvent.target_category_id as Option.Some<Discord.Snowflake>).value).toBe(
            'cat123000000000000',
          );
        }
      }).pipe(Effect.provide(TestLayer)),
  );

  /**
   * RC3: Default (Option.none()) → NULL persisted → target_category_id=None on deserialize
   */
  it.effect(
    'RC3: emitRosterChannelCreated without targetCategoryId → NULL persisted → target_category_id=None',
    () =>
      Effect.gen(function* () {
        const teamId = yield* setup;
        const repo = yield* ChannelSyncEventsRepository.asEffect();

        // Call without the trailing targetCategoryId argument (default Option.none())
        yield* repo.emitRosterChannelCreated(
          teamId,
          '00000000-0000-0000-0000-000000000030' as any,
          'Test Roster',
          Option.none(),
          '🏐│Test Roster',
          '🏐 Test Roster',
          Option.none(),
          // targetCategoryId omitted — uses default Option.none()
        );

        expect(yield* countEvents).toBe(1);
        const storedVal = yield* readTargetCategoryId;
        expect(storedVal).toBeNull();

        const rows = yield* repo.findUnprocessed(10);
        expect(rows).toHaveLength(1);
        const typedEvent = yield* constructEvent(rows[0]!);
        expect(typedEvent._tag).toBe('roster_channel_created');
        if (typedEvent._tag === 'roster_channel_created') {
          expect(Option.isNone(typedEvent.target_category_id)).toBe(true);
        }
      }).pipe(Effect.provide(TestLayer)),
  );

  /**
   * RC4: Two emitRosterChannelCreated calls with different target_category_ids
   *      preserve values independently — regression guard for multi-row INSERT bug (dcf58c53).
   */
  it.effect(
    'RC4: two roster-created events with different target_category_ids preserve per-row values',
    () =>
      Effect.gen(function* () {
        const teamId = yield* setup;
        const repo = yield* ChannelSyncEventsRepository.asEffect();

        yield* repo.emitRosterChannelCreated(
          teamId,
          '00000000-0000-0000-0000-000000000031' as any,
          'Roster A',
          Option.none(),
          '│Roster A',
          'Roster A',
          Option.none(),
          Option.some('cat111000000000000' as Discord.Snowflake),
        );

        yield* repo.emitRosterChannelCreated(
          teamId,
          '00000000-0000-0000-0000-000000000032' as any,
          'Roster B',
          Option.none(),
          '│Roster B',
          'Roster B',
          Option.none(),
          Option.none(), // No category for second roster
        );

        expect(yield* countEvents).toBe(2);

        const ids = yield* readAllTargetCategoryIds;
        // One row has the category, one has null — order by created_at
        expect(ids).toHaveLength(2);
        expect(ids).toContain('cat111000000000000');
        expect(ids).toContain(null);

        // Also verify constructEvent round-trips both rows correctly
        const rows = yield* repo.findUnprocessed(10);
        expect(rows).toHaveLength(2);

        const typedEvents = yield* Effect.all(rows.map(constructEvent));

        const rosterCreatedEvents = typedEvents.filter((e) => e._tag === 'roster_channel_created');
        expect(rosterCreatedEvents).toHaveLength(2);

        const withCategory = rosterCreatedEvents.find(
          (e) => e._tag === 'roster_channel_created' && Option.isSome(e.target_category_id),
        );
        const withoutCategory = rosterCreatedEvents.find(
          (e) => e._tag === 'roster_channel_created' && Option.isNone(e.target_category_id),
        );

        expect(withCategory).toBeDefined();
        expect(withoutCategory).toBeDefined();

        if (withCategory && withCategory._tag === 'roster_channel_created') {
          expect((withCategory.target_category_id as Option.Some<Discord.Snowflake>).value).toBe(
            'cat111000000000000',
          );
        }
      }).pipe(Effect.provide(TestLayer)),
  );
});
