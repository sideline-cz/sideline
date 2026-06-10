import { Effect, Layer, Option } from 'effect';
import { EventRosterRequestsRepository } from '~/repositories/EventRosterRequestsRepository.js';
import { EventRostersRepository } from '~/repositories/EventRostersRepository.js';
import { EventRosterProvisioningService } from '~/services/EventRosterProvisioningService.js';

export const MockEventRostersRepositoryLayer = Layer.succeed(EventRostersRepository, {
  findByEventId: () => Effect.succeed(Option.none()),
  link: () => Effect.die(new Error('Not implemented')),
  unlink: () => Effect.void,
  setAutoApprove: () => Effect.void,
  saveThreadIfAbsent: () => Effect.succeed(Option.none()),
  clearThread: () => Effect.void,
} as any);

export const MockEventRosterRequestsRepositoryLayer = Layer.succeed(EventRosterRequestsRepository, {
  findByEventAndMember: () => Effect.succeed(Option.none()),
  upsertApproved: () => Effect.die(new Error('Not implemented')),
  upsertPending: () => Effect.die(new Error('Not implemented')),
  claimDecision: () => Effect.succeed(Option.none()),
  cancel: () => Effect.succeed(Option.none()),
  saveMessageId: () => Effect.void,
  findPendingByEvent: () => Effect.succeed([]),
  findPendingByRoster: () => Effect.succeed([]),
  wasMemberBefore: () => Effect.succeed(false),
  findById: () => Effect.succeed(Option.none()),
} as any);

export const MockEventRosterProvisioningServiceLayer = Layer.succeed(
  EventRosterProvisioningService,
  {
    onRsvp: () => Effect.void,
    approve: () => Effect.die(new Error('Not implemented')),
    decline: () => Effect.die(new Error('Not implemented')),
    backfill: () => Effect.succeed({ added: 0, cancelled: 0 }),
  } as any,
);

export const MockEventRosterLayers = Layer.mergeAll(
  MockEventRostersRepositoryLayer,
  MockEventRosterRequestsRepositoryLayer,
  MockEventRosterProvisioningServiceLayer,
);
