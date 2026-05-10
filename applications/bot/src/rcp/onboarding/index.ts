import { type Effect, Layer, ServiceMap } from 'effect';
import { ProcessorService } from './ProcessorService.js';

const make = ProcessorService;

export class OnboardingSyncService extends ServiceMap.Service<
  OnboardingSyncService,
  Effect.Success<typeof make>
>()('bot/OnboardingSyncService') {
  static readonly Default = Layer.effect(OnboardingSyncService, make);
}
