import { Payment } from '@sideline/domain';
import { describe, expect, it, vi } from 'vitest';

const TR_MAP: Record<string, string> = {
  finance_payment_method_cash: 'Cash',
  finance_payment_method_bank_transfer: 'Bank transfer',
  finance_payment_method_credit: 'From credit',
  finance_payment_method_unknown: 'Other',
};

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => TR_MAP[key] ?? key,
}));

const { paymentMethodLabel } = await import('./paymentMethodLabels.js');

const METHODS = Payment.PaymentMethod.literals;

describe('paymentMethodLabel', () => {
  it('has exactly the three method literals from the domain union, no more, no fewer', () => {
    expect(METHODS).toHaveLength(3);
    for (const method of METHODS) {
      expect(paymentMethodLabel(method)).not.toBe('Other');
    }
  });

  it('cash → Cash, bank_transfer → Bank transfer, credit → From credit', () => {
    expect(paymentMethodLabel('cash')).toBe('Cash');
    expect(paymentMethodLabel('bank_transfer')).toBe('Bank transfer');
    expect(paymentMethodLabel('credit')).toBe('From credit');
  });

  it('an unknown method renders the neutral fallback, never a raw key', () => {
    expect(paymentMethodLabel('sepa_direct_debit')).toBe('Other');
  });
});
