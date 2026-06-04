import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import type { ActivityTypeApi } from '@sideline/domain';
import { ActivityType, Team } from '@sideline/domain';
import { Link, useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
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
import { Textarea } from '~/components/ui/textarea';
import { withFieldErrors } from '~/lib/form';
import { ApiClient, ClientError, SilentClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countGraphemes(s: string): number {
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(seg.segment(s)).length;
  } catch {
    return s.length;
  }
}

// ─── Form Schema ──────────────────────────────────────────────────────────────

const ActivityTypeFormSchema = Schema.Struct({
  name: ActivityType.ActivityTypeName.annotate({ message: tr('validation_required') }),
  emoji: Schema.String,
  description: Schema.String,
});

type ActivityTypeFormValues = Schema.Schema.Type<typeof ActivityTypeFormSchema>;

// ─── ActivityTypeFormDialog ────────────────────────────────────────────────────

interface ActivityTypeFormDialogProps {
  teamId: Team.TeamId;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  editing?: ActivityTypeApi.ActivityTypeInfo;
}

export function ActivityTypeFormDialog({
  teamId,
  open,
  onClose,
  onSaved,
  editing,
}: ActivityTypeFormDialogProps) {
  const run = useRun();
  const isEditing = editing !== undefined;

  const form = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(ActivityTypeFormSchema)),
    mode: 'onChange',
    defaultValues: {
      name: editing?.name ?? '',
      emoji: Option.getOrElse(editing?.emoji ?? Option.none<string>(), () => ''),
      description: Option.getOrElse(editing?.description ?? Option.none<string>(), () => ''),
    },
  });

  React.useEffect(() => {
    if (open) {
      form.reset({
        name: editing?.name ?? '',
        emoji: Option.getOrElse(editing?.emoji ?? Option.none<string>(), () => ''),
        description: Option.getOrElse(editing?.description ?? Option.none<string>(), () => ''),
      });
    }
  }, [open, editing, form]);

  const watchedEmoji = form.watch('emoji');

  const validateEmoji = (value: string): string | true => {
    if (!value) return tr('activityType_emojiRequired');
    if (value.length > 8) return tr('activityType_emojiRequired');
    if (countGraphemes(value) !== 1) return tr('activityType_emojiRequired');
    return true;
  };

  const onSubmit = async (values: ActivityTypeFormValues) => {
    const emojiError = validateEmoji(values.emoji);
    if (emojiError !== true) {
      form.setError('emoji', { message: emojiError });
      return;
    }

    const emojiOption = values.emoji
      ? Option.some(Schema.decodeSync(ActivityType.ActivityTypeEmoji)(values.emoji))
      : Option.none<ActivityType.ActivityTypeEmoji>();
    const descriptionOption = values.description
      ? Option.some(Schema.decodeSync(ActivityType.ActivityTypeDescription)(values.description))
      : Option.none<ActivityType.ActivityTypeDescription>();

    if (isEditing) {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.activityType.updateActivityType({
            params: { teamId, activityTypeId: editing.id },
            payload: {
              name: Option.some(values.name),
              emoji: Option.some(emojiOption),
              description: Option.some(descriptionOption),
            },
          }),
        ),
        withFieldErrors(form, [
          {
            tag: 'ActivityTypeNameAlreadyTaken',
            field: 'name',
            message: tr('activityType_nameAlreadyTaken'),
          },
        ]),
        Effect.mapError(() => ClientError.make('Failed to save activity type')),
        run({ success: tr('activityType_saved') }),
      );
      if (Option.isSome(result)) {
        form.reset();
        onSaved();
        onClose();
      }
    } else {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.activityType.createActivityType({
            params: { teamId },
            payload: {
              name: values.name,
              emoji: emojiOption,
              description: descriptionOption,
            },
          }),
        ),
        withFieldErrors(form, [
          {
            tag: 'ActivityTypeNameAlreadyTaken',
            field: 'name',
            message: tr('activityType_nameAlreadyTaken'),
          },
        ]),
        Effect.mapError(() => ClientError.make('Failed to create activity type')),
        run({ success: tr('activityType_created') }),
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
          <DialogTitle>
            {isEditing ? tr('activityType_edit') : tr('activityType_create')}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className='flex flex-col gap-4'>
            {/* Name */}
            <FormField
              {...form.register('name')}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tr('activityType_name')}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder={tr('activityType_namePlaceholder')}
                      maxLength={50}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Emoji */}
            <FormField
              {...form.register('emoji')}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {tr('activityType_emoji')}
                    {watchedEmoji && (
                      <span className='ml-2 text-xl leading-none'>{watchedEmoji}</span>
                    )}
                  </FormLabel>
                  <FormControl>
                    <Input {...field} placeholder='🏃' maxLength={8} className='w-24' />
                  </FormControl>
                  <FormDescription className='text-xs'>
                    {tr('activityType_emojiHelp')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Description */}
            <FormField
              {...form.register('description')}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tr('activityType_description')}</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      rows={2}
                      placeholder={tr('activityType_descriptionPlaceholder')}
                      maxLength={200}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type='button' variant='outline' onClick={onClose}>
                {tr('achievement_admin_cancel')}
              </Button>
              <Button type='submit' disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting
                  ? isEditing
                    ? tr('activityType_saving')
                    : tr('activityType_creating')
                  : isEditing
                    ? tr('activityType_save')
                    : tr('activityType_create')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ─── CannotDeleteDialog ────────────────────────────────────────────────────────

interface CannotDeleteDialogProps {
  open: boolean;
  name: string;
  usageCount: number;
  onClose: () => void;
  onRename: () => void;
}

export function CannotDeleteDialog({
  open,
  name,
  usageCount,
  onClose,
  onRename,
}: CannotDeleteDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-w-md'>
        <DialogHeader>
          <DialogTitle>{tr('activityType_cannotDelete_title', { name })}</DialogTitle>
        </DialogHeader>
        <p className='text-sm text-muted-foreground'>
          {tr('activityType_cannotDelete_body', { count: usageCount })}
        </p>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>
            {tr('achievement_admin_cancel')}
          </Button>
          <Button onClick={onRename}>{tr('activityType_cannotDelete_rename')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

interface ActivityTypesPageProps {
  teamId: string;
  canAdmin: boolean;
  activityTypes: ReadonlyArray<ActivityTypeApi.ActivityTypeInfo>;
}

export function ActivityTypesPage({ teamId, canAdmin, activityTypes }: ActivityTypesPageProps) {
  const run = useRun();
  const router = useRouter();
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<ActivityTypeApi.ActivityTypeInfo | null>(null);
  const [cannotDeleteTarget, setCannotDeleteTarget] =
    React.useState<ActivityTypeApi.ActivityTypeInfo | null>(null);
  const [cannotDeleteCount, setCannotDeleteCount] = React.useState(0);

  const editTargetRef = React.useRef<ActivityTypeApi.ActivityTypeInfo | null>(null);
  if (editTarget !== null) editTargetRef.current = editTarget;

  const cannotDeleteNameRef = React.useRef('');
  if (cannotDeleteTarget !== null) cannotDeleteNameRef.current = cannotDeleteTarget.name;

  const handleSaved = React.useCallback(() => {
    router.invalidate();
  }, [router]);

  const handleDelete = React.useCallback(
    async (activityType: ActivityTypeApi.ActivityTypeInfo) => {
      if (activityType.usageCount > 0) {
        setCannotDeleteTarget(activityType);
        setCannotDeleteCount(activityType.usageCount);
        return;
      }

      if (!window.confirm(tr('activityType_deleteConfirm', { name: activityType.name }))) {
        return;
      }

      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.activityType.deleteActivityType({
            params: { teamId: teamIdBranded, activityTypeId: activityType.id },
          }),
        ),
        Effect.mapError((e) => {
          if (e._tag === 'ActivityTypeHasLogs') {
            setCannotDeleteTarget(activityType);
            setCannotDeleteCount(e.usageCount);
            return new SilentClientError({ message: 'ActivityTypeHasLogs' });
          }
          return ClientError.make('Failed to delete activity type');
        }),
        run({ success: tr('activityType_deleted') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [teamIdBranded, run, router],
  );

  return (
    <div>
      <header className='mb-8'>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId' params={{ teamId }}>
            ← {tr('team_backToTeams')}
          </Link>
        </Button>
        <h1 className='text-2xl font-bold'>{tr('activityType_title')}</h1>
        <p className='text-muted-foreground mt-1'>{tr('activityType_subtitle')}</p>
      </header>

      {/* Top action */}
      {canAdmin && (
        <div className='flex justify-end mb-4'>
          <Button onClick={() => setCreateOpen(true)}>+ {tr('activityType_create')}</Button>
        </div>
      )}

      {/* Empty state */}
      {activityTypes.length === 0 ? (
        <div className='flex flex-col items-center gap-3 py-12 text-center'>
          <span className='text-4xl'>🏃</span>
          <p className='font-medium'>{tr('activityType_empty_title')}</p>
          <p className='text-sm text-muted-foreground'>{tr('activityType_empty_subtitle')}</p>
          {canAdmin && (
            <Button onClick={() => setCreateOpen(true)}>{tr('activityType_create')}</Button>
          )}
        </div>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full'>
            <thead>
              <tr className='border-b text-left text-sm text-muted-foreground'>
                <th className='py-2 px-2 w-10'>{tr('activityType_emoji')}</th>
                <th className='py-2 px-3'>{tr('activityType_name')}</th>
                <th className='hidden sm:table-cell py-2 px-3'>{tr('activityType_description')}</th>
                <th className='py-2 px-3'>{tr('activityType_inUse')}</th>
                {canAdmin && <th className='py-2 px-3'>{tr('achievement_admin_table_actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {activityTypes.map((activityType) => {
                const isBuiltIn = Option.isSome(activityType.slug);
                return (
                  <tr key={activityType.id} className='border-b hover:bg-muted/30'>
                    <td className='py-3 px-2 text-center text-lg'>
                      {Option.match(activityType.emoji, {
                        onNone: () => '—',
                        onSome: (e) => e,
                      })}
                    </td>
                    <td className='py-3 px-3'>
                      <span className='font-medium'>{activityType.name}</span>
                      {isBuiltIn && (
                        <span className='ml-2 text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-700'>
                          {tr('activityType_builtIn')}
                        </span>
                      )}
                    </td>
                    <td className='hidden sm:table-cell py-3 px-3 text-sm text-muted-foreground'>
                      {Option.match(activityType.description, {
                        onNone: () => '—',
                        onSome: (d) => d,
                      })}
                    </td>
                    <td className='py-3 px-3 text-sm text-muted-foreground'>
                      {activityType.usageCount}
                    </td>
                    {canAdmin && (
                      <td className='py-3 px-3'>
                        <div className='flex gap-2'>
                          <Button
                            variant='outline'
                            size='sm'
                            disabled={isBuiltIn}
                            title={isBuiltIn ? tr('activityType_protected') : undefined}
                            onClick={() => {
                              if (!isBuiltIn) setEditTarget(activityType);
                            }}
                          >
                            {tr('activityType_edit')}
                          </Button>
                          <Button
                            variant='outline'
                            size='sm'
                            disabled={isBuiltIn}
                            title={isBuiltIn ? tr('activityType_protected') : undefined}
                            onClick={() => {
                              if (!isBuiltIn) handleDelete(activityType);
                            }}
                          >
                            {tr('activityType_delete')}
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create dialog */}
      <ActivityTypeFormDialog
        teamId={teamIdBranded}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={handleSaved}
      />

      {/* Edit dialog */}
      <ActivityTypeFormDialog
        teamId={teamIdBranded}
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        onSaved={handleSaved}
        editing={editTarget ?? editTargetRef.current ?? undefined}
      />

      {/* Cannot delete dialog */}
      {/* cannotDeleteCount is intentionally not frozen/reset on close: it is only ever
          set together with cannotDeleteTarget, so it stays consistent with the frozen
          name during the close animation. */}
      <CannotDeleteDialog
        open={cannotDeleteTarget !== null}
        name={cannotDeleteTarget?.name ?? cannotDeleteNameRef.current}
        usageCount={cannotDeleteCount}
        onClose={() => setCannotDeleteTarget(null)}
        onRename={() => {
          const target = cannotDeleteTarget;
          setCannotDeleteTarget(null);
          if (target) setEditTarget(target);
        }}
      />
    </div>
  );
}
