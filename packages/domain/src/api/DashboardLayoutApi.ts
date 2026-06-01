import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { TeamId } from '~/models/Team.js';

export const DashboardWidgetId = Schema.Literals([
  'awaitingRsvp',
  'outstandingPayments',
  'stats',
  'upcomingEvents',
  'activity',
  'teamManagement',
]);
export type DashboardWidgetId = typeof DashboardWidgetId.Type;

export const DASHBOARD_WIDGET_ORDER = [
  'awaitingRsvp',
  'outstandingPayments',
  'stats',
  'upcomingEvents',
  'activity',
  'teamManagement',
] as const;

export class DashboardWidget extends Schema.Class<DashboardWidget>('DashboardWidget')({
  id: DashboardWidgetId,
  visible: Schema.Boolean,
  height: Schema.Number,
  colSpan: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
  x: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  y: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
}) {}

export interface DefaultLayoutEntry {
  id: DashboardWidgetId;
  visible: boolean;
  height: number;
  colSpan: number;
  x: number;
  y: number;
}

// Explicit grid positions (1-indexed CSS grid column lines, 1-indexed rows).
// awaitingRsvp:        x=1,  y=1,  colSpan=3 — full width (3×4=12 cols), row 1
// outstandingPayments: x=1,  y=2,  colSpan=3 — full width, row 2
// stats:               x=1,  y=3,  colSpan=3 — full width, row 3
// upcomingEvents:      x=1,  y=4,  colSpan=2 — cols 1-8, row 4
// activity:            x=9,  y=4,  colSpan=1 — cols 9-12, row 4
// teamManagement:      x=9,  y=5,  colSpan=1 — cols 9-12, row 5
export const DEFAULT_LAYOUT: ReadonlyArray<DefaultLayoutEntry> = [
  { id: 'awaitingRsvp', visible: true, height: 80, colSpan: 3, x: 1, y: 1 },
  { id: 'outstandingPayments', visible: true, height: 80, colSpan: 3, x: 1, y: 2 },
  { id: 'stats', visible: true, height: 140, colSpan: 3, x: 1, y: 3 },
  { id: 'upcomingEvents', visible: true, height: 280, colSpan: 2, x: 1, y: 4 },
  { id: 'activity', visible: true, height: 200, colSpan: 1, x: 9, y: 4 },
  { id: 'teamManagement', visible: true, height: 260, colSpan: 1, x: 9, y: 5 },
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
