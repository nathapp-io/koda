# SPEC: November 25 Koda review remediation

## Summary

Resolve findings 4–14 from `docs/20261125-review-whole-repo.md` in one nax feature and one PR. Each finding has one owning story and independently observable regression criteria. The story order starts with web actions and threads, then covers runner shutdown and the fleet API. Finding numbers refer to the review document.

## Motivation

People can see success for a write still awaiting approval, lose access to usable thread controls, or see an acknowledged cancellation finish as completed. Project and repository removal can also leave jobs, stored files and search results inconsistent. The review contains runnable observations at `7e2342791`. The integration points below were checked on `abae5e5b5`. For finding 4, the reviewed database controls established the two sides of a race. A deterministic interleaving is part of the requested implementation evidence.

## Design

### Integration and failure handling

Each story below names the current producer, the consuming entry point, the changed behavior and the checks at their boundary. Use the existing project rules in `.nax/rules/`, including the permission-key, repository, transaction, test-isolation and web i18n rules. Regression tests belong in package test suites. The dated review fixtures assert historical behavior and are read-only references.

For the three approval-gated web calls, use the existing unwrapped approval summary. Check the operation's permission key, pending status and request ID, following the existing fleet dispatch UI. A pending transcript message also has a pending status. A queued reindex also has HTTP status 202. Neither alone identifies an approval.

For bundle reconciliation, a primary read must observe the settled metadata transaction. If an acknowledgement was lost and its commit could still be running, serialize the verification with the same job-row lock in a fresh transaction before reading the artifact pointer. An inconclusive verification preserves the bytes. Per-attempt keys are unique, so subsequent upload attempts cannot reclaim an old key. The exception path only cleans up its own attempt.

## Out of Scope

- Deployment, runner distribution, CLI publication and live data changes.
- Findings 1–3 and 15–18 from the November 25 review, and the separate performance work.
- A retrospective scan or deletion of files orphaned before the cleanup records exist.
- Expansion of the existing project-repository enumeration limit. US-011 takes eligible repository IDs from the current bounded listProjectRepos result.
- Changes to the public approval wire format, permission catalog or fleet protocol.

## Stories

### US-001 — Display pending approval for three web actions

Workdir: apps/web

No dependencies.

Finding 10. ApprovalPendingFilter returns HTTP 202 with an enveloped ApprovalRequestSummaryDto. Ticket submit currently ignores the result, fleet cancel assigns it to the job view, and thread send merges it as a message. Distinguish the approval summary using its actual shape in the request/response path. Limit the behavior change to these three operations. Expose the returned request ID and keep the draft or job visible. Translate new copy in both locales. Preserve the existing retry rules for transport errors and closing sessions.

### US-002 — Catch up when the thread event stream first becomes ready

Workdir: apps/web

Depends on US-001.

Finding 11. useThread and useWorkspaceThread both load before subscribing. createThreadEventStream marks the initial ready event live, while its resync callback currently fires on transport reopen. Catch up at server readiness once per connected stream, including reconnect. Reconcile thread detail and messages. Protect both snapshot ordering and updates to the same message sequence, including text deltas. A rejected background read must be handled and allow subsequent recovery.

### US-003 — Show project thread errors and retry transient loads

Workdir: apps/web

Depends on US-002.

Finding 12. useThread suppresses its initial load rejection to keep the stream alive. Expose load state to the project detail page following useWorkspaceThread. Distinguish initial loading, unavailable or inaccessible detail and a retryable failure. Avoid revealing whether a forbidden thread exists. A successful retry or live recovery clears obsolete feedback.

### US-004 — Page active and archived project threads

Workdir: apps/web

No dependencies.

Finding 13. useThreads loads the first 100 rows for a status. Mirror useWorkspaceThreads' loadMore behavior on the project route. Retain the current generation guard across status switches and same-status reloads. Keep the page number on failure so retry reads the missing page.

### US-005 — Apply effective project send permission to the composer

Workdir: apps/web

Depends on US-001, US-003.

Finding 14. composerState gates on creator identity before checking sendRefusal and running messages. On the project page resolve send access from useProjectPermissions, including any-row and own-row keys and thread ownership. Pass the boolean into the shared composer logic. The workspace page supplies its existing personal-thread decision. Permissions still load asynchronously and API authorization remains authoritative.

### US-006 — Honor RUN cancellation through log drain

Workdir: apps/runner

No dependencies.

Finding 8. JobRun.finish computes a verdict before awaitLogs. For a RUN, serialize the final cancellation check with the RUNNING to UPLOADING journal transition. An accepted cancellation wins while the drain is held. A newly delivered cancellation after this cutoff must report refusal. Replay of an already handled command uses its recorded acknowledgement. Preserve command-specific CONFIG result semantics, existing lease fencing and recovery.

### US-007 — Bound thread turn settlement and session close

Workdir: apps/runner

No dependencies.

Finding 9. ThreadJobRun.finishRun awaits turnSettled before closeHeldSession starts its timed wait. After startup and any live-publish coordination, use one threadCloseTimeoutMs budget for settling the cancelled turn and waiting on session close. Start close exactly once even when the budget is exhausted. Seal the writer and fence late turn callbacks and writes. Keep the separate log-drain timeout and daemon halt semantics.

### US-008 — Fence scheduled job insertion against project deletion

Workdir: apps/api

No dependencies.

Finding 4. ScheduleTicker.dispatchFresh checks owner access before FleetJobsService.dispatch opens the job insertion transaction. Inside that transaction acquire a row lock on the live Project using a transaction-aware repository method, compatible with both soft-delete UPDATE paths. Decide liveness under the lock before creating the job or its dependent records. Keep the established handling for a refused dispatch and post-commit placement.

### US-009 — Retain cleanup targets across fleet repository deletion

Workdir: apps/api

No dependencies.

Finding 5. FleetReposService.remove locks the repository, rejects unfinished jobs, then deletes it. Cascades erase the only lookup for logs and bundles. Capture terminal job IDs, lease-epoch bounds, finished times and exact bundle keys in durable cleanup records in the same transaction, before the cascade. Keep those records independent of the deleted parents. Extend the existing retention pass to consume eligible records using its cutoff and store methods. Use bounded batches, retry partial failures idempotently and acknowledge only after all targeted deletions succeed. Keep the existing retention setting and schedule.

### US-010 — Reconcile a stored bundle after metadata failure

Workdir: apps/api

No dependencies.

Finding 6. BundleService.upload generates a unique attempt key, writes bytes, then uses a transaction to fence and record that attempt. Known rejections already delete the new object. Handle a thrown transactional error as well. After the transaction settles, use a fresh primary database read for this job, bundle kind and epoch. Delete only an attempt known to be unreferenced. If the commit is uncertain and the read itself fails, retain the bytes, emit a recoverable diagnostic identifying the attempt, and propagate the original failure. This story covers request-time reconciliation.

### US-011 — Rank knowledge candidates from registered repositories

Workdir: apps/api

No dependencies.

Finding 7. KnowledgeSearchService.search currently chooses bounded lexical and vector candidates before listProjectRepos is consulted. Obtain the project registry first and apply the registered repo IDs, intersected with any requested repo, inside both storage predicates before either leg's row cap. Preserve project partitioning, source selection, embedded-row constraints, path-prefix behavior, rank fusion, outcome job visibility, lexical-only mode and the existing meaning of empty. Empty eligibility must never broaden a query.

### Context Files

**US-001**
- `apps/api/src/approvals/route/approval-gated.decorator.ts` — pending response producer.
- `docs/review-evidence/20261125/web.ts` — mounted pending and executed fixtures.
- `apps/web/composables/useFleetJobs.ts` — job cancellation operation.
- `apps/web/lib/approval-requests.ts` — existing ApprovalRequestSummary type for union responses.
- `apps/web/components/fleet/FleetJobOpenItems.vue` — existing scoped pending check using permissionKey, status and the returned id.

**US-002**
- `apps/web/composables/useThread.ts` — project subscription.
- `apps/web/composables/useWorkspaceThread.ts` — workspace subscription.
- `docs/review-evidence/20261125/web.ts` — event-bus and delayed-subscription fixture.

**US-003**
- `apps/web/composables/useWorkspaceThread.ts` — existing load and retry adapter.
- `apps/web/pages/threads/[id].vue` — workspace recovery presentation.
- `docs/review-evidence/20261125/web.md` — project deep-link controls.

**US-004**
- `apps/web/composables/useWorkspaceThreads.ts` — working paging contract.
- `apps/web/pages/threads/index.vue` — workspace control.
- `apps/api/src/fleet/threads/threads.controller.ts` — paged project response.

**US-005**
- `apps/web/lib/permissions.ts` — has and hasOwn semantics.
- `apps/web/composables/usePermissions.ts` — effective project permissions.
- `apps/api/src/fleet/threads/threads.controller.ts` — project send authority.
- `docs/review-evidence/20261125/web.ts` — permission matrix.

**US-006**
- `docs/review-evidence/20261125/runner-lifecycle.ts` — real handler, journal and controlled drain.
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — cancel contract and upload cutoff.
- `apps/runner/src/supervisor/job-run-config.spec.ts` — CONFIG result precedence control.

**US-007**
- `docs/review-evidence/20261125/runner-lifecycle.ts` — held facade finalizer and injected time.
- `apps/runner/test/unit/thread-job-run-halt-safety.spec.ts` — halt and recovery controls.

**US-008**
- `apps/api/src/fleet/schedules/schedule-ticker.ts` — due tick and owner authorization.
- `apps/api/src/projects/projects.service.ts` — ID and slug soft-delete paths.
- `apps/api/src/fleet/jobs/project-deletion-jobs.listener.ts` — post-delete quiesce.
- `docs/review-evidence/20261125/database-controls.py` — separate deletion controls.

**US-009**
- `apps/api/src/fleet/logs/log-store.ts` — log prefix deletion.
- `apps/api/src/fleet/artifacts/artifact-store.ts` — bundle deletion.
- `docs/review-evidence/20261125/database-controls.py` — real deletion and retention controls.

**US-010**
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — findArtifact identifies the recorded attempt.
- `apps/api/src/fleet/artifacts/artifact-store.ts` — unique attempt keys and delete.
- `docs/review-evidence/20261125/bundle-cleanup.ts` — post-put fault fixture.

**US-011**
- `apps/api/src/fleet/knowledge/knowledge-chunk-store.ts` — Lance where and limit on each leg.
- `apps/api/src/fleet/knowledge/project-knowledge.controller.ts` — REST caller.
- `apps/api/src/fleet/assistant/tools/kb-tools.ts` — assistant caller.
- `docs/review-evidence/20261125/search-ranking.ts` — real ranked LanceDB fixture.

### Creates

**US-001**
None. Extend the existing package files.

**US-002**
None. Extend the existing package files.

**US-003**
None. Extend the existing package files.

**US-004**
None. Extend the existing package files.

**US-005**
None. Extend the existing package files.

**US-006**
None. Extend the existing package files.

**US-007**
None. Extend the existing package files.

**US-008**
None. Extend the existing package files.

**US-009**
- `apps/api/prisma/migrations/20261219090000_fleet_retired_job_cleanup/migration.sql` — create the independent cleanup table and due-work index without rewriting existing job history.

**US-010**
None. Extend the existing package files.

**US-011**
None. Extend the existing package files.

### Modifies

**US-001**
- `apps/web/composables/useApi.ts` — allow scoped callers to distinguish an approval response from an executed result.
- `apps/web/composables/useFleetJobs.ts` — carry the cancel result through to the job page.
- `apps/web/components/CreateTicketDialog.vue` — preserve form and present the request ID on pending creation.
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` — branch before applying a job response or showing success.
- `apps/web/lib/thread-controller.ts` — distinguish pending send and remove its optimistic echo.
- `apps/web/components/fleet/threads/ThreadComposer.vue` — retain pending drafts and present the request ID.
- `apps/web/pages/[project]/threads/[id].vue` — handle pending send through the project page action.
- `apps/web/pages/threads/[id].vue` — preserve the shared action contract for workspace threads.
- `apps/web/i18n/locales/en.json` — English pending feedback.
- `apps/web/i18n/locales/zh.json` — Chinese pending feedback.
- `apps/web/tests/components/CreateTicketDialog.spec.ts` — test populated form on pending and executed submission.
- `apps/web/tests/pages/fleet-job-detail.spec.ts` — exercise both cancellation replies.
- `apps/web/tests/lib/thread-controller.spec.ts` — exercise pending and executed send responses.
- `apps/web/tests/components/thread-composer.spec.ts` — assert draft and feedback after pending send.
- `apps/web/tests/pages/threads-detail-actions-page.spec.ts` — mount the project page with its real composer and verify pending-send feedback and draft preservation.
- `apps/web/tests/composables/useApi.spec.ts` — check response discrimination against queued reindex.

**US-002**
- `apps/web/lib/thread-event-stream.ts` — deliver one catch-up signal per ready connection.
- `apps/web/lib/thread-controller.ts` — reconcile ready reads, failed reads, late replies and teardown.
- `apps/web/lib/thread-view.ts` — preserve newer message content and terminal state during reconciliation.
- `apps/web/tests/lib/thread-event-stream.spec.ts` — change the first-ready and reconnect expectations.
- `apps/web/tests/lib/thread-event-stream-recovery.spec.ts` — retain backoff and auth recovery coverage.
- `apps/web/tests/lib/thread-controller.spec.ts` — cover overlapping snapshots and live deltas.
- `apps/web/tests/composables/useThread.spec.ts` — exercise the project adapter through ready.
- `apps/web/tests/composables/useWorkspaceThread.spec.ts` — exercise the workspace adapter through ready.

**US-003**
- `apps/web/composables/useThread.ts` — surface initial read failure and retry without duplicating the stream.
- `apps/web/pages/[project]/threads/[id].vue` — render unavailable and retry states alongside loaded detail.
- `apps/web/i18n/locales/en.json` — supply English feedback when an existing key cannot be reused.
- `apps/web/i18n/locales/zh.json` — supply corresponding Chinese feedback.
- `apps/web/tests/pages/threads-detail-page.spec.ts` — exercise initial failures and successful retry.
- `apps/web/tests/composables/useThread.spec.ts` — cover retry, recovery and unmount behavior.

**US-004**
- `apps/web/composables/useThreads.ts` — track next page, selected status and in-flight reads.
- `apps/web/pages/[project]/threads/index.vue` — expose the load-more control and retry feedback.
- `apps/web/tests/composables/useThreads.spec.ts` — exercise generations, concurrent calls and failures.
- `apps/web/tests/pages/threads-page.spec.ts` — exercise active and archived paging.

**US-005**
- `apps/web/lib/thread-view.ts` — take a resolved send decision while retaining session and running-turn checks.
- `apps/web/pages/[project]/threads/[id].vue` — derive the send decision reactively from ownership and effective keys.
- `apps/web/pages/threads/[id].vue` — adapt the shared helper without changing workspace scope.
- `apps/web/tests/lib/thread-view.spec.ts` — replace creator-only fixtures with resolved send decisions.
- `apps/web/tests/pages/threads-detail-page.spec.ts` — assert the project grant matrix.
- `apps/web/tests/pages/threads-detail-actions-page.spec.ts` — give the creator fixture its effective thread.message.send.own grant alongside thread.archive, retaining the typing, submission and refusal-toast assertions.
- `apps/web/tests/pages/workspace-thread-detail-page.spec.ts` — retain the personal-thread control.

**US-006**
- `apps/runner/src/supervisor/job-run.ts` — resolve RUN cancellation and upload cutoff consistently in requestCancel and finish.
- `apps/runner/src/supervisor/supervisor.ts` — propagate the active RUN's cancellation result and apply the same cutoff to journal-only recovery before readoption.
- `apps/runner/src/supervisor/supervisor.spec.ts` — distinguish recovered and active RUN cancellation before and after the cutoff while preserving the thread and CONFIG paths.
- `apps/runner/src/supervisor/command-handler.ts` — carry the run cancellation decision into the acknowledgement.
- `apps/runner/src/supervisor/job-run.spec.ts` — cover final decision and recovery from persisted cancellation.
- `apps/runner/src/supervisor/command-handler.spec.ts` — cover fresh versus redelivered command IDs.

**US-007**
- `apps/runner/src/thread/thread-job-run.ts` — bound the wait, fence stale finalizers, and preserve the close owner.
- `apps/runner/src/thread/thread-event-writer.ts` — make stream sealing effective for callbacks already holding the writer when the deadline expires.
- `apps/runner/test/unit/thread-event-writer.spec.ts` — check that a late callback on a retained writer cannot append past its terminal marker.
- `apps/runner/test/unit/thread-job-run-hardening.spec.ts` — cover a held turn, held close and late writes.
- `apps/runner/test/unit/thread-job-run-turns.spec.ts` — cover a turn settling normally during close.

**US-008**
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — declare the live-project lock operation.
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — lock and check the project through the active Prisma transaction.
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — refuse insertion for a missing or deleted project within the create transaction.
- `apps/api/src/fleet/jobs/fleet-jobs.service.spec.ts` — supply the live-project guard in dispatch fixtures and cover refusal.
- `apps/api/src/fleet/jobs/fleet-jobs.audit.spec.ts` — supply a live project in successful insertion fixtures and preserve the audit rollback checks.
- `apps/api/src/fleet/jobs/fleet-jobs.thread-handoff.spec.ts` — supply the project guard in the handoff dispatch fixture while retaining the expected handoff decision.
- `apps/api/test/integration/fleet/fleet-schedule-ticker.integration.spec.ts` — add a deterministic two-connection tick versus delete case.
- `apps/api/test/integration/fleet/project-deletion-quiesce.integration.spec.ts` — retain the opposite ordering as a control.

**US-009**
- `apps/api/prisma/schema.prisma` — add durable cleanup records with cutoff and stable job identity.
- `apps/api/src/fleet/repos/fleet-repos.service.ts` — capture cleanup targets before deleting each eligible repository.
- `apps/api/src/fleet/repos/domain/fleet-repo.domain.ts` — declare transactional capture.
- `apps/api/src/fleet/repos/prisma-fleet-repo.repository.ts` — persist cleanup records for terminal jobs in the deletion transaction.
- `apps/api/src/fleet/logs/domain/log-retention.domain.ts` — describe outstanding cleanup records and acknowledgement.
- `apps/api/src/fleet/logs/prisma-log-retention.repository.ts` — page due records and settle successfully completed work.
- `apps/api/src/fleet/logs/fleet-log-retention.processor.ts` — drain deleted-repository work through both stores as part of purge.
- `apps/api/src/fleet/repos/fleet-repos.service.spec.ts` — extend the removal fixtures with capture and rollback.
- `apps/api/src/fleet/logs/fleet-log-retention.processor.spec.ts` — cover partial cleanup, replay and bounded progress.
- `apps/api/test/integration/fleet/fleet-log-retention.integration.spec.ts` — exercise repository DELETE followed by retention against real files.

**US-010**
- `apps/api/src/fleet/artifacts/bundle.service.ts` — reconcile the attempt outside the failed transaction and preserve the original error.
- `apps/api/src/fleet/artifacts/bundle.service.spec.ts` — inject transaction, verification-read and delete errors.
- `apps/api/test/integration/fleet/fleet-bundles.integration.spec.ts` — exercise actual stored bytes and durable metadata across attempts.

**US-011**
- `apps/api/src/fleet/knowledge/knowledge-search.service.ts` — scope both rank inputs to project-registered repositories before truncating candidates.
- `apps/api/src/fleet/knowledge/knowledge-search.service.spec.ts` — cover eligibility, mode and project scope controls.
- `apps/api/test/integration/fleet/knowledge-store.integration.spec.ts` — exercise the search service with real LanceDB ordering and constraints.

### Seams

US-001 owns pending send. US-002 builds on its controller so resync retains valid optimistic state. US-003 consumes that recovery in the project detail view. US-005 retains the pending-send and load-error behavior while changing whether the composer accepts input. The runner stories govern distinct execution paths. The database stories remain independently verifiable. US-009 operates on terminal-job files captured before repository deletion, US-010 identifies one upload by its unique storage key, and US-011 handles retired chunks already present in a search table.

## Acceptance Criteria

### US-001

- [integration] For ticket create, job cancel and thread send, supply the real pending-summary shape with the corresponding operation key. Each mounted action shows pending feedback containing the returned request ID.
- [integration] A pending ticket submission leaves the populated dialog open and emits no created event.
- [integration] Pending ticket and job actions produce zero execution-success toasts.
- [integration] After a pending cancellation, the mounted job detail continues to render the original job.
- [integration] After a pending thread send, the draft remains editable and the transcript returns to its pre-submit messages.
- [unit] The thread controller makes one POST when a send returns a pending approval.
- [integration] Exercise the existing executed responses through the three forms. The ticket emits created, cancellation renders the returned job, and the executed send replaces its optimistic message.
- [unit] Through the web request adapter a queued-reindex 202 with data { queued: true } still delivers that object to its caller.

### US-002

- [integration] For each scope, finish a turn between initial GET and subscription. Deliver ready and observe the final transcript and an available composer without disconnecting.
- [unit] Deliver open, ready and a duplicate ready for one connection, then reconnect and deliver open and ready. Each ready connection initiates one catch-up.
- [unit] Hold a catch-up snapshot and deliver a newer terminal message or text delta for the same message. Release the older response and assert the latest status and content survive without duplicates.
- [unit] Reject a ready-triggered read, then reconnect successfully. The controller recovers the transcript. Stop the controller during a held recovery and verify its completion cannot reopen the stream or polling.

### US-003

- [integration] Open a project thread deep link returning 403 or 404. The detail area renders the same localized unavailable message for either response and shows no private thread content.
- [integration] Open a project thread returning 503, select its visible retry action and return a valid detail. The page displays the thread, clears the failure and uses one subscription.
- [unit] Resolve a later live reload after the initial load failed. Once a valid thread is present the stale error state does not mask it.

### US-004

- [integration] Mount the project list with 101 active and 101 archived threads. For each status, load more fetches page two for that status, shows row 101 once and hides the control after the short page.
- [unit] Hold an active page-two response across a switch to archived or a same-status page-one reload. Releasing the held response leaves the new list intact.
- [unit] Double-click load more during a pending read. Only one request goes out. After an injected failure the next click retries the same page and preserves the visible rows.

### US-005

- [integration] With an idle project thread and a different creator, an any-row thread.message.send grant enables the mounted composer. An own-only grant disables it.
- [integration] On the creator’s project thread, an own-only grant enables sending. Missing or still-loading grants leave the composer read-only, and a later effective grant updates it.
- [unit] With send permission present, a server sendRefusal or a running turn still disables the composer with the appropriate reason.
- [integration] The mounted personal workspace thread retains its existing owner-based composer behavior without requiring project permission data.

### US-006

- [integration] Drive a RUN through ASSIGN using the handler and journal, hold the log drain after a successful result, and send CANCEL. The acknowledgement is ok, the timestamp is durable, and releasing the drain publishes exactly one CANCELLED terminal event.
- [integration] Replay that same command ID after completion and observe its original acknowledgement and one terminal event. A distinct CANCEL first delivered in UPLOADING is refused and creates no cancellation timestamp on a previously uncancelled RUN.
- [unit] Resume finish from a persisted RUN with an accepted cancellation. The final event remains CANCELLED. An otherwise identical uncancelled successful RUN ends COMPLETED.
- [unit] On restart before readoption, deliver a fresh CANCEL against a journal-only RUN. A RUNNING row records the request, while an UPLOADING or terminal row refuses it without changing the journal.
- [unit] A CONFIG operation that already produced its authoritative result retains the existing late-cancel result precedence.

### US-007

- [integration] Drive THREAD_CLOSE with a held transcript finalizer, a ready startup and an immediately completing log drain. Advancing the injected clock by the close budget lets the run seal its stream, finish and stop heartbeats while the finalizer is still held.
- [unit] Consume part of the close budget in turn settlement and hold session.close for the remainder. Only the remaining budget is waited and close starts once.
- [unit] Release a held finalizer and deliver late callbacks after sealing. The stream bytes, terminal event count and journal completion stay fixed.
- [unit] With timely settlement, final transcript content precedes the single close marker. A daemon halt during settlement leaves the job recoverable without publishing a terminal event.

### US-008

- [integration] With disposable PostgreSQL and no runner attached, pause a due tick after successful owner authorization, commit project soft deletion through the application, and resume it. A fresh database read finds zero jobs for that schedule and no assignment command.
- [integration] Pause an authorized insert after its live-project read inside the transaction. Start application soft deletion on a second connection. Use PostgreSQL lock-wait observation to establish that deletion waits for the insert. Release the insert, allow deletion to commit, and verify the deletion listener cancels the queued job.
- [integration] For a live project and authorized owner the due tick still creates one job, including when two tickers race to claim the same occurrence.

### US-009

- [integration] Delete a repository containing an expired terminal job with log files at two epochs and a recorded bundle. After restarting the retention worker and running purge, the target files and cleanup record are gone and an unrelated job’s files remain.
- [integration] Abort the removal transaction after target capture. The repository, files and metadata remain intact with zero committed cleanup records. A repository with an unfinished job still refuses removal.
- [integration] Remove a repository whose terminal job is newer than the retention cutoff. Its files survive the first pass and expire once the cutoff advances beyond its finish time.
- [unit] Fail one store deletion after a previous deletion succeeds, then run purge again with the first file already absent. Pending work survives failure, finishes on retry, and a third pass makes no further change.
- [unit] With multiple eligible records including one persistently failing target, bounded processing still reaches the later eligible records.

### US-010

- [integration] After writing a replacement bundle, fail the transaction before it records metadata. With a reachable database, the new file is removed, the request fails, and the previous bundle row and bytes remain readable.
- [integration] Model a lost commit acknowledgement using two PostgreSQL connections and the disk store. Hold the recording transaction's job-row lock after pointing the artifact at the new key, and start the request's reconciliation path while that transaction is outstanding. Observe the verifying transaction waiting for the lock with the bytes still present. Commit the record and verify that the request reports its original error and the recorded bundle remains readable.
- [unit] Fail the verification read after an uncertain commit. The attempt is retained, a diagnostic identifies its key, and the transaction error remains the request error. An error deleting a confirmed orphan likewise leaves a diagnostic without masking the original failure.
- [integration] Retry a failed upload with a new key. A successful retry has readable bytes and matching metadata, and cleanup for the failed attempt cannot remove that successful key.

### US-011

- [integration] With one matching live document below 50 higher-ranked retired documents, project-wide lexical-only search returns the live document and zero retired hits.
- [integration] Use a controlled embedding and real LanceDB with the only live vector match below the retired candidates and no lexical match for the query. The live document is returned in vector-enabled search.
- [unit] At the search service boundary, an empty registry, a retired explicit repo ID or another project’s repo ID yields zero eligible hits. A live explicit repo restricts both legs to that repo. The REST route retains its existing not-found response for an unknown repository name.
- [unit] Exercise docs, outcomes and all with registered repositories. Preserve source and path-prefix filtering, omit outcomes for inaccessible jobs, retain lexical fallback on embedding failure, and keep empty keyed to stored source rows.
