#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
BACKUP_DIR="$SCRIPT_DIR/backups"
TS="$(date +%Y%m%d-%H%M%S)"
DB_BACKUP_FILE="$BACKUP_DIR/koda-db-$TS.sql.gz"
DB_CHECK_FILE="$BACKUP_DIR/.koda-db-$TS.check"
DATA_BACKUP_NAME="koda_data-$TS.tar.gz"
DATA_BACKUP_FILE="$BACKUP_DIR/$DATA_BACKUP_NAME"
DUMP_COMPLETE_LINE='-- PostgreSQL database dump complete'

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker is required"
  exit 1
fi

mkdir -p "$BACKUP_DIR"

report_failed_dump() {
  # A dump that failed or is incomplete is worse than no dump: it looks restorable and is not.
  rm -f "$DB_BACKUP_FILE" "$DB_CHECK_FILE"
  echo "❌ Postgres dump failed"
  exit 1
}

# The stack is often stopped when this runs (its volumes survive), and `deploy.sh` then runs
# `prisma migrate deploy`, which starts postgres through depends_on anyway. So a dump is always taken:
# on a first install this initialises the database and writes a near-empty but valid dump.
echo "==> Starting postgres"
if ! docker compose -f "$COMPOSE_FILE" up -d --wait postgres; then
  echo "❌ Could not start the postgres service — refusing to continue without a database dump"
  exit 1
fi

echo "==> Creating Postgres dump: $DB_BACKUP_FILE"
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  sh -lc 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$DB_BACKUP_FILE" || report_failed_dump

# pg_dump writes its last comment line only when it finished, so the dump is complete when that line is
# somewhere in the decompressed text. Check the gzip and then read the whole stream into a file: a reader
# that exits early on a pipe (`grep -q`) would kill the writer with SIGPIPE under `pipefail` (review K7).
gzip -t "$DB_BACKUP_FILE" 2>/dev/null || report_failed_dump
gzip -dc "$DB_BACKUP_FILE" > "$DB_CHECK_FILE" || report_failed_dump
grep -F -x -- "$DUMP_COMPLETE_LINE" "$DB_CHECK_FILE" >/dev/null || report_failed_dump
rm -f "$DB_CHECK_FILE"

echo "==> Creating data volume backup: $DATA_BACKUP_FILE"
# Archive the data volume inside the project's own api service: Compose mounts the project's koda_data
# volume at /data whatever the project name is, so no volume name and no separate helper container are
# needed (review K3). The api image is Alpine (busybox tar).
if ! docker compose -f "$COMPOSE_FILE" run --rm --no-deps --user root --entrypoint sh \
  -v "$BACKUP_DIR":/backup api -c "tar -czf /backup/$DATA_BACKUP_NAME -C /data ."; then
  echo "❌ Data volume backup failed: $DATA_BACKUP_FILE"
  exit 1
fi

echo "✅ Backup complete: $DB_BACKUP_FILE, $DATA_BACKUP_FILE"
