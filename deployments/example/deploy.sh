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
