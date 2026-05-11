import { type Effect, Layer, ServiceMap } from 'effect';
import { ProcessorService } from './ProcessorService.js';

const make = ProcessorService;

export class InviteGeneratorService extends ServiceMap.Service<
  InviteGeneratorService,
  Effect.Success<typeof make>
>()('bot/InviteGeneratorService') {
  static readonly Default = Layer.effect(InviteGeneratorService, make);
}
