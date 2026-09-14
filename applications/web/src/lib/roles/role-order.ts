import { getLocale } from '@sideline/i18n/runtime';

/**
 * Deterministic display order for a member's effective roles:
 *
 * 1. Built-in before custom (`isBuiltIn` desc).
 * 2. Within built-in, a FIXED privilege rank — Admin > Captain > Treasurer > Player — rather
 *    than `permissionCount`, because permissions are editable per team and would otherwise
 *    silently reshuffle the badge order between teams. Built-in role names cannot be renamed
 *    (`applications/server/src/api/role.ts` blocks it), so matching on the literal name is safe.
 * 3. Within custom, locale-aware alphabetical (`localeCompare`) — a plain `<` mis-sorts Czech
 *    diacritics (e.g. `Č` sorting after `Z`).
 *
 * `source` ('direct' | 'inherited' | 'both') is deliberately NOT a sort dimension — the visual
 * treatment (dashed border, icon) carries that distinction; interleaving direct/inherited here
 * would break the "built-ins first" scan.
 */

interface EffectiveRoleLike {
  readonly name: string;
  readonly isBuiltIn: boolean;
}

const BUILT_IN_RANK: Record<string, number> = {
  Admin: 0,
  Captain: 1,
  Treasurer: 2,
  Player: 3,
};

export function sortEffectiveRoles<T extends EffectiveRoleLike>(
  roles: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const locale = getLocale();
  return [...roles].sort((a, b) => {
    if (a.isBuiltIn !== b.isBuiltIn) return a.isBuiltIn ? -1 : 1;
    if (a.isBuiltIn && b.isBuiltIn) {
      const rankA = BUILT_IN_RANK[a.name] ?? Number.MAX_SAFE_INTEGER;
      const rankB = BUILT_IN_RANK[b.name] ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
    }
    return a.name.localeCompare(b.name, locale);
  });
}
