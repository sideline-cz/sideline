import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { GroupId } from '~/models/GroupModel.js';
import { InviteAcceptanceId } from '~/models/InviteAcceptance.js';
import { TeamId } from '~/models/Team.js';
import { TeamInviteId } from '~/models/TeamInvite.js';
import { UserId } from '~/models/User.js';

/**
 * The client-facing subset of `Onboarding.InviteGeneratorErrorCode`. `'expired'` is never here
 * — `JoinStatus.state` carries it (CC-3). Name is permanent, not `LegacyInviteGeneratorErrorCode`:
 * this is not a legacy artefact awaiting deletion, it is the permanent client contract.
 * `'bot_not_in_guild'` joined in PR-9, once the server bundles the widened stored enum (PR-2) and
 * every browser that could receive it does too (CC-3's three-release schedule). See
 * `applications/server/src/utils/inviteErrorWireProjection.ts` for the projection applied at the
 * `getJoinStatus` read boundary. Model: `EventRsvpApi.ts` `LegacyRsvpResponse` /
 * `rsvpWireProjection.ts`.
 */
export const JoinStatusErrorCode = Schema.Literals([
  'welcome_channel_missing',
  'welcome_channel_deleted',
  'bot_missing_perms',
  'community_not_enabled',
  'rate_limited',
  'discord_error',
  'network_error',
  'unknown',
  'bot_not_in_guild',
]);
export type JoinStatusErrorCode = typeof JoinStatusErrorCode.Type;

export class InviteInfo extends Schema.Class<InviteInfo>('InviteInfo')({
  teamName: Schema.String,
  teamId: TeamId,
  code: Schema.String,
  groupName: Schema.OptionFromNullOr(Schema.String),
  inviterName: Schema.OptionFromNullOr(Schema.String),
}) {}

export class JoinResult extends Schema.Class<JoinResult>('JoinResult')({
  teamId: TeamId,
  roleNames: Schema.Array(Schema.String),
  isProfileComplete: Schema.Boolean,
  requiresReauth: Schema.Boolean,
  // BLOCKER 1 (third review of PR-4): `resolveOrCreateAcceptance`'s rate limit is scoped to
  // the (user, invite) pair, which makes "no acceptance returned" provably unreachable — see
  // `applications/server/src/utils/resolveOrCreateAcceptance.ts`. No longer `Option`.
  acceptanceId: InviteAcceptanceId,
}) {}

/**
 * PR-5 shipped this without `'joined'` (CC-15): the only truthful source for "already in the
 * guild" is `team_members.discord_joined_at`, which did not exist until PR-8 — until then,
 * "already in the guild" was expressed as `getMyPendingDiscordJoin` returning `Option.none()`
 * (nothing pending), not a state on this union. PR-9 adds `'joined'`, purely additively, derived
 * from `discord_joined_at` — the only source that is *cleared* when a user leaves the guild
 * (`Guild/RemoveMember`), so it can never go stale the way `pending_guild_joins.status = 'done'`
 * would have (rev 2's sticky-`'done'` bug). `discordJoined` takes precedence over every other
 * derivation in `joinStatusState.ts`: a user who is factually in the guild is `'joined'`
 * regardless of what their invite acceptance row says. `Schema.withDecodingDefaultKey` lets an
 * old server's payload (no `state` key at all) decode in a new browser as `'preparing'` —
 * harmless, since a browser that old never reads this field anyway.
 */
export const JoinStatusState = Schema.Literals([
  'preparing',
  'ready',
  'expired',
  'failed',
  'joined',
]);
export type JoinStatusState = typeof JoinStatusState.Type;

export class JoinStatus extends Schema.Class<JoinStatus>('JoinStatus')({
  acceptanceId: InviteAcceptanceId,
  discordInviteUrl: Schema.OptionFromNullOr(Schema.String),
  // CC-3: `'expired'` never appears here — it is carried by `state` instead. See
  // `applications/server/src/utils/inviteErrorWireProjection.ts`.
  errorCode: Schema.OptionFromNullOr(JoinStatusErrorCode),
  state: JoinStatusState.pipe(Schema.withDecodingDefaultKey(() => 'preparing')),
}) {}

export class InviteCode extends Schema.Class<InviteCode>('InviteCode')({
  code: Schema.String,
  active: Schema.Boolean,
}) {}

export const CreateInviteInput = Schema.Struct({
  groupId: Schema.OptionFromNullOr(GroupId),
  expiresAt: Schema.OptionFromNullOr(Schema.Date),
});
export type CreateInviteInput = typeof CreateInviteInput.Type;

export class InviteListItem extends Schema.Class<InviteListItem>('InviteListItem')({
  id: TeamInviteId,
  code: Schema.String,
  active: Schema.Boolean,
  groupId: Schema.OptionFromNullOr(GroupId),
  groupName: Schema.OptionFromNullOr(Schema.String),
  inviterName: Schema.OptionFromNullOr(Schema.String),
  expiresAt: Schema.OptionFromNullOr(Schema.Date),
  createdAt: Schema.Date,
  createdBy: UserId,
}) {}

export class InviteNotFound extends Schema.TaggedErrorClass<InviteNotFound>()(
  'InviteNotFound',
  {},
) {}

export class AlreadyMember extends Schema.TaggedErrorClass<AlreadyMember>()('AlreadyMember', {}) {}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()('Forbidden', {}) {}

export class InvalidGroup extends Schema.TaggedErrorClass<InvalidGroup>()('InvalidGroup', {}) {}

export class InviteApiGroup extends HttpApiGroup.make('invite')
  .add(
    HttpApiEndpoint.get('getInvite', '/invite/:code', {
      success: InviteInfo,
      error: InviteNotFound.pipe(HttpApiSchema.status(404)),
      params: { code: Schema.String },
    }),
  )
  .add(
    HttpApiEndpoint.post('joinViaInvite', '/invite/:code/join', {
      success: JoinResult,
      error: [
        InviteNotFound.pipe(HttpApiSchema.status(404)),
        AlreadyMember.pipe(HttpApiSchema.status(409)),
      ],
      params: { code: Schema.String },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getJoinStatus', '/invite/acceptances/:acceptanceId', {
      success: JoinStatus,
      error: InviteNotFound.pipe(HttpApiSchema.status(404)),
      params: { acceptanceId: InviteAcceptanceId },
    }).middleware(AuthMiddleware),
  )
  .add(
    // PR-5 step 3: server-sourced replacement for the localStorage-only banner
    // (designer §1 root cause 1). Scoped to the CALLING user's own acceptance — never a
    // request-controlled id (CC-14's ownership fix on `getJoinStatus` must not be reopened
    // here).
    HttpApiEndpoint.get('getMyPendingDiscordJoin', '/teams/:teamId/me/discord-join', {
      success: Schema.OptionFromNullOr(JoinStatus),
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    // PR-5 step 4 / CC-14: what the "Get a new invite" CTA calls. Returns the SAME shape as
    // the GET above so the client replaces its polled state with the response and keeps
    // polling, with no second decode path and no new error tag.
    HttpApiEndpoint.post('regenerateMyDiscordInvite', '/teams/:teamId/me/discord-join', {
      success: Schema.OptionFromNullOr(JoinStatus),
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createInvite', '/teams/:teamId/invites', {
      success: InviteCode,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        InvalidGroup.pipe(HttpApiSchema.status(422)),
      ],
      params: { teamId: TeamId },
      payload: CreateInviteInput,
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('listInvitesForTeam', '/teams/:teamId/invites', {
      success: Schema.Array(InviteListItem),
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    // @deprecated — use createInvite
    HttpApiEndpoint.post('regenerateInvite', '/teams/:teamId/invite/regenerate', {
      success: InviteCode,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete('disableInvite', '/teams/:teamId/invite', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('deactivateInvite', '/teams/:teamId/invites/:inviteId/deactivate', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        InviteNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, inviteId: TeamInviteId },
    }).middleware(AuthMiddleware),
  ) {}
