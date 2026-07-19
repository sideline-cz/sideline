#!/bin/sh
# MajNet deployment entrypoint for the server. Two adaptations to how MajNet
# delivers configuration; both are no-ops under docker-compose.
set -eu

# 1. Secrets. MajNet delivers SOPS secrets as read-only tmpfs FILES at
#    /run/secrets/<KEY> (never env vars, §14). The app reads them from
#    process.env (env.ts), so load each file into the environment. Only fills a
#    var that is unset, so compose (which sets secrets via env) is unaffected.
if [ -d /run/secrets ]; then
  for f in /run/secrets/*; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    eval "cur=\${$name-__majnet_unset__}"
    [ "$cur" = "__majnet_unset__" ] && export "$name=$(cat "$f")"
  done
fi

# 2. Managed Postgres. MajNet provisions the DB + role and injects
#    PGHOST/PGDATABASE/PGUSER/PGPASSWORD (§15/ADR 0014); map them to the
#    DATABASE_* vars env.ts reads. DATABASE_MAIN defaults to the app's own DB so
#    run.ts skips its self-CREATE DATABASE (the role can't touch the postgres
#    maintenance DB, and the DB already exists). Each only fills an unset var.
: "${DATABASE_HOST:=${PGHOST:-}}"
: "${DATABASE_PORT:=5432}"
: "${DATABASE_NAME:=${PGDATABASE:-}}"
: "${DATABASE_USER:=${PGUSER:-}}"
: "${DATABASE_PASS:=${PGPASSWORD:-}}"
: "${DATABASE_MAIN:=${DATABASE_NAME}}"
export DATABASE_HOST DATABASE_PORT DATABASE_NAME DATABASE_USER DATABASE_PASS DATABASE_MAIN

exec node applications/server/build/run.js
