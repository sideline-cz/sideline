import type { ActivityStatsApi } from '@sideline/domain';
import { Activity } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { tr } from '~/lib/translations.js';

interface ActivityStatsCardProps {
  stats: ActivityStatsApi.ActivityStatsResponse;
  isOwnProfile?: boolean;
  onLogActivity?: () => void;
  // Past season or Earlier: a streak that ended is not "current"
  hideCurrentStreak?: boolean;
}

const formatDuration = (minutes: number): string => {
  if (minutes === 0) return '0m';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
};

export function ActivityStatsCard({
  stats,
  isOwnProfile,
  onLogActivity,
  hideCurrentStreak = false,
}: ActivityStatsCardProps) {
  const isEmpty = stats.totalActivities === 0;

  if (isEmpty) {
    return (
      <div className='flex flex-col items-center justify-center gap-2 py-10 text-center'>
        <Activity className='size-8 text-muted-foreground' aria-hidden='true' />
        <p className='font-medium'>{tr('stats_empty_title')}</p>
        <p className='text-sm text-muted-foreground'>{tr('stats_empty')}</p>
        {isOwnProfile ? (
          <Button type='button' size='sm' className='mt-2' onClick={onLogActivity}>
            {tr('stats_activityEmptyCta')}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <div className='grid grid-cols-2 gap-4 mb-6'>
        <div>
          <p className='text-3xl font-bold'>🔥 {hideCurrentStreak ? '—' : stats.currentStreak}</p>
          <p className='text-sm text-muted-foreground'>{tr('stats_currentStreak')}</p>
        </div>
        <div>
          <p className='text-3xl font-bold'>🏆 {stats.longestStreak}</p>
          <p className='text-sm text-muted-foreground'>{tr('stats_longestStreak')}</p>
        </div>
      </div>
      <div className='grid grid-cols-2 gap-4 mb-6'>
        <div>
          <p className='text-xl font-semibold'>{stats.totalActivities}</p>
          <p className='text-sm text-muted-foreground'>{tr('stats_totalActivities')}</p>
        </div>
        <div>
          <p className='text-xl font-semibold'>{formatDuration(stats.totalDurationMinutes)}</p>
          <p className='text-sm text-muted-foreground'>{tr('stats_totalDuration')}</p>
        </div>
      </div>
      <div className='flex flex-col gap-2'>
        {stats.counts.map((c) => (
          <div key={c.activityTypeId} className='flex justify-between items-center'>
            <span className='text-sm'>{c.activityTypeName}</span>
            <span className='font-semibold'>{c.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
