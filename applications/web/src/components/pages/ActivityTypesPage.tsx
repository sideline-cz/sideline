import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import type { ActivityTypeApi } from '@sideline/domain';
import { ActivityType, Team } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
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
  name: ActivityType.ActivityTypeName.annotate({ message: m.validation_required() }),
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

function ActivityTypeFormDialog({
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
    if (!value) return m.activityType_emojiRequired();
    if (value.length > 8) return m.activityType_emojiRequired();
    if (countGraphemes(value) !== 1) return m.activityType_emojiRequired();
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
            message: m.activityType_nameAlreadyTaken(),
          },
        ]),
        Effect.mapError(() => ClientError.make('Failed to save activity type')),
        run({ success: m.activityType_saved() }),
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
            message: m.activityType_nameAlreadyTaken(),
          },
        ]),
        Effect.mapError(() => ClientError.make('Failed to create activity type')),
        run({ success: m.activityType_created() }),
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
          <DialogTitle>{isEditing ? m.activityType_edit() : m.activityType_create()}</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className='flex flex-col gap-4'>
            {/* Name */}
            <FormField
              {...form.register('name')}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{m.activityType_name()}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder={m.activityType_namePlaceholder()}
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
                    {m.activityType_emoji()}
                    {watchedEmoji && (
                      <span className='ml-2 text-xl leading-none'>{watchedEmoji}</span>
                    )}
                  </FormLabel>
                  <FormControl>
                    <Input {...field} placeholder='🏃' maxLength={8} className='w-24' />
                  </FormControl>
                  <FormDescription className='text-xs'>
                    {m.activityType_emojiHelp()}
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
                  <FormLabel>{m.activityType_description()}</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      rows={2}
                      placeholder={m.activityType_descriptionPlaceholder()}
                      maxLength={200}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type='button' variant='outline' onClick={onClose}>
                {m.achievement_admin_cancel()}
              </Button>
              <Button type='submit' disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting
                  ? isEditing
                    ? m.activityType_saving()
                    : m.activityType_creating()
                  : isEditing
                    ? m.activityType_save()
                    : m.activityType_create()}
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

function CannotDeleteDialog({
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
          <DialogTitle>{m.activityType_cannotDelete_title({ name })}</DialogTitle>
        </DialogHeader>
        <p className='text-sm text-muted-foreground'>
          {m.activityType_cannotDelete_body({ count: usageCount })}
        </p>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>
            {m.achievement_admin_cancel()}
          </Button>
          <Button onClick={onRename}>{m.activityType_cannotDelete_rename()}</Button>
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

      if (!window.confirm(m.activityType_deleteConfirm({ name: activityType.name }))) {
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
        run({ success: m.activityType_deleted() }),
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
            ← {m.team_backToTeams()}
          </Link>
        </Button>
        <h1 className='text-2xl font-bold'>{m.activityType_title()}</h1>
        <p className='text-muted-foreground mt-1'>{m.activityType_subtitle()}</p>
      </header>

      {/* Top action */}
      {canAdmin && (
        <div className='flex justify-end mb-4'>
          <Button onClick={() => setCreateOpen(true)}>+ {m.activityType_create()}</Button>
        </div>
      )}

      {/* Empty state */}
      {activityTypes.length === 0 ? (
        <div className='flex flex-col items-center gap-3 py-12 text-center'>
          <span className='text-4xl'>🏃</span>
          <p className='font-medium'>{m.activityType_empty_title()}</p>
          <p className='text-sm text-muted-foreground'>{m.activityType_empty_subtitle()}</p>
          {canAdmin && (
            <Button onClick={() => setCreateOpen(true)}>{m.activityType_create()}</Button>
          )}
        </div>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full'>
            <thead>
              <tr className='border-b text-left text-sm text-muted-foreground'>
                <th className='py-2 px-2 w-10'>{m.activityType_emoji()}</th>
                <th className='py-2 px-3'>{m.activityType_name()}</th>
                <th className='hidden sm:table-cell py-2 px-3'>{m.activityType_description()}</th>
                <th className='py-2 px-3'>{m.activityType_inUse()}</th>
                {canAdmin && <th className='py-2 px-3'>{m.achievement_admin_table_actions()}</th>}
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
                          {m.activityType_builtIn()}
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
                            title={isBuiltIn ? m.activityType_protected() : undefined}
                            onClick={() => {
                              if (!isBuiltIn) setEditTarget(activityType);
                            }}
                          >
                            {m.activityType_edit()}
                          </Button>
                          <Button
                            variant='outline'
                            size='sm'
                            disabled={isBuiltIn}
                            title={isBuiltIn ? m.activityType_protected() : undefined}
                            onClick={() => {
                              if (!isBuiltIn) handleDelete(activityType);
                            }}
                          >
                            {m.activityType_delete()}
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
      {editTarget !== null && (
        <ActivityTypeFormDialog
          teamId={teamIdBranded}
          open={true}
          onClose={() => setEditTarget(null)}
          onSaved={handleSaved}
          editing={editTarget}
        />
      )}

      {/* Cannot delete dialog */}
      {cannotDeleteTarget !== null && (
        <CannotDeleteDialog
          open={true}
          name={cannotDeleteTarget.name}
          usageCount={cannotDeleteCount}
          onClose={() => setCannotDeleteTarget(null)}
          onRename={() => {
            const target = cannotDeleteTarget;
            setCannotDeleteTarget(null);
            setEditTarget(target);
          }}
        />
      )}
    </div>
  );
}
