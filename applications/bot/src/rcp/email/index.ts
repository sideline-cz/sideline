import { type Effect, Layer, ServiceMap } from 'effect';
import { ProcessorService } from './ProcessorService.js';

export { handleEmailPostEvent } from './handleEmailPostEvent.js';

const make = ProcessorService;

export class EmailSyncService extends ServiceMap.Service<
  EmailSyncService,
  Effect.Success<typeof make>
>()('bot/EmailSyncService') {
  static readonly Default = Layer.effect(EmailSyncService, make);
}
