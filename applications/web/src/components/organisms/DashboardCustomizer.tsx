import { DashboardLayoutApi } from '@sideline/domain';
import React from 'react';
import type { Layout, LayoutItem } from 'react-grid-layout';
import { GridLayout, useContainerWidth } from 'react-grid-layout';
import { Button } from '~/components/ui/button';
import { Switch } from '~/components/ui/switch';
import { DEFAULT_LAYOUT } from '~/lib/dashboardLayout.js';
import { tr } from '~/lib/translations.js';

interface DashboardCustomizerProps {
  teamId: string;
  layout: DashboardLayoutApi.DashboardLayout;
  onSave: (widgets: DashboardLayoutApi.DashboardWidget[]) => Promise<void>;
  widgetRegistry: Record<string, React.ReactNode>;
}

const WIDGET_LABELS: Record<string, string> = {
  stats: 'dashboard_widget_stats',
  upcomingEvents: 'dashboard_widget_upcomingEvents',
  activity: 'dashboard_widget_activity',
  teamManagement: 'dashboard_widget_teamManagement',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function widgetsToLayout(widgets: ReadonlyArray<DashboardLayoutApi.DashboardWidget>): Layout {
  return widgets.map((w) => ({
    i: w.id,
    x: w.x,
    y: w.y,
    w: w.w,
    h: w.h,
  }));
}

function mergeLayoutIntoWidgets(
  widgets: DashboardLayoutApi.DashboardWidget[],
  layout: Layout,
): DashboardLayoutApi.DashboardWidget[] {
  const byId = new Map<string, LayoutItem>(layout.map((item) => [item.i, item]));
  return widgets.map((w) => {
    const item = byId.get(w.id);
    if (!item) return w;
    return new DashboardLayoutApi.DashboardWidget({
      id: w.id,
      visible: w.visible,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
    });
  });
}

// ---------------------------------------------------------------------------
// Grid renderer (shared between edit and view modes)
// ---------------------------------------------------------------------------

interface DashboardGridProps {
  working: DashboardLayoutApi.DashboardWidget[];
  widgetRegistry: Record<string, React.ReactNode>;
  isEditing: boolean;
  onLayoutChange: (layout: Layout) => void;
}

function DashboardGrid({ working, widgetRegistry, isEditing, onLayoutChange }: DashboardGridProps) {
  const { width, containerRef, mounted } = useContainerWidth();
  const rglLayout = widgetsToLayout(working.filter((w) => w.visible));

  return (
    <div ref={containerRef} className='w-full'>
      {mounted && (
        <GridLayout
          layout={rglLayout}
          width={width}
          gridConfig={{ cols: 12, rowHeight: 80 }}
          dragConfig={{ enabled: isEditing, bounded: false, threshold: 3 }}
          resizeConfig={{ enabled: isEditing, handles: ['se'] }}
          onLayoutChange={onLayoutChange}
          className={isEditing ? 'rgl-edit-mode' : undefined}
        >
          {working
            .filter((w) => w.visible)
            .map((w) => (
              <div key={w.id}>{widgetRegistry[w.id]}</div>
            ))}
        </GridLayout>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DashboardCustomizer({ layout, onSave, widgetRegistry }: DashboardCustomizerProps) {
  const [editMode, setEditMode] = React.useState(false);
  const [working, setWorking] = React.useState<DashboardLayoutApi.DashboardWidget[]>([]);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const allHidden = editMode
    ? working.every((w) => !w.visible)
    : layout.widgets.every((w) => !w.visible);

  const enterEditMode = () => {
    setWorking([...layout.widgets]);
    setSaveError(null);
    setEditMode(true);
  };

  const cancelEditMode = () => {
    setEditMode(false);
    setSaveError(null);
  };

  const toggleVisible = (id: string) => {
    setWorking((prev) =>
      prev.map((w) =>
        w.id === id
          ? new DashboardLayoutApi.DashboardWidget({
              id: w.id,
              visible: !w.visible,
              x: w.x,
              y: w.y,
              w: w.w,
              h: w.h,
            })
          : w,
      ),
    );
  };

  const resetLayout = () => {
    setWorking([...DEFAULT_LAYOUT.widgets]);
  };

  const handleLayoutChange = (newLayout: Layout) => {
    setWorking((prev) => mergeLayoutIntoWidgets(prev, newLayout));
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(working);
      setEditMode(false);
    } catch {
      setSaveError(tr('dashboard_customizer_saveError'));
    } finally {
      setSaving(false);
    }
  };

  if (!editMode) {
    return (
      <Button variant='outline' size='sm' onClick={enterEditMode}>
        {tr('dashboard_customize')}
      </Button>
    );
  }

  return (
    <div className='flex flex-col gap-6 lg:flex-row'>
      {/* Grid area */}
      <div className='flex-1 min-w-0'>
        {allHidden ? (
          <div className='flex items-center justify-center py-10 text-sm text-muted-foreground'>
            {tr('dashboard_allWidgetsHidden')}
          </div>
        ) : (
          <DashboardGrid
            working={working}
            widgetRegistry={widgetRegistry}
            isEditing={true}
            onLayoutChange={handleLayoutChange}
          />
        )}
      </div>

      {/* Aside panel */}
      <aside className='lg:w-56 flex flex-col gap-4 rounded-lg border bg-card p-4'>
        <h2 className='font-semibold text-sm'>{tr('dashboard_customizer_panelTitle')}</h2>
        <div className='flex flex-col gap-3'>
          {working.map((widget) => {
            const widgetName = tr(WIDGET_LABELS[widget.id] ?? widget.id);
            return (
              <div key={widget.id} className='flex items-center gap-2 justify-between'>
                <span className='text-sm'>{widgetName}</span>
                <Switch checked={widget.visible} onCheckedChange={() => toggleVisible(widget.id)} />
              </div>
            );
          })}
        </div>
        <div className='flex flex-col gap-2'>
          <Button variant='outline' size='sm' onClick={resetLayout}>
            {tr('dashboard_customizer_reset')}
          </Button>
          <Button variant='outline' size='sm' onClick={cancelEditMode}>
            {tr('dashboard_customizer_cancel')}
          </Button>
          <Button size='sm' onClick={handleSave} disabled={saving}>
            {tr('dashboard_customizer_save')}
          </Button>
        </div>
        {saveError && <p className='text-sm text-destructive'>{saveError}</p>}
      </aside>
    </div>
  );
}
