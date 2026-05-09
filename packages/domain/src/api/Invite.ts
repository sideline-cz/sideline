import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { GroupId } from '~/models/GroupModel.js';
import { TeamId } from '~/models/Team.js';
import { TeamInviteId } from '~/models/TeamInvite.js';
import { UserId } from '~/models/User.js';

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
