// TDD mode — tests for pickAdoptableRole, the pure role-adoption selection rule.
// Will FAIL until applications/bot/src/rest/roles/adoptableGuildRole.ts exists and exports
// `pickAdoptableRole`.
//
// Spec: .work-plans/discord-onboarding-fix-plan.md, PR-6 step 1, decision CC-7.
//
// pickAdoptableRole is the safety boundary that stops ensureMapping's adoption path from ever
// handing out a Discord role that carries permissions, is integration-managed, or sits at/above
// the bot's own top role (which Discord would reject on assignment with a terminal 50013 — see
// CC-0). A candidate must satisfy ALL of:
//   - exact, case-sensitive name match
//   - managed === false
//   - permissions === '0' (strict string compare against Discord's string bitfield)
//   - position < botTopPosition
// and among survivors, the LOWEST position wins (furthest from the bot's own role, so the least
// likely to be invalidated by a later hierarchy change).

import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { pickAdoptableRole } from '~/rest/roles/adoptableGuildRole.js';

// ---------------------------------------------------------------------------
// Candidate role factory
// ---------------------------------------------------------------------------

type CandidateRole = {
  id: string;
  name: string;
  permissions: string;
  position: number;
  managed: boolean;
};

const makeRole = (overrides: Partial<CandidateRole> = {}): CandidateRole => ({
  id: '100000000000000001',
  name: 'Captain',
  permissions: '0',
  position: 1,
  managed: false,
  ...overrides,
});

describe('pickAdoptableRole', () => {
  it('adopts an exact-name, unmanaged, zero-permission role below the bot', () => {
    const role = makeRole({
      id: '1',
      name: 'Captain',
      permissions: '0',
      position: 3,
      managed: false,
    });

    const result = pickAdoptableRole([role], 'Captain', 10);

    expect(Option.isSome(result)).toBe(true);
    expect(Option.getOrThrow(result)).toMatchObject({ id: '1', position: 3 });
  });

  it('refuses a role carrying any non-zero permissions — the privilege-escalation guard', () => {
    // Named "Captain" with ADMINISTRATOR (bit 3, value 8). A club guild's hand-made "Captain" role
    // frequently carries this. Adopting it would let handleAssigned → addGuildMemberRole grant
    // guild admin to every Sideline role:manage holder. This is blocker 5(a)'s regression test.
    const adminRole = makeRole({
      id: '2',
      name: 'Captain',
      permissions: '8',
      position: 3,
      managed: false,
    });

    const result = pickAdoptableRole([adminRole], 'Captain', 10);

    expect(result).toEqual(Option.none());
  });

  it('refuses a managed role (integration/bot-owned)', () => {
    const managedRole = makeRole({
      id: '3',
      name: 'Captain',
      permissions: '0',
      position: 3,
      managed: true,
    });

    const result = pickAdoptableRole([managedRole], 'Captain', 10);

    expect(result).toEqual(Option.none());
  });

  it("refuses a role at the bot's top position (position === botTopPosition)", () => {
    const atTop = makeRole({
      id: '4',
      name: 'Captain',
      permissions: '0',
      position: 10,
      managed: false,
    });

    const result = pickAdoptableRole([atTop], 'Captain', 10);

    expect(result).toEqual(Option.none());
  });

  it("refuses a role above the bot's top position (position > botTopPosition)", () => {
    const aboveTop = makeRole({
      id: '5',
      name: 'Captain',
      permissions: '0',
      position: 11,
      managed: false,
    });

    const result = pickAdoptableRole([aboveTop], 'Captain', 10);

    expect(result).toEqual(Option.none());
  });

  it('is case-sensitive — does not adopt a differently-cased name', () => {
    // Guild has "captain" (lowercase), Sideline wants "Captain". Discord role names are
    // case-sensitive; fuzzy-matching the wrong role is worse than creating a new one.
    const lowerCased = makeRole({
      id: '6',
      name: 'captain',
      permissions: '0',
      position: 3,
      managed: false,
    });

    const result = pickAdoptableRole([lowerCased], 'Captain', 10);

    expect(result).toEqual(Option.none());
  });

  it('picks the LOWEST position when multiple valid candidates collide on name', () => {
    // Rev 2 took the highest position, which maximised the chance of picking a role the bot
    // cannot assign. PR-6 inverts that rule.
    const higher = makeRole({
      id: '7',
      name: 'Player',
      permissions: '0',
      position: 9,
      managed: false,
    });
    const lower = makeRole({
      id: '8',
      name: 'Player',
      permissions: '0',
      position: 3,
      managed: false,
    });

    const result = pickAdoptableRole([higher, lower], 'Player', 20);

    expect(Option.getOrThrow(result)).toMatchObject({ id: '8', position: 3 });
  });

  it('returns None for an empty role list', () => {
    const result = pickAdoptableRole([], 'Captain', 10);

    expect(result).toEqual(Option.none());
  });

  it('returns None when no role name matches — so the caller falls through to create', () => {
    const other = makeRole({
      id: '9',
      name: 'Not Captain',
      permissions: '0',
      position: 3,
      managed: false,
    });

    const result = pickAdoptableRole([other], 'Captain', 10);

    expect(result).toEqual(Option.none());
  });

  it('picks among valid survivors only, ignoring a same-named invalid near-miss', () => {
    // A managed near-miss at a lower position must not beat a valid, higher-position candidate.
    const managedNearMiss = makeRole({
      id: '10',
      name: 'Player',
      permissions: '0',
      position: 1,
      managed: true,
    });
    const valid = makeRole({
      id: '11',
      name: 'Player',
      permissions: '0',
      position: 5,
      managed: false,
    });

    const result = pickAdoptableRole([managedNearMiss, valid], 'Player', 20);

    expect(Option.getOrThrow(result)).toMatchObject({ id: '11', position: 5 });
  });

  it('nit: breaks an equal-position tie by id, not by input/listGuildRoles order', () => {
    // Discord does not document `listGuildRoles`'s return order as stable, so relying on
    // `Arr.sort`'s stability alone over an undocumented order is not a real guarantee. `id` is
    // the deterministic secondary key.
    const first = makeRole({
      id: '20',
      name: 'Player',
      permissions: '0',
      position: 3,
      managed: false,
    });
    const second = makeRole({
      id: '10',
      name: 'Player',
      permissions: '0',
      position: 3,
      managed: false,
    });

    // Feed them in an order where the naturally-lower id comes second — the result must still
    // pick the lower id, not "whichever came first in the input array".
    const result = pickAdoptableRole([first, second], 'Player', 20);

    expect(Option.getOrThrow(result)).toMatchObject({ id: '10', position: 3 });
  });

  // Table test pinning the `permissions === '0'` STRICT STRING COMPARE fail-closed guarantee —
  // the guarantee most likely to be broken by a refactor to `BigInt(permissions) === 0n` (throws
  // on `''`/`undefined`) or `Number(permissions) === 0` (`Number('') === 0` would wrongly accept
  // an empty string as "zero permissions").
  it.each`
    permissions  | label                                            | adoptable
    ${'0'}       | ${"'0' — the canonical zero bitfield"}           | ${true}
    ${0}         | ${'0 (number, not the canonical string)'}        | ${false}
    ${''}        | ${"'' (empty string)"}                           | ${false}
    ${undefined} | ${'undefined'}                                   | ${false}
    ${'00'}      | ${"'00' (zero-padded, not strict equal to '0')"} | ${false}
  `('permissions fail-closed guarantee: $label', ({ permissions, adoptable }) => {
    // Deliberately bypasses the `permissions: string` type to exercise runtime behavior against
    // inputs that violate the static contract (a malformed producer, or a future refactor).
    const role = {
      id: '30',
      name: 'Captain',
      permissions,
      position: 3,
      managed: false,
    } as any as CandidateRole;

    const result = pickAdoptableRole([role], 'Captain', 10);

    expect(Option.isSome(result)).toBe(adoptable);
  });
});
