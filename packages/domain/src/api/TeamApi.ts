import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { Forbidden } from '~/api/EventApi.js';
import { Snowflake } from '~/models/Discord.js';
import { OnboardingLocale, OnboardingSyncStatus } from '~/models/Onboarding.js';
import { TeamId } from '~/models/Team.js';

export class TeamInfo extends Schema.Class<TeamInfo>('TeamInfo')({
  teamId: TeamId,
  name: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  sport: Schema.OptionFromNullOr(Schema.String),
  logoUrl: Schema.OptionFromNullOr(Schema.String),
  guildId: Snowflake,
  welcomeChannelId: Schema.OptionFromNullOr(Snowflake),
  systemLogChannelId: Schema.OptionFromNullOr(Snowflake),
  welcomeMessageTemplate: Schema.OptionFromNullOr(Schema.String),
  verifyIntroTemplate: Schema.OptionFromNullOr(Schema.String),
  rulesChannelId: Schema.OptionFromNullOr(Snowflake),
  achievementChannelId: Schema.OptionFromNullOr(Snowflake),
  onboardingRulesRoleId: Schema.OptionFromNullOr(Snowflake),
  onboardingLocale: OnboardingLocale,
  onboardingSyncStatus: OnboardingSyncStatus,
  onboardingSyncedAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  onboardingSyncError: Schema.OptionFromNullOr(Schema.String),
  isCommunityEnabled: Schema.Boolean,
}) {}

export const UpdateTeamRequest = Schema.Struct({
  name: Schema.OptionFromOptional(
    Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(100))),
  ),
  description: Schema.OptionFromOptional(
    Schema.OptionFromNullOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(500)))),
  ),
  sport: Schema.OptionFromOptional(
    Schema.OptionFromNullOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(50)))),
  ),
  logoUrl: Schema.OptionFromOptional(
    Schema.OptionFromNullOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(2048)))),
  ),
  welcomeChannelId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  achievementChannelId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  systemLogChannelId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  welcomeMessageTemplate: Schema.OptionFromOptional(
    Schema.OptionFromNullOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(500)))),
  ),
  // Becomes an embed `description`, whose Discord cap is 4096 (6000 across the whole
  // embed, and the hardcoded title/fields/footer eat ~600). isMinLength(1) because
  // Discord rejects an empty description outright.
  verifyIntroTemplate: Schema.OptionFromOptional(
    Schema.OptionFromNullOr(
      Schema.String.pipe(
        Schema.check(Schema.isMinLength(1)),
        Schema.check(Schema.isMaxLength(2000)),
      ),
    ),
  ),
  rulesChannelId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  onboardingRulesRoleId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  onboardingLocale: Schema.OptionFromOptional(OnboardingLocale),
});
export type UpdateTeamRequest = Schema.Schema.Type<typeof UpdateTeamRequest>;

// Nastavitelná docházka (plan §5.6): the calling member's own event preferences for a team.
export class MemberEventPreferences extends Schema.Class<MemberEventPreferences>(
  'MemberEventPreferences',
)({
  showAttendeeList: Schema.Boolean,
  rsvpReminderDms: Schema.Boolean,
  personalChannelsSplit: Schema.Boolean,
  // False when the team has no discord_personal_events_category_id — there are no
  // personal channels to configure, so the UI hides the channel block (design.md §A.8).
  // Response-only; the PATCH payload is a separate schema without it.
  personalChannelsAvailable: Schema.Boolean,
}) {}

// A `Schema.Struct`, NOT a `Schema.Class`, like every other request payload in this API
// (81 of them). The HTTP client encodes the payload before it issues the request, and a
// Class schema does not accept the plain object every call site passes — encoding fails,
// the effect errors out, and NO network request is ever sent. The symptom is a generic
// save-failed toast with nothing in the Network tab, which looks like a server problem
// and is not one. Response schemas may stay classes; only payloads are affected.
export const UpdateMemberEventPreferences = Schema.Struct({
  showAttendeeList: Schema.Boolean,
  rsvpReminderDms: Schema.Boolean,
  personalChannelsSplit: Schema.Boolean,
});
export type UpdateMemberEventPreferences = Schema.Schema.Type<typeof UpdateMemberEventPreferences>;

export class TeamApiGroup extends HttpApiGroup.make('team')
  .add(
    HttpApiEndpoint.get('getTeamInfo', '/teams/:teamId', {
      success: TeamInfo,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateTeamInfo', '/teams/:teamId', {
      success: TeamInfo,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      payload: UpdateTeamRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('retryOnboardingSync', '/teams/:teamId/onboarding/retry', {
      success: TeamInfo,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getMyEventPreferences', '/teams/:teamId/me/event-preferences', {
      success: MemberEventPreferences,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateMyEventPreferences', '/teams/:teamId/me/event-preferences', {
      success: MemberEventPreferences,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      payload: UpdateMemberEventPreferences,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  ) {}
