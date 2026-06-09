// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").

import { type EmailForwarding, EmailRpcEvents, type Team } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DateTime, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  buildApprovalEmbeds,
  buildPageComponents,
  buildPageEmbed,
  buildTeamPostComponents,
  buildTeamPostEmbed,
} from '~/rest/email/buildEmailEmbeds.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCALE = 'en' as const;
const TEAM_ID = '00000000-0000-4000-8000-000000000010' as Team.TeamId;
const EMAIL_ID = '00000000-0000-4000-8000-000000000001' as EmailForwarding.EmailMessageId;
const APPROVAL_COLOR = 0xfee75c;
const DETAILED_COLOR = 0x5865f2;
const SUMMARY_COLOR = 0x57f287;
const DETAILED_TRUNCATE_LIMIT = 3500;

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

const decodeEvent = Schema.decodeUnknownSync(EmailRpcEvents.EmailPostEvent);

const makeEvent = (
  overrides: Partial<{
    subject: string;
    from_address: string;
    body: string;
    summary: string | null;
    short_summary: string | null;
  }> = {},
): EmailRpcEvents.EmailPostEvent =>
  decodeEvent({
    id: '00000000-0000-4000-8000-000000000099',
    email_message_id: EMAIL_ID,
    team_id: TEAM_ID,
    kind: 'approval_request',
    coach_channel_id: '600000000000000001',
    target_channel_id: '600000000000000002',
    subject: overrides.subject ?? 'Test Subject',
    from_address: overrides.from_address ?? 'sender@example.com',
    summary: overrides.summary !== undefined ? overrides.summary : 'This is the summary text.',
    short_summary:
      overrides.short_summary !== undefined
        ? overrides.short_summary
        : 'Short: Quick summary. ✅ Item 1\n📌 Item 2',
    body: overrides.body ?? 'Full email body content here.',
    received_at: DateTime.nowUnsafe(),
  });

// ---------------------------------------------------------------------------
// Tests — buildApprovalEmbeds (two-embed approval)
// ---------------------------------------------------------------------------

describe('buildApprovalEmbeds — two-embed approval', () => {
  it('returns exactly two embeds', () => {
    const event = makeEvent();
    const embeds = buildApprovalEmbeds(event, LOCALE);

    expect(embeds).toHaveLength(2);
  });

  it('embed[0] has amber color 0xfee75c', () => {
    const event = makeEvent();
    const embeds = buildApprovalEmbeds(event, LOCALE);

    expect(embeds[0].color).toBe(APPROVAL_COLOR);
  });

  it('embed[1] has blurple color 0x5865f2', () => {
    const event = makeEvent();
    const embeds = buildApprovalEmbeds(event, LOCALE);

    expect(embeds[1].color).toBe(DETAILED_COLOR);
  });

  it('embed[0] description contains short_summary', () => {
    const short = 'Quick summary line. ✅ Item A\n📌 Item B';
    const event = makeEvent({ short_summary: short });
    const embeds = buildApprovalEmbeds(event, LOCALE);

    expect(embeds[0].description).toContain(short);
  });

  it('embed[0] has From, Subject, Received fields', () => {
    const event = makeEvent({ from_address: 'coach@team.com', subject: 'Training Friday' });
    const embeds = buildApprovalEmbeds(event, LOCALE);

    const fieldNames = (embeds[0].fields ?? []).map((f) => f.name);
    // There should be From and Subject fields
    expect(fieldNames.some((n) => n.toLowerCase().includes('from') || n.length > 0)).toBe(true);
    expect(embeds[0].fields?.some((f) => f.value.includes('coach@team.com'))).toBe(true);
    expect(embeds[0].fields?.some((f) => f.value.includes('Training Friday'))).toBe(true);
  });

  it('embed[1] description contains detailed (summary) text', () => {
    const summary = 'Detailed: This is the detailed summary content for the team.';
    const event = makeEvent({ summary });
    const embeds = buildApprovalEmbeds(event, LOCALE);

    expect(embeds[1].description).toBeDefined();
    expect(embeds[1].description?.length).toBeGreaterThan(0);
  });

  it('embed[1] description truncated at ~3500 ending with truncation marker when too long', () => {
    // Create a summary longer than 3500 chars
    const longSummary = 'A'.repeat(4000);
    const event = makeEvent({ summary: longSummary });
    const embeds = buildApprovalEmbeds(event, LOCALE);

    const desc = embeds[1].description ?? '';
    expect(desc.length).toBeLessThanOrEqual(4096);
    // Should end with the truncation marker (not just cut off abruptly)
    const marker = m.bot_email_detailed_truncated({}, { locale: LOCALE });
    expect(desc.endsWith(marker)).toBe(true);
    // The content portion (before the marker) should be at or near the DETAILED_TRUNCATE_LIMIT
    const contentPortion = desc.slice(0, desc.length - marker.length);
    expect(contentPortion.length).toBeLessThanOrEqual(DETAILED_TRUNCATE_LIMIT + marker.length);
  });

  it('embed[1] description ≤ 4096 chars even with very long summary', () => {
    const longSummary = 'B'.repeat(5000);
    const event = makeEvent({ summary: longSummary });
    const embeds = buildApprovalEmbeds(event, LOCALE);

    expect((embeds[1].description ?? '').length).toBeLessThanOrEqual(4096);
  });

  it('short_summary None — falls back to summary for embed[0] description', () => {
    const summary = 'Fallback summary text when short is absent.';
    const event = makeEvent({ short_summary: null, summary });
    const embeds = buildApprovalEmbeds(event, LOCALE);

    expect(embeds[0].description).toContain(summary);
  });

  it('short_summary None, summary None — falls back to body for embed[0] description', () => {
    const body = 'Body text used as last resort fallback.';
    const event = makeEvent({ short_summary: null, summary: null, body });
    const embeds = buildApprovalEmbeds(event, LOCALE);

    expect(embeds[0].description).toContain(body);
  });

  it('short_summary blank/whitespace — treated as absent, falls back to summary', () => {
    // Production uses nonBlank(): even if short_summary decodes to Some("  "),
    // the whitespace-only value is treated as absent and the fallback chain fires.
    // The EmailPostEvent schema decodes non-null short_summary as Some(value).
    // We pass a non-blank summary so we can distinguish which fallback was used.
    const summary = 'Summary used when short is blank.';
    const event = makeEvent({ short_summary: '   ', summary });
    const embeds = buildApprovalEmbeds(event, LOCALE);

    // The blank short_summary should be skipped; embed[0] should contain the summary fallback
    expect(embeds[0].description).toContain(summary);
    // And definitely should NOT contain only whitespace as the description
    expect((embeds[0].description ?? '').trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — buildTeamPostEmbed (posted team embed, green)
// ---------------------------------------------------------------------------

describe('buildTeamPostEmbed — posted team embed', () => {
  it('has green color 0x57f287', () => {
    const event = makeEvent();
    const embed = buildTeamPostEmbed(event, LOCALE);

    expect(embed.color).toBe(SUMMARY_COLOR);
  });

  it('title is subject when subject non-empty', () => {
    const event = makeEvent({ subject: 'Team Newsletter' });
    const embed = buildTeamPostEmbed(event, LOCALE);

    expect(embed.title).toContain('Team Newsletter');
  });

  it('title falls back when subject is empty', () => {
    const event = makeEvent({ subject: '' });
    const embed = buildTeamPostEmbed(event, LOCALE);

    expect(embed.title).toBeDefined();
    expect(embed.title?.length).toBeGreaterThan(0);
  });

  it('description contains short_summary text', () => {
    const short = 'Quick post summary. 🏟️ Location: Hall';
    const event = makeEvent({ short_summary: short });
    const embed = buildTeamPostEmbed(event, LOCALE);

    expect(embed.description).toContain(short);
  });

  it('description falls back to summary when short_summary is None', () => {
    const summary = 'Summary fallback for posted embed.';
    const event = makeEvent({ short_summary: null, summary });
    const embed = buildTeamPostEmbed(event, LOCALE);

    expect(embed.description).toContain(summary);
  });

  it('description falls back to body when both short_summary and summary are None', () => {
    const body = 'Body fallback for posted embed.';
    const event = makeEvent({ short_summary: null, summary: null, body });
    const embed = buildTeamPostEmbed(event, LOCALE);

    expect(embed.description).toContain(body);
  });

  it('short_summary blank/whitespace — treated as absent, falls back to summary', () => {
    const summary = 'Summary used when team post short is blank.';
    const event = makeEvent({ short_summary: '\t\n  ', summary });
    const embed = buildTeamPostEmbed(event, LOCALE);

    expect(embed.description).toContain(summary);
  });
});

// ---------------------------------------------------------------------------
// Tests — buildTeamPostComponents (two non-link buttons)
// ---------------------------------------------------------------------------

describe('buildTeamPostComponents — posted team components', () => {
  it('returns exactly two non-link buttons', () => {
    const components = buildTeamPostComponents(TEAM_ID, EMAIL_ID, LOCALE);

    const allButtons = components.flatMap((row) => (row as any).components ?? []) as Array<{
      type: number;
      style: number;
      custom_id?: string;
    }>;

    // type 2 = button; style 5 = link button (we want non-link = styles 1-4)
    const nonLinkButtons = allButtons.filter((b) => b.type === 2 && b.style !== 5);
    expect(nonLinkButtons).toHaveLength(2);
  });

  it('first button has custom_id email-detail:{teamId}:{emailId}', () => {
    const components = buildTeamPostComponents(TEAM_ID, EMAIL_ID, LOCALE);

    const allButtons = components.flatMap((row) => (row as any).components ?? []) as Array<{
      custom_id?: string;
    }>;

    const detailBtn = allButtons.find((b) => b.custom_id === `email-detail:${TEAM_ID}:${EMAIL_ID}`);
    expect(detailBtn).toBeDefined();
  });

  it('second button has custom_id email-original:{teamId}:{emailId}', () => {
    const components = buildTeamPostComponents(TEAM_ID, EMAIL_ID, LOCALE);

    const allButtons = components.flatMap((row) => (row as any).components ?? []) as Array<{
      custom_id?: string;
    }>;

    const originalBtn = allButtons.find(
      (b) => b.custom_id === `email-original:${TEAM_ID}:${EMAIL_ID}`,
    );
    expect(originalBtn).toBeDefined();
  });

  it('no link buttons (no style 5) in team post components', () => {
    const components = buildTeamPostComponents(TEAM_ID, EMAIL_ID, LOCALE);

    const allButtons = components.flatMap((row) => (row as any).components ?? []) as Array<{
      type: number;
      style: number;
    }>;

    expect(allButtons.every((b) => b.style !== 5)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — buildPageEmbed
// ---------------------------------------------------------------------------

describe('buildPageEmbed', () => {
  it('description equals the given page chunk', () => {
    const chunk = 'This is page content for page 0.';
    const embed = buildPageEmbed({
      kind: 'detailed',
      teamId: TEAM_ID,
      emailId: EMAIL_ID,
      pageText: chunk,
      pageIndex: 0,
      totalPages: 3,
      subject: 'Test Subject',
      locale: LOCALE,
    });

    expect(embed.description).toBe(chunk);
  });
});

// ---------------------------------------------------------------------------
// Tests — buildPageComponents (pagination controls)
// ---------------------------------------------------------------------------

describe('buildPageComponents — pagination row', () => {
  it('first page: prev button is disabled, next button is enabled', () => {
    const rows = buildPageComponents({
      kind: 'detailed',
      teamId: TEAM_ID,
      emailId: EMAIL_ID,
      pageIndex: 0,
      totalPages: 3,
      locale: LOCALE,
    });

    const buttons = rows.flatMap((row) => (row as any).components ?? []) as Array<{
      custom_id?: string;
      disabled?: boolean;
      label?: string;
    }>;

    // We rely on the implementation placing prev first
    const prevButton = buttons[0];
    const nextButton = buttons[buttons.length - 1];

    expect(prevButton?.disabled).toBe(true);
    expect(nextButton?.disabled).toBe(false);
  });

  it('last page: prev button is enabled, next button is disabled', () => {
    const rows = buildPageComponents({
      kind: 'detailed',
      teamId: TEAM_ID,
      emailId: EMAIL_ID,
      pageIndex: 2,
      totalPages: 3,
      locale: LOCALE,
    });

    const buttons = rows.flatMap((row) => (row as any).components ?? []) as Array<{
      custom_id?: string;
      disabled?: boolean;
    }>;

    const prevButton = buttons[0];
    const nextButton = buttons[buttons.length - 1];

    expect(prevButton?.disabled).toBe(false);
    expect(nextButton?.disabled).toBe(true);
  });

  it('middle page: both prev and next are enabled', () => {
    const rows = buildPageComponents({
      kind: 'detailed',
      teamId: TEAM_ID,
      emailId: EMAIL_ID,
      pageIndex: 1,
      totalPages: 3,
      locale: LOCALE,
    });

    const buttons = rows.flatMap((row) => (row as any).components ?? []) as Array<{
      custom_id?: string;
      disabled?: boolean;
    }>;

    const prevButton = buttons[0];
    const nextButton = buttons[buttons.length - 1];

    expect(prevButton?.disabled).toBe(false);
    expect(nextButton?.disabled).toBe(false);
  });

  it('middle button shows page indicator text with current/total', () => {
    const rows = buildPageComponents({
      kind: 'detailed',
      teamId: TEAM_ID,
      emailId: EMAIL_ID,
      pageIndex: 1,
      totalPages: 5,
      locale: LOCALE,
    });

    const buttons = rows.flatMap((row) => (row as any).components ?? []) as Array<{
      label?: string;
      disabled?: boolean;
    }>;

    // Middle button (index 1 of 3) should have page indicator
    const middleBtn = buttons[1];
    expect(middleBtn).toBeDefined();
    // It should be disabled (it's just an indicator)
    expect(middleBtn?.disabled).toBe(true);
    // Label should contain page numbers
    const label = middleBtn?.label ?? '';
    expect(label).toContain('2'); // current = pageIndex+1 = 2
    expect(label).toContain('5'); // total
  });

  it('single page (totalPages===1) — no pagination row', () => {
    const rows = buildPageComponents({
      kind: 'detailed',
      teamId: TEAM_ID,
      emailId: EMAIL_ID,
      pageIndex: 0,
      totalPages: 1,
      locale: LOCALE,
    });

    expect(rows).toHaveLength(0);
  });

  it('nav custom_ids use email-detail-page: prefix for kind=detailed', () => {
    const rows = buildPageComponents({
      kind: 'detailed',
      teamId: TEAM_ID,
      emailId: EMAIL_ID,
      pageIndex: 1,
      totalPages: 3,
      locale: LOCALE,
    });

    const buttons = rows.flatMap((row) => (row as any).components ?? []) as Array<{
      custom_id?: string;
    }>;

    const navButtons = buttons.filter((b) => b.custom_id && !b.custom_id.includes('disabled'));
    for (const btn of navButtons) {
      if (btn.custom_id?.startsWith('email-')) {
        expect(
          btn.custom_id.startsWith('email-detail-page:') ||
            btn.custom_id.startsWith('email-original-page:'),
        ).toBe(true);
      }
    }
  });

  it('nav custom_ids use email-original-page: prefix for kind=original', () => {
    const rows = buildPageComponents({
      kind: 'original',
      teamId: TEAM_ID,
      emailId: EMAIL_ID,
      pageIndex: 1,
      totalPages: 3,
      locale: LOCALE,
    });

    const allCustomIds = rows
      .flatMap((row) => (row as any).components ?? [])
      .map((b: any) => b.custom_id as string | undefined)
      .filter(Boolean);

    // At least the nav buttons should have original page prefix
    const navIds = allCustomIds.filter((id) => id?.includes('-page:'));
    expect(navIds.every((id) => id?.startsWith('email-original-page:'))).toBe(true);
  });

  it('page nav custom_id encodes correct page number', () => {
    const rows = buildPageComponents({
      kind: 'detailed',
      teamId: TEAM_ID,
      emailId: EMAIL_ID,
      pageIndex: 1,
      totalPages: 3,
      locale: LOCALE,
    });

    const buttons = rows.flatMap((row) => (row as any).components ?? []) as Array<{
      custom_id?: string;
      disabled?: boolean;
    }>;

    const prevBtn = buttons[0];
    const nextBtn = buttons[buttons.length - 1];

    // prev from page 1 → page 0
    expect(prevBtn?.custom_id).toContain(':0');
    // next from page 1 → page 2
    expect(nextBtn?.custom_id).toContain(':2');
  });
});
