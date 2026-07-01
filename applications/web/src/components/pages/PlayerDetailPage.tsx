import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import type {
  Achievement,
  ActivityLog,
  ActivityLogApi,
  ActivityStatsApi,
  ActivityType,
  PlayerRatingApi,
  RoleApi,
  Roster,
} from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import { Option, Schema } from 'effect';
import { X } from 'lucide-react';
import React from 'react';
import { useForm } from 'react-hook-form';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { AchievementsGridI18n } from '~/components/organisms/AchievementsGrid.js';
import { ActivityLogList } from '~/components/organisms/ActivityLogList';
import { ActivityStatsCard } from '~/components/organisms/ActivityStatsCard';
import { MemberRatingCard } from '~/components/organisms/MemberRatingCard.js';
import { MemberSummaryHeader } from '~/components/organisms/MemberSummaryHeader.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '~/components/ui/alert-dialog';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '~/components/ui/card';
import { DatePicker } from '~/components/ui/date-picker';
import {
  Form,
  FormControl,
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
import { tr } from '~/lib/translations.js';

const isNotFutureDate = Schema.makeFilter<string>((value) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return true;
  return parsed.getTime() <= Date.now() ? true : tr('validation_birthDateFuture');
});

const isNonBlank = Schema.makeFilter<string>((value) =>
  value.trim().length > 0 ? true : tr('validation_required'),
);

const PlayerEditSchema = Schema.Struct({
  name: Schema.NullOr(
    Schema.String.pipe(Schema.check(isNonBlank), Schema.check(Schema.isMaxLength(80))).annotate({
      message: tr('validation_displayNameTooLong'),
    }),
  ),
  birthDate: Schema.NullOr(Schema.String.pipe(Schema.check(isNotFutureDate))),
  gender: Schema.NullOr(Schema.Literals(['male', 'female', 'other'])),
  jerseyNumber: Schema.NullOr(
    Schema.NumberFromString.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isBetween({ minimum: 0, maximum: 99 })),
    ).annotate({
      message: tr('validation_jerseyNumber'),
    }),
  ),
});

export type PlayerEditValues = Schema.Schema.Type<typeof PlayerEditSchema>;

type ActivityTypeOption = {
  id: ActivityType.ActivityTypeId;
  name: string;
  emoji: Option.Option<string>;
};

interface PlayerDetailPageProps {
  teamId: string;
  player: Roster.RosterPlayer;
  canEdit: boolean;
  canManageRoles: boolean;
  availableRoles: ReadonlyArray<RoleApi.RoleInfo>;
  activityStats: ActivityStatsApi.ActivityStatsResponse;
  achievements: ReadonlyArray<{ slug: Achievement.AchievementSlug; earned_at: string }>;
  isOwnProfile: boolean;
  activityLogs: ActivityLogApi.ActivityLogListResponse;
  activityTypes: ReadonlyArray<ActivityTypeOption>;
  rating?: PlayerRatingApi.MemberRatingResponse;
  teamMemberId?: string;
  onRefresh?: () => void;
  onSave: (values: PlayerEditValues) => Promise<boolean>;
  onAssignRole: (roleId: string) => Promise<void>;
  onUnassignRole: (roleId: string) => Promise<void>;
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

export function PlayerDetailPage({
  teamId,
  player,
  canEdit,
  canManageRoles,
  availableRoles,
  activityStats,
  achievements,
  isOwnProfile,
  activityLogs,
  activityTypes,
  rating,
  teamMemberId,
  onRefresh,
  onSave,
  onAssignRole,
  onUnassignRole,
  onCreateLog,
  onUpdateLog,
  onDeleteLog,
}: PlayerDetailPageProps) {
  const form = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(PlayerEditSchema)),
    mode: 'onChange',
    defaultValues: {
      name: Option.getOrNull(player.name),
      birthDate: Option.getOrNull(player.birthDate),
      gender: Option.getOrNull(player.gender),
      jerseyNumber: player.jerseyNumber.pipe(
        Option.map((v) => String(v)),
        Option.getOrNull,
      ),
    },
  });

  const dirtyFieldCount = Object.keys(form.formState.dirtyFields).length;
  const hasErrors = Object.keys(form.formState.errors).length > 0;

  const handleSubmit = React.useCallback(
    async (values: PlayerEditValues) => {
      const submittedValues = form.getValues();
      const succeeded = await onSave(values);
      if (succeeded) {
        form.reset(submittedValues);
      }
    },
    [onSave, form],
  );

  const activityLogCardRef = React.useRef<HTMLDivElement>(null);
  const handleFocusActivityLog = React.useCallback(() => {
    activityLogCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  return (
    <div className='mx-auto flex max-w-3xl flex-col gap-6 lg:max-w-5xl'>
      <div>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId/members' params={{ teamId }}>
            ← {tr('members_backToMembers')}
          </Link>
        </Button>
        <MemberSummaryHeader player={player} canManageRoles={canManageRoles} />
      </div>

      <div className='grid gap-6 lg:grid-cols-2'>
        <Card>
          <CardHeader>
            <CardTitle>{tr('profile_complete_title')}</CardTitle>
          </CardHeader>
          <CardContent>
            {canEdit ? (
              <Form {...form}>
                <form onSubmit={form.handleSubmit(handleSubmit)} className='flex flex-col gap-4'>
                  <FormField
                    {...form.register('name')}
                    render={({ field }) => (
                      <FormItem>
                        <DirtyFieldLabel
                          label={tr('profile_complete_displayName')}
                          dirty={Boolean(form.formState.dirtyFields.name)}
                        />
                        <FormControl>
                          <Input {...field} value={field.value ?? ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    {...form.register('birthDate')}
                    render={({ field }) => (
                      <FormItem>
                        <DirtyFieldLabel
                          label={tr('profile_complete_birthDate')}
                          dirty={Boolean(form.formState.dirtyFields.birthDate)}
                        />
                        <FormControl>
                          <DatePicker
                            value={field.value ?? ''}
                            onChange={field.onChange}
                            placeholder={tr('profile_complete_birthDatePlaceholder')}
                            fromYear={1900}
                            toYear={new Date().getFullYear()}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    {...form.register('gender')}
                    render={({ field }) => (
                      <FormItem>
                        <DirtyFieldLabel
                          label={tr('profile_complete_gender')}
                          dirty={Boolean(form.formState.dirtyFields.gender)}
                        />
                        <Select onValueChange={field.onChange} value={field.value ?? ''}>
                          <FormControl>
                            <SelectTrigger className='w-full'>
                              <SelectValue placeholder={tr('profile_complete_genderPlaceholder')} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value='male'>
                              {tr('profile_complete_genderMale')}
                            </SelectItem>
                            <SelectItem value='female'>
                              {tr('profile_complete_genderFemale')}
                            </SelectItem>
                            <SelectItem value='other'>
                              {tr('profile_complete_genderOther')}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    {...form.register('jerseyNumber')}
                    render={({ field }) => (
                      <FormItem>
                        <DirtyFieldLabel
                          label={tr('profile_complete_jerseyNumber')}
                          dirty={Boolean(form.formState.dirtyFields.jerseyNumber)}
                        />
                        <FormControl>
                          <Input
                            {...field}
                            value={field.value ?? ''}
                            placeholder={tr('profile_complete_jerseyNumberPlaceholder')}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button
                    type='submit'
                    disabled={!form.formState.isDirty || hasErrors || form.formState.isSubmitting}
                  >
                    {form.formState.isSubmitting ? tr('members_saving') : tr('members_saveChanges')}
                  </Button>
                  {form.formState.isDirty ? (
                    <CardFooter className='flex items-center justify-between gap-2 px-0'>
                      <p className='text-sm text-muted-foreground'>
                        {tr('members_unsavedChanges', { count: dirtyFieldCount })}
                      </p>
                      <Button type='button' variant='ghost' size='sm' onClick={() => form.reset()}>
                        {tr('common_cancel')}
                      </Button>
                    </CardFooter>
                  ) : null}
                </form>
              </Form>
            ) : (
              <div className='flex flex-col gap-2'>
                <p>
                  <strong>{tr('profile_complete_jerseyNumber')}:</strong>{' '}
                  {player.jerseyNumber.pipe(
                    Option.map((v) => `#${v}`),
                    Option.getOrElse(() => '—'),
                  )}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{tr('roles_currentRoles')}</CardTitle>
          </CardHeader>
          <CardContent>
            <RolesSection
              player={player}
              canManageRoles={canManageRoles}
              availableRoles={availableRoles}
              onAssignRole={onAssignRole}
              onUnassignRole={onUnassignRole}
            />
          </CardContent>
        </Card>

        {canEdit && rating ? (
          <Card>
            <CardContent>
              <MemberRatingCard
                rating={rating}
                teamId={teamId}
                teamMemberId={teamMemberId}
                onRefresh={onRefresh}
              />
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>{tr('stats_title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ActivityStatsCard
              stats={activityStats}
              isOwnProfile={isOwnProfile}
              onLogActivity={handleFocusActivityLog}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent>
          <AchievementsGridI18n
            earnedAchievements={achievements.map((a) => ({
              achievement_slug: a.slug,
              earned_at: new Date(a.earned_at),
            }))}
            emptyTitle={tr('achievements_empty_title')}
            emptyDescription={tr('achievements_empty_description')}
          />
        </CardContent>
      </Card>

      <Card ref={activityLogCardRef}>
        <CardHeader>
          <CardTitle>{tr('activityLog_title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ActivityLogList
            logs={activityLogs.logs}
            isOwnProfile={isOwnProfile}
            activityTypes={activityTypes}
            onCreateLog={onCreateLog}
            onUpdateLog={onUpdateLog}
            onDeleteLog={onDeleteLog}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function DirtyFieldLabel({ label, dirty }: { label: string; dirty: boolean }) {
  return (
    <FormLabel className='flex items-center gap-1.5'>
      {label}
      {dirty ? (
        <>
          <span className='inline-block size-1.5 rounded-full bg-warning' aria-hidden='true' />
          <span className='sr-only'>{tr('form_fieldChanged')}</span>
        </>
      ) : null}
    </FormLabel>
  );
}

function RolesSection({
  player,
  canManageRoles,
  availableRoles,
  onAssignRole,
  onUnassignRole,
}: {
  player: Roster.RosterPlayer;
  canManageRoles: boolean;
  availableRoles: ReadonlyArray<RoleApi.RoleInfo>;
  onAssignRole: (roleId: string) => Promise<void>;
  onUnassignRole: (roleId: string) => Promise<void>;
}) {
  const [selectedRoleId, setSelectedRoleId] = React.useState('');
  const [assigning, setAssigning] = React.useState(false);

  const assignableRoles = availableRoles.filter((r) => !player.roleNames.includes(r.name));

  const handleAssign = React.useCallback(async () => {
    if (!selectedRoleId) return;
    setAssigning(true);
    await onAssignRole(selectedRoleId);
    setSelectedRoleId('');
    setAssigning(false);
  }, [selectedRoleId, onAssignRole]);

  return (
    <div>
      {player.roleNames.length === 0 ? (
        <p className='text-muted-foreground'>{tr('roles_noRoles')}</p>
      ) : (
        <div className='flex flex-wrap gap-2 mb-4'>
          {player.roleNames.map((roleName) => {
            const roleInfo = availableRoles.find((r) => r.name === roleName);
            return (
              <Badge key={roleName} variant='secondary' className='gap-1 py-1'>
                {roleName}
                {canManageRoles && roleInfo ? (
                  <RemoveRoleControl
                    roleName={roleName}
                    onConfirm={() => onUnassignRole(roleInfo.roleId)}
                  />
                ) : null}
              </Badge>
            );
          })}
        </div>
      )}
      {canManageRoles && assignableRoles.length > 0 ? (
        <div className='flex gap-2 items-end'>
          <SearchableSelect
            value={selectedRoleId}
            onValueChange={setSelectedRoleId}
            placeholder={tr('roles_addRole')}
            options={assignableRoles.map((r) => ({ value: r.roleId, label: r.name }))}
            className='w-48'
          />
          <Button size='sm' disabled={!selectedRoleId || assigning} onClick={handleAssign}>
            {tr('roles_addRole')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function RemoveRoleControl({ roleName, onConfirm }: { roleName: string; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type='button'
          variant='ghost'
          size='icon'
          className='ml-1 size-6 text-muted-foreground hover:text-destructive'
        >
          <X className='size-3' aria-hidden='true' />
          <span className='sr-only'>{tr('roles_removeAria', { role: roleName })}</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tr('roles_removeRoleConfirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {tr('roles_removeRoleConfirmDescription', { role: roleName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{tr('roles_removeRoleCancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{tr('roles_removeRoleConfirm')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
