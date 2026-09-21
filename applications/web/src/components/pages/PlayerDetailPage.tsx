import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import type {
  Achievement,
  ActivityLog,
  ActivityLogApi,
  ActivityStatsApi,
  ActivityType,
  GroupApi,
  PlayerRatingApi,
  RoleApi,
  Roster,
} from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import { Option, Schema } from 'effect';
import { AlertTriangle, ExternalLink, Pencil, UserMinus, Users, X } from 'lucide-react';
import React from 'react';
import { useForm } from 'react-hook-form';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { DirtyFieldLabel } from '~/components/molecules/DirtyFieldLabel.js';
import { RoleBadge } from '~/components/molecules/RoleBadge.js';
import { SyncRolesButton } from '~/components/molecules/SyncRolesButton.js';
import { AchievementsGridI18n } from '~/components/organisms/AchievementsGrid.js';
import { ActivityLogList } from '~/components/organisms/ActivityLogList';
import { ActivityStatsCard } from '~/components/organisms/ActivityStatsCard';
import { MemberRatingCard } from '~/components/organisms/MemberRatingCard.js';
import { MemberSummaryHeader } from '~/components/organisms/MemberSummaryHeader.js';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
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
import { Form, FormControl, FormField, FormItem, FormMessage } from '~/components/ui/form';
import { Input } from '~/components/ui/input';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '~/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '~/components/ui/tooltip';
import { useFormatDate } from '~/hooks/useFormatDate.js';
import { resolveEffectiveRoles } from '~/lib/roles/resolveEffectiveRoles.js';
import { sortEffectiveRoles } from '~/lib/roles/role-order.js';
import { tr } from '~/lib/translations.js';

const isNotFutureDate = Schema.makeFilter<string>((value) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return true;
  return parsed.getTime() <= Date.now() ? true : tr('validation_birthDateFuture');
});

const isNonBlank = Schema.makeFilter<string>((value) =>
  value.trim().length > 0 ? true : tr('validation_required'),
);

const isVariableSymbolShape = Schema.makeFilter<string>((value) =>
  /^[0-9]{1,10}$/.test(value) ? true : tr('validation_variableSymbol'),
);

const PlayerEditSchema = Schema.Struct({
  name: Schema.NullOr(
    Schema.String.pipe(Schema.check(isNonBlank), Schema.check(Schema.isMaxLength(80))).annotate({
      message: tr('validation_displayNameTooLong'),
    }),
  ),
  variableSymbol: Schema.NullOr(Schema.String.pipe(Schema.check(isVariableSymbolShape))),
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
  memberRosters: ReadonlyArray<Roster.RosterInfo>;
  assignableRosters: ReadonlyArray<Roster.RosterInfo>;
  memberGroups: ReadonlyArray<GroupApi.GroupInfo>;
  assignableGroups: ReadonlyArray<GroupApi.GroupInfo>;
  canManageRosters: boolean;
  canManageGroups: boolean;
  canRemoveMember: boolean;
  activityStats: ActivityStatsApi.ActivityStatsResponse;
  achievements: ReadonlyArray<{ slug: Achievement.AchievementSlug; earned_at: string }>;
  isOwnProfile: boolean;
  activityLogs: ActivityLogApi.ActivityLogListResponse;
  activityTypes: ReadonlyArray<ActivityTypeOption>;
  rating?: PlayerRatingApi.MemberRatingResponse;
  teamMemberId?: string;
  onRefresh?: () => void;
  onSave: (values: PlayerEditValues) => Promise<boolean>;
  /** The server's 409 `VariableSymbolTaken` — the route resets it to `null` before every save
   * attempt. Rendered as a field-level message (never a toast, since it names another member and
   * a toast would vanish before that name was read). */
  variableSymbolConflict?: { holderMemberId: string; holderName: string | null } | null;
  onAssignRole: (roleId: string) => Promise<void>;
  onUnassignRole: (roleId: string) => Promise<void>;
  onSyncDiscordRoles: () => Promise<RoleApi.SyncMemberRolesResult | undefined>;
  onAddToRoster: (rosterId: string) => Promise<void>;
  onRemoveFromRoster: (rosterId: string) => Promise<void>;
  onAddToGroup: (groupId: string) => Promise<void>;
  onRemoveFromGroup: (groupId: string) => Promise<void>;
  onDeactivate: () => Promise<boolean>;
  onReactivate: () => Promise<boolean>;
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
  memberRosters,
  assignableRosters,
  memberGroups,
  assignableGroups,
  canManageRosters,
  canManageGroups,
  canRemoveMember,
  activityStats,
  achievements,
  isOwnProfile,
  activityLogs,
  activityTypes,
  rating,
  teamMemberId,
  onRefresh,
  onSave,
  variableSymbolConflict,
  onAssignRole,
  onUnassignRole,
  onSyncDiscordRoles,
  onAddToRoster,
  onRemoveFromRoster,
  onAddToGroup,
  onRemoveFromGroup,
  onDeactivate,
  onReactivate,
  onCreateLog,
  onUpdateLog,
  onDeleteLog,
}: PlayerDetailPageProps) {
  const { formatDate } = useFormatDate();
  const isInactive = !player.active;

  // Every group in the team the viewer knows about (their own groups + everything they could
  // still add the member to) — the only source of `name -> groupId` this page has for building
  // a link to the group that GRANTED an inherited role (`Roster.EffectiveRole.groupNames` carries
  // only names, not ids). Only populated when `canManageGroups` (see `members.$memberId.tsx`),
  // which is exactly when the forwarding link below is rendered.
  const groupNameToId = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const group of [...memberGroups, ...assignableGroups]) {
      map.set(group.name, group.groupId);
    }
    return map;
  }, [memberGroups, assignableGroups]);

  const getDefaultValues = React.useCallback(
    () => ({
      name: Option.getOrNull(player.name),
      variableSymbol: Option.getOrNull(player.variableSymbol),
      birthDate: Option.getOrNull(player.birthDate),
      gender: Option.getOrNull(player.gender),
      jerseyNumber: player.jerseyNumber.pipe(
        Option.map((v) => String(v)),
        Option.getOrNull,
      ),
    }),
    [player],
  );

  const form = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(PlayerEditSchema)),
    mode: 'onChange',
    defaultValues: getDefaultValues(),
  });

  const [isEditing, setIsEditing] = React.useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = React.useState(false);

  const dirtyFieldCount = Object.keys(form.formState.dirtyFields).length;
  const hasErrors = Object.keys(form.formState.errors).length > 0;

  const handleStartEditing = React.useCallback(() => {
    form.reset(getDefaultValues());
    setIsEditing(true);
  }, [form, getDefaultValues]);

  const handleCancelEditing = React.useCallback(() => {
    if (form.formState.isDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    setIsEditing(false);
  }, [form.formState.isDirty]);

  const handleConfirmDiscard = React.useCallback(() => {
    form.reset(getDefaultValues());
    setDiscardConfirmOpen(false);
    setIsEditing(false);
  }, [form, getDefaultValues]);

  const handleSubmit = React.useCallback(
    async (values: PlayerEditValues) => {
      const submittedValues = form.getValues();
      const succeeded = await onSave(values);
      if (succeeded) {
        form.reset(submittedValues);
        setIsEditing(false);
      }
    },
    [onSave, form],
  );

  const activityLogCardRef = React.useRef<HTMLDivElement>(null);
  const handleFocusActivityLog = React.useCallback(() => {
    activityLogCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // `SyncRolesButton` owns the idle/syncing/cooldown state machine and the 60s cooldown itself
  // (it amplifies Discord writes and the bot's role loop runs at concurrency: 1) — this adapter
  // only bridges `onSyncDiscordRoles`'s `| undefined` failure signal (already toasted by the
  // route's `run()`) into a rejection, matching `DiscordConnectCard`'s `handleSync`.
  const handleSyncDiscordRoles = React.useCallback(async () => {
    const result = await onSyncDiscordRoles();
    if (result === undefined) {
      throw new Error('Discord role sync failed');
    }
    return result;
  }, [onSyncDiscordRoles]);

  return (
    <div className='mx-auto flex max-w-3xl flex-col gap-6 lg:max-w-5xl'>
      <div>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId/members' params={{ teamId }}>
            ← {tr('members_backToMembers')}
          </Link>
        </Button>
        <MemberSummaryHeader
          player={player}
          canManageRoles={canManageRoles}
          isInactive={isInactive}
        />
      </div>

      {isInactive ? (
        <Alert variant='default'>
          <UserMinus aria-hidden='true' />
          <AlertTitle>{tr('members_inactiveBannerTitle')}</AlertTitle>
          <AlertDescription>{tr('members_inactiveBannerDescription')}</AlertDescription>
        </Alert>
      ) : null}

      <div className='grid gap-6 lg:grid-cols-2'>
        <Card>
          <CardHeader className='flex items-center justify-between'>
            <CardTitle>{tr('profile_complete_title')}</CardTitle>
            {canEdit && !isEditing && !isInactive ? (
              <Button type='button' variant='ghost' size='sm' onClick={handleStartEditing}>
                <Pencil className='size-4' aria-hidden='true' />
                {tr('members_editProfile')}
              </Button>
            ) : null}
          </CardHeader>
          <CardContent>
            {canEdit && isEditing ? (
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
                    {...form.register('variableSymbol')}
                    render={({ field }) => (
                      <FormItem>
                        <DirtyFieldLabel
                          label={tr('members_vs_label')}
                          dirty={Boolean(form.formState.dirtyFields.variableSymbol)}
                        />
                        <FormControl>
                          <Input
                            {...field}
                            value={field.value ?? ''}
                            onChange={(e) => {
                              field.onChange(e);
                            }}
                            aria-invalid={
                              variableSymbolConflict !== null &&
                              variableSymbolConflict !== undefined
                            }
                            aria-describedby={
                              variableSymbolConflict ? 'variable-symbol-conflict' : undefined
                            }
                          />
                        </FormControl>
                        <p className='text-xs text-muted-foreground'>{tr('members_vs_help')}</p>
                        {variableSymbolConflict ? (
                          <p id='variable-symbol-conflict' className='text-sm text-destructive'>
                            {tr('members_vs_duplicate', {
                              member: variableSymbolConflict.holderName ?? '—',
                            })}
                          </p>
                        ) : null}
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
                  <div className='flex items-center gap-2'>
                    <Button
                      type='submit'
                      disabled={!form.formState.isDirty || hasErrors || form.formState.isSubmitting}
                    >
                      {form.formState.isSubmitting
                        ? tr('members_saving')
                        : tr('members_saveChanges')}
                    </Button>
                    <Button type='button' variant='ghost' onClick={handleCancelEditing}>
                      {tr('common_cancel')}
                    </Button>
                  </div>
                  {form.formState.isDirty ? (
                    <CardFooter className='flex items-center justify-between gap-2 px-0'>
                      <p className='text-sm text-muted-foreground'>
                        {tr('members_unsavedChanges', { count: dirtyFieldCount })}
                      </p>
                    </CardFooter>
                  ) : null}
                </form>
              </Form>
            ) : (
              <ProfileReadOnlyView player={player} formatDate={formatDate} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className='flex items-center justify-between'>
            <CardTitle>{tr('roles_currentRoles')}</CardTitle>
            {canManageRoles && !isInactive ? (
              <SyncRolesButton onSync={handleSyncDiscordRoles} />
            ) : null}
          </CardHeader>
          <CardContent>
            <RolesSection
              player={player}
              canManageRoles={canManageRoles && !isInactive}
              canManageGroups={canManageGroups}
              teamId={teamId}
              groupNameToId={groupNameToId}
              availableRoles={availableRoles}
              onAssignRole={onAssignRole}
              onUnassignRole={onUnassignRole}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{tr('members_membershipsTitle')}</CardTitle>
          </CardHeader>
          <CardContent className='flex flex-col gap-6'>
            <div>
              <h3 className='mb-2 text-sm font-medium'>{tr('members_groupsTitle')}</h3>
              <MembershipsSection
                current={memberGroups}
                assignable={assignableGroups}
                canManage={canManageGroups && !isInactive}
                emptyLabel={tr('groups_noneForMember')}
                addPlaceholder={tr('members_addToGroup')}
                getId={(g) => g.groupId}
                getLabel={(g) => g.name}
                removeAriaLabel={(name) => tr('members_removeFromGroupAria', { group: name })}
                removeConfirmTitle={tr('members_removeFromGroupConfirmTitle')}
                removeConfirmDescription={(name) =>
                  tr('members_removeFromGroupConfirmDescription', { group: name })
                }
                removeConfirmConfirm={tr('members_removeFromGroupConfirmConfirm')}
                onAdd={onAddToGroup}
                onRemove={onRemoveFromGroup}
              />
            </div>
            <div>
              <h3 className='mb-2 text-sm font-medium'>{tr('members_rostersTitle')}</h3>
              <MembershipsSection
                current={memberRosters}
                assignable={assignableRosters}
                canManage={canManageRosters && !isInactive}
                emptyLabel={tr('rosters_noneForMember')}
                addPlaceholder={tr('members_addToRoster')}
                getId={(r) => r.rosterId}
                getLabel={(r) => r.name}
                removeAriaLabel={(name) => tr('members_removeFromRosterAria', { roster: name })}
                removeConfirmTitle={tr('members_removeFromRosterConfirmTitle')}
                removeConfirmDescription={(name) =>
                  tr('members_removeFromRosterConfirmDescription', { roster: name })
                }
                removeConfirmConfirm={tr('members_removeFromRosterConfirmConfirm')}
                onAdd={onAddToRoster}
                onRemove={onRemoveFromRoster}
              />
            </div>
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

      {canRemoveMember && !isOwnProfile ? (
        <DangerZoneCard
          isInactive={isInactive}
          onDeactivate={onDeactivate}
          onReactivate={onReactivate}
        />
      ) : null}

      <AlertDialog open={discardConfirmOpen} onOpenChange={setDiscardConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr('members_discardTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{tr('members_discardDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr('members_discardCancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDiscard}>
              {tr('members_discardConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ProfileReadOnlyView({
  player,
  formatDate,
}: {
  player: Roster.RosterPlayer;
  formatDate: (date: Date) => string;
}) {
  const genderLabel = player.gender.pipe(
    Option.map((g) => {
      if (g === 'male') return tr('profile_complete_genderMale');
      if (g === 'female') return tr('profile_complete_genderFemale');
      return tr('profile_complete_genderOther');
    }),
    Option.getOrElse(() => tr('members_fieldEmpty')),
  );
  const birthDateLabel = player.birthDate.pipe(
    Option.map((d) => formatDate(new Date(d))),
    Option.getOrElse(() => tr('members_fieldEmpty')),
  );
  const jerseyNumberLabel = player.jerseyNumber.pipe(
    Option.map((v) => `#${v}`),
    Option.getOrElse(() => tr('members_fieldEmpty')),
  );

  return (
    <div className='flex flex-col gap-2'>
      <p>
        <strong>{tr('profile_complete_displayName')}:</strong> {player.displayName}
      </p>
      <p>
        <strong>{tr('members_vs_label')}:</strong>{' '}
        {Option.isSome(player.variableSymbol) ? (
          <span className='tabular-nums'>{player.variableSymbol.value}</span>
        ) : (
          <span className='inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300'>
            <AlertTriangle className='size-3' aria-hidden='true' />
            {tr('members_vs_missing')}
          </span>
        )}
      </p>
      <p>
        <strong>{tr('profile_complete_birthDate')}:</strong> {birthDateLabel}
      </p>
      <p>
        <strong>{tr('profile_complete_gender')}:</strong> {genderLabel}
      </p>
      <p>
        <strong>{tr('profile_complete_jerseyNumber')}:</strong> {jerseyNumberLabel}
      </p>
    </div>
  );
}

function DangerZoneCard({
  isInactive,
  onDeactivate,
  onReactivate,
}: {
  isInactive: boolean;
  onDeactivate: () => Promise<boolean>;
  onReactivate: () => Promise<boolean>;
}) {
  const [pending, setPending] = React.useState(false);

  const handleDeactivate = React.useCallback(async () => {
    setPending(true);
    await onDeactivate();
    setPending(false);
  }, [onDeactivate]);

  const handleReactivate = React.useCallback(async () => {
    setPending(true);
    await onReactivate();
    setPending(false);
  }, [onReactivate]);

  return (
    <Card className='border-destructive/50'>
      <CardHeader>
        <CardTitle>{tr('members_dangerZoneTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        {isInactive ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type='button' variant='outline'>
                {tr('members_reactivateAction')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{tr('members_reactivateConfirmTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {tr('members_reactivateConfirmDescription')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{tr('common_cancel')}</AlertDialogCancel>
                <AlertDialogAction disabled={pending} onClick={handleReactivate}>
                  {tr('members_reactivateConfirmConfirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <div className='flex flex-col gap-2'>
            <p className='text-sm text-muted-foreground'>{tr('members_deactivateDescription')}</p>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type='button' variant='destructive' className='w-fit'>
                  {tr('members_deactivateAction')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{tr('members_deactivateConfirmTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {tr('members_deactivateConfirmDescription')}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{tr('common_cancel')}</AlertDialogCancel>
                  <AlertDialogAction disabled={pending} onClick={handleDeactivate}>
                    {tr('members_deactivateConfirmConfirm')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RolesSection({
  player,
  canManageRoles,
  canManageGroups,
  teamId,
  groupNameToId,
  availableRoles,
  onAssignRole,
  onUnassignRole,
}: {
  player: Roster.RosterPlayer;
  canManageRoles: boolean;
  canManageGroups: boolean;
  teamId: string;
  groupNameToId: ReadonlyMap<string, string>;
  availableRoles: ReadonlyArray<RoleApi.RoleInfo>;
  onAssignRole: (roleId: string) => Promise<void>;
  onUnassignRole: (roleId: string) => Promise<void>;
}) {
  const [selectedRoleId, setSelectedRoleId] = React.useState('');
  const [assigning, setAssigning] = React.useState(false);

  // Sorted with the same comparator `EffectiveRolesList` uses, so a member's badges appear in
  // one order everywhere (roster row, summary header, this section) instead of the detail page
  // showing raw query order.
  const effectiveRoles = sortEffectiveRoles(resolveEffectiveRoles(player, availableRoles));
  // Keyed on `roleId` (not `name` — name matching is fragile and gets worse once inherited
  // roles join the effective set), and filtered against the FULL effective set so a role
  // already shown as a badge (direct OR inherited) never also appears in "assign a role".
  const effectiveRoleIds = new Set(effectiveRoles.map((role) => role.roleId));
  const assignableRoles = availableRoles.filter((role) => !effectiveRoleIds.has(role.roleId));
  const hasInheritedRole = effectiveRoles.some(
    (role) => role.source === 'inherited' || role.source === 'both',
  );

  const handleAssign = React.useCallback(async () => {
    if (!selectedRoleId) return;
    setAssigning(true);
    await onAssignRole(selectedRoleId);
    setSelectedRoleId('');
    setAssigning(false);
  }, [selectedRoleId, onAssignRole]);

  return (
    <div>
      {effectiveRoles.length === 0 ? (
        <p className='text-muted-foreground'>{tr('roles_noRoles')}</p>
      ) : (
        <>
          <div className='flex flex-wrap gap-1 mb-2'>
            {effectiveRoles.map((role) => {
              // `'both'` keeps its remove control — the member holds it directly TOO, and
              // removing that direct grant is a real state change, unlike a purely
              // `'inherited'` role (removing a `member_roles` row that does not exist).
              const canRemoveDirectly = role.source === 'direct' || role.source === 'both';
              return (
                <div key={role.roleId} className='flex items-center gap-1'>
                  <RoleBadge role={role} />
                  {canManageRoles && canRemoveDirectly ? (
                    <RemoveMembershipControl
                      ariaLabel={tr('roles_removeAria', { role: role.name })}
                      confirmTitle={tr('roles_removeRoleConfirmTitle')}
                      confirmDescription={
                        role.source === 'both'
                          ? tr('roles_removeRoleStillInheritedDescription', {
                              role: role.name,
                              group: role.groupNames[0] ?? '',
                            })
                          : tr('roles_removeRoleConfirmDescription', { role: role.name })
                      }
                      confirmConfirm={tr('roles_removeRoleConfirm')}
                      cancelLabel={tr('roles_removeRoleCancel')}
                      onConfirm={() => onUnassignRole(role.roleId)}
                    />
                  ) : canManageRoles && role.source === 'inherited' ? (
                    <InheritedRoleForwardControl
                      teamId={teamId}
                      roleName={role.name}
                      groupNames={role.groupNames}
                      groupNameToId={groupNameToId}
                      canManageGroups={canManageGroups}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
          {canManageRoles && hasInheritedRole ? (
            <p className='mb-4 flex items-center gap-1.5 text-xs text-muted-foreground'>
              <Users className='size-3 shrink-0' aria-hidden='true' />
              {tr('roles_inheritedLegend')}
            </p>
          ) : null}
        </>
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

/**
 * Replaces the remove (`X`) control for a PURELY `inherited` role — never a disabled `X`, which
 * would say "you lack permission" (false: the captain IS allowed to remove it, just not from
 * this screen). Instead, an `ExternalLink` forwards to the group that grants it, gated on
 * `group:manage` (a viewer who cannot manage groups sees no button at all — nothing is missing,
 * because nothing is actionable). With 2+ granting groups, the single icon button becomes a
 * `Popover` listing one link per group.
 */
function InheritedRoleForwardControl({
  teamId,
  roleName,
  groupNames,
  groupNameToId,
  canManageGroups,
}: {
  teamId: string;
  roleName: string;
  groupNames: ReadonlyArray<string>;
  groupNameToId: ReadonlyMap<string, string>;
  canManageGroups: boolean;
}) {
  if (!canManageGroups) return null;

  const links = groupNames
    .map((name) => {
      const groupId = groupNameToId.get(name);
      return groupId ? { name, groupId } : undefined;
    })
    .filter((group): group is { name: string; groupId: string } => group !== undefined);

  // Degraded data (a data race between group deletion and page load, or the granting group is
  // outside the viewer's known group list): no attribution to forward to, so render nothing —
  // never a link to `undefined`.
  if (links.length === 0) return null;

  if (links.length === 1) {
    const group = links[0];
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              type='button'
              variant='ghost'
              size='icon'
              className='ml-1 size-6 text-muted-foreground hover:text-foreground'
            >
              <Link to='/teams/$teamId/groups/$groupId' params={{ teamId, groupId: group.groupId }}>
                <ExternalLink className='size-3' aria-hidden='true' />
                <span className='sr-only'>
                  {tr('roles_manageInGroupAria', { role: roleName, group: group.name })}
                </span>
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{tr('roles_manageInGroupTooltip', { group: group.name })}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='ghost'
          size='icon'
          className='ml-1 size-6 text-muted-foreground hover:text-foreground'
        >
          <ExternalLink className='size-3' aria-hidden='true' />
          <span className='sr-only'>
            {tr('roles_manageInGroupAria', {
              role: roleName,
              group: links.map((group) => group.name).join(tr('common_listSeparator')),
            })}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-56 p-2'>
        <PopoverTitle className='mb-1 px-1 text-sm'>
          {tr('roles_grantedByGroupsTitle')}
        </PopoverTitle>
        <ul className='flex flex-col gap-1'>
          {links.map((group) => (
            <li key={group.groupId}>
              <Button
                asChild
                variant='link'
                size='sm'
                className='h-auto justify-start px-1 text-xs'
              >
                <Link
                  to='/teams/$teamId/groups/$groupId'
                  params={{ teamId, groupId: group.groupId }}
                >
                  {group.name}
                </Link>
              </Button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

interface MembershipsSectionProps<T> {
  current: ReadonlyArray<T>;
  assignable: ReadonlyArray<T>;
  canManage: boolean;
  emptyLabel: string;
  addPlaceholder: string;
  getId: (item: T) => string;
  getLabel: (item: T) => string;
  removeAriaLabel: (label: string) => string;
  removeConfirmTitle: string;
  removeConfirmDescription: (label: string) => string;
  removeConfirmConfirm: string;
  onAdd: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}

function MembershipsSection<T>({
  current,
  assignable,
  canManage,
  emptyLabel,
  addPlaceholder,
  getId,
  getLabel,
  removeAriaLabel,
  removeConfirmTitle,
  removeConfirmDescription,
  removeConfirmConfirm,
  onAdd,
  onRemove,
}: MembershipsSectionProps<T>) {
  const [selectedId, setSelectedId] = React.useState('');
  const [assigning, setAssigning] = React.useState(false);

  const handleAdd = React.useCallback(async () => {
    if (!selectedId) return;
    setAssigning(true);
    await onAdd(selectedId);
    setSelectedId('');
    setAssigning(false);
  }, [selectedId, onAdd]);

  return (
    <div>
      {current.length === 0 ? (
        <p className='text-muted-foreground'>{emptyLabel}</p>
      ) : (
        <div className='flex flex-wrap gap-2 mb-4'>
          {current.map((item) => {
            const id = getId(item);
            const label = getLabel(item);
            return (
              <Badge key={id} variant='secondary' className='gap-1 py-1'>
                {label}
                {canManage ? (
                  <RemoveMembershipControl
                    ariaLabel={removeAriaLabel(label)}
                    confirmTitle={removeConfirmTitle}
                    confirmDescription={removeConfirmDescription(label)}
                    confirmConfirm={removeConfirmConfirm}
                    onConfirm={() => onRemove(id)}
                  />
                ) : null}
              </Badge>
            );
          })}
        </div>
      )}
      {canManage && assignable.length > 0 ? (
        <div className='flex gap-2 items-end'>
          <SearchableSelect
            value={selectedId}
            onValueChange={setSelectedId}
            placeholder={addPlaceholder}
            options={assignable.map((item) => ({ value: getId(item), label: getLabel(item) }))}
            className='w-48'
          />
          <Button size='sm' disabled={!selectedId || assigning} onClick={handleAdd}>
            {addPlaceholder}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function RemoveMembershipControl({
  ariaLabel,
  confirmTitle,
  confirmDescription,
  confirmConfirm,
  cancelLabel = tr('common_cancel'),
  onConfirm,
}: {
  ariaLabel: string;
  confirmTitle: string;
  confirmDescription: string;
  confirmConfirm: string;
  cancelLabel?: string;
  onConfirm: () => void;
}) {
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
          <span className='sr-only'>{ariaLabel}</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
          <AlertDialogDescription>{confirmDescription}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{confirmConfirm}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
