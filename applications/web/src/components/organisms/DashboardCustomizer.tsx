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
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DashboardLayoutApi } from '@sideline/domain';
import { GripVertical } from 'lucide-react';
import React from 'react';
import { Button } from '~/components/ui/button';
import { Switch } from '~/components/ui/switch';
import { DEFAULT_LAYOUT } from '~/lib/dashboardLayout.js';
import { tr } from '~/lib/translations.js';

interface DashboardCustomizerProps {
  teamId: string;
  layout: DashboardLayoutApi.DashboardLayout;
  onSave: (widgets: DashboardLayoutApi.DashboardWidget[]) => Promise<void>;
}

const WIDGET_LABELS: Record<string, string> = {
  stats: 'dashboard_widget_stats',
  upcomingEvents: 'dashboard_widget_upcomingEvents',
  activity: 'dashboard_widget_activity',
  teamManagement: 'dashboard_widget_teamManagement',
};

interface SortableWidgetRowProps {
  widget: DashboardLayoutApi.DashboardWidget;
  index: number;
  onToggle: (index: number) => void;
}

function SortableWidgetRow({ widget, index, onToggle }: SortableWidgetRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: widget.id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const widgetName = tr(WIDGET_LABELS[widget.id] ?? widget.id);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className='flex items-center gap-2 rounded-lg border px-3 py-2'
    >
      <button
        type='button'
        className='cursor-grab touch-none text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        aria-label={tr('dashboard_customizer_dragHandle').replace('{widget}', widgetName)}
        {...attributes}
        {...listeners}
      >
        <GripVertical className='size-4' />
      </button>
      <span className='flex-1 text-sm font-medium'>{widgetName}</span>
      <Switch checked={widget.visible} onCheckedChange={() => onToggle(index)} />
    </div>
  );
}

export function DashboardCustomizer({ layout, onSave }: DashboardCustomizerProps) {
  const [editMode, setEditMode] = React.useState(false);
  const [working, setWorking] = React.useState<DashboardLayoutApi.DashboardWidget[]>([]);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
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

  const toggleVisible = (index: number) => {
    setWorking((prev) =>
      prev.map((w, i) =>
        i === index ? new DashboardLayoutApi.DashboardWidget({ id: w.id, visible: !w.visible }) : w,
      ),
    );
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setWorking((prev) => {
        const oldIndex = prev.findIndex((w) => w.id === active.id);
        const newIndex = prev.findIndex((w) => w.id === over.id);
        return arrayMove(prev, oldIndex, newIndex);
      });
    }
  };

  const resetLayout = () => {
    setWorking([...DEFAULT_LAYOUT.widgets]);
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
    <div className='flex flex-col gap-4'>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={working.map((w) => w.id)} strategy={verticalListSortingStrategy}>
          <div className='flex flex-col gap-2'>
            {working.map((widget, index) => (
              <SortableWidgetRow
                key={widget.id}
                widget={widget}
                index={index}
                onToggle={toggleVisible}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <div className='flex items-center gap-2 flex-wrap'>
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
    </div>
  );
}
