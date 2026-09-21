// TDD mode — bug 3da93506 ("group roles never reach Discord").
//
// `Guild/RegisterMember` is the RPC the bot calls on every guild-member-add / reconnect. Today
// it never binds the `group_members` row a group-scoped invite carries, and — even where a
// group add DOES happen elsewhere (`api/invite.ts`'s `joinViaInvite`) — nothing ever emits the
// `channel_sync_events` `member_added` rows that make the bot grant the group's own Discord role
// or the roles of any Sideline role linked to the group (`role_groups`). A mocked repository
// layer (see `test/rpc/RegisterMember.test.ts`) can only prove ORDERING; it cannot prove the
// real recursive `effectiveRoles.ts` walk and the real `getActiveAncestors` walk agree about
// which ancestors still grant once one of them is archived. This file wires the real
// `GuildsRpcLive` against a real Postgres (testcontainers), the same pattern as
// `GuildGetAllUpcomingEventsForUserVisibility.test.ts`.
//
// Expected to FAIL until the developer implements Tasks 1-3 of the approved spec (the
// `applyInviteGroup` group-bind + channel-sync emit inside `Guild/RegisterMember`, plus
// `getActiveAncestors` already added to `GroupsRepository`).

import { it as itEffect } from '@effect/vitest';
import type {
  Discord,
  GroupModel,
  InviteAcceptance,
  Role,
  Team,
  TeamInvite,
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

// `GuildsRpcLive` is built with `toLayer(handlers)`, so every requirement of every handler
// function it closes over must be satisfiable — including the ones `Guild/RegisterMember`
// doesn't touch directly but reaches through `reconcileMemberDiscordRoles`
// (`RolesRepository`, `RoleSyncEventsRepository`) and through other handlers in the same
// `toLayer` call (`RostersRepository`, `ChannelSyncEventsRepository`). `TeamInvitesRepository`
// is only needed by this file's own seeding, not by the RPC itself, but sits in the same merged
// layer for convenience (mirrors `RealReposLayer` below).
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
// Seed helpers — through the real repositories, so the real `effectiveRolesFrom` (member roles
// diff) and the real `getActiveAncestors` recursion (channel-sync emit) are what's under test.
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

// The seeded team MUST carry `guild_id` — `_emitIfGuildLinked`
// (`ChannelSyncEventsRepository.ts`) silently drops every channel-sync event for a team with no
// linked guild, which would make every "still 0 rows" assertion below pass for the wrong reason.
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

const findGroupMembers = (groupId: GroupModel.GroupId) =>
  GroupsRepository.asEffect().pipe(Effect.andThen((repo) => repo.findMembersByGroupId(groupId)));

const createRole = (teamId: Team.TeamId, name: string) =>
  RolesRepository.asEffect().pipe(Effect.andThen((repo) => repo.insertRole(teamId, name)));

const assignRoleToGroup = (roleId: Role.RoleId, groupId: GroupModel.GroupId) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.assignRoleToGroup(roleId, groupId)),
  );

const mapDiscordRole = (
  teamId: Team.TeamId,
  roleId: Role.RoleId,
  discordRoleId: Discord.Snowflake,
) =>
  DiscordRoleMappingRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.insert(teamId, roleId, discordRoleId, true)),
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

// ---------------------------------------------------------------------------
// Raw reads of the two sync-event tables — no repository exposes a "find all events for a
// team" read (only "find unprocessed", which would race the write inside the same test), so
// these read the tables directly, mirroring the pattern already used by
// `EventRosterProvisioningDiscordId.test.ts`'s `queryRosterMemberAddedRows`.
// ---------------------------------------------------------------------------

const findRoleSyncEventsForTeam = (teamId: Team.TeamId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql<{
          event_type: string;
          role_id: string;
          team_member_id: string | null;
          discord_user_id: string | null;
        }>`
          SELECT event_type, role_id, team_member_id, discord_user_id
          FROM role_sync_events
          WHERE team_id = ${teamId}
        `,
    ),
  );

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
// RPC call helper
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

describe('Guild/RegisterMember — group-scoped invite reaches Discord (bug 3da93506)', () => {
  itEffect.effect(
    'I1: emits role_assigned for the group linked role in the same RegisterMember call',
    () =>
      Effect.Do.pipe(
        Effect.bind('admin', () =>
          createUser('900000000000000001' as Discord.Snowflake, 'admin-i1'),
        ),
        Effect.bind('team', ({ admin }) =>
          createTeam('910000000000000001' as Discord.Snowflake, admin.id),
        ),
        Effect.bind('joiner', () =>
          createUser('920000000000000001' as Discord.Snowflake, 'joiner-i1'),
        ),
        Effect.bind('group', ({ team }) => createGroup(team.id, 'Strikers', Option.none())),
        Effect.bind('role', ({ team }) => createRole(team.id, 'Strikers Player')),
        Effect.tap(({ role, group }) => assignRoleToGroup(role.id, group.id)),
        Effect.tap(({ team, role }) =>
          mapDiscordRole(team.id, role.id, '700000000000000001' as Discord.Snowflake),
        ),
        Effect.bind('invite', ({ team, admin, group }) =>
          createInvite(team.id, admin.id, 'CODE-I1', Option.some(group.id)),
        ),
        Effect.bind('acceptance', ({ invite, joiner }) => createAcceptance(invite.id, joiner.id)),
        Effect.tap(({ acceptance }) => setDiscordCode(acceptance.id, 'CODE-I1')),
        Effect.bind('result', ({ team, joiner }) =>
          callRegisterMember({
            guild_id: team.guild_id,
            discord_id: joiner.discord_id,
            username: 'joiner-i1',
            avatar: Option.none(),
            roles: [],
            nickname: Option.none(),
            display_name: Option.none(),
            invite_code: Option.some('CODE-I1'),
            source: Option.some('member_add'),
          }),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            expect(Exit.isSuccess(result)).toBe(true);
          }),
        ),
        Effect.bind('groupMembers', ({ group }) => findGroupMembers(group.id)),
        Effect.bind('roleSyncEvents', ({ team }) => findRoleSyncEventsForTeam(team.id)),
        Effect.tap(({ groupMembers, roleSyncEvents, role, joiner }) =>
          Effect.sync(() => {
            expect(groupMembers.length).toBe(1);
            const assigned = roleSyncEvents.filter((e) => e.event_type === 'role_assigned');
            expect(assigned.length).toBe(1);
            expect(assigned[0]?.role_id).toBe(role.id);
            expect(assigned[0]?.discord_user_id).toBe(joiner.discord_id);
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );

  itEffect.effect(
    'I2: a group with no linked Sideline role still gets member_added for itself and its parent',
    () =>
      Effect.Do.pipe(
        Effect.bind('admin', () =>
          createUser('900000000000000002' as Discord.Snowflake, 'admin-i2'),
        ),
        Effect.bind('team', ({ admin }) =>
          createTeam('910000000000000002' as Discord.Snowflake, admin.id),
        ),
        Effect.bind('joiner', () =>
          createUser('920000000000000002' as Discord.Snowflake, 'joiner-i2'),
        ),
        Effect.bind('parent', ({ team }) => createGroup(team.id, 'Seniors', Option.none())),
        Effect.bind('group', ({ team, parent }) =>
          createGroup(team.id, 'Strikers', Option.some(parent.id)),
        ),
        Effect.bind('invite', ({ team, admin, group }) =>
          createInvite(team.id, admin.id, 'CODE-I2', Option.some(group.id)),
        ),
        Effect.bind('acceptance', ({ invite, joiner }) => createAcceptance(invite.id, joiner.id)),
        Effect.tap(({ acceptance }) => setDiscordCode(acceptance.id, 'CODE-I2')),
        Effect.bind('result', ({ team, joiner }) =>
          callRegisterMember({
            guild_id: team.guild_id,
            discord_id: joiner.discord_id,
            username: 'joiner-i2',
            avatar: Option.none(),
            roles: [],
            nickname: Option.none(),
            display_name: Option.none(),
            invite_code: Option.some('CODE-I2'),
            source: Option.some('member_add'),
          }),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            expect(Exit.isSuccess(result)).toBe(true);
          }),
        ),
        Effect.bind('roleSyncEvents', ({ team }) => findRoleSyncEventsForTeam(team.id)),
        Effect.bind('channelSyncEvents', ({ team }) => findChannelSyncMemberAddedForTeam(team.id)),
        Effect.tap(({ roleSyncEvents, channelSyncEvents, group, parent, joiner }) =>
          Effect.sync(() => {
            // Nothing to diff — this group has no `role_groups` row at all.
            expect(roleSyncEvents.length).toBe(0);

            expect(channelSyncEvents.length).toBe(2);
            const groupIds = channelSyncEvents.map((e) => e.group_id).sort();
            expect(groupIds).toEqual([group.id, parent.id].sort());
            for (const row of channelSyncEvents) {
              expect(row.discord_user_id).toBe(joiner.discord_id);
              expect(row.team_member_id).not.toBeNull();
            }
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );

  itEffect.effect(
    'I3: an archived ancestor is excluded from member_added, matching role sync severing',
    () =>
      Effect.Do.pipe(
        Effect.bind('admin', () =>
          createUser('900000000000000003' as Discord.Snowflake, 'admin-i3'),
        ),
        Effect.bind('team', ({ admin }) =>
          createTeam('910000000000000003' as Discord.Snowflake, admin.id),
        ),
        Effect.bind('joiner', () =>
          createUser('920000000000000003' as Discord.Snowflake, 'joiner-i3'),
        ),
        Effect.bind('grandparent', ({ team }) => createGroup(team.id, 'Club', Option.none())),
        Effect.bind('parent', ({ team, grandparent }) =>
          createGroup(team.id, 'Seniors', Option.some(grandparent.id)),
        ),
        Effect.tap(({ parent }) => archiveGroup(parent.id)),
        Effect.bind('group', ({ team, parent }) =>
          createGroup(team.id, 'Strikers', Option.some(parent.id)),
        ),
        Effect.bind('role', ({ team }) => createRole(team.id, 'Club Member')),
        Effect.tap(({ role, grandparent }) => assignRoleToGroup(role.id, grandparent.id)),
        // Present so this stays a realistic fully-provisioned setup. It is no longer load-bearing
        // for the assertion: since bug 3da93506 the diff emits `role_assigned` for a desired role
        // even with no mapping, so a failure to sever would surface as a `role_sync_events` row
        // either way. Kept rather than dropped — mapping the role is the normal state, and the
        // test should sever under normal conditions.
        Effect.tap(({ team, role }) =>
          mapDiscordRole(team.id, role.id, '700000000000000003' as Discord.Snowflake),
        ),
        Effect.bind('invite', ({ team, admin, group }) =>
          createInvite(team.id, admin.id, 'CODE-I3', Option.some(group.id)),
        ),
        Effect.bind('acceptance', ({ invite, joiner }) => createAcceptance(invite.id, joiner.id)),
        Effect.tap(({ acceptance }) => setDiscordCode(acceptance.id, 'CODE-I3')),
        Effect.bind('result', ({ team, joiner }) =>
          callRegisterMember({
            guild_id: team.guild_id,
            discord_id: joiner.discord_id,
            username: 'joiner-i3',
            avatar: Option.none(),
            roles: [],
            nickname: Option.none(),
            display_name: Option.none(),
            invite_code: Option.some('CODE-I3'),
            source: Option.some('member_add'),
          }),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            expect(Exit.isSuccess(result)).toBe(true);
          }),
        ),
        Effect.bind('roleSyncEvents', ({ team }) => findRoleSyncEventsForTeam(team.id)),
        Effect.bind('channelSyncEvents', ({ team }) => findChannelSyncMemberAddedForTeam(team.id)),
        Effect.tap(({ roleSyncEvents, channelSyncEvents, group }) =>
          Effect.sync(() => {
            // Severed at the archived `parent` — the grandparent-linked role never reaches the
            // diff.
            expect(roleSyncEvents.length).toBe(0);

            // Severed identically on the channel-sync side — `member_added` only for `group`
            // itself, never for the archived `parent` nor (transitively) the `grandparent`.
            expect(channelSyncEvents.length).toBe(1);
            expect(channelSyncEvents[0]?.group_id).toBe(group.id);
          }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );

  itEffect.effect(
    "I4: a role linked to an ACTIVE ancestor is emitted alongside the ancestor's member_added",
    () =>
      Effect.Do.pipe(
        Effect.bind('admin', () =>
          createUser('900000000000000004' as Discord.Snowflake, 'admin-i4'),
        ),
        Effect.bind('team', ({ admin }) =>
          createTeam('910000000000000004' as Discord.Snowflake, admin.id),
        ),
        Effect.bind('joiner', () =>
          createUser('920000000000000004' as Discord.Snowflake, 'joiner-i4'),
        ),
        Effect.bind('parent', ({ team }) => createGroup(team.id, 'Seniors', Option.none())),
        Effect.bind('group', ({ team, parent }) =>
          createGroup(team.id, 'Strikers', Option.some(parent.id)),
        ),
        Effect.bind('role', ({ team }) => createRole(team.id, 'Seniors Member')),
        // The role is linked to the ancestor, not the invited group itself — this is what
        // proves `effectiveRolesFrom` walks UP from `group` to `parent` and does not sever,
        // mirroring `getActiveAncestors`'s own upward walk on the channel-sync side.
        Effect.tap(({ role, parent }) => assignRoleToGroup(role.id, parent.id)),
        Effect.tap(({ team, role }) =>
          mapDiscordRole(team.id, role.id, '700000000000000004' as Discord.Snowflake),
        ),
        Effect.bind('invite', ({ team, admin, group }) =>
          createInvite(team.id, admin.id, 'CODE-I4', Option.some(group.id)),
        ),
        Effect.bind('acceptance', ({ invite, joiner }) => createAcceptance(invite.id, joiner.id)),
        Effect.tap(({ acceptance }) => setDiscordCode(acceptance.id, 'CODE-I4')),
        Effect.bind('result', ({ team, joiner }) =>
          callRegisterMember({
            guild_id: team.guild_id,
            discord_id: joiner.discord_id,
            username: 'joiner-i4',
            avatar: Option.none(),
            roles: [],
            nickname: Option.none(),
            display_name: Option.none(),
            invite_code: Option.some('CODE-I4'),
            source: Option.some('member_add'),
          }),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            expect(Exit.isSuccess(result)).toBe(true);
          }),
        ),
        Effect.bind('groupMembers', ({ group }) => findGroupMembers(group.id)),
        Effect.bind('roleSyncEvents', ({ team }) => findRoleSyncEventsForTeam(team.id)),
        Effect.bind('channelSyncEvents', ({ team }) => findChannelSyncMemberAddedForTeam(team.id)),
        Effect.tap(
          ({ groupMembers, roleSyncEvents, channelSyncEvents, role, group, parent, joiner }) =>
            Effect.sync(() => {
              // Ancestor membership is implied by the tree, not stored — only `group` itself
              // gets a `group_members` row.
              expect(groupMembers.length).toBe(1);

              // Not severed — the ancestor-linked role reaches the diff exactly once.
              const assigned = roleSyncEvents.filter((e) => e.event_type === 'role_assigned');
              expect(assigned.length).toBe(1);
              expect(assigned[0]?.role_id).toBe(role.id);
              expect(assigned[0]?.discord_user_id).toBe(joiner.discord_id);

              // Not severed on the channel-sync side either — `member_added` for both `group`
              // and `parent`.
              expect(channelSyncEvents.length).toBe(2);
              const groupIds = channelSyncEvents.map((e) => e.group_id).sort();
              expect(groupIds).toEqual([group.id, parent.id].sort());
              for (const row of channelSyncEvents) {
                expect(row.discord_user_id).toBe(joiner.discord_id);
                expect(row.team_member_id).not.toBeNull();
              }
            }),
        ),
        Effect.provide(RealReposLayer),
      ),
  );
});
