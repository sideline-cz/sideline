import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
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
  colStart: number; // 1..3
  colEnd: number; // colStart + colSpan (2..4)
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
    colStart: Math.max(1, Math.min(3, w.x)),
    colEnd: Math.max(1, Math.min(3, w.x)) + Math.max(1, Math.min(3, w.colSpan)),
    row: yMap.get(w.y) ?? 1,
  }));
}

/** Compute maximum row number used by visible renderable widgets. */
function maxRow(
  widgets: ReadonlyArray<DashboardLayoutApi.DashboardWidget>,
  widgetRegistry: Record<string, React.ReactNode | null>,
): number {
  const rendered = renderableWidgets(widgets, widgetRegistry);
  if (rendered.length === 0) return 0;
  return Math.max(...rendered.map((r) => r.row));
}

// ---------------------------------------------------------------------------
// Placement helper — hybrid snap-after / push-down
// ---------------------------------------------------------------------------

/**
 * Move widget `draggedId` to (newCol, targetRow).
 *
 * - If the target cell is EMPTY for the dragged widget's column range:
 *   place the widget at the row IMMEDIATELY AFTER the last occupied row
 *   above the drop target in this column. (So dropping below an existing
 *   widget puts the dragged widget right below it; dropping far below a
 *   stack puts the dragged widget right after the stack.)
 * - If the target cell is OCCUPIED: place the dragged widget at the exact
 *   `targetRow`, and push each colliding sibling down by one row,
 *   recursively cascading further collisions below.
 */
function placeAt(
  working: DashboardLayoutApi.DashboardWidget[],
  draggedId: string,
  newCol: number,
  targetRow: number,
): DashboardLayoutApi.DashboardWidget[] {
  const dragged = working.find((w) => w.id === draggedId);
  if (!dragged) return working;

  const draggedColSpan = dragged.colSpan;
  const draggedColEnd = newCol + draggedColSpan;

  const collidersAt = (workingSet: DashboardLayoutApi.DashboardWidget[], row: number) =>
    workingSet.filter((w) => {
      if (w.id === draggedId || !w.visible) return false;
      const wColEnd = w.x + w.colSpan;
      return w.y === row && w.x < draggedColEnd && wColEnd > newCol;
    });

  const targetOccupied = collidersAt(working, targetRow).length > 0;

  if (targetOccupied) {
    // OCCUPIED case: place at the exact target row and push colliders down recursively.
    let result = working.map((w) =>
      w.id === draggedId
        ? new DashboardLayoutApi.DashboardWidget({
            id: w.id,
            visible: w.visible,
            colSpan: w.colSpan,
            height: w.height,
            x: newCol as 1 | 2 | 3,
            y: targetRow,
          })
        : w,
    );
    for (const collider of collidersAt(working, targetRow)) {
      result = placeAt(result, collider.id, collider.x, targetRow + 1);
    }
    return result;
  }

  // EMPTY case: snap to the row IMMEDIATELY AFTER the highest-row occupant
  // above the drop target in this column range. If nothing's above, snap to row 1.
  let lastOccupiedAbove = 0;
  for (const w of working) {
    if (w.id === draggedId || !w.visible) continue;
    const wColEnd = w.x + w.colSpan;
    const colOverlap = w.x < draggedColEnd && wColEnd > newCol;
    if (colOverlap && w.y < targetRow && w.y > lastOccupiedAbove) {
      lastOccupiedAbove = w.y;
    }
  }
  const finalRow = lastOccupiedAbove + 1;

  return working.map((w) =>
    w.id === draggedId
      ? new DashboardLayoutApi.DashboardWidget({
          id: w.id,
          visible: w.visible,
          colSpan: w.colSpan,
          height: w.height,
          x: newCol as 1 | 2 | 3,
          y: finalRow,
        })
      : w,
  );
}

// ---------------------------------------------------------------------------
// Drop zone cell (useDroppable)
// ---------------------------------------------------------------------------

function DropCell({ row, col }: { row: number; col: number }) {
  const id = `cell-${row}-${col}`;
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ '--dash-col-start': col, '--dash-row-start': row } as React.CSSProperties}
      className={`dashboard-grid-cell pointer-events-auto min-h-8 rounded-md border-2 border-dashed transition-colors ${isOver ? 'border-primary/60 bg-primary/10' : 'border-primary/20 bg-transparent'}`}
      data-cell-id={id}
    />
  );
}

// ---------------------------------------------------------------------------
// Draggable widget cell (useDraggable)
// ---------------------------------------------------------------------------

function DraggableWidget({
  pos,
  isEditing,
  widgetRegistry,
  onStartResize,
}: {
  pos: RenderedWidget;
  isEditing: boolean;
  widgetRegistry: Record<string, React.ReactNode | null>;
  onStartResize: (id: string, e: React.PointerEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: pos.widget.id,
    disabled: !isEditing,
  });

  const style = {
    '--dash-col-start': pos.colStart,
    '--dash-col-end': pos.colEnd,
    '--dash-row-start': pos.row,
    transform: transform ? CSS.Translate.toString(transform) : undefined,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : undefined,
  } as React.CSSProperties;

  const widgetName = tr(WIDGET_LABELS[pos.widget.id] ?? pos.widget.id);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`dashboard-grid-item relative${isEditing ? ' rounded-lg outline outline-1 outline-dashed outline-primary outline-offset-[-2px]' : ''}`}
    >
      {isEditing && (
        <button
          type='button'
          {...listeners}
          {...attributes}
          className='absolute top-1 left-1 z-10 flex size-6 cursor-grab items-center justify-center rounded bg-primary/20 hover:bg-primary/40 transition-colors active:cursor-grabbing'
          aria-label={tr('dashboard_customizer_dragHandle', { widget: widgetName })}
        >
          <svg
            xmlns='http://www.w3.org/2000/svg'
            width='12'
            height='12'
            viewBox='0 0 24 24'
            fill='currentColor'
            aria-hidden='true'
          >
            <circle cx='9' cy='5' r='1.5' />
            <circle cx='15' cy='5' r='1.5' />
            <circle cx='9' cy='12' r='1.5' />
            <circle cx='15' cy='12' r='1.5' />
            <circle cx='9' cy='19' r='1.5' />
            <circle cx='15' cy='19' r='1.5' />
          </svg>
        </button>
      )}
      {widgetRegistry[pos.widget.id]}
      {isEditing && (
        <button
          type='button'
          onPointerDown={(e) => onStartResize(pos.widget.id, e)}
          className='absolute top-0 right-0 h-full w-2 cursor-col-resize bg-primary/30 hover:bg-primary/60 transition-colors'
          aria-label={tr('dashboard_customizer_resizeFor', { widget: widgetName })}
        />
      )}
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
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

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

  const handleDragEnd = (event: DragEndEvent) => {
    const { over, active } = event;
    if (!over) return;
    const overId = String(over.id);
    const match = /^cell-(\d+)-(\d+)$/.exec(overId);
    if (!match) return;
    const newRow = Number.parseInt(match[1], 10);
    const newCol = Number.parseInt(match[2], 10) as 1 | 2 | 3;
    setWorking((prev) => placeAt([...prev], String(active.id), newCol, newRow));
  };

  const startResize = (id: string, downEvent: React.PointerEvent) => {
    downEvent.preventDefault();
    downEvent.stopPropagation();
    const target = downEvent.currentTarget as HTMLElement;
    target.setPointerCapture(downEvent.pointerId);
    const startX = downEvent.clientX;
    const grid = target.closest('.dashboard-grid') as HTMLElement | null;
    if (!grid) return;
    const gridRect = grid.getBoundingClientRect();
    const colWidth = gridRect.width / 3;
    const initial = working.find((w) => w.id === id);
    if (!initial) return;
    const startSpan = initial.colSpan;
    const initialX = initial.x;
    const maxSpan = 4 - initialX; // 3 - x + 1

    const handleMove = (e: PointerEvent) => {
      const delta = e.clientX - startX;
      const spanDelta = Math.round(delta / colWidth);
      const newSpan = Math.max(1, Math.min(maxSpan, startSpan + spanDelta)) as 1 | 2 | 3;
      handleColSpanChange(id, newSpan);
    };

    const handleUp = () => {
      target.releasePointerCapture(downEvent.pointerId);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
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
    const rendered = renderableWidgets(widgets, widgetRegistry);
    if (rendered.length === 0 && !isEditing) return emptyState;

    // In edit mode with no visible renderable widgets, still show the empty state
    // (wrapped in DndContext so drop zones work for dragging widgets back in via toggle)
    if (rendered.length === 0 && isEditing) {
      return (
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          {emptyState}
        </DndContext>
      );
    }

    const rows = isEditing ? maxRow(widgets, widgetRegistry) + 2 : 0;

    // Build drop zone cells (only in edit mode). Use a pre-built coord array
    // so the JSX key is derived from {row, col} object identity, not array index.
    const cellCoords: Array<{ row: number; col: number }> = [];
    if (isEditing) {
      for (let r = 1; r <= rows; r++) {
        for (let c = 1; c <= 3; c++) {
          cellCoords.push({ row: r, col: c });
        }
      }
    }
    const dropZones = cellCoords.map(({ row, col }) => (
      <DropCell key={`cell-${row}-${col}`} row={row} col={col} />
    ));

    const widgetCells = rendered.map((pos) =>
      isEditing ? (
        <DraggableWidget
          key={pos.widget.id}
          pos={pos}
          isEditing={isEditing}
          widgetRegistry={widgetRegistry}
          onStartResize={startResize}
        />
      ) : (
        <div
          key={pos.widget.id}
          style={
            {
              '--dash-col-start': pos.colStart,
              '--dash-col-end': pos.colEnd,
              '--dash-row-start': pos.row,
            } as React.CSSProperties
          }
          className='dashboard-grid-item'
        >
          {widgetRegistry[pos.widget.id]}
        </div>
      ),
    );

    if (!isEditing) {
      return (
        <div className='dashboard-grid grid grid-cols-1 lg:grid-cols-3 gap-4 relative'>
          {widgetCells}
        </div>
      );
    }

    // In edit mode: show drop zones under widgets
    return (
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className='dashboard-grid grid grid-cols-1 lg:grid-cols-3 gap-4 relative'>
          {dropZones}
          {widgetCells}
        </div>
      </DndContext>
    );
  };

  // ---------------------------------------------------------------------------
  // Idle mode
  // ---------------------------------------------------------------------------

  if (!editMode) {
    return <div className='flex flex-col gap-4'>{renderGrid(activeWidgets, false)}</div>;
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
