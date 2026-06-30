import { type Effect, Layer, ServiceMap } from 'effect';
import { ProcessorService } from './ProcessorService.js';

const make = ProcessorService;

export class PersonalEventsSyncService extends ServiceMap.Service<
  PersonalEventsSyncService,
  Effect.Success<typeof make>
>()('bot/PersonalEventsSyncService') {
  static readonly Default = Layer.effect(PersonalEventsSyncService, make);
}
