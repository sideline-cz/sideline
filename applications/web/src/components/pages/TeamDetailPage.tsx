import type { Auth, DashboardApi, DashboardLayoutApi } from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import { DateTime, Option } from 'effect';
import {
  Activity,
  Calendar,
  ChevronRight,
  Clock,
  Flame,
  MapPin,
  Settings,
  Trophy,
  Users,
  Zap,
} from 'lucide-react';
import React from 'react';
import { EventLocation } from '~/components/atoms/EventLocation.js';
import { DashboardCustomizer } from '~/components/organisms/DashboardCustomizer.js';
import { DiscordConnectCard } from '~/components/organisms/DiscordConnectCard.js';
import type { MyFinanceStatus } from '~/components/organisms/OutstandingPaymentsBanner.js';
import { OutstandingPaymentsBanner } from '~/components/organisms/OutstandingPaymentsBanner.js';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Skeleton } from '~/components/ui/skeleton';
import { DEFAULT_LAYOUT } from '~/lib/dashboardLayout.js';
import { formatLocalTime, formatUtcDate } from '~/lib/datetime';
import { tr } from '~/lib/translations.js';

// WidgetId mirrors DashboardLayoutApi.DashboardWidgetId
type WidgetId =
  | 'awaitingRsvp'
  | 'outstandingPayments'
  | 'stats'
  | 'upcomingEvents'
  | 'activity'
  | 'teamManagement';

interface TeamDetailPageProps {
  teamId: string;
  userId?: string;
  /** PR-9 / designer §2.2 — the current user's own view of this team, carrying
   * `discordJoined`. Optional so existing callers/tests that don't exercise the Discord surface
   * keep compiling; when absent, `DiscordConnectCard` is not mounted. */
  team?: Auth.UserTeam;
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

// Timed events only — kept exactly as before (browser-local read of the instant).
// Also the fallback for an all-day card missing `startDate` or the response missing
// `todayLocalDate` (an older server, plan §11.5(c)/§17): today's behaviour rather
// than a crash.
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

// `dateStr` is a `YYYY-MM-DD` calendar date (never an instant) — parse it as UTC
// midnight so no browser timezone can shift it to the neighbouring day.
const parseDateOnly = (dateStr: string): Date => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d));
};

// All-day events, plan §11.1 row W6 / §11.5(c). Both operands are server-derived
// team-local `YYYY-MM-DD` strings, compared as strings/UTC-midnight dates — never the
// browser's own notion of "today" and never a UTC read of the (team-local) instant.
const formatAllDayRelativeDate = (startDate: string, todayLocalDate: string): string => {
  const diffDays = Math.round(
    (parseDateOnly(startDate).getTime() - parseDateOnly(todayLocalDate).getTime()) /
      (1000 * 60 * 60 * 24),
  );
  if (diffDays === 0) return tr('dashboard_today');
  if (diffDays === 1) return tr('dashboard_tomorrow');
  return parseDateOnly(startDate).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
};

// Dispatches between the two above. Falls back to `formatRelativeDate(event.startAt)`
// — today's behaviour — whenever either date-only string is missing (older server).
const relativeDateLabel = (
  event: DashboardApi.DashboardUpcomingEvent,
  todayLocalDate: Option.Option<string>,
): string => {
  if (event.allDay && Option.isSome(event.startDate) && Option.isSome(todayLocalDate)) {
    return formatAllDayRelativeDate(event.startDate.value, todayLocalDate.value);
  }
  return formatRelativeDate(event.startAt);
};

// The date-badge box (`UpcomingEventsCard`). All-day events read the server-derived
// team-local date (falling back to `formatUtcDate` on the instant for an older
// server, plan §17) rather than the instant itself, mirroring `EventsListPage.tsx`.
const eventBadgeDate = (
  event: DashboardApi.DashboardUpcomingEvent,
): { day: number; month: string } => {
  if (event.allDay) {
    const dateStr = Option.getOrElse(event.startDate, () => formatUtcDate(event.startAt));
    const date = parseDateOnly(dateStr);
    return {
      day: date.getUTCDate(),
      month: date.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }),
    };
  }
  const date = toDate(event.startAt);
  return { day: date.getDate(), month: date.toLocaleDateString(undefined, { month: 'short' }) };
};

const RsvpBadge = ({ rsvp }: { rsvp: Option.Option<'yes' | 'no' | 'maybe' | 'coming_later'> }) => {
  if (Option.isNone(rsvp)) {
    return <Badge variant='secondary'>{tr('dashboard_noResponse')}</Badge>;
  }
  // "Coming later" is written as `coming_later` and read back as `maybe` this release — both
  // render as the same "coming later" badge, grouped under the `late` style/label key.
  const key: 'yes' | 'no' | 'late' =
    rsvp.value === 'yes' ? 'yes' : rsvp.value === 'no' ? 'no' : 'late';
  const styles = {
    yes: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/50 dark:text-green-200 dark:border-green-800',
    no: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/50 dark:text-red-200 dark:border-red-800',
    late: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/50 dark:text-blue-200 dark:border-blue-800',
  };
  const labels = {
    yes: tr('dashboard_rsvpYes'),
    no: tr('dashboard_rsvpNo'),
    late: tr('dashboard_rsvpMaybe'),
  };
  return (
    <Badge variant='outline' className={styles[key]}>
      {labels[key]}
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
  todayLocalDate,
}: {
  teamId: string;
  events: ReadonlyArray<DashboardApi.DashboardUpcomingEvent>;
  todayLocalDate: Option.Option<string>;
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
                  {relativeDateLabel(event, todayLocalDate)} ·{' '}
                  {event.allDay ? (
                    <span className='rounded bg-muted px-1 py-0.5 text-[10px]'>
                      {tr('event_allDayLabel')}
                    </span>
                  ) : (
                    formatLocalTime(event.startAt)
                  )}
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
  todayLocalDate,
}: {
  teamId: string;
  events: ReadonlyArray<DashboardApi.DashboardUpcomingEvent>;
  todayLocalDate: Option.Option<string>;
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
                  <span className='font-semibold leading-none'>{eventBadgeDate(event).day}</span>
                  <span className='text-muted-foreground leading-none mt-0.5'>
                    {eventBadgeDate(event).month}
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
                      {relativeDateLabel(event, todayLocalDate)} ·{' '}
                      {event.allDay ? (
                        <span className='rounded bg-muted px-1 py-0.5 text-[10px]'>
                          {tr('event_allDayLabel')}
                        </span>
                      ) : (
                        formatLocalTime(event.startAt)
                      )}
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
  team,
  dashboard,
  myStatus = [],
  layout,
  onSaveLayout,
}: TeamDetailPageProps) {
  const [editMode, setEditMode] = React.useState(false);

  if (!dashboard) {
    return (
      <div className='space-y-6'>
        <h1 className='text-2xl font-bold'>{tr('dashboard_title')}</h1>
        <DashboardSkeleton />
      </div>
    );
  }

  const { upcomingEvents, awaitingRsvp, activitySummary, todayLocalDate } = dashboard;
  const effectiveLayout = layout ?? DEFAULT_LAYOUT;

  // Determine whether each banner has actionable data. When there is no data
  // the registry entry is set to null so the DashboardCustomizer excludes the
  // widget from the RGL grid entirely (no empty rectangle left behind).
  const hasRsvp = awaitingRsvp.length > 0;
  const hasOutstandingPayments = myStatus.some((g) => g.totalOutstandingMinor > 0);

  // NOTE: Banners are now part of the widget registry and can be toggled/repositioned
  // by the user via the customizer. This means a user who deliberately hides the
  // awaitingRsvp or outstandingPayments widget via the aside panel will NOT see
  // those banners even when there is actionable data (pending RSVPs / unpaid fees).
  // This is a deliberate user choice — they opted out of the reminder.
  const widgetRegistry: Record<WidgetId, React.ReactNode | null> = {
    awaitingRsvp: hasRsvp ? (
      <AwaitingRsvpBanner
        key='awaitingRsvp'
        teamId={teamId}
        events={awaitingRsvp}
        todayLocalDate={todayLocalDate}
      />
    ) : null,
    outstandingPayments: hasOutstandingPayments ? (
      <OutstandingPaymentsBanner key='outstandingPayments' teamId={teamId} groups={myStatus} />
    ) : null,
    stats: <StatCards key='stats' activitySummary={activitySummary} />,
    upcomingEvents: (
      <UpcomingEventsCard
        key='upcomingEvents'
        teamId={teamId}
        events={upcomingEvents}
        todayLocalDate={todayLocalDate}
      />
    ),
    activity: <ActivityCard key='activity' activitySummary={activitySummary} teamId={teamId} />,
    teamManagement: <TeamManagementCard key='teamManagement' teamId={teamId} />,
  };

  return (
    <div className='space-y-6'>
      {/* Page header with Customize button */}
      <div className='flex items-center justify-between gap-4'>
        <h1 className='text-2xl font-bold'>{tr('dashboard_title')}</h1>
        {userId !== undefined && onSaveLayout !== undefined && (
          <Button variant='outline' size='sm' onClick={() => setEditMode(true)}>
            {tr('dashboard_customize')}
          </Button>
        )}
      </div>

      {/* PR-9 / designer §2.2 — the durable Discord card. Deliberately NOT part of the
          customizable widget grid below: it is never dismissible and never hidden, which the
          widget registry's opt-out semantics would otherwise allow. */}
      {team !== undefined && <DiscordConnectCard team={team} myMemberId={dashboard.myMemberId} />}

      {/* Configurable widget region — banners are now part of the grid */}
      <DashboardCustomizer
        teamId={teamId}
        layout={effectiveLayout}
        onSave={userId !== undefined ? onSaveLayout : undefined}
        widgetRegistry={widgetRegistry}
        editMode={editMode}
        onEditModeChange={setEditMode}
      />
    </div>
  );
}
