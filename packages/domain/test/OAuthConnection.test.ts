import { describe, expect, it } from '@effect/vitest';
import { hasScope, parseScopes, REQUIRED_DISCORD_SCOPE } from '~/models/OAuthConnection.js';

describe('OAuthConnection scope helpers', () => {
  describe('parseScopes', () => {
    it('returns empty array for empty string', () => {
      expect(parseScopes('')).toEqual([]);
    });

    it('splits space-separated scopes', () => {
      expect(parseScopes('identify guilds guilds.join')).toEqual([
        'identify',
        'guilds',
        'guilds.join',
      ]);
    });

    it('drops empty entries from extra whitespace', () => {
      expect(parseScopes('identify  guilds')).toEqual(['identify', 'guilds']);
    });
  });

  describe('hasScope', () => {
    it('detects guilds.join when present', () => {
      expect(hasScope('identify guilds guilds.join', REQUIRED_DISCORD_SCOPE)).toBe(true);
    });

    it('returns false when guilds.join is absent', () => {
      expect(hasScope('identify guilds', REQUIRED_DISCORD_SCOPE)).toBe(false);
    });

    it('returns false on empty string', () => {
      expect(hasScope('', REQUIRED_DISCORD_SCOPE)).toBe(false);
    });

    it('does not match a substring of another scope', () => {
      expect(hasScope('guilds.join.extra', 'guilds.join')).toBe(false);
    });
  });
});
