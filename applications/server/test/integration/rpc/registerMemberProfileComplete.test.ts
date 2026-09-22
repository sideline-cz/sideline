// TDD mode — Task 4 of `.work-plans/discord-full-onboarding.md`.
//
// `Guild/RegisterMember`'s response is supposed to gain three TOP-LEVEL fields (outside the
// nested `welcome`): `profile_complete`, `profile_gate_enabled`, `verify_locale`. They are
// top-level because `buildWelcomeMeta` returns `welcome: None` for a member who joined through a
// plain, captain-made Discord invite — exactly the cohort this story targets — so hanging
// verification state off the (absent) welcome embed would miss them entirely. Case 4 below is the
// regression guard for exactly that cohort.
//
// `WelcomeMeta`/`buildWelcomeMeta` (`applications/server/src/rpc/guild/index.ts`) do not carry
// these fields yet (Task 4 is unimplemented) — the domain schema (Task 1, already committed)
// decodes their ABSENCE as the "old server" defaults (`profile_complete: true`,
// `profile_gate_enabled: false`, `verify_locale: 'en'`), which is why every case below that
// expects `profile_complete === false` or `profile_gate_enabled === true` is expected to fail
// first: the schema silently supplies the safe-default value instead of the real one.
//
// Pattern: `registerMemberGroupInviteRoleSync.test.ts` right next to this file — same
// `PlainRepositories` / `RealReposLayer` / `RpcTestLayer` shape (`RpcTestLayer` self-contained,
// used only inside `callRegisterMember`; seeding runs against the separate `RealReposLayer`), same
// `createUser` / `createTeam` seed helpers, same `callRegisterMember` RPC-client helper via
// `RpcTest`.

import { it as itEffect } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { GuildRpcGroup } from '@sideline/domain';
import { DateTime, Effect, Exit, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach, describe, expect } from 'vitest';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
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
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { SudoSessionsRepository } from '~/repositories/SudoSessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { GuildsRpcLive } from '~/rpc/guild/index.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

// Every requirement `GuildsRpcLive`'s `toLayer(handlers)` closes over — see the identical comment
// in `registerMemberGroupInviteRoleSync.test.ts`. `TeamInvitesRepository` is dropped here (unlike
// that file): none of these cases seed a `team_invites` row, and it is not one of `Guild/
// RegisterMember`'s own bound dependencies (`Effect.bind('acceptances', ...)` is
// `InviteAcceptancesRepository`, which IS kept).
const PlainRepositories = Layer.mergeAll(
  BotGuildsRepository.Default,
  DiscordChannelsRepository.Default,
  DiscordRolesRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
  DiscordRoleMappingRepository.Default,
  DiscordChannelMappingRepository.Default,
  GroupsRepository.Default,
  InviteAcceptancesRepository.Default,
  PendingGuildJoinsRepository.Default,
  TeamSettingsRepository.Default,
  PersonalEventChannelsRepository.Default,
  PersonalEventOverflowCategoriesRepository.Default,
  EventsRepository.Default,
  SudoSessionsRepository.Default,
  RolesRepository.Default,
  RoleSyncEventsRepository.Default,
  RostersRepository.Default,
  ChannelSyncEventsRepository.Default,
);

const RealReposLayer = PlainRepositories.pipe(Layer.provideMerge(TestPgClient));

const RpcTestLayer = GuildsRpcLive.pipe(
  Layer.provide(PlainRepositories),
  Layer.provideMerge(TestPgClient),
);

// Case 6 needs to assert `teamSettings.findByTeamId` is NEVER called on the `source: 'reconcile'`
// path (R9's fan-out saving — `Guild/ReconcileMembers` calls `registerMemberWithReconcile` for
// every member of a guild at `concurrency: 5` and throws the `welcomeMeta` result away, so the
// lookup would be pure waste on the largest fan-out in the server). A real Postgres integration
// test cannot assert "never called" without a spy — this wraps the REAL repository (every other
// method still runs real SQL) and only instruments the one method under test. Used ONLY inside
// `RpcTestLayerSpiedTeamSettings`, never for seeding, so it does not affect any other case.
let findByTeamIdCalls: Team.TeamId[] = [];
const SpyTeamSettingsRepositoryLayer = Layer.effect(
  TeamSettingsRepository,
  TeamSettingsRepository.asEffect().pipe(
    Effect.map((real) => ({
      ...real,
      findByTeamId: (teamId: Team.TeamId) => {
        findByTeamIdCalls.push(teamId);
        return real.findByTeamId(teamId);
      },
    })),
  ),
).pipe(Layer.provide(TeamSettingsRepository.Default));

const PlainRepositoriesWithSpiedTeamSettings = Layer.mergeAll(
  BotGuildsRepository.Default,
  DiscordChannelsRepository.Default,
  DiscordRolesRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
  DiscordRoleMappingRepository.Default,
  DiscordChannelMappingRepository.Default,
  GroupsRepository.Default,
  InviteAcceptancesRepository.Default,
  PendingGuildJoinsRepository.Default,
  SpyTeamSettingsRepositoryLayer,
  PersonalEventChannelsRepository.Default,
  PersonalEventOverflowCategoriesRepository.Default,
  EventsRepository.Default,
  SudoSessionsRepository.Default,
  RolesRepository.Default,
  RoleSyncEventsRepository.Default,
  RostersRepository.Default,
  ChannelSyncEventsRepository.Default,
);

const RpcTestLayerSpiedTeamSettings = GuildsRpcLive.pipe(
  Layer.provide(PlainRepositoriesWithSpiedTeamSettings),
  Layer.provideMerge(TestPgClient),
);

beforeEach(() => {
  findByTeamIdCalls = [];
  return cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise);
});

// ---------------------------------------------------------------------------
// Seed helpers — run against `RealReposLayer`.
// ---------------------------------------------------------------------------

const createUser = (discordId: Discord.Snowflake, username: string) =>
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

const completeUserProfile = (userId: User.UserId) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.completeProfile({
        id: userId,
        name: Option.some('Test Player'),
        birth_date: Option.some(DateTime.makeUnsafe('2000-01-01')),
        gender: Option.some('male'),
      }),
    ),
  );

const createTeam = (
  guildId: Discord.Snowflake,
  createdBy: User.UserId,
  onboardingLocale: 'en' | 'cs' = 'en',
) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'RegisterMember Profile Complete Test Team',
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
        achievement_channel_id: Option.none(),
        onboarding_rules_role_id: Option.none(),
        onboarding_rules_prompt_id: Option.none(),
        onboarding_locale: onboardingLocale,
        onboarding_synced_at: Option.none(),
        onboarding_sync_status: 'pending',
        onboarding_sync_error: Option.none(),
      }),
    ),
  );

// `TeamSettingsRepository.upsert` does not accept `requireCompleteProfile` yet (Task 3 is
// unimplemented) — set the column directly, exactly like the real captain-facing toggle will once
// Task 3 lands. `upsert` first, so the row exists to update.
const setRequireCompleteProfile = (teamId: Team.TeamId, value: boolean) =>
  Effect.Do.pipe(
    Effect.tap(() =>
      TeamSettingsRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.upsert({ teamId, eventHorizonDays: 30, minPlayersThreshold: 5 }),
        ),
      ),
    ),
    Effect.tap(() =>
      SqlClient.SqlClient.asEffect().pipe(
        Effect.flatMap(
          (sql) =>
            sql`UPDATE team_settings SET require_complete_profile = ${value} WHERE team_id = ${teamId}`,
        ),
      ),
    ),
  );

const addActiveMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
  );

// ---------------------------------------------------------------------------
// RPC call helper — each variant is self-contained (provides its own layer), matching
// `registerMemberGroupInviteRoleSync.test.ts`'s `callRegisterMember`.
// ---------------------------------------------------------------------------

type RegisterMemberSuccess = {
  readonly welcome: Option.Option<unknown>;
  readonly profile_complete: boolean;
  readonly profile_gate_enabled: boolean;
  readonly verify_locale: 'en' | 'cs';
};

type RegisterMemberPayload = {
  guild_id: Discord.Snowflake;
  discord_id: string;
  username: string;
  avatar: Option.Option<string>;
  roles: ReadonlyArray<string>;
  nickname: Option.Option<string>;
  display_name: Option.Option<string>;
  invite_code: Option.Option<string>;
  source: Option.Option<'member_add' | 'reconcile'>;
};

const makeCallRegisterMember =
  (layer: Layer.Layer<never, never, never>) => (payload: RegisterMemberPayload) =>
    Effect.scoped(
      (RpcTest.makeClient(GuildRpcGroup.GuildRpcGroup) as Effect.Effect<any, never, any>).pipe(
        Effect.flatMap(
          (rpc: any) =>
            rpc['Guild/RegisterMember'](payload) as Effect.Effect<
              Option.Option<RegisterMemberSuccess>,
              unknown,
              never
            >,
        ),
        Effect.exit,
      ),
    ).pipe(Effect.provide(layer));

const callRegisterMember = makeCallRegisterMember(RpcTestLayer as never);
const callRegisterMemberSpied = makeCallRegisterMember(RpcTestLayerSpiedTeamSettings as never);

const memberAddPayload = (params: {
  guildId: Discord.Snowflake;
  discordId: string;
  username: string;
  source?: 'member_add' | 'reconcile';
}): RegisterMemberPayload => ({
  guild_id: params.guildId,
  discord_id: params.discordId,
  username: params.username,
  avatar: Option.none<string>(),
  roles: [],
  nickname: Option.none<string>(),
  display_name: Option.none<string>(),
  invite_code: Option.none<string>(),
  source: Option.some(params.source ?? 'member_add'),
});

const unwrapSuccess = (outcome: Exit.Exit<Option.Option<RegisterMemberSuccess>, unknown>) => {
  expect(Exit.isSuccess(outcome)).toBe(true);
  if (!Exit.isSuccess(outcome)) throw new Error('RegisterMember failed');
  expect(Option.isSome(outcome.value)).toBe(true);
  if (!Option.isSome(outcome.value)) throw new Error('RegisterMember returned no outcome');
  return outcome.value.value;
};

describe('Guild/RegisterMember — profile-gate fields on the response (Task 4)', () => {
  itEffect.effect('1. incomplete profile, setting on', () =>
    Effect.Do.pipe(
      Effect.bind('admin', () => createUser('900400000000000001' as Discord.Snowflake, 'admin-1')),
      Effect.bind('team', ({ admin }) =>
        createTeam('910400000000000001' as Discord.Snowflake, admin.id),
      ),
      Effect.tap(({ team }) => setRequireCompleteProfile(team.id, true)),
      Effect.bind('outcome', ({ team }) =>
        callRegisterMember(
          memberAddPayload({
            guildId: team.guild_id,
            discordId: '920400000000000001',
            username: 'joiner-1',
          }),
        ),
      ),
      Effect.tap(({ outcome, team }) =>
        Effect.sync(() => {
          const success = unwrapSuccess(outcome);
          expect(success.profile_complete).toBe(false);
          expect(success.profile_gate_enabled).toBe(true);
          expect(success.verify_locale).toBe(team.onboarding_locale);
        }),
      ),
      Effect.provide(RealReposLayer),
    ),
  );

  itEffect.effect('2. incomplete profile, setting OFF', () =>
    Effect.Do.pipe(
      Effect.bind('admin', () => createUser('900400000000000002' as Discord.Snowflake, 'admin-2')),
      Effect.bind('team', ({ admin }) =>
        createTeam('910400000000000002' as Discord.Snowflake, admin.id),
      ),
      Effect.tap(({ team }) => setRequireCompleteProfile(team.id, false)),
      Effect.bind('outcome', ({ team }) =>
        callRegisterMember(
          memberAddPayload({
            guildId: team.guild_id,
            discordId: '920400000000000002',
            username: 'joiner-2',
          }),
        ),
      ),
      Effect.tap(({ outcome }) =>
        Effect.sync(() => {
          const success = unwrapSuccess(outcome);
          expect(success.profile_gate_enabled).toBe(false);
        }),
      ),
      Effect.provide(RealReposLayer),
    ),
  );

  itEffect.effect('3. complete profile, setting on', () =>
    Effect.Do.pipe(
      Effect.bind('admin', () => createUser('900400000000000003' as Discord.Snowflake, 'admin-3')),
      Effect.bind('team', ({ admin }) =>
        createTeam('910400000000000003' as Discord.Snowflake, admin.id),
      ),
      Effect.tap(({ team }) => setRequireCompleteProfile(team.id, true)),
      Effect.bind('joiner', () =>
        createUser('920400000000000003' as Discord.Snowflake, 'joiner-3'),
      ),
      Effect.tap(({ joiner }) => completeUserProfile(joiner.id)),
      Effect.bind('outcome', ({ team }) =>
        callRegisterMember(
          memberAddPayload({
            guildId: team.guild_id,
            discordId: '920400000000000003',
            username: 'joiner-3',
          }),
        ),
      ),
      Effect.tap(({ outcome }) =>
        Effect.sync(() => {
          const success = unwrapSuccess(outcome);
          expect(success.profile_complete).toBe(true);
        }),
      ),
      Effect.provide(RealReposLayer),
    ),
  );

  itEffect.effect(
    '4. no invite context (plain Discord invite) — welcome is None AND the profile-gate fields ' +
      'still populate. This is the regression guard for the whole story: the target cohort gets ' +
      'no welcome embed but must still get the fields.',
    () =>
      Effect.Do.pipe(
        Effect.bind('admin', () =>
          createUser('900400000000000004' as Discord.Snowflake, 'admin-4'),
        ),
        Effect.bind('team', ({ admin }) =>
          createTeam('910400000000000004' as Discord.Snowflake, admin.id),
        ),
        Effect.tap(({ team }) => setRequireCompleteProfile(team.id, true)),
        Effect.bind('outcome', ({ team }) =>
          // No invite_code on the payload and no `invite_acceptances` row seeded — this IS the
          // plain-invite cohort: `resolveInviteContext` resolves to `None`.
          callRegisterMember(
            memberAddPayload({
              guildId: team.guild_id,
              discordId: '920400000000000004',
              username: 'joiner-4',
            }),
          ),
        ),
        Effect.tap(({ outcome }) =>
          Effect.sync(() => {
            const success = unwrapSuccess(outcome);
            expect(Option.isNone(success.welcome)).toBe(true);
            expect(success.profile_complete).toBe(false);
            expect(success.profile_gate_enabled).toBe(true);
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );

  itEffect.effect(
    "5. existing active member re-observed — the fields still populate on the 'already active' branch",
    () =>
      Effect.Do.pipe(
        Effect.bind('admin', () =>
          createUser('900400000000000005' as Discord.Snowflake, 'admin-5'),
        ),
        Effect.bind('team', ({ admin }) =>
          createTeam('910400000000000005' as Discord.Snowflake, admin.id),
        ),
        Effect.tap(({ team }) => setRequireCompleteProfile(team.id, true)),
        Effect.bind('joiner', () =>
          createUser('920400000000000005' as Discord.Snowflake, 'joiner-5'),
        ),
        Effect.tap(({ team, joiner }) => addActiveMember(team.id, joiner.id)),
        Effect.bind('outcome', ({ team }) =>
          callRegisterMember(
            memberAddPayload({
              guildId: team.guild_id,
              discordId: '920400000000000005',
              username: 'joiner-5',
            }),
          ),
        ),
        Effect.tap(({ outcome }) =>
          Effect.sync(() => {
            const success = unwrapSuccess(outcome);
            expect(success.profile_complete).toBe(false);
            expect(success.profile_gate_enabled).toBe(true);
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );

  itEffect.effect(
    "6. source: 'reconcile' — profile_gate_enabled is false BY CONSTRUCTION, and " +
      "`teamSettings.findByTeamId` is never called (R9's fan-out saving)",
    () =>
      Effect.Do.pipe(
        Effect.bind('admin', () =>
          createUser('900400000000000006' as Discord.Snowflake, 'admin-6'),
        ),
        Effect.bind('team', ({ admin }) =>
          createTeam('910400000000000006' as Discord.Snowflake, admin.id),
        ),
        Effect.tap(({ team }) => setRequireCompleteProfile(team.id, true)),
        Effect.bind('outcome', ({ team }) =>
          callRegisterMemberSpied(
            memberAddPayload({
              guildId: team.guild_id,
              discordId: '920400000000000006',
              username: 'joiner-6',
              source: 'reconcile',
            }),
          ),
        ),
        Effect.tap(({ outcome }) =>
          Effect.sync(() => {
            const success = unwrapSuccess(outcome);
            expect(success.profile_gate_enabled).toBe(false);
            expect(findByTeamIdCalls).toEqual([]);
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );

  itEffect.effect("7. cs team — verify_locale reflects the team's onboarding_locale", () =>
    Effect.Do.pipe(
      Effect.bind('admin', () => createUser('900400000000000007' as Discord.Snowflake, 'admin-7')),
      Effect.bind('team', ({ admin }) =>
        createTeam('910400000000000007' as Discord.Snowflake, admin.id, 'cs'),
      ),
      Effect.tap(({ team }) => setRequireCompleteProfile(team.id, true)),
      Effect.bind('outcome', ({ team }) =>
        callRegisterMember(
          memberAddPayload({
            guildId: team.guild_id,
            discordId: '920400000000000007',
            username: 'joiner-7',
          }),
        ),
      ),
      Effect.tap(({ outcome }) =>
        Effect.sync(() => {
          const success = unwrapSuccess(outcome);
          expect(success.verify_locale).toBe('cs');
        }),
      ),
      Effect.provide(RealReposLayer),
    ),
  );
});
