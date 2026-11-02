# SPEC: Whole-repo review P1 remainder (self-fix approval, credential tiers, Owner protection, after-commit PR creation, verified review approver, fresh forge token)

## Summary

This feature fixes the P1 findings of the 2026-11-01 whole-repo review (`docs/20261101-review-whole-repo.md`) that
the first P1 bundle (#384) left out, with the rulings the user gave on 2026-11-02. It closes seven holes:

1. **A/SEC-3.** One agent can submit a fix (`POST /tickets/:ref/fix`) and then close the ticket on it: with
   `POST /tickets/:ref/verify-fix?approve=true`, with `POST /tickets/:ref/verify` (which closes a VERIFY_FIX ticket), or
   with `POST /tickets/:ref/close`. Each runs at once because its key is medium risk and defaults to `none`. The
   design's shipped rule, "when the caller is also the actor of the ticket's latest `fix`, the mode is `agent`", is now
   built: the approval gate gains a minimum-mode option, and those three routes set it to `agent` when the caller
   submitted the fix of a ticket that is in VERIFY_FIX.
2. **A/SEC-6, keys.** `agent.create`, `agent.key.rotate` and `user.create` each answer a raw secret (an API key or a
   password) but are medium risk, so an agent runs them with no approval. They move to high risk, whose agent default
   is `agent` (design section 1: "credential, key ... writes: `high`").
3. **A/SEC-6, CI token.** `PATCH /projects/:slug` with a `ciWebhookToken` rotates the project's CI webhook secret
   under `project.update`, which is medium. Such a PATCH now opens the gate with a minimum mode of `agent`.
4. **A/SEC-6, Owner (ruling 9).** A global Admin, or an agent bound to Admin, can disable the Owner while another
   admin stays active. Disabling a user who holds `role.binding.owner` is now refused unless the caller also holds it.
5. **A/BUG-1.** On the deferred approval path, the VERIFIED transition's GitHub draft-PR creation runs inside the
   approval execution transaction, holding the request and project row locks over network calls. A settle failure
   rolls the transition back but leaves the PR, and the stale-approved retry opens a second one. The PR creation and
   the CLOSED-ticket RAG index now run after the transaction commits, and the PR is skipped when the ticket already has
   one.
6. **C/SEC-2 (ruling 14).** A review-minted "not a defect" decision credits as its human approver any repo writer the
   runner's `bot-review.json` names in `disagreedBy`, and nothing checks that this login wrote in the thread. The
   minter now reads the review thread's comment authors with one GitHub GraphQL call, using a token that can read pull
   requests. A writer who is also a thread author on that PR is a verified approver (`satisfiedBy: 'human'`).
   Otherwise the decision is still minted, but recorded as unverified (`satisfiedBy: 'none'`).
7. **D/BUG-2 (ruling 4).** The forge token the runner writes for nax at the start of a FIX or REVIEW step can have as
   little as about 5 minutes left, and nax reads it once, so a longer fix fails to push or reply. The runner now asks
   for a fresh token (`fresh: true` on the sync token request) when the cached one has less than 50 minutes left, and
   waits for it; the API skips its token reuse cache for such a request.

The bundle spans `apps/api` and `apps/runner`, plus a types-only field in `packages/fleet-protocol`. No schema change,
no migration, no web change. **Deploy order:** the API before the runner (see Out of Scope).

## Motivation

The 2026-11-01 review graded koda C+ (74/100). The P0 bundle (#381) and the first P1 bundle (#384) are deployed. These
are the remaining P1 rows of the review's Priority Fix Order.

- **Self-approval (A/SEC-3).** `TicketsController.verifyFix` opens the gate under
  `ticket.transition.verify-fix.approve` with no reference to who submitted the fix. `POST /:ref/verify` on a VERIFY_FIX
  ticket closes it (`TicketTransitionsService.verify` -> `executeTransitionInternal(..., CLOSED, ...)`, edge key
  `verify-fix.approve`) under the gate key `ticket.transition.verify`, and `POST /:ref/close` accepts VERIFY_FIX
  (`CLOSE_SOURCES` in `allowed-actions.ts`) under `ticket.transition.close`. The Developer role holds
  `ticket.transition.*`, so a Developer agent closes its own ticket on a self-written review, and the audit records
  `requiredMode: none`. The permission redesign (`docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md`,
  "Shipped defaults") lists the self-fix rule; no code implements it.
- **Credential tiers (A/SEC-6).** `classifyRisk` in `apps/api/src/permissions/catalog.ts` makes a key high only for
  delete/remove verbs and `HIGH_RISK_PREFIXES`. An agent bound to global Admin (one human-approved binding) rotates
  another agent's key with `POST /agents/:slug/rotate-key`, receives the raw key, and impersonates that agent, with
  `satisfiedBy: none` in the audit. The same holds for `POST /agents` and `POST /admin/users`.
- **CI token (A/SEC-6).** `ProjectsController.update` already routes a `ciWebhookToken` patch to its own redeem variant
  `rest:projects.update-ci-token`, but under the medium `project.update` key, so an agent rotates the CI secret at once
  (`test/integration/projects/gated-project-ci-token-route.integration.spec.ts` "FM-1" pins that today).
- **Owner protection (A/SEC-6, ruling 9).** `UsersAdminService.update` refuses only a self-disable and the last active
  admin. The user ruled on 2026-11-02 to protect the Owner: only an Owner may disable an Owner.
- **External effects in the transaction (A/BUG-1).** `ApprovalExecutionService.executeOnce` runs the command inside
  `txManager.run` after taking the request lock and the project slug lock. For `ticket.transition.verify` that call
  awaits `createPrForTicket` (`getDefaultBranch`, `createPullRequest`, `createTicketLink`, `extractLinksFromPr`) while
  both locks are held. If the settle then fails, the transition and the link roll back but the draft PR exists, and
  `retryStale` re-executes the request five minutes later and opens a second draft PR. `autoIndexTicket` (CLOSED) is
  started under the transaction's async context and can read uncommitted state.
- **Unverified approver (C/SEC-2, ruling 14).** `ReviewEventMinter.mintOne` mints a `mintReadOnlyToken` token
  (`contents: read, metadata: read`), picks the first `disagreedBy` login whose repo role is `admin`, `maintain` or
  `write`, and mints with `satisfiedBy: 'human', approverType: 'FORGE_USER'`. `disagreedBy` comes from an artifact the
  runner uploads from a raw job's workspace, and the K2 design says these logins are "unverified forge logins;
  consumers must check artifact trust and commenter permissions". For GitHub, nax sets the event's `threadId` to the
  GraphQL node id of the PR review thread (`nax packages/nax/src/forge/threads.ts`: `id: node.id` of a
  `reviewThreads` node), which `node(id:)` resolves. The user ruled on 2026-11-02: verify with one GitHub call per
  event; when the login cannot be confirmed, or the call fails, record the decision as unverified rather than drop it.
- **Forge token lifetime (D/BUG-2, ruling 4).** The API reuses a cached installation token until
  `gitTokenReuseMarginSec` (300 s) before it expires, and the runner's `TokenCache` refreshes only inside its own
  margin, so `CredentialBroker.currentToken(job)` can hand nax a token with 5 to 60 minutes left. nax reads
  `forge-token` once at startup and uses it for every forge call and the push. The user ruled on 2026-11-02 for a
  koda-only fresh mint; a generic nax token-refresh command is a later, separate nax feature.

## Design

### Calls made in this spec

1. **Gate minimum mode (US-001).** `ApprovalGate.gate` and `RouteGateCall` take an optional `minMode: ApprovalMode`.
   The gate composes in this order:
   1. resolve the primary key and every `alsoKeys` key, and keep the strictest resolution (unchanged, #384);
   2. if `minMode` is present, the kept resolution's `source` is not `'not-approvable'`, and `minMode` is stricter than
      its mode, replace it with `{ mode: minMode, floor: <the kept resolution's floor>, policy: null, source: 'default' }`.
   Step 2 never lowers a mode and never applies to a non-approvable key. Replacing the policy with `null` means a request
   opened only because of `minMode` uses the no-policy defaults (`onTimeout: 'reject'`, timeout
   `DEFAULT_APPROVAL_TIMEOUT_SEC`, `approverMustHoldAction: true`, `requireDistinctApprover: false`), so a policy that
   allows auto-approve on timeout cannot release it. The rest of the gate is unchanged: `none` executes, a USER subject
   executes with `satisfiedBy: 'human'`, any other subject gets a pending request whose `requiredMode` is the final
   mode. `ApprovalRouteGate.run` forwards `minMode` only when the call carries it.
2. **Self-fix floor (US-002).** `ITicketRepository.findLatestStatusChangeActor(ticketId, toStatus)` reads the newest
   `TicketActivity` row with `action = 'STATUS_CHANGE'` and that `toStatus` (order `createdAt` desc, then `id` desc) and
   answers `{ type: 'AGENT', id: actorAgentId }` when `actorAgentId` is set, else `{ type: 'USER', id: actorUserId }`
   when that is set, else `null`; no row answers `null`. `TicketsService.selfFixApprovalFloor(projectSlug, ref,
   principal): Promise<'agent' | undefined>` loads the ticket the way `findByRef` does (same 404s). It answers
   `undefined` without reading activity when the ticket's status is not `VERIFY_FIX`. Otherwise it reads the latest
   `VERIFY_FIX` actor and answers `'agent'` when that actor's `type` equals the caller's kind (`principal.actorType`
   `'user'` -> `'USER'`, `'agent'` -> `'AGENT'`) and its `id` equals `principal.id`, else `undefined`; a `'runner'`
   principal (never reaches these routes) answers `undefined`.
3. **Routes apply the floor (US-003).** `TicketsController.verifyFix` (only when `approve` is true), `verify` and
   `close` call `selfFixApprovalFloor(slug, ref, principal)` before the gate. When it answers `'agent'`, their
   `routeGate.run` call carries `minMode: 'agent'`; otherwise the call has no `minMode` property. The return branch of
   `verifyFix` (`approve` false) does not call it. `PATCH /tickets/:ref` needs no floor: through PATCH only the
   comment-less edges CREATED/VERIFIED -> IN_PROGRESS succeed, and none of them leaves VERIFY_FIX.
4. **Credential keys (US-004).** `catalog.ts` exports `CREDENTIAL_KEYS: ReadonlySet<string>` =
   `{'agent.create', 'agent.key.rotate', 'user.create'}`. `classifyRisk` answers `'high'` for them, after the critical
   and read checks and before the `'medium'` fallback. `buildEntry` is unchanged, so their `approval.default` becomes
   `'agent'` and their floor stays `'none'`.
5. **CI token floor (US-004).** `ProjectsController.update`, when the parsed patch carries `ciWebhookToken` (any
   present value, `null` included: clearing the secret is a credential write too, and the route already routes a
   present value, `!== undefined`, to the redeem variant), adds
   `minMode: 'agent'` to its `routeGate.run` call (variant `rest:projects.update-ci-token`, redeem header unchanged). A
   patch without it is unchanged.
6. **Owner protection (US-005).** `UsersAdminService.update(actor: PrincipalRef, userId, patch)` replaces the
   `actorId: string` parameter; `UsersAdminService` gains `PermissionService` as a constructor dependency. Order inside
   `update`:
   1. self-disable refusal (`users.self`), unchanged, comparing `actor.id`;
   2. inside the transaction, after the target lookup (`users` 404 unchanged): when `patch.disabled === true` and the
      target is not already disabled, read `effectiveKeys({ type: 'USER', id: userId }, 'global')`; if it holds
      `role.binding.owner`, read `effectiveKeys(actor, 'global')`; if that does not hold `role.binding.owner`, throw
      `new ForbiddenAppException({}, 'users.owner')` (HTTP 403) before any write;
   3. the last-admin guard (`users.lastAdmin`), unchanged.
   `UserRouteCommands`' `user.update` command passes `{ type: principal.actorType === 'agent' ? 'AGENT' : 'USER', id:
   principal.id }`. New i18n key `users.owner.40003`: en "Only an Owner can disable an Owner", zh "只有所有者可以停用所有者".
7. **After-commit effects (US-006).** `TicketTransitionsService` gains `AfterCommitService` as a required constructor
   dependency, placed right after `audit`. A private helper runs a task after commit:
   `if (!this.afterCommit.defer(task)) await task();`. Both `createPrForTicket` (VERIFIED) and `autoIndexTicket`
   (CLOSED, in both places it is called today) go through it. The PR task uses the helper as written. The index task
   returns the index promise chain (still catching and logging its own failure), is deferred the same way, and when
   no scope is open is started without being awaited (`void task()`), so the immediate path's response does not wait
   on the embedding call, as today. On the deferred approval path `executeOnce` already
   wraps its transaction in `afterCommit.scope`, so the task runs after commit and is dropped on rollback; on the
   immediate path no scope is open, so the task runs right after the transition's own transaction, as today.
   `createPrForTicket` also checks `ITicketRepository.hasPrLink(ticketId)` (any `TicketLink` with `linkType: 'pr'`,
   any source) right after the fleet-ownership check, inside its own try/catch: true returns before any provider call,
   and a thrown lookup logs a warning and also returns before any provider call (fail closed: no possible duplicate).
8. **Review thread lookup (US-007).** `GitHubAppClient.mintThreadReadToken(installationId, repoName)` mints a token
   scoped `{ contents: 'read', pull_requests: 'read', metadata: 'read' }` through the existing `mintScopedToken`.
   `GitHubAppClient.getReviewThread(token, threadId): Promise<ReviewThreadInfo | null>`, `ReviewThreadInfo = {
   repoOwner: string; repoName: string; prNumber: number; authors: readonly string[] }`. It POSTs `{ query, variables:
   { id: threadId } }` to the GraphQL endpoint with the bearer token. The endpoint is `<githubApiUrl>/graphql`, except
   that a `githubApiUrl` ending in `/api/v3` maps to the same host's `/api/graphql`. The query is
   `query($id: ID!) { node(id: $id) { ... on PullRequestReviewThread { pullRequest { number repository { name owner { login } } } comments(first: 100) { nodes { author { login } } } } } }`.
   A 200 whose `data` is absent, or whose `data.node` is null or has no `pullRequest`, answers `null` (a `threadId`
   that is not a review-thread node id lands here). Any non-200 throws `RepoCheckException('provider_error')`.
   `authors` lists each non-null `author.login`, in order, without duplicates.
9. **Verified approver (US-007).** `ReviewEventMinter.mintOne` mints its token with `mintThreadReadToken` instead of
   `mintReadOnlyToken`. It keeps one `getRepoRole` call per non-bot login, as today, but collects every writer
   (`admin`/`maintain`/`write`) in `disagreedBy` order instead of stopping at the first; a role-check error keeps
   today's `permission-check-failed` skip. With no writer it skips `no-writer` as today and makes no thread call. With
   writers, it calls `getReviewThread(token, row.threadId)` exactly once. The thread matches when its `prNumber` equals
   `row.prNumber` and its `repoOwner`/`repoName` equal the repo's (case-insensitive). The approver is the first writer
   whose login is among the thread's `authors` (case-insensitive) when the thread matches; the mint then runs under
   `{ requiredMode: 'human', satisfiedBy: 'human', approverType: 'FORGE_USER', approverId: 'github:<login>' }`. In every
   other case (no writer among the authors, a null thread, a thread for another PR or repo, or a thrown lookup) the
   approver is the first writer and the mint runs under the same object with `satisfiedBy: 'none'`.
   `ReviewDecisionWriter.mint`'s audit summary ends `approver github:<login> (verified thread author)` when the
   context's `satisfiedBy` is `'human'` and `approver github:<login> (unverified)` otherwise, replacing the fixed
   "(one of the thread's commenters)" text.
10. **Fresh token request, API (US-008).** `TokenRequest` (`packages/fleet-protocol/src/index.ts`, types only) gains
    `fresh?: true`. `parseTokenRequest` accepts `fresh: true` (kept), `fresh: false` (dropped) and refuses any other
    present value with the parser's `tokenRequest` validation error. `SyncService.grantTokens` forwards `fresh: true` to
    `GitTokenBroker.mint` only for a request that carries it and whose job is `FIX` or `REVIEW`. `GitTokenBroker.mint`'s
    request gains `fresh?: boolean`: when true it skips the cache reuse check, mints through the existing `fresh()` path
    (for `purpose: 'fix'` that path ends in `mintInstallationToken`; for `'review'`, in `mintReviewToken`), and replaces
    the cache entry under the same key.
11. **Fresh token cache, runner (US-009).** `TokenCache.requireFresh(jobId, leaseEpoch, minRemainingMs)` records a
    minimum remaining life on the job's repo-less entry (creating a wanted entry when there is none), clears that
    entry's stored error, and calls the `onNeed` listeners. `minRemainingMs` 0 clears the minimum. `requests(nowMs)`
    composes the two thresholds as: a request is due when the entry is outside its cool-down and its token is missing
    or has less than `max(refreshMarginMs, minRemainingMs)` left; the request carries `fresh: true` only when
    `minRemainingMs > 0` and the token is missing or has less than `minRemainingMs` left. `apply` clears the minimum once
    it stores a token with at least that much left; a token still short of it starts the cool-down.
    `TokenCache.error(jobId, leaseEpoch, repoId?)` answers the entry's stored error even while a live token is cached
    (`state()` keeps hiding it then, unchanged). `buildSyncRequest` (`apps/runner/src/sync/batch.ts`), which rebuilds
    each token request for the wire, forwards `fresh: true` when the request carries it and adds no `fresh` key
    otherwise; today it copies only `jobId`, `leaseEpoch` and `repoId`.
12. **Fresh token use, runner (US-010).** `CredentialBroker.freshToken(job, minRemainingMs, isCancelled?)` calls
    `requireFresh`, then polls like `firstToken` (same `waitMs`/`pollMs`) and answers `{ ok: true, token }` once the
    live token has at least `minRemainingMs` left, `{ ok: false, reason: 'git token: <error>' }` as soon as
    `tokens.error(...)` is set, `{ ok: false, reason: 'git token: timeout' }` at the deadline and `{ ok: false, reason:
    'cancelled' }` when cancelled; before it returns, on success and on every refusal, it calls
    `requireFresh(jobId, leaseEpoch, 0)`, so no stale minimum keeps asking for fresh mints. `CredentialProvider` gains the optional `freshToken`. `HostExecutor` exports
    `FORGE_TOKEN_MIN_REMAINING_MS = 3_000_000` (50 minutes). Both places that write `forge-token` (`reviewEnv`, used by
    the REVIEW spawn and by the FIX job's review step, and `spawnFixStep`, the FIX job's fix step) call
    `freshToken(job, FORGE_TOKEN_MIN_REMAINING_MS)` instead of `currentToken`, throw `new Error(reason)` on a refusal
    before writing the file, and throw `new Error('git token: none')` when the provider has no `freshToken`.

### Integration

Symbols this feature only reads:

- `APPROVAL_MODE_RANK`, `modeAtLeast`, `strictestMode` (`apps/api/src/approvals/domain/approval-mode.ts`).
- `ResolvedApproval = { mode, floor, policy, source }` with `source: 'not-approvable' | 'policy' | 'default'`
  (`apps/api/src/approvals/approval-policy.resolver.ts`).
- `DEFAULT_APPROVAL_TIMEOUT_SEC` (`apps/api/src/approvals/domain/approval.domain.ts`) and the gate's
  `NO_POLICY_ON_TIMEOUT = 'reject'`.
- `TICKET_ROUTE_VARIANTS.verifyFix = 'rest:tickets.verify-fix'`, `.verify`, `.close`;
  `PROJECT_ROUTE_VARIANTS.updateCiToken = 'rest:projects.update-ci-token'`.
- `ActivityType.STATUS_CHANGE`, `TicketStatus.VERIFY_FIX`; `TicketActivity` columns `action`, `toStatus`,
  `actorUserId`, `actorAgentId`, `createdAt` (index `[ticketId, createdAt]`).
- `KodaPrincipal.actorType: 'user' | 'agent' | 'runner'`; `PrincipalRef = { type: PrincipalType; id: string }`;
  `PermissionService.effectiveKeys(principal: PrincipalRef, scope: PermissionScope): Promise<ReadonlySet<string>>`;
  `OWNER_BINDING_KEY = 'role.binding.owner'`.
- `AfterCommitService.defer(task): boolean` and `scope(fn)` (`apps/api/src/permissions/after-commit.service.ts`,
  exported by `PermissionsModule`).
- `ApprovalExecutionService.executeOnce` (wraps its transaction in `afterCommit.scope(...)`).
- `GitHubAppClient.mintScopedToken`, `FleetHttpClient.request(method, url, headers, body?)`; `RepoCheckException`.
- `runWithApproval(approval, fn)` and `ActionApproval = { requiredMode; satisfiedBy; approverType?; approverId? }`.
- `CredentialBroker.firstToken` (the polling pattern `freshToken` mirrors); `TokenCacheTiming.refreshMarginMs`,
  `cooldownMs`; the broker timing's `waitMs`, `pollMs`.

Symbols this feature changes. The baseline only locates the code; the target is the interface to implement.

- `ApprovalGate.gate`
  - Baseline: `opts: { projectId: string | null; variant?: string; alsoKeys?: readonly string[] }`.
  - Target: `opts: { projectId: string | null; variant?: string; alsoKeys?: readonly string[]; minMode?: ApprovalMode }`.
- `RouteGateCall`
  - Target: gains `minMode?: ApprovalMode`.
- `ITicketRepository` (`apps/api/src/tickets/domain/ticket.domain.ts`)
  - Target: gains `findLatestStatusChangeActor(ticketId: string, toStatus: TicketStatus): Promise<{ type: 'USER' |
    'AGENT'; id: string } | null>` (US-002) and `hasPrLink(ticketId: string): Promise<boolean>` (US-006).
- `TicketsService`
  - Target: gains `selfFixApprovalFloor(projectSlug: string, ref: string, principal: KodaPrincipal): Promise<'agent' |
    undefined>`.
- `catalog.ts`
  - Target: also exports `CREDENTIAL_KEYS`.
- `UsersAdminService.update`
  - Baseline: `update(actorId: string, userId: string, patch: UpdateUserDto): Promise<UserAdminDto>`.
  - Target: `update(actor: PrincipalRef, userId: string, patch: UpdateUserDto): Promise<UserAdminDto>`.
- `TicketTransitionsService` constructor
  - Baseline: `(ticketRepo, txManager, permissions, audit, ragService?, webhookDispatcher?, vcsConnectionService?,
    ticketLinksService?, vcsLinkExtractorService?, vcsConfig?, ticketEventService?, outboxService?)`.
  - Target: `(ticketRepo, txManager, permissions, audit, afterCommit: AfterCommitService, ragService?, ...the same
    optional dependencies in the same order)`.
- `GitHubAppClient`
  - Target: gains `mintThreadReadToken(installationId: bigint, repoName: string): Promise<{ token: string; expiresAt:
    Date }>` and `getReviewThread(token: string, threadId: string): Promise<ReviewThreadInfo | null>`, and exports
    `ReviewThreadInfo`.
- `TokenRequest` (`@nathapp/fleet-protocol`)
  - Baseline: `{ jobId: string; leaseEpoch: number; repoId?: string }`.
  - Target: `{ jobId: string; leaseEpoch: number; repoId?: string; fresh?: true }`.
- `GitTokenBroker.mint`
  - Target: request gains `fresh?: boolean`.
- `TokenCache`
  - Target: gains `requireFresh(jobId: string, leaseEpoch: number, minRemainingMs: number): void` and
    `error(jobId: string, leaseEpoch: number, repoId?: string): string | null`.
- `CredentialProvider` / `CredentialBroker`
  - Target: gains `freshToken?(job: JobRow, minRemainingMs: number, isCancelled?: () => boolean): Promise<{ ok: true;
    token: string } | { ok: false; reason: string }>` (implemented by `CredentialBroker`).

### Failure Handling

| Path | Behaviour |
|:---|:---|
| Fix's own agent approves, verifies or closes a VERIFY_FIX ticket | gate pending with `requiredMode` at least `agent`; ticket unchanged. |
| No VERIFY_FIX activity row, or the ticket is not in VERIFY_FIX | no `minMode`; gate as today. |
| Agent calls a re-tiered credential key with no policy | 202 approval request (redeem routes keep their redeem flow); nothing written. |
| Non-Owner disables an Owner | 403 `users.owner`; no write, no token bump. |
| PR creation fails after commit | `logger.warn` as today; the committed transition stays. |
| `hasPrLink` lookup throws | `logger.warn`; no provider call (fail closed). |
| Deferred transition rolls back | the queued PR and index tasks never run. |
| Review thread lookup throws, is null, or names another PR/repo | decision minted with `satisfiedBy: 'none'`. |
| Runner sends `fresh` with a non-boolean | sync rejected with the parser's `tokenRequest` validation error. |
| `fresh` on a job other than FIX/REVIEW | ignored: the broker may reuse its cache. |
| Fresh mint refused by the API (e.g. `default_branch_unprotected`) | FIX/REVIEW step throws `git token: <reason>`; no `forge-token` written. |
| Fresh token not delivered in `waitMs` | step throws `git token: timeout`; minimum cleared; no `forge-token` written. |

## Out of Scope

- Deploy order is API before runner: a runner with this change against an older API, which drops `fresh` from the token request, waits `waitMs` and fails FIX and REVIEW starts with `git token: timeout`. No protocol version bump or fallback is added; koda-wk deploys both together, API first.
- Invite emails sent from a deferred `invite.create` redeem keep their current ordering; the invite keys are critical (human floor) since #381, and moving the send after commit would change the `emailed` flag the redeem answers.
- The after-commit tasks are best-effort and in-process, as `committedEffect` is: a crash between commit and the PR call loses that PR, as a crash does on the immediate path today. No outbox is added.
- A generic nax forge-token refresh command (a nax feature request under ruling 4) is not part of this bundle.
- `user.update` other than the Owner rule is not re-tiered; only `disabled` is patchable and the Owner rule covers the reported abuse.
- An unverified review decision (`satisfiedBy: 'none'`) is still an active memory decision that later reviews consume; only its audit provenance differs. This is the ruling-14 choice (downgrade, not drop).
- Existing review decisions minted before this change keep their recorded approval; nothing is re-verified.
- "Verified" in ruling 14 means the writer authored a comment in the review thread that the event's `threadId` names, on the same PR and repo. It does not prove that this comment is the disagreement, or that the runner-supplied `threadId` belongs to this finding; tying a decision to a specific comment needs nax to report comment ids and is not part of this bundle.
- US-007 only: `FleetReviewEvent.approverLogin` keeps recording the chosen login for an unverified mint as well; the verified/unverified distinction lives in the action approval (`satisfiedBy`) and the audit summary.
- No web, CLI or MCP copy is added for the new 202 answers or the `users.owner` refusal beyond the API i18n key.
- US-003 only: `ticket.transition.verify-fix.return` by the fix's own actor is not given a floor; the design names only the approving edge, and returning a ticket to IN_PROGRESS closes nothing.
- US-002 only: a fix actor recorded as neither a user nor an agent (a system writer) never matches a caller.
- US-004 only: `agent.update`, `agent.capabilities.update` and `user.update` keep their medium tier.
- US-007 only: GitLab review threads are not looked up; review decisions are GitHub-only today.
- US-007 only: a thread with more than 100 comments is judged on its first 100 authors.
- US-007 only: role checks stay one `getRepoRole` call per non-bot login, as today; ruling 14's "one call per event" is the thread lookup.
- US-008 only: the runner-sync integration suite gains no fresh-token case; the parser, sync and broker units cover it, and the live check exercises it end to end.
- US-009 only: a token request for a repo-scoped entry (`repoId`) never carries `fresh`; only the job's own token is written to `forge-token`.

## Stories

This bundle has 10 stories, one package each. It is a bundle of independent P1 fixes, not one capability; the user
chose one bundle on 2026-11-02, as for #381 and #384 (8 stories confirmed; spec-review pass 1 added the `/verify` and
`/close` routes to A/SEC-3 and moved the runner past one story's AC budget, which split two stories). Every story has
at most 15 AC bullets; the resolved story-size gate (`action: warn`) only warns when `nax plan` splits compound bullets
past 15.

### US-001: Approval gate takes a minimum mode

No dependencies. Workdir: apps/api. Call 1: `minMode` on `ApprovalGate.gate` and `RouteGateCall`, applied after the
strictest-of-keys reduction, skipped for non-approvable keys, with a policy-less resolution when it raises the mode.

### US-002: The ticket service answers the self-fix approval floor

No dependencies. Workdir: apps/api. Call 2: `findLatestStatusChangeActor` and `TicketsService.selfFixApprovalFloor`.

### US-003: Verify-fix, verify and close apply the self-fix floor

Depends on US-001, US-002. Workdir: apps/api. Call 3: the `minMode: 'agent'` branch in `TicketsController.verifyFix`,
`verify` and `close`.

### US-004: Credential writes are high risk and a CI token rotation needs agent mode

Depends on US-001. Workdir: apps/api. Calls 4 and 5: `CREDENTIAL_KEYS` in `classifyRisk`, and `minMode: 'agent'` on a
`ciWebhookToken` patch in `ProjectsController.update`.

### US-005: Only an Owner can disable an Owner

No dependencies. Workdir: apps/api. Call 6: the `PrincipalRef` actor and the Owner check in `UsersAdminService.update`,
the route command's actor, and the `users.owner` i18n key.

### US-006: Transition PR creation and RAG indexing run after commit

No dependencies. Workdir: apps/api. Call 7: `AfterCommitService` in `TicketTransitionsService`, the after-commit helper
for `createPrForTicket` and `autoIndexTicket`, and `hasPrLink`.

### US-007: A review decision's approver is verified against the thread

No dependencies. Workdir: apps/api. Calls 8 and 9: `mintThreadReadToken`, `getReviewThread`, the verified/unverified
approver in `ReviewEventMinter.mintOne`, and the writer's audit summary.

### US-008: The API honours a fresh token request for FIX and REVIEW

No dependencies. Workdir: apps/api. Call 10: `TokenRequest.fresh` (types-only change in
`packages/fleet-protocol/src/index.ts`, as #383 did for `FleetRepoRef`), the parser, `SyncService.grantTokens` and
`GitTokenBroker.mint`.

### US-009: The runner token cache asks for a fresh token

Depends on US-008. Workdir: apps/runner. Call 11: `TokenCache.requireFresh`, its request composition, and
`TokenCache.error`.

### US-010: FIX and REVIEW write a forge token with at least 50 minutes left

Depends on US-009. Workdir: apps/runner. Call 12: `CredentialBroker.freshToken` and the two `forge-token` writers in
`HostExecutor`.

### Context Files

**US-001**

- `apps/api/src/approvals/approval-gate.service.ts`
- `apps/api/src/approvals/route/approval-route-gate.ts`
- `apps/api/src/approvals/domain/approval-mode.ts`
- `apps/api/src/approvals/approval-policy.resolver.ts`

**US-002**

- `apps/api/src/tickets/tickets.service.ts`
- `apps/api/src/tickets/prisma-tickets.repository.ts`
- `apps/api/src/tickets/domain/ticket.domain.ts`

**US-003**

- `apps/api/src/tickets/tickets.controller.ts`
- `apps/api/src/tickets/state-machine/ticket-transitions.service.ts`
- `apps/api/src/tickets/state-machine/allowed-actions.ts`
- `apps/api/test/integration/tickets/gated-ticket-review-routes.integration.spec.ts`

**US-004**

- `apps/api/src/permissions/catalog.ts`
- `apps/api/src/permissions/catalog.spec.ts`
- `apps/api/src/projects/projects.controller.ts`
- `apps/api/test/integration/projects/gated-project-ci-token-route.integration.spec.ts`
- `apps/api/test/integration/agents/gated-agent-key-routes.integration.spec.ts`

**US-005**

- `apps/api/src/users/users-admin.service.ts`
- `apps/api/src/users/user-route.commands.ts`
- `apps/api/src/permissions/permission.service.ts`
- `apps/api/test/integration/users/admin-users.integration.spec.ts`

**US-006**

- `apps/api/src/tickets/state-machine/ticket-transitions.service.ts`
- `apps/api/src/permissions/after-commit.service.ts`
- `apps/api/src/approvals/approval-execution.service.ts`
- `apps/api/test/integration/vcs/auto-create-pr-on-verified.integration.spec.ts`

**US-007**

- `apps/api/src/fleet/reviews/review-event.minter.ts`
- `apps/api/src/fleet/git-broker/github-app-client.ts`
- `apps/api/src/memory/review-decision.writer.ts`
- `apps/api/src/fleet/reviews/review-event.minter.spec.ts`

**US-008**

- `apps/api/src/fleet/sync/sync-request.parser.ts`
- `apps/api/src/fleet/sync/sync.service.ts`
- `apps/api/src/fleet/git-broker/git-token.broker.ts`
- `packages/fleet-protocol/src/index.ts`

**US-009**

- `apps/runner/src/credentials/token-cache.ts`
- `apps/runner/src/credentials/token-cache.spec.ts`
- `apps/runner/src/sync/batch.ts`
- `apps/runner/src/sync/batch.spec.ts`

**US-010**

- `apps/runner/src/credentials/broker.ts`
- `apps/runner/src/executor/host-executor.ts`
- `apps/runner/test/unit/host-executor.spec.ts`
- `apps/runner/test/unit/broker.spec.ts`

### Creates

**US-002**

- `apps/api/test/integration/tickets/ticket-latest-status-actor.integration.spec.ts` — real-DB cases for `findLatestStatusChangeActor`.

**US-006**

- `apps/api/test/integration/tickets/ticket-pr-link.integration.spec.ts` — real-DB cases for `hasPrLink`.

### Modifies

**US-001**

- `apps/api/src/approvals/approval-gate.service.ts` — `gate` accepts `opts.minMode` and, after the strictest-of-keys reduction, replaces a weaker approvable resolution with `{ mode: minMode, floor, policy: null, source: 'default' }`.
- `apps/api/src/approvals/route/approval-route-gate.ts` — `RouteGateCall` gains `minMode?: ApprovalMode`, and `run` forwards it to `gate.gate` only when present.
- `apps/api/src/approvals/approval-gate.service.spec.ts` — add the `minMode` cases; existing cases stay.
- `apps/api/src/approvals/route/approval-route-gate.spec.ts` — add the forwarding cases; existing cases stay, including those asserting the exact opts object for calls without `minMode`.

**US-002**

- `apps/api/src/tickets/domain/ticket.domain.ts` — `ITicketRepository` gains `findLatestStatusChangeActor`.
- `apps/api/src/tickets/prisma-tickets.repository.ts` — implements `findLatestStatusChangeActor` with one `findFirst` on `TicketActivity` ordered by `createdAt` desc then `id` desc.
- `apps/api/src/tickets/tickets.service.ts` — gains `selfFixApprovalFloor`.
- `apps/api/src/tickets/tickets.service.spec.ts` — the repository mock gains `findLatestStatusChangeActor`; add the service cases.

**US-003**

- `apps/api/src/tickets/tickets.controller.ts` — `verifyFix` (approve), `verify` and `close` add `minMode: 'agent'` to the gate call when `selfFixApprovalFloor` answers `'agent'`.
- `apps/api/src/tickets/tickets.controller.spec.ts` — the service mock gains `selfFixApprovalFloor` answering `undefined` by default, so existing verify-fix, verify and close cases keep asserting the same gate call; add the new cases.
- `apps/api/test/integration/tickets/gated-ticket-review-routes.integration.spec.ts` — add the self-fix cases; existing cases stay, because their fixes are submitted by the root user, not by the agent that approves.

**US-004**

- `apps/api/src/permissions/catalog.ts` — exports `CREDENTIAL_KEYS` and `classifyRisk` answers `'high'` for its keys.
- `apps/api/src/permissions/catalog.spec.ts` — the spec's own `expectedRisk` oracle adds the `CREDENTIAL_KEYS` rule after the read check, so the catalog-wide comparison still matches; add the per-key cases.
- `apps/api/src/projects/projects.controller.ts` — `update` adds `minMode: 'agent'` when the patch carries `ciWebhookToken`.
- `apps/api/src/projects/projects.controller.spec.ts` — "AC-9: routes token-bearing mixed patches through the redeem variant" asserts the exact `routeGate.run` argument for a token-bearing patch, which now also carries `minMode: 'agent'`; add the new cases; cases for patches without a token stay.
- `apps/api/test/integration/projects/gated-project-ci-token-route.integration.spec.ts` — "FM-1: agent token patch executes immediately under the project.update default-none policy" now expects 202 and an unchanged token, because a CI token rotation needs `agent` mode.
- `apps/api/test/integration/agents/gated-agent-key-routes.integration.spec.ts` — add the no-policy agent create case; existing cases keep their explicit policies.

**US-005**

- `apps/api/src/users/users-admin.service.ts` — `update` takes `actor: PrincipalRef`, and the service injects `PermissionService` for the Owner check.
- `apps/api/src/users/user-route.commands.ts` — the `user.update` command passes the caller as a `PrincipalRef`.
- `apps/api/src/users/users-admin.service.spec.ts` — every `update(...)` call passes a `PrincipalRef` instead of a bare id, and the service is built with a `PermissionService` mock whose `effectiveKeys` answers an empty set by default; add the Owner cases.
- `apps/api/src/users/user-route.commands.spec.ts` — the `user.update` expectation asserts the `PrincipalRef` argument instead of the bare id.
- `apps/api/src/i18n/en/users.json` — adds `owner.40003`.
- `apps/api/src/i18n/zh/users.json` — adds `owner.40003`.
- `apps/api/test/integration/users/admin-users.integration.spec.ts` — "two admins disabling each other at once refuse exactly one with users.lastAdmin" has Eve (a non-Owner admin) disable root, which is the Owner (`bindOwnerIfFirst`) and is now refused with 403 `users.owner`; rewrite the case so the two concurrent writers are both Owners (grant Eve the global `owner` role instead of `admin`), keeping its `[200, 409]` expectation and its lock assertions; add the Owner cases; other cases stay.

**US-006**

- `apps/api/src/tickets/state-machine/ticket-transitions.service.ts` — injects `AfterCommitService` after `audit`, runs `createPrForTicket` and `autoIndexTicket` through the after-commit helper, and returns early from `createPrForTicket` when `hasPrLink` answers true or throws.
- `apps/api/src/tickets/domain/ticket.domain.ts` — `ITicketRepository` gains `hasPrLink`.
- `apps/api/src/tickets/prisma-tickets.repository.ts` — implements `hasPrLink` with one `count` on `TicketLink` where `linkType: 'pr'`.
- `apps/api/src/tickets/state-machine/ticket-transitions.service.spec.ts` — the positional constructor gains an `AfterCommitService` (a real instance) right after the audit argument, and the repository mocks that carry `hasFleetOwnership` (around lines 1248 and 1305) also gain `hasPrLink` answering false; add the after-commit cases.
- `apps/api/src/tickets/state-machine/ticket-transitions.audit.spec.ts` — the positional constructor gains an `AfterCommitService` right after the audit argument; assertions stay.
- `apps/api/src/tickets/state-machine/ticket-transitions.autoindex.spec.ts` — the positional constructor gains an `AfterCommitService` right after the audit argument; add the rollback case for the index.
- `apps/api/src/approvals/approval-execution.service.spec.ts` — add the deferred-execution after-commit cases; existing cases stay.
- `apps/api/test/integration/memory/outbox-envelope.integration.spec.ts` — the positional constructor gains an `AfterCommitService` right after the audit argument; assertions stay.
- `apps/api/test/integration/vcs/auto-create-pr-on-verified.integration.spec.ts` — both positional constructors gain an `AfterCommitService` right after the audit argument, and both mocked Prisma clients' `ticketLink` gain a `count` mock answering 0 by default (the real repository's `hasPrLink` reads it); add the existing-PR-link case.
- `apps/api/test/integration/outbox/producer-atomicity.integration.spec.ts` — its Nest testing module provides `TicketTransitionsService` directly, so its providers gain `AfterCommitService`; assertions stay.
- `apps/api/test/integration/tickets/ticket-tenancy.integration.spec.ts` — its testing module's providers gain `AfterCommitService`; assertions stay.
- `apps/api/test/integration/tickets/ticket-transition-race.integration.spec.ts` — its testing module's providers gain `AfterCommitService`; assertions stay.
- `apps/api/test/integration/rag/rag-close-to-search.integration.spec.ts` — its testing module's providers gain `AfterCommitService`; assertions stay.

**US-007**

- `apps/api/src/fleet/git-broker/github-app-client.ts` — gains `mintThreadReadToken`, `getReviewThread` and the exported `ReviewThreadInfo`.
- `apps/api/src/fleet/git-broker/github-app-client.spec.ts` — add the `mintThreadReadToken` and `getReviewThread` cases; existing cases stay.
- `apps/api/src/fleet/reviews/review-event.minter.ts` — mints with `mintThreadReadToken`, collects every writer, calls `getReviewThread` once, and mints verified or unverified.
- `apps/api/src/fleet/reviews/review-event.minter.spec.ts` — the GitHub client mock gains `mintThreadReadToken` and `getReviewThread` (answering a matching thread whose authors include the existing cases' approver); every assertion on `mintReadOnlyToken` (the one in the test titled AC-1/2/3 around line 61, and those in AC-9, AC-10 and AC-11) asserts `mintThreadReadToken` instead; AC-6's expected `getRepoRole` logins grow to every non-bot login (`['carol', 'alice', 'dave']`) because the loop no longer stops at the first writer; other assertions stay.
- `apps/api/src/memory/review-decision.writer.ts` — the audit summary reads the verified or unverified wording from the action context.
- `apps/api/src/memory/review-decision.writer.spec.ts` — add the verified and unverified summary cases; existing cases stay.
- `apps/api/test/integration/memory/review-decision-writer.integration.spec.ts` — the exact summary it asserts under `satisfiedBy: 'human'` changes from "(one of the thread's commenters)" to "(verified thread author)".

**US-008**

- `packages/fleet-protocol/src/index.ts` — `TokenRequest` gains `fresh?: true` (types only).
- `apps/api/src/fleet/sync/sync-request.parser.ts` — `parseTokenRequest` keeps `fresh: true`, drops `fresh: false`, refuses any other value.
- `apps/api/src/fleet/sync/sync.service.ts` — `grantTokens` forwards `fresh: true` for FIX and REVIEW jobs only.
- `apps/api/src/fleet/git-broker/git-token.broker.ts` — `mint` skips cache reuse when `fresh` is true and replaces the entry.
- `apps/api/src/fleet/sync/sync-request.parser.spec.ts` — add the `fresh` cases; existing cases stay.
- `apps/api/src/fleet/sync/sync.service.token-purpose.spec.ts` — add the forwarding cases; existing cases that assert the exact `mint` argument stay valid because a request without `fresh` adds no key.
- `apps/api/src/fleet/git-broker/git-token.broker.spec.ts` — add the fresh-mint cases; existing cases stay.

**US-009**

- `apps/runner/src/credentials/token-cache.ts` — gains `requireFresh`, `error`, the composed request rule and the `fresh` flag.
- `apps/runner/src/credentials/token-cache.spec.ts` — add the fresh cases; existing cases stay.
- `apps/runner/src/sync/batch.ts` — `buildSyncRequest` forwards `fresh: true` on a token request that carries it.
- `apps/runner/src/sync/batch.spec.ts` — add the `fresh` forwarding cases; the existing exact-shape assertion for a request without `fresh` (around line 119) stays as it is.

**US-010**

- `apps/runner/src/credentials/broker.ts` — gains `freshToken` and the optional `CredentialProvider.freshToken`.
- `apps/runner/src/executor/host-executor.ts` — `reviewEnv` and `spawnFixStep` use `freshToken(job, FORGE_TOKEN_MIN_REMAINING_MS)`; exports the constant.
- `apps/runner/test/unit/broker.spec.ts` — add the `freshToken` cases; existing cases stay.
- `apps/runner/test/unit/host-executor.spec.ts` — the injected-world helper's fake provider gains `freshToken` answering `{ ok: true, token: TOKEN }` by default; its `currentToken: null` option (used by the cases around lines 704, 783 and 838 that expect `git token: none`) becomes a `freshToken` refusal or absence that keeps those expectations; its `omitCurrentToken` option also omits `freshToken`; the inline provider around line 754 that has only `currentToken` gains `freshToken`; add the new cases.

### Seams

- `minMode` on `RouteGateCall` (US-001) is consumed by `TicketsController.verifyFix`, `verify` and `close` (US-003) and
  `ProjectsController.update` (US-004). Each consumer has unit ACs asserting the exact `routeGate.run` argument and
  integration ACs entering through the real HTTP route and real gate, asserting 202 and the unchanged row, so a gate
  that ignores `minMode` fails them.
- `selfFixApprovalFloor` (US-002) is consumed by the three routes (US-003); its integration ACs enter through
  `POST /api/projects/:slug/tickets/:ref/verify-fix`, `/verify` and `/close` after a real `/fix`.
- The after-commit helper (US-006) relies on `ApprovalExecutionService.executeOnce`'s existing `afterCommit.scope`
  wrapper; a US-006 AC drives `ApprovalExecutionService.execute` with a command that defers a task, so the composition
  is tested at the entry point the deferred approval path uses.
- `TokenRequest.fresh` (US-008) is produced by the runner's `TokenCache.requests` and put on the wire by
  `buildSyncRequest` (US-009), and consumed by the API parser (US-008). Each side has unit ACs on the same wire shape
  (a `fresh` property whose value is the boolean `true`, present only when set); the runner-side seam AC sits at
  `buildSyncRequest`, the last runner hop before the HTTP body.
- `TokenCache.requireFresh` and `TokenCache.error` (US-009) are consumed by `CredentialBroker.freshToken` (US-010),
  whose ACs drive a real `TokenCache`.

## Acceptance Criteria

### US-001: Approval gate takes a minimum mode

- `[unit]` `ApprovalGate.gate` for an AGENT actor, with the resolver answering mode `none` (source `default`) for the key and `opts.minMode` `'agent'`, returns `status: 'pending'`, and the opened request's `requiredMode` is `'agent'`.
- `[unit]` with the resolver answering mode `self` from a policy with `onTimeout: 'approve'` and `opts.minMode` `'agent'`, the opened request's `policyId` is null and its `onTimeout` is `'reject'`.
- `[unit]` the same call as the first without `minMode` executes the command and returns `status: 'executed'` with approval `requiredMode: 'none'`.
- `[unit]` with the resolver answering `'human'` from a policy with id `p-1` and `opts.minMode` `'agent'`, the opened request's `requiredMode` is `'human'` and its `policyId` is `'p-1'`.
- `[unit]` for a USER actor with the resolver answering `none` and `opts.minMode` `'agent'`, the command executes and the outcome's approval is `{ requiredMode: 'agent', satisfiedBy: 'human', approverType: 'USER', approverId: <the user's id> }`.
- `[unit]` with `alsoKeys: ['k2']`, the primary key resolving `none`, `k2` resolving `self` and `opts.minMode` `'agent'`, the opened request's `requiredMode` is `'agent'`.
- `[unit]` with `alsoKeys: ['k2']`, the primary key resolving `none`, `k2` resolving `human` and `opts.minMode` `'agent'`, the opened request's `requiredMode` is `'human'`.
- `[unit]` with the resolver answering mode `none` and source `'not-approvable'` and `opts.minMode` `'agent'`, the gate executes the command and opens no request.
- `[unit]` `ApprovalRouteGate.run({ key, variant, projectId, input, minMode: 'agent' })` calls `gate.gate` once with an opts object whose `minMode` is `'agent'`.
- `[unit]` `ApprovalRouteGate.run` with no `minMode` calls `gate.gate` with an opts object that has no `minMode` property.

### US-002: The ticket service answers the self-fix approval floor

- `[integration]` `PrismaTicketsRepository.findLatestStatusChangeActor(ticketId, 'VERIFY_FIX')`, with a `STATUS_CHANGE` row to `VERIFY_FIX` by user U and a later one by agent A, returns `{ type: 'AGENT', id: A }`.
- `[integration]` with those rows plus a later `STATUS_CHANGE` row to `CLOSED` by user U2, it still returns `{ type: 'AGENT', id: A }`.
- `[integration]` for a ticket with no `STATUS_CHANGE` row to `VERIFY_FIX` it returns `null`.
- `[unit]` `TicketsService.selfFixApprovalFloor('alpha', 'AL-1', <agent principal agent-1>)` for a VERIFY_FIX ticket, with the repository answering `{ type: 'AGENT', id: 'agent-1' }`, returns `'agent'` and called `findLatestStatusChangeActor` once with the ticket's id and `'VERIFY_FIX'`.
- `[unit]` for the same ticket with the repository answering `{ type: 'AGENT', id: 'agent-2' }`, it returns `undefined`.
- `[unit]` for the same ticket with the repository answering `{ type: 'USER', id: 'agent-1' }`, it returns `undefined`.
- `[unit]` for a user principal `u-1` and the repository answering `{ type: 'USER', id: 'u-1' }`, it returns `'agent'`.
- `[unit]` for the same ticket with the repository answering `null`, it returns `undefined`.
- `[unit]` for an IN_PROGRESS ticket it returns `undefined` and never calls `findLatestStatusChangeActor`.
- `[unit]` for a ref with no ticket in the project it rejects with `NotFoundAppException`, as `findByRef` does.

### US-003: Verify-fix, verify and close apply the self-fix floor

- `[unit]` `TicketsController.verifyFix` with `approve` `'true'` and `selfFixApprovalFloor` answering `'agent'` calls `routeGate.run` once with `{ key: 'ticket.transition.verify-fix.approve', variant: 'rest:tickets.verify-fix', projectId: 'project-1', input: { slug, ref, body }, minMode: 'agent' }`.
- `[unit]` `verifyFix` with `approve` `'true'` and `selfFixApprovalFloor` answering `undefined` calls `routeGate.run` with an argument that has no `minMode` property.
- `[unit]` `verifyFix` with `approve` `'false'` never calls `selfFixApprovalFloor`, and `routeGate.run`'s argument has key `'ticket.transition.verify-fix.return'` and no `minMode` property.
- `[unit]` `TicketsController.verify` with `selfFixApprovalFloor` answering `'agent'` calls `routeGate.run` with `key: 'ticket.transition.verify'` and `minMode: 'agent'`.
- `[unit]` `TicketsController.close` with `selfFixApprovalFloor` answering `'agent'` calls `routeGate.run` with `key: 'ticket.transition.close'` and `minMode: 'agent'`.
- `[integration]` with no approval policies, an agent holding the Developer role that sent `POST /api/projects/:slug/tickets/:ref/fix` on an IN_PROGRESS ticket then sends `POST .../verify-fix?approve=true` and gets HTTP 202 whose request has `permissionKey` `'ticket.transition.verify-fix.approve'` and `requiredMode` `'agent'`.
- `[integration]` after that parked verify-fix the ticket's status is still `VERIFY_FIX`.
- `[integration]` with no approval policies, the same fix-submitting agent sends `POST .../verify` on the VERIFY_FIX ticket and gets HTTP 202 whose request has `permissionKey` `'ticket.transition.verify'`.
- `[integration]` with no approval policies, the same fix-submitting agent sends `POST .../close` on the VERIFY_FIX ticket and gets HTTP 202 whose request has `permissionKey` `'ticket.transition.close'`.
- `[integration]` the fix-submitting agent, also holding `approval.decide`, sends `POST /api/approvals/:id/decisions` with `{ "decision": "approve" }` for its own parked verify-fix request and gets HTTP 403, and the ticket's status is still `VERIFY_FIX`.
- `[integration]` with no approval policies, a second agent holding `ticket.transition.verify-fix.approve`, which did not submit the fix, sends the approve and gets HTTP 200, and the ticket's status is then `CLOSED`.
- `[integration]` with no approval policies, the root user who submitted the fix sends the approve and gets HTTP 200, and the ticket's status is then `CLOSED`.

### US-004: Credential writes are high risk and a CI token rotation needs agent mode

- `[unit]` `CREDENTIAL_KEYS` is importable from `permissions/catalog` and equals the set `{'agent.create', 'agent.key.rotate', 'user.create'}`.
- `[unit]` for each key in `CREDENTIAL_KEYS`, `findCatalogEntry(key)` has `risk` `'high'` and `approval.default` `'agent'`.
- `[unit]` `findCatalogEntry('agent.update')` still has `risk` `'medium'`.
- `[unit]` `ProjectsController.update('alpha', { ciWebhookToken: 'tok' }, project)` calls `routeGate.run` once with `key: 'project.update'`, `variant: 'rest:projects.update-ci-token'` and `minMode: 'agent'`.
- `[unit]` `ProjectsController.update('alpha', { ciWebhookToken: null }, project)` calls `routeGate.run` with `minMode: 'agent'`.
- `[unit]` `ProjectsController.update('alpha', { name: 'New' }, project)` calls `routeGate.run` once with `variant: 'rest:projects.update'` and an argument that has no `minMode` property.
- `[integration]` with no approval policies, an agent holding `project.read` and `project.update` in the project sends `PATCH /api/projects/:slug` with `{ "ciWebhookToken": "<new>" }` and gets HTTP 202.
- `[integration]` after that parked PATCH the project's `ciWebhookToken` is unchanged.
- `[integration]` with no approval policies, the same agent sends `PATCH /api/projects/:slug` with `{ "name": "<new>" }` and gets HTTP 200.
- `[integration]` with no approval policies, an agent holding the global `agent.create` sends `POST /api/agents` and gets HTTP 202 with a pending request whose `permissionKey` is `'agent.create'`.
- `[integration]` after that parked create no agent row with that slug exists.
- `[integration]` with no approval policies, the root user's `POST /api/agents` gets HTTP 201 with an `apiKey`.

### US-005: Only an Owner can disable an Owner

- `[unit]` `UsersAdminService.update({ type: 'USER', id: 'admin-1' }, 'owner-1', { disabled: true })`, with `effectiveKeys` answering `role.binding.owner` for `owner-1` and not for `admin-1`, rejects with `ForbiddenAppException` whose i18n key is `users.owner`.
- `[unit]` in that refused case the repository's `updateUser` is never called.
- `[unit]` with the actor `{ type: 'AGENT', id: 'agent-1' }` lacking `role.binding.owner` and the same target, `update` rejects with `ForbiddenAppException` (`users.owner`).
- `[unit]` with the actor `{ type: 'USER', id: 'owner-2' }` holding `role.binding.owner`, disabling `owner-1` calls `updateUser` with `disabled: true`.
- `[unit]` with the actor `admin-1` disabling a target whose keys do not include `role.binding.owner`, `updateUser` is called with `disabled: true`.
- `[unit]` with the actor `admin-1` sending `{ disabled: false }` for `owner-1`, `updateUser` is called and no `ForbiddenAppException` is raised.
- `[unit]` with the actor `{ type: 'USER', id: 'owner-1' }` disabling itself, `update` rejects with `ForbiddenAppException` whose i18n key is `users.self`, as before.
- `[unit]` the registered `user.update` command run by an agent principal with id `agent-1` calls `UsersAdminService.update` with `{ type: 'AGENT', id: 'agent-1' }` as the first argument.
- `[integration]` a global admin who is not an Owner sends `PATCH /api/admin/users/:ownerId` with `{ "disabled": true }` and gets HTTP 403 with the message "Only an Owner can disable an Owner".
- `[integration]` after that refusal the Owner's `disabled` is still false.
- `[integration]` a second Owner sends the same PATCH for the first Owner, with another active admin present, and gets HTTP 200, and the first Owner's `disabled` is then true.

### US-006: Transition PR creation and RAG indexing run after commit

- `[unit]` `TicketTransitionsService.verify` called outside any `AfterCommitService.scope`, with a VCS provider stub, calls the provider's `createPullRequest` once before `verify` resolves.
- `[unit]` `verify` called inside `afterCommit.scope(...)` whose callback then throws calls the provider's `createPullRequest` zero times.
- `[unit]` `verify` called inside `afterCommit.scope(...)` whose callback resolves calls `createPullRequest` once, and that call happens after the callback has returned.
- `[unit]` the CLOSED transition called inside `afterCommit.scope(...)` whose callback then throws calls `ragService.indexDocument` zero times, with `autoIndexOnClose` true.
- `[unit]` the CLOSED transition called inside `afterCommit.scope(...)` whose callback resolves has called `ragService.indexDocument` once by the time the scope resolves, with `autoIndexOnClose` true.
- `[unit]` the CLOSED transition called outside any scope, with `ragService.indexDocument` returning a promise that never settles, still resolves with the CLOSED ticket.
- `[unit]` `verify` with the repository's `hasPrLink` answering true calls the provider's `createPullRequest` zero times and still resolves with the VERIFIED ticket.
- `[unit]` `verify` with the repository's `hasPrLink` rejecting calls `createPullRequest` zero times, logs a warning through the class logger, and still resolves with the VERIFIED ticket.
- `[unit]` `verify` with the provider's `createPullRequest` rejecting resolves with the VERIFIED ticket and logs a warning through the class logger.
- `[unit]` `ApprovalExecutionService.execute` of an approved request whose command's execution calls `AfterCommitService.defer(task)` runs `task` once, after the request has been settled `executed`.
- `[unit]` `ApprovalExecutionService.execute` of an approved request whose command defers `task` and whose settle transition finds the request no longer approved never runs `task`.
- `[integration]` `PrismaTicketsRepository.hasPrLink(ticketId)` answers true for a ticket with a `TicketLink` whose `linkType` is `'pr'` and `source` is not FLEET.
- `[integration]` `hasPrLink(ticketId)` answers false for a ticket whose only `TicketLink` has a `linkType` other than `'pr'`.
- `[integration]` in the auto-create-PR suite, verifying a ticket that already has a `'pr'` link creates no new `TicketLink` and makes no `createPullRequest` call.

### US-007: A review decision's approver is verified against the thread

- `[unit]` `GitHubAppClient.mintThreadReadToken(installationId, 'app')` requests an installation token whose `permissions` are exactly `{ contents: 'read', pull_requests: 'read', metadata: 'read' }` for repository `app`.
- `[unit]` `GitHubAppClient.getReviewThread('tok', 'PRRT_1')` sends one POST to `<githubApiUrl>/graphql` with an `authorization` header `Bearer tok` and a body whose `variables` is `{ id: 'PRRT_1' }`.
- `[unit]` with `githubApiUrl` `https://ghe.example/api/v3`, the POST goes to `https://ghe.example/api/graphql`.
- `[unit]` a 200 answer whose `data.node` holds PR number 7 in repository `acme/app` with comment authors `alice`, `null` and `alice` returns `{ repoOwner: 'acme', repoName: 'app', prNumber: 7, authors: ['alice'] }`.
- `[unit]` a 200 answer whose `data.node` is null, and a 200 answer with an `errors` array and no `data`, each return `null`.
- `[unit]` a 502 answer rejects with `RepoCheckException` whose reason is `provider_error`.
- `[unit]` `ReviewEventMinter` for an event on PR 7 of `acme/app` with `disagreedBy: ['alice']`, `alice` holding `write` and `getReviewThread` answering that PR and repo with authors `['alice']`, mints once under an approval `{ requiredMode: 'human', satisfiedBy: 'human', approverType: 'FORGE_USER', approverId: 'github:alice' }`.
- `[unit]` in that verified case the minter minted its token with `mintThreadReadToken` and never called `mintReadOnlyToken`.
- `[unit]` the same event with thread authors `['bob']` mints once under `satisfiedBy: 'none'` and `approverId: 'github:alice'`.
- `[unit]` the same event mints once under `satisfiedBy: 'none'` when `getReviewThread` answers `null`, and also when it rejects.
- `[unit]` the same event mints once under `satisfiedBy: 'none'` when `getReviewThread` answers PR 8 of `acme/app`, and also when it answers PR 7 of `acme/other`, with authors `['alice']`.
- `[unit]` an event with `disagreedBy: ['bob', 'alice']`, both holding `write`, and thread authors `['alice']` mints under `satisfiedBy: 'human'` and `approverId: 'github:alice'`.
- `[unit]` an event with `disagreedBy: ['Alice']` and thread authors `['alice']` mints under `satisfiedBy: 'human'`.
- `[unit]` an event whose `disagreedBy` logins all hold `read` is skipped with reason `no-writer`, and `getReviewThread` is never called.
- `[unit]` `ReviewDecisionWriter.mint` run under an approval with `satisfiedBy: 'none'` and `approverId: 'github:alice'` records an audit entry whose summary contains `github:alice (unverified)`.

### US-008: The API honours a fresh token request for FIX and REVIEW

- `[unit]` the sync request parser, given a token request `{ jobId: 'j1', leaseEpoch: 1, fresh: true }`, returns that entry with `fresh: true`.
- `[unit]` given `{ jobId: 'j1', leaseEpoch: 1, fresh: false }`, it returns an entry with no `fresh` property.
- `[unit]` given `{ jobId: 'j1', leaseEpoch: 1, fresh: 'yes' }`, it throws the `ValidationAppException` the parser raises for an invalid `tokenRequest`.
- `[unit]` `GitTokenBroker.mint` with `purpose: 'fix'` and a cached token for the same job and epoch that expires in 50 minutes, called with `fresh: true`, calls the GitHub client's `mintInstallationToken` once and returns the new token.
- `[unit]` the same call without `fresh` returns the cached token and calls neither `mintInstallationToken` nor `mintReadOnlyToken`.
- `[unit]` after that fresh mint, a following `mint` for the same job and epoch without `fresh` returns the new token without calling `mintInstallationToken`.
- `[unit]` `GitTokenBroker.mint` with `purpose: 'review'` and `fresh: true` over a cached review token calls the client's `mintReviewToken` once.
- `[unit]` `SyncService.grantTokens` for a held FIX job and a request `{ jobId, leaseEpoch, fresh: true }` calls `broker.mint` once with an argument whose `fresh` is true.
- `[unit]` the same for a held REVIEW job calls `broker.mint` with `fresh` true.
- `[unit]` the same for a held RUN job calls `broker.mint` with an argument that has no `fresh` property.
- `[unit]` a FIX job's request without `fresh` calls `broker.mint` with an argument that has no `fresh` property.

### US-009: The runner token cache asks for a fresh token

- `[unit]` `TokenCache` (refresh margin 5 minutes) holding a job's token with 40 minutes left, after `requireFresh(jobId, epoch, 3_000_000)`, returns from `requests(now)` the entry `{ jobId, leaseEpoch: epoch, fresh: true }`.
- `[unit]` with the token at 55 minutes left after the same `requireFresh`, `requests(now)` has no entry for that job.
- `[unit]` with no `requireFresh` and the token at 40 minutes left, `requests(now)` has no entry for that job.
- `[unit]` with no `requireFresh` and the token at 3 minutes left, `requests(now)` has an entry for the job with no `fresh` property.
- `[unit]` after `requireFresh` and `apply` of a token with 59 minutes left, `state(...)` answers that token and `requests(now)` has no entry for the job.
- `[unit]` after `requireFresh` and `apply` of a token with 40 minutes left, `requests(now + 1)` has no entry for the job.
- `[unit]` in that same case `requests(now + cooldownMs + 1)` has the entry with `fresh: true`.
- `[unit]` `requireFresh` for a job with no entry makes `wanted(jobId, epoch)` true and `requests(now)` return `{ jobId, leaseEpoch: epoch, fresh: true }`.
- `[unit]` `requireFresh` calls each `onNeed` listener once.
- `[unit]` after `requireFresh` and `requireFresh(jobId, epoch, 0)`, with the token at 40 minutes left, `requests(now)` has no entry for that job.
- `[unit]` with a live token at 40 minutes left and an `apply` that carries an error `'default_branch_unprotected'` for the job, `error(jobId, epoch)` returns `'default_branch_unprotected'` while `state(...)` still answers the live token.
- `[unit]` `requireFresh` clears a stored error: after it, `error(jobId, epoch)` returns `null`.
- `[unit]` `buildSyncRequest` given token requests `[{ jobId: 'j1', leaseEpoch: 1, fresh: true }, { jobId: 'j2', leaseEpoch: 1 }]` emits `tokenRequests` `[{ jobId: 'j1', leaseEpoch: 1, fresh: true }, { jobId: 'j2', leaseEpoch: 1 }]`, the second with no `fresh` property.

### US-010: FIX and REVIEW write a forge token with at least 50 minutes left

- `[unit]` `CredentialBroker.freshToken(job, 3_000_000)` over a real `TokenCache` holding a token with 40 minutes left returns `{ ok: true, token: 'new' }` once the cache has been given a token `'new'` with 59 minutes left.
- `[unit]` `freshToken` over a cache holding a live token with 40 minutes left returns `{ ok: false, reason: 'git token: default_branch_unprotected' }` once the cache has been given that error for the job.
- `[unit]` `freshToken` returns `{ ok: false, reason: 'git token: timeout' }` when no qualifying token arrives within `waitMs`.
- `[unit]` after that timeout, `requests(now)` on the cache has no `fresh` entry for the job.
- `[unit]` `freshToken` over a cache whose token already has 55 minutes left returns `{ ok: true }` at once, and afterwards `requests(now)` has no entry for the job.
- `[unit]` `FORGE_TOKEN_MIN_REMAINING_MS` is importable from `executor/host-executor` and equals `3_000_000`.
- `[unit]` starting a REVIEW job calls the provider's `freshToken` once with the job and `3_000_000`, and the job's `forge-token` file then holds the returned token.
- `[unit]` starting a FIX job's review step (the `reviewEnv` path) calls `freshToken` with the job and `3_000_000`, and `forge-token` then holds the returned token.
- `[unit]` starting a FIX job's fix step (`spawnFixStep`) calls `freshToken` with the job and `3_000_000`, and `forge-token` then holds the returned token.
- `[unit]` starting a FIX job's fix step whose `freshToken` answers `{ ok: false, reason: 'git token: timeout' }` throws an error with message `git token: timeout`.
- `[unit]` in that refused case no `forge-token` file exists in the job directory.
- `[unit]` starting a REVIEW job with a provider that has no `freshToken` throws an error with message `git token: none`.
