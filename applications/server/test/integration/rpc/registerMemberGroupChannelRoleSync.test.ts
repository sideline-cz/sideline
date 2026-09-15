// TDD mode — bug fix-group-channel-discord-join ("group channel role never granted on a late
// Discord join").
//
// Today `applyInviteGroup` only reaches Discord when `resolveInviteContext` resolves an invite
// (a code on the payload, or a same-guild acceptance inside the 15-minute recency window,
// `InviteAcceptancesRepository.ts:343`). A member who joined Discord manually, or past that
// window, or whose `group_members` row was written some other way (the web UI's "add to group"
// button, `api/group.ts`'s `addGroupMember`) never gets a `channel_sync_events` `member_added`
// row for the group's own Discord role — the bot never grants it, and the only remedy today is a
// captain manually clicking "Sync role members" per group.
//
// This file wires the real `GuildsRpcLive` against a real Postgres (testcontainers), mirroring
// `registerMemberGroupInviteRoleSync.test.ts`. It is expected to FAIL until the developer
// implements PR 1: `GroupsRepository.findActiveGroupsWithAncestorsForMember`,
// `utils/emitMemberGroupChannelRoles.ts`, and its wiring into `observeGuildMembership` gated on
// `payload.source === Some('member_add')`.

import { it as itEffect } from '@effect/vitest';
import type {
  Discord,
  GroupModel,
  InviteAcceptance,
  Team,
  TeamInvite,
  TeamMember,
  User,
} from '@sideline/domain';
import { GuildRpcGroup } from '@sideline/domain';
import { Effect, Exit, Layer, Option } from 'effect';
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
import { TeamInvitesRepository } from '~/repositories/TeamInvitesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { GuildsRpcLive } from '~/rpc/guild/index.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

// See `registerMemberGroupInviteRoleSync.test.ts` for why every requirement of `GuildsRpcLive`
// (not just the ones this file exercises directly) must be satisfiable.
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
  TeamInvitesRepository.Default,
);

const RealReposLayer = PlainRepositories.pipe(Layer.provideMerge(TestPgClient));

const RpcTestLayer = GuildsRpcLive.pipe(
  Layer.provide(PlainRepositories),
  Layer.provideMerge(TestPgClient),
);

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Seed helpers — through the real repositories.
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

// `teams.guild_id` is `NOT NULL` at the schema level (`1741200000_guild_linking.ts`) — a team can
// never exist with no guild at all. "Unlinked guild" (I7) therefore means dispatching
// `Guild/RegisterMember` for a `guild_id` that resolves to NO team row (`findByGuildId` misses),
// not a team whose `guild_id` column is null. Every OTHER test in this file still must be
// careful to dispatch against the SAME `guild_id` the team was created with — a mismatch there
// would make its "zero rows" assertions pass for the same wrong reason I7 exists to rule out.
const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
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

const addActiveMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
  );

const createGroup = (
  teamId: Team.TeamId,
  name: string,
  parentId: Option.Option<GroupModel.GroupId>,
) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertGroup(teamId, name, parentId, Option.none(), Option.none()),
    ),
  );

const archiveGroup = (groupId: GroupModel.GroupId) =>
  GroupsRepository.asEffect().pipe(Effect.andThen((repo) => repo.archiveGroupById(groupId)));

const addGroupMemberDirectly = (
  groupId: GroupModel.GroupId,
  teamMemberId: TeamMember.TeamMemberId,
) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.addMemberById(groupId, teamMemberId)),
  );

const mapGroupChannelRole = (
  teamId: Team.TeamId,
  groupId: GroupModel.GroupId,
  discordChannelId: Discord.Snowflake,
  discordRoleId: Discord.Snowflake,
) =>
  DiscordChannelMappingRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.insert(teamId, groupId, discordChannelId, discordRoleId)),
  );

const clearGroupChannel = (teamId: Team.TeamId, groupId: GroupModel.GroupId) =>
  DiscordChannelMappingRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.clearGroupChannel(teamId, groupId)),
  );

const deleteGroupMapping = (teamId: Team.TeamId, groupId: GroupModel.GroupId) =>
  DiscordChannelMappingRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.deleteByGroupId(teamId, groupId)),
  );

const createInvite = (
  teamId: Team.TeamId,
  createdBy: User.UserId,
  code: string,
  groupId: Option.Option<GroupModel.GroupId>,
) =>
  TeamInvitesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.create({
        team_id: teamId,
        code,
        active: true,
        created_by: createdBy,
        created_at: undefined,
        expires_at: Option.none(),
        group_id: groupId,
      }),
    ),
  );

const createAcceptance = (teamInviteId: TeamInvite.TeamInviteId, userId: User.UserId) =>
  InviteAcceptancesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.create({ team_invite_id: teamInviteId, user_id: userId })),
  );

const setDiscordCode = (acceptanceId: InviteAcceptance.InviteAcceptanceId, discordCode: string) =>
  InviteAcceptancesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.setDiscordCode({ acceptanceId, discordCode })),
  );

// Bypasses the repository (which always writes `created_at = now()`), to put an acceptance
// outside `InviteAcceptancesRepository.ts:343`'s 15-minute recency window — mirrors
// `backdateCreatedAt` in `InviteAcceptancesRepository.test.ts`.
const backdateAcceptance = (acceptanceId: InviteAcceptance.InviteAcceptanceId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        UPDATE invite_acceptances SET created_at = now() - interval '20 minutes'
        WHERE id = ${acceptanceId}
      `,
    ),
  );

const findDiscordJoinedAt = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findDiscordJoinedAt(teamId, userId)),
  );

// ---------------------------------------------------------------------------
// Raw read of `channel_sync_events` — no repository exposes "find all events for a team", only
// "find unprocessed" (which would race the write inside the same test). Mirrors
// `registerMemberGroupInviteRoleSync.test.ts`'s `findChannelSyncMemberAddedForTeam`.
// ---------------------------------------------------------------------------

const findChannelSyncMemberAddedForTeam = (teamId: Team.TeamId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql<{
          group_id: string | null;
          team_member_id: string | null;
          discord_user_id: string | null;
        }>`
          SELECT group_id, team_member_id, discord_user_id
          FROM channel_sync_events
          WHERE team_id = ${teamId} AND event_type = 'member_added'
        `,
    ),
  );

// ---------------------------------------------------------------------------
// RPC call helpers
// ---------------------------------------------------------------------------

const callRegisterMember = (payload: {
  guild_id: Discord.Snowflake;
  discord_id: string;
  username: string;
  avatar: Option.Option<string>;
  roles: ReadonlyArray<string>;
  nickname: Option.Option<string>;
  display_name: Option.Option<string>;
  invite_code: Option.Option<string>;
  source: Option.Option<'member_add' | 'reconcile'>;
}) =>
  Effect.scoped(
    (RpcTest.makeClient(GuildRpcGroup.GuildRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) =>
          rpc['Guild/RegisterMember'](payload) as Effect.Effect<unknown, unknown, never>,
      ),
      Effect.exit,
    ),
  ).pipe(Effect.provide(RpcTestLayer));

const callReconcileMembers = (
  guildId: Discord.Snowflake,
  members: ReadonlyArray<{ discord_id: string; username: string; roles: ReadonlyArray<string> }>,
  complete: boolean,
) =>
  Effect.scoped(
    (RpcTest.makeClient(GuildRpcGroup.GuildRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) =>
          rpc['Guild/ReconcileMembers']({
            guild_id: guildId,
            complete,
            members: members.map((m) => ({
              discord_id: m.discord_id,
              username: m.username,
              avatar: Option.none(),
              roles: m.roles,
              nickname: Option.none(),
              display_name: Option.none(),
            })),
          }) as Effect.Effect<unknown, unknown, never>,
      ),
      Effect.exit,
    ),
  ).pipe(Effect.provide(RpcTestLayer));

const registerPayload = (opts: {
  guildId: Discord.Snowflake;
  discordId: string;
  username: string;
  inviteCode?: Option.Option<string>;
  roles?: ReadonlyArray<string>;
}) => ({
  guild_id: opts.guildId,
  discord_id: opts.discordId,
  username: opts.username,
  avatar: Option.none(),
  roles: opts.roles ?? [],
  nickname: Option.none(),
  display_name: Option.none(),
  invite_code: opts.inviteCode ?? Option.none(),
  source: Option.some<'member_add' | 'reconcile'>('member_add'),
});

describe('Guild/RegisterMember — group channel role sync on Discord join (bug fix-group-channel-discord-join)', () => {
  itEffect.effect(
    'I1: the reported bug — an already-active member whose group_members row was written directly gets member_added on their next Discord join',
    () =>
      Effect.Do.pipe(
        Effect.bind('admin', () =>
          createUser('900100000000000001' as Discord.Snowflake, 'admin-i1'),
        ),
        Effect.bind('team', ({ admin }) =>
          createTeam('910100000000000001' as Discord.Snowflake, admin.id),
        ),
        Effect.bind('joiner', () =>
          createUser('920100000000000001' as Discord.Snowflake, 'joiner-i1'),
        ),
        Effect.bind('member', ({ team, joiner }) => addActiveMember(team.id, joiner.id)),
        Effect.bind('group', ({ team }) => createGroup(team.id, 'Strikers', Option.none())),
        Effect.tap(({ group, member }) => addGroupMemberDirectly(group.id, member.id)),
        Effect.tap(({ team, group }) =>
          mapGroupChannelRole(
            team.id,
            group.id,
            '930100000000000001' as Discord.Snowflake,
            '940100000000000001' as Discord.Snowflake,
          ),
        ),
        Effect.bind('result', ({ team, joiner }) =>
          callRegisterMember(
            registerPayload({
              guildId: team.guild_id,
              discordId: joiner.discord_id,
              username: 'joiner-i1',
            }),
          ),
        ),
        Effect.tap(({ result }) => Effect.sync(() => expect(Exit.isSuccess(result)).toBe(true))),
        Effect.bind('rows', ({ team }) => findChannelSyncMemberAddedForTeam(team.id)),
        Effect.tap(({ rows, group, member, joiner }) =>
          Effect.sync(() => {
            expect(rows).toHaveLength(1);
            expect(rows[0]?.group_id).toBe(group.id);
            expect(rows[0]?.team_member_id).toBe(member.id);
            expect(rows[0]?.discord_user_id).toBe(joiner.discord_id);
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );

  itEffect.effect(
    'I2: a stale (>15-minute) invite acceptance does not block the same emission',
    () =>
      Effect.Do.pipe(
        Effect.bind('admin', () =>
          createUser('900100000000000002' as Discord.Snowflake, 'admin-i2'),
        ),
        Effect.bind('team', ({ admin }) =>
          createTeam('910100000000000002' as Discord.Snowflake, admin.id),
        ),
        Effect.bind('joiner', () =>
          createUser('920100000000000002' as Discord.Snowflake, 'joiner-i2'),
        ),
        Effect.bind('member', ({ team, joiner }) => addActiveMember(team.id, joiner.id)),
        Effect.bind('group', ({ team }) => createGroup(team.id, 'Strikers', Option.none())),
        Effect.tap(({ group, member }) => addGroupMemberDirectly(group.id, member.id)),
        Effect.tap(({ team, group }) =>
          mapGroupChannelRole(
            team.id,
            group.id,
            '930100000000000002' as Discord.Snowflake,
            '940100000000000002' as Discord.Snowflake,
          ),
        ),
        // A stale acceptance for a DIFFERENT (unmapped) invite — proves the CTE-based emission
        // is wholly independent of `resolveInviteContext`'s recency fallback, not merely that a
        // fallback miss doesn't crash.
        Effect.bind('invite', ({ team, admin }) =>
          createInvite(team.id, admin.id, 'CODE-I2', Option.none()),
        ),
        Effect.bind('acceptance', ({ invite, joiner }) => createAcceptance(invite.id, joiner.id)),
        Effect.tap(({ acceptance }) => setDiscordCode(acceptance.id, 'CODE-I2')),
        Effect.tap(({ acceptance }) => backdateAcceptance(acceptance.id)),
        Effect.bind('result', ({ team, joiner }) =>
          callRegisterMember(
            registerPayload({
              guildId: team.guild_id,
              discordId: joiner.discord_id,
              username: 'joiner-i2',
            }),
          ),
        ),
        Effect.tap(({ result }) => Effect.sync(() => expect(Exit.isSuccess(result)).toBe(true))),
        Effect.bind('rows', ({ team }) => findChannelSyncMemberAddedForTeam(team.id)),
        Effect.tap(({ rows, group, member }) =>
          Effect.sync(() => {
            expect(rows).toHaveLength(1);
            expect(rows[0]?.group_id).toBe(group.id);
            expect(rows[0]?.team_member_id).toBe(member.id);
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );

  itEffect.effect(
    'I3a: an archived ancestor severs the walk — only the member’s own group emits',
    () =>
      Effect.Do.pipe(
        Effect.bind('admin', () =>
          createUser('900100000000000003' as Discord.Snowflake, 'admin-i3a'),
        ),
        Effect.bind('team', ({ admin }) =>
          createTeam('910100000000000003' as Discord.Snowflake, admin.id),
        ),
        Effect.bind('joiner', () =>
          createUser('920100000000000003' as Discord.Snowflake, 'joiner-i3a'),
        ),
        Effect.bind('member', ({ team, joiner }) => addActiveMember(team.id, joiner.id)),
        Effect.bind('grandparent', ({ team }) => createGroup(team.id, 'Club', Option.none())),
        Effect.bind('parent', ({ team, grandparent }) =>
          createGroup(team.id, 'Seniors', Option.some(grandparent.id)),
        ),
        Effect.tap(({ parent }) => archiveGroup(parent.id)),
        Effect.bind('group', ({ team, parent }) =>
          createGroup(team.id, 'Strikers', Option.some(parent.id)),
        ),
        Effect.tap(({ group, member }) => addGroupMemberDirectly(group.id, member.id)),
        Effect.tap(({ team, group }) =>
          mapGroupChannelRole(
            team.id,
            group.id,
            '930100000000000003' as Discord.Snowflake,
            '940100000000000003' as Discord.Snowflake,
          ),
        ),
        // Present so a failure to sever would surface as an actual extra row, not merely pass
        // because the ancestor was never mapped at all.
        Effect.tap(({ team, grandparent }) =>
          mapGroupChannelRole(
            team.id,
            grandparent.id,
            '930100000000000013' as Discord.Snowflake,
            '940100000000000013' as Discord.Snowflake,
          ),
        ),
        Effect.bind('result', ({ team, joiner }) =>
          callRegisterMember(
            registerPayload({
              guildId: team.guild_id,
              discordId: joiner.discord_id,
              username: 'joiner-i3a',
            }),
          ),
        ),
        Effect.tap(({ result }) => Effect.sync(() => expect(Exit.isSuccess(result)).toBe(true))),
        Effect.bind('rows', ({ team }) => findChannelSyncMemberAddedForTeam(team.id)),
        Effect.tap(({ rows, group }) =>
          Effect.sync(() => {
            expect(rows).toHaveLength(1);
            expect(rows[0]?.group_id).toBe(group.id);
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );

  itEffect.effect(
    'I3b: two seed groups sharing an active ancestor deduplicate to exactly one row for the ancestor',
    () =>
      Effect.Do.pipe(
        Effect.bind('admin', () =>
          createUser('900100000000000004' as Discord.Snowflake, 'admin-i3b'),
        ),
        Effect.bind('team', ({ admin }) =>
          createTeam('910100000000000004' as Discord.Snowflake, admin.id),
        ),
        Effect.bind('joiner', () =>
          createUser('920100000000000004' as Discord.Snowflake, 'joiner-i3b'),
        ),
        Effect.bind('member', ({ team, joiner }) => addActiveMember(team.id, joiner.id)),
        Effect.bind('parent', ({ team }) => createGroup(team.id, 'Seniors', Option.none())),
        Effect.bind('groupOne', ({ team, parent }) =>
          createGroup(team.id, 'Strikers', Option.some(parent.id)),
        ),
        Effect.bind('groupTwo', ({ team, parent }) =>
          createGroup(team.id, 'Defenders', Option.some(parent.id)),
        ),
        Effect.tap(({ groupOne, member }) => addGroupMemberDirectly(groupOne.id, member.id)),
        Effect.tap(({ groupTwo, member }) => addGroupMemberDirectly(groupTwo.id, member.id)),
        Effect.tap(({ team, groupOne }) =>
          mapGroupChannelRole(
            team.id,
            groupOne.id,
            '930100000000000005' as Discord.Snowflake,
            '940100000000000005' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ team, groupTwo }) =>
          mapGroupChannelRole(
            team.id,
            groupTwo.id,
            '930100000000000015' as Discord.Snowflake,
            '940100000000000015' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ team, parent }) =>
          mapGroupChannelRole(
            team.id,
            parent.id,
            '930100000000000025' as Discord.Snowflake,
            '940100000000000025' as Discord.Snowflake,
          ),
        ),
        Effect.bind('result', ({ team, joiner }) =>
          callRegisterMember(
            registerPayload({
              guildId: team.guild_id,
              discordId: joiner.discord_id,
              username: 'joiner-i3b',
            }),
          ),
        ),
        Effect.tap(({ result }) => Effect.sync(() => expect(Exit.isSuccess(result)).toBe(true))),
        Effect.bind('rows', ({ team }) => findChannelSyncMemberAddedForTeam(team.id)),
        Effect.tap(({ rows, groupOne, groupTwo, parent }) =>
          Effect.sync(() => {
            expect(rows).toHaveLength(3);
            const groupIds = rows.map((r) => r.group_id).sort();
            expect(groupIds).toEqual([groupOne.id, groupTwo.id, parent.id].sort());
            expect(rows.filter((r) => r.group_id === parent.id)).toHaveLength(1);
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );

  itEffect.effect('I4: an archived own group emits zero rows', () =>
    Effect.Do.pipe(
      Effect.bind('admin', () => createUser('900100000000000006' as Discord.Snowflake, 'admin-i4')),
      Effect.bind('team', ({ admin }) =>
        createTeam('910100000000000006' as Discord.Snowflake, admin.id),
      ),
      Effect.bind('joiner', () =>
        createUser('920100000000000006' as Discord.Snowflake, 'joiner-i4'),
      ),
      Effect.bind('member', ({ team, joiner }) => addActiveMember(team.id, joiner.id)),
      Effect.bind('group', ({ team }) => createGroup(team.id, 'Strikers', Option.none())),
      Effect.tap(({ group, member }) => addGroupMemberDirectly(group.id, member.id)),
      Effect.tap(({ team, group }) =>
        mapGroupChannelRole(
          team.id,
          group.id,
          '930100000000000006' as Discord.Snowflake,
          '940100000000000006' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ group }) => archiveGroup(group.id)),
      Effect.bind('result', ({ team, joiner }) =>
        callRegisterMember(
          registerPayload({
            guildId: team.guild_id,
            discordId: joiner.discord_id,
            username: 'joiner-i4',
          }),
        ),
      ),
      Effect.tap(({ result }) => Effect.sync(() => expect(Exit.isSuccess(result)).toBe(true))),
      Effect.bind('rows', ({ team }) => findChannelSyncMemberAddedForTeam(team.id)),
      Effect.tap(({ rows }) => Effect.sync(() => expect(rows).toHaveLength(0))),
      Effect.provide(RealReposLayer),
    ),
  );

  itEffect.effect(
    'I5: steady state — a member already holding the mapped role emits zero rows',
    () =>
      Effect.Do.pipe(
        Effect.bind('admin', () =>
          createUser('900100000000000007' as Discord.Snowflake, 'admin-i5'),
        ),
        Effect.bind('team', ({ admin }) =>
          createTeam('910100000000000007' as Discord.Snowflake, admin.id),
        ),
        Effect.bind('joiner', () =>
          createUser('920100000000000007' as Discord.Snowflake, 'joiner-i5'),
        ),
        Effect.bind('member', ({ team, joiner }) => addActiveMember(team.id, joiner.id)),
        Effect.bind('group', ({ team }) => createGroup(team.id, 'Strikers', Option.none())),
        Effect.tap(({ group, member }) => addGroupMemberDirectly(group.id, member.id)),
        Effect.bind('discordRoleId', () =>
          Effect.succeed('940100000000000007' as Discord.Snowflake),
        ),
        Effect.tap(({ team, group, discordRoleId }) =>
          mapGroupChannelRole(
            team.id,
            group.id,
            '930100000000000007' as Discord.Snowflake,
            discordRoleId,
          ),
        ),
        Effect.bind('result', ({ team, joiner, discordRoleId }) =>
          callRegisterMember(
            registerPayload({
              guildId: team.guild_id,
              discordId: joiner.discord_id,
              username: 'joiner-i5',
              roles: [discordRoleId],
            }),
          ),
        ),
        Effect.tap(({ result }) => Effect.sync(() => expect(Exit.isSuccess(result)).toBe(true))),
        Effect.bind('rows', ({ team }) => findChannelSyncMemberAddedForTeam(team.id)),
        Effect.tap(({ rows }) => Effect.sync(() => expect(rows).toHaveLength(0))),
        Effect.provide(RealReposLayer),
      ),
  );

  itEffect.effect(
    'I6: an in-window invite acceptance AND a pre-existing group_members row for the same group emit exactly one row per (group, member)',
    () =>
      Effect.Do.pipe(
        Effect.bind('admin', () =>
          createUser('900100000000000008' as Discord.Snowflake, 'admin-i6'),
        ),
        Effect.bind('team', ({ admin }) =>
          createTeam('910100000000000008' as Discord.Snowflake, admin.id),
        ),
        Effect.bind('joiner', () =>
          createUser('920100000000000008' as Discord.Snowflake, 'joiner-i6'),
        ),
        Effect.bind('member', ({ team, joiner }) => addActiveMember(team.id, joiner.id)),
        Effect.bind('group', ({ team }) => createGroup(team.id, 'Strikers', Option.none())),
        // Pre-existing membership — written directly, exactly like I1.
        Effect.tap(({ group, member }) => addGroupMemberDirectly(group.id, member.id)),
        Effect.tap(({ team, group }) =>
          mapGroupChannelRole(
            team.id,
            group.id,
            '930100000000000008' as Discord.Snowflake,
            '940100000000000008' as Discord.Snowflake,
          ),
        ),
        // AND an in-window invite for the SAME group, redundantly re-binding it.
        Effect.bind('invite', ({ team, admin, group }) =>
          createInvite(team.id, admin.id, 'CODE-I6', Option.some(group.id)),
        ),
        Effect.bind('acceptance', ({ invite, joiner }) => createAcceptance(invite.id, joiner.id)),
        Effect.tap(({ acceptance }) => setDiscordCode(acceptance.id, 'CODE-I6')),
        Effect.bind('result', ({ team, joiner }) =>
          callRegisterMember(
            registerPayload({
              guildId: team.guild_id,
              discordId: joiner.discord_id,
              username: 'joiner-i6',
              inviteCode: Option.some('CODE-I6'),
            }),
          ),
        ),
        Effect.tap(({ result }) => Effect.sync(() => expect(Exit.isSuccess(result)).toBe(true))),
        Effect.bind('rows', ({ team }) => findChannelSyncMemberAddedForTeam(team.id)),
        Effect.tap(({ rows, group, member }) =>
          Effect.sync(() => {
            const forThisPair = rows.filter(
              (r) => r.group_id === group.id && r.team_member_id === member.id,
            );
            expect(forThisPair).toHaveLength(1);
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );

  itEffect.effect(
    'I7: a guild with no linked team emits zero rows — guards every other assertion in this file against a false pass',
    () =>
      Effect.Do.pipe(
        Effect.bind('admin', () =>
          createUser('900100000000000009' as Discord.Snowflake, 'admin-i7'),
        ),
        Effect.bind('team', ({ admin }) =>
          createTeam('910100000000000009' as Discord.Snowflake, admin.id),
        ),
        Effect.bind('joiner', () =>
          createUser('920100000000000009' as Discord.Snowflake, 'joiner-i7'),
        ),
        Effect.bind('member', ({ team, joiner }) => addActiveMember(team.id, joiner.id)),
        Effect.bind('group', ({ team }) => createGroup(team.id, 'Strikers', Option.none())),
        Effect.tap(({ group, member }) => addGroupMemberDirectly(group.id, member.id)),
        Effect.tap(({ team, group }) =>
          mapGroupChannelRole(
            team.id,
            group.id,
            '930100000000000009' as Discord.Snowflake,
            '940100000000000009' as Discord.Snowflake,
          ),
        ),
        // `teams.guild_id` is `NOT NULL` — there is no way to seed a team with "no guild". The
        // equivalent, real "unlinked" case is dispatching `Guild/RegisterMember` for a
        // `guild_id` NO team was ever created with: `deps.teams.findByGuildId` misses, and
        // `registerMemberWithReconcile` returns `noOutcome` before the user/member/group work
        // above is ever reached by this call — proving the earlier assertions in this file are
        // not passing merely because nothing runs by default.
        Effect.bind('result', ({ joiner }) =>
          callRegisterMember(
            registerPayload({
              guildId: '999900000000000001' as Discord.Snowflake,
              discordId: joiner.discord_id,
              username: 'joiner-i7',
            }),
          ),
        ),
        Effect.tap(({ result }) => Effect.sync(() => expect(Exit.isSuccess(result)).toBe(true))),
        Effect.bind('rows', ({ team }) => findChannelSyncMemberAddedForTeam(team.id)),
        Effect.tap(({ rows }) => Effect.sync(() => expect(rows).toHaveLength(0))),
        Effect.provide(RealReposLayer),
      ),
  );

  itEffect.effect(
    'I8: Guild/ReconcileMembers emits zero member_added rows regardless of complete, and sets discord_joined_at iff complete',
    () =>
      Effect.Do.pipe(
        Effect.bind('admin', () =>
          createUser('900100000000000010' as Discord.Snowflake, 'admin-i8'),
        ),
        Effect.bind('team', ({ admin }) =>
          createTeam('910100000000000010' as Discord.Snowflake, admin.id),
        ),
        Effect.bind('joinerTrue', () =>
          createUser('920100000000000010' as Discord.Snowflake, 'joiner-i8-true'),
        ),
        Effect.bind('joinerFalse', () =>
          createUser('920100000000000011' as Discord.Snowflake, 'joiner-i8-false'),
        ),
        Effect.bind('memberTrue', ({ team, joinerTrue }) =>
          addActiveMember(team.id, joinerTrue.id),
        ),
        Effect.bind('memberFalse', ({ team, joinerFalse }) =>
          addActiveMember(team.id, joinerFalse.id),
        ),
        Effect.bind('group', ({ team }) => createGroup(team.id, 'Strikers', Option.none())),
        Effect.tap(({ group, memberTrue }) => addGroupMemberDirectly(group.id, memberTrue.id)),
        Effect.tap(({ group, memberFalse }) => addGroupMemberDirectly(group.id, memberFalse.id)),
        Effect.tap(({ team, group }) =>
          mapGroupChannelRole(
            team.id,
            group.id,
            '930100000000000010' as Discord.Snowflake,
            '940100000000000010' as Discord.Snowflake,
          ),
        ),
        Effect.bind('resultTrue', ({ team, joinerTrue }) =>
          callReconcileMembers(
            team.guild_id,
            [{ discord_id: joinerTrue.discord_id, username: 'joiner-i8-true', roles: [] }],
            true,
          ),
        ),
        Effect.tap(({ resultTrue }) =>
          Effect.sync(() => expect(Exit.isSuccess(resultTrue)).toBe(true)),
        ),
        Effect.bind('resultFalse', ({ team, joinerFalse }) =>
          callReconcileMembers(
            team.guild_id,
            [{ discord_id: joinerFalse.discord_id, username: 'joiner-i8-false', roles: [] }],
            false,
          ),
        ),
        Effect.tap(({ resultFalse }) =>
          Effect.sync(() => expect(Exit.isSuccess(resultFalse)).toBe(true)),
        ),
        Effect.bind('rows', ({ team }) => findChannelSyncMemberAddedForTeam(team.id)),
        Effect.bind('joinedTrue', ({ team, joinerTrue }) =>
          findDiscordJoinedAt(team.id, joinerTrue.id),
        ),
        Effect.bind('joinedFalse', ({ team, joinerFalse }) =>
          findDiscordJoinedAt(team.id, joinerFalse.id),
        ),
        Effect.tap(({ rows, joinedTrue, joinedFalse }) =>
          Effect.sync(() => {
            expect(rows).toHaveLength(0);
            expect(Option.isSome(joinedTrue)).toBe(true);
            expect(Option.isNone(joinedFalse)).toBe(true);
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );

  itEffect.effect(
    'I9: a mapping row deleted entirely emits zero rows; the same group with only its channel cleared (role intact) still emits one',
    () =>
      Effect.Do.pipe(
        Effect.bind('admin', () =>
          createUser('900100000000000012' as Discord.Snowflake, 'admin-i9'),
        ),
        Effect.bind('team', ({ admin }) =>
          createTeam('910100000000000012' as Discord.Snowflake, admin.id),
        ),
        Effect.bind('joiner', () =>
          createUser('920100000000000012' as Discord.Snowflake, 'joiner-i9'),
        ),
        Effect.bind('member', ({ team, joiner }) => addActiveMember(team.id, joiner.id)),
        Effect.bind('deletedGroup', ({ team }) =>
          createGroup(team.id, 'Deleted Mapping', Option.none()),
        ),
        Effect.bind('clearedGroup', ({ team }) =>
          createGroup(team.id, 'Cleared Channel', Option.none()),
        ),
        Effect.tap(({ deletedGroup, member }) =>
          addGroupMemberDirectly(deletedGroup.id, member.id),
        ),
        Effect.tap(({ clearedGroup, member }) =>
          addGroupMemberDirectly(clearedGroup.id, member.id),
        ),
        Effect.tap(({ team, deletedGroup }) =>
          mapGroupChannelRole(
            team.id,
            deletedGroup.id,
            '930100000000000112' as Discord.Snowflake,
            '940100000000000112' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ team, clearedGroup }) =>
          mapGroupChannelRole(
            team.id,
            clearedGroup.id,
            '930100000000000212' as Discord.Snowflake,
            '940100000000000212' as Discord.Snowflake,
          ),
        ),
        Effect.tap(({ team, deletedGroup }) => deleteGroupMapping(team.id, deletedGroup.id)),
        Effect.tap(({ team, clearedGroup }) => clearGroupChannel(team.id, clearedGroup.id)),
        Effect.bind('result', ({ team, joiner }) =>
          callRegisterMember(
            registerPayload({
              guildId: team.guild_id,
              discordId: joiner.discord_id,
              username: 'joiner-i9',
            }),
          ),
        ),
        Effect.tap(({ result }) => Effect.sync(() => expect(Exit.isSuccess(result)).toBe(true))),
        Effect.bind('rows', ({ team }) => findChannelSyncMemberAddedForTeam(team.id)),
        Effect.tap(({ rows, deletedGroup, clearedGroup }) =>
          Effect.sync(() => {
            expect(rows.some((r) => r.group_id === deletedGroup.id)).toBe(false);
            const clearedRows = rows.filter((r) => r.group_id === clearedGroup.id);
            expect(clearedRows).toHaveLength(1);
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );
});
