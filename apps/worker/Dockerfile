# trixie, not bookworm, and the reason is the GPU. bookworm ships
# intel-media-va-driver 23.1.1, which does not know the Alder Lake-N family
# (the N150's iGPU is 8086:46d4) and fails VA init outright:
#   "iHD_drv_video.so init failed / vaInitialize failed with error code -1".
# There is no backport -- bookworm-backports carries the same 23.1.1. trixie's
# 25.2.3 initialises on that part and exposes H.264 encode, so QuickSync needs
# the newer base. It also brings ffmpeg 7.1 in place of 5.1.
FROM node:22-trixie-slim AS build
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

# Both stages must share a base: native modules built against the build stage's
# glibc are copied wholesale into this one.
FROM node:22-trixie-slim
# mesa-vulkan-drivers supplies a software Vulkan implementation (lavapipe)
# and libvulkan1 is the loader that dlopens it; together they let the
# libplacebo tonemap filter run without a GPU. ffmpeg 7.1 can auto-create a
# Vulkan device, but the worker still passes -init_hw_device vulkan explicitly
# (see VULKAN_HWDEVICE_ARGS in packages/worker/src/media.ts) so the filter does
# not depend on which device ffmpeg would have picked. fonts-dejavu-core
# provides /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf, the default
# fontfile for the burned watermark drawtext recipe.
#
# intel-media-va-driver (iHD) plus libva are what h264_vaapi loads for Intel
# QuickSync. They are inert unless the container is given a render node AND
# ONELIGHT_VAAPI_DEVICE names it, so this image still runs anywhere -- it just
# encodes in software. vainfo is kept for diagnosing exactly that.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg mesa-vulkan-drivers libvulkan1 poppler-utils libvips-tools fonts-dejavu-core ca-certificates intel-media-va-driver libva2 libva-drm2 vainfo \
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
