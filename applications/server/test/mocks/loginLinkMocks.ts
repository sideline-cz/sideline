import { Effect, Layer, Option } from 'effect';
import { DiscordLoginTokensRepository } from '~/repositories/DiscordLoginTokensRepository.js';

/**
 * Stub layer for `DiscordLoginTokensRepository` — safe defaults for suites that wire
 * `ApiLive` but do not exercise the Discord `/login` link endpoint.
 *
 * `redeem` returns `None`, i.e. "that link is not valid", which is the fail-closed answer
 * and the one a suite that never issued a link should get.
 */
export const MockDiscordLoginTokensRepositoryLayer = Layer.succeed(DiscordLoginTokensRepository, {
  _tag: 'api/DiscordLoginTokensRepository',
  issue: () => Effect.die(new Error('DiscordLoginTokensRepository.issue: not implemented in stub')),
  redeem: () => Effect.succeed(Option.none()),
} as never);
