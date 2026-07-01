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

Ten top-level commands are registered globally: `/carpool`, `/event`, `/finance`, `/info`, `/makanicko`, `/poll`, `/sudo`, `/summarize`, `/summon`, and `/training`. `/event`, `/finance`, `/makanicko`, and `/training` each have sub-commands. `/event` has three sub-commands: `create`, `list`, and `refresh`.

### /carpool

**Description:** Post a persistent, live-updating carpool board in the current channel.

**Czech command name:** `doprava`

**Options:** None.

**Permission required:** `carpool:manage` (checked server-side via `Carpool/CreateCarpool` RPC; members without this permission receive an ephemeral error). The command is hidden in the Discord UI from members who lack the `ManageEvents` permission (used as a proxy gate for captains).

**Constraints:**
- `dm_permission: false` — the command cannot be used in DMs.
- `default_member_permissions: ManageEvents` — Discord hides the command from members without this permission; the server additionally checks `carpool:manage` at runtime.

**Flow:**

1. Captain invokes `/carpool` (or `/doprava`) in the channel where the board should live.
2. The handler (`applications/bot/src/commands/carpool/handler.ts`) returns a deferred ephemeral acknowledgement and forks a background fiber.
3. The background fiber calls `Carpool/CreateCarpool` RPC with `guild_id`, `discord_user_id`, `discord_channel_id`, and `event_id: Option.none()`.
4. On success the bot posts a public `buildCarpoolEmbed` message to the same channel with an **Add a car** button. The message ID is saved via `Carpool/SaveCarpoolMessageId`.
5. The ephemeral reply is updated with a localised "carpool created" confirmation.

**Errors from `Carpool/CreateCarpool`:**

| Error tag | User-visible message |
|-----------|----------------------|
| `CarpoolForbidden` | Missing permission |
| `CarpoolGuildNotFound` | Team not found for this Discord server |
| `CarpoolNotMember` | Not a member of this team |

**Source files:**
- `applications/bot/src/commands/carpool/index.ts`
- `applications/bot/src/commands/carpool/handler.ts`

---

### /poll

**Description:** Create an interactive poll in the current channel.

**Czech command name:** `anketa`

**Options:**
- `question` (STRING, required) — the poll question (up to 300 characters).
- `options` (STRING, required) — semicolon-separated choices, e.g. `Pizza; Sushi; Tacos` (2–10 options, each ≤80 characters, no duplicates).
- `multiple` (BOOLEAN, optional) — allow voting for more than one option (default: false).
- `deadline` (STRING, optional) — closing time in the team's timezone, format `YYYY-MM-DD HH:mm`.
- `allowed_role` (ROLE, optional) — Discord role whose members may add new options; omit to restrict to creator/captains only.

**Permission required:** `poll:manage` (Admin and Captain by default). The command is hidden in the Discord UI from members who lack `ManageEvents`.

**Constraints:**
- `dm_permission: false`
- `default_member_permissions: ManageEvents`

**Flow:**

1. Captain invokes `/poll` (or `/anketa`) in the channel where the poll should live.
2. The handler returns a deferred ephemeral acknowledgement and forks a background fiber.
3. The fiber calls `Poll/CreatePoll` RPC with `guild_id`, `discord_user_id`, `discord_channel_id`, `question`, `options_raw`, `multiple`, `allowed_role_id`, and `deadline_raw`.
4. On success the bot posts a public `buildPollEmbed` message with option vote buttons, an **Add option** button, a **Close poll** button, and a **👥 Who voted?** button. The message ID is saved via `Poll/SavePollMessageId`.
5. The ephemeral reply is updated with a localised "poll created" confirmation.

**Errors from `Poll/CreatePoll`:**

| Error tag | User-visible message |
|-----------|----------------------|
| `PollForbidden` | Missing permission (not a captain / no `poll:manage`) |
| `PollGuildNotFound` | Team not found for this Discord server |
| `PollNotMember` | Not a member of this team |
| `PollTooFewOptions` | Too few options (minimum 2) |
| `PollTooManyOptions` | Too many options (maximum 10) |
| `PollDuplicateOption` | Duplicate option labels are not allowed |
| `PollOptionTooLong` | At least one option label exceeds 80 characters |
| `PollInvalidDeadline` | Deadline format invalid (expected `YYYY-MM-DD HH:mm`) |
| `PollDeadlineInPast` | Deadline is in the past |

**Source files:**
- `applications/bot/src/commands/poll/index.ts`
- `applications/bot/src/commands/poll/handler.ts`
- `applications/bot/src/rest/poll/buildPollEmbed.ts`
- `applications/bot/src/rest/poll/buildPollVotersView.ts`
- `applications/bot/src/interactions/poll.ts`

---

### /event refresh

**Description:** Re-sync the current channel's event messages. Run this inside a global events channel or a personal events channel to force an immediate re-render and reorder.

**Czech sub-command name:** `obnovit`

**Options:** None.

**Permission required:** Visible to all members under `/event`. The subcommand carries no `default_member_permissions` gate (that is not possible for subcommands). Instead, access is gated at runtime using `Guild/IdentifyEventsChannel`, which returns `owner_discord_id` (the Discord snowflake of the personal channel's owner) and `is_admin` (whether the caller holds `team:manage`). The rules are:
- **Own personal channel** — any member can refresh their own personal events channel.
- **Another member's personal channel** — only Sideline admins (`team:manage`).
- **Global events channel** — only Sideline admins (`team:manage`).

**Flow:**

1. Any member invokes `/event refresh` (Czech: `/event obnovit`) inside an events channel.
2. The handler (`applications/bot/src/commands/event/refresh.ts`) calls `Guild/IdentifyEventsChannel` RPC with `guild_id`, `channel_id`, and `discord_user_id` to classify the channel and retrieve `owner_discord_id` and `is_admin`.
3. The handler acks the interaction immediately (ephemeral); the heavy work is forked to a detached fiber so the 3-second Discord window is always met.
4. **Personal events channel** (`kind: 'personal'`): compares `owner_discord_id` to the caller's ID. If the caller is not the owner and `is_admin` is `false`, returns an ephemeral "Only team admins can refresh events channels" reply. Otherwise, calls `Guild/MarkTeamPersonalEventsDirty` to mark the team's upcoming events dirty (triggering content re-render via the reconcile loop), then calls `reorderPersonalChannel` acting with the channel owner's identity. If `MarkTeamPersonalEventsDirty` fails with an `RpcClientError` it is logged as a warning and the reorder still proceeds.
5. **Global events channel** (`kind: 'global'`): if `is_admin` is `false`, returns the forbidden reply. Otherwise calls `reorderChannelMessages` — re-renders all event embeds in place and reorders channel messages. Channel content is rendered in the guild locale.
6. **Neither** (`kind: 'none'`): replies ephemerally with a "not an events channel" message and does nothing else.
7. The ephemeral reply (always visible only to the invoker) is rendered in the caller's Discord client locale.

**Errors:**

| Condition | Behavior |
|-----------|----------|
| No `guild_id`, no `channel_id`, or user ID unavailable | Ephemeral "not an events channel" reply; no work forked |
| Personal channel, caller is not the owner and `is_admin` is `false` | Ephemeral "Only team admins can refresh events channels" reply |
| Global channel and `is_admin` is `false` | Ephemeral "Only team admins can refresh events channels" reply |
| `Guild/IdentifyEventsChannel` returns `RpcClientError` | Logged as a warning; ephemeral "not an events channel" reply |
| Channel is neither global nor personal | Ephemeral "not an events channel" reply |

**Source file:**
- `applications/bot/src/commands/event/refresh.ts`

---

### /info

**Description:** Show bot and server version information.

**Options:** None.

**Flow:**

1. User invokes `/info`.
2. The handler (`applications/bot/src/commands/info/handler.ts`) calls `BotInfo/GetServerVersion` RPC to retrieve the server version. If the RPC fails, the server version falls back to `"unknown"`.
3. Returns an ephemeral embed containing:
   - Bot version (static, from `APP_VERSION` in `applications/bot/src/version.ts`).
   - Server version (from RPC response or `"unknown"` on failure).
   - Author credit with a link to [https://majksa.com](https://majksa.com).

**Source file:** `applications/bot/src/commands/info/handler.ts`

---

### /summon

**Description:** Add a user and/or a role's members to the Discord thread this command is invoked in.

**Czech command name:** `přivolat`

**Options:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `user` | User | No | The Discord user to add to the thread |
| `role` | Role | No | A Discord role; all of its members are added to the thread |

At least one of `user` or `role` must be supplied.

**Constraints:**
- `dm_permission: false` — the command cannot be used in DMs.
- `default_member_permissions: ManageThreads` — Discord hides the command from members who lack the Manage Threads permission; the handler additionally re-checks at runtime.

**Flow:**

1. User invokes `/summon` (with `user`, `role`, or both) inside a Discord thread (PUBLIC_THREAD, PRIVATE_THREAD, or ANNOUNCEMENT_THREAD).
2. The handler (`applications/bot/src/commands/summon/handler.ts`) checks the channel type. If the channel is not a thread, it replies ephemerally with "This command can only be used inside a thread."
3. If neither option is provided, it replies ephemerally with "You must specify at least a user or a role."
4. Otherwise it defers ephemerally and, in a forked fiber:
   - If `role` is supplied, calls `rest.listGuildMembers(guild_id, { limit: 1000 })`, filters to members whose `roles` array contains the supplied role id, and dedupes against the explicit `user` (if any).
   - Calls `rest.addThreadMember(channelId, userId)` for each target with bounded concurrency (5) to avoid Discord rate-limit storms.
5. After all calls complete, it edits the original deferred message with a localized summary: per-user, per-role count, both, or "no members with role" / generic-error / forbidden as appropriate.

**Errors:**

| Condition | User-visible message |
|-----------|----------------------|
| Channel is not a thread | This command can only be used inside a thread. |
| Invoker lacks Manage Threads | You need the Manage Threads permission to use this command. |
| Neither option provided | You must specify at least a user or a role. |
| Role expansion returns no members | No members found with role \<@&roleId\>. |
| Discord HTTP 403 or JSON code 50013 on `addThreadMember` | I don't have permission to add members to this thread. |
| Any other Discord error | Failed to add members to this thread. Please try again. |

**Source files:**
- `applications/bot/src/commands/summon/index.ts`
- `applications/bot/src/commands/summon/handler.ts`

---

### /summarize

**Description:** Summarize the recent messages in the current channel or thread using the server's LLM.

**Czech command name:** `shrnout`

**Options:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `messages` | Integer | No | How many recent messages to summarize (1–200, default 50) |
| `since` | String | No | Summarize messages since a point in time — e.g. `24h`, `7d`, `3d12h`, or `2026-06-20` |
| `private` | Boolean | No | Whether the response is visible only to you (default: `true`). Set to `false` to post the summary publicly to the channel. Czech name: `soukrome` |

When both `messages` and `since` are omitted the command summarizes the last 50 messages. When `since` is provided the bot collects all messages in the window (up to `messages` after filtering); when omitted the bot simply takes the newest `messages` messages.

**Constraints:**
- `dm_permission: false` — the command cannot be used in DMs.
- No `default_member_permissions` gate — any member with channel access can use it.

**Flow:**

1. User invokes `/summarize` (optionally with `messages`, `since`, and/or `private`) in a channel or thread.
2. The handler (`applications/bot/src/commands/summarize/handler.ts`) validates the inputs:
   - If the interaction has no `channel_id` (e.g. invoked in a DM), replies ephemerally with an error (regardless of `private`).
   - If `since` is present but unparseable, replies ephemerally with an invalid-input error (regardless of `private`).
3. Resolves response visibility: `private: false` → public; omitted or `true` → ephemeral (default). Returns a `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` — with the `Ephemeral` flag when private, without it when public — and forks a background fiber (the LLM call may be slow). **The defer flag is immutable for the rest of the interaction**, so the chosen visibility also applies to all subsequent follow-up edits (summary embed and post-fetch edge-case messages).
4. The background fiber paginates `rest.listMessages(channelId)` in pages of 100, stopping when:
   - The page cursor crosses the `since` cutoff (if provided),
   - The channel is exhausted (page < 100 messages), or
   - The 2-page fetch budget (200 messages max) is reached.
5. Bot-author messages and empty-content messages are filtered out.
6. Messages are sorted chronologically (oldest first) and trimmed to `effectiveLimit` (the resolved value of `messages`, capped at 200).
7. The resulting transcript is wrapped in `TranscriptMessage` records and sent to the server via `Summarize/SummarizeChannel` RPC with `messages`, `channelName`, and `locale`.
8. The server's `LlmClient.summarizeChannel` builds a system-prompt-guarded chat-completion request with a 12 000-character transcript budget (oldest messages are dropped whole until the budget is met). The JSON response is parsed for `{ summary }`.
9. If the LLM is unavailable or the response cannot be parsed, the server returns `generated: false` and a deterministic fallback prose summary (participant count, message count, channel name).
10. The bot edits the original deferred message (visibility matches the deferred response — ephemeral when `private: true`, public when `private: false`):
    - `generated: false` → text: "I couldn't generate a summary right now."
    - `generated: true` → embed titled "📝 Channel summary" with the summary text and a footer reporting the message count, participant count, time range, and a "(capped)" flag if the window was truncated.

**`since` accepted formats:**

| Format | Examples | Behaviour |
|--------|----------|-----------|
| Duration | `24h`, `7d`, `3d12h`, `90m`, `1d2h30m` | Relative to interaction time; units `d`/`h`/`m`; multi-unit additive |
| ISO date | `2026-06-20` | Start of that UTC day |
| ISO datetime | `2026-06-20T10:00:00Z` | Exact UTC timestamp |

Maximum duration: 10 years (3 650 days). Out-of-range or zero-value inputs return an ephemeral parse error.

**Errors:**

| Condition | User-visible message |
|-----------|----------------------|
| No channel ID on interaction | This command can only be used in a server channel or thread. |
| `since` is present but unparseable | I couldn't read "{input}". Use something like 24h, 7d, or 2026-06-20. |
| No messages found (or only bot messages) | Appropriate ephemeral message per case. |
| Discord HTTP 403 / code 50013 on `listMessages` | I don't have permission to read this channel's history. |
| LLM unavailable / `generated: false` | I couldn't generate a summary right now. Please try again in a moment. |
| RPC or unexpected error | Something went wrong while summarizing. Please try again. |

**Source files:**
- `applications/bot/src/commands/summarize/index.ts`
- `applications/bot/src/commands/summarize/handler.ts`
- `applications/bot/src/commands/summarize/buildSummaryEmbed.ts`

---

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

### /finance status

**Description:** Show your current fee status (outstanding fees, payment progress).

**Czech sub-command name:** `stav`

**Options:** None.

**Flow:**

1. User invokes `/finance status`.
2. The handler (`applications/bot/src/commands/finance/statusHandler.ts`) immediately returns a deferred ephemeral acknowledgement and forks a background fiber.
3. The background fiber calls `Finance/GetMyStatus` RPC with `guild_id` and `discord_user_id`.
4. On success the handler builds a rich embed via `buildFinanceStatusEmbed` and updates the original deferred message:
   - If all assignments are paid or waived, the embed is **green** with an "all clear" description.
   - If any assignment is overdue, the embed is **red**. If any is pending or partial (with no overdue), the embed is **amber**.
   - Each outstanding assignment appears as an embed field showing fee name, amount due (remaining), due date, and — for overdue items — how many days past due.
   - The embed footer shows today's date.
5. If the guild is not found in Sideline, the bot silently returns the "all clear" embed (the server is not connected to this Discord server).

**Errors from `Finance/GetMyStatus`:**

| Error tag | Behavior |
|-----------|----------|
| `FinanceGuildNotFound` | Falls back to "all clear" embed (team not found in this Discord server) |
| `FinanceMemberNotFound` | Shows a "not a member" message |
| `RpcClientError` | Shows a generic error message |

**Source files:**
- `applications/bot/src/commands/finance/index.ts`
- `applications/bot/src/commands/finance/statusHandler.ts`
- `applications/bot/src/commands/finance/buildFinanceStatusEmbed.ts`
- `applications/bot/src/rest/finance/formatMoney.ts`

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
| `date` | String | No | `YYYY-MM-DD`; within ±2 years of today | Date of the activity (defaults to today) |

**`activity` choices:**

| Value | Display name | Czech |
|-------|-------------|-------|
| `gym` | Gym | Posilovna |
| `running` | Running | Běh |
| `stretching` | Stretching | Protahování |

**Flow:**

1. User invokes `/makanicko log activity:gym duration:45`.
2. The handler sends an immediate ephemeral "thinking" response and forks a background fiber.
3. The background fiber calls `Activity/LogActivity` RPC with `guild_id`, `discord_user_id`, `activity_type` (slug), and optional `duration_minutes`, `note`, and `logged_at_date`.
4. On success the ephemeral message is updated with a confirmation showing the logged activity type.

**Errors from `Activity/LogActivity`:**

| Error tag | Behavior |
|-----------|----------|
| `ActivityGuildNotFound` | Generic error message |
| `ActivityMemberNotFound` | "Not a member" message |
| `ActivityLogInvalidLoggedAtDate` | "Invalid date" error message |

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

### /training result

**Description:** Get a deep-link to the web training result editor for a specific event.

**Czech sub-command name:** `výsledek`

**Permission required:** Hidden in the Discord UI from members who lack `ManageEvents` (used as a proxy gate for captains/coaches). No server-side permission is checked beyond guild membership.

**Constraints:**
- `dm_permission: false` — the command cannot be used in DMs.
- `default_member_permissions: ManageEvents` — Discord hides the command from members without this permission.

**Options:**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `event` | String (autocomplete) | Yes | Event ID; populated via autocomplete from loggable training events |

**Flow:**

1. Captain invokes `/training result event:<autocomplete>`.
2. The handler returns an immediate deferred ephemeral acknowledgement and forks a background fiber.
3. The background fiber calls `Event/GetLoggableTrainingEvents` and `Event/GetUpcomingGuildEvents` (for `team_id`) concurrently.
4. If the selected `event` value appears in the loggable list, the bot builds a deep-link URL (`{WEB_URL}/teams/{teamId}/events/{eventId}`) and replies with a localised ephemeral message containing the link.
5. If the event is no longer loggable, the bot replies with an ephemeral "event not loggable" message.

**Autocomplete behavior:** The `event` option is backed by `TrainingResultAutocomplete` (`applications/bot/src/interactions/training-result-autocomplete.ts`). It calls `Event/GetLoggableTrainingEvents` (payload: `{ guild_id }`), then filters results by the user's current search query (matched case-insensitively against the event title and ISO date label `YYYY-MM-DD`), takes up to 25 results, and formats each choice label as `{date} · {title}` (truncated to 100 characters). The value stored in the choice is the event ID string.

**Errors handled:**
- `GuildNotFound` — returns empty ephemeral acknowledgement.
- `RpcClientError` — returns a generic error message.
- If `WEB_URL` is not configured on the bot, replies with a "deep link unavailable" message.

**Source files:**
- `applications/bot/src/commands/training/result.ts` (command handler)
- `applications/bot/src/commands/training/index.ts` (command registration)
- `applications/bot/src/interactions/training-result-autocomplete.ts` (autocomplete handler)

---

### /training generate

**Description:** Get a private deep-link to the team generator UI for a specific training event.

**Czech sub-command name:** `generovat`

**Permission required:** Hidden in the Discord UI from members who lack `ManageEvents` (used as a proxy gate for captains/coaches). No server-side permission is checked beyond guild membership.

**Constraints:**
- `dm_permission: false` — the command cannot be used in DMs.
- `default_member_permissions: ManageEvents` — Discord hides the command from members without this permission.

**Options:**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `event` | String (autocomplete) | Yes | Event ID; populated via autocomplete from loggable training events |

**Flow:**

1. Captain invokes `/training generate event:<autocomplete>`.
2. The handler returns an immediate deferred ephemeral acknowledgement and forks a background fiber.
3. The background fiber calls `Event/GetLoggableTrainingEvents` and `Event/GetUpcomingGuildEvents` (for `team_id`) concurrently.
4. If the selected `event` value appears in the loggable list, the bot builds a deep-link URL (`{WEB_URL}/teams/{teamId}/events/{eventId}`) pointing to the team generator section of the event detail page and replies with a localised ephemeral message containing a clickable link.
5. If the event is no longer loggable, the bot replies with an ephemeral "event not loggable" message.

**Autocomplete behavior:** The `event` option reuses the same `Event/GetLoggableTrainingEvents` RPC call as `/training result`. Results are filtered case-insensitively by the user's current input (against title and ISO date), up to 25 choices formatted as `{date} · {title}`.

**Errors handled:**
- `GuildNotFound` — returns an ephemeral "not a member" message.
- `RpcClientError` — returns a generic error message.
- If `WEB_URL` is not configured on the bot, replies with a "deep link unavailable" message.

**Source files:**
- `applications/bot/src/commands/training/generate.ts` (command handler)
- `applications/bot/src/commands/training/index.ts` (command registration)

---

### /sudo

**Description:** Toggle temporary Discord Administrator elevation for the invoking team admin.

**Options:** None.

**Permission required:** `team:manage` (checked server-side via the `Guild/CheckTeamAdmin` RPC). Unlike most other commands, `/sudo` carries **no** `default_member_permissions` gate, so it stays visible in the Discord UI to team admins even if they lack Discord-native permissions — the check happens entirely at runtime.

**Constraints:**
- `dm_permission: false` — the command cannot be used in DMs.
- No `default_member_permissions` gate (see above).

**Flow:**

1. Team admin invokes `/sudo`. The handler (`applications/bot/src/commands/sudo/handler.ts`) returns a deferred ephemeral acknowledgement and forks a background fiber (the admin check + role + audit-post chain can exceed Discord's 3-second ACK window).
2. The fiber calls `Guild/CheckTeamAdmin` RPC with `guild_id` and `discord_user_id`. If `is_admin` is `false`, replies ephemerally that only team admins can use sudo mode.
3. Otherwise calls `ensureSudoRole` (`applications/bot/src/rest/roles/ensureSudoRole.ts`), which looks up (or creates, with the Discord Administrator permission) a guild role named `Sideline Sudo` and returns its ID. If more than one role happens to share that name (a create race), it deterministically picks the lowest-snowflake (oldest) one and logs a warning.
4. Checks whether the invoker already holds the sudo role (via `interaction.member.roles`):
   - **Not elevated** → grants the role (`addGuildMemberRole`), then fetches the guild to find its configured system channel:
     - If a system channel is configured, posts a permanent audit embed there ("🛡️ Sudo mode active", who, when) with a **Leave sudo** button (`sudo-leave:{userId}`), then replies ephemerally that sudo mode is on.
     - If no system channel is configured, still grants the role but replies ephemerally that no audit entry was posted (re-run `/sudo` to step down).
   - **Already elevated** → revokes the role (`deleteGuildMemberRole`) and replies ephemerally that sudo mode has ended. The original audit message (if any) is left untouched — the invoker toggling off does not edit it; only the "Leave sudo" button does that (see below).
5. Role-grant/revoke permission failures (bot role below the sudo role, or missing Manage Roles) are detected via `isDiscordPermissionError` and surfaced as a clear ephemeral warning rather than a generic error.

**No auto-expiry:** sudo mode persists until the invoker runs `/sudo` again or an admin presses **Leave sudo** — there is no scheduled revocation.

**Errors:**

| Condition | User-visible message |
|-----------|----------------------|
| No `guild_id` or user ID unavailable (e.g. DM edge case) | This command can only be used on a Discord server. |
| `Guild/CheckTeamAdmin` returns `is_admin: false` | Only team admins can use sudo mode. |
| `Guild/CheckTeamAdmin` RPC fails (`RpcClientError`) | Generic error message |
| Role grant/revoke fails with a Discord permission error | Role-hierarchy-specific warning (check bot role position and Manage Roles) |
| No system channel configured (still grants the role) | Sudo is on, but no audit entry was posted; re-run to step down |

**Source files:**
- `applications/bot/src/commands/sudo/index.ts` (command registration)
- `applications/bot/src/commands/sudo/handler.ts`
- `applications/bot/src/rest/roles/ensureSudoRole.ts`
- `applications/bot/src/rest/discordErrors.ts`

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

### Carpool Add Button — `carpool-add:{carpoolId}`

Appears on the public carpool board message posted by `/carpool`. Opens a modal so the user can specify the car capacity.

**Custom ID pattern:** `carpool-add:{carpoolId}`

**Behavior:**

1. Parses `carpoolId` from the custom ID and reads `channelId` and `messageId` from the interaction context.
2. Returns a **modal** immediately (no deferred response) with `custom_id` `carpool-add-modal:{channelId}:{messageId}:{carpoolId}`.
3. The modal has one required single-line text field (`custom_id: carpool_capacity`, max length 1, placeholder `2`).

**Source file:** `applications/bot/src/interactions/carpool.ts` (`CarpoolAddButton`)

---

### Carpool Add Modal — `carpool-add-modal:{channelId}:{messageId}:{carpoolId}`

Handles submission of the car-creation modal. Creates the car, spawns a private thread, and rebuilds the board.

**Custom ID pattern:** `carpool-add-modal:{channelId}:{messageId}:{carpoolId}`

**Behavior:**

1. Parses `channelId`, `messageId`, and `carpoolId` from the custom ID; reads `capacity` (1–8, defaults to 4 on parse failure) from the `carpool_capacity` modal field.
2. Returns a deferred ephemeral acknowledgement and forks a background fiber.
3. The background fiber calls `Carpool/AddCar` RPC with `guild_id`, `discord_user_id`, `carpool_id`, `capacity`, and `note: Option.none()`.
4. On success:
   a. Creates a private Discord thread (`type: 12`) named after the car index and owner display name via `rest.createThread`.
   b. Persists the thread ID via `Carpool/SaveCarThreadId`.
   c. Posts a welcome embed to the thread with an **Assign passenger** button (`carpool-assign:{carId}`), a **Leave** button (`carpool-leave:{carId}`), and a **Remove car** button (`carpool-remove:{carId}`).
   d. Adds the car owner to the thread via `rest.addThreadMember`.
   e. Re-fetches the carpool view via `Carpool/GetCarpoolView` and edits the public board message to reflect the new car.
5. The ephemeral reply is updated with a "Car #N added" confirmation. If thread creation fails, the board is still rebuilt and the confirmation is shown without the thread link.

**Errors from `Carpool/AddCar`:**

| Error tag | User-visible message |
|-----------|----------------------|
| `CarpoolGuildNotFound` | Team not found for this Discord server |
| `CarpoolNotMember` | Not a member of this team |
| `CarpoolNotFound` | Carpool not found |
| `CarpoolAlreadyOwnsCar` | You already own a car in this carpool |
| `CarpoolAlreadyInAnotherCar` | You are already in another car in this carpool |

**Source file:** `applications/bot/src/interactions/carpool.ts` (`CarpoolAddModal`)

---

### Carpool Reserve Button — `carpool-reserve:{carId}`

Appears on each car entry in the public carpool board. Allows any team member (except the car owner) to claim a seat.

**Custom ID pattern:** `carpool-reserve:{carId}`

**Behavior:**

1. Parses `carId` from the custom ID.
2. Returns a deferred ephemeral acknowledgement and forks a background fiber.
3. The background fiber calls `Carpool/ReserveSeat` RPC with `guild_id`, `discord_user_id`, and `car_id`.
4. On success: adds the user to the car's private thread (if a thread exists), rebuilds the public board, and replies with "Joined car #N" plus a **Leave** button (`carpool-leave:{carId}`). If thread-add fails, a warning is appended to the confirmation.

**Errors from `Carpool/ReserveSeat`:**

| Error tag | User-visible message |
|-----------|----------------------|
| `CarpoolFull` | Car is full |
| `CarpoolAlreadyInThisCar` | Already in this car |
| `CarpoolAlreadyInAnotherCar` | Already in another car in this carpool |
| `CarpoolOwnerCannotReserve` | Car owner cannot reserve their own car |
| `CarpoolCarNotFound` | Car not found |
| `CarpoolNotMember` | Not a member of this team |
| `CarpoolGuildNotFound` | Team not found for this Discord server |

**Source file:** `applications/bot/src/interactions/carpool.ts` (`CarpoolReserveButton`)

---

### Carpool Leave Button — `carpool-leave:{carId}`

Appears in the ephemeral confirmation after a member reserves a seat, and also as a persistent button in the car's private thread (between Assign and Remove). Releases the seat and removes the user from the private thread.

**Custom ID pattern:** `carpool-leave:{carId}`

**Behavior:**

1. Parses `carId` from the custom ID.
2. Returns a deferred ephemeral acknowledgement and forks a background fiber.
3. The background fiber calls `Carpool/LeaveSeat` RPC with `guild_id`, `discord_user_id`, and `car_id`.
4. On success: removes the user from the car's private thread (using the persisted `thread_id` from the returned view — not the interaction channel ID), rebuilds the public board, and replies with "Left car #N".

**Errors from `Carpool/LeaveSeat`:**

| Error tag | User-visible message |
|-----------|----------------------|
| `CarpoolOwnerCannotLeave` | Car owner cannot leave their own car |
| `CarpoolNotInCar` | Not in this car |
| `CarpoolCarNotFound` | Car not found |
| `CarpoolNotMember` | Not a member of this team |
| `CarpoolGuildNotFound` | Team not found for this Discord server |

**Source file:** `applications/bot/src/interactions/carpool.ts` (`CarpoolLeaveButton`)

---

### Carpool Leave Mine Button — `carpool-leave-mine:{carpoolId}`

Appears on the public carpool board message as a single shared **Leave my car** button. Because a member can only be in one car per carpool, the server resolves the relevant car server-side from the carpool ID and the invoking user's identity. The button is disabled when there are no cars on the board.

**Custom ID pattern:** `carpool-leave-mine:{carpoolId}`

**Behavior:**

1. Parses `carpoolId` from the custom ID.
2. Returns a deferred ephemeral acknowledgement and forks a background fiber.
3. The background fiber calls `Carpool/LeaveCarpool` RPC with `guild_id`, `discord_user_id`, and `carpool_id`.
4. On success: removes the user from the car's private thread (if one exists), rebuilds the public board, and replies with "Left car #N".

**Errors from `Carpool/LeaveCarpool`:**

| Error tag | User-visible message |
|-----------|----------------------|
| `CarpoolOwnerCannotLeave` | Car owner cannot leave their own car |
| `CarpoolNotInCar` | Not in this car |
| `CarpoolNotMember` | Not a member of this team |
| `CarpoolGuildNotFound` | Team not found for this Discord server |

**Source file:** `applications/bot/src/interactions/carpool.ts` (`CarpoolLeaveMineButton`)

---

### Carpool Remove Button — `carpool-remove:{carId}` (thread only, owner)

Appears inside the per-car private thread (posted by the carpool add modal). Allows the car owner to remove their car entirely.

**Custom ID pattern:** `carpool-remove:{carId}`

**Behavior:**

1. Parses `carId` from the custom ID.
2. Returns a deferred ephemeral acknowledgement and forks a background fiber.
3. The background fiber calls `Carpool/RemoveCar` RPC with `guild_id`, `discord_user_id`, and `car_id`.
4. On success: archives and locks the private thread (`archived: true, locked: true`), rebuilds the public board, and replies with "Car removed".

**Errors from `Carpool/RemoveCar`:**

| Error tag | User-visible message |
|-----------|----------------------|
| `CarpoolNotCarOwner` | Not the owner of this car |
| `CarpoolCarNotFound` | Car not found |
| `CarpoolNotMember` | Not a member of this team |
| `CarpoolGuildNotFound` | Team not found for this Discord server |

**Source file:** `applications/bot/src/interactions/carpool.ts` (`CarpoolRemoveButton`)

---

### Carpool Assign Button — `carpool-assign:{carId}` (thread only, owner)

Appears inside the per-car private thread. Allows the car owner to add a passenger by selecting them from a Discord user-select menu.

**Custom ID pattern:** `carpool-assign:{carId}`

**Behavior:**

1. Parses `carId` from the custom ID.
2. Responds immediately (non-deferred) with an ephemeral message containing a Discord **user-select** component (`custom_id: carpool-assign-pick:{carId}`).

**Source file:** `applications/bot/src/interactions/carpool.ts` (`CarpoolAssignButton`)

---

### Carpool Assign-Pick User Select — `carpool-assign-pick:{carId}`

Handles the user-select submission from the Carpool Assign Button. Assigns the chosen member a seat and adds them to the thread.

**Custom ID pattern:** `carpool-assign-pick:{carId}`

**Behavior:**

1. Parses `carId` from the custom ID; reads the selected `targetUserId` from `data.values[0]`.
2. Returns a deferred ephemeral acknowledgement and forks a background fiber.
3. The background fiber calls `Carpool/AssignSeat` RPC with `guild_id`, `discord_user_id`, `car_id`, and `target_discord_user_id`.
4. On success: adds the target user to the car's private thread (if present), rebuilds the public board, and replies with "Assigned <@userId> to car #N".

**Errors from `Carpool/AssignSeat`:**

| Error tag | User-visible message |
|-----------|----------------------|
| `CarpoolFull` | Car is full |
| `CarpoolAlreadyInThisCar` | Target already in this car |
| `CarpoolAlreadyInAnotherCar` | Target already in another car |
| `CarpoolOwnerCannotReserve` | Cannot assign the owner as a passenger |
| `CarpoolNotCarOwner` | You are not the owner of this car |
| `CarpoolTargetNotMember` | Target user is not a team member |
| `CarpoolCarNotFound` | Car not found |
| `CarpoolNotMember` | Not a member of this team |
| `CarpoolGuildNotFound` | Team not found for this Discord server |

**Source file:** `applications/bot/src/interactions/carpool.ts` (`CarpoolAssignPickSelect`)

---

### Email Approve Button — `email-approve:{teamId}:{emailId}`

Appears on the approval-request embed posted to the coach channel when a new email is received.

**Custom ID pattern:** `email-approve:{teamId}:{emailId}`

**Behavior:**

1. Returns a deferred ephemeral response and forks a background fiber.
2. The fiber calls `Email/RecordApproval` RPC with `team_id`, `email_id`, and the clicking user's Discord snowflake.
3. On success, edits the original approval embed to disable both Approve and Reject buttons.
4. Sends an ephemeral follow-up: approval confirmation, "already handled" notice, or an authorization error.

**Source file:** `applications/bot/src/interactions/email-approval.ts` (`EmailApproveButton`)

---

### Email Reject Button — `email-reject:{teamId}:{emailId}`

Appears on the same approval-request embed as the Approve button.

**Custom ID pattern:** `email-reject:{teamId}:{emailId}`

**Behavior:** identical to Approve but calls `Email/RecordRejection` RPC. The server posts the original email body (truncated) to the target channel.

**Source file:** `applications/bot/src/interactions/email-approval.ts` (`EmailRejectButton`)

---

### Email Detail Open Button — `email-detail:{teamId}:{emailId}`

Appears on the green team-post embed after a coach approves an email.

**Custom ID pattern:** `email-detail:{teamId}:{emailId}`

**Behavior:**

1. Returns a deferred ephemeral response.
2. Calls `Email/GetEmailContent` RPC to fetch the detailed summary.
3. Chunks the detailed summary text (up to 4 096 characters per embed page, capped at 20 pages) and renders the first page as a blurple embed with optional pagination buttons (`◀`/`▶`).
4. If the content exceeds 20 pages it is capped: a truncation notice is appended to the last kept page (including a deep link to the Email detail page in the web app when `WEB_URL` is configured). The embed footer shows "Page X/Y (truncated)".
5. Any error during rendering (RPC failure, unexpected exception) always resolves the ephemeral interaction with an error message — the interaction never hangs in a "loading" state.

**Source file:** `applications/bot/src/interactions/email-pages.ts` (`EmailDetailOpenButton`)

---

### Email Original Open Button — `email-original:{teamId}:{emailId}`

Appears on the same green team-post embed as the Detail button.

**Custom ID pattern:** `email-original:{teamId}:{emailId}`

**Behavior:** identical to Email Detail Open, but uses the raw `body` text and renders a grey embed. The same 20-page cap, truncation notice, and error-resolution guarantee apply.

**Source file:** `applications/bot/src/interactions/email-pages.ts` (`EmailOriginalOpenButton`)

---

### Email Detail Page Button — `email-detail-page:{teamId}:{emailId}:{pageIndex}`

Pagination button inside the ephemeral detailed-summary embed. Appears when the detailed summary exceeds one embed page.

**Custom ID pattern:** `email-detail-page:{teamId}:{emailId}:{pageIndex}`

**Behavior:** Defers an update, re-fetches the email content, applies the 20-page cap (with truncation notice on the last page if capped), and renders the requested page. Any error always resolves the interaction.

**Source file:** `applications/bot/src/interactions/email-pages.ts` (`EmailDetailPageButton`)

---

### Email Original Page Button — `email-original-page:{teamId}:{emailId}:{pageIndex}`

Pagination button inside the ephemeral original-email embed. Appears when the email body exceeds one embed page.

**Custom ID pattern:** `email-original-page:{teamId}:{emailId}:{pageIndex}`

**Behavior:** identical to Email Detail Page but renders the raw body text. The same 20-page cap and error-resolution guarantee apply.

**Source file:** `applications/bot/src/interactions/email-pages.ts` (`EmailOriginalPageButton`)

---

### Roster Approve Button — `rsv-approve:{eventId}:{memberId}`

Approves a roster attendance request from the per-event approval thread.

**Custom ID pattern:** `rsv-approve:{eventId}:{memberId}`

**Behavior:**

1. Responds immediately with a deferred ephemeral acknowledgement.
2. The background fiber calls `Event/ApproveRosterRequest` RPC with `event_id`, `team_member_id`, and the invoking user's `discord_user_id`.
3. If the outcome is `approved`: edits the follow-up with a localised "Approved {candidate}" confirmation and disables both Approve/Decline buttons on the source message.
4. If the outcome is `already_handled` or `already_member`: edits the follow-up with "Already handled".
5. Errors: `NotOwnerGroupMember` → "Only owners can decide" ephemeral; `RosterRequestNotPending` → "Already handled"; `RosterRequestNotFound` / `EventRosterEventNotFound` → generic error ephemeral.

**Source file:** `applications/bot/src/interactions/roster-approval.ts` (`RosterApproveButton`)

---

### Roster Decline Button — `rsv-decline:{eventId}:{memberId}`

Declines a roster attendance request from the per-event approval thread.

**Custom ID pattern:** `rsv-decline:{eventId}:{memberId}`

**Behavior:**

1. Responds immediately with a deferred ephemeral acknowledgement.
2. The background fiber calls `Event/DeclineRosterRequest` RPC with `event_id`, `team_member_id`, and the invoking user's `discord_user_id`.
3. If the outcome is `declined`: edits the follow-up with a localised "Declined" confirmation and disables both Approve/Decline buttons on the source message.
4. If the outcome is `already_handled` or `already_member`: edits the follow-up with "Already handled".
5. Errors: same as Roster Approve Button.

**Source file:** `applications/bot/src/interactions/roster-approval.ts` (`RosterDeclineButton`)

---

### Poll "Who voted?" Button — `poll-voters:{pollId}`

Appears on every poll embed (both open and closed). Sends an ephemeral "Who voted?" breakdown to the clicking user, listing each option with the voters' names and a true total count. No Discord @-mentions are sent — voter names are rendered as `Name (@mention)` text.

**Custom ID pattern:** `poll-voters:{pollId}`

**Visibility:** available to all team members (no `poll:manage` permission required).

**Behavior:**

1. Parses `pollId` from the custom ID.
2. Returns a `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` with the `Ephemeral` flag (ephemeral deferred), and forks a background fiber.
3. The background fiber calls `Poll/GetPollVoters` RPC with `guild_id`, `discord_user_id`, and `poll_id`.
4. On success (`Some(PollVotersView)`): builds a rich embed via `buildPollVotersView` (one field per option, vote count in the field name, voter names in the field value) and sends it as the ephemeral follow-up with `allowed_mentions: { parse: [] }` (suppresses any accidental pings).
5. On `None` (poll not found): sends an ephemeral "poll not found" message.
6. Each option field value is constructed by `buildPollVoterFieldValue`:
   - Zero-vote options show a "no votes yet" string.
   - Otherwise, voters are listed as `Name (@mention)` (display name preferred, username fallback).
   - The server caps returned voters to 60 per option; any extras from the server-side cap are counted into a "…and N more" suffix alongside any Discord embed-length truncation.
   - The embed respects Discord's 6000 code-point total limit; options near the budget are collapsed to a count-only value.

**Errors from `Poll/GetPollVoters`:**

| Error tag | User-visible message |
|-----------|----------------------|
| `PollGuildNotFound` | Team not found for this Discord server |
| `PollNotMember` | Not a member of this team |
| `RpcClientError` | Generic error (interaction is always resolved, never left loading) |

**Source files:**
- `applications/bot/src/interactions/poll.ts` (`PollVotersButton`, `PollVotersButtonReg`)
- `applications/bot/src/rest/poll/buildPollVotersView.ts`

---

### Leave Sudo Button — `sudo-leave:{subjectUserId}`

Appears on the permanent audit embed posted to the system channel when a team admin enters `/sudo` mode. Lets **any** team admin (not just the original invoker) revoke another admin's active sudo session.

**Custom ID pattern:** `sudo-leave:{subjectUserId}`

**Behavior:**

1. Parses `subjectUserId` from the custom ID.
2. Returns a deferred ephemeral acknowledgement and forks a background fiber.
3. The fiber calls `Guild/CheckTeamAdmin` RPC for the *clicking* user. If they are not an admin, replies ephemerally that only team admins can use sudo mode — **the shared audit message is left untouched** (not edited).
4. Otherwise calls `ensureSudoRole` to resolve the `Sideline Sudo` role ID, then `deleteGuildMemberRole` to revoke it from the subject user.
5. On success, edits the shared audit message in place to a resolved "✅ Sudo mode ended" state (green, no components, records who ended it and when) and replies ephemerally that sudo mode ended.
6. If the role/member was already gone (Discord 404 — e.g. the subject already left sudo themselves), treats it as success: still marks the message ended and replies "Sudo mode was already ended."
7. Any other Discord permission error (bot role hierarchy, missing Manage Roles) leaves the audit message **active** (components/embed unchanged) and replies with a revoke-failed warning.

**Source file:** `applications/bot/src/interactions/sudo.ts` (`SudoLeaveButton`, `SudoLeaveButtonReg`)

---

### Event Create Autocomplete

Provides training type suggestions for the `/event create training_type` option.

**Trigger condition:** command name is `event` and the focused option name is `training_type`.

**Behavior:** See `/event create` autocomplete description above.

**Source file:** `applications/bot/src/interactions/event-create-autocomplete.ts`

---

### Training Result Autocomplete

Provides loggable training-event suggestions for the `/training result event` option.

**Trigger condition:** command name is `training` and the focused option name is `event`.

**Behavior:** Calls `Event/GetLoggableTrainingEvents` with the guild ID. Filters results case-insensitively by the user's current input (matched against the event title and the ISO date string `YYYY-MM-DD`). Returns up to 25 choices formatted as `{date} · {title}` (truncated to 100 characters). The choice value is the event ID string. Returns empty choices on `GuildNotFound` or `RpcClientError`.

**Source file:** `applications/bot/src/interactions/training-result-autocomplete.ts`

---

### Training Generate Autocomplete

Provides loggable training-event suggestions for the `/training generate event` option.

**Trigger condition:** command name is `training` and the focused option name is `event` (shared autocomplete handler with the `result` sub-command).

**Behavior:** Identical to Training Result Autocomplete — calls `Event/GetLoggableTrainingEvents`, filters by the user's input, and returns up to 25 formatted choices. The choice value is the event ID string.

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

Twelve background worker loops run continuously inside the bot process. Eight of them (Role Sync, Channel Sync, Event Sync, Achievement Sync, Role Provision, Finance Sync, Weekly Challenge Sync, Email Sync) poll the server for unprocessed outbox events, process them sequentially, and mark each as processed or failed. Those eight loops use a **5-second polling interval** (`Schedule.spaced('5 seconds')`). Several outbox workers pass a client-side `POLL_BATCH_SIZE = 50` limit to the server query (Role Sync, Channel Sync, Event Sync, Achievement Sync, Role Provision, Finance Sync, Email Sync); the Weekly Challenge and Weekly Summary workers do not — their server-side queries are currently unbounded, which is acceptable because the per-team-per-week invariant naturally bounds the backlog. The ninth worker (Invite Generator) uses a **1-second polling interval** (`Schedule.spaced('1 seconds')`) for near-real-time Discord invite generation. The tenth worker (Channel Backfill) uses a **5-minute polling interval** (`Schedule.spaced('5 minutes')`) for low-cadence healing of groups that were never provisioned with a Discord role. The eleventh worker (Personal Events Provisioning) and the twelfth worker (Personal Events Reconcile) run on a **10-second polling interval** (`Schedule.spaced('10 seconds')`) and manage per-member private event channels.

The outbox workers implement the bot's side of the outbox pattern: the server inserts rows into `role_sync_events`, `channel_sync_events`, `event_sync_events`, `achievement_sync_events`, `discord_role_provision_events`, `payment_reminder_sync_events`, `weekly_challenge_sync_events`, and `email_post_sync_events`; the bot drains those queues.

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

Channel sync manages Discord channels and roles for Sideline groups. The Discord role (which gates channel access) and the Discord channel are now independent: a group always gets a role, but a channel is only created when explicitly requested. This means a mapping row can exist with a `discord_role_id` but no `discord_channel_id`.

**Events processed:**

| Event tag | Handler file | Discord action |
|-----------|-------------|----------------|
| `group_channel_created` | `handleCreated.ts` | Idempotent handler that ensures a Discord role exists for the group, then backfills all current group members (including members of descendant subgroups) onto that role. All branches resolve a single `roleId`, then execute a shared backfill step. Branch decisions: (1) `existing_channel_id` is set — creates a role for that channel via `createRoleForChannel` and calls `Channel/UpsertMapping`; (2) `discord_channel_name` is set — creates the channel via `createChannelOnly`, persists the channel ID immediately via `Channel/UpsertGroupChannel` (orphan-prevention on retry), creates the role via `createRoleForChannel`, and calls `Channel/UpsertMapping`; (3) neither is set — reads the existing mapping via `Channel/GetMapping` and sub-branches: (3a) mapping already has a role → reuses it (no creation), (3b) mapping has a channel but no role → creates a role via `createRoleForChannel`, calls `Channel/UpsertMapping`, (3c) mapping has no channel and no role, or no mapping exists → creates a role only via `createRoleOnly`, calls `Channel/UpsertMappingRoleOnly`. After the role is resolved, calls `Channel/GetGroupMembers` and calls `rest.addGuildMemberRole` for each member with concurrency 1 and per-member failure isolation — a single failed add is logged as a warning and does not abort the rest of the backfill. Permanent errors are not retried (see `isPermanentError`). `Channel/GetGroupMembers` uses a recursive CTE to return members of the group and all descendant subgroups (because `group_member_added` emits for the group and every ancestor). Phase 1 is add/heal only; pruning stale role-holders is a planned follow-up. |
| `roster_channel_created` | `handleRosterChannelCreated.ts` | Idempotent handler that ensures a Discord channel and role exist for the roster, then backfills all current roster members onto the role. Decision tree: (1) if a mapping exists with a `discord_role_id` → reuse the existing role (no create); (2) if a mapping exists without a role but with a channel → create a role only via `createRoleForChannel` and call `Channel/UpsertRosterMapping`; (3) if a mapping exists without either → create both channel and role via `createDiscordChannelAndRole`, call `Channel/UpsertRosterMapping` and `Channel/UpdateRosterChannel`; (4) if no mapping exists → same as (3) (or role-only when `existing_channel_id` is set). After the role is resolved, calls `Channel/GetRosterMembers` and calls `rest.addGuildMemberRole` for each member with concurrency 1 and per-member failure isolation — a single failed add is logged as a warning and does not abort the rest of the backfill. Permanent errors are not retried (see `isPermanentError`). Phase 1 is add/heal only; pruning stale role-holders is a planned follow-up. |
| `channel_updated` | `handleUpdated.ts` | Updates the existing Discord role name and colour, and (if present) the Discord channel name, to reflect the latest group/roster name, emoji, and colour settings; then calls `Guild/UpdateChannelName` RPC to write the new name back to the server's `discord_channels` cache |
| `channel_deleted` | `handleDeleted.ts` | Looks up the mapping via `Channel/GetMapping`, deletes the associated Discord role (if present) and the Discord channel (if present) via REST, then removes the mapping via `Channel/DeleteMapping` |
| `channel_archived` | `handleArchived.ts` | If a channel is present: moves it to the configured archive category via REST; falls back to deletion if the move fails. Removes the channel's permission overwrite for the associated role. The Discord role is NOT deleted. |
| `channel_detached` | `handleDetached.ts` | If both a channel and role ID are present, removes the channel's permission overwrite for the role in Discord, leaving the channel and role otherwise intact. Used when cleanup mode is `nothing`. |
| `group_member_added` | `handleMemberAdded.ts` | Resolves the group's Discord role, creating one if absent (role-only via `createRoleOnly`, or paired with an existing channel via `createRoleForChannel`), then assigns it to the guild member via REST. Never creates a Discord channel. |
| `roster_member_added` | `handleRosterMemberAdded.ts` | Looks up the roster's Discord role via `Channel/GetRosterMapping`; assigns it to the guild member if found; silently skips if no mapping or role exists. |
| `channel_member_removed` | `handleMemberRemoved.ts` | Looks up the mapping via `Channel/GetMapping`, then removes the channel's Discord role from the guild member via REST |
| `managed_channel_created` | `handleManagedCreated.ts` | Creates a Discord text channel in the guild (`createChannelOnly`), then calls `Channel/UpsertManagedChannel` with the new channel ID. `UpsertManagedChannel` persists the ID and back-fills any access grants that were recorded before the channel existed. |
| `managed_channel_archived` | `handleManagedArchived.ts` | If a Discord channel ID is present, moves the Discord channel to the configured archive category (`updateChannel parent_id`); falls back to deleting the channel if the move fails. **Does not call `Channel/ClearManagedChannel`** — the `discord_channel_id` link is preserved on the `team_channels` row so that a subsequent restore can re-activate the channel without reprovisioning it. |
| `managed_channel_deleted` | `handleManagedDeleted.ts` | If a Discord channel ID is present, deletes the Discord channel via REST. Then calls `Channel/ClearManagedChannel`. (No HTTP endpoint currently emits this event in v1; handler kept for future use.) |
| `managed_channel_adopted` | `handleManagedAdopted.ts` | Does a **full permission-overwrite replace** on the adopted Discord channel: calls `updateChannel` with `permission_overwrites: [{ id: guild_id, type: ROLE, deny: ViewChannel }]`. This single-element replace wipes all existing overwrites and sets `@everyone deny ViewChannel`, making the channel private. The bot retains access via its guild-level bot role, so this replace does not lock it out of the follow-up `setAccess` grants. Access grants for the channel are applied immediately after, via the existing `managed_access_granted` pipeline — **no grants are applied inside `handleManagedAdopted` itself**. Event tag: `channel_updated`, `entity_type: 'managed'`. |
| `managed_access_granted` | `handleManagedAccess.ts` (`handleManagedAccessGranted`) | Calls `setChannelAccessOverwrite` to apply a Discord permission overwrite on the channel for the given role at the specified `access_level` tier. |
| `managed_access_revoked` | `handleManagedAccess.ts` (`handleManagedAccessRevoked`) | Calls `removeChannelAccessOverwrite` to delete the Discord permission overwrite for the given role on the channel. |
| `discord_channel_archived` | `handleDiscordArchived.ts` | Moves the Discord-native channel to the archive category via `updateChannel { parent_id }`. **No delete-fallback** (the bot must never delete a channel it did not create). **No `Channel/ClearManagedChannel` call** (there is no `team_channels` row for `entity_type = 'discord'`). Move failures are caught and logged as warnings; the handler returns success so the event is still marked processed. |
| `managed_channel_restored` | `handleManagedRestored.ts` | If a Discord channel ID is present, moves the channel out of the archive category by setting `parent_id = null` (`updateChannel { parent_id: null }`). No delete-fallback and no `Channel/ClearManagedChannel` call — the link stays on the row. Move failures are caught and logged as warnings; the event is still marked processed. |
| `discord_channel_restored` | `handleDiscordRestored.ts` | Moves a Discord-native channel out of the archive category by setting `parent_id = null`. Same asymmetry as `discord_channel_archived`: no delete-fallback, no RPC ack (no `team_channels` row for `entity_type = 'discord'`). Move failures are caught and logged as warnings; the event is still marked processed. |
| `roster_role_reconcile` | `handleRosterRoleReconcile.ts` | Bidirectional reconcile for a single roster Discord role. (1) Fetches the expected set of role holders via `Channel/GetExpectedRoleHolders` — the union of active members across all rosters that share `discord_role_id` for the given team. (2) Paginates `listGuildMembers` (up to 50 pages × 1000 members) to collect every current holder of that role in the guild. (3) Computes extras = holders − expected, then calls `deleteGuildMemberRole` for each extra with concurrency 1 and per-member failure isolation (a failed removal is logged as a warning and does not abort the rest). Retries transient failures per `retryPolicy`; permanent errors are not retried. **Fail-closed**: if any `listGuildMembers` page fetch fails, the entire `holdersRaw` list is returned as empty — causing `extras` to be empty and preventing any removal for that roster. Emitted by `POST /teams/:teamId/rosters/backfill-roster-roles` (team-wide sync button). |

**Managed channel access tiers** (`applications/bot/src/rest/permissions.ts`):

| Level | Allow | Deny |
|---|---|---|
| `VIEW` | ViewChannel, ReadMessageHistory | SendMessages, AddReactions, all thread-write permissions |
| `EDIT` | ViewChannel, ReadMessageHistory, SendMessages, AddReactions, AttachFiles, EmbedLinks, all thread-write permissions | — |
| `ADMIN` | All EDIT permissions + ManageMessages, ManageThreads, PinMessages | — |

`ADMIN` intentionally excludes `ManageChannels` — that permission is reserved for bot management only.

**Lifecycle RPCs:**
- `Channel/MarkEventProcessed`
- `Channel/MarkEventFailed` — records transient failures; leaves `processed_at` null so the event is retried on the next poll.
- `Channel/MarkEventPermanentlyFailed` — records permanent failures (Discord 403/404, parse errors); sets `processed_at` so the event is never retried (poison-pill prevention).

**Permanent vs transient failure classification** (`ProcessorService.ts`): Discord `ErrorResponse` with HTTP status 403 or 404, or Discord JSON error codes 10xxx (Unknown Resource) and 50013 (Missing Permissions), and any `ParseError`/`SchemaError` are classified as permanent. All other errors are transient and will be retried.

---

### Channel Backfill Worker

**Service class:** `ChannelBackfillService` (`applications/bot/src/rcp/channel/index.ts`)

**RPC called:** `Channel/BackfillMissingGroupRoles`

**Polling interval:** 5 minutes (`slowPollLoop` in `Bot.ts`).

This worker heals groups that were never provisioned with a Discord role. A group can end up in this state when it was created as a role-only group before its team's Discord link was established — the normal `group_channel_created` outbox event either was never emitted or was emitted but could not succeed at the time.

On each tick the worker calls `Channel/BackfillMissingGroupRoles` with no `team_id` filter and no explicit limit (the server defaults to 20 per call). The server queries for non-archived groups that have either no row in `discord_channel_mappings` or a row with `discord_role_id IS NULL`, and that have no pending unprocessed provisioning event in `channel_sync_events`. For each qualifying group it emits a provisioning event into the normal `channel_sync_events` outbox — the Channel Sync Worker then picks it up and creates the role (role-only, or attaches a role to an existing channel) via the standard `group_channel_created` handler.

When the Channel Sync Worker calls `Channel/UpsertMapping` or `Channel/UpsertMappingRoleOnly` and the role is being set for the first time (previous `discord_role_id` was `null`), the server automatically re-applies all stored `team_channel_access` grants for that group on every already-provisioned managed channel (group-axis reconcile). This means previously stuck managed-channel access grants take effect without any manual action.

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
| `event_started` | `handleStarted.ts` | Three actions run in parallel. (1) In-place edit: looks up the stored Discord message via `Event/GetDiscordMessageId`, fetches updated RSVP counts and embed info, rebuilds the embed without RSVP action-row buttons, and edits the existing Discord message. If Discord returns error 10008 (Unknown Message — the message was deleted), the embed is re-posted with `createMessage` and the new message ID is persisted via `Event/SaveDiscordMessageId`. After the in-place edit (or recreation) succeeds, `reorderChannelMessages` is called so the started event moves into the channel's "past" section. (2) New announcement post: posts a fresh "Starting now: {title}" message to the team's configured reminders channel (falls back to the guild system channel when no reminders channel is set). The announcement embed lists the going attendees filtered to the event's member group, and is formatted in yellow. For **training** events: if `claimed_by_discord_id` is set the message content is `<@coachDiscordId>` (user mention with `allowed_mentions.users`); if no coach was assigned (or the claimer has no linked Discord) the content pings the owners-group Discord role (`<@&ownersRole>`) together with the i18n string `bot_event_started_no_coach_warning` ("No coach claimed this training."). If neither is available, only the warning text is shown. For **non-training** events the behavior is unchanged: the member-group Discord role is @-mentioned as before. The `GetYesAttendeesForEmbed` RPC is called with `member_group_id` so only members in the event's member group (and their descendants, via `WITH RECURSIVE descendant_groups`) appear. Emitted by `EventStartCron` when an event's `start_at` time passes. (3) Best-effort claim-message deletion: for training events, calls `Event/GetClaimInfo` to find the claim message's thread channel and message IDs, then calls `rest.deleteMessage` to remove the embed from the owners claim thread. Discord 10008 errors (unknown message) are silently swallowed; other errors are logged as warnings. |
| `rsvp_reminder` | `handleRsvpReminder.ts` | Fetches a reminder summary via `Event/GetRsvpReminderSummary` (yes/no/maybe counts, non-responder list, yes-attendee list with Discord IDs), posts a yellow reminder embed to the team's configured reminders channel (falls back to the owner-group's channel). No role @-mention is included in the message content — the reminder is embed-only. Non-responders and yes-attendees are filtered to the event's member group. Non-responders and yes-attendees are formatted as `**Name** (<@id>)` (dual format: bold name plus mention) when both are available; name-only when no Discord ID is linked; mention-only when only a Discord ID is known. The embed also includes a "Going" field listing current yes-attendees. Sends a direct message to each non-responder with a linked Discord account with a link to the voting message. |
| `training_claim_request` | `handleTrainingClaimRequest.ts` | Posts a claim-board message into a **persistent "Training claims" thread** scoped to the event's owner group. The flow is: (1) Resolve the owner group's claim thread via `Event/GetOwnerClaimThread`; if none exists, create a new PUBLIC_THREAD (type 11, 7-day auto-archive, name from i18n key `bot_claim_thread_name` = "Training claims") in the owner-group channel (`discord_target_channel_id`) and persist it via `Event/SaveOwnerClaimThread`. A compare-and-swap pattern handles concurrent requests: if two bot instances race to create the thread, only one wins the save and the loser deletes its orphan thread (best-effort) and uses the winner's ID. (2) Post the claim embed (event details, orange "Unclaimed" colour, "Claim" primary button) to the resolved thread via `rest.createMessage`. If the thread has since been deleted (Discord error 10003), the bot clears the stored ID via `Event/ClearOwnerClaimThread`, creates a fresh thread, and retries the post once. (3) Persist the thread channel ID and message ID via `Event/SaveClaimDiscordMessageId`. Unlike previous behavior, each training no longer gets its own thread; all trainings for the same owner group share one persistent thread. |
| `coaching_status` | `handleCoachingStatus.ts` | Posts a green "today's coach is X" embed to the channel supplied in `discord_target_channel_id`. The coach is shown as a Discord @-mention when a Discord ID is available, or a plain display name otherwise. Emitted by `CoachingStatusCron` on the day of a claimed training. |
| `training_claim_update` | `handleTrainingClaimUpdate.ts` | Edits the existing claim-board message (located via `claim_discord_channel_id` / `claim_discord_message_id`). The updated embed reflects whether the training is now claimed (green, claimer shown as `**Name** (<@discordId>)` using the same `formatNameWithMention` helper as RSVP attendee lists, Unclaim button) or unclaimed (orange, Claim button). The claimer's identity fields (`discord_id`, `name`, `nickname`, `display_name`, `username`) are resolved at SELECT time via a LEFT JOIN to `team_members → users` rather than being stored in the outbox row. If the message has been deleted (404 response), the update is silently skipped. |
| `unclaimed_training_reminder` | `handleUnclaimedTrainingReminder.ts` | Posts a yellow reminder embed to the owner-group's channel warning that the training is still unclaimed. If `claim_discord_channel_id` and `claim_discord_message_id` are present, the embed description includes a jump link to the claim-board message. If a Discord role is set, the message content @-mentions that role. Emitted by `RsvpReminderCron` alongside the normal RSVP reminder when the training's `claimed_by` is NULL. |
| `event_roster_approval_request` | `handleEventRosterApprovalRequest.ts` | Posts an Approve/Decline approval embed to a per-event Discord thread in the event's owner-group channel. Flow: (1) Resolve the stored thread ID via `Event/SaveEventRosterThreadIfAbsent`; if none exists, create a PUBLIC_THREAD (type 11, 7-day auto-archive, name `"Roster approval: {eventTitle}"` truncated to 100 chars) in `owner_channel_id` and save it with CAS — the loser of a concurrent race deletes its orphan thread and uses the winner's ID. (2) Build the approval embed (orange, pending state) via `buildRosterApprovalMessage` with event/candidate/roster fields and `rsv-approve:{eventId}:{memberId}` / `rsv-decline:{eventId}:{memberId}` button components. (3) Post the message to the resolved thread via `rest.createMessage`. (4) Persist the message ID via `Event/SaveApprovalRequestMessageId`. Emitted by `EventRosterProvisioningService` when a member RSVPs "yes" to an event whose linked roster has `auto_approve = false` and the member is not already a roster member. If `owner_channel_id` is absent (event has no owner group), the event is skipped with a warning. |
| `event_roster_approval_cancel` | `handleEventRosterApprovalCancel.ts` | Deletes the specific approval embed message from the per-event thread. Uses `owners_thread_id` (the thread channel ID) and `discord_message_id` (the message ID) from the event payload. Discord 10008 errors (Unknown Message) are silently swallowed. Emitted when a pending approval request is cancelled — e.g. the member's RSVP changes away from "yes" or the event–roster link is removed. |
| `event_roster_thread_delete` | `handleEventRosterThreadDelete.ts` | Deletes the entire per-event approval thread from Discord. Uses `owners_thread_id` from the event payload. Discord 10003 errors (Unknown Channel) are silently swallowed. Emitted when the event–roster link is removed and a thread previously existed. |
| `teams_generated` | `handleTeamsGenerated.ts` | Posts a generated-teams embed to the event's `discord_target_channel_id`. Flow: (1) If `discord_target_channel_id` is `None`, logs a warning and skips. (2) Fetches the guild via `rest.getGuild` to resolve the preferred locale. (3) Builds the embed via `buildGeneratedTeamsEmbed` — lists each team with its members (display name, rating, calibrating indicator) and average rating. (4) Posts the embed to the target channel via `rest.createMessage`. Discord errors are caught and logged as warnings without rethrowing. Emitted by `POST /teams/:teamId/events/:eventId/post-teams-to-discord`. |

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

### Achievement Sync Worker

**Service class:** `AchievementSyncService` (`applications/bot/src/rcp/achievement/index.ts`)

**Polling RPC:** `Achievement/GetUnprocessedEvents`

**Polling interval:** 5 seconds (`pollLoop` in `Bot.ts`).

The server's `AchievementEvaluator` service inserts a row into `achievement_sync_events` whenever a team member earns a new achievement (triggered after any activity is logged via the REST API or the `/makanicko log` bot command). The Achievement Sync worker drains this outbox.

**Events processed:**

| Event tag | Handler file | Discord action |
|-----------|-------------|----------------|
| `achievement_earned` | `handleAchievementEarned.ts` | (1) If `discord_role_id` is present (resolved from `achievement_role_mappings`), grants that Discord role to the member via REST — silently skips on 404 (role deleted). (2) If `welcome_channel_id` is present (from `teams.welcome_channel_id`), posts a congratulatory embed in that channel @-mentioning the member; if a role was granted, the embed also @-mentions the role. Silently skips the embed on 404 (channel deleted). Either action is optional; if neither is configured the event is still marked processed. |

**Lifecycle RPCs:**
- `Achievement/MarkEventProcessed` — called after each successful event.
- `Achievement/MarkEventFailed` — called on error; records the error string and sets `processed_at`, preventing retries (permanent failure semantics, same as `channel_sync_events`).

---

### Role Provision Worker

**Service class:** `RoleProvisionSyncService` (`applications/bot/src/rcp/roleProvision/ProcessorService.ts`)

**Polling RPC:** `RoleProvision/GetUnprocessedEvents`

**Polling interval:** 5 seconds (`pollLoop` in `Bot.ts`).

The Role Provision worker drains the `discord_role_provision_events` outbox. When a team admin selects **Auto-create** for an achievement's Discord role mapping, the server inserts a row in `discord_role_provision_events` with `desired_name` set to the achievement's display name. The worker processes each event as follows:

1. Calls `discord.listGuildRoles` for the event's `guild_id`.
2. Searches for an existing role whose name exactly matches `desired_name`.
3. If found, uses that role's ID (reuse semantics — avoids duplicate roles for the same achievement).
4. If not found, calls `discord.createGuildRole` with `{ name: desired_name }`.
5. Writes the resolved role ID back to the server:
   - `kind = "builtin_achievement"` → calls `Achievement/UpsertBuiltInRoleMapping` with `(team_id, achievement_slug, discord_role_id)`.
   - `kind = "custom_achievement"` → calls `Achievement/UpsertCustomRoleMapping` with `(team_id, custom_achievement_id, discord_role_id)`.
6. Marks the event processed via `RoleProvision/MarkProcessed`.

Failures are recorded via `RoleProvision/MarkFailed` (sets `processed_at`) and are not automatically retried.

**Lifecycle RPCs:**
- `RoleProvision/MarkProcessed` — called after each successful provision.
- `RoleProvision/MarkFailed` — called on error; records the error string and sets `processed_at`.

---

### Finance Sync Worker

**Service class:** `FinanceSyncService` (`applications/bot/src/rcp/finance/index.ts`)

**Polling RPC:** `Finance/GetUnprocessedPaymentReminders`

**Polling interval:** 5 seconds (`pollLoop` in `Bot.ts`).

The server's `PaymentReminderCron` (every minute) finds fee assignments that have crossed a reminder cadence threshold and inserts rows into `payment_reminder_sync_events`. The Finance Sync worker drains this outbox and sends a Discord DM to the relevant member.

**Events processed:**

| Event tag | Handler file | Discord action |
|-----------|-------------|----------------|
| `payment_reminder_ready` | `handlePaymentReminderReady.ts` | Opens a DM channel with the member via `discord.createDm`, posts a rich embed built by `buildPaymentReminderEmbed`, then calls `Finance/MarkReminderSent` to record successful delivery in `payment_reminders_sent`. |

The embed colour and copy vary by cadence:

| Kind | Title | Embed colour |
|---|---|---|
| `due_in_3d` | Heads up — payment due soon | Blue |
| `due_today` | Payment due today | Yellow |
| `overdue_3d` | Payment overdue | Red |
| `overdue_10d` | Payment overdue | Red |
| `overdue_21d` | Payment overdue | Red |

Each embed includes four fields: **Fee** (fee name), **Amount** (total charge), **Due** (due date as Discord timestamp), **Outstanding** (remaining unpaid amount).

**Lifecycle RPCs:**
- `Finance/MarkPaymentReminderProcessed` — called after each successful DM delivery (and after `Finance/MarkReminderSent` succeeds).
- `Finance/MarkPaymentReminderFailed` — called on any error; sets `processed_at` and records the error string. Failed events are not automatically retried (permanent failure semantics).

**Idempotency:** `Finance/MarkReminderSent` inserts into `payment_reminders_sent` with `PRIMARY KEY (assignment_id, kind)`. A reminder DM for a given assignment and kind is therefore sent at most once, even if the outbox row is retried or the bot restarts.

---

### Weekly Challenge Sync Worker

**Service class:** `ProcessorService` (`applications/bot/src/rcp/weeklyChallenge/ProcessorService.ts`)

**Polling RPC:** `WeeklyChallenge/GetUnprocessedWeeklyChallengeEvents`

**Polling interval:** 5 seconds (`pollLoop` in `Bot.ts`).

The server's weekly challenge cron inserts rows into the `weekly_challenge_sync_events` outbox table each Monday at 09:00 local team time (one row per team, for the current week's challenge). The Weekly Challenge Sync worker drains this outbox and posts an embed to the configured Discord channel.

**Events processed:**

| Event type | Handler file | Discord action |
|-----------|-------------|----------------|
| `weekly_challenge_ready` | `handleWeeklyChallengeReady.ts` | Builds a rich embed via `buildWeeklyChallengeEmbed` and posts it to the event's `channelId` via `rest.createMessage`. If the channel returns HTTP 404, the event is marked processed (not failed) and a warning is logged — a deleted channel cannot be retried into existence. Other Discord errors are retried via `retryPolicy`; the server-side 5-attempt cap on the outbox row terminates permanently failing rows. |

**Embed layout:**

| Element | Detail |
|---------|--------|
| Title | Kind-prefixed: `🥏 New throwing challenge: {title}` or `🏃 New sport challenge: {title}` |
| Color | Emerald (`#10b981`) for `throwing`; amber (`#f59e0b`) for `sport` |
| Fields | Inline `Druh` (kind label: `🥏 Házecí` or `🏃 Sportovní`) and `Týden` (`YYYY-MM-DD – YYYY-MM-DD`) |
| Description field | Optional; shown only when `description` is present |
| Footer | `Sideline · Týdenní výzva` |
| URL | Deep-link to `/teams/{teamId}/challenges` when `WEB_URL` is set in the bot's environment |

**Locale note:** the embed is rendered in Czech (`cs`) for the MVP. Per-team locale support (via `team.onboarding_locale`) is planned for a later release.

**Lifecycle RPCs:**
- `WeeklyChallenge/MarkWeeklyChallengeProcessed` — called with `{ eventId, deliveredAt }` after the embed is posted successfully.
- `WeeklyChallenge/MarkWeeklyChallengeFailed` — called with `{ eventId, error }` on any processing error; the server's 5-attempt cap prevents infinite retries.

**Concurrency:** events are processed sequentially (`concurrency: 1`). The expected backlog is at most one row per team per week, so the cap is not a bottleneck.

**Source files:**
- `applications/bot/src/rcp/weeklyChallenge/ProcessorService.ts`
- `applications/bot/src/rcp/weeklyChallenge/handleWeeklyChallengeReady.ts`
- `applications/bot/src/rest/weeklyChallenge/buildWeeklyChallengeEmbed.ts`

---

### Email Sync Worker

**Service class:** `EmailSyncService` (`applications/bot/src/rcp/email/index.ts`)

**Polling RPC:** `Email/GetUnprocessedEmailPostEvents`

**Polling interval:** 5 seconds (`pollLoop` in `Bot.ts`).

The server's AI summarization pipeline inserts rows into `email_post_sync_events` when an email is ready for a Discord action. The Email Sync worker drains this outbox.

**Events processed:**

| Event kind | Handler | Discord action |
|---|---|---|
| `approval_request` | `handleEmailPostEvent.ts` | Posts **two embeds** to the team's configured `coach_channel_id`: (1) an amber embed showing the **short summary** (falling back to the detailed summary or body) with From/Subject/Received fields; (2) a blurple embed showing the **detailed summary** (truncated at 3500 chars). Two buttons are attached: **Approve** (`email-approve:{teamId}:{emailId}`) and **Reject** (`email-reject:{teamId}:{emailId}`). An optional **Edit in Sideline** link button is appended when `WEB_URL` is set. |
| `post_summary` | `handleEmailPostEvent.ts` | Posts the **short summary** embed (green colour) to `target_channel_id`. Two buttons are always present: **Detailed summary** (`email-detail:{teamId}:{emailId}`) and **Original email** (`email-original:{teamId}:{emailId}`). |
| `post_original` | `handleEmailPostEvent.ts` | Posts the original email body (grey colour, truncated to 3500 characters) to `target_channel_id`. No buttons attached. |

**Embed builder:** `applications/bot/src/rest/email/buildEmailEmbeds.ts`

**Locale note:** all email embeds are rendered in Czech (`cs`). Per-team locale support is planned.

**Lifecycle RPCs:**
- `Email/MarkEmailPostEventProcessed` — called with event ID, kind, and the posted channel ID after the Discord message is created. For `post_summary` and `post_original`, also transitions the `email_messages.status`.
- `Email/MarkEmailPostEventFailed` — called on any error; the row is retried on the next poll.

---

### Personal Events Provisioning Worker

**Service class:** `ProcessorService` (`applications/bot/src/rcp/personalEvents/ProcessorService.ts`)

**Polling RPC:** `Guild/GetGuildsNeedingPersonalProvisioning`

**Polling interval:** 10 seconds.

This worker creates private per-member event channels, de-provisions channels for members who are no longer eligible, and renames channels whose name format has changed. On each tick it calls `Guild/GetGuildsNeedingPersonalProvisioning` to find guilds where the personal-channel feature is enabled (`discord_personal_events_category_id` is set) and at least one active member is missing a channel or has a channel rendered with an outdated format. For each such guild it runs three sequential passes:

**Provisioning pass (`handleProvision.ts`):**

1. Calls `Guild/GetMembersNeedingPersonalChannel` to retrieve up to `POLL_BATCH_SIZE` eligible members who still need a channel. The server applies any configured `discord_personal_events_group_id` restriction — only members of the configured group (and its descendant groups) are returned; all others are skipped.
2. For each member: calls `Guild/ReservePersonalChannel` (`ON CONFLICT DO NOTHING`) to claim the slot. If another worker already reserved it (`reserved = false`), the member is skipped.
3. Calls `Guild/GetPersonalChannelTargetCategory` to determine the target Discord category (the primary category or the latest overflow category if the primary is full).
4. Applies the team's `channel_format` template — replaces `{name}` with the member's display name and `{discord_id}` with their Discord user snowflake — to derive the channel name.
5. Calls `createPersonalEventChannel` (Discord REST) to create a private text channel visible only to that member and the bot.
6. On success, calls `Guild/SavePersonalChannelId` (now includes `channel_format`) to write the Discord snowflake and the applied format back. If category overflow is detected (Discord HTTP 400 / JSON error code 30013 — max channels in category), allocates a new overflow category row via `Guild/AllocatePersonalOverflowCategory`, fetches the base category name, calls `createGuildChannel(GUILD_CATEGORY)` to create the new Discord category (named `"{base name} ({n})"` where `n` is the overflow sequence + 1), saves the Discord snowflake via `Guild/SavePersonalOverflowCategoryId`, and retries the channel creation in the new category.
7. After writing the channel ID, calls `Guild/MarkTeamPersonalEventsDirty` to mark all of the team's active upcoming events dirty. This triggers the reconcile loop to backfill event embeds into the freshly-created channel so members see their existing events immediately. If this RPC call fails transiently it is logged as a warning and does not block provisioning.

**De-provisioning pass (`handleDeprovision.ts`):**

Runs immediately after the provisioning pass for the same guild. Calls `Guild/GetPersonalChannelsToDeprovision` to find members who currently have a personal channel but are no longer eligible (i.e. `discord_personal_events_group_id` is set and the member is outside that group). For each such member, deletes the Discord channel via REST and removes the row via `Guild/DeletePersonalChannel`. Returns an empty list if no group restriction is configured, so de-provisioning is a no-op for teams without a restriction.

**Rename pass (`handleRename.ts`):**

Runs immediately after the de-provisioning pass for the same guild. Calls `Guild/GetPersonalChannelsToRename` to find members whose stored `applied_channel_format` differs from the team's current `discord_personal_events_channel_format`. For each such member: renders the new channel name using the current format, calls `rest.updateChannel` to rename the Discord channel, then calls `Guild/SavePersonalChannelFormat` to record the applied format so the channel is no longer flagged as drifted. The applied format is only recorded once the rename lands (or Discord reports the channel gone with a 10003 Unknown Channel error), so a transient failure simply retries on the next tick. Channels are processed one at a time per guild to respect Discord rate limits. Existing channels created before migration `1790300011` have `applied_channel_format = NULL`, which is treated as drifted — they are renamed on the first provisioning tick after the migration.

**RPCs used by this worker:**

- `Guild/GetGuildsNeedingPersonalProvisioning`
- `Guild/GetMembersNeedingPersonalChannel`
- `Guild/ReservePersonalChannel`
- `Guild/GetPersonalChannelTargetCategory`
- `Guild/SavePersonalChannelId`
- `Guild/MarkTeamPersonalEventsDirty`
- `Guild/AllocatePersonalOverflowCategory`
- `Guild/SavePersonalOverflowCategoryId`
- `Guild/GetPersonalChannelsToDeprovision`
- `Guild/DeletePersonalChannel`
- `Guild/GetPersonalChannelsToRename`
- `Guild/SavePersonalChannelFormat`

---

### Personal Events Reconcile Worker

**Service class:** `ProcessorService` (`applications/bot/src/rcp/personalEvents/ProcessorService.ts`)

**Polling RPC:** `PersonalEvents/GetEventsNeedingReconcile`

**Polling interval:** 10 seconds.

This worker keeps the event embeds inside each member's private channel up to date. The server sets `events.personal_messages_dirty_at` whenever an event is created, updated, or cancelled, whenever a member submits an RSVP, or whenever a recurring event series is created, updated, or cancelled (so all generated occurrences within the horizon pick up series-level changes). The reconcile worker drains this dirty queue.

On each tick it calls `PersonalEvents/GetEventsNeedingReconcile` to get up to `POLL_BATCH_SIZE` events with a non-null `personal_messages_dirty_at`, ordered oldest-first. For each event it calls `Guild/ListPersonalChannelsForEvent` to enumerate every member who has a personal channel for that event's team. It then reconciles each member's message in the channel:

**Per-member reconcile (`reconcileMemberMessage`):**

1. Calls `Guild/GetAllUpcomingEventsForUser` to retrieve the full list of upcoming events with RSVP data for that member.
2. Calls `PersonalEvents/GetPersonalEventMessage` to retrieve the currently stored embed state (channel ID, message ID, payload hash).
3. If the event is no longer in the member's upcoming window (cancelled, started, or filtered by group): deletes the Discord message and the stored row via `PersonalEvents/DeletePersonalEventMessage`.
4. If the event is still upcoming: builds the embed via `buildPersonalMessagePayload` (matching the global event embed format, including the "Going" attendee list and an **Attendees** button). For events where the member has not yet responded, the message content includes an `@mention` of the member (suppressed via `allowed_mentions: { parse: [] }` — no real ping is sent) so the message appears as unread and is visually highlighted. Once the member responds, the `content` field is cleared to `''`.
5. Hashes the new payload and compares it to the stored hash. If they match, the update is skipped.
6. If an existing message is found: edits it in place via REST (`updateMessage`). In-place edits do not affect message ordering.
7. If no message exists yet: creates a new message via REST (`createMessage`) and persists the result via `PersonalEvents/UpsertPersonalEventMessage`. Since a `createMessage` appends to the bottom of the channel, the channel may now be out of order; these members are collected for the reorder pass below.

**Per-channel reorder pass (`reorderPersonalChannel`):**

After all members for an event have been reconciled, any member whose channel received a new message is subject to a reorder pass. The worker calls `PersonalEvents/ListMessagesForMember` to retrieve all stored personal event messages for that member ordered by `start_at` ascending. It then runs the same `longestKeepablePrefix` / delete-and-recreate algorithm used by the global event channel (`reorderChannelMessages`), ensuring that upcoming events inside each personal channel are ordered with the soonest event nearest the input box — matching the ordering in the global events channel. The reorder is serialised per-channel via `ChannelReorderSemaphore`.

After reconciling all members for an event, calls `PersonalEvents/ClearPersonalMessagesDirty` with the original `dirty_at` timestamp (optimistic concurrency — if a newer dirty timestamp was written since the reconcile started, the clear is skipped and the event remains dirty for the next tick).

**RPCs used by this worker:**

- `PersonalEvents/GetEventsNeedingReconcile`
- `Guild/ListPersonalChannelsForEvent`
- `Guild/GetAllUpcomingEventsForUser`
- `PersonalEvents/GetPersonalEventMessage`
- `PersonalEvents/UpsertPersonalEventMessage`
- `PersonalEvents/DeletePersonalEventMessage`
- `PersonalEvents/ListMessagesForMember`
- `PersonalEvents/ClearPersonalMessagesDirty`
- `Event/GetYesAttendeesForEmbed`

**Source files:**
- `applications/bot/src/rcp/personalEvents/ProcessorService.ts`
- `applications/bot/src/rcp/personalEvents/handleProvision.ts`
- `applications/bot/src/rcp/personalEvents/handleDeprovision.ts`
- `applications/bot/src/rcp/personalEvents/handleRename.ts`
- `applications/bot/src/rcp/personalEvents/handleReconcile.ts`
- `applications/bot/src/rcp/personalEvents/reorderPersonalChannel.ts`
- `applications/bot/src/rest/events/buildPersonalEventMessage.ts`

---

## Startup Tasks

In addition to the poll loops, the bot runs one-off tasks at startup (after the gateway connection is established). These tasks are composed alongside the poll loops with `concurrency: 'unbounded'` in `Bot.ts`.

### recoverDeletedMessages

**Source file:** `applications/bot/src/rcp/event/recoverDeletedMessages.ts`

On connect, the bot calls `Event/GetChannelsWithStoredMessages` to retrieve every `(discord_channel_id, guild_id)` pair for which at least one event message is currently stored in the database. For each channel it fetches the guild's preferred locale via the Discord REST API (defaults to `en` if the fetch fails), then runs `reorderChannelMessages`. Because `reorderChannelMessages` recovers from Discord 10008 errors by recreating any deleted messages (see "Message recovery" above), this single pass restores all event embeds that were removed from Discord while the bot was offline. Channels are processed with a concurrency of 3 (outer loop); per-channel reorders are still serialised by `ChannelReorderSemaphore`. Per-channel failures are logged as warnings and do not abort the remaining channels.

The optional `snowflakeOverrides` parameter on `reorderChannelMessages` (a `ReadonlyMap<eventId, Option<Snowflake>>`) lets callers force specific items into the recreate suffix by passing `Option.none()` for their snowflake. This is used internally when a message is known to be missing, bypassing the prefix-algorithm's keep decision.

---

## RPC Method Reference

The bot communicates with the server using the `SyncRpcs` RPC group defined in `packages/domain/src/rpc/SyncRpcs.ts`. Below is a complete list of all methods used by the bot, organized by group prefix.

### BotInfo group (`BotInfo/`)

| Method | Purpose |
|--------|---------|
| `BotInfo/ReportBotInfo` | Called at bot startup to report the running bot version to the server; payload: `{ version: string }`. Forked as a daemon fiber with a 5-second timeout so it does not block startup. |
| `BotInfo/GetServerVersion` | Called by the `/info` slash command handler to retrieve the server's running version string. |

### Guild group (`Guild/`)

| Method | Signature | Purpose |
|--------|-----------|---------|
| `Guild/RegisterGuild` | | Register a guild when the bot joins |
| `Guild/UnregisterGuild` | | Remove guild registration when the bot leaves |
| `Guild/IsGuildRegistered` | | Check whether a guild is already registered |
| `Guild/SyncGuildChannels` | | Bulk-sync all text channels for a guild |
| `Guild/UpdateChannelName` | | Update the cached name of a single Discord channel after the bot renames it |
| `Guild/UpsertChannel` | | Insert or update a single Discord channel row in `discord_channels`; called after the bot auto-creates a channel so the web can display its name |
| `Guild/DeleteChannel` | | Delete a single channel row from `discord_channels` when a Discord channel is deleted |
| `Guild/ReconcileMembers` | | Bulk-sync up to 1000 guild members on startup |
| `Guild/RegisterMember` | | Register a single new member; accepts `invite_code: Option<string>` (the Discord code matched by the invite diff) and returns `Option<WelcomeMeta>` (system log channel, optional welcome detail including rendered message, group colour, inviter Discord ID). The server resolves the invite code via `invite_acceptances.discord_code` (not `team_invites.discord_code`) to look up the team, group, and inviter. |
| `Guild/GetGuildsNeedingPersonalProvisioning` | `limit` → `Snowflake[]` | Returns guild IDs where personal events are enabled and at least one active member is missing a personal channel |
| `Guild/IdentifyEventsChannel` | `guild_id`, `channel_id`, `discord_user_id` → `{ kind, team_id, team_member_id, owner_discord_id, is_admin }` | Classifies a channel as `'global'` (the team's global events channel), `'personal'` (a member's personal events channel), or `'none'`. For `'personal'` channels, `owner_discord_id` is the Discord snowflake of the channel's owner — the bot compares this to the caller to tell an own-channel refresh apart from an admin refreshing someone else's. `is_admin` is `true` if the caller holds `team:manage`. |
| `Guild/GetPersonalEventsCategory` | `guild_id` → `Snowflake \| null` | Returns the team's `discord_personal_events_category_id` setting |
| `Guild/GetMembersNeedingPersonalChannel` | `guild_id`, `limit` → `{ team_id, team_member_id, discord_id, name, channel_format }[]` | Lists active members with no provisioned personal channel; applies the team's `discord_personal_events_group_id` restriction when set; `name` is the member's display name for the `{name}` channel-format placeholder; `channel_format` is the team's configured `discord_personal_events_channel_format` |
| `Guild/GetPersonalChannelsToDeprovision` | `guild_id`, `limit` → `{ team_id, team_member_id, discord_channel_id }[]` | Lists members who have a personal channel but are outside the configured `discord_personal_events_group_id` group; empty when no group restriction is set |
| `Guild/ReservePersonalChannel` | `team_id`, `team_member_id` → `{ reserved }` | Idempotent insert into `personal_event_channels` |
| `Guild/SavePersonalChannelId` | `team_id`, `team_member_id`, `discord_channel_id`, `channel_format` | Writes the Discord channel ID and the applied channel-name format after the bot creates a channel |
| `Guild/SavePersonalChannelFormat` | `team_id`, `team_member_id`, `channel_format` | Records the channel-name format last applied during a rename so drift detection works correctly on subsequent ticks |
| `Guild/GetPersonalChannelsToRename` | `guild_id`, `limit` → `{ team_id, team_member_id, discord_id, discord_channel_id, name, channel_format }[]` | Lists members whose channel was rendered with an outdated format; `channel_format` is the current format to apply |
| `Guild/MarkTeamPersonalEventsDirty` | `team_id` | Marks all active upcoming team events dirty so the reconcile loop backfills embeds into a freshly-provisioned channel |
| `Guild/GetPersonalChannel` | `team_id`, `team_member_id` → `Snowflake \| null` | Reads the stored Discord channel ID for a member |
| `Guild/DeletePersonalChannel` | `team_id`, `team_member_id` → `Snowflake \| null` | Deletes the row and returns the channel ID for cleanup |
| `Guild/ListPersonalChannelsForEvent` | `event_id` → `{ team_member_id, discord_id, personal_channel_id }[]` | Lists all members with a personal channel for reconcile |
| `Guild/GetPersonalChannelTargetCategory` | `team_id` → `{ category_id, is_overflow }` | Returns which Discord category to place the next personal channel into |
| `Guild/AllocatePersonalOverflowCategory` | `team_id` → `{ sequence, exists }` | Reserves the next overflow category slot |
| `Guild/SavePersonalOverflowCategoryId` | `team_id`, `sequence`, `discord_category_id` | Persists the Discord overflow category snowflake |
| `Guild/ListPersonalOverflowCategories` | `team_id` → `{ sequence, discord_category_id }[]` | Lists provisioned overflow categories in order |
| `Guild/GetAllUpcomingEventsForUser` | `guild_id`, `discord_user_id` → `UpcomingEventsForUserResult` | Returns all upcoming active events with the user's RSVP; used by the personal-channel reconcile worker |

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
| `Channel/MarkEventFailed` | Record a transient failure (event will be retried) |
| `Channel/MarkEventPermanentlyFailed` | Record a permanent failure (event is poisoned; `processed_at` is set to prevent retries) |
| `Channel/GetMapping` | Look up the Discord channel/role IDs for a group |
| `Channel/UpsertMapping` | Save or update the Discord channel+role mapping (both IDs required) |
| `Channel/UpsertMappingRoleOnly` | Save or update a role-only mapping (no channel ID) for a group |
| `Channel/UpsertGroupChannel` | Write a `discord_channel_id` onto an existing group mapping (used mid-flight during `group_channel_created` to persist the channel before role creation, preventing orphan channels on retry) |
| `Channel/DeleteMapping` | Remove the mapping when a group channel is deleted |
| `Channel/GetRosterMapping` | Look up the Discord channel/role IDs for a roster |
| `Channel/GetRosterMembers` | Return all current roster members who have a linked Discord account (`RosterMemberDiscord[]`); scoped to the requesting team — mismatched `team_id` or unknown roster yields an empty array |
| `Channel/GetGroupMembers` | Return all members of a group and its descendant subgroups who have a linked Discord account (`GroupMemberDiscord[]`); scoped to the requesting team — mismatched `team_id` or unknown group yields an empty array. Uses a recursive CTE (`WITH RECURSIVE descendants`) so that ancestor groups receive the full transitive membership when backfilling roles |
| `Channel/GetExpectedRoleHolders` | Return the union of active members across all rosters that share a given `discord_role_id` for a team (`RosterMemberDiscord[]`). Used by `handleRosterRoleReconcile.ts` to compute the expected set of role holders before removing extras |
| `Channel/UpsertRosterMapping` | Save or update the Discord channel+role mapping for a roster |
| `Channel/DeleteRosterMapping` | Remove the mapping when a roster channel is deleted |
| `Channel/UpdateRosterChannel` | Update the `discord_channel_id` on a roster's Sideline record |
| `Channel/GetManagedChannel` | Look up the `team_id` and current `discord_channel_id` for a `team_channels` row |
| `Channel/UpsertManagedChannel` | Persist the bot-provisioned Discord channel ID and back-fill any access grants that existed before the channel was provisioned |
| `Channel/ClearManagedChannel` | Clear `discord_channel_id` on the `team_channels` row after delete (not called for `managed_channel_archived` — the link is preserved through archive to enable restore; not called for `discord_channel_archived` or `discord_channel_restored` — `entity_type = 'discord'` has no `team_channels` row) |
| `Channel/DeleteManagedChannel` | Hard-delete a `team_channels` row (reserved for future use; not yet emitted) |

### Event group (`Event/`)

| Method | Purpose |
|--------|---------|
| `Event/GetUnprocessedEvents` | Poll for pending event outbox events |
| `Event/MarkEventProcessed` | Acknowledge successful processing |
| `Event/MarkEventFailed` | Record a processing failure |
| `Event/CreateEvent` | Create a new event (from `/event create`) |
| `Event/GetUpcomingGuildEvents` | Fetch paginated upcoming events (guild-scoped, no per-user RSVP data; used by the event sync worker embed builder) |
| `Event/GetUpcomingEventsForUser` | Fetch paginated upcoming events with the invoking user's RSVP status; used by `/event list` and pagination/RSVP buttons on the per-user embed |
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
| `Event/GetOwnerClaimThread` | Look up the persistent claim-thread ID stored on the `discord_channel_mappings` row for a given `(team_id, owner_group_id)` pair; returns `Option<Snowflake>` |
| `Event/SaveOwnerClaimThread` | Compare-and-swap write: sets `claim_thread_id` on the mapping row only when the current value is `NULL`; returns the winning thread ID (the caller's if it won, or the pre-existing one if it lost the race) |
| `Event/ClearOwnerClaimThread` | Sets `claim_thread_id = NULL` on the mapping row for a given `(team_id, owner_group_id)`; called when the thread is found to have been deleted (Discord error 10003) so that the next claim-request recreates it |
| `Event/GetChannelsWithStoredMessages` | Fetch all `(discord_channel_id, guild_id)` pairs for which at least one event message ID is stored; used by the `recoverDeletedMessages` startup task |
| `Event/GetLoggableTrainingEvents` | Fetch training events for the guild with status `active` or `started` whose `start_at` is within the past 2 days; used by the `/training result` autocomplete and command handler; errors: `GuildNotFound` |

### Invite group (`Invite/`)

| Method | Purpose |
|--------|---------|
| `Invite/PendingAcceptances` | Fetch pending `invite_acceptances` rows that need a Discord invite generated (1-second cadence) |
| `Invite/SetAcceptanceDiscordCode` | Store the generated single-use Discord invite code on the acceptance row |
| `Invite/MarkAcceptanceFailed` | Record the error code and detail when Discord invite creation fails |

### Carpool group (`Carpool/`)

| Method | Payload | Purpose |
|--------|---------|---------|
| `Carpool/CreateCarpool` | `guild_id`, `discord_user_id`, `discord_channel_id`, `event_id: Option<EventId>` | Create a new carpool board for the current channel. Errors: `CarpoolGuildNotFound`, `CarpoolNotMember`, `CarpoolForbidden`. |
| `Carpool/SaveCarpoolMessageId` | `carpool_id`, `discord_message_id` | Persist the Discord message ID of the public board message after it is posted. |
| `Carpool/SaveCarThreadId` | `car_id`, `thread_id` | Persist the Discord thread ID of a car's private thread after it is created. |
| `Carpool/GetCarpoolView` | `carpool_id` | Fetch the current `CarpoolView` (cars + passengers) for a carpool; returns `Option<CarpoolView>`. |
| `Carpool/AddCar` | `guild_id`, `discord_user_id`, `carpool_id`, `capacity: Int[1–8]`, `note: Option<string>` | Add a new car to a carpool; the owner occupies seat #1. Returns `AddCarResult` (new `car_id` + updated `CarpoolView`). Errors: `CarpoolGuildNotFound`, `CarpoolNotMember`, `CarpoolNotFound`, `CarpoolAlreadyOwnsCar`, `CarpoolAlreadyInAnotherCar`. |
| `Carpool/ReserveSeat` | `guild_id`, `discord_user_id`, `car_id` | Reserve a seat in a car (any member except the owner). Returns `ReserveResult` (`thread_id` + updated `CarpoolView`). Errors: `CarpoolGuildNotFound`, `CarpoolNotMember`, `CarpoolCarNotFound`, `CarpoolFull`, `CarpoolAlreadyInThisCar`, `CarpoolAlreadyInAnotherCar`, `CarpoolOwnerCannotReserve`. |
| `Carpool/AssignSeat` | `guild_id`, `discord_user_id`, `car_id`, `target_discord_user_id` | Owner assigns a seat to another team member. Returns `ReserveResult`. Errors: same as `ReserveSeat` plus `CarpoolNotCarOwner`, `CarpoolTargetNotMember`. |
| `Carpool/LeaveSeat` | `guild_id`, `discord_user_id`, `car_id` | Release a reserved seat (passengers only; owner cannot leave). Returns updated `CarpoolView`. Errors: `CarpoolGuildNotFound`, `CarpoolNotMember`, `CarpoolCarNotFound`, `CarpoolNotInCar`, `CarpoolOwnerCannotLeave`. |
| `Carpool/LeaveCarpool` | `guild_id`, `discord_user_id`, `carpool_id` | Release a reserved seat by carpool ID — the server resolves the specific car. Returns `LeaveCarpoolResult` (`car_id` + updated `CarpoolView`). Errors: `CarpoolGuildNotFound`, `CarpoolNotMember`, `CarpoolNotInCar`, `CarpoolOwnerCannotLeave`. |
| `Carpool/RemoveCar` | `guild_id`, `discord_user_id`, `car_id` | Owner removes their car entirely (deletes car + all seats). Returns `RemoveCarResult` (`thread_id` of the car's thread + updated `CarpoolView`). Errors: `CarpoolGuildNotFound`, `CarpoolNotMember`, `CarpoolCarNotFound`, `CarpoolNotCarOwner`. |

### Activity group (`Activity/`)

| Method | Purpose |
|--------|---------|
| `Activity/LogActivity` | Log a physical activity (from `/makanicko log`) |
| `Activity/GetStats` | Fetch personal stats and streaks (from `/makanicko stats`) |
| `Activity/GetLeaderboard` | Fetch team leaderboard (from `/makanicko leaderboard`) |

### Achievement group (`Achievement/`)

| Method | Purpose |
|--------|---------|
| `Achievement/GetUnprocessedEvents` | Poll for pending achievement outbox events |
| `Achievement/MarkEventProcessed` | Acknowledge successful processing |
| `Achievement/MarkEventFailed` | Record a processing failure (sets `processed_at`; event is not retried) |
| `Achievement/GetRoleMapping` | Look up the Discord role ID mapped to an achievement slug for a team |
| `Achievement/UpsertRoleMapping` | Save or update the Discord role ID mapping for a (team, achievement slug) pair (legacy) |
| `Achievement/UpsertBuiltInRoleMapping` | Save or update the role mapping for a built-in achievement after auto-provisioning |
| `Achievement/UpsertCustomRoleMapping` | Save or update the role mapping for a custom achievement after auto-provisioning |

### RoleProvision group (`RoleProvision/`)

| Method | Purpose |
|--------|---------|
| `RoleProvision/GetUnprocessedEvents` | Poll for pending `discord_role_provision_events` outbox rows |
| `RoleProvision/MarkProcessed` | Acknowledge a successful Discord role provision |
| `RoleProvision/MarkFailed` | Record a provision failure (sets `processed_at`; event is not retried) |

### WeeklyChallenge group (`WeeklyChallenge/`)

| Method | Purpose |
|--------|---------|
| `WeeklyChallenge/GetUnprocessedWeeklyChallengeEvents` | Poll for pending `weekly_challenge_sync_events` outbox rows (no client-side limit) |
| `WeeklyChallenge/MarkWeeklyChallengeProcessed` | Acknowledge successful processing; payload: `{ eventId, deliveredAt }` |
| `WeeklyChallenge/MarkWeeklyChallengeFailed` | Record a processing failure and increment the attempt counter; payload: `{ eventId, error }` |

### Email group (`Email/`)

| Method | Payload / Returns | Description |
|--------|---------|-------------|
| `Email/RecordApproval` | `team_id`, `email_id`, `discord_user_id` → `{ outcome }` | Records a coach approval. Validates team membership and `team:manage` permission. `outcome` is `"approved"` or `"already_handled"`. Errors: `EmailApprovalForbidden`, `EmailRpcMessageNotFound`. |
| `Email/RecordRejection` | `team_id`, `email_id`, `discord_user_id` → `{ outcome }` | Records a coach rejection. Same authorization check as approval. `outcome` is `"rejected"` or `"already_handled"`. Errors: `EmailApprovalForbidden`, `EmailRpcMessageNotFound`. |
| `Email/GetUnprocessedEmailPostEvents` | `{ limit }` → `UnprocessedEmailPostEvent[]` | Polls `email_post_sync_events` for rows where `processed_at IS NULL`, up to `limit`. |
| `Email/MarkEmailPostEventProcessed` | `id`, `deliveredAt`, `email_message_id`, `kind`, `posted_channel_id` | Sets `processed_at = now()`. For `post_summary`/`post_original` kinds, also updates `email_messages.status` and `posted_channel_id`. |
| `Email/MarkEmailPostEventFailed` | `id`, `error` | Records a delivery failure. The row remains `processed_at = NULL` and will be retried. |
| `Email/GetEmailContent` | `team_id`, `email_id` → `EmailContentView` | Returns `subject`, `from_address`, `short_summary`, `summary`, `body` for an email in `posted_summary` or `posted_original` status. Called by the ephemeral pagination buttons. Errors: `EmailRpcMessageNotFound`. |

---

### Finance group (`Finance/`)

| Method | Payload / Returns | Description |
|--------|---------|-------------|
| `Finance/GetMyStatus` | `guild_id`, `discord_user_id` → `GetMyStatusResult` | Returns the invoking member's fee assignment status grouped by currency. Used by `/finance status`. Errors: `FinanceGuildNotFound`, `FinanceMemberNotFound`. |
| `Finance/GetUnprocessedPaymentReminders` | `limit` → `UnprocessedPaymentReminderEvent[]` | Polls `payment_reminder_sync_events` for rows where `processed_at IS NULL`, up to `limit`. Called by the Finance Sync worker on a 5-second cadence. |
| `Finance/MarkPaymentReminderProcessed` | `id` → `void` | Sets `processed_at = now()` after the reminder DM was successfully delivered. |
| `Finance/MarkPaymentReminderFailed` | `id`, `error` → `void` | Sets `processed_at = now()` and records the error string. Failed events are not retried. |
| `Finance/MarkReminderSent` | `assignment_id`, `kind` → `void` | Inserts into `payment_reminders_sent` (idempotent upsert on PK `(assignment_id, kind)`). Called only after the Discord DM was accepted. |

`GetMyStatusResult` shape: `{ groups: FinanceStatusCurrencyGroup[] }` where each group carries `{ currency, total_outstanding_minor, assignments: FinanceStatusAssignment[] }` and each assignment carries `{ assignment_id, fee_name, status, due_minor, paid_minor, effective_due_at }`.

Status values: `pending`, `partial`, `paid`, `overdue`, `waived`.

`UnprocessedPaymentReminderEvent` fields: `id`, `team_id`, `guild_id`, `assignment_id`, `kind` (`due_in_3d | due_today | overdue_3d | overdue_10d | overdue_21d`), `fee_name`, `effective_due_at`, `currency`, `amount_minor`, `paid_minor`, `user_discord_id`.

### PersonalEvents group (`PersonalEvents/`)

| Method | Purpose |
|--------|---------|
| `PersonalEvents/GetPersonalEventMessage` | `event_id`, `team_member_id` → `{ personal_channel_id, discord_message_id, payload_hash } \| null` — Returns the stored embed state for an (event, member) pair |
| `PersonalEvents/UpsertPersonalEventMessage` | `event_id`, `team_member_id`, `personal_channel_id`, `discord_message_id`, `payload_hash` — Inserts or updates the stored embed state |
| `PersonalEvents/DeletePersonalEventMessage` | `event_id`, `team_member_id` — Deletes the stored embed state when the event no longer applies to the member |
| `PersonalEvents/GetEventsNeedingReconcile` | `limit` → `{ event_id, team_id, guild_id, dirty_at }[]` — Polls events with `personal_messages_dirty_at IS NOT NULL`; used by the reconcile worker |
| `PersonalEvents/ClearPersonalMessagesDirty` | `event_id`, `dirty_at` — Clears `personal_messages_dirty_at` with optimistic concurrency (only clears if the timestamp matches) |
| `PersonalEvents/ListMessagesForMember` | `team_member_id` → `{ event_id, personal_channel_id, discord_message_id, start_at }[]` — Returns all stored personal event messages for a member, ordered by `start_at` ascending; drives the per-channel reorder pass |

### Poll group (`Poll/`)

| Method | Payload | Purpose |
|--------|---------|---------|
| `Poll/CreatePoll` | `guild_id`, `discord_user_id`, `discord_channel_id`, `question`, `options_raw`, `multiple`, `allowed_role_id`, `deadline_raw` | Create a new poll; errors: `PollGuildNotFound`, `PollNotMember`, `PollForbidden`, `PollTooFewOptions`, `PollTooManyOptions`, `PollDuplicateOption`, `PollOptionTooLong`, `PollInvalidDeadline`, `PollDeadlineInPast` |
| `Poll/SavePollMessageId` | `guild_id`, `poll_id`, `discord_message_id` | Persist the Discord message ID after posting the poll embed; errors: `PollGuildNotFound`, `PollNotFound` |
| `Poll/CastVote` | `guild_id`, `discord_user_id`, `poll_id`, `option_id` | Cast or retract a vote; returns `CastVoteResult`; errors: `PollGuildNotFound`, `PollNotMember`, `PollNotFound`, `PollOptionNotFound`, `PollClosed` |
| `Poll/AddOption` | `guild_id`, `discord_user_id`, `poll_id`, `label`, `member_role_ids` | Add a new option to an open poll; returns `AddOptionResult`; errors: `PollGuildNotFound`, `PollNotMember`, `PollNotFound`, `PollClosed`, `PollOptionLimitReached`, `PollDuplicateOption`, `PollOptionTooLong`, `PollAddOptionForbidden` |
| `Poll/ClosePoll` | `guild_id`, `discord_user_id`, `poll_id` | Close a poll permanently; returns updated `PollView`; errors: `PollGuildNotFound`, `PollNotMember`, `PollForbidden`, `PollNotFound` |
| `Poll/GetPollView` | `guild_id`, `discord_user_id`, `poll_id` | Fetch the current `PollView` for a poll; returns `Option<PollView>`; errors: `PollGuildNotFound`, `PollNotMember` |
| `Poll/GetPollVoters` | `guild_id`, `discord_user_id`, `poll_id` | Fetch a `PollVotersView` containing per-option voter lists (server-side 60-voter cap per option); returns `Option<PollVotersView>`; errors: `PollGuildNotFound`, `PollNotMember` |

`PollVotersView` fields: `poll_id`, `question`, `status` (`open | closed`), `total_votes`, `options: PollOptionVoters[]`.

`PollOptionVoters` fields: `option_id`, `label`, `position`, `vote_count`, `voters: PollVoter[]` (at most 60 entries, ordered by first-vote time ascending).

`PollVoter` fields: `discord_id`, `name`, `nickname`, `display_name`, `username` (all nullable; the bot applies `display_name → nickname → username → name` display precedence).

---

### Summarize group (`Summarize/`)

| Method | Payload | Returns | Description |
|--------|---------|---------|-------------|
| `Summarize/SummarizeChannel` | `messages: TranscriptMessage[]`, `channelName: Option<string>`, `locale: 'en' \| 'cs'` | `SummarizeChannelResult` | Summarizes a Discord channel transcript using `LlmClient.summarizeChannel`. Applies a 12 000-character budget (drops oldest messages whole). Returns `{ summary, generated, summarizedCount }`. When the LLM is unavailable or the response is unparseable, `generated` is `false` and a deterministic fallback prose is returned. |

`TranscriptMessage` fields: `author: string`, `content: string`, `timestamp: DateTimeUtc`.

`SummarizeChannelResult` fields: `summary: string`, `generated: boolean`, `summarizedCount: number`.

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
| `WEB_URL` | No | — | Public base URL of the web frontend (e.g. `https://sideline.example.com`). When set, weekly challenge embeds include a deep-link button to `/teams/{teamId}/challenges`. |

Source: `applications/bot/src/env.ts`
