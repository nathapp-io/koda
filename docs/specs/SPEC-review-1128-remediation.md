# SPEC: Koda November 28 review remediation

## Summary

Correct the 14 confirmed defects in the [revised whole-repository review](../20261128-review-whole-repo.md) at baseline `d4538dd4e`. The eleven independent stories retain the original finding numbers. Those numbers refer to entries in the review.

## Motivation

The PostgreSQL controls reproduced missing code relationships, symbol loss, a missed ticket transition and inconsistent API responses. SQLite and controlled process, client and workflow fixtures isolated runner recovery, calendar, CLI and delivery defects. Nine findings are P2 and five are P3. The review records the evidence and limitations for each, including which external systems were simulated.

## Design

| Story | Review findings | Baseline and target behavior |
| --- | --- | --- |
| US-001 | 6, 7 | CodeGraphService currently selects a numeric syntax kind and requests JSDoc from a variable declaration. Traverse call-expression nodes by named kind. Read callable bodies and parameters from the initializer and documentation from its owning variable statement. Keep batch isolation and the existing name resolver. |
| US-002 | 8 | VcsPrSyncService checks a status captured during candidate selection. Delegate eligibility at merge time to the existing conditional transition in applyMergedPrTransition. Preserve the transaction that records the winning status change, FIX_REPORT, VCS_PR_MERGED activity and audit entry. |
| US-003 | 9, 17 | The status PATCH and transition route commands return raw transition records. Use the project-aware response mapping used by ordinary edits, inside the command execution boundary so stored approval results also carry the mapped ticket. Carry projectId through TicketLabel.label in the domain contract and repository projection. |
| US-004 | 3 | Journal.prune deletes all events for done jobs past retention and returns directories for cleanup. Make eligibility conditional on absence of unacknowledged events for the exact job and lease in the same SQLite transaction. Age alone never settles delivery. The daemon removes directories returned by prune, and epochs of one job share a directory. Return a directory for cleanup only after its final retained row is gone. |
| US-005 | 4 | Use the same effective-close predicate for send refusal, session control, mode changes and publish in PrismaChatThreadRepository. Include unacknowledged closes explicitly because a nullable ackResult may fail a SQL inequality. Ignore acknowledged rejected closes for that job and lease. Preserve the treatment of other outcomes, locks, readiness, pending approvals and lease fencing. |
| US-006 | 5 | The startup reaper forgets ownership even when inspection or signalling fails. Distinguish positive absence from an inconclusive identity probe in production as well as injected tests. Keep existing host-boot and PID guards and conditional deletion by pid and recorded timestamp. Preserve readProcessStart’s Date-or-null contract for its existing executor callers. |
| US-007 | 12, 18 | Name the ordinary assignee argument as a user ID and document the self shorthand. Emit a JSON confirmation for a successful empty DELETE response, using the requested label ID. |
| US-008 | 13 | Convert date-only picker values at the web request boundary. Encode local midnight for from and the last millisecond before the following local midnight for inclusive to. Advance one calendar date in local time. The API already compares inclusive millisecond timestamps. |
| US-009 | 14 | Include the tracked patches directory in main push paths, the PR change classifier and Turbo globalDependencies. The global input trades broader cache invalidation for coverage of every dependent task. |
| US-010 | 15 | On tag push or full redispatch, compare the requested canary to remote canary tags in the info job before registry writes. Order the three base components then the canary sequence numerically using decimal-string comparison. Fail the run when a newer canary exists. Keep the current version's published-package skip and stable tagging policy. |
| US-011 | 16 | Extend the example wrapper's existing assignment reader to recognize the optional export prefix in .env. Keep shell precedence, quoting support, URL-safe validation and the preflight check before Docker operations. |

### Integration and failure handling

Exercise public routes and durable state together for indexing, PR merges and ticket mutations. Exercise journal replay against a reopened database. Inject process observation and signals for the reaper. Use isolated Git histories and intercepted registry and deployment commands for delivery tests. Each story's criteria identify the successful operation and its failure or boundary control.

## Out of Scope

- Changing the configured verification approval policy (review item 1).
- Deduplicating simultaneous independent approval requests (item 2).
- Changing JSON evaluation exit codes (item 10).
- Paginating `ticket mine` beyond its documented first page (item 11).
- Introducing a new lease reconciliation protocol or modifying the server silence sweeper.
- Adding semantic TypeScript resolution, historical reindex migrations or new graph endpoints.
- Coordinating concurrent registry publication across runs or repairing historical registry state.

## Stories

**US-001: Index TypeScript calls and callable variables.** Workdir: `apps/api`. No dependencies. Covers review 6, 7.

**US-002: Apply polled merges to the live ticket.** Workdir: `apps/api`. No dependencies. Covers review 8.

**US-003: Return canonical tickets from status changes.** Workdir: `apps/api`. No dependencies. Covers review 9, 17.

**US-004: Retain undelivered journal events.** Workdir: `apps/runner`. No dependencies. Covers review 3.

**US-005: Allow retry after a rejected thread close.** Workdir: `apps/api`. No dependencies. Covers review 4.

**US-006: Retry indeterminate orphan cleanup.** Workdir: `apps/runner`. No dependencies. Covers review 5.

**US-007: Correct CLI assignee help and label deletion output.** Workdir: `apps/cli`. No dependencies. Covers review 12, 18.

**US-008: Filter timeline events by the browser’s calendar day.** Workdir: `apps/web`. No dependencies. Covers review 13.

**US-009: Run CI and invalidate cache for Bun patches.** Workdir: `.`. No dependencies. Covers review 14.

**US-010: Reject stale canary release retries.** Workdir: `.`. No dependencies. Covers review 15.

**US-011: Accept exported deployment credentials.** Workdir: `.`. No dependencies. Covers review 16.

### Context Files

All paths below are relative to the repository root.

**US-001**

- `apps/api/src/code-intel/code-graph.service.ts`
- `apps/api/src/code-intel/code-graph.service.spec.ts`
- `apps/api/src/code-intel/code-graph.batch.spec.ts`
- `apps/api/test/e2e/ast-index.e2e.spec.ts`

**US-002**

- `apps/api/src/vcs/vcs-pr-sync.service.ts`
- `apps/api/src/vcs/vcs-pr-sync.service.spec.ts`
- `apps/api/test/integration/vcs/vcs-pr-sync-auto-transition.spec.ts`
- `apps/api/test/integration/vcs/vcs-merge-step.integration.spec.ts`

**US-003**

- `apps/api/src/tickets/tickets.service.ts`
- `apps/api/src/tickets/ticket-route.commands.ts`
- `apps/api/src/tickets/prisma-tickets.repository.ts`
- `apps/api/src/tickets/domain/ticket.domain.ts`
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts`

**US-004**

- `apps/runner/src/journal/journal.ts`
- `apps/runner/src/journal/journal.spec.ts`

**US-005**

- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts`
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.spec.ts`
- `apps/api/test/e2e/fleet/thread-send-guards.e2e.spec.ts`
- `apps/api/test/integration/fleet/fleet-project-thread-send.integration.spec.ts`

**US-006**

- `apps/runner/src/daemon/owned-processes.ts`
- `apps/runner/src/executor/pid-registry.ts`
- `apps/runner/test/unit/owned-processes.spec.ts`

**US-007**

- `apps/cli/src/commands/ticket.ts`
- `apps/cli/src/commands/ticket.spec.ts`
- `apps/cli/src/commands/label.ts`
- `apps/cli/src/commands/label.spec.ts`

**US-008**

- `apps/web/composables/useTimelineEvents.ts`
- `apps/web/tests/composables/useTimelineEvents.spec.ts`

**US-009**

- `.github/workflows/ci.yml`
- `turbo.json`
- `apps/api/test/unit/tooling/ci-change-filter.spec.ts`

**US-010**

- `.github/workflows/release.yml`
- `RELEASING.md`
- `apps/api/test/unit/tooling/release-channels.spec.ts`

**US-011**

- `deployments/example/deploy.sh`
- `apps/api/test/unit/tooling/deploy-script.spec.ts`
- `apps/api/test/unit/tooling/deploy-script-harness.spec.ts`

### Creates

None. Extend the existing implementation and regression suites.

### Modifies

**US-001**

- `apps/api/src/code-intel/code-graph.service.ts` — Extract calls and variable-bound functions.
- `apps/api/src/code-intel/code-graph.service.spec.ts` — Replace the expected arrow exception with successful extraction assertions.
- `apps/api/src/code-intel/code-graph.batch.spec.ts` — Pin isolation of genuinely malformed siblings and equality for valid arrow extraction.
- `apps/api/test/e2e/ast-index.e2e.spec.ts` — Verify durable symbols and both HTTP graph reads.

**US-002**

- `apps/api/src/vcs/vcs-pr-sync.service.ts` — Move eligibility to the live merge application.
- `apps/api/src/vcs/vcs-pr-sync.service.spec.ts` — Replace stale snapshot call-count expectations.
- `apps/api/test/integration/vcs/vcs-pr-sync-auto-transition.spec.ts` — Exercise selection/start/application ordering.
- `apps/api/test/integration/vcs/vcs-merge-step.integration.spec.ts` — Verify a single durable transition under repeated delivery.

**US-003**

- `apps/api/src/tickets/tickets.service.ts` — Format successful status updates like ordinary edits.
- `apps/api/src/tickets/ticket-route.commands.ts` — Return mapped responses from all seven transition variants.
- `apps/api/src/tickets/domain/ticket.domain.ts` — Require the project ID in the embedded label type.
- `apps/api/src/tickets/prisma-tickets.repository.ts` — Preserve projectId in flat embedded labels.
- `apps/api/src/tickets/ticket-route.commands.spec.ts` — Exercise each command variant and its serialized result.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — Compare persisted ticket and label fields across HTTP writes and reads.

**US-004**

- `apps/runner/src/journal/journal.ts` — Protect undelivered events during lease-scoped pruning.
- `apps/runner/src/journal/journal.spec.ts` — Verify SQLite retention, replay and acknowledgement boundaries.

**US-005**

- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — Apply one effective-close rule to all four lookup sites.
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.spec.ts` — Cover close histories with mixed acknowledgements.
- `apps/api/test/e2e/fleet/thread-send-guards.e2e.spec.ts` — Exercise the guard using a ready lease after rejection.
- `apps/api/test/integration/fleet/fleet-project-thread-send.integration.spec.ts` — Verify serialized retries and subsequent message acceptance.

**US-006**

- `apps/runner/src/daemon/owned-processes.ts` — Keep ownership rows after indeterminate cleanup.
- `apps/runner/src/executor/pid-registry.ts` — Expose enough probe information to distinguish disappearance from lookup failure.
- `apps/runner/test/unit/owned-processes.spec.ts` — Retry against freshly validated identity using injected process operations.

**US-007**

- `apps/cli/src/commands/ticket.ts` — Describe accepted assignee values in generated help.
- `apps/cli/src/commands/ticket.spec.ts` — Check help and ordinary versus self request mappings.
- `apps/cli/src/commands/label.ts` — Format a successful empty delete response according to --json.
- `apps/cli/src/commands/label.spec.ts` — Check machine output, text output and failure behavior.

**US-008**

- `apps/web/composables/useTimelineEvents.ts` — Convert picker dates when constructing the outgoing query.
- `apps/web/tests/composables/useTimelineEvents.spec.ts` — Exercise timezone boundaries, DST and cursor reuse.

**US-009**

- `.github/workflows/ci.yml` — Select patch paths for pushes and pull requests.
- `turbo.json` — Include patch contents in cache keys.
- `apps/api/test/unit/tooling/ci-change-filter.spec.ts` — Exercise patch-only Git diffs and runner task hashes.

**US-010**

- `.github/workflows/release.yml` — Reject superseded canaries before publish jobs run.
- `RELEASING.md` — Document canary ordering and redispatch behavior.
- `apps/api/test/unit/tooling/release-channels.spec.ts` — Exercise current and stale publication selection with stubbed tags.

**US-011**

- `deployments/example/deploy.sh` — Recognize export-prefixed password assignments during preflight.
- `apps/api/test/unit/tooling/deploy-script.spec.ts` — Cover password precedence and validation outcomes.
- `apps/api/test/unit/tooling/deploy-script-harness.spec.ts` — Exercise the wrapper against stubbed Docker and inspect captured output.

### Seams

Each story can ship independently. The web client consumes the API's existing inclusive timeline bounds. The runner consumes the existing lease-scoped event acknowledgement. CLI fixes preserve SDK request contracts. Root-owned delivery stories use the existing tooling harness under apps/api. No story introduces a shared schema or requires a downstream migration.

## Acceptance Criteria

### US-001

- AC-1 [integration] After indexing main calling helper twice, the callers and callees HTTP reads each return the counterpart exactly once. Referencing helper without calling it adds no edge.
- AC-2 [unit] A direct method call resolves by its existing method-name rule. Self calls create no self edge.
- AC-3 [integration] Reindex a file with two declarations plus a new documented top-level arrow. All three are queryable and the file has no error. A valid sibling still indexes when another sibling has a syntax error.
- AC-4 [unit] Both single-file and batch extraction return the binding name and callable signature for arrow and function-expression variables. A documented binding retains its JSDoc text and an undocumented binding has no docComment. A helper called inside either initializer resolves to the helper symbol.

### US-002

- AC-1 [integration] Select an open PR for a VERIFIED ticket, start the ticket before processing a merged provider result, then apply it. The link reads merged, the ticket reads VERIFY_FIX and it has one FIX_REPORT.
- AC-2 [integration] A ticket that leaves IN_PROGRESS before application receives zero merge reports and retains its live status. A linked, soft-deleted ticket also receives zero reports.
- AC-3 [integration] Deliver the same merge through polling and webhook handling. The eligible ticket advances once and has exactly one VCS_PR_MERGED activity, one FIX_REPORT and one system.vcs.pr-merge-transition audit entry.

### US-003

- AC-1 [integration] Use two labelled VERIFIED tickets with a project gitRemoteUrl and ticket gitRefFile. Start one via status PATCH and the other via POST start. Compare each result to GET of that ticket and an ordinary edit response for the same fixture. Assert the status for each step, its project-prefixed ref, non-null resolved gitRefUrl and flat labels including id, projectId, name and color.
- AC-2 [unit] Exercise verify, start, fix, both verify-fix outcomes, close and reject through their registered command variants. Each successful result contains the canonical project-scoped ticket and an empty label array when unlabelled.
- AC-3 [integration] For a gated transition, the initial response identifies a pending approval. After approval the stored result contains the same ref and label fields as GET. A denied transition leaves the ticket untouched.

### US-004

- AC-1 [integration] With seven-day retention and a done job eight days old, prune retains the unacknowledged terminal event and omits its directory from cleanup. Reopening SQLite still exposes the event for replay.
- AC-2 [integration] A partial acknowledgement keeps the row and directory. After the last acknowledgement, the next prune removes the expired job and returns its directory once.
- AC-3 [integration] A younger completed job and an active job survive pruning. Another expired and fully acknowledged lease can be pruned independently. If epochs share a job directory, omitting that directory from cleanup protects the retained epoch. Once both are eligible, return the directory once.

### US-005

- AC-1 [integration] A running lease reports a rejected close with session_not_ready. Once ready, the same lease accepts a message and a new close without a restart.
- AC-2 [integration] With an earlier rejection followed by a pending or applied close, the existing closing response still blocks sends and a second close. Two concurrent retry requests enqueue at most one new close.
- AC-3 [unit] All send, session-control and indirect close decisions use the effective close for the active lease. A previous lease's close cannot block a ready current lease.

### US-006

- AC-1 [unit] An inspection failure retains the row and sends no signal. A subsequent boot pass rereads identity and can reap the original matching process.
- AC-2 [unit] A denied signal retains ownership. A later identity mismatch clears the obsolete record without signalling the reused PID. Confirmed absence or ESRCH clears the record.
- AC-3 [unit] A successful cleanup signals the recorded process or group once. Clear protected PIDs, entries with no recorded host identity, and entries from a confirmed different host boot without signalling. If the current host identity is temporarily unreadable, retain rows with a known recorded host for retry. The current daemon’s own rows stay untouched.
- AC-4 [integration] Exercise the production probe with controlled process-command outputs. Malformed timestamps, command launch failures and denied inspection preserve the row. A definitively absent PID clears it. No signal is sent in these cases.

### US-007

- AC-1 [cli] ticket list --help describes a user ID or self for --assigned-to. Running the command with each form preserves its current request mapping.
- AC-2 [cli] Given HTTP 204, label delete --id abc --json exits zero and stdout parses as exactly {"id":"abc","deleted":true}. Without --json it prints the existing text confirmation.
- AC-3 [cli] A failed DELETE preserves the current error exit and emits no deletion confirmation.

### US-008

- AC-1 [integration] In Asia/Kuala_Lumpur, selecting 2026-11-28 for both fields sends 2026-11-27T16:00:00.000Z through 2026-11-28T15:59:59.999Z. An inclusive fixture returns both endpoints and excludes the next midnight.
- AC-2 [unit] In America/New_York the selected 2026-03-08 day spans 23 hours and 2026-11-01 spans 25 hours, measured from start through the exclusive next midnight.
- AC-3 [unit] From-only and to-only selections omit the other bound. Explicit timestamps pass through. Pagination carries the same bounds and changing a filter clears the prior cursor.

### US-009

- AC-1 [integration] For each patch declared in package.json, a patch-only diff yields code=true from the actual PR filter and matches the main push paths. A README-only control yields false for both.
- AC-2 [cli] In a disposable checkout, record the runner test task hash from a Turbo dry run. Changing only the contents of either declared patch changes the hash, and restoring its contents restores the baseline hash.

### US-010

- AC-1 [integration] With canary.2 and canary.10 on the same base, dispatching .2 fails before npm or Docker writes, whether or not npm already contains .2. Dispatching .10 selects both Docker canary tags and the npm canary channel.
- AC-2 [integration] A higher base version wins even with a smaller sequence. Very large decimal components compare numerically. Stable tags do not affect canary ordering. A failed remote tag listing prevents publication.
- AC-3 [integration] A retry of the newest already published canary retains the existing npm skip. A stable patch with a newer stable patch on the same minor retains version-only Docker tags. Capture actions with registry stubs.

### US-011

- AC-1 [integration] Bare and export-prefixed assignments with the same valid test password both pass preflight through the example script. The existing shell override takes precedence.
- AC-2 [integration] An absent or invalid effective password still fails before Docker is invoked. Captured stdout and stderr never contain the supplied password on either path.
