import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import type {
  EventApi,
  EventAttendanceApi,
  EventRosterApi,
  EventRsvpApi,
  EventTypeApi,
  GroupApi,
  PlayerRatingApi,
  Roster as RosterDomain,
  TrainingTypeApi,
} from '@sideline/domain';
import { Event, EventSeries, EventType, GroupModel, Team, TrainingType } from '@sideline/domain';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import type { DateTime } from 'effect';
import { Effect, Option, Schema } from 'effect';
import React from 'react';
import { useForm } from 'react-hook-form';

import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { EventFactBar } from '~/components/molecules/EventFactBar.js';
import { EventTypePicker } from '~/components/molecules/EventTypePicker';
import { EventAttendanceConfirmSection } from '~/components/organisms/EventAttendanceConfirmSection.js';
import { EventAttendanceRosterSection } from '~/components/organisms/EventAttendanceRosterSection.js';
import { EventRsvpPanel } from '~/components/organisms/EventRsvpPanel.js';
import { TeamGeneratorSection } from '~/components/organisms/TeamGeneratorSection.js';
import { TrainingResultSection } from '~/components/organisms/TrainingResultSection.js';
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
import { Switch } from '~/components/ui/switch';
import { Textarea } from '~/components/ui/textarea';
import {
  dateOnlyToUtcNoon,
  formatLocalDate,
  formatLocalTime,
  formatTimeInZone,
  formatUtcDate,
  localToUtc,
} from '~/lib/datetime.js';
import { getEventColor } from '~/lib/event-colors';
import { eventStatusClasses, eventStatusLabels, eventTypeName } from '~/lib/event-labels';
import { toGroupOptions } from '~/lib/group-options';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

const NONE_VALUE = '__none__';

const EventEditSchema = Schema.Struct({
  title: Schema.NonEmptyString.annotate({ message: tr('validation_required') }),
  // B3: always submit both — `eventType` (the selected type's `kind`) is kept in sync by
  // `EventTypePicker`'s `onChange`, never picked directly by the user.
  eventType: Event.EventType.annotate({ message: tr('validation_invalidOption') }),
  eventTypeId: Schema.String,
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
  // Required only for timed events; validated before save so all-day events can omit it.
  startTime: Schema.String,
  endDate: Schema.String,
  endTime: Schema.String,
  location: Schema.String,
  ownerGroupId: Schema.String,
  memberGroupId: Schema.String,
});

type EventEditValues = Schema.Schema.Type<typeof EventEditSchema>;

const buildPayload = (values: EventEditValues) => {
  const trainingTypeIdOption =
    values.trainingTypeId && values.trainingTypeId !== NONE_VALUE
      ? Option.some(Schema.decodeSync(TrainingType.TrainingTypeId)(values.trainingTypeId))
      : Option.none();
  const startAt = values.allDay
    ? dateOnlyToUtcNoon(values.startDate)
    : localToUtc(values.startDate, values.startTime);
  const endAt = values.allDay
    ? values.endDate
      ? Option.some(dateOnlyToUtcNoon(values.endDate))
      : Option.none()
    : values.endTime
      ? Option.some(localToUtc(values.endDate || values.startDate, values.endTime))
      : Option.none();
  return { trainingTypeIdOption, startAt, endAt, allDay: values.allDay };
};

interface EventDetailPageProps {
  teamId: string;
  eventId: string;
  eventDetail: EventApi.EventDetail;
  trainingTypes: ReadonlyArray<TrainingTypeApi.TrainingTypeInfo>;
  eventTypes: ReadonlyArray<EventTypeApi.EventTypeInfo>;
  rsvpDetail: EventRsvpApi.EventRsvpDetail;
  attendance: {
    canConfirm: boolean;
    confirmedAt: Option.Option<DateTime.Utc>;
    entries: ReadonlyArray<EventAttendanceApi.EventAttendanceEntry>;
  };
  nonResponders: ReadonlyArray<EventRsvpApi.NonResponderEntry>;
  groups: ReadonlyArray<GroupApi.GroupInfo>;
  rosters: ReadonlyArray<RosterDomain.RosterInfo>;
  canManageRosters: boolean;
  canManageRatings: boolean;
  canGenerate: boolean;
  initialEventRosterLink: Option.Option<EventRosterApi.EventRosterLink>;
  rsvpYesAttendees: ReadonlyArray<EventRsvpApi.RsvpEntry>;
  initialTrainingGames: ReadonlyArray<PlayerRatingApi.LoggedGameEntry>;
}

export function EventDetailPage({
  teamId,
  eventId,
  eventDetail,
  trainingTypes,
  eventTypes,
  rsvpDetail,
  attendance,
  nonResponders,
  groups,
  rosters,
  canManageRosters,
  canManageRatings,
  canGenerate,
  initialEventRosterLink,
  rsvpYesAttendees,
  initialTrainingGames,
}: EventDetailPageProps) {
  const run = useRun();
  const router = useRouter();
  const navigate = useNavigate();

  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const eventIdBranded = Schema.decodeSync(Event.EventId)(eventId);
  // `eventDetail.timezone` is `OptionFromOptionalKey` — an older server mid-rollout simply omits
  // the key rather than decode-failing the whole event detail. Fall back to the same default the
  // server itself uses for a team with no `team_settings` row yet (see
  // `applications/server/src/api/team-settings.ts`), so "save all future" still writes a sane
  // wall-clock projection instead of silently guessing the browser's zone.
  const teamTimezone = Option.getOrElse(eventDetail.timezone, () => 'Europe/Prague');

  // `values` (not `defaultValues`): the route renders this page with no `key`, so
  // `router.invalidate()` (fired from RSVP submit and the roster/rating/generator `onRefresh`
  // callbacks) refetches `eventDetail` without remounting. RHF deep-compares `values` every
  // render and only touches its internal defaults when they actually changed, so an in-progress
  // edit isn't clobbered by an unrelated refetch. `keepDirtyValues` stops a background refetch
  // from overwriting fields the user is actively editing.
  //
  // Held in a variable because Discard resets to it explicitly.
  const formValues: EventEditValues = React.useMemo(
    () => ({
      title: eventDetail.title,
      eventType: eventDetail.eventType,
      eventTypeId: Option.getOrElse(eventDetail.eventTypeId, () => ''),
      trainingTypeId: Option.getOrElse(eventDetail.trainingTypeId, () => NONE_VALUE),
      description: Option.getOrElse(eventDetail.description, () => ''),
      imageUrl: Option.getOrElse(eventDetail.imageUrl, () => ''),
      allDay: eventDetail.allDay,
      startDate: eventDetail.allDay
        ? Option.getOrElse(eventDetail.startDate, () => formatUtcDate(eventDetail.startAt))
        : formatLocalDate(eventDetail.startAt),
      startTime: eventDetail.allDay ? '' : formatLocalTime(eventDetail.startAt),
      endDate: Option.match(eventDetail.endAt, {
        onNone: () => '',
        onSome: (e) =>
          eventDetail.allDay
            ? Option.getOrElse(eventDetail.endDate, () => formatUtcDate(e))
            : formatLocalDate(e),
      }),
      endTime: eventDetail.allDay
        ? ''
        : Option.match(eventDetail.endAt, {
            onNone: () => '',
            onSome: formatLocalTime,
          }),
      location: Option.getOrElse(eventDetail.location, () => ''),
      locationUrl: Option.getOrElse(eventDetail.locationUrl, () => ''),
      ownerGroupId: Option.getOrElse(eventDetail.ownerGroupId, () => NONE_VALUE),
      memberGroupId: Option.getOrElse(eventDetail.memberGroupId, () => NONE_VALUE),
    }),
    [eventDetail],
  );

  const form = useForm<EventEditValues>({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(EventEditSchema)),
    mode: 'onChange',
    values: formValues,
    resetOptions: { keepDirtyValues: true },
  });

  const watchedEventTypeId = form.watch('eventTypeId');
  // Routed off `kind`, never off the name (plan §4/§5) — reads the LIVE lookup rather than the
  // form's own `eventType` field, which the picker only updates once its own effects run.
  const selectedEventType = eventTypes.find((t) => t.eventTypeId === watchedEventTypeId);
  const isTrainingSelected = (selectedEventType?.kind ?? form.watch('eventType')) === 'training';
  const watchedLocation = form.watch('location');
  const watchedAllDay = form.watch('allDay');

  React.useEffect(() => {
    if (!isTrainingSelected) {
      form.setValue('trainingTypeId', NONE_VALUE);
    }
  }, [isTrainingSelected, form]);

  React.useEffect(() => {
    if (!watchedLocation) {
      form.setValue('locationUrl', '');
    }
  }, [watchedLocation, form]);

  const [saving, setSaving] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [showEditScope, setShowEditScope] = React.useState(false);
  const [showCancelScope, setShowCancelScope] = React.useState(false);
  const hasSeries = Option.isSome(eventDetail.seriesId);
  const status = eventDetail.status;
  const eventTypeColor = getEventColor(eventDetail.eventTypeColor, eventDetail.eventType);
  const canEditNow = eventDetail.canEdit && status === 'active';

  const handleDiscard = React.useCallback(() => {
    // `keepDirtyValues: false` is REQUIRED here, not redundant: RHF's public `reset` merges the
    // form-level `resetOptions` into every explicit call (`reset(v, {...options.resetOptions,
    // ...arg})`), so without this override the form-level `keepDirtyValues: true` survives and
    // Discard keeps the very edits it is meant to throw away — they reappear on reopen.
    form.reset(formValues, { keepDirtyValues: false });
    setShowEditScope(false);
    setShowCancelScope(false);
    setEditing(false);
  }, [form, formValues]);

  const doSaveThisOnly = React.useCallback(async () => {
    const values = form.getValues();
    setSaving(true);
    setShowEditScope(false);
    const { trainingTypeIdOption, startAt, endAt, allDay } = buildPayload(values);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.event.updateEvent({
          params: { teamId: teamIdBranded, eventId: eventIdBranded },
          payload: {
            title: Option.some(values.title),
            // B3/D7: always submit both together — a title-only edit still resends whatever
            // the picker already holds (unchanged unless the captain actively re-picks), never
            // omits both and silently leaves the event's type alone by accident.
            eventType: Option.some(values.eventType),
            eventTypeId: Option.some(Schema.decodeSync(EventType.EventTypeId)(values.eventTypeId)),
            allDay: Option.some(allDay),
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
      setEditing(false);
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
            // This form value is browser-local for ONE occurrence, but it is being written back
            // onto the SERIES-level wall-clock field, so it must be re-expressed in the team's
            // zone first — unlike the plain per-occurrence write above, this is a genuine
            // conversion, not a verbatim pass-through.
            startTime: Option.some(
              formatTimeInZone(localToUtc(values.startDate, values.startTime), teamTimezone),
            ),
            endTime: Option.some(
              values.endTime
                ? Option.some(
                    formatTimeInZone(localToUtc(values.startDate, values.endTime), teamTimezone),
                  )
                : Option.none(),
            ),
            location: Option.some(values.location ? Option.some(values.location) : Option.none()),
            locationUrl: Option.some(
              values.locationUrl ? Option.some(values.locationUrl) : Option.none(),
            ),
            endDate: Option.none(),
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
            // `startTime`/`endTime` above are converted to the team's wall clock before being
            // sent, so this payload's dialect is genuinely team-local. Release N
            // (`.work-plans/series-time-conversion.md`) does not tag or release
            // `@sideline/web` — the deployed `v0.37.2` bundle predates this field entirely and
            // sends no key at all, decoding server-side to `false`, so this change has no
            // effect on what ships in Release N.
            timesAreTeamLocal: true,
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('event_updateSeriesFailed'))),
      run({ success: tr('event_seriesSaved') }),
    );
    setSaving(false);
    if (Option.isSome(result)) {
      setEditing(false);
      router.invalidate();
    }
  }, [form, teamIdBranded, eventDetail.seriesId, run, router, teamTimezone]);

  const handleSave = form.handleSubmit((values) => {
    if (!values.allDay && !values.startTime) {
      form.setError('startTime', { message: tr('validation_required') });
      return;
    }
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
    (response: 'yes' | 'no' | 'maybe' | 'coming_later', message: string) =>
      ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.eventRsvp.submitRsvp({
            params: { teamId: teamIdBranded, eventId: eventIdBranded },
            payload: {
              // Always send the note field's full value — an empty string is how this API is told
              // to clear a stored note, whereas `null` would ask it to keep whatever is there.
              response,
              message: Option.some(message),
            },
          }),
        ),
        Effect.catchTag('EventRsvpMessageRequired', () =>
          Effect.fail(ClientError.make(tr('rsvp_messageRequired'))),
        ),
        Effect.catchTag('EventRsvpProfileIncomplete', () =>
          Effect.fail(ClientError.make(tr('rsvp_profileIncomplete'))),
        ),
        // A page held open across the RSVP deadline: the buttons are still on screen because
        // nothing re-renders at the deadline, so the stale UI has to explain itself rather than
        // fall through to the generic `rsvp_submitFailed`.
        Effect.catchTag('RsvpDeadlinePassed', () =>
          Effect.fail(ClientError.make(tr('rsvp_lockedJustNow'))),
        ),
        Effect.mapError(() => ClientError.make(tr('rsvp_submitFailed'))),
        Effect.tap(() => Effect.sync(() => router.invalidate())),
      ),
    [teamIdBranded, eventIdBranded, router],
  );

  return (
    <div>
      <header className='mb-4 flex items-start justify-between gap-4'>
        <Button asChild variant='ghost' size='sm'>
          <Link to='/teams/$teamId/events' params={{ teamId }}>
            ← {tr('event_backToEvents')}
          </Link>
        </Button>
        <div className='flex shrink-0 gap-2'>
          {canEditNow && !editing && (
            <Button
              variant='outline'
              size='sm'
              aria-expanded={editing}
              aria-controls='event-edit-form'
              onClick={() => setEditing(true)}
            >
              {tr('event_edit')}
            </Button>
          )}
          {eventDetail.canCancel && status === 'active' && (
            <Button variant='destructive' size='sm' onClick={handleCancel}>
              {tr('event_cancelEvent')}
            </Button>
          )}
        </div>
      </header>

      <div className='mb-2 flex flex-wrap items-center gap-2'>
        <Badge variant='outline' className={eventStatusClasses[status]}>
          {eventStatusLabels[status]()}
        </Badge>
        <Badge
          variant='outline'
          className={`${eventTypeColor.bg} ${eventTypeColor.text} ${eventTypeColor.border}`}
        >
          {eventTypeName(eventDetail.eventTypeName, eventDetail.eventType)}
        </Badge>
        {hasSeries && <Badge variant='outline'>{tr('event_recurring')}</Badge>}
      </div>

      <h1 className='mb-4 text-2xl font-bold'>{eventDetail.title}</h1>

      <div className='mb-6'>
        <EventFactBar eventDetail={eventDetail} />
      </div>

      {Option.isSome(eventDetail.imageUrl) && (
        <div className='mb-6 h-[180px] overflow-hidden rounded-lg border bg-muted'>
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
            {canEditNow && editing ? (
              <Form {...form}>
                <form id='event-edit-form' onSubmit={handleSave} className='flex flex-col gap-4'>
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
                    <FormItem className='flex-1'>
                      <FormLabel>{tr('event_eventType')}</FormLabel>
                      <EventTypePicker
                        eventTypes={eventTypes}
                        event={{
                          eventType: eventDetail.eventType,
                          eventTypeId: eventDetail.eventTypeId,
                          eventTypeName: eventDetail.eventTypeName,
                          eventTypeColor: eventDetail.eventTypeColor,
                        }}
                        value={
                          watchedEventTypeId
                            ? Option.some(
                                Schema.decodeSync(EventType.EventTypeId)(watchedEventTypeId),
                              )
                            : Option.none()
                        }
                        onChange={({ eventTypeId, kind }) => {
                          form.setValue('eventTypeId', eventTypeId, { shouldValidate: true });
                          form.setValue('eventType', kind, { shouldValidate: true });
                        }}
                      />
                    </FormItem>
                    {isTrainingSelected && (
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
                      id='edit-all-day'
                      checked={watchedAllDay}
                      onCheckedChange={(checked) => form.setValue('allDay', checked)}
                    />
                    <Label htmlFor='edit-all-day'>{tr('event_allDay')}</Label>
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
                        <p className='text-xs text-muted-foreground'>{tr('event_imageUrlHelp')}</p>
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

                  <div className='flex gap-2'>
                    <Button type='submit' disabled={saving}>
                      {saving ? tr('event_saving') : tr('event_saveChanges')}
                    </Button>
                    <Button type='button' variant='outline' onClick={handleDiscard}>
                      {tr('event_editCancel')}
                    </Button>
                  </div>
                </form>
              </Form>
            ) : (
              <div className='flex flex-col gap-4'>
                {Option.isSome(eventDetail.description) && (
                  <div>
                    <h2 className='text-sm font-semibold'>{tr('event_description')}</h2>
                    <p className='mt-1 whitespace-pre-wrap text-sm text-muted-foreground'>
                      {eventDetail.description.value}
                    </p>
                  </div>
                )}
                {Option.isSome(eventDetail.ownerGroupName) && (
                  <div>
                    <h2 className='text-sm font-semibold'>{tr('event_ownerGroup')}</h2>
                    <p className='mt-1 text-sm text-muted-foreground'>
                      {eventDetail.ownerGroupName.value}
                    </p>
                  </div>
                )}
                {Option.isSome(eventDetail.memberGroupName) && (
                  <div>
                    <h2 className='text-sm font-semibold'>{tr('event_memberGroup')}</h2>
                    <p className='mt-1 text-sm text-muted-foreground'>
                      {eventDetail.memberGroupName.value}
                    </p>
                  </div>
                )}
                {Option.isSome(eventDetail.createdByName) && (
                  <p className='text-sm text-muted-foreground'>
                    {tr('event_createdBy')}: {eventDetail.createdByName.value}
                  </p>
                )}
              </div>
            )}

            {/* Hoisted out of the form: the "Cancel Event" button lives in the header now and is
                reachable whether or not the edit form is open, so this scope picker must be too —
                otherwise cancelling a recurring event while not editing would set state nobody
                renders. */}
            {showCancelScope && (
              <div className='rounded-md border border-destructive/30 p-4 space-y-2'>
                <p className='font-medium'>{tr('event_cancelScopeTitle')}</p>
                <div className='flex gap-2'>
                  <Button type='button' size='sm' variant='outline' onClick={doCancelThisOnly}>
                    {tr('event_cancelThisOnly')}
                  </Button>
                  <Button type='button' size='sm' variant='destructive' onClick={doCancelAllFuture}>
                    {tr('event_cancelAllFuture')}
                  </Button>
                </div>
              </div>
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

      {canManageRosters && (
        <div className='mt-6'>
          <EventAttendanceRosterSection
            teamId={teamId}
            eventId={eventId}
            rosters={rosters}
            initialEventRosterLink={initialEventRosterLink}
            onRefresh={() => router.invalidate()}
          />
        </div>
      )}

      {canManageRatings && eventDetail.eventType === 'training' && status !== 'cancelled' && (
        <div className='mt-6'>
          <TrainingResultSection
            teamId={teamId}
            eventId={eventId}
            attendees={rsvpYesAttendees}
            initialGames={initialTrainingGames}
            onRefresh={() => router.invalidate()}
          />
        </div>
      )}

      {attendance.canConfirm && eventDetail.eventType === 'training' && status !== 'cancelled' && (
        <div className='mt-6'>
          <EventAttendanceConfirmSection
            teamId={teamId}
            eventId={eventId}
            confirmedAt={attendance.confirmedAt}
            entries={attendance.entries}
            onRefresh={() => router.invalidate()}
          />
        </div>
      )}

      {canGenerate && eventDetail.eventType === 'training' && status !== 'cancelled' && (
        <div className='mt-6'>
          <TeamGeneratorSection
            teamId={teamId}
            eventId={eventId}
            rsvpYesAttendees={rsvpYesAttendees}
            onRefresh={() => router.invalidate()}
          />
        </div>
      )}
    </div>
  );
}
