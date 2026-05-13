import { Schema } from 'effect';
import * as Discord from '../../models/Discord.js';
import * as Team from '../../models/Team.js';

const UUIDString = Schema.String.pipe(Schema.check(Schema.isUUID()));

export class WeeklySummaryReadyEvent extends Schema.TaggedClass<WeeklySummaryReadyEvent>()(
  'weekly_summary_ready',
  {
    id: UUIDString,
    team_id: Team.TeamId,
    channel_id: Discord.Snowflake,
    week_start: Schema.String,
    week_end: Schema.String,
    payload: Schema.Unknown,
  },
) {}

export const UnprocessedWeeklySummaryEvent = Schema.Union([WeeklySummaryReadyEvent]);

export type UnprocessedWeeklySummaryEvent = Schema.Schema.Type<
  typeof UnprocessedWeeklySummaryEvent
>;
