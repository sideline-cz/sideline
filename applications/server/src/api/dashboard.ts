import { ActivityStats, Auth, DashboardApi, type GroupModel, Leaderboard } from '@sideline/domain';
import { Array, DateTime, Effect, Option, pipe } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership } from '~/api/permissions.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { LeaderboardRepository } from '~/repositories/LeaderboardRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { projectRsvpResponseToLegacy } from '~/utils/rsvpWireProjection.js';

const forbidden = new DashboardApi.Forbidden();
const allTimeframe: Leaderboard.LeaderboardTimeframe = 'all';

export const DashboardApiLive = HttpApiBuilder.group(Api, 'dashboard', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('events', () => EventsRepository.asEffect()),
    Effect.bind('groups', () => GroupsRepository.asEffect()),
    Effect.bind('leaderboardRepo', () => LeaderboardRepository.asEffect()),
    Effect.bind('activityLogs', () => ActivityLogsRepository.asEffect()),
    Effect.map(({ members, events, groups, leaderboardRepo, activityLogs }) =>
      handlers.handle('getDashboard', ({ params: { teamId } }) =>
        Effect.Do.pipe(
          Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
          Effect.bind('membership', ({ currentUser }) =>
            requireMembership(members, teamId, currentUser.id, forbidden),
          ),
          // Fetch all upcoming events with user's RSVP status
          Effect.bind('allUpcoming', ({ membership }) =>
            events.findUpcomingWithRsvp(teamId, membership.id),
          ),
          // Filter events by group access (with caching to avoid N+1)
          Effect.bind('filteredEvents', ({ allUpcoming, membership }) => {
            const groupCache = new Map<GroupModel.GroupId, boolean>();
            return Effect.filter(allUpcoming, (event) => {
              if (Option.isNone(event.member_group_id)) return Effect.succeed(true);
              const gid = event.member_group_id.value;
              const cached = groupCache.get(gid);
              if (cached !== undefined) return Effect.succeed(cached);
              return groups.getDescendantMemberIds(gid).pipe(
                Effect.map((memberIds) => {
                  const result = pipe(memberIds, Array.contains(membership.id));
                  groupCache.set(gid, result);
                  return result;
                }),
              );
            });
          }),
          // Fetch leaderboard data and activity stats in parallel
          Effect.bind('leaderboardAndStats', ({ membership }) =>
            Effect.all({
              leaderboardRows: leaderboardRepo.getLeaderboard(teamId, Option.none(), allTimeframe),
              activityRows: activityLogs.findByTeamMember(membership.id),
            }),
          ),
          // Build the response
          Effect.map(({ filteredEvents, membership, leaderboardAndStats }) => {
            const { leaderboardRows, activityRows } = leaderboardAndStats;
            const today = ActivityStats.todayInPrague();

            // Calculate time boundaries
            const now = new Date();
            const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
            const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

            const toEvent = (
              e: (typeof filteredEvents)[number],
            ): DashboardApi.DashboardUpcomingEvent =>
              new DashboardApi.DashboardUpcomingEvent({
                eventId: e.id,
                title: e.title,
                eventType: e.event_type,
                startAt: e.start_at,
                endAt: e.end_at,
                location: e.location,
                locationUrl: e.location_url,
                myRsvp: Option.map(e.my_rsvp, projectRsvpResponseToLegacy),
              });

            const toEpochMs = (dt: DateTime.Utc) => Number(DateTime.toEpochMillis(dt));

            // Upcoming events: next 7 days
            const sevenDaysMs = sevenDaysFromNow.getTime();
            const upcomingEvents = pipe(
              filteredEvents,
              Array.filter((e) => toEpochMs(e.start_at) <= sevenDaysMs),
              Array.take(10),
              Array.map(toEvent),
            );

            // Awaiting RSVP: next 30 days with no response
            const thirtyDaysMs = thirtyDaysFromNow.getTime();
            const awaitingRsvp = pipe(
              filteredEvents,
              Array.filter(
                (e) => Option.isNone(e.my_rsvp) && toEpochMs(e.start_at) <= thirtyDaysMs,
              ),
              Array.take(10),
              Array.map(toEvent),
            );

            // Calculate activity stats
            const stats = ActivityStats.calculateStats(activityRows, today);

            // Calculate recent activity count (last 7 days)
            // NOTE: Uses Europe/Prague timezone to match activity_logs query which
            // stores logged_at_date in Prague TZ. A system-wide timezone refactor
            // would be needed to support per-user timezones.
            const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            const parts = new Intl.DateTimeFormat('en-CA', {
              timeZone: 'Europe/Prague',
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
            }).formatToParts(sevenDaysAgo);
            const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
            const sevenDaysAgoDate = `${get('year')}-${get('month')}-${get('day')}`;
            const recentActivityCount = pipe(
              activityRows,
              Array.filter((r) => r.logged_at_date >= sevenDaysAgoDate),
              Array.length,
            );

            // Calculate leaderboard rank
            const memberData = pipe(
              leaderboardRows,
              Array.map((row) => {
                const streaks = ActivityStats.calculateStreaks(row.activity_dates, today);
                return {
                  teamMemberId: row.team_member_id,
                  userId: row.user_id,
                  username: row.username,
                  totalActivities: row.total_activities,
                  totalDurationMinutes: row.total_duration_minutes,
                  currentStreak: streaks.currentStreak,
                  longestStreak: streaks.longestStreak,
                };
              }),
            );

            const ranked = Leaderboard.rankLeaderboard(memberData);
            const myRank = pipe(
              ranked,
              Array.findFirst((r) => r.teamMemberId === membership.id),
            );

            const activitySummary = new DashboardApi.DashboardActivitySummary({
              currentStreak: stats.currentStreak,
              longestStreak: stats.longestStreak,
              totalActivities: stats.totalActivities,
              totalDurationMinutes: stats.totalDurationMinutes,
              leaderboardRank: Option.map(myRank, (r) => r.rank),
              leaderboardTotal: ranked.length,
              recentActivityCount,
            });

            return new DashboardApi.DashboardResponse({
              upcomingEvents,
              awaitingRsvp,
              activitySummary,
              myMemberId: membership.id,
            });
          }),
        ),
      ),
    ),
  ),
);
