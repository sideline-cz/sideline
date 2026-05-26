import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { Snowflake } from '~/models/Discord.js';

export const UserId = Schema.String.pipe(Schema.brand('UserId'));
export type UserId = typeof UserId.Type;

export const Gender = Schema.Literals(['male', 'female', 'other']);
export type Gender = typeof Gender.Type;

export const Locale = Schema.Literals(['en', 'cs']);
export type Locale = typeof Locale.Type;

export class User extends Model.Class<User>('User')({
  id: Model.Generated(UserId),
  discord_id: Snowflake,
  username: Schema.String,
  discord_nickname: Model.FieldExcept(['insert'])(Schema.OptionFromNullOr(Schema.String)),
  discord_display_name: Model.FieldExcept(['insert'])(Schema.OptionFromNullOr(Schema.String)),
  avatar: Schema.OptionFromNullOr(Schema.String),
  name: Schema.OptionFromNullOr(Schema.String),
  birth_date: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  gender: Schema.OptionFromNullOr(Gender),
  locale: Locale,
  created_at: Model.DateTimeInsertFromDate,
  is_profile_complete: Schema.Boolean,
  is_global_admin: Schema.Boolean,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}
