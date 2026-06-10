---
name: diagnose
description: Diagnose a running Sideline issue — errors, bad behaviour, "why did X happen", or a failed Coolify deployment. Routes read-only investigation to the right source (SigNoz for logs/traces, the Coolify CLI for deploy state, Postgres for data) and includes the full Coolify deploy-failure root-cause procedure (classify transient infra vs real code/migration defect, recommend fix or redeploy). Use when the user says "look into", "check logs", "why did this happen", "deploy/preview failed", "why did Coolify fail", or asks to investigate live behaviour. READ-ONLY; to change deploy config use /update-deploy-config.
---

# Diagnose Skill

Investigate a live Sideline problem and route it to the correct **read-only** data source, or
root-cause a failed Coolify deployment. Combine sources to follow a request end-to-end.

> Changing anything (env vars, secrets, forced/prod redeploys) is **out of scope** — the Coolify CLI
> here is read-only. To change deploy config use **/update-deploy-config**.

## Environments

| Env | deployment.environment | Proxy URL | DB access |
|---|---|---|---|
| Preview | `preview` | `sideline-preview-<PR>.majksa.net` | direct via `bin/psql --pr <PR>` |
| Dev | `development` | `sideline.majksa.net` | none — ask the user to run SQL |
| Prod | `production` | `sideline.cz` | none — ask the user to run SQL |

Services emit OpenTelemetry as `service.name` = `sideline-server` / `sideline-bot` / `sideline-web` /
`sideline-proxy`, with resource attrs `deployment.environment` and `service.origin` (the FQDN).

---

## Part A — Pick a data source

### 1. Logs & traces → SigNoz MCP
Use the **signoz** MCP tools (don't scrape container logs via Coolify for this).

- `signoz_search_logs` — scope by env + service:
  - `query`: `service.name = 'sideline-server' AND deployment.environment = 'preview'`
  - `searchText`: a body substring (CONTAINS), e.g. `ImapPoller`, a team id, an error string.
  - `severity`: `ERROR` for error sweeps. `timeRange`: `30m` / `2h` / `24h`.
- `signoz_search_traces` / `signoz_get_trace_details` — follow one request across services via the
  `trace_id` on log rows.
- `signoz_list_services`, `signoz_get_field_keys`, `signoz_get_field_values` — discover names/values.
- Read `signoz://traces/query-builder-guide` before a `signoz_execute_builder_query`.

Example — did the IMAP poller ingest an email on preview?
```
signoz_search_logs(query="service.name='sideline-server' AND deployment.environment='preview'",
                   searchText="ImapPoller", timeRange="2h")
```

### 2. Deploy state → Coolify CLI (read-only)
Answer "is it deployed / healthy / which app is which / what env vars exist", not mutate.

- `coolify app list` — apps + UUIDs (two of each service: dev + prod; previews are per-PR compose apps).
  Map dev vs prod: `coolify app env get <uuid> APP_ENV --show-sensitive` (`development`/`production`)
  or `FRONTEND_URL` (`sideline.majksa.net` vs `sideline.cz`).
- `coolify app env list <uuid>` — which vars are set (masked unless `--show-sensitive`).
- `coolify app deployments list <uuid>` — deployment history/status.
- `coolify app logs <uuid>` — container boot/crash output (prefer SigNoz for app-level logs).

For a deployment that **failed to build / come up**, use **Part B** below.

### 3. Database
- **Preview** → the `bin/psql` wrapper:
  ```bash
  bin/psql --pr <PR> -c "SELECT ..."   # PR preview DB    (bin/psql -c "..." = main preview DB)
  ```
  Read-only intent: prefer `SELECT`, qualify columns, `LIMIT`. No destructive SQL on shared DBs without sign-off.
- **Dev & Prod** → **no direct access**. Write the exact read-only SQL, ask the user to run it and paste
  results, then continue. Never guess dev/prod row state — confirm via the user-run query.

---

## Part B — Diagnose a Coolify deployment failure

Sideline deploys **out-of-band via Coolify** (`coolify.majksa.net`) — there is **no GitHub Actions deploy
workflow**. A `majksa-deploy[bot]` PR comment links the build/app logs and reports 🟡 in-progress / 🔴 failed
/ 🟢 success. **GitHub "Check" CI green ≠ Coolify deploy green** — they're independent; always check Coolify.

### Prerequisites
- `coolify` CLI installed (`brew install coollabsio/coolify-cli/coolify-cli`), context `majksa.net`
  (`https://coolify.majksa.net`). Verify: `coolify context verify` (expect "Connection successful / Authentication valid").
  If it fails: `coolify context add -d majksa.net https://coolify.majksa.net <token>` (token from `/security/api-tokens`).
- Regenerate CLI docs anytime with `coolify docs llms` → `llms.txt`/`llms-full.txt` (both gitignored — never commit).

### Preview shape
One Coolify **application resource per PR** builds ALL services via a docker-compose buildpack: services
`server-pr-<PR>`, `bot-pr-<PR>`, `web-pr-<PR>`, `docs-pr-<PR>`; FQDN `sideline-preview-<PR>.majksa.net`. The
build runs each app's Dockerfile (`pnpm --recursive --parallel run codegen && pnpm build`) — **all apps build
in parallel**, memory-heavy and the usual cause of transient OOM kills.

### Step 1 — Find the deployment
Use a given UUID, or discover the app:
```bash
coolify app list --format json     # match name/fqdn containing pr-<PR> / sideline-preview-<PR>
gh api repos/maxa-ondrej/sideline/issues/<PR>/comments \
  --jq '.[] | select(.user.login=="majksa-deploy[bot]") | .body'   # embeds APP_UUID + DEPLOYMENT_UUID in log URLs
```

### Step 2 — Read deployment history
```bash
coolify app deployments list <APP_UUID> --format json > /tmp/deps.json
python3 - <<'PY'
import json
d=json.load(open('/tmp/deps.json')); items=d if isinstance(d,list) else d.get('deployments',d.get('data',[]))
for x in items[:12]:
    print(x.get('created_at'),'status=%s'%x.get('status'),
          'commit=%s'%str(x.get('commit_message') or x.get('commit'))[:40],
          'uuid=%s'%(x.get('deployment_uuid') or x.get('uuid')))
PY
```
**Critical first check:** is there a *later* deployment of the **same commit** that `finished`? If a retry of
the same SHA succeeded, the failure was almost certainly **transient** — say so and stop unless the user wants
the failed-build root cause anyway.

### Step 3 — Extract the failed build's error
```bash
python3 - <<'PY'
import json
d=json.load(open('/tmp/deps.json')); items=d if isinstance(d,list) else d.get('deployments',d.get('data',[]))
fail=next((x for x in items if x.get('status')=='failed'), None)
if not fail: print('no failed deployment found'); raise SystemExit
logs=fail['logs'];
if isinstance(logs,str): logs=json.loads(logs)
out="\n".join(e.get('output','') if isinstance(e,dict) else str(e) for e in logs)
open('/tmp/deploy_out.txt','w').write(out); print(out[-4000:])   # failure line is at the very end
PY
```
Decisive line: `Deployment failed: Command execution failed (exit code N): docker compose ... build`. Scan up
for the last running service step (`#NN [<svc>-pr-<PR> build 4/4] RUN ... pnpm build`) and whether earlier
services printed `DONE`.

### Step 4 — Classify
| Signature in the logs | Class | Action |
|---|---|---|
| `exit code 255` mid-`docker compose build`, some apps `DONE` then one killed with no compiler error; same commit later `finished` | **Transient — build-host OOM** (parallel multi-app builds) | Redeploy; no code change |
| `failed to solve` / `pull access denied` / network/registry timeout / TLS | **Transient — registry/network** | Redeploy |
| `error TS####` / `Type error` / biome / `astro build` / `vite` build error | **Deterministic — build/code** | Fix code, push |
| `relation/column ... does not exist`, constraint violation, migration SQL error in **application** logs | **Deterministic — migration/runtime** | Fix migration (must be a superset of existing data) |
| `variable is not set` warnings only | **Noise** — compose build-arg warnings | Ignore |
| App boots then crash-loops in **application** logs | **Deterministic — runtime/config** | `coolify app logs <APP_UUID>` |

For runtime (not build) failures also check live logs: `coolify app logs <APP_UUID> --follow`.

### Step 5 — Act
- **Transient:** redeploy + report — `coolify deploy <APP_UUID> --force` (or `coolify app restart <APP_UUID>`).
  Repeated OOM from parallel builds → flag as infra recommendation (more build RAM / serialize per-app builds);
  don't retry blindly more than once or twice.
- **Deterministic:** report exact error + file/line, fix via the normal dev loop (`/implement` for code, a new
  migration for schema), re-ship. Don't redeploy without a fix.
- Always end with: the class, the evidence (1–2 log lines), and the concrete next step.

## Guardrails
- Read-only first. Any `deploy`/`restart`/`env` mutation only after classifying, and (for transient) confirming
  redeploy is right; confirm with the user before changing env vars or forcing prod deploys.
- Never commit `llms.txt`/`llms-full.txt` (gitignored). Use UUIDs not numeric IDs. Prefer `--format json`.
- GitHub CI green ≠ Coolify deploy green — always check Coolify directly.
