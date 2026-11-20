#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
ENV_FILE="$SCRIPT_DIR/.env"
BACKUP_DIR="$SCRIPT_DIR/backups"
# The stamp keeps the date-time ordering, and the pid makes each run's files its own: two backups started
# in the same second must not write the same dump, and one run's failure cleanup must not delete the
# other's file (F1).
TS="$(date +%Y%m%d-%H%M%S)-$$"
DB_BACKUP_FILE="$BACKUP_DIR/koda-db-$TS.sql.gz"
DB_CHECK_FILE="$BACKUP_DIR/.koda-db-$TS.check"
DATA_BACKUP_NAME="koda_data-$TS.tar.gz"
DATA_BACKUP_FILE="$BACKUP_DIR/$DATA_BACKUP_NAME"
# The volume archive is written under a temporary, clearly unusable name and renamed only after tar
# succeeded (review B9): a failed run must not leave an incomplete archive next to the verified dump,
# where it would look restorable.
DATA_BACKUP_TMP_NAME=".koda_data-$TS.tar.gz.partial"
DUMP_COMPLETE_LINE='-- PostgreSQL database dump complete'

# Compose resolves the project from the environment file and the Compose file. Deploy pins its own `.env`
# with `--env-file` and then migrates that project, so this script must pin exactly the same pair: without
# it, `COMPOSE_ENV_FILES` (or a shell `COMPOSE_PROJECT_NAME`) can point this backup at another project than
# the one deploy migrates (review B1).
COMPOSE_ARGS=( -f "$COMPOSE_FILE" )
if [[ -f "$ENV_FILE" ]]; then
  COMPOSE_ARGS=( --env-file "$ENV_FILE" "${COMPOSE_ARGS[@]}" )
fi

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
if ! docker compose "${COMPOSE_ARGS[@]}" up -d --wait postgres; then
  echo "❌ Could not start the postgres service — refusing to continue without a database dump"
  exit 1
fi

echo "==> Creating Postgres dump: $DB_BACKUP_FILE"
docker compose "${COMPOSE_ARGS[@]}" exec -T postgres \
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
if ! docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps --user root --entrypoint sh \
  -v "$BACKUP_DIR":/backup api -c "tar -czf /backup/$DATA_BACKUP_TMP_NAME -C /data ."; then
  rm -f "$BACKUP_DIR/$DATA_BACKUP_TMP_NAME"
  echo "❌ Data volume backup failed: $DATA_BACKUP_FILE"
  exit 1
fi
mv "$BACKUP_DIR/$DATA_BACKUP_TMP_NAME" "$DATA_BACKUP_FILE"

echo "✅ Backup complete: $DB_BACKUP_FILE, $DATA_BACKUP_FILE"
