import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import { CarpoolCarId, CarpoolId } from '~/models/Carpool.js';
import * as Discord from '~/models/Discord.js';
import * as Event from '~/models/Event.js';
import {
  AddCarResult,
  CarpoolAlreadyInAnotherCar,
  CarpoolAlreadyInThisCar,
  CarpoolAlreadyOwnsCar,
  CarpoolCarNotFound,
  CarpoolForbidden,
  CarpoolFull,
  CarpoolGuildNotFound,
  CarpoolNotCarOwner,
  CarpoolNotFound,
  CarpoolNotInCar,
  CarpoolNotMember,
  CarpoolOwnerCannotLeave,
  CarpoolOwnerCannotReserve,
  CarpoolTargetNotMember,
  CarpoolView,
  LeaveCarpoolResult,
  RemoveCarResult,
  ReserveResult,
} from './CarpoolRpcModels.js';

export const CarpoolRpcGroup = RpcGroup.make(
  Rpc.make('CreateCarpool', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
      discord_channel_id: Discord.Snowflake,
      event_id: Schema.OptionFromNullOr(Event.EventId),
    },
    success: CarpoolView,
    error: Schema.Union([CarpoolGuildNotFound, CarpoolNotMember, CarpoolForbidden]),
  }),
  Rpc.make('SaveCarpoolMessageId', {
    payload: {
      carpool_id: CarpoolId,
      discord_message_id: Discord.Snowflake,
    },
  }),
  Rpc.make('SaveCarThreadId', {
    payload: {
      car_id: CarpoolCarId,
      thread_id: Discord.Snowflake,
    },
  }),
  Rpc.make('GetCarpoolView', {
    payload: {
      carpool_id: CarpoolId,
    },
    success: Schema.OptionFromNullOr(CarpoolView),
  }),
  Rpc.make('AddCar', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
      carpool_id: CarpoolId,
      capacity: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 8 }))),
      note: Schema.OptionFromNullOr(Schema.String),
    },
    success: AddCarResult,
    error: Schema.Union([
      CarpoolGuildNotFound,
      CarpoolNotMember,
      CarpoolNotFound,
      CarpoolAlreadyOwnsCar,
      CarpoolAlreadyInAnotherCar,
    ]),
  }),
  Rpc.make('ReserveSeat', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
      car_id: CarpoolCarId,
    },
    success: ReserveResult,
    error: Schema.Union([
      CarpoolGuildNotFound,
      CarpoolNotMember,
      CarpoolCarNotFound,
      CarpoolFull,
      CarpoolAlreadyInThisCar,
      CarpoolAlreadyInAnotherCar,
      CarpoolOwnerCannotReserve,
    ]),
  }),
  Rpc.make('AssignSeat', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
      car_id: CarpoolCarId,
      target_discord_user_id: Discord.Snowflake,
    },
    success: ReserveResult,
    error: Schema.Union([
      CarpoolGuildNotFound,
      CarpoolNotMember,
      CarpoolCarNotFound,
      CarpoolFull,
      CarpoolAlreadyInThisCar,
      CarpoolAlreadyInAnotherCar,
      CarpoolOwnerCannotReserve,
      CarpoolNotCarOwner,
      CarpoolTargetNotMember,
    ]),
  }),
  Rpc.make('LeaveSeat', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
      car_id: CarpoolCarId,
    },
    success: CarpoolView,
    error: Schema.Union([
      CarpoolGuildNotFound,
      CarpoolNotMember,
      CarpoolCarNotFound,
      CarpoolNotInCar,
      CarpoolOwnerCannotLeave,
    ]),
  }),
  Rpc.make('LeaveCarpool', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
      carpool_id: CarpoolId,
    },
    success: LeaveCarpoolResult,
    error: Schema.Union([
      CarpoolGuildNotFound,
      CarpoolNotMember,
      CarpoolNotInCar,
      CarpoolOwnerCannotLeave,
    ]),
  }),
  Rpc.make('RemoveCar', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
      car_id: CarpoolCarId,
    },
    success: RemoveCarResult,
    error: Schema.Union([
      CarpoolGuildNotFound,
      CarpoolNotMember,
      CarpoolCarNotFound,
      CarpoolNotCarOwner,
    ]),
  }),
).prefix('Carpool/');
