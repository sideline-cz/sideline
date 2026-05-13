import { WeeklySummaryRpcEvents, WeeklySummaryRpcGroup } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { type DateTime, Effect, Option } from 'effect';
import { WeeklySummarySyncEventsRepository } from '~/repositories/WeeklySummaryRepository.js';

export const WeeklySummaryRpcLive = Effect.Do.pipe(
  Effect.bind('syncEvents', () => WeeklySummarySyncEventsRepository.asEffect()),
  Effect.let(
    'WeeklySummary/GetUnprocessedEvents',
    ({ syncEvents }) =>
      () =>
        syncEvents.findUnprocessed(50).pipe(
          Effect.map((rows) =>
            rows.map(
              (row) =>
                new WeeklySummaryRpcEvents.WeeklySummaryReadyEvent({
                  id: row.id,
                  team_id: row.team_id,
                  channel_id: row.channel_id,
                  week_start: row.week_start,
                  week_end: row.week_end,
                  payload: row.payload,
                }),
            ),
          ),
        ),
  ),
  Effect.let(
    'WeeklySummary/MarkEventProcessed',
    ({ syncEvents }) =>
      ({ id, deliveredAt }: { readonly id: string; readonly deliveredAt: DateTime.Utc }) =>
        syncEvents.markProcessed(id, Option.some(deliveredAt)),
  ),
  Effect.let(
    'WeeklySummary/MarkEventFailed',
    ({ syncEvents }) =>
      ({ id, error }: { readonly id: string; readonly error: string }) =>
        syncEvents.markFailed(id, error),
  ),
  Bind.remove('syncEvents'),
  (handlers) => WeeklySummaryRpcGroup.WeeklySummaryRpcGroup.toLayer(handlers),
);
