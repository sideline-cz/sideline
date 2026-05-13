import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import type {
  Achievement,
  ActivityLog,
  ActivityLogApi,
  ActivityStatsApi,
  ActivityType,
  RoleApi,
  Roster,
} from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { Link } from '@tanstack/react-router';
import { Option, Schema } from 'effect';
import React from 'react';
import { useForm } from 'react-hook-form';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { AchievementsGridI18n } from '~/components/organisms/AchievementsGrid.js';
import { ActivityLogList } from '~/components/organisms/ActivityLogList';
import { ActivityStatsCard } from '~/components/organisms/ActivityStatsCard';
import { Button } from '~/components/ui/button';
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

const PlayerEditSchema = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  birthDate: Schema.NullOr(Schema.String),
  gender: Schema.NullOr(Schema.Literals(['male', 'female', 'other'])),
  jerseyNumber: Schema.NullOr(
    Schema.NumberFromString.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isBetween({ minimum: 0, maximum: 99 })),
    ).annotate({
      message: m.validation_jerseyNumber(),
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
  onSave: (values: PlayerEditValues) => Promise<void>;
  onAssignRole: (roleId: string) => Promise<void>;
  onUnassignRole: (roleId: string) => Promise<void>;
  onCreateLog: (input: {
    activityTypeId: ActivityType.ActivityTypeId;
    durationMinutes: Option.Option<number>;
    note: Option.Option<string>;
  }) => Promise<void>;
  onUpdateLog: (
    logId: ActivityLog.ActivityLogId,
    input: {
      activityTypeId: Option.Option<ActivityType.ActivityTypeId>;
      durationMinutes: Option.Option<Option.Option<number>>;
      note: Option.Option<Option.Option<string>>;
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

  const displayName = Option.getOrElse(player.name, () => player.username);

  return (
    <div>
      <header className='mb-8'>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId/members' params={{ teamId }}>
            ← {m.members_backToMembers()}
          </Link>
        </Button>
        <h1 className='text-2xl font-bold'>{displayName}</h1>
      </header>
      {canEdit ? (
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSave)} className='flex flex-col gap-4'>
            <FormField
              {...form.register('name')}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{m.profile_complete_displayName()}</FormLabel>
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
                  <FormLabel>{m.profile_complete_birthDate()}</FormLabel>
                  <FormControl>
                    <DatePicker
                      value={field.value ?? ''}
                      onChange={field.onChange}
                      placeholder={m.profile_complete_birthDatePlaceholder()}
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
                  <FormLabel>{m.profile_complete_gender()}</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value ?? ''}>
                    <FormControl>
                      <SelectTrigger className='w-full'>
                        <SelectValue placeholder={m.profile_complete_genderPlaceholder()} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value='male'>{m.profile_complete_genderMale()}</SelectItem>
                      <SelectItem value='female'>{m.profile_complete_genderFemale()}</SelectItem>
                      <SelectItem value='other'>{m.profile_complete_genderOther()}</SelectItem>
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
                  <FormLabel>{m.profile_complete_jerseyNumber()}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value ?? ''}
                      placeholder={m.profile_complete_jerseyNumberPlaceholder()}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type='submit' disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? m.members_saving() : m.members_saveChanges()}
            </Button>
          </form>
        </Form>
      ) : (
        <div className='flex flex-col gap-2'>
          <p>
            <strong>{m.profile_complete_jerseyNumber()}:</strong>{' '}
            {player.jerseyNumber.pipe(
              Option.map((v) => `#${v}`),
              Option.getOrElse(() => '—'),
            )}
          </p>
        </div>
      )}
      <RolesSection
        player={player}
        canManageRoles={canManageRoles}
        availableRoles={availableRoles}
        onAssignRole={onAssignRole}
        onUnassignRole={onUnassignRole}
      />
      <AchievementsGridI18n
        earnedAchievements={achievements.map((a) => ({
          achievement_slug: a.slug,
          earned_at: new Date(a.earned_at),
        }))}
      />
      <ActivityStatsCard stats={activityStats} />
      <ActivityLogList
        logs={activityLogs.logs}
        isOwnProfile={isOwnProfile}
        activityTypes={activityTypes}
        onCreateLog={onCreateLog}
        onUpdateLog={onUpdateLog}
        onDeleteLog={onDeleteLog}
      />
    </div>
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
    <div className='mt-6'>
      <h2 className='text-lg font-semibold mb-2'>{m.roles_currentRoles()}</h2>
      {player.roleNames.length === 0 ? (
        <p className='text-muted-foreground'>{m.roles_noRoles()}</p>
      ) : (
        <div className='flex flex-wrap gap-2 mb-4'>
          {player.roleNames.map((roleName) => {
            const roleInfo = availableRoles.find((r) => r.name === roleName);
            return (
              <span
                key={roleName}
                className='inline-flex items-center gap-1 rounded-full bg-secondary px-3 py-1 text-sm'
              >
                {roleName}
                {canManageRoles && roleInfo ? (
                  <button
                    type='button'
                    className='ml-1 text-muted-foreground hover:text-destructive'
                    onClick={() => onUnassignRole(roleInfo.roleId)}
                  >
                    x
                  </button>
                ) : null}
              </span>
            );
          })}
        </div>
      )}
      {canManageRoles && assignableRoles.length > 0 ? (
        <div className='flex gap-2 items-end'>
          <SearchableSelect
            value={selectedRoleId}
            onValueChange={setSelectedRoleId}
            placeholder={m.roles_addRole()}
            options={assignableRoles.map((r) => ({ value: r.roleId, label: r.name }))}
            className='w-48'
          />
          <Button size='sm' disabled={!selectedRoleId || assigning} onClick={handleAssign}>
            {m.roles_addRole()}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
