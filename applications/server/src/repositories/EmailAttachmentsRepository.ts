import { EmailForwarding } from '@sideline/domain';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

class AttachmentMetaRow extends Schema.Class<AttachmentMetaRow>('EmailAttachmentMetaRow')({
  id: EmailForwarding.EmailAttachmentId,
  filename: Schema.String,
  content_type: Schema.String,
  size_bytes: Schema.Int,
  created_at: Schema.DateTimeUtc,
}) {}

class AttachmentWithBytesRow extends Schema.Class<AttachmentWithBytesRow>(
  'EmailAttachmentWithBytesRow',
)({
  id: EmailForwarding.EmailAttachmentId,
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

  const listMetaByEmailQuery = SqlSchema.findAll({
    Request: EmailForwarding.EmailMessageId,
    Result: AttachmentMetaRow,
    execute: (emailMessageId) => sql`
      SELECT id, filename, content_type, size_bytes, created_at
      FROM email_attachments
      WHERE email_message_id = ${emailMessageId}::uuid
      ORDER BY created_at ASC
    `,
  });

  const findByIdWithBytesQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: EmailForwarding.EmailAttachmentId,
      email_message_id: EmailForwarding.EmailMessageId,
    }),
    Result: AttachmentWithBytesRow,
    execute: (input) => sql`
      SELECT id, filename, content_type, size_bytes, content
      FROM email_attachments
      WHERE id = ${input.id}::uuid AND email_message_id = ${input.email_message_id}::uuid
    `,
  });

  const insertMany = (
    emailMessageId: EmailForwarding.EmailMessageId,
    attachments: ReadonlyArray<{
      readonly filename: string;
      readonly content_type: string;
      readonly size_bytes: number;
      readonly content_base64: string;
    }>,
  ) => {
    if (attachments.length === 0) return Effect.void;
    return sql`
      INSERT INTO email_attachments (email_message_id, filename, content_type, size_bytes, content)
      VALUES ${sql.join(',')(
        attachments.map(
          (a) =>
            sql`(${emailMessageId}::uuid, ${a.filename}, ${a.content_type}, ${a.size_bytes}, ${Buffer.from(a.content_base64, 'base64')})`,
        ),
      )}
    `.pipe(Effect.asVoid, catchSqlErrors);
  };

  const listMetaByEmail = (emailMessageId: EmailForwarding.EmailMessageId) =>
    listMetaByEmailQuery(emailMessageId).pipe(
      catchSqlErrors,
      Effect.map((rows) =>
        rows.map(
          (r) =>
            new EmailForwarding.EmailAttachmentMeta({
              attachmentId: r.id,
              filename: r.filename,
              contentType: r.content_type,
              sizeBytes: r.size_bytes,
              createdAt: r.created_at,
            }),
        ),
      ),
    );

  const findByIdWithBytes = (
    attachmentId: EmailForwarding.EmailAttachmentId,
    emailMessageId: EmailForwarding.EmailMessageId,
  ) =>
    findByIdWithBytesQuery({ id: attachmentId, email_message_id: emailMessageId }).pipe(
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

  return {
    insertMany,
    listMetaByEmail,
    findByIdWithBytes,
  } as const;
});

export class EmailAttachmentsRepository extends ServiceMap.Service<
  EmailAttachmentsRepository,
  Effect.Success<typeof make>
>()('api/EmailAttachmentsRepository') {
  static readonly Default = Layer.effect(EmailAttachmentsRepository, make);
}
