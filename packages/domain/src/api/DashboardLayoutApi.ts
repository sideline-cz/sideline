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
  x: Schema.Number,
  y: Schema.Number,
  w: Schema.Number,
  h: Schema.Number,
}) {}

export interface DefaultLayoutEntry {
  id: DashboardWidgetId;
  visible: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

// 12-column grid defaults (rowHeight=10px, margin=[16,16])
// stats:          h=14 → ~140px  (4 stat tiles)
// upcomingEvents: h=28 → ~280px  (event list)
// activity:       h=20 → ~200px  (3 detail rows)
// teamManagement: h=26 → ~260px  (8 nav links)
export const DEFAULT_LAYOUT: ReadonlyArray<DefaultLayoutEntry> = [
  { id: 'stats', visible: true, x: 0, y: 0, w: 12, h: 14 },
  { id: 'upcomingEvents', visible: true, x: 0, y: 14, w: 8, h: 28 },
  { id: 'activity', visible: true, x: 8, y: 14, w: 4, h: 20 },
  { id: 'teamManagement', visible: true, x: 8, y: 34, w: 4, h: 26 },
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
