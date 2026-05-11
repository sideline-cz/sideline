// TDD mode — these tests will FAIL until Phase 5 implements the server-side
// RPC handlers for the onboarding sync flow.
// SQL references new columns added by migration 1747000000_add_onboarding_columns.ts.
// That migration does not exist yet — tests will fail at DB setup time until it lands.

import { it as itEffect } from '@effect/vitest';
import type { Discord, Team } from '@sideline/domain';
import { GuildRpcGroup } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { SqlClient } from 'effect/unstable/sql';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordRoleMappingRepository } from '~/repositories/DiscordRoleMappingRepository.js';
import { DiscordRolesRepository } from '~/repositories/DiscordRolesRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { InviteAcceptancesRepository } from '~/repositories/InviteAcceptancesRepository.js';
import { PendingGuildJoinsRepository } from '~/repositories/PendingGuildJoinsRepository.js';
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

const GUILD_ID = '111111111111111111' as Discord.Snowflake;
const GUILD_ID_2 = '222222222222222222' as Discord.Snowflake;
const RULES_CHANNEL_ID = '333333333333333333';
const RULES_ROLE_ID = '555555555555555555';
const PROMPT_ID = '666666666666666666' as Discord.Snowflake;
const ROLE_ID = '777777777777777777' as Discord.Snowflake;
const ROLE_ID_2 = '888888888888888888' as Discord.Snowflake;

let TEAM_ID: Team.TeamId;
let TEAM_ID_2: Team.TeamId;

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

const insertBotGuild = (sql: SqlClient.SqlClient, guildId: string, isCommunity = false) =>
  sql`
    INSERT INTO bot_guilds (guild_id, guild_name, is_community_enabled)
    VALUES (${guildId}, ${`Guild ${guildId}`}, ${isCommunity})
    ON CONFLICT (guild_id) DO UPDATE SET
      guild_name = EXCLUDED.guild_name,
      is_community_enabled = EXCLUDED.is_community_enabled
  `;

/** Inserts a test user (upsert by discord_id) and returns their UUID. */
const insertUser = (sql: SqlClient.SqlClient, discordId = '100000000000000001') =>
  sql`
    INSERT INTO users (discord_id, username, avatar, discord_nickname, discord_display_name)
    VALUES (${discordId}, ${`user_${discordId}`}, null, null, null)
    ON CONFLICT (discord_id) DO UPDATE SET username = EXCLUDED.username
    RETURNING id
  `.pipe(Effect.map((rows: readonly any[]) => rows[0].id as string));

const insertTeam = (
  sql: SqlClient.SqlClient,
  params: {
    guild_id: string;
    name?: string;
    status?: string;
    rules_channel_id?: string | null;
    onboarding_rules_role_id?: string | null;
    onboarding_rules_prompt_id?: string | null;
    is_community_enabled?: boolean;
  },
) =>
  insertUser(sql).pipe(
    Effect.flatMap((createdBy) =>
      sql`
        INSERT INTO teams (
          id, name, guild_id, created_by,
          rules_channel_id, onboarding_rules_role_id, onboarding_rules_prompt_id,
          onboarding_sync_status, onboarding_locale
        )
        VALUES (
          gen_random_uuid(), ${params.name ?? 'Test Team'}, ${params.guild_id},
          ${createdBy},
          ${params.rules_channel_id ?? null},
          ${params.onboarding_rules_role_id ?? null},
          ${params.onboarding_rules_prompt_id ?? null},
          ${params.status ?? 'pending'},
          'en'
        )
        RETURNING id
      `.pipe(Effect.map((rows: readonly any[]) => rows[0].id as Team.TeamId)),
    ),
  );

// ---------------------------------------------------------------------------
// Layer composition
// ---------------------------------------------------------------------------

// Layer composition — typed via explicit return annotation so missing dependencies surface as
// compile errors when the repositories are added/removed. Mirrors the canonical pattern from
// sibling RegisterMember.test.ts: GuildsRpcLive.pipe(Layer.provide(...), Layer.provide(TestPgClient)).
const makeTestLayer = () =>
  GuildsRpcLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        BotGuildsRepository.Default,
        DiscordChannelsRepository.Default,
        DiscordRoleMappingRepository.Default,
        DiscordChannelMappingRepository.Default,
        DiscordRolesRepository.Default,
        GroupsRepository.Default,
        InviteAcceptancesRepository.Default,
        PendingGuildJoinsRepository.Default,
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

// Mirrors RegisterMember.test.ts pattern: wraps the RPC call inside Effect.scoped so the
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

describe('Guild/PendingOnboardingSyncs + sync lifecycle RPCs', () => {
  beforeEach(() =>
    Effect.runPromise(
      cleanDatabase.pipe(
        Effect.andThen(
          SqlClient.SqlClient.asEffect().pipe(
            Effect.flatMap((sql) =>
              insertBotGuild(sql, GUILD_ID, true).pipe(
                Effect.andThen(insertBotGuild(sql, GUILD_ID_2, false)),
                Effect.andThen(
                  insertTeam(sql, {
                    guild_id: GUILD_ID,
                    rules_channel_id: RULES_CHANNEL_ID,
                    onboarding_rules_role_id: RULES_ROLE_ID,
                  }).pipe(
                    Effect.tap((id) =>
                      Effect.sync(() => {
                        TEAM_ID = id;
                      }),
                    ),
                  ),
                ),
                Effect.andThen(
                  insertTeam(sql, {
                    guild_id: GUILD_ID_2,
                    name: 'Team B',
                    status: 'syncing',
                  }).pipe(
                    Effect.tap((id) =>
                      Effect.sync(() => {
                        TEAM_ID_2 = id;
                      }),
                    ),
                  ),
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
    'PendingOnboardingSyncs returns only pending rows, claims them (status→syncing)',
    () =>
      asTest(
        withRpc(makeTestLayer(), (rpc) =>
          Effect.Do.pipe(
            Effect.bind('result', () => rpc['Guild/PendingOnboardingSyncs']({ limit: 20 })),
            Effect.bind('rowAfter', () =>
              SqlClient.SqlClient.asEffect().pipe(
                Effect.flatMap((sql) =>
                  sql`SELECT onboarding_sync_status FROM teams WHERE id = ${TEAM_ID}`.pipe(
                    Effect.map((rows: readonly any[]) => rows[0]?.onboarding_sync_status),
                  ),
                ),
              ),
            ),
            Effect.tap(({ result, rowAfter }) =>
              Effect.sync(() => {
                const r = result as any[];
                // Only team 1 was pending (team 2 was already syncing)
                expect(r).toHaveLength(1);
                expect(r[0].team_id).toBe(TEAM_ID);
                // Returned row has required fields
                expect(r[0].guild_id).toBe(GUILD_ID);
                expect(typeof r[0].team_name).toBe('string');
                expect(r[0].is_community_enabled).toBe(true);
                // Row is now claimed (syncing)
                expect(rowAfter).toBe('syncing');
              }),
            ),
          ),
        ).pipe(Effect.provide(TestPgClient)),
      ),
  );

  itEffect.effect('PendingOnboardingSyncs does NOT re-claim syncing rows', () =>
    asTest(
      withRpc(makeTestLayer(), (rpc) =>
        Effect.Do.pipe(
          Effect.bind('result', () => rpc['Guild/PendingOnboardingSyncs']({ limit: 20 })),
          Effect.tap(({ result }) =>
            Effect.sync(() => {
              // team 2 is already syncing — should not be returned
              const ids = (result as any[]).map((r: any) => r.team_id);
              expect(ids).not.toContain(TEAM_ID_2);
            }),
          ),
        ),
      ).pipe(Effect.provide(TestPgClient)),
    ),
  );

  itEffect.effect('PendingOnboardingSyncs respects limit', () =>
    asTest(
      SqlClient.SqlClient.asEffect().pipe(
        Effect.flatMap((sql) =>
          // Insert 5 more pending teams
          Effect.forEach(
            Array.from({ length: 5 }, (_, i) => i),
            (i) =>
              insertBotGuild(sql, `9999999999999999${i}`, false).pipe(
                Effect.andThen(
                  insertTeam(sql, { guild_id: `9999999999999999${i}`, name: `Extra ${i}` }),
                ),
              ),
            { concurrency: 1 },
          ),
        ),
        Effect.andThen(() =>
          withRpc(makeTestLayer(), (rpc) =>
            (
              rpc['Guild/PendingOnboardingSyncs']({ limit: 2 }) as Effect.Effect<any[], any, any>
            ).pipe(
              Effect.tap((result: any[]) =>
                Effect.sync(() => {
                  expect(result.length).toBeLessThanOrEqual(2);
                }),
              ),
            ),
          ),
        ),
        Effect.provide(TestPgClient),
      ),
    ),
  );

  itEffect.effect(
    'MarkOnboardingSyncDone on syncing row → done, sets prompt_id and synced_at, returns {updated:true}',
    () =>
      asTest(
        withRpc(makeTestLayer(), (rpc) =>
          Effect.Do.pipe(
            Effect.tap(() => rpc['Guild/PendingOnboardingSyncs']({ limit: 20 })),
            Effect.bind('doneResult', () =>
              rpc['Guild/MarkOnboardingSyncDone']({
                team_id: TEAM_ID,
                prompt_id: Option.some(PROMPT_ID),
              }),
            ),
            Effect.bind('rowAfter', () =>
              SqlClient.SqlClient.asEffect().pipe(
                Effect.flatMap((sql) =>
                  sql`SELECT onboarding_sync_status, onboarding_rules_prompt_id, onboarding_synced_at
                  FROM teams WHERE id = ${TEAM_ID}`.pipe(
                    Effect.map((rows: readonly any[]) => rows[0]),
                  ),
                ),
              ),
            ),
            Effect.tap(({ doneResult, rowAfter }) =>
              Effect.sync(() => {
                const done = doneResult as any;
                const row = rowAfter as any;
                expect(done.updated).toBe(true);
                expect(row.onboarding_sync_status).toBe('done');
                expect(row.onboarding_rules_prompt_id).toBe(PROMPT_ID);
                expect(row.onboarding_synced_at).toBeTruthy();
              }),
            ),
          ),
        ).pipe(Effect.provide(TestPgClient)),
      ),
  );

  itEffect.effect(
    'MarkOnboardingSyncDone on pending row (mid-sync flip) → no-op, returns {updated:false}',
    () =>
      asTest(
        withRpc(makeTestLayer(), (rpc) =>
          Effect.Do.pipe(
            // Claim the row
            Effect.tap(() => rpc['Guild/PendingOnboardingSyncs']({ limit: 20 })),
            // Simulate captain re-save: manually flip back to pending
            Effect.tap(() =>
              SqlClient.SqlClient.asEffect().pipe(
                Effect.flatMap(
                  (sql) =>
                    sql`UPDATE teams SET onboarding_sync_status = 'pending' WHERE id = ${TEAM_ID}`,
                ),
              ),
            ),
            Effect.bind('result', () =>
              rpc['Guild/MarkOnboardingSyncDone']({
                team_id: TEAM_ID,
                prompt_id: Option.none(),
              }),
            ),
            Effect.bind('rowAfter', () =>
              SqlClient.SqlClient.asEffect().pipe(
                Effect.flatMap((sql) =>
                  sql`SELECT onboarding_sync_status FROM teams WHERE id = ${TEAM_ID}`.pipe(
                    Effect.map((rows: readonly any[]) => rows[0]?.onboarding_sync_status),
                  ),
                ),
              ),
            ),
            Effect.tap(({ result, rowAfter }) =>
              Effect.sync(() => {
                expect((result as any).updated).toBe(false);
                expect(rowAfter).toBe('pending');
              }),
            ),
          ),
        ).pipe(Effect.provide(TestPgClient)),
      ),
  );

  itEffect.effect('MarkOnboardingSyncFailed on syncing row → failed with typed error_code', () =>
    asTest(
      withRpc(makeTestLayer(), (rpc) =>
        Effect.Do.pipe(
          Effect.tap(() => rpc['Guild/PendingOnboardingSyncs']({ limit: 20 })),
          Effect.tap(() =>
            rpc['Guild/MarkOnboardingSyncFailed']({
              team_id: TEAM_ID,
              error_code: 'role_deleted',
              error_detail: 'Role no longer exists',
            }),
          ),
          Effect.bind('rowAfter', () =>
            SqlClient.SqlClient.asEffect().pipe(
              Effect.flatMap((sql) =>
                sql`SELECT onboarding_sync_status, onboarding_sync_error FROM teams WHERE id = ${TEAM_ID}`.pipe(
                  Effect.map((rows: readonly any[]) => rows[0]),
                ),
              ),
            ),
          ),
          Effect.tap(({ rowAfter }) =>
            Effect.sync(() => {
              const row = rowAfter as any;
              expect(row.onboarding_sync_status).toBe('failed');
              const parsed = JSON.parse(row.onboarding_sync_error);
              expect(parsed.code).toBe('role_deleted');
              expect(typeof parsed.detail).toBe('string');
            }),
          ),
        ),
      ).pipe(Effect.provide(TestPgClient)),
    ),
  );

  itEffect.effect(
    'MarkOnboardingSyncFailed JSON round-trip: detail with colons preserved verbatim',
    () =>
      asTest(
        withRpc(makeTestLayer(), (rpc) =>
          Effect.Do.pipe(
            Effect.tap(() => rpc['Guild/PendingOnboardingSyncs']({ limit: 20 })),
            Effect.tap(() =>
              rpc['Guild/MarkOnboardingSyncFailed']({
                team_id: TEAM_ID,
                error_code: 'discord_error',
                error_detail: '10004: Unknown Channel: https://discord.com/api/v10/guilds/x',
              }),
            ),
            Effect.bind('rowAfter', () =>
              SqlClient.SqlClient.asEffect().pipe(
                Effect.flatMap((sql) =>
                  sql`SELECT onboarding_sync_error FROM teams WHERE id = ${TEAM_ID}`.pipe(
                    Effect.map((rows: readonly any[]) => rows[0]?.onboarding_sync_error),
                  ),
                ),
              ),
            ),
            Effect.tap(({ rowAfter }) =>
              Effect.sync(() => {
                const parsed = JSON.parse(rowAfter as string);
                expect(parsed.detail).toBe(
                  '10004: Unknown Channel: https://discord.com/api/v10/guilds/x',
                );
              }),
            ),
          ),
        ).pipe(Effect.provide(TestPgClient)),
      ),
  );

  itEffect.effect('RevertOnboardingSync on syncing row → back to pending, error cleared', () =>
    asTest(
      withRpc(makeTestLayer(), (rpc) =>
        Effect.Do.pipe(
          // team 2 is already syncing
          Effect.tap(() => rpc['Guild/RevertOnboardingSync']({ team_id: TEAM_ID_2 })),
          Effect.bind('rowAfter', () =>
            SqlClient.SqlClient.asEffect().pipe(
              Effect.flatMap((sql) =>
                sql`SELECT onboarding_sync_status, onboarding_sync_error FROM teams WHERE id = ${TEAM_ID_2}`.pipe(
                  Effect.map((rows: readonly any[]) => rows[0]),
                ),
              ),
            ),
          ),
          Effect.tap(({ rowAfter }) =>
            Effect.sync(() => {
              expect((rowAfter as any).onboarding_sync_status).toBe('pending');
            }),
          ),
        ),
      ).pipe(Effect.provide(TestPgClient)),
    ),
  );

  itEffect.effect('SyncCommunityFlags upserts is_community_enabled for all listed guilds', () =>
    asTest(
      withRpc(makeTestLayer(), (rpc) =>
        Effect.Do.pipe(
          Effect.tap(() =>
            rpc['Guild/SyncCommunityFlags']({
              guilds: [
                { guild_id: GUILD_ID, is_community_enabled: false },
                { guild_id: GUILD_ID_2, is_community_enabled: true },
              ],
            }),
          ),
          Effect.bind('rows', () =>
            SqlClient.SqlClient.asEffect().pipe(
              Effect.flatMap((sql) =>
                sql`SELECT guild_id, is_community_enabled FROM bot_guilds WHERE guild_id IN (${GUILD_ID}, ${GUILD_ID_2}) ORDER BY guild_id`.pipe(
                  Effect.map((rows: readonly any[]) => rows as any[]),
                ),
              ),
            ),
          ),
          Effect.tap(({ rows }) =>
            Effect.sync(() => {
              const r = rows as any[];
              const guildA = r.find((x: any) => x.guild_id === GUILD_ID);
              const guildB = r.find((x: any) => x.guild_id === GUILD_ID_2);
              expect(guildA?.is_community_enabled).toBe(false); // was true, now false
              expect(guildB?.is_community_enabled).toBe(true); // was false, now true
            }),
          ),
        ),
      ).pipe(Effect.provide(TestPgClient)),
    ),
  );

  itEffect.effect('UpsertGuildRole + DeleteGuildRole round-trip', () =>
    asTest(
      withRpc(makeTestLayer(), (rpc) =>
        Effect.Do.pipe(
          // Insert
          Effect.tap(() =>
            rpc['Guild/UpsertGuildRole']({
              guild_id: GUILD_ID,
              role_id: ROLE_ID,
              name: 'Strikers',
              color: 0xff0000,
              position: 5,
              managed: false,
            }),
          ),
          // Update (upsert on conflict)
          Effect.tap(() =>
            rpc['Guild/UpsertGuildRole']({
              guild_id: GUILD_ID,
              role_id: ROLE_ID,
              name: 'Defenders',
              color: 0x0000ff,
              position: 3,
              managed: false,
            }),
          ),
          // List to verify update
          Effect.bind('afterUpdate', () => rpc['Guild/ListGuildRoles']({ guild_id: GUILD_ID })),
          // Delete
          Effect.tap(() => rpc['Guild/DeleteGuildRole']({ guild_id: GUILD_ID, role_id: ROLE_ID })),
          // List to verify delete
          Effect.bind('afterDelete', () => rpc['Guild/ListGuildRoles']({ guild_id: GUILD_ID })),
          Effect.tap(({ afterUpdate, afterDelete }) =>
            Effect.sync(() => {
              const au = afterUpdate as any[];
              const ad = afterDelete as any[];
              const updated = au.find((r: any) => r.id === ROLE_ID);
              expect(updated).toBeDefined();
              expect(updated?.name).toBe('Defenders');
              expect(updated?.color).toBe(0x0000ff);
              const deleted = ad.find((r: any) => r.id === ROLE_ID);
              expect(deleted).toBeUndefined();
            }),
          ),
        ),
      ).pipe(Effect.provide(TestPgClient)),
    ),
  );

  itEffect.effect('SyncGuildRoles replaces role set: deletes missing, upserts present', () =>
    asTest(
      withRpc(makeTestLayer(), (rpc) =>
        Effect.Do.pipe(
          // Seed two roles
          Effect.tap(() =>
            rpc['Guild/UpsertGuildRole']({
              guild_id: GUILD_ID,
              role_id: ROLE_ID,
              name: 'Old Role A',
              color: 0,
              position: 1,
              managed: false,
            }),
          ),
          Effect.tap(() =>
            rpc['Guild/UpsertGuildRole']({
              guild_id: GUILD_ID,
              role_id: ROLE_ID_2,
              name: 'Old Role B',
              color: 0,
              position: 2,
              managed: false,
            }),
          ),
          // Sync with only ROLE_ID_2 (new name) — ROLE_ID should be deleted
          Effect.tap(() =>
            rpc['Guild/SyncGuildRoles']({
              guild_id: GUILD_ID,
              roles: [
                {
                  role_id: ROLE_ID_2,
                  name: 'Updated Role B',
                  color: 0x111111,
                  position: 1,
                  managed: false,
                },
              ],
            }),
          ),
          Effect.bind('roles', () => rpc['Guild/ListGuildRoles']({ guild_id: GUILD_ID })),
          Effect.tap(({ roles }) =>
            Effect.sync(() => {
              const r = roles as any[];
              expect(r.find((x: any) => x.id === ROLE_ID)).toBeUndefined();
              const b = r.find((x: any) => x.id === ROLE_ID_2);
              expect(b).toBeDefined();
              expect(b?.name).toBe('Updated Role B');
            }),
          ),
        ),
      ).pipe(Effect.provide(TestPgClient)),
    ),
  );

  itEffect.effect('ListGuildRoles returns seeded rows ordered by position desc', () =>
    asTest(
      withRpc(makeTestLayer(), (rpc) =>
        Effect.Do.pipe(
          Effect.tap(() =>
            rpc['Guild/UpsertGuildRole']({
              guild_id: GUILD_ID,
              role_id: ROLE_ID,
              name: 'Role A',
              color: 0,
              position: 1,
              managed: false,
            }),
          ),
          Effect.tap(() =>
            rpc['Guild/UpsertGuildRole']({
              guild_id: GUILD_ID,
              role_id: ROLE_ID_2,
              name: 'Role B',
              color: 0,
              position: 10,
              managed: true,
            }),
          ),
          Effect.bind('roles', () => rpc['Guild/ListGuildRoles']({ guild_id: GUILD_ID })),
          Effect.tap(({ roles }) =>
            Effect.sync(() => {
              const r = roles as any[];
              expect(r.length).toBeGreaterThanOrEqual(2);
              // Ordered by position desc → Role B (position 10) first
              const positions = r.map((x: any) => x.position);
              for (let i = 1; i < positions.length; i++) {
                expect(positions[i - 1]).toBeGreaterThanOrEqual(positions[i]);
              }
            }),
          ),
        ),
      ).pipe(Effect.provide(TestPgClient)),
    ),
  );

  itEffect.effect('GetOnboardingRulesRoleId returns the role id when set, None otherwise', () =>
    asTest(
      withRpc(makeTestLayer(), (rpc) =>
        Effect.Do.pipe(
          Effect.bind('withRole', () =>
            rpc['Guild/GetOnboardingRulesRoleId']({ guild_id: GUILD_ID }),
          ),
          Effect.bind('withoutRole', () =>
            rpc['Guild/GetOnboardingRulesRoleId']({ guild_id: GUILD_ID_2 }),
          ),
          Effect.tap(({ withRole, withoutRole }) =>
            Effect.sync(() => {
              expect(Option.isSome(withRole as Option.Option<unknown>)).toBe(true);
              expect(Option.getOrNull(withRole as Option.Option<unknown>)).toBe(RULES_ROLE_ID);
              expect(Option.isNone(withoutRole as Option.Option<unknown>)).toBe(true);
            }),
          ),
        ),
      ).pipe(Effect.provide(TestPgClient)),
    ),
  );

  itEffect.effect(
    'MarkOnboardingSyncDone with prompt_id=Option.none() → done, prompt_id preserved (COALESCE), returns {updated:true}',
    () =>
      asTest(
        withRpc(makeTestLayer(), (rpc) =>
          Effect.Do.pipe(
            // Seed a prompt id so we can verify COALESCE preserves it
            Effect.tap(() =>
              SqlClient.SqlClient.asEffect().pipe(
                Effect.flatMap(
                  (sql) =>
                    sql`UPDATE teams SET onboarding_rules_prompt_id = ${PROMPT_ID} WHERE id = ${TEAM_ID}`,
                ),
              ),
            ),
            // Claim the row (flip to syncing)
            Effect.tap(() => rpc['Guild/PendingOnboardingSyncs']({ limit: 20 })),
            // Mark done with Option.none() — no new prompt id from the merge
            Effect.bind('doneResult', () =>
              rpc['Guild/MarkOnboardingSyncDone']({
                team_id: TEAM_ID,
                prompt_id: Option.none(),
              }),
            ),
            Effect.bind('rowAfter', () =>
              SqlClient.SqlClient.asEffect().pipe(
                Effect.flatMap((sql) =>
                  sql`SELECT onboarding_sync_status, onboarding_rules_prompt_id FROM teams WHERE id = ${TEAM_ID}`.pipe(
                    Effect.map((rows: readonly any[]) => rows[0]),
                  ),
                ),
              ),
            ),
            Effect.tap(({ doneResult, rowAfter }) =>
              Effect.sync(() => {
                const done = doneResult as any;
                const row = rowAfter as any;
                expect(done.updated).toBe(true);
                expect(row.onboarding_sync_status).toBe('done');
                // When prompt_id is Option.none(), the existing prompt_id is preserved (COALESCE)
                expect(row.onboarding_rules_prompt_id).toBe(PROMPT_ID);
              }),
            ),
          ),
        ).pipe(Effect.provide(TestPgClient)),
      ),
  );

  itEffect.effect('RevertOnboardingSync on a done row → row stays done (no-op), no error', () =>
    asTest(
      SqlClient.SqlClient.asEffect().pipe(
        Effect.flatMap(
          (sql) =>
            // Set team 1 to done directly
            sql`UPDATE teams SET onboarding_sync_status = 'done' WHERE id = ${TEAM_ID}`,
        ),
        Effect.andThen(() =>
          withRpc(makeTestLayer(), (rpc) =>
            Effect.Do.pipe(
              // Revert on a done row should be a no-op
              Effect.tap(() => rpc['Guild/RevertOnboardingSync']({ team_id: TEAM_ID })),
              Effect.bind('rowAfter', () =>
                SqlClient.SqlClient.asEffect().pipe(
                  Effect.flatMap((sql) =>
                    sql`SELECT onboarding_sync_status FROM teams WHERE id = ${TEAM_ID}`.pipe(
                      Effect.map((rows: readonly any[]) => rows[0]?.onboarding_sync_status),
                    ),
                  ),
                ),
              ),
              Effect.tap(({ rowAfter }) =>
                Effect.sync(() => {
                  // Row stays done — RevertOnboardingSync uses WHERE status='syncing'
                  expect(rowAfter).toBe('done');
                }),
              ),
            ),
          ),
        ),
        Effect.provide(TestPgClient),
      ),
    ),
  );
});
