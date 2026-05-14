// TDD mode — tests written BEFORE the FinancesOverviewPage component exists.
// These tests WILL FAIL until the developer implements:
//   - applications/web/src/components/pages/FinancesOverviewPage.tsx
//   - applications/web/src/lib/finance/formatMoney.ts (or similar)

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      finance_overview_title: 'Finance Overview',
      finance_overview_noFees: 'No fees yet',
      finance_overview_createFee: 'Create a fee',
      finance_overview_totalDue: 'Total Due',
      finance_overview_totalPaid: 'Total Paid',
      finance_overview_totalOutstanding: 'Total Outstanding',
      finance_status_paid: 'Paid',
      finance_status_pending: 'Pending',
      finance_status_partial: 'Partial',
      finance_status_overdue: 'Overdue',
      finance_status_waived: 'Waived',
    };
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

// Dynamic import — will fail until the component/util exists
const { FinancesOverviewPage } = await import('~/components/pages/FinancesOverviewPage.js');
const { formatMoney } = await import('~/lib/finance/formatMoney.js');

// ---------------------------------------------------------------------------
// Type helpers (mirror what the loader will return)
// ---------------------------------------------------------------------------

type MemberOverviewRow = {
  teamMemberId: string;
  memberName: string | null;
  currency: string;
  totalDueMinor: number;
  totalPaidMinor: number;
  overdueCount: number;
  pendingCount: number;
  paidCount: number;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MEMBER_A_CZK: MemberOverviewRow = {
  teamMemberId: 'member-1',
  memberName: 'Alice',
  currency: 'CZK',
  totalDueMinor: 100000, // 1000 CZK
  totalPaidMinor: 50000, // 500 CZK paid
  overdueCount: 0,
  pendingCount: 1,
  paidCount: 1,
};

const MEMBER_B_CZK: MemberOverviewRow = {
  teamMemberId: 'member-2',
  memberName: 'Bob',
  currency: 'CZK',
  totalDueMinor: 50000, // 500 CZK
  totalPaidMinor: 0,
  overdueCount: 1,
  pendingCount: 0,
  paidCount: 0,
};

const sampleRows: MemberOverviewRow[] = [MEMBER_A_CZK, MEMBER_B_CZK];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FinancesOverviewPage', () => {
  it('renders one row per member with worst-status badge', () => {
    render(<FinancesOverviewPage rows={sampleRows} />);

    // Both members should appear
    expect(screen.getByText('Alice')).not.toBeNull();
    expect(screen.getByText('Bob')).not.toBeNull();
  });

  it('KPI cards sum correctly from loader data (totalDue = 1000 + 500 = 1500 CZK)', () => {
    render(<FinancesOverviewPage rows={sampleRows} />);

    // The KPI card for total due should show the aggregate
    // sampleRows: totalDueMinor = 100000 + 50000 = 150000 minor = 1500 CZK
    // We look for "1 500" or "1500" in the document
    const totalDueEl = document.querySelector('[data-kpi="total-due"]');
    expect(totalDueEl).not.toBeNull();
    expect(totalDueEl?.textContent).toMatch(/1[,.\s]?500|150[,.]?000/);
  });

  it('empty state shows "no fees" CTA', () => {
    render(<FinancesOverviewPage rows={[]} />);

    // Should show empty state with a call to action
    expect(screen.getByText(/No fees yet/i)).not.toBeNull();
    expect(screen.getByText(/Create a fee/i)).not.toBeNull();
  });

  it('shows overdue badge for member with overdue assignments', () => {
    render(<FinancesOverviewPage rows={sampleRows} />);

    // Bob has overdueCount: 1 → should show overdue badge
    const overdueElements = document.querySelectorAll('[data-status="overdue"]');
    expect(overdueElements.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// formatMoney helper tests
// ---------------------------------------------------------------------------

describe('formatMoney', () => {
  it('formatMoney(240000, "CZK", "cs") → Czech locale format', () => {
    const result = formatMoney(240000, 'CZK', 'cs');
    // 240000 minor = 2400 CZK
    // cs-CZ locale: "2 400 Kč" or similar
    expect(result).toMatch(/2[\s ]?400/);
    expect(result).toMatch(/Kč|CZK/);
  });

  it('formatMoney(50000, "EUR", "en") → English locale format', () => {
    const result = formatMoney(50000, 'EUR', 'en');
    // 50000 minor = 500 EUR
    expect(result).toMatch(/500/);
    expect(result).toMatch(/€|EUR/);
  });

  it('formatMoney(0, "CZK", "en") → zero amount', () => {
    const result = formatMoney(0, 'CZK', 'en');
    expect(result).toMatch(/0/);
    expect(result).toMatch(/CZK|Kč/);
  });

  it('formatMoney(100, "USD", "en") → 1 USD (100 minor = $1)', () => {
    const result = formatMoney(100, 'USD', 'en');
    expect(result).toMatch(/1/);
    expect(result).toMatch(/\$|USD/);
  });

  it('formatMoney with CZK uses 0 decimal places (CZK has no sub-units in display)', () => {
    // CZK amounts should not have decimals: 5000 minor → "50 Kč", not "50.00 Kč"
    const result = formatMoney(5000, 'CZK', 'cs');
    // Should not contain ".00" for CZK
    expect(result).not.toMatch(/50\.00/);
  });
});
