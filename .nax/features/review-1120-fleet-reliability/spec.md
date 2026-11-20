# SPEC: Fleet synchronization, ruling identity and thread cancellation

## Summary

Resolve findings 2, 8, 9 and 10 in `docs/20261120-review-37b396c49.md` against main `37b396c49`. A stale lease must release its resources while the runner keeps polling. Ruling retirement and ready comments must refer to the configured forge. Capability delivery must recover from an unrelated batch error. Thread cancellation must end the event stream and its heartbeat in order.

## Motivation

- **Finding 2.** Placement ordinarily refuses a second non-thread job on the same runner and repository. The API can cancel A before its assignment acknowledgement, assign B, then receive a stale report from A and queue ABANDON. Commands arrive in creation order. B can acquire the repo mutex ahead of A's cleanup and wait for a git token available only through the blocked poll. A runner fixture observed B fail on its simulated token timeout.
- **Finding 8.** A newer RUN under the same repository ID can report a URL on another forge with the same owner, repo and PR number. Ingest can replace the earlier RUN's pending rulings. A ready notification can also reach a ticket belonging to the foreign URL.
- **Finding 9.** A pending capability update can coincide with an invalid event. A 17,000-character status phase survived snapshot construction and exceeded the API's 16 KiB event limit. The API independently accepted the capability object. The loop recovered the event but suppressed the valid hash.
- **Finding 10.** A cancellation delivered while a repository thread opened its stream produced a CANCELLED row, a lone `session_started` line and a subsequent heartbeat snapshot. Project and workspace session startup have the same ordering.

## Design

### Integration

**Retirement.** Today `SyncLoop.apply` awaits `abandonUnknown` and `handleCommands`. Keep ordering of command initiation. Initiate ABANDON through the normal command handler so the target halts promptly, but track completion outside the poll. The runner may omit its ack on a sync while cleanup is pending. Deduplicate in-flight delivery by command ID and serialize retirement of the same job and epoch across command and unknown-job paths. Finish cleanup under the existing repo mutex, persist the command outcome using the existing journal and enqueue its ack for a later sync. An already completed command replays its stored outcome. The server redelivers unacknowledged commands on restart. Snapshot the local epochs for a missing job before scheduling their removal so later leases cannot enter an earlier sweep. On graceful daemon stop, stop polling, halt runs and close broker sockets before joining outstanding run, cleanup and command-outcome writers; close the journal last. The separate daemon.crash() hook simulates process death and returns without draining. Recovery follows server redelivery and journal records. Preserve best-effort cleanup errors already handled inside JobRun. If retirement succeeds or an error escapes the supervisor and the handler classifies the command as rejected, persist that outcome before offering the ack. If persisting it fails, withhold the ack, clear the in-flight entry and allow redelivery; keep the journal error observable. A lost ack must replay the recorded outcome. If execution is interrupted before a durable outcome, reconcile whatever epoch resources remain on redelivery without assuming external cleanup ran exactly once. Keeping a polling loop free must not weaken process identity checks or epoch-scoped cleanup.

**Ruling identity.** Today `PrismaFleetPrRulingRepository.latestRunForPr` combines `sameRepoOrigin` with `prNumberFor`. Give `latestRunForPr`, `replaceOlderRuns` and `runsForPr` a shared PR-number resolver with those semantics. Compare normalized URL origins (including scheme and non-default port) and use the existing provider-specific path parser. An unparseable URL or configured host resolves to no PR. Retain the existing RUN, workflow, age/tie-break, pending-state, repository, ordering and paging predicates at their respective call sites. Ingest already owns the transaction for retirement.

**Capability reporting.** Today a mixed-request 400 stores `capsRejected` immediately. Isolate the attempted capability hash using the same valid runner envelope and empty jobs, acks and credential requests. On success, apply the probe response through the ordinary response path, including commands, and mark exactly the accepted hash sent. Use the positive base-only control before suppressing a hash after an isolated 400. The deployed parser need not expose a capability-specific error code. An original, already isolated request can provide the isolated evidence. Process commands and archive notices from every successful probe, including a base-only control, using the exact fields it sent. Only confirm items actually included. Preserve the original batch’s isolation scale, failure/backoff accounting and pending acknowledgement details when an empty control succeeds. Retry the original pending work through existing batch isolation. A changed hash remains eligible. Maintain stop, network backoff and request-abort semantics, including when the probe carries newly delivered commands in its response.

**Thread termination.** Both session startup paths transition RUNNING before awaiting `openStream`. Coordinate this interval with `requestCancel` and `finishRun`. On successful stream setup let one close owner seal and drain the stream, stop log shipping, mark the row done and release the session. Skip initial input, idle and heartbeat scheduling once close starts. Protect heartbeat scheduling and emission against already ended runs. Preserve bounded session close and shutdown behavior, including when stream setup fails or a halt occurs while it is pending.

### Failure Handling

A repeated abandonment rejoins or replays one retirement. A failed capability probe leaves unconfirmed state retryable through the ordinary network/protocol handling. Ruling URL mismatch selects zero rows. A stream-open failure while cancellation is pending uses the existing RUNNING → UPLOADING → FAILED startup failure path, once. Release the session, timers and any log registration, even for a partially initialized stream. A halt preserves the recoverable journal state and does not synthesize a terminal transition.

## Out of Scope

- Changes to API placement, cancellation, fencing, wire envelopes and database schema.
- Broadening the ruling change into a project-wide rewrite of PR attribution or forge URL storage.
- Changing nax status snapshot sizing or the API's event byte limit.
- Changing the semantics of thread PUBLISH and DISCARD action jobs.

## Stories

**US-001: Keep polling during stale-lease cleanup.** Workdir: `apps/runner`. No dependencies. Deliver the next sync while retirement waits, publish the ack after cleanup, and handle redelivery and shutdown.

**US-002: Use the configured forge for ruling retirement and ready selection.** Workdir: `apps/api`. No dependencies. Reuse latest-RUN identity validation across the three affected repository operations.

**US-003: Isolate capability validation from batch errors.** Workdir: `apps/runner`. Depends on US-001 because both change sync response handling. Confirm an isolated result before suppressing a hash and preserve delivery of deferred command acknowledgements.

**US-004: Finish thread stream startup and cancellation in order.** Workdir: `apps/runner`. No dependencies. Cover repository, project and workspace session jobs across the RUNNING-to-stream-ready interval.

### Context Files

**US-001**
- `apps/runner/src/supervisor/job-run.ts`
- `apps/runner/src/supervisor/repo-mutex.ts`
- `apps/runner/src/supervisor/command-handler.ts`
- `apps/runner/src/daemon/daemon.ts`
- `apps/api/src/fleet/sync/fence.service.ts`
- `apps/api/src/fleet/jobs/placement-rules.ts`

**US-002**
- `apps/api/src/fleet/rulings/prisma-fleet-pr-ruling.repository.ts`
- `apps/api/src/fleet/sync/pr-attribution.service.ts`
- `apps/api/src/fleet/ingest/bundle-ingest.service.ts`
- `apps/api/src/fleet/ingest/parsers/workflow.parser.ts`
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts`

**US-003**
- `apps/runner/src/sync/sync-loop.ts`
- `apps/runner/src/sync/batch.ts`
- `apps/runner/src/capabilities/capability-probe.ts`
- `apps/api/src/fleet/sync/sync-request.parser.ts`

**US-004**
- `apps/runner/src/thread/thread-job-run.ts`
- `apps/runner/src/thread/thread-event-writer.ts`
- `apps/runner/test/unit/thread-job-run-halt-safety.spec.ts`

### Creates

None.

### Modifies

**US-001**
- `apps/runner/src/sync/sync-loop.ts` — dispatch and track slow retirement without waiting in apply, and deliver its eventual ack.
- `apps/runner/src/supervisor/supervisor.ts` — share in-flight epoch retirement across repeated cleanup requests and track shutdown.
- `apps/runner/src/daemon/daemon.ts` — connect background unknown-job retirement and wait for pending journal users on shutdown.
- `apps/runner/src/supervisor/command-handler.ts` — preserve journaled outcomes and replay while allowing deferred ABANDON completion.
- `apps/runner/src/supervisor/command-handler.spec.ts` — assert one cleanup and a replayable outcome after retirement.
- `apps/runner/src/sync/sync-loop.spec.ts` — exercise ordered assignments, deferred ack, repeated delivery and missing-job cleanup while polling continues.
- `apps/runner/test/unit/daemon.spec.ts` — check shutdown joins pending work before closing journal resources.

**US-002**
- `apps/api/src/fleet/rulings/prisma-fleet-pr-ruling.repository.ts` — share configured-forge PR identity across latest lookup, retirement and ready selection.
- `apps/api/test/integration/fleet/fleet-pr-ruling.repository.integration.spec.ts` — compare origins, provider paths and supported URL variants across selection paths.
- `apps/api/test/integration/fleet/fleet-pr-rulings-ingest.integration.spec.ts` — extend the existing FIX-only attach fixture with a current-lease RUN artifact containing a valid workflow result; retain the current ready-comment exact-body assertions.

**US-003**
- `apps/runner/src/sync/sync-loop.ts` — isolate capability delivery on mixed 400 and apply probe results with the exact probe envelope.
- `apps/runner/src/sync/sync-loop.spec.ts` — revise the D25 mixed-400 expectation to require isolated evidence and test both possible causes.

**US-004**
- `apps/runner/src/thread/thread-job-run.ts` — coordinate stream creation, cancellation, heartbeat and session finalization in both branches.
- `apps/runner/test/unit/thread-job-run.spec.ts` — inject cancellation at RUNNING before stream setup, verify event order and fake-clock behavior.
- `apps/runner/test/unit/thread-job-run-project.spec.ts` — cover cancellation during project stream startup.
- `apps/runner/test/unit/thread-job-run-workspace.spec.ts` — cover cancellation during workspace stream startup.
- `apps/runner/test/unit/thread-job-run-halt-safety.spec.ts` — check a halt during opening and normal close boundaries.

### Seams

US-003 consumes US-001's deferred command acknowledgement handling through `SyncLoop.run`. An isolated capability probe can deliver commands even though its outgoing command-ack array is empty. US-003 AC-4 exercises this response path.

## Acceptance Criteria

### US-001

- AC-1 [integration] Run the real sync loop, command handler, supervisor, journal and FIFO repo mutex with a fake executor. Hold A in prepare, deliver ASSIGN B followed by ABANDON A on the same repo, release halted A and have B wait for a token. Observe a second sync requesting B's token before B's deadline, grant it, and observe B resume.
- AC-2 [integration] In AC-1, no outgoing request acknowledges A's abandonment before its cleanup completes. The next delivery after completion carries the recorded successful ack for the original command ID and epoch.
- AC-3 [unit] Re-deliver the same ABANDON while cleanup is pending and after completion. Count one cleanup and verify the completed delivery replays the stored outcome.
- AC-4 [integration] For an unknown job reported on two responses while its repo lock is held, subsequent syncs deliver unrelated events. After both missing-job responses have been received, introduce a higher epoch and release the lock. Observe one cleanup per originally captured epoch and preservation of the new epoch.
- AC-5 [unit] Restart the command handler against the same journal at two checkpoints. Before a completed command record, server redelivery finishes outstanding cleanup. After a completed record, redelivery returns the stored outcome without repeating execution. Cover both success and an error escaping supervisor.abandon with a lost ack; a deleted epoch row must never turn a recorded rejection into success.
- AC-6 [integration] Gracefully stop the daemon with tracked retirement waiting behind a run blocked on a broker credential. Closing the broker releases the waiter before the drain joins. Observe the retirement and outcome write settle before journal close, without advancing a credential timeout.

- AC-7 [unit] When persisting a completed ABANDON outcome fails, no ack is queued. Redelivering the same command after storage recovers records and returns its outcome; an absent epoch is an idempotent success when there is no prior rejection.
- AC-8 [unit] Drive explicit ABANDON and unknown-job cleanup for one epoch while the repo lock is held. Upon release there is one retirement, a mismatching process identity is never killed, and an owned higher epoch keeps its checkout.

### US-002

- AC-1 [integration] Ingest a newer RUN's workflow bundle under the same repo ID with the same PR path and number on another origin. Use a valid schemaVersion 1 workflow result with runId, verdict.outcome and boolean verdict.workflowPassed; the status workflow URL or already mirrored resultPrUrl supplies the candidate URL. Verify ingest completes and the earlier RUN's ruling remains pending.
- AC-2 [integration] Repeat with the configured origin and verify the older pending ruling becomes replaced, while already settled rulings and another PR's pending rulings retain their states.
- AC-3 [integration] Ingest a ready FIX with two matching RUN tickets and a third RUN carrying a foreign origin but the identical path. Verify each matching ticket receives the existing ready comment once across a retry, and the foreign ticket has zero such comments.
- AC-4 [integration] Call the repository lookups with GitHub and GitLab fixtures. Supported trailing slash, query and fragment variants on the configured origin match, a different origin or unparseable URL is skipped, and latest selection retains its existing newest-match ordering.
- AC-5 [integration] Use a configured origin with a non-default port and a candidate with the same host/path but a different port. Latest lookup and ready selection exclude it, and ingest of that candidate leaves the older pending ruling intact.

### US-003

- AC-1 [unit] Drive the real sync loop with a valid pending report and an oversized journal event. Reject requests containing the bad event, accept the isolated capability report, then accept the recovered event. Verify the report hash is marked sent once and the corrected event is acknowledged.
- AC-2 [unit] Reject the isolated capability report with a capability validation 400 and accept the same envelope without it. The invalid hash stays suppressed, unrelated events are delivered, and a changed valid hash is sent successfully. Repeat with the initial request already capability-only: use it as the isolated attempt and send one base-only control.
- AC-3 [unit] On a network failure or ambiguous rejection during isolation, the hash is neither marked sent nor permanently suppressed. A later successful request reports it. A 401 or 426 during isolation follows the existing auth or protocol stop classification. Abort an in-flight probe on loop.stop and observe no follow-up requests or committed probe response.
- AC-4 [integration] Deliver an ABANDON in the response to an isolated capabilities request processed by `SyncLoop.run`. Observe its command handled once, the eventual ack sent after cleanup, and unsent job events and queued acknowledgements retained until included in successful requests.

- AC-5 [unit] For a mixed 400 with an ambiguous cause, at minimum batch scale with pending events and acknowledgement details, return a command and archive notice only on a successful base-only control. Observe both handled once. No capability is marked sent, unsent acknowledgements retain their details, and the next ordinary batch resumes isolation at the prior scale.

### US-004

- AC-1 [integration] For a repository SESSION with an initial message, request cancellation at its RUNNING journal notification while stream initialization is pending. Observe CANCELLED and a non-null done time, with one started line followed by one cancelled close line and zero inputs consumed.
- AC-2 [integration] Repeat the RUNNING-window cancellation for PROJECT and WORKSPACE sessions using their normal startup path. Advance the fake clock past two heartbeat intervals and idle expiry after completion. All three kinds retain the same event count, final state and stream contents.
- AC-3 [unit] A normally started session emits its heartbeat on schedule and accepts initial input. After ordinary closure, clock advancement produces no further heartbeat.
- AC-4 [unit] Halt while stream setup is pending. Once startup settles, the session closes once and the test observes no subsequent timer-driven event, active log registration or terminal journal write from the halted run.
- AC-5 [unit] Make stream initialization fail during a pending cancellation. The journal records UPLOADING then FAILED with a done time, and no competing CANCELLED terminal transition. The run releases the session and log registration and leaves no recurring heartbeat or unhandled rejection.
