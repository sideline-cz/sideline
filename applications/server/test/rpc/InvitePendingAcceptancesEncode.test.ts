// The second instance of a bug this repo had already found, fixed and
// documented once.
//
// `InvitesRpcLive` returned `PendingAcceptanceRow` values straight from the
// repository while the RPC declared `Schema.Array(PendingAcceptanceEntry)`.
// The two carry identical fields, so the handler type-checked — but
// `Schema.Class` is NOMINAL, and encoding one against the other fails:
//
//   Expected PendingAcceptanceEntry, got PendingAcceptanceRow({...})
//
// It shipped in server v0.47.0 and stayed silent for ten days, because
// encoding only happens once a row exists. Releasing bot v0.39.0 started
// polling this outbox, and the tick then failed roughly once a second in
// production.
//
// `RulesQuizPendingEventsEncode.test.ts` is the same test for the same bug in
// `RulesQuiz/PendingEvents`. That one was written, and this RPC shipped broken
// anyway — the guard was never generalised to the other outboxes. Any new
// `success: Schema.Array(SomeDomainClass)` RPC needs one of these.

import { describe, expect, it } from '@effect/vitest';
import { type Discord, type InviteAcceptance, InviteRpcGroup } from '@sideline/domain';
import { Effect, Schema } from 'effect';
import { PendingAcceptanceRow } from '~/repositories/InviteAcceptancesRepository.js';

/** Exactly the columns `findPending` selects, with the values from the incident. */
const ROW_FIELDS = {
  acceptance_id: '1cdfef5e-06b8-454e-ac14-03ff5f714681' as InviteAcceptance.InviteAcceptanceId,
  guild_id: '1080098077664350249' as Discord.Snowflake,
  welcome_channel_id: '1080146792802435235' as Discord.Snowflake,
  bot_present: true,
} as const;

const encodePending = Schema.encodeUnknownEffect(
  Schema.Array(InviteRpcGroup.PendingAcceptanceEntry),
);

describe('Invite/PendingAcceptances encoding', () => {
  it.effect('encodes what the handler now returns', () =>
    Effect.gen(function* () {
      const mapped = [
        new InviteRpcGroup.PendingAcceptanceEntry({
          ...Schema.decodeUnknownSync(PendingAcceptanceRow)(ROW_FIELDS),
        }),
      ];

      const encoded = yield* encodePending(mapped);

      expect(encoded).toHaveLength(1);
      expect(encoded[0]).toMatchObject({
        acceptance_id: ROW_FIELDS.acceptance_id,
        guild_id: ROW_FIELDS.guild_id,
      });
    }),
  );

  it.effect('rejects the raw repository row — the regression itself', () =>
    Effect.gen(function* () {
      const raw = [Schema.decodeUnknownSync(PendingAcceptanceRow)(ROW_FIELDS)];

      const result = yield* Effect.result(encodePending(raw));

      expect(result._tag).toBe('Failure');
    }),
  );

  // PR-3 lifted the `welcome_channel_id IS NOT NULL` guard, so a team with no
  // welcome channel now genuinely reaches the encoder as null.
  it.effect('encodes a row with no welcome channel', () =>
    Effect.gen(function* () {
      const row = Schema.decodeUnknownSync(PendingAcceptanceRow)({
        ...ROW_FIELDS,
        welcome_channel_id: null,
        bot_present: false,
      });

      const encoded = yield* encodePending([new InviteRpcGroup.PendingAcceptanceEntry({ ...row })]);

      expect(encoded[0]).toMatchObject({ welcome_channel_id: null, bot_present: false });
    }),
  );

  it('the two classes are structurally identical, which is why types missed it', () => {
    const row = Schema.decodeUnknownSync(PendingAcceptanceRow)(ROW_FIELDS);
    const entry = new InviteRpcGroup.PendingAcceptanceEntry({ ...row });

    expect(Object.keys({ ...row }).sort()).toEqual(Object.keys({ ...entry }).sort());
    expect({ ...row }).toEqual({ ...entry });
  });
});
