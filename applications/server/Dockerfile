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
COPY tsconfig.* /app/
RUN pnpm --recursive --parallel run codegen && pnpm build

FROM base AS production
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
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
