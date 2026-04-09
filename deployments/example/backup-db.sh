#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
BACKUP_DIR="$SCRIPT_DIR/backups"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/koda_data-$TS.tar.gz"

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker is required"
  exit 1
fi

mkdir -p "$BACKUP_DIR"

echo "==> Creating SQLite volume backup: $BACKUP_FILE"
# Backup the named volume (koda-local_koda_data) via helper container.
docker run --rm \
  -v koda-local_koda_data:/source:ro \
  -v "$BACKUP_DIR":/backup \
  alpine:3.20 \
  sh -lc "tar -czf /backup/$(basename "$BACKUP_FILE") -C /source ."

echo "✅ Backup complete: $BACKUP_FILE"
