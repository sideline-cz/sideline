import { type Discord, Team } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import { DiscordREST } from 'dfx/DiscordREST';
import type { UpdateGuildOnboardingRequest as DfxUpdateGuildOnboardingRequest } from 'dfx/DiscordREST/Generated';
import { ChannelTypes, MessageComponentTypes, type MessageEmbedResponse } from 'dfx/types';
import { Array, Effect, Metric, Option, Schema, type ServiceMap } from 'effect';
import { buildVerifyButton, VERIFY_BUTTON_ID } from '~/interactions/profile-verify.js';
import { buildIntroEmbed } from '~/rest/channels/ensureVerificationChannel.js';
import { isPermanentError } from '~/rest/discordErrors.js';
import { retryPolicy } from '~/rest/utils.js';
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
    },
  };
};

/**
 * Keeps the pinned intro message in the verify channel in step with
 * `teams.verify_intro_template`. Runs on the onboarding sync loop — saving the field
 * flips the team to `pending` (server `hasOnboardingFieldChange`), so a captain's edit
 * lands within one poll tick. Deliberately NOT on the join path: `ensureVerificationChannel`
 * returns early for an existing channel, and hanging a listPins/updateMessage off a
 * `guildMemberAdd` would add join latency and a 429 storm on a cold-cache join burst.
 *
 * Requires the bot to hold Administrator to read and write inside its own
 * `@everyone`-hidden channel — the install link grants it (`permissions=8`).
 *
 * Best-effort throughout: any failure logs a warning and resolves. It must never fail the
 * onboarding sync, never reach `classifyOnboardingError`, and never block
 * `MarkOnboardingSyncDone`.
 */
const reconcileVerifyIntro = (
  discord: ServiceMap.Service.Shape<typeof DiscordREST>,
  team: OnboardingTeamView,
): Effect.Effect<void> => {
  const locale = team.onboarding_locale;
  const embed = buildIntroEmbed(locale, team.verify_intro_template);
  const sameCopy = (e: MessageEmbedResponse) =>
    e.title === embed.title &&
    e.description === embed.description &&
    e.footer?.text === embed.footer.text &&
    JSON.stringify(e.fields?.map((f) => [f.name, f.value])) ===
      JSON.stringify(embed.fields.map((f) => [f.name, f.value]));

  return Effect.Do.pipe(
    Effect.bind('channels', () =>
      discord
        .listGuildChannels(team.guild_id)
        .pipe(Effect.retry({ schedule: retryPolicy, while: (e) => !isPermanentError(e) })),
    ),
    Effect.flatMap(({ channels }) => {
      const name = m.bot_verify_channel_name({}, { locale });
      // Type check first, then read `.name`: `name` doesn't exist on every member of
      // the `listGuildChannels` response union (e.g. `PrivateChannelResponse`), so TS
      // only lets us read it once narrowed to `GUILD_TEXT`. That narrowing doubles as
      // the fix for the real hazard: a *category* named `start-here` would otherwise
      // match and every message call against it would 400.
      const channel = channels.find((c) => c.type === ChannelTypes.GUILD_TEXT && c.name === name);
      if (channel === undefined) return Effect.void; // no join yet, or the captain renamed it
      const channelId = channel.id;

      return discord.listPins(channelId, { limit: 50 }).pipe(
        Effect.retry({ schedule: retryPolicy, while: (e) => !isPermanentError(e) }),
        Effect.flatMap((pins) => {
          // Our own message. `custom_id: VERIFY_BUTTON_ID` is NOT globally unique —
          // the bot stamps it on ten other messages (rsvp, upcoming-rsvp, carpool,
          // claim, the welcome embed). The invariant that holds is narrower and
          // sufficient: the only *pinnable* profile-verify message in *this* channel
          // is the one this code posts. The channel is bot-owned and write-locked to
          // members.
          const own = pins.items.find((p) =>
            (p.message.components ?? []).some(
              (row) =>
                row.type === MessageComponentTypes.ACTION_ROW &&
                row.components.some(
                  (c) =>
                    c.type === MessageComponentTypes.BUTTON && c.custom_id === VERIFY_BUTTON_ID,
                ),
            ),
          );

          // No pin of ours: the captain deleted or merely unpinned it (they hold
          // Administrator). Post a fresh one. "No own pin" IS the idempotency guard —
          // do not replace this with an unconditional early return.
          if (own === undefined) {
            return discord
              .createMessage(channelId, {
                embeds: [embed],
                components: [UI.row([buildVerifyButton(locale)])],
              })
              .pipe(
                Effect.retry({ schedule: retryPolicy, while: (e) => !isPermanentError(e) }),
                Effect.flatMap((message) =>
                  discord.createPin(channelId, message.id).pipe(
                    Effect.retry({ schedule: retryPolicy, while: (e) => !isPermanentError(e) }),
                    // An unpinned message is invisible to the next `listPins`, so leaving one
                    // behind would repost on every subsequent template edit and stack up
                    // duplicates in the first channel a new member sees. Roll it back instead.
                    Effect.catchIf(isPermanentError, (error) =>
                      discord
                        .deleteMessage(channelId, message.id)
                        .pipe(
                          Effect.retry(retryPolicy),
                          Effect.andThen(
                            Effect.logWarning(
                              `Could not pin the verify intro message in guild ${team.guild_id}; rolled it back`,
                              error,
                            ),
                          ),
                        ),
                    ),
                  ),
                ),
                Effect.tap(() =>
                  Effect.logInfo(`Reposted the verify intro message in guild ${team.guild_id}`),
                ),
                Effect.asVoid,
              );
          }

          // Compare every copy-bearing part (title, description, fields, footer), not
          // description alone, so a future i18n edit to the HARDCODED parts propagates to
          // existing channels too — `fields` carries bot_verify_intro_unlocks_* / _why_*.
          const current = own.message.embeds[0];
          if (current !== undefined && sameCopy(current)) return Effect.void;

          // Partial edit: `components` (the verify button) is left untouched.
          return discord.updateMessage(channelId, own.message.id, { embeds: [embed] }).pipe(
            Effect.retry({ schedule: retryPolicy, while: (e) => !isPermanentError(e) }),
            Effect.tap(() =>
              Effect.logInfo(`Refreshed the verify intro message in guild ${team.guild_id}`),
            ),
            Effect.asVoid,
          );
        }),
      );
    }),
    // ponytail: first page of pins only (limit 50). A channel with >50 pins whose intro
    // is not in the first page silently skips the refresh — paginate with `before` if a
    // real guild ever hits that.
    Effect.asVoid,
    // `Effect.Effect<void>` above is a real guarantee for TYPED failures only: nothing in
    // here can reach `classifyOnboardingError` and mark the team's sync failed. Interruption
    // is not covered — it travels the same failure channel and is caught here too — so a
    // SIGTERM mid-`listPins` is logged as a reconcile failure. That is benign: the
    // surrounding fiber is still interrupted at the next yield point, so the sync does not
    // get marked done behind it. Matches the same pattern in `~/events/index.ts`.
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `Verify intro reconcile failed for guild ${team.guild_id}; continuing the onboarding sync`,
        cause,
      ),
    ),
  );
};

const makeProcessTeam =
  (
    rpc: SyncRpcClient,
    discord: ServiceMap.Service.Shape<typeof DiscordREST>,
    cache: { invalidate: (guildId: string) => Effect.Effect<void> },
  ) =>
  (team: OnboardingTeamView): Effect.Effect<void> => {
    const teamId = Schema.decodeSync(Team.TeamId)(team.team_id);

    // The verify channel is NOT a Community feature — it is created from the join path
    // (`grantUnverified` -> `ensureVerificationChannel`), gated only on
    // `profile_gate_enabled`. So its reconcile has to run BEFORE the Community
    // short-circuit below, or every non-Community guild (the default: the claim query
    // COALESCEs `is_community_enabled` to false for any guild not yet in `bot_guilds`)
    // would silently never pick up an edited `verify_intro_template`.
    if (!team.is_community_enabled) {
      return reconcileVerifyIntro(discord, team).pipe(
        Effect.flatMap(() => rpc['Guild/MarkOnboardingSyncSkipped']({ team_id: teamId })),
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

    // Always disable Discord onboarding so new members see the welcome screen instead
    // of the role-gated onboarding flow. We send only { enabled: false } — Discord
    // doesn't require the rest of the payload when disabling, and skipping the
    // prompts/channels fields avoids the validation errors those impose.
    const disableOnboarding = discord
      .putGuildsOnboarding(team.guild_id, { enabled: false } as DfxUpdateGuildOnboardingRequest)
      .pipe(
        Effect.catchTag('ErrorResponse', (error) =>
          // If Discord rejects (e.g. onboarding was never enabled or the guild lacks
          // Community), log and continue to the welcome-screen patch — the welcome
          // screen still works without the disable call.
          Effect.logWarning(
            `Disabling onboarding failed for guild ${team.guild_id}; continuing with welcome screen`,
            error,
          ),
        ),
      );

    const patchWelcomeScreen = Option.isNone(welcomePayload)
      ? Effect.void
      : discord.updateGuildWelcomeScreen(team.guild_id, welcomePayload.value).pipe(Effect.asVoid);

    // Reconcile BEFORE the welcome-screen patch. `patchWelcomeScreen` has no catch, and a
    // rejection (50035 WELCOME_CHANNEL_PERMISSIONS_REQUIRED is a real, recurring one —
    // see errorClassifier.ts) marks the row 'failed'. `claimPendingOnboardingSyncs` only
    // re-claims 'pending' rows, so anything sequenced after the patch is lost forever for
    // that team. The reconcile is the one leg that cannot fail, so it goes first.
    const syncDiscord = disableOnboarding.pipe(
      Effect.flatMap(() => reconcileVerifyIntro(discord, team)),
      Effect.flatMap(() => patchWelcomeScreen),
      Effect.as(Option.none<Discord.Snowflake>()),
    );

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
