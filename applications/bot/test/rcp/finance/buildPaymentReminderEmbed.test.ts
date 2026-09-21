import type { Fee, FeeAssignment, Team } from '@sideline/domain';
import { type Discord, FinanceRpcEvents } from '@sideline/domain';
import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  buildPaymentReminderComponents,
  buildPaymentReminderEmbed,
} from '~/rcp/finance/buildPaymentReminderEmbed.js';

const GUILD_ID = '111111111111111111' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const ASSIGNMENT_ID = '00000000-0000-0000-0000-000000000040' as FeeAssignment.FeeAssignmentId;
const DISCORD_USER_ID = '222222222222222222' as Discord.Snowflake;

const makeEvent = (
  overrides: Partial<{
    kind: FinanceRpcEvents.PaymentReminderReadyEvent['kind'];
    fee_name: string;
    amount_minor: Fee.AmountMinor;
    paid_minor: Fee.AmountMinor;
    currency: Fee.CurrencyCode;
  }> = {},
) =>
  new FinanceRpcEvents.PaymentReminderReadyEvent({
    id: '00000000-0000-0000-0000-000000000001',
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    assignment_id: ASSIGNMENT_ID,
    kind: 'due_today',
    fee_name: 'Příspěvek podzim 2026',
    effective_due_at: '2026-10-31T00:00:00.000Z',
    currency: 'CZK' as Fee.CurrencyCode,
    amount_minor: 150000 as Fee.AmountMinor,
    paid_minor: 0 as Fee.AmountMinor,
    user_discord_id: DISCORD_USER_ID,
    ...overrides,
  });

const SPAYD =
  'SPD*1.0*ACC:CZ6508000000192000145399*AM:1500.00*CC:CZK*X-VS:2026014*MSG:PRISPEVEK PODZIM 2026 NOVAK*DT:20261031*';

describe('buildPaymentReminderEmbed', () => {
  it('renders the assigned kind with a neutral first-contact title', () => {
    const embed = buildPaymentReminderEmbed(makeEvent({ kind: 'assigned' }), 'cs', Option.none());
    expect(embed.title).toBe('Nový předpis k úhradě');
    expect(embed.color).toBe(0x5865f2);
  });

  it('has 3 fields (no VS) and no image when no QR is available', () => {
    const embed = buildPaymentReminderEmbed(makeEvent(), 'en', Option.none());
    expect(embed.fields).toHaveLength(3);
    expect(embed.image).toBeUndefined();
    expect(embed.fields?.map((f) => f.name)).not.toContain('Variable symbol');
  });

  it('adds the VS field, the image, and the fallback block when a QR is available', () => {
    const embed = buildPaymentReminderEmbed(
      makeEvent(),
      'cs',
      Option.some({ spayd: SPAYD, imageUrl: 'attachment://qr-test.png' }),
    );

    expect(embed.fields).toHaveLength(4);
    expect(embed.image).toEqual({ url: 'attachment://qr-test.png' });

    const vsField = embed.fields?.find((f) => f.name === 'Variabilní symbol');
    expect(vsField?.value).toBe('2026014');

    // The fallback block renders the QR payload's uppercase-ASCII message VERBATIM — never
    // re-accented — while the rest of the embed keeps full Czech diacritics (design §6.4/6.2).
    expect(embed.description).toContain('PRISPEVEK PODZIM 2026 NOVAK');
    expect(embed.description).toContain('CZ6508000000192000145399'); // the account (IBAN) line
  });

  it('never re-accents the SPAYD MSG even when the rest of the embed is Czech', () => {
    const embed = buildPaymentReminderEmbed(
      makeEvent({ fee_name: 'Příspěvek podzim 2026' }),
      'cs',
      Option.some({ spayd: SPAYD, imageUrl: 'attachment://qr-test.png' }),
    );

    expect(embed.description).toContain('Příspěvek podzim 2026'); // body keeps diacritics
    expect(embed.description).toContain('PRISPEVEK PODZIM 2026 NOVAK'); // fallback does not
    expect(embed.description).toContain('⚠️ Bez variabilního symbolu platbu nespárujeme.');
  });

  it('formats the overdue kinds with the shared title but distinct day counts', () => {
    const e3 = buildPaymentReminderEmbed(makeEvent({ kind: 'overdue_3d' }), 'en', Option.none());
    const e10 = buildPaymentReminderEmbed(makeEvent({ kind: 'overdue_10d' }), 'en', Option.none());
    expect(e3.title).toBe('Payment overdue');
    expect(e10.title).toBe('Payment overdue');
    expect(e3.description).toContain('3 days overdue');
    expect(e10.description).toContain('10 days overdue');
  });
});

describe('buildPaymentReminderComponents', () => {
  it('returns no rows when WEB_URL is unset', () => {
    expect(buildPaymentReminderComponents(TEAM_ID, Option.none(), 'en')).toHaveLength(0);
  });

  it('links to /teams/:teamId/my-payments when WEB_URL is set', () => {
    const rows = buildPaymentReminderComponents(TEAM_ID, Option.some('https://app.test/'), 'cs');
    expect(rows).toHaveLength(1);
    const [row] = rows;
    const button = (row as { components: ReadonlyArray<{ url?: string; label?: string }> })
      .components[0];
    expect(button?.url).toBe(`https://app.test/teams/${TEAM_ID}/my-payments`);
    expect(button?.label).toBe('Moje platby');
  });
});
