import { RpcGroup } from 'effect/unstable/rpc';
import { AchievementRpcGroup } from './achievement/AchievementRpcGroup.js';
import { ActivityRpcGroup } from './activity/ActivityRpcGroup.js';
import { ChannelRpcGroup } from './channel/ChannelRpcGroup.js';
import { EventRpcGroup } from './event/EventRpcGroup.js';
import { GuildRpcGroup } from './guild/GuildRpcGroup.js';
import { InviteRpcGroup } from './invite/InviteRpcGroup.js';
import { RoleRpcGroup } from './role/RoleRpcGroup.js';
import { RoleProvisionRpcGroup } from './roleProvision/RoleProvisionRpcGroup.js';

export class SyncRpcs extends RpcGroup.make().merge(
  RoleRpcGroup,
  ChannelRpcGroup,
  GuildRpcGroup,
  EventRpcGroup,
  ActivityRpcGroup,
  InviteRpcGroup,
  AchievementRpcGroup,
  RoleProvisionRpcGroup,
) {}
