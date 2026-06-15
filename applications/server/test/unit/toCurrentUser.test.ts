// Tests for toCurrentUser display-name precedence logic.
//
// Precedence: profile name → discord_nickname → discord_display_name → username
// Empty/whitespace values are skipped; username is the terminal fallback.

import { describe, expect, it } from '@effect/vitest';
import type { Auth, Discord } from '@sideline/domain';
import { DateTime, Option } from 'effect';
import { toCurrentUser } from '~/utils/toCurrentUser.js';

// ---------------------------------------------------------------------------
// Minimal user fixture builder
// ---------------------------------------------------------------------------

const BASE_USER = {
  id: '00000000-0000-0000-0000-000000000001' as Auth.UserId,
  discord_id: '12345' as Discord.Snowflake,
  username: 'testuser',
  avatar: Option.none<string>(),
  is_profile_complete: false,
  is_global_admin: false,
  global_admin_granted_at: Option.none(),
  name: Option.none<string>(),
  birth_date: Option.none(),
  gender: Option.none(),
  locale: 'en' as const,
  discord_nickname: Option.none<string>(),
  discord_display_name: Option.none<string>(),
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

// ---------------------------------------------------------------------------
// displayName precedence
// ---------------------------------------------------------------------------

describe('toCurrentUser — displayName precedence', () => {
  it('returns profile name when name is set', () => {
    const user = { ...BASE_USER, name: Option.some('Alice Smith') };
    const result = toCurrentUser(user);
    expect(result.displayName).toBe('Alice Smith');
  });

  it('falls back to discord_nickname when name is None', () => {
    const user = {
      ...BASE_USER,
      name: Option.none(),
      discord_nickname: Option.some('alice_nick'),
    };
    const result = toCurrentUser(user);
    expect(result.displayName).toBe('alice_nick');
  });

  it('falls back to discord_display_name when name and nickname are None', () => {
    const user = {
      ...BASE_USER,
      name: Option.none(),
      discord_nickname: Option.none(),
      discord_display_name: Option.some('Alice Display'),
    };
    const result = toCurrentUser(user);
    expect(result.displayName).toBe('Alice Display');
  });

  it('falls back to username when all profile fields are None', () => {
    const user = {
      ...BASE_USER,
      name: Option.none(),
      discord_nickname: Option.none(),
      discord_display_name: Option.none(),
      username: 'fallbackuser',
    };
    const result = toCurrentUser(user);
    expect(result.displayName).toBe('fallbackuser');
  });

  it('skips whitespace-only name and uses discord_nickname instead', () => {
    const user = {
      ...BASE_USER,
      name: Option.some('   '),
      discord_nickname: Option.some('nick_over_blank'),
      discord_display_name: Option.none(),
    };
    const result = toCurrentUser(user);
    expect(result.displayName).toBe('nick_over_blank');
  });

  it('skips whitespace-only discord_nickname and uses discord_display_name', () => {
    const user = {
      ...BASE_USER,
      name: Option.none(),
      discord_nickname: Option.some('  '),
      discord_display_name: Option.some('DisplayName'),
    };
    const result = toCurrentUser(user);
    expect(result.displayName).toBe('DisplayName');
  });

  it('prefers name over discord_nickname even when both are set', () => {
    const user = {
      ...BASE_USER,
      name: Option.some('Real Name'),
      discord_nickname: Option.some('discord_nick'),
      discord_display_name: Option.some('discord_display'),
    };
    const result = toCurrentUser(user);
    expect(result.displayName).toBe('Real Name');
  });
});

// ---------------------------------------------------------------------------
// Other CurrentUser fields are passed through correctly
// ---------------------------------------------------------------------------

describe('toCurrentUser — passthrough fields', () => {
  it('maps username field correctly', () => {
    const user = { ...BASE_USER, username: 'mapped_user' };
    const result = toCurrentUser(user);
    expect(result.username).toBe('mapped_user');
  });

  it('passes is_global_admin DB flag through to isGlobalAdmin', () => {
    const user = { ...BASE_USER, is_global_admin: true };
    const result = toCurrentUser(user);
    expect(result.isGlobalAdmin).toBe(true);
  });
});
