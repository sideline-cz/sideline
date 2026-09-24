import { Schema } from 'effect';

export const MemberCreditDepositId = Schema.String.pipe(Schema.brand('MemberCreditDepositId'));
export type MemberCreditDepositId = typeof MemberCreditDepositId.Type;

// Who wrote the deposit. 'manual' is a treasurer recording it through the settle endpoint;
// 'auto' is BankTransactionMatcher turning the remainder of an incoming transfer into credit,
// and only an 'auto' row carries a bank_transaction_id (paired CHECK in 1792800001).
export const MemberCreditSource = Schema.Literals(['auto', 'manual']);
export type MemberCreditSource = typeof MemberCreditSource.Type;
