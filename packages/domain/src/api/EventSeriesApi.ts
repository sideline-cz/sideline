import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { EventLocationUrl, Forbidden } from '~/api/EventApi.js';
import { fieldState } from '~/api/RequestFilters.js';
import {
  DaysOfWeek,
  EventSeriesId,
  EventSeriesStatus,
  RecurrenceFrequency,
} from '~/models/EventSeries.js';
import { GroupId } from '~/models/GroupModel.js';
import { TeamId } from '~/models/Team.js';
import { TrainingTypeId } from '~/models/TrainingType.js';

export class EventSeriesInfo extends Schema.Class<EventSeriesInfo>('EventSeriesInfo')({
  seriesId: EventSeriesId,
  teamId: TeamId,
  title: Schema.String,
  frequency: RecurrenceFrequency,
  daysOfWeek: DaysOfWeek,
  startDate: Schemas.DateTimeFromIsoString,
  endDate: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  status: EventSeriesStatus,
  trainingTypeId: Schema.OptionFromNullOr(TrainingTypeId),
  trainingTypeName: Schema.OptionFromNullOr(Schema.String),
  startTime: Schema.String,
  endTime: Schema.OptionFromNullOr(Schema.String),
  location: Schema.OptionFromNullOr(Schema.String),
  locationUrl: Schema.OptionFromNullOr(Schema.String),
  ownerGroupId: Schema.OptionFromNullOr(GroupId),
  ownerGroupName: Schema.OptionFromNullOr(Schema.String),
  memberGroupId: Schema.OptionFromNullOr(GroupId),
  memberGroupName: Schema.OptionFromNullOr(Schema.String),
}) {}

export class EventSeriesDetail extends Schema.Class<EventSeriesDetail>('EventSeriesDetail')({
  seriesId: EventSeriesId,
  teamId: TeamId,
  title: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  frequency: RecurrenceFrequency,
  daysOfWeek: DaysOfWeek,
  startDate: Schemas.DateTimeFromIsoString,
  endDate: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  status: EventSeriesStatus,
  trainingTypeId: Schema.OptionFromNullOr(TrainingTypeId),
  trainingTypeName: Schema.OptionFromNullOr(Schema.String),
  startTime: Schema.String,
  endTime: Schema.OptionFromNullOr(Schema.String),
  location: Schema.OptionFromNullOr(Schema.String),
  locationUrl: Schema.OptionFromNullOr(Schema.String),
  ownerGroupId: Schema.OptionFromNullOr(GroupId),
  ownerGroupName: Schema.OptionFromNullOr(Schema.String),
  memberGroupId: Schema.OptionFromNullOr(GroupId),
  memberGroupName: Schema.OptionFromNullOr(Schema.String),
  canEdit: Schema.Boolean,
  canCancel: Schema.Boolean,
}) {}

const CreateEventSeriesRequestStruct = Schema.Struct({
  title: Schema.NonEmptyString,
  trainingTypeId: Schema.OptionFromNullOr(TrainingTypeId),
  description: Schema.OptionFromNullOr(Schema.String),
  frequency: RecurrenceFrequency,
  daysOfWeek: DaysOfWeek,
  startDate: Schemas.DateTimeFromIsoString,
  endDate: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  startTime: Schema.String,
  endTime: Schema.OptionFromNullOr(Schema.String),
  location: Schema.OptionFromNullOr(Schema.String),
  locationUrl: Schema.OptionFromOptionalNullOr(EventLocationUrl),
  ownerGroupId: Schema.OptionFromNullOr(GroupId),
  memberGroupId: Schema.OptionFromNullOr(GroupId),
});
export const CreateEventSeriesRequest = CreateEventSeriesRequestStruct.pipe(
  Schema.check(
    Schema.makeFilter<Schema.Schema.Type<typeof CreateEventSeriesRequestStruct>>((req) => {
      if (fieldState(req.locationUrl) === 'setting' && fieldState(req.location) !== 'setting')
        return 'Location URL requires location text';
      return true;
    }),
  ),
);
export type CreateEventSeriesRequest = Schema.Schema.Type<typeof CreateEventSeriesRequest>;

const UpdateEventSeriesRequestStruct = Schema.Struct({
  title: Schema.OptionFromOptional(Schema.NonEmptyString),
  trainingTypeId: Schema.OptionFromOptional(Schema.OptionFromNullOr(TrainingTypeId)),
  description: Schema.OptionFromOptional(Schema.OptionFromNullOr(Schema.String)),
  daysOfWeek: Schema.OptionFromOptional(DaysOfWeek),
  startTime: Schema.OptionFromOptional(Schema.String),
  endTime: Schema.OptionFromOptional(Schema.OptionFromNullOr(Schema.String)),
  location: Schema.OptionFromOptional(Schema.OptionFromNullOr(Schema.String)),
  locationUrl: Schema.OptionFromOptional(Schema.OptionFromNullOr(EventLocationUrl)),
  endDate: Schema.OptionFromOptional(Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString)),
  ownerGroupId: Schema.OptionFromOptional(Schema.OptionFromNullOr(GroupId)),
  memberGroupId: Schema.OptionFromOptional(Schema.OptionFromNullOr(GroupId)),
});
export const UpdateEventSeriesRequest = UpdateEventSeriesRequestStruct.pipe(
  Schema.check(
    Schema.makeFilter<Schema.Schema.Type<typeof UpdateEventSeriesRequestStruct>>((req) => {
      if (fieldState(req.locationUrl) === 'setting' && fieldState(req.location) === 'clearing')
        return 'Location URL requires location text';
      return true;
    }),
  ),
);
export type UpdateEventSeriesRequest = Schema.Schema.Type<typeof UpdateEventSeriesRequest>;

export class EventSeriesNotFound extends Schema.TaggedErrorClass<EventSeriesNotFound>()(
  'EventSeriesNotFound',
  {},
) {}

export class EventSeriesCancelled extends Schema.TaggedErrorClass<EventSeriesCancelled>()(
  'EventSeriesCancelled',
  {},
) {}

export class EventSeriesNotActive extends Schema.TaggedErrorClass<EventSeriesNotActive>()(
  'EventSeriesNotActive',
  {},
) {}

export class EventSeriesApiGroup extends HttpApiGroup.make('eventSeries')
  .add(
    HttpApiEndpoint.post('createEventSeries', '/teams/:teamId/event-series', {
      success: EventSeriesInfo.pipe(HttpApiSchema.status(201)),
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      payload: CreateEventSeriesRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('listEventSeries', '/teams/:teamId/event-series', {
      success: Schema.Array(EventSeriesInfo),
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getEventSeries', '/teams/:teamId/event-series/:seriesId', {
      success: EventSeriesDetail,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventSeriesNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, seriesId: EventSeriesId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateEventSeries', '/teams/:teamId/event-series/:seriesId', {
      success: EventSeriesDetail,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventSeriesNotFound.pipe(HttpApiSchema.status(404)),
        EventSeriesNotActive.pipe(HttpApiSchema.status(400)),
      ],
      payload: UpdateEventSeriesRequest,
      params: { teamId: TeamId, seriesId: EventSeriesId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('cancelEventSeries', '/teams/:teamId/event-series/:seriesId/cancel', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventSeriesNotFound.pipe(HttpApiSchema.status(404)),
        EventSeriesNotActive.pipe(HttpApiSchema.status(400)),
      ],
      params: { teamId: TeamId, seriesId: EventSeriesId },
    }).middleware(AuthMiddleware),
  ) {}
