import { describe, expect, it } from 'vitest';
import { hasDangerousPermissions } from '~/rest/roles/dangerousPermissions.js';

describe('hasDangerousPermissions', () => {
  it('is false for zero permissions', () => {
    expect(hasDangerousPermissions('0')).toBe(false);
  });

  it('is true for ADMINISTRATOR (8)', () => {
    expect(hasDangerousPermissions('8')).toBe(true);
  });

  it('is true for MANAGE_GUILD (32)', () => {
    expect(hasDangerousPermissions('32')).toBe(true);
  });

  it('is true for MANAGE_ROLES (268435456)', () => {
    expect(hasDangerousPermissions('268435456')).toBe(true);
  });

  it('is true for MANAGE_CHANNELS (16)', () => {
    expect(hasDangerousPermissions('16')).toBe(true);
  });

  it('is true for BAN_MEMBERS (4)', () => {
    expect(hasDangerousPermissions('4')).toBe(true);
  });

  it('is true for KICK_MEMBERS (2)', () => {
    expect(hasDangerousPermissions('2')).toBe(true);
  });

  it('is false for a harmless combination (VIEW_CHANNEL | SEND_MESSAGES = 1024+2048)', () => {
    expect(hasDangerousPermissions(String(1024 + 2048))).toBe(false);
  });

  it('is true when a dangerous bit is combined with harmless ones', () => {
    expect(hasDangerousPermissions(String(1024 + 8))).toBe(true);
  });

  // Fail-closed table: a malformed permissions string must never be silently treated as safe.
  // `BigInt('')` and `BigInt('  ')` coerce to `0n` rather than throwing — the exact trap that
  // would make a naive `BigInt(permissions) === 0n` rewrite fail OPEN on these inputs.
  it.each`
    input    | description
    ${''}    | ${'empty string'}
    ${'  '}  | ${'blank/whitespace'}
    ${'abc'} | ${'non-numeric'}
    ${'-1'}  | ${'negative'}
  `('fails closed (treats as dangerous) for $description', ({ input }) => {
    expect(hasDangerousPermissions(input)).toBe(true);
  });

  it('does not fail closed for a benign-looking zero-padded zero ("00")', () => {
    expect(hasDangerousPermissions('00')).toBe(false);
  });
});
