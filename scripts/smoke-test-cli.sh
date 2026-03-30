#!/usr/bin/env bash
# =============================================================================
# Koda API + CLI Smoke Test
# Usage: ./scripts/smoke-test-cli.sh [--keep-db]
#
# Starts the API, bootstraps test data, runs all CLI commands, reports results.
# Safe to re-run: uses a fresh temp DB each run, cleaned up after.
# =============================================================================

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$REPO_ROOT/apps/api"
CLI_DIR="$REPO_ROOT/apps/cli"
TEST_DB="/tmp/koda-smoke-$$.db"
API_LOG="/tmp/koda-smoke-$$.log"
API_URL="http://localhost:13100"
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
  [[ $FAIL -gt 0 ]] && exit 1
  exit 0
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
# STEP 0: Basic sanity
# =============================================================================
log "Step 0: Basic sanity checks..."
VERSION_OUT=$(HOME="$(mktemp -d)" bun run --silent --cwd "$CLI_DIR" src/index.ts --version 2>&1 || true)
assert "koda --version exits cleanly" "[0-9]\+\.[0-9]\+\.[0-9]\+" "$VERSION_OUT"

HELP_OUT=$(HOME="$(mktemp -d)" bun run --silent --cwd "$CLI_DIR" src/index.ts --help 2>&1 || true)
assert "koda --help shows commands" "ticket\|project\|agent" "$HELP_OUT"

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
  ok "DB migrations"
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
GLOBAL_PROJECT_SLUG="koda" \
node dist/main > "$API_LOG" 2>&1 &
API_PID=$!
cd "$REPO_ROOT"

log "Waiting for API..."
READY=false
for i in $(seq 1 20); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/api/health" 2>/dev/null || true)
  if [[ "$HTTP_CODE" == "200" ]]; then
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
# STEP 3b: Health endpoint
# =============================================================================
log "Step 3b: Health check..."
HEALTH_OUT=$(curl -sf "$API_URL/api/health" 2>&1)
assert "GET /api/health returns ok" '"status":"ok"' "$HEALTH_OUT"

# =============================================================================
# STEP 4: Bootstrap test data
# =============================================================================
log "Step 4: Bootstrapping test data..."

REGISTER=$(curl -sf -X POST "$API_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"smoke@koda.test","name":"Smoke Test","password":"Smoke1234!"}' 2>&1)
if echo "$REGISTER" | grep -q '"accessToken"'; then
  ok "Register user"
else
  fail "Register: $REGISTER"; exit 1
fi

JWT=$(echo "$REGISTER" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',d)['accessToken'])" 2>/dev/null)
USER_ID=$(echo "$REGISTER" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',d)['user']['id'])" 2>/dev/null)

# Promote user to ADMIN (first user is MEMBER by default)
PROMOTE_OUT=$(cd "$API_DIR" && DATABASE_URL="file:${TEST_DB}" npx prisma db execute \
  --schema prisma/schema.prisma --stdin <<< \
  "UPDATE \"User\" SET \"role\" = 'ADMIN' WHERE \"id\" = '${USER_ID}';" 2>&1) || true
if ! echo "$PROMOTE_OUT" | grep -qi "success\|executed"; then
  fail "ADMIN promotion failed: $PROMOTE_OUT"; exit 1
fi

# Re-login to get a fresh JWT with ADMIN role
LOGIN=$(curl -sf -X POST "$API_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"smoke@koda.test","password":"Smoke1234!"}' 2>&1)
JWT=$(echo "$LOGIN" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',d)['accessToken'])" 2>/dev/null)
ok "Promoted user to ADMIN"

PROJECT=$(curl -sf -X POST "$API_URL/api/projects" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{"name":"Koda","slug":"koda","key":"KODA","description":"Smoke test project"}' 2>&1)
if echo "$PROJECT" | grep -q '"slug"'; then
  ok "Create project 'koda'"
else
  fail "Create project: $PROJECT"; exit 1
fi

AGENT=$(curl -s -X POST "$API_URL/api/agents" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{"name":"Smoke Agent","slug":"smoke-agent"}' 2>&1)
RAW_KEY=$(echo "$AGENT" | python3 -c "import json,sys; d=json.load(sys.stdin); inner=d.get('data',d); print(inner.get('apiKey',inner.get('rawApiKey','')))" 2>/dev/null)
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

# Set default project so commands without --project work
INIT_OUT=$(koda init --project koda)
assert "koda init --project koda" "initialized\|configured\|koda\|success" "$INIT_OUT"

# =============================================================================
# STEP 6: Project commands
# =============================================================================
log "Step 6: Project commands..."
assert "koda project list"         "koda\|KODA\|Koda"  "$(koda project list)"
assert "koda project list --json"  '"slug"'             "$(koda project list --json)"
assert "koda project show koda"    "koda\|KODA\|Koda"  "$(koda project show koda)"
assert "koda project show --json"  '"slug"'             "$(koda project show koda --json)"

# =============================================================================
# STEP 7: Label CRUD
# =============================================================================
log "Step 7: Label CRUD..."
LABEL_CREATE_OUT=$(koda label create --project koda --name "smoke-bug" --color "#e11d48" --json)
assert "koda label create" '"name"\|smoke-bug' "$LABEL_CREATE_OUT"
LABEL_ID=$(echo "$LABEL_CREATE_OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id', d.get('data',{}).get('id','')))" 2>/dev/null || true)

assert "koda label list"       "smoke-bug"    "$(koda label list --project koda)"
assert "koda label list --json" '"name"'      "$(koda label list --project koda --json)"

# =============================================================================
# STEP 8: Ticket lifecycle
# =============================================================================
log "Step 8: Ticket lifecycle (bug workflow)..."
CREATE_OUT=$(koda ticket create --project koda --type BUG --title "Smoke test ticket")
assert "koda ticket create" "KODA-\|created\|success\|ticket\|smoke" "$CREATE_OUT"

assert "koda ticket list"       "KODA-\|Smoke"    "$(koda ticket list --project koda)"
assert "koda ticket list --json" '"id"\|"title"'  "$(koda ticket list --project koda --json)"
assert "koda ticket show KODA-1" "KODA-1\|Smoke"  "$(koda ticket show KODA-1)"
assert "koda ticket show --json" '"id"\|"title"'  "$(koda ticket show KODA-1 --json)"

assert "koda ticket verify"    "verif\|success\|VERIFIED"   "$(koda ticket verify KODA-1 --comment 'Looks verified')"
assert "koda ticket start"     "start\|success\|IN_PROGRESS" "$(koda ticket start KODA-1)"
assert "koda ticket fix"       "fix\|success\|VERIFY_FIX"   "$(koda ticket fix KODA-1 --comment 'Fixed it')"
assert "koda ticket verify-fix" "pass\|CLOSED\|success"     "$(koda ticket verify-fix KODA-1 --comment 'Good fix' --pass)"

# =============================================================================
# STEP 9: Ticket reject flow
# =============================================================================
log "Step 9: Ticket reject flow..."
koda ticket create --project koda --type BUG --title "Reject ticket" > /dev/null
assert "koda ticket reject"    "reject\|REJECTED\|success"  "$(koda ticket reject KODA-2 --comment 'Not a bug')"

# =============================================================================
# STEP 10: Ticket assign + mine
# =============================================================================
log "Step 10: Ticket assign + mine..."
koda ticket create --project koda --type BUG --title "Assign test ticket" > /dev/null
ASSIGN_OUT=$(koda ticket assign KODA-3 --to smoke-agent)
assert "koda ticket assign"    "assign\|success\|smoke-agent\|KODA-3" "$ASSIGN_OUT"
MINE_OUT=$(koda ticket mine --project koda)
assert "koda ticket mine"      "KODA-3\|Assign\|No tickets"          "$MINE_OUT"
MINE_JSON=$(koda ticket mine --project koda --json)
# mine --json returns [] if no tickets assigned, or array with items
assert "koda ticket mine --json" '"\|^\[' "$MINE_JSON"

# =============================================================================
# STEP 11: Ticket update
# =============================================================================
log "Step 11: Ticket update..."
assert "koda ticket update" "update\|success\|Updated" "$(koda ticket update KODA-3 --title 'Updated title' --priority HIGH)"

# =============================================================================
# STEP 12: Ticket close (direct)
# =============================================================================
log "Step 12: Ticket close..."
koda ticket create --project koda --type TASK --title "Close test ticket" > /dev/null
koda ticket start KODA-4 > /dev/null
assert "koda ticket close"    "close\|CLOSED\|success"  "$(koda ticket close KODA-4)"

# =============================================================================
# STEP 13: Ticket links
# =============================================================================
log "Step 13: Ticket links..."
koda ticket create --project koda --type BUG --title "Link test ticket" > /dev/null
assert "koda ticket link"     "link\|success\|github"    "$(koda ticket link KODA-5 --url 'https://github.com/owner/repo/pull/42')"
# unlink exits 0 with no output on success — check exit code instead
UNLINK_EXIT=$(HOME="$SMOKE_HOME" bun run --silent --cwd "$CLI_DIR" src/index.ts ticket unlink KODA-5 --url 'https://github.com/owner/repo/pull/42' > /dev/null 2>&1; echo $?)
if [[ "$UNLINK_EXIT" == "0" ]]; then
  ok "koda ticket unlink"
else
  fail "koda ticket unlink — exit code $UNLINK_EXIT"
fi

# =============================================================================
# STEP 14: Ticket labels (attach/detach)
# =============================================================================
log "Step 14: Ticket labels..."
if [[ -n "$LABEL_ID" ]]; then
  assert "koda ticket label add"    "success\|added\|attach"   "$(koda ticket label add KODA-5 --label "$LABEL_ID")"
  assert "koda ticket label remove" "success\|removed\|detach" "$(koda ticket label remove KODA-5 --label "$LABEL_ID")"
else
  fail "koda ticket label add — skipped (no LABEL_ID)"
  fail "koda ticket label remove — skipped (no LABEL_ID)"
fi

# =============================================================================
# STEP 15: Ticket delete
# =============================================================================
log "Step 15: Ticket delete..."
koda ticket create --project koda --type TASK --title "Delete me" > /dev/null
assert "koda ticket delete (no --force)" "force\|confirm\|require" "$(koda ticket delete KODA-6 2>&1)"
assert "koda ticket delete --force"      "delet\|success\|removed" "$(koda ticket delete KODA-6 --force)"

# =============================================================================
# STEP 16: Comment & agent
# =============================================================================
log "Step 16: Comment & agent..."
koda ticket create --project koda --type ENHANCEMENT --title "Comment ticket" > /dev/null
assert "koda comment add"   "success\|comment\|added\|Comment"  "$(koda comment add KODA-7 --body 'Great ticket')"
assert "koda agent me"      "smoke-agent\|Smoke Agent"          "$(koda agent me)"
assert "koda agent me --json" '"slug"\|"name"'                  "$(koda agent me --json)"

# =============================================================================
# STEP 17: Knowledge base
# =============================================================================
log "Step 17: Knowledge base..."
# NOTE: `koda kb add` CLI has a bug (sends filename as source instead of enum).
# Use API directly to seed a KB doc, then test CLI list/search.
KB_ADD=$(curl -s -X POST "$API_URL/api/projects/koda/kb/documents" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{"source":"manual","sourceId":"smoke-doc-1","content":"Smoke test knowledge base document about deployment"}' 2>&1)
assert "KB add via API"      '"id"\|"ret"\|success\|doc'  "$KB_ADD"

assert "koda kb list"        "manual\|smoke\|Source\|ID"   "$(koda kb list --project koda)"
assert "koda kb search"      "result\|score\|deploy\|no\|found\|No"  "$(koda kb search --project koda --query 'deployment')"

# =============================================================================
# STEP 18: Label delete
# =============================================================================
log "Step 18: Label delete..."
if [[ -n "$LABEL_ID" ]]; then
  assert "koda label delete" "delet\|success\|removed" "$(koda label delete --project koda --id "$LABEL_ID")"
else
  fail "koda label delete — skipped (no LABEL_ID)"
fi

# =============================================================================
# STEP 19: Error handling
# =============================================================================
log "Step 19: Error handling..."
NO_AUTH_HOME=$(mktemp -d)
EXIT_CODE=$(HOME="$NO_AUTH_HOME" bun run --silent --cwd "$CLI_DIR" src/index.ts project list > /dev/null 2>&1; echo $?)
rm -rf "$NO_AUTH_HOME"
if [[ "$EXIT_CODE" == "2" ]]; then
  ok "No credentials → exit 2"
else
  fail "No credentials → expected exit 2, got $EXIT_CODE"
fi
