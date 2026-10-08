import type { Auth } from '@sideline/domain';
import { Expense } from '@sideline/domain';
import { SqlErrors } from '@sideline/effect-lib';
import { Data, Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

/** The expense was deleted between the handler's ownership check and this insert. Raised from
 * the foreign-key violation alone, so the narrow race reads as a 404 rather than a 500. */
export class ExpenseGoneBeforeAttachment extends Data.TaggedError(
  'ExpenseGoneBeforeAttachment',
)<{}> {}

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

class AttachmentMetaRow extends Schema.Class<AttachmentMetaRow>('ExpenseAttachmentMetaRow')({
  id: Expense.ExpenseAttachmentId,
  filename: Schema.String,
  content_type: Schema.String,
  size_bytes: Schema.Int,
}) {}

class AttachmentWithBytesRow extends Schema.Class<AttachmentWithBytesRow>(
  'ExpenseAttachmentWithBytesRow',
)({
  id: Expense.ExpenseAttachmentId,
  filename: Schema.String,
  content_type: Schema.String,
  size_bytes: Schema.Int,
  content: Schema.Uint8Array,
}) {}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByIdWithBytesQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: Expense.ExpenseAttachmentId,
      expense_id: Expense.ExpenseId,
    }),
    Result: AttachmentWithBytesRow,
    execute: (input) => sql`
      SELECT id, filename, content_type, size_bytes, content
      FROM expense_attachments
      WHERE id = ${input.id}::uuid AND expense_id = ${input.expense_id}::uuid
    `,
  });

  const deleteQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: Expense.ExpenseAttachmentId,
      expense_id: Expense.ExpenseId,
    }),
    Result: Schema.Struct({ id: Expense.ExpenseAttachmentId }),
    execute: (input) => sql`
      DELETE FROM expense_attachments
      WHERE id = ${input.id}::uuid AND expense_id = ${input.expense_id}::uuid
      RETURNING id
    `,
  });

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  // `Request: Schema.Void` plus a closure, exactly like `ExpensesRepository.updateQuery`: the
  // BYTEA parameter is a Buffer and does not round-trip through a Request schema.
  // Fails with NoSuchElementError if nothing came back; the handler maps it via LogicError.
  const insert = (input: {
    expense_id: Expense.ExpenseId;
    filename: string;
    content_type: string;
    size_bytes: number;
    content: Uint8Array;
    uploaded_by_user_id: Auth.UserId;
  }) =>
    SqlSchema.findOne({
      Request: Schema.Void,
      Result: AttachmentMetaRow,
      execute: () => sql`
        INSERT INTO expense_attachments
          (expense_id, filename, content_type, size_bytes, content, uploaded_by_user_id)
        VALUES (
          ${input.expense_id}::uuid,
          ${input.filename},
          ${input.content_type},
          ${input.size_bytes},
          ${Buffer.from(input.content)},
          ${input.uploaded_by_user_id}::uuid
        )
        RETURNING id, filename, content_type, size_bytes
      `,
    })(undefined).pipe(
      // Must precede `catchSqlErrors`, which would otherwise turn the violation into a defect.
      SqlErrors.catchForeignKeyViolation(() => new ExpenseGoneBeforeAttachment()),
      catchSqlErrors,
    );

  // Scoped by BOTH ids — an attachment id from another expense is `Option.none()`, i.e. 404.
  const findByIdWithBytes = (
    attachmentId: Expense.ExpenseAttachmentId,
    expenseId: Expense.ExpenseId,
  ) =>
    findByIdWithBytesQuery({ id: attachmentId, expense_id: expenseId }).pipe(
      catchSqlErrors,
      Effect.map(
        Option.map((r) => ({
          filename: r.filename,
          contentType: r.content_type,
          sizeBytes: r.size_bytes,
          content: r.content,
        })),
      ),
    );

  const delete_ = (attachmentId: Expense.ExpenseAttachmentId, expenseId: Expense.ExpenseId) =>
    deleteQuery({ id: attachmentId, expense_id: expenseId }).pipe(
      Effect.map(Option.isSome),
      catchSqlErrors,
    );

  return {
    insert,
    findByIdWithBytes,
    delete: delete_,
  } as const;
});

export class ExpenseAttachmentsRepository extends ServiceMap.Service<
  ExpenseAttachmentsRepository,
  Effect.Success<typeof make>
>()('api/ExpenseAttachmentsRepository') {
  static readonly Default = Layer.effect(ExpenseAttachmentsRepository, make);
}
