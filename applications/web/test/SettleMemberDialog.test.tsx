import { fireEvent, render, screen } from '@testing-library/react';
import { DateTime, Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      finance_settle_action: 'Settle all',
      finance_settle_actionAddCredit: 'Add credit',
      finance_settle_amountReceived: 'Amount received',
      finance_settle_breakdownHeading: 'Outstanding fees',
      finance_settle_coverFromCredit: 'The credit covers everything. Nothing needs to be paid.',
      finance_settle_coversAll: 'Covers all {count} fees in full.',
      finance_settle_coversPartial: 'Covers {count} fees. {remaining} will stay open on "{fee}".',
      finance_settle_coversPartialNone: '{amount} goes to "{fee}"; {remaining} stays open.',
      finance_settle_creditApplied: 'Credit applied',
      finance_settle_creditOnly:
        "Nothing is outstanding. The whole {amount} will be added to {member}'s credit.",
      finance_settle_currencyNote:
        'All amounts are in {currency}. Fees in other currencies are settled separately.',
      finance_settle_empty: 'Nothing is outstanding in {currency}.',
      finance_settle_submit: 'Settle {amount}',
      finance_settle_submitAddCredit: 'Add {amount} to credit',
      finance_settle_submitFromCredit: 'Cover from credit',
      finance_settle_title: 'Settle everything — {member}',
      finance_settle_titleAddCredit: 'Add credit — {member}',
      finance_settle_toCredit: "{amount} more than owed — it will be added to {member}'s credit.",
      finance_settle_toPay: 'To pay',
      finance_settle_totalOutstanding: 'Outstanding total',
      finance_settle_voidHint:
        'Recorded as {count} separate payments — each one can be cancelled later.',
      finance_column_due: 'Due',
      payment_record_method: 'Payment method',
      payment_record_method_cash: 'Cash',
      payment_record_method_bank_transfer: 'Bank transfer',
      payment_record_paidAt: 'Date paid',
      payment_record_note: 'Note (optional)',
      payment_record_cancel: 'Cancel',
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

const { SettleMemberDialog } = await import('~/components/organisms/SettleMemberDialog.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function candidate(
  assignmentId: string,
  dueMinor: number,
  paidMinor = 0,
  dueAtIso: string | null = '2026-03-01T00:00:00Z',
) {
  return {
    assignmentId,
    feeId: `fee-${assignmentId}`,
    feeName: `Fee ${assignmentId}`,
    dueMinor,
    paidMinor,
    effectiveDueAt: dueAtIso
      ? Option.some(DateTime.fromDateUnsafe(new Date(dueAtIso)))
      : Option.none(),
  };
}

function renderDialog(
  overrides: Record<string, unknown> = {},
  onSubmit = vi.fn(),
  onCancel = vi.fn(),
) {
  const utils = render(
    <SettleMemberDialog
      open={true}
      memberName='Jan Novák'
      currency='CZK'
      creditMinor={0}
      assignments={[candidate('a1', 250000)]}
      submitting={false}
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { ...utils, onSubmit, onCancel };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SettleMemberDialog', () => {
  it('case A — nothing outstanding, no credit: submit disabled until amount > 0, label is Add to credit', () => {
    renderDialog({ assignments: [], creditMinor: 0 });

    expect(screen.getByText(/Nothing is outstanding in CZK/)).not.toBeNull();
    const submit = screen.getByRole('button', { name: /Add .* to credit/ });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: '20' } });
    expect(screen.getByRole('button', { name: /Add 20 CZK to credit/ })).not.toBeDisabled();
  });

  it('case C — credit partly covers: "Credit applied" line rendered, amount defaults to toPay', () => {
    renderDialog({ assignments: [candidate('a1', 250000)], creditMinor: 30000 });

    expect(screen.getByText('Credit applied')).not.toBeNull();
    const amountInput = screen.getByLabelText(/Amount received/i) as HTMLInputElement;
    // outstanding 2500, credit applied 300 → toPay 2200
    expect(amountInput.value).toBe('2200');
    expect(screen.getByRole('button', { name: 'Settle 2200 CZK' })).not.toBeNull();
  });

  it('case D — credit covers everything: amount/method/date hidden, label is Cover from credit', () => {
    renderDialog({ assignments: [candidate('a1', 250000)], creditMinor: 500000 });

    expect(screen.queryByLabelText(/Amount received/i)).toBeNull();
    expect(screen.queryByText('Payment method')).toBeNull();
    expect(
      screen.getByText('The credit covers everything. Nothing needs to be paid.'),
    ).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Cover from credit' })).not.toBeDisabled();
  });

  it('case E — overpayment: amber callout with the "to credit" copy', () => {
    renderDialog({ assignments: [candidate('a1', 250000)], creditMinor: 0 });

    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: '3000' } });

    expect(
      screen.getByText(/500 CZK more than owed — it will be added to Jan Novák's credit\./),
    ).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Settle 3000 CZK' })).not.toBeNull();
  });

  it('submits expectedOutstandingMinor equal to the rendered breakdown total', () => {
    const { onSubmit } = renderDialog({ assignments: [candidate('a1', 250000)], creditMinor: 0 });

    fireEvent.click(screen.getByRole('button', { name: /^Settle/ }));

    expect(onSubmit).toHaveBeenCalledOnce();
    const req = onSubmit.mock.calls[0][0];
    expect(req.expectedOutstandingMinor).toBe(250000);
    expect(req.amountMinor).toBe(250000);
    expect(req.currency).toBe('CZK');
  });

  it('a server error keeps the dialog open with every field intact', () => {
    const onSubmit = vi.fn();
    const { rerender } = renderDialog(
      { assignments: [candidate('a1', 250000)], creditMinor: 0 },
      onSubmit,
    );

    const amountInput = screen.getByLabelText(/Amount received/i) as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: /^Settle/ }));
    expect(onSubmit).toHaveBeenCalledOnce();

    // Parent's async call failed — `open` never changes, `submitting` flips back to false.
    // The field value must survive: local state only resets when `open` transitions to true.
    rerender(
      <SettleMemberDialog
        open={true}
        memberName='Jan Novák'
        currency='CZK'
        creditMinor={0}
        assignments={[candidate('a1', 250000)]}
        submitting={false}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    expect((screen.getByLabelText(/Amount received/i) as HTMLInputElement).value).toBe('1234');
  });

  it('SettlementStale re-renders the breakdown from fresh props and keeps the dialog open', () => {
    const { rerender } = renderDialog({
      assignments: [candidate('a1', 250000)],
      creditMinor: 0,
    });

    expect(screen.getAllByText('2500 CZK').length).toBeGreaterThan(0); // outstanding total

    // Parent reloaded — the server's fees changed under the treasurer (409 SettlementStale).
    rerender(
      <SettleMemberDialog
        open={true}
        memberName='Jan Novák'
        currency='CZK'
        creditMinor={0}
        assignments={[candidate('a1', 300000)]}
        submitting={false}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getAllByText('3000 CZK').length).toBeGreaterThan(0);
  });

  it('the method radio never offers "credit"', () => {
    renderDialog({ assignments: [candidate('a1', 250000)], creditMinor: 0 });
    fireEvent.change(screen.getByLabelText(/Amount received/i), { target: { value: '25' } });

    const radios = document.querySelectorAll('input[type="radio"][name="settle-method"]');
    const values = [...radios].map((r) => (r as HTMLInputElement).value);
    expect(values.sort()).toEqual(['bank_transfer', 'cash']);
  });

  it("the breakdown is ordered by due date, not sortAssignments' status groups", () => {
    // A past-due but PARTIALLY paid assignment (status would be 'partial') due earlier, and a
    // later-dated OVERDUE assignment. sortAssignments would put the overdue one first (status
    // group); planSettlement — and therefore this breakdown — pays by due date, so the earlier
    // one must render first.
    const earlierPartial = candidate('partial-1', 200000, 50000, '2026-01-01T00:00:00Z');
    const laterOverdue = candidate('overdue-1', 100000, 0, '2026-02-01T00:00:00Z');

    renderDialog({ assignments: [laterOverdue, earlierPartial], creditMinor: 0 });

    const feeNames = [...document.querySelectorAll('dt.truncate')].map((dt) =>
      dt.textContent?.split('Due')[0]?.trim(),
    );
    expect(feeNames).toEqual(['Fee partial-1', 'Fee overdue-1']);
  });
});
