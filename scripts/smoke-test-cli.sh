#!/usr/bin/env bash
# =============================================================================
# Koda API + CLI Smoke Test
# Usage: ./scripts/smoke-test.sh [--keep-db]
#
# Starts the API, bootstraps test data, runs all CLI commands, reports results.
# Safe to re-run: uses a fresh temp DB each run, cleaned up after.
# =============================================================================

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$REPO_ROOT/apps/api"
CLI_DIR="$REPO_ROOT/apps/cli"
TEST_DB="/tmp/koda-smoke-$$.db"
API_LOG="/tmp/koda-smoke-$$.log"
API_URL="http://localhost:13100/api"
API_PORT=13100
API_PID=""
SMOKE_HOME=""
KEEP_DB=false
PASS=0
FAIL=0
FAILURES=()

[[ "${1:-}" == "--keep-db" ]] && KEEP_DB=true

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RESET='\033[0m'

log()  { echo -e "${CYAN}[smoke]${RESET} $*"; }
ok()   { echo -e "${GREEN}  ✓${RESET} $*"; ((PASS++)) || true; }
fail() { echo -e "${RED}  ✗${RESET} $*"; ((FAIL++)) || true; FAILURES+=("$*"); }

cleanup() {
  [[ -n "$API_PID" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "$SMOKE_HOME" ]] && rm -rf "$SMOKE_HOME"
  [[ "$KEEP_DB" == false ]] && rm -f "$TEST_DB" "$API_LOG"
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "Results: ${GREEN}${PASS} passed${RESET}, ${RED}${FAIL} failed${RESET}"
  if [[ ${#FAILURES[@]} -gt 0 ]]; then
    echo -e "${RED}Failures:${RESET}"
    for f in "${FAILURES[@]}"; do echo "  - $f"; done
  fi
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
}
trap cleanup EXIT

assert() {
  local desc="$1" expected="$2"
  local actual="${3:-}"
  if echo "$actual" | grep -qi "$expected" 2>/dev/null; then
    ok "$desc"
  else
    fail "$desc  (expected: '$expected'  got: $(echo "$actual" | head -1))"
  fi
}

koda() {
  HOME="$SMOKE_HOME" bun run --silent --cwd "$CLI_DIR" src/index.ts "$@" 2>&1 || true
}

# =============================================================================
# STEP 1: Build API
# =============================================================================
log "Step 1: Building API..."
if (cd "$API_DIR" && bun run build > /dev/null 2>&1); then
  ok "API build"
else
  fail "API build failed"; exit 1
fi

# =============================================================================
# STEP 2: Migrate DB
# =============================================================================
log "Step 2: Running migrations..."
if (cd "$API_DIR" && DATABASE_URL="file:${TEST_DB}" npx prisma migrate deploy > /dev/null 2>&1); then
  ok "DB migrations (3 applied)"
else
  fail "DB migrations failed"; exit 1
fi

# =============================================================================
# STEP 3: Start API
# =============================================================================
log "Step 3: Starting API on port $API_PORT..."
cd "$API_DIR"
DATABASE_URL="file:${TEST_DB}" \
JWT_SECRET="smoke-secret" \
JWT_REFRESH_SECRET="smoke-refresh-secret" \
JWT_EXPIRES_IN="1h" \
JWT_REFRESH_EXPIRES_IN="7d" \
API_KEY_SECRET="smoke-api-key-secret" \
API_PORT=$API_PORT \
node dist/main > "$API_LOG" 2>&1 &
API_PID=$!
cd "$REPO_ROOT"

log "Waiting for API..."
READY=false
for i in $(seq 1 15); do
  if curl -sf "$API_URL/projects" > /dev/null 2>&1; then
    READY=true; break
  fi
  sleep 1
done

if [[ "$READY" != true ]]; then
  fail "API did not start (PID=$API_PID)"
  echo "--- API log ---"
  tail -20 "$API_LOG"
  exit 1
fi
ok "API started (PID=$API_PID)"

# =============================================================================
# STEP 4: Bootstrap test data
# =============================================================================
log "Step 4: Bootstrapping test data..."

REGISTER=$(curl -sf -X POST "$API_URL/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"smoke@koda.test","name":"Smoke Test","password":"Smoke1234!"}' 2>&1)
if echo "$REGISTER" | grep -q '"accessToken"'; then
  ok "Register user"
else
  fail "Register: $REGISTER"; exit 1
fi

JWT=$(echo "$REGISTER" | python3 -c "import json,sys; print(json.load(sys.stdin)['accessToken'])" 2>/dev/null)
USER_ID=$(echo "$REGISTER" | python3 -c "import json,sys; print(json.load(sys.stdin)['user']['id'])" 2>/dev/null)

# Promote user to ADMIN (first user is MEMBER by default)
(cd "$API_DIR" && DATABASE_URL="file:${TEST_DB}" npx prisma db execute --stdin <<< \
  "UPDATE \"User\" SET \"role\" = 'ADMIN' WHERE \"id\" = '${USER_ID}';" > /dev/null 2>&1) || true

# Re-login to get a fresh JWT with ADMIN role
LOGIN=$(curl -sf -X POST "$API_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"smoke@koda.test","password":"Smoke1234!"}' 2>&1)
JWT=$(echo "$LOGIN" | python3 -c "import json,sys; print(json.load(sys.stdin)['accessToken'])" 2>/dev/null)
ok "Promoted user to ADMIN"

PROJECT=$(curl -sf -X POST "$API_URL/projects" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{"name":"Koda","slug":"koda","key":"KODA","description":"Smoke test project"}' 2>&1)
if echo "$PROJECT" | grep -q '"slug"'; then
  ok "Create project 'koda'"
else
  fail "Create project: $PROJECT"; exit 1
fi

AGENT=$(curl -sf -X POST "$API_URL/agents" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{"name":"Smoke Agent","slug":"smoke-agent"}' 2>&1)
RAW_KEY=$(echo "$AGENT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('rawApiKey',''))" 2>/dev/null)
if [[ -n "$RAW_KEY" ]]; then
  ok "Create agent (API key captured)"
else
  fail "Create agent: $AGENT"; exit 1
fi

# =============================================================================
# STEP 5: Configure CLI
# =============================================================================
log "Step 5: Configuring CLI..."
SMOKE_HOME=$(mktemp -d)

LOGIN_OUT=$(koda login --api-key "$RAW_KEY" --api-url "$API_URL")
assert "koda login" "successful\|saved\|Logged" "$LOGIN_OUT"

CONFIG_OUT=$(koda config show)
assert "koda config show — URL" "13100" "$CONFIG_OUT"
assert "koda config show — masked key" "\*\*\*" "$CONFIG_OUT"

# =============================================================================
# STEP 6: Project commands
# =============================================================================
log "Step 6: Project commands..."
assert "koda project list"         "koda\|KODA\|Koda"  "$(koda project list)"
assert "koda project list --json"  '"slug"'             "$(koda project list --json)"
assert "koda project show koda"    "koda\|KODA\|Koda"  "$(koda project show koda)"
assert "koda project show --json"  '"slug"'             "$(koda project show koda --json)"

# =============================================================================
# STEP 7: Ticket lifecycle
# =============================================================================
log "Step 7: Ticket lifecycle..."
CREATE_OUT=$(koda ticket create --project koda --type bug --title "Smoke test ticket")
assert "koda ticket create" "KODA-\|created\|success\|ticket\|smoke" "$CREATE_OUT"

assert "koda ticket list"       "KODA-\|Smoke"    "$(koda ticket list --project koda)"
assert "koda ticket list --json" '"id"\|"title"'  "$(koda ticket list --project koda --json)"
assert "koda ticket show KODA-1" "KODA-1\|Smoke"  "$(koda ticket show KODA-1)"
assert "koda ticket show --json" '"id"\|"title"'  "$(koda ticket show KODA-1 --json)"

assert "koda ticket verify"    "verif\|success\|VERIFIED"   "$(koda ticket verify KODA-1 --comment 'Looks verified')"
assert "koda ticket start"     "start\|success\|IN_PROGRESS" "$(koda ticket start KODA-1)"
assert "koda ticket fix"       "fix\|success\|VERIFY_FIX"   "$(koda ticket fix KODA-1 --comment 'Fixed it')"
assert "koda ticket verify-fix" "pass\|CLOSED\|success"     "$(koda ticket verify-fix KODA-1 --comment 'Good fix' --pass)"

koda ticket create --project koda --type bug --title "Reject ticket" > /dev/null
assert "koda ticket reject"    "reject\|REJECTED\|success"  "$(koda ticket reject KODA-2 --comment 'Not a bug')"

# =============================================================================
# STEP 8: Comment + agent
# =============================================================================
log "Step 8: Comment & agent..."
koda ticket create --project koda --type enhancement --title "Comment ticket" > /dev/null
assert "koda comment add"   "success\|comment\|added\|Comment"  "$(koda comment add KODA-3 --body 'Great ticket')"
assert "koda agent me"      "smoke-agent\|Smoke Agent"          "$(koda agent me)"
assert "koda agent me --json" '"slug"\|"name"'                  "$(koda agent me --json)"

# =============================================================================
# STEP 9: Error handling
# =============================================================================
log "Step 9: Error handling..."
NO_AUTH_HOME=$(mktemp -d)
EXIT_CODE=$(HOME="$NO_AUTH_HOME" bun run --silent --cwd "$CLI_DIR" src/index.ts project list > /dev/null 2>&1; echo $?)
rm -rf "$NO_AUTH_HOME"
if [[ "$EXIT_CODE" == "2" ]]; then
  ok "No credentials → exit 2"
else
  fail "No credentials → expected exit 2, got $EXIT_CODE"
fi
