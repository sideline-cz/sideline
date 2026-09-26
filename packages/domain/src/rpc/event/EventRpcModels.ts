import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { Snowflake } from '~/models/Discord.js';
import { EventId } from '~/models/Event.js';
import { RsvpResponse } from '~/models/EventRsvp.js';
import { EventTypeColor, EventTypeId, EventTypeKind } from '~/models/EventType.js';
import { TeamMemberId } from '~/models/TeamMember.js';
import { TrainingTypeId } from '~/models/TrainingType.js';

// event_type_name/event_type_color are wire-compatible additions to the five RPC entries
// that already render `event_type`: an old peer on either side of the bot-ships-before-server
// deploy simply omits/ignores the key. `event_type_name`'s inner `OptionFromNullOr` carries
// the "seeded row, no custom name" signal, same shape as `EventApi.EventInfo.eventTypeName`.
export const EventTypeRenderFields = {
  event_type_name: Schema.OptionFromOptionalKey(Schema.OptionFromNullOr(Schema.String)),
  event_type_color: Schema.OptionFromOptionalKey(EventTypeColor),
};

export class MovedEventRow extends Schema.Class<MovedEventRow>('MovedEventRow')({
  event_id: EventId,
  old_message_id: Schema.OptionFromNullOr(Snowflake),
}) {}

export class EventDiscordMessage extends Schema.Class<EventDiscordMessage>('EventDiscordMessage')({
  discord_channel_id: Snowflake,
  discord_message_id: Snowflake,
}) {}

export class RsvpCountsResult extends Schema.Class<RsvpCountsResult>('RsvpCountsResult')({
  yesCount: Schema.Number,
  noCount: Schema.Number,
  maybeCount: Schema.Number,
  canRsvp: Schema.Boolean,
}) {}

export class SubmitRsvpResult extends Schema.Class<SubmitRsvpResult>('SubmitRsvpResult')({
  yesCount: Schema.Number,
  noCount: Schema.Number,
  maybeCount: Schema.Number,
  canRsvp: Schema.Boolean,
  isLateRsvp: Schema.Boolean,
  lateRsvpChannelId: Schema.OptionFromNullOr(Snowflake),
  message: Schema.OptionFromNullOr(Schema.String),
  /** The RSVP'ing user's name fields, for rendering `**Name** (<@id>)` on the bot side. */
  userName: Schema.OptionFromNullOr(Schema.String),
  userNickname: Schema.OptionFromNullOr(Schema.String),
  userDisplayName: Schema.OptionFromNullOr(Schema.String),
  userUsername: Schema.OptionFromNullOr(Schema.String),
}) {}

export class EventEmbedInfo extends Schema.Class<EventEmbedInfo>('EventEmbedInfo')({
  title: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  image_url: Schema.OptionFromNullOr(Schema.String),
  start_at: Schemas.DateTimeFromIsoString,
  end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  location: Schema.OptionFromNullOr(Schema.String),
  location_url: Schema.OptionFromNullOr(Schema.String),
  event_type: Schema.String,
  all_day: Schema.Boolean,
  status: Schema.String.pipe(Schema.withDecodingDefaultKey(() => 'active')),
  ...EventTypeRenderFields,
}) {}

export class ChannelEventEntry extends Schema.Class<ChannelEventEntry>('ChannelEventEntry')({
  event_id: Schema.String,
  team_id: Schema.String,
  title: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  image_url: Schema.OptionFromNullOr(Schema.String),
  start_at: Schemas.DateTimeFromIsoString,
  end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  location: Schema.OptionFromNullOr(Schema.String),
  location_url: Schema.OptionFromNullOr(Schema.String),
  event_type: Schema.String,
  status: Schema.String,
  all_day: Schema.Boolean,
  discord_message_id: Snowflake,
  ...EventTypeRenderFields,
}) {}

export class RsvpMemberNotFound extends Schema.TaggedErrorClass<RsvpMemberNotFound>()(
  'RsvpMemberNotFound',
  {},
) {}

export class RsvpDeadlinePassed extends Schema.TaggedErrorClass<RsvpDeadlinePassed>()(
  'RsvpDeadlinePassed',
  {},
) {}

export class RsvpMessageRequired extends Schema.TaggedErrorClass<RsvpMessageRequired>()(
  'RsvpMessageRequired',
  {},
) {}

export class RsvpEventNotFound extends Schema.TaggedErrorClass<RsvpEventNotFound>()(
  'RsvpEventNotFound',
  {},
) {}

export class RsvpNotGroupMember extends Schema.TaggedErrorClass<RsvpNotGroupMember>()(
  'RsvpNotGroupMember',
  {},
) {}

// The request is well-formed; the actor just hasn't finished onboarding yet.
export class RsvpProfileIncomplete extends Schema.TaggedErrorClass<RsvpProfileIncomplete>()(
  'RsvpProfileIncomplete',
  {},
) {}

export class CreateEventNotMember extends Schema.TaggedErrorClass<CreateEventNotMember>()(
  'CreateEventNotMember',
  {},
) {}

export class CreateEventForbidden extends Schema.TaggedErrorClass<CreateEventForbidden>()(
  'CreateEventForbidden',
  {},
) {}

export class CreateEventInvalidDate extends Schema.TaggedErrorClass<CreateEventInvalidDate>()(
  'CreateEventInvalidDate',
  {},
) {}

export class CreateEventResult extends Schema.Class<CreateEventResult>('CreateEventResult')({
  event_id: Schema.String,
  title: Schema.String,
}) {}

export class GuildEventListEntry extends Schema.Class<GuildEventListEntry>('GuildEventListEntry')({
  event_id: Schema.String,
  title: Schema.String,
  start_at: Schemas.DateTimeFromIsoString,
  end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  location: Schema.OptionFromNullOr(Schema.String),
  location_url: Schema.OptionFromNullOr(Schema.String),
  event_type: Schema.String,
  yes_count: Schema.Number,
  no_count: Schema.Number,
  maybe_count: Schema.Number,
  all_day: Schema.Boolean,
  ...EventTypeRenderFields,
}) {}

export class GuildEventListResult extends Schema.Class<GuildEventListResult>(
  'GuildEventListResult',
)({
  events: Schema.Array(GuildEventListEntry),
  total: Schema.Number,
  team_id: Schema.String,
}) {}

export class GuildNotFound extends Schema.TaggedErrorClass<GuildNotFound>()('GuildNotFound', {}) {}

export class RsvpAttendeeEntry extends Schema.Class<RsvpAttendeeEntry>('RsvpAttendeeEntry')({
  discord_id: Schema.OptionFromNullOr(Snowflake),
  name: Schema.OptionFromNullOr(Schema.String),
  nickname: Schema.OptionFromNullOr(Schema.String),
  username: Schema.OptionFromNullOr(Schema.String),
  display_name: Schema.OptionFromNullOr(Schema.String),
  response: RsvpResponse,
  message: Schema.OptionFromNullOr(Schema.String),
}) {}

export class RsvpAttendeesResult extends Schema.Class<RsvpAttendeesResult>('RsvpAttendeesResult')({
  attendees: Schema.Array(RsvpAttendeeEntry),
  total: Schema.Number,
}) {}

export class NonResponderRpcEntry extends Schema.Class<NonResponderRpcEntry>(
  'NonResponderRpcEntry',
)({
  discord_id: Schema.OptionFromNullOr(Snowflake),
  name: Schema.OptionFromNullOr(Schema.String),
  nickname: Schema.OptionFromNullOr(Schema.String),
  username: Schema.OptionFromNullOr(Schema.String),
  display_name: Schema.OptionFromNullOr(Schema.String),
}) {}

export class RsvpReminderSummary extends Schema.Class<RsvpReminderSummary>('RsvpReminderSummary')({
  yesCount: Schema.Number,
  noCount: Schema.Number,
  maybeCount: Schema.Number,
  nonResponders: Schema.Array(NonResponderRpcEntry),
  yesAttendees: Schema.Array(NonResponderRpcEntry),
}) {}

export class TrainingTypeChoice extends Schema.Class<TrainingTypeChoice>('TrainingTypeChoice')({
  id: TrainingTypeId,
  name: Schema.String,
}) {}

// `kind` lets the bot fall back to its own per-user-locale translated label when `name` is
// None (a seeded, never-renamed row) — the server has no reliable per-viewer locale to render
// that label itself.
export class EventTypeChoice extends Schema.Class<EventTypeChoice>('EventTypeChoice')({
  id: EventTypeId,
  kind: EventTypeKind,
  name: Schema.OptionFromNullOr(Schema.String),
}) {}

export class UpcomingEventForUserEntry extends Schema.Class<UpcomingEventForUserEntry>(
  'UpcomingEventForUserEntry',
)({
  event_id: Schema.String,
  team_id: Schema.String,
  title: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  image_url: Schema.OptionFromNullOr(Schema.String),
  start_at: Schemas.DateTimeFromIsoString,
  end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  location: Schema.OptionFromNullOr(Schema.String),
  location_url: Schema.OptionFromNullOr(Schema.String),
  event_type: Schema.String,
  yes_count: Schema.Number,
  no_count: Schema.Number,
  // `maybe_count` now means only `response = 'maybe'` ("Nevím"); `coming_later_count` below
  // carries the other non-`yes`-attending bucket that used to be folded in here.
  maybe_count: Schema.Number,
  coming_later_count: Schema.Number.pipe(Schema.withDecodingDefaultKey(() => 0)),
  all_day: Schema.Boolean,
  /**
   * Drives the personal-message "Dnes"/"Today" marker (plan §4.6): an all-day event whose
   * `status` has flipped to `'started'` is currently running, so the renderer swaps the
   * relative `<t:S:R>` timestamp for a static "today" label instead. Defaulted on decode
   * (not required on the wire) so a rolling deploy where the server hasn't shipped this
   * field yet degrades to the pre-existing `<t:S:R>` rendering rather than a hard decode
   * failure — see `TeamSettingsApi.ts:79` for the same `withDecodingDefaultKey` precedent.
   */
  status: Schema.String.pipe(Schema.withDecodingDefaultKey(() => 'active')),
  my_response: Schema.OptionFromNullOr(RsvpResponse),
  my_message: Schema.OptionFromNullOr(Schema.String),
  /**
   * Derived team-local calendar date (`YYYY-MM-DD`), projected server-side from
   * `start_at`/`end_at` and the team's timezone (plan §11.2/§11.3). Feeds Discord's
   * `buildUpcomingEventEmbed` (B0) render through `discordDateInstant`. `Option.none()`
   * means the key was absent (old-server skew); the reader falls back to
   * `DateTime.formatIsoDateUtc(start_at)`. `OptionFromOptionalKey` tolerates a producer on
   * either side of a rolling deploy that hasn't shipped this key yet — never a plain string
   * defaulted to `''` (see `EventApi.EventInfo.startDate`'s doc comment).
   */
  start_date: Schema.OptionFromOptionalKey(Schema.String),
  end_date: Schema.OptionFromOptionalKey(Schema.String),
  /**
   * The instant RSVPs close for this event — `start_at` minus the team's configured lock, with
   * the per-event-type override applied. `None` means no lock applies, which is every team
   * until a captain sets one. Feeds the `🔒 RSVP until` line on the Discord card.
   *
   * `OptionFromOptionalKey`, same rolling-deploy rationale as `start_date` above. That
   * tolerance is also the hazard: this class has TWO producers (`rpc/event/index.ts`'s
   * `Event/GetUpcomingEventsForUser` and `rpc/guild/index.ts`'s
   * `Guild/GetAllUpcomingEventsForUser`, which feeds the personal cards), and wiring only one
   * of them fails NOTHING except `test/integration/rpc/UpcomingEventsLock.test.ts`.
   */
  rsvp_closes_at: Schema.OptionFromOptionalKey(Schemas.DateTimeFromIsoString),
  ...EventTypeRenderFields,
}) {}

export class UpcomingEventsForUserResult extends Schema.Class<UpcomingEventsForUserResult>(
  'UpcomingEventsForUserResult',
)({
  events: Schema.Array(UpcomingEventForUserEntry),
  total: Schema.Number,
  team_id: Schema.String,
  // Member-level preference (plan §5.3): defaults to `true` (today's behaviour) so a
  // rolling deploy where the server hasn't shipped this key yet still decodes.
  show_attendee_list: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(() => true)),
}) {}

export class EventClaimInfo extends Schema.Class<EventClaimInfo>('EventClaimInfo')({
  event_id: EventId,
  event_type: Schema.String,
  status: Schema.String,
  claimed_by_member_id: Schema.OptionFromNullOr(TeamMemberId),
  claimed_by_display_name: Schema.OptionFromNullOr(Schema.String),
  claim_discord_channel_id: Schema.OptionFromNullOr(Snowflake),
  claim_discord_message_id: Schema.OptionFromNullOr(Snowflake),
  claim_thread_id: Schema.OptionFromNullOr(Snowflake),
  ...EventTypeRenderFields,
}) {}

export class ClaimEventNotFound extends Schema.TaggedErrorClass<ClaimEventNotFound>()(
  'ClaimEventNotFound',
  {},
) {}

export class ClaimNotTraining extends Schema.TaggedErrorClass<ClaimNotTraining>()(
  'ClaimNotTraining',
  {},
) {}

export class ClaimEventInactive extends Schema.TaggedErrorClass<ClaimEventInactive>()(
  'ClaimEventInactive',
  {},
) {}

export class ClaimNotOwnerGroupMember extends Schema.TaggedErrorClass<ClaimNotOwnerGroupMember>()(
  'ClaimNotOwnerGroupMember',
  {},
) {}

export class ClaimAlreadyClaimed extends Schema.TaggedErrorClass<ClaimAlreadyClaimed>()(
  'ClaimAlreadyClaimed',
  {
    claimer_display: Schema.OptionFromNullOr(Schema.String),
  },
) {}

export class ClaimNotClaimer extends Schema.TaggedErrorClass<ClaimNotClaimer>()(
  'ClaimNotClaimer',
  {},
) {}

// The request is well-formed; the actor just hasn't finished onboarding yet.
export class ClaimProfileIncomplete extends Schema.TaggedErrorClass<ClaimProfileIncomplete>()(
  'ClaimProfileIncomplete',
  {},
) {}

export class DecideRosterRequestResult extends Schema.Class<DecideRosterRequestResult>(
  'DecideRosterRequestResult',
)({
  outcome: Schema.Literals(['approved', 'declined', 'already_member', 'already_handled']),
  member_display_name: Schema.OptionFromNullOr(Schema.String),
}) {}

export class SetAutoApproveResult extends Schema.Class<SetAutoApproveResult>(
  'SetAutoApproveResult',
)({
  added: Schema.Number,
  cancelled: Schema.Number,
}) {}

export class RosterRequestNotFound extends Schema.TaggedErrorClass<RosterRequestNotFound>()(
  'RosterRequestNotFound',
  {},
) {}

export class RosterRequestNotPending extends Schema.TaggedErrorClass<RosterRequestNotPending>()(
  'RosterRequestNotPending',
  {},
) {}

export class NotOwnerGroupMember extends Schema.TaggedErrorClass<NotOwnerGroupMember>()(
  'NotOwnerGroupMember',
  {},
) {}

export class EventRosterEventNotFound extends Schema.TaggedErrorClass<EventRosterEventNotFound>()(
  'EventRosterEventNotFound',
  {},
) {}

export class EventRosterAlreadyLinked extends Schema.TaggedErrorClass<EventRosterAlreadyLinked>()(
  'EventRosterAlreadyLinked',
  {},
) {}

export class RosterNotFoundForLink extends Schema.TaggedErrorClass<RosterNotFoundForLink>()(
  'RosterNotFoundForLink',
  {},
) {}
