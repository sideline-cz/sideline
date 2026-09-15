import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { Snowflake } from '~/models/Discord.js';
import { TeamId } from '~/models/Team.js';
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

// Drives the install-base-wide group-role member backfill (see
// `applications/server/src/api/global-admin.ts` and
// `applications/server/src/utils/backfillGroupRoleMembers.ts`) one PAGE of teams at a
// time. `after` is the cursor returned as `nextAfter` by the previous call (absent on
// the first call); the operator re-submits it to resume from where the last
// invocation left off. There is deliberately NO all-teams action: one invocation's
// real cost is `Σ (direct + descendant members) over every group selected across the
// page's teams`, drained serially on the single global channel queue, so an
// all-teams-at-once shape would enqueue the install base's entire group membership
// from one click and stall every other channel event behind it.
export const GroupRoleBackfillRequest = Schema.Struct({
  after: Schema.OptionFromNullOr(TeamId),
});
export type GroupRoleBackfillRequest = Schema.Schema.Type<typeof GroupRoleBackfillRequest>;

export class GroupRoleBackfillResult extends Schema.Class<GroupRoleBackfillResult>(
  'GroupRoleBackfillResult',
)({
  processedCount: Schema.Number,
  remainingCount: Schema.Number,
  // Teams still left to visit after this page, in the same stable
  // `(created_at, id)` order the sweep walks. This is the mirror of `nextAfter`:
  // it is 0 exactly when `nextAfter` is `Option.none()`.
  remainingTeams: Schema.Number,
  // Cursor for the next call; `Option.none()` once every team has been visited
  // (i.e. once `remainingTeams` is 0). The operator stops calling — or may
  // equivalently keep calling with `after: nextAfter` while `remainingTeams > 0` —
  // both checks always agree.
  nextAfter: Schema.OptionFromNullOr(TeamId),
}) {}

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
  .add(
    HttpApiEndpoint.post('backfillGroupRoleMembers', '/global-admins/group-role-member-backfill', {
      success: GroupRoleBackfillResult,
      error: GlobalAdminForbidden.pipe(HttpApiSchema.status(403)),
      payload: GroupRoleBackfillRequest,
    }).middleware(AuthMiddleware),
  )
  .prefix('/auth') {}
