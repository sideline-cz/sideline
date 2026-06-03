import { Schema } from 'effect';
import { CarpoolCarId, CarpoolId } from '~/models/Carpool.js';
import { Snowflake } from '~/models/Discord.js';
import { EventId } from '~/models/Event.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export class MemberDisplay extends Schema.Class<MemberDisplay>('MemberDisplay')({
  team_member_id: TeamMemberId,
  discord_id: Schema.OptionFromNullOr(Snowflake),
  name: Schema.OptionFromNullOr(Schema.String),
  nickname: Schema.OptionFromNullOr(Schema.String),
  display_name: Schema.OptionFromNullOr(Schema.String),
  username: Schema.OptionFromNullOr(Schema.String),
}) {}

export class CarpoolCarView extends Schema.Class<CarpoolCarView>('CarpoolCarView')({
  car_id: CarpoolCarId,
  thread_id: Schema.OptionFromNullOr(Snowflake),
  capacity: Schema.Number,
  note: Schema.OptionFromNullOr(Schema.String),
  owner: MemberDisplay,
  passengers: Schema.Array(MemberDisplay),
}) {}

export class CarpoolView extends Schema.Class<CarpoolView>('CarpoolView')({
  carpool_id: CarpoolId,
  discord_channel_id: Snowflake,
  discord_message_id: Schema.OptionFromNullOr(Snowflake),
  event_id: Schema.OptionFromNullOr(EventId),
  cars: Schema.Array(CarpoolCarView),
}) {}

export class AddCarResult extends Schema.Class<AddCarResult>('AddCarResult')({
  car_id: CarpoolCarId,
  view: CarpoolView,
}) {}

export class ReserveResult extends Schema.Class<ReserveResult>('ReserveResult')({
  thread_id: Schema.OptionFromNullOr(Snowflake),
  view: CarpoolView,
}) {}

export class RemoveCarResult extends Schema.Class<RemoveCarResult>('RemoveCarResult')({
  thread_id: Schema.OptionFromNullOr(Snowflake),
  view: CarpoolView,
}) {}

export class CarpoolGuildNotFound extends Schema.TaggedErrorClass<CarpoolGuildNotFound>()(
  'CarpoolGuildNotFound',
  {},
) {}

export class CarpoolNotMember extends Schema.TaggedErrorClass<CarpoolNotMember>()(
  'CarpoolNotMember',
  {},
) {}

export class CarpoolNotFound extends Schema.TaggedErrorClass<CarpoolNotFound>()(
  'CarpoolNotFound',
  {},
) {}

export class CarpoolCarNotFound extends Schema.TaggedErrorClass<CarpoolCarNotFound>()(
  'CarpoolCarNotFound',
  {},
) {}

export class CarpoolFull extends Schema.TaggedErrorClass<CarpoolFull>()('CarpoolFull', {}) {}

export class CarpoolAlreadyInThisCar extends Schema.TaggedErrorClass<CarpoolAlreadyInThisCar>()(
  'CarpoolAlreadyInThisCar',
  {},
) {}

export class CarpoolAlreadyInAnotherCar extends Schema.TaggedErrorClass<CarpoolAlreadyInAnotherCar>()(
  'CarpoolAlreadyInAnotherCar',
  {},
) {}

export class CarpoolAlreadyOwnsCar extends Schema.TaggedErrorClass<CarpoolAlreadyOwnsCar>()(
  'CarpoolAlreadyOwnsCar',
  {},
) {}

export class CarpoolOwnerCannotReserve extends Schema.TaggedErrorClass<CarpoolOwnerCannotReserve>()(
  'CarpoolOwnerCannotReserve',
  {},
) {}

export class CarpoolOwnerCannotLeave extends Schema.TaggedErrorClass<CarpoolOwnerCannotLeave>()(
  'CarpoolOwnerCannotLeave',
  {},
) {}

export class CarpoolNotInCar extends Schema.TaggedErrorClass<CarpoolNotInCar>()(
  'CarpoolNotInCar',
  {},
) {}

export class CarpoolNotCarOwner extends Schema.TaggedErrorClass<CarpoolNotCarOwner>()(
  'CarpoolNotCarOwner',
  {},
) {}

export class CarpoolTargetNotMember extends Schema.TaggedErrorClass<CarpoolTargetNotMember>()(
  'CarpoolTargetNotMember',
  {},
) {}

export class CarpoolForbidden extends Schema.TaggedErrorClass<CarpoolForbidden>()(
  'CarpoolForbidden',
  {},
) {}
