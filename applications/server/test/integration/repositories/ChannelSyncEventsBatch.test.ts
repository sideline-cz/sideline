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
