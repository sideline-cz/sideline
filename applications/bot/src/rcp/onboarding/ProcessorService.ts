import { type Discord, Team } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, Effect, Metric, Option, Schema, type ServiceMap } from 'effect';
import { OnboardingRoleCache } from '../../services/OnboardingRoleCache.js';
import { SyncRpc, type SyncRpcClient } from '../../services/SyncRpc.js';
import { classifyOnboardingError } from './errorClassifier.js';
import type { OnboardingTeamView, WelcomeScreenStrings } from './payloadBuilders.js';
import { buildWelcomeScreenPayload } from './payloadBuilders.js';

const onboardingSyncTotal = Metric.counter('onboarding_sync_total', {
  description: 'Total onboarding sync operations',
  incremental: true,
});

const resolveStrings = (
  locale: 'en' | 'cs',
  teamName: string,
): { welcome: WelcomeScreenStrings } => {
  const opts = { locale };
  return {
    welcome: {
      description: m.bot_onboarding_welcomeScreen_description({ teamName }, opts),
      channels_rules: m.bot_onboarding_welcomeScreen_channels_rules({}, opts),
      channels_welcome: m.bot_onboarding_welcomeScreen_channels_welcome({}, opts),
      channels_training: m.bot_onboarding_welcomeScreen_channels_training({}, opts),
    },
  };
};

const makeProcessTeam =
  (
    rpc: SyncRpcClient,
    discord: ServiceMap.Service.Shape<typeof DiscordREST>,
    cache: { invalidate: (guildId: string) => Effect.Effect<void> },
  ) =>
  (team: OnboardingTeamView): Effect.Effect<void> => {
    const teamId = Schema.decodeSync(Team.TeamId)(team.team_id);
    if (!team.is_community_enabled) {
      return rpc['Guild/MarkOnboardingSyncSkipped']({ team_id: teamId }).pipe(
        Effect.tap(() => cache.invalidate(team.guild_id)),
        Effect.tap(() =>
          Metric.update(
            Metric.withAttributes(onboardingSyncTotal, { status: 'skipped_no_community' }),
            1,
          ),
        ),
        Effect.catchTag('RpcClientError', (error) =>
          Effect.logWarning(`MarkOnboardingSyncSkipped failed for team ${team.team_id}`, error),
        ),
        Effect.asVoid,
      );
    }

    const strings = resolveStrings(team.onboarding_locale, team.team_name);
    const welcomePayload = buildWelcomeScreenPayload(team, strings.welcome);

    const syncDiscord = Option.isNone(welcomePayload)
      ? Effect.succeed(Option.none<Discord.Snowflake>())
      : discord
          .updateGuildWelcomeScreen(team.guild_id, welcomePayload.value)
          .pipe(Effect.as(Option.none<Discord.Snowflake>()));

    return syncDiscord.pipe(
      Effect.flatMap(() =>
        rpc['Guild/MarkOnboardingSyncDone']({
          team_id: teamId,
          prompt_id: Option.none<Discord.Snowflake>(),
        }).pipe(
          Effect.flatMap(({ updated }) => {
            if (!updated) {
              return Effect.logInfo(
                `Onboarding sync row already updated for team ${team.team_id}, skipping`,
              );
            }
            return cache
              .invalidate(team.guild_id)
              .pipe(
                Effect.tap(() =>
                  Metric.update(
                    Metric.withAttributes(onboardingSyncTotal, { status: 'success' }),
                    1,
                  ),
                ),
              );
          }),
        ),
      ),
      Effect.catch((error) => {
        const classified = classifyOnboardingError(error, team);
        return cache.invalidate(team.guild_id).pipe(
          Effect.flatMap(() =>
            rpc['Guild/MarkOnboardingSyncFailed']({
              team_id: teamId,
              error_code: classified.code,
              error_detail: classified.detail,
            }),
          ),
          Effect.tap(() =>
            Effect.logWarning(`Onboarding sync failed for team ${team.team_id}`, error),
          ),
          Effect.tap(() =>
            Metric.update(Metric.withAttributes(onboardingSyncTotal, { status: 'failed' }), 1),
          ),
          Effect.catchTag('RpcClientError', (e) =>
            Effect.logError(`MarkOnboardingSyncFailed RPC failed for team ${team.team_id}`, e),
          ),
          Effect.asVoid,
        );
      }),
    );
  };

export const ProcessorService = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.bind('cache', () => OnboardingRoleCache.asEffect()),
  Effect.let('processTeam', ({ rpc, discord, cache }) => makeProcessTeam(rpc, discord, cache)),
  Effect.tap(() => Effect.logInfo('OnboardingSyncService initialized')),
  Effect.let('processTick', ({ rpc, processTeam }) =>
    rpc['Guild/PendingOnboardingSyncs']({ limit: 20 }).pipe(
      Effect.tap((teams) => Effect.logDebug(`Onboarding sync poll: ${teams.length} team(s)`)),
      Effect.flatMap((teams) =>
        teams.length === 0
          ? Effect.void
          : Effect.all(Array.map(teams, processTeam), { concurrency: 1 }).pipe(
              Effect.tap(() => Effect.logInfo(`Processed ${teams.length} onboarding sync team(s)`)),
              Effect.asVoid,
            ),
      ),
      Effect.tapError((error) => Effect.logError('Error polling onboarding sync teams', error)),
      Effect.catchTag('RpcClientError', (error) =>
        Effect.logError('Unhandled error in onboarding sync poll', error),
      ),
    ),
  ),
  Bind.remove('rpc'),
  Bind.remove('processTeam'),
  Bind.remove('cache'),
);
