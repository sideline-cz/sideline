import { Schema } from 'effect';

export const PaymentReminderKind = Schema.Literals([
  // [D15b] Fired once, at assignment creation — carries the QR. Not date-gated: an assignment
  // due six weeks out still fires immediately, so a member who pays early has a VS to pay with.
  'assigned',
  'due_in_3d',
  'due_today',
  'overdue_3d',
  'overdue_10d',
  'overdue_21d',
]);
export type PaymentReminderKind = typeof PaymentReminderKind.Type;
