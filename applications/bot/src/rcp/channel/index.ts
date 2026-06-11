import { type Effect, Layer, ServiceMap } from 'effect';
import { BackfillService } from './BackfillService.js';
import { ProcessorService } from './ProcessorService.js';

const make = ProcessorService;

export class ChannelSyncService extends ServiceMap.Service<
  ChannelSyncService,
  Effect.Success<typeof make>
>()('bot/ChannelSyncService') {
  static readonly Default = Layer.effect(ChannelSyncService, make);
}

const makeBackfill = BackfillService;

export class ChannelBackfillService extends ServiceMap.Service<
  ChannelBackfillService,
  Effect.Success<typeof makeBackfill>
>()('bot/ChannelBackfillService') {
  static readonly Default = Layer.effect(ChannelBackfillService, makeBackfill);
}
