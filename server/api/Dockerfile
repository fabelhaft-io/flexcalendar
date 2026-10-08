# --- calendar-flex API service: local development image (E02-R03) ------------
#
# `make dev` builds this; production images are built in CI, pinned by digest
# and owned by E08.
#
# The service body is the skeleton in src/ until E05-R01. The image only has to
# boot and answer, so it is a production install of this workspace package and
# nothing else — the workspace lockfile stays the single source of resolved
# versions, which is why the build context is the repository root.
#
#   dockerfile: server/api/Dockerfile
#   context:    ../..   (the repository root, see infra/dev/compose.yaml)

FROM node:24-alpine AS dependencies
WORKDIR /repo
# The workspace root, so `pnpm install` can read the lockfile and the workspace
# globs, plus this package's manifest.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/api/package.json server/api/
RUN corepack pnpm install --frozen-lockfile --prod --filter @calendar-flex/api

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /repo
# pnpm keeps the real packages in the root virtual store and links them from the
# package that depends on them, so both directories have to be copied.
COPY --from=dependencies /repo/node_modules ./node_modules
COPY --from=dependencies /repo/server/api/node_modules ./server/api/node_modules
COPY --from=dependencies /repo/server/api/package.json ./server/api/package.json
COPY server/api/src ./server/api/src
COPY server/api/migrations ./server/api/migrations
COPY server/api/sabredav ./server/api/sabredav
USER node
EXPOSE 3000
# The readiness probe lives in infra/dev/compose.yaml, where the rest of the
# stack's healthchecks are.
CMD ["node", "server/api/src/server.mjs"]
