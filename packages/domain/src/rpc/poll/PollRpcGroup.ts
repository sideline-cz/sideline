import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as Discord from '~/models/Discord.js';
import { PollId, PollOptionId } from '~/models/Poll.js';
import {
  AddOptionResult,
  CastVoteResult,
  PollAddOptionForbidden,
  PollClosed,
  PollDeadlineInPast,
  PollDuplicateOption,
  PollForbidden,
  PollGuildNotFound,
  PollInvalidDeadline,
  PollNotFound,
  PollNotMember,
  PollOptionLimitReached,
  PollOptionNotFound,
  PollOptionTooLong,
  PollTooFewOptions,
  PollTooManyOptions,
  PollView,
} from './PollRpcModels.js';

export const PollRpcGroup = RpcGroup.make(
  Rpc.make('CreatePoll', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
      discord_channel_id: Discord.Snowflake,
      question: Schema.String,
      options_raw: Schema.String,
      multiple: Schema.Boolean,
      allowed_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
      deadline_raw: Schema.OptionFromNullOr(Schema.String),
    },
    success: PollView,
    error: Schema.Union([
      PollGuildNotFound,
      PollNotMember,
      PollForbidden,
      PollTooFewOptions,
      PollTooManyOptions,
      PollDuplicateOption,
      PollOptionTooLong,
      PollInvalidDeadline,
      PollDeadlineInPast,
    ]),
  }),
  Rpc.make('SavePollMessageId', {
    payload: {
      guild_id: Discord.Snowflake,
      poll_id: PollId,
      discord_message_id: Discord.Snowflake,
    },
    error: Schema.Union([PollGuildNotFound, PollNotFound]),
  }),
  Rpc.make('CastVote', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
      poll_id: PollId,
      option_id: PollOptionId,
    },
    success: CastVoteResult,
    error: Schema.Union([
      PollGuildNotFound,
      PollNotMember,
      PollNotFound,
      PollOptionNotFound,
      PollClosed,
    ]),
  }),
  Rpc.make('AddOption', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
      poll_id: PollId,
      label: Schema.String,
      member_role_ids: Schema.Array(Discord.Snowflake),
    },
    success: AddOptionResult,
    error: Schema.Union([
      PollGuildNotFound,
      PollNotMember,
      PollNotFound,
      PollClosed,
      PollOptionLimitReached,
      PollDuplicateOption,
      PollOptionTooLong,
      PollAddOptionForbidden,
    ]),
  }),
  Rpc.make('ClosePoll', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
      poll_id: PollId,
    },
    success: PollView,
    error: Schema.Union([PollGuildNotFound, PollNotMember, PollForbidden, PollNotFound]),
  }),
  Rpc.make('GetPollView', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
      poll_id: PollId,
    },
    success: Schema.OptionFromNullOr(PollView),
    error: Schema.Union([PollGuildNotFound, PollNotMember]),
  }),
).prefix('Poll/');
