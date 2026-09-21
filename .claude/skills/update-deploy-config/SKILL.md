---
name: update-deploy-config
description: Change Sideline deploy configuration — environment variables, image digests, domains, resources, healthchecks — for a MajNet environment class (production / stable / testing). Config lives in the `sideline-cz/ops` GitOps repo; edits go to `main` and take effect when the rendered `env/<class>` PR merges. Use when the user asks to set a deploy env var, flip a feature flag, change domains/resources, or read a secret's name. Releasing an app version is `/deploy`, not this skill.
---

# Update Deploy Config Skill

Sideline's deploy config is **GitOps-managed** in **`sideline-cz/ops`**, cloned at **`/data/sideline/ops`**
(`git@github.com:sideline-cz/ops.git`). The control plane is **MajNet**, same platform as `/deploy`.

**Read `.claude/skills/deploy/SKILL.md` first.** It describes this same GitOps flow for the digest case and
everything it says about render PRs applies here verbatim; this skill does not repeat it. The difference is
only *which line you edit*: `/deploy` bumps `digest:`, this skill changes `env:`, `ingress:`, `resources:`,
`health:` or reads `secrets:`.

The `majnet` CLI is **read-only for config** — it has no `secrets set`, no `env set`. You edit YAML on `main`
and let the bot render. `majnet agent-guide` is the CLI's own reference.

## Where things live

Five apps, one directory each. There is no `config/sideline/`, no `service.yml`, no `.dev`/`.prod` split,
and no separate `secrets.*.enc.yaml` file:

```
apps/sideline-<app>/          # app ∈ { proxy, server, web, docs, bot }
├── base.yaml                 # all classes: name, image, otel, health, database, resources, non-secret env
├── production.yaml           # per-class overlay
├── stable.yaml
└── testing.yaml
```

Environment classes are **`production` / `stable` / `testing` / `ephemeral`** — **there is no `dev`**.

| Class | Rolls out when | Domain |
|---|---|---|
| `production` | a human merges the `env/production` render PR | `sideline.cz` |
| `stable` | automatically — the `env/stable` render PR **auto-merges** | `dev.sideline.cz` |
| `testing` | automatically, on every merge to sideline `main` | `sideline-<app>.sideline.majksa.net` |
| `ephemeral` | PR previews — **currently disabled for sideline** (ops `baa8cdaf`, capacity). No overlay files exist. |

Each overlay file carries both kinds of value, in the same file:

- **Non-secret** (URLs, flags, model names, IDs) → `env:`. Put it in `base.yaml` if it is identical for every
  class, in `<class>.yaml` if it differs. A `<class>.yaml` key overrides the same key in `base.yaml`.
- **Secret** (keys, tokens, passwords) → `secrets:`, as `NAME: majnet:<base64 age ciphertext>`. Committed
  encrypted, decrypted by the reconciler at deploy time.

Both land in the container's environment. A worked shape (`apps/sideline-server/stable.yaml`):

```yaml
digest: sha256:82417d0589ef…
image: ghcr.io/sideline-cz/sideline/server
env:
  AI_CHAT_ENABLED: 'true'
  APP_ENV: development
  APP_ORIGIN: dev.sideline.cz
secrets:
  DISCORD_CLIENT_SECRET: majnet:YWdlLWVuY3J5cHRpb24ub3JnL3Yx…
```

YAML scalars are passed through as-is, so **quote anything that is not a string on its face** — `'true'`,
`'80'`, `'1471835285858942976'`. An unquoted `true` or a long numeric ID is a YAML bool/int and will not
render as you expect.

## Secrets

**You cannot set a secret from the CLI or by hand.** Values are written by the `majnet-platform[bot]` through
the MajNet dashboard, which commits straight to ops `main` as
`secrets(sideline-<app>): set N value(s) in <class>.yaml`. There is no `sops edit` step, no `.age-key` file,
and no plaintext working copy — the old SOPS-file workflow does not exist here.

Reading is CLI-side and role-gated:

```bash
majnet secrets sideline sideline-server -c production            # NAMES only
majnet secrets sideline sideline-server -c production --reveal   # values — only when asked
```

Never `--reveal` unless the user asked for that value, and never echo a revealed value into a summary, a
commit message, a PR body, or a file. To *add* a secret, tell the user to set it in the dashboard and say
which app and class — do not improvise an encryption step.

## The trap: promoting to production takes TWO merges

**This is the part that bites, and it cost real time.** Merging your PR to ops `main` does **not** deploy
production. It only makes the bot *render*, which opens an **`env/production` render PR**. Merging **that
second PR** is the deploy trigger.

The `env/stable` render PR **auto-merges within seconds**, so stable rolls out on its own and everything looks
like it worked. Production silently does not. The symptom — feature absent on `sideline.cz`, nothing in the
server logs, working fine on `dev.sideline.cz` — is indistinguishable from "the feature is broken".

Measured on the real thing (ops PR #1728, `chore(sideline-server): enable the AI assistant`, one commit
touching both `stable.yaml` and `production.yaml`):

| Event | Time (UTC) | Merged by |
|---|---|---|
| PR #1728 merged to ops `main` | 13:28:42 | human |
| render PR #1729 → `env/stable` opened | 13:28:51 | — |
| render PR #1729 **auto-merged** → stable live | 13:28:53 | `majnet-platform[bot]` |
| render PR #1730 → `env/production` opened | 13:29:01 | — |
| render PR #1730 merged → production live | **13:42:10** | human |

**13 minutes** where stable had the flag and production did not. Nothing was broken; the second merge had not
happened. If you change `production.yaml` and do not merge the render PR, you have not deployed — say so
explicitly rather than reporting the change as shipped.

Never hand-edit the `env/*` branches. They are rendered output.

## Execution

Follow in order; stop and report on any failure.

1. **Sync and branch** in the ops clone:
   ```bash
   cd /data/sideline/ops && git checkout main && git pull
   git checkout -b chore/<short-description>
   ```
2. **Decide the class(es).** Changing a value for production only touches `production.yaml`; a value true
   everywhere goes in `base.yaml`. A flag being rolled out normally changes `stable.yaml` and
   `production.yaml` in one commit — as #1728 did.
3. **Edit the `env:` block(s).** Touch nothing else. `git diff` must show only the lines you intended —
   a stray `digest:` change in the same PR is an unannounced release.
4. **Commit and open a PR to ops `main`.** Match the existing subject style:
   ```bash
   git commit -am "chore(sideline-server): enable the AI assistant"
   gh pr create --repo sideline-cz/ops --base main --title "chore(sideline-<app>): <what changed>"
   ```
   Prefer a reviewed PR over pushing to `main` — production config is real. Never put a secret value in the
   branch name, title, or body.
5. **Merge the PR.** `gh pr merge <n> --repo sideline-cz/ops --squash --delete-branch`. This **renders only.**
6. **If you touched `stable.yaml` or `testing.yaml`:** nothing more to do — that render PR auto-merges. Confirm
   it did:
   ```bash
   gh pr list --repo sideline-cz/ops --state merged --base env/stable --limit 3 \
     --json number,createdAt,mergedAt,mergedBy
   ```
7. **If you touched `production.yaml`: find and review the `env/production` render PR, then merge it.**
   ```bash
   majnet deploy list sideline                          # render PRs waiting
   gh pr diff <render-pr> --repo sideline-cz/ops        # review: this is the last gate, and nothing blocks it
   gh pr merge <render-pr> --repo sideline-cz/ops --merge
   ```
   The diff must contain only what you changed. Secrets stay `majnet:`-encrypted in it. An unexpected app,
   digest or env key in the diff means **STOP and report**.
8. **Verify the container, not the manifest.** The reconciler applies asynchronously, so a converged
   `env/production` branch does not mean the new config is running:
   ```bash
   majnet ps sideline sideline-server -c production
   ```
   Both things must hold: `image` ends in the digest you expect, **and** `status` reads `Up … (healthy)`.
   A `running` container that never became healthy is a failed rollout. If `majnet ps` is empty while
   `majnet apps sideline` lists the app, the class did not render or the deploy failed —
   `majnet events --failed --project sideline` names the reason.
   Then confirm the app actually read the value, e.g. `majnet logs sideline sideline-server -c production`
   or the feature's own surface on `sideline.cz`.

Rollback = revert the config commit on ops `main` the same way (PR → merge → merge the render PR), or
`majnet deploy rollback sideline`.

## Report

State, separately: the ops PR, whether the `env/stable` render PR auto-merged, whether the `env/production`
render PR **was merged by you** or is still open, and what `majnet ps` showed (digest **and** health).

Be precise about what was and was not verified. **Manifest convergence is not container health, and a merge
to ops `main` is not a production deploy.** If `whoami` reports `identity: unidentified`, the control plane is
treating the call as `infra` break-glass and passing every role check — stop and report instead of writing.
