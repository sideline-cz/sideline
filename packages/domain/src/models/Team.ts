import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { Snowflake } from '~/models/Discord.js';
import { OnboardingLocale, OnboardingSyncStatus } from '~/models/Onboarding.js';
import { UserId } from '~/models/User.js';

export const TeamId = Schema.String.pipe(Schema.brand('TeamId'));
export type TeamId = typeof TeamId.Type;

export class Team extends Model.Class<Team>('Team')({
  id: Model.Generated(TeamId),
  name: Schema.String,
  guild_id: Snowflake,
  description: Schema.OptionFromNullOr(Schema.String),
  sport: Schema.OptionFromNullOr(Schema.String),
  logo_url: Schema.OptionFromNullOr(Schema.String),
  created_by: UserId,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
  welcome_channel_id: Schema.OptionFromNullOr(Snowflake),
  system_log_channel_id: Schema.OptionFromNullOr(Snowflake),
  welcome_message_template: Schema.OptionFromNullOr(Schema.String),
  rules_channel_id: Schema.OptionFromNullOr(Snowflake),
  onboarding_rules_role_id: Schema.OptionFromNullOr(Snowflake),
  onboarding_rules_prompt_id: Schema.OptionFromNullOr(Snowflake),
  onboarding_locale: OnboardingLocale,
  onboarding_synced_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  onboarding_sync_status: OnboardingSyncStatus,
  onboarding_sync_error: Schema.OptionFromNullOr(Schema.String),
}) {}
