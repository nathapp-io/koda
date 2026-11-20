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
DATA_BACKUP_NAME="koda_data-$TS.tar.gz"
DATA_BACKUP_FILE="$BACKUP_DIR/$DATA_BACKUP_NAME"
# The archive is streamed into a host-created partial under a name that cannot be mistaken for a restorable
# backup, and renamed only after tar succeeded: a failed run must not leave something next to the verified
# dump that looks restorable (review B9).
DATA_BACKUP_PARTIAL_FILE="$BACKUP_DIR/.koda_data-$TS.tar.gz.partial"
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

# The dump and the archive each hold the whole database, so nobody but the operator may read them. The
# operator's shell usually runs with umask 022, so the mask is set here instead: it applies from the first
# artifact the script creates, and every file it writes is created owner-readable/writable only — a chmod
# after the fact would leave a window in which the contents are world-readable (review finding 4).
umask 077

# `mkdir -p` keeps the mode of a directory an earlier umask-022 run created, so the 0700 is applied
# explicitly, and a directory is the only outcome this script accepts: a regular file (or anything else) at
# that path fails here, before a single byte is dumped, rather than leaving the dump beside a directory
# other users can read.
if ! mkdir -p "$BACKUP_DIR" || [[ ! -d "$BACKUP_DIR" ]]; then
  echo "❌ Cannot create the backup directory: $BACKUP_DIR"
  exit 1
fi
if ! chmod 0700 "$BACKUP_DIR"; then
  echo "❌ Cannot secure the backup directory: $BACKUP_DIR"
  exit 1
fi

report_failed_dump() {
  # A dump that failed or is incomplete is worse than no dump: it looks restorable and is not.
  rm -f "$DB_BACKUP_FILE"
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
# somewhere in the decompressed text. The decompressed stream is read to its end through the pipe (a reader
# that stopped at the marker, `grep -q`, would kill the decompressor with SIGPIPE under `pipefail`, review
# K7) and never stored: a plaintext copy of the database would be a second, world-readable database on disk
# for the sake of one check.
gzip -t "$DB_BACKUP_FILE" 2>/dev/null || report_failed_dump
gzip -dc "$DB_BACKUP_FILE" | grep -F -x -- "$DUMP_COMPLETE_LINE" >/dev/null || report_failed_dump

echo "==> Creating data volume backup: $DATA_BACKUP_FILE"
# The archive is written by the host, never by the container. `compose run -T` (no TTY) streams tar's binary
# stdout out of the project's own api service into the host-created partial above, so the invoking account
# owns the file — a root container writing into a bind-mounted directory would leave a root-owned file the
# operator cannot recover on Linux (review finding 4). Compose mounts the project's koda_data volume at /data
# whatever the project name is, so no volume name and no separate helper container are needed (review K3).
# tar records the numeric uid/gid of every entry, so the archive keeps its ownership metadata without a name
# lookup on the host. The api image is Alpine (busybox tar).
rm -f "$DATA_BACKUP_PARTIAL_FILE"
if ! docker compose "${COMPOSE_ARGS[@]}" run -T --rm --no-deps --user root --entrypoint tar \
  api -czf - -C /data . > "$DATA_BACKUP_PARTIAL_FILE"; then
  rm -f "$DATA_BACKUP_PARTIAL_FILE"
  echo "❌ Data volume backup failed: $DATA_BACKUP_FILE"
  exit 1
fi
mv "$DATA_BACKUP_PARTIAL_FILE" "$DATA_BACKUP_FILE"

echo "✅ Backup complete: $DB_BACKUP_FILE, $DATA_BACKUP_FILE"
