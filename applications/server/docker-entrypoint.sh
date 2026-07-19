#!/bin/sh
# Map a MajNet-injected managed-Postgres connection to the DATABASE_* vars the
# server reads (env.ts). MajNet provisions the database + role itself and injects
# PGHOST/PGDATABASE/PGUSER/PGPASSWORD (§15, ADR 0014); it does NOT set the
# discrete DATABASE_* names this app uses, nor a maintenance-DB name.
#
# Each assignment only fills a var that is unset, so this is a no-op under
# docker-compose (which sets DATABASE_* directly) and only maps under MajNet.
#
# DATABASE_MAIN defaults to the app's own DB name so `DATABASE_MAIN !==
# DATABASE_NAME` is false and run.ts skips its `CREATE DATABASE` — the managed
# role has no access to the `postgres` maintenance DB and the DB already exists.
set -eu

: "${DATABASE_HOST:=${PGHOST:-}}"
: "${DATABASE_PORT:=5432}"
: "${DATABASE_NAME:=${PGDATABASE:-}}"
: "${DATABASE_USER:=${PGUSER:-}}"
: "${DATABASE_PASS:=${PGPASSWORD:-}}"
: "${DATABASE_MAIN:=${DATABASE_NAME}}"

export DATABASE_HOST DATABASE_PORT DATABASE_NAME DATABASE_USER DATABASE_PASS DATABASE_MAIN

exec node applications/server/build/run.js
