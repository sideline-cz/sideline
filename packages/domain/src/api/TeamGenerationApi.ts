import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { Snowflake } from '~/models/Discord.js';
import { EventId } from '~/models/Event.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';
import { Gender } from '~/models/User.js';

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()(
  'TeamGenerationForbidden',
  {},
) {}

export class InsufficientPlayers extends Schema.TaggedErrorClass<InsufficientPlayers>()(
  'TeamGenerationInsufficientPlayers',
  {},
) {}

export class EventNotGeneratable extends Schema.TaggedErrorClass<EventNotGeneratable>()(
  'TeamGenerationEventNotGeneratable',
  {},
) {}

export class DiscordPostFailed extends Schema.TaggedErrorClass<DiscordPostFailed>()(
  'TeamGenerationDiscordPostFailed',
  {},
) {}

export class TeamGenerationRosterChanged extends Schema.TaggedErrorClass<TeamGenerationRosterChanged>()(
  'TeamGenerationRosterChanged',
  {},
) {}

export class TeamGenerationPostPending extends Schema.TaggedErrorClass<TeamGenerationPostPending>()(
  'TeamGenerationPostPending',
  {},
) {}

export class UnsupportedTeamCount extends Schema.TaggedErrorClass<UnsupportedTeamCount>()(
  'TeamGenerationUnsupportedTeamCount',
  {},
) {}

// ---------------------------------------------------------------------------
// Warning schema (mirrors the pure-TS union in TeamGenerator.ts)
// ---------------------------------------------------------------------------

export const GenerationWarning = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal('UnevenTeamSizes') }),
  Schema.Struct({ _tag: Schema.Literal('InsufficientGenderMix') }),
  Schema.Struct({ _tag: Schema.Literal('EloOutlier'), teamMemberId: TeamMemberId }),
]);
export type GenerationWarning = Schema.Schema.Type<typeof GenerationWarning>;

// ---------------------------------------------------------------------------
// Enriched player entry returned per generated team
// ---------------------------------------------------------------------------

export class GeneratedTeamMember extends Schema.Class<GeneratedTeamMember>('GeneratedTeamMember')({
  teamMemberId: TeamMemberId,
  displayName: Schema.String,
  discordId: Schema.OptionFromNullOr(Snowflake),
  avatar: Schema.OptionFromNullOr(Schema.String),
  rating: Schema.Int,
  isCalibrating: Schema.Boolean,
  role: Schema.OptionFromNullOr(Schema.String),
  jerseyNumber: Schema.OptionFromNullOr(Schema.Int),
  gender: Schema.OptionFromNullOr(Gender),
}) {}

// ---------------------------------------------------------------------------
// Generated team response
// ---------------------------------------------------------------------------

export class GeneratedTeamResponse extends Schema.Class<GeneratedTeamResponse>(
  'GeneratedTeamResponse',
)({
  index: Schema.Int,
  members: Schema.Array(GeneratedTeamMember),
  averageRating: Schema.Number,
  genderCounts: Schema.Struct({
    male: Schema.Int,
    female: Schema.Int,
    other: Schema.Int,
    unknown: Schema.Int,
  }),
}) {}

export class GenerateTeamsResponse extends Schema.Class<GenerateTeamsResponse>(
  'GenerateTeamsResponse',
)({
  teams: Schema.Array(GeneratedTeamResponse),
  maxRatingSpread: Schema.Number,
  iterationsUsed: Schema.Int,
  warnings: Schema.Array(GenerationWarning),
}) {}

// ---------------------------------------------------------------------------
// Generation config response
// ---------------------------------------------------------------------------

export class GenerationConfigResponse extends Schema.Class<GenerationConfigResponse>(
  'GenerationConfigResponse',
)({
  teamId: TeamId,
  weightElo: Schema.Int,
  weightSize: Schema.Int,
  weightGender: Schema.Int,
  defaultTeamCount: Schema.Int,
  maxIterations: Schema.Int,
  canManage: Schema.Boolean,
}) {}

// ---------------------------------------------------------------------------
// Post-teams-to-discord payload
// Only membership is trusted from the client; display names/ratings are
// re-loaded server-side from the DB to prevent embed injection / rating spoofing.
// ---------------------------------------------------------------------------

export const PostTeamPayload = Schema.Struct({
  memberIds: Schema.Array(TeamMemberId),
});
export type PostTeamPayload = Schema.Schema.Type<typeof PostTeamPayload>;

export const PostTeamsToDiscordRequest = Schema.Struct({
  teams: Schema.Array(PostTeamPayload),
});
export type PostTeamsToDiscordRequest = Schema.Schema.Type<typeof PostTeamsToDiscordRequest>;

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

export const GenerateTeamsRequest = Schema.Struct({
  teamCount: Schema.OptionFromOptional(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 2, maximum: 20 }))),
  ),
});
export type GenerateTeamsRequest = Schema.Schema.Type<typeof GenerateTeamsRequest>;

export const UpdateGenerationConfigRequest = Schema.Struct({
  weightElo: Schema.OptionFromOptional(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))),
  ),
  weightSize: Schema.OptionFromOptional(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))),
  ),
  weightGender: Schema.OptionFromOptional(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))),
  ),
  defaultTeamCount: Schema.OptionFromOptional(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 2, maximum: 20 }))),
  ),
  maxIterations: Schema.OptionFromOptional(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10000 }))),
  ),
});
export type UpdateGenerationConfigRequest = Schema.Schema.Type<
  typeof UpdateGenerationConfigRequest
>;

// ---------------------------------------------------------------------------
// HttpApiGroup
// ---------------------------------------------------------------------------

export class TeamGenerationApiGroup extends HttpApiGroup.make('teamGeneration')
  .add(
    HttpApiEndpoint.post('generateTeams', '/teams/:teamId/events/:eventId/generate-teams', {
      success: GenerateTeamsResponse,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventNotGeneratable.pipe(HttpApiSchema.status(409)),
        UnsupportedTeamCount.pipe(HttpApiSchema.status(422)),
        InsufficientPlayers.pipe(HttpApiSchema.status(422)),
      ],
      payload: GenerateTeamsRequest,
      params: { teamId: TeamId, eventId: EventId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getGenerationConfig', '/teams/:teamId/generation-config', {
      success: GenerationConfigResponse,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateGenerationConfig', '/teams/:teamId/generation-config', {
      success: GenerationConfigResponse,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      payload: UpdateGenerationConfigRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post(
      'postTeamsToDiscord',
      '/teams/:teamId/events/:eventId/post-teams-to-discord',
      {
        success: Schema.Void.pipe(HttpApiSchema.status(204)),
        error: [
          Forbidden.pipe(HttpApiSchema.status(403)),
          EventNotGeneratable.pipe(HttpApiSchema.status(409)),
          TeamGenerationRosterChanged.pipe(HttpApiSchema.status(409)),
          TeamGenerationPostPending.pipe(HttpApiSchema.status(409)),
          DiscordPostFailed.pipe(HttpApiSchema.status(502)),
        ],
        payload: PostTeamsToDiscordRequest,
        params: { teamId: TeamId, eventId: EventId },
      },
    ).middleware(AuthMiddleware),
  ) {}
