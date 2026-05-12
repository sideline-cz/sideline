import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import * as Achievement from '~/models/Achievement.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export class ActivityStatsResponse extends Schema.Class<ActivityStatsResponse>(
  'ActivityStatsResponse',
)({
  currentStreak: Schema.Int,
  longestStreak: Schema.Int,
  totalActivities: Schema.Int,
  totalDurationMinutes: Schema.Int,
  counts: Schema.Array(
    Schema.Struct({
      activityTypeId: Schema.String,
      activityTypeName: Schema.String,
      count: Schema.Int,
    }),
  ),
  achievements: Schema.Array(
    Schema.Struct({
      slug: Achievement.AchievementSlug,
      earned_at: Schema.String,
    }),
  ),
}) {}

export class MemberNotFound extends Schema.TaggedErrorClass<MemberNotFound>()(
  'ActivityStatsMemberNotFound',
  {},
) {}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()('ActivityStatsForbidden', {}) {}

export class ActivityStatsApiGroup extends HttpApiGroup.make('activityStats').add(
  HttpApiEndpoint.get('getMemberStats', '/teams/:teamId/members/:memberId/activity-stats', {
    success: ActivityStatsResponse,
    error: [MemberNotFound, Forbidden],
    params: { teamId: TeamId, memberId: TeamMemberId },
  }).middleware(AuthMiddleware),
) {}
