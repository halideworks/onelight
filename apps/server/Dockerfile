FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages
COPY apps ./apps
COPY tsconfig.base.json tsconfig.json eslint.config.js vitest.config.ts ./
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @onelight/core build \
  && pnpm --filter @onelight/db build \
  && pnpm --filter @onelight/worker build \
  && pnpm --filter @onelight/api build \
  && pnpm --filter @onelight/server build
RUN pnpm --filter @onelight/web build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Same non-root uid as the worker image so both containers agree on the
# ownership of the shared /data volume.
RUN corepack enable \
  && useradd --create-home --uid 10001 onelight \
  && mkdir -p /data \
  && chown onelight:onelight /data
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages /app/packages
COPY --from=build /app/apps/server/node_modules /app/apps/server/node_modules
COPY --from=build /app/apps/server/dist /app/apps/server/dist
USER onelight
VOLUME /data
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
