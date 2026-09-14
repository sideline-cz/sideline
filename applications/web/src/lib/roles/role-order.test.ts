import { describe, expect, it } from 'vitest';
import { sortEffectiveRoles } from './role-order.js';

describe('sortEffectiveRoles', () => {
  it('puts built-in roles before custom roles', () => {
    const roles = [
      { name: 'Striker', isBuiltIn: false },
      { name: 'Player', isBuiltIn: true },
    ];

    expect(sortEffectiveRoles(roles).map((r) => r.name)).toEqual(['Player', 'Striker']);
  });

  it('orders built-in roles by fixed privilege rank, not alphabetically', () => {
    const roles = [
      { name: 'Player', isBuiltIn: true },
      { name: 'Treasurer', isBuiltIn: true },
      { name: 'Admin', isBuiltIn: true },
      { name: 'Captain', isBuiltIn: true },
    ];

    expect(sortEffectiveRoles(roles).map((r) => r.name)).toEqual([
      'Admin',
      'Captain',
      'Treasurer',
      'Player',
    ]);
  });

  it('orders custom roles alphabetically', () => {
    const roles = [
      { name: 'Zeta squad', isBuiltIn: false },
      { name: 'Alpha squad', isBuiltIn: false },
    ];

    expect(sortEffectiveRoles(roles).map((r) => r.name)).toEqual(['Alpha squad', 'Zeta squad']);
  });

  it('does not mutate the input array', () => {
    const roles = [
      { name: 'Zeta', isBuiltIn: false },
      { name: 'Alpha', isBuiltIn: false },
    ];
    const original = [...roles];

    sortEffectiveRoles(roles);

    expect(roles).toEqual(original);
  });
});
