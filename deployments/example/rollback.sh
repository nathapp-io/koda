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

if [[ -n "$RESTORE_DB_FILE" ]]; then
  if [[ ! -f "$RESTORE_DB_FILE" || ! -r "$RESTORE_DB_FILE" ]]; then
    echo "❌ Backup file not found: $RESTORE_DB_FILE"
    exit 1
  fi

  if ! tar -tzf "$RESTORE_DB_FILE" >/dev/null 2>&1; then
    echo "❌ Backup file is not a valid .tar.gz: $RESTORE_DB_FILE"
    exit 1
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker is required"
  exit 1
fi

echo "==> Pull target images"
KODA_VERSION="$TARGET_VERSION" docker compose -f "$COMPOSE_FILE" pull api web

echo "==> Stopping app services"
docker compose -f "$COMPOSE_FILE" stop api web || true

if [[ -n "$RESTORE_DB_FILE" ]]; then
  echo "==> Restoring DB volume from: $RESTORE_DB_FILE"
  RESTORE_DIR="$(cd "$(dirname "$RESTORE_DB_FILE")" && pwd)"
  KODA_VERSION="$TARGET_VERSION" docker compose -f "$COMPOSE_FILE" run --rm --no-deps --user root --entrypoint sh \
    -v "$RESTORE_DIR:/backup:ro" \
    api -c "find /data -mindepth 1 -delete && tar -xzf /backup/$(basename "$RESTORE_DB_FILE") -C /data"
fi

ENV_FILE_TMP="${ENV_FILE}.tmp.$$"
if [[ -f "$ENV_FILE" ]]; then
  cp -p "$ENV_FILE" "$ENV_FILE_TMP"
  awk -v version="KODA_VERSION=$TARGET_VERSION" '
    /^KODA_VERSION=/ { print version; found = 1; next }
    { print }
    END { if (!found) print version }
  ' "$ENV_FILE" > "$ENV_FILE_TMP"
else
  : > "$ENV_FILE_TMP"
  printf '%s\n' "KODA_VERSION=$TARGET_VERSION" > "$ENV_FILE_TMP"
fi
mv "$ENV_FILE_TMP" "$ENV_FILE"

echo "==> Starting app services on KODA_VERSION=$TARGET_VERSION"
docker compose -f "$COMPOSE_FILE" up -d api web

echo "==> Status"
docker compose -f "$COMPOSE_FILE" ps

echo "✅ Rollback complete"
