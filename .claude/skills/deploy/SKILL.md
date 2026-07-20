---
name: deploy
description: Release the merged main branch through MajNet — push per-app `@sideline/<app>@vX.Y.Z` release tags (stable auto-deploys), then promote to production via the admin-gated env/production render PR in sideline-cz/ops. Use when the user says "deploy", "release", "ship to prod", "cut a release", or "promote to production".
---

# Deploy Skill

Release `main` through **MajNet** (the GitOps platform — source: `~/Projects/majnet`, design in `docs/design.md`, ADR 0009/0018). There is **no Changesets flow** — a release is a set of **per-app git tags `@sideline/<app>@vX.Y.Z`** (continuing the historical tag naming); all apps normally release together at the same version. A plain `vX.Y.Z` tag is a supported fallback that releases every app at once (what the MajNet dashboard's repo-wide cut would produce).

## Pipeline reference

- **Builds (automatic, no ceremony):** every PR publishes `pr-<N>` images (ephemeral preview); every merge to `main` publishes `sha-…`/`latest` (auto-deployed to the **testing** class). Driven by `.github/workflows/build.yaml`.
- **Release = per-app git tags `@sideline/<app>@vX.Y.Z`.** `.github/workflows/release.yaml` parses each tag and builds + pushes that app's image `ghcr.io/sideline-cz/sideline/<app>:vX.Y.Z` (the IMAGE tag is the plain version — that is what MajNet reads). The GHCR `registry_package` webhook tells the MajNet bot, which records the release (version → digest) per app and **auto-tracks it into the `stable` class** — auto-merged render PR on `sideline-cz/ops` `env/stable`; the reconciler converges.
- **Production:** a separate **promote** of a chosen release (MajNet dashboard, or its CLI if available) → the bot commits the digest to the production overlay and opens an **`env/production` render PR** on `sideline-cz/ops`. **Merging that render PR is the production deploy trigger** and requires admin review — it shows the exact final manifest diff.
- The `sideline-cz/ops` repo is managed by the platform; `git log env/production` is the audit/rollback record. Never hand-edit rendered `env/*` branches.

## Execution

Follow in order; stop and report on any failure.

### Step 1: Preconditions

1. The change is **merged to `main`** (feature PRs go through `/ship` first) and the `MajNet build` workflow for that merge commit succeeded (`gh run list --workflow build.yaml --branch main`).
2. Working tree on up-to-date `main`.

### Step 2: Cut the release (tag → stable)

1. Determine the version: shared semver line from the latest release tags (`git tag -l '@sideline/*@v*' --sort=-v:refname | head -5`). Bump patch for fixes, minor for features; never major without the user asking.
2. Tag every app being released (normally all five) at the new version and push:
   ```bash
   V=X.Y.Z
   for app in proxy server web docs bot; do git tag "@sideline/${app}@v${V}"; done
   git push origin --tags
   ```
3. Watch `.github/workflows/release.yaml` (one run per tag) to success (`gh run watch`). Every app's run must be green.
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
