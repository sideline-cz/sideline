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

FROM base AS production
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches/ patches/
COPY --from=build --parents /app/packages/*/package.json /app/packages/*/dist /
COPY applications/bot/package.json applications/bot/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=build /app/applications/bot/build/esm applications/bot/build
COPY applications/bot/docker-entrypoint.sh /app/applications/bot/docker-entrypoint.sh
RUN chmod +x /app/applications/bot/docker-entrypoint.sh

EXPOSE 9000

CMD ["/app/applications/bot/docker-entrypoint.sh"]
