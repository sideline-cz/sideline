// TDD mode — tests written BEFORE OutstandingPaymentsBanner.tsx exists.
// These tests WILL FAIL until:
//   - applications/web/src/components/organisms/OutstandingPaymentsBanner.tsx is implemented
//
// Component contract:
//   OutstandingPaymentsBanner({
//     teamId: string;
//     groups: ReadonlyArray<MyFinanceStatus>;
//   })
//
// Behaviour:
//   - Renders null when groups is empty or all are paid/waived
//   - Amber variant when only pending/partial outstanding
//   - Red variant when any overdue
//   - Shows up to 3 outstanding rows; "+N more" when > 3
//   - CTA links to /teams/$teamId/my-payments
//   - Overdue rows precede pending rows in the list

import { render } from '@testing-library/react';
import { DateTime, Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — before any imports using them
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      my_payments_banner_titleAmber: 'You have outstanding payments',
      my_payments_banner_titleRed: 'You have overdue payments',
      my_payments_banner_cta_viewAll: 'View all',
      my_payments_banner_more: '+{n} more',
      finance_status_pending: 'Pending',
      finance_status_partial: 'Partial',
      finance_status_overdue: 'Overdue',
      finance_column_fee: 'Fee',
      finance_column_due: 'Due',
    };
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

vi.mock('~/lib/finance/formatMoney.js', () => ({
  formatMoney: (minor: number, currency: string) => `${minor / 100} ${currency}`,
}));

// Mock TanStack Link to a plain <a>
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    ...rest
  }: React.PropsWithChildren<{ to?: string; params?: Record<string, string> }>) => {
    const href = to
      ? to.replace(/\$(\w+)/g, (_: string, key: string) => params?.[key] ?? key)
      : '#';
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks)
// ---------------------------------------------------------------------------

const { OutstandingPaymentsBanner } = await import(
  '~/components/organisms/OutstandingPaymentsBanner.js'
);

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
// Fixture helpers
// ---------------------------------------------------------------------------

const DUE_DATE = DateTime.fromDateUnsafe(new Date('2025-06-01T00:00:00Z'));

function makeAssignment(
  id: string,
  status: FeeAssignmentStatus,
  currency = 'CZK',
): FeeAssignmentView {
  return {
    assignmentId: id,
    feeId: `fee-${id}`,
    teamMemberId: 'member-1',
    memberName: Option.some('Alice'),
    feeName: `Fee ${id}`,
    currency,
    dueMinor: 5000,
    paidMinor: 0,
    status,
    effectiveDueAt: Option.some(DUE_DATE),
    waivedReason: Option.none(),
  };
}

function makeGroup(
  currency: string,
  assignments: ReadonlyArray<FeeAssignmentView>,
  totalOutstandingMinor = 0,
): MyFinanceStatus {
  return { currency, assignments, totalOutstandingMinor };
}

const TEAM_ID = 'team-abc';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OutstandingPaymentsBanner', () => {
  it('empty groups → renders null (no banner)', () => {
    const { container } = render(<OutstandingPaymentsBanner teamId={TEAM_ID} groups={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('only paid/waived rows → renders null', () => {
    const group = makeGroup('CZK', [
      makeAssignment('paid', 'paid'),
      makeAssignment('waived', 'waived'),
    ]);
    const { container } = render(<OutstandingPaymentsBanner teamId={TEAM_ID} groups={[group]} />);
    expect(container.firstChild).toBeNull();
  });

  it('pending only → amber variant', () => {
    const group = makeGroup('CZK', [makeAssignment('pending', 'pending')], 5000);
    render(<OutstandingPaymentsBanner teamId={TEAM_ID} groups={[group]} />);

    const banner = document.querySelector('[data-variant="amber"]');
    expect(banner).not.toBeNull();
  });

  it('any overdue → red variant', () => {
    const group = makeGroup(
      'CZK',
      [makeAssignment('pending', 'pending'), makeAssignment('overdue', 'overdue')],
      10000,
    );
    render(<OutstandingPaymentsBanner teamId={TEAM_ID} groups={[group]} />);

    const banner = document.querySelector('[data-variant="red"]');
    expect(banner).not.toBeNull();
  });

  it('5 outstanding rows → shows 3 items + "+2 more" indicator', () => {
    const assignments = [
      makeAssignment('o1', 'overdue'),
      makeAssignment('o2', 'overdue'),
      makeAssignment('p1', 'pending'),
      makeAssignment('p2', 'pending'),
      makeAssignment('p3', 'pending'),
    ];
    const group = makeGroup('CZK', assignments, 25000);
    render(<OutstandingPaymentsBanner teamId={TEAM_ID} groups={[group]} />);

    // 3 fee rows visible
    const feeItems = document.querySelectorAll('[data-testid="banner-fee-row"]');
    expect(feeItems.length).toBe(3);

    // "+2 more" text visible (the translation key returns '+{n} more')
    const pageText = document.body.textContent ?? '';
    // The component should replace {n} with 2
    expect(pageText).toMatch(/\+2/);
  });

  it('3 outstanding rows → shows all 3, no overflow indicator', () => {
    const assignments = [
      makeAssignment('o1', 'overdue'),
      makeAssignment('p1', 'pending'),
      makeAssignment('p2', 'pending'),
    ];
    const group = makeGroup('CZK', assignments, 15000);
    render(<OutstandingPaymentsBanner teamId={TEAM_ID} groups={[group]} />);

    const feeItems = document.querySelectorAll('[data-testid="banner-fee-row"]');
    expect(feeItems.length).toBe(3);

    // No "+N more" text
    const pageText = document.body.textContent ?? '';
    expect(pageText).not.toMatch(/\+\d+ more/i);
  });

  it('CTA links to /teams/$teamId/my-payments', () => {
    const group = makeGroup('CZK', [makeAssignment('pending', 'pending')], 5000);
    render(<OutstandingPaymentsBanner teamId={TEAM_ID} groups={[group]} />);

    const link = document.querySelector(`a[href*="${TEAM_ID}"][href*="my-payments"]`);
    expect(link).not.toBeNull();
  });

  it('overdue rows precede pending rows in the rendered list', () => {
    const assignments = [
      makeAssignment('first-pending', 'pending'),
      makeAssignment('first-overdue', 'overdue'),
    ];
    const group = makeGroup('CZK', assignments, 10000);
    render(<OutstandingPaymentsBanner teamId={TEAM_ID} groups={[group]} />);

    const rows = document.querySelectorAll('[data-testid="banner-fee-row"]');
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const firstRowStatus = rows[0].getAttribute('data-status');
    expect(firstRowStatus).toBe('overdue');

    const secondRowStatus = rows[1].getAttribute('data-status');
    expect(secondRowStatus).toBe('pending');
  });
});
