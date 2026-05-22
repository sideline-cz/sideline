import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware, UserTeam } from '~/api/Auth.js';
import { isPublicHttpsUrl } from '~/api/EventApi.js';
import { Snowflake } from '~/models/Discord.js';
import { OnboardingLocale } from '~/models/Onboarding.js';
import { TeamId } from '~/models/Team.js';
import { OnboardingTokenTtl, TeamOnboardingTokenId } from '~/models/TeamOnboardingToken.js';
import { UserId } from '~/models/User.js';

// --- Logo URL (SSRF-guarded) ---

const isValidLogoUrl = (value: string): boolean | string => {
  if (!isPublicHttpsUrl(value)) {
    return 'Logo URL must be a valid public https:// URL without userinfo or private-network addresses';
  }
  return true;
};

export const OnboardingLogoUrl = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(2048)),
  Schema.check(Schema.makeFilter<string>(isValidLogoUrl)),
);
export type OnboardingLogoUrl = typeof OnboardingLogoUrl.Type;

// --- Request schemas ---

export const CreateOnboardingTokenRequest = Schema.Struct({
  proposedName: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(100)),
  ),
  boundDiscordId: Snowflake,
  ttl: OnboardingTokenTtl,
});
export type CreateOnboardingTokenRequest = Schema.Schema.Type<typeof CreateOnboardingTokenRequest>;

export const CompleteOnboardingRequest = Schema.Struct({
  name: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(100)),
  ),
  description: Schema.OptionFromNullOr(Schema.String),
  sport: Schema.OptionFromNullOr(Schema.String),
  logoUrl: Schema.OptionFromNullOr(OnboardingLogoUrl),
  guildId: Snowflake,
  welcomeChannelId: Schema.OptionFromNullOr(Snowflake),
  systemLogChannelId: Schema.OptionFromNullOr(Snowflake),
  onboardingLocale: OnboardingLocale,
});
export type CompleteOnboardingRequest = Schema.Schema.Type<typeof CompleteOnboardingRequest>;

// --- Response schemas ---

export const CreateOnboardingTokenResponse = Schema.Struct({
  plaintextToken: Schema.String,
  onboardingUrl: Schema.String,
  expiresAt: Schemas.DateTimeFromIsoString,
});
export type CreateOnboardingTokenResponse = Schema.Schema.Type<
  typeof CreateOnboardingTokenResponse
>;

export const OnboardingTokenPreview = Schema.Struct({
  proposedName: Schema.String,
  boundDiscordId: Snowflake,
  expiresAt: Schemas.DateTimeFromIsoString,
});
export type OnboardingTokenPreview = Schema.Schema.Type<typeof OnboardingTokenPreview>;

export const OnboardingTokenStatus = Schema.Literals(['active', 'consumed', 'expired', 'revoked']);
export type OnboardingTokenStatus = typeof OnboardingTokenStatus.Type;

export const OnboardingTokenListItem = Schema.Struct({
  id: TeamOnboardingTokenId,
  proposedName: Schema.String,
  boundDiscordId: Snowflake,
  createdAt: Schemas.DateTimeFromIsoString,
  expiresAt: Schemas.DateTimeFromIsoString,
  status: OnboardingTokenStatus,
  consumedAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  consumedBy: Schema.OptionFromNullOr(UserId),
  resultingTeamId: Schema.OptionFromNullOr(TeamId),
  createdByUsername: Schema.String,
});
export type OnboardingTokenListItem = Schema.Schema.Type<typeof OnboardingTokenListItem>;

// --- Tagged errors ---

export class OnboardingForbidden extends Schema.TaggedErrorClass<OnboardingForbidden>()(
  'OnboardingForbidden',
  {},
) {}

export class OnboardingTokenNotFound extends Schema.TaggedErrorClass<OnboardingTokenNotFound>()(
  'OnboardingTokenNotFound',
  {},
) {}

export class OnboardingTokenExpired extends Schema.TaggedErrorClass<OnboardingTokenExpired>()(
  'OnboardingTokenExpired',
  {},
) {}

export class OnboardingTokenAlreadyConsumed extends Schema.TaggedErrorClass<OnboardingTokenAlreadyConsumed>()(
  'OnboardingTokenAlreadyConsumed',
  {},
) {}

export class OnboardingTokenRevoked extends Schema.TaggedErrorClass<OnboardingTokenRevoked>()(
  'OnboardingTokenRevoked',
  {},
) {}

export class OnboardingWrongCaptain extends Schema.TaggedErrorClass<OnboardingWrongCaptain>()(
  'OnboardingWrongCaptain',
  {},
) {}

export class OnboardingGuildAlreadyClaimed extends Schema.TaggedErrorClass<OnboardingGuildAlreadyClaimed>()(
  'OnboardingGuildAlreadyClaimed',
  {},
) {}

// --- API group ---

export class OnboardingApiGroup extends HttpApiGroup.make('onboarding')
  .add(
    HttpApiEndpoint.post('mintOnboardingToken', '/onboarding/tokens', {
      success: CreateOnboardingTokenResponse.pipe(HttpApiSchema.status(201)),
      error: OnboardingForbidden.pipe(HttpApiSchema.status(403)),
      payload: CreateOnboardingTokenRequest,
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('listOnboardingTokens', '/onboarding/tokens', {
      success: Schema.Array(OnboardingTokenListItem),
      error: OnboardingForbidden.pipe(HttpApiSchema.status(403)),
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete('revokeOnboardingToken', '/onboarding/tokens/:tokenId', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        OnboardingForbidden.pipe(HttpApiSchema.status(403)),
        OnboardingTokenNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { tokenId: TeamOnboardingTokenId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('previewOnboardingToken', '/onboarding/tokens/:plaintextToken/preview', {
      success: OnboardingTokenPreview,
      error: [
        OnboardingTokenNotFound.pipe(HttpApiSchema.status(404)),
        OnboardingTokenExpired.pipe(HttpApiSchema.status(410)),
        OnboardingTokenRevoked.pipe(HttpApiSchema.status(410)),
        OnboardingTokenAlreadyConsumed.pipe(HttpApiSchema.status(409)),
      ],
      params: { plaintextToken: Schema.String },
    }),
  )
  .add(
    HttpApiEndpoint.post('completeOnboarding', '/onboarding/tokens/:plaintextToken/complete', {
      success: UserTeam.pipe(HttpApiSchema.status(201)),
      error: [
        OnboardingTokenNotFound.pipe(HttpApiSchema.status(404)),
        OnboardingTokenExpired.pipe(HttpApiSchema.status(410)),
        OnboardingTokenRevoked.pipe(HttpApiSchema.status(410)),
        OnboardingTokenAlreadyConsumed.pipe(HttpApiSchema.status(409)),
        OnboardingWrongCaptain.pipe(HttpApiSchema.status(403)),
        OnboardingGuildAlreadyClaimed.pipe(HttpApiSchema.status(409)),
      ],
      params: { plaintextToken: Schema.String },
      payload: CompleteOnboardingRequest,
    }).middleware(AuthMiddleware),
  )
  .prefix('/auth') {}
