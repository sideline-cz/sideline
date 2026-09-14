import { Users } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import type { EffectiveRoleView } from '~/lib/roles/resolveEffectiveRoles.js';
import { tr } from '~/lib/translations.js';
import { cn } from '~/lib/utils';

interface RoleBadgeProps {
  role: EffectiveRoleView;
  className?: string;
}

/**
 * One effective role rendered as a single `Badge`. Distinguishes a group-inherited role from a
 * directly-assigned one through THREE redundant channels (never colour alone, so the distinction
 * survives forced-colors mode, greyscale, and screen readers):
 *
 * 1. Shape — a dashed border on an `inherited` role (solid on `direct` / `both`).
 * 2. Icon — a leading `Users` glyph (`aria-hidden`) on an `inherited` role.
 * 3. Accessible name — `aria-label` names the role AND the granting group(s) for `inherited`
 *    and `both` roles (a `both` role is still visually treated as direct — see `RolesSection` in
 *    `PlayerDetailPage.tsx` for why removing the direct grant is a real, non-no-op action — but
 *    the group attribution is still surfaced to assistive tech via `data-role-source`/`aria-label`).
 *
 * Only variants that already ship in `ui/badge.tsx` are used (`secondary` / `outline`) — no new
 * variant is introduced.
 */
export function RoleBadge({ role, className }: RoleBadgeProps) {
  const isDashed = role.source === 'inherited';
  const hasGroupAttribution = role.source === 'inherited' || role.source === 'both';

  // The group name(s) are passed as the `{group}` ICU placeholder (like every sibling string
  // in this feature — `roles_manageInGroupTooltip`, `roles_removeRoleStillInheritedDescription`)
  // so a translator can reorder the phrase where needed. For the plural key the group list is
  // pre-joined into a single string and passed as that one placeholder value.
  const groupAttribution =
    role.groupNames.length > 1
      ? tr('roles_inheritedFromGroups', { group: role.groupNames.join(tr('common_listSeparator')) })
      : role.groupNames.length === 1
        ? tr('roles_inheritedFromGroup', { group: role.groupNames[0] })
        : undefined;

  const ariaLabel = hasGroupAttribution
    ? groupAttribution !== undefined
      ? `${role.name} — ${groupAttribution}`
      : `${role.name}${tr('roles_inheritedSrSuffix')}`
    : undefined;

  return (
    <Badge
      variant={isDashed ? 'outline' : 'secondary'}
      className={cn(isDashed && 'border-dashed', className)}
      data-role-source={hasGroupAttribution ? role.source : undefined}
      aria-label={ariaLabel}
    >
      {isDashed ? <Users className='size-3' aria-hidden='true' /> : null}
      <span className='max-w-[10rem] truncate'>{role.name}</span>
    </Badge>
  );
}
