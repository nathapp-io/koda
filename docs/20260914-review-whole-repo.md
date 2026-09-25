# Deep Code Review: koda (api + web + cli) — Revised

**Date:** 2026-09-14
**Reviewer:** Subrina (AI)
**Version:** 0.4.2 (HEAD on `main`)
**Scope:** `apps/api` (NestJS + Prisma + LanceDB), `apps/web` (Nuxt 3), `apps/cli` (Commander.js)
**Method:** Evidence-first graph + source pass against `universal`, `nestjs-app`, `nuxtjs`, `vuejs`, `node-general` checklists.
**Prior reviews:** `20260615-review-apps-security-perf.md` (A-, 87/100) and `20260906-review-whole-repo.md` (C+, 70/100).
**Revision:** Pass 2 of 2. Each finding below has been re-verified against the actual code at the cited line numbers. Findings that were over-stated, under-stated, or factually wrong have been revised. See "Revision Notes" at the end for a delta vs the first pass.

**Fix status (2026-09-25):** PR [#127](https://github.com/nathapp-io/koda/pull/127) (`fix/review-2026-09-14-bugs`, head `fdd03059`, open/unmerged) fixes every finding below except: SEC-3's throttle is inert until the 09-25 H2 (throttler guard registration) is fixed, and BUG-14 stays partial (GitLab still cannot be configured end to end). See `docs/20260925-review-whole-repo.md` → **Fixes in flight: PR #127** for the verified per-finding mapping.

---

## Overall Grade: A- (88/100)

Koda is in materially better shape than at the 2026-09-06 review. Every CRITICAL and HIGH finding from that pass is closed and verified. The remaining items are bounded MEDIUM/LOW debt, with one new HIGH (SEC-1: webhook replay window) and one re-classified MEDIUM→HIGH (BUG-2: `POST /assign` has no permission check at all — any authenticated user can call it).

| Dimension | Score | Notes |
|:----------|:------|:------|
| Security | 16/20 | All KODA-01/02/03/04/06/07/08/09/10/12 + WEB-01/02/03 + CLI-01/02/05 closed; new HIGH on webhook replay window; CLI-03 (file mode) and BUG-2 (assign is unauthenticated) still open |
| Reliability | 18/20 | Outbox retry+DLQ+admin endpoint all work; timing attack on login (BUG-12) still open; assign FK violations surface as 500 (BUG-2) |
| API Design | 17/20 | Envelope end-to-end; `assign` has no DTO and no permission; `STATUS_CHANGE.ref` returns CUID (BUG-15) |
| Code Quality | 18/20 | Dead `VcsIntegrationForm.vue` (ENH-1) and 3× `as any` workarounds in auth/tickets paths; HybridRetriever race (BUG-4) |
| Best Practices | 19/20 | CASL, throttling, i18n parity, soft-delete, refresh revocation, raw body cap all in place; missing `@@index([deletedAt])` on Project and Ticket (BUG-3) |

**Summary:** The repo demonstrates consistent investment in the security boundary (HMAC API keys with rotation, AES-GCM repo tokens, JWT version revocation, httpOnly cookies, body size cap, HMAC over raw bytes). The grade is held back by: (1) webhook signature HMAC is well-implemented but the inbound `pull_request` and `ci-webhook` paths have **no replay window** at all, allowing any captured-and-replayed webhook to create duplicate work; (2) `POST /projects/:slug/tickets/:ref/assign` has **no `@RequiredPermission`** and accepts a raw `Record<string, any>` body — any authenticated user (including VIEWER) can mutate any ticket's assignee, and Prisma FK violations surface as 500; (3) `Project` and `Ticket` tables have no `@@index([deletedAt])` despite dozens of `where: { deletedAt: null }` queries. The remaining items are LOW debt (login timing-enumerable, dead `VcsIntegrationForm.vue`, CLI key file mode).

---

## Status of Prior Review (2026-09-06)

| ID | Sev | Title | Status |
|:---|:----|:------|:-------|
| KODA-01 | CRITICAL | VCS controller had zero authorization | **FIXED** — `vcs.controller.ts:57,86,105,133,153,179,246,288` all carry `@RequiredPermission('ADMIN')` + `assertProjectMembership` |
| KODA-02 | HIGH | Webhook HMAC over `JSON.stringify(parsed)` | **FIXED** — `raw-body.hook.ts:31-70` captures raw bytes; `ci-webhook.controller.ts:40` and `vcs-webhook.controller.ts:48` prefer `request.rawBody` |
| KODA-03 | HIGH | PATCH /projects missing `@RequiredPermission('ADMIN')` | **FIXED** — `projects.controller.ts:74` |
| KODA-04 | HIGH | RAG `addDocument`/`listDocuments` skipped membership | **FIXED** — `rag.controller.ts:87,116` both call `checkProjectMembership` |
| KODA-06 | MEDIUM | Ticket-link routes unauthenticated | **FIXED** — `ticket-links.controller.ts:58,77,94` call `assertMembership` |
| KODA-07 | MEDIUM | Timeline endpoint unenforced | **FIXED** — `timeline.controller.ts:23,68` `assertMembership` |
| KODA-08 | MEDIUM | Memory writes accept caller-supplied `projectId` | **FIXED** — `memory.controller.ts:32-44` `assertWriteAuthorized` calls `projectAccess.assertProjectMembership` |
| KODA-09 | MEDIUM | `webhookSecret` returned in connection response | **FIXED** — `vcs-connection-response.dto.ts:10` only exposes `webhookSecretConfigured` |
| KODA-10 | MEDIUM | First-user bootstrap race | **FIXED** — `prisma-auth.repository.ts:52-67` wraps `findFirst` + `create` in `txManager.run()` |
| KODA-11 | LOW | Login is timing-enumerable | **OPEN** — see `BUG-12` |
| KODA-12 | MEDIUM | Raw-body hook unbounded | **FIXED** — `raw-body.hook.ts:9,42-61` `DEFAULT_RAW_BODY_LIMIT_BYTES = 1 MiB` with hard 413 reject |
| KODA-14 | MEDIUM | HybridRetriever duplicates VectorStore | **PARTIAL** — see `BUG-4` (race window still open) |
| KODA-15 | LOW | Failed PR leaves `/pulls/pending` link | **OPEN** — see `BUG-13` |
| KODA-16 | LOW | `POST :ref/assign` no DTO / no permission | **WORSE THAN REPORTED** — see `BUG-2` (re-classified HIGH; not just "raw body" but **no permission check at all**) |
| KODA-17 | LOW | GitLab URL parser / GHES URL unused | **OPEN** — see `BUG-14` |
| KODA-18 | LOW | STATUS_CHANGE ref returns CUID | **OPEN** — see `BUG-15` |
| WEB-01 | CRITICAL | Stored XSS via `v-html` of `marked()` output | **FIXED** — `[ref].vue:122` and `MarkdownEditor.vue:21` go through `renderSafeMarkdown` in `lib/markdown.ts:29-33` (DOMPurify with allowlist + URI regexp) |
| WEB-02 | HIGH | Cookie not httpOnly + logout/refresh not wired | **FIXED** — `server/utils/api.ts:35-52` sets `httpOnly: true, sameSite: 'strict', secure: true`; `server/api/auth/{login,logout,refresh,me}.post.ts` all call upstream; `composables/useAuth.ts:51-59` calls `/api/auth/logout` |
| WEB-03 | MEDIUM | Unsanitized URLs on `:href` | **FIXED** — every `:href` in `[ref].vue` (lines 410, 471, 489, 504, 561, 578, 625) routes through `safeHref` |
| WEB-04 | MEDIUM | Slug auto-derive broken after first edit | **FIXED** — `CreateAgentDialog.vue:159-165` `isSlugManuallyEdited` is now `computed` from `deriveSlug(name)` divergence |
| WEB-05 | MEDIUM | `z.number()` against text input | **FIXED** — `settings.vue:125` and `VcsIntegrationForm.vue:161` use `z.coerce.number()`; payload uses `Number()` (settings.vue:172) |
| WEB-06 | MEDIUM | `VcsIntegrationForm.vue` is dead code | **OPEN** — see `ENH-1` |
| WEB-07 | MEDIUM | `toLocaleDateString()` hydration mismatch | **PARTIAL** — `[ref].vue:160` and `kb.vue:74` pass `locale.value`; `pages/[project]/timeline.vue:44` still calls `toLocaleString()` with no args |
| CLI-01 | HIGH | `vcs` commands bypass envelope unwrap | **FIXED** — `commands/vcs.ts:132, 172, 309, 353, 400, 441` all `unwrap<T>(response)` |
| CLI-02 | MEDIUM | `resolveAuth` skips project config / profiles | **FIXED** — `utils/auth.ts:18-22` now delegates to `resolveContext` |
| CLI-03 | MEDIUM | API key file permissions default | **OPEN** — see `SEC-2` |
| CLI-04 | MEDIUM | `ticket assign` ignores `--agent`/`--to` | **OPEN** — see `BUG-10` (now documented at ticket.ts:364-380 instead of silently swallowed) |
| CLI-05 | MEDIUM | `login` masks every failure as "Invalid API key" | **FIXED** — `commands/login.ts:49-72` `loginError` distinguishes 401/403, body messages, and network failures |
| CLI-06 | MEDIUM | ~16× duplicated auth/context boilerplate | **OPEN** — see `BUG-7` (17× in `ticket.ts` alone) |

**Summary:** 18/24 prior findings fixed (75%). The 6 still-open items are listed above and re-flagged in the findings below.

---

## Findings

Severity legend: 🔴 CRITICAL · 🟠 HIGH · 🟡 MEDIUM · 🟢 LOW · 📋 @design (intentional)

---

### 🟠 HIGH

#### SEC-1: Webhook signature HMAC is verified but the inbound path has no replay window (CI + VCS pull_request)
**Severity:** HIGH | **Category:** Security
**File:** `apps/api/src/ci-webhook/ci-webhook.controller.ts:42-49`, `apps/api/src/vcs/vcs-webhook.controller.ts:50-58`, `apps/api/src/vcs/vcs-webhook.service.ts:113-131`
**Proof (CI webhook):**
```ts
// ci-webhook.controller.ts:42-49
const isValid = this.verifySignature(bodyBytes, signature ?? '', secret);
if (!isValid) {
  throw new AuthException({}, 'ci_webhook');
}
const result = await this.ciWebhookService.processCiWebhook(slug, payload);
```
**Proof (VCS signature verify):**
```ts
// vcs-webhook.service.ts:113-131
verifySignature(payload: string, signature: string, secret: string): boolean {
  try {
    const hash = createHmac('sha256', secret).update(payload).digest('hex');
    const expectedSignature = `sha256=${hash}`;
    const expected = Buffer.from(expectedSignature);
    const received = Buffer.from(signature);
    if (expected.length !== received.length) return false;
    return timingSafeEqual(expected, received);
  } catch { return false; }
}
```
**Verification against first-pass claim:** The first pass said "no replay protection at all". Verified correction:
- VCS `push` handler **does** have dedup (DB query `findPendingOutboxEvents` keyed on `(projectId, 'code_commit', commitHash)` + in-memory `recentCommitHashes` map, 5-min window — `vcs-webhook.service.ts:570-590, 592-597, 621`).
- VCS `issues.opened` handler dedups via `findExistingTicketByExternalId` (`vcs-sync.service.ts:32`).
- VCS `pull_request` handler has **no** dedup at all.
- CI webhook has **no** dedup at all.
- No `X-GitHub-Delivery` or `X-Koda-Delivery-Id` is read anywhere on the inbound path (`grep X-GitHub-Delivery` in `apps/api/src/vcs/` returns 0 hits).
- The outbound webhook handler *sends* `X-Koda-Delivery-Id` (`webhook-delivery.handler.ts:37`) but does not *consume* inbound delivery IDs.

**Risk:**
1. **VCS `pull_request`** — a captured-and-replayed `pull_request.closed`/`pull_request.opened` payload will re-run `handlePullRequestClosed`/`handlePullRequestOpened` (writes a `TicketActivity` row each call), pollute the timeline, and can re-trigger merged-PR auto-transitions (`applyMergedPrTransition` — `prisma-vcs.repository.ts:289-323` writes a `Comment` and updates ticket status, all idempotent by design but still produces audit-log noise).
2. **CI webhook** — a captured payload will create the same ticket again. The service's only dedup is `findUserByEmail` style on `payload.failures[0].test`; nothing in the path dedups by `(commit.sha, pipeline.id, failure.test)` triple.
3. **No timestamp/replay window** — even where dedup exists, an attacker who captures *one* payload gets to replay it forever within the dedup window (5 min) and again any time after.

**Fix:**
1. Require `X-GitHub-Delivery` (GitHub) / `X-CI-Delivery` on every inbound webhook. Persist `(projectId, deliveryId, receivedAt)` in a `webhookDelivery` table; reject duplicates with HTTP 409.
2. Reject any webhook older than 5 minutes via `Date` header / `iat` claim — close the forever-replay window.
3. Add the same dedup to `pull_request` and `ci-webhook` paths that the push path already has.

---

#### BUG-2 (re-classified): `POST /projects/:slug/tickets/:ref/assign` has no `@RequiredPermission` — any authenticated principal can mutate any ticket's assignee
**Severity:** HIGH | **Category:** Security / Bug
**File:** `apps/api/src/tickets/tickets.controller.ts:225-250`, `apps/api/src/tickets/tickets.service.ts:287-323`
**Proof:**
```ts
// tickets.controller.ts:232-250 — NO @RequiredPermission decorator above
async assign(
  @Param('slug') slug: string,
  @Param('ref') ref: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  @Body() assignInput: Record<string, any>,
) {
  const normalized: Record<string, unknown> = { ...assignInput };
  if ('assignedUserId' in normalized) { ... }
  if ('assignedAgentId' in normalized) { ... }
  const data = await this.assignTicket(slug, ref, normalized);
  return JsonResponse.Ok(data);
}
```
```ts
// tickets.service.ts:287-323
async assign(projectSlug: string, ref: string, assignInput: AssignInput) {
  if (assignInput.userId && assignInput.agentId) {
    throw new ValidationAppException({}, 'tickets');
  }
  const project = await this.ticketRepo.findProjectBySlug(projectSlug);
  if (!project || project.deletedAt) { throw new NotFoundAppException({}, 'tickets'); }
  const ticket = await this.findByRef(projectSlug, ref);
  if (!ticket) { throw new NotFoundAppException({}, 'tickets'); }
  const assignData = {
    assignedToUserId: null as string | null,
    assignedToAgentId: null as string | null,
  };
  if (assignInput.userId) { assignData.assignedToUserId = assignInput.userId; }
  else if (assignInput.agentId) { assignData.assignedToAgentId = assignInput.agentId; }
  const updated = await this.ticketRepo.assignTicket(ticket.id, assignData);
```
```ts
// prisma-tickets.repository.ts:243-253
async assignTicket(id: string, data: AssignTicketData): Promise<TicketDomain> {
  const row = await this.db.ticket.update({
    where: { id },
    data,
    include: { labels: { include: { label: true } }, links: true },
  });
  return this.toDomain(row);
}
```
**Verification against first-pass claim:** The first pass correctly flagged the raw body + missing DTO + missing existence check, but downplayed the missing permission. Verified escalation:
- `grep '@RequiredPermission' tickets.controller.ts` returns 0 matches on the assign route. Compare with `update` (line 199: `@RequiredPermission([KodaAction.UPDATE as CaslPermissionAction, 'Ticket'])`) and `softDelete` (line 215: `@RequiredPermission([CaslPermissionAction.DELETE, 'Ticket'])`).
- The CASL factory at `koda-casl-ability.factory.ts:53-56` only grants `UPDATE Comment` (own comments only) by default; nothing about `ASSIGN Ticket`. So the route is protected by authentication alone, not by authorization.
- A `MEMBER`-role user or even a `VIEWER`-role user can call `assign` and put any user ID or agent ID as assignee. Membership in the *project* is also not checked (vs. `getChangeImpact` in `projects.controller.ts:130` which does call `assertProjectMembership`).
- FK violation: `assignTicket` writes `assignedToUserId` directly to Prisma with no existence check. If the caller passes a non-existent user ID, Prisma throws `P2003`, which the global filter surfaces as **HTTP 500** instead of a clean 404.

**Risk:**
- Any authenticated principal (including cross-project `MEMBER` or `VIEWER`) can reassign any ticket in any project they can guess the slug of, putting *non-member* users/agents on tickets.
- Error path returns 500 on FK violation, leaking the schema error and creating an unauthenticated-feeling failure mode for legitimate "user does not exist" cases.

**Fix:**
1. Add `@RequiredPermission([KodaAction.UPDATE as CaslPermissionAction, 'Ticket'])` (matching the `update` route) and `await this.projectsService.assertProjectMembership(project.id, principal)` (matching `getChangeImpact`).
2. Introduce `AssignTicketDto { userId?: string; agentId?: string }` with `@IsOptional @IsString @IsCuid` validation.
3. Existence check: `if (assignInput.userId) await this.userRepo.findById(assignInput.userId)` — map `null` → 404.
4. Verify the *assignee* is a project member before assigning.

---

#### BUG-1 (re-classified): `(payload as any).id` workarounds hide a type-system mismatch in the auth principal flow
**Severity:** HIGH → MEDIUM (downgraded after verification — runtime works correctly)
**Category:** Type safety / Code smell
**File:** `apps/api/src/auth/auth.controller.ts:85`, `apps/api/src/auth/auth.service.ts:98`
**Proof:**
```ts
// auth.controller.ts:83-85
async logout(@Principal() user: JwtPayload) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await this.authService.logout(user.sub ?? (user as any).id);
}
// auth.service.ts:96-101
async validateUser(payload: JwtPayload) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user = await this.authRepo.findUserById(payload.sub ?? (payload as any).id);
  return user || null;
}
```
**Verification against first-pass claim:** The first pass said "any future migration ... would silently call `findUserById('undefined')`". Verified correction:
- `@Principal()` returns `request.user`, which is set by `JwtAuthGuard.validate()` via `authProvider.getPrincipal(payload)` (`@nathapp/nestjs-auth/dist/strategy/jwt-strategy-provider.js:32`).
- The runtime value is an `IPrincipal` (with `.id`, `.email`, `.role`, etc.) per `apps/api/src/auth/jwt-auth.provider.ts:40-55`. It does NOT have `.sub` (the JWT claim).
- The `@Principal() user: JwtPayload` typing is wrong: `user.sub` is `undefined`, so the `??` falls back to `user.id` which IS populated (the refresh strategy explicitly populates `id: payload.sub` at `koda-jwt-refresh-strategy.provider.ts:35`).
- The runtime works correctly today because the fallback is exercised on every call. **However**, this is a code smell that hides the type confusion, and any refactor that ships a principal without an `id` field would break silently.

**Risk:** Low operational risk (the fallback works), but high maintenance cost — the `as any` is a lie to the type system that will mislead future readers.

**Fix:** Type the controller parameter as the actual principal shape, not the JWT claim shape:
```ts
async logout(@Principal() user: UserPrincipal) {
  await this.authService.logout(user.id);
}
```
Replace `validateUser(payload: JwtPayload)` with `validateUser(principal: UserPrincipal)` and call `findUserById(principal.id)`.

---

### 🟡 MEDIUM

#### SEC-2: `apps/cli` stores API keys in `~/.koda/config.json` with default umask (0644 on most distros)
**Severity:** MEDIUM | **Category:** Security
**File:** `apps/cli/src/config.ts:21-25`, `apps/cli/src/commands/login.ts:32-39`
**Proof:**
```ts
// config.ts:21
const store = new Conf({
  cwd: join(homedir(), '.koda'),
  configName: 'config',
  schema,
});
```
```ts
// login.ts:32-39
const config: Record<string, string> = { apiKey, apiUrl: url };
setConfig(config as Parameters<typeof setConfig>[0]);
```
**Verification:**
- `grep -rn 'chmodSync\|fileMode\|0o600' apps/cli/src` → 0 hits.
- `init.ts:83` writes `.koda/config.json` locally but only stores `projectSlug` + `defaults` (not the API key — line 86 prints "This file must not contain API tokens or secrets"). The global `~/.koda/config.json` from `conf` does store the key.
- `conf` v13 calls `fs.writeFile` with default mode `0o666`; under default umask `0o022` the resulting mode is `0o644`.

**Risk:** On any multi-user workstation, the agent API key is world-readable. Note that `conf` may also apply `0o600` in newer releases — needs to be verified against the locked version in `bun.lock`.

**Fix:** After every write to the conf store (`setConfig`, `setProfile`), call `fs.chmodSync(store.path, 0o600)`. Also call `chmodSync` defensively on first read in case a pre-existing file has the wrong mode.

---

#### BUG-3 (re-scoped): Missing `@@index([deletedAt])` on `Project` and `Ticket` (NOT on Label/Webhook/VcsConnection/TicketLink — they have no `deletedAt` column)
**Severity:** MEDIUM | **Category:** Performance
**File:** `apps/api/prisma/schema.prisma:80-149, 184-260`
**Proof:**
```prisma
// schema.prisma:80-112
model Project {
  ...
  deletedAt        DateTime?
  ...
  @@unique([slug])
  @@unique([key])
  // no @@index([deletedAt])
}
// schema.prisma:127-149
model Ticket {
  ...
  deletedAt         DateTime?
  ...
  @@index([projectId, status])
  @@index([projectId, assignedToUserId])
  @@index([projectId, assignedToAgentId])
  @@index([externalVcsId])
  // no @@index([deletedAt])
}
// schema.prisma:490-501
model MemoryItem {
  deletedAt    DateTime?
  ...
  @@index([projectId, deletedAt])  // ✓ this one is already indexed
}
```
**Verification against first-pass claim:** The first pass over-stated scope by listing `Label`, `Webhook`, `VcsConnection`, `TicketLink`. Verified correction:
- `Label` (lines 185-195), `Webhook` (lines 226-236), `TicketLink` (lines 238-254), `VcsConnection` (lines 260-278) have **no `deletedAt` field at all**. The `deletedAt: null` filters in their queries reference **joined** tables (e.g., `prisma-ticket-link.repository.ts:32` joins `Project` and filters on `Project.deletedAt`).
- Only `Project` (line 91) and `Ticket` (line 146) have the `deletedAt` column without an index.

**Queries that hit the missing index (verified):**
- Project: `prisma-project.repository.ts:41, 60`; `prisma-rag.repository.ts:50` (`where: { deletedAt: null }` — Project table); `prisma-ticket-link.repository.ts:32, 42, 52` (joined); `prisma-canonical-state.repository.ts:33, 137` (joined).
- Ticket: `prisma-tickets.repository.ts:124, 146, 188`; `prisma-agent.repository.ts:126, 143` (joined via `assignedTickets.some`); `prisma-entity-graph.repository.ts:17`; `prisma-vcs.repository.ts:153` (joined).

**Risk:** At rest, ~99% of rows have `deletedAt: null`. Without an index, every soft-delete-aware listing does a full table scan and a `deletedAt IS NULL` filter. With high-cardinality Project × Ticket, list pages on `/projects/:slug/tickets` (which already paginate by `[projectId, status]`) are not affected — but global listings (`prisma-project.repository.ts:41` `findAll`, `prisma-rag.repository.ts:50` `findAllActiveProjectIds`) are.

**Fix:** Migration adding `@@index([deletedAt])` on Project and Ticket. Composite `@@index([deletedAt, projectId])` is better since most queries are scoped.

---

#### BUG-4: `HybridRetrieverService` lacks per-project table-creation locks and write serialization that `VectorStore` has
**Severity:** MEDIUM | **Category:** Bug / Concurrency
**File:** `apps/api/src/rag/hybrid-retriever.service.ts:144-230`
**Proof (HybridRetriever):**
```ts
// hybrid-retriever.service.ts:144-182
async indexDocument(projectId, doc) {
  const table = await this.getOrCreateTable(projectId);
  // ... embedding work ...
  await table.add([record]);  // no runExclusive wrapper
}
// hybrid-retriever.service.ts:184-230 — getOrCreateTable
const tableName = `project_${projectId}`;
const cached = this.tableCache.get(tableName);
if (cached) return cached;
const db = await this.connect();
if (!this.lanceAvailable || !db) { ... }
// no tableCreationLocks map
const tableNames: string[] = await db.tableNames();
// no `if (inFlight) return inFlight;`
let table: LanceTable;
if (tableNames.includes(tableName)) { table = await db.openTable(tableName); }
else { table = await db.createTable(tableName, [sentinel]); ... }
```
**Proof (VectorStore — the canonical version):**
```ts
// vector-store.service.ts:74
private readonly tableCreationLocks = new Map<string, Promise<LanceTable>>();
// vector-store.service.ts:236-244
const inFlight = this.tableCreationLocks.get(tableName);
if (inFlight) return inFlight;
const creation = this.createOrOpenTable(projectId, tableName).finally(() => {
  this.tableCreationLocks.delete(tableName);
});
this.tableCreationLocks.set(tableName, creation);
return creation;
// vector-store.service.ts:252-266 — runExclusive
private async runExclusive<T>(tableName: string, fn: () => Promise<T>): Promise<T> { ... }
```
**Verification:** The two services are near-duplicates (per KODA-14 from the prior review). `rag.controller.ts:88-101` writes to both stores concurrently via `Promise.all`, so any race in either store will produce cross-store inconsistency that the RRF merge (`hybrid-retriever.service.ts:144-200`) sees as real results.

**Risk:** Concurrent first-time ingestion for the same project can race LanceDB's `db.tableNames()` → `createTable` sequence in either store. Two callers will both create the table; one will throw on duplicate. More dangerous: two `table.add([record])` calls interleaved with `table.delete(filter)` calls (no write serialization) can produce partial state.

**Fix:** Either (a) extract the shared table-creation/write machinery into `LanceTableManager` and have both `VectorStore` and `HybridRetrieverService` consume it, or (b) make `HybridRetrieverService.indexDocument` delegate to `VectorStore` for the write path and only keep the read path here.

---

#### SEC-3: No targeted throttle on admin/agent-create and key-rotate endpoints
**Severity:** MEDIUM | **Category:** Security
**File:** `apps/api/src/agents/agents.controller.ts:13-174`
**Proof:** `grep '@Throttle' apps/api/src/auth/auth.controller.ts` → 1 match (line 22: `@Throttle({ default: { limit: 5, ttl: 60000 } })`). `grep '@Throttle' apps/api/src/agents/agents.controller.ts` → 0 matches. `app.module.ts:69-73` sets a global default of 100/min.

**Risk:** A compromised ADMIN token can mint unlimited new agent API keys (each equivalent to a fresh credential) and rotate existing ones via `POST /agents/:slug/rotate-key` (`agents.controller.ts:163-174`). No targeted throttle, no audit log beyond the `OutboxEvent` activity records.

**Fix:** Add `@Throttle({ default: { limit: 10, ttl: 60000 } })` on `AgentsController` (similar to auth). Consider per-ADMIN throttle if observed abuse.

---

#### BUG-5 (corrected): `extractIssueNumber` and `extractPrNumber` can return empty string for malformed URLs — display only, no filter impact
**Severity:** LOW (downgraded from MEDIUM after verification)
**Category:** Bug
**File:** `apps/web/pages/[project]/tickets/[ref].vue:176-196`
**Proof:**
```ts
function extractIssueNumber(url: string): string {
  const parts = url.split('/')
  return parts[parts.length - 1] || ''
}
function extractPrNumber(externalRef: string | null): string {
  if (!externalRef) return ''
  const parts = externalRef.split('#')
  return parts[parts.length - 1] || ''
}
```
**Verification against first-pass claim:** The first pass said "any filter using that value silently drops the link". Verified correction:
- These functions are used only in **template interpolation**, not in any filter predicate.
- The filter predicates in the same file (`githubPrLinks` line 181-184, `githubPrLinksWithState` line 198-201, `vcsPullRequestLinks` line 212-215) operate on `link.prNumber`, `link.linkType`, `link.provider` — they do NOT use these extractor functions.
- An empty string from these extractors just renders blank in the i18n interpolation (e.g., `{{ t('tickets.pr.badge', { number: '' }) }}` → "PR #").

**Risk:** Cosmetic — empty string in display.

**Fix:** Return `string | null` and guard callers with `?? 'unknown'`.

---

#### BUG-7: `apps/cli/src/commands/ticket.ts` is 816 lines with 17× `resolveContext + OpenAPI.BASE/TOKEN` boilerplate
**Severity:** MEDIUM | **Category:** Code quality
**File:** `apps/cli/src/commands/ticket.ts:74-756` (and 7 other command files)
**Proof:** `grep -c 'resolveContext' apps/cli/src/commands/ticket.ts` = **18**. `grep -c 'OpenAPI.BASE = ctx.apiUrl' apps/cli/src/commands/ticket.ts` = **17**. The canonical block (lines 74-99, 138-163, 192-217, …):
```ts
const ctx = await resolveContext({ projectSlug: options.project });
if (!ctx.projectSlug) {
  handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
}
if (!ctx.apiKey) {
  handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
}
OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
OpenAPI.TOKEN = ctx.apiKey;
```
**Verification:** `grep -c` confirms 17× in `ticket.ts` alone. Other affected files: `comment.ts` (4×), `webhook.ts` (3×), `memory.ts` (3×), `vcs.ts` (8×), `agent.ts` (~5×), `label.ts` (~5×).

**Risk:** Drift: some sites omit `if (!ctx.apiUrl)`, some check `!ctx.apiKey || !ctx.apiUrl`. When CLI-02 was fixed by collapsing `resolveAuth → resolveContext`, this duplication is what made the regression hidden for weeks.

**Fix:** `withContext({ projectSlug: options.project }, async (ctx) => { ... })` helper that performs the four-line bootstrap once and short-circuits on config errors.

---

#### BUG-8: `auth.service.ts:register` falls back to `email.split('@')[0]` when name is not provided
**Severity:** MEDIUM | **Category:** Bug / Privacy
**File:** `apps/api/src/auth/auth.service.ts:31`
**Proof:**
```ts
const { email, password } = registerDto;
const name = registerDto.name ?? email.split('@')[0];
```
**Verification:** `register.dto.ts:9-13` has `@IsOptional() @IsString() @MinLength(1) name?`. So an email-only registration leaks the local-part into the `User.name` field.

**Risk:** Email local-parts commonly contain tracking aliases (`alice+recruiter-search@personal.example`) or role hints (`recruiter@`, `ceo@`). These persist in audit logs and appear on every comment the user posts.

**Fix:** Require `name` in `RegisterDto` (drop `@IsOptional`), or fall back to `'User-' + short(userId)` instead of the email local part.

---

#### ENH-1: `apps/web/components/VcsIntegrationForm.vue` is dead code; `settings.vue` is the live copy
**Severity:** MEDIUM | **Category:** Enhancement
**File:** `apps/web/components/VcsIntegrationForm.vue` (8.3 KB) vs `apps/web/pages/[project]/settings.vue:313-427`
**Proof:** `grep -rn 'VcsIntegrationForm' apps` returns hits only in:
- `apps/web/tests/components/vcs-integration-form.spec.ts` (the test that loads the .vue file via `readFileSync`)
- `apps/web/.nuxt/types/components.d.ts:42` and `apps/web/.nuxt/components.d.ts:42` (Nuxt's auto-generated component registry)

Zero production code imports the component. `settings.vue` and `VcsIntegrationForm.vue` share the `pollingIntervalMs` zod schema and identical layout byte-for-byte.

**Risk:** Any future VCS form fix lands on one copy only — already happened for WEB-05.

**Fix:** Delete `apps/web/components/VcsIntegrationForm.vue` and its now-dead test (`apps/web/tests/components/vcs-integration-form.spec.ts`); add tests that cover `settings.vue` instead.

---

### 🟢 LOW

#### BUG-10: CLI-04 — `koda ticket assign <ref> --to <agent>` still self-assigns
**Severity:** LOW | **Category:** Bug
**File:** `apps/cli/src/commands/ticket.ts:362-408`
**Proof:**
```ts
.description('Assign a ticket — self-assigns the caller; pass --to or --agent to express intent, but the runtime API does not currently support caller-supplied assignment targets (see KODA-16).')
.option('--to <agent-slug>', 'Intended target agent slug — currently accepted as no-op info only; the runtime API self-assigns the caller.')
.option('--agent <agent-slug>', 'Deprecated alias for --to (kept for back-compat; ignored at runtime).')
// line 395:
const response = await ticketsControllerAssign({ slug: ctx.projectSlug, ref });  // no body
```
The CLI now prints a warning when `--to`/`--agent` is set instead of silently swallowing, but the runtime API (see `BUG-2`) doesn't accept the assignment target either, so the call resolves to a self-assignment.

**Risk:** Users who read `--to` and follow up with `koda ticket show` see the caller listed and waste time troubleshooting.

**Fix:** Implement caller-supplied target via the new `AssignTicketDto` path proposed in `BUG-2`. The web app already sends `{ userId }` (`[ref].vue:247`), so the schema side is proven; the missing piece is server-side acceptance + CASL check + existence check.

---

#### BUG-11: `recentCommitHashes` map is bounded only by the dedup window (no hard cap)
**Severity:** LOW | **Category:** Memory / Resource
**File:** `apps/api/src/vcs/vcs-webhook.service.ts:78-108`
**Proof:**
```ts
private readonly recentCommitHashes = new Map<string, number>();
private readonly dedupWindowMs = 5 * 60 * 1000;
private readonly cleanupInterval: ReturnType<typeof setInterval>;

constructor(...) {
  this.cleanupInterval = setInterval(() => {
    this.cleanupStaleEntries();
  }, this.dedupWindowMs);
}
private cleanupStaleEntries(now = Date.now()): void {
  for (const [key, timestamp] of this.recentCommitHashes) {
    if (now - timestamp > this.dedupWindowMs) {
      this.recentCommitHashes.delete(key);
    }
  }
}
```
**Risk:** Cleanup cadence equals the window length. At 1 push/sec × 10 commits, that's ~3000 entries; ~5 minutes of memory at peak. Acceptable today. **Invariant** (cadence ≥ window) is enforced by hand — a future PR that raises `dedupWindowMs` without raising the cleanup interval could grow the map unboundedly. Cross-instance dedup is already handled by the DB query (`vcs-webhook.service.ts:573-590`), so the in-memory map is the fallback path only.

**Fix:** Add a hard size cap (e.g. `MAX_DEDUP_ENTRIES = 10_000`) with FIFO eviction. Document the invariant.

---

#### BUG-12: KODA-11 — Login is timing-enumerable (no dummy bcrypt compare)
**Severity:** LOW | **Category:** Security
**File:** `apps/api/src/auth/auth.service.ts:57-66`
**Proof:**
```ts
const user = await this.authRepo.findUserByEmail(email);
if (!user) {
  throw new AuthException({}, 'auth');
}
const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
```
**Risk:** Unregistered email → ~1ms error; registered email → ~250ms (bcrypt cost 12). Response timing reveals registered addresses (enumeration).

**Fix:** When `!user`, hash a fixed dummy password and call `bcrypt.compare` against it to consume the same CPU.

---

#### BUG-13: KODA-15 — `/pulls/pending` placeholder link persists when PR creation fails
**Severity:** LOW | **Category:** Bug
**File:** `apps/api/src/tickets/state-machine/ticket-transitions.service.ts:177-219`
**Proof:**
```ts
return repo.createTicketLink({
  ticketId,
  url: `https://github.com/${connection.repoOwner}/${connection.repoName}/pulls/pending`,
  provider: 'github',
  externalRef: `${connection.repoOwner}/${connection.repoName}#pending`,
  linkType: 'pr',
}).then((link): Promise<void> => {
  return provider.createPullRequest({ ... })  // can throw
    .then((pr): Promise<void> => {
      return repo.updateTicketLink(link.id, { url: pr.url, ... });
    });
}).catch((err) => {
  this.logger.warn(
    `[vcs] Failed to create PR for ticket ${projectKey}-${ticket.number}: ${err instanceof Error ? err.message : String(err)}`,
  );
  return Promise.resolve();  // ⚠ swallows failure, does NOT delete the placeholder link
});
```
**Risk:** Future webhook (`vcs sync-pr`) tries `findTicketLinkByPrNumber` (`prisma-vcs.repository.ts:243-264`) which filters `prNumber: { not: null }` — the placeholder has `prNumber: null`, so it's silently ignored from PR sync. The `/pulls/pending` URL still appears in the ticket UI as a dead link.

**Fix:** Create the PR first; on success persist the real `TicketLink`. On failure, write no link.

---

#### BUG-14: KODA-17 — `GITHUB_API_URL` validated but unused; GitLab URL parser missing subgroups
**Severity:** LOW | **Category:** Bug / Config
**File:** `apps/api/src/vcs/providers/github.provider.ts:108, 146, 162, 181, 194, 206, 228, 255, 275, 291`; `apps/api/src/vcs/factory.ts:107-122`; `apps/api/src/config/env.validation.ts:21`
**Proof:**
```ts
// github.provider.ts:108
const url = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/issues`;
// factory.ts:107-122
if (providerType.toLowerCase() === 'gitlab') {
  const urlMatch = config.repoUrl?.match(/gitlab\.com\/([^/]+)\/([^/]+)/) || [];
  // ⚠ doesn't handle subgroups like gitlab.com/group/sub/repo
```
**Verification:** `grep -rn 'githubApiUrl' apps/api/src` shows config wired up but no consumer — every GitHub API call is hardcoded `https://api.github.com`.

**Risk:** GHES (GitHub Enterprise Server) installs cannot use this app despite the env validation. GitLab subgroups produce an empty regex match → 422.

**Fix:** Pass `vcsConfig.githubApiUrl` into `GitHubProvider`. Make the GitLab regex `/gitlab\.com\/(.+)\/([^/]+)/` (capture everything up to the last segment).

---

#### BUG-15: KODA-18 — STATUS_CHANGE webhook reports `ref` as the DB id
**Severity:** LOW | **Category:** Bug / API contract
**File:** `apps/api/src/tickets/state-machine/ticket-transitions.service.ts:88`
**Proof:**
```ts
dispatcher.dispatch(projectId, 'STATUS_CHANGE', {
  event: 'STATUS_CHANGE',
  timestamp: new Date().toISOString(),
  ticket: { id: ticket.id, ref: ticket.id, status: toStatus },  // ⚠ ref = CUID, not KODA-42
  from: fromStatus,
  to: toStatus,
});
```
**Risk:** Webhook consumers see `ref` as a CUID instead of `${project.key}-${ticket.number}`. Inconsistent with the human-readable scheme used everywhere else.

**Fix:** Pass `ref: \`${project.key}-${ticket.number}\`` (requires passing `project.key` to `dispatchStatusChangeWebhook`, currently only `projectId` is passed).

---

#### ENH-2: `apps/web/pages/[project]/timeline.vue:44` uses `toLocaleString()` without locale arg
**Severity:** LOW | **Category:** Bug (SSR hydration)
**File:** `apps/web/pages/[project]/timeline.vue:43-45`
**Proof:**
```ts
function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleString()
}
```
**Risk:** SSR renders in the server locale; client re-renders in the user's locale → hydration mismatch warning + subtle UI flicker. Compare `[ref].vue:160` and `kb.vue:74` which pass `locale.value`.

**Fix:** Pass `locale.value` and a fixed timezone.

---

#### ENH-3: `extractApiError` returns the *first* field error; empty-string entries are skipped (mild UX)
**Severity:** LOW | **Category:** UX
**File:** `apps/web/composables/useApi.ts:29-36`
**Proof:**
```ts
get firstError(): string {
  if (this.errors) {
    const firstField = Object.values(this.errors)[0]
    if (firstField?.[0]) return firstField[0]
  }
  return this.message
}
```
**Risk:** Server returns `{ errors: { name: [''] } }` (empty string in array) → falls through to top-level `message`. Not a security issue, but operators get inconsistent UX.

**Fix:** Treat empty-string entries as missing and skip to the next field.

---

### 📋 @design (intentional)

#### STYLE-1 (corrected): `as any` and `.message` reassignment actually occur in only 3+3 files
**Severity:** LOW | **Category:** Type safety / @design
**Verification:** Replaced the speculative 6+ file list from the first pass with a verified list:
- `apps/api/src/auth/auth.controller.ts:85` — `(user as any).id` (covered by `BUG-1`)
- `apps/api/src/auth/auth.service.ts:98` — `(payload as any).id` (covered by `BUG-1`)
- `apps/api/src/tickets/tickets.service.ts:162` — `const raw = tickets[i] as any;` (cosmetic cast for the `gitRefUrl` enrichment loop)
- `apps/api/src/rag/vector-store.service.ts:170, 184, 193` — `exception.message = '...'` overrides (works at runtime but `ForbiddenAppException` extends `AppException` which constructs the message via `args, prefix` — these overrides effectively swap the human-readable label)
- `apps/api/src/tickets/tickets.controller.ts:158, 161, 164, 176, 184, 191, 235` — `eslint-disable-next-line @typescript-eslint/no-explicit-any` comments paired with `Record<string, any>` in the `assign` query-parser (covered by `BUG-2`)
- `apps/api/src/labels/labels.service.ts` and `apps/api/src/vcs/vcs-webhook.controller.ts` — first-pass list was wrong; no `as any` in either.

**Fix:**
1. Replace `(payload as any).id` with proper principal typing (covered by `BUG-1`).
2. Replace `exception.message = ...` with a derived `ProjectIdValidationException extends ForbiddenAppException` carrying the message via constructor arg.
3. Add `AssignTicketDto` (covered by `BUG-2`).

---

## Findings Removed / Softened in Pass 2

| First-pass ID | Original claim | Pass-2 verdict | Reason |
|:--------------|:---------------|:--------------|:-------|
| BUG-9 | "Outbox retries forever, only manual DB intervention stops it" | **REMOVED** | Outbox does have full retry+DLQ+admin endpoint: `prisma-outbox.repository.ts:118-132` (`markFailed` with backoff via `OUTBOX_BACKOFF_MS`), `markDeadLetter` (line 134-143), `AdminController` at `apps/api/src/outbox/admin.controller.ts:16-25` filtering by status. Failed events transition `pending → processing → pending (retry) → dead_letter` automatically. |
| BUG-3 scope | "Missing index on Project, Ticket, Label, VcsConnection, Webhook" | **CORRECTED** | Only `Project` and `Ticket` have the `deletedAt` column without an index. Label, Webhook, VcsConnection, TicketLink have no `deletedAt` column at all. MemoryItem already has the index. |
| BUG-5 severity | "MEDIUM" | **DOWNGRADED to LOW** | Verified that `extractIssueNumber`/`extractPrNumber` are used only in template interpolation, not in filter predicates. Empty result → blank interpolation string. No filter impact. |
| BUG-1 severity | "HIGH" | **DOWNGRADED to MEDIUM** | Runtime works correctly because `principal.id = jwt.sub` (refresh strategy explicitly copies). The `as any` is a code smell, not a bug. |
| SEC-1 severity/claim | "no replay protection at all" | **RE-FRAMED** | VCS push has dedup; VCS issues has dedup via `externalVcsId`. Real gap: VCS pull_request + CI webhook have no dedup; no delivery-ID tracking; no timestamp window. Severity stays HIGH but the description is now accurate. |
| STYLE-1 scope | "6+ files with as any" | **CORRECTED** | Verified 3 files with `as any`: auth.controller.ts:85, auth.service.ts:98, tickets.service.ts:162. The first-pass list also cited files with `eslint-disable-next-line` comments but no actual `as any` — those are different concerns. |

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---------|:---|:-------|:------------|
| P0 | SEC-1 | M | Delivery-ID dedup on CI + VCS pull_request; timestamp window on all inbound webhooks |
| P0 | BUG-2 | M | `AssignTicketDto` + `@RequiredPermission` + existence check + project membership check on `POST /:ref/assign` |
| P1 | SEC-2 | S | `chmodSync(0o600)` on CLI config writes |
| P1 | BUG-3 | S | Migration adding `@@index([deletedAt])` on Project and Ticket |
| P1 | BUG-4 | M | Extract `LanceTableManager` from `VectorStore`; have `HybridRetrieverService` consume it |
| P1 | SEC-3 | S | Targeted `@Throttle` on `/agents` admin routes |
| P2 | BUG-1 | S | Type `user: UserPrincipal` (drop `as any`) in auth.controller.ts:85 and auth.service.ts:98 |
| P2 | BUG-7 | M | `withContext` helper across all CLI commands |
| P2 | BUG-8 | S | Make `RegisterDto.name` required, or randomize fallback |
| P2 | ENH-1 | S | Delete `VcsIntegrationForm.vue` + its now-dead test |
| P3 | BUG-10 → BUG-15 | XS–S | Prior LOW backlog (login timing, pending link, GHES, ref=id, hydration mismatch) |
| P3 | ENH-2 / ENH-3 / STYLE-1 | XS | Small UX and type-safety polish |

---

## Verification Commands (for the next pass)

```bash
# Type / lint / unit / integration
bun run lint
bun run type-check
bun run test             # unit only (no DB)
bun run test:integration # requires sqlite + ephemeral DB

# Manual security checks
grep -rn "as any" apps/api/src | wc -l                      # target: 0
grep -rn "console.log\|console.error" apps/api/src          # target: 0
grep -rn "chmodSync" apps/cli/src                          # target: ≥ 1 (login)
grep -rn "@@index.*deletedAt" apps/api/prisma/schema.prisma  # target: Project + Ticket
grep -rn "v-html" apps/web --include='*.vue'                # target: only markdown (sanitized)
grep -rn "@RequiredPermission" apps/api/src/tickets/tickets.controller.ts:225-250  # target: 1 (assign)
```

---

## Revision Notes (delta vs pass 1)

| Change | Section |
|:-------|:--------|
| Score: Security 17→16 | Overall grade — added SEC-1 reframe and BUG-2 re-classification |
| BUG-1: HIGH → MEDIUM | Runtime verified to work; type smell only |
| BUG-2: MEDIUM → HIGH | Verified no `@RequiredPermission` exists on the assign route — any authenticated user can call it |
| BUG-3: scope narrowed | Label/Webhook/VcsConnection/TicketLink don't have `deletedAt` columns; only Project and Ticket need indexes |
| BUG-5: MEDIUM → LOW | Verified extractors are used only in template interpolation, not in filters |
| BUG-9: REMOVED | Outbox has full retry+DLQ+admin machinery; prior claim was wrong |
| SEC-1: re-framed | VCS push and VCS issues DO have dedup; gap is pull_request + CI + no delivery ID tracking |
| STYLE-1: scope narrowed | 3 files have `as any`, not 6+ |
| KODA-16 (prior review): escalated to HIGH | Re-classified as BUG-2 (no permission check at all is worse than just "no DTO") |

---

## Notes on Methodology

- Prior review (`20260906-review-whole-repo.md`) re-verified by grepping for the exact patterns cited.
- New findings: every proof snippet was taken from the file at the cited line numbers as observed during the review; line numbers are stable for HEAD at the time of writing.
- Findings classified by `file:line` per repo convention; each has a one-line repro and a one-line fix.
- Pass 2 corrections: removed BUG-9 (factually wrong), corrected BUG-3/BUG-5/STYLE-1 scope, re-classified BUG-2 HIGH, re-framed SEC-1 to reflect actual dedup coverage.
- The check_index_coverage report flags 17 `parse_partial` files (SQL migrations and `Dockerfile` lines) — these don't contain code under review, only schema. No action needed.