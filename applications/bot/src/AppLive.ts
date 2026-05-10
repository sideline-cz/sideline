import { DiscordIxLive } from 'dfx/gateway';
import { Layer } from 'effect';
import { HealthServerLive } from '~/HealthServerLive.js';
import { ChannelReorderSemaphore } from '~/rcp/event/ChannelReorderSemaphore.js';
import {
  ChannelSyncService,
  EventSyncService,
  GuildJoinSyncService,
  OnboardingSyncService,
  RoleSyncService,
} from '~/rcp/index.js';
import { InviteCache } from '~/services/InviteCache.js';
import { OnboardingRoleCache } from '~/services/OnboardingRoleCache.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const SyncLive = Layer.mergeAll(
  RoleSyncService.Default,
  ChannelSyncService.Default,
  EventSyncService.Default,
  GuildJoinSyncService.Default,
  OnboardingSyncService.Default,
).pipe(
  Layer.provideMerge(ChannelReorderSemaphore.Live),
  Layer.provideMerge(InviteCache.Default),
  Layer.provideMerge(OnboardingRoleCache.Default),
  Layer.provideMerge(SyncRpc.Default),
  Layer.provide(DiscordIxLive),
);

export const AppLive = HealthServerLive.pipe(
  Layer.provideMerge(DiscordIxLive),
  Layer.provideMerge(SyncLive),
);
