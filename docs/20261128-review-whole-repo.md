# Koda whole-repository code review

Revised November 28, 2026, against local `main` at `d4538dd4e`. The original finding numbers are retained so earlier discussion still points to the correct item.

**14 confirmed defects — 9 P2 and 5 P3. No P1 remains.** Four original items leave the defect count. The behavior in #1 and #10 implements explicit requirements. The project accepts the concurrency limit in #2 and the first-page behavior in #11. The severity of #3, #12 and #16 drops after checking their controls and workarounds. Finding #7 is an existing parser defect that the batching work explicitly deferred.

The first fixes I would prioritize are #6 and #7, which make normal TypeScript code disappear from relationship or symbol queries, and #8, where a polling pass can record a merge and lose the ticket transition. All three reproduced on PostgreSQL 16. Finding #14 also warrants an early fix because a patch-only change can miss both test selection and cache invalidation.

### 1. Withdrawn · Verification uses the configured route policy

The ticket approval specification explicitly assigns verification to the route policy and checks edge permissions when the command executes. The later self-review change retains that route key and adds a minimum approval level. The later change that binds an approved request to a particular edge applies to status PATCH. My original P1 described the documented verification semantics as a defect. The pending request stores the route input, so state changes before execution still matter. Freezing an intended edge for verification would be a policy change. Verified from source and specification. [Route policy](../.nax/features/permissions-p3-approval-gate-tickets/spec.md#L49) · [Self-review requirement](../.nax/features/review-p1-rest/spec.md#L577) · [Later PATCH requirement](../.nax/features/review-1118-api-fixes/spec.md#L147) · [Verify handler](../apps/api/src/tickets/tickets.controller.ts#L335)

### 2. Documented limitation · Concurrent identical calls may open separate approval requests

The specification explicitly allows simultaneous calls to open independent requests. Each needs its own decision. A sequential retry test passed. A private PostgreSQL 16 instance with the four relevant migrations showed five request indexes, with uniqueness on the request primary key alone. That supports the documented concurrency boundary. The prior report overstated the evidence for duplicate execution: no pair of requests was approved and no duplicate ticket was observed. Remove the P1 designation. [Concurrency exception](../.nax/features/permissions-p3-approval-core/spec.md#L536) · [Lookup and insertion](../apps/api/src/approvals/approval-gate.service.ts#L209) · [Database check](review-evidence/20261128/api-request-index.py)

### 3. P3, lowered from P2 · Retention can discard a verdict before a delayed server recovers

With seven-day retention, SQLite retained an unacknowledged completion on day six and deleted it on day eight. The API control changed the impact assessment. With the default 300-second silence threshold and a functioning sweeper, the job had already become `CRASHED` and the old lease was fenced in both cases. When the sweep had not run, retaining the report produced `COMPLETED`; pruning it led to rejected readoption and `CRASHED`. Preserve unacknowledged terminal events until delivery or explicit reconciliation. The server-side comparison used real services with simulated persistence. [Prune](../apps/runner/src/journal/journal.ts#L287) · [Silence threshold](../apps/api/src/config/fleet.config.ts#L150) · [SQLite fixture](review-evidence/20261128/runner-lifecycle.ts) · [API control](review-evidence/20261128/runner-api.cjs)

### 4. P2 · A rejected startup close blocks further commands for the live lease

During the interval between the runner reporting `RUNNING` and opening its writer, the real command handler returned `rejected/session_not_ready`. The API acknowledgement processor recorded the rejection. The job remained `RUNNING`, but the send check returned `closing` and a close retry raised HTTP status 409. A fresh lease accepted sends. This is recoverable when the session ends. The fixture controlled the timing and substituted storage; the frequency in production is unknown. Make rejected closes retryable, or accept close during startup. [Runner readiness](../apps/runner/src/thread/thread-job-run.ts#L1193) · [API close lookup](../apps/api/src/fleet/threads/prisma-chat-thread.repository.ts#L387) · [Runner fixture](review-evidence/20261128/runner-lifecycle.ts) · [Acknowledgement and retry](review-evidence/20261128/runner-api.cjs)

### 5. P2 · A transient cleanup error erases the runner’s process ownership record

A failed lookup and a denied signal each left zero ledger rows and produced zero attempts on a second, healthy pass. The matching-process control signalled once, and the control with a later start time correctly skipped the process. A surviving backend consequently loses this cleanup path. Preserve the row when identity or signal delivery is indeterminate and revalidate identity at retry. The fixture used SQLite and injected process operations. It did not leave or signal a real backend. [Reaper](../apps/runner/src/daemon/owned-processes.ts#L167) · [Retry controls](review-evidence/20261128/runner-lifecycle.ts)

### 6. P2 · Code intelligence indexes both functions and loses the call between them

The HTTP index endpoint accepted a file where `main()` directly calls `helper()`. PostgreSQL contained both symbols with empty relationship arrays. The public callers and callees endpoints each returned an empty list. After inserting just the expected relationship into the same rows, both endpoints returned the correct counterpart. This isolates the failure to extraction: the installed compiler interprets the hard-coded syntax kind 300 as `CatchClause`. Use named call-expression nodes and assert the identities returned by both public reads. [Extractor](../apps/api/src/code-intel/code-graph.service.ts#L286) · [Relationship contract](specs/SPEC-004-memory-phase4-graph-code-intelligence.md#L127) · [HTTP and PostgreSQL control](review-evidence/20261128/indexing.py)

### 7. P2, previously documented · A valid top-level arrow function clears the file’s indexed symbols

A first HTTP index request stored two symbols for the target file. Adding one top-level arrow produced HTTP 201 with a per-file `getJsDocs` error. The database then held zero symbols for that file, while a sibling file indexed successfully. Replacing the arrow with a named function restored all three symbols. The batch-indexing spec explicitly deferred this parser defect. Extract the callable from the initializer and its documentation from the owning declaration, then assert the reindex outcome. [Variable extraction](../apps/api/src/code-intel/code-graph.service.ts#L150) · [Replacement logic](../apps/api/src/code-intel/ast-index.service.ts#L69) · [Prior deferral](../.nax/features/indexer-batch-project/spec.md#L128) · [HTTP and PostgreSQL control](review-evidence/20261128/indexing.py)

### 8. P2 · A stale polling snapshot consumes the merge without advancing the ticket

Two PostgreSQL controls differed only in when the ticket started relative to candidate selection. Starting before selection produced `VERIFY_FIX` and one `FIX_REPORT`. Starting through HTTP after selection but before applying the same synthetic merged-PR response left the ticket `IN_PROGRESS` with zero reports. Both links persisted as `merged` and disappeared from the next candidate query. Use the conditional database update to check the live ticket at merge application. The provider result was synthetic, while the candidate query, start route, merge application and subsequent reads were real. [Sync requirement](specs/SPEC-vcs-phase3-pr-status-sync.md#L199) · [Snapshot check](../apps/api/src/vcs/vcs-pr-sync.service.ts#L244) · [Conditional write](../apps/api/src/vcs/prisma-vcs.repository.ts#L413) · [PostgreSQL ordering control](review-evidence/20261128/indexing.py)

### 9. P2 · Successful status mutations return a different ticket representation from reads

On two labelled tickets, an ordinary edit and GET returned a project-prefixed `ref`. A status-only PATCH on one and POST `start` on the other both succeeded and persisted `IN_PROGRESS`, but both wire responses omitted `ref` and nested each label under `label`. A subsequent GET returned `ref` and flat labels again. The published DTO requires `ref`. This is a response-contract failure; the underlying transition succeeded. Apply the common response mapper to the final ticket, or publish a distinct mutation contract if that shape is intentional. [Status PATCH](../apps/api/src/tickets/tickets.service.ts#L317) · [Start command](../apps/api/src/tickets/ticket-route.commands.ts#L115) · [DTO mapping](../apps/api/src/tickets/dto/ticket-response.dto.ts) · [HTTP comparison](review-evidence/20261128/indexing.py)

### 10. Withdrawn · JSON evaluation deliberately exits zero for a below-threshold result

The real CLI and generated SDK decoded scores of 0.50, 0.70 and 0.75 correctly. Text mode exited 1, 0 and 0. JSON mode exited 0 for all three. The CLI output acceptance criteria explicitly require a zero exit for a below-threshold JSON evaluation. The original P2 mistook an intentional output-mode contract for a failing CI gate. [Acceptance criteria](specs/SPEC-cli-output-completion.md#L140) · [CLI implementation](../apps/cli/src/commands/evaluate.ts#L51) · [CLI fixture](review-evidence/20261128/client-review.cjs)

### 11. Documented limitation · `ticket mine` displays the first page only

For 0, 20 and 21 assignments the real command printed 0, 20 and 20 rows with one request. `ticket list --assigned-to self --page 2` returned ticket 21. The pagination plan explicitly directs `mine` to consume the page records without a continuation hint. This is a discoverability limitation with a working alternative. Adding pagination to `mine` would be a product improvement. [Pagination plan](superpowers/plans/2026-09-26-track-1-slice-3-pagination.md#L1594) · [CLI command](../apps/cli/src/commands/ticket.ts#L228) · [CLI fixture](review-evidence/20261128/client-review.cjs)

### 12. P3, lowered from P2 · The assignee filter’s help advertises the wrong identifier

`ticket list --assigned-to` advertises `<slug>`. Passing a known agent slug or its ID yielded zero matches even with an assigned ticket. A user ID returned the user-owned ticket, and `self` resolved the agent’s own assignments. The API’s ordinary argument filters `assignedToUserId`. The verified defect is misleading CLI help. Describe the accepted user ID and `self`; support for arbitrary agent selection would be additional functionality. [CLI help](../apps/cli/src/commands/ticket.ts#L179) · [Filter mapping](../apps/api/src/tickets/tickets.service.ts#L170) · [CLI and API control](review-evidence/20261128/client-review.cjs)

### 13. P2 · The timeline end date excludes events later that day

Five fixture events crossed the boundary of a Kuala Lumpur calendar day. Selecting the same start and end date through the web composable returned only the event at UTC midnight. Explicit local-day bounds returned all four events belonging to the selected day and excluded the next midnight. The production controller and service processed the requests with fixture storage. Convert date-picker values to local calendar boundaries and use an exclusive next-day boundary consistently. [Web query](../apps/web/composables/useTimelineEvents.ts#L58) · [API bounds](../apps/api/src/memory/timeline.service.ts#L72) · [Date control](review-evidence/20261128/client-timeline.cjs)

### 14. P2 · A dependency-patch-only change misses both CI selection and the runner test cache key

In a temporary Git repository, each committed Bun patch path produced `code=false` from the actual PR filter, matched no main push pattern, and left Turbo’s runner-test dry-run hash unchanged after its content changed. A runner source change produced `code=true`, matched the push filter, and changed the hash. A README change produced three negatives. Include the patches in both workflow filters and in Turbo inputs for the runner tasks affected. These checks used the repository configuration locally. [Workflow filter](../.github/workflows/ci.yml#L69) · [Patched dependencies](../package.json#L45) · [Cache inputs](../turbo.json) · [Workflow and hash fixture](review-evidence/20261128/operations.py)

### 15. P2 · Re-dispatching an old canary selects inconsistent Docker and npm release actions

With canary versions 1 and 2 present and already published, the workflow’s real channel and merge scripts instructed Docker to write both floating `:canary` tags on a retry of version 1. The npm existence check selected the published-version skip. A retry of version 2 selected the same floating names, while an older stable release selected only its versioned Docker tags. If npm’s canary already points to version 2, a successful version-1 retry can therefore leave Docker and npm on different versions. Evaluate canary eligibility consistently on retries. Registry commands were intercepted; no registry state was changed or inspected. [Channel selection](../.github/workflows/release.yml#L197) · [npm skip](../.github/workflows/release.yml#L350) · [Docker merge](../.github/workflows/release.yml#L536) · [Workflow fixture](review-evidence/20261128/operations.py)

### 16. P3, lowered from P2 · Example deployment rejects an exported assignment inside `.env`

Docker Compose rendered the expected database password with both `POSTGRES_PASSWORD=…` and `export POSTGRES_PASSWORD=…` in the fixture file. The deployment script accepted the bare form and rejected the exported form before calling Docker. Providing a shell override also passed preflight. This is limited to the example wrapper’s parser, with a one-line workaround. Validate the effective Compose setting while keeping credentials out of output. Only configuration rendering ran against real Compose. [Preflight parser](../deployments/example/deploy.sh#L54) · [Example setup](../deployments/example/README.md#L23) · [Compose controls](review-evidence/20261128/operations.py)

### 17. P3 · Embedded ticket labels omit their project ID

Creating the label returned its `projectId`. After attaching that label, GET ticket returned its ID, name and color but omitted the declared label `projectId`. Supplying the complete label row directly to the DTO preserved it, isolating the omission to the ticket repository mapping. The parent ticket still carries its own project ID. Preserve the field when projecting label rows. [Repository projection](../apps/api/src/tickets/prisma-tickets.repository.ts#L115) · [Response DTO](../apps/api/src/tickets/dto/ticket-response.dto.ts) · [HTTP control](review-evidence/20261128/indexing.py) · [Mapper control](review-evidence/20261128/api-tickets.mjs)

### 18. P3 · `label delete --json` emits a sentence

The CLI sent the expected DELETE request. With the documented empty HTTP 204 response, both text and JSON modes exited 0 and printed the same prose confirmation. The advertised JSON option therefore produces output a JSON parser cannot consume. Emit a JSON confirmation when the flag is supplied. [Flag and output](../apps/cli/src/commands/label.ts#L85) · [CLI fixture](review-evidence/20261128/client-review.cjs)

## Verification scope

This revision checked all 18 original items across the API, runner, clients and delivery workflows. Each entry records its control and evidence boundary. For the database-backed checks, the suite built a fresh schema on a temporary local PostgreSQL 16 container. It ran 18 tests, including the new cases for indexing, ticket and label HTTP responses, and PR merge ordering. The approval index inspection separately applied four relevant migrations to a network-isolated PostgreSQL 16 container. No actual external VCS, registry publish or live deployment participated.

The original baseline on the same commit passed all three production builds, all five type-check tasks and four lint tasks. The unit suites reported 12,968 API, 980 CLI, 6,172 web and 2,877 runner tests passed, plus 85 runner skips. This revision reran targeted checks. The complete database integration and browser suites were outside both runs.

### Repeating the targeted checks

From the repository root, with the workspace dependencies installed and the API and CLI built for the fixtures that load compiled code:

```sh
python3 docs/review-evidence/20261128/indexing.py
python3 docs/review-evidence/20261128/api-request-index.py
node docs/review-evidence/20261128/api-tickets.mjs
bun docs/review-evidence/20261128/runner-lifecycle.ts
node docs/review-evidence/20261128/runner-api.cjs
node docs/review-evidence/20261128/client-review.cjs
node docs/review-evidence/20261128/client-timeline.cjs
python3 docs/review-evidence/20261128/operations.py
```

The first two checks require a local Docker engine with `postgres:16` already available and remove their temporary containers. The operations check uses Git, Turbo, Bash, Ruby, jq and Docker Compose to evaluate local fixtures. It intercepts release and deployment actions.
