---
name: deploy
description: Take a reviewed PR all the way to production — merge the feature PR, merge the Changesets "Version Packages" release PR (which publishes and auto-deploys to dev), wait for the dev deploy to succeed, then promote the released apps to prod. Use when the user says "deploy", "ship to prod", "release and deploy", "merge it and deploy", or "merge release, deploy to dev and prod".
---

# Deploy Skill

Promote a merged/approved change from a feature PR all the way to production.

This automates the release train: **feature PR → release PR → dev → prod**. The Sideline
release pipeline (`.github/workflows/release.yml`) auto-deploys to **dev** when the release
PR merges; **prod** is a separate manual promotion in the ops repo
(`maxa-ondrej/majksa-ops`).

## Pipeline reference (how the repo works)

- `release.yml` runs on every push to `main`. It uses Changesets:
  - When pending changesets exist → it opens/updates a **"Version Packages"** PR
    (branch `changeset-release/main`).
  - When that release PR is merged → it **publishes** the new versions, builds a Docker
    image per changed app under `applications/`, and dispatches a `deploy`
    `repository_dispatch` to `maxa-ondrej/majksa-ops` with
    `{"env":"dev","app":"sideline","service":"<app>","version":"<version>"}`.
- `maxa-ondrej/majksa-ops` — **the actual deploy is a TWO-STAGE process. Bumping the tag is
  NOT a deploy.** Stage 1 records the desired version on `main`; Stage 2 is what actually
  rolls the running containers, and it requires merging a PR:
  - `deploy.yml` (on `repository_dispatch: deploy`) **Stage 1**: bumps the tag in
    `config/sideline/<service>/service.<env>.yml` on `main`, commits, then runs
    `sync_config.yml`.
  - `sync_config.yml` renders the `main` config into the long-lived **`env/<env>`** branch and
    **opens/updates a PR** `update/env/<env> → env/<env>` (title "(env/<env>) Sync config").
    **This PR does NOT auto-merge.** Until it is merged, the running environment is unchanged.
  - `rollout.yml` (on **push to `env/*`**) **Stage 2**: the real Coolify rollout
    (`sync_service` / `sync_secrets` / `sync_deploy`). It only fires when the `update/env/<env>`
    PR is **merged** into `env/<env>`.
  - `manual_deploy.yml` (`workflow_dispatch`, inputs `env`, `app`, `service`, `version`) is just a
    convenience that re-dispatches a `deploy` event — it still only does **Stage 1** (and thus
    still leaves an env-sync PR to merge).
  - The `env/<env>` branch's `sideline/<service>/service.yaml` `tag:` is the source of truth for
    **what is actually running**. The `main` `config/.../service.<env>.yml` tag is only the
    *desired* state.
- Only apps under `applications/` (e.g. `server`, `bot`, `web`, `proxy`, `docs`) get Docker
  images and deploys. Package-only bumps (`@sideline/domain`, `@sideline/i18n`,
  `@sideline/effect-lib`) do NOT deploy on their own.

> **⚠️ Concurrency collision (important).** `majksa-ops/deploy.yml` uses
> `concurrency.group = deploy-<env>-<app>` keyed on **app**, NOT service, with
> `cancel-in-progress: false`. So two deploys for the **same app but different services**
> (e.g. `sideline/server` + `sideline/bot`) in the **same env** collide on one group — one
> runs, the other can be **cancelled** (it shows conclusion `failure` with a `cancelled`
> job and no error logs). The release Docker matrix dispatches all changed apps' **dev**
> deploys in parallel, so when a release bumps 2+ apps, expect one dev deploy to be
> cancelled. **Mitigation:** after the dev deploys, verify EACH service's tag actually
> updated; re-trigger any that didn't (Step 6). For **prod**, deploy services
> **sequentially** — fully finish one before dispatching the next (Step 7).

## Conventions

- Repo: `maxa-ondrej/sideline`. Ops repo: `maxa-ondrej/majksa-ops`.
- Merge method: **squash** (`--squash --delete-branch`). The repo disallows merge commits.
- Never deploy from a red pipeline. Wait for required checks before each merge.

## Execution

Follow these steps **in order**. Stop and report if any step fails — never proceed to a
later environment when an earlier one failed.

---

### Step 1: Identify the feature PR

Determine the PR to deploy:
- If the user names a PR number, use it.
- Else use the PR for the current branch: `gh pr view --json number,title,headRefName,state,mergeable,mergeStateStatus`.
- If it is already merged, skip to Step 3 (the release PR may already exist).
- If there is no PR, stop and tell the user there is nothing to deploy.

---

### Step 2: Verify CI and merge the feature PR

1. Confirm all **required** checks pass: `gh pr checks <pr>`. (`CodeRabbit` is advisory/non-required
   — a pending or skipped CodeRabbit check is fine; do NOT block on it. But if CodeRabbit has
   posted **actionable** review comments, surface them and ask the user before merging.)
2. If a required check is pending, wait for it: `gh run watch <run-id> --exit-status` (run in
   background; you are notified on completion). If a required check fails, stop and report.
3. Merge: `gh pr merge <pr> --squash --delete-branch`.

---

### Step 3: Wait for the release PR

Merging to `main` triggers `release.yml`, which opens/updates the **"Version Packages"** PR.

1. Wait for the latest `release.yml` run on `main` to finish:
   `gh run list --branch main --workflow release.yml --limit 1 --json databaseId,status` then
   `gh run watch <id> --exit-status`.
2. Find the release PR:
   `gh pr list --state open --json number,title,headRefName` → the one with
   `headRefName == "changeset-release/main"` (title "Version Packages").
3. If **no** release PR appears and the release run reported `published == true`, then there were
   no pending changesets and nothing new shipped — stop and tell the user (likely the change had
   no changeset).

---

### Step 4: Record which apps will deploy

Inspect the release PR diff to learn the app→version map (you need this for prod in Step 7):

```bash
gh pr diff <release-pr> --patch | grep -A2 -E 'applications/(server|bot|web|proxy|docs)/package.json'
```

For each changed `applications/<app>/package.json`, capture the new `"version"`. These are the
services that will deploy. Package-only bumps (`packages/*`) do not deploy.

---

### Step 5: Merge the release PR (publishes + auto-deploys to dev)

1. Wait for the release PR's required checks (`check.yml`) to pass — it starts `BLOCKED` until CI
   is green. Watch the run, same as Step 2.
2. Merge: `gh pr merge <release-pr> --squash --delete-branch`.
3. This triggers a new `release.yml` run that **publishes** and runs the **Docker** matrix job
   (one per changed app), each dispatching the dev `deploy` event. Watch that run to success:
   `gh run watch <release-run-id> --exit-status` and confirm the `Release` + `Docker (<app>)`
   jobs succeed: `gh run view <id> --json jobs --jq '.jobs[] | "\(.name): \(.conclusion)"'`.

---

### Step 6: Roll out to DEV (Stage 1 tag-bump + Stage 2 PR-merge)

The Docker job dispatched `deploy` (env=dev) to `maxa-ondrej/majksa-ops`. That only does
**Stage 1**. You must complete **Stage 2** (merge the env-sync PR) for dev to actually update.

1. **Stage 1 — watch the `deploy.yml` run(s)** (one per changed app):
   `gh run list --repo maxa-ondrej/majksa-ops --workflow deploy.yml --limit <n> --json databaseId,status,conclusion`.
   Watch each to completion. **Verify EACH service's `main` dev tag updated** (a *cancelled*
   run from the concurrency collision looks like a failure and leaves the tag stale):
   `gh api repos/maxa-ondrej/majksa-ops/contents/config/sideline/<service>/service.dev.yml --jq .content | base64 -d | grep '^tag:'`.
   If a service was cancelled, re-trigger just it and re-verify:
   `gh workflow run manual_deploy.yml --repo maxa-ondrej/majksa-ops -f env=dev -f app=sideline -f service=<service> -f version=<version>`.
2. **Stage 2 — merge the dev env-sync PR (THIS is the actual rollout).** `sync_config` opened/updated
   a PR `update/env/dev → env/dev`. Find and merge it:
   ```bash
   gh pr list --repo maxa-ondrej/majksa-ops --state open --json number,headRefName,baseRefName \
     --jq '.[] | select(.baseRefName=="env/dev")'
   gh pr merge <num> --repo maxa-ondrej/majksa-ops --squash   # do NOT --delete-branch (sync reuses it)
   ```
   Confirm the PR diff contains the expected new tags before merging. If `sync_config` is still
   running (PR not yet created/updated with the new tags), wait for it.
3. **Watch the `rollout.yml` run on `env/dev`** (the real Coolify deploy):
   `gh run list --repo maxa-ondrej/majksa-ops --workflow rollout.yml --limit 3 --json databaseId,headBranch,status,conclusion`
   → the one with `headBranch == "env/dev"`. `gh run watch <id> --exit-status`.
4. **Verify what is actually running** — the `env/dev` branch tag:
   `gh api "repos/maxa-ondrej/majksa-ops/contents/sideline/<service>/service.yaml?ref=env/dev" --jq .content | base64 -d | grep '^tag:'`
   — confirm it equals the new version for every changed service.
5. **If the dev rollout fails, STOP.** Do not promote to prod. Report the failure.

---

### Step 7: Roll out to PROD (Stage 1 per service + Stage 2 PR-merge)

1. **Stage 1 — bump each app's prod tag**, one service at a time (sequential, to avoid the
   `deploy-prod-sideline` concurrency collision):
   ```bash
   gh workflow run manual_deploy.yml --repo maxa-ondrej/majksa-ops \
     -f env=prod -f app=sideline -f service=<service> -f version=<version>
   ```
   Watch each `manual_deploy.yml` run and the resulting `deploy.yml` run to completion, and verify
   the `main` `service.prod.yml` tag updated, before starting the next service.
2. **Stage 2 — merge the prod env-sync PR (THIS is the actual prod rollout).** After all services'
   prod tags are bumped on `main`, `sync_config` will have opened/updated a PR
   `update/env/prod → env/prod`. Confirm its diff shows the expected tags for every service, then:
   ```bash
   gh pr merge <num> --repo maxa-ondrej/majksa-ops --squash
   ```
3. **Watch the `rollout.yml` run on `env/prod`** to completion (`gh run watch <id> --exit-status`).
4. **Verify the `env/prod` branch tags** equal the new versions:
   `gh api "repos/maxa-ondrej/majksa-ops/contents/sideline/<service>/service.yaml?ref=env/prod" --jq .content | base64 -d | grep '^tag:'`.

> A deploy is **not done** until the `rollout.yml` run succeeded AND the `env/<env>` branch tag
> shows the new version. A green `deploy.yml` / updated `main` config tag alone means nothing has
> rolled out yet.

---

### Step 8: Done

Report a concise summary: the merged feature PR, the merged release PR + published versions, the
merged env-sync PRs, the dev + prod **`rollout.yml`** run links/status, and the confirmed
**`env/dev` and `env/prod`** branch tags (the real running versions).

Do **not** update Notion statuses — that is the `/agile-coach` / `/reconcile` agent's job.
