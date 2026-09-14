/**
 * Resolves the flat, name-only `Roster.RosterPlayer.roleNames` and the richer, additive
 * `Roster.RosterPlayer.effectiveRoles` into a single list of role "views" the UI can render
 * uniformly — one badge per entry, each carrying provenance (`source`) and, for a role granted
 * via a group, the granting group name(s).
 *
 * `effectiveRoles` is an ADDITIVE field (`Schema.withDecodingDefaultKey(() => [])` on the wire,
 * and simply absent on older test fixtures / cached data). When it is empty, every entry in
 * `roleNames` is treated as `source: 'direct'` with no group attribution — the safe, back-compat
 * default described in `MemberSummaryHeader.test.tsx`.
 *
 * When `availableRoles` is supplied (the team's full role catalogue, `RoleApi.RoleInfo[]`), the
 * fallback path resolves the real `roleId`/`isBuiltIn` by matching on `name` — this preserves the
 * pre-fix behaviour of `PlayerDetailPage`'s role-removal control, which needs a real `roleId` to
 * call the unassign API even when the richer `effectiveRoles` payload is not present.
 */

export type EffectiveRoleSource = 'direct' | 'inherited' | 'both';

export interface EffectiveRoleView {
  readonly roleId: string;
  readonly name: string;
  readonly isBuiltIn: boolean;
  readonly source: EffectiveRoleSource;
  readonly groupNames: ReadonlyArray<string>;
}

interface PlayerLike {
  readonly roleNames: ReadonlyArray<string>;
  readonly effectiveRoles?: ReadonlyArray<{
    readonly roleId: string;
    readonly name: string;
    readonly isBuiltIn: boolean;
    readonly source: EffectiveRoleSource;
    readonly groupNames: ReadonlyArray<string>;
  }>;
}

interface RoleInfoLike {
  readonly roleId: string;
  readonly name: string;
  readonly isBuiltIn: boolean;
}

export function resolveEffectiveRoles(
  player: PlayerLike,
  availableRoles: ReadonlyArray<RoleInfoLike> = [],
): ReadonlyArray<EffectiveRoleView> {
  if (player.effectiveRoles !== undefined && player.effectiveRoles.length > 0) {
    return player.effectiveRoles.map((role) => ({
      roleId: role.roleId,
      name: role.name,
      isBuiltIn: role.isBuiltIn,
      source: role.source,
      groupNames: role.groupNames,
    }));
  }

  return player.roleNames.map((name) => {
    const known = availableRoles.find((role) => role.name === name);
    return {
      roleId: known?.roleId ?? name,
      name,
      isBuiltIn: known?.isBuiltIn ?? false,
      source: 'direct' as const,
      groupNames: [],
    };
  });
}
