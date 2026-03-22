FROM node:22-alpine AS base
RUN npm install -g bun turbo

# ── Prune: extract only what @nathapp/koda-web needs ─────────────────────────
FROM base AS pruner
WORKDIR /app
COPY . .
RUN turbo prune @nathapp/koda-web --docker

# ── Install dependencies (uses pruned lockfile for better caching) ────────────
FROM base AS deps
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN bun install --frozen-lockfile

# ── Build ─────────────────────────────────────────────────────────────────────
FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=pruner /app/out/full/ .
RUN turbo run build --filter=@nathapp/koda-web

# ── Runner ────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nuxt
COPY --from=build --chown=nuxt:nodejs /app/apps/web/.output ./.output
USER nuxt
EXPOSE 3101
CMD ["node", ".output/server/index.mjs"]
