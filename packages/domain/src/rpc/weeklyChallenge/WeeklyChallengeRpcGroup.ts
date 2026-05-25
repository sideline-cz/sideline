import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import { TeamId } from '../../models/Team.js';
import {
  WeeklyChallenge,
  WeeklyChallengeDescription,
  WeeklyChallengeId,
  WeeklyChallengeKind,
  WeeklyChallengeTitle,
  WeeklyChallengeView,
} from '../../models/WeeklyChallenge.js';

export class WeeklyChallengeNotFound extends Schema.TaggedErrorClass<WeeklyChallengeNotFound>()(
  'WeeklyChallengeNotFound',
  {},
) {}

export class WeeklyChallengeNotActive extends Schema.TaggedErrorClass<WeeklyChallengeNotActive>()(
  'WeeklyChallengeNotActive',
  {},
) {}

export class WeeklyChallengeAlreadyExistsForWeek extends Schema.TaggedErrorClass<WeeklyChallengeAlreadyExistsForWeek>()(
  'WeeklyChallengeAlreadyExistsForWeek',
  {},
) {}

export class WeeklyChallengeWeekOutOfRange extends Schema.TaggedErrorClass<WeeklyChallengeWeekOutOfRange>()(
  'WeeklyChallengeWeekOutOfRange',
  {},
) {}

export class WeeklyChallengeForbidden extends Schema.TaggedErrorClass<WeeklyChallengeForbidden>()(
  'WeeklyChallengeForbidden',
  {},
) {}

export const WeeklyChallengeRpcGroup = RpcGroup.make(
  Rpc.make('List', {
    payload: {
      teamId: TeamId,
    },
    success: Schema.Array(WeeklyChallengeView),
    error: WeeklyChallengeForbidden,
  }),
  Rpc.make('Create', {
    payload: {
      teamId: TeamId,
      weekStart: Schema.Date,
      kind: WeeklyChallengeKind,
      title: WeeklyChallengeTitle,
      description: Schema.OptionFromNullOr(WeeklyChallengeDescription),
    },
    success: WeeklyChallenge,
    error: Schema.Union([
      WeeklyChallengeForbidden,
      WeeklyChallengeAlreadyExistsForWeek,
      WeeklyChallengeWeekOutOfRange,
    ]),
  }),
  Rpc.make('UpdateTitleDescription', {
    payload: {
      challengeId: WeeklyChallengeId,
      title: WeeklyChallengeTitle,
      description: Schema.OptionFromNullOr(WeeklyChallengeDescription),
    },
    success: WeeklyChallenge,
    error: Schema.Union([WeeklyChallengeForbidden, WeeklyChallengeNotFound]),
  }),
  Rpc.make('Delete', {
    payload: {
      challengeId: WeeklyChallengeId,
    },
    error: Schema.Union([WeeklyChallengeForbidden, WeeklyChallengeNotFound]),
  }),
  Rpc.make('MarkCompleted', {
    payload: {
      challengeId: WeeklyChallengeId,
    },
    error: Schema.Union([
      WeeklyChallengeNotFound,
      WeeklyChallengeNotActive,
      WeeklyChallengeForbidden,
    ]),
  }),
  Rpc.make('UnmarkCompleted', {
    payload: {
      challengeId: WeeklyChallengeId,
    },
    error: Schema.Union([
      WeeklyChallengeNotFound,
      WeeklyChallengeNotActive,
      WeeklyChallengeForbidden,
    ]),
  }),
).prefix('WeeklyChallenge/');
