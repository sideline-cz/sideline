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
import type { Discord, Team, TeamInvite, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
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

  // NOTE: this test is inverted in PR-3, once `t.welcome_channel_id IS NOT
  // NULL` and the `bot_guilds` join are removed from findPending. At that
  // point a team with no welcome_channel_id should also be returned (a null
  // welcome channel becomes a failure path elsewhere, not a silent filter).
  it.effect('still excludes a team with no welcome_channel_id', () =>
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
      Effect.bind('pending', () => findPending(10)),
      Effect.tap(({ pending }) =>
        Effect.sync(() => {
          expect(pending.length).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // NOTE: this test is inverted in PR-3, once the `bot_guilds` join is
  // removed from findPending. At that point an acceptance whose team's guild
  // has no bot_guilds row should also be returned.
  it.effect("still excludes an acceptance whose team's guild has no bot_guilds row", () =>
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
