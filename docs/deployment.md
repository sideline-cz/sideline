# Deployment and Operations Guide

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Service Details](#2-service-details)
3. [Environment Variables](#3-environment-variables)
4. [Background Cron Jobs](#4-background-cron-jobs)
5. [Database Operations](#5-database-operations)
6. [CI/CD Pipelines](#6-cicd-pipelines)
7. [Monitoring and Observability](#7-monitoring-and-observability)
8. [Local Development Setup](#8-local-development-setup)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Architecture Overview

Sideline is composed of five containerized services backed by a PostgreSQL 17 database. All services are built with Docker and orchestrated via Docker Compose. In production the stack runs on a VPS managed by Coolify.

```
Internet ──► Proxy (nginx :80)
               ├── /api/*   ─────────► Server (:80)
               ├── /docs/*  ─────────► Docs (:80)
               └── /*       ─────────► Web (:3000)

Bot ──────────────────────────────────► Server (HTTP RPC at /rpc/sync)

Server, Bot, Web ────────────────────► PostgreSQL (:5432)
```

**Services at a glance:**

| Service | Technology | Role |
|---------|-----------|------|
| `proxy` | nginx + njs | Reverse proxy; routes `/api/*` to server, `/docs/*` to docs, and `/*` to web |
| `server` | Node.js 25, Effect-TS | REST API, RPC endpoint, cron jobs, database migrations |
| `bot` | Node.js 25, Effect-TS, dfx | Discord bot; connects to gateway and processes sync events |
| `web` | Node.js 25, TanStack Start, React 19 | Server-side rendered frontend |
| `docs` | Astro + Starlight → nginx:alpine | Static end-user documentation site served at `/docs` |

**Container registry:** `ghcr.io/maxa-ondrej/sideline/<app>`

---

## 2. Service Details

### 2.1 Proxy

**Purpose:** Terminates inbound HTTP traffic, forwards `/api/*` to the server, and all other paths to the web frontend. Handles the Discord OAuth callback redirect in a small njs script (`preview_redirect.js`).

**Dockerfile:** `applications/proxy/Dockerfile`
- Base image: `nginx` with `nginx-module-njs` installed
- Copies nginx configuration, njs script, and template files into the image
- Template files in `/etc/nginx/templates/` are expanded at container start using nginx's built-in envsubst support

**Ports:**
- `:80` (or `$PORT`) — application traffic
- `:9000` (or `$HEALTH_PORT`) — health check server

**Health check:** `GET http://localhost:9000/health` returns `{"status": "ok"}`

**Dependencies:** `server` (healthy), `web` (healthy), `docs` (healthy)

**Routing rules (nginx.conf):**
- `GET /api/auth/callback` — handled inline by njs script
- `GET /api/*` — proxied to `http://$SERVER_HOST:$SERVER_PORT`
- `GET /docs` — 301 redirect to `/docs/`
- `GET /docs/*` — proxied to `http://$DOCS_HOST:$DOCS_PORT`
- `GET /*` — proxied to `http://$WEB_HOST:$WEB_PORT`

---

### 2.2 Server

**Purpose:** The core HTTP API server. Exposes the REST API (under `$API_PREFIX`, default `/api`), an internal RPC endpoint for the bot (under `$RPC_PREFIX`, default `/rpc/sync`), and runs seven background cron jobs.

**Dockerfile:** `applications/server/Dockerfile`

Build stages:
1. `base` — Node.js 25 slim + pnpm 10
2. `deps` — installs all dependencies from lockfile
3. `build` — runs codegen and compiles TypeScript to `build/esm/`
4. `production` — lean image with prod-only dependencies; copies `build/esm/` as `build/`

**Entry point:** `node applications/server/build/run.js`

**Ports:**
- `:80` (or `$PORT`) — application traffic
- `:9000` (or `$HEALTH_PORT`) — health check

**Health check:** `GET http://localhost:9000/health` — checked up to 15 times (30 s apart, 30 s start period)

**Dependencies:** PostgreSQL

**Startup sequence (`applications/server/src/run.ts`):**

1. If `DATABASE_MAIN != DATABASE_NAME`, creates the target database (used for preview environments where each PR has an isolated database).
2. Runs "before" migrations (schema changes).
3. Launches all of the following concurrently (concurrency: 8):
   - HTTP application server (`AppLive`)
   - Health check server (`HealthServerLive`)
   - "After" migrations (seed data)
   - `AgeCheckCron`
   - `EventHorizonCron`
   - `EventStartCron`
   - `PaymentReminderCron`
   - `RsvpReminderCron`
   - `TrainingAutoLogCron`
   - `WeeklySummaryCron`

The `Runtime.runMain` wrapper configures the OpenTelemetry telemetry layer before starting.

---

### 2.3 Bot

**Purpose:** Discord bot. Connects to the Discord gateway, registers slash commands, handles interactions, and runs long-polling sync worker loops that poll the server RPC endpoint to process role, channel, event, achievement, role-provision, and weekly-summary sync events.

**Dockerfile:** `applications/bot/Dockerfile`

Build stages are identical in structure to the server Dockerfile: `base` → `deps` → `build` → `production`.

**Entry point:** `node applications/bot/build/run.js`

**Ports:**
- `:9000` (or `$HEALTH_PORT`) — health check only (no external application port)

**Health check:** `GET http://localhost:9000/health`

**Dependencies:** `server` (healthy) — the bot connects to the server's RPC endpoint on startup.

**Startup (`applications/bot/src/run.ts`):**
- Establishes an HTTP RPC client pointing at `$SERVER_URL + $RPC_PREFIX`
- Configures the Discord gateway with `$DISCORD_BOT_TOKEN` and `$DISCORD_GATEWAY_INTENTS`
- Runs `Bot.program` which registers slash commands and starts the gateway + sync worker loops

---

### 2.4 Web

**Purpose:** Server-side rendered frontend built with TanStack Start (React 19, Vite). Proxied from the root path by nginx.

**Dockerfile:** `applications/web/Dockerfile`

Build stages: `base` → `deps` → `build` → `production`. The Vite build outputs to `applications/web/.output/`; the production image serves it with the TanStack Start Node.js adapter.

**Entry point:** `node applications/web/.output/server/index.mjs`

**Ports:**
- `:3000` (or `$PORT`) — application traffic

**Health check:** `GET http://localhost:3000/health`

**Dependencies:** `server` (healthy)

---

### 2.5 Docs

**Purpose:** Static end-user documentation site (Astro + Starlight) served at the `/docs` path prefix.

**Dockerfile:** `applications/docs/Dockerfile`

Build stages:
1. `build` — Node.js 25 slim + pnpm 10; installs dependencies, runs `pnpm --filter @sideline/docs build`, outputs static files to `applications/docs/dist/`
2. `production` — `nginx:alpine`; copies the built static files to `/usr/share/nginx/html/docs` and serves them with a minimal nginx config

**Ports:**
- `:80` — static file serving

**Health check:** `GET http://localhost/health` returns `{"status": "ok"}` — checked up to 3 times (30 s apart, 10 s start period)

**Dependencies:** none

---

## 3. Environment Variables

### 3.1 Server (`applications/server/src/env.ts`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | Yes | — | Node environment (`development`, `production`, `test`) |
| `PORT` | No | `80` | HTTP application port |
| `HEALTH_PORT` | No | `9000` | Health check server port |
| `API_PREFIX` | No | `''` | URL path prefix for the REST API (e.g. `/api`) |
| `RPC_PREFIX` | No | `''` | URL path prefix for the RPC endpoint (e.g. `/rpc/sync`) |
| `SERVER_URL` | Yes | — | Public URL of the server, used for building absolute URLs |
| `DATABASE_HOST` | Yes | — | PostgreSQL host |
| `DATABASE_PORT` | No | `5432` | PostgreSQL port |
| `DATABASE_MAIN` | Yes | — | Postgres maintenance database (used to create `DATABASE_NAME` when they differ) |
| `DATABASE_NAME` | Yes | — | Database name for this deployment |
| `DATABASE_USER` | Yes | — | PostgreSQL username |
| `DATABASE_PASS` | Yes | — | PostgreSQL password (redacted in logs) |
| `DISCORD_CLIENT_ID` | Yes | — | Discord OAuth2 application client ID |
| `DISCORD_CLIENT_SECRET` | Yes | — | Discord OAuth2 application client secret (redacted in logs) |
| `DISCORD_REDIRECT` | Yes | — | Discord OAuth2 redirect URI (must be registered in Discord developer portal) |
| `FRONTEND_URL` | Yes | — | Public URL of the web frontend, used in redirects |
| `LOG_LEVEL` | No | — | Log level filter: `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`. Omit to use the framework default |
| `APP_ENV` | Yes | — | Deployment environment name (e.g. `dev`, `preview`, `production`) |
| `APP_ORIGIN` | Yes | — | Origin hostname (e.g. `sideline-preview.majksa.net`), used as OTEL resource attribute |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Yes | — | OTLP HTTP endpoint for telemetry export |
| `OTEL_SERVICE_NAME` | Yes | — | Service name reported to the telemetry backend (e.g. `sideline-server`) |
| `APP_GLOBAL_ADMIN_DISCORD_IDS` | No | `''` | Comma-separated list of Discord user snowflake IDs that are granted global-admin access. Global admins can read and write translation overrides via the `/api/translations` endpoints and access the `/admin/translations` page in the web app. Empty or unset means no users have global-admin access. Example: `123456789012345678,987654321098765432` |

### 3.2 Bot (`applications/bot/src/env.ts`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | Yes | — | Node environment |
| `DISCORD_BOT_TOKEN` | Yes | — | Discord bot token (redacted in logs) |
| `HEALTH_PORT` | No | `9000` | Health check server port |
| `DISCORD_GATEWAY_INTENTS` | No | `Guilds \| GuildMembers` | Bitmask of Discord gateway intents |
| `RPC_PREFIX` | No | `''` | Path prefix appended to `SERVER_URL` for RPC calls |
| `SERVER_URL` | Yes | — | Base URL of the server (e.g. `http://server:80`) |
| `LOG_LEVEL` | No | — | Log level filter: `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL` |
| `APP_ENV` | Yes | — | Deployment environment name |
| `APP_ORIGIN` | Yes | — | Origin hostname, used as OTEL resource attribute |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Yes | — | OTLP HTTP endpoint for telemetry export |
| `OTEL_SERVICE_NAME` | Yes | — | Service name reported to the telemetry backend (e.g. `sideline-bot`) |

### 3.3 Proxy (runtime environment, from `docker-compose.yaml`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `80` | Port on which nginx listens for application traffic |
| `HEALTH_PORT` | No | `9000` | Port on which nginx listens for health check requests |
| `SERVER_HOST` | Yes | — | Hostname of the server service (Docker service name) |
| `SERVER_PORT` | No | `80` | Port of the server service |
| `WEB_HOST` | Yes | — | Hostname of the web service (Docker service name) |
| `WEB_PORT` | Yes | — | Port of the web service |
| `DOCS_HOST` | Yes | — | Hostname of the docs service (Docker service name, set to `$SERVICE_NAME_DOCS`) |
| `DOCS_PORT` | No | `80` | Port of the docs service |
| `FRONTEND_URL` | Yes | — | Public frontend URL, injected into nginx config for redirect handling |
| `MAX_BODY_SIZE` | No | `0` | nginx `client_max_body_size` value (`0` = unlimited) |

### 3.4 Web (`applications/web/src/env.ts`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SERVER_URL` | Yes | — | URL of the server API, used for server-side fetch requests |
| `PORT` | No | `3000` | Port on which the web server listens |
| `DISCORD_CLIENT_ID` | Yes | — | Discord OAuth2 application client ID, used on the frontend for the OAuth flow |
| `WEB_URL` | No | — | Public base URL of the web app (e.g. `https://sideline.example.com`). When set, the Nitro server plugin rewrites the relative `og:image` URL to an absolute URL for Open Graph / Twitter Card embeds |

---

## 4. Background Cron Jobs

All cron jobs run inside the server process, launched concurrently at startup. They are implemented with Effect's `Schedule.cron` and run indefinitely alongside the HTTP server.

Source files: `applications/server/src/services/*Cron.ts`

| Cron Job | Schedule | Purpose |
|----------|----------|---------|
| `EventHorizonCron` | `0 3 * * *` (daily at 03:00 UTC) | Reads all active event series and generates concrete `events` rows up to each series' horizon window. After inserting each event, resolves the target Discord channel and emits an `event_created` sync event so the bot publishes an embed to Discord. Sync-event failures are logged and suppressed so that event generation always completes. Updates `last_generated_date` on each series after generation. |
| `EventStartCron` | `* * * * *` (every minute) | Finds `active` events whose `start_at` time has passed, transitions each to `started` status, and emits an `event_sync_events` row of type `event_started` for the bot to process (removes RSVP buttons from the Discord embed). |
| `RsvpReminderCron` | `* * * * *` (every minute) | Finds events that need an RSVP reminder (as configured in team settings) and emits `event_sync_events` rows of type `rsvp_reminder` for the bot to process. Marks the event reminder as sent. |
| `AgeCheckCron` | `0 2 * * *` (daily at 02:00 UTC) | Evaluates age threshold rules for every team that has them configured, and automatically moves members between groups based on their age. |
| `TrainingAutoLogCron` | `*/5 * * * *` (every 5 minutes) | Finds ended training events that haven't been auto-logged yet. For each event, inserts an `activity_logs` row for every member who RSVP'd "yes". Ignores duplicate-key violations (idempotent). |
| `WeeklySummaryCron` | `* * * * *` (every minute) | Checks all teams that have a `weekly_summary_channel_id` configured. For each team whose current local time is Sunday 20:00, builds a `WeeklySummaryDigest` and inserts a `weekly_summary_sync_events` row (ON CONFLICT DO NOTHING ensures idempotency). The bot's Weekly Summary worker drains the outbox and posts the embed to the configured Discord channel. Instrumented with the `weekly-summary` metric label. |
| `PaymentReminderCron` | `* * * * *` (every minute) | Finds fee assignments that have crossed a reminder cadence threshold (T−3 days, T+0, T+3, T+10, T+21 days) and have not already been queued for that cadence (no unprocessed `payment_reminder_sync_events` row for the same `(assignment_id, kind)` pair). For each candidate, inserts a row into `payment_reminder_sync_events`. The bot's Finance Sync worker drains the outbox and sends a Discord DM to the member; on successful delivery it calls `Finance/MarkReminderSent` to record the send in `payment_reminders_sent`. Instrumented with the `payment-reminder` metric label. The server must be running for reminders to fire; the bot need not be running for the cron to enqueue them, but the DMs are only delivered while the bot is connected. |

---

## 5. Database Operations

### 5.1 Local Development Database

A standalone `docker-compose.db.yaml` file runs PostgreSQL 17 locally:

```bash
# Start the database
pnpm db:up
# or directly:
docker compose -f docker-compose.db.yaml up -d

# Stop the database
pnpm db:down
```

Local connection details:
- Host: `localhost`
- Port: `5432`
- User: `sideline`
- Password: `sideline`
- Database: `sideline`
- Connection string: `postgresql://sideline:sideline@localhost:5432/sideline`

The default `.env.example` provides the `DATABASE_URL` for local use.

### 5.2 Migrations

Migrations are managed by the `@sideline/migrations` workspace package, which uses `@effect/sql`'s migrator. There are two migration phases:

| Phase | Timing | Content |
|-------|--------|---------|
| **Before** (`packages/migrations/src/before/`) | Before the server starts accepting requests | Schema changes: `CREATE TABLE`, `ALTER TABLE`, index creation |
| **After** (`packages/migrations/src/after/`) | After the server is healthy, concurrently | Seed data: built-in roles, default activity types |

Migrations run automatically each time the server starts. They are idempotent — already-applied migrations are skipped. Migration files are named with a timestamp prefix for ordering.

### 5.3 Preview Database Access

Each pull request gets its own isolated PostgreSQL database on a shared preview server. The database name follows the convention `sideline-preview-{PR_ID}.majksa.net`.

The server automatically creates the PR database on startup when `DATABASE_MAIN` differs from `DATABASE_NAME` (as configured in the preview `docker-compose.yaml`).

#### Connecting to a preview database

The `bin/psql` wrapper script handles credential loading and connection string construction. The `bin/` directory is on `PATH` via `.envrc`.

```bash
# Connect to PR 108's preview database
psql --pr 108

# Run a query against PR 108's database
psql --pr 108 -c "SELECT * FROM teams"

# Connect to the main (non-PR) preview database
psql
```

#### Credential files

| File | Purpose | Committed |
|------|---------|-----------|
| `.env.preview` | Host, port, user, database name templates | Yes |
| `.env.preview.local` | `PREVIEW_DB_PASSWORD` only | No (gitignored) |

`.env.preview` contents (for reference):

```bash
export PREVIEW_DB_HOST=202.61.194.146
export PREVIEW_DB_PORT=55432
export PREVIEW_DB_USER=sideline
export PREVIEW_DB_NAME_PR="sideline-preview-${PREVIEW_PR_ID}.majksa.net"
export PREVIEW_DB_NAME_MAIN="sideline-preview.majksa.net"
```

`.env.preview.local` must contain:

```bash
export PREVIEW_DB_PASSWORD=<password>
```

---

## 6. CI/CD Pipelines

All pipelines are defined in `.github/workflows/`. The shared setup action (`.github/actions/setup/`) installs pnpm and Node.js 25, then runs `pnpm install`.

### 6.1 `check.yml` — Quality Gates

Triggers on every push to `main` and every pull request targeting `main`. Runs with `concurrency` (cancel-in-progress for PRs).

| Job | Command | Purpose |
|-----|---------|---------|
| Lint & Format | `pnpm lint` | Biome formatting and lint rules |
| Build | `pnpm codegen` + source-state check | Verifies that codegen produces no uncommitted changes in `packages/*/src` |
| Types | `pnpm codegen && pnpm build && pnpm check` | Full TypeScript type-check across all packages |
| Test | `pnpm build && pnpm test` | Builds all packages, then runs the Vitest suite (`NODE_OPTIONS=--max_old_space_size=8192`) |

### 6.2 `release.yml` — Versioning and Docker Publish

Triggers on every push to `main`. Uses Changesets to manage versions and releases.

**Step 1 — Release job:**
1. Runs the Changesets action (`changesets/action`).
2. If there are pending changesets, opens or updates a "Version Packages" release PR.
3. When the release PR is merged, publishes new package versions (`pnpm changeset-publish`) and creates GitHub releases.
4. Detects which published packages correspond to applications under `applications/` and outputs the list as `changed-apps`.

**Step 2 — Docker job (matrix, one job per changed app):**
1. Reads the new version from `applications/<app>/package.json`.
2. Logs in to GHCR with `GITHUB_TOKEN`.
3. Sets up Docker Buildx.
4. Builds the Docker image from the root context using `applications/<app>/Dockerfile`.
5. Pushes to `ghcr.io/maxa-ondrej/sideline/<app>` with the following tags:
   - `<version>` (e.g. `1.2.3`)
   - `main` (branch name)
   - `sha-<commit>` (short SHA)
6. Dispatches a `deploy` event to `maxa-ondrej/majksa-ops` with the payload `{"env":"dev","app":"sideline","service":"<app>","version":"<version>"}` — this triggers automated deployment in the ops repository.

Required secrets: `GH_PAT` (personal access token with write access), `NPM_TOKEN`.

### 6.3 `publish.yml` — Manual Tag-Based Docker Publish

Triggers on any git tag push (e.g. `@sideline/server@1.2.3`).

**Detect job:**
- Strips the `@sideline/` prefix and version suffix from the tag name.
- Checks whether the resulting name is a directory under `applications/`.
- Outputs `is_app=true` and the `app` name if so.

**Docker job (runs only when `is_app=true`):**
1. Logs in to GHCR.
2. Builds the Docker image from the root context using `applications/<app>/Dockerfile`.
3. Pushes to `ghcr.io/maxa-ondrej/sideline/<app>` with:
   - The exact tag ref (e.g. `@sideline/server@1.2.3`)
   - `sha-<commit>` (short SHA)

This workflow is useful for republishing a specific tagged version without going through the full release flow.

### 6.4 `close-preview.yml` — Preview Cleanup

Triggers when a PR targeting `main` is closed, or can be triggered manually with a PR number.

**Database job:**
- Installs `psql` (PostgreSQL 17 client).
- Attempts to drop the database `sideline-preview-{PR_ID}.majksa.net` with up to 15 retries (60 s apart) to handle in-flight connections.

Required secrets: `SIDELINE_DB_HOST`, `SIDELINE_DB_PORT`, `SIDELINE_DB_USER`, `SIDELINE_DB_PASSWORD`.

---

## 7. Monitoring and Observability

### 7.1 OpenTelemetry

Both the server and the bot export logs, traces, and metrics via the OTLP HTTP protocol to a SigNoz instance. The telemetry layer is configured in each application's `run.ts` using `Telemetry.makeTelemetryLayer` from `@sideline/effect-lib`:

```typescript
Runtime.runMain(
  env.NODE_ENV,
  env.LOG_LEVEL,
  Telemetry.makeTelemetryLayer({
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: env.OTEL_SERVICE_NAME,
    environment: env.APP_ENV,
    origin: env.APP_ORIGIN,
  }),
)
```

### 7.2 Resource Attributes

| Attribute | Source Env Var | Example Value |
|-----------|---------------|---------------|
| `service.name` | `OTEL_SERVICE_NAME` | `sideline-server` |
| `deployment.environment` | `APP_ENV` | `preview`, `dev`, `production` |
| `service.origin` | `APP_ORIGIN` | `sideline-preview.majksa.net` |

### 7.3 Service Names

| Application | `service.name` |
|-------------|----------------|
| Server | `sideline-server` |
| Bot | `sideline-bot` |

### 7.4 Log Levels

Controlled by the `LOG_LEVEL` environment variable. Accepted values: `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`. Omitting the variable uses the framework default.

### 7.5 Querying in SigNoz

For efficient queries, always filter by resource attributes first:

- `service.name = 'sideline-server'` — scope to a specific service
- `deployment.environment = 'preview'` — scope to a specific environment
- Combine both to narrow results to a single service in a single environment

Each cron job and application module includes log spans (e.g. `age-check-cron`, `event-horizon-cron`) which appear in traces and can be used to correlate cron execution with downstream effects.

---

## 8. Local Development Setup

### 8.1 Prerequisites

- **Node.js 25+** — see `.nvmrc` or use the flake (`nix develop`)
- **pnpm 10+** — installed automatically by the setup action; install locally with `npm install -g pnpm`
- **Docker** — required for the local PostgreSQL container
- **Discord application** — a bot token, OAuth2 client ID, and client secret from the [Discord developer portal](https://discord.com/developers/applications)

### 8.2 First-Time Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Start the local database (PostgreSQL 17 on port 5432)
pnpm db:up

# 3. Copy the environment file template and fill in your credentials
cp .env.example .env.local
# Edit .env.local and fill in:
#   DISCORD_CLIENT_ID
#   DISCORD_CLIENT_SECRET
#   DISCORD_BOT_TOKEN
#   SERVER_URL, FRONTEND_URL, DISCORD_REDIRECT (for the server)
#   APP_ENV, APP_ORIGIN, OTEL_* (for telemetry)

# 4. Generate code and build all packages
pnpm codegen && pnpm build
```

### 8.3 Running Services

Each service can be started individually from its application directory:

```bash
# Start all services in parallel (dev mode)
pnpm dev

# Or start each service individually:
cd applications/server && pnpm dev
cd applications/bot    && pnpm dev
cd applications/web    && pnpm dev
```

Migrations run automatically when the server starts. On first run they will create all tables and seed the default roles and activity types.

### 8.4 Useful Commands

```bash
pnpm build          # Build all packages and applications
pnpm check          # TypeScript type-check
pnpm test           # Run the full test suite
pnpm lint           # Biome lint and format check
pnpm format         # Auto-fix formatting (biome)
pnpm codegen        # Regenerate derived code (route types, index exports)
pnpm clean          # Remove stale build artifacts

pnpm db:up          # Start local PostgreSQL
pnpm db:down        # Stop local PostgreSQL

psql                # Connect to main preview database (requires .env.preview.local)
psql --pr 42        # Connect to PR 42's preview database
```

---

## 9. Troubleshooting

### 9.1 Database Connection Failures

**Symptom:** Server exits immediately with a connection error on startup.

**Checks:**
- Verify PostgreSQL is running: `docker compose -f docker-compose.db.yaml ps`
- Check `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USER`, `DATABASE_PASS`, and `DATABASE_NAME` in your `.env.local`
- Confirm the database user has `CREATEDB` privileges if `DATABASE_MAIN != DATABASE_NAME` (needed for preview environments)
- For Docker Compose deployments, ensure the service depends on a healthy `postgres` container

### 9.2 Migration Errors

**Symptom:** Server starts but logs migration errors; requests fail with "table does not exist".

**Checks:**
- Migrations run automatically before the server opens its port. If they fail, the server will exit.
- Check for conflicting database state: if a migration was partially applied (e.g. after a force-kill), you may need to manually clean up. The migrator stores its state in a `migrations` table.
- After adding new migration files to `packages/migrations/`, run `pnpm build` to recompile the migrations package before starting the server.

### 9.3 Bot Not Connecting to Gateway

**Symptom:** Bot container starts but no slash commands are registered; Discord gateway logs show errors.

**Checks:**
- Verify `DISCORD_BOT_TOKEN` is set and valid (test with a direct Discord API call)
- Ensure the server is healthy before the bot starts — the bot's `depends_on: server: condition: service_healthy` enforces this in Docker Compose, but in local dev you must start the server first
- Check `SERVER_URL` and `RPC_PREFIX` match the server's configured `RPC_PREFIX`
- Verify `DISCORD_GATEWAY_INTENTS` includes at least `Guilds` and `GuildMembers` (the default bitmask is `3`)

### 9.4 Health Check Failures

**Symptom:** Docker Compose reports a service as unhealthy; dependent services never start.

**Checks:**
- The server health check retries up to 15 times with a 30 s interval and a 30 s start period — migration-heavy first starts can take several minutes. Wait before concluding there is a problem.
- Confirm the health port (`HEALTH_PORT`, default `9000`) is not occupied by another process
- Check container logs: `docker compose logs server` or `docker compose logs bot`

### 9.5 Preview Database Access Issues

**Symptom:** `psql --pr 42` fails to connect.

**Checks:**
- Ensure `.env.preview.local` exists and exports `PREVIEW_DB_PASSWORD`
- Confirm the PR number is correct and the preview environment was deployed (check GitHub Actions for the preview deployment)
- The preview database host is `202.61.194.146:55432` — verify network access from your machine
- Use `close-preview.yml` manually (via workflow dispatch) to drop a stale database if the automated cleanup failed

### 9.6 Type Errors After Domain Changes

When type errors appear after modifying `packages/domain/`, stale `.d.ts` files in the `dist/` directories are often the cause:

```bash
pnpm codegen && pnpm build && find . -name '*.tsbuildinfo' -delete && pnpm check
```

### 9.7 Bot Slash Commands Not Updating

Discord caches slash command registrations globally. After adding or modifying commands:
- Allow up to 1 hour for global propagation
- For immediate testing, use guild-specific command registration (add a `GUILD_ID` env var if supported by the bot command registration logic)
- Restart the bot container to trigger re-registration on startup

### 9.8 OTEL Telemetry Not Appearing

**Checks:**
- Verify `OTEL_EXPORTER_OTLP_ENDPOINT` is reachable from the container network
- Confirm `OTEL_SERVICE_NAME`, `APP_ENV`, and `APP_ORIGIN` are all set — missing values will prevent telemetry layer initialization
- Check that the OTLP endpoint accepts HTTP (not HTTPS) if the URL does not use TLS; the current preview endpoint uses HTTPS (`https://otelcollectorhttp-*.majksa.net/`)
