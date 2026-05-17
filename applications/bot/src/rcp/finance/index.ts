import { type Effect, Layer, ServiceMap } from 'effect';
import { ProcessorService } from './ProcessorService.js';

export { handlePaymentReminderReady } from './handlePaymentReminderReady.js';

const make = ProcessorService;

export class FinanceSyncService extends ServiceMap.Service<
  FinanceSyncService,
  Effect.Success<typeof make>
>()('bot/FinanceSyncService') {
  static readonly Default = Layer.effect(FinanceSyncService, make);
}
