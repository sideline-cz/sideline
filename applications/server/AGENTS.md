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

## Hand-written INSERT / UPDATE Column Lists

`SqlSchema.findOne({ Request: Model.insert, ... })` validates the **input shape**, but the column list and `VALUES (...)` tuple inside the raw `sql\`INSERT INTO ... \`` template are hand-written. The schema does **not** cross-check that every field on the `insert` variant appears in the SQL — fields present on the schema but absent from the column list are silently dropped at write time and the query still succeeds (returning the row with the DB default / NULL for the missing column).

This footgun bit `TeamsRepository.insert` once already: `welcome_channel_id` was added to `Team.Team.insert` and the API handler, but the column list still read `(name, guild_id, description, sport, logo_url, created_by)` — every team created post-migration had `welcome_channel_id = NULL` despite the caller passing a value. Fix: extend both the column list and `VALUES` tuple in the same edit.

Rules when adding a new column to a `Model.Class` that is INSERTed via hand-written SQL:

1. **Grep for every hand-written `INSERT INTO <table>` in `src/repositories/`** and add the new column to both the column list and the `VALUES (...)` tuple. `SqlSchema` does not catch the mismatch.
2. **Do the same for hand-written `UPDATE <table> SET ...`** statements that take a typed `Request` schema. A new field on the request schema is not auto-applied to the SET clause.
3. **Prefer `Model.makeRepository(...)` `insert` / `update`** when the operation maps 1:1 to the model — it derives the column list from the schema and cannot drift. Use hand-written SQL only when the operation needs JOINs, `ON CONFLICT`, `RETURNING` of computed columns, or partial column updates.
4. **Add an integration test that round-trips the new field** through the repository — read the inserted row back and assert the new column equals the input. This is the only mechanism that catches the silent-drop bug.

## Postgres Type Conventions

- **`TIME` columns** — node-postgres returns `'HH:MM:SS'`. If consumers expect `'HH:MM'`, normalize on read with `TO_CHAR(col, 'HH24:MI') AS col` in both `SELECT` and `RETURNING` clauses (see `TeamSettingsRepository._findByTeam`).
- **`sql` template tag** — interpolated values become bind parameters, never SQL fragments. To pass "now" into a query, pass a real `Date` (or its ISO string) and cast in SQL (`${nowIso}::timestamptz`); never interpolate the literal string `'NOW()'` — it becomes a bound text value, not a function call.

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

## Testing

Tests go in `test/` directory. When adding new repositories, add corresponding mock implementations to all test files that compose `AppLive` (e.g., `MockChannelSyncEventsRepository`).
