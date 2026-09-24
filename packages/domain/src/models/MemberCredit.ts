import { Schema } from 'effect';

export const MemberCreditDepositId = Schema.String.pipe(Schema.brand('MemberCreditDepositId'));
export type MemberCreditDepositId = typeof MemberCreditDepositId.Type;
