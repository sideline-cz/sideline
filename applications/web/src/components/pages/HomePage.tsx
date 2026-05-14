import { Option, Record } from 'effect';
import {
  Calendar,
  CheckCircle2,
  Clock,
  Dumbbell,
  Flame,
  MapPin,
  Monitor,
  Moon,
  Sun,
  Trophy,
  Users,
  Zap,
} from 'lucide-react';
import { LanguageSwitcher } from '~/components/organisms/LanguageSwitcher';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { useTheme } from '~/lib/theme';
import { tr } from '~/lib/translations.js';

const reasonMessages: Record<string, () => string> = {
  access_denied: () => tr('auth_errors_accessDenied'),
  missing_params: () => tr('auth_errors_missingParams'),
  oauth_failed: () => tr('auth_errors_oauthFailed'),
  profile_failed: () => tr('auth_errors_profileFailed'),
  internal_error: () => tr('auth_errors_internalError'),
};

interface HomePageProps {
  loginUrl: string;
  error: Option.Option<string>;
  reason: Option.Option<string>;
}

// -- Theme toggle button --

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const nextTheme = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  return (
    <Button variant='ghost' size='icon' onClick={() => setTheme(nextTheme)} className='size-9'>
      <Icon className='size-4' />
      <span className='sr-only'>{tr('theme_label')}</span>
    </Button>
  );
}

// -- Demo widgets with fake data --

function DemoStats() {
  const stats = [
    { label: tr('dashboard_currentStreak'), value: '12d', icon: Flame, accent: 'text-orange-500' },
    { label: tr('dashboard_recentActivities'), value: '8', icon: Zap, accent: 'text-blue-500' },
    {
      label: tr('dashboard_totalActivities'),
      value: '147',
      icon: Calendar,
      accent: 'text-muted-foreground',
    },
    {
      label: tr('dashboard_leaderboardPosition'),
      value: '#3',
      icon: Trophy,
      accent: 'text-yellow-500',
    },
  ];

  return (
    <Card className='shadow-lg border-border/50'>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm font-medium text-muted-foreground'>
          {tr('hero_demo_stats')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className='grid grid-cols-2 gap-3'>
          {stats.map((stat) => (
            <div key={stat.label} className='flex items-center gap-2'>
              <stat.icon className={`size-4 ${stat.accent}`} />
              <div>
                <p className='text-lg font-bold leading-none'>{stat.value}</p>
                <p className='text-[10px] text-muted-foreground leading-tight mt-0.5'>
                  {stat.label}
                </p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function DemoUpcomingEvents() {
  const events = [
    {
      day: '29',
      month: 'Mar',
      title: tr('hero_demo_event1_title'),
      type: 'training',
      time: tr('hero_demo_event1_time'),
      timeDetail: '10:00',
      location: tr('hero_demo_event1_location'),
      rsvp: 'yes' as const,
    },
    {
      day: '2',
      month: 'Apr',
      title: tr('hero_demo_event2_title'),
      type: 'match',
      time: tr('hero_demo_event2_time'),
      timeDetail: '18:30',
      location: tr('hero_demo_event2_location'),
      rsvp: 'maybe' as const,
    },
  ];

  const rsvpStyles = {
    yes: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/50 dark:text-green-200 dark:border-green-800',
    maybe:
      'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/50 dark:text-amber-200 dark:border-amber-800',
  };

  return (
    <Card className='shadow-lg border-border/50'>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm font-medium text-muted-foreground'>
          {tr('hero_demo_nextEvent')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className='flex flex-col gap-2'>
          {events.map((event) => (
            <div key={event.title} className='flex items-start gap-3 rounded-lg border p-2.5'>
              <div className='flex size-9 shrink-0 flex-col items-center justify-center rounded-md bg-muted text-xs'>
                <span className='font-semibold leading-none'>{event.day}</span>
                <span className='text-muted-foreground leading-none mt-0.5 text-[10px]'>
                  {event.month}
                </span>
              </div>
              <div className='min-w-0 flex-1'>
                <div className='flex items-center gap-1.5 mb-0.5'>
                  <p className='font-medium truncate text-xs'>{event.title}</p>
                  <Badge variant='secondary' className='capitalize text-[10px] px-1.5 py-0'>
                    {event.type}
                  </Badge>
                </div>
                <div className='flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground'>
                  <span className='flex items-center gap-0.5'>
                    <Clock className='size-2.5' />
                    {event.time} · {event.timeDetail}
                  </span>
                  <span className='flex items-center gap-0.5'>
                    <MapPin className='size-2.5' />
                    {event.location}
                  </span>
                </div>
              </div>
              <Badge
                variant='outline'
                className={`text-[10px] px-1.5 py-0 shrink-0 ${rsvpStyles[event.rsvp]}`}
              >
                {event.rsvp === 'yes' ? tr('dashboard_rsvpYes') : tr('dashboard_rsvpMaybe')}
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function DemoLeaderboard() {
  const players = [
    { rank: 1, name: 'Martin K.', points: '2,450', streak: 18 },
    { rank: 2, name: 'Jakub N.', points: '2,180', streak: 12 },
    { rank: 3, name: tr('hero_demo_player_you'), points: '1,920', streak: 12, isYou: true },
    { rank: 4, name: 'Tomas P.', points: '1,740', streak: 5 },
  ];

  return (
    <Card className='shadow-lg border-border/50'>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm font-medium text-muted-foreground'>
          {tr('hero_demo_leaderboard')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className='flex flex-col gap-1.5'>
          {players.map((player) => (
            <div
              key={player.rank}
              className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs ${
                player.isYou ? 'bg-primary/10 border border-primary/20 font-medium' : ''
              }`}
            >
              <span
                className={`w-5 text-center font-bold ${player.rank <= 3 ? 'text-yellow-500' : 'text-muted-foreground'}`}
              >
                #{player.rank}
              </span>
              <span className='flex-1 truncate'>{player.name}</span>
              <span className='flex items-center gap-1 text-orange-500'>
                <Flame className='size-3' />
                {player.streak}d
              </span>
              <span className='font-semibold tabular-nums'>{player.points}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function DemoRsvpBanner() {
  return (
    <Card className='shadow-lg border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20'>
      <CardHeader className='pb-2'>
        <div className='flex items-center gap-2'>
          <div className='flex size-5 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/50'>
            <Clock className='size-3 text-amber-600 dark:text-amber-400' />
          </div>
          <CardTitle className='text-sm font-medium text-muted-foreground'>
            {tr('hero_demo_rsvp')}
          </CardTitle>
          <Badge
            variant='secondary'
            className='bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/50 dark:text-amber-300 dark:border-amber-800 text-[10px] px-1.5 py-0'
          >
            1
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className='flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-white p-2.5 dark:border-amber-800 dark:bg-amber-950/30'>
          <div className='min-w-0 flex-1'>
            <p className='font-medium truncate text-xs'>{tr('hero_demo_rsvp_event')}</p>
            <p className='text-[10px] text-muted-foreground'>{tr('hero_demo_rsvp_time')}</p>
          </div>
          <Button size='sm' className='shrink-0 text-xs h-7 px-2.5'>
            {tr('dashboard_rsvpNow')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// -- Main component --

export function HomePage({ loginUrl, error, reason }: HomePageProps) {
  return (
    <div className='flex min-h-screen flex-col bg-background'>
      {/* Dot pattern background */}
      <div className='pointer-events-none fixed inset-0 bg-[radial-gradient(circle,_var(--color-muted-foreground)_1px,_transparent_1px)] bg-[size:24px_24px] opacity-[0.07]' />

      <header className='relative z-10 flex items-center justify-between px-6 py-4 border-b bg-background/80 backdrop-blur-sm'>
        <span className='text-lg font-bold'>{tr('app_name')}</span>
        <div className='flex items-center gap-1'>
          <LanguageSwitcher isAuthenticated={false} />
          <ThemeToggle />
        </div>
      </header>

      <main className='relative z-10 flex flex-1 flex-col items-center px-6 pb-24'>
        {Option.isSome(error) ? (
          <div className='flex flex-col items-center gap-4 text-center max-w-md mt-32'>
            <h1 className='text-3xl font-bold'>{tr('app_name')}</h1>
            <p className='text-muted-foreground'>
              {reason.pipe(
                Option.flatMap((msg) => Record.get(reasonMessages, msg)),
                Option.getOrElse(() => () => tr('auth_loginFailed')),
              )()}
            </p>
            <Button asChild size='lg'>
              <a href={loginUrl}>{tr('auth_tryAgain')}</a>
            </Button>
          </div>
        ) : (
          <div className='flex flex-col items-center w-full max-w-6xl'>
            {/* Hero section */}
            <div className='flex flex-col items-center gap-4 text-center pt-16 pb-12 sm:pt-24 sm:pb-16'>
              <div className='flex items-center gap-2 mb-2'>
                <Badge variant='secondary' className='gap-1.5 px-3 py-1 text-xs'>
                  <Users className='size-3' />
                  {tr('hero_feature_team')}
                </Badge>
                <Badge variant='secondary' className='gap-1.5 px-3 py-1 text-xs'>
                  <Calendar className='size-3' />
                  {tr('hero_feature_events')}
                </Badge>
                <Badge
                  variant='secondary'
                  className='gap-1.5 px-3 py-1 text-xs hidden sm:inline-flex'
                >
                  <Dumbbell className='size-3' />
                  {tr('hero_feature_workout')}
                </Badge>
              </div>
              <h1 className='text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl max-w-3xl bg-gradient-to-br from-foreground via-foreground to-muted-foreground/70 bg-clip-text text-transparent'>
                {tr('hero_headline')}
              </h1>
              <p className='text-lg text-muted-foreground max-w-2xl'>{tr('hero_subheadline')}</p>
              <Button asChild size='lg' className='mt-4 text-base px-8 h-12'>
                <a href={loginUrl}>
                  <DiscordIcon />
                  {tr('auth_signInDiscord')}
                </a>
              </Button>
            </div>

            {/* Demo bento grid */}
            <div className='w-full max-w-4xl mx-auto'>
              {/* Outer container with perspective for depth */}
              <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'>
                {/* Stats card - top left */}
                <div className='sm:col-span-1 lg:col-span-1 transition-transform hover:scale-[1.02] duration-200 -rotate-1'>
                  <DemoStats />
                </div>

                {/* Events card - top center/right, spans 2 cols on lg */}
                <div className='sm:col-span-1 lg:col-span-2 transition-transform hover:scale-[1.02] duration-200 rotate-1'>
                  <DemoUpcomingEvents />
                </div>

                {/* Leaderboard - bottom left, spans 2 cols on lg */}
                <div className='sm:col-span-1 lg:col-span-2 transition-transform hover:scale-[1.02] duration-200 rotate-[0.5deg]'>
                  <DemoLeaderboard />
                </div>

                {/* RSVP banner - bottom right */}
                <div className='sm:col-span-1 lg:col-span-1 transition-transform hover:scale-[1.02] duration-200 -rotate-1'>
                  <DemoRsvpBanner />
                </div>
              </div>
            </div>

            {/* Feature descriptions below */}
            <div className='grid grid-cols-1 gap-6 sm:grid-cols-3 w-full max-w-4xl mt-16'>
              {[
                {
                  icon: Calendar,
                  title: tr('hero_feature_events'),
                  desc: tr('hero_feature_events_desc'),
                },
                {
                  icon: Dumbbell,
                  title: tr('hero_feature_workout'),
                  desc: tr('hero_feature_workout_desc'),
                },
                {
                  icon: Users,
                  title: tr('hero_feature_team'),
                  desc: tr('hero_feature_team_desc'),
                },
              ].map((feature) => (
                <div
                  key={feature.title}
                  className='flex flex-col items-center text-center gap-2 px-4'
                >
                  <div className='flex size-10 items-center justify-center rounded-lg bg-primary/10'>
                    <feature.icon className='size-5 text-primary' />
                  </div>
                  <h3 className='font-semibold'>{feature.title}</h3>
                  <p className='text-sm text-muted-foreground'>{feature.desc}</p>
                </div>
              ))}
            </div>

            {/* Second CTA */}
            <div className='mt-16 flex flex-col items-center gap-3'>
              <div className='flex items-center gap-2 text-sm text-muted-foreground'>
                <CheckCircle2 className='size-4 text-green-500' />
                <span>{tr('hero_footer')}</span>
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className='relative z-10 border-t px-6 py-4 text-center text-sm text-muted-foreground bg-background/80 backdrop-blur-sm'>
        {tr('hero_footer')}
      </footer>
    </div>
  );
}

function DiscordIcon() {
  return (
    <svg
      className='size-5 mr-1'
      viewBox='0 0 24 24'
      fill='currentColor'
      role='img'
      aria-label='Discord'
    >
      <path d='M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z' />
    </svg>
  );
}
