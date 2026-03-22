FROM node:22-alpine AS base
RUN npm install -g bun

FROM base AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/
RUN bun install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build --filter=@nathapp/koda-web

FROM node:22-alpine AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nuxt
COPY --from=build --chown=nuxt:nodejs /app/apps/web/.output ./.output
USER nuxt
EXPOSE 3101
CMD ["node", ".output/server/index.mjs"]
