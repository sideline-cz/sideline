import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as AiChatApi from '~/api/AiChatApi.js';
import { AiActionName, AiActionProposalId } from '~/models/AiActionProposal.js';
import * as Discord from '~/models/Discord.js';
import {
  AssistantConfirmOutcome,
  AssistantNotLinked,
  AssistantNotMember,
  AssistantThreadNotFound,
  AssistantThreadOwner,
  AssistantTurn,
} from './AssistantRpcModels.js';

const actor = {
  guild_id: Discord.Snowflake,
  discord_user_id: Discord.Snowflake,
} as const;

export const AssistantRpcGroup = RpcGroup.make(
  // Checked before the thread is created, so a refused user gets no thread at all.
  Rpc.make('Authorize', {
    payload: actor,
    success: Schema.Struct({ enabled: Schema.Boolean }),
    error: Schema.Union([AssistantNotLinked, AssistantNotMember]),
  }),
  Rpc.make('RegisterThread', {
    payload: { ...actor, thread_id: Discord.Snowflake },
    error: Schema.Union([AssistantNotLinked, AssistantNotMember]),
  }),
  // `null` = not an assistant thread. The bot caches the answer per channel.
  Rpc.make('GetThreadOwner', {
    payload: { thread_id: Discord.Snowflake },
    success: Schema.NullOr(AssistantThreadOwner),
  }),
  Rpc.make('Chat', {
    payload: {
      thread_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
      messages: Schema.Array(AiChatApi.ChatMessage),
    },
    success: AssistantTurn,
    error: Schema.Union([AssistantThreadNotFound, AssistantNotMember, AiChatApi.AiChatRateLimited]),
  }),
  Rpc.make('ConfirmProposal', {
    payload: { ...actor, proposal_id: AiActionProposalId },
    success: Schema.Struct({ outcome: AssistantConfirmOutcome, action: AiActionName }),
    error: Schema.Union([
      AssistantNotLinked,
      AssistantNotMember,
      AiChatApi.AiChatForbidden,
      AiChatApi.AiProposalNotFound,
      AiChatApi.AiProposalAlreadyUsed,
      AiChatApi.AiProposalExpired,
      AiChatApi.AiProposalActionForbidden,
    ]),
  }),
  Rpc.make('RejectProposal', {
    payload: { ...actor, proposal_id: AiActionProposalId },
    error: Schema.Union([AssistantNotLinked, AssistantNotMember, AiChatApi.AiProposalNotFound]),
  }),
).prefix('Assistant/');
