import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as Discord from '~/models/Discord.js';
import { DiscordReadRequestId, DiscordReadResult } from '~/models/DiscordReadRequest.js';

// One live read the bot must do. `since` is the cutoff the server computed on the DB clock;
// None means "the newest messages, no cutoff".
export class PendingDiscordRead extends Schema.Class<PendingDiscordRead>('PendingDiscordRead')({
  id: DiscordReadRequestId,
  channel_id: Discord.Snowflake,
  since: Schema.OptionFromNullOr(Schema.DateTimeUtc),
  limit: Schema.Int,
}) {}

// Bot -> server only. SubmitResult is also the ack: the server sets result and processed_at in
// one UPDATE, so there is no separate MarkProcessed.
export const DiscordReadRpcGroup = RpcGroup.make(
  Rpc.make('GetUnprocessedRequests', {
    payload: { limit: Schema.Number },
    success: Schema.Array(PendingDiscordRead),
  }),
  Rpc.make('SubmitResult', {
    payload: { id: DiscordReadRequestId, result: DiscordReadResult },
  }),
).prefix('DiscordRead/');
