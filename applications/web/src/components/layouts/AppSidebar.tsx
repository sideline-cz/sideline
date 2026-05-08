import type { Auth, Role } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { Link, useMatchRoute } from '@tanstack/react-router';
import {
  Calendar,
  CalendarDays,
  Dumbbell,
  Home,
  Link2,
  type LucideIcon,
  Rss,
  Settings,
  Shield,
  Trophy,
  UserCog,
  Users,
  UsersRound,
} from 'lucide-react';
import { NavUser } from '~/components/layouts/NavUser';
import { TeamSwitcher } from '~/components/layouts/TeamSwitcher';
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

interface NavItem {
  title: string;
  icon: LucideIcon;
  to: string;
  params?: Record<string, string>;
  requiredPermission?: Role.Permission;
  exact?: boolean;
}

function getTeamNavGroups(
  teamId: string,
): ReadonlyArray<{ id: string; label: string; items: ReadonlyArray<NavItem> }> {
  return [
    {
      id: 'team',
      label: m.sidebar_team(),
      items: [
        {
          title: m.sidebar_dashboard(),
          icon: Home,
          to: '/teams/$teamId',
          params: { teamId },
          exact: true,
        },
        {
          title: m.event_events(),
          icon: Calendar,
          to: '/teams/$teamId/events',
          params: { teamId },
        },
        {
          title: m.sidebar_makanicko(),
          icon: Trophy,
          to: '/teams/$teamId/workout',
          params: { teamId },
        },
      ],
    },
    {
      id: 'coach',
      label: m.sidebar_coach(),
      items: [
        { title: m.team_members(), icon: Users, to: '/teams/$teamId/members', params: { teamId } },
        {
          title: m.team_groups(),
          icon: UserCog,
          to: '/teams/$teamId/groups',
          params: { teamId },
          requiredPermission: 'group:manage' satisfies Role.Permission,
        },
        {
          title: m.invites_title(),
          icon: Link2,
          to: '/teams/$teamId/invites',
          params: { teamId },
          requiredPermission: 'team:invite' satisfies Role.Permission,
        },
        {
          title: m.team_rosters(),
          icon: UsersRound,
          to: '/teams/$teamId/rosters',
          params: { teamId },
        },
        {
          title: m.team_trainingTypes(),
          icon: Dumbbell,
          to: '/teams/$teamId/training-types',
          params: { teamId },
          requiredPermission: 'training-type:create' satisfies Role.Permission,
        },
      ],
    },
    {
      id: 'administration',
      label: m.sidebar_administration(),
      items: [
        {
          title: m.team_roles(),
          icon: Shield,
          to: '/teams/$teamId/roles',
          params: { teamId },
          requiredPermission: 'role:manage' satisfies Role.Permission,
        },
        {
          title: m.team_ageThresholds(),
          icon: CalendarDays,
          to: '/teams/$teamId/age-thresholds',
          params: { teamId },
          requiredPermission: 'group:manage' satisfies Role.Permission,
        },
        {
          title: m.ical_title(),
          icon: Rss,
          to: '/teams/$teamId/calendar-subscription',
          params: { teamId },
        },
        {
          title: m.team_settings(),
          icon: Settings,
          to: '/teams/$teamId/settings',
          params: { teamId },
          requiredPermission: 'team:manage' satisfies Role.Permission,
        },
      ],
    },
  ];
}

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  user: Auth.CurrentUser;
  teams: ReadonlyArray<Auth.UserTeam>;
  activeTeam: Auth.UserTeam;
  onLogout: () => void;
}

export function AppSidebar({ user, teams, activeTeam, onLogout, ...props }: AppSidebarProps) {
  const matchRoute = useMatchRoute();
  const navGroups = getTeamNavGroups(activeTeam.teamId)
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          !item.requiredPermission || activeTeam.permissions.includes(item.requiredPermission),
      ),
    }))
    .filter((group) => group.items.length > 0);

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
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} activeTeamId={activeTeam.teamId} onLogout={onLogout} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
