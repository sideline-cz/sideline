import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import type { EventApi, GroupApi, TrainingTypeApi } from '@sideline/domain';
import { Discord, Event, EventSeries, GroupModel, Team, TrainingType } from '@sideline/domain';
import { Link, useRouter, useRouterState } from '@tanstack/react-router';
import { DateTime, Effect, Option, Schema } from 'effect';
import { CalendarDays, List, Loader2, ShieldCheck } from 'lucide-react';
import React from 'react';
import { useForm } from 'react-hook-form';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { EventCalendarView } from '~/components/organisms/EventCalendarView';
import { Badge } from '~/components/ui/badge';
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
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Switch } from '~/components/ui/switch';
import { Textarea } from '~/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '~/components/ui/tooltip';
import { dateOnlyToUtc, formatEventDateRange, formatUtcTime, localToUtc } from '~/lib/datetime.js';
import { DISCORD_CHANNEL_TYPE_TEXT } from '~/lib/discord';
import {
  DAY_ORDER,
  dayFullLabels,
  dayShortLabels,
  eventStatusClasses,
  eventStatusLabels,
  eventTypeLabels,
  sortDays,
} from '~/lib/event-labels';
import { toGroupOptions } from '~/lib/group-options';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

const NONE_VALUE = '__none__';

const CreateEventSchema = Schema.Struct({
  title: Schema.NonEmptyString.annotate({ message: tr('validation_required') }),
  eventType: Event.EventType.annotate({ message: tr('validation_invalidOption') }),
  trainingTypeId: Schema.String,
  description: Schema.String,
  imageUrl: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter<string>((s) =>
        s === '' || s.startsWith('https://') ? true : tr('event_imageUrlInvalid'),
      ),
    ),
  ),
  locationUrl: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter<string>((s) =>
        s === '' || s.startsWith('https://') ? true : tr('event_locationUrlInvalid'),
      ),
    ),
  ),
  allDay: Schema.Boolean,
  startDate: Schema.NonEmptyString.annotate({ message: tr('validation_required') }),
  // Required only for timed events; validated in onSubmit so all-day events can omit it.
  startTime: Schema.String,
  endDate: Schema.String,
  endTime: Schema.String,
  location: Schema.String,
  discordChannelId: Schema.String,
  ownerGroupId: Schema.String,
  memberGroupId: Schema.String,
});

type CreateEventValues = Schema.Schema.Type<typeof CreateEventSchema>;

const CreateSeriesSchema = Schema.Struct({
  title: Schema.NonEmptyString.annotate({ message: tr('validation_required') }),
  trainingTypeId: Schema.String,
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
  discordChannelId: Schema.String,
  ownerGroupId: Schema.String,
  memberGroupId: Schema.String,
});

type CreateSeriesValues = Schema.Schema.Type<typeof CreateSeriesSchema>;

interface EventsListPageProps {
  teamId: string;
  events: ReadonlyArray<EventApi.EventInfo>;
  canCreate: boolean;
  canViewAll: boolean;
  showAllGroups: boolean;
  onShowAllGroupsChange: (value: boolean) => void;
  trainingTypes: ReadonlyArray<TrainingTypeApi.TrainingTypeInfo>;
  discordChannels: ReadonlyArray<GroupApi.DiscordChannelInfo>;
  groups: ReadonlyArray<GroupApi.GroupInfo>;
}

export function EventsListPage({
  teamId,
  events,
  canCreate,
  canViewAll,
  showAllGroups,
  onShowAllGroupsChange,
  trainingTypes,
  discordChannels,
  groups,
}: EventsListPageProps) {
  const run = useRun();
  const router = useRouter();
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const [viewMode, setViewMode] = React.useState<'list' | 'calendar'>('list');
  const [mode, setMode] = React.useState<'one-time' | 'recurring'>('one-time');
  // Started/cancelled events are hidden from the list by default; the calendar always shows all.
  const [showHidden, setShowHidden] = React.useState(false);
  const isPending = useRouterState({ select: (s) => s.status === 'pending' });
  const hiddenCount = events.filter((e) => e.status !== 'active').length;
  const visibleEvents = showHidden ? events : events.filter((e) => e.status === 'active');

  const form = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(CreateEventSchema)),
    mode: 'onChange',
    defaultValues: {
      title: '',
      eventType: 'training' as Event.EventType,
      trainingTypeId: NONE_VALUE,
      description: '',
      imageUrl: '',
      locationUrl: '',
      allDay: false,
      startDate: '',
      startTime: '',
      endDate: '',
      endTime: '',
      location: '',
      discordChannelId: NONE_VALUE,
      ownerGroupId: NONE_VALUE,
      memberGroupId: NONE_VALUE,
    },
  });

  const watchedEventType = form.watch('eventType');
  const watchedAllDay = form.watch('allDay');

  const seriesForm = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(CreateSeriesSchema)),
    mode: 'onChange',
    defaultValues: {
      title: '',
      trainingTypeId: NONE_VALUE,
      description: '',
      frequency: 'weekly' as EventSeries.RecurrenceFrequency,
      daysOfWeek: [] as number[],
      locationUrl: '',
      startDate: new Date().toISOString().slice(0, 10),
      endDate: '',
      startTime: '',
      endTime: '',
      location: '',
      discordChannelId: NONE_VALUE,
      ownerGroupId: NONE_VALUE,
      memberGroupId: NONE_VALUE,
    },
  });

  const watchedLocation = form.watch('location');
  const watchedSeriesLocation = seriesForm.watch('location');

  React.useEffect(() => {
    if (watchedEventType !== 'training') {
      form.setValue('trainingTypeId', NONE_VALUE);
    }
  }, [watchedEventType, form]);

  React.useEffect(() => {
    if (!watchedLocation) {
      form.setValue('locationUrl', '');
    }
  }, [watchedLocation, form]);

  React.useEffect(() => {
    if (!watchedSeriesLocation) {
      seriesForm.setValue('locationUrl', '');
    }
  }, [watchedSeriesLocation, seriesForm]);

  const onSubmit = async (values: CreateEventValues) => {
    if (!values.allDay && !values.startTime) {
      form.setError('startTime', { message: tr('validation_required') });
      return;
    }
    const startAt = values.allDay
      ? dateOnlyToUtc(values.startDate)
      : localToUtc(values.startDate, values.startTime);
    const endAt = values.allDay
      ? values.endDate
        ? dateOnlyToUtc(values.endDate)
        : null
      : values.endTime
        ? localToUtc(values.endDate || values.startDate, values.endTime)
        : null;
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.event.createEvent({
          params: { teamId: teamIdBranded },
          payload: {
            title: values.title,
            eventType: values.eventType,
            trainingTypeId:
              values.trainingTypeId && values.trainingTypeId !== NONE_VALUE
                ? Option.some(Schema.decodeSync(TrainingType.TrainingTypeId)(values.trainingTypeId))
                : Option.none(),
            description: values.description ? Option.some(values.description) : Option.none(),
            imageUrl: values.imageUrl ? Option.some(values.imageUrl) : Option.none(),
            locationUrl: values.locationUrl ? Option.some(values.locationUrl) : Option.none(),
            startAt,
            endAt: endAt ? Option.some(endAt) : Option.none(),
            allDay: values.allDay,
            location: values.location ? Option.some(values.location) : Option.none(),
            discordChannelId:
              values.discordChannelId && values.discordChannelId !== NONE_VALUE
                ? Option.some(Discord.Snowflake.makeUnsafe(values.discordChannelId))
                : Option.none(),
            ownerGroupId:
              values.ownerGroupId && values.ownerGroupId !== NONE_VALUE
                ? Option.some(Schema.decodeSync(GroupModel.GroupId)(values.ownerGroupId))
                : Option.none(),
            memberGroupId:
              values.memberGroupId && values.memberGroupId !== NONE_VALUE
                ? Option.some(Schema.decodeSync(GroupModel.GroupId)(values.memberGroupId))
                : Option.none(),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('event_createFailed'))),
      run({ success: tr('event_eventCreated') }),
    );
    if (Option.isSome(result)) {
      form.reset();
      router.invalidate();
    }
  };

  const onSubmitSeries = async (values: CreateSeriesValues) => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.eventSeries.createEventSeries({
          params: { teamId: teamIdBranded },
          payload: {
            title: values.title,
            trainingTypeId:
              values.trainingTypeId && values.trainingTypeId !== NONE_VALUE
                ? Option.some(Schema.decodeSync(TrainingType.TrainingTypeId)(values.trainingTypeId))
                : Option.none(),
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
            discordChannelId:
              values.discordChannelId && values.discordChannelId !== NONE_VALUE
                ? Option.some(Discord.Snowflake.makeUnsafe(values.discordChannelId))
                : Option.none(),
            ownerGroupId:
              values.ownerGroupId && values.ownerGroupId !== NONE_VALUE
                ? Option.some(Schema.decodeSync(GroupModel.GroupId)(values.ownerGroupId))
                : Option.none(),
            memberGroupId:
              values.memberGroupId && values.memberGroupId !== NONE_VALUE
                ? Option.some(Schema.decodeSync(GroupModel.GroupId)(values.memberGroupId))
                : Option.none(),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('event_createSeriesFailed'))),
      run({ success: tr('event_seriesCreated') }),
    );
    if (Option.isSome(result)) {
      seriesForm.reset();
      router.invalidate();
    }
  };

  return (
    <div>
      <header className='mb-8'>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId' params={{ teamId }}>
            ← {tr('team_backToTeams')}
          </Link>
        </Button>
        <div className='flex items-center gap-3'>
          <h1 className='text-2xl font-bold'>{tr('event_events')}</h1>
          <div className='flex rounded-md border'>
            <Button
              variant={viewMode === 'list' ? 'default' : 'ghost'}
              size='icon'
              className='rounded-r-none h-8 w-8'
              onClick={() => setViewMode('list')}
              title={tr('event_viewList')}
            >
              <List className='h-4 w-4' />
            </Button>
            <Button
              variant={viewMode === 'calendar' ? 'default' : 'ghost'}
              size='icon'
              className='rounded-l-none h-8 w-8'
              onClick={() => setViewMode('calendar')}
              title={tr('event_viewCalendar')}
            >
              <CalendarDays className='h-4 w-4' />
            </Button>
          </div>
        </div>
      </header>

      {viewMode === 'calendar' ? (
        <div
          className={isPending ? 'opacity-60 pointer-events-none transition-opacity' : undefined}
          aria-busy={isPending}
        >
          <EventCalendarView teamId={teamId} events={events} trainingTypes={trainingTypes} />
        </div>
      ) : (
        <div className='flex flex-col gap-6 lg:grid lg:grid-cols-[1fr_420px]'>
          <div className='order-2 lg:order-2 lg:sticky lg:top-20 lg:self-start'>
            {canCreate && (
              <div className='mb-8'>
                <div className='flex gap-2 mb-4'>
                  <Button
                    variant={mode === 'one-time' ? 'default' : 'outline'}
                    size='sm'
                    onClick={() => setMode('one-time')}
                  >
                    {tr('event_oneTime')}
                  </Button>
                  <Button
                    variant={mode === 'recurring' ? 'default' : 'outline'}
                    size='sm'
                    onClick={() => setMode('recurring')}
                  >
                    {tr('event_recurring')}
                  </Button>
                </div>

                {mode === 'one-time' ? (
                  <Form key='one-time' {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className='flex flex-col gap-4'>
                      <FormField
                        {...form.register('title')}
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
                      <div className='flex flex-col gap-4 sm:flex-row'>
                        <FormField
                          {...form.register('eventType')}
                          render={({ field }) => (
                            <FormItem className='flex-1'>
                              <FormLabel>{tr('event_eventType')}</FormLabel>
                              <Select onValueChange={field.onChange} value={field.value}>
                                <FormControl>
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  {Event.EventType.literals.map((type) => (
                                    <SelectItem key={type} value={type}>
                                      {eventTypeLabels[type]()}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        {watchedEventType === 'training' && (
                          <FormField
                            {...form.register('trainingTypeId')}
                            render={({ field }) => (
                              <FormItem className='flex-1'>
                                <FormLabel>{tr('event_trainingType')}</FormLabel>
                                <FormControl>
                                  <SearchableSelect
                                    value={field.value}
                                    onValueChange={field.onChange}
                                    placeholder={tr('event_noTrainingType')}
                                    options={[
                                      { value: NONE_VALUE, label: tr('event_noTrainingType') },
                                      ...trainingTypes.map((tt) => ({
                                        value: tt.trainingTypeId,
                                        label: tt.name,
                                      })),
                                    ]}
                                    pinnedValues={[NONE_VALUE]}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        )}
                      </div>
                      <div className='flex items-center gap-2'>
                        <Switch
                          id='create-all-day'
                          checked={watchedAllDay}
                          onCheckedChange={(checked) => form.setValue('allDay', checked)}
                        />
                        <Label htmlFor='create-all-day'>{tr('event_allDay')}</Label>
                      </div>
                      <div className='flex flex-col gap-4 sm:flex-row'>
                        <FormField
                          {...form.register('startDate')}
                          render={({ field }) => (
                            <FormItem className='flex-1'>
                              <FormLabel>{tr('event_startDate')}</FormLabel>
                              <FormControl>
                                <DatePicker
                                  value={field.value}
                                  onChange={field.onChange}
                                  placeholder={tr('event_startDate')}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        {!watchedAllDay && (
                          <FormField
                            {...form.register('startTime')}
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
                        )}
                      </div>
                      <div className='flex flex-col gap-4 sm:flex-row'>
                        <FormField
                          {...form.register('endDate')}
                          render={({ field }) => (
                            <FormItem className='flex-1'>
                              <FormLabel>{tr('event_endDate')}</FormLabel>
                              <FormControl>
                                <DatePicker
                                  value={field.value}
                                  onChange={field.onChange}
                                  placeholder={tr('event_endDate')}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        {!watchedAllDay && (
                          <FormField
                            {...form.register('endTime')}
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
                        )}
                      </div>
                      <FormField
                        {...form.register('location')}
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
                        {...form.register('locationUrl')}
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
                                disabled={!form.watch('location')}
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
                        {...form.register('description')}
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
                      <FormField
                        {...form.register('imageUrl')}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{tr('event_imageUrl')}</FormLabel>
                            <FormControl>
                              <Input
                                {...field}
                                type='url'
                                placeholder={tr('event_imageUrlPlaceholder')}
                              />
                            </FormControl>
                            {field.value &&
                              URL.canParse(field.value) &&
                              field.value.startsWith('https://') && (
                                <img
                                  src={field.value}
                                  alt=''
                                  loading='lazy'
                                  decoding='async'
                                  referrerPolicy='no-referrer'
                                  className='mt-2 aspect-video max-h-32 rounded-md border object-cover'
                                  onError={(e) => {
                                    e.currentTarget.style.display = 'none';
                                  }}
                                />
                              )}
                            <p className='text-xs text-muted-foreground'>
                              {tr('event_imageUrlHelp')}
                            </p>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        {...form.register('discordChannelId')}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{tr('event_discordChannel')}</FormLabel>
                            <FormControl>
                              <SearchableSelect
                                value={field.value}
                                onValueChange={field.onChange}
                                placeholder={tr('event_useDefault')}
                                options={[
                                  { value: NONE_VALUE, label: tr('event_useDefault') },
                                  ...discordChannels
                                    .filter((ch) => ch.type === DISCORD_CHANNEL_TYPE_TEXT)
                                    .map((ch) => ({ value: ch.id, label: `# ${ch.name}` })),
                                ]}
                                pinnedValues={[NONE_VALUE]}
                              />
                            </FormControl>
                            <p className='text-xs text-muted-foreground'>
                              {tr('event_discordChannelHelp')}
                            </p>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <div className='flex flex-col gap-4 sm:flex-row'>
                        <FormField
                          {...form.register('ownerGroupId')}
                          render={({ field }) => (
                            <FormItem className='flex-1'>
                              <FormLabel>{tr('event_ownerGroup')}</FormLabel>
                              <FormControl>
                                <SearchableSelect
                                  value={field.value}
                                  onValueChange={field.onChange}
                                  placeholder={tr('event_useDefault')}
                                  options={[
                                    { value: NONE_VALUE, label: tr('event_useDefault') },
                                    ...toGroupOptions(groups),
                                  ]}
                                  pinnedValues={[NONE_VALUE]}
                                />
                              </FormControl>
                              <p className='text-xs text-muted-foreground'>
                                {tr('event_ownerGroupHelp')}
                              </p>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          {...form.register('memberGroupId')}
                          render={({ field }) => (
                            <FormItem className='flex-1'>
                              <FormLabel>{tr('event_memberGroup')}</FormLabel>
                              <FormControl>
                                <SearchableSelect
                                  value={field.value}
                                  onValueChange={field.onChange}
                                  placeholder={tr('event_useDefault')}
                                  options={[
                                    { value: NONE_VALUE, label: tr('event_useDefault') },
                                    ...toGroupOptions(groups),
                                  ]}
                                  pinnedValues={[NONE_VALUE]}
                                />
                              </FormControl>
                              <p className='text-xs text-muted-foreground'>
                                {tr('event_memberGroupHelp')}
                              </p>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                      <Button
                        type='submit'
                        disabled={form.formState.isSubmitting}
                        className='self-start'
                      >
                        {tr('event_createEvent')}
                      </Button>
                    </form>
                  </Form>
                ) : (
                  <Form key='recurring' {...seriesForm}>
                    <form
                      onSubmit={seriesForm.handleSubmit(onSubmitSeries)}
                      className='flex flex-col gap-4'
                    >
                      <FormField
                        {...seriesForm.register('title')}
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
                      <div className='flex flex-col gap-4 sm:flex-row'>
                        <FormField
                          {...seriesForm.register('trainingTypeId')}
                          render={({ field }) => (
                            <FormItem className='flex-1'>
                              <FormLabel>{tr('event_trainingType')}</FormLabel>
                              <FormControl>
                                <SearchableSelect
                                  value={field.value}
                                  onValueChange={field.onChange}
                                  placeholder={tr('event_noTrainingType')}
                                  options={[
                                    { value: NONE_VALUE, label: tr('event_noTrainingType') },
                                    ...trainingTypes.map((tt) => ({
                                      value: tt.trainingTypeId,
                                      label: tt.name,
                                    })),
                                  ]}
                                  pinnedValues={[NONE_VALUE]}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          {...seriesForm.register('frequency')}
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
                      </div>
                      <FormField
                        name='daysOfWeek'
                        control={seriesForm.control}
                        render={({ field }) => (
                          <FormItem>
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
                      <div className='flex flex-col gap-4 sm:flex-row'>
                        <FormField
                          {...seriesForm.register('startDate')}
                          render={({ field }) => (
                            <FormItem className='flex-1'>
                              <FormLabel>{tr('event_startDate')}</FormLabel>
                              <FormControl>
                                <DatePicker
                                  value={field.value}
                                  onChange={field.onChange}
                                  placeholder={tr('event_startDate')}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          {...seriesForm.register('endDate')}
                          render={({ field }) => (
                            <FormItem className='flex-1'>
                              <FormLabel>{tr('event_endDate')}</FormLabel>
                              <FormControl>
                                <DatePicker
                                  value={field.value}
                                  onChange={field.onChange}
                                  placeholder={tr('event_endDate')}
                                />
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
                          {...seriesForm.register('startTime')}
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
                          {...seriesForm.register('endTime')}
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
                        {...seriesForm.register('location')}
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
                        {...seriesForm.register('locationUrl')}
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
                                disabled={!seriesForm.watch('location')}
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
                        {...seriesForm.register('description')}
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
                      <FormField
                        {...seriesForm.register('discordChannelId')}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{tr('event_discordChannel')}</FormLabel>
                            <FormControl>
                              <SearchableSelect
                                value={field.value}
                                onValueChange={field.onChange}
                                placeholder={tr('event_useDefault')}
                                options={[
                                  { value: NONE_VALUE, label: tr('event_useDefault') },
                                  ...discordChannels
                                    .filter((ch) => ch.type === DISCORD_CHANNEL_TYPE_TEXT)
                                    .map((ch) => ({ value: ch.id, label: `# ${ch.name}` })),
                                ]}
                                pinnedValues={[NONE_VALUE]}
                              />
                            </FormControl>
                            <p className='text-xs text-muted-foreground'>
                              {tr('event_discordChannelHelp')}
                            </p>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <div className='flex flex-col gap-4 sm:flex-row'>
                        <FormField
                          {...seriesForm.register('ownerGroupId')}
                          render={({ field }) => (
                            <FormItem className='flex-1'>
                              <FormLabel>{tr('event_ownerGroup')}</FormLabel>
                              <FormControl>
                                <SearchableSelect
                                  value={field.value}
                                  onValueChange={field.onChange}
                                  placeholder={tr('event_useDefault')}
                                  options={[
                                    { value: NONE_VALUE, label: tr('event_useDefault') },
                                    ...toGroupOptions(groups),
                                  ]}
                                  pinnedValues={[NONE_VALUE]}
                                />
                              </FormControl>
                              <p className='text-xs text-muted-foreground'>
                                {tr('event_ownerGroupHelp')}
                              </p>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          {...seriesForm.register('memberGroupId')}
                          render={({ field }) => (
                            <FormItem className='flex-1'>
                              <FormLabel>{tr('event_memberGroup')}</FormLabel>
                              <FormControl>
                                <SearchableSelect
                                  value={field.value}
                                  onValueChange={field.onChange}
                                  placeholder={tr('event_useDefault')}
                                  options={[
                                    { value: NONE_VALUE, label: tr('event_useDefault') },
                                    ...toGroupOptions(groups),
                                  ]}
                                  pinnedValues={[NONE_VALUE]}
                                />
                              </FormControl>
                              <p className='text-xs text-muted-foreground'>
                                {tr('event_memberGroupHelp')}
                              </p>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                      <Button
                        type='submit'
                        disabled={seriesForm.formState.isSubmitting}
                        className='self-start'
                      >
                        {tr('event_createSeries')}
                      </Button>
                    </form>
                  </Form>
                )}
              </div>
            )}
          </div>
          <div className='order-1 lg:order-1'>
            <div className='flex flex-wrap items-center gap-3 mb-2'>
              {hiddenCount > 0 && (
                <Button
                  variant='ghost'
                  size='sm'
                  className='text-muted-foreground'
                  onClick={() => setShowHidden((v) => !v)}
                >
                  {showHidden ? tr('event_hidePastCancelled') : tr('event_showPastCancelled')}
                </Button>
              )}
              {canViewAll && (
                <div className='flex items-center gap-2'>
                  <Switch
                    id='events-all-groups'
                    checked={showAllGroups}
                    onCheckedChange={onShowAllGroupsChange}
                    aria-describedby='events-all-groups-help'
                  />
                  <Label htmlFor='events-all-groups' className='flex items-center gap-1.5'>
                    {tr('event_allGroups')}
                    <Badge variant='secondary'>{tr('event_adminViewBadge')}</Badge>
                  </Label>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type='button'
                          className='text-muted-foreground'
                          aria-label={tr('event_allGroupsHelp')}
                        >
                          <ShieldCheck className='size-4' />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent id='events-all-groups-help'>
                        {tr('event_allGroupsHelp')}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  {isPending && (
                    <Loader2
                      className='size-4 animate-spin text-muted-foreground'
                      aria-hidden='true'
                    />
                  )}
                </div>
              )}
            </div>
            {visibleEvents.length === 0 ? (
              <p className='text-muted-foreground'>{tr('event_noEvents')}</p>
            ) : (
              <div
                className={`flex flex-col gap-2${isPending ? ' opacity-60 pointer-events-none transition-opacity' : ''}`}
                aria-busy={isPending}
              >
                {visibleEvents.map((event) => {
                  const { startDate, startTime, end } = formatEventDateRange(
                    event.startAt,
                    event.endAt,
                    event.allDay,
                  );
                  return (
                    <Link
                      key={event.eventId}
                      to='/teams/$teamId/events/$eventId'
                      params={{ teamId, eventId: event.eventId }}
                      className='flex items-start gap-3 rounded-lg border p-3 hover:bg-accent transition-colors'
                    >
                      <div className='flex size-10 shrink-0 flex-col items-center justify-center rounded-md bg-muted text-xs'>
                        <span className='font-semibold leading-none'>
                          {event.allDay
                            ? new Date(Number(DateTime.toEpochMillis(event.startAt))).getUTCDate()
                            : new Date(Number(DateTime.toEpochMillis(event.startAt))).getDate()}
                        </span>
                        <span className='text-muted-foreground leading-none mt-0.5'>
                          {new Date(
                            Number(DateTime.toEpochMillis(event.startAt)),
                          ).toLocaleDateString(undefined, {
                            month: 'short',
                            ...(event.allDay ? { timeZone: 'UTC' } : {}),
                          })}
                        </span>
                      </div>
                      <div className='min-w-0 flex-1'>
                        <div className='flex items-center gap-1.5 mb-0.5'>
                          <p className='font-medium truncate text-sm'>{event.title}</p>
                          {Option.isSome(event.seriesId) && (
                            <span className='text-[10px] text-muted-foreground'>
                              {tr('event_recurring')}
                            </span>
                          )}
                        </div>
                        <div className='flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground'>
                          <span>{eventTypeLabels[event.eventType]()}</span>
                          <span>·</span>
                          <span>
                            {startDate}
                            {event.allDay &&
                              Option.match(end, { onNone: () => '', onSome: (v) => ` – ${v}` })}
                          </span>
                          {event.allDay ? (
                            <span className='rounded bg-muted px-1 py-0.5 text-[10px]'>
                              {tr('event_allDayLabel')}
                            </span>
                          ) : (
                            <span className='hidden sm:inline'>
                              {startTime}
                              {Option.match(end, { onNone: () => '', onSome: (v) => ` – ${v}` })}
                            </span>
                          )}
                        </div>
                      </div>
                      <span className={`text-xs shrink-0 ${eventStatusClasses[event.status]}`}>
                        {eventStatusLabels[event.status]()}
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
