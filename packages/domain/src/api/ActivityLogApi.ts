import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import {
  ActivityLogId,
  ActivitySeasonFilter,
  ActivitySeasonId,
  ActivitySource,
} from '~/models/ActivityLog.js';
import * as ActivityType from '~/models/ActivityType.js';
import { ActivityTypeId } from '~/models/ActivityType.js';
import { GroupId } from '~/models/GroupModel.js';
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

export class ActivitySeason extends Schema.Class<ActivitySeason>('ActivitySeason')({
  id: ActivitySeasonId,
  startsAt: Schema.String,
  // expires_at, else the next season's starts_at, else None (open)
  endsAt: Schema.OptionFromNullOr(Schema.String),
  isCurrent: Schema.Boolean,
}) {}

export class ActivityLogListResponse extends Schema.Class<ActivityLogListResponse>(
  'ActivityLogListResponse',
)({
  logs: Schema.Array(ActivityLogEntry),
  // Seasons that started, newest first
  seasons: Schema.Array(ActivitySeason),
}) {}

export class ActivityMatrixEntry extends Schema.Class<ActivityMatrixEntry>('ActivityMatrixEntry')({
  activityTypeName: Schema.String,
  activityTypeEmoji: Schema.OptionFromNullOr(ActivityType.ActivityTypeEmoji),
  totalMinutes: Schema.OptionFromNullOr(Schema.Int),
}) {}

export class ActivityMatrixCell extends Schema.Class<ActivityMatrixCell>('ActivityMatrixCell')({
  // YYYY-MM-DD, Europe/Prague
  date: Schema.String,
  entries: Schema.Array(ActivityMatrixEntry),
}) {}

export class ActivityMatrixRow extends Schema.Class<ActivityMatrixRow>('ActivityMatrixRow')({
  memberId: TeamMemberId,
  displayName: Schema.String,
  // Only days with at least one log
  cells: Schema.Array(ActivityMatrixCell),
}) {}

export class ActivityMatrixGroup extends Schema.Class<ActivityMatrixGroup>('ActivityMatrixGroup')({
  groupId: GroupId,
  name: Schema.String,
  emoji: Schema.OptionFromNullOr(Schema.String),
}) {}

export class ActivityMatrixResponse extends Schema.Class<ActivityMatrixResponse>(
  'ActivityMatrixResponse',
)({
  // 30 Prague days, oldest first, today last
  days: Schema.Array(Schema.String),
  rows: Schema.Array(ActivityMatrixRow),
  groups: Schema.Array(ActivityMatrixGroup),
}) {}

export const LoggedAtDate = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
);

export const CreateActivityLogRequest = Schema.Struct({
  activityTypeId: ActivityTypeId,
  durationMinutes: Schema.OptionFromNullOr(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 1440 }))),
  ),
  note: Schema.OptionFromNullOr(Schema.String),
  loggedAtDate: Schema.OptionFromNullOr(LoggedAtDate),
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
  loggedAtDate: Schema.OptionFromOptional(LoggedAtDate),
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

export class InvalidLoggedAtDate extends Schema.TaggedErrorClass<InvalidLoggedAtDate>()(
  'ActivityLogInvalidLoggedAtDate',
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
      query: { season: Schema.OptionFromOptional(ActivitySeasonFilter) },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getActivityMatrix', '/teams/:teamId/activity-matrix', {
      success: ActivityMatrixResponse,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
      query: {
        // UUID check: a bad id is a 400, not a 22P02 -> 500
        group: Schema.OptionFromOptional(GroupId.pipe(Schema.check(Schema.isUUID()))),
      },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createLog', '/teams/:teamId/members/:memberId/activity-logs', {
      success: ActivityLogEntry.pipe(HttpApiSchema.status(201)),
      error: [
        MemberNotFound.pipe(HttpApiSchema.status(404)),
        Forbidden.pipe(HttpApiSchema.status(403)),
        MemberInactive.pipe(HttpApiSchema.status(403)),
        InvalidLoggedAtDate.pipe(HttpApiSchema.status(400)),
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
        InvalidLoggedAtDate.pipe(HttpApiSchema.status(400)),
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
