// TDD mode — tests written BEFORE the FinancesOverviewPage component exists.
// These tests WILL FAIL until the developer implements:
//   - applications/web/src/components/pages/FinancesOverviewPage.tsx
//   - applications/web/src/lib/finance/formatMoney.ts (or similar)
//
// Extended (2nd pass) to cover tab navigation and "By assignment" tab.
// New tests expect the component to accept an optional `assignmentsTabContent` prop
// (or render tabs internally) for the "By assignment" view.
//
// Additional components expected (will also fail until implemented):
//   - The FinancesOverviewPage receives a `tabs` prop or renders "By member" + "By assignment" tabs

import { fireEvent, render, screen } from '@testing-library/react';
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
      // Tab labels
      finance_tab_byMember: 'By member',
      finance_tab_byAssignment: 'By assignment',
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
  creditMinor: number;
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
  creditMinor: 0,
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
  creditMinor: 0,
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
// Tab navigation tests (added in 2nd TDD pass)
// ---------------------------------------------------------------------------
//
// These tests expect FinancesOverviewPage to accept an additional prop:
//   assignmentsTabContent?: React.ReactNode
//
// When provided, the component should render two tabs:
//   "By member" (default, active) and "By assignment"
// Clicking "By assignment" renders the provided ReactNode in place of the member table.
//
// When canManageFees=false (or no action handlers), action buttons/dialogs
// should not be present in the component's own toolbar.

describe('FinancesOverviewPage — tab navigation', () => {
  it('"By member" tab is selected by default when tabs are present', () => {
    render(
      <FinancesOverviewPage
        rows={sampleRows}
        assignmentsTabContent={<div data-testid='assignments-view'>Assignments here</div>}
      />,
    );
    // The "By member" tab button should be visible
    expect(screen.getByRole('tab', { name: /By member/i })).not.toBeNull();
    // The assignments view should NOT be visible by default
    expect(screen.queryByTestId('assignments-view')).toBeNull();
  });

  it('clicking "By assignment" tab renders the assignments tab content', () => {
    render(
      <FinancesOverviewPage
        rows={sampleRows}
        assignmentsTabContent={<div data-testid='assignments-view'>Assignments here</div>}
      />,
    );
    const byAssignmentTab = screen.getByRole('tab', { name: /By assignment/i });
    fireEvent.click(byAssignmentTab);
    expect(screen.getByTestId('assignments-view')).not.toBeNull();
  });

  it('switching back to "By member" shows the overview content again', () => {
    render(
      <FinancesOverviewPage
        rows={sampleRows}
        assignmentsTabContent={<div data-testid='assignments-view'>Assignments here</div>}
      />,
    );
    const byAssignmentTab = screen.getByRole('tab', { name: /By assignment/i });
    fireEvent.click(byAssignmentTab);
    const byMemberTab = screen.getByRole('tab', { name: /By member/i });
    fireEvent.click(byMemberTab);
    // Assignments view gone, member list back
    expect(screen.queryByTestId('assignments-view')).toBeNull();
    expect(screen.getByText('Alice')).not.toBeNull();
  });

  it('renders normally (single tab / no tabs) when no assignmentsTabContent provided', () => {
    // Backwards compatible: existing props-only usage should still work
    render(<FinancesOverviewPage rows={sampleRows} />);
    expect(screen.getByText('Alice')).not.toBeNull();
    // No tab buttons expected in the original single-pane layout
    // (the component may add tabs in future — just verify member list is visible)
  });
});

// ---------------------------------------------------------------------------
// [R2] KPI currency vote — settle-all-and-credit-architecture.md §6.3 / §9
// ---------------------------------------------------------------------------

describe('FinancesOverviewPage — KPI currency vote excludes credit-only rows', () => {
  it('a credit-only EUR row does not flip the KPI currency away from CZK', () => {
    // Deliberately ONE assignment-bearing CZK row against TWO credit-only EUR rows —
    // `pickMostFrequentCurrency` votes by row count, so without the `kpiRows` filter EUR
    // would win 2-to-1 and this test would pass on unfixed code too.
    const czkRow: MemberOverviewRow = {
      teamMemberId: 'member-czk-0',
      memberName: 'Member 0',
      currency: 'CZK',
      totalDueMinor: 100000, // 1000 CZK
      totalPaidMinor: 0,
      overdueCount: 1,
      pendingCount: 0,
      paidCount: 0,
      creditMinor: 0,
    };
    const eurCreditOnlyRows: MemberOverviewRow[] = Array.from({ length: 2 }, (_, i) => ({
      teamMemberId: `member-eur-credit-${i}`,
      memberName: `Credit Holder ${i}`,
      currency: 'EUR',
      totalDueMinor: 0,
      totalPaidMinor: 0,
      overdueCount: 0,
      pendingCount: 0,
      paidCount: 0,
      creditMinor: 50000, // €500 credit, no assignments at all
    }));

    render(<FinancesOverviewPage rows={[czkRow, ...eurCreditOnlyRows]} />);

    // KPI cards must stay in CZK: 1000 CZK total due, never €0.00.
    const totalDueEl = document.querySelector('[data-kpi="total-due"]');
    expect(totalDueEl).not.toBeNull();
    expect(totalDueEl?.textContent).toMatch(/1[,.\s]?000/);
    expect(totalDueEl?.textContent).not.toMatch(/€/);
  });
});

// ---------------------------------------------------------------------------
// [Adversarial review #2] all-waived team must not regress to the "no fees" empty state
// ---------------------------------------------------------------------------

describe('FinancesOverviewPage — an all-waived team is not the "no fees" empty state', () => {
  it('a team whose only member has every fee waived does not fall back to "no fees yet"', () => {
    // Waived assignments land in none of overdueCount/pendingCount/paidCount (the overview SQL
    // only counts overdue / pending|partial / paid) — same zero-count signature as a
    // credit-only row. `kpiRows` (which excludes zero-count rows) must only gate the currency
    // vote, never the empty state, or this row vanishes behind "You have no fees yet." With
    // every row zero-count, `worstStatus` reads them all as 'paid' and the (pre-existing,
    // unaffected-by-this-fix) all-caught-up branch renders instead — never the "no fees" CTA.
    const allWaivedRow: MemberOverviewRow = {
      teamMemberId: 'member-waived',
      memberName: 'Waived Member',
      currency: 'CZK',
      totalDueMinor: 0,
      totalPaidMinor: 0,
      overdueCount: 0,
      pendingCount: 0,
      paidCount: 0,
      creditMinor: 0,
    };

    render(<FinancesOverviewPage rows={[allWaivedRow]} />);

    expect(screen.queryByText(/No fees yet/i)).toBeNull();
    expect(screen.getByText('finance_empty_allPaid')).not.toBeNull();
  });

  it('worstStatus badges a zero-count row (all-waived or credit-only) as paid, not pending', () => {
    // [R3] fixed the credit-only case (a member who owes nothing must not show a Pending
    // badge); the same zero-count signature is indistinguishable from an all-waived member
    // with the fields this row carries. Badging it "paid" (nothing owed) is the accepted
    // behavior for both — pinned here so a future change notices it. Paired with a genuinely
    // overdue row so the "all paid" branch doesn't short-circuit the table itself.
    const zeroCountRow: MemberOverviewRow = {
      teamMemberId: 'member-zero',
      memberName: 'Zero Count',
      currency: 'CZK',
      totalDueMinor: 0,
      totalPaidMinor: 0,
      overdueCount: 0,
      pendingCount: 0,
      paidCount: 0,
      creditMinor: 0,
    };

    render(<FinancesOverviewPage rows={[zeroCountRow, MEMBER_B_CZK]} />);

    expect(document.querySelector('[data-status="paid"]')).not.toBeNull();
    expect(document.querySelector('[data-status="pending"]')).toBeNull();
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
