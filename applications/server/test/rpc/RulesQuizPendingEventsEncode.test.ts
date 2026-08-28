// The scheduled rules quiz never once worked in production, and this is the
// test that would have said so.
//
// `RulesQuizRpcLive` returned `RulesQuizSyncEventRow` values straight from the
// repository while the RPC declared `Schema.Array(RulesQuizPendingEvent)`.
// The two classes carry identical fields, so the handler type-checked — but
// `Schema.Class` is NOMINAL, and encoding one against the other fails:
//
//   Expected RulesQuizPendingEvent, got RulesQuizSyncEventRow({...})
//
// Nothing surfaced it because encoding only happens when a row exists, and the
// outbox was empty from the day the feature shipped until the first team
// enabled it. The failure then repeated every five seconds for 27 minutes,
// with `attempts` stuck at 0 and `last_error` NULL, because the defect
// bypassed the handler that writes those columns.
//
// So this asserts the thing types cannot: that a row shaped exactly as the
// repository produces it survives the RPC's own encoder.

import { describe, expect, it } from '@effect/vitest';
import { RulesQuizRpcGroup } from '@sideline/domain';
import { Effect, Schema } from 'effect';
import { RulesQuizSyncEventRow } from '~/repositories/RulesQuizSyncEventsRepository.js';

/** Exactly the columns `findUnprocessed` selects, with values shaped like the
 * real ones from the incident. */
const ROW_FIELDS = {
  id: '2f80dc81-8ede-485f-83b7-a0d54b0b5ec3',
  team_id: 'e2686d09-6fd0-4e72-bd17-6f0f1fd4f7f0',
  guild_id: '1080098077664350249',
  channel_id: '1542510650516050002',
  scenario_id: 'eq1',
} as const;

const encodePending = Schema.encodeUnknownEffect(
  Schema.Array(RulesQuizRpcGroup.RulesQuizPendingEvent),
);

describe('RulesQuiz/PendingEvents encoding', () => {
  it.effect('encodes what the handler now returns', () =>
    Effect.gen(function* () {
      // What `RulesQuizRpcLive` maps rows into.
      const mapped = [new RulesQuizRpcGroup.RulesQuizPendingEvent({ ...ROW_FIELDS })];

      const encoded = yield* encodePending(mapped);

      expect(encoded).toHaveLength(1);
      expect(encoded[0]).toMatchObject({ scenario_id: 'eq1', guild_id: '1080098077664350249' });
    }),
  );

  it.effect('rejects the raw repository row — the regression itself', () =>
    Effect.gen(function* () {
      // Passing the row through unmapped is what shipped. If a future change
      // drops the mapping, this stops failing and the test starts failing.
      const raw = [Schema.decodeUnknownSync(RulesQuizSyncEventRow)(ROW_FIELDS)];

      const result = yield* Effect.result(encodePending(raw));

      expect(result._tag).toBe('Failure');
    }),
  );

  it('the two classes are structurally identical, which is why types missed it', () => {
    const row = Schema.decodeUnknownSync(RulesQuizSyncEventRow)(ROW_FIELDS);
    const event = new RulesQuizRpcGroup.RulesQuizPendingEvent({ ...ROW_FIELDS });

    // Same fields, same values — a structural comparison cannot tell them
    // apart, and neither can `tsc`. Only the encoder can.
    expect(Object.keys({ ...row }).sort()).toEqual(Object.keys({ ...event }).sort());
    expect({ ...row }).toEqual({ ...event });
  });
});
