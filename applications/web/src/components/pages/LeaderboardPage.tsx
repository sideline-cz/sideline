import type { LeaderboardApi } from '@sideline/domain';
import { tr } from '~/lib/translations.js';

interface LeaderboardPageProps {
  entries: ReadonlyArray<LeaderboardApi.LeaderboardEntry>;
  currentUserId: string;
}

const formatDuration = (minutes: number): string => {
  if (minutes === 0) return '0m';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
};

interface RankBadgeProps {
  rank: number;
}

function RankBadge({ rank }: RankBadgeProps) {
  if (rank === 1) {
    return (
      <div className='flex size-8 shrink-0 items-center justify-center rounded-full bg-yellow-400 text-yellow-900 font-bold text-sm dark:bg-yellow-500 dark:text-yellow-950'>
        1
      </div>
    );
  }
  if (rank === 2) {
    return (
      <div className='flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-300 text-slate-700 font-bold text-sm dark:bg-slate-400 dark:text-slate-900'>
        2
      </div>
    );
  }
  if (rank === 3) {
    return (
      <div className='flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-600 text-amber-50 font-bold text-sm dark:bg-amber-700'>
        3
      </div>
    );
  }
  return (
    <div className='flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground font-medium text-sm'>
      {rank}
    </div>
  );
}

export function LeaderboardPage({ entries, currentUserId }: LeaderboardPageProps) {
  if (entries.length === 0) {
    return (
      <div>
        <h1 className='text-2xl font-bold mb-6'>{tr('leaderboard_title')}</h1>
        <p className='text-muted-foreground'>{tr('leaderboard_empty')}</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className='text-2xl font-bold mb-6'>{tr('leaderboard_title')}</h1>

      <div className='flex flex-col gap-2'>
        {entries.map((entry) => {
          const isCurrentUser = entry.userId === currentUserId;
          return (
            <div
              key={entry.teamMemberId}
              className={`flex items-center gap-3 rounded-lg border p-3 ${
                isCurrentUser
                  ? 'border-primary/40 bg-primary/5 dark:border-primary/30 dark:bg-primary/10'
                  : 'border-border bg-card'
              }`}
            >
              <RankBadge rank={entry.rank} />
              <div className='flex-1 min-w-0'>
                <p
                  className={`text-sm truncate ${isCurrentUser ? 'font-semibold' : 'font-medium'}`}
                >
                  {entry.username}
                </p>
                <p className='text-xs text-muted-foreground'>
                  {entry.totalActivities} {tr('leaderboard_activities')} ·{' '}
                  {formatDuration(entry.totalDurationMinutes)}
                </p>
              </div>
              <div className='text-right shrink-0'>
                <p className='text-sm font-medium'>{entry.currentStreak}d</p>
                <p className='text-xs text-muted-foreground'>{tr('leaderboard_currentStreak')}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
