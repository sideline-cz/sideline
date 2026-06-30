import { RpcGroup } from 'effect/unstable/rpc';
import { AchievementRpcGroup } from './achievement/AchievementRpcGroup.js';
import { ActivityRpcGroup } from './activity/ActivityRpcGroup.js';
import { BotInfoRpcGroup } from './botInfo/BotInfoRpcGroup.js';
import { CarpoolRpcGroup } from './carpool/CarpoolRpcGroup.js';
import { ChannelRpcGroup } from './channel/ChannelRpcGroup.js';
import { EmailRpcGroup } from './email/EmailRpcGroup.js';
import { EventRpcGroup } from './event/EventRpcGroup.js';
import { FinanceRpcGroup } from './finance/FinanceRpcGroup.js';
import { GuildRpcGroup } from './guild/GuildRpcGroup.js';
import { InviteRpcGroup } from './invite/InviteRpcGroup.js';
import { PersonalEventsRpcGroup } from './personalEvents/PersonalEventsRpcGroup.js';
import { PollRpcGroup } from './poll/PollRpcGroup.js';
import { RoleRpcGroup } from './role/RoleRpcGroup.js';
import { RoleProvisionRpcGroup } from './roleProvision/RoleProvisionRpcGroup.js';
import { SummarizeRpcGroup } from './summarize/SummarizeRpcGroup.js';
import { TeamChallengeSyncEventsRpcGroup } from './teamChallenge/TeamChallengeSyncEvents.js';
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
  TeamChallengeSyncEventsRpcGroup,
  FinanceRpcGroup,
  BotInfoRpcGroup,
  CarpoolRpcGroup,
  EmailRpcGroup,
  SummarizeRpcGroup,
  PollRpcGroup,
  PersonalEventsRpcGroup,
) {}
