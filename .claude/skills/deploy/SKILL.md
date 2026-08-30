---
name: deploy
description: Release the merged main branch through MajNet — push per-app `@sideline/<app>@vX.Y.Z` release tags (stable auto-deploys), then promote to production by bumping the production overlay in sideline-cz/ops and merging the env/production render PR. Use when the user says "deploy", "release", "ship to prod", "cut a release", or "promote to production".
---

# Deploy Skill

Release `main` through **MajNet** (the GitOps platform — source: `~/Projects/majnet`, design in `docs/design.md`, ADR 0009/0018). There is **no Changesets flow** — a release is a set of **per-app git tags `@sideline/<app>@vX.Y.Z`** (continuing the historical tag naming).

**Every app has its OWN version line, and you release ONLY the apps whose code changed.** The lines drifted apart long ago and are nowhere near each other — as of 2026-08-30: proxy `v0.3.0`, docs `v0.9.0`, web `v0.36.0`, bot `v0.38.3`, server `v0.46.2`. Tagging all five at one shared version would jump most of them by dozens of minor versions and claim a release for code that never changed. Read each app's own latest tag; never invent a common one. A plain `vX.Y.Z` tag releasing every app at once is supported by the workflow but is almost never what you want.

## Pipeline reference

- **Builds (automatic, no ceremony):** every PR publishes `pr-<N>` images (ephemeral preview); every merge to `main` publishes `sha-…`/`latest` (auto-deployed to the **testing** class). Driven by `.github/workflows/build.yaml`.
- **Release = per-app git tags `@sideline/<app>@vX.Y.Z`.** `.github/workflows/release.yaml` parses each tag and builds + pushes that app's image `ghcr.io/sideline-cz/sideline/<app>:vX.Y.Z` (the IMAGE tag is the plain version — that is what MajNet reads). The GHCR `registry_package` webhook tells the MajNet bot, which records the release (version → digest) per app and **auto-tracks it into the `stable` class** — auto-merged render PR on `sideline-cz/ops` `env/stable`; the reconciler converges.
- **Production:** a separate **promote** — the `digest:` in the production overlay `apps/<app>/production.yaml` on `sideline-cz/ops` **`main`** is bumped, which renders an **`env/production` render PR**. **Merging that render PR is the production deploy trigger** — it shows the exact final manifest diff.
- **The promote is an ordinary git change and you can do it yourself** (Step 3). The MajNet dashboard is one front-end for it, not the only route; there is no bot or Tailscale identity in the loop that `git` and `gh` cannot replace.
- **Nothing actually blocks the render-PR merge.** Reviewing that diff IS the gate — do it properly rather than trusting a gate to stop you.
- The `sideline-cz/ops` repo is managed by the platform; `git log env/production` is the audit/rollback record. **Never hand-edit the rendered `env/*` branches** — but `apps/*/production.yaml` on `main` is the SOURCE overlay, and editing it is the supported path, not a workaround.

## Execution

Follow in order; stop and report on any failure.

### Step 1: Preconditions

1. The change is **merged to `main`** (feature PRs go through `/ship` first) and the `MajNet build` workflow for that merge commit succeeded (`gh run list --workflow build.yaml --branch main`).
2. Working tree on up-to-date `main`.

### Step 2: Cut the release (tag → stable)

1. Decide **which apps changed**. Only those get released — a tag for an unchanged app publishes an identical image under a new version and muddies the history:
   ```bash
   git diff --name-only <last-release-commit>..HEAD -- applications/ packages/
   ```
   `packages/**` is shared, so a change there can affect several apps; check which of them actually import it.
2. Read **each app's own latest tag** and bump that line — patch for fixes, minor for features; never major without the user asking:
   ```bash
   for app in proxy server web docs bot; do
     printf '%-8s %s\n' "$app" "$(git tag -l "@sideline/${app}@v*" --sort=-v:refname | head -1)"
   done
   ```
3. Tag each changed app at ITS next version and push **one tag per push** — GitHub does NOT create events when more than 3 tags arrive in a single push, so a bulk `git push --tags` silently triggers NOTHING:
   ```bash
   git tag "@sideline/server@v0.46.2" && git push origin "@sideline/server@v0.46.2"
   git tag "@sideline/bot@v0.38.3"    && git push origin "@sideline/bot@v0.38.3"
   ```
4. Watch `.github/workflows/release.yaml` (one run per tag) to success (`gh run watch`). Every app's run must be green.
5. Verify **stable** picked it up: the bot auto-merges a render PR on `sideline-cz/ops` targeting `env/stable` — confirm the merged PR / new commit on `env/stable` references the `vX.Y.Z` digests:
   ```bash
   gh pr list --repo sideline-cz/ops --state merged --base env/stable --limit 3
   gh api "repos/sideline-cz/ops/commits?sha=env/stable&per_page=3" --jq '.[].commit.message'
   ```

### Step 3: Promote to production

A promote is **two merges**: bump the production overlay on ops `main`, then merge the render PR it produces. The MajNet dashboard does exactly this; doing it with `git`/`gh` is equivalent and needs no Tailscale identity.

1. Clone the ops repo and branch. Name the branch and PR after the versions, matching the existing history (`promote/v0.45.1-v0.36.1`):
   ```bash
   git clone git@github.com:sideline-cz/ops.git && cd ops
   git checkout -b promote/v0.46.2-v0.38.3
   ```
2. **Get the digest for each released version, and verify it before writing it.** The digest to promote is whatever `stable` is already running, so promoting means "make production run what stable runs":
   ```bash
   grep '^digest' apps/sideline-server/stable.yaml   # the value to copy
   grep '^digest' apps/sideline-server/production.yaml # the value to replace
   ```
   Confirm the `stable.yaml` digest actually corresponds to the version you just released — it should have changed within a minute or two of that app's release workflow going green (`gh pr list --repo sideline-cz/ops --state merged --base env/stable`). A GitHub token without `read:packages` cannot query GHCR to match tag→digest directly, so this timing check is usually the available evidence; say so rather than implying a stronger verification than you did.
3. Edit ONLY the `digest:` line in `apps/<app>/production.yaml` for each app being promoted. Everything else in that file (env, resources, health) is real production config — leave it alone. `git diff` must show one changed line per app and nothing more.
4. Open and merge the promote PR into ops `main`:
   ```bash
   gh pr create --base main \
     --title "chore(production): promote server v0.46.2, bot v0.38.3 — <why, briefly>"
   gh pr merge <n> --squash --delete-branch
   ```
5. Merging renders an **`env/production` render PR** automatically. **Review its diff — this is the last point before production changes, and nothing blocks the merge for you:**
   ```bash
   gh pr diff <render-pr> --repo sideline-cz/ops
   ```
   It must be digest lines only, matching what you promoted. Secrets stay SOPS-encrypted. Anything else in the diff — env, resources, an app you did not intend — means STOP and report.
6. Merge the render PR. **This is the prod deploy.**
   ```bash
   gh pr merge <render-pr> --repo sideline-cz/ops --merge
   ```
7. Verify convergence — every promoted app's `env/production` digest now equals its `env/stable` digest:
   ```bash
   for app in server bot; do
     for br in production stable; do
       gh api "repos/sideline-cz/ops/contents/sideline-$app.yaml?ref=env/$br" \
         --jq '.content' | base64 -d | grep '^digest'
     done
   done
   ```
   This confirms the **manifests** converged, not that containers rolled — the reconciler applies asynchronously. Check the MajNet dashboard for app health, and do not report a deploy as verified on manifest state alone.

Rollback = revert the render-PR merge on `env/production`, or promote the previous digests the same way.

### Step 4: Done

Report: **every** tag pushed (one per released app), each release-workflow run, the stable render PR, the promote PR, the production render PR, and confirmation that `env/production` carries the new digests.

Be precise about what was and was not verified. Manifest convergence is not container health, and a digest matched by release timing is not a digest matched against GHCR. State which you did. Do **not** update Notion statuses — that is `/reconcile`'s job.
