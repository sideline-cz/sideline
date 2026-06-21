# AGENTS.md

## Project Overview

This is an **Effect-TS monorepo** built with TypeScript, utilizing a modern functional programming approach. The project emphasizes type safety, composable effects, and structured concurrency through the Effect ecosystem.

### Architecture

```
applications/
├── bot/       — Discord bot (dfx, Effect-native)            → see applications/bot/AGENTS.md
├── server/    — HTTP API server (Effect + PostgreSQL)       → see applications/server/AGENTS.md
├── web/       — TanStack Start frontend (React 19, Vite)    → see applications/web/AGENTS.md
├── docs/      — End-user product docs (Astro + Starlight)   → see applications/docs/AGENTS.md
└── proxy/     — Reverse proxy (nginx-like routing)
packages/
├── domain/    — Core domain models and API contracts     → see packages/domain/AGENTS.md
├── effect-lib/— Shared Effect utilities (Bind, Schemas)  → see packages/effect-lib/AGENTS.md
├── i18n/      — Translation system (Paraglide.js)        → see packages/i18n/AGENTS.md
├── migrations/— Database migrations (Effect SQL)         → see packages/migrations/AGENTS.md
└── template-renderer/ — Pure welcome-template rendering (no Effect) → see packages/template-renderer/AGENTS.md
```

Each application follows an **AppLive + run.ts** pattern:
- **`AppLive`** — a composable `Layer` that wires up the application's core services without runtime concerns (config, logging, connection details). This is the unit that can be tested or composed into larger systems.
- **`run.ts`** — the deployment entrypoint that provides environment-specific layers (PgClient, NodeHttpServer, Logger, Config) and calls `NodeRuntime.runMain`.

The **migrations** package exports `MigratorLive` — a layer that only needs a `PgClient` and filesystem. Consumers provide their own `PgClient`, keeping the migration package decoupled from connection config.

## Technology Stack

- **TypeScript 5.6+** — Strict mode, NodeNext module resolution, ES2022 target
- **Effect-TS 3.10+** — Functional effect system for composable, type-safe programs
- **pnpm** — Fast, disk-efficient package manager (workspace-aware). Always use bare `pnpm` command, never `npx pnpm@...`
- **Vitest 3.2+** — Testing framework with Effect integration (`@effect/vitest`)
- **Biome.js** — Fast linting and formatting
- **Changesets** — Version management and changelog generation
- **Husky + lint-staged** — Pre-commit hooks (auto-format via biome)

## Effect-TS Patterns

### The Effect Type

```typescript
Effect<Success, Error, Requirements>
```

- `Success (A)` — The value type on success
- `Error (E)` — The error type(s) that can occur
- `Requirements (R)` — Services/dependencies needed to run

**Key Principle**: Effects are **blueprints**, not imperative actions. They describe programs that the runtime executes.

### Dependency Injection

Use **covariant union types** (not intersections) for services:

```typescript
class DatabaseService extends Effect.Tag("DatabaseService")<
  DatabaseService,
  { query: (sql: string) => Effect.Effect<Result> }
>() {}

// Dependencies merge as R = DatabaseService | CacheService
```

### Service Patterns

- Use `Effect.Tag` for service definitions with static method access
- Use `Layer` for service construction and dependency wiring
- Use `ManagedRuntime` for service lifecycle in external frameworks
- Prefer `Effect.provide` over manual dependency passing

### Configuration

```typescript
import { Config } from "effect"
const dbUrl = Config.string("DATABASE_URL")
const port = Config.number("PORT").pipe(Config.withDefault(3000))
const apiKey = Config.redacted("API_KEY")
```

### Error Handling

Typed errors automatically merge into unions. Handle specific errors with `Effect.catchTag`.

#### Rules

1. **`Effect.catchAll` does NOT exist** in the Effect 4 beta used by this repo — the operator is `Effect.catch` (catches every typed failure). Prefer `Effect.catchTag` with explicit error tags. Only fall back to `Effect.catch` when a handler genuinely needs to handle every typed failure uniformly (e.g. the outer `Effect.catch((error) => ...)` wrapper inside `ProcessorService.processEvent` that funnels all per-event failures into a `MarkFailed` RPC):
   ```typescript
   // ✗ Bad — Effect.catchAll is not a real export; this is a TypeError at runtime
   Effect.catchAll(() => Effect.void)

   // ✓ Good — explicit about which errors are handled
   Effect.catchTag('NoSuchElementException', () => Effect.void)
   Effect.catchTag('SqlError', 'ParseError', LogicError.withMessage(
     (e) => `Failed fetching user ${id}: ${e}`
   ))

   // ✓ Acceptable — outer catch-everything inside a per-event processor
   Effect.catch((error) => markEventFailed(eventId, formatError(error)))
   ```

2. **Never use `Effect.orDie` or `Effect.die`** — use `LogicError` from `@sideline/effect-lib` instead:
   ```typescript
   import { LogicError } from '@sideline/effect-lib'

   // ✗ Bad — loses error context, generic defect
   Effect.orDie
   Effect.catchTag('SqlError', Effect.die)

   // ✗ Bad — `HttpServerResponse.json(...).pipe(Effect.orDie)` to silence the encode error
   HttpServerResponse.json(payload).pipe(Effect.orDie)

   // ✓ Good — descriptive defect with cause chain
   Effect.catchTag('SqlError', 'ParseError', LogicError.withMessage(
     (e) => `Failed fetching user ${id}: ${e}`
   ))

   // ✓ Good — standalone defect
   LogicError.die('Training activity type not found')

   // ✓ Good — INSERT ... RETURNING always yields one row; map NoSuchElement to a descriptive defect
   insertChallengeQuery(input).pipe(
     SqlErrors.catchUniqueViolation(() => new WeeklyChallengeAlreadyExistsForWeek()),
     catchSqlErrors,
     Effect.catchTag('NoSuchElementError', () =>
       LogicError.die('Weekly challenge insert returned no row'),
     ),
   )
   ```

   The single sanctioned exception to the `Effect.die` ban is **re-raising a defect you have just captured unchanged**: when a `catchDefect` handler must let some defects through (e.g. retry on a unique-violation defect but propagate every other defect untouched), re-raise the captured value with `Effect.failCause(Cause.die(defect))` — never `Effect.die(defect)`. `Effect.die` is banned because it loses context for *new* defects; `Cause.die(defect)` on an *already-existing* defect preserves the original cause verbatim and there is nothing to wrap. Use `LogicError` only when you are creating a fresh defect, not when forwarding one.
   ```typescript
   // ✓ Good — retry on unique violation, re-raise every other defect verbatim
   Effect.catchDefect((defect) =>
     isUniqueViolation(defect) ? Effect.void : Effect.failCause(Cause.die(defect)),
   )
   ```
   Reference: `applications/server/src/services/TrainingAutoLogCron.ts`.

   The rule applies even when the immediate fix is "silence a never-happens error". When a typed failure is genuinely impossible in production (e.g. `NoSuchElementError` from `INSERT ... RETURNING`, encode error from a `Schema.encodeSync`-ed payload), reach for `Effect.catchTag('<Tag>', () => LogicError.die('<reason>'))` — the descriptive defect preserves cause context that `Effect.orDie` discards. Reference: `applications/server/src/repositories/WeeklyChallengeRepository.ts` `create` for the canonical `INSERT ... RETURNING` shape.

3. **Never swallow errors silently** — always log before catching:
   ```typescript
   // ✗ Bad — error disappears without trace
   Effect.catchTag('NoSuchElementException', () => Effect.void)

   // ✓ Good — error is logged, then caught
   Effect.tapError((e) => Effect.logWarning('Context about what failed', e)),
   Effect.catchTag('NoSuchElementException', () => Effect.void)
   ```

4. **Repository error boundary** — all repositories catch `SqlError` and `ParseError` at the public method level using `catchSqlErrors`:
   ```typescript
   import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

   findByTeamId = (teamId: Team.TeamId) =>
     this.findByTeamQuery(teamId).pipe(catchSqlErrors);
   ```

5. **`Effect.either` is NOT exported** in the Effect 4 beta used by this repo. To convert a per-item failure into a successful `Exit` (e.g. for batch error isolation), use `Effect.exit` — it captures both typed errors and defects.

6. **`Effect.catchAllCause` does NOT exist** in the Effect 4 beta used by this repo. To handle a `Cause` (both typed failures and defects) — typically for "log everything, swallow, don't break the caller" — use `Effect.catchCause((cause) => Effect.logWarning('Context', cause))`. This is the correct pattern for **best-effort side effects** that must never fail their caller (e.g. firing achievement evaluation from an activity-log handler, emitting sync events alongside a primary write). Always log the `cause` before swallowing — never `Effect.catchCause(() => Effect.void)`.

### Resource Management

Use `Effect.acquireRelease` for automatic resource cleanup.

## Code Style

- **Avoid `Effect.gen(function* () {`** in regular effect pipelines — use `Effect.Do.pipe(...)` with `Effect.bind` / `Effect.let` / `Effect.tap` instead. Two narrow exceptions where `Effect.gen` is the documented convention:
  1. **`Effect.Service` / `Effect.Tag` constructor bodies** named `const make = Effect.gen(function* () { const sql = yield* SqlClient.SqlClient; ... return { ... }; })` — the entire `applications/server/src/repositories/` directory follows this shape (see `AgeThresholdRepository.ts`, `RolesRepository.ts`, etc.). Keep new repositories/services consistent with this pattern.
  2. **Test bodies** passed to `it.effect(...)` — see the Testing section below.

  Everywhere else (API handlers, cron jobs, helpers, RPC handlers), use `Effect.Do.pipe(...)`.
- **Use `pipe`** for linear transformations and chaining
- **Always use `Effect.asVoid`** instead of `Effect.map(() => undefined)`
- **Never cast types** (`as X`) and **never use `any`**
- **Never use `Schema.optional`** — always use `Schema.optionalWith({ as: 'Option' })`, `Schema.OptionFromNullOr(...)`, `Schema.OptionFromOptionalKey(...)`, or `Schema.OptionFromOptional(...)`
- **Use `Schema.OptionFromNullOr`** for nullable API/DB fields; use `Schema.OptionFromOptionalKey` only when the key may be absent from the input and `null` must be rejected; use `Schema.OptionFromOptional` for HTTP query parameters AND for partial PATCH request payload fields (missing key → `Option.none()`, present value → `Option.some(decoded)`). See `packages/domain/AGENTS.md`.
- **Use branded types** (e.g. `Discord.Snowflake`, `Team.TeamId`) instead of raw `Schema.String` for IDs
- **Use `Effect.void`** instead of `Effect.succeed(undefined)` or `Effect.unit`
- **Use Effect `Array` module** instead of native JS array methods in Effect pipelines
- **Type narrow errors** — use discriminated unions for error types

### Import Conventions

```typescript
// Use .js extensions in imports (TypeScript + ESM)
import { pipe } from "effect"
import * as Effect from "effect/Effect"

// Workspace imports
import { DomainService } from "@sideline/domain"
```

### Path Aliases

```typescript
@sideline/bot                → ./applications/bot/src
@sideline/domain             → ./packages/domain/src
@sideline/server             → ./applications/server/src
@sideline/template-renderer  → ./packages/template-renderer/src
```

## Testing

### Test Structure

```typescript
import { Effect, Exit } from "effect"
import { describe, it, expect } from "@effect/vitest"

describe("MyService", () => {
  it.effect("should handle success case", () =>
    Effect.gen(function* () {
      const result = yield* myOperation
      expect(result).toEqual(expected)
    })
  )
})
```

### Test Utilities

- **`it.effect`** — Run Effect programs as tests
- **`it.scoped`** — Tests requiring scope
- **`it.live`** — Tests with live services
- **`TestClock`** — Control time
- **`ConfigProvider.fromMap`** — Mock configuration
- **`Effect.provide`** — Supply test implementations

### Running Tests

```bash
pnpm test                    # Run all unit tests (no DB needed)
pnpm test:unit               # Alias for pnpm test
pnpm test --watch            # Watch mode
cd packages/domain && pnpm test  # Specific package
```

### Integration Tests

Integration tests live in `applications/server/test/integration/` and use **testcontainers** to spin up a real PostgreSQL 17 database.

```bash
pnpm test:integration        # Run integration tests (needs Docker)
```

**Prerequisites:**
- Docker must be running
- Run `pnpm build` first (migrations package must be compiled)

**Structure:**
```
applications/server/test/integration/
├── globalSetup.ts      — Starts PostgreSQL container, runs migrations, writes connection info to /tmp
├── setupFile.ts        — Reads connection info and sets process.env for each worker
├── helpers.ts          — TestPgClient layer and cleanDatabase effect
└── repositories/       — Repository integration tests
    ├── TeamsRepository.test.ts
    └── UsersRepository.test.ts
```

**Key helpers:**
- `TestPgClient` — a `Layer` that creates PgClient from env vars set by setupFile
- `cleanDatabase` — an Effect that truncates all public tables (except `migrations_*`) before each test

**Writing integration tests:**
```typescript
import { TestPgClient, cleanDatabase } from '../helpers.js'
import { beforeEach } from 'vitest'

const TestLayer = MyRepository.Default.pipe(Layer.provideMerge(TestPgClient))

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise))
```

## E2E Testing

E2E tests live in the `e2e/` directory at the monorepo root and use **Playwright**.

### Structure

```
e2e/
├── playwright.config.ts   — Playwright configuration (baseURL, projects, webServer)
├── tsconfig.json          — Standalone tsconfig for e2e tests
└── tests/
    └── *.spec.ts          — Test files (use .spec.ts extension)
```

### Writing E2E Tests

```typescript
import { expect, test } from '@playwright/test';

test.describe('Feature', () => {
  test('should do something', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Sideline/);
  });
});
```

### Running E2E Tests

```bash
pnpm test:e2e              # Run E2E tests (starts dev server automatically)
pnpm test:e2e:ui           # Open Playwright UI mode for debugging
pnpm exec playwright install chromium  # Install browser (first-time setup)
```

The `webServer` config in `playwright.config.ts` automatically starts `pnpm --filter @sideline/web dev` when running tests locally. In CI, `reuseExistingServer` is disabled so Playwright always manages the server lifecycle.

## Package Structure Conventions

```
packages/{name}/
├── src/
│   ├── index.ts           — Main entry point (must export public API)
│   ├── {Feature}/         — Feature-based organization
│   │   ├── services.ts    — Effect services
│   │   ├── models.ts      — Domain models (Effect Schema)
│   │   ├── effects.ts     — Effect programs
│   │   └── layers.ts      — Layer construction
├── test/
│   └── *.test.ts          — Test files
├── package.json
├── tsconfig.json
├── tsconfig.src.json
├── tsconfig.test.json
└── tsconfig.build.json
```

## Common Tasks

```bash
pnpm build               # Build all packages
pnpm check               # Type check
pnpm test                # Run tests
pnpm test:e2e            # Run Playwright E2E tests
pnpm test:e2e:ui         # Open Playwright UI mode
pnpm format              # Biome formatting and linting
pnpm codegen             # Regenerate generated code
pnpm clean               # Remove stale artifacts
pnpm tsx ./path/to/file.ts   # Execute TypeScript directly
```

## Biome.js

- **Formatter**: 2-space indentation, 100-char line width, single quotes, semicolons, trailing commas
- **Linter**: All recommended rules + TypeScript-specific rules
- **Import Organization**: Automatic import sorting, unused import removal
- **VCS Integration**: Git-aware, respects `.gitignore`
- **Test File Overrides**: `noExplicitAny` disabled in test files
- **Never rely on `!` non-null assertions for narrowing** (e.g. `map.get(k)!`, `arr[i]!`). The Biome formatter strips `!` in some positions, so a value the compiler treated as non-`undefined` becomes `T | undefined` after `pnpm format` and `pnpm check` then fails on the now-unguarded use. Always narrow with an explicit `undefined` guard instead — `const v = map.get(k); if (v === undefined) { ... }` — for `Map`/array/optional lookups.

## CI Pipeline

The `check.yml` workflow runs on pushes to `main` and on pull requests:

| Job | Command | Purpose |
|-----|---------|---------|
| **Lint & Format** | `pnpm lint` | Biome formatting and lint rules |
| **Build** | `pnpm codegen && pnpm build` | Verifies codegen + builds all packages |
| **Types** | `pnpm check` | Type-checks all packages |
| **Test** | `pnpm build && pnpm test` | Builds packages, then runs tests |
| **E2E Tests** | `pnpm build && pnpm test:e2e` | Builds packages, then runs Playwright E2E tests |

> **Why Build is critical:** Workspace packages use `publishConfig.directory: "dist"`, so pnpm symlinks consumers to `packages/*/dist`. Stale `.d.ts` files cause false type errors and cryptic test failures. **Always rebuild `packages/domain` after changing domain source files.**

### Docker / Snapshot Pipeline

`snapshot.yml` runs on PRs: publishes package snapshots via `pkg-pr-new`, builds Docker images for all apps, pushes to `ghcr.io/maxa-ondrej/sideline/<app>`.

### Full Clean Verification

When type errors seem wrong or after large refactors:
```bash
pnpm codegen && pnpm build && find . -name '*.tsbuildinfo' -delete && pnpm check && pnpm test
```

## Branching & PR Strategy

Trunk-based development on `main`:
- **`main`** is the single long-lived branch
- **Feature branches** branch off `main` and merge back via PR
- Branch naming: `feat/rsvp-buttons`, `fix/auth-token-refresh`, `docs/setup-guide`

### Workflow

1. Create a feature branch from `main`
2. Make changes, commit (pre-commit hooks run biome automatically)
3. Open a PR against `main` — CI runs checks + snapshot build
4. After review, squash-merge into `main`
5. For publishable changes, add a changeset before merging

## Development Workflow Skills

The development workflow is split into composable skills:

| Skill | Purpose |
|-------|---------|
| `/work` | Orchestrator: picks up a Notion story → `/implement` → `/ship` → updates Notion |
| `/implement` | Full dev loop: research → plan → TDD → verify tests → implement → verify → review → refactor |
| `/ship` | Delivery loop: changeset → `/docs` → checks → commit → push → PR → CI → code review → `/revise` |
| `/revise` | Triage review comments with `/architect` → `/implement` fixes → `/ship` |
| `/refactor` | Refactor code with before/after explanation, verified by tests |
| `/complete` | Mark story/bug as done after PR is merged (story → Done, bug → Fixed) |
| `/reconcile` | Sync Notion statuses for merged PRs |

### Composition

- **`/work`** calls `/implement` then `/ship` — use for full story lifecycle with Notion integration
- **`/implement`** is standalone — use when you already have a branch and want the full dev loop
- **`/ship`** is standalone — use when code is ready and you want to commit, push, and handle review
- **`/revise`** is standalone — use when a PR has review comments to address
- **`/complete`** is standalone — use after a PR is merged to finalize Notion statuses

## Version Management

```bash
pnpm changeset             # Create a changeset
pnpm changeset-version     # Version packages based on changesets
pnpm changeset-publish     # Build, test, and publish
```

### Changeset Bump Rules

- **patch** — small features, bug fixes, refactors
- **minor** — larger features, significant new functionality
- **major** — never bump major
- Include all `@sideline/*` packages with meaningful code changes

## Git Conventions

- Never add `Co-Authored-By`, `Generated-By`, or any AI attribution footers to commit messages
- Never commit to an old/existing feature branch when working on a new story — always create fresh from `main`
- Before every commit, run `pnpm format` and `pnpm codegen`, stage resulting changes
- After every `git push`, check that CI pipelines pass
- After any structural change (new packages, new patterns, changed conventions), update the relevant section in AGENTS.md as part of the same PR

## Task Management (Notion)

**Always use the `notion` CLI tool to check for tasks, stories, and sprint work.** Notion is the single source of truth.

### Hierarchy

```
Milestone → Epic → Story → Task
```

### Notion Databases

| Database | ID |
|----------|---|
| Tasks | `2e0b6b31-d3bd-4e32-a127-3eedf257f228` |
| Stories | `9ec44d56-966b-4c3e-ba98-637b128c99a8` |
| Epics | `a040ab6d-10bb-4575-8c80-d4e827238b03` |
| Milestones | `089dd440-070c-4cfb-a45d-1a68c299a2f2` |
| Sprints | `a89cc7a7-ab1a-4e3f-945d-d42028c75f00` |
| Bugs | `e6b8eb47-ddcd-4dba-b5fd-c631763ac5bd` |

### Task Properties

- **Status** — `TODO` | `In Progress` | `Done`
- **Type** — Feature | Bug | Design | Test | Docs | DevOps | Refactor
- **Story** — relation to Stories database
- **Version** — `v1` | `v2`

### Task Status Lifecycle

Tasks: `TODO → In Progress → Done`
Stories/epics/milestones: `TODO → In Progress → In Review → In Test → Done`

- When starting work, move **ALL tasks** to `In Progress` immediately
- Also cascade `In Progress` up to story, epic, milestone
- After CI passes, move tasks to `Done`; if all tasks done, story → `In Review`
- After PR merged, story → `In Test`
- **Never** move stories/epics/milestones to `Done` — that's manual

### Notion CLI (`notion`)

Use the `notion` CLI tool (installed via `brew install 4ier/tap/notion-cli`) for all Notion operations:

```bash
notion db query <db-id> -f json --all          # query database
notion db query <db-id> -F "Status=Done"       # filter
notion page props <page-id> -f json            # read properties
notion page view <page-id> -f md               # read page body
notion page set <page-id> "Status=In Progress" # update property
notion search "keyword" -f json                # search
```

## Preview Database Access

Each PR gets a preview database. Use `bin/psql` to connect:

```bash
psql --pr 108                          # Connect to PR 108's preview database
psql --pr 108 -c "SELECT * FROM teams" # Run a query
psql                                   # Connect to the main preview database
```

Configuration:
- `.env.preview` — connection config (host, port, user, DB name templates) — committed
- `.env.preview.local` — password only — gitignored

Both files are sourced automatically by `bin/psql`. The `bin/` directory is added to `PATH` via `.envrc`.

### Editing migrations after PR creation

Migrations run automatically when a preview environment is deployed. If you edit a migration **after** the PR has already been created (and the preview deployed), the migration runner will skip it because it was already marked as executed. You must apply the new SQL statements manually:

```bash
psql --pr <PR_NUMBER> -c "ALTER TABLE ... ADD COLUMN IF NOT EXISTS ..."
```

Always use `IF NOT EXISTS` / `IF EXISTS` guards so the command is idempotent. Run each new statement from the migration that was added after the initial deploy.

## Logs & Monitoring

Logs, traces, and metrics are exported via OpenTelemetry to **SigNoz**. Node apps (server, bot) configure the telemetry layer in each application's `run.ts` using `makeTelemetryLayer` from `@sideline/effect-lib`. The web app uses a **separate browser-side** telemetry layer in `applications/web/src/lib/telemetry.ts` (`makeTelemetryLayer`) wired through a `ManagedRuntime` singleton — see `applications/web/AGENTS.md` → "Runtime Singleton & Browser Telemetry".

### Services

| Application | `service.name` | Telemetry layer source |
|-------------|----------------|------------------------|
| Server | `sideline-server` | `applications/server/src/run.ts` (`@sideline/effect-lib` `makeTelemetryLayer`) |
| Bot | `sideline-bot` | `applications/bot/src/run.ts` (`@sideline/effect-lib` `makeTelemetryLayer`) |
| Web | `sideline-web` | `applications/web/src/lib/telemetry.ts` (`makeTelemetryLayer`, browser `Otlp.layerJson` + `FetchHttpClient.layer`) |

### Resource Attributes

| Attribute | Source | Example |
|-----------|--------|---------|
| `service.name` | `OTEL_SERVICE_NAME` | `sideline-server` |
| `deployment.environment` | `APP_ENV` | `preview` \| `development` \| `production` |
| `service.origin` | `APP_ORIGIN` | `sideline-preview.majksa.net` |

### Environments

| Environment | `APP_ENV` | Description |
|-------------|-----------|-------------|
| Development | `development` | Local development |
| Preview | `preview` | Per-PR preview deployments |
| Production | `production` | Live production environment |

### Querying Logs

When searching logs in SigNoz, always filter by resource attributes for faster queries:

- `service.name = 'sideline-server'` — scope to a specific service
- `deployment.environment = 'preview'` — scope to an environment
- Severity levels: `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`

## Troubleshooting

- **"Cannot find module"**: Ensure `.js` extensions in imports, run `pnpm install`
- **Type errors with Effect**: Ensure `@effect/language-service` is loaded, check error types are handled
- **Test failures**: Verify all services provided, use `it.effect` not raw `it`
- **Build failures**: Run `pnpm clean`, check `tsconfig.build.json`, verify project references
- **Stale domain `dist/`**: Run `pnpm build`, delete `.tsbuildinfo` files
- **TanStack Router serialization errors**: Add `ssr: false` to route options

## App Version (`APP_VERSION`)

Every long-running application exposes its own version string as `export const APP_VERSION: string`. Consumers (info commands, `/version` endpoint, web footer) import it from a per-app `version.ts`.

| App | File | Source of truth |
|-----|------|-----------------|
| Server | `applications/server/src/version.ts` | Reads `package.json` at runtime via parent-walking from `import.meta.url`, guarded by `parsed.name === '@sideline/server'`. |
| Bot | `applications/bot/src/version.ts` | Reads `package.json` at runtime via parent-walking from `import.meta.url`, guarded by `parsed.name === '@sideline/bot'`. |
| Web | `applications/web/src/lib/version.ts` | Reads `import.meta.env.VITE_APP_VERSION`, injected at build time by `vite.config.ts` + `vitest.config.ts` via `define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version) }` (both configs must mirror each other). |

### Rules for adding `APP_VERSION` to a new application

1. **Node runtime apps (server, bot, future workers)** — copy `applications/server/src/version.ts` and change only the workspace-name guard to the new package's `name` field. Walk **at most 5** parent directories from `import.meta.url`, match `package.json` by `name`, and fall back to `'unknown'` on any failure. The parent-walk + name-match is required because the file may live under `src/` (tsx dev) or `build/src/` (compiled) — neither layout is hard-coded.
2. **Vite-bundled apps** — use the `define` injection pattern: read `./package.json` with `import pkg from './package.json' with { type: 'json' }` and inject `import.meta.env.VITE_APP_VERSION`. Mirror the `define` block in both `vite.config.ts` and `vitest.config.ts` — otherwise unit tests read `undefined` and fall back to `'unknown'`.
3. **Never read `process.env.npm_package_version`** — it is only set under `npm/pnpm run` scripts and is absent in the Docker runtime.
4. **Never hard-code the version string.** `APP_VERSION` must always resolve from `package.json` so Changesets bumps propagate automatically.

## Documentation Conventions

Sideline has **three distinct documentation surfaces**. Know which one to update:

| Surface | Audience | Location | Format |
|---------|----------|----------|--------|
| Agent guides | AI agents, developers | `AGENTS.md` files | Markdown |
| Internal tech reference | Developers, operators | `docs/*.md` | Markdown |
| End-user product docs | Players, captains, admins, API integrators | `applications/docs/src/content/docs/**` | Starlight (MDX / Markdown) |

- **Always update the relevant AGENTS.md** when making architecture changes, adding new patterns, or establishing new conventions
- Package-specific docs go in the package's `AGENTS.md`, not here

### Product-user documentation (`applications/docs/`)

The user-facing docs site lives at `applications/docs/` (Astro + Starlight, served at `/docs`). Update it in the same PR when code changes alter end-user behaviour:

| Code change | Required docs update |
|-------------|----------------------|
| New or changed user-facing flow | Matching `guides/*.mdx` |
| New role / changed permission | `quick-start/<role>.mdx` |
| New Discord bot slash command | `guides/discord-integration.mdx` or `faq.md` |
| New API endpoint or changed schema | `api/overview.mdx` (and future per-endpoint pages) |
| New domain term | `introduction/key-concepts.md` |
| User-visible release | Append a plain-language entry to `changelog.md` |

See `applications/docs/AGENTS.md` for content conventions, translation policy (no CZ stubs in v1 — Starlight's fallback banner handles untranslated pages), and local dev workflow.

### Internal technical reference (`docs/`)

The root `docs/` directory contains comprehensive technical documentation for contributors and operators. These must stay in sync with the codebase. Update them as part of the same PR when making relevant changes:

| Document | Update when… |
|----------|-------------|
| `index.md` | Adding or removing documentation files |
| `discord-bot.md` | Adding/removing/renaming bot slash commands, button/modal interactions, gateway handlers, or RPC sync workers |
| `deployment.md` | Changing environment variables, Docker configuration, CI/CD pipelines, cron job schedules, monitoring setup, or local dev prerequisites |
| `api.md` | Adding/removing/renaming API endpoints, changing request/response schemas, adding new error types, or modifying auth requirements |
| `database.md` | Adding/removing/renaming database tables or columns (new migrations), changing constraints, indexes, or seeding behavior |

## Thesis Documentation (`docs/thesis/`)

The `docs/thesis/` directory contains Mermaid diagrams and documentation for the bachelor's thesis. These must stay in sync with the codebase. Update them as part of the same PR when making relevant changes:

| Document | Update when… |
|----------|-------------|
| `er-diagram.md` | Adding/removing/renaming database tables or columns (new migrations) |
| `architecture.md` | Adding new applications, packages, services, cron jobs, or changing the deployment topology (docker-compose, nginx) |
| `use-cases.md` | Adding new API endpoints, RPC methods, bot commands, or changing actor permissions |
| `sequence-diagrams.md` | Changing the flow of any documented interaction (OAuth, event creation, RSVP, role sync, cron generation, team creation, invites) |
| `user-testing-plan.md` | Adding or removing user-facing features that should be covered by test scenarios |
| `competitive-analysis.md` | Adding major new features that change Sideline's competitive positioning |

---

**Last Updated**: 2026-06-21 (AI rating insight + ELO-from-description. server AGENTS.md: added "Adding an `LlmClient` Method (Never-Fail Fallback vs `LlmError`)" — two method shapes: fail-with-`LlmError` (`summarizeEmail`, retried by a pending-status worker) vs never-fail with deterministic fallback (`generateRatingInsight`/`estimateRatingFromDescription`, `Effect<Result>` with `never` E, the sanctioned exception to the "Config-Gated External Service Provider" rule-3 `LlmError`-only surface); a never-fail method writes a pure locale-aware `derive…Fallback(input)` the stub returns directly, and `makeReal` pipes through the shared `requestContent` helper then `Effect.tapError(logWarning)` BEFORE `Effect.catchTag('LlmError', () => Effect.succeed(derive…Fallback(input)))`; reuse `requestContent` (don't re-implement the `POST /chat/completions` + `mapError` pipeline per method); the result carries `generated: boolean` (true=live, false=fallback) surfaced to the web. Added "Untrusted Input and Numeric Output Clamping in LLM Prompts" — end the system prompt with the `UNTRUSTED DATA` clause and put the untrusted value in a `user` message, cap free text (`description.slice(0, 2000)`), and clamp any LLM-returned number server-side via the exported `clampRating(n, min, max)` AND again in the handler before persisting (`applySeedRating` re-clamps with `RATING_MIN`/`RATING_MAX`). Added "Seed-Only Guarded Upsert (`PlayerRatingsRepository.seedRating`)" — `INSERT … ON CONFLICT DO UPDATE SET rating = EXCLUDED.rating WHERE games_played = 0` returning `Option<Row>` (`None` → `SeedNotAllowed` 409 when the row already has games), writes NO `player_rating_history` row and keeps counters at 0 so calibration corrects it; reference `test/integration/repositories/PlayerRatingsRepository.test.ts`.) (Earlier entry: Epic 6.3 "balanced training team generator". root AGENTS.md: added a Biome.js bullet — never rely on `!` non-null assertions for narrowing (`map.get(k)!`, `arr[i]!`), the formatter strips `!` in some positions so the value becomes `T | undefined` and `pnpm check` then fails; use an explicit `if (v === undefined)` guard. domain AGENTS.md: added "Pure Algorithm Modules (`src/models/<Algorithm>.ts` + `test/<Algorithm>.test.ts`)" — a multi-step computation several consumers run identically lives as a pure (no Effect/I/O/Schema) module with a paired deterministic-output unit test in the same PR; never `Math.random()`/clock, break ties with an explicit total order captured at decision time, document phases/cost-function/constants in a module doc comment, tunable constants are named exports, the server wraps the pure result into Effect at the call site; reference `Elo.ts`/`TeamGenerator.ts`. server AGENTS.md: added a "RPC direction is bot→server only" note to "RPC Transport" — the server is always the RPC server and the bot always the RPC client (`SyncRpcs`), the server has NO RPC channel back to the bot and cannot call Discord directly, so its only path to Discord is enqueueing a `*_sync_events` outbox row the bot polls; add an outbox event type, never look for a server→bot RPC. Added "JSONB payload column on an outbox event type" — the sanctioned exception to the never-denormalise / JOIN-resolution rule: a computed point-in-time snapshot with no stable source row to re-derive at read time is stored in a nullable JSONB column (one event type populates it, others NULL), schema decodes with `Schema.OptionFromNullOr(Schema.Array(<Element>))` (node-pg auto-parses JSONB — no `Schema.parseJson`), emitter writes `JSON.stringify(...)::jsonb`, snapshot at emit time never re-derive; reference `event_sync_events.teams_payload` (migration `1789900000`) + `emitTeamsGenerated`/`constructEvent`. bot AGENTS.md: added `teams_generated` to the Event Sync event-types list with the `handleTeamsGenerated` (`src/rcp/event/handleTeamsGenerated.ts`) → `buildGeneratedTeamsEmbed` description (posts to `discord_target_channel_id`, no-op+warn on `None`, renders the server-computed `teams_payload`, does not recompute).) (Earlier entry: Epic 6.2 "log training game results". root AGENTS.md: added the single sanctioned exception to the `Effect.die` ban under Error Handling rule 2 — re-raising an *already-captured* defect unchanged via `Effect.failCause(Cause.die(defect))` (never `Effect.die(defect)`); `Effect.die` is banned for losing context on *new* defects, but `Cause.die(defect)` on an existing defect preserves the cause verbatim and there is nothing to wrap; reference `applications/server/src/services/TrainingAutoLogCron.ts` (`catchDefect` retry-on-unique-violation / re-raise-everything-else). server AGENTS.md: added "Composing repository writes atomically across repositories (`…Tx` body split)" under "In-Transaction Read → Compute → Write" — expose a `…Tx` body method that does NOT call `sql.withTransaction` (so it nests as a SAVEPOINT inside a caller's outer transaction) plus a public wrapper that adds `sql.withTransaction` + `catchSqlErrors`; the body keeps per-statement `catchSqlErrors`; all `FOR UPDATE` lock-ordering rules apply across the merged transaction; reference `PlayerRatingsRepository.applyGameUpdatesTx`/`applyGameUpdates` consumed by `TrainingGamesRepository.insertGame`. Added "Best-effort side effect AFTER a committed transaction" — a follow-up side effect that runs after the primary `sql.withTransaction` commits MUST run outside that transaction, be wrapped in `Effect.catchCause((cause) => Effect.logWarning(msg, cause))` (always log the captured cause, never `Effect.ignore`), and be idempotent (`ON CONFLICT DO NOTHING` against the partial unique index); reference the `insertAutoIgnoreConflict` loop in `logTrainingGame` (`src/api/player-rating.ts`).) (Earlier entry: server AGENTS.md: Elo rating system. Added rule 4 to "Consistent `FOR UPDATE` Lock Ordering Within A Transaction" — when the lock targets N sibling rows of the SAME table (not a parent/child pair), the locking SELECT MUST be `ORDER BY <pk>` and the app MUST dedupe + sort the id set in the same order before the `IN` list, so concurrent transactions acquire overlapping row locks in identical order; reference `PlayerRatingsRepository.applyGameUpdates` (`Array.from(new Set([...a, ...b])).sort()` + `... IN ${sql.in(...)} ORDER BY team_member_id FOR UPDATE`). Added "In-Transaction Read → Compute → Write" subsection — a mutation that derives new values from current persisted values MUST read (`FOR UPDATE`), compute (via a pure `packages/domain` calculator like `Elo.computeTeamGameUpdate`), and write all inside one `sql.withTransaction`; compute from locked rows only; a missing-but-expected locked row is `LogicError.die`, not a recoverable error. Added rule 7 to "Global Admin Authorization" — a "manage" gate that admits global admins is the ONLY sanctioned exception to rule 5 and MUST be `requireReadAccess` + an `isGlobalAdmin`-branched `requirePermission` (the synthetic membership carries only `VIEW_PERMISSIONS`, so a global admin would otherwise be rejected by the `member:edit`/`<perm>` check); allowed only for operator-facing features with no Discord-facing or member-self-service mutation; canonical helper `requireManageAccess` in `src/api/player-rating.ts`.) (Earlier entry: server AGENTS.md: added "Injectable Env-Derived Config Service (Testable Allowlist)" section — wrap an env-derived process-wide constant (parsed once at module load) in a thin `ServiceMap.Service` whose `Default` reads the existing module-level constant ONLY when handlers must override it in tests (`Layer.succeed(Service, fake)`, never `vi.stubEnv` on a `@t3-oss/env-core`-snapshotted module); the service is a wrapper not a second source of truth, wrap only the consumers that need injectability (the per-request `toCurrentUser` keeps reading `globalAdminDiscordIds` directly — only `src/api/global-admin.ts` depends on the service), and adding it to `ApiLive` triggers the test-layer cascade; reference `GlobalAdminAllowlist` (`src/services/GlobalAdminAllowlist.ts`). Generalised the "HttpApi Mock-Layer Cascade" section from repositories to **every** service a registered `HttpApiBuilder.group(...)` depends on — non-repository services are provided via their `.Default` (or a `Layer.succeed` override); added the recurring footgun that wiring a new `ServiceMap.Service` into `ApiLive`/`AppLive.ts` silently breaks every `ApiLive`-providing test at once (the global-admins change had to add `Layer.provide(GlobalAdminAllowlist.Default)` to 34 test files), with `Layer.provide(BotInfoStore.Default)` as the grep anchor.) (Earlier entry: domain AGENTS.md: added "Input vs Output Types for Write-Back Nested Arrays" section under Schema Patterns — when a response `Detail` type carries an editable nested array that the client submits back AND the response augments each element with a server-computed field, define two schema classes: an input type with only writable fields (`ChannelAccessGrant`, used by `SetChannelAccessRequest.grants`) and an output `<Input>Detail` type adding the computed field (`ChannelAccessGrantDetail` adds `roleResolvable: boolean`, used by `ChannelDetail.grants`, populated server-side from `findGroupRoleIds`); the request payload element MUST be the input type, never the output type, and the web MUST map output records back to fresh input instances before submitting so the computed field cannot leak into the request — reference `packages/domain/src/api/ChannelApi.ts` + `applications/web/src/components/organisms/ChannelAccessSheet.tsx` (`handleGrantAccess`/`handleChangeLevel`/`handleRemoveAccess`); framed as the nested-write-back counterpart of "Display Names Are Computed Server-Side".) (Earlier entry: Per-team IMAP email-ingestion variant. server AGENTS.md: added `ImapPoller` (`src/services/ImapPoller.ts`, every 5 min) to the Cron table. Added "Email Ingestion Has Two Producers (Webhook + IMAP Poller)" section — `email_messages` `received` rows are written by `EmailWebhookLive` (`insertReceived`, always inserts) and `ImapPoller` (`insertReceivedDedup`, ON CONFLICT); everything downstream of `received` is producer-agnostic; both share the `senderAllowed` allow-list filter, the `validateAttachmentSizes` cap (`src/services/emailAttachmentLimits.ts`), and a single `sql.withTransaction` message+attachments write; `insertReceivedDedup` dedups on `(team_id, message_id)` via `ON CONFLICT (team_id, message_id) WHERE message_id IS NOT NULL DO NOTHING RETURNING id` (partial unique index `uq_email_messages_team_message_id`, migration `1789400006`), returning `Option<EmailMessageId>` (`None` = already-ingested no-op) and falling back to plain `insertReceived` when `message_id` is absent. Added "IMAP Watermark Ingestion (`ImapPoller`)" section — per-team UID watermark on `email_forwarding_config` (`imap_last_seen_uid`/`imap_uid_validity`/`imap_last_synced_at`, advanced via `updateImapSync`); cold start (`imap_last_seen_uid === 0 AND imap_uid_validity IS NONE`) and `UIDVALIDITY` reset both baseline to `uidNext - 1` and ingest nothing; the ascending-UID left-fold threads `{ committed, stopped }` and never advances the watermark past a failed insert (`stopped` halts the rest of the cycle, failed UID retried next cycle); per-team `decrypt`/`ImapConnectionError` failures map to a module-local `SkipTeam` and the per-team loop is `{ concurrency: 2 }` with `Effect.exit` isolation; candidate query `findImapEnabled()` backed by partial index `idx_email_forwarding_imap_enabled (... WHERE imap_enabled = true AND enabled = true AND imap_secret_encrypted IS NOT NULL)` (both `imap_enabled` AND `enabled` required). Added "Optional Secret That Fails On Use, Not On Boot (`EmailSecretCrypto`)" section — AES-256-GCM per-team IMAP credential crypto distinct from the real-vs-stub `LlmClient` provider: the `EMAIL_IMAP_ENCRYPTION_KEY` redacted-optional env var is resolved per call via `resolveKey` (never at layer build), so the layer always builds and `encrypt`/`decrypt` fail with typed `EmailSecretKeyMissing` (key absent or not 32 base64 bytes) / `EmailSecretDecryptError`; ciphertext is the self-describing `v1.<iv>.<tag>.<ct>` base64url string stored in `email_forwarding_config.imap_secret_encrypted`; tests use the `makeWithKey(Option<string>)` seam, never `Default`.) (Earlier entry: server AGENTS.md: added "Overloaded payload fields on event sync events (training vs non-training)" section — `event_started.discord_role_id` carries the OWNERS-group role for trainings but the MEMBER-group role otherwise, and `training_claim_request.owner_group_id` is populated in `constructEvent` from the outbox `member_group_id` column; both producer (`EventStartCron`/`constructEvent`) and consumer branch on `event_type === 'training'` and MUST be kept in sync; `EventStartCron` also passes `event.claimed_by` → `claimed_by_discord_id` only for trainings. Added "Dead claim-thread column and RPC" section flagging `events.claim_thread_id` + `Event/SaveClaimThreadId` as dead/do-not-reuse. Added "Persistent owners claim thread" section — one thread per owners group on `discord_channel_mappings.claim_thread_id` (migration `1789400005`), served by `Event/{Get,Save,Clear}OwnerClaimThread` RPCs; `saveClaimThreadIfAbsent` is the atomic race-safe `UPDATE ... WHERE claim_thread_id IS NULL RETURNING` that returns the winning id and re-reads on `None`; added it to the "Atomic Conditional UPDATE Pattern" used-by list. bot AGENTS.md: updated the `event_started` description — the "Starting now" mention is `event_type`-dependent (training → `<@coach>` user mention via `claimed_by_discord_id` + `allowed_mentions.users`, fallback owners-role mention + `bot_event_started_no_coach_warning`; non-training → member-group role), and the handler best-effort deletes the owners-thread claim message on training start. Replaced "Coach-claim message id round-trip" with "Persistent owners claim thread (one per owners group, NOT per training)" — `handleTrainingClaimRequest` resolves/creates ONE thread per owners group via `Event/GetOwnerClaimThread`/`SaveOwnerClaimThread` (delete-the-loser-on-race), posts the embed into the thread with a code-10003 clear+recreate+retry-once path, then saves the message id; per-message thread creation was removed.) (Earlier entry: server AGENTS.md: added "Consistent `FOR UPDATE` Lock Ordering Within A Transaction" section — when two or more repository methods mutate the same related rows inside `sql.withTransaction(...)` and guard concurrency with explicit `SELECT ... FOR UPDATE`, every method MUST take those locks in the same parent→child order; for `CarpoolsRepository` the order is `carpools` row first then `carpool_cars` row, so `reserveSeat`/`removeCar` begin with `lockCarpoolByCarQuery(input.carId)` before `lockCarQuery`, matching `addCar`; a method touching only one table still takes the parent lock first when it must serialize against a sibling that touches both (why `reserveSeat` locks `carpools`); cross-method guards are mirrored both ways (`addCar`'s `checkOwnerIsPassengerQuery` ↔ `reserveSeat`'s `findOwnedCarQuery`, the latter placed before the capacity check so `CarpoolAlreadyInAnotherCar` wins over `CarpoolFull`); reference `CarpoolsRepository.reserveSeat`/`removeCar`/`addCar`.) (Earlier entry: Email Forwarding & AI Summarization feature. server AGENTS.md: added "Unauthenticated Raw HTTP Routes (`HttpRouter.add`, Outside `AuthMiddleware`)" section codifying that non-session-gated routes (inbound webhooks) are raw `HttpRouter.add` layers merged into `AppLayer` next to `RpcLive`, NOT `ApiLive`; the four-gate self-auth order (body-size cap → HMAC `crypto.timingSafeEqual` constant-time verify BEFORE the DB token lookup → per-team capability token → resource-state filter), the `never` error channel via a `WebhookEarlyExit` tagged error absorbed by `Effect.catchTag(...)`, distinct status mapping that never leaks token existence, and `sql.withTransaction` for the atomic write — reference `EmailWebhookLive` (`src/api/email-webhook.ts`), the first inbound write webhook vs the read-only iCal group. Added "Status-Claim As Per-Row Lock" section — poll-driven status-state-machine workers MUST claim via `UPDATE ... SET status='<inflight>' WHERE id=$1 AND status='<from>' RETURNING id` (`SqlSchema.findOneOption` → skip on `Option.none()`), repeat the precondition in every transition's WHERE, and use `CASE WHEN attempts+1>=max` for in-table capped retry — reference `EmailMessagesRepository.claimForSummarizing` + `EmailSummarizer`. Added "Config-Gated External Service Provider (Real vs Deterministic Stub)" section — one `ServiceMap.Service` whose `Default` picks `makeReal`/`makeStub` from config, identical interface either way, single typed error (`LlmError`), optional-with-default gating env vars, and tests use `Layer.succeed(Service, fake)` not the real `Default` — reference `LlmClient`. Added `EmailSummarizer` to the Cron table. bot AGENTS.md: added "Email Sync (email posts → Discord embeds)" section (the `email_post_sync_events` family: `approval_request`/`post_summary`/`post_original` kinds, `src/rcp/email/`, `src/rest/email/buildEmailEmbeds.ts`); added "`allowed_mentions: { parse: [] }` On Every Message Carrying User- or Email-Derived Content" section generalising the welcome-flow rule to all `createMessage`/`updateMessage` relaying user-authored or external text; added `finance.processTick` + `email.processTick` to the `pollLoop` cadence row.) (Earlier entry: server AGENTS.md: extended the "Global Admin Authorization" section for global-admin read access — added `requireReadAccess(members, teamId, forbidden)` and the `VIEW_PERMISSIONS` (`roster:view`/`member:view`/`role:view`/`finance:view`) component rows to the helper table; reworded rule 5 to scope the "global admin does NOT grant team permissions" rule to WRITE operations only; added rule 6 codifying the read-vs-write helper split — read-only `<resource>:view` handlers use `requireReadAccess` (signature `(members, teamId, forbidden)`, reads `Auth.CurrentUserContext` itself, NO `currentUser.id` arg; returns a synthetic sentinel-id `MembershipWithRole` for a non-member global admin whose `membership.id` MUST NOT scope DB queries), write handlers keep `requireMembership(members, teamId, currentUser.id, forbidden)`, and caller-scoped `my*` reads keep `requireMembership` because they scope by `membership.id`; reference `src/api/permissions.ts` + read handlers `roster.ts`/`role.ts`/`finance.ts`/`activity-stats.ts`/`team.ts`. Updated "Membership Lookups Default To Active-Only" rule 1 to note `requireReadAccess` is an authorization gate whose `Option.none()` branch falls through to synthetic read-only access for global admins.) (Earlier entry: server AGENTS.md: added `TrainingClaimRequestCron` and `CoachingStatusCron` rows to the cron table; added "Self-Healing `*_sent_at` Date-Gated Crons" section under Cron Jobs codifying the per-row `*_sent_at` idempotency marker plus lower-bound (`DATE(start) - days_before <= DATE(now)`) candidate-query gate — distinct from `RsvpReminderCron`'s exact-day-equality + time-of-day BETWEEN window which a cron outage can permanently miss; the marker MUST be set in every terminal branch (success AND each permanent-skip branch), pair it with a matching partial index, and the adding migration MUST backfill existing rows; reference `TrainingClaimRequestCron`/`CoachingStatusCron` + `TeamSettingsRepository`. Added "Adding an `event_sync_events` Event Type — Four Synchronized Places" section under Sync Event Pattern: a new `event_type` value must be added to the DB CHECK constraint `event_sync_events_event_type_check`, the `EventSyncEventType` `Schema.Literals` in `EventSyncEventsRepository.ts`, the `UnprocessedEventSyncEvent` `Schema.Union` (`Schema.TaggedClass`) in `packages/domain/src/rpc/event/EventRpcEvents.ts`, and the bot `Match.type<...>().pipe(...)` dispatcher in `applications/bot/src/rcp/event/ProcessorService.ts` (place 4 is the only compile-time backstop via `Match.exhaustive`; places 1–2 are runtime-only). migrations AGENTS.md: added "Backfill `*_sent_at` Idempotency Markers on Add" section — the same migration that adds a `*_sent_at` cron marker MUST `UPDATE ... SET <marker> = now() WHERE ... AND <marker> IS NULL`, scoped to the cron's target rows, to avoid a first-deploy notification blast; reference `1789300000_improve_coach_assigning.ts`.) (Earlier entry: root AGENTS.md: updated "Logs & Monitoring" → Services table to add the web app (`sideline-web`) and note it uses a separate browser-side telemetry layer in `applications/web/src/lib/telemetry.ts` (`makeTelemetryLayer` with `Otlp.layerJson` + `FetchHttpClient.layer`) wired through a `ManagedRuntime` singleton, distinct from the Node apps' `run.ts` `@sideline/effect-lib` layer. web AGENTS.md: added "Runtime Singleton & Browser Telemetry" section codifying the single module-level `ManagedRuntime` in `lib/runtime.ts`, the one-directional OTEL config flow `fetchEnv → initRuntime → ManagedRuntime → runners`, the idempotent `initRuntime({ serverUrl, telemetryLayer })` called once in root `beforeLoad` (every runner throws if called before it), the four optional OTEL env vars (`OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_SERVICE_NAME`/`APP_ENV`/`APP_ORIGIN`, `makeTelemetryLayer` returns `Layer.empty` when endpoint is unset), the load-bearing `makeAppLayer` constraint that `ClientConfig` must be both provided to `ApiClientLive` AND merged into the runtime output (`ApiClientLive.pipe(Layer.provide(clientConfigLayer))` + `clientConfigLayer` in `Layer.mergeAll`), `runEffect` as the fire-and-forget `runFork` runner for metrics from non-Effect callbacks only, and the `lib/telemetry.ts` Web Vitals (`registerWebVitals`) + React render (`recordReactRender` via `<Profiler>`) metric helpers with all `Metric.histogram` definitions living there and `web-vitals` lazy-imported. Added `runEffect` to the "Runtime — Client vs Server Runners" table and updated the Wiring note for the `<Profiler>` + `initRuntime`/`registerWebVitals` call sites.) (Earlier entry: server AGENTS.md: documented the channel-management iteration in the "Managed Channels" section — the `managed_channel_adopted` event (`event_type='channel_updated'`, `entity_type='managed'`, carries `team_channel_id` + `discord_channel_id` via `existing_channel_id`, emitted by `emitManagedChannelAdopted`); the `adoptDiscordChannel` endpoint (`POST .../discord-channels/:id/adopt`, text-only, idempotent via a pre-check plus `DiscordChannelAlreadyAdoptedError` catch that re-fetches without re-emitting); the `bulkArchiveDiscordChannels` endpoint (`Array.dedupe` payload, `findAllByTeam` once, per-item `Effect.exit` isolation → `{archived, skipped, failed}`); the new partial unique index `uq_team_channels_discord_channel` on `team_channels(team_id, discord_channel_id) WHERE NOT NULL` (migration `1789000002_uq_team_channels_discord_channel.ts`) as the adoption concurrency guard; and the rule that adoption and access are emitted as two separate committed events to avoid an ordering race. bot AGENTS.md: added the `managed_channel_adopted` → `handleManagedAdopted` row and a REPLACE-semantics note — the handler full-REPLACES `permission_overwrites` with a single `@everyone` deny-`ViewChannel`, wiping foreign overwrites; the bot retains access via its guild-level bot role (not a per-channel overwrite); grants arrive separately via `managed_access_granted`; no RPC ack; updated the dispatcher-chain note and corrected the `channel_updated` + `managed` claim. effect-lib AGENTS.md: filled in the "SQL Error Handling" section documenting `isUniqueViolation`, `getConstraintName`, `catchUniqueViolation`, and `catchUniqueViolationOn` — use `catchUniqueViolationOn(constraintName, ...)` when a table has multiple unique constraints, with `TeamChannelsRepository.insertAdopted` as reference.) (Earlier entry: domain AGENTS.md: added "User Display-Name Resolution (`src/models/DisplayName.ts`)" section codifying `DisplayName.pickDisplayName` as the single source of truth for resolving a user's display name — precedence `name → nickname → displayName → username`, first non-blank wins, blank/whitespace slots skipped, returns `Option<string>` with NO terminal fallback; pure module, namespace re-export; forbids inline `Option.getOrElse(name, () => username)` and ad-hoc `Array.make(...).pipe(Array.getSomes, Array.head)` in server/bot/web. server AGENTS.md: added "Display Names Are Computed Server-Side" section — every API response carrying a user identity MUST return a fully-resolved non-`Option` `displayName: string`, computed at the handler/mapper layer via `DisplayName.pickDisplayName` with terminal fallback `() => username` (username always present); repositories still SELECT the raw four slots; reference `toCurrentUser.ts` and `roster.ts` `toRosterPlayer` (also `event-rsvp.ts`, `group.ts`, `leaderboard.ts`). web AGENTS.md: added "User Display Names — Read `displayName`, Never Re-Derive" under Auth Store — web reads the server's `displayName` string directly and MUST NOT re-implement the fallback (`Option.getOrElse(x.name, () => x.username)` is forbidden — skips nickname/global display name); derive initials/avatars from `displayName`; reference `NavUser.tsx`, `PlayerRow.tsx`. bot AGENTS.md: updated "`formatName`" section — `formatName` now delegates its precedence to the shared `DisplayName.pickDisplayName` picker and only layers Discord markdown (`**bold**`, `<@id>`); the entry's `display_name` field maps to the picker's `displayName` slot; `"Unknown"` is the bot's own terminal fallback, the picker invents none.) (Earlier entry: domain AGENTS.md: expanded Permission-catalog rule 1 into an explicit four-file checklist for adding a `Permission` literal — `Permission.literals` + `defaultPermissions`, the backfill migration, the exhaustive `permissionLabels: Record<Role.Permission, …>` map in web `RoleDetailPage.tsx` (omitting a key is a compile error), and a `role_perm_<camelCaseLiteral>` i18n key in BOTH `cs.json` and `en.json`. bot AGENTS.md: added "Rebuild a board message from the stored id, never from `interaction.message`" under the Event Sync message-id section — persistent multi-user board embeds must be rebuilt at the channel/message id carried on the server view (saved at create time via a `Save…DiscordMessageId`-style RPC), not from `interaction.message`/`interaction.channel_id`, because the interaction may originate from a private thread or ephemeral reply; reference `rebuildBoard` in `src/interactions/carpool.ts`.) (Earlier entry: server AGENTS.md: added "Per-User/Team Preferences (`(user_id, team_id)` JSONB Row)" section codifying the composite-key + JSONB body pattern used by `dashboard_layouts` — `PRIMARY KEY (user_id, team_id)`, both FKs `ON DELETE CASCADE`, no synthetic id; read returns `Option<Body>` with the API handler defaulting `None` to a `DEFAULT_*` value (never 404); writes are unconditional `INSERT ... ON CONFLICT (user_id, team_id) DO UPDATE` upserts; JSONB is bound via `JSON.stringify(...)::jsonb`; authorization is `requireMembership` (not `requirePermission`) and `userId` is bound from `Auth.CurrentUserContext`, never from URL/payload. Added "Server-Side Normalization Of Stored Preference Payloads" section codifying the `normalize` pure-function pattern run on BOTH read and write for any JSONB payload whose body references a domain literal set that may grow over time (drop-unknown / dedupe / append-missing-as-visible in canonical order); reference `normalizeWidgets` in `src/api/dashboard-layout.ts`; canonical id order lives as a `const`-tuple in `packages/domain/` (`DASHBOARD_WIDGET_ORDER`); missing entries append as visible by default — never version the payload, the normalizer makes it self-healing.) (Earlier entry: server AGENTS.md: added "Membership Lookups Default To Active-Only" section codifying that `TeamMembersRepository.findMembershipByIds(teamId, userId)` (no options) and `findByUser(userId)` filter `AND tm.active = true` by default; `{ includeInactive: true }` is the explicit opt-in used only by the three reactivation-or-create flows (`invite.joinViaInvite`, `auth.autoJoinTeams`, `rpc/guild.RegisterMember`); `requireMembership` inherits the active-only filter; the deactivation-is-terminal invariant for `auth.autoJoinTeams` — when `findMembershipByIds(..., { includeInactive: true })` returns `Some` (active OR inactive), the handler returns `Option.none()` and never calls `addMember`/`reactivateMember`, so a removed user is never silently auto-rejoined on the next OAuth login; fee/payment queries that JOIN `team_members` filter `AND tm.active = true` in SQL. web AGENTS.md: updated "Current Route Structure" tree to reflect the `(no-team)/` parenthesised group under `(authenticated)/` (now contains `no-team.tsx`, `create-team.tsx`, and `profile/`); added "`(no-team)` Route Group Convention" section codifying that authenticated routes with no `teamId` in the path belong under `(no-team)/`, `teams/$teamId/route.tsx` redirects to `/no-team` (with `?removed=1` when `getLastTeamId()` matches `params.teamId`) on a missing membership, root `/` redirects to `/no-team` (not `/create-team`) on `NoSuchElementError`, and `clearLastTeamId()` must be called before redirecting to `/no-team` to avoid a redirect loop.) (Earlier entry: root AGENTS.md: reinforced "Never use `Effect.orDie`/`Effect.die`" rule with `HttpServerResponse.json(...).pipe(Effect.orDie)` as an additional bad example and the canonical `Effect.catchTag('NoSuchElementError', () => LogicError.die('...'))` pattern for `INSERT ... RETURNING` queries — reference `WeeklyChallengeRepository.create`. server AGENTS.md: added "HttpApi Query Parameters Must Be Consumed Or Removed" section (every `Schema.OptionFromOptional` query field must be destructured by the handler or removed from the schema; reference `weekly-challenge.ts` `listChallenges`); added "HttpApi Mock-Layer Cascade" section under Testing — every test file that provides `ApiLive` must provide a mock layer for every repository registered in `ApiLive` (noop reads return `Option.none()` / `[]` / `Effect.void`; non-trivial writes return `Effect.die(...)`; mock objects MUST build domain models via canonical constructors, never as camelCase string literals — reference `test/mocks/weeklyChallengeMocks.ts`). web AGENTS.md: added "Time-Sensitive Data: Timezone Correctness, Stale-Response Toggles, Focus Refetch" section codifying three rules — (1) server's `currentTeamMondayDateString(teamTz)` is the single source of truth; web client NEVER uses `Date.getDay()`/`getDate()` for "current week"; `MondayPicker` identifies Mondays via `Intl.DateTimeFormat('en-CA', { timeZone: teamTz, weekday: 'short' })`; (2) `window.focus` → `router.invalidate()` for pages with calendar-boundary semantics (reference `WeeklyChallengesPage.tsx`); (3) debounced-optimistic-toggle stale-response pattern using monotonic `inFlightRequestIdRef` + `serverStateRef` for rollback target — reference `ChallengeCompletionCell.tsx`.) (Earlier entry: root AGENTS.md: clarified that `Effect.catchAll` does NOT exist in Effect v4 beta — the operator is `Effect.catch`; documented the legitimate use of `Effect.catch` as the outer per-event funnel inside `ProcessorService.processEvent`. bot AGENTS.md: added "Discord REST Retry Pattern" section codifying `Effect.suspend(() => rest.<call>(...))` as mandatory inside `Effect.retry`, the required `catchTag → retry` ordering (permanent errors short-circuit before burning retries), and pointing at `handleAchievementEarned.ts` + `handleWeeklySummaryReady.ts` as latent-bug references that lack `Effect.suspend` and (for weekly summary) have the wrong catchTag/retry order. Added "Optional Env Var Pattern" (`Schema.OptionFromNullishOr(Schema.NonEmptyString)`, see `WEB_URL` / `LOG_LEVEL` in `src/env.ts`). Added "Mocking `~/env.js` in Tests" rule — `@t3-oss/env-core` snapshots at module load, so `vi.stubEnv` after import is a no-op; use `vi.mock('~/env.js', factory)` with a mutable hoisted ref; reference `applications/bot/test/rcp/weeklyChallenge/ProcessorService.test.ts`. Added "Folder Naming: `rcp` Not `rpc`" callout — the bot sync-processor folder is `applications/bot/src/rcp/` (historical typo, now the established convention). Added "Embed Builder Location" rule — embed builders live under `applications/bot/src/rest/<feature>/build<Name>Embed.ts`, never under `src/rcp/`. i18n AGENTS.md: added "Kind/Category Label Keys Bake In Their Emoji" section — `weeklyChallenge_embed_kind_throwing` resolves to `"🥏 Házecí"` with the emoji already in the value; bot embed builders MUST NOT prefix another emoji.) (Earlier entry: server AGENTS.md: added "Team Provisioning: `provisionNewTeam(...)` Helper" section codifying the single-source-of-truth helper at `applications/server/src/utils/provisionNewTeam.ts` — both `auth.createTeam` (deprecated) and `onboarding.completeOnboarding` delegate to it; documents the optional `markConsumed: (teamId) => Effect<Option<unknown>>` callback for atomic token consumption inside the team-creation transaction (returns `Option.none` to abort with `OnboardingTokenAlreadyConsumed`); pre-flight checks and `SqlErrors.catchUniqueViolation` mapping live at the call site, never in the helper. Added "Token-Hash-At-Rest For Capability URLs" section codifying that single-use URL capability tokens (e.g. `team_onboarding_tokens.token_hash`) are stored as SHA-256 hex of `crypto.randomBytes(32).toString('base64url')` plaintext; the plaintext is returned exactly once at mint time and never persisted; lookups go through `findByHash(hashToken(plaintext))` only; reference `src/utils/onboardingToken.ts`. Domain AGENTS.md: added rule 4 to "HTTP API Error Tag Conventions" — lifecycle-state errors get one resource-prefixed tag per terminal state (`<Resource>TokenExpired` / `Revoked` / `AlreadyConsumed`) with per-state HTTP status mapping (410/410/409), not a single collapsed `<Resource>TokenInvalid`; reference `OnboardingApi.ts`.) (Earlier entry: web AGENTS.md: added `formatEventDateRange` to the `src/lib/datetime.ts` row in the Shared Utility Modules table — canonical helper for rendering event start/end ranges across EventDetailPage, EventsListPage, and EventCalendarView WeekEventCard.) (Earlier entry: server AGENTS.md: extended "Hand-written INSERT / UPDATE Column Lists" footgun section to enumerate `TeamsRepository.insertQuery`'s current state — `welcome_channel_id` and `achievement_channel_id` ARE persisted at INSERT, but `system_log_channel_id`, `rules_channel_id`, `overview_channel_id`, `welcome_message_template`, `onboarding_rules_role_id`, `onboarding_rules_prompt_id` are still silently dropped and can only be set via subsequent `teams.update(...)`. Added "PATCH Payload Merge: `Option.getOrElse` Over `Option.match`" section codifying `Option.getOrElse(payload.x, () => existing.x)` as the required idiom for partial-PATCH "patch-or-keep" merges over the verbose `Option.match({ onNone: () => existing.x, onSome: (v) => v })`; reserve `Option.match` for non-trivial `onSome` branches; use `Effect.let` (not `Effect.bind` + `Effect.succeed`) when no effectful work is needed; reference `applications/server/src/api/team.ts` `updateTeamInfo`.) (Earlier entry: domain AGENTS.md: added "Wire-Format Date-String Helpers (`src/models/<Resource>Date.ts`)" section codifying the pure `parse...`/`format...` pair pattern used by `ActivityLogDate` — DST-safe noon anchoring, ±N-day calendar bounds, `Option<Date>` return, namespace re-export from `index.ts`; both parser and matching `Schema.check(Schema.isPattern(...))` wire schema are required. effect-lib AGENTS.md: documented `Options.toEffect` (`Option<T>` → `Effect<T, E>` lifting) and `Options.extractEffect` (`Option<Effect<T, E>>` → `Effect<Option<T>, E>`) — prefer over inline `Option.match` when `onSome` is a bare `Effect.succeed`. server AGENTS.md: added "Stable Tiebreaker On Timestamp ORDER BY" section requiring `ORDER BY <user-editable timestamp>, id` (matching direction) on user-mutable timestamp columns to keep pagination deterministic; reference `ActivityLogsRepository._listByMember` / `_listRecent`. web AGENTS.md: added "Date Inputs — `DatePicker`" section (use `~/components/ui/date-picker` over `<input type='date'>`, controlled by `YYYY-MM-DD` string not `Date`, `fromYear`/`toYear` ±N pattern, `dirty` flag for edit forms to honour the server's missing-key PATCH contract).) (Earlier entry: bot AGENTS.md: added "Test File Imports — Static Only" section codifying that dynamic `await import('~/...')` inside test helpers re-pays Vitest transform cost per test under repo-root `sequence.concurrent: true` and causes 5s timeouts; TDD-scaffolding dynamic imports must be hoisted once the module under test exists; reference fix `applications/bot/test/rcp/onboarding/ProcessorService.test.ts`; lists known offenders still to hoist.) (Earlier entry: root AGENTS.md: added `Schema.OptionFromOptional` to the optional-schema rule (also used for partial PATCH payload fields, not only HTTP query strings). Domain AGENTS.md: extended the `OptionFromOptional` bullet to cover PATCH request payloads with `ExpenseApi.UpdateExpenseRequest` as reference; added "Permission Reuse Over New Literals" rule under the permission catalog. Server AGENTS.md: added "Application-Set Audit Actor For Hard Deletes" section codifying the `SET LOCAL audit.user_id = ${userId}` inside `sql.withTransaction(...)` pattern (reference `ExpensesRepository.delete`), and "Hard-Delete + Audit Trigger vs Soft-Delete" decision matrix. Migrations AGENTS.md: added "Per-Row Audit Trigger With Application-Set Actor" section documenting the `expenses_audit` trigger + `expense_history` table + `current_setting('audit.user_id', true)` actor-lookup pattern. Web AGENTS.md: added "URL-Synced Tabs Via `validateSearch`" section (reference `finances.tsx`); added "User-Scoped `localStorage` Keys" rule (reference `overviewTabSeenKey`); added `pickDominantCurrency` (by volume) vs `pickMostFrequentCurrency` (by row count) distinction in the finance utilities table.)
