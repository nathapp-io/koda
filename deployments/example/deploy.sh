#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
ENV_FILE="$SCRIPT_DIR/.env"
BACKUP_SCRIPT="$SCRIPT_DIR/backup-db.sh"
RUN_BACKUP=1
COMPOSE_ARGS=( -f "$COMPOSE_FILE" )

usage() {
  cat <<'EOF'
Usage:
  ./deploy.sh [--no-backup]

Options:
  --no-backup   Skip pre-deploy database backup
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-backup)
      RUN_BACKUP=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "❌ Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ -f "$ENV_FILE" ]]; then
  COMPOSE_ARGS=( --env-file "$ENV_FILE" "${COMPOSE_ARGS[@]}" )
fi

is_url_safe_postgres_password() {
  local LC_ALL=C
  [[ -n "$1" && "$1" =~ ^[A-Za-z0-9._~-]+$ ]]
}

if [[ ${POSTGRES_PASSWORD+x} ]]; then
  effective_postgres_password="$POSTGRES_PASSWORD"
else
  effective_postgres_password=''
  if [[ -f "$ENV_FILE" ]]; then
    while IFS= read -r env_line || [[ -n "$env_line" ]]; do
      if [[ "$env_line" =~ ^[[:space:]]*(export[[:space:]]+)?POSTGRES_PASSWORD[[:space:]]*=(.*)$ ]]; then
        effective_postgres_password="${BASH_REMATCH[2]}"
      fi
    done < "$ENV_FILE"

    # Strip whitespace around the value, quotes, and comments without sourcing the file.
    effective_postgres_password="${effective_postgres_password#"${effective_postgres_password%%[![:space:]]*}"}"
    effective_postgres_password="${effective_postgres_password%"${effective_postgres_password##*[![:space:]]}"}"
    if [[ "${effective_postgres_password:0:1}" == '"' || "${effective_postgres_password:0:1}" == "'" ]]; then
      password_quote="${effective_postgres_password:0:1}"
      quoted_password="${effective_postgres_password:1}"
      if [[ "$quoted_password" == *"$password_quote"* ]]; then
        password_trailer="${quoted_password#*"$password_quote"}"
        effective_postgres_password="${quoted_password%%"$password_quote"*}"
        password_trailer="${password_trailer#"${password_trailer%%[![:space:]]*}"}"
        if [[ -n "$password_trailer" && "${password_trailer:0:1}" != '#' ]]; then
          effective_postgres_password+='!'
        fi
      else
        effective_postgres_password+='!'
      fi
    else
      # docker compose ends an unquoted value at a `#` only when it starts the value or follows
      # whitespace, so `unsafe#fragment` keeps its `#` and must fail the safety check below. Only a
      # whitespace-separated comment is stripped here; trimming happens after it.
      if [[ "$effective_postgres_password" =~ [[:space:]]# ]]; then
        effective_postgres_password="${effective_postgres_password%%"${BASH_REMATCH[0]}"*}"
      fi
      effective_postgres_password="${effective_postgres_password%"${effective_postgres_password##*[![:space:]]}"}"
    fi
  fi
fi

if ! is_url_safe_postgres_password "$effective_postgres_password"; then
  echo "❌ POSTGRES_PASSWORD must be non-empty and contain only A-Z, a-z, 0-9, ., _, ~, or -"
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  # A quoted value may span lines and legitimately contain a line that looks like an assignment, so only
  # top-level assignments count (review deploy.sh:94).
  if database_url_line="$(
    awk '
      BEGIN { dq = sprintf("%c", 34); sq = sprintf("%c", 39); quote = "" }
      {
        line = $0
        if (quote != "") {
          for (i = 1; i <= length(line); i++) {
            c = substr(line, i, 1)
            if (c == "\\") { i++; continue }
            if (c == quote) { quote = ""; break }
          }
          next
        }
        if (line ~ /^[[:space:]]*(export[[:space:]]+)?DATABASE_URL[[:space:]]*=/) { print NR; exit }
        eq = index(line, "=")
        if (eq == 0) next
        value = substr(line, eq + 1)
        sub(/^[[:space:]]+/, "", value)
        first = substr(value, 1, 1)
        if (first != dq && first != sq) next
        closed = 0
        for (i = 2; i <= length(value); i++) {
          c = substr(value, i, 1)
          if (c == "\\") { i++; continue }
          if (c == first) { closed = 1; break }
        }
        if (!closed) quote = first
      }
      END { if (quote != "") print 0 }
    ' "$ENV_FILE"
  )" && [[ -n "$database_url_line" ]]; then
    echo "❌ DATABASE_URL is not supported by this example deployment: it always uses the bundled postgres service"
    if [[ "$database_url_line" = 0 ]]; then
      echo "   (a quoted value in $ENV_FILE is never closed)"
    else
      echo "   (line $database_url_line of $ENV_FILE)"
    fi
    exit 1
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker is required"
  exit 1
fi

echo "==> Pre-deploy safety checks"
docker compose "${COMPOSE_ARGS[@]}" config >/dev/null

if [[ "$RUN_BACKUP" -eq 1 ]]; then
  if [[ ! -x "$BACKUP_SCRIPT" ]]; then
    echo "❌ backup script missing or not executable: $BACKUP_SCRIPT"
    exit 1
  fi
  echo "==> Pre-deploy backup"
  "$BACKUP_SCRIPT"
else
  echo "==> Pre-deploy backup skipped (--no-backup)"
fi

echo "==> Pull latest images"
docker compose "${COMPOSE_ARGS[@]}" pull

# The api image runs as uid 1001 since review E/SEC-4. A koda_data volume written by an older root image
# keeps root-owned files the api can no longer write; this is a no-op once ownership is right.
echo "==> Fix data volume ownership (api runs as uid 1001)"
docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps --user root --entrypoint chown \
  api -R 1001:1001 /data

echo "==> Run DB migrations (via api image)"
docker compose "${COMPOSE_ARGS[@]}" run --rm \
  api bunx --package prisma@7.10.0 prisma migrate deploy

echo "==> Start services"
# --wait returns once the healthchecks pass (review E/BUG-6: the curls below raced a starting container).
docker compose "${COMPOSE_ARGS[@]}" up -d --wait api web

echo "==> Post-deploy health checks"
# Ask Compose for the published ports instead of sourcing `.env`: an environment file Compose accepts may use
# syntax bash would run as commands (`KEY: value`, or a quoted multiline value), which fails here — after the
# services have already been replaced (review rollback.sh:289).
published_port() {
  local published
  published="$(docker compose "${COMPOSE_ARGS[@]}" port "$1" "$2" 2>/dev/null | head -n 1)" || return 1
  if [[ -z "$published" ]]; then
    return 1
  fi
  printf '%s\n' "${published##*:}"
}
if ! api_port="$(published_port api 3100)" || ! web_port="$(published_port web 3101)"; then
  echo "❌ Could not resolve the published ports of api and web from Compose" >&2
  exit 1
fi
curl -fsS "http://localhost:${api_port}/api/health" >/dev/null
curl -fsS "http://localhost:${web_port}" >/dev/null

echo "==> Status"
docker compose "${COMPOSE_ARGS[@]}" ps

echo "✅ Deploy complete"
