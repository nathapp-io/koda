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

# Install the restore: extract once, into a staging directory on the target volume, and swap it into place
# only after that extraction succeeded. Extracting here rather than in the container's writable layer means a
# backup that fits on the data volume does not also need room in Docker's storage, and a corrupt or
# unreadable archive fails before anything under /data is moved (review B13).
#
# Every top-level entry is enumerated except `.`, `..` and the two staging directories: the three globs cover
# plain names, single-dot names and names that begin with two dots, and a symlink counts as an entry even
# when its target is gone (an empty or already-moved target made the old `[ -e ]` test skip it, so a restore
# could report success while keeping stale entries and dropping archived ones — review B12).
RESTORE_INSTALL_SCRIPT='set -e
stage=/data/.koda-restore-staging
previous=/data/.koda-restore-previous
trap "rm -rf $stage" EXIT
if [ -e "$previous" ] || [ -L "$previous" ]; then
  echo "❌ An earlier restore was interrupted: $previous still holds the data it moved aside." >&2
  echo "   Put it back before rolling back again, inside the api container:" >&2
  echo "     cp -a $previous/. /data/ && rm -rf $previous" >&2
  exit 1
fi
rm -rf "$stage"
mkdir -p "$stage"
tar -xzf "/backup/$1" -C "$stage"
mkdir -p "$previous"
cd /data
for entry in ./* ./.[!.]* ./..?*; do
  case "$entry" in
    ./.koda-restore-staging|./.koda-restore-previous) continue ;;
  esac
  if [ -e "$entry" ] || [ -L "$entry" ]; then
    mv "$entry" "$previous/"
  fi
done
cd "$stage"
for entry in ./* ./.[!.]* ./..?*; do
  if [ -e "$entry" ] || [ -L "$entry" ]; then
    mv "$entry" /data/
  fi
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

# The Compose project name Compose would derive from the environment, in its own precedence order: the
# shell's `COMPOSE_PROJECT_NAME`, then the value in `.env`, then the Compose file's top-level `name:`.
# Compose interpolates all three, so any of them may reference KODA_VERSION.
compose_project_source() {
  local env_line env_value="" compose_line
  if [[ -n "${COMPOSE_PROJECT_NAME:-}" ]]; then
    printf '%s' "$COMPOSE_PROJECT_NAME"
    return 0
  fi
  if [[ -f "$ENV_FILE" ]]; then
    while IFS= read -r env_line || [[ -n "$env_line" ]]; do
      if [[ "$env_line" =~ ^[[:space:]]*(export[[:space:]]+)?COMPOSE_PROJECT_NAME[[:space:]]*[=:][[:space:]]*(.*)$ ]]; then
        env_value="${BASH_REMATCH[2]}"
      fi
    done < "$ENV_FILE"
    if [[ -n "$env_value" ]]; then
      printf '%s' "$env_value"
      return 0
    fi
  fi
  if [[ -f "$COMPOSE_FILE" ]]; then
    while IFS= read -r compose_line || [[ -n "$compose_line" ]]; do
      if [[ "$compose_line" =~ ^name:[[:space:]]*(.*)$ ]]; then
        printf '%s' "${BASH_REMATCH[1]}"
        return 0
      fi
    done < "$COMPOSE_FILE"
  fi
}

# This rollback stops the services under whatever version `.env` (or the shell) has now and restores under
# the target one. When the Compose project name follows KODA_VERSION, those two are different projects, so
# the stop would hit one project and the restore the other — and the data would land in a project the
# running stack never used (review B1). Refuse instead of guessing which project owns the data.
project_source="$(compose_project_source)"
case "$project_source" in
  *KODA_VERSION*)
    echo "❌ The Compose project name depends on KODA_VERSION (\"$project_source\")."
    echo "   A rollback stops one project and restores another when the project name follows the version."
    echo "   Pin COMPOSE_PROJECT_NAME (in .env, the shell, or the Compose file's name:) to a name that does not, then retry."
    exit 1
    ;;
esac

echo "==> Pull target images"
KODA_VERSION="$TARGET_VERSION" docker compose "${COMPOSE_ARGS[@]}" pull api web

if [[ -n "$RESTORE_DB_FILE" ]]; then
  # Stage next to the deployment (the directory `deploy.sh` writes `.env` in and `backup-db.sh` writes
  # `backups/` in), so the mount stays on a directory the operator's Docker shares, and the pid keeps two
  # concurrent rollbacks apart. Staging happens before the services stop, so an unstageable archive never
  # takes them down.
  RESTORE_STAGE_DIR="$SCRIPT_DIR/.rollback-stage-$$"
  mkdir -p "$RESTORE_STAGE_DIR"
  # A symlink to a valid archive outside its own directory passes the host checks, but the container only
  # sees the mounted directory and cannot follow it. `cp -L` stages the archive as a regular file, so the
  # container reads the content, not a dangling link (review B2).
  if ! cp -L "$RESTORE_DB_FILE" "$RESTORE_STAGE_DIR/$STAGED_ARCHIVE_NAME"; then
    echo "❌ Could not stage the backup file: $RESTORE_DB_FILE"
    exit 1
  fi
fi

echo "==> Stopping app services"
# A stop that cannot be confirmed leaves the API writing to the volume, so the restore (which replaces the
# data) must not run. A failure here aborts before anything is deleted (review B3).
if ! docker compose "${COMPOSE_ARGS[@]}" stop api web; then
  echo "❌ Could not stop the app services — refusing to restore data while they may be running"
  exit 1
fi

if [[ -n "$RESTORE_DB_FILE" ]]; then
  echo "==> Restoring DB volume from: $RESTORE_DB_FILE"
  KODA_VERSION="$TARGET_VERSION" docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps --user root --entrypoint sh \
    -v "$RESTORE_STAGE_DIR:/backup:ro" \
    api -c "$RESTORE_INSTALL_SCRIPT" koda-restore "$STAGED_ARCHIVE_NAME"
fi

ENV_FILE_TMP="${ENV_FILE}.tmp.$$"
if [[ -f "$ENV_FILE" ]]; then
  cp -p "$ENV_FILE" "$ENV_FILE_TMP"
  # Replace every assignment Compose would read — `KODA_VERSION=v0.9.0`, `KODA_VERSION: v0.9.0`,
  # `export KODA_VERSION = v0.9.0` and their whitespace variants: Compose accepts `=` and `:`, a later
  # assignment in the same file wins, and one left behind would restart the services on a version other
  # than the one that was pulled and restored (review B6).
  awk -v version="KODA_VERSION=$TARGET_VERSION" '
    /^[[:space:]]*(export[[:space:]]+)?KODA_VERSION[[:space:]]*[=:]/ { print version; found = 1; next }
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
