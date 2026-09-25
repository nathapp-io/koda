#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
BACKUP_DIR="$SCRIPT_DIR/backups"
TS="$(date +%Y%m%d-%H%M%S)"
DB_BACKUP_FILE="$BACKUP_DIR/koda-db-$TS.sql.gz"
LANCE_BACKUP_FILE="$BACKUP_DIR/koda_data-$TS.tar.gz"

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker is required"
  exit 1
fi

mkdir -p "$BACKUP_DIR"

DB_DUMPED=0
if [[ -n "$(docker compose -f "$COMPOSE_FILE" ps --quiet --status running postgres)" ]]; then
  echo "==> Creating Postgres dump: $DB_BACKUP_FILE"
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    sh -lc 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$DB_BACKUP_FILE"
  DB_DUMPED=1
else
  echo "==> Postgres service is not running yet — skipping database dump"
fi

echo "==> Creating LanceDB volume backup: $LANCE_BACKUP_FILE"
# Backup the named volume (koda-local_koda_data) via helper container.
docker run --rm \
  -v koda-local_koda_data:/source:ro \
  -v "$BACKUP_DIR":/backup \
  alpine:3.20 \
  sh -lc "tar -czf /backup/$(basename "$LANCE_BACKUP_FILE") -C /source ."

if [[ "$DB_DUMPED" -eq 1 ]]; then
  echo "✅ Backup complete: $DB_BACKUP_FILE, $LANCE_BACKUP_FILE"
else
  echo "✅ Backup complete: $LANCE_BACKUP_FILE (database dump skipped — postgres not running)"
fi
