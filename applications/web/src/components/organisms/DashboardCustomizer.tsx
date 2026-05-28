import { DashboardLayoutApi } from '@sideline/domain';
import { LayoutDashboard } from 'lucide-react';
import React from 'react';
import {
  type Layout,
  type LayoutItem,
  ReactGridLayout,
  WidthProvider,
} from 'react-grid-layout/legacy';
import { Button } from '~/components/ui/button';
import { Card, CardContent } from '~/components/ui/card';
import { Switch } from '~/components/ui/switch';
import { DEFAULT_LAYOUT } from '~/lib/dashboardLayout.js';
import { tr } from '~/lib/translations.js';

interface DashboardCustomizerProps {
  teamId: string;
  layout: DashboardLayoutApi.DashboardLayout;
  /** When undefined, the Customize button is not rendered (read-only mode). */
  onSave?: (widgets: DashboardLayoutApi.DashboardWidget[]) => Promise<void>;
  widgetRegistry: Record<string, React.ReactNode>;
}

const SizedGridLayout = WidthProvider(ReactGridLayout);

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
  const rglLayout = widgetsToLayout(working.filter((w) => w.visible));

  return (
    <SizedGridLayout
      layout={rglLayout}
      cols={12}
      rowHeight={80}
      margin={[16, 16]}
      isDraggable={isEditing}
      isResizable={isEditing}
      resizeHandles={['se']}
      onLayoutChange={onLayoutChange}
      className={isEditing ? 'rgl-edit-mode' : undefined}
      draggableCancel='button, a, input, [role="switch"]'
    >
      {working
        .filter((w) => w.visible)
        .map((w) => (
          <div key={w.id}>{widgetRegistry[w.id]}</div>
        ))}
    </SizedGridLayout>
  );
}

// ---------------------------------------------------------------------------
// Main component — owns the full configurable region
// ---------------------------------------------------------------------------

export function DashboardCustomizer({
  layout,
  onSave = undefined,
  widgetRegistry,
}: DashboardCustomizerProps) {
  const [editMode, setEditMode] = React.useState(false);
  const [working, setWorking] = React.useState<DashboardLayoutApi.DashboardWidget[]>([]);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // Visible widgets derived from the appropriate source
  const activeWidgets = editMode ? working : [...layout.widgets];
  const allHidden = activeWidgets.every((w) => !w.visible);

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
    if (onSave === undefined) return;
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

  // ---------------------------------------------------------------------------
  // Render: configurable region wrapper
  // ---------------------------------------------------------------------------

  const emptyState = (
    <Card data-testid='dashboard-empty-state'>
      <CardContent className='flex flex-col items-center justify-center gap-3 py-10 text-center'>
        <LayoutDashboard className='size-8 text-muted-foreground/40' />
        <p className='text-sm text-muted-foreground'>{tr('dashboard_allWidgetsHidden')}</p>
      </CardContent>
    </Card>
  );

  if (!editMode) {
    return (
      <div className='flex flex-col gap-4'>
        {/* Customize entry point — only shown when editing is allowed */}
        {onSave !== undefined && (
          <div className='flex justify-end'>
            <Button variant='outline' size='sm' onClick={enterEditMode}>
              {tr('dashboard_customize')}
            </Button>
          </div>
        )}

        {/* Read-only grid or empty state */}
        {allHidden ? (
          emptyState
        ) : (
          <DashboardGrid
            working={activeWidgets as DashboardLayoutApi.DashboardWidget[]}
            widgetRegistry={widgetRegistry}
            isEditing={false}
            onLayoutChange={() => {
              /* read-only: no-op */
            }}
          />
        )}
      </div>
    );
  }

  // Edit mode: grid + aside panel side-by-side (stacked on mobile)
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
      <aside className='lg:w-64 flex flex-col gap-4 rounded-lg border bg-card p-4'>
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
