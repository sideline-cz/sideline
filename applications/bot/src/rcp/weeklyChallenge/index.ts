import { type Effect, Layer, ServiceMap } from 'effect';
import { ProcessorService } from './ProcessorService.js';

const make = ProcessorService;

export class WeeklyChallengeSyncService extends ServiceMap.Service<
  WeeklyChallengeSyncService,
  Effect.Success<typeof make>
>()('bot/WeeklyChallengeSyncService') {
  static readonly Default = Layer.effect(WeeklyChallengeSyncService, make);
}
