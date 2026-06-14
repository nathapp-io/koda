# Koda Manual Test Checklist — API + Web

Date: 2026-06-14
Scope: All currently implemented features — API (§3), Web (§4), Multi-user/RBAC (§7), and CLI smoke (§8).
Audience: Human tester or AI agent. API/CLI steps are copy-paste commands; Web steps are browser actions.

Scope notes:
- §3 and §4 are run as the single seeded **admin** user (ADMIN bypasses most authorization).
- §7 adds extra principals to exercise the permission boundaries that the admin-only pass cannot reach.
- §8 covers the `koda` CLI, which authenticates as an **agent** (API key), not a user.
Companion doc: `docs/20260614-test-plan-api-web-regression-safety.md` (strategy/prioritization).

---

## 0. How to read this

- `[ ]` = run it and tick when the actual result matches Expected.
- API facts (verified from source):
  - Base URL: `http://localhost:3100/api` (port `API_PORT=3100`, global prefix `GLOBAL_PREFIX=api`).
  - Response envelope: success = `{ "ret": 0, "data": ... }`; error = `{ "ret": <non-zero>, "message": "...", "errors": {...} }`.
  - HTTP status still reflects success/failure (200/201/204 vs 400/401/403/404/409).
  - Health check (`/api/health`) is the only route NOT enveloped.
- Web runs at `http://localhost:3101`, proxies `/api/**` to the API.

---

## 1. Local setup (do once)

```bash
# from repo root
bun install
cp .env.example .env                      # if not already present
cp apps/api/.env.example apps/api/.env    # if not already present

# DB + seed (creates admin user)
cd apps/api
bun run db:generate
bun run db:migrate
bun run seed:prod
# Terminal 1 — API
bun run dev            # http://localhost:3100

# Terminal 2 — Web
cd ../web && bun run dev   # http://localhost:3101
```

Seeded admin credentials (from `apps/api/prisma/seed.ts`):
- Email: `admin@koda.local`
- Password: `Admin123!`
- Also creates project: slug `eval`, key `EVAL`.

Useful URLs:
- Swagger UI (dev only): `http://localhost:3100/swagger-ui.html`
- Health: `http://localhost:3100/api/health`

---

## 2. API session bootstrap (run first)

```bash
export BASE=http://localhost:3100/api

# Health (no auth, no envelope)
curl -s $BASE/health
# Expected: {"status":"ok","timestamp":"..."}

# Login -> capture token (token lives at .data.accessToken)
export TOKEN=$(curl -s -X POST $BASE/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@koda.local","password":"Admin123!"}' | jq -r '.data.accessToken')
echo "TOKEN=${TOKEN:0:20}..."

# Auth header helper used below
auth() { curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }
```

If `jq` is unavailable, copy `data.accessToken` from the login response manually into `export TOKEN=...`.

---

## 3. API manual checklist (curl)

> Tip: create a throwaway project at the start so destructive steps don't touch `eval`.
> `export SLUG=qa-$(date +%s)` then create it in 3.2.

### 3.1 Auth  (e2e: partial)
- [ ] Register new user → `POST /auth/register`
  ```bash
  auth -X POST $BASE/auth/register -d '{"email":"qa1@koda.local","password":"QaPass123!"}'
  ```
  Expected: HTTP 201, `ret:0`, `data` has `accessToken`, `refreshToken`, `user`.
- [ ] Login valid → `ret:0` + tokens (done in §2).
- [ ] Login invalid password → `POST /auth/login` wrong pw. Expected: HTTP 401, non-zero `ret`.
- [ ] `GET /auth/me` with token → Expected: 200, returns current user.
- [ ] `GET /auth/me` without token → Expected: 401.
- [ ] Refresh → `POST /auth/refresh` with `Authorization: Bearer <refreshToken>`. Expected: 200, new tokens.
- [ ] Throttle: >10 logins in 60s → Expected: 429 (route is `@Throttle 10/60s`).

### 3.2 Projects  (e2e: yes)
- [ ] Create → `POST /projects`
  ```bash
  export SLUG=qa-demo
  auth -X POST $BASE/projects -d "{\"slug\":\"$SLUG\",\"name\":\"QA Demo\",\"key\":\"QAD\",\"description\":\"test\"}"
  ```
  Expected: 201, `data` project. (ADMIN required.)
- [ ] List → `auth $BASE/projects` → Expected: array incl. `qa-demo` and `eval`.
- [ ] Get → `auth $BASE/projects/$SLUG` → Expected: 200.
- [ ] Update → `auth -X PATCH $BASE/projects/$SLUG -d '{"description":"updated"}'` → Expected: 200, change reflected.
- [ ] Duplicate slug/key rejected → re-POST same slug → Expected: 4xx conflict/validation.
- [ ] Get nonexistent → `auth $BASE/projects/nope` → Expected: 404.
- [ ] (Defer DELETE to end so other steps have a project.)

### 3.3 Tickets CRUD  (e2e: yes)
- [ ] Create → `POST /projects/:slug/tickets`
  ```bash
  export REF=$(auth -X POST $BASE/projects/$SLUG/tickets \
    -d '{"title":"First bug","type":"BUG","priority":"HIGH","description":"repro steps"}' | jq -r '.data.ref')
  echo "REF=$REF"
  ```
  Expected: 201, `data.ref` like `QAD-1`.
- [ ] Invalid create (missing title) → Expected: 400 with `errors`.
- [ ] List → `auth "$BASE/projects/$SLUG/tickets"` → Expected: `{items,total,page,limit}`.
- [ ] Filter by status → `auth "$BASE/projects/$SLUG/tickets?status=CREATED"`.
- [ ] Filter by type/priority/assignedTo/unassigned → each returns filtered set.
- [ ] Pagination → `?page=1&limit=1` honored.
- [ ] Get by ref → `auth $BASE/projects/$SLUG/tickets/$REF` → 200.
- [ ] Update editable fields → `PATCH .../$REF -d '{"priority":"LOW"}'` → 200.

### 3.4 Ticket lifecycle state machine  (e2e: yes — highest value)
Valid path: `CREATED → VERIFIED → IN_PROGRESS → VERIFY_FIX → CLOSED`.
- [ ] Verify → `POST .../$REF/verify -d '{"body":"looks valid"}'` → status `VERIFIED`.
- [ ] Start → `POST .../$REF/start` → status `IN_PROGRESS`.
- [ ] Fix → `POST .../$REF/fix -d '{"body":"fix pushed"}'` → status `VERIFY_FIX`.
- [ ] Verify-fix approve → `POST ".../$REF/verify-fix?approve=true"` → status `CLOSED`.
- [ ] Verify-fix reject path (new ticket) → `?approve=false` → status back to `IN_PROGRESS`.
- [ ] Reject path (new ticket) → `POST .../$REF/reject -d '{"body":"invalid"}'` → status `REJECTED`.
- [ ] Invalid transition → `start` on a `CREATED` ticket → Expected: 4xx with clear error.
- [ ] Transition `body` becomes a comment (cross-check in 3.6).

### 3.5 Assignment  (e2e: light)
- [ ] Assign to user → `POST .../$REF/assign -d '{"assignedUserId":"<userId>"}'` → 200, reflected in get.
- [ ] Unassign → `POST .../$REF/assign -d '{}'` → 200, assignee cleared.
- [ ] Assign nonexistent actor → Expected: 4xx.
- [ ] Assign both user AND agent in one payload → Expected: rejected (contract: not both).
- [ ] Assignment reflected in `?assignedTo=<id>` list filter.

### 3.6 Comments  (e2e: NOT covered — manual focus)
- [ ] Add → `POST /projects/:slug/tickets/:ref/comments -d '{"body":"hello","authorUserId":"<id>"}'` → 201.
- [ ] List → `GET .../comments` → ordered, includes transition-generated comments.
- [ ] Invalid (empty body) → 400.
- [ ] Update own → `PATCH /comments/:id -d '{"body":"edited"}'` → 200 (owner only).
- [ ] Delete own → `DELETE /comments/:id` → 204.
- [ ] Edit/delete someone else's comment → Expected: 403 (CASL ownership condition).

### 3.7 Labels  (e2e: NOT covered at API level — manual focus)
- [ ] Create → `POST /projects/:slug/labels -d '{"name":"backend","color":"#3366FF"}'` → 201 (MANAGE permission).
- [ ] List → `GET .../labels`.
- [ ] Update → `PATCH .../labels/:id -d '{"color":"#FF0000"}'`.
- [ ] Invalid color → Expected: 400 or normalized per contract.
- [ ] Assign to ticket → `POST .../tickets/:ref/labels -d '{"labelId":"<id>"}'` → 201.
- [ ] Duplicate assignment → idempotent / 409 per contract.
- [ ] Remove from ticket → `DELETE .../tickets/:ref/labels/:labelId` → 204.
- [ ] Delete label → `DELETE .../labels/:id`.

### 3.8 Ticket links  (e2e: NOT covered at API level — manual focus)
- [ ] Add link → `POST /projects/:slug/tickets/:ref/links -d '{"url":"https://github.com/o/r/pull/1"}'` → 201.
- [ ] Re-add same url → Expected: 200 returns existing (unique on ticket+url).
- [ ] List → `GET .../links`.
- [ ] Invalid url → Expected: 400.
- [ ] Delete → `DELETE .../links/:linkId` → 204.

### 3.9 Agents  (e2e: yes for top-level)
- [ ] Create → `POST /agents -d '{"slug":"qa-agent","displayName":"QA Agent","status":"ACTIVE"}'` → 201, **capture returned API key**.
  ```bash
  export AKEY=$(auth -X POST $BASE/agents -d '{"slug":"qa-agent","displayName":"QA Agent","status":"ACTIVE"}' | jq -r '.data.apiKey')
  ```
- [ ] Agent self-profile → `GET /agents/me` with `Authorization: Bearer $AKEY` → 200, returns qa-agent.
- [ ] List → `GET /agents`.
- [ ] Update roles → `PATCH /agents/qa-agent/update-roles -d '{"roles":["DEVELOPER","REVIEWER"]}'`.
- [ ] Update capabilities → `PATCH /agents/qa-agent/update-capabilities -d '{"capabilities":["typescript"]}'`.
- [ ] Rotate key → `POST /agents/qa-agent/rotate-key` → new key; **old `$AKEY` now rejected** (re-test `/agents/me` → 401).
- [ ] Pickup → `GET /agents/qa-agent/pickup?project=$SLUG` → suggestion or empty.
- [ ] Pickup missing `project` param → Expected: 4xx.
- [ ] Non-admin create → Expected: 403 (use a non-admin user token).
- [ ] Delete → `DELETE /agents/qa-agent` → soft delete.

### 3.10 Knowledge Base / RAG  (e2e: partial — retriever only)
- [ ] Add document → `POST /projects/:slug/kb/documents -d '{"source":"manual","sourceId":"doc1","content":"Koda tracks tickets"}'` → 201.
- [ ] List → `GET .../kb/documents`.
- [ ] Search → `POST .../kb/search -d '{"query":"tickets","limit":5}'` → results with scores + verdict.
- [ ] Membership enforcement → call with a non-member user → Expected: 403.
- [ ] Optimize (admin) → `POST .../kb/optimize` → 200 admin / 403 non-admin.
- [ ] Delete by sourceId → `DELETE .../kb/documents/doc1` → 204 (admin).
- [ ] Graphify import → `POST .../kb/import/graphify -d '{"nodes":[...]}'` (IMPORT permission).

### 3.11 VCS integration  (e2e: NOT covered at API level — manual focus)
> Requires `VCS_ENCRYPTION_KEY` (64 hex chars) set in API env, else create should fail clearly.
- [ ] Missing encryption key path → start API without `VCS_ENCRYPTION_KEY`, attempt create → Expected: clear failure.
- [ ] Create connection → `POST /projects/:slug/vcs -d '{"provider":"github","repoOwner":"o","repoName":"r","token":"ghp_xxx"}'` → 201.
- [ ] Get connection → `GET .../vcs` → **token NOT leaked** in response.
- [ ] Update → `PATCH .../vcs -d '{"token":"ghp_new"}'`.
- [ ] Test connection → `POST .../vcs/test` → success/failure result.
- [ ] Sync single issue → `POST .../vcs/sync/42` → creates ticket; re-sync same → Expected: 409 conflict.
- [ ] Sync all → `POST .../vcs/sync` → summary `{issuesSynced, issuesSkipped, tickets}`.
- [ ] Sync PR status → `POST .../vcs/sync-pr` → `{updated:n}`.
- [ ] Delete → `DELETE .../vcs` → 204.

### 3.12 Code intel / impact  (e2e: ast-index + context covered)
- [ ] Impact missing params → `GET /projects/:slug/codeintel/impact` (no repoId/commitHash) → 400.
- [ ] Valid impact → `?repoId=r1&commitHash=abc&changedFiles=a.ts,b.ts` → response contract.
- [ ] Non-member → 403.
- [ ] Index commit → `POST /code-intel/index -d '{...}'` (MANAGE AstIndex).
- [ ] Symbol lookup → `GET /code-intel/symbols/:id?projectSlug=$SLUG` + `/callers` + `/callees`.

### 3.13 Memory & timeline  (e2e: NOT covered — manual focus)
- [ ] Create memory → `POST /memory -d '{"projectId":"<id>","kind":"FACT","subject":"x","predicate":"is"}'`.
- [ ] Record decision → `POST /memory/decisions -d '{...}'`.
- [ ] Project memory read → `GET /projects/:slug/memory?kind=FACT`.
- [ ] Timeline → `GET /projects/:slug/timeline` → ordered events; filter `?eventTypes=...&limit=...&cursor=...`.

### 3.14 Monitoring / admin / outbox  (e2e: NOT covered — manual focus)
- [ ] SLO dashboard → `GET /admin/slos?from=...&to=...` (ADMIN) → metrics structure, empty-state ok.
- [ ] Outbox list → `GET /admin/outbox?status=PENDING` (ADMIN).
- [ ] Outbox retry → `POST /admin/outbox/:eventId/retry` (ADMIN).

### 3.15 Webhooks & CI  (e2e: NOT covered — manual focus)
- [ ] Register outbound webhook → `POST /projects/:slug/webhooks -d '{"url":"https://x","events":["ticket.created"]}'` (ADMIN).
- [ ] List → `GET /projects/:slug/webhooks`.
- [ ] **BUG to confirm**: Delete webhook is mapped `@Delete('api/webhooks/:id')` with global `/api` prefix → real path is `DELETE /api/api/webhooks/:id`. Verify which path actually works and record it. (See §6.)
- [ ] CI webhook → `POST /projects/:slug/ci-webhook` with `x-ci-signature` HMAC → auto-creates ticket; bad signature → rejected.
- [ ] VCS webhook → `POST /projects/:slug/vcs-webhook` with `x-hub-signature-256` + `x-github-event` → processed; bad signature → rejected.

### 3.16 Teardown
- [ ] Delete throwaway project → `DELETE /projects/$SLUG` → 204.
- [ ] Soft-delete visibility: deleted project hidden from `GET /projects`; deleted ticket/label/agent likewise.

---

## 4. Web manual checklist (browser)

Login once at `http://localhost:3101/login` with `admin@koda.local` / `Admin123!`.

### 4.1 Auth & redirects  (e2e: yes)
- [ ] Visit `/projects` while logged out → redirected to `/login`.
- [ ] Login success → lands on `/` (projects).
- [ ] Login wrong password → error toast, stays on page.
- [ ] Register at `/register` → creates account, logs in.
- [ ] While logged in, visit `/login` → redirected to `/`.
- [ ] Logout → session cleared, protected pages redirect.

### 4.2 Projects list / board  (e2e: yes)
- [ ] `/` lists project cards; empty state when none.
- [ ] "New Project" dialog → name auto-derives slug; key uppercased 2–6 chars → create → card appears.
- [ ] "View Board" → `/:project` board with 6 columns (CREATED, VERIFIED, IN_PROGRESS, VERIFY_FIX, CLOSED, REJECTED).
- [ ] "New Ticket" dialog → title/type/priority/description → ticket appears in CREATED.
- [ ] "Import Issue" dialog → issue number → calls VCS sync (needs VCS connection).
- [ ] Click ticket card → opens detail page.

### 4.3 Ticket detail  (e2e: yes — most important page)
- [ ] Renders title/status/priority/type/description (markdown).
- [ ] Edit title/description/priority → Save → persists; Cancel discards.
- [ ] Transition buttons match status:
  - [ ] CREATED → Verify / Reject (optional comment dialog).
  - [ ] VERIFIED → Start / Close.
  - [ ] IN_PROGRESS → Submit Fix / Close / Reject.
  - [ ] VERIFY_FIX → Approve Fix / Close / Fail Fix.
  - [ ] CLOSED & REJECTED → no action buttons.
- [ ] Comments: add (type select), edit inline, delete (confirm). (e2e: ticket-detail-operations partial — verify add/edit/delete.)
- [ ] Assignment: enter user ID → Assign → avatar shows; Unassign clears.
- [ ] Labels: Add from dropdown (only unassigned shown); click label badge to remove.
- [ ] Links: add URL with type (pr/branch/commit/url); delete; PR/branch/commit grouped sections render.
- [ ] Delete ticket (confirm) → returns to board.

### 4.4 Agents  (e2e: yes for global page)
- [ ] `/agents` lists agents; "Create Agent" 2-step dialog reveals API key + copy.
- [ ] Actions menu: Edit Roles, Edit Capabilities, Rotate Key (reveals new key), Delete (confirm), status change.
- [ ] **BUG to confirm**: `/:project/agents` (project-scoped page) calls `GET /projects/:slug/agents` and `PATCH /projects/:slug/agents/:agentId` — **these routes do not exist in the API**. Expect failed load / errors. Record actual behavior. (See §6.)

### 4.5 Labels page  (e2e: inline-update covered)
- [ ] `/:project/labels` create label (name + color picker).
- [ ] Inline edit name/color → Save / Cancel.
- [ ] Delete (confirm).
- [ ] Invalid color handling.

### 4.6 KB page  (e2e: yes)
- [ ] `/:project/kb` Search tab: query → results with verdict; no-results message; error toast on failure.
- [ ] Documents tab: list renders with count; Add Document dialog (sourceId/type/content) → list refreshes.
- [ ] Delete document → row removed.
- [ ] Optimize KB → success toast (admin) / forbidden handling (non-admin).

### 4.7 Project settings + VCS  (e2e: yes for VCS sync-pr & integration)
- [ ] `/:project/settings` Projects tab: edit name/key/description → Save; no-change submit behavior.
- [ ] Delete Project (confirm) → navigates home.
- [ ] VCS tab: create connection (provider/owner/repo/token, sync mode, interval, authors).
- [ ] Token required only on first create, not on update.
- [ ] Test Connection → toast.
- [ ] Sync Now → summary toast; Sync PR Status → updated count toast.
- [ ] Disconnect → form resets.

### 4.8 Cross-cutting  (e2e: NOT covered — manual focus)
- [ ] i18n: switch locale (en/zh) → UI strings + validation/toasts localized on critical screens.
- [ ] SSR/hydration: hard refresh ticket detail & board → no auth redirect loop, no hydration mismatch.
- [ ] Accessibility smoke: dialog focus trap, keyboard nav on forms, visible labels.
- [ ] Layout stability: loading/empty/error states on board, agents, KB don't break layout.

---

## 5. e2e coverage gaps (where manual testing matters most)

Areas with **no automated e2e** — prioritize these manually:

| Area | API e2e | Web e2e | Manual priority |
|------|:-------:|:-------:|:----------------|
| Comments | No | partial | High |
| Labels (API) | No | inline only | High |
| Ticket links (API) | No | partial | High |
| VCS connection/sync (API) | No | settings only | High |
| Assignment edge cases | light | partial | Medium |
| Memory & timeline | No | No | Medium |
| Monitoring / SLO / outbox | No | No | Medium |
| Outbound webhooks / CI / VCS webhook | No | No | Medium |
| i18n / hydration / a11y | n/a | No | Medium |

API e2e present: agents, projects, tickets, ast-index, context, hybrid-retriever, generic endpoint.
Web e2e present: auth, projects, agents, kb, kb-admin, labels-inline, ticket-detail-operations, ticket-lifecycle, settings VCS sync-pr, vcs-integration-settings, git-ref-link.

---

## 6. Confirmed contract bugs to validate during this pass

1. **Project-scoped agents routes missing.** → tracked in **GitHub issue [#98](https://github.com/nathapp-io/koda/issues/98)** (needs a design decision; agents have no project association).
   Web page `/:project/agents` calls `GET /projects/:slug/agents` and `PATCH /projects/:slug/agents/:agentId`.
   API only defines `@Controller('agents')` — no `projects/:slug/agents` controller exists.
   Expected real result until fixed: 404 / failed page load.

2. **Webhook delete double prefix.** → **FIXED** (branch `fix/webhook-delete-route-double-prefix`).
   `webhook.controller.ts` mapped `@Delete('api/webhooks/:id')`; with global prefix `api` the effective path was `DELETE /api/api/webhooks/:id`. Corrected to `@Delete('webhooks/:id')` → `DELETE /api/webhooks/:id`. Covered by `webhook.controller.spec.ts`; `openapi.json` regenerated.

3. **No way to grant project membership.**
   `checkProjectMembership` reads `ProjectMember` rows, but **no controller, service, seed, or UI ever creates one** (project creation does not add the creator). Confirmed in `projects.service.ts` (no `projectMember.create`) and across the codebase. Consequences:
   - ADMIN users bypass membership entirely, so the §3/§4 admin pass never exercises it.
   - A non-admin MEMBER user can only become a project member via **direct DB insertion** (Prisma Studio / SQL / a custom seed).
   - Therefore the "member with limited role" tests in §7 require manual DB setup; there is no product surface for it.

4. **Membership is enforced inconsistently across project-scoped routes.**
   `checkProjectMembership` is called only in: KB/RAG, code-intel, context, and the project-memory/codeintel-impact endpoints of `projects.controller`. It is **not** called by tickets, comments, labels, links, VCS, or timeline — those rely on global role + CASL only. Verify in §7 whether a non-member MEMBER can create/modify tickets etc. (possible over-permission).

Items 1–2 are bugs; items 3–4 are design gaps worth raising. All recorded only — fixing is out of scope for the manual test pass.

---

## 7. Multi-user / RBAC track  (NOT covered by automated e2e)

Goal: exercise the authorization boundaries the admin-only pass (§3/§4) cannot reach. Run §2 first (admin `$TOKEN`, `$BASE`, `$SLUG`).

### 7.1 Provision principals
```bash
# Second regular user (defaults to role MEMBER)
export T_MEMBER=$(curl -s -X POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"member@koda.local","password":"Member123!"}' | jq -r '.data.accessToken')

# Third regular user — will remain a NON-member / outsider
export T_OUT=$(curl -s -X POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"outsider@koda.local","password":"Outsid123!"}' | jq -r '.data.accessToken')

# Agent principal (API key) — from §3.9 if created, else create here
export AKEY=$(auth -X POST $BASE/agents -d '{"slug":"rbac-agent","displayName":"RBAC Agent","status":"ACTIVE"}' | jq -r '.data.apiKey')

# Helpers
amember() { curl -s -H "Authorization: Bearer $T_MEMBER" -H 'Content-Type: application/json' "$@"; }
aout()    { curl -s -H "Authorization: Bearer $T_OUT"    -H 'Content-Type: application/json' "$@"; }
aagent()  { curl -s -H "Authorization: Bearer $AKEY"     -H 'Content-Type: application/json' "$@"; }
```

To test a **member with a limited project role**, insert a `ProjectMember` row manually (no API exists — see §6.3):
```bash
# Option A: Prisma Studio (apps/api) -> ProjectMember -> add row {projectId, userId, role:"VIEWER"}
cd apps/api && bun run db:studio
# Option B: get IDs then seed via sqlite/Prisma directly
#   projectId = GET /projects/$SLUG (.data.id);  userId from member's /auth/me (.data.id)
```

### 7.2 Global role (ADMIN vs MEMBER) — CASL boundaries
- [ ] MEMBER create project → `amember -X POST $BASE/projects -d '{...}'` → Expected: **403**.
- [ ] MEMBER create agent → `amember -X POST $BASE/agents -d '{...}'` → Expected: **403**.
- [ ] MEMBER register/list webhooks → `amember $BASE/projects/$SLUG/webhooks` → Expected: **403** (ADMIN only).
- [ ] MEMBER admin routes → `amember $BASE/admin/slos`, `amember $BASE/admin/outbox` → Expected: **403**.
- [ ] MEMBER KB optimize/delete → Expected: **403** (admin-only KB ops).
- [ ] ADMIN bypass confirm → admin succeeds on all the above.

### 7.3 Project membership enforcement (KB / code-intel / context / project-memory)
- [ ] Non-member MEMBER reads KB → `amember -X POST $BASE/projects/$SLUG/kb/search -d '{"query":"x"}'` → Expected: **403** (no ProjectMember row).
- [ ] Non-member code-intel impact → `amember "$BASE/projects/$SLUG/codeintel/impact?repoId=r&commitHash=c"` → Expected: **403**.
- [ ] Non-member context → `amember $BASE/context/<projectId>?intent=answer` → Expected: **403**.
- [ ] Member WITH a seeded `ProjectMember` row → same calls now **succeed** (role permitting).
- [ ] Member role too low (e.g. VIEWER calling an action needing DEVELOPER) → Expected: **403** per `allowedRoles`.

### 7.4 Over-permission probes (routes that DON'T check membership — see §6.4)
- [ ] Non-member MEMBER creates a ticket → `amember -X POST $BASE/projects/$SLUG/tickets -d '{"title":"x","type":"BUG"}'` → **record actual** (expected-or-bug?).
- [ ] Non-member MEMBER adds a label / link / comment → **record actual**.
- [ ] Non-member MEMBER reads tickets list / timeline → **record actual**.

### 7.5 Ownership boundaries (comments)
- [ ] User A adds a comment; User B (`amember`) tries `PATCH /comments/:id` → Expected: **403**.
- [ ] User B tries `DELETE /comments/:id` of A's comment → Expected: **403**.
- [ ] Author edits/deletes own comment → Expected: success.

### 7.6 Principal-type separation (user vs agent)
- [ ] `aagent $BASE/agents/me` → Expected: 200 (agent self).
- [ ] Agent key on a user-only route (e.g. `aagent -X POST $BASE/projects ...`) → Expected: **403** (agents lack ADMIN).
- [ ] User JWT on agent-self route `auth $BASE/agents/me` → Expected: behaves per contract (agent-scope guard) — record.
- [ ] Rotated/invalid agent key → Expected: **401**.

### 7.7 Web multi-user (browser)
- [ ] Log in as `member@koda.local` in a separate browser/incognito → admin-only UI (create project, create agent, webhooks/admin) hidden or returns errors.
- [ ] Two sessions on the same ticket: A transitions status, B refreshes → B sees updated state (no stale cache).

---

## 8. CLI smoke track  (`apps/cli`)  (separately unit-tested; no live e2e)

> The CLI authenticates as an **agent** via API key (validated against `/agents/me`) — it does NOT use user JWT. Create an agent first (§3.9 or §7.1) and use its `$AKEY`.

### 8.1 Build & authenticate
```bash
cd apps/cli && bun run build
KODA=./dist/index.js     # or `node dist/index.js`

# Auth precedence (high→low): flags > .koda/config.json > profile > ~/.koda/config.json > KODA_API_KEY/KODA_API_URL > default http://localhost:3100
$KODA login --api-key "$AKEY" --api-url http://localhost:3100
$KODA config show          # api key masked, url shown
```
- [ ] `login` with valid key → success (calls `/agents/me`).
- [ ] `login` with bogus key → Expected: clear auth error.
- [ ] `config show` → masked key + correct URL.

### 8.2 Project context
```bash
$KODA init --project $SLUG      # writes ./.koda/config.json
```
- [ ] `init` verifies project exists, then writes local config.
- [ ] `init --project nope` → Expected: failure (project not found).
- [ ] `project list` / `project show $SLUG --json` → expected data.

### 8.3 Ticket lifecycle via CLI
```bash
REF=$($KODA ticket create --type BUG --title "CLI smoke" --priority MEDIUM --json | jq -r '.ref')
$KODA ticket list --json
$KODA ticket show $REF
$KODA ticket assign $REF            # self-assign to the agent
$KODA ticket start $REF
$KODA ticket fix $REF --comment "fix pushed" --git-ref main
$KODA ticket verify-fix $REF --comment "looks good" --pass
```
- [ ] Each command succeeds and status advances CREATED→…→CLOSED.
- [ ] `--project` flag overrides local config; omitting it falls back to `.koda/config.json`.
- [ ] `ticket verify-fix` without `--pass`/`--fail` → Expected: validation error.
- [ ] `ticket mine` lists tickets assigned to the agent.

### 8.4 Other surfaces (smoke)
- [ ] `comment add $REF --body "hi" --type GENERAL` then `comment list $REF`.
- [ ] `label list` / `label create --name cli --color "#00ff00"`.
- [ ] `ticket link $REF --url https://github.com/o/r/pull/1` then `ticket unlink`.
- [ ] `agent me` / `agent pickup --project $SLUG`.
- [ ] `kb search --query "tickets"` / `kb list`.
- [ ] `vcs status` (no connection → graceful message).
- [ ] `--json` flag returns machine-readable output on the commands that support it.

### 8.5 CLI auth/context edge cases
- [ ] No auth configured (clear `~/.koda` + unset `KODA_API_KEY`) → command → Expected: helpful "not logged in" error.
- [ ] `KODA_API_URL` env override respected when no flag/config.
- [ ] Agent key lacks ADMIN → `project create` / `project delete` via CLI → Expected: **403** surfaced clearly.

---

## 9. Coverage summary after extension

| Track | Source | Automated e2e | This checklist |
|-------|--------|:-------------:|:--------------:|
| API (admin) | §3 | partial | full |
| Web (admin) | §4 | partial | full |
| Multi-user / RBAC | §7 | none | full (needs manual member seeding) |
| CLI | §8 | unit only | smoke |
</content>
</invoke>
