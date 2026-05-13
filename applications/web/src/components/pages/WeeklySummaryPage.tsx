import type { WeeklySummary } from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import type { DateTime } from 'effect';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert.js';
import { Button } from '~/components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card.js';

interface WeeklySummaryPageProps {
  summary: WeeklySummary.WeeklySummaryResponse;
  teamId: string;
  canViewTeam: boolean;
  currentWeek: string;
}

const formatDuration = (minutes: number): string => {
  if (minutes === 0) return '0m';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
};

const formatWeekDate = (dt: DateTime.Utc): string => {
  const date = new Date(dt.epochMilliseconds);
  return date.toLocaleDateString('en', { month: 'short', day: 'numeric' });
};

const parseWeekParam = (week: string): { year: number; week: number } | null => {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!match) return null;
  return { year: Number(match[1]), week: Number(match[2]) };
};

const isoWeekToString = (year: number, week: number): string =>
  `${year}-W${String(week).padStart(2, '0')}`;

/**
 * Returns the number of ISO weeks in a given year.
 * A year has 53 weeks if Jan 1 is Thursday, or if it is a leap year and Jan 1 is Wednesday.
 * Equivalently: Dec 28 is always in the last ISO week of the year.
 */
const isoWeeksInYear = (year: number): number => {
  const dec28 = new Date(Date.UTC(year, 11, 28));
  const dow = dec28.getUTCDay() === 0 ? 7 : dec28.getUTCDay();
  const thursday = new Date(dec28.getTime() + (4 - dow) * 86400000);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  return Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
};

const prevWeekParam = (week: string): string => {
  const parsed = parseWeekParam(week);
  if (!parsed) return week;
  const { year, week: w } = parsed;
  if (w <= 1) return isoWeekToString(year - 1, isoWeeksInYear(year - 1));
  return isoWeekToString(year, w - 1);
};

const nextWeekParam = (week: string): string => {
  const parsed = parseWeekParam(week);
  if (!parsed) return week;
  const { year, week: w } = parsed;
  if (w >= isoWeeksInYear(year)) return isoWeekToString(year + 1, 1);
  return isoWeekToString(year, w + 1);
};

const deltaLabel = (current: number, previous: number): string => {
  const diff = current - previous;
  if (diff === 0) return '= same as last week';
  if (diff > 0) return `+${diff} vs last week`;
  return `${diff} vs last week`;
};

const activityTypeEmoji = (name: string): string => {
  const lower = name.toLowerCase();
  if (lower.includes('run')) return '🏃';
  if (lower.includes('gym') || lower.includes('strength')) return '🏋️';
  if (lower.includes('stretch') || lower.includes('yoga')) return '🧘';
  if (lower.includes('swim')) return '🏊';
  if (lower.includes('cycle') || lower.includes('bike')) return '🚴';
  if (lower.includes('hike') || lower.includes('walk')) return '🥾';
  return '⚡';
};

export function WeeklySummaryPage({
  summary,
  teamId,
  canViewTeam,
  currentWeek,
}: WeeklySummaryPageProps) {
  const { week, player, team } = summary;
  const weekLabel = `Week of ${formatWeekDate(week.startAt)} – ${formatWeekDate(week.endAt)}`;

  return (
    <div className='flex flex-col gap-6'>
      <header className='flex flex-col gap-2'>
        <Button asChild variant='ghost' size='sm' className='self-start'>
          <Link to='/teams/$teamId/workout' params={{ teamId }}>
            ← Back to Workout
          </Link>
        </Button>
        <div className='flex items-center gap-3'>
          <Button asChild variant='outline' size='icon-sm' aria-label='Previous week'>
            <Link
              to='/teams/$teamId/workout/weekly'
              params={{ teamId }}
              search={{ week: prevWeekParam(currentWeek), includeTeam: canViewTeam }}
            >
              ←
            </Link>
          </Button>
          <h1 className='text-2xl font-bold'>{weekLabel}</h1>
          <Button asChild variant='outline' size='icon-sm' aria-label='Next week'>
            <Link
              to='/teams/$teamId/workout/weekly'
              params={{ teamId }}
              search={{ week: nextWeekParam(currentWeek), includeTeam: canViewTeam }}
            >
              →
            </Link>
          </Button>
        </div>
        <p className='text-sm text-muted-foreground'>
          ISO Week {week.isoWeek}, {week.isoYear}
        </p>
      </header>

      {player === null ? (
        <Alert>
          <AlertTitle>Not a team member</AlertTitle>
          <AlertDescription>You are not on this team.</AlertDescription>
        </Alert>
      ) : (
        <div className='flex flex-col gap-6'>
          {/* Your week card */}
          {player.totalActivities === 0 ? (
            <Alert>
              <AlertTitle>No activities this week</AlertTitle>
              <AlertDescription>
                You did not log any activities this week. Keep going — every workout counts!
              </AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Your Week</CardTitle>
            </CardHeader>
            <CardContent>
              <div className='grid grid-cols-2 gap-4 sm:grid-cols-4'>
                <div className='flex flex-col gap-1'>
                  <span className='text-xs text-muted-foreground uppercase tracking-wide'>
                    Current Streak
                  </span>
                  <span className='text-2xl font-bold'>{player.currentStreak}d</span>
                </div>
                <div className='flex flex-col gap-1'>
                  <span className='text-xs text-muted-foreground uppercase tracking-wide'>
                    Activities
                  </span>
                  <span className='text-2xl font-bold'>{player.totalActivities}</span>
                  <span className='text-xs text-muted-foreground'>
                    {deltaLabel(player.totalActivities, player.previousWeekActivities)}
                  </span>
                </div>
                <div className='flex flex-col gap-1'>
                  <span className='text-xs text-muted-foreground uppercase tracking-wide'>
                    Total Duration
                  </span>
                  <span className='text-2xl font-bold'>
                    {formatDuration(player.totalDurationMinutes)}
                  </span>
                </div>
                <div className='flex flex-col gap-1'>
                  <span className='text-xs text-muted-foreground uppercase tracking-wide'>
                    Longest Streak
                  </span>
                  <span className='text-2xl font-bold'>{player.longestStreak}d</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Breakdown card */}
          {player.activitiesByType.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Breakdown</CardTitle>
              </CardHeader>
              <CardContent>
                <div className='flex flex-col gap-2'>
                  {player.activitiesByType.map((item) => (
                    <div
                      key={item.activityTypeId}
                      className='flex items-center justify-between rounded-lg border px-4 py-2'
                    >
                      <span className='flex items-center gap-2'>
                        <span>{activityTypeEmoji(item.activityTypeName)}</span>
                        <span className='font-medium'>{item.activityTypeName}</span>
                      </span>
                      <span className='text-sm font-semibold'>
                        {item.count} {item.count === 1 ? 'activity' : 'activities'}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}

          {/* Achievements card */}
          <Card>
            <CardHeader>
              <CardTitle>Achievements</CardTitle>
            </CardHeader>
            <CardContent>
              {player.newAchievements.length === 0 ? (
                <p className='text-sm text-muted-foreground'>No new achievements this week.</p>
              ) : (
                <div className='flex flex-col gap-2'>
                  {player.newAchievements.map((achievement) => (
                    <div
                      key={achievement.slug}
                      className='flex items-center gap-3 rounded-lg border px-4 py-2'
                    >
                      <span className='text-xl'>🏆</span>
                      <div className='flex flex-col'>
                        <span className='font-medium'>{achievement.slug}</span>
                        <span className='text-xs text-muted-foreground'>
                          Earned{' '}
                          {new Date(achievement.earnedAt.epochMilliseconds).toLocaleDateString(
                            'en',
                            {
                              month: 'short',
                              day: 'numeric',
                            },
                          )}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Team card */}
      {canViewTeam && team !== null ? (
        team.totalActivities === 0 ? (
          <Alert>
            <AlertTitle>No team activity</AlertTitle>
            <AlertDescription>No team members logged activities this week.</AlertDescription>
          </Alert>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Team This Week</CardTitle>
            </CardHeader>
            <CardContent className='flex flex-col gap-6'>
              <div className='grid grid-cols-2 gap-4 sm:grid-cols-4'>
                <div className='flex flex-col gap-1'>
                  <span className='text-xs text-muted-foreground uppercase tracking-wide'>
                    Team Activities
                  </span>
                  <span className='text-2xl font-bold'>{team.totalActivities}</span>
                  <span className='text-xs text-muted-foreground'>
                    {deltaLabel(team.totalActivities, team.previousWeekActivities)}
                  </span>
                </div>
                <div className='flex flex-col gap-1'>
                  <span className='text-xs text-muted-foreground uppercase tracking-wide'>
                    Total Duration
                  </span>
                  <span className='text-2xl font-bold'>
                    {formatDuration(team.totalDurationMinutes)}
                  </span>
                </div>
                <div className='flex flex-col gap-1'>
                  <span className='text-xs text-muted-foreground uppercase tracking-wide'>
                    Active Members
                  </span>
                  <span className='text-2xl font-bold'>
                    {team.activeMemberCount}
                    <span className='text-base font-normal text-muted-foreground'>
                      /{team.totalMemberCount}
                    </span>
                  </span>
                </div>
                <div className='flex flex-col gap-1'>
                  <span className='text-xs text-muted-foreground uppercase tracking-wide'>
                    New Achievements
                  </span>
                  <span className='text-2xl font-bold'>{team.newAchievementsCount}</span>
                </div>
              </div>

              {team.topContributors.length > 0 ? (
                <div>
                  <p className='text-sm font-semibold mb-2'>Top Contributors</p>
                  <div className='flex flex-col gap-2'>
                    {team.topContributors.map((contributor, index) => (
                      <div
                        key={contributor.teamMemberId}
                        className='flex items-center gap-3 rounded-lg border px-4 py-2'
                      >
                        <div className='flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground font-medium text-sm'>
                          {index + 1}
                        </div>
                        <div className='flex-1 min-w-0'>
                          <p className='text-sm font-medium truncate'>{contributor.displayName}</p>
                          <p className='text-xs text-muted-foreground'>
                            {contributor.totalActivities}{' '}
                            {contributor.totalActivities === 1 ? 'activity' : 'activities'} ·{' '}
                            {formatDuration(contributor.totalDurationMinutes)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        )
      ) : null}
    </div>
  );
}
