import { EventType, Team } from '@sideline/domain';
import { LogicError, SqlErrors } from '@sideline/effect-lib';
import { Effect, Layer, type Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

export class EventTypeNameAlreadyTakenError extends Schema.TaggedErrorClass<EventTypeNameAlreadyTakenError>()(
  'EventTypeNameAlreadyTakenError',
  {},
) {}

class EventTypeRow extends Schema.Class<EventTypeRow>('EventTypeRow')({
  id: EventType.EventTypeId,
  team_id: Team.TeamId,
  name: Schema.OptionFromNullOr(Schema.String),
  kind: EventType.EventTypeKind,
  color: EventType.EventTypeColor,
  position: Schema.Number,
}) {}

class EventTypeWithUsageRow extends Schema.Class<EventTypeWithUsageRow>('EventTypeWithUsageRow')({
  id: EventType.EventTypeId,
  team_id: Team.TeamId,
  name: Schema.OptionFromNullOr(Schema.String),
  kind: EventType.EventTypeKind,
  color: EventType.EventTypeColor,
  position: Schema.Number,
  usageCount: Schema.Int,
}) {}

const ScopedRequest = Schema.Struct({
  id: EventType.EventTypeId,
  team_id: Team.TeamId,
});

const InsertInput = Schema.Struct({
  team_id: Team.TeamId,
  name: Schema.String,
  kind: EventType.EventTypeKind,
  color: EventType.EventTypeColor,
});

const UpdateInput = Schema.Struct({
  id: EventType.EventTypeId,
  team_id: Team.TeamId,
  name: Schema.OptionFromNullOr(Schema.String),
  color: EventType.EventTypeColor,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Active types only, ordered by their presentation `position` — never used to
  // resolve a kind to an id (see AGENTS.md ownership statement).
  const findByTeamIdQuery = SqlSchema.findAll({
    Request: Team.TeamId,
    Result: EventTypeWithUsageRow,
    execute: (teamId) => sql`
      SELECT t.id, t.team_id, t.name, t.kind, t.color, t.position,
             COALESCE(c.cnt, 0)::int AS "usageCount"
      FROM event_types t
      LEFT JOIN (
        SELECT event_type_id, COUNT(*)::int AS cnt
        FROM events
        WHERE team_id = ${teamId} AND event_type_id IS NOT NULL
        GROUP BY event_type_id
      ) c ON c.event_type_id = t.id
      WHERE t.team_id = ${teamId} AND t.archived_at IS NULL
      ORDER BY t.position ASC, t.created_at ASC
    `,
  });

  const findByIdScopedQuery = SqlSchema.findOneOption({
    Request: ScopedRequest,
    Result: EventTypeRow,
    execute: (input) => sql`
      SELECT id, team_id, name, kind, color, position
      FROM event_types
      WHERE id = ${input.id} AND team_id = ${input.team_id} AND archived_at IS NULL
    `,
  });

  const countActiveQuery = SqlSchema.findOne({
    Request: Team.TeamId,
    Result: Schema.Struct({ count: Schema.Int }),
    execute: (teamId) => sql`
      SELECT COUNT(*)::int AS count FROM event_types
      WHERE team_id = ${teamId} AND archived_at IS NULL
    `,
  });

  // `position` = current max + 1 among the team's active types — a transient collision from a
  // concurrent create is tolerated; ordering stays deterministic via the `created_at` tiebreak.
  const insertQuery = SqlSchema.findOne({
    Request: InsertInput,
    Result: EventTypeRow,
    execute: (input) => sql`
      INSERT INTO event_types (team_id, name, kind, color, position)
      SELECT ${input.team_id}, ${input.name}, ${input.kind}, ${input.color},
             COALESCE(MAX(position) + 1, 0)
      FROM event_types WHERE team_id = ${input.team_id} AND archived_at IS NULL
      RETURNING id, team_id, name, kind, color, position
    `,
  });

  const updateQuery = SqlSchema.findOne({
    Request: UpdateInput,
    Result: EventTypeRow,
    execute: (input) => sql`
      UPDATE event_types SET name = ${input.name}, color = ${input.color}, updated_at = now()
      WHERE id = ${input.id} AND team_id = ${input.team_id} AND archived_at IS NULL
      RETURNING id, team_id, name, kind, color, position
    `,
  });

  const archiveQuery = SqlSchema.void({
    Request: ScopedRequest,
    execute: (input) => sql`
      UPDATE event_types SET archived_at = now(), updated_at = now()
      WHERE id = ${input.id} AND team_id = ${input.team_id} AND archived_at IS NULL
    `,
  });

  // The authorization boundary for a client-supplied id array — every row touched must belong
  // to `team_id`, so a foreign id in the list simply fails to match any row.
  const reorderQuery = SqlSchema.void({
    Request: Schema.Struct({ team_id: Team.TeamId, ids: Schema.Array(Schema.String) }),
    execute: (input) => sql`
      UPDATE event_types et SET position = u.ord - 1, updated_at = now()
      FROM unnest(${input.ids}::uuid[]) WITH ORDINALITY AS u(id, ord)
      WHERE et.id = u.id AND et.team_id = ${input.team_id} AND et.archived_at IS NULL
    `,
  });

  const findEventTypesByTeamId = (teamId: Team.TeamId) =>
    findByTeamIdQuery(teamId).pipe(catchSqlErrors);

  const findEventTypeByIdScoped = (id: EventType.EventTypeId, teamId: Team.TeamId) =>
    findByIdScopedQuery({ id, team_id: teamId }).pipe(catchSqlErrors);

  const countActiveByTeamId = (teamId: Team.TeamId) =>
    countActiveQuery(teamId).pipe(
      catchSqlErrors,
      // `COUNT(*)` with no `GROUP BY` always returns exactly one row — `NoSuchElementError`
      // here would mean the query itself is broken, not a legitimate empty result.
      Effect.catchTag(
        'NoSuchElementError',
        LogicError.withMessage(() => 'countActiveByTeamId returned no row'),
      ),
      Effect.map((r) => r.count),
    );

  const insertEventType = (
    teamId: Team.TeamId,
    name: string,
    kind: EventType.EventTypeKind,
    color: EventType.EventTypeColor,
  ) =>
    insertQuery({ team_id: teamId, name, kind, color }).pipe(
      SqlErrors.catchUniqueViolation(() => new EventTypeNameAlreadyTakenError()),
      catchSqlErrors,
    );

  const updateEventType = (
    id: EventType.EventTypeId,
    teamId: Team.TeamId,
    name: Option.Option<string>,
    color: EventType.EventTypeColor,
  ) =>
    updateQuery({ id, team_id: teamId, name, color }).pipe(
      SqlErrors.catchUniqueViolation(() => new EventTypeNameAlreadyTakenError()),
      catchSqlErrors,
    );

  const archiveEventType = (id: EventType.EventTypeId, teamId: Team.TeamId) =>
    archiveQuery({ id, team_id: teamId }).pipe(catchSqlErrors);

  const reorderEventTypes = (teamId: Team.TeamId, ids: ReadonlyArray<EventType.EventTypeId>) =>
    reorderQuery({ team_id: teamId, ids }).pipe(catchSqlErrors);

  return {
    findEventTypesByTeamId,
    findEventTypeByIdScoped,
    countActiveByTeamId,
    insertEventType,
    updateEventType,
    archiveEventType,
    reorderEventTypes,
  };
});

export class EventTypesRepository extends ServiceMap.Service<
  EventTypesRepository,
  Effect.Success<typeof make>
>()('api/EventTypesRepository') {
  static readonly Default = Layer.effect(EventTypesRepository, make);
}
