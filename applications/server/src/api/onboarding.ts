import { Auth, OnboardingApi, type TeamOnboardingToken } from '@sideline/domain';
import { LogicError, Options, SqlErrors } from '@sideline/effect-lib';
import { DateTime, Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { env } from '~/env.js';
import { TeamOnboardingTokensRepository } from '~/repositories/TeamOnboardingTokensRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { generateOnboardingToken, hashToken } from '~/utils/onboardingToken.js';
import { provisionNewTeam } from '~/utils/provisionNewTeam.js';
import { requireGlobalAdmin } from '~/utils/requireGlobalAdmin.js';

const forbidden = new OnboardingApi.OnboardingForbidden();

const ttlToDuration = (
  ttl: OnboardingApi.CreateOnboardingTokenRequest['ttl'],
): Parameters<typeof DateTime.add>[1] => {
  switch (ttl) {
    case '24h':
      return { hours: 24 };
    case '72h':
      return { hours: 72 };
    case '7d':
      return { days: 7 };
  }
};

/**
 * Validates the token state and returns typed errors for each bad state.
 * Returns the token unchanged on success.
 */
const validateTokenState = (
  token: TeamOnboardingToken.TeamOnboardingToken,
  now: DateTime.Utc,
): Effect.Effect<
  TeamOnboardingToken.TeamOnboardingToken,
  | OnboardingApi.OnboardingTokenAlreadyConsumed
  | OnboardingApi.OnboardingTokenRevoked
  | OnboardingApi.OnboardingTokenExpired
> => {
  if (Option.isSome(token.consumed_at)) {
    return Effect.fail(new OnboardingApi.OnboardingTokenAlreadyConsumed());
  }
  if (Option.isSome(token.revoked_at)) {
    return Effect.fail(new OnboardingApi.OnboardingTokenRevoked());
  }
  if (DateTime.isLessThanOrEqualTo(token.expires_at, now)) {
    return Effect.fail(new OnboardingApi.OnboardingTokenExpired());
  }
  return Effect.succeed(token);
};

export const OnboardingApiLive = HttpApiBuilder.group(Api, 'onboarding', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('tokens', () => TeamOnboardingTokensRepository.asEffect()),
    Effect.bind('teams', () => TeamsRepository.asEffect()),
    Effect.map(({ tokens, teams }) =>
      handlers
        .handle('mintOnboardingToken', ({ payload }) =>
          Effect.Do.pipe(
            Effect.tap(() => requireGlobalAdmin(forbidden)),
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('generated', () => generateOnboardingToken()),
            Effect.bind('now', () => DateTime.now),
            Effect.let('expiresAt', ({ now }) =>
              DateTime.toDateUtc(DateTime.add(now, ttlToDuration(payload.ttl))),
            ),
            Effect.bind('token', ({ generated, currentUser, expiresAt }) =>
              tokens.create({
                token_hash: generated.hash,
                proposed_name: payload.proposedName,
                bound_discord_id: payload.boundDiscordId,
                created_by: currentUser.id,
                expires_at: expiresAt,
              }),
            ),
            Effect.tap(({ token }) =>
              Effect.logInfo('team_onboarding.token_minted', {
                tokenId: token.id,
                proposedName: token.proposed_name,
                boundDiscordId: token.bound_discord_id,
              }),
            ),
            Effect.map(({ generated, token }) => ({
              plaintextToken: generated.token,
              onboardingUrl: `${env.FRONTEND_URL.toString().replace(/\/$/, '')}/onboarding/${generated.token}`,
              expiresAt: token.expires_at,
            })),
          ),
        )
        .handle('listOnboardingTokens', () =>
          Effect.Do.pipe(
            Effect.tap(() => requireGlobalAdmin(forbidden)),
            Effect.flatMap(() => tokens.listForAdmin()),
          ),
        )
        .handle('revokeOnboardingToken', ({ params: { tokenId } }) =>
          Effect.Do.pipe(
            Effect.tap(() => requireGlobalAdmin(forbidden)),
            Effect.tap(() => tokens.revoke(tokenId)),
            Effect.tap(() => Effect.logInfo('team_onboarding.token_revoked', { tokenId })),
            Effect.asVoid,
          ),
        )
        .handle('previewOnboardingToken', ({ params: { plaintextToken } }) =>
          Effect.Do.pipe(
            Effect.let('hash', () => hashToken(plaintextToken)),
            Effect.bind('token', ({ hash }) =>
              tokens
                .findByHash(hash)
                .pipe(
                  Effect.flatMap(
                    Options.toEffect(() => new OnboardingApi.OnboardingTokenNotFound()),
                  ),
                ),
            ),
            Effect.bind('now', () => DateTime.now),
            Effect.bind('validToken', ({ token, now }) => validateTokenState(token, now)),
            Effect.map(({ validToken }) => ({
              proposedName: validToken.proposed_name,
              boundDiscordId: validToken.bound_discord_id,
              expiresAt: validToken.expires_at,
            })),
          ),
        )
        .handle('completeOnboarding', ({ params: { plaintextToken }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.let('hash', () => hashToken(plaintextToken)),
            Effect.bind('token', ({ hash }) =>
              tokens
                .findByHash(hash)
                .pipe(
                  Effect.flatMap(
                    Options.toEffect(() => new OnboardingApi.OnboardingTokenNotFound()),
                  ),
                ),
            ),
            Effect.bind('now', () => DateTime.now),
            Effect.bind('validToken', ({ token, now }) => validateTokenState(token, now)),
            Effect.tap(({ validToken, currentUser }) =>
              validToken.bound_discord_id === currentUser.discordId
                ? Effect.void
                : Effect.logInfo('team_onboarding.wrong_captain_attempt', {
                    tokenId: validToken.id,
                    expectedDiscordId: validToken.bound_discord_id,
                    actualDiscordId: currentUser.discordId,
                  }).pipe(
                    Effect.flatMap(() => Effect.fail(new OnboardingApi.OnboardingWrongCaptain())),
                  ),
            ),
            Effect.tap(() =>
              teams.findByGuildId(payload.guildId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.void,
                    onSome: () => Effect.fail(new OnboardingApi.OnboardingGuildAlreadyClaimed()),
                  }),
                ),
              ),
            ),
            Effect.bind('userTeam', ({ currentUser, validToken }) =>
              provisionNewTeam({
                payload: {
                  name: payload.name,
                  guildId: payload.guildId,
                  description: payload.description,
                  sport: payload.sport,
                  logoUrl: payload.logoUrl,
                  welcomeChannelId: payload.welcomeChannelId,
                  systemLogChannelId: payload.systemLogChannelId,
                  onboardingLocale: payload.onboardingLocale,
                },
                currentUserId: currentUser.id,
                markConsumed: (teamId) =>
                  tokens.markConsumed(validToken.id, {
                    consumed_by: currentUser.id,
                    resulting_team_id: teamId,
                  }),
              }).pipe(
                SqlErrors.catchUniqueViolation(
                  () => new OnboardingApi.OnboardingGuildAlreadyClaimed(),
                ),
                Effect.catchTag(
                  'MemberAlreadyExistsError',
                  LogicError.withMessage(
                    () => 'MemberAlreadyExistsError during onboarding — unexpected state',
                  ),
                ),
              ),
            ),
            Effect.tap(({ validToken, userTeam, currentUser }) =>
              Effect.logInfo('team_onboarding.token_consumed', {
                tokenId: validToken.id,
                teamId: userTeam.teamId,
                userId: currentUser.id,
              }),
            ),
            Effect.map(({ userTeam }) => userTeam),
          ),
        ),
    ),
  ),
);
