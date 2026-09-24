import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // ---- Step 1: table -----------------------------------------------------
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS membership_plans (
          id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id                  UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          -- NULL = render the built-in translated label for the seeded default plan.
          -- Set = captain's free text. Same rationale as event_types.name (AGENTS.md).
          name                     TEXT,
          price_minor              BIGINT NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
          currency                 CHAR(3) NOT NULL,
          price_per_training_minor BIGINT NOT NULL DEFAULT 0 CHECK (price_per_training_minor >= 0),
          expires_at               TIMESTAMPTZ,
          is_default               BOOLEAN NOT NULL DEFAULT false,
          archived_at              TIMESTAMPTZ,
          created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_membership_plans_team_default
          ON membership_plans (team_id) WHERE is_default AND archived_at IS NULL
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_membership_plans_team_name
          ON membership_plans (team_id, lower(name)) WHERE archived_at IS NULL AND name IS NOT NULL
      `,
    ),
    // Serves `findMembershipPlansByTeamId`'s `WHERE team_id = $1 AND archived_at IS NULL ORDER
    // BY is_default DESC, created_at ASC` — neither unique index above covers it (both are
    // partial on other predicates). Same pattern as `idx_event_types_team_position`.
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_membership_plans_team_active
          ON membership_plans (team_id, is_default DESC, created_at) WHERE archived_at IS NULL
      `,
    ),

    // ---- Step 2: seed existing teams (idempotent) --------------------------
    // NULL name, never a translated literal ('Free'/'Zdarma') and never a CASE on
    // teams.onboarding_locale -- that would freeze one locale into the row regardless
    // of the viewer reading it later (same rationale as event_types.name, AGENTS.md).
    Effect.tap(
      () => sql`
        INSERT INTO membership_plans (team_id, name, currency, is_default)
        SELECT t.id, NULL, 'CZK', true FROM teams t
        WHERE NOT EXISTS (SELECT 1 FROM membership_plans mp WHERE mp.team_id = t.id)
      `,
    ),

    // ---- Step 3: seed trigger for future teams ------------------------------
    Effect.tap(
      () => sql`
        CREATE OR REPLACE FUNCTION seed_default_membership_plan() RETURNS trigger AS $$
        BEGIN
          INSERT INTO membership_plans (team_id, name, currency, is_default)
          VALUES (NEW.id, NULL, 'CZK', true);
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE OR REPLACE TRIGGER seed_default_membership_plan_trg
          AFTER INSERT ON teams
          FOR EACH ROW EXECUTE FUNCTION seed_default_membership_plan()
      `,
    ),
  ),
);
