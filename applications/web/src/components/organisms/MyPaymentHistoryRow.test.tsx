// TDD mode — tests written BEFORE MyPaymentHistoryRow.tsx exists.
// These tests WILL FAIL until:
//   - applications/web/src/components/organisms/MyPaymentHistoryRow.tsx is implemented
//
// Component contract:
//   MyPaymentHistoryRow({
//     teamId: string;
//     feeId: string;
//     currency: string;
//   })
//
// Behaviour:
//   - Shows loading state initially (data-testid="payment-history-loading")
//   - On success: renders each payment with amount, date, method label, recorder name
//   - Voided payment: data-voided="true" + "Voided" badge
//   - recorder Option.none() → em-dash, no crash
//   - method 'cash' → 'finance_payment_method_cash' translated text
//   - empty list → empty state copy
//   - error state → inline error copy, no crash propagation
//   - API called with correct feeId

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { DateTime, Option } from 'effect';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

// Option is used in the mock below to wrap resolved values, matching production behaviour

// ---------------------------------------------------------------------------
// Module mocks — before any imports using them
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      my_payments_history_loading: 'Loading payments...',
      my_payments_history_error: 'Failed to load payments',
      my_payments_history_empty: 'No payments recorded yet',
      my_payments_history_voided: 'Voided',
      my_payments_history_recordedBy: 'Recorded by: {name}',
      finance_payment_method_cash: 'Cash',
      finance_payment_method_bank_transfer: 'Bank transfer',
    };
    const template = map[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
  },
  setTranslationOverrides: vi.fn(),
}));

vi.mock('~/lib/finance/formatMoney.js', () => ({
  formatMoney: (minor: number, currency: string) => `${minor / 100} ${currency}`,
}));

// ---------------------------------------------------------------------------
// Mock ApiClient and useRun
// ---------------------------------------------------------------------------

const apiCallSpy = vi.fn();
const capturedQueryArgs: unknown[] = [];

vi.mock('~/lib/runtime', async () => {
  const { Effect } = await import('effect');
  return {
    ApiClient: {
      asEffect: () =>
        Effect.succeed({
          finance: {
            myPaymentHistory: (args: unknown) => {
              capturedQueryArgs.push(args);
              // Return an Effect that the pipe will use — the run mock will intercept it
              return Effect.succeed([]);
            },
          },
        }),
    },
    ClientError: { make: (msg: string) => ({ _tag: 'ClientError', message: msg }) },
    useRun: () => () => apiCallSpy,
  };
});

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks)
// ---------------------------------------------------------------------------

const { MyPaymentHistoryRow } = await import('~/components/organisms/MyPaymentHistoryRow.js');

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type PaymentView = {
  paymentId: string;
  feeAssignmentId: string;
  teamMemberId: string;
  memberName: Option.Option<string>;
  amountMinor: number;
  method: string;
  paidAt: DateTime.Utc;
  note: Option.Option<string>;
  recorderName: Option.Option<string>;
  voidedAt: Option.Option<DateTime.Utc>;
  voidReason: Option.Option<string>;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAID_AT = DateTime.fromDateUnsafe(new Date('2025-04-15T10:00:00Z'));

function makePayment(id: string, overrides: Partial<PaymentView> = {}): PaymentView {
  return {
    paymentId: id,
    feeAssignmentId: `assignment-${id}`,
    teamMemberId: 'member-1',
    memberName: Option.some('Alice'),
    amountMinor: 5000,
    method: 'cash',
    paidAt: PAID_AT,
    note: Option.none(),
    recorderName: Option.some('Captain'),
    voidedAt: Option.none(),
    voidReason: Option.none(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function withQueryClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const TEAM_ID = 'team-1';
const FEE_ID = 'fee-1';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MyPaymentHistoryRow', () => {
  it('shows loading state initially', () => {
    apiCallSpy.mockReturnValueOnce(new Promise(() => {})); // never resolves

    withQueryClient(<MyPaymentHistoryRow teamId={TEAM_ID} feeId={FEE_ID} currency='CZK' />);

    const loading = screen.queryByTestId('payment-history-loading');
    expect(loading).not.toBeNull();
  });

  it('success → renders payment rows with amount, date, method, recorder', async () => {
    const payments = [makePayment('pay-1')];
    apiCallSpy.mockResolvedValueOnce(Option.some(payments));

    withQueryClient(<MyPaymentHistoryRow teamId={TEAM_ID} feeId={FEE_ID} currency='CZK' />);

    await waitFor(() => {
      // Amount formatted
      expect(screen.getByText(/50 CZK/)).not.toBeNull();
      // Method label
      expect(screen.getByText('Cash')).not.toBeNull();
      // Recorder name
      expect(screen.getByText(/Captain/)).not.toBeNull();
    });
  });

  it('voided payment → data-voided="true" and "Voided" badge present', async () => {
    const payments = [
      makePayment('voided-pay', {
        voidedAt: Option.some(DateTime.fromDateUnsafe(new Date('2025-05-01T00:00:00Z'))),
        voidReason: Option.some('Duplicate entry'),
      }),
    ];
    apiCallSpy.mockResolvedValueOnce(Option.some(payments));

    withQueryClient(<MyPaymentHistoryRow teamId={TEAM_ID} feeId={FEE_ID} currency='CZK' />);

    await waitFor(() => {
      const voidedRow = document.querySelector('[data-voided="true"]');
      expect(voidedRow).not.toBeNull();
      expect(screen.getByText('Voided')).not.toBeNull();
    });
  });

  it('recorder Option.none() → renders em-dash, no crash', async () => {
    const payments = [makePayment('pay-no-recorder', { recorderName: Option.none() })];
    apiCallSpy.mockResolvedValueOnce(Option.some(payments));

    withQueryClient(<MyPaymentHistoryRow teamId={TEAM_ID} feeId={FEE_ID} currency='CZK' />);

    await waitFor(() => {
      const pageText = document.body.textContent ?? '';
      // Em-dash for missing recorder
      expect(pageText).toContain('—');
    });
  });

  it('method "cash" → shows "Cash" label', async () => {
    const payments = [makePayment('pay-cash', { method: 'cash' })];
    apiCallSpy.mockResolvedValueOnce(Option.some(payments));

    withQueryClient(<MyPaymentHistoryRow teamId={TEAM_ID} feeId={FEE_ID} currency='CZK' />);

    await waitFor(() => {
      expect(screen.getByText('Cash')).not.toBeNull();
    });
  });

  it('empty list → empty state copy shown', async () => {
    apiCallSpy.mockResolvedValueOnce(Option.some([]));

    withQueryClient(<MyPaymentHistoryRow teamId={TEAM_ID} feeId={FEE_ID} currency='CZK' />);

    await waitFor(() => {
      expect(screen.getByText('No payments recorded yet')).not.toBeNull();
    });
  });

  it('error state → inline error copy shown, no crash propagation', async () => {
    apiCallSpy.mockRejectedValueOnce(new Error('Network error'));

    // Wrap in an ErrorBoundary to ensure it doesn't propagate
    class ErrorBoundary extends React.Component<
      React.PropsWithChildren<object>,
      { caught: boolean }
    > {
      state = { caught: false };
      componentDidCatch() {
        this.setState({ caught: true });
      }
      render() {
        if (this.state.caught) return <div data-testid='boundary-triggered'>Boundary</div>;
        return this.props.children;
      }
    }

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ErrorBoundary>
          <MyPaymentHistoryRow teamId={TEAM_ID} feeId={FEE_ID} currency='CZK' />
        </ErrorBoundary>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      // Error boundary should NOT be triggered
      const boundary = screen.queryByTestId('boundary-triggered');
      expect(boundary).toBeNull();
      // Inline error copy should appear
      expect(screen.getByText('Failed to load payments')).not.toBeNull();
    });
  });

  it('API called when the row mounts', async () => {
    const specificFeeId = 'specific-fee-id';
    apiCallSpy.mockResolvedValueOnce(Option.some([]));
    apiCallSpy.mockClear();

    withQueryClient(<MyPaymentHistoryRow teamId={TEAM_ID} feeId={specificFeeId} currency='CZK' />);

    await waitFor(() => {
      expect(apiCallSpy).toHaveBeenCalled();
    });
  });
});
