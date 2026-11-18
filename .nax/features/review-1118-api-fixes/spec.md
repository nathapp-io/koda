<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Review 2026-11-14 API fixes (duplicate PR adoption, status PATCH race, write conflicts, auth and secret hardening, review claim recovery, memory count, workflow comments, thread stream and runner labels)

## Summary

This feature fixes the API findings of the 2026-11-14 whole-repo review (`docs/20261114-review-whole-repo.md`) that
are still open on main `1fb137a83` and need no owner ruling. Each item was re-checked against the code on 2026-11-18.

1. **A/BUG-5 (second PR after a lost link).** Before a VERIFIED transition creates a ticket's PR, koda looks for an
   open PR on the ticket's branch and links that one instead of opening a second.
2. **A/BUG-6 (status PATCH gated on a stale edge).** A status PATCH whose ticket moved after the route picked its
   approval key is refused with `409` instead of running under the wrong edge's approval mode.
3. **A/BUG-4 remainder (unique violations become 500).** A concurrent duplicate ticket link returns the existing link;
   a concurrent duplicate project slug or key returns the same `409` the pre-check returns.
4. **A/BUG-3 (API-key lookup error reads as 401).** A database error while looking up an API key answers `503` instead
   of falling through to JWT and a `401`.
5. **A/SEC-9 (no secret length floor).** In production, `JWT_SECRET`, `JWT_REFRESH_SECRET` and `API_KEY_SECRET` must be
   at least 32 characters.
6. **A/SEC-10 (GCM tag length).** `decryptToken` accepts only a 16-byte authentication tag.
7. **A/ENH-2 (no shutdown hooks).** The API enables Nest shutdown hooks for `SIGTERM` and `SIGINT`.
8. **C/BUG-1 (stale review claim re-dispatches).** A stale `pending` review claim whose REVIEW job was in fact
   dispatched is linked to that job instead of being removed and dispatched again.
9. **C/PERF-2 (memory count per page).** A ranked memory page that is not full answers its total without a `count(*)`.
10. **A/ENH-1 remainder (workflow comments deletable).** A non-`GENERAL` comment can no longer be deleted.
11. **B/SEC-5 (thread stream re-check).** An open thread event stream closes when the viewer loses `thread.read`.
12. **B/SEC-3 (runner-chosen labels).** A new runner's labels are its enrollment's labels; labels the runner sends that
    the enrollment does not carry are dropped and recorded.
13. **C/STYLE-1 (duplicated classifier).** The review dispatcher and the FIX follow-up share one exception-response
    helper.

All stories are in `apps/api`.

## Motivation

The 2026-11-14 review graded koda B- (76/100). Its P0 and P1 auth items are fixed (#459, #460, #465). A re-check on
2026-11-18 found these API items still open with no owner decision needed. Each one is a reachable defect or a
hardening gap:

- A/BUG-5: `createPrForTicket` creates the PR and then writes the `TicketLink`. When the link write fails, the warning
  is logged and the PR stays open with no link. The next VERIFIED cycle passes the `hasPrLink` guard, and the provider
  refuses a second PR for the same branch, so the ticket never gets its link.
- A/BUG-6: `TicketsController.update` reads the ticket's status, picks the edge key, and gates on it. The command runs
  later (immediately, or after approval) against the ticket's live status. If the status changed in between, the edge
  taken was approved under another edge's mode.
- A/BUG-4: `TicketLinksService.create` and `ProjectsService.create/update` check uniqueness first and then write. Two
  concurrent requests both pass the check, and the loser's P2002 becomes a 500.
- A/BUG-3: `CombinedAuthGuard` catches every error from the API-key lookup, logs it and tries JWT. An agent whose key
  is valid gets `401` during a database blip and may treat its key as revoked.
- A/SEC-9: the env schema refuses only the `change-me` placeholder; a one-character production secret boots.
- A/SEC-10: `createDecipheriv('aes-256-gcm', ...)` without `authTagLength` accepts a truncated tag.
- A/ENH-2: without shutdown hooks, Nest lifecycle shutdown handlers (the RAG services' and the VCS webhook service's
  `onModuleDestroy`, and any later `onApplicationShutdown`) do not run on `SIGTERM`.
- C/BUG-1: when `markDispatched` fails after a REVIEW job was created, the claim stays `pending`. After one poll
  interval the dispatcher removes it as stale and dispatches a second review of the same head.
- C/PERF-2: every ranked memory page runs `count(*)` over every match.
- A/ENH-1: workflow comments (resolution, rejection, fix notes) cannot be edited but can still be deleted.
- B/SEC-5: the thread stream re-check confirms project membership only, so a member whose `thread.read` was removed
  keeps receiving events.
- B/SEC-3: any holder of an enrollment token can add labels such as `gpu` and attract jobs aimed at those labels.
- C/STYLE-1: two private copies of `getExceptionResponse` drift independently.

## Design

### Calls made in this spec

- **PR adoption.** The lookup runs after the `hasPrLink` guard and after `getDefaultBranch`, with the branch name
  `buildBranchName` returns. A lookup that throws is handled like the `hasPrLink` lookup failure: logged, and no PR is
  created, because a skipped PR is recoverable and a second PR is not. An adopted PR gets a `pr` link and runs
  `extractLinksFromPr` like a created one, but records no `VCS_PR_CREATED` activity, because koda did not create it.
  Only a PR from the connection's own repository is adopted: GitHub's `head: '{owner}:{branch}'` filter already scopes
  to the repository owner, and the GitLab lookup skips a merge request whose `source_project_id` differs from its
  `target_project_id` (a fork's merge request), taking the first same-project one.
- **Stale edge check.** The ticket route commands pass the edge key they were gated on to `TicketsService.update`:
  the `rest:tickets.update-status` commands pass their own key, and the `rest:tickets.update` command passes `null`
  (it was gated on `ticket.update`, not an edge). `executeTransitionInternal` compares it with
  `transitionKeyFor(ticket.status, toStatus) ?? null` for the ticket it loaded, right after loading it and before
  `assertEdgeAllowed`, validation and any write, and refuses a mismatch with the same `409` `HttpException` the
  conditional status write throws (`Ticket state changed concurrently`). So when both apply, the `409` wins over the
  edge `403`. The conditional write is keyed on that same loaded status, so the check and the write agree.
  A caller that passes no gated key (every caller other than the two route commands) keeps today's behaviour.
  `TicketsService.update` passes a sixth `options` argument to `executeTransitionPublic` only when its own `options`
  is defined, so existing five-argument call expectations keep holding.
- **Write conflicts.** The services catch the error outside `AuditRecorder.audited`, because a unique violation
  aborts the Postgres transaction it happened in. `isUniqueViolation(error, field)` from `common/utils/prisma-errors.ts`
  identifies it, so no service imports `@prisma/client`. The project services test `slug` before `key`:
  `isUniqueViolation` matches by substring when the target is an index name, and the slug index `Project_slug_key`
  contains `key`, so a key-first test would label a slug race as `key`.
- **API-key lookup.** Only an error thrown by `tryApiKey` changes. A key that matches no agent, an `OFFLINE` agent and
  a JWT-shaped bearer keep falling through to JWT. The `503` uses the existing pattern
  `new AppException(HttpStatus.SERVICE_UNAVAILABLE, {}, 'auth.keyLookupUnavailable', HttpStatus.SERVICE_UNAVAILABLE)`
  (as `provider-credentials.service.ts` does for `vaultOff`), with an i18n entry in `src/i18n/en/auth.json`
  (`"keyLookupUnavailable": { "503": "Authentication is temporarily unavailable; try again" }`) and the matching
  `src/i18n/zh/auth.json` entry.
- **Secret floor.** The 32-character minimum is part of the same production-only refusal as the placeholder check, so
  development and test environments keep short secrets. The deployed koda-wk secrets are 64 characters.
- **Shutdown hooks.** A small exported helper, `enableGracefulShutdown(app)`, calls
  `app.enableShutdownHooks(['SIGTERM', 'SIGINT'])` (`NathApp.enableShutdownHooks` in `@nathapp/nestjs-app` 4.2.4).
  `main.ts` calls it before `app.start`.
- **Review claim recovery.** The new lookup finds a REVIEW job for the claim's repo and `review-pr-<n>` feature created
  inside the claim's dispatch window, from the claim's `createdAt` to `createdAt` plus the poll interval
  (`prReviewPollMs`), in any state: the head was dispatched, and that job's outcome is the head's. A pass dispatches
  within seconds of inserting its claim, so the window bounds the match to that pass's job. `FleetJob` carries no head
  SHA, so a manual REVIEW of the same PR inside that window would also match (see Out of Scope).
  Both stale paths use it, the auto-review dispatcher (`ReviewHeadDispatcher`) and the flow's claim
  (`FleetReviewClaimService.claimHead`). A lookup that throws leaves the claim as it is for this pass.
  The link is conditional, so the two stale paths cannot both act on one row: a new repository method
  `markDispatchedIfPending(id, jobId)` updates the row only while it is `pending` with no `jobId`, mirroring
  `removeStalePending`, and reports whether it did.
- **Memory count.** The page query runs first. When the page is not full, its total is exact without a count:
  `skip + rows`, provided the page has rows or is the first page. `rows` is the number of ids the page query returned,
  not the number of hydrated records (`hydrateRanked` drops a row deleted between the two queries). A full page, or an empty page past the first, still
  counts. The `Page` contract is unchanged.
- **Workflow comment delete.** It is refused with a new `409` key `comments.workflowUndeletable` (en "Workflow comments
  cannot be deleted", plus zh), both before the approval gate (`resolveCommentProject` with operation `'delete'`) and in
  `CommentsService.delete`, mirroring the edit refusal.
- **Thread stream.** `stillAllowed` asks `PermissionService.can(fresh, 'thread.read', { projectId })` after the
  membership check, the key the guard checked when the stream opened.
- **Runner labels.** Owner ruling 2026-11-18: the enrollment's labels are final. Runners already enrolled keep their
  stored labels; nothing is migrated.
- **Not in this feature.** Owner rulings 2026-11-18: the tool-relay fence race (B/BUG-3) is accepted as is, and
  `fleet.thread.preapprove` stays on the Developer role (A/SEC-13 is closed by its `critical` tier).

### Integration

Symbols this feature changes. Each baseline locates today's code and is never the interface to implement; the target
is the interface.

- `IVcsProvider` (`src/vcs/vcs-provider.ts`). Target: gains
  `findOpenPullRequestByBranch(branchName: string): Promise<VcsPrStatus | null>`.
- `GitHubProvider` (`src/vcs/providers/github.provider.ts`). Target: implements it with
  `GET {apiBaseUrl}/repos/{owner}/{repo}/pulls` and params `{ state: 'open', head: '{owner}:{branchName}' }`, mapping
  the first element with `mapGitHubPrToVcsPrStatus`, `null` for an empty array.
- `GitLabProvider` (`src/vcs/providers/gitlab.provider.ts`). Target: implements it with
  `GET {baseUrl}/merge_requests` and params `{ state: 'opened', source_branch: branchName }`, mapping the first element
  whose `source_project_id` equals its `target_project_id` with `mapGitLabMrToVcsPrStatus`, `null` when there is none.
  `GitLabMrStatusResponse` gains the optional `source_project_id` and `target_project_id` numbers.
- `TicketTransitionsService.createPrForTicket` (private, `src/tickets/state-machine/ticket-transitions.service.ts`).
  Baseline: after `hasPrLink` it calls `provider.createPullRequest` directly. Target: calls
  `provider.findOpenPullRequestByBranch(branchName)` first and links a found PR instead of creating one.
- `TicketTransitionsService.executeTransitionPublic`. Baseline:
  `(projectSlug, ticketRef, toStatus, principal, fields?)`. Target:
  `(projectSlug, ticketRef, toStatus, principal, fields?, options?: { gatedEdgeKey?: string | null })`, passed on to
  `executeTransitionInternal`, whose `options` gains `gatedEdgeKey`.
- `TicketsService.update`. Baseline: `(projectSlug, ref, updateTicketDto, principal)`. Target:
  `(projectSlug, ref, updateTicketDto, principal, options?: { gatedEdgeKey?: string | null })`, passing `options` to
  `executeTransitionPublic` when the DTO carries a `status`.
- `TicketRouteCommands` (`src/tickets/ticket-route.commands.ts`), `updateCommand`. Target: the
  `rest:tickets.update-status` commands call `service.update(..., { gatedEdgeKey: key })`; the `rest:tickets.update`
  command calls `service.update(..., { gatedEdgeKey: null })`.
- `TicketLinksService.create` (`src/ticket-links/ticket-links.service.ts`). Target: a unique violation on `url` from the
  audited create is answered by re-reading `findLinkByUrl` and returning `{ status: 200, link }`.
- `ProjectsService.create` and `ProjectsService.update` (`src/projects/projects.service.ts`). Target: a unique
  violation on `slug` or `key` from the audited write becomes `ConflictAppException({ field }, 'projects')`.
- `CombinedAuthGuard.canActivate` (`src/auth/guards/combined-auth.guard.ts`). Baseline: catches an error from
  `tryApiKey`, logs it and falls back to JWT. Target: rethrows it as the `503` `AppException` above.
- `secret()` in `src/config/env.validation.ts`. Target: the production branch also requires `.min(32)`, with a message
  naming the key and never the value.
- `decryptToken` (`src/common/utils/encryption.util.ts`). Target: refuses an auth tag that is not 16 bytes with
  `Error('Invalid ciphertext format: auth tag must be 16 bytes')` and passes `{ authTagLength: 16 }` to
  `createDecipheriv`.
- `IFleetJobRepository` (`src/fleet/jobs/domain/fleet-job.domain.ts`) and `PrismaFleetJobRepository`. Target: gain
  `findReviewJobIdBetween(repoId: string, prNumber: number, from: Date, to: Date): Promise<string | null>`, the
  oldest `FleetJob` id with that `repoId`, `command` `REVIEW`, `feature` `reviewFeature(prNumber)` and
  `from <= createdAt <= to`.
- `FleetJobsService` (`src/fleet/jobs/fleet-jobs.service.ts`). Target: gains
  `findReviewJobIdBetween(repoId, prNumber, from, to)` delegating to the repository.
- `IFleetPrReviewRepository` (`src/fleet/reviews/domain/fleet-pr-review.domain.ts`) and
  `PrismaFleetPrReviewRepository`. Target: gain `markDispatchedIfPending(id: string, jobId: string): Promise<boolean>`,
  an `updateMany` of `{ outcome: 'dispatched', jobId }` where `id`, `outcome: 'pending'` and `jobId: null`, answering
  whether one row changed. `markDispatched` is unchanged.
- `ReviewHeadDispatcher.reopenStaleClaim` (private, `src/fleet/reviews/review-head-dispatcher.ts`). Baseline: removes a
  stale `pending` row. Target: first asks `jobs.findReviewJobIdBetween(row.repoId, row.prNumber, row.createdAt,
  row.createdAt + pollMs)`; a found id is recorded with `reviews.markDispatchedIfPending(row.id, jobId)` (in
  `bookkeeping`) and the head is not open, whatever that call answers.
- `FleetReviewClaimService` (`src/fleet/reviews/fleet-review-claim.service.ts`). Baseline constructor
  `(reviews, config)`. Target: `(reviews, config, jobs: FleetJobsService)`; `claimHead` asks the same lookup (window
  `prReviewPollMs`) before `removeStalePending`. When a job is found and `markDispatchedIfPending` answers `true`, it
  returns `{ kind: 'owned', jobId }`; when it answers `false`, it re-reads the head and answers the way today's lost
  `removeStalePending` path does (`owned`, `failed` or `busy`).
- `PrismaMemoryItemRepository.findRankedByText` (private, `src/memory/prisma-memory-item.repository.ts`). Baseline: the
  page query and `count(*)` in one `Promise.all`. Target: the page query first, the count only when needed.
- `CommentsService.resolveCommentProject` (`src/comments/comments.service.ts`). Baseline:
  `(commentId, principal, operation?: 'update')`. Target: `operation?: 'update' | 'delete'`; `'delete'` refuses a
  non-`GENERAL` comment. `CommentsService.delete` refuses it too, and `CommentsController`'s delete route passes
  `'delete'`.
- `ThreadEventsController` (`src/fleet/threads/thread-events.controller.ts`). Target: the constructor gains
  `PermissionService`, and `stillAllowed` also requires `thread.read`.
- `EnrollmentService.enroll` (`src/fleet/runners/enrollment.service.ts`). Baseline:
  `labels: uniqueSorted([...enrollment.labels, ...body.labels])`. Target: `labels: uniqueSorted(enrollment.labels)`,
  and the `runner.enrolled` activity payload gains `ignoredLabels`: the sorted, de-duplicated body labels that are not
  enrollment labels (`[]` when none).
- `getExceptionResponse` (private copies in `review-head-dispatcher.ts` and `fix-follow-up.subscriber.ts`). Target: one
  exported `exceptionResponse(error: Error): { prefix?: string; args?: Record<string, unknown> }` in the new
  `src/fleet/reviews/dispatch-error.ts`, which returns `{}` when the error has no `getResponse` function or its
  response is not an object.

Symbols read, unchanged: `hasPrLink`, `createTicketLink`, `buildBranchName`, `extractLinksFromPr`,
`transitionKeyFor` (`src/tickets/state-machine/transition-keys.ts`), `updateTicketStatusIf`, `isUniqueViolation`,
`ConflictAppException` (`src/common/exceptions/conflict-app.exception.ts`), `AuditRecorder.audited`, `reviewFeature`
(`src/fleet/common/review-jobs.ts`), `IFleetPrReviewRepository.markDispatched` and `removeStalePending`,
`PermissionService.can`, `ProjectAccessService.assertProjectMembership`, `resolvePageOption`, `Page`.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| `findOpenPullRequestByBranch` throws | A warning is logged; no PR is created and no link is written. |
| A status PATCH's gated edge key differs from the live edge key | `409` `Ticket state changed concurrently`; no field or status is written. |
| A ticket-link create hits a unique violation and the re-read finds the link | `200` with that link. |
| A ticket-link create hits a unique violation and the re-read finds nothing | The original error propagates. |
| A project create or update hits a unique violation on `slug` or `key` | `409` `ConflictAppException({ field }, 'projects')`. |
| The API-key lookup throws | `503` `auth.keyLookupUnavailable`; JWT is not tried. |
| A production secret is shorter than 32 characters | `validate` throws naming the key; the API does not boot. |
| A ciphertext's auth tag is not 16 bytes | `decryptToken` throws before decrypting. |
| The review-job lookup throws on a stale claim | The claim is kept; the head is skipped this pass (dispatcher) or answered `busy` (claim service). |
| The conditional link finds the row already settled or removed | Dispatcher: the head is not open this pass. Claim service: it answers from a re-read of the head. |
| A GitLab merge request on the branch comes from a fork | It is not adopted; a same-project one is, or a new PR is created. |
| A delete targets a non-`GENERAL` comment | `409` `comments.workflowUndeletable`; nothing is written and no approval request is opened. |
| The `thread.read` re-check is denied, or throws | The stream closes. |

## Out of Scope

- The tool-relay fence race (B/BUG-3): accepted as is by owner ruling 2026-11-18.
- Removing `fleet.thread.preapprove` from the Developer role (A/SEC-13): kept by owner ruling 2026-11-18.
- Re-labelling runners that are already enrolled; only new enrollments change.
- Retrying the `TicketLink` write after a successful PR create; the next VERIFIED cycle adopts the PR instead.
- Adopting a closed or merged PR on the ticket's branch; only an open PR is adopted.
- Approximate or capped memory totals; a full ranked page still counts exactly.
- US-003 only: recovering a ticket-link or project unique violation for a caller that is already inside an outer
  transaction (the violation aborts that transaction, so the error propagates as before).
- US-004 only: bounding how long an open SSE stream can delay `app.close()` after `SIGTERM`.
- US-006 only: telling a manual REVIEW of the same PR, dispatched inside a stale claim's dispatch window, from that
  claim's own job; `FleetJob` carries no head SHA, so such a job also settles the claim.
- US-004 only: a test that boots `main.ts`; the `enableGracefulShutdown(app)` call in `main.ts` is checked by review.
- US-004 only: a minimum length for `VCS_ENCRYPTION_KEY` or `PROVIDER_CREDENTIAL_ENCRYPTION_KEY`; both are already
  exactly 64 hex characters.
- The other 2026-11-14 review items: the runner, web, CI and deploy fixes are a separate feature, and the
  ruling-dependent items wait for their rulings.

## Stories

The feature is a bundle of independent API fixes, split by area at the owner's choice (2026-11-18): this feature
holds the API items and a second feature holds the runner, web, CI and deploy items. Nine stories keep each story
under the 15-assertion gate.

**US-001: Adopt an open PR on the ticket's branch.** Workdir: `apps/api`. No dependencies.
The providers gain `findOpenPullRequestByBranch`; `createPrForTicket` links an open PR it finds instead of creating
one.

**US-002: Refuse a status PATCH gated on a stale edge.** Workdir: `apps/api`. No dependencies.
The ticket route commands pass their gated edge key through `TicketsService.update` to the transition, which refuses
a mismatch with `409`.

**US-003: Map ticket-link and project unique violations.** Workdir: `apps/api`. No dependencies.

**US-004: API-key lookup errors, secret floor, GCM tag length, shutdown hooks.** Workdir: `apps/api`. No dependencies.

**US-005: Review job lookup and conditional claim link.** Workdir: `apps/api`. No dependencies.
Adds `findReviewJobIdBetween` to the job repository and `FleetJobsService`, and `markDispatchedIfPending` to the
review repository.

**US-006: Recover a stale review claim whose job was dispatched.** Workdir: `apps/api`. Depends on US-005.
`ReviewHeadDispatcher` and `FleetReviewClaimService` consult the lookup before dropping a stale claim and link a
found job conditionally.

**US-007: Memory page count and workflow comment delete.** Workdir: `apps/api`. No dependencies.

**US-008: Thread stream re-check and enrollment labels.** Workdir: `apps/api`. No dependencies.

**US-009: Share the dispatch exception-response helper.** Workdir: `apps/api`. Depends on US-006.
Refactor only: both files import `exceptionResponse` and their private copies are deleted. The deletion is verified by
`bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint`.

### Context Files

**US-001**
- `apps/api/src/tickets/state-machine/ticket-transitions.service.ts` — `createPrForTicket`, `createPrAfterCommit`, `verify`.
- `apps/api/src/vcs/vcs-provider.ts` — `IVcsProvider`.
- `apps/api/src/vcs/providers/github.provider.ts` — `listPullRequests`, `mapGitHubPrToVcsPrStatus`.
- `apps/api/src/vcs/providers/gitlab.provider.ts` — `listPullRequests`, `mapGitLabMrToVcsPrStatus`.
- `apps/api/src/tickets/state-machine/ticket-transitions.after-commit.spec.ts` — the provider harness.

**US-002**
- `apps/api/src/tickets/ticket-route.commands.ts` — `updateCommand`.
- `apps/api/src/tickets/tickets.service.ts` — `update`.
- `apps/api/src/tickets/state-machine/ticket-transitions.service.ts` — `executeTransitionPublic`, `executeTransitionInternal`, `assertEdgeAllowed`.
- `apps/api/src/tickets/state-machine/transition-keys.ts` — `transitionKeyFor`.

**US-003**
- `apps/api/src/ticket-links/ticket-links.service.ts` — `create`.
- `apps/api/src/projects/projects.service.ts` — `create`, `update`.
- `apps/api/src/common/utils/prisma-errors.ts` — `isUniqueViolation`.

**US-004**
- `apps/api/src/auth/guards/combined-auth.guard.ts` — `canActivate`, `tryApiKey`.
- `apps/api/src/config/env.validation.ts` — `secret`, `validate`.
- `apps/api/src/common/utils/encryption.util.ts` — `decryptToken`.
- `apps/api/src/main.ts` — the bootstrap sequence.
- `apps/api/src/fleet/provider-credentials/provider-credentials.service.ts` — the `503` `AppException` pattern.

**US-005**
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findActiveJobId`, the query pattern.
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — the service surface.
- `apps/api/src/fleet/reviews/prisma-fleet-pr-review.repository.ts` — `markDispatched`, `removeStalePending`.
- `apps/api/src/fleet/common/review-jobs.ts` — `reviewFeature`.

**US-006**
- `apps/api/src/fleet/reviews/review-head-dispatcher.ts` — `headIsOpen`, `reopenStaleClaim`.
- `apps/api/src/fleet/reviews/fleet-review-claim.service.ts` — `claimHead`.
- `apps/api/src/fleet/reviews/review-head-dispatcher.spec.ts` — the `createDispatcher` harness.

**US-007**
- `apps/api/src/memory/prisma-memory-item.repository.ts` — `findRankedByText`.
- `apps/api/src/memory/memory-item-repository.spec.ts` — the `ranked` and `rawCalls` helpers.
- `apps/api/src/comments/comments.service.ts` — `resolveCommentProject`, `assertEditable`, `delete`.
- `apps/api/src/comments/comments.controller.ts` — the delete route.

**US-008**
- `apps/api/src/fleet/threads/thread-events.controller.ts` — `ThreadEventsGuard`, `stillAllowed`.
- `apps/api/src/fleet/threads/thread-events.controller.spec.ts` — the guard harness.
- `apps/api/src/fleet/runners/enrollment.service.ts` — `enroll`.
- `apps/api/src/fleet/runners/enrollment.service.spec.ts` — the harness.

**US-009**
- `apps/api/src/fleet/reviews/review-head-dispatcher.ts` — `getExceptionResponse`.
- `apps/api/src/fleet/reviews/fix-follow-up.subscriber.ts` — `getExceptionResponse`, `handle`.

### Creates

**US-004**
- `apps/api/src/common/bootstrap/graceful-shutdown.ts` — `enableGracefulShutdown`.
- `apps/api/src/common/bootstrap/graceful-shutdown.spec.ts` — its unit test.

**US-005**
- `apps/api/test/integration/fleet/fleet-review-job-lookup.integration.spec.ts` — `findReviewJobIdBetween` and `markDispatchedIfPending` against Postgres.

**US-009**
- `apps/api/src/fleet/reviews/dispatch-error.ts` — `exceptionResponse`.
- `apps/api/src/fleet/reviews/dispatch-error.spec.ts` — its unit test.

### Modifies

**US-001**
- `apps/api/src/tickets/state-machine/ticket-transitions.service.spec.ts` — the provider stubs at the PR-creation cases (about lines 1330 and 1390) define `createPullRequest` only; add `findOpenPullRequestByBranch: vi.fn().mockResolvedValue(null)` so those cases still reach `createPullRequest`, keeping every assertion.
- `apps/api/src/tickets/state-machine/ticket-transitions.after-commit.spec.ts` — the provider factory (about line 87) builds a provider with `createPullRequest` only; it gains `findOpenPullRequestByBranch` resolving `null` by default (overridable through the options), so the existing "calls createPullRequest once" cases keep their assertions.
- `apps/api/test/integration/vcs/auto-create-pr-on-verified.integration.spec.ts` — `mockVcsProvider` (about line 153) gains `findOpenPullRequestByBranch: vi.fn().mockResolvedValue(null)`, so the existing creation cases keep their assertions.
- `apps/api/src/vcs/vcs-provider.spec.ts` — its `class MockVcsProvider implements IVcsProvider` declarations no longer satisfy the interface once it gains `findOpenPullRequestByBranch`; each gains a `findOpenPullRequestByBranch` method resolving `null`, keeping every assertion.

**US-002**
- `apps/api/src/tickets/ticket-route.commands.spec.ts` — the status-update case (about line 116) asserts `service.update` was called exactly once with four arguments; it now expects a fifth argument `{ gatedEdgeKey: 'ticket.transition.start' }`. The plain update case (about line 176) now expects a fifth argument `{ gatedEdgeKey: null }`. Their other assertions stay.

**US-003**
None. The services only gain a catch around their audited writes; no existing case raises a unique violation there.

**US-004**
- `apps/api/src/config/env.validation.spec.ts` — `REQUIRED` uses one-character secrets (`'s'`, `'r'`, `'k'`); "accepts real secrets in production" and the production placeholder cases now need 32-character values. Give `REQUIRED` three distinct 32-character secrets; the outside-production cases keep their assertions.
- `apps/api/src/auth/guards/combined-auth.guard.spec.ts` — gains this story's AC-1 and AC-2 cases (the agent lookup rejects); no existing case changes.

**US-005**
None. The new methods are additions; existing fakes of the two repository interfaces are typed with `Pick` or build only the methods their cases call.

**US-006**
- `apps/api/src/fleet/reviews/review-head-dispatcher.spec.ts` — `createDispatcher`'s `jobs` stub defines `dispatch` only; it gains `findReviewJobIdBetween` resolving `null`, so the stale-claim cases (about lines 176 and 190) keep removing and re-dispatching. The `reviews` fake gains `markDispatchedIfPending`.
- `apps/api/src/fleet/reviews/fleet-review-claim.service.spec.ts` — the service is constructed with `(reviews, config)`; it now takes a third `jobs` stub whose `findReviewJobIdBetween` resolves `null`, so AC-4 and AC-5 keep their stale-removal and retry assertions. The `reviews` stub gains `markDispatchedIfPending`. The module case (AC-10) keeps its provider assertion.

**US-007**
- `apps/api/src/memory/memory-item-repository.spec.ts` — the `ranked(ids, total)` helper queues three `$queryRaw` results (probe, page, count). A page that returns fewer ids than its size, on page 1 or with ids, no longer issues the count, so the helper queues the count result only when `ids.length` equals the page size or the page is empty past page 1, and these expectations change: "ranks, filters and pages in SQL, then loads the rows by id and keeps rank order" (page 2 of 5, 2 ids) now expects no `count(*)::int` call and `total: 7`; the raw-call counts at about lines 369 (3 to 2), 398 (5 to 3), 434 (`it.each`, 3 to 2) and 444 (`ranked(['mem-1'], 1)`, 3 to 2) drop by the skipped counts; the any-word cases at about lines 388-411 stop queueing the `{ total: 0 }` results for their empty first pages. Every other assertion stays.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — beside its workflow-comment PATCH case (about line 1219), gains a DELETE case: deleting a workflow comment returns `409`.

**US-008**
- `apps/api/src/fleet/threads/thread-events.controller.spec.ts` — today it constructs only `ThreadEventsGuard`. It gains a `ThreadEventsController` describe block for this story's AC-1 to AC-3: the controller built with stubs (bus, stream registry, `JwtAuthProvider`, `ProjectAccessService`, `PermissionService`, a live config with a short `heartbeatMs`), `events()` called with an authorized request, and the returned Observable driven under fake timers, since `createLiveStream` calls `stillAllowed` on each heartbeat; a closed stream is one that completes. The existing guard cases stay.
- `apps/api/src/fleet/runners/enrollment.service.spec.ts` — "creates the runner with merged labels and returns a kr_ key once" expects `['darwin', 'fast', 'gpu']`; it now expects the enrollment's `['darwin', 'gpu']`, and the activity payload gains `ignoredLabels: ['fast']`. Its key and return assertions stay.
- `apps/api/test/integration/fleet/runner-enrollment.integration.spec.ts` — the enroll case (about line 76) enrolls with enrollment labels `['gpu']` and body labels `['linux']` and expects the runner `me` route to answer `labels: ['gpu', 'linux']`; it now expects `labels: ['gpu']`, keeping its other assertions.

**US-009**
None. The helper behaves like the two private copies on every input they handle.

### Seams

- US-001 creates `findOpenPullRequestByBranch`; `createPrForTicket` consumes it, driven through `TicketTransitionsService.verify` on a CREATED ticket (US-001 AC-6).
- US-002 adds `gatedEdgeKey`; the registered ticket route commands produce it (US-002 AC-1, AC-2), `TicketsService.update` forwards it (US-002 AC-3), and `executeTransitionPublic` consumes it (US-002 AC-4 to AC-7).
- US-004 creates `enableGracefulShutdown`; `main.ts` consumes it (checked by review, see Out of Scope).
- US-005 creates `FleetJobsService.findReviewJobIdBetween` and `markDispatchedIfPending`; US-006 consumes them through `ReviewHeadDispatcher.dispatchRepo` (US-006 AC-1) and `FleetReviewClaimService.claimHead` (US-006 AC-4).
- US-009 creates `exceptionResponse`; both classifiers consume it, driven through `ReviewHeadDispatcher.dispatchRepo` (US-009 AC-4) and `FixFollowUpSubscriber.handle` (US-009 AC-5), each with a `fleet.jobs` conflict.

## Acceptance Criteria

### US-001

- AC-1 [unit] `GitHubProvider.findOpenPullRequestByBranch('ACME-7-fix-login')` sends `GET {apiBaseUrl}/repos/{owner}/{repo}/pulls` with params `state: 'open'` and `head: '{owner}:ACME-7-fix-login'`.
- AC-2 [unit] When that GitHub call answers one pull request, `GitHubProvider.findOpenPullRequestByBranch` returns it mapped as a `VcsPrStatus` with its `number` and `url`.
- AC-3 [unit] When that GitHub call answers an empty array, `GitHubProvider.findOpenPullRequestByBranch` returns `null`.
- AC-4 [unit] `GitLabProvider.findOpenPullRequestByBranch('ACME-7-fix-login')` sends `GET {baseUrl}/merge_requests` with params `state: 'opened'` and `source_branch: 'ACME-7-fix-login'`, and returns the first merge request whose `source_project_id` equals its `target_project_id`, mapped as a `VcsPrStatus`.
- AC-5 [unit] When GitLab answers an empty array, or only merge requests whose `source_project_id` differs from their `target_project_id`, `GitLabProvider.findOpenPullRequestByBranch` returns `null`.
- AC-6 [unit] Verifying a CREATED ticket through `TicketTransitionsService.verify` while the provider's `findOpenPullRequestByBranch` resolves an open PR number 7 never calls `createPullRequest`.
- AC-7 [unit] In that case `createTicketLink` is called once with `prNumber: 7`, the PR's `url`, `linkType: 'pr'` and `externalRef` `'{repoOwner}/{repoName}#7'`.
- AC-8 [unit] An adopted PR with `draft: true` is linked with `prState: 'draft'`, and one with `draft: false` with `prState: 'open'`.
- AC-9 [unit] An adopted PR calls `extractLinksFromPr` with the branch name `buildBranchName` returned and PR number 7.
- AC-10 [unit] An adopted PR records no `VCS_PR_CREATED` activity.
- AC-11 [unit] `findOpenPullRequestByBranch` is called with the branch name `buildBranchName` returns for the ticket.
- AC-12 [unit] When `findOpenPullRequestByBranch` resolves `null`, verifying the ticket calls `createPullRequest` once, as before.
- AC-13 [unit] When `findOpenPullRequestByBranch` rejects, verifying the ticket calls neither `createPullRequest` nor `createTicketLink`, and the verify itself still resolves.

### US-002

- AC-1 [unit] Executing the registered `rest:tickets.update-status` command for key `ticket.transition.start` with `{ status: 'IN_PROGRESS' }` calls `TicketsService.update` with a fifth argument `{ gatedEdgeKey: 'ticket.transition.start' }`.
- AC-2 [unit] Executing the registered `rest:tickets.update` command calls `TicketsService.update` with a fifth argument `{ gatedEdgeKey: null }`.
- AC-3 [unit] `TicketsService.update` with a `status` and `options` `{ gatedEdgeKey: 'ticket.transition.start' }` calls `executeTransitionPublic` with that `options` object as its sixth argument; called without `options`, it passes five arguments.
- AC-4 [unit] `TicketTransitionsService.executeTransitionPublic(slug, ref, 'IN_PROGRESS', principal, undefined, { gatedEdgeKey: 'ticket.transition.start' })` on a ticket whose loaded status makes `transitionKeyFor(status, 'IN_PROGRESS')` a different key rejects with HTTP status `409`, and `updateTicketStatusIf` is never called.
- AC-5 [unit] In the AC-4 case, a principal who also lacks the live edge's key still gets `409`, not `403`.
- AC-6 [unit] `executeTransitionPublic` with `{ gatedEdgeKey }` equal to the loaded status's edge key runs the transition and calls `updateTicketStatusIf` with the loaded status.
- AC-7 [unit] `executeTransitionPublic` with `{ gatedEdgeKey: null }` on a pair that has an edge key rejects with `409`; with `{ gatedEdgeKey: null }` on a pair that has none, it reaches transition validation as it does today.

### US-003

- AC-1 [unit] `TicketLinksService.create` whose audited `createLink` rejects with a unique violation on `url`, and whose following `findLinkByUrl` returns a link, resolves `{ status: 200, link }` for that link.
- AC-2 [unit] When the re-read after that unique violation returns `null`, `TicketLinksService.create` rejects with the original error.
- AC-3 [unit] When the audited `createLink` rejects with any other error, `TicketLinksService.create` rejects with that error and does not re-read.
- AC-4 [unit] `ProjectsService.create` whose audited `createProject` rejects with a unique violation on `slug` rejects with a `ConflictAppException` whose args are `{ field: 'slug' }` under prefix `projects`.
- AC-5 [unit] `ProjectsService.create` whose audited write rejects with a unique violation on `key` rejects with `ConflictAppException` args `{ field: 'key' }`.
- AC-6 [unit] `ProjectsService.update` whose audited `updateBySlug` rejects with a unique violation on `slug` rejects with `ConflictAppException` args `{ field: 'slug' }`.
- AC-7 [unit] `ProjectsService.update` whose audited write rejects with a unique violation on `key` rejects with `ConflictAppException` args `{ field: 'key' }`.
- AC-8 [unit] `ProjectsService.create` whose audited write rejects with a unique violation whose target is the index name `Project_slug_key` rejects with `ConflictAppException` args `{ field: 'slug' }`.

### US-004

- AC-1 [unit] `CombinedAuthGuard.canActivate` with a non-JWT bearer whose `findAgentByKeyHash` rejects throws an `AppException` with HTTP status `503`.
- AC-2 [unit] In that case the JWT path (`super.canActivate`) is never called.
- AC-3 [unit] With a non-JWT bearer whose `findAgentByKeyHash` resolves `null`, `canActivate` still falls back to JWT.
- AC-4 [unit] `validate` with `NODE_ENV: 'production'` and a 31-character `JWT_SECRET` throws an error naming `JWT_SECRET`.
- AC-5 [unit] `validate` with `NODE_ENV: 'production'` and a 31-character `JWT_REFRESH_SECRET` throws an error naming `JWT_REFRESH_SECRET`.
- AC-6 [unit] `validate` with `NODE_ENV: 'production'` and a 31-character `API_KEY_SECRET` throws an error naming `API_KEY_SECRET`.
- AC-7 [unit] `validate` with `ENV_NAME: 'production'` and a 31-character `JWT_SECRET` throws an error naming `JWT_SECRET`.
- AC-8 [unit] `validate` with `NODE_ENV: 'production'` and three distinct 32-character secrets does not throw.
- AC-9 [unit] `validate` with `NODE_ENV: 'test'` and one-character secrets does not throw.
- AC-10 [unit] The thrown secret-length error message omits the secret's value.
- AC-11 [unit] `decryptToken` of a ciphertext produced by `encryptToken` whose auth-tag segment is cut to 12 bytes throws `Invalid ciphertext format: auth tag must be 16 bytes`.
- AC-12 [unit] `decryptToken` of an unmodified `encryptToken` output returns the original plaintext.
- AC-13 [unit] `enableGracefulShutdown(app)` calls `app.enableShutdownHooks` once with `['SIGTERM', 'SIGINT']`.

### US-005

- AC-1 [integration] `PrismaFleetJobRepository.findReviewJobIdBetween(repoId, 12, from, to)` returns the id of a REVIEW job on that repo with feature `review-pr-12` created between `from` and `to`.
- AC-2 [integration] It returns `null` when the only such REVIEW job was created before `from`.
- AC-3 [integration] It returns `null` when the only such REVIEW job was created after `to`.
- AC-4 [integration] It returns `null` when the only REVIEW job inside the window has feature `review-pr-13`.
- AC-5 [integration] `PrismaFleetPrReviewRepository.markDispatchedIfPending(id, jobId)` on a `pending` row with no `jobId` returns `true` and leaves the row `dispatched` with that `jobId`.
- AC-6 [integration] `markDispatchedIfPending` on a row already `dispatched` returns `false` and leaves the row unchanged.
- AC-7 [integration] `markDispatchedIfPending` on an id with no row returns `false`.
- AC-8 [unit] `FleetJobsService.findReviewJobIdBetween('repo-1', 12, from, to)` returns what the repository's `findReviewJobIdBetween` returns for the same arguments.

### US-006

- AC-1 [unit] `ReviewHeadDispatcher.dispatchRepo` over a PR whose head row is a stale `pending` claim, with `jobs.findReviewJobIdBetween` resolving `'job-1'`, calls `findReviewJobIdBetween` with the row's `repoId`, `prNumber`, `createdAt` and `createdAt` plus `pollMs`, and calls `reviews.markDispatchedIfPending(row.id, 'job-1')`.
- AC-2 [unit] In that case `dispatchRepo` calls neither `reviews.remove`, `reviews.insertPending` nor `jobs.dispatch`, and returns `0`, whether `markDispatchedIfPending` answers `true` or `false`.
- AC-3 [unit] When `findReviewJobIdBetween` rejects for a stale claim, `dispatchRepo` keeps the row (no `remove`) and dispatches nothing for that PR.
- AC-4 [unit] `FleetReviewClaimService.claimHead` on a stale `pending` row with no `jobId`, with `jobs.findReviewJobIdBetween` resolving `'job-1'` and `markDispatchedIfPending` answering `true`, returns `{ kind: 'owned', jobId: 'job-1' }` and never calls `removeStalePending`.
- AC-5 [unit] When `markDispatchedIfPending` answers `false` and the re-read head row carries `jobId` `'job-2'`, `claimHead` returns `{ kind: 'owned', jobId: 'job-2' }`.
- AC-6 [unit] When `findReviewJobIdBetween` resolves `null`, `claimHead` removes the stale claim and retries the insert as it does today.
- AC-7 [unit] When `findReviewJobIdBetween` rejects, `claimHead` returns `{ kind: 'busy' }` and never calls `removeStalePending`.

### US-007

- AC-1 [unit] A ranked memory search on page 1 of size 10 whose page query returns 3 ids answers `total: 3` and issues no `count(*)` query.
- AC-2 [unit] A ranked search on page 2 of size 5 whose page query returns 2 ids answers `total: 7` and issues no `count(*)` query.
- AC-3 [unit] A ranked search whose page query returns exactly the page size issues the `count(*)` query and answers its `total`.
- AC-4 [unit] A ranked search on page 1 whose page query returns no ids answers `total: 0` and issues no `count(*)` query.
- AC-5 [unit] A ranked search on page 3 whose page query returns no ids issues the `count(*)` query and answers its `total`.
- AC-6 [unit] `CommentsService.delete` on a comment whose `type` is not `GENERAL` rejects with a `409` `ConflictAppException` under prefix `comments.workflowUndeletable`.
- AC-7 [unit] In that case the comment repository's `softDelete` is never called.
- AC-8 [unit] `CommentsService.resolveCommentProject(id, principal, 'delete')` on a non-`GENERAL` comment rejects with the same `409` `comments.workflowUndeletable`.
- AC-9 [unit] The comments controller's delete route on a non-`GENERAL` comment rejects with `409` before the approval gate's `run` is called.
- AC-10 [unit] `CommentsService.delete` on a `GENERAL` comment the caller may delete calls `softDelete` once.

### US-008

- AC-1 [unit] The `stillAllowed` callback of a thread stream opened by `ThreadEventsController.events` returns `false` when the viewer is still a project member but `PermissionService.can(fresh, 'thread.read', { projectId })` is denied.
- AC-2 [unit] `stillAllowed` returns `true` when the viewer is a member and `thread.read` is allowed.
- AC-3 [unit] `stillAllowed` returns `false` when `PermissionService.can` rejects.
- AC-4 [unit] `EnrollmentService.enroll` with enrollment labels `['gpu', 'darwin']` and body labels `['darwin', 'fast']` creates the runner with labels `['darwin', 'gpu']`.
- AC-5 [unit] In that case the `runner.enrolled` activity payload carries `ignoredLabels: ['fast']`.
- AC-6 [unit] `EnrollmentService.enroll` whose body labels are all enrollment labels records `ignoredLabels: []`.
- AC-7 [unit] `EnrollmentService.enroll` with enrollment labels `[]` and body labels `['x']` creates the runner with labels `[]`.

### US-009

- AC-1 [unit] `exceptionResponse(new ConflictAppException({}, 'fleet.jobs'))` returns an object whose `prefix` is `'fleet.jobs'`.
- AC-2 [unit] `exceptionResponse(new ValidationAppException({ reason: 'repo_unavailable' }, 'fleet.jobs'))` returns `args.reason` `'repo_unavailable'`.
- AC-3 [unit] `exceptionResponse(new Error('plain'))` returns `{}`.
- AC-4 [unit] `ReviewHeadDispatcher.dispatchRepo` whose `jobs.dispatch` rejects with `ConflictAppException({}, 'fleet.jobs')` removes the claim and dispatches nothing more for that PR, as before the refactor.
- AC-5 [unit] `FixFollowUpSubscriber.handle` with a valid follow-up payload whose `jobs.dispatch` rejects with `ConflictAppException({}, 'fleet.jobs')` removes its claim and records the skip reason `review_active`, as before the refactor.
