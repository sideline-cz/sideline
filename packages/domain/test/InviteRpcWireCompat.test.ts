// PR-2 wire expand tests (CC-1: "the bot is the decoder"). `Invite/PendingAcceptances` is a
// batch RPC decoded by the bot via `SqlSchema.findAll` — a single row failing to decode fails
// the WHOLE batch and stops invite generation for every team. These tests pin the two directions
// that make PR-2 safe to deploy in any order:
//
//   1-3. The NEW (PR-2) schema tolerates every shape the OLD server could still emit (missing
//        `bot_present`) as well as the shapes a PR-3+ server will start emitting (an explicit
//        `null` welcome_channel_id, `bot_present: false`).
//   4.   The entire point of the PR: what the PR-2 SERVER emits this release (never a null —
//        `findPending`'s temporary wire guard sees to that) must still decode under a locally
//        declared copy of the OLD (pre-PR-2) schema, so an un-upgraded bot survives a PR-2
//        server deploy.
//
// See `.work-plans/discord-onboarding-fix-plan.md`, PR-2 test list items 1-4, and CC-1.

import { describe, expect, it } from '@effect/vitest';
import { Option, Schema } from 'effect';
import type * as Discord from '~/models/Discord.js';
import type { InviteAcceptanceId } from '~/models/InviteAcceptance.js';
import { PendingAcceptanceEntry } from '~/rpc/invite/InviteRpcGroup.js';

const ACCEPTANCE_ID = 'acc-1' as InviteAcceptanceId;
const GUILD_ID = '111111111111111111' as Discord.Snowflake;
const CHANNEL_ID = '222222222222222222' as Discord.Snowflake;

describe('Invite/PendingAcceptances wire compatibility (PR-2, CC-1)', () => {
  it('new PendingAcceptances schema decodes a legacy payload (no bot_present key)', () => {
    const decoded = Schema.decodeUnknownSync(PendingAcceptanceEntry)({
      acceptance_id: ACCEPTANCE_ID,
      guild_id: GUILD_ID,
      welcome_channel_id: CHANNEL_ID,
    });

    expect(Option.isSome(decoded.welcome_channel_id)).toBe(true);
    expect(Option.getOrThrow(decoded.welcome_channel_id)).toBe(CHANNEL_ID);
    expect(decoded.bot_present).toBe(true);
  });

  it('new PendingAcceptances schema decodes welcome_channel_id: null', () => {
    const decoded = Schema.decodeUnknownSync(PendingAcceptanceEntry)({
      acceptance_id: ACCEPTANCE_ID,
      guild_id: GUILD_ID,
      welcome_channel_id: null,
      bot_present: true,
    });

    expect(Option.isNone(decoded.welcome_channel_id)).toBe(true);
  });

  it('new PendingAcceptances schema decodes bot_present: false', () => {
    const decoded = Schema.decodeUnknownSync(PendingAcceptanceEntry)({
      acceptance_id: ACCEPTANCE_ID,
      guild_id: GUILD_ID,
      welcome_channel_id: CHANNEL_ID,
      bot_present: false,
    });

    expect(decoded.bot_present).toBe(false);
  });

  // This test used to assert ONLY that the OLD (pre-PR-2) schema still decodes the PR-2 server's
  // output, on the premise that `findPending`'s temporary wire guard (`AND t.welcome_channel_id
  // IS NOT NULL`) kept `welcome_channel_id` always non-null this release. PR-3 removed that guard
  // (fixed here — whole-series review of `fix/discord-onboarding-webapp`: the premise was
  // invalidated two commits after this test was written), so the server now genuinely emits
  // `null` for a team with no welcome channel configured.
  //
  // Should-fix 5 (whole-series review of commit 46806427): the rewrite that added the `null`
  // case dropped the ORIGINAL assertion — that the server's real, non-null output still decodes
  // under the OLD schema — leaving it with only a `.toThrow()` and no matcher on the `null` case.
  // A decoder-first rollout (CC-1) needs BOTH proven: the common case (a configured welcome
  // channel) must keep working for an un-upgraded bot, AND the new case (no welcome channel) must
  // fail loudly rather than silently coerce to something wrong. Losing the first assertion let a
  // regression that broke the OLD schema's decoding of the (far more common) non-null shape pass
  // silently — the very kind of premise-invalidation bug this whole file exists to catch (CC-1).
  // The OLD schema is declared locally in both tests below, deliberately NOT reusing
  // `PendingAcceptanceEntry`, since asserting the new schema decodes its own output would prove
  // nothing about compatibility.
  const LegacyPendingAcceptance = Schema.Struct({
    acceptance_id: Schema.String,
    guild_id: Schema.String,
    welcome_channel_id: Schema.String,
  });

  it('a non-null welcome_channel_id (the common case) still decodes under the OLD (pre-PR-2) schema', () => {
    const serverEmitted: unknown = Schema.encodeSync(PendingAcceptanceEntry)(
      new PendingAcceptanceEntry({
        acceptance_id: ACCEPTANCE_ID,
        guild_id: GUILD_ID,
        welcome_channel_id: Option.some(CHANNEL_ID),
        bot_present: true,
      }),
    );

    const decoded = Schema.decodeUnknownSync(LegacyPendingAcceptance)(serverEmitted);
    expect(decoded.welcome_channel_id).toBe(CHANNEL_ID);
  });

  // This failure is the exact deploy-window CC-1's contract does NOT cover: a bot that has not
  // yet received the PR-2 wire-expand release, still running once a PR-3+ server starts emitting
  // real nulls. CC-1's whole point is decoder-first ordering (deploy the tolerant PR-2 bot
  // before the server that needs it), which makes that window unreachable in a correctly ordered
  // rollout — but it is worth pinning as a failure, not silently "would also work", so a future
  // reader does not mistake the wire-expand for permanent unconditional back-compat.
  it('a genuinely null welcome_channel_id (the PR-3+ server) does NOT decode under the OLD (pre-PR-2) schema', () => {
    const serverEmitted: unknown = Schema.encodeSync(PendingAcceptanceEntry)(
      new PendingAcceptanceEntry({
        acceptance_id: ACCEPTANCE_ID,
        guild_id: GUILD_ID,
        welcome_channel_id: Option.none(),
        bot_present: true,
      }),
    );

    expect(() => Schema.decodeUnknownSync(LegacyPendingAcceptance)(serverEmitted)).toThrow();
  });
});
