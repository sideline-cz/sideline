// Tests for `projectInviteErrorToWire` (PR-2, CC-3) — the wire-value projection applied at the
// `getJoinStatus` read boundary. Table-driven over all 10 stored `Onboarding.InviteGeneratorErrorCode`
// literals: `'expired'` collapses to `None` permanently, `'bot_not_in_guild'` projects to
// `'unknown'` (until PR-9), and every other literal is identity.

import { describe, expect, it } from '@effect/vitest';
import type { Onboarding } from '@sideline/domain';
import { Option } from 'effect';
import { projectInviteErrorToWire } from '~/utils/inviteErrorWireProjection.js';

describe('projectInviteErrorToWire', () => {
  const cases: ReadonlyArray<
    readonly [Onboarding.InviteGeneratorErrorCode, Option.Option<string>]
  > = [
    ['welcome_channel_missing', Option.some('welcome_channel_missing')],
    ['welcome_channel_deleted', Option.some('welcome_channel_deleted')],
    ['bot_missing_perms', Option.some('bot_missing_perms')],
    ['community_not_enabled', Option.some('community_not_enabled')],
    ['rate_limited', Option.some('rate_limited')],
    ['discord_error', Option.some('discord_error')],
    ['network_error', Option.some('network_error')],
    ['unknown', Option.some('unknown')],
    ['bot_not_in_guild', Option.some('unknown')],
    ['expired', Option.none()],
  ];

  it.each(cases)('projects %s to %s', (code, expected) => {
    const projected = projectInviteErrorToWire(code);

    expect(Option.isSome(projected)).toBe(Option.isSome(expected));
    if (Option.isSome(expected)) {
      expect(Option.getOrThrow(projected)).toBe(Option.getOrThrow(expected));
    }
  });

  it("projects 'expired' to None — permanent collapse, never an errorCode (CC-3)", () => {
    expect(Option.isNone(projectInviteErrorToWire('expired'))).toBe(true);
  });

  it("projects 'bot_not_in_guild' to Some('unknown') until PR-9", () => {
    expect(Option.getOrThrow(projectInviteErrorToWire('bot_not_in_guild'))).toBe('unknown');
  });
});
