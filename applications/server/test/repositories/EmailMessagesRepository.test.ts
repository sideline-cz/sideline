import { describe, expect, it } from '@effect/vitest';
import type { Discord, EmailForwarding, Team } from '@sideline/domain';
import { Effect, Option, Schema } from 'effect';
import { EmailMessageRow } from '~/repositories/EmailMessagesRepository.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const EMAIL_ID = '00000000-0000-4000-8000-000000000001' as EmailForwarding.EmailMessageId;
const TEAM_ID = '00000000-0000-4000-8000-000000000010' as Team.TeamId;
const CHANNEL_ID = '600000000000000001' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const decodeRow = Schema.decodeUnknownSync(EmailMessageRow);

const baseRowInput = () => ({
  id: EMAIL_ID,
  team_id: TEAM_ID,
  status: 'received' as const,
  from_address: 'sender@example.com',
  subject: 'Test Subject',
  body: 'Test body text',
  summary: null as string | null,
  short_summary: null as string | null,
  summarize_attempts: 0,
  last_error: null as string | null,
  approval_request_message_id: null as string | null,
  approved_by: null as string | null,
  rejected_by: null as string | null,
  posted_channel_id: null as string | null,
  received_at: new Date('2024-01-15T10:00:00Z'),
  created_at: new Date('2024-01-15T09:00:00Z'),
  updated_at: new Date('2024-01-15T10:00:00Z'),
});

// ---------------------------------------------------------------------------
// Tests — short_summary field decoding (OptionFromNullOr)
// ---------------------------------------------------------------------------

describe('EmailMessageRow — short_summary field decoding', () => {
  it.effect('short_summary null → decoded as Option.none()', () =>
    Effect.sync(() => {
      const input = { ...baseRowInput(), short_summary: null };
      const row = decodeRow(input);
      expect(Option.isNone(row.short_summary)).toBe(true);
    }),
  );

  it.effect('short_summary string value → decoded as Option.some(value)', () =>
    Effect.sync(() => {
      const short = 'Short summary text here. ✅ Item 1\n📌 Item 2';
      const input = { ...baseRowInput(), short_summary: short };
      const row = decodeRow(input);
      expect(Option.isSome(row.short_summary)).toBe(true);
      expect(Option.getOrThrow(row.short_summary)).toBe(short);
    }),
  );

  it.effect(
    'short_summary empty string → decoded as Option.some("") (OptionFromNullOr: non-null → Some)',
    () =>
      Effect.sync(() => {
        const input = { ...baseRowInput(), short_summary: '' };
        const row = decodeRow(input);
        // OptionFromNullOr: null → None, non-null (even empty string) → Some
        expect(Option.isSome(row.short_summary)).toBe(true);
        expect(Option.getOrThrow(row.short_summary)).toBe('');
      }),
  );

  it.effect('summary null → decoded as Option.none()', () =>
    Effect.sync(() => {
      const input = { ...baseRowInput(), summary: null };
      const row = decodeRow(input);
      expect(Option.isNone(row.summary)).toBe(true);
    }),
  );

  it.effect('summary string value → decoded as Option.some(value)', () =>
    Effect.sync(() => {
      const summary = 'Detailed summary content here.';
      const input = { ...baseRowInput(), summary };
      const row = decodeRow(input);
      expect(Option.isSome(row.summary)).toBe(true);
      expect(Option.getOrThrow(row.summary)).toBe(summary);
    }),
  );

  it.effect('both summary and short_summary present → both decoded as Some', () =>
    Effect.sync(() => {
      const input = {
        ...baseRowInput(),
        summary: 'Full detailed summary.',
        short_summary: 'Short summary.',
      };
      const row = decodeRow(input);
      expect(Option.isSome(row.summary)).toBe(true);
      expect(Option.isSome(row.short_summary)).toBe(true);
      expect(Option.getOrThrow(row.summary)).toBe('Full detailed summary.');
      expect(Option.getOrThrow(row.short_summary)).toBe('Short summary.');
    }),
  );

  it.effect('both summary and short_summary null → both decoded as None', () =>
    Effect.sync(() => {
      const input = { ...baseRowInput(), summary: null, short_summary: null };
      const row = decodeRow(input);
      expect(Option.isNone(row.summary)).toBe(true);
      expect(Option.isNone(row.short_summary)).toBe(true);
    }),
  );
});

// ---------------------------------------------------------------------------
// Tests — EmailMessageRow full row decode
// ---------------------------------------------------------------------------

describe('EmailMessageRow — full row decode does not throw', () => {
  it.effect('decodes a fully-populated pending_approval row without errors', () =>
    Effect.sync(() => {
      const input = {
        ...baseRowInput(),
        status: 'pending_approval' as const,
        summary: 'This is the summary.',
        short_summary: 'Short summary.',
        summarize_attempts: 1,
        last_error: null,
        approval_request_message_id: '700000000000000001',
        approved_by: null,
        rejected_by: null,
        posted_channel_id: CHANNEL_ID,
      };
      expect(() => decodeRow(input)).not.toThrow();
      const row = decodeRow(input);
      expect(row.id).toBe(EMAIL_ID);
      expect(row.team_id).toBe(TEAM_ID);
      expect(row.status).toBe('pending_approval');
    }),
  );

  it.effect('decodes a row with posted_summary status', () =>
    Effect.sync(() => {
      const input = {
        ...baseRowInput(),
        status: 'posted_summary' as const,
        summary: 'Posted summary text.',
        short_summary: 'Posted short.',
        posted_channel_id: CHANNEL_ID,
      };
      const row = decodeRow(input);
      expect(row.status).toBe('posted_summary');
      expect(Option.isSome(row.posted_channel_id)).toBe(true);
    }),
  );
});
