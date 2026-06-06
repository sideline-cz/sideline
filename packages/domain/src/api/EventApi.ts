import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { fieldState } from '~/api/RequestFilters.js';
import { Snowflake } from '~/models/Discord.js';
import { EventId, EventStatus, EventType } from '~/models/Event.js';
import { EventSeriesId } from '~/models/EventSeries.js';
import { GroupId } from '~/models/GroupModel.js';
import { TeamId } from '~/models/Team.js';
import { TrainingTypeId } from '~/models/TrainingType.js';

// Matches a literal IPv4 dotted-quad (exactly four decimal octets)
const IPV4_LITERAL_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

// IPv6 reserved ranges (tested against the de-bracketed hostname)
// Covers: loopback (::1), unspecified (::), unique-local (fc00::/7 = fc.. or fd..),
// link-local (fe80::/10 = fe8x, fe9x, feax, febx), and IPv4-mapped (::ffff:)
const PRIVATE_IPV6_PATTERN = /^(::1$|::$|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe[89ab][0-9a-f]:|::ffff:)/i;

export const isPublicHttpsUrl = (value: string): boolean => {
  // Reject URLs containing unencoded characters that break Discord markdown or are illegal in URLs
  if (/[<>\s]/.test(value)) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;

  // url.hostname for an IPv6 literal includes brackets, e.g. "[::1]" — strip them
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;

  // Check IPv4 literals only (exact dotted-quad) — avoids false positives on domains like 10.example.com
  if (IPV4_LITERAL_PATTERN.test(hostname)) {
    const parts = hostname.split('.').map(Number);
    const [a, b] = parts;
    // 127.x.x.x — loopback
    if (a === 127) return false;
    // 10.x.x.x — RFC 1918
    if (a === 10) return false;
    // 172.16.x.x – 172.31.x.x — RFC 1918
    if (a === 172 && b >= 16 && b <= 31) return false;
    // 192.168.x.x — RFC 1918
    if (a === 192 && b === 168) return false;
    // 169.254.x.x — link-local
    if (a === 169 && b === 254) return false;
    // 0.0.0.0
    if (a === 0) return false;
  }

  // Check literal hostnames (exact match only — avoids false positives on subdomains)
  if (hostname === 'localhost' || hostname === '0.0.0.0') return false;

  // Check IPv6 reserved ranges
  if (PRIVATE_IPV6_PATTERN.test(hostname)) return false;

  return true;
};

const isValidEventImageUrl = (value: string): boolean | string => {
  if (!isPublicHttpsUrl(value)) {
    // Provide a specific message based on the failure reason
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return 'Image URL must be a valid URL';
    }
    if (url.protocol !== 'https:')
      return 'Image URL must use https:// protocol (http://, data:, javascript:, etc. are not allowed)';
    if (url.username !== '' || url.password !== '')
      return 'Image URL must not contain userinfo (username/password)';
    return 'Image URL must point to a public host (loopback and private network addresses are not allowed)';
  }
  return true;
};

export const EventImageUrl = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(2048)),
  Schema.check(Schema.makeFilter<string>(isValidEventImageUrl)),
);
export type EventImageUrl = typeof EventImageUrl.Type;

const isValidEventLocationUrl = (value: string): boolean | string => {
  if (value.length > 2048) return 'Location URL must not exceed 2048 characters';
  if (!isPublicHttpsUrl(value))
    return 'Location URL must be a valid public https:// URL without userinfo';
  return true;
};

export const EventLocationUrl = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(2048)),
  Schema.check(Schema.makeFilter<string>(isValidEventLocationUrl)),
);
export type EventLocationUrl = typeof EventLocationUrl.Type;

export class EventInfo extends Schema.Class<EventInfo>('EventInfo')({
  eventId: EventId,
  teamId: TeamId,
  title: Schema.String,
  eventType: EventType,
  trainingTypeName: Schema.OptionFromNullOr(Schema.String),
  description: Schema.OptionFromNullOr(Schema.String),
  imageUrl: Schema.OptionFromNullOr(Schema.String),
  startAt: Schemas.DateTimeFromIsoString,
  endAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  location: Schema.OptionFromNullOr(Schema.String),
  locationUrl: Schema.OptionFromNullOr(Schema.String),
  status: EventStatus,
  allDay: Schema.Boolean,
  seriesId: Schema.OptionFromNullOr(EventSeriesId),
}) {}

export class EventDetail extends Schema.Class<EventDetail>('EventDetail')({
  eventId: EventId,
  teamId: TeamId,
  title: Schema.String,
  eventType: EventType,
  trainingTypeId: Schema.OptionFromNullOr(TrainingTypeId),
  trainingTypeName: Schema.OptionFromNullOr(Schema.String),
  description: Schema.OptionFromNullOr(Schema.String),
  imageUrl: Schema.OptionFromNullOr(Schema.String),
  startAt: Schemas.DateTimeFromIsoString,
  endAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  location: Schema.OptionFromNullOr(Schema.String),
  locationUrl: Schema.OptionFromNullOr(Schema.String),
  status: EventStatus,
  allDay: Schema.Boolean,
  createdByName: Schema.OptionFromNullOr(Schema.String),
  canEdit: Schema.Boolean,
  canCancel: Schema.Boolean,
  seriesId: Schema.OptionFromNullOr(EventSeriesId),
  seriesModified: Schema.Boolean,
  discordChannelId: Schema.OptionFromNullOr(Snowflake),
  ownerGroupId: Schema.OptionFromNullOr(GroupId),
  ownerGroupName: Schema.OptionFromNullOr(Schema.String),
  memberGroupId: Schema.OptionFromNullOr(GroupId),
  memberGroupName: Schema.OptionFromNullOr(Schema.String),
}) {}

export class EventListResponse extends Schema.Class<EventListResponse>('EventListResponse')({
  canCreate: Schema.Boolean,
  events: Schema.Array(EventInfo),
}) {}

const CreateEventRequestStruct = Schema.Struct({
  title: Schema.NonEmptyString,
  eventType: EventType,
  trainingTypeId: Schema.OptionFromNullOr(TrainingTypeId),
  description: Schema.OptionFromNullOr(Schema.String),
  imageUrl: Schema.OptionFromOptionalNullOr(EventImageUrl),
  startAt: Schemas.DateTimeFromIsoString,
  endAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  allDay: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(() => false)),
  location: Schema.OptionFromNullOr(Schema.String),
  locationUrl: Schema.OptionFromOptionalNullOr(EventLocationUrl),
  discordChannelId: Schema.OptionFromNullOr(Snowflake),
  ownerGroupId: Schema.OptionFromNullOr(GroupId),
  memberGroupId: Schema.OptionFromNullOr(GroupId),
});
export const CreateEventRequest = CreateEventRequestStruct.pipe(
  Schema.check(
    Schema.makeFilter<Schema.Schema.Type<typeof CreateEventRequestStruct>>((req) => {
      if (fieldState(req.locationUrl) === 'setting' && fieldState(req.location) !== 'setting')
        return 'Location URL requires location text';
      return true;
    }),
  ),
);
export type CreateEventRequest = Schema.Schema.Type<typeof CreateEventRequest>;

const UpdateEventRequestStruct = Schema.Struct({
  title: Schema.OptionFromOptional(Schema.NonEmptyString),
  eventType: Schema.OptionFromOptional(EventType),
  trainingTypeId: Schema.OptionFromOptional(Schema.OptionFromNullOr(TrainingTypeId)),
  description: Schema.OptionFromOptional(Schema.OptionFromNullOr(Schema.String)),
  imageUrl: Schema.OptionFromOptional(Schema.OptionFromNullOr(EventImageUrl)),
  startAt: Schema.OptionFromOptional(Schemas.DateTimeFromIsoString),
  endAt: Schema.OptionFromOptional(Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString)),
  allDay: Schema.OptionFromOptional(Schema.Boolean),
  location: Schema.OptionFromOptional(Schema.OptionFromNullOr(Schema.String)),
  locationUrl: Schema.OptionFromOptional(Schema.OptionFromNullOr(EventLocationUrl)),
  discordChannelId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  ownerGroupId: Schema.OptionFromOptional(Schema.OptionFromNullOr(GroupId)),
  memberGroupId: Schema.OptionFromOptional(Schema.OptionFromNullOr(GroupId)),
});
export const UpdateEventRequest = UpdateEventRequestStruct.pipe(
  Schema.check(
    Schema.makeFilter<Schema.Schema.Type<typeof UpdateEventRequestStruct>>((req) => {
      if (fieldState(req.locationUrl) === 'setting' && fieldState(req.location) === 'clearing')
        return 'Location URL requires location text';
      return true;
    }),
  ),
);
export type UpdateEventRequest = Schema.Schema.Type<typeof UpdateEventRequest>;

export class EventNotFound extends Schema.TaggedErrorClass<EventNotFound>()('EventNotFound', {}) {}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()('EventForbidden', {}) {}

export class EventCancelled extends Schema.TaggedErrorClass<EventCancelled>()(
  'EventCancelled',
  {},
) {}

export class EventNotActive extends Schema.TaggedErrorClass<EventNotActive>()(
  'EventNotActive',
  {},
) {}

export class EventApiGroup extends HttpApiGroup.make('event')
  .add(
    HttpApiEndpoint.get('listEvents', '/teams/:teamId/events', {
      success: EventListResponse,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createEvent', '/teams/:teamId/events', {
      success: EventInfo.pipe(HttpApiSchema.status(201)),
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      payload: CreateEventRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getEvent', '/teams/:teamId/events/:eventId', {
      success: EventDetail,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, eventId: EventId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateEvent', '/teams/:teamId/events/:eventId', {
      success: EventDetail,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventNotFound.pipe(HttpApiSchema.status(404)),
        EventNotActive.pipe(HttpApiSchema.status(400)),
      ],
      payload: UpdateEventRequest,
      params: { teamId: TeamId, eventId: EventId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('cancelEvent', '/teams/:teamId/events/:eventId/cancel', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventNotFound.pipe(HttpApiSchema.status(404)),
        EventNotActive.pipe(HttpApiSchema.status(400)),
      ],
      params: { teamId: TeamId, eventId: EventId },
    }).middleware(AuthMiddleware),
  ) {}
