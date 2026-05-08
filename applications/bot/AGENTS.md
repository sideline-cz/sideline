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
├── commands/        — Slash command registry (event/create, event/list, event/overview, makanicko/*)
├── interactions/    — Component interaction registry (buttons/selects/modals)
├── events/          — Gateway event handler registry (guild, member, invite, channel lifecycle)
├── services/        — Sync services (RoleSyncService, ChannelSyncService) and welcome helpers (InviteCache, inviteDiff, welcomeRenderer)
├── rcp/channel/     — Channel sync event handlers
│   ├── ProcessorService.ts    — Match.tag dispatcher for channel events
│   ├── channelUtils.ts        — Shared Discord helpers (deleteRole, deleteChannelAndRole)
│   ├── handleCreated.ts       — channel_created handler
│   ├── handleUpdated.ts       — channel_updated handler (rename channel + role, update role color)
│   ├── handleDeleted.ts       — channel_deleted handler
│   ├── handleArchived.ts      — channel_archived handler (archive or fallback to delete)
│   ├── handleMemberAdded.ts   — member_added handler
│   ├── handleMemberRemoved.ts — member_removed handler
│   └── handleRosterChannelCreated.ts — roster channel_created handler
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

**Name fields on `channel_created` and `channel_updated` events**: The server pre-formats Discord names using team settings. Events carry separate `discord_channel_name` (for the Discord channel) and `discord_role_name` (for the Discord role). Bot handlers must use these fields instead of deriving names from `group_name` or `roster_name`. Exception: `member_added` handlers may fall back to `group_name` since the channel is normally already created by the `channel_created` event with the correct format. The `ensureMapping` and `createDiscordChannelAndRole` functions accept separate `channelName` and `roleName` parameters.

**Color field on `channel_created` and `channel_updated` events**: Events carry `discord_role_color` as `Option<number>` (Discord integer color). The server converts hex colors (e.g. `#FF0000`) to Discord integers before emitting. Bot handlers pass this value to `createRoleForChannel` or `updateGuildRole` as the `color` parameter.

#### Channel Update

When a group or roster name/emoji/color changes, the server emits `channel_updated`. The bot handler in `src/rcp/channel/handleUpdated.ts`:

1. Updates the Discord role via `updateGuildRole` (name + color)
2. Updates the Discord channel via `updateChannel` (name)
3. Calls `rpc['Guild/UpdateChannelName']` to sync the new channel name back to the `discord_channels` table on the server

Both `handleGroupChannelUpdated` and `handleRosterChannelUpdated` delegate to the same shared logic.

#### Channel Archival

When a team has `discord_archive_category_id` set, deleting a group or deactivating a roster emits `channel_archived` instead of `channel_deleted`. The bot handler in `src/rcp/channel/handleArchived.ts`:

1. Moves the Discord channel to the archive category via `updateChannel({ parent_id })`
2. Deletes the permission overwrite for the channel role
3. Deletes the Discord role
4. On any failure, falls back to full channel+role deletion (same as `channel_deleted`)

Each handler (`handleGroupArchived`, `handleRosterArchived`) follows this pattern and then calls the appropriate RPC to clean up mappings.

### Event Sync (events → Discord messages)

Syncs event lifecycle to Discord embed messages. When events are created/updated/cancelled/started, the server emits events to `event_sync_events`.

| Component | File |
|-----------|------|
| Domain model | `packages/domain/src/rpc/event/EventRpcEvents.ts` |
| Bot service | `src/rcp/event/ProcessorService.ts` |

Event types: `event_created`, `event_updated`, `event_cancelled`, `event_started`, `rsvp_reminder`, `training_claim_request`, `training_claim_update`, `unclaimed_training_reminder`

The `event_started` handler updates the Discord embed to remove RSVP buttons and rebuilds the embed with current RSVP counts.

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

1. Bot service polls via `rpc.GetUnprocessed*Events({ limit: 50 })` every 5 seconds
2. Processes each event (Discord REST calls with exponential retry)
3. Marks events as processed or failed
4. Mapping tables track the Discord resource ID for each domain entity

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
