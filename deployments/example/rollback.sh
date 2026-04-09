#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
ENV_FILE="$SCRIPT_DIR/.env"
TARGET_VERSION="${1:-}"
RESTORE_DB_FILE=""

usage() {
  cat <<'EOF'
Usage:
  ./rollback.sh <version> [--restore-db <backup-tar-gz>]

Examples:
  ./rollback.sh v0.3.0
  ./rollback.sh v0.3.0 --restore-db ./backups/koda_data-20260409-180000.tar.gz
EOF
}

if [[ -z "$TARGET_VERSION" ]]; then
  usage
  exit 1
fi

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --restore-db)
      RESTORE_DB_FILE="${2:-}"
      if [[ -z "$RESTORE_DB_FILE" ]]; then
        echo "❌ --restore-db requires a file path"
        exit 1
      fi
      shift 2
      ;;
    *)
      echo "❌ Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker is required"
  exit 1
fi

echo "==> Stopping app services"
docker compose -f "$COMPOSE_FILE" stop api web || true

if [[ -n "$RESTORE_DB_FILE" ]]; then
  if [[ ! -f "$RESTORE_DB_FILE" ]]; then
    echo "❌ Backup file not found: $RESTORE_DB_FILE"
    exit 1
  fi

  echo "==> Restoring DB volume from: $RESTORE_DB_FILE"
  docker run --rm \
    -v koda-local_koda_data:/target \
    -v "$(cd "$(dirname "$RESTORE_DB_FILE")" && pwd):/backup:ro" \
    alpine:3.20 \
    sh -lc "rm -rf /target/* && tar -xzf /backup/$(basename "$RESTORE_DB_FILE") -C /target"
fi

if [[ -f "$ENV_FILE" ]]; then
  if grep -q '^KODA_VERSION=' "$ENV_FILE"; then
    sed -i "s/^KODA_VERSION=.*/KODA_VERSION=$TARGET_VERSION/" "$ENV_FILE"
  else
    echo "KODA_VERSION=$TARGET_VERSION" >> "$ENV_FILE"
  fi
else
  echo "KODA_VERSION=$TARGET_VERSION" > "$ENV_FILE"
fi

echo "==> Pull target images"
docker compose -f "$COMPOSE_FILE" pull api web

echo "==> Starting app services on KODA_VERSION=$TARGET_VERSION"
docker compose -f "$COMPOSE_FILE" up -d api web

echo "==> Status"
docker compose -f "$COMPOSE_FILE" ps

echo "✅ Rollback complete"
