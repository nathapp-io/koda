# Whole-Repo Code Review: koda (api + web + cli)

**Date:** 2026-09-06
**Reviewer:** Subrina (AI)
**Version:** HEAD `74de0033`
**Files:** ~382 non-generated source files (api: 240 TS ~22.4k LOC, 135 spec files; web: ~115 source files ~7,500 LOC; cli: 27 hand-written files ~4.5k LOC)
**Baseline:** Not executed (review-only run; test suite not run)

---

## Overall Grade: C+ (70/100)

| Dimension | Score | Notes |
|:---|:---|:---|
| Security | 8/20 | 2 CRITICAL (missing route authorization cluster including repo-token exposure; stored XSS via `v-html`) plus several HIGH/MEDIUM authorization gaps; token/crypto hygiene elsewhere is excellent |
| Reliability | 14/20 | Signature verification over re-serialized JSON, permanent "pending" link artifacts, hydration mismatches, broken CLI contract in `vcs` commands |
| API Design | 13/20 | Strong DTO/repository typing in api, but authorization is inconsistently applied across controllers; envelope contract leaks into clients |
| Code Quality | 14/20 | Near-zero TODO/FIXME debt, adversarial test culture, DI seams — offset by 6 oversized files, ~200-line duplicated VCS form, 16× duplicated CLI boilerplate |
| Best Practices | 14/20 | Framework conventions largely followed (keyed `useAsyncData`, throttling, outbox pattern, refresh-token revocation); fixtures-in-production-service and dead code are the outliers |

**Summary:** The codebase shows strong engineering discipline in secrets handling, HMAC API keys, refresh-token revocation, soft deletes, outbox processing, SSR-safe data fetching, and i18n parity. The grade is dragged down by a **cluster of missing authorization checks** on less-trafficked controllers (VCS, ticket-links, timeline, memory, and RAG KB writes) that expose repository configuration and cross-project data to authenticated callers, a **stored XSS** in ticket rendering, and a **CLI `vcs` module whose response handling is broken against the runtime API envelope**. These are bounded fixes, but they need controller-level regression tests.

---

## Findings

Severity legend: 🔴 CRITICAL · 🟠 HIGH · 🟡 MEDIUM · 🟢 LOW

### 🔴 CRITICAL

#### KODA-01: VCS connection routes have zero authorization (any principal can manage any project's repo tokens)
- **Severity:** CRITICAL | **Category:** SEC
- **File:** `apps/api/src/vcs/vcs.controller.ts:55-283`
- **Proof:**
  ```ts
  @Post()
  @ApiOperation({ summary: 'Create a VCS connection for a project' })
  @HttpCode(HttpStatus.CREATED)
  async createConnection(
    @Param('slug') slug: string,
    @Body() dto: CreateVcsConnectionDto,
    @Principal('userId') userId?: string,
  ): Promise<VcsConnectionResponseDto> {
    const project = await this.projectsService.findBySlug(slug);
    return this.vcsService.create(project.id, encryptionKey, dto);
  ```
- **Risk:** No `@RequiredPermission` and no `assertProjectMembership` anywhere in this controller (compare: projects/tickets/code-intel all have both). Any authenticated user or agent API key can create/update/delete VCS connections (which hold repo tokens), read the `webhookSecret`, and trigger full syncs for every project.
- **Fix:** Add `@RequiredPermission('ADMIN')` (or CASL subject) + `assertProjectMembership(project.id, principal)` on every route, matching the `VcsController` spec tests.

#### WEB-01: Stored XSS — `marked()` output rendered via `v-html` with no sanitizer
- **Severity:** CRITICAL | **Category:** SEC
- **File:** `apps/web/pages/[project]/tickets/[ref].vue:441` (and `apps/web/components/MarkdownEditor.vue:50`)
- **Proof:**
  ```ts
  // [ref].vue:118-125
  const renderedDescription = computed(() => {
    if (!ticket.value?.description) return ''
    try {
      return marked(ticket.value.description)
  // [ref].vue:438-442
  <p v-else class="whitespace-pre-wrap text-sm" v-html="renderedDescription" />
  ```
  `marked` (v17) does not sanitize HTML by default; no `DOMPurify`/`sanitize-html` anywhere in the app. MarkdownEditor preview panel has the identical `v-html="renderedHtml"` sink.
- **Risk:** Any ticket description (including ones synced/imported from GitHub issues or posted by agents) can execute arbitrary JS in viewers' browsers.
- **Fix:** Sanitize with DOMPurify (server-safe for SSR) before `v-html`, or render markdown to a restricted renderer.

### 🟠 HIGH

#### KODA-02: Webhook/signature verification runs over `JSON.stringify(payload)` instead of the raw request body
- **Severity:** HIGH | **Category:** BUG
- **File:** `apps/api/src/vcs/vcs-webhook.controller.ts:37-41` (same pattern `apps/api/src/ci-webhook/ci-webhook.controller.ts:32`)
- **Proof:**
  ```ts
  const isValid = this.webhookService.verifySignature(
    JSON.stringify(payload),
    signature || '',
    connection.webhookSecret,
  );
  ```
- **Risk:** GitHub HMACs the raw bytes. After Fastify parses the payload, `JSON.stringify` need not reproduce those bytes, so legitimate webhooks can be rejected as 401; re-serialization also weakens the verification guarantee.
- **Fix:** Enable Fastify `rawBody` and verify the HMAC against `request.rawBody`.

#### KODA-03: `PATCH /projects/:slug` missing `@RequiredPermission('ADMIN')` despite admin-only doc
- **Severity:** HIGH | **Category:** SEC
- **File:** `apps/api/src/projects/projects.controller.ts:73-87`
- **Proof:**
  ```ts
  @Patch(':slug')
  @ApiOperation({ summary: 'Update a project (admin only)' })
  ...
  async update(@Param('slug') slug: string, @Body() updateProjectDto: UpdateProjectDto) {
  ```
- **Risk:** `create` (line 44) and `remove` (line 91) have `@RequiredPermission('ADMIN')`; update does not. Any authenticated principal can rename/re-key any project.
- **Fix:** Add `@RequiredPermission('ADMIN')` to `update`.

#### KODA-04: RAG KB `addDocument`/`listDocuments` skip the membership check that `search` performs
- **Severity:** HIGH | **Category:** SEC
- **File:** `apps/api/src/rag/rag.controller.ts:76-114`
- **Proof:**
  ```ts
  async addDocument(@Param('slug') slug: string, @Body() dto: AddDocumentDto) {
    const project = await this.resolveProject(slug);
    await Promise.all([ this.ragService.indexDocument(project.id, { ... }),
  ```
- **Risk:** `search` (line 145) and `importGraphify` (line 182) call `checkProjectMembership`, but `addDocument` and `listDocuments` do not — any authenticated principal can poison/read any project's knowledge base.
- **Fix:** Call `checkProjectMembership(project.id, principal)` in `addDocument` and `listDocuments`.

#### WEB-02: Auth token in XSS-readable cookie; logout never revokes; refresh token discarded
- **Severity:** HIGH | **Category:** SEC
- **File:** `apps/web/composables/useAuth.ts:43` (also :18-22, :68-72)
- **Proof:**
  ```ts
  const token = useCookie('koda_token', { secure: true, sameSite: 'strict', maxAge: 604800 })
  async function logout(): Promise<void> {
    token.value = null
    user.value = null
    await navigateTo('/login')
  }
  ```
  `httpOnly` is absent (token readable by JS — directly weaponizes WEB-01). The API exposes `POST /auth/logout` and `POST /auth/refresh` (`apps/api/src/auth/auth.controller.ts:63,77`) but the web app calls neither; `AuthResponse.refreshToken` is discarded on every login/register.
- **Risk:** XSS exposes the access token to JavaScript. The default access-token lifetime is 15 minutes, but the web app neither sends the refresh token nor invokes the server logout endpoint, so it cannot provide a normal refresh or revocation flow.
- **Fix:** Call `/auth/logout` on logout, implement `/auth/refresh`, and move token storage server-side (httpOnly cookie set by a Nuxt server route).

#### CLI-01: VCS commands bypass the envelope unwrap — broken against the runtime API contract
- **Severity:** HIGH | **Category:** BUG
- **File:** `apps/cli/src/commands/vcs.ts:293, 338, 386, 426` (also 101, 145)
- **Proof:**
  ```ts
  const result = await vcsControllerTestConnection({ slug: ctx.projectSlug });
  if (result.ok) {                       // undefined → always "Connection test failed"
  console.log(`Sync complete: created ${result.issuesSynced}, skipped ${result.issuesSkipped}`); // "created undefined"
  ```
  The API wraps responses in the `{ret, data}` envelope at runtime; `vcs test/sync/sync-pr/import` read DTO fields directly off the raw body. `vcs connect`/`status` hand-roll `response.data || response` instead of `unwrap`. Test mocks codify both shapes (`vcs-update-test-sync-import.spec.ts:297` vs `vcs.spec.ts:124-127`).
- **Risk:** `vcs test` always reports failure; `vcs sync/sync-pr/import` print `undefined`; non-zero `ret` envelopes silently treated as success.
- **Fix:** Route all vcs responses through `unwrap()` from `utils/api.ts` and fix the mock shapes.

### 🟡 MEDIUM

#### KODA-06: Ticket link routes have no permission or membership checks
- **Severity:** MEDIUM | **Category:** SEC
- **File:** `apps/api/src/ticket-links/ticket-links.controller.ts:32-72`
- **Proof:**
  ```ts
  @Post()
  @ApiOperation({ summary: 'Create or return existing link for a ticket' })
  async create(@Param('slug') slug: string, @Param('ref') ref: string, @Body() dto: CreateTicketLinkDto) {
    const result = await this.ticketLinksService.create(slug, ref, dto);
  ```
- **Risk:** Any authenticated principal can create/delete PR links on any project's tickets (`DELETE :linkId` also unguarded).
- **Fix:** Add `@RequiredPermission` + project membership check mirroring `TicketsController`.

#### KODA-07: Timeline endpoint exposes all project activity without membership check
- **Severity:** MEDIUM | **Category:** SEC
- **File:** `apps/api/src/memory/timeline.controller.ts:46-60`
- **Proof:**
  ```ts
  @Get()
  @ApiOperation({ summary: 'Get a project timeline' })
  async getTimeline(@Param('slug') slug: string, @Query('actorId') actorId?: string, ...) {
    const project = await this.resolveProject(slug);
  ```
- **Risk:** Any authenticated principal can enumerate any project's full event timeline (actor IDs, decisions).
- **Fix:** Add `assertProjectMembership(project.id, principal)` (optionally filter `actorId` to self for non-admins).

#### KODA-08: Memory writes accept caller-supplied `projectId` with only global role check
- **Severity:** MEDIUM | **Category:** SEC
- **File:** `apps/api/src/memory/memory.controller.ts:97-113`
- **Proof:**
  ```ts
  async createMemory(@Body() input: CreateMemoryDto, @Principal() principal: KodaPrincipal) {
    const role = principalRole(principal);
    if (!role || !MEMORY_WRITE_ROLES.includes(role)) { throw ... }
    const memory = await this.repository.upsert({ projectId: input.projectId,
  ```
- **Risk:** Global role check passes, but no per-project membership check — a member of project A can write memory items attributed to project B.
- **Fix:** Validate `input.projectId` membership before `upsert`.

#### KODA-09: `webhookSecret` returned in connection API responses
- **Severity:** MEDIUM | **Category:** SEC
- **File:** `apps/api/src/vcs/vcs-connection.service.ts:238-253`
- **Proof:**
  ```ts
  private mapToResponseDto(connection: VcsConnectionDomain): VcsConnectionResponseDto {
    return { id: connection.id, ..., webhookSecret: connection.webhookSecret,
  ```
- **Risk:** Any caller of `GET /projects/:slug/vcs` (any authenticated principal today — see KODA-01) receives the secret used to authenticate inbound GitHub webhooks → forged issue/PR/push events.
- **Fix:** Omit `webhookSecret` from response DTOs (return `webhookSecretConfigured: true/false`).

#### KODA-10: First-user bootstrap role assignment has a race
- **Severity:** MEDIUM | **Category:** BUG
- **File:** `apps/api/src/auth/auth.service.ts:35-43`
- **Proof:**
  ```ts
  const anyUser = await this.authRepo.findAnyUser();
  const role = anyUser === null ? 'ADMIN' : undefined;
  const user = await this.authRepo.createUser({ email, name, passwordHash, ...(role ? { role } : {}) });
  ```
- **Risk:** The check-then-act sequence is outside a transaction, so concurrent registrations against an empty database can both receive `ADMIN`. Registration is public (but controller-throttled at 5/min), so the initial bootstrap behavior needs an explicit concurrency-safe design.
- **Fix:** Wrap the check+create in a transaction (or use a unique-constraint bootstrap token / invite flow).

#### KODA-12: `preParsing` hook buffers the entire JSON body in memory with no size cap
- **Severity:** MEDIUM | **Category:** MEM
- **File:** `apps/api/src/main.ts:24-31`
- **Proof:**
  ```ts
  const chunks: Buffer[] = [];
  for await (const chunk of payload) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  ```
- **Risk:** The hook drains the full stream into memory before Fastify's JSON parser (and its `bodyLimit`) sees it — a client streaming a multi-GB `application/json` body can exhaust memory.
- **Fix:** Enforce a max-size cap inside the hook (destroy the stream when `chunks` exceeds the limit).

#### KODA-14: `HybridRetrieverService` duplicates `VectorStore` minus its safety mechanisms
- **Severity:** MEDIUM | **Category:** ENH
- **File:** `apps/api/src/rag/hybrid-retriever.service.ts:144-230` (cf. `apps/api/src/rag/vector-store.service.ts:222-266, 333-356`)
- **Proof:**
  ```ts
  async indexDocument(projectId: string, doc: {...}): Promise<void> {
    const table = await this.getOrCreateTable(projectId);   // no validateProjectId, no creation lock
    await table.add([record]);                              // no runExclusive write lock
  ```
- **Risk:** `VectorStore` implements per-project table-creation locks and serialized writes plus `validateProjectId`; the near-identical `HybridRetrieverService` copy has none of these, yet `RagController.addDocument` writes to both stores.
- **Fix:** Extract the shared LanceDB table/write machinery into one service (~150 duplicated lines removed).

#### WEB-03: Unsanitized attacker-influenced URLs bound to `href`
- **Severity:** MEDIUM | **Category:** SEC
- **File:** `apps/web/pages/[project]/tickets/[ref].vue:409,470,487,503,624`
- **Proof:**
  ```html
  <a :href="link.url" target="_blank" rel="noopener noreferrer" class="truncate text-blue-500 hover:underline">
  ```
- **Risk:** A project member (or API importer) storing `javascript:alert(1)` as a link URL gets a stored XSS on click; Vue does not block `javascript:` in `:href`.
- **Fix:** Validate URLs on entry and/or allowlist `http(s):` schemes before binding (also for `ticket.gitRefUrl`, `ticket.externalVcsUrl`).

#### WEB-04: Agent slug auto-derive breaks after first programmatic set
- **Severity:** MEDIUM | **Category:** BUG
- **File:** `apps/web/components/CreateAgentDialog.vue:182-191`
- **Proof:**
  ```ts
  watch(() => values.name, (name) => {
    if (name !== undefined && !isSlugManuallyEdited.value) {
      setFieldValue('slug', deriveSlug(name))
    }
  })
  watch(() => values.slug, () => { isSlugManuallyEdited.value = true })
  ```
  The slug watcher can't distinguish user edits from the programmatic `setFieldValue`, so `isSlugManuallyEdited` flips after the *first* auto-derivation.
- **Risk:** Submitted slug only reflects the first keystroke, causing avoidable slug collisions/failures.
- **Fix:** Set the flag only in the input's own `onChange`, or diff against `deriveSlug(values.name)`.

#### WEB-05: `z.number()` schema against a text input — polling interval always fails validation
- **Severity:** MEDIUM | **Category:** BUG
- **File:** `apps/web/pages/[project]/settings.vue:125` (input at :372-376)
- **Proof:**
  ```ts
  pollingInterval: z.number().min(60000, ...).max(86400000, ...).optional(),
  <Input data-testid="pollingInterval" ... v-bind="componentField" type="number" />
  ```
  Shadcn `Input` emits a *string*; `z.number()` rejects strings. `ImportIssueDialog.vue:56-59` correctly uses `z.coerce.number()` for the same situation. The payload also sends a string `pollingIntervalMs` (settings.vue:171).
- **Risk:** Users editing the polling interval hit a permanent validation error (or send a string to the API).
- **Fix:** Use `z.coerce.number()` and `Number()` in the payload, mirroring `ImportIssueDialog`.

#### WEB-06: `VcsIntegrationForm.vue` is dead code; `settings.vue` re-implements it inline (~200 duplicated lines)
- **Severity:** MEDIUM | **Category:** ENH
- **File:** `apps/web/components/VcsIntegrationForm.vue:1-263` vs `apps/web/pages/[project]/settings.vue:313-427`
- **Proof:** Only references to `VcsIntegrationForm` outside itself are in `tests/components/vcs-integration-form.spec.ts`. `settings.vue` contains a byte-for-byte-similar copy of the same form (e.g. settings.vue:158-188 ≈ VcsIntegrationForm.vue:194-224).
- **Risk:** Fixes to VCS form behavior (e.g. WEB-05) get applied to one copy only.
- **Fix:** Delete `VcsIntegrationForm.vue` (or extract it back into `settings.vue`).

#### WEB-07: `toLocaleDateString()` without locale → hydration mismatch + non-localized dates
- **Severity:** MEDIUM | **Category:** BUG
- **File:** `apps/web/pages/[project]/kb.vue:71-73` (SSR'd via `useAsyncData`); same pattern `apps/web/components/KbResultCard.vue:37`
- **Proof:**
  ```ts
  function formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleDateString()
  }
  ```
- **Risk:** Server renders en-US; a zh-CN browser re-renders with its own locale → hydration text mismatch; ignores the app's active i18n locale (contrast `[ref].vue:158-164`, which correctly passes `locale.value`).
- **Fix:** Pass `locale.value` (and a fixed timezone if precision matters) to `toLocaleDateString`.

#### CLI-02: `resolveAuth` violates the documented config precedence (skips project config and profiles)
- **Severity:** MEDIUM | **Category:** BUG
- **File:** `apps/cli/src/utils/auth.ts:14-20` (used by vcs.ts, project.ts, init.ts)
- **Proof:**
  ```ts
  const apiKey = options.apiKey || process.env.KODA_API_KEY || config.apiKey || '';
  const apiUrl = options.apiUrl || process.env.KODA_API_URL || config.apiUrl || 'http://localhost:3100/api';
  ```
  Documented precedence is flags → env → local `.koda/config.json` → profile → global. `resolveContext` (config.ts:131-146) implements it; `resolveAuth` does not. Default URL also differs (`:3100/api` vs `:3100`).
- **Risk:** Users with per-project `apiKey`/profile get 401s from `vcs`/`project` commands that work with `ticket` commands.
- **Fix:** Delete `resolveAuth` and use `resolveContext` everywhere.

#### CLI-03: API key persisted to `~/.koda/config.json` with default file permissions
- **Severity:** MEDIUM | **Category:** SEC
- **File:** `apps/cli/src/config.ts:21-25`
- **Proof:**
  ```ts
  const store = new Conf({
    cwd: join(homedir(), '.koda'),
    configName: 'config',
    schema,
  });
  ```
  `setConfig` writes the raw API key; no chmod/mode hardening anywhere (0 hits for `chmod` in src). File created with umask default (typically 0644, group/world-readable).
- **Risk:** Long-lived API credentials readable by other local users.
- **Fix:** `fs.chmodSync(store.path, 0o600)` after writes in `setConfig`/`setProfile`/`loginCommand`.

#### CLI-04: `ticket assign` silently ignores `--agent` / `--to` flags
- **Severity:** MEDIUM | **Category:** BUG
- **File:** `apps/cli/src/commands/ticket.ts:366-367, 384`
- **Proof:**
  ```ts
  .option('--agent <agent-slug>', 'Agent to assign to')
  .option('--to <agent-slug>', 'Agent to assign to (omit for self-assign)')
  const response = await ticketsControllerAssign({ slug: ctx.projectSlug, ref });
  ```
  Neither option is read; the call takes no body.
- **Risk:** `koda ticket assign T-1 --to alice` self-assigns with a success message.
- **Fix:** Pass the target if the API supports it, or remove the dead options and hard-fail if provided.

#### CLI-05: `login` masks every failure as "Invalid API key"
- **Severity:** MEDIUM | **Category:** BUG
- **File:** `apps/cli/src/commands/login.ts:25-29`
- **Proof:**
  ```ts
  try {
    await agentsControllerFindMe();
  } catch {
    throw new Error('Invalid API key');
  }
  ```
- **Risk:** Network outage, DNS failure, or 5xx all surface as "Invalid API key".
- **Fix:** Inspect `ApiError.status` — report "Invalid API key" only for 401/403, otherwise rethrow via `handleApiError`.

#### CLI-06: ~16× duplicated auth/context/OpenAPI boilerplate across every command action
- **Severity:** MEDIUM | **Category:** STYLE
- **File:** `apps/cli/src/commands/ticket.ts:74-99` (identical block repeated in ~40 actions across 11 command files)
- **Proof:**
  ```ts
  const ctx = await resolveContext({ projectSlug: options.project });
  if (!ctx.projectSlug) { handleApiError(new Error('Project not configured. Run: koda init'), { configError: true }); }
  if (!ctx.apiKey) { handleApiError(new Error('API key or URL not configured. ...'), { configError: true }); }
  OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
  OpenAPI.TOKEN = ctx.apiKey;
  ```
  ~8 lines × ~40 sites; drift already exists (`!ctx.apiKey` alone vs `!ctx.apiKey || !ctx.apiUrl`; `error()`+exit vs `handleApiError`). ticket.ts is 805 lines.
- **Risk:** Precedence/error-message fixes must be made in ~40 places (CLI-02 is exactly this drift).
- **Fix:** One `withContext({ projectSlug }, async (ctx) => {...})` helper handling checks + `OpenAPI` config.

### 🟢 LOW

#### KODA-11: Login is timing-enumerable (no dummy bcrypt compare for unknown emails)
- **Severity:** LOW | **Category:** SEC
- **File:** `apps/api/src/auth/auth.service.ts:58-67`
- **Proof:**
  ```ts
  const user = await this.authRepo.findUserByEmail(email);
  if (!user) {
    throw new AuthException({}, 'auth');
  }
  const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
  ```
- **Risk:** Unknown emails fail in ~1ms vs ~250ms for known emails (bcrypt cost 12) — response timing reveals registered addresses.
- **Fix:** Run `bcrypt.compare` against a fixed dummy hash when the user is missing.

#### KODA-15: Failed PR creation leaves permanent placeholder "pending" ticket link
- **Severity:** LOW | **Category:** BUG
- **File:** `apps/api/src/tickets/state-machine/ticket-transitions.service.ts:177-183`
- **Proof:**
  ```ts
  return repo.createTicketLink({
    ticketId,
    url: `https://github.com/${connection.repoOwner}/${connection.repoName}/pulls/pending`,
    externalRef: `${connection.repoOwner}/${connection.repoName}#pending`,
    linkType: 'pr',
  }).then((link) => provider.createPullRequest({ ... })
  ```
- **Risk:** Link is persisted before the PR exists; if `createPullRequest` fails (whole chain is `.catch → logger.warn`), the ticket keeps a fake `/pulls/pending` URL forever and never matches the webhook `findTicketLinkByPrNumber` path.
- **Fix:** Create the PR first, then persist the real link (or delete the placeholder in the catch).

#### KODA-16: `POST :ref/assign` has no permission check and unvalidated raw body (FK violations → 500)
- **Severity:** LOW | **Category:** BUG
- **File:** `apps/api/src/tickets/tickets.controller.ts:225-250`; `apps/api/src/tickets/tickets.service.ts:308-314`
- **Proof:**
  ```ts
  async assign(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    @Body() assignInput: Record<string, any>,
  ) {
  ```
- **Risk:** No DTO/`class-validator` and no `@RequiredPermission` — arbitrary `userId`/`agentId` strings go straight to Prisma `update`; nonexistent IDs surface as Prisma P2003 FK errors (500) instead of 400/404.
- **Fix:** Add an `AssignTicketDto` and a CASL check.

#### KODA-17: GitHub/GitLab hardcoding mismatches (dead `GITHUB_API_URL`, GitHub-only URL parser, unencoded path segments)
- **Severity:** LOW | **Category:** BUG
- **File:** `apps/api/src/vcs/providers/github.provider.ts:108`; `apps/api/src/vcs/vcs-connection.service.ts:265-271`; `apps/api/src/config/env.validation.ts:21`
- **Proof:**
  ```ts
  const url = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/issues`;
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  ```
- **Risk:** `GITHUB_API_URL` is validated but never read (GHES unsupported); `parseRepoUrl` rejects all GitLab URLs even though `GitLabProvider` exists; unvalidated regex captures are interpolated unencoded into API paths.
- **Fix:** Use the configured API URL, support GitLab URL parsing, `encodeURIComponent` owner/name.

#### KODA-18: STATUS_CHANGE webhook payload reports ticket `ref` as the DB id
- **Severity:** LOW | **Category:** BUG
- **File:** `apps/api/src/tickets/state-machine/ticket-transitions.service.ts:85-91`
- **Proof:**
  ```ts
  dispatcher.dispatch(projectId, 'STATUS_CHANGE', {
    event: 'STATUS_CHANGE',
    ticket: { id: ticket.id, ref: ticket.id, status: toStatus },
  ```
- **Risk:** Consumers receiving `ref` get a CUID instead of the human ref (`KEY-123`) used everywhere else.
- **Fix:** Pass project key + number, or drop `ref` from the payload.

#### KODA-19: Widespread `any` in public DTO/service signatures and unsafe casts in transition service
- **Severity:** LOW | **Category:** TYPE
- **File:** `apps/api/src/tickets/dto/ticket-response.dto.ts:80`, `apps/api/src/tickets/state-machine/ticket-transitions.service.ts:198,204`
- **Proof:**
  ```ts
  static from(ticket: any, projectKey?: string, gitRefUrl?: string | null): TicketResponseDto {
  return repo.updateTicketLink(link.id, { ... }) as unknown as Promise<void>;
  ```
- **Risk:** Repository row types are hand-modeled, but every `from()` mapper reverts to `any`; double-casts hide real async-shape bugs.
- **Fix:** Type `from()` against the repository row types already defined in `prisma-tickets.repository.ts`.

#### KODA-20: Six files exceed 400 lines; transition service re-fetches project/ticket redundantly
- **Severity:** LOW | **Category:** STYLE
- **File:** `apps/api/src/rag/vector-store.service.ts` (708), `apps/api/src/vcs/vcs-webhook.service.ts` (652), `apps/api/src/policy/policy-gate.service.ts` (597), `apps/api/src/rag/hybrid-retriever.service.ts` (524), `apps/api/src/entity-graph/entity-graph.service.ts` (514), `apps/api/src/tickets/state-machine/ticket-transitions.service.ts` (477); `apps/api/src/tickets/tickets.service.ts:217-241`
- **Proof:**
  ```ts
  const ticket = await this.findByRef(projectSlug, ref);   // findByRef internally re-resolves project
  const project = await this.ticketRepo.findProjectBySlug(projectSlug);  // 2nd/3rd fetch of same project
  ```
- **Risk:** `tickets.service.update/softDelete/assign` fetch the same project 2–3× per request; deep promise-chaining in `createPrForTicket` instead of `async/await`.
- **Fix:** Return the project from ref-resolution helpers; split >400-line services.

#### WEB-08: `navigateTo` in setup not awaited/returned
- **Severity:** LOW | **Category:** BUG
- **File:** `apps/web/pages/projects.vue:3`
- **Proof:**
  ```ts
  definePageMeta({ layout: 'default' })
  navigateTo('/', { redirectCode: 301 })
  ```
- **Risk:** `navigateTo` during setup must be awaited/returned; a bare statement may render the empty page before redirecting on some Nuxt versions; 301 is permanently cacheable.
- **Fix:** `await navigateTo('/', { redirectCode: 302 })` in async setup, or `routeRules: { '/projects': { redirect: '/' } }`.

#### WEB-09: SLO date window computed with `new Date()` in SSR setup → hydration mismatch
- **Severity:** LOW | **Category:** BUG
- **File:** `apps/web/pages/admin/slos.vue:47-55`
- **Proof:**
  ```ts
  function defaultWindow(): { from: string; to: string } {
    const now = new Date()
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  ```
- **Risk:** Server date can differ from client date (timezone/midnight); value rendered into date-input v-model attributes server-side.
- **Fix:** Initialize `from`/`to` as empty refs and set defaults in `onMounted`.

#### WEB-10: Hardcoded UI strings bypassing i18n
- **Severity:** LOW | **Category:** ENH
- **File:** `apps/web/components/MarkdownEditor.vue:36-37`; `apps/web/components/KbResultCard.vue:13-15`; `apps/web/components/ThemeSwitcher.vue`; `apps/web/pages/[project]/labels.vue:38`
- **Proof:**
  ```html
  <TabsTrigger value="write">Write</TabsTrigger>
  <TabsTrigger value="preview">Preview</TabsTrigger>
  ```
  ```ts
  name: z.string().min(1, 'Name is required'),   // labels.vue:38 — sibling messages use t()
  ```
- **Risk:** Chinese-locale users see English strings.
- **Fix:** Add `common.write/preview`, `kb.similarity.*`, `theme.*`, `labels.validation.nameRequired` keys to both locales.

#### WEB-11: Dead fallback pattern defeats i18n
- **Severity:** LOW | **Category:** STYLE
- **File:** `apps/web/pages/register.vue:82-84`
- **Proof:**
  ```ts
  name: z.string().min(1, t('auth.validation.nameRequired') || 'Name is required'),
  ```
  `t()` never returns falsy for an existing key (en/zh both have it — 405/405 key parity verified).
- **Risk:** Masked missing-key bugs; divergent hardcoded strings.
- **Fix:** Remove the `|| '...'` fallbacks.

#### WEB-12: `const ref` shadows Vue's `ref` import
- **Severity:** LOW | **Category:** STYLE
- **File:** `apps/web/pages/[project]/tickets/[ref].vue:52` (forcing `:3`)
- **Proof:**
  ```ts
  import { computed, reactive, ref as vueRef } from 'vue'
  const ref = route.params.ref as string
  ```
- **Risk:** Cognitive hazard in the app's largest file (664 lines).
- **Fix:** Rename to `ticketRef`.

#### WEB-13: Color helpers duplicated; `:class="[fallbackColor]"` is a no-op Tailwind class
- **Severity:** LOW | **Category:** ENH
- **File:** `apps/web/pages/[project]/labels.vue:10-13,151` (vs `apps/web/lib/utils.ts:26-34`)
- **Proof:**
  ```ts
  const fallbackColor = '#E5E7EB'
  <TableHead :class="[fallbackColor]">
  ```
  `lib/utils.ts` already exports `isValidColor` + `getSafeColor`; `:class="['#E5E7EB']"` emits a bogus class name.
- **Fix:** Import `getSafeColor` and drop the bogus `:class`.

#### WEB-14: Status/priority/type → CSS class mappers duplicated across 4 files
- **Severity:** LOW | **Category:** ENH
- **File:** `apps/web/pages/[project]/tickets/[ref].vue:127-156`; `apps/web/pages/agents.vue:88-92`; `apps/web/pages/[project]/agents.vue:26-30`; `apps/web/components/TicketCard.vue:34-50`
- **Proof:**
  ```ts
  function statusClass(status: string) {
    switch (status) {
      case 'VERIFIED': return 'bg-blue-100 text-blue-800'
  ```
- **Risk:** Palette changes must be applied in 4+ places; already slightly divergent (`bg-green-500` vs `bg-green-100`).
- **Fix:** Extract to `lib/ticketStyles.ts` keyed by the union types already declared.

#### WEB-15: Sync toast hardcodes `updated: 0`
- **Severity:** LOW | **Category:** BUG
- **File:** `apps/web/pages/[project]/settings.vue:211-215` (duplicated in dead VcsIntegrationForm.vue:249-253)
- **Proof:**
  ```ts
  toast.success(t('vcs.toast.syncComplete', {
    created: result.issuesSynced,
    updated: 0,          // always zero
  ```
- **Fix:** Use the actual update count from `SyncResult` (or extend the API response).

#### WEB-16: `nuxt.config.ts` cast disables config type safety
- **Severity:** LOW | **Category:** TYPE
- **File:** `apps/web/nuxt.config.ts:89`
- **Proof:**
  ```ts
  }) as unknown as Record<string, unknown>
  ```
- **Risk:** Invalid module options/config keys will not fail type-check.
- **Fix:** Use `satisfies` or cast the inline module function type instead of `as unknown as`.

#### WEB-17: Unhandled clipboard promise rejections
- **Severity:** LOW | **Category:** BUG
- **File:** `apps/web/components/CreateAgentDialog.vue:234-239`; `apps/web/components/RotateKeyDialog.vue:80-85`
- **Proof:**
  ```ts
  async function copyToClipboard() {
    if (!apiKey.value) return
    await navigator.clipboard.writeText(apiKey.value)
  ```
- **Risk:** Clipboard API throws on non-HTTPS/insecure contexts; rejection is unhandled, button never resets.
- **Fix:** Wrap in try/catch with fallback and error toast.

#### WEB-18: Generic catch swallows API error detail in KB dialogs/pages
- **Severity:** LOW | **Category:** ENH
- **File:** `apps/web/pages/[project]/kb.vue:42-44`; `apps/web/components/KbAddDocumentDialog.vue:41-43`
- **Proof:**
  ```ts
  catch {
    toast.error(t('kb.toast.searchFailed'))
  }
  ```
  Elsewhere the codebase consistently uses `extractApiError(err)` (kb.vue:90,107).
- **Fix:** `toast.error(extractApiError(err))` for consistency.

#### WEB-19: Global agent page and project agent page are ~80% copies
- **Severity:** LOW | **Category:** ENH
- **File:** `apps/web/pages/agents.vue:126-207` vs `apps/web/pages/[project]/agents.vue:50-117`
- **Proof:** Both render identical Table markup (name/slug/roles/capabilities/status columns, same `statusClass`, same Badge loops).
- **Fix:** Extract an `AgentTable.vue` component taking a data source prop.

#### WEB-20: `logout()` returns before navigation completes; header button double-clickable
- **Severity:** LOW | **Category:** ENH
- **File:** `apps/web/layouts/default.vue:174-180` (with `composables/useAuth.ts:68-72`)
- **Proof:**
  ```html
  <Button variant="ghost" size="sm" @click="auth.logout()">
  ```
- **Fix:** Add a `loggingOut` ref guarding the button; wire server logout per WEB-02.

#### CLI-07: Secrets passed as CLI flags (shell history / process-list exposure)
- **Severity:** LOW | **Category:** SEC
- **File:** `apps/cli/src/index.ts:78`, `apps/cli/src/commands/vcs.ts:52`, `apps/cli/src/commands/auth.ts:55`
- **Proof:**
  ```ts
  .requiredOption('--api-key <key>', 'API key for authentication')
  .option('--token <token>', 'API token for provider')
  .requiredOption('--password <password>', 'Password (min 8 chars, ...)')
  ```
- **Risk:** API keys, VCS tokens, and passwords land in shell history and `ps` output.
- **Fix:** Also accept stdin/env (`KODA_VCS_TOKEN`, `--token-env`) and document the risk in `--help`.

#### CLI-08: Wrong remediation hint in 401 error path
- **Severity:** LOW | **Category:** BUG
- **File:** `apps/cli/src/utils/error.ts:80`
- **Proof:**
  ```ts
  emitError(message, 'UNAUTHORIZED', status, 'Check your API key: koda config set apiKey <key>');
  ```
  Actual syntax is `koda config set --api-key <key>` (index.ts:136-137 rejects bare `apiKey`).
- **Fix:** Change the hint.

#### CLI-09: `evaluate` sets `OpenAPI.BASE` without stripping `/api`; hardcoded CI quality threshold
- **Severity:** LOW | **Category:** BUG
- **File:** `apps/cli/src/commands/evaluate.ts:27, 6`
- **Proof:**
  ```ts
  OpenAPI.BASE = ctx.apiUrl;      // every other command strips /api
  const CI_THRESHOLD = 0.70;
  ```
- **Risk:** With `--api-url http://host:3100/api`, evaluate hits `/api/api/...`; the retrieval-quality gate is a business rule baked into the thin client.
- **Fix:** Strip the suffix consistently; surface the threshold from the API response.

#### CLI-10: Malformed `.koda/config.json` silently ignored
- **Severity:** LOW | **Category:** BUG
- **File:** `apps/cli/src/config.ts:202-209`
- **Proof:**
  ```ts
  } catch {
    // If JSON parsing fails, return null
    return null;
  }
  ```
- **Risk:** A JSON typo makes all project-config precedence entries vanish with zero feedback.
- **Fix:** Warn to stderr on `JSON.parse`/read errors while continuing.

#### CLI-11: `conf.d.ts` hand-rolled declaration shadows real package types; stray `any` casts
- **Severity:** LOW | **Category:** TYPE
- **File:** `apps/cli/src/conf.d.ts:1-16`, `apps/cli/src/commands/kb.ts:366`, `apps/cli/src/commands/evaluate.ts:16`
- **Proof:**
  ```ts
  declare module 'conf' {
    class Conf<T extends Record<string, unknown> = Record<string, unknown>> { ... }
  ```
  ```ts
  requestBody: { nodes, links } as any,          // kb.ts:366
  const ctx = await resolveContext(opts as any); // evaluate.ts:16
  ```
- **Risk:** All config access type-checking is decorative; Commander action params are implicitly `any` throughout.
- **Fix:** Delete `conf.d.ts`, use the package's generics-aware types with `Conf<Config>`.

#### CLI-12: Inconsistent error-emission conventions with divergent exit codes
- **Severity:** LOW | **Category:** STYLE
- **File:** `apps/cli/src/commands/kb.ts:35-46` vs `apps/cli/src/commands/ticket.ts:84-86, 727-728`
- **Proof:**
  ```ts
  // kb.ts — missing option → error() + exit(3), config missing → exit(2)
  error('Missing required option: --query is required'); process.exit(3);
  // vcs.ts:77 — "missing project" is exit 3, not kb.ts's exit 2
  ```
- **Risk:** Machine consumers relying on documented exit codes get inconsistent results per command.
- **Fix:** Route every failure through `handleApiError` and codify the exit-code table in one place.

---

## Done Well

1. **Secrets & crypto hygiene (api)** — `env.validation.ts` requires `JWT_SECRET`/`JWT_REFRESH_SECRET`/`API_KEY_SECRET`, validates `VCS_ENCRYPTION_KEY` as 64-hex; no `console.log`, no TODO/FIXME in src; VCS tokens handled only via AES-256-GCM (`encryption.util.ts`). API keys are 32 random bytes stored only as HMAC-SHA256, raw key returned exactly once (`CombinedAuthGuard.tryApiKey`, `AgentsService.generateApiKey`).
2. **Refresh-token revocation is real (api)** — `koda-jwt-refresh-strategy.provider.ts:27-46` checks `user.tokenVersion > tokenVersion` so `logout` invalidates outstanding refresh tokens; auth controller throttled to 5/min.
3. **Outbox + soft-delete discipline (api)** — every ticket/project read path checks `deletedAt`; outbox uses claim-via-`updateMany` CAS, bounded exponential backoff (1s/4s/16s), stale-processing requeue, dead-letter with admin retry route.
4. **SSR data-fetching discipline (web)** — every page uses keyed `useAsyncData` (no double-fetch, no raw `$fetch` in setup), `pending`/`error` rendered via shared `LoadingState`/`ErrorState` + retry; ticket page fetches ticket/links/labels in parallel; stale-response guards in `useMemory`/`useTimelineEvents`/`code-intel.vue` with page rollback on failed appends.
5. **i18n parity (web)** — `en.json`/`zh.json` both have exactly 405 leaf keys, zero missing on either side (verified programmatically).
6. **Honest engineering notes & test seams (cli)** — `ResolveContextDeps`/`ConfigDeps`/`InitDeps` make file-discovery and context logic unit-testable without network/FS coupling; `json-mode.ts:1-13` documents the process-global state tradeoff; API key output is masked (`maskApiKey`, config.ts:151-168).

## Testing Assessment

- **api:** 135 spec files (~equal to source count) including adversarial specs (`code-commit-outbox-handler.adversarial.spec.ts`, `vcs-provider.adversarial.spec.ts`); public services extensively unit-covered; error paths (404/403/400, transition violations, dead-letter) represented. The authorization gaps (KODA-01/03/04/06/07) indicate missing negative tests at the controller guard level for vcs/ticket-links/timeline specifically.
- **web:** ~2,000 LOC unit tests + Playwright e2e with API fixtures. The vcs test mocks codify two conflicting envelope shapes (see CLI-01), which is why the break isn't caught.
- **cli:** per-command spec files exist; `vcs-update-test-sync-import.spec.ts` asserts the wrong response shape.

---

## Priority Fix Order

| Priority | IDs | Effort | Description |
|:---|:---|:---|:---|
| P0 | KODA-01, KODA-03, KODA-04, KODA-06, KODA-07, KODA-08 | M | Close the authorization gap cluster: add `@RequiredPermission` + project-membership checks to vcs/ticket-links/timeline/memory/rag-write/projects-update controllers; add controller-level negative authz tests |
| P0 | KODA-09 | S | Stop returning `webhookSecret` in VCS connection responses |
| P0 | WEB-01 | S | Sanitize markdown output with DOMPurify before `v-html` (both sinks) |
| P1 | KODA-02 | M | Verify webhook HMAC over raw request body (Fastify `rawBody`) |
| P1 | WEB-02 | M | httpOnly/server-side token storage + server logout + refresh flow |
| P1 | CLI-01 | S | Route vcs command responses through `unwrap()`; fix mock shapes |
| P2 | KODA-10, KODA-12 | M | Make initial-admin bootstrap concurrency-safe; add a body-size cap in `preParsing` |
| P2 | WEB-03, WEB-04, WEB-05, WEB-07 | S/M | URL scheme allowlist; agent slug watcher; `z.coerce.number()`; locale-aware dates |
| P2 | CLI-02, CLI-03, CLI-04, CLI-05 | S | Unify `resolveContext`; chmod 0600 on config; honor/expire assign flags; accurate login errors |
| P3 | KODA-11/14/15/16/17/18/19/20, WEB-06..20, CLI-06..12 | M/L | Dead-code removal, dedup (`withContext` helper, shared retriever, extracted components), typing cleanups, oversized-file splits |

---

*Method note: source and call-path verification was refreshed against HEAD `74de0033` on 2026-09-06. The documented paths were covered by the current code index with no recorded coverage gaps, and material claims were checked against source. `KodaDomainWriter.writeTicketEvent` is not reached by production code (only tests/acceptance material), so its payload-role design was removed as an exploitable finding. `PolicyGateService` explicitly operates on deterministic fixture projects in CI, so it was removed as a production-enforcement defect. Severity clustering after those corrections: CRITICAL×2, HIGH×5, MEDIUM×17, LOW×26.*
