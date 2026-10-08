/**
 * The team navigation entries — which pages exist, how they group, and which permission each
 * one needs. Lifted out of `AppSidebar.tsx` so the command palette's static menu
 * (`CommandPalette.tsx`) renders the SAME list under the SAME gates: re-deriving them there
 * would hide an entry from somebody who may use it. `membership-plans` in particular is
 * deliberately ungated — every member picks their own plan.
 */
import type { Role } from '@sideline/domain';
import {
  Activity,
  BookOpen,
  Calendar,
  CalendarCog,
  CreditCard,
  Dumbbell,
  Hash,
  Home,
  IdCard,
  Landmark,
  Link2,
  Receipt,
  ReceiptText,
  Rss,
  Settings,
  Shield,
  Sparkles,
  Target,
  Trophy,
  UserCog,
  Users,
  UsersRound,
  Wallet,
  Wand2,
} from 'lucide-react';
import type React from 'react';
import { DiscordIcon } from '~/components/atoms/DiscordIcon.js';
import { tr } from '~/lib/translations.js';

export interface NavGroup {
  id: string;
  label: string;
  items: ReadonlyArray<NavItem>;
}

// The nav row already renders the visible label `tr('discord_navTitle')` right next to this
// icon (`<item.icon /><span>{item.title}</span>`, below) — `DiscordIcon`'s default
// `role='img' aria-label='Discord'` would announce "Discord, Discord" to a screen reader.
// `<item.icon />` is rendered with no props for every nav item, so this wrapper is how the
// Discord entry alone opts into `aria-hidden` without widening `NavItem.icon`'s prop-less type.
function DiscordNavIcon() {
  return <DiscordIcon aria-hidden />;
}

export interface NavItem {
  title: string;
  // Widened from `LucideIcon` so `DiscordIcon` (a plain function component, not a lucide
  // `ForwardRefExoticComponent`) can share this list — rendered as `<item.icon />` with no
  // props, so no lucide-specific prop is ever required here.
  icon: React.ComponentType;
  to: string;
  params?: Record<string, string>;
  requiredPermission?: Role.Permission;
  exact?: boolean;
  /** designer §2.3 — the sidebar nav badge dot. Currently only the Discord item uses this. */
  needsAttention?: boolean;
}

export function getTeamNavGroups(
  teamId: string,
  discordNeedsAttention: boolean,
): ReadonlyArray<NavGroup> {
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
          title: tr('discord_navTitle'),
          icon: DiscordNavIcon,
          to: '/teams/$teamId/connect-discord',
          params: { teamId },
          needsAttention: discordNeedsAttention,
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
        {
          // No `requiredPermission` — every member may open this. The server
          // (`getRulesLeaderboard`) decides team-vs-self scope; gating the
          // nav entry here would wrongly hide it from ordinary members.
          title: tr('rules_navTitle'),
          icon: BookOpen,
          to: '/teams/$teamId/rules',
          params: { teamId },
        },
        {
          // No `requiredPermission` — every member may ask; the server decides what they may
          // see (assistant design §1, same precedent as `rules` above).
          title: tr('assistant_navTitle'),
          icon: Sparkles,
          to: '/teams/$teamId/assistant',
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
          title: tr('channels_title'),
          icon: Hash,
          to: '/teams/$teamId/channels',
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
          // Reuses `team:manage`, unlike training-types/activity-types above — captains do NOT
          // see this entry (plan §0 trade-off, reversible with a 4-line grant migration).
          title: tr('eventType_title'),
          icon: CalendarCog,
          to: '/teams/$teamId/event-types',
          params: { teamId },
          requiredPermission: 'team:manage' satisfies Role.Permission,
        },
      ],
    },
    {
      // Every entry here is ungated or `finance:*`-gated, so an ordinary member sees this
      // group reduced to the two personal entries; `getTeamNavGroups`'s caller drops it
      // entirely if permissions empty it out.
      id: 'finance',
      label: tr('sidebar_finance'),
      items: [
        {
          title: tr('my_payments_navTitle'),
          icon: CreditCard,
          to: '/teams/$teamId/my-payments',
          params: { teamId },
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
          // Ungated — every member picks their own plan here (Slice 2 of "Setup
          // memberships"), not just captains.
          title: tr('membershipPlan_title'),
          icon: IdCard,
          to: '/teams/$teamId/membership-plans',
          params: { teamId },
        },
        {
          title: tr('expenses_navTitle'),
          icon: ReceiptText,
          to: '/teams/$teamId/finances/expenses',
          params: { teamId },
          requiredPermission: 'finance:view' satisfies Role.Permission,
        },
        {
          // Gated on `finance:record_payments`, not `finance:view` — this page lists the
          // name, account number and payment message of everyone who paid the club
          // (design §3.2), which is not roster-level information.
          title: tr('bank_navTitle'),
          icon: Landmark,
          to: '/teams/$teamId/finances/bank',
          params: { teamId },
          requiredPermission: 'finance:record_payments' satisfies Role.Permission,
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

/**
 * Drops entries the caller lacks the permission for, then drops any group left empty. The ONE
 * place this filter lives — the sidebar and the palette must never answer it differently.
 */
export function filterNavGroups(
  groups: ReadonlyArray<NavGroup>,
  permissions: ReadonlyArray<Role.Permission>,
): ReadonlyArray<NavGroup> {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => !item.requiredPermission || permissions.includes(item.requiredPermission),
      ),
    }))
    .filter((group) => group.items.length > 0);
}
