import {
  Discord,
  EventRosterModel,
  EventRpcEvents,
  RosterModel,
  TeamMember,
} from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Match, Option, Schema } from 'effect';
import {
  type EventSyncEventRow,
  EventSyncEventsRepository,
} from '~/repositories/EventSyncEventsRepository.js';

export class EventPropertyMissing {
  readonly _tag = 'EventPropertyMissing';
  constructor(
    readonly event_type: string,
    readonly id: string,
    readonly property: string,
  ) {}

  errorMessage = () =>
    `Property "${this.property}" is missing for event "${this.event_type}" with id "${this.id}"`;

  log = () => Effect.logError(this.errorMessage());

  markFailed = () =>
    EventSyncEventsRepository.asEffect().pipe(
      Effect.flatMap((repository) => repository.markFailed(this.id, this.errorMessage())),
    );

  static handle = (e: EventPropertyMissing) => e.log().pipe(Effect.tap(() => e.markFailed()));
}

export const constructEvent = Match.type<EventSyncEventRow>().pipe(
  Match.when({ event_type: 'event_created' }, (r) =>
    Effect.succeed(
      new EventRpcEvents.EventCreatedEvent({
        id: r.id,
        team_id: r.team_id,
        guild_id: r.guild_id,
        event_id: r.event_id,
        title: r.event_title,
        description: r.event_description,
        image_url: r.event_image_url,
        start_at: r.event_start_at,
        end_at: r.event_end_at,
        location: r.event_location,
        location_url: r.event_location_url,
        event_type: r.event_event_type,
        discord_channel_id: r.discord_target_channel_id,
        all_day: r.event_all_day,
      }),
    ),
  ),
  Match.when({ event_type: 'event_updated' }, (r) =>
    Effect.succeed(
      new EventRpcEvents.EventUpdatedEvent({
        id: r.id,
        team_id: r.team_id,
        guild_id: r.guild_id,
        event_id: r.event_id,
        title: r.event_title,
        description: r.event_description,
        image_url: r.event_image_url,
        start_at: r.event_start_at,
        end_at: r.event_end_at,
        location: r.event_location,
        location_url: r.event_location_url,
        event_type: r.event_event_type,
        discord_channel_id: r.discord_target_channel_id,
        all_day: r.event_all_day,
      }),
    ),
  ),
  Match.when({ event_type: 'event_cancelled' }, (r) =>
    Effect.succeed(
      new EventRpcEvents.EventCancelledEvent({
        id: r.id,
        team_id: r.team_id,
        guild_id: r.guild_id,
        event_id: r.event_id,
      }),
    ),
  ),
  Match.when({ event_type: 'rsvp_reminder' }, (r) =>
    Effect.succeed(
      new EventRpcEvents.RsvpReminderEvent({
        id: r.id,
        team_id: r.team_id,
        guild_id: r.guild_id,
        event_id: r.event_id,
        title: r.event_title,
        start_at: r.event_start_at,
        discord_channel_id: r.discord_target_channel_id,
        member_group_id: r.member_group_id,
        discord_role_id: r.discord_role_id,
      }),
    ),
  ),
  Match.when({ event_type: 'event_started' }, (r) =>
    Effect.succeed(
      new EventRpcEvents.EventStartedEvent({
        id: r.id,
        team_id: r.team_id,
        guild_id: r.guild_id,
        event_id: r.event_id,
        title: r.event_title,
        image_url: r.event_image_url,
        start_at: r.event_start_at,
        end_at: r.event_end_at,
        location: r.event_location,
        location_url: r.event_location_url,
        event_type: r.event_event_type,
        member_group_id: r.member_group_id,
        discord_channel_id: r.discord_target_channel_id,
        discord_role_id: r.discord_role_id,
        all_day: r.event_all_day,
        claimed_by_discord_id: r.claimed_by_discord_id,
      }),
    ),
  ),
  Match.when({ event_type: 'training_claim_request' }, (r) =>
    Effect.succeed(
      new EventRpcEvents.TrainingClaimRequestEvent({
        id: r.id,
        team_id: r.team_id,
        guild_id: r.guild_id,
        event_id: r.event_id,
        title: r.event_title,
        start_at: r.event_start_at,
        end_at: r.event_end_at,
        location: r.event_location,
        location_url: r.event_location_url,
        description: r.event_description,
        discord_target_channel_id: r.discord_target_channel_id,
        discord_role_id: r.discord_role_id,
        owner_group_id: r.member_group_id,
      }),
    ),
  ),
  Match.when({ event_type: 'training_claim_update' }, (r) =>
    Effect.succeed(
      new EventRpcEvents.TrainingClaimUpdateEvent({
        id: r.id,
        team_id: r.team_id,
        guild_id: r.guild_id,
        event_id: r.event_id,
        title: r.event_title,
        start_at: r.event_start_at,
        end_at: r.event_end_at,
        location: r.event_location,
        location_url: r.event_location_url,
        description: r.event_description,
        claim_discord_channel_id: r.discord_target_channel_id,
        claim_discord_message_id: r.discord_role_id,
        claimed_by_member_id: r.claimed_by_member_id,
        claimed_by_discord_id: r.claimed_by_discord_id,
        claimed_by_name: r.claimed_by_name,
        claimed_by_nickname: r.claimed_by_nickname,
        claimed_by_display_name: r.claimed_by_user_display_name,
        claimed_by_username: r.claimed_by_username,
        event_status: r.event_event_type,
      }),
    ),
  ),
  Match.when({ event_type: 'unclaimed_training_reminder' }, (r) =>
    Effect.succeed(
      new EventRpcEvents.UnclaimedTrainingReminderEvent({
        id: r.id,
        team_id: r.team_id,
        guild_id: r.guild_id,
        event_id: r.event_id,
        title: r.event_title,
        start_at: r.event_start_at,
        end_at: r.event_end_at,
        location: r.event_location,
        location_url: r.event_location_url,
        discord_target_channel_id: r.discord_target_channel_id,
        discord_role_id: r.discord_role_id,
        claim_discord_channel_id: Option.none(),
        claim_discord_message_id: Option.none(),
      }),
    ),
  ),
  Match.when({ event_type: 'coaching_status' }, (r) =>
    Effect.succeed(
      new EventRpcEvents.CoachingStatusEvent({
        id: r.id,
        team_id: r.team_id,
        guild_id: r.guild_id,
        event_id: r.event_id,
        title: r.event_title,
        start_at: r.event_start_at,
        discord_target_channel_id: r.discord_target_channel_id,
        claimed_by_display_name: r.claimed_by_name,
        claimed_by_discord_id: r.claimed_by_discord_id,
        location: r.event_location,
      }),
    ),
  ),
  // Roster attendance sync events — column overloads documented in EventSyncEventsRepository
  Match.when({ event_type: 'event_roster_approval_request' }, (r) =>
    Effect.succeed(
      new EventRpcEvents.EventRosterApprovalRequestEvent({
        id: r.id,
        team_id: r.team_id,
        guild_id: r.guild_id,
        event_id: r.event_id,
        // discord_target_channel_id overloaded with event_roster_id
        event_roster_id: Schema.decodeUnknownSync(EventRosterModel.EventRosterId)(
          Option.getOrElse(r.discord_target_channel_id, () => ''),
        ),
        // member_group_id overloaded with roster_id
        roster_id: Schema.decodeUnknownSync(RosterModel.RosterId)(
          Option.getOrElse(r.member_group_id, () => ''),
        ),
        // claimed_by_member_id stores the candidate
        team_member_id: Schema.decodeUnknownSync(TeamMember.TeamMemberId)(
          Option.getOrElse(r.claimed_by_member_id, () => ''),
        ),
        // candidate_discord_id is resolved via the member JOIN on claimed_by_member_id
        candidate_discord_id: r.claimed_by_discord_id,
        // claimed_by_name = COALESCE(u.name, ese.claimed_by_display_name) — uses stored snapshot
        // when the user has no name, ensuring the bot embed shows something meaningful
        candidate_display_name: r.claimed_by_name,
        title: r.event_title,
        start_at: r.event_start_at,
        // event_location overloaded with owners_thread_id (Snowflake stored as plain string)
        owners_thread_id: Option.map(r.event_location, (s) =>
          Schema.decodeUnknownSync(Discord.Snowflake)(s),
        ),
        // discord_role_id overloaded with owner_channel_id
        owner_channel_id: r.discord_role_id,
        // event_description overloaded with roster_name
        roster_name: r.event_description,
      }),
    ),
  ),
  Match.when({ event_type: 'event_roster_approval_cancel' }, (r) =>
    Effect.succeed(
      new EventRpcEvents.EventRosterApprovalCancelEvent({
        id: r.id,
        team_id: r.team_id,
        guild_id: r.guild_id,
        event_id: r.event_id,
        // event_location overloaded with owners_thread_id
        owners_thread_id: Option.map(r.event_location, (s) =>
          Schema.decodeUnknownSync(Discord.Snowflake)(s),
        ),
        // discord_role_id overloaded with discord_message_id
        discord_message_id: Option.map(r.discord_role_id, (s) =>
          Schema.decodeUnknownSync(Discord.Snowflake)(s),
        ),
      }),
    ),
  ),
  Match.when({ event_type: 'event_roster_thread_delete' }, (r) =>
    Effect.succeed(
      new EventRpcEvents.EventRosterThreadDeleteEvent({
        id: r.id,
        team_id: r.team_id,
        guild_id: r.guild_id,
        event_id: r.event_id,
        // event_location overloaded with owners_thread_id
        owners_thread_id: Option.map(r.event_location, (s) =>
          Schema.decodeUnknownSync(Discord.Snowflake)(s),
        ),
      }),
    ),
  ),
  Match.when({ event_type: 'event_channel_moved' }, (r) =>
    Effect.succeed(
      new EventRpcEvents.EventChannelMovedEvent({
        id: r.id,
        team_id: r.team_id,
        guild_id: r.guild_id,
        event_id: r.event_id,
        new_channel_id: r.discord_target_channel_id,
        old_channel_id: r.discord_role_id,
      }),
    ),
  ),
  Match.when({ event_type: 'teams_generated' }, (r) => {
    // A teams_generated row with a null or empty payload is malformed — fail so the
    // ProcessorService marks the event FAILED for retry instead of posting empty teams.
    const teamsOption = r.teams_payload;
    if (Option.isNone(teamsOption) || teamsOption.value.length === 0) {
      return LogicError.die(
        `teams_generated event ${r.id} has a null or empty teams_payload — marking failed`,
      );
    }
    return Effect.succeed(
      new EventRpcEvents.TeamsGeneratedEvent({
        id: r.id,
        team_id: r.team_id,
        guild_id: r.guild_id,
        event_id: r.event_id,
        title: r.event_title,
        discord_target_channel_id: r.discord_target_channel_id,
        teams: teamsOption.value,
      }),
    );
  }),
  Match.exhaustive,
);
