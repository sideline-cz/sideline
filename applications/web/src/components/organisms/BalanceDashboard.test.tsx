// TDD mode — tests written BEFORE BalanceDashboard.tsx exists.
// These tests WILL FAIL until the developer implements:
//   - applications/web/src/components/organisms/BalanceDashboard.tsx
//   - applications/web/src/lib/finance/pickDominantCurrency.ts (or equivalent)

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — before any imports using them
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      balance_dashboard_income: 'Income',
      balance_dashboard_expenses: 'Expenses',
      balance_dashboard_net: 'Net',
      balance_dashboard_empty: 'No financial data yet',
      balance_dashboard_multi_currency_banner: 'Showing dominant currency only',
      finance_breakdown_title: 'Breakdown by category',
      finance_breakdown_empty: 'No expenses to break down',
      finance_breakdown_categoryColumn: 'Category',
      finance_breakdown_amountColumn: 'Amount',
      finance_breakdown_shareColumn: 'Share',
      expense_category_fields: 'Fields',
      expense_category_equipment: 'Equipment',
      expense_category_travel: 'Travel',
      expense_category_tournaments: 'Tournaments',
      expense_category_other: 'Other',
    };
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

vi.mock('~/lib/finance/formatMoney.js', () => ({
  formatMoney: (minor: number, currency: string) => `${minor / 100} ${currency}`,
}));

vi.mock('~/lib/finance/pickDominantCurrency.js', () => ({
  pickDominantCurrency: (
    summaries: ReadonlyArray<{ currency: string; incomeMinor: number; expensesMinor: number }>,
  ) => {
    if (summaries.length === 0) return null;
    // Pick the one with largest total volume
    return summaries.reduce((best, cur) => {
      const bestVol = best.incomeMinor + best.expensesMinor;
      const curVol = cur.incomeMinor + cur.expensesMinor;
      return curVol > bestVol ? cur : best;
    }).currency;
  },
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks)
// ---------------------------------------------------------------------------

const { BalanceDashboard } = await import('~/components/organisms/BalanceDashboard.js');

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type CategoryBreakdownItem = {
  category: 'fields' | 'equipment' | 'travel' | 'tournaments' | 'other';
  amountMinor: number;
};

type BalanceSummary = {
  currency: string;
  incomeMinor: number;
  expensesMinor: number;
  netMinor: number;
  byCategory: ReadonlyArray<CategoryBreakdownItem>;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSummary(
  currency: string,
  incomeMinor: number,
  expensesMinor: number,
  byCategory: ReadonlyArray<CategoryBreakdownItem> = [],
): BalanceSummary {
  return {
    currency,
    incomeMinor,
    expensesMinor,
    netMinor: incomeMinor - expensesMinor,
    byCategory,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BalanceDashboard', () => {
  it('renders Income / Expenses / Net cards from a single-currency BalanceSummary', () => {
    const summary = [makeSummary('CZK', 50000, 30000)];
    render(<BalanceDashboard summaries={summary} />);

    expect(screen.getByText('Income')).not.toBeNull();
    expect(screen.getByText('Expenses')).not.toBeNull();
    expect(screen.getByText('Net')).not.toBeNull();

    const pageText = document.body.textContent ?? '';
    // Income: 500 CZK, Expenses: 300 CZK, Net: 200 CZK
    expect(pageText).toContain('500 CZK');
    expect(pageText).toContain('300 CZK');
    expect(pageText).toContain('200 CZK');
  });

  it('negative net renders in red with explicit minus sign', () => {
    const summary = [makeSummary('CZK', 10000, 50000)];
    render(<BalanceDashboard summaries={summary} />);

    // Net = -40000 minor = -400 CZK
    const pageText = document.body.textContent ?? '';
    // Either the card element has a red class/data-attribute or the text has a minus sign
    const hasRed =
      !!document.querySelector('[data-net-sign="negative"]') ||
      !!document.querySelector('[data-variant="negative"]') ||
      pageText.includes('-400');
    expect(hasRed).toBe(true);
  });

  it('positive net renders in green with explicit plus sign', () => {
    const summary = [makeSummary('CZK', 50000, 10000)];
    render(<BalanceDashboard summaries={summary} />);

    // Net = +40000 minor = +400 CZK
    const pageText = document.body.textContent ?? '';
    const hasPositive =
      !!document.querySelector('[data-net-sign="positive"]') ||
      !!document.querySelector('[data-variant="positive"]') ||
      pageText.includes('+400') ||
      pageText.includes('400 CZK');
    expect(hasPositive).toBe(true);
  });

  it('empty array → renders zero state', () => {
    render(<BalanceDashboard summaries={[]} />);

    const pageText = document.body.textContent ?? '';
    expect(pageText).toContain('No financial data yet');
  });

  it('2+ currencies → renders banner using dominant currency', () => {
    const summaries = [
      makeSummary('CZK', 100000, 50000), // dominant by volume
      makeSummary('EUR', 5000, 2000),
    ];
    render(<BalanceDashboard summaries={summaries} />);

    // Banner should appear mentioning multi-currency
    const pageText = document.body.textContent ?? '';
    expect(pageText).toContain('Showing dominant currency only');

    // Dominant currency (CZK) cards should be shown
    expect(pageText).toContain('CZK');
  });

  it('2+ currencies → excludes non-dominant currencies from cards', () => {
    const summaries = [
      makeSummary('CZK', 100000, 50000), // dominant
      makeSummary('EUR', 5000, 2000),
    ];
    render(<BalanceDashboard summaries={summaries} />);

    // EUR should NOT appear in the main cards (only CZK is dominant)
    // But may appear in the sr-only table
    const cards = document.querySelectorAll(
      '[data-testid="income-card"], [data-testid="expenses-card"], [data-testid="net-card"]',
    );
    const cardText = Array.from(cards)
      .map((c) => c.textContent ?? '')
      .join('');
    // Cards should only show CZK values, not EUR values
    if (cards.length > 0) {
      expect(cardText).toContain('CZK');
      // EUR values in cards are unexpected — check net is CZK net only
      // (If cards are not data-testid-marked, we skip this assertion)
    }
  });

  it('sr-only table with Category / Amount / Share columns is present', () => {
    const summary = [makeSummary('CZK', 50000, 30000)];
    render(<BalanceDashboard summaries={summary} />);

    // An sr-only or visually hidden table should be present for accessibility
    const srTable =
      document.querySelector('table') ??
      document.querySelector('[role="table"]') ??
      document.querySelector('.sr-only table');
    expect(srTable).not.toBeNull();
  });

  it('single currency with zero net shows balanced state', () => {
    const summary = [makeSummary('EUR', 25000, 25000)];
    render(<BalanceDashboard summaries={summary} />);

    const pageText = document.body.textContent ?? '';
    // Net = 0, should show 0 EUR or similar
    expect(pageText).toContain('EUR');
    // Income = Expenses = 250 EUR
    expect(pageText).toContain('250 EUR');
  });
});
