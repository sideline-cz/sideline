import { DiscordREST } from 'dfx/DiscordREST';
import { DiscordGateway, InteractionsRegistry } from 'dfx/gateway';
import { Effect, Exit, Layer, Option, References } from 'effect';
import { describe, expect, it } from 'vitest';
import { Bot } from '~/index.js';
import {
  AchievementSyncService,
  ChannelBackfillService,
  ChannelSyncService,
  EmailSyncService,
  EventSyncService,
  FinanceSyncService,
  GuildJoinSyncService,
  InviteGeneratorService,
  OnboardingSyncService,
  RoleProvisionSyncService,
  RoleSyncService,
  TeamChallengeSyncService,
  WeeklySummarySyncService,
} from '~/rcp/index.js';
import { InviteCache } from '~/services/InviteCache.js';
import { OnboardingRoleCache } from '~/services/OnboardingRoleCache.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const MockDiscordGatewayLayer = Layer.succeed(DiscordGateway, {
  [DiscordGateway.key]: DiscordGateway.key,
  dispatch: undefined as never,
  fromDispatch: undefined as never,
  handleDispatch: (_event: string, _handle: unknown) => Effect.never,
  send: () => Effect.succeed(true),
  shards: Effect.succeed(new Set()),
} as never);

const MockInteractionsRegistryLayer = Layer.succeed(InteractionsRegistry, {
  register: () => Effect.void,
} as never);

const MockDiscordRESTLayer = Layer.succeed(
  DiscordREST,
  new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'getMyApplication') {
          return () => Effect.succeed({ id: 'mock-app-id' });
        }
        if (prop === 'bulkSetApplicationCommands') {
          return () => Effect.succeed([]);
        }
        if (prop === 'listMyGuilds') {
          return () => Effect.succeed([]);
        }
        return () => Effect.void;
      },
    },
  ) as never,
);

const MockRoleSyncServiceLayer = Layer.succeed(RoleSyncService, {
  processTick: Effect.void,
  discord: undefined as never,
} as never);

const MockChannelSyncServiceLayer = Layer.succeed(ChannelSyncService, {
  processTick: Effect.void,
  discord: undefined as never,
} as never);

const MockEventSyncServiceLayer = Layer.succeed(EventSyncService, {
  processTick: Effect.void,
  discord: undefined as never,
} as never);

const MockGuildJoinSyncServiceLayer = Layer.succeed(GuildJoinSyncService, {
  processTick: Effect.void,
  discord: undefined as never,
} as never);

const MockOnboardingSyncServiceLayer = Layer.succeed(OnboardingSyncService, {
  processTick: Effect.void,
  discord: undefined as never,
} as never);

const MockInviteGeneratorServiceLayer = Layer.succeed(InviteGeneratorService, {
  processTick: Effect.void,
  discord: undefined as never,
} as never);

const MockAchievementSyncServiceLayer = Layer.succeed(AchievementSyncService, {
  processTick: Effect.void,
} as never);

const MockRoleProvisionSyncServiceLayer = Layer.succeed(RoleProvisionSyncService, {
  processTick: Effect.void,
} as never);

const MockTeamChallengeSyncServiceLayer = Layer.succeed(TeamChallengeSyncService, {
  processTick: Effect.void,
} as never);

const MockWeeklySummarySyncServiceLayer = Layer.succeed(WeeklySummarySyncService, {
  processTick: Effect.void,
} as never);

const MockFinanceSyncServiceLayer = Layer.succeed(FinanceSyncService, {
  processTick: Effect.void,
} as never);

const MockEmailSyncServiceLayer = Layer.succeed(EmailSyncService, {
  processTick: Effect.void,
} as never);

const MockChannelBackfillServiceLayer = Layer.succeed(ChannelBackfillService, {
  processTick: Effect.void,
} as never);

const MockOnboardingRoleCacheLayer = Layer.succeed(OnboardingRoleCache, {
  get: () => Effect.succeed(Option.none()),
  set: () => Effect.void,
  invalidate: () => Effect.void,
} as never);

const MockSyncRpcLayer = Layer.succeed(
  SyncRpc,
  new Proxy(
    {},
    {
      get: () => () => Effect.succeed([]),
    },
  ) as never,
);

const MockInviteCacheLayer = Layer.succeed(InviteCache, {
  upsert: () => Effect.void,
  remove: () => Effect.void,
  snapshot: () => Effect.succeed(new Map<string, number>()),
  diffOnMemberJoin: () => Effect.succeed(Option.none()),
} as never);

describe('Bot', () => {
  it('program composes and starts without error', async () => {
    const TestLayer = Layer.mergeAll(
      MockDiscordGatewayLayer,
      MockInteractionsRegistryLayer,
      MockDiscordRESTLayer,
      MockRoleSyncServiceLayer,
      MockChannelSyncServiceLayer,
      MockEventSyncServiceLayer,
      MockGuildJoinSyncServiceLayer,
      MockInviteGeneratorServiceLayer,
      MockOnboardingSyncServiceLayer,
      MockAchievementSyncServiceLayer,
      MockRoleProvisionSyncServiceLayer,
      MockTeamChallengeSyncServiceLayer,
      MockWeeklySummarySyncServiceLayer,
      MockFinanceSyncServiceLayer,
      MockEmailSyncServiceLayer,
      MockChannelBackfillServiceLayer,
      MockOnboardingRoleCacheLayer,
      MockSyncRpcLayer,
      MockInviteCacheLayer,
    );

    const result = await Effect.runPromise(
      Bot.program.pipe(
        Effect.timeout('200 millis'),
        Effect.ignore,
        Effect.provide(TestLayer),
        Effect.provide(Layer.succeed(References.MinimumLogLevel, 'None')),
      ),
    );

    expect(result).toBeUndefined();
  });
});

describe('resilientTick', () => {
  const SilentLogger = Layer.succeed(References.MinimumLogLevel, 'None');

  it('neutralizes a failing tick (so Effect.repeat keeps the poller alive)', async () => {
    const exit = await Effect.runPromiseExit(
      Bot.resilientTick(Effect.fail('transient rpc blip')).pipe(Effect.provide(SilentLogger)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it('neutralizes a defect (die) too', async () => {
    const exit = await Effect.runPromiseExit(
      Bot.resilientTick(Effect.die(new Error('boom'))).pipe(Effect.provide(SilentLogger)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it('passes a successful tick through unchanged', async () => {
    const exit = await Effect.runPromiseExit(Bot.resilientTick(Effect.void));
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
