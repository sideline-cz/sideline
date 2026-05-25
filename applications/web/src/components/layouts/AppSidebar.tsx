import type { Auth, Role } from '@sideline/domain';
import { Link, useMatchRoute } from '@tanstack/react-router';
import {
  Activity,
  Calendar,
  CreditCard,
  Dumbbell,
  Home,
  Languages,
  Link2,
  type LucideIcon,
  Receipt,
  ReceiptText,
  Rss,
  Settings,
  Shield,
  Target,
  Trophy,
  UserCog,
  UserPlus,
  Users,
  UsersRound,
  Wallet,
  Wand2,
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
import { tr } from '~/lib/translations.js';

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
      label: tr('sidebar_team'),
      items: [
        {
          title: tr('sidebar_dashboard'),
          icon: Home,
          to: '/teams/$teamId',
          params: { teamId },
          exact: true,
        },
        {
          title: tr('my_payments_navTitle'),
          icon: CreditCard,
          to: '/teams/$teamId/my-payments',
          params: { teamId },
        },
        {
          title: tr('event_events'),
          icon: Calendar,
          to: '/teams/$teamId/events',
          params: { teamId },
        },
        {
          title: tr('challenges_navTitle'),
          icon: Target,
          to: '/teams/$teamId/challenges',
          params: { teamId },
        },
        {
          title: tr('sidebar_makanicko'),
          icon: Trophy,
          to: '/teams/$teamId/workout',
          params: { teamId },
        },
      ],
    },
    {
      id: 'coach',
      label: tr('sidebar_coach'),
      items: [
        {
          title: tr('team_members'),
          icon: Users,
          to: '/teams/$teamId/members',
          params: { teamId },
        },
        {
          title: tr('team_groups'),
          icon: UserCog,
          to: '/teams/$teamId/groups',
          params: { teamId },
          requiredPermission: 'group:manage' satisfies Role.Permission,
        },
        {
          title: tr('invites_title'),
          icon: Link2,
          to: '/teams/$teamId/invites',
          params: { teamId },
          requiredPermission: 'team:invite' satisfies Role.Permission,
        },
        {
          title: tr('team_rosters'),
          icon: UsersRound,
          to: '/teams/$teamId/rosters',
          params: { teamId },
        },
        {
          title: tr('team_trainingTypes'),
          icon: Dumbbell,
          to: '/teams/$teamId/training-types',
          params: { teamId },
          requiredPermission: 'training-type:create' satisfies Role.Permission,
        },
        {
          title: tr('team_activityTypes'),
          icon: Activity,
          to: '/teams/$teamId/activity-types',
          params: { teamId },
          requiredPermission: 'activity-type:create' satisfies Role.Permission,
        },
        {
          title: tr('finance_navTitle'),
          icon: Wallet,
          to: '/teams/$teamId/finances',
          params: { teamId },
          requiredPermission: 'finance:view' satisfies Role.Permission,
          exact: true,
        },
        {
          title: tr('fees_navTitle'),
          icon: Receipt,
          to: '/teams/$teamId/finances/fees',
          params: { teamId },
          requiredPermission: 'finance:view' satisfies Role.Permission,
        },
        {
          title: tr('expenses_navTitle'),
          icon: ReceiptText,
          to: '/teams/$teamId/finances/expenses',
          params: { teamId },
          requiredPermission: 'finance:view' satisfies Role.Permission,
        },
      ],
    },
    {
      id: 'administration',
      label: tr('sidebar_administration'),
      items: [
        {
          title: tr('team_roles'),
          icon: Shield,
          to: '/teams/$teamId/roles',
          params: { teamId },
          requiredPermission: 'role:manage' satisfies Role.Permission,
        },
        {
          title: tr('team_ageThresholds'),
          icon: Wand2,
          to: '/teams/$teamId/age-thresholds',
          params: { teamId },
          requiredPermission: 'group:manage' satisfies Role.Permission,
        },
        {
          title: tr('ical_title'),
          icon: Rss,
          to: '/teams/$teamId/calendar-subscription',
          params: { teamId },
        },
        {
          title: tr('achievement_admin_navTitle'),
          icon: Trophy,
          to: '/teams/$teamId/achievements',
          params: { teamId },
          requiredPermission: 'team:manage' satisfies Role.Permission,
        },
        {
          title: tr('team_settings'),
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
