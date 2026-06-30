# Discord Bot (`@sideline/bot`)

Discord bot built with dfx (Discord effect library) and Effect-TS.

## Architecture

```
src/
├── Bot.ts           — Composes commands + interactions + events into program
├── AppLive.ts       — Composable app layer (DiscordIx → HealthServer)
├── HealthServerLive.ts — Health check HTTP endpoint with gateway shard status
├── env.ts           — Environment config (token, intents, health port)
├── run.ts           — Runtime entrypoint (config, logging, NodeRuntime)
├── schemas.ts       — Dfx decode schemas (DfxTextChannel, DfxSyncableChannel, DfxGuildMember, DfxUser incl. global_name)
├── commands/        — Slash command registry (event/create, event/list, refresh-events, training/*, carpool/*, makanicko/*, finance/*, poll, info, summon, summarize)
├── interactions/    — Component interaction registry (buttons/selects/modals)
├── events/          — Gateway event handler registry (guild, member, invite, channel lifecycle)
├── services/        — Sync services (RoleSyncService, ChannelSyncService) and welcome helpers (InviteCache, inviteDiff, welcomeRenderer)
├── rcp/channel/     — Channel sync event handlers
│   ├── ProcessorService.ts    — Match.tag dispatcher for channel events; classifies failures as transient vs permanent
│   ├── channelUtils.ts        — Shared Discord helpers (deleteRole, deleteChannelAndRole)
│   ├── handleCreated.ts       — channel_created handler (channel-only, role-only, or both)
│   ├── handleUpdated.ts       — channel_updated handler (rename channel + role, update role color); each side optional
│   ├── handleDeleted.ts       — channel_deleted handler
│   ├── handleArchived.ts      — channel_archived handler (archive or fallback to delete)
│   ├── handleManagedRestored.ts — managed channel_restored handler (move channel to parent_id=null; no delete-fallback, no RPC)
│   ├── handleDiscordRestored.ts — discord channel_restored handler (move channel to parent_id=null; no delete-fallback, no RPC)
│   ├── handleDetached.ts      — channel_detached handler (removes role permission overwrite; keeps channel + role)
│   ├── handleMemberAdded.ts   — member_added handler (lazily creates role + permission overwrite when mapping has channel but no role)
│   ├── handleMemberRemoved.ts — member_removed handler
│   └── handleRosterChannelCreated.ts — roster channel_created handler
└── rest/channels/   — Discord REST helpers for channel/role lifecycle
    ├── createChannelWithRole.ts — Create both channel + role + permission overwrite (used when event carries both names)
    ├── createChannelOnly.ts     — Create hidden channel; persist channel id via `Channel/UpsertGroupChannel` BEFORE creating role
    ├── createRoleOnly.ts        — Create role only; no channel, no permission overwrite
    └── createRoleForChannel.ts  — Create role + apply permission overwrite for an existing channel
└── rcp/event/       — Event sync event handlers
    ├── ProcessorService.ts             — Match.tag dispatcher for event sync events
    ├── ChannelReorderSemaphore.ts      — Per-channel mutex registry (ServiceMap.Service) used to serialise concurrent reorders on the same channel
    ├── reorderChannelMessages.ts       — Channel reorder algorithm (longest keepable prefix); exports MAX_CHANNEL_EVENTS = 10, plus `longestKeepablePrefix` and `compareSnowflakes` reused by the personal-channel reorder
    ├── recoverDeletedMessages.ts       — Startup recovery: bulk listMessages + snowflake overrides → reorderChannelMessages
    ├── handleCreated.ts                — event_created handler
    ├── handleUpdated.ts                — event_updated handler
    ├── handleCancelled.ts              — event_cancelled handler
    ├── handleStarted.ts                — event_started handler (updates embed, removes RSVP buttons)
    ├── handleRsvpReminder.ts           — rsvp_reminder handler
    ├── handleTrainingClaimRequest.ts   — training_claim_request handler (posts claim embed into the persistent owners claim thread, saves message id back via Event/SaveClaimDiscordMessageId)
    ├── handleTrainingClaimUpdate.ts    — training_claim_update handler (edits existing claim embed in place)
    ├── handleUnclaimedTrainingReminder.ts — unclaimed_training_reminder handler (posts reminder pointing to claim message)
    ├── handleEventRosterApprovalRequest.ts — event_roster_approval_request handler (resolves/creates owners thread, posts approval embed + Approve/Decline buttons, saves message id back via Event/SaveApprovalRequestMessageId)
    ├── handleEventRosterApprovalCancel.ts — event_roster_approval_cancel handler (deletes the approval thread message; swallows 10008)
    └── handleEventRosterThreadDelete.ts — event_roster_thread_delete handler (deletes the entire owners approval thread; swallows 10003)
└── rest/events/     — Embed builder functions
    ├── buildEventEmbed.ts              — Main event embed (RSVP counts, "Going" field)
    ├── buildAttendeesEmbed.ts          — Paginated attendee list embed
    ├── buildUpcomingEventEmbed.ts      — Per-user upcoming events embed (/event list + personal-channel messages)
    ├── buildClaimMessage.ts            — Coach-claim embed + Claim/Release button row
    ├── buildRosterApprovalMessage.ts   — Roster-approval embed + Approve/Decline button row (status-colored; disabled row for decided/withdrawn states)
    └── sendUpcomingEventFollowups.ts   — Shared helper: sends one ephemeral follow-up message per event (max 10)
```

Follows the **AppLive + run.ts** pattern.

### Folder Naming Conventions

| Path | Holds | Rule |
|------|-------|------|
| `src/rcp/<feature>/` | Sync-event processors (`ProcessorService.ts`, `handle*.ts`). | Folder is named `rcp`, NOT `rpc` — historical typo carried through every feature. Do NOT rename, split, or alias. New sync workers go under `src/rcp/<feature>/`. |
| `src/rest/<feature>/` | Discord-REST-calling helpers and embed builders (`build<Name>Embed.ts`, send/edit helpers). | Embed builders MUST live here, NEVER under `src/rcp/`. The processor in `src/rcp/<feature>/` imports the embed builder from `src/rest/<feature>/`, never the reverse. |
| `test/rcp/<feature>/` | Tests for the matching processor. | Mirrors `src/rcp/<feature>/` 1:1. |

## Discord REST Retry Pattern

Every bot handler that calls `rest.<method>(...)` and wraps it in `Effect.retry(retryPolicy)` MUST defer the REST call with `Effect.suspend`. In Effect v4 beta, `rest.createMessage(channelId, body)` evaluates eagerly and returns a fixed `Effect` value — `Effect.retry` re-runs that same frozen description instead of re-invoking the function. The result is that the API call fires exactly once even though the retry policy schedules N attempts.

### Canonical Shape

```ts
Effect.suspend(() => rest.createMessage(channelId, { embeds })).pipe(
  Effect.catchTag('ErrorResponse', (err) =>
    err.response.status === 404
      ? Effect.logWarning(`Channel ${channelId} not found (404), skipping`)
      : Effect.fail(err),
  ),
  Effect.retry(retryPolicy),
);
```

### Rules

1. **Always wrap `rest.<method>(...)` in `Effect.suspend(() => ...)`** when the call sits inside `Effect.retry(...)`. The single exception is `rest.addGuildMemberRole` and other REST methods that are themselves thunked by dfx — when unsure, default to `Effect.suspend`; the cost of an extra suspension is negligible.
2. **`Effect.catchTag(...)` MUST come BEFORE `Effect.retry(...)` in the pipe.** A permanent error (`404`, `50001`, `50013`) should short-circuit the retry; with the reverse order, retry burns its full attempt budget (4 attempts) before `catchTag` ever sees the failure. Reference: the canonical layout in `src/rcp/weeklyChallenge/handleWeeklyChallengeReady.ts` and `src/rcp/achievement/handleAchievementEarned.ts`.
3. **Latent-bug references** (do not copy these — they pre-date this rule):
   - `src/rcp/weeklySummary/handleWeeklySummaryReady.ts` has `retry` BEFORE `catchTag` AND lacks `Effect.suspend`. When next touched, hoist `catchTag` above `retry` and wrap the call in `Effect.suspend(() => ...)`.
   - `src/rcp/achievement/handleAchievementEarned.ts` has the correct catchTag/retry order but lacks `Effect.suspend`. When next touched, add the suspend wrapper.
4. **Test the retry count.** A handler test that exercises a non-404 `ErrorResponse` MUST assert `rest.<method>` was called exactly `1 + Schedule.recurs(N)` times (4 for the standard `retryPolicy`). Without this assertion, the suspend bug regresses silently. Reference: the `403/50001` and `403/50013` tests in `applications/bot/test/rcp/weeklyChallenge/ProcessorService.test.ts` assert `createMessage.length === 4`.

### Permanent-Error Fallback With a Relaxed Parameter (`retry({ schedule, while })` + `catchIf`)

When a REST call carries an **optional input that may be stale at runtime** (e.g. a `parent_id` category that the user deleted in Discord after Sideline stored it), retry only the transient failures with the input intact, then on a permanent error fall back to the call WITHOUT that input. Use this exact two-stage shape — do NOT wrap the fallback in an outer retry, or a retry-on-re-entry can mint duplicate resources. Reference: `createDiscordChannelAndRole` in `src/rest/channels/createChannelWithRole.ts` (stale `parent_id` → guild-root fallback).

```ts
Effect.suspend(() => rest.createGuildChannel(guildId, withParentParams)).pipe(
  // Retry only WHILE the error is transient; a permanent error exits immediately
  // instead of burning the retry budget.
  Effect.retry({ schedule: retryPolicy, while: (e) => !isPermanentError(e) }),
  // Permanent error → log a warning and fall back to the relaxed call. The fallback
  // has its OWN retryPolicy and is terminal — no outer retry wraps it.
  Effect.catchIf(isPermanentError, () =>
    Effect.logWarning(`... falling back ...`).pipe(
      Effect.flatMap(() =>
        Effect.suspend(() => rest.createGuildChannel(guildId, rootParams)).pipe(
          Effect.retry(retryPolicy),
        ),
      ),
    ),
  ),
);
```

Rules:

1. **Use the shared `isPermanentError`** (`src/rcp/channel/ProcessorService.ts`) as both the retry `while` predicate (negated) and the `catchIf` predicate — never re-classify errors inline here. This keeps the transient/permanent decision in exactly one place (see "Channel Sync Event Failure Classification" below).
2. **The fallback path is terminal.** Wrap only the fallback's own REST call in `Effect.retry(retryPolicy)`; never put an outer `Effect.retry` around the whole `retry`+`catchIf` pipe — re-entry after a permanent error must not re-create the already-created resource.
3. **Only apply the parameter-relaxed branch when the optional input is present.** When the optional input is absent, issue the plain `Effect.suspend(() => ...).pipe(Effect.retry(retryPolicy))` call with no `catchIf` fallback.

## Gateway Event Handlers (`src/events/index.ts`)

Gateway event handlers react to Discord gateway dispatch events (e.g. `GuildCreate`, `ChannelDelete`, `GuildMemberAdd`). All handlers are defined in `src/events/index.ts` and registered via `gateway.handleDispatch`.

### Pattern: Syncable Channel Events (ChannelCreate, ChannelDelete, ChannelUpdate)

These handlers sync Discord channel state to the server's `discord_channels` table via Guild RPCs. They follow a strict pattern:

1. Decode the raw payload with `decodeSyncableChannel(channel)` (returns `Option<DfxSyncableChannel>`)
2. `Option.match` on the result:
   - `onNone`: `Effect.logDebug('Skipping non-syncable channel event')` — silently skip unsupported channel types
   - `onSome`: execute the handler body
3. Handler body uses `Effect.Do.pipe`:
   - `Effect.tap` → increment `discordEventsTotal` metric with `event_type` tag
   - `Effect.tap` → `Effect.logInfo` with channel name, id, and guild_id
   - `Effect.tap` → call the appropriate Guild RPC (`Guild/UpsertChannel` for create/update, `Guild/DeleteChannel` for delete)
   - `Effect.catchTag('RpcClientError', (error) => Effect.logError(...))` — log and swallow RPC failures
   - `Effect.withSpan('discord/<event_name>', { attributes: { 'guild.id': channel.guild_id } })`
4. The `guild_id` comes from the raw `channel` payload (not the decoded struct), because the raw Discord payload includes `guild_id` at the top level

```typescript
// Example: ChannelCreate handler
Effect.let('channelCreate', ({ gateway, rpc }) =>
  gateway.handleDispatch(DiscordTypes.GatewayDispatchEvents.ChannelCreate, (channel) =>
    Option.match(decodeSyncableChannel(channel), {
      onNone: () => Effect.logDebug('Skipping non-syncable channel event'),
      onSome: (decoded) =>
        Effect.Do.pipe(
          Effect.tap(() =>
            Metric.update(pipe(discordEventsTotal, Metric.tagged('event_type', 'channel_create')), 1),
          ),
          Effect.tap(() => Effect.logInfo(`Channel created: ${decoded.name} (${decoded.id}) in guild ${channel.guild_id}`)),
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
```

### Adding a New Gateway Event Handler

1. Add an `Effect.let('<handlerName>', ({ gateway, rpc, rest }) => ...)` entry in the `eventHandlers` pipe
2. Use `gateway.handleDispatch(DiscordTypes.GatewayDispatchEvents.<Event>, (payload) => ...)` to register the handler
3. If the event payload needs schema validation, decode with `Schema.decodeUnknownOption` and use `Option.match` (see channel pattern above)
4. Always increment `discordEventsTotal` metric with `Metric.tagged('event_type', '<snake_case_name>')`
5. Always add `Effect.withSpan('discord/<event_name>', { attributes: { 'guild.id': ... } })`
6. Always catch expected errors (e.g. `RpcClientError`) with `Effect.catchTag` and log them — never let RPC failures crash the handler
7. Add the handler name to the destructuring in the final `Effect.map` and include it in the returned array
8. Add an `expect(registeredEvents).toContain(Discord.GatewayDispatchEvents.<Event>)` assertion in `test/events.test.ts` and update the `toHaveLength` count

## Welcome Flow (`GuildMemberAdd` + invite attribution)

The bot attributes a joining member to a specific Sideline invite by diffing Discord's invite-usage counts before and after the member joins. The `Guild/RegisterMember` RPC returns optional welcome metadata that the bot then renders into one or two Discord messages.

### Required Gateway Intent

`DISCORD_GATEWAY_INTENTS` in `src/env.ts` defaults to `Guilds | GuildMembers | GuildInvites`. **`GuildInvites` is required** — without it, Discord does not dispatch `InviteCreate` / `InviteDelete` events and the in-memory invite cache cannot track use counts. Never remove this intent from the default.

### Components

| File | Purpose |
|------|---------|
| `src/services/InviteCache.ts` | In-memory `ServiceMap.Service` (`bot/InviteCache`) that holds `Map<guild_id, Map<code, uses>>`. Updated by `InviteCreate` / `InviteDelete` handlers. |
| `src/services/inviteDiff.ts` | Pure function `inviteDiff(before, after): Option<code>`. Returns `Some(code)` only when exactly one known code's `uses` increased. Returns `None` if the baseline is empty (lazy-seed: first join after bot startup is unattributable) or the winner is ambiguous. Never imports Effect runtime — it is a pure helper. |
| `src/services/welcomeRenderer.ts` | Pure embed builders `buildWelcomeEmbed` and `buildSystemLogEmbed`. Return `APIEmbed` from `discord-api-types/v10`. No Effect. |

### `InviteCache` API

| Method | Purpose |
|--------|---------|
| `upsert(guildId, code, uses)` | Called from `InviteCreate` and to seed entries. |
| `remove(guildId, code)` | Called from `InviteDelete`. |
| `snapshot(guildId)` | Read-only access for tests/diagnostics. |
| `diffOnMemberJoin(guildId, fresh)` | Atomically diffs against the prior snapshot, replaces the snapshot with `fresh`, and returns the matched code (or `None`). Always replaces the snapshot — even if the diff is ambiguous — so subsequent joins remain attributable. |

### `GuildMemberAdd` Pipeline

`src/events/index.ts → guildMemberAdd` performs the following, in order, inside a single `Effect.Do.pipe`:

1. Skip bots (`if (user.bot) return`).
2. `rest.listGuildInvites(member.guild_id)` to fetch fresh invite usage. Failure is caught (`HttpClientError | RatelimitedResponse | ErrorResponse`) and returns `[]` — the diff will then yield `None` and registration proceeds without an attributed code.
3. `inviteCache.diffOnMemberJoin(guild_id, fresh)` returns `Option<code>`.
4. `rpc['Guild/RegisterMember']({ ..., invite_code })` returns `Option<WelcomeMeta>` (see server AGENTS.md). `None` means the guild is not linked to a team — nothing else to do.
5. On `Some`, render two independent messages concurrently (`Effect.all([...], { concurrency: 'unbounded' })`):
   - **System log** — sent if `system_log_channel_id` is `Some`. Uses `buildSystemLogEmbed`. Always sent (even when the invite was unattributed) so captains see every join.
   - **Welcome message** — sent only if both `welcome.welcome_channel_id` and `welcome.welcome_message_rendered` are `Some`. Uses `buildWelcomeEmbed`. Sent with `content: <@member_id>` and `allowed_mentions: { parse: [], users: [member_id, inviter_id?] }` so only the joiner and (optionally) the inviter receive a ping — never `@everyone` or roles.

### Rules When Modifying the Welcome Flow

1. **Never render the welcome template in the bot.** The server renders `welcome_message_template` via `@sideline/template-renderer` and returns `welcome_message_rendered` already substituted and sanitized. The bot must not call `applyTemplate` itself.
2. **Always pass `allowed_mentions: { parse: [] }` and an explicit `users` allow-list** when sending welcome messages — `sanitizeRendered` neuters `@everyone` / `@here` literals, but the embed `description` could still contain other mention syntax.
3. **Never add denormalised welcome metadata to the bot.** Channel ids, group color, inviter discord id all come from `Guild/RegisterMember`'s response. The bot must not look these up itself.
4. **`inviteDiff` and `welcomeRenderer` must remain Effect-free.** They live under `src/services/` for proximity to consumers but follow the pure-function rule of `@sideline/template-renderer`.

## Discord Sync Architecture

The bot and server communicate via an **event-driven polling pattern** for syncing Discord resources.

### Role Sync (roles ↔ Discord roles)

Syncs team roles to Discord guild roles. When roles are created/deleted/assigned/unassigned, the server emits events to `role_sync_events`.

| Component | File |
|-----------|------|
| Domain model | `packages/domain/src/models/RoleSyncEvent.ts` |
| Bot service | `src/services/RoleSyncService.ts` |
| Mapping table | `discord_role_mappings` (team_id + role_id → discord_role_id) |

Event types: `role_created`, `role_deleted`, `role_assigned`, `role_unassigned`

### Channel Sync (groups ↔ Discord channels)

Syncs groups to private Discord text channels with per-user permission overwrites. The guild sync uses `DfxSyncableChannel` (type 0 = text, type 4 = category) to sync both text and category channels from Discord to the database.

| Component | File |
|-----------|------|
| Domain model | `packages/domain/src/models/ChannelSyncEvent.ts` |
| Bot service | `src/services/ChannelSyncService.ts` |
| Mapping table | `discord_channel_mappings` (team_id + group_id → discord_channel_id) |

`channel_sync_events.entity_type` is one of `group`, `roster`, `managed`, or `discord`. The same `event_type` literals (`channel_created`, `channel_archived`, `channel_deleted`, `member_added`, `member_removed`) carry a different RPC event class per `entity_type` — `ProcessorService.ts` dispatches on the decoded RPC event `_tag`, not on `event_type`. `entity_type='managed'` events decode to the `Managed*` RPC event classes (see "Managed Channels" below). `channel_updated` + `managed` is the adoption event — it decodes to `ManagedChannelAdoptedEvent` (handled by `handleManagedAdopted`); `channel_detached` is **never** emitted with `entity_type='managed'` (that `Match.when('managed', ...)` branch in `src/rpc/channel/events.ts` is an impossible-state guard that fails with `EventPropertyMissing`). `entity_type='discord'` is valid **only** with `event_type` ∈ `channel_archived` (decodes to `DiscordChannelArchivedEvent`, handled by `handleDiscordArchived`) and `channel_restored` (decodes to `DiscordChannelRestoredEvent`, handled by `handleDiscordRestored`); every other `event_type` for `discord` is an impossible-state guard that fails with `EventPropertyMissing`. `channel_restored` + `managed` decodes to `ManagedChannelRestoredEvent` (handled by `handleManagedRestored`).

Because `ProcessorService.ts` now exceeds the 20-argument `Match.type(...).pipe(...)` overload limit, the dispatcher is split into two chains: `actionMatcher` holds the first set of `Match.tag` arms and `action` pipes the remainder (`managed_access_revoked`, `discord_channel_archived`, `managed_channel_adopted`, `managed_channel_restored`, `discord_channel_restored`) before `Match.exhaustive`. Add new tags to whichever chain has room; never collapse them back into a single `pipe` past 20 arms.

Event types: `channel_created`, `channel_updated`, `channel_deleted`, `channel_archived`, `channel_detached`, `member_added`, `member_removed`

**Name fields on `channel_created` and `channel_updated` events**: The server pre-formats Discord names using team settings. Events carry separate `discord_channel_name` (`Option<string>`; `None` means "do not create a channel, role-only mapping") and `discord_role_name` (`string`, always present). Bot handlers must use these fields instead of deriving names from `group_name`/`roster_name`. `member_added` is the only handler permitted to fall back to `group_name` when lazily provisioning a role for an existing channel-only mapping.

**Color field on `channel_created` and `channel_updated` events**: Events carry `discord_role_color` as `Option<number>` (Discord integer color). The server converts hex colors (e.g. `#FF0000`) to Discord integers before emitting. Bot handlers pass this value to `createRoleForChannel`, `createRoleOnly`, or `updateGuildRole` as the `color` parameter.

#### Channel ↔ Role Decoupling

A group's Discord presence is one of: **channel + role** (both created), **role only** (no Discord channel), or **channel only** (transient — only seen mid-provision after `Channel/UpsertGroupChannel` fires but before role creation, or after detach). `discord_channel_mappings.discord_channel_id` and `discord_role_id` are independently nullable; the DB enforces `discord_channel_id IS NOT NULL OR discord_role_id IS NOT NULL`. Every event payload now carries both ids as `Option<Snowflake>`.

Server-owned vs. bot-owned mapping writes:

| Caller | RPC | Semantics |
|--------|-----|-----------|
| Server (HTTP API) | `Channel/UpsertMapping` | Insert/update both ids. |
| Bot (`handleCreated` channel+role path) | `Channel/UpsertMapping` | Sets both ids after channel + role are created. |
| Bot (`handleCreated` channel-only path) | `Channel/UpsertGroupChannel` THEN `Channel/UpsertMapping` | Persist channel id BEFORE role creation, then update both after role. |
| Bot (`handleCreated` role-only / `handleMemberAdded` lazy role) | `Channel/UpsertMappingRoleOnly` | Sets only `discord_role_id`, leaves channel id untouched. |
| Server (detach / archive) | `Channel/UpsertGroupChannel` cleared via `clearGroupChannel` repository method | Server clears `discord_channel_id`; the mapping row stays so the role survives. |
| Bot (`handleDeleted` only) | `Channel/DeleteMapping` | Deletes the entire mapping row. Never call this from `handleArchived` or `handleDetached`. |
| Bot (`handleRosterChannelCreated`) | `Channel/UpsertRosterMapping` THEN `Channel/UpdateRosterChannel` | Roster-flow parallel of the group family. Upsert both ids after channel + role are created, then link the new channel back onto the roster. Skip `Channel/UpdateRosterChannel` when the channel already existed in the mapping. See rule 8. |

Rules:

1. **`handleCreated`** dispatches on `(existing_channel_id, discord_channel_name)`:
   - `existing_channel_id = Some` → use `createRoleForChannel` against the existing channel, then `Channel/UpsertMapping` with both ids.
   - `existing_channel_id = None` AND `discord_channel_name = Some` → call `createChannelOnly`, then immediately `Channel/UpsertGroupChannel` (persist channel id), then `createRoleForChannel`, then `Channel/UpsertMapping`. The intermediate upsert prevents orphan Discord channels if role creation fails and the event retries.
   - `existing_channel_id = None` AND `discord_channel_name = None` → the role-only path is **`Channel/GetMapping`-first** (mirrors `handleMemberAdded`, rule 2) so a retried or backfilled event never mints a duplicate Discord role: mapping has `discord_role_id = Some` → NO-OP (no `createRoleOnly`, no upsert); mapping `None` → `createRoleOnly` + `Channel/UpsertMappingRoleOnly`; mapping has `discord_channel_id = Some, discord_role_id = None` → `createRoleForChannel` against the existing channel + `Channel/UpsertMapping` (NOT `UpsertMappingRoleOnly`). No channel is created.
   - **Every branch resolves a single `roleId`, then runs ONE shared member-backfill step** (mirrors `handleRosterChannelCreated`, rule 8): after `roleId` is resolved, read `Channel/GetGroupMembers({ team_id, group_id })` and backfill each member's role with the per-member backfill loop (rule 9). Do NOT inline a separate backfill per dispatch branch — the role-creation branches differ only in how they yield `roleId`. The role-only paths (`createRoleOnly` + role-only upsert) are extracted into the shared `provisionRoleOnly` helper at the top of `handleCreated.ts`. Regression coverage: `applications/bot/test/rcp/channel/handleCreated.test.ts`.
2. **`handleMemberAdded`** must NEVER call `createGuildChannel`. It reads the mapping via `Channel/GetMapping` and:
   - mapping `None` → `createRoleOnly` + `Channel/UpsertMappingRoleOnly` + `addGuildMemberRole`.
   - mapping has `discord_role_id = Some` → `addGuildMemberRole` only.
   - mapping has `discord_channel_id = Some, discord_role_id = None` → `createRoleForChannel` against the existing channel + `Channel/UpsertMapping` + `addGuildMemberRole`.
3. **`handleUpdated`** processes each side independently: `Option.match` on `discord_role_id` (update role name + color) and on `discord_channel_id` (rename channel + call `Guild/UpdateChannelName`). If both are `None`, log a warning and no-op — never throw.
4. **`handleDeleted`** deletes the channel (if `discord_channel_id = Some`) and the role (if `discord_role_id = Some`) independently, then calls `Channel/DeleteMapping`. This is the only path that removes the mapping row.
5. **`handleArchived`** moves the channel to the archive category if `discord_channel_id = Some`; on failure falls back to deleting only the channel (`Option.none()` for role). It does NOT delete the role, does NOT call `Channel/DeleteMapping` — the server has already cleared `discord_channel_id` via `clearGroupChannel` before emitting.
6. **`handleDetached`** deletes the role's permission overwrite from the channel when both ids are `Some`; otherwise no-op. It does NOT delete the role, does NOT delete the channel, does NOT call `Channel/DeleteMapping` — the server has already cleared `discord_channel_id`.
7. **Never re-introduce `ensureMapping`.** The helper was removed; provisioning is split across `createChannelOnly` / `createRoleOnly` / `createRoleForChannel` / `createChannelWithRole`, each with a narrow contract. Splitting prevents racy fat-upserts that would nullify the unrelated column.
8. **`handleRosterChannelCreated`** (`src/rcp/channel/handleRosterChannelCreated.ts`) is the `roster` `channel_created` handler. It is **`Channel/GetRosterMapping`-first** for idempotency, then backfills the roster's members onto the role. Provision order:
   - Read the mapping via `Channel/GetRosterMapping({ team_id, roster_id })`, then resolve `roleId`:
     - mapping has `discord_role_id = Some` → reuse it; do NOT create a role, do NOT upsert (NO-OP on the role axis).
     - mapping has `discord_channel_id = Some, discord_role_id = None` → `createRoleForChannel` against the existing channel + `Channel/UpsertRosterMapping`; do NOT call `Channel/UpdateRosterChannel` (the channel already exists in the mapping).
     - mapping `None`, OR mapping with both ids `None` → `provisionChannelAndRole`: when `event.existing_channel_id = Some` call `createRoleForChannel`, otherwise `createDiscordChannelAndRole`; then `Channel/UpsertRosterMapping` + `Channel/UpdateRosterChannel` (link the new channel back onto the roster).
   - After `roleId` is resolved, read `Channel/GetRosterMembers({ team_id, roster_id })` and backfill each member's role with the per-member backfill loop (see rule 9). Reusing the resolved role on a retried/backfilled event is what makes the handler idempotent. Regression coverage: `applications/bot/test/rcp/channel/handleRosterChannelCreated.test.ts`.
9. **Per-member role-backfill loop.** When a handler grants a role to many members in one pass (`handleRosterChannelCreated` and `handleCreated`), use `Effect.forEach(members, ..., { concurrency: 1 })` (serialised to avoid Discord rate-limit storms) where each iteration is:
   ```ts
   rest.addGuildMemberRole(guildId, member.discord_user_id, roleId).pipe(
     // Retry transient failures only; a permanent error exits immediately.
     Effect.retry({ schedule: retryPolicy, while: (e) => !isPermanentError(e) }),
     // Isolate each member: one failure must NOT abort the rest of the loop.
     Effect.exit,
     Effect.flatMap((exit) =>
       Exit.match(exit, {
         onSuccess: () => Effect.void,
         onFailure: (cause) => Effect.logWarning(`Failed to add role ... ${String(cause)}`),
       }),
     ),
   )
   ```
   Rules: (a) use the shared `isPermanentError` (`src/rcp/channel/ProcessorService.ts`) as the negated `while` predicate — never re-classify inline; (b) wrap each iteration in `Effect.exit` + `Exit.match` so a single member's permanent failure is logged-and-skipped, not propagated (one bad member must not fail the whole event and trigger a re-process that re-grants the others); (c) keep `concurrency: 1`. Do NOT use `Effect.catchIf` here — the `Effect.exit` isolation is required because the loop must continue past a permanent failure.

#### Channel Backfill (self-healing role provisioning)

Group→Discord-role provisioning is event-driven, so a group created BEFORE its team's guild was linked (or while the bot was down) can end up role-less forever — no `channel_created` event was ever emitted. `ChannelBackfillService` (`src/rcp/channel/BackfillService.ts`, wired in `src/rcp/channel/index.ts`) is the safety net: on each `slowPollLoop` (5min) tick it calls `Channel/BackfillMissingGroupRoles({ team_id: None, limit: None })`. The server finds non-archived groups whose mapping has no `discord_role_id` AND no unprocessed/un-errored `channel_created`/`channel_updated` event, then re-emits a provisioning `channel_created` event for each (see `applications/server/AGENTS.md` → "Group-role backfill and grant reapply").

Rules:

1. **The backfill only enqueues events — it never touches Discord directly.** The re-emitted `channel_created` events are processed by the normal `channels` `pollLoop` through the same `handleCreated` dispatch. The role-only GetMapping-first idempotency (rule 1 above) is what makes a backfilled event a NO-OP if the role already exists.
2. **The backfill RPC returns the enqueued count** (`Schema.Number`); the service logs `Backfilled N missing group roles` only when `N > 0` and otherwise stays quiet.
3. **`team_id` and `limit` are `Option`** (`Schema.OptionFromNullOr`) — the cron passes `None`/`None` (server defaults the limit to 20). Do not hard-code a team or a non-default limit in the cron tick.

#### Roster role remove-extras reconcile (fail-closed)

`handleRosterRoleReconcile` (`src/rcp/channel/handleRosterRoleReconcile.ts`) processes the `roster_role_reconcile` RPC event tag — the REMOVE half of the team-wide "Sync roster roles with Discord" button (the ADD half is `roster_channel_created` backfill). It is the ONLY channel handler that does a LIVE Discord read to compute a delete diff: it paginates `listGuildMembers` to find every current holder of `event.discord_role_id`, asks the server `Channel/GetExpectedRoleHolders` for who SHOULD hold it, and removes the role (`deleteGuildMemberRole`, per-member concurrency-1 loop, same shape as rule 9) from holders not in the expected set. The server-side shared-role union contract lives in `applications/server/AGENTS.md` → "Roster-role remove-extras reconcile".

Rules (all MUST be preserved — this is the only handler that strips roles in bulk):

1. **Fail closed: never remove a role when the holder list or the expected set could not be fully read.** `collectRoleHolders` catches every `listGuildMembers` page failure (`HttpClientError | RatelimitedResponse | ErrorResponse`) and returns `[]` — an empty holder list yields an empty `extras` set, so a partial/failed read removes NOBODY rather than treating unread members as extras. If `Channel/GetExpectedRoleHolders` fails, the whole handler fails and the event is retried (never falls through to a removal with an empty expected set). Any future bulk role/member removal handler MUST adopt the same fail-closed default: a read error means "remove nothing", never "remove everything not seen".
2. **`listGuildMembers` MUST be paginated with a STRING `after` cursor.** Discord snowflakes exceed `Number.MAX_SAFE_INTEGER`, so the cursor cannot be a JS number. dfx mistypes `after` as `number`; pass the string id with a `// @ts-expect-error` and compute the next cursor as the max id on the page via `BigInt(a) > BigInt(b)` comparison (page order is not guaranteed). Cap the walk at `MAX_PAGES` (50) and treat hitting the cap as a partial read (log a warning) — combined with rule 1, a truncated walk still removes only confirmed extras, never members on unread pages.

#### Channel Sync Event Failure Classification

`ProcessorService.processEvent` wraps each handler in `Effect.catch` and routes failures via `isPermanentError(error)`:

| Trigger | RPC called | Effect on DB row |
|---------|------------|------------------|
| `error._tag === 'ErrorResponse'` with HTTP `403` or `404` | `Channel/MarkEventPermanentlyFailed` | `processed_at = now(), error = <msg>` — row stops polling. |
| `error._tag === 'ErrorResponse'` with Discord JSON code `50013` (Missing Perms) or `10000–10999` (Unknown resource) | `Channel/MarkEventPermanentlyFailed` | as above |
| `error._tag === 'ParseError'` or `'SchemaError'` | `Channel/MarkEventPermanentlyFailed` | as above |
| All other errors | `Channel/MarkEventFailed` | `error = <msg>` only — row stays unprocessed and is retried on next poll. |

Rules:

1. **Never delete a `channel_sync_events` row on failure.** Both RPCs only UPDATE — the row is kept for audit/observability.
2. **Never set `processed_at` on a transient failure.** Transient = handler should be re-tried next tick; only `MarkEventFailed` is correct.
3. **`EventPropertyMissing` (server-side decode failure in `events.ts`) always routes to `markPermanentlyFailed`.** Missing required identity fields cannot heal on retry.
4. **Do NOT add `error.message.includes('…')` checks to `isPermanentError`.** Classification is by `_tag` + structured fields only — string matching is fragile across dfx versions.

#### Channel Update

When a group or roster name/emoji/color changes, the server emits `channel_updated`. The bot handler in `src/rcp/channel/handleUpdated.ts`:

1. If `discord_role_id = Some` — update the Discord role via `updateGuildRole` (name + color).
2. If `discord_channel_id = Some` — update the Discord channel via `updateChannel` (name) and call `rpc['Guild/UpdateChannelName']` to sync the new channel name back to the server's `discord_channels` table.
3. If both are `None` — log a warning and return `Effect.void`.

`handleGroupChannelUpdated` and `handleRosterChannelUpdated` are sibling functions in the same file. Do not collapse them back into a single shared `handleChannelUpdated` — they differ in which RPCs they target and which mapping table is consulted.

#### Channel Archival

When a team has `discord_archive_category_id` set, deleting a group or deactivating a roster emits `channel_archived` instead of `channel_deleted`. The server clears `discord_channel_mappings.discord_channel_id` via `channelMappings.clearGroupChannel` **before** emitting. The bot handler in `src/rcp/channel/handleArchived.ts`:

1. If `discord_channel_id = None` — no-op.
2. If `discord_channel_id = Some` — move the channel to the archive category via `updateChannel({ parent_id })`. On failure, fall back to `deleteChannelAndRole(guild_id, channelId, Option.none())` (channel only — never the role).
3. On success, delete the role's permission overwrite for the archive channel.
4. Never call `Channel/DeleteMapping` — the mapping row stays so the (now role-only) presence is preserved.

#### Managed Channels

"Managed channels" are Sideline-authoritative Discord text channels (name/category/position/archived owned by the `team_channels` table, NOT by Discord). They are a third `entity_type` (`managed`) on `channel_sync_events`, distinct from the `group`/`roster` mapping flows above. Managed channels do NOT use `discord_channel_mappings` and do NOT have a per-channel role — access is enforced entirely via per-group Discord permission overwrites.

Bot handlers (registered in `ProcessorService.ts` via `Match.tag`):

| RPC event `_tag` | Handler file | Behavior |
|------------------|--------------|----------|
| `managed_channel_created` | `src/rcp/channel/handleManagedCreated.ts` | `createChannelOnly(guild_id, discord_channel_name)`, then `Channel/UpsertManagedChannel` to persist the new `discord_channel_id`. No role, no permission overwrite. |
| `managed_channel_adopted` | `src/rcp/channel/handleManagedAdopted.ts` (`handleManagedAdopted`) | `updateChannel(discord_channel_id, { permission_overwrites: [@everyone deny ViewChannel] })` — a full-REPLACE of the overwrite list (see REPLACE-semantics note below). No RPC ack; group grants arrive separately via `managed_access_granted`. |
| `managed_channel_archived` | `src/rcp/channel/handleManagedArchived.ts` | Move channel to `archive_category_id` via `updateChannel({ parent_id })`; on failure fall back to `deleteChannel`. Does **NOT** call `Channel/ClearManagedChannel` — the `team_channels.discord_channel_id` link is preserved through archive so restore can re-flip `archived` on the same row and the channel list de-dups consistently. |
| `managed_channel_restored` | `src/rcp/channel/handleManagedRestored.ts` (`handleManagedRestored`) | Move channel to uncategorized via `updateChannel(discord_channel_id, { parent_id: null })`. NO delete-fallback, NO RPC ack — the server already flipped `team_channels.archived` to `false` before emitting. See restore-asymmetry note below. |
| `managed_channel_deleted` | `src/rcp/channel/handleManagedDeleted.ts` | `deleteChannel`, then `Channel/ClearManagedChannel`. This is now the ONLY handler that calls `Channel/ClearManagedChannel`. No endpoint currently emits this event (v1) — the handler exists for future use. |
| `managed_access_granted` | `src/rcp/channel/handleManagedAccess.ts` (`handleManagedAccessGranted`) | `setChannelAccessOverwrite(discord_channel_id, discord_role_id, access_level)`. |
| `managed_access_revoked` | `src/rcp/channel/handleManagedAccess.ts` (`handleManagedAccessRevoked`) | `removeChannelAccessOverwrite(discord_channel_id, discord_role_id)`. |
| `discord_channel_archived` | `src/rcp/channel/handleDiscordArchived.ts` (`handleDiscordArchived`) | Move an arbitrary Discord channel (no `team_channels` row) to `archive_category_id` via `updateChannel({ parent_id })`. See asymmetry rules below. |
| `discord_channel_restored` | `src/rcp/channel/handleDiscordRestored.ts` (`handleDiscordRestored`) | Move an arbitrary Discord channel (no `team_channels` row) to uncategorized via `updateChannel(discord_channel_id, { parent_id: null })`. NO delete-fallback, NO RPC ack. See restore-asymmetry note below. |

`handleDiscordArchived` is for archiving channels Sideline did NOT create (`entity_type='discord'`). It differs from `handleManagedArchived` in two ways that MUST be preserved:

1. **NO delete-fallback.** On `updateChannel` failure it logs a warning and stops — never delete a channel Sideline did not create. (`handleManagedArchived` may fall back to `deleteChannel` because Sideline created that channel.)
2. **NO RPC ack.** There is no `team_channels` row to update, so it never calls `Channel/ClearManagedChannel` or any other ack RPC.

When `event.discord_channel_id` is `None`, the handler is a no-op.

`handleManagedRestored` and `handleDiscordRestored` are the inverse of the archive handlers — both move the channel to uncategorized via `updateChannel(discord_channel_id, { parent_id: null })`. BOTH MUST preserve two asymmetries vs `handleManagedArchived`:

1. **NO delete-fallback.** On `updateChannel` failure they log a warning and stop. A restore must never delete a channel.
2. **NO RPC ack.** The server already set `team_channels.archived = false` (managed) or owns no row (discord) before emitting, so neither handler calls `Channel/ClearManagedChannel` or any other RPC. The preserved `team_channels.discord_channel_id` link (kept through archive) is what lets `handleManagedRestored` target the same channel.

When `event.discord_channel_id` is `None`, both restore handlers are no-ops.

`handleManagedAdopted` makes a previously-unmanaged channel private by **full-REPLACING** its `permission_overwrites` list with a single `@everyone` deny-`ViewChannel` overwrite (`deny(HIDDEN)`, the same shape `createChannelOnly` uses for Sideline-created channels). Rules that MUST be preserved:

1. **It is a REPLACE, not a merge.** Passing the full `permission_overwrites` array to `updateChannel` wipes every pre-existing (foreign) overwrite on the adopted channel — that is the intended effect (make the channel private from scratch). Never switch this to `setChannelPermissionOverwrite` (which only adds one entry and would leave foreign overwrites in place).
2. **The bot keeps its own access via its guild-level bot role, not a per-channel overwrite.** The REPLACE therefore does NOT lock the bot out of the follow-up `managed_access_granted` grants.
3. **It grants NO group access itself.** Per-group grants arrive as separate `managed_access_granted` events (their own committed outbox rows) handled by `handleManagedAccessGranted`. The server deliberately splits adoption and access into two events to avoid an event-ordering race — never fold grant logic into `handleManagedAdopted`.
4. **No RPC ack.** The `team_channels` row already exists (the server inserted it before emitting), so the handler never calls `Channel/UpsertManagedChannel` or any other ack RPC.

Access tiers and Discord permission overwrites:

1. **`access_level` is `'VIEW' | 'EDIT' | 'ADMIN'`** (`packages/domain/src/models/TeamChannelAccess.ts`). Each tier maps to a fixed `allow`/`deny` permission bitset via `accessLevelPermission(level)` in `src/rest/permissions.ts`.
2. **`ADMIN` never includes `ManageChannels`.** The admin tier grants message/thread moderation (`ManageMessages`, `ManageThreads`, `PinMessages`) but never channel rename or delete — Sideline owns channel name/category/position, so a Discord ADMIN must not be able to mutate them.
3. **Overwrites target Discord role ids, one per granted group.** The server resolves each group's `discord_role_id` at emit time; the bot's `setChannelAccessOverwrite` writes a `ROLE`-type overwrite via `rest.setChannelPermissionOverwrite`, and `removeChannelAccessOverwrite` deletes it via `rest.deleteChannelPermissionOverwrite`.
4. **Never derive permission bitsets inline in a handler.** Always go through `accessLevelPermission(level)` so the three tiers stay defined in exactly one place.

### Event Sync (events → Discord messages)

Events render onto **two distinct Discord surfaces** — keep them straight:

1. **Global shared events channel** — ONE channel per team (`team_settings.discord_events_channel_id`, resolved server-side by `resolveChannel`; see `applications/server/AGENTS.md`). The event-sync handlers below post/edit the aggregate embed here (`buildEventEmbed`), one message per event, RSVP buttons shared by everyone.
2. **Private per-member personal channels** — one hidden channel per team member inside the team's configured personal-events category. Each carries that member's own RSVP view (`buildUpcomingEventEmbed`, per-member state). These are driven by the **Personal Events Sync** poll loop, NOT by the event-sync handlers — see "Personal Events Sync" below.

`event_sync_events` (this section) drives surface 1. Surface 2 is reconciled separately off the `events.personal_messages_dirty_at` marker.

Syncs event lifecycle to Discord embed messages. When events are created/updated/cancelled/started, the server emits events to `event_sync_events`.

| Component | File |
|-----------|------|
| Domain model | `packages/domain/src/rpc/event/EventRpcEvents.ts` |
| Bot service | `src/rcp/event/ProcessorService.ts` |

Event types: `event_created`, `event_updated`, `event_cancelled`, `event_started`, `rsvp_reminder`, `training_claim_request`, `training_claim_update`, `unclaimed_training_reminder`, `coaching_status`, `event_roster_approval_request`, `event_roster_approval_cancel`, `event_roster_thread_delete`, `teams_generated`

The `teams_generated` handler (`src/rcp/event/handleTeamsGenerated.ts`) posts the balanced-team breakdown embed (built by `src/rest/events/buildGeneratedTeamsEmbed.ts`) to `event.discord_target_channel_id`; it no-ops with a warning when that channel id is `None`. Its `teams` payload is decoded from the `event_sync_events.teams_payload` JSONB column (see "JSONB payload column on an outbox event type" in `applications/server/AGENTS.md`) — the bot does not recompute the assignment, it only renders the server-computed result.

The `event_started` handler updates the Discord embed to remove RSVP buttons and rebuilds the embed with current RSVP counts. For its "Starting now" post, the mention is `event_type`-dependent: for a **training** it mentions the assigned coach via a `<@coach>` user mention (`event.claimed_by_discord_id` + `allowed_mentions.users`), falling back to the owners-group role mention + `bot_event_started_no_coach_warning` when no coach is claimed (and to the bare warning text when neither is resolvable); for **non-training** events it mentions `event.discord_role_id` (the member-group role) as before. Note `event.discord_role_id` is the OWNERS-group role for trainings and the MEMBER-group role otherwise — this overload is set server-side; see `applications/server/AGENTS.md` → "Overloaded payload fields on event sync events". The handler also best-effort deletes the owners-thread claim message (`Event/GetClaimInfo` → `rest.deleteMessage`, swallowing code 10008) when a training starts.

#### Roster-approval sync handlers (Event↔Roster Attendance)

Three event-sync handlers drive the Discord side of the Event↔Roster Attendance approval flow. The server-side emit contract for these event types lives in `applications/server/AGENTS.md` → "Overloaded payload fields on event sync events (roster approval flow)".

| Handler | Event type | Behaviour |
|---------|-----------|-----------|
| `handleEventRosterApprovalRequest` | `event_roster_approval_request` | Posts the approval embed (built by `buildRosterApprovalMessage`) with Approve/Decline buttons into the owners thread, then saves the posted message id back via `Event/SaveApprovalRequestMessageId`. |
| `handleEventRosterApprovalCancel` | `event_roster_approval_cancel` | `rest.deleteMessage(owners_thread_id, discord_message_id)`; swallows code 10008 (Unknown Message). No-ops when either id is `None`. |
| `handleEventRosterThreadDelete` | `event_roster_thread_delete` | `rest.deleteChannel(owners_thread_id)`; swallows code 10003 (Unknown Channel). No-ops when `owners_thread_id` is `None`. |

`handleEventRosterApprovalRequest` resolves the owners thread with the same race-safe lazy-create pattern as the persistent claim thread (see "Persistent owners claim thread" in `applications/server/AGENTS.md`):

1. If `event.owners_thread_id` is `Some`, use it. Otherwise `rest.createThread(owner_channel_id, ...)` (PUBLIC_THREAD, 7-day auto-archive), then `Event/SaveEventRosterThreadIfAbsent` returns the WINNING thread id. If another request won the save race, `rest.deleteChannel` the orphan thread (best-effort) and use the winner's id.
2. If `owner_channel_id` is `None`, log a warning and skip — no thread can be created.
3. On `createMessage` failure with code 10003 / HTTP 404 (thread deleted), call `Event/ClearEventRosterThread`, recreate via the same race-safe path, and retry the post once.
4. The candidate's `discord_id` is resolved server-side and arrives on the event as `candidate_discord_id` — the handler never looks it up itself.

### Personal Events Sync (per-member private channels + global refresh)

This is surface 2 of the two-surface event model (see "Event Sync" above). It is **bot-driven and poll-based** — there is NO `personal_events_sync_events` outbox. The bot polls server reads keyed on `events.personal_messages_dirty_at` and reconciles both the per-member personal channels AND (re-)refreshes the global shared message.

| Component | File |
|-----------|------|
| Bot service | `src/rcp/personalEvents/ProcessorService.ts` (`PersonalEventsSyncService.processTick`, exported via `src/rcp/personalEvents/index.ts`) |
| Pass 1a — provision | `src/rcp/personalEvents/handleProvision.ts` (`provisionPersonalChannels(guildId)`) |
| Pass 1b — de-provision | `src/rcp/personalEvents/handleDeprovision.ts` (`deprovisionPersonalChannels(guildId)`) |
| Pass 1c — rename | `src/rcp/personalEvents/handleRename.ts` (`renamePersonalChannels(guildId)`) |
| Pass 2 — reconcile | `src/rcp/personalEvents/handleReconcile.ts` (`reconcileEvent(event)`) |
| Per-channel reorder | `src/rcp/personalEvents/reorderPersonalChannel.ts` (`reorderPersonalChannel(params)`) |
| Channel creation | `src/rest/channels/createPersonalEventChannel.ts` |
| Channel-name format | `src/rest/channels/formatPersonalChannelName.ts` (`{name}` / `{discord_id}` placeholders) |
| Message payload builder | `src/rest/events/buildPersonalEventMessage.ts` (`buildPersonalMessage` → `{ createPayload, editPayload, needsMentionEdit, hash }`) |
| Domain RPCs | `packages/domain/src/rpc/guild/GuildRpcGroup.ts` (`Guild/*Personal*`) + `packages/domain/src/rpc/personalEvents/PersonalEventsRpcGroup.ts` (`PersonalEvents/*`) |

`processTick` runs on the standard `pollLoop` (5s) and performs **two independent passes per tick** (Pass 1 itself runs provision THEN de-provision THEN rename per guild via `provisionPersonalChannels(guildId).pipe(Effect.andThen(deprovisionPersonalChannels(guildId)), Effect.andThen(renamePersonalChannels(guildId)))`), each isolating per-item failures so one bad guild/event never aborts the rest:

**Pass 1a — Provision (event-independent).** `Guild/GetGuildsNeedingPersonalProvisioning({ limit: 20 })` → for each guild, `provisionPersonalChannels(guildId)` (serialised `{ concurrency: 1 }` to respect Discord rate limits). This covers backfill when a category is first configured AND new member joins. Per member:

1. `Guild/GetPersonalChannelTargetCategory({ team_id })` resolves the base category (`team_settings.discord_personal_events_category_id`) or the last allocated overflow category. Skip the member when `category_id` is `None` (no category configured).
2. `Guild/ReservePersonalChannel({ team_id, team_member_id })` is the **reserve-first idempotency** guard — it `INSERT ... ON CONFLICT (team_id, team_member_id) DO NOTHING` into `personal_event_channels` (channel id still `NULL`) and returns `{ reserved: boolean }`. Proceed only when `reserved === true`; `false` means another replica/prior tick already owns it.
3. `createPersonalEventChannel(guildId, discordId, categoryId, name)` creates a `GUILD_TEXT` channel inside the category with `permission_overwrites` that DENY `ViewChannel` for `@everyone` and ALLOW `ViewChannel | ReadMessageHistory` (deny `SendMessages`) for the member — member-only, read-only. The `name` is computed by `formatPersonalChannelName(member.channel_format, member.name, member.discord_id)` — the server returns `channel_format` (from `team_settings.discord_personal_events_channel_format`, default `events-{discord_id}`) and `name` (the member display name) on the `GetGuildsNeedingPersonalProvisioning` result. Never hard-code `events-<discord_id>` in the bot — go through `formatPersonalChannelName`, which slugifies `{name}` and substitutes `{discord_id}`.
4. On a permanent Discord `403` (category at the 50-channel cap), `Guild/AllocatePersonalOverflowCategory({ team_id })` reserves the next `personal_event_overflow_categories` sequence, then re-resolve `Guild/GetPersonalChannelTargetCategory` and retry the create ONCE.
5. `Guild/SavePersonalChannelId({ team_id, team_member_id, discord_channel_id, channel_format })` fills in the reserved row's channel id AND records `applied_channel_format` (the format just used to render the name — see Pass 1c).
6. **Backfill the new channel with existing events.** After `SavePersonalChannelId`, call `Guild/MarkTeamPersonalEventsDirty({ team_id })` to mark the team's active upcoming events dirty so Pass 2's reconcile loop renders them into the freshly-created channel. Do NOT render existing events here — reuse the reconcile path rather than duplicating `buildPersonalMessagePayload` in provision. Wrap the call in `Effect.catchTag('RpcClientError', ...)` and log-and-swallow: a failed mark must not roll back the just-saved channel id.

**Pass 1b — De-provision (group-restriction enforcement).** `Guild/GetPersonalChannelsToDeprovision({ guild_id, limit })` → `deprovisionPersonalChannels(guildId)` (serialised `{ concurrency: 1 }`). The server returns members who hold a personal channel but fell OUTSIDE the team's configured `discord_personal_events_group_id` (returns `[]` when no group restriction is set — so an unrestricted team never de-provisions). Per member: `rest.deleteChannel(discord_channel_id)` (retry transient), THEN `Guild/DeletePersonalChannel({ team_id, team_member_id })` to clear the DB rows. **Clear the DB rows ONLY after the channel is gone** (delete succeeded, OR Discord returns `10003` "Unknown Channel"); on any other delete failure, log a warning and leave the rows so the next tick retries — never clear the row before the channel is deleted, or the member would keep an orphan channel forever.

**Pass 1c — Rename (format-change drift).** `Guild/GetPersonalChannelsToRename({ guild_id, limit })` → `renamePersonalChannels(guildId)` (serialised `{ concurrency: 1 }`). The server returns members whose stored `personal_event_channels.applied_channel_format` no longer matches the team's current `discord_personal_events_channel_format` (see `applications/server/AGENTS.md` → "Personal-channel format-change drift"). Per member: render the new name with `formatPersonalChannelName(member.channel_format, member.name, member.discord_id)` (the SAME single source of name formatting used in Pass 1a — never derive the name any other way), `rest.updateChannel(discord_channel_id, { name })` (retry transient), THEN on success record the applied format via `Guild/SavePersonalChannelFormat({ team_id, team_member_id, channel_format })` AND sync the new name to `discord_channels` via `Guild/UpdateChannelName({ channel_id, name })`. **Record the applied format ONLY after the rename lands** (rename succeeded, OR Discord returns `10003` "Unknown Channel" — the channel is already gone, stop flagging it); on any other rename failure, log a warning and leave `applied_channel_format` unchanged so the next tick retries.

**Pass 2 — Reconcile (event-driven, dirty-marker-gated).** `PersonalEvents/GetEventsNeedingReconcile({ limit: 20 })` returns `{ event_id, team_id, guild_id, dirty_at }` for events whose `personal_messages_dirty_at IS NOT NULL` (ORDER BY the marker ASC). For each event (serialised `{ concurrency: 1 }`): `reconcileEvent(event)` THEN `PersonalEvents/ClearPersonalMessagesDirty({ event_id, dirty_at })`.

`reconcileEvent` does four things, all hash-diffed to suppress no-op Discord edits:

1. **Per-member personal messages.** `Guild/ListPersonalChannelsForEvent({ event_id })` → for each member, fetch their upcoming events, `buildPersonalMessage({ entry, yesAttendees, discordId, locale })` (from `src/rest/events/buildPersonalEventMessage.ts`), and compare its `hash` to the stored `payload_hash` from `PersonalEvents/GetPersonalEventMessage`. If equal, skip. Otherwise: on an existing message `rest.updateMessage(..., render.editPayload)`; on a new message `rest.createMessage(..., render.createPayload)` (mention-free) and then, when `render.needsMentionEdit`, a follow-up `rest.updateMessage(..., render.editPayload)` to add the mention (see "Ping-free mention"). Then `PersonalEvents/UpsertPersonalEventMessage` persists `(personal_channel_id, discord_message_id, payload_hash)` keyed `(event_id, team_member_id)`. On CREATE, if the upsert still fails after retries, **delete the just-created Discord message (compensating action) and re-fail** so the event stays dirty and is retried cleanly next tick — never leave an orphan message persisted with no row. If the mention edit fails, persist `payload_hash: ''` so the next tick re-applies it via the edit branch. `reconcileMemberMessage` returns `Some(member)` ONLY when it created a NEW message (so the channel may now be out of order); in-place edits, no-ops, and deletions return `None`.
2. **Per-channel reorder (only for members that got a NEW message).** For each member returned `Some` in step 1, call `reorderPersonalChannel({ team_member_id, discord_id, guild_id, locale })`. Reorder is the SAME longest-keepable-prefix algorithm as the global channel — it reuses `longestKeepablePrefix` and `compareSnowflakes` exported from `src/rcp/event/reorderChannelMessages.ts` and the shared `ChannelReorderSemaphore.withChannelLock(channelId)`. Do NOT copy or re-implement the prefix math; import the exports. Personal channels sort latest-start-first (soonest event nearest the input box), opposite the global past/future divider layout, so the reorder uses its own `desiredOrder` comparator but the same prefix engine. A reorder is skipped when the member has ≤1 stored message (nothing to order).
3. **Global shared message refresh.** `Event/GetDiscordMessageId({ event_id })` → rebuild `buildEventEmbed` from `Event/GetEventEmbedInfo` + `Event/GetRsvpCounts` + `Event/GetYesAttendeesForEmbed`, hash-diff against the CURRENT message fetched via `rest.getMessage` (fall back to always-update if the fetch fails), and `rest.updateMessage` only on change.
4. The dirty flag is cleared LAST, with a timestamp guard (see below).

Rules:

1. **The `dirty_at` timestamp guard prevents lost updates.** `ClearPersonalMessagesDirty` clears the marker ONLY when `personal_messages_dirty_at = ${dirty_at}` (the value observed at the start of the tick). If an RSVP/edit re-marked the event during reconcile, the marker now holds a newer timestamp, the conditional `UPDATE` matches nothing, and the event is reconciled again next tick. Never clear the marker unconditionally. The server side of this contract lives in `applications/server/AGENTS.md` → "`events.personal_messages_dirty_at` reconcile marker".
2. **`payload_hash` is the no-op suppressor on BOTH surfaces.** `buildPersonalMessage`'s `hash` is the SHA-256 of the FINAL `{ content, embeds, components }` (i.e. of `editPayload`); compare it before any `rest.updateMessage`. Personal messages compare against the stored `personal_event_messages.payload_hash`; the global message compares against the live message content. Do not edit a Discord message whose hash is unchanged. The hash MUST include `content` — the unanswered-event mention lives there (see "Ping-free mention" below), so dropping it from the hash would miss the highlight toggling on/off.
3. **Reserve before create, always.** Never call `createPersonalEventChannel` without a successful `ReservePersonalChannel` first — the reserve row (nullable `discord_channel_id`) is what makes provisioning idempotent across replicas and ticks.
4. **There is no outbox for personal events.** Do not add a `personal_events_sync_events` table or a `Match.exhaustive` dispatcher — the trigger is the `events.personal_messages_dirty_at` marker, polled by `GetEventsNeedingReconcile`.
5. **Reorder only on create, never on every reconcile.** An in-place edit keeps the existing snowflake in place, so a reorder pass after every edit would be wasted Discord reads. Only `reconcileMemberMessage` returning `Some` (a fresh `createMessage`) can put the channel out of order, so reorder is gated on that signal.

#### Ping-free mention convention (highlight without notifying)

To draw a member's eye to an unanswered event WITHOUT firing a Discord notification, the mention is applied **via a message edit**, not on create. Discord only paints the "you were mentioned" highlight when the message actually registers a mention of you (`allowed_mentions: { parse: [] }` suppresses that — you get a chip but no highlight), and a *create* that registers your mention pings you. So `buildPersonalMessage` returns two bodies:

- `createPayload` — mention-free (`content: ''`, `allowed_mentions: { parse: [] }`). Always used for `rest.createMessage`, so a create never pings.
- `editPayload` — when `Option.isNone(entry.my_response)`, `content: <@${discordId}>` with `allowed_mentions: { parse: [], users: [discordId] }` (the member's own id is allow-listed so the mention REGISTERS → highlight); otherwise identical to `createPayload`. Used for `rest.updateMessage`.

Because edits never notify, editing-in the mention highlights the message without a ping. On the create path, post `createPayload` first then (when `needsMentionEdit`) `updateMessage(editPayload)`. The `users` allow-list MUST contain only the channel's own member — never widen it to others, and never put the mention in a `createMessage`/`createPayload` (that would ping).

### Finance Sync (payment reminders → user DMs)

Syncs `payment_reminder_sync_events` rows to per-user DM embeds. The server's `PaymentReminderCron` enqueues one outbox row per `(assignment_id, kind)` candidate; the bot DMs the recipient, then acks delivery via `Finance/MarkReminderSent` BEFORE calling `Finance/MarkPaymentReminderProcessed`. See `applications/server/AGENTS.md` → "Bot-Ack Idempotency for Discord-Side-Effect Crons" for the server-side contract.

| Component | File |
|-----------|------|
| Domain event | `packages/domain/src/rpc/finance/FinanceRpcEvents.ts` (`PaymentReminderReadyEvent`) |
| Kind literal | `packages/domain/src/models/PaymentReminder.ts` (`PaymentReminderKind`) |
| Bot service | `src/rcp/finance/ProcessorService.ts` (`FinanceSyncService.processTick`, exported via `src/rcp/finance/index.ts`) |
| Ready handler | `src/rcp/finance/handlePaymentReminderReady.ts` — `createDm` → `createMessage` → `Finance/MarkReminderSent` |
| Embed builder | `src/rcp/finance/buildPaymentReminderEmbed.ts` — `Match.value(kind).pipe(Match.when(...), Match.exhaustive)` over `PaymentReminderKind` |

Event types: `payment_reminder_ready`. Uses standard `pollLoop` (5s).

Rules:

1. **`Finance/MarkReminderSent` must run AFTER `createMessage` succeeds and BEFORE `Finance/MarkPaymentReminderProcessed`.** If the Discord call fails, the handler falls through to `Finance/MarkPaymentReminderFailed` via `Effect.catch` in `ProcessorService.processEvent` — `payment_reminders_sent` is NOT written, so the next cron tick can re-emit after the outbox row is processed.
2. **Never write to `payment_reminders_sent` from the bot directly.** The bot only calls the RPC; the server handler owns the `INSERT ... ON CONFLICT DO NOTHING`.
3. **`buildPaymentReminderEmbed` must remain pure** — no Effect, no `DiscordREST` calls, no i18n side effects. The embed copy is currently English-only and lives inline; do not add `tr()` or `m.*` imports without first adding `bot_payment_reminder_*` keys per the "Translation Source — Compiled Paraglide Only" rules above.

### Email Sync (email posts → Discord embeds)

Syncs `email_post_sync_events` rows to Discord embeds. The server's `EmailSummarizer` cron and the approval state machine enqueue one outbox row per delivery; the bot posts an embed (and approval buttons) per row. This is a sync-event family alongside Role / Channel / Event / Finance / weekly-summary sync.

| Component | File |
|-----------|------|
| Domain event | `packages/domain/src/rpc/email/EmailRpcEvents.ts` (`EmailPostEvent`, `UnprocessedEmailPostEvent`) |
| Bot service | `src/rcp/email/ProcessorService.ts` (`ProcessorService.processTick`, exported via `src/rcp/email/index.ts`) |
| Post handler | `src/rcp/email/handleEmailPostEvent.ts` — dispatches on `event.kind` (`switch` with a `const _exhaustive: never` default) |
| Embed builders | `src/rest/email/buildEmailEmbeds.ts` (`buildApprovalEmbed` / `buildSummaryEmbed` / `buildOriginalEmbed` + component builders) |
| Approval interaction | `src/interactions/email-approval.ts` (Approve / Reject buttons) |

Event kinds: `approval_request` (post summary + Approve/Reject buttons to the coach channel), `post_summary` (post the approved AI summary to the team channel), `post_original` (post the original email to the team channel after rejection). Uses the standard `pollLoop` (5s) and the standard `Effect.catch` → `Email/MarkEmailPostEventFailed` per-event funnel.

#### `allowed_mentions: { parse: [] }` On Every Message Carrying User- or Email-Derived Content

Any `rest.createMessage` / `rest.updateMessage` whose embed or content includes a string the bot did not author — a user-typed value, or content forwarded from an external source (email subject/body/sender, summaries) — MUST pass `allowed_mentions: { parse: [] }` (optionally with an explicit `users` allow-list). Without it, a `@everyone`, `@here`, role, or user mention literal embedded in that text pings real recipients. This generalises the welcome-flow rule above: it applies to the email post handlers (`handleEmailPostEvent` passes `allowed_mentions: { parse: [] }` on every `createMessage`) and to any future feature that relays third-party or user-authored text into Discord. The only messages that may omit it are those whose entire content is bot-authored static copy with no interpolated user/external strings.

#### Persistent owners claim thread (one per owners group, NOT per training)

The `training_claim_request` handler posts the claim embed into a single **persistent claim thread per owners group**, NOT a per-training thread (the old per-message thread creation in `buildThreadName` / `createThreadFromMessage` was removed). Flow in `handleTrainingClaimRequest.ts`:

1. Resolve the thread id from the server via `rpc['Event/GetOwnerClaimThread']({ team_id, owner_group_id })` (the owner group comes from `event.owner_group_id`, which the server overloads onto the outbox `member_group_id` column — see `applications/server/AGENTS.md`).
2. If `None`, create a `PUBLIC_THREAD` (`type: 11`, `auto_archive_duration: 10080`, name `bot_claim_thread_name`) and persist it via `rpc['Event/SaveOwnerClaimThread']`. That RPC is race-safe and returns the WINNING thread id; if another request won, delete the orphan thread you just created (`rest.deleteChannel`, best-effort) and use the winner's id.
3. Post the embed to the thread. If `createMessage` returns Discord code `10003` (unknown channel — the thread was deleted), call `rpc['Event/ClearOwnerClaimThread']`, recreate the thread, and retry the post ONCE.
4. After the post succeeds, call `rpc['Event/SaveClaimDiscordMessageId']({ event_id, channel_id, message_id })` (where `channel_id` is the actual thread id used) so `training_claim_update`, `unclaimed_training_reminder`, and the `handleStarted` claim-message cleanup can locate / edit / delete that message.

#### Rebuild a board message from the stored id, never from `interaction.message`

When a component/button/modal interaction must edit a persistent "board" message (a server-backed embed that several users mutate — e.g. the carpool board, an RSVP roster, any embed rebuilt after a state change), rebuild it at the channel/message id **carried on the server view** (saved at creation time via a `Save…DiscordMessageId`-style RPC), NOT from `interaction.message` / `interaction.channel_id`. The same interaction can fire from inside a private thread or an ephemeral reply, where `interaction.message` is a different message entirely — editing it would corrupt the wrong message or no-op silently. Reference: `applications/bot/src/interactions/carpool.ts` — the `rebuildBoard` helper reads `view.discord_channel_id` + `view.discord_message_id` (an `Option`; log a warning and skip when `None`) and calls `rest.updateMessage`, swallowing REST failures. The view's ids originate from the create handler calling the persist RPC (`Carpool/SaveCarThreadId` saves a per-car thread id the same way).

#### Per-user actions on a shared board message: one button keyed by entity id, resolved server-side

A board message is shared — every viewer sees the identical component rows, so a button's `custom_id` MUST NOT encode any single user's state. For a per-user action on a board, post ONE button keyed only by the board's entity id (e.g. `custom_id` = `carpool-leave-mine:<carpool_id>`), and resolve the acting user's specific target on the server from the interaction's user id. Reference: `CarpoolLeaveMineButton` in `src/interactions/carpool.ts` calls `rpc['Carpool/LeaveCarpool']({ carpool_id, discord_user_id })`; the `leaveSeatByCarpool` repo method (`applications/server/src/repositories/CarpoolsRepository.ts`) finds and deletes the caller's seat within that carpool and returns its `car_id` in `LeaveCarpoolResult`. Rules:

1. **Never encode a per-user id (seat id, car id chosen for one user) into a shared-board button `custom_id`.** Encode only the shared entity id; pass `discord_user_id` in the RPC payload and let the server map it to the user's row. Per-target buttons (`carpool-leave:<car_id>`) are fine inside that target's own thread, where only its members act.
2. **The RPC resolves the target by a uniqueness invariant**, so no client-supplied target is needed — `leaveSeatByCarpool` relies on the unique index on `carpool_seats(carpool_id, team_member_id)` (at most one seat per member per carpool). When the lookup yields nothing, return a typed error (`CarpoolNotInCar`) and reply ephemerally; never silently no-op.
3. **Disable the shared button when there is nothing to act on** (e.g. `disabled: displayedCars.length === 0`) rather than letting the click fall through to a typed error.
4. **Always reply ephemerally** (`ephemeralDeferred` + `replyWebhook`) to a shared-board per-user action — the outcome is user-specific and must not post to the shared channel; the board itself is updated via `rebuildBoard`.

#### Channel Reorder Algorithm (`reorderChannelMessages`)

`reorderChannelMessages(channelId, locale, snowflakeOverrides?)` is the single function responsible for laying out event messages (plus the optional past/future divider) inside a channel in chronological order. Every event handler that changes embed content or list ordering — `handleCreated`, `handleUpdated`, `handleCancelled`, `handleStarted`, `handleRsvpReminder` — calls into it. **Never re-implement reorder logic in a handler.**

**Constraints (must be preserved):**

1. Discord assigns monotonically-increasing snowflake IDs to messages in posting order. The visible order in a channel is therefore the snowflake order. The bot does not reorder messages on Discord — it edits in place where the existing message ID already sits in the correct position, and recreates (delete-old + create-new, sequentially) for the suffix that does not.
2. **Cap**: at most `MAX_CHANNEL_EVENTS` (= 10) event messages per channel. Older entries beyond the cap are deleted from Discord; their DB rows are left to the server.
3. **Per-channel serialisation**: the entire body is wrapped in `ChannelReorderSemaphore.withChannelLock(channelId)(...)`. Two reorders for the same channelId never run concurrently; reorders for different channels do run concurrently.
4. The reorder is internally chunked into:
   - **kept prefix** — items whose stored snowflake is strictly increasing and whose snowflake is strictly less than every snowflake in the remaining suffix. These are edited in place.
   - **recreate suffix** — everything from the first non-keepable item onward. Processed sequentially with `concurrency: 1` (delete old, then create new), so newly minted snowflakes are themselves monotonically increasing and end up at the end of the channel.
5. **Forbidden pattern**: do not zip the items array with a sorted list of existing message IDs and edit each slot. That pattern (the pre-fix implementation) corrupts message IDs across rows when even one item is recreated. The longest-keepable-prefix algorithm in `reorderChannelMessages.ts` is the only correct approach — preserve it.

**`EditOutcome` typed-return convention:**

In-place edit helpers return `type EditOutcome = 'edited' | 'message_gone'`. They MUST NOT self-heal a missing message inline (e.g. by recreating it from inside the edit helper) — that would produce a new snowflake at an arbitrary position in the channel and re-introduce the corruption bug. Instead, on error code `10008` ("Unknown Message"), return `'message_gone'`. The caller (`processKeptPrefix` in `reorderChannelMessages.ts`) treats `'message_gone'` as the boundary at which the kept prefix ends and the recreate suffix begins, so the recreated message lands at the tail of the channel where its new snowflake is guaranteed to be the largest.

When adding new edit-in-place helpers in this file, follow the same contract: return `EditOutcome`, never recreate inline, never swallow `10008` as success.

**Snowflake overrides (`snowflakeOverrides`):**

`snowflakeOverrides: ReadonlyMap<event_id, Option<Snowflake>>` lets a caller force an entry into the recreate suffix by passing `Option.none()` for that `event_id`. Currently used only by `recoverDeletedMessages` (startup recovery): it bulk-fetches `rest.listMessages(channelId, { limit: 100 })` and overrides any DB entry whose `discord_message_id` is absent from the live channel. The override carries a `deleteSnowflake` (the original DB-stored ID) so the recreate path still attempts to delete the stale message before creating its replacement.

#### `ChannelReorderSemaphore` (per-channel lock registry)

`ChannelReorderSemaphore` is a `ServiceMap.Service` Tag (`'bot/ChannelReorderSemaphore'`) wired in `AppLive.SyncLive` via `Layer.provideMerge(ChannelReorderSemaphore.Live)`. It is also threaded through `ProcessorService` so per-event handlers see it in their `R` channel.

| Property | Value |
|----------|-------|
| Tag id | `'bot/ChannelReorderSemaphore'` |
| Live layer | `ChannelReorderSemaphore.Live` |
| API | `withChannelLock(channelId: string) => <A,E,R>(effect) => Effect<A,E,R>` |
| Concurrency | One in-flight effect per `channelId`; different channelIds run in parallel |
| Storage | `Ref<Map<string, Semaphore.Semaphore>>` — lazy, atomic get-or-create via `Ref.modify` |

Use this pattern (and not `Effect.Semaphore.make` at module top-level) whenever a Discord-side resource is identified by an ID and per-resource serialisation is required. Module-level semaphores serialise globally across all IDs and would needlessly block unrelated channels.

1. Bot service polls via `rpc.GetUnprocessed*Events({ limit: 50 })` every 5 seconds (the standard `pollLoop` helper in `src/Bot.ts`, `Schedule.spaced('5 seconds')`)
2. Processes each event (Discord REST calls with exponential retry)
3. Marks events as processed or failed
4. Mapping tables track the Discord resource ID for each domain entity

### Poll-Loop Cadences (`src/Bot.ts`)

Three distinct schedules wrap processor `processTick` effects. All wrap the tick in the exported `resilientTick` helper BEFORE `Effect.repeat`:

```ts
export const resilientTick = <E, R>(processTick: Effect.Effect<void, E, R>) =>
  Effect.catchCause(processTick, (cause) => Effect.logError('Sync poll tick failed', cause));

const pollLoop = <E, R>(processTick: Effect.Effect<void, E, R>) =>
  resilientTick(processTick).pipe(Effect.repeat(Schedule.spaced('5 seconds')));
```

| Helper | Cadence | Schedule | Used by |
|--------|---------|----------|---------|
| `pollLoop` | 5s | `Schedule.spaced('5 seconds')` | `roles.processTick`, `channels.processTick`, `eventSync.processTick`, `guildJoin.processTick`, `onboarding.processTick`, `finance.processTick`, `email.processTick`, `personalEvents.processTick` |
| `fastPollLoop` | 1s | `Schedule.spaced('1 seconds')` | `inviteGenerator.processTick` only |
| `slowPollLoop` | 5min | `Schedule.spaced('5 minutes')` | `channelBackfill.processTick` only (see "Channel Backfill" below) |

Rules:

1. **A `processTick` failure or defect MUST NOT kill its repeat loop.** `Effect.repeat(Schedule.spaced(...))` stops permanently on the first failure — a single transient blip (e.g. an `RpcClientError` while the server redeploys) would silently stop that poller until the bot is restarted. The shared `resilientTick` boundary in `pollLoop` / `fastPollLoop` / `slowPollLoop` catches the whole `Cause` (failures AND defects), logs `'Sync poll tick failed'`, and returns void so the loop keeps ticking. NEVER route a `processTick` to `Effect.repeat` outside `pollLoop` / `fastPollLoop` / `slowPollLoop`, and never remove the `resilientTick` wrapper. Per-service `processTick`s still `tapError`-log their specific error; `resilientTick` is the catch-all safety net, not a substitute for that per-service logging. Mirrors the `ixProgram` interaction-handler boundary in the same file.
2. **`fastPollLoop` is reserved for the invite generator.** The web client begins polling `GET /invite/acceptances/:acceptanceId` immediately after a user accepts an invite; the 1s cadence keeps the wait between accept and the "Open Discord server" CTA under ~2s.
3. **Never promote other services to `fastPollLoop`** without explicit justification — every additional 1s loop multiplies idle RPC load.
4. **Never demote `inviteGenerator` back to `pollLoop`** — the user-visible latency on `InvitePage` depends on this cadence.
5. **`slowPollLoop` is reserved for self-healing reconcile sweeps, not real-time sync.** It runs `channelBackfill.processTick`, which calls `Channel/BackfillMissingGroupRoles` (the server enqueues provisioning events for groups that never got a Discord role). Real-time provisioning still happens on the `channels` `pollLoop`; the backfill is the safety net for groups created before the guild was linked. Keep new reconcile/self-heal sweeps on `slowPollLoop` — never put one on `pollLoop`.

### Invite Generator (`src/rcp/inviteGenerator/ProcessorService.ts`)

The invite generator mints one single-use Discord invite per **acceptance** (not per `team_invites` row). Each tick:

1. Calls `rpc['Invite/PendingAcceptances']({ limit: 20 })` to fetch acceptances with `discord_code IS NULL AND discord_code_error_code IS NULL` (server filters by `welcome_channel_id IS NOT NULL` and `bot_guilds.is_community_enabled = true`).
2. For each `PendingAcceptance { acceptance_id, guild_id, welcome_channel_id }`, calls `discord.createChannelInvite(welcome_channel_id, { max_age: 86400, max_uses: 1, unique: true, temporary: false })`.
3. On success: `rpc['Invite/SetAcceptanceDiscordCode']({ acceptance_id, discord_code })`.
4. On failure: classifies the error and calls `rpc['Invite/MarkAcceptanceFailed']({ acceptance_id, error_code, error_detail })`.

Rules:

1. **`max_uses` must be `1` and `max_age` must be `86400` (24h).** Reusable or longer-lived codes break the per-acceptance attribution model — the `Guild/RegisterMember` welcome lookup uses `invite_acceptances.discord_code` to find the single user the code was minted for.
2. **The acceptance id is the only identifier passed in `Invite/*` RPC payloads.** The old `invite_id`-keyed RPCs (`Invite/PendingDiscordCodes`, `Invite/SetDiscordCode`, `Invite/MarkDiscordCodeFailed`) no longer exist. Never reintroduce them.
3. **Processing concurrency is `1`.** The `Effect.all(..., { concurrency: 1 })` serialisation prevents Discord rate-limit storms when many acceptances queue up.

### Adding a New Sync Type

1. Create migration with `*_sync_events` and `discord_*_mappings` tables
2. Add domain models in `packages/domain/src/models/`
3. Add RPC schemas and endpoints to `RoleSyncRpc.ts` (same group)
4. Rebuild domain: `pnpm build` in `packages/domain`
5. Create server repositories following `RoleSyncEventsRepository` pattern
6. Add RPC handlers to `RoleSyncRpcLive.ts`
7. Wire repositories in `applications/server/src/AppLive.ts`
8. Emit events from the relevant API handler
9. Create bot service following `RoleSyncService` pattern
10. Wire bot service in `AppLive.ts`, `Bot.ts`, `index.ts`
11. Add mock repository to all server test files

## Bot Localization

### Translation Source — Compiled Paraglide Only

The bot imports translation functions directly from `@sideline/i18n/messages` (e.g. `import * as m from '@sideline/i18n/messages'`). Translations are **bundled at compile time** via Paraglide — the bot does NOT consult the `translation_overrides` table or the server's `TranslationCache`.

Rules:

1. **Always import from `@sideline/i18n/messages`** in bot code. The Biome `style/noRestrictedImports` rule that blocks this path in `applications/web/**` is explicitly overridden for `applications/bot/**` in `biome.json` — do not remove that override.
2. **Never import `tr()` or any helper from `applications/web/src/lib/translations.ts`** in the bot. The web `tr()` helper depends on a React provider and an HTTP polling loop; neither exists in the bot runtime.
3. **Admin edits to `bot_*` keys via the `/admin/translations` page do NOT take effect in Discord until the bot is redeployed.** This is intentional v1 scope: the bot's localization stays deterministic and offline-safe. Document any user-facing string that an admin might expect to edit live as "requires bot redeploy" in the admin UI (the page already badges `bot_*`-prefixed keys with `requires redeploy`).
4. **When adding a new translation key consumed by the bot**, prefix it with `bot_` so the admin UI can flag it as redeploy-only. Add the key + English text to `packages/i18n/messages/en.json` and the Czech translation to `cs.json`, then rebuild `@sideline/i18n`.

### Discord Built-in Localization

Discord's built-in `description_localizations` field on command definitions provides Czech translations. For dynamic response text, use the `Interaction` context tag from `dfx/Interactions/index`:

```typescript
import { Interaction } from 'dfx/Interactions/index';

Interaction.pipe(
  Effect.map((i) => {
    const rawLocale = i.guild_locale ?? ('locale' in i ? i.locale : undefined);
    const locale = (rawLocale ?? 'en').startsWith('cs') ? 'cs' : 'en';
    return Ix.response({
      type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: locale === 'cs' ? 'Pong! Bot žije.' : 'Pong!' },
    });
  }),
)
```

Prefer `guild_locale` (server-configured language) over `locale` (individual user's language) for server-wide consistency.

## Slash Commands (`src/commands/<command>/`)

Each top-level slash command lives in its own folder under `src/commands/`: `index.ts` builds the `Ix.global(definition, handler)` and is registered in `src/commands/index.ts` via `commandBuilder.add(...)`; `handler.ts` holds the handler effect. Localize `description`/`description_localizations` with `m.bot_<command>_description({}, { locale })` and add `name_localizations` for the Czech command name.

### Admin-Gating via `default_member_permissions` (no runtime permission check)

Captain/admin-only commands are gated **natively by Discord**, not by a runtime check in the handler. Set both fields on the command definition:

```ts
// Hides the command from members lacking ManageEvents in Discord's UI.
default_member_permissions: Number(DiscordTypes.Permissions.ManageEvents),
dm_permission: false,
```

Rules:

1. **Use `default_member_permissions: Number(DiscordTypes.Permissions.ManageEvents)` + `dm_permission: false`** for every captain/admin command. Reference commands sharing this exact convention: `/training`, `/carpool`, `/summon`, `/poll`, `/refresh-events`. Do NOT re-check the permission in the handler — Discord enforces it before dispatch.
2. **Subcommands cannot carry their own `default_member_permissions`** — the field is honored only on the top-level command. When an admin action must be permission-gated, declare it as a **top-level command** (`/refresh-events`), NOT a subcommand of an existing member-visible command (e.g. not `/event refresh`).

### 3-Second Ack: Fork Heavy Work With `Effect.forkDetach`

Discord requires an interaction ack within 3s. When a command handler's work (RPC round-trips + Discord REST renders) may exceed that, ack immediately and fork the heavy work with `Effect.forkDetach`, returning an ephemeral acknowledgement synchronously. Reference: `src/commands/refreshEvents/handler.ts` classifies the channel via `Guild/IdentifyEventsChannel`, then `Effect.forkDetach`s the reorder/dirty-mark work and returns an ephemeral reply. For handlers that DEFER (rather than reply immediately), the deferred-response resolution rules in "Paginated Embed Pattern" rule 6 apply.

### Locale Split: Channel Content vs. Ephemeral Reply (`guildLocale` / `userLocale`)

`src/locale.ts` exports two helpers. A command that both renders into a shared channel AND replies to the caller MUST split locales:

1. **`guildLocale(interaction)`** (`guild_locale`, server-configured language) — for content written into a channel everyone sees (the reordered/refreshed event messages). Mirrors the existing "prefer `guild_locale` for server-wide consistency" rule under "Discord Built-in Localization".
2. **`userLocale(interaction)`** (caller's `locale`, falling back to `guildLocale`) — for the ephemeral reply only the caller sees.

Reference: `src/commands/refreshEvents/handler.ts` renders channel content in `guildLocale(interaction)` and the ephemeral reply in `userLocale(interaction)`.

## Autocomplete Handlers (`src/interactions/*-autocomplete.ts`)

Discord slash-command `STRING` / `INTEGER` options support up to 25 static `choices`. When the choice set is **dynamic** (per-guild custom rows, user-created lists) or may exceed 25 entries, declare the option as `autocomplete: true` on the command definition and register an `Ix.autocomplete(...)` handler in `src/interactions/`.

Reference: `MakanickoLogAutocomplete` in `src/interactions/makanicko-log-autocomplete.ts` — backs the `/makanicko log activity` option, which lists both global and team-custom `activity_types` rows.

### Pattern

1. **File location.** One handler per `(command, option)` pair, named `<command>-<option>-autocomplete.ts`. Export the handler as `<Pascal>Autocomplete`.
2. **Predicate.** First arg to `Ix.autocomplete` is `(data, focused) => data.name === '<command>' && focused.name === '<option>'`. Never match by command alone — a command with multiple autocomplete options needs distinct handlers.
3. **Body shape.** Wrap the entire handler in `Effect.Do.pipe(...)`:
   - `Effect.tap` → increment `discordInteractionsTotal` with `Metric.withAttributes(..., { interaction_type: 'autocomplete' })`.
   - `Effect.bind('interaction', () => Interaction.asEffect())`, `Effect.bind('focused', () => FocusedOptionContext.asEffect())`, `Effect.bind('rpc', () => SyncRpc.asEffect())`.
   - Read the typed query string: `focused && 'value' in focused && typeof focused.value === 'string' ? focused.value : ''`.
   - Call the RPC that returns the candidate list, filter client-side by `name.toLowerCase().includes(queryLower)`, sort (globals first, then customs, both alphabetically), `Array.take(25)`, map to `{ name, value }`.
   - `Effect.catchTag('RpcClientError', () => Effect.succeed([]))` — return an empty choice list on RPC failure, never throw out of an autocomplete handler.
   - `Effect.withSpan('interaction/<command>-<option>-autocomplete')`.
4. **Response shape.** Return `Ix.response({ type: APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices } })`.
5. **Registration.** Add the handler to `interactionBuilder` in `src/interactions/index.ts` via `.add(<Pascal>Autocomplete)`.

### Rules

1. **Always cap at 25 choices** with `Array.take(25)` after sorting — Discord rejects the response otherwise. Sort so the most relevant 25 win; never trust the server to pre-truncate.
2. **Never throw `RpcClientError`** out of an autocomplete handler — Discord's autocomplete is a hot interaction (fired on every keystroke); a failed response shows the user a broken UI. Always `Effect.catchTag('RpcClientError', () => Effect.succeed([]))`.
3. **Display label may differ from submitted `value`.** Use `name: emoji ? `${emoji} ${row.name}` : row.name` for the user-visible label and `value: row.id` (UUID) for what the command handler receives. The command handler is responsible for resolving the id back to a row.
4. **Filter and sort in the bot, not the server.** The server's RPC returns the full candidate list (or a per-guild pre-filtered list); the bot does query matching, ordering, and the 25-cap. This keeps the server RPC reusable across commands with different filtering rules.

## Tagged-Union Dispatch With `Match.exhaustive`

When a bot handler or embed builder dispatches on a `Schema.Literals` union (e.g. `PaymentReminderKind`) or a `Schema.TaggedClass` union (e.g. `UnprocessedPaymentReminderEvent`), use `Match.value(x).pipe(Match.when(...), Match.exhaustive)` (literals) or `Match.type<T>().pipe(Match.tag(...), Match.exhaustive)` (tagged classes). `Match.exhaustive` is a compile-time check that every variant is handled — adding a new literal to the schema turns into a TS error at every dispatch site.

Reference implementations:

| Dispatch site | Shape | File |
|---------------|-------|------|
| Per-kind embed copy on `PaymentReminderKind` | `Match.value(kind).pipe(Match.when('due_in_3d', ...), ..., Match.exhaustive)` | `src/rcp/finance/buildPaymentReminderEmbed.ts` |
| Per-tag handler on `UnprocessedPaymentReminderEvent` | `Match.type<T>().pipe(Match.tag('payment_reminder_ready', handler), Match.exhaustive)` | `src/rcp/finance/ProcessorService.ts` |
| Per-tag handler on `UnprocessedChannelSyncEvent` | `Match.tag(...)` dispatcher | `src/rcp/channel/ProcessorService.ts` |
| Per-tag handler on `UnprocessedEventSyncEvent` | `Match.tag(...)` dispatcher | `src/rcp/event/ProcessorService.ts` |

Rules:

1. **Always end the `Match` chain with `Match.exhaustive`** — never `Match.orElse(...)` for a closed union. A default branch silently hides the case when a new variant is added to the domain schema.
2. **Type the `Match` constructor explicitly** when dispatching on a `Schema.Union` of `TaggedClass`es — use `Match.type<MyUnion>().pipe(...)` so the compiler can verify completeness against the static union, not against the runtime value.
3. **Each branch must return the same type.** When branches need divergent shapes, lift the shared shape into a local interface (see `EmbedCopy` in `buildPaymentReminderEmbed.ts`) and have each branch construct it.
4. **Never cast the dispatch value (`as <Variant>`) inside a branch.** `Match.when('literal', ...)` and `Match.tag('tag', ...)` narrow automatically; a cast bypasses that narrowing and re-introduces the very class of bug `Match.exhaustive` exists to prevent.

## Embed Display Conventions

### User Name Display in Embeds

All Discord embeds that display user/member names must use the **bold name + mention dual format**. This ensures reliable display on mobile clients where `<@id>` mentions sometimes fail to resolve.

| Scenario | Format | Example |
|----------|--------|---------|
| Name and discord_id both present | `**Name** (<@id>)` | `**Alice** (<@123>)` |
| Only discord_id present | `<@id>` | `<@123>` |
| Only name present | `**Name**` | `**Alice**` |
| Neither present | `Unknown` or `?` | `Unknown` |

#### `formatName` — Canonical Name Resolver

`formatName` in `src/rest/utils.ts` is the single implementation for resolving a user's display name **in the bot**. Always use it instead of building name resolution inline. Its precedence is delegated to the shared `DisplayName.pickDisplayName` picker in `@sideline/domain` (see `packages/domain/AGENTS.md`); the bot only layers Discord markdown (`**bold**`, `<@id>`) on top of the picker's `Option<string>` result.

**Fallback priority** (first non-blank `Some` wins — owned by `DisplayName.pickDisplayName`):
1. `name` — user's real name (from profile)
2. `nickname` — Discord server nickname
3. `display_name` — Discord global display name (`global_name`)
4. `username` — Discord username (always present)

The bot maps the entry's `display_name` field to the picker's `displayName` slot. If the picker returns `Option.none()` (all slots blank), `formatName` returns `"Unknown"` — the picker itself never invents a fallback. Never re-implement the precedence inline (no `Array.make(...).pipe(Array.getSomes, Array.head)`); call `DisplayName.pickDisplayName` and add the markdown.

`formatName` accepts a **structural type** — any object with `{ name, nickname, display_name, username }` as `Option<string>` fields. `formatNameWithMention` additionally requires `discord_id: Option<string>`. This five-field tuple `{ discord_id, name, nickname, display_name, username }` (all `Option<string>`) is the **canonical identity-tuple** for any embed/message that mentions a user. `RsvpAttendeeEntry` and `NonResponderRpcEntry` already match it; new RPC event payloads that carry a user identity (e.g. `TrainingClaimUpdateEvent.claimed_by_*`) MUST use the same five field names so call sites can pass the payload directly to `formatNameWithMention` without per-call adapters.

```typescript
import { formatName } from '~/rest/utils.js';

// Works with any object matching the structural type
const displayText = formatName(attendeeEntry); // => "**Alice**"
```

`formatNameWithMention` (same file) is the mention-aware variant. It additionally requires `discord_id: Option<string>` on the entry and returns `**Name** (<@id>)`, `**Name**`, `<@id>`, or `"Unknown"` per the table above. Use it when the embed should render the mention alongside the bold name; use `formatName` when only the bold name is wanted.

**`formatNamePlain` (same file) returns the raw display name with NO markdown** — same `{ name, nickname, display_name, username }` structural type and same `DisplayName.pickDisplayName` precedence as `formatName`, but without the `**bold**` wrap. Use it for any string Discord renders **literally instead of as markdown**:

| Surface | Helper | Reason |
|---------|--------|--------|
| Embed/message **body** (title field, description, fields) | `formatName` / `formatNameWithMention` | Discord renders markdown — `**bold**` shows as bold. |
| Thread / channel **title** (e.g. `rest.createThread({ name })`) | `formatNamePlain` | Titles do NOT render markdown — `formatName` would print literal `**Alice**` asterisks in the title. Reference: `CarpoolAddModal` in `src/interactions/carpool.ts` passes `formatNamePlain(car.owner)` to `bot_carpool_thread_name` while the embed body uses `formatName`. |

Never pass `formatName`'s output into a thread name, channel name, or any other field Discord treats as plain text.

This pattern is used in:
- `buildEventEmbed.ts` — "Going" field (bold name only via `formatName`, no mention, comma-separated)
- `buildAttendeesEmbed.ts` — attendee entries via `formatNameWithMention` (with optional message suffix)
- `handleRsvpReminder.ts` — non-responder and yes-attendee lists via `formatNameWithMention`
- `buildClaimMessage.ts` — Status field renders the claimer via `formatNameWithMention`; `claimedBy` is `Option<ClaimedByEntry>` where `ClaimedByEntry` is the canonical five-field identity-tuple

When building new embed functions that display user names, always use `formatName` for the bold name portion and follow this priority: bold name first, mention as parenthetical supplement.

#### Total embed-text budget (the 6000-code-point cap)

`EMBED_FIELD_VALUE_LIMIT` (1024, `src/rest/utils.ts`) caps a SINGLE field value, but it is NOT sufficient on its own. Discord rejects an embed whose **combined** text (title + description + every field name + every field value + footer) exceeds **6000 code points**. Any embed that fans out a variable number of fields from server data (e.g. one field per poll option, one per group) MUST guard the cumulative total, not just each field:

1. **Count code points with `[...str].length`, never `str.length`.** Discord counts code points, so a `.length` measurement under-counts emoji and astral characters and lets a too-large embed through. Reference: the `cpLen` helper in `src/rest/poll/buildPollVotersView.ts`.
2. **Track cumulative usage and collapse later fields once a headroom budget is exceeded.** Seed the running total with `title + footer`, then for each field add `name + value`; if the next field would push the total over a budget BELOW 6000 (`buildPollVotersView` uses `EMBED_TEXT_BUDGET = 5800` to leave room for the last field), emit a collapsed value (e.g. a count-only "…and N more") instead of the full list. Never assume the per-field 1024 limit alone keeps the embed valid.
3. **When a server-side cap already hid rows** (see `applications/server/AGENTS.md` → "Capping a per-group child list while keeping the true count uncapped"), the "…and N more" suffix count MUST include BOTH the rows the field-length limit dropped AND the rows the server cap dropped: `hiddenByCap = vote_count - voters.length`, and the suffix count is `shownRemaining + hiddenByCap`. Use the uncapped count column from the RPC payload, never `voters.length`, as the source of truth for the displayed total.

### Discord Markdown Link Injection

Whenever an embed/message renders a `[label](url)` Discord markdown link from user-supplied data, follow the canonical pattern in `src/rest/events/locationDisplay.ts`:

1. Validate the URL with `EventApi.isPublicHttpsUrl(url)` from `@sideline/domain`. If it returns `false`, fall back to plain text (no link). Never render an unvalidated URL inside `(…)`.
2. Escape the label by replacing `\` with `\\` first, then `]` with `\]` — order matters (escape backslashes before brackets, otherwise the bracket-escape's added backslash would be re-escaped).
3. Wrap the URL in angle brackets: `[label](<url>)`. The `<…>` form lets URLs containing `(` or `)` (common in Google Maps and Wikipedia links) render correctly and prevents Discord from greedily terminating the URL at the first `)`.

Do not roll your own escaper — call `locationDisplay` (or extract a sibling helper that mirrors its three steps). The same input contract applies to any future field that pairs free-text with an external URL.

### Paginated Embed Pattern

Two pagination models are used:

#### Multi-item pages (attendees)

1. Embed builder in `src/rest/events/` exports a `PAGE_SIZE` constant and a `build*Embed` function
2. The builder returns `{ embeds, components }` where `components` contains Previous/Next buttons when `total > PAGE_SIZE`
3. Button `custom_id` format: `{prefix}:{guildId}:{userId?}:{offset}` — offset-based pagination
4. Previous button is disabled when `offset === 0`; Next button is disabled when `offset + PAGE_SIZE >= total`
5. The slash command handler sends an initial ephemeral "thinking" response, forks a background fiber, then updates the message
6. The page button interaction handler responds with `DEFERRED_UPDATE_MESSAGE` and edits in place

#### Single-event ephemeral messages (upcoming events)

Used by `/event list`. Instead of pagination, the bot sends one ephemeral follow-up message per upcoming event (max 10). Each message shows one event with the invoking user's RSVP status. (The old `/event overview` command and `overview-show` button — `src/commands/event/overview.ts`, `src/interactions/overview-channel.ts`, `OverviewShowButton` — were REMOVED in the events-overview rework; the always-on private per-member channels of "Personal Events Sync" replace that on-demand snapshot. Do not reintroduce them.)

1. `buildUpcomingEventEmbed` in `src/rest/events/buildUpcomingEventEmbed.ts` accepts `{ entry, locale }` and returns `{ embeds, components }` with a single action row:
   - **Row 1 — RSVP buttons** (Yes / No / Maybe): `custom_id` = `upcoming-rsvp:{event_id}:{team_id}:{response}`. The button matching the user's current response uses a highlighted style (Success/Danger/Primary); others use Secondary
2. `sendUpcomingEventFollowups` in `src/rest/events/sendUpcomingEventFollowups.ts` is the shared helper used by `/event list`. It calls `Event/GetUpcomingEventsForUser` (fetching up to 10 events), then sends one ephemeral follow-up message per event via `rest.createFollowupMessage`
3. `UpcomingRsvpButton` (`src/interactions/upcoming-rsvp.ts`) handles inline RSVP — submits the RSVP via `Event/SubmitRsvp`, triggers embed updates via `postRsvpDiscordUpdates`, then edits the current ephemeral message to reflect the new RSVP state

#### Stateless ephemeral pagination (email detail / original)

Used by the member-facing "Read detailed summary" / "Read original" buttons under a posted email embed. The full text can exceed Discord's 4096-char embed-description limit, so it is paged into an ephemeral message that only the clicking member sees. The page index is carried entirely in the button `custom_id` — there is NO server-side or in-memory page state. Handlers live in `src/interactions/email-pages.ts`; embed/component builders are `buildPageEmbed` / `buildPageComponents` in `src/rest/email/buildEmailEmbeds.ts`.

Two `custom_id` schemes per "kind" (`detailed` and `original`), all colon-delimited and parsed positionally with `data.custom_id.split(':')` (UUIDs use hyphens, never colons, so the split is safe):

| Action | `custom_id` | Interaction response | Parts |
|--------|-------------|----------------------|-------|
| Open (first page) | `email-detail:{teamId}:{emailId}` / `email-original:{teamId}:{emailId}` | `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` with `flags: Ephemeral` | `[prefix, teamId, emailId]` |
| Navigate | `email-detail-page:{teamId}:{emailId}:{pageIndex}` / `email-original-page:{teamId}:{emailId}:{pageIndex}` | `DEFERRED_UPDATE_MESSAGE` | `[prefix, teamId, emailId, pageIndex]` |

Rules (must be preserved):

1. **Open responds `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` + `Ephemeral`; navigate responds `DEFERRED_UPDATE_MESSAGE`.** Open creates a NEW ephemeral message (only the clicker sees it); navigate edits that same ephemeral message in place. Never use `CHANNEL_MESSAGE_WITH_SOURCE` for open — the read must not be visible to the whole channel.
2. **The page index is stateless — it lives ONLY in the navigate `custom_id`.** Never store page position in memory, a `Ref`, or the DB. The handler re-fetches the content via `Email/GetEmailContent`, re-chunks it, clamps `requestedPageIndex` to `[0, totalPages-1]`, and renders that page. `prev`/`next` buttons embed `pageIndex ± 1` in their own `custom_id`.
3. **Both handler families share `fetchAndRenderPage`** (open passes page `0`; navigate passes the parsed index). It calls `rpc['Email/GetEmailContent']`, derives the text by kind — `detailed` = `Option.getOrElse(content.summary, () => content.body)`, `original` = `content.body` — chunks via `chunkForEmbedDescription`, then `rest.updateOriginalWebhookMessage(application_id, token, ...)`. On `EmailRpcMessageNotFound` / `RpcClientError`, render `m.bot_email_page_empty` instead of failing.
4. **Always chunk embed-description text with `chunkForEmbedDescription`** (`src/rest/email/chunkText.ts`) — never `string.slice`. It is code-point-safe: it splits on paragraph (`\n\n`) → line (`\n`) → word → individual code-point boundaries so no chunk exceeds `maxChars` (default `4096`, the embed-description cap) AND no UTF-8 surrogate pair (emoji) is split mid-character. Reuse it for any future feature that pages arbitrary text into a Discord embed description.
5. **Cap the page count with `capPages`** (`src/rest/email/chunkText.ts`) after chunking. `email-pages.ts` caps to `MAX_PAGES = 20`; when `rawChunks.length > MAX_PAGES`, the last kept page is trimmed (surrogate-safe) to fit the truncation `suffix` within `maxChars`, and the embed footer switches to `m.bot_email_page_indicator_capped` (passing `truncated: true` to `buildPageEmbed`). The suffix is a localized notice (`m.bot_email_truncation_notice` with a `buildEmailDeepLink(env.WEB_URL, …)` markdown link, or `m.bot_email_truncation_notice_no_link` when `WEB_URL` is `None`). Reuse `capPages` for any future Discord pagination that must bound the number of pages.
6. **The actual REST work is forked with `Effect.forkDetach`** and the handler returns the deferred response immediately — Discord requires an interaction ack within 3s, and the RPC + render may take longer. **A forkDetach'd handler that deferred its response MUST resolve that deferred response on every failure, defect, and interrupt path** — otherwise the ephemeral interaction is left spinning "loading" forever. Place a terminal `Effect.catchCause((cause) => Effect.logError('…', cause).pipe(Effect.andThen(errorUpdate(…))))` as the OUTERMOST handler in `fetchAndRenderPage` (after the specific `Effect.catchTag` cases), so any uncaught typed failure (e.g. `RequestError`, `ErrorResponse`) or defect (`Effect.die`) still edits the deferred message with a fallback. This rule applies to all forkDetach'd deferred-interaction handlers, not just email pages. **The visibility flag is fixed at defer time and immutable for the rest of the interaction** — a defer sent without `flags: Ephemeral` is public forever (and one sent with it is ephemeral forever), so every follow-up inherits the defer's visibility; decide ephemeral-vs-public before sending the deferred response, never after (see `src/commands/summarize/handler.ts`, which reads the `private` BOOLEAN option — default ephemeral — to choose the defer flag).
7. **Register all four handlers** (`EmailDetailOpenButton`, `EmailOriginalOpenButton`, `EmailDetailPageButton`, `EmailOriginalPageButton`) in `src/interactions/index.ts`. The middle page-indicator button uses a `{prefix}-disabled:` `custom_id` and `disabled: true` so it never dispatches.

#### Coach claim / release buttons

`ClaimButton` and `UnclaimButton` (`src/interactions/claim.ts`) are matched via `Ix.idStartsWith('claim:')` and `Ix.idStartsWith('unclaim:')`. The `custom_id` format is `claim:{team_id}:{event_id}` and `unclaim:{team_id}:{event_id}` — parsed positionally by `data.custom_id.split(':')`. Both handlers respond with `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` (ephemeral), fork the RPC call (`Event/ClaimTraining` / `Event/UnclaimTraining`) in the background via `Effect.forkDetach`, and edit the original webhook message with the localized result. RPC error tags are mapped to localized strings via `Effect.catchTag`: `ClaimAlreadyClaimed` → `bot_claim_already_claimed_by`, `ClaimNotOwnerGroupMember` → `bot_claim_not_owner`, `ClaimEventInactive` / `ClaimEventNotFound` / `ClaimNotTraining` → `bot_claim_event_cancelled`, `ClaimNotClaimer` → `bot_claim_release_not_claimer`.

#### Roster approve / decline buttons

`RosterApproveButton` and `RosterDeclineButton` (`src/interactions/roster-approval.ts`) are matched via `Ix.idStartsWith('rsv-approve:')` and `Ix.idStartsWith('rsv-decline:')`. The `custom_id` format is `rsv-approve:{eventId}:{memberId}` and `rsv-decline:{eventId}:{memberId}` — parsed positionally by `data.custom_id.split(':')`. Both handlers respond with `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` (ephemeral), fork the RPC call (`Event/ApproveRosterRequest` / `Event/DeclineRosterRequest`, payload `{ event_id, team_member_id, decided_by_discord_id }`) in the background via `Effect.forkDetach`, and edit the original webhook message with the localized result. RPC error tags map to localized strings via `Effect.catchTag`: `NotOwnerGroupMember` → `bot_roster_ephemeral_not_owner`, `RosterRequestNotPending` → `bot_roster_ephemeral_already_handled`, `RosterRequestNotFound` / `EventRosterEventNotFound` → `bot_roster_ephemeral_error`.

Rules:

1. **The Discord path passes `decided_by_discord_id`; the server resolves the decider and enforces owner-group membership.** This is the Discord side of the dual-surface approve/decline convergence — the web path instead authenticates `roster:manage` and passes `membership.id`, but both surfaces converge on `EventRosterProvisioningService.approve`/`decline`. See `applications/server/AGENTS.md` → "Dual-surface roster approve/decline convergence".
2. **On success, the handler disables the source message's button row in place** (`rest.updateMessage` with a disabled `buildDisabledRosterRow`) AND the server emits an `event_roster_approval_cancel` sync so the thread message is deleted — the in-place disable is the immediate UX; the cancel sync is the durable cleanup.
3. **`already_handled` / `already_member` outcomes** edit the follow-up to `bot_roster_ephemeral_already_handled` without re-disabling — the message was already decided.

## Environment Variables (`src/env.ts`)

The bot uses `@t3-oss/env-core` + Effect `Schema.toStandardSchemaV1` for env decoding. Every var must declare a Schema (no raw `process.env.X` access in production code — always import `env` from `~/env.js`).

### Optional Env Var Pattern

For an optional string env var that should decode to `Option<string>` (absent or empty → `Option.none()`), use `Schema.OptionFromNullishOr(Schema.NonEmptyString)`. This is the canonical shape — `WEB_URL` and `LOG_LEVEL` both follow it:

```ts
WEB_URL: Schema.toStandardSchemaV1(Schema.OptionFromNullishOr(Schema.NonEmptyString)),
LOG_LEVEL: Schema.toStandardSchemaV1(Schema.OptionFromNullishOr(Schemas.LogLevelFromString)),
```

Rules:

1. **Always decode to `Option<T>` for optional env vars.** Never use `string | undefined` — downstream handlers must `Option.match` explicitly, never `if (env.X !== undefined)`.
2. **Use `Schemas.Optional(() => default)` from `@sideline/effect-lib` only when a fallback DEFAULT exists** (e.g. `HEALTH_PORT` defaults to `9000`, `RPC_PREFIX` defaults to `''`). Never combine `Optional(() => default)` with `OptionFromNullishOr` — the two are mutually exclusive shapes.
3. **`emptyStringAsUndefined: true` is set on `createEnv`.** An env var set to `""` decodes to `Option.none()`, not `Option.some("")`. Producer-side code (Docker compose, GitHub Actions) may rely on this — never flip the flag.

### Mocking `~/env.js` in Tests

`@t3-oss/env-core` runs its decode once at module load and freezes the result. `vi.stubEnv('WEB_URL', '...')` AFTER the test file has imported anything that transitively imports `~/env.js` has no effect on what the production code reads. To toggle env values per test:

1. Declare a mutable ref at module top with the desired shape (e.g. `let mockWebUrl: Option.Option<string> = Option.none();`).
2. Call `vi.mock('~/env.js', factory)` BEFORE any non-type production imports. `vi.mock` is hoisted by Vitest to the top of the file, so the factory runs before `~/env.js` is evaluated. Inside the factory, return `{ env: new Proxy(...) }` whose getter reads the mutable ref.
3. In `afterEach`, reset the ref to its default.

Canonical example: `applications/bot/test/rcp/weeklyChallenge/ProcessorService.test.ts`. Do not reach for `vi.stubEnv` or `process.env.X = '...'` for bot env vars — both are no-ops against the frozen `env` object.

## Test File Imports — Static Only

The repo-root `vitest.config.ts` sets `sequence.concurrent: true`, so every test inside a file runs in parallel. Dynamic `await import('~/<module>.js')` inside a test helper (e.g. a `runProcessTick` wrapper) re-pays Vitest's module-graph resolution + transform on every call, which under parallel execution causes 5-second test timeouts and flaky CI runs. Reference fix: `applications/bot/test/rcp/onboarding/ProcessorService.test.ts` (hoisted `ProcessorService` import to the top of file).

Rules:

1. **Always import modules under test at the top of the test file** with a static `import { X } from '~/path/to/X.js'`. Never call `await import('~/...')` inside `it`, `beforeEach`, or test-local helpers.
2. **TDD-scaffolding dynamic imports must be hoisted the moment the module under test exists.** A comment like `// TDD mode — these tests will FAIL until Phase N implements X` plus a dynamic `await import` is a transitional state, not a permanent pattern; remove both the comment and the dynamic import in the same commit that lands the implementation.
3. **The only legitimate `await import('~/...')` inside a test body is when the test asserts on side effects of module loading itself** (e.g. registration order). Such cases must include a comment explaining why the static import is insufficient.
4. **Known offenders to hoist** (left over from earlier TDD phases): `test/events/ready.test.ts`, `test/events/guildRoleEvents.test.ts`, `test/events/guildMemberUpdate.test.ts`, `test/rcp/channel/handleMemberAdded.test.ts`. Hoist each one's dynamic imports when next touching the file.
