import { type Auth, type Team, WeeklySummary, WeeklySummaryApi } from '@sideline/domain';
import { DateTime, Effect, Option } from 'effect';
import { hasPermission, requireMembership } from '~/api/permissions.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { WeeklySummaryRepository } from '~/repositories/WeeklySummaryRepository.js';
import { buildPlayerSummary, buildTeamSummary } from '~/services/WeeklySummaryService.js';

// ---------------------------------------------------------------------------
// ISO week parsing: "2026-W02" → WeekRange
// ---------------------------------------------------------------------------

const parseIsoWeek = (weekStr: string): WeeklySummary.WeekRange | null => {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekStr);
  if (!match) return null;
  const year = parseInt(match[1]!, 10);
  const week = parseInt(match[2]!, 10);
  if (week < 1 || week > 53) return null;

  // Find the Monday of the given ISO week.
  // Jan 4 is always in week 1. Find the first Monday on or before Jan 4 for the given year.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const week1Monday = new Date(jan4.getTime() - (jan4Dow - 1) * 86400000);

  const mondayMs = week1Monday.getTime() + (week - 1) * 7 * 86400000;
  const sundayMs = mondayMs + 6 * 86400000 + 23 * 3600000 + 59 * 60000 + 59 * 1000 + 999;

  return new WeeklySummary.WeekRange({
    startAt: DateTime.makeUnsafe(mondayMs),
    endAt: DateTime.makeUnsafe(sundayMs),
    isoYear: year,
    isoWeek: week,
  });
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export type GetWeeklySummaryInput = {
  readonly teamId: Team.TeamId;
  readonly currentUserId: Auth.UserId;
  readonly week: Option.Option<string>;
  readonly includeTeam: Option.Option<boolean>;
};

export const getWeeklySummaryHandler = (
  input: GetWeeklySummaryInput,
): Effect.Effect<
  WeeklySummary.WeeklySummaryResponse,
  WeeklySummaryApi.WeeklySummaryForbidden | WeeklySummaryApi.WeeklySummaryNotFound,
  TeamMembersRepository | WeeklySummaryRepository | TeamSettingsRepository
> => {
  const { teamId, currentUserId, week, includeTeam } = input;

  return Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('summaryRepo', () => WeeklySummaryRepository.asEffect()),
    Effect.bind('settingsRepo', () => TeamSettingsRepository.asEffect()),
    Effect.bind('membership', ({ members }) =>
      requireMembership(
        members,
        teamId,
        currentUserId,
        new WeeklySummaryApi.WeeklySummaryForbidden(),
      ),
    ),
    // Resolve team timezone from settings (default to 'Europe/Prague')
    Effect.bind('timezone', ({ settingsRepo }) =>
      settingsRepo.findByTeamId(teamId).pipe(
        Effect.map((settings) =>
          Option.match(settings, {
            onNone: () => 'Europe/Prague',
            onSome: (s) => s.timezone,
          }),
        ),
      ),
    ),
    Effect.bind('weekRange', ({ timezone }) => {
      if (Option.isNone(week)) {
        const now = DateTime.nowUnsafe();
        return Effect.succeed(WeeklySummary.weekRangeFor(now, timezone));
      }
      const parsed = parseIsoWeek(week.value);
      if (parsed === null) {
        return Effect.fail(new WeeklySummaryApi.WeeklySummaryNotFound());
      }
      return Effect.succeed(parsed);
    }),
    Effect.bind('prevWeekRange', ({ weekRange, timezone }) =>
      Effect.succeed(WeeklySummary.previousWeekRange(weekRange, timezone)),
    ),
    Effect.bind('playerSummary', ({ membership, summaryRepo, weekRange, prevWeekRange }) =>
      Effect.Do.pipe(
        Effect.bind('weekRows', () =>
          summaryRepo.findPlayerWeekActivity(
            teamId,
            membership.id,
            weekRange.startAt,
            weekRange.endAt,
          ),
        ),
        Effect.bind('prevRows', () =>
          summaryRepo.findPlayerWeekActivity(
            teamId,
            membership.id,
            prevWeekRange.startAt,
            prevWeekRange.endAt,
          ),
        ),
        Effect.bind('allTimeRows', () => summaryRepo.findAllTimeLogsForMember(membership.id)),
        Effect.bind('newAchievements', () =>
          summaryRepo.findNewAchievementsInRange(teamId, weekRange.startAt, weekRange.endAt),
        ),
        Effect.flatMap(({ weekRows, prevRows, allTimeRows, newAchievements }) =>
          buildPlayerSummary({
            memberId: membership.id,
            weekStart: weekRange.startAt,
            weekEnd: weekRange.endAt,
            weekRows,
            previousWeekRows: prevRows,
            allTimeRows,
            newAchievements,
          }),
        ),
      ),
    ),
    Effect.bind('teamSummary', ({ membership, members, summaryRepo, weekRange, prevWeekRange }) => {
      const canSeeTeam =
        Option.getOrElse(includeTeam, () => false) && hasPermission(membership, 'roster:manage');

      if (!canSeeTeam) {
        return Effect.succeed(null);
      }

      return Effect.Do.pipe(
        Effect.bind('teamMembers', () =>
          members
            .findByTeam(teamId)
            .pipe(Effect.map((rows) => rows.map((m) => ({ id: m.id, displayName: String(m.id) })))),
        ),
        Effect.bind('teamWeekRows', () =>
          summaryRepo.findTeamWeekActivity(teamId, weekRange.startAt, weekRange.endAt),
        ),
        Effect.bind('teamPrevRows', () =>
          summaryRepo.findTeamWeekActivity(teamId, prevWeekRange.startAt, prevWeekRange.endAt),
        ),
        Effect.bind('achievementsCount', () =>
          summaryRepo.findTeamNewAchievementCountInRange(
            teamId,
            weekRange.startAt,
            weekRange.endAt,
          ),
        ),
        Effect.flatMap(({ teamMembers, teamWeekRows, teamPrevRows, achievementsCount }) =>
          buildTeamSummary({
            weekStart: weekRange.startAt,
            weekEnd: weekRange.endAt,
            weekRows: teamWeekRows,
            previousWeekRows: teamPrevRows,
            members: teamMembers,
            newAchievementsCount: achievementsCount,
          }),
        ),
        Effect.map((s): WeeklySummary.TeamWeeklySummary | null => s),
      );
    }),
    Effect.map(
      ({ weekRange, playerSummary, teamSummary }) =>
        new WeeklySummary.WeeklySummaryResponse({
          week: weekRange,
          player: playerSummary,
          team: teamSummary,
        }),
    ),
  );
};
