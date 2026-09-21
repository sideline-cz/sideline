import type { AiChatApi, Auth } from '@sideline/domain';
import { Link, Outlet, useMatches, useNavigate, useRouter } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import React from 'react';
import { AppSidebar } from '~/components/layouts/AppSidebar';
import { PwaInstallPrompt } from '~/components/molecules/PwaInstallPrompt.js';
import { CommandPalette } from '~/components/organisms/CommandPalette.js';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '~/components/ui/breadcrumb';
import { Button } from '~/components/ui/button';
import { Separator } from '~/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from '~/components/ui/sidebar';
import { ENTITY_ROUTE } from '~/lib/assistant/entityRoutes.js';
import { tr } from '~/lib/translations.js';

// `navigator.userAgent.includes('Mac')` (design §3.2), computed once per module — not per
// render, it never changes for the life of the tab.
const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');

interface BreadcrumbEntry {
  label: string;
  to: string;
}

function useBreadcrumbs(): ReadonlyArray<BreadcrumbEntry> {
  const matches = useMatches();

  return React.useMemo(() => {
    const crumbs: BreadcrumbEntry[] = [];

    for (const match of matches) {
      const routeId = match.routeId;
      // Skip the root and layout group routes
      if (routeId === '__root__' || routeId === '/(authenticated)') continue;

      const pathname = match.pathname;

      if (routeId.includes('/create-team')) {
        crumbs.push({ label: tr('breadcrumb_createTeam'), to: pathname });
      } else if (routeId.includes('/profile/complete')) {
        crumbs.push({ label: tr('breadcrumb_profile'), to: '/profile' });
        crumbs.push({ label: tr('breadcrumb_complete'), to: pathname });
      } else if (routeId.includes('/profile')) {
        crumbs.push({ label: tr('breadcrumb_profile'), to: pathname });
      } else if (routeId.includes('/teams/$teamId/')) {
        // Team sub-pages: add the team crumb, then the sub-page
        const teamId = (match.params as Record<string, string>).teamId;
        if (teamId && !crumbs.some((c) => c.to.includes('/teams/'))) {
          crumbs.push({ label: tr('breadcrumb_team'), to: `/teams/${teamId}` });
        }

        if (routeId.includes('/workout')) {
          crumbs.push({ label: tr('makanicko_title'), to: pathname });
        } else if (routeId.includes('/notifications')) {
          crumbs.push({ label: tr('notification_title'), to: pathname });
        } else if (routeId.includes('/assistant')) {
          crumbs.push({ label: tr('assistant_navTitle'), to: pathname });
        } else if (routeId.includes('/members')) {
          if (!crumbs.some((c) => c.to.endsWith('/members'))) {
            crumbs.push({ label: tr('team_members'), to: `/teams/${teamId}/members` });
          }
          if (routeId.includes('$memberId')) {
            crumbs.push({ label: tr('breadcrumb_details'), to: pathname });
          }
        } else if (routeId.includes('/roles')) {
          if (!crumbs.some((c) => c.to.endsWith('/roles'))) {
            crumbs.push({ label: tr('team_roles'), to: `/teams/${teamId}/roles` });
          }
          if (routeId.includes('$roleId')) {
            crumbs.push({ label: tr('breadcrumb_details'), to: pathname });
          }
        } else if (routeId.includes('/rosters')) {
          if (!crumbs.some((c) => c.to.endsWith('/rosters'))) {
            crumbs.push({ label: tr('team_rosters'), to: `/teams/${teamId}/rosters` });
          }
          if (routeId.includes('$rosterId')) {
            crumbs.push({ label: tr('breadcrumb_details'), to: pathname });
          }
        } else if (routeId.includes('/groups')) {
          if (!crumbs.some((c) => c.to.endsWith('/groups'))) {
            crumbs.push({ label: tr('team_groups'), to: `/teams/${teamId}/groups` });
          }
          if (routeId.includes('$groupId')) {
            crumbs.push({ label: tr('breadcrumb_details'), to: pathname });
          }
        } else if (routeId.includes('/channels')) {
          crumbs.push({ label: tr('channels_title'), to: pathname });
        } else if (routeId.includes('/age-thresholds')) {
          crumbs.push({ label: tr('team_ageThresholds'), to: pathname });
        } else if (routeId.includes('/finances/expenses')) {
          crumbs.push({ label: tr('expenses_navTitle'), to: pathname });
        } else if (routeId.includes('/finances/bank') || routeId.includes('/finances_/bank')) {
          crumbs.push({ label: tr('bank_navTitle'), to: pathname });
        }
      } else if (routeId === '/(authenticated)/teams/$teamId/') {
        const teamId = (match.params as Record<string, string>).teamId;
        crumbs.push({ label: tr('breadcrumb_team'), to: `/teams/${teamId}` });
      }
    }

    return crumbs;
  }, [matches]);
}

interface AuthenticatedLayoutProps {
  user: Auth.CurrentUser;
  teams: ReadonlyArray<Auth.UserTeam>;
  activeTeam: Auth.UserTeam;
  onLogout: () => void;
}

function AuthenticatedLayoutContent({
  user,
  teams,
  activeTeam,
  onLogout,
}: AuthenticatedLayoutProps) {
  const breadcrumbs = useBreadcrumbs();
  const { setOpenMobile } = useSidebar();
  const router = useRouter();
  const navigate = useNavigate();
  const teamId = activeTeam.teamId;

  const [searchOpen, setSearchOpen] = React.useState(false);

  React.useEffect(() => {
    const unsubscribe = router.subscribe('onBeforeLoad', () => {
      setOpenMobile(false);
    });
    return unsubscribe;
  }, [router, setOpenMobile]);

  // The per-kind switch (plan §C "Navigation per result kind"). `ENTITY_ROUTE` keeps every
  // branch typed — no inlined route strings.
  const onSelectHit = (hit: AiChatApi.SearchHit) => {
    switch (hit.kind) {
      case 'event':
        void navigate({ to: ENTITY_ROUTE.event, params: { teamId, eventId: hit.event.eventId } });
        return;
      case 'member':
        void navigate({ to: ENTITY_ROUTE.member, params: { teamId, memberId: hit.memberId } });
        return;
      case 'group':
        void navigate({ to: ENTITY_ROUTE.group, params: { teamId, groupId: hit.group.groupId } });
        return;
      case 'roster':
        void navigate({
          to: ENTITY_ROUTE.roster,
          params: { teamId, rosterId: hit.roster.rosterId },
        });
        return;
      case 'trainingType':
        void navigate({
          to: ENTITY_ROUTE.trainingType,
          params: { teamId, trainingTypeId: hit.trainingType.trainingTypeId },
        });
    }
  };

  const onAskAssistant = (question: string) => {
    void navigate({
      to: '/teams/$teamId/assistant',
      params: { teamId },
      search: { ask: question },
    });
  };

  return (
    <>
      <AppSidebar user={user} teams={teams} activeTeam={activeTeam} onLogout={onLogout} />
      <SidebarInset>
        <header className='sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 bg-background/95 backdrop-blur transition-[width,height] ease-linear supports-[backdrop-filter]:bg-background/60 group-has-[[data-collapsible=icon]]/sidebar-wrapper:h-12 pt-[env(safe-area-inset-top)]'>
          <div className='flex flex-1 min-w-0 items-center gap-2 px-4'>
            <SidebarTrigger className='-ml-1' />
            <Separator orientation='vertical' className='mr-2 h-4' />
            <Breadcrumb>
              <BreadcrumbList>
                {breadcrumbs.map((crumb, index) => {
                  const isLast = index === breadcrumbs.length - 1;

                  return (
                    <React.Fragment key={crumb.to}>
                      {index > 0 && <BreadcrumbSeparator className='hidden md:block' />}
                      <BreadcrumbItem
                        className={index < breadcrumbs.length - 1 ? 'hidden md:block' : undefined}
                      >
                        {isLast ? (
                          <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                        ) : (
                          <BreadcrumbLink asChild>
                            <Link to={crumb.to}>{crumb.label}</Link>
                          </BreadcrumbLink>
                        )}
                      </BreadcrumbItem>
                    </React.Fragment>
                  );
                })}
              </BreadcrumbList>
            </Breadcrumb>
          </div>
          <Button
            variant='ghost'
            size='sm'
            className='ml-auto mr-2'
            onClick={() => setSearchOpen(true)}
          >
            <Search className='size-4' aria-hidden='true' />
            <span className='sr-only'>{tr('search_title')}</span>
            <kbd className='hidden rounded border bg-muted px-1.5 text-[10px] text-muted-foreground sm:inline'>
              {isMac ? '⌘K' : 'Ctrl K'}
            </kbd>
          </Button>
        </header>
        <PwaInstallPrompt />
        <div className='flex flex-1 flex-col gap-4 p-4 pt-0'>
          <Outlet />
        </div>
      </SidebarInset>
      <CommandPalette
        teamId={teamId}
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onSelectHit={onSelectHit}
        onAskAssistant={onAskAssistant}
      />
    </>
  );
}

export function AuthenticatedLayout({
  user,
  teams,
  activeTeam,
  onLogout,
}: AuthenticatedLayoutProps) {
  return (
    <SidebarProvider>
      <AuthenticatedLayoutContent
        user={user}
        teams={teams}
        activeTeam={activeTeam}
        onLogout={onLogout}
      />
    </SidebarProvider>
  );
}
