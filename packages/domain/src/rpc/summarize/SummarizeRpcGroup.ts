import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import { SummarizeChannelInput, SummarizeChannelResult } from './SummarizeRpcModels.js';

export const SummarizeRpcGroup = RpcGroup.make(
  Rpc.make('SummarizeChannel', {
    payload: SummarizeChannelInput,
    success: SummarizeChannelResult,
  }),
).prefix('Summarize/');
