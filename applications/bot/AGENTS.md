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
├── commands/        — Slash command registry (event/create, event/list, event/overview, makanicko/*, finance/*, info, summon)
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
    ├── reorderChannelMessages.ts       — Channel reorder algorithm (longest keepable prefix); exports MAX_CHANNEL_EVENTS = 10
    ├── recoverDeletedMessages.ts       — Startup recovery: bulk listMessages + snowflake overrides → reorderChannelMessages
    ├── handleCreated.ts                — event_created handler
    ├── handleUpdated.ts                — event_updated handler
    ├── handleCancelled.ts              — event_cancelled handler
    ├── handleStarted.ts                — event_started handler (updates embed, removes RSVP buttons)
    ├── handleRsvpReminder.ts           — rsvp_reminder handler
    ├── handleTrainingClaimRequest.ts   — training_claim_request handler (posts claim embed, saves message id back via Event/SaveClaimDiscordMessageId)
    ├── handleTrainingClaimUpdate.ts    — training_claim_update handler (edits existing claim embed in place)
    └── handleUnclaimedTrainingReminder.ts — unclaimed_training_reminder handler (posts reminder pointing to claim message)
└── rest/events/     — Embed builder functions
    ├── buildEventEmbed.ts              — Main event embed (RSVP counts, "Going" field)
    ├── buildAttendeesEmbed.ts          — Paginated attendee list embed
    ├── buildUpcomingEventEmbed.ts      — Per-user upcoming events embed (/event list, overview button)
    ├── buildClaimMessage.ts            — Coach-claim embed + Claim/Release button row
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

Rules:

1. **`handleCreated`** dispatches on `(existing_channel_id, discord_channel_name)`:
   - `existing_channel_id = Some` → use `createRoleForChannel` against the existing channel, then `Channel/UpsertMapping` with both ids.
   - `existing_channel_id = None` AND `discord_channel_name = Some` → call `createChannelOnly`, then immediately `Channel/UpsertGroupChannel` (persist channel id), then `createRoleForChannel`, then `Channel/UpsertMapping`. The intermediate upsert prevents orphan Discord channels if role creation fails and the event retries.
   - `existing_channel_id = None` AND `discord_channel_name = None` → call `createRoleOnly`, then `Channel/UpsertMappingRoleOnly`. No channel is created.
2. **`handleMemberAdded`** must NEVER call `createGuildChannel`. It reads the mapping via `Channel/GetMapping` and:
   - mapping `None` → `createRoleOnly` + `Channel/UpsertMappingRoleOnly` + `addGuildMemberRole`.
   - mapping has `discord_role_id = Some` → `addGuildMemberRole` only.
   - mapping has `discord_channel_id = Some, discord_role_id = None` → `createRoleForChannel` against the existing channel + `Channel/UpsertMapping` + `addGuildMemberRole`.
3. **`handleUpdated`** processes each side independently: `Option.match` on `discord_role_id` (update role name + color) and on `discord_channel_id` (rename channel + call `Guild/UpdateChannelName`). If both are `None`, log a warning and no-op — never throw.
4. **`handleDeleted`** deletes the channel (if `discord_channel_id = Some`) and the role (if `discord_role_id = Some`) independently, then calls `Channel/DeleteMapping`. This is the only path that removes the mapping row.
5. **`handleArchived`** moves the channel to the archive category if `discord_channel_id = Some`; on failure falls back to deleting only the channel (`Option.none()` for role). It does NOT delete the role, does NOT call `Channel/DeleteMapping` — the server has already cleared `discord_channel_id` via `clearGroupChannel` before emitting.
6. **`handleDetached`** deletes the role's permission overwrite from the channel when both ids are `Some`; otherwise no-op. It does NOT delete the role, does NOT delete the channel, does NOT call `Channel/DeleteMapping` — the server has already cleared `discord_channel_id`.
7. **Never re-introduce `ensureMapping`.** The helper was removed; provisioning is split across `createChannelOnly` / `createRoleOnly` / `createRoleForChannel` / `createChannelWithRole`, each with a narrow contract. Splitting prevents racy fat-upserts that would nullify the unrelated column.

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

### Event Sync (events → Discord messages)

Syncs event lifecycle to Discord embed messages. When events are created/updated/cancelled/started, the server emits events to `event_sync_events`.

| Component | File |
|-----------|------|
| Domain model | `packages/domain/src/rpc/event/EventRpcEvents.ts` |
| Bot service | `src/rcp/event/ProcessorService.ts` |

Event types: `event_created`, `event_updated`, `event_cancelled`, `event_started`, `rsvp_reminder`, `training_claim_request`, `training_claim_update`, `unclaimed_training_reminder`

The `event_started` handler updates the Discord embed to remove RSVP buttons and rebuilds the embed with current RSVP counts.

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

#### Coach-claim message id round-trip

The `training_claim_request` handler posts the initial claim embed to the owner-group channel. The server does not know the resulting Discord channel/message id ahead of time. After `rest.createMessage` succeeds, the handler must call `rpc['Event/SaveClaimDiscordMessageId']({ event_id, channel_id, message_id })` so subsequent `training_claim_update` and `unclaimed_training_reminder` events can locate and edit / link to that message. Always save the id in the same effect chain as the create call (via `Effect.tap`) so a failure to save is logged together with the create.

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

Two distinct schedules wrap processor `processTick` effects:

| Helper | Cadence | Schedule | Used by |
|--------|---------|----------|---------|
| `pollLoop` | 5s | `Schedule.spaced('5 seconds')` | `roles.processTick`, `channels.processTick`, `eventSync.processTick`, `guildJoin.processTick`, `onboarding.processTick` |
| `fastPollLoop` | 1s | `Schedule.spaced('1 seconds')` | `inviteGenerator.processTick` only |

Rules:

1. **`fastPollLoop` is reserved for the invite generator.** The web client begins polling `GET /invite/acceptances/:acceptanceId` immediately after a user accepts an invite; the 1s cadence keeps the wait between accept and the "Open Discord server" CTA under ~2s.
2. **Never promote other services to `fastPollLoop`** without explicit justification — every additional 1s loop multiplies idle RPC load.
3. **Never demote `inviteGenerator` back to `pollLoop`** — the user-visible latency on `InvitePage` depends on this cadence.

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

`formatName` in `src/rest/utils.ts` is the single implementation for resolving a user's display name. Always use it instead of building name resolution inline.

**Fallback priority** (first `Some` wins):
1. `name` — user's real name (from profile)
2. `nickname` — Discord server nickname
3. `display_name` — Discord global display name (`global_name`)
4. `username` — Discord username (always present)

If all are `None`, returns `"Unknown"`.

`formatName` accepts a **structural type** — any object with `{ name, nickname, display_name, username }` as `Option<string>` fields. `formatNameWithMention` additionally requires `discord_id: Option<string>`. This five-field tuple `{ discord_id, name, nickname, display_name, username }` (all `Option<string>`) is the **canonical identity-tuple** for any embed/message that mentions a user. `RsvpAttendeeEntry` and `NonResponderRpcEntry` already match it; new RPC event payloads that carry a user identity (e.g. `TrainingClaimUpdateEvent.claimed_by_*`) MUST use the same five field names so call sites can pass the payload directly to `formatNameWithMention` without per-call adapters.

```typescript
import { formatName } from '~/rest/utils.js';

// Works with any object matching the structural type
const displayText = formatName(attendeeEntry); // => "**Alice**"
```

`formatNameWithMention` (same file) is the mention-aware variant. It additionally requires `discord_id: Option<string>` on the entry and returns `**Name** (<@id>)`, `**Name**`, `<@id>`, or `"Unknown"` per the table above. Use it when the embed should render the mention alongside the bold name; use `formatName` when only the bold name is wanted.

This pattern is used in:
- `buildEventEmbed.ts` — "Going" field (bold name only via `formatName`, no mention, comma-separated)
- `buildAttendeesEmbed.ts` — attendee entries via `formatNameWithMention` (with optional message suffix)
- `handleRsvpReminder.ts` — non-responder and yes-attendee lists via `formatNameWithMention`
- `buildClaimMessage.ts` — Status field renders the claimer via `formatNameWithMention`; `claimedBy` is `Option<ClaimedByEntry>` where `ClaimedByEntry` is the canonical five-field identity-tuple

When building new embed functions that display user names, always use `formatName` for the bold name portion and follow this priority: bold name first, mention as parenthetical supplement.

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

Used by `/event list` and the overview show button (`overview-show`). Instead of pagination, the bot sends one ephemeral follow-up message per upcoming event (max 10). Each message shows one event with the invoking user's RSVP status.

1. `buildUpcomingEventPage` in `src/rest/events/buildUpcomingEventEmbed.ts` accepts `{ entry, locale }` and returns `{ embeds, components }` with a single action row:
   - **Row 1 — RSVP buttons** (Yes / No / Maybe): `custom_id` = `upcoming-rsvp:{event_id}:{team_id}:{response}`. The button matching the user's current response uses a highlighted style (Success/Danger/Primary); others use Secondary
2. `sendUpcomingEventFollowups` in `src/rest/events/sendUpcomingEventFollowups.ts` is the shared helper used by both `/event list` and `OverviewShowButton`. It calls `Event/GetUpcomingEventsForUser` (fetching up to 10 events), then sends one ephemeral follow-up message per event via `rest.createFollowupMessage`
3. `UpcomingRsvpButton` (`src/interactions/upcoming-rsvp.ts`) handles inline RSVP — submits the RSVP via `Event/SubmitRsvp`, triggers embed updates via `postRsvpDiscordUpdates`, then edits the current ephemeral message to reflect the new RSVP state
4. `OverviewShowButton` (`src/interactions/overview-channel.ts`) handles the `overview-show` button — delegates to `sendUpcomingEventFollowups`

#### Coach claim / release buttons

`ClaimButton` and `UnclaimButton` (`src/interactions/claim.ts`) are matched via `Ix.idStartsWith('claim:')` and `Ix.idStartsWith('unclaim:')`. The `custom_id` format is `claim:{team_id}:{event_id}` and `unclaim:{team_id}:{event_id}` — parsed positionally by `data.custom_id.split(':')`. Both handlers respond with `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` (ephemeral), fork the RPC call (`Event/ClaimTraining` / `Event/UnclaimTraining`) in the background via `Effect.forkDetach`, and edit the original webhook message with the localized result. RPC error tags are mapped to localized strings via `Effect.catchTag`: `ClaimAlreadyClaimed` → `bot_claim_already_claimed_by`, `ClaimNotOwnerGroupMember` → `bot_claim_not_owner`, `ClaimEventInactive` / `ClaimEventNotFound` / `ClaimNotTraining` → `bot_claim_event_cancelled`, `ClaimNotClaimer` → `bot_claim_release_not_claimer`.

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
