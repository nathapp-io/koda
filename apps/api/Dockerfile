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
    jq 'del(.version)' /tmp/app-pkg.json > /tmp/app-deps.json


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
ENV TURBO_TEAM=$TURBO_TEAM \
    TURBO_API=$TURBO_API \
    DO_NOT_TRACK=1

COPY --from=installer /app .
COPY --from=prune /app/out/full .

RUN --mount=type=secret,id=TURBO_TOKEN \
    TURBO_TOKEN=$(cat /run/secrets/TURBO_TOKEN) \
    bun run db:generate && \
    bun run build

# Final image
FROM base
WORKDIR /app/
ARG BUILD_APP=api

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/apps/${BUILD_APP}/package.json ./apps/${BUILD_APP}/package.json
COPY --from=builder /app/bun.lock ./bun.lock
COPY --from=prune /app/out/json/packages ./packages

# Install only production dependencies
RUN --mount=type=cache,id=bun-install,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production && \
    mv /app/apps/${BUILD_APP} ./apps/runtime

COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/${BUILD_APP}/dist ./apps/runtime/dist

ENV ENV_NAME=production

# Replace root package.json with runtime one for version metadata
COPY ./apps/${BUILD_APP}/package.json ./package.json

# use bun run instead of bun dist/main to ensure package version is correctly picked up by the app
CMD ["bun", "run", "start:prod-runtime"]