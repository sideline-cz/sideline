import { describe, expect, it } from '@effect/vitest';
import { Option, Schema } from 'effect';
import { PendingOnboardingSyncEntry } from '~/rpc/guild/GuildRpcGroup.js';

// Release A expand/contract invariant (remove-channel-by-type): the server no
// longer has a training channel, but pre-Release-A bots decode
// `training_channel_id` as a REQUIRED key — if the key is omitted from the
// wire payload, those bots fail the whole batch decode AFTER the server has
// already claimed the rows (pending → syncing), stranding onboarding syncs.
// These tests pin the wire shape until the field is deleted in Release B.
describe('PendingOnboardingSyncEntry training_channel_id (transitional)', () => {
  const base = {
    team_id: '11111111-1111-1111-1111-111111111111',
    guild_id: '123456789012345678',
    team_name: 'Team',
    onboarding_locale: 'en',
    rules_channel_id: null,
    welcome_channel_id: null,
    onboarding_rules_role_id: null,
    onboarding_rules_prompt_id: null,
    is_community_enabled: false,
  };

  it('decodes an explicit null to None (Release A server emission)', () => {
    const decoded = Schema.decodeUnknownSync(PendingOnboardingSyncEntry)({
      ...base,
      training_channel_id: null,
    });
    expect(Option.isNone(decoded.training_channel_id)).toBe(true);
  });

  it('decodes a missing key to None (Release B forward-compat)', () => {
    const decoded = Schema.decodeUnknownSync(PendingOnboardingSyncEntry)(base);
    expect(Option.isNone(decoded.training_channel_id)).toBe(true);
  });

  it('encodes None as an explicit null key, never omitted (old-bot compat)', () => {
    const decoded = Schema.decodeUnknownSync(PendingOnboardingSyncEntry)({
      ...base,
      training_channel_id: null,
    });
    const encoded = Schema.encodeUnknownSync(PendingOnboardingSyncEntry)(decoded) as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(encoded, 'training_channel_id')).toBe(true);
    expect(encoded.training_channel_id).toBeNull();
  });
});
