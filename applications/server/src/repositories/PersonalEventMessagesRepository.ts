import { Discord, Event, Team, TeamMember } from '@sideline/domain';
import { Schemas } from '@sideline/effect-lib';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class PersonalEventMessageRow extends Schema.Class<PersonalEventMessageRow>(
  'PersonalEventMessageRow',
)({
  id: Schema.String,
  event_id: Event.EventId,
  team_member_id: TeamMember.TeamMemberId,
  personal_channel_id: Discord.Snowflake,
  discord_message_id: Discord.Snowflake,
  payload_hash: Schema.String,
}) {}

class EventNeedingReconcileRow extends Schema.Class<EventNeedingReconcileRow>(
  'EventNeedingReconcileRow',
)({
  event_id: Event.EventId,
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  dirty_at: Schemas.DateTimeFromDate,
}) {}

class MemberMessageRow extends Schema.Class<MemberMessageRow>('MemberMessageRow')({
  event_id: Event.EventId,
  personal_channel_id: Discord.Snowflake,
  discord_message_id: Discord.Snowflake,
  start_at: Schemas.DateTimeFromDate,
}) {}

const make = Effect.Do.pipe(
  Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
  Effect.map(({ sql }) => {
    const _upsert = SqlSchema.void({
      Request: Schema.Struct({
        event_id: Schema.String,
        team_member_id: Schema.String,
        personal_channel_id: Discord.Snowflake,
        discord_message_id: Discord.Snowflake,
        payload_hash: Schema.String,
      }),
      execute: (input) => sql`
        INSERT INTO personal_event_messages
          (event_id, team_member_id, personal_channel_id, discord_message_id, payload_hash)
        VALUES
          (${input.event_id}, ${input.team_member_id}, ${input.personal_channel_id},
           ${input.discord_message_id}, ${input.payload_hash})
        ON CONFLICT (event_id, team_member_id) DO UPDATE SET
          personal_channel_id = EXCLUDED.personal_channel_id,
          discord_message_id = EXCLUDED.discord_message_id,
          payload_hash = EXCLUDED.payload_hash,
          updated_at = now()
      `,
    });

    const _get = SqlSchema.findOneOption({
      Request: Schema.Struct({
        event_id: Schema.String,
        team_member_id: Schema.String,
      }),
      Result: PersonalEventMessageRow,
      execute: (input) => sql`
        SELECT id, event_id, team_member_id, personal_channel_id, discord_message_id, payload_hash
        FROM personal_event_messages
        WHERE event_id = ${input.event_id} AND team_member_id = ${input.team_member_id}
      `,
    });

    const _delete = SqlSchema.void({
      Request: Schema.Struct({
        event_id: Schema.String,
        team_member_id: Schema.String,
      }),
      execute: (input) => sql`
        DELETE FROM personal_event_messages
        WHERE event_id = ${input.event_id} AND team_member_id = ${input.team_member_id}
      `,
    });

    const _getEventsNeedingReconcile = SqlSchema.findAll({
      Request: Schema.Struct({ limit: Schema.Number }),
      Result: EventNeedingReconcileRow,
      execute: (input) => sql`
        SELECT e.id AS event_id, e.team_id, t.guild_id, e.personal_messages_dirty_at AS dirty_at
        FROM events e
        JOIN teams t ON t.id = e.team_id
        WHERE e.personal_messages_dirty_at IS NOT NULL
          AND t.guild_id IS NOT NULL
        ORDER BY e.personal_messages_dirty_at ASC
        LIMIT ${input.limit}
      `,
    });

    const _listForMember = SqlSchema.findAll({
      Request: Schema.Struct({ team_member_id: Schema.String }),
      Result: MemberMessageRow,
      execute: (input) => sql`
        SELECT pem.event_id, pem.personal_channel_id, pem.discord_message_id, e.start_at
        FROM personal_event_messages pem
        JOIN events e ON e.id = pem.event_id
        WHERE pem.team_member_id = ${input.team_member_id}
          AND e.status = 'active'
          AND e.start_at >= now()
        ORDER BY e.start_at ASC
      `,
    });

    const upsertPersonalEventMessage = (
      eventId: Event.EventId,
      teamMemberId: TeamMember.TeamMemberId,
      personalChannelId: Discord.Snowflake,
      discordMessageId: Discord.Snowflake,
      payloadHash: string,
    ) =>
      _upsert({
        event_id: eventId,
        team_member_id: teamMemberId,
        personal_channel_id: personalChannelId,
        discord_message_id: discordMessageId,
        payload_hash: payloadHash,
      }).pipe(catchSqlErrors);

    const getPersonalEventMessage = (
      eventId: Event.EventId,
      teamMemberId: TeamMember.TeamMemberId,
    ) =>
      _get({ event_id: eventId, team_member_id: teamMemberId }).pipe(
        Effect.map(
          Option.map((row) => ({
            personal_channel_id: row.personal_channel_id,
            discord_message_id: row.discord_message_id,
            payload_hash: row.payload_hash,
          })),
        ),
        catchSqlErrors,
      );

    const deletePersonalEventMessage = (
      eventId: Event.EventId,
      teamMemberId: TeamMember.TeamMemberId,
    ) => _delete({ event_id: eventId, team_member_id: teamMemberId }).pipe(catchSqlErrors);

    const getEventsNeedingReconcile = (limit: number) =>
      _getEventsNeedingReconcile({ limit }).pipe(catchSqlErrors);

    const listMessagesForMember = (teamMemberId: TeamMember.TeamMemberId) =>
      _listForMember({ team_member_id: teamMemberId }).pipe(catchSqlErrors);

    return {
      upsertPersonalEventMessage,
      getPersonalEventMessage,
      deletePersonalEventMessage,
      getEventsNeedingReconcile,
      listMessagesForMember,
    };
  }),
);

export class PersonalEventMessagesRepository extends ServiceMap.Service<
  PersonalEventMessagesRepository,
  Effect.Success<typeof make>
>()('api/PersonalEventMessagesRepository') {
  static readonly Default = Layer.effect(PersonalEventMessagesRepository, make);
}
