import {
  type Discord,
  type Event,
  EventRpcGroup,
  EventRpcModels,
  type EventRsvp,
  type GroupModel,
  type RosterModel,
  Team,
  TeamMember,
  type TrainingType,
  User,
} from '@sideline/domain';
import { LogicError, Options, Schemas } from '@sideline/effect-lib';
import {
  Array,
  Data,
  DateTime,
  Effect,
  flow,
  Metric,
  Option,
  Schema,
  type ServiceMap,
} from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { rsvpSubmissionsTotal } from '~/metrics.js';
import { ChannelEventDividersRepository } from '~/repositories/ChannelEventDividersRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventRosterRequestsRepository } from '~/repositories/EventRosterRequestsRepository.js';
import { EventRostersRepository } from '~/repositories/EventRostersRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { resolveChannel } from '~/services/EventChannelResolver.js';
import { EventRosterProvisioningService } from '~/services/EventRosterProvisioningService.js';
import { emitTrainingClaimRequestIfApplicable } from '~/services/TrainingClaimEmitter.js';
import { constructEvent } from './events.js';

class NoChanges extends Data.TaggedError('NoChanges')<{
  count: 0;
}> {
  static make = () => new NoChanges({ count: 0 });
}

class TeamMemberLookup extends Schema.Class<TeamMemberLookup>('TeamMemberLookup')({
  id: TeamMember.TeamMemberId,
  name: Schema.OptionFromNullOr(Schema.String),
  nickname: Schema.OptionFromNullOr(Schema.String),
  display_name: Schema.OptionFromNullOr(Schema.String),
  username: Schema.OptionFromNullOr(Schema.String),
}) {}

const getRsvpCounts = (
  rsvps: ServiceMap.Service.Shape<typeof EventRsvpsRepository>,
  eventId: Event.EventId,
  events: ServiceMap.Service.Shape<typeof EventsRepository>,
) =>
  Effect.Do.pipe(
    Effect.bind('counts', () => rsvps.countRsvpsByEventId(eventId)),
    Effect.bind('event', () =>
      events.findEventByIdWithDetails(eventId).pipe(Effect.map(Option.getOrUndefined)),
    ),
    Effect.map(({ counts, event }) => {
      let yesCount = 0;
      let noCount = 0;
      let maybeCount = 0;
      for (const c of counts) {
        if (c.response === 'yes') yesCount = c.count;
        else if (c.response === 'no') noCount = c.count;
        else if (c.response === 'maybe') maybeCount = c.count;
      }
      const canRsvp = event !== undefined && event.status === 'active';
      return new EventRpcModels.RsvpCountsResult({ yesCount, noCount, maybeCount, canRsvp });
    }),
  );

class TeamLookupResult extends Schema.Class<TeamLookupResult>('TeamLookupResult')({
  id: Team.TeamId,
}) {}

class UserLookupResult extends Schema.Class<UserLookupResult>('UserLookupResult')({
  id: User.UserId,
  team_member_id: TeamMember.TeamMemberId,
}) {}

const parseDateTime = (input: string): Option.Option<DateTime.Utc> => {
  const match = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/.exec(input.trim());
  if (!match) return Option.none();
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr] = match;
  const year = Number.parseInt(yearStr, 10);
  const month = Number.parseInt(monthStr, 10);
  const day = Number.parseInt(dayStr, 10);
  const hour = Number.parseInt(hourStr, 10);
  const minute = Number.parseInt(minuteStr, 10);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59)
    return Option.none();
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  if (Number.isNaN(date.getTime())) return Option.none();
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute
  )
    return Option.none();
  return Option.some(DateTime.fromDateUnsafe(date));
};

const createEvent = (
  sql: SqlClient.SqlClient,
  events: ServiceMap.Service.Shape<typeof EventsRepository>,
  syncEvents: ServiceMap.Service.Shape<typeof EventSyncEventsRepository>,
  members: ServiceMap.Service.Shape<typeof TeamMembersRepository>,
  trainingTypes: ServiceMap.Service.Shape<typeof TrainingTypesRepository>,
  _mappingRepo: ServiceMap.Service.Shape<typeof DiscordChannelMappingRepository>,
  input: {
    readonly guild_id: Discord.Snowflake;
    readonly discord_user_id: Discord.Snowflake;
    readonly event_type: Event.EventType;
    readonly title: string;
    readonly start_at: string;
    readonly end_at: Option.Option<string>;
    readonly location: Option.Option<string>;
    readonly location_url: Option.Option<string>;
    readonly description: Option.Option<string>;
    readonly training_type_id: Option.Option<TrainingType.TrainingTypeId>;
  },
) =>
  Effect.Do.pipe(
    Effect.bind('teamId', () =>
      SqlSchema.findOne({
        Request: Schema.String,
        Result: TeamLookupResult,
        execute: (guildId) => sql`SELECT id FROM teams WHERE guild_id = ${guildId}`,
      })(input.guild_id).pipe(
        Effect.catchTag(
          ['SqlError', 'SchemaError'],
          LogicError.withMessage(
            (e) => `Failed looking up team for guild ${input.guild_id}: ${e.message}`,
          ),
        ),
        Effect.catchTag('NoSuchElementError', () =>
          Effect.fail(new EventRpcModels.CreateEventNotMember()),
        ),
        Effect.map((result) => result.id),
      ),
    ),
    Effect.bind('userLookup', ({ teamId }) =>
      SqlSchema.findOne({
        Request: Schema.Struct({
          discord_user_id: Schema.String,
          team_id: Schema.String,
        }),
        Result: UserLookupResult,
        execute: (i) => sql`
          SELECT u.id, tm.id AS team_member_id FROM team_members tm
          JOIN users u ON u.id = tm.user_id
          WHERE u.discord_id = ${i.discord_user_id} AND tm.team_id = ${i.team_id}
        `,
      })({
        discord_user_id: input.discord_user_id,
        team_id: teamId,
      }).pipe(
        Effect.catchTag(
          ['SqlError', 'SchemaError'],
          LogicError.withMessage(
            (e) => `Failed looking up user ${input.discord_user_id} in team: ${e.message}`,
          ),
        ),
        Effect.catchTag('NoSuchElementError', () =>
          Effect.fail(new EventRpcModels.CreateEventNotMember()),
        ),
      ),
    ),
    Effect.bind('membership', ({ teamId, userLookup }) =>
      members
        .findMembershipByIds(teamId, userLookup.id)
        .pipe(Effect.flatMap(Options.toEffect(() => new EventRpcModels.CreateEventNotMember()))),
    ),
    Effect.tap(({ membership }) =>
      membership.permissions.includes('event:create')
        ? Effect.void
        : Effect.fail(new EventRpcModels.CreateEventForbidden()),
    ),
    Effect.bind('parsedStartAt', () => Effect.fromOption(parseDateTime(input.start_at))),
    Effect.catchTag('NoSuchElementError', () =>
      Effect.fail(new EventRpcModels.CreateEventInvalidDate()),
    ),
    Effect.bind('parsedEndAt', () =>
      input.end_at.pipe(
        Option.map(parseDateTime),
        Option.map(Option.map(Effect.succeed)),
        Option.map(Option.getOrElse(() => Effect.fail(new EventRpcModels.CreateEventForbidden()))),
        Options.extractEffect,
      ),
    ),
    Effect.bind('validatedTrainingTypeId', ({ teamId }) =>
      input.event_type !== 'training'
        ? Effect.succeed(Option.none<TrainingType.TrainingTypeId>())
        : Option.match(input.training_type_id, {
            onNone: () => Effect.succeed(Option.none<TrainingType.TrainingTypeId>()),
            onSome: (ttId) =>
              trainingTypes.findTrainingTypeById(ttId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new EventRpcModels.CreateEventForbidden()),
                    onSome: (tt) =>
                      tt.team_id === teamId
                        ? Effect.succeed(Option.some(ttId))
                        : Effect.fail(new EventRpcModels.CreateEventForbidden()),
                  }),
                ),
              ),
          }),
    ),
    // Inherit owner/member groups from the training type when not provided.
    Effect.bind('resolvedGroups', ({ validatedTrainingTypeId }) =>
      Option.match(validatedTrainingTypeId, {
        onNone: () =>
          Effect.succeed({
            ownerGroupId: Option.none<GroupModel.GroupId>(),
            memberGroupId: Option.none<GroupModel.GroupId>(),
          }),
        onSome: (ttId) =>
          trainingTypes.findTrainingTypeById(ttId).pipe(
            Effect.map(
              Option.match({
                onNone: () => ({
                  ownerGroupId: Option.none<GroupModel.GroupId>(),
                  memberGroupId: Option.none<GroupModel.GroupId>(),
                }),
                onSome: (tt) => ({
                  ownerGroupId: tt.owner_group_id,
                  memberGroupId: tt.member_group_id,
                }),
              }),
            ),
          ),
      }),
    ),
    Effect.bind(
      'event',
      ({
        teamId,
        userLookup,
        parsedStartAt,
        parsedEndAt,
        validatedTrainingTypeId,
        resolvedGroups,
      }) =>
        events
          .insertEvent({
            teamId,
            trainingTypeId: validatedTrainingTypeId,
            eventType: input.event_type,
            title: input.title,
            description: input.description,
            startAt: parsedStartAt,
            endAt: parsedEndAt,
            location: input.location,
            locationUrl: input.location_url,
            createdBy: userLookup.team_member_id,
            ownerGroupId: resolvedGroups.ownerGroupId,
            memberGroupId: resolvedGroups.memberGroupId,
          })
          .pipe(
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(
                () => `Failed inserting event "${input.title}" — no row returned`,
              ),
            ),
          ),
    ),
    Effect.bind('resolvedChannel', ({ teamId, event }) => resolveChannel(teamId, event.id)),
    Effect.tap(({ teamId, event, resolvedChannel }) =>
      syncEvents.emitEventCreated(
        teamId,
        event.id,
        event.title,
        event.description,
        event.start_at,
        event.end_at,
        event.location,
        event.event_type,
        resolvedChannel,
      ),
    ),
    Effect.tap(({ teamId, event }) =>
      emitTrainingClaimRequestIfApplicable({
        teamId,
        eventId: event.id,
        eventType: event.event_type,
        ownerGroupId: event.owner_group_id,
        title: event.title,
        description: event.description,
        startAt: event.start_at,
        endAt: event.end_at,
        location: event.location,
        locationUrl: event.location_url,
      }),
    ),
    Effect.map(
      ({ event }) =>
        new EventRpcModels.CreateEventResult({
          event_id: event.id,
          title: event.title,
        }),
    ),
  );

// ---------------------------------------------------------------------------
// All services gathered upfront; handlers are built in a single Effect.map step
// to avoid TypeScript's TS2589 "type instantiation excessively deep" error that
// occurs when Effect.Do.pipe accumulates 30+ sequential Effect.let steps.
// ---------------------------------------------------------------------------
export const EventsRpcLive = EventRpcGroup.EventRpcGroup.toLayer(
  Effect.all({
    events: EventsRepository.asEffect(),
    rsvps: EventRsvpsRepository.asEffect(),
    syncEvents: EventSyncEventsRepository.asEffect(),
    members: TeamMembersRepository.asEffect(),
    groups: GroupsRepository.asEffect(),
    sql: SqlClient.SqlClient.asEffect(),
    trainingTypesRepo: TrainingTypesRepository.asEffect(),
    teamsRepo: TeamsRepository.asEffect(),
    teamSettings: TeamSettingsRepository.asEffect(),
    channelDividers: ChannelEventDividersRepository.asEffect(),
    mappingRepo: DiscordChannelMappingRepository.asEffect(),
    eventRosters: EventRostersRepository.asEffect(),
    rosterRequests: EventRosterRequestsRepository.asEffect(),
    provisioning: EventRosterProvisioningService.asEffect(),
  }).pipe(
    Effect.map((svc) => ({
      'Event/GetUnprocessedEvents': ({ limit }: { readonly limit: number }) =>
        svc.syncEvents.findUnprocessed(limit).pipe(
          Effect.map(Array.map(flow(constructEvent))),
          Effect.tap((events) =>
            Array.isArrayEmpty(events) ? Effect.fail(NoChanges.make()) : Effect.void,
          ),
          Effect.tap((events) =>
            Effect.logInfo(`Collected ${events.length} event sync events from database.`),
          ),
          Effect.flatMap(Effect.all),
          Effect.tap((events) =>
            Effect.logInfo(`Successfully mapped ${events.length} event sync events from database.`),
          ),
          Effect.catchTag('NoChanges', () => Effect.succeed(Array.empty())),
        ),

      'Event/MarkEventProcessed': ({ id }: { readonly id: string }) =>
        svc.syncEvents.markProcessed(id),

      'Event/MarkEventFailed': ({ id, error }: { readonly id: string; readonly error: string }) =>
        svc.syncEvents.markFailed(id, error),

      'Event/SaveDiscordMessageId': ({
        event_id,
        discord_channel_id,
        discord_message_id,
      }: {
        readonly event_id: Event.EventId;
        readonly discord_channel_id: Discord.Snowflake;
        readonly discord_message_id: Discord.Snowflake;
      }) => svc.events.saveDiscordMessageId(event_id, discord_channel_id, discord_message_id),

      'Event/GetDiscordMessageId': ({ event_id }: { readonly event_id: Event.EventId }) =>
        svc.events.getDiscordMessageId(event_id).pipe(
          Effect.map(
            Option.flatMap((row) =>
              Option.all({
                discord_channel_id: row.discord_channel_id,
                discord_message_id: row.discord_message_id,
              }).pipe(Option.map((ids) => new EventRpcModels.EventDiscordMessage(ids))),
            ),
          ),
        ),

      'Event/GetChannelsWithStoredMessages': () => svc.events.findAllChannelsWithStoredMessages(),

      'Event/SubmitRsvp': ({
        event_id,
        team_id,
        discord_user_id,
        response,
        message,
        clearMessage,
      }: {
        readonly event_id: Event.EventId;
        readonly team_id: Team.TeamId;
        readonly discord_user_id: Discord.Snowflake;
        readonly response: EventRsvp.RsvpResponse;
        readonly message: Option.Option<string>;
        readonly clearMessage: boolean;
      }) =>
        Effect.Do.pipe(
          Effect.tap(() =>
            Effect.logInfo('Submitting Rsvp Info', {
              event_id,
              team_id,
              discord_user_id,
              response,
              message,
            }),
          ),
          Effect.bind('event', () =>
            svc.events.findEventByIdWithDetails(event_id).pipe(
              Effect.tap((event) => Effect.logInfo('Found event by id', event)),
              Effect.flatMap(Options.toEffect(() => new EventRpcModels.RsvpEventNotFound())),
            ),
          ),
          Effect.tap(({ event }) =>
            event.status !== 'active'
              ? Effect.fail(new EventRpcModels.RsvpDeadlinePassed())
              : Effect.void,
          ),
          Effect.bind('member', () =>
            SqlSchema.findOne({
              Request: Schema.Struct({
                discord_user_id: Schema.String,
                team_id: Schema.String,
              }),
              Result: TeamMemberLookup,
              execute: (input) => svc.sql`
                SELECT tm.id,
                       u.name,
                       u.discord_nickname AS nickname,
                       u.discord_display_name AS display_name,
                       u.username
                FROM team_members tm
                JOIN users u ON u.id = tm.user_id
                WHERE u.discord_id = ${input.discord_user_id} AND tm.team_id = ${input.team_id}
              `,
            })({
              discord_user_id,
              team_id,
            }).pipe(
              Effect.catchTag('NoSuchElementError', () =>
                Effect.fail(new EventRpcModels.RsvpMemberNotFound()),
              ),
              Effect.mapError(() => new EventRpcModels.RsvpMemberNotFound()),
            ),
          ),
          Effect.tap(({ event, member }) =>
            Option.match(event.member_group_id, {
              onNone: () => Effect.void,
              onSome: (groupId) =>
                svc.groups
                  .getDescendantMemberIds(groupId)
                  .pipe(
                    Effect.flatMap((memberIds) =>
                      Array.contains(memberIds, member.id)
                        ? Effect.void
                        : Effect.fail(new EventRpcModels.RsvpNotGroupMember()),
                    ),
                  ),
            }),
          ),
          Effect.bind('upsertResult', ({ member }) =>
            svc.rsvps.upsertRsvp(event_id, member.id, response, message, clearMessage).pipe(
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(
                  () => `Failed upserting RSVP for event ${event_id} — no row returned`,
                ),
              ),
              Effect.tap(() =>
                Metric.update(Metric.withAttributes(rsvpSubmissionsTotal, { response }), 1),
              ),
            ),
          ),
          // Best-effort: call provisioning after RSVP — failure must NOT fail the write
          Effect.tap(({ event, member, upsertResult }) =>
            svc.provisioning
              .onRsvp({
                teamId: team_id,
                event: {
                  id: event.id,
                  owner_group_id: event.owner_group_id,
                  member_group_id: event.member_group_id,
                  title: event.title,
                  start_at: event.start_at,
                },
                memberId: member.id,
                discordUserId: Option.some(discord_user_id),
                priorResponse: upsertResult.priorResponse,
                newResponse: response,
                displayName: member.name,
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    'EventRosterProvisioningService.onRsvp best-effort error in SubmitRsvp RPC',
                    cause,
                  ),
                ),
              ),
          ),
          Effect.bind('counts', () => getRsvpCounts(svc.rsvps, event_id, svc.events)),
          Effect.let(
            'isLateRsvp',
            ({ event, upsertResult }) =>
              Option.isSome(event.reminder_sent_at) &&
              (Option.isNone(upsertResult.priorResponse) ||
                Option.exists(upsertResult.priorResponse, (r) => r !== response)),
          ),
          Effect.bind('lateRsvpChannelId', ({ isLateRsvp }) =>
            isLateRsvp
              ? svc.teamSettings.findLateRsvpChannelId(team_id)
              : Effect.succeed(Option.none<Discord.Snowflake>()),
          ),
          Effect.map(
            ({ counts, isLateRsvp, lateRsvpChannelId, upsertResult, member }) =>
              new EventRpcModels.SubmitRsvpResult({
                yesCount: counts.yesCount,
                noCount: counts.noCount,
                maybeCount: counts.maybeCount,
                canRsvp: counts.canRsvp,
                isLateRsvp,
                lateRsvpChannelId,
                message: upsertResult.row.message,
                userName: member.name,
                userNickname: member.nickname,
                userDisplayName: member.display_name,
                userUsername: member.username,
              }),
          ),
        ),

      'Event/GetRsvpCounts': ({ event_id }: { readonly event_id: Event.EventId }) =>
        getRsvpCounts(svc.rsvps, event_id, svc.events),

      'Event/GetEventEmbedInfo': ({ event_id }: { readonly event_id: Event.EventId }) =>
        svc.events.findEventByIdWithDetails(event_id).pipe(
          Effect.map(
            Option.map(
              (row) =>
                new EventRpcModels.EventEmbedInfo({
                  title: row.title,
                  description: row.description,
                  image_url: row.image_url,
                  start_at: row.start_at,
                  end_at: row.end_at,
                  location: row.location,
                  location_url: row.location_url,
                  event_type: row.event_type,
                  all_day: row.all_day,
                }),
            ),
          ),
        ),

      'Event/GetChannelEvents': ({
        discord_channel_id,
      }: {
        readonly discord_channel_id: Discord.Snowflake;
      }) =>
        svc.events.findEventsByChannelId(discord_channel_id).pipe(
          Effect.map(
            Array.map(
              (row) =>
                new EventRpcModels.ChannelEventEntry({
                  event_id: row.event_id,
                  team_id: row.team_id,
                  title: row.title,
                  description: row.description,
                  image_url: row.image_url,
                  start_at: row.start_at,
                  end_at: row.end_at,
                  location: row.location,
                  location_url: row.location_url,
                  event_type: row.event_type,
                  status: row.status,
                  discord_message_id: row.discord_message_id,
                  all_day: row.all_day,
                }),
            ),
          ),
        ),

      'Event/GetRsvpAttendees': ({
        event_id,
        offset,
        limit,
      }: {
        readonly event_id: Event.EventId;
        readonly offset: number;
        readonly limit: number;
      }) =>
        Effect.Do.pipe(
          Effect.bind('attendees', () => svc.rsvps.findRsvpAttendeesPage(event_id, offset, limit)),
          Effect.bind('total', () => svc.rsvps.countRsvpTotal(event_id)),
          Effect.map(
            ({ attendees, total }) =>
              new EventRpcModels.RsvpAttendeesResult({
                attendees: Array.map(
                  attendees,
                  (row) =>
                    new EventRpcModels.RsvpAttendeeEntry({
                      discord_id: row.discord_id,
                      name: row.member_name,
                      nickname: row.nickname,
                      username: row.username,
                      display_name: row.display_name,
                      response: row.response,
                      message: row.message,
                    }),
                ),
                total,
              }),
          ),
        ),

      'Event/GetRsvpReminderSummary': ({ event_id }: { readonly event_id: Event.EventId }) =>
        Effect.Do.pipe(
          Effect.bind('event', () =>
            svc.events.findEventByIdWithDetails(event_id).pipe(Effect.map(Option.getOrUndefined)),
          ),
          Effect.bind('counts', () => svc.rsvps.countRsvpsByEventId(event_id)),
          Effect.bind('nonResponders', ({ event }) =>
            event
              ? svc.rsvps.findNonRespondersByEventId(event_id, event.team_id, event.member_group_id)
              : Effect.succeed([]),
          ),
          Effect.bind('yesAttendees', ({ event }) =>
            svc.rsvps.findYesAttendeesForEmbed(
              event_id,
              50,
              event ? event.member_group_id : Option.none(),
            ),
          ),
          Effect.map(({ counts, nonResponders, yesAttendees }) => {
            let yesCount = 0;
            let noCount = 0;
            let maybeCount = 0;
            for (const c of counts) {
              if (c.response === 'yes') yesCount = c.count;
              else if (c.response === 'no') noCount = c.count;
              else if (c.response === 'maybe') maybeCount = c.count;
            }
            return new EventRpcModels.RsvpReminderSummary({
              yesCount,
              noCount,
              maybeCount,
              nonResponders: Array.map(
                nonResponders,
                (nr) =>
                  new EventRpcModels.NonResponderRpcEntry({
                    discord_id: nr.discord_id,
                    name: nr.member_name,
                    nickname: nr.nickname,
                    username: nr.username,
                    display_name: nr.display_name,
                  }),
              ),
              yesAttendees: Array.map(
                yesAttendees,
                (a) =>
                  new EventRpcModels.NonResponderRpcEntry({
                    discord_id: a.discord_id,
                    name: a.member_name,
                    nickname: a.nickname,
                    username: a.username,
                    display_name: a.display_name,
                  }),
              ),
            });
          }),
        ),

      'Event/GetUpcomingGuildEvents': ({
        guild_id,
        offset,
        limit,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly offset: number;
        readonly limit: number;
      }) =>
        Effect.Do.pipe(
          Effect.bind('teamId', () =>
            SqlSchema.findOne({
              Request: Schema.String,
              Result: TeamLookupResult,
              execute: (guildId) => svc.sql`SELECT id FROM teams WHERE guild_id = ${guildId}`,
            })(guild_id).pipe(
              Effect.catchTag('NoSuchElementError', () =>
                Effect.fail(new EventRpcModels.GuildNotFound()),
              ),
              Effect.mapError(() => new EventRpcModels.GuildNotFound()),
              Effect.map((r) => r.id),
            ),
          ),
          Effect.bind('rows', () => svc.events.findUpcomingByGuildId(guild_id, offset, limit)),
          Effect.bind('total', () => svc.events.countUpcomingByGuildId(guild_id)),
          Effect.map(
            ({ teamId, rows, total }) =>
              new EventRpcModels.GuildEventListResult({
                events: Array.map(
                  rows,
                  (row) =>
                    new EventRpcModels.GuildEventListEntry({
                      event_id: row.event_id,
                      title: row.title,
                      start_at: row.start_at,
                      end_at: row.end_at,
                      location: row.location,
                      location_url: row.location_url,
                      event_type: row.event_type,
                      yes_count: row.yes_count,
                      no_count: row.no_count,
                      maybe_count: row.maybe_count,
                      all_day: row.all_day,
                    }),
                ),
                total,
                team_id: teamId,
              }),
          ),
        ),

      'Event/GetUpcomingEventsForUser': ({
        guild_id,
        discord_user_id,
        offset,
        limit,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly offset: number;
        readonly limit: number;
      }) =>
        Effect.Do.pipe(
          Effect.bind('teamId', () =>
            SqlSchema.findOne({
              Request: Schema.String,
              Result: TeamLookupResult,
              execute: (guildId) => svc.sql`SELECT id FROM teams WHERE guild_id = ${guildId}`,
            })(guild_id).pipe(
              Effect.catchTag('NoSuchElementError', () =>
                Effect.fail(new EventRpcModels.GuildNotFound()),
              ),
              Effect.tapError((err) => Effect.logWarning('Guild lookup failed', err)),
              Effect.mapError(() => new EventRpcModels.GuildNotFound()),
              Effect.map((r) => r.id),
            ),
          ),
          Effect.bind('member', ({ teamId }) =>
            SqlSchema.findOne({
              Request: Schema.Struct({ discord_user_id: Schema.String, team_id: Schema.String }),
              Result: Schema.Struct({
                id: TeamMember.TeamMemberId,
              }),
              execute: (input) => svc.sql`
                SELECT tm.id FROM team_members tm
                JOIN users u ON u.id = tm.user_id
                WHERE u.discord_id = ${input.discord_user_id} AND tm.team_id = ${input.team_id}
                  AND tm.active = true
              `,
            })({ discord_user_id, team_id: teamId }).pipe(
              Effect.catchTag('NoSuchElementError', () =>
                Effect.fail(new EventRpcModels.RsvpMemberNotFound()),
              ),
              Effect.tapError((err) => Effect.logWarning('Member lookup failed', err)),
              Effect.mapError(() => new EventRpcModels.RsvpMemberNotFound()),
            ),
          ),
          Effect.bind('rows', ({ teamId, member }) =>
            SqlSchema.findAll({
              Request: Schema.Struct({
                team_id: Schema.String,
                team_member_id: Schema.String,
                offset: Schema.Number,
                limit: Schema.Number,
              }),
              Result: Schema.Struct({
                event_id: Schema.String,
                team_id: Schema.String,
                title: Schema.String,
                description: Schema.OptionFromNullOr(Schema.String),
                image_url: Schema.OptionFromNullOr(Schema.String),
                start_at: Schemas.DateTimeFromDate,
                end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
                location: Schema.OptionFromNullOr(Schema.String),
                location_url: Schema.OptionFromNullOr(Schema.String),
                event_type: Schema.String,
                yes_count: Schema.Number,
                no_count: Schema.Number,
                maybe_count: Schema.Number,
                my_response: Schema.OptionFromNullOr(Schema.Literals(['yes', 'no', 'maybe'])),
                my_message: Schema.OptionFromNullOr(Schema.String),
                all_day: Schema.Boolean,
              }),
              execute: (input) => svc.sql`
                SELECT
                  e.id AS event_id,
                  e.team_id,
                  e.title,
                  e.description,
                  e.image_url,
                  e.start_at,
                  e.end_at,
                  e.location,
                  e.location_url,
                  e.event_type,
                  e.all_day,
                  COALESCE(SUM(CASE WHEN er.response = 'yes' THEN 1 ELSE 0 END), 0)::int AS yes_count,
                  COALESCE(SUM(CASE WHEN er.response = 'no' THEN 1 ELSE 0 END), 0)::int AS no_count,
                  COALESCE(SUM(CASE WHEN er.response = 'maybe' THEN 1 ELSE 0 END), 0)::int AS maybe_count,
                  my_rsvp.response AS my_response,
                  my_rsvp.message AS my_message
                FROM events e
                LEFT JOIN event_rsvps er ON er.event_id = e.id
                LEFT JOIN event_rsvps my_rsvp ON my_rsvp.event_id = e.id
                  AND my_rsvp.team_member_id = ${input.team_member_id}
                WHERE e.team_id = ${input.team_id}
                  AND e.status = 'active'
                  AND e.start_at >= now()
                  AND (
                    e.member_group_id IS NULL
                    OR EXISTS (
                      WITH RECURSIVE descendant_groups AS (
                        SELECT id FROM groups WHERE id = e.member_group_id AND team_id = ${input.team_id}
                        UNION ALL
                        SELECT g.id FROM groups g JOIN descendant_groups dg ON g.parent_id = dg.id WHERE g.team_id = ${input.team_id}
                      )
                      SELECT 1 FROM group_members gm
                      WHERE gm.group_id IN (SELECT id FROM descendant_groups)
                        AND gm.team_member_id = ${input.team_member_id}
                    )
                  )
                GROUP BY e.id, my_rsvp.response, my_rsvp.message
                ORDER BY e.start_at ASC
                LIMIT ${input.limit} OFFSET ${input.offset}
              `,
            })({
              team_id: teamId,
              team_member_id: member.id,
              offset,
              limit,
            }).pipe(
              Effect.catchTag(
                ['SqlError', 'SchemaError'],
                LogicError.withMessage(
                  (e) => `Failed querying upcoming events for user: ${e.message}`,
                ),
              ),
            ),
          ),
          Effect.bind('total', ({ teamId, member }) =>
            SqlSchema.findOne({
              Request: Schema.Struct({
                team_id: Schema.String,
                team_member_id: Schema.String,
              }),
              Result: Schema.Struct({ count: Schema.Number }),
              execute: (input) => svc.sql`
                SELECT COUNT(DISTINCT e.id)::int AS count
                FROM events e
                WHERE e.team_id = ${input.team_id}
                  AND e.status = 'active'
                  AND e.start_at >= now()
                  AND (
                    e.member_group_id IS NULL
                    OR EXISTS (
                      WITH RECURSIVE descendant_groups AS (
                        SELECT id FROM groups WHERE id = e.member_group_id AND team_id = ${input.team_id}
                        UNION ALL
                        SELECT g.id FROM groups g JOIN descendant_groups dg ON g.parent_id = dg.id WHERE g.team_id = ${input.team_id}
                      )
                      SELECT 1 FROM group_members gm
                      WHERE gm.group_id IN (SELECT id FROM descendant_groups)
                        AND gm.team_member_id = ${input.team_member_id}
                    )
                  )
              `,
            })({
              team_id: teamId,
              team_member_id: member.id,
            }).pipe(
              Effect.catchTag(
                ['SqlError', 'SchemaError'],
                LogicError.withMessage(
                  (e) => `Failed counting upcoming events for user: ${e.message}`,
                ),
              ),
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(() => 'Count query returned no row'),
              ),
              Effect.map((r) => r.count),
            ),
          ),
          Effect.map(
            ({ rows, total, teamId }) =>
              new EventRpcModels.UpcomingEventsForUserResult({
                events: Array.map(
                  rows,
                  (row) =>
                    new EventRpcModels.UpcomingEventForUserEntry({
                      event_id: row.event_id,
                      team_id: row.team_id,
                      title: row.title,
                      description: row.description,
                      image_url: row.image_url,
                      start_at: row.start_at,
                      end_at: row.end_at,
                      location: row.location,
                      location_url: row.location_url,
                      event_type: row.event_type,
                      yes_count: row.yes_count,
                      no_count: row.no_count,
                      maybe_count: row.maybe_count,
                      my_response: row.my_response,
                      my_message: row.my_message,
                      all_day: row.all_day,
                    }),
                ),
                total,
                team_id: teamId,
              }),
          ),
        ),

      'Event/GetTrainingTypesByGuild': ({ guild_id }: { readonly guild_id: Discord.Snowflake }) =>
        svc.teamsRepo.findByGuildId(guild_id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Array.empty<EventRpcModels.TrainingTypeChoice>()),
              onSome: (team) =>
                svc.trainingTypesRepo.findTrainingTypesByTeamId(team.id).pipe(
                  Effect.map(
                    Array.map(
                      (tt) =>
                        new EventRpcModels.TrainingTypeChoice({
                          id: tt.id,
                          name: tt.name,
                        }),
                    ),
                  ),
                ),
            }),
          ),
          Effect.catchDefect((defect) =>
            Effect.logError(defect).pipe(
              Effect.as(Array.empty<EventRpcModels.TrainingTypeChoice>()),
            ),
          ),
        ),

      'Event/GetYesAttendeesForEmbed': ({
        event_id,
        limit,
        member_group_id,
      }: {
        readonly event_id: Event.EventId;
        readonly limit: number;
        readonly member_group_id: Option.Option<GroupModel.GroupId>;
      }) =>
        svc.rsvps.findYesAttendeesForEmbed(event_id, limit, member_group_id).pipe(
          Effect.map(
            Array.map(
              (row) =>
                new EventRpcModels.RsvpAttendeeEntry({
                  discord_id: row.discord_id,
                  name: row.member_name,
                  nickname: row.nickname,
                  username: row.username,
                  display_name: row.display_name,
                  response: row.response,
                  message: row.message,
                }),
            ),
          ),
        ),

      'Event/CreateEvent': (input: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly event_type: Event.EventType;
        readonly title: string;
        readonly start_at: string;
        readonly end_at: Option.Option<string>;
        readonly location: Option.Option<string>;
        readonly location_url: Option.Option<string>;
        readonly description: Option.Option<string>;
        readonly training_type_id: Option.Option<TrainingType.TrainingTypeId>;
      }) =>
        createEvent(
          svc.sql,
          svc.events,
          svc.syncEvents,
          svc.members,
          svc.trainingTypesRepo,
          svc.mappingRepo,
          input,
        ),

      'Event/GetChannelDivider': ({
        discord_channel_id,
      }: {
        readonly discord_channel_id: Discord.Snowflake;
      }) => svc.channelDividers.findByChannelId(discord_channel_id),
      'Event/SaveChannelDivider': ({
        discord_channel_id,
        discord_message_id,
      }: {
        readonly discord_channel_id: Discord.Snowflake;
        readonly discord_message_id: Discord.Snowflake;
      }) => svc.channelDividers.upsert(discord_channel_id, discord_message_id),

      'Event/DeleteChannelDivider': ({
        discord_channel_id,
      }: {
        readonly discord_channel_id: Discord.Snowflake;
      }) => svc.channelDividers.deleteByChannelId(discord_channel_id),

      'Event/ClaimTraining': ({
        event_id,
        team_id,
        discord_user_id,
      }: {
        readonly event_id: Event.EventId;
        readonly team_id: Team.TeamId;
        readonly discord_user_id: Discord.Snowflake;
      }) =>
        Effect.Do.pipe(
          Effect.bind('member', () =>
            SqlSchema.findOne({
              Request: Schema.Struct({
                discord_user_id: Schema.String,
                team_id: Schema.String,
              }),
              Result: TeamMemberLookup,
              execute: (input) => svc.sql`
                SELECT tm.id,
                       u.name,
                       u.discord_nickname AS nickname,
                       u.discord_display_name AS display_name,
                       u.username
                FROM team_members tm
                JOIN users u ON u.id = tm.user_id
                WHERE u.discord_id = ${input.discord_user_id} AND tm.team_id = ${input.team_id}
              `,
            })({
              discord_user_id,
              team_id,
            }).pipe(
              Effect.catchTag('NoSuchElementError', () =>
                Effect.fail(new EventRpcModels.ClaimNotOwnerGroupMember()),
              ),
              Effect.mapError(() => new EventRpcModels.ClaimNotOwnerGroupMember()),
            ),
          ),
          Effect.bind('event', () =>
            svc.events.findEventByIdWithDetails(event_id).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new EventRpcModels.ClaimEventNotFound()),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          Effect.tap(({ event }) =>
            event.event_type !== 'training'
              ? Effect.fail(new EventRpcModels.ClaimNotTraining())
              : Effect.void,
          ),
          Effect.tap(({ event }) =>
            event.status !== 'active'
              ? Effect.fail(new EventRpcModels.ClaimEventInactive())
              : Effect.void,
          ),
          Effect.tap(({ event }) =>
            Option.isNone(event.owner_group_id)
              ? Effect.fail(new EventRpcModels.ClaimNotOwnerGroupMember())
              : Effect.void,
          ),
          Effect.tap(({ event, member }) =>
            Option.match(event.owner_group_id, {
              onNone: () => Effect.fail(new EventRpcModels.ClaimNotOwnerGroupMember()),
              onSome: (ownerGroupId) =>
                svc.groups
                  .getDescendantMemberIds(ownerGroupId)
                  .pipe(
                    Effect.flatMap((memberIds) =>
                      Array.contains(memberIds, member.id)
                        ? Effect.void
                        : Effect.fail(new EventRpcModels.ClaimNotOwnerGroupMember()),
                    ),
                  ),
            }),
          ),
          Effect.tap(({ event }) =>
            Option.isSome(event.claimed_by)
              ? Effect.fail(
                  new EventRpcModels.ClaimAlreadyClaimed({
                    claimer_display: event.claimer_name,
                  }),
                )
              : Effect.void,
          ),
          Effect.bind('claimResult', ({ member }) => svc.events.claimTraining(event_id, member.id)),
          Effect.bind(
            'claimInfo',
            ({
              claimResult,
            }): Effect.Effect<
              EventRpcModels.EventClaimInfo,
              | EventRpcModels.ClaimEventNotFound
              | EventRpcModels.ClaimAlreadyClaimed
              | EventRpcModels.ClaimEventInactive,
              never
            > =>
              Option.isNone(claimResult)
                ? svc.events.findEventByIdWithDetails(event_id).pipe(
                    Effect.flatMap(
                      (
                        reloaded,
                      ): Effect.Effect<
                        never,
                        | EventRpcModels.ClaimEventNotFound
                        | EventRpcModels.ClaimAlreadyClaimed
                        | EventRpcModels.ClaimEventInactive,
                        never
                      > => {
                        if (Option.isNone(reloaded)) {
                          return Effect.fail(new EventRpcModels.ClaimEventNotFound());
                        }
                        if (Option.isSome(reloaded.value.claimed_by)) {
                          return Effect.fail(
                            new EventRpcModels.ClaimAlreadyClaimed({
                              claimer_display: reloaded.value.claimer_name,
                            }),
                          );
                        }
                        return Effect.fail(new EventRpcModels.ClaimEventInactive());
                      },
                    ),
                  )
                : svc.events
                    .findClaimInfo(event_id)
                    .pipe(
                      Effect.flatMap(
                        Options.toEffect(() => new EventRpcModels.ClaimEventNotFound()),
                      ),
                    ),
          ),
          Effect.tap(({ event, claimInfo }) =>
            svc.syncEvents.emitTrainingClaimUpdate(
              team_id,
              event_id,
              event.title,
              event.start_at,
              event.end_at,
              event.location,
              event.description,
              claimInfo.claim_discord_channel_id,
              claimInfo.claim_discord_message_id,
              claimInfo.claimed_by_member_id,
              claimInfo.claimed_by_display_name,
              claimInfo.status,
            ),
          ),
          Effect.map(({ claimInfo }) => claimInfo),
        ),

      'Event/UnclaimTraining': ({
        event_id,
        team_id,
        discord_user_id,
      }: {
        readonly event_id: Event.EventId;
        readonly team_id: Team.TeamId;
        readonly discord_user_id: Discord.Snowflake;
      }) =>
        Effect.Do.pipe(
          Effect.bind('member', () =>
            SqlSchema.findOne({
              Request: Schema.Struct({
                discord_user_id: Schema.String,
                team_id: Schema.String,
              }),
              Result: TeamMemberLookup,
              execute: (input) => svc.sql`
                SELECT tm.id,
                       u.name,
                       u.discord_nickname AS nickname,
                       u.discord_display_name AS display_name,
                       u.username
                FROM team_members tm
                JOIN users u ON u.id = tm.user_id
                WHERE u.discord_id = ${input.discord_user_id} AND tm.team_id = ${input.team_id}
              `,
            })({
              discord_user_id,
              team_id,
            }).pipe(
              Effect.catchTag('NoSuchElementError', () =>
                Effect.fail(new EventRpcModels.ClaimNotClaimer()),
              ),
              Effect.mapError(() => new EventRpcModels.ClaimNotClaimer()),
            ),
          ),
          Effect.bind('event', () =>
            svc.events.findEventByIdWithDetails(event_id).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new EventRpcModels.ClaimEventNotFound()),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          Effect.tap(({ event }) =>
            event.status !== 'active'
              ? Effect.fail(new EventRpcModels.ClaimEventInactive())
              : Effect.void,
          ),
          Effect.bind('unclaimResult', ({ member }) =>
            svc.events.unclaimTraining(event_id, member.id),
          ),
          Effect.bind(
            'claimInfo',
            ({
              unclaimResult,
            }): Effect.Effect<
              EventRpcModels.EventClaimInfo,
              EventRpcModels.ClaimEventNotFound | EventRpcModels.ClaimNotClaimer,
              never
            > =>
              Option.isNone(unclaimResult)
                ? Effect.fail(new EventRpcModels.ClaimNotClaimer())
                : svc.events
                    .findClaimInfo(event_id)
                    .pipe(
                      Effect.flatMap(
                        Options.toEffect(() => new EventRpcModels.ClaimEventNotFound()),
                      ),
                    ),
          ),
          Effect.tap(({ event, claimInfo }) =>
            svc.syncEvents.emitTrainingClaimUpdate(
              team_id,
              event_id,
              event.title,
              event.start_at,
              event.end_at,
              event.location,
              event.description,
              claimInfo.claim_discord_channel_id,
              claimInfo.claim_discord_message_id,
              claimInfo.claimed_by_member_id,
              claimInfo.claimed_by_display_name,
              claimInfo.status,
            ),
          ),
          Effect.map(({ claimInfo }) => claimInfo),
        ),

      'Event/SaveClaimDiscordMessageId': ({
        event_id,
        channel_id,
        message_id,
      }: {
        readonly event_id: Event.EventId;
        readonly channel_id: Discord.Snowflake;
        readonly message_id: Discord.Snowflake;
      }) => svc.events.saveClaimDiscordMessage(event_id, channel_id, message_id),

      'Event/SaveClaimThreadId': ({
        event_id,
        thread_id,
      }: {
        readonly event_id: Event.EventId;
        readonly thread_id: Discord.Snowflake;
      }) => svc.events.saveClaimThread(event_id, thread_id),

      'Event/GetClaimInfo': ({ event_id }: { readonly event_id: Event.EventId }) =>
        svc.events.findClaimInfo(event_id),

      'Event/GetOwnerClaimThread': ({
        team_id,
        owner_group_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly owner_group_id: GroupModel.GroupId;
      }) => svc.mappingRepo.findClaimThread(team_id, owner_group_id),

      'Event/SaveOwnerClaimThread': ({
        team_id,
        owner_group_id,
        thread_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly owner_group_id: GroupModel.GroupId;
        readonly thread_id: Discord.Snowflake;
      }) => svc.mappingRepo.saveClaimThreadIfAbsent(team_id, owner_group_id, thread_id),

      'Event/ClearOwnerClaimThread': ({
        team_id,
        owner_group_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly owner_group_id: GroupModel.GroupId;
      }) => svc.mappingRepo.clearClaimThread(team_id, owner_group_id),

      // ---------------------------------------------------------------------------
      // Event roster handlers
      // ---------------------------------------------------------------------------

      'Event/LinkEventRoster': ({
        event_id,
        roster_id,
        auto_approve,
      }: {
        readonly event_id: Event.EventId;
        readonly team_id: Team.TeamId;
        readonly roster_id: RosterModel.RosterId;
        readonly auto_approve: boolean;
      }) =>
        svc.eventRosters
          .link({ eventId: event_id, rosterId: roster_id, autoApprove: auto_approve })
          .pipe(
            Effect.catchTag('EventRosterAlreadyLinked', () =>
              Effect.fail(new EventRpcModels.EventRosterAlreadyLinked()),
            ),
            Effect.map((row) => ({
              id: row.id,
              event_id: row.event_id,
              roster_id: row.roster_id,
              auto_approve: row.auto_approve,
              owners_thread_id: row.owners_thread_id,
              created_at: row.created_at,
              updated_at: row.updated_at,
            })),
          ),

      'Event/UnlinkEventRoster': ({ event_id }: { readonly event_id: Event.EventId }) =>
        svc.eventRosters.unlink(event_id),

      'Event/GetEventRoster': ({ event_id }: { readonly event_id: Event.EventId }) =>
        svc.eventRosters.findByEventId(event_id).pipe(
          Effect.map((opt) =>
            Option.map(opt, (link) => ({
              id: link.id,
              event_id: link.event_id,
              roster_id: link.roster_id,
              auto_approve: link.auto_approve,
              owners_thread_id: link.owners_thread_id,
              created_at: link.created_at,
              updated_at: link.updated_at,
            })),
          ),
        ),

      'Event/SetEventRosterAutoApprove': ({
        event_id,
        team_id,
        auto_approve,
      }: {
        readonly event_id: Event.EventId;
        readonly team_id: Team.TeamId;
        readonly auto_approve: boolean;
      }) =>
        svc.eventRosters.findByEventId(event_id).pipe(
          Effect.tap(() => svc.eventRosters.setAutoApprove(event_id, auto_approve)),
          Effect.flatMap((linkOpt) => {
            // Run backfill only when toggling ON AND currently OFF
            if (!auto_approve) {
              return Effect.succeed(
                new EventRpcModels.SetAutoApproveResult({ added: 0, cancelled: 0 }),
              );
            }
            if (!Option.isSome(linkOpt)) {
              return Effect.succeed(
                new EventRpcModels.SetAutoApproveResult({ added: 0, cancelled: 0 }),
              );
            }
            const link = linkOpt.value;
            if (link.auto_approve) {
              // Was already ON — no backfill needed
              return Effect.succeed(
                new EventRpcModels.SetAutoApproveResult({ added: 0, cancelled: 0 }),
              );
            }
            return svc.rsvps.findRsvpsByEventId(event_id).pipe(
              Effect.flatMap((allRsvps) => {
                const yesResponders = allRsvps
                  .filter((r) => r.response === 'yes')
                  .map((r) => ({
                    team_member_id: r.team_member_id,
                    discord_user_id: Option.none<Discord.Snowflake>(),
                    display_name: r.display_name,
                  }));
                return svc.provisioning
                  .backfill({
                    eventId: event_id,
                    teamId: team_id,
                    rosterId: link.roster_id,
                    yesResponders,
                  })
                  .pipe(
                    Effect.map(
                      (result) =>
                        new EventRpcModels.SetAutoApproveResult({
                          added: result.added,
                          cancelled: result.cancelled,
                        }),
                    ),
                  );
              }),
            );
          }),
        ),

      'Event/SaveEventRosterThreadIfAbsent': ({
        event_id,
        thread_id,
      }: {
        readonly event_id: Event.EventId;
        readonly thread_id: Discord.Snowflake;
      }) => svc.eventRosters.saveThreadIfAbsent(event_id, thread_id),

      'Event/ClearEventRosterThread': ({ event_id }: { readonly event_id: Event.EventId }) =>
        svc.eventRosters.clearThread(event_id),

      'Event/SaveApprovalRequestMessageId': ({
        event_id,
        team_member_id,
        message_id,
      }: {
        readonly event_id: Event.EventId;
        readonly team_member_id: TeamMember.TeamMemberId;
        readonly message_id: Discord.Snowflake;
      }) => svc.rosterRequests.saveMessageId(event_id, team_member_id, message_id),

      'Event/ApproveRosterRequest': ({
        event_id,
        team_member_id,
        decided_by_discord_id,
      }: {
        readonly event_id: Event.EventId;
        readonly team_member_id: TeamMember.TeamMemberId;
        readonly decided_by_discord_id: Discord.Snowflake;
      }) =>
        Effect.Do.pipe(
          // Resolve the event to get team_id and owner_group_id
          Effect.bind('event', () =>
            svc.events.findEventByIdWithDetails(event_id).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new EventRpcModels.EventRosterEventNotFound()),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          // Resolve the decider's team member record from their discord id
          Effect.bind('decider', ({ event }) =>
            SqlSchema.findOne({
              Request: Schema.Struct({
                discord_user_id: Schema.String,
                team_id: Schema.String,
              }),
              Result: TeamMemberLookup,
              execute: (input) => svc.sql`
                SELECT tm.id,
                       u.name,
                       u.discord_nickname AS nickname,
                       u.discord_display_name AS display_name,
                       u.username
                FROM team_members tm
                JOIN users u ON u.id = tm.user_id
                WHERE u.discord_id = ${input.discord_user_id} AND tm.team_id = ${input.team_id}
              `,
            })({ discord_user_id: decided_by_discord_id, team_id: event.team_id }).pipe(
              Effect.catchTag('NoSuchElementError', () =>
                Effect.fail(new EventRpcModels.NotOwnerGroupMember()),
              ),
              Effect.mapError(() => new EventRpcModels.NotOwnerGroupMember()),
            ),
          ),
          // Verify the decider is a member of the event's owner group
          Effect.tap(({ event, decider }) =>
            Option.match(event.owner_group_id, {
              onNone: () => Effect.fail(new EventRpcModels.NotOwnerGroupMember()),
              onSome: (ownerGroupId) =>
                svc.groups
                  .getDescendantMemberIds(ownerGroupId)
                  .pipe(
                    Effect.flatMap((memberIds) =>
                      Array.contains(memberIds, decider.id)
                        ? Effect.void
                        : Effect.fail(new EventRpcModels.NotOwnerGroupMember()),
                    ),
                  ),
            }),
          ),
          Effect.flatMap(({ event, decider }) =>
            svc.provisioning
              .approve({
                eventId: event_id,
                teamId: event.team_id,
                memberId: team_member_id,
                deciderMemberId: decider.id,
              })
              .pipe(
                Effect.catchTag('EventRosterNotFound', () =>
                  Effect.fail(new EventRpcModels.EventRosterEventNotFound()),
                ),
              ),
          ),
        ),

      'Event/DeclineRosterRequest': ({
        event_id,
        team_member_id,
        decided_by_discord_id,
      }: {
        readonly event_id: Event.EventId;
        readonly team_member_id: TeamMember.TeamMemberId;
        readonly decided_by_discord_id: Discord.Snowflake;
      }) =>
        Effect.Do.pipe(
          // Resolve the event to get team_id and owner_group_id
          Effect.bind('event', () =>
            svc.events.findEventByIdWithDetails(event_id).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new EventRpcModels.EventRosterEventNotFound()),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          // Resolve the decider's team member record from their discord id
          Effect.bind('decider', ({ event }) =>
            SqlSchema.findOne({
              Request: Schema.Struct({
                discord_user_id: Schema.String,
                team_id: Schema.String,
              }),
              Result: TeamMemberLookup,
              execute: (input) => svc.sql`
                SELECT tm.id,
                       u.name,
                       u.discord_nickname AS nickname,
                       u.discord_display_name AS display_name,
                       u.username
                FROM team_members tm
                JOIN users u ON u.id = tm.user_id
                WHERE u.discord_id = ${input.discord_user_id} AND tm.team_id = ${input.team_id}
              `,
            })({ discord_user_id: decided_by_discord_id, team_id: event.team_id }).pipe(
              Effect.catchTag('NoSuchElementError', () =>
                Effect.fail(new EventRpcModels.NotOwnerGroupMember()),
              ),
              Effect.mapError(() => new EventRpcModels.NotOwnerGroupMember()),
            ),
          ),
          // Verify the decider is a member of the event's owner group
          Effect.tap(({ event, decider }) =>
            Option.match(event.owner_group_id, {
              onNone: () => Effect.fail(new EventRpcModels.NotOwnerGroupMember()),
              onSome: (ownerGroupId) =>
                svc.groups
                  .getDescendantMemberIds(ownerGroupId)
                  .pipe(
                    Effect.flatMap((memberIds) =>
                      Array.contains(memberIds, decider.id)
                        ? Effect.void
                        : Effect.fail(new EventRpcModels.NotOwnerGroupMember()),
                    ),
                  ),
            }),
          ),
          Effect.flatMap(({ event, decider }) =>
            svc.provisioning
              .decline({
                eventId: event_id,
                teamId: event.team_id,
                memberId: team_member_id,
                deciderMemberId: decider.id,
              })
              .pipe(
                Effect.catchTag('EventRosterNotFound', () =>
                  Effect.fail(new EventRpcModels.EventRosterEventNotFound()),
                ),
              ),
          ),
        ),
    })),
  ),
);
