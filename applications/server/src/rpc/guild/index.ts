import {
  Auth,
  Discord,
  EventRpcModels,
  EventRsvp,
  type GroupModel,
  GuildRpcGroup,
  GuildRpcModels,
  type Onboarding,
  type PersonalEventChannel,
  type Team,
  TeamMember,
  type User,
} from '@sideline/domain';
import { LogicError, Schemas } from '@sideline/effect-lib';
import { applyTemplate, sanitizeHexColor, sanitizeRendered } from '@sideline/template-renderer';
import { Array, DateTime, Effect, Option, pipe, Ref, Schema } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordRoleMappingRepository } from '~/repositories/DiscordRoleMappingRepository.js';
import { DiscordRolesRepository } from '~/repositories/DiscordRolesRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { eventDayOrder, eventVisibleNow } from '~/repositories/eventVisibility.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { InviteAcceptancesRepository } from '~/repositories/InviteAcceptancesRepository.js';
import { PendingGuildJoinsRepository } from '~/repositories/PendingGuildJoinsRepository.js';
import { PersonalEventChannelsRepository } from '~/repositories/PersonalEventChannelsRepository.js';
import { PersonalEventOverflowCategoriesRepository } from '~/repositories/PersonalEventOverflowCategoriesRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { SudoSessionsRepository } from '~/repositories/SudoSessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { DEFAULT_PERSONAL_EVENTS_CHANNEL_FORMAT } from '~/utils/applyDiscordFormat.js';
import { deactivateMemberAndCascade } from '~/utils/deactivateMemberCascade.js';
import { emitMemberGroupChannelRoles } from '~/utils/emitMemberGroupChannelRoles.js';
import {
  MAX_ROLE_SYNC_EMISSIONS_PER_GUILD_RECONCILE,
  type ReconcileMemberRolesResult,
  reconcileMemberDiscordRoles,
} from '~/utils/reconcileMemberDiscordRoles.js';

const toSnowflake = Schema.decodeSync(Discord.Snowflake);

type IdentifyEventsChannelResult = {
  readonly kind: 'global' | 'personal' | 'none';
  readonly team_id: Option.Option<Team.TeamId>;
  readonly team_member_id: Option.Option<TeamMember.TeamMemberId>;
  readonly owner_discord_id: Option.Option<Discord.Snowflake>;
  readonly is_admin: boolean;
};
/** Widens the `kind` literal so all branches share one return type. */
const identifyResult = (r: IdentifyEventsChannelResult): IdentifyEventsChannelResult => r;

type RegisterMemberPayload = {
  readonly guild_id: Discord.Snowflake;
  readonly discord_id: string;
  readonly username: string;
  readonly avatar: Option.Option<string>;
  readonly roles: ReadonlyArray<string>;
  readonly nickname: Option.Option<string>;
  readonly display_name: Option.Option<string>;
  readonly invite_code: Option.Option<string>;
  readonly source: Option.Option<'member_add' | 'reconcile'>;
};

/**
 * Per-call options for `registerMemberWithReconcile`, distinct from the wire payload:
 * - `guildBudget` — the shared per-`ReconcileMembers`-call emission budget (see
 *   `reconcileMemberDiscordRoles.ts`). Should-fix 7 (whole-series review of commit 46806427):
 *   direct `member_add` calls pass no budget (unbounded — they only ever touch one member).
 *   `source`'s union (below) is exactly `'member_add' | 'reconcile'` — there is no `'interaction'`
 *   variant to pass a budget for; this comment used to claim otherwise.
 * - `markDiscordJoined` — defaults to `true` (any `Some(source)` observation is a real, complete
 *   sighting of the member). `Guild/ReconcileMembers` overrides this to `complete` because a
 *   truncated member-list page cannot be trusted to certify `bot_guilds.members_backfilled_at`-
 *   grade completeness; it still lets the per-member role diff run regardless (CC-10 S6).
 */
type RegisterMemberOptions = {
  readonly guildBudget?: Option.Option<Ref.Ref<number>>;
  readonly markDiscordJoined?: boolean;
};

type WelcomeDetail = {
  readonly welcome_channel_id: Option.Option<Discord.Snowflake>;
  readonly welcome_message_rendered: Option.Option<string>;
  readonly group_name: Option.Option<string>;
  readonly group_color_int: Option.Option<number>;
  readonly inviter_discord_id: Option.Option<Discord.Snowflake>;
};

type WelcomeMeta = {
  readonly system_log_channel_id: Option.Option<Discord.Snowflake>;
  readonly welcome: Option.Option<WelcomeDetail>;
  readonly invite_code: Option.Option<string>;
  // Task 4 (`.work-plans/discord-full-onboarding.md`) — TOP-LEVEL, not inside `WelcomeDetail`.
  // That is the whole point: `resolveInviteContext` only resolves from a Sideline-minted
  // per-acceptance code or a recent `invite_acceptances` row, so a member joining through a
  // plain, captain-made Discord invite gets `welcome: None` and NO welcome message today — see
  // "One finding that shapes the join-time surface" in the plan. These three fields let the bot
  // act on a join with no welcome embed at all.
  readonly profile_complete: boolean;
  readonly profile_gate_enabled: boolean;
  readonly verify_locale: Onboarding.OnboardingLocale;
  readonly verify_intro_template: Option.Option<string>;
};

/**
 * The resolved invite context behind a `Guild/RegisterMember` call: the acceptance row's
 * `team_invites → users → teams → groups` join, or `None` when no invite was identified for
 * this join (no code on the payload and no recent acceptance, or a rejected cross-team match —
 * see `resolveInviteContext`). Hoisted out of `resolveWelcomeMeta` (formerly `Ctx`) because both
 * `applyInviteGroup` and `buildWelcomeMeta` now consume it independently, resolved once by
 * `resolveInviteContext`.
 */
type InviteContext = {
  readonly team_id: Team.TeamId;
  readonly group_id: Option.Option<GroupModel.GroupId>;
  readonly group_name: Option.Option<string>;
  readonly inviter_username: string;
  readonly inviter_discord_id: Option.Option<Discord.Snowflake>;
  readonly team_name: string;
};

export const GuildsRpcLive = Effect.Do.pipe(
  Effect.bind('botGuilds', () => BotGuildsRepository.asEffect()),
  Effect.bind('discordChannels', () => DiscordChannelsRepository.asEffect()),
  Effect.bind('discordRoles', () => DiscordRolesRepository.asEffect()),
  Effect.bind('teams', () => TeamsRepository.asEffect()),
  Effect.bind('users', () => UsersRepository.asEffect()),
  Effect.bind('members', () => TeamMembersRepository.asEffect()),
  Effect.bind('roleMappings', () => DiscordRoleMappingRepository.asEffect()),
  Effect.bind('channelMappings', () => DiscordChannelMappingRepository.asEffect()),
  Effect.bind('groups', () => GroupsRepository.asEffect()),
  Effect.bind('acceptances', () => InviteAcceptancesRepository.asEffect()),
  Effect.bind('pendingGuildJoins', () => PendingGuildJoinsRepository.asEffect()),
  Effect.bind('teamSettings', () => TeamSettingsRepository.asEffect()),
  Effect.bind('personalChannels', () => PersonalEventChannelsRepository.asEffect()),
  Effect.bind('overflowCategories', () => PersonalEventOverflowCategoriesRepository.asEffect()),
  Effect.bind('events', () => EventsRepository.asEffect()),
  Effect.bind('sudoSessions', () => SudoSessionsRepository.asEffect()),
  Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
  Effect.map((deps) => {
    const setupNewMember = (
      team: { readonly id: Team.TeamId },
      newMember: { readonly id: TeamMember.TeamMemberId },
      roles: ReadonlyArray<string>,
    ) =>
      Effect.Do.pipe(
        Effect.tap(() =>
          deps.members.getDefaultRoleId(team.id).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.logInfo('No default role found, skipping'),
                onSome: (defaultRole) => deps.members.assignRole(newMember.id, defaultRole.id),
              }),
            ),
          ),
        ),
        Effect.tap(() =>
          deps.roleMappings.findAllByTeam(team.id).pipe(
            Effect.flatMap((mappings) =>
              Effect.all(
                pipe(
                  mappings,
                  Array.filter((m) => roles.includes(m.discord_role_id)),
                  Array.map((m) => deps.members.assignRole(newMember.id, m.role_id)),
                ),
                { concurrency: 'unbounded' },
              ),
            ),
          ),
        ),
        Effect.tap(() =>
          deps.channelMappings.findAllByTeam(team.id).pipe(
            Effect.flatMap((mappings) =>
              Effect.all(
                pipe(
                  mappings,
                  Array.flatMap((m) =>
                    Option.toArray(
                      Option.flatMap(m.discord_role_id, (roleId) =>
                        roles.includes(roleId) ? m.group_id : Option.none(),
                      ),
                    ),
                  ),
                  Array.map((groupId) => deps.groups.addMemberById(groupId, newMember.id)),
                ),
                { concurrency: 'unbounded' },
              ),
            ),
          ),
        ),
      );

    /**
     * Resolves the (at most one) invite context behind this join: the Discord invite code the
     * bot diffed off the guild's invite list, or — when that lookup misses — the most recent
     * acceptance for this (discord_id, guild_id) pair (Discord auto-deletes `max_uses:1`
     * invites on consumption, which breaks the diff the bot uses to identify the code).
     *
     * Structured as two phases so the cross-team guard's terminal behaviour is structural, not
     * incidental:
     *
     * - Phase 1 resolves AT MOST ONE candidate acceptance. The recency fallback is consumed
     *   here and nowhere else.
     * - Phase 2 applies the cross-team guard ONCE, to that single candidate. A rejected
     *   cross-team match returns `None` and does NOT retry the recency fallback — retrying would
     *   let a stale or mismatched Discord code fall through to a coincidental same-team
     *   acceptance and manufacture a welcome + group bind out of it. This mirrors the
     *   pre-refactor behaviour, where the guard lived inside `buildWelcome` and only ran after a
     *   branch had already been chosen. Do NOT restructure this into resolve -> guard ->
     *   retry-on-None.
     */
    const resolveInviteContext = (
      team: { readonly id: Team.TeamId },
      payload: RegisterMemberPayload,
    ): Effect.Effect<Option.Option<InviteContext>> => {
      // Fallback used when the bot couldn't identify the consumed invite code
      // (Discord auto-deletes max_uses:1 invites on consumption, breaking diff matching).
      const fallbackByUserAndGuild = deps.acceptances.findRecentByUserAndGuildWithContext(
        payload.discord_id,
        payload.guild_id,
      );
      // Phase 1 — resolve at most one candidate acceptance.
      const candidate = Option.match(payload.invite_code, {
        onNone: () => fallbackByUserAndGuild,
        onSome: (code) =>
          deps.acceptances.findByDiscordCodeWithContext(code).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.logWarning(
                    `RegisterMember: invite code ${code} not found or expired; trying recency fallback`,
                  ).pipe(Effect.andThen(fallbackByUserAndGuild)),
                onSome: (ctx) => Effect.succeed(Option.some(ctx)),
              }),
            ),
          ),
      });
      // Phase 2 — the cross-team guard, applied once. Terminal by construction: phase 1 has
      // already finished, so a rejected cross-team match cannot fall through to the recency
      // fallback.
      return candidate.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<InviteContext>()),
            onSome: (ctx) =>
              ctx.team_id !== team.id
                ? Effect.logError(
                    `RegisterMember: invite team_id ${ctx.team_id} !== team ${team.id}`,
                  ).pipe(Effect.as(Option.none<InviteContext>()))
                : Effect.succeed(Option.some(ctx)),
          }),
        ),
      );
    };

    /**
     * ORDER-CRITICAL. Applies the group binding an invite carries, in BOTH halves that every
     * other group-add in this codebase applies (`api/group.ts` `addGroupMember`,
     * `AgeCheckService.ts`): the `group_members` row AND the `member_added` channel-sync events
     * that make the bot grant the group's own Discord role
     * (`discord_channel_mappings.discord_role_id`, created by `createGroup`'s
     * `emitChannelCreated`) for the group and every active ancestor. This handler was the only
     * group-add that wrote the row and emitted nothing — and `reconcileMemberDiscordRoles`
     * cannot cover for it, because it reads `discord_role_mappings`, a different table. A group
     * with no explicitly linked Sideline role (i.e. no `role_groups` row — the state of every
     * group at creation) contributes NOTHING to the role diff, so the channel emit is not a
     * nicety here: it is the only thing that gets the majority of groups their Discord role.
     * (`setupNewMember`'s group-add needs no emit — it matched the member BECAUSE they already
     * hold that Discord role.)
     *
     * Ancestors come from `getActiveAncestors`, NOT `getAncestorsIncludingArchived`: an archived ancestor whose
     * `discord_channel_mappings` row `deleteGroup` already removed would otherwise make the
     * bot's self-healing `createRoleOnly` branch recreate a Discord role named after the deleted
     * group, on the hottest automatic path in the system.
     *
     * Returns the group ids it emitted `member_added` for — the bound group PLUS its active
     * ancestors. Only the first of those got an `addMemberById`; membership in an ancestor is
     * implied by the subgroup tree, not stored. `registerMemberWithReconcile` destructures that
     * value in the `reconcile` bind, which makes it a COMPILE ERROR in `Effect.Do` to run the
     * role diff first: the diff reads `findEffectiveRoleIdsForMember` (`member_roles` UNION the
     * group-inherited walk, `repositories/effectiveRoles.ts`) from the database at call time and
     * would miss any group bound after it. That structural dependency, not a comment, is what
     * keeps this ordering.
     *
     * `group_id` and `group_name` come from the same `LEFT JOIN groups g ON g.id = ti.group_id
     * AND g.is_archived = false` in both acceptance queries, so they are strictly co-present —
     * hence `Option.all`, not a `getOrElse('')` that could hand the bot an unnamed role to
     * create. An archived group yields `None` on both and binds nothing.
     *
     * The insert is `ON CONFLICT DO NOTHING` (PK `(group_id, team_member_id)`), so it is a free
     * no-op when `joinViaInvite` (Task 3) already wrote the row; the emit runs regardless,
     * because the Discord side is not derivable from the insert's outcome.
     */
    const applyInviteGroup = (
      team: { readonly id: Team.TeamId },
      newMember: { readonly id: TeamMember.TeamMemberId },
      payload: RegisterMemberPayload,
      inviteContext: Option.Option<InviteContext>,
    ): Effect.Effect<ReadonlyArray<GroupModel.GroupId>, never, ChannelSyncEventsRepository> =>
      Option.match(
        Option.flatMap(inviteContext, (ctx) =>
          Option.all({ groupId: ctx.group_id, groupName: ctx.group_name }),
        ),
        {
          onNone: () => Effect.succeed<ReadonlyArray<GroupModel.GroupId>>([]),
          onSome: ({ groupId, groupName }) =>
            Effect.Do.pipe(
              Effect.bind('channelSync', () => ChannelSyncEventsRepository.asEffect()),
              Effect.tap(() => deps.groups.addMemberById(groupId, newMember.id)),
              Effect.bind('ancestors', () => deps.groups.getActiveAncestors(groupId, team.id)),
              Effect.let('entries', ({ ancestors }) =>
                [{ id: groupId, name: groupName }, ...ancestors].map((g) => ({
                  groupId: g.id,
                  groupName: g.name,
                  teamMemberId: newMember.id,
                  discordUserId: toSnowflake(payload.discord_id),
                })),
              ),
              Effect.tap(({ channelSync, entries }) =>
                channelSync.emitMembersAddedBatch({ teamId: team.id, entries }),
              ),
              Effect.map(({ entries }) => entries.map((e) => e.groupId)),
            ),
        },
      );

    /**
     * Pure(ish) read of the welcome DTO: template render + `fetchGroupColor`. The group bind
     * itself and the cross-team guard have both moved out — see `applyInviteGroup` and
     * `resolveInviteContext`. Must still return `noWelcome` (with `system_log_channel_id` and
     * `invite_code` populated) when `inviteContext` is `None`; `WelcomeMeta`'s shape is
     * byte-identical to before this split.
     */
    const buildWelcomeMeta = (
      team: {
        readonly id: Team.TeamId;
        readonly welcome_channel_id: Option.Option<Discord.Snowflake>;
        readonly system_log_channel_id: Option.Option<Discord.Snowflake>;
        readonly welcome_message_template: Option.Option<string>;
        readonly onboarding_locale: Onboarding.OnboardingLocale;
        readonly verify_intro_template: Option.Option<string>;
      },
      user: { readonly is_profile_complete: boolean },
      payload: RegisterMemberPayload,
      inviteContext: Option.Option<InviteContext>,
    ): Effect.Effect<WelcomeMeta> => {
      // Task 4 (`.work-plans/discord-full-onboarding.md`) — `profile_gate_enabled` is the only
      // field here that costs a query (`deps.teamSettings.findByTeamId`). Skip it entirely when
      // this call came from `Guild/ReconcileMembers` (`payload.source === Some('reconcile')`):
      // that path calls `registerMemberWithReconcile` for every member of a guild at
      // `concurrency: 5` and DISCARDS the `welcomeMeta` result (see `:795-815`), so the query
      // would be pure waste on the largest fan-out in the server. `profile_complete` and
      // `verify_locale` are free (already-loaded rows) and stay populated on that path.
      const isReconcile = Option.isSome(payload.source) && payload.source.value === 'reconcile';
      const fetchProfileGateEnabled: Effect.Effect<boolean> = isReconcile
        ? Effect.succeed(false)
        : deps.teamSettings.findByTeamId(team.id).pipe(
            Effect.map((row) =>
              Option.match(row, {
                onNone: () => false,
                onSome: (s) => s.require_complete_profile,
              }),
            ),
          );

      return Effect.Do.pipe(
        Effect.bind('profileGateEnabled', () => fetchProfileGateEnabled),
        Effect.bind('result', ({ profileGateEnabled }) => {
          const noWelcome: WelcomeMeta = {
            system_log_channel_id: team.system_log_channel_id,
            welcome: Option.none(),
            invite_code: payload.invite_code,
            profile_complete: user.is_profile_complete,
            profile_gate_enabled: profileGateEnabled,
            verify_locale: team.onboarding_locale,
            verify_intro_template: team.verify_intro_template,
          };
          return Option.match(inviteContext, {
            onNone: () => Effect.succeed(noWelcome),
            onSome: (ctx) => {
              const renderedMessage = Option.map(team.welcome_message_template, (template) =>
                sanitizeRendered(
                  applyTemplate(template, {
                    memberMention: `<@${payload.discord_id}>`,
                    memberName: Option.getOrElse(payload.display_name, () => payload.username),
                    inviterMention: Option.match(ctx.inviter_discord_id, {
                      onNone: () => '',
                      onSome: (id) => `<@${id}>`,
                    }),
                    inviterName: ctx.inviter_username,
                    groupName: Option.getOrElse(ctx.group_name, () => ''),
                    teamName: ctx.team_name,
                  }),
                ),
              );
              const fetchGroupColor = Option.match(ctx.group_id, {
                onNone: () => Effect.succeed(Option.none<number>()),
                onSome: (groupId) =>
                  deps.groups
                    .findGroupById(groupId)
                    .pipe(
                      Effect.map(
                        Option.flatMap((g) =>
                          Option.fromNullishOr(sanitizeHexColor(Option.getOrNull(g.color))),
                        ),
                      ),
                    ),
              });
              return Effect.Do.pipe(
                Effect.bind('group_color_int', () => fetchGroupColor),
                Effect.map(
                  ({ group_color_int }): WelcomeMeta => ({
                    system_log_channel_id: team.system_log_channel_id,
                    invite_code: payload.invite_code,
                    profile_complete: user.is_profile_complete,
                    profile_gate_enabled: profileGateEnabled,
                    verify_locale: team.onboarding_locale,
                    verify_intro_template: team.verify_intro_template,
                    welcome: Option.some<WelcomeDetail>({
                      welcome_channel_id: team.welcome_channel_id,
                      welcome_message_rendered: renderedMessage,
                      group_name: ctx.group_name,
                      group_color_int,
                      inviter_discord_id: ctx.inviter_discord_id,
                    }),
                  }),
                ),
              );
            },
          });
        }),
        Effect.map(({ result }) => result),
      );
    };

    type RegisterMemberOutcome = {
      readonly welcomeMeta: Option.Option<WelcomeMeta>;
      readonly reconcile: Option.Option<ReconcileMemberRolesResult>;
    };
    const noOutcome: RegisterMemberOutcome = {
      welcomeMeta: Option.none(),
      reconcile: Option.none(),
    };

    // PR-8 (CC-10): runs the level-based role diff on EVERY observation of the member (a fresh
    // join, a re-join, or — critically, the reporter's exact bug — a member already active on
    // the team who is only now being seen in the guild). `payload.source` gates whether this runs
    // at all (`None` = an un-upgraded bot; skip entirely and pick the member up on the next
    // reconcile from an upgraded bot).
    const observeGuildMembership = (
      team: { readonly id: Team.TeamId },
      newMember: { readonly id: TeamMember.TeamMemberId },
      payload: RegisterMemberPayload,
      options: RegisterMemberOptions,
      // ORDER-CRITICAL, not decorative. To be precise about what enforces what: the thing that
      // makes running the role diff before `applyInviteGroup` a COMPILE ERROR is the
      // `{ newMember, boundGroupIds }` destructure at the `reconcile` bind in
      // `registerMemberWithReconcile` — `Effect.Do` only exposes keys bound earlier, so hoisting
      // `reconcile` above `boundGroupIds` stops type-checking. This parameter is what gives that
      // destructure a reason to exist. It is ALSO now a real, functional argument in its own
      // right (bug fix-group-channel-discord-join, PR 1): passed straight through to
      // `emitMemberGroupChannelRoles` below as `alreadyEmittedGroupIds`, so a group-scoped
      // invite's own `member_added` emit (from `applyInviteGroup`, bound above this call) is
      // never double-emitted by this function's own group-channel-role diff. Do not "tidy this
      // away" — it now has two independent reasons to exist, not one.
      boundGroupIds: ReadonlyArray<GroupModel.GroupId>,
    ) =>
      Option.match(payload.source, {
        onNone: () =>
          Effect.logDebug(
            `RegisterMember: no source on payload for discord_id ${payload.discord_id} in team ${team.id} ` +
              `(pre-PR-8 bot); skipping discord_joined_at + role diff`,
          ).pipe(Effect.as(Option.none<ReconcileMemberRolesResult>())),
        onSome: (source) =>
          Effect.Do.pipe(
            Effect.tap(() =>
              (options.markDiscordJoined ?? true)
                ? deps.members.markDiscordJoined(newMember.id)
                : Effect.void,
            ),
            Effect.tap(() =>
              Effect.logDebug(
                `RegisterMember: diffing after ${boundGroupIds.length} invite-bound group binding(s)`,
              ),
            ),
            // bug fix-group-channel-discord-join (PR 1) — `GUILD_MEMBER_ADD` only. A member
            // already active on the team who is only now sighted joining Discord (the reported
            // bug) or joining past the invite-acceptance recency window gets their group's own
            // Discord channel role here, independent of any invite. Gated on `source ===
            // 'member_add'` — NOT run for `Guild/ReconcileMembers` (`source: 'reconcile'`),
            // which would otherwise re-emit a whole page of already-active members' entire group
            // trees on every bot reconnect (the N+1 fan-out §2 of the implementation plan
            // rejects). A member first observed by reconcile (e.g. joined while the bot was
            // disconnected past the gateway resume window) is left uncovered by this path today —
            // see `applications/server/AGENTS.md`'s group-channel-role-sync section for that
            // accepted gap, its trigger condition, and today's manual remedy.
            // Auxiliary heal, must stay non-fatal: every repository call inside
            // `emitMemberGroupChannelRoles` pipes `catchSqlErrors` (`Effect.die(LogicError)`), so a
            // transient failure here is a DEFECT, not a typed error — despite the `never` error
            // channel. Left unguarded, that defect would short-circuit this whole `Effect.tap` and
            // skip `reconcileMemberDiscordRoles` plus the welcome message below, breaking
            // pre-existing behavior for the sake of an additive fix. Same convention as
            // `reapplyGroupGrants`'s wrap in `rpc/channel/index.ts:220-221` / `:245-246` (see
            // `applications/server/AGENTS.md`: "a grant-reapply error is observability noise, not a
            // reason to reject the role mapping").
            Effect.tap(() =>
              source === 'member_add'
                ? emitMemberGroupChannelRoles(
                    team,
                    newMember,
                    toSnowflake(payload.discord_id),
                    payload.roles,
                    boundGroupIds,
                  ).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning('emitMemberGroupChannelRoles failed (non-fatal)', cause),
                    ),
                  )
                : Effect.logDebug(
                    `RegisterMember: source '${source}' !== 'member_add' for discord_id ${payload.discord_id} ` +
                      `in team ${team.id}; skipping group-channel-role emit here (reconcile does not ` +
                      `re-derive it — see AGENTS.md's accepted gap and today's manual "Sync role members" remedy)`,
                  ),
            ),
            Effect.flatMap(() =>
              reconcileMemberDiscordRoles(
                team,
                newMember,
                toSnowflake(payload.discord_id),
                payload.roles,
                options.guildBudget ?? Option.none(),
              ),
            ),
            Effect.map(Option.some),
          ),
      });

    const registerMemberWithReconcile = (
      payload: RegisterMemberPayload,
      options: RegisterMemberOptions = {},
    ) =>
      deps.teams.findByGuildId(payload.guild_id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.logInfo(
                `No team found for guild ${payload.guild_id}, skipping member registration`,
              ).pipe(Effect.as(noOutcome)),
            onSome: (team) =>
              Effect.Do.pipe(
                Effect.bind('user', () =>
                  deps.users.upsertFromDiscord({
                    discord_id: payload.discord_id,
                    username: payload.username,
                    avatar: payload.avatar,
                    discord_nickname: payload.nickname,
                    discord_display_name: payload.display_name,
                  }),
                ),
                Effect.bind('existingMembership', ({ user }) =>
                  deps.members.findMembershipByIds(team.id, user.id, { includeInactive: true }),
                ),
                Effect.bind('newMember', ({ existingMembership, user }) => {
                  if (Option.isSome(existingMembership) && existingMembership.value.active) {
                    return Effect.logInfo(
                      `Member ${payload.username} already active in team ${team.id}`,
                    ).pipe(Effect.as({ id: existingMembership.value.id }));
                  }
                  const resolveMemberId = Option.isNone(existingMembership)
                    ? deps.members
                        .addMember({
                          team_id: team.id,
                          user_id: user.id,
                          active: true,
                          joined_at: undefined,
                        })
                        .pipe(Effect.map((m) => ({ id: m.id })))
                    : deps.members
                        .reactivateMember(existingMembership.value.id)
                        .pipe(Effect.map((m) => ({ id: m.id })));
                  return resolveMemberId.pipe(
                    Effect.tap((newMember) => setupNewMember(team, newMember, payload.roles)),
                    Effect.tap(() =>
                      Effect.logInfo(`Registered member ${payload.username} in team ${team.id}`),
                    ),
                  );
                }),
                // Resolve the invite behind this join ONCE — the group write below and the
                // welcome DTO at the bottom of this chain consume the same context, and
                // previously each re-derived it inside `resolveWelcomeMeta`.
                Effect.bind('inviteContext', () => resolveInviteContext(team, payload)),
                // ORDER-CRITICAL — see `applyInviteGroup`. Enforced by `reconcile`'s
                // `boundGroupIds` destructure below, not by this comment.
                Effect.bind('boundGroupIds', ({ newMember, inviteContext }) =>
                  applyInviteGroup(team, newMember, payload, inviteContext),
                ),
                // Runs on every branch above — including "already active", which is exactly the
                // reporter's case (a member registered via web who only later joins Discord).
                Effect.bind('reconcile', ({ newMember, boundGroupIds }) =>
                  observeGuildMembership(team, newMember, payload, options, boundGroupIds),
                ),
                Effect.bind('welcomeMeta', ({ user, inviteContext }) =>
                  buildWelcomeMeta(team, user, payload, inviteContext),
                ),
                Effect.map(
                  ({ welcomeMeta, reconcile }): RegisterMemberOutcome => ({
                    welcomeMeta: Option.some(welcomeMeta),
                    reconcile,
                  }),
                ),
              ),
          }),
        ),
        Effect.catchTag(['MemberAlreadyExistsError', 'NoSuchElementError'], (error) =>
          Effect.logError(`RegisterMember failed for ${payload.username}`, error).pipe(
            Effect.as(noOutcome),
          ),
        ),
      );

    const registerMember = (payload: RegisterMemberPayload) =>
      registerMemberWithReconcile(payload).pipe(Effect.map((outcome) => outcome.welcomeMeta));

    return {
      'Guild/RegisterGuild': ({
        guild_id,
        guild_name,
        is_community_enabled,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly guild_name: string;
        readonly is_community_enabled: boolean;
      }) => deps.botGuilds.upsert(guild_id, guild_name, is_community_enabled),

      'Guild/UnregisterGuild': ({ guild_id }: { readonly guild_id: Discord.Snowflake }) =>
        deps.botGuilds.remove(guild_id),

      'Guild/IsGuildRegistered': ({ guild_id }: { readonly guild_id: Discord.Snowflake }) =>
        deps.botGuilds.exists(guild_id),

      'Guild/SyncGuildChannels': ({
        guild_id,
        channels,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly channels: ReadonlyArray<{
          readonly channel_id: Discord.Snowflake;
          readonly name: string;
          readonly type: number;
          readonly parent_id: Option.Option<Discord.Snowflake>;
        }>;
      }) => deps.discordChannels.syncChannels(guild_id, channels),

      'Guild/UpdateChannelName': ({
        channel_id,
        name,
      }: {
        readonly channel_id: Discord.Snowflake;
        readonly name: string;
      }) => deps.discordChannels.updateChannelName(channel_id, name),

      'Guild/UpsertChannel': ({
        guild_id,
        channel_id,
        name,
        type,
        parent_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly channel_id: Discord.Snowflake;
        readonly name: string;
        readonly type: number;
        readonly parent_id: Option.Option<Discord.Snowflake>;
      }) => deps.discordChannels.upsertChannel(guild_id, channel_id, name, type, parent_id),

      'Guild/DeleteChannel': ({
        guild_id,
        channel_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly channel_id: Discord.Snowflake;
      }) => deps.discordChannels.deleteChannel(guild_id, channel_id),

      'Guild/RegisterMember': registerMember,

      'Guild/RemoveMember': ({
        guild_id,
        discord_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_id: Discord.Snowflake;
      }) =>
        Effect.withSpan('Guild/RemoveMember', { attributes: { guild_id, discord_id } })(
          Effect.Do.pipe(
            Effect.bind('rosters', () => RostersRepository.asEffect()),
            Effect.bind('channelSync', () => ChannelSyncEventsRepository.asEffect()),
            Effect.flatMap(({ rosters, channelSync }) =>
              deps.teams.findByGuildId(guild_id).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.logInfo(
                        `Guild/RemoveMember: no team found for guild ${guild_id}, skipping`,
                      ).pipe(Effect.asVoid),
                    onSome: (team) =>
                      Effect.Do.pipe(
                        Effect.bind('user', () => deps.users.findByDiscordId(discord_id)),
                        Effect.flatMap(({ user }) =>
                          Option.match(user, {
                            onNone: () =>
                              Effect.logInfo(
                                `Guild/RemoveMember: no user found for discord_id ${discord_id}, skipping`,
                              ).pipe(Effect.asVoid),
                            onSome: (resolvedUser) =>
                              Effect.Do.pipe(
                                Effect.bind('membership', () =>
                                  deps.members.findMembershipByIds(team.id, resolvedUser.id, {
                                    includeInactive: true,
                                  }),
                                ),
                                Effect.flatMap(({ membership }) =>
                                  Option.match(membership, {
                                    onNone: () =>
                                      Effect.logInfo(
                                        `Guild/RemoveMember: no membership found for user ${resolvedUser.id} in team ${team.id}, skipping`,
                                      ).pipe(Effect.asVoid),
                                    onSome: (m) => {
                                      if (!m.active) {
                                        // A user who left Discord is not in the guild regardless
                                        // of Sideline membership state (CC-10 step 7).
                                        return deps.members
                                          .clearDiscordJoined(m.id)
                                          .pipe(
                                            Effect.andThen(
                                              Effect.logInfo(
                                                `Guild/RemoveMember: membership for user ${resolvedUser.id} in team ${team.id} is already inactive, skipping`,
                                              ),
                                            ),
                                            Effect.asVoid,
                                          );
                                      }
                                      const memberHoldsManage =
                                        m.permissions.includes('team:manage');
                                      return deactivateMemberAndCascade(
                                        {
                                          sql: deps.sql,
                                          members: {
                                            ...deps.members,
                                            deactivateMemberByIds: (tId, mId) =>
                                              deps.members.deactivateMemberByIds(tId, mId).pipe(
                                                Effect.asVoid,
                                                Effect.catchTag('NoSuchElementError', () =>
                                                  LogicError.die(
                                                    'deactivateMemberByIds: UPDATE returned no row',
                                                  ),
                                                ),
                                              ),
                                          },
                                          rosters,
                                          groups: deps.groups,
                                          channelSync,
                                        },
                                        team.id,
                                        m.id,
                                        memberHoldsManage,
                                        discord_id,
                                      ).pipe(
                                        // A user who left Discord is not in the guild regardless
                                        // of Sideline membership state (CC-10 step 7) — clear on
                                        // every outcome, including `last_admin` (deactivation is
                                        // skipped there, but the Discord departure is real).
                                        Effect.tap(() => deps.members.clearDiscordJoined(m.id)),
                                        Effect.flatMap((result) => {
                                          if (result.deactivated) {
                                            return Effect.logInfo(
                                              `Guild/RemoveMember: deactivated member ${m.id} for discord_id ${discord_id} in team ${team.id}`,
                                            );
                                          }
                                          if (result.reason === 'last_admin') {
                                            return Effect.logWarning(
                                              `Guild/RemoveMember: skipped deactivation of member ${m.id} (last admin) for discord_id ${discord_id} in team ${team.id}`,
                                            );
                                          }
                                          return Effect.logInfo(
                                            `Guild/RemoveMember: member ${m.id} already inactive for discord_id ${discord_id} in team ${team.id}`,
                                          );
                                        }),
                                        Effect.asVoid,
                                      );
                                    },
                                  }),
                                ),
                              ),
                          }),
                        ),
                      ),
                  }),
                ),
              ),
            ),
          ),
        ),

      'Guild/ReconcileMembers': ({
        guild_id,
        members: membersList,
        complete,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly members: ReadonlyArray<{
          readonly discord_id: string;
          readonly username: string;
          readonly avatar: Option.Option<string>;
          readonly roles: ReadonlyArray<string>;
          readonly nickname: Option.Option<string>;
          readonly display_name: Option.Option<string>;
        }>;
        readonly complete: boolean;
      }) =>
        Effect.Do.pipe(
          Effect.tap(() =>
            Effect.logInfo(`Reconciling ${membersList.length} members for guild ${guild_id}`),
          ),
          // Per-guild-per-pass emission budget (CC-10 S6 / PR-8 step 6) — shared across every
          // member processed in this call so the first post-deploy backfill of a large,
          // long-unsynced guild drains over several reconnects instead of dumping thousands of
          // role_sync_events into the bot's `concurrency: 1` drain loop in one shot.
          Effect.bind('budget', () => Ref.make(MAX_ROLE_SYNC_EMISSIONS_PER_GUILD_RECONCILE)),
          Effect.bind('results', ({ budget }) =>
            Effect.all(
              Array.map(membersList, (member) =>
                registerMemberWithReconcile(
                  {
                    guild_id,
                    discord_id: member.discord_id,
                    username: member.username,
                    avatar: member.avatar,
                    roles: member.roles,
                    nickname: member.nickname,
                    display_name: member.display_name,
                    invite_code: Option.none(),
                    // The server supplies 'reconcile' explicitly — an absent key on the wire can
                    // therefore only mean a bot older than PR-8 hitting `RegisterMember` directly.
                    source: Option.some('reconcile'),
                  },
                  {
                    guildBudget: Option.some(budget),
                    // A truncated page cannot certify "we have seen this member" the way a
                    // realtime member_add can — see CC-10 S6. The diff still runs unconditionally
                    // (below, independent of `complete`).
                    markDiscordJoined: complete,
                  },
                ),
              ),
              { concurrency: 5 },
            ),
          ),
          Effect.tap(({ results }) => {
            const skipped = results.reduce(
              (acc, { reconcile }) =>
                acc + Option.match(reconcile, { onNone: () => 0, onSome: (r) => r.skippedForCap }),
              0,
            );
            return skipped > 0
              ? Effect.logWarning(
                  `Guild/ReconcileMembers: per-guild emission cap reached for guild ${guild_id}; ${skipped} role_sync_events deferred to the next reconcile`,
                )
              : Effect.void;
          }),
          Effect.tap(() =>
            complete ? deps.botGuilds.markMembersBackfilled(guild_id) : Effect.void,
          ),
          Effect.tap(() => Effect.logInfo(`Reconciliation complete for guild ${guild_id}`)),
          Effect.asVoid,
        ),

      'Guild/PendingGuildJoins': () => deps.pendingGuildJoins.listPending(),

      'Guild/MarkGuildJoinDone': ({ id }: { readonly id: string }) =>
        deps.pendingGuildJoins.markDone(id),

      'Guild/MarkGuildJoinFailed': ({
        id,
        error,
      }: {
        readonly id: string;
        readonly error: string;
      }) => deps.pendingGuildJoins.markFailed(id, error),

      'Guild/PendingOnboardingSyncs': ({ limit }: { readonly limit: number }) =>
        deps.teams.claimPendingOnboardingSyncs(limit),

      'Guild/MarkOnboardingSyncDone': ({
        team_id,
        prompt_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly prompt_id: Option.Option<Discord.Snowflake>;
      }) =>
        deps.teams
          .markOnboardingSyncDoneIfSyncing(team_id, prompt_id)
          .pipe(Effect.map((updated) => ({ updated }))),

      'Guild/MarkOnboardingSyncFailed': ({
        team_id,
        error_code,
        error_detail,
      }: {
        readonly team_id: Team.TeamId;
        readonly error_code: string;
        readonly error_detail: string;
      }) =>
        deps.teams
          .markOnboardingSyncFailedIfSyncing(
            team_id,
            JSON.stringify({ code: error_code, detail: error_detail }),
          )
          .pipe(Effect.map(() => ({ updated: true }))),

      'Guild/RevertOnboardingSync': ({ team_id }: { readonly team_id: Team.TeamId }) =>
        deps.teams.revertOnboardingSyncIfSyncing(team_id),

      'Guild/MarkOnboardingSyncSkipped': ({ team_id }: { readonly team_id: Team.TeamId }) =>
        deps.teams.markOnboardingSyncSkippedIfSyncing(team_id),

      'Guild/GetOnboardingRulesRoleId': ({ guild_id }: { readonly guild_id: Discord.Snowflake }) =>
        deps.teams.getOnboardingRulesRoleIdByGuildId(guild_id),

      'Guild/SyncCommunityFlags': ({
        guilds,
      }: {
        readonly guilds: ReadonlyArray<{
          readonly guild_id: Discord.Snowflake;
          readonly is_community_enabled: boolean;
        }>;
      }) =>
        deps.botGuilds
          .bulkUpdateCommunityFlags(
            Array.map(guilds, (g) => ({
              guildId: g.guild_id,
              isCommunityEnabled: g.is_community_enabled,
            })),
          )
          .pipe(
            Effect.flatMap(() =>
              Effect.all(
                pipe(
                  guilds,
                  Array.filter((g) => g.is_community_enabled),
                  Array.map((g) => deps.teams.flipPendingOnboardingSyncForGuild(g.guild_id)),
                ),
                { concurrency: 'unbounded' },
              ),
            ),
            Effect.asVoid,
          ),

      'Guild/ListGuildRoles': ({ guild_id }: { readonly guild_id: Discord.Snowflake }) =>
        deps.discordRoles.listByGuild(guild_id),

      'Guild/SyncGuildRoles': ({
        guild_id,
        roles,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly roles: ReadonlyArray<{
          readonly role_id: Discord.Snowflake;
          readonly name: string;
          readonly color: number;
          readonly position: number;
          readonly managed: boolean;
        }>;
      }) => deps.discordRoles.syncForGuild(guild_id, roles),

      'Guild/UpsertGuildRole': ({
        guild_id,
        role_id,
        name,
        color,
        position,
        managed,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly role_id: Discord.Snowflake;
        readonly name: string;
        readonly color: number;
        readonly position: number;
        readonly managed: boolean;
      }) => deps.discordRoles.upsert({ guild_id, role_id, name, color, position, managed }),

      'Guild/DeleteGuildRole': ({
        guild_id,
        role_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly role_id: Discord.Snowflake;
      }) => deps.discordRoles.delete(guild_id, role_id),

      'Guild/GetGuildsNeedingPersonalProvisioning': ({ limit }: { readonly limit: number }) =>
        deps.personalChannels.getGuildsNeedingPersonalProvisioning(limit),

      'Guild/GetPersonalEventsCategory': ({ guild_id }: { readonly guild_id: Discord.Snowflake }) =>
        deps.teams.findByGuildId(guild_id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none<Discord.Snowflake>()),
              onSome: (team) =>
                deps.teamSettings
                  .findByTeamId(team.id)
                  .pipe(Effect.map(Option.flatMap((s) => s.discord_personal_events_category_id))),
            }),
          ),
        ),

      'Guild/GetMembersNeedingPersonalChannel': ({
        guild_id,
        limit,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly limit: number;
      }) =>
        deps.teams.findByGuildId(guild_id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.succeed<
                  ReadonlyArray<{
                    readonly team_id: Team.TeamId;
                    readonly team_member_id: TeamMember.TeamMemberId;
                    readonly discord_id: Discord.Snowflake;
                    readonly name: string;
                    readonly channel_format: string;
                    readonly bucket: PersonalEventChannel.PersonalChannelBucket;
                  }>
                >([]),
              onSome: (team) =>
                deps.teamSettings.findByTeamId(team.id).pipe(
                  Effect.flatMap((settingsOpt) => {
                    const groupId = Option.flatMap(
                      settingsOpt,
                      (s) => s.discord_personal_events_group_id,
                    );
                    const channelFormat = Option.match(settingsOpt, {
                      onNone: () => DEFAULT_PERSONAL_EVENTS_CHANNEL_FORMAT,
                      onSome: (s) => s.discord_personal_events_channel_format,
                    });
                    return deps.personalChannels
                      .getMembersNeedingPersonalChannel(team.id, groupId, limit)
                      .pipe(
                        Effect.map(
                          Array.map((m) => ({
                            team_id: team.id,
                            team_member_id: m.team_member_id,
                            discord_id: m.discord_id,
                            name: m.name,
                            channel_format: channelFormat,
                            bucket: m.bucket,
                          })),
                        ),
                      );
                  }),
                ),
            }),
          ),
        ),

      'Guild/GetPersonalChannelsToDeprovision': ({
        guild_id,
        limit,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly limit: number;
      }) =>
        deps.teams.findByGuildId(guild_id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.succeed<
                  ReadonlyArray<{
                    readonly team_id: Team.TeamId;
                    readonly team_member_id: TeamMember.TeamMemberId;
                    readonly discord_channel_id: Discord.Snowflake;
                    readonly bucket: PersonalEventChannel.PersonalChannelBucket;
                  }>
                >([]),
              onSome: (team) =>
                deps.teamSettings.findByTeamId(team.id).pipe(
                  Effect.flatMap((settingsOpt) => {
                    const groupId = Option.flatMap(
                      settingsOpt,
                      (s) => s.discord_personal_events_group_id,
                    );
                    // Group-based de-provision: active members who left the configured group.
                    // NOT gated by B3 — a member out of the group loses every channel.
                    const groupBased = Option.match(groupId, {
                      onNone: () =>
                        Effect.succeed<
                          ReadonlyArray<{
                            readonly team_member_id: TeamMember.TeamMemberId;
                            readonly discord_channel_id: Discord.Snowflake;
                            readonly bucket: PersonalEventChannel.PersonalChannelBucket;
                          }>
                        >([]),
                      onSome: (gId) =>
                        deps.personalChannels.getMembersToDeprovision(team.id, gId, limit),
                    });
                    // Inactive-member de-provision: always, regardless of group config.
                    // NOT gated by B3 — an inactive member loses every channel.
                    const inactiveBased = deps.personalChannels.getInactiveMembersToDeprovision(
                      team.id,
                      limit,
                    );
                    // Mode-flip de-provision: channels outside the member's current
                    // desired bucket set. Gated by B3 inside the repository — a member
                    // mid-switch never loses a channel before its replacement exists.
                    const obsoleteBucketBased =
                      deps.personalChannels.getObsoleteBucketsToDeprovision(team.id, limit);
                    return Effect.all([groupBased, inactiveBased, obsoleteBucketBased], {
                      concurrency: 'unbounded',
                    }).pipe(
                      Effect.map(([groupRows, inactiveRows, obsoleteRows]) => {
                        // Merge and deduplicate by `team_member_id:bucket` — NOT by
                        // team_member_id alone. A split member can have up to three
                        // obsolete channels in the same tick; a member-only key would
                        // silently drop two of them every tick.
                        const seen = new Set<string>();
                        const merged: Array<{
                          readonly team_id: Team.TeamId;
                          readonly team_member_id: TeamMember.TeamMemberId;
                          readonly discord_channel_id: Discord.Snowflake;
                          readonly bucket: PersonalEventChannel.PersonalChannelBucket;
                        }> = [];
                        for (const m of [...groupRows, ...inactiveRows, ...obsoleteRows]) {
                          const key = `${m.team_member_id}:${m.bucket}`;
                          if (!seen.has(key)) {
                            seen.add(key);
                            merged.push({
                              team_id: team.id,
                              team_member_id: m.team_member_id,
                              discord_channel_id: m.discord_channel_id,
                              bucket: m.bucket,
                            });
                          }
                        }
                        return merged;
                      }),
                    );
                  }),
                ),
            }),
          ),
        ),

      'Guild/ReservePersonalChannel': ({
        team_id,
        team_member_id,
        bucket,
      }: {
        readonly team_id: Team.TeamId;
        readonly team_member_id: TeamMember.TeamMemberId;
        readonly bucket: PersonalEventChannel.PersonalChannelBucket;
      }) =>
        deps.personalChannels
          .reservePersonalChannel(team_id, team_member_id, bucket)
          .pipe(Effect.map((reserved) => ({ reserved }))),

      'Guild/SavePersonalChannelId': ({
        team_id,
        team_member_id,
        discord_channel_id,
        channel_format,
        bucket,
      }: {
        readonly team_id: Team.TeamId;
        readonly team_member_id: TeamMember.TeamMemberId;
        readonly discord_channel_id: Discord.Snowflake;
        readonly channel_format: string;
        readonly bucket: PersonalEventChannel.PersonalChannelBucket;
      }) =>
        deps.personalChannels.savePersonalChannelId(
          team_id,
          team_member_id,
          discord_channel_id,
          channel_format,
          bucket,
        ),

      'Guild/SavePersonalChannelFormat': ({
        team_id,
        team_member_id,
        channel_format,
        bucket,
      }: {
        readonly team_id: Team.TeamId;
        readonly team_member_id: TeamMember.TeamMemberId;
        readonly channel_format: string;
        readonly bucket: PersonalEventChannel.PersonalChannelBucket;
      }) =>
        deps.personalChannels.savePersonalChannelFormat(
          team_id,
          team_member_id,
          channel_format,
          bucket,
        ),

      'Guild/MarkTeamPersonalEventsDirty': ({ team_id }: { readonly team_id: Team.TeamId }) =>
        deps.events.markTeamUpcomingEventsPersonalMessagesDirty(team_id),

      'Guild/IdentifyEventsChannel': ({
        guild_id,
        channel_id,
        discord_user_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly channel_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
      }) =>
        deps.teams.findByGuildId(guild_id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.succeed(
                  identifyResult({
                    kind: 'none',
                    team_id: Option.none(),
                    team_member_id: Option.none(),
                    owner_discord_id: Option.none(),
                    is_admin: false,
                  }),
                ),
              onSome: (team) =>
                // Resolve the caller's team membership to gate on the `team:manage`
                // permission (Sideline's admin gate — Discord perms aren't used here).
                deps.members.findMembershipByDiscordAndTeam(discord_user_id, team.id).pipe(
                  Effect.map(
                    Option.match({
                      onNone: () => false,
                      onSome: (membership) => membership.permissions.includes('team:manage'),
                    }),
                  ),
                  Effect.flatMap((isAdmin) =>
                    deps.personalChannels.findPersonalChannelOwner(team.id, channel_id).pipe(
                      Effect.map(
                        Option.match({
                          onNone: () =>
                            identifyResult({
                              kind: 'none',
                              team_id: Option.some(team.id),
                              team_member_id: Option.none(),
                              owner_discord_id: Option.none(),
                              is_admin: isAdmin,
                            }),
                          onSome: (owner) =>
                            identifyResult({
                              kind: 'personal',
                              team_id: Option.some(team.id),
                              team_member_id: Option.some(owner.team_member_id),
                              owner_discord_id: Option.some(owner.discord_id),
                              is_admin: isAdmin,
                            }),
                        }),
                      ),
                    ),
                  ),
                ),
            }),
          ),
        ),

      'Guild/CheckTeamAdmin': ({
        guild_id,
        discord_user_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
      }) =>
        deps.teams.findByGuildId(guild_id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.succeed({ team_id: Option.none<Team.TeamId>(), is_admin: false }),
              onSome: (team) =>
                deps.members.findMembershipByDiscordAndTeam(discord_user_id, team.id).pipe(
                  Effect.map(
                    Option.match({
                      onNone: () => ({ team_id: Option.some(team.id), is_admin: false }),
                      onSome: (membership) => ({
                        team_id: Option.some(team.id),
                        is_admin: membership.permissions.includes('team:manage'),
                      }),
                    }),
                  ),
                ),
            }),
          ),
        ),

      // Server-side is the source of truth for validation — the bot's slash-command
      // payload uses permissive `String`/`Number` fields, so name, birth_date, and
      // jersey_number are re-validated/re-decoded here with the same schemas the
      // bot's own modal validation uses (`Auth.BirthDateString`,
      // `TeamMember.JerseyNumber`) before anything is persisted. `/complete` marks
      // the user's profile globally complete: name, birth date, gender, and
      // `is_profile_complete = true` are written via `deps.users.completeProfile`,
      // and the optional jersey number is written alongside it, all inside a
      // single transaction.
      'Guild/CompleteMemberProfile': ({
        guild_id,
        discord_user_id,
        name,
        birth_date,
        gender,
        jersey_number,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly name: string;
        readonly birth_date: string;
        readonly gender: User.Gender;
        readonly jersey_number: Option.Option<number>;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () =>
            deps.teams.findByGuildId(guild_id).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new GuildRpcModels.CompleteProfileGuildNotFound()),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          Effect.bind('membership', ({ team }) =>
            deps.members.findMembershipByDiscordAndTeam(discord_user_id, team.id).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new GuildRpcModels.CompleteProfileNotMember()),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          Effect.bind('validatedName', () => {
            const trimmed = name.trim();
            return trimmed.length > 0
              ? Effect.succeed(trimmed)
              : Effect.fail(new GuildRpcModels.CompleteProfileInvalidInput());
          }),
          Effect.bind('validatedBirthDate', () =>
            Schema.decodeUnknownEffect(Auth.BirthDateString)(birth_date).pipe(
              Effect.mapError(() => new GuildRpcModels.CompleteProfileInvalidInput()),
            ),
          ),
          Effect.bind('validatedJerseyNumber', () =>
            Option.match(jersey_number, {
              onNone: () => Effect.succeed(Option.none<TeamMember.JerseyNumber>()),
              onSome: (n) =>
                Schema.decodeUnknownEffect(TeamMember.JerseyNumber)(n).pipe(
                  Effect.map(Option.some),
                  Effect.mapError(() => new GuildRpcModels.CompleteProfileInvalidInput()),
                ),
            }),
          ),
          Effect.tap(({ membership, validatedName, validatedBirthDate, validatedJerseyNumber }) =>
            deps.sql
              .withTransaction(
                Effect.Do.pipe(
                  Effect.tap(() =>
                    deps.users
                      .completeProfile({
                        id: membership.user_id,
                        name: Option.some(validatedName),
                        birth_date: Option.some(DateTime.makeUnsafe(validatedBirthDate)),
                        gender: Option.some(gender),
                      })
                      .pipe(
                        Effect.catchTag('NoSuchElementError', () =>
                          LogicError.die('completeProfile: UPDATE returned no row'),
                        ),
                      ),
                  ),
                  Effect.tap(() =>
                    Option.match(validatedJerseyNumber, {
                      onNone: () => Effect.void,
                      onSome: (n) => deps.members.setJerseyNumber(membership.id, Option.some(n)),
                    }),
                  ),
                ),
              )
              .pipe(catchSqlErrors),
          ),
          Effect.map(({ validatedName, validatedBirthDate }) => ({
            name: validatedName,
            birth_date: validatedBirthDate,
            gender,
            jersey_number,
          })),
        ),

      'Guild/BeginSudoSession': ({
        guild_id,
        discord_user_id,
        system_channel_id,
        audit_message_id,
        started_at,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly system_channel_id: Discord.Snowflake;
        readonly audit_message_id: Discord.Snowflake;
        readonly started_at: DateTime.Utc;
      }) =>
        deps.teams.findByGuildId(guild_id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed({}),
              onSome: (team) =>
                deps.sudoSessions
                  .upsert({
                    team_id: team.id,
                    discord_user_id,
                    system_channel_id,
                    audit_message_id,
                    started_at,
                  })
                  .pipe(Effect.as({})),
            }),
          ),
        ),

      'Guild/EndSudoSession': ({
        guild_id,
        discord_user_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
      }) =>
        deps.teams.findByGuildId(guild_id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.succeed({
                  session: Option.none<{
                    readonly started_at: DateTime.Utc;
                    readonly system_channel_id: Discord.Snowflake;
                    readonly audit_message_id: Discord.Snowflake;
                  }>(),
                }),
              onSome: (team) =>
                deps.sudoSessions
                  .fetchAndDelete({ team_id: team.id, discord_user_id })
                  .pipe(Effect.map((session) => ({ session }))),
            }),
          ),
        ),

      'Guild/GetPersonalChannelsToRename': ({
        guild_id,
        limit,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly limit: number;
      }) =>
        deps.teams.findByGuildId(guild_id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.succeed<
                  ReadonlyArray<{
                    readonly team_id: Team.TeamId;
                    readonly team_member_id: TeamMember.TeamMemberId;
                    readonly discord_id: Discord.Snowflake;
                    readonly discord_channel_id: Discord.Snowflake;
                    readonly name: string;
                    readonly channel_format: string;
                    readonly bucket: PersonalEventChannel.PersonalChannelBucket;
                  }>
                >([]),
              onSome: (team) =>
                deps.personalChannels.getChannelsToRename(team.id, limit).pipe(
                  Effect.map(
                    Array.map((m) => ({
                      team_id: team.id,
                      team_member_id: m.team_member_id,
                      discord_id: m.discord_id,
                      discord_channel_id: m.discord_channel_id,
                      name: m.name,
                      channel_format: m.channel_format,
                      bucket: m.bucket,
                    })),
                  ),
                ),
            }),
          ),
        ),

      // Nastavitelná docházka (plan §6.6, S5): `Guild/GetPersonalChannel` is deleted.
      // `findOneOption` on `(team_id, team_member_id)` would return an arbitrary one
      // of up to three rows in split mode — silently wrong — and it has zero
      // consumers (verified by grep across `applications/bot`).

      'Guild/DeletePersonalChannel': ({
        team_id,
        team_member_id,
        bucket,
      }: {
        readonly team_id: Team.TeamId;
        readonly team_member_id: TeamMember.TeamMemberId;
        readonly bucket: PersonalEventChannel.PersonalChannelBucket;
      }) => deps.personalChannels.deletePersonalChannel(team_id, team_member_id, bucket),

      'Guild/ListPersonalChannelsForEvent': ({ event_id }: { readonly event_id: string }) =>
        deps.personalChannels.listPersonalChannelsForEvent(event_id),

      'Guild/GetPersonalChannelTargetCategory': ({ team_id }: { readonly team_id: Team.TeamId }) =>
        deps.teamSettings.findByTeamId(team_id).pipe(
          Effect.flatMap((settingsOpt) => {
            const baseCategory = Option.flatMap(
              settingsOpt,
              (s) => s.discord_personal_events_category_id,
            );
            if (Option.isNone(baseCategory)) {
              return Effect.succeed({
                category_id: Option.none<Discord.Snowflake>(),
                is_overflow: false,
              });
            }
            return deps.overflowCategories.listPersonalOverflowCategories(team_id).pipe(
              Effect.map((overflows) => {
                if (overflows.length === 0) {
                  return { category_id: baseCategory, is_overflow: false };
                }
                const resolvedOverflow = Array.findLast(overflows, (o) =>
                  Option.isSome(o.discord_category_id),
                );
                if (Option.isNone(resolvedOverflow)) {
                  return { category_id: baseCategory, is_overflow: false };
                }
                return {
                  category_id: resolvedOverflow.value.discord_category_id,
                  is_overflow: true,
                };
              }),
            );
          }),
        ),

      'Guild/AllocatePersonalOverflowCategory': ({ team_id }: { readonly team_id: Team.TeamId }) =>
        deps.overflowCategories.listPersonalOverflowCategories(team_id).pipe(
          Effect.flatMap((existing) => {
            const nextSequence = existing.length + 1;
            return deps.overflowCategories
              .allocatePersonalOverflowCategory(team_id, nextSequence)
              .pipe(
                Effect.map((idOpt) => ({
                  sequence: nextSequence,
                  exists: Option.isSome(idOpt),
                })),
              );
          }),
        ),

      'Guild/SavePersonalOverflowCategoryId': ({
        team_id,
        sequence,
        discord_category_id,
      }: {
        readonly team_id: Team.TeamId;
        readonly sequence: number;
        readonly discord_category_id: Discord.Snowflake;
      }) =>
        deps.overflowCategories.savePersonalOverflowCategoryId(
          team_id,
          sequence,
          discord_category_id,
        ),

      'Guild/ListPersonalOverflowCategories': ({ team_id }: { readonly team_id: Team.TeamId }) =>
        deps.overflowCategories
          .listPersonalOverflowCategories(team_id)
          .pipe(
            Effect.map((rows) =>
              rows.flatMap((row) =>
                Option.isSome(row.discord_category_id)
                  ? [{ sequence: row.sequence, discord_category_id: row.discord_category_id.value }]
                  : [],
              ),
            ),
          ),

      'Guild/GetAllUpcomingEventsForUser': ({
        guild_id,
        discord_user_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () =>
            deps.teams.findByGuildId(guild_id).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new EventRpcModels.GuildNotFound()),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          Effect.bind('member', ({ team }) =>
            SqlSchema.findOne({
              Request: Schema.Struct({ discord_user_id: Schema.String, team_id: Schema.String }),
              Result: Schema.Struct({ id: Schema.String, show_attendee_list: Schema.Boolean }),
              execute: (input) =>
                deps.sql`
                  SELECT tm.id, tm.show_attendee_list FROM team_members tm
                  JOIN users u ON u.id = tm.user_id
                  WHERE u.discord_id = ${input.discord_user_id} AND tm.team_id = ${input.team_id}
                    AND tm.active = true
                `,
            })({ discord_user_id, team_id: team.id }).pipe(
              Effect.catchTag('NoSuchElementError', () =>
                Effect.fail(new EventRpcModels.RsvpMemberNotFound()),
              ),
              Effect.mapError(() => new EventRpcModels.RsvpMemberNotFound()),
            ),
          ),
          Effect.bind('rows', ({ team, member }) =>
            SqlSchema.findAll({
              Request: Schema.Struct({
                team_id: Schema.String,
                team_member_id: Schema.String,
              }),
              Result: Schema.Struct({
                event_id: Schema.String,
                team_id: Schema.String,
                title: Schema.String,
                description: Schema.OptionFromNullOr(Schema.String),
                image_url: Schema.OptionFromNullOr(Schema.String),
                start_at: Schemas.DateTimeFromDate,
                end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
                location: Schema.OptionFromNullOr(Schema.String),
                location_url: Schema.OptionFromNullOr(Schema.String),
                event_type: Schema.String,
                yes_count: Schema.Number,
                no_count: Schema.Number,
                maybe_count: Schema.Number,
                coming_later_count: Schema.Number,
                my_response: Schema.OptionFromNullOr(EventRsvp.RsvpResponse),
                my_message: Schema.OptionFromNullOr(Schema.String),
                all_day: Schema.Boolean,
                status: Schema.String,
                start_date: Schema.String,
                end_date: Schema.String,
              }),
              execute: (input) =>
                deps.sql`
                  SELECT
                    e.id AS event_id,
                    e.team_id,
                    e.title,
                    e.description,
                    e.image_url,
                    e.start_at,
                    e.end_at,
                    e.location,
                    e.location_url,
                    e.event_type,
                    e.all_day,
                    e.status,
                    COALESCE(SUM(CASE WHEN er.response = 'yes' THEN 1 ELSE 0 END), 0)::int AS yes_count,
                    COALESCE(SUM(CASE WHEN er.response = 'no' THEN 1 ELSE 0 END), 0)::int AS no_count,
                    COALESCE(SUM(CASE WHEN er.response = 'maybe' THEN 1 ELSE 0 END), 0)::int AS maybe_count,
                    COALESCE(SUM(CASE WHEN er.response = 'coming_later' THEN 1 ELSE 0 END), 0)::int AS coming_later_count,
                    my_rsvp.response AS my_response,
                    my_rsvp.message AS my_message,
                    (e.start_at AT TIME ZONE COALESCE(ts.timezone, 'Europe/Prague'))::date::text
                        AS start_date,
                    (COALESCE(e.end_at, e.start_at)
                        AT TIME ZONE COALESCE(ts.timezone, 'Europe/Prague'))::date::text
                        AS end_date
                  FROM events e
                  LEFT JOIN event_rsvps er ON er.event_id = e.id
                  LEFT JOIN event_rsvps my_rsvp ON my_rsvp.event_id = e.id
                    AND my_rsvp.team_member_id = ${input.team_member_id}
                  LEFT JOIN team_settings ts ON ts.team_id = e.team_id
                  WHERE e.team_id = ${input.team_id}
                    AND ${deps.sql.unsafe(eventVisibleNow('e', "COALESCE(ts.timezone, 'Europe/Prague')"))}
                    AND (
                      e.member_group_id IS NULL
                      OR EXISTS (
                        WITH RECURSIVE descendant_groups AS (
                          SELECT id FROM groups WHERE id = e.member_group_id AND team_id = ${input.team_id}
                          UNION ALL
                          SELECT g.id FROM groups g JOIN descendant_groups dg ON g.parent_id = dg.id WHERE g.team_id = ${input.team_id}
                        )
                        SELECT 1 FROM group_members gm
                        WHERE gm.group_id IN (SELECT id FROM descendant_groups)
                          AND gm.team_member_id = ${input.team_member_id}
                      )
                    )
                  GROUP BY e.id, my_rsvp.response, my_rsvp.message, ts.timezone
                  ORDER BY ${deps.sql.unsafe(eventDayOrder('e', "COALESCE(ts.timezone, 'Europe/Prague')"))}
                `,
            })({ team_id: team.id, team_member_id: member.id }).pipe(
              Effect.catchTag(
                ['SqlError', 'SchemaError'],
                LogicError.withMessage(
                  (e) => `Failed querying all upcoming events for user: ${e.message}`,
                ),
              ),
            ),
          ),
          Effect.map(
            ({ rows, team, member }) =>
              new EventRpcModels.UpcomingEventsForUserResult({
                events: Array.map(
                  rows,
                  (row) =>
                    new EventRpcModels.UpcomingEventForUserEntry({
                      event_id: row.event_id,
                      team_id: row.team_id,
                      title: row.title,
                      description: row.description,
                      image_url: row.image_url,
                      start_at: row.start_at,
                      end_at: row.end_at,
                      location: row.location,
                      location_url: row.location_url,
                      event_type: row.event_type,
                      yes_count: row.yes_count,
                      no_count: row.no_count,
                      maybe_count: row.maybe_count,
                      coming_later_count: row.coming_later_count,
                      my_response: row.my_response,
                      my_message: row.my_message,
                      all_day: row.all_day,
                      status: row.status,
                      start_date: Option.some(row.start_date),
                      end_date: Option.some(row.end_date),
                      // ponytail: this raw inline query isn't joined to `event_types` — add
                      // the join here if this surface needs the name/color.
                      event_type_name: Option.none(),
                      event_type_color: Option.none(),
                    }),
                ),
                total: rows.length,
                team_id: team.id,
                show_attendee_list: member.show_attendee_list,
              }),
          ),
        ),
    };
  }),
  (handlers) => GuildRpcGroup.GuildRpcGroup.toLayer(handlers),
);
