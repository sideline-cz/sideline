import * as React from 'react';
import { RoleBadge } from '~/components/molecules/RoleBadge.js';
import { Button } from '~/components/ui/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '~/components/ui/popover';
import { useIsMobile } from '~/hooks/use-mobile.js';
import type { EffectiveRoleView } from '~/lib/roles/resolveEffectiveRoles.js';
import { sortEffectiveRoles } from '~/lib/roles/role-order.js';
import { tr } from '~/lib/translations.js';
import { cn } from '~/lib/utils';

interface EffectiveRolesListProps {
  roles: ReadonlyArray<EffectiveRoleView>;
  /**
   * Fixed number of badges to show before collapsing the rest into "+n". When omitted, the
   * limit is responsive: 3 badges below the `sm` breakpoint, 5 at/above it (`useIsMobile`).
   * Callers with their own layout constraints (e.g. a dense table row in `PlayerRow`) pass an
   * explicit limit instead of relying on the viewport-driven default.
   */
  limit?: number;
  className?: string;
}

/**
 * A flat, wrapping `<ul>` of role badges with NO "primary" role — every effective role is
 * individually visible. Overflow beyond the limit collapses into a `+n` controlled by a
 * `Popover` (not a `Tooltip`): Radix tooltips do not open on touch, and the trigger must be a
 * real, keyboard-focusable `<Button>` (a bare `Badge` is a `<span>`, see `ui/badge.tsx`).
 */
export function EffectiveRolesList({ roles, limit, className }: EffectiveRolesListProps) {
  const isMobile = useIsMobile();
  const effectiveLimit = limit ?? (isMobile ? 3 : 5);
  const sorted = React.useMemo(() => sortEffectiveRoles(roles), [roles]);
  const visible = sorted.slice(0, effectiveLimit);
  const hiddenCount = sorted.length - visible.length;

  if (sorted.length === 0) return null;

  return (
    <ul
      className={cn('flex flex-wrap items-center gap-1.5', className)}
      aria-label={tr('roles_effectiveRolesAria')}
    >
      {visible.map((role) => (
        <li key={role.roleId}>
          <RoleBadge role={role} />
        </li>
      ))}
      {hiddenCount > 0 ? (
        <li>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type='button'
                variant='ghost'
                size='sm'
                className='h-auto min-h-[1.75rem] rounded-md border px-2 py-0.5 text-xs font-medium'
              >
                +{hiddenCount}
                <span className='sr-only'>
                  {tr('roles_showAllRolesAria', { count: hiddenCount })}
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align='start' className='w-64 p-2'>
              <PopoverTitle className='mb-2 px-1 text-sm'>{tr('roles_allRolesTitle')}</PopoverTitle>
              <ul className='flex flex-col gap-1'>
                {sorted.map((role) => (
                  <li key={role.roleId}>
                    <RoleBadge role={role} />
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        </li>
      ) : null}
    </ul>
  );
}
