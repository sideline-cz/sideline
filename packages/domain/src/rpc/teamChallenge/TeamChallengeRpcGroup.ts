import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import { TeamId } from '../../models/Team.js';
import {
  TeamChallenge,
  TeamChallengeDescription,
  TeamChallengeId,
  TeamChallengeKind,
  TeamChallengeTitle,
  TeamChallengeView,
} from '../../models/TeamChallenge.js';

export class TeamChallengeNotFound extends Schema.TaggedErrorClass<TeamChallengeNotFound>()(
  'TeamChallengeNotFound',
  {},
) {}

export class TeamChallengeNotActive extends Schema.TaggedErrorClass<TeamChallengeNotActive>()(
  'TeamChallengeNotActive',
  {},
) {}

export class TeamChallengeAlreadyExistsForWeek extends Schema.TaggedErrorClass<TeamChallengeAlreadyExistsForWeek>()(
  'TeamChallengeAlreadyExistsForWeek',
  {},
) {}

export class TeamChallengeStartDateOutOfRange extends Schema.TaggedErrorClass<TeamChallengeStartDateOutOfRange>()(
  'TeamChallengeStartDateOutOfRange',
  {},
) {}

export class TeamChallengeForbidden extends Schema.TaggedErrorClass<TeamChallengeForbidden>()(
  'TeamChallengeForbidden',
  {},
) {}

export const TeamChallengeRpcGroup = RpcGroup.make(
  Rpc.make('List', {
    payload: {
      teamId: TeamId,
    },
    success: Schema.Array(TeamChallengeView),
    error: TeamChallengeForbidden,
  }),
  Rpc.make('Create', {
    payload: {
      teamId: TeamId,
      startDate: Schema.Date,
      endDate: Schema.Date,
      kind: TeamChallengeKind,
      title: TeamChallengeTitle,
      description: Schema.OptionFromNullOr(TeamChallengeDescription),
    },
    success: TeamChallenge,
    error: Schema.Union([
      TeamChallengeForbidden,
      TeamChallengeAlreadyExistsForWeek,
      TeamChallengeStartDateOutOfRange,
    ]),
  }),
  Rpc.make('UpdateTitleDescription', {
    payload: {
      challengeId: TeamChallengeId,
      title: TeamChallengeTitle,
      description: Schema.OptionFromNullOr(TeamChallengeDescription),
    },
    success: TeamChallenge,
    error: Schema.Union([TeamChallengeForbidden, TeamChallengeNotFound]),
  }),
  Rpc.make('Delete', {
    payload: {
      challengeId: TeamChallengeId,
    },
    error: Schema.Union([TeamChallengeForbidden, TeamChallengeNotFound]),
  }),
  Rpc.make('MarkCompleted', {
    payload: {
      challengeId: TeamChallengeId,
    },
    error: Schema.Union([TeamChallengeNotFound, TeamChallengeNotActive, TeamChallengeForbidden]),
  }),
  Rpc.make('UnmarkCompleted', {
    payload: {
      challengeId: TeamChallengeId,
    },
    error: Schema.Union([TeamChallengeNotFound, TeamChallengeNotActive, TeamChallengeForbidden]),
  }),
).prefix('TeamChallenge/');
