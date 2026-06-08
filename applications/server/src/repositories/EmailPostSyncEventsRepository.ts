import { Discord, EmailForwarding, EmailRpcEvents, Team } from '@sideline/domain';
import { Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

class UnprocessedEventRow extends Schema.Class<UnprocessedEventRow>('UnprocessedEmailSyncEventRow')(
  {
    id: Schema.String,
    email_message_id: EmailForwarding.EmailMessageId,
    team_id: Team.TeamId,
    kind: EmailRpcEvents.EmailPostEventKind,
    coach_channel_id: Discord.Snowflake,
    target_channel_id: Discord.Snowflake,
    subject: Schema.String,
    from_address: Schema.String,
    summary: Schema.OptionFromNullOr(Schema.String),
    body: Schema.String,
    received_at: Schema.DateTimeUtcFromDate,
  },
) {}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const enqueueQuery = SqlSchema.void({
    Request: Schema.Struct({
      email_message_id: EmailForwarding.EmailMessageId,
      team_id: Schema.String,
      kind: EmailRpcEvents.EmailPostEventKind,
    }),
    execute: (input) => sql`
      INSERT INTO email_post_sync_events (email_message_id, team_id, kind)
      VALUES (${input.email_message_id}::uuid, ${input.team_id}::uuid, ${input.kind})
      ON CONFLICT (email_message_id, kind) DO NOTHING
    `,
  });

  const MAX_ATTEMPTS = 5;

  const findUnprocessedQuery = SqlSchema.findAll({
    Request: Schema.Int,
    Result: UnprocessedEventRow,
    execute: (limit) => sql`
      SELECT
        e.id::text AS id,
        e.email_message_id,
        e.team_id,
        e.kind,
        c.coach_channel_id,
        c.target_channel_id,
        m.subject,
        m.from_address,
        m.summary,
        m.body,
        m.received_at
      FROM email_post_sync_events e
      JOIN email_forwarding_config c ON c.team_id = e.team_id
      JOIN email_messages m ON m.id = e.email_message_id
      WHERE e.processed_at IS NULL
        AND e.attempts < ${MAX_ATTEMPTS}
      ORDER BY e.created_at ASC
      LIMIT ${limit}
    `,
  });

  const markProcessedQuery = SqlSchema.void({
    Request: Schema.Struct({ id: Schema.String }),
    execute: (input) => sql`
      UPDATE email_post_sync_events
      SET processed_at = now()
      WHERE id = ${input.id}::uuid
    `,
  });

  const markFailedQuery = SqlSchema.void({
    Request: Schema.Struct({ id: Schema.String, error: Schema.String }),
    execute: (input) => sql`
      UPDATE email_post_sync_events
      SET error = ${input.error},
          attempts = attempts + 1
      WHERE id = ${input.id}::uuid
    `,
  });

  const enqueue = (
    emailMessageId: EmailForwarding.EmailMessageId,
    teamId: string,
    kind: EmailRpcEvents.EmailPostEventKind,
  ) =>
    enqueueQuery({ email_message_id: emailMessageId, team_id: teamId, kind }).pipe(catchSqlErrors);

  const findUnprocessed = (limit: number) =>
    findUnprocessedQuery(limit).pipe(
      catchSqlErrors,
      Effect.map((rows) =>
        rows.map(
          (r) =>
            new EmailRpcEvents.EmailPostEvent({
              id: r.id,
              email_message_id: r.email_message_id,
              team_id: r.team_id,
              kind: r.kind,
              coach_channel_id: r.coach_channel_id,
              target_channel_id: r.target_channel_id,
              subject: r.subject,
              from_address: r.from_address,
              summary: r.summary,
              body: r.body,
              received_at: r.received_at,
            }),
        ),
      ),
    );

  const markProcessed = (id: string) => markProcessedQuery({ id }).pipe(catchSqlErrors);

  const markFailed = (id: string, error: string) =>
    markFailedQuery({ id, error }).pipe(catchSqlErrors);

  return {
    enqueue,
    findUnprocessed,
    markProcessed,
    markFailed,
  } as const;
});

export class EmailPostSyncEventsRepository extends ServiceMap.Service<
  EmailPostSyncEventsRepository,
  Effect.Success<typeof make>
>()('api/EmailPostSyncEventsRepository') {
  static readonly Default = Layer.effect(EmailPostSyncEventsRepository, make);
}
