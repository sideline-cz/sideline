#!/bin/sh
# MajNet deployment entrypoint for the bot. MajNet delivers SOPS secrets as
# read-only tmpfs FILES at /run/secrets/<KEY> (never env vars, §14); the app
# reads them from process.env (env.ts), so load each file into the environment
# (here: DISCORD_BOT_TOKEN). Only fills unset vars, so this is a no-op under
# docker-compose (which sets secrets via env).
set -eu

if [ -d /run/secrets ]; then
  for f in /run/secrets/*; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    eval "cur=\${$name-__majnet_unset__}"
    [ "$cur" = "__majnet_unset__" ] && export "$name=$(cat "$f")"
  done
fi

exec node applications/bot/build/run.js
