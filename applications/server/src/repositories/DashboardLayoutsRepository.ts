import { Auth, DashboardLayoutApi, Team } from '@sideline/domain';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// ---------------------------------------------------------------------------
// Row schema
// Node-pg automatically parses JSONB columns into JS objects, so we use
// Schema.Array(DashboardWidget) directly (no JSON string parsing needed).
//
// LegacyDashboardWidgetRow is lenient: x/y/w/h are optional so that rows
// stored before the layout-grid migration can still be read back.
// normalizeWidgets in the API layer fills in the missing positions.
// ---------------------------------------------------------------------------

class LegacyDashboardWidgetRow extends Schema.Class<LegacyDashboardWidgetRow>(
  'LegacyDashboardWidgetRow',
)({
  id: DashboardLayoutApi.DashboardWidgetId,
  visible: Schema.Boolean,
  x: Schema.OptionFromOptionalKey(Schema.Number),
  y: Schema.OptionFromOptionalKey(Schema.Number),
  w: Schema.OptionFromOptionalKey(Schema.Number),
  h: Schema.OptionFromOptionalKey(Schema.Number),
}) {}

class DashboardLayoutLegacyRow extends Schema.Class<DashboardLayoutLegacyRow>(
  'DashboardLayoutLegacyRow',
)({
  widgets: Schema.Array(LegacyDashboardWidgetRow),
}) {}

class DashboardLayoutRow extends Schema.Class<DashboardLayoutRow>('DashboardLayoutRow')({
  widgets: Schema.Array(DashboardLayoutApi.DashboardWidget),
}) {}

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
                x: Option.getOrElse(w.x, () => 0),
                y: Option.getOrElse(w.y, () => 0),
                w: Option.getOrElse(w.w, () => 1),
                h: Option.getOrElse(w.h, () => 1),
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
          x: w.x,
          y: w.y,
          w: w.w,
          h: w.h,
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
