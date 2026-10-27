import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { Snowflake } from '~/models/Discord.js';

export const UserId = Schema.String.pipe(Schema.brand('UserId'));
export type UserId = typeof UserId.Type;

export const Gender = Schema.Literals(['male', 'female', 'other']);
export type Gender = typeof Gender.Type;

// Aggregate head-count by gender. `unknown` is the bucket for members with no recorded
// gender — `users.gender` is NULLABLE and in production it is the LARGEST bucket (46% of
// active members on the reference team), so it is a first-class category here, never an
// omission. Mirrors the `GenderCounts` interface in `models/TeamGenerator.ts`, which is a
// pure no-Effect algorithm module and therefore cannot hold a Schema itself; the four keys
// must stay in step with `GenderValue` there.
// Line comments, not JSDoc: the barrel codegen hoists a file's first doc block onto its
// `export * as` re-export.
export const GenderCounts = Schema.Struct({
  male: Schema.Int,
  female: Schema.Int,
  other: Schema.Int,
  unknown: Schema.Int,
});
export type GenderCounts = typeof GenderCounts.Type;

// The three numbers a gender split actually renders, shared by the web RSVP panel and the
// Discord embed so the two can never disagree. Pure arithmetic; each surface formats it with
// its own i18n runtime.
export interface GenderSplitDisplay {
  readonly total: number;
  readonly male: number;
  readonly female: number;
  readonly more: number;
}

// `more` is DERIVED (total minus the two named buckets), never summed from stored buckets.
// That is what guarantees the rendered numbers always account for everyone: `other` and
// `unknown` both land in it today, and a gender value added later lands in it automatically
// instead of silently vanishing from a breakdown that still reads as complete.
//
// `null` means there is nothing to render, and reaches exactly one case: nobody is going.
//
// Everything else is PRESENTATION and belongs to each formatter, not here. In particular the
// all-unrecorded case (male and female both 0) differs by surface: the web line reads "3 going
// — 3 more", which is nonsense ("more" than what?), so it drops to the bare total; the Discord
// title reads `3 👤`, which is meaningful, so it keeps the bucket. This function reports the
// true remainder in both cases and lets them decide. Zero buckets are the formatter's job to
// omit too.
export const genderSplitDisplay = (counts: GenderCounts): GenderSplitDisplay | null => {
  const total = counts.male + counts.female + counts.other + counts.unknown;
  if (total === 0) return null;
  return {
    total,
    male: counts.male,
    female: counts.female,
    more: total - counts.male - counts.female,
  };
};

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
  global_admin_granted_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  updated_at: Model.DateTimeUpdateFromDate,
}) {}
