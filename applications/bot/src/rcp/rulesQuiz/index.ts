import { type Effect, Layer, ServiceMap } from 'effect';
import { ProcessorService } from './ProcessorService.js';

const make = ProcessorService;

export class RulesQuizSyncService extends ServiceMap.Service<
  RulesQuizSyncService,
  Effect.Success<typeof make>
>()('bot/RulesQuizSyncService') {
  static readonly Default = Layer.effect(RulesQuizSyncService, make);
}
