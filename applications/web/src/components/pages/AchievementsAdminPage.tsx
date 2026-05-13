import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import type { AchievementApi } from '@sideline/domain';
import { Achievement, CustomAchievement, Discord, Team } from '@sideline/domain';
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '~/components/ui/form';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '~/components/ui/sheet';
import { Skeleton } from '~/components/ui/skeleton';
import { Textarea } from '~/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group';
import { withFieldErrors } from '~/lib/form';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';

// ─── Types ───────────────────────────────────────────────────────────────────

type Filter = 'all' | 'system' | 'custom';
type RoleSource = 'none' | 'existing' | 'auto_create';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function translateBuiltInTitle(titleKey: string): string {
  const fn = m[titleKey as keyof typeof m];
  if (typeof fn === 'function') {
    return (fn as () => string)();
  }
  return titleKey;
}

function formatRule(ruleKind: string, threshold: number): string {
  switch (ruleKind) {
    case 'total_activities':
      return `≥ ${String(threshold)} ${m.achievement_admin_rule_total_activities()}`;
    case 'longest_streak':
      return `≥ ${String(threshold)} ${m.achievement_admin_rule_longest_streak()}`;
    case 'total_duration':
      return `≥ ${String(threshold)} ${m.achievement_admin_rule_total_duration()}`;
    case 'activity_type_count':
      return `≥ ${String(threshold)} ${m.achievement_admin_rule_activity_type_count()}`;
    default:
      return `≥ ${String(threshold)}`;
  }
}

// ─── Role Mapping Section ─────────────────────────────────────────────────────

interface RoleMappingSectionProps {
  roleSource: RoleSource;
  onRoleSourceChange: (v: RoleSource) => void;
  roleId: string;
  onRoleIdChange: (v: string) => void;
  botCanManageRoles: boolean;
  radioGroupName: string;
}

function RoleMappingSection({
  roleSource,
  onRoleSourceChange,
  roleId,
  onRoleIdChange,
  botCanManageRoles,
  radioGroupName,
}: RoleMappingSectionProps) {
  return (
    <div className='flex flex-col gap-3'>
      <Label className='text-sm font-medium'>{m.achievement_admin_table_role()}</Label>
      <div className='flex flex-col gap-2'>
        {/* None */}
        <label className='flex items-center gap-2 cursor-pointer'>
          <input
            type='radio'
            name={radioGroupName}
            value='none'
            checked={roleSource === 'none'}
            onChange={() => onRoleSourceChange('none')}
            className='accent-primary'
          />
          <span className='text-sm'>{m.achievement_admin_roleMapping_none()}</span>
        </label>

        {/* Existing */}
        <div className='flex flex-col gap-1'>
          <label className='flex items-center gap-2 cursor-pointer'>
            <input
              type='radio'
              name={radioGroupName}
              value='existing'
              checked={roleSource === 'existing'}
              onChange={() => onRoleSourceChange('existing')}
              className='accent-primary'
            />
            <span className='text-sm'>{m.achievement_admin_roleMapping_existing()}</span>
          </label>
          {roleSource === 'existing' && (
            <div className='ml-5'>
              <Input
                value={roleId}
                onChange={(e) => onRoleIdChange(e.target.value)}
                placeholder='Discord role ID (snowflake)'
                className='h-8 text-sm'
              />
            </div>
          )}
        </div>

        {/* Auto-create */}
        <div className='flex flex-col gap-1'>
          <label
            className={`flex items-center gap-2 ${!botCanManageRoles ? 'opacity-50' : 'cursor-pointer'}`}
          >
            <input
              type='radio'
              name={radioGroupName}
              value='auto_create'
              checked={roleSource === 'auto_create'}
              onChange={() => {
                if (botCanManageRoles) onRoleSourceChange('auto_create');
              }}
              disabled={!botCanManageRoles}
              className='accent-primary'
            />
            <span className='text-sm'>{m.achievement_admin_roleMapping_autoCreate()}</span>
          </label>
          {!botCanManageRoles && (
            <p className='ml-5 text-xs text-destructive'>
              {m.achievement_admin_roleMapping_botMissingPermission()}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Edit Built-in Sheet ──────────────────────────────────────────────────────

interface EditBuiltInSheetProps {
  achievement: AchievementApi.AchievementOverview;
  teamId: Team.TeamId;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | {
      status: 'loaded';
      qualifyingCount: number;
      removedMembers: ReadonlyArray<AchievementApi.RemovedMember>;
      botCanManageRoles: boolean;
    };

function EditBuiltInSheet({ achievement, teamId, open, onClose, onSaved }: EditBuiltInSheetProps) {
  const run = useRun();

  const slug = Schema.decodeUnknownSync(Achievement.AchievementSlug)(achievement.keyOrId);

  const [threshold, setThreshold] = React.useState(String(achievement.effectiveThreshold));
  const [previewState, setPreviewState] = React.useState<PreviewState>({ status: 'idle' });
  const [confirmedDestructive, setConfirmedDestructive] = React.useState(false);
  const [showAffected, setShowAffected] = React.useState(false);
  const [roleSource, setRoleSource] = React.useState<RoleSource>(() =>
    Option.isSome(achievement.discordRoleId) ? 'existing' : 'none',
  );
  const [roleId, setRoleId] = React.useState(Option.getOrElse(achievement.discordRoleId, () => ''));
  const [saving, setSaving] = React.useState(false);

  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchPreview = React.useCallback(
    (thresholdValue: number) => {
      setPreviewState({ status: 'loading' });
      setConfirmedDestructive(false);
      setShowAffected(false);
      ApiClient.asEffect()
        .pipe(
          Effect.flatMap((api) =>
            api.achievement.previewBuiltInThreshold({
              params: { teamId, slug },
              query: { threshold: thresholdValue },
            }),
          ),
          Effect.mapError(() => ClientError.make('preview failed')),
          run({}),
        )
        .then((result) => {
          if (Option.isSome(result)) {
            setPreviewState({
              status: 'loaded',
              qualifyingCount: result.value.qualifyingCount,
              removedMembers: result.value.removedMembers,
              botCanManageRoles: result.value.botCanManageRoles,
            });
          } else {
            setPreviewState({ status: 'error' });
          }
        })
        .catch(() => setPreviewState({ status: 'error' }));
    },
    [teamId, slug, run],
  );

  const handleThresholdChange = (value: string) => {
    setThreshold(value);
    const n = Number(value);
    if (!value || Number.isNaN(n) || n < 1) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchPreview(n), 300);
  };

  const removedCount = previewState.status === 'loaded' ? previewState.removedMembers.length : 0;

  const botCanManageRoles =
    previewState.status === 'loaded' ? previewState.botCanManageRoles : true;

  const canSave =
    !saving &&
    threshold !== '' &&
    Number(threshold) >= 1 &&
    (removedCount === 0 || confirmedDestructive) &&
    (roleSource !== 'existing' || roleId !== '');

  const handleSave = React.useCallback(async () => {
    const thresholdNum = Number(threshold);
    if (Number.isNaN(thresholdNum) || thresholdNum < 1) return;
    setSaving(true);

    const thresholdResult = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.achievement.setBuiltInThreshold({
          params: { teamId, slug },
          payload: { threshold: thresholdNum },
        }),
      ),
      Effect.mapError(() => ClientError.make('Failed to save threshold')),
      run({}),
    );

    if (Option.isNone(thresholdResult)) {
      setSaving(false);
      return;
    }

    if (roleSource === 'existing' && roleId) {
      let snowflake: Discord.Snowflake;
      try {
        snowflake = Schema.decodeSync(Discord.Snowflake)(roleId);
      } catch {
        setSaving(false);
        return;
      }
      await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.achievement.setRoleMapping({
            params: { teamId, keyOrId: achievement.keyOrId },
            payload: { source: 'existing', roleId: snowflake },
          }),
        ),
        Effect.mapError(() => ClientError.make('Failed to save role mapping')),
        run({ success: m.achievement_admin_save() }),
      );
    } else if (roleSource === 'auto_create') {
      await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.achievement.setRoleMapping({
            params: { teamId, keyOrId: achievement.keyOrId },
            payload: { source: 'auto_create' },
          }),
        ),
        Effect.mapError(() => ClientError.make('Failed to save role mapping')),
        run({ success: m.achievement_admin_save() }),
      );
    } else {
      await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.achievement.setRoleMapping({
            params: { teamId, keyOrId: achievement.keyOrId },
            payload: { source: 'none' },
          }),
        ),
        Effect.mapError(() => ClientError.make('Failed to save role mapping')),
        run({ success: m.achievement_admin_save() }),
      );
    }

    setSaving(false);
    onSaved();
    onClose();
  }, [threshold, teamId, slug, roleSource, roleId, achievement.keyOrId, run, onSaved, onClose]);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side='right' className='w-full sm:max-w-md overflow-y-auto'>
        <SheetHeader>
          <SheetTitle>
            {Option.isSome(achievement.titleKey)
              ? translateBuiltInTitle(achievement.titleKey.value)
              : achievement.name}
          </SheetTitle>
        </SheetHeader>

        <div className='flex flex-col gap-6 p-4'>
          {/* Threshold */}
          <div className='flex flex-col gap-2'>
            <Label htmlFor='threshold-input' className='text-sm font-medium'>
              {m.achievement_admin_thresholdOverride_label()}
            </Label>
            <Input
              id='threshold-input'
              type='number'
              min={1}
              value={threshold}
              onChange={(e) => handleThresholdChange(e.target.value)}
              className='max-w-[120px]'
            />

            {/* Preview */}
            <div aria-live='polite' className='text-sm mt-1'>
              {previewState.status === 'loading' && <Skeleton className='w-32 h-4' />}
              {previewState.status === 'error' && (
                <div className='flex items-center gap-2 text-destructive'>
                  <span>Couldn&apos;t load preview.</span>
                  <Button
                    variant='ghost'
                    size='sm'
                    className='h-6 text-xs'
                    onClick={() => fetchPreview(Number(threshold))}
                  >
                    Retry
                  </Button>
                </div>
              )}
              {previewState.status === 'loaded' && (
                <p className='text-muted-foreground'>
                  {m.achievement_admin_qualifyingCount({ count: previewState.qualifyingCount })}{' '}
                  after save
                </p>
              )}
            </div>

            {/* Destructive confirm */}
            {previewState.status === 'loaded' && removedCount > 0 && (
              <div className='border border-destructive/30 bg-destructive/5 rounded-md p-3 flex flex-col gap-2'>
                <p className='text-sm font-medium text-destructive'>
                  ⚠ {removedCount} player(s) will lose this achievement
                </p>
                <Button
                  variant='ghost'
                  size='sm'
                  className='w-fit text-xs h-6 px-2'
                  onClick={() => setShowAffected((v) => !v)}
                >
                  {showAffected ? 'Hide affected players' : 'Show affected players'}
                </Button>
                {showAffected && (
                  <ul className='text-xs text-muted-foreground list-disc list-inside max-h-32 overflow-y-auto'>
                    {previewState.removedMembers.slice(0, 10).map((rm) => (
                      <li key={rm.teamMemberId}>{rm.memberName}</li>
                    ))}
                    {previewState.removedMembers.length > 10 && (
                      <li className='list-none text-muted-foreground/60'>
                        +{previewState.removedMembers.length - 10} more
                      </li>
                    )}
                  </ul>
                )}
                <label className='flex items-center gap-2 cursor-pointer'>
                  <input
                    type='checkbox'
                    checked={confirmedDestructive}
                    onChange={(e) => setConfirmedDestructive(e.target.checked)}
                  />
                  <span className='text-sm'>
                    {m.achievement_admin_thresholdOverride_destructiveConfirm({
                      count: removedCount,
                    })}
                  </span>
                </label>
              </div>
            )}
          </div>

          {/* Role mapping */}
          <RoleMappingSection
            roleSource={roleSource}
            onRoleSourceChange={setRoleSource}
            roleId={roleId}
            onRoleIdChange={setRoleId}
            botCanManageRoles={botCanManageRoles}
            radioGroupName='sheet-roleSource'
          />
        </div>

        <SheetFooter className='flex flex-row gap-2 justify-end px-4 pb-4'>
          <Button variant='outline' onClick={onClose} disabled={saving}>
            {m.achievement_admin_cancel()}
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {saving ? 'Saving…' : m.achievement_admin_save()}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ─── Create/Edit Custom Schema ─────────────────────────────────────────────────

const CustomAchievementFormSchema = Schema.Struct({
  name: Schema.NonEmptyString.annotate({ message: m.validation_required() }),
  description: Schema.NonEmptyString.annotate({ message: m.validation_required() }),
  emoji: Schema.String,
  ruleKind: CustomAchievement.CustomRuleKind,
  threshold: Schema.String,
  activityTypeSlug: Schema.String,
  roleSource: Schema.Literals(['none', 'existing', 'auto_create']),
  roleId: Schema.String,
});

type CustomAchievementFormValues = Schema.Schema.Type<typeof CustomAchievementFormSchema>;

// ─── Create/Edit Custom Dialog ────────────────────────────────────────────────

interface CustomAchievementDialogProps {
  teamId: Team.TeamId;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  editing?: AchievementApi.AchievementOverview;
}

function CustomAchievementDialog({
  teamId,
  open,
  onClose,
  onSaved,
  editing,
}: CustomAchievementDialogProps) {
  const run = useRun();

  const isEditing = editing !== undefined;

  const form = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(CustomAchievementFormSchema)),
    mode: 'onChange',
    defaultValues: {
      name: editing?.name ?? '',
      description: editing?.description ?? '',
      emoji: '',
      ruleKind: (editing?.ruleKind ?? 'total_activities') as CustomAchievement.CustomRuleKind,
      threshold: String(editing?.effectiveThreshold ?? 1),
      activityTypeSlug: '',
      roleSource: (Option.isSome(editing?.discordRoleId ?? Option.none()) ? 'existing' : 'none') as
        | 'none'
        | 'existing'
        | 'auto_create',
      roleId: editing ? Option.getOrElse(editing.discordRoleId, () => '') : '',
    },
  });

  const watchedRuleKind = form.watch('ruleKind');
  const watchedRoleSource = form.watch('roleSource');

  const onSubmit = async (values: CustomAchievementFormValues) => {
    const thresholdNum = Number(values.threshold);
    if (Number.isNaN(thresholdNum) || thresholdNum < 1) return;

    const discordRoleId =
      values.roleSource === 'existing' && values.roleId
        ? Option.some(values.roleId)
        : Option.none<string>();

    const activityTypeSlug =
      values.ruleKind === 'activity_type_count' && values.activityTypeSlug
        ? Option.some(values.activityTypeSlug)
        : Option.none<string>();

    const emojiOption = values.emoji ? Option.some(values.emoji) : Option.none<string>();

    if (isEditing) {
      const customId = Schema.decodeSync(CustomAchievement.CustomAchievementId)(editing.keyOrId);
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.achievement.updateCustom({
            params: { teamId, customId },
            payload: {
              name: Option.some(values.name),
              description: Option.some(values.description),
              emoji: emojiOption,
              ruleKind: Option.some(values.ruleKind),
              threshold: Option.some(thresholdNum),
              activityTypeSlug,
              discordRoleId,
            },
          }),
        ),
        withFieldErrors(form, [
          {
            tag: 'CustomAchievementNameTaken',
            field: 'name',
            message: m.achievement_admin_custom_nameTaken(),
          },
        ]),
        Effect.mapError(() => ClientError.make('Failed to save achievement')),
        run({ success: m.achievement_admin_save() }),
      );
      if (Option.isSome(result)) {
        form.reset();
        onSaved();
        onClose();
      }
    } else {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.achievement.createCustom({
            params: { teamId },
            payload: {
              name: values.name,
              description: values.description,
              emoji: emojiOption,
              ruleKind: values.ruleKind,
              threshold: thresholdNum,
              activityTypeSlug,
              discordRoleId,
            },
          }),
        ),
        withFieldErrors(form, [
          {
            tag: 'CustomAchievementNameTaken',
            field: 'name',
            message: m.achievement_admin_custom_nameTaken(),
          },
        ]),
        Effect.mapError(() => ClientError.make('Failed to create achievement')),
        run({ success: m.achievement_admin_custom_create() }),
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
      <DialogContent className='max-w-lg max-h-[90vh] overflow-y-auto'>
        <DialogHeader>
          <DialogTitle>
            {isEditing ? m.achievement_admin_custom_edit() : m.achievement_admin_custom_create()}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className='flex flex-col gap-4'>
            {/* Name */}
            <FormField
              {...form.register('name')}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{m.achievement_admin_table_name()}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder='e.g. Team Spirit' />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Description */}
            <FormField
              {...form.register('description')}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{m.achievement_admin_table_description()}</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={2} placeholder='Shown to players…' maxLength={140} />
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
                  <FormLabel>{m.achievement_admin_table_emoji()}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder='🏅' maxLength={4} className='w-20' />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Rule kind */}
            <FormField
              {...form.register('ruleKind')}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{m.achievement_admin_table_rule()}</FormLabel>
                  <FormControl>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='total_activities'>
                          {m.achievement_admin_rule_total_activities()}
                        </SelectItem>
                        <SelectItem value='longest_streak'>
                          {m.achievement_admin_rule_longest_streak()}
                        </SelectItem>
                        <SelectItem value='total_duration'>
                          {m.achievement_admin_rule_total_duration()}
                        </SelectItem>
                        <SelectItem value='activity_type_count'>
                          {m.achievement_admin_rule_activity_type_count()}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Threshold */}
            <FormField
              {...form.register('threshold')}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{m.achievement_admin_thresholdOverride_label()}</FormLabel>
                  <FormControl>
                    <Input {...field} type='number' min={1} className='w-28' />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Activity type slug (only for activity_type_count) */}
            {watchedRuleKind === 'activity_type_count' && (
              <FormField
                {...form.register('activityTypeSlug')}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Activity type slug</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder='e.g. gym' />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {/* Role mapping */}
            <div className='flex flex-col gap-2'>
              <Label className='text-sm font-medium'>{m.achievement_admin_table_role()}</Label>
              <div className='flex flex-col gap-2'>
                <label className='flex items-center gap-2 cursor-pointer'>
                  <input
                    type='radio'
                    name='dialog-roleSource'
                    value='none'
                    checked={watchedRoleSource === 'none'}
                    onChange={() => form.setValue('roleSource', 'none')}
                    className='accent-primary'
                  />
                  <span className='text-sm'>{m.achievement_admin_roleMapping_none()}</span>
                </label>
                <div className='flex flex-col gap-1'>
                  <label className='flex items-center gap-2 cursor-pointer'>
                    <input
                      type='radio'
                      name='dialog-roleSource'
                      value='existing'
                      checked={watchedRoleSource === 'existing'}
                      onChange={() => form.setValue('roleSource', 'existing')}
                      className='accent-primary'
                    />
                    <span className='text-sm'>{m.achievement_admin_roleMapping_existing()}</span>
                  </label>
                  {watchedRoleSource === 'existing' && (
                    <div className='ml-5'>
                      <FormField
                        {...form.register('roleId')}
                        render={({ field }) => (
                          <FormItem>
                            <FormControl>
                              <Input
                                {...field}
                                placeholder='Discord role ID'
                                className='h-8 text-sm'
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  )}
                </div>
                <label className='flex items-center gap-2 cursor-pointer'>
                  <input
                    type='radio'
                    name='dialog-roleSource'
                    value='auto_create'
                    checked={watchedRoleSource === 'auto_create'}
                    onChange={() => form.setValue('roleSource', 'auto_create')}
                    className='accent-primary'
                  />
                  <span className='text-sm'>{m.achievement_admin_roleMapping_autoCreate()}</span>
                </label>
              </div>
            </div>

            <DialogFooter>
              <Button type='button' variant='outline' onClick={onClose}>
                {m.achievement_admin_cancel()}
              </Button>
              <Button type='submit' disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting
                  ? 'Saving…'
                  : isEditing
                    ? m.achievement_admin_save()
                    : m.achievement_admin_custom_create()}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

interface AchievementsAdminPageProps {
  teamId: string;
  initialData: ReadonlyArray<AchievementApi.AchievementOverview>;
}

export function AchievementsAdminPage({ teamId, initialData }: AchievementsAdminPageProps) {
  const run = useRun();
  const router = useRouter();
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);

  const [filter, setFilter] = React.useState<Filter>('all');
  const [editTarget, setEditTarget] = React.useState<AchievementApi.AchievementOverview | null>(
    null,
  );
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editCustomTarget, setEditCustomTarget] =
    React.useState<AchievementApi.AchievementOverview | null>(null);

  const filtered = initialData.filter((a) => {
    if (filter === 'system') return a.isBuiltIn;
    if (filter === 'custom') return !a.isBuiltIn;
    return true;
  });

  const handleDelete = React.useCallback(
    async (achievement: AchievementApi.AchievementOverview) => {
      if (!window.confirm(m.achievement_admin_custom_deleteConfirm())) return;
      const customId = Schema.decodeSync(CustomAchievement.CustomAchievementId)(
        achievement.keyOrId,
      );
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.achievement.deleteCustom({
            params: { teamId: teamIdBranded, customId },
          }),
        ),
        Effect.mapError(() => ClientError.make('Failed to delete achievement')),
        run({ success: m.achievement_admin_custom_delete() }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [teamIdBranded, run, router],
  );

  const handleSaved = React.useCallback(() => {
    router.invalidate();
  }, [router]);

  return (
    <div>
      <header className='mb-8'>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId' params={{ teamId }}>
            ← {m.team_backToTeams()}
          </Link>
        </Button>
        <h1 className='text-2xl font-bold'>{m.achievement_admin_title()}</h1>
        <p className='text-muted-foreground mt-1'>{m.achievement_admin_subtitle()}</p>
      </header>

      {/* Top action */}
      <div className='flex justify-between items-center mb-4'>
        <ToggleGroup
          type='single'
          value={filter}
          onValueChange={(v) => {
            if (v) setFilter(v as Filter);
          }}
          variant='outline'
        >
          <ToggleGroupItem value='all'>{m.achievement_admin_filter_all()}</ToggleGroupItem>
          <ToggleGroupItem value='system'>{m.achievement_admin_filter_system()}</ToggleGroupItem>
          <ToggleGroupItem value='custom'>{m.achievement_admin_filter_custom()}</ToggleGroupItem>
        </ToggleGroup>

        <Button onClick={() => setCreateOpen(true)}>+ {m.achievement_admin_custom_create()}</Button>
      </div>

      {/* Table */}
      {filtered.length === 0 && filter === 'custom' ? (
        <div className='flex flex-col items-center gap-3 py-12 text-center'>
          <span className='text-4xl'>🏅</span>
          <p className='font-medium'>No custom achievements yet</p>
          <p className='text-sm text-muted-foreground'>
            Create one to recognise team-specific milestones.
          </p>
          <Button onClick={() => setCreateOpen(true)}>{m.achievement_admin_custom_create()}</Button>
        </div>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full'>
            <thead>
              <tr className='border-b text-left text-sm text-muted-foreground'>
                <th className='py-2 px-2 w-10'>{m.achievement_admin_table_emoji()}</th>
                <th className='py-2 px-3'>{m.achievement_admin_table_name()}</th>
                <th className='hidden sm:table-cell py-2 px-3'>
                  {m.achievement_admin_table_rule()}
                </th>
                <th className='hidden sm:table-cell py-2 px-3'>
                  {m.achievement_admin_table_role()}
                </th>
                <th className='py-2 px-3'>{m.achievement_admin_table_actions()}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((achievement) => (
                <tr key={achievement.keyOrId} className='border-b hover:bg-muted/30'>
                  <td className='py-3 px-2 text-center text-lg'>
                    {achievement.isBuiltIn ? '🏆' : '🌟'}
                  </td>
                  <td className='py-3 px-3'>
                    <span className='font-medium'>
                      {Option.isSome(achievement.titleKey)
                        ? translateBuiltInTitle(achievement.titleKey.value)
                        : achievement.name}
                    </span>
                    <span
                      className={`ml-2 text-xs px-1.5 py-0.5 rounded ${
                        achievement.isBuiltIn
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {achievement.isBuiltIn
                        ? m.achievement_admin_filter_system()
                        : m.achievement_admin_filter_custom()}
                    </span>
                  </td>
                  <td className='hidden sm:table-cell py-3 px-3 text-sm text-muted-foreground'>
                    {formatRule(achievement.ruleKind, achievement.effectiveThreshold)}
                  </td>
                  <td className='hidden sm:table-cell py-3 px-3 text-sm'>
                    {Option.isSome(achievement.discordRoleId) ? (
                      <span className='text-blue-700'>@{achievement.discordRoleId.value}</span>
                    ) : (
                      <span className='text-muted-foreground'>—</span>
                    )}
                  </td>
                  <td className='py-3 px-3'>
                    <div className='flex gap-2'>
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => {
                          if (achievement.isBuiltIn) {
                            setEditTarget(achievement);
                          } else {
                            setEditCustomTarget(achievement);
                          }
                        }}
                      >
                        {m.achievement_admin_custom_edit()}
                      </Button>
                      {!achievement.isBuiltIn && (
                        <Button
                          variant='outline'
                          size='sm'
                          onClick={() => handleDelete(achievement)}
                        >
                          {m.achievement_admin_custom_delete()}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit built-in sheet */}
      {editTarget !== null && (
        <EditBuiltInSheet
          achievement={editTarget}
          teamId={teamIdBranded}
          open={true}
          onClose={() => setEditTarget(null)}
          onSaved={handleSaved}
        />
      )}

      {/* Create custom dialog */}
      <CustomAchievementDialog
        teamId={teamIdBranded}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={handleSaved}
      />

      {/* Edit custom dialog */}
      {editCustomTarget !== null && (
        <CustomAchievementDialog
          teamId={teamIdBranded}
          open={true}
          onClose={() => setEditCustomTarget(null)}
          onSaved={handleSaved}
          editing={editCustomTarget}
        />
      )}
    </div>
  );
}
