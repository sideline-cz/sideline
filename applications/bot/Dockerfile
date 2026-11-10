FROM node:25-slim AS base
RUN npm install -g pnpm@10.28.0
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches/ patches/
COPY --parents packages/*/package.json /app/
COPY applications/bot/package.json applications/bot/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages/ /app/packages/
COPY applications/bot/ applications/bot/
COPY tsconfig.* /app/
RUN pnpm --recursive --parallel run codegen && pnpm build

# Renders the 218 rules-quiz clips (109 scenarios × setup/resolution) that the
# bot attaches to quiz posts. ~2 min, ~67 MiB.
#
# The renderer lives in the web app because it drives `RulesFieldSvg` — the
# SAME component the web trainer renders, which is what stops the GIFs and the
# live trainer from drifting. So this stage installs the WEB dependency tree
# (resvg-js, gifenc, react-dom/server), not the bot's, and none of it reaches
# the production stage: only the finished `.gif` files are copied out.
#
# Rendering here rather than in a separate workflow costs ~2 min per bot build,
# and buys the property that matters: the clips and the scenario content come
# out of one commit, so a Czech content fix can never ship with GIFs still
# showing the old text. There is no artefact store to version and no skew to
# reconcile.
FROM base AS gifs
# resvg silently DROPS text it has no font for, so a missing font here would
# yield 218 plausible-looking clips with no actor labels and no call-outs.
# `render-rules-gifs.ts` hard-fails instead, and this is the package its
# Debian candidate path points at.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches/ patches/
COPY --parents packages/*/package.json /app/
COPY applications/web/package.json applications/web/
RUN pnpm install --frozen-lockfile
COPY packages/ /app/packages/
COPY applications/web/ applications/web/
COPY tsconfig.* /app/
RUN pnpm --recursive --parallel run codegen
# `build:packages`, not the full `build`: the renderer runs the web app's TSX
# straight through tsx, so the web bundle is never needed — but the workspace
# packages it imports (`@sideline/rules` for the content and the animator,
# `@sideline/i18n` for the compiled messages `RulesFieldSvg` renders labels
# with) are consumed from `dist/` and must be built first.
RUN pnpm build:packages
# The renderer batches itself across child processes because resvg-js leaks
# native memory on Linux — a single-process render of all 109 climbs past
# 11 GiB and gets OOM-killed here. See the long comment in
# `render-rules-gifs.ts` for what was measured and what was ruled out.
# Batched: ~2 min, peak ~2.5 GiB.
RUN pnpm --filter @sideline/web render:gifs -- --out /app/rules-gifs

FROM base AS production
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ARG VERSION=dev
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=
ENV APP_VERSION=$VERSION GIT_COMMIT=$GIT_COMMIT BUILD_TIME=$BUILD_TIME
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches/ patches/
COPY --from=build --parents /app/packages/*/package.json /app/packages/*/dist /
COPY applications/bot/package.json applications/bot/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=build /app/applications/bot/build/esm applications/bot/build
COPY --from=gifs /app/rules-gifs /app/rules-gifs
ENV RULES_GIF_DIR=/app/rules-gifs
COPY applications/bot/docker-entrypoint.sh /app/applications/bot/docker-entrypoint.sh
RUN chmod +x /app/applications/bot/docker-entrypoint.sh

EXPOSE 9000

CMD ["/app/applications/bot/docker-entrypoint.sh"]
