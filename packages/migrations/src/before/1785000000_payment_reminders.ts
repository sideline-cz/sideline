import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS payment_reminder_sync_events (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          guild_id text NOT NULL,
          assignment_id uuid NOT NULL REFERENCES fee_assignments(id) ON DELETE CASCADE,
          kind varchar(32) NOT NULL,
          effective_due_at timestamptz NOT NULL,
          fee_name text NOT NULL,
          currency char(3) NOT NULL,
          amount_minor bigint NOT NULL,
          paid_minor bigint NOT NULL,
          user_discord_id text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          processed_at timestamptz,
          error text
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS payment_reminders_sent (
          assignment_id uuid NOT NULL REFERENCES fee_assignments(id) ON DELETE CASCADE,
          kind varchar(32) NOT NULL,
          sent_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (assignment_id, kind)
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_fee_assignments_due_at ON fee_assignments(due_at)
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_payment_reminder_sync_events_unprocessed
          ON payment_reminder_sync_events(created_at)
          WHERE processed_at IS NULL
      `,
    ),
  ),
);
