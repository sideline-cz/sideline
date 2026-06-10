---
name: update-deploy-config
description: Change Sideline deploy configuration — environment variables, secrets, image tags, domains, healthchecks — for dev or prod. All changes go through the majksa-ops GitOps repo (SOPS-encrypted secrets, rendered to env/* branches, applied to Coolify by CI), NOT the read-only Coolify CLI. Use when the user asks to set/rotate an env var or secret, add a deploy config value, or change deployment settings for dev/prod.
---

# Update Deploy Config Skill

Sideline's deploy config is **GitOps-managed** in the `majksa-ops` repo at
`/Users/ondrej.maxa/Projects/majksa-ops`. The Coolify CLI is read-only — you do **not** set env vars
or secrets through it. You edit config on `main`, push, and let CI render → open env PRs → sync to
Coolify and redeploy.

Read `majksa-ops/AGENTS.md` (conventions) and `majksa-ops/RUNBOOK.md` (procedures) before non-trivial
changes. This skill is the quick path for the common case: changing an env var or secret.

## Where things live (per service)

```
config/sideline/<service>/                 # service ∈ { server, bot, web, proxy, docs }
├── service.yml            # base: image, ports, NON-secret `environment:`, healthcheck, volumes
├── service.dev.yml        # dev overrides: tag, domains, per-env NON-secret `environment:`
├── service.prod.yml       # prod overrides
├── secrets.dev.enc.yaml   # SOPS+age encrypted SECRETS for dev
└── secrets.prod.enc.yaml  # SOPS+age encrypted SECRETS for prod
```

Decide where a value goes:
- **Non-sensitive** (URLs, flags, model names) → `environment:` in `service.yml` (all envs) or
  `service.<env>.yml` (one env).
- **Sensitive** (keys, passwords, tokens) → `secrets.<env>.enc.yaml`.

Both end up in the same Coolify env-var bag at deploy time. `env` ∈ `dev` (→ `sideline.majksa.net`) /
`prod` (→ `sideline.cz`).

## Editing a secret (SOPS + age)

The age private key is at `majksa-ops/.age-key` (gitignored). Always pass it explicitly:

```bash
cd /Users/ondrej.maxa/Projects/majksa-ops
SOPS_AGE_KEY_FILE=.age-key sops edit config/sideline/<service>/secrets.<env>.enc.yaml
```

`sops edit` decrypts to a temp buffer and re-encrypts in place on save — only the `.enc.yaml` is
committed. (Plaintext `secrets.*.yaml` working copies are gitignored; the canonical edit is `sops edit`
of the `.enc.yaml`.) Never commit plaintext secrets, never print secret values into logs/PRs.

## The flow (what happens after you commit to `main`)

1. **Edit on `main`** — change `service*.yml` (non-secret) or `sops edit` the `secrets.<env>.enc.yaml`.
2. **Commit + push to `main`** (config source of truth). This triggers `sync_config`.
3. **`sync_config`** renders config and opens a **PR to `env/<env>`** per app. Review/merge it.
4. **Merging the env PR** triggers **`rollout`** (`sync_service` → `sync_secrets` → `sync_deploy`):
   secrets/env are pushed to the Coolify Application and changed services are redeployed (rolling).

Do **not** edit `env/*` branches directly — they are rendered output.

## Worked example — add `EMAIL_IMAP_ENCRYPTION_KEY` (a secret) to the server, dev + prod

```bash
cd /Users/ondrej.maxa/Projects/majksa-ops
# generate a DISTINCT key per environment (base64, 32 bytes)
SOPS_AGE_KEY_FILE=.age-key sops edit config/sideline/server/secrets.dev.enc.yaml
#   add:  EMAIL_IMAP_ENCRYPTION_KEY: "<openssl rand -base64 32>"
SOPS_AGE_KEY_FILE=.age-key sops edit config/sideline/server/secrets.prod.enc.yaml
#   add:  EMAIL_IMAP_ENCRYPTION_KEY: "<a DIFFERENT openssl rand -base64 32>"
git checkout -b chore/add-imap-key
git add config/sideline/server/secrets.dev.enc.yaml config/sideline/server/secrets.prod.enc.yaml
git commit -m "feat(sideline): add EMAIL_IMAP_ENCRYPTION_KEY for server (dev+prod)"
git push -u origin chore/add-imap-key   # open PR to main; merge → sync_config → env PRs → rollout
```

Guidance for this kind of key:
- Use a **different** key per environment; never reuse a preview key in prod.
- A key is **stable once data is encrypted with it** — rotating it later orphans existing encrypted
  secrets (teams must re-enter passwords). Set once per env and leave it.

## Safety

- Prod is real: prefer a PR + the user's review over committing straight to `main`, and confirm the
  target env. Coolify redeploys the affected service when the env PR merges.
- Verify after rollout with **/investigate** (Coolify CLI `app env list` to confirm the var exists;
  SigNoz to confirm the service came back healthy).
