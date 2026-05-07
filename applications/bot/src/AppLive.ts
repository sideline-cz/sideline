import { DiscordIxLive } from 'dfx/gateway';
import { Layer } from 'effect';
import { HealthServerLive } from '~/HealthServerLive.js';
import { ChannelReorderSemaphore } from '~/rcp/event/ChannelReorderSemaphore.js';
import { ChannelSyncService, EventSyncService, RoleSyncService } from '~/rcp/index.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const SyncLive = Layer.mergeAll(
  RoleSyncService.Default,
  ChannelSyncService.Default,
  EventSyncService.Default,
).pipe(
  Layer.provideMerge(ChannelReorderSemaphore.Live),
  Layer.provideMerge(SyncRpc.Default),
  Layer.provide(DiscordIxLive),
);

export const AppLive = HealthServerLive.pipe(
  Layer.provideMerge(DiscordIxLive),
  Layer.provideMerge(SyncLive),
);
