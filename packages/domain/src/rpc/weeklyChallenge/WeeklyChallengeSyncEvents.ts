import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as Discord from '../../models/Discord.js';
import * as Team from '../../models/Team.js';
import {
  WeeklyChallengeDescription,
  WeeklyChallengeId,
  WeeklyChallengeKind,
  WeeklyChallengeTitle,
} from '../../models/WeeklyChallenge.js';

const UUIDString = Schema.String.pipe(Schema.check(Schema.isUUID()));

export class UnprocessedWeeklyChallengeEvent extends Schema.Class<UnprocessedWeeklyChallengeEvent>(
  'UnprocessedWeeklyChallengeEvent',
)({
  id: UUIDString,
  teamId: Team.TeamId,
  challengeId: WeeklyChallengeId,
  channelId: Discord.Snowflake,
  scheduledFor: Schema.DateTimeUtc,
  attempts: Schema.Int,
  title: WeeklyChallengeTitle,
  kind: WeeklyChallengeKind,
  description: Schema.OptionFromNullOr(WeeklyChallengeDescription),
  weekStartDate: Schema.String,
  weekEndDate: Schema.String,
}) {}

export const WeeklyChallengeSyncEventsRpcGroup = RpcGroup.make(
  Rpc.make('GetUnprocessedWeeklyChallengeEvents', {
    success: Schema.Array(UnprocessedWeeklyChallengeEvent),
  }),
  Rpc.make('MarkWeeklyChallengeProcessed', {
    payload: { eventId: UUIDString, deliveredAt: Schema.DateTimeUtc },
  }),
  Rpc.make('MarkWeeklyChallengeFailed', {
    payload: { eventId: UUIDString, error: Schema.String },
  }),
).prefix('WeeklyChallenge/');
