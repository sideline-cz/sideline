import { Auth, Invite, OAuthConnection } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { DateTime, Duration, Effect, Option, Schedule } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership, requirePermission } from '~/api/permissions.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { InviteAcceptancesRepository } from '~/repositories/InviteAcceptancesRepository.js';
import { OAuthConnectionsRepository } from '~/repositories/OAuthConnectionsRepository.js';
import { PendingGuildJoinsRepository } from '~/repositories/PendingGuildJoinsRepository.js';
import { TeamInvitesRepository } from '~/repositories/TeamInvitesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { deriveJoinStatusState } from '~/utils/joinStatusState.js';
import { resolveOrCreateAcceptance } from '~/utils/resolveOrCreateAcceptance.js';

const INVITE_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const INVITE_CODE_LENGTH = 12;

const generateInviteCode = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(INVITE_CODE_LENGTH));
  return Array.from(bytes, (b) => INVITE_CODE_CHARS[b % INVITE_CODE_CHARS.length]).join('');
};

const forbidden = new Invite.Forbidden();

export const InviteApiLive = HttpApiBuilder.group(Api, 'invite', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('invites', () => TeamInvitesRepository.asEffect()),
    Effect.bind('acceptances', () => InviteAcceptancesRepository.asEffect()),
    Effect.bind('groups', () => GroupsRepository.asEffect()),
    Effect.bind('oauthConnections', () => OAuthConnectionsRepository.asEffect()),
    Effect.bind('pendingGuildJoins', () => PendingGuildJoinsRepository.asEffect()),
    Effect.map(({ members, invites, acceptances, groups, oauthConnections, pendingGuildJoins }) =>
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
              members.findMembershipByIds(invite.team_id, user.id, { includeInactive: true }),
            ),
            // Should-fix 6 (third review of PR-4): single source of truth for "is this a
            // returning member who is already active", used below by `membership`, the
            // `assignRole` gate, and `roleNames` — previously each computed
            // `Option.isSome(existing) && existing.value.active` independently, with nothing
            // enforcing they agreed.
            Effect.let('activeMembership', ({ existing }) =>
              Option.filter(existing, (member) => member.active),
            ),
            // Should-fix 5 (third review of PR-4): no longer fails the request when the team
            // has no "Player" role. That value is only consumed by the `assignRole` tap below,
            // which itself is skipped for a returning active member — failing here unconditionally
            // 404'd every idempotent re-join for a team that renamed or deleted its Player role.
            Effect.bind('playerRole', ({ invite }) => members.getPlayerRoleId(invite.team_id)),
            // CC-14: `Invite.AlreadyMember` is no longer raised. A returning active member does
            // not get re-inserted; everyone else (new member, or a previously-removed member
            // being reactivated) runs today's insert/reactivate path. Both cases fall through to
            // the same acceptance-resolution + enqueue tail below.
            Effect.bind('membership', ({ user, invite, existing, activeMembership }) =>
              Option.isSome(activeMembership)
                ? Effect.succeed({ id: activeMembership.value.id })
                : Option.isSome(existing)
                  ? members
                      .reactivateMember(existing.value.id)
                      .pipe(Effect.map((member) => ({ id: member.id })))
                  : members
                      .addMember({
                        team_id: invite.team_id,
                        user_id: user.id,
                        active: true,
                        joined_at: undefined,
                      })
                      .pipe(Effect.map((member) => ({ id: member.id }))),
            ),
            // Must-fix 7: skip for a returning ACTIVE member. The removed `AlreadyMember` tap
            // used to short-circuit above this line for that cohort; without an equivalent
            // guard here, a captain or coach without the Player role who opens their own team's
            // invite link would silently gain it on every re-join. Should-fix 5: only fail on a
            // missing Player role when the assignment is actually about to run.
            Effect.tap(({ activeMembership, membership, playerRole }) =>
              Option.isSome(activeMembership)
                ? Effect.void
                : Option.match(playerRole, {
                    onNone: () => Effect.fail(new Invite.InviteNotFound()),
                    onSome: (role) => members.assignRole(membership.id, role.id),
                  }),
            ),
            Effect.bind('grantedScopes', ({ user }) =>
              oauthConnections.getGrantedScopes(user.id, 'discord'),
            ),
            Effect.let('requiresReauth', ({ grantedScopes }) =>
              Option.match(grantedScopes, {
                onNone: () => true,
                onSome: (raw) =>
                  !OAuthConnection.hasScope(raw, OAuthConnection.REQUIRED_DISCORD_SCOPE),
              }),
            ),
            // Should-fix 7: derived from whether `assignRole` actually ran above, rather than
            // unconditionally `['Player']` — a returning active member whose assignment was
            // skipped may not hold the role.
            Effect.let('roleNames', ({ activeMembership }) =>
              Option.isSome(activeMembership) ? [] : ['Player'],
            ),
            // BLOCKER 1 (third review of PR-4): `resolveOrCreateAcceptance`'s rate limit is now
            // scoped to this (user, invite) pair, so it always returns a real acceptance — see
            // its doc comment for why the old "fails closed, no acceptance" branch is provably
            // unreachable. `resolved.acceptance` is no longer `Option`, so there is nothing left
            // to log or plumb through `JoinResult` as absent (should-fix 8: this also removes
            // the double logging — the one remaining rate-limit log lives in the helper, next
            // to the branch it describes).
            Effect.bind('resolved', ({ user, invite }) =>
              resolveOrCreateAcceptance(user.id, invite),
            ),
            // S4/step 6 — `enqueue` fires only from this explicit Join click (never a background
            // job), and it fires here whether this is a first join or an idempotent re-join,
            // which is the point: a returning member whose auto-join previously failed gets
            // re-queued by clicking Join again. Guarded with `catchCause` (must-fix 8): a queue
            // insert failing must never fail the user's join — membership and the acceptance
            // are already committed by this point.
            Effect.tap(({ user, invite, requiresReauth }) =>
              requiresReauth
                ? Effect.logInfo(
                    '[invite/join] skipping pending_guild_joins enqueue — missing guilds.join',
                  )
                : pendingGuildJoins
                    .enqueue(user.id, invite.team_id)
                    .pipe(
                      Effect.catchCause((cause) =>
                        Effect.logError('[invite/join] pending_guild_joins enqueue failed', cause),
                      ),
                    ),
            ),
            Effect.map(
              ({ user, invite, requiresReauth, resolved, roleNames }) =>
                new Invite.JoinResult({
                  teamId: invite.team_id,
                  roleNames,
                  isProfileComplete: user.isProfileComplete,
                  requiresReauth,
                  acceptanceId: resolved.acceptance.id,
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
        .handle('getJoinStatus', ({ params: { acceptanceId } }) =>
          Effect.Do.pipe(
            Effect.bind('user', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('acc', () =>
              acceptances.findById(acceptanceId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new Invite.InviteNotFound()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            // Ownership check (live security fix): without it, any authenticated caller holding
            // an acceptanceId gets a working one-time Discord invite to a server they were never
            // invited to. 404, not 403 — do not confirm existence to a non-owner.
            Effect.tap(({ user, acc }) =>
              acc.user_id === user.id ? Effect.void : Effect.fail(new Invite.InviteNotFound()),
            ),
            // PR-9 / CC-15: `InviteAcceptance` carries no `team_id` of its own — resolve it
            // through `team_invites` so `discord_joined_at` can be checked for this (team, user)
            // pair. `None` (an orphaned acceptance, or a race with the invite being deleted) just
            // means "not observed joined" — never a hard failure of the whole read.
            Effect.bind('teamId', ({ acc }) => acceptances.findTeamIdById(acc.id)),
            Effect.bind('discordJoinedAt', ({ user, teamId }) =>
              Option.match(teamId, {
                onNone: () => Effect.succeedNone,
                onSome: (id) => members.findDiscordJoinedAt(id, user.id),
              }),
            ),
            Effect.map(({ acc, discordJoinedAt }) => {
              const derived = deriveJoinStatusState(acc, Option.isSome(discordJoinedAt));
              return new Invite.JoinStatus({
                acceptanceId: acc.id,
                discordInviteUrl: derived.discordInviteUrl,
                errorCode: derived.errorCode,
                state: derived.state,
              });
            }),
          ),
        )
        .handle('getMyPendingDiscordJoin', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('user', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ user }) =>
              requireMembership(members, teamId, user.id, forbidden),
            ),
            // Ownership: scoped to the CALLING user's own id, never anything
            // request-controlled — the same hole PR-4 closed on `getJoinStatus`.
            Effect.bind('open', ({ user }) => acceptances.findOpenByUserAndTeam(user.id, teamId)),
            Effect.bind('discordJoinedAt', ({ user }) =>
              members.findDiscordJoinedAt(teamId, user.id),
            ),
            Effect.map(({ open, discordJoinedAt }) =>
              Option.map(open, (acc) => {
                const derived = deriveJoinStatusState(acc, Option.isSome(discordJoinedAt));
                return new Invite.JoinStatus({
                  acceptanceId: acc.id,
                  discordInviteUrl: derived.discordInviteUrl,
                  errorCode: derived.errorCode,
                  state: derived.state,
                });
              }),
            ),
          ),
        )
        .handle('regenerateMyDiscordInvite', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('user', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ user }) =>
              requireMembership(members, teamId, user.id, forbidden),
            ),
            // Step 8: resolve the team's active invite first — `None` means the team has no
            // invite link at all, and the UI shows the "ask your captain" copy.
            Effect.bind('activeInvite', () => invites.findActiveByTeamId(teamId)),
            Effect.bind('resolved', ({ user, activeInvite }) =>
              Option.match(activeInvite, {
                onNone: () => Effect.succeedNone,
                onSome: (invite) => resolveOrCreateAcceptance(user.id, invite).pipe(Effect.asSome),
              }),
            ),
            // S4 / CC-14: `enqueue` fires only on the `created: true` branch — this is an
            // explicit user click (the regenerate CTA), and reusing an existing row must not
            // re-trigger the auto-join queue.
            Effect.tap(({ user, activeInvite, resolved }) =>
              Option.isSome(activeInvite) && Option.isSome(resolved) && resolved.value.created
                ? pendingGuildJoins
                    .enqueue(user.id, activeInvite.value.team_id)
                    .pipe(
                      Effect.catchCause((cause) =>
                        Effect.logError(
                          '[invite/regenerate] pending_guild_joins enqueue failed',
                          cause,
                        ),
                      ),
                    )
                : Effect.void,
            ),
            Effect.bind('discordJoinedAt', ({ user }) =>
              members.findDiscordJoinedAt(teamId, user.id),
            ),
            Effect.map(({ resolved, discordJoinedAt }) =>
              Option.map(resolved, ({ acceptance }) => {
                const derived = deriveJoinStatusState(acceptance, Option.isSome(discordJoinedAt));
                return new Invite.JoinStatus({
                  acceptanceId: acceptance.id,
                  discordInviteUrl: derived.discordInviteUrl,
                  errorCode: derived.errorCode,
                  state: derived.state,
                });
              }),
            ),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Failed regenerating invite — no row returned'),
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
