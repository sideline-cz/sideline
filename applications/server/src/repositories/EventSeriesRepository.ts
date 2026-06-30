import { EventSeries, GroupModel, Team, TeamMember, TrainingType } from '@sideline/domain';
import { Schemas } from '@sideline/effect-lib';
import { type DateTime, Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class EventSeriesRow extends Schema.Class<EventSeriesRow>('EventSeriesRow')({
  id: EventSeries.EventSeriesId,
  team_id: Team.TeamId,
  training_type_id: Schema.OptionFromNullOr(TrainingType.TrainingTypeId),
  title: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  start_time: Schema.String,
  end_time: Schema.OptionFromNullOr(Schema.String),
  location: Schema.OptionFromNullOr(Schema.String),
  location_url: Schema.OptionFromNullOr(Schema.String),
  frequency: EventSeries.RecurrenceFrequency,
  days_of_week: EventSeries.DaysOfWeek,
  start_date: Schemas.DateTimeFromDate,
  end_date: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  status: EventSeries.EventSeriesStatus,
  owner_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  member_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
}) {}

class EventSeriesWithDetails extends Schema.Class<EventSeriesWithDetails>('EventSeriesWithDetails')(
  {
    id: EventSeries.EventSeriesId,
    team_id: Team.TeamId,
    training_type_id: Schema.OptionFromNullOr(TrainingType.TrainingTypeId),
    title: Schema.String,
    description: Schema.OptionFromNullOr(Schema.String),
    start_time: Schema.String,
    end_time: Schema.OptionFromNullOr(Schema.String),
    location: Schema.OptionFromNullOr(Schema.String),
    location_url: Schema.OptionFromNullOr(Schema.String),
    frequency: EventSeries.RecurrenceFrequency,
    days_of_week: EventSeries.DaysOfWeek,
    start_date: Schemas.DateTimeFromDate,
    end_date: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
    status: EventSeries.EventSeriesStatus,
    training_type_name: Schema.OptionFromNullOr(Schema.String),
    last_generated_date: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
    owner_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
    owner_group_name: Schema.OptionFromNullOr(Schema.String),
    member_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
    member_group_name: Schema.OptionFromNullOr(Schema.String),
  },
) {}

class EventSeriesForGeneration extends Schema.Class<EventSeriesForGeneration>(
  'EventSeriesForGeneration',
)({
  id: EventSeries.EventSeriesId,
  team_id: Team.TeamId,
  training_type_id: Schema.OptionFromNullOr(TrainingType.TrainingTypeId),
  title: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  start_time: Schema.String,
  end_time: Schema.OptionFromNullOr(Schema.String),
  location: Schema.OptionFromNullOr(Schema.String),
  location_url: Schema.OptionFromNullOr(Schema.String),
  frequency: EventSeries.RecurrenceFrequency,
  days_of_week: EventSeries.DaysOfWeek,
  start_date: Schemas.DateTimeFromDate,
  end_date: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  last_generated_date: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  owner_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  member_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  created_by: TeamMember.TeamMemberId,
  event_horizon_days: Schema.Number,
}) {}

const EventSeriesInsertInput = Schema.Struct({
  team_id: Schema.String,
  training_type_id: Schema.OptionFromNullOr(Schema.String),
  title: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  start_time: Schema.String,
  end_time: Schema.OptionFromNullOr(Schema.String),
  location: Schema.OptionFromNullOr(Schema.String),
  location_url: Schema.OptionFromNullOr(Schema.String),
  frequency: Schema.String,
  days_of_week: Schema.Array(Schema.Number),
  start_date: Schemas.DateTimeFromDate,
  end_date: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  created_by: Schema.String,
  owner_group_id: Schema.OptionFromNullOr(Schema.String),
  member_group_id: Schema.OptionFromNullOr(Schema.String),
});

const EventSeriesUpdateInput = Schema.Struct({
  id: EventSeries.EventSeriesId,
  title: Schema.String,
  training_type_id: Schema.OptionFromNullOr(Schema.String),
  description: Schema.OptionFromNullOr(Schema.String),
  days_of_week: Schema.Array(Schema.Number),
  start_time: Schema.String,
  end_time: Schema.OptionFromNullOr(Schema.String),
  location: Schema.OptionFromNullOr(Schema.String),
  location_url: Schema.OptionFromNullOr(Schema.String),
  end_date: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  owner_group_id: Schema.OptionFromNullOr(Schema.String),
  member_group_id: Schema.OptionFromNullOr(Schema.String),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertSeries = SqlSchema.findOne({
    Request: EventSeriesInsertInput,
    Result: EventSeriesRow,
    execute: (input) => sql`
            INSERT INTO event_series (team_id, training_type_id, title, description,
                                      start_time, end_time, location, location_url, frequency,
                                      days_of_week, start_date, end_date, created_by,
                                      owner_group_id, member_group_id)
            VALUES (${input.team_id}, ${input.training_type_id}, ${input.title},
                    ${input.description}, ${input.start_time}, ${input.end_time},
                    ${input.location}, ${input.location_url}, ${input.frequency}, ${input.days_of_week},
                    ${input.start_date}, ${input.end_date}, ${input.created_by},
                    ${input.owner_group_id}, ${input.member_group_id})
            RETURNING id, team_id, training_type_id, title, description,
                      start_time, end_time, location, location_url, frequency,
                      days_of_week, start_date, end_date, status,
                      owner_group_id, member_group_id
          `,
  });

  const findByTeamId = SqlSchema.findAll({
    Request: Schema.String,
    Result: EventSeriesWithDetails,
    execute: (teamId) => sql`
            SELECT es.id, es.team_id, es.training_type_id, es.title, es.description,
                   es.start_time, es.end_time, es.location, es.location_url, es.frequency,
                   es.days_of_week, es.start_date, es.end_date, es.status,
                   tt.name AS training_type_name, es.last_generated_date,
                   es.owner_group_id, og.name AS owner_group_name,
                   es.member_group_id, mg.name AS member_group_name
            FROM event_series es
            LEFT JOIN training_types tt ON tt.id = es.training_type_id
            LEFT JOIN groups og ON og.id = es.owner_group_id
            LEFT JOIN groups mg ON mg.id = es.member_group_id
            WHERE es.team_id = ${teamId}
            ORDER BY es.start_date DESC
          `,
  });

  const findById = SqlSchema.findOneOption({
    Request: EventSeries.EventSeriesId,
    Result: EventSeriesWithDetails,
    execute: (id) => sql`
            SELECT es.id, es.team_id, es.training_type_id, es.title, es.description,
                   es.start_time, es.end_time, es.location, es.location_url, es.frequency,
                   es.days_of_week, es.start_date, es.end_date, es.status,
                   tt.name AS training_type_name, es.last_generated_date,
                   es.owner_group_id, og.name AS owner_group_name,
                   es.member_group_id, mg.name AS member_group_name
            FROM event_series es
            LEFT JOIN training_types tt ON tt.id = es.training_type_id
            LEFT JOIN groups og ON og.id = es.owner_group_id
            LEFT JOIN groups mg ON mg.id = es.member_group_id
            WHERE es.id = ${id}
          `,
  });

  const findActiveForGeneration = SqlSchema.findAll({
    Request: Schema.Void,
    Result: EventSeriesForGeneration,
    execute: () => sql`
            SELECT es.id, es.team_id, es.training_type_id, es.title, es.description,
                   es.start_time, es.end_time, es.location, es.location_url, es.frequency,
                   es.days_of_week, es.start_date, es.end_date,
                   es.last_generated_date,
                   es.owner_group_id, es.member_group_id,
                   es.created_by,
                   COALESCE(ts.event_horizon_days, 30) AS event_horizon_days
            FROM event_series es
            LEFT JOIN team_settings ts ON ts.team_id = es.team_id
            WHERE es.status = 'active'
              AND (es.end_date IS NULL OR es.end_date > CURRENT_DATE)
          `,
  });

  const setLastGeneratedDate = SqlSchema.void({
    Request: Schema.Struct({
      id: EventSeries.EventSeriesId,
      last_generated_date: Schemas.DateTimeFromDate,
    }),
    execute: (input) =>
      sql`UPDATE event_series SET last_generated_date = ${input.last_generated_date}::date, updated_at = now() WHERE id = ${input.id}`,
  });

  const updateSeries = SqlSchema.findOne({
    Request: EventSeriesUpdateInput,
    Result: EventSeriesRow,
    execute: (input) => sql`
            UPDATE event_series SET
              title = ${input.title},
              training_type_id = ${input.training_type_id},
              description = ${input.description},
              days_of_week = ${input.days_of_week},
              start_time = ${input.start_time},
              end_time = ${input.end_time},
              location = ${input.location},
              location_url = ${input.location_url},
              end_date = ${input.end_date},
              owner_group_id = ${input.owner_group_id},
              member_group_id = ${input.member_group_id},
              updated_at = now()
            WHERE id = ${input.id}
            RETURNING id, team_id, training_type_id, title, description,
                      start_time, end_time, location, location_url, frequency,
                      days_of_week, start_date, end_date, status,
                      owner_group_id, member_group_id
          `,
  });

  const cancelSeries = SqlSchema.void({
    Request: EventSeries.EventSeriesId,
    execute: (id) =>
      sql`UPDATE event_series SET status = 'cancelled', updated_at = now() WHERE id = ${id}`,
  });

  const insertEventSeries = ({
    teamId,
    trainingTypeId,
    title,
    description,
    startTime,
    endTime,
    location,
    locationUrl = Option.none(),
    frequency,
    daysOfWeek,
    startDate,
    endDate,
    createdBy,
    ownerGroupId = Option.none(),
    memberGroupId = Option.none(),
  }: {
    teamId: Team.TeamId;
    trainingTypeId: Option.Option<string>;
    title: string;
    description: Option.Option<string>;
    startTime: string;
    endTime: Option.Option<string>;
    location: Option.Option<string>;
    locationUrl?: Option.Option<string>;
    frequency: string;
    daysOfWeek: ReadonlyArray<number>;
    startDate: DateTime.Utc;
    endDate: Option.Option<DateTime.Utc>;
    createdBy: string;
    ownerGroupId?: Option.Option<string>;
    memberGroupId?: Option.Option<string>;
  }) =>
    insertSeries({
      team_id: teamId,
      training_type_id: trainingTypeId,
      title,
      description,
      start_time: startTime,
      end_time: endTime,
      location,
      location_url: locationUrl,
      frequency,
      days_of_week: Array.from(daysOfWeek),
      start_date: startDate,
      end_date: endDate,
      created_by: createdBy,
      owner_group_id: ownerGroupId,
      member_group_id: memberGroupId,
    }).pipe(catchSqlErrors);

  const findSeriesByTeamId = (teamId: Team.TeamId) => findByTeamId(teamId).pipe(catchSqlErrors);

  const findSeriesById = (seriesId: EventSeries.EventSeriesId) =>
    findById(seriesId).pipe(catchSqlErrors);

  const updateEventSeries = ({
    id,
    title,
    trainingTypeId,
    description,
    daysOfWeek,
    startTime,
    endTime,
    location,
    locationUrl = Option.none(),
    endDate,
    ownerGroupId = Option.none(),
    memberGroupId = Option.none(),
  }: {
    id: EventSeries.EventSeriesId;
    title: string;
    trainingTypeId: Option.Option<string>;
    description: Option.Option<string>;
    daysOfWeek: ReadonlyArray<number>;
    startTime: string;
    endTime: Option.Option<string>;
    location: Option.Option<string>;
    locationUrl?: Option.Option<string>;
    endDate: Option.Option<DateTime.Utc>;
    ownerGroupId?: Option.Option<string>;
    memberGroupId?: Option.Option<string>;
  }) =>
    updateSeries({
      id,
      title,
      training_type_id: trainingTypeId,
      description,
      days_of_week: Array.from(daysOfWeek),
      start_time: startTime,
      end_time: endTime,
      location,
      location_url: locationUrl,
      end_date: endDate,
      owner_group_id: ownerGroupId,
      member_group_id: memberGroupId,
    }).pipe(catchSqlErrors);

  const cancelEventSeries = (seriesId: EventSeries.EventSeriesId) =>
    cancelSeries(seriesId).pipe(catchSqlErrors);

  const getActiveForGeneration = () =>
    findActiveForGeneration(undefined as undefined).pipe(catchSqlErrors);

  const updateLastGeneratedDate = (seriesId: EventSeries.EventSeriesId, date: DateTime.Utc) =>
    setLastGeneratedDate({ id: seriesId, last_generated_date: date }).pipe(catchSqlErrors);

  return {
    insertEventSeries,
    findSeriesByTeamId,
    findSeriesById,
    updateEventSeries,
    cancelEventSeries,
    getActiveForGeneration,
    updateLastGeneratedDate,
  };
});

export class EventSeriesRepository extends ServiceMap.Service<
  EventSeriesRepository,
  Effect.Success<typeof make>
>()('api/EventSeriesRepository') {
  static readonly Default = Layer.effect(EventSeriesRepository, make);
}
