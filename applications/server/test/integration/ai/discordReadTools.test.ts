// `list_discord_channels` / `list_discord_roles` on real Postgres. The unit tests in
// `test/services/aiTools.test.ts` use mock repositories; this file proves the two parts mocks
// cannot: the `ai:manage_discord` gate reads `membership.permissions` that real SQL builds from
// the seeded built-in roles, and every row is scoped to the caller's team (team B is seeded the
// same way and must never show).
//
// Fixture helpers mirror `repositories/archivedRoleGrantsNothing.test.ts`.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, DiscordReadRequest, Team, TeamMember, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { AchievementRoleMappingsRepository } from '~/repositories/AchievementRoleMappingsRepository.js';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { CustomAchievementsRepository } from '~/repositories/CustomAchievementsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordReadRequestsRepository } from '~/repositories/DiscordReadRequestsRepository.js';
import { DiscordRolesRepository } from '~/repositories/DiscordRolesRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { TeamChannelAccessRepository } from '~/repositories/TeamChannelAccessRepository.js';
import { TeamChannelsRepository } from '~/repositories/TeamChannelsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import {
  listDiscordChannels,
  listDiscordRoles,
  readDiscordMessages,
} from '~/services/ai/readTools.js';
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
  RostersRepository.Default,
  AchievementRoleMappingsRepository.Default,
  CustomAchievementsRepository.Default,
  TeamChannelsRepository.Default,
  TeamChannelAccessRepository.Default,
  DiscordReadRequestsRepository.Default,
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
          { role_id: id('0203'), name: `${label}-Custom`, color: 0, position: 0, managed: false },
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
    yield* CustomAchievementsRepository.asEffect().pipe(
      Effect.andThen((repo) =>
        repo.insert({
          team_id: team.id,
          name: `${label} hustler`,
          description: '',
          emoji: Option.none(),
          rule_kind: 'total_activities',
          threshold: 10,
          activity_type_slug: Option.none(),
          discord_role_id: Option.some(id('0203')),
        }),
      ),
      Effect.orDie,
    );

    return { team, guildId, id, group };
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
      expect(roleItems.find((i) => i.name === 'A-U20')?.linkedTo).toEqual(['group']);
      expect(roleItems.find((i) => i.name === 'A-Mod')?.linkedTo).toEqual([]);
      expect(roleItems.find((i) => i.name === 'A-Champ')?.linkedTo).toEqual(['achievement']);
      expect(roleItems.find((i) => i.name === 'A-Custom')?.linkedTo).toEqual(['achievement']);
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

// ---------------------------------------------------------------------------
// read_discord_messages — team scope and the caller-access walk on real SQL. The refused cases
// stop before any insert, so they run against the real reads repository. The allowed case keeps
// the real `insert` but answers `consume` at once, so the test does not wait 15 s for a bot.
// ---------------------------------------------------------------------------

const OK_READ: DiscordReadRequest.DiscordReadResult = {
  outcome: 'ok',
  messages: [],
  capped: false,
};

const readRowCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ n: number }>`SELECT count(*)::int AS n FROM discord_read_requests`;
  return rows[0]?.n ?? 0;
});

const readAs = (ctx: EntityReadContext, channel: string) =>
  Effect.gen(function* () {
    const real = yield* DiscordReadRequestsRepository.asEffect();
    const outcome = yield* readDiscordMessages(
      { channel },
      { ...ctx, teamTimezone: 'Europe/Prague' },
    ).pipe(
      Effect.provideService(DiscordReadRequestsRepository, {
        ...real,
        consume: () => Effect.succeed(Option.some(OK_READ)),
      } as never),
    );
    return outcome.result as Record<string, unknown>;
  });

/** Team A with groups `Club` -> `U12` and the managed channel `u12-chat` (on `A-general`). */
const seedAccessTree = Effect.gen(function* () {
  const a = yield* seedDiscordTeam('1', 'A');
  const groups = yield* GroupsRepository.asEffect();
  const club = yield* groups.insertGroup(
    a.team.id,
    'Club',
    Option.none(),
    Option.none(),
    Option.none(),
  );
  const u12 = yield* groups.insertGroup(
    a.team.id,
    'U12',
    Option.some(club.id),
    Option.none(),
    Option.none(),
  );
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ id: string }>`
    INSERT INTO team_channels (team_id, name, discord_channel_id)
    VALUES (${a.team.id}, 'u12-chat', ${a.id('0101')})
    RETURNING id
  `;
  const teamChannelId = rows[0]?.id as never;
  const grant = (groupId: typeof club.id) =>
    TeamChannelAccessRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.upsertGrant(teamChannelId, groupId, 'VIEW')),
    );
  const captainIn = (groupId: typeof club.id, discordId: string) =>
    Effect.gen(function* () {
      const ctx = yield* memberWithBuiltInRole(a.team.id, a.id(discordId), 'Captain');
      yield* groups.addMemberById(groupId, ctx.membership.id);
      return ctx;
    });
  return { a, club, u12, grant, captainIn };
});

describe('read_discord_messages on real Postgres', () => {
  it.effect('a channel of another team is not found, and nothing is inserted', () =>
    Effect.gen(function* () {
      const a = yield* seedDiscordTeam('1', 'A');
      yield* seedDiscordTeam('2', 'B');
      const ctx = yield* memberWithBuiltInRole(a.team.id, a.id('0904'), 'Captain');

      expect(yield* readAs(ctx, 'B-general')).toEqual({ error: 'channel_not_found' });
      expect(yield* readRowCount).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a member of a child group reads a channel granted to the parent', () =>
    Effect.gen(function* () {
      const t = yield* seedAccessTree;
      yield* t.grant(t.club.id);
      const ctx = yield* t.captainIn(t.u12.id, '0905');

      yield* readAs(ctx, 'u12-chat');
      expect(yield* readRowCount).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a member of the parent only is refused a channel granted to the child', () =>
    Effect.gen(function* () {
      const t = yield* seedAccessTree;
      yield* t.grant(t.u12.id);
      const ctx = yield* t.captainIn(t.club.id, '0906');

      expect(yield* readAs(ctx, 'u12-chat')).toEqual({ error: 'no_channel_access' });
      expect(yield* readRowCount).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a grant to an archived group gives no access', () =>
    Effect.gen(function* () {
      const t = yield* seedAccessTree;
      yield* t.grant(t.u12.id);
      const ctx = yield* t.captainIn(t.u12.id, '0907');
      yield* GroupsRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.archiveGroupById(t.u12.id)),
      );

      expect(yield* readAs(ctx, 'u12-chat')).toEqual({ error: 'no_channel_access' });
      expect(yield* readRowCount).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  // `A-general` has no `team_channels` row: Sideline created it for group `A juniors`
  // (`discord_channel_mappings` with a role). The bot gives that role to the group's members.
  it.effect('a group channel Sideline created: a group member reads it, others are refused', () =>
    Effect.gen(function* () {
      const a = yield* seedDiscordTeam('1', 'A');
      const member = yield* memberWithBuiltInRole(a.team.id, a.id('0908'), 'Captain');
      yield* GroupsRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.addMemberById(a.group.id, member.membership.id)),
      );
      const outsider = yield* memberWithBuiltInRole(a.team.id, a.id('0909'), 'Admin');

      expect(yield* readAs(outsider, 'A-general')).toEqual({ error: 'no_channel_access' });
      expect(yield* readRowCount).toBe(0);
      yield* readAs(member, 'A-general');
      expect(yield* readRowCount).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a roster channel Sideline created: a roster member reads it, others are refused', () =>
    Effect.gen(function* () {
      const a = yield* seedDiscordTeam('1', 'A');
      yield* DiscordChannelsRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.upsertChannel(a.guildId, a.id('0103'), 'A-first-team', 0, Option.none()),
        ),
      );
      const rosters = yield* RostersRepository.asEffect();
      const roster = yield* rosters.insert({
        team_id: a.team.id,
        name: 'First team',
        active: true,
        color: Option.none(),
        emoji: Option.none(),
      });
      yield* DiscordChannelMappingRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.insertRoster(a.team.id, roster.id, a.id('0103'), a.id('0201')),
        ),
      );
      const member = yield* memberWithBuiltInRole(a.team.id, a.id('0910'), 'Captain');
      yield* rosters.addMemberById(roster.id, member.membership.id);
      const outsider = yield* memberWithBuiltInRole(a.team.id, a.id('0911'), 'Captain');

      expect(yield* readAs(outsider, 'A-first-team')).toEqual({ error: 'no_channel_access' });
      expect(yield* readRowCount).toBe(0);
      yield* readAs(member, 'A-first-team');
      expect(yield* readRowCount).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );
});
