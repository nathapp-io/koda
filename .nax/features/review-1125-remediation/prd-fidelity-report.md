# Phase 9 fidelity review — November 25 Koda remediation

**Reviewed against** Koda commit `d893361` on 2026-11-25, using the [approved spec](spec.md) and [generated PRD](prd.json). Nax recorded the profile as `native-codex-ds`.

**Phases run** 1 of 9 (--phase 9: phases 1-8 skipped by request)

**Verdict** Ready for implementation.

## Summary

Phase 9 traced all 47 spec criteria to 109 of the PRD's 110 criteria. The remaining PRD criterion preserves the spec's transport-error behavior. All 11 story IDs, titles, package workdirs, four dependency edges and five feature exclusions survived. The largest story has 15 criteria, which meets Koda's configured limit.

The spec declares 114 story-level file entries across 37 context reads, one creation and 76 modifications. Every entry has the correct role and each modification retains its reason verbatim. The PRD adds 18 existing files as context across ten stories. One minor finding covers those extra reads. There are zero blockers or major findings.

## Criteria crosswalk

Positions are one-based within each story. A range covers consecutive PRD criteria that split one spec assertion into observable outcomes.

| Story | Spec AC | PRD AC | Assertion in the approved spec |
| --- | ---: | --- | --- |
| US-001 | 1 | 1–3 | For ticket create, job cancel and thread send, supply the real pending-summary shape with the corresponding operation key. Each mounted action shows pending feedback containing the returned request ID. |
| US-001 | 2 | 4–5 | A pending ticket submission leaves the populated dialog open and emits no created event. |
| US-001 | 3 | 6 | Pending ticket and job actions produce zero execution-success toasts. |
| US-001 | 4 | 7 | After a pending cancellation, the mounted job detail continues to render the original job. |
| US-001 | 5 | 8–9 | After a pending thread send, the draft remains editable and the transcript returns to its pre-submit messages. |
| US-001 | 6 | 10 | The thread controller makes one POST when a send returns a pending approval. |
| US-001 | 7 | 11–13 | Exercise the existing executed responses through the three forms. The ticket emits created, cancellation renders the returned job, and the executed send replaces its optimistic message. |
| US-001 | 8 | 14 | Through the web request adapter a queued-reindex 202 with data { queued: true } still delivers that object to its caller. |
| US-002 | 1 | 1–2 | For each scope, finish a turn between initial GET and subscription. Deliver ready and observe the final transcript and an available composer without disconnecting. |
| US-002 | 2 | 3 | Deliver open, ready and a duplicate ready for one connection, then reconnect and deliver open and ready. Each ready connection initiates one catch-up. |
| US-002 | 3 | 4–6 | Hold a catch-up snapshot and deliver a newer terminal message or text delta for the same message. Release the older response and assert the latest status and content survive without duplicates. |
| US-002 | 4 | 7–9 | Reject a ready-triggered read, then reconnect successfully. The controller recovers the transcript. Stop the controller during a held recovery and verify its completion cannot reopen the stream or polling. |
| US-003 | 1 | 1–2 | Open a project thread deep link returning 403 or 404. The detail area renders the same localized unavailable message for either response and shows no private thread content. |
| US-003 | 2 | 3–5 | Open a project thread returning 503, select its visible retry action and return a valid detail. The page displays the thread, clears the failure and uses one subscription. |
| US-003 | 3 | 6 | Resolve a later live reload after the initial load failed. Once a valid thread is present the stale error state does not mask it. |
| US-004 | 1 | 1–3 | Mount the project list with 101 active and 101 archived threads. For each status, load more fetches page two for that status, shows row 101 once and hides the control after the short page. |
| US-004 | 2 | 4–5 | Hold an active page-two response across a switch to archived or a same-status page-one reload. Releasing the held response leaves the new list intact. |
| US-004 | 3 | 6–8 | Double-click load more during a pending read. Only one request goes out. After an injected failure the next click retries the same page and preserves the visible rows. |
| US-005 | 1 | 1–2 | With an idle project thread and a different creator, an any-row thread.message.send grant enables the mounted composer. An own-only grant disables it. |
| US-005 | 2 | 3–5 | On the creator’s project thread, an own-only grant enables sending. Missing or still-loading grants leave the composer read-only, and a later effective grant updates it. |
| US-005 | 3 | 6–7 | With send permission present, a server sendRefusal or a running turn still disables the composer with the appropriate reason. |
| US-005 | 4 | 8 | The mounted personal workspace thread retains its existing owner-based composer behavior without requiring project permission data. |
| US-006 | 1 | 1–3 | Drive a RUN through ASSIGN using the handler and journal, hold the log drain after a successful result, and send CANCEL. The acknowledgement is ok, the timestamp is durable, and releasing the drain publishes exactly one CANCELLED terminal event. |
| US-006 | 2 | 4–7 | Replay that same command ID after completion and observe its original acknowledgement and one terminal event. A distinct CANCEL first delivered in UPLOADING is refused and creates no cancellation timestamp on a previously uncancelled RUN. |
| US-006 | 3 | 8–9 | Resume finish from a persisted RUN with an accepted cancellation. The final event remains CANCELLED. An otherwise identical uncancelled successful RUN ends COMPLETED. |
| US-006 | 4 | 10–11 | On restart before readoption, deliver a fresh CANCEL against a journal-only RUN. A RUNNING row records the request, while an UPLOADING or terminal row refuses it without changing the journal. |
| US-006 | 5 | 12 | A CONFIG operation that already produced its authoritative result retains the existing late-cancel result precedence. |
| US-007 | 1 | 1–3 | Drive THREAD_CLOSE with a held transcript finalizer, a ready startup and an immediately completing log drain. Advancing the injected clock by the close budget lets the run seal its stream, finish and stop heartbeats while the finalizer is still held. |
| US-007 | 2 | 4–5 | Consume part of the close budget in turn settlement and hold session.close for the remainder. Only the remaining budget is waited and close starts once. |
| US-007 | 3 | 6–8 | Release a held finalizer and deliver late callbacks after sealing. The stream bytes, terminal event count and journal completion stay fixed. |
| US-007 | 4 | 9–10 | With timely settlement, final transcript content precedes the single close marker. A daemon halt during settlement leaves the job recoverable without publishing a terminal event. |
| US-008 | 1 | 1–2 | With disposable PostgreSQL and no runner attached, pause a due tick after successful owner authorization, commit project soft deletion through the application, and resume it. A fresh database read finds zero jobs for that schedule and no assignment command. |
| US-008 | 2 | 3–4 | Pause an authorized insert after its live-project read inside the transaction. Start application soft deletion on a second connection. Use PostgreSQL lock-wait observation to establish that deletion waits for the insert. Release the insert, allow deletion to commit, and verify the deletion listener cancels the queued job. |
| US-008 | 3 | 5 | For a live project and authorized owner the due tick still creates one job, including when two tickers race to claim the same occurrence. |
| US-009 | 1 | 1–3 | Delete a repository containing an expired terminal job with log files at two epochs and a recorded bundle. After restarting the retention worker and running purge, the target files and cleanup record are gone and an unrelated job’s files remain. |
| US-009 | 2 | 4–6 | Abort the removal transaction after target capture. The repository, files and metadata remain intact with zero committed cleanup records. A repository with an unfinished job still refuses removal. |
| US-009 | 3 | 7–8 | Remove a repository whose terminal job is newer than the retention cutoff. Its files survive the first pass and expire once the cutoff advances beyond its finish time. |
| US-009 | 4 | 9–11 | Fail one store deletion after a previous deletion succeeds, then run purge again with the first file already absent. Pending work survives failure, finishes on retry, and a third pass makes no further change. |
| US-009 | 5 | 12 | With multiple eligible records including one persistently failing target, bounded processing still reaches the later eligible records. |
| US-010 | 1 | 1–3 | After writing a replacement bundle, fail the transaction before it records metadata. With a reachable database, the new file is removed, the request fails, and the previous bundle row and bytes remain readable. |
| US-010 | 2 | 4–6 | Model a lost commit acknowledgement using two PostgreSQL connections and the disk store. Hold the recording transaction's job-row lock after pointing the artifact at the new key, and start the request's reconciliation path while that transaction is outstanding. Observe the verifying transaction waiting for the lock with the bytes still present. Commit the record and verify that the request reports its original error and the recorded bundle remains readable. |
| US-010 | 3 | 7–10 | Fail the verification read after an uncertain commit. The attempt is retained, a diagnostic identifies its key, and the transaction error remains the request error. An error deleting a confirmed orphan likewise leaves a diagnostic without masking the original failure. |
| US-010 | 4 | 11–12 | Retry a failed upload with a new key. A successful retry has readable bytes and matching metadata, and cleanup for the failed attempt cannot remove that successful key. |
| US-011 | 1 | 1–2 | With one matching live document below 50 higher-ranked retired documents, project-wide lexical-only search returns the live document and zero retired hits. |
| US-011 | 2 | 3 | Use a controlled embedding and real LanceDB with the only live vector match below the retired candidates and no lexical match for the query. The live document is returned in vector-enabled search. |
| US-011 | 3 | 4–8 | At the search service boundary, an empty registry, a retired explicit repo ID or another project’s repo ID yields zero eligible hits. A live explicit repo restricts both legs to that repo. The REST route retains its existing not-found response for an unknown repository name. |
| US-011 | 4 | 9–13 | Exercise docs, outcomes and all with registered repositories. Preserve source and path-prefix filtering, omit outcomes for inaccessible jobs, retain lexical fallback on embedding failure, and keep empty keyed to stored source rows. |

US-001 PRD AC 15 adds a non-409 transport-error control. Its source is the spec's instruction to preserve existing error and retry behavior. The registered send action already returns the original error after removing the optimistic echo. [Thread send handler](../../../apps/web/lib/thread-controller.ts#L251)

## Corrections and call paths

| Story | Evidence reaching the implementer |
| --- | --- |
| US-001 and US-005 | The descriptions require a mounted composer, operation-specific pending feedback, and the creator fixture's send grant alongside its archive grant. The approval, success, and permission matrices remain runtime criteria. |
| US-002 | ACs 4–6 distinguish the message read triggered by onMessage from the in-memory text update triggered by onDelta. Both are reachable via the existing controller handlers. [Event handlers](../../../apps/web/lib/thread-controller.ts#L164) |
| US-006 | The description carries the cancellation decision from JobRun through Supervisor to the command handler. ACs 4–11 distinguish replay, fresh delivery, and journal-only recovery. AC 12's CONFIG outcomes and reasons match the package's authoritative-result controls. [Outcome controls](../../../apps/runner/src/supervisor/job-run-config.spec.ts#L82) |
| US-007 | ACs 1–8 test a held finalizer, the shared deadline, session close and a retained writer. Journal completion uses the existing doneAt marker. [Close path](../../../apps/runner/src/thread/thread-job-run.ts#L975) |
| US-008 | ACs 1–4 retain both transaction orderings, including a second connection observing the lock wait and subsequent cancellation. The description explicitly includes the audit and thread-handoff fixtures. |
| US-009 | ACs 1–12 retain the transactional capture, retention cutoff, partial-failure retry and progress past a failing record. The one named forward reference, the cleanup SQL migration, appears only as US-009's expected file and is spelled consistently in its interface description. The spec leaves new internal method names to the implementer. |
| US-010 | ACs 4–6 retain the outstanding recording transaction, the verification connection waiting on the same job row, the original request error and readable committed bytes. |
| US-011 | The scope and interface retain the bounded listProjectRepos result. AC 8's controller check uses an enabled knowledge index and a valid search body as in the existing unknown-repository control. ACs 9–13 retain the source, path, job visibility, fallback and empty-result contracts. [Controller](../../../apps/api/src/fleet/knowledge/project-knowledge.controller.ts#L167) · [Unknown-repository control](../../../apps/api/src/fleet/knowledge/project-knowledge.controller.spec.ts#L202) |

All five exclusions match verbatim. The PRD contains zero inverted exclusions, story-specific waivers promoted to feature scope, self-created context paths, upstream-created context paths, separate meta-criteria, or terminal-cleanup stories. The criteria and descriptions carry the review corrections independently of planner analysis.

## Minor finding — extra context reads

The following additions are existing files already authorized for modification by their owning stories. They add reading context without expanding the authorized changes. Keep the generated lists. The source of comparison is each story's Context Files section in the [spec](spec.md#context-files).

| Story | Additional PRD context paths |
| --- | --- |
| US-002 | `apps/web/lib/thread-controller.ts`, `apps/web/lib/thread-event-stream.ts` |
| US-003 | `apps/web/composables/useThread.ts`, `apps/web/pages/[project]/threads/[id].vue` |
| US-004 | `apps/web/composables/useThreads.ts`, `apps/web/pages/[project]/threads/index.vue` |
| US-005 | `apps/web/lib/thread-view.ts` |
| US-006 | `apps/runner/src/supervisor/job-run.ts`, `apps/runner/src/supervisor/supervisor.ts` |
| US-007 | `apps/runner/src/thread/thread-event-writer.ts`, `apps/runner/src/thread/thread-job-run.ts`, `apps/runner/test/unit/thread-job-run-hardening.spec.ts` |
| US-008 | `apps/api/src/fleet/jobs/fleet-jobs.service.ts` |
| US-009 | `apps/api/prisma/schema.prisma`, `apps/api/src/fleet/logs/fleet-log-retention.processor.ts` |
| US-010 | `apps/api/src/fleet/artifacts/bundle.service.ts`, `apps/api/test/integration/fleet/fleet-bundles.integration.spec.ts` |
| US-011 | `apps/api/src/fleet/knowledge/knowledge-search.service.ts` |
