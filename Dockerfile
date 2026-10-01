# syntax=docker/dockerfile:1

# ── dependencies ─────────────────────────────────────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /app
RUN npm install -g pnpm@11.11.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ── build ────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@11.11.0
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
COPY src ./src
# Compile, then drop dev dependencies so the runtime layer stays small.
RUN pnpm build && pnpm prune --prod

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S assistant && adduser -S assistant -G assistant

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

USER assistant

# Offline: validates config only, no Telegram and no network.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "dist/index.js", "--healthcheck"]

CMD ["node", "dist/index.js"]
