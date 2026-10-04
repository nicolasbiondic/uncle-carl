# syntax=docker/dockerfile:1
#
# Uncle Carl Trading Bot — single-stage image, no build step (Bun runs .ts
# directly). Bun version pinned to this repo's dev version (`bun --version`)
# — bump both together when the repo's Bun version changes.
FROM oven/bun:1.4.2-slim

WORKDIR /app

# Install dependencies first so this layer caches across source-only edits.
# --production skips devDependencies (type stubs only; not needed at runtime).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

# oven/bun ships a non-root `bun` user (uid/gid 1000) — run as that, not root.
# /app/data is where the SQLite DB, backups, and cached historical bars live;
# mount it as a named volume / bind mount so it survives container recreation.
RUN mkdir -p /app/data /app/logs && chown -R bun:bun /app
USER bun

VOLUME ["/app/data"]

ENV NODE_ENV=production
# Inside the container the app must listen on every interface for the port
# mapping to work; docker-compose.yml restricts the published port to the
# host's loopback. Env beats instance.json, so a setup run inside the
# container (which writes 127.0.0.1 for new installs) cannot lock it out.
ENV DASHBOARD_HOST=0.0.0.0
EXPOSE 3789

# /healthz is public and unauthenticated by design (liveness only) — see
# AGENTS.md "Auth & WebSocket". Reads DASHBOARD_PORT so a custom port still
# health-checks correctly.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.DASHBOARD_PORT || 3789) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "src/index.ts"]
