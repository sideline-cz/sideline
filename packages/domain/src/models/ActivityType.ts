import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { TeamId } from '~/models/Team.js';

export const ActivityTypeId = Schema.String.pipe(Schema.brand('ActivityTypeId'));
export type ActivityTypeId = typeof ActivityTypeId.Type;

export const ActivityTypeSlug = Schema.Literals(['gym', 'running', 'stretching', 'training']);
export type ActivityTypeSlug = typeof ActivityTypeSlug.Type;

export const ActivityTypeName = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(50)));
export type ActivityTypeName = typeof ActivityTypeName.Type;

export const ActivityTypeDescription = Schema.String.pipe(Schema.check(Schema.isMaxLength(200)));
export type ActivityTypeDescription = typeof ActivityTypeDescription.Type;

const isActivityTypeEmoji = (s: string): boolean | string => {
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    if (Array.from(seg.segment(s)).length !== 1) return 'Emoji must be a single grapheme cluster';
  } catch {
    // Older runtimes — fall back to allowing it (defense-in-depth happens server-side too).
  }
  return true;
};

// Single grapheme cluster, max 8 UTF-16 code units (allows ZWJ-joined emojis).
export const ActivityTypeEmoji = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(8)),
  Schema.check(Schema.makeFilter<string>(isActivityTypeEmoji)),
);
export type ActivityTypeEmoji = typeof ActivityTypeEmoji.Type;

export class ActivityType extends Model.Class<ActivityType>('ActivityType')({
  id: Model.Generated(ActivityTypeId),
  team_id: Schema.OptionFromNullOr(TeamId),
  name: Schema.String,
  slug: Schema.OptionFromNullOr(Schema.String),
  emoji: Schema.OptionFromNullOr(ActivityTypeEmoji),
  description: Schema.OptionFromNullOr(ActivityTypeDescription),
  created_at: Model.DateTimeInsertFromDate,
}) {}
