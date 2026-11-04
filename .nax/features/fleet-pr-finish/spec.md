# SPEC: Fleet PR finish (rulings on workflow drafts, the fix ready result)

Closes: #372, #373

## Summary

A nax workflow RUN that cannot finish cleanly leaves a draft PR with open items. koda gains a way to finish it: any
project member with the new `fleet.job.rule` permission, a person or an agent, records a ruling on an open item of the
RUN (`POST /projects/:slug/fleet/jobs/:id/rulings`). A ruling is a nax ruling keyword line plus evidence. It goes
through the approval engine (direct by default, held for approval when the project sets an AGENT policy), is stored as
a `FleetPrRuling` row, and is posted as an immutable `RULING` comment on the RUN's ticket; koda creates an
`IN_PROGRESS` ticket linked to the PR when the RUN has none. Dispatching a FIX on the draft's PR ("Finish") snapshots
the pending rulings of the PR's latest RUN and the PR head sha, the runner hands them to
`nax bot review --rulings <file>`, and nax settles the items and echoes each ruling on its GitHub thread; the fix ready
step then marks the PR ready or says why it stays a draft. koda reads back which rulings nax applied or skipped. A FIX
job also records nax's ready result and thread reply counts (#373). The web job page, the ticket page, the CLI and
the assistant/MCP tools follow.

## Motivation

- #372: a workflow RUN that ends with a draft PR has no finish path in koda. Settling an open item takes a GitHub
  thread reply from a repository writer, but koda acts as the `koda-fleet` GitHub App, which nax never counts as a
  writer, so nobody can finish the PR from koda; the user runs `nax-finish` on their own machine, outside koda's
  audit, budget and runners. The user leaves most rulings to agents ("agent also is a member, they can rule it").
- #373: a FIX job records only `fixOutcome` (`pushed` / `nothing`) and `resultSha`. nax also replies on and resolves
  the threads it fixed and runs a ready step (`markedReady`, or `readyHeld` with a reason) that koda drops, so the job
  page cannot say whether the PR is ready or why it is still a draft.
- Design: `docs/superpowers/specs/2026-11-04-fleet-pr-finish-design.md` (approved 2026-11-04). nax prerequisite:
  `nax bot review --rulings` (nax PR #2784).

## Design

### User rulings (2026-11-04)

- One feature for #372 + #373. Agents rule; no per-item human question in the default flow.
- Agent rulings are direct by default; a project switches them to proposal with an approval policy on the ruling key
  for type AGENT (like the memory write mode).
- Rulings are visible: each is a comment on the koda ticket; nax echoes each applied ruling on the GitHub thread.
- A RUN without a ticket gets one at its first ruling. Ticket lifecycle option (b): created `IN_PROGRESS` with a PR
  link; marking the PR ready only adds a comment; the existing PR-merge sync moves the ticket to `VERIFY_FIX`.

### Integration

Read-only symbols (verified on `main` @ `c51cf74e`):

- `FleetJobsController` (`apps/api/src/fleet/jobs/fleet-jobs.controller.ts`): `@Controller('projects/:slug/fleet/jobs')`;
  `GET :id` is `@UseGuards(ProjectMembershipGuard, RequiresGuard) @Requires('fleet.job.read')` and answers
  `this.jobs.get(ctx.project.id, id)`; `POST /` dispatches under `fleet.job.dispatch`, `@ApprovalGated`, variant
  `FLEET_JOB_ROUTE_VARIANTS.dispatch` (`fleet-job-route.commands.ts`).
- `ApprovalRouteGate.run({ key, variant, projectId, input })` and `ApprovalPending`; route commands are registered with
  `routeCommand<Input, Result>({ key, variant, parse, run, toResult }, loader)` from `approvals/route/route-command.ts`
  in an `OnModuleInit` class listed in its module's providers (precedent: `MemoryRouteCommands`,
  `apps/api/src/memory/memory-route.commands.ts`). The registry requires the key to be approvable and `(key, variant)`
  unique; `ApprovalExecutionService` runs an approved command as the requester.
- `FleetJobRecord.workflow: FleetJobWorkflow | null` (`fleet/jobs/domain/fleet-job.domain.ts`): `{ runId, outcome:
  'ready' | 'draft' | 'local-only', workflowPassed, reasons, openItems: FleetJobWorkflowItem[] }`; an item is `{ id,
  kind, issue, severity, file, line, suggestion }`. Written by the bundle ingest (`computeCorrection` in
  `fleet/ingest/ingest-corrections.ts`).
- `prNumberFor(repo, url)` (`fleet/sync/pr-attribution.service.ts`) answers the PR number of a repo's PR URL or null.
  `reviewFeature(prNumber)` / `prNumberOfReviewFeature(feature)` (`fleet/common/review-jobs.ts`): a REVIEW or FIX job's
  feature is `review-pr-<n>`.
- `GitHubAppClient.mintReadOnlyToken(installationId, repoName)` (`fleet/git-broker/github-app-client.ts`).
- `TicketsService.create(projectSlug, dto: CreateTicketDto, principal)` (`tickets/tickets.service.ts`) creates a
  `CREATED` ticket with the next number. `TicketTransitionsService.startForDispatch(projectSlug, ticketRef, principal)`
  moves a ticket to `IN_PROGRESS` skipping the edge check.
- `FleetTicketsService.link(jobId, tickets: DispatchTicket[])` writes `FleetJobTicket` rows;
  `PrismaFleetTicketsRepository.upsertFleetPrLink({ ticketId, jobId, url, provider, prNumber, externalRef, now })`
  writes a fleet `TicketLink` of type `pr` (`fleet/tickets/prisma-fleet-tickets.repository.ts`), which
  `vcs/vcs-pr-sync.service.ts` moves to `VERIFY_FIX` on merge when the ticket is `IN_PROGRESS`.
- `PrismaFleetTicketsRepository.createSystemComment(ticketId, body)` creates a comment with both author ids null.
- `CommentsService.assertEditable` refuses every non-`GENERAL` comment with `comments.workflowImmutable`.
- `parseBotReview(files, prNumber)` (`fleet/ingest/parsers/bot-review.parser.ts`) and the FIX review ingest in
  `BundleIngestService.write` (`reviewEligible` covers FIX in COMPLETED, FAILED and CANCELLED).
- `capabilityMisfit(job, caps)` (`fleet/jobs/placement-rules.ts`) and the capability parser
  (`fleet/common/capabilities-core.ts`).
- Assistant tools: `AssistantTool` (`fleet/assistant/assistant-tool.types.ts`), `AssistantToolRegistry.register`,
  tool group classes under `fleet/assistant/tools/`, descriptors in `fleet/assistant/koda-tool-descriptors.ts`,
  `MCP_DESCRIPTIONS` in `fleet/assistant/mcp/mcp-tool-catalog.ts`.
- Runner: `readFixResult`, `readPushedSha` (`apps/runner/src/verdict/fix-result.ts`), `HostExecutor.readFixOutcome`,
  `JobRun.judge` (`apps/runner/src/supervisor/job-run.ts`), `buildNaxArgv` (`apps/runner/src/executor/nax-process.ts`),
  `writeReviewDecisions` (`review-decisions-file.ts`), `ATTEMPT_FILES` (`host-executor.ts`), the nax probe
  (`apps/runner/src/capabilities/nax-probe.ts`).
- Web: `apps/web/pages/[project]/fleet/jobs/[id]/index.vue`, `useFleetJobs(slug)` (`dispatch`, `get`),
  `FleetJobWorkflow.vue`, `CommentThread.vue`, `useProjectPermissions(slug)`, `apps/web/lib/fleet-types.ts`.
- CLI: `apps/cli/src/commands/fleet-job.ts` (`show <jobId>`), `handleApiError` (`apps/cli/src/utils/error.ts`: 401/403
  exit 2, 400 exit 3, 404 exit 4, other API/network exit 1, approval pending exit 5).
- nax `bot review --rulings <path>` (nax PR #2784): file `{ version: 1, headSha, rulings: [{ item, key?, ruling, by,
  at }] }`; `item` `^[A-Za-z0-9._:-]{1,64}$`; `ruling` 1..2000 chars, first line a nax ruling keyword; `by` 1..100
  chars, no newline; `at` ISO datetime with offset, at most 5 minutes in the future; at most 100 rulings, one per item.
  The `bot-review.json` artifact gains `callerRulings: { applied: [{ item, disposition }], skipped: [{ item, reason }],
  ignored?: 'untrusted-pr' | 'head-mismatch' }`; skip reasons `unknown-item`, `stale-key`, `already-settled`,
  `superseded-by-writer`, `ambiguous-item`, `echo-failed`, `recorder-failed`. An invalid file fails the command.

Mutated symbols. The baseline exists only to locate the code; it is never the interface to implement.

- `SnapshotEventPayload` (`packages/fleet-protocol/src/index.ts`). Baseline: has `fixOutcome?: 'pushed' | 'nothing'`.
  Target: also `fixReady?: { markedReady: boolean; readyHeld?: string; replied?: number; resolved?: number }`.
- `AssignPayload.review` (same file). Baseline: `{ prNumber; botLogin; decisions?: ReviewDecision[];
  trustDetectedChecks?: true }`. Target: also `rulings?: { headSha: string; rulings: CallerRuling[] }` with a new
  exported `CallerRuling { item: string; ruling: string; by: string; at: string }`.
- `RunnerCapabilities` (same file). Target: gains `botRulings?: true`.
- `mirror(p)` (`apps/api/src/fleet/sync/event-payloads.ts`). Target: also maps a valid `p.fixReady` to the patch.
- `FleetJobRecord` / `FleetJobPatch` / `NewFleetJob` (`fleet-job.domain.ts`). Target: gain `fixReady?: FixReady | null`
  and `prRulings?: FleetJobPrRulings | null` (`{ headSha: string; rulings: { rulingId: string; item: string; ruling:
  string; by: string; at: string }[] } | { notSent: 'head-unreadable' | 'pr-not-open' }`).
- `FleetJobDto` (`dto/fleet-job.dto.ts`). Target: gains `fixReady` (nullable).
- Prisma `FleetJob`. Target: gains `fixReady Json?` and `prRulings Json?`.
- `FleetJobsService` FIX dispatch (`fleet-jobs.service.ts`, beside the `reviewDecisions` snapshot). Target: a FIX also
  snapshots the PR's pending rulings and head sha into `prRulings`; a requeue keeps `prRulings` and resets `fixReady`.
- `buildAssignPayload` (`fleet/jobs/assign-payload.ts`). Target: a FIX whose `prRulings` has rulings adds
  `review.rulings`.
- `VcsPrStatus` (`apps/api/src/vcs/types.ts`) and `GitHubAppClient.getPullRequest`. Baseline: no head sha. Target:
  `VcsPrStatus` gains `headSha?: string`, which the GitHub client maps from `head.sha`.
- `PlacementJob`, `toPlacementJob`, `MisfitReason` and `capabilityMisfit` (`placement-rules.ts`). Baseline:
  `PlacementJob` has no ruling field and `toPlacementJob` picks command, repo, project, provider, profiles, labels, pin,
  bash mode and thread. Target: `PlacementJob` gains `needsBotRulings?: true`, which `toPlacementJob` sets when the
  job's `prRulings.rulings` is non-empty and otherwise omits (so existing `toEqual` assertions on its output hold); `firstMisfit` answers `bot_rulings` for such a job on a runner without
  `botRulings`. The queued scan (`findQueuedPage`) has no capability filter, so the misfit is decided per job in
  `fillRunner` like `bot_fix`; `bot_rulings` is not permanent, so the pinned-runner check at dispatch, which runs before
  the snapshot, never refuses for it.
- `CommentType` (`apps/api/src/common/enums.ts`). Target: gains `RULING: 'RULING'`.
- `BotReviewParse` `done` variant. Target: gains `callerRulings?: { applied: { item: string; disposition: string }[];
  skipped: { item: string; reason: string }[]; ignored?: 'untrusted-pr' | 'head-mismatch' }`.
- `parseAssign` (`apps/runner/src/supervisor/assign-parser.ts`). Baseline: rebuilds `review` from `prNumber`,
  `botLogin`, `trustDetectedChecks` and `decisions`, so any other field is dropped. Target: a FIX also keeps a valid
  `review.rulings` (`headSha` 40 hex; 1..100 rulings; each `item` `^[A-Za-z0-9._:-]{1,64}$`, `ruling` 1..2000 chars,
  `by` 1..100 chars without a newline, `at` a parseable ISO datetime; items unique); a REVIEW carrying `rulings`, or a
  FIX with malformed `rulings`, is refused as `bad('review')`.
- `buildNaxArgv(naxCommand, assign, opts)` (runner). Baseline opts `{ decisionsPath?: string }`. Target opts `{
  decisionsPath?: string; rulingsPath?: string }`; `--rulings <rulingsPath>` follows `--decisions` in the `bot review`
  argv of a FIX.
- `readPushedSha(logPath)` (runner). Target: replaced by `readFixState(logPath): Promise<FixState | null>` with
  `FixState { pushedSha: string | null; fixReady: FixReady | null }`; `FixOutcome` gains the optional
  `readonly fixReady?: FixReady | null`.

### Approach

**Ruling record (US-003).** New model `FleetPrRuling { id, projectId, repoId, prNumber, jobId, itemId, itemKind,
text, disposition, actorType, actorId, state, skipReason?, appliedJobId?, commentId?, approvalRequestId?, createdAt,
updatedAt }`, `state` one of `pending`, `applied`, `skipped`, `replaced`, index `[repoId, prNumber, state]` and
`[jobId, itemId]`. A new `apps/api/src/fleet/rulings/` module holds it (repository extends
`AbstractPrismaRepository`, behind a DI token). `parseRulingText(text): { disposition: RulingDisposition; reason:
string; sha?: string } | null` in `fleet/rulings/ruling-keyword.ts` mirrors nax's grammar on the first non-empty line:
`fixed <7-40 hex>[ — | - | : reason]` -> `fixed`; `waive: <reason>` / `waived: <reason>` -> `waived`; `override:` /
`overridden:` -> `overridden`; `confirm[: reason]` / `confirmed` -> `confirmed`; `verify[: reason]` / `verified` ->
`verified`; case-insensitive. koda's evidence rule: `waived`, `overridden` and `confirmed` need a non-empty reason, so
`parseRulingText('confirm')` is null.

**Ruling route (US-004).** `POST /projects/:slug/fleet/jobs/:id/rulings` body `CreateRulingDto { itemId: string
(1..64, `^[A-Za-z0-9._:-]+$`); text: string (1..2000) }`, `@UseGuards(ProjectMembershipGuard, RequiresGuard)`,
`@Requires('fleet.job.rule')` (guard level, so a caller without the key gets 403 before any job state is read),
`@ApprovalGated()`. `FleetPrRulingsService.ruleTarget(projectId,
jobId, dto)` runs before the gate, in this order: the job is in the project (else 404 `fleet.jobs`); it is a RUN
whose `workflow.outcome` is `draft` and whose `resultPrUrl` gives a PR number through `prNumberFor` on a GitHub repo
(else 409 `fleet.rulings.notDraft`); it is the latest RUN of that PR (`latestRunForPr`, below; else 409
`fleet.rulings.notLatest`); `itemId` is in `workflow.openItems` (else 404 `fleet.rulings.unknownItem`);
`parseRulingText(text)` is not null (else 400 `ValidationAppException` naming `text`). Then
`ApprovalRouteGate.run({ key: 'fleet.job.rule', variant: FLEET_RULING_ROUTE_VARIANTS.create, projectId, input: { slug, projectId, jobId, ruling: dto } })`; pending answers 202. The
command's `run` re-runs `ruleTarget` (so an approval decided after the item's ruling was applied, the outcome changed or a newer
RUN appeared fails with the same 404/409 and writes nothing), then calls `FleetPrRulingsService.create(principal, slug,
jobId, dto)`, which in one transaction marks the `pending` ruling of the same
`(jobId, itemId)` `replaced`, inserts the new `pending` row (its `text` normalised to start at the first non-empty line, trimmed), records the audit entry (`fleet.job.rule`, summary
`ruled <itemId>: <disposition>`), and runs the ticket step (US-005). The route answers 201 with `FleetPrRulingDto`.
`GET /projects/:slug/fleet/jobs/:id/rulings` (`fleet.job.read`) lists the job's rulings, newest first, every state.
`FLEET_RULING_ROUTE_VARIANTS = { create: 'rest:fleet.job.rule' } as const` in `fleet-ruling-route.commands.ts`.
`latestRunForPr(repoId, prNumber)` loads the repo's RUN jobs whose `resultPrUrl` ends with `/pull/<prNumber>`,
newest `createdAt` first, and answers the first whose `resultPrUrl` gives that PR number through `prNumberFor`.
After the text-parse check, one more pre-gate check refuses an item whose latest ruling is `applied` (409 `fleet.rulings.settled`): nax already
settled it.
`fleet.job.rule` is a new catalog key (scope project, inventory row `['project']`); the `fleet.job.*` glob grants it
to developer, `*` to project-admin, admin and owner. Its derived approval is approvable, floor `none`, default `none`.

**Ticket step (US-005).** Inside the create transaction, `FleetJobTicketEffects.ensureFinishTicket(job, principal)`
locks the RUN job row (`SELECT ... FOR UPDATE` on `FleetJob`), then answers the oldest `FleetJobTicket` link's
ticket that is not soft-deleted and not `CLOSED` or `REJECTED`, when one exists; otherwise it creates a TASK ticket titled `Finish draft PR #<n> (<feature>)` through
`TicketsService.create` as the ruling's principal, moves it to `IN_PROGRESS` through `startForDispatch`, links it to
the RUN with `FleetTicketsService.link`, and writes the fleet PR link with `upsertFleetPrLink`. Then
`createRulingComment(ticketId, body, principal)` writes a `RULING` comment authored by the principal (`authorUserId`
or `authorAgentId`), body `<itemId> (<itemKind>): <text>`, and its id is stored on the ruling. `TicketsService.create` inside the ruling transaction gets one number
allocation attempt (`runWithTicketNumberRetry` does not retry inside a transaction), so a concurrent ticket creation
that wins the number answers 409 and the ruling is not written; the caller retries. `fleet.job.rule` alone is enough
to create the finish ticket and its comments (no `ticket.create` check), as `fleet.job.dispatch` already starts
tickets through `startForDispatch`.

**Rulings to the runner (US-006 snapshot, US-007 payload and placement).** At FIX dispatch, after the `reviewDecisions` snapshot and before the insert
transaction, `FleetPrRulingsService.snapshotForFix(repo, prNumber)` selects the `pending` rulings of `latestRunForPr(repo.id, prNumber)`. With none it answers undefined and the job carries no `prRulings`. With some it mints a read-only
token and calls `getPullRequest`; an open PR with a `headSha` gives `{ headSha, rulings: [...] }`, each ruling as `{
rulingId, item: itemId, ruling: text, by, at: createdAt ISO }`, at most 100 (the oldest `createdAt` first; the rest
wait for the next FIX, since nax refuses a file of more than 100); a closed or missing PR gives `{ notSent:
'pr-not-open' }`; a thrown read gives `{ notSent: 'head-unreadable' }`. `by` is `koda:agent:<agent slug>` or
`koda:user:<user name>`, newlines removed, clipped to 100 characters. When a RUN job's ingest writes a `workflow`
with a PR, every `pending` ruling of an older RUN for the same `(repoId, prNumber)` becomes `replaced`
(`FleetPrRulingsService.replaceOlderRuns(runJob)`, called from `BundleIngestService.write`).
`buildAssignPayload` copies `prRulings` without `rulingId` into `review.rulings` for a FIX. Placement:
`toPlacementJob` sets `needsBotRulings` and `firstMisfit` answers `bot_rulings` for it on a runner whose
capabilities lack `botRulings`. Module wiring: `FleetRulingsModule` reads FIX and RUN jobs through its own
repository (Prisma escape hatch), never by importing `FleetJobsModule`, so `FleetJobsModule`, `IngestModule` and
`AssistantModule` import it without a cycle.

**Runner (US-008).** When `assign.review.rulings` has rulings, the runner writes `review-rulings.json` in the job dir
(`{ version: 1, headSha, rulings }`, mode 0600) through `writeReviewRulings(jobDir, rulings)` and passes
`rulingsPath` to `buildNaxArgv`, which appends `--rulings <path>` after `--decisions` for a FIX. The file name joins
`ATTEMPT_FILES`. The probe adds `botRulings: true` when `bot review --help` lists `--rulings` and `botReview` passed.

**Results (US-009).** `parseBotReview` reads `callerRulings` from the selected artifact when present (each `applied`
entry needs string `item` and `disposition`, each `skipped` entry string `item` and `reason`; malformed entries are
dropped; `ignored` kept only when it is `untrusted-pr` or `head-mismatch`). In the FIX branch of
`BundleIngestService.write`, `FleetPrRulingsService.recordResults(job, parse)` maps each item of
`job.prRulings.rulings` to its ruling: an item in `applied` -> `applied`; an item in `skipped` with reason
`echo-failed` or `recorder-failed` -> stays `pending`; any other `skipped` reason -> `skipped` with that `skipReason`;
`ignored: 'untrusted-pr'` -> every sent ruling `skipped` with `untrusted-pr`; `ignored: 'head-mismatch'` or a
missing `callerRulings` -> every sent ruling stays `pending`. Only rulings still `pending` change state. Each changed
ruling gets `appliedJobId`. When at least one ruling changed, one system `RULING` comment is written on the RUN's
ticket: `Finish <jobId>: applied D-1 (confirmed), B3 (waived); skipped G-1 (superseded-by-writer)`. When the FIX's
`fixReady.markedReady` is true, one system comment `PR #<n> marked ready by FIX <jobId>` is written on the ticket of
every RUN of the same repo whose `resultPrUrl` is that PR; ticket status does not change. Both system comments carry
the FIX job id in their body, and each is skipped when the ticket already has a comment with exactly that body, so a
re-delivered bundle writes neither twice. Ingest claims a bundle only after the job is terminal (`claimNext`), and the
terminal transition follows the runner's final snapshot (with `fixReady`), so ingest sees `fixReady`.

**Fix ready result (US-001, US-002).** The runner's `readFixState` reads `bot-state.json` once: `pushedSha` (40 hex),
`markedReady` (boolean), `readyHeld` (string, clipped to 500 characters), `replied`, `resolved` (non-negative
integers). `fixReady` is null when `markedReady` is absent; otherwise `{ markedReady, readyHeld?, replied?, resolved?
}`. `judge` adds `fixReady` to the snapshot next to `fixOutcome`. The API's `mirror` keeps a `fixReady` whose
`markedReady` is boolean, drops a non-string `readyHeld` and non-integer counts, clips `readyHeld` to 500.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| US-004: ruling on a job of another project, or an unknown job | 404 `fleet.jobs` before the gate |
| US-004: the job is not a RUN, its workflow outcome is not `draft`, or it has no GitHub PR | 409 `fleet.rulings.notDraft` before the gate |
| US-004: `itemId` not in the job's open items | 404 `fleet.rulings.unknownItem` before the gate |
| US-004: `text` does not parse, or `waive`/`override`/`confirm` without a reason | 400 naming `text`; nothing written |
| US-004: caller lacks `fleet.job.rule` | 403 from the guard, before the job is read |
| US-004: the RUN is not the latest RUN of its PR | 409 `fleet.rulings.notLatest` before the gate |
| US-004: the item's latest ruling is `applied` | 409 `fleet.rulings.settled` before the gate |
| US-004: an approval executes after the item's ruling was applied, the outcome changed or a newer RUN appeared | `run` re-checks the target; the execution fails with the same 404/409 and writes nothing |
| US-004: agent in a project whose `fleet.job.rule` AGENT policy is `human` | 202 with the approval request; on approval the ruling, ticket and comment are written as the agent |
| US-005: ticket creation or the comment fails | the whole ruling transaction rolls back; no ruling row |
| US-005: another ticket in the project takes the number first | 409; the ruling is not written; the caller retries |
| US-006: PR head read throws at FIX dispatch | the FIX is dispatched with `prRulings: { notSent: 'head-unreadable' }` and no rulings in its payload |
| US-006: the PR is closed or missing at FIX dispatch | the FIX is dispatched with `prRulings: { notSent: 'pr-not-open' }` |
| US-007: no runner has `botRulings` | the FIX with rulings stays queued with misfit `bot_rulings` |
| US-009: `ignored: head-mismatch`, or no `callerRulings` in the artifact | sent rulings stay `pending` |
| US-009: `ignored: untrusted-pr` | every sent ruling `skipped` with `untrusted-pr` |
| US-009: skip reason `echo-failed` or `recorder-failed` | that ruling stays `pending` |
| US-002: `bot-state.json` missing, unreadable or without `markedReady` | `fixReady` absent from the snapshot; outcome unchanged |
| US-013: API or network error, invalid option | shared `handleApiError`: 401/403 exit 2, 400 exit 3, 404 exit 4, other exit 1, approval pending exit 5; an invalid option exits 3 before any call |

## Out of Scope

- Settling workflow items any other way than nax's ruling path: no `nax workflow record` or `promote`, no writes to nax files, no koda-side GitHub thread replies.
- Legacy workflow drafts (published before nax 0.91.2, no item index) and pipeline-mode escalations (`finish-audit/`).
- Rulings on PRs that no koda RUN produced; the ruling route accepts only a RUN job with a draft workflow outcome.
- No koda-side LLM drafts rulings; the ruler is whoever calls the route (a person, or an agent through MCP or CLI).
- No automatic Finish: only an explicit FIX dispatch carries rulings; a REVIEW (manual or the auto-review poller) never carries rulings.
- No keyword-per-item-kind rule: any keyword may rule any item kind, as for a writer's thread reply.
- `fleet.job.rule` alone creates the finish ticket and its `RULING` comments; no `ticket.create` or `comment.create` check is added on that path.
- US-007 only: the dashboard attention list does not surface a FIX waiting on `bot_rulings` as unplaceable (its queued rows carry no `prRulings`); the job's own misfit shows it.
- US-012 only: the Finish button is not hidden after a PR is marked ready; a further FIX on a ready PR answers `nothing to fix`.
- `RULING` comments are immutable against edits only; deleting one is allowed and leaves the ruling's `commentId` pointing at a deleted comment.
- No sweeper for `pending` rulings on PRs readied, merged or closed outside koda.
- No ticket status change when a PR is marked ready, and no new ticket transition; the existing PR-merge sync moves the ticket.
- Red CI, merge conflicts and gate repair are not handled by Finish; they show as the fix ready hold.
- GitLab: rulings and Finish are GitHub-only, like K1-K3.
- K3's follow-up REVIEW after a pushed FIX is unchanged; replacing it with nax's own post-push re-review is a separate decision.
- No PR head binding at ruling time: the head is read when the FIX is dispatched, and a push between dispatch and the review leaves the rulings `pending` (nax `head-mismatch`).
- The nax change (`--rulings`) ships in nax PR #2784, not in this feature; installing a nax with `--rulings` on the runner host is a deploy step.
- `.nax/rules/` and other `.nax/` files are not edited by this feature.

## Stories

This feature has 13 stories, one package each: 8 api, 2 runner, 2 web, 1 cli. It is one capability (finishing a nax workflow draft PR from koda); the user chose one feature for #372 and #373 on
2026-11-04, and confirmed the 11-story list; US-003 and US-005 of that list were each split in two by assertion count
(ruling core / ruling routes, dispatch snapshot / payload and placement). Story-size gate resolved from
`.nax/config.json`: `maxAcCount` 15, `maxBulletPoints` 15, enabled. Protocol type edits
(`packages/fleet-protocol/src/index.ts`, types only) ride the api story that first needs them, as in K3.

### US-001: Store the fix ready result on a FIX job

Workdir: `apps/api`. No dependencies. #373 storage: protocol `SnapshotEventPayload.fixReady`, `mirror` validation,
the `FleetJob.fixReady` column (migration `20261122090000_fleet_job_fix_ready`), `FixReady` in the domain,
`FleetJobDto.fixReady`, and the requeue reset.

### US-002: Runner reads the fix ready result

Workdir: `apps/runner`. Depends on US-001. #373 runner: `readFixState` replaces `readPushedSha`, `readFixOutcome`
carries `fixReady`, `judge` adds it to the snapshot.

### US-003: Ruling record, keyword parser and service

Workdir: `apps/api`. No dependencies. #372 core: `FleetPrRuling` (migration `20261122090100_fleet_pr_rulings`), the
new `fleet/rulings/` module and repository, `parseRulingText`, and `FleetPrRulingsService.create` (re-ruling marks the
earlier `pending` ruling `replaced`, audit entry). No route yet.

### US-004: Ruling routes and permission

Workdir: `apps/api`. Depends on US-003. The `fleet.job.rule` catalog key, `POST` and
`GET /projects/:slug/fleet/jobs/:id/rulings`, the pre-gate checks (`ruleTarget`), the route variant
`rest:fleet.job.rule` and its route command, i18n `fleet.rulings.*`.

### US-005: Post every ruling on the work's ticket

Workdir: `apps/api`. Depends on US-004. `CommentType.RULING`, `ensureFinishTicket` (oldest linked ticket, or a new
`IN_PROGRESS` TASK ticket linked to the RUN and the PR), `createRulingComment`, all inside the ruling transaction.

### US-006: Snapshot the pending rulings at FIX dispatch

Workdir: `apps/api`. Depends on US-003. `VcsPrStatus.headSha` from the GitHub client, `snapshotForFix` (latest RUN,
`by` label, head read), `FleetJob.prRulings` (migration `20261122090200_fleet_job_pr_rulings`) stored at FIX dispatch,
and older-RUN rulings `replaced` on RUN ingest.

### US-007: Carry rulings in the assign payload and placement

Workdir: `apps/api`. Depends on US-006. Protocol `CallerRuling`, `AssignPayload.review.rulings` and
`RunnerCapabilities.botRulings`; `buildAssignPayload`; the `bot_rulings` misfit in placement, the dashboard types and
the job DTO enum; capability parsing.

### US-008: Runner passes rulings to nax

Workdir: `apps/runner`. Depends on US-007. `writeReviewRulings`, `--rulings` in the FIX review argv, the attempt
wipe, and the `botRulings` probe.

### US-009: Record what nax did with the rulings

Workdir: `apps/api`. Depends on US-001, US-005, US-006. `callerRulings` in `parseBotReview`, `recordResults` in the
FIX ingest, the summary `RULING` comment, and the marked-ready ticket comment.

### US-010: Assistant and MCP tools for rulings

Workdir: `apps/api`. Depends on US-004. Read tool `koda_list_pr_rulings` (`fleet.job.read`) and write tool
`koda_rule_pr_item` (`fleet.job.rule`, with preview), descriptors, registry and MCP descriptions.

### US-011: Web shows the fix ready result and ruling comments

Workdir: `apps/web`. Depends on US-001, US-005. FIX job page ready line and reply counts; `CommentThread` renders
`RULING` with a label and no edit control.

### US-012: Web open items, rulings and Finish

Workdir: `apps/web`. Depends on US-004, US-007. Open items table on a draft RUN with each item's latest ruling, a
ruling form per row (`fleet.job.rule`), a Finish button (`fleet.job.dispatch`) that dispatches a FIX for the PR, and
the `bot_rulings` misfit label.

### US-013: CLI ready result and ruling commands

Workdir: `apps/cli`. Depends on US-001, US-004. `koda fleet job show` prints the ready result; `koda fleet job
rulings <jobId>` lists rulings; `koda fleet job rule <jobId> <itemId> <text>` records one.

### Context Files

**US-001**

- `packages/fleet-protocol/src/index.ts`
- `apps/api/src/fleet/sync/event-payloads.ts`
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts`
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts`

**US-002**

- `apps/runner/src/verdict/fix-result.ts`
- `apps/runner/src/executor/host-executor.ts`
- `apps/runner/src/supervisor/job-run.ts`
- `packages/fleet-protocol/src/index.ts` — `fixReady` added by US-001

**US-003**

- `apps/api/src/memory/prisma-memory-item.repository.ts` — precedent for an `AbstractPrismaRepository`
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`
- `apps/api/prisma/schema.prisma`

**US-004**

- `apps/api/src/memory/memory-route.commands.ts` — precedent for a route command
- `apps/api/src/fleet/jobs/fleet-jobs.controller.ts`
- `apps/api/src/fleet/jobs/fleet-job-route.commands.ts`
- `apps/api/src/permissions/catalog.ts`
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts` — created by US-003

**US-005**

- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts`
- `apps/api/src/fleet/tickets/prisma-fleet-tickets.repository.ts`
- `apps/api/src/tickets/tickets.service.ts`
- `apps/api/src/tickets/state-machine/ticket-transitions.service.ts`
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts` — created by US-003, extended here

**US-006**

- `apps/api/src/fleet/jobs/fleet-jobs.service.ts`
- `apps/api/src/fleet/git-broker/github-app-client.ts`
- `apps/api/src/fleet/ingest/bundle-ingest.service.ts`
- `apps/api/src/fleet/sync/pr-attribution.service.ts`
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts` — created by US-003, extended here

**US-007**

- `apps/api/src/fleet/jobs/assign-payload.ts`
- `apps/api/src/fleet/jobs/placement-rules.ts`
- `apps/api/src/fleet/common/capabilities-core.ts`
- `packages/fleet-protocol/src/index.ts`

**US-008**

- `apps/runner/src/executor/nax-process.ts`
- `apps/runner/src/executor/review-decisions-file.ts`
- `apps/runner/src/executor/host-executor.ts`
- `apps/runner/src/capabilities/nax-probe.ts`
- `packages/fleet-protocol/src/index.ts` — `CallerRuling`, `review.rulings`, `botRulings` added by US-007

**US-009**

- `apps/api/src/fleet/ingest/parsers/bot-review.parser.ts`
- `apps/api/src/fleet/ingest/bundle-ingest.service.ts`
- `apps/api/src/fleet/reviews/fleet-review-events.service.ts`
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts`
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts` — created by US-003, extended here

**US-010**

- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts`
- `apps/api/src/fleet/assistant/tools/fleet-write-tools.ts`
- `apps/api/src/fleet/assistant/tools/dispatch-job-tool.ts`
- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.ts`
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts` — created by US-003

**US-011**

- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue`
- `apps/web/components/CommentThread.vue`
- `apps/web/lib/fleet-types.ts`
- `apps/web/i18n/locales/en.json`

**US-012**

- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue`
- `apps/web/components/fleet/FleetJobWorkflow.vue`
- `apps/web/composables/useFleetJobs.ts`
- `apps/web/lib/fleet-types.ts`
- `apps/web/tests/pages/fleet-job-fix-action.spec.ts` — precedent for a FIX action on the job page

**US-013**

- `apps/cli/src/commands/fleet-job.ts`
- `apps/cli/src/commands/fleet-job.spec.ts`
- `apps/cli/src/utils/error.ts`

### Creates

**US-001**

- `apps/api/prisma/migrations/20261122090000_fleet_job_fix_ready/migration.sql`
- `apps/api/src/fleet/sync/event-payloads.fix-ready.spec.ts`

**US-002**

- `apps/runner/src/verdict/fix-result.fix-ready.spec.ts`

**US-003**

- `apps/api/prisma/migrations/20261122090100_fleet_pr_rulings/migration.sql`
- `apps/api/src/fleet/rulings/fleet-rulings.module.ts`
- `apps/api/src/fleet/rulings/fleet-rulings.module.spec.ts`
- `apps/api/src/fleet/rulings/ruling-keyword.ts`
- `apps/api/src/fleet/rulings/ruling-keyword.spec.ts`
- `apps/api/src/fleet/rulings/fleet-pr-ruling.domain.ts`
- `apps/api/src/fleet/rulings/prisma-fleet-pr-ruling.repository.ts`
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts`
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.spec.ts`
- `apps/api/test/integration/fleet/fleet-pr-ruling.repository.integration.spec.ts`

**US-004**

- `apps/api/src/fleet/rulings/fleet-rulings.controller.ts`
- `apps/api/src/fleet/rulings/fleet-ruling-route.commands.ts`
- `apps/api/src/fleet/rulings/dto/create-ruling.dto.ts`
- `apps/api/src/fleet/rulings/dto/fleet-pr-ruling.dto.ts`
- `apps/api/test/integration/fleet/fleet-pr-rulings.integration.spec.ts`

**US-005**

- `apps/api/test/integration/fleet/fleet-pr-ruling-ticket.integration.spec.ts`

**US-006**

- `apps/api/prisma/migrations/20261122090200_fleet_job_pr_rulings/migration.sql`
- `apps/api/src/fleet/rulings/fleet-pr-rulings.snapshot.spec.ts`
- `apps/api/test/integration/fleet/fleet-pr-rulings-dispatch.integration.spec.ts`

**US-007**

- `apps/api/src/fleet/jobs/assign-payload.rulings.spec.ts`

**US-008**

- `apps/runner/src/executor/review-rulings-file.ts`
- `apps/runner/src/executor/review-rulings-file.spec.ts`

**US-009**

- `apps/api/src/fleet/rulings/fleet-pr-rulings.results.spec.ts`
- `apps/api/test/integration/fleet/fleet-pr-rulings-ingest.integration.spec.ts`

**US-010**

- `apps/api/src/fleet/assistant/tools/pr-ruling-tools.ts`
- `apps/api/src/fleet/assistant/tools/pr-ruling-tools.spec.ts`
- `apps/api/test/integration/fleet/assistant-pr-ruling-tools.integration.spec.ts`

**US-011**

- `apps/web/tests/pages/fleet-job-fix-ready.spec.ts`

**US-012**

- `apps/web/components/fleet/FleetJobOpenItems.vue`
- `apps/web/composables/useFleetRulings.ts`
- `apps/web/tests/components/FleetJobOpenItems.spec.ts`
- `apps/web/tests/composables/useFleetRulings.spec.ts`

**US-013**

- `apps/cli/src/commands/fleet-job-rulings.ts`
- `apps/cli/src/commands/fleet-job-rulings.spec.ts`

### Modifies

**US-001**

- `packages/fleet-protocol/src/index.ts` — `SnapshotEventPayload` gains `fixReady?: { markedReady: boolean; readyHeld?: string; replied?: number; resolved?: number }`; types only.
- `apps/api/prisma/schema.prisma` — `FleetJob` gains `fixReady Json?`.
- `apps/api/src/fleet/sync/event-payloads.ts` — `mirror` maps a valid `fixReady` into the patch.
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `FixReady` type; `FleetJobRecord` and `FleetJobPatch` gain `fixReady`.
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `toDomain` and `update` map `fixReady` (`Prisma.DbNull` for null).
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — the requeue reset adds `fixReady: null` next to `fixOutcome: null`.
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` — `FleetJobDto` gains nullable `fixReady`; the list variant keeps it.
- `openapi.json` — regenerated with `bun run generate` for `FleetJobDto.fixReady`.

**US-002**

- `apps/runner/src/verdict/fix-result.ts` — `readPushedSha` becomes `readFixState`; `FixOutcome` gains `fixReady`.
- `apps/runner/src/verdict/fix-result.spec.ts` — the `readPushedSha` cases move to `readFixState` and assert `pushedSha` on its result; every behaviour keeps its meaning.
- `apps/runner/src/executor/host-executor.ts` — `readFixOutcome` calls `readFixState` and returns `fixReady`.
- `apps/runner/src/executor/job-executor.ts` — the `FixOutcome` returned by `readFixOutcome` carries the optional `fixReady`.
- `apps/runner/test/unit/host-executor.spec.ts` — the `readFixOutcome` `toEqual` for a state file without ready fields expects `fixReady: null` as well.
- `apps/runner/src/supervisor/job-run.ts` — `judge` adds `fixReady` to the snapshot when present.
- `apps/runner/src/supervisor/job-run.spec.ts` — the FIX snapshot assertions that pin `{ fixOutcome, resultSha }` exactly gain `fixReady` where the fake outcome sets it; outcomes unchanged.

**US-003**

- `apps/api/prisma/schema.prisma` — new model `FleetPrRuling` with `onDelete: Cascade` relations to `FleetJob` and `Project`; back-relations on both.
- `apps/api/src/fleet/fleet.module.ts` — imports `FleetRulingsModule`.

**US-004**

- `apps/api/src/permissions/catalog.ts` — `NEW_KEY_SCOPES` gains `'fleet.job.rule': 'project'`.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — regenerated: one new `fleet.job.rule` cell per role, granted to owner, admin, project-admin and developer.
- `apps/api/src/permissions/role-matrix.spec.ts` — the per-row cell count 225 becomes 226.
- `apps/api/src/permissions/catalog.spec.ts` — its `NEW_KEY_SCOPES` mirror gains `'fleet.job.rule': 'project'`, so the key set equals the TSV keys plus the new-key list.
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — "collects exactly 129 gated routes" becomes 130 for the new `@ApprovalGated` ruling route.
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — `gatedOperations` gains the POST operation of the new ruling create route; the describe title and the AC-5 length 129 become 130.
- `apps/api/src/i18n/en/fleet.json` — adds `rulings.notDraft`, `rulings.notLatest`, `rulings.settled`, `rulings.unknownItem`, `rulings.invalidText`.
- `apps/api/src/i18n/zh/fleet.json` — the same keys in Chinese.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — adds the ruling create route happy path (201), an unparseable text case (400), and the ruling list route (200).
- `openapi.json` — regenerated for the two ruling routes and their DTOs.

**US-005**

- `apps/api/src/common/enums.ts` — `CommentType` gains `RULING: 'RULING'`.
- `apps/api/src/comments/dto/comment-response.dto.ts` — the `type` enum gains `RULING`.
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts` — gains `ensureFinishTicket(job, principal)`; the constructor appends `TicketsService` and `FleetTicketsService` as its last arguments.
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.spec.ts` — the six positional constructions append stubs for the two new arguments; assertions unchanged.
- `apps/api/src/fleet/tickets/prisma-fleet-tickets.repository.ts` — gains `createRulingComment(ticketId, body, principal)` and a `lockJobRow(jobId)` escape hatch.
- `apps/api/src/tickets/state-machine/ticket-transitions.service.ts` — the doc comment of `startForDispatch` names `FleetJobTicketEffects.ensureFinishTicket` as its second allowed caller; behaviour unchanged.
- `openapi.json` — regenerated for the comment type enum.

**US-006**

- `apps/api/prisma/schema.prisma` — `FleetJob` gains `prRulings Json?`.
- `apps/api/src/fleet/jobs/fleet-jobs.module.ts` — imports `FleetRulingsModule`.
- `apps/api/src/fleet/jobs/fleet-jobs.module.spec.ts` — module compile resolves `FleetPrRulingsService`.
- `apps/api/src/fleet/ingest/ingest.module.ts` — imports `FleetRulingsModule`.
- `apps/api/src/fleet/ingest/ingest.module.spec.ts` — module compile resolves `FleetPrRulingsService`.
- `apps/api/src/fleet/jobs/fleet-jobs.audit.spec.ts` — `FleetJobsService` gains a `FleetPrRulingsService` constructor argument; the positional construction passes a stub answering undefined; assertions unchanged.
- `apps/api/src/fleet/jobs/fleet-jobs.config-requeue.spec.ts` — same constructor argument; pass a stub; assertions unchanged.
- `apps/api/src/fleet/jobs/fleet-jobs.project-deletion.spec.ts` — same constructor argument; pass a stub; assertions unchanged.
- `apps/api/src/fleet/jobs/fleet-jobs.thread-handoff.spec.ts` — same constructor argument; pass a stub; assertions unchanged.
- `apps/api/src/fleet/jobs/fleet-jobs.thread-requeue.spec.ts` — same constructor argument; pass a stub; assertions unchanged.
- `apps/api/src/fleet/ingest/bundle-ingest.workflow.spec.ts` — `BundleIngestService` gains a `FleetPrRulingsService` constructor argument; the positional construction passes a stub whose `replaceOlderRuns` resolves; assertions unchanged.
- `apps/api/src/fleet/ingest/bundle-ingest.outcomes.spec.ts` — same constructor argument; pass a stub; assertions unchanged.
- `apps/api/src/fleet/ingest/bundle-ingest.pr-links.spec.ts` — same constructor argument; pass a stub; assertions unchanged.
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `FleetJobPrRulings`; `FleetJobRecord` and `NewFleetJob` gain `prRulings`.
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `createJob` and `toDomain` map `prRulings`.
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — FIX dispatch calls `snapshotForFix` before the insert transaction and stores `prRulings`.
- `apps/api/src/fleet/jobs/fleet-jobs.service.spec.ts` — the service fixtures provide a `FleetPrRulingsService` stub that answers undefined; existing assertions keep their meaning.
- `apps/api/src/vcs/types.ts` — `VcsPrStatus` gains `headSha?: string`.
- `apps/api/src/fleet/git-broker/github-app-client.ts` — `getPullRequest` maps `head.sha` to `headSha` when it is a string.
- `apps/api/src/fleet/git-broker/github-app-client.spec.ts` — the `getPullRequest` result assertion gains `headSha`.
- `apps/api/src/fleet/ingest/bundle-ingest.service.ts` — after a RUN's workflow with a PR is written, older RUN rulings of that PR become `replaced`.
- `apps/api/src/fleet/ingest/bundle-ingest.service.spec.ts` — the service fixture gains a `FleetPrRulingsService` stub; existing assertions keep their meaning.

**US-007**

- `packages/fleet-protocol/src/index.ts` — exports `CallerRuling`; `AssignPayload.review` gains `rulings?: { headSha: string; rulings: CallerRuling[] }`; `RunnerCapabilities` gains `botRulings?: true`; types only.
- `apps/api/src/fleet/jobs/assign-payload.ts` — a FIX with `prRulings.rulings` adds `review.rulings` without `rulingId`.
- `apps/api/src/fleet/jobs/placement-rules.ts` — `PlacementJob` gains `needsBotRulings`; `toPlacementJob` sets it from `prRulings`; `MisfitReason` gains `bot_rulings`; `capabilityMisfit` answers it.
- `apps/api/src/fleet/common/capabilities-core.ts` — parses `botRulings` (literal `true` or absent).
- `apps/api/src/fleet/dashboard/dashboard.types.ts` — the misfit reason list gains `bot_rulings`.
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` — the misfit enum gains `bot_rulings`.
- `openapi.json` — regenerated for the misfit enum.

**US-008**

- `apps/runner/src/supervisor/assign-parser.ts` — keeps a valid `review.rulings` for a FIX; refuses `rulings` on a REVIEW and malformed `rulings` as `bad('review')`.
- `apps/runner/src/supervisor/assign-parser.spec.ts` — existing FIX/REVIEW cases without `rulings` keep their results; new cases cover `rulings`.
- `apps/runner/src/executor/nax-process.ts` — `buildNaxArgv` opts gain `rulingsPath`; a FIX appends `--rulings <path>` after `--decisions`.
- `apps/runner/src/executor/nax-process.spec.ts` — the FIX argv `toEqual` cases keep their arrays when no `rulingsPath` is given; a new case covers `--rulings`.
- `apps/runner/src/executor/host-executor.ts` — `spawn` writes the rulings file for a FIX with `review.rulings` and passes `rulingsPath`; `ATTEMPT_FILES` gains `REVIEW_RULINGS_FILE`.
- `apps/runner/src/capabilities/nax-probe.ts` — `botRulings` probe and capability entry.
- `apps/runner/src/capabilities/nax-probe.spec.ts` — the fake nax CLI gains a `bot review --help` output with and without `--rulings`; existing `botReview`/`botFix` assertions unchanged.

**US-009**

- `apps/api/src/fleet/ingest/parsers/bot-review.parser.ts` — the `done` variant gains `callerRulings`.
- `apps/api/src/fleet/ingest/parsers/bot-review.parser.spec.ts` — existing `toEqual` assertions on a `done` parse of an artifact without `callerRulings` keep passing; new cases cover it.
- `apps/api/src/fleet/ingest/bundle-ingest.service.ts` — the FIX branch calls `recordResults` inside the ingest transaction.
- `apps/api/src/fleet/ingest/bundle-ingest.service.spec.ts` — the FIX branch fixture stubs `recordResults`; existing assertions keep their meaning.
- `apps/api/src/fleet/tickets/prisma-fleet-tickets.repository.ts` — `createSystemComment` takes an optional comment type (default `GENERAL`) so the summary is a `RULING` comment.

**US-010**

- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts` — `KODA_LIST_PR_RULINGS` joins the fleet read descriptors and `KODA_RULE_PR_ITEM` the fleet write descriptors.
- `apps/api/src/fleet/assistant/koda-tool-descriptors.spec.ts` — the catalog lengths 23 (REPO, PROJECT) and 24 (WORKSPACE) become 25 and 26; the WORKSPACE `.at(-1)` check changes from `koda_cancel_job` to `koda_rule_pr_item` (the new write descriptor is appended last to `FLEET_WRITE_TOOL_DESCRIPTORS`, the new read descriptor last to `FLEET_TOOL_DESCRIPTORS`); the slice before the write descriptors keeps `['koda_get_action','koda_add_comment']`; the fleet-write description phrase checks apply to `koda_rule_pr_item` unchanged.
- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.ts` — `MCP_DESCRIPTIONS` gains `koda_rule_pr_item`.
- `apps/api/src/fleet/assistant/assistant.module.ts` — imports `FleetRulingsModule` and lists the new tool group class.
- `apps/api/src/fleet/assistant/commands/assistant-tool-commands.ts` — constructor gains the new ruling tool group as an ordering dependency, like the four existing write-tool groups; behaviour unchanged.
- `apps/api/src/fleet/assistant/assistant.module.spec.ts` — "registers exactly nine write commands": `commandSamples` gains a `fleet.job.rule` sample (`{ jobId: 'j1', itemId: 'D-1', text: 'confirm: ok' }`) and the write-command set becomes ten; the descriptor-name check against `KODA_TOOL_DESCRIPTORS` gains both new names.
- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.spec.ts` — `WRITE_TOOLS` and `MCP_DESCRIPTION_TOOLS` gain `koda_rule_pr_item`, so the `MCP_DESCRIPTIONS` key-set equality holds at ten write tools.

**US-011**

- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` — the FIX outcome line gains the ready result and reply counts.
- `apps/web/components/CommentThread.vue` — the comment type union and pill map gain `RULING`.
- `apps/web/lib/fleet-types.ts` — `FleetJobDto` gains `fixReady`.
- `apps/web/i18n/locales/en.json` — `fleet.fixReady.*` and `comments.types.RULING`.
- `apps/web/i18n/locales/zh.json` — the same keys in Chinese.
- `apps/web/tests/pages/fleet-job-detail.spec.ts` — the job fixture gains `fixReady: null`; assertions unchanged.

**US-012**

- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` — renders `FleetJobOpenItems` for a RUN with a draft workflow.
- `apps/web/lib/fleet-types.ts` — `FleetPrRulingDto`; the misfit union gains `bot_rulings`.
- `apps/web/i18n/locales/en.json` — `fleet.rulings.*` and `fleet.misfit.bot_rulings`.
- `apps/web/i18n/locales/zh.json` — the same keys in Chinese.
- `apps/web/tests/pages/fleet-job-detail-workflow.spec.ts` — the page now also renders the open-items component for a draft; existing assertions keep their meaning.
- `apps/web/tests/i18n/fleet-locale-parity.spec.ts` — the `fleet.misfit` enum list gains `bot_rulings`; any new enum group under `fleet.rulings` (states, skip reasons) is added to `ENUMS` with its full value list.

**US-013**

- `apps/cli/src/commands/fleet-job.ts` — `showRows` adds a `Ready` row for a FIX; registers the rulings commands.
- `apps/cli/src/commands/fleet-job.spec.ts` — a closed-world `showRows` assertion gains the `Ready` row for FIX fixtures only.

### Seams

- US-001 -> US-002: the runner sends `fixReady` with the shape `mirror` accepts; a `readyHeld` longer than 500 characters is clipped by both.
- US-003 -> US-004, US-005: `FleetPrRulingsService.create` is the only writer of ruling rows; the route command (US-004) calls it and the ticket step (US-005) runs inside its transaction.
- US-003 -> US-006: `snapshotForFix` selects only `pending` rows; `replaced` is written by re-ruling (US-003) and by RUN ingest (US-006).
- US-006 -> US-007: `buildAssignPayload` reads `job.prRulings` exactly as US-006 stores it.
- US-007 -> US-008: `review.rulings` items carry exactly `{ item, ruling, by, at }`, which the runner writes unchanged into nax's file.
- US-006 -> US-009: `recordResults` maps items through `job.prRulings.rulings[].rulingId`, so only rulings sent with that FIX change.
- US-004 -> US-010, US-012, US-013: the tools call `FleetPrRulingsService.ruleTarget` and `create` directly from the tool's execute path as the actor (gated once by the assistant tool command adapter); the web form and the CLI go through the ruling route; none re-implements `parseRulingText`.
- API stories -> US-011, US-012: the web reads `fixReady`, the rulings list and the misfit reason from the API DTOs.

## Acceptance Criteria

### US-001: Store the fix ready result on a FIX job

- `[unit]` `mirror` of a snapshot with `fixReady: { markedReady: true, replied: 2, resolved: 1 }` returns a patch whose `fixReady` equals that object.
- `[unit]` `mirror` of a snapshot with `fixReady: { markedReady: false, readyHeld: 'CI failure: check:e2e' }` returns a patch whose `fixReady` keeps `readyHeld`.
- `[unit]` `mirror` of a snapshot whose `fixReady.markedReady` is the string `'yes'` returns a patch without `fixReady`.
- `[unit]` `mirror` of a snapshot whose `fixReady.replied` is `-1` returns a `fixReady` without `replied`.
- `[unit]` `mirror` of a snapshot whose `fixReady.readyHeld` is a number returns a `fixReady` without `readyHeld`.
- `[unit]` `mirror` of a `fixReady` whose `readyHeld` is 600 characters returns a `readyHeld` of 500 characters.
- `[unit]` `mirror` of a snapshot without `fixReady` returns a patch without the `fixReady` key, so an earlier value is kept.
- `[integration]` after a FIX job's snapshot with `fixReady: { markedReady: true }` is applied, `GET /projects/:slug/fleet/jobs/:id` answers `fixReady: { markedReady: true }`.
- `[integration]` `GET /projects/:slug/fleet/jobs/:id` of a RUN job answers `fixReady: null`.
- `[integration]` `POST /projects/:slug/fleet/jobs/:id/requeue` of a FIX job with a stored `fixReady` leaves the requeued job with `fixReady: null`.

### US-002: Runner reads the fix ready result

- `[unit]` `readFixState` of a `bot-state.json` with `pushedSha` of 40 hex, `markedReady: true`, `replied: 3`, `resolved: 2` returns `{ pushedSha, fixReady: { markedReady: true, replied: 3, resolved: 2 } }`.
- `[unit]` `readFixState` of a state with `markedReady: false` and `readyHeld: 'PR head changed since this execution'` returns that `readyHeld` in `fixReady`.
- `[unit]` `readFixState` of a state without `markedReady` returns `fixReady: null` and keeps a valid `pushedSha`.
- `[unit]` `readFixState` of a state whose `pushedSha` is not 40 hex returns `pushedSha: null`.
- `[unit]` `readFixState` of a missing `bot-state.json` returns null.
- `[unit]` `readFixState` of a `bot-state.json` holding invalid JSON returns null.
- `[unit]` `readFixState` of a `bot-state.json` that is a symlink returns null.
- `[unit]` `readFixState` of a state whose `readyHeld` is 600 characters returns a 500-character `readyHeld`.
- `[unit]` `JobRun.judge` for a FIX whose `readFixOutcome` answers `kind: 'nothing'` and `fixReady: { markedReady: true }` sends a snapshot with `fixOutcome: 'nothing'` and that `fixReady`.
- `[unit]` `JobRun.judge` for a FIX whose `readFixOutcome` answers `fixReady: null` sends a snapshot without a `fixReady` key.

### US-003: Ruling record, keyword parser and service

- `[unit]` `parseRulingText('confirm: read 4f2e1aa store.ts:88; test green')` returns `{ disposition: 'confirmed', reason: 'read 4f2e1aa store.ts:88; test green' }`.
- `[unit]` `parseRulingText('fixed 4f2e1aa — null check added')` returns `{ disposition: 'fixed', sha: '4f2e1aa', reason: 'null check added' }`.
- `[unit]` `parseRulingText('Waive: out of scope per spec section 3')` returns disposition `waived`.
- `[unit]` `parseRulingText('override: kept as is')` returns disposition `overridden`.
- `[unit]` `parseRulingText('verified')` returns disposition `verified` with reason `verified`.
- `[unit]` `parseRulingText('confirm')` returns null (the evidence rule).
- `[unit]` `parseRulingText('looks fine')` returns null.
- `[unit]` `parseRulingText('fixed xyz')` returns null.
- `[unit]` `parseRulingText('\n\nconfirm: ok\nmore evidence')` reads only the first non-empty line and returns disposition `confirmed` with reason `ok`.
- `[integration]` `create` with text `'\n\nconfirm: ok\nmore evidence'` stores the text `'confirm: ok\nmore evidence'`.
- `[integration]` `FleetPrRulingsService.create(agentPrincipal, runJobId, { itemId: 'D-1', text: 'confirm: test green' })` stores one `FleetPrRuling` with state `pending`, disposition `confirmed`, actor type `AGENT`, and the RUN's `repoId` and PR number.
- `[integration]` a second `create` on the same job and item leaves the first ruling `replaced` and the second `pending`.
- `[integration]` `create` writes one audit entry with key `fleet.job.rule`, the job id and the actor.

### US-004: Ruling routes and permission

- `[integration]` `POST /projects/:slug/fleet/jobs/:id/rulings` by a developer agent on a RUN with workflow outcome `draft` and open item `D-1`, body `{ itemId: 'D-1', text: 'confirm: test green' }`, answers 201 with a ruling in state `pending`, disposition `confirmed`.
- `[integration]` the same POST on a RUN whose workflow outcome is `ready` answers 409 and opens no approval request.
- `[integration]` the same POST with `itemId: 'Z-9'` not in the open items answers 404 and opens no approval request.
- `[integration]` the same POST with `text: 'looks fine'` answers 400 naming `text`.
- `[integration]` the same POST for a job id of another project answers 404.
- `[integration]` the same POST by a project member holding the viewer role, on a RUN whose outcome is `ready`, answers 403 (not 409).
- `[integration]` the same POST on a RUN that is not the latest RUN of its PR answers 409 and opens no approval request.
- `[integration]` the same POST on an item whose latest ruling is `applied` answers 409.
- `[integration]` with a project approval policy `{ permissionPattern: 'fleet.job.rule', appliesTo: { kind: 'type', principalType: 'AGENT' }, mode: 'human' }`, the agent's POST answers 202 with an approval request and no ruling row exists.
- `[integration]` after a user approves that request, one `pending` ruling by the agent exists.
- `[integration]` when the RUN's workflow outcome changes to `ready` before a user approves that request, the approval execution fails and no ruling row exists.
- `[integration]` `GET /projects/:slug/fleet/jobs/:id/rulings` answers every ruling of the job, newest first, including `replaced` ones.
- `[unit]` the permission catalog entry for `fleet.job.rule` has scope `project`, is approvable, and has floor `none` and default `none`.

### US-005: Post every ruling on the work's ticket

- `[unit]` `CommentType.RULING` imported from `common/enums` equals `'RULING'`.
- `[integration]` the first ruling through `POST /projects/:slug/fleet/jobs/:id/rulings` on a RUN with no linked ticket creates one TASK ticket titled `Finish draft PR #<n> (<feature>)` with status `IN_PROGRESS`, linked to the RUN through `FleetJobTicket`.
- `[integration]` that new ticket has a fleet `TicketLink` of type `pr` with the PR's number and URL.
- `[integration]` the ruling writes one `RULING` comment on the ticket, authored by the ruling agent (`authorAgentId`), with body `D-1 (advisor): confirm: test green`, and the ruling's `commentId` is that comment's id.
- `[integration]` a second ruling on the same RUN adds a comment to the same ticket and creates no second ticket.
- `[integration]` a ruling on a RUN that already links two open tickets comments on the ticket whose link is oldest.
- `[integration]` a ruling on a RUN whose only linked ticket is `CLOSED` creates a new finish ticket.
- `[integration]` two concurrent first rulings on one RUN leave exactly one finish ticket.
- `[integration]` `PATCH` of a `RULING` comment answers 409 `comments.workflowImmutable`.
- `[integration]` when the comment insert fails, no ruling row, no ticket and no `FleetJobTicket` row remain.
- `[unit]` when `TicketsService.create` throws the ticket-number conflict, `FleetPrRulingsService.create` rethrows it as a 409 and writes no ruling.
- `[integration]` after `VcsPrSyncService.applyMergedPr` is called with the finish ticket's fleet PR link and a merged PR status (the path `FleetPrStateRefresher` takes), the finish ticket moves from `IN_PROGRESS` to `VERIFY_FIX`.

### US-006: Snapshot the pending rulings at FIX dispatch

- `[unit]` `GitHubAppClient.getPullRequest` maps a response whose `head.sha` is a string to `headSha` on the result.
- `[unit]` `snapshotForFix` for a PR whose latest RUN has two `pending` rulings and an open PR with a 40-hex head returns `{ headSha, rulings }` with both rulings as `{ rulingId, item, ruling, by, at }`.
- `[unit]` `snapshotForFix` ignores `pending` rulings of an older RUN of the same PR.
- `[unit]` `snapshotForFix` with no `pending` rulings returns undefined.
- `[unit]` `snapshotForFix` when `getPullRequest` throws returns `{ notSent: 'head-unreadable' }`.
- `[unit]` `snapshotForFix` when `getPullRequest` answers a closed PR returns `{ notSent: 'pr-not-open' }`.
- `[unit]` the `by` of a ruling by agent `rev-bot` is `koda:agent:rev-bot`.
- `[unit]` the `by` of a ruling by a user whose name has a newline and 120 characters is one line of at most 100 characters starting with `koda:user:`.
- `[integration]` `POST /projects/:slug/fleet/jobs` with `{ command: 'FIX', prNumber }` for a PR whose latest RUN has a `pending` ruling, with `getPullRequest` stubbed to an open PR, stores `prRulings` with that ruling and the stubbed `headSha` on the new job.
- `[integration]` a REVIEW dispatch for the same PR stores no `prRulings`.
- `[integration]` a FIX dispatch for that PR with `getPullRequest` stubbed to throw is accepted and stores `prRulings: { notSent: 'head-unreadable' }`.
- `[integration]` when a newer RUN's bundle for the same PR is ingested with a workflow, the older RUN's `pending` rulings become `replaced`.
- `[integration]` that ingest leaves the older RUN's `applied` rulings `applied`.

### US-007: Carry rulings in the assign payload and placement

- `[unit]` `buildAssignPayload` for a FIX whose `prRulings` has rulings returns `review.rulings` equal to `{ headSha, rulings: [{ item, ruling, by, at }] }` with no `rulingId`.
- `[unit]` `buildAssignPayload` for a FIX whose `prRulings` is `{ notSent: 'head-unreadable' }` returns a `review` without `rulings`.
- `[unit]` `toPlacementJob` of a FIX whose `prRulings.rulings` is non-empty sets `needsBotRulings: true`.
- `[unit]` `firstMisfit` for a job with `needsBotRulings` on an online runner with `botReview` and `botFix` but no `botRulings` returns `bot_rulings`.
- `[unit]` `firstMisfit` for the same job on a runner with `botRulings: true` returns null.
- `[unit]` `firstMisfit` for a FIX without `needsBotRulings` on a runner without `botRulings` returns null.
- `[integration]` `PlacementService.placeJob` for a queued FIX with rulings, when the only runner lacks `botRulings`, leaves the job `QUEUED` with misfit `bot_rulings`.
- `[unit]` the capability parser keeps `botRulings: true`.
- `[unit]` the capability parser refuses a report whose `botRulings` is `'yes'`.

### US-008: Runner passes rulings to nax

- `[unit]` `parseAssign` of a FIX payload whose `review.rulings` is valid returns an assign whose `review.rulings` equals it.
- `[unit]` `parseAssign` of a REVIEW payload carrying `review.rulings` answers `bad('review')`.
- `[unit]` `parseAssign` of a FIX payload with a ruling whose `by` contains a newline answers `bad('review')`.
- `[unit]` `writeReviewRulings(jobDir, { headSha, rulings })` writes `review-rulings.json` containing `{ version: 1, headSha, rulings }` with file mode 0600 and returns its path.
- `[unit]` `buildNaxArgv` for a FIX with `decisionsPath` and `rulingsPath` returns `[..., 'bot', 'review', '4', '--full', '--profile', <chain>, '--decisions', <decisions>, '--rulings', <rulings>]`.
- `[unit]` `buildNaxArgv` for a REVIEW given a `rulingsPath` returns an argv without `--rulings`.
- `[unit]` `buildNaxArgv` for a FIX without `rulingsPath` returns the same argv as before this feature.
- `[unit]` `HostExecutor.spawn` of a FIX whose `assign.review.rulings` has one ruling spawns nax with `--rulings` pointing at the job dir's `review-rulings.json`.
- `[unit]` `HostExecutor.spawn` of a FIX whose `assign.review` has no `rulings` writes no rulings file and passes no `--rulings`.
- `[unit]` the per-attempt wipe removes `review-rulings.json` from the job dir.
- `[unit]` the nax probe reports `botRulings: true` when `bot review --help` lists `--rulings` and `botReview` passed.

### US-009: Record what nax did with the rulings

- `[unit]` `parseBotReview` of an artifact with `callerRulings: { applied: [{ item: 'D-1', disposition: 'confirmed' }], skipped: [{ item: 'G-1', reason: 'superseded-by-writer' }] }` returns `callerRulings` with both lists.
- `[unit]` `parseBotReview` drops an `ignored` value other than `untrusted-pr` or `head-mismatch`.
- `[unit]` `parseBotReview` of an artifact without `callerRulings` returns a `done` parse without the `callerRulings` key.
- `[unit]` `recordResults` for a FIX that sent D-1 and G-1, with D-1 applied and G-1 skipped `superseded-by-writer`, marks D-1 `applied` and G-1 `skipped` with that `skipReason`, both with `appliedJobId` = the FIX id.
- `[unit]` `recordResults` with G-1 skipped `echo-failed` leaves G-1 `pending`.
- `[unit]` `recordResults` with `ignored: 'untrusted-pr'` marks every sent ruling `skipped` with `untrusted-pr`.
- `[unit]` `recordResults` with `ignored: 'head-mismatch'` changes no ruling.
- `[unit]` `recordResults` for a parse without `callerRulings` changes no ruling.
- `[unit]` `recordResults` with G-1 skipped `recorder-failed` leaves G-1 `pending`.
- `[unit]` `recordResults` never changes a ruling that is no longer `pending` (re-ruled to `replaced` while the FIX ran).
- `[integration]` ingesting a COMPLETED FIX bundle whose `bot-review.json` applies D-1 writes one system `RULING` comment on the RUN's ticket reading `Finish <jobId>: applied D-1 (confirmed)`.
- `[integration]` ingesting a FIX bundle whose rulings all stay `pending` writes no summary comment.
- `[integration]` after a FIX of PR 12 is ingested with `fixReady.markedReady: true`, the ticket of the RUN whose `resultPrUrl` is PR 12 has one system comment `PR #12 marked ready by FIX <jobId>` and keeps status `IN_PROGRESS`.
- `[integration]` re-ingesting the same FIX bundle writes no second marked-ready comment.

### US-010: Assistant and MCP tools for rulings

- `[unit]` `koda_list_pr_rulings` with `{ jobId }` returns one line per ruling with item, disposition, state and actor, and its tool key is `fleet.job.read`.
- `[unit]` `koda_rule_pr_item` parse of `{ jobId, itemId: 'D-1', text: 'confirm' }` throws `ToolInputError` naming `text`.
- `[unit]` `koda_rule_pr_item` preview of `{ jobId, itemId: 'D-1', text: 'confirm: test green' }` names the job, the item and the disposition `confirmed`, and its tool key is `fleet.job.rule` with kind `write`.
- `[integration]` executing `koda_rule_pr_item` as an agent on a draft RUN creates a `pending` ruling and a `RULING` ticket comment, the same as `POST /projects/:slug/fleet/jobs/:id/rulings`.
- `[integration]` executing `koda_rule_pr_item` on an item that is not open answers the tool error `unknown item` and creates no ruling.
- `[unit]` `kodaToolDescriptorsFor('PROJECT')` includes `koda_list_pr_rulings` and `koda_rule_pr_item`.
- `[unit]` `kodaToolDescriptorsFor('WORKSPACE')` adds the `project` argument to `koda_rule_pr_item`.
- `[unit]` the MCP catalog description of `koda_rule_pr_item` ends with the MCP project sentence shared by the other write tools.

### US-011: Web shows the fix ready result and ruling comments

- `[unit]` the FIX job page with `fixReady: { markedReady: true, replied: 2, resolved: 1 }` renders the translated `fleet.fixReady.markedReady` text with `2` replies and `1` resolved.
- `[unit]` the FIX job page with `fixReady: { markedReady: false, readyHeld: 'CI failure: check:e2e' }` renders the translated `fleet.fixReady.held` text followed by `CI failure: check:e2e`.
- `[unit]` the FIX job page with `fixReady: null` renders no ready line.
- `[unit]` a RUN job page renders no ready line even when `fixReady` is set.
- `[unit]` `CommentThread` renders a `RULING` comment with the translated `comments.types.RULING` label.
- `[unit]` `CommentThread` renders no edit control for a `RULING` comment authored by the viewer.

### US-012: Web open items, rulings and Finish

- `[unit]` `useFleetRulings(slug).list(jobId)` calls `GET` `/projects/<slug>/fleet/jobs/<jobId>/rulings` through `useApi()` and returns the unwrapped list.
- `[unit]` `useFleetRulings(slug).create(jobId, { itemId: 'D-1', text: 'confirm: ok' })` posts that body to `/projects/<slug>/fleet/jobs/<jobId>/rulings`.
- `[unit]` `FleetJobOpenItems` for a draft workflow with items `D-1` and `B3` renders one row per item with its id, kind, issue and `file:line`.
- `[unit]` a row whose item's latest ruling is `pending` shows its disposition, the ruler and the translated `pending` state.
- `[unit]` a row whose item's latest ruling is `skipped` shows the translated skip reason.
- `[unit]` with `fleet.job.rule` granted, submitting a row's form with keyword `waive` and reason `out of scope` calls `create` with `text: 'waive: out of scope'`.
- `[unit]` submitting keyword `confirm` with an empty reason shows the translated validation error and calls no API.
- `[unit]` without `fleet.job.rule`, no row renders a ruling form.
- `[unit]` a `create` answering 202 shows the translated pending-approval toast.
- `[unit]` a `create` answering 409 shows `extractApiError` of the response.
- `[unit]` with `fleet.job.dispatch` granted, the Finish button calls `useFleetJobs(slug).dispatch` with `command: 'FIX'`, `prNumber: 12` and the job's repo for a RUN whose `resultPrUrl` is PR 12.
- `[unit]` without `fleet.job.dispatch`, the Finish button is not rendered.
- `[unit]` the job page renders no `FleetJobOpenItems` for a RUN whose workflow outcome is `ready`.
- `[unit]` a queued job with misfit `bot_rulings` renders the translated `fleet.misfit.bot_rulings` text.

### US-013: CLI ready result and ruling commands

- `[cli]` `koda fleet job show <id>` for a FIX with `fixReady: { markedReady: true, replied: 2, resolved: 1 }` prints a `Ready` row reading `marked ready (replied 2, resolved 1)`.
- `[cli]` `koda fleet job show <id>` for a FIX with `fixReady: { markedReady: false, readyHeld: 'CI failure: x' }` prints a `Ready` row reading `kept as draft: CI failure: x`.
- `[cli]` `koda fleet job show <id>` for a RUN prints no `Ready` row.
- `[cli]` `koda fleet job rulings <jobId>` prints a table of item, disposition, state, actor and skip reason.
- `[cli]` `koda fleet job rulings <jobId> --json` prints the list as JSON.
- `[cli]` `koda fleet job rule <jobId> D-1 'confirm: test green'` calls the generated create-ruling client with `{ itemId: 'D-1', text: 'confirm: test green' }`, prints the ruling id and exits 0.
- `[cli]` `koda fleet job rule` answered 400 exits 3 and prints the API message to stderr.
- `[cli]` `koda fleet job rule` answered 202 exits 5 and prints the approval request id.
- `[cli]` `koda fleet job rule` answered 404 exits 4.
- `[cli]` `koda fleet job rule` answered 403 exits 2.
- `[cli]` `koda fleet job rule <jobId> D-1 ''` exits 3 before any API call.
