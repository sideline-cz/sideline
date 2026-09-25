// The bank tab is the entry point for turning an outgoing movement into a real ledger row, so
// the wiring around that button is worth pinning: who sees it, what it does with a currency the
// expense form cannot represent, and what an already-expensed movement shows instead.

import { BankSyncApi } from '@sideline/domain';
import { render, screen } from '@testing-library/react';
import { Schema } from 'effect';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MatchedList } from '~/components/organisms/bank/MatchedList';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isLoading: false }),
}));

// Assert on keys, not on copy — the copy is reviewed in the catalogue, not here.
vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => key,
  setTranslationOverrides: vi.fn(),
}));

const TEAM_ID = '00000000-0000-0000-0001-000000000010';

const tx = (overrides: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(BankSyncApi.BankTransactionView)({
    id: '11111111-1111-4111-8111-111111111111',
    bookedOn: '2025-06-03',
    amountMinor: -250000,
    currency: 'CZK',
    direction: 'outgoing',
    counterpartyName: 'Pitch Owner s.r.o.',
    counterpartyAccount: null,
    variableSymbol: null,
    messageForRecipient: 'June rent',
    matchState: 'not_applicable',
    matchReason: null,
    resolutionKind: null,
    duplicateOfTransactionId: null,
    matchedMemberName: null,
    expenseId: null,
    ingestedAt: '2025-06-03T08:00:00.000Z',
    ...overrides,
  });

const renderList = (
  transactions: ReadonlyArray<BankSyncApi.BankTransactionView>,
  canManageExpenses = true,
) =>
  render(
    <MatchedList
      teamId={TEAM_ID}
      transactions={transactions}
      canManageExpenses={canManageExpenses}
      onChanged={vi.fn()}
    />,
  );

describe('MatchedList — expenses from outgoing movements', () => {
  it('offers "Create expense" on an un-expensed outgoing movement', () => {
    renderList([tx()]);
    expect(screen.queryByText('bank_expense_create')).not.toBeNull();
  });

  it('shows a link to the expense instead once the movement has one', () => {
    renderList([tx({ expenseId: '22222222-2222-4222-8222-222222222222' })]);
    expect(screen.queryByText('bank_expense_view')).not.toBeNull();
    expect(screen.queryByText('bank_expense_create')).toBeNull();
  });

  it('hides the action from a role without finance:manage_fees', () => {
    // The bank tab itself is gated on finance:record_payments, which does not imply manage_fees.
    renderList([tx()], false);
    expect(screen.queryByText('bank_expense_create')).toBeNull();
  });

  it('refuses a currency the expense form cannot represent, rather than defaulting to CZK', () => {
    renderList([tx({ currency: 'PLN' })]);
    expect(screen.queryByText('bank_expense_create')).toBeNull();
    expect(screen.queryByText('bank_expense_unsupportedCurrency')).not.toBeNull();
  });

  it('labels an outgoing movement "Výdaj" rather than the old em dash', () => {
    renderList([tx()]);
    expect(screen.queryByText('bank_status_expense')).not.toBeNull();
  });

  it('leaves incoming rows untouched — no action, no expense label', () => {
    const incoming = tx({
      direction: 'incoming',
      amountMinor: 40000,
      matchState: 'matched',
      matchedMemberName: 'Jana Nováková',
    });
    renderList([incoming]);
    expect(screen.queryByText('bank_expense_create')).toBeNull();
    expect(screen.queryByText('bank_status_expense')).toBeNull();
    expect(screen.queryByText('Jana Nováková')).not.toBeNull();
  });
});
