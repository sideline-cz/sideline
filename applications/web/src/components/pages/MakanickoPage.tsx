import type {
  ActivityLog,
  ActivityLogApi,
  ActivityStatsApi,
  ActivityType,
  LeaderboardApi,
} from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { Link } from '@tanstack/react-router';
import type { Option } from 'effect';
import { ActivityLogList } from '~/components/organisms/ActivityLogList.js';
import { ActivityStatsCard } from '~/components/organisms/ActivityStatsCard.js';
import { LeaderboardPage } from '~/components/pages/LeaderboardPage.js';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';

interface MakanickoPageProps {
  teamId: string;
  leaderboardEntries: ReadonlyArray<LeaderboardApi.LeaderboardEntry>;
  currentUserId: string;
  activityStats: ActivityStatsApi.ActivityStatsResponse;
  activityLogs: ReadonlyArray<ActivityLogApi.ActivityLogEntry>;
  activityTypes: ReadonlyArray<{
    id: ActivityType.ActivityTypeId;
    name: string;
    emoji: Option.Option<string>;
  }>;
  onCreateLog: (input: {
    activityTypeId: ActivityType.ActivityTypeId;
    durationMinutes: Option.Option<number>;
    note: Option.Option<string>;
  }) => Promise<void>;
  onUpdateLog: (
    logId: ActivityLog.ActivityLogId,
    input: {
      activityTypeId: Option.Option<ActivityType.ActivityTypeId>;
      durationMinutes: Option.Option<Option.Option<number>>;
      note: Option.Option<Option.Option<string>>;
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
  activityTypes,
  onCreateLog,
  onUpdateLog,
  onDeleteLog,
}: MakanickoPageProps) {
  return (
    <div className='flex flex-col gap-6'>
      <header>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId' params={{ teamId }}>
            ← {m.team_backToTeams()}
          </Link>
        </Button>
        <div className='flex items-center justify-between gap-4'>
          <h1 className='text-2xl font-bold'>{m.makanicko_title()}</h1>
          <Button asChild variant='outline' size='sm'>
            <Link to='/teams/$teamId/workout/weekly' params={{ teamId }}>
              View weekly summary →
            </Link>
          </Button>
        </div>
      </header>

      <div className='flex flex-col gap-6 lg:grid lg:grid-cols-[1fr_400px]'>
        {/* Left: Activity card */}
        <Card>
          <CardHeader>
            <CardTitle>{m.makanicko_yourActivity()}</CardTitle>
          </CardHeader>
          <CardContent>
            <ActivityStatsCard stats={activityStats} />
            <ActivityLogList
              logs={activityLogs}
              isOwnProfile={true}
              activityTypes={activityTypes}
              onCreateLog={onCreateLog}
              onUpdateLog={onUpdateLog}
              onDeleteLog={onDeleteLog}
            />
          </CardContent>
        </Card>

        {/* Right: Leaderboard sticky panel */}
        <div className='lg:sticky lg:top-20 lg:self-start'>
          <Card>
            <CardContent className='pt-6'>
              <LeaderboardPage entries={leaderboardEntries} currentUserId={currentUserId} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
