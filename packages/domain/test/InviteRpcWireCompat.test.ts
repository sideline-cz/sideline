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

  // This is the test that proves PR-2 is safe to deploy in any order (CC-1): the PR-2 server's
  // encoded output must still decode under the OLD schema an un-upgraded bot still bundles.
  // The old schema is declared locally, deliberately NOT reusing `PendingAcceptanceEntry` —
  // asserting the new schema decodes its own output would prove nothing about compatibility.
  it('the PR-2 server encoding still decodes under the OLD (pre-PR-2) schema', () => {
    const LegacyPendingAcceptance = Schema.Struct({
      acceptance_id: Schema.String,
      guild_id: Schema.String,
      welcome_channel_id: Schema.String,
    });

    // Exactly what the PR-2 server emits this release: `findPending`'s temporary wire guard
    // (`AND t.welcome_channel_id IS NOT NULL`) means welcome_channel_id is always `Some`, and
    // `bot_present` is always `true` (the inner `JOIN bot_guilds` makes it a hardcoded constant).
    const serverEmitted: unknown = Schema.encodeSync(PendingAcceptanceEntry)(
      new PendingAcceptanceEntry({
        acceptance_id: ACCEPTANCE_ID,
        guild_id: GUILD_ID,
        welcome_channel_id: Option.some(CHANNEL_ID),
        bot_present: true,
      }),
    );

    const decoded = Schema.decodeUnknownSync(LegacyPendingAcceptance)(serverEmitted);

    expect(decoded).toEqual({
      acceptance_id: ACCEPTANCE_ID,
      guild_id: GUILD_ID,
      welcome_channel_id: CHANNEL_ID,
    });
  });
});
