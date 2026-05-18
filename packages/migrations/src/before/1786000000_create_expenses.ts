import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
      CREATE TABLE expenses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
        currency CHAR(3) NOT NULL,
        spent_at TIMESTAMPTZ NOT NULL CHECK (spent_at > '1900-01-01'::timestamptz AND spent_at < now() + interval '365 days'),
        category TEXT NOT NULL CHECK (category IN ('fields','equipment','travel','tournaments','other')),
        description VARCHAR(500) NOT NULL,
        created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        updated_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `,
    ),
    Effect.tap(
      () =>
        sql`COMMENT ON COLUMN expenses.created_by_user_id IS 'Author of the expense. Future GDPR-erasure stories must anonymize via SET NULL or separate anonymization.'`,
    ),
    Effect.tap(
      () =>
        sql`COMMENT ON COLUMN expenses.updated_by_user_id IS 'Last editor of the expense. Same GDPR caveat as created_by_user_id.'`,
    ),
    Effect.tap(
      () => sql`CREATE INDEX idx_expenses_team_spent_at ON expenses (team_id, spent_at DESC)`,
    ),
    Effect.tap(() => sql`CREATE INDEX idx_expenses_team_category ON expenses (team_id, category)`),
    Effect.tap(
      () => sql`
      CREATE TABLE expense_history (
        history_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        expense_id UUID NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('insert','update','delete')),
        performed_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        performed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        snapshot JSONB NOT NULL
      )
    `,
    ),
    Effect.tap(
      () =>
        sql`CREATE INDEX idx_expense_history_expense ON expense_history (expense_id, performed_at DESC)`,
    ),
    Effect.tap(
      () => sql`
      CREATE FUNCTION expenses_audit() RETURNS TRIGGER AS $$
      DECLARE
        audit_user_id UUID;
      BEGIN
        BEGIN
          IF TG_OP = 'INSERT' THEN
            INSERT INTO expense_history (expense_id, operation, performed_by_user_id, snapshot)
            VALUES (NEW.id, 'insert', NEW.created_by_user_id, to_jsonb(NEW));
            RETURN NEW;
          ELSIF TG_OP = 'UPDATE' THEN
            INSERT INTO expense_history (expense_id, operation, performed_by_user_id, snapshot)
            VALUES (NEW.id, 'update', NEW.updated_by_user_id, to_jsonb(NEW));
            RETURN NEW;
          ELSIF TG_OP = 'DELETE' THEN
            -- Prefer the session-local audit.user_id set by the application (covers DELETE actor).
            -- Fall back to OLD.updated_by_user_id for backwards compatibility.
            BEGIN
              audit_user_id := current_setting('audit.user_id', true)::uuid;
            EXCEPTION WHEN OTHERS THEN
              audit_user_id := NULL;
            END;
            IF audit_user_id IS NULL THEN
              audit_user_id := OLD.updated_by_user_id;
            END IF;
            INSERT INTO expense_history (expense_id, operation, performed_by_user_id, snapshot)
            VALUES (OLD.id, 'delete', audit_user_id, to_jsonb(OLD));
            RETURN OLD;
          END IF;
          RETURN NULL;
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'expenses_audit trigger failed: %', SQLERRM;
          RETURN COALESCE(NEW, OLD);
        END;
      END;
      $$ LANGUAGE plpgsql
    `,
    ),
    Effect.tap(
      () => sql`
      CREATE TRIGGER expenses_audit_trg
        AFTER INSERT OR UPDATE OR DELETE ON expenses
        FOR EACH ROW EXECUTE FUNCTION expenses_audit()
    `,
    ),
  ),
);
