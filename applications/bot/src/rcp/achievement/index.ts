import { type Effect, Layer, ServiceMap } from 'effect';
import { ProcessorService } from './ProcessorService.js';

const make = ProcessorService;

export class AchievementSyncService extends ServiceMap.Service<
  AchievementSyncService,
  Effect.Success<typeof make>
>()('bot/AchievementSyncService') {
  static readonly Default = Layer.effect(AchievementSyncService, make);
}
