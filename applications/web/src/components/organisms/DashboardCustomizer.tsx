import { DashboardLayoutApi } from '@sideline/domain';
import { ChevronDown, ChevronUp } from 'lucide-react';
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

export function DashboardCustomizer({ layout, onSave }: DashboardCustomizerProps) {
  const [editMode, setEditMode] = React.useState(false);
  const [working, setWorking] = React.useState<DashboardLayoutApi.DashboardWidget[]>([]);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

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

  const moveUp = (index: number) => {
    if (index === 0) return;
    setWorking((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  };

  const moveDown = (index: number) => {
    setWorking((prev) => {
      if (index >= prev.length - 1) return prev;
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
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
      <div className='flex flex-col gap-2'>
        {working.map((widget, index) => {
          const widgetName = tr(WIDGET_LABELS[widget.id] ?? widget.id);
          return (
            <div
              key={widget.id}
              className='flex items-center justify-between gap-2 rounded-lg border px-3 py-2'
            >
              <span className='text-sm font-medium'>{widgetName}</span>
              <div className='flex items-center gap-1'>
                <Switch checked={widget.visible} onCheckedChange={() => toggleVisible(index)} />
                <Button
                  variant='ghost'
                  size='icon'
                  className='size-7'
                  disabled={index === 0}
                  onClick={() => moveUp(index)}
                  aria-label={`${tr('dashboard_customizer_moveUp')} ${widgetName}`}
                >
                  <ChevronUp className='size-4' />
                </Button>
                <Button
                  variant='ghost'
                  size='icon'
                  className='size-7'
                  disabled={index === working.length - 1}
                  onClick={() => moveDown(index)}
                  aria-label={`${tr('dashboard_customizer_moveDown')} ${widgetName}`}
                >
                  <ChevronDown className='size-4' />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

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
