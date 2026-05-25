import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as Discord from '../../models/Discord.js';
import * as Team from '../../models/Team.js';
import {
  TeamChallengeDescription,
  TeamChallengeId,
  TeamChallengeKind,
  TeamChallengeTitle,
} from '../../models/TeamChallenge.js';

const UUIDString = Schema.String.pipe(Schema.check(Schema.isUUID()));

export class UnprocessedTeamChallengeEvent extends Schema.Class<UnprocessedTeamChallengeEvent>(
  'UnprocessedTeamChallengeEvent',
)({
  id: UUIDString,
  teamId: Team.TeamId,
  challengeId: TeamChallengeId,
  channelId: Discord.Snowflake,
  scheduledFor: Schema.DateTimeUtc,
  attempts: Schema.Int,
  title: TeamChallengeTitle,
  kind: TeamChallengeKind,
  description: Schema.OptionFromNullOr(TeamChallengeDescription),
  startDate: Schema.String,
  endDate: Schema.String,
}) {}

export const TeamChallengeSyncEventsRpcGroup = RpcGroup.make(
  Rpc.make('GetUnprocessedTeamChallengeEvents', {
    success: Schema.Array(UnprocessedTeamChallengeEvent),
  }),
  Rpc.make('MarkTeamChallengeProcessed', {
    payload: { eventId: UUIDString, deliveredAt: Schema.DateTimeUtc },
  }),
  Rpc.make('MarkTeamChallengeFailed', {
    payload: { eventId: UUIDString, error: Schema.String },
  }),
).prefix('TeamChallenge/');
