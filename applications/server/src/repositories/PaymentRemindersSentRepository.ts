import { FeeAssignment, PaymentReminder } from '@sideline/domain';
import { Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const _markSent = SqlSchema.void({
    Request: Schema.Struct({
      assignment_id: FeeAssignment.FeeAssignmentId,
      kind: PaymentReminder.PaymentReminderKind,
    }),
    execute: (input) => sql`
      INSERT INTO payment_reminders_sent (assignment_id, kind)
      VALUES (${input.assignment_id}, ${input.kind})
      ON CONFLICT DO NOTHING
    `,
  });

  const _existsForAssignmentKind = SqlSchema.findAll({
    Request: Schema.Struct({
      assignment_id: FeeAssignment.FeeAssignmentId,
      kind: PaymentReminder.PaymentReminderKind,
    }),
    Result: Schema.Struct({ found: Schema.Number }),
    execute: (input) => sql`
      SELECT 1 AS found
      FROM payment_reminders_sent
      WHERE assignment_id = ${input.assignment_id}
        AND kind = ${input.kind}
      LIMIT 1
    `,
  });

  const markSent = (
    assignmentId: FeeAssignment.FeeAssignmentId,
    kind: PaymentReminder.PaymentReminderKind,
  ) => _markSent({ assignment_id: assignmentId, kind }).pipe(catchSqlErrors);

  const existsForAssignmentKind = (
    assignmentId: FeeAssignment.FeeAssignmentId,
    kind: PaymentReminder.PaymentReminderKind,
  ) =>
    _existsForAssignmentKind({ assignment_id: assignmentId, kind }).pipe(
      catchSqlErrors,
      Effect.map((rows) => rows.length > 0),
    );

  return {
    markSent,
    existsForAssignmentKind,
  };
});

export class PaymentRemindersSentRepository extends ServiceMap.Service<
  PaymentRemindersSentRepository,
  Effect.Success<typeof make>
>()('api/PaymentRemindersSentRepository') {
  static readonly Default = Layer.effect(PaymentRemindersSentRepository, make);
}
