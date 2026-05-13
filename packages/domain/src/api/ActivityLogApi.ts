import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { ActivityLogId, ActivitySource } from '~/models/ActivityLog.js';
import * as ActivityType from '~/models/ActivityType.js';
import { ActivityTypeId } from '~/models/ActivityType.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export class ActivityLogEntry extends Schema.Class<ActivityLogEntry>('ActivityLogEntry')({
  id: ActivityLogId,
  activityTypeId: ActivityTypeId,
  activityTypeName: Schema.String,
  activityTypeEmoji: Schema.OptionFromNullOr(ActivityType.ActivityTypeEmoji),
  loggedAt: Schema.String,
  durationMinutes: Schema.OptionFromNullOr(Schema.Int),
  note: Schema.OptionFromNullOr(Schema.String),
  source: ActivitySource,
}) {}

export class ActivityLogListResponse extends Schema.Class<ActivityLogListResponse>(
  'ActivityLogListResponse',
)({
  logs: Schema.Array(ActivityLogEntry),
}) {}

export const CreateActivityLogRequest = Schema.Struct({
  activityTypeId: ActivityTypeId,
  durationMinutes: Schema.OptionFromNullOr(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 1440 }))),
  ),
  note: Schema.OptionFromNullOr(Schema.String),
});
export type CreateActivityLogRequest = Schema.Schema.Type<typeof CreateActivityLogRequest>;

export const UpdateActivityLogRequest = Schema.Struct({
  activityTypeId: Schema.OptionFromOptional(ActivityTypeId),
  durationMinutes: Schema.OptionFromOptional(
    Schema.OptionFromNullOr(
      Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 1440 }))),
    ),
  ),
  note: Schema.OptionFromOptional(Schema.OptionFromNullOr(Schema.String)),
});
export type UpdateActivityLogRequest = Schema.Schema.Type<typeof UpdateActivityLogRequest>;

export class MemberNotFound extends Schema.TaggedErrorClass<MemberNotFound>()(
  'ActivityLogMemberNotFound',
  {},
) {}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()('ActivityLogForbidden', {}) {}

export class LogNotFound extends Schema.TaggedErrorClass<LogNotFound>()(
  'ActivityLogNotFound',
  {},
) {}

export class MemberInactive extends Schema.TaggedErrorClass<MemberInactive>()(
  'ActivityLogMemberInactive',
  {},
) {}

export class AutoSourceForbidden extends Schema.TaggedErrorClass<AutoSourceForbidden>()(
  'ActivityLogAutoSourceForbidden',
  {},
) {}

export class ActivityLogApiGroup extends HttpApiGroup.make('activityLog')
  .add(
    HttpApiEndpoint.get('listLogs', '/teams/:teamId/members/:memberId/activity-logs', {
      success: ActivityLogListResponse,
      error: [
        MemberNotFound.pipe(HttpApiSchema.status(404)),
        Forbidden.pipe(HttpApiSchema.status(403)),
      ],
      params: { teamId: TeamId, memberId: TeamMemberId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createLog', '/teams/:teamId/members/:memberId/activity-logs', {
      success: ActivityLogEntry.pipe(HttpApiSchema.status(201)),
      error: [
        MemberNotFound.pipe(HttpApiSchema.status(404)),
        Forbidden.pipe(HttpApiSchema.status(403)),
        MemberInactive.pipe(HttpApiSchema.status(403)),
      ],
      payload: CreateActivityLogRequest,
      params: { teamId: TeamId, memberId: TeamMemberId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateLog', '/teams/:teamId/members/:memberId/activity-logs/:logId', {
      success: ActivityLogEntry,
      error: [
        LogNotFound.pipe(HttpApiSchema.status(404)),
        Forbidden.pipe(HttpApiSchema.status(403)),
        MemberInactive.pipe(HttpApiSchema.status(403)),
        AutoSourceForbidden.pipe(HttpApiSchema.status(403)),
      ],
      payload: UpdateActivityLogRequest,
      params: { teamId: TeamId, memberId: TeamMemberId, logId: ActivityLogId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post(
      'deleteLog',
      '/teams/:teamId/members/:memberId/activity-logs/:logId/delete',
      {
        success: Schema.Void.pipe(HttpApiSchema.status(204)),
        error: [
          LogNotFound.pipe(HttpApiSchema.status(404)),
          Forbidden.pipe(HttpApiSchema.status(403)),
          MemberInactive.pipe(HttpApiSchema.status(403)),
          AutoSourceForbidden.pipe(HttpApiSchema.status(403)),
        ],
        params: { teamId: TeamId, memberId: TeamMemberId, logId: ActivityLogId },
      },
    ).middleware(AuthMiddleware),
  ) {}
