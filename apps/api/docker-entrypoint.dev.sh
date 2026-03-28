#!/bin/sh
set -eu

APP_USER="${APP_USER:-bun}"

mkdir -p /app/node_modules /app/apps/api/node_modules /app/apps/api/dist /data /home/bun/.bun/install/cache
chown -R "$APP_USER:$APP_USER" /app/node_modules /app/apps/api/node_modules /app/apps/api/dist /data /home/bun

exec su-exec "$APP_USER" "$@"
