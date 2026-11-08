import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { ActivitySeasonFilter } from '~/models/ActivityLog.js';
import { ActivityTypeId } from '~/models/ActivityType.js';
import { LeaderboardTimeframe } from '~/models/Leaderboard.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';
import { UserId } from '~/models/User.js';

export class LeaderboardEntry extends Schema.Class<LeaderboardEntry>('LeaderboardEntry')({
  rank: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  teamMemberId: TeamMemberId,
  userId: UserId,
  username: Schema.String,
  name: Schema.OptionFromOptional(Schema.String),
  avatar: Schema.OptionFromOptional(Schema.String),
  totalActivities: Schema.Int,
  totalDurationMinutes: Schema.Int,
  currentStreak: Schema.Int,
  longestStreak: Schema.Int,
  /** Resolved display name (profile name → Discord nickname → Discord display name → username). */
  displayName: Schema.String,
}) {}

export class LeaderboardResponse extends Schema.Class<LeaderboardResponse>('LeaderboardResponse')({
  entries: Schema.Array(LeaderboardEntry),
}) {}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()('LeaderboardForbidden', {}) {}

export class LeaderboardApiGroup extends HttpApiGroup.make('leaderboard').add(
  HttpApiEndpoint.get('getLeaderboard', '/teams/:teamId/leaderboard', {
    success: LeaderboardResponse,
    error: Forbidden,
    params: { teamId: TeamId },
    query: {
      timeframe: Schema.OptionFromOptional(LeaderboardTimeframe),
      // Used only when timeframe is absent; absent too = current season
      season: Schema.OptionFromOptional(ActivitySeasonFilter),
      activityTypeId: Schema.OptionFromOptional(ActivityTypeId),
    },
  }).middleware(AuthMiddleware),
) {}
