---
name: diagnose
description: Diagnose a running Sideline issue — errors, bad behaviour, "why did X happen", or a failed deploy. Routes read-only investigation through the `majnet` CLI (logs, container state, events, and SQL against the managed database) and covers the failure modes that look like success. Use when the user says "look into", "check logs", "why did this happen", "deploy failed", or asks to investigate live behaviour. READ-ONLY; to change deploy config use /update-deploy-config.
---

# Diagnose Skill

Investigate a live Sideline problem with the **`majnet`** CLI — everything the dashboard does, from
a laptop: status, logs, container state, events, and SQL against an app's managed database.

> **Do not guess at production state.** Every question this skill exists to answer — "did the cron
> fire?", "did the bot get the event?", "is the setting saved?" — has an exact answer one command
> away. Reasoning from source code about what production *probably* did is how an evening gets
> spent on two wrong theories.

## Before anything

```sh
majnet whoami          # ALWAYS first
```

**If it says *unidentified*, stop and report it.** Identity is the Tailscale device, not a token.
An identity-less call is treated as the WireGuard break-glass and **passes every role check** —
`whoami` will even print `admin: true`, which means "nobody checked", not "you are an admin".
Causes: this machine is off the tailnet, the URL is not the identity-injecting front door, or the
tailnet login has no entry in `people.yaml`.

Not installed?

```sh
curl -fsSL https://raw.githubusercontent.com/majnet/majnet/main/scripts/install-cli.sh | bash
majnet agent-guide     # the authoritative reference — prefer it over this file when they disagree
```

## Environment classes

`production`, `stable`, `testing`, `ephemeral`. **The CLI defaults to `stable`** — pass
`-c production` explicitly or you will be reading the wrong environment and drawing confident
conclusions from it. `production` needs project **admin** even to read, and prompts unless `--yes`.

Sideline's project is `sideline`. **The apps are named `sideline-server`, `sideline-bot`,
`sideline-web`, `sideline-docs`, `sideline-proxy`** — the project prefix is part of the app name, so
`majnet logs sideline bot` fails. Confirm with `majnet apps sideline` rather than guessing.

## Reading state

```sh
majnet status                                          # start here: health, deploys, recent failures
majnet events --failed --project sideline              # what broke, and why
majnet logs sideline sideline-bot -c production -n 300          # container logs (--follow to tail)
majnet ps sideline sideline-server -c production                # what is actually running
majnet info sideline sideline-server                            # what each env reported at /info
majnet app sideline sideline-server                             # image, classes, build info, containers
```

Add `--output json` for anything you parse — table output is elided by design.

## SQL against the managed database

This is the part most easily forgotten, and the most valuable. **Read-only by default.**

```sh
majnet db  sideline sideline-server -c production                        # engine + database name
majnet sql sideline sideline-server -c production --tables
majnet sql sideline sideline-server -c production --columns team_settings
majnet sql sideline sideline-server -c production 'SELECT count(*) FROM email_messages'
```

- Runs as **the app's own database role**, never superuser — a query has exactly the app's privileges.
- Without `--write` the statement runs in a read-only transaction. That is a seatbelt against a
  mistyped `UPDATE`, **not** a sandbox.
- **One statement per call.** Multiple statements concatenate result sets and the parsed shape stops
  being meaningful.
- Every returned value is a **string** — the engine's text output is not re-typed, so a `numeric` or
  `timestamptz` arrives verbatim rather than guessed at.
- `--limit` caps what is *printed*; the statement still runs in full, and `truncated: true` says rows
  were dropped.

## Answers that look like success but are not

Re-read this when something seems wrong.

| What you see | What it means |
|---|---|
| `whoami` says *unidentified* | No identity reached the API; every role check was skipped. Do not proceed with writes. |
| HTTP **200** with `text/html` from `/api` | Auth failure wearing a success code — the request fell through to the dashboard SPA. Never parse the HTML. |
| `converged: null` on `control-plane status` | The build did not report its version. **Unknown**, not "not converged". |
| `mergeable: null` on a render PR | GitHub is still computing it. Wait; it is not a refusal. |
| Empty `majnet ps`, healthy `majnet apps` | Declared for that class but nothing running — often the class was never rendered, or a deploy failed. `majnet events --failed` names it. |

## Rules

- **Read before you write.** `majnet status` and the relevant `logs` first.
- **Never `--yes` on a production command** unless the human asked for that specific action in this
  conversation. The prompt exists because production is the class the platform itself gates.
- **Never `--write` a SQL statement on your own initiative.** Propose it, show what the read-only
  version returns, let the human decide.
- **Never `--reveal` a secret unless asked**, and never echo a revealed value into a summary, a
  commit message, or a file.
- **Report what the platform said, not what you hoped.** Quote stderr on failure. If identity was
  unresolved, say so instead of continuing.
- Prefer `exec` over `shell` — scriptable, role-scoped, returns an exit code. `shell` needs platform
  admin and records a transcript a person will read.
- Everything is audited: `exec`, `sql`, `restart`, `shell` all write an event naming the caller and
  what was run.

## A worked example

The scheduled rules quiz did not post. What actually settled it, in order:

```sh
majnet sql sideline sideline-server -c production \
  'SELECT rules_quiz_channel_id, rules_quiz_time, timezone FROM team_settings WHERE rules_quiz_channel_id IS NOT NULL'
majnet sql sideline sideline-server -c production \
  'SELECT scenario_id, attempts, processed_at, last_error FROM rules_quiz_sync_events ORDER BY scheduled_for DESC LIMIT 5'
majnet logs sideline sideline-bot -c production -n 500      # the cause, in the log line's cause field
```

The settings were fine and the cron had fired; `attempts = 0` with `last_error = NULL` ruled out
every post-attempt failure; the log line named a schema encode error. **Three commands.** Two
plausible theories — cron drift, then the newly-shipped attachment code — were both wrong and both
excluded by data that was already there.

## Deploy state

`majnet status` and `majnet events --failed` cover the deploy questions. Deploys are git: `promote`,
`rollback`, manifest changes and release cuts are commits and PRs, so their output describes what was
*written* — the rollout follows when the render PR merges. `majnet deploy list` shows render PRs
waiting, `majnet deploy progress` shows rollouts in flight.

**Green GitHub CI does not mean a green deploy.** They are independent; check the platform directly.
