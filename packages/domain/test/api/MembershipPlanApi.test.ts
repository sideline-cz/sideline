// Wire-compatibility tests for `api/MembershipPlanApi.ts` under "Give a season real dates".
//
// Every case here is a ROLLOUT guarantee, not a schema style check. Deploy order is
// bot -> server -> web, so for the whole rollout window a NEW server serves OLD web bundles, and
// a NEW bundle must survive a server ROLLBACK. Those two directions are different assertions and
// both are written out.
//
// TDD note: the domain contracts (Task 2) are already committed, so this file should compile and
// — unlike the server and web suites — may already pass. It is written anyway, because the shapes
// it pins are exactly the ones a later "tidy the Options" PR flattens.

import { describe, expect, it } from '@effect/vitest';
import { Option, Schema } from 'effect';
import * as MembershipPlanApi from '~/api/MembershipPlanApi.js';

const PLAN_ID = '00000000-0000-0000-0000-0000000000a1';
const TEAM_ID = '00000000-0000-0000-0000-000000000090';

/** The wire shape a Release-A server emits for one plan. */
const planWire = {
  membershipPlanId: PLAN_ID,
  teamId: TEAM_ID,
  name: 'Adult membership',
  priceMinor: 50000,
  currency: 'CZK',
  pricePerTrainingMinor: 0,
  freeTrainingsIncluded: 0,
  expiresAt: null,
  isDefault: false,
};

describe('MembershipPlanInfo.expiresAt — the dead field, kept for one release', () => {
  // CASE 41 — ONE assertion, and it is the ENTIRE Release-A read-side guarantee.
  //
  // `expiresAt` is dead (the handler hardcodes `Option.none()`, nothing reads the column), but it
  // is NOT removed from the schema this release: an already-loaded bundle's frozen copy declares
  // the key REQUIRED, so an absent key breaks every tab a manager left open. `OptionFromNullOr`
  // encodes `None` as a PRESENT key whose value is `null`, which is exactly what that copy needs —
  // so the schema is deliberately left UNCHANGED rather than made tolerant.
  //
  // The absent-key cases an earlier revision specified are dropped on purpose: no Release-A
  // producer emits an absent key, so testing for one tests nothing.
  it('encodes None as a PRESENT key whose value is null, never an absent key', () => {
    const decoded = Schema.decodeUnknownSync(MembershipPlanApi.MembershipPlanInfo)(planWire);
    expect(Option.isNone(decoded.expiresAt)).toBe(true);

    const encoded = Schema.encodeSync(MembershipPlanApi.MembershipPlanInfo)(decoded) as Record<
      string,
      unknown
    >;

    expect(Object.hasOwn(encoded, 'expiresAt')).toBe(true);
    expect(encoded.expiresAt).toBeNull();
  });
});

describe('MembershipPlanListResponse — the three NEW season keys', () => {
  const baseWire = {
    canManage: true,
    plans: [planWire],
    selectedPlanId: null,
    selectionDeadline: null,
    assignments: [],
  };

  // CASE 41b, direction 1 — an ALREADY-LOADED bundle's payload has never heard of these keys.
  // A required key here 500s nothing but breaks decoding outright for every open tab.
  it('decodes with currentSeason, nextSeason and seasonExpiresAt ALL ABSENT -> None each', () => {
    const decoded = Schema.decodeUnknownSync(MembershipPlanApi.MembershipPlanListResponse)(
      baseWire,
    );

    expect(Option.isNone(decoded.currentSeason)).toBe(true);
    expect(Option.isNone(decoded.nextSeason)).toBe(true);
    expect(Option.isNone(decoded.seasonExpiresAt)).toBe(true);
  });

  // CASE 41b, direction 2 — a NEW bundle against a ROLLED-BACK server. `{ onNoneEncoding: null }`
  // is what keeps the key present-and-null rather than vanishing, so a consumer reading
  // `body.currentSeason` gets `null` and not `undefined`. Both directions happen; both are tested.
  it('encodes None as a PRESENT null for all three', () => {
    const decoded = Schema.decodeUnknownSync(MembershipPlanApi.MembershipPlanListResponse)(
      baseWire,
    );

    const encoded = Schema.encodeSync(MembershipPlanApi.MembershipPlanListResponse)(
      decoded,
    ) as Record<string, unknown>;

    for (const key of ['currentSeason', 'nextSeason', 'seasonExpiresAt']) {
      expect(Object.hasOwn(encoded, key), `${key} must be present`).toBe(true);
      expect(encoded[key], `${key} must encode to null`).toBeNull();
    }
  });

  // The populated direction — the SEEDING contract. Each season object is the RAW column set of
  // ONE row; nothing here is derived, which is what makes "an input seeded from a value it then
  // writes back" structurally unreachable.
  it('round-trips a populated currentSeason / nextSeason pair column for column', () => {
    const decoded = Schema.decodeUnknownSync(MembershipPlanApi.MembershipPlanListResponse)({
      ...baseWire,
      currentSeason: {
        startsAt: '2026-09-01T00:00:00.000Z',
        selectionDeadline: '2026-09-15T21:59:59.999Z',
        expiresAt: null,
      },
      nextSeason: {
        startsAt: '2027-09-01T00:00:00.000Z',
        selectionDeadline: null,
        expiresAt: '2028-02-01T22:59:59.999Z',
      },
      seasonExpiresAt: null,
    });

    expect(Option.isSome(decoded.currentSeason)).toBe(true);
    expect(Option.isSome(decoded.nextSeason)).toBe(true);
    const current = Option.getOrThrow(decoded.currentSeason);
    const next = Option.getOrThrow(decoded.nextSeason);
    expect(Option.isSome(current.selectionDeadline)).toBe(true);
    expect(Option.isNone(current.expiresAt)).toBe(true);
    expect(Option.isNone(next.selectionDeadline)).toBe(true);
    expect(Option.isSome(next.expiresAt)).toBe(true);
  });
});

describe('MembershipPlanRequest — expiresAt is gone from the payload', () => {
  // CASE 42 — the mirror of the read-side guarantee, and why deleting the key outright is safe in
  // the SAME release the web still sends it. `onExcessProperty` defaults to `"ignore"` and nothing
  // in this repo overrides it, so an already-loaded bundle's save carries a key the server
  // silently DROPS rather than 400s on. Kept permanently rather than as a scratch check: the day
  // someone sets `onExcessProperty: "error"` globally, this is what tells them what it costs.
  it('decodes a body that still INCLUDES expiresAt, and the decoded value has no expiresAt', () => {
    const decoded = Schema.decodeUnknownSync(MembershipPlanApi.MembershipPlanRequest)({
      name: 'Adult membership',
      priceMinor: 50000,
      currency: 'CZK',
      pricePerTrainingMinor: 0,
      freeTrainingsIncluded: 0,
      expiresAt: '2027-01-01T00:00:00.000Z',
    });

    expect(Object.hasOwn(decoded, 'expiresAt')).toBe(false);
    expect(Option.getOrNull(decoded.name)).toBe('Adult membership');
  });
});

describe('SetSelectionDeadlineRequest.expiresAt — THREE distinct outcomes', () => {
  // CASE 43. The nested Option is load-bearing and is the single thing that breaks the rollout if
  // flattened:
  //   absent    -> None          = "keep the stored value" (what every OLD bundle sends)
  //   null      -> Some(None)    = "clear it"              (what a NEW bundle sends for an empty box)
  //   ISO       -> Some(Some(t)) = "set it"
  // Collapsing the nesting makes absent and null indistinguishable, and an old bundle's every save
  // then silently wipes the season's expiry. Three assertions, deliberately not parameterised —
  // each failure message should name the outcome it lost.
  it('absent means KEEP THE STORED VALUE -> Option.none() at the outer level', () => {
    const decoded = Schema.decodeUnknownSync(MembershipPlanApi.SetSelectionDeadlineRequest)({
      deadline: '2026-09-15T21:59:59.999Z',
    });

    expect(Option.isNone(decoded.expiresAt)).toBe(true);
  });

  it('an explicit null means CLEAR IT -> Some(None)', () => {
    const decoded = Schema.decodeUnknownSync(MembershipPlanApi.SetSelectionDeadlineRequest)({
      deadline: '2026-09-15T21:59:59.999Z',
      expiresAt: null,
    });

    expect(Option.isSome(decoded.expiresAt)).toBe(true);
    expect(Option.isNone(Option.getOrThrow(decoded.expiresAt))).toBe(true);
  });

  it('an ISO string means SET IT -> Some(Some(instant))', () => {
    const decoded = Schema.decodeUnknownSync(MembershipPlanApi.SetSelectionDeadlineRequest)({
      deadline: null,
      expiresAt: '2027-02-01T22:59:59.999Z',
    });

    expect(Option.isSome(decoded.expiresAt)).toBe(true);
    expect(Option.isSome(Option.getOrThrow(decoded.expiresAt))).toBe(true);
    // And the deadline's own `null` still means "clear the deadline" — a separate, UNCHANGED
    // non-nested Option, which is why an empty deadline box needs no tolerance of its own.
    expect(Option.isNone(decoded.deadline)).toBe(true);
  });
});

describe('UpsertNextSeasonRequest', () => {
  // Deliberately NOT tolerant: this endpoint is new, so there is no old bundle to be tolerant of,
  // and every Save sends the whole block — a missing key would be a bug, not a rollout artefact.
  it('requires startsAt and takes null for both optional dates', () => {
    const decoded = Schema.decodeUnknownSync(MembershipPlanApi.UpsertNextSeasonRequest)({
      startsAt: '2027-09-01T00:00:00.000Z',
      deadline: null,
      expiresAt: null,
    });

    expect(Option.isNone(decoded.deadline)).toBe(true);
    expect(Option.isNone(decoded.expiresAt)).toBe(true);
  });

  it('rejects a payload with no startsAt — the slot key is never optional', () => {
    expect(() =>
      Schema.decodeUnknownSync(MembershipPlanApi.UpsertNextSeasonRequest)({
        deadline: null,
        expiresAt: null,
      }),
    ).toThrow();
  });
});
