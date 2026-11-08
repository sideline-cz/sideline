import type { ActivityLogApi, ActivityStatsApi } from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import {
  isNonCurrentSelection,
  SeasonInfoLine,
  SeasonPicker,
  seasonRangeLabel,
} from '~/components/molecules/SeasonPicker.js';
import { AchievementsGridI18n } from '~/components/organisms/AchievementsGrid.js';
import { ActivityLogList } from '~/components/organisms/ActivityLogList.js';
import { ActivityStatsCard } from '~/components/organisms/ActivityStatsCard.js';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { tr } from '~/lib/translations.js';

interface WorkoutMemberPageProps {
  teamId: string;
  displayName: string;
  stats: ActivityStatsApi.ActivityStatsResponse;
  logs: ReadonlyArray<ActivityLogApi.ActivityLogEntry>;
  seasons: ReadonlyArray<ActivityLogApi.ActivitySeason>;
  logsError: boolean;
  onRetry: () => void;
  season: string | undefined;
  onSeasonChange: (season: string | undefined) => void;
  isPending?: boolean;
}

const noop = async () => {};

// Read-only workout view of one member; writes stay on the member's own /workout page
export function WorkoutMemberPage({
  teamId,
  displayName,
  stats,
  logs,
  seasons,
  logsError,
  onRetry,
  season,
  onSeasonChange,
  isPending = false,
}: WorkoutMemberPageProps) {
  const isPastPeriod = isNonCurrentSelection(seasons, season);
  const rangeLabel = seasonRangeLabel(seasons, season);
  const busy = isPending ? 'opacity-60 pointer-events-none transition-opacity' : undefined;

  return (
    <div className='flex flex-col gap-6'>
      <header>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId/workout' params={{ teamId }}>
            ← {tr('makanicko_matrix_back')}
          </Link>
        </Button>
        <div className='flex flex-wrap items-center gap-3'>
          <h1 className='text-2xl font-bold mr-auto'>{displayName}</h1>
          {seasons.length > 0 ? (
            <SeasonPicker seasons={seasons} value={season} onChange={onSeasonChange} />
          ) : null}
        </div>
      </header>

      <div className={`grid gap-6 lg:grid-cols-[1fr_1.4fr] lg:items-start ${busy ?? ''}`}>
        <div className='flex flex-col gap-6'>
          <Card>
            <CardHeader>
              <CardTitle>{tr('stats_title')}</CardTitle>
            </CardHeader>
            <CardContent className='flex flex-col gap-4'>
              <SeasonInfoLine seasons={seasons} value={season} />
              <ActivityStatsCard stats={stats} hideCurrentStreak={isPastPeriod} />
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <AchievementsGridI18n
                earnedAchievements={stats.achievements.map((a) => ({
                  achievement_slug: a.slug,
                  earned_at: new Date(a.earned_at),
                }))}
                emptyTitle={tr('achievements_empty_title')}
                emptyDescription={tr('achievements_empty_description')}
              />
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{tr('activityLog_title')}</CardTitle>
            <CardDescription>
              {rangeLabel !== undefined
                ? `${tr('activitySeason_showing', { range: rangeLabel })} `
                : null}
              {tr('activityLog_notesPrivate', { name: displayName })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActivityLogList
              logs={logs}
              isOwnProfile={false}
              isPastPeriod={isPastPeriod}
              loadError={logsError}
              onRetry={onRetry}
              activityTypes={[]}
              onCreateLog={noop}
              onUpdateLog={noop}
              onDeleteLog={noop}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
