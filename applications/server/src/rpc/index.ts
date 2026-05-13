import { Layer } from 'effect';
import { AchievementRpcLive } from './achievement/index.js';
import { ActivityRpcLive } from './activity/index.js';
import { ChannelsRpcLive } from './channel/index.js';
import { EventsRpcLive } from './event/index.js';
import { GuildsRpcLive } from './guild/index.js';
import { InvitesRpcLive } from './invite/index.js';
import { RolesRpcLive } from './role/index.js';
import { RoleProvisionRpcLive } from './roleProvision/index.js';
import { WeeklySummaryRpcLive } from './weeklySummary/index.js';

export const SyncRpcsLive = Layer.mergeAll(
  RolesRpcLive,
  ChannelsRpcLive,
  GuildsRpcLive,
  EventsRpcLive,
  ActivityRpcLive,
  InvitesRpcLive,
  AchievementRpcLive,
  RoleProvisionRpcLive,
  WeeklySummaryRpcLive,
);
