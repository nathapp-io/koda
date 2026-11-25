# Koda whole-repository code review

Reviewed local `main` at `7e23427915d4e98df0eb9a4fc9750ad4a05c0f43` on November 25, 2026. Scope included the API and database schema, fleet protocol and runner, web, CLI, Compose, deployment scripts, and CI/release workflows. Finding numbers are stable across revisions.

**Revised verdict: 2 P1, 15 P2, 1 P3.** Prioritize duplicate execution of a runner lease (#1) and silent truncation of piped CLI output (#2). Both reproduced through the affected entry points. The Compose issue moves to P2 (#3). The previous claim about a routine indexing failure is withdrawn and replaced with a P3 CLI output defect (#17). Finding #4 is a source-supported race with a narrower verification boundary than the other runtime findings.

P1 denotes a high-impact correctness failure such as duplicate execution or silent data loss. P2 denotes a material workflow, data-lifecycle or deployment issue with a specific trigger. P3 denotes a user-visible reporting defect with a successful underlying operation.

### 1. P1 · Two runner daemons execute the same lease

Two separately started daemon processes shared one temporary runner home and SQLite journal. Both received the same synthetic assignment for lease epoch 1. Holding the first process in preparation allowed each daemon to launch a distinct inert child for that lease. The API deliberately redelivers a pending assignment across daemon boots. Duplicate execution was observed. Production checkout damage and double billing are possible consequences, unmeasured here.

**Correction.** Acquire exclusive process-lifetime ownership of the runner home before opening the journal. Keep same-lease replay idempotent during preparation as well as after a PID is recorded.

[Verification fixture](review-evidence/20261125/runner-duplicate-daemon.ts) · [Daemon startup](../apps/runner/src/daemon/daemon.ts#L145) · [Assignment replay](../apps/runner/src/supervisor/command-handler.ts#L225) · [API lease check](../apps/api/src/fleet/sync/fence.service.ts#L18) · [API assignment redelivery](../apps/api/src/fleet/sync/command-ack.processor.ts#L138)

### 2. P1 · Piped CLI output can be incomplete with exit code 0

The real CLI wrote a synthetic 100-row `kb list --json` response to a regular file and to a slow pipe. The file contained all 100 rows in 1,239,393 bytes. The pipe received the first 65,536 bytes, ending inside a JSON string. Both processes exited 0. The byte threshold depends on the host. Other commands share the immediate-exit pattern, but the measured result is for KB list.

**Correction.** Let successful commands return naturally, or await completion of the output write before exiting. Keep a child-process test with a slow pipe consumer.

[Verification fixture](review-evidence/20261125/cli.py) · [KB JSON output and exit](../apps/cli/src/commands/kb.ts#L95) · [Fleet log output and exit](../apps/cli/src/commands/fleet-job-logs.ts#L166)

### 3. P2 · Dev and test PostgreSQL publish ports without a loopback restriction

Docker Compose rendered development host port 5432 and test host port 5433, both targeting container port 5432 with no host IP specified. A clean environment selected the checked-in login defaults. A development credential override took effect, and the root Compose file published no PostgreSQL port. This verifies the deployment defaults. Remote reachability depends on the host, engine and firewall and was not measured.

**Correction.** Bind both local database port mappings to loopback by default. Make a broader bind an explicit choice.

[Verification fixture](review-evidence/20261125/deployment.rb) · [Development Compose](../docker-compose.dev.yml#L39) · [Test Compose](../docker-compose.test.yml#L9)

### 4. P2 · Scheduled dispatch can pass its liveness check before project deletion commits

The ticker discovers live projects and authorizes the schedule owner before calling dispatch. Project deletion soft-deletes the project and cancels jobs already present. Dispatch subsequently checks the repository’s project ID and inserts the job without rechecking project liveness in the insertion transaction. The remaining foreign keys are valid after soft deletion. On the same PostgreSQL fixture, the scheduler’s due lookup returned the schedule before soft deletion and excluded it afterward. Dispatch’s repository lookup still returned the matching project ID after deletion. Other integration controls observed zero claims for a pre-deleted project and cancellation of a job queued before deletion. The race between authorization and insertion follows from the transaction boundaries. No post-deletion job execution was observed. Immediate placement is the relevant execution path when a runner is available. Later background queue scans exclude deleted projects.

**Correction.** Serialize job creation with project deletion and check liveness inside that boundary. Cover a tick paused after owner authorization, with no runner attached, and assert that deletion leaves zero new job rows.

[Verification fixture](review-evidence/20261125/database-controls.py) · [Scheduled dispatch](../apps/api/src/fleet/schedules/schedule-ticker.ts#L147) · [Job insertion](../apps/api/src/fleet/jobs/fleet-jobs.service.ts#L126) · [Deletion listener](../apps/api/src/fleet/jobs/project-deletion-jobs.listener.ts#L39) · [Placement](../apps/api/src/fleet/jobs/placement.service.ts#L144) · [Soft deletion](../apps/api/src/projects/projects.service.ts#L251) · [Queued scan](../apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts#L315) · [Pre-deleted schedule control](../apps/api/test/integration/fleet/fleet-schedule-ticker.integration.spec.ts#L234) · [Deletion cancellation control](../apps/api/test/integration/fleet/project-deletion-quiesce.integration.spec.ts#L73)

### 5. P2 · Removing a fleet repository can leave its terminal-job files outside retention

On disposable PostgreSQL 16, a completed job older than the retention cutoff had one log, one bundle and two corresponding files on disk. The real repository DELETE returned 204. Counts of job, log and artifact rows went from 1/1/1 to 0/0/0. The real retention pass then reported zero expired jobs and zero failures. Both files still existed. An existing control removed the files for a comparable old job whose repo remained registered. PostgreSQL confirmed all three relevant foreign keys cascade on deletion.

**Correction.** Save a durable cleanup record containing the log location and bundle keys in the deletion transaction. Process it after commit with retries.

[Verification fixture](review-evidence/20261125/database-controls.py) · [Repository removal](../apps/api/src/fleet/repos/fleet-repos.service.ts#L669) · [Job cascade](../apps/api/prisma/migrations/20260930090000_fleet_jobs/migration.sql#L127) · [Artifact cascade](../apps/api/prisma/migrations/20260930090000_fleet_jobs/migration.sql#L148) · [Retention lookup](../apps/api/src/fleet/logs/prisma-log-retention.repository.ts#L16) · [Log cascade](../apps/api/prisma/migrations/20261004120000_fleet_job_logs/migration.sql#L20) · [Retention control](../apps/api/test/integration/fleet/fleet-log-retention.integration.spec.ts#L92)

### 6. P2 · A bundle metadata read error leaves an unreferenced file

The production bundle service and local-disk store wrote a real compressed fixture. A missing job row during the second check produced zero artifact rows and zero files. Throwing a database-read error at the same point produced zero artifact rows and one durable file. The transaction collaborator was simulated. This establishes one failure before metadata insertion. It does not establish the outcome of every rollback or ambiguous commit. A later upload uses a fresh key.

**Correction.** Handle exceptions after storage writes. For an uncertain commit outcome, reconcile the attempt key against the durable artifact record before deleting it.

[Verification fixture](review-evidence/20261125/bundle-cleanup.ts) · [Storage write](../apps/api/src/fleet/artifacts/bundle.service.ts#L61) · [Transaction and cleanup](../apps/api/src/fleet/artifacts/bundle.service.ts#L82) · [Runner retry](../apps/runner/src/bundle/upload-bundle.ts#L70)

### 7. P2 · Retired repositories can displace live knowledge-search hits

A real temporary LanceDB index returned the only live match when queried alone. After adding 50 higher-ranked chunks for an unregistered repository, that live match ranked 51st in both retrieval paths. Project-wide search returned zero results, while search scoped to the live repo still returned one. The registry and query embedding were controlled fixtures. This verifies the search consequence when retired chunks exist.

**Correction.** Filter to registered repos before applying each retrieval limit, or guarantee removal of retired chunks. Cover both lexical and vector candidates.

[Verification fixture](review-evidence/20261125/search-ranking.ts) · [Candidate selection](../apps/api/src/fleet/knowledge/knowledge-search.service.ts#L265) · [REST caller](../apps/api/src/fleet/knowledge/project-knowledge.controller.ts#L195) · [Assistant caller](../apps/api/src/fleet/assistant/tools/kb-tools.ts#L253)

### 8. P2 · An acknowledged cancellation during log draining can finish as completed

With the worker result available and log draining held, the runner still reported RUNNING. Its cancel handler acknowledged success and persisted a cancellation timestamp. After the drain resumed, the journal advanced through UPLOADING to COMPLETED. This measures runner acceptance and final state with a controlled executor.

**Correction.** Place the verdict decision and the last cancellable transition behind the same atomic state decision. A cancellation acknowledged during a drain should agree with the published terminal state.

[Verification fixture](review-evidence/20261125/runner-lifecycle.ts) · [API cancellation contract](../apps/api/src/fleet/jobs/fleet-jobs.service.ts#L218) · [Runner acceptance](../apps/runner/src/supervisor/job-run.ts#L184) · [Verdict](../apps/runner/src/supervisor/job-run.ts#L576) · [Log drain and transition](../apps/runner/src/supervisor/job-run.ts#L647)

### 9. P2 · Thread finalization can outlive the session-close deadline

The real agent-session facade returned from its synthetic backend, then paused in transcript finalization. The runner delivered cancellation and continued recording heartbeats. The fixture advanced the runner clock by four configured close budgets before releasing finalization. Session close had still not started. After release the job finished. The source awaits turn settlement before starting the bounded close. The observation proves the delay can exceed that budget. A permanent hang depends on settlement never returning.

**Correction.** Apply a bounded shutdown deadline to turn settlement as well as session close, and prevent late turn writes after sealing the stream.

[Verification fixture](review-evidence/20261125/runner-lifecycle.ts) · [Thread shutdown](../apps/runner/src/thread/thread-job-run.ts#L993) · [Runner liveness sweep](../apps/api/src/fleet/sync/fleet-sweeper.ts#L56)

### 10. P2 · Web actions treat pending approval as an executed write

The real API approval filter produced a pending 202 response. Mounted web components showed ticket-created success and closed the form, showed fleet-cancel success before a render TypeError, and failed thread send with a TypeError. Executed 200/201 responses worked in the same harness. A legitimate 202 queued-reindex body also passed through. The failure depends on the response shape.

**Correction.** Represent pending approval explicitly, display the approval request ID, and preserve the form or displayed resource until execution. Preserve queued-success handling.

[Verification fixture and results](review-evidence/20261125/web.md) · [Approval response](../apps/api/src/approvals/route/approval-gated.decorator.ts#L29) · [Web response handling](../apps/web/composables/useApi.ts#L266) · [Create ticket](../apps/web/components/CreateTicketDialog.vue#L134) · [Fleet job actions](../apps/web/pages/%5Bproject%5D/fleet/jobs/%5Bid%5D/index.vue#L244) · [Successful queue response](../apps/api/src/fleet/knowledge/project-knowledge.controller.ts#L137)

### 11. P2 · Initial thread subscription can miss turn completion

On both project and workspace pages, completion published after the first GET and before subscription produced zero catch-up GETs at the first ready frame. The mounted composer stayed disabled. A simulated reconnect triggered two GETs and enabled the composer. The harness used the real API event bus and stream with a controlled browser event source.

**Correction.** Reconcile on the first ready frame as well as reconnection. Merge by sequence so a late snapshot cannot overwrite newer events.

[Verification fixture and results](review-evidence/20261125/web.md) · [Project startup](../apps/web/composables/useThread.ts#L41) · [Workspace startup](../apps/web/composables/useWorkspaceThread.ts#L72) · [First ready frame](../apps/web/lib/thread-event-stream.ts#L130) · [API stream](../apps/api/src/live/live-stream.ts#L41)

### 12. P2 · A project-thread deep link can render empty content on load failure

Initial 403, 404 and 503 responses each left the mounted project thread detail with zero visible characters and no retry control. The equivalent workspace 503 showed a retry control and recovered after the simulated API became available. The observation concerns the detail area, within the surrounding layout.

**Correction.** Render an explicit missing or inaccessible state and provide retry for transient failures. Reuse the workspace page’s recovery behavior.

[Verification fixture and results](review-evidence/20261125/web.md) · [Project load](../apps/web/composables/useThread.ts#L48) · [Project page](../apps/web/pages/%5Bproject%5D/threads/%5Bid%5D.vue#L116) · [Workspace handling](../apps/web/pages/threads/%5Bid%5D.vue#L130)

### 13. P2 · Project thread lists expose only the first 100 threads per status

With 101 active and 101 archived threads, each mounted project view requested page one and displayed 100 rows. The only controls switched status. The workspace load-more control requested page two from the same paginated fixture and displayed row 101. Older project threads can still be opened by a known direct link.

**Correction.** Expose the next page on the project list for both statuses and retain the selected status when loading it.

[Verification fixture and results](review-evidence/20261125/web.md) · [Project list client](../apps/web/composables/useThreads.ts#L41) · [Project list view](../apps/web/pages/%5Bproject%5D/threads/index.vue#L82) · [API pagination](../apps/api/src/fleet/threads/threads.controller.ts#L76)

### 14. P2 · The thread composer disagrees with the API’s effective send permission

The API permission resolver granted project-wide `thread.message.send` on another creator’s thread, while the mounted composer remained read-only. The reverse mismatch also reproduced: a creator without a send grant saw an enabled composer even though the API denied permission. Own-only grants matched expectations for both owners and nonowners. The API still enforces session and authorization rules.

**Correction.** Use the effective send decision in the composer and retain the API’s active-session checks.

[Verification fixture and results](review-evidence/20261125/web.md) · [Composer rule](../apps/web/lib/thread-view.ts#L94) · [API send contract](../apps/api/src/fleet/threads/threads.controller.ts#L297)

### 15. P2 · Running koda init from home replaces saved credentials and profiles

The real command ran against a disposable home with a saved endpoint, synthetic key and named profile. Init from a separate project preserved all three. With the fixture home as the working directory, init succeeded and the global config contained only `projectSlug`. The command’s project and global paths resolve to the same file in this case.

**Correction.** Detect the resolved global configuration path before writing. Include an explicitly supplied home directory via `--cwd` in the regression check.

[Verification fixture](review-evidence/20261125/cli.py) · [Init destination and write](../apps/cli/src/commands/init.ts#L77) · [Global store](../apps/cli/src/config.ts#L21)

### 16. P2 · Human-readable koda kb list fails on valid API responses

The API’s real controller and service supplied valid empty and single-row array envelopes. The real CLI’s human formatter exited 1 on both because it iterates `data.items`. JSON mode exited 0 and produced the correct 0 or 1 rows from those same envelopes. HTTP transport and database collaborators were in memory.

**Correction.** Type the response as an array and use it in both formatters. Cover the empty and nonempty response through the CLI entry point.

[Verification fixture](review-evidence/20261125/cli.py) · [API controller](../apps/api/src/rag/rag.controller.ts#L104) · [Return type](../apps/api/src/rag/rag.service.ts#L85) · [CLI rendering](../apps/cli/src/commands/kb.ts#L92)

### 17. P3 · A successful koda kb add prints an undefined document count

An injected embedding-provider error exercised the production vector store’s zero-vector fallback. The fixture stored the document and the API returned `indexed: true`. The real CLI exited 0 and printed “Total documents: undefined”. The API result contains no `docCount`. An artificially absent optional collaborator produced `indexed: false` and the same output, but the application module normally registers that collaborator. The earlier claim that an ordinary provider outage caused an unindexed success is withdrawn.

**Correction.** Print the returned indexing outcome. Omit the total unless the API provides one, and handle `indexed: false` explicitly if that response remains supported.

[Verification fixture](review-evidence/20261125/cli.py) · [API result](../apps/api/src/rag/kb-document-addition.service.ts#L32) · [CLI result handling](../apps/cli/src/commands/kb.ts#L140) · [Provider fallback](../apps/api/src/rag/vector-store.service.ts#L218) · [Registered providers](../apps/api/src/rag/rag.module.ts#L99) · [API contract fixture](review-evidence/20261125/cli-kb-contract.ts)

### 18. P2 · Dev- or test-Compose-only changes skip this CI workflow’s validation jobs

Separate temporary Git histories each changed one Compose filename. Executing the workflow’s actual pull-request changes step yielded `code=false` for the dev and test files and `code=true` for the root file. All eight downstream jobs depend on that output. The main-branch push path filter likewise matched only the root file. The PR classifier ran locally. The push conclusion follows from the declared paths. No hosted run was triggered.

**Correction.** Include all supported Compose filenames in both filters and exercise them individually with the change classifier.

[Verification fixture](review-evidence/20261125/deployment.rb) · [Push paths](../.github/workflows/ci.yml#L7) · [PR change filter](../.github/workflows/ci.yml#L64)

## Reproducing the evidence

Run from the repository root with the workspace dependencies installed. The fixtures assert the observed behavior at the reviewed commit and exit nonzero if it changes. The CLI run used Node 24. The Python harness accepts an explicit Node executable through `KODA_REVIEW_NODE`. The deployment checks use Ruby, Git and Docker Compose. The database check needs a local Docker engine and a cached `postgres:16` image. It creates an isolated, loopback-bound database and stops its container on exit.

```sh
e=docs/review-evidence/20261125
bun "$e/runner-duplicate-daemon.ts"
bun "$e/runner-lifecycle.ts"
python3 "$e/cli.py"
ruby "$e/deployment.rb"
bun --tsconfig-override "$e/web.tsconfig.json" "$e/web.ts"
NODE_ENV=test TS_NODE_PROJECT=apps/api/tsconfig.json node -r ts-node/register/transpile-only "$e/bundle-cleanup.ts"
NODE_ENV=test TS_NODE_PROJECT=apps/api/tsconfig.json node -r ts-node/register/transpile-only "$e/search-ranking.ts"
python3 "$e/database-controls.py"
```

## Suite coverage and boundaries

| Run | Result |
| --- | --- |
| Original repository-wide baseline | All 5 type-check and 4 lint tasks passed with caches bypassed. 22,731 unique unit and Jest cases passed across API (12,830), CLI (955), web (6,064) and runner (2,882). Runner host-dependent cases required a separate run with local process and socket access. |
| Targeted unit suites in this revision | 212 API cases across 10 suites and 13 runner bundle-retry cases passed. These overlap the repository-wide baseline. |
| PostgreSQL 16 controls in this revision | 83 tests across six checked-in integration suites passed for project deletion, schedule ticking, repo removal, retention, bundles and knowledge storage. Two additional focused tests passed for the scheduler/dispatch lookups after soft deletion and the on-disk result of deleting a repo before retention. The installed schema’s three cascade actions matched the migration definitions. |
| Focused verification in this revision | The commands above cover runner processes and lifecycle timing, CLI child-process output, mounted Vue workflows, native LanceDB ranking, bundle storage, the Compose renderer, the CI classifier and database controls. |

External access to a deployed database, incurred runner charges, and real browser or hosted CI sessions were outside the measurements. Each affected finding names its controlled dependencies or remaining inference.
