import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DateTime, Effect, Option } from 'effect';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      finance_credit_popover_title: 'Credit — {member} · {currency}',
      finance_credit_popover_balance: 'Balance',
      finance_credit_popover_empty: 'No credit has been added yet.',
      finance_credit_void_title: 'Cancel credit',
      finance_credit_void_reason: 'Reason',
      finance_credit_void_action: 'Cancel credit',
      finance_credit_void_spent:
        'This credit has already been used to pay fees. Cancel those payments first.',
      finance_credit_void_success: 'Credit cancelled.',
      finance_credit_rowBadge: 'Credit {amount}',
      finance_error_loadFailed: "Couldn't load finance data. Try again.",
      loading_text: 'Loading...',
      my_payments_history_voided: 'Voided',
      payment_record_cancel: 'Cancel',
      waive_dialog_validation_reasonRequired: 'Reason is required',
      finance_payment_method_cash: 'Cash',
      finance_payment_method_bank_transfer: 'Bank transfer',
      finance_payment_method_unknown: 'Other',
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
// Runtime mock — threads the REAL Effect pipeline through `Effect.option` so
// `Effect.tapError`/`Effect.mapError` inside the component actually run (unlike a bare
// spy-substitution mock, which would bypass them and make the CreditDepositSpent inline
// test unable to observe anything).
// ---------------------------------------------------------------------------

const listDepositsImpl = vi.fn();
const voidDepositImpl = vi.fn();

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

class MockSilentClientError {
  readonly _tag = 'SilentClientError';
  readonly message: string;
  constructor(props: { message: string }) {
    this.message = props.message;
  }
}

vi.mock('~/lib/runtime', async () => {
  const { Effect: RealEffect } = await import('effect');
  return {
    ApiClient: {
      asEffect: () =>
        RealEffect.succeed({
          finance: {
            listMemberCreditDeposits: (args: unknown) => listDepositsImpl(args),
            voidCreditDeposit: (args: unknown) => voidDepositImpl(args),
          },
        }),
    },
    ClientError: MockClientError,
    SilentClientError: MockSilentClientError,
    useRun: () => () => (effect: Effect.Effect<unknown, unknown, never>) =>
      Effect.runPromise(Effect.option(effect)),
  };
});

const { MemberCreditPopover } = await import('~/components/organisms/MemberCreditPopover.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function deposit(
  id: string,
  overrides: Partial<{
    amountMinor: number;
    method: 'cash' | 'bank_transfer';
    paidAtIso: string;
    voided: boolean;
  }> = {},
) {
  const paidAt = DateTime.fromDateUnsafe(new Date(overrides.paidAtIso ?? '2026-03-12T00:00:00Z'));
  return {
    depositId: id,
    teamMemberId: 'member-1',
    currency: 'CZK',
    amountMinor: overrides.amountMinor ?? 200000,
    method: overrides.method ?? 'cash',
    paidAt,
    note: Option.none(),
    recorderName: Option.some('Jan Bílý'),
    voidedAt: overrides.voided ? Option.some(paidAt) : Option.none(),
    voidReason: overrides.voided ? Option.some('typo') : Option.none(),
  };
}

function withQueryClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function renderPopover(overrides: Record<string, unknown> = {}) {
  return withQueryClient(
    <MemberCreditPopover
      teamId='11111111-1111-4111-8111-111111111111'
      teamMemberId='22222222-2222-4222-8222-222222222222'
      memberName='Jan Novák'
      currency='CZK'
      balanceMinor={300000}
      canRecordPayments={true}
      onVoided={vi.fn()}
      {...overrides}
    />,
  );
}

async function openPopover() {
  fireEvent.click(screen.getByText('Credit 3000 CZK'));
  await waitFor(() => expect(screen.getByText('Balance')).not.toBeNull());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemberCreditPopover', () => {
  it('lists deposits newest first, voided rows muted and without a Cancel button', async () => {
    listDepositsImpl.mockReturnValueOnce(
      Effect.succeed([
        deposit('d-old', { paidAtIso: '2026-01-01T00:00:00Z', amountMinor: 10000 }),
        deposit('d-new', { paidAtIso: '2026-03-01T00:00:00Z', amountMinor: 20000 }),
        deposit('d-voided', { paidAtIso: '2026-02-01T00:00:00Z', amountMinor: 5000, voided: true }),
      ]),
    );

    renderPopover();
    await openPopover();

    await waitFor(() => {
      const rows = document.querySelectorAll('li');
      expect(rows.length).toBe(3);
      // newest first
      expect(rows[0].getAttribute('data-voided')).toBe('false');
      expect(rows[0].textContent).toContain('200 CZK');
    });

    const voidedRow = document.querySelector('[data-voided="true"]');
    expect(voidedRow).not.toBeNull();
    expect(voidedRow?.textContent).toContain('Voided');
    // no Cancel button on the voided row
    expect(voidedRow?.querySelector('button')).toBeNull();
  });

  it('Cancel opens the confirm dialog and calls voidCreditDeposit with the reason', async () => {
    listDepositsImpl.mockReturnValueOnce(Effect.succeed([deposit('d-1')]));
    voidDepositImpl.mockReturnValueOnce(Effect.succeed(undefined));

    renderPopover();
    await openPopover();

    await waitFor(() => expect(screen.getByText('Cancel credit')).not.toBeNull());
    fireEvent.click(screen.getByText('Cancel credit'));

    const reasonInput = await screen.findByLabelText('Reason');
    fireEvent.change(reasonInput, { target: { value: 'Typed the wrong amount' } });

    const confirmButtons = screen.getAllByText('Cancel credit');
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => {
      expect(voidDepositImpl).toHaveBeenCalledOnce();
      const args = voidDepositImpl.mock.calls[0][0] as { payload: { reason: string } };
      expect(args.payload.reason).toBe('Typed the wrong amount');
    });
  });

  it('CreditDepositSpent renders finance_credit_void_spent inline, popover stays open', async () => {
    listDepositsImpl.mockReturnValueOnce(Effect.succeed([deposit('d-1')]));
    voidDepositImpl.mockReturnValueOnce(Effect.fail({ _tag: 'CreditDepositSpent' }));

    renderPopover();
    await openPopover();

    await waitFor(() => expect(screen.getByText('Cancel credit')).not.toBeNull());
    fireEvent.click(screen.getByText('Cancel credit'));
    const reasonInput = await screen.findByLabelText('Reason');
    fireEvent.change(reasonInput, { target: { value: 'Already spent' } });
    const confirmButtons = screen.getAllByText('Cancel credit');
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => {
      expect(
        screen.getByText(
          'This credit has already been used to pay fees. Cancel those payments first.',
        ),
      ).not.toBeNull();
    });
    // Popover itself is still open — balance is still visible.
    expect(screen.getByText('Balance')).not.toBeNull();
  });
});
