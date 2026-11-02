# SPEC: Whole-repo review P1 bundle (token scope, sweep isolation, ingest caps, knowledge sources, gate bypasses, branch-protection probe, runner git hardening)

Closes: #382

## Summary

This feature fixes the P1 findings of the 2026-11-01 whole-repo review (`docs/20261101-review-whole-repo.md`) that
need no further ruling, plus koda issue #382. It closes eight holes:

1. **B/SEC-2 (ruling 3: refuse).** A PROJECT-thread job's token request without a `repoId` still gets a
   `contents: write` token for the thread's anchor repo. The server now refuses it with `repo_not_assigned`, as it
   already does for WORKSPACE threads.
2. **B/BUG-1.** One job whose crash transaction throws ends the whole silent-runner sweep, and a throwing placement
   step makes the runner's sync answer 500 after its reports committed, so it gets no commands and no git tokens.
   Each sweep item and each placement call is now isolated, logged and skipped.
3. **B/MEM-1.** Bundle ingest caps only the size of each file, so a bundle of thousands of large, well-compressing
   allowlisted files exhausts API memory. The reader now also caps the total bytes it keeps and the files per slot.
4. **C/SEC-1.** The repository-knowledge store reads, replaces and deletes rows by `source_id` alone, so a KB writer
   can plant a `doc` row that `koda_get_doc` serves as repository or outcome content, and the indexer silently
   deletes user rows that share an id. Every store filter now also names the row's `source`, and the KB add route
   refuses the reserved `repo:` and `outcome:` id prefixes.
5. **A/SEC-4.** The MCP `koda_decide_approval` tool records a decision without the approval gate that the REST
   decide route applies. It now goes through the same gate and answers `pending: <id>` when the decision parks.
6. **A/SEC-5 (strictest of both).** `PATCH /tickets/:ref` with a `status` is gated only under `ticket.update`, so a
   policy on the edge key (`ticket.transition.start`) is skipped. Such a PATCH is now gated under its edge key, and
   the gate also resolves `ticket.update` and applies the stricter of the two modes, in one approval request.
7. **#382.** A FIX on a private repo of a free-plan account is refused with `provider_error`, because the rulesets
   endpoint answers 403 "Upgrade to GitHub Pro". The probe now falls through to the classic branch endpoint, so the
   refusal reads `default_branch_unprotected`.
8. **D/SEC-2.** The runner's own git calls in the shared clone honour repo-local hooks and config that a raw REVIEW or
   FIX agent can write. Every runner git call now disables hooks, fsmonitor and submodule recursion.

The bundle spans `apps/api` and `apps/runner`. No schema change, no migration, no web change.

## Motivation

The 2026-11-01 review graded koda C+ (74/100). The P0 bundle (#381, deployed 2026-11-02) closed the four HIGH
findings. The P1 rows of its Priority Fix Order are next. Three P1 rows wait on rulings and are not in this bundle
(see Out of Scope).

- **PROJECT anchor token (B/SEC-2).** `SyncService.grantTokens` refuses a repo-less request only when
  `findThreadTokenScope(job.id)` answers `kind: 'WORKSPACE'`. A PROJECT thread job stores the anchor repo id, so a
  repo-less request from it falls to `findRepo(job.repoId)` and gets a write token. The runner's PROJECT path is a
  no-checkout path (`isNoCheckoutKind` in `apps/runner/src/thread/thread-job-run.ts`) and never asks for that token.
  The user ruled on 2026-11-02 to refuse it (least privilege), rather than close it as covered by Ruling 5.
- **Sweep and sync isolation (B/BUG-1).** `FleetSweeper.crashSilent` runs one transaction per silent job with no
  try/catch, so a deterministic throw for one job stops every later job from being crashed, on every tick.
  `SyncService.sync` awaits `placement.fillRunner` and `placement.fillRunnerThreads` unguarded; a throw there answers
  the runner 500 after its reports committed, and the runner gets no CANCEL/ABANDON/APPROVAL_ANSWER commands and no git
  tokens, so a FIX or RUN waiting for its forge token stalls. The project rule is "one failing job or ack in a sync is
  logged and skipped".
- **Decompression bomb (B/MEM-1).** `readBundleFiles` (`apps/api/src/fleet/ingest/bundle-reader.ts`) checks each
  entry against `INGEST_LIMITS.fileBytes` (32 MiB) and keeps everything else. K2 added the `botReview` array slot and
  the 32 MiB `naxStdout` slot. Thousands of 32 MiB allowlisted entries that compress well fit under the compressed
  upload cap, and the reader buffers all of them before `parseBundle` runs; the single API instance runs out of
  memory, then retries the claim after restart until `INGEST_MAX_ATTEMPTS`.
- **Knowledge source confusion (C/SEC-1).** `KnowledgeChunkStore.readFile`, `replaceFile` and `deleteFile` filter on
  `source_id = '<id>'` only. The table `project_<id>` is shared with KB documents. A holder of `kb.document.add` posts
  `{ source: 'doc', sourceId: 'repo:<repoId>:docs/SECURITY.md', metadata: { text: '<instructions>', chunkIndex: 0 } }`;
  every later `koda_get_doc` of that file (`KnowledgeSearchService.readDoc`) serves the planted chunk as repository
  content, and `readOutcome` does the same for `outcome:<repoId>:<jobId>:<kind>`. The next index pass over the file
  deletes the user's row without `kb.document.delete` and without an audit entry. Search is unaffected: both its legs
  already filter on `source`.
- **MCP decide bypass (A/SEC-4).** `ApprovalMcpTools`' `koda_decide_approval` handler calls
  `ApprovalDecisionService.decide` directly. The REST route `POST /api/approvals/:id/decisions` calls
  `assertMayDecide`, then `ApprovalRouteGate.run({ key: 'approval.decide', ... })`, which honours a policy on
  `approval.decide`. With a policy "agent decisions need a human", an agent's REST decision parks, while the same
  agent's MCP decision executes at once.
- **PATCH status bypass (A/SEC-5).** `TicketsController.update` gates every PATCH under `ticket.update`. With a status,
  `TicketsService.update` checks the edge key's permission (`assertTransitionAllowed`) but no approval policy on it.
  Through PATCH only the comment-less edges CREATED/VERIFIED -> IN_PROGRESS (`ticket.transition.start`) can succeed.
  A project policy `ticket.transition.start` -> `agent` is skipped: the agent's PATCH starts the ticket at once. The
  user ruled on 2026-11-02 for one gate call that applies the stricter of the two keys' modes.
- **Branch-protection probe (#382).** `GitHubAppClient.isBranchProtected` first calls
  `GET /repos/{owner}/{repo}/rules/branches/{branch}`. For a private repo of a free-plan account GitHub answers 403
  "Upgrade to GitHub Pro or make this repository public to enable this feature.", and the probe throws
  `RepoCheckException('provider_error')`. The koda-wk live check of 2026-11-02 (P0 bundle deploy) saw FIX fail with
  `git token: provider_error` on such a repo, while `GET /branches/main` answers 200 `protected: false`. The refusal is
  correct; only its reason is wrong.
- **Runner git hooks (D/SEC-2).** `createGit().run` (`apps/runner/src/executor/git.ts`) adds only the
  `credential.helper` `-c` arguments. REVIEW and FIX are always raw, and `nax bot` creates PR worktrees from the shared
  clone, which share the main gitdir's `config` and `hooks`. A raw agent that writes `core.hooksPath` or
  `core.fsmonitor` gets code run by the next job's `ensureClone`/`checkout` inside the daemon, which holds every job's
  credential sockets.

## Design

### Calls made in this spec

1. **PROJECT repo-less refusal (B/SEC-2).** In `SyncService.grantTokens`, the repo-less branch for a THREAD job
   refuses with `{ jobId, reason: 'repo_not_assigned' }` when the thread token scope's `kind` is `'WORKSPACE'` **or**
   `'PROJECT'`, for every turn action. REPO threads and every non-THREAD command keep minting from
   `findRepo(job.repoId)` exactly as today.
2. **Sweep isolation (B/BUG-1).** In `FleetSweeper.crashSilent`, each silent id's transaction and its post-commit
   effects run inside their own try/catch. A throw is logged with `this.logger.warn` as
   `Silent-runner crash of job <id> failed: <error name>` (the error's `name`, never its message) and the loop moves on
   to the next id. A failed id is not counted in the returned total.
3. **Sync placement isolation (B/BUG-1).** In `SyncService.sync`, the `placement.fillRunner` call and the
   `placement.fillRunnerThreads` call each run inside their own try/catch. A throw is logged with `this.logger.error`
   as `Sync: placement for runner <runnerId> failed: <error name>`, and the sync continues to `afterTerminal`,
   `grantTokens` and `deliver`. A `fillRunner` throw does not skip `fillRunnerThreads`. `afterTerminal` is unchanged
   (its effects are already fire-and-forget).
4. **Ingest caps (B/MEM-1).** `INGEST_LIMITS` gains `totalBytes: 67_108_864` (64 MiB) and `maxFilesPerSlot: 5_000`.
   `readBundleFiles(bundle, limits = INGEST_LIMITS)` takes an optional second parameter typed
   `Readonly<Record<'fileBytes' | 'totalBytes' | 'maxFilesPerSlot', number>>` (not a `Pick` of the `as const` object,
   whose literal types would refuse test values) so tests can use small caps; the
   ingest service keeps calling it with one argument. For each allowlisted regular-file entry, in tar order, the checks
   compose as an ordered pipeline, first match wins:
   1. `header.size > limits.fileBytes` -> skipped (the existing rule);
   2. for an array slot (`cost`, `reviews`, `finishResults`, `finishLast`, `botReview`), the slot already holds
      `limits.maxFilesPerSlot` files -> skipped;
   3. `keptBytes + header.size > limits.totalBytes`, where `keptBytes` is the sum of `header.size` of entries kept so
      far -> skipped;
   4. otherwise the entry is read and kept, and `keptBytes` grows by `header.size`.

   A skipped entry is drained with `resume()` and never buffered. Its name is appended to `oversized`, except for the
   `botReview` and `naxStdout` slots, which are skipped silently (the existing rule for those two slots). An entry
   skipped by rule 2 or 3 does not count toward `keptBytes`, so a later smaller entry that fits is still kept.
   `tar-stream` emits exactly `header.size` bytes per entry, so counting by header size is exact. A non-empty
   `oversized` already makes `parseBundle` answer a partial outcome (`parse-bundle.ts:59`), so no parser change. A small
   single-file slot (`status.json`, `workflow/result.json`) that arrives after the total cap is used up is skipped and
   reported the same way; that is intended, a bundle that large is already partial.
5. **Knowledge store source filters (C/SEC-1).** `KnowledgeChunkStore.readFile`, `replaceFile` and `deleteFile` keep
   their signatures. Each derives the row source from the id prefix: `repo:` -> `REPO_SOURCE` (`'repo'`), `outcome:`
   -> `OUTCOME_SOURCE` (`'outcome'`); any other id throws `KnowledgeInvalidPathError` (its constructor may take an
   optional reason so the message can say the id has no reserved prefix), after the existing
   `isSafeFilterValue` check. Each then filters with the existing `sourceRowFilter(source, sourceId)` from
   `rag/lance-table-manager`, so a `doc`, `manual` or `ticket` row that shares the id is never read, replaced or
   deleted. `replaceFile` also requires every row's `source` to equal the derived source, else
   `KnowledgeInvalidPathError`.
6. **Reserved KB id prefixes (C/SEC-1).** `AddDocumentDto.sourceId` refuses a value that starts with `repo:` or
   `outcome:`: validation fails on `sourceId` with the message `sourceId must not start with a reserved prefix
   (repo:, outcome:)`. The KB add route (`POST /api/projects/:slug/kb/documents`) parses its body with this DTO, so it
   answers 400 and writes no row. Only the start of the id is checked: `notes:repo:x` is accepted.
7. **MCP decide through the gate (A/SEC-4).** The `koda_decide_approval` handler keeps its input checks, then mirrors
   the REST decide route: `queries.get(ref, id)` for visibility, `decisions.assertMayDecide(id)`, then
   `routeGate.run({ key: 'approval.decide', variant: APPROVAL_ROUTE_VARIANTS.decide, projectId:
   visible.request.projectId, input: { requestId: id, decision, comment, params? }, keyCheck: false })`, where
   `params` is present in `input` only when the caller sent it. Outcomes:
   - `status: 'pending'` -> tool result `pending: <outcome.request.id>`, `isError: false`;
   - `status: 'executed'` and `decision: 'approve'` -> `execution.execute(id)`, then `<record.id> <record.status>`;
   - `status: 'executed'` and `decision: 'reject'` -> `<outcome.result.id> <outcome.result.status>`.

   Error mapping keeps today's four (`not_found`, `not_pending: <status>`, `expired`, `forbidden: <reason>`) and adds
   `ForbiddenAppException` -> `forbidden: permissions`. `ApprovalMcpTools` gains constructor dependencies
   `ApprovalRouteGate` and `ApprovalExecutionService`; both are already providers of `ApprovalEngineModule`, the
   module that provides `ApprovalMcpTools`.
8. **Strictest-of-keys gate (A/SEC-5).** `ApprovalGate.gate`'s `opts` gains `alsoKeys?: readonly string[]`. When it
   is present and non-empty, the gate resolves the primary key and each extra key for the same subject and project,
   and uses the resolution with the highest-ranked mode (`APPROVAL_MODE_RANK`); on a tie the primary key's
   resolution wins. The command, the request's `permissionKey` and the variant stay the primary key's. When `alsoKeys`
   is absent or empty, the gate resolves only the primary key, as today. `RouteGateCall` gains the same optional
   `alsoKeys`, and `ApprovalRouteGate.run` passes it into the gate's `opts` only when present (so the existing
   `{ projectId, variant }` shape is unchanged for every other route).
9. **PATCH status gating (A/SEC-5).** `TicketsController.update`: when the parsed patch has a `status`, it reads the
   ticket with `ticketsService.findByRef(slug, ref)` and computes `edgeKey = transitionKeyFor(ticket.status,
   patch.status)`. When `edgeKey` is defined it calls `routeGate.run({ key: edgeKey, variant:
   TICKET_ROUTE_VARIANTS.updateStatus, projectId, input: { slug, ref, patch }, alsoKeys: ['ticket.update'] })`, where
   `TICKET_ROUTE_VARIANTS.updateStatus` is `'rest:tickets.update-status'`. Otherwise (no status, or no edge between the
   two statuses) it keeps today's `ticket.update` call; the service then refuses an impossible transition as today.
   `transition-keys.ts` exports `TICKET_EDGE_KEYS`, the distinct values of its edge table
   (`ticket.transition.verify`, `ticket.transition.start`, `ticket.transition.reject`, `ticket.transition.fix`,
   `ticket.transition.verify-fix.approve`, `ticket.transition.verify-fix.return`). `TicketRouteCommands` registers the
   `'rest:tickets.update-status'` variant under each of them, with the same parse and run as the `ticket.update`
   command (`this.service.update(slug, ref, patch, principal)`).
10. **Rulesets fall-through (#382).** In `GitHubAppClient.isBranchProtected`, a rules response with status 404, or
    with status 403 whose body `message` matches `/upgrade to github pro|make this repository public/i`, is treated as
    "no rulesets" and the probe goes on to the classic `GET /branches/{branch}`. Every other non-200 rules status, a
    non-array 200 body, a network error and every existing classic-endpoint failure still throw
    `RepoCheckException('provider_error')`. `GitTokenBroker.mint` already turns `false` into the resolved value
    `{ ok: false, error: { jobId, reason: 'default_branch_unprotected' } }` (it never rejects), so a FIX on such a
    repo now fails with `git token: default_branch_unprotected`. The broker is unchanged.
11. **Runner git hardening (D/SEC-2).** `createGit().run` spawns
    `git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c submodule.recurse=false <helper args> <args>`. A
    `-c` setting outranks repo-local config wherever it sits on the command line; the three settings apply to every call the daemon makes
    through `createGit` (clone, fetch, checkout, clean, commit, push).

### Integration

Symbols this feature only reads:

- `ChatThreadKind` (`'REPO' | 'PROJECT' | 'WORKSPACE'`) and `FleetJobRepository.findThreadTokenScope(jobId):
  Promise<{ kind: ChatThreadKind; action: string } | null>`.
- `sourceRowFilter(source: string, sourceId: string): string`, `REPO_SOURCE = 'repo'`, `OUTCOME_SOURCE = 'outcome'`,
  `isSafeFilterValue` (`apps/api/src/rag/lance-table-manager.ts`).
- `ApprovalDecisionService.assertMayDecide(requestId: string): Promise<void>`,
  `ApprovalExecutionService.execute(requestId: string, now?: Date): Promise<ApprovalRequestRecord>`,
  `APPROVAL_ROUTE_VARIANTS.decide = 'rest:approvals.decide'`.
- `APPROVAL_MODE_RANK`, `modeAtLeast(mode, required)` (`apps/api/src/approvals/domain/approval-mode.ts`).
- `ApprovalPolicyResolver.resolve({ key, projectId, subject }): Promise<ResolvedApproval>` with
  `ResolvedApproval = { mode, floor, policy, source }`.
- `transitionKeyFor(from: TicketStatus, to: TicketStatus): string | undefined`,
  `TicketsService.findByRef(projectSlug, ref)`.
- `GitTokenBroker.mint` (resolves `{ ok: false, error: { jobId, reason: 'default_branch_unprotected' } }` when
  `isBranchProtected` answers `false`; it never rejects).
- `parseBundle` (`apps/api/src/fleet/ingest/parse-bundle.ts`): a non-empty `oversized` makes the outcome partial.

Symbols this feature changes. The baseline only locates the code; the target is the interface to implement.

- `INGEST_LIMITS`
  - Baseline: `{ fileBytes, costEvents, stories, reviews, shortText, idText, reasonText, errorText }`.
  - Target: the same keys plus `totalBytes: 67_108_864` and `maxFilesPerSlot: 5_000`.
- `readBundleFiles`
  - Baseline: `readBundleFiles(bundle: Readable): Promise<BundleFiles>`.
  - Target: `readBundleFiles(bundle: Readable, limits?: Readonly<Record<'fileBytes' | 'totalBytes' |
    'maxFilesPerSlot', number>>): Promise<BundleFiles>`, `limits` defaulting to `INGEST_LIMITS`.
- `ApprovalMcpTools` constructor
  - Baseline: `(queries: ApprovalRequestQueries, decisions: ApprovalDecisionService)`.
  - Target: `(queries: ApprovalRequestQueries, decisions: ApprovalDecisionService, routeGate: ApprovalRouteGate,
    execution: ApprovalExecutionService)`.
- `ApprovalGate.gate`
  - Baseline: `gate<TResult>(key, input, opts: { projectId: string | null; variant?: string }, now?)`.
  - Target: `gate<TResult>(key, input, opts: { projectId: string | null; variant?: string; alsoKeys?: readonly
    string[] }, now?)`.
- `RouteGateCall`
  - Target: gains `alsoKeys?: readonly string[]`.
- `TICKET_ROUTE_VARIANTS`
  - Target: gains `updateStatus: 'rest:tickets.update-status'`.
- `transition-keys.ts`
  - Target: also exports `TICKET_EDGE_KEYS: readonly string[]`, the six distinct edge keys listed in call 9.

### Failure Handling

| Path | Behaviour |
|:---|:---|
| PROJECT thread repo-less token request | `gitTokenErrors` entry `{ jobId, reason: 'repo_not_assigned' }`, no mint, no `findRepo` (fail closed). |
| One silent job's crash transaction throws | `logger.warn` with the job id and error name; later ids still processed; not counted. |
| `fillRunner` or `fillRunnerThreads` throws in a sync | `logger.error` with runner id and error name; tokens and commands still delivered in that sync. |
| Bundle entry over a cap | drained unread; name in `oversized` (except `botReview`, `naxStdout`); outcome partial. |
| Knowledge store id with neither reserved prefix | `KnowledgeInvalidPathError`, no table call. |
| KB add with a reserved prefix | 400 validation error on `sourceId`, no row. |
| MCP decide parks | `pending: <request id>`, `isError: false`, nothing executed. |
| MCP decide refused by the route gate key check | `forbidden: permissions`, `isError: true`. |
| Rulesets 403 plan-upgrade or 404 | classic probe decides; `protected: false` -> FIX refused `default_branch_unprotected`. |
| Rulesets 403 with any other message, 5xx, network | `provider_error` (fail closed, unchanged). |

## Out of Scope

- A/SEC-3 (verify-fix self-approval rule) and A/SEC-6 (re-tier credential write keys) are not in this bundle; they are separate P1 work.
- A/BUG-1 (move PR creation and email out of the approval execution transaction) is not in this bundle.
- C/SEC-2 (verify that a forge approver replied in the thread) waits on review ruling 14 and is not in this bundle.
- D/BUG-2 (a fresh forge token for FIX and REVIEW) waits on review ruling 4 and is not in this bundle.
- Forcing nax's OS sandbox for raw job kinds (review ruling 5 on D/SEC-2) is not decided and not built; only the runner's own git calls are hardened.
- The endpoint e2e file gains no MCP or runner-sync cases: those routes keep their request and response shapes, and their behaviour changes are covered by the integration ACs.
- US-009 only: `-c protocol.file.allow=never` is not added to runner git calls, because `assertCloneUrl` accepts `file://` remotes by design and the runner's tests clone from local `file://` fixtures.
- US-009 only: git invocations made by nax itself (inside `nax bot` or a nax run) are not changed; only calls made through the runner's `createGit` are.
- US-003 only: marking a failed ingest claim terminal before `INGEST_MAX_ATTEMPTS` is not changed; the new caps remove the out-of-memory path that made retries repeat.
- US-003 only: replacing the copy-on-append of slot arrays with in-place pushes is not required; the per-slot cap bounds the copy cost.
- US-004 only: KB documents already stored with a `repo:` or `outcome:` id are not migrated or deleted; after this change they are no longer served by `koda_get_doc` and no longer deleted by the indexer.
- US-004 only: search ranking and the search legs' filters are unchanged; both already filter on `source`.
- US-007 only: an edge key reachable through `PATCH /tickets/:ref` other than `ticket.transition.start` still fails in the transition service as today (those edges need a comment); this bundle only gates them correctly before that refusal.
- US-008 only: no web, CLI or assistant copy is added for `default_branch_unprotected`; the job page shows the reason text as it does today.
- US-008 only: GitLab repos are unchanged; the branch-protection probe is GitHub-only.

## Stories

This bundle has 9 stories, one package each. It is a bundle of independent P1 fixes, not one capability. The user
chose one bundle on 2026-11-02, as for the P0 bundle (#381). Stories are split by the 15-AC cap counted as atomic
assertions, not by count.

### US-001: Sync refuses the PROJECT anchor token

No dependencies. Workdir: apps/api. Call 1: the PROJECT branch of the repo-less token refusal in
`SyncService.grantTokens`.

### US-002: Sweep and sync placement failures are isolated per item

No dependencies. Workdir: apps/api. Calls 2 and 3: the per-item try/catch in `FleetSweeper.crashSilent` and the
guarded placement calls in `SyncService.sync`.

### US-003: Bundle reader caps total kept bytes and files per slot

No dependencies. Workdir: apps/api. Call 4: `INGEST_LIMITS.totalBytes`, `INGEST_LIMITS.maxFilesPerSlot`, the optional
`limits` parameter of `readBundleFiles` and the ordered skip pipeline.

### US-004: Knowledge store filters by source, KB add refuses reserved prefixes

No dependencies. Workdir: apps/api. Calls 5 and 6: the prefix-derived source filter in `KnowledgeChunkStore.readFile`,
`replaceFile` and `deleteFile`, and the reserved-prefix validation on `AddDocumentDto.sourceId`.

### US-005: MCP approval decide goes through the approval gate

No dependencies. Workdir: apps/api. Call 7: the `koda_decide_approval` handler calls `assertMayDecide` and
`ApprovalRouteGate.run` exactly as the REST decide route does, and answers `pending: <id>` when the decision parks.

### US-006: Approval gate resolves extra keys and applies the strictest mode

No dependencies. Workdir: apps/api. Call 8: `alsoKeys` on `ApprovalGate.gate` and on `RouteGateCall`, and its
forwarding in `ApprovalRouteGate.run`.

### US-007: Ticket PATCH with a status is gated under its edge key and ticket.update

Depends on US-006. Workdir: apps/api. Call 9: `TICKET_EDGE_KEYS`, the `'rest:tickets.update-status'` registrations
and the status branch of `TicketsController.update`, which passes `alsoKeys: ['ticket.update']`.

### US-008: Branch-protection probe falls through when rulesets are unavailable

No dependencies. Workdir: apps/api. Call 10: the 404 and plan-upgrade 403 fall-through in
`GitHubAppClient.isBranchProtected`.

### US-009: Runner git ignores repo hooks, fsmonitor and submodule recursion

No dependencies. Workdir: apps/runner. Call 11: the fixed `-c` prefix in `createGit().run`.

### Context Files

**US-001**

- `apps/api/src/fleet/sync/sync.service.ts`
- `apps/api/src/fleet/sync/sync-token-fence.spec.ts`
- `apps/api/test/integration/fleet/fleet-project-code-token-fence.integration.spec.ts`

**US-002**

- `apps/api/src/fleet/sync/sync.service.ts`
- `apps/api/src/fleet/sync/fleet-sweeper.ts`
- `apps/api/src/fleet/sync/fleet-sweeper.spec.ts`
- `apps/api/src/approvals/approval-request-expiry.sweeper.ts`

**US-003**

- `apps/api/src/fleet/ingest/bundle-reader.ts`
- `apps/api/src/fleet/ingest/domain/bundle-ingest.domain.ts`
- `apps/api/src/fleet/ingest/bundle-reader.spec.ts`
- `apps/api/src/fleet/ingest/parse-bundle.ts`

**US-004**

- `apps/api/src/fleet/knowledge/knowledge-chunk-store.ts`
- `apps/api/src/rag/lance-table-manager.ts`
- `apps/api/src/rag/dto/add-document.dto.ts`
- `apps/api/test/integration/fleet/knowledge-store.integration.spec.ts`
- `apps/api/test/integration/rag/gated-kb-add-route.integration.spec.ts`

**US-005**

- `apps/api/src/approvals/mcp/approval-mcp-tools.ts`
- `apps/api/src/approvals/approval-requests.controller.ts`
- `apps/api/src/approvals/route/approval-route-gate.ts`
- `apps/api/src/memory/mcp/memory-mcp-tools.ts`
- `apps/api/test/integration/approvals/approval-mcp-decide.integration.spec.ts`

**US-006**

- `apps/api/src/approvals/approval-gate.service.ts`
- `apps/api/src/approvals/route/approval-route-gate.ts`
- `apps/api/src/approvals/approval-policy.resolver.ts`
- `apps/api/src/approvals/domain/approval-mode.ts`

**US-007**

- `apps/api/src/tickets/tickets.controller.ts`
- `apps/api/src/tickets/ticket-route.commands.ts`
- `apps/api/src/tickets/state-machine/transition-keys.ts`
- `apps/api/src/tickets/tickets.service.ts`

**US-008**

- `apps/api/src/fleet/git-broker/github-app-client.ts`
- `apps/api/src/fleet/git-broker/github-app-client.branch-protection.spec.ts`

**US-009**

- `apps/runner/src/executor/git.ts`
- `apps/runner/src/executor/git.spec.ts`

### Creates

**US-001**

None.

**US-002**

None.

**US-003**

None.

**US-004**

- `apps/api/src/rag/dto/add-document.dto.spec.ts`

**US-005**

None.

**US-006**

None.

**US-007**

- `apps/api/test/integration/tickets/ticket-patch-status-gate.integration.spec.ts`

**US-008**

None.

**US-009**

None.

### Modifies

**US-001**

- `apps/api/src/fleet/sync/sync.service.ts` — `grantTokens` refuses a repo-less THREAD request with `repo_not_assigned` when the scope kind is `'WORKSPACE'` or `'PROJECT'`, for every turn action.
- `apps/api/src/fleet/sync/sync-token-fence.spec.ts` — add the PROJECT repo-less refusal cases beside "workspace AC-7 refuses the anchor token without repoId"; every existing case stays.
- `apps/api/test/integration/fleet/fleet-project-code-token-fence.integration.spec.ts` — add one case whose token request for the held PROJECT thread job carries no `repoId` (the file's `requestFor` helper always sends one, so the case builds its request without it); existing cases stay.

**US-002**

- `apps/api/src/fleet/sync/fleet-sweeper.ts` — `crashSilent` wraps each id's transaction and post-commit effects in a try/catch that logs `Silent-runner crash of job <id> failed: <error name>` with the class logger's `warn` and continues.
- `apps/api/src/fleet/sync/sync.service.ts` — `sync` wraps `placement.fillRunner` and `placement.fillRunnerThreads` each in its own try/catch that logs `Sync: placement for runner <runnerId> failed: <error name>` with the class logger's `error`.
- `apps/api/src/fleet/sync/fleet-sweeper.spec.ts` — add the per-item isolation cases (the logger is observed by spying on the Nest `Logger` prototype's `warn`); existing cases stay.
- `apps/api/src/fleet/sync/sync-token-fence.spec.ts` — the `harness()` helper exposes its `placement` mock so a case can make `fillRunner` or `fillRunnerThreads` reject; add the placement-failure cases, each sending `freeSlots > 0` and protocol version 4 (the logger is observed by spying on the Nest `Logger` prototype's `error`); existing cases stay.

**US-003**

- `apps/api/src/fleet/ingest/domain/bundle-ingest.domain.ts` — `INGEST_LIMITS` gains `totalBytes: 67_108_864` and `maxFilesPerSlot: 5_000`; every other key keeps its value.
- `apps/api/src/fleet/ingest/bundle-reader.ts` — `readBundleFiles` takes the optional `limits` parameter and applies the ordered skip pipeline of call 4.
- `apps/api/src/fleet/ingest/bundle-reader.spec.ts` — add the total-bytes and files-per-slot cases using small injected `limits`; existing cases stay.

**US-004**

- `apps/api/src/fleet/knowledge/knowledge-chunk-store.ts` — `readFile`, `replaceFile` and `deleteFile` derive the source from the id prefix, throw `KnowledgeInvalidPathError` for an id with neither prefix, and filter with `sourceRowFilter(source, sourceId)`; `replaceFile` also refuses a row whose `source` differs from the derived source.
- `apps/api/src/fleet/knowledge/knowledge-chunk-store.spec.ts` — add the prefix-derivation and refusal cases; any fake table that captures the delete or where predicate expects the `source = '<source>' AND source_id = '<id>'` form; existing refusal cases stay.
- `apps/api/src/rag/dto/add-document.dto.ts` — `sourceId` gains a validator refusing a value that starts with `repo:` or `outcome:`, with the message of call 6.
- `apps/api/test/integration/fleet/knowledge-store.integration.spec.ts` — the test "deleteFile removes the file rows and keeps a ticket row of the same table (AC-9)" reads the ticket row back with a direct query on `manager.getOrCreateTable(...)` filtered on `source_id = 'ticket:t1'` instead of `store.readFile(PROJECT, 'ticket:t1')`, which now refuses an unprefixed id; its assertion that the ticket row survives stays. Add the shared-id cases; every other case stays.
- `apps/api/test/integration/rag/gated-kb-add-route.integration.spec.ts` — add the reserved-prefix 400 case; existing cases stay.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — add one case beside the KB document add tests: a KB document add POST whose sourceId is repo:x:y.md answers 400 (rule: endpoint changes are reflected here). Existing cases stay.

**US-005**

- `apps/api/src/approvals/mcp/approval-mcp-tools.ts` — the constructor gains `ApprovalRouteGate` and `ApprovalExecutionService`; the `koda_decide_approval` handler follows call 7.
- `apps/api/src/approvals/mcp/approval-mcp-tools.spec.ts` — both `tools()` helpers (the list describe's near line 12 and the decide describe's near line 65) construct `ApprovalMcpTools` with stub `routeGate` (with `run`), `assertMayDecide` on the decisions stub, and stub `execution` (with `execute`); the `get` stub answers `{ request: { projectId: 'p1' } }` instead of `{}`; the decide cases that expect `decisions.decide` to be called with `('r1', 'approve', null)` or with `params` instead expect `routeGate.run` to be called with `key: 'approval.decide'`, `variant: 'rest:approvals.decide'`, `keyCheck: false` and the matching `input`; the "AC-10/11/12/13 maps error" table rejects each error from the stubbed `routeGate.run` instead of `decide`, with the same expected texts; the list cases and the input-validation cases stay, with their `decide` not-called assertions also holding for `routeGate.run`.
- `apps/api/test/integration/approvals/approval-mcp-decide.integration.spec.ts` — add the parked-decision case under an `approval.decide` policy; the existing case "AC-14: a REST agent decides another agent's pending P request and the request is executed" keeps its `<id> executed` answer.

**US-006**

- `apps/api/src/approvals/approval-gate.service.ts` — `gate`'s `opts` gains `alsoKeys`; with a non-empty `alsoKeys` the gate resolves every key and uses the highest-ranked mode's resolution, the primary key's on a tie.
- `apps/api/src/approvals/route/approval-route-gate.ts` — `RouteGateCall` gains `alsoKeys`; `run` passes it in the gate `opts` only when present.
- `apps/api/src/approvals/approval-gate.service.spec.ts` — add the `alsoKeys` cases; existing cases stay.
- `apps/api/src/approvals/route/approval-route-gate.spec.ts` — add the `alsoKeys` forwarding case; the existing assertion that the gate is called with `{ projectId: 'p1', variant: 'rest:tickets.update' }` stays unchanged.

**US-007**

- `apps/api/src/tickets/state-machine/transition-keys.ts` — exports `TICKET_EDGE_KEYS`, the six distinct values of the edge table.
- `apps/api/src/tickets/ticket-route.commands.ts` — `TICKET_ROUTE_VARIANTS` gains `updateStatus: 'rest:tickets.update-status'`; `onModuleInit` registers that variant under each key of `TICKET_EDGE_KEYS` with the `ticket.update` command's parse and run.
- `apps/api/src/tickets/ticket-route.commands.spec.ts` — add the registration cases for the new variant; existing cases stay.
- `apps/api/src/tickets/tickets.controller.ts` — `update` follows call 9.
- `apps/api/src/tickets/tickets.controller.spec.ts` — the controller harness `build()` gives its `ticketsService` stub a `findByRef` member; the existing case "update gates the DTO under ticket.update in CurrentProject scope" (patch `{ title }`, no status) keeps its exact `run` expectation; add the status cases.
- `apps/api/test/integration/tickets/gated-ticket-write-routes.integration.spec.ts` — the test "AC-4: approved status patch fails when the agent lacks the edge key" (agent holds `ticket.update` but not `ticket.transition.start`, wait policy on `ticket.update`, PATCH `{ status: 'IN_PROGRESS' }`) now expects HTTP 403 at once and no `ApprovalRequest` row for that ticket, because the edge key is the gate's primary key and the route gate's key check refuses a caller who does not hold it; every other test in the file stays.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — add one case beside the ticket PATCH tests: a root user's ticket PATCH with status IN_PROGRESS on a CREATED ticket answers 200 (rule: endpoint changes are reflected here). Existing cases stay.

**US-008**

- `apps/api/src/fleet/git-broker/github-app-client.ts` — `isBranchProtected` treats a rules 404, or a rules 403 whose body `message` matches the plan-upgrade text, as "no rulesets" and continues to the classic branch probe.
- `apps/api/src/fleet/git-broker/github-app-client.branch-protection.spec.ts` — add the fall-through cases; the "AC-8/9/12: fails closed for endpoint failure" table stays.

**US-009**

- `apps/runner/src/executor/git.ts` — `createGit().run` puts the three settings core.hooksPath=/dev/null, core.fsmonitor=false and submodule.recurse=false, each as a `-c` pair, before the helper args.
- `apps/runner/src/executor/git.spec.ts` — add the hardening cases; existing cases stay.

### Seams

- `alsoKeys` on `RouteGateCall` and `ApprovalGate.gate` (US-006) is consumed by `TicketsController.update` (US-007).
  The US-007 integration ACs enter through `PATCH /api/projects/:slug/tickets/:ref` with the real gate, and assert on
  the response status and the ticket's status, so a gate that ignores `alsoKeys` fails the `ticket.update` policy case.
- `TICKET_EDGE_KEYS` (US-007) is consumed by `TicketRouteCommands.onModuleInit` (US-007), whose unit AC asserts a
  registered command per key.
- The `limits` parameter of `readBundleFiles` (US-003) is a test seam only; the ingest service keeps the one-argument
  call, so production uses `INGEST_LIMITS`.

## Acceptance Criteria

### US-001: Sync refuses the PROJECT anchor token

- `[unit]` `SyncService.sync` for a THREAD job whose `findThreadTokenScope` answers `{ kind: 'PROJECT', action: 'SESSION' }`, with a token request `{ jobId, leaseEpoch }` and no `repoId`, answers `gitTokenErrors` `[{ jobId, reason: 'repo_not_assigned' }]`.
- `[unit]` in the same PROJECT SESSION case the response's `gitTokens` is `[]`.
- `[unit]` in the same PROJECT SESSION case the broker's `mint` is never called.
- `[unit]` in the same PROJECT SESSION case the repository's `findRepo` is never called.
- `[unit]` `SyncService.sync` for a THREAD job whose scope is `{ kind: 'PROJECT', action: 'PUBLISH' }` with a repo-less token request answers `gitTokenErrors` `[{ jobId, reason: 'repo_not_assigned' }]`.
- `[unit]` `SyncService.sync` for a THREAD job whose scope is `{ kind: 'REPO', action: 'SESSION' }` with a repo-less token request calls the broker's `mint` once with the repo that `findRepo(job.repoId)` answers.
- `[unit]` `SyncService.sync` for a RUN job with a repo-less token request calls the broker's `mint` once with the repo that `findRepo(job.repoId)` answers.
- `[integration]` a runner whose held THREAD job belongs to a PROJECT thread sends `POST /api/fleet/runner/sync` with a token request for that job and no `repoId`; the response's `gitTokenErrors` holds `{ jobId, reason: 'repo_not_assigned' }`.
- `[integration]` in the same sync the response's `gitTokens` holds no entry for that job.

### US-002: Sweep and sync placement failures are isolated per item

- `[unit]` `FleetSweeper.sweep` with `findSilentHeldIds` answering `['j1', 'j2']`, where the transition apply for `j1` rejects with an `Error` named `TransitionError` whose message is `secret-detail`, still applies the `CRASHED` transition to `j2`.
- `[unit]` that sweep resolves `1`.
- `[unit]` during that sweep the logger's `warn` is called with `Silent-runner crash of job j1 failed: TransitionError`, and no logged text contains the thrown error's message `secret-detail`.
- `[unit]` `FleetSweeper.sweep` with `findSilentHeldIds` answering `['j1', 'j2']`, where `lockById` rejects for `j1`, still applies the `CRASHED` transition to `j2`.
- `[unit]` `SyncService.sync` with `freeSlots > 0` where `placement.fillRunner` rejects resolves without throwing.
- `[unit]` in that `fillRunner` rejection case the response's `commands` holds the commands `findPendingCommands` answered.
- `[unit]` in that `fillRunner` rejection case, with a repo-less token request for a held RUN job, the response's `gitTokens` holds the minted token.
- `[unit]` `SyncService.sync` with `freeSlots > 0` and protocol version 4 where `placement.fillRunner` rejects still calls `placement.fillRunnerThreads` once.
- `[unit]` `SyncService.sync` with `freeSlots > 0` and protocol version 4 where `placement.fillRunnerThreads` rejects with an `Error` named `PlacementError` resolves without throwing.
- `[unit]` in that `fillRunnerThreads` rejection case the logger's `error` is called with `Sync: placement for runner <runnerId> failed: PlacementError`.

### US-003: Bundle reader caps total kept bytes and files per slot

- `[unit]` `INGEST_LIMITS.totalBytes` equals `67108864` and `INGEST_LIMITS.maxFilesPerSlot` equals `5000`.
- `[unit]` `readBundleFiles(bundle, { fileBytes: 100, totalBytes: 150, maxFilesPerSlot: 10 })` over three 60-byte files `nax-out/cost/a.jsonl`, `nax-out/cost/b.jsonl`, `nax-out/cost/c.jsonl` (in that order) answers `cost` holding `a` and `b` only, and `oversized` `['nax-out/cost/c.jsonl']`.
- `[unit]` with the same limits, files `nax-out/cost/a.jsonl` (60 bytes), `nax-out/cost/b.jsonl` (100 bytes) and `nax-out/cost/c.jsonl` (40 bytes) answer `cost` holding `a` and `c`, and `oversized` `['nax-out/cost/b.jsonl']`.
- `[unit]` with the same limits, a 60-byte `nax-out/cost/a.jsonl` and a 60-byte `nax-out/metrics.json` followed by a 60-byte `nax.stdout` answer `naxStdout` `null` and an `oversized` list that does not name `nax.stdout`.
- `[unit]` with `{ fileBytes: 100, totalBytes: 10000, maxFilesPerSlot: 2 }`, three small `nax-out/review-audit/f/s<N>.json` files answer `reviews` holding the first two only, and `oversized` naming the third.
- `[unit]` with `{ fileBytes: 100, totalBytes: 10000, maxFilesPerSlot: 2 }`, three small entries `nax-out/bot/pr-1/a/bot-review.json`, `nax-out/bot/pr-1/b/bot-review.json` and `nax-out/bot/pr-1/c/bot-review.json` answer `botReview` holding two files and an empty `oversized`.
- `[unit]` with `{ fileBytes: 50, totalBytes: 100, maxFilesPerSlot: 10 }`, a 60-byte `nax-out/metrics.json` followed by two 50-byte cost files answer `cost` holding both cost files and `oversized` `['nax-out/metrics.json']`, because a file over `fileBytes` adds nothing to the kept total.

### US-004: Knowledge store filters by source, KB add refuses reserved prefixes

- `[integration]` with a real LanceDB table holding a `repo` row and a `doc` row that both have `source_id` `repo:r1:docs/a.md`, `KnowledgeChunkStore.readFile(project, 'repo:r1:docs/a.md')` answers only the `repo` row.
- `[integration]` with a real table holding an `outcome` row and a `doc` row that both have `source_id` `outcome:r1:j1:report`, `readFile(project, 'outcome:r1:j1:report')` answers only the `outcome` row.
- `[integration]` with a real table holding a `repo` row and a `doc` row with `source_id` `repo:r1:docs/a.md`, after `deleteFile(project, 'repo:r1:docs/a.md')` the `doc` row is still in the table and the `repo` row is gone.
- `[integration]` with the same two rows, after `replaceFile(project, 'repo:r1:docs/a.md', [<new repo row>])` the `doc` row is still in the table and the only `repo` row is the new one.
- `[unit]` table-driven over `readFile`, `deleteFile` and `replaceFile`: each called with the source id `docs/a.md` (no reserved prefix) rejects with `KnowledgeInvalidPathError` and makes no table call.
- `[unit]` `replaceFile('p1', 'repo:r1:a.md', [<row with source 'doc' and source_id 'repo:r1:a.md'>])` rejects with `KnowledgeInvalidPathError`.
- `[unit]` table-driven over the source ids `repo:r1:docs/a.md` and `outcome:r1:j1:report`: validating `AddDocumentDto` with `{ source: 'doc', sourceId: <id>, content: 'x' }` yields a validation error on `sourceId` with the message `sourceId must not start with a reserved prefix (repo:, outcome:)`.
- `[unit]` validating `AddDocumentDto` with `{ source: 'doc', sourceId: 'notes:repo:x', content: 'x' }` yields no validation errors.
- `[integration]` a project member holding `kb.document.add` sends `POST /api/projects/:slug/kb/documents` with `{ source: 'doc', sourceId: 'repo:r1:docs/a.md', content: 'x' }`; it gets HTTP 400.
- `[integration]` after that refused request no KB row with `source_id` `repo:r1:docs/a.md` and `source` `doc` exists.

### US-005: MCP approval decide goes through the approval gate

- `[unit]` the `koda_decide_approval` handler for `{ id: 'r1', decision: 'approve' }`, with `queries.get` answering `{ request: { projectId: 'p1' } }`, calls `routeGate.run` once with `{ key: 'approval.decide', variant: 'rest:approvals.decide', projectId: 'p1', input: { requestId: 'r1', decision: 'approve', comment: null }, keyCheck: false }`.
- `[unit]` in that call `decisions.assertMayDecide` is called with `'r1'` before `routeGate.run`, and `decisions.decide` is never called.
- `[unit]` when `routeGate.run` answers `{ status: 'pending', request: { id: 'ar9' } }`, the handler answers content `pending: ar9` with `isError: false`.
- `[unit]` when `routeGate.run` answers `status: 'executed'` for `decision: 'approve'` and `execution.execute('r1')` answers a record `{ id: 'r1', status: 'executed' }`, the handler calls `execution.execute` with `'r1'` and answers content `r1 executed`.
- `[unit]` when `routeGate.run` answers `{ status: 'executed', result: { id: 'r1', status: 'rejected' } }` for `decision: 'reject'`, the handler answers content `r1 rejected`.
- `[unit]` for `{ id: 'r1', decision: 'approve', params: { remember: true } }`, the `input` passed to `routeGate.run` is `{ requestId: 'r1', decision: 'approve', comment: null, params: { remember: true } }`.
- `[unit]` when `assertMayDecide` rejects with `ApprovalDecideForbiddenError('distinct-approver-required')`, the handler answers `forbidden: distinct-approver-required` with `isError: true`.
- `[unit]` when `routeGate.run` rejects with `ForbiddenAppException`, the handler answers content `forbidden: permissions`.
- `[integration]` with a global approval policy `approval.decide` -> mode `human` for principal type AGENT, an agent that may decide another agent's pending request calls `koda_decide_approval` through `POST /api/mcp` with `decision: 'approve'`; the tool result text starts with `pending: `.
- `[integration]` after that parked call the original request's status is still `pending`.
- `[integration]` after that parked call an `ApprovalRequest` row with `permissionKey` `approval.decide` exists.

### US-006: Approval gate resolves extra keys and applies the strictest mode

- `[unit]` `ApprovalGate.gate('ticket.transition.start', input, { projectId: 'p1', variant: 'rest:tickets.update-status', alsoKeys: ['ticket.update'] })` for an AGENT subject, with the resolver answering mode `none` for `ticket.transition.start` and mode `agent` for `ticket.update`, answers `status: 'pending'`.
- `[unit]` in that call the opened request's `permissionKey` is `ticket.transition.start`.
- `[unit]` in that call the opened request's `requiredMode` is `agent`.
- `[unit]` the same call with the resolver answering mode `human` for `ticket.transition.start` and `agent` for `ticket.update` opens a request whose `requiredMode` is `human`.
- `[unit]` the same call with the resolver answering mode `none` for both keys runs the command at once and answers `status: 'executed'`.
- `[unit]` the same `alsoKeys` call with the resolver answering mode `agent` for both keys, from policies `pol-start` (primary) and `pol-update`, opens a request whose `policyId` is `pol-start`.
- `[unit]` `ApprovalGate.gate` called without `alsoKeys` calls the resolver exactly once, with the primary key.
- `[unit]` `ApprovalGate.gate` called with `alsoKeys: []` calls the resolver exactly once, with the primary key.
- `[unit]` `ApprovalRouteGate.run({ key: 'ticket.transition.start', variant: 'rest:tickets.update-status', projectId: 'p1', input, alsoKeys: ['ticket.update'] })` calls the gate with `('ticket.transition.start', input, { projectId: 'p1', variant: 'rest:tickets.update-status', alsoKeys: ['ticket.update'] })`.

### US-007: Ticket PATCH with a status is gated under its edge key and ticket.update

- `[unit]` `TICKET_EDGE_KEYS` is importable from `tickets/state-machine/transition-keys` and equals, in any order, `ticket.transition.verify`, `ticket.transition.start`, `ticket.transition.reject`, `ticket.transition.fix`, `ticket.transition.verify-fix.approve` and `ticket.transition.verify-fix.return`.
- `[unit]` after `TicketRouteCommands.onModuleInit`, `registry.get(key, 'rest:tickets.update-status')` is defined for every key of `TICKET_EDGE_KEYS`.
- `[unit]` executing the registered `ticket.transition.start` / `'rest:tickets.update-status'` command with `{ slug: 'alpha', ref: 'AL-1', patch: { status: 'IN_PROGRESS' } }` calls `ticketsService.update('alpha', 'AL-1', { status: 'IN_PROGRESS' }, <loaded principal>)` once.
- `[unit]` `TicketsController.update('alpha', 'AL-1', { status: 'IN_PROGRESS' }, principal, project)` with `findByRef` answering a ticket in status `CREATED` calls `routeGate.run` once with `{ key: 'ticket.transition.start', variant: 'rest:tickets.update-status', projectId: 'project-1', input: { slug: 'alpha', ref: 'AL-1', patch: { status: 'IN_PROGRESS' } }, alsoKeys: ['ticket.update'] }`.
- `[unit]` `TicketsController.update` with `{ status: 'CREATED' }` on a ticket in status `CLOSED` (no edge between them) calls `routeGate.run` once with `key: 'ticket.update'` and `variant: 'rest:tickets.update'`.
- `[integration]` with a project approval policy `ticket.transition.start` -> mode `agent` for principal type AGENT, an agent holding `ticket.update` and `ticket.transition.start` sends `PATCH /api/projects/:slug/tickets/:ref` with `{ "status": "IN_PROGRESS" }` on a CREATED ticket and gets HTTP 202 with `permissionKey` `ticket.transition.start`.
- `[integration]` after that parked PATCH the ticket's status is still `CREATED`.
- `[integration]` with a project approval policy `ticket.update` -> mode `agent` for principal type AGENT and none on the edge key, the same agent's status PATCH gets HTTP 202.
- `[integration]` after that parked PATCH the ticket's status is still `CREATED`.
- `[integration]` with no approval policies, the root user's `PATCH /api/projects/:slug/tickets/:ref` with `{ "status": "IN_PROGRESS" }` on a CREATED ticket gets HTTP 200 and the ticket's status is then `IN_PROGRESS`.
- `[integration]` an agent holding `ticket.update` but not `ticket.transition.start`, under a project policy `ticket.update` -> mode `agent`, sends the same status PATCH and gets HTTP 403.

### US-008: Branch-protection probe falls through when rulesets are unavailable

- `[unit]` `isBranchProtected('t', 'acme', 'app', 'main')` where the rules request answers 403 with body `{ message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' }` and the classic branch request answers 200 `{ protected: false }` resolves `false`.
- `[unit]` the same rules 403 answer followed by a classic answer 200 `{ protected: true }` resolves `true`.
- `[unit]` a rules answer 404 followed by a classic answer 200 `{ protected: false }` resolves `false`.
- `[unit]` after a plan-upgrade 403 rules answer, the second request is a GET to `https://github.test/repos/acme/app/branches/main`.
- `[unit]` a rules answer 403 with body `{ message: 'Resource not accessible by integration' }` rejects with `RepoCheckException` whose `reason` is `provider_error`.
- `[unit]` after that non-plan 403 rules answer no classic branch request is made.
- `[unit]` a plan-upgrade 403 rules answer followed by a classic answer 404 rejects with `RepoCheckException` whose `reason` is `provider_error`.

### US-009: Runner git ignores repo hooks, fsmonitor and submodule recursion

The fixture for each AC is a temporary directory made with `git init`, whose local config sets `user.name`,
`user.email` and `commit.gpgsign=false`, removed after the test. Outputs of `createGit().ok` are compared trimmed.

- `[unit]` in such a repo whose local config sets `core.hooksPath` to a directory holding an executable `pre-commit` hook that writes a marker file, `createGit().ok(['commit', '--allow-empty', '-m', 'x'], { cwd })` succeeds and the marker file does not exist afterwards.
- `[unit]` in such a repo whose local config sets `core.hooksPath` to `/tmp/elsewhere`, `createGit().ok(['config', '--get', 'core.hooksPath'], { cwd })` answers `/dev/null`.
- `[unit]` in such a repo whose local config sets `core.fsmonitor` to `true`, `createGit().ok(['config', '--get', 'core.fsmonitor'], { cwd })` answers `false`.
- `[unit]` in such a repo whose local config sets `submodule.recurse` to `true`, `createGit().ok(['config', '--get', 'submodule.recurse'], { cwd })` answers `false`.
- `[unit]` in such a repo, `createGit().ok(['config', '--get-all', 'credential.helper'], { cwd, credentialHelper: '!f() { echo x; }; f' })` returns raw output that, split on newlines, equals `['', '!f() { echo x; }; f', '']` (this AC compares the untrimmed output), so the helper args keep working after the new prefix.
