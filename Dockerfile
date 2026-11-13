# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Jukebox container: builds the React/Vite web app, then runs the Express
# server that serves it. Bun 1.4+ is required (see AGENTS.md).
#
# The Spotify login tokens live in server/tokens.json and the queue in
# server/queue.json; both are excluded from the image (see .dockerignore) and
# mounted at run time so secrets never bake into a layer.
#
# This image runs the server only. The Cloudflare Quick Tunnel is started by
# `bun start` (start.js); in Docker run cloudflared as a sidecar pointed at
# this container (see the README/notes) or expose port 3000 yourself.
# ---------------------------------------------------------------------------

# ---------- build stage: install web deps and build the SPA ----------
FROM oven/bun:1.4-alpine AS build
WORKDIR /app

# Manifests first: this layer only re-runs when dependencies change.
COPY web/package.json web/bun.lock ./web/
RUN cd web && bun install --frozen-lockfile

# Vite + tsc build -> web/dist (Express serves this directory).
COPY web/ ./web/
RUN cd web && bun run build

# ---------- runtime stage: server + built SPA ----------
FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

# Server runtime deps only (express, ws).
COPY server/package.json server/bun.lock ./server/
RUN cd server && bun install --frozen-lockfile --production

# Server source (node_modules/dist/env are excluded via .dockerignore).
COPY server/ ./server/

# Built front end from the build stage.
COPY --from=build /app/web/dist ./web/dist

# The server listens on 0.0.0.0:PORT (default 3000).
EXPOSE 3000

# server.js reads all config from the environment (SPOTIFY_CLIENT_ID,
# ADMIN_PIN, ...), so run it directly instead of the repo's --env-file wrapper.
# Override with `docker run -e ...` or a compose `environment:`/`env_file:`.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["bun", "server/server.js"]
