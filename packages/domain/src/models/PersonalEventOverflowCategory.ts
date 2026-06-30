import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { Snowflake } from '~/models/Discord.js';
import { TeamId } from '~/models/Team.js';

export const PersonalEventOverflowCategoryId = Schema.String.pipe(
  Schema.brand('PersonalEventOverflowCategoryId'),
);
export type PersonalEventOverflowCategoryId = typeof PersonalEventOverflowCategoryId.Type;

export class PersonalEventOverflowCategory extends Model.Class<PersonalEventOverflowCategory>(
  'PersonalEventOverflowCategory',
)({
  id: Model.Generated(PersonalEventOverflowCategoryId),
  team_id: TeamId,
  // Reserve-first allocation inserts the row with a NULL category id (migration
  // 1790300008), then a follow-up SavePersonalOverflowCategoryId fills it in once
  // the Discord category exists — so this is nullable to match the column.
  discord_category_id: Schema.OptionFromNullOr(Snowflake),
  sequence: Schema.Int,
  created_at: Model.DateTimeInsertFromDate,
}) {}
