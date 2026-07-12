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
# and libvulkan1 is the loader that dlopens it; together they let the
# libplacebo tonemap filter run without a GPU. bookworm ffmpeg (5.1) cannot
# auto-create a Vulkan device (that landed in 6.1), so the worker passes
# -init_hw_device vulkan explicitly (see VULKAN_HWDEVICE_ARGS in
# packages/worker/src/media.ts). fonts-dejavu-core provides
# /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf, the default fontfile for
# the burned watermark drawtext recipe.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg mesa-vulkan-drivers libvulkan1 poppler-utils libvips-tools fonts-dejavu-core ca-certificates \
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
