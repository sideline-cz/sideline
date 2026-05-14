import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
      CREATE TABLE fees (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
        currency CHAR(3) NOT NULL,
        due_at TIMESTAMPTZ,
        recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none')),
        target_scope TEXT NOT NULL DEFAULT 'all_members' CHECK (target_scope IN ('all_members','custom')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        archived_at TIMESTAMPTZ
      )
    `,
    ),
    Effect.tap(
      () => sql`CREATE INDEX idx_fees_team_active ON fees(team_id) WHERE archived_at IS NULL`,
    ),
    Effect.tap(() => sql`CREATE INDEX idx_fees_team_due ON fees(team_id, due_at)`),
    Effect.tap(
      () => sql`
      CREATE TABLE fee_assignments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        fee_id UUID NOT NULL REFERENCES fees(id) ON DELETE CASCADE,
        team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE RESTRICT,
        amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
        paid_minor BIGINT NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
        due_at TIMESTAMPTZ,
        stored_status TEXT NOT NULL DEFAULT 'active' CHECK (stored_status IN ('active','waived')),
        waived_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (fee_id, team_member_id)
      )
    `,
    ),
    Effect.tap(
      () => sql`CREATE INDEX idx_fee_assignments_member ON fee_assignments(team_member_id)`,
    ),
    Effect.tap(() => sql`CREATE INDEX idx_fee_assignments_fee ON fee_assignments(fee_id)`),
    Effect.tap(
      () => sql`
      CREATE TABLE payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        fee_assignment_id UUID NOT NULL REFERENCES fee_assignments(id) ON DELETE RESTRICT,
        team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE RESTRICT,
        amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
        method TEXT NOT NULL CHECK (method IN ('cash','bank_transfer')),
        paid_at TIMESTAMPTZ NOT NULL,
        note TEXT,
        recorded_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        voided_at TIMESTAMPTZ,
        voided_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
        void_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK ((voided_at IS NULL AND voided_by_user_id IS NULL AND void_reason IS NULL)
            OR (voided_at IS NOT NULL AND voided_by_user_id IS NOT NULL AND void_reason IS NOT NULL))
      )
    `,
    ),
    Effect.tap(
      () =>
        sql`CREATE INDEX idx_payments_assignment_active ON payments(fee_assignment_id) WHERE voided_at IS NULL`,
    ),
    Effect.tap(() => sql`CREATE INDEX idx_payments_member ON payments(team_member_id)`),
    Effect.tap(() => sql`CREATE INDEX idx_payments_paid_at ON payments(paid_at DESC)`),
    Effect.tap(
      () => sql`
      CREATE OR REPLACE FUNCTION recompute_paid_minor(p_assignment_id UUID) RETURNS void AS $$
      BEGIN
        -- Lock the assignment row to serialize concurrent recomputations
        PERFORM 1 FROM fee_assignments WHERE id = p_assignment_id FOR UPDATE;

        UPDATE fee_assignments fa
        SET paid_minor = COALESCE((
          SELECT SUM(p.amount_minor)::BIGINT FROM payments p
          WHERE p.fee_assignment_id = fa.id AND p.voided_at IS NULL
        ), 0),
        updated_at = now()
        WHERE fa.id = p_assignment_id;
      END;
      $$ LANGUAGE plpgsql
    `,
    ),
    Effect.tap(
      () => sql`
      CREATE OR REPLACE FUNCTION payments_recompute_trigger() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          PERFORM recompute_paid_minor(OLD.fee_assignment_id);
          RETURN OLD;
        END IF;
        PERFORM recompute_paid_minor(NEW.fee_assignment_id);
        IF TG_OP = 'UPDATE' AND OLD.fee_assignment_id <> NEW.fee_assignment_id THEN
          PERFORM recompute_paid_minor(OLD.fee_assignment_id);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `,
    ),
    Effect.tap(
      () => sql`
      CREATE TRIGGER payments_recompute_paid_minor
        AFTER INSERT OR UPDATE OR DELETE ON payments
        FOR EACH ROW EXECUTE FUNCTION payments_recompute_trigger()
    `,
    ),
    Effect.tap(
      () => sql`
      CREATE VIEW fee_assignment_status_v AS
      SELECT
        fa.id              AS assignment_id,
        fa.fee_id,
        f.team_id,
        fa.team_member_id,
        fa.amount_minor    AS due_minor,
        fa.paid_minor      AS paid_minor,
        COALESCE(fa.due_at, f.due_at) AS effective_due_at,
        CASE
          WHEN fa.stored_status = 'waived' THEN 'waived'
          WHEN fa.paid_minor >= fa.amount_minor THEN 'paid'
          WHEN fa.paid_minor > 0 THEN 'partial'
          WHEN COALESCE(fa.due_at, f.due_at) IS NOT NULL
               AND COALESCE(fa.due_at, f.due_at) < now() THEN 'overdue'
          ELSE 'pending'
        END AS status,
        f.currency,
        f.name AS fee_name,
        fa.stored_status,
        fa.waived_reason
      FROM fee_assignments fa
      JOIN fees f ON f.id = fa.fee_id
    `,
    ),
  ),
);
