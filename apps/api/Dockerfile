# ARGS: BUN_VERSION, BUILD_APP, BUILD_APP_PACKAGE, TURBO_VERSION, TURBO_TEAM, TURBO_API, DO_NOT_TRACK

ARG BUN_VERSION=1.4.4
FROM oven/bun:${BUN_VERSION}-alpine AS base

# -- stripe package.json version to avoid cache invalidation on only the app package.json changes
FROM nathapp/apline-jq:3.18 AS deps
ARG BUILD_APP=api

COPY package.json /tmp/
COPY apps/${BUILD_APP}/package.json /tmp/app-pkg.json

# Remove .version fields to avoid cache invalidation
RUN jq 'del(.version)' /tmp/package.json > /tmp/deps.json && \
    jq 'del(.version)' /tmp/app-pkg.json > /tmp/app-deps.json


# Prune dependencies using Turbo
FROM base AS prune
WORKDIR /app
ARG TURBO_VERSION=2.11.4
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
    bun run build

# Production dependencies, installed from the pruned workspace manifests AND its lockfile,
# so the image ships exactly the versions (and root `overrides`) CI tested. A standalone
# install of a package that is not in the lock resolves ranges fresh and once shipped a
# second @nathapp/nestjs-tenant copy that broke Nest DI at boot (#437).
# Keep bun's default isolated layout, as in CI. A hoisted install of the same lock nests
# @nestjs/core 11 under @nestjs/throttler, whose peer range stops at ^11. The store is
# /app/node_modules/.bun; the app's links live in apps/<app>/node_modules, renamed to
# apps/runtime (same depth, so the relative links hold).
# devDependencies are deleted from the manifests and the lock is re-saved (--lockfile-only
# drops their entries and keeps every other resolution) before the frozen install:
# `--production` alone still installs a devDependency that a production package lists as
# an optional peer (@prisma/client -> prisma CLI + typescript, ~230 MB).
FROM base AS runtime-deps
WORKDIR /app
ARG BUILD_APP=api

COPY --from=prune /app/out/json/ .
COPY --from=builder /app/apps/${BUILD_APP}/scripts/check-runtime-deps.ts /tmp/check-runtime-deps.ts

RUN --mount=type=cache,id=bun-install,target=/root/.bun/install/cache \
    for f in package.json apps/*/package.json packages/*/package.json; do \
      [ -f "$f" ] || continue; \
      bun -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('$f','utf8'));delete p.devDependencies;fs.writeFileSync('$f',JSON.stringify(p,null,2))"; \
    done && \
    bun install --lockfile-only && \
    bun install --frozen-lockfile --production && \
    bun /tmp/check-runtime-deps.ts /app/node_modules && \
    mv apps/${BUILD_APP} apps/runtime && \
    rm -rf node_modules/.bun/@lancedb+lancedb-linux-*-gnu@* && \
    find node_modules -type f -name '*.map' -delete && \
    find node_modules -type f -path '*/@prisma/client/runtime/*' \
      \( -name 'edge*' -o -name 'react-native*' -o -name 'index-browser*' -o -name '*.mjs' \
         -o \( -name 'query_compiler_*' ! -name 'query_compiler_fast_bg.postgresql*' \) \) \
      -delete

# Final image
FROM base
WORKDIR /app/
ARG BUILD_APP=api

COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=runtime-deps /app/apps/runtime/node_modules ./apps/runtime/node_modules
COPY --from=builder /app/apps/${BUILD_APP}/dist ./apps/runtime/dist

# Prisma runtime assets for in-container migration commands:
# - /app/prisma.config.ts (schema path, migrations path, DATABASE_URL)
# - /app/prisma/schema.prisma
# - /app/prisma/migrations/*
COPY --from=builder /app/apps/${BUILD_APP}/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/apps/${BUILD_APP}/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=builder /app/apps/${BUILD_APP}/prisma/migrations ./prisma/migrations

ENV ENV_NAME=production

# Replace root package.json with runtime one for version metadata
COPY ./apps/${BUILD_APP}/package.json ./package.json

HEALTHCHECK --interval=30s --timeout=3s --retries=3 --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3100/api/health || exit 1

# Run as an unprivileged user (review E/SEC-4), like the web image. The code under /app stays root-owned and
# read-only to the process. Only the data directories are writable: /data (the compose volume: LanceDB and
# fleet artifacts), plus /app/data and /app/lancedb (the FLEET_ARTIFACT_DIR and LANCEDB_PATH defaults when they
# are unset). A volume created by an older root image keeps root-owned files: chown it once to 1001:1001
# (deployments/example/deploy.sh does this on every deploy).
RUN addgroup --system --gid 1001 koda && \
    adduser --system --uid 1001 --ingroup koda koda && \
    mkdir -p /data /app/data /app/lancedb && \
    chown koda:koda /data /app/data /app/lancedb

USER koda

# use bun run instead of bun dist/main to ensure package version is correctly picked up by the app
CMD ["bun", "run", "start:prod-runtime"]
