import { Schema } from 'effect';

export const PaymentReminderKind = Schema.Literals([
  'due_in_3d',
  'due_today',
  'overdue_3d',
  'overdue_10d',
  'overdue_21d',
]);
export type PaymentReminderKind = typeof PaymentReminderKind.Type;
