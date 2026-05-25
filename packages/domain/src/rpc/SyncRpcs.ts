import { RpcGroup } from 'effect/unstable/rpc';
import { AchievementRpcGroup } from './achievement/AchievementRpcGroup.js';
import { ActivityRpcGroup } from './activity/ActivityRpcGroup.js';
import { BotInfoRpcGroup } from './botInfo/BotInfoRpcGroup.js';
import { ChannelRpcGroup } from './channel/ChannelRpcGroup.js';
import { EventRpcGroup } from './event/EventRpcGroup.js';
import { FinanceRpcGroup } from './finance/FinanceRpcGroup.js';
import { GuildRpcGroup } from './guild/GuildRpcGroup.js';
import { InviteRpcGroup } from './invite/InviteRpcGroup.js';
import { RoleRpcGroup } from './role/RoleRpcGroup.js';
import { RoleProvisionRpcGroup } from './roleProvision/RoleProvisionRpcGroup.js';
import { TeamChallengeSyncEventsRpcGroup } from './teamChallenge/TeamChallengeSyncEvents.js';
import { WeeklyChallengeSyncEventsRpcGroup } from './weeklyChallenge/WeeklyChallengeSyncEvents.js';
import { WeeklySummaryRpcGroup } from './weeklySummary/WeeklySummaryRpcGroup.js';

export class SyncRpcs extends RpcGroup.make().merge(
  RoleRpcGroup,
  ChannelRpcGroup,
  GuildRpcGroup,
  EventRpcGroup,
  ActivityRpcGroup,
  InviteRpcGroup,
  AchievementRpcGroup,
  RoleProvisionRpcGroup,
  WeeklySummaryRpcGroup,
  WeeklyChallengeSyncEventsRpcGroup,
  TeamChallengeSyncEventsRpcGroup,
  FinanceRpcGroup,
  BotInfoRpcGroup,
) {}
