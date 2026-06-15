import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { Snowflake } from '~/models/Discord.js';
import { UserId } from '~/models/User.js';

// --- Schemas ---

export const GlobalAdminSource = Schema.Literals(['db', 'env']);
export type GlobalAdminSource = typeof GlobalAdminSource.Type;

export const GlobalAdminListItem = Schema.Struct({
  discordId: Snowflake,
  userId: Schema.OptionFromNullOr(UserId),
  username: Schema.OptionFromNullOr(Schema.String),
  avatar: Schema.OptionFromNullOr(Schema.String),
  source: GlobalAdminSource,
  grantedAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  revocable: Schema.Boolean,
  isSelf: Schema.Boolean,
});
export type GlobalAdminListItem = Schema.Schema.Type<typeof GlobalAdminListItem>;

export const GrantGlobalAdminRequest = Schema.Struct({
  discordId: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^\d{17,20}$/)),
    Schema.brand('Snowflake'),
  ),
});
export type GrantGlobalAdminRequest = Schema.Schema.Type<typeof GrantGlobalAdminRequest>;

// --- Tagged errors ---

export class GlobalAdminForbidden extends Schema.TaggedErrorClass<GlobalAdminForbidden>()(
  'GlobalAdminForbidden',
  {},
) {}

export class GlobalAdminUserNotFound extends Schema.TaggedErrorClass<GlobalAdminUserNotFound>()(
  'GlobalAdminUserNotFound',
  {},
) {}

export class GlobalAdminLastAdminError extends Schema.TaggedErrorClass<GlobalAdminLastAdminError>()(
  'GlobalAdminLastAdminError',
  {},
) {}

export class GlobalAdminSelfRevokeError extends Schema.TaggedErrorClass<GlobalAdminSelfRevokeError>()(
  'GlobalAdminSelfRevokeError',
  {},
) {}

export class GlobalAdminEnvManaged extends Schema.TaggedErrorClass<GlobalAdminEnvManaged>()(
  'GlobalAdminEnvManaged',
  {},
) {}

// --- API group ---

export class GlobalAdminApiGroup extends HttpApiGroup.make('globalAdmin')
  .add(
    HttpApiEndpoint.get('listGlobalAdmins', '/global-admins', {
      success: Schema.Array(GlobalAdminListItem),
      error: GlobalAdminForbidden.pipe(HttpApiSchema.status(403)),
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('grantGlobalAdmin', '/global-admins', {
      success: Schema.Array(GlobalAdminListItem),
      error: [
        GlobalAdminForbidden.pipe(HttpApiSchema.status(403)),
        GlobalAdminUserNotFound.pipe(HttpApiSchema.status(404)),
      ],
      payload: GrantGlobalAdminRequest,
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete('revokeGlobalAdmin', '/global-admins/:userId', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        GlobalAdminForbidden.pipe(HttpApiSchema.status(403)),
        GlobalAdminUserNotFound.pipe(HttpApiSchema.status(404)),
        GlobalAdminLastAdminError.pipe(HttpApiSchema.status(409)),
        GlobalAdminSelfRevokeError.pipe(HttpApiSchema.status(409)),
        GlobalAdminEnvManaged.pipe(HttpApiSchema.status(409)),
      ],
      params: { userId: UserId },
    }).middleware(AuthMiddleware),
  )
  .prefix('/auth') {}
