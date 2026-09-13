import { describe, expect, it } from 'vitest';
import { resolveEffectiveRoles } from './resolveEffectiveRoles.js';

describe('resolveEffectiveRoles', () => {
  it('uses effectiveRoles verbatim when present', () => {
    const player = {
      roleNames: ['Captain', 'Host'],
      effectiveRoles: [
        {
          roleId: 'r-1',
          name: 'Captain',
          isBuiltIn: false,
          source: 'direct' as const,
          groupNames: [],
        },
        {
          roleId: 'r-2',
          name: 'Host',
          isBuiltIn: false,
          source: 'inherited' as const,
          groupNames: ['Leadership'],
        },
      ],
    };

    expect(resolveEffectiveRoles(player)).toEqual(player.effectiveRoles);
  });

  it('falls back to roleNames as all-direct when effectiveRoles is empty', () => {
    const player = { roleNames: ['Captain', 'Striker'], effectiveRoles: [] };

    const result = resolveEffectiveRoles(player);

    expect(result).toEqual([
      { roleId: 'Captain', name: 'Captain', isBuiltIn: false, source: 'direct', groupNames: [] },
      { roleId: 'Striker', name: 'Striker', isBuiltIn: false, source: 'direct', groupNames: [] },
    ]);
  });

  it('falls back to roleNames as all-direct when effectiveRoles is absent entirely', () => {
    const player = { roleNames: ['Captain'] };

    expect(resolveEffectiveRoles(player)).toEqual([
      { roleId: 'Captain', name: 'Captain', isBuiltIn: false, source: 'direct', groupNames: [] },
    ]);
  });

  it('resolves the real roleId/isBuiltIn from availableRoles in the fallback path', () => {
    const player = { roleNames: ['Captain'], effectiveRoles: [] };
    const availableRoles = [{ roleId: 'role-captain', name: 'Captain', isBuiltIn: true }];

    expect(resolveEffectiveRoles(player, availableRoles)).toEqual([
      {
        roleId: 'role-captain',
        name: 'Captain',
        isBuiltIn: true,
        source: 'direct',
        groupNames: [],
      },
    ]);
  });

  it('returns an empty list when there are no roles at all', () => {
    expect(resolveEffectiveRoles({ roleNames: [], effectiveRoles: [] })).toEqual([]);
  });
});
