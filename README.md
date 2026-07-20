# Sideline

[![CI](https://github.com/maxa-ondrej/sideline/actions/workflows/check.yml/badge.svg)](https://github.com/maxa-ondrej/sideline/actions/workflows/check.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6+-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Effect](https://img.shields.io/badge/Effect--TS-3.10+-black?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0wIDE4Yy00LjQyIDAtOC0zLjU4LTgtOHMzLjU4LTggOC04IDggMy41OCA4IDgtMy41OCA0LTggOHoiLz48L3N2Zz4=)](https://effect.website)
[![pnpm](https://img.shields.io/badge/pnpm-10.14+-f69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Sports team management system with a Discord-first architecture. Built as a bachelor's thesis project.

**Website:** [sideline.cz](https://sideline.cz)

## Architecture

An Effect-TS monorepo with schema-driven API design:

```
applications/
  bot/       Discord bot (dfx, Effect-native)
  server/    HTTP API handlers, repositories, service layer
  web/       TanStack Start frontend (Vite, React 19, Nitro)
packages/
  domain/    Schema definitions, typed errors, HttpApi spec
  migrations/Database migrations (Effect SQL)
```

The **domain** package defines the API contract (`HttpApiGroup` + `Schema`) and **server** implements it via `HttpApiBuilder` — all sharing the same type-safe spec.

Each application separates its composable layer (`AppLive`) from its runtime entrypoint (`run.ts`), allowing clean dependency injection and Docker deployment.

## AI Agent Team

This project uses a **multi-agent system** powered by [Claude Code](https://docs.anthropic.com/en/docs/claude-code) to automate the full software development lifecycle. Each agent is a specialist with a focused role, specific AI model, and restricted toolset.

### Agent Roster

| Agent | Model | Role |
|-------|-------|------|
| **Manager** | — | Orchestrator. Runs the full development workflow by delegating to specialist agents. Never writes code. |
| **Agile Coach** | Haiku | Sprint coordinator. Picks work from the Notion backlog (bugs before stories), updates task/story/epic statuses, creates feature branches, and detects already-finished work. |
| **Architect** | Opus | Software architect. Explores the codebase, understands existing patterns, and designs concrete implementation plans with test specifications for TDD. Read-only — never modifies files. |
| **Designer** | Opus | UX/UI designer. Creates modern, accessible designs for both the web app and Discord bot. UX-first approach focused on ease of use. Designs component hierarchies, user flows, and responsive layouts using Shadcn/UI. |
| **Developer** | Sonnet | The coder. Implements features according to the architect's plan, following all Effect-TS conventions. Writes code, fixes compilation errors, and addresses review feedback. |
| **Reviewer** | Sonnet | Code reviewer. Checks all changes against the project's code style rules and Effect-TS conventions (AGENTS.md). Reports issues categorized as must-fix, should-fix, or nits. Read-only. |
| **Hater** | Opus | Devil's advocate. Critiques both implementation plans (before coding) and final code (after coding). Finds logic bugs, missing edge cases, security issues, and over-engineering. Every criticism must include a concrete fix suggestion. Read-only. |
| **Tester** | Sonnet | Test engineer. Operates in two modes: **TDD mode** writes tests from the architect's spec before implementation; **verify mode** runs tests after implementation and fills coverage gaps. Uses `@effect/vitest` patterns. |
| **Refactorer** | — | Code style enforcer. Refactors changed files for Effect-TS compliance, removes unnecessary complexity. Keeps changes minimal and focused. |
| **Formatter** | Haiku | Runs `pnpm format` (Biome) to fix formatting and linting issues, then stages the fixed files. |
| **Analyzer** | Haiku | Runs `pnpm check` (TypeScript type checking). Rebuilds the domain package if needed, reports type errors with suggested fixes. |
| **Researcher** | Haiku | Documentation scout. Looks up Effect-TS APIs, library docs, and finds usage examples in the codebase. Fetches from effect.website, tanstack.com, ui.shadcn.com, and other allowed domains. |

### How It Works

The **Manager** orchestrates the full workflow. The **Agile Coach** handles all Notion task management. Together they run a 12-phase process:

```
Phase 1   Agile Coach picks up work from Notion sprint, creates branch
Phase 2   Researcher looks up unfamiliar APIs (optional)
Phase 3   Architect designs plan → Hater critiques → repeat until fool-proof → user approves
Phase 4   Tester writes failing tests from architect's spec (TDD)
Phase 5   Developer implements code to make tests pass
Phase 6   Formatter + Analyzer + Tester verify (no round limit)
Phase 7   Reviewer + Hater review → Developer fixes (no round limit)
Phase 8   Refactorer cleans up code style
Phase 9   Commit skill pushes, opens PR
Phase 10  Wait for CI + poll for code review comments
Phase 11  Developer addresses review comments → push fixes (no round limit)
Phase 12  Agile Coach updates Notion statuses, Manager reports final state
```

Each agent communicates through structured text summaries. Read-only agents (architect, reviewer, hater, researcher) cannot modify files, preventing accidental changes. The hater reviews **twice** — once on the plan (cheap to fix) and once on the code (catches what the reviewer misses). Verification, review, and feedback loops run without round limits until all issues are resolved.

### Agent Files

Agent definitions live in `.claude/agents/*.md`. Each file contains YAML frontmatter (name, model, tools, color) and markdown instructions. Skills (procedural workflows) live in `.claude/skills/*/SKILL.md`.

### Running Agents

Agents are invoked automatically by the `/work` skill, or individually:
- `/work` — full end-to-end workflow (delegates to Manager)
- `/work search feature` — work on a specific story matching "search feature"
- `/commit` — commit, push, open PR, verify CI
- `/refactor src/file.ts` — refactor a specific file

## Getting Started

### Prerequisites

**Nix + direnv (recommended):**

```sh
direnv allow
```

This provisions Node.js, pnpm, and configures git hooks automatically.

**Manual:**

- [Node.js](https://nodejs.org/) 24+
- [pnpm](https://pnpm.io/) 10.14+

### Setup

```sh
pnpm install
```

### Development

```sh
# Type check
pnpm check

# Run tests
pnpm test

# Lint & format (auto-fix)
pnpm biome:fix

# Start the server
pnpm tsx ./applications/server/src/server.ts
```

### Build

```sh
pnpm build
```

### Docker

Each application has a multi-stage Dockerfile. Build images from the repo root:

```sh
docker build -f applications/bot/Dockerfile -t sideline-bot .
docker build -f applications/server/Dockerfile -t sideline-server .
docker build -f applications/web/Dockerfile -t sideline-web .
```

Images are automatically built and pushed to GHCR on pull requests via the Snapshot workflow.

## Tech Stack

| Category       | Tool                                                       |
|----------------|------------------------------------------------------------|
| Language       | TypeScript 5.6+ (strict mode)                              |
| Effect system  | [Effect-TS](https://effect.website) 3.10+                  |
| Package mgmt   | pnpm workspaces                                            |
| Testing        | Vitest + [@effect/vitest](https://effect.website)          |
| Linting        | [Biome](https://biomejs.dev)                               |
| CI/CD          | GitHub Actions + [MajNet](https://github.com/majnet/majnet) (repo-wide `vX.Y.Z` tag releases) |

## Pre-commit Hooks

[husky](https://typicode.github.io/husky/) + [lint-staged](https://github.com/lint-staged/lint-staged) automatically run `biome check --write` on staged files before each commit.

## Documentation

| File | Contents |
|------|----------|
| [`AGENTS.md`](./AGENTS.md) | Root conventions: Effect-TS patterns, code style, CI, git, Notion |
| [`applications/web/AGENTS.md`](./applications/web/AGENTS.md) | Frontend: TanStack Router, Shadcn, forms, auth, i18n, atomic design |
| [`applications/server/AGENTS.md`](./applications/server/AGENTS.md) | Server: repositories, SQL patterns, API, middleware |
| [`applications/bot/AGENTS.md`](./applications/bot/AGENTS.md) | Bot: Discord sync, RPC, localization |
| [`packages/domain/AGENTS.md`](./packages/domain/AGENTS.md) | Domain: Model.Class, schemas, branded types |
| [`packages/migrations/AGENTS.md`](./packages/migrations/AGENTS.md) | Database migration conventions |
| [`packages/effect-lib/AGENTS.md`](./packages/effect-lib/AGENTS.md) | Shared utilities (Bind, DateTime schemas) |
| [`packages/i18n/AGENTS.md`](./packages/i18n/AGENTS.md) | Translation system (Paraglide.js) |

### Thesis Documentation

| File | Contents |
|------|----------|
| [`docs/thesis/er-diagram.md`](./docs/thesis/er-diagram.md) | Entity-relationship diagram (33 database entities) |
| [`docs/thesis/architecture.md`](./docs/thesis/architecture.md) | System architecture (deployment, packages, communication) |
| [`docs/thesis/use-cases.md`](./docs/thesis/use-cases.md) | UML use case diagrams (6 actors, 8 domains) |
| [`docs/thesis/sequence-diagrams.md`](./docs/thesis/sequence-diagrams.md) | Sequence diagrams for 8 core flows |
| [`docs/thesis/user-testing-plan.md`](./docs/thesis/user-testing-plan.md) | Usability testing plan with 12 task scenarios |
| [`docs/thesis/competitive-analysis.md`](./docs/thesis/competitive-analysis.md) | Competitive analysis with feature matrix and SWOT |

## License

[MIT](./LICENSE)
