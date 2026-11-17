# syntax=docker/dockerfile:1.7

# Jarvis Meeting — control plane image.
#
# Lightweight Hono service: no model binaries, no SQLite index.
# Build context root is this repo's root: `docker build -t jarvis-meeting .`
#
# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: build TypeScript
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /build

COPY package.json ./package.json
COPY package-lock.json* ./
COPY tsconfig.json ./tsconfig.json

RUN npm install --no-audit --no-fund

COPY src ./src
COPY web ./web
COPY scripts ./scripts

# Compiles the service (dist/) AND bundles the browser agent-frame page into
# public/agent-frame.js (npm run build chains build:web).
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: runtime
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./package.json
COPY package-lock.json* ./

RUN npm install --omit=dev --no-audit --no-fund

COPY --from=build /build/dist ./dist
# The agent-frame and panel routes read these from disk at runtime (page HTML + bundle).
# createPanelRoutes reads web/panel/index.html at startup, so the container exits without it.
COPY --from=build /build/public ./public
COPY web/agent-frame/index.html ./web/agent-frame/index.html
COPY web/panel/index.html ./web/panel/index.html
# createArtifactRoutes and createMeetingPageRoutes also read their page HTML at startup.
COPY web/artifact/index.html ./web/artifact/index.html
COPY web/meeting-page/index.html ./web/meeting-page/index.html
# SOUL_DIR defaults to ${cwd}/soul (src/config.ts) — bake the committed souls
# in; override with SOUL_DIR + a mounted volume to manage souls without rebuilds.
# Only soul/example.md and soul/README.md reach the build context (.dockerignore):
# real teammate SOULs (soul/david.md) are personal, gitignored, and mounted at runtime.
COPY soul ./soul

# Transcript JSONL land here at runtime (mounted volume in production)
RUN mkdir -p /app/.data && chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=8080

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "--enable-source-maps", "dist/index.js"]
