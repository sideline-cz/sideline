import {
  AgeThresholdApi,
  type Discord,
  type GroupModel,
  type Team,
  type TeamMember,
  type User,
} from '@sideline/domain';
import { Array, Data, Effect, Layer, Option, pipe, ServiceMap } from 'effect';
import {
  AgeThresholdRepository,
  type AgeThresholdWithGroupName,
  type MemberForAutoAssignment,
} from '~/repositories/AgeThresholdRepository.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { NotificationsRepository } from '~/repositories/NotificationsRepository.js';
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import {
  captureGroupRoleSnapshot,
  emitGroupRoleChanges,
  type GroupRoleSyncTarget,
} from '~/utils/syncGroupRoleMembers.js';

interface Dependencies {
  thresholds: ServiceMap.Service.Shape<typeof AgeThresholdRepository>;
  groups: ServiceMap.Service.Shape<typeof GroupsRepository>;
  notifications: ServiceMap.Service.Shape<typeof NotificationsRepository>;
  channelSync: ServiceMap.Service.Shape<typeof ChannelSyncEventsRepository>;
  roleSyncEvents: ServiceMap.Service.Shape<typeof RoleSyncEventsRepository>;
  teamMembersRepository: ServiceMap.Service.Shape<typeof TeamMembersRepository>;
}

interface Change {
  userId: User.UserId;
  memberId: TeamMember.TeamMemberId;
  memberName: string;
  discordId: Discord.Snowflake;
  groupId: GroupModel.GroupId;
  groupName: string;
  action: 'added' | 'removed';
}

const makeChange = (change: Change) => change;

const computeAge = (birthDateStr: string, now: Date): number => {
  const birth = new Date(`${birthDateStr}T00:00:00Z`);
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - birth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < birth.getUTCDate())) age--;
  return age;
};

const detectChanges = (
  today: Date,
  rules: readonly AgeThresholdWithGroupName[],
  teamMembers: readonly MemberForAutoAssignment[],
) =>
  pipe(
    teamMembers,
    Array.flatMap((member) =>
      Array.map(rules, (rule) => ({
        rule,
        member,
      })),
    ),
    Array.let('age', ({ member }) => Option.map(member.birth_date, (bd) => computeAge(bd, today))),
    Array.let('ageOk', ({ age, rule }) => {
      // A bound is "satisfied" when either the rule omits it, or the member has an
      // age that meets it. Crucially, a rule WITH a bound and a member WITHOUT an
      // age must fail — `Option.exists` returns false on `None`, giving us that.
      const minOk = Option.match(rule.min_age, {
        onNone: () => true,
        onSome: (mn) => Option.exists(age, (a) => a >= mn),
      });
      const maxOk = Option.match(rule.max_age, {
        onNone: () => true,
        onSome: (mx) => Option.exists(age, (a) => a <= mx),
      });
      return minOk && maxOk;
    }),
    Array.let('genderOk', ({ rule, member }) =>
      Option.match(rule.gender, {
        onNone: () => true,
        onSome: (g) => Option.exists(member.gender, (mg) => mg === g),
      }),
    ),
    Array.let('requiredGroupOk', ({ rule, member }) =>
      Option.match(rule.required_group_id, {
        onNone: () => true,
        onSome: (gid) => Array.contains(member.group_ids, gid),
      }),
    ),
    Array.let(
      'shouldBeInGroup',
      ({ ageOk, genderOk, requiredGroupOk }) => ageOk && genderOk && requiredGroupOk,
    ),
    Array.let('isInGroup', ({ member, rule }) => Array.contains(member.group_ids, rule.group_id)),
    Array.filter(({ shouldBeInGroup, isInGroup }) => shouldBeInGroup !== isInGroup),
    Array.let('displayName', ({ member }) =>
      Option.getOrElse(member.member_name, () => member.username),
    ),
    Array.map(({ shouldBeInGroup, member, displayName, rule }) =>
      shouldBeInGroup
        ? makeChange({
            userId: member.user_id,
            memberId: member.member_id,
            memberName: displayName,
            discordId: member.discord_id,
            groupId: rule.group_id,
            groupName: rule.group_name,
            action: 'added',
          })
        : makeChange({
            userId: member.user_id,
            memberId: member.member_id,
            memberName: displayName,
            discordId: member.discord_id,
            groupId: rule.group_id,
            groupName: rule.group_name,
            action: 'removed',
          }),
    ),
  );

const commitChange =
  (groups: ServiceMap.Service.Shape<typeof GroupsRepository>) => (change: Change) =>
    Effect.succeed(change).pipe(
      Effect.tap(
        change.action === 'added'
          ? groups.addMemberById(change.groupId, change.memberId)
          : groups.removeMemberById(change.groupId, change.memberId),
      ),
    );

const commitChanges = (
  groups: ServiceMap.Service.Shape<typeof GroupsRepository>,
  changes: readonly Change[],
) =>
  pipe(
    changes,
    Array.map(commitChange(groups)),
    Array.map(
      Effect.tap((change) =>
        Effect.logInfo(
          `${change.memberId} was automatically ${change.action === 'added' ? 'added to' : 'removed from'} the "${change.groupName}" group based on automatic group rules.`,
        ),
      ),
    ),
    Array.map(Effect.tapError(Effect.logError)),
    Effect.all,
    Effect.tap((commits) =>
      Effect.logInfo(`Successfully made ${commits.length} changes to age-based groups!`),
    ),
  );

class NoChanges extends Data.TaggedError('NoChanges')<{
  readonly count: 0;
}> {}

const notifyAdmins = (
  notifications: ServiceMap.Service.Shape<typeof NotificationsRepository>,
  teamId: Team.TeamId,
  changes: readonly Change[],
  teamMembers: readonly MemberForAutoAssignment[],
) =>
  Effect.succeed(
    pipe(
      teamMembers,
      Array.filter(({ is_admin }) => is_admin),
      Array.map((m) => m.user_id),
    ),
  ).pipe(
    Effect.map(Array.dedupe),
    Effect.map(
      Array.flatMap((userId) =>
        Array.map(changes, (change) =>
          change.action === 'added'
            ? {
                teamId,
                userId,
                type: 'age_group_added' as const,
                title: `Added to group "${change.groupName}"`,
                body: `${change.memberName} was automatically added to the "${change.groupName}" group based on automatic group rules.`,
              }
            : {
                teamId,
                userId,
                type: 'age_group_removed' as const,
                title: `Removed from group "${change.groupName}"`,
                body: `${change.memberName} was automatically removed from the "${change.groupName}" group based on automatic group rules.`,
              },
        ),
      ),
    ),
    Effect.tap((notifications) =>
      Array.isArrayEmpty(notifications) ? Effect.fail(new NoChanges({ count: 0 })) : Effect.void,
    ),
    Effect.flatMap((n) => notifications.insertBulk(n)),
    Effect.catchTag('NoChanges', () => Effect.void),
    Effect.tapError((e) => Effect.logWarning('Failed to notify admins about age-based changes', e)),
    Effect.catchTag('NoSuchElementError', () => Effect.void),
  );

// `fix/group-role-discord-sync` (decision 5): automatic age-based group adds/removes
// (`commitChange` above) had NO role-sync emission at all, unlike the equivalent HTTP
// `addGroupMember` / `removeGroupMember` handlers (`api/group.ts`, via
// `utils/syncGroupRoleMembers.ts`). The removal direction in particular was a live permissions
// leak: a member who aged out of a group kept that group's Discord role forever, because nothing
// ever told the bot to revoke it.
//
// This now routes through the SAME shared before/after effective-roles diff every group-shaped
// HTTP handler uses (`captureGroupRoleSnapshot` / `emitGroupRoleChanges`,
// `utils/syncGroupRoleMembers.ts`), rather than emitting directly from
// `groups.getRolesForGroup(change.groupId)` (the earlier, narrower approach). That approach
// stripped a role the member still held through another group, an ancestor, or a direct
// `member_roles` grant — reachable in practice (e.g. a role attached to both `U14` and `Juniors`:
// a member ages out of `U14` but is still in `Juniors`, and would have had the role stripped in
// Discord regardless). The shared diff computes effective roles (group-inherited, ancestor-walked,
// `is_archived`-filtered) before and after the batch of `commitChanges` writes below, and gates
// every removal on `member_role_grants`, so a role still held any other way is never emitted as
// `role_unassigned`. It also applies the same per-operation cap
// (`MAX_ROLE_SYNC_EMISSIONS_PER_GROUP_OPERATION`) the HTTP handlers get — this cron evaluates
// every team with rules with no team/guild predicate on the drain side, making it the single
// largest fan-out in the system.
const buildRoleSyncTargets = (changes: readonly Change[]): ReadonlyArray<GroupRoleSyncTarget> => {
  const seen = new Set<TeamMember.TeamMemberId>();
  const targets: Array<GroupRoleSyncTarget> = [];
  for (const change of changes) {
    if (seen.has(change.memberId)) continue;
    seen.add(change.memberId);
    targets.push({ teamMemberId: change.memberId, discordUserId: change.discordId });
  }
  return targets;
};

const evaluateTeam =
  ({
    thresholds,
    groups,
    notifications,
    channelSync,
    roleSyncEvents,
    teamMembersRepository,
  }: Dependencies) =>
  (teamId: Team.TeamId, today: Date) =>
    Effect.Do.pipe(
      Effect.bind('rules', () => thresholds.findRulesByTeamId(teamId)),
      Effect.bind('teamMembers', () => thresholds.getMembersForAutoAssignment(teamId)),
      Effect.let('changes', ({ rules, teamMembers }) => detectChanges(today, rules, teamMembers)),
      Effect.tap(({ changes }) =>
        Array.isArrayEmpty(changes) ? Effect.fail(new NoChanges({ count: 0 })) : Effect.void,
      ),
      Effect.tap(({ changes }) =>
        Effect.logInfo(`Detected ${changes.length} changes to be made with age-based groups!`),
      ),
      // MUST run BEFORE `commitChanges` below — this is the "before" snapshot the shared diff
      // computes against (see `buildRoleSyncTargets`'s header comment).
      Effect.bind('roleSyncSnapshot', ({ changes }) =>
        captureGroupRoleSnapshot(buildRoleSyncTargets(changes)).pipe(
          Effect.provideService(TeamMembersRepository, teamMembersRepository),
        ),
      ),
      Effect.bind('commited', ({ changes }) => commitChanges(groups, changes)),
      Effect.tap(({ changes }) =>
        pipe(
          changes,
          Array.map((change) =>
            change.action === 'added'
              ? notifications.insert(
                  teamId,
                  change.userId,
                  'age_group_added',
                  `Added to group "${change.groupName}"`,
                  `You have been added to the "${change.groupName}" group based on automatic group rules.`,
                )
              : notifications.insert(
                  teamId,
                  change.userId,
                  'age_group_removed',
                  `Removed from group "${change.groupName}"`,
                  `You have been removed from the "${change.groupName}" group based on automatic group rules.`,
                ),
          ),
          Effect.all,
          Effect.asVoid,
        ),
      ),
      Effect.tap(({ changes, teamMembers }) =>
        notifyAdmins(notifications, teamId, changes, teamMembers),
      ),
      Effect.tap(({ changes }) =>
        pipe(
          changes,
          Array.map((change) =>
            change.action === 'added'
              ? channelSync.emitMemberAdded(
                  teamId,
                  change.groupId,
                  change.groupName,
                  change.memberId,
                  change.discordId,
                )
              : channelSync.emitMemberRemoved(
                  teamId,
                  change.groupId,
                  change.groupName,
                  change.memberId,
                  change.discordId,
                ),
          ),
          Effect.all,
          Effect.asVoid,
        ),
      ),
      // Best-effort (never fails, degrades internally — see `syncGroupRoleMembers.ts`'s header):
      // re-reads the same members' effective roles now that `commitChanges` has run, diffs against
      // `roleSyncSnapshot.before`, and emits exactly the roles gained/lost as a result of THIS
      // evaluation's group changes.
      Effect.tap(({ roleSyncSnapshot }) =>
        emitGroupRoleChanges(teamId, roleSyncSnapshot, { operation: 'ageCheck' }).pipe(
          Effect.provideService(TeamMembersRepository, teamMembersRepository),
          Effect.provideService(RoleSyncEventsRepository, roleSyncEvents),
        ),
      ),
      Effect.map(({ changes }) =>
        Array.map(
          changes,
          (c) =>
            new AgeThresholdApi.AgeGroupChange({
              memberId: c.memberId,
              memberName: c.memberName,
              groupId: c.groupId,
              groupName: c.groupName,
              action: c.action,
            }),
        ),
      ),
      Effect.catchTag('NoChanges', () => Effect.succeed(Array.empty())),
    );

const make = Effect.Do.pipe(
  Effect.bind('thresholds', () => AgeThresholdRepository.asEffect()),
  Effect.bind('groups', () => GroupsRepository.asEffect()),
  Effect.bind('notifications', () => NotificationsRepository.asEffect()),
  Effect.bind('channelSync', () => ChannelSyncEventsRepository.asEffect()),
  Effect.bind('roleSyncEvents', () => RoleSyncEventsRepository.asEffect()),
  Effect.bind('teamMembersRepository', () => TeamMembersRepository.asEffect()),
  Effect.let('evaluateTeam', evaluateTeam),
  Effect.map(({ evaluateTeam }) => ({
    evaluate: (teamId: Team.TeamId, today: Date) => evaluateTeam(teamId, today),
  })),
);

export class AgeCheckService extends ServiceMap.Service<
  AgeCheckService,
  Effect.Success<typeof make>
>()('api/AgeCheckService') {
  static readonly Default = Layer.effect(AgeCheckService, make);
}
