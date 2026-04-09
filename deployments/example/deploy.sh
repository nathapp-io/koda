#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker is required"
  exit 1
fi

echo "==> Pull latest images"
docker compose -f "$COMPOSE_FILE" pull

echo "==> Run DB migrations"
docker compose -f "$COMPOSE_FILE" run --rm migrate

echo "==> Start services"
docker compose -f "$COMPOSE_FILE" up -d api web

echo "==> Status"
docker compose -f "$COMPOSE_FILE" ps

echo "✅ Deploy complete"
