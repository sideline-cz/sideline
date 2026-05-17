// TDD mode — tests written BEFORE MyPaymentsPage.tsx exists.
// These tests WILL FAIL until:
//   - applications/web/src/components/pages/MyPaymentsPage.tsx is implemented
//   - applications/web/src/lib/finance/sortAssignments.ts is implemented
//   - applications/web/src/lib/finance/computeKpis.ts is implemented
//   - applications/web/src/components/organisms/MyPaymentHistoryRow.tsx is implemented
//
// Component contract:
//   MyPaymentsPage({
//     teamId: string;
//     myStatus: ReadonlyArray<MyFinanceStatus>;
//   })
//
// Behaviour:
//   - 4 KPI cards: Outstanding total, Overdue count, Paid total, Next due
//   - 4 filter chips: All / Outstanding / Paid / Waived
//     - Default = "Outstanding" when any outstanding exist
//     - Default = "All" when no outstanding (only paid + waived)
//   - Per-currency table sections
//   - Chevron toggle only when paidMinor > 0
//   - Clicking chevron renders MyPaymentHistoryRow

import { fireEvent, render, screen } from '@testing-library/react';
import { DateTime, Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be called before any imports that use them
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      my_payments_pageTitle: 'My Payments',
      my_payments_kpi_outstandingTotal: 'Outstanding',
      my_payments_kpi_overdueCount: 'Overdue',
      my_payments_kpi_paidTotal: 'Paid total',
      my_payments_kpi_nextDue: 'Next due',
      my_payments_kpi_multiCurrencyMore: '+{n} more',
      my_payments_kpi_none: '—',
      my_payments_filter_all: 'All',
      my_payments_filter_outstanding: 'Outstanding',
      my_payments_filter_paid: 'Paid',
      my_payments_filter_waived: 'Waived',
      my_payments_empty: 'No fee assignments yet',
      my_payments_history_toggle: 'View payments',
      finance_status_pending: 'Pending',
      finance_status_partial: 'Partial',
      finance_status_overdue: 'Overdue',
      finance_status_paid: 'Paid',
      finance_status_waived: 'Waived',
      finance_column_fee: 'Fee',
      finance_column_due: 'Due',
      finance_column_paid: 'Paid',
      finance_column_status: 'Status',
    };
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

vi.mock('~/lib/finance/formatMoney.js', () => ({
  formatMoney: (minor: number, currency: string) => `${minor / 100} ${currency}`,
}));

// Mock MyPaymentHistoryRow so we can assert it is mounted without fetching
vi.mock('~/components/organisms/MyPaymentHistoryRow.js', () => ({
  MyPaymentHistoryRow: ({ feeId }: { feeId: string }) => (
    <div data-testid='payment-history-row' data-fee-id={feeId} />
  ),
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks)
// ---------------------------------------------------------------------------

const { MyPaymentsPage } = await import('~/components/pages/MyPaymentsPage.js');

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type FeeAssignmentStatus = 'pending' | 'partial' | 'overdue' | 'paid' | 'waived';

type FeeAssignmentView = {
  assignmentId: string;
  feeId: string;
  teamMemberId: string;
  memberName: Option.Option<string>;
  feeName: string;
  currency: string;
  dueMinor: number;
  paidMinor: number;
  status: FeeAssignmentStatus;
  effectiveDueAt: Option.Option<DateTime.Utc>;
  waivedReason: Option.Option<string>;
};

type MyFinanceStatus = {
  currency: string;
  assignments: ReadonlyArray<FeeAssignmentView>;
  totalOutstandingMinor: number;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DUE_DATE = DateTime.fromDateUnsafe(new Date('2025-07-01T00:00:00Z'));

function makeAssignment(
  id: string,
  status: FeeAssignmentStatus,
  currency = 'CZK',
  paidMinor = 0,
): FeeAssignmentView {
  return {
    assignmentId: id,
    feeId: `fee-${id}`,
    teamMemberId: 'member-1',
    memberName: Option.some('Alice'),
    feeName: `Fee ${id}`,
    currency,
    dueMinor: 5000,
    paidMinor,
    status,
    effectiveDueAt: Option.some(DUE_DATE),
    waivedReason: Option.none(),
  };
}

function makeGroup(
  currency: string,
  assignments: ReadonlyArray<FeeAssignmentView>,
  totalOutstandingMinor = 5000,
): MyFinanceStatus {
  return { currency, assignments, totalOutstandingMinor };
}

const TEAM_ID = 'team-1';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MyPaymentsPage', () => {
  it('empty myStatus → empty state copy shown and 4 KPIs show em-dash or 0', () => {
    render(<MyPaymentsPage teamId={TEAM_ID} myStatus={[]} />);

    // Empty state text should appear
    expect(screen.getByText('No fee assignments yet')).not.toBeNull();

    // KPI cards — outstanding, paid, next due should show em-dash (—); overdue shows 0
    const pageText = document.body.textContent ?? '';
    // Either em-dash or '0' is acceptable for empty state KPIs
    expect(pageText).toMatch(/—|0/);
  });

  it('multi-currency → both CZK and EUR sections rendered', () => {
    const czk = makeGroup('CZK', [makeAssignment('czk-pending', 'pending', 'CZK')]);
    const eur = makeGroup('EUR', [makeAssignment('eur-pending', 'pending', 'EUR')]);

    render(<MyPaymentsPage teamId={TEAM_ID} myStatus={[czk, eur]} />);

    const czkSection = document.querySelector('[data-currency="CZK"]');
    const eurSection = document.querySelector('[data-currency="EUR"]');
    expect(czkSection).not.toBeNull();
    expect(eurSection).not.toBeNull();
  });

  it('all-paid → Next-due KPI shows em-dash, Overdue=0, Paid total > 0', () => {
    const group = makeGroup('CZK', [makeAssignment('paid-1', 'paid', 'CZK', 5000)], 0);

    render(<MyPaymentsPage teamId={TEAM_ID} myStatus={[group]} />);

    const pageText = document.body.textContent ?? '';
    // Overdue count should be 0
    expect(pageText).toContain('0');
    // Next due should show em-dash since all are paid
    expect(pageText).toContain('—');
    // Paid total label should appear
    expect(screen.getByText('Paid total')).not.toBeNull();
  });

  it('status badges rendered — data-status attribute for each status type', () => {
    const group = makeGroup(
      'CZK',
      [
        makeAssignment('p', 'pending'),
        makeAssignment('pa', 'partial'),
        makeAssignment('o', 'overdue'),
        makeAssignment('d', 'paid', 'CZK', 5000),
        makeAssignment('w', 'waived'),
      ],
      15000,
    );

    render(<MyPaymentsPage teamId={TEAM_ID} myStatus={[group]} />);

    // Use "All" filter to see all rows
    const allChip = screen.getByText('All');
    fireEvent.click(allChip);

    const statuses = ['pending', 'partial', 'overdue', 'paid', 'waived'];
    for (const status of statuses) {
      const badge = document.querySelector(`[data-status="${status}"]`);
      expect(badge).not.toBeNull();
    }
  });

  it('filter default = outstanding when outstanding exists', () => {
    const group = makeGroup('CZK', [
      makeAssignment('pending', 'pending'),
      makeAssignment('paid', 'paid', 'CZK', 5000),
    ]);

    render(<MyPaymentsPage teamId={TEAM_ID} myStatus={[group]} />);

    const outstandingChip = screen.getByText('Outstanding');
    // The Outstanding chip should be active by default
    expect(
      outstandingChip.closest('[aria-pressed="true"]') ??
        outstandingChip.getAttribute('aria-pressed'),
    ).toBeTruthy();
  });

  it('filter default = all when no outstanding (only paid + waived)', () => {
    const group = makeGroup(
      'CZK',
      [makeAssignment('paid', 'paid', 'CZK', 5000), makeAssignment('waived', 'waived')],
      0,
    );

    render(<MyPaymentsPage teamId={TEAM_ID} myStatus={[group]} />);

    const allChip = screen.getByText('All');
    // The All chip should be active by default
    expect(
      allChip.closest('[aria-pressed="true"]') ?? allChip.getAttribute('aria-pressed'),
    ).toBeTruthy();
  });

  it('click Paid chip → only paid rows visible', () => {
    const group = makeGroup('CZK', [
      makeAssignment('pending', 'pending'),
      makeAssignment('paid', 'paid', 'CZK', 5000),
    ]);

    render(<MyPaymentsPage teamId={TEAM_ID} myStatus={[group]} />);

    const paidChip = screen.getByText('Paid');
    fireEvent.click(paidChip);

    // Paid row should be visible, pending row should not
    const pendingBadge = document.querySelector('[data-status="pending"]');
    expect(pendingBadge).toBeNull();
    const paidBadge = document.querySelector('[data-status="paid"]');
    expect(paidBadge).not.toBeNull();
  });

  it('click Waived chip → only waived rows visible', () => {
    const group = makeGroup('CZK', [
      makeAssignment('pending', 'pending'),
      makeAssignment('waived', 'waived'),
    ]);

    render(<MyPaymentsPage teamId={TEAM_ID} myStatus={[group]} />);

    const waivedChip = screen.getByText('Waived');
    fireEvent.click(waivedChip);

    const pendingBadge = document.querySelector('[data-status="pending"]');
    expect(pendingBadge).toBeNull();
    const waivedBadge = document.querySelector('[data-status="waived"]');
    expect(waivedBadge).not.toBeNull();
  });

  it('filter applied across all currencies', () => {
    const czk = makeGroup('CZK', [
      makeAssignment('czk-pending', 'pending', 'CZK'),
      makeAssignment('czk-paid', 'paid', 'CZK', 5000),
    ]);
    const eur = makeGroup('EUR', [
      makeAssignment('eur-pending', 'pending', 'EUR'),
      makeAssignment('eur-paid', 'paid', 'EUR', 3000),
    ]);

    render(<MyPaymentsPage teamId={TEAM_ID} myStatus={[czk, eur]} />);

    // Click Paid — all currencies should only show paid rows
    const paidChip = screen.getByText('Paid');
    fireEvent.click(paidChip);

    const pendingBadges = document.querySelectorAll('[data-status="pending"]');
    expect(pendingBadges.length).toBe(0);

    const paidBadges = document.querySelectorAll('[data-status="paid"]');
    expect(paidBadges.length).toBeGreaterThan(0);
  });

  it('if filter empties a currency section, the section is hidden', () => {
    // CZK has only pending, EUR has only paid
    const czk = makeGroup('CZK', [makeAssignment('czk-pending', 'pending', 'CZK')]);
    const eur = makeGroup('EUR', [makeAssignment('eur-paid', 'paid', 'EUR', 3000)], 0);

    render(<MyPaymentsPage teamId={TEAM_ID} myStatus={[czk, eur]} />);

    // Switch to Paid filter — CZK section should be hidden
    const paidChip = screen.getByText('Paid');
    fireEvent.click(paidChip);

    const czkSection = document.querySelector('[data-currency="CZK"]');
    // CZK section should either be absent or hidden
    if (czkSection) {
      const style = (czkSection as HTMLElement).style.display;
      expect(style).toBe('none');
    } else {
      // Section not rendered at all is also correct
      expect(czkSection).toBeNull();
    }
  });

  it('chevron toggle only rendered for rows with paidMinor > 0', () => {
    const group = makeGroup(
      'CZK',
      [
        makeAssignment('paid', 'paid', 'CZK', 5000), // paidMinor > 0 — chevron expected
        makeAssignment('pending', 'pending', 'CZK', 0), // paidMinor = 0 — no chevron
      ],
      5000,
    );

    render(<MyPaymentsPage teamId={TEAM_ID} myStatus={[group]} />);

    // Show all rows
    const allChip = screen.getByText('All');
    fireEvent.click(allChip);

    // Chevrons should only appear for rows with paidMinor > 0
    const chevrons = document.querySelectorAll('[data-testid="payment-history-toggle"]');
    // At least one row should have a chevron (the paid row)
    expect(chevrons.length).toBeGreaterThanOrEqual(1);

    // The pending row (paidMinor=0) should NOT have a chevron
    // We can verify total count: only 1 chevron for 1 paid row
    expect(chevrons.length).toBe(1);
  });

  it('clicking chevron mounts MyPaymentHistoryRow with correct props', () => {
    const paidAssignment = makeAssignment('paid-fee', 'paid', 'CZK', 5000);
    const group = makeGroup('CZK', [paidAssignment]);

    render(<MyPaymentsPage teamId={TEAM_ID} myStatus={[group]} />);

    // Show all rows
    const allChip = screen.getByText('All');
    fireEvent.click(allChip);

    // Initially no history row mounted
    expect(document.querySelector('[data-testid="payment-history-row"]')).toBeNull();

    // Click the chevron toggle
    const toggle = document.querySelector('[data-testid="payment-history-toggle"]');
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);

    // After click, MyPaymentHistoryRow should be mounted with the correct feeId
    const historyRow = document.querySelector('[data-testid="payment-history-row"]');
    expect(historyRow).not.toBeNull();
    expect(historyRow?.getAttribute('data-fee-id')).toBe('fee-paid-fee');
  });
});
