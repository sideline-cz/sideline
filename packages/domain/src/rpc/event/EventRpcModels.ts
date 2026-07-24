import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { Snowflake } from '~/models/Discord.js';
import { EventId } from '~/models/Event.js';
import { RsvpResponse } from '~/models/EventRsvp.js';
import { TeamMemberId } from '~/models/TeamMember.js';
import { TrainingTypeId } from '~/models/TrainingType.js';

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
  response: Schema.Literals(['yes', 'no', 'maybe']),
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
  maybe_count: Schema.Number,
  all_day: Schema.Boolean,
  my_response: Schema.OptionFromNullOr(Schema.Literals(['yes', 'no', 'maybe'])),
  /**
   * The TRUE (unprojected) stored response, additive alongside the legacy
   * `my_response` above. `my_response` intentionally stays pinned to the
   * legacy 3-value vocabulary for wire safety (see `rsvpWireProjection.ts`),
   * but bot-side logic that must distinguish a real `coming_later` RSVP from a
   * legacy `maybe` (e.g. which message-management buttons to render) needs
   * the unprojected value. Uses `OptionFromOptionalKey` (not `OptionFromNullOr`)
   * so a rolling deploy where the bot updates before the server — and briefly
   * decodes a response from an older producer that omits this key entirely —
   * tolerates the missing key as `Option.none()` instead of a hard decode
   * failure.
   */
  my_response_actual: Schema.OptionFromOptionalKey(RsvpResponse),
  my_message: Schema.OptionFromNullOr(Schema.String),
}) {}

export class UpcomingEventsForUserResult extends Schema.Class<UpcomingEventsForUserResult>(
  'UpcomingEventsForUserResult',
)({
  events: Schema.Array(UpcomingEventForUserEntry),
  total: Schema.Number,
  team_id: Schema.String,
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
