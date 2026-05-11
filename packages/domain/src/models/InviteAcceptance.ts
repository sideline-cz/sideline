import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { InviteGeneratorErrorCode } from '~/models/Onboarding.js';
import { TeamInviteId } from '~/models/TeamInvite.js';
import { UserId } from '~/models/User.js';

export const InviteAcceptanceId = Schema.String.pipe(Schema.brand('InviteAcceptanceId'));
export type InviteAcceptanceId = typeof InviteAcceptanceId.Type;

export class InviteAcceptance extends Model.Class<InviteAcceptance>('InviteAcceptance')({
  id: Model.Generated(InviteAcceptanceId),
  team_invite_id: TeamInviteId,
  user_id: UserId,
  discord_code: Schema.OptionFromNullOr(Schema.String),
  discord_code_error_code: Schema.OptionFromNullOr(InviteGeneratorErrorCode),
  discord_code_error_detail: Schema.OptionFromNullOr(Schema.String),
  created_at: Model.DateTimeInsertFromDate,
  generated_at: Schema.OptionFromNullOr(Schema.Date),
}) {}
