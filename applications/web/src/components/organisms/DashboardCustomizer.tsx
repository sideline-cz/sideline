import { DashboardLayoutApi } from '@sideline/domain';
import { LayoutDashboard } from 'lucide-react';
import React from 'react';
import { Button } from '~/components/ui/button';
import { Card, CardContent } from '~/components/ui/card';
import { Switch } from '~/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group';
import { DEFAULT_LAYOUT } from '~/lib/dashboardLayout.js';
import { tr } from '~/lib/translations.js';

interface DashboardCustomizerProps {
  teamId: string;
  layout: DashboardLayoutApi.DashboardLayout;
  /** When undefined, edit mode cannot be entered (read-only mode). */
  onSave?: (widgets: DashboardLayoutApi.DashboardWidget[]) => Promise<void>;
  /**
   * A null entry means the widget has no data to display right now.
   * Null-entry widgets are excluded from the CSS grid (no empty rectangle),
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
// Explicit grid position computation (no packing algorithm)
// ---------------------------------------------------------------------------

type RenderedWidget = {
  widget: DashboardLayoutApi.DashboardWidget;
  colStart: number; // 1..12
  colSpanCols: number; // 4, 8, or 12
  row: number; // 1..N (compacted)
};

function renderableWidgets(
  widgets: ReadonlyArray<DashboardLayoutApi.DashboardWidget>,
  widgetRegistry: Record<string, React.ReactNode | null>,
): Array<RenderedWidget> {
  const visible = widgets.filter((w) => w.visible && widgetRegistry[w.id] != null);
  // Renumber rows so empty rows collapse: collect distinct y values among visible widgets,
  // sort ascending, map each to a sequential row index (1, 2, 3, ...).
  const usedY = Array.from(new Set(visible.map((w) => w.y))).sort((a, b) => a - b);
  const yMap = new Map(usedY.map((y, i) => [y, i + 1]));
  return visible.map((w) => ({
    widget: w,
    colStart: Math.max(1, Math.min(12, w.x)),
    colSpanCols: Math.max(1, Math.min(12, w.colSpan * 4)),
    row: yMap.get(w.y) ?? 1,
  }));
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
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // When edit mode is turned ON by the parent, snapshot the current layout once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot-on-enter is the design
  React.useEffect(() => {
    if (editMode) {
      setWorking([...layout.widgets]);
      setSaveError(null);
    }
  }, [editMode]);

  const toggleVisible = (id: string) => {
    setWorking((prev) =>
      prev.map((w) =>
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
      ),
    );
  };

  const handleColSpanChange = (id: string, colSpan: 1 | 2 | 3) => {
    setWorking((prev) =>
      prev.map((w) =>
        w.id === id
          ? new DashboardLayoutApi.DashboardWidget({
              id: w.id,
              visible: w.visible,
              colSpan,
              height: w.height,
              x: w.x,
              y: w.y,
            })
          : w,
      ),
    );
  };

  const handleXChange = (id: string, x: number) => {
    setWorking((prev) =>
      prev.map((w) =>
        w.id === id
          ? new DashboardLayoutApi.DashboardWidget({
              id: w.id,
              visible: w.visible,
              colSpan: w.colSpan,
              height: w.height,
              x: Math.max(1, Math.min(12, x)),
              y: w.y,
            })
          : w,
      ),
    );
  };

  const handleYChange = (id: string, y: number) => {
    setWorking((prev) =>
      prev.map((w) =>
        w.id === id
          ? new DashboardLayoutApi.DashboardWidget({
              id: w.id,
              visible: w.visible,
              colSpan: w.colSpan,
              height: w.height,
              x: w.x,
              y: Math.max(1, Math.min(999, y)),
            })
          : w,
      ),
    );
  };

  const resetLayout = () => {
    setWorking([...DEFAULT_LAYOUT.widgets]);
  };

  const cancelEditMode = () => {
    onEditModeChange(false);
    setSaveError(null);
  };

  const handleSave = async () => {
    if (onSave === undefined) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(working);
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

  const activeWidgets = editMode ? working : [...layout.widgets];

  const emptyState = (
    <Card data-testid='dashboard-empty-state'>
      <CardContent className='flex flex-col items-center justify-center gap-3 py-10 text-center'>
        <LayoutDashboard className='size-8 text-muted-foreground/40' />
        <p className='text-sm text-muted-foreground'>{tr('dashboard_allWidgetsHidden')}</p>
      </CardContent>
    </Card>
  );

  const renderGrid = (widgets: DashboardLayoutApi.DashboardWidget[]) => {
    const rendered = renderableWidgets(widgets, widgetRegistry);
    if (rendered.length === 0) return emptyState;

    return (
      <div className='grid grid-cols-1 lg:grid-cols-12 gap-4'>
        {rendered.map((pos) => {
          const style = {
            '--dash-col-start': pos.colStart,
            '--dash-col-end': pos.colStart + pos.colSpanCols,
            '--dash-row-start': pos.row,
          } as React.CSSProperties;
          return (
            <div
              key={pos.widget.id}
              style={style}
              className={`dashboard-grid-item${editMode ? ' rounded-lg outline outline-1 outline-dashed outline-primary outline-offset-[-2px]' : ''}`}
            >
              {widgetRegistry[pos.widget.id]}
            </div>
          );
        })}
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Idle mode
  // ---------------------------------------------------------------------------

  if (!editMode) {
    return <div className='flex flex-col gap-4'>{renderGrid(activeWidgets)}</div>;
  }

  // ---------------------------------------------------------------------------
  // Edit mode: grid + aside panel side-by-side (stacked on mobile)
  // ---------------------------------------------------------------------------

  return (
    <div className='flex flex-col gap-6 lg:flex-row'>
      {/* Grid area */}
      <div className='flex-1 min-w-0'>{renderGrid(working)}</div>

      {/* Aside panel */}
      <aside className='lg:w-64 flex flex-col gap-4 rounded-lg border bg-card p-4'>
        <h2 className='font-semibold text-sm'>{tr('dashboard_customizer_panelTitle')}</h2>
        <div className='flex flex-col gap-4'>
          {working.map((widget) => {
            const widgetName = tr(WIDGET_LABELS[widget.id] ?? widget.id);
            return (
              <div key={widget.id} className='flex flex-col gap-2'>
                <div className='flex items-center gap-2 justify-between'>
                  <span className='text-sm'>{widgetName}</span>
                  <Switch
                    checked={widget.visible}
                    onCheckedChange={() => toggleVisible(widget.id)}
                  />
                </div>
                {widget.visible && (
                  <>
                    {/* Row number input */}
                    <div className='flex items-center gap-2'>
                      <label
                        htmlFor={`dashboard-row-${widget.id}`}
                        className='text-xs text-muted-foreground shrink-0'
                      >
                        {tr('dashboard_customizer_rowFor', { widget: widgetName })}
                      </label>
                      <input
                        id={`dashboard-row-${widget.id}`}
                        type='number'
                        min={1}
                        max={20}
                        value={widget.y}
                        onChange={(e) => {
                          const val = Number.parseInt(e.target.value, 10);
                          if (!Number.isNaN(val)) handleYChange(widget.id, val);
                        }}
                        className='w-16 rounded-md border bg-background px-2 py-1 text-xs'
                      />
                    </div>
                    {/* Column segmented control */}
                    <ToggleGroup
                      type='single'
                      value={String(widget.x)}
                      onValueChange={(val) => {
                        const num = Number.parseInt(val, 10);
                        if (val === '1' || val === '5' || val === '9') {
                          handleXChange(widget.id, num);
                        }
                      }}
                      aria-label={tr('dashboard_customizer_columnFor', { widget: widgetName })}
                      className='justify-start'
                      size='sm'
                    >
                      <ToggleGroupItem value='1' aria-label='1'>
                        1
                      </ToggleGroupItem>
                      <ToggleGroupItem value='5' aria-label='5'>
                        5
                      </ToggleGroupItem>
                      <ToggleGroupItem value='9' aria-label='9'>
                        9
                      </ToggleGroupItem>
                    </ToggleGroup>
                    {/* Width segmented control */}
                    <ToggleGroup
                      type='single'
                      value={String(widget.colSpan)}
                      onValueChange={(val) => {
                        if (val === '1' || val === '2' || val === '3') {
                          handleColSpanChange(widget.id, Number(val) as 1 | 2 | 3);
                        }
                      }}
                      aria-label={tr('dashboard_customizer_widthFor', { widget: widgetName })}
                      className='justify-start'
                      size='sm'
                    >
                      <ToggleGroupItem
                        value='1'
                        aria-label={tr('dashboard_customizer_widthOption1')}
                      >
                        {tr('dashboard_customizer_widthOption1')}
                      </ToggleGroupItem>
                      <ToggleGroupItem
                        value='2'
                        aria-label={tr('dashboard_customizer_widthOption2')}
                      >
                        {tr('dashboard_customizer_widthOption2')}
                      </ToggleGroupItem>
                      <ToggleGroupItem
                        value='3'
                        aria-label={tr('dashboard_customizer_widthOption3')}
                      >
                        {tr('dashboard_customizer_widthOption3')}
                      </ToggleGroupItem>
                    </ToggleGroup>
                  </>
                )}
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
