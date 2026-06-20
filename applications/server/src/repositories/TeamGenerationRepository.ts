import { Discord, Elo, Event, Team, TeamMember, User } from '@sideline/domain';
import { Effect, Layer, type Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

class TeamGenerationConfigRow extends Schema.Class<TeamGenerationConfigRow>(
  'TeamGenerationConfigRow',
)({
  team_id: Team.TeamId,
  weight_elo: Schema.Int,
  weight_size: Schema.Int,
  weight_gender: Schema.Int,
  default_team_count: Schema.Int,
  max_iterations: Schema.Int,
}) {}

export class RsvpYesMemberRow extends Schema.Class<RsvpYesMemberRow>('RsvpYesMemberRow')({
  team_member_id: TeamMember.TeamMemberId,
  display_name: Schema.OptionFromNullOr(Schema.String),
  discord_id: Schema.OptionFromNullOr(Discord.Snowflake),
  avatar: Schema.OptionFromNullOr(Schema.String),
  rating: Schema.Int,
  games_played: Schema.Int,
  role_name: Schema.OptionFromNullOr(Schema.String),
  jersey_number: Schema.OptionFromNullOr(Schema.Int),
  gender: Schema.OptionFromNullOr(User.Gender),
}) {}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // ---- Config queries ----

  const findConfigByTeamIdQuery = SqlSchema.findOneOption({
    Request: Team.TeamId,
    Result: TeamGenerationConfigRow,
    execute: (teamId) => sql`
      SELECT team_id, weight_elo, weight_size, weight_gender, default_team_count, max_iterations
      FROM team_generation_config
      WHERE team_id = ${teamId}
    `,
  });

  const upsertConfigQuery = SqlSchema.findOne({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      weight_elo: Schema.Int,
      weight_size: Schema.Int,
      weight_gender: Schema.Int,
      default_team_count: Schema.Int,
      max_iterations: Schema.Int,
    }),
    Result: TeamGenerationConfigRow,
    execute: (input) => sql`
      INSERT INTO team_generation_config
        (team_id, weight_elo, weight_size, weight_gender, default_team_count, max_iterations)
      VALUES
        (${input.team_id}, ${input.weight_elo}, ${input.weight_size}, ${input.weight_gender},
         ${input.default_team_count}, ${input.max_iterations})
      ON CONFLICT (team_id) DO UPDATE SET
        weight_elo = EXCLUDED.weight_elo,
        weight_size = EXCLUDED.weight_size,
        weight_gender = EXCLUDED.weight_gender,
        default_team_count = EXCLUDED.default_team_count,
        max_iterations = EXCLUDED.max_iterations,
        updated_at = now()
      RETURNING team_id, weight_elo, weight_size, weight_gender, default_team_count, max_iterations
    `,
  });

  // ---- RSVP-yes members with ratings and enriched data ----

  const findYesMembersForEventQuery = SqlSchema.findAll({
    Request: Schema.Struct({ event_id: Event.EventId }),
    Result: RsvpYesMemberRow,
    execute: (input) => sql`
      SELECT
        tm.id AS team_member_id,
        COALESCE(u.discord_display_name, u.discord_nickname, u.name, u.username) AS display_name,
        u.discord_id,
        u.avatar,
        COALESCE(pr.rating, ${Elo.DEFAULT_RATING}) AS rating,
        COALESCE(pr.games_played, 0) AS games_played,
        (
          SELECT r.name
          FROM member_roles mr
          JOIN roles r ON r.id = mr.role_id
          WHERE mr.team_member_id = tm.id
          LIMIT 1
        ) AS role_name,
        tm.jersey_number,
        u.gender
      FROM event_rsvps er
      JOIN team_members tm ON tm.id = er.team_member_id
      LEFT JOIN users u ON u.id = tm.user_id
      LEFT JOIN player_ratings pr ON pr.team_member_id = tm.id
      WHERE er.event_id = ${input.event_id}
        AND er.response = 'yes'
      ORDER BY COALESCE(pr.rating, ${Elo.DEFAULT_RATING}) DESC, tm.id ASC
    `,
  });

  // ---- Public methods ----

  const findConfigByTeamId = (
    teamId: Team.TeamId,
  ): Effect.Effect<Option.Option<TeamGenerationConfigRow>> =>
    findConfigByTeamIdQuery(teamId).pipe(catchSqlErrors);

  const upsertConfig = (params: {
    readonly teamId: Team.TeamId;
    readonly weightElo: number;
    readonly weightSize: number;
    readonly weightGender: number;
    readonly defaultTeamCount: number;
    readonly maxIterations: number;
  }) =>
    upsertConfigQuery({
      team_id: params.teamId,
      weight_elo: params.weightElo,
      weight_size: params.weightSize,
      weight_gender: params.weightGender,
      default_team_count: params.defaultTeamCount,
      max_iterations: params.maxIterations,
    }).pipe(catchSqlErrors);

  const findYesMembersForEvent = (
    eventId: Event.EventId,
  ): Effect.Effect<ReadonlyArray<RsvpYesMemberRow>> =>
    findYesMembersForEventQuery({ event_id: eventId }).pipe(catchSqlErrors);

  return {
    findConfigByTeamId,
    upsertConfig,
    findYesMembersForEvent,
  };
});

export class TeamGenerationRepository extends ServiceMap.Service<
  TeamGenerationRepository,
  Effect.Success<typeof make>
>()('api/TeamGenerationRepository') {
  static readonly Default = Layer.effect(TeamGenerationRepository, make);
}

// Re-export config row for consumers
export type { TeamGenerationConfigRow };
