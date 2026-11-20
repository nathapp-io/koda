#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
ENV_FILE="$SCRIPT_DIR/.env"
TARGET_VERSION="${1:-}"
RESTORE_DB_FILE=""
RESTORE_STAGE_DIR=""
# The archive is copied into a staging directory under a fixed name, so the container reads a regular
# file with a plain name whatever the operator called the backup (review B2).
STAGED_ARCHIVE_NAME="koda-restore.tar.gz"

# Verify the staged archive extracts inside the target container. It runs before anything touches /data,
# so an unreadable archive leaves the current data in place.
RESTORE_CHECK_SCRIPT='set -e
rm -rf /tmp/koda-restore-check
mkdir -p /tmp/koda-restore-check
tar -xzf "/backup/$1" -C /tmp/koda-restore-check
rm -rf /tmp/koda-restore-check'

# Install the restore: extract into a staging directory inside the volume first, then swap it into place,
# so the current data stays recoverable until the new content is installed.
RESTORE_INSTALL_SCRIPT='set -e
stage=/data/.koda-restore-staging
previous=/data/.koda-restore-previous
rm -rf "$stage" "$previous"
mkdir -p "$stage"
tar -xzf "/backup/$1" -C "$stage"
mkdir -p "$previous"
for entry in /data/* /data/.[!.]*; do
  [ -e "$entry" ] || continue
  case "$entry" in
    /data/.koda-restore-*) continue ;;
  esac
  mv "$entry" "$previous/"
done
for entry in "$stage"/* "$stage"/.[!.]*; do
  [ -e "$entry" ] || continue
  mv "$entry" /data/
done
rm -rf "$stage" "$previous"'

cleanup_stage_dir() {
  if [[ -n "$RESTORE_STAGE_DIR" ]]; then
    rm -rf "$RESTORE_STAGE_DIR"
    RESTORE_STAGE_DIR=""
  fi
}
trap cleanup_stage_dir EXIT

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

  # `tar -tzf` alone is not enough: bsdtar (macOS) detects the format itself and lists a plain,
  # uncompressed tar, which the container's `tar -xzf` then cannot read (review B5). Check the gzip stream
  # explicitly as well.
  if ! gzip -t "$RESTORE_DB_FILE" >/dev/null 2>&1 || ! tar -tzf "$RESTORE_DB_FILE" >/dev/null 2>&1; then
    echo "❌ Backup file is not a valid .tar.gz: $RESTORE_DB_FILE"
    exit 1
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker is required"
  exit 1
fi

# Compose resolves the project from the environment file and the Compose file. `deploy.sh` pins its own
# `.env` with `--env-file` and then migrates that project, so this script pins exactly the same pair:
# otherwise `COMPOSE_ENV_FILES` can make a rollback touch another project than the one deploy manages
# (review B1).
COMPOSE_ARGS=( -f "$COMPOSE_FILE" )
if [[ -f "$ENV_FILE" ]]; then
  COMPOSE_ARGS=( --env-file "$ENV_FILE" "${COMPOSE_ARGS[@]}" )
fi

echo "==> Pull target images"
KODA_VERSION="$TARGET_VERSION" docker compose "${COMPOSE_ARGS[@]}" pull api web

echo "==> Stopping app services"
# A stop that cannot be confirmed leaves the API writing to the volume, so the restore (which replaces the
# data) must not run. A failure here aborts before anything is deleted (review B3).
if ! docker compose "${COMPOSE_ARGS[@]}" stop api web; then
  echo "❌ Could not stop the app services — refusing to restore data while they may be running"
  exit 1
fi

if [[ -n "$RESTORE_DB_FILE" ]]; then
  echo "==> Restoring DB volume from: $RESTORE_DB_FILE"
  # Stage next to the deployment (the directory `deploy.sh` writes `.env` in and `backup-db.sh` writes
  # `backups/` in), so the mount stays on a directory the operator's Docker shares, and the pid keeps two
  # concurrent rollbacks apart.
  RESTORE_STAGE_DIR="$SCRIPT_DIR/.rollback-stage-$$"
  mkdir -p "$RESTORE_STAGE_DIR"
  # A symlink to a valid archive outside its own directory passes the host checks, but the container only
  # sees the mounted directory and cannot follow it. `cp -L` stages the archive as a regular file, so the
  # container reads the content, not a dangling link (review B2).
  if ! cp -L "$RESTORE_DB_FILE" "$RESTORE_STAGE_DIR/$STAGED_ARCHIVE_NAME"; then
    echo "❌ Could not stage the backup file: $RESTORE_DB_FILE"
    exit 1
  fi

  echo "==> Verifying the archive inside the target container"
  KODA_VERSION="$TARGET_VERSION" docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps --user root --entrypoint sh \
    -v "$RESTORE_STAGE_DIR:/backup:ro" \
    api -c "$RESTORE_CHECK_SCRIPT" koda-restore "$STAGED_ARCHIVE_NAME"

  echo "==> Installing the restored data into /data"
  KODA_VERSION="$TARGET_VERSION" docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps --user root --entrypoint sh \
    -v "$RESTORE_STAGE_DIR:/backup:ro" \
    api -c "$RESTORE_INSTALL_SCRIPT" koda-restore "$STAGED_ARCHIVE_NAME"
fi

ENV_FILE_TMP="${ENV_FILE}.tmp.$$"
if [[ -f "$ENV_FILE" ]]; then
  cp -p "$ENV_FILE" "$ENV_FILE_TMP"
  # Replace every assignment Compose would read, including `export KODA_VERSION = v0.9.0` and its
  # whitespace variants: a later assignment in the same file wins, and leaving one behind would restart the
  # services on a version other than the one that was pulled and restored (review B6).
  awk -v version="KODA_VERSION=$TARGET_VERSION" '
    /^[[:space:]]*(export[[:space:]]+)?KODA_VERSION[[:space:]]*=/ { print version; found = 1; next }
    { print }
    END { if (!found) print version }
  ' "$ENV_FILE" > "$ENV_FILE_TMP"
else
  : > "$ENV_FILE_TMP"
  printf '%s\n' "KODA_VERSION=$TARGET_VERSION" > "$ENV_FILE_TMP"
fi
mv "$ENV_FILE_TMP" "$ENV_FILE"

echo "==> Starting app services on KODA_VERSION=$TARGET_VERSION"
# Pin the version for the restart too: an exported KODA_VERSION (or an assignment this script did not read)
# would otherwise bring the services up on another tag than the one pulled and restored (review B6).
KODA_VERSION="$TARGET_VERSION" docker compose "${COMPOSE_ARGS[@]}" up -d api web

echo "==> Status"
docker compose "${COMPOSE_ARGS[@]}" ps

echo "✅ Rollback complete"
