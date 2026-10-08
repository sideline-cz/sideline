// TDD mode — tests written BEFORE statusHandler implementation exists.
// These tests WILL FAIL until the developer implements:
//   - applications/bot/src/commands/finance/statusHandler.ts
//   - applications/bot/src/commands/finance/buildFinanceStatusEmbed.ts (or similar)

import type { FeeAssignment } from '@sideline/domain';
import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { buildFinanceStatusEmbed } from '~/commands/finance/buildFinanceStatusEmbed.js';

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

type AssignmentFixture = {
  assignmentId: string;
  feeId: string;
  teamMemberId: string;
  feeName: string;
  currency: string;
  dueMinor: number;
  paidMinor: number;
  status: FeeAssignment.FeeAssignmentStatus;
  effectiveDueAt: string | null;
  waivedReason: string | null;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const pendingCzkAssignment: AssignmentFixture = {
  assignmentId: 'a1',
  feeId: 'fee1',
  teamMemberId: 'member1',
  feeName: 'Annual Membership',
  currency: 'CZK',
  dueMinor: 50000, // 500 CZK
  paidMinor: 0,
  status: 'pending',
  effectiveDueAt: '2025-12-31T23:59:59Z',
  waivedReason: null,
};

const overdueEurAssignment: AssignmentFixture = {
  assignmentId: 'a2',
  feeId: 'fee2',
  teamMemberId: 'member1',
  feeName: 'Tournament Entry Fee',
  currency: 'EUR',
  dueMinor: 2500, // 25 EUR
  paidMinor: 0,
  status: 'overdue',
  effectiveDueAt: '2025-01-01T00:00:00Z',
  waivedReason: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildFinanceStatusEmbed', () => {
  it('renders embed with outstanding fees grouped by currency', () => {
    const result = buildFinanceStatusEmbed({
      assignments: [pendingCzkAssignment],
      locale: 'en',
    });

    const embedText = JSON.stringify(result.embeds);
    expect(embedText).toContain('Annual Membership');
    expect(embedText).toContain('CZK');
  });

  it('empty state: no fees → green embed with all-paid-up message', () => {
    const result = buildFinanceStatusEmbed({
      assignments: [],
      locale: 'en',
    });

    expect(result.embeds).toHaveLength(1);
    const embed = result.embeds[0];
    // Green color indicates all paid up
    expect(embed.color).toBe(0x2ecc71); // Discord green
    const embedText = JSON.stringify(embed);
    expect(embedText).toMatch(/paid|up.to.date|clear|outstanding/i);
  });

  it("locale 'cs' produces Czech-language embed strings", () => {
    const result = buildFinanceStatusEmbed({
      assignments: [pendingCzkAssignment],
      locale: 'cs',
    });

    const embedText = JSON.stringify(result.embeds);
    // The embed should contain some Czech text (not just English)
    // At minimum, the title or description should differ from English
    expect(embedText.length).toBeGreaterThan(10);
    // Should not be identical to English embed for the same input
    const englishResult = buildFinanceStatusEmbed({
      assignments: [pendingCzkAssignment],
      locale: 'en',
    });
    // Czech and English embeds should differ in text
    expect(JSON.stringify(result.embeds)).not.toEqual(JSON.stringify(englishResult.embeds));
  });

  it('snapshot of embed JSON for one pending + one overdue assignment', () => {
    const result = buildFinanceStatusEmbed({
      assignments: [pendingCzkAssignment, overdueEurAssignment],
      locale: 'en',
    });

    expect(result.embeds).toHaveLength(1);
    const embed = result.embeds[0];

    // Embed must have a title
    expect(typeof embed.title).toBe('string');
    expect((embed.title ?? '').length).toBeGreaterThan(0);

    // Must have fields (one per currency or per assignment)
    expect(Array.isArray(embed.fields)).toBe(true);
    expect((embed.fields ?? []).length).toBeGreaterThan(0);

    // Should mention both currencies
    const embedText = JSON.stringify(embed);
    expect(embedText).toContain('CZK');
    expect(embedText).toContain('EUR');

    // Overdue assignment should be highlighted differently (e.g., red or overdue label)
    expect(embedText).toMatch(/overdue|OVERDUE|Overdue|po splatnosti/i);
  });

  it('renders assignment with status overdue with a distinct visual indicator', () => {
    const result = buildFinanceStatusEmbed({
      assignments: [overdueEurAssignment],
      locale: 'en',
    });

    const embedText = JSON.stringify(result.embeds);
    // Color should indicate urgency (red for overdue) or there should be a text label
    const embed = result.embeds[0];
    const hasRedColor =
      embed.color === 0xe74c3c || embed.color === 0xff0000 || embed.color === 0xed4245;
    const hasOverdueText = embedText.match(/overdue|OVERDUE/i);
    expect(hasRedColor || hasOverdueText).toBeTruthy();
  });

  it('pending assignments show outstanding amount', () => {
    const result = buildFinanceStatusEmbed({
      assignments: [pendingCzkAssignment],
      locale: 'en',
    });

    const embedText = JSON.stringify(result.embeds);
    // 50000 minor = 500 CZK — should appear in some form
    // Could be "500", "500 CZK", "500,00 CZK", etc.
    expect(embedText).toMatch(/500/);
  });

  it('waived assignments should not appear as outstanding', () => {
    const waivedAssignment: AssignmentFixture = {
      ...pendingCzkAssignment,
      assignmentId: 'a3',
      status: 'waived',
      waivedReason: 'Scholarship',
    };

    const result = buildFinanceStatusEmbed({
      assignments: [waivedAssignment],
      locale: 'en',
    });

    const embedText = JSON.stringify(result.embeds);
    // Waived assignments should not show as outstanding
    // Either they are excluded from the display or shown as waived/exempt
    const embed = result.embeds[0];
    // If all fees are waived, the embed should show a positive/neutral state
    // OR waived should be labeled clearly
    expect(embed.color === 0x2ecc71 || embedText.match(/waived|exempt|Waived/i)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Credit netting + the single standing QR (`/finance`, no subcommand)
// ---------------------------------------------------------------------------

const ACC = 'ACC:CZ6508000000192000145399';
const spaydWithAmount = `SPD*1.0*${ACC}*AM:400.00*CC:CZK*X-VS:12345`;
const spaydNoAmount = `SPD*1.0*${ACC}*CC:CZK*X-VS:12345`;

const qrOf = (spayd: string) =>
  Option.some({ spayd, imageUrl: 'attachment://qr-finance-status.png' });

describe('buildFinanceStatusEmbed — credit and QR', () => {
  it('nets credit off the summary total, leaving the per-fee amounts gross', () => {
    const embed = buildFinanceStatusEmbed({
      assignments: [pendingCzkAssignment], // 500 CZK
      credits: [{ currency: 'CZK', balanceMinor: 10000 }], // 100 CZK
      locale: 'en',
    }).embeds[0];

    // 500 − 100 owed...
    expect(embed.description).toContain('400');
    expect(embed.description).not.toContain('500');
    // ...but the fee itself is still a 500 CZK fee.
    expect(JSON.stringify(embed.fields)).toContain('500');
  });

  it('credit covering every open fee reads as covered, not as a debt', () => {
    const embed = buildFinanceStatusEmbed({
      assignments: [pendingCzkAssignment],
      credits: [{ currency: 'CZK', balanceMinor: 50000 }],
      locale: 'en',
    }).embeds[0];

    expect(embed.description).toMatch(/covered/i);
    expect(embed.color).toBe(0x2ecc71); // green, same as all-paid-up
    // The fees stay listed — the member should still see what the credit is going on.
    expect((embed.fields ?? []).length).toBeGreaterThan(0);
  });

  it('credit in another currency never offsets what is owed in this one', () => {
    const embed = buildFinanceStatusEmbed({
      assignments: [pendingCzkAssignment], // 500 CZK
      credits: [{ currency: 'EUR', balanceMinor: 50000 }],
      locale: 'en',
    }).embeds[0];

    expect(embed.description).toContain('500');
    expect(embed.description).not.toMatch(/covered/i);
  });

  it('attaches the QR and tells the member to scan it for the whole sum', () => {
    const embed = buildFinanceStatusEmbed({
      assignments: [pendingCzkAssignment],
      credits: [{ currency: 'CZK', balanceMinor: 10000 }],
      qr: qrOf(spaydWithAmount),
      locale: 'en',
    }).embeds[0];

    expect(embed.image?.url).toBe('attachment://qr-finance-status.png');
    expect(embed.description).toMatch(/settle everything at once/i);
  });

  it('a QR carrying no amount gets the "send any amount" wording, not the pay-it-all one', () => {
    const embed = buildFinanceStatusEmbed({
      assignments: [],
      qr: qrOf(spaydNoAmount),
      locale: 'en',
    }).embeds[0];

    expect(embed.image?.url).toBe('attachment://qr-finance-status.png');
    expect(embed.description).toMatch(/any amount/i);
    expect(embed.description).not.toMatch(/settle everything at once/i);
  });

  it('renders exactly as before when the club has no usable QR', () => {
    const embed = buildFinanceStatusEmbed({
      assignments: [pendingCzkAssignment],
      locale: 'en',
    }).embeds[0];

    expect(embed.image).toBeUndefined();
    expect(embed.description).not.toMatch(/scan/i);
  });
});
