import type {
  ActivityLog,
  ActivityLogApi,
  ActivityStatsApi,
  ActivityType,
  LeaderboardApi,
} from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import type { Option } from 'effect';
import {
  isNonCurrentSelection,
  SeasonInfoLine,
  SeasonPicker,
} from '~/components/molecules/SeasonPicker.js';
import { ActivityLogList } from '~/components/organisms/ActivityLogList.js';
import { ActivityStatsCard } from '~/components/organisms/ActivityStatsCard.js';
import { LeaderboardPage } from '~/components/pages/LeaderboardPage.js';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { tr } from '~/lib/translations.js';

interface MakanickoPageProps {
  teamId: string;
  leaderboardEntries: ReadonlyArray<LeaderboardApi.LeaderboardEntry>;
  currentUserId: string;
  activityStats: ActivityStatsApi.ActivityStatsResponse;
  activityLogs: ReadonlyArray<ActivityLogApi.ActivityLogEntry>;
  seasons: ReadonlyArray<ActivityLogApi.ActivitySeason>;
  // `undefined` = default view (current season, or "No active season")
  season: string | undefined;
  onSeasonChange: (season: string | undefined) => void;
  canViewTeamActivity: boolean;
  isPending?: boolean;
  activityTypes: ReadonlyArray<{
    id: ActivityType.ActivityTypeId;
    name: string;
    emoji: Option.Option<string>;
  }>;
  onCreateLog: (input: {
    activityTypeId: ActivityType.ActivityTypeId;
    durationMinutes: Option.Option<number>;
    note: Option.Option<string>;
    loggedAtDate: Option.Option<string>;
  }) => Promise<void>;
  onUpdateLog: (
    logId: ActivityLog.ActivityLogId,
    input: {
      activityTypeId: Option.Option<ActivityType.ActivityTypeId>;
      durationMinutes: Option.Option<Option.Option<number>>;
      note: Option.Option<Option.Option<string>>;
      loggedAtDate: Option.Option<string>;
    },
  ) => Promise<void>;
  onDeleteLog: (logId: ActivityLog.ActivityLogId) => Promise<void>;
}

export function MakanickoPage({
  teamId,
  leaderboardEntries,
  currentUserId,
  activityStats,
  activityLogs,
  seasons,
  season,
  onSeasonChange,
  canViewTeamActivity,
  isPending = false,
  activityTypes,
  onCreateLog,
  onUpdateLog,
  onDeleteLog,
}: MakanickoPageProps) {
  const isPastPeriod = isNonCurrentSelection(seasons, season);
  const busy = isPending ? 'opacity-60 pointer-events-none transition-opacity' : undefined;
  return (
    <div className='flex flex-col gap-6'>
      <header>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId' params={{ teamId }}>
            ← {tr('team_backToTeams')}
          </Link>
        </Button>
        <div className='flex flex-wrap items-center gap-3'>
          <h1 className='text-2xl font-bold mr-auto'>{tr('makanicko_title')}</h1>
          {seasons.length > 0 ? (
            <SeasonPicker seasons={seasons} value={season} onChange={onSeasonChange} />
          ) : null}
          <Button asChild variant='outline' size='sm'>
            <Link to='/teams/$teamId/workout/weekly' params={{ teamId }}>
              {tr('makanicko_weeklyLink')}
            </Link>
          </Button>
          {canViewTeamActivity ? (
            <Button asChild variant='outline' size='sm'>
              <Link to='/teams/$teamId/workout/team' params={{ teamId }}>
                {tr('makanicko_matrix_link')}
              </Link>
            </Button>
          ) : null}
        </div>
        <div className='mt-2'>
          <SeasonInfoLine seasons={seasons} value={season} />
        </div>
      </header>

      <div className='flex flex-col gap-6 lg:grid lg:grid-cols-[1fr_400px]'>
        {/* Left: Activity card */}
        <Card className={busy} aria-busy={isPending}>
          <CardHeader>
            <CardTitle>{tr('makanicko_yourActivity')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ActivityStatsCard stats={activityStats} hideCurrentStreak={isPastPeriod} />
            <ActivityLogList
              logs={activityLogs}
              isOwnProfile={true}
              isPastPeriod={isPastPeriod}
              activityTypes={activityTypes}
              onCreateLog={onCreateLog}
              onUpdateLog={onUpdateLog}
              onDeleteLog={onDeleteLog}
            />
          </CardContent>
        </Card>

        {/* Right: Leaderboard sticky panel */}
        <div className='lg:sticky lg:top-20 lg:self-start'>
          <Card className={busy} aria-busy={isPending}>
            <CardContent className='pt-6'>
              <LeaderboardPage entries={leaderboardEntries} currentUserId={currentUserId} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
