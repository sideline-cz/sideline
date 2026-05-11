# Discord Bot

This document describes the commands, interactions, gateway event handlers, and background sync workers of the Sideline Discord bot.

## Overview

The bot is built with **dfx**, an Effect-native Discord framework. It connects to Discord via a WebSocket gateway and exposes slash commands and component interactions to users.

**Bot-to-server communication** uses Effect RPC over HTTP. The bot is a pure RPC client; all persistence and business logic lives in the server. The RPC endpoint is `{SERVER_URL}{RPC_PREFIX}/` (the prefix defaults to an empty string, so in production the path is just `/`).

**Localization** is Czech (`cs`) and English (default). Ephemeral messages (visible only to the invoking user) use the user's Discord client language. Permanent guild messages (event embeds, reminders) use the guild's preferred language. The resolution logic is in `applications/bot/src/locale.ts`.

**Gateway intents** required by the bot: `Guilds`, `GuildMembers`, and `GuildInvites`.

**Source layout:**

| Path | Contents |
|------|----------|
| `applications/bot/src/commands/` | Slash command definitions and option handlers |
| `applications/bot/src/interactions/` | Button, modal, and autocomplete handlers |
| `applications/bot/src/events/` | Gateway dispatch event handlers |
| `applications/bot/src/rcp/` | RPC sync worker loops (note: directory is named `rcp`, a typo in the codebase; the intended meaning is `rpc`) |
| `applications/bot/src/services/SyncRpc.ts` | Typed RPC client service |
| `applications/bot/src/services/InviteCache.ts` | In-memory per-guild invite usage snapshot used to identify which invite a new member used |
| `applications/bot/src/services/inviteDiff.ts` | Pure function that diffs a before/after invite usage snapshot to find the winning invite code |
| `applications/bot/src/services/welcomeRenderer.ts` | Builds the Discord embed payloads for the welcome message and the system log |
| `applications/bot/src/rest/` | Discord REST helpers (embed builders, permission helpers) |

---

## Slash Commands

Two top-level commands are registered globally: `/event` and `/makanicko`. Each has sub-commands.

### /event create

**Description:** Create a new event for the guild.

**Czech sub-command name:** `vytvořit`

**Options:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `type` | String (choices) | Yes | Event type |
| `training_type` | String (autocomplete) | No | Training type ID; only relevant when `type=training` |

**`type` choices:**

| Value | Display name | Czech |
|-------|-------------|-------|
| `training` | Training | Trénink |
| `match` | Match | Zápas |
| `tournament` | Tournament | Turnaj |
| `meeting` | Meeting | Schůzka |
| `social` | Social | Společenská |
| `other` | Other | Jiné |

**Flow:**

1. User invokes `/event create type:training training_type:Strength`.
2. The command handler (`applications/bot/src/commands/event/create.ts`) opens a Discord modal with `custom_id` `event-create:{eventType}:{trainingTypeId}`.
3. The modal contains five text input fields:

   | Field `custom_id` | Label | Required | Max length | Style |
   |-------------------|-------|----------|------------|-------|
   | `event_title` | Title | Yes | 100 | Single-line |
   | `event_start` | Start | Yes | 16 | Single-line (placeholder: `YYYY-MM-DDTHH:mm`) |
   | `event_end` | End | No | 16 | Single-line (placeholder: `YYYY-MM-DDTHH:mm`) |
   | `event_location` | Location | No | 200 | Single-line |
   | `event_description` | Description | No | 1000 | Multi-line |

4. User submits the modal. The modal submit handler (`applications/bot/src/interactions/event-create.ts`) sends an immediate ephemeral "thinking" response, then forks a background fiber.
5. The background fiber calls `Event/CreateEvent` RPC with the parsed fields.
6. On success the ephemeral message is updated with the event title. On error an appropriate error message is shown.

**Autocomplete:** When the focused option is `training_type` and the event `type` is `training`, the autocomplete handler (`applications/bot/src/interactions/event-create-autocomplete.ts`) calls `Event/GetTrainingTypesByGuild` RPC, filters results case-insensitively by the user's current input, takes up to 24 matches, and appends a fixed `{ name: "Other", value: "" }` entry. If `type` is not `training` the handler returns an empty choices list immediately.

**Errors from `Event/CreateEvent`:**

| Error tag | User-visible message |
|-----------|----------------------|
| `CreateEventNotMember` | Not a member of this team |
| `CreateEventForbidden` | Missing permission to create events |
| `CreateEventInvalidDate` | Invalid date format |

**Source files:**
- `applications/bot/src/commands/event/create.ts`
- `applications/bot/src/interactions/event-create.ts`
- `applications/bot/src/interactions/event-create-autocomplete.ts`

---

### /event overview

**Description:** Post the events overview message in this channel.

**Czech sub-command name:** `prehled`

**Options:** None.

**Permission required:** `Manage Server` (checked at the top of the handler; members lacking this permission receive an ephemeral error).

**Flow:**

1. User with Manage Server permission invokes `/event overview`.
2. The handler (`applications/bot/src/commands/event/overview.ts`) immediately returns an ephemeral acknowledgement.
3. A background fiber posts a persistent public message containing a "Show My Events" button in the current channel.
4. When a member clicks the button, the `OverviewShowButton` handler (`applications/bot/src/interactions/overview-channel.ts`) delegates to `sendUpcomingEventFollowups`, which calls `Event/GetUpcomingEventsForUser` RPC and sends one ephemeral message per upcoming event (up to 10), each with RSVP buttons.

**Source files:**
- `applications/bot/src/commands/event/overview.ts`
- `applications/bot/src/interactions/overview-channel.ts` (`OverviewShowButton`)
- `applications/bot/src/rest/events/sendUpcomingEventFollowups.ts`

---

### /event list

**Description:** Show the invoking user's upcoming events with per-user RSVP visibility (one ephemeral message per event).

**Czech sub-command name:** `seznam`

**Options:** None.

**Flow:**

1. User invokes `/event list`.
2. The handler (`applications/bot/src/commands/event/list.ts`) immediately returns an ephemeral acknowledgement and forks a background fiber.
3. The background fiber delegates to `sendUpcomingEventFollowups`, which calls `Event/GetUpcomingEventsForUser` RPC with `discord_user_id` (resolved via `interactionUserId` helper) and `limit=10`.
4. For each event in the response (up to 10), a separate ephemeral follow-up message is sent. Each message shows: event title, description, Discord dynamic timestamps, optional location, RSVP counts, and the invoking user's own RSVP status, with inline RSVP buttons.
5. If there are no upcoming events, a single ephemeral "no events" message is sent instead.

**Errors from `Event/GetUpcomingEventsForUser`:**

| Error tag | Behavior |
|-----------|----------|
| `GuildNotFound` | Shows "not a member" message |
| `RsvpMemberNotFound` | Shows "not a member" message |

**Source files:**
- `applications/bot/src/commands/event/list.ts`
- `applications/bot/src/interactions/upcoming-rsvp.ts`
- `applications/bot/src/rest/events/buildUpcomingEventEmbed.ts`
- `applications/bot/src/rest/events/sendUpcomingEventFollowups.ts`

---

### /makanicko log

**Description:** Log a physical activity.

**Czech sub-command name:** `zaznamenat`

**Options:**

| Name | Type | Required | Constraints | Description |
|------|------|----------|-------------|-------------|
| `activity` | String (choices) | Yes | — | Activity type |
| `duration` | Integer | No | 1–1440 | Duration in minutes |
| `note` | String | No | — | Free-text note |

**`activity` choices:**

| Value | Display name | Czech |
|-------|-------------|-------|
| `gym` | Gym | Posilovna |
| `running` | Running | Běh |
| `stretching` | Stretching | Protahování |

**Flow:**

1. User invokes `/makanicko log activity:gym duration:45`.
2. The handler sends an immediate ephemeral "thinking" response and forks a background fiber.
3. The background fiber calls `Activity/LogActivity` RPC with `guild_id`, `discord_user_id`, `activity_type` (slug), and optional `duration_minutes` and `note`.
4. On success the ephemeral message is updated with a confirmation showing the logged activity type.

**Errors from `Activity/LogActivity`:**

| Error tag | Behavior |
|-----------|----------|
| `ActivityGuildNotFound` | Generic error message |
| `ActivityMemberNotFound` | "Not a member" message |

**Source file:** `applications/bot/src/commands/makanicko/log.ts`

---

### /makanicko stats

**Description:** View personal activity stats and streaks.

**Czech sub-command name:** `statistiky`

**Options:** None.

**Flow:**

1. User invokes `/makanicko stats`.
2. The handler sends an immediate ephemeral "thinking" response and forks a background fiber.
3. The background fiber calls `Activity/GetStats` RPC with `guild_id` and `discord_user_id`.
4. If `total_activities` is 0 the embed shows an empty-state description.
5. Otherwise the embed includes:
   - **Description:** current streak (days) and longest streak (days).
   - **Fields:** total activity count, total duration (formatted as `Xh Ym`), and a per-activity-type breakdown. Spacer fields (`\u200b`) are inserted to maintain a three-column grid layout for the breakdown.
   - **Footer:** attribution text.

**Errors from `Activity/GetStats`:**

| Error tag | Behavior |
|-----------|----------|
| `ActivityGuildNotFound` | Generic error message |
| `ActivityMemberNotFound` | "Not a member" message |

**Source file:** `applications/bot/src/commands/makanicko/stats.ts`

---

### /makanicko leaderboard

**Description:** View the team activity leaderboard.

**Czech sub-command name:** `zebricek`

**Options:** None.

**Flow:**

1. User invokes `/makanicko leaderboard`.
2. The handler sends an immediate ephemeral "thinking" response and forks a background fiber.
3. The background fiber calls `Activity/GetLeaderboard` RPC with `guild_id`, `discord_user_id`, and `limit=None` (no server-side limit; the bot slices to top 10 client-side).
4. If `entries` is empty the embed shows an empty-state description.
5. Otherwise the embed description lists up to 10 entries, each formatted as `{rank}. {username} — {total_activities}`.
6. The footer shows the requesting user's own rank (from `requesting_user_rank`) or a "not ranked" message if absent.

**Errors from `Activity/GetLeaderboard`:**

| Error tag | Behavior |
|-----------|----------|
| `ActivityGuildNotFound` | Generic error message |
| `ActivityMemberNotFound` | "Not a member" message |

**Source file:** `applications/bot/src/commands/makanicko/leaderboard.ts`

---

## Button and Modal Interactions

All interaction handlers are registered in `applications/bot/src/interactions/index.ts`. Each handler pattern-matches on the `custom_id` prefix.

### RSVP Button — `rsvp:{teamId}:{eventId}:{response}`

Attached to every event embed message. Clicking saves the RSVP immediately and opens an ephemeral confirmation with message management buttons.

**Custom ID pattern:** `rsvp:{teamId}:{eventId}:{response}` where `response` is one of `yes`, `no`, `maybe`.

**Behavior:**

1. Parses `teamId`, `eventId`, and `response` from the custom ID.
2. Sends an immediate ephemeral "thinking" response and forks a background fiber.
3. The background fiber calls `Event/SubmitRsvp` RPC with `message: none` and `clearMessage: false`, which records the response while preserving any existing message (the SQL upsert uses `COALESCE(new_message, existing_message)`).
4. On success, the background fiber also runs `postRsvpDiscordUpdates` to rebuild and edit the original event embed (fetching `Event/GetDiscordMessageId`, `Event/GetEventEmbedInfo`, `Event/GetYesAttendeesForEmbed`, and the guild locale). If the RSVP was late (`isLateRsvp = true`) and `lateRsvpChannelId` is present, it also posts an orange-coloured notification embed to that channel.
5. Updates the ephemeral "thinking" message with a localised confirmation. If the RSVP was late, a polite hint is appended.
6. The ephemeral message includes one action row of buttons based on whether the member already has a message:
   - **No existing message:** `[💬 Add a message]` (`rsvp-add-msg:…`)
   - **Message exists:** `[💬 Edit message]` (`rsvp-add-msg:…`) and `[🗑️ Clear message]` (`rsvp-clear-msg:…`)

**Errors from `Event/SubmitRsvp`:**

| Error tag | User-visible message |
|-----------|----------------------|
| `RsvpDeadlinePassed` | RSVP deadline has passed |
| `RsvpMemberNotFound` | Not a member of this team |
| `RsvpNotGroupMember` | Not a member of the required group |
| `RsvpEventNotFound` | Event not found |

**Source file:** `applications/bot/src/interactions/rsvp.ts` (`RsvpButton`)

---

### RSVP Add/Edit Message Button — `rsvp-add-msg:{teamId}:{eventId}:{response}`

Appears in the ephemeral confirmation after clicking an RSVP button. Opens a modal so the member can add or edit their personal message without changing their RSVP response.

**Custom ID pattern:** `rsvp-add-msg:{teamId}:{eventId}:{response}`

**Behavior:**

1. Parses `teamId`, `eventId`, and `response` from the custom ID.
2. Opens a modal with `custom_id` `rsvp-modal:{teamId}:{eventId}:{response}`.
3. The modal has one optional multi-line text field (`custom_id: rsvp_message`, max 200 characters).

**Source file:** `applications/bot/src/interactions/rsvp.ts` (`RsvpAddMessageButton`)

---

### RSVP Clear Message Button — `rsvp-clear-msg:{teamId}:{eventId}:{response}`

Appears alongside the "Edit message" button in the ephemeral confirmation when the member already has a message. Clears the message without changing the RSVP response.

**Custom ID pattern:** `rsvp-clear-msg:{teamId}:{eventId}:{response}`

**Behavior:**

1. Parses `teamId`, `eventId`, and `response` from the custom ID.
2. Sends an immediate ephemeral "thinking" response and forks a background fiber.
3. The background fiber calls `Event/SubmitRsvp` RPC with `message: none` and `clearMessage: true`, which sets the stored message to NULL.
4. Runs `postRsvpDiscordUpdates` to rebuild the event embed.
5. Updates the ephemeral message with a localised "message cleared" confirmation and replaces the action row with only the `[💬 Add a message]` button.

**Errors from `Event/SubmitRsvp`:** same as RSVP Button.

**Source file:** `applications/bot/src/interactions/rsvp.ts` (`RsvpClearMessageButton`)

---

### RSVP Modal — `rsvp-modal:{teamId}:{eventId}:{response}`

Handles submission of the RSVP modal opened by the "Add/Edit message" button.

**Behavior:**

1. Parses `teamId`, `eventId`, `response`, and optional `rsvp_message` from the submission.
2. Sends an immediate ephemeral "thinking" response and forks a background fiber.
3. The background fiber calls `Event/SubmitRsvp` RPC with the provided `message` and `clearMessage: false`.
4. Runs `postRsvpDiscordUpdates` to rebuild the event embed.
5. Updates the ephemeral message with a localised "Message saved." confirmation and rebuilds the action row (showing "Edit message" + "Clear message" if the message is set, or "Add a message" otherwise).

**Errors from `Event/SubmitRsvp`:** same as RSVP Button.

**Source file:** `applications/bot/src/interactions/rsvp.ts` (`RsvpModal`)

---

### Attendees Button — `attendees:{teamId}:{eventId}:{offset}`

Appears on event embeds (separate from the RSVP buttons). Opens a paginated attendee list in an ephemeral response.

**Custom ID pattern:** `attendees:{teamId}:{eventId}:{offset}`

**Behavior:**

1. Parses `teamId`, `eventId`, and `offset` (defaults to 0) from the custom ID.
2. Sends an immediate ephemeral "thinking" response and forks a background fiber.
3. The background fiber calls `Event/GetRsvpAttendees` RPC with `limit=15`.
4. Builds and posts an attendee embed with page navigation buttons (`attendees-page:…`).

**Source file:** `applications/bot/src/interactions/attendees.ts` (`AttendeesButton`)

---

### Attendees Page Button — `attendees-page:{teamId}:{eventId}:{offset}`

Updates an existing attendees embed when the user pages through the list.

**Custom ID pattern:** `attendees-page:{teamId}:{eventId}:{offset}`

**Behavior:** Same as Attendees Button but responds with `DEFERRED_UPDATE_MESSAGE` (edits the existing message in place rather than sending a new ephemeral reply).

**Source file:** `applications/bot/src/interactions/attendees.ts` (`AttendeesPageButton`)

---

### Upcoming RSVP Button — `upcoming-rsvp:{eventId}:{teamId}:{response}`

Appears on each per-user upcoming event message (produced by `/event list` and the overview show button). Clicking saves the RSVP immediately and refreshes that message to show the updated response and counts.

**Custom ID pattern:** `upcoming-rsvp:{eventId}:{teamId}:{response}` where `response` is one of `yes`, `no`, `maybe`.

**Behavior:**

1. Parses `eventId`, `teamId`, and `response` from the custom ID.
2. Responds with `DEFERRED_UPDATE_MESSAGE` and forks a background fiber.
3. The background fiber calls `Event/SubmitRsvp` RPC (same as the standard RSVP button), then runs `postRsvpDiscordUpdates` to rebuild the public event embed.
4. After the RSVP is recorded, re-fetches the event's embed info and rebuilds the per-user upcoming embed, updating the current ephemeral message in place.

**Errors:** same as RSVP Button, plus `GuildNotFound` (shows "not a member" message).

**Source file:** `applications/bot/src/interactions/upcoming-rsvp.ts` (`UpcomingRsvpButton`)

---

### Claim Button — `claim:{teamId}:{eventId}`

Appears on the training claim-board message posted to the event's owner-group channel when a training is created. Allows coaches (members of the training's owner group or any descendant group) to claim the training.

**Custom ID pattern:** `claim:{teamId}:{eventId}`

**Behavior:**

1. Parses `teamId` and `eventId` from the custom ID.
2. Responds with a deferred ephemeral acknowledgement and forks a background fiber.
3. The background fiber calls `Event/ClaimTraining` RPC with `event_id`, `team_id`, and the invoking user's `discord_user_id`.
4. On success, updates the ephemeral message with a localised "claimed" confirmation.
5. The server emits a `training_claim_update` event sync event; the bot's Event Sync worker then edits the claim-board message to reflect the new claimer and replaces the Claim button with an Unclaim button.

**Errors from `Event/ClaimTraining`:**

| Error tag | User-visible message |
|-----------|----------------------|
| `ClaimAlreadyClaimed` | Already claimed by `**{name}**` |
| `ClaimNotOwnerGroupMember` | You are not in the owner group for this training |
| `ClaimEventInactive` | The training has been cancelled |
| `ClaimEventNotFound` | The training has been cancelled |
| `ClaimNotTraining` | The training has been cancelled |

**Source file:** `applications/bot/src/interactions/claim.ts` (`ClaimButton`)

---

### Unclaim Button — `unclaim:{teamId}:{eventId}`

Appears on the training claim-board message after a coach has claimed the training. Allows the current claimer to release their claim.

**Custom ID pattern:** `unclaim:{teamId}:{eventId}`

**Behavior:**

1. Parses `teamId` and `eventId` from the custom ID.
2. Responds with a deferred ephemeral acknowledgement and forks a background fiber.
3. The background fiber calls `Event/UnclaimTraining` RPC with `event_id`, `team_id`, and `discord_user_id`.
4. On success, updates the ephemeral message with a localised "released" confirmation.
5. The server emits a `training_claim_update` event sync event; the bot's Event Sync worker edits the claim-board message back to unclaimed state and restores the Claim button.

**Errors from `Event/UnclaimTraining`:**

| Error tag | User-visible message |
|-----------|----------------------|
| `ClaimNotClaimer` | You are not the person who claimed this training |
| `ClaimEventInactive` | The training has been cancelled |
| `ClaimEventNotFound` | The training has been cancelled |

**Source file:** `applications/bot/src/interactions/claim.ts` (`UnclaimButton`)

---

### Event Create Autocomplete

Provides training type suggestions for the `/event create training_type` option.

**Trigger condition:** command name is `event` and the focused option name is `training_type`.

**Behavior:** See `/event create` autocomplete description above.

**Source file:** `applications/bot/src/interactions/event-create-autocomplete.ts`

---

## Gateway Event Handlers

Gateway handlers are set up in `applications/bot/src/events/index.ts`. They react to Discord gateway dispatch events.

### GUILD_CREATE

Fired when the bot joins a guild, or when Discord sends the initial `GUILD_CREATE` payloads on connection.

**Actions (in order):**

1. Calls `Guild/RegisterGuild` RPC with `guild_id` and `guild_name`.
2. Calls `Guild/SyncGuildChannels` RPC with all text channels (type 0) and category channels (type 4) in the guild (channel ID, name, type, parent category ID).
3. Fetches up to 1000 guild members via the Discord REST API, filters out bots, and calls `Guild/ReconcileMembers` RPC with the full member list (discord ID, username, avatar, role IDs).

Each step catches errors independently so a failure in channel sync or member reconciliation does not prevent guild registration.

**Note on invite cache:** The `InviteCache` is populated lazily — the first snapshot for a guild is taken at the moment the first `GUILD_MEMBER_ADD` event fires (via `listGuildInvites`). There is no pre-seeding on `GUILD_CREATE`.

---

### GUILD_DELETE

Fired when the bot is removed from a guild, or when the guild becomes unavailable due to an outage.

**Actions:**

- If `guild.unavailable` is `true`: logs an informational message only; no RPC call is made (this is a Discord outage, not a removal).
- Otherwise: calls `Guild/UnregisterGuild` RPC with `guild_id`.

---

### INVITE_CREATE

Fired when a guild invite is created.

**Actions:**

- If `guild_id` is absent (DM invite): skips.
- Otherwise: calls `InviteCache.upsert(guild_id, code, uses)` to record the invite code and its initial use count in the in-memory snapshot.

---

### INVITE_DELETE

Fired when a guild invite is deleted or expires.

**Actions:**

- If `guild_id` is absent: skips.
- Otherwise: calls `InviteCache.remove(guild_id, code)` to remove the code from the snapshot so it is not considered as a candidate when the next member joins.

---

### GUILD_MEMBER_ADD

Fired when a new member joins a guild.

**Actions:**

- If the new member is a bot: logs and skips.
- Otherwise, performs the **invite diff + welcome flow** (see below).

**Invite diff and welcome flow:**

1. Calls `rest.listGuildInvites(guild_id)` to fetch the current invite usage counts. Errors are suppressed — if the REST call fails, an empty list is used and invite tracking is skipped for this join.
2. Calls `InviteCache.diffOnMemberJoin(guild_id, fresh)` which atomically compares the fresh usage counts against the stored snapshot (via `inviteDiff`) and updates the snapshot. The winning invite code (the one whose use count increased) is returned as `Option<string>`.
3. Calls `Guild/RegisterMember` RPC with `guild_id`, `discord_id`, `username`, `avatar`, `roles`, `nickname`, `display_name`, and `invite_code` (the matched Discord code or `None`).
   - The server looks up the matched Discord code in `invite_acceptances.discord_code` (via `InviteAcceptancesRepository.findByDiscordCodeWithContext`) to resolve the originating `team_invite`, its `group_id`, and the inviter. It auto-adds the member to that group, renders the welcome message template (substituting `{memberMention}`, `{memberName}`, `{inviterMention}`, `{inviterName}`, `{groupName}`, `{teamName}`), and returns a `WelcomeMeta` payload.
4. If `WelcomeMeta` is present:
   - If `system_log_channel_id` is set: posts a **system log embed** (title "Member joined", fields: member mention + username, invite code, inviter mention, group name) to that channel.
   - If `welcome_channel_id` and `welcome_message_rendered` are both present: posts a **welcome embed** (rendered message as description, group name field if set, group colour as embed colour, `<@memberId>` as message content) to the welcome channel.
   - Both posts run concurrently. Errors are logged as warnings and do not abort the handler.

**Source files:** `applications/bot/src/events/index.ts`, `applications/bot/src/services/InviteCache.ts`, `applications/bot/src/services/inviteDiff.ts`, `applications/bot/src/services/welcomeRenderer.ts`

---

### GUILD_MEMBER_REMOVE

Fired when a member leaves or is removed from a guild.

**Actions:** Logs the event only. No server-side action is taken; the member record is retained.

---

### GUILD_MEMBER_UPDATE

Fired when a member's roles, nickname, or other profile attributes change.

**Actions:** Logs the event only. No server-side action is taken.

---

### CHANNEL_CREATE

Fired when a channel is created in a guild. Filters to text channels (type 0) and category channels (type 4) only — voice, DM, and other channel types are logged at debug level and ignored.

Calls `Guild/UpsertChannel` RPC with the channel's ID, name, type, and parent ID to keep the server's `discord_channels` table in sync.

---

### CHANNEL_DELETE

Fired when a channel is deleted from a guild. Applies the same type filter as `CHANNEL_CREATE`.

Calls `Guild/DeleteChannel` RPC to remove the row from the server's `discord_channels` table.

---

### CHANNEL_UPDATE

Fired when a channel is updated in a guild (e.g. renamed by a Discord admin). Applies the same type filter as `CHANNEL_CREATE`.

Calls `Guild/UpsertChannel` RPC to update the channel's name and metadata in the `discord_channels` table. The upsert handles both create and update semantics.

---

## RPC Sync Workers

Four background worker loops run continuously inside the bot process. Three of them (Role Sync, Channel Sync, Event Sync) poll the server for unprocessed outbox events, process them sequentially, and mark each as processed or failed. Those three loops use a **5-second polling interval** (`Schedule.spaced('5 seconds')`) and fetch up to **50 events per poll** (`POLL_BATCH_SIZE = 50`). The fourth (Invite Generator) uses a **1-second polling interval** (`Schedule.spaced('1 seconds')`) for near-real-time Discord invite generation.

The outbox workers implement the bot's side of the outbox pattern: the server inserts rows into `role_sync_events`, `channel_sync_events`, and `event_sync_events`; the bot drains those queues.

> **Note on directory name:** The source files for these workers live under `applications/bot/src/rcp/`. This is a typo in the codebase; the intended name is `rpc`. The import paths and class names (`RoleSyncService`, `ChannelSyncService`, `EventSyncService`) all reflect the intended `rpc` meaning.

---

### Role Sync Worker

**Service class:** `RoleSyncService` (`applications/bot/src/rcp/role/index.ts`)

**Polling RPC:** `Role/GetUnprocessedEvents`

**Events processed:**

| Event tag | Handler file | Discord action |
|-----------|-------------|----------------|
| `role_created` | `handleCreated.ts` | Ensures a Discord guild role exists for the Sideline role; calls `ensureMapping` which creates the Discord role if absent and upserts the mapping via `Role/UpsertMapping` |
| `role_deleted` | `handleDeleted.ts` | Looks up the Discord role ID via `Role/GetMapping`, deletes it in Discord via REST, then removes the mapping via `Role/DeleteMapping` |
| `role_assigned` | `handleAssigned.ts` | Ensures the Discord role exists (`ensureMapping`), then adds it to the Discord guild member via REST |
| `role_unassigned` | `handleUnassigned.ts` | Looks up the Discord role ID via `Role/GetMapping`, then removes it from the Discord guild member via REST |

**Lifecycle RPCs:**
- `Role/MarkEventProcessed` — called after each successful event.
- `Role/MarkEventFailed` — called when processing throws; records the error string for diagnostics.

---

### Channel Sync Worker

**Service class:** `ChannelSyncService` (`applications/bot/src/rcp/channel/index.ts`)

**Polling RPC:** `Channel/GetUnprocessedEvents`

Channel sync mirrors each Sideline group that has a Discord channel mapping as a Discord text channel. It also creates and manages a corresponding Discord role used to control channel visibility.

**Events processed:**

| Event tag | Handler file | Discord action |
|-----------|-------------|----------------|
| `channel_created` | `handleCreated.ts` | Ensures a Discord channel (and associated role) exists for the group; calls `ensureMapping` which creates the channel+role if absent and upserts the mapping via `Channel/UpsertMapping` |
| `channel_updated` | `handleUpdated.ts` | Updates the existing Discord role name and colour, and the Discord channel name, to reflect the latest group/roster name, emoji, and colour settings; then calls `Guild/UpdateChannelName` RPC to write the new name back to the server's `discord_channels` cache |
| `channel_deleted` | `handleDeleted.ts` | Looks up the mapping via `Channel/GetMapping`, deletes the associated Discord role (if present) and the Discord channel via REST, then removes the mapping via `Channel/DeleteMapping` |
| `channel_archived` | `handleArchived.ts` | Moves the Discord channel to the configured archive category via REST (`updateChannel`); falls back to full channel deletion if the move fails. On success, removes the channel's permission overwrite for the associated role, deletes the Discord role (if present), then removes the mapping. |
| `channel_detached` | `handleDetached.ts` | Deletes the associated Discord role (if present) and removes the mapping, but leaves the Discord channel untouched. Used when the cleanup mode is `nothing`. |
| `channel_member_added` | `handleMemberAdded.ts` | Ensures the mapping exists (`ensureMapping`), then adds the channel's Discord role to the guild member via REST |
| `channel_member_removed` | `handleMemberRemoved.ts` | Looks up the mapping via `Channel/GetMapping`, then removes the channel's Discord role from the guild member via REST |

**Lifecycle RPCs:**
- `Channel/MarkEventProcessed`
- `Channel/MarkEventFailed`

---

### Event Sync Worker

**Service class:** `EventSyncService` (`applications/bot/src/rcp/event/index.ts`)

**Polling RPC:** `Event/GetUnprocessedEvents`

**Message recovery:** whenever `reorderChannelMessages` attempts to edit an existing Discord message and receives error code 10008 (Unknown Message), it returns `EditOutcome = 'message_gone'`, which causes the item to be treated as part of the suffix that must be recreated. The recreated message is posted with `createMessage` and the new snowflake is persisted via `Event/SaveDiscordMessageId`. This recovery also runs during the startup task described below.

**Concurrency guard:** every call to `reorderChannelMessages` is wrapped in `ChannelReorderSemaphore.withChannelLock(channelId)` (`applications/bot/src/rcp/event/ChannelReorderSemaphore.ts`). This in-process per-channel `Effect.Semaphore` (capacity 1) ensures that two concurrent reorders for the same channel are serialised, preventing interleaved deletes and creates from producing out-of-order messages.

**Channel event cap:** at most `MAX_CHANNEL_EVENTS = 10` event messages are kept per channel. When sorting produces more than 10 entries, the oldest (earliest-past) entries beyond the cap are deleted from Discord before the prefix/suffix algorithm runs. This keeps each channel to a manageable window of recent-past plus soonest-future events.

**Reorder algorithm (`reorderChannelMessages`):**

1. Fetch all event entries for the channel via `Event/GetChannelEvents` and sort them with `sortEntriesForChannel`: past events oldest-first, then a divider message, then future events nearest-first (so the next upcoming event is always the bottom-most — i.e., the most visible — message).
2. Apply the `MAX_CHANNEL_EVENTS = 10` cap: drop the excess oldest-past entries and delete their Discord messages.
3. Compute the *longest keepable prefix* `k`: the maximum-length prefix of the sorted item list (events + optional divider) whose snowflakes are already strictly increasing left-to-right and strictly less than every snowflake in the remaining suffix. Items without a stored snowflake (`Option.none()`, used by startup recovery to force recreation) automatically terminate the prefix.
4. **Kept prefix (indices 0 … k−1):** edit each message in-place. If an edit returns `message_gone` (10008 error), the item and all subsequent items are moved into the recreate phase.
5. **Recreated suffix (indices effectiveK … end):** delete each old Discord message, then post a new one sequentially (concurrency: 1) so that Discord assigns monotonically increasing snowflakes, which guarantees the messages appear in the correct top-to-bottom order on the next reorder pass.

**Events processed:**

| Event tag | Handler file | Discord action |
|-----------|-------------|----------------|
| `event_created` | `handleCreated.ts` | Fetches RSVP counts (`Event/GetRsvpCounts`) and the guild's preferred locale, builds an event embed with RSVP buttons, posts it to the group's configured Discord channel (or the guild system channel as fallback), saves the resulting message ID via `Event/SaveDiscordMessageId`, then re-orders all event messages in the channel by start time |
| `event_updated` | `handleUpdated.ts` | Looks up the stored Discord message via `Event/GetDiscordMessageId`, fetches updated RSVP counts, rebuilds the embed, edits the existing Discord message, then re-orders channel messages |
| `event_cancelled` | `handleCancelled.ts` | Looks up the stored Discord message, replaces the embed content with a cancelled-state embed (no RSVP buttons), edits the existing Discord message |
| `event_started` | `handleStarted.ts` | Two actions run in parallel. (1) In-place edit: looks up the stored Discord message via `Event/GetDiscordMessageId`, fetches updated RSVP counts and embed info, rebuilds the embed without RSVP action-row buttons, and edits the existing Discord message. If Discord returns error 10008 (Unknown Message — the message was deleted), the embed is re-posted with `createMessage` and the new message ID is persisted via `Event/SaveDiscordMessageId`. After the in-place edit (or recreation) succeeds, `reorderChannelMessages` is called so the started event moves into the channel's "past" section. (2) New announcement post: posts a fresh "Starting now: {title}" message to the team's configured reminders channel (falls back to the guild system channel when no reminders channel is set). The announcement embed lists the going attendees filtered to the event's member group, includes a role @-mention (`<@&roleId>`) in the message `content` with `allowed_mentions.roles`, and is formatted in yellow. The `GetYesAttendeesForEmbed` RPC is called with `member_group_id` so only members in the event's member group (and their descendants, via `WITH RECURSIVE descendant_groups`) appear. Emitted by `EventStartCron` when an event's `start_at` time passes. |
| `rsvp_reminder` | `handleRsvpReminder.ts` | Fetches a reminder summary via `Event/GetRsvpReminderSummary` (yes/no/maybe counts, non-responder list, yes-attendee list with Discord IDs), posts a yellow reminder embed to the team's configured reminders channel (falls back to the owner-group's channel). No role @-mention is included in the message content — the reminder is embed-only. Non-responders and yes-attendees are filtered to the event's member group. Non-responders and yes-attendees are formatted as `**Name** (<@id>)` (dual format: bold name plus mention) when both are available; name-only when no Discord ID is linked; mention-only when only a Discord ID is known. The embed also includes a "Going" field listing current yes-attendees. Sends a direct message to each non-responder with a linked Discord account with a link to the voting message. |
| `training_claim_request` | `handleTrainingClaimRequest.ts` | Posts a claim-board message to the event's owner-group channel (resolved from `discord_target_channel_id` in the sync event). The embed shows event details, an orange "Unclaimed" colour, and a "Claim" primary button. If a Discord role is set for the owner group, the message content @-mentions that role. After posting, saves the resulting message ID via `Event/SaveClaimDiscordMessageId` so future `training_claim_update` events know where to edit. |
| `training_claim_update` | `handleTrainingClaimUpdate.ts` | Edits the existing claim-board message (located via `claim_discord_channel_id` / `claim_discord_message_id`). The updated embed reflects whether the training is now claimed (green, claimer shown as `**Name** (<@discordId>)` using the same `formatNameWithMention` helper as RSVP attendee lists, Unclaim button) or unclaimed (orange, Claim button). The claimer's identity fields (`discord_id`, `name`, `nickname`, `display_name`, `username`) are resolved at SELECT time via a LEFT JOIN to `team_members → users` rather than being stored in the outbox row. If the message has been deleted (404 response), the update is silently skipped. |
| `unclaimed_training_reminder` | `handleUnclaimedTrainingReminder.ts` | Posts a yellow reminder embed to the owner-group's channel warning that the training is still unclaimed. If `claim_discord_channel_id` and `claim_discord_message_id` are present, the embed description includes a jump link to the claim-board message. If a Discord role is set, the message content @-mentions that role. Emitted by `RsvpReminderCron` alongside the normal RSVP reminder when the training's `claimed_by` is NULL. |

**Lifecycle RPCs:**
- `Event/MarkEventProcessed`
- `Event/MarkEventFailed`

---

### Invite Generator Worker

**Service class:** `ProcessorService` (`applications/bot/src/rcp/inviteGenerator/ProcessorService.ts`)

**Polling RPC:** `Invite/PendingAcceptances`

**Polling interval:** 1 second (`fastPollLoop` in `Bot.ts`, distinct from the 5-second `pollLoop` used by the three outbox workers).

When a user accepts a Sideline invite link (clicks "Accept" on `/invite/{code}`), the server creates an `invite_acceptances` row and returns its ID to the web app. The invite generator picks up pending rows (those with `discord_code IS NULL AND discord_code_error_code IS NULL`) and calls `discord.createChannelInvite` on the team's `welcome_channel_id` with `max_uses: 1`, `max_age: 86400` (24 hours), and `unique: true` — a single-use link tied to this specific acceptance. On success it calls `Invite/SetAcceptanceDiscordCode` to store the code. On failure it calls `Invite/MarkAcceptanceFailed` to record the error code and detail.

The web app polls `GET /invite/acceptances/:acceptanceId` to obtain the Discord invite URL as soon as it is written, then redirects the user to `https://discord.gg/<code>`.

**Invite group RPCs used:**

| RPC | Payload | Purpose |
|-----|---------|---------|
| `Invite/PendingAcceptances` | `{ limit: number }` | Fetch pending acceptance rows (up to `limit`); returns `acceptance_id`, `guild_id`, `welcome_channel_id` |
| `Invite/SetAcceptanceDiscordCode` | `{ acceptance_id, discord_code }` | Store the generated Discord invite code on the acceptance row |
| `Invite/MarkAcceptanceFailed` | `{ acceptance_id, error_code, error_detail }` | Record the error when Discord invite creation fails |

The `GUILD_MEMBER_ADD` handler resolves welcome metadata by looking up `invite_acceptances.discord_code` (via `InviteAcceptancesRepository.findByDiscordCodeWithContext`) rather than `team_invites.discord_code` as before.

---

## Startup Tasks

In addition to the three poll loops, the bot runs one-off tasks at startup (after the gateway connection is established). These tasks are composed alongside the poll loops with `concurrency: 'unbounded'` in `Bot.ts`.

### recoverDeletedMessages

**Source file:** `applications/bot/src/rcp/event/recoverDeletedMessages.ts`

On connect, the bot calls `Event/GetChannelsWithStoredMessages` to retrieve every `(discord_channel_id, guild_id)` pair for which at least one event message is currently stored in the database. For each channel it fetches the guild's preferred locale via the Discord REST API (defaults to `en` if the fetch fails), then runs `reorderChannelMessages`. Because `reorderChannelMessages` recovers from Discord 10008 errors by recreating any deleted messages (see "Message recovery" above), this single pass restores all event embeds that were removed from Discord while the bot was offline. Channels are processed with a concurrency of 3 (outer loop); per-channel reorders are still serialised by `ChannelReorderSemaphore`. Per-channel failures are logged as warnings and do not abort the remaining channels.

The optional `snowflakeOverrides` parameter on `reorderChannelMessages` (a `ReadonlyMap<eventId, Option<Snowflake>>`) lets callers force specific items into the recreate suffix by passing `Option.none()` for their snowflake. This is used internally when a message is known to be missing, bypassing the prefix-algorithm's keep decision.

---

## RPC Method Reference

The bot communicates with the server using the `SyncRpcs` RPC group defined in `packages/domain/src/rpc/SyncRpcs.ts`. Below is a complete list of all methods used by the bot, organized by group prefix.

### Guild group (`Guild/`)

| Method | Purpose |
|--------|---------|
| `Guild/RegisterGuild` | Register a guild when the bot joins |
| `Guild/UnregisterGuild` | Remove guild registration when the bot leaves |
| `Guild/IsGuildRegistered` | Check whether a guild is already registered |
| `Guild/SyncGuildChannels` | Bulk-sync all text channels for a guild |
| `Guild/UpdateChannelName` | Update the cached name of a single Discord channel after the bot renames it |
| `Guild/UpsertChannel` | Insert or update a single Discord channel row in `discord_channels`; called after the bot auto-creates a channel so the web can display its name |
| `Guild/DeleteChannel` | Delete a single channel row from `discord_channels` when a Discord channel is deleted |
| `Guild/ReconcileMembers` | Bulk-sync up to 1000 guild members on startup |
| `Guild/RegisterMember` | Register a single new member; accepts `invite_code: Option<string>` (the Discord code matched by the invite diff) and returns `Option<WelcomeMeta>` (system log channel, optional welcome detail including rendered message, group colour, inviter Discord ID). The server resolves the invite code via `invite_acceptances.discord_code` (not `team_invites.discord_code`) to look up the team, group, and inviter. |

### Role group (`Role/`)

| Method | Purpose |
|--------|---------|
| `Role/GetUnprocessedEvents` | Poll for pending role outbox events |
| `Role/MarkEventProcessed` | Acknowledge successful processing |
| `Role/MarkEventFailed` | Record a processing failure |
| `Role/GetMapping` | Look up the Discord role ID for a Sideline role |
| `Role/UpsertMapping` | Save or update the Discord role ID mapping |
| `Role/DeleteMapping` | Remove the mapping when a role is deleted |

### Channel group (`Channel/`)

| Method | Purpose |
|--------|---------|
| `Channel/GetUnprocessedEvents` | Poll for pending channel outbox events |
| `Channel/MarkEventProcessed` | Acknowledge successful processing |
| `Channel/MarkEventFailed` | Record a processing failure |
| `Channel/GetMapping` | Look up the Discord channel/role IDs for a group |
| `Channel/UpsertMapping` | Save or update the Discord channel+role mapping |
| `Channel/DeleteMapping` | Remove the mapping when a group channel is deleted |

### Event group (`Event/`)

| Method | Purpose |
|--------|---------|
| `Event/GetUnprocessedEvents` | Poll for pending event outbox events |
| `Event/MarkEventProcessed` | Acknowledge successful processing |
| `Event/MarkEventFailed` | Record a processing failure |
| `Event/CreateEvent` | Create a new event (from `/event create`) |
| `Event/GetUpcomingGuildEvents` | Fetch paginated upcoming events (guild-scoped, no per-user RSVP data; used by the event sync worker embed builder) |
| `Event/GetUpcomingEventsForUser` | Fetch paginated upcoming events with the invoking user's RSVP status; used by `/event list`, the overview show button, and pagination/RSVP buttons on the per-user embed |
| `Event/GetTrainingTypesByGuild` | Fetch training type choices for autocomplete |
| `Event/SubmitRsvp` | Record a member's RSVP response; payload includes `clearMessage: boolean`; returns `SubmitRsvpResult` with late-RSVP flag, optional notification channel, and `message: Option<string>` |
| `Event/GetRsvpCounts` | Fetch yes/no/maybe counts for an event |
| `Event/GetRsvpAttendees` | Fetch paginated attendee list |
| `Event/GetRsvpReminderSummary` | Fetch counts and non-responder list for a reminder |
| `Event/SaveDiscordMessageId` | Persist the Discord message ID after posting an event embed |
| `Event/GetDiscordMessageId` | Look up the stored Discord message for an event |
| `Event/GetEventEmbedInfo` | Fetch event fields needed to rebuild the embed |
| `Event/GetYesAttendeesForEmbed` | Fetch yes-attendee display names for the embed; accepts an optional `member_group_id` to filter results to the event's member group and its descendants via `WITH RECURSIVE descendant_groups` (used by `postRsvpDiscordUpdates`, event sync, and start announcements) |
| `Event/GetChannelEvents` | Fetch all events in a Discord channel (for reordering) |
| `Event/GetChannelDivider` | Look up the stored divider message ID for a Discord channel |
| `Event/SaveChannelDivider` | Persist the divider message ID for a Discord channel (upsert) |
| `Event/DeleteChannelDivider` | Remove the divider message record for a Discord channel |
| `Event/ClaimTraining` | Atomically claim a training for the invoking coach; returns `EventClaimInfo` or a typed error (`ClaimEventNotFound`, `ClaimNotTraining`, `ClaimEventInactive`, `ClaimNotOwnerGroupMember`, `ClaimAlreadyClaimed`) |
| `Event/UnclaimTraining` | Release a coach's claim on a training; returns `EventClaimInfo` or a typed error (`ClaimEventNotFound`, `ClaimEventInactive`, `ClaimNotClaimer`) |
| `Event/SaveClaimDiscordMessageId` | Persist the Discord channel and message IDs for the claim-board message after posting |
| `Event/GetClaimInfo` | Fetch current claim state (`EventClaimInfo`) for a training; returns `None` if the event does not exist |
| `Event/GetChannelsWithStoredMessages` | Fetch all `(discord_channel_id, guild_id)` pairs for which at least one event message ID is stored; used by the `recoverDeletedMessages` startup task |

### Invite group (`Invite/`)

| Method | Purpose |
|--------|---------|
| `Invite/PendingAcceptances` | Fetch pending `invite_acceptances` rows that need a Discord invite generated (1-second cadence) |
| `Invite/SetAcceptanceDiscordCode` | Store the generated single-use Discord invite code on the acceptance row |
| `Invite/MarkAcceptanceFailed` | Record the error code and detail when Discord invite creation fails |

### Activity group (`Activity/`)

| Method | Purpose |
|--------|---------|
| `Activity/LogActivity` | Log a physical activity (from `/makanicko log`) |
| `Activity/GetStats` | Fetch personal stats and streaks (from `/makanicko stats`) |
| `Activity/GetLeaderboard` | Fetch team leaderboard (from `/makanicko leaderboard`) |

---

## Environment Variables

For the canonical reference including all services, see `docs/deployment.md` (created separately). The variables specific to the bot process are:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | Yes | — | Runtime environment (`development`, `production`, etc.) |
| `DISCORD_BOT_TOKEN` | Yes | — | Discord bot token (redacted in logs) |
| `SERVER_URL` | Yes | — | Base URL of the Sideline server, e.g. `https://api.example.com` |
| `APP_ENV` | Yes | — | Deployment environment label (e.g. `production`, `preview`) |
| `APP_ORIGIN` | Yes | — | Public origin for telemetry resource attributes |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Yes | — | OTLP endpoint for traces/logs/metrics |
| `OTEL_SERVICE_NAME` | Yes | — | Service name reported in telemetry (e.g. `bot`) |
| `HEALTH_PORT` | No | `9000` | Port for the HTTP health check server |
| `DISCORD_GATEWAY_INTENTS` | No | `Guilds \| GuildMembers` (513) | Bitmask of gateway intents to request |
| `RPC_PREFIX` | No | `""` | URL path prefix prepended to all RPC calls |
| `LOG_LEVEL` | No | — | Minimum log level (`DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`) |

Source: `applications/bot/src/env.ts`
