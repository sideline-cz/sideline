import { DashboardLayoutApi } from '@sideline/domain';

export const DEFAULT_LAYOUT: DashboardLayoutApi.DashboardLayout =
  new DashboardLayoutApi.DashboardLayout({
    widgets: DashboardLayoutApi.DASHBOARD_WIDGET_ORDER.map(
      (id) => new DashboardLayoutApi.DashboardWidget({ id, visible: true }),
    ),
  });
