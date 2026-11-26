import type { ActivityType } from '@sideline/domain';
import { Option } from 'effect';
import React from 'react';
import { Button } from '~/components/ui/button';
import { DatePicker } from '~/components/ui/date-picker';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { tr } from '~/lib/translations.js';

type ActivityTypeOption = {
  id: ActivityType.ActivityTypeId;
  name: string;
  emoji: Option.Option<string>;
};

export interface LogActivityInput {
  activityTypeId: ActivityType.ActivityTypeId;
  durationMinutes: Option.Option<number>;
  note: Option.Option<string>;
  loggedAtDate: Option.Option<string>;
}

interface LogActivityFormProps {
  activityTypes: ReadonlyArray<ActivityTypeOption>;
  onCreateLog: (input: LogActivityInput) => Promise<void>;
}

// Create-a-log form shared by the personal workout page and the team matrix sheet
export function LogActivityForm({ activityTypes, onCreateLog }: LogActivityFormProps) {
  const [selectedTypeId, setSelectedTypeId] = React.useState<ActivityType.ActivityTypeId | null>(
    null,
  );
  const [durationInput, setDurationInput] = React.useState('');
  const [noteInput, setNoteInput] = React.useState('');
  const [dateInput, setDateInput] = React.useState<string>('');
  const [creating, setCreating] = React.useState(false);

  const handleCreate = React.useCallback(async () => {
    if (!selectedTypeId) return;
    setCreating(true);
    try {
      const durationNum = durationInput ? parseInt(durationInput, 10) : null;
      await onCreateLog({
        activityTypeId: selectedTypeId,
        durationMinutes:
          durationNum !== null && !Number.isNaN(durationNum)
            ? Option.some(durationNum)
            : Option.none(),
        note: noteInput.trim() ? Option.some(noteInput.trim()) : Option.none(),
        loggedAtDate: dateInput ? Option.some(dateInput) : Option.none<string>(),
      });
      setSelectedTypeId(null);
      setDurationInput('');
      setNoteInput('');
      setDateInput('');
    } finally {
      setCreating(false);
    }
  }, [selectedTypeId, durationInput, noteInput, dateInput, onCreateLog]);

  return (
    <>
      <div className='flex gap-2 mb-3 flex-wrap'>
        {activityTypes.map((type) => (
          <Button
            key={type.id}
            type='button'
            variant={selectedTypeId === type.id ? 'default' : 'outline'}
            size='sm'
            onClick={() => setSelectedTypeId(type.id)}
          >
            {Option.match(type.emoji, {
              onNone: () => null,
              onSome: (e) => (
                <span aria-hidden='true' className='mr-1'>
                  {e}
                </span>
              ),
            })}
            {type.name}
          </Button>
        ))}
      </div>
      {selectedTypeId && (
        <>
          <div className='mb-2'>
            <Label className='text-xs text-muted-foreground'>{tr('activityLog_dateLabel')}</Label>
            <DatePicker
              value={dateInput}
              onChange={setDateInput}
              placeholder={tr('activityLog_datePlaceholder')}
              fromYear={new Date().getFullYear() - 2}
              toYear={new Date().getFullYear() + 2}
            />
          </div>
          <div className='flex gap-2 mb-2'>
            <div className='flex-1'>
              <Label htmlFor='log-duration' className='text-xs text-muted-foreground'>
                {tr('activityLog_durationLabel')}
              </Label>
              <Input
                id='log-duration'
                type='number'
                min={1}
                max={1440}
                value={durationInput}
                onChange={(e) => setDurationInput(e.target.value)}
                placeholder={tr('activityLog_durationPlaceholder')}
              />
            </div>
          </div>
          <div className='mb-3'>
            <Label htmlFor='log-note' className='text-xs text-muted-foreground'>
              {tr('activityLog_noteLabel')}
            </Label>
            <Input
              id='log-note'
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value)}
              placeholder={tr('activityLog_notePlaceholder')}
            />
          </div>
          <Button size='sm' disabled={creating} onClick={handleCreate}>
            {creating ? tr('activityLog_logging') : tr('activityLog_logActivity')}
          </Button>
        </>
      )}
    </>
  );
}
