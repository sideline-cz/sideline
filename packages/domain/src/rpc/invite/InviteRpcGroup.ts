import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as Discord from '~/models/Discord.js';
import { InviteAcceptanceId } from '~/models/InviteAcceptance.js';
import { InviteGeneratorErrorCode } from '~/models/Onboarding.js';

/**
 * PR-2 wire expand (CC-1: "the bot is the decoder"). Two additive, tolerant fields so an
 * old bot bundling the pre-PR-2 schema keeps decoding this batch RPC's success payload:
 *
 * - `welcome_channel_id` tolerates both a missing key (an old server never sent it) and an
 *   explicit `null` (a PR-3+ server, once the `welcome_channel_id IS NOT NULL` guard in
 *   `findPending` is lifted) — both decode to `Option.none()`.
 * - `bot_present` decodes a missing key (an old server never sent it) as `true`, the
 *   behaviour-preserving default before PR-3 adds the real "is the bot actually in this
 *   guild" gate.
 *
 * This release (PR-2) the server still only ever emits a non-null `welcome_channel_id` and
 * never emits `bot_present: false` — see `InviteAcceptancesRepository.findPending`'s
 * temporary wire guard. Nothing behaves differently yet; only the schema is widened.
 */
export class PendingAcceptanceEntry extends Schema.Class<PendingAcceptanceEntry>(
  'PendingAcceptanceEntry',
)({
  acceptance_id: InviteAcceptanceId,
  guild_id: Discord.Snowflake,
  welcome_channel_id: Schema.OptionFromOptionalNullOr(Discord.Snowflake, { onNoneEncoding: null }),
  bot_present: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(() => true)),
}) {}

export const InviteRpcGroup = RpcGroup.make(
  Rpc.make('PendingAcceptances', {
    payload: { limit: Schema.Number },
    success: Schema.Array(PendingAcceptanceEntry),
  }),
  Rpc.make('SetAcceptanceDiscordCode', {
    payload: {
      acceptance_id: InviteAcceptanceId,
      discord_code: Schema.String,
    },
  }),
  Rpc.make('MarkAcceptanceFailed', {
    payload: {
      acceptance_id: InviteAcceptanceId,
      error_code: InviteGeneratorErrorCode,
      error_detail: Schema.String,
    },
  }),
).prefix('Invite/');
