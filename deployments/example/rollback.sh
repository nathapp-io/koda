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

# Use the same volume for extraction and the renames. Recovery data is published before
# moving any live entry, and the installing marker precedes the first install rename.
RESTORE_INSTALL_SCRIPT='set -eu
umask 077
stage=/data/.koda-restore-staging
previous=/data/.koda-restore-previous
exists() { [ -e "$1" ] || [ -L "$1" ]; }
root_metadata() { stat -c "%u:%g %a" "$1"; }
apply_root_metadata() {
  chown "${2%% *}" "$1" || return 1
  chmod "${2#* }" "$1" || return 1
  actual=$(root_metadata "$1") || return 1
  [ "$actual" = "$2" ]
}
if exists "$previous" || exists "$stage"; then
  echo "❌ An earlier restore was interrupted or a reserved staging path already exists." >&2
  echo "   Keep the services stopped; inspect $previous and $stage before retrying." >&2
  exit 1
fi
mkdir "$stage"
trap '\''rm -rf "$stage"'\'' EXIT
trap "exit 1" HUP INT TERM
mkdir "$stage/tree"
original=$(root_metadata /data)
# If the archive has no root entry, the extracted tree retains the original root metadata.
apply_root_metadata "$stage/tree" "$original"
tar --numeric-owner -xzpf "/backup/$1" -C "$stage/tree"
for reserved in .koda-restore-staging .koda-restore-previous; do
  if exists "$stage/tree/$reserved"; then
    echo "❌ Restore archive contains reserved name: $reserved" >&2
    exit 1
  fi
done
restored=$(root_metadata "$stage/tree")
mkdir -p "$stage/original/entries"
printf "%s\n" "$original" > "$stage/original/root-metadata"
mv "$stage/original" "$previous"
cd /data
for entry in ./* ./.[!.]* ./..?*; do
  case "$entry" in
    ./.koda-restore-staging|./.koda-restore-previous) continue ;;
  esac
  if exists "$entry"; then mv "$entry" "$previous/entries/"; fi
done
: > "$previous/installing"
cd "$stage/tree"
for entry in ./* ./.[!.]* ./..?*; do
  if exists "$entry"; then mv "$entry" /data/; fi
done
cd /data
if ! apply_root_metadata /data "$restored"; then
  echo "❌ Could not apply or verify the archived data root metadata." >&2
  exit 1
fi
# Commit by atomically removing the recovery marker from /data; the EXIT cleanup
# can now delete the saved entries without leaving a misleading partial recovery tree.
mv "$previous" "$stage/committed"'

LOCK_ID=""
KEEP_LOCK=0
ENV_FILE_TMP=""
cleanup() {
  if [[ -n "$RESTORE_STAGE_DIR" ]]; then
    rm -rf "$RESTORE_STAGE_DIR"
  fi
  if [[ -n "$ENV_FILE_TMP" ]]; then
    rm -f "$ENV_FILE_TMP"
  fi
  if [[ -n "$LOCK_ID" && "$KEEP_LOCK" == 0 ]]; then
    docker rm "$LOCK_ID" >/dev/null || echo "⚠️  Could not release rollback lock: $LOCK_NAME" >&2
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

usage() {
  cat <<'EOF'
Usage:
  ./rollback.sh <version> [--restore-db <backup-tar-gz>]

Examples:
  ./rollback.sh v0.3.0
  ./rollback.sh v0.3.0 --restore-db ./backups/koda_data-20260409-180000-12345.tar.gz
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
#
# With a local `.env`, `deploy.sh` pins it and Compose ignores the `COMPOSE_ENV_FILES` list, so this script
# does the same. With no local `.env`, `deploy.sh` passes no `--env-file` at all and Compose reads that list —
# and a single `--env-file` would replace it, leaving the staged validation and the restart with only the
# version this script writes (review rollback.sh:275). So the list is carried for that case, and the version
# file goes last: Compose reads them in order and the later file wins.
COMPOSE_ENV_FILE_ARGS=()
COMPOSE_ENV_FILE_LIST=()
if [[ ! -f "$ENV_FILE" && -n "${COMPOSE_ENV_FILES:-}" ]]; then
  IFS=',' read -r -a COMPOSE_ENV_FILE_LIST <<< "$COMPOSE_ENV_FILES"
  if [[ ${#COMPOSE_ENV_FILE_LIST[@]} -gt 0 ]]; then
    for compose_env_file in "${COMPOSE_ENV_FILE_LIST[@]}"; do
      if [[ -n "$compose_env_file" ]]; then
        COMPOSE_ENV_FILE_ARGS+=( --env-file "$compose_env_file" )
      fi
    done
  fi
fi
COMPOSE_ARGS=( -f "$COMPOSE_FILE" )
if [[ -f "$ENV_FILE" ]]; then
  COMPOSE_ARGS=( --env-file "$ENV_FILE" -f "$COMPOSE_FILE" )
else
  COMPOSE_ARGS=( ${COMPOSE_ENV_FILE_ARGS[@]+"${COMPOSE_ENV_FILE_ARGS[@]}"} -f "$COMPOSE_FILE" )
fi

# Read the canonical config, not the source expressions. This also resolves an explicit
# Docker volume name (two Compose projects can point at the same volume).
compose_identity() {
  docker compose "$@" config | awk '
    /^[^[:space:]]/ { section = $1; key = ""; mount_type = "" }
    function scalar(value) { if (value ~ /^"[a-zA-Z0-9_.-]+"$/) return substr(value, 2, length(value)-2); return value }
    /^name: / { project = scalar($2) }
    /^  [^[:space:]]/ { key = $1; mount_type = "" }
    section == "services:" && key == "api:" {
      if ($0 ~ /^    image: /) image = $2
      if ($0 ~ /^      - type: /) { mount_type = $3; source = "" }
      if ($0 ~ /^        source: /) source = scalar($2)
      if ($0 ~ /^        target: \/data$/ && mount_type == "volume") data_key = source
    }
    section == "volumes:" && /^    name: / { names[scalar(substr(key, 1, length(key)-1))] = scalar($2) }
    END {
      volume = names[data_key]
      if (project !~ /^[a-z0-9][a-z0-9_-]*$/ || volume !~ /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/ || !image) exit 1
      print project, volume, image
    }
  '
}
if ! current_identity="$(compose_identity "${COMPOSE_ARGS[@]}")" ||
   ! target_identity="$(KODA_VERSION="$TARGET_VERSION" compose_identity "${COMPOSE_ARGS[@]}")"; then
  echo "❌ Could not resolve the Compose project, API image and named /data volume." >&2
  exit 1
fi
read -r project volume _ <<< "$current_identity"
read -r target_project target_volume target_image <<< "$target_identity"
if [[ "$project" != "$target_project" || "$volume" != "$target_volume" ]]; then
  echo "❌ KODA_VERSION changes the resolved Compose project or data volume." >&2
  echo "   Use a version-independent project name and /data volume, then retry." >&2
  exit 1
fi
COMPOSE_ARGS+=( --project-name "$project" )

echo "==> Pull target images"
KODA_VERSION="$TARGET_VERSION" docker compose "${COMPOSE_ARGS[@]}" pull api web

if [[ -n "$RESTORE_DB_FILE" ]]; then
  # Stage next to the deployment (the directory `deploy.sh` writes `.env` in and `backup-db.sh` writes
  # `backups/` in), so the mount stays on a directory the operator's Docker shares. The unique directory
  # keeps concurrent rollbacks apart. Staging happens before the services stop, so an unstageable archive never
  # takes them down.
  RESTORE_STAGE_DIR="$(mktemp -d "$SCRIPT_DIR/.rollback-stage-XXXXXXXX")"
  # A symlink to a valid archive outside its own directory passes the host checks, but the container only
  # sees the mounted directory and cannot follow it. `cp -L` stages the archive as a regular file, so the
  # container reads the content, not a dangling link (review B2).
  if ! cp -L "$RESTORE_DB_FILE" "$RESTORE_STAGE_DIR/$STAGED_ARCHIVE_NAME"; then
    echo "❌ Could not stage the backup file: $RESTORE_DB_FILE"
    exit 1
  fi
fi

# Docker reserves container names atomically on the daemon. The lock is never started;
# acquiring it before stop also serializes version-only rollbacks on this volume.
LOCK_NAME="koda-rollback-lock-$volume"
if ! LOCK_ID="$(docker create --name "$LOCK_NAME" --entrypoint /bin/true "$target_image")"; then
  LOCK_ID=""
  echo "❌ Could not acquire rollback lock: $LOCK_NAME" >&2
  echo "   Check for another rollback or follow the interrupted-restore steps in README.md." >&2
  exit 1
fi

# Prepare the replacement under the lock, but do not publish it until the restore succeeds.
if [[ -e "$ENV_FILE" && ! -f "$ENV_FILE" ]]; then
  echo "❌ .env is not a regular file." >&2
  exit 1
fi
ENV_FILE_TMP="$(mktemp "$ENV_FILE.tmp.XXXXXXXX")"
if [[ -f "$ENV_FILE" ]]; then
  cp -p "$ENV_FILE" "$ENV_FILE_TMP"
  # Compose accepts export, colon and multiline quoted values. Track the closing quote
  # before treating a physical line as a new assignment. Keep unrelated bytes as-is.
  if ! KODA_ROLLBACK_VERSION="$TARGET_VERSION" LC_ALL=C awk -v final_nl="$(tail -c 1 "$ENV_FILE" | wc -l)" '
    function quote_end(text, start,    i, ch, backslashes) {
      backslashes = 0
      for (i = start; i <= length(text); i++) {
        ch = substr(text, i, 1)
        if (ch == quote && backslashes % 2 == 0) return i
        backslashes = (ch == "\\" ? backslashes + 1 : 0)
      }
      return 0
    }
    function emit(line) {
      if (pending) print last
      pending = 1
      last = line
    }
    BEGIN { version = "KODA_VERSION=" ENVIRON["KODA_ROLLBACK_VERSION"] }
    {
      # A UTF-8 BOM in front of the first key hides it from the anchored match: the old assignment would stay
      # and the target would be appended after it, leaving every setting in between interpolating the old
      # version. Compose ignores the BOM, so drop it and treat the line as the assignment it is.
      if (NR == 1 && substr($0, 1, 3) == "\357\273\277") $0 = substr($0, 4)
      if (quote != "") {
        if (!replacing) emit($0)
        if (quote_end($0, 1)) quote = ""
        next
      }
      replacing = 0
      if (match($0, /^[[:space:]]*(export[[:space:]]+)?[[:alnum:]_.-]+[[:space:]]*[=:][[:space:]]*/)) {
        replacing = ($0 ~ /^[[:space:]]*(export[[:space:]]+)?KODA_VERSION[[:space:]]*[=:]/)
        value = substr($0, RLENGTH + 1)
        quote = substr(value, 1, 1)
        if ((quote != "\047" && quote != "\042") || quote_end(value, 2)) quote = ""
      }
      if (replacing) {
        found = 1
        emit(version ($0 ~ /\r$/ ? "\r" : ""))
      } else emit($0)
    }
    END {
      if (quote != "") exit 1
      if (!found) emit(version)
      if (pending) printf "%s%s", last, (final_nl || !found ? "\n" : "")
    }
  ' "$ENV_FILE" > "$ENV_FILE_TMP"; then
    echo "❌ Could not prepare the staged .env." >&2
    exit 1
  fi
else
  printf '%s\n' "KODA_VERSION=$TARGET_VERSION" > "$ENV_FILE_TMP"
fi

# Validate what Compose will read on a future run without the shell version override.
if ! staged_identity="$(unset KODA_VERSION; compose_identity ${COMPOSE_ENV_FILE_ARGS[@]+"${COMPOSE_ENV_FILE_ARGS[@]}"} --env-file "$ENV_FILE_TMP" -f "$COMPOSE_FILE")" ||
   [[ "$staged_identity" != "$target_identity" ]]; then
  echo "❌ Could not validate the staged .env against the target Compose project, volume and API image." >&2
  exit 1
fi

volume_writers() {
  local containers container names mount_format
  containers=$(docker ps --no-trunc --quiet --filter "volume=$volume") || return 1
  # The volume filter selects candidates, including read-only mounts. Inspect the
  # actual mount name and access mode, and ignore containers that have since stopped.
  mount_format='{{if .State.Running}}{{range .Mounts}}{{if and (eq .Type "volume") (eq .Name "'"$volume"'") .RW}}{{println $.Name}}{{end}}{{end}}{{end}}'
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    names=$(docker container inspect --format "$mount_format" "$container") || return 1
    if [[ -n "$names" ]]; then printf '%s\n' "$names"; fi
  done <<< "$containers"
}

echo "==> Stopping app services"
# A stop that cannot be confirmed leaves the API writing to the volume, so the restore (which replaces the
# data) must not run. A failure here aborts before anything is deleted (review B3).
if ! docker compose "${COMPOSE_ARGS[@]}" stop api web; then
  echo "❌ Could not stop the app services — refusing to restore data while they may be running"
  exit 1
fi

if [[ -n "$RESTORE_DB_FILE" ]]; then
  if ! writers="$(volume_writers)"; then
    echo "❌ Could not check for running writers to $volume — refusing to restore." >&2
    exit 1
  fi
  if [[ -n "$writers" ]]; then
    printf '❌ Refusing to restore %s: running containers still have writable mounts:\n%s\n' "$volume" "$writers" >&2
    exit 1
  fi
  echo "==> Restoring DB volume from: $RESTORE_DB_FILE"
  # A failed/disconnected Docker client does not prove the worker stopped. Retain the
  # lock on any restore failure so no rollback starts the API on partially replaced data.
  KEEP_LOCK=1
  if ! KODA_VERSION="$TARGET_VERSION" docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps --user root --entrypoint sh \
    --name "koda-rollback-worker-$volume" -v "$RESTORE_STAGE_DIR:/backup:ro" \
    api -c "$RESTORE_INSTALL_SCRIPT" koda-restore "$STAGED_ARCHIVE_NAME"; then
    echo "❌ Restore failed. Keep the services stopped; rollback lock $LOCK_NAME was retained." >&2
    echo "   Follow the interrupted-restore steps in README.md before releasing the lock." >&2
    exit 1
  fi
  KEEP_LOCK=0
fi

mv "$ENV_FILE_TMP" "$ENV_FILE"
ENV_FILE_TMP=""
COMPOSE_ARGS=( ${COMPOSE_ENV_FILE_ARGS[@]+"${COMPOSE_ENV_FILE_ARGS[@]}"} --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --project-name "$project" )

echo "==> Starting app services on KODA_VERSION=$TARGET_VERSION"
# Pin the version for the restart too: an exported KODA_VERSION (or an assignment this script did not read)
# would otherwise bring the services up on another tag than the one pulled and restored (review B6).
KODA_VERSION="$TARGET_VERSION" docker compose "${COMPOSE_ARGS[@]}" up -d api web

echo "==> Status"
KODA_VERSION="$TARGET_VERSION" docker compose "${COMPOSE_ARGS[@]}" ps

echo "✅ Rollback complete"
