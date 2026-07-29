FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependencies
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS builder
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -- --webpack
RUN npm prune --omit=dev

FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runner
WORKDIR /app
ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  PORT=3001 \
  HOSTNAME=0.0.0.0 \
  DJMIMA_DATABASE_PATH=/app/data/djmima.sqlite \
  DJMIMA_BACKUP_DIR=/app/data/backups
RUN groupadd --system --gid 1001 djmima \
  && useradd --system --uid 1001 --gid djmima --create-home djmima \
  && mkdir -p /app/data/backups \
  && chown -R djmima:djmima /app/data
COPY --from=builder --chown=djmima:djmima /app/package.json ./package.json
COPY --from=builder --chown=djmima:djmima /app/node_modules ./node_modules
COPY --from=builder --chown=djmima:djmima /app/public ./public
COPY --from=builder --chown=djmima:djmima /app/.next ./.next
COPY --from=builder --chown=djmima:djmima /app/scripts/selfhost-backup.mjs ./scripts/selfhost-backup.mjs
USER djmima
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:3001/api/health?mode=live').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "node_modules/next/dist/bin/next", "start"]
