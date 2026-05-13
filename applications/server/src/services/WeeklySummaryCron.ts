import { WeeklySummary } from '@sideline/domain';
import { Array, Data, DateTime, Effect, Option, Schedule, Schema } from 'effect';
import { withCronMetrics } from '~/metrics.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import {
  WeeklySummaryRepository,
  WeeklySummarySyncEventsRepository,
} from '~/repositories/WeeklySummaryRepository.js';
import { buildTeamSummary } from '~/services/WeeklySummaryService.js';

// ---------------------------------------------------------------------------
// Internal skip error (used for short-circuit filtering, never propagated)
// ---------------------------------------------------------------------------

class SkipTeam extends Data.TaggedError('SkipTeam')<{ readonly reason: string }> {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the given UTC timestamp is on a Sunday between 20:00:00 and
 * 20:00:59 in the given IANA timezone.
 */
const isSunday20InTimezone = (nowMs: number, timezone: string): boolean => {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date(nowMs));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const weekday = get('weekday'); // "Sun"
    const hour = parseInt(get('hour'), 10);
    const minute = parseInt(get('minute'), 10);
    const second = parseInt(get('second'), 10);
    return weekday === 'Sun' && hour === 20 && minute === 0 && second <= 59;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Cron effect (exported for testing)
// ---------------------------------------------------------------------------

export const weeklySummaryCronEffect = Effect.Do.pipe(
  Effect.bind('settingsRepo', () => TeamSettingsRepository.asEffect()),
  Effect.bind('summaryRepo', () => WeeklySummaryRepository.asEffect()),
  Effect.bind('syncEventsRepo', () => WeeklySummarySyncEventsRepository.asEffect()),
  Effect.bind('membersRepo', () => TeamMembersRepository.asEffect()),
  Effect.bind('now', () => DateTime.now),
  Effect.tap(() => Effect.logInfo('WeeklySummaryCron: starting cycle')),
  Effect.bind('teams', ({ settingsRepo }) => settingsRepo.findAllWithWeeklySummaryChannel()),
  Effect.tap(({ teams, now, summaryRepo, syncEventsRepo, membersRepo }) =>
    Effect.all(
      Array.map(teams, (team) =>
        Effect.Do.pipe(
          // Filter: must have a channel configured
          Effect.tap(() =>
            Option.isNone(team.weekly_summary_channel_id)
              ? Effect.fail(new SkipTeam({ reason: 'no channel' }))
              : Effect.void,
          ),
          // Filter: must be Sunday 20:00 in team timezone
          Effect.tap(() =>
            isSunday20InTimezone(now.epochMilliseconds, team.timezone)
              ? Effect.void
              : Effect.fail(new SkipTeam({ reason: 'not Sunday 20:00' })),
          ),
          Effect.bind('channelId', () =>
            Option.match(team.weekly_summary_channel_id, {
              onNone: () => Effect.fail(new SkipTeam({ reason: 'no channel (match)' })),
              onSome: (id) => Effect.succeed(id),
            }),
          ),
          // Compute the current week (Mon through this Sunday at 20:00 local time)
          Effect.let('currentWeek', () => WeeklySummary.weekRangeFor(now, team.timezone)),
          Effect.let('prevWeek', ({ currentWeek }) =>
            WeeklySummary.previousWeekRange(currentWeek, team.timezone),
          ),
          // Fetch team members for topContributors / activeMemberCount
          Effect.bind('members', () =>
            membersRepo
              .findByTeam(team.team_id)
              .pipe(
                Effect.map((rows) => rows.map((m) => ({ id: m.id, displayName: String(m.id) }))),
              ),
          ),
          // Fetch this week's activity rows for team
          Effect.bind('weekRows', ({ currentWeek }) =>
            summaryRepo.findTeamWeekActivity(team.team_id, currentWeek.startAt, currentWeek.endAt),
          ),
          // Fetch previous week's activity rows
          Effect.bind('prevRows', ({ prevWeek }) =>
            summaryRepo.findTeamWeekActivity(team.team_id, prevWeek.startAt, prevWeek.endAt),
          ),
          // Fetch new achievement count for the week
          Effect.bind('achievementsCount', ({ currentWeek }) =>
            summaryRepo.findTeamNewAchievementCountInRange(
              team.team_id,
              currentWeek.startAt,
              currentWeek.endAt,
            ),
          ),
          // Build the team summary
          Effect.bind(
            'teamSummary',
            ({ currentWeek, weekRows, prevRows, members, achievementsCount }) =>
              buildTeamSummary({
                weekStart: currentWeek.startAt,
                weekEnd: currentWeek.endAt,
                weekRows,
                previousWeekRows: prevRows,
                members,
                newAchievementsCount: achievementsCount,
              }),
          ),
          // Encode the digest
          Effect.bind('digest', ({ currentWeek, teamSummary }) =>
            Effect.sync(() =>
              Schema.encodeSync(WeeklySummary.WeeklySummaryDigest)(
                new WeeklySummary.WeeklySummaryDigest({
                  week: currentWeek,
                  teamSummary,
                }),
              ),
            ),
          ),
          // Insert the sync event (ON CONFLICT DO NOTHING handles idempotency at DB layer)
          Effect.tap(({ channelId, currentWeek, digest }) =>
            syncEventsRepo.insert({
              team_id: team.team_id,
              channel_id: channelId,
              week_start: currentWeek.startAt,
              week_end: currentWeek.endAt,
              payload: digest,
            }),
          ),
          Effect.tap(({ currentWeek }) =>
            Effect.logInfo(
              `WeeklySummaryCron: queued summary for team ${team.team_id} week ${currentWeek.isoYear}-W${String(currentWeek.isoWeek).padStart(2, '0')}`,
            ),
          ),
          // Catch SkipTeam silently — it's just a filter, not an error
          Effect.catchTag('SkipTeam', () => Effect.void),
          Effect.exit,
        ),
      ),
      { concurrency: 1 },
    ),
  ),
  Effect.tap(({ teams }) =>
    Effect.logInfo(`WeeklySummaryCron: cycle complete, ${String(teams.length)} team(s) checked`),
  ),
  Effect.asVoid,
  withCronMetrics('weekly-summary'),
);

// ---------------------------------------------------------------------------
// Cron registration
// ---------------------------------------------------------------------------

const cronSchedule = Schedule.cron('* * * * *');

export const WeeklySummaryCron = weeklySummaryCronEffect.pipe(
  Effect.repeat(cronSchedule),
  Effect.asVoid,
);
