# ARGS: BUN_VERSION, BUILD_APP, BUILD_APP_PACKAGE, TURBO_VERSION, TURBO_TEAM, TURBO_API, DO_NOT_TRACK

ARG BUN_VERSION=1.3.11
FROM oven/bun:${BUN_VERSION}-alpine AS base

# -- stripe package.json version to avoid cache invalidation on only the app package.json changes
FROM nathapp/apline-jq:3.18 AS deps
ARG BUILD_APP=api

COPY package.json /tmp/
COPY apps/${BUILD_APP}/package.json /tmp/app-pkg.json

# Remove .version fields to avoid cache invalidation
RUN jq 'del(.version)' /tmp/package.json > /tmp/deps.json && \
    jq 'del(.version)' /tmp/app-pkg.json > /tmp/app-deps.json && \
    jq 'del(.version, .devDependencies)' /tmp/app-pkg.json > /tmp/app-runtime-deps.json


# Prune dependencies using Turbo
FROM base AS prune
WORKDIR /app
ARG TURBO_VERSION=2.8.17
ARG BUILD_APP=api
ARG BUILD_APP_PACKAGE=api
ENV DO_NOT_TRACK=1

RUN bun install -g turbo@$TURBO_VERSION

COPY turbo.json bun.lock ./ 
COPY --link apps/ ./apps/
COPY --link packages/ ./packages/
COPY --from=deps /tmp/deps.json ./package.json
COPY --from=deps /tmp/app-deps.json ./apps/${BUILD_APP}/package.json

# Run turbo prune for the selected app
RUN bunx turbo prune ${BUILD_APP_PACKAGE} --docker 


# Install dependencies
FROM base AS installer
WORKDIR /app

COPY --from=prune /app/out/json/ .

RUN --mount=type=cache,id=bun-install,target=/root/.bun/install/cache \
    bun install --frozen-lockfile


# Build app
FROM base AS builder
WORKDIR /app
ARG TURBO_TEAM
ARG TURBO_API
ARG NUXT_API_INTERNAL_URL=http://api:3100
ENV TURBO_TEAM=$TURBO_TEAM \
    TURBO_API=$TURBO_API \
    NUXT_API_INTERNAL_URL=$NUXT_API_INTERNAL_URL \
    DO_NOT_TRACK=1

COPY --from=installer /app .
COPY --from=prune /app/out/full .

RUN --mount=type=secret,id=TURBO_TOKEN \
    TURBO_TOKEN=$(cat /run/secrets/TURBO_TOKEN) \
    bun run db:generate && \
    bun run build && \
    prisma_client_dir=$(find /app/node_modules/.bun -type d -path '*/node_modules/.prisma/client' | head -n 1) && \
    test -n "$prisma_client_dir" && \
    mkdir -p /tmp/prisma-generated && \
    cp -R "$prisma_client_dir" /tmp/prisma-generated/client

# Final image
FROM base
WORKDIR /app/
ARG BUILD_APP=api

COPY --from=builder /app/bun.lock ./bun.lock
COPY --from=deps /tmp/app-runtime-deps.json ./apps/runtime/package.json

# Install only production dependencies for the runtime app package
RUN --mount=type=cache,id=bun-install,target=/root/.bun/install/cache \
    cd /app/apps/runtime && \
    bun install --frozen-lockfile --production && \
    rm -rf /app/node_modules/.bun/@lancedb+lancedb-linux-x64-gnu@* \
           /app/apps/runtime/node_modules/.bun/@lancedb+lancedb-linux-x64-gnu@* \
           /app/apps/runtime/node_modules/@lancedb/lancedb-linux-x64-gnu && \
    find /app/apps/runtime/node_modules -type f -name '*.map' -delete && \
    find /app/apps/runtime/node_modules -type d \
      \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name doc -o -name examples -o -name example \) \
      -prune -exec rm -rf '{}' + && \
    find /app/apps/runtime/node_modules/@prisma/client/runtime -type f \
      \( -name 'edge*' -o -name 'react-native*' -o -name 'index-browser*' -o -name 'wasm-*' -o -name 'query_*wasm-base64*' \) \
      -delete

COPY --from=builder /app/apps/${BUILD_APP}/dist ./apps/runtime/dist

# Prisma runtime assets for in-container migration commands:
# - /app/prisma/schema.prisma
# - /app/prisma/migrations/*
COPY --from=builder /app/apps/${BUILD_APP}/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=builder /app/apps/${BUILD_APP}/prisma/migrations ./prisma/migrations

# Copy only Prisma generated runtime artifacts instead of the full Bun package store.
RUN --mount=from=builder,source=/tmp/prisma-generated,target=/tmp/prisma-generated,ro \
    prisma_client_pkg_dir=$(find /app -type d -path '*/node_modules/@prisma/client' | head -n 1) && \
    test -n "$prisma_client_pkg_dir" && \
    prisma_node_modules_dir=$(dirname "$(dirname "$prisma_client_pkg_dir")") && \
    mkdir -p "$prisma_node_modules_dir/.prisma" && \
    rm -rf "$prisma_node_modules_dir/.prisma/client" && \
    cp -R /tmp/prisma-generated/client "$prisma_node_modules_dir/.prisma/client"

ENV ENV_NAME=production

# Replace root package.json with runtime one for version metadata
COPY ./apps/${BUILD_APP}/package.json ./package.json

# use bun run instead of bun dist/main to ensure package version is correctly picked up by the app
CMD ["bun", "run", "start:prod-runtime"]
