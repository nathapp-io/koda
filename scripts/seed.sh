#!/usr/bin/env bash
# =============================================================================
# Koda Local — Setup Script
# Run this after a fresh deploy or after wiping the data directory.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"

# --- 3. Seed initial admin user ---
echo ""
echo "🌱 Seeding initial admin user..."

# Env overrides (optional)
KODA_ADMIN_EMAIL="${KODA_ADMIN_EMAIL:-admin@koda.local}"
KODA_ADMIN_PASSWORD="${KODA_ADMIN_PASSWORD:-Admin123!}"
KODA_ADMIN_NAME="${KODA_ADMIN_NAME:-Admin}"

docker exec koda-api sh -c "
  cd /app &&
  KODA_ADMIN_EMAIL='$KODA_ADMIN_EMAIL' \
  KODA_ADMIN_PASSWORD='$KODA_ADMIN_PASSWORD' \
  KODA_ADMIN_NAME='$KODA_ADMIN_NAME' \
  bun apps/api/prisma/seed.ts
"

echo ""
echo "🎉 Setup complete!"
echo "   Web UI: http://localhost:3101"
echo "   API:    http://localhost:3100/api"
echo "   Login:  $KODA_ADMIN_EMAIL / $KODA_ADMIN_PASSWORD"
