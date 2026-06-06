import { EventRpcEvents } from '@sideline/domain';
import { Effect, Match, Option } from 'effect';
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
  Match.exhaustive,
);
