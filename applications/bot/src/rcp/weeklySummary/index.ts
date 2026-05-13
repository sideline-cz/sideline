import { type Effect, Layer, ServiceMap } from 'effect';
import { ProcessorService } from './ProcessorService.js';

export { handleWeeklySummaryReady } from './handleWeeklySummaryReady.js';

const make = ProcessorService;

export class WeeklySummarySyncService extends ServiceMap.Service<
  WeeklySummarySyncService,
  Effect.Success<typeof make>
>()('bot/WeeklySummarySyncService') {
  static readonly Default = Layer.effect(WeeklySummarySyncService, make);
}
