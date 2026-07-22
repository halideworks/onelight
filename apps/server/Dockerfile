FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
# The dependency layer is keyed on the lockfile and nothing else. `pnpm fetch`
# exists for exactly this: it populates the store from the lockfile alone,
# without needing a single package.json, so no source file can invalidate it.
#
# The install used to sit AFTER the source copies, which meant every one-line
# change to a Svelte file reinstalled a 700 MB dependency tree and rebuilt
# better-sqlite3 from source before anything was compiled. That cost was paid
# on every verification loop.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm fetch
# Then the workspace manifests, and ONLY the manifests. Installing needs to
# know what each package depends on; it does not need a line of their source,
# and copying the source first is what tied a dependency install to every edit.
# Adding a package means adding a line here: `--frozen-lockfile` fails loudly
# on a workspace member it cannot find, so this list cannot rot in silence.
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/worker/package.json packages/worker/
COPY packages/api/package.json packages/api/
COPY packages/player/package.json packages/player/
COPY packages/web/package.json packages/web/
COPY apps/server/package.json apps/server/
COPY apps/worker/package.json apps/worker/
COPY apps/cf/package.json apps/cf/
# Offline: the store above already holds every tarball, so this only links and
# builds natives. --frozen-lockfile still holds, so a lockfile that disagrees
# with the manifests fails here rather than quietly resolving something new.
RUN pnpm install --frozen-lockfile --offline
# Source last, so a change to it invalidates the compile and nothing above it.
COPY packages ./packages
COPY apps ./apps
COPY tsconfig.base.json tsconfig.json eslint.config.js vitest.config.ts ./
# One composite build instead of six. Every package's build script is exactly
# `tsc -p tsconfig.json`, and the root tsconfig already references all of them
# in dependency order, so `tsc -b` does the same work in one process: it reads
# the shared type surface once rather than six times and orders the graph
# itself. Six separate pnpm+tsc startups cost more than the compiling did.
RUN pnpm exec tsc -b
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
