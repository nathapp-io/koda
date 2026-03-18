#!/usr/bin/env bash
# Auto lint:fix triggered by Claude PostToolUse (Edit|Write)
# Detects which package was edited and runs the correct lint:fix

set -euo pipefail

# Extract file_path from CLAUDE_TOOL_INPUT (JSON)
FILE_PATH=""
if [ -n "${CLAUDE_TOOL_INPUT:-}" ]; then
  FILE_PATH=$(echo "$CLAUDE_TOOL_INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('file_path', d.get('path', '')))
except:
    print('')
" 2>/dev/null || true)
fi

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

run_fix() {
  local pkg_dir="$1"
  echo "[lint-fix] Running lint:fix in $pkg_dir"
  cd "$REPO_ROOT/$pkg_dir" && bun run lint:fix 2>/dev/null || true
}

case "$FILE_PATH" in
  */apps/api/*|apps/api/*)
    run_fix "apps/api" ;;
  */apps/web/*|apps/web/*)
    run_fix "apps/web" ;;
  */apps/cli/*|apps/cli/*)
    run_fix "apps/cli" ;;
  *)
    # No matching package — skip
    exit 0 ;;
esac
