# SPEC: Fleet review outcomes into memory (S6 K2, part B)

## Summary

After a fleet `REVIEW` job completes, koda reads nax's `bot-review.json` from the job bundle and turns each
`finding-withdrawn` event (a finding the bot withdrew after humans replied in its thread) into an active
project `DECISION`, so the next review receives it through the decisions seam (part A, feature
`fleet-review-decisions`). Only a disagreement from a GitHub login with write access or higher on the repo
counts, and an untrusted (fork or outsider) PR never creates a decision. The decision is written by the
system (`SYSTEM/review`) with the GitHub login recorded as the approver (`FORGE_USER`, `github:<login>`).
A human can retire a decision through a new gated route (`POST /memory/:id/retire`, key
`memory.decision.retire`) on REST, CLI and MCP, and a retired review decision is not created again.

## Motivation

`nax bot review` remembers its threads on one PR only. When a maintainer pushes back on a finding and the
bot withdraws it, nax records a `finding-withdrawn` event in `bot-review.json`, but koda discards the file:
the ingest reader keeps only allowlisted slots (`apps/api/src/fleet/ingest/bundle-reader.ts:28-38`), and the
ingest stores outcomes for `RUN` jobs only (`bundle-ingest.service.ts:100-101`). The next PR then gets the same
finding again. There is also no way to take a decision back: memory has no retire or supersede route
(`memory.controller.ts` serves `extract`, `decisions` and create only).

The design is `docs/superpowers/specs/2026-10-31-fleet-s6-k2-review-memory-design.md` (D1, D2, D5, D6),
approved 2026-10-31, with the user ruling that untrusted PRs never create decisions and that this is one
feature. Standing rules: memory is project-scoped (ADR-001); every write records the actor, the approval mode
and the approver as separate fields; the reviewer never writes memory itself.

## Design

### Calls made in this spec

1. **Two phases: store, then mint.** The GitHub permission check is a network call, so it never runs inside
   the ingest transaction. The ingest stores each withdrawal as a `FleetReviewEvent` row in the same
   transaction as the rest of the bundle; after commit it emits `REVIEW_EVENTS_INGESTED`. A system writer,
   `ReviewEventMinter`, then checks permissions and mints decisions for `pending` rows. The row is also the
   record of every skipped event and its reason.
2. **Which artifact.** The reader gains two slots: `nax-out/bot/pr-<n>/<runId>/bot-review.json` (`botReview`,
   may match more than one) and top-level `nax.stdout` (`naxStdout`). **Neither slot ever adds to the bundle's
   `oversized` list**: an oversized file in either slot is skipped silently, so a large `nax.stdout` on a `RUN`
   bundle never makes that ingest partial. The parser picks the `bot-review.json` whose path the stdout line
   `nax bot review: artifact <path>` names, matched on the path's trailing `bot/pr-<n>/<runId>/bot-review.json`.
   With no such line and exactly one `bot-review.json`, it uses that one; otherwise the artifact is `invalid`
   (reason `artifact-ambiguous`).
3. **Artifact checks.** The PR number comes from `prNumberOfReviewFeature(job.feature)`. The artifact must parse
   as JSON with `version` 1, 2 or 3, `pr.number` equal to that PR number, and a boolean `trusted`; otherwise it
   is `invalid` (reason `artifact-invalid`) and no rows are written. A missing `events` field means no events.
   Events whose `type` is not `finding-withdrawn` are ignored. A `finding-withdrawn` event needs a `key` matching
   nax's finding-key format `^f-[0-9a-f]{8,64}$` (nax `findingKey`: `f-` plus a sha256 hex prefix), `threadId`
   (1..200 chars), `finding`, `reason`, and a `disagreedBy` array of strings; an event
   missing one is dropped. `file` (string) and `line` (positive integer) are optional; a wrongly typed optional
   field is treated as absent. In `finding` and `reason`, every control character (Unicode category Cc, which
   includes newlines and tabs) becomes a space, then each is clipped to 1000 characters, so the text cannot fake
   structure in a later review's decisions block. Logins that do not
   match `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$` are dropped, and `disagreedBy` keeps its first 10
   valid logins. At most 50 events per artifact are kept (the first 50).
4. **When the ingest reads it.** Only for a `REVIEW` job whose state is `COMPLETED` at ingest time **and** whose
   `leaseEpoch` equals the claim's epoch. The outcome joins the ingest's per-file outcomes as `botReview`: `done`,
   `invalid` or `absent`. `botReview` never makes the ingest partial.
5. **Untrusted PRs never mint (user ruling).** When `trusted` is false, every event's row is written with status
   `skipped`, reason `untrusted-pr`.
6. **Idempotent rows.** `FleetReviewEvent` is unique on `(jobId, leaseEpoch, threadId)`; a re-ingest of the same
   bundle inserts nothing new (insert skipping duplicates) and never changes an existing row.
7. **Approver = a writer.** For a `pending` row, in this order: drop logins that end in `[bot]` from
   `disagreedBy` (none left: `skipped`, reason `no-writer`, before any lookup); run the call-9 guards; load the
   repo with `FleetReposService.findReviewRepo` (missing repo, or no `githubInstallationId`: `skipped`, reason
   `repo-unavailable`); mint a read-only token (`mintReadOnlyToken`); then walk the remaining logins in order,
   asking `getRepoRole` for each. The first login whose role is `admin`, `maintain` or `write` is the approver. No such
   login: `skipped`, reason `no-writer`. A `getRepoRole` that throws: `skipped`, reason
   `permission-check-failed` (never minted on an unverified login).
8. **The decision row (design D5).** `kind DECISION`, `subject repo:<repoId>`, `predicate
   review-finding:<findingKey>`, `object` = `Not a defect: <finding>. Reason: <reason>` plus ` (<file>:<line>)`
   when both are present (` (<file>)` when only `file` is), `confidence 1.0`, `ownerId`/`ownerType` null,
   `sourceType review_event`, `sourceId <jobId>:<threadId>`. Written through `PrismaMemoryItemRepository.upsert`,
   so a newer withdrawal of the same finding key on the same repo supersedes the older one.
9. **Mint guards, before any network call, in this order.** `ReviewDecisionWriter.guard(input)` returns
   `{ status: 'skipped', reason: 'duplicate' }` when a `MemoryItem` with `sourceType review_event` and the same
   `sourceId` exists in any status; `{ status: 'skipped', reason: 'retired' }` when a `rejected` row with
   `sourceType review_event` and the same project, `subject` and `predicate` exists; otherwise `null`. `mint`
   runs the same guards again inside its write; when `mint` returns `{ status: 'skipped', reason }`, the minter
   calls `markSkipped(reason)`. A crash between `mint` and `markMinted` leaves the row `pending`; the next pass
   then ends it `skipped` / `duplicate` (the decision exists; the row's approver login is lost, the audit entry
   keeps it).
10. **Transient failures retry.** When `mintReadOnlyToken` or `mint` throws, the row stays `pending` and its
    `attempts` count goes up by one; at 3 attempts it becomes `skipped`, reason `mint-failed`. The error is logged.
11. **Audit.** One `system.review.decision` entry per minted decision, actor `SYSTEM/review` (the design said
    `review-ingest`; the system actor id must be the key's second segment, `review`), approval
    `{ requiredMode: 'human', satisfiedBy: 'human', approverType: 'FORGE_USER', approverId: 'github:<login>' }`
    set with `runWithApproval` around `mint`, resource `memory-item` / the new id, summary
    `review decision from job <jobId>, PR #<prNumber>, approver github:<login> (one of the thread's commenters)`,
    written by the writer's own `onWritten` hook (not `memoryAuditHook`, whose summary is fixed).
    `markMinted`, `markSkipped` and the attempts bump are bookkeeping (reason `fleet.review-event-bookkeeping`);
    `claimPending` is a pure read.
12. **Forge approver type.** `ActionApproval.approverType` widens from `ActorType` to `ActorType | 'FORGE_USER'`,
    and so does `AuditEntryRecord.approverType`. The audit entry DTO's `approval.approverType` TypeScript union
    gains `FORGE_USER` (the OpenAPI schema is `type: Object` and does not change), and the audit display labels a `FORGE_USER` approver with its id (`github:alice`).
13. **When the minter runs.** `ReviewEventMinter.run()` is single-flight (a `run` that starts while one is in
    progress returns at once without claiming) and never rejects (an unexpected error is logged). It is called
    by an `@OnEvent(REVIEW_EVENTS_INGESTED)` handler and by `ReviewEventMintPoller` every
    `FLEET_REVIEW_MINT_POLL_MS` (default 300000) when `sweepEnabled` is true. One pass claims at most 20 `pending`
    rows, oldest `createdAt` first. A wake-up dropped by single-flight, and rows past the first 20, wait for the
    next poller tick (accepted).
14. **Retire (design D6).** `POST /memory/:id/retire`, handler `MemoryController.retireDecision`, body
    `{ reason?: string }` (at most 500 characters), key `memory.decision.retire`, catalog scope `['project']`,
    approval-gated like the other memory writes. Before the gate, `MemoryWriteService.retireTarget(principal, id):
    Promise<{ projectId: string }>` answers 404 `memory.notFound` when the item does not exist, is soft-deleted, or
    belongs to a project the principal is not a member of (`ProjectAccessService.assertProjectMembership`, its
    refusal mapped to 404, so a non-member learns nothing); then 422 `memory.retireNotDecision` for a
    kind other than `DECISION`; then 409 `memory.retireNotActive` for a status other than `active`. The gate runs
    with the item's project. `retireDecision` re-checks kind and status inside its transaction (409 / 422 at
    execution), applies the same replace check as superseding (`MemoryWriteGuard.mayReplace`: a developer may
    retire only items it owns; a holder of `memory.update`, such as project-admin, may retire any, including
    review-minted ones), sets `status rejected`, `activeKey null`, and records `memory.decision.retire`
    (summary includes the reason when given). Roles: `developer` gains `memory.decision.retire` in the seed and,
    for existing deployments, through an idempotent data migration
    `20261116090000_developer_memory_decision_retire` that inserts the key after `memory.decision.record` into the
    stored `developer` role when it lacks it (an unlocked system role keeps its stored permissions,
    `system-role.seeder.ts:15-22`; precedent `20261111090000_retire_fleet_approval_keys`); `project-admin` holds it
    via `*`.
15. **Retire on CLI and MCP.** CLI `koda memory retire <id> [--reason <text>] [--json]` calls the generated
    `memoryControllerRetireDecision`. MCP gains a direct tool `koda_retire_decision` `{ id, reason? }`, listed for
    every agent (like the approval tools; the gate enforces the key), provided and exported by `MemoryModule`,
    spread in the MCP controller after the approval tools, running the same route gate with origin `mcp`.

### Integration

Read-only (verified at koda `main` `1fe8d458`):

- `BundleIngestService.ingestOne` / `write` (`apps/api/src/fleet/ingest/bundle-ingest.service.ts:76,93`): one
  transaction that locks the job, parses, `replaceRows`, corrections, `markOutcome`, audit `system.ingest.drain`;
  post-commit hooks (`KNOWLEDGE_RUN_INGESTED` via `EventEmitter2`).
- `readBundleFiles` / `slotOf` / `BundleFiles` (`bundle-reader.ts`); `parseBundle` (`parse-bundle.ts`, partial
  calculation at line 55).
- `prNumberOfReviewFeature` (`apps/api/src/fleet/common/review-jobs.ts`).
- `GitHubAppClient.mintReadOnlyToken` (contents + metadata read) and the `http.request` / `obj` / `repoPath`
  helpers (`apps/api/src/fleet/git-broker/github-app-client.ts:78,152-180`).
- `FleetPrReviewPass` (`@SystemWriter` + `runAsSystemWriter`) and `FleetPrReviewPoller` (timer, `sweepEnabled`
  gating) in `apps/api/src/fleet/reviews/`.
- `PrismaMemoryItemRepository.upsert(item, { onWritten })` (`apps/api/src/memory/prisma-memory-item.repository.ts:182`);
  `memoryAuditHook` (`memory-audit.ts:34`); `MemoryWriteGuard.mayReplace` (`memory-write.guard.ts:50`).
- `MemoryController` / `MemoryRouteCommands` (`memory.controller.ts`, `memory-route.commands.ts`): the gated
  route pattern.
- `ApprovalMcpTools.registrations` (`apps/api/src/approvals/mcp/approval-mcp-tools.ts`), spread in
  `fleet/assistant/mcp/mcp.controller.ts:67`; `AssistantModule` already imports `MemoryModule`.
- The 422 pattern `super(422, { reason }, '<i18n key>', 422)` (`apps/api/src/fleet/repos/auto-review.exception.ts:6`).

Changed. The baseline locates the code; implement the target.

- `BundleFiles` / `SLOTS` / `readBundleFiles`: Baseline: nine slots. Target: adds optional `botReview?: BundleFile[]`
  and `naxStdout?: BundleFile | null` per call 2.
- New `apps/api/src/fleet/ingest/parsers/bot-review.parser.ts`: `parseBotReview(files: BundleFiles, prNumber:
  number): BotReviewParse` where `BotReviewParse = { outcome: 'absent' } | { outcome: 'invalid'; reason:
  'artifact-ambiguous' | 'artifact-invalid' } | { outcome: 'done'; trusted: boolean; events: WithdrawnEvent[] }`
  and `WithdrawnEvent = { key, threadId, file?, line?, finding, reason, disagreedBy }`.
- `parseBundle` gains an optional third parameter `opts: { reviewPrNumber?: number }`; when given, it returns
  `botReview` and records `files.botReview`, excluded from the partial calculation.
- New `FleetReviewEvent` model + migration `20261115090000_fleet_review_event`: `id`, `jobId` (FK FleetJob,
  cascade), `leaseEpoch`, `projectId`, `repoId`, `prNumber`, `findingKey`, `threadId`, `file?`, `line?`,
  `finding`, `reason`, `disagreedBy String[]`, `trusted Boolean`, `status` (`pending` | `minted` | `skipped`),
  `skipReason?`, `approverLogin?`, `memoryItemId?`, `attempts Int @default(0)`, `createdAt`, `updatedAt`;
  unique `(jobId, leaseEpoch, threadId)`; index `(status, createdAt)`.
- New `apps/api/src/fleet/reviews/fleet-review-event.repository.ts` (module-private, `FLEET_REVIEW_EVENT_REPOSITORY`)
  and the exported `FleetReviewEventsService`: `recordForJob(job, leaseEpoch, parse): Promise<{ pending: number }>`
  (`pending` = rows this call newly inserted with status `pending`),
  `claimPending(limit)`, `markMinted(id, { memoryItemId, approverLogin })`, `markSkipped(id, reason)`,
  `bumpAttempt(id): Promise<number>` (returns the new count).
- `BundleIngestService`: Baseline: constructor ends with `private readonly audit: AuditRecorder`. Target: adds a
  last parameter `private readonly reviewEvents: FleetReviewEventsService`; `write` calls `recordForJob` inside the
  transaction per call 4; after commit emits `REVIEW_EVENTS_INGESTED` (`{ jobId }`, constant in
  `apps/api/src/fleet/common/review-events.ts`) when `pending > 0`. `IngestModule` imports `FleetReviewsModule`;
  `FleetReviewsModule` exports `FleetReviewEventsService` (its header comment stops saying it exports nothing).
- `GitHubAppClient` gains `getRepoRole(token, owner, name, login): Promise<'admin' | 'maintain' | 'write' |
  'triage' | 'read' | 'none'>`: `GET /repos/{owner}/{name}/collaborators/{login}/permission`; 200 returns
  `role_name` when it is one of those values, else maps `permission` (`admin`, `write`, `read` map to themselves,
  anything else to `none`); 404 returns `none`; any other status throws `RepoCheckException('provider_error')`.
  The login is URL-encoded.
- `FleetReposService` gains `findReviewRepo(id): Promise<{ id, projectId, owner, name, githubInstallationId:
  bigint | null } | null>`.
- `ActionApproval.approverType` (`action-context.ts:44`), `AuditEntryRecord.approverType`
  (`audit/domain/audit-entry.domain.ts:21`), `AuditEntryDto.approval.approverType` (`audit/dto/audit-entry.dto.ts:16`)
  and `principalLabel` / `collectDisplayIds` (`audit/audit-log.service.ts`): call 12.
- New `runWithApproval(approval: ActionApproval, fn)` in `action-context.ts`: runs `fn` in a copy of the current
  context with `approval` replaced; throws `Error('no action context')` outside one.
- New `apps/api/src/memory/review-decision.writer.ts`: `ReviewDecisionInput = { projectId, repoId, prNumber, jobId,
  threadId, findingKey, finding, reason, file?, line? }`; `ReviewDecisionWriter.guard(input)` (call 9) and
  `ReviewDecisionWriter.mint(input): Promise<{ status: 'minted'; memoryItemId: string } | { status: 'skipped';
  reason: 'duplicate' | 'retired' }>`, provided and exported by `MemoryModule`; `reviewDecisionObject(input)`
  builds the call-8 `object`. `MemoryAuditKey` (`memory-audit.ts:11`) adds `'system.review.decision'` and
  `'memory.decision.retire'`.
- New `apps/api/src/fleet/reviews/review-event.minter.ts`: `@SystemWriter('system.review.decision')
  ReviewEventMinter` with `run(): Promise<void>`; New `review-event-mint.poller.ts`. `FleetReviewsModule` imports
  `MemoryModule`. `IFleetConfig` gains `reviewMintPollMs` (`FLEET_REVIEW_MINT_POLL_MS`, default 300000) in
  `config/fleet.config.ts` (env validation class next to lines 106-108, value next to line 168).
- Catalog (`apps/api/src/permissions/catalog.ts`): `'system.review.decision': ['system']` after
  `'system.pr-review.dispatch'`; `'memory.decision.retire': ['project']` after `'memory.decision.record'`.
  `BOOKKEEPING_REASONS` adds `fleet.review-event-bookkeeping`.
- `MemoryWriteService.retireTarget(principal, id)` and `retireDecision(principal, id, reason?)`; `MemoryController`
  `@Post(':id/retire') retireDecision`; `MEMORY_ROUTE_VARIANTS.retire = 'rest:memory.decision.retire'` and its
  `routeCommand` registration; new `RetireDecisionDto`; new `MemoryRetireException` (422, `memory.retireNotDecision`).
- `system-roles.ts` `developer` adds `memory.decision.retire` after `memory.decision.record`.
- New `apps/api/src/memory/mcp/memory-mcp-tools.ts` `MemoryMcpTools.registrations(principal)`; `McpController`
  gains a `MemoryMcpTools` parameter.
- CLI `memory retire` subcommand (`apps/cli/src/commands/memory.ts`).

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| No `bot-review.json` in a COMPLETED review's bundle | `botReview` outcome `absent`; no rows; ingest not partial. |
| Two `bot-review.json` files and no stdout success line | `invalid` (`artifact-ambiguous`); no rows. |
| Unparseable JSON, bad version, PR number mismatch, or non-boolean `trusted` | `invalid` (`artifact-invalid`); no rows. |
| An oversized `bot-review.json` or `nax.stdout` | Skipped silently; never makes the ingest partial. |
| `trusted` false | Rows written `skipped` / `untrusted-pr`; nothing minted. |
| Re-ingest of the same bundle | No new rows; existing rows unchanged. |
| A `FAILED` or `CANCELLED` review, or an older epoch's bundle | The artifact is not read. |
| The repo is gone or has no installation | `skipped` / `repo-unavailable`. |
| No login in `disagreedBy` with write access | `skipped` / `no-writer`. |
| `getRepoRole` throws | `skipped` / `permission-check-failed`. |
| `mintReadOnlyToken` or `mint` throws | Row stays `pending`, `attempts` + 1; at 3, `skipped` / `mint-failed`. |
| Same `sourceId` already minted | `skipped` / `duplicate`, no GitHub call. |
| A retired decision for the same repo and finding key | `skipped` / `retired`, no GitHub call. |
| Retire on a missing id, or one in a project the caller cannot read | 404 `memory.notFound`. |
| Retire on a non-`DECISION` item | 422 `memory.retireNotDecision`. |
| Retire on a non-active item | 409 `memory.retireNotActive`. |
| Retire by a developer on an item it does not own | 403 `permissions`. |
| An approved retire whose item is no longer active at execution | The request ends `failed` with `result.error` `execution-failed`. |

## Out of Scope

- Mapping a GitHub login to a koda user; the approver is recorded as `FORGE_USER` / `github:<login>` only.
- Turning agreed findings or any event type other than `finding-withdrawn` into memory.
- GitLab reviews; K1 reviews GitHub repos only.
- Re-checking a `skipped` event later (for example after a GitHub outage); a `skipped` row stays skipped.
- Classifying each comment in a withdrawn thread as agreement or disagreement; nax's withdrawal is taken as the judgment, and `disagreedBy` is used only to pick a writer, so the recorded approver may be any writer who commented in the thread.
- A web UI for review events or for retiring decisions; the audit page shows the new entries.
- Retiring memory items of kinds other than `DECISION`, and un-retiring a decision.
- Passing decisions into the review and the decisions selection; those are part A (feature `fleet-review-decisions`). This feature defines its own `review_event` and `repo:<id>` literals and does not import part A's module.
- Expiring or pruning `FleetReviewEvent` rows; they cascade with their job.
- Re-pinning the approver login on a row whose decision was minted just before a crash; the next pass ends that row `skipped` / `duplicate`, and the audit entry keeps the approver.
- Checking `pr.repo` or `pr.forge` in the artifact against the job's repo; the job, its bundle and its PR number already tie the artifact to the repo.

## Stories

This is one capability (review outcomes into memory, plus taking a decision back) in 11 stories, split per
package and along seams. The user confirmed one feature (2026-10-31). Each new permission key lands in the same
story as its declarer (the `@SystemWriter` class or the gated route), because the permission contract tests
fail on a catalog key nothing declares.

### US-001 — Read and parse the review artifact

Workdir: apps/api. No dependencies.

The two reader slots (never `oversized`), `parseBotReview` (calls 2 and 3), and `parseBundle`'s optional
`reviewPrNumber`.

### US-002 — Store review events at ingest

Workdir: apps/api. Depends on US-001.

The `FleetReviewEvent` model and migration (run `bun run db:generate` in `apps/api` after the schema edit; the
Prisma client is git-ignored), its repository and `FleetReviewEventsService`; the `BundleIngestService` REVIEW
branch (calls 4-6); `REVIEW_EVENTS_INGESTED` after commit; `IngestModule` imports `FleetReviewsModule`.

### US-003 — Ask GitHub for a login's role on a repo

Workdir: apps/api. No dependencies.

`GitHubAppClient.getRepoRole`.

### US-004 — A forge user as the approver

Workdir: apps/api. No dependencies.

`approverType` widened (call 12), `runWithApproval`, the audit DTO enum and the `FORGE_USER` display label.

### US-005 — Write a review decision, and declare its system key

Workdir: apps/api. Depends on US-004.

`ReviewDecisionWriter` (`guard`, `mint`, `reviewDecisionObject`) in `MemoryModule`; `FleetReviewsModule` imports
`MemoryModule`; `MemoryAuditKey` gains
`system.review.decision`; the catalog key `system.review.decision`; a `ReviewEventMinter` class carrying
`@SystemWriter('system.review.decision')`, provided by `FleetReviewsModule`, whose `run()` resolves without doing
anything yet; the writers map, role matrix and inventory pins.

### US-006 — Mint pending events

Workdir: apps/api. Depends on US-002, US-003, US-005.

The `ReviewEventMinter.run()` body (calls 7, 9, 10, 11), `FleetReposService.findReviewRepo`, and the bookkeeping
reason.

### US-007 — Run the minter on ingest and on a timer

Workdir: apps/api. Depends on US-006.

Single-flight and never-rejecting `run()`, the `@OnEvent(REVIEW_EVENTS_INGESTED)` handler,
`ReviewEventMintPoller`, `reviewMintPollMs` (call 13).

### US-008 — Retire a decision

Workdir: apps/api. Depends on US-005.

`memory.decision.retire` in the catalog and the `developer` seed role; `MemoryWriteService.retireTarget` and
`retireDecision`; `MemoryRetireException`; the gated `POST /memory/:id/retire` route (`MemoryController.retireDecision`),
`RetireDecisionDto`, the route variant and command registration; i18n keys in both locales; `MemoryAuditKey` gains
`memory.decision.retire`; the contract pins; regenerates `openapi.json` (tracked) and the CLI client (git-ignored)
with `bun run generate` from the repo root.

### US-009 — Retire for stored roles, approvals and the endpoint suite

Workdir: apps/api. Depends on US-008.

The `20261116090000_developer_memory_decision_retire` data migration; the approval-gated (202) and late-failure
paths; the endpoint e2e entry.

### US-010 — Retire over MCP

Workdir: apps/api. Depends on US-008.

`MemoryMcpTools` with `koda_retire_decision`, provided and exported by `MemoryModule`, spread into the MCP
controller's registrations.

### US-011 — Retire on the CLI

Workdir: apps/cli. Depends on US-008.

`koda memory retire <id> [--reason <text>] [--json]`.

### Context Files

**US-001**

- `apps/api/src/fleet/ingest/bundle-reader.ts` — `SLOTS`, `slotOf`, `readBundleFiles`.
- `apps/api/src/fleet/ingest/parse-bundle.ts` — `parseBundle`, per-file outcomes.
- `apps/api/src/fleet/ingest/parsers/workflow.parser.ts` — a single-file parser pattern.
- `apps/api/src/fleet/common/review-jobs.ts` — `prNumberOfReviewFeature`.

**US-002**

- `apps/api/src/fleet/ingest/bundle-ingest.service.ts` — `ingestOne`, `write` and its post-commit hooks.
- `apps/api/src/fleet/ingest/ingest.module.ts` — imports.
- `apps/api/src/fleet/reviews/fleet-reviews.module.ts` — providers and exports.
- `apps/api/src/fleet/reviews/prisma-fleet-pr-review.repository.ts` — a fleet repository pattern.
- `apps/api/test/integration/fleet/fleet-pr-review.integration.spec.ts` — PG integration setup.

**US-003**

- `apps/api/src/fleet/git-broker/github-app-client.ts` — request helpers and error mapping.
- `apps/api/src/fleet/git-broker/github-app-client.spec.ts` — fake HTTP pattern.

**US-004**

- `apps/api/src/action-context/action-context.ts` — `ActionApproval`, `runWithActionContext`.
- `apps/api/src/audit/domain/audit-entry.domain.ts` — `AuditEntryRecord`.
- `apps/api/src/audit/dto/audit-entry.dto.ts` — the approval block.
- `apps/api/src/audit/audit-log.service.ts` — `principalLabel`, `collectDisplayIds`.

**US-005**

- `apps/api/src/memory/prisma-memory-item.repository.ts` — `upsert`.
- `apps/api/src/memory/memory-audit.ts` — `memoryAuditHook`, `MemoryAuditKey`.
- `apps/api/src/fleet/reviews/fleet-pr-review.pass.ts` — the `@SystemWriter` pattern.
- `apps/api/test/integration/memory/decision-replacement-atomic.integration.spec.ts` — memory PG test pattern.

**US-006**

- `apps/api/src/fleet/repos/fleet-repos.service.ts` — the service this story extends.
- `apps/api/src/action-context/audit-coverage.reasons.ts` — bookkeeping reasons.
- `apps/api/src/action-context/audit-coverage.ts` — `bookkeeping`.

**US-007**

- `apps/api/src/fleet/reviews/fleet-pr-review.poller.ts` — timer, gating and single-flight pattern.
- `apps/api/src/fleet/knowledge/knowledge-index.queue.ts` — the `@OnEvent` pattern.
- `apps/api/src/config/fleet.config.ts` — config fields.

**US-008**

- `apps/api/src/memory/memory-write.service.ts` — `recordDecision`, `assertMayWrite`.
- `apps/api/src/memory/memory-write.guard.ts` — `mayReplace`.
- `apps/api/src/memory/memory.controller.ts` — the gated route pattern.
- `apps/api/src/memory/memory-route.commands.ts` — variants and registrations.
- `apps/api/src/fleet/repos/auto-review.exception.ts` — the 422 exception pattern.

**US-009**

- `apps/api/prisma/migrations/20261111090000_retire_fleet_approval_keys/migration.sql` — a stored-role data migration.
- `apps/api/test/integration/permissions/developer-bash-decide-migration.integration.spec.ts` — its test pattern.
- `apps/api/test/integration/memory/gated-memory-routes.integration.spec.ts` — the agent + policy fixture for 202.

**US-010**

- `apps/api/src/approvals/mcp/approval-mcp-tools.ts` — the direct MCP tool pattern.
- `apps/api/src/fleet/assistant/mcp/mcp.controller.ts` — registrations.

**US-011**

- `apps/cli/src/commands/memory.ts` — the memory command group.
- `apps/cli/src/commands/memory.spec.ts` — the CLI test pattern.

### Creates

**US-001**

- `apps/api/src/fleet/ingest/parsers/bot-review.parser.ts` — `parseBotReview`.
- `apps/api/src/fleet/ingest/parsers/bot-review.parser.spec.ts` — unit tests.

**US-002**

- `apps/api/prisma/migrations/20261115090000_fleet_review_event/migration.sql` — the `FleetReviewEvent` table.
- `apps/api/src/fleet/reviews/fleet-review-event.repository.ts` — the repository.
- `apps/api/src/fleet/reviews/fleet-review-events.service.ts` — `FleetReviewEventsService`.
- `apps/api/src/fleet/common/review-events.ts` — `REVIEW_EVENTS_INGESTED`.
- `apps/api/test/integration/fleet/fleet-review-events-ingest.integration.spec.ts` — ingest PG tests.

**US-004**

- `apps/api/src/action-context/run-with-approval.spec.ts` — unit tests for `runWithApproval`.

**US-005**

- `apps/api/src/memory/review-decision.writer.ts` — `ReviewDecisionWriter`, `reviewDecisionObject`.
- `apps/api/src/fleet/reviews/review-event.minter.ts` — `ReviewEventMinter` (declarer only in this story).
- `apps/api/test/integration/memory/review-decision-writer.integration.spec.ts` — PG tests.

**US-006**

- `apps/api/src/fleet/reviews/review-event.minter.spec.ts` — unit tests.
- `apps/api/test/integration/fleet/review-event-minter.integration.spec.ts` — PG tests of a skip-only pass.

**US-007**

- `apps/api/src/fleet/reviews/review-event-mint.poller.ts` — `ReviewEventMintPoller`.
- `apps/api/src/fleet/reviews/review-event-mint.poller.spec.ts` — unit tests.

**US-008**

- `apps/api/src/memory/dto/retire-decision.dto.ts` — `RetireDecisionDto`.
- `apps/api/src/memory/memory-retire.exception.ts` — `MemoryRetireException`.
- `apps/api/src/i18n/en/memory.json` — `notFound`, `retireNotDecision`, `retireNotActive`.
- `apps/api/src/i18n/zh/memory.json` — the same keys in Chinese.
- `apps/api/test/integration/memory/retire-decision-route.integration.spec.ts` — route tests.

**US-009**

- `apps/api/prisma/migrations/20261116090000_developer_memory_decision_retire/migration.sql` — adds the key to the stored developer role.
- `apps/api/test/integration/permissions/developer-memory-retire-migration.integration.spec.ts` — migration tests.
- `apps/api/test/integration/memory/retire-decision-approval.integration.spec.ts` — gated and late-failure tests.

**US-010**

- `apps/api/src/memory/mcp/memory-mcp-tools.ts` — `MemoryMcpTools`.
- `apps/api/src/memory/mcp/memory-mcp-tools.spec.ts` — unit tests.

### Modifies

**US-002**

- `apps/api/src/fleet/ingest/bundle-ingest.service.spec.ts` — its `new BundleIngestService(...)` calls pass the constructor arguments positionally and stop type-checking once the constructor gains its last `reviewEvents` parameter; each gains a trailing `{ recordForJob: vi.fn().mockResolvedValue({ pending: 0 }) } as never`, every existing assertion is unchanged, and the file gains this story's `BundleIngestService` unit tests.
- `apps/api/src/fleet/ingest/bundle-ingest.outcomes.spec.ts` — its `new BundleIngestService(...)` calls stop type-checking once the constructor gains its last `reviewEvents` parameter; each gains a trailing `{ recordForJob: vi.fn().mockResolvedValue({ pending: 0 }) } as never`, and every existing assertion is unchanged.
- `apps/api/src/fleet/ingest/bundle-ingest.workflow.spec.ts` — its `new BundleIngestService(...)` calls stop type-checking once the constructor gains its last `reviewEvents` parameter; each gains a trailing `{ recordForJob: vi.fn().mockResolvedValue({ pending: 0 }) } as never`, and every existing assertion is unchanged.
- `apps/api/src/fleet/ingest/bundle-ingest.pr-links.spec.ts` — its `new BundleIngestService(...)` calls stop type-checking once the constructor gains its last `reviewEvents` parameter; each gains a trailing `{ recordForJob: vi.fn().mockResolvedValue({ pending: 0 }) } as never`, and every existing assertion is unchanged.

**US-003**

- `apps/api/src/fleet/git-broker/github-app-client.spec.ts` — adds tests for this story's acceptance criteria; every existing assertion is unchanged.

**US-005**

- `apps/api/src/permissions/role-matrix.spec.ts` — the per-role cell count (line 224) pins 221 catalog keys; the new `system.review.decision` key makes it 222; it stays an exact count.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — every role gains `system.review.decision`, placed right after `system.pr-review.dispatch`, with the same cells as `system.pr-review.dispatch` for that role. Every other entry stays identical.
- `apps/api/src/permissions/system-writer.decorator.spec.ts` — the writers map (lines 40-77) gains `[ReviewEventMinter, 'system.review.decision']`, and the length assertion (line 101) changes from 35 to 36.
- `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` — the catalog spec re-derives the catalog from this file; it gains one system row for ReviewEventMinter (run on REVIEW_EVENTS_INGESTED and by ReviewEventMintPoller on a setInterval) with key system.review.decision and catalog scope system, every column mirroring the FleetPrReviewPass row (line 260) except the class name and key.

**US-006**

- `apps/api/src/action-context/audit-coverage.bookkeeping.spec.ts` — `EXPECTED_REASON_IDS` (lines 14-44), compared exactly with `Object.keys(BOOKKEEPING_REASONS).sort()` (line 127), gains `'fleet.review-event-bookkeeping'`; the assertion stays exact.
- `apps/api/src/fleet/repos/fleet-repos.service.spec.ts` — adds tests for `findReviewRepo`; every existing assertion is unchanged.

**US-007**

- `apps/api/src/common/test-helpers/fleet-config.ts` — the full typed `IFleetConfig` literal (lines 4-42) stops type-checking once `IFleetConfig` gains `reviewMintPollMs`; it gains `reviewMintPollMs: 300000`, and every other value is unchanged.

**US-008**

- `apps/api/src/permissions/role-matrix.spec.ts` — the per-role cell count (line 224), 222 after US-005, becomes 223 for the new `memory.decision.retire` key; it stays an exact count.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — every role gains `memory.decision.retire`, placed right after `memory.decision.record`: owner, admin, project-admin and developer get `["no-project","granted"]`, every other role gets `["no-project","not-granted"]` (a project-scoped key answers no-project in the global cell). Every other entry stays identical.
- `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` — it gains one REST row for POST /memory/:id/retire with key memory.decision.retire and catalog scope project, its other columns mirroring the POST /memory/decisions row (line 144).
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — AC-12 (line 68) pins exactly 126 gated routes; the new gated POST /memory/:id/retire makes it 127. Change the number and its comment (lines 65-67); the assertion stays an exact count.
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — the gated operations list gains post /api/memory/{id}/retire; the describe title (line 176) and the it title (line 257) change from 126 to 127, and toHaveLength(126) (line 259) becomes 127.
- `apps/api/src/memory/memory-route.commands.spec.ts` — it asserts 3 registrations and `MEMORY_ROUTE_VARIANTS` equal to the three current variants (lines 22-23); they become 4 registrations and the four variants including `retire: 'rest:memory.decision.retire'`.
- `openapi.json` — the expected output of `bun run generate`: the new retire operation and `RetireDecisionDto`; no other schema changes.

**US-009**

- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — gains a POST /api/memory/:id/retire happy path (201) and error case (404), next to the memory create entries (lines 3658-3665); every existing case is unchanged.

**US-010**

- `apps/api/test/integration/fleet/mcp-route.integration.spec.ts` — the exact MCP tool list (line 128) ending in `'koda_list_approvals', 'koda_decide_approval'` gains `'koda_retire_decision'` at the end; every other entry and order is unchanged.
- `apps/api/test/integration/approvals/approval-mcp.integration.spec.ts` — AC-12 (line 58) asserts `tools.slice(-2)` equals the two approval tools; it becomes `tools.slice(-3, -1)` equals the two approval tools and the last tool is `koda_retire_decision`.
- `apps/api/test/integration/fleet/permissions-mcp-tools.integration.spec.ts` — the exact MCP tool lists (lines 162, 172, 180, 201) ending in `'koda_list_approvals', 'koda_decide_approval'` gain `'koda_retire_decision'` at the end; every other entry and order is unchanged.
- `apps/api/src/fleet/assistant/mcp/mcp.controller.routes.spec.ts` — the test module (lines 75-76) provides only `ApprovalMcpTools`; it also provides a `MemoryMcpTools` stub whose `registrations` returns `[]`, and the exact tool list (line 151) is unchanged.

**US-011**

- `apps/cli/src/commands/memory.spec.ts` — adds tests for this story's acceptance criteria; every existing assertion is unchanged.

### Seams

- `parseBotReview` (US-001) is used by `BundleIngestService.write` (US-002); the US-002 integration ACs drain the
  ingest (`BundleIngestService.drain`) for an uploaded bundle and assert the stored rows.
- `FleetReviewEventsService` (US-002), `getRepoRole` (US-003) and `ReviewDecisionWriter` (US-005) are used by
  `ReviewEventMinter.run()` (US-006); the US-006 unit ACs stub all three and assert their captured calls; the
  US-006 integration AC runs the real service against Postgres.
- `runWithApproval` and the `FORGE_USER` approver (US-004) are used around `mint` (US-005 integration AC reads the
  stored `AuditEntry`; US-006 unit AC captures `currentContext()` inside the `mint` stub).
- `REVIEW_EVENTS_INGESTED` (US-002) is consumed by the minter's `@OnEvent` handler (US-007).
- `MemoryWriteService.retireDecision` (US-008) is used by the route (US-008), the MCP tool (US-010) and, through
  the generated client, the CLI (US-011).

## Acceptance Criteria

### US-001 — Read and parse the review artifact

- `[unit]` `slotOf` maps `nax-out/bot/pr-42/r1/bot-review.json` to `botReview` and `nax.stdout` to `naxStdout`.
- `[unit]` `readBundleFiles` given a bundle whose `nax.stdout` and `bot-review.json` are both larger than `INGEST_LIMITS.fileBytes` returns an empty `oversized` list.
- `[unit]` `parseBotReview` given a `finding-withdrawn` event whose `key` is `review-pr-1` drops that event.
- `[unit]` `parseBotReview` given a `finding-withdrawn` event whose `finding` is `a\nb\u0007c` returns that event with `finding` `a b c`.
- `[unit]` `parseBotReview` given one `bot-review.json` for PR 42 with `version: 3`, `trusted: true` and one valid `finding-withdrawn` event returns `{ outcome: 'done', trusted: true, events: [<that event>] }`.
- `[unit]` `parseBotReview` given `bot-review.json` files for runs `r1` and `r2` and a `nax.stdout` line `nax bot review: artifact /x/out/bot/pr-42/r2/bot-review.json` returns the events of run `r2`.
- `[unit]` `parseBotReview` given two `bot-review.json` files and a `nax.stdout` without the success line returns `{ outcome: 'invalid', reason: 'artifact-ambiguous' }`.
- `[unit]` `parseBotReview` given no `bot-review.json` returns `{ outcome: 'absent' }`.
- `[unit]` `parseBotReview` given a `bot-review.json` whose text is not JSON returns `{ outcome: 'invalid', reason: 'artifact-invalid' }`.
- `[unit]` `parseBotReview(files, 42)` given a `bot-review.json` whose `pr.number` is 43 returns `{ outcome: 'invalid', reason: 'artifact-invalid' }`.
- `[unit]` `parseBotReview` given a `bot-review.json` whose `trusted` is the string `yes` returns `{ outcome: 'invalid', reason: 'artifact-invalid' }`.
- `[unit]` `parseBotReview` given events of types `finding-withdrawn` and `finding-agreed` returns only the `finding-withdrawn` event.
- `[unit]` `parseBotReview` given a `finding-withdrawn` event whose `disagreedBy` is `['alice', 'bad login', 'bob']` returns that event with `disagreedBy` `['alice', 'bob']`.
- `[unit]` `parseBotReview` given 60 valid `finding-withdrawn` events returns the first 50.
- `[unit]` `parseBundle(files, null, { reviewPrNumber: 42 })` for a bundle whose `bot-review.json` is invalid and whose other files are done returns `partial` false.

### US-002 — Store review events at ingest

- `[integration]` `BundleIngestService.drain` for a COMPLETED `REVIEW` job (feature `review-pr-42`) whose bundle has a trusted artifact with one `finding-withdrawn` event stores one `FleetReviewEvent` row matching `{ status: 'pending', prNumber: 42, attempts: 0 }` with the event's `findingKey`, `threadId` and `disagreedBy`.
- `[integration]` `drain` for a COMPLETED `REVIEW` job whose artifact has `trusted: false` and one event stores that row with `skipReason` `untrusted-pr`.
- `[integration]` re-ingesting the same bundle through `IngestRequeueService` and `drain` leaves exactly one `FleetReviewEvent` row for that job and thread.
- `[integration]` `drain` for a `FAILED` `REVIEW` job whose bundle has a valid artifact with one event stores no `FleetReviewEvent` row.
- `[integration]` `drain` for a `RUN` job stores no `FleetReviewEvent` row.
- `[integration]` `drain` for a COMPLETED `REVIEW` job whose artifact is invalid marks the ingest `done`.
- `[integration]` `FleetReviewEventsService.recordForJob` called twice with the same parse for one job returns `{ pending: 0 }` the second time.
- `[integration]` `FleetReviewEventsService.claimPending(20)` given pending rows created at 10:00, 09:00 and 11:00 and one skipped row returns the three pending rows in the order 09:00, 10:00, 11:00.
- `[integration]` `claimPending(2)` given three pending rows returns two.
- `[integration]` `FleetReviewEventsService.bumpAttempt` called three times on one row returns 1, then 2, then 3.
- `[unit]` `BundleIngestService.write` for a COMPLETED `REVIEW` whose `recordForJob` resolves `{ pending: 1 }` emits `REVIEW_EVENTS_INGESTED` with `{ jobId }` once, after the transaction callback returns.
- `[unit]` `BundleIngestService.write` for a COMPLETED `REVIEW` whose `recordForJob` resolves `{ pending: 0 }` does not emit `REVIEW_EVENTS_INGESTED`.
- `[unit]` `BundleIngestService.write` for a COMPLETED `REVIEW` whose claim's `leaseEpoch` is 1 while the job's is 2 never calls `recordForJob`.
- `[unit]` `BundleIngestService.ingestOne` for a COMPLETED `REVIEW` whose `recordForJob` rejects records an ingest retry for the claim.

### US-003 — Ask GitHub for a login's role on a repo

- `[unit]` `getRepoRole(token, 'acme', 'api', 'alice')` sends `GET /repos/acme/api/collaborators/alice/permission` with the token.
- `[unit]` `getRepoRole` answering 200 with `role_name: 'maintain'` returns `maintain`.
- `[unit]` `getRepoRole` answering 200 with `permission: 'write'` and no `role_name` returns `write`.
- `[unit]` `getRepoRole` answering 200 with `role_name: 'custom-role'` and `permission: 'read'` returns `read`.
- `[unit]` `getRepoRole` answering 404 returns `none`.
- `[unit]` `getRepoRole` answering 500 throws `RepoCheckException` with reason `provider_error`.
- `[unit]` `getRepoRole` answering 403 throws `RepoCheckException` with reason `provider_error`.
- `[unit]` `getRepoRole(token, 'acme', 'api', 'a/b')` sends the login URL-encoded as `a%2Fb`.

### US-004 — A forge user as the approver

- `[unit]` inside `runWithActionContext({ actor: { type: 'SYSTEM', id: 'review' }, origin: 'system' }, ...)`, `runWithApproval({ requiredMode: 'human', satisfiedBy: 'human', approverType: 'FORGE_USER', approverId: 'github:alice' }, fn)` runs `fn` with `currentContext().approval.approverId` equal to `github:alice`.
- `[unit]` inside that `runWithApproval` call, `currentContext().actor` is `{ type: 'SYSTEM', id: 'review' }`.
- `[unit]` inside that `runWithApproval` call, `currentContext().correlationId` equals the outer context's.
- `[unit]` after that `runWithApproval` call returns, `currentContext().approval` is the outer context's approval.
- `[unit]` `runWithApproval(approval, fn)` outside any action context throws `no action context`.
- `[unit]` `AuditRecorder.record` inside a context whose approval has `approverType: 'FORGE_USER'` and `approverId: 'github:alice'` stores an entry with `approverType` `FORGE_USER` and `approverId` `github:alice`.
- `[unit]` the audit log list maps an entry with `approverType` `FORGE_USER` and `approverId` `github:alice` to a display `approver` of `github:alice`.

### US-005 — Write a review decision, and declare its system key

These integration ACs run `mint` inside `runAsSystem('review', ...)`.

- `[unit]` `reviewDecisionObject({ finding: 'missing null check', reason: 'guarded upstream', file: 'src/a.ts', line: 12 })` returns `Not a defect: missing null check. Reason: guarded upstream (src/a.ts:12)`.
- `[unit]` `reviewDecisionObject` with `file: 'src/a.ts'` and no `line` returns text ending in ` (src/a.ts)`.
- `[unit]` `reviewDecisionObject` with neither `file` nor `line` returns `Not a defect: missing null check. Reason: guarded upstream`.
- `[integration]` `ReviewDecisionWriter.mint` for project P, repo R1, PR 42, finding key `f-ab12`, job `j1` and thread `t1` creates an active `MemoryItem` matching `{ kind: 'DECISION', subject: 'repo:R1', predicate: 'review-finding:f-ab12', sourceType: 'review_event', sourceId: 'j1:t1', confidence: 1, ownerId: null, ownerType: null }`.
- `[integration]` that `mint`, run inside `runWithApproval` with approver `github:alice`, stores one `AuditEntry` matching `{ key: 'system.review.decision', resourceId: <new item id>, approverType: 'FORGE_USER', approverId: 'github:alice' }`.
- `[integration]` that `AuditEntry`'s summary is `review decision from job j1, PR #42, approver github:alice (one of the thread's commenters)`.
- `[integration]` `mint` called a second time with job `j1` and thread `t1` returns `{ status: 'skipped', reason: 'duplicate' }`.
- `[integration]` `mint` for repo R1 and key `f-ab12` when a `rejected` `review_event` item with subject `repo:R1` and predicate `review-finding:f-ab12` exists in project P returns `{ status: 'skipped', reason: 'retired' }`.
- `[integration]` `mint` for repo R1 and key `f-ab12` in project P when that `rejected` item exists only in project Q returns `status: 'minted'`.
- `[integration]` `mint` for job `j2`, thread `t9`, repo R1 and key `f-ab12` while an active minted item for repo R1 and key `f-ab12` exists sets the older item's status to `superseded`.
- `[integration]` `ReviewDecisionWriter.guard` for an input whose `sourceId` has no item and no retired match returns null.
- `[unit]` `PERMISSION_CATALOG` has an entry `system.review.decision` with scopes `['system']`.
- `[unit]` a testing module importing `FleetReviewsModule` with the global stub providers resolves `ReviewEventMinter`.

### US-006 — Mint pending events

- `[unit]` `ReviewEventMinter.run()` with one pending row whose `disagreedBy` is `['alice']` and `getRepoRole` returning `write` calls `ReviewDecisionWriter.mint` once with that row's `projectId`, `repoId`, `prNumber`, `findingKey`, `jobId` and `threadId`.
- `[unit]` in that run, `currentContext()` captured inside the `mint` stub has approval `{ requiredMode: 'human', satisfiedBy: 'human', approverType: 'FORGE_USER', approverId: 'github:alice' }`.
- `[unit]` in that run, `markMinted` is called with the minted item's id and approver login `alice`.
- `[unit]` `run()` with `disagreedBy` `['dependabot[bot]', 'bob']` asks `getRepoRole` only for `bob`.
- `[unit]` `run()` with `disagreedBy` `['dependabot[bot]']` calls `markSkipped` with `no-writer` and never calls `findReviewRepo`.
- `[unit]` `run()` with `disagreedBy` `['carol', 'alice']`, `carol` answering `read` and `alice` answering `maintain`, calls `markMinted` with approver login `alice`.
- `[unit]` `run()` with `disagreedBy` `['carol']` and `getRepoRole` returning `triage` calls `markSkipped` with `no-writer`.
- `[unit]` `run()` with `getRepoRole` throwing calls `markSkipped` with `permission-check-failed`.
- `[unit]` `run()` whose `guard` returns `{ status: 'skipped', reason: 'duplicate' }` calls `markSkipped` with `duplicate` and never calls `mintReadOnlyToken`.
- `[unit]` `run()` whose `findReviewRepo` returns null calls `markSkipped` with `repo-unavailable`.
- `[unit]` `run()` whose `mintReadOnlyToken` throws for a row whose `bumpAttempt` returns 1 never calls `markSkipped`.
- `[unit]` `run()` whose `mint` throws for a row whose `bumpAttempt` returns 3 calls `markSkipped` with `mint-failed`.
- `[unit]` `run()` whose `mint` returns `{ status: 'skipped', reason: 'retired' }` calls `markSkipped` with `retired`.
- `[integration]` `ReviewEventMinter.run()` against Postgres with one pending row whose `disagreedBy` is `['dependabot[bot]']` leaves the row `skipped` with `skipReason` `no-writer`.
- `[integration]` `FleetReposService.findReviewRepo` for an unknown id returns null.

### US-007 — Run the minter on ingest and on a timer

- `[unit]` a `ReviewEventMinter.run()` started while another `run()` has not settled resolves without calling `claimPending`.
- `[unit]` `ReviewEventMinter.run()` whose `claimPending` rejects resolves.
- `[unit]` emitting `REVIEW_EVENTS_INGESTED` through `EventEmitter2` in a module that registers `ReviewEventMinter` calls its `run` once.
- `[unit]` `ReviewEventMintPoller` with `sweepEnabled` true and `reviewMintPollMs` 300000 calls `ReviewEventMinter.run` once after 300000 ms of fake time.
- `[unit]` `ReviewEventMintPoller` with `sweepEnabled` false never calls `run`.
- `[unit]` `ReviewEventMintPoller.onModuleDestroy` stops further ticks.
- `[unit]` the fleet config with `FLEET_REVIEW_MINT_POLL_MS` unset resolves `reviewMintPollMs` to 300000.
- `[unit]` the fleet config with `FLEET_REVIEW_MINT_POLL_MS` set to `60000` resolves `reviewMintPollMs` to 60000.

### US-008 — Retire a decision

- `[unit]` `PERMISSION_CATALOG` has an entry `memory.decision.retire` with scopes `['project']`.
- `[unit]` the `developer` system role seed holds `memory.decision.retire`.
- `[integration]` `POST /api/memory/:id/retire` by a project-admin of P on an active review-minted `DECISION` of P with body `{ reason: 'wrong call' }` answers 201.
- `[integration]` after that retire, the item's `status` is `rejected`.
- `[integration]` after that retire, the item's `activeKey` is null.
- `[integration]` that retire stores one `AuditEntry` with key `memory.decision.retire` whose summary contains `wrong call`.
- `[integration]` `POST /api/memory/:id/retire` by a developer of P on a `DECISION` it recorded itself answers 201.
- `[integration]` `POST /api/memory/:id/retire` by a developer of P on a review-minted `DECISION` (no owner) answers 403.
- `[integration]` `POST /api/memory/:id/retire` by a viewer of P answers 403.
- `[integration]` `POST /api/memory/:id/retire` by a member of project Q only, on a `DECISION` of project P, answers 404.
- `[integration]` `POST /api/memory/:id/retire` with an unknown id answers 404 `memory.notFound`.
- `[integration]` `POST /api/memory/:id/retire` on a `FACT` item answers 422 `memory.retireNotDecision`.
- `[integration]` `POST /api/memory/:id/retire` on a `superseded` `DECISION` answers 409 `memory.retireNotActive`.
- `[integration]` `POST /api/memory/:id/retire` with a `reason` of 501 characters answers 400.
- `[integration]` the booted app's permission contract lists `POST /api/memory/:id/retire` as gated with key `memory.decision.retire`.

### US-009 — Retire for stored roles, approvals and the endpoint suite

- `[integration]` applying `20261116090000_developer_memory_decision_retire` to a database whose stored `developer` role lacks `memory.decision.retire` adds it right after `memory.decision.record`.
- `[integration]` applying that migration a second time leaves the stored `developer` permissions unchanged.
- `[integration]` applying that migration leaves the stored `viewer` role's permissions unchanged.
- `[integration]` `POST /api/memory/:id/retire` by an agent of P whose project role grants `project.read`, `memory.decision.retire` and `memory.update`, under a project policy for `memory.decision.retire` requiring `human` approval, answers 202.
- `[integration]` that 202 body carries the approval request id.
- `[integration]` after that 202, the item's `status` is still `active`.
- `[integration]` approving that pending request retires the item (its `status` becomes `rejected`).
- `[integration]` approving a pending retire request after the item was retired by someone else ends the request `failed` with `result.error` `execution-failed`.
- `[integration]` the endpoint e2e suite's `POST /api/memory/:id/retire` case answers 201 for an owner on an active `DECISION`.
- `[integration]` the endpoint e2e suite's `POST /api/memory/:id/retire` case answers 404 for an unknown id.

### US-010 — Retire over MCP

- `[unit]` `MemoryMcpTools.registrations(agent)` includes a tool named `koda_retire_decision` whose input schema requires `id` and allows an optional `reason`.
- `[unit]` calling `koda_retire_decision` with `{ id: 'm1' }` runs the route gate with key `memory.decision.retire`, variant `rest:memory.decision.retire`, the project `retireTarget` returned, and origin `mcp`.
- `[unit]` `koda_retire_decision` answers a text containing `retired m1` and `isError` false when the gate returns `done`.
- `[unit]` `koda_retire_decision` answers a text containing the approval request id when the gate returns `pending`.
- `[unit]` `koda_retire_decision` with an unknown input key `force` answers `invalid_input: force` with `isError` true.
- `[unit]` `koda_retire_decision` for an id `retireTarget` rejects with `memory.notFound` answers `isError` true with a text containing `not found`.
- `[integration]` the MCP tool list for an agent ends with `koda_retire_decision`, right after `koda_decide_approval`.

### US-011 — Retire on the CLI

- `[unit]` `koda memory retire m1` calls `memoryControllerRetireDecision` with path id `m1` and an empty body.
- `[unit]` `koda memory retire m1 --reason "wrong call"` sends body `{ reason: 'wrong call' }`.
- `[unit]` `koda memory retire m1` prints `Decision retired.` on success.
- `[unit]` `koda memory retire m1 --json` prints the response data as JSON.
- `[unit]` `koda memory retire m1` with the API answering 404 exits through `handleApiError`.
