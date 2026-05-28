import { DashboardLayoutApi } from '@sideline/domain';
import { LayoutDashboard } from 'lucide-react';
import React from 'react';
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

const WIDGET_LABELS: Record<string, string> = {
  stats: 'dashboard_widget_stats',
  upcomingEvents: 'dashboard_widget_upcomingEvents',
  activity: 'dashboard_widget_activity',
  teamManagement: 'dashboard_widget_teamManagement',
};

// Grid span classes per widget id
const WIDGET_SPAN: Record<DashboardLayoutApi.DashboardWidgetId, string> = {
  stats: 'lg:col-span-3',
  upcomingEvents: 'lg:col-span-2',
  activity: 'lg:col-span-1',
  teamManagement: 'lg:col-span-1',
};

// ---------------------------------------------------------------------------
// ResizableWidgetContainer
// ---------------------------------------------------------------------------

interface ResizableWidgetContainerProps {
  widget: DashboardLayoutApi.DashboardWidget;
  isEditing: boolean;
  onHeightChange: (height: number) => void;
  children: React.ReactNode;
}

function ResizableWidgetContainer({
  widget,
  isEditing,
  onHeightChange,
  children,
}: ResizableWidgetContainerProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!isEditing) return;
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) onHeightChange(h);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [isEditing, onHeightChange]);

  return (
    <div
      ref={containerRef}
      style={{
        height: `${widget.height}px`,
        overflow: 'hidden',
        resize: isEditing ? 'vertical' : 'none',
      }}
      className={`w-full h-full ${isEditing ? 'dashboard-resizable' : ''}`}
    >
      {children}
    </div>
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
            })
          : w,
      ),
    );
  };

  const handleHeightChange = (id: string, height: number) => {
    setWorking((prev) =>
      prev.map((w) =>
        w.id === id
          ? new DashboardLayoutApi.DashboardWidget({ id: w.id, visible: w.visible, height })
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
      <div className='grid grid-cols-1 lg:grid-cols-3 gap-6'>
        {visibleWidgets.map((w) => (
          <div key={w.id} className={WIDGET_SPAN[w.id]}>
            <ResizableWidgetContainer
              widget={w}
              isEditing={isEditing}
              onHeightChange={(h) => handleHeightChange(w.id, h)}
            >
              {widgetRegistry[w.id]}
            </ResizableWidgetContainer>
          </div>
        ))}
      </div>
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
      <div className='flex-1 min-w-0'>{renderGrid(working, true)}</div>

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
