---
name: worktree
description: Selects the next sprint ticket (or a specified one) and opens it in an isolated herdr-managed git worktree — creates the branch, seeds gitignored config (.env.local, .env.preview.local, .claude/settings.local.json), runs direnv allow + pnpm install, and launches a Claude agent inside it. Use this to spin up parallel work on a ticket without disturbing the main checkout.
---

# Worktree Skill

Pick up a ticket and open it in an isolated [herdr](https://herdr.dev) worktree with the dev environment ready and a fresh Claude agent running. Unlike `/work`, this does **not** implement the ticket — it prepares an isolated workspace so a dedicated agent can.

## Execution

Follow these phases **in order**. Stop and report if any phase fails. Pass `$ARGUMENTS` to the agile-coach if the user specified a ticket.

### Phase 1: Select the ticket

Invoke the `/agile-coach` agent via the Agent tool to:
- Find the active sprint
- Select the next **not-started** bug or story (pass `$ARGUMENTS` if the user named one)
- Update Notion statuses to In Progress
- **Determine the branch name** it would use (e.g. `feat/...` or `fix/...`)
- **Report the selected ticket's Notion page ID** (32-hex UUID)

**Skip in-progress and already-claimed tickets.** Unlike `/work`, this skill spins up a *new* dedicated agent in a *new* worktree — a ticket that is already In Progress, or that already carries a `Claude session`, almost always already has a worktree and agent on it. So instruct the agile-coach to **only consider not-started tickets** (bugs still before stories, stories by epic number), to **skip anything already In Progress**, and to **skip anything whose `Claude session` property is non-empty**. If the user named a specific ticket via `$ARGUMENTS`, honor that regardless of status or session — but surface it if that ticket is already claimed, so the user can decide before a second agent starts on it. If no unclaimed, not-started ticket remains, the agile-coach should report that and Phase 2/3 are skipped.

**Important:** Instruct the agile-coach to **NOT run any `git checkout`/`git branch` commands** and **NOT touch the main checkout** — the worktree script creates the branch from `origin/main` itself. The agile-coach should only report the branch name (new or, for resumed work, the existing branch) and the ticket's page ID.

**Do NOT stamp the `Claude session` here.** This session is not the one that will do the work — the
agent launched inside the worktree is. Explicitly tell the agile-coach **not to write the `Claude
session` property**. The worktree agent stamps its own session when its `/work <page-id>` run calls
the agile-coach in Phase 2.

Review the work summary and capture the **branch name** and the **ticket page ID**.

### Phase 2: Open the worktree

Run the bootstrap script with the branch name, the ticket title as the label, and a `--prompt` that makes the launched Claude pick up the ticket immediately:

```bash
scripts/herdr-worktree.sh <branch> --label "<ticket title>" --prompt "/work <ticket-page-id>"
```

This creates (or reuses) a herdr worktree on the branch, seeds the gitignored
config files, runs `direnv allow` + `pnpm install`, and launches a focused
Claude agent inside the worktree that **boots straight into `/work <ticket-page-id>`** —
so the worktree agent re-selects that exact ticket and implements it end-to-end.
(agile-coach is worktree-aware: it skips the `main` checkout/branch creation when
run inside a linked worktree, since the branch is already checked out there. It also stamps that
worktree agent's own session URL onto the ticket's `Claude session` property, which is what marks
the ticket as claimed for every later `/work` and `/worktree` run.)

Useful flags: `--no-install` (skip deps), `--no-agent` (prepare only), `--base <ref>` (base a new branch on something other than `origin/main`), `--prompt <text>` (override the opening command).

### Phase 3: Report

Present:
- Ticket title and Notion status
- Branch name
- Worktree path
- That the ticket's `Claude session` will be stamped by the worktree agent (not by this session)
- That a Claude agent was launched and focused in herdr, now running `/work <ticket-page-id>` (or any step that was skipped/failed)

The new agent runs `/work` autonomously inside the worktree — implementing and shipping the ticket without further input from this session.
