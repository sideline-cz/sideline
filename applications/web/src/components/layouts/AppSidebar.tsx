import type { Auth } from '@sideline/domain';
import { Link, useMatchRoute } from '@tanstack/react-router';
import { Languages, ShieldCheck, UserPlus } from 'lucide-react';
import type React from 'react';
import { NavUser } from '~/components/layouts/NavUser';
import { TeamSwitcher } from '~/components/layouts/TeamSwitcher';
import { Badge } from '~/components/ui/badge';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '~/components/ui/sidebar';
import { filterNavGroups, getTeamNavGroups } from '~/lib/navigation/teamNav.js';
import { tr } from '~/lib/translations.js';

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  user: Auth.CurrentUser;
  teams: ReadonlyArray<Auth.UserTeam>;
  activeTeam: Auth.UserTeam;
  onLogout: () => void;
}

export function AppSidebar({ user, teams, activeTeam, onLogout, ...props }: AppSidebarProps) {
  const matchRoute = useMatchRoute();
  const navGroups = filterNavGroups(
    getTeamNavGroups(activeTeam.teamId, activeTeam.discordJoined === 'not_connected'),
    activeTeam.permissions,
  );

  return (
    <Sidebar collapsible='icon' {...props}>
      <SidebarHeader>
        <TeamSwitcher teams={teams} activeTeamId={activeTeam.teamId} />
      </SidebarHeader>
      <SidebarContent>
        {navGroups.map((group) => (
          <SidebarGroup key={group.id}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      asChild
                      isActive={
                        !!matchRoute({ to: item.to, params: item.params, fuzzy: !item.exact })
                      }
                      tooltip={item.title}
                    >
                      <Link to={item.to} params={item.params}>
                        <item.icon />
                        <span>{item.title}</span>
                        {item.needsAttention && (
                          <Badge variant='destructive' className='ml-auto size-2 rounded-full p-0'>
                            <span className='sr-only'>{tr('discord_navNeedsAttention')}</span>
                          </Badge>
                        )}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
        {user.isGlobalAdmin && (
          <SidebarGroup>
            <SidebarGroupLabel>Admin</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={!!matchRoute({ to: '/admin/onboarding-tokens', fuzzy: false })}
                    tooltip={tr('admin_onboarding_pageTitle')}
                  >
                    <Link to='/admin/onboarding-tokens'>
                      <UserPlus />
                      <span>{tr('admin_onboarding_pageTitle')}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={!!matchRoute({ to: '/admin/translations', fuzzy: false })}
                    tooltip='Translations'
                  >
                    <Link to='/admin/translations'>
                      <Languages />
                      <span>Translations</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={!!matchRoute({ to: '/admin/global-admins', fuzzy: false })}
                    tooltip={tr('admin_globalAdmins_pageTitle')}
                  >
                    <Link to='/admin/global-admins'>
                      <ShieldCheck />
                      <span>{tr('admin_globalAdmins_pageTitle')}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} activeTeamId={activeTeam.teamId} onLogout={onLogout} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
