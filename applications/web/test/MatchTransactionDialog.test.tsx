// A family transfer arrives under ONE variable symbol but pays fees for several children. The
// server has always accepted that — `performManualMatch` validates team ownership, never member,
// and locks on `match_state IN ('unmatched','partially_matched')` — but this dialog refused it
// twice over: split rows resolved their label through whichever member's `candidates` were
// loaded (so switching the picker blanked them), and the submit guard demanded the allocation
// total equal the transaction exactly. Production hit this with a 4 500 Kč transfer covering
// three siblings; the treasurer had no way to enter it.

import { BankSyncApi } from '@sideline/domain';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Effect, Option, Schema } from 'effect';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => key,
  setTranslationOverrides: vi.fn(),
}));

// A native select keeps the member override driveable with fireEvent.change; the real one is a
// combobox whose internals are not what this test is about.
vi.mock('~/components/atoms/SearchableSelect', () => ({
  SearchableSelect: ({
    id,
    options,
    value,
    onValueChange,
  }: {
    id: string;
    options: ReadonlyArray<{ value: string; label: string }>;
    value: string;
    onValueChange: (v: string) => void;
  }) => (
    <select
      data-testid={id}
      value={value}
      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onValueChange(e.target.value)}
    >
      <option value=''>--</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

const TEAM_ID = '11111111-1111-4111-8111-111111111111';
const TX_ID = '22222222-2222-4222-8222-222222222222';
const BARCA_ID = '33333333-3333-4333-8333-333333333333';
const FANTA_ID = '44444444-4444-4444-8444-444444444444';
const FEE_ID = '55555555-5555-4555-8555-555555555555';

const A_BARCA_TRAINING = '66666666-6666-4666-8666-666666666666';
const A_FANTA_TRAINING = '77777777-7777-4777-8777-777777777777';
const A_FANTA_TOURNAMENT = '88888888-8888-4888-8888-888888888888';

const candidate = (assignmentId: string, feeName: string, outstandingMinor: number) => ({
  assignmentId,
  feeId: FEE_ID,
  feeName,
  currency: 'CZK',
  outstandingMinor,
  effectiveDueAt: null,
});

// 4 500,00 Kč — more than any single child's outstanding fee.
const TX_AMOUNT_MINOR = 450000;

const detail = Schema.decodeUnknownSync(BankSyncApi.BankTransactionDetailView)({
  id: TX_ID,
  bookedOn: '2026-10-08',
  amountMinor: TX_AMOUNT_MINOR,
  currency: 'CZK',
  direction: 'incoming',
  counterpartyName: 'Mgr. ŠIMON POKORNÝ',
  counterpartyAccount: null,
  counterpartyBankCode: null,
  counterpartyBankName: null,
  counterpartyBic: null,
  variableSymbol: '2026084',
  constantSymbol: null,
  specificSymbol: null,
  messageForRecipient: 'KAZDY TRENINK 2026-10-07 Pokorní',
  userIdentification: null,
  comment: null,
  matchState: 'unmatched',
  matchReason: null,
  resolutionKind: null,
  ignoredReason: null,
  duplicateOfTransactionId: null,
  suggestedMemberNames: [],
  resolvedMemberId: BARCA_ID,
  resolvedMemberName: 'Barča',
  candidateAssignments: [candidate(A_BARCA_TRAINING, 'Training', 115000)],
  matchedPayments: [],
  expenseId: null,
  ingestedAt: '2026-10-08T06:00:00.000Z',
  updatedAt: '2026-10-08T06:00:00.000Z',
});

// Must be a stable identity: the dialog's loader effect lists `run` in its deps, so a new
// closure per render would re-fetch forever and `detail` would never settle.
const mockRun = () => (effect: Effect.Effect<unknown, unknown>) =>
  Effect.runPromise(Effect.option(effect));

type Allocation = { readonly assignmentId: string; readonly amountMinor: number };

// Captured from the call rather than read off `mock.calls`, which is untyped for a zero-arg
// `vi.fn`. Initialised to [] (never undefined) so TS keeps the array type.
let submitted: ReadonlyArray<Allocation> = [];
const matchBankTransaction = vi.fn(
  (req: { readonly payload: { readonly allocations: ReadonlyArray<Allocation> } }) => {
    submitted = req.payload.allocations;
    return Effect.succeed(detail);
  },
);

const listMemberAssignments = vi.fn(() =>
  Effect.succeed([
    {
      assignmentId: A_FANTA_TRAINING,
      feeId: FEE_ID,
      feeName: 'Training',
      currency: 'CZK',
      dueMinor: 150000,
      paidMinor: 0,
      status: 'pending',
      effectiveDueAt: Option.none(),
    },
    {
      assignmentId: A_FANTA_TOURNAMENT,
      feeId: FEE_ID,
      feeName: 'Tournament',
      currency: 'CZK',
      dueMinor: 35000,
      paidMinor: 0,
      status: 'pending',
      effectiveDueAt: Option.none(),
    },
  ]),
);

vi.mock('~/lib/runtime', () => ({
  ApiClient: {
    asEffect: () =>
      Effect.succeed({
        bankSync: {
          getBankTransaction: () => Effect.succeed(detail),
          matchBankTransaction,
        },
        roster: {
          listMembers: () =>
            Effect.succeed([
              {
                memberId: BARCA_ID,
                displayName: 'Barča',
                variableSymbol: Option.some('2026084'),
                active: true,
              },
              {
                memberId: FANTA_ID,
                displayName: 'Fanta',
                variableSymbol: Option.some('2026105'),
                active: true,
              },
            ]),
        },
        finance: { listMemberAssignments },
      }),
  },
  ClientError: { make: (message: string) => ({ _tag: 'ClientError', message }) },
  SilentClientError: class SilentClientError {
    readonly _tag = 'SilentClientError';
    props: { message: string };
    constructor(props: { message: string }) {
      this.props = props;
    }
  },
  useRun: () => mockRun,
}));

const { MatchTransactionDialog } = await import('~/components/organisms/MatchTransactionDialog.js');

const amountInputs = () =>
  screen.getAllByRole('textbox').filter((el) => el.getAttribute('inputmode') === 'decimal');

// The mode radios sit inside their <label>; clicking the label's text node does not toggle them
// in jsdom, so reach the input itself.
const chooseMode = (labelText: string) => {
  const input = screen.getByText(labelText).querySelector('input[type="radio"]');
  if (input === null) throw new Error(`no radio inside ${labelText}`);
  fireEvent.click(input);
};

describe('MatchTransactionDialog — one transfer, several members', () => {
  it('keeps rows across a member switch and submits a cross-member allocation under the total', async () => {
    render(
      <MatchTransactionDialog
        teamId={TEAM_ID}
        txId={TX_ID}
        onCancel={vi.fn()}
        onResolved={vi.fn()}
      />,
    );

    await screen.findByText('bank_resolve_modeSplit');
    chooseMode('bank_resolve_modeSplit');

    // Barča's row, from the VS-resolved candidates.
    fireEvent.click(screen.getByText('bank_resolve_splitAdd'));
    await screen.findByText('Barča · Training');
    fireEvent.change(amountInputs()[0], { target: { value: '1150' } });

    // Switching the picker used to wipe splitRows — Barča's row must survive it.
    fireEvent.change(screen.getByTestId('resolve-member'), { target: { value: FANTA_ID } });
    await waitFor(() => expect(listMemberAssignments).toHaveBeenCalled());
    expect(screen.getByText('Barča · Training')).toBeTruthy();

    fireEvent.click(screen.getByText('bank_resolve_splitAdd'));
    await screen.findByText('Fanta · 2026105 · Training');
    fireEvent.click(screen.getByText('bank_resolve_splitAdd'));
    await screen.findByText('Fanta · 2026105 · Tournament');

    const inputs = amountInputs();
    fireEvent.change(inputs[1], { target: { value: '1500' } });
    fireEvent.change(inputs[2], { target: { value: '350' } });

    fireEvent.click(screen.getByText('bank_resolve_submit'));

    await waitFor(() => expect(matchBankTransaction).toHaveBeenCalledTimes(1));

    expect(submitted).toEqual([
      { assignmentId: A_BARCA_TRAINING, amountMinor: 115000 },
      { assignmentId: A_FANTA_TRAINING, amountMinor: 150000 },
      { assignmentId: A_FANTA_TOURNAMENT, amountMinor: 35000 },
    ]);

    // 3 000,00 of 4 500,00 — deliberately short. The rest stays on the transaction for the
    // third sibling, which is the whole point of dropping the equality guard.
    const total = submitted.reduce((s: number, a: { amountMinor: number }) => s + a.amountMinor, 0);
    expect(total).toBeLessThan(TX_AMOUNT_MINOR);
  });

  it('still refuses an allocation that exceeds the transaction', async () => {
    matchBankTransaction.mockClear();
    submitted = [];
    render(
      <MatchTransactionDialog
        teamId={TEAM_ID}
        txId={TX_ID}
        onCancel={vi.fn()}
        onResolved={vi.fn()}
      />,
    );

    await screen.findByText('bank_resolve_modeSplit');
    chooseMode('bank_resolve_modeSplit');
    fireEvent.click(screen.getByText('bank_resolve_splitAdd'));
    await screen.findByText('Barča · Training');

    fireEvent.change(amountInputs()[0], { target: { value: '5000' } });
    fireEvent.click(screen.getByText('bank_resolve_submit'));

    const shown = await screen.findAllByText('bank_resolve_splitOver');
    expect(shown.length).toBeGreaterThan(0);
    expect(matchBankTransaction).not.toHaveBeenCalled();
  });
});
