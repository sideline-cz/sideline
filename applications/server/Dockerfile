FROM node:25-slim AS base
RUN npm install -g pnpm@10.28.0
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches/ patches/
COPY --parents packages/*/package.json /app/
COPY applications/server/package.json applications/server/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages/ /app/packages/
COPY applications/server/ applications/server/
# `scripts/build-docs-index.mjs` (the server's `codegen` step) reads the end-user docs to
# build the assistant's `search_docs` index. Content only — the docs app itself is a
# separate image and is not built here.
COPY applications/docs/src/content applications/docs/src/content
COPY tsconfig.* /app/
RUN pnpm --recursive --parallel run codegen && pnpm build

FROM base AS production
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
ARG VERSION=dev
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=
ENV APP_VERSION=$VERSION GIT_COMMIT=$GIT_COMMIT BUILD_TIME=$BUILD_TIME
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches/ patches/
COPY --from=build --parents /app/packages/*/package.json /app/packages/*/dist /
COPY applications/server/package.json applications/server/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=build /app/applications/server/build/esm applications/server/build
COPY applications/server/docker-entrypoint.sh /app/applications/server/docker-entrypoint.sh
RUN chmod +x /app/applications/server/docker-entrypoint.sh

EXPOSE 80
EXPOSE 9000

CMD ["/app/applications/server/docker-entrypoint.sh"]
