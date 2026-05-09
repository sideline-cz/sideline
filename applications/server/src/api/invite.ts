import { Auth, Invite } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { DateTime, Duration, Effect, Option, Schedule } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership, requirePermission } from '~/api/permissions.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { PendingGuildJoinsRepository } from '~/repositories/PendingGuildJoinsRepository.js';
import { TeamInvitesRepository } from '~/repositories/TeamInvitesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';

const INVITE_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const INVITE_CODE_LENGTH = 12;

const generateInviteCode = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(INVITE_CODE_LENGTH));
  return Array.from(bytes, (b) => INVITE_CODE_CHARS[b % INVITE_CODE_CHARS.length]).join('');
};

const forbidden = new Invite.Forbidden();

export const InviteApiLive = HttpApiBuilder.group(Api, 'invite', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('teams', () => TeamsRepository.asEffect()),
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('invites', () => TeamInvitesRepository.asEffect()),
    Effect.bind('groups', () => GroupsRepository.asEffect()),
    Effect.bind('pendingGuildJoins', () => PendingGuildJoinsRepository.asEffect()),
    Effect.map(({ teams, members, invites, groups, pendingGuildJoins }) =>
      handlers
        .handle('getInvite', ({ params: { code } }) =>
          invites.findByCodeWithContext(code).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new Invite.InviteNotFound()),
                onSome: Effect.succeed,
              }),
            ),
            Effect.map(
              (ctx) =>
                new Invite.InviteInfo({
                  teamName: ctx.team_name,
                  teamId: ctx.team_id,
                  code: ctx.code,
                  groupName: ctx.group_name,
                  inviterName: Option.some(ctx.inviter_username),
                }),
            ),
          ),
        )
        .handle('joinViaInvite', ({ params: { code } }) =>
          Effect.Do.pipe(
            Effect.bind('user', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('invite', () =>
              invites.findByCode(code).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new Invite.InviteNotFound()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.bind('existing', ({ user, invite }) =>
              members.findMembershipByIds(invite.team_id, user.id),
            ),
            Effect.tap(({ existing }) =>
              Option.isSome(existing) && existing.value.active
                ? Effect.fail(new Invite.AlreadyMember())
                : Effect.void,
            ),
            Effect.bind('playerRole', ({ invite }) =>
              members.getPlayerRoleId(invite.team_id).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new Invite.InviteNotFound()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.bind('membership', ({ user, invite, existing }) =>
              Option.isSome(existing)
                ? members.reactivateMember(existing.value.id)
                : members.addMember({
                    team_id: invite.team_id,
                    user_id: user.id,
                    active: true,
                    joined_at: undefined,
                  }),
            ),
            Effect.tap(({ membership, playerRole }) =>
              members.assignRole(membership.id, playerRole.id),
            ),
            Effect.tap(({ user, invite }) => pendingGuildJoins.enqueue(user.id, invite.team_id)),
            Effect.map(
              ({ user, invite }) =>
                new Invite.JoinResult({
                  teamId: invite.team_id,
                  roleNames: ['Player'],
                  isProfileComplete: user.isProfileComplete,
                }),
            ),
            Effect.catchTag('MemberAlreadyExistsError', () =>
              Effect.fail(new Invite.AlreadyMember()),
            ),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Failed joining via invite — no row returned'),
            ),
          ),
        )
        .handle('createInvite', ({ params: { teamId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('user', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ user }) =>
              requireMembership(members, teamId, user.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'team:invite', forbidden)),
            Effect.tap(() =>
              Option.match(payload.groupId, {
                onNone: () => Effect.void,
                onSome: (groupId) =>
                  groups.findGroupById(groupId).pipe(
                    Effect.flatMap(
                      Option.match({
                        onNone: () => Effect.fail(new Invite.InvalidGroup()),
                        onSome: (group) =>
                          group.team_id === teamId
                            ? Effect.void
                            : Effect.fail(new Invite.InvalidGroup()),
                      }),
                    ),
                  ),
              }),
            ),
            Effect.bind('newInvite', ({ user }) =>
              Effect.suspend(() =>
                invites.create({
                  team_id: teamId,
                  code: generateInviteCode(),
                  active: true,
                  created_by: user.id,
                  expires_at: Option.map(payload.expiresAt, DateTime.fromDateUnsafe),
                  group_id: payload.groupId,
                  created_at: undefined,
                }),
              ).pipe(
                Effect.retry(
                  Schedule.addDelay(Schedule.recurs(5), () => Effect.succeed(Duration.millis(100))),
                ),
              ),
            ),
            Effect.map(
              ({ newInvite }) =>
                new Invite.InviteCode({
                  code: newInvite.code,
                  active: newInvite.active,
                }),
            ),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Failed creating invite — no row returned'),
            ),
          ),
        )
        .handle('listInvitesForTeam', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('user', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ user }) =>
              requireMembership(members, teamId, user.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'team:invite', forbidden)),
            Effect.bind('list', () => invites.listForTeam(teamId)),
            Effect.map(({ list }) =>
              list.map(
                (item) =>
                  new Invite.InviteListItem({
                    id: item.id,
                    code: item.code,
                    active: item.active,
                    groupId: item.groupId,
                    groupName: item.groupName,
                    inviterName: item.inviterName,
                    expiresAt: Option.map(item.expiresAt, DateTime.toDate),
                    createdAt: DateTime.toDate(item.createdAt),
                    createdBy: item.createdBy,
                  }),
              ),
            ),
          ),
        )
        .handle('regenerateInvite', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('user', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ user }) =>
              requireMembership(members, teamId, user.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'team:invite', forbidden)),
            Effect.bind('newInvite', ({ user }) =>
              Effect.suspend(() =>
                invites.create({
                  team_id: teamId,
                  code: generateInviteCode(),
                  active: true,
                  created_by: user.id,
                  expires_at: Option.some(
                    DateTime.addDuration(DateTime.nowUnsafe(), Duration.days(14)),
                  ),
                  group_id: Option.none(),
                  created_at: undefined,
                }),
              ).pipe(
                Effect.retry(
                  Schedule.addDelay(Schedule.recurs(5), () => Effect.succeed(Duration.millis(100))),
                ),
              ),
            ),
            Effect.map(
              ({ newInvite }) =>
                new Invite.InviteCode({
                  code: newInvite.code,
                  active: newInvite.active,
                }),
            ),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Failed regenerating invite — no row returned'),
            ),
          ),
        )
        .handle('disableInvite', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('user', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ user }) =>
              requireMembership(members, teamId, user.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'team:invite', forbidden)),
            Effect.tap(() => invites.deactivateByTeam(teamId)),
            Effect.asVoid,
          ),
        )
        .handle('deactivateInvite', ({ params: { teamId, inviteId } }) =>
          Effect.Do.pipe(
            Effect.bind('user', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ user }) =>
              requireMembership(members, teamId, user.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'team:invite', forbidden)),
            Effect.bind('updated', () => invites.deactivateById({ inviteId, teamId })),
            Effect.flatMap(({ updated }) =>
              Option.isSome(updated) ? Effect.void : Effect.fail(new Invite.InviteNotFound()),
            ),
          ),
        ),
    ),
  ),
);
