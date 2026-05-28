import type { DragEndEvent } from '@dnd-kit/core';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DashboardLayoutApi } from '@sideline/domain';
import { GripVertical, LayoutDashboard } from 'lucide-react';
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

/** Map a colSpan value (1–3) to the corresponding Tailwind col-span class. */
const colSpanClass = (colSpan: number): string => {
  if (colSpan >= 3) return 'lg:col-span-3';
  if (colSpan === 2) return 'lg:col-span-2';
  return 'lg:col-span-1';
};

// ---------------------------------------------------------------------------
// SortableWidgetCell — wraps a single grid cell with dnd-kit sortable hooks
// ---------------------------------------------------------------------------

interface SortableWidgetCellProps {
  widget: DashboardLayoutApi.DashboardWidget;
  isEditing: boolean;
  onHeightChange: (height: number) => void;
  children: React.ReactNode;
}

function SortableWidgetCell({
  widget,
  isEditing,
  onHeightChange,
  children,
}: SortableWidgetCellProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const widgetName = tr(WIDGET_LABELS[widget.id] ?? widget.id);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } =
    useSortable({ id: widget.id });

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

  const style: React.CSSProperties = isEditing
    ? {
        transform: CSS.Transform.toString(transform),
        transition,
      }
    : {};

  return (
    <div
      ref={isEditing ? setNodeRef : undefined}
      style={style}
      className={colSpanClass(widget.colSpan)}
    >
      <div
        ref={containerRef}
        style={{
          height: `${widget.height}px`,
          overflow: 'hidden',
          resize: isEditing ? 'vertical' : 'none',
        }}
        className={`relative w-full h-full ${isEditing ? 'dashboard-resizable' : ''}`}
      >
        {isEditing && (
          <button
            type='button'
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={tr('dashboard_customizer_dragHandle', { widget: widgetName })}
            className='dashboard-drag-handle absolute top-2 left-2 z-10 inline-flex items-center justify-center size-7 rounded-md bg-primary text-primary-foreground shadow cursor-grab active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-ring'
          >
            <GripVertical className='size-4' />
          </button>
        )}
        {children}
      </div>
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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

  const handleHeightChange = (id: string, height: number) => {
    setWorking((prev) =>
      prev.map((w) =>
        w.id === id
          ? new DashboardLayoutApi.DashboardWidget({
              id: w.id,
              visible: w.visible,
              height,
              colSpan: w.colSpan,
            })
          : w,
      ),
    );
  };

  const handleColSpanChange = (id: string, colSpan: number) => {
    setWorking((prev) =>
      prev.map((w) =>
        w.id === id
          ? new DashboardLayoutApi.DashboardWidget({
              id: w.id,
              visible: w.visible,
              height: w.height,
              colSpan,
            })
          : w,
      ),
    );
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    setWorking((prev) => {
      const oldIndex = prev.findIndex((w) => w.id === active.id);
      const newIndex = prev.findIndex((w) => w.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
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

    const visibleIds = visibleWidgets.map((w) => w.id);

    const gridContent = (
      <div className='grid grid-cols-1 lg:grid-cols-3 gap-6'>
        {visibleWidgets.map((w) => (
          <SortableWidgetCell
            key={w.id}
            widget={w}
            isEditing={isEditing}
            onHeightChange={(h) => handleHeightChange(w.id, h)}
          >
            {widgetRegistry[w.id]}
          </SortableWidgetCell>
        ))}
      </div>
    );

    if (!isEditing) return gridContent;

    return (
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={visibleIds} strategy={rectSortingStrategy}>
          {gridContent}
        </SortableContext>
      </DndContext>
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
                <ToggleGroup
                  type='single'
                  value={String(widget.colSpan)}
                  onValueChange={(val) => {
                    if (val) handleColSpanChange(widget.id, Number(val));
                  }}
                  size='sm'
                  variant='outline'
                  aria-label={tr('dashboard_customizer_widthFor', { widget: widgetName })}
                >
                  <ToggleGroupItem value='1' aria-label={tr('dashboard_customizer_widthOption1')}>
                    {tr('dashboard_customizer_widthOption1')}
                  </ToggleGroupItem>
                  <ToggleGroupItem value='2' aria-label={tr('dashboard_customizer_widthOption2')}>
                    {tr('dashboard_customizer_widthOption2')}
                  </ToggleGroupItem>
                  <ToggleGroupItem value='3' aria-label={tr('dashboard_customizer_widthOption3')}>
                    {tr('dashboard_customizer_widthOption3')}
                  </ToggleGroupItem>
                </ToggleGroup>
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
