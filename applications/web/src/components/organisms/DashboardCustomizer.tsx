import {
  closestCenter,
  DndContext,
  type DragEndEvent,
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
// CSS Grid column helpers
// ---------------------------------------------------------------------------

function colSpanClass(c: number): string {
  if (c >= 3) return 'lg:col-span-12';
  if (c === 2) return 'lg:col-span-8';
  return 'lg:col-span-4';
}

// ---------------------------------------------------------------------------
// Sortable widget wrapper
// ---------------------------------------------------------------------------

function SortableWidget({
  widget,
  isEditing,
  registryNode,
}: {
  widget: DashboardLayoutApi.DashboardWidget;
  isEditing: boolean;
  registryNode: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: widget.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  const widgetName = tr(WIDGET_LABELS[widget.id] ?? widget.id);

  return (
    <div ref={setNodeRef} style={style} className={`${colSpanClass(widget.colSpan)} relative`}>
      {isEditing && (
        <button
          type='button'
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={tr('dashboard_customizer_dragHandle', { widget: widgetName })}
          className='absolute top-2 left-2 z-10 inline-flex items-center justify-center size-7 rounded-md bg-primary text-primary-foreground shadow cursor-grab active:cursor-grabbing'
        >
          <GripVertical className='size-4' />
        </button>
      )}
      <div
        className={
          isEditing
            ? 'rounded-lg outline outline-1 outline-dashed outline-primary outline-offset-[-2px]'
            : ''
        }
      >
        {registryNode}
      </div>
    </div>
  );
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setWorking((prev) => {
      const oldIndex = prev.findIndex((w) => w.id === active.id);
      const newIndex = prev.findIndex((w) => w.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
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

  const renderGrid = (widgets: DashboardLayoutApi.DashboardWidget[], isEditing: boolean) => {
    const visible = widgets.filter((w) => w.visible && widgetRegistry[w.id] != null);
    if (visible.length === 0) return emptyState;

    const ids = visible.map((w) => w.id);
    return (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={isEditing ? handleDragEnd : undefined}
      >
        <SortableContext items={ids} strategy={rectSortingStrategy}>
          <div className='grid grid-cols-1 lg:grid-cols-12 gap-4'>
            {visible.map((w) => (
              <SortableWidget
                key={w.id}
                widget={w}
                isEditing={isEditing}
                registryNode={widgetRegistry[w.id]}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    );
  };

  // ---------------------------------------------------------------------------
  // Idle mode
  // ---------------------------------------------------------------------------

  if (!editMode) {
    const allHidden = activeWidgets.every((w) => !w.visible || widgetRegistry[w.id] == null);
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
      <div className='flex-1 min-w-0'>{renderGrid(working, true)}</div>

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
