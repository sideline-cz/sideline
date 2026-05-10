import { Discord, Team } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import type { UpdateGuildOnboardingRequest as DfxUpdateGuildOnboardingRequest } from 'dfx/DiscordREST/Generated';
import { Array, Effect, Metric, Option, Schema, type ServiceMap } from 'effect';
import { OnboardingRoleCache } from '../../services/OnboardingRoleCache.js';
import { SyncRpc, type SyncRpcClient } from '../../services/SyncRpc.js';
import { classifyOnboardingError } from './errorClassifier.js';
import type {
  OnboardingTeamView,
  RulesPromptStrings,
  WelcomeScreenStrings,
} from './payloadBuilders.js';
import { buildWelcomeScreenPayload, mergeOnboardingPayload } from './payloadBuilders.js';

const onboardingSyncTotal = Metric.counter('onboarding_sync_total', {
  description: 'Total onboarding sync operations',
  incremental: true,
});

const resolveStrings = (
  locale: 'en' | 'cs',
  teamName: string,
): { welcome: WelcomeScreenStrings; rulesPrompt: RulesPromptStrings } => {
  const opts = { locale };
  return {
    welcome: {
      description: m.bot_onboarding_welcomeScreen_description({ teamName }, opts),
      channels_rules: m.bot_onboarding_welcomeScreen_channels_rules({}, opts),
      channels_welcome: m.bot_onboarding_welcomeScreen_channels_welcome({}, opts),
      channels_training: m.bot_onboarding_welcomeScreen_channels_training({}, opts),
    },
    rulesPrompt: {
      title: m.bot_onboarding_rulesPrompt_title({}, opts),
      optionTitle: m.bot_onboarding_rulesPrompt_option_title({}, opts),
      optionDescription: m.bot_onboarding_rulesPrompt_option_description({}, opts),
    },
  };
};

const decodeSnowflake = Schema.decodeSync(Discord.Snowflake);

const findNewPromptId = (response: unknown, roleId: string): Option.Option<Discord.Snowflake> => {
  if (response === null || typeof response !== 'object' || !('prompts' in response)) {
    return Option.none();
  }
  const prompts = (response as { prompts?: ReadonlyArray<unknown> }).prompts ?? [];
  for (const promptUnknown of prompts) {
    if (promptUnknown === null || typeof promptUnknown !== 'object') continue;
    const prompt = promptUnknown as {
      id?: string;
      options?: ReadonlyArray<{ role_ids?: ReadonlyArray<string> }>;
    };
    const options = prompt.options ?? [];
    for (const opt of options) {
      if ((opt.role_ids ?? []).includes(roleId)) {
        return prompt.id !== undefined ? Option.some(decodeSnowflake(prompt.id)) : Option.none();
      }
    }
  }
  return Option.none();
};

const isStalePromptIdError = (error: unknown, promptId: string): boolean => {
  if (error === null || typeof error !== 'object' || !('_tag' in error)) return false;
  if ((error as { _tag: unknown })._tag !== 'ErrorResponse') return false;
  const errors = (error as { errors?: unknown }).errors ?? {};
  const serialized = JSON.stringify(errors);
  return serialized.includes('"id"') && serialized.includes(promptId);
};

const getErrorTag = (error: unknown): string | undefined => {
  if (error !== null && typeof error === 'object' && '_tag' in error) {
    const tag = (error as { _tag?: unknown })._tag;
    return typeof tag === 'string' ? tag : undefined;
  }
  return undefined;
};

const getErrorCode = (error: unknown): number | undefined => {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
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
    const storedPromptId = Option.getOrUndefined(team.onboarding_rules_prompt_id);

    const syncDiscord = discord.getGuildsOnboarding(team.guild_id).pipe(
      Effect.flatMap((current) => {
        const { merged } = mergeOnboardingPayload(current, team, strings.rulesPrompt);
        return discord
          .putGuildsOnboarding(team.guild_id, merged as DfxUpdateGuildOnboardingRequest)
          .pipe(
            Effect.catch((putError) => {
              if (storedPromptId === undefined) return Effect.fail(putError);
              const classified = classifyOnboardingError(putError, team);
              if (classified.code !== 'discord_error') return Effect.fail(putError);
              if (
                getErrorTag(putError) === 'ErrorResponse' &&
                getErrorCode(putError) === 50035 &&
                isStalePromptIdError(putError, storedPromptId)
              ) {
                const strippedTeam = { ...team, onboarding_rules_prompt_id: Option.none<string>() };
                const { merged: retryMerged } = mergeOnboardingPayload(
                  current,
                  strippedTeam,
                  strings.rulesPrompt,
                );
                return discord.putGuildsOnboarding(
                  team.guild_id,
                  retryMerged as DfxUpdateGuildOnboardingRequest,
                );
              }
              return Effect.fail(putError);
            }),
          );
      }),
      Effect.flatMap((putResponse) => {
        const newPromptId = Option.isSome(team.onboarding_rules_role_id)
          ? findNewPromptId(putResponse, team.onboarding_rules_role_id.value)
          : Option.none<Discord.Snowflake>();

        return Option.isNone(welcomePayload)
          ? Effect.succeed(newPromptId)
          : discord
              .updateGuildWelcomeScreen(team.guild_id, welcomePayload.value)
              .pipe(Effect.as(newPromptId));
      }),
      Effect.flatMap((newPromptId) =>
        rpc['Guild/MarkOnboardingSyncDone']({ team_id: teamId, prompt_id: newPromptId }).pipe(
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
    );

    return syncDiscord.pipe(
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
