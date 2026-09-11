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
  /**
   * Plan §16 PR 5 / §11.3. `false` is a safe, meaningful default for an old server that
   * hasn't shipped the key yet — unlike `startDate`, there is no silent-failure sentinel
   * risk here, so `withDecodingDefaultKey` (not `OptionFromOptionalKey`) is correct.
   */
  allDay: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(() => false)),
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
  /**
   * Team-local "today" (`YYYY-MM-DD`), plan §11.5(c). The web has no timezone of its
   * own, so it cannot compute the operand `event.startDate` needs to be compared
   * against for the "Dnes"/"Zítra" label; the server computes it once per request.
   * `Option.none()` means an old server hasn't shipped the key yet — the reader then
   * falls back to the browser's local date (today's behaviour), never a crash.
   */
  todayLocalDate: Schema.OptionFromOptionalKey(Schema.String),
}) {}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()('DashboardForbidden', {}) {}

export class DashboardApiGroup extends HttpApiGroup.make('dashboard').add(
  HttpApiEndpoint.get('getDashboard', '/teams/:teamId/dashboard', {
    success: DashboardResponse,
    error: Forbidden,
    params: { teamId: TeamId },
  }).middleware(AuthMiddleware),
) {}
