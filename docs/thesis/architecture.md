# System Architecture

## Introduction

Sideline is a sports-team management platform that integrates with Discord. The system is built as an Effect-TS monorepo, written entirely in TypeScript with strict functional programming conventions. It consists of five deployed applications — a reverse proxy, a web frontend, an HTTP API server, a Discord bot, and a static documentation site — backed by a PostgreSQL database and observed via OpenTelemetry.

This document describes the system's deployment topology, internal package structure, communication patterns, technology stack, background jobs, and the shared application-composition pattern used throughout the codebase.

---

## 1. Deployment Architecture

All five application containers are orchestrated via Docker Compose. The proxy is the single public-facing entry point; the web, server, and docs containers are only reachable through it. The bot container reaches the server directly over the internal Docker network using its HTTP RPC endpoint.

```mermaid
graph TD
    Client([Browser / Client])
    Discord([Discord API])

    subgraph Docker Compose Network
        Proxy["Nginx Proxy\n(port 9000 public)"]
        Web["Web App\nTanStack Start / React 19\n(port 3000)"]
        Server["API Server\nEffect HttpApi\n(port 80)"]
        Bot["Discord Bot\ndfx / Effect\n(port 9000 health)"]
        Docs["Docs Site\nAstro + Starlight → nginx:alpine\n(port 80)"]
        DB[(PostgreSQL)]
    end

    OTEL["SigNoz / OpenTelemetry\n(external collector)"]

    Client -->|HTTPS| Proxy
    Proxy -->|"/ (all routes)"| Web
    Proxy -->|"/api/ (REST)"| Server
    Proxy -->|"/docs/ (static)"| Docs
    Web -.->|"SSR: SERVER_URL/api"| Server

    Bot -->|"HTTP RPC /rpc/sync (NDJSON)"| Server
    Bot <-->|"WebSocket Gateway"| Discord
    Discord -->|"OAuth2 callbacks"| Proxy

    Server -->|SQL| DB
    Server -->|OTLP| OTEL
    Bot -->|OTLP| OTEL
    Web -->|OTLP| OTEL

    Proxy -.->|"depends_on (healthy)"| Server
    Proxy -.->|"depends_on (healthy)"| Web
    Proxy -.->|"depends_on (healthy)"| Docs
    Bot -.->|"depends_on (healthy)"| Server
```

### Nginx Routing Rules

| Path prefix | Upstream | Notes |
|---|---|---|
| `/api/auth/callback` | Server (via JS handler) | Discord OAuth2 redirect |
| `/api/` | Server (`$var_server_upstream`) | All REST API calls |
| `/docs` | — | 301 redirect to `/docs/` |
| `/docs/` | Docs (`$var_docs_upstream`) | Astro + Starlight static site |
| `/` | Web (`$var_web_upstream`) | TanStack Start SSR |

---

## 2. Monorepo Package Dependency Diagram

The workspace is managed with pnpm. Shared logic lives in four packages under `packages/`; application code in `applications/` depends on them.

```mermaid
graph TD
    subgraph Packages
        EL["@sideline/effect-lib\nShared Effect utilities\n(Bind, Schemas, Runtime, Telemetry)"]
        DOM["@sideline/domain\nCore domain models\nand API contracts\n(Effect Schema, HttpApi, RPC)"]
        I18N["@sideline/i18n\nTranslation messages\n(Paraglide.js)"]
        MIG["@sideline/migrations\nDatabase migrations\n(Effect SQL + PgClient)"]
    end

    subgraph Applications
        SERVER["applications/server\nEffect HttpApi + PostgreSQL"]
        BOT["applications/bot\nDiscord bot (dfx)"]
        WEB["applications/web\nTanStack Start + React 19"]
        PROXY["applications/proxy\nNginx reverse proxy"]
        DOCS["applications/docs\nAstro + Starlight static site"]
    end

    DOM --> EL
    MIG --> EL

    SERVER --> DOM
    SERVER --> EL
    SERVER --> MIG

    BOT --> DOM
    BOT --> EL

    WEB --> DOM
    WEB --> I18N
    WEB --> EL
```

---

## 3. Communication Patterns

```mermaid
graph LR
    Browser([Browser])
    Proxy[Nginx Proxy]
    Web[Web App]
    Server[API Server]
    Bot[Discord Bot]
    DB[(PostgreSQL)]
    DiscordGW([Discord Gateway])

    Browser -->|"HTTPS REST"| Proxy
    Proxy -->|"HTTP proxy"| Web
    Proxy -->|"HTTP proxy /api/"| Server
    Web -->|"HTTP fetch SERVER_URL"| Server

    Bot -->|"HTTP RPC / NDJSON\n/rpc/sync"| Server
    Bot <-->|"WebSocket\n(Discord Gateway)"| DiscordGW

    Server -->|"SQL / TCP"| DB
```

Key protocols:

- **Browser to Server**: Standard HTTPS REST, routed via Nginx. The web app also calls the API directly during SSR using the internal `SERVER_URL`.
- **Bot to Server (RPC)**: The bot communicates with the server over HTTP using an NDJSON streaming protocol (`@effect/rpc` with `RpcSerialization.layerNdjson`). The RPC prefix is `/rpc/sync`. Inside Docker, the bot connects directly to the server container (`http://<SERVICE_NAME_SERVER>:80`) bypassing the proxy.
- **Bot to Discord**: The bot maintains a persistent WebSocket connection to the Discord Gateway using the `dfx` library (`DiscordIxLive`), receiving real-time interaction events.
- **Discord OAuth2**: Browser is redirected to Discord, then returns to `/api/auth/callback` on the proxy, which handles the token exchange.

---

## 4. Technology Stack

| Concern | Technology |
|---|---|
| Language | TypeScript 5.6+, strict mode, NodeNext resolution |
| Effect system | Effect-TS 3.10+ (`effect`, `@effect/platform`, `@effect/rpc`) |
| API layer | `@effect/platform` `HttpApi` (declarative, schema-validated) |
| Frontend framework | TanStack Start (SSR) + React 19 |
| Docs site | Astro + Starlight (static, served via nginx:alpine) |
| Discord bot runtime | `dfx` (Effect-native Discord framework) |
| Authentication | Discord OAuth2 (server-side token exchange) |
| Database | PostgreSQL (via `@effect/sql-pg`) |
| Database migrations | `@sideline/migrations` (Effect SQL migrator, decoupled from config) |
| i18n | Paraglide.js (`@sideline/i18n`, compiled message bundles) |
| Reverse proxy | Nginx with njs (JavaScript module for OAuth redirect) |
| Observability | SigNoz + OpenTelemetry (`@effect/opentelemetry`, OTLP HTTP export) |
| Testing | Vitest 3.2+ with `@effect/vitest` |
| Linting / formatting | Biome.js |
| Package manager | pnpm 10+ (workspace-aware) |
| CI | GitHub Actions (`check.yml`: lint, build, typecheck, test) |
| Docker images | Built per-app, pushed to GHCR (`ghcr.io/maxa-ondrej/sideline/<app>`) |
| Containerisation | Docker Compose (five services: proxy, web, server, bot, docs) |

---

## 5. Background Cron Jobs

All cron jobs run inside the server process, launched as concurrent fibers alongside the HTTP server in `run.ts`. Each job is an `Effect` value composed with `Effect.repeat(Schedule.cron(...))` and provided with its own `PgClient` layer, keeping it independent from the HTTP layer's database connection.

| Job | Schedule (cron) | Purpose |
|---|---|---|
| `EventHorizonCron` | `0 3 * * *` (daily at 03:00 UTC) | Generates future event occurrences for recurring event series up to a configurable horizon date; emits an `event_created` sync event for each generated event so the bot publishes a Discord embed |
| `EventStartCron` | `* * * * *` (every minute) | Transitions `active` events to `started` status when their `start_at` time passes, and emits `event_started` sync events for the bot to remove RSVP buttons from Discord embeds |
| `RsvpReminderCron` | `* * * * *` (every minute) | Emits RSVP reminder sync events for upcoming events that have not yet had a reminder sent |
| `AgeCheckCron` | `0 2 * * *` (daily at 02:00 UTC) | Evaluates age-threshold rules per team and applies Discord role changes to members who have crossed an age boundary |
| `TrainingAutoLogCron` | `*/5 * * * *` (every 5 minutes) | Automatically logs training activity for members who had a "yes" RSVP on completed training events |
| `TrainingClaimRequestCron` | `* * * * *` (every minute) | Emits `training_claim_request` sync events for training events that are within the team's configured `claim_request_days_before` window and have not yet had a claim-request message posted (`claim_request_sent_at IS NULL`) |
| `CoachingStatusCron` | `* * * * *` (every minute) | Emits `coaching_status` sync events on the day of a claimed training (where `coaching_status_sent_at IS NULL`), causing the bot to post a "today's coach is X" announcement to the member training channel |
| `ImapPoller` | `*/5 * * * *` (every 5 minutes) | Polls IMAP mailboxes for all teams that have `imap_enabled = true` and a stored encrypted app-password. Fetches unseen messages since the last-seen UID, stores them as `email_messages` rows (deduplicating by RFC 2822 `Message-ID`), and advances `imap_last_seen_uid` and `imap_last_synced_at` on success. Requires `EMAIL_IMAP_ENCRYPTION_KEY` to decrypt stored credentials at poll time. |

---

## 6. AppLive + run.ts Pattern

Every application in the workspace follows the same two-file composition pattern, as described in `AGENTS.md`:

### `AppLive` — portable layer

`AppLive` is an Effect `Layer` that wires all of the application's core services together without any runtime concerns (no database connection config, no HTTP port, no logger setup). It is the unit that can be tested in isolation or composed into a larger system.

For the server, `AppLive` composes:

- `HttpApiBuilder.serve(HttpLogger)` — the HTTP router with access logging
- `HttpApiSwagger` — OpenAPI/Swagger UI at `/docs/swagger-ui`
- `ApiLive` — all REST route handlers
- `RpcLive` — the NDJSON RPC router at `/rpc/sync` (used by the bot)
- `AuthMiddlewareLive` — Discord session authentication middleware
- All repository layers (`UsersRepository`, `TeamsRepository`, `FeesRepository`, `FeeAssignmentsRepository`, `PaymentsRepository`, `FinanceOverviewRepository`, etc.)
- `DiscordOAuth.Default` — Discord OAuth2 client

For the bot, `AppLive` composes:

- `HealthServerLive` — lightweight HTTP health-check server
- `DiscordIxLive` — dfx Gateway connection (WebSocket to Discord)
- `SyncLive` — `RoleSyncService`, `ChannelSyncService`, `ChannelBackfillService`, `EventSyncService`, `AchievementSyncService`, `RoleProvisionSyncService`, `EmailSyncService` (all backed by `SyncRpc` which calls the server over RPC)
- `FinanceCommand` — `/finance` slash command group (ephemeral, calls `Finance/GetMyStatus` RPC)

### `run.ts` — deployment entrypoint

`run.ts` is the Node.js entrypoint that provides all environment-specific infrastructure:

- `PgClient.layerConfig(BasePg)` — PostgreSQL connection from environment variables
- `NodeHttpServer.layer(createServer, { port })` — Node.js HTTP server
- Database creation and migration steps (`CreateDb`, `BeforeMigrator`, `AfterMigrator`)
- All cron job effects launched in parallel with the HTTP server
- `Runtime.runMain(...)` from `@sideline/effect-lib` — sets up structured logging, the OpenTelemetry telemetry layer (`makeTelemetryLayer`), and calls `NodeRuntime.runMain`

The clean separation means `AppLive` never imports `node:http`, never reads environment variables directly, and never starts the runtime — all of that is the exclusive responsibility of `run.ts`.

The web frontend follows a slightly different pattern. Rather than a Node.js `run.ts`, it uses a TanStack Start root route (`src/routes/__root.tsx`) whose `beforeLoad` hook calls `initRuntime` (initialising a `ManagedRuntime` singleton from `src/lib/runtime.ts`) and `registerWebVitals` (wiring Web Vitals and page-load reporters). The `makeTelemetryLayer` in `src/lib/telemetry.ts` uses the browser Fetch API as its OTLP transport and is silently disabled when `OTEL_EXPORTER_OTLP_ENDPOINT` is not set.

The web frontend also includes a PWA crash-recovery system composed of several modules:

- **`preMountGuard` (inline watchdog):** An ES5-safe IIFE injected into every HTML `<head>` response (before the JS bundle) by `RootDocument.tsx`. It sets a 10-second watchdog timer. If the React root has not mounted within that window (e.g. because a JS bundle chunk failed to fetch), the watchdog injects a full-screen recovery UI with **Reload** and **Reset app** buttons. It also captures pre-mount `window.onerror` / `onunhandledrejection` events and beacons them to the OTLP collector via `window.__SIDELINE_OTLP__`.
- **`AppErrorBoundary`:** A React class error boundary wrapping the entire component tree (outside `ThemeProvider`). On a render throw it renders `AppCrashFallback` — the same **Reload / Reset app** screen — and logs the error via the Effect runtime if it is initialised, or via `crashBeacon.ts` (direct `navigator.sendBeacon`) if the runtime is not yet up.
- **`reloadGuard`:** A session-storage counter that caps automatic page reloads at 2 (crash reloads) and 1 (SW-update reloads on separate counters) so a persistent crash does not loop forever.
- **`sw-recovery` (`resetApp`):** Called by the Reset app button. Unregisters all service worker registrations, clears all caches, then triggers a guarded reload.
- **`resolveStoredTheme`:** A dependency-free helper used by all crash surfaces (boundary, watchdog, route error component) to read `localStorage['sideline-theme']` and ensure the recovery UI respects the user's dark/light preference even when `ThemeProvider` has unmounted.
- **`otlp-endpoint.ts` (Nitro server plugin):** Rewrites every HTML SSR response to inject `<script>window.__SIDELINE_OTLP__ = "...";</script>` from `OTEL_EXPORTER_OTLP_ENDPOINT`. This makes the OTLP endpoint available to both the inline watchdog and `crashBeacon.ts` before the Effect runtime is ready.
- **Devtools tree-shaking:** TanStack devtools packages (`@tanstack/react-devtools`, `@tanstack/react-router-devtools`, `@tanstack/react-query-devtools`) are imported via a dynamic `import()` inside a `DevtoolsPanel` component gated by `import.meta.env.DEV`. The Vite build therefore omits all devtools code from production bundles.

The `markAppMounted()` / `markRouteHealthy()` functions signal the watchdog and the reload guard respectively: `markAppMounted` is called from `RootComponent`'s `useEffect` (clears the watchdog timer), and `markRouteHealthy` is called from `HealthyOutlet`'s `useEffect` (clears the reload counter) once a real child route has committed successfully.

---

## 7. Achievement System Flow

The achievement system has two concerns: evaluating and recording earned achievements (the original outbox flow), and managing achievement configuration (the new admin flow).

### 7a. Evaluation flow

**Server side — `AchievementEvaluator` service:**

After any activity is logged (via the REST `ActivityLog` API handler or the RPC `Activity/LogActivity` handler), the server calls `AchievementEvaluator.evaluate(memberId)`. The evaluator:

1. Loads the member's full activity log and computes stats (`ActivityStats.calculateStats`).
2. Compares the computed stats against the catalogue of 11 built-in achievement definitions in `packages/domain/src/models/Achievement.ts`, applying any per-team threshold overrides from `achievement_settings`, plus any custom achievements defined in `custom_achievements`.
3. For each newly qualifying achievement that has not yet been recorded, inserts a row into `earned_achievements` (idempotent — `ON CONFLICT DO NOTHING`).
4. For each newly inserted row, emits a row into `achievement_sync_events` (omitted if the team has no `guild_id`).

Evaluation errors are caught and logged as warnings — they never abort the activity-log mutation.

**Bot side — `AchievementSyncService` processor:**

The bot's Achievement Sync worker polls `Achievement/GetUnprocessedEvents` every 5 seconds. For each `achievement_earned` event it:

1. Looks up the optional Discord role from `achievement_role_mappings` (resolved at SELECT time in the RPC query, alongside the member's `discord_user_id` and the team's `welcome_channel_id`).
2. If a role ID is present, grants it to the guild member via `REST.addGuildMemberRole`.
3. If a `welcome_channel_id` is set, posts a congratulatory embed in that channel @-mentioning the member (and the role, if granted).
4. Marks the event processed via `Achievement/MarkEventProcessed` (or failed via `Achievement/MarkEventFailed` — failed events are not retried).

### 7b. Admin management flow

Team captains manage achievements through the web admin page at `/teams/:teamId/achievements` or the `Achievement` API group. Three areas of management are supported:

**Threshold overrides:** Admins can change the qualifying threshold for any built-in achievement. The override is stored in `achievement_settings`. The `AchievementPreview` service supports a "preview" endpoint that calculates how many current members would qualify and which already-earned achievements would be retroactively lost at a candidate threshold.

**Custom achievements:** Admins can create fully custom achievements via `POST /teams/:teamId/achievements/custom`. Each custom achievement specifies a `rule_kind` (`total_activities`, `longest_streak`, `total_duration`, or `activity_type_count`), a `threshold`, and an optional `activityTypeSlug` (required for `activity_type_count`). Custom achievements are stored in `custom_achievements` and are evaluated by `AchievementEvaluator` alongside built-in achievements.

**Discord role mapping:** For any achievement (built-in or custom), admins can:
- Link an existing Discord role by ID (`source: "existing"`).
- Remove the mapping (`source: "none"`).
- Request auto-creation (`source: "auto_create"`), which inserts a row in `discord_role_provision_events`.

**Bot side — `RoleProvisionSyncService` processor:**

The bot's Role Provision worker polls `RoleProvision/GetUnprocessedEvents` every 5 seconds. For each pending provision event it:

1. Lists all existing roles in the guild via Discord REST.
2. Searches for an existing role whose name exactly matches `desired_name` (reuse semantics).
3. If no match is found, creates a new Discord role with that name.
4. Writes the resulting role ID back via `Achievement/UpsertBuiltInRoleMapping` (for `kind = "builtin_achievement"`) or `Achievement/UpsertCustomRoleMapping` (for `kind = "custom_achievement"`).
5. Marks the event processed via `RoleProvision/MarkProcessed`.

### Achievement catalogue (from `Achievement.ACHIEVEMENTS`)

| Slug | Default trigger | Default threshold | Rule kind |
|---|---|---|---|
| `first_activity` | 1 activity logged | 1 | `total_activities` |
| `ten_activities` | 10 activities logged | 10 | `total_activities` |
| `fifty_activities` | 50 activities logged | 50 | `total_activities` |
| `hundred_activities` | 100 activities logged | 100 | `total_activities` |
| `streak_3` | 3-day longest streak | 3 | `longest_streak` |
| `streak_7` | 7-day longest streak | 7 | `longest_streak` |
| `streak_30` | 30-day longest streak | 30 | `longest_streak` |
| `duration_600` | 600 total minutes logged | 600 | `total_duration` |
| `duration_3000` | 3000 total minutes logged | 3000 | `total_duration` |
| `gym_25` | 25 gym activities logged | 25 | `activity_type_count` |
| `running_25` | 25 running activities logged | 25 | `activity_type_count` |
