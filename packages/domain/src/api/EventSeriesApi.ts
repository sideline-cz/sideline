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
  /** `HH:MM` wall clock in the team's `team_settings.timezone`, resolved to an instant per occurrence. NOT UTC. */
  startTime: Schema.String,
  /** `HH:MM` wall clock in the team's `team_settings.timezone`, resolved to an instant per occurrence. NOT UTC. */
  endTime: Schema.OptionFromNullOr(Schema.String),
  location: Schema.OptionFromNullOr(Schema.String),
  locationUrl: Schema.OptionFromNullOr(Schema.String),
  ownerGroupId: Schema.OptionFromNullOr(GroupId),
  ownerGroupName: Schema.OptionFromNullOr(Schema.String),
  memberGroupId: Schema.OptionFromNullOr(GroupId),
  memberGroupName: Schema.OptionFromNullOr(Schema.String),
  // The team's `team_settings.timezone` — the zone `startTime`/`endTime` are wall-clock in — so
  // the web can label inputs and format times without guessing the browser zone.
  //
  // `OptionFromOptionalKey`, matching `EventApi.EventDetail.timezone`: an old server during a
  // rolling deploy omits the key rather than decode-failing the whole response. A REQUIRED field
  // here would make a web-ahead-of-server rollout 404 the entire events and training-type pages
  // (the decode error becomes `NotFound` via `warnAndCatchAll`), not just lose the label.
  //
  // Line comments, not JSDoc: `pnpm codegen` hoists a module's first multi-line JSDoc onto the
  // `export * as EventSeriesApi` re-export in `packages/domain/src/index.ts`, where a field-level
  // note would read as documentation for the whole module.
  timezone: Schema.OptionFromOptionalKey(Schema.String),
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
  /** `HH:MM` wall clock in the team's `team_settings.timezone`, resolved to an instant per occurrence. NOT UTC. */
  startTime: Schema.String,
  /** `HH:MM` wall clock in the team's `team_settings.timezone`, resolved to an instant per occurrence. NOT UTC. */
  endTime: Schema.OptionFromNullOr(Schema.String),
  location: Schema.OptionFromNullOr(Schema.String),
  locationUrl: Schema.OptionFromNullOr(Schema.String),
  ownerGroupId: Schema.OptionFromNullOr(GroupId),
  ownerGroupName: Schema.OptionFromNullOr(Schema.String),
  memberGroupId: Schema.OptionFromNullOr(GroupId),
  memberGroupName: Schema.OptionFromNullOr(Schema.String),
  canEdit: Schema.Boolean,
  canCancel: Schema.Boolean,
  // The team's `team_settings.timezone` — the zone `startTime`/`endTime` are wall-clock in — so
  // the web can label inputs and format times without guessing the browser zone.
  //
  // `OptionFromOptionalKey`, matching `EventApi.EventDetail.timezone`: an old server during a
  // rolling deploy omits the key rather than decode-failing the whole response. A REQUIRED field
  // here would make a web-ahead-of-server rollout 404 the entire events and training-type pages
  // (the decode error becomes `NotFound` via `warnAndCatchAll`), not just lose the label.
  //
  // Line comments, not JSDoc: `pnpm codegen` hoists a module's first multi-line JSDoc onto the
  // `export * as EventSeriesApi` re-export in `packages/domain/src/index.ts`, where a field-level
  // note would read as documentation for the whole module.
  timezone: Schema.OptionFromOptionalKey(Schema.String),
}) {}

const CreateEventSeriesRequestStruct = Schema.Struct({
  title: Schema.NonEmptyString,
  trainingTypeId: Schema.OptionFromNullOr(TrainingTypeId),
  description: Schema.OptionFromNullOr(Schema.String),
  frequency: RecurrenceFrequency,
  daysOfWeek: DaysOfWeek,
  startDate: Schemas.DateTimeFromIsoString,
  endDate: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  // `HH:MM` wall clock resolved to an instant per occurrence. Whether this is team-local
  // or UTC depends on `timesAreTeamLocal` below, not unconditionally one or the other.
  //
  // Line comments, not JSDoc: see the note on `EventSeriesInfo.timezone` above —
  // `pnpm codegen` hoists a module's first multi-line JSDoc onto the `export * as
  // EventSeriesApi` re-export in `packages/domain/src/index.ts`.
  startTime: Schema.String,
  // Same dialect note as `startTime` above.
  endTime: Schema.OptionFromNullOr(Schema.String),
  location: Schema.OptionFromNullOr(Schema.String),
  locationUrl: Schema.OptionFromOptionalNullOr(EventLocationUrl),
  ownerGroupId: Schema.OptionFromNullOr(GroupId),
  memberGroupId: Schema.OptionFromNullOr(GroupId),
  // Declares the dialect of `startTime`/`endTime` in THIS payload — not the storage
  // dialect of the row being written. `TRUE` = wall clock in the team's timezone;
  // `FALSE` = UTC time-of-day. Defaults to `false` when the key is absent, because
  // every client built before #650 sends UTC time-of-day without knowing this field
  // exists at all; `withDecodingDefaultKey` (not `Schema.optionalWith`, which does not
  // exist in the pinned `effect` version) is what makes an absent key decode to `false`
  // rather than fail.
  timesAreTeamLocal: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(() => false)),
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
  // `HH:MM` wall clock resolved to an instant per occurrence. Whether this is team-local
  // or UTC depends on `timesAreTeamLocal` below, not unconditionally one or the other.
  // Line comments, not JSDoc — see the note on the create request's `startTime` above.
  startTime: Schema.OptionFromOptional(Schema.String),
  // Same dialect note as `startTime` above.
  endTime: Schema.OptionFromOptional(Schema.OptionFromNullOr(Schema.String)),
  location: Schema.OptionFromOptional(Schema.OptionFromNullOr(Schema.String)),
  locationUrl: Schema.OptionFromOptional(Schema.OptionFromNullOr(EventLocationUrl)),
  endDate: Schema.OptionFromOptional(Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString)),
  ownerGroupId: Schema.OptionFromOptional(Schema.OptionFromNullOr(GroupId)),
  memberGroupId: Schema.OptionFromOptional(Schema.OptionFromNullOr(GroupId)),
  // Declares the dialect of `startTime`/`endTime` in THIS payload — not the storage
  // dialect of the row being updated. `TRUE` = wall clock in the team's timezone;
  // `FALSE` = UTC time-of-day. Defaults to `false` when the key is absent, because
  // every client built before #650 sends UTC time-of-day without knowing this field
  // exists at all; `withDecodingDefaultKey` (not `Schema.optionalWith`, which does not
  // exist in the pinned `effect` version) is what makes an absent key decode to `false`
  // rather than fail. The server applies this check only when `startTime`/`endTime` are
  // themselves present in the payload — an omitted time is not asserting any dialect.
  timesAreTeamLocal: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(() => false)),
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

// Raised when an UPDATE payload's declared time dialect (`timesAreTeamLocal`) does not match
// the existing row's stored `times_are_team_local`. There is no create-side equivalent: a
// create has no existing row to assert against, so its payload's declared dialect BECOMES the
// new row's dialect instead (see `insertEventSeries` in `EventSeriesRepository.ts`) — only
// `updateEventSeries` can raise this error. The server never translates between dialects on
// behalf of a mismatched client — a wrong guess would silently shift `startTime`/`endTime` by
// the team's offset, an error class strictly worse than a rejected write the caller can retry.
// Only applies when the payload actually supplies `startTime`/`endTime` — see
// `assertDialectMatches` in `applications/server/src/utils/seriesTimeDialect.ts`.
//
// Line comments, not JSDoc, same reason as the field notes above: `pnpm codegen` hoists a
// module's first multi-line JSDoc onto the `export * as EventSeriesApi` re-export.
export class EventSeriesTimeDialectMismatch extends Schema.TaggedErrorClass<EventSeriesTimeDialectMismatch>()(
  'EventSeriesTimeDialectMismatch',
  {},
) {}

export class EventSeriesApiGroup extends HttpApiGroup.make('eventSeries')
  .add(
    HttpApiEndpoint.post('createEventSeries', '/teams/:teamId/event-series', {
      success: EventSeriesInfo.pipe(HttpApiSchema.status(201)),
      // Create has no existing row to assert a dialect against — the payload's declared
      // `timesAreTeamLocal` BECOMES the new row's dialect, so a create can never raise
      // `EventSeriesTimeDialectMismatch`. Only `updateEventSeries` below can.
      error: [Forbidden.pipe(HttpApiSchema.status(403))],
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
        EventSeriesTimeDialectMismatch.pipe(HttpApiSchema.status(400)),
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
