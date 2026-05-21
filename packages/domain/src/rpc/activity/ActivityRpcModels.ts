import { Schema } from 'effect';
import { ActivityLogId } from '~/models/ActivityLog.js';
import { ActivityTypeId } from '~/models/ActivityType.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export class LogActivityResult extends Schema.Class<LogActivityResult>('LogActivityResult')({
  id: ActivityLogId,
  activity_type_id: Schema.String,
  logged_at: Schema.String,
}) {}

export class ActivityMemberNotFound extends Schema.TaggedErrorClass<ActivityMemberNotFound>()(
  'ActivityMemberNotFound',
  {},
) {}

export class ActivityGuildNotFound extends Schema.TaggedErrorClass<ActivityGuildNotFound>()(
  'ActivityGuildNotFound',
  {},
) {}

export class GetStatsResult extends Schema.Class<GetStatsResult>('GetStatsResult')({
  current_streak: Schema.Int,
  longest_streak: Schema.Int,
  total_activities: Schema.Int,
  total_duration_minutes: Schema.Int,
  counts: Schema.Array(
    Schema.Struct({
      activity_type_id: Schema.String,
      activity_type_name: Schema.String,
      count: Schema.Int,
    }),
  ),
}) {}

export class LeaderboardEntryResult extends Schema.Class<LeaderboardEntryResult>(
  'LeaderboardEntryResult',
)({
  rank: Schema.Int,
  team_member_id: TeamMemberId,
  username: Schema.String,
  total_activities: Schema.Int,
  total_duration_minutes: Schema.Int,
  current_streak: Schema.Int,
  longest_streak: Schema.Int,
}) {}

export class GetLeaderboardResult extends Schema.Class<GetLeaderboardResult>(
  'GetLeaderboardResult',
)({
  entries: Schema.Array(LeaderboardEntryResult),
  requesting_user_rank: Schema.OptionFromNullOr(Schema.Int),
  requesting_user_entry: Schema.OptionFromNullOr(LeaderboardEntryResult),
}) {}

export class ActivityTypeChoice extends Schema.Class<ActivityTypeChoice>('ActivityTypeChoice')({
  id: ActivityTypeId,
  name: Schema.String,
  slug: Schema.OptionFromNullOr(Schema.String),
  emoji: Schema.OptionFromNullOr(Schema.String),
  isGlobal: Schema.Boolean,
}) {}

export class ActivityTypeNotFound extends Schema.TaggedErrorClass<ActivityTypeNotFound>()(
  'ActivityTypeNotFound',
  {},
) {}

export class InvalidLoggedAtDate extends Schema.TaggedErrorClass<InvalidLoggedAtDate>()(
  'ActivityLogInvalidLoggedAtDate',
  {},
) {}
