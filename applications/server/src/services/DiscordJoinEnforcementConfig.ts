import { Effect, Layer, ServiceMap } from 'effect';
import { discordJoinEnforcementEnabled } from '~/env.js';

/**
 * Blocker D (whole-series review of `fix/discord-onboarding-webapp`) — wraps the
 * `DISCORD_JOIN_ENFORCEMENT_ENABLED` env flag as a service (mirrors `GlobalAdminAllowlist`) so
 * `auth.myTeams` can be overridden in tests without touching `process.env`. `false` (the
 * default) is the kill switch engaged: `auth.myTeams` forces `discordJoined` to `'unknown'` for
 * every team, instantly removing the redirect, the card, and the badge on the client.
 */
export interface DiscordJoinEnforcementConfigShape {
  readonly asEffect: Effect.Effect<boolean>;
}

export class DiscordJoinEnforcementConfig extends ServiceMap.Service<
  DiscordJoinEnforcementConfig,
  DiscordJoinEnforcementConfigShape
>()('api/DiscordJoinEnforcementConfig') {
  static readonly Default = Layer.sync(DiscordJoinEnforcementConfig, () => ({
    asEffect: Effect.succeed(discordJoinEnforcementEnabled),
  }));
}
