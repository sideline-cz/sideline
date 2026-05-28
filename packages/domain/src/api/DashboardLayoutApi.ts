import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { TeamId } from '~/models/Team.js';

export const DashboardWidgetId = Schema.Literals([
  'stats',
  'upcomingEvents',
  'activity',
  'teamManagement',
]);
export type DashboardWidgetId = typeof DashboardWidgetId.Type;

export const DASHBOARD_WIDGET_ORDER = [
  'stats',
  'upcomingEvents',
  'activity',
  'teamManagement',
] as const;

export class DashboardWidget extends Schema.Class<DashboardWidget>('DashboardWidget')({
  id: DashboardWidgetId,
  visible: Schema.Boolean,
  height: Schema.Number,
}) {}

export interface DefaultLayoutEntry {
  id: DashboardWidgetId;
  visible: boolean;
  height: number;
}

// Sensible pixel-height defaults for the vertical-stack layout.
// stats:          140px  (4 stat tiles)
// upcomingEvents: 280px  (event list)
// activity:       200px  (3 detail rows)
// teamManagement: 260px  (8 nav links)
export const DEFAULT_LAYOUT: ReadonlyArray<DefaultLayoutEntry> = [
  { id: 'stats', visible: true, height: 140 },
  { id: 'upcomingEvents', visible: true, height: 280 },
  { id: 'activity', visible: true, height: 200 },
  { id: 'teamManagement', visible: true, height: 260 },
] as const;

export class DashboardLayout extends Schema.Class<DashboardLayout>('DashboardLayout')({
  widgets: Schema.Array(DashboardWidget),
}) {}

export const UpdateDashboardLayoutPayload = Schema.Struct({
  widgets: Schema.Array(DashboardWidget),
});
export type UpdateDashboardLayoutPayload = Schema.Schema.Type<typeof UpdateDashboardLayoutPayload>;

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()(
  'DashboardLayoutForbidden',
  {},
) {}

export class DashboardLayoutApiGroup extends HttpApiGroup.make('dashboardLayout')
  .add(
    HttpApiEndpoint.get('getDashboardLayout', '/teams/:teamId/dashboard-layout', {
      success: DashboardLayout,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.put('updateDashboardLayout', '/teams/:teamId/dashboard-layout', {
      success: DashboardLayout,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      payload: UpdateDashboardLayoutPayload,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  ) {}
