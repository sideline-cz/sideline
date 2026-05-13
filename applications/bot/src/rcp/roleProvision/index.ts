import { type Effect, Layer, ServiceMap } from 'effect';
import { ProcessorService } from './ProcessorService.js';

const make = ProcessorService;

export class RoleProvisionSyncService extends ServiceMap.Service<
  RoleProvisionSyncService,
  Effect.Success<typeof make>
>()('bot/RoleProvisionSyncService') {
  static readonly Default = Layer.effect(RoleProvisionSyncService, make);
}
