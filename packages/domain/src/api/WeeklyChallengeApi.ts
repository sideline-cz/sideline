import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';
import {
  WeeklyChallenge,
  WeeklyChallengeDescription,
  WeeklyChallengeId,
  WeeklyChallengeKind,
  WeeklyChallengeTitle,
  WeeklyChallengeView,
} from '~/models/WeeklyChallenge.js';
import {
  WeeklyChallengeAlreadyExistsForWeek,
  WeeklyChallengeForbidden,
  WeeklyChallengeNotActive,
  WeeklyChallengeNotFound,
  WeeklyChallengeWeekOutOfRange,
} from '~/rpc/weeklyChallenge/WeeklyChallengeRpcGroup.js';

export {
  WeeklyChallengeAlreadyExistsForWeek,
  WeeklyChallengeForbidden,
  WeeklyChallengeNotActive,
  WeeklyChallengeNotFound,
  WeeklyChallengeWeekOutOfRange,
} from '~/rpc/weeklyChallenge/WeeklyChallengeRpcGroup.js';

export const CreateWeeklyChallengeRequest = Schema.Struct({
  weekStart: Schema.Date,
  kind: WeeklyChallengeKind,
  title: WeeklyChallengeTitle,
  description: Schema.OptionFromNullOr(WeeklyChallengeDescription),
});
export type CreateWeeklyChallengeRequest = Schema.Schema.Type<typeof CreateWeeklyChallengeRequest>;

export const UpdateWeeklyChallengeRequest = Schema.Struct({
  title: WeeklyChallengeTitle,
  description: Schema.OptionFromNullOr(WeeklyChallengeDescription),
});
export type UpdateWeeklyChallengeRequest = Schema.Schema.Type<typeof UpdateWeeklyChallengeRequest>;

export class WeeklyChallengeListResponse extends Schema.Class<WeeklyChallengeListResponse>(
  'WeeklyChallengeListResponse',
)({
  team: Schema.Struct({
    id: TeamId,
    timezone: Schema.String,
  }),
  canCreate: Schema.Boolean,
  currentMemberId: Schema.OptionFromNullOr(TeamMemberId),
  challenges: Schema.Array(WeeklyChallengeView),
}) {}

export class WeeklyChallengeApiGroup extends HttpApiGroup.make('weeklyChallenge')
  .add(
    HttpApiEndpoint.get('listChallenges', '/teams/:teamId/weekly-challenges', {
      success: WeeklyChallengeListResponse,
      error: WeeklyChallengeForbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
      query: {
        limit: Schema.OptionFromOptional(Schema.NumberFromString),
      },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createChallenge', '/teams/:teamId/weekly-challenges', {
      success: WeeklyChallenge.pipe(HttpApiSchema.status(201)),
      error: [
        WeeklyChallengeForbidden.pipe(HttpApiSchema.status(403)),
        WeeklyChallengeAlreadyExistsForWeek.pipe(HttpApiSchema.status(409)),
        WeeklyChallengeWeekOutOfRange.pipe(HttpApiSchema.status(422)),
      ],
      payload: CreateWeeklyChallengeRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateChallenge', '/teams/:teamId/weekly-challenges/:challengeId', {
      success: WeeklyChallenge,
      error: [
        WeeklyChallengeForbidden.pipe(HttpApiSchema.status(403)),
        WeeklyChallengeNotFound.pipe(HttpApiSchema.status(404)),
      ],
      payload: UpdateWeeklyChallengeRequest,
      params: { teamId: TeamId, challengeId: WeeklyChallengeId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete('deleteChallenge', '/teams/:teamId/weekly-challenges/:challengeId', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        WeeklyChallengeForbidden.pipe(HttpApiSchema.status(403)),
        WeeklyChallengeNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, challengeId: WeeklyChallengeId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post(
      'markCompleted',
      '/teams/:teamId/weekly-challenges/:challengeId/complete',
      {
        success: Schema.Void.pipe(HttpApiSchema.status(204)),
        error: [
          WeeklyChallengeForbidden.pipe(HttpApiSchema.status(403)),
          WeeklyChallengeNotFound.pipe(HttpApiSchema.status(404)),
          WeeklyChallengeNotActive.pipe(HttpApiSchema.status(409)),
        ],
        params: { teamId: TeamId, challengeId: WeeklyChallengeId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete(
      'unmarkCompleted',
      '/teams/:teamId/weekly-challenges/:challengeId/complete',
      {
        success: Schema.Void.pipe(HttpApiSchema.status(204)),
        error: [
          WeeklyChallengeForbidden.pipe(HttpApiSchema.status(403)),
          WeeklyChallengeNotFound.pipe(HttpApiSchema.status(404)),
          WeeklyChallengeNotActive.pipe(HttpApiSchema.status(409)),
        ],
        params: { teamId: TeamId, challengeId: WeeklyChallengeId },
      },
    ).middleware(AuthMiddleware),
  ) {}
