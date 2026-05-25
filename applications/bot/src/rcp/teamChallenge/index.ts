import { type Effect, Layer, ServiceMap } from 'effect';
import { ProcessorService } from './ProcessorService.js';

const make = ProcessorService;

export class TeamChallengeSyncService extends ServiceMap.Service<
  TeamChallengeSyncService,
  Effect.Success<typeof make>
>()('bot/TeamChallengeSyncService') {
  static readonly Default = Layer.effect(TeamChallengeSyncService, make);
}
