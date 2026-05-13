import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import {
  ActivityTypeDescription,
  ActivityTypeEmoji,
  ActivityTypeId,
  ActivityTypeName,
} from '~/models/ActivityType.js';
import { TeamId } from '~/models/Team.js';

export class ActivityTypeInfo extends Schema.Class<ActivityTypeInfo>('ActivityTypeInfo')({
  id: ActivityTypeId,
  teamId: Schema.OptionFromNullOr(TeamId),
  name: Schema.String,
  slug: Schema.OptionFromNullOr(Schema.String),
  emoji: Schema.OptionFromNullOr(ActivityTypeEmoji),
  description: Schema.OptionFromNullOr(ActivityTypeDescription),
  usageCount: Schema.Number,
}) {}

export class ActivityTypeListResponse extends Schema.Class<ActivityTypeListResponse>(
  'ActivityTypeApiListResponse',
)({
  canAdmin: Schema.Boolean,
  activityTypes: Schema.Array(ActivityTypeInfo),
}) {}

export const CreateActivityTypeRequest = Schema.Struct({
  name: ActivityTypeName,
  emoji: Schema.OptionFromNullOr(ActivityTypeEmoji),
  description: Schema.OptionFromNullOr(ActivityTypeDescription),
});
export type CreateActivityTypeRequest = Schema.Schema.Type<typeof CreateActivityTypeRequest>;

export const UpdateActivityTypeRequest = Schema.Struct({
  name: Schema.OptionFromOptional(ActivityTypeName),
  emoji: Schema.OptionFromOptional(Schema.OptionFromNullOr(ActivityTypeEmoji)),
  description: Schema.OptionFromOptional(Schema.OptionFromNullOr(ActivityTypeDescription)),
});
export type UpdateActivityTypeRequest = Schema.Schema.Type<typeof UpdateActivityTypeRequest>;

export class ActivityTypeNotFound extends Schema.TaggedErrorClass<ActivityTypeNotFound>()(
  'ActivityTypeNotFound',
  {},
) {}

export class ActivityTypeProtected extends Schema.TaggedErrorClass<ActivityTypeProtected>()(
  'ActivityTypeProtected',
  {},
) {}

export class ActivityTypeNameAlreadyTaken extends Schema.TaggedErrorClass<ActivityTypeNameAlreadyTaken>()(
  'ActivityTypeNameAlreadyTaken',
  { name: Schema.String },
) {}

export class ActivityTypeHasLogs extends Schema.TaggedErrorClass<ActivityTypeHasLogs>()(
  'ActivityTypeHasLogs',
  { usageCount: Schema.Number },
) {}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()('ActivityTypeForbidden', {}) {}

export class ActivityTypeApiGroup extends HttpApiGroup.make('activityType')
  .add(
    HttpApiEndpoint.get('listActivityTypes', '/teams/:teamId/activity-types', {
      success: ActivityTypeListResponse,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createActivityType', '/teams/:teamId/activity-types', {
      success: ActivityTypeInfo.pipe(HttpApiSchema.status(201)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        ActivityTypeNameAlreadyTaken.pipe(HttpApiSchema.status(409)),
      ],
      payload: CreateActivityTypeRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getActivityType', '/teams/:teamId/activity-types/:activityTypeId', {
      success: ActivityTypeInfo,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        ActivityTypeNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, activityTypeId: ActivityTypeId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateActivityType', '/teams/:teamId/activity-types/:activityTypeId', {
      success: ActivityTypeInfo,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        ActivityTypeNotFound.pipe(HttpApiSchema.status(404)),
        ActivityTypeProtected.pipe(HttpApiSchema.status(422)),
        ActivityTypeNameAlreadyTaken.pipe(HttpApiSchema.status(409)),
      ],
      payload: UpdateActivityTypeRequest,
      params: { teamId: TeamId, activityTypeId: ActivityTypeId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete('deleteActivityType', '/teams/:teamId/activity-types/:activityTypeId', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        ActivityTypeNotFound.pipe(HttpApiSchema.status(404)),
        ActivityTypeProtected.pipe(HttpApiSchema.status(422)),
        ActivityTypeHasLogs.pipe(HttpApiSchema.status(409)),
      ],
      params: { teamId: TeamId, activityTypeId: ActivityTypeId },
    }).middleware(AuthMiddleware),
  ) {}
