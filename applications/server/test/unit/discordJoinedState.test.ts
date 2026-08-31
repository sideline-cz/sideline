// PR-9 (Discord onboarding fix), CC-15 — `deriveDiscordJoined` is the tri-state gate consumed by
// `auth.myTeams`. The anti-lockout guard (designer §3.6 step 2): a guild whose member list was
// never provably read completely must NEVER be interpreted as "nobody is connected".

import { describe, expect, it } from '@effect/vitest';
import { Option } from 'effect';
import { deriveDiscordJoined } from '~/utils/discordJoinedState.js';

describe('deriveDiscordJoined', () => {
  it("returns 'connected' when discord_joined_at is set", () => {
    expect(deriveDiscordJoined(Option.some(new Date()), Option.none())).toBe('connected');
  });

  it("returns 'connected' when discord_joined_at is set even if the guild backfill also completed", () => {
    expect(deriveDiscordJoined(Option.some(new Date()), Option.some(new Date()))).toBe('connected');
  });

  it("returns 'not_connected' only when discord_joined_at is unset AND the guild's backfill completed", () => {
    expect(deriveDiscordJoined(Option.none(), Option.some(new Date()))).toBe('not_connected');
  });

  // The anti-lockout guard — pins the exact failure mode a hard gate on an unknown signal would
  // cause: bouncing an entire existing, working user base to a "join Discord" wall.
  it("returns 'unknown' for a guild whose backfill never completed — never 'not_connected'", () => {
    expect(deriveDiscordJoined(Option.none(), Option.none())).toBe('unknown');
  });
});
