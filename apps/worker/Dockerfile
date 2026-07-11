FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/worker ./apps/worker
COPY tsconfig.base.json tsconfig.json ./
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @onelight/core build \
  && pnpm --filter @onelight/worker build \
  && pnpm --filter @onelight/worker-app build

FROM node:22-bookworm-slim
# mesa-vulkan-drivers supplies a software Vulkan implementation (lavapipe)
# so the libplacebo tonemap filter works without a GPU.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg mesa-vulkan-drivers poppler-utils libvips-tools ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 onelight \
  && mkdir -p /data \
  && chown onelight:onelight /data
WORKDIR /app
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages /app/packages
COPY --from=build /app/apps/worker/node_modules /app/apps/worker/node_modules
COPY --from=build /app/apps/worker/dist /app/apps/worker/dist
USER onelight
EXPOSE 8080
CMD ["node", "apps/worker/dist/index.js"]
