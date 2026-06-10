---
name: diagnose-deploy
description: Diagnose a Coolify preview/production deployment failure using the Coolify CLI. Finds the app, reads the latest deployment status and build logs, classifies the failure as transient infra (build-host OOM, registry/network, exit 255) vs a real code/migration/config defect, and recommends a fix or redeploy. Use when the user says "preview deploy failed", "deployment failed", "check the deploy", "why did Coolify fail", or asks to investigate/redeploy a Coolify deployment.
---

# Diagnose Deploy Skill

Investigate a **Coolify** deployment failure end-to-end with the `coolify` CLI, find the
real root cause from the build logs, and tell the user whether to just redeploy (transient)
or fix code (deterministic).

This repo deploys **out-of-band via Coolify** (`coolify.majksa.net`) — there is **no GitHub
Actions deploy workflow**. A `majksa-deploy[bot]` comment on each PR links to the Coolify
build/application logs (behind auth), and reports 🟡 in-progress / 🔴 failed / 🟢 success.
GitHub "Check" CI passing does **not** mean the Coolify deploy passed — they are independent.

## Prerequisites

- `coolify` CLI installed (`brew install coollabsio/coolify-cli/coolify-cli`).
- A context configured for the self-hosted instance. This repo uses **`majksa.net`**
  (`https://coolify.majksa.net`), normally the default context.
- Regenerate the CLI's own docs anytime with `coolify docs llms` (writes `llms.txt` /
  `llms-full.txt` to cwd — **both are gitignored; never commit them**).

Verify access first:

```bash
coolify context verify          # expect: Connection successful / Authentication valid
```

If it fails, tell the user to set a token: `coolify context add -d majksa.net https://coolify.majksa.net <token>` (token from the Coolify dashboard at `/security/api-tokens`).

## How this repo's preview deploys are shaped

- One Coolify **application resource per PR** builds ALL services via a docker-compose
  buildpack: services are named `server-pr-<PR>`, `bot-pr-<PR>`, `web-pr-<PR>`, `docs-pr-<PR>`.
- Preview FQDN pattern: **`sideline-preview-<PR>.majksa.net`**.
- The compose `build` step runs each app's Dockerfile, which does
  `pnpm --recursive --parallel run codegen && pnpm build` — i.e. **all apps build in parallel**,
  which is memory-heavy and the usual culprit for transient OOM kills.

## Procedure

### Step 1 — Find the deployment

If the user gives a deployment UUID or app UUID, use it. Otherwise discover the app:

```bash
# Identify the PR (from the branch, the user, or `gh pr view --json number`).
coolify app list --format json
```

Match the app whose name/fqdn contains `pr-<PR>` or `sideline-preview-<PR>`. The PR's
`majksa-deploy[bot]` comment also embeds the app + deployment UUIDs in its log URLs
(`.../application/<APP_UUID>/deployment/<DEPLOYMENT_UUID>`):

```bash
gh api repos/maxa-ondrej/sideline/issues/<PR>/comments \
  --jq '.[] | select(.user.login=="majksa-deploy[bot]") | .body'
```

### Step 2 — Read deployment history

```bash
coolify app deployments list <APP_UUID> --format json > /tmp/deps.json
```

Each deployment object has: `deployment_uuid`, `status` (`finished` | `failed` |
`cancelled-by-user` | `in_progress`/`queued`), `commit`, `commit_message`, `finished_at`,
`created_at`, and a `logs` field (a JSON-encoded array of `{output,...}` entries).

Summarize the recent deployments — **status + commit + time**:

```bash
python3 - <<'PY'
import json
d=json.load(open('/tmp/deps.json'))
items=d if isinstance(d,list) else d.get('deployments',d.get('data',[]))
for x in items[:12]:
    print(x.get('created_at'),'status=%s'%x.get('status'),
          'commit=%s'%str(x.get('commit_message') or x.get('commit'))[:40],
          'uuid=%s'%(x.get('deployment_uuid') or x.get('uuid')))
PY
```

**Critical first check:** is there a *later* deployment of the **same commit** that
`finished`? If a retry of the same SHA succeeded, the failure was almost certainly
**transient** — say so and stop unless the user wants the failed-build root cause anyway.

### Step 3 — Extract the failed build's error

Pull the failed deployment's `logs`, decode the nested JSON, and read the tail:

```bash
python3 - <<'PY'
import json
d=json.load(open('/tmp/deps.json'))
items=d if isinstance(d,list) else d.get('deployments',d.get('data',[]))
fail=next((x for x in items if x.get('status')=='failed'), None)   # or match a UUID
if not fail: print('no failed deployment found'); raise SystemExit
logs=fail['logs']
if isinstance(logs,str): logs=json.loads(logs)
out="\n".join(e.get('output','') if isinstance(e,dict) else str(e) for e in logs)
open('/tmp/deploy_out.txt','w').write(out)
print(out[-4000:])   # tail: the failure line is at the very end
PY
```

The decisive line looks like:
`Deployment failed: Command execution failed (exit code N): docker compose ... build`.
Scan upward for the last service step that was running (`#NN [<svc>-pr-<PR> build 4/4] RUN ... pnpm build`) and whether earlier services printed `DONE`.

### Step 4 — Classify the failure

| Signature in the logs | Class | Action |
|---|---|---|
| `exit code 255` mid-`docker compose build`, some apps `DONE` then one killed with no compiler error; identical commit later `finished` | **Transient — build-host OOM / resource exhaustion** (parallel multi-app builds) | Redeploy; no code change |
| `failed to solve` / `pull access denied` / network/registry timeout / TLS | **Transient — registry/network** | Redeploy |
| `error TS####` / `Type error` / biome / `astro build` error / `vite` build error | **Deterministic — build/code** | Fix the code, push |
| `relation/column ... does not exist`, `constraint ... is violated by some row`, `migration` SQL error in the **application** logs (not build) | **Deterministic — migration/runtime** | Fix migration; check it's a superset of existing data |
| `variable is not set` warnings only | **Noise** — Docker Compose build-arg warnings; not the cause | Ignore |
| App boots then crash-loops in **application** logs | **Deterministic — runtime/config** | Inspect `coolify app logs <APP_UUID>` |

For runtime (not build) failures, also check the live container logs:

```bash
coolify app logs <APP_UUID> --follow
```

### Step 5 — Act

- **Transient:** redeploy and report. `coolify deploy <APP_UUID> --force` (or
  `coolify app restart <APP_UUID>`). If the cause is repeated OOM from parallel builds,
  flag it as an infra recommendation (more build RAM, or serialize the per-app builds) —
  do NOT keep retrying blindly more than once or twice.
- **Deterministic:** report the exact error + file/line, fix via the normal dev loop
  (`/implement` for code, a new migration for schema), then re-ship. Do not redeploy
  without a fix.
- Always end by stating: the class, the evidence (1–2 log lines), and the concrete next step.

## Guardrails

- Read-only first. Only `deploy`/`restart`/`env` *mutations* after you've classified the
  failure and (for transient) confirmed a redeploy is the right call. Confirm with the user
  before changing env vars or forcing prod deploys.
- Never commit `llms.txt` / `llms-full.txt` (gitignored).
- Use UUIDs, not numeric IDs (except team commands). Prefer `--format json`.
- GitHub CI green ≠ Coolify deploy green. Always check Coolify directly.
