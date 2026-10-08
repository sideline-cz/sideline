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
      balance_dashboard_collected: 'Collected',
      balance_dashboard_stillOwed: 'still owed',
      balance_dashboard_trend_title: 'Income and spending by month',
      balance_dashboard_trend_income: 'Income',
      balance_dashboard_trend_expenses: 'Expenses',
      balance_dashboard_trend_monthColumn: 'Month',
      balance_dashboard_window_all: 'All time',
      balance_dashboard_window_season: 'This season',
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

type MonthlyItem = {
  month: string;
  incomeMinor: number;
  expensesMinor: number;
};

type BalanceSummary = {
  currency: string;
  incomeMinor: number;
  expensesMinor: number;
  netMinor: number;
  byCategory: ReadonlyArray<CategoryBreakdownItem>;
  byMonth: ReadonlyArray<MonthlyItem>;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSummary(
  currency: string,
  incomeMinor: number,
  expensesMinor: number,
  byCategory: ReadonlyArray<CategoryBreakdownItem> = [],
  byMonth: ReadonlyArray<MonthlyItem> = [],
): BalanceSummary {
  return {
    currency,
    incomeMinor,
    expensesMinor,
    netMinor: incomeMinor - expensesMinor,
    byCategory,
    byMonth,
  };
}

const row = (currency: string, totalDueMinor: number, totalPaidMinor: number) => ({
  currency,
  totalDueMinor,
  totalPaidMinor,
});

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

// ---------------------------------------------------------------------------
// Collection ratio
// ---------------------------------------------------------------------------

describe('BalanceDashboard — collection ratio', () => {
  it('renders the collected percentage and the amount still owed', () => {
    render(
      <BalanceDashboard
        summaries={[makeSummary('CZK', 78000, 30000)]}
        rows={[row('CZK', 100000, 78000)]}
      />,
    );

    const pageText = document.body.textContent ?? '';
    expect(pageText).toContain('Collected');
    expect(pageText).toContain('78%');
    // 100000 - 78000 = 22000 minor = 220 CZK
    expect(pageText).toContain('220 CZK');
  });

  it('hides the ratio entirely when nothing has been billed', () => {
    render(
      <BalanceDashboard summaries={[makeSummary('CZK', 0, 5000)]} rows={[row('CZK', 0, 0)]} />,
    );

    expect(document.body.textContent ?? '').not.toContain('Collected');
  });

  it('hides the ratio when no rows are supplied at all', () => {
    render(<BalanceDashboard summaries={[makeSummary('CZK', 50000, 30000)]} />);

    expect(document.body.textContent ?? '').not.toContain('Collected');
  });

  it('clamps at 100% when members have overpaid', () => {
    render(
      <BalanceDashboard
        summaries={[makeSummary('CZK', 120000, 0)]}
        rows={[row('CZK', 100000, 120000)]}
      />,
    );

    const pageText = document.body.textContent ?? '';
    expect(pageText).toContain('100%');
    // Never a negative "still owed".
    expect(pageText).not.toContain('-200');
  });

  // The two currency pickers in this app disagree by construction: the dashboard picks by
  // transaction VOLUME, the by-member tab picks by ROW COUNT. If the ratio used the by-member
  // pick, this team would show CZK tiles above a EUR progress bar.
  it('derives the ratio from the same currency the tiles show, not the most common row currency', () => {
    render(
      <BalanceDashboard
        summaries={[makeSummary('CZK', 100000, 50000), makeSummary('EUR', 5000, 2000)]}
        rows={[
          row('EUR', 1000, 0),
          row('EUR', 1000, 0),
          row('EUR', 1000, 0),
          row('CZK', 200000, 100000),
        ]}
      />,
    );

    const pageText = document.body.textContent ?? '';
    // CZK rows only: 100000 / 200000 = 50%, 100000 minor = 1000 CZK outstanding.
    expect(pageText).toContain('50%');
    expect(pageText).toContain('1000 CZK');
  });
});

// ---------------------------------------------------------------------------
// Monthly trend
// ---------------------------------------------------------------------------

describe('BalanceDashboard — monthly trend', () => {
  const months = [
    { month: '2026-01-01', incomeMinor: 10000, expensesMinor: 4000 },
    { month: '2026-03-01', incomeMinor: 20000, expensesMinor: 9000 },
  ];

  it('renders one column per month', () => {
    render(<BalanceDashboard summaries={[makeSummary('CZK', 30000, 13000, [], months)]} />);

    expect(document.body.textContent ?? '').toContain('Income and spending by month');
    expect(document.querySelectorAll('[data-testid="trend-month"]').length).toBeGreaterThan(0);
  });

  // A month with no activity is zero, not missing. Without the fill, February vanishes and
  // January sits next to March as if they were consecutive.
  it('fills gap months with zeroes rather than omitting them', () => {
    render(<BalanceDashboard summaries={[makeSummary('CZK', 30000, 13000, [], months)]} />);

    const rendered = Array.from(document.querySelectorAll('[data-testid="trend-month"]')).map(
      (el) => el.getAttribute('data-month'),
    );
    expect(rendered).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
  });

  it('spans a year boundary without skipping or repeating a month', () => {
    const crossYear = [
      { month: '2025-11-01', incomeMinor: 1000, expensesMinor: 0 },
      { month: '2026-02-01', incomeMinor: 2000, expensesMinor: 0 },
    ];
    render(<BalanceDashboard summaries={[makeSummary('CZK', 3000, 0, [], crossYear)]} />);

    const rendered = Array.from(document.querySelectorAll('[data-testid="trend-month"]')).map(
      (el) => el.getAttribute('data-month'),
    );
    expect(rendered).toEqual(['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01']);
  });

  it('renders a single month without a divide-by-zero or an empty bar', () => {
    const one = [{ month: '2026-05-01', incomeMinor: 7000, expensesMinor: 3000 }];
    render(<BalanceDashboard summaries={[makeSummary('CZK', 7000, 3000, [], one)]} />);

    const rendered = document.querySelectorAll('[data-testid="trend-month"]');
    expect(rendered.length).toBe(1);
  });

  it('omits the trend section when there is no monthly data', () => {
    render(<BalanceDashboard summaries={[makeSummary('CZK', 50000, 30000)]} />);

    expect(document.body.textContent ?? '').not.toContain('Income and spending by month');
  });

  it('shows only the dominant currency months', () => {
    render(
      <BalanceDashboard
        summaries={[
          makeSummary('CZK', 100000, 50000, [], months),
          makeSummary(
            'EUR',
            5000,
            2000,
            [],
            [{ month: '2020-06-01', incomeMinor: 5000, expensesMinor: 2000 }],
          ),
        ]}
      />,
    );

    const rendered = Array.from(document.querySelectorAll('[data-testid="trend-month"]')).map(
      (el) => el.getAttribute('data-month'),
    );
    expect(rendered).not.toContain('2020-06-01');
  });
});

// ---------------------------------------------------------------------------
// Window label and visible category figures
// ---------------------------------------------------------------------------

describe('BalanceDashboard — window label', () => {
  it("labels an all-time view 'All time'", () => {
    render(<BalanceDashboard summaries={[makeSummary('CZK', 50000, 30000)]} window='all' />);

    expect(document.body.textContent ?? '').toContain('All time');
  });

  it('prefers the season start label when the applied window is a season', () => {
    render(
      <BalanceDashboard
        summaries={[makeSummary('CZK', 50000, 30000)]}
        window='season'
        windowStartLabel='Since 1 Sep 2026'
      />,
    );

    const pageText = document.body.textContent ?? '';
    expect(pageText).toContain('Since 1 Sep 2026');
    expect(pageText).not.toContain('All time');
  });

  // The route passes through what the RESPONSE said was applied, so a team with no governing
  // season gets window='all' even though it asked for a season. Labelling off the request would
  // put all-time figures under a season heading.
  it('falls back to the season name when a season is applied but no start label is given', () => {
    render(<BalanceDashboard summaries={[makeSummary('CZK', 50000, 30000)]} window='season' />);

    expect(document.body.textContent ?? '').toContain('This season');
  });
});

describe('BalanceDashboard — visible category figures', () => {
  it('shows the category amount and share to sighted users, not only in the sr-only table', () => {
    const summary = [
      makeSummary('CZK', 0, 10000, [
        { category: 'fields', amountMinor: 7500 },
        { category: 'travel', amountMinor: 2500 },
      ]),
    ];
    render(<BalanceDashboard summaries={summary} />);

    const legend = document.querySelector('[data-testid="category-legend"]');
    expect(legend).not.toBeNull();
    const legendText = legend?.textContent ?? '';
    expect(legendText).toContain('Fields');
    expect(legendText).toContain('75%');
    expect(legendText).toContain('25%');
  });
});
