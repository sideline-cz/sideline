import { Discord, Event, EventRosterModel, GroupModel, RosterModel } from '@sideline/domain';
import { Data, type DateTime, Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class EventRosterAlreadyLinked extends Data.TaggedError('EventRosterAlreadyLinked')<{}> {}

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

class EventRosterRow extends Schema.Class<EventRosterRow>('EventRosterRow')({
  id: EventRosterModel.EventRosterId,
  event_id: Event.EventId,
  roster_id: RosterModel.RosterId,
  auto_approve: Schema.Boolean,
  owners_thread_id: Schema.OptionFromNullOr(Discord.Snowflake),
  created_at: Schema.DateTimeUtcFromDate,
  updated_at: Schema.DateTimeUtcFromDate,
}) {}

/**
 * Extended join result used by findByEventId — includes info from the roster
 * and the owner group channel mapping needed by the provisioning service.
 */
class EventRosterLinkRow extends Schema.Class<EventRosterLinkRow>('EventRosterLinkRow')({
  id: EventRosterModel.EventRosterId,
  event_id: Event.EventId,
  roster_id: RosterModel.RosterId,
  auto_approve: Schema.Boolean,
  owners_thread_id: Schema.OptionFromNullOr(Discord.Snowflake),
  created_at: Schema.DateTimeUtcFromDate,
  updated_at: Schema.DateTimeUtcFromDate,
  roster_name: Schema.String,
  owner_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  member_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  member_count: Schema.Number,
  // owner group's discord channel id — used by bot for approval messages
  owner_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

class ThreadRow extends Schema.Class<ThreadRow>('ThreadRow')({
  owners_thread_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // -- raw SqlSchema helpers --------------------------------------------------

  const _findByEventId = SqlSchema.findOneOption({
    Request: Event.EventId,
    Result: EventRosterLinkRow,
    execute: (eventId) => sql`
      SELECT er.id, er.event_id, er.roster_id, er.auto_approve, er.owners_thread_id,
             er.created_at, er.updated_at,
             r.name AS roster_name,
             e.owner_group_id,
             e.member_group_id,
             (SELECT COUNT(*) FROM roster_members rm WHERE rm.roster_id = r.id)::int AS member_count,
             (
               SELECT dcm2.discord_channel_id
               FROM discord_channel_mappings dcm2
               WHERE dcm2.group_id = e.owner_group_id AND dcm2.group_id IS NOT NULL
               LIMIT 1
             ) AS owner_channel_id
      FROM event_rosters er
      JOIN rosters r ON r.id = er.roster_id
      JOIN events e ON e.id = er.event_id
      WHERE er.event_id = ${eventId}
    `,
  });

  const _link = SqlSchema.findOneOption({
    Request: Schema.Struct({
      event_id: Event.EventId,
      roster_id: RosterModel.RosterId,
      auto_approve: Schema.Boolean,
    }),
    Result: EventRosterRow,
    execute: (input) => sql`
      INSERT INTO event_rosters (event_id, roster_id, auto_approve)
      VALUES (${input.event_id}, ${input.roster_id}, ${input.auto_approve})
      ON CONFLICT (event_id) DO NOTHING
      RETURNING id, event_id, roster_id, auto_approve, owners_thread_id, created_at, updated_at
    `,
  });

  const _unlink = SqlSchema.void({
    Request: Event.EventId,
    execute: (eventId) => sql`DELETE FROM event_rosters WHERE event_id = ${eventId}`,
  });

  const _setAutoApprove = SqlSchema.void({
    Request: Schema.Struct({ event_id: Event.EventId, auto_approve: Schema.Boolean }),
    execute: (input) => sql`
      UPDATE event_rosters SET auto_approve = ${input.auto_approve} WHERE event_id = ${input.event_id}
    `,
  });

  // Atomic "save thread if absent" — returns the winning thread id.
  // Mirror of DiscordChannelMappingRepository.saveClaimThreadIfAbsent.
  const _saveThread = SqlSchema.findOneOption({
    Request: Schema.Struct({ event_id: Event.EventId, thread_id: Discord.Snowflake }),
    Result: ThreadRow,
    execute: (input) => sql`
      UPDATE event_rosters
      SET owners_thread_id = ${input.thread_id}
      WHERE event_id = ${input.event_id} AND owners_thread_id IS NULL
      RETURNING owners_thread_id
    `,
  });

  const _readThread = SqlSchema.findOneOption({
    Request: Event.EventId,
    Result: ThreadRow,
    execute: (eventId) => sql`
      SELECT owners_thread_id FROM event_rosters WHERE event_id = ${eventId}
    `,
  });

  const _clearThread = SqlSchema.void({
    Request: Event.EventId,
    execute: (eventId) => sql`
      UPDATE event_rosters SET owners_thread_id = NULL WHERE event_id = ${eventId}
    `,
  });

  // -- public methods ---------------------------------------------------------

  const findByEventId = (eventId: Event.EventId) => _findByEventId(eventId).pipe(catchSqlErrors);

  const link = (input: {
    readonly eventId: Event.EventId;
    readonly rosterId: RosterModel.RosterId;
    readonly autoApprove: boolean;
  }) =>
    _link({
      event_id: input.eventId,
      roster_id: input.rosterId,
      auto_approve: input.autoApprove,
    }).pipe(
      catchSqlErrors,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new EventRosterAlreadyLinked()),
          onSome: Effect.succeed,
        }),
      ),
    );

  const unlink = (eventId: Event.EventId) => _unlink(eventId).pipe(catchSqlErrors);

  const setAutoApprove = (eventId: Event.EventId, autoApprove: boolean) =>
    _setAutoApprove({ event_id: eventId, auto_approve: autoApprove }).pipe(catchSqlErrors);

  /**
   * Atomically saves the thread id if not already set.
   * Returns the winning thread id (either the one just saved, or the already-stored one).
   */
  const saveThreadIfAbsent = (eventId: Event.EventId, threadId: Discord.Snowflake) =>
    _saveThread({ event_id: eventId, thread_id: threadId }).pipe(
      catchSqlErrors,
      Effect.flatMap((maybeRow) =>
        Option.isSome(maybeRow)
          ? // We won the race — return what we saved
            Effect.succeed(maybeRow.value.owners_thread_id)
          : // Lost the race — read the winner's thread
            _readThread(eventId).pipe(
              catchSqlErrors,
              Effect.map(Option.flatMap((r) => r.owners_thread_id)),
            ),
      ),
    );

  const clearThread = (eventId: Event.EventId) => _clearThread(eventId).pipe(catchSqlErrors);

  return {
    findByEventId,
    link,
    unlink,
    setAutoApprove,
    saveThreadIfAbsent,
    clearThread,
  };
});

export class EventRostersRepository extends ServiceMap.Service<
  EventRostersRepository,
  Effect.Success<typeof make>
>()('api/EventRostersRepository') {
  static readonly Default = Layer.effect(EventRostersRepository, make);
}

// Convenience re-export so callers can reference the row type
export type EventRosterLinkInfo = {
  readonly id: EventRosterModel.EventRosterId;
  readonly event_id: Event.EventId;
  readonly roster_id: RosterModel.RosterId;
  readonly auto_approve: boolean;
  readonly owners_thread_id: Option.Option<Discord.Snowflake>;
  readonly created_at: DateTime.Utc;
  readonly updated_at: DateTime.Utc;
  readonly roster_name: string;
  readonly owner_group_id: Option.Option<GroupModel.GroupId>;
  readonly member_group_id: Option.Option<GroupModel.GroupId>;
  readonly member_count: number;
  readonly owner_channel_id: Option.Option<Discord.Snowflake>;
};

// Type for the basic link row returned from link()
export type EventRosterBasicRow = {
  readonly id: EventRosterModel.EventRosterId;
  readonly event_id: Event.EventId;
  readonly roster_id: RosterModel.RosterId;
  readonly auto_approve: boolean;
  readonly owners_thread_id: Option.Option<Discord.Snowflake>;
  readonly created_at: DateTime.Utc;
  readonly updated_at: DateTime.Utc;
};
