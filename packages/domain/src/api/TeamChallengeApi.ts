import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { TeamId } from '~/models/Team.js';
import {
  TeamChallenge,
  TeamChallengeDescription,
  TeamChallengeId,
  TeamChallengeKind,
  TeamChallengeTitle,
  TeamChallengeView,
} from '~/models/TeamChallenge.js';
import { TeamMemberId } from '~/models/TeamMember.js';
import {
  TeamChallengeAlreadyExistsForWeek,
  TeamChallengeForbidden,
  TeamChallengeNotActive,
  TeamChallengeNotFound,
  TeamChallengeStartDateOutOfRange,
} from '~/rpc/teamChallenge/TeamChallengeRpcGroup.js';

export {
  TeamChallengeAlreadyExistsForWeek,
  TeamChallengeForbidden,
  TeamChallengeNotActive,
  TeamChallengeNotFound,
  TeamChallengeStartDateOutOfRange,
} from '~/rpc/teamChallenge/TeamChallengeRpcGroup.js';

export const CreateTeamChallengeRequest = Schema.Struct({
  startDate: Schema.Date,
  endDate: Schema.Date,
  kind: TeamChallengeKind,
  title: TeamChallengeTitle,
  description: Schema.OptionFromNullOr(TeamChallengeDescription),
});
export type CreateTeamChallengeRequest = Schema.Schema.Type<typeof CreateTeamChallengeRequest>;

export const UpdateTeamChallengeRequest = Schema.Struct({
  title: TeamChallengeTitle,
  description: Schema.OptionFromNullOr(TeamChallengeDescription),
});
export type UpdateTeamChallengeRequest = Schema.Schema.Type<typeof UpdateTeamChallengeRequest>;

export class TeamChallengeListResponse extends Schema.Class<TeamChallengeListResponse>(
  'TeamChallengeListResponse',
)({
  team: Schema.Struct({
    id: TeamId,
    timezone: Schema.String,
  }),
  canCreate: Schema.Boolean,
  currentMemberId: Schema.OptionFromNullOr(TeamMemberId),
  challenges: Schema.Array(TeamChallengeView),
}) {}

export class TeamChallengeApiGroup extends HttpApiGroup.make('teamChallenge')
  .add(
    HttpApiEndpoint.get('listChallenges', '/teams/:teamId/challenges', {
      success: TeamChallengeListResponse,
      error: TeamChallengeForbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
      query: {
        limit: Schema.OptionFromOptional(Schema.NumberFromString),
      },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createChallenge', '/teams/:teamId/challenges', {
      success: TeamChallenge.pipe(HttpApiSchema.status(201)),
      error: [
        TeamChallengeForbidden.pipe(HttpApiSchema.status(403)),
        TeamChallengeAlreadyExistsForWeek.pipe(HttpApiSchema.status(409)),
        TeamChallengeStartDateOutOfRange.pipe(HttpApiSchema.status(422)),
      ],
      payload: CreateTeamChallengeRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateChallenge', '/teams/:teamId/challenges/:challengeId', {
      success: TeamChallenge,
      error: [
        TeamChallengeForbidden.pipe(HttpApiSchema.status(403)),
        TeamChallengeNotFound.pipe(HttpApiSchema.status(404)),
      ],
      payload: UpdateTeamChallengeRequest,
      params: { teamId: TeamId, challengeId: TeamChallengeId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete('deleteChallenge', '/teams/:teamId/challenges/:challengeId', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        TeamChallengeForbidden.pipe(HttpApiSchema.status(403)),
        TeamChallengeNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, challengeId: TeamChallengeId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('markCompleted', '/teams/:teamId/challenges/:challengeId/complete', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        TeamChallengeForbidden.pipe(HttpApiSchema.status(403)),
        TeamChallengeNotFound.pipe(HttpApiSchema.status(404)),
        TeamChallengeNotActive.pipe(HttpApiSchema.status(409)),
      ],
      params: { teamId: TeamId, challengeId: TeamChallengeId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete('unmarkCompleted', '/teams/:teamId/challenges/:challengeId/complete', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        TeamChallengeForbidden.pipe(HttpApiSchema.status(403)),
        TeamChallengeNotFound.pipe(HttpApiSchema.status(404)),
        TeamChallengeNotActive.pipe(HttpApiSchema.status(409)),
      ],
      params: { teamId: TeamId, challengeId: TeamChallengeId },
    }).middleware(AuthMiddleware),
  ) {}
