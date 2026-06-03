import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { Snowflake } from '~/models/Discord.js';
import { EventId } from '~/models/Event.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export const CarpoolId = Schema.String.pipe(Schema.brand('CarpoolId'));
export type CarpoolId = typeof CarpoolId.Type;

export const CarpoolCarId = Schema.String.pipe(Schema.brand('CarpoolCarId'));
export type CarpoolCarId = typeof CarpoolCarId.Type;

export const CarpoolSeatId = Schema.String.pipe(Schema.brand('CarpoolSeatId'));
export type CarpoolSeatId = typeof CarpoolSeatId.Type;

export class Carpool extends Model.Class<Carpool>('Carpool')({
  id: Model.Generated(CarpoolId),
  team_id: TeamId,
  event_id: Schema.OptionFromNullOr(EventId),
  guild_id: Snowflake,
  discord_channel_id: Snowflake,
  discord_message_id: Schema.OptionFromNullOr(Snowflake),
  created_by: TeamMemberId,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}

export class CarpoolCar extends Model.Class<CarpoolCar>('CarpoolCar')({
  id: Model.Generated(CarpoolCarId),
  carpool_id: CarpoolId,
  owner_team_member_id: TeamMemberId,
  capacity: Schema.Number,
  thread_id: Schema.OptionFromNullOr(Snowflake),
  note: Schema.OptionFromNullOr(Schema.String),
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}

export class CarpoolSeat extends Model.Class<CarpoolSeat>('CarpoolSeat')({
  id: Model.Generated(CarpoolSeatId),
  car_id: CarpoolCarId,
  carpool_id: CarpoolId,
  team_member_id: TeamMemberId,
  assigned_by: Schema.OptionFromNullOr(TeamMemberId),
  created_at: Model.DateTimeInsertFromDate,
}) {}
