// Tests for the Guild/BeginSudoSession + Guild/EndSudoSession RPC handlers.
// Mirrors OnboardingSync.test.ts: drives the real handlers (GuildsRpcLive) against a real
// Postgres test database via RpcTest.makeClient, rather than mocking repositories.

import { it as itEffect } from '@effect/vitest';
import type { Discord, Team } from '@sideline/domain';
import { GuildRpcGroup } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { SqlClient } from 'effect/unstable/sql';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordRoleMappingRepository } from '~/repositories/DiscordRoleMappingRepository.js';
import { DiscordRolesRepository } from '~/repositories/DiscordRolesRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { InviteAcceptancesRepository } from '~/repositories/InviteAcceptancesRepository.js';
import { PendingGuildJoinsRepository } from '~/repositories/PendingGuildJoinsRepository.js';
import { PersonalEventChannelsRepository } from '~/repositories/PersonalEventChannelsRepository.js';
import { PersonalEventOverflowCategoriesRepository } from '~/repositories/PersonalEventOverflowCategoriesRepository.js';
import { SudoSessionsRepository } from '~/repositories/SudoSessionsRepository.js';
import { TeamInvitesRepository } from '~/repositories/TeamInvitesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { GuildsRpcLive } from '~/rpc/guild/index.js';
import { cleanDatabase, TestPgClient } from '../integration/helpers.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const GUILD_ID = '911111111111111111' as Discord.Snowflake;
const UNKNOWN_GUILD_ID = '922222222222222222' as Discord.Snowflake;
const DISCORD_USER_ID = '933333333333333333' as Discord.Snowflake;
const SYSTEM_CHANNEL_ID = '944444444444444444' as Discord.Snowflake;
const AUDIT_MESSAGE_ID = '955555555555555555' as Discord.Snowflake;

type EndSudoSessionResult = {
  readonly session: Option.Option<{
    readonly started_at: DateTime.Utc;
    readonly system_channel_id: Discord.Snowflake;
    readonly audit_message_id: Discord.Snowflake;
  }>;
};

let TEAM_ID: Team.TeamId;

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

/** Inserts a test user (upsert by discord_id) and returns their UUID. */
const insertUser = (sql: SqlClient.SqlClient, discordId = '900000000000000001') =>
  sql`
    INSERT INTO users (discord_id, username, avatar, discord_nickname, discord_display_name)
    VALUES (${discordId}, ${`user_${discordId}`}, null, null, null)
    ON CONFLICT (discord_id) DO UPDATE SET username = EXCLUDED.username
    RETURNING id
  `.pipe(Effect.map((rows: readonly any[]) => rows[0].id as string));

const insertTeam = (sql: SqlClient.SqlClient, guildId: string) =>
  insertUser(sql).pipe(
    Effect.flatMap((createdBy) =>
      sql`
        INSERT INTO teams (id, name, guild_id, created_by, onboarding_sync_status, onboarding_locale)
        VALUES (gen_random_uuid(), 'Test Team', ${guildId}, ${createdBy}, 'pending', 'en')
        RETURNING id
      `.pipe(Effect.map((rows: readonly any[]) => rows[0].id as Team.TeamId)),
    ),
  );

// ---------------------------------------------------------------------------
// Layer composition
// ---------------------------------------------------------------------------

const makeTestLayer = () =>
  GuildsRpcLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        BotGuildsRepository.Default,
        DiscordChannelsRepository.Default,
        DiscordRoleMappingRepository.Default,
        DiscordChannelMappingRepository.Default,
        DiscordRolesRepository.Default,
        EventsRepository.Default,
        GroupsRepository.Default,
        InviteAcceptancesRepository.Default,
        PendingGuildJoinsRepository.Default,
        PersonalEventChannelsRepository.Default,
        PersonalEventOverflowCategoriesRepository.Default,
        SudoSessionsRepository.Default,
        TeamInvitesRepository.Default,
        TeamMembersRepository.Default,
        TeamSettingsRepository.Default,
        TeamsRepository.Default,
        UsersRepository.Default,
      ),
    ),
    Layer.provide(TestPgClient),
  );

// ---------------------------------------------------------------------------
// RPC call helper
// ---------------------------------------------------------------------------

// Mirrors OnboardingSync.test.ts: wraps the RPC call inside Effect.scoped so the
// test server stays alive for the duration of the continuation.
const withRpc = <A>(
  layer: ReturnType<typeof makeTestLayer>,
  fn: (rpc: any) => Effect.Effect<A, any, any>,
): Effect.Effect<A, any, never> =>
  Effect.scoped(
    (RpcTest.makeClient(GuildRpcGroup.GuildRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap((rpc: any) => fn(rpc)),
      Effect.provide(layer),
    ),
  ) as Effect.Effect<A, any, never>;

/** Casts an effect to the type expected by `itEffect.effect`. */
const asTest = <A>(e: Effect.Effect<A, any, any>): Effect.Effect<A, any, never> =>
  e as Effect.Effect<A, any, never>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Guild/BeginSudoSession + Guild/EndSudoSession RPCs', () => {
  beforeEach(() =>
    Effect.runPromise(
      cleanDatabase.pipe(
        Effect.andThen(
          SqlClient.SqlClient.asEffect().pipe(
            Effect.flatMap((sql) =>
              insertTeam(sql, GUILD_ID).pipe(
                Effect.tap((id) =>
                  Effect.sync(() => {
                    TEAM_ID = id;
                  }),
                ),
              ),
            ),
          ),
        ),
        Effect.provide(TestPgClient),
      ),
    ),
  );

  afterEach(() => Effect.runPromise(cleanDatabase.pipe(Effect.provide(TestPgClient))));

  itEffect.effect(
    'BeginSudoSession then EndSudoSession returns the stored row and deletes it',
    () =>
      asTest(
        withRpc(makeTestLayer(), (rpc) =>
          Effect.Do.pipe(
            Effect.bind('startedAt', () => DateTime.now),
            Effect.tap(({ startedAt }) =>
              rpc['Guild/BeginSudoSession']({
                guild_id: GUILD_ID,
                discord_user_id: DISCORD_USER_ID,
                system_channel_id: SYSTEM_CHANNEL_ID,
                audit_message_id: AUDIT_MESSAGE_ID,
                started_at: startedAt,
              }),
            ),
            Effect.bind(
              'ended',
              () =>
                rpc['Guild/EndSudoSession']({
                  guild_id: GUILD_ID,
                  discord_user_id: DISCORD_USER_ID,
                }) as Effect.Effect<EndSudoSessionResult, any, any>,
            ),
            Effect.bind(
              'endedAgain',
              () =>
                rpc['Guild/EndSudoSession']({
                  guild_id: GUILD_ID,
                  discord_user_id: DISCORD_USER_ID,
                }) as Effect.Effect<EndSudoSessionResult, any, any>,
            ),
            Effect.tap(({ ended, endedAgain, startedAt }) =>
              Effect.sync(() => {
                expect(TEAM_ID).toBeTruthy();
                expect(Option.isSome(ended.session)).toBe(true);
                const session = Option.getOrThrow(ended.session);
                expect(session.system_channel_id).toBe(SYSTEM_CHANNEL_ID);
                expect(session.audit_message_id).toBe(AUDIT_MESSAGE_ID);
                expect(DateTime.toEpochMillis(session.started_at)).toBe(
                  DateTime.toEpochMillis(startedAt),
                );
                // Second EndSudoSession → no active session left.
                expect(Option.isNone(endedAgain.session)).toBe(true);
              }),
            ),
          ),
        ),
      ),
  );

  itEffect.effect('EndSudoSession with no active session returns { session: None }', () =>
    asTest(
      withRpc(makeTestLayer(), (rpc) =>
        (
          rpc['Guild/EndSudoSession']({
            guild_id: GUILD_ID,
            discord_user_id: DISCORD_USER_ID,
          }) as Effect.Effect<EndSudoSessionResult, any, any>
        ).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(Option.isNone(result.session)).toBe(true);
            }),
          ),
        ),
      ),
    ),
  );

  itEffect.effect('unknown guild → BeginSudoSession no-ops, EndSudoSession returns None', () =>
    asTest(
      withRpc(makeTestLayer(), (rpc) =>
        Effect.Do.pipe(
          Effect.bind('startedAt', () => DateTime.now),
          Effect.tap(({ startedAt }) =>
            rpc['Guild/BeginSudoSession']({
              guild_id: UNKNOWN_GUILD_ID,
              discord_user_id: DISCORD_USER_ID,
              system_channel_id: SYSTEM_CHANNEL_ID,
              audit_message_id: AUDIT_MESSAGE_ID,
              started_at: startedAt,
            }),
          ),
          Effect.bind(
            'ended',
            () =>
              rpc['Guild/EndSudoSession']({
                guild_id: UNKNOWN_GUILD_ID,
                discord_user_id: DISCORD_USER_ID,
              }) as Effect.Effect<EndSudoSessionResult, any, any>,
          ),
          Effect.tap(({ ended }) =>
            Effect.sync(() => {
              expect(Option.isNone(ended.session)).toBe(true);
            }),
          ),
        ),
      ),
    ),
  );

  itEffect.effect(
    're-running BeginSudoSession for the same (team, user) restarts the session (upsert)',
    () =>
      asTest(
        withRpc(makeTestLayer(), (rpc) =>
          Effect.Do.pipe(
            Effect.bind('firstStart', () => DateTime.now),
            Effect.tap(({ firstStart }) =>
              rpc['Guild/BeginSudoSession']({
                guild_id: GUILD_ID,
                discord_user_id: DISCORD_USER_ID,
                system_channel_id: SYSTEM_CHANNEL_ID,
                audit_message_id: AUDIT_MESSAGE_ID,
                started_at: firstStart,
              }),
            ),
            Effect.bind('secondStart', () => DateTime.now),
            Effect.tap(({ secondStart }) =>
              rpc['Guild/BeginSudoSession']({
                guild_id: GUILD_ID,
                discord_user_id: DISCORD_USER_ID,
                system_channel_id: SYSTEM_CHANNEL_ID,
                audit_message_id: '966666666666666666' as Discord.Snowflake,
                started_at: secondStart,
              }),
            ),
            Effect.bind(
              'ended',
              () =>
                rpc['Guild/EndSudoSession']({
                  guild_id: GUILD_ID,
                  discord_user_id: DISCORD_USER_ID,
                }) as Effect.Effect<EndSudoSessionResult, any, any>,
            ),
            Effect.tap(({ ended, secondStart }) =>
              Effect.sync(() => {
                expect(Option.isSome(ended.session)).toBe(true);
                const session = Option.getOrThrow(ended.session);
                // The second BeginSudoSession replaced the first row.
                expect(session.audit_message_id).toBe('966666666666666666');
                expect(DateTime.toEpochMillis(session.started_at)).toBe(
                  DateTime.toEpochMillis(secondStart),
                );
              }),
            ),
          ),
        ),
      ),
  );
});
