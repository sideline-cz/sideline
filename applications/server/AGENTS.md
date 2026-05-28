# Server Application (`@sideline/server`)

HTTP API server built with Effect-TS and PostgreSQL.

## Architecture

```
src/
├── api/             — HTTP API modules (errors, health, auth, composition)
├── repositories/    — Database repositories (Sessions, Users, Teams, etc.)
├── services/        — External service integrations (DiscordOAuth)
├── middleware/       — HTTP middleware (AuthMiddlewareLive)
├── rpc/             — RPC handler implementations
├── AppLive.ts       — Composable app layer (HTTP + API + Repos)
└── run.ts           — Runtime entrypoint (Pg, migrations, NodeRuntime)
```

Follows the **AppLive + run.ts** pattern:
- **`AppLive`** — composable `Layer` that wires up services without runtime concerns
- **`run.ts`** — provides PgClient, NodeHttpServer, Logger, Config and calls `NodeRuntime.runMain`

## Database & SQL Patterns

### Model.Class

Use `Model.Class` from `@effect/sql` for database models. See `packages/domain/AGENTS.md` for model definition patterns.

### SqlSchema Helpers

Use `SqlSchema` helpers for custom queries with schema-validated inputs/outputs:

- **`SqlSchema.findOne`** — returns `Option<T>` (first row or `None`)
- **`SqlSchema.single`** — returns `T` (first row, fails with `NoSuchElementException` if empty)
- **`SqlSchema.void`** — discards result (for DELETE/UPDATE without RETURNING)
- **`SqlSchema.findAll`** — returns `ReadonlyArray<T>`

```typescript
const findByDiscordId = SqlSchema.findOne({
  Request: Schema.String,
  Result: User,
  execute: (discordId) => sql`SELECT * FROM users WHERE discord_id = ${discordId}`,
});
```

### Repository Pattern

Construct repositories by starting from `SqlClient.SqlClient.pipe(Effect.bindTo('sql'), ...)`. Use `Effect.bind` for effectful dependencies and `Effect.let` for pure method definitions. End with `Bind.remove` to strip internals.

```typescript
import { Bind } from '@sideline/effect-lib';

export class UsersRepository extends Effect.Service<UsersRepository>()('api/UsersRepository', {
  effect: SqlClient.SqlClient.pipe(
    Effect.bindTo('sql'),
    Effect.bind('repo', () =>
      Model.makeRepository(User, {
        tableName: 'users',
        spanPrefix: 'UsersRepository',
        idColumn: 'id',
      }),
    ),
    Effect.let('findById', ({ repo }) => (id: UserId) => repo.findById(id)),
    Effect.let('findByDiscordId', ({ sql }) =>
      SqlSchema.findOne({
        Request: Schema.String,
        Result: User,
        execute: (discordId) => sql`SELECT * FROM users WHERE discord_id = ${discordId}`,
      }),
    ),
    Bind.remove('sql'),
    Bind.remove('repo'),
  ),
}) {}
```

### Model.makeRepository

Use for standard CRUD operations. Returns `findById` (→ `Option<T>`), `insert`, `update`, `delete`.

```typescript
const repo = Model.makeRepository(User, {
  tableName: 'users',
  spanPrefix: 'UsersRepository',
  idColumn: 'id',
});
```

## RPC Transport

RPC groups are served via NDJSON over HTTP. Each group has a domain definition and a server handler:

| Group | Domain definition | Server handler | Purpose |
|-------|------------------|----------------|---------|
| Role | `packages/domain/src/rpc/role/RoleRpcGroup.ts` | `src/rpc/role/index.ts` | Role sync events |
| Channel | `packages/domain/src/rpc/channel/ChannelRpcGroup.ts` | `src/rpc/channel/index.ts` | Channel sync events |
| Guild | `packages/domain/src/rpc/guild/GuildRpcGroup.ts` | `src/rpc/guild/index.ts` | Guild operations (sync/upsert/delete channels, register members, update channel names) |
| Event | `packages/domain/src/rpc/event/EventRpcGroup.ts` | `src/rpc/event/index.ts` | Event sync |
| Activity | `packages/domain/src/rpc/activity/ActivityRpcGroup.ts` | `src/rpc/activity/index.ts` | Activity sync |
| BotInfo | `packages/domain/src/rpc/botInfo/BotInfoRpcGroup.ts` | `src/rpc/botInfo/index.ts` | Bot version reporting (`ReportBotInfo` writes the bot's `APP_VERSION` into the in-memory `BotInfoStore` at startup; `GetServerVersion` returns the server's `APP_VERSION`). Backs the `/version` HTTP endpoint and the bot's `/info` slash command. |

The `Guild/UpdateChannelName` RPC updates the `discord_channels` table when the bot renames a Discord channel. The bot calls this after processing a `channel_updated` event to keep the server's `discord_channels.name` column in sync with the actual Discord channel name.

The `Guild/UpsertChannel` and `Guild/DeleteChannel` RPCs are called by the bot's gateway event handlers (`ChannelCreate`, `ChannelUpdate`, `ChannelDelete`) to keep the `discord_channels` table in sync with real-time Discord channel changes. `UpsertChannel` inserts or updates a channel row (using `ON CONFLICT DO UPDATE`), and `DeleteChannel` removes a channel row by `guild_id` + `channel_id`.

### `Guild/RegisterMember` and Welcome Metadata

`Guild/RegisterMember` (`src/rpc/guild/index.ts`) is called by the bot's `GuildMemberAdd` handler. It upserts the user, creates or reactivates the team membership, applies role/group mappings, and returns `Option<WelcomeMeta>`. The bot uses the returned metadata to send a system-log message and (optionally) a welcome message — see `applications/bot/AGENTS.md` for the bot side.

The RPC payload includes `invite_code: Option<Snowflake-like string>` — this is the **Discord** invite code captured by the bot's invite-diff (one-use code minted per acceptance; see "Per-Acceptance Discord Invites" below), **not** the Sideline `team_invites.code`. The server resolves welcome metadata as follows:

1. If `findByGuildId(guild_id)` returns `None`, return `Option.none()` — the guild is not linked.
2. Always populate `system_log_channel_id` from the team row.
3. If `invite_code` is `Some`, look up the consumed acceptance via `acceptances.findByDiscordCodeWithContext(code)` (joins `invite_acceptances → team_invites → users → teams → groups`). If no acceptance row matches the Discord code (or its parent `team_invites` row is inactive/expired), log a warning/error and return `noWelcome` (system log only, no welcome embed). **Never** fall back to `TeamInvitesRepository.findByCodeWithContext` here — `team_invites` no longer has a `discord_code` column.
4. If the lookup resolves and the team has `welcome_message_template`, render it with `applyTemplate(template, vars)` then `sanitizeRendered(...)` from `@sideline/template-renderer`. The rendered string goes into `welcome.welcome_message_rendered` — **never send the raw template to the bot**.
5. If the parent invite has a `group_id`, add the new member to that group AND fetch the group's color via `groups.findGroupById` → `sanitizeHexColor` to populate `group_color_int`.

The server is the only renderer of welcome templates. The bot receives a fully-substituted, sanitized string and embeds it as-is.

### Per-Acceptance Discord Invites

Each time a user clicks "Accept" on `/invite/{code}`, the server inserts an `invite_acceptances` row (FK to `team_invites`, FK to `users`) and returns its id to the client. The Discord invite is generated **per acceptance**, not per `team_invites` row, so each acceptance produces a distinct `max_uses: 1, max_age: 24h` Discord invite that is bound to that single recipient.

| Column on `invite_acceptances` | Purpose |
|--------------------------------|---------|
| `id` | Acceptance UUID returned to the web client and used by `getJoinStatus`. |
| `team_invite_id` | FK to the underlying `team_invites` row (the captain-created code). |
| `user_id` | FK to the accepting user. |
| `discord_code` | One-use Discord invite code minted by the bot's `Invite/SetAcceptanceDiscordCode` RPC. `NULL` until generated. Unique partial index. |
| `discord_code_error_code` / `discord_code_error_detail` | Populated by `Invite/MarkAcceptanceFailed` when the bot cannot mint an invite. |
| `created_at` / `generated_at` | Insert time / mint time. |

Rules:

1. **`team_invites.discord_code` no longer exists.** Never add a column-level Discord code to `team_invites` again — minted codes always live on `invite_acceptances`.
2. **`InviteAcceptancesRepository` owns all Discord-code helpers** (`findPending`, `setDiscordCode`, `markFailed`, `findByDiscordCodeWithContext`). `TeamInvitesRepository` must not regain these methods.
3. The `Guild/RegisterMember` Discord-code lookup, the invite-generator poll, and the `getJoinStatus` API all read from `invite_acceptances`. There is no other source of truth for a minted Discord code.

### Invite Endpoints (`src/api/invite.ts`)

| Endpoint | Path | Purpose |
|----------|------|---------|
| `getInvite` | `GET /invite/:code` | Public — resolve invite for the join landing page |
| `joinViaInvite` | `POST /invite/:code/join` | Authenticated — accept invite, create membership, insert `invite_acceptances` row, return `JoinResult { teamId, roleNames, isProfileComplete, requiresReauth, acceptanceId: Option<InviteAcceptanceId> }`. **Never returns a `discordInviteUrl`** — the bot mints the Discord invite asynchronously and the client must poll `getJoinStatus`. |
| `getJoinStatus` | `GET /invite/acceptances/:acceptanceId` | Authenticated — poll the acceptance row; returns `JoinStatus { acceptanceId, discordInviteUrl: Option<string>, errorCode: Option<InviteGeneratorErrorCode> }`. The web polls this every 1.5s after a successful join until either `discordInviteUrl` or `errorCode` becomes `Some`. |
| `createInvite` | `POST /teams/:teamId/invites` | Captain — create invite (optionally bound to a `groupId`, optional `expiresAt`). Does NOT mint any Discord code — codes are minted per acceptance, not per `team_invites` row. |
| `listInvitesForTeam` | `GET /teams/:teamId/invites` | Captain — list active and inactive invites for management UI. The returned `InviteListItem` has no `discordCode` field; captains share only the `/invite/{code}` Sideline link. |
| `regenerateInvite` | `POST /teams/:teamId/invite/regenerate` | **Deprecated** — kept for backwards compat; prefer `createInvite` |
| `disableInvite` | `DELETE /teams/:teamId/invite` | Captain — deactivate **all** invites for a team |
| `deactivateInvite` | `POST /teams/:teamId/invites/:inviteId/deactivate` | Captain — deactivate a single invite by id |

All captain-scoped endpoints require `team:invite` permission via `requirePermission(membership, 'team:invite', forbidden)`. The `createInvite` handler validates that `groupId` (if provided) belongs to `teamId` before insertion — fails with `InvalidGroup` otherwise. Invite-code generation retries up to 5 times on unique-constraint collision (`Schedule.recurs(5)` with 100ms delay).

## Sync Event Pattern

When API handlers create/delete resources that need Discord sync:

1. Perform the primary operation (e.g. insert group)
2. Call `repo.emitIfGuildLinked(teamId, eventType, ...)` — looks up `guild_id` from `teams` table; if linked, inserts event row; if not, no-op
3. Wrap emission in `Effect.catchAllDefect(() => Effect.void)` so sync failures never break the primary operation. Use `Effect.catchAllDefect` (not `Effect.catchAll`) because repository methods convert SQL/parse errors to defects via `catchSqlErrors`. Always log before catching with `Effect.tapDefect`

### Channel Sync Event Lifecycle (Server side)

`channel_sync_events` is a poll-driven outbox. Each event has two terminal states besides "processed":

| Repository method | RPC alias | SQL effect | When the bot calls it |
|-------------------|-----------|------------|----------------------|
| `markProcessed` | `Channel/MarkEventProcessed` | `SET processed_at = now()` | Handler succeeded. |
| `markFailed` | `Channel/MarkEventFailed` | `SET error = $1` (leaves `processed_at` NULL) | Transient failure — row is retried on next poll. |
| `markPermanentlyFailed` | `Channel/MarkEventPermanentlyFailed` | `SET processed_at = now(), error = $1` | Permanent failure (Discord 403/404, `ParseError`, missing payload field) — row stops being polled. |

Rules:

1. **Never delete `channel_sync_events` rows on failure** — the row is kept for audit. Both failure paths only UPDATE.
2. **The transient/permanent decision lives in the bot** (`isPermanentError` in `ProcessorService.ts`). Do NOT add server-side error classification — the server exposes both RPCs and the bot picks.
3. **Server-side decode failures** (`EventPropertyMissing` in `src/rpc/channel/events.ts`) always call `markPermanentlyFailed` — missing payload fields are not transient.
4. When adding a new failure-classification rule, update the bot's `isPermanentError` and `applications/bot/AGENTS.md`, not the server.

### Outbox Failure Modes: Two-RPC Classification vs `attempts`-Counted Retry

There are two server-side patterns for failure handling on a `*_sync_events` / `*_provision_events` outbox table. Pick one per table; do not mix them.

| Pattern | When to use | Schema cost | Permanent-stop trigger |
|---------|-------------|-------------|------------------------|
| **Two-RPC classification** (`markFailed` + `markPermanentlyFailed`) | Failure modes are classifiable up-front (HTTP 403/404, Discord JSON code 50013, `ParseError` → permanent; everything else → transient). Used by `channel_sync_events`. | One column (`error TEXT`). | Bot calls `markPermanentlyFailed` explicitly when `isPermanentError(error)` returns `true`. |
| **`attempts`-counted retry** (`markFailed` only, with `attempts INT NOT NULL DEFAULT 0`) | Failure modes are not reliably classifiable (best-effort Discord REST work where transient/permanent looks identical), so the safe contract is "retry N times then give up". Used by `discord_role_provision_events`. | Two columns (`error TEXT`, `attempts INT NOT NULL DEFAULT 0`). | The SQL sets `processed_at` automatically once `attempts + 1 >= maxAttempts`. |

The canonical `attempts`-counted UPDATE (see `DiscordRoleProvisionEventsRepository.markAttemptFailed`):

```sql
UPDATE <table>
SET
  attempts = attempts + 1,
  error = ${input.error},
  processed_at = CASE WHEN attempts + 1 >= ${input.maxAttempts} THEN now() ELSE NULL END
WHERE id = ${input.id}
```

Rules when adding an `attempts`-counted outbox:

1. **Add the `attempts INT NOT NULL DEFAULT 0` column in the same migration** that creates the outbox table — do not introduce it later, because in-flight rows would compute `NULL + 1 = NULL` and silently get stuck.
2. **Define `MAX_ATTEMPTS` as a module-level constant in the repository** (not as an RPC payload field) so the bot cannot widen the retry budget. Pass the constant into the SQL via the `Request` schema's `maxAttempts: Schema.Number` field as shown above — this keeps the value bound through `SqlSchema.void` while still being internal to the server.
3. **The bot calls one RPC (`MarkFailed`) on any failure** — no `MarkPermanentlyFailed` RPC exists for this table. The server's `CASE WHEN` decides whether the row stops polling.
4. **`supersede(teamId, kind, refId)` is the manual escape hatch.** When the user takes an action that invalidates a still-pending outbox row (e.g. changing the role mapping before the bot has provisioned the previous one), the API handler calls `supersede` to UPDATE `processed_at = now(), error = 'superseded_by_user'` for any unprocessed row matching the natural key. Do not delete the row — keep it for audit.
5. **The natural key (`team_id, kind, ref_id`) is `UNIQUE`** with `ON CONFLICT DO NOTHING` on enqueue, so re-enqueueing the same operation while a row is still pending is a no-op. The `supersede` path is the only way to retire a pending row before it processes.

### Channel ↔ Role Decoupling on `discord_channel_mappings`

`discord_channel_mappings.discord_channel_id` is **nullable**. The migration `1747600000_decouple_channel_role.ts` drops `NOT NULL` and adds CHECK `discord_channel_id IS NOT NULL OR discord_role_id IS NOT NULL` plus a partial unique index on `(team_id, discord_channel_id) WHERE discord_channel_id IS NOT NULL`. Every domain schema that references this column uses `Schema.OptionFromNullOr(Discord.Snowflake)`.

`DiscordChannelMappingRepository` exposes **narrow** mutation methods. Each method touches exactly the columns its name implies — never use a fat upsert that nullifies unrelated columns:

| Method | Columns written | Used by |
|--------|----------------|---------|
| `insert(teamId, groupId, channelId, roleId)` | sets both ids | server (legacy paths still creating both atomically) |
| `insertRoleOnly(teamId, groupId, roleId)` | sets `discord_role_id`; `discord_channel_id` stays as-is | RPC `Channel/UpsertMappingRoleOnly` (bot calls during role-only provisioning) |
| `upsertGroupChannel(teamId, groupId, channelId)` | sets `discord_channel_id`; `discord_role_id` stays as-is | RPC `Channel/UpsertGroupChannel` (bot calls BEFORE creating role) AND server's manual "link existing channel" handler |
| `clearGroupChannel(teamId, groupId)` | sets `discord_channel_id = NULL`; `discord_role_id` stays as-is | Server's detach/archive paths, BEFORE emitting `channel_detached` / `channel_archived` |
| `deleteByGroupId(teamId, groupId)` | deletes the row | Server `Channel/DeleteMapping`; bot calls this only from `handleDeleted` |

Rules:

1. **Server owns clearing the channel id.** When detaching or archiving a group, the API handler calls `channelMappings.clearGroupChannel(teamId, groupId)` synchronously, then emits the event. The bot must never write `NULL` to `discord_channel_id` itself.
2. **Bot owns deleting the row.** Only the `channel_deleted` event triggers `Channel/DeleteMapping`. `channel_detached` and `channel_archived` keep the mapping (with cleared channel id) so the surviving role still resolves.
3. **`emitChannel{Deleted,Archived,Detached,Updated}` accept `discordChannelId: Option<Snowflake>` and `discordRoleId: Option<Snowflake>`.** Do not wrap the channel id in `Option.some(...)` at call sites — pass the mapping field through unchanged.
4. **`emitChannelCreated` accepts `discordChannelName?: string`.** Pass `undefined` when the group is configured for role-only provisioning (`settings.create_discord_channel_on_group = false`); the wire field decodes to `Option<string>` on the bot side and triggers the role-only branch in `handleCreated`.
5. **When checking "is this channel already linked?"** (e.g. in `LinkChannelToGroup`), filter mappings with `Option.isSome(m.discord_channel_id) && m.discord_channel_id.value === payload.discordChannelId`. The mapping may exist with `discord_channel_id = None` for a role-only group — that is not a conflict.

### Resolving identity fields on outbox reads

`*_sync_events` outbox tables (e.g. `event_sync_events`) are written once at emit-time and read once before being marked processed. When a sync event payload needs additional identity fields beyond the foreign-key id stored at emit-time (e.g. the claimer's `discord_id`, `nickname`, `display_name`, `username`), resolve them via `LEFT JOIN` inside the `findUnprocessed*Events` SELECT — **never** add new denormalised columns to the outbox table.

Rules:
1. The outbox row stores only the foreign-key id (e.g. `claimed_by_member_id`) — no denormalised name/handle columns
2. The `findUnprocessed*Events` query LEFT JOINs `team_members` and `users` and aliases the resolved columns to the names the row schema expects (e.g. `u.discord_id AS claimed_by_discord_id`)
3. Use `LEFT JOIN` (not `JOIN`) so events with no associated user (`claimed_by_member_id IS NULL`) still return one row with `Option.none()` identity fields
4. When a denormalised field already exists on the outbox table for legacy reasons, prefer `COALESCE(u.<col>, ese.<legacy_col>) AS <col>` so the JOIN can supersede stale snapshot data while still working when the user row is missing
5. The `EventSyncEventRow` schema lists every aliased column; `Schema.OptionFromNullOr` decodes nullable JOIN results to `Option`

Reference: `EventSyncEventsRepository.findUnprocessedEvents` resolves the claimer's `discord_id`, `name`, `nickname`, `display_name`, `username` from `users` via `team_members`.

### Discord Name Formatting

The **server** applies Discord name formatting before emitting sync events. The bot receives pre-formatted `discord_channel_name` and `discord_role_name` fields and uses them directly.

| Constant | Value | Location |
|----------|-------|----------|
| `DEFAULT_ROLE_FORMAT` | `{emoji} {name}` | `src/utils/applyDiscordFormat.ts` |
| `DEFAULT_CHANNEL_FORMAT` | `{emoji}│{name}` | `src/utils/applyDiscordFormat.ts` |

Format templates use `{emoji}` and `{name}` placeholders. The `applyDiscordFormat(template, name, emoji)` function handles missing emoji by stripping the placeholder and cleaning up leftover separators.

When emitting `channel_created`, `roster_channel_created`, or `channel_updated` events:

1. Load team settings via `teamSettings.findByTeamId(teamId)`
2. Resolve the channel format: `Option.match(settings, { onNone: () => DEFAULT_CHANNEL_FORMAT, onSome: (s) => s.discord_channel_format })`
3. Resolve the role format: same pattern with `discord_role_format`
4. Call `applyDiscordFormat(format, entityName, entityEmoji)` for both channel and role names
5. Pass the formatted names as `discordChannelName` and `discordRoleName` to the emit method
6. For entities with a `color` field (hex string like `#FF0000`), convert to Discord integer using `hexColorToDiscordInt` from `src/utils/hexColorToDiscordInt.ts` and pass as `discordRoleColor`

## Before/After State Detection in Upsert Handlers

When an RPC handler must detect whether an upsert changed meaningful state (e.g. "was this RSVP submitted after a reminder?"), read the prior record **before** the upsert and compare afterward:

```typescript
Effect.bind('priorRsvp', ({ member }) =>
  rsvps.findRsvpByEventAndMember(event_id, member.id),
),
Effect.tap(({ member }) =>
  rsvps.upsertRsvp(event_id, member.id, response, message),
),
Effect.let(
  'isLateRsvp',
  ({ event, priorRsvp }) =>
    Option.isSome(event.reminder_sent_at) &&
    (Option.isNone(priorRsvp) ||
      Option.exists(priorRsvp, (r) => r.response !== response)),
),
```

Rules:
1. Always `Effect.bind` the prior state **before** the `Effect.tap` that performs the upsert
2. Use `Option.isNone` to detect first-time inserts vs `Option.exists` to detect changed values
3. Derive the boolean in an `Effect.let` after the upsert so the write is not conditional on the check

## Cron Jobs

Cron jobs are long-running Effects that repeat on a schedule. Each cron is defined in `src/services/` and wired as a concurrent fiber in `run.ts`.

| Cron | File | Schedule | Purpose |
|------|------|----------|---------|
| `AgeCheckCron` | `src/services/AgeCheckCron.ts` | daily | Check member age thresholds |
| `EventHorizonCron` | `src/services/EventHorizonCron.ts` | daily 03:00 UTC | Generate recurring events from series, emit Discord sync events |
| `RsvpReminderCron` | `src/services/RsvpReminderCron.ts` | every minute | Send RSVP reminder sync events |
| `TrainingAutoLogCron` | `src/services/TrainingAutoLogCron.ts` | every 5 minutes | Auto-log ended trainings |
| `EventStartCron` | `src/services/EventStartCron.ts` | every minute | Mark active events as `started` when `start_at <= NOW()`, emit `event_started` sync events |
| `WeeklySummaryCron` | `src/services/WeeklySummaryCron.ts` | every minute (gated to Sun 20:00 in team timezone) | Build a per-team weekly digest and insert one `weekly_summary_sync_events` row per team-week |
| `PaymentReminderCron` | `src/services/PaymentReminderCron.ts` | every minute | For each unpaid fee assignment whose `effective_due_at` matches a `PaymentReminderKind` offset (−3 / 0 / +3 / +10 / +21 days in team timezone), insert one `payment_reminder_sync_events` row. Idempotency lives in `FeeAssignmentsRepository.findReminderCandidates` (NOT EXISTS against both `payment_reminders_sent` and the outbox) — see "Bot-Ack Idempotency for Discord-Side-Effect Crons" below. |

### Pattern

```typescript
// 1. Define the single-cycle effect (exported for unit testing)
export const myCronEffect = Effect.Do.pipe(
  Effect.bind('repo', () => MyRepository),
  // ... business logic ...
  Effect.asVoid,
  withCronMetrics('my-cron'),
);

// 2. Define the repeating cron (exported for run.ts)
const cronSchedule = Schedule.cron('*/5 * * * *');
export const MyCron = myCronEffect.pipe(Effect.repeat(cronSchedule), Effect.asVoid);
```

Key rules:
1. Export the single-cycle effect (e.g. `eventStartCronEffect`) separately from the repeating cron (e.g. `EventStartCron`) so unit tests can run one cycle without waiting for the schedule
2. Each cron gets its own repository layer in `run.ts` and runs as a separate concurrent fiber
3. Always wrap with `withCronMetrics('name')` for observability

### Per-Item Error Isolation

When a cron iterates over a batch (events, members, etc.) and processes each item independently, **isolate failures per item** so one bad row does not poison the rest of the cycle. Wrap each item's effect with `Effect.tapError` (to log) followed by `Effect.exit` (to convert any failure or defect into a successful `Exit`). Used by `RsvpReminderCron` and `EventStartCron`:

```typescript
Effect.all(
  Array.map(events, (event) =>
    processEvent(event).pipe(
      Effect.tapError((e) =>
        Effect.logWarning(`MyCron: failed for event ${event.id}`, e),
      ),
      Effect.exit,
    ),
  ),
  { concurrency: 1 },
)
```

Use `Effect.exit` (not `Effect.either`) — `Effect.either` is not exported in the Effect 4 beta used by this repo, and `Effect.exit` additionally catches defects.

### Timezone-Aware Firing Time

A cron whose business rule is "fire on a specific local time per team" (e.g. "Sunday 20:00 in `team_settings.timezone`") has two valid gating strategies. Pick one per cron; do not mix them.

| Strategy | When to use | Reference |
|----------|-------------|-----------|
| **SQL-side** (`AT TIME ZONE ts.timezone` inside the `WHERE` clause) | The cron's trigger is **per-row** and the row already lives in a table joined to `team_settings`. The query returns only rows whose owning team is currently inside the firing window. | `RsvpReminderCron` → `TeamSettingsRepository.findEventsNeedingReminder` |
| **TS-side** (`Intl.DateTimeFormat` over each team's IANA timezone, inside the cron's per-team loop) | The cron's trigger is **per-team** (one row per team per cycle), so there is no per-row JOIN to gate in SQL. The cron loads `team_settings` for every team that opted in, then short-circuits per team when the local time does not match. | `WeeklySummaryCron.isSunday20InTimezone` |

Rules for the TS-side variant:

1. **Wire the cron at `Schedule.cron('* * * * *')` (every minute)** and gate inside the per-team `Effect.tap`. Do not try to encode a weekly cron pattern — DST and per-team timezones make a single CRON expression incorrect.
2. **Define the gate as a pure helper** (signature `(nowMs: number, timezone: string) => boolean`) that calls `new Intl.DateTimeFormat('en-CA', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })` and reads `weekday`/`hour`/`minute` from `formatToParts(...)`. Keep it module-local — do not export.
3. **The gate's hour/minute comparison must be exact** (`hour === 20 && minute === 0`) and the second must be range-checked (`second <= 59`) so a one-minute-cadence cron fires exactly once per team-week. Do not use `hour >= 20` — that fires every minute for the next four hours.
4. **Wrap the `Intl.DateTimeFormat` call in `try { ... } catch { return false }`** — an unknown IANA zone in `team_settings.timezone` is a misconfiguration, not a cron failure. The bad team is skipped silently this cycle.
5. **Skip via `Effect.fail(new SkipTeam(...))`** (a module-local `Data.TaggedError`) and `Effect.catchTag('SkipTeam', () => Effect.void)` at the per-team boundary. Do not use `Effect.when` — the gate is one of several short-circuit filters and the tagged-skip pattern keeps the chain readable.

## Bot-Ack Idempotency for Discord-Side-Effect Crons

Some crons fan out a one-shot Discord side effect per row (e.g. payment reminders DM'd to a user). The "did we already do this?" signal cannot be derived from the source row alone — it lives on a dedicated **`<resource>_sent` log table** that is written **only after the bot acknowledges delivery**, not when the outbox row is emitted. This makes cycles safe against overlapping ticks, server crashes, and bot retries.

Reference implementation: `PaymentReminderCron` + `payment_reminder_sync_events` (outbox) + `payment_reminders_sent` (delivery log) + `Finance/MarkReminderSent` RPC.

| Table | Purpose | Written by |
|-------|---------|-----------|
| `<resource>_sync_events` | Outbox — one row per pending delivery. `processed_at IS NULL` rows are visible to the bot poll. | Cron `emit(...)` on each cycle. |
| `<resource>_sent` | Delivery log — `PRIMARY KEY (<ref_id>, <kind>)`. Existence of a row means "the bot has confirmed delivery". | Bot calls `Finance/MarkReminderSent` (or analogous) AFTER the Discord call succeeds. The server handler does `INSERT ... ON CONFLICT DO NOTHING`. |

### Candidate Query Contract

The cron's candidate query MUST filter out both states with two `NOT EXISTS` clauses on the same `(ref_id, kind)` natural key:

```sql
AND NOT EXISTS (
  SELECT 1 FROM payment_reminders_sent prs
  WHERE prs.assignment_id = c.assignment_id AND prs.kind = c.kind
)
AND NOT EXISTS (
  SELECT 1 FROM payment_reminder_sync_events prse
  WHERE prse.assignment_id = c.assignment_id
    AND prse.kind = c.kind
    AND prse.processed_at IS NULL
)
```

The first guard prevents re-emission after a successful delivery. The second guard prevents double-emit when two cron ticks overlap (or one is mid-cycle while the bot has not yet acked) — once a row is in the outbox unprocessed, no new row is enqueued for the same `(ref_id, kind)`.

### Rules

1. **The `<resource>_sent` table is keyed by the natural delivery identity** (`PRIMARY KEY (assignment_id, kind)` in the reference), not by a synthetic id. The bot's mark-sent RPC must `INSERT ... ON CONFLICT DO NOTHING` so duplicate acks (e.g. bot retry after server timeout) become no-ops.
2. **The bot calls `<Resource>/MarkSent` AFTER the Discord call returns success**, not before. If the Discord call fails, the bot falls back to `<Resource>/MarkPaymentReminderFailed` on the outbox row — `<resource>_sent` is NOT written, and the next cron tick will re-emit once the outbox row is marked processed/failed.
3. **The outbox UPDATE statements (`markProcessed`, `markFailed`) MUST include `AND processed_at IS NULL` in the WHERE clause.** This makes ack idempotent — duplicate `MarkProcessed` / `MarkFailed` calls from retried bot polls become no-ops rather than rewriting the `processed_at` timestamp.
4. **`emit` is called inside the cron's per-candidate loop with `Effect.exit` for per-item error isolation** (see "Per-Item Error Isolation" above) — one bad row never poisons the rest of the cycle.
5. **Never write to `<resource>_sent` from the cron or from any server-side path.** It is exclusively bot-driven. A row in `<resource>_sent` is the only durable proof that Discord actually accepted the message; promoting the cron to write it would re-introduce the "we think we sent it but Discord never got it" bug class.

## iCal Feed Generation (`src/api/ical.ts`)

The `getICalFeed` endpoint builds a single `VCALENDAR` containing both user events and payment-due VEVENTs. Every interpolated user-supplied string MUST pass through `escapeICalText` defined at the top of `src/api/ical.ts`:

```typescript
const escapeICalText = (text: string): string =>
  text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
```

Rules:

1. **Escape every dynamic value placed into `SUMMARY`, `DESCRIPTION`, `LOCATION`, `CALNAME`, or `X-WR-CALNAME`** — names, currencies, fee names, team names, free-text descriptions, all come from user input and can contain `,` `;` `\n` `\\` which break the iCal parser.
2. **Order of replacements matters.** Escape `\\` first, then `;` `,` `\n` — reversing the order would re-escape the backslashes added by the later replacements.
3. **`UID` values are server-generated** (`payment-${assignment_id}@sideline`, `${event_id}@sideline`) — never interpolate user input into `UID`. The UUID/event-id source guarantees no special characters.
4. **DTSTART/DTEND `VALUE=DATE` for payments use the team's IANA timezone** (`team_timezone` from `team_settings`, defaulting to `'UTC'`). Use `Intl.DateTimeFormat('en-CA', { timeZone })` to compute the local `YYYYMMDD` so a payment due "Friday in Prague" renders on Friday even for users whose calendar app is in Sydney.
5. **Skip rules for payment VEVENTs** live in `buildPaymentVEvents`: skip rows where `computed_status === 'paid'` or `stored_status === 'waived'`, and skip rows whose `effective_due_at` is older than the 180-day `HISTORY_CAP_MS` window. Do not relax these — older paid/waived items would bloat every refresh of every subscriber's calendar.

## Outbox With Opaque JSONB Payload

Most `*_sync_events` tables expand the payload into named columns on the row (e.g. `event_sync_events.title`, `event_sync_events.start_at`) and decode them via the row schema. This is the right default — the SQL planner can index/filter on individual fields, and bot handlers receive typed RPC events.

When the payload is a **rendered presentation artefact** that the consumer treats as opaque (e.g. a digest object built by the server and posted verbatim to Discord by the bot), an alternative is valid: store the payload as a single `payload JSONB NOT NULL DEFAULT '{}'` column and validate it against a **shared `Schema.Class` defined once in `packages/domain/`** (e.g. `WeeklySummary.WeeklySummaryDigest`).

Rules:

1. **The shared payload schema lives in `packages/domain/src/models/`** and is exported from `packages/domain/src/index.ts`. Both processes import the same symbol — there is no second source of truth.
2. **Server encodes once on emit** with `Schema.encodeSync(SharedSchema)(value)` and inserts the result via `${JSON.stringify(payload)}::jsonb`. Do not pass the un-encoded class instance to the SQL bind — `jsonb` requires a JSON string.
3. **Bot decodes once on consume** with `Schema.decodeUnknownEffect(SharedSchema)(event.payload)` inside the handler. Decode failures must be mapped to a real error (not swallowed) so the outbox retries / exhausts via the standard `attempts`-counted path. See `applications/bot/src/rcp/weeklySummary/handleWeeklySummaryReady.ts`.
4. **The RPC event schema uses `payload: Schema.Unknown`** (e.g. `WeeklySummaryRpcEvents.WeeklySummaryReadyEvent`). Do not duplicate the digest's fields on the RPC event — the consumer must always decode against the shared schema to get typed access.
5. **Never read individual payload fields in SQL** (`payload->>'foo'`). The opaque-payload contract is "the row is a delivery envelope; the body is the consumer's concern". If a field needs to be queried, promote it to a real column on the outbox table.

### `delivered_at` Separate From `processed_at`

When the outbox represents a one-shot delivery (post a message to Discord; no follow-up state) and the operator must distinguish "we stopped retrying" from "the message actually reached the user", add a `delivered_at TIMESTAMPTZ` column alongside `processed_at`:

| Column | Set by | Meaning |
|--------|--------|---------|
| `processed_at` | `markProcessed` (success) **and** `markFailed` (when `attempts + 1 >= maxAttempts`) | Row no longer eligible for polling. |
| `delivered_at` | `markProcessed` only, with `Option<DateTime.Utc>` from the bot's success-time | The Discord call actually succeeded. `NULL` after max-attempts exhaustion. |

Rules:

1. **`processed_at IS NOT NULL AND delivered_at IS NULL`** is the audit signal for "we gave up after N retries". Operators query this to detect persistently broken teams/channels.
2. **Add a partial index `WHERE delivered_at IS NOT NULL`** (see `idx_wsse_delivered`) when callers need to answer "did team X get its digest for week Y?" — this is the predicate of the `hasDeliveredSummaryForWeek` query.
3. **The `markProcessed` RPC payload carries `deliveredAt: DateTime.Utc`** (set by the bot to `DateTime.nowUnsafe()` immediately after the Discord call returns). Do not let the server fill it in — only the bot knows whether delivery succeeded.
4. Only use this pattern when "delivered" has a clear, single meaning. For multi-stage outboxes (e.g. channel sync, which emits, creates, then later updates) keep the existing two-RPC / `attempts`-counted patterns documented above.

## Per-User/Team Preferences (`(user_id, team_id)` JSONB Row)

Per-user, per-team UI preferences that have no cross-row relationships (e.g. dashboard widget layout, future notification mute lists, future sidebar collapse state) live in a dedicated table keyed by the composite `PRIMARY KEY (user_id, team_id)`, with the preference body stored as a single `JSONB NOT NULL` column. Both ids are `ON DELETE CASCADE` so removing a user or a team automatically purges the row.

Reference implementation: `dashboard_layouts` table (migration `1787400000_create_dashboard_layouts.ts`) + `DashboardLayoutsRepository` (`findByUserTeam` + `upsert`) + `src/api/dashboard-layout.ts`.

### Schema Shape

```sql
CREATE TABLE <resource>_preferences (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  <body>  JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, team_id)
)
```

### Rules

1. **The composite primary key is `(user_id, team_id)` — never add a synthetic `id UUID`.** The natural key uniquely identifies the row; a surrogate would only invite ambiguous `findById` lookups.
2. **Reads return `Option<Body>`; the "no row yet" case is a defaulted-on-the-server response, never a 404.** The API handler resolves `Option.none()` to a `DEFAULT_*` value defined in the handler module (see `DEFAULT_LAYOUT` in `src/api/dashboard-layout.ts`). The client never distinguishes "never saved" from "saved as default".
3. **Writes use `INSERT ... ON CONFLICT (user_id, team_id) DO UPDATE SET <body> = EXCLUDED.<body>, updated_at = now() RETURNING <body>`** through `SqlSchema.findOne` — there is no separate `insert` / `update`. The handler upserts unconditionally.
4. **Pre-encode the JSONB column to a string** with `JSON.stringify(...)` and bind via `${input.body_json}::jsonb`. Do not pass the un-encoded class instance — `jsonb` requires a JSON string. Node-pg automatically parses JSONB columns back to JS objects on read, so the row schema uses `Schema.Array(Widget)` (or `Schema.Struct`) directly with no `Schema.parseJson` wrapper.
5. **Authorization is `requireMembership(...)`, not `requirePermission(...)`.** A preference is caller-scoped data — every team member may CRUD their own row regardless of permissions. Never accept a `userId` from the URL or payload — bind it from `Auth.CurrentUserContext` so a member cannot read or overwrite another member's preferences.

## Server-Side Normalization Of Stored Preference Payloads

When a JSONB preference payload references domain literals that may grow over time (e.g. `DashboardWidgetId` adds a new widget; a notification-mute set adds a new channel kind), the server MUST run a **`normalize` pure function on BOTH read and write** that (1) drops unknown ids, (2) dedupes repeated ids, (3) appends any missing canonical ids with a sensible default in a fixed canonical order. The function lives next to the API handler (e.g. `normalizeWidgets` in `src/api/dashboard-layout.ts`) and is unit-tested independently.

```typescript
export const normalizeWidgets = (
  input: ReadonlyArray<DashboardLayoutApi.DashboardWidget>,
): ReadonlyArray<DashboardLayoutApi.DashboardWidget> => {
  const validIds = new Set(DashboardLayoutApi.DASHBOARD_WIDGET_ORDER);
  const seen = new Set<DashboardLayoutApi.DashboardWidgetId>();
  const result: DashboardLayoutApi.DashboardWidget[] = [];

  for (const widget of input) {
    if (!validIds.has(widget.id)) continue; // drop unknown (stale literal)
    if (seen.has(widget.id)) continue;       // dedupe
    seen.add(widget.id);
    result.push(widget);
  }
  for (const id of DashboardLayoutApi.DASHBOARD_WIDGET_ORDER) {
    if (!seen.has(id)) result.push(new DashboardLayoutApi.DashboardWidget({ id, visible: true }));
  }
  return result;
};
```

Rules:

1. **Run `normalize` on the GET handler's mapped result** (after `Option.match` resolves the row) AND on the PUT handler before `upsert(...)` — never trust the stored payload OR the client payload. A row written by an old server version may contain stale ids; a client built against an old domain schema may omit new ids.
2. **The canonical id order is a `const`-tuple exported from `packages/domain/`** (e.g. `DASHBOARD_WIDGET_ORDER`). The normalizer iterates that tuple to append missing entries; the order is the client's default display order.
3. **"Missing" entries are appended as visible/enabled by default,** not hidden — a user who upgrades to a version that adds a new widget sees it without opening settings. Hiding-by-default would orphan new features behind discovery.
4. **The normalizer is a pure synchronous function** (no `Effect`, no DB access). Place it in the handler file alongside the route definitions and export it for unit testing. Unit test the four cases: drop-unknown, dedupe, append-missing, preserve-existing-order.
5. **Do not version the stored payload** (`{ version: 1, widgets: [...] }`). The normalizer makes the payload schema self-healing — a forward/backward-compatible literal set is cheaper than a migration on every additive change.

## Team Provisioning: `provisionNewTeam(...)` Helper

The single source of truth for "create a team row + seed roles + add the creator as Admin" is `src/utils/provisionNewTeam.ts`. Both `auth.createTeam` (legacy, deprecated) and `onboarding.completeOnboarding` (new) delegate to this helper. Never re-implement the team-creation steps inline in a new handler — always go through `provisionNewTeam`.

### Contract

```typescript
provisionNewTeam({
  payload: ProvisionNewTeamPayload, // name, guildId, description, sport, logoUrl,
                                    // welcomeChannelId, systemLogChannelId, onboardingLocale
  currentUserId: User.UserId,
  markConsumed?: (teamId: Team.TeamId) => Effect.Effect<Option.Option<unknown>, never, never>,
}): Effect.Effect<
  Auth.UserTeam,
  MemberAlreadyExistsError | OnboardingApi.OnboardingTokenAlreadyConsumed, // ← `OnboardingTokenAlreadyConsumed` only when `markConsumed` is provided
  TeamsRepository | RolesRepository | TeamMembersRepository | SqlClient.SqlClient
>
```

What the helper does, in a single `sql.withTransaction(...)`:

1. `teams.insert(...)` — creates the row with `onboarding_sync_status = 'pending'`, `onboarding_synced_at = None`, all other onboarding fields defaulted to `None`.
2. `roles.seedTeamRolesWithPermissions(team.id)` — seeds all built-in roles (Admin / Captain / Treasurer / Player).
3. `members.addMember({ team_id, user_id: currentUserId, active: true })` — adds the creator as a member.
4. `members.assignRole(newMember.id, adminRole.id)` — grants the creator the Admin role.
5. If `markConsumed` is provided, calls it as the **last step inside the transaction**. The callback returns `Effect<Option<unknown>>` — `Option.none` means the precondition failed (token already consumed/revoked by a concurrent caller); the helper then fails with `OnboardingApi.OnboardingTokenAlreadyConsumed` and the entire transaction is rolled back.

### Rules

1. **Use `provisionNewTeam` for every code path that creates a new team.** Inline-reimplementing the four steps above (insert team / seed roles / add member / assign Admin) is forbidden — it duplicates the transaction boundary and the Admin-role discovery logic.
2. **Pass `markConsumed` only when the caller owns a token / acceptance row that must be atomically consumed with the team creation.** `OnboardingApiLive.completeOnboarding` passes a closure that calls `tokens.markConsumed(validToken.id, { consumed_by, resulting_team_id: teamId })`. The legacy `auth.createTeam` omits `markConsumed` entirely — its overload narrows the error union back to `MemberAlreadyExistsError` only.
3. **The `markConsumed` callback MUST return `Option<unknown>`** (`Some` = won the race, `None` = lost). Returning `Effect.fail` from inside the callback bypasses the helper's `OnboardingTokenAlreadyConsumed` mapping and surfaces an opaque defect — always express precondition-failure as `Option.none`.
4. **Pre-flight checks belong in the handler, not the helper.** The handler validates the token state, checks `bound_discord_id` matches the caller, and checks `findByGuildId(guildId)` is `None` before calling `provisionNewTeam`. The helper only owns the transactional create + token-consume.
5. **`SqlErrors.catchUniqueViolation(...)` belongs at the call site,** not in the helper — different callers map the unique-violation defect to different domain errors (e.g. `OnboardingGuildAlreadyClaimed` from the onboarding endpoint). The helper itself never catches unique violations.

Reference: `applications/server/src/utils/provisionNewTeam.ts`, `applications/server/src/api/onboarding.ts` (`completeOnboarding`), `applications/server/src/api/auth.ts` (`createTeam`, deprecated).

## Token-Hash-At-Rest For Capability URLs

Single-use capability tokens that travel in a URL path (e.g. `team_onboarding_tokens.token_hash`) MUST be stored as a SHA-256 hex digest of the plaintext, never as the plaintext itself. The plaintext is generated once with `crypto.randomBytes(32).toString('base64url')`, returned to the operator exactly once at mint time, and never persisted server-side.

Reference: `applications/server/src/utils/onboardingToken.ts` (`generateOnboardingToken` + `hashToken`) and `TeamOnboardingTokensRepository` (`token_hash` column, `findByHash` lookup).

### Rules

1. **The repository stores `token_hash`, never `token`.** Every lookup is via `findByHash(hashToken(plaintext))` — there is no `findByPlaintext` method. A DB leak exposes hashes, not redeemable URLs.
2. **`generateOnboardingToken()` returns `{ token, hash }` exactly once.** The handler inserts the hash, builds the onboarding URL with the plaintext, returns the URL in the response, and lets the plaintext drop out of memory. Never log the plaintext.
3. **Use 256 bits of entropy** (`randomBytes(32)` → 43 base64url chars). Do not shorten — the URL is the only credential, and the hash collision space must be cryptographically large.
4. **The hash is deterministic SHA-256, not bcrypt/argon2.** Capability tokens have full entropy and short lifetimes, so a fast hash is correct — the threat model is "leaked DB dump" (defeated by hashing at all), not "low-entropy password" (which is what slow hashes defend against).
5. **Use `Schema.String` (not the plaintext-token type) for the `:plaintextToken` URL param.** Validation is "does `findByHash` return `Some`?", not a regex on the URL segment — leaking the format constraints would help attackers narrow brute-force attempts.

## Hand-written INSERT / UPDATE Column Lists

`SqlSchema.findOne({ Request: Model.insert, ... })` validates the **input shape**, but the column list and `VALUES (...)` tuple inside the raw `sql\`INSERT INTO ... \`` template are hand-written. The schema does **not** cross-check that every field on the `insert` variant appears in the SQL — fields present on the schema but absent from the column list are silently dropped at write time and the query still succeeds (returning the row with the DB default / NULL for the missing column).

This footgun bit `TeamsRepository.insert` once already: `welcome_channel_id` was added to `Team.Team.insert` and the API handler, but the column list still read `(name, guild_id, description, sport, logo_url, created_by)` — every team created post-migration had `welcome_channel_id = NULL` despite the caller passing a value. Fix: extend both the column list and `VALUES` tuple in the same edit.

Current state of `TeamsRepository.insertQuery` column list: all 16 non-generated columns are now persisted at INSERT time — `name`, `guild_id`, `description`, `sport`, `logo_url`, `created_by`, `welcome_channel_id`, `system_log_channel_id`, `welcome_message_template`, `rules_channel_id`, `overview_channel_id`, `achievement_channel_id`, `onboarding_rules_role_id`, `onboarding_rules_prompt_id`, `onboarding_locale`, `onboarding_sync_status`. (`created_at`/`updated_at` keep DB defaults; `id` is generated; `onboarding_synced_at`/`onboarding_sync_error` default to NULL.) The 16-column round-trip is verified by an integration test in `TeamsRepository.test.ts`.

Rules when adding a new column to a `Model.Class` that is INSERTed via hand-written SQL:

1. **Grep for every hand-written `INSERT INTO <table>` in `src/repositories/`** and add the new column to both the column list and the `VALUES (...)` tuple. `SqlSchema` does not catch the mismatch.
2. **Do the same for hand-written `UPDATE <table> SET ...`** statements that take a typed `Request` schema. A new field on the request schema is not auto-applied to the SET clause.
3. **Prefer `Model.makeRepository(...)` `insert` / `update`** when the operation maps 1:1 to the model — it derives the column list from the schema and cannot drift. Use hand-written SQL only when the operation needs JOINs, `ON CONFLICT`, `RETURNING` of computed columns, or partial column updates.
4. **Add an integration test that round-trips the new field** through the repository — read the inserted row back and assert the new column equals the input. This is the only mechanism that catches the silent-drop bug.

## Stable Tiebreaker On Timestamp ORDER BY

Repository queries that `ORDER BY` a `TIMESTAMPTZ` column whose value is **user-editable** (i.e. not a server-set `created_at` that uses `clock_timestamp()`) MUST append the primary key as a deterministic tiebreaker on the same direction: `ORDER BY al.logged_at, al.id` (or `ORDER BY al.logged_at DESC, al.id DESC`). Two rows with the same wire-format date land on the same anchored UTC timestamp (see `packages/domain/AGENTS.md` → "Wire-Format Date-String Helpers"), so without a tiebreaker the row order is non-deterministic and page-to-page navigation can show the same row twice or skip it.

Reference: `ActivityLogsRepository._listByMember` (`ORDER BY al.logged_at, al.id`) and `_listRecent` (`ORDER BY al.logged_at DESC, al.id DESC`). `EventRsvpsRepository.listByEventOrdered` (`ORDER BY CASE r.response WHEN ... END ASC, r.created_at ASC, r.id ASC`) is the equivalent for a multi-key sort.

Rules:

1. **Always include `id` as the final ORDER BY key whenever the leading key is a user-editable timestamp or a value with low cardinality** (status enums, response enums). For server-only `created_at`/`updated_at` columns the tiebreaker is optional — two rows inserted in the same microsecond is implausible — but adding it is harmless and future-proofs the query against backfill scripts that may set identical timestamps.
2. **The tiebreaker direction must match the leading key's direction.** `ORDER BY logged_at DESC, id DESC` (not `id ASC`) so the most recent row with the same timestamp is consistently first on every page. Mixing directions across keys breaks the "lexicographic over keys" intuition operators rely on when paginating.
3. **Do not introduce a new server-generated tiebreaker column** (e.g. a `sequence_no SERIAL`) to solve this — the `id UUID` column already provides a stable order, and a UUID's natural ordering is fine for a tiebreaker (it is consistent within a single query plan; the absolute order between two UUIDs is not semantically meaningful and never should be relied on by callers).
4. **Migration is silent.** Adding a tiebreaker to an existing ORDER BY only narrows the previously-undefined order — it never changes a previously-defined order. No data backfill is needed.

## Postgres Type Conventions

- **`TIME` columns** — node-postgres returns `'HH:MM:SS'`. If consumers expect `'HH:MM'`, normalize on read with `TO_CHAR(col, 'HH24:MI') AS col` in both `SELECT` and `RETURNING` clauses (see `TeamSettingsRepository._findByTeam`).
- **`sql` template tag** — interpolated values become bind parameters, never SQL fragments. To pass "now" into a query, pass a real `Date` (or its ISO string) and cast in SQL (`${nowIso}::timestamptz`); never interpolate the literal string `'NOW()'` — it becomes a bound text value, not a function call.

## Team-Scoped Resources With Global Rows

Some resource tables hold both **global** rows (shared across every team) and **team-specific** rows in the same table, distinguished by `team_id`:

| Value | Meaning |
|-------|---------|
| `team_id IS NULL` | Global / built-in row. Immutable from the HTTP API — never UPDATE or DELETE. Seeded by migrations. |
| `team_id = <teamId>` | Team-specific row. Owned by that team; the team's captains may CRUD it. |

Reference implementation: `activity_types` (see `ActivityTypesRepository`, `src/api/activity-type.ts`, migration `1781000000_activity_type_metadata.ts`).

Rules:

1. **Case-insensitive name uniqueness is enforced per scope** via two partial unique indexes:
   ```sql
   CREATE UNIQUE INDEX idx_<table>_global_lower_name ON <table> (LOWER(name)) WHERE team_id IS NULL;
   CREATE UNIQUE INDEX idx_<table>_team_lower_name   ON <table> (team_id, LOWER(name)) WHERE team_id IS NOT NULL;
   ```
   The team-scoped uniqueness check helper (`findByNameInScope(name, teamId)`) returns the first row matching `LOWER(name) = LOWER($1) AND (team_id IS NULL OR team_id = $2)` so a team cannot create a row whose name shadows a global row or another team-row of theirs. Always trim the name before the lookup AND before the insert/update.
2. **Tenant isolation reads use `findByIdScoped(id, teamId)`**, which filters `id = $1 AND (team_id IS NULL OR team_id = $2)`. Never expose a bare `findById` to API handlers — that would let team A read or reference team B's row by guessing the id. `findById` (no scope) is reserved for internal lookups that have already authenticated the resource owner.
3. **Mutation methods must include `team_id` in the `WHERE` clause** to prevent cross-tenant writes:
   ```sql
   UPDATE activity_types SET ... WHERE id = ${id} AND team_id = ${teamId} AND team_id IS NOT NULL
   DELETE FROM activity_types        WHERE id = ${id} AND team_id = ${teamId} AND team_id IS NOT NULL
   ```
   The trailing `team_id IS NOT NULL` guard is what prevents a captain from accidentally clobbering a global row even if they pass a global row's id — the API layer's `Protected` check (see below) is the primary defence; the SQL guard is defence-in-depth.
4. **List queries return both scopes in one call**, sorted globals-first: `WHERE team_id IS NULL OR team_id = $1 ORDER BY (team_id IS NULL) DESC, LOWER(name) ASC`. Do not run two queries and merge in TS.
5. **Catch the unique-violation defect** from the unique indexes with `SqlErrors.catchUniqueViolation(() => new <Resource>NameAlreadyTakenError())` on `insertCustom` / `updateCustom`. The pre-check via `findByNameInScope` handles the happy path; the catch handles the race-condition path.

## Cross-Tenant Resource Lookups (JOIN Through Team Scope)

When a resource id is exposed in a URL path (`/teams/:teamId/.../:resourceId`) but the resource table does **not** carry a `team_id` column directly (e.g. `payments` only has `fee_assignment_id`, which reaches `team_id` via `fee_assignments → fees → team_id`), the repository MUST expose a `findActive<Resource>ByIdAndTeam(id, teamId)` variant that JOINs through to the team scope and only returns the row when `f.team_id = ${teamId}`.

Reference: `PaymentsRepository.findActiveByIdAndTeam` joins `payments → fee_assignments → fees` and filters `WHERE p.id = ${id} AND p.voided_at IS NULL AND f.team_id = ${team_id}`.

Rules:

1. **Never use a bare `findById(id)` inside an HTTP handler when the URL also carries a `teamId`.** A handler that fetches by id alone and then asserts `row.team_id === teamId` in TypeScript only works for tables that store `team_id` directly. For transitively-scoped tables, the assertion is impossible without an extra round-trip — the JOIN-based `findByIdAndTeam` is the only correct shape.
2. **Return `Option<Row>` and treat `None` as 404.** The handler must not distinguish "row does not exist" from "row exists but belongs to another team" — both responses are 404. Leaking existence information by returning a different error for cross-tenant lookups is the bug this pattern prevents.
3. **The JOIN must filter on the scope column with `=`, never with `IN (...)`.** Each request has exactly one `teamId` from the path; do not accept arrays.
4. **For directly-scoped tables (the resource table itself has `team_id`)**, the equivalent is `findByIdScoped(id, teamId)` with `WHERE id = $1 AND team_id = $2` — see the "Team-Scoped Resources With Global Rows" section above. Use whichever variant matches the table's schema; never expose a bare `findById` to handlers.
5. **Bulk-insert / batch operations must apply the same scope inside SQL.** Example: `FeeAssignmentsRepository.bulkInsert` filters candidate members via `JOIN team_members tm ON tm.id = v.member_id JOIN fees f ON f.id = ${feeId} WHERE tm.team_id = f.team_id` — a member id supplied by the caller that belongs to a different team is silently dropped by the JOIN, never inserted.

## HTTP API Error Tags: `Forbidden` vs `Protected` vs `<Resource>NotFound`

Use three distinct tagged errors at the HTTP-API layer when a write may be rejected for different reasons. Do not collapse them into one error.

| Tag | HTTP status | Meaning | Example trigger |
|-----|-------------|---------|-----------------|
| `<Resource>Forbidden` | 403 | Caller lacks the required permission on this team. | Member without `activity-type:create` calling create. |
| `<Resource>Protected` | 422 | Caller has permission, but the **target row is immutable** (e.g. global / built-in). | Captain trying to edit a row with `team_id IS NULL`. |
| `<Resource>NotFound` | 404 | The row does not exist, or exists but is not visible to this team. | `findByIdScoped` returns `None`. |

Reference: `packages/domain/src/api/ActivityTypeApi.ts` defines `Forbidden` (403), `ActivityTypeProtected` (422), `ActivityTypeNotFound` (404), `ActivityTypeNameAlreadyTaken` (409), `ActivityTypeHasLogs` (409).

Rules:

1. **Order checks: permission → existence → mutability → business rules.** A member without permission must receive 403 regardless of whether the target row exists — never leak existence information by returning 404 before the permission check.
2. **Detect "immutable target" by `Option.isNone(row.team_id)`** after `findByIdScoped` resolves; fail with `<Resource>Protected`. Do not encode immutability into the SQL `WHERE` clause alone — the API needs to return a distinct error so the client can render the correct UI ("This is built-in and cannot be edited" vs "You don't have permission").
3. **`<Resource>NameAlreadyTaken` is 409, `<Resource>HasLogs` (and similar referential-integrity blockers) is 409.** Validation errors that the caller can fix by changing the payload are 409, not 422 — 422 is reserved for "the target row's class forbids this operation".

## Caller-Scoped Reads: Membership-Gated Without `requirePermission`

Some HTTP endpoints return data **about the caller** rather than about an arbitrary resource — e.g. "my fee assignment status", "my payment history". These endpoints intentionally bypass the team-permission system so that every member can read their own data without being granted a `finance:view` (or analogous) permission.

| Endpoint | Path | Auth chain |
|----------|------|-----------|
| `myStatus` | `GET /teams/:teamId/finance/status` | `requireMembership(...)` only |
| `myPaymentHistory` | `GET /teams/:teamId/finance/my-payments` | `requireMembership(...)` only |

### Handler Shape

```typescript
.handle('myPaymentHistory', ({ params: { teamId }, query }) =>
  Effect.Do.pipe(
    Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
    Effect.bind('membership', ({ currentUser }) =>
      requireMembership(members, teamId, currentUser.id, forbidden),
    ),
    Effect.bind('list', ({ membership }) =>
      payments.listByTeam(teamId, {
        memberId: Option.some(membership.id), // ← scope HARDCODED to caller's membership
        feeId: query.feeId,
        from: Option.none(),
        to: Option.none(),
        includeVoided: true,
      }),
    ),
    Effect.map(({ list }) => Array.map(list, toPaymentView)),
  ),
)
```

Rules:

1. **No `requirePermission` call.** The endpoint name MUST start with `my` (`myStatus`, `myPaymentHistory`, future `myAttendance`, etc.). The naming is the contract — a reviewer scanning the handler sees `my*` and knows the data is caller-scoped.
2. **The repository query MUST be scoped to `membership.id`,** not to the caller-supplied `query`/`payload`. Never accept a `memberId` from the request body or URL — that would let a member read another member's data with a forged id. The example above passes `memberId: Option.some(membership.id)` directly from the bound membership.
3. **Reuse the team-scoped repository method** (`payments.listByTeam`, `assignments.findByTeamMember`, etc.) rather than adding a `findByMyMember` variant. The pre-existing method already filters by `teamId`; the `memberId` argument restricts it further to the caller.
4. **The 403 error is `FinanceForbidden` (or analogous) with the message "not a member of this team",** not "missing permission". The only failure mode here is "caller is not a member" — `requireMembership` returns the membership row or fails with `forbidden`.
5. **Document the endpoint in `docs/api.md` with `Required Permission: membership in the team (bearer token must belong to a team member)`** — never `finance:view` or any specific permission string. This is how API consumers learn the auth contract.

Reference: `applications/server/src/api/finance.ts` (`myStatus`, `myPaymentHistory`).

## Membership Lookups Default To Active-Only

`TeamMembersRepository.findMembershipByIds(teamId, userId, options?)` and `TeamMembersRepository.findByUser(userId)` filter `AND tm.active = true` in their SQL by default. A row with `active = false` (a removed user) is invisible to every caller that does not explicitly opt in.

```typescript
// ✓ Default — active-only. `requireMembership`, every notification/fee/permission gate.
members.findMembershipByIds(teamId, userId)
// → Option.none() when the row exists but is inactive.

// ✓ Opt-in — inactive rows visible. Use ONLY for reactivation-or-create flows.
members.findMembershipByIds(teamId, userId, { includeInactive: true })
// → Option.some(membership) where `membership.active === false` for a removed user.
```

Rules:

1. **The default `findMembershipByIds(teamId, userId)` (no options) is the correct call for every authorization gate** — `requireMembership`, every `requirePermission`, every "is this caller a member" check. A removed user must surface as `Option.none()` so the gate returns `forbidden` (403).
2. **Pass `{ includeInactive: true }` only when the handler's purpose is to decide between addMember / reactivateMember / reject.** Currently exactly three call sites need this: `invite.joinViaInvite`, `auth.autoJoinTeams`, and `rpc/guild.RegisterMember`. Do not add a fourth without documenting why the reactivation branch belongs there.
3. **`findByUser(userId)` has no `includeInactive` option and never will.** It backs `GET /auth/me/teams` (the team switcher), which must hide teams the user has been removed from. Add a new method (e.g. `findAllByUserIncludingInactive`) before relaxing the SQL filter on `findByUser`.
4. **`requireMembership` (`src/api/permissions.ts`) calls `findMembershipByIds` without options.** Every endpoint that gates on membership inherits the active-only filter for free — never re-implement the gate by calling `findMembershipByIds(..., { includeInactive: true })` and then checking `membership.active` in handler code.
5. **The deactivation-is-terminal invariant in `auth.autoJoinTeams`.** When `findMembershipByIds(..., { includeInactive: true })` returns `Some` (active OR inactive), the handler returns `Option.none<Auth.UserTeam>()` and does NOT call `addMember` or `reactivateMember`. A user who was removed from a team is NEVER silently auto-rejoined on the next OAuth login — re-entry must go through an explicit invite via `invite.joinViaInvite`, which is the only path that calls `reactivateMember`.
6. **Fee/payment queries that JOIN `team_members` filter `AND tm.active = true` directly in SQL** (see `FeeAssignmentsRepository.findReminderCandidates` and `findUnpaidAssignmentsForUser`). A removed member's outstanding fees must not appear in payment reminders, my-payments lists, or unpaid-assignment scans. When adding a new repository query that JOINs `team_members` to surface user-facing data, add the same predicate.

Reference: `applications/server/src/repositories/TeamMembersRepository.ts` (`findMembershipQuery`, `findByUserQuery`), `applications/server/src/api/auth.ts` (`autoJoinTeams`), `applications/server/src/api/invite.ts` (`joinViaInvite`), `applications/server/src/rpc/guild/index.ts` (`RegisterMember`).

## PATCH Payload Merge: `Option.getOrElse` Over `Option.match`

PATCH handlers that build a "full row to UPDATE" from `Schema.OptionFromOptional(...)` payload fields plus the existing DB row MUST use `Option.getOrElse(payload.x, () => existing.x)` — never the verbose `Option.match(payload.x, { onNone: () => existing.x, onSome: (v) => v })`. The two are semantically identical when the `onSome` branch is the identity function, but `getOrElse` is one line, reads top-down ("the value, falling back to existing"), and removes the visual noise that obscures which payload fields the handler actually touches.

```typescript
// ✓ Good — partial-PATCH merge using Option.getOrElse
Effect.let('nextFields', ({ existing }) => ({
  name: Option.getOrElse(payload.name, () => existing.name),
  rules_channel_id: Option.getOrElse(payload.rulesChannelId, () => existing.rules_channel_id),
  achievement_channel_id: Option.getOrElse(
    payload.achievementChannelId,
    () => existing.achievement_channel_id,
  ),
})),

// ✗ Bad — Option.match where onSome is identity (use getOrElse instead)
const welcome_channel_id = Option.match(payload.welcomeChannelId, {
  onNone: () => existing.welcome_channel_id,
  onSome: (v) => v,
});
```

Reference: `applications/server/src/api/team.ts` (`updateTeamInfo` handler — every PATCH field uses `Option.getOrElse`).

Rules:

1. **Use `Option.getOrElse(opt, () => fallback)` when the `onSome` branch is the identity function `(v) => v`.** This is the "patch-or-keep" case for partial updates.
2. **Keep `Option.match` only when `onSome` is non-trivial** — i.e. transforms `v`, runs an `Effect`, or branches on `v`'s value. The "bare `Effect.succeed` in `onSome`" case has its own helper (`Options.toEffect`) — see `packages/effect-lib/AGENTS.md`.
3. **Do not lift a "patch-or-keep" merge into an `Effect.bind`** when no effectful work is needed. Use `Effect.let('nextFields', ({ existing }) => ({ ... }))` — `Effect.bind` would force the merged record to be wrapped in `Effect.succeed` and back, adding allocation for no benefit. `team.ts:updateTeamInfo` switched from `Effect.bind` returning `Effect.succeed({ ... })` to `Effect.let` for exactly this reason.

## HttpApi Query Parameters Must Be Consumed Or Removed

When an endpoint declares a query parameter via `Schema.OptionFromOptional(...)` (or any other shape) on the domain `HttpApiEndpoint`, the server handler MUST destructure and use it. A declared-but-unused query parameter is a contract bug: the client believes it can constrain the response (e.g. `?limit=20`) but the server silently ignores it, returning the full result set. Reviewers see only the schema declaration in the diff and assume the wiring is complete.

```typescript
// ✗ Bad — `limit` declared on the endpoint, never destructured
.handle('listChallenges', ({ params: { teamId } }) =>
  challenges.listForTeam(teamId, teamTz),
)

// ✓ Good — `limit` destructured and threaded through
.handle('listChallenges', ({ params: { teamId }, query }) =>
  challenges.listForTeam(teamId, teamTz, Option.getOrUndefined(query.limit)),
)

// ✓ Also acceptable — if the parameter is not actually needed, remove the schema declaration in the same PR
```

Rules:

1. **Every `Schema.OptionFromOptional` query field on an endpoint MUST appear in the handler's destructure or the handler's body.** Grep `query\.<fieldName>` in the handler file before marking the endpoint complete.
2. **`Option.getOrUndefined(query.x)` is the canonical way to pass an `Option`-typed query param into a repository method that takes a default-parameter (e.g. `(teamId, teamTz, limit = 12)`).** Do not pre-resolve the default in the handler — keep the default value next to the SQL `LIMIT` clause in the repository.
3. **If a query param turns out to be unnecessary,** remove the field from the domain `HttpApi*` schema in the same PR as removing the handler reference — never leave a declared-but-dead parameter on the public contract.

## Atomic Conditional UPDATE Pattern

When a state transition must be race-free (e.g. "claim if not yet claimed", "mark started if still active"), encode the precondition in the `WHERE` clause and use `RETURNING id` to detect whether the row was updated. Use `SqlSchema.findOneOption` so callers receive `Option<{ id }>` — `Option.isSome` means "we won the race", `Option.isNone` means "preconditions failed (already claimed / cancelled / wrong member / not found)".

```typescript
const _claimTraining = SqlSchema.findOneOption({
  Request: Schema.Struct({ event_id: Event.EventId, team_member_id: TeamMember.TeamMemberId }),
  Result: Schema.Struct({ id: Event.EventId }),
  execute: (input) =>
    sql`UPDATE events SET claimed_by = ${input.team_member_id}
        WHERE id = ${input.event_id}
          AND status = 'active'
          AND event_type = 'training'
          AND claimed_by IS NULL
        RETURNING id`,
});
```

Rules:
1. Always include every business precondition in the `WHERE` clause — never read-then-update across two statements
2. The handler that consumes the `Option` must, on `None`, re-read the row to distinguish which precondition failed and map to the appropriate typed error (e.g. `ClaimEventNotFound` vs `ClaimAlreadyClaimed` vs `ClaimEventInactive`)
3. Used by: `EventsRepository.claimTraining` / `unclaimTraining` (claim race), `EventsRepository.markEventStarted` (start race), `EventRsvpsRepository` upserts

## Global Admin Authorization (`users.is_global_admin` + `APP_GLOBAL_ADMIN_DISCORD_IDS`)

Some HTTP endpoints (translations CMS, onboarding-token tools, future cross-team operator tools) must be restricted to Sideline operators that are **not** modelled per-team in the database. Global-admin status has two additive sources, OR-combined into a per-request boolean on `CurrentUser`: a persisted `users.is_global_admin` DB flag and an env-driven Discord-id allow-list.

| Component | File | Behaviour |
|-----------|------|-----------|
| DB column | `users.is_global_admin` (`packages/migrations/src/before/1787300000_add_user_global_admin.ts`) | Persisted `boolean`. Bootstrapped to `true` for the first registered user (see below); otherwise `false`. |
| Env var | `APP_GLOBAL_ADMIN_DISCORD_IDS` | Comma-separated list of Discord user ids. Empty / unset → no env-granted global admins. Additive OR on top of the DB flag, kept for backward compatibility. |
| Parsed set | `globalAdminDiscordIds` in `src/env.ts` | `ReadonlySet<string>` materialized once at module load — trimmed entries, empty strings filtered. |
| Resolution helper | `toCurrentUser(user)` in `src/utils/toCurrentUser.ts` | Single source that builds `Auth.CurrentUser` from a `User.User` row, setting `isGlobalAdmin = user.is_global_admin \|\| globalAdminDiscordIds.has(user.discord_id)`. |
| Per-request flag | `Auth.CurrentUser.isGlobalAdmin` | Produced by `toCurrentUser` at every `CurrentUser` construction site: `AuthMiddlewareLive` and the three `src/api/auth.ts` handlers (locale update, admin profile update, profile completion). Never construct `Auth.CurrentUser` inline. |
| First-user bootstrap | `UsersRepository.upsertFromDiscord` | The insert sets `is_global_admin = (NOT EXISTS (SELECT 1 FROM users))`, so the first registered user becomes a global admin. `ON CONFLICT` omits `is_global_admin`, so subsequent logins never promote/demote it. |
| Handler guard | `requireGlobalAdmin(forbidden)` in `src/utils/requireGlobalAdmin.ts` | Reads `Auth.CurrentUserContext`; on `isGlobalAdmin === false`, fails with the caller-supplied `forbidden` error. |

Rules:

1. **Use `requireGlobalAdmin(new <Resource>Forbidden())` as the FIRST step** of any admin-only handler — before reading payload, before DB lookups. Returning 403 on permission must not leak existence information about the target row.
2. **The endpoint's domain error must be a dedicated `<Resource>Forbidden` tag bound to HTTP 403** via `HttpApiSchema.status(403)`. Do not reuse `Auth.Unauthorized` — that is reserved for "no valid session" (401), not "session valid but insufficient privilege".
3. **Never check `discord_id` against the env set inside a handler, and never construct `Auth.CurrentUser` inline.** Always build it via `toCurrentUser` and always read `currentUser.isGlobalAdmin`, so the resolution rule (DB flag OR env allow-list) lives in exactly one place.
4. **Env allow-list changes require a redeploy; DB-flag changes take effect on the user's next request.** `globalAdminDiscordIds` is computed at module load from `process.env` — there is no hot-reload path. `users.is_global_admin` is read per-request via `toCurrentUser`. Document the env var in `docs/deployment.md` when adding a new admin-only endpoint.
5. **Do not use the global-admin flag for team-scoped operations.** Captain/member permissions on a team are checked via `requirePermission(membership, '<perm>', forbidden)` from the membership repository — global admin does NOT implicitly grant team permissions and must not be made to.

Reference: `src/api/translations.ts` (every mutating endpoint starts with `Effect.tap(() => requireGlobalAdmin(forbidden))`).

## LISTEN/NOTIFY Cache Invalidation

When a small, frequently-read table (e.g. `translation_overrides`) must be served from an in-memory cache that stays coherent across multiple server instances, use Postgres `LISTEN/NOTIFY` as the invalidation bus. Every mutation bumps a monotonic version row in the same transaction and emits `NOTIFY <channel>`; every server instance subscribes to the channel via `PgClient.listen(channel)` and refreshes its in-memory snapshot on each notification.

Reference: `TranslationCache` (`src/services/TranslationCache.ts`) backed by `translation_overrides` and `translation_cache_version`.

### Schema Contract

```sql
-- The data table (any shape).
CREATE TABLE <resource>_overrides ( ... );

-- The single-row version counter. Bumped on every mutation.
CREATE TABLE <resource>_cache_version (
  id          INT PRIMARY KEY CHECK (id = 1),
  version     INT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO <resource>_cache_version (id, version) VALUES (1, 1);
```

### Mutation Path (Repository)

Every write that should invalidate the cache must, **in a single transaction**, (1) write the row(s) and (2) bump the version + emit `NOTIFY`:

```typescript
const bumpVersionAndNotify = () =>
  bumpVersionQuery(undefined).pipe(
    catchSqlErrors,
    Effect.flatMap((opt) =>
      Option.match(opt, {
        onNone: () => Effect.succeed(1),
        onSome: (row) => Effect.succeed(row.version),
      }),
    ),
    Effect.tap((version) =>
      sql
        .unsafe(`NOTIFY <resource>_cache_invalidate, '${String(version)}'`)
        .pipe(catchSqlErrors),
    ),
  );

const upsert = (args) =>
  sql.withTransaction(
    Effect.Do.pipe(
      Effect.tap(() => sql`INSERT INTO <resource>_overrides ... ON CONFLICT ...`.pipe(catchSqlErrors)),
      Effect.flatMap(() => bumpVersionAndNotify()),
    ),
  ).pipe(catchSqlErrors);
```

### Subscriber Path (Service)

The cache service is a `ServiceMap.Service` with a `Layer.effect` (NOT `Layer.scoped`) so that `Effect.forkScoped` inside `make` is wired into the layer's scope:

```typescript
const make = Effect.Do.pipe(
  Effect.bind('repository', () => <Resource>Repository.asEffect()),
  Effect.bind('pgClient', () => PgClient.PgClient.asEffect()),
  Effect.bind('initialOverrides', ({ repository }) => repository.findAll()),
  Effect.bind('initialVersion', ({ repository }) => repository.getVersion()),
  Effect.bind('stateRef', ({ initialOverrides, initialVersion }) =>
    Ref.make({ version: initialVersion, overrides: initialOverrides }),
  ),
  Effect.let('refresh', ({ repository, stateRef }) => () =>
    Effect.Do.pipe(
      Effect.bind('overrides', () => repository.findAll()),
      Effect.bind('version', () => repository.getVersion()),
      Effect.tap(({ overrides, version }) => Ref.set(stateRef, { version, overrides })),
      Effect.asVoid,
      Effect.tapError((e) => Effect.logWarning('<Resource>Cache: refresh failed', e)),
      Effect.ignore,
    ),
  ),
  Effect.tap(({ pgClient, refresh }) =>
    pgClient.listen('<resource>_cache_invalidate').pipe(
      Stream.tap(() => refresh()),
      Stream.runDrain,
      Effect.retry(Schedule.exponential('1 second', 2).pipe(Schedule.take(20))),
      Effect.tapError((e) =>
        Effect.logError('<Resource>Cache: LISTEN fiber stopped unexpectedly', e),
      ),
      Effect.ignore,
      Effect.forkScoped,
    ),
  ),
  Effect.map(({ stateRef, refresh }) => ({
    get: () => Ref.get(stateRef),
    refresh,
  })),
);
```

### Rules

1. **The version bump and the `NOTIFY` must run inside the same `sql.withTransaction(...)` as the data write.** A write that commits before the NOTIFY fires would leave other instances serving stale data until the next mutation.
2. **The NOTIFY payload is informational only.** The subscriber must re-read `findAll()` + `getVersion()` from the DB on every notification — never reconstruct state from the payload. The payload is a `String(version)` for log-correlation only.
3. **Use `Layer.effect`, not `Layer.scoped`, when the service uses `Effect.forkScoped` internally.** `Layer.effect` already provides a scope that lives for the layer's lifetime; the forked fiber is automatically interrupted on layer release.
4. **Wrap `Stream.runDrain` in `Effect.retry(Schedule.exponential('1 second', 2).pipe(Schedule.take(20)))`** so the LISTEN fiber auto-reconnects after pg connection drops. After exhausting retries, log via `Effect.tapError` and `Effect.ignore` so the layer never fails — operator monitoring on the error log catches sustained outages.
5. **Always provide `findAll` + `getVersion` separately on the repository** (not a fused `findAllWithVersion`). The initial-load path and the refresh path call both; keeping them separate keeps each query indexable and lets unit tests stub them independently.
6. **The `get()` method on the cache returns the in-memory snapshot synchronously** — handlers must not call `refresh()` on the read path. The only legitimate caller of `refresh()` outside the LISTEN fiber is a test that needs to force a re-read between mutations.

## Application-Set Audit Actor For Hard Deletes

When a table is hard-deleted (no `voided_at` / `archived_at` soft-delete) but an audit trail must record **who** performed the delete, the actor cannot be derived from the row itself — `OLD.updated_by_user_id` only captures the last editor, not the deleter. The pattern: the repository sets a Postgres **session-local** variable inside a transaction before issuing the DELETE; the audit trigger reads it via `current_setting('audit.user_id', true)` and falls back to `OLD.updated_by_user_id` if unset.

Reference implementation: `ExpensesRepository.delete` + `expenses_audit` trigger (migration `1786000000_create_expenses.ts`).

### Repository Shape

```typescript
const delete_ = (id: Expense.ExpenseId, teamId: Team.TeamId, userId: Auth.UserId) =>
  sql
    .withTransaction(
      sql`SET LOCAL audit.user_id = ${String(userId)}`.pipe(
        Effect.flatMap(() => deleteReturningQuery({ id, team_id: teamId })),
        Effect.map(Option.isSome),
        catchSqlErrors,
      ),
    )
    .pipe(catchSqlErrors);
```

### Rules

1. **Always wrap the `SET LOCAL` + DELETE in `sql.withTransaction(...)`.** `SET LOCAL` is scoped to the current transaction — without `withTransaction` the setting either has no effect (autocommit) or leaks across statements on a pooled connection.
2. **Interpolate the user id with `${String(userId)}`, not as a raw SQL fragment.** The `sql` template tag binds the value as a parameter; `SET LOCAL audit.user_id = $1` is the correct form. Never concatenate the id into the SQL string.
3. **The trigger must call `current_setting('audit.user_id', true)`** (note the `true` second argument — missing-key returns `NULL` instead of raising) and wrap the cast in a `BEGIN ... EXCEPTION WHEN OTHERS THEN audit_user_id := NULL; END` block so a malformed or absent setting falls back to `OLD.updated_by_user_id` rather than aborting the delete.
4. **Do NOT add a `deleted_by_user_id` column to the parent table** — the parent row is gone after DELETE. The audit actor lives only on the history row (`expense_history.performed_by_user_id`).
5. **Every repository method that hard-deletes a row from such a table MUST take `userId: Auth.UserId` as an argument and set the session var.** A repository method that omits the `SET LOCAL` will write the history row with `OLD.updated_by_user_id` as the actor — silently wrong, no error.

## Hard-Delete + Audit Trigger vs Soft-Delete

Pick one deletion strategy per entity at table-creation time; do not retrofit. Both are valid; the choice is per-table based on operational needs:

| Strategy | Use when | Reference |
|----------|---------|-----------|
| **Soft-delete** (`archived_at` / `voided_at` column, never deleted from disk) | The row is read after "deletion" — e.g. financial transactions (`payments.voided_at`) must remain visible in payment history; archived fees (`fees.archived_at`) must remain listable so historical assignments still resolve. The application filters via `WHERE <column> IS NULL` in active-row queries. | `payments.voided_at`, `fees.archived_at`, `team_invites.deactivated_at` |
| **Hard-delete + audit trigger** | The row is never read after "deletion" — e.g. expense entries (`expenses` table) have no downstream FKs (no payments reference them, no reports require the row to remain). Audit is satisfied by writing every insert/update/delete to a `<resource>_history` table via trigger. The hot path stays small (no `WHERE archived_at IS NULL` predicate on every read). | `expenses` + `expense_history` (trigger `expenses_audit`) |

Rules:

1. **Soft-delete is the default for any row that participates in a financial total, statement, or downstream computation.** Once a payment, fee, or assignment row exists, removing it from disk silently breaks every report that already summed it.
2. **Hard-delete + audit trigger is only valid when no other table FKs to the deleted table with a non-NULL value.** Verify by grepping `REFERENCES <table>` across migrations: every FK must either not exist, be on a child that cascades, or be safely `ON DELETE RESTRICT` with no real-world rows that would block deletion.
3. **The audit `<resource>_history` table stores a full JSONB snapshot per operation** (`snapshot JSONB NOT NULL` populated via `to_jsonb(NEW)` / `to_jsonb(OLD)` in the trigger). Do NOT denormalize fields onto history columns — the snapshot is the authoritative pre-delete record; the column projection is undefined for entries created before a schema change.
4. **`expense_history.performed_by_user_id` is `ON DELETE RESTRICT`** so the audit row outlives the user account by default. GDPR-style anonymization is a separate per-PR story documented as a `COMMENT ON COLUMN` on the original table — see `1786000000_create_expenses.ts` for the comment template.
5. **Never mix the two strategies on the same table.** A table with both `voided_at` AND an audit trigger that hard-deletes is a footgun — readers cannot tell which "delete" path was used. Pick one in the creating migration and stick to it.

See `packages/migrations/AGENTS.md` → "Per-Row Audit Trigger With Application-Set Actor" for the trigger DDL.

## Testing

Tests go in `test/` directory. When adding new repositories, add corresponding mock implementations to all test files that compose `AppLive` (e.g., `MockChannelSyncEventsRepository`).

### HttpApi Mock-Layer Cascade

Every test file that provides `ApiLive` (directly or transitively) MUST provide a mock layer for **every** repository that any `HttpApiBuilder.group(...)` registered in `ApiLive` depends on — even repositories the test does not exercise. Adding a new group to `ApiLive` without updating every existing `ApiLive`-providing test produces a missing-service runtime error at layer construction, not a compile error.

Reference: `applications/server/test/mocks/weeklyChallengeMocks.ts` is the canonical noop-mock shape. Every method returns the type's safe empty value (`Effect.succeed(Option.none())`, `Effect.succeed([])`, `Effect.void`); methods whose success type is non-trivial (e.g. `create` returning a domain model) return `Effect.die(new Error('Mock<X>.create not implemented'))` so a test that accidentally exercises an unimplemented path fails loudly instead of returning a partially-constructed value.

Rules:

1. **When adding a new `HttpApiBuilder.group(...)` and wiring it into `ApiLive`,** create `test/mocks/<feature>Mocks.ts` exporting a `Mock<Repo>Layer` in the same PR, and add it to every test file that currently provides `ApiLive`. Grep `Layer.provideMerge(ApiLive)` and `Layer.provide(ApiLive)` to find the full call-site list.
2. **Noop mocks use `Effect.succeed(<empty>)` for read methods and `Effect.die(...)` for non-trivial writes** (any method whose success type is a domain model, not `void`). Read methods that return `Option` succeed with `Option.none()`; read methods that return `ReadonlyArray` succeed with `[]`; void-returning writes succeed with `Effect.void`.
3. **Cast the mock object with `as never`** (matching the existing files) — the repository's `ServiceMap.Service` tag carries a private brand that cannot be reconstructed in test code.
4. **Mock objects must build the canonical domain model via its constructor, not as a plain camelCase literal.** `new WeeklyChallenge.WeeklyChallengeView({ challenge: new WeeklyChallenge.WeeklyChallenge({ ... }), completedMemberIds: [], isActive: false })` — NOT `{ challenge: { id: '...', weekStartDate: '...' }, ... }`. The HTTP handler encodes the response through the schema; a string-shaped literal fails encoding and tempts a "fix" that bypasses schema encoding entirely. Build mocks via the same constructors the production code uses.
