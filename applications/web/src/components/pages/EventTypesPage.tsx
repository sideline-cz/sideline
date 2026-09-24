import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import type { EventTypeApi } from '@sideline/domain';
import { EventType, Team } from '@sideline/domain';
import { Link, useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import { ChevronDown, ChevronUp } from 'lucide-react';
import React from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '~/components/ui/form';
import { Input } from '~/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { EVENT_COLOR_SETS } from '~/lib/event-colors.js';
import { eventTypeLabels } from '~/lib/event-labels.js';
import { withFieldErrors } from '~/lib/form';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';
import { cn } from '~/lib/utils';

// ─── Form Schema ──────────────────────────────────────────────────────────────
//
// `name` is deliberately plain (no min-length requirement) at the schema level: creating a
// type requires a non-empty name (checked by hand in `onSubmit`, matching
// `EventTypeApi.CreateEventTypeRequest.name`'s `EventTypeName`), but editing one must allow a
// blank field to mean "leave the name unchanged" — `UpdateEventTypeRequest.name` is
// `OptionFromOptional`, and there is deliberately no way to reset a renamed type back to its
// seeded NULL (plan §9 accepted trade-off).

const EventTypeFormSchema = Schema.Struct({
  name: Schema.String.pipe(Schema.check(Schema.isMaxLength(50))),
  kind: EventType.EventTypeKind,
  color: EventType.EventTypeColor,
});

type EventTypeFormValues = Schema.Schema.Type<typeof EventTypeFormSchema>;

// ─── Colour swatch grid ────────────────────────────────────────────────────────

function ColorSwatchGrid({
  value,
  onChange,
}: {
  value: EventType.EventTypeColor;
  onChange: (color: EventType.EventTypeColor) => void;
}) {
  return (
    <div className='flex flex-wrap gap-2'>
      {EventType.EventTypeColor.literals.map((color) => (
        <button
          key={color}
          type='button'
          aria-pressed={color === value}
          aria-label={tr(`eventType_color_${color}`)}
          title={tr(`eventType_color_${color}`)}
          onClick={() => onChange(color)}
          className={cn(
            'size-7 rounded-full border-2 transition-transform',
            EVENT_COLOR_SETS[color].dot,
            color === value ? 'border-foreground scale-110' : 'border-transparent hover:scale-105',
          )}
        />
      ))}
    </div>
  );
}

// ─── EventTypeFormDialog ────────────────────────────────────────────────────────

interface EventTypeFormDialogProps {
  teamId: Team.TeamId;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  editing?: EventTypeApi.EventTypeInfo;
}

export function EventTypeFormDialog({
  teamId,
  open,
  onClose,
  onSaved,
  editing,
}: EventTypeFormDialogProps) {
  const run = useRun();
  const isEditing = editing !== undefined;

  const defaultValues = React.useMemo<EventTypeFormValues>(
    () => ({
      name: Option.getOrElse(editing?.name ?? Option.none<string>(), () => ''),
      kind: editing?.kind ?? 'training',
      color: editing?.color ?? 'blue',
    }),
    [editing],
  );

  const form = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(EventTypeFormSchema)),
    mode: 'onChange',
    defaultValues,
  });

  React.useEffect(() => {
    if (open) form.reset(defaultValues);
  }, [open, form, defaultValues]);

  const watchedName = form.watch('name');
  const watchedKind = form.watch('kind');
  const watchedColor = form.watch('color');

  const previewName = watchedName.trim() || eventTypeLabels[watchedKind]();
  const previewColor = EVENT_COLOR_SETS[watchedColor];

  const onSubmit = async (values: EventTypeFormValues) => {
    const trimmedName = values.name.trim();

    if (isEditing) {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.eventType.updateEventType({
            params: { teamId, eventTypeId: editing.eventTypeId },
            payload: {
              name: trimmedName
                ? Option.some(Schema.decodeSync(EventType.EventTypeName)(trimmedName))
                : Option.none(),
              color: Option.some(values.color),
            },
          }),
        ),
        withFieldErrors(form, [
          {
            tag: 'EventTypeNameAlreadyTaken',
            field: 'name',
            message: tr('eventType_nameAlreadyTaken'),
          },
        ]),
        Effect.mapError(() => ClientError.make(tr('eventType_updateFailed'))),
        run({ success: tr('eventType_updated') }),
      );
      if (Option.isSome(result)) {
        form.reset();
        onSaved();
        onClose();
      }
    } else {
      if (!trimmedName) {
        form.setError('name', { message: tr('validation_required') });
        return;
      }
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.eventType.createEventType({
            params: { teamId },
            payload: {
              name: Schema.decodeSync(EventType.EventTypeName)(trimmedName),
              kind: values.kind,
              color: values.color,
            },
          }),
        ),
        withFieldErrors(form, [
          {
            tag: 'EventTypeNameAlreadyTaken',
            field: 'name',
            message: tr('eventType_nameAlreadyTaken'),
          },
        ]),
        Effect.mapError(() => ClientError.make(tr('eventType_createFailed'))),
        run({ success: tr('eventType_created') }),
      );
      if (Option.isSome(result)) {
        form.reset();
        onSaved();
        onClose();
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-w-lg'>
        <DialogHeader>
          <DialogTitle>{isEditing ? tr('eventType_edit') : tr('eventType_create')}</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className='flex flex-col gap-4'>
            <FormField
              {...form.register('name')}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tr('eventType_name')}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder={tr('eventType_namePlaceholder')}
                      maxLength={50}
                    />
                  </FormControl>
                  <FormDescription className='text-xs'>
                    {tr('eventType_defaultNameHint')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* "Behaves like" — the word "kind" never appears in user-facing copy, but the
                underlying select is exactly the immutable `EventTypeKind` literal. Enabled only
                on create: once a type exists, its behaviour can never change (plan §0/§2). */}
            <FormField
              {...form.register('kind')}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tr('eventType_kind')}</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value} disabled={isEditing}>
                    <FormControl>
                      <SelectTrigger className='w-full'>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {EventType.EventTypeKind.literals.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {eventTypeLabels[kind]()}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {isEditing && (
                    <FormDescription className='text-xs'>
                      {tr('eventType_kindImmutableHelp')}
                    </FormDescription>
                  )}
                  {!isEditing && (
                    <FormDescription className='text-xs'>
                      {tr(`eventType_behaviour_${watchedKind}`)}
                    </FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              {...form.register('color')}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tr('eventType_color')}</FormLabel>
                  <FormControl>
                    <ColorSwatchGrid value={field.value} onChange={field.onChange} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div>
              <span className='text-xs font-medium text-muted-foreground'>
                {tr('eventType_preview')}
              </span>
              <div
                className={cn(
                  'mt-1 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm',
                  previewColor.bg,
                  previewColor.text,
                  previewColor.border,
                )}
              >
                <span className={cn('size-2 rounded-full', previewColor.dot)} />
                {previewName}
              </div>
            </div>

            <DialogFooter>
              <Button type='button' variant='outline' onClick={onClose}>
                {tr('achievement_admin_cancel')}
              </Button>
              <Button type='submit' disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting
                  ? isEditing
                    ? tr('eventType_saving')
                    : tr('eventType_creating')
                  : isEditing
                    ? tr('eventType_save')
                    : tr('eventType_create')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

interface EventTypesPageProps {
  teamId: string;
  canAdmin: boolean;
  eventTypes: ReadonlyArray<EventTypeApi.EventTypeInfo>;
}

export function EventTypesPage({ teamId, canAdmin, eventTypes }: EventTypesPageProps) {
  const run = useRun();
  const router = useRouter();
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<EventTypeApi.EventTypeInfo | null>(null);

  const editTargetRef = React.useRef<EventTypeApi.EventTypeInfo | null>(null);
  if (editTarget !== null) editTargetRef.current = editTarget;

  const handleSaved = React.useCallback(() => {
    router.invalidate();
  }, [router]);

  const handleArchive = React.useCallback(
    async (type: EventTypeApi.EventTypeInfo) => {
      const name = Option.getOrElse(type.name, () => eventTypeLabels[type.kind]());
      if (!window.confirm(tr('eventType_archiveConfirm', { name, count: type.usageCount }))) {
        return;
      }

      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.eventType.deleteEventType({
            params: { teamId: teamIdBranded, eventTypeId: type.eventTypeId },
          }),
        ),
        Effect.mapError((e) =>
          e._tag === 'EventTypeLastRemaining'
            ? ClientError.make(tr('eventType_lastRemaining'))
            : ClientError.make(tr('eventType_updateFailed')),
        ),
        run({ success: tr('eventType_archived') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [teamIdBranded, run, router],
  );

  const handleMove = React.useCallback(
    async (index: number, direction: -1 | 1) => {
      const target = index + direction;
      if (target < 0 || target >= eventTypes.length) return;

      const reordered = [...eventTypes];
      const moved = reordered[index];
      if (moved === undefined) return;
      reordered.splice(index, 1);
      reordered.splice(target, 0, moved);

      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.eventType.reorderEventTypes({
            params: { teamId: teamIdBranded },
            payload: { eventTypeIds: reordered.map((t) => t.eventTypeId) },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('eventType_updateFailed'))),
        run({ success: tr('eventType_reordered') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [eventTypes, teamIdBranded, run, router],
  );

  return (
    <div>
      <header className='mb-8'>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId' params={{ teamId }}>
            ← {tr('team_backToTeams')}
          </Link>
        </Button>
        <h1 className='text-2xl font-bold'>{tr('eventType_title')}</h1>
        <p className='text-muted-foreground mt-1'>{tr('eventType_subtitle')}</p>
      </header>

      {canAdmin && (
        <div className='flex justify-end mb-4'>
          <Button onClick={() => setCreateOpen(true)}>+ {tr('eventType_add')}</Button>
        </div>
      )}

      {eventTypes.length === 0 ? (
        <div className='flex flex-col items-center gap-3 py-12 text-center'>
          <p className='font-medium'>{tr('eventType_empty_title')}</p>
          <p className='text-sm text-muted-foreground'>{tr('eventType_empty_subtitle')}</p>
          {canAdmin && <Button onClick={() => setCreateOpen(true)}>{tr('eventType_add')}</Button>}
        </div>
      ) : (
        <div className='flex flex-col gap-2'>
          {eventTypes.map((type, index) => {
            const name = Option.getOrElse(type.name, () => eventTypeLabels[type.kind]());
            const colorSet = EVENT_COLOR_SETS[type.color];
            return (
              <div
                key={type.eventTypeId}
                className='flex flex-wrap items-center gap-3 rounded-lg border p-3'
              >
                <span
                  data-testid={`event-type-swatch-${type.eventTypeId}`}
                  className={cn('size-4 shrink-0 rounded-full', colorSet.dot)}
                />
                <div className='min-w-0 flex-1 basis-40'>
                  <div className='font-medium truncate'>{name}</div>
                  <div className='text-xs text-muted-foreground'>
                    {eventTypeLabels[type.kind]()} ·{' '}
                    {tr('eventType_usageCount', { count: type.usageCount })}
                  </div>
                </div>
                {canAdmin && (
                  <div className='ml-auto flex flex-wrap items-center gap-1'>
                    <Button
                      type='button'
                      variant='outline'
                      size='icon'
                      className='size-8'
                      disabled={index === 0}
                      aria-label={tr('eventType_moveUp', { name })}
                      onClick={() => handleMove(index, -1)}
                    >
                      <ChevronUp className='size-4' />
                    </Button>
                    <Button
                      type='button'
                      variant='outline'
                      size='icon'
                      className='size-8'
                      disabled={index === eventTypes.length - 1}
                      aria-label={tr('eventType_moveDown', { name })}
                      onClick={() => handleMove(index, 1)}
                    >
                      <ChevronDown className='size-4' />
                    </Button>
                    <Button variant='outline' size='sm' onClick={() => setEditTarget(type)}>
                      {tr('eventType_edit')}
                    </Button>
                    <Button variant='outline' size='sm' onClick={() => handleArchive(type)}>
                      {tr('eventType_archiveAction')}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create dialog */}
      <EventTypeFormDialog
        teamId={teamIdBranded}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={handleSaved}
      />

      {/* Edit dialog */}
      <EventTypeFormDialog
        teamId={teamIdBranded}
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        onSaved={handleSaved}
        editing={editTarget ?? editTargetRef.current ?? undefined}
      />
    </div>
  );
}
