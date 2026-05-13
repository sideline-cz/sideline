import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import { UnprocessedWeeklySummaryEvent } from './WeeklySummaryRpcEvents.js';

const UUIDString = Schema.String.pipe(Schema.check(Schema.isUUID()));

export const WeeklySummaryRpcGroup = RpcGroup.make(
  Rpc.make('GetUnprocessedEvents', {
    success: Schema.Array(UnprocessedWeeklySummaryEvent),
  }),
  Rpc.make('MarkEventProcessed', {
    payload: { id: UUIDString, deliveredAt: Schema.DateTimeUtc },
  }),
  Rpc.make('MarkEventFailed', {
    payload: { id: UUIDString, error: Schema.String },
  }),
).prefix('WeeklySummary/');
