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

**Container registry:** `ghcr.io/sideline-cz/sideline/<app>`

---

## 2. Service Details

Every app follows MajNet's standard health/info convention (ADR 0020) on its health port: `GET /healthz` is a bare liveness probe (`{"status": "ok"}`), and `GET /info` returns `{version, commit, build_time}` sourced from the `APP_VERSION` / `GIT_COMMIT` / `BUILD_TIME` env vars baked in at image build time via Docker `ARG`s (see [6.3](#63-releaseyaml-majnet-release-stable--production)). The legacy `GET /health` endpoint is unchanged and kept alongside `/healthz` for backward compatibility — it is what the Docker Compose/ops health-check manifests actually declare today.

### 2.1 Proxy

**Purpose:** Terminates inbound HTTP traffic, forwards `/api/*` to the server, and all other paths to the web frontend. Handles the Discord OAuth callback redirect in a small njs script (`preview_redirect.js`).

**Dockerfile:** `applications/proxy/Dockerfile`
- Base image: `nginx` with `nginx-module-njs` installed
- Copies nginx configuration, njs script, and template files into the image
- Template files in `/etc/nginx/templates/` are expanded at container start using nginx's built-in envsubst support

**Ports:**
- `:80` (or `$PORT`) — application traffic
- `:9000` (or `$HEALTH_PORT`) — health check server

**Health check:** `GET http://localhost:9000/health` returns `{"status": "ok"}` (also served on `/healthz`; `/info` on the same port returns version metadata)

**Dependencies:** `server` (healthy), `web` (healthy), `docs` (healthy)

**Routing rules (nginx.conf):**
- `GET /api/auth/callback` — handled inline by njs script
- `GET /api/*` — proxied to `http://$SERVER_HOST:$SERVER_PORT`
- `GET /docs` — 301 redirect to `/docs/`
- `GET /docs/*` — proxied to `http://$DOCS_HOST:$DOCS_PORT`
- `GET /*` — proxied to `http://$WEB_HOST:$WEB_PORT`

---

### 2.2 Server

**Purpose:** The core HTTP API server. Exposes the REST API (under `$API_PREFIX`, default `/api`), an internal RPC endpoint for the bot (under `$RPC_PREFIX`, default `/rpc/sync`), and runs nine background cron jobs.

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

**Health check:** `GET http://localhost:9000/health` — checked up to 15 times (30 s apart, 30 s start period). The same port also serves `/healthz` (liveness) and `/info` (`{version, commit, build_time}`).

**Dependencies:** PostgreSQL

**Startup sequence (`applications/server/src/run.ts`):**

1. If `DATABASE_MAIN != DATABASE_NAME`, creates the target database (used for preview environments where each PR has an isolated database).
2. Runs "before" migrations (schema changes).
3. Launches all of the following concurrently (concurrency: 10):
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
   - `TrainingClaimRequestCron`
   - `CoachingStatusCron`

The `Runtime.runMain` wrapper configures the OpenTelemetry telemetry layer before starting.

---

### 2.3 Bot

**Purpose:** Discord bot. Connects to the Discord gateway, registers slash commands, handles interactions, and runs long-polling sync worker loops that poll the server RPC endpoint to process role, channel, event, achievement, role-provision, and weekly-summary sync events.

**Dockerfile:** `applications/bot/Dockerfile`

Build stages are identical in structure to the server Dockerfile: `base` → `deps` → `build` → `production`.

**Entry point:** `node applications/bot/build/run.js`

**Ports:**
- `:9000` (or `$HEALTH_PORT`) — health check only (no external application port)

**Health check:** `GET http://localhost:9000/health` (also served on `/healthz`; `/info` on the same port returns version metadata)

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

**Health check:** `GET http://localhost:3000/health` (also served on `/healthz`; `/info` returns `{version, commit, build_time}` read server-side from `APP_VERSION`/`GIT_COMMIT`/`BUILD_TIME`, falling back to `"dev"`/`"unknown"`/`null`)

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

**Health check:** `GET http://localhost/health` returns `{"status": "ok"}` — checked up to 3 times (30 s apart, 10 s start period). `/healthz` returns the same payload; `/info` returns `{version, commit, build_time}` rendered from the nginx config template (`nginx.conf.template`) via envsubst at container start.

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
| `APP_GLOBAL_ADMIN_DISCORD_IDS` | No | `''` | Comma-separated list of Discord user snowflake IDs that are granted global-admin access. A user is a global admin when **either** their `users.is_global_admin` DB flag is `true` **or** their Discord ID appears in this list — the two sources are combined with OR. The first user to register on a fresh database is automatically promoted via the DB flag. This env list exists for backward compatibility and for bootstrap scenarios where the DB flag cannot yet be set. Empty or unset means no env-list admins, but DB-flagged users still have access. Example: `123456789012345678,987654321098765432` |
| `EMAIL_WEBHOOK_SIGNING_SECRET` | **Yes** | — | HMAC-SHA-256 signing secret used to verify inbound email webhook payloads. Every `POST /email/inbound/:token` request must include an `X-Signature` header whose value is `HMAC-SHA256(raw_body, EMAIL_WEBHOOK_SIGNING_SECRET)` in hex. Requests with a missing or invalid signature are rejected with `401`. Required even when email forwarding is not actively used. |
| `EMAIL_IMAP_ENCRYPTION_KEY` | No | — | AES-256-GCM encryption key used by `EmailSecretCrypto` to encrypt/decrypt IMAP app-passwords stored in `email_forwarding_config.imap_secret_encrypted`. Must be a base64-encoded 32-byte key. Only required once at least one team enables IMAP polling; the IMAP feature is silently unavailable without it (saving a secret via the API will fail with a server error if unset). Generate with: `openssl rand -base64 32` |
| `LLM_API_URL` | No | `''` | Base URL of the OpenAI-compatible LLM API used for email summarization (e.g. `https://api.openai.com/v1`). When empty or unset, the AI summarization pipeline uses a deterministic stub that returns the first 500 characters of the email body as the summary. |
| `LLM_API_KEY` | No | — | API key for the LLM service. Redacted in logs. Required when `LLM_API_URL` is set; ignored otherwise. |
| `LLM_MODEL` | No | `gpt-4o-mini` | Model identifier passed to the LLM API (e.g. `gpt-4o`, `gpt-4o-mini`). Ignored when `LLM_API_URL` is empty. |

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
| `WEB_URL` | No | — | Public base URL of the web frontend (e.g. `https://sideline.example.com`). When set, the bot includes a deep-link to `/teams/{teamId}/challenges` in weekly challenge embeds. In production this is set to `${SERVICE_URL_PROXY}` via `docker-compose.yaml`. |

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
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | — | OTLP HTTP endpoint for telemetry export. When omitted, telemetry is disabled |
| `OTEL_SERVICE_NAME` | No | `sideline-web` | Service name reported to the telemetry backend |
| `APP_ENV` | No | — | Deployment environment name (e.g. `dev`, `preview`, `production`), reported as the `deployment.environment` OTEL resource attribute |
| `APP_ORIGIN` | No | — | Origin hostname (e.g. `sideline-preview.majksa.net`), reported as the `service.origin` OTEL resource attribute |

---

## 4. Background Cron Jobs

All cron jobs run inside the server process, launched concurrently at startup. They are implemented with Effect's `Schedule.cron` and run indefinitely alongside the HTTP server.

Source files: `applications/server/src/services/*Cron.ts`

| Cron Job | Schedule | Purpose |
|----------|----------|---------|
| `EventHorizonCron` | `0 3 * * *` (daily at 03:00 UTC) | Reads all active event series and generates concrete `events` rows up to each series' horizon window. After inserting each event, resolves the target Discord channel and emits an `event_created` sync event so the bot publishes an embed to Discord. Sync-event failures are logged and suppressed so that event generation always completes. Updates `last_generated_date` on each series after generation. |
| `EventStartCron` | `* * * * *` (every minute) | Finds `active` events whose `start_at` time has passed, transitions each to `started` status, and emits an `event_sync_events` row of type `event_started` for the bot to process (removes RSVP buttons from the Discord embed). Also marks the event's `personal_messages_dirty_at` so the reconcile worker removes it from members' personal channels, and runs a once-per-cycle self-healing sweep that re-marks any non-active/past event still holding `personal_event_messages` rows. |
| `RsvpReminderCron` | `* * * * *` (every minute) | Finds events that need an RSVP reminder (as configured in team settings) and emits `event_sync_events` rows of type `rsvp_reminder` for the bot to process. Marks the event reminder as sent. |
| `AgeCheckCron` | `0 2 * * *` (daily at 02:00 UTC) | Evaluates age threshold rules for every team that has them configured, and automatically moves members between groups based on their age. |
| `TrainingAutoLogCron` | `*/5 * * * *` (every 5 minutes) | Finds ended training events that haven't been auto-logged yet. For each event, inserts an `activity_logs` row for every member who RSVP'd "yes". Ignores duplicate-key violations (idempotent). |
| `WeeklySummaryCron` | `* * * * *` (every minute) | Checks all teams that have a `weekly_summary_channel_id` configured. For each team whose current local time is Sunday 20:00, builds a `WeeklySummaryDigest` and inserts a `weekly_summary_sync_events` row (ON CONFLICT DO NOTHING ensures idempotency). The bot's Weekly Summary worker drains the outbox and posts the embed to the configured Discord channel. Instrumented with the `weekly-summary` metric label. |
| `PaymentReminderCron` | `* * * * *` (every minute) | Finds fee assignments that have crossed a reminder cadence threshold (T−3 days, T+0, T+3, T+10, T+21 days) and have not already been queued for that cadence (no unprocessed `payment_reminder_sync_events` row for the same `(assignment_id, kind)` pair). For each candidate, inserts a row into `payment_reminder_sync_events`. The bot's Finance Sync worker drains the outbox and sends a Discord DM to the member; on successful delivery it calls `Finance/MarkReminderSent` to record the send in `payment_reminders_sent`. Instrumented with the `payment-reminder` metric label. The server must be running for reminders to fire; the bot need not be running for the cron to enqueue them, but the DMs are only delivered while the bot is connected. |
| `TrainingClaimRequestCron` | `* * * * *` (every minute) | Finds training events whose `claim_request_sent_at` is NULL and whose `start_at` is within `team_settings.claim_request_days_before` days. For each, resolves the owner group's Discord channel via `DiscordChannelMappingRepository` and emits a `training_claim_request` sync event. Sets `claim_request_sent_at = now()` on the event after queuing (or immediately if no channel can be resolved, to prevent repeated retries). Instrumented with the `training-claim-request` metric label. |
| `CoachingStatusCron` | `* * * * *` (every minute) | Finds claimed training events whose `coaching_status_sent_at` is NULL and whose `start_at` is on the current calendar day. For each, resolves the target Discord channel: first tries `team_settings.discord_channel_training`; falls back to the owner group's channel via `DiscordChannelMappingRepository`. Emits a `coaching_status` sync event so the bot posts a "today's coach is X" announcement to the member training channel. Sets `coaching_status_sent_at = now()` on the event. Instrumented with the `coaching-status` metric label. |

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

### 6.2 `build.yaml` — MajNet Build (Preview & Testing Images)

Triggers on every push to `main` and every pull request. There is no versioning step — this workflow only builds and publishes images.

For each app in the matrix (`proxy`, `server`, `web`, `docs`, `bot`), calls MajNet's reusable `app-build.yaml` workflow (`majnet/majnet@main`), which builds the Docker image from the root context using `applications/<app>/Dockerfile` and pushes it to the nested image `ghcr.io/<owner>/<repo>/<app>` with build-tier tags:
- Pull requests → `pr-<N>` (ephemeral preview image)
- `main` → `sha-<sha>` and `latest` (auto-deployed to MajNet's **testing** class)

The GHCR `registry_package` webhook fired by the push notifies the MajNet bot, which maps the package name to the MajNet app and drives the deploy.

### 6.3 `release.yaml` — MajNet Release (Stable & Production)

Triggers on push of a per-app `@sideline/<app>@vX.Y.Z` git tag (continuing the historical tag naming) — each tag releases that one app; all apps are normally tagged together at one shared version. A plain `vX.Y.Z` tag is a supported fallback that releases every app at once (MajNet ADR 0009/0018). There is no per-package Changesets versioning anymore.

A `resolve` job parses the tag into a matrix of app(s) and the resolved `version`. The `release` job then delegates the actual build/push to MajNet's reusable `app-release.yaml` workflow (MajNet ADR 0020), passing `version` through explicitly as the image tag (`ghcr.io/<owner>/<repo>/<app>:vX.Y.Z`) rather than letting it derive the tag from the git ref name — which the per-app tags prefix and would otherwise mis-parse. The reusable workflow also bakes `version`, the resolved commit SHA, and the build timestamp into the image as Docker build-args (`VERSION`, `GIT_COMMIT`, `BUILD_TIME`), which each app's `Dockerfile` promotes to `APP_VERSION`/`GIT_COMMIT`/`BUILD_TIME` env vars so the running container can report them at `GET /info` (see [2. Service Details](#2-service-details)).

The GHCR `registry_package` webhook tells the MajNet bot, which records the release (version → digest) and auto-tracks it into the **stable** class — the bot opens and auto-merges a render PR on `sideline-cz/ops` targeting `env/stable`.

**Production** is a separate, manually triggered **promote** of a chosen release (MajNet dashboard or CLI): the bot commits the digest to the production overlay and opens an `env/production` render PR on `sideline-cz/ops`. Merging that render PR — gated on admin review — is the production deploy trigger; the reconciler then converges the cluster. See `.claude/skills/deploy/SKILL.md` for the full operator-facing flow.

### 6.4 `close-preview.yml` — Preview Cleanup

Triggers when a PR targeting `main` is closed, or can be triggered manually with a PR number.

**Database job:**
- Installs `psql` (PostgreSQL 17 client).
- Attempts to drop the database `sideline-preview-{PR_ID}.majksa.net` with up to 15 retries (60 s apart) to handle in-flight connections.

Required secrets: `SIDELINE_DB_HOST`, `SIDELINE_DB_PORT`, `SIDELINE_DB_USER`, `SIDELINE_DB_PASSWORD`.

---

## 7. Monitoring and Observability

### 7.1 OpenTelemetry

The server, bot, and web frontend all export telemetry via the OTLP HTTP protocol to a SigNoz instance.

**Server and bot** use `Telemetry.makeTelemetryLayer` from `@sideline/effect-lib`, configured in each application's `run.ts`:

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

**Web frontend** uses its own `makeTelemetryLayer` in `applications/web/src/lib/telemetry.ts`, initialised from `fetchEnv` in the root route's `beforeLoad` hook. The web layer uses the browser Fetch API as the OTLP transport instead of Node.js HTTP. Telemetry is optional — when `OTEL_EXPORTER_OTLP_ENDPOINT` is not set, the layer is a no-op.

**Crash beacons (pre-runtime OTLP):** The Nitro server plugin `server/plugins/otlp-endpoint.ts` injects `window.__SIDELINE_OTLP__ = "<endpoint>"` into the HTML `<head>` of every SSR response. This allows `crashBeacon.ts` (and the inline `preMountGuard` watchdog script) to fire `navigator.sendBeacon` directly to the OTLP collector for crashes that occur before the Effect runtime is initialised — for example, a JS bundle load failure or a React mount crash before `beforeLoad` completes. Requires `OTEL_EXPORTER_OTLP_ENDPOINT` to be set on the web service; when it is unset no script tag is injected and crash beacons are silently dropped.

In addition to traces, the web frontend reports the following OTEL histogram metrics:

| Metric | Description |
|--------|-------------|
| `web_vitals_lcp_ms` | Largest Contentful Paint (ms) |
| `web_vitals_cls` | Cumulative Layout Shift score |
| `web_vitals_fcp_ms` | First Contentful Paint (ms) |
| `web_vitals_inp_ms` | Interaction to Next Paint (ms) |
| `web_vitals_ttfb_ms` | Time to First Byte (ms) |
| `page_load_ms` | Full page load time (`loadEventEnd`) in ms |
| `react_render_ms` | React component tree render duration (ms) |

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
| Web | `sideline-web` (default; overridden by `OTEL_SERVICE_NAME`) |

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

### 9.8 Web App Shows a Blank or White Screen

**Symptom:** The app URL loads but the browser displays a blank or white screen — no UI renders.

**What the app does automatically:** The web frontend has a layered crash-recovery system that handles most cases without user intervention:

1. **Pre-mount watchdog (`preMountGuard`):** An inline ES5 script injected before the JS bundle sets a 10-second watchdog timer. If the React root has not mounted within 10 seconds (e.g. due to a JS bundle fetch failure), the watchdog replaces the page body with a recovery UI offering two buttons: **Reload** and **Reset app**. Reload retries the page (capped at 2 automatic attempts via a session-storage counter). Reset app unregisters the service worker and clears caches before reloading.
2. **Vite preload-error guard:** If a JS chunk fails to load (stale service-worker cache after a deployment), the app automatically reloads once to fetch the latest bundle.
3. **`AppErrorBoundary` (React error boundary):** Wraps the entire component tree. If React throws during render, the boundary first attempts a silent one-shot automatic reload (via `requestAutoReloadOnce`) — showing a minimal `AppReloadingScreen` spinner for the brief moment before the page reloads. This auto-reload is bounded by a separate `sideline-auto-reload-count` session-storage counter (cap: 1) and is also gated by the shared reload cap, so it cannot chain into a loop. Only if the auto-reload budget is already spent (or sessionStorage is unavailable) does the boundary fall back to rendering the **Reload / Reset app** fallback screen and sending a crash beacon to the OTLP collector (`crashBeacon.ts`).

**Manual recovery steps for users:**

- Click **Reload** on the error screen (or reload the browser tab manually).
- If blank screen persists: click **Reset app**. This unregisters the service worker and clears the offline cache, then reloads a fresh copy. The user stays logged in — only cached offline data is cleared.
- If the problem persists: force-clear site data from the browser (DevTools → Application → Storage → Clear site data) and reload.

**Operator checks:**

- A blank screen with no JS errors often means a stale service worker is serving a cached `index.html` that references chunks from a previous build. Check `OTEL_EXPORTER_OTLP_ENDPOINT` is set so crash beacons reach SigNoz — filter by `service.name = 'sideline-web'` and `body CONTAINS 'pre-mount'` or `body CONTAINS 'boundary'`.
- If the crash happened before the Effect runtime initialised, the beacon arrives via `navigator.sendBeacon` to the OTLP endpoint directly (not via the Effect logging pipeline). These events will appear as raw JSON payloads; their `phase` field will be `pre-mount`, `boundary`, or `preload-error`.

### 9.9 OTEL Telemetry Not Appearing

**Checks:**
- Verify `OTEL_EXPORTER_OTLP_ENDPOINT` is reachable from the container network (for server/bot) or from the browser (for web)
- For the **server** and **bot**, `OTEL_SERVICE_NAME`, `APP_ENV`, and `APP_ORIGIN` are required — missing values will prevent telemetry layer initialisation
- For the **web** frontend, all four OTEL env vars are optional; when `OTEL_EXPORTER_OTLP_ENDPOINT` is absent the telemetry layer is silently disabled
- Check that the OTLP endpoint accepts HTTP (not HTTPS) if the URL does not use TLS; the current preview endpoint uses HTTPS (`https://otelcollectorhttp-*.majksa.net/`)
- Web Vitals and React render metrics are only emitted in the browser — they will not appear in server-side SSR traces
