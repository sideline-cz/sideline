---
name: deploy
description: Release the merged main branch through MajNet — cut a repo-wide vX.Y.Z release (stable auto-deploys), then promote it to production via the admin-gated env/production render PR in sideline-cz/ops. Use when the user says "deploy", "release", "ship to prod", "cut a release", or "promote to production".
---

# Deploy Skill

Release `main` through **MajNet** (the GitOps platform — source: `~/Projects/majnet`, design in `docs/design.md`, ADR 0009/0018). There is **no Changesets flow** — a release is a repo-wide `vX.Y.Z` git tag; one tag releases every app in the monorepo.

## Pipeline reference

- **Builds (automatic, no ceremony):** every PR publishes `pr-<N>` images (ephemeral preview); every merge to `main` publishes `sha-…`/`latest` (auto-deployed to the **testing** class). Driven by `.github/workflows/build.yaml`.
- **Release = a `vX.Y.Z` git tag on this repo.** `.github/workflows/release.yaml` builds + pushes `ghcr.io/sideline-cz/sideline/<app>:vX.Y.Z` for every app. The GHCR `registry_package` webhook tells the MajNet bot, which records the release (version → digest) and **auto-tracks it into the `stable` class** — the bot opens and auto-merges a render PR on `sideline-cz/ops` `env/stable`; the reconciler converges.
- **Production:** a separate **promote** of a chosen release (MajNet dashboard, or its CLI if available) → the bot commits the digest to the production overlay and opens an **`env/production` render PR** on `sideline-cz/ops`. **Merging that render PR is the production deploy trigger** and requires admin review — it shows the exact final manifest diff.
- The `sideline-cz/ops` repo is managed by the platform; `git log env/production` is the audit/rollback record. Never hand-edit rendered `env/*` branches.

## Execution

Follow in order; stop and report on any failure.

### Step 1: Preconditions

1. The change is **merged to `main`** (feature PRs go through `/ship` first) and the `MajNet build` workflow for that merge commit succeeded (`gh run list --workflow build.yaml --branch main`).
2. Working tree on up-to-date `main`.

### Step 2: Cut the release (tag → stable)

1. Determine the version: repo-wide semver line from the latest `v*` tag (`git tag -l 'v*' --sort=-v:refname | head -1`). Bump patch for fixes, minor for features; never major without the user asking.
2. Prefer the MajNet dashboard's **cut** action if the user wants to drive it; otherwise tag directly:
   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
3. Watch `.github/workflows/release.yaml` for the tag to success (`gh run watch`). All app matrix entries must be green.
4. Verify **stable** picked it up: the bot auto-merges a render PR on `sideline-cz/ops` targeting `env/stable` — confirm the merged PR / new commit on `env/stable` references the `vX.Y.Z` digests:
   ```bash
   gh pr list --repo sideline-cz/ops --state merged --base env/stable --limit 3
   gh api "repos/sideline-cz/ops/commits?sha=env/stable&per_page=3" --jq '.[].commit.message'
   ```

### Step 3: Promote to production

1. Trigger the **promote** for `vX.Y.Z` (MajNet dashboard → project sideline → promote; requests are authorized via Tailscale identity, so this step may need the user).
2. The bot opens the **`env/production` render PR** on `sideline-cz/ops`. Review its diff — it is the exact final manifest change (image digests; secrets stay SOPS-encrypted). Confirm every app's digest matches the release.
3. Merge the render PR (admin gate). **This is the prod deploy.**
4. Verify convergence: new commit on `env/production` with the expected digests; check the MajNet dashboard / app health. Rollback = revert the render-PR merge on `env/production` (or promote the previous release).

### Step 4: Done

Report: the tag, the release-workflow run, the stable render PR, the production render PR, and confirmation `env/production` carries the new digests. Do **not** update Notion statuses — that is `/reconcile`'s job.
