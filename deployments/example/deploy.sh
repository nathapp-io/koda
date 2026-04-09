#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
BACKUP_SCRIPT="$SCRIPT_DIR/backup-db.sh"
RUN_BACKUP=1

usage() {
  cat <<'EOF'
Usage:
  ./deploy.sh [--no-backup]

Options:
  --no-backup   Skip pre-deploy SQLite volume backup
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

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker is required"
  exit 1
fi

echo "==> Pre-deploy safety checks"
docker compose -f "$COMPOSE_FILE" config >/dev/null

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
docker compose -f "$COMPOSE_FILE" pull

echo "==> Run DB migrations"
docker compose -f "$COMPOSE_FILE" run --rm migrate

echo "==> Start services"
docker compose -f "$COMPOSE_FILE" up -d api web

echo "==> Post-deploy health checks"
curl -fsS "http://localhost:${API_PORT:-3100}/api/health" >/dev/null
curl -fsS "http://localhost:${WEB_PORT:-3101}" >/dev/null

echo "==> Status"
docker compose -f "$COMPOSE_FILE" ps

echo "✅ Deploy complete"
