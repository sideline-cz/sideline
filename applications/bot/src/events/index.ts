import { Discord } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import { DiscordREST } from 'dfx/DiscordREST';
import { DiscordGateway } from 'dfx/gateway';
import * as DiscordTypes from 'dfx/types';
import { Array as Arr, Effect, Metric, Option, Schema } from 'effect';
import { buildVerifyButton } from '~/interactions/profile-verify.js';
import type { Locale } from '~/locale.js';
import { discordEventsTotal } from '~/metrics.js';
import { ensureVerificationChannel } from '~/rest/channels/ensureVerificationChannel.js';
import { ensureUnverifiedRole, findUnverifiedRole } from '~/rest/roles/ensureUnverifiedRole.js';
import { DfxSyncableChannel, DfxUser } from '~/schemas.js';
import { InviteCache } from '~/services/InviteCache.js';
import { OnboardingRoleCache } from '~/services/OnboardingRoleCache.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { VerificationChannelCache } from '~/services/VerificationChannelCache.js';
import { buildSystemLogEmbed, buildWelcomeEmbed } from '~/services/welcomeRenderer.js';
import { handleGuildCreate } from './guildCreate.js';
import { handleGuildMemberUpdate } from './guildMemberUpdate.js';
import { handleGuildRoleCreate } from './guildRoleCreate.js';
import { handleGuildRoleDelete } from './guildRoleDelete.js';
import { handleGuildRoleUpdate } from './guildRoleUpdate.js';
import { handleReady } from './ready.js';

const decodeSnowflake = Schema.decodeSync(Discord.Snowflake);
const decodeSyncableChannel = Schema.decodeUnknownOption(DfxSyncableChannel);
const decodeUser = Schema.decodeUnknownSync(DfxUser);

const DEFAULT_WELCOME_COLOR = 0x5865f2;

export const eventHandlers = Effect.Do.pipe(
  Effect.bind('gateway', () => DiscordGateway.asEffect()),
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('rest', () => DiscordREST.asEffect()),
  Effect.bind('inviteCache', () => InviteCache.asEffect()),
  Effect.bind('onboardingRoleCache', () => OnboardingRoleCache.asEffect()),
  Effect.let('ready', ({ gateway }) =>
    gateway.handleDispatch(DiscordTypes.GatewayDispatchEvents.Ready, () =>
      handleReady().pipe(Effect.withSpan('discord/ready')),
    ),
  ),
  Effect.let('guildCreate', ({ gateway, rest, inviteCache }) =>
    gateway.handleDispatch(DiscordTypes.GatewayDispatchEvents.GuildCreate, (guild) => {
      // Seed InviteCache with existing invites so diffOnMemberJoin has a baseline.
      // Without this, the first member who joins after bot startup never matches
      // their invite code, and the welcome message never fires.
      const seedInvites = rest.listGuildInvites(guild.id).pipe(
        Effect.map((invites) =>
          Arr.getSomes(
            Arr.map(invites, (i) =>
              i !== null && i.type === 0
                ? Option.some({ code: i.code, uses: i.uses ?? 0 })
                : Option.none(),
            ),
          ),
        ),
        Effect.tap((seeded) =>
          Effect.all(
            Arr.map(seeded, (s) => inviteCache.upsert(guild.id, s.code, s.uses)),
            { concurrency: 'unbounded', discard: true },
          ),
        ),
        Effect.tap((seeded) =>
          Effect.logInfo(
            `Seeded InviteCache for guild ${guild.id} with ${seeded.length} invite(s)`,
          ),
        ),
        Effect.asVoid,
        Effect.catchTags({
          HttpClientError: (e) =>
            Effect.logWarning(`Failed to seed InviteCache for guild ${guild.id}`, e),
          RatelimitedResponse: (e) =>
            Effect.logWarning(`Rate-limited seeding InviteCache for guild ${guild.id}`, e),
          ErrorResponse: (e) =>
            Effect.logWarning(`Error seeding InviteCache for guild ${guild.id}`, e),
        }),
      );

      return Effect.Do.pipe(
        Effect.tap(() =>
          Metric.update(
            Metric.withAttributes(discordEventsTotal, { event_type: 'guild_create' }),
            1,
          ),
        ),
        Effect.tap(() => Effect.logInfo(`Guild available: ${guild.name} (${guild.id})`)),
        Effect.tap(() => handleGuildCreate(guild)),
        Effect.tap(() => seedInvites),
        Effect.withSpan('discord/guild_create', { attributes: { 'guild.id': guild.id } }),
      );
    }),
  ),
  Effect.let('guildDelete', ({ gateway, rpc }) =>
    gateway.handleDispatch(DiscordTypes.GatewayDispatchEvents.GuildDelete, (guild) =>
      guild.unavailable
        ? Effect.logInfo(`Guild unavailable (outage): ${guild.id}`)
        : Effect.Do.pipe(
            Effect.tap(() =>
              Metric.update(
                Metric.withAttributes(discordEventsTotal, { event_type: 'guild_delete' }),
                1,
              ),
            ),
            Effect.tap(() => Effect.logInfo(`Guild removed: ${guild.id}`)),
            Effect.tap(() =>
              rpc['Guild/UnregisterGuild']({
                guild_id: decodeSnowflake(guild.id),
              }),
            ),
            Effect.catchTag('RpcClientError', (error) =>
              Effect.logError(`Failed to unregister guild ${guild.id}`, error),
            ),
            Effect.withSpan('discord/guild_delete', { attributes: { 'guild.id': guild.id } }),
          ),
    ),
  ),
  Effect.let('inviteCreate', ({ gateway, inviteCache }) =>
    gateway.handleDispatch(
      DiscordTypes.GatewayDispatchEvents.InviteCreate,
      ({ guild_id, code, uses }) =>
        guild_id === undefined ? Effect.void : inviteCache.upsert(guild_id, code, uses ?? 0),
    ),
  ),
  Effect.let('inviteDelete', ({ gateway, inviteCache }) =>
    gateway.handleDispatch(DiscordTypes.GatewayDispatchEvents.InviteDelete, ({ guild_id, code }) =>
      guild_id === undefined ? Effect.void : inviteCache.remove(guild_id, code),
    ),
  ),
  Effect.let('guildMemberAdd', ({ gateway, rpc, rest, inviteCache }) =>
    gateway.handleDispatch(DiscordTypes.GatewayDispatchEvents.GuildMemberAdd, (member) => {
      const user = decodeUser(member.user);
      const memberDisplayName =
        member.nick ?? Option.getOrElse(user.global_name, () => user.username);

      const fetchInviteUsage = rest.listGuildInvites(member.guild_id).pipe(
        Effect.map((invites) =>
          Arr.getSomes(
            Arr.map(invites, (i) =>
              i !== null && i.type === 0
                ? Option.some({ code: i.code, uses: i.uses ?? 0 })
                : Option.none(),
            ),
          ),
        ),
        Effect.tapError((e) => Effect.logWarning('listGuildInvites failed', e)),
        Effect.catchTags({
          HttpClientError: () => Effect.succeed<ReadonlyArray<{ code: string; uses: number }>>([]),
          RatelimitedResponse: () =>
            Effect.succeed<ReadonlyArray<{ code: string; uses: number }>>([]),
          ErrorResponse: () => Effect.succeed<ReadonlyArray<{ code: string; uses: number }>>([]),
        }),
      );

      const sendSystemLog = (
        systemChannelId: Discord.Snowflake,
        meta: {
          readonly invite_code: Option.Option<string>;
          readonly welcome: Option.Option<{
            readonly inviter_discord_id: Option.Option<Discord.Snowflake>;
            readonly group_name: Option.Option<string>;
          }>;
        },
      ) =>
        rest
          .createMessage(systemChannelId, {
            embeds: [
              buildSystemLogEmbed({
                username: user.username,
                memberId: user.id,
                inviteCode: meta.invite_code,
                inviterId: Option.flatMap(meta.welcome, (w) => w.inviter_discord_id),
                groupName: Option.flatMap(meta.welcome, (w) => w.group_name),
              }),
            ],
            allowed_mentions: { parse: [] },
          })
          .pipe(
            Effect.asVoid,
            Effect.catchTags({
              HttpClientError: (e) => Effect.logWarning('Failed to send system log message', e),
              RatelimitedResponse: (e) =>
                Effect.logWarning('Rate-limited sending system log message', e),
              ErrorResponse: (e) => Effect.logWarning('Error sending system log message', e),
            }),
          );

      // Task 9: `verifyLocale` is `Some(locale)` exactly when the member should see the
      // verify field + button on THIS SAME welcome message (gate on, profile incomplete)
      // — `None` means unchanged behaviour (gate off, or already complete). One message,
      // one ping, never a second bot message chasing someone who just walked in.
      const sendWelcome = (
        welcomeChannelId: Discord.Snowflake,
        rendered: string,
        welcome: {
          readonly group_name: Option.Option<string>;
          readonly group_color_int: Option.Option<number>;
          readonly inviter_discord_id: Option.Option<Discord.Snowflake>;
        },
        verifyLocale: Option.Option<Locale>,
      ) => {
        const baseEmbed = buildWelcomeEmbed({
          rendered,
          groupName: welcome.group_name,
          colorInt: Option.getOrElse(welcome.group_color_int, () => DEFAULT_WELCOME_COLOR),
          memberDisplayName,
          locale: Option.getOrElse(verifyLocale, () => 'en' as const),
        });
        const embed = Option.match(verifyLocale, {
          onNone: () => baseEmbed,
          onSome: (locale) => ({
            ...baseEmbed,
            fields: [
              ...(baseEmbed.fields ?? []),
              {
                name: m.bot_verify_welcome_field_name({}, { locale }),
                value: m.bot_verify_welcome_field_value({}, { locale }),
                inline: false,
              },
            ],
          }),
        });

        return rest
          .createMessage(welcomeChannelId, {
            content: `<@${user.id}>`,
            embeds: [embed],
            ...(Option.isSome(verifyLocale)
              ? { components: [UI.row([buildVerifyButton(verifyLocale.value)])] }
              : {}),
            allowed_mentions: {
              parse: [],
              users: [user.id, ...Option.toArray(welcome.inviter_discord_id)],
            },
          })
          .pipe(
            Effect.asVoid,
            Effect.catchTags({
              HttpClientError: (e) => Effect.logWarning('Failed to send welcome message', e),
              RatelimitedResponse: (e) =>
                Effect.logWarning('Rate-limited sending welcome message', e),
              ErrorResponse: (e) => Effect.logWarning('Error sending welcome message', e),
            }),
          );
      };

      // Task 10: grant on join when the gate is on and the profile is incomplete;
      // revoke when the gate is on and the profile is complete — evaluated on EVERY
      // `guildMemberAdd`, not just on modal-submit success, so a member who finished
      // their profile on the web (`api/auth.ts`, the second `completeProfile` writer)
      // self-heals on their next join. Both directions are idempotent Discord no-ops
      // when already in the target state. A permission failure logs a warning and
      // lets the join resolve — it must never fail the member's join over a cosmetic
      // role/channel.
      const grantUnverified = (
        guildId: Discord.Snowflake,
        discordUserId: Discord.Snowflake,
        verifyLocale: Locale,
      ) =>
        VerificationChannelCache.asEffect().pipe(
          Effect.flatMap((verificationChannelCache) =>
            verificationChannelCache.get(guildId).pipe(
              Effect.flatMap((cached) =>
                Option.match(cached, {
                  onSome: (entry) => Effect.succeed(Discord.Snowflake.makeUnsafe(entry.roleId)),
                  onNone: () => ensureUnverifiedRole(guildId),
                }).pipe(
                  Effect.tap((roleId) => rest.addGuildMemberRole(guildId, discordUserId, roleId)),
                  Effect.tap((roleId) =>
                    Option.isSome(cached)
                      ? Effect.void
                      : ensureVerificationChannel(guildId, roleId, verifyLocale).pipe(
                          Effect.flatMap((channelIdOption) =>
                            Option.match(channelIdOption, {
                              onNone: () => Effect.void,
                              onSome: (channelId) =>
                                verificationChannelCache.set(guildId, { roleId, channelId }),
                            }),
                          ),
                          Effect.catchCause((cause) =>
                            Effect.logWarning(
                              `Failed to ensure the verification channel in guild ${guildId}`,
                              cause,
                            ),
                          ),
                        ),
                  ),
                ),
              ),
            ),
          ),
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning(`Failed to grant the unverified role in guild ${guildId}`, cause),
          ),
        );

      const revokeUnverified = (guildId: Discord.Snowflake, discordUserId: Discord.Snowflake) =>
        findUnverifiedRole(guildId).pipe(
          Effect.flatMap((roleIdOption) =>
            Option.match(roleIdOption, {
              onNone: () => Effect.void,
              onSome: (roleId) =>
                rest.deleteGuildMemberRole(guildId, discordUserId, roleId).pipe(Effect.asVoid),
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning(`Failed to revoke the unverified role in guild ${guildId}`, cause),
          ),
        );

      const handleWelcomeMeta = (meta: {
        readonly system_log_channel_id: Option.Option<Discord.Snowflake>;
        readonly invite_code: Option.Option<string>;
        readonly welcome: Option.Option<{
          readonly welcome_channel_id: Option.Option<Discord.Snowflake>;
          readonly welcome_message_rendered: Option.Option<string>;
          readonly group_name: Option.Option<string>;
          readonly group_color_int: Option.Option<number>;
          readonly inviter_discord_id: Option.Option<Discord.Snowflake>;
        }>;
        readonly profile_complete: boolean;
        readonly profile_gate_enabled: boolean;
        readonly verify_locale: Locale;
      }) => {
        const systemLog = Option.match(meta.system_log_channel_id, {
          onNone: () => Effect.void,
          onSome: (channelId) => sendSystemLog(channelId, meta),
        });

        // Task 9: only the cohort with a welcome embed gets the field + button
        // added to it. The plain-invite cohort (welcome: None) gets NOTHING extra
        // here — Task 10's pinned channel card is their surface, and Task 8's
        // blocked-action ephemeral is the universal safety net. Posting a
        // per-member message into the verify channel would turn one clean pinned
        // card into a scroll of identical bot spam.
        const showVerifyPrompt = meta.profile_gate_enabled && !meta.profile_complete;
        const welcomeMessage = Option.match(
          Option.all([
            Option.flatMap(meta.welcome, (w) => w.welcome_channel_id),
            Option.flatMap(meta.welcome, (w) => w.welcome_message_rendered),
            meta.welcome,
          ]),
          {
            onNone: () => Effect.void,
            onSome: ([channelId, rendered, welcome]) =>
              sendWelcome(
                channelId,
                rendered,
                welcome,
                showVerifyPrompt ? Option.some(meta.verify_locale) : Option.none(),
              ),
          },
        );

        // Task 10: independent of whether a welcome message was sent at all — this is
        // exactly the catch-all for the plain-invite cohort that gets `welcome: None`.
        const verificationState = !meta.profile_gate_enabled
          ? Effect.void
          : meta.profile_complete
            ? revokeUnverified(decodeSnowflake(member.guild_id), user.id)
            : grantUnverified(decodeSnowflake(member.guild_id), user.id, meta.verify_locale);

        return Effect.all([systemLog, welcomeMessage, verificationState], {
          concurrency: 'unbounded',
        }).pipe(Effect.asVoid);
      };

      const registerAndWelcome = Effect.Do.pipe(
        Effect.bind('invites', () => fetchInviteUsage),
        Effect.bind('matchedCode', ({ invites }) =>
          inviteCache.diffOnMemberJoin(member.guild_id, invites),
        ),
        Effect.tap(({ invites, matchedCode }) =>
          Effect.logInfo(
            `Invite match for ${user.username} in ${member.guild_id}: ${Option.match(matchedCode, {
              onNone: () => 'no match',
              onSome: (c) => `matched ${c}`,
            })} (${invites.length} invite(s) seen)`,
          ),
        ),
        Effect.bind('welcomeMeta', ({ matchedCode }) =>
          rpc['Guild/RegisterMember']({
            guild_id: decodeSnowflake(member.guild_id),
            discord_id: user.id,
            username: user.username,
            avatar: user.avatar,
            roles: Arr.map(member.roles, (r) => decodeSnowflake(r)),
            nickname: Option.fromNullishOr(member.nick ?? null),
            display_name: user.global_name,
            invite_code: matchedCode,
            // PR-8 (CC-10, blocker 7): a real-time GuildMemberAdd dispatch is an unambiguous,
            // complete observation — never omit this key on this call site.
            source: Option.some('member_add'),
          }),
        ),
        Effect.tap(({ welcomeMeta }) =>
          Option.match(welcomeMeta, {
            onNone: () => Effect.void,
            onSome: handleWelcomeMeta,
          }),
        ),
      );

      return Effect.Do.pipe(
        Effect.tap(() =>
          Metric.update(
            Metric.withAttributes(discordEventsTotal, { event_type: 'guild_member_add' }),
            1,
          ),
        ),
        Effect.tap(() =>
          Effect.logInfo(`Member joined: ${user.username} in guild ${member.guild_id}`),
        ),
        Effect.tap(() => (user.bot ? Effect.logInfo('Skipping bot') : registerAndWelcome)),
        Effect.catchTag('RpcClientError', (error) =>
          Effect.logError(`Failed to register member ${user.username}`, error),
        ),
        Effect.withSpan('discord/guild_member_add', {
          attributes: { 'guild.id': member.guild_id },
        }),
      );
    }),
  ),
  Effect.let('guildMemberRemove', ({ gateway, rpc }) =>
    gateway.handleDispatch(DiscordTypes.GatewayDispatchEvents.GuildMemberRemove, (member) =>
      Effect.Do.pipe(
        Effect.bind('decoded', () =>
          Schema.decodeEffect(Schema.Struct({ user: DfxUser, guild_id: Discord.Snowflake }))(
            member,
          ).pipe(
            Effect.map(Option.some),
            Effect.catchTag('SchemaError', (e) =>
              Effect.logWarning(`guild_member_remove: failed to decode member payload`, e).pipe(
                Effect.as(Option.none()),
              ),
            ),
          ),
        ),
        Effect.tap(() =>
          Metric.update(
            Metric.withAttributes(discordEventsTotal, { event_type: 'guild_member_remove' }),
            1,
          ),
        ),
        Effect.tap(({ decoded }) =>
          Option.match(decoded, {
            onNone: () => Effect.void,
            onSome: ({ user, guild_id }) =>
              Effect.logInfo(`Member left: ${user.username} from guild ${guild_id}`).pipe(
                Effect.andThen(
                  user.bot
                    ? Effect.logInfo('Skipping bot')
                    : rpc['Guild/RemoveMember']({
                        guild_id,
                        discord_id: user.id,
                      }).pipe(
                        Effect.catchTag('RpcClientError', (error) =>
                          Effect.logError(`Failed to remove member ${user.username}`, error),
                        ),
                      ),
                ),
              ),
          }),
        ),
        Effect.withSpan('discord/guild_member_remove', {
          attributes: { 'guild.id': member.guild_id },
        }),
        Effect.asVoid,
      ),
    ),
  ),
  Effect.let('guildMemberUpdate', ({ gateway }) =>
    gateway.handleDispatch(DiscordTypes.GatewayDispatchEvents.GuildMemberUpdate, (member) =>
      Effect.Do.pipe(
        Effect.tap(() =>
          Metric.update(
            Metric.withAttributes(discordEventsTotal, { event_type: 'guild_member_update' }),
            1,
          ),
        ),
        Effect.tap(() =>
          Effect.logInfo(`Member updated: ${member.user.username} in guild ${member.guild_id}`),
        ),
        Effect.tap(() => handleGuildMemberUpdate(member)),
        Effect.withSpan('discord/guild_member_update', {
          attributes: { 'guild.id': member.guild_id },
        }),
      ),
    ),
  ),
  Effect.let('guildRoleCreate', ({ gateway }) =>
    gateway.handleDispatch(DiscordTypes.GatewayDispatchEvents.GuildRoleCreate, (payload) =>
      Effect.Do.pipe(
        Effect.tap(() =>
          Metric.update(
            Metric.withAttributes(discordEventsTotal, { event_type: 'guild_role_create' }),
            1,
          ),
        ),
        Effect.tap(() => handleGuildRoleCreate(payload)),
        Effect.withSpan('discord/guild_role_create', {
          attributes: { 'guild.id': payload.guild_id },
        }),
      ),
    ),
  ),
  Effect.let('guildRoleUpdate', ({ gateway }) =>
    gateway.handleDispatch(DiscordTypes.GatewayDispatchEvents.GuildRoleUpdate, (payload) =>
      Effect.Do.pipe(
        Effect.tap(() =>
          Metric.update(
            Metric.withAttributes(discordEventsTotal, { event_type: 'guild_role_update' }),
            1,
          ),
        ),
        Effect.tap(() => handleGuildRoleUpdate(payload)),
        Effect.withSpan('discord/guild_role_update', {
          attributes: { 'guild.id': payload.guild_id },
        }),
      ),
    ),
  ),
  Effect.let('guildRoleDelete', ({ gateway }) =>
    gateway.handleDispatch(DiscordTypes.GatewayDispatchEvents.GuildRoleDelete, (payload) =>
      Effect.Do.pipe(
        Effect.tap(() =>
          Metric.update(
            Metric.withAttributes(discordEventsTotal, { event_type: 'guild_role_delete' }),
            1,
          ),
        ),
        Effect.tap(() =>
          handleGuildRoleDelete({ guild_id: payload.guild_id, role_id: payload.role_id }),
        ),
        Effect.withSpan('discord/guild_role_delete', {
          attributes: { 'guild.id': payload.guild_id },
        }),
      ),
    ),
  ),
  Effect.let('channelCreate', ({ gateway, rpc }) =>
    gateway.handleDispatch(DiscordTypes.GatewayDispatchEvents.ChannelCreate, (channel) =>
      Option.match(decodeSyncableChannel(channel), {
        onNone: () => Effect.logDebug('Skipping non-syncable channel event'),
        onSome: (decoded) =>
          Effect.Do.pipe(
            Effect.tap(() =>
              Metric.update(
                Metric.withAttributes(discordEventsTotal, { event_type: 'channel_create' }),
                1,
              ),
            ),
            Effect.tap(() =>
              Effect.logInfo(
                `Channel created: ${decoded.name} (${decoded.id}) in guild ${channel.guild_id}`,
              ),
            ),
            Effect.tap(() =>
              rpc['Guild/UpsertChannel']({
                guild_id: decodeSnowflake(channel.guild_id),
                channel_id: decoded.id,
                name: decoded.name,
                type: decoded.type,
                parent_id: decoded.parent_id,
              }),
            ),
            Effect.catchTag('RpcClientError', (error) =>
              Effect.logError(`Failed to upsert channel ${decoded.id}`, error),
            ),
            Effect.withSpan('discord/channel_create', {
              attributes: { 'guild.id': channel.guild_id },
            }),
          ),
      }),
    ),
  ),
  Effect.let('channelDelete', ({ gateway, rpc }) =>
    gateway.handleDispatch(DiscordTypes.GatewayDispatchEvents.ChannelDelete, (channel) =>
      Option.match(decodeSyncableChannel(channel), {
        onNone: () => Effect.logDebug('Skipping non-syncable channel event'),
        onSome: (decoded) =>
          Effect.Do.pipe(
            Effect.tap(() =>
              Metric.update(
                Metric.withAttributes(discordEventsTotal, { event_type: 'channel_delete' }),
                1,
              ),
            ),
            Effect.tap(() =>
              Effect.logInfo(`Channel deleted: ${decoded.id} in guild ${channel.guild_id}`),
            ),
            Effect.tap(() =>
              rpc['Guild/DeleteChannel']({
                guild_id: decodeSnowflake(channel.guild_id),
                channel_id: decoded.id,
              }),
            ),
            Effect.catchTag('RpcClientError', (error) =>
              Effect.logError(`Failed to delete channel ${decoded.id}`, error),
            ),
            Effect.withSpan('discord/channel_delete', {
              attributes: { 'guild.id': channel.guild_id },
            }),
          ),
      }),
    ),
  ),
  Effect.let('channelUpdate', ({ gateway, rpc }) =>
    gateway.handleDispatch(DiscordTypes.GatewayDispatchEvents.ChannelUpdate, (channel) =>
      Option.match(decodeSyncableChannel(channel), {
        onNone: () => Effect.logDebug('Skipping non-syncable channel event'),
        onSome: (decoded) =>
          Effect.Do.pipe(
            Effect.tap(() =>
              Metric.update(
                Metric.withAttributes(discordEventsTotal, { event_type: 'channel_update' }),
                1,
              ),
            ),
            Effect.tap(() =>
              Effect.logInfo(
                `Channel updated: ${decoded.name} (${decoded.id}) in guild ${channel.guild_id}`,
              ),
            ),
            Effect.tap(() =>
              rpc['Guild/UpsertChannel']({
                guild_id: decodeSnowflake(channel.guild_id),
                channel_id: decoded.id,
                name: decoded.name,
                type: decoded.type,
                parent_id: decoded.parent_id,
              }),
            ),
            Effect.catchTag('RpcClientError', (error) =>
              Effect.logError(`Failed to upsert channel ${decoded.id}`, error),
            ),
            Effect.withSpan('discord/channel_update', {
              attributes: { 'guild.id': channel.guild_id },
            }),
          ),
      }),
    ),
  ),
  Effect.map(
    ({
      ready,
      guildCreate,
      guildDelete,
      inviteCreate,
      inviteDelete,
      guildMemberAdd,
      guildMemberRemove,
      guildMemberUpdate,
      guildRoleCreate,
      guildRoleUpdate,
      guildRoleDelete,
      channelCreate,
      channelDelete,
      channelUpdate,
    }) => [
      ready,
      guildCreate,
      guildDelete,
      inviteCreate,
      inviteDelete,
      guildMemberAdd,
      guildMemberRemove,
      guildMemberUpdate,
      guildRoleCreate,
      guildRoleUpdate,
      guildRoleDelete,
      channelCreate,
      channelDelete,
      channelUpdate,
    ],
  ),
);
