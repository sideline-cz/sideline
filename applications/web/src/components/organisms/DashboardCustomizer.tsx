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
  /** When undefined, edit mode cannot be entered (read-only mode). */
  onSave?: (widgets: DashboardLayoutApi.DashboardWidget[]) => Promise<void>;
  /**
   * A null entry means the widget has no data to display right now.
   * Null-entry widgets are excluded from the RGL grid (no empty rectangle),
   * but their toggles remain visible in the edit-mode aside panel.
   */
  widgetRegistry: Record<string, React.ReactNode | null>;
  /** Controlled edit mode — owned by the parent (TeamDetailPage). */
  editMode: boolean;
  onEditModeChange: (next: boolean) => void;
}

const WIDGET_LABELS: Record<string, string> = {
  awaitingRsvp: 'dashboard_widget_awaitingRsvp',
  outstandingPayments: 'dashboard_widget_outstandingPayments',
  stats: 'dashboard_widget_stats',
  upcomingEvents: 'dashboard_widget_upcomingEvents',
  activity: 'dashboard_widget_activity',
  teamManagement: 'dashboard_widget_teamManagement',
};

// ---------------------------------------------------------------------------
// Layout conversion helpers
// ---------------------------------------------------------------------------

function widgetsToLayout(widgets: ReadonlyArray<DashboardLayoutApi.DashboardWidget>): Layout {
  return widgets
    .filter((w) => w.visible)
    .map((w) => ({
      i: w.id,
      x: w.x,
      y: w.y,
      w: Math.max(1, Math.min(12, w.colSpan * 4)),
      h: Math.max(1, Math.round(w.height / ROW_HEIGHT)),
      // Allow widgets to shrink down to a single grid row. Without explicit
      // minH/minW, RGL falls back to internal defaults that can refuse very
      // small heights and bounce the user's drag back to a larger size.
      minH: 1,
      minW: 1,
    }));
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
          x: item.x,
          y: item.y,
          height: item.h * ROW_HEIGHT,
          colSpan: Math.max(1, Math.min(3, Math.round(item.w / 4))),
        }),
    );
  const hidden = widgets.filter((w) => !w.visible);
  return [...visible, ...hidden];
}

// ---------------------------------------------------------------------------
// Main component — owns the configurable grid region
// ---------------------------------------------------------------------------

export function DashboardCustomizer({
  layout,
  onSave = undefined,
  widgetRegistry,
  editMode,
  onEditModeChange,
}: DashboardCustomizerProps) {
  const [working, setWorking] = React.useState<DashboardLayoutApi.DashboardWidget[]>([]);
  const [editLayout, setEditLayout] = React.useState<Layout>([]);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // When edit mode is turned ON by the parent, snapshot the current layout once.
  // We intentionally do NOT re-run when `layout.widgets` changes — the parent re-renders
  // with a fresh array reference on every render, and re-snapshotting would discard the
  // user's in-progress drag/resize edits on every keystroke.
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot-on-enter is the design
  React.useEffect(() => {
    if (editMode) {
      setWorking([...layout.widgets]);
      setEditLayout(widgetsToLayout(layout.widgets));
      setSaveError(null);
    }
  }, [editMode]);

  const activeWidgets = editMode ? working : [...layout.widgets];
  const allHidden = activeWidgets.every((w) => !w.visible);

  const cancelEditMode = () => {
    onEditModeChange(false);
    setSaveError(null);
  };

  const toggleVisible = (id: string) => {
    setWorking((prev) => {
      const widget = prev.find((w) => w.id === id);
      if (!widget) return prev;
      return prev.map((w) =>
        w.id === id
          ? new DashboardLayoutApi.DashboardWidget({
              id: w.id,
              visible: !w.visible,
              height: w.height,
              colSpan: w.colSpan,
              x: w.x,
              y: w.y,
            })
          : w,
      );
    });
    setEditLayout((prev) => {
      const widget = working.find((w) => w.id === id);
      if (!widget) return prev;
      // Currently visible → becoming hidden → drop from layout
      if (widget.visible) return prev.filter((item) => item.i !== id);
      // Currently hidden → becoming visible → restore stored x/y
      const itemW = Math.max(1, Math.min(12, widget.colSpan * 4));
      const itemH = Math.max(1, Math.round(widget.height / ROW_HEIGHT));
      return [...prev, { i: id, x: widget.x, y: widget.y, w: itemW, h: itemH }];
    });
  };

  const resetLayout = () => {
    setWorking([...DEFAULT_LAYOUT.widgets]);
    setEditLayout(widgetsToLayout(DEFAULT_LAYOUT.widgets));
  };

  const handleSave = async () => {
    if (onSave === undefined) return;
    setSaving(true);
    setSaveError(null);
    // Use editLayout (RGL's authoritative positions) when computing the final widgets
    const finalWidgets = applyLayoutToWidgets(working, editLayout);
    try {
      await onSave(finalWidgets);
      onEditModeChange(false);
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
    // Also exclude widgets whose registry entry is null (no data to display)
    const renderableWidgets = visibleWidgets.filter((w) => widgetRegistry[w.id] != null);
    if (renderableWidgets.length === 0) return emptyState;

    return (
      <SizedGridLayout
        layout={
          isEditing
            ? editLayout.filter((item) => renderableWidgets.some((w) => w.id === item.i))
            : widgetsToLayout(renderableWidgets)
        }
        cols={12}
        rowHeight={ROW_HEIGHT}
        margin={[12, 12]}
        isDraggable={isEditing}
        isResizable={isEditing}
        resizeHandles={['se']}
        compactType='vertical'
        preventCollision={false}
        // useCSSTransforms=false makes RGL use top/left + width/height absolute
        // positioning instead of CSS transforms. This eliminates a sizing
        // interaction where transforms can bypass explicit height constraints,
        // causing widgets to expand beyond their configured grid slot.
        useCSSTransforms={false}
        draggableCancel='button, a, input, [role="switch"], select'
        // Only commit the layout on drag/resize STOP — not on every intermediate
        // RGL re-compute. The continuous `onLayoutChange` ticks during a drag
        // were re-flowing the prop and snapping the user's size back.
        onDragStop={(newLayout) => {
          if (isEditing) setEditLayout(newLayout);
        }}
        onResizeStop={(newLayout) => {
          if (isEditing) setEditLayout(newLayout);
        }}
      >
        {renderableWidgets.map((w) => (
          <div
            key={w.id}
            style={{
              height: '100%',
              width: '100%',
              minHeight: 0,
              minWidth: 0,
              overflow: 'hidden',
              boxSizing: 'border-box',
              borderRadius: 'var(--radius)',
            }}
          >
            <div style={{ height: '100%', width: '100%', minHeight: 0, overflow: 'hidden' }}>
              {widgetRegistry[w.id]}
            </div>
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
