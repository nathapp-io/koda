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
      if [[ "$env_line" =~ ^[[:space:]]*POSTGRES_PASSWORD[[:space:]]*=(.*)$ ]]; then
        effective_postgres_password="${BASH_REMATCH[1]}"
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
set -a
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"
set +a
curl -fsS "http://localhost:${API_PORT:-3100}/api/health" >/dev/null
curl -fsS "http://localhost:${WEB_PORT:-3101}" >/dev/null

echo "==> Status"
docker compose "${COMPOSE_ARGS[@]}" ps

echo "✅ Deploy complete"
