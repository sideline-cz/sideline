import type { DashboardApi, DashboardLayoutApi } from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import { DateTime, Option } from 'effect';
import {
  Activity,
  Calendar,
  ChevronRight,
  Clock,
  Flame,
  LayoutDashboard,
  MapPin,
  Settings,
  Trophy,
  Users,
  Zap,
} from 'lucide-react';
import type React from 'react';
import { EventLocation } from '~/components/atoms/EventLocation.js';
import { DashboardCustomizer } from '~/components/organisms/DashboardCustomizer.js';
import type { MyFinanceStatus } from '~/components/organisms/OutstandingPaymentsBanner.js';
import { OutstandingPaymentsBanner } from '~/components/organisms/OutstandingPaymentsBanner.js';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Skeleton } from '~/components/ui/skeleton';
import { DEFAULT_LAYOUT } from '~/lib/dashboardLayout.js';
import { formatLocalTime } from '~/lib/datetime';
import { tr } from '~/lib/translations.js';

// WidgetId mirrors DashboardLayoutApi.DashboardWidgetId — kept here so the
// registry Record type is closed without importing from the domain package.
type WidgetId = 'stats' | 'upcomingEvents' | 'activity' | 'teamManagement';

interface TeamDetailPageProps {
  teamId: string;
  userId?: string;
  dashboard: DashboardApi.DashboardResponse | undefined;
  myStatus?: ReadonlyArray<MyFinanceStatus>;
  layout?: DashboardLayoutApi.DashboardLayout;
  onSaveLayout?: (widgets: DashboardLayoutApi.DashboardWidget[]) => Promise<void>;
}

const formatDuration = (minutes: number): string => {
  if (minutes === 0) return '0m';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
};

const toDate = (dt: DateTime.Utc): Date => new Date(Number(DateTime.toEpochMillis(dt)));

const formatRelativeDate = (dt: DateTime.Utc): string => {
  const date = toDate(dt);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const eventDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((eventDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return tr('dashboard_today');
  if (diffDays === 1) return tr('dashboard_tomorrow');
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
};

const RsvpBadge = ({ rsvp }: { rsvp: Option.Option<'yes' | 'no' | 'maybe'> }) => {
  if (Option.isNone(rsvp)) {
    return <Badge variant='secondary'>{tr('dashboard_noResponse')}</Badge>;
  }
  const styles = {
    yes: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/50 dark:text-green-200 dark:border-green-800',
    no: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/50 dark:text-red-200 dark:border-red-800',
    maybe:
      'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/50 dark:text-amber-200 dark:border-amber-800',
  };
  const labels = {
    yes: tr('dashboard_rsvpYes'),
    no: tr('dashboard_rsvpNo'),
    maybe: tr('dashboard_rsvpMaybe'),
  };
  return (
    <Badge variant='outline' className={styles[rsvp.value]}>
      {labels[rsvp.value]}
    </Badge>
  );
};

const EventTypeBadge = ({ type }: { type: string }) => {
  return (
    <Badge variant='secondary' className='capitalize'>
      {type}
    </Badge>
  );
};

// -- Loading skeleton --

function DashboardSkeleton() {
  return (
    <div className='space-y-6'>
      {/* Stats skeleton */}
      <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
        {['streak', 'recent', 'total', 'rank'].map((id) => (
          <Card key={id} className='py-4'>
            <CardContent className='px-4'>
              <Skeleton className='h-3 w-16 mb-2' />
              <Skeleton className='h-7 w-12' />
            </CardContent>
          </Card>
        ))}
      </div>
      {/* Cards skeleton */}
      <div className='grid grid-cols-1 gap-6 lg:grid-cols-2'>
        <Card>
          <CardContent>
            <Skeleton className='h-32' />
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Skeleton className='h-32' />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// -- Stat cards row --

function StatCards({
  activitySummary,
}: {
  activitySummary: DashboardApi.DashboardActivitySummary;
}) {
  const stats = [
    {
      label: tr('dashboard_currentStreak'),
      value: `${activitySummary.currentStreak}d`,
      icon: Flame,
      accent: activitySummary.currentStreak > 0 ? 'text-orange-500' : 'text-muted-foreground',
    },
    {
      label: tr('dashboard_recentActivities'),
      value: String(activitySummary.recentActivityCount),
      icon: Zap,
      accent: 'text-blue-500',
    },
    {
      label: tr('dashboard_totalActivities'),
      value: String(activitySummary.totalActivities),
      icon: Calendar,
      accent: 'text-muted-foreground',
    },
    {
      label: tr('dashboard_leaderboardPosition'),
      value: Option.match(activitySummary.leaderboardRank, {
        onNone: () => tr('dashboard_notRanked'),
        onSome: (rank) => `#${rank}`,
      }),
      icon: Trophy,
      accent: Option.isSome(activitySummary.leaderboardRank)
        ? 'text-yellow-500'
        : 'text-muted-foreground',
    },
  ];

  return (
    <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
      {stats.map((stat) => (
        <Card key={stat.label} className='py-4 gap-2'>
          <CardContent className='px-4'>
            <div className='flex items-center gap-1.5 mb-1'>
              <stat.icon className={`size-3.5 ${stat.accent}`} />
              <p className='text-xs text-muted-foreground'>{stat.label}</p>
            </div>
            <p className='text-2xl font-bold tracking-tight'>{stat.value}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// -- Awaiting RSVP section (urgent, shown as alert-style) --

function AwaitingRsvpBanner({
  teamId,
  events,
}: {
  teamId: string;
  events: ReadonlyArray<DashboardApi.DashboardUpcomingEvent>;
}) {
  if (events.length === 0) return null;

  return (
    <Card className='border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20 py-4 gap-3'>
      <CardHeader className='px-4 sm:px-6 py-0'>
        <div className='flex items-center gap-2'>
          <div className='flex size-6 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/50'>
            <Clock className='size-3.5 text-amber-600 dark:text-amber-400' />
          </div>
          <CardTitle className='text-sm font-semibold'>{tr('dashboard_awaitingRsvp')}</CardTitle>
          <Badge
            variant='secondary'
            className='bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/50 dark:text-amber-300 dark:border-amber-800'
          >
            {events.length}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className='px-4 sm:px-6 py-0'>
        <div className='flex flex-col gap-2'>
          {events.map((event) => (
            <Link
              key={event.eventId}
              to='/teams/$teamId/events/$eventId'
              params={{ teamId, eventId: event.eventId }}
              className='flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-white p-3 transition-colors hover:bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 dark:hover:bg-amber-950/50'
            >
              <div className='min-w-0 flex-1'>
                <p className='font-medium truncate text-sm'>{event.title}</p>
                <p className='text-xs text-muted-foreground'>
                  {formatRelativeDate(event.startAt)} · {formatLocalTime(event.startAt)}
                </p>
              </div>
              <Button size='sm' className='shrink-0'>
                {tr('dashboard_rsvpNow')}
              </Button>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// -- Upcoming events card --

function UpcomingEventsCard({
  teamId,
  events,
}: {
  teamId: string;
  events: ReadonlyArray<DashboardApi.DashboardUpcomingEvent>;
}) {
  return (
    <Card>
      <CardHeader>
        <div className='flex items-center justify-between'>
          <CardTitle className='text-base'>{tr('dashboard_upcomingEvents')}</CardTitle>
          <Button asChild variant='ghost' size='sm'>
            <Link to='/teams/$teamId/events' params={{ teamId }}>
              {tr('dashboard_viewEvents')}
              <ChevronRight className='size-4' />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-6 text-center'>
            <Calendar className='size-8 text-muted-foreground/40 mb-2' />
            <p className='text-sm text-muted-foreground'>{tr('dashboard_noUpcomingEvents')}</p>
          </div>
        ) : (
          <div className='flex flex-col gap-2'>
            {events.map((event) => (
              <Link
                key={event.eventId}
                to='/teams/$teamId/events/$eventId'
                params={{ teamId, eventId: event.eventId }}
                className='group flex items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-accent'
              >
                {/* Date column */}
                <div className='flex size-10 shrink-0 flex-col items-center justify-center rounded-md bg-muted text-xs'>
                  <span className='font-semibold leading-none'>
                    {toDate(event.startAt).getDate()}
                  </span>
                  <span className='text-muted-foreground leading-none mt-0.5'>
                    {toDate(event.startAt).toLocaleDateString(undefined, { month: 'short' })}
                  </span>
                </div>
                {/* Event info */}
                <div className='min-w-0 flex-1'>
                  <div className='flex items-center gap-2 mb-0.5'>
                    <p className='font-medium truncate text-sm'>{event.title}</p>
                    <EventTypeBadge type={event.eventType} />
                  </div>
                  <div className='flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground'>
                    <span className='flex items-center gap-1'>
                      <Clock className='size-3' />
                      {formatRelativeDate(event.startAt)} · {formatLocalTime(event.startAt)}
                    </span>
                    {Option.isSome(event.location) && (
                      <span className='flex items-center gap-1 truncate'>
                        <MapPin className='size-3 shrink-0' />
                        <EventLocation
                          text={event.location.value}
                          url={event.locationUrl}
                          stopPropagation
                        />
                      </span>
                    )}
                  </div>
                </div>
                {/* RSVP status */}
                <div className='shrink-0 self-center'>
                  <RsvpBadge rsvp={event.myRsvp} />
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// -- Activity details card --

function ActivityCard({
  activitySummary,
  teamId,
}: {
  activitySummary: DashboardApi.DashboardActivitySummary;
  teamId: string;
}) {
  const details = [
    { label: tr('dashboard_longestStreak'), value: `${activitySummary.longestStreak}d` },
    {
      label: tr('dashboard_totalDuration'),
      value: formatDuration(activitySummary.totalDurationMinutes),
    },
    {
      label: tr('dashboard_leaderboardPosition'),
      value: Option.match(activitySummary.leaderboardRank, {
        onNone: () => tr('dashboard_notRanked'),
        onSome: (rank) => `#${rank} / ${activitySummary.leaderboardTotal}`,
      }),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <div className='flex items-center justify-between'>
          <CardTitle className='text-base'>{tr('dashboard_activitySummary')}</CardTitle>
          <Button asChild variant='ghost' size='sm'>
            <Link to='/teams/$teamId/workout' params={{ teamId }}>
              {tr('dashboard_viewLeaderboard')}
              <ChevronRight className='size-4' />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className='flex flex-col gap-3'>
          {details.map((detail) => (
            <div key={detail.label} className='flex items-center justify-between'>
              <span className='text-sm text-muted-foreground'>{detail.label}</span>
              <span className='text-sm font-semibold'>{detail.value}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// -- Team management card --

function TeamManagementCard({ teamId }: { teamId: string }) {
  const sections = [
    { to: '/teams/$teamId/members' as const, label: tr('team_members'), icon: Users },
    { to: '/teams/$teamId/rosters' as const, label: tr('team_rosters'), icon: Users },
    { to: '/teams/$teamId/roles' as const, label: tr('team_roles'), icon: Settings },
    { to: '/teams/$teamId/groups' as const, label: tr('team_groups'), icon: Users },
    {
      to: '/teams/$teamId/activity-types' as const,
      label: tr('team_activityTypes'),
      icon: Activity,
    },
    { to: '/teams/$teamId/training-types' as const, label: tr('team_trainingTypes'), icon: Zap },
    {
      to: '/teams/$teamId/age-thresholds' as const,
      label: tr('team_ageThresholds'),
      icon: Calendar,
    },
    { to: '/teams/$teamId/settings' as const, label: tr('team_settings'), icon: Settings },
  ] as const;

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>{tr('dashboard_teamManagement')}</CardTitle>
        <CardDescription className='text-xs'>{tr('team_settings')}</CardDescription>
      </CardHeader>
      <CardContent>
        <nav className='grid grid-cols-1 gap-1 sm:grid-cols-2'>
          {sections.map((section) => (
            <Link
              key={section.to}
              to={section.to}
              params={{ teamId }}
              className='flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent'
            >
              <section.icon className='size-4 text-muted-foreground' />
              <span>{section.label}</span>
              <ChevronRight className='ml-auto size-4 text-muted-foreground/50' />
            </Link>
          ))}
        </nav>
      </CardContent>
    </Card>
  );
}

// -- Main page component --

export function TeamDetailPage({
  teamId,
  userId,
  dashboard,
  myStatus = [],
  layout,
  onSaveLayout,
}: TeamDetailPageProps) {
  if (!dashboard) {
    return (
      <div className='space-y-6'>
        <h1 className='text-2xl font-bold'>{tr('dashboard_title')}</h1>
        <DashboardSkeleton />
      </div>
    );
  }

  const { upcomingEvents, awaitingRsvp, activitySummary } = dashboard;
  const effectiveLayout = layout ?? DEFAULT_LAYOUT;

  const widgetRegistry: Record<WidgetId, React.ReactNode> = {
    stats: <StatCards key='stats' activitySummary={activitySummary} />,
    upcomingEvents: (
      <UpcomingEventsCard key='upcomingEvents' teamId={teamId} events={upcomingEvents} />
    ),
    activity: <ActivityCard key='activity' activitySummary={activitySummary} teamId={teamId} />,
    teamManagement: <TeamManagementCard key='teamManagement' teamId={teamId} />,
  };

  const visibleWidgets = effectiveLayout.widgets
    .filter((w) => w.visible)
    .map((w) => widgetRegistry[w.id as WidgetId])
    .filter(Boolean);

  const allHidden = effectiveLayout.widgets.every((w) => !w.visible);

  return (
    <div className='space-y-6'>
      {/* Page header with title and customizer entry point */}
      <div className='flex items-center justify-between gap-2'>
        <h1 className='text-2xl font-bold'>{tr('dashboard_title')}</h1>
        {userId !== undefined && onSaveLayout !== undefined && (
          <DashboardCustomizer teamId={teamId} layout={effectiveLayout} onSave={onSaveLayout} />
        )}
      </div>

      {/* Pinned banners - always rendered regardless of layout */}
      <AwaitingRsvpBanner teamId={teamId} events={awaitingRsvp} />

      {/* Outstanding payments banner - shown when player has outstanding fees */}
      <OutstandingPaymentsBanner teamId={teamId} groups={myStatus} />

      {/* Configurable widget region */}
      <div className='flex flex-col gap-6 max-w-4xl mx-auto w-full'>
        {allHidden ? (
          <Card data-testid='dashboard-empty-state'>
            <CardContent className='flex flex-col items-center justify-center gap-3 py-10 text-center'>
              <LayoutDashboard className='size-8 text-muted-foreground/40' />
              <p className='text-sm text-muted-foreground'>{tr('dashboard_allWidgetsHidden')}</p>
            </CardContent>
          </Card>
        ) : (
          visibleWidgets
        )}
      </div>
    </div>
  );
}
