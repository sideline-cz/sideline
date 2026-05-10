import { type Effect, Layer, ServiceMap } from 'effect';
import { OnboardingRoleCache } from '../../services/OnboardingRoleCache.js';
import { ProcessorService } from './ProcessorService.js';

const make = ProcessorService;

export class OnboardingSyncService extends ServiceMap.Service<
  OnboardingSyncService,
  Effect.Success<typeof make>
>()('bot/OnboardingSyncService') {
  static readonly Default = Layer.effect(OnboardingSyncService, make).pipe(
    Layer.provide(OnboardingRoleCache.Default),
  );
}
