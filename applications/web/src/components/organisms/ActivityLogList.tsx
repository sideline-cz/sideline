import type { ActivityLog, ActivityLogApi, ActivityType } from '@sideline/domain';
import { ActivityLogDate } from '@sideline/domain';
import { Option } from 'effect';
import { ClipboardList } from 'lucide-react';
import React from 'react';
import { Alert, AlertDescription } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { DatePicker } from '~/components/ui/date-picker';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '~/components/ui/sheet';
import { tr } from '~/lib/translations.js';

type ActivityTypeOption = {
  id: ActivityType.ActivityTypeId;
  name: string;
  emoji: Option.Option<string>;
};

const formatDuration = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
};

const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const formatDayLabel = (date: Date, now: Date): string => {
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const key = dayKey(date);
  const long = date.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  if (key === today) return `${tr('activityLog_today')} · ${long}`;
  if (key === yesterday) return `${tr('activityLog_yesterday')} · ${long}`;
  return long;
};

interface ActivityLogListProps {
  logs: ReadonlyArray<ActivityLogApi.ActivityLogEntry>;
  isOwnProfile: boolean;
  // A past season or Earlier is selected: empty copy points to other seasons, no "log first" CTA
  isPastPeriod?: boolean;
  // listLogs failed: show an error with Retry, never the empty state or the log form
  loadError?: boolean;
  onRetry?: () => void;
  activityTypes: ReadonlyArray<ActivityTypeOption>;
  onCreateLog: (input: {
    activityTypeId: ActivityType.ActivityTypeId;
    durationMinutes: Option.Option<number>;
    note: Option.Option<string>;
    loggedAtDate: Option.Option<string>;
  }) => Promise<void>;
  onUpdateLog: (
    logId: ActivityLog.ActivityLogId,
    input: {
      activityTypeId: Option.Option<ActivityType.ActivityTypeId>;
      durationMinutes: Option.Option<Option.Option<number>>;
      note: Option.Option<Option.Option<string>>;
      loggedAtDate: Option.Option<string>;
    },
  ) => Promise<void>;
  onDeleteLog: (logId: ActivityLog.ActivityLogId) => Promise<void>;
}

export function ActivityLogList({
  logs,
  isOwnProfile,
  isPastPeriod = false,
  loadError = false,
  onRetry,
  activityTypes,
  onCreateLog,
  onUpdateLog,
  onDeleteLog,
}: ActivityLogListProps) {
  const [selectedTypeId, setSelectedTypeId] = React.useState<ActivityType.ActivityTypeId | null>(
    null,
  );
  const [durationInput, setDurationInput] = React.useState('');
  const [noteInput, setNoteInput] = React.useState('');
  const [dateInput, setDateInput] = React.useState<string>('');
  const [creating, setCreating] = React.useState(false);

  const [editingLog, setEditingLog] = React.useState<ActivityLogApi.ActivityLogEntry | null>(null);
  const [editTypeId, setEditTypeId] = React.useState<ActivityType.ActivityTypeId | null>(null);
  const [editDuration, setEditDuration] = React.useState('');
  const [editNote, setEditNote] = React.useState('');
  const [editDate, setEditDate] = React.useState<string>('');
  const [editDateDirty, setEditDateDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<ActivityLog.ActivityLogId | null>(null);

  const logActivityRef = React.useRef<HTMLDivElement>(null);

  const handleFocusLogActivity = React.useCallback(() => {
    logActivityRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  // Derive edit activity types from the logs (unique types seen) plus provided activityTypes
  const editActivityTypes = React.useMemo(() => {
    const seenIds = new Set(activityTypes.map((t) => t.id));
    const extra: ActivityTypeOption[] = [];
    for (const log of logs) {
      if (!seenIds.has(log.activityTypeId)) {
        seenIds.add(log.activityTypeId);
        extra.push({
          id: log.activityTypeId,
          name: log.activityTypeName,
          emoji: log.activityTypeEmoji,
        });
      }
    }
    return [...activityTypes, ...extra];
  }, [activityTypes, logs]);

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

  const openEdit = React.useCallback((log: ActivityLogApi.ActivityLogEntry) => {
    setEditingLog(log);
    setEditTypeId(log.activityTypeId);
    setEditDuration(
      Option.match(log.durationMinutes, { onNone: () => '', onSome: (n) => n.toString() }),
    );
    setEditNote(Option.match(log.note, { onNone: () => '', onSome: (s) => s }));
    setEditDate(ActivityLogDate.formatPragueDate(new Date(log.loggedAt)));
    setEditDateDirty(false);
  }, []);

  const handleUpdate = React.useCallback(async () => {
    if (!editingLog || !editTypeId) return;
    setSaving(true);
    try {
      const durationNum = editDuration ? parseInt(editDuration, 10) : null;
      const parsedDuration =
        durationNum !== null && !Number.isNaN(durationNum)
          ? Option.some(durationNum)
          : Option.none<number>();
      await onUpdateLog(editingLog.id, {
        activityTypeId: Option.some(editTypeId),
        durationMinutes: Option.some(parsedDuration),
        note: Option.some(editNote.trim() ? Option.some(editNote.trim()) : Option.none<string>()),
        loggedAtDate: editDateDirty ? Option.some(editDate) : Option.none<string>(),
      });
      setEditingLog(null);
    } finally {
      setSaving(false);
    }
  }, [editingLog, editTypeId, editDuration, editNote, editDate, editDateDirty, onUpdateLog]);

  const handleDelete = React.useCallback(
    async (logId: ActivityLog.ActivityLogId) => {
      setDeletingId(logId);
      try {
        await onDeleteLog(logId);
      } finally {
        setDeletingId(null);
      }
    },
    [onDeleteLog],
  );

  const groupedByDate = React.useMemo(() => {
    const now = new Date();
    const groups = new Map<
      string,
      { label: string; minutes: number; logs: ActivityLogApi.ActivityLogEntry[] }
    >();
    for (const log of logs) {
      const date = new Date(log.loggedAt);
      const key = dayKey(date);
      const group = groups.get(key) ?? { label: formatDayLabel(date, now), minutes: 0, logs: [] };
      group.logs.push(log);
      group.minutes += Option.getOrElse(log.durationMinutes, () => 0);
      groups.set(key, group);
    }
    return Array.from(groups, ([key, group]) => ({ key, ...group }));
  }, [logs]);

  // A new log lands in the current season, so a past-scope list would never show it
  const canLog = isOwnProfile && !isPastPeriod && !loadError;

  return (
    <div>
      {canLog && (
        <div ref={logActivityRef} className='mb-6 p-4 border rounded-lg'>
          <p className='text-sm font-medium mb-2'>{tr('activityLog_logActivity')}</p>
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
                <Label className='text-xs text-muted-foreground'>
                  {tr('activityLog_dateLabel')}
                </Label>
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
        </div>
      )}

      {loadError ? (
        <Alert variant='destructive'>
          <AlertDescription className='flex flex-wrap items-center gap-3'>
            {tr('activityLog_loadError')}
            {onRetry ? (
              <Button size='sm' onClick={onRetry}>
                {tr('common_retry')}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : logs.length === 0 ? (
        <div className='flex flex-col items-center justify-center gap-2 py-10 text-center'>
          <ClipboardList className='size-8 text-muted-foreground' aria-hidden='true' />
          {canLog ? (
            <>
              <p className='font-medium'>{tr('activityLog_empty_title')}</p>
              <p className='text-sm text-muted-foreground'>{tr('activityLog_empty_body')}</p>
            </>
          ) : (
            <>
              <p className='font-medium'>{tr('activityLog_emptyPeriod_title')}</p>
              <p className='text-sm text-muted-foreground'>{tr('activityLog_emptyPeriod_body')}</p>
            </>
          )}
          {canLog ? (
            <Button type='button' size='sm' className='mt-2' onClick={handleFocusLogActivity}>
              {tr('activityLog_empty_cta')}
            </Button>
          ) : null}
        </div>
      ) : (
        <ol className='flex flex-col gap-5'>
          {groupedByDate.map((group) => (
            <li key={group.key}>
              <div className='mb-2 flex items-baseline justify-between gap-3'>
                <h3 className='text-xs font-semibold uppercase tracking-wide text-muted-foreground'>
                  {group.label}
                </h3>
                {group.minutes > 0 ? (
                  <span className='text-xs font-medium tabular-nums text-muted-foreground'>
                    {formatDuration(group.minutes)}
                  </span>
                ) : null}
              </div>
              <ul className='divide-y rounded-lg border bg-card'>
                {group.logs.map((log) => (
                  <li key={log.id} className='flex items-center gap-3 px-3 py-2.5'>
                    <span
                      aria-hidden='true'
                      className='flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-lg'
                    >
                      {Option.getOrElse(log.activityTypeEmoji, () =>
                        log.activityTypeName.slice(0, 1).toUpperCase(),
                      )}
                    </span>
                    <div className='min-w-0 flex-1'>
                      <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
                        <span className='truncate text-sm font-medium'>{log.activityTypeName}</span>
                        {log.source === 'auto' && (
                          <span className='rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary'>
                            {tr('activityLog_autoBadge')}
                          </span>
                        )}
                      </div>
                      {/* Second wall: the server strips other members' notes already */}
                      {isOwnProfile && Option.isSome(log.note) && (
                        <p className='truncate text-xs text-muted-foreground'>{log.note.value}</p>
                      )}
                    </div>
                    {Option.isSome(log.durationMinutes) && (
                      <span className='shrink-0 text-sm font-medium tabular-nums'>
                        {formatDuration(log.durationMinutes.value)}
                      </span>
                    )}
                    {isOwnProfile && log.source !== 'auto' && (
                      <div className='flex shrink-0 gap-1'>
                        <Button
                          type='button'
                          variant='ghost'
                          size='sm'
                          onClick={() => openEdit(log)}
                        >
                          {tr('activityLog_edit')}
                        </Button>
                        <Button
                          type='button'
                          variant='ghost'
                          size='sm'
                          disabled={deletingId === log.id}
                          onClick={() => {
                            if (confirm(tr('activityLog_deleteConfirm'))) {
                              handleDelete(log.id);
                            }
                          }}
                        >
                          {deletingId === log.id ? '...' : tr('activityLog_delete')}
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}

      <Sheet
        open={editingLog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditingLog(null);
            setEditDate('');
            setEditDateDirty(false);
          }
        }}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{tr('activityLog_editTitle')}</SheetTitle>
          </SheetHeader>
          <div className='flex flex-col gap-4 px-4 pb-4'>
            <div>
              <Label className='text-sm font-medium mb-2 block'>
                {tr('activityLog_activityType')}
              </Label>
              <div className='flex gap-2 flex-wrap'>
                {editActivityTypes.map((type) => (
                  <Button
                    key={type.id}
                    type='button'
                    variant={editTypeId === type.id ? 'default' : 'outline'}
                    size='sm'
                    onClick={() => setEditTypeId(type.id)}
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
            </div>
            <div>
              <Label className='text-sm font-medium'>{tr('activityLog_dateLabel')}</Label>
              <DatePicker
                value={editDate}
                onChange={(v) => {
                  setEditDate(v);
                  setEditDateDirty(true);
                }}
                placeholder={tr('activityLog_datePlaceholder')}
                fromYear={new Date().getFullYear() - 2}
                toYear={new Date().getFullYear() + 2}
              />
            </div>
            <div>
              <Label htmlFor='edit-duration' className='text-sm font-medium'>
                {tr('activityLog_durationLabel')}
              </Label>
              <Input
                id='edit-duration'
                type='number'
                min={1}
                max={1440}
                value={editDuration}
                onChange={(e) => setEditDuration(e.target.value)}
                placeholder={tr('activityLog_durationPlaceholder')}
              />
            </div>
            <div>
              <Label htmlFor='edit-note' className='text-sm font-medium'>
                {tr('activityLog_noteLabel')}
              </Label>
              <Input
                id='edit-note'
                value={editNote}
                onChange={(e) => setEditNote(e.target.value)}
                placeholder={tr('activityLog_notePlaceholder')}
              />
            </div>
            <Button disabled={saving} onClick={handleUpdate}>
              {saving ? tr('activityLog_saving') : tr('activityLog_saveChanges')}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
