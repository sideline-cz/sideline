/**
 * Group and roster write bodies shared by the HTTP handlers (`api/group.ts`, `api/roster.ts`) and
 * the AI write path (`services/ai/actions.ts`). No `sql.withTransaction` here — the caller owns it.
 * Every write also queues its Discord sync event (`channel_sync_events`) in the same statement
 * flow, which is safe inside a transaction: these are plain inserts, not best-effort emitters.
 */
import {
  GroupApi,
  type GroupModel,
  Roster,
  type RosterModel,
  type Team,
  type TeamMember,
} from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Option } from 'effect';
import { requirePermission } from '~/api/permissions.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import {
  type MembershipWithRole,
  TeamMembersRepository,
} from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import {
  applyDiscordFormat,
  DEFAULT_CHANNEL_FORMAT,
  DEFAULT_ROLE_FORMAT,
} from '~/utils/applyDiscordFormat.js';
import { hexColorToDiscordInt } from '~/utils/hexColorToDiscordInt.js';

interface WriteContext {
  readonly teamId: Team.TeamId;
  readonly membership: MembershipWithRole;
}

const groupForbidden = new GroupApi.Forbidden();
const rosterForbidden = new Roster.Forbidden();

const settingsOf = (teamId: Team.TeamId) =>
  TeamSettingsRepository.asEffect().pipe(Effect.flatMap((s) => s.findByTeamId(teamId)));

/** The Discord channel and role names the bot will create for a group or roster. */
export const deriveChannelNames = (
  settings: Option.Option<{
    readonly discord_channel_format: string;
    readonly discord_role_format: string;
  }>,
  name: string,
  emoji: Option.Option<string>,
  color: Option.Option<string>,
) => ({
  channelName: applyDiscordFormat(
    Option.match(settings, {
      onNone: () => DEFAULT_CHANNEL_FORMAT,
      onSome: (s) => s.discord_channel_format,
    }),
    name,
    emoji,
  ),
  roleName: applyDiscordFormat(
    Option.match(settings, {
      onNone: () => DEFAULT_ROLE_FORMAT,
      onSome: (s) => s.discord_role_format,
    }),
    name,
    emoji,
  ),
  discordRoleColor: Option.map(color, hexColorToDiscordInt),
});

/** The member's user, for the Discord id the sync event carries. */
const memberUser = <E>(teamId: Team.TeamId, memberId: TeamMember.TeamMemberId, onMissing: E) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.flatMap((members) => members.findRosterMemberByIds(teamId, memberId)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(onMissing),
        onSome: (member) =>
          UsersRepository.asEffect().pipe(Effect.flatMap((u) => u.findById(member.user_id))),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/**
 * Every `groups.parent_id` edge must stay inside one team, and BOTH writers of that column
 * (`createGroup`'s insert and `moveGroup`'s update) go through this.
 *
 * It is not a cosmetic tenancy check. `moveGroup` serializes its cycle check on a per-team
 * advisory lock keyed by `hashtext(teamId)`, so a parent belonging to ANOTHER team would sit
 * under a different lock key and two concurrent moves could still jointly close a cycle spanning
 * the two trees — the exact race the lock exists to stop. Guarding only `moveGroup` would not be
 * enough either: a cross-team edge planted at creation time is one a later, perfectly ordinary
 * same-team move can extend into that cycle.
 *
 * A group's `team_id` is immutable (no writer updates it — `updateGroupById`, `archiveGroup` and
 * `moveGroupParent` are the only `UPDATE groups` statements), so the verdict cannot go stale
 * between this read and the write it guards.
 *
 * Fails `Forbidden`, not `GroupNotFound`, for both "no such parent" and "parent is another
 * team's" — deliberately, and not the `assignGroupRole` shape (which answers `RoleNotFound` for
 * its payload-referenced role). `createGroup` does not declare `GroupNotFound` at all
 * (`GroupApi.ts`), so reusing it would be an API contract change; and `moveGroup` already spends
 * `GroupNotFound` on the PATH group, where a second meaning would be ambiguous. Neither verdict
 * leaks more than the other: both are the same answer for missing and for cross-team.
 */
export const requireSameTeamParent = (
  teamId: Team.TeamId,
  parentId: Option.Option<GroupModel.GroupId>,
) =>
  Option.match(parentId, {
    onNone: () => Effect.void,
    onSome: (pid) =>
      GroupsRepository.asEffect().pipe(
        Effect.flatMap((groups) => groups.findGroupById(pid)),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(groupForbidden),
            onSome: (parent) =>
              parent.team_id === teamId ? Effect.void : Effect.fail(groupForbidden),
          }),
        ),
      ),
  });

export const createGroupForMemberTx = (
  args: WriteContext & {
    readonly name: string;
    readonly parentId: Option.Option<GroupModel.GroupId>;
    readonly emoji: Option.Option<string>;
    readonly color: Option.Option<string>;
  },
) =>
  Effect.Do.pipe(
    Effect.tap(() => requirePermission(args.membership, 'group:manage', groupForbidden)),
    Effect.tap(() => requireSameTeamParent(args.teamId, args.parentId)),
    Effect.bind('group', () =>
      GroupsRepository.asEffect().pipe(
        Effect.flatMap((groups) =>
          groups.insertGroup(args.teamId, args.name, args.parentId, args.emoji, args.color),
        ),
      ),
    ),
    Effect.bind('settings', () => settingsOf(args.teamId)),
    Effect.tap(({ group, settings }) => {
      const { channelName, roleName, discordRoleColor } = deriveChannelNames(
        settings,
        group.name,
        group.emoji,
        group.color,
      );
      const createChannel = Option.match(settings, {
        onNone: () => true,
        onSome: (s) => s.create_discord_channel_on_group,
      });
      return ChannelSyncEventsRepository.asEffect().pipe(
        Effect.flatMap((channelSync) =>
          channelSync.emitChannelCreated(
            args.teamId,
            group.id,
            group.name,
            Option.none(),
            createChannel ? channelName : undefined,
            roleName,
            discordRoleColor,
          ),
        ),
      );
    }),
    Effect.map(({ group }) => group),
    Effect.catchTag('GroupNameAlreadyTakenError', () =>
      Effect.fail(new GroupApi.GroupNameAlreadyTaken()),
    ),
    Effect.catchTag(
      'NoSuchElementError',
      LogicError.withMessage(() => `Failed creating group "${args.name}" — no row returned`),
    ),
  );

const findGroupInTeam = (teamId: Team.TeamId, groupId: GroupModel.GroupId) =>
  GroupsRepository.asEffect().pipe(
    Effect.flatMap((groups) => groups.findGroupById(groupId)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new GroupApi.GroupNotFound()),
        onSome: (g) =>
          g.team_id !== teamId ? Effect.fail(new GroupApi.GroupNotFound()) : Effect.succeed(g),
      }),
    ),
  );

type GroupMemberArgs = WriteContext & {
  readonly groupId: GroupModel.GroupId;
  readonly memberId: TeamMember.TeamMemberId;
};

export const addGroupMemberForMemberTx = (args: GroupMemberArgs) =>
  Effect.Do.pipe(
    Effect.tap(() => requirePermission(args.membership, 'group:manage', groupForbidden)),
    Effect.bind('group', () => findGroupInTeam(args.teamId, args.groupId)),
    Effect.bind('user', () =>
      memberUser(args.teamId, args.memberId, new GroupApi.MemberNotFound()),
    ),
    Effect.bind('groups', () => GroupsRepository.asEffect()),
    Effect.bind('channelSync', () => ChannelSyncEventsRepository.asEffect()),
    Effect.tap(({ groups }) => groups.addMemberById(args.groupId, args.memberId)),
    Effect.tap(({ group, user, groups, channelSync }) =>
      Option.match(user, {
        onNone: () => Effect.void,
        onSome: (u) =>
          Effect.all(
            [
              channelSync.emitMemberAdded(
                args.teamId,
                args.groupId,
                group.name,
                args.memberId,
                u.discord_id,
              ),
              // Archived-aware: see `rpc/guild/index.ts`'s `applyInviteGroup`.
              groups
                .getActiveAncestors(args.groupId, args.teamId)
                .pipe(
                  Effect.flatMap((ancestors) =>
                    Effect.forEach(ancestors, (ancestor) =>
                      channelSync.emitMemberAdded(
                        args.teamId,
                        ancestor.id,
                        ancestor.name,
                        args.memberId,
                        u.discord_id,
                      ),
                    ),
                  ),
                ),
            ],
            { concurrency: 'unbounded' },
          ),
      }),
    ),
    Effect.asVoid,
  );

export const removeGroupMemberForMemberTx = (args: GroupMemberArgs) =>
  Effect.Do.pipe(
    Effect.tap(() => requirePermission(args.membership, 'group:manage', groupForbidden)),
    Effect.bind('group', () => findGroupInTeam(args.teamId, args.groupId)),
    Effect.bind('user', () =>
      memberUser(args.teamId, args.memberId, new GroupApi.MemberNotFound()),
    ),
    Effect.tap(() =>
      GroupsRepository.asEffect().pipe(
        Effect.flatMap((groups) => groups.removeMemberById(args.groupId, args.memberId)),
      ),
    ),
    Effect.tap(({ group, user }) =>
      Option.match(user, {
        onNone: () => Effect.void,
        onSome: (u) =>
          ChannelSyncEventsRepository.asEffect().pipe(
            Effect.flatMap((channelSync) =>
              channelSync.emitMemberRemoved(
                args.teamId,
                args.groupId,
                group.name,
                args.memberId,
                u.discord_id,
              ),
            ),
          ),
      }),
    ),
    Effect.asVoid,
  );

// ---------------------------------------------------------------------------
// Rosters
// ---------------------------------------------------------------------------

/** Returns whether a Discord channel/role sync event was queued: the team may have turned off
 *  channel creation for rosters. */
export const createRosterForMemberTx = (
  args: WriteContext & {
    readonly name: string;
    readonly color: Option.Option<string>;
    readonly emoji: Option.Option<string>;
  },
) =>
  Effect.Do.pipe(
    Effect.tap(() => requirePermission(args.membership, 'roster:manage', rosterForbidden)),
    Effect.bind('roster', () =>
      RostersRepository.asEffect().pipe(
        Effect.flatMap((rosters) =>
          rosters.insert({
            team_id: args.teamId,
            name: args.name,
            active: true,
            color: args.color,
            emoji: args.emoji,
          }),
        ),
      ),
    ),
    Effect.bind('settings', () => settingsOf(args.teamId)),
    Effect.let('emit', ({ settings }) =>
      Option.match(settings, {
        onNone: () => true,
        onSome: (s) => s.create_discord_channel_on_roster,
      }),
    ),
    Effect.tap(({ roster, settings, emit }) => {
      if (!emit) return Effect.void;
      const { channelName, roleName, discordRoleColor } = deriveChannelNames(
        settings,
        roster.name,
        roster.emoji,
        roster.color,
      );
      return ChannelSyncEventsRepository.asEffect().pipe(
        Effect.flatMap((channelSync) =>
          Option.match(settings, {
            onNone: () =>
              channelSync.emitRosterChannelCreated(
                args.teamId,
                roster.id,
                roster.name,
                Option.none(),
                channelName,
                roleName,
                discordRoleColor,
              ),
            onSome: (s) =>
              channelSync.emitRosterChannelCreated(
                args.teamId,
                roster.id,
                roster.name,
                Option.none(),
                channelName,
                roleName,
                discordRoleColor,
                s.discord_roster_category_id,
              ),
          }),
        ),
      );
    }),
    Effect.map(({ roster, emit }) => ({ roster, discordQueued: emit })),
    Effect.catchTag(
      'NoSuchElementError',
      LogicError.withMessage(() => 'Failed creating roster — no row returned'),
    ),
  );

/** The roster, only while it belongs to the team. `findRosterById` is not team-scoped. */
const findRosterInTeam = (teamId: Team.TeamId, rosterId: RosterModel.RosterId) =>
  RostersRepository.asEffect().pipe(
    Effect.flatMap((rosters) => rosters.findRosterById(rosterId)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new Roster.RosterNotFound()),
        onSome: (r) =>
          r.team_id !== teamId ? Effect.fail(new Roster.RosterNotFound()) : Effect.succeed(r),
      }),
    ),
  );

type RosterMemberArgs = WriteContext & {
  readonly rosterId: RosterModel.RosterId;
  readonly memberId: TeamMember.TeamMemberId;
};

const rosterMemberWrite = (added: boolean) => (args: RosterMemberArgs) =>
  Effect.Do.pipe(
    Effect.tap(() => requirePermission(args.membership, 'roster:manage', rosterForbidden)),
    Effect.bind('roster', () => findRosterInTeam(args.teamId, args.rosterId)),
    Effect.bind('user', () => memberUser(args.teamId, args.memberId, new Roster.PlayerNotFound())),
    Effect.bind('rosters', () => RostersRepository.asEffect()),
    Effect.bind('channelSync', () => ChannelSyncEventsRepository.asEffect()),
    Effect.tap(({ rosters }) =>
      added
        ? rosters.addMemberById(args.rosterId, args.memberId)
        : rosters.removeMemberById(args.rosterId, args.memberId),
    ),
    Effect.tap(({ roster, user, channelSync }) =>
      Option.match(user, {
        onNone: () => Effect.void,
        onSome: (u) =>
          (added ? channelSync.emitRosterMemberAdded : channelSync.emitRosterMemberRemoved)(
            args.teamId,
            args.rosterId,
            roster.name,
            args.memberId,
            Option.some(u.discord_id),
          ),
      }),
    ),
    Effect.asVoid,
  );

export const addRosterMemberForMemberTx = rosterMemberWrite(true);
export const removeRosterMemberForMemberTx = rosterMemberWrite(false);
