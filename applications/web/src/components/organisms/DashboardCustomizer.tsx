import { DashboardLayoutApi } from '@sideline/domain';
import { LayoutDashboard } from 'lucide-react';
import React from 'react';
import type { Layout, LayoutItem } from 'react-grid-layout/legacy';
import { ReactGridLayout, WidthProvider } from 'react-grid-layout/legacy';
import { Button } from '~/components/ui/button';
import { Card, CardContent } from '~/components/ui/card';
import { Switch } from '~/components/ui/switch';
import { DEFAULT_LAYOUT } from '~/lib/dashboardLayout.js';
import { tr } from '~/lib/translations.js';

const SizedGridLayout = WidthProvider(ReactGridLayout);

const ROW_HEIGHT = 10;

interface DashboardCustomizerProps {
  teamId: string;
  layout: DashboardLayoutApi.DashboardLayout;
  /** When undefined, the Customize button is not rendered (read-only mode). */
  onSave?: (widgets: DashboardLayoutApi.DashboardWidget[]) => Promise<void>;
  widgetRegistry: Record<string, React.ReactNode>;
}

const WIDGET_LABELS: Record<string, string> = {
  stats: 'dashboard_widget_stats',
  upcomingEvents: 'dashboard_widget_upcomingEvents',
  activity: 'dashboard_widget_activity',
  teamManagement: 'dashboard_widget_teamManagement',
};

// ---------------------------------------------------------------------------
// Layout conversion helpers
// ---------------------------------------------------------------------------

function widgetsToLayout(widgets: ReadonlyArray<DashboardLayoutApi.DashboardWidget>): Layout {
  const visible = widgets.filter((w) => w.visible);
  const items: LayoutItem[] = [];
  let cursorX = 0;
  let cursorY = 0;
  for (const w of visible) {
    const itemW = Math.max(1, Math.min(12, w.colSpan * 4));
    const itemH = Math.max(1, Math.round(w.height / ROW_HEIGHT));
    if (cursorX + itemW > 12) {
      cursorX = 0;
      cursorY += 1;
    }
    items.push({ i: w.id, x: cursorX, y: cursorY, w: itemW, h: itemH });
    cursorX += itemW;
    if (cursorX >= 12) {
      cursorX = 0;
      cursorY += 1;
    }
  }
  return items;
}

function applyLayoutToWidgets(
  widgets: DashboardLayoutApi.DashboardWidget[],
  layout: Layout,
): DashboardLayoutApi.DashboardWidget[] {
  const byId = new Map(layout.map((item) => [item.i, item]));
  // Visible widgets in their new order, then hidden widgets appended in original order
  const visible = widgets
    .filter((w) => w.visible)
    .map((w) => ({ widget: w, item: byId.get(w.id) }))
    .filter(
      (entry): entry is { widget: DashboardLayoutApi.DashboardWidget; item: LayoutItem } =>
        entry.item !== undefined,
    )
    .sort((a, b) => a.item.y - b.item.y || a.item.x - b.item.x)
    .map(
      ({ widget, item }) =>
        new DashboardLayoutApi.DashboardWidget({
          id: widget.id,
          visible: true,
          height: item.h * ROW_HEIGHT,
          colSpan: Math.max(1, Math.min(3, Math.round(item.w / 4))),
        }),
    );
  const hidden = widgets.filter((w) => !w.visible);
  return [...visible, ...hidden];
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
              height: w.height,
              colSpan: w.colSpan,
            })
          : w,
      ),
    );
  };

  const resetLayout = () => {
    setWorking([...DEFAULT_LAYOUT.widgets]);
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
  // Render helpers
  // ---------------------------------------------------------------------------

  const emptyState = (
    <Card data-testid='dashboard-empty-state'>
      <CardContent className='flex flex-col items-center justify-center gap-3 py-10 text-center'>
        <LayoutDashboard className='size-8 text-muted-foreground/40' />
        <p className='text-sm text-muted-foreground'>{tr('dashboard_allWidgetsHidden')}</p>
      </CardContent>
    </Card>
  );

  const renderGrid = (widgets: DashboardLayoutApi.DashboardWidget[], isEditing: boolean) => {
    const visibleWidgets = widgets.filter((w) => w.visible);
    if (visibleWidgets.length === 0) return emptyState;

    return (
      <SizedGridLayout
        layout={widgetsToLayout(widgets)}
        cols={12}
        rowHeight={ROW_HEIGHT}
        margin={[16, 16]}
        isDraggable={isEditing}
        isResizable={isEditing}
        resizeHandles={['se']}
        draggableCancel='button, a, input, [role="switch"], select'
        onLayoutChange={(newLayout) => {
          if (isEditing) {
            setWorking((prev) => applyLayoutToWidgets(prev, newLayout));
          }
        }}
      >
        {visibleWidgets.map((w) => (
          <div key={w.id} className='rounded-lg'>
            {widgetRegistry[w.id]}
          </div>
        ))}
      </SizedGridLayout>
    );
  };

  // ---------------------------------------------------------------------------
  // Idle mode
  // ---------------------------------------------------------------------------

  if (!editMode) {
    return (
      <div className='flex flex-col gap-4'>
        {onSave !== undefined && (
          <div className='flex justify-end'>
            <Button variant='outline' size='sm' onClick={enterEditMode}>
              {tr('dashboard_customize')}
            </Button>
          </div>
        )}
        {allHidden ? emptyState : renderGrid(activeWidgets, false)}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Edit mode: grid + aside panel side-by-side (stacked on mobile)
  // ---------------------------------------------------------------------------

  return (
    <div className='flex flex-col gap-6 lg:flex-row'>
      {/* Grid area */}
      <div className='flex-1 min-w-0 dashboard-grid-editing'>{renderGrid(working, true)}</div>

      {/* Aside panel */}
      <aside className='lg:w-64 flex flex-col gap-4 rounded-lg border bg-card p-4'>
        <h2 className='font-semibold text-sm'>{tr('dashboard_customizer_panelTitle')}</h2>
        <div className='flex flex-col gap-4'>
          {working.map((widget) => {
            const widgetName = tr(WIDGET_LABELS[widget.id] ?? widget.id);
            return (
              <div key={widget.id} className='flex flex-col gap-1'>
                <div className='flex items-center gap-2 justify-between'>
                  <span className='text-sm'>{widgetName}</span>
                  <Switch
                    checked={widget.visible}
                    onCheckedChange={() => toggleVisible(widget.id)}
                  />
                </div>
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
