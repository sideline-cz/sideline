# Sideline — Core System Sequence Diagrams

This document provides sequence diagrams for the nine core flows in the Sideline platform. Each diagram is accompanied by a brief description of the flow and its key design decisions. The diagrams use Mermaid `sequenceDiagram` syntax and are intended for inclusion in a bachelor's thesis.

---

## 1. Discord OAuth2 Login Flow

A user initiates login through the web application. The server generates a state token containing a redirect URL, constructs the Discord authorization URL, and redirects the browser to Discord. After the user grants consent, Discord redirects back to the server callback with an authorization code. The server exchanges the code for an access token, fetches the user's Discord profile via the REST API, upserts the user and OAuth connection records (including the space-separated `granted_scopes` list) in PostgreSQL, and finally creates a 30-day session. The session token is returned to the browser as a query parameter on the redirect.

If the received token set is missing the `guilds.join` scope (which can happen for users who authenticated before this scope was required), the callback performs a one-shot re-authorisation loop: it redirects the browser back to Discord with a fresh state that carries `scopeRetry=true`. On the second callback the scope is present; the server then re-enqueues any `pending_guild_joins` rows that previously failed for the user and proceeds normally. If the second callback still lacks the scope, the server proceeds without re-enqueuing.

```mermaid
sequenceDiagram
    participant Browser
    participant WebApp as Web App (Vite/TanStack)
    participant Server as API Server (Effect HTTP)
    participant DiscordAPI as Discord API
    participant DB as PostgreSQL

    Browser->>WebApp: Click "Login with Discord"
    WebApp->>Server: GET /auth/login
    Server-->>WebApp: 200 OK — callback URL

    Browser->>Server: GET /auth/do-login
    Note over Server: Generate UUID state,<br/>encode {id, redirectUrl, scopeRetry: none} as JSON,<br/>build Discord authorization URL
    Server-->>Browser: 302 Redirect → discord.com/oauth2/authorize<br/>(scope: identify guilds guilds.join, state=<encoded>)

    Browser->>DiscordAPI: User grants consent
    DiscordAPI-->>Browser: 302 Redirect → /auth/callback?code=...&state=...

    Browser->>Server: GET /auth/callback?code=CODE&state=STATE
    Note over Server: Decode & validate state JSON
    Server->>DiscordAPI: POST /oauth2/token (exchange code for access token)
    DiscordAPI-->>Server: {access_token, refresh_token, scope, ...}

    alt guilds.join missing AND scopeRetry not already set
        Note over Server: One-shot re-auth loop
        Server-->>Browser: 302 Redirect → discord.com/oauth2/authorize<br/>(fresh state with scopeRetry=true)
        Browser->>DiscordAPI: User re-authorises
        DiscordAPI-->>Browser: 302 Redirect → /auth/callback (second call)
        Browser->>Server: GET /auth/callback (scopeRetry=true in state)
        Server->>DiscordAPI: POST /oauth2/token
        DiscordAPI-->>Server: {access_token, refresh_token, scope, ...}
    end

    Server->>DiscordAPI: GET /users/@me (using access token)
    DiscordAPI-->>Server: {id, username, avatar, ...}

    Server->>DB: UPSERT users ON CONFLICT (discord_id)
    DB-->>Server: User row {id, discord_id, username, ...}

    Server->>DB: UPSERT oauth_connections (user_id, provider='discord',<br/>access_token, refresh_token, granted_scopes)
    DB-->>Server: OK

    opt guilds.join now present AND scopeRetry was set
        Server->>DB: UPDATE pending_guild_joins SET processed_at=NULL, error=NULL<br/>WHERE user_id=? AND processed_at IS NOT NULL (re-enqueue)
        DB-->>Server: OK
    end

    Note over Server: Generate session token (UUID),<br/>set expires_at = now + 30 days
    Server->>DB: INSERT sessions {user_id, token, expires_at}
    DB-->>Server: Session row

    Server-->>Browser: 302 Redirect → FRONTEND_URL?token=<session_token>
    Browser->>WebApp: Store token, redirect to app

    alt OAuth error or Discord API failure
        Server-->>Browser: 302 Redirect → FRONTEND_URL?error=auth_failed&reason=<reason>
    end
```

---

## 2. Event Creation via Web App

An authenticated team member with the `event:create` permission creates an event through the web interface. The server validates the session token, checks team membership, enforces role-based permissions, optionally resolves group scoping from the training type, inserts the event, resolves the target Discord channel, and emits an `event_created` sync event to the `event_sync_events` queue so the bot can publish an embed to Discord.

```mermaid
sequenceDiagram
    participant Browser
    participant Server as API Server
    participant DB as PostgreSQL
    participant Queue as EventSyncEvents (DB table)

    Browser->>Server: POST /teams/{teamId}/events<br/>Authorization: Bearer <token><br/>Body: {title, eventType, startAt, endAt, ...}

    Note over Server: Auth middleware — look up session by token
    Server->>DB: SELECT users JOIN sessions WHERE token=?
    DB-->>Server: Current user

    Server->>DB: SELECT team_members WHERE team_id=? AND user_id=?
    DB-->>Server: Membership row (with permissions bitmask)

    alt Not a member
        Server-->>Browser: 403 Forbidden
    end

    Note over Server: Check permission event:create in bitmask
    alt Insufficient permission
        Server-->>Browser: 403 Forbidden
    end

    opt trainingTypeId provided and user is not admin
        Server->>DB: SELECT scoped_training_type_ids WHERE member_id=?
        DB-->>Server: Allowed training type IDs
        alt Training type not in scope
            Server-->>Browser: 403 Forbidden
        end
    end

    opt trainingTypeId set but no explicit group IDs
        Server->>DB: SELECT owner_group_id, member_group_id FROM training_types WHERE id=?
        DB-->>Server: Group IDs from training type
    end

    Server->>DB: INSERT events {team_id, title, event_type, start_at, end_at, location, ...}
    DB-->>Server: Event row {id, ...}

    Server->>DB: Resolve target Discord channel for event
    DB-->>Server: discord_channel_id (Option)

    Server->>Queue: INSERT event_sync_events {type='event_created', team_id, event_id, channel_id, ...}
    Queue-->>Server: OK

    Server-->>Browser: 201 Created — EventInfo {eventId, title, startAt, ...}
```

---

## 3. Event Creation via Discord Bot (Slash Command + Modal)

A Discord user runs a slash command (e.g., `/event create`) inside a guild. The bot responds immediately with a modal form (Discord requires a response within 3 seconds). The user fills in the modal fields. On submission the bot immediately acknowledges with an ephemeral "thinking" message (again within 3 seconds), then forks a daemon fiber that calls the server via the typed RPC protocol (`Event/CreateEvent`). The RPC handler on the server resolves the guild to a team, checks membership and permissions, inserts the event, and emits a sync event. The bot's daemon fiber then edits the original ephemeral message with the result.

```mermaid
sequenceDiagram
    participant User as Discord User
    participant Discord
    participant Bot as Bot Process (dfx)
    participant Server as API Server (RPC)
    participant DB as PostgreSQL
    participant Queue as EventSyncEvents (DB table)

    User->>Discord: /event create [type] [training_type?]
    Discord->>Bot: Interaction payload (APPLICATION_COMMAND)

    Note over Bot: Must respond within 3 seconds
    Bot-->>Discord: MODAL response<br/>custom_id="event-create:{type}:{trainingTypeId}"<br/>Fields: title, start, end, location, description

    User->>Discord: Fill modal, submit
    Discord->>Bot: Interaction payload (MODAL_SUBMIT)

    Note over Bot: Must respond within 3 seconds
    Bot->>Bot: Fork daemon fiber (submitAndFollowUp)
    Bot-->>Discord: CHANNEL_MESSAGE_WITH_SOURCE (ephemeral)<br/>"Thinking..."

    Note over Bot: Daemon fiber continues past 3s deadline

    Bot->>Server: RPC Event/CreateEvent {guild_id, discord_user_id, event_type, title, start_at, ...}

    Server->>DB: Resolve guild_id → team_id
    DB-->>Server: Team row

    Server->>DB: SELECT team_members WHERE discord_id=discord_user_id AND team_id=?
    DB-->>Server: Membership (or not found)

    alt Not a member
        Server-->>Bot: RPC error CreateEventNotMember
        Bot->>Discord: Edit original message → "You are not a member of this team"
    else Insufficient permission
        Server-->>Bot: RPC error CreateEventForbidden
        Bot->>Discord: Edit original message → "You do not have permission"
    else Invalid date format
        Server-->>Bot: RPC error CreateEventInvalidDate
        Bot->>Discord: Edit original message → "Invalid date format"
    else Success
        Server->>DB: INSERT events {team_id, title, event_type, start_at, ...}
        DB-->>Server: Event row {title, ...}

        Server->>Queue: INSERT event_sync_events {type='event_created', ...}
        Queue-->>Server: OK

        Server-->>Bot: RPC success {title}
        Bot->>Discord: PATCH webhooks/{app_id}/{token}/messages/@original<br/>"Event '{title}' created"
    end
```

---

## 4. RSVP via Discord Button

An event embed posted to a Discord channel contains RSVP buttons (Yes / No / Maybe). When a member clicks one, the bot immediately saves the RSVP without opening a modal and replies with an ephemeral confirmation. The confirmation includes a `[💬 Add a message]` button if no message exists, or `[💬 Edit message]` and `[🗑️ Clear message]` buttons if a message is already stored. Clicking the add/edit button opens a modal where the member can type an optional message; submitting the modal saves the message via a second `Event/SubmitRsvp` call. At each step the bot rebuilds and edits the original event embed with fresh RSVP counts.

```mermaid
sequenceDiagram
    participant User as Discord User
    participant Discord
    participant Bot as Bot Process
    participant Server as API Server (RPC)
    participant DB as PostgreSQL

    User->>Discord: Click RSVP button (custom_id="rsvp:{teamId}:{eventId}:{response}")
    Discord->>Bot: Interaction payload (MESSAGE_COMPONENT)

    Note over Bot: Must respond within 3 seconds
    Bot->>Bot: Fork daemon fiber (submitAndFollowUp)
    Bot-->>Discord: CHANNEL_MESSAGE_WITH_SOURCE (ephemeral)<br/>"Thinking..."

    Note over Bot: Daemon fiber continues

    Bot->>Server: RPC Event/SubmitRsvp {event_id, team_id, discord_user_id, response,<br/>message: none, clearMessage: false}

    Server->>DB: Resolve discord_user_id → team_member_id for team
    DB-->>Server: Member (or not found)

    alt Member not found
        Server-->>Bot: RPC error RsvpMemberNotFound
        Bot->>Discord: Edit original ephemeral → "You are not a member of this team"
    else Event not found
        Server-->>Bot: RPC error RsvpEventNotFound
        Bot->>Discord: Edit original ephemeral → "Event not found"
    else RSVP deadline passed
        Server-->>Bot: RPC error RsvpDeadlinePassed
        Bot->>Discord: Edit original ephemeral → "RSVP deadline has passed"
    else Not in member group
        Server-->>Bot: RPC error RsvpNotGroupMember
        Bot->>Discord: Edit original ephemeral → "You are not in the event's member group"
    else Success
        Server->>DB: UPSERT event_rsvps {event_id, member_id, response}<br/>message = COALESCE(new_message, existing_message)
        DB-->>Server: SubmitRsvpResult {yes, no, maybe, isLateRsvp, lateRsvpChannelId, message}

        Server-->>Bot: RPC success — SubmitRsvpResult

        Note over Bot: postRsvpDiscordUpdates (concurrent)
        Bot->>Server: RPC Event/GetDiscordMessageId {event_id}
        Bot->>Server: RPC Event/GetEventEmbedInfo {event_id}
        Bot->>Server: RPC Event/GetYesAttendeesForEmbed {event_id}
        Bot->>Discord: GET /guilds/{guild_id} (fetch preferred locale)
        Discord-->>Bot: Guild {preferred_locale}

        Note over Bot: Build embed with updated RSVP counts
        Bot->>Discord: PATCH /channels/{channel_id}/messages/{message_id}<br/>{embeds: [...], components: [...]}
        Discord-->>Bot: Updated message

        opt isLateRsvp = true and lateRsvpChannelId present
            Bot->>Discord: POST /channels/{lateRsvpChannelId}/messages<br/>(orange embed — late RSVP notification)
        end

        Note over Bot: Determine action row buttons<br/>message present → [Edit message] [Clear message]<br/>no message → [Add a message]
        Bot->>Discord: Edit original ephemeral → "Your response (Yes/No/Maybe) has been recorded"<br/>+ action row with message management buttons
    end

    opt User clicks [Add a message] or [Edit message] (custom_id="rsvp-add-msg:…")
        User->>Discord: Click "Add a message" / "Edit message" button
        Discord->>Bot: Interaction payload (MESSAGE_COMPONENT)

        Note over Bot: Must respond within 3 seconds
        Bot-->>Discord: MODAL response<br/>custom_id="rsvp-modal:{teamId}:{eventId}:{response}"<br/>Field: optional message (max 200 chars)

        User->>Discord: Fill message field, submit modal
        Discord->>Bot: Interaction payload (MODAL_SUBMIT)

        Note over Bot: Must respond within 3 seconds
        Bot->>Bot: Fork daemon fiber
        Bot-->>Discord: CHANNEL_MESSAGE_WITH_SOURCE (ephemeral)<br/>"Thinking..."

        Bot->>Server: RPC Event/SubmitRsvp {event_id, team_id, discord_user_id, response,<br/>message: some(text), clearMessage: false}
        Server->>DB: UPSERT event_rsvps — set message = provided text
        DB-->>Server: SubmitRsvpResult {message: some(text), ...}
        Server-->>Bot: RPC success

        Note over Bot: postRsvpDiscordUpdates — rebuild event embed
        Bot->>Discord: Edit original ephemeral → "Message saved."<br/>+ [Edit message] [Clear message] buttons
    end

    opt User clicks [Clear message] (custom_id="rsvp-clear-msg:…")
        User->>Discord: Click "Clear message" button
        Discord->>Bot: Interaction payload (MESSAGE_COMPONENT)

        Note over Bot: Must respond within 3 seconds
        Bot->>Bot: Fork daemon fiber
        Bot-->>Discord: CHANNEL_MESSAGE_WITH_SOURCE (ephemeral)<br/>"Thinking..."

        Bot->>Server: RPC Event/SubmitRsvp {event_id, team_id, discord_user_id, response,<br/>message: none, clearMessage: true}
        Server->>DB: UPSERT event_rsvps — set message = NULL
        DB-->>Server: SubmitRsvpResult {message: none, ...}
        Server-->>Bot: RPC success

        Note over Bot: postRsvpDiscordUpdates — rebuild event embed
        Bot->>Discord: Edit original ephemeral → "Message cleared."<br/>+ [Add a message] button
    end
```

---

## 5. Discord Role Sync (Outbound)

When an admin assigns a Sideline role to a team member via the web app, the server writes a `role_assigned` event row to the `role_sync_events` table. The bot runs a polling loop every 5 seconds that calls `Role/GetUnprocessedEvents` over RPC. For each event the bot ensures a Discord role mapping exists (creating the Discord role if necessary), calls the Discord API to assign the role to the member in the guild, then marks the event as processed. Failed events are marked with an error string for later inspection.

```mermaid
sequenceDiagram
    participant Admin as Admin (Browser)
    participant Server as API Server
    participant DB as PostgreSQL
    participant Bot as Bot Process (poll loop)
    participant Discord as Discord API

    Admin->>Server: POST /teams/{teamId}/members/{memberId}/roles<br/>(assign role)
    Server->>DB: INSERT team_member_roles {member_id, role_id}
    DB-->>Server: OK
    Server->>DB: INSERT role_sync_events {type='role_assigned', team_id, guild_id,<br/>role_id, role_name, team_member_id, discord_user_id}
    DB-->>Server: sync event row {id, ...}
    Server-->>Admin: 200 OK

    Note over Bot: Poll loop — every 5 seconds
    Bot->>Server: RPC Role/GetUnprocessedEvents {limit: BATCH_SIZE}
    Server->>DB: SELECT * FROM role_sync_events WHERE processed_at IS NULL LIMIT ?
    DB-->>Server: [role_assigned event, ...]
    Server-->>Bot: [UnprocessedRoleEvent, ...]

    loop For each event
        Bot->>Server: RPC Role/GetMapping {team_id, role_id}
        Server->>DB: SELECT discord_role_id FROM role_mappings WHERE team_id=? AND role_id=?
        DB-->>Server: Option<RoleMapping>

        alt No mapping yet
            Bot->>Discord: POST /guilds/{guild_id}/roles {name: role_name}
            Discord-->>Bot: Discord role {id}
            Bot->>Server: RPC Role/UpsertMapping {team_id, role_id, discord_role_id}
            Server->>DB: UPSERT role_mappings
            DB-->>Server: OK
        end

        Bot->>Discord: PUT /guilds/{guild_id}/members/{discord_user_id}/roles/{discord_role_id}
        Discord-->>Bot: 204 No Content

        alt Success
            Bot->>Server: RPC Role/MarkEventProcessed {id}
            Server->>DB: UPDATE role_sync_events SET processed_at=now() WHERE id=?
            DB-->>Server: OK
        else Discord API error
            Bot->>Server: RPC Role/MarkEventFailed {id, error}
            Server->>DB: UPDATE role_sync_events SET failed_at=now(), error=? WHERE id=?
            DB-->>Server: OK
        end
    end
```

---

## 6. Recurring Event Generation (Cron)

The `EventHorizonCron` runs on a daily schedule (`0 3 * * *` UTC). On each tick it fetches all active event series from the database, computes the generation horizon end date (the lesser of the series end date and `now + horizonDays`), calls `generateOccurrenceDates` to enumerate matching weekdays, and inserts one event row per date (sequentially, concurrency 1). After each insert it resolves the target Discord channel (checking the per-event override, the training-type default, and the team-settings event-type default in order) and emits an `event_created` row in the `event_sync_events` queue so the bot can publish an embed to Discord. If the sync-event emission fails, the failure is logged and suppressed — event insertion is never rolled back due to a notification error. Finally the cron updates the series' `last_generated_date` to the horizon end. The cron only generates dates from where it left off (`last_generated_date + 1 day`) so it is safe to run repeatedly.

```mermaid
sequenceDiagram
    participant Clock as System Clock (cron)
    participant Cron as EventHorizonCron
    participant SeriesRepo as EventSeriesRepository
    participant EventsRepo as EventsRepository
    participant SyncRepo as EventSyncEventsRepository
    participant DB as PostgreSQL

    Clock->>Cron: Trigger — 03:00 UTC daily

    Cron->>SeriesRepo: getActiveForGeneration()
    SeriesRepo->>DB: SELECT * FROM event_series WHERE active=true
    DB-->>SeriesRepo: [series rows]
    SeriesRepo-->>Cron: [EventSeries, ...]

    loop For each series
        Note over Cron: computeHorizonEnd:<br/>min(series.end_date, now + horizonDays)

        Note over Cron: startFrom = last_generated_date + 1 day<br/>(or series.start_date if never generated)

        alt startFrom > effectiveEnd
            Note over Cron: Nothing to generate — skip
        else dates available
            Note over Cron: generateOccurrenceDates:<br/>enumerate daysOfWeek in [startFrom, effectiveEnd]<br/>applying weekly / biweekly filter

            loop For each date (concurrency: 1)
                Cron->>EventsRepo: insertEvent {team_id, title, event_type='training',<br/>start_at, end_at, series_id, training_type_id,<br/>owner_group_id, member_group_id, ...}
                EventsRepo->>DB: INSERT events
                DB-->>EventsRepo: event row {id, ...}
                EventsRepo-->>Cron: event

                Note over Cron: resolveChannel — priority order:<br/>1. event.discord_target_channel_id<br/>2. training_type.discord_channel_id<br/>3. team_settings.discord_channel_{event_type}<br/>4. owner_group discord_channel_mapping.discord_channel_id
                Cron->>DB: resolve target Discord channel for event
                DB-->>Cron: Option<discord_channel_id>

                Cron->>SyncRepo: emitEventCreated(team_id, event_id, title,<br/>description, start_at, end_at, location,<br/>event_type, resolved_channel_id)
                SyncRepo->>DB: INSERT event_sync_events {type='event_created', ...}
                DB-->>SyncRepo: OK

                alt Sync event emission fails (defect)
                    Note over Cron: Log warning — suppress failure,<br/>event creation is unaffected
                end
            end

            Cron->>SeriesRepo: updateLastGeneratedDate(series.id, effectiveEnd)
            SeriesRepo->>DB: UPDATE event_series SET last_generated_date=? WHERE id=?
            DB-->>SeriesRepo: OK
        end
    end

    Note over Cron: Generation cycle complete — sleep until next tick
```

---

## 7. Event Started (Cron)

The `EventStartCron` runs every minute (`* * * * *`). On each tick it queries for `active` events whose `start_at` timestamp is in the past, atomically transitions each to `started` status, and emits an `event_started` row in the `event_sync_events` outbox. The bot's Event Sync worker picks up the event, edits the Discord embed to the started state (yellow, no RSVP buttons), and then reorders channel messages so the started event moves into the channel's "past" section. If the original Discord message has been deleted (error 10008), the bot recreates it and persists the new message ID. The reorder applies a cap of `MAX_CHANNEL_EVENTS = 10`: if there are more than 10 events for the channel the oldest past-events beyond the cap are deleted from Discord. Per-channel reorders are serialised by an in-process `ChannelReorderSemaphore`. On bot startup a `recoverDeletedMessages` task scans every channel with stored event messages and reruns the reorder, recreating any messages that were deleted while the bot was offline.

```mermaid
sequenceDiagram
    participant Clock as System Clock (cron)
    participant Cron as EventStartCron
    participant EventsRepo as EventsRepository
    participant SyncRepo as EventSyncEventsRepository
    participant DB as PostgreSQL
    participant Bot as Bot Process (poll loop)
    participant Discord as Discord API

    Clock->>Cron: Trigger — every minute

    Cron->>EventsRepo: findEventsToStart()
    EventsRepo->>DB: SELECT * FROM events<br/>WHERE status='active' AND start_at <= now()
    DB-->>EventsRepo: [event rows]
    EventsRepo-->>Cron: [Event, ...]

    loop For each event (concurrency: 1)
        Cron->>EventsRepo: startEvent(event.id)
        EventsRepo->>DB: UPDATE events SET status='started'<br/>WHERE id=? AND status='active'
        DB-->>EventsRepo: updated row count

        alt Already started (0 rows updated)
            Note over Cron: Skip — another process beat us (idempotent)
        else Successfully started
            Cron->>SyncRepo: emitEventStarted(team_id, event_id, ...)
            SyncRepo->>DB: INSERT event_sync_events {type='event_started', team_id, event_id, ...}
            DB-->>SyncRepo: OK
            Note over Cron: Log "marked event as started"
        end
    end

    Note over Bot: Poll loop — every 5 seconds
    Bot->>DB: RPC Event/GetUnprocessedEvents {limit: 50}
    DB-->>Bot: [event_started event, ...]

    loop For each event_started event
        Bot->>DB: RPC Event/GetDiscordMessageId {event_id}
        DB-->>Bot: Option<{discord_channel_id, discord_message_id}>

        alt No message stored
            Note over Bot: Log warning — skip
        else Message stored
            Bot->>DB: RPC Event/GetRsvpCounts {event_id}
            Bot->>DB: RPC Event/GetEventEmbedInfo {event_id}
            Bot->>DB: RPC Event/GetYesAttendeesForEmbed {event_id}
            Bot->>Discord: GET /guilds/{guild_id} (preferred locale)
            Discord-->>Bot: Guild {preferred_locale}

            Note over Bot: Build started embed — yellow colour,<br/>isStarted=true, components array empty (no RSVP buttons)
            Bot->>Discord: PATCH /channels/{channel_id}/messages/{message_id}<br/>{embeds: [...], components: []}

            alt Discord returns 200 OK
                Discord-->>Bot: Updated message
            else Discord returns 10008 (Unknown Message — deleted)
                Bot->>Discord: POST /channels/{channel_id}/messages (recreate embed)
                Discord-->>Bot: New message {id}
                Bot->>DB: RPC Event/SaveDiscordMessageId {event_id, channel_id, new_message_id}
            end

            Note over Bot: reorderChannelMessages (serialised per channel via ChannelReorderSemaphore)
            Bot->>DB: RPC Event/GetChannelEvents {channel_id}
            DB-->>Bot: sorted entries (past oldest-first · divider · future nearest-first)
            Note over Bot: Apply cap: drop oldest past events beyond MAX_CHANNEL_EVENTS=10
            Bot->>Discord: DELETE cap-dropped messages (if any)
            Note over Bot: Prefix algorithm — keep longest strictly-increasing<br/>snowflake prefix; recreate suffix (delete old → post new)
            Bot->>Discord: PATCH kept-prefix messages (in-place edit)
            Bot->>Discord: DELETE + POST suffix messages (recreate, concurrency: 1)
            Bot->>DB: RPC Event/SaveDiscordMessageId for any recreated messages
        end

        Bot->>DB: RPC Event/MarkEventProcessed {id}
    end

    Note over Bot: Startup task — recoverDeletedMessages
    Bot->>DB: RPC Event/GetChannelsWithStoredMessages
    DB-->>Bot: [{discord_channel_id, guild_id}, ...]

    loop For each channel (concurrency: 3, reorder serialised per channel)
        Bot->>Discord: GET /guilds/{guild_id} (preferred locale)
        Discord-->>Bot: Guild {preferred_locale} (or default 'en' on failure)
        Note over Bot: reorderChannelMessages — cap-drop, prefix/suffix split;<br/>recreates deleted messages and persists new IDs
    end
```

---

## 8. Team Creation and Guild Linking

Before creating a team the user must select a Discord guild in which they hold Administrator or Manage Guild permission and where the Sideline bot is already installed. The web app calls `GET /auth/my-guilds`, which uses the stored OAuth access token to list the user's guilds, filters to those with sufficient permissions, and annotates each with a `botPresent` flag. The user selects a guild and submits the team creation form. The server inserts the team, seeds default roles with their permission sets (Admin, Coach, Player), creates a team membership for the creator, and assigns the Admin role.

```mermaid
sequenceDiagram
    participant Browser
    participant Server as API Server
    participant DiscordAPI as Discord API
    participant DB as PostgreSQL

    Browser->>Server: GET /auth/my-guilds<br/>Authorization: Bearer <token>
    Note over Server: Auth middleware — resolve current user

    Server->>DB: SELECT access_token FROM oauth_connections<br/>WHERE user_id=? AND provider='discord'
    DB-->>Server: access_token

    Server->>DiscordAPI: GET /users/@me/guilds (using user access token)
    DiscordAPI-->>Server: [Guild, ...] with permissions bitmask

    Note over Server: Filter guilds where<br/>(permissions & ADMINISTRATOR) || (permissions & MANAGE_GUILD)

    loop For each permitted guild
        Server->>DB: SELECT EXISTS FROM bot_guilds WHERE guild_id=?
        DB-->>Server: botPresent: true/false
    end

    Server-->>Browser: [DiscordGuild {id, name, icon, botPresent}, ...]

    Browser->>Server: POST /auth/create-team<br/>{name: "FC Sideline", guildId: "123456789"}
    Note over Server: Auth middleware — resolve current user

    Server->>DB: INSERT teams {name, guild_id, created_by}
    DB-->>Server: Team {id, name, guild_id}

    Server->>DB: INSERT roles (Admin, Coach, Player) with permission sets<br/>for team_id
    DB-->>Server: [Role rows] including Admin role

    Server->>DB: INSERT team_members {team_id, user_id, active=true}
    DB-->>Server: TeamMember {id}

    Server->>DB: INSERT team_member_roles {member_id, role_id=Admin.id}
    DB-->>Server: OK

    Server-->>Browser: 201 Created — UserTeam {teamId, teamName,<br/>roleNames:["Admin"], permissions:[...]}
```

---

## 9. Member Onboarding via Group-Targeted Invite

A captain creates a group-targeted invite (e.g. for the "First Team" group) from the web app. The invite link is shared in Discord. A new player clicks the link, completes the Discord OAuth login, and joins the team's Discord guild. The bot detects the join via `GUILD_MEMBER_ADD`, identifies the invite code by diffing usage counts, calls `Guild/RegisterMember` on the server, which resolves the group, auto-adds the member to the group, renders the welcome message, and returns welcome metadata. The bot then posts a public welcome embed to the configured welcome channel and a private system log to the captain-only channel.

```mermaid
sequenceDiagram
    participant Captain as Captain (Browser)
    participant Server as API Server
    participant DB as PostgreSQL
    participant NewUser as New Player (Browser/Discord)
    participant Discord as Discord Gateway
    participant Bot as Bot Process
    participant REST as Discord REST

    Captain->>Server: POST /teams/{teamId}/invites<br/>{groupId: "first-team-id", expiresAt: null}
    Server->>DB: INSERT team_invites {team_id, code, active=true,<br/>group_id="first-team-id", created_by}
    DB-->>Server: TeamInvite {code}
    Server-->>Captain: 200 OK — InviteCode {code, active: true}

    Note over Captain: Share /invite/{code} in Discord

    NewUser->>Server: GET /invite/{code}
    Server->>DB: SELECT team_invites JOIN groups JOIN users (inviter)<br/>WHERE code=? AND active=true
    DB-->>Server: {team_name, team_id, code, group_name="First Team", inviter_username}
    Server-->>NewUser: 200 OK — InviteInfo {teamName, code, groupName, inviterName}

    NewUser->>Server: (Login via Discord OAuth — see Diagram 1)
    Note over NewUser: Now a Discord guild member

    Discord->>Bot: GUILD_MEMBER_ADD {guild_id, user, roles}

    Bot->>REST: GET /guilds/{guild_id}/invites
    REST-->>Bot: [{code, uses: 1}, ...]

    Note over Bot: InviteCache.diffOnMemberJoin — compare fresh<br/>use counts against stored snapshot; matched code = {code}

    Bot->>Server: RPC Guild/RegisterMember {guild_id, discord_id, username,<br/>avatar, roles, nickname, display_name,<br/>invite_code: some("{code}")}

    Server->>DB: Upsert user; find/create team_member
    Server->>DB: SELECT * FROM team_invites JOIN groups JOIN users<br/>WHERE code=? AND active=true (findByCodeWithContext)
    DB-->>Server: {team_id, group_id, group_name, inviter_discord_id, inviter_username, team_name}

    Server->>DB: INSERT group_members {group_id, team_member_id}
    DB-->>Server: OK

    Note over Server: applyTemplate(welcome_message_template, {<br/>  memberMention: "<@discord_id>",<br/>  memberName: "display_name",<br/>  inviterMention: "<@inviter_discord_id>",<br/>  inviterName: "inviter_username",<br/>  groupName: "First Team",<br/>  teamName: "FC Sideline"<br/>})

    Server-->>Bot: Option<WelcomeMeta> {<br/>  system_log_channel_id: some(...),<br/>  invite_code: some("{code}"),<br/>  welcome: some({<br/>    welcome_channel_id: some(...),<br/>    welcome_message_rendered: some("Welcome..."),<br/>    group_name: some("First Team"),<br/>    group_color_int: some(0x3498db),<br/>    inviter_discord_id: some(...)<br/>  })<br/>}

    par System log (captain-only channel)
        Bot->>REST: POST /channels/{system_log_channel_id}/messages<br/>embed: {title: "Member joined", fields: [member, invite code, inviter, group]}
        REST-->>Bot: 204 OK
    and Welcome message (public channel)
        Bot->>REST: POST /channels/{welcome_channel_id}/messages<br/>content: "<@memberId>",<br/>embed: {description: rendered, color: 0x3498db,<br/>author: display_name, fields: [{Group: "First Team"}]}
        REST-->>Bot: 204 OK
    end
```

---

## 10. Invite and Join Team (web flow)

An admin generates an invite link (or regenerates one) from the team settings page. The server creates a 12-character alphanumeric code, stores it in `team_invites`, and deactivates any previous codes for that team. A new user visits the invite URL in the browser, which first calls `GET /invite/{code}` to display the team name without authentication. When the user clicks "Accept", the front end redirects through the OAuth login flow (diagram 1), after which the app calls `POST /invite/{code}/join` with the session token. The server validates the code, checks the user is not already a member, resolves the "Player" role ID, inserts the membership, assigns the Player role, and returns a join result.

If the user's OAuth token is missing the `guilds.join` scope (a legacy user who authenticated before the scope was added), `joinViaInvite` skips the pending-guild-join enqueue and returns `requiresReauth: true`. The web app then shows a re-authorisation prompt. When the user re-authenticates via Discord (diagram 1), the auth callback detects the newly-granted scope and re-enqueues any failed pending-guild-joins automatically; no further action is required from the user.

```mermaid
sequenceDiagram
    participant Admin as Admin (Browser)
    participant NewUser as New User (Browser)
    participant Server as API Server
    participant DB as PostgreSQL

    Admin->>Server: POST /teams/{teamId}/invite/regenerate<br/>Authorization: Bearer <token>
    Note over Server: Verify team:invite permission
    Note over Server: Generate 12-char alphanumeric code
    Server->>DB: INSERT team_invites {team_id, code, active=true, created_by}
    DB-->>Server: Invite {code}
    Server->>DB: UPDATE team_invites SET active=false<br/>WHERE team_id=? AND id != newInvite.id
    DB-->>Server: OK
    Server-->>Admin: 200 OK — InviteCode {code}

    Note over Admin: Share invite URL: /invite/{code}

    NewUser->>Server: GET /invite/{code}
    Server->>DB: SELECT * FROM team_invites WHERE code=? AND active=true
    DB-->>Server: Invite row (or not found)

    alt Code not found or inactive
        Server-->>NewUser: 404 InviteNotFound
    else Valid invite
        Server->>DB: SELECT * FROM teams WHERE id=invite.team_id
        DB-->>Server: Team {name}
        Server-->>NewUser: 200 OK — InviteInfo {teamName, teamId, code}
    end

    NewUser->>Server: (Login via OAuth — see Diagram 1)
    Note over NewUser: Obtains session token

    NewUser->>Server: POST /invite/{code}/join<br/>Authorization: Bearer <token>
    Note over Server: Auth middleware — resolve current user

    Server->>DB: SELECT * FROM team_invites WHERE code=? AND active=true
    DB-->>Server: Invite row

    Server->>DB: SELECT * FROM team_members<br/>WHERE team_id=? AND user_id=?
    DB-->>Server: Option<Membership>

    alt Already a member
        Server-->>NewUser: 409 AlreadyMember
    else Not yet a member
        Server->>DB: SELECT role_id FROM roles<br/>WHERE team_id=? AND name='Player'
        DB-->>Server: Player role ID

        Server->>DB: INSERT team_members {team_id, user_id, active=true}
        DB-->>Server: TeamMember {id}

        Server->>DB: INSERT team_member_roles {member_id, role_id=Player.id}
        DB-->>Server: OK

        Server->>DB: SELECT granted_scopes FROM oauth_connections<br/>WHERE user_id=? AND provider='discord'
        DB-->>Server: granted_scopes (string)

        alt guilds.join present in granted_scopes
            Server->>DB: INSERT pending_guild_joins {user_id, guild_id, team_id}
            DB-->>Server: OK
            Server-->>NewUser: 200 OK — JoinResult {teamId, roleNames:["Player"],<br/>isProfileComplete, requiresReauth: false}
        else guilds.join missing (legacy token)
            Note over Server: Skip enqueue — bot cannot add user to guild
            Server-->>NewUser: 200 OK — JoinResult {teamId, roleNames:["Player"],<br/>isProfileComplete, requiresReauth: true}
            NewUser->>NewUser: Web app shows re-auth CTA<br/>"Re-connect Discord to finish joining"
            Note over NewUser: User clicks CTA → OAuth re-auth (Diagram 1)<br/>Callback re-enqueues pending_guild_joins automatically
        end
    end
```
