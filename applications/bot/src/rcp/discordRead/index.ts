import { type Effect, Layer, ServiceMap } from 'effect';
import { ProcessorService } from './ProcessorService.js';

const make = ProcessorService;

export class DiscordReadSyncService extends ServiceMap.Service<
  DiscordReadSyncService,
  Effect.Success<typeof make>
>()('bot/DiscordReadSyncService') {
  static readonly Default = Layer.effect(DiscordReadSyncService, make);
}
