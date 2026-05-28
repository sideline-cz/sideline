import { DashboardLayoutApi } from '@sideline/domain';

export const DEFAULT_LAYOUT: DashboardLayoutApi.DashboardLayout =
  new DashboardLayoutApi.DashboardLayout({
    widgets: DashboardLayoutApi.DEFAULT_LAYOUT.map(
      (entry) =>
        new DashboardLayoutApi.DashboardWidget({
          id: entry.id,
          visible: entry.visible,
          x: entry.x,
          y: entry.y,
          w: entry.w,
          h: entry.h,
        }),
    ),
  });
