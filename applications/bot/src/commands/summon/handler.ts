import * as m from '@sideline/i18n/messages';
import type { DiscordRestService } from 'dfx/DiscordREST';
import { DiscordREST } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Array, Effect, Metric, Option, pipe } from 'effect';
import type { Locale } from '~/locale.js';
import { userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { DISCORD_REST_ERROR_TAGS, failAsDiscordError } from '~/rest/discordErrors.js';

const THREAD_CHANNEL_TYPES = new Set<number>([
  DiscordTypes.ChannelTypes.PUBLIC_THREAD,
  DiscordTypes.ChannelTypes.PRIVATE_THREAD,
  DiscordTypes.ChannelTypes.ANNOUNCEMENT_THREAD,
]);

/** Manage Threads permission bit, required for `/summon`. Re-uses dfx's
 * `Permissions.ManageThreads` (`PermissionFlagsBits.ManageThreads = 1n << 34n`)
 * so the runtime check stays in sync with `default_member_permissions` in the
 * command definition. */
const MANAGE_THREADS = DiscordTypes.Permissions.ManageThreads;

/** Max guild members the bot will scan when expanding a role. Discord caps a
 * single `listGuildMembers` page at 1000 — beyond that, the bot would need to
 * paginate. For v1, take the single largest page and treat anything larger as
 * an edge case (the request still succeeds; only members beyond the first 1000
 * are skipped). */
const MAX_GUILD_MEMBERS_PER_LIST = 1000;

/** Concurrency for parallel `addThreadMember` calls. Discord's per-thread
 * rate limit allows roughly a handful of writes per second; 5 is conservative
 * and avoids long head-of-line blocking on large role expansions. */
const ADD_THREAD_MEMBER_CONCURRENCY = 5;

const ephemeral = (content: string) =>
  Ix.response({
    type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      flags: DiscordTypes.MessageFlags.Ephemeral,
    },
  });

const readOption = (
  options: ReadonlyArray<{ name: string }>,
  name: string,
): Option.Option<string> =>
  pipe(
    options,
    Array.findFirst((o) => o.name === name),
    Option.flatMap((o) =>
      'value' in o && o.value !== null && o.value !== undefined
        ? Option.some(String(o.value))
        : Option.none(),
    ),
  );

const expandRoleMembers = (
  rest: DiscordRestService,
  guildId: string,
  roleId: string,
): Effect.Effect<ReadonlyArray<string>, never> =>
  rest.listGuildMembers(guildId, { limit: MAX_GUILD_MEMBERS_PER_LIST }).pipe(
    Effect.map((members) =>
      members
        .filter((member) => member.roles.includes(roleId))
        .map((member) => member.user.id as string),
    ),
    Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
      Effect.logWarning('Failed to list guild members for /summon role expansion', error).pipe(
        Effect.as<ReadonlyArray<string>>([]),
      ),
    ),
  );

interface AddOutcome {
  readonly added: ReadonlyArray<string>;
  readonly permissionError: boolean;
  readonly otherError: boolean;
}

const addMembersToThread = (
  rest: DiscordRestService,
  channelId: string,
  userIds: ReadonlyArray<string>,
): Effect.Effect<AddOutcome, never> =>
  Effect.forEach(
    userIds,
    (userId) =>
      rest.addThreadMember(channelId, userId).pipe(
        Effect.map(() => ({ userId, status: 'ok' as const })),
        Effect.catchTag(DISCORD_REST_ERROR_TAGS, failAsDiscordError),
        Effect.catchTag('DiscordPermissionError', () =>
          Effect.succeed({ userId, status: 'permission' as const }),
        ),
        Effect.catchTag(['DiscordNotFoundError', 'DiscordPermanentError'], () =>
          Effect.succeed({ userId, status: 'error' as const }),
        ),
        Effect.catchTag('DiscordTransientError', (error) =>
          Effect.logWarning('Failed to add thread member', error.cause).pipe(
            Effect.as({ userId, status: 'error' as const }),
          ),
        ),
      ),
    { concurrency: ADD_THREAD_MEMBER_CONCURRENCY },
  ).pipe(
    Effect.map((results) => {
      const added: string[] = [];
      let permissionError = false;
      let otherError = false;
      for (const r of results) {
        if (r.status === 'ok') added.push(r.userId);
        else if (r.status === 'permission') permissionError = true;
        else otherError = true;
      }
      return { added, permissionError, otherError };
    }),
  );

const buildSuccessContent = ({
  locale,
  outcome,
  userId,
  roleId,
  roleMemberCount,
  roleHadNoMembers,
}: {
  locale: Locale;
  outcome: AddOutcome;
  userId: Option.Option<string>;
  roleId: Option.Option<string>;
  roleMemberCount: number;
  roleHadNoMembers: boolean;
}): string => {
  if (outcome.added.length === 0) {
    if (roleHadNoMembers && Option.isSome(roleId) && Option.isNone(userId)) {
      return m.bot_summon_role_no_members({ roleId: roleId.value }, { locale });
    }
    if (outcome.permissionError) {
      return m.bot_summon_bot_forbidden({}, { locale });
    }
    return m.bot_summon_error({}, { locale });
  }

  const userAdded =
    Option.isSome(userId) && outcome.added.includes(userId.value) ? userId : Option.none<string>();
  const roleAddCount = Option.isSome(userAdded) ? outcome.added.length - 1 : outcome.added.length;

  if (Option.isSome(userAdded) && Option.isSome(roleId) && roleAddCount > 0) {
    return m.bot_summon_success_both(
      { userId: userAdded.value, roleId: roleId.value, count: roleAddCount },
      { locale },
    );
  }
  if (Option.isSome(userAdded) && roleAddCount === 0) {
    return m.bot_summon_success_user({ userId: userAdded.value }, { locale });
  }
  if (Option.isSome(roleId) && roleAddCount > 0) {
    return m.bot_summon_success_role({ roleId: roleId.value, count: roleAddCount }, { locale });
  }
  // Fallback: user was requested but didn't land in `added` (already a member,
  // or non-permission error). Use generic error if any failure occurred,
  // otherwise the generic "added" template with whatever IDs we did land.
  if (outcome.permissionError) return m.bot_summon_bot_forbidden({}, { locale });
  if (outcome.otherError) return m.bot_summon_error({}, { locale });
  // Shouldn't happen given the branching above, but fall back gracefully.
  return Option.isSome(roleId) && roleMemberCount === 0
    ? m.bot_summon_role_no_members({ roleId: roleId.value }, { locale })
    : m.bot_summon_error({}, { locale });
};

export const summonHandler = Interaction.asEffect().pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'command' }),
      1,
    ),
  ),
  Effect.flatMap((interaction) => {
    const locale = userLocale(interaction);
    const channelId = interaction.channel_id;
    const channelType = interaction.channel?.type;
    const guildId = interaction.guild_id;

    if (channelId === undefined || channelType === undefined) {
      return Effect.succeed(ephemeral(m.bot_summon_not_thread({}, { locale })));
    }
    if (!THREAD_CHANNEL_TYPES.has(channelType)) {
      return Effect.succeed(ephemeral(m.bot_summon_not_thread({}, { locale })));
    }

    const memberPermissions = interaction.member?.permissions;
    if (
      memberPermissions === undefined ||
      memberPermissions === null ||
      (BigInt(memberPermissions) & MANAGE_THREADS) === 0n
    ) {
      return Effect.succeed(ephemeral(m.bot_summon_forbidden({}, { locale })));
    }

    const data = interaction.data;
    const options = data && 'options' in data ? [...(data.options ?? [])] : [];

    const userOption = readOption(options, 'user');
    const roleOption = readOption(options, 'role');

    if (Option.isNone(userOption) && Option.isNone(roleOption)) {
      return Effect.succeed(ephemeral(m.bot_summon_missing_target({}, { locale })));
    }

    // Expanding a role requires a guild context (listGuildMembers needs the
    // guild id). If somehow the interaction has no guild_id but does have a
    // role option, treat it as the "not in a server" case.
    if (Option.isSome(roleOption) && guildId === undefined) {
      return Effect.succeed(ephemeral(m.bot_summon_not_thread({}, { locale })));
    }

    const work = DiscordREST.asEffect().pipe(
      Effect.flatMap((rest) =>
        Effect.Do.pipe(
          Effect.bind('roleMembers', () =>
            Option.match(roleOption, {
              onNone: () => Effect.succeed<ReadonlyArray<string>>([]),
              // Safe to assert guildId here — checked above.
              onSome: (roleId) =>
                expandRoleMembers(rest, guildId as DiscordTypes.Snowflake, roleId),
            }),
          ),
          Effect.bind('targets', ({ roleMembers }) => {
            const set = new Set<string>(roleMembers);
            if (Option.isSome(userOption)) set.add(userOption.value);
            return Effect.succeed([...set]);
          }),
          Effect.bind('outcome', ({ targets }) => addMembersToThread(rest, channelId, targets)),
          Effect.flatMap(({ roleMembers, outcome }) => {
            const content = buildSuccessContent({
              locale,
              outcome,
              userId: userOption,
              roleId: roleOption,
              roleMemberCount: roleMembers.length,
              roleHadNoMembers: Option.isSome(roleOption) && roleMembers.length === 0,
            });
            const mentionedUsers = outcome.added.slice(0, 100);
            return rest
              .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
                payload: {
                  content,
                  // Render mentions visually (so `<@id>` shows as @username) but
                  // never actually ping anyone — this is an ephemeral reply
                  // only the invoker sees, and we don't want a side-channel
                  // ping to the added users.
                  allowed_mentions: { parse: [], users: mentionedUsers },
                },
              })
              .pipe(
                Effect.catchTag(
                  ['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'],
                  (error) => Effect.logError('Failed to update summon response', error),
                ),
              );
          }),
        ),
      ),
    );

    const deferred: DiscordTypes.CreateMessageInteractionCallbackRequest = {
      type: DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: DiscordTypes.MessageFlags.Ephemeral },
    };
    return Effect.as(Effect.forkDetach(work), deferred);
  }),
  Effect.withSpan('command/summon'),
);
