import { describe, expect, it } from '@effect/vitest';
import { allPermissions, builtInRoleNames, defaultPermissions, Permission } from '~/models/Role.js';

describe('Role', () => {
  it('builtInRoleNames is [Admin, Captain, Player, Treasurer]', () => {
    expect(builtInRoleNames).toEqual(['Admin', 'Captain', 'Player', 'Treasurer']);
  });

  it('defaultPermissions has exactly one entry per built-in role name', () => {
    expect(Object.keys(defaultPermissions).sort()).toEqual([...builtInRoleNames].sort());
  });

  it('every permission in defaultPermissions is a valid Permission literal', () => {
    const allPerms = Object.values(defaultPermissions).flat();
    for (const perm of allPerms) {
      expect(Permission.literals).toContain(perm);
    }
  });

  it('defaultPermissions.Admin equals allPermissions as a set', () => {
    expect([...defaultPermissions.Admin].sort()).toEqual([...allPermissions].sort());
  });

  it('Captain only holds finance:view among finance permissions', () => {
    const captainFinance = defaultPermissions.Captain.filter((p) => p.startsWith('finance:'));
    expect(captainFinance).toEqual(['finance:view']);
  });

  it('defaultPermissions.Treasurer equals exactly [finance:view, finance:manage_fees, finance:record_payments]', () => {
    expect([...defaultPermissions.Treasurer].sort()).toEqual(
      ['finance:view', 'finance:manage_fees', 'finance:record_payments'].sort(),
    );
  });

  it('defaultPermissions.Player equals exactly [roster:view, member:view]', () => {
    expect([...defaultPermissions.Player].sort()).toEqual(['roster:view', 'member:view'].sort());
  });
});
