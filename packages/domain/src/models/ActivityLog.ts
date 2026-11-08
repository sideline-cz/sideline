import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { ActivityTypeId } from '~/models/ActivityType.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export const ActivityLogId = Schema.String.pipe(Schema.brand('ActivityLogId'));
export type ActivityLogId = typeof ActivityLogId.Type;

export const ActivitySource = Schema.Literals(['manual', 'auto']);
export type ActivitySource = typeof ActivitySource.Type;

// UUID check: a bad id is a 400, not a 22P02 -> 500.
export const ActivitySeasonId = Schema.String.pipe(
  Schema.check(Schema.isUUID()),
  Schema.brand('ActivitySeasonId'),
);
export type ActivitySeasonId = typeof ActivitySeasonId.Type;

// 'earlier' = logs outside any season (season_id IS NULL).
export const ActivitySeasonFilter = Schema.Union([Schema.Literal('earlier'), ActivitySeasonId]);
export type ActivitySeasonFilter = typeof ActivitySeasonFilter.Type;

export class ActivityLog extends Model.Class<ActivityLog>('ActivityLog')({
  id: Model.Generated(ActivityLogId),
  team_member_id: TeamMemberId,
  activity_type_id: ActivityTypeId,
  logged_at: Model.DateTimeInsertFromDate,
  duration_minutes: Schema.OptionFromNullOr(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 1440 }))),
  ),
  note: Schema.OptionFromNullOr(Schema.String),
  source: ActivitySource,
  created_at: Model.DateTimeInsertFromDate,
}) {}
