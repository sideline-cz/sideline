// Adversarial review finding #1: the settle dialog froze the whole `MemberOverviewRow` — including
// `creditMinor` — in a ref at open time. `settleCandidates` was re-derived from fresh `assignments`
// after a `SettlementStale` retry's `router.invalidate()`, but `creditMinor` still came straight from
// the frozen row, so a credit balance that moved underneath an open dialog (e.g. a concurrent
// `voidCreditDeposit`) never reached the breakdown. `SettleMemberDialog.test.tsx`'s own
// "SettlementStale re-renders..." test drives the component directly with hand-picked props, so it
// cannot catch a bug in what the ROUTE passes as those props — this file renders the route component
// itself, following the `assistantRoute.test.tsx` convention (mock `createFileRoute` down to
// controllable `useParams`/`useLoaderData`/`useRouteContext`, mock `useRouter`/`useNavigate`/
// `useSearch`, and render `Route.options.component` directly).

import { act, render } from '@testing-library/react';
import { Effect } from 'effect';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    const template = key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
  },
  setTranslationOverrides: vi.fn(),
}));

vi.mock('~/lib/finance/formatMoney.js', () => ({
  formatMoney: (minor: number, currency: string) => `${minor / 100} ${currency}`,
}));

const createSettlementImpl = vi.fn();

vi.mock('~/lib/runtime', async () => {
  const { Effect: RealEffect } = await import('effect');
  class MockClientError {
    readonly _tag = 'ClientError';
    readonly message: string;
    constructor(props: { message: string }) {
      this.message = props.message;
    }
    static make(message: string) {
      return new MockClientError({ message });
    }
  }
  return {
    ApiClient: {
      asEffect: () =>
        RealEffect.succeed({
          finance: {
            createSettlement: (args: unknown) => createSettlementImpl(args),
          },
        }),
    },
    ClientError: MockClientError,
    NotFound: { make: (e: unknown) => e },
    warnAndCatchAll: (effect: Effect.Effect<unknown, unknown>) => effect,
    useRun: () => () => (effect: Effect.Effect<unknown, unknown, never>) =>
      RealEffect.runPromise(RealEffect.option(effect)),
  };
});

const { mockFinancesOverviewPage, mockSettleMemberDialog } = vi.hoisted(() => ({
  mockFinancesOverviewPage: vi.fn(),
  mockSettleMemberDialog: vi.fn(),
}));

interface FinancesOverviewPageProps {
  onSettleRow: (row: unknown) => void;
}

vi.mock('~/components/pages/FinancesOverviewPage.js', () => ({
  FinancesOverviewPage: (props: FinancesOverviewPageProps) => {
    mockFinancesOverviewPage(props);
    return null;
  },
}));

interface SettleMemberDialogProps {
  currency: string;
  creditMinor: number;
  onSubmit: (req: unknown) => void;
}

vi.mock('~/components/organisms/SettleMemberDialog.js', () => ({
  SettleMemberDialog: (props: SettleMemberDialogProps) => {
    mockSettleMemberDialog(props);
    return null;
  },
}));

vi.mock('~/components/organisms/AssignmentsTab.js', () => ({
  AssignmentsTab: () => null,
}));

const { mockUseParams, mockUseLoaderData, mockUseRouteContext, mockUseSearch, mockNavigate } =
  vi.hoisted(() => ({
    mockUseParams: vi.fn(),
    mockUseLoaderData: vi.fn(),
    mockUseRouteContext: vi.fn(),
    mockUseSearch: vi.fn(),
    mockNavigate: vi.fn(),
  }));

interface FileRouteOptions {
  readonly component: React.ComponentType;
}

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (options: FileRouteOptions) => ({
    id: 'finances-route',
    fullPath: '/teams/$teamId/finances',
    options,
    useParams: mockUseParams,
    useLoaderData: mockUseLoaderData,
    useRouteContext: mockUseRouteContext,
  }),
  useNavigate: () => mockNavigate,
  useSearch: mockUseSearch,
  useRouter: () => ({ invalidate: vi.fn() }),
  Link: (props: React.ComponentProps<'a'>) => <a {...props} />,
}));

const { Route } = await import('~/routes/(authenticated)/teams/$teamId/finances.tsx');

function assertComponent<T>(component: T | undefined): T {
  if (component === undefined) {
    throw new Error('FinancesRoute must define a component');
  }
  return component;
}

const Component = assertComponent(Route.options.component);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const teamMemberId = '22222222-2222-4222-8222-222222222222';
const feeId = '33333333-3333-4333-8333-333333333333';
const assignmentId = '44444444-4444-4444-8444-444444444444';
const teamId = '11111111-1111-4111-8111-111111111111';

function row(creditMinor: number) {
  return {
    teamMemberId,
    memberName: 'Jan Novák',
    currency: 'CZK',
    totalDueMinor: 100000,
    totalPaidMinor: 0,
    overdueCount: 0,
    pendingCount: 1,
    paidCount: 0,
    creditMinor,
  };
}

function assignment(paidMinor: number) {
  return {
    assignmentId,
    feeId,
    feeName: 'Membership',
    teamMemberId,
    memberName: { _tag: 'Some', value: 'Jan Novák' },
    currency: 'CZK',
    dueMinor: 100000,
    paidMinor,
    status: paidMinor >= 100000 ? 'paid' : 'pending',
    effectiveDueAt: { _tag: 'None' },
  };
}

function loaderData(creditMinor: number, paidMinor: number) {
  return {
    rows: [row(creditMinor)],
    fees: [],
    assignments: [assignment(paidMinor)],
    canManageFees: true,
    canRecordPayments: true,
    teamId,
    balanceSummaries: undefined,
  };
}

function lastSettleDialogProps(): SettleMemberDialogProps {
  const call = mockSettleMemberDialog.mock.calls.at(-1);
  const props = call?.[0];
  if (!props) throw new Error('SettleMemberDialog never rendered');
  return props;
}

function lastOverviewProps(): FinancesOverviewPageProps {
  const call = mockFinancesOverviewPage.mock.calls.at(-1);
  const props = call?.[0];
  if (!props) throw new Error('FinancesOverviewPage never rendered');
  return props;
}

beforeEach(() => {
  mockUseParams.mockReturnValue({ teamId });
  mockUseRouteContext.mockReturnValue({ user: { id: 'user-1' } });
  mockUseSearch.mockReturnValue({});
  mockNavigate.mockReset();
  mockFinancesOverviewPage.mockReset();
  mockSettleMemberDialog.mockReset();
  createSettlementImpl.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('FinancesRoute — settle dialog credit freshness (adversarial review #1)', () => {
  it('re-derives creditMinor from the current rows after a SettlementStale retry, not the row frozen at open time', async () => {
    // Open: credit 600 in the loader data at mount time.
    mockUseLoaderData.mockReturnValue(loaderData(600, 0));
    const { rerender } = render(<Component />);

    act(() => {
      lastOverviewProps().onSettleRow(row(600));
    });
    expect(lastSettleDialogProps().creditMinor).toBe(600);

    // Submit → server says stale (409). The route's handler calls router.invalidate() and keeps
    // the dialog open.
    createSettlementImpl.mockReturnValue(Effect.fail({ _tag: 'SettlementStale' }));
    await act(async () => {
      lastSettleDialogProps().onSubmit({
        currency: 'CZK',
        amountMinor: 40000,
        method: 'cash',
        paidAt: new Date(),
        note: { _tag: 'None' },
        expectedOutstandingMinor: 100000,
        expectedCreditMinor: 600,
      });
    });

    // Fresh loader data lands (a concurrent voidCreditDeposit dropped the credit to 0; the fee
    // itself is untouched). Simulates what `router.invalidate()` would feed back through
    // `Route.useLoaderData()`.
    mockUseLoaderData.mockReturnValue(loaderData(0, 0));
    rerender(<Component />);

    // The dialog must see the FRESH credit (0), never the value frozen when it was opened (600) —
    // otherwise `isCoveredByCredit` is computed against stale data and the amount field can vanish
    // even though nothing was actually applied to this member's credit.
    expect(lastSettleDialogProps().creditMinor).toBe(0);
  });

  it('never hands SettleMemberDialog an empty currency — it is always-mounted and computes formatMoney on every render', () => {
    // Caught live in e2e: before any row is ever selected, the dialog's own `Intl.NumberFormat`
    // calls (submitLabel/consequence) run unconditionally on mount because the dialog is
    // always-mounted (AGENTS.md), not gated behind `open`. `''` is not a valid ISO currency code
    // and crashes the whole route with `RangeError: Invalid currency code`.
    mockUseLoaderData.mockReturnValue(loaderData(0, 0));
    render(<Component />);

    expect(lastSettleDialogProps().currency).not.toBe('');
  });
});
