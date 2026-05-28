import { Auth, DashboardLayoutApi, Team } from '@sideline/domain';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// ---------------------------------------------------------------------------
// Row schema
// Node-pg automatically parses JSONB columns into JS objects, so we use
// Schema.Array(DashboardWidget) directly (no JSON string parsing needed).
//
// LegacyDashboardWidgetRow is lenient: height is optional (legacy rows from
// the grid era stored x/y/w/h instead). On read, we fall back to the
// canonical height from DEFAULT_LAYOUT so old rows don't break the load.
// ---------------------------------------------------------------------------

class LegacyDashboardWidgetRow extends Schema.Class<LegacyDashboardWidgetRow>(
  'LegacyDashboardWidgetRow',
)({
  id: DashboardLayoutApi.DashboardWidgetId,
  visible: Schema.Boolean,
  height: Schema.OptionFromOptionalKey(Schema.Number),
}) {}

class DashboardLayoutLegacyRow extends Schema.Class<DashboardLayoutLegacyRow>(
  'DashboardLayoutLegacyRow',
)({
  widgets: Schema.Array(LegacyDashboardWidgetRow),
}) {}

class DashboardLayoutRow extends Schema.Class<DashboardLayoutRow>('DashboardLayoutRow')({
  widgets: Schema.Array(DashboardLayoutApi.DashboardWidget),
}) {}

// Default height lookup for legacy backfill
const defaultHeightById = new Map<DashboardLayoutApi.DashboardWidgetId, number>(
  DashboardLayoutApi.DEFAULT_LAYOUT.map((entry) => [entry.id, entry.height]),
);

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const _findByUserTeam = SqlSchema.findOneOption({
    Request: Schema.Struct({ user_id: Auth.UserId, team_id: Team.TeamId }),
    Result: DashboardLayoutLegacyRow,
    execute: (input) =>
      sql`SELECT widgets FROM dashboard_layouts WHERE user_id = ${input.user_id} AND team_id = ${input.team_id}`,
  });

  const _upsert = SqlSchema.findOne({
    Request: Schema.Struct({
      user_id: Auth.UserId,
      team_id: Team.TeamId,
      widgets_json: Schema.String,
    }),
    Result: DashboardLayoutRow,
    execute: (input) =>
      sql`INSERT INTO dashboard_layouts (user_id, team_id, widgets)
          VALUES (${input.user_id}, ${input.team_id}, ${input.widgets_json}::jsonb)
          ON CONFLICT (user_id, team_id) DO UPDATE SET
            widgets = EXCLUDED.widgets,
            updated_at = now()
          RETURNING widgets`,
  });

  const findByUserTeam = (userId: Auth.UserId, teamId: Team.TeamId) =>
    _findByUserTeam({ user_id: userId, team_id: teamId }).pipe(
      Effect.map(
        Option.map((row) => ({
          widgets: row.widgets.map(
            (w) =>
              new DashboardLayoutApi.DashboardWidget({
                id: w.id,
                visible: w.visible,
                // Backfill height for legacy rows that stored x/y/w/h instead
                height: Option.getOrElse(w.height, () => defaultHeightById.get(w.id) ?? 200),
              }),
          ),
        })),
      ),
      catchSqlErrors,
    );

  const upsert = (
    userId: Auth.UserId,
    teamId: Team.TeamId,
    widgets: ReadonlyArray<DashboardLayoutApi.DashboardWidget>,
  ) =>
    _upsert({
      user_id: userId,
      team_id: teamId,
      widgets_json: JSON.stringify(
        widgets.map((w) => ({
          id: w.id,
          visible: w.visible,
          height: w.height,
        })),
      ),
    }).pipe(
      Effect.map((row) => ({
        widgets: row.widgets,
      })),
      catchSqlErrors,
    );

  return {
    findByUserTeam,
    upsert,
  };
});

export class DashboardLayoutsRepository extends ServiceMap.Service<
  DashboardLayoutsRepository,
  Effect.Success<typeof make>
>()('api/DashboardLayoutsRepository') {
  static readonly Default = Layer.effect(DashboardLayoutsRepository, make);
}
