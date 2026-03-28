#!/bin/sh
set -eu

APP_USER="${APP_USER:-bun}"

mkdir -p /app/node_modules /app/apps/web/node_modules /app/apps/web/.nuxt /home/bun/.bun/install/cache
chown -R "$APP_USER:$APP_USER" /app/node_modules /app/apps/web/node_modules /app/apps/web/.nuxt /home/bun

exec su-exec "$APP_USER" "$@"
