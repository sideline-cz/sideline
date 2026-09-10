import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { EventId, EventType } from '~/models/Event.js';
import { RsvpResponse } from '~/models/EventRsvp.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export class DashboardUpcomingEvent extends Schema.Class<DashboardUpcomingEvent>(
  'DashboardUpcomingEvent',
)({
  eventId: EventId,
  title: Schema.String,
  eventType: EventType,
  startAt: Schemas.DateTimeFromIsoString,
  endAt: Schema.OptionFromOptional(Schemas.DateTimeFromIsoString),
  location: Schema.OptionFromOptional(Schema.String),
  locationUrl: Schema.OptionFromOptional(Schema.String),
  myRsvp: Schema.OptionFromOptional(RsvpResponse),
  /**
   * Derived team-local calendar date (`YYYY-MM-DD`), plan §11.2/§11.3. `Option.none()`
   * means the key was absent (old-server skew) and the reader falls back to
   * `formatUtcDate(startAt)`. Deliberately `OptionFromOptionalKey`, never a plain string
   * defaulted to `''` — see `EventApi.EventInfo.startDate`'s doc comment.
   */
  startDate: Schema.OptionFromOptionalKey(Schema.String),
}) {}

export class DashboardActivitySummary extends Schema.Class<DashboardActivitySummary>(
  'DashboardActivitySummary',
)({
  currentStreak: Schema.Int,
  longestStreak: Schema.Int,
  totalActivities: Schema.Int,
  totalDurationMinutes: Schema.Int,
  leaderboardRank: Schema.OptionFromOptional(Schema.Int),
  leaderboardTotal: Schema.Int,
  recentActivityCount: Schema.Int,
}) {}

export class DashboardResponse extends Schema.Class<DashboardResponse>('DashboardResponse')({
  upcomingEvents: Schema.Array(DashboardUpcomingEvent),
  awaitingRsvp: Schema.Array(DashboardUpcomingEvent),
  activitySummary: DashboardActivitySummary,
  myMemberId: TeamMemberId,
}) {}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()('DashboardForbidden', {}) {}

export class DashboardApiGroup extends HttpApiGroup.make('dashboard').add(
  HttpApiEndpoint.get('getDashboard', '/teams/:teamId/dashboard', {
    success: DashboardResponse,
    error: Forbidden,
    params: { teamId: TeamId },
  }).middleware(AuthMiddleware),
) {}
