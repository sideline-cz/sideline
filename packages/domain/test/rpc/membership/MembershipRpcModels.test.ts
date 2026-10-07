// Wire-compatibility for the Discord membership RPC under "Give a season real dates".
//
// Pattern: `test/rpc/event/EventRpcModels.test.ts`.

import { describe, expect, it } from '@effect/vitest';
import { Option, Schema } from 'effect';
import * as MembershipRpcModels from '~/rpc/membership/MembershipRpcModels.js';

const PLAN_ID = '00000000-0000-0000-0000-0000000000a1';

const planWire = {
  plan_id: PLAN_ID,
  name: 'Adult membership',
  price_minor: 45000,
  currency: 'CZK',
  price_per_training_minor: 8000,
  free_trainings_included: 0,
  is_default: true,
};

describe('MembershipSelectionView.season_expires_at', () => {
  // CASE 41c — THE ROLLING-DEPLOY DIRECTION, and the one that 500s a live Discord surface if it
  // is wrong. Deploy order is bot -> server -> web, so for the whole window between the bot
  // rolling and the server rolling, a NEW bot decodes an OLD server's payload where this key is
  // simply ABSENT. `OptionFromOptionalKey` is required; `OptionFromNullOr` would make the key
  // mandatory and break /membership and every ephemeral picker for that entire window.
  //
  // It degrades in the direction that actually happens: absent -> None -> "not ended" -> the bot
  // shows the deadline line, exactly as it does today.
  it('decodes with season_expires_at ABSENT -> None (an OLD server’s payload)', () => {
    const decoded = Schema.decodeUnknownSync(MembershipRpcModels.MembershipSelectionView)({
      plans: [planWire],
      selected_plan_id: null,
      deadline: null,
      can_manage: false,
    });

    expect(Option.isNone(decoded.season_expires_at)).toBe(true);
    expect(Option.isNone(decoded.deadline)).toBe(true);
  });

  // The two dates travel SEPARATELY, end to end. An earlier revision collapsed them into
  // `LEAST(deadline, expiry)` and put one instant on the wire; from one instant no consumer can
  // tell "deadline passed" (ask a team admin) from "season ended" (you keep your plan until the
  // next season), and those need different copy and different next actions.
  it('carries BOTH dates independently when the server emits them', () => {
    const decoded = Schema.decodeUnknownSync(MembershipRpcModels.MembershipSelectionView)({
      plans: [planWire],
      selected_plan_id: PLAN_ID,
      deadline: '2026-08-25T21:59:59.999Z',
      season_expires_at: '2026-06-30T21:59:59.999Z',
      can_manage: false,
    });

    expect(Option.isSome(decoded.deadline)).toBe(true);
    expect(Option.isSome(decoded.season_expires_at)).toBe(true);
    // The expiry is EARLIER than the deadline here on purpose — the shape a LEAST() collapse makes
    // unrepresentable, and a legal row the DB has no CHECK against.
  });

  // `deadline` is UNCHANGED (required key, `OptionFromNullOr`): the server has always emitted it,
  // so there is no absent-key case to tolerate and adding tolerance would hide a real bug.
  it('still REQUIRES the deadline key — only the new field is optional', () => {
    expect(() =>
      Schema.decodeUnknownSync(MembershipRpcModels.MembershipSelectionView)({
        plans: [planWire],
        selected_plan_id: null,
        can_manage: false,
      }),
    ).toThrow();
  });
});
