import { type Effect, Layer, ServiceMap } from 'effect';
import { ProcessorService } from './ProcessorService.js';

const make = ProcessorService;

export class GuildJoinSyncService extends ServiceMap.Service<
  GuildJoinSyncService,
  Effect.Success<typeof make>
>()('bot/GuildJoinSyncService') {
  static readonly Default = Layer.effect(GuildJoinSyncService, make);
}
