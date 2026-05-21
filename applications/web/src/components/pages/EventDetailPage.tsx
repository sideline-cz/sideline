import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import type { EventApi, EventRsvpApi, GroupApi, TrainingTypeApi } from '@sideline/domain';
import { Discord, Event, EventSeries, GroupModel, Team, TrainingType } from '@sideline/domain';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { type DateTime, Effect, Option, Schema } from 'effect';
import React from 'react';
import { useForm } from 'react-hook-form';

import { EventLocation } from '~/components/atoms/EventLocation.js';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { EventRsvpPanel } from '~/components/organisms/EventRsvpPanel.js';
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
import { Textarea } from '~/components/ui/textarea';
import {
  formatEventDateRange,
  formatLocalDate,
  formatLocalTime,
  formatUtcTime,
  localToUtc,
} from '~/lib/datetime';
import { DISCORD_CHANNEL_TYPE_TEXT } from '~/lib/discord';
import { eventStatusClasses, eventStatusLabels, eventTypeLabels } from '~/lib/event-labels';
import { toGroupOptions } from '~/lib/group-options';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

const NONE_VALUE = '__none__';

const EventEditSchema = Schema.Struct({
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
  startDate: Schema.NonEmptyString.annotate({ message: tr('validation_required') }),
  startTime: Schema.NonEmptyString.annotate({ message: tr('validation_required') }),
  endDate: Schema.String,
  endTime: Schema.String,
  location: Schema.String,
  discordChannelId: Schema.String,
  ownerGroupId: Schema.String,
  memberGroupId: Schema.String,
});

type EventEditValues = Schema.Schema.Type<typeof EventEditSchema>;

const buildPayload = (values: EventEditValues) => {
  const trainingTypeIdOption =
    values.trainingTypeId && values.trainingTypeId !== NONE_VALUE
      ? Option.some(Schema.decodeSync(TrainingType.TrainingTypeId)(values.trainingTypeId))
      : Option.none();
  const startAt = localToUtc(values.startDate, values.startTime);
  const endAt = values.endTime
    ? Option.some(localToUtc(values.endDate || values.startDate, values.endTime))
    : Option.none();
  return { trainingTypeIdOption, startAt, endAt };
};

interface EventDetailPageProps {
  teamId: string;
  eventId: string;
  eventDetail: EventApi.EventDetail;
  trainingTypes: ReadonlyArray<TrainingTypeApi.TrainingTypeInfo>;
  discordChannels: ReadonlyArray<GroupApi.DiscordChannelInfo>;
  rsvpDetail: EventRsvpApi.EventRsvpDetail;
  nonResponders: ReadonlyArray<EventRsvpApi.NonResponderEntry>;
  groups: ReadonlyArray<GroupApi.GroupInfo>;
}

interface EventDateRangeProps {
  startAt: DateTime.Utc;
  endAt: Option.Option<DateTime.Utc>;
  labelStart: string;
  labelEnd: string;
}

const EventDateRange = ({ startAt, endAt, labelStart, labelEnd }: EventDateRangeProps) => {
  const { startDate, startTime, end, sameDay } = formatEventDateRange(startAt, endAt);
  const start = `${startDate} ${startTime}`;
  if (sameDay) {
    return (
      <p>
        <span className='text-sm font-medium'>{labelStart}: </span>
        {start}
        {Option.match(end, { onNone: () => '', onSome: (v) => ` – ${v}` })}
      </p>
    );
  }
  return (
    <>
      <p>
        <span className='text-sm font-medium'>{labelStart}: </span>
        {start}
      </p>
      {Option.isSome(end) && (
        <p>
          <span className='text-sm font-medium'>{labelEnd}: </span>
          {end.value}
        </p>
      )}
    </>
  );
};

export function EventDetailPage({
  teamId,
  eventId,
  eventDetail,
  trainingTypes,
  discordChannels,
  rsvpDetail,
  nonResponders,
  groups,
}: EventDetailPageProps) {
  const run = useRun();
  const router = useRouter();
  const navigate = useNavigate();

  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const eventIdBranded = Schema.decodeSync(Event.EventId)(eventId);

  const form = useForm<EventEditValues>({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(EventEditSchema)),
    mode: 'onChange',
    defaultValues: {
      title: eventDetail.title,
      eventType: eventDetail.eventType,
      trainingTypeId: Option.getOrElse(eventDetail.trainingTypeId, () => NONE_VALUE),
      description: Option.getOrElse(eventDetail.description, () => ''),
      imageUrl: Option.getOrElse(eventDetail.imageUrl, () => ''),
      startDate: formatLocalDate(eventDetail.startAt),
      startTime: formatLocalTime(eventDetail.startAt),
      endDate: Option.match(eventDetail.endAt, {
        onNone: () => '',
        onSome: formatLocalDate,
      }),
      endTime: Option.match(eventDetail.endAt, {
        onNone: () => '',
        onSome: formatLocalTime,
      }),
      location: Option.getOrElse(eventDetail.location, () => ''),
      locationUrl: Option.getOrElse(eventDetail.locationUrl, () => ''),
      discordChannelId: Option.getOrElse(eventDetail.discordChannelId, () => NONE_VALUE),
      ownerGroupId: Option.getOrElse(eventDetail.ownerGroupId, () => NONE_VALUE),
      memberGroupId: Option.getOrElse(eventDetail.memberGroupId, () => NONE_VALUE),
    },
  });

  const watchedEventType = form.watch('eventType');
  const watchedLocation = form.watch('location');

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

  const [saving, setSaving] = React.useState(false);
  const [showEditScope, setShowEditScope] = React.useState(false);
  const [showCancelScope, setShowCancelScope] = React.useState(false);
  const hasSeries = Option.isSome(eventDetail.seriesId);

  const doSaveThisOnly = React.useCallback(async () => {
    const values = form.getValues();
    setSaving(true);
    setShowEditScope(false);
    const { trainingTypeIdOption, startAt, endAt } = buildPayload(values);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.event.updateEvent({
          params: { teamId: teamIdBranded, eventId: eventIdBranded },
          payload: {
            title: Option.some(values.title),
            eventType: Option.some(values.eventType),
            trainingTypeId: Option.some(trainingTypeIdOption),
            description: Option.some(
              values.description ? Option.some(values.description) : Option.none(),
            ),
            imageUrl: Option.some(values.imageUrl ? Option.some(values.imageUrl) : Option.none()),
            startAt: Option.some(startAt),
            endAt: Option.some(endAt),
            location: Option.some(values.location ? Option.some(values.location) : Option.none()),
            locationUrl: Option.some(
              values.locationUrl ? Option.some(values.locationUrl) : Option.none(),
            ),
            discordChannelId: Option.some(
              values.discordChannelId && values.discordChannelId !== NONE_VALUE
                ? Option.some(Discord.Snowflake.makeUnsafe(values.discordChannelId))
                : Option.none(),
            ),
            ownerGroupId: Option.some(
              values.ownerGroupId && values.ownerGroupId !== NONE_VALUE
                ? Option.some(Schema.decodeSync(GroupModel.GroupId)(values.ownerGroupId))
                : Option.none(),
            ),
            memberGroupId: Option.some(
              values.memberGroupId && values.memberGroupId !== NONE_VALUE
                ? Option.some(Schema.decodeSync(GroupModel.GroupId)(values.memberGroupId))
                : Option.none(),
            ),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('event_updateFailed'))),
      run({ success: tr('event_eventSaved') }),
    );
    setSaving(false);
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [form, teamIdBranded, eventIdBranded, run, router]);

  const doSaveAllFuture = React.useCallback(async () => {
    if (Option.isNone(eventDetail.seriesId)) return;
    const values = form.getValues();
    setSaving(true);
    setShowEditScope(false);
    const { trainingTypeIdOption } = buildPayload(values);
    const seriesIdBranded = Schema.decodeSync(EventSeries.EventSeriesId)(
      eventDetail.seriesId.value,
    );
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.eventSeries.updateEventSeries({
          params: { teamId: teamIdBranded, seriesId: seriesIdBranded },
          payload: {
            title: Option.some(values.title),
            trainingTypeId: Option.some(trainingTypeIdOption),
            description: Option.some(
              values.description ? Option.some(values.description) : Option.none(),
            ),
            daysOfWeek: Option.none(),
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
            endDate: Option.none(),
            discordChannelId: Option.some(
              values.discordChannelId && values.discordChannelId !== NONE_VALUE
                ? Option.some(Discord.Snowflake.makeUnsafe(values.discordChannelId))
                : Option.none(),
            ),
            ownerGroupId: Option.some(
              values.ownerGroupId && values.ownerGroupId !== NONE_VALUE
                ? Option.some(Schema.decodeSync(GroupModel.GroupId)(values.ownerGroupId))
                : Option.none(),
            ),
            memberGroupId: Option.some(
              values.memberGroupId && values.memberGroupId !== NONE_VALUE
                ? Option.some(Schema.decodeSync(GroupModel.GroupId)(values.memberGroupId))
                : Option.none(),
            ),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('event_updateSeriesFailed'))),
      run({ success: tr('event_seriesSaved') }),
    );
    setSaving(false);
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [form, teamIdBranded, eventDetail.seriesId, run, router]);

  const handleSave = form.handleSubmit(() => {
    if (hasSeries) {
      setShowEditScope(true);
    } else {
      doSaveThisOnly();
    }
  });

  const doCancelThisOnly = React.useCallback(async () => {
    setShowCancelScope(false);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.event.cancelEvent({ params: { teamId: teamIdBranded, eventId: eventIdBranded } }),
      ),
      Effect.mapError(() => ClientError.make(tr('event_cancelFailed'))),
      run({ success: tr('event_cancelled') }),
    );
    if (Option.isSome(result)) {
      navigate({ to: '/teams/$teamId/events', params: { teamId } });
    }
  }, [teamId, teamIdBranded, eventIdBranded, run, navigate]);

  const doCancelAllFuture = React.useCallback(async () => {
    if (Option.isNone(eventDetail.seriesId)) return;
    setShowCancelScope(false);
    const seriesIdBranded = Schema.decodeSync(EventSeries.EventSeriesId)(
      eventDetail.seriesId.value,
    );
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.eventSeries.cancelEventSeries({
          params: { teamId: teamIdBranded, seriesId: seriesIdBranded },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('event_cancelFailed'))),
      run({ success: tr('event_seriesCancelled') }),
    );
    if (Option.isSome(result)) {
      navigate({ to: '/teams/$teamId/events', params: { teamId } });
    }
  }, [teamId, teamIdBranded, eventDetail.seriesId, run, navigate]);

  const handleCancel = React.useCallback(() => {
    if (hasSeries) {
      setShowCancelScope(true);
    } else {
      if (!window.confirm(tr('event_cancelConfirm'))) return;
      doCancelThisOnly();
    }
  }, [hasSeries, doCancelThisOnly]);

  const handleRsvpSubmit = React.useCallback(
    (response: 'yes' | 'no' | 'maybe', message: string) =>
      ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.eventRsvp.submitRsvp({
            params: { teamId: teamIdBranded, eventId: eventIdBranded },
            payload: {
              response,
              message: message ? Option.some(message) : Option.none(),
            },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('rsvp_submitFailed'))),
        Effect.tap(() => Effect.sync(() => router.invalidate())),
      ),
    [teamIdBranded, eventIdBranded, router],
  );

  const status = eventDetail.status;

  return (
    <div>
      <header className='mb-8'>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId/events' params={{ teamId }}>
            ← {tr('event_backToEvents')}
          </Link>
        </Button>
        <h1 className='text-2xl font-bold'>{eventDetail.title}</h1>
        <div className='flex flex-wrap gap-2 sm:gap-4 text-sm text-muted-foreground mt-1'>
          <span>{eventTypeLabels[eventDetail.eventType]()}</span>
          <span className={eventStatusClasses[status]}>{eventStatusLabels[status]()}</span>
          {Option.isSome(eventDetail.createdByName) && (
            <span>
              {tr('event_createdBy')}: {eventDetail.createdByName.value}
            </span>
          )}
        </div>
      </header>

      {hasSeries && (
        <div className='mb-4 rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800'>
          {tr('event_partOfSeries')}
        </div>
      )}

      {Option.isSome(eventDetail.imageUrl) && (
        <div className='mb-6 overflow-hidden rounded-lg border bg-muted aspect-video max-h-[360px]'>
          <img
            src={eventDetail.imageUrl.value}
            alt=''
            loading='lazy'
            decoding='async'
            referrerPolicy='no-referrer'
            className='h-full w-full object-cover'
            onError={(e) => {
              const parent = e.currentTarget.parentElement;
              if (parent) parent.style.display = 'none';
            }}
          />
        </div>
      )}

      <div className='flex flex-col gap-6 lg:grid lg:grid-cols-[1fr_380px]'>
        <div className='order-2 lg:order-1'>
          <div className='flex flex-col gap-6 max-w-lg'>
            {eventDetail.canEdit && status === 'active' ? (
              <Form {...form}>
                <form onSubmit={handleSave} className='flex flex-col gap-4'>
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
                        <p className='text-xs text-muted-foreground'>{tr('event_imageUrlHelp')}</p>
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

                  {showEditScope && (
                    <div className='rounded-md border p-4 space-y-2'>
                      <p className='font-medium'>{tr('event_editScopeTitle')}</p>
                      <div className='flex gap-2'>
                        <Button type='button' size='sm' variant='outline' onClick={doSaveThisOnly}>
                          {tr('event_editThisOnly')}
                        </Button>
                        <Button type='button' size='sm' onClick={doSaveAllFuture}>
                          {tr('event_editAllFuture')}
                        </Button>
                      </div>
                    </div>
                  )}

                  {showCancelScope && (
                    <div className='rounded-md border border-destructive/30 p-4 space-y-2'>
                      <p className='font-medium'>{tr('event_cancelScopeTitle')}</p>
                      <div className='flex gap-2'>
                        <Button
                          type='button'
                          size='sm'
                          variant='outline'
                          onClick={doCancelThisOnly}
                        >
                          {tr('event_cancelThisOnly')}
                        </Button>
                        <Button
                          type='button'
                          size='sm'
                          variant='destructive'
                          onClick={doCancelAllFuture}
                        >
                          {tr('event_cancelAllFuture')}
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className='flex gap-2'>
                    <Button type='submit' disabled={saving}>
                      {saving ? tr('event_saving') : tr('event_saveChanges')}
                    </Button>
                    {eventDetail.canCancel && (
                      <Button type='button' variant='destructive' onClick={handleCancel}>
                        {tr('event_cancelEvent')}
                      </Button>
                    )}
                  </div>
                </form>
              </Form>
            ) : (
              <>
                {eventDetail.eventType === 'training' &&
                  Option.isSome(eventDetail.trainingTypeName) && (
                    <p>
                      <span className='text-sm font-medium'>{tr('event_trainingType')}: </span>
                      {eventDetail.trainingTypeName.value}
                    </p>
                  )}
                <EventDateRange
                  startAt={eventDetail.startAt}
                  endAt={eventDetail.endAt}
                  labelStart={tr('event_startDate')}
                  labelEnd={tr('event_endDate')}
                />
                {Option.isSome(eventDetail.location) && (
                  <p>
                    <span className='text-sm font-medium'>{tr('event_location')}: </span>
                    <EventLocation
                      text={eventDetail.location.value}
                      url={eventDetail.locationUrl}
                    />
                  </p>
                )}
                {Option.isSome(eventDetail.description) && (
                  <p>
                    <span className='text-sm font-medium'>{tr('event_description')}: </span>
                    {eventDetail.description.value}
                  </p>
                )}
                {Option.isSome(eventDetail.ownerGroupName) && (
                  <p>
                    <span className='text-sm font-medium'>{tr('event_ownerGroup')}: </span>
                    {eventDetail.ownerGroupName.value}
                  </p>
                )}
                {Option.isSome(eventDetail.memberGroupName) && (
                  <p>
                    <span className='text-sm font-medium'>{tr('event_memberGroup')}: </span>
                    {eventDetail.memberGroupName.value}
                  </p>
                )}
                {eventDetail.canCancel && status === 'active' && (
                  <div>
                    <Button variant='destructive' onClick={handleCancel}>
                      {tr('event_cancelEvent')}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {(status === 'active' || status === 'started') && (
          <div className='order-1 lg:order-2 lg:sticky lg:top-20 lg:self-start'>
            <EventRsvpPanel
              eventDetail={eventDetail}
              rsvpDetail={rsvpDetail}
              nonResponders={nonResponders}
              onRsvpSubmit={handleRsvpSubmit}
            />
          </div>
        )}
      </div>
    </div>
  );
}
