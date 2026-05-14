import type { Auth } from '@sideline/domain';
import { getLocale, setLocale } from '@sideline/i18n/runtime';
import { Link } from '@tanstack/react-router';
import { Effect, Option } from 'effect';
import {
  Bell,
  BookOpen,
  Bug,
  Check,
  ChevronsUpDown,
  Languages,
  LogOut,
  Monitor,
  Moon,
  Sun,
  UserIcon,
} from 'lucide-react';
import { useCallback } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '~/components/ui/sidebar';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { useTheme } from '~/lib/theme.js';
import { tr } from '~/lib/translations.js';

function discordAvatarUrl(discordId: string, avatar: string): string {
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.png?size=64`;
}

function userInitials(user: Auth.CurrentUser): string {
  if (Option.isSome(user.name)) {
    return user.name.value
      .split(' ')
      .map((part: string) => part[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }
  return user.username.slice(0, 2).toUpperCase();
}

interface NavUserProps {
  user: Auth.CurrentUser;
  activeTeamId: string | undefined;
  onLogout: () => void;
}

const localeOptions = [
  { value: 'en' as const, flag: '🇬🇧', label: () => tr('language_en') },
  { value: 'cs' as const, flag: '🇨🇿', label: () => tr('language_cs') },
] as const;

const themeOptions = [
  { value: 'light' as const, icon: Sun, label: () => tr('theme_light') },
  { value: 'dark' as const, icon: Moon, label: () => tr('theme_dark') },
  { value: 'system' as const, icon: Monitor, label: () => tr('theme_system') },
] as const;

export function NavUser({ user, activeTeamId, onLogout }: NavUserProps) {
  const { isMobile } = useSidebar();
  const run = useRun();
  const displayName = Option.getOrElse(user.name, () => user.username);
  const currentLocale = getLocale();
  const { theme, setTheme } = useTheme();

  const handleLocaleChange = useCallback(
    (locale: 'en' | 'cs') => {
      setLocale(locale);
      ApiClient.asEffect().pipe(
        Effect.flatMap((api) => api.auth.updateLocale({ payload: { locale } })),
        Effect.mapError(() => ClientError.make(tr('auth_errors_profileFailed'))),
        run(),
      );
    },
    [run],
  );

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size='lg'
              className='data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground'
            >
              <Avatar className='h-8 w-8 rounded-lg'>
                {Option.isSome(user.avatar) && (
                  <AvatarImage
                    src={discordAvatarUrl(user.discordId, user.avatar.value)}
                    alt={displayName}
                  />
                )}
                <AvatarFallback className='rounded-lg'>{userInitials(user)}</AvatarFallback>
              </Avatar>
              <div className='grid flex-1 text-left text-sm leading-tight'>
                <span className='truncate font-semibold'>{displayName}</span>
                <span className='truncate text-xs'>{user.username}</span>
              </div>
              <ChevronsUpDown className='ml-auto size-4' />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className='w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg'
            side={isMobile ? 'bottom' : 'right'}
            align='end'
            sideOffset={4}
          >
            <DropdownMenuLabel className='p-0 font-normal'>
              <div className='flex items-center gap-2 px-1 py-1.5 text-left text-sm'>
                <Avatar className='h-8 w-8 rounded-lg'>
                  {Option.isSome(user.avatar) && (
                    <AvatarImage
                      src={discordAvatarUrl(user.discordId, user.avatar.value)}
                      alt={displayName}
                    />
                  )}
                  <AvatarFallback className='rounded-lg'>{userInitials(user)}</AvatarFallback>
                </Avatar>
                <div className='grid flex-1 text-left text-sm leading-tight'>
                  <span className='truncate font-semibold'>{displayName}</span>
                  <span className='truncate text-xs'>{user.username}</span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <Link to='/profile'>
                  <UserIcon />
                  {tr('nav_profile')}
                </Link>
              </DropdownMenuItem>
              {activeTeamId && (
                <DropdownMenuItem asChild>
                  <Link to='/teams/$teamId/notifications' params={{ teamId: activeTeamId }}>
                    <Bell />
                    {tr('nav_notifications')}
                  </Link>
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Languages />
                  {tr('language_label')}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {localeOptions.map((loc) => (
                    <DropdownMenuItem key={loc.value} onClick={() => handleLocaleChange(loc.value)}>
                      {loc.flag} {loc.label()}
                      {currentLocale === loc.value && <Check className='ml-auto h-4 w-4' />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  {(() => {
                    const ActiveIcon = themeOptions.find((o) => o.value === theme)?.icon ?? Sun;
                    return <ActiveIcon />;
                  })()}
                  {tr('theme_label')}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {themeOptions.map((opt) => (
                    <DropdownMenuItem key={opt.value} onClick={() => setTheme(opt.value)}>
                      <opt.icon className='mr-2 h-4 w-4' />
                      {opt.label()}
                      {theme === opt.value && <Check className='ml-auto h-4 w-4' />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <a href='/docs/' target='_blank' rel='noopener noreferrer'>
                  <BookOpen />
                  {tr('nav_documentation')}
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a
                  href='https://majksa.notion.site/33b93506081880de83b1ed40e3759e46'
                  target='_blank'
                  rel='noopener noreferrer'
                >
                  <Bug />
                  {tr('nav_reportBug')}
                </a>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onLogout}>
              <LogOut />
              {tr('nav_logOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
