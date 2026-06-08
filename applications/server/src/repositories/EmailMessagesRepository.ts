import { Discord, EmailForwarding, Team } from '@sideline/domain';
import { LogicError, Schemas } from '@sideline/effect-lib';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

export class EmailMessageRow extends Schema.Class<EmailMessageRow>('EmailMessageRow')({
  id: EmailForwarding.EmailMessageId,
  team_id: Team.TeamId,
  status: EmailForwarding.EmailStatus,
  from_address: Schema.String,
  subject: Schema.String,
  body: Schema.String,
  summary: Schema.OptionFromNullOr(Schema.String),
  summarize_attempts: Schema.Int,
  last_error: Schema.OptionFromNullOr(Schema.String),
  approval_request_message_id: Schema.OptionFromNullOr(Schema.String),
  approved_by: Schema.OptionFromNullOr(Schema.String),
  rejected_by: Schema.OptionFromNullOr(Schema.String),
  posted_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  received_at: Schema.DateTimeUtcFromDate,
  created_at: Schema.DateTimeUtcFromDate,
  updated_at: Schema.DateTimeUtcFromDate,
}) {}

class InsertedId extends Schema.Class<InsertedId>('EmailInsertedId')({
  id: EmailForwarding.EmailMessageId,
}) {}

class ConditionalId extends Schema.Class<ConditionalId>('EmailConditionalId')({
  id: EmailForwarding.EmailMessageId,
}) {}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertReceivedQuery = SqlSchema.findOne({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      from_address: Schema.String,
      subject: Schema.String,
      body: Schema.String,
      received_at: Schemas.DateTimeFromIsoString,
    }),
    Result: InsertedId,
    execute: (input) => sql`
      INSERT INTO email_messages (team_id, from_address, subject, body, received_at)
      VALUES (${input.team_id}::uuid, ${input.from_address}, ${input.subject}, ${input.body}, ${input.received_at})
      RETURNING id
    `,
  });

  const findByIdQuery = SqlSchema.findOneOption({
    Request: EmailForwarding.EmailMessageId,
    Result: EmailMessageRow,
    execute: (id) => sql`
      SELECT id, team_id, status, from_address, subject, body, summary, summarize_attempts,
             last_error, approval_request_message_id, approved_by, rejected_by,
             posted_channel_id, received_at, created_at, updated_at
      FROM email_messages
      WHERE id = ${id}::uuid
    `,
  });

  const findReceivedBatchQuery = SqlSchema.findAll({
    Request: Schema.Int,
    Result: InsertedId,
    execute: (limit) => sql`
      SELECT id FROM email_messages
      WHERE status = 'received'
      ORDER BY received_at ASC
      LIMIT ${limit}
    `,
  });

  const claimForSummarizingQuery = SqlSchema.findOneOption({
    Request: EmailForwarding.EmailMessageId,
    Result: ConditionalId,
    execute: (id) => sql`
      UPDATE email_messages
      SET status = 'summarizing', updated_at = now()
      WHERE id = ${id}::uuid AND status = 'received'
      RETURNING id
    `,
  });

  const setSummaryPendingApprovalQuery = SqlSchema.void({
    Request: Schema.Struct({
      id: EmailForwarding.EmailMessageId,
      summary: Schema.String,
    }),
    execute: (input) => sql`
      UPDATE email_messages
      SET status = 'pending_approval', summary = ${input.summary}, updated_at = now()
      WHERE id = ${input.id}::uuid
    `,
  });

  const updateSummaryQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: EmailForwarding.EmailMessageId,
      summary: Schema.String,
    }),
    Result: ConditionalId,
    execute: (input) => sql`
      UPDATE email_messages
      SET summary = ${input.summary}, updated_at = now()
      WHERE id = ${input.id}::uuid AND status = 'pending_approval'
      RETURNING id
    `,
  });

  const incrementAttemptsQuery = SqlSchema.void({
    Request: Schema.Struct({
      id: EmailForwarding.EmailMessageId,
      max_attempts: Schema.Int,
      error: Schema.String,
    }),
    execute: (input) => sql`
      UPDATE email_messages
      SET summarize_attempts = summarize_attempts + 1,
          last_error = ${input.error},
          status = CASE WHEN summarize_attempts + 1 >= ${input.max_attempts} THEN 'failed' ELSE 'received' END,
          updated_at = now()
      WHERE id = ${input.id}::uuid
    `,
  });

  const approveQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: EmailForwarding.EmailMessageId,
      by: Schema.String,
    }),
    Result: ConditionalId,
    execute: (input) => sql`
      UPDATE email_messages
      SET status = 'approved', approved_by = ${input.by}, updated_at = now()
      WHERE id = ${input.id}::uuid AND status = 'pending_approval'
      RETURNING id
    `,
  });

  const rejectQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: EmailForwarding.EmailMessageId,
      by: Schema.String,
    }),
    Result: ConditionalId,
    execute: (input) => sql`
      UPDATE email_messages
      SET status = 'rejected', rejected_by = ${input.by}, updated_at = now()
      WHERE id = ${input.id}::uuid AND status = 'pending_approval'
      RETURNING id
    `,
  });

  const setPostedQuery = SqlSchema.void({
    Request: Schema.Struct({
      id: EmailForwarding.EmailMessageId,
      status: EmailForwarding.EmailStatus,
      channel_id: Schema.String,
    }),
    execute: (input) => sql`
      UPDATE email_messages
      SET status = ${input.status}, posted_channel_id = ${input.channel_id}, updated_at = now()
      WHERE id = ${input.id}::uuid
    `,
  });

  const insertReceived = (input: {
    readonly team_id: Team.TeamId;
    readonly from_address: string;
    readonly subject: string;
    readonly body: string;
    readonly received_at: import('effect').DateTime.Utc;
  }) =>
    insertReceivedQuery(input).pipe(
      catchSqlErrors,
      Effect.catchTag('NoSuchElementError', () =>
        LogicError.die('Failed inserting email_messages — no row returned'),
      ),
      Effect.map((row) => row.id),
    );

  const findById = (id: EmailForwarding.EmailMessageId) => findByIdQuery(id).pipe(catchSqlErrors);

  const findReceivedBatch = (limit: number) =>
    findReceivedBatchQuery(limit).pipe(
      catchSqlErrors,
      Effect.map((rows) => rows.map((r) => r.id)),
    );

  const claimForSummarizing = (id: EmailForwarding.EmailMessageId) =>
    claimForSummarizingQuery(id).pipe(catchSqlErrors, Effect.map(Option.map((r) => r.id)));

  const setSummaryPendingApproval = (id: EmailForwarding.EmailMessageId, summary: string) =>
    setSummaryPendingApprovalQuery({ id, summary }).pipe(catchSqlErrors);

  const updateSummary = (id: EmailForwarding.EmailMessageId, summary: string) =>
    updateSummaryQuery({ id, summary }).pipe(catchSqlErrors, Effect.map(Option.map((r) => r.id)));

  const incrementAttemptsAndMaybeFail = (
    id: EmailForwarding.EmailMessageId,
    maxAttempts: number,
    error: string,
  ) => incrementAttemptsQuery({ id, max_attempts: maxAttempts, error }).pipe(catchSqlErrors);

  const approve = (id: EmailForwarding.EmailMessageId, by: string) =>
    approveQuery({ id, by }).pipe(catchSqlErrors, Effect.map(Option.map((r) => r.id)));

  const reject = (id: EmailForwarding.EmailMessageId, by: string) =>
    rejectQuery({ id, by }).pipe(catchSqlErrors, Effect.map(Option.map((r) => r.id)));

  const setPosted = (
    id: EmailForwarding.EmailMessageId,
    status: EmailForwarding.EmailStatus,
    channelId: string,
  ) => setPostedQuery({ id, status, channel_id: channelId }).pipe(catchSqlErrors);

  return {
    insertReceived,
    findById,
    findReceivedBatch,
    claimForSummarizing,
    setSummaryPendingApproval,
    updateSummary,
    incrementAttemptsAndMaybeFail,
    approve,
    reject,
    setPosted,
  } as const;
});

export class EmailMessagesRepository extends ServiceMap.Service<
  EmailMessagesRepository,
  Effect.Success<typeof make>
>()('api/EmailMessagesRepository') {
  static readonly Default = Layer.effect(EmailMessagesRepository, make);
}
