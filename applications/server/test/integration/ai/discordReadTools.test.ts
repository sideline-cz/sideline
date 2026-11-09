// `list_discord_channels` / `list_discord_roles` on real Postgres. The unit tests in
// `test/services/aiTools.test.ts` use mock repositories; this file proves the two parts mocks
// cannot: the `ai:manage_discord` gate reads `membership.permissions` that real SQL builds from
// the seeded built-in roles, and every row is scoped to the caller's team (team B is seeded the
// same way and must never show).
//
// Fixture helpers mirror `repositories/archivedRoleGrantsNothing.test.ts`.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, TeamMember, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { AchievementRoleMappingsRepository } from '~/repositories/AchievementRoleMappingsRepository.js';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordRolesRepository } from '~/repositories/DiscordRolesRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { listDiscordChannels, listDiscordRoles } from '~/services/ai/readTools.js';
import type { EntityReadContext } from '~/services/ai/toolTypes.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamsRepository.Default,
  TeamMembersRepository.Default,
  RolesRepository.Default,
  UsersRepository.Default,
  BotGuildsRepository.Default,
  DiscordChannelsRepository.Default,
  DiscordRolesRepository.Default,
  DiscordChannelMappingRepository.Default,
  GroupsRepository.Default,
  AchievementRoleMappingsRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const sf = (s: string) => s as Discord.Snowflake;

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: sf(discordId),
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
        name: 'Discord Read Tools Team',
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
        onboarding_locale: 'en',
        onboarding_synced_at: Option.none(),
        onboarding_sync_status: 'pending',
        onboarding_sync_error: Option.none(),
      }),
    ),
  );

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
    Effect.map((tm) => tm.id),
  );

const membershipOf = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findMembershipByIds(teamId, userId)),
    Effect.map(Option.getOrThrow),
  );

/**
 * One team with its Discord guild synced: category `<label>-cat`, text channels
 * `<label>-general` (in the category, mapped to a group + role) and `<label>-old` (an archived
 * Sideline channel), roles `<label>-U20` (linked to the group), `<label>-Mod` and
 * `<label>-Champ` (an achievement role).
 * `digit` keeps the Discord ids of the two teams apart (`teams.guild_id` is UNIQUE).
 */
const seedDiscordTeam = (digit: string, label: string) =>
  Effect.gen(function* () {
    const id = (n: string) => sf(`9${digit}000000000000${n}`);
    const guildId = id('0000');
    const ownerId = yield* createUser(id('0001'), `${label}-owner`);
    const team = yield* createTeam(guildId, ownerId);
    yield* RolesRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.seedTeamRolesWithPermissions(team.id)),
    );

    yield* BotGuildsRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.upsert(guildId, `${label} guild`)),
    );
    yield* DiscordChannelsRepository.asEffect().pipe(
      Effect.andThen((repo) =>
        repo.syncChannels(guildId, [
          { channel_id: id('0100'), name: `${label}-cat`, type: 4, parent_id: Option.none() },
          {
            channel_id: id('0101'),
            name: `${label}-general`,
            type: 0,
            parent_id: Option.some(id('0100')),
          },
          { channel_id: id('0102'), name: `${label}-old`, type: 0, parent_id: Option.none() },
        ]),
      ),
    );
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO team_channels (team_id, name, discord_channel_id, archived)
      VALUES (${team.id}, ${`${label}-old`}, ${id('0102')}, true)
    `;

    yield* DiscordRolesRepository.asEffect().pipe(
      Effect.andThen((repo) =>
        repo.syncForGuild(guildId, [
          { role_id: id('0200'), name: `${label}-U20`, color: 0, position: 2, managed: false },
          { role_id: id('0201'), name: `${label}-Mod`, color: 0, position: 1, managed: false },
          { role_id: id('0202'), name: `${label}-Champ`, color: 0, position: 0, managed: false },
        ]),
      ),
    );
    const group = yield* GroupsRepository.asEffect().pipe(
      Effect.andThen((repo) =>
        repo.insertGroup(team.id, `${label} juniors`, Option.none(), Option.none(), Option.none()),
      ),
    );
    yield* DiscordChannelMappingRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.insert(team.id, group.id, id('0101'), id('0200'))),
    );
    yield* AchievementRoleMappingsRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.upsert(team.id, 'first_activity', id('0202'))),
    );

    return { team, guildId, id };
  });

/** A new member of `teamId` holding only the built-in role `roleName`; returns the tool ctx. */
const memberWithBuiltInRole = (
  teamId: Team.TeamId,
  discordId: Discord.Snowflake,
  roleName: 'Player' | 'Captain' | 'Admin',
) =>
  Effect.gen(function* () {
    const userId = yield* createUser(discordId, `${roleName.toLowerCase()}-${discordId}`);
    const memberId: TeamMember.TeamMemberId = yield* addTeamMember(teamId, userId);
    const roles = yield* RolesRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.findRolesByTeamId(teamId)),
    );
    const role = roles.find((r) => r.name === roleName);
    if (!role) return yield* Effect.die(new Error(`built-in role ${roleName} not seeded`));
    yield* TeamMembersRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.assignRole(memberId, role.id)),
    );
    const membership = yield* membershipOf(teamId, userId);
    const ctx: EntityReadContext = {
      teamId,
      membership,
      canSeeGroup: () => Effect.succeed(true),
    };
    return ctx;
  });

const namesOf = (result: unknown): ReadonlyArray<string> =>
  (result as { items: ReadonlyArray<{ name: string }> }).items.map((i) => i.name);

const itemsOf = (result: unknown) =>
  (result as { items: ReadonlyArray<Record<string, unknown>> }).items;

describe('Discord read tools on real Postgres', () => {
  it.effect('a Player (real seeded role) is refused by both tools', () =>
    Effect.gen(function* () {
      const a = yield* seedDiscordTeam('1', 'A');
      const ctx = yield* memberWithBuiltInRole(a.team.id, a.id('0900'), 'Player');

      const forbidden = { error: 'forbidden', permission: 'ai:manage_discord' };
      expect((yield* listDiscordChannels({}, ctx)).result).toEqual(forbidden);
      expect((yield* listDiscordRoles({}, ctx)).result).toEqual(forbidden);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a Captain sees only their own team channels and roles', () =>
    Effect.gen(function* () {
      const a = yield* seedDiscordTeam('1', 'A');
      yield* seedDiscordTeam('2', 'B');
      const ctx = yield* memberWithBuiltInRole(a.team.id, a.id('0901'), 'Captain');

      const channels = yield* listDiscordChannels({}, ctx);
      expect([...namesOf(channels.result)].sort()).toEqual(['A-cat', 'A-general', 'A-old']);
      expect(itemsOf(channels.result).find((i) => i.name === 'A-old')?.archived).toBe(true);
      expect(JSON.stringify(channels.result)).not.toContain('B-');

      const roles = yield* listDiscordRoles({}, ctx);
      const roleItems = itemsOf(roles.result);
      expect(roleItems.find((i) => i.name === 'A-U20')?.linkedTo).toBe('group');
      expect(roleItems.find((i) => i.name === 'A-Mod')?.linkedTo).toBeNull();
      expect(roleItems.find((i) => i.name === 'A-Champ')?.linkedTo).toBe('achievement');
      expect(JSON.stringify(roles.result)).not.toContain('B-');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('an Admin gets the channels (the Admin grant holds the permission)', () =>
    Effect.gen(function* () {
      const a = yield* seedDiscordTeam('1', 'A');
      const ctx = yield* memberWithBuiltInRole(a.team.id, a.id('0902'), 'Admin');

      const channels = yield* listDiscordChannels({}, ctx);
      expect([...namesOf(channels.result)].sort()).toEqual(['A-cat', 'A-general', 'A-old']);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('without a bot_guilds row, a Captain gets discord_not_connected', () =>
    Effect.gen(function* () {
      const a = yield* seedDiscordTeam('1', 'A');
      const ctx = yield* memberWithBuiltInRole(a.team.id, a.id('0903'), 'Captain');
      yield* BotGuildsRepository.asEffect().pipe(Effect.andThen((repo) => repo.remove(a.guildId)));

      expect((yield* listDiscordChannels({}, ctx)).result).toEqual({
        error: 'discord_not_connected',
      });
    }).pipe(Effect.provide(TestLayer)),
  );
});
