import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as Discord from '~/models/Discord.js';
import { MembershipPlanId } from '~/models/MembershipPlan.js';
import {
  MembershipGuildNotFound,
  MembershipNotMember,
  MembershipPlanUnavailable,
  MembershipSelectionLocked,
  MembershipSelectionView,
} from './MembershipRpcModels.js';

export const MembershipRpcGroup = RpcGroup.make(
  Rpc.make('GetMembershipSelection', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
    },
    success: MembershipSelectionView,
    error: Schema.Union([MembershipGuildNotFound, MembershipNotMember]),
  }),
  // Returns the FULL view, not void: every caller re-renders the picker from it, so one round
  // trip covers write + read-back and the ephemeral can never show a stale selection.
  Rpc.make('SelectMembershipPlan', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
      plan_id: MembershipPlanId,
    },
    success: MembershipSelectionView,
    error: Schema.Union([
      MembershipGuildNotFound,
      MembershipNotMember,
      MembershipPlanUnavailable,
      MembershipSelectionLocked,
    ]),
  }),
).prefix('Membership/');
