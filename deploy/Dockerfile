# Single-process container for the Discord GM bot.
# Build from the repository root:
#   docker build -f deploy/Dockerfile -t rpg-bot .
# Run exactly one container per data volume (the bot keeps a single-instance lock in /app/data).

# ---------------------------------------------------------------- build
FROM node:24-bookworm-slim AS build
WORKDIR /app
# Toolchain only in case better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---------------------------------------------------------------- runtime
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/app/data
WORKDIR /app
COPY --from=build --chown=root:root /app/package.json /app/package-lock.json ./
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
# Read at runtime: SQL migrations and the GM prompt (src/prompts/gm.md).
COPY --chown=root:root migrations ./migrations
COPY --chown=root:root src/prompts ./src/prompts
COPY --chown=root:root sample-campaign ./sample-campaign
# Application code stays root-owned and read-only to the bot; only the data dir is writable.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
# Doctor/backup/restore inside the container use the compiled scripts, e.g.:
#   docker compose exec bot node dist/scripts/backup.js
#   docker compose run --rm bot node dist/scripts/doctor.js
# SIGTERM triggers a clean shutdown; give it time (compose stop_grace_period / docker stop -t 60).
STOPSIGNAL SIGTERM
CMD ["node", "dist/src/index.js"]
