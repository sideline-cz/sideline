import type { Auth } from '@sideline/domain';
import { Link, Outlet, useMatches, useRouter } from '@tanstack/react-router';
import React from 'react';
import { AppSidebar } from '~/components/layouts/AppSidebar';
import { PwaInstallPrompt } from '~/components/molecules/PwaInstallPrompt.js';
import { PendingDiscordJoinBanner } from '~/components/organisms/PendingDiscordJoinBanner';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '~/components/ui/breadcrumb';
import { Separator } from '~/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from '~/components/ui/sidebar';
import { tr } from '~/lib/translations.js';

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
        } else if (routeId.includes('/age-thresholds')) {
          crumbs.push({ label: tr('team_ageThresholds'), to: pathname });
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

  React.useEffect(() => {
    const unsubscribe = router.subscribe('onBeforeLoad', () => {
      setOpenMobile(false);
    });
    return unsubscribe;
  }, [router, setOpenMobile]);

  return (
    <>
      <AppSidebar user={user} teams={teams} activeTeam={activeTeam} onLogout={onLogout} />
      <SidebarInset>
        <PendingDiscordJoinBanner />
        <header className='sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 bg-background/95 backdrop-blur transition-[width,height] ease-linear supports-[backdrop-filter]:bg-background/60 group-has-[[data-collapsible=icon]]/sidebar-wrapper:h-12 pt-[env(safe-area-inset-top)]'>
          <div className='flex items-center gap-2 px-4'>
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
        </header>
        <PwaInstallPrompt />
        <div className='flex flex-1 flex-col gap-4 p-4 pt-0'>
          <Outlet />
        </div>
      </SidebarInset>
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
