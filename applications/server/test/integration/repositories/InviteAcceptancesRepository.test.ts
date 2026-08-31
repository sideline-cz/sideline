// ---------------------------------------------------------------------------
// TDD for the "Discord invite link never appears" bug (PR-1).
//
// Root cause: findPending's WHERE clause required
//   b.is_community_enabled = true
// but that column defaults to false and is only true for Discord "Community"
// servers — most club servers are not. Because it's a WHERE filter rather
// than a failure path, affected acceptances get neither a discord_code nor a
// discord_code_error_code, so the UI spins on "Preparing your Discord
// invite..." forever.
//
// PR-1 deletes ONLY the `b.is_community_enabled = true` predicate.
// `AND t.welcome_channel_id IS NOT NULL` and the inner `JOIN bot_guilds b`
// deliberately REMAIN — they are removed later in PR-3, after a wire-compat
// expand release. Test 2 below is the regression test and MUST FAIL against
// current code. Tests 3 and 4 pin the PR-1/PR-3 boundary and are expected to
// be INVERTED in PR-3 (see comments on each).
// ---------------------------------------------------------------------------

import { describe, expect, it } from '@effect/vitest';
import type { Discord, InviteAcceptance, Team, TeamInvite, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { InviteAcceptancesRepository } from '~/repositories/InviteAcceptancesRepository.js';
import { TeamInvitesRepository } from '~/repositories/TeamInvitesRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  InviteAcceptancesRepository.Default,
  BotGuildsRepository.Default,
  TeamInvitesRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  );

const createTeam = (
  guildId: Discord.Snowflake,
  createdBy: User.UserId,
  welcomeChannelId: Option.Option<Discord.Snowflake> = Option.none(),
) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Test Team',
        guild_id: guildId,
        created_by: createdBy,
        description: Option.none(),
        sport: Option.none(),
        logo_url: Option.none(),
        created_at: undefined,
        updated_at: undefined,
        welcome_channel_id: welcomeChannelId,
        system_log_channel_id: Option.none(),
        welcome_message_template: Option.none(),
        rules_channel_id: Option.none(),
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

const createInvite = (teamId: Team.TeamId, createdBy: User.UserId, code: string) =>
  TeamInvitesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.create({
        team_id: teamId,
        code,
        active: true,
        created_by: createdBy,
        created_at: undefined,
        expires_at: Option.none(),
        group_id: Option.none(),
      }),
    ),
  );

const upsertGuild = (guildId: Discord.Snowflake, isCommunityEnabled: boolean) =>
  BotGuildsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.upsert(guildId, 'Test Guild', isCommunityEnabled)),
  );

const createAcceptance = (teamInviteId: TeamInvite.TeamInviteId, userId: User.UserId) =>
  InviteAcceptancesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.create({ team_invite_id: teamInviteId, user_id: userId })),
  );

const findPending = (limit: number) =>
  InviteAcceptancesRepository.asEffect().pipe(Effect.andThen((repo) => repo.findPending(limit)));

// ---------------------------------------------------------------------------
// Full "happy path" setup: user + team (with welcome channel) + community
// guild + invite + acceptance. Individual tests deviate from this baseline
// to isolate one predicate at a time.
// ---------------------------------------------------------------------------

const setupAcceptance = (options: {
  readonly guildId: Discord.Snowflake;
  readonly discordUserId: string;
  readonly username: string;
  readonly code: string;
  readonly welcomeChannelId: Option.Option<Discord.Snowflake>;
  readonly guild: Option.Option<{ readonly isCommunityEnabled: boolean }>;
}) =>
  Effect.Do.pipe(
    Effect.bind('user', () => createUser(options.discordUserId, options.username)),
    Effect.bind('team', ({ user }) =>
      createTeam(options.guildId, user.id, options.welcomeChannelId),
    ),
    Effect.tap(() =>
      Option.isSome(options.guild)
        ? upsertGuild(options.guildId, options.guild.value.isCommunityEnabled)
        : Effect.void,
    ),
    Effect.bind('invite', ({ user, team }) => createInvite(team.id, user.id, options.code)),
    Effect.bind('acceptance', ({ user, invite }) => createAcceptance(invite.id, user.id)),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InviteAcceptancesRepository — findPending', () => {
  it.effect('returns an acceptance for a team with a welcome channel and a community guild', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () =>
        setupAcceptance({
          guildId: '600000000000000001' as Discord.Snowflake,
          discordUserId: '700000000000000001',
          username: 'joiner-one',
          code: 'PENDING-BASELINE',
          welcomeChannelId: Option.some('800000000000000001' as Discord.Snowflake),
          guild: Option.some({ isCommunityEnabled: true }),
        }),
      ),
      Effect.bind('pending', ({ setup }) =>
        findPending(10).pipe(Effect.map((rows) => ({ rows, setup }))),
      ),
      Effect.tap(({ pending }) =>
        Effect.sync(() => {
          expect(pending.rows.length).toBe(1);
          expect(pending.rows[0].acceptance_id).toBe(pending.setup.acceptance.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // -------------------------------------------------------------------------
  // REGRESSION TEST — this is the bug. Must FAIL against current code (the
  // `is_community_enabled = true` predicate incorrectly excludes this row).
  // -------------------------------------------------------------------------
  it.effect('returns an acceptance when the guild is NOT community-enabled', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () =>
        setupAcceptance({
          guildId: '600000000000000002' as Discord.Snowflake,
          discordUserId: '700000000000000002',
          username: 'joiner-two',
          code: 'PENDING-NON-COMMUNITY',
          welcomeChannelId: Option.some('800000000000000002' as Discord.Snowflake),
          guild: Option.some({ isCommunityEnabled: false }),
        }),
      ),
      Effect.bind('pending', ({ setup }) =>
        findPending(10).pipe(Effect.map((rows) => ({ rows, setup }))),
      ),
      Effect.tap(({ pending }) =>
        Effect.sync(() => {
          expect(pending.rows.length).toBe(1);
          expect(pending.rows[0].acceptance_id).toBe(pending.setup.acceptance.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // INVERTED IN PR-3 (was "still excludes a team with no welcome_channel_id"): `t.welcome_channel_id
  // IS NOT NULL` is no longer part of findPending's WHERE clause. A null welcome channel is now a
  // failure path (the bot's `welcome_channel_missing` short-circuit), not a silent SQL filter — the
  // row must be selected so the bot can fail it loudly.
  it.effect('findPending returns an acceptance when the team has no welcome_channel_id', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () =>
        setupAcceptance({
          guildId: '600000000000000003' as Discord.Snowflake,
          discordUserId: '700000000000000003',
          username: 'joiner-three',
          code: 'PENDING-NO-WELCOME-CHANNEL',
          welcomeChannelId: Option.none(),
          guild: Option.some({ isCommunityEnabled: true }),
        }),
      ),
      Effect.bind('pending', ({ setup }) =>
        findPending(10).pipe(Effect.map((rows) => ({ rows, setup }))),
      ),
      Effect.tap(({ pending }) =>
        Effect.sync(() => {
          expect(pending.rows.length).toBe(1);
          expect(pending.rows[0].acceptance_id).toBe(pending.setup.acceptance.id);
          expect(Option.isNone(pending.rows[0].welcome_channel_id)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // INVERTED IN PR-3 (was "still excludes an acceptance whose team's guild has no bot_guilds row"):
  // the `bot_guilds` join is now a LEFT JOIN. An acceptance whose team's guild has no bot_guilds row
  // is selected with `bot_present: false`, so the bot can fail it loudly with `bot_not_in_guild`
  // instead of the row vanishing forever.
  it.effect('findPending returns bot_present: false when no bot_guilds row exists', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () =>
        setupAcceptance({
          guildId: '600000000000000004' as Discord.Snowflake,
          discordUserId: '700000000000000004',
          username: 'joiner-four',
          code: 'PENDING-NO-BOT-GUILD-ROW',
          welcomeChannelId: Option.some('800000000000000004' as Discord.Snowflake),
          guild: Option.none(),
        }),
      ),
      Effect.bind('pending', ({ setup }) =>
        findPending(10).pipe(Effect.map((rows) => ({ rows, setup }))),
      ),
      Effect.tap(({ pending }) =>
        Effect.sync(() => {
          expect(pending.rows.length).toBe(1);
          expect(pending.rows[0].acceptance_id).toBe(pending.setup.acceptance.id);
          expect(pending.rows[0].bot_present).toBe(false);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // PR-3, CC-4: no age predicate. A 90-day-old open acceptance must still be returned — the sweep
  // (not a SQL filter) is what bounds stale rows.
  it.effect('findPending does not filter by age', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () =>
        setupAcceptance({
          guildId: '600000000000000014' as Discord.Snowflake,
          discordUserId: '700000000000000014',
          username: 'joiner-fourteen',
          code: 'PENDING-VERY-OLD',
          welcomeChannelId: Option.some('800000000000000014' as Discord.Snowflake),
          guild: Option.some({ isCommunityEnabled: true }),
        }),
      ),
      Effect.tap(({ setup }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen(
            (sql) => sql`
              UPDATE invite_acceptances SET created_at = now() - interval '90 days'
              WHERE id = ${setup.acceptance.id}
            `,
          ),
        ),
      ),
      Effect.bind('pending', ({ setup }) =>
        findPending(10).pipe(Effect.map((rows) => ({ rows, setup }))),
      ),
      Effect.tap(({ pending }) =>
        Effect.sync(() => {
          expect(pending.rows.length).toBe(1);
          expect(pending.rows[0].acceptance_id).toBe(pending.setup.acceptance.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // PR-3, CC-0 rule 2: a `welcome_channel_missing` row is fixable by a captain setting the welcome
  // channel, so it must re-open once `teams.welcome_channel_id` becomes non-null.
  it.effect(
    'findPending re-opens a welcome_channel_missing row once the team gets a welcome channel',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () =>
          setupAcceptance({
            guildId: '600000000000000015' as Discord.Snowflake,
            discordUserId: '700000000000000015',
            username: 'joiner-fifteen',
            code: 'PENDING-WELCOME-REOPEN',
            welcomeChannelId: Option.none(),
            guild: Option.some({ isCommunityEnabled: true }),
          }),
        ),
        Effect.tap(({ setup }) =>
          InviteAcceptancesRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.markFailed({
                acceptanceId: setup.acceptance.id,
                errorCode: 'welcome_channel_missing',
                errorDetail: 'Team has no welcome channel configured',
              }),
            ),
          ),
        ),
        // Bypasses the repository's full `update` (which requires every column) — this test only
        // cares about the one column `findPending`'s re-open clause reads.
        Effect.tap(({ setup }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen(
              (sql) => sql`
                UPDATE teams SET welcome_channel_id = '800000000000000015'
                WHERE id = ${setup.team.id}
              `,
            ),
          ),
        ),
        Effect.bind('pending', ({ setup }) =>
          findPending(10).pipe(Effect.map((rows) => ({ rows, setup }))),
        ),
        Effect.tap(({ pending }) =>
          Effect.sync(() => {
            expect(pending.rows.length).toBe(1);
            expect(pending.rows[0].acceptance_id).toBe(pending.setup.acceptance.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'findPending still excludes a welcome_channel_missing row while welcome_channel_id is NULL',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () =>
          setupAcceptance({
            guildId: '600000000000000016' as Discord.Snowflake,
            discordUserId: '700000000000000016',
            username: 'joiner-sixteen',
            code: 'PENDING-WELCOME-STILL-MISSING',
            welcomeChannelId: Option.none(),
            guild: Option.some({ isCommunityEnabled: true }),
          }),
        ),
        Effect.tap(({ setup }) =>
          InviteAcceptancesRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.markFailed({
                acceptanceId: setup.acceptance.id,
                errorCode: 'welcome_channel_missing',
                errorDetail: 'Team has no welcome channel configured',
              }),
            ),
          ),
        ),
        Effect.bind('pending', () => findPending(10)),
        Effect.tap(({ pending }) =>
          Effect.sync(() => {
            expect(pending.length).toBe(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('findPending still excludes rows with any other error code', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () =>
        setupAcceptance({
          guildId: '600000000000000017' as Discord.Snowflake,
          discordUserId: '700000000000000017',
          username: 'joiner-seventeen',
          code: 'PENDING-OTHER-ERROR-CODE',
          welcomeChannelId: Option.some('800000000000000017' as Discord.Snowflake),
          guild: Option.some({ isCommunityEnabled: true }),
        }),
      ),
      Effect.tap(({ setup }) =>
        InviteAcceptancesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.markFailed({
              acceptanceId: setup.acceptance.id,
              errorCode: 'bot_missing_perms',
              errorDetail: 'missing perms',
            }),
          ),
        ),
      ),
      Effect.bind('pending', () => findPending(10)),
      Effect.tap(({ pending }) =>
        Effect.sync(() => {
          expect(pending.length).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('excludes acceptances that already have a discord_code', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () =>
        setupAcceptance({
          guildId: '600000000000000005' as Discord.Snowflake,
          discordUserId: '700000000000000005',
          username: 'joiner-five',
          code: 'PENDING-ALREADY-GENERATED',
          welcomeChannelId: Option.some('800000000000000005' as Discord.Snowflake),
          guild: Option.some({ isCommunityEnabled: true }),
        }),
      ),
      Effect.tap(({ setup }) =>
        InviteAcceptancesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.setDiscordCode({
              acceptanceId: setup.acceptance.id,
              discordCode: 'already-generated-code',
            }),
          ),
        ),
      ),
      Effect.bind('pending', () => findPending(10)),
      Effect.tap(({ pending }) =>
        Effect.sync(() => {
          expect(pending.length).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('excludes acceptances already marked failed', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () =>
        setupAcceptance({
          guildId: '600000000000000006' as Discord.Snowflake,
          discordUserId: '700000000000000006',
          username: 'joiner-six',
          code: 'PENDING-ALREADY-FAILED',
          welcomeChannelId: Option.some('800000000000000006' as Discord.Snowflake),
          guild: Option.some({ isCommunityEnabled: true }),
        }),
      ),
      Effect.tap(({ setup }) =>
        InviteAcceptancesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.markFailed({
              acceptanceId: setup.acceptance.id,
              errorCode: 'bot_missing_perms',
              errorDetail: 'missing perms',
            }),
          ),
        ),
      ),
      Effect.bind('pending', () => findPending(10)),
      Effect.tap(({ pending }) =>
        Effect.sync(() => {
          expect(pending.length).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('orders by created_at ASC and honours the limit', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('700000000000000007', 'joiner-seven')),
      Effect.bind('team', ({ user }) =>
        createTeam(
          '600000000000000007' as Discord.Snowflake,
          user.id,
          Option.some('800000000000000007' as Discord.Snowflake),
        ),
      ),
      Effect.tap(({ team }) => upsertGuild(team.guild_id, true)),
      Effect.bind('invite1', ({ user, team }) => createInvite(team.id, user.id, 'ORDER-CODE-ONE')),
      Effect.bind('invite2', ({ user, team }) => createInvite(team.id, user.id, 'ORDER-CODE-TWO')),
      Effect.bind('invite3', ({ user, team }) =>
        createInvite(team.id, user.id, 'ORDER-CODE-THREE'),
      ),
      Effect.bind('acceptance1', ({ user, invite1 }) => createAcceptance(invite1.id, user.id)),
      Effect.bind('acceptance2', ({ user, invite2 }) => createAcceptance(invite2.id, user.id)),
      Effect.bind('acceptance3', ({ user, invite3 }) => createAcceptance(invite3.id, user.id)),
      Effect.bind('pending', () => findPending(2)),
      Effect.tap(({ pending, acceptance1, acceptance2 }) =>
        Effect.sync(() => {
          expect(pending.length).toBe(2);
          expect(pending[0].acceptance_id).toBe(acceptance1.id);
          expect(pending[1].acceptance_id).toBe(acceptance2.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// PR-3 (Discord onboarding fix), CC-14 step 5 — `setDiscordCode` must clear any previously-stored
// error so a row re-opened via the `welcome_channel_missing` re-open clause (or the regenerate
// primitive) never ends up with both a `discord_code` and a stale `discord_code_error_code`.
// ---------------------------------------------------------------------------

describe('InviteAcceptancesRepository — setDiscordCode (PR-3, CC-14 step 5)', () => {
  it.effect('clears discord_code_error_code and discord_code_error_detail', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () =>
        setupAcceptance({
          guildId: '600000000000000018' as Discord.Snowflake,
          discordUserId: '700000000000000018',
          username: 'joiner-eighteen',
          code: 'PENDING-SET-CODE-CLEARS-ERROR',
          welcomeChannelId: Option.some('800000000000000018' as Discord.Snowflake),
          guild: Option.some({ isCommunityEnabled: true }),
        }),
      ),
      Effect.tap(({ setup }) =>
        InviteAcceptancesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.markFailed({
              acceptanceId: setup.acceptance.id,
              errorCode: 'welcome_channel_missing',
              errorDetail: 'Team has no welcome channel configured',
            }),
          ),
        ),
      ),
      Effect.tap(({ setup }) =>
        InviteAcceptancesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.setDiscordCode({
              acceptanceId: setup.acceptance.id,
              discordCode: 'freshly-generated-code',
            }),
          ),
        ),
      ),
      Effect.bind('reloaded', ({ setup }) =>
        InviteAcceptancesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findById(setup.acceptance.id)),
        ),
      ),
      Effect.tap(({ reloaded }) =>
        Effect.sync(() => {
          expect(Option.isSome(reloaded)).toBe(true);
          if (Option.isSome(reloaded)) {
            expect(Option.isSome(reloaded.value.discord_code)).toBe(true);
            expect(Option.getOrThrow(reloaded.value.discord_code)).toBe('freshly-generated-code');
            expect(Option.isNone(reloaded.value.discord_code_error_code)).toBe(true);
            expect(Option.isNone(reloaded.value.discord_code_error_detail)).toBe(true);
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// PR-3 (Discord onboarding fix), CC-4 / CC-5 — the expiry sweep. Idempotent, closes the entire
// stuck backlog to the terminal `'expired'` code, and NEVER touches `created_at` (CC-5 rejects
// rewriting audit timestamps outright — that was rev 1's rejected backfill).
// ---------------------------------------------------------------------------

const sweepExpired = (olderThanDays: number) =>
  InviteAcceptancesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.sweepExpired(olderThanDays)),
  );

const findById = (id: InviteAcceptance.InviteAcceptanceId) =>
  InviteAcceptancesRepository.asEffect().pipe(Effect.andThen((repo) => repo.findById(id)));

const setupAgedAcceptance = (options: {
  readonly guildId: Discord.Snowflake;
  readonly discordUserId: string;
  readonly username: string;
  readonly code: string;
  readonly ageDays: number;
}) =>
  Effect.Do.pipe(
    Effect.bind('user', () => createUser(options.discordUserId, options.username)),
    Effect.bind('team', ({ user }) => createTeam(options.guildId, user.id)),
    Effect.bind('invite', ({ user, team }) => createInvite(team.id, user.id, options.code)),
    Effect.bind('acceptance', ({ user, invite }) => createAcceptance(invite.id, user.id)),
    Effect.tap(({ acceptance }) =>
      SqlClient.SqlClient.asEffect().pipe(
        Effect.andThen(
          (sql) => sql`
            UPDATE invite_acceptances SET created_at = now() - (${options.ageDays} * interval '1 day')
            WHERE id = ${acceptance.id}
          `,
        ),
      ),
    ),
  );

describe('InviteAcceptancesRepository — sweepExpired (PR-3, CC-4 / CC-5)', () => {
  it.effect('closes rows older than the window', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () =>
        setupAgedAcceptance({
          guildId: '600000000000000019' as Discord.Snowflake,
          discordUserId: '700000000000000019',
          username: 'joiner-nineteen',
          code: 'SWEEP-OLD-ROW',
          ageDays: 4,
        }),
      ),
      Effect.tap(() => sweepExpired(3)),
      Effect.bind('reloaded', ({ setup }) => findById(setup.acceptance.id)),
      Effect.tap(({ reloaded }) =>
        Effect.sync(() => {
          expect(Option.isSome(reloaded)).toBe(true);
          if (Option.isSome(reloaded)) {
            expect(Option.isSome(reloaded.value.discord_code_error_code)).toBe(true);
            expect(Option.getOrThrow(reloaded.value.discord_code_error_code)).toBe('expired');
            expect(Option.isSome(reloaded.value.discord_code_error_detail)).toBe(true);
            expect(Option.getOrThrow(reloaded.value.discord_code_error_detail)).toBe(
              'aged out before generation',
            );
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // Guards CC-5: rev 1's rejected backfill rewrote `created_at`. The sweep must never do that.
  it.effect('does not modify created_at', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () =>
        setupAgedAcceptance({
          guildId: '600000000000000020' as Discord.Snowflake,
          discordUserId: '700000000000000020',
          username: 'joiner-twenty',
          code: 'SWEEP-CREATED-AT-GUARD',
          ageDays: 4,
        }),
      ),
      Effect.bind('before', ({ setup }) => findById(setup.acceptance.id)),
      Effect.tap(() => sweepExpired(3)),
      Effect.bind('after', ({ setup }) => findById(setup.acceptance.id)),
      Effect.tap(({ before, after }) =>
        Effect.sync(() => {
          expect(Option.isSome(before)).toBe(true);
          expect(Option.isSome(after)).toBe(true);
          if (Option.isSome(before) && Option.isSome(after)) {
            expect(DateTime.toEpochMillis(after.value.created_at)).toBe(
              DateTime.toEpochMillis(before.value.created_at),
            );
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('leaves rows inside the window untouched', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () =>
        setupAgedAcceptance({
          guildId: '600000000000000021' as Discord.Snowflake,
          discordUserId: '700000000000000021',
          username: 'joiner-twentyone',
          code: 'SWEEP-INSIDE-WINDOW',
          ageDays: 1,
        }),
      ),
      Effect.tap(() => sweepExpired(3)),
      Effect.bind('reloaded', ({ setup }) => findById(setup.acceptance.id)),
      Effect.tap(({ reloaded }) =>
        Effect.sync(() => {
          expect(Option.isSome(reloaded)).toBe(true);
          if (Option.isSome(reloaded)) {
            expect(Option.isNone(reloaded.value.discord_code_error_code)).toBe(true);
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('is idempotent — a second run affects 0 rows and does not change generated_at', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () =>
        setupAgedAcceptance({
          guildId: '600000000000000022' as Discord.Snowflake,
          discordUserId: '700000000000000022',
          username: 'joiner-twentytwo',
          code: 'SWEEP-IDEMPOTENT',
          ageDays: 4,
        }),
      ),
      Effect.tap(() => sweepExpired(3)),
      Effect.bind('first', ({ setup }) => findById(setup.acceptance.id)),
      // Second run must be a no-op: `discord_code_error_code IS NULL` is no longer true, so the
      // WHERE clause excludes this row and `generated_at` must not move again.
      Effect.tap(() => sweepExpired(3)),
      Effect.bind('second', ({ setup }) => findById(setup.acceptance.id)),
      Effect.tap(({ first, second }) =>
        Effect.sync(() => {
          expect(Option.isSome(first)).toBe(true);
          expect(Option.isSome(second)).toBe(true);
          if (Option.isSome(first) && Option.isSome(second)) {
            expect(Option.isSome(first.value.generated_at)).toBe(true);
            expect(Option.isSome(second.value.generated_at)).toBe(true);
            if (
              Option.isSome(first.value.generated_at) &&
              Option.isSome(second.value.generated_at)
            ) {
              expect(second.value.generated_at.value.getTime()).toBe(
                first.value.generated_at.value.getTime(),
              );
            }
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('does not touch rows that already have a discord_code', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () =>
        setupAgedAcceptance({
          guildId: '600000000000000023' as Discord.Snowflake,
          discordUserId: '700000000000000023',
          username: 'joiner-twentythree',
          code: 'SWEEP-HAS-CODE',
          ageDays: 4,
        }),
      ),
      Effect.tap(({ setup }) =>
        InviteAcceptancesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.setDiscordCode({
              acceptanceId: setup.acceptance.id,
              discordCode: 'already-generated-before-sweep',
            }),
          ),
        ),
      ),
      Effect.tap(() => sweepExpired(3)),
      Effect.bind('reloaded', ({ setup }) => findById(setup.acceptance.id)),
      Effect.tap(({ reloaded }) =>
        Effect.sync(() => {
          expect(Option.isSome(reloaded)).toBe(true);
          if (Option.isSome(reloaded)) {
            expect(Option.isNone(reloaded.value.discord_code_error_code)).toBe(true);
            expect(Option.isSome(reloaded.value.discord_code)).toBe(true);
            expect(Option.getOrThrow(reloaded.value.discord_code)).toBe(
              'already-generated-before-sweep',
            );
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('does not touch rows that already have an error code', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () =>
        setupAgedAcceptance({
          guildId: '600000000000000024' as Discord.Snowflake,
          discordUserId: '700000000000000024',
          username: 'joiner-twentyfour',
          code: 'SWEEP-HAS-ERROR',
          ageDays: 4,
        }),
      ),
      Effect.tap(({ setup }) =>
        InviteAcceptancesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.markFailed({
              acceptanceId: setup.acceptance.id,
              errorCode: 'bot_missing_perms',
              errorDetail: 'missing perms',
            }),
          ),
        ),
      ),
      Effect.tap(() => sweepExpired(3)),
      Effect.bind('reloaded', ({ setup }) => findById(setup.acceptance.id)),
      Effect.tap(({ reloaded }) =>
        Effect.sync(() => {
          expect(Option.isSome(reloaded)).toBe(true);
          if (Option.isSome(reloaded)) {
            expect(Option.isSome(reloaded.value.discord_code_error_code)).toBe(true);
            expect(Option.getOrThrow(reloaded.value.discord_code_error_code)).toBe(
              'bot_missing_perms',
            );
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// TDD for PR-4 (Discord onboarding fix), CC-14 — `findOpenByUserAndInvite` and
// `countRecentByUser`, the two new reads `resolveOrCreateAcceptance` is built on.
// Neither method exists on the repository yet, so every test below MUST FAIL against
// current code (calling them throws — there is nothing to invert here, they are net new).
// See `.work-plans/discord-onboarding-fix-plan.md`, PR-4 test list items 12, 13, 16.
// ---------------------------------------------------------------------------

const markFailed = (acceptanceId: InviteAcceptance.InviteAcceptanceId, errorCode: string) =>
  InviteAcceptancesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.markFailed({
        acceptanceId,
        errorCode: errorCode as never,
        errorDetail: 'test failure',
      }),
    ),
  );

const findOpenByUserAndInvite = (userId: User.UserId, teamInviteId: TeamInvite.TeamInviteId) =>
  InviteAcceptancesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findOpenByUserAndInvite(userId, teamInviteId)),
  );

// BLOCKER 1 (third review of PR-4): scoped to the (user, invite) pair — see CC-14 (plan
// ~line 630, "if regenerations in the last hour >= 3" — regenerations of *this* invite, not a
// global count of everything the user has ever created). Renamed from `countRecentByUser`,
// which no longer describes what it counts once the pair is added.
const countRecentByUserAndInvite = (userId: User.UserId, teamInviteId: TeamInvite.TeamInviteId) =>
  InviteAcceptancesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.countRecentByUserAndInvite(userId, teamInviteId)),
  );

// Bypasses the repository (which always writes `created_at = now()`) so the recency window in
// `countRecentByUserAndInvite` has something outside it to exclude.
const insertOldAcceptance = (teamInviteId: TeamInvite.TeamInviteId, userId: User.UserId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        INSERT INTO invite_acceptances (team_invite_id, user_id, created_at)
        VALUES (${teamInviteId}, ${userId}, now() - interval '2 hours')
      `,
    ),
  );

// Backdates an existing row's `created_at` in place (rather than inserting two rows in the
// same tick and relying on `id DESC` to break the tie — see the nit below).
const backdateCreatedAt = (acceptanceId: InviteAcceptance.InviteAcceptanceId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        UPDATE invite_acceptances SET created_at = now() - interval '2 hours'
        WHERE id = ${acceptanceId}
      `,
    ),
  );

// BLOCKER 2 (third review of PR-4): the bot mints single-use, 24h-lived Discord codes
// (`applications/bot/src/rcp/inviteGenerator/ProcessorService.ts` — `max_age: 86400,
// max_uses: 1`). `setDiscordCode` always writes `generated_at = now()`, so this bypasses the
// repository to backdate it, simulating a code minted more than 24h ago.
const backdateGeneratedAt = (acceptanceId: InviteAcceptance.InviteAcceptanceId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        UPDATE invite_acceptances
        SET generated_at = now() - interval '25 hours'
        WHERE id = ${acceptanceId}
      `,
    ),
  );

describe('InviteAcceptancesRepository — findOpenByUserAndInvite (TDD: PR-4 CC-14)', () => {
  it.effect(
    'returns the newest open row when more than one exists for the same (user, invite)',
    () =>
      Effect.Do.pipe(
        Effect.bind('user', () => createUser('700000000000000008', 'joiner-eight')),
        Effect.bind('team', ({ user }) =>
          createTeam('600000000000000008' as Discord.Snowflake, user.id),
        ),
        Effect.bind('invite', ({ user, team }) =>
          createInvite(team.id, user.id, 'OPEN-ACCEPTANCE-CODE'),
        ),
        // NIT (third review of PR-4): explicit, distinct `created_at` values rather than two
        // back-to-back inserts via the repository (which both write `now()` and could land in
        // the same tick) — `id DESC` is a random tiebreaker (`id` is `gen_random_uuid()`), so
        // relying on it to break a `created_at` tie would flake ~50% of the time.
        Effect.bind('older', ({ user, invite }) => createAcceptance(invite.id, user.id)),
        Effect.tap(({ older }) => backdateCreatedAt(older.id)),
        Effect.bind('newer', ({ user, invite }) => createAcceptance(invite.id, user.id)),
        Effect.bind('open', ({ user, invite }) => findOpenByUserAndInvite(user.id, invite.id)),
        Effect.tap(({ open, newer }) =>
          Effect.sync(() => {
            expect(Option.isSome(open)).toBe(true);
            if (Option.isSome(open)) {
              expect(open.value.id).toBe(newer.id);
            }
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'skips a row with a discord_code_error_code — a terminally failed row is not "open"',
    () =>
      Effect.Do.pipe(
        Effect.bind('user', () => createUser('700000000000000009', 'joiner-nine')),
        Effect.bind('team', ({ user }) =>
          createTeam('600000000000000009' as Discord.Snowflake, user.id),
        ),
        Effect.bind('invite', ({ user, team }) =>
          createInvite(team.id, user.id, 'FAILED-ACCEPTANCE-CODE'),
        ),
        Effect.bind('acceptance', ({ user, invite }) => createAcceptance(invite.id, user.id)),
        Effect.tap(({ acceptance }) => markFailed(acceptance.id, 'bot_missing_perms')),
        Effect.bind('open', ({ user, invite }) => findOpenByUserAndInvite(user.id, invite.id)),
        Effect.tap(({ open }) =>
          Effect.sync(() => {
            expect(Option.isNone(open)).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  // BLOCKER 2 (third review of PR-4): a code-bearing row must only be "open" while its
  // one-time Discord code can still work. The bot mints codes with `max_age: 86400`
  // (`applications/bot/src/rcp/inviteGenerator/ProcessorService.ts`), so a row whose code was
  // generated more than 24h ago is dead — reusing it hands the user a link that 404s on
  // Discord's side, with nothing to regenerate it (`findPending` only picks up rows with
  // `discord_code IS NULL`). MUST FAIL against current code: `findOpenByUserAndInvite` today
  // treats any row without a `discord_code_error_code` as open, regardless of code age.
  it.effect('does not reuse a row whose discord_code was generated more than 24h ago', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('700000000000000011', 'joiner-eleven')),
      Effect.bind('team', ({ user }) =>
        createTeam('600000000000000011' as Discord.Snowflake, user.id),
      ),
      Effect.bind('invite', ({ user, team }) =>
        createInvite(team.id, user.id, 'STALE-CODE-ACCEPTANCE'),
      ),
      Effect.bind('acceptance', ({ user, invite }) => createAcceptance(invite.id, user.id)),
      Effect.tap(({ acceptance }) =>
        InviteAcceptancesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.setDiscordCode({ acceptanceId: acceptance.id, discordCode: 'stale-code' }),
          ),
        ),
      ),
      Effect.tap(({ acceptance }) => backdateGeneratedAt(acceptance.id)),
      Effect.bind('open', ({ user, invite }) => findOpenByUserAndInvite(user.id, invite.id)),
      Effect.tap(({ open }) =>
        Effect.sync(() => {
          expect(Option.isNone(open)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('still reuses a row whose discord_code was generated within the last 24h', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('700000000000000012', 'joiner-twelve')),
      Effect.bind('team', ({ user }) =>
        createTeam('600000000000000012' as Discord.Snowflake, user.id),
      ),
      Effect.bind('invite', ({ user, team }) =>
        createInvite(team.id, user.id, 'FRESH-CODE-ACCEPTANCE'),
      ),
      Effect.bind('acceptance', ({ user, invite }) => createAcceptance(invite.id, user.id)),
      Effect.tap(({ acceptance }) =>
        InviteAcceptancesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.setDiscordCode({ acceptanceId: acceptance.id, discordCode: 'fresh-code' }),
          ),
        ),
      ),
      Effect.bind('open', ({ user, invite }) => findOpenByUserAndInvite(user.id, invite.id)),
      Effect.tap(({ open, acceptance }) =>
        Effect.sync(() => {
          expect(Option.isSome(open)).toBe(true);
          if (Option.isSome(open)) {
            expect(open.value.id).toBe(acceptance.id);
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('InviteAcceptancesRepository — countRecentByUserAndInvite (TDD: PR-4 CC-14, BLOCKER 1)', () => {
  it.effect(
    'counts only acceptances for this (user, invite) pair created within the last hour',
    () =>
      Effect.Do.pipe(
        Effect.bind('user', () => createUser('700000000000000010', 'joiner-ten')),
        Effect.bind('team', ({ user }) =>
          createTeam('600000000000000010' as Discord.Snowflake, user.id),
        ),
        Effect.bind('invite1', ({ user, team }) =>
          createInvite(team.id, user.id, 'RECENT-COUNT-CODE-ONE'),
        ),
        Effect.bind('invite3', ({ user, team }) =>
          createInvite(team.id, user.id, 'RECENT-COUNT-CODE-THREE'),
        ),
        // Two recent acceptances on invite1 (via the repository, so created_at = now())...
        Effect.tap(({ user, invite1 }) => createAcceptance(invite1.id, user.id)),
        Effect.tap(({ user, invite1 }) => createAcceptance(invite1.id, user.id)),
        // ...and one old one on invite1, outside the 1-hour window, which must NOT be counted.
        Effect.tap(({ user, invite1 }) => insertOldAcceptance(invite1.id, user.id)),
        // A recent acceptance on a DIFFERENT invite, which must not inflate invite1's count.
        Effect.tap(({ user, invite3 }) => createAcceptance(invite3.id, user.id)),
        Effect.bind('count', ({ user, invite1 }) =>
          countRecentByUserAndInvite(user.id, invite1.id),
        ),
        Effect.tap(({ count }) =>
          Effect.sync(() => {
            expect(count).toBe(2);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  // BLOCKER 1 (third review of PR-4) — this is the reported production bug, reproduced at the
  // repository level: a new user invited to four squads of the same club joins three (one
  // regeneration/acceptance each), then clicks the fourth invite for the first time. The
  // pre-fix query counted every acceptance the user ever created across ALL invites, so this
  // returns 3 (>= the cap) for an invite the user has never touched, which makes
  // `resolveOrCreateAcceptance` fail closed — no acceptance, no banner, no error. MUST FAIL
  // against current code: `countRecentByUserAndInvite(user, invite4)` returns 3, not 0.
  it.effect(
    'does not count acceptances created for a different invite (four-squads regression)',
    () =>
      Effect.Do.pipe(
        Effect.bind('user', () => createUser('700000000000000013', 'joiner-thirteen')),
        Effect.bind('team', ({ user }) =>
          createTeam('600000000000000013' as Discord.Snowflake, user.id),
        ),
        Effect.bind('invite1', ({ user, team }) =>
          createInvite(team.id, user.id, 'FOUR-SQUADS-CODE-ONE'),
        ),
        Effect.bind('invite2', ({ user, team }) =>
          createInvite(team.id, user.id, 'FOUR-SQUADS-CODE-TWO'),
        ),
        Effect.bind('invite3', ({ user, team }) =>
          createInvite(team.id, user.id, 'FOUR-SQUADS-CODE-THREE'),
        ),
        Effect.bind('invite4', ({ user, team }) =>
          createInvite(team.id, user.id, 'FOUR-SQUADS-CODE-FOUR'),
        ),
        Effect.tap(({ user, invite1 }) => createAcceptance(invite1.id, user.id)),
        Effect.tap(({ user, invite2 }) => createAcceptance(invite2.id, user.id)),
        Effect.tap(({ user, invite3 }) => createAcceptance(invite3.id, user.id)),
        Effect.bind('countInvite1', ({ user, invite1 }) =>
          countRecentByUserAndInvite(user.id, invite1.id),
        ),
        Effect.bind('countInvite4', ({ user, invite4 }) =>
          countRecentByUserAndInvite(user.id, invite4.id),
        ),
        Effect.tap(({ countInvite1, countInvite4 }) =>
          Effect.sync(() => {
            expect(countInvite1).toBe(1);
            expect(countInvite4).toBe(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
// ---------------------------------------------------------------------------
// TDD for PR-5 (Discord onboarding fix), CC-14 / step 5 — `findOpenByUserAndTeam`,
// the read `getMyPendingDiscordJoin` is built on. As `findOpenByUserAndInvite` joined
// through `team_invite_id`, this joins `team_invites ti ON ti.id = ia.team_invite_id`
// and filters `ti.team_id = $teamId`, newest first. The method does not exist on the
// repository yet — every test below MUST FAIL against current code (calling it throws).
// See `.work-plans/discord-onboarding-fix-plan.md`, PR-5 test list (repository-level
// coverage for `getMyPendingDiscordJoin`, items 7 and 9).
// ---------------------------------------------------------------------------

const findOpenByUserAndTeam = (
  userId: User.UserId,
  teamId: Team.TeamId,
): Effect.Effect<
  Option.Option<InviteAcceptance.InviteAcceptance>,
  never,
  InviteAcceptancesRepository
> =>
  InviteAcceptancesRepository.asEffect().pipe(
    Effect.andThen(
      (repo) =>
        (repo as any).findOpenByUserAndTeam(userId, teamId) as Effect.Effect<
          Option.Option<InviteAcceptance.InviteAcceptance>,
          never,
          never
        >,
    ),
  );

describe('InviteAcceptancesRepository — findOpenByUserAndTeam (TDD: PR-5 CC-14)', () => {
  it.effect('returns the newest open row for a (user, team) pair', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('700000000000000020', 'joiner-twenty')),
      Effect.bind('team', ({ user }) =>
        createTeam('600000000000000020' as Discord.Snowflake, user.id),
      ),
      Effect.bind('invite', ({ user, team }) =>
        createInvite(team.id, user.id, 'PR5-OPEN-BY-TEAM-CODE'),
      ),
      Effect.bind('older', ({ user, invite }) => createAcceptance(invite.id, user.id)),
      Effect.tap(({ older }) => backdateCreatedAt(older.id)),
      Effect.bind('newer', ({ user, invite }) => createAcceptance(invite.id, user.id)),
      Effect.bind('open', ({ user, team }) => findOpenByUserAndTeam(user.id, team.id)),
      Effect.tap(({ open, newer }) =>
        Effect.sync(() => {
          expect(Option.isSome(open)).toBe(true);
          if (Option.isSome(open)) {
            expect(open.value.id).toBe(newer.id);
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // Blocker B (whole-series review of `fix/discord-onboarding-webapp`): this test used to assert
  // the opposite — that a row with `discord_code_error_code` set was excluded here. That filter
  // was the bug: `getMyPendingDiscordJoin` (the only web caller) is built directly on this
  // method, and `deriveJoinStatusState` already knows how to turn a `discord_code_error_code`
  // into `state: 'failed'` with the matching wire `errorCode` — including
  // `welcome_channel_missing`, the dominant cohort of the original onboarding root cause, since
  // the onboarding wizard makes the welcome channel optional. Filtering the row out here meant
  // `getMyPendingDiscordJoin` returned `None` for it instead, the UI showed "we need a fresh
  // invite", and the regenerate button re-minted an acceptance that failed the exact same way,
  // up to three times an hour, forever — the one actionable error message in the product
  // unreachable. `findOpenByUserAndTeam` now returns the newest row for the pair REGARDLESS of
  // `discord_code_error_code`; `deriveJoinStatusState` is the thing that decides what it means,
  // not the SQL. The staleness clause (`generated_at > now() - 24h`) still applies only to the
  // `discord_code IS NOT NULL` case — see the test below this one.
  it.effect(
    'returns a row even when discord_code_error_code is set — deriveJoinStatusState decides, not the SQL',
    () =>
      Effect.Do.pipe(
        Effect.bind('user', () => createUser('700000000000000021', 'joiner-twentyone')),
        Effect.bind('team', ({ user }) =>
          createTeam('600000000000000021' as Discord.Snowflake, user.id),
        ),
        Effect.bind('invite', ({ user, team }) =>
          createInvite(team.id, user.id, 'PR5-FAILED-BY-TEAM-CODE'),
        ),
        Effect.bind('acceptance', ({ user, invite }) => createAcceptance(invite.id, user.id)),
        Effect.tap(({ acceptance }) => markFailed(acceptance.id, 'welcome_channel_missing')),
        Effect.bind('open', ({ user, team }) => findOpenByUserAndTeam(user.id, team.id)),
        Effect.tap(({ open, acceptance }) =>
          Effect.sync(() => {
            expect(Option.isSome(open)).toBe(true);
            if (Option.isSome(open)) {
              expect(open.value.id).toBe(acceptance.id);
              expect(Option.isSome(open.value.discord_code_error_code)).toBe(true);
            }
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  // Ownership (PR-5 test list item 9, pinned at the repository level): a second user's
  // acceptance for the SAME team's invite must never surface as "the caller's own" pending
  // join. MUST FAIL against current code — the method does not exist, so this cannot even
  // scope by user yet.
  it.effect("never returns another user's acceptance for the same team", () =>
    Effect.Do.pipe(
      Effect.bind('owner', () => createUser('700000000000000022', 'joiner-twentytwo')),
      Effect.bind('other', () => createUser('700000000000000023', 'joiner-twentythree')),
      Effect.bind('team', ({ owner }) =>
        createTeam('600000000000000022' as Discord.Snowflake, owner.id),
      ),
      Effect.bind('invite', ({ owner, team }) =>
        createInvite(team.id, owner.id, 'PR5-OWNERSHIP-CODE'),
      ),
      Effect.bind('ownerAcceptance', ({ owner, invite }) => createAcceptance(invite.id, owner.id)),
      Effect.bind('openForOther', ({ other, team }) => findOpenByUserAndTeam(other.id, team.id)),
      Effect.bind('openForOwner', ({ owner, team }) => findOpenByUserAndTeam(owner.id, team.id)),
      Effect.tap(({ openForOther, openForOwner, ownerAcceptance }) =>
        Effect.sync(() => {
          expect(Option.isNone(openForOther)).toBe(true);
          expect(Option.isSome(openForOwner)).toBe(true);
          if (Option.isSome(openForOwner)) {
            expect(openForOwner.value.id).toBe(ownerAcceptance.id);
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // Team-scoping analogue of PR-4's "four squads" regression: the same user has an open
  // acceptance on a DIFFERENT team and must not see it when asking about THIS team.
  it.effect('does not return an acceptance scoped to a different team', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('700000000000000024', 'joiner-twentyfour')),
      Effect.bind('teamA', ({ user }) =>
        createTeam('600000000000000024' as Discord.Snowflake, user.id),
      ),
      Effect.bind('teamB', ({ user }) =>
        createTeam('600000000000000025' as Discord.Snowflake, user.id),
      ),
      Effect.bind('inviteA', ({ user, teamA }) =>
        createInvite(teamA.id, user.id, 'PR5-TEAM-A-CODE'),
      ),
      Effect.bind('inviteB', ({ user, teamB }) =>
        createInvite(teamB.id, user.id, 'PR5-TEAM-B-CODE'),
      ),
      Effect.tap(({ user, inviteA }) => createAcceptance(inviteA.id, user.id)),
      Effect.bind('openForTeamB', ({ user, teamB }) => findOpenByUserAndTeam(user.id, teamB.id)),
      Effect.tap(({ openForTeamB }) =>
        Effect.sync(() => {
          expect(Option.isNone(openForTeamB)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('does not reuse a row whose discord_code was generated more than 24h ago', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('700000000000000026', 'joiner-twentysix')),
      Effect.bind('team', ({ user }) =>
        createTeam('600000000000000026' as Discord.Snowflake, user.id),
      ),
      Effect.bind('invite', ({ user, team }) =>
        createInvite(team.id, user.id, 'PR5-STALE-CODE-BY-TEAM'),
      ),
      Effect.bind('acceptance', ({ user, invite }) => createAcceptance(invite.id, user.id)),
      Effect.tap(({ acceptance }) =>
        InviteAcceptancesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.setDiscordCode({ acceptanceId: acceptance.id, discordCode: 'stale-by-team' }),
          ),
        ),
      ),
      Effect.tap(({ acceptance }) => backdateGeneratedAt(acceptance.id)),
      Effect.bind('open', ({ user, team }) => findOpenByUserAndTeam(user.id, team.id)),
      Effect.tap(({ open }) =>
        Effect.sync(() => {
          expect(Option.isNone(open)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
