import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import type { EventSeriesApi, GroupApi, TrainingTypeApi } from '@sideline/domain';
import { Discord, EventSeries, GroupModel, Team, TrainingType } from '@sideline/domain';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import React from 'react';
import { useForm } from 'react-hook-form';

import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { Button } from '~/components/ui/button';
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
import { Textarea } from '~/components/ui/textarea';
import {
  dateOnlyToUtc,
  formatLocalDate,
  formatUtcTime,
  localToUtc,
  utcTimeToLocal,
} from '~/lib/datetime';
import { DISCORD_CHANNEL_TYPE_TEXT } from '~/lib/discord';
import { DAY_ORDER, dayFullLabels, dayShortLabels, sortDays } from '~/lib/event-labels';
import { toGroupOptions } from '~/lib/group-options';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

const CreateScheduleSchema = Schema.Struct({
  title: Schema.NonEmptyString.annotate({ message: tr('validation_required') }),
  description: Schema.String,
  frequency: EventSeries.RecurrenceFrequency.annotate({
    message: tr('validation_invalidOption'),
  }),
  daysOfWeek: EventSeries.DaysOfWeek,
  locationUrl: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter<string>((s) =>
        s === '' || s.startsWith('https://') ? true : tr('event_locationUrlInvalid'),
      ),
    ),
  ),
  startDate: Schema.NonEmptyString.annotate({ message: tr('validation_required') }),
  endDate: Schema.String,
  startTime: Schema.NonEmptyString.annotate({ message: tr('validation_required') }),
  endTime: Schema.String,
  location: Schema.String,
});

type CreateScheduleValues = Schema.Schema.Type<typeof CreateScheduleSchema>;

const NONE_VALUE = '__none__';

interface TrainingTypeDetailPageProps {
  teamId: string;
  trainingTypeId: string;
  trainingTypeDetail: TrainingTypeApi.TrainingTypeDetail;
  canAdmin: boolean;
  series: ReadonlyArray<EventSeriesApi.EventSeriesInfo>;
  discordChannels: ReadonlyArray<GroupApi.DiscordChannelInfo>;
  groups: ReadonlyArray<GroupApi.GroupInfo>;
}

export function TrainingTypeDetailPage({
  teamId,
  trainingTypeId,
  trainingTypeDetail,
  canAdmin,
  series,
  discordChannels,
  groups,
}: TrainingTypeDetailPageProps) {
  const run = useRun();
  const router = useRouter();
  const navigate = useNavigate();

  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const trainingTypeIdBranded = Schema.decodeSync(TrainingType.TrainingTypeId)(trainingTypeId);

  const [name, setName] = React.useState(trainingTypeDetail.name);
  const [channelId, setChannelId] = React.useState(
    Option.getOrElse(trainingTypeDetail.discordChannelId, () => NONE_VALUE),
  );
  const [ownerGroupId, setOwnerGroupId] = React.useState(
    Option.getOrElse(trainingTypeDetail.ownerGroupId, () => NONE_VALUE),
  );
  const [memberGroupId, setMemberGroupId] = React.useState(
    Option.getOrElse(trainingTypeDetail.memberGroupId, () => NONE_VALUE),
  );
  const [saving, setSaving] = React.useState(false);
  const [showCreateForm, setShowCreateForm] = React.useState(false);
  const [editingSeriesId, setEditingSeriesId] = React.useState<string | null>(null);

  const scheduleForm = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(CreateScheduleSchema)),
    mode: 'onChange',
    defaultValues: {
      title: trainingTypeDetail.name,
      description: '',
      frequency: 'weekly' as EventSeries.RecurrenceFrequency,
      daysOfWeek: [] as number[],
      locationUrl: '',
      startDate: new Date().toISOString().slice(0, 10),
      endDate: '',
      startTime: '',
      endTime: '',
      location: '',
    },
  });

  const watchedScheduleLocation = scheduleForm.watch('location');

  React.useEffect(() => {
    if (!watchedScheduleLocation) {
      scheduleForm.setValue('locationUrl', '');
    }
  }, [watchedScheduleLocation, scheduleForm]);

  const handleSaveName = React.useCallback(async () => {
    setSaving(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.trainingType.updateTrainingType({
          params: { teamId: teamIdBranded, trainingTypeId: trainingTypeIdBranded },
          payload: {
            name,
            discordChannelId: Option.some(
              channelId !== NONE_VALUE
                ? Option.some(Discord.Snowflake.makeUnsafe(channelId))
                : Option.none(),
            ),
            ownerGroupId: Option.some(
              ownerGroupId !== NONE_VALUE
                ? Option.some(Schema.decodeSync(GroupModel.GroupId)(ownerGroupId))
                : Option.none(),
            ),
            memberGroupId: Option.some(
              memberGroupId !== NONE_VALUE
                ? Option.some(Schema.decodeSync(GroupModel.GroupId)(memberGroupId))
                : Option.none(),
            ),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('trainingType_updateFailed'))),
      run({ success: tr('trainingType_saved') }),
    );
    setSaving(false);
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [
    teamIdBranded,
    trainingTypeIdBranded,
    name,
    channelId,
    ownerGroupId,
    memberGroupId,
    run,
    router,
  ]);

  const handleDelete = React.useCallback(async () => {
    if (!window.confirm(tr('trainingType_deleteConfirm'))) return;
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.trainingType.deleteTrainingType({
          params: { teamId: teamIdBranded, trainingTypeId: trainingTypeIdBranded },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('trainingType_deleteFailed'))),
      run({ success: tr('trainingType_deleted') }),
    );
    if (Option.isSome(result)) {
      navigate({ to: '/teams/$teamId/training-types', params: { teamId } });
    }
  }, [teamId, teamIdBranded, trainingTypeIdBranded, run, navigate]);

  const onSubmitSchedule = async (values: CreateScheduleValues) => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.eventSeries.createEventSeries({
          params: { teamId: teamIdBranded },
          payload: {
            title: values.title,
            trainingTypeId: Option.some(trainingTypeIdBranded),
            description: values.description ? Option.some(values.description) : Option.none(),
            frequency: values.frequency,
            daysOfWeek: values.daysOfWeek,
            startDate: dateOnlyToUtc(values.startDate),
            endDate: values.endDate ? Option.some(dateOnlyToUtc(values.endDate)) : Option.none(),
            startTime: formatUtcTime(localToUtc(values.startDate, values.startTime)),
            endTime: values.endTime
              ? Option.some(formatUtcTime(localToUtc(values.startDate, values.endTime)))
              : Option.none(),
            location: values.location ? Option.some(values.location) : Option.none(),
            locationUrl: values.locationUrl ? Option.some(values.locationUrl) : Option.none(),
            ownerGroupId: Option.none(),
            memberGroupId: Option.none(),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('trainingType_createScheduleFailed'))),
      run({ success: tr('trainingType_scheduleCreated') }),
    );
    if (Option.isSome(result)) {
      scheduleForm.reset();
      setShowCreateForm(false);
      router.invalidate();
    }
  };

  const handleCancelSchedule = React.useCallback(
    async (seriesId: string) => {
      if (!window.confirm(tr('trainingType_cancelScheduleConfirm'))) return;
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.eventSeries.cancelEventSeries({
            params: {
              teamId: teamIdBranded,
              seriesId: Schema.decodeSync(EventSeries.EventSeriesId)(seriesId),
            },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('event_cancelFailed'))),
        run({ success: tr('trainingType_scheduleCancelled') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [teamIdBranded, run, router],
  );

  const handleEditSchedule = React.useCallback(
    (s: EventSeriesApi.EventSeriesInfo) => {
      scheduleForm.reset({
        title: s.title,
        description: '',
        frequency: s.frequency,
        daysOfWeek: Array.from(s.daysOfWeek),
        startDate: formatLocalDate(s.startDate),
        endDate: Option.match(s.endDate, {
          onNone: () => '',
          onSome: formatLocalDate,
        }),
        startTime: utcTimeToLocal(s.startTime),
        endTime: Option.match(s.endTime, { onNone: () => '', onSome: utcTimeToLocal }),
        location: Option.getOrElse(s.location, () => ''),
        locationUrl: Option.getOrElse(s.locationUrl, () => ''),
      });
      setEditingSeriesId(s.seriesId);
      setShowCreateForm(true);
    },
    [scheduleForm],
  );

  const handleUpdateSchedule = async (values: CreateScheduleValues) => {
    if (!editingSeriesId) return;
    const seriesIdBranded = Schema.decodeSync(EventSeries.EventSeriesId)(editingSeriesId);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.eventSeries.updateEventSeries({
          params: { teamId: teamIdBranded, seriesId: seriesIdBranded },
          payload: {
            title: Option.some(values.title),
            trainingTypeId: Option.none(),
            description: Option.some(
              values.description ? Option.some(values.description) : Option.none(),
            ),
            daysOfWeek: Option.some(values.daysOfWeek),
            startTime: Option.some(formatUtcTime(localToUtc(values.startDate, values.startTime))),
            endTime: Option.some(
              values.endTime
                ? Option.some(formatUtcTime(localToUtc(values.startDate, values.endTime)))
                : Option.none(),
            ),
            location: Option.some(values.location ? Option.some(values.location) : Option.none()),
            locationUrl: Option.some(
              values.locationUrl ? Option.some(values.locationUrl) : Option.none(),
            ),
            endDate: Option.some(
              values.endDate ? Option.some(dateOnlyToUtc(values.endDate)) : Option.none(),
            ),
            ownerGroupId: Option.none(),
            memberGroupId: Option.none(),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('trainingType_updateScheduleFailed'))),
      run({ success: tr('trainingType_scheduleUpdated') }),
    );
    if (Option.isSome(result)) {
      setEditingSeriesId(null);
      setShowCreateForm(false);
      scheduleForm.reset({
        title: trainingTypeDetail.name,
        description: '',
        frequency: 'weekly',
        daysOfWeek: [],
        locationUrl: '',
        startDate: new Date().toISOString().slice(0, 10),
        endDate: '',
        startTime: '',
        endTime: '',
        location: '',
      });
      router.invalidate();
    }
  };

  const activeSeries = series.filter((s) => s.status === 'active');

  return (
    <div>
      <header className='mb-8'>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId/training-types' params={{ teamId }}>
            ← {tr('trainingType_backToTrainingTypes')}
          </Link>
        </Button>
        <h1 className='text-2xl font-bold'>{trainingTypeDetail.name}</h1>
        {Option.isSome(trainingTypeDetail.ownerGroupName) && (
          <p className='text-muted-foreground'>
            {tr('trainingType_ownerGroupName')}: {trainingTypeDetail.ownerGroupName.value}
          </p>
        )}
        {Option.isSome(trainingTypeDetail.memberGroupName) && (
          <p className='text-muted-foreground'>
            {tr('trainingType_memberGroupName')}: {trainingTypeDetail.memberGroupName.value}
          </p>
        )}
      </header>

      <div className='flex flex-col gap-6'>
        {/* Rename */}
        <div>
          <label htmlFor='training-type-name' className='text-sm font-medium mb-1 block'>
            {tr('trainingType_rename')}
          </label>
          <div className='flex gap-2'>
            <Input
              id='training-type-name'
              value={name}
              onChange={(e) => setName(e.target.value)}
              className='flex-1'
            />
            <Button
              onClick={handleSaveName}
              disabled={
                saving ||
                (name === trainingTypeDetail.name &&
                  channelId ===
                    Option.getOrElse(trainingTypeDetail.discordChannelId, () => NONE_VALUE) &&
                  ownerGroupId ===
                    Option.getOrElse(trainingTypeDetail.ownerGroupId, () => NONE_VALUE) &&
                  memberGroupId ===
                    Option.getOrElse(trainingTypeDetail.memberGroupId, () => NONE_VALUE))
              }
            >
              {saving ? tr('trainingType_saving') : tr('trainingType_saveChanges')}
            </Button>
          </div>
        </div>

        {/* Default Discord Channel */}
        {canAdmin && discordChannels.length > 0 && (
          <div>
            <label htmlFor='discord-channel' className='text-sm font-medium mb-1 block'>
              {tr('trainingType_discordChannel')}
            </label>
            <p className='text-xs text-muted-foreground mb-2'>
              {tr('trainingType_discordChannelHelp')}
            </p>
            <SearchableSelect
              value={channelId}
              onValueChange={setChannelId}
              placeholder={tr('event_useDefault')}
              options={[
                { value: NONE_VALUE, label: tr('event_useDefault') },
                ...discordChannels
                  .filter((ch) => ch.type === DISCORD_CHANNEL_TYPE_TEXT)
                  .map((ch) => ({ value: ch.id, label: `# ${ch.name}` })),
              ]}
              pinnedValues={[NONE_VALUE]}
              className='max-w-xs'
            />
          </div>
        )}

        {/* Group Selectors */}
        {canAdmin && groups.length > 0 && (
          <div className='flex flex-col gap-4 sm:flex-row'>
            <div className='flex-1'>
              <label htmlFor='owner-group' className='text-sm font-medium mb-1 block'>
                {tr('event_ownerGroup')}
              </label>
              <p className='text-xs text-muted-foreground mb-2'>{tr('event_ownerGroupHelp')}</p>
              <SearchableSelect
                value={ownerGroupId}
                onValueChange={setOwnerGroupId}
                placeholder={tr('event_useDefault')}
                options={[
                  { value: NONE_VALUE, label: tr('event_useDefault') },
                  ...toGroupOptions(groups),
                ]}
                pinnedValues={[NONE_VALUE]}
                className='w-full sm:max-w-xs'
              />
            </div>
            <div className='flex-1'>
              <label htmlFor='member-group' className='text-sm font-medium mb-1 block'>
                {tr('event_memberGroup')}
              </label>
              <p className='text-xs text-muted-foreground mb-2'>{tr('event_memberGroupHelp')}</p>
              <SearchableSelect
                value={memberGroupId}
                onValueChange={setMemberGroupId}
                placeholder={tr('event_useDefault')}
                options={[
                  { value: NONE_VALUE, label: tr('event_useDefault') },
                  ...toGroupOptions(groups),
                ]}
                pinnedValues={[NONE_VALUE]}
                className='w-full sm:max-w-xs'
              />
            </div>
          </div>
        )}

        {/* Recurring Schedules */}
        {canAdmin && (
          <div>
            <h2 className='text-lg font-semibold mb-3'>{tr('trainingType_recurringSchedules')}</h2>

            {activeSeries.length === 0 && !showCreateForm && (
              <p className='text-muted-foreground mb-3'>{tr('trainingType_noSchedules')}</p>
            )}

            {activeSeries.length > 0 && (
              <div className='overflow-x-auto mb-4'>
                <table className='w-full min-w-[480px]'>
                  <tbody>
                    {activeSeries.map((s) => (
                      <tr key={s.seriesId} className='border-b'>
                        <td className='py-2 px-4 font-medium'>{s.title}</td>
                        <td className='hidden sm:table-cell py-2 px-4 text-muted-foreground'>
                          {s.frequency === 'weekly'
                            ? tr('event_frequency_weekly')
                            : tr('event_frequency_biweekly')}
                        </td>
                        <td className='py-2 px-4 text-muted-foreground'>
                          {s.daysOfWeek.map((d) => dayShortLabels[d]()).join(', ')}
                        </td>
                        <td className='py-2 px-4 text-muted-foreground'>
                          {utcTimeToLocal(s.startTime)}
                          {s.endTime.pipe(
                            Option.map((v) => ` - ${utcTimeToLocal(v)}`),
                            Option.getOrElse(() => ''),
                          )}
                        </td>
                        <td className='hidden sm:table-cell py-2 px-4 text-muted-foreground'>
                          {formatLocalDate(s.startDate)} →{' '}
                          {Option.match(s.endDate, {
                            onNone: () => tr('event_ongoing'),
                            onSome: formatLocalDate,
                          })}
                        </td>
                        <td className='py-2 px-4'>
                          <div className='flex gap-2 flex-wrap'>
                            <Button
                              variant='outline'
                              size='sm'
                              onClick={() => handleEditSchedule(s)}
                            >
                              {tr('trainingType_editSchedule')}
                            </Button>
                            <Button
                              variant='outline'
                              size='sm'
                              onClick={() => handleCancelSchedule(s.seriesId)}
                            >
                              {tr('trainingType_cancelSchedule')}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {showCreateForm ? (
              <div className='max-w-lg'>
                <Form {...scheduleForm}>
                  <form
                    onSubmit={scheduleForm.handleSubmit(
                      editingSeriesId ? handleUpdateSchedule : onSubmitSchedule,
                    )}
                    className='flex flex-col gap-4'
                  >
                    <FormField
                      {...scheduleForm.register('title')}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{tr('event_title')}</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder={tr('event_titlePlaceholder')} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {!editingSeriesId && (
                      <div className='flex flex-col gap-4 sm:flex-row'>
                        <FormField
                          {...scheduleForm.register('frequency')}
                          render={({ field }) => (
                            <FormItem className='flex-1'>
                              <FormLabel>{tr('event_frequency')}</FormLabel>
                              <Select onValueChange={field.onChange} value={field.value}>
                                <FormControl>
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  <SelectItem value='weekly'>
                                    {tr('event_frequency_weekly')}
                                  </SelectItem>
                                  <SelectItem value='biweekly'>
                                    {tr('event_frequency_biweekly')}
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          name='daysOfWeek'
                          control={scheduleForm.control}
                          render={({ field }) => (
                            <FormItem className='flex-1'>
                              <FormLabel>{tr('event_daysOfWeek')}</FormLabel>
                              <div className='flex gap-1'>
                                {DAY_ORDER.map((d) => {
                                  const selected = (field.value as number[]).includes(d);
                                  return (
                                    <Button
                                      key={d}
                                      type='button'
                                      size='sm'
                                      variant={selected ? 'default' : 'outline'}
                                      className='w-10'
                                      aria-pressed={selected}
                                      aria-label={dayFullLabels[d]()}
                                      onClick={() => {
                                        const current = field.value as number[];
                                        field.onChange(
                                          sortDays(
                                            selected
                                              ? current.filter((v) => v !== d)
                                              : [...current, d],
                                          ),
                                        );
                                      }}
                                    >
                                      {dayShortLabels[d]()}
                                    </Button>
                                  );
                                })}
                              </div>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    )}
                    <div className='flex flex-col gap-4 sm:flex-row'>
                      {!editingSeriesId && (
                        <FormField
                          {...scheduleForm.register('startDate')}
                          render={({ field }) => (
                            <FormItem className='flex-1'>
                              <FormLabel>{tr('event_startDate')}</FormLabel>
                              <FormControl>
                                <Input {...field} type='date' />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      )}
                      <FormField
                        {...scheduleForm.register('endDate')}
                        render={({ field }) => (
                          <FormItem className='flex-1'>
                            <FormLabel>{tr('event_endDate')}</FormLabel>
                            <FormControl>
                              <Input {...field} type='date' />
                            </FormControl>
                            <p className='text-xs text-muted-foreground'>
                              {tr('event_endDateHelp')}
                            </p>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                    <div className='flex flex-col gap-4 sm:flex-row'>
                      <FormField
                        {...scheduleForm.register('startTime')}
                        render={({ field }) => (
                          <FormItem className='flex-1'>
                            <FormLabel>{tr('event_startTime')}</FormLabel>
                            <FormControl>
                              <Input {...field} type='time' />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        {...scheduleForm.register('endTime')}
                        render={({ field }) => (
                          <FormItem className='flex-1'>
                            <FormLabel>{tr('event_endTime')}</FormLabel>
                            <FormControl>
                              <Input {...field} type='time' />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                    <FormField
                      {...scheduleForm.register('location')}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{tr('event_location')}</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder={tr('event_locationPlaceholder')} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      {...scheduleForm.register('locationUrl')}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{tr('event_locationUrl')}</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              type='url'
                              inputMode='url'
                              autoComplete='url'
                              placeholder={tr('event_locationUrlPlaceholder')}
                              disabled={!scheduleForm.watch('location')}
                            />
                          </FormControl>
                          <p className='text-xs text-muted-foreground'>
                            {tr('event_locationUrlHelp')}
                          </p>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      {...scheduleForm.register('description')}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{tr('event_description')}</FormLabel>
                          <FormControl>
                            <Textarea
                              {...field}
                              placeholder={tr('event_descriptionPlaceholder')}
                              rows={3}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <div className='flex gap-2'>
                      <Button type='submit' disabled={scheduleForm.formState.isSubmitting}>
                        {editingSeriesId
                          ? tr('trainingType_updateSchedule')
                          : tr('trainingType_createSchedule')}
                      </Button>
                      <Button
                        type='button'
                        variant='outline'
                        onClick={() => {
                          setShowCreateForm(false);
                          setEditingSeriesId(null);
                          scheduleForm.reset({
                            title: trainingTypeDetail.name,
                            description: '',
                            frequency: 'weekly',
                            daysOfWeek: [],
                            locationUrl: '',
                            startDate: new Date().toISOString().slice(0, 10),
                            endDate: '',
                            startTime: '',
                            endTime: '',
                            location: '',
                          });
                        }}
                      >
                        {tr('guild_back')}
                      </Button>
                    </div>
                  </form>
                </Form>
              </div>
            ) : (
              <Button variant='outline' onClick={() => setShowCreateForm(true)}>
                {tr('trainingType_createSchedule')}
              </Button>
            )}
          </div>
        )}

        {/* Delete */}
        {canAdmin && (
          <div>
            <Button variant='destructive' onClick={handleDelete}>
              {tr('trainingType_deleteTrainingType')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
