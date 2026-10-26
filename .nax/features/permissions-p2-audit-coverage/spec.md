# SPEC: Permissions P2l — Audit Coverage Guard and Walker

## Summary

This feature closes P2 with the two checks that keep the audit trail complete:
- **A runtime coverage guard.** Every entry point (an HTTP request, a `runAsSystem` run, a `runAsSystemWriter` run) opens an audit scope. The Prisma write guard counts each write the scope makes that changed a row, and `AuditRecorder.record` counts each entry; both counts of a transaction that rolls back are dropped. When a scope ends having written but recorded nothing, the guard throws `UnauditedWriteError` in development and test, and logs an error in production.
- **Two reasoned exemptions.** A write that is bookkeeping by design runs inside `bookkeeping('<reason id>', …)`, and the guard does not count it. An entry point that only ever writes bookkeeping is on `UNAUDITED_SURFACES` with its reason. The reason ids and the surfaces come from the Bookkeeping tables of the six audit features.
- **A walker test over the live surfaces.** It boots the API, collects every route, system writer and system component id, and checks that every `UNAUDITED_SURFACES` entry names a live write surface with a reason. Every other write surface is audited by default, and the guard holds it to that whenever a test reaches it.
- **Logout records.** `POST /auth/logout` records `session.logout`. Login and refresh write no row, so they record nothing.

This is the last of twelve features implementing phase P2 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§5 "Action context and audit"). The order: context, context-guard, audit-entry, audit-core, audit-fleet-routes, audit-fleet-ops, audit-fleet-system, web, audit-vcs-ci, audit-knowledge, audit-delivery, **audit-coverage**.

## Motivation

The eleven earlier P2 features made every domain writer record an `AuditEntry` (`permissions-p2-audit-delivery`, PR #336, deployed `4592d038` on 2026-10-26, was the last writer feature). Nothing stops the next route, tool or system writer from writing without an entry: the context guard (`permissions-p2-context-guard`) only refuses a write with no actor, and an audited actor that forgets `AuditRecorder.record` is silent. The design ends P2 with "the coverage test walks the write rows so none are left" (§5), and the scoping ruling makes that two checks.

**Rulings that bind this feature** (user, 2026-10-24):
- **Coverage is a runtime guard plus a walker test.** The guard throws in development and test when a request, tool call or system run commits a domain write with no `AuditEntry`; the walker test proves every write surface is audited or on a reasoned allowlist.
- **The walker uses the live surfaces, not the inventory TSV.** `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` is stale; the walker reads the booted app, as the P1 permission contract test does.
- **Keep the design approach.** The command layer writes `AuditEntry` in the domain write's transaction; the guard checks that, it does not replace it.
- **Strict in tests, never an outage in production.** The same split as the context guard: throw in development and test, log an error in production.

The user skipped the design questions for the integrations split ("skip questions and proceed", 2026-10-25) and asked to proceed with this feature on 2026-10-26. Every call below that is not in the rulings or the design is the designer's.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **The unit of coverage is the entry-point scope, not the transaction.** A scope passes when it wrote nothing it counts, or recorded at least one entry. Checking each write against an entry of its own would need every write mapped to a key; the earlier features record one entry per action, not per row (a ticket create writes the ticket, its event and outbox rows, and records one `ticket.create`). The guard therefore catches an entry point that forgot to record at all, which is the gap the context guard leaves; a scope that records one entry and also makes a second, unaudited domain write is out of scope.
- **Three entry points open a scope; nothing else does.** `ActionContextInterceptor` opens one per HTTP request, `runAsSystem` one per run, and `runAsSystemWriter` one per run (it calls `runAsSystem`). `runWithActionContext`, `runWithActor` and the test helper `withTestActor` open none, so a test that calls a service or a repository directly to build fixtures is not checked, and neither is any code that runs with no scope. The guard checks production entry points; the integration and e2e suites reach them through HTTP and through the ticks and subscribers they call.
- **Nested scopes.** A scope opened inside another (a `runAsSystem('vcs', …)` inside the GitHub webhook request, `runAsSystem('schedule', () => record(…))` inside the schedule tick) is a child. A counted write goes to the innermost open scope. A recorded entry counts in the innermost scope and in every enclosing scope. So a tick whose entry is recorded in a nested record-only scope passes, and the record-only scope itself wrote nothing. A detached scope (`{ detached: true }`) has no parent: its entries count only in itself, and nothing it records can satisfy the request or tick that started it.
- **The check runs when the scope's work succeeds.** `runAsSystem` checks after its function's promise fulfils (immediately for a synchronous return); a rejection or a throw skips the check and propagates unchanged, because the transaction rolled back or the caller already sees an error. The interceptor checks once, when the handler's observable completes, before the completion is forwarded: Nest answers a route with the observable's last value only on completion, so an unaudited request answers 500 in development and test. A handler that errors skips the check. A server-sent-events route completes when the client disconnects; it is checked then, and its reads write nothing.
- **What counts as a write: an operation that changed a row.** An operation in `GUARDED_OPERATIONS` (the context guard's set) on any model except `AuditEntry`, made while no `bookkeeping` call is running, counts once it resolves and only if it changed something: `create`, `update`, `upsert` and `delete` always; `createMany`, `updateMany` and `deleteMany` when the result's `count` is above 0; `createManyAndReturn` and `updateManyAndReturn` when the returned array is not empty; `$executeRaw` and `$executeRawUnsafe` when the returned number is above 0. The earlier features record nothing for a write that finds nothing to do (a purge of 0 rows, a claim that loses, an idempotent repeat), and a zero-row write changed nothing to audit. The label is `<Model>.<operation>`, or the operation alone for a raw execute. A write that rejects is not counted.
- **A rolled-back transaction leaves no count.** `PrismaTransactionManager.run` (`@nathapp/nestjs-prisma`) opens the outermost transaction with `$transaction(async (tx) => …)` on the API's client, and joins it for nested runs. `KodaPrismaClient` wraps that interactive form in `withTransactionTally`: the writes and entries noted inside the callback are held, added to the current scope (entries also to its parents) when `$transaction` resolves, and dropped when it rejects. So a system writer that catches a rejected `record` (the rollback specs of every audit feature) leaves neither the rolled-back write nor the rolled-back entry. The array form of `$transaction` passes through unchanged.
- **Bookkeeping is marked at the write, narrowly.** `bookkeeping(reason, fn)` wraps the exact call that makes a bookkeeping write, never a method that also makes domain writes: a domain write inside a bookkeeping call is not counted, so a broad wrap would hide the next missing entry. The reason id is a key of `BOOKKEEPING_REASONS`, a code catalogue in `src/action-context/audit-coverage.reasons.ts` with one sentence per id, so the type checker refuses a typo and a reviewer reads the reason next to the id. Some rows wrap a whole method body (`FenceService.abandon`, `PlacementService.assign`, `LogUploadService.write`, `BundleIngestService.recordFailure`, `ScheduleTicker.linkDispatched`, `PrismaAssistantToolCallRepository.record`, `AssistantActionDecisions.finalize`, `EmailTemplateSeeder.seed`, `WebhookReplayGuard.forget`, and `PrismaThreadIngestRepository.fold`'s transaction body), each because every write in it is bookkeeping. Most make one or two writes. Three are broad by design: `fold` (the transcript, its cost mirror rows and session fields; the `turn_end` entry still counts, since only writes are uncounted), `assign` (the lease and ASSIGN of a job whose dispatch already recorded `fleet.job.dispatch`) and `seed` (built-in templates).
- **An unaudited surface is a whole entry point that only writes bookkeeping.** `UNAUDITED_SURFACES` (`src/action-context/audit-coverage.allowlist.ts`) maps a surface label to its reason. The labels: `<METHOD> /<path>` for a route, exactly as the permission contract test prints it (`POST /me/notifications/read-all`); `writer:<ClassName>` for a `runAsSystemWriter` run; `system:<id>` for a `runAsSystem` run. A scope on the list is not checked. A surface that writes both kinds stays off the list and marks its bookkeeping calls.
- **Mirrored run facts are bookkeeping.** `JobReportProcessor` copies what the runner reports about its run onto the job (`mirror(p)`, `event-payloads.ts:98-120`), including the result PR url and finish result. They are facts the runner observed, not a decision anyone made; the transition that moves the job to its terminal state records `runner.sync`, and the job's outcome is read from those fields under that entry.
- **The module graph.** `action-context.ts` imports `audit-coverage.ts`, which imports `resolveWriteGuardMode` from `contextless-write.ts`, which imports `action-context.ts`. Every use across that cycle is inside a function body, so module evaluation order does not matter; no top-level statement may read an import of the cycle.
- **Timers inherit the scope.** A timer started inside a scope (`BudgetEvaluator.signal`'s debounce, `budget-evaluator.ts:55-66`) runs in that scope's async context, after it may have closed. That is safe only where the timer's work commits its writes and its entry in one transaction, as the budget evaluation does; new timer work follows the detached-scope pattern.
- **The guard's mode is the context guard's.** `resolveWriteGuardMode({ ENV_NAME, NODE_ENV })` answers `record` in production and `throw` elsewhere. `throw` raises `UnauditedWriteError`; `record` logs `unaudited write: <surface> wrote <labels> and recorded no audit entry` through `new Logger(UnauditedWriteError.name).error` and returns. There is no switch to turn the guard off.
- **The context guard's production fallback is not checked again.** In production a context-less write runs inside `runAsSystem('unknown', …)`, which now opens a scope; `system:unknown` is on `UNAUDITED_SURFACES`, because that write already logged `ContextlessWriteError`.
- **The outbox fan-out root is an unaudited surface.** `FanOutPublisher.publish` runs each handler inside `runAsSystem('outbox', …)`. The handlers that write only bookkeeping (notification rows and watchers, the KB ticket index, the entity graph projection, the webhook send) run there with no scope of their own; the handlers that record (memory extraction, the code-intel index) open `runAsSystemWriter` scopes, which are checked. `system:outbox` is on the list with that reason. A future outbox handler that makes a domain write must open its own writer scope; that is a review rule, not a check.
- **`withTestActor` stops opening a scope for a SYSTEM actor.** It runs a SYSTEM actor through `runAsSystem` today, which would now check fixture writes. It keeps refusing an id outside `SYSTEM_ACTOR_IDS`, then runs `runWithActionContext({ actor, origin: 'system' }, fn)`.
- **Logout records; login and refresh do not.** `AuthService.logout` bumps `User.tokenVersion`, a write that revokes every session of the caller. It records `session.logout` on `user` (the caller's id, `projectId` `null`, summary `logged out`) through `audited` around `bumpTokenVersion`; the cache invalidation stays after it. `login` and `refresh` only sign tokens and write no row, so the guard has nothing to check; auditing a sign-in, and a failed one, is a security-log concern out of scope.
- **The walker checks the allowlist; the guard checks everything else.** The walker cannot tell from metadata whether a route records. It checks what metadata can prove: every `UNAUDITED_SURFACES` label names a live write surface (a non-`GET` route, a system writer class, a system actor id), and every reason is a non-empty sentence. Every write surface not on the list is audited by default, and the guard fails any test that reaches it and finds no entry. A write surface no test reaches is out of scope.

### Integration

Read-only symbols (verified at `4592d038`):
- `GUARDED_OPERATIONS`, `ContextlessWriteError`, `resolveWriteGuardMode(env)`, `WriteGuardMode` — `src/action-context/contextless-write.ts`.
- `currentContext()`, `runWithActionContext(input, fn)`, `SYSTEM_ACTOR_IDS` — `src/action-context/action-context.ts`.
- `collectPermissionDeclarations(modules, registry)`, `PermissionDeclarations`, `RouteDeclaration.route` (`"<METHOD> /<path>"`), `SystemWriterDeclaration.writer` (the class name) — `src/permissions/test-helpers/permission-contract.ts`.
- `SYSTEM_WRITER_METADATA` — `src/permissions/system-writer.decorator.ts`.
- `bootHttpApp(opts)` — `test/helpers/http-app.ts`; `resetDb()` — `test/helpers/reset-db.ts`; `canRunDbTests()` — `test/helpers/test-environment.ts`.
- `AuthService.logout(userId)` callers: `AuthController.logout` (`POST /auth/logout`, `@Requires('session.logout')`).

Changed symbols. The baseline exists only to locate the code; the target is the interface to implement.
- `contextlessWriteHandler(mode)` — `src/action-context/contextless-write.ts`.
  - Baseline: an in-context guarded operation returns `await query(args)`.
  - Target: an in-context guarded operation awaits `query(args)`, then calls `noteAuditWrite(model === undefined ? operation : \`${model}.${operation}\`)` when `model` is not `'AuditEntry'` and the result changed a row ("What counts as a write"), then returns the result. The context-less paths are unchanged.
- `AuditRecorder.record(input)` — `src/audit/audit-recorder.service.ts`.
  - Baseline: validates the key and the transaction, then `await this.storage.record(…)`.
  - Target: the same, then `noteAuditEntry()` after `storage.record` resolves.
- `runAsSystem(component, fn, opts?)` — `src/action-context/action-context.ts`.
  - Baseline: `opts?: { onBehalfOf?; correlationId? }`; runs `runWithActionContext(input, fn)`.
  - Target: `opts?: { onBehalfOf?; correlationId?; surface?: string }`; runs `runWithActionContext(input, () => runInAuditScope(opts?.surface ?? \`system:${component}\`, fn))`.
- `runAsSystemWriter(writer, fn)` — the same file.
  - Baseline: `runAsSystem(key.split('.')[1], fn)`.
  - Target: `runAsSystem(key.split('.')[1], fn, { surface: \`writer:${writer.constructor.name}\` })`.
- `KodaPrismaClient` constructor — `src/prisma/koda-prisma-client.ts`.
  - Baseline: returns `this.$extends(contextlessWriteExtension(mode))`.
  - Target: returns that extended client with its `$transaction` replaced: a function first argument runs as `withTransactionTally(() => fn(tx))` inside the original interactive `$transaction` (same options); an array argument calls the original unchanged.
- `ActionContextInterceptor.intercept(ctx, next)` — `src/action-context/action-context.interceptor.ts`.
  - Baseline: `runWithActionContext({ actor, origin }, () => next.handle().subscribe(subscriber))`.
  - Target: computes `routeSurface(ctx.getClass(), ctx.getHandler())`; when it is `undefined`, behaves as the baseline; otherwise opens an audit scope with that label around the subscription, forwards every value and error unchanged, and runs `assertAuditCoverage(scope)` once when the handler completes, forwarding its `UnauditedWriteError` (mode `throw`) as the error instead of the completion.
- `collectControllerRoutes(controller)` — `src/permissions/test-helpers/permission-contract.ts`.
  - Baseline: builds `\`${methodName(method)} ${joinRoutePath(classPath, handlerPath)}\`` with file-local helpers.
  - Target: calls `routeSurface(controller, handler)` from `src/permissions/route-surface.ts`, which owns `joinRoutePath` and `methodName`; the printed strings are unchanged.
- `withTestActor(actor, fn)` — `test/helpers/action-context.ts`.
  - Baseline: a SYSTEM actor runs `runAsSystem(actor.id, async () => await fn())`.
  - Target: a SYSTEM actor whose id is not in `SYSTEM_ACTOR_IDS` rejects with `unknown system actor id: <id>`; otherwise it runs `runWithActionContext({ actor, origin: 'system' }, async () => await fn())`.
- `AuthService.logout(userId)` — `src/auth/auth.service.ts`.
  - Baseline: `bumpTokenVersion(userId)`, then two cache invalidations.
  - Target: `this.audit.audited(() => this.authRepo.bumpTokenVersion(userId), () => ({ key: 'session.logout', resourceType: 'user', resourceId: userId, projectId: null, summary: 'logged out' }))`, then the same invalidations.

### New module: `src/action-context/audit-coverage.ts`

```ts
export class UnauditedWriteError extends Error {
  readonly name = 'UnauditedWriteError';
  constructor(readonly surface: string, readonly writes: readonly string[]) {
    super(`unaudited write: ${surface} wrote ${writes.join(', ')} and recorded no audit entry`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A read-only view of one entry point's tally; only audit-coverage.ts changes it, through noteAuditWrite / noteAuditEntry. */
export interface AuditScope {
  readonly surface: string;
  readonly parent: AuditScope | undefined;
  /** Every counted write label, in order. */
  readonly writes: readonly string[];
  readonly entries: number;
}

export function currentAuditScope(): AuditScope | undefined;
/** Runs fn with a new child scope of the current one as current; does not check it. */
export function openAuditScope<T>(surface: string, fn: (scope: AuditScope) => T, opts?: { detached?: boolean }): T;
/** openAuditScope, then assertAuditCoverage after fn's promise fulfils (immediately for a non-thenable). */
export function runInAuditScope<T>(surface: string, fn: () => T, opts?: { detached?: boolean }): T;
/** Holds the writes and entries noted while fn runs; adds them to the current scope when fn fulfils, drops them when it rejects. */
export function withTransactionTally<T>(fn: () => Promise<T>): Promise<T>;
/** Counts a write in the innermost scope; a no-op with no scope or inside bookkeeping(). */
export function noteAuditWrite(label: string): void;
/** Counts an entry in the innermost scope and every enclosing one; a no-op with no scope. */
export function noteAuditEntry(): void;
/** Throws UnauditedWriteError (mode 'throw') or logs it (mode 'record') when the scope's writes are not empty, its entries are 0 and it is not on UNAUDITED_SURFACES. */
export function assertAuditCoverage(scope: AuditScope, mode?: WriteGuardMode): void;
/** Runs and awaits fn with writes uncounted; refuses an id outside BOOKKEEPING_REASONS before running fn. */
export function bookkeeping<T>(reason: BookkeepingReason, fn: () => T | PromiseLike<T>): Promise<T>;
export function currentBookkeepingReason(): BookkeepingReason | undefined;
```

Prisma promises are lazy: the query runs when the promise is awaited, not when the call returns. So `bookkeeping` awaits `fn()` inside its own storage (`storage.run(reason, async () => await fn())`), and `runInAuditScope` awaits a thenable result inside the scope's storage before checking; a non-thenable result is checked at once and returned as is.

`mode` defaults to `resolveWriteGuardMode({ ENV_NAME: process.env['ENV_NAME'], NODE_ENV: process.env['NODE_ENV'] })`, read at each call. The scope and the bookkeeping reason each live in their own `AsyncLocalStorage`, separate from the action context's, so `runWithActionContext` does not need to copy them.

`src/action-context/audit-coverage.reasons.ts` exports `BOOKKEEPING_REASONS` (`as const`, id to one sentence) and `type BookkeepingReason = keyof typeof BOOKKEEPING_REASONS`. `src/action-context/audit-coverage.allowlist.ts` exports `UNAUDITED_SURFACES: ReadonlyMap<string, string>`. Their contents are the tables below.

`src/permissions/route-surface.ts` exports `routeSurface(controller: Function, handler: Function): string | undefined`: `undefined` when the handler has no `METHOD_METADATA`, else `"<METHOD> /<controller path>/<handler path>"` joined without duplicated separators.

`src/action-context/test-helpers/audit-coverage-contract.ts` exports:

```ts
export type CoverageViolation =
  | { kind: 'stale-surface'; surface: string }
  | { kind: 'read-route-allowlisted'; surface: string }
  | { kind: 'empty-reason'; surface: string };

export function findCoverageViolations(
  declarations: PermissionDeclarations,
  allowlist: ReadonlyMap<string, string> = UNAUDITED_SURFACES,
  systemIds: ReadonlySet<string> = SYSTEM_ACTOR_IDS,
): CoverageViolation[];
```

A `<METHOD> /<path>` label is live when a declaration has that `route`; a `GET` route label is `read-route-allowlisted`. A `writer:<Name>` label is live when a system writer declaration has `writer` `<Name>`. A `system:<id>` label is live when `systemIds` has `<id>`. Any other label is `stale-surface`. A reason that is empty after trimming is `empty-reason`.

### Bookkeeping reasons (`BOOKKEEPING_REASONS`)

Each id wraps the exact calls in the "Wrapped at" column, and nothing around them. Line numbers are at `4592d038`, to locate the code.

| Id | Reason (the catalogue sentence) | Wrapped at | Story |
|:--|:--|:--|:--|
| `runner.heartbeat` | A runner's liveness, boot id, versions and capabilities from a sync. | `SyncService.sync`, the `repo.recordRunnerSync` call (`sync.service.ts:61`) | US-005 |
| `runner.command-delivery` | The delivered mark of a command handed to a runner. | `SyncService.deliver`, the `markDelivered` call (`sync.service.ts:166`) | US-005 |
| `runner.command-ack` | A runner's ack of a command, and an approval answer's delivery outcome, that change no job. | `CommandAckProcessor.processOne`: the three `ackCommand` calls (`:60`, `:65`, `:69`), `approvals.setOutcome` (`:82`), the READOPT-ok `repo.update` of `runnerBootId` (`:89`) | US-005 |
| `thread.input-ack` | A runner's ack of a thread input, answer or publish command: the message's error mark, the answered question cleared, the command payload trimmed. | `CommandAckProcessor.processOne`, the `threadEffects.onInputAck` call (`command-ack.processor.ts:71`; `ThreadJobEffects.onInputAck` makes only these writes) | US-005 |
| `runner.event-log` | Runner event rows, the acked sequence, the job fields mirrored from the runner's reported run facts (cost, progress, `naxRunId`, result branch, sha and PR url, finish result, escalation reason, post-run, stories, config result), and a rejected event's activity row; the state transition that ends a run records its own entry. | `JobReportProcessor`: `repo.appendEvent` (`job-report.processor.ts:92`), the `ackedRunnerSeq` `repo.update` (`:113`), the mirror branch's `repo.update(effect.patch)` (`:121`), the reject branch's `activity.record` (`:137`) | US-005 |
| `runner.fence-abandon` | The ABANDON command and activity row a fence queues for a stale holder. | `FenceService.abandon`, its whole body (`fence.service.ts:22-34`; it makes no other write) | US-005 |
| `runner.boot-reconcile` | A pending ASSIGN's boot id moved to the runner's new boot. | `CommandAckProcessor.reconcileBoot`, the pending-assign `repo.update` (`command-ack.processor.ts:128`) | US-005 |
| `fleet.placement` | A job or thread assigned to a runner: the lease, the ASSIGN command, the thread pin and the assigned row. | `PlacementService.assign`, its whole body (`placement.service.ts:197-210`; `cancelForPause` records and is not wrapped) | US-005 |
| `fleet.pr-link-job` | The job id refreshed on a PR link that already exists. | `PrismaFleetTicketsRepository.upsertFleetPrLink`, the `ticketLink.updateMany` call (`prisma-fleet-tickets.repository.ts:165`) | US-006 |
| `fleet.ticket-comment-claim` | The once-per-job-epoch claim before a failure comment; the comment records `comment.create`. | `FleetJobTicketEffects.commentOnce`, the `repo.claimNotified` call (`fleet-job-ticket.effects.ts:119`) | US-006 |
| `fleet.pr-attribution-claim` | The once-per-job claim before the attribution comment. | `PrAttributionService.attribute`, the `repo.claimAttribution` call (`pr-attribution.service.ts:54`) | US-006 |
| `fleet.log-chunk` | The stream metadata of an uploaded log chunk. | `LogUploadService.write`, its whole body (`log-upload.service.ts:112-140`) | US-007 |
| `thread.transcript` | The thread transcript folded from a runner's stream, and the ingest cursor; a `turn_end` records `system.thread.ingest` itself. | `PrismaThreadIngestRepository.fold`: every write in the fold except `this.audit.record` (`prisma-thread-ingest.repository.ts:75-200`), by wrapping the fold's transaction body in `bookkeeping` (the record still counts: only writes are uncounted) | US-007 |
| `fleet.ingest-queue` | A bundle ingest claim, retry or failure mark. | `BundleIngestService.ingestOne`, the `repo.claimNext` (`bundle-ingest.service.ts:76`) and `repo.markFailed` (`:81`) calls; `recordFailure`, its whole body (`:137-143`) | US-007 |
| `fleet.schedule-bookkeeping` | A schedule's fire claim, a skip or coalesce activity row, and the last dispatched job link. | `ScheduleTicker`: `repo.claimFire` (`schedule-ticker.ts:116`), the skip and coalesce `activity.record` calls (`:129`, `:135`, `:142`, `:186`, `:190`, `:206`), `linkDispatched`, its whole body (`:176-181`) | US-007 |
| `assistant.tool-call-ledger` | The tool-call ledger row every assistant tool call stores, read or write. | `PrismaAssistantToolCallRepository.record`, its whole body (`prisma-assistant-tool-call.repository.ts:75-77`) | US-007 |
| `assistant.action-proposal` | A write tool's proposal: the pending action, its approval, the approval's activity and outbox rows, and the approval id link; the decide records `fleet.approval.decide.assistant`. | `AssistantActionService.open`, the `actions.insert`, `approvals.openAssistant` and `actions.setApprovalId` calls (`assistant-action.service.ts:77-84`) | US-007 |
| `assistant.direct-action-record` | The terminal ledger row of a direct-write tool call, failed calls included; the tool's own write records. | `AssistantActionService.recordDirect`, the `actions.insertDirect` call (`assistant-action.service.ts:62`) | US-007 |
| `assistant.action-finalize` | An approved assistant action's terminal status and outcome note; the decide and the tool recorded. | `AssistantActionDecisions.finalize`, its whole body (`assistant-action-decisions.ts:151-165`) | US-007 |
| `email.template-seed` | The built-in email templates written from code at boot; the code is their source. | `EmailTemplateSeeder.seed`, its whole body (`email-template.seeder.ts`; it makes only template writes) | US-007 |
| `vcs.poll-log` | A VCS poll's sync log row and cursor. | `VcsPollingService.poll`, the `updateVcsConnectionLastSynced` call (`vcs-polling.service.ts:177`) and both `createVcsSyncLog` calls (`:181`, `:212`) | US-008 |
| `webhook.replay-record` | A webhook delivery id kept or forgotten for replay protection. | `WebhookReplayGuard.assertFresh`, the delivery row `create` (`webhook-replay.guard.ts:71`); `forget`, its whole body (`:96-109`) | US-008 |
| `vcs.push-outbox` | The `code_commit` outbox rows a push enqueues; the code-intel subscriber records the index. | `VcsWebhookService.handlePush`, the `outboxService.record` call (`vcs-webhook.service.ts:710`) | US-008 |
| `vcs.pr-same-state` | A PR webhook that restates the stored state, touching only `prUpdatedAt`. | `PrismaVcsRepository.updateTicketLinkWithPrState`, the `ticketLink.update` call (`prisma-vcs.repository.ts:304`) only when `previousState === prState` | US-008 |
| `vcs.link-refresh` | The extractor's refresh of a ticket link that already exists. | `PrismaVcsRepository.upsertTicketLink`, the refresh branch's `ticketLink.upsert` (`prisma-vcs.repository.ts:371`) | US-008 |
| `context.query-metric` | A context query's latency and result metric row. | `ContextBuilderService.recordQueryMetricFireAndForget`, the `sloDashboardService.recordQueryMetric(metric)` call (`context-builder.service.ts:345`) | US-008 |

The memory restatement row of audit-knowledge's table is not here: `PrismaMemoryItemRepository.upsert` returns before any write on that path, so there is nothing to mark.

### Unaudited surfaces (`UNAUDITED_SURFACES`)

| Surface | Reason |
|:--|:--|
| `POST /me/notifications/:id/read` | Marks one of the caller's own notifications read; inbox state, not a domain change. |
| `POST /me/notifications/read-all` | Marks the caller's own notifications read; inbox state, not a domain change. |
| `system:outbox` | Runs each outbox fan-out handler; the handlers that run here write delivery bookkeeping (notification rows and watchers, the KB ticket index, the entity graph projection, the webhook send, the handler's `lastError`), and the recording handlers open their own writer scope. |
| `writer:PrismaOutboxStore` | The outbox relay's published, retry and dead marks. |
| `writer:EmailDispatcher` | An email claimed, sent, skipped, failed or backed off, and abandoned invite sends closed. |
| `system:knowledge` | A knowledge index pass: claims, leases and per-file rows of a derived index; a successful pass also records `system.knowledge.index`. |
| `system:unknown` | The context guard's production fallback, which already logged `ContextlessWriteError`. |

### Detached work opens its own scope

`SyncService.afterTerminal` and `FleetSweeper` start `PrAttributionService.attribute(id)` and `FleetJobTicketEffects.onTerminal(ids)` without awaiting them. Their writes would land in the request's or the tick's scope at an unpredictable time: before it closes they count, after it they are lost, and a write counted before the close with its entry recorded after it fails the request at random. Both methods therefore run their body in their own scope: `attribute` in `runInAuditScope('task:PrAttributionService.attribute', …, { detached: true })` and `onTerminal` in `runInAuditScope('task:FleetJobTicketEffects.onTerminal', …, { detached: true })`. A detached scope has no parent, so the request or tick neither receives its entries nor waits for it. A `task:` scope is checked like any other and is never allowlisted. Each scope wraps the whole method body outside the method's own error handling, so in mode `throw` an `UnauditedWriteError` rejects the detached promise (an unhandled rejection, which fails the test run), and mode `record` never throws. A write that reaches a scope after it closed is ignored.

`BundleIngestService.kick` already runs `drain` in `runAsSystem('ingest', …)` and ends in `.catch(warn)`, so an `UnauditedWriteError` there is logged, not thrown; a spec reaches the check by calling `drain` through `runAsSystem('ingest', …)` itself.

### Writes the suite reveals

The tables are what the six audit features documented and the grounding confirmed. When US-010 and US-011 open the scopes, an integration or e2e spec that reaches an entry point making a write no table names fails with `UnauditedWriteError`, naming the surface and the write labels. US-011 resolves each one in source, never in the test:
- a write that changes what a user, an agent or the system later sees or does gets an `AuditRecorder.record` (inside its transaction) or `audited` entry under the key its entry point's family already uses;
- a write that only records delivery, progress or a derived index gets a new `BOOKKEEPING_REASONS` id with its sentence, wrapped at the exact call;
- an entry point that only writes bookkeeping gets an `UNAUDITED_SURFACES` entry with its reason.

Each resolution is listed in the story's commit message with the surface and the choice. A record uses a key the catalog already has (new keys are out of scope); a write that no existing key fits is bookkeeping or an unaudited surface, with its reason. A resolution edits source files only (any file the write lives in); it never changes an existing spec's assertion. Turning the guard off, catching `UnauditedWriteError`, or changing a spec to stop reaching the entry point is not a resolution.


### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| a scope wrote, recorded nothing, mode `throw` | `UnauditedWriteError` with the surface and the write labels; an HTTP request answers 500 | US-001, US-010 |
| a scope wrote, recorded nothing, mode `record` | logs the error message once, returns the work's result unchanged | US-001 |
| the scope's function rejects or throws | the check is skipped; the original error propagates unchanged | US-001 |
| `bookkeeping` with an id outside `BOOKKEEPING_REASONS` | rejects with `unknown bookkeeping reason: <id>` before running fn | US-002 |
| a write rejects | not counted; the rejection propagates unchanged | US-003 |
| an interactive transaction's callback rejects | its writes and entries are dropped; the rejection propagates unchanged | US-004 |
| a surface on `UNAUDITED_SURFACES` wrote and recorded nothing | no error, no log | US-001 |
| a request whose handler has no route metadata | no scope; the request runs as before | US-010 |
| a handler observable that errors | the error is forwarded unchanged; no check | US-010 |
| a SYSTEM `withTestActor` id outside `SYSTEM_ACTOR_IDS` | rejects with `unknown system actor id: <id>`; fn does not run | US-011 |
| `record` rejects inside the logout's `audited` | the token version bump rolls back (the user's `tokenVersion` is unchanged); the route answers an error status | US-009 |

## Out of Scope

- A scope that records at least one entry and also makes a second, unaudited domain write is not detected; the guard checks per entry point, not per write.
- A write surface that no integration or e2e spec reaches is not checked; adding specs for unreached routes is out of scope.
- Auditing `POST /auth/login`, `POST /auth/refresh` and failed sign-ins is out of scope; they write no row, and a sign-in log is a security-log concern.
- Writes made through `$queryRaw` (the outbox relay's `claimBatch` `UPDATE … RETURNING`) are not counted, because the context guard's `GUARDED_OPERATIONS` does not include `$queryRaw`; widening that set is out of scope.
- A transaction whose callback resolves but whose commit then fails keeps its counts; the guard reads the callback's outcome only.
- A check that a new outbox handler with domain writes opens its own `runAsSystemWriter` scope is out of scope; it stays a review rule (see `system:outbox`).
- An `UnauditedWriteError` inside `BundleIngestService.kick`'s background drain is logged by its existing `.catch`, not thrown; changing that catch is out of scope.
- A switch or environment variable that turns the coverage guard off is out of scope.
- Reading or updating `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` is out of scope; the walker reads the live app.
- New permission catalog keys are out of scope; logout records the existing `session.logout`.
- A write that reaches a scope after the scope closed is ignored; tracking it is out of scope.
- Controllers whose `@Controller` path is an array are out of scope for `routeSurface`, as they are for the existing permission contract walker; none exists at `4592d038`.
- Watching koda-wk's production logs for `UnauditedWriteError` lines after the deploy is a manual step after merge, not story work.
- US-005 only: wrapping `CommandAckProcessor.reconcileBoot`'s READOPT `createCommand` and `runner.rebooted` activity row is out of scope; that branch records an entry when it queues or detects a reboot.
- US-007 only: per-line conditions inside `PrismaThreadIngestRepository.fold` are out of scope; the whole fold body is bookkeeping and the `turn_end` entry still counts.
- US-010 only: an integration test through a test-only controller that writes without recording is out of scope; the interceptor's throw path is covered by unit specs.

## Stories

This is one capability (the coverage guard and its walker) in twelve stories: four build the guard, five mark the bookkeeping the earlier features documented, two open the scopes, and one walks the allowlist. Every mark is inert until US-010 and US-011 open the scopes. US-010 lands after every marking story, so the HTTP suites then reach only the bookkeeping the tables name; a write the tables miss surfaces there or in US-011 ("Writes the suite reveals").

### US-001: Audit scope core

No dependencies. Workdir: `apps/api`.

Adds `src/action-context/audit-coverage.ts` with `AuditScope`, `openAuditScope`, `runInAuditScope` (with `{ detached }`), `currentAuditScope`, `noteAuditWrite`, `noteAuditEntry`, `assertAuditCoverage` and `UnauditedWriteError`, and `src/action-context/audit-coverage.allowlist.ts` with `UNAUDITED_SURFACES` (every row of the Unaudited surfaces table). Nothing calls the module yet.

### US-002: The bookkeeping marker and its catalogue

Depends on US-001. Workdir: `apps/api`.

Adds `bookkeeping` and `currentBookkeepingReason` to `audit-coverage.ts`, and `src/action-context/audit-coverage.reasons.ts` with `BOOKKEEPING_REASONS` (every row of the Bookkeeping reasons table, with its sentence).

### US-003: Count the writes that changed a row

Depends on US-001. Workdir: `apps/api`.

`contextlessWriteHandler` notes each in-context write that changed a row, by the "What counts as a write" rules. Still inert: no entry point opens a scope.

### US-004: The transaction tally and the recorder

Depends on US-001, US-003. Workdir: `apps/api`.

Adds `withTransactionTally` to `audit-coverage.ts`: it captures the scope current when it is called, holds the writes and entries noted while its function runs (including those of scopes opened and closed inside it), and on fulfilment adds them to that captured scope (entries also to its parents); on rejection it drops them. `KodaPrismaClient` returns `new Proxy(extended, { get })` whose `$transaction` property is a wrapper: a function first argument calls `Reflect.get(extended, '$transaction').call(extended, (tx) => withTransactionTally(() => fn(tx)), options)`; an array argument delegates unchanged; every other property is `Reflect.get(extended, property)`. `AuditRecorder.record` notes each entry after `storage.record` resolves.

### US-005: Mark the runner sync bookkeeping

Depends on US-002. Workdir: `apps/api`.

Wraps the rows whose story is US-005 (`runner.heartbeat`, `runner.command-delivery`, `runner.command-ack`, `thread.input-ack`, `runner.event-log`, `runner.fence-abandon`, `runner.boot-reconcile`, `fleet.placement`) at exactly the named calls.

### US-006: Detached fleet tasks and their bookkeeping

Depends on US-001, US-002. Workdir: `apps/api`.

Runs `PrAttributionService.attribute` and `FleetJobTicketEffects.onTerminal` in their detached `task:` scopes ("Detached work opens its own scope"), and wraps the rows whose story is US-006 (`fleet.pr-link-job`, `fleet.ticket-comment-claim`, `fleet.pr-attribution-claim`).

### US-007: Mark the ingest, schedule, assistant and seed bookkeeping

Depends on US-002. Workdir: `apps/api`.

Wraps the rows whose story is US-007 (`fleet.log-chunk`, `thread.transcript`, `fleet.ingest-queue`, `fleet.schedule-bookkeeping`, `assistant.tool-call-ledger`, `assistant.action-proposal`, `assistant.direct-action-record`, `assistant.action-finalize`, `email.template-seed`) at exactly the named calls.

### US-008: Mark the VCS and context bookkeeping

Depends on US-002. Workdir: `apps/api`.

Wraps the rows whose story is US-008 (`vcs.poll-log`, `webhook.replay-record`, `vcs.push-outbox`, `vcs.pr-same-state`, `vcs.link-refresh`, `context.query-metric`) at exactly the named calls.

### US-009: Logout records `session.logout`

No dependencies. Workdir: `apps/api`.

`AuthService.logout` records `session.logout` through `audited` around `bumpTokenVersion`, as the Integration block states.

### US-010: The request scope

Depends on US-001, US-003, US-004, US-005, US-006, US-007, US-008, US-009. Workdir: `apps/api`.

Adds `src/permissions/route-surface.ts` and moves `collectControllerRoutes` onto it. `ActionContextInterceptor` opens a scope labelled with the route surface, calls `next.handle()` inside it (Nest binds the handler to the async context at that call), and checks it once on completion. It depends on every marking story, so the HTTP suites reach only marked bookkeeping when it lands.

### US-011: System scopes and the suite

Depends on US-004, US-010. Workdir: `apps/api`.

`runAsSystem` and `runAsSystemWriter` open scopes with the labels of the Design. `withTestActor`'s SYSTEM branch and `fixtureDb`'s `asSeed` stop opening a scope: they validate the id against `SYSTEM_ACTOR_IDS`, then run `runWithActionContext({ actor: { type: 'SYSTEM', id }, origin: 'system' }, …)`. Resolves, in source, every write the integration and e2e suites reveal, per "Writes the suite reveals".

### US-012: The coverage walker

Depends on US-011. Workdir: `apps/api`.

Adds `findCoverageViolations` in `src/action-context/test-helpers/audit-coverage-contract.ts` and `test/integration/audit/audit-coverage.integration.spec.ts`, which boots the API, collects the live surfaces with `collectPermissionDeclarations` and finds no violation.

### Context Files

**US-001**
- `apps/api/src/action-context/action-context.ts` — the `AsyncLocalStorage` pattern to mirror
- `apps/api/src/action-context/contextless-write.ts` — `resolveWriteGuardMode`, `WriteGuardMode`, the error class pattern
- `apps/api/src/common/test-helpers/restore-env.ts` — `restoreEnvAfterEach()` for the `ENV_NAME` ACs

**US-002**
- `apps/api/src/action-context/audit-coverage.ts` — created by US-001, extended here

**US-003**
- `apps/api/src/action-context/contextless-write.ts` — `contextlessWriteHandler`
- `apps/api/src/action-context/contextless-write.spec.ts` — the handler's spec style

**US-004**
- `apps/api/src/prisma/koda-prisma-client.ts` — the client the tally wraps
- `apps/api/src/audit/audit-recorder.service.ts` — `record`
- `apps/api/src/audit/audit-recorder.service.spec.ts` — the recorder's spec harness
- `apps/api/test/helpers/action-context.ts` — the existing `Proxy` over the client (`asTestActor`) to mirror

**US-005**
- `apps/api/src/fleet/sync/sync.service.ts` — `sync`, `deliver`
- `apps/api/src/fleet/sync/command-ack.processor.ts` — `processOne`, `reconcileBoot`
- `apps/api/src/fleet/sync/job-report.processor.ts` — event log writes
- `apps/api/src/fleet/sync/fence.service.ts` — `abandon`
- `apps/api/src/fleet/jobs/placement.service.ts` — `assign`

**US-006**
- `apps/api/src/fleet/sync/pr-attribution.service.ts` — `attribute`
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts` — `onTerminal`, `commentOnce`
- `apps/api/src/fleet/tickets/prisma-fleet-tickets.repository.ts` — `upsertFleetPrLink`, `claimNotified`
- `apps/api/src/fleet/sync/sync.service.ts` — `afterTerminal`, the detached caller

**US-007**
- `apps/api/src/fleet/logs/log-upload.service.ts` — `write`
- `apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.ts` — `fold`
- `apps/api/src/fleet/ingest/bundle-ingest.service.ts` — `ingestOne`, `recordFailure`
- `apps/api/src/fleet/schedules/schedule-ticker.ts` — claim, skip rows, `linkDispatched`
- `apps/api/src/fleet/assistant/actions/assistant-action-decisions.ts` — `finalize`

**US-008**
- `apps/api/src/vcs/vcs-polling.service.ts` — `poll`
- `apps/api/src/webhook-security/webhook-replay.guard.ts` — `assertFresh`, `forget`
- `apps/api/src/vcs/prisma-vcs.repository.ts` — `updateTicketLinkWithPrState`, `upsertTicketLink`
- `apps/api/src/vcs/vcs-webhook.service.ts` — `handlePush`
- `apps/api/src/context/context-builder.service.ts` — `recordQueryMetricFireAndForget`

**US-009**
- `apps/api/src/auth/auth.service.ts` — `logout`
- `apps/api/src/auth/auth.service.spec.ts` — the logout test

**US-010**
- `apps/api/src/action-context/action-context.interceptor.ts` — the request entry point
- `apps/api/src/action-context/action-context.interceptor.spec.ts` — the interceptor's spec fakes
- `apps/api/src/permissions/test-helpers/permission-contract.ts` — `collectControllerRoutes`, `joinRoutePath`

**US-011**
- `apps/api/src/action-context/action-context.ts` — `runAsSystem`, `runAsSystemWriter`
- `apps/api/test/helpers/action-context.ts` — `withTestActor`, `asSeed`
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the HTTP suite that reaches most routes
- `apps/api/test/integration/audit/audit-fleet-system-retention.integration.spec.ts` — idle-purge and rollback cases the counting rules must keep green

**US-012**
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the boot-and-collect pattern to mirror
- `apps/api/src/permissions/test-helpers/permission-contract.ts` — `collectPermissionDeclarations`
- `apps/api/src/action-context/audit-coverage.allowlist.ts` — created by US-001, read here
- `apps/api/src/action-context/action-context.ts` — `SYSTEM_ACTOR_IDS`

### Creates

**US-001**
- `apps/api/src/action-context/audit-coverage.ts`
- `apps/api/src/action-context/audit-coverage.allowlist.ts`
- `apps/api/src/action-context/audit-coverage.spec.ts`

**US-002**
- `apps/api/src/action-context/audit-coverage.reasons.ts`
- `apps/api/src/action-context/audit-coverage.bookkeeping.spec.ts`

**US-003**
- `apps/api/src/action-context/audit-coverage.counting.spec.ts`

**US-004**
- `apps/api/src/action-context/audit-coverage.tally.spec.ts`
- `apps/api/test/integration/audit/audit-coverage-tally.integration.spec.ts`

**US-009**
- `apps/api/test/integration/audit/audit-logout.integration.spec.ts`

**US-010**
- `apps/api/src/permissions/route-surface.ts`
- `apps/api/src/permissions/route-surface.spec.ts`

**US-011**
- `apps/api/test/integration/audit/audit-coverage-scopes.integration.spec.ts`

**US-012**
- `apps/api/src/action-context/test-helpers/audit-coverage-contract.ts`
- `apps/api/src/action-context/test-helpers/audit-coverage-contract.spec.ts`
- `apps/api/test/integration/audit/audit-coverage.integration.spec.ts`

### Modifies

**US-003**
- `apps/api/src/action-context/contextless-write.ts` — an in-context guarded write notes its label after it resolves, by the "What counts as a write" rules; the context-less paths are unchanged.

**US-004**
- `apps/api/src/audit/audit-recorder.service.ts` — `record` calls `noteAuditEntry()` after `storage.record` resolves.
- `apps/api/src/prisma/koda-prisma-client.ts` — the returned client's interactive `$transaction` runs its callback in `withTransactionTally`; the array form is unchanged.

**US-005**
- `apps/api/src/fleet/sync/sync.service.ts` — wrap the `recordRunnerSync` and `markDelivered` calls.
- `apps/api/src/fleet/sync/command-ack.processor.ts` — wrap the `ackCommand`, `approvals.setOutcome`, READOPT-ok `repo.update`, `threadEffects.onInputAck` and pending-assign `repo.update` calls.
- `apps/api/src/fleet/sync/job-report.processor.ts` — wrap `appendEvent`, the `ackedRunnerSeq` update, the mirror update and the reject branch's `activity.record`.
- `apps/api/src/fleet/sync/fence.service.ts` — wrap the body of `abandon`.
- `apps/api/src/fleet/jobs/placement.service.ts` — wrap the body of `assign`.

**US-006**
- `apps/api/src/fleet/sync/pr-attribution.service.ts` — run `attribute`'s body in its detached scope and wrap the `claimAttribution` call.
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts` — run `onTerminal`'s body in its detached scope and wrap the `claimNotified` call.
- `apps/api/src/fleet/tickets/prisma-fleet-tickets.repository.ts` — wrap the existing-link `ticketLink.updateMany` call.

**US-007**
- `apps/api/src/fleet/logs/log-upload.service.ts` — wrap the body of `write`.
- `apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.ts` — wrap the fold's transaction body.
- `apps/api/src/fleet/ingest/bundle-ingest.service.ts` — wrap `claimNext`, `markFailed` and the body of `recordFailure`.
- `apps/api/src/fleet/schedules/schedule-ticker.ts` — wrap `claimFire`, the skip and coalesce activity rows, and the body of `linkDispatched`.
- `apps/api/src/fleet/assistant/prisma-assistant-tool-call.repository.ts` — wrap the body of `record`.
- `apps/api/src/fleet/assistant/actions/assistant-action-decisions.ts` — wrap the body of `finalize`.
- `apps/api/src/fleet/assistant/actions/assistant-action.service.ts` — wrap the three proposal writes in `open` and the `insertDirect` call in `recordDirect`.
- `apps/api/src/email/email-template.seeder.ts` — wrap the body of `seed`.

**US-008**
- `apps/api/src/vcs/vcs-polling.service.ts` — wrap the cursor update and both sync log writes in `poll`.
- `apps/api/src/webhook-security/webhook-replay.guard.ts` — wrap the delivery create in `assertFresh` and the body of `forget`.
- `apps/api/src/vcs/vcs-webhook.service.ts` — wrap the `outboxService.record` call in `handlePush`.
- `apps/api/src/vcs/prisma-vcs.repository.ts` — wrap the same-state `ticketLink.update` and the refresh-branch `ticketLink.upsert`.
- `apps/api/src/context/context-builder.service.ts` — wrap the `recordQueryMetric` call.

**US-009**
- `apps/api/src/auth/auth.service.ts` — `logout` records through `audited`.
- `apps/api/src/auth/auth.service.spec.ts` — the `logout` test's `mockAuditRecorder` has only `record`, and `logout` now calls `audited`; add an `audited` mock that runs its function and returns its result, so the existing assertions (`bumpTokenVersion` called with the user id, both cache invalidations) keep holding.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the logout case gains one assertion: after the logout request answers 200, one `AuditEntry` with `action` `session.logout` exists for the user (the API testing rule keeps endpoint behaviour in this file). Its existing assertions stay unchanged.

**US-010**
- `apps/api/src/action-context/action-context.interceptor.ts` — open the request scope and check it on completion.
- `apps/api/src/action-context/action-context.interceptor.spec.ts` — the `requestWith` fake `ExecutionContext` has no `getClass` or `getHandler`, which the interceptor now calls; add both (a controller class and a handler, with or without route metadata). Every existing assertion on the emitted context stays unchanged.
- `apps/api/src/permissions/test-helpers/permission-contract.ts` — `collectControllerRoutes` builds the route string through `routeSurface`; the strings it prints, and every assertion of the permission contract integration spec, stay unchanged.

**US-011**
- `apps/api/src/action-context/action-context.ts` — `runAsSystem` takes `opts.surface` and runs its work in `runInAuditScope`; `runAsSystemWriter` passes its `writer:` label.
- `apps/api/test/helpers/action-context.ts` — `withTestActor`'s SYSTEM branch and `asSeed` call `runAsSystem`, which now opens a checked scope over fixture writes; they validate the id against `SYSTEM_ACTOR_IDS` (rejecting with `unknown system actor id: <id>`) and run `runWithActionContext({ actor: { type: 'SYSTEM', id }, origin: 'system' }, async () => await fn())` instead. Fixture writes keep running as SYSTEM with the same id.

None for US-001, US-002 and US-012: they only add files, or extend `audit-coverage.ts`, which US-001 creates (US-002 adds `bookkeeping`, and `noteAuditWrite` skips while a reason is set; US-004 adds `withTransactionTally`, and `noteAuditWrite` and `noteAuditEntry` add to the innermost open tally first). Each story's unit ACs live in the spec file co-located with the service it names (`<service>.spec.ts`), created if absent.

### Seams

- `noteAuditWrite` and `noteAuditEntry` (US-001) are called by `contextlessWriteHandler` (US-003) and `AuditRecorder.record` (US-004); US-003 AC-1 to AC-8 enter through the handler, and US-004 AC-5 and AC-6 through `record`.
- `withTransactionTally` (US-004) is called by `KodaPrismaClient`'s `$transaction`; US-004 AC-7 enters through `txManager.run` on the booted app.
- `bookkeeping` and `currentBookkeepingReason` (US-002) are used by US-005 to US-008; each of their ACs enters through the service's public method and observes the reason inside the stubbed collaborator.
- `runInAuditScope` (US-001) is used by US-006's detached scopes and by US-011's `runAsSystem`; US-006 AC-2 and AC-3 and US-011 AC-1 observe `currentAuditScope()?.surface` inside the work.
- `routeSurface` (US-010) is used by `ActionContextInterceptor` and `collectControllerRoutes`; US-010 AC-3 proves both print the same label for `POST /auth/logout`.
- `UNAUDITED_SURFACES` (US-001) is read by `assertAuditCoverage` (US-001 AC-8; its contents are pinned by US-002 AC-11) and by `findCoverageViolations` (US-012 AC-7).

## Acceptance Criteria

### US-001

- AC-1 [unit] In mode `throw`, `runInAuditScope('POST /x', fn)`, where `fn` calls `noteAuditWrite('Ticket.update')` and resolves, rejects with an `UnauditedWriteError`.
- AC-2 [unit] That `UnauditedWriteError` has `surface` `POST /x` and `writes` `['Ticket.update']`.
- AC-3 [unit] That `UnauditedWriteError`'s message is `unaudited write: POST /x wrote Ticket.update and recorded no audit entry`.
- AC-4 [unit] `runInAuditScope('POST /x', fn)`, where `fn` calls `noteAuditWrite('Ticket.update')` and `noteAuditEntry()` and resolves to `42`, resolves to `42`.
- AC-5 [unit] With `ENV_NAME` stubbed to `production` (restored after the test), `runInAuditScope('POST /x', fn)` whose `fn` notes one write, records nothing and resolves to `42` resolves to `42`.
- AC-6 [unit] In that production case, `Logger.prototype.error` is called exactly once, with `unaudited write: POST /x wrote Ticket.update and recorded no audit entry`.
- AC-7 [unit] When `fn` notes a write and then rejects with an error `E`, `runInAuditScope('POST /x', fn)` rejects with that same `E`.
- AC-8 [unit] In mode `throw`, `runInAuditScope('system:unknown', fn)` whose `fn` notes a write and records nothing resolves to `fn`'s value without logging.
- AC-9 [unit] When `fn` notes a write and then throws `E` synchronously, `runInAuditScope('POST /x', fn)` throws that same `E`.
- AC-10 [unit] A scope nested in `runInAuditScope('writer:Ticker', outer)`, where `outer` notes a write and awaits `runInAuditScope('system:schedule', inner)` whose `inner` only calls `noteAuditEntry()`, lets `outer`'s scope resolve.
- AC-11 [unit] A write noted inside a nested `runInAuditScope('system:vcs', inner)` that records nothing makes that nested call reject with an `UnauditedWriteError` whose `surface` is `system:vcs`, and leaves the enclosing scope's `writes` empty.
- AC-12 [unit] In mode `throw`, `runInAuditScope('writer:Sweeper', outer)`, where `outer` notes a write and awaits `runInAuditScope('task:T', inner, { detached: true })` whose `inner` calls `noteAuditEntry()`, rejects with an `UnauditedWriteError` whose `surface` is `writer:Sweeper`.
- AC-13 [unit] `noteAuditWrite('Ticket.update')` and `noteAuditEntry()` called with no open scope return without throwing, and `currentAuditScope()` answers `undefined`.

### US-002

- AC-1 [unit] Inside `bookkeeping('runner.heartbeat', fn)`, `currentBookkeepingReason()` answers `runner.heartbeat`.
- AC-2 [unit] A `noteAuditWrite('Runner.update')` inside `bookkeeping('runner.heartbeat', fn)`, inside an open scope, leaves the scope's `writes` empty.
- AC-3 [unit] After `bookkeeping('runner.heartbeat', fn)` resolves, `currentBookkeepingReason()` answers `undefined`.
- AC-4 [unit] `bookkeeping` called with an id that is not a key of `BOOKKEEPING_REASONS` rejects with `unknown bookkeeping reason: <id>`.
- AC-5 [unit] For that unknown id, `fn` is never called.
- AC-6 [unit] When `fn` returns a lazy thenable that reads `currentBookkeepingReason()` only when its `then` is invoked, `bookkeeping('runner.heartbeat', fn)` makes it read `runner.heartbeat`.
- AC-7 [unit] When `fn` returns a lazy thenable that reads `currentAuditScope()` only when its `then` is invoked, `runInAuditScope('POST /x', fn)` makes it read the scope whose `surface` is `POST /x`.
- AC-8 [unit] A `noteAuditEntry()` inside `bookkeeping('thread.transcript', fn)`, inside an open scope, raises the scope's `entries` to 1.
- AC-9 [unit] The keys of `BOOKKEEPING_REASONS` are exactly the 26 ids of the Bookkeeping reasons table.
- AC-10 [unit] Every value of `BOOKKEEPING_REASONS` is a sentence that is non-empty after trimming.
- AC-11 [unit] `UNAUDITED_SURFACES` holds exactly the seven surfaces of the Unaudited surfaces table.
- AC-12 [unit] Every reason in `UNAUDITED_SURFACES` is non-empty after trimming.

### US-003

- AC-1 [unit] `contextlessWriteHandler('throw')`, called inside an action context and an open scope, adds `Ticket.update` to the scope's `writes` for a resolved `update` on model `Ticket`.
- AC-2 [unit] It adds `Ticket.deleteMany` for a resolved `deleteMany` on model `Ticket` whose result is `{ count: 2 }`.
- AC-3 [unit] It adds nothing for a resolved `updateMany` or `deleteMany` whose result is `{ count: 0 }`.
- AC-4 [unit] It adds nothing for a resolved `createManyAndReturn` whose result is `[]`, and adds `TicketLink.createManyAndReturn` for one whose result holds one row.
- AC-5 [unit] It adds `$executeRaw` for a raw execute with no model that resolves to `1`, and nothing for one that resolves to `0`.
- AC-6 [unit] It adds nothing for a resolved `create` on model `AuditEntry`.
- AC-7 [unit] It adds nothing for an `update` on model `Ticket` whose query rejects, and the rejection propagates unchanged.
- AC-8 [unit] It returns the query's result unchanged for a counted write.
### US-004

- AC-1 [unit] Inside an open scope, `withTransactionTally(fn)`, where `fn` notes one write and resolves, leaves the scope's `writes` empty while `fn` runs, and holds that one label after `withTransactionTally` resolves.
- AC-2 [unit] Inside an open scope, `withTransactionTally(fn)`, where `fn` notes one write and then rejects with `E`, rejects with `E` and leaves the scope's `writes` empty.
- AC-3 [unit] Inside an open scope, an entry noted inside a `withTransactionTally(fn)` whose `fn` rejects leaves the scope's `entries` at 0.
- AC-4 [unit] An entry noted inside a `withTransactionTally(fn)` that resolves, inside a nested scope, counts in the nested scope and in its enclosing scope.
- AC-5 [unit] `AuditRecorder.record` with a valid key, inside a transaction (`txManager.isInTransaction()` answering `true`) and an open scope, raises the scope's `entries` from 0 to 1 once `storage.record` resolves.
- AC-6 [unit] When `storage.record` rejects, `AuditRecorder.record` rejects with the same error and the scope's `entries` stays 0.
- AC-7 [integration] On the booted API, inside `openAuditScope('POST /x', …)` and an action context, a `txManager.run` that creates a `Label` row and then throws rejects, and the scope's `writes` is empty afterwards.
- AC-8 [unit] A scope opened and closed inside a `withTransactionTally(fn)` callback, whose work notes one write and records nothing, resolves; after `withTransactionTally` resolves, that write is in the `writes` of the scope that was current when `withTransactionTally` was called.

### US-005

- AC-1 [unit] `SyncService.sync` for a known runner calls `repo.recordRunnerSync` while `currentBookkeepingReason()` answers `runner.heartbeat`.
- AC-2 [unit] `SyncService.sync` for a runner with one pending command calls `markDelivered` while `currentBookkeepingReason()` answers `runner.command-delivery`.
- AC-3 [unit] `CommandAckProcessor.process` with one ordinary command ack calls `ackCommand` while `currentBookkeepingReason()` answers `runner.command-ack`.
- AC-4 [unit] `CommandAckProcessor.process` with one `APPROVAL_ANSWER` ack calls `approvals.setOutcome` while `currentBookkeepingReason()` answers `runner.command-ack`.
- AC-5 [unit] `CommandAckProcessor.process` with one `THREAD_INPUT` ack calls `threadEffects.onInputAck` while `currentBookkeepingReason()` answers `thread.input-ack`.
- AC-6 [unit] `CommandAckProcessor.process` with an ack that applies a job transition calls `transitions.apply` while `currentBookkeepingReason()` answers `undefined`.
- AC-7 [unit] `JobReportProcessor.process` with one new contiguous event calls `repo.appendEvent` while `currentBookkeepingReason()` answers `runner.event-log`.
- AC-8 [unit] `JobReportProcessor.process` with one new contiguous event calls the `ackedRunnerSeq` `repo.update` while `currentBookkeepingReason()` answers `runner.event-log`.
- AC-9 [unit] `JobReportProcessor.process` with an event the transition rules reject calls `activity.record` with `job.event_rejected` while `currentBookkeepingReason()` answers `runner.event-log`.
- AC-10 [unit] `JobReportProcessor.process` with an accepted transition event calls `transitions.apply` while `currentBookkeepingReason()` answers `undefined`.
- AC-11 [unit] `FenceService.abandon` calls `createCommand` with an `ABANDON` command and `activity.record` with `job.abandon_queued`, both while `currentBookkeepingReason()` answers `runner.fence-abandon`.
- AC-12 [unit] `CommandAckProcessor.reconcileBoot` for a job with a pending ASSIGN calls the `runnerBootId` `repo.update` while `currentBookkeepingReason()` answers `runner.boot-reconcile`.
- AC-13 [unit] `CommandAckProcessor.reconcileBoot` after a reboot calls the READOPT `createCommand` while `currentBookkeepingReason()` answers `undefined`.
- AC-14 [unit] `PlacementService.fillRunner` with one placeable job calls `casAssign` and the `ASSIGN` `createCommand` while `currentBookkeepingReason()` answers `fleet.placement`.

### US-006

- AC-1 [unit] `PrAttributionService.attribute(jobId)` calls `repo.claimAttribution` while `currentBookkeepingReason()` answers `fleet.pr-attribution-claim`.
- AC-2 [unit] `PrAttributionService.attribute(jobId)` calls `repo.claimAttribution` while `currentAuditScope()?.surface` answers `task:PrAttributionService.attribute`.
- AC-3 [unit] `FleetJobTicketEffects.onTerminal([jobId])` for a `FAILED` job with one linked ticket reads the job's tickets while `currentAuditScope()?.surface` answers `task:FleetJobTicketEffects.onTerminal`.
- AC-4 [unit] Called inside `runInAuditScope('POST /fleet/runner/sync', …)`, `onTerminal`'s scope has `parent` `undefined`.
- AC-5 [unit] In mode `throw`, `FleetJobTicketEffects.onTerminal([jobId])` whose stubbed repository notes one write (`noteAuditWrite('TicketLink.update')`) and records nothing rejects with an `UnauditedWriteError` whose `surface` is `task:FleetJobTicketEffects.onTerminal`.
- AC-6 [unit] `FleetJobTicketEffects.onTerminal([jobId])` for a `FAILED` job with one linked ticket calls `repo.claimNotified` while `currentBookkeepingReason()` answers `fleet.ticket-comment-claim`.
- AC-7 [unit] `FleetJobTicketEffects.onTerminal([jobId])` for a job with an opened PR whose ticket link already exists calls `ticketLink.updateMany` (through `PrismaFleetTicketsRepository.upsertFleetPrLink` over a stubbed client whose `createManyAndReturn` answers `[]`) while `currentBookkeepingReason()` answers `fleet.pr-link-job`.
- AC-8 [unit] In that existing-link case, `upsertFleetPrLink` answers `null`.

### US-007

- AC-1 [unit] `LogUploadService.upload` of one log chunk calls `logs.upsertStream` while `currentBookkeepingReason()` answers `fleet.log-chunk`.
- AC-2 [unit] `PrismaThreadIngestRepository.fold` of a batch holding one `turn_start` line, with a `txManager` stub that runs its callback, makes the turn create while `currentBookkeepingReason()` answers `thread.transcript`.
- AC-3 [unit] That fold makes the `threadIngestCursor.upsert` while `currentBookkeepingReason()` answers `thread.transcript`.
- AC-4 [unit] `BundleIngestService.ingestOne` calls `repo.claimNext` while `currentBookkeepingReason()` answers `fleet.ingest-queue`.
- AC-5 [unit] `BundleIngestService.ingestOne` for a claim whose bundle read throws calls `markRetry` while `currentBookkeepingReason()` answers `fleet.ingest-queue`.
- AC-6 [unit] `BundleIngestService.ingestOne` for a claim that ingests calls `replaceRows` while `currentBookkeepingReason()` answers `undefined`.
- AC-7 [unit] `ScheduleTicker.tick` with one due schedule calls `repo.claimFire` while `currentBookkeepingReason()` answers `fleet.schedule-bookkeeping`.
- AC-8 [unit] `ScheduleTicker.tick` with a due schedule whose previous job is still running calls `activity.record` for the skip while `currentBookkeepingReason()` answers `fleet.schedule-bookkeeping`.
- AC-9 [unit] `ScheduleTicker.tick` with a due schedule that dispatches calls `jobs.dispatch` while `currentBookkeepingReason()` answers `undefined`.
- AC-10 [unit] That dispatching tick then calls the `lastJobId` `repo.update` while `currentBookkeepingReason()` answers `fleet.schedule-bookkeeping`.
- AC-11 [unit] `PrismaAssistantToolCallRepository.record(row)` calls `assistantToolCall.create` while `currentBookkeepingReason()` answers `assistant.tool-call-ledger`.
- AC-12 [unit] `AssistantActionDecisions.decide` approving a pending assistant action calls `executor.executeAction` while `currentBookkeepingReason()` answers `undefined`.
- AC-13 [unit] That approval then calls `actions.resolve` and `insertSystemNote` while `currentBookkeepingReason()` answers `assistant.action-finalize`.
- AC-14 [unit] `EmailTemplateSeeder.seed()` on a repository with no templates creates each template while `currentBookkeepingReason()` answers `email.template-seed`.
- AC-15 [unit] `AssistantActionService.propose` for a new write-tool call calls `actions.insert` and `approvals.openAssistant` while `currentBookkeepingReason()` answers `assistant.action-proposal`.

### US-008

- AC-1 [unit] A successful poll of a VCS connection calls `updateVcsConnectionLastSynced` while `currentBookkeepingReason()` answers `vcs.poll-log`.
- AC-2 [unit] That poll calls `createVcsSyncLog` while `currentBookkeepingReason()` answers `vcs.poll-log`.
- AC-3 [unit] A poll whose provider call throws calls the error-path `createVcsSyncLog` while `currentBookkeepingReason()` answers `vcs.poll-log`.
- AC-4 [unit] `WebhookReplayGuard.assertFresh` for a delivery id never seen creates its delivery row while `currentBookkeepingReason()` answers `webhook.replay-record`.
- AC-5 [unit] `WebhookReplayGuard.forget` deletes the delivery row while `currentBookkeepingReason()` answers `webhook.replay-record`.
- AC-6 [unit] `VcsWebhookService` handling a `push` webhook with one commit calls `outboxService.record` while `currentBookkeepingReason()` answers `vcs.push-outbox`.
- AC-7 [unit] `PrismaVcsRepository.updateTicketLinkWithPrState(id, 'open')` for a row whose stored `prState` is `open` calls `ticketLink.update` while `currentBookkeepingReason()` answers `vcs.pr-same-state`.
- AC-8 [unit] `PrismaVcsRepository.updateTicketLinkWithPrState(id, 'closed')` for a row whose stored `prState` is `open` calls `ticketLink.update` while `currentBookkeepingReason()` answers `undefined`.
- AC-9 [unit] `PrismaVcsRepository.upsertTicketLink` for a link that already exists calls the refresh branch's `ticketLink.upsert` while `currentBookkeepingReason()` answers `vcs.link-refresh`.
- AC-10 [unit] `PrismaVcsRepository.upsertTicketLink` for a new link makes its create while `currentBookkeepingReason()` answers `undefined`.
- AC-11 [unit] A context query through `ContextBuilderService` calls `sloDashboardService.recordQueryMetric` while `currentBookkeepingReason()` answers `context.query-metric`.

### US-009

- AC-1 [unit] `AuthService.logout(userId)` calls `audit.audited` exactly once, and `bumpTokenVersion(userId)` runs inside the function it passes.
- AC-2 [unit] The `entriesOf` that `AuthService.logout(userId)` passes to `audited` yields `{ key: 'session.logout', resourceType: 'user', resourceId: userId, projectId: null, summary: 'logged out' }`.
- AC-3 [unit] When `audit.audited` rejects, `AuthService.logout(userId)` rejects with the same error and calls `cache.invalidate` zero times.
- AC-4 [integration] `POST /auth/logout` as a logged-in user answers 200 and writes exactly one `AuditEntry` whose `action` is `session.logout` and whose `resourceId` is the user's id.
- AC-5 [integration] That entry's actor is `USER` with the user's id, and its summary is `logged out`.
- AC-6 [integration] With `AuditRecorder.record` rejecting once, `POST /auth/logout` answers an error status and the user's `tokenVersion` is unchanged.

### US-010

- AC-1 [unit] `routeSurface` for a controller decorated `@Controller('me')` and a handler decorated `@Post('notifications/read-all')` answers `POST /me/notifications/read-all`.
- AC-2 [unit] `routeSurface` for a method with no route decorator answers `undefined`.
- AC-3 [integration] On the booted API, the `route` that `collectPermissionDeclarations` reports for `AuthController.logout` equals `routeSurface(AuthController, AuthController.prototype.logout)`, and both answer `POST /auth/logout`.
- AC-4 [unit] In mode `throw`, `ActionContextInterceptor.intercept` for a `POST /x` route handler that notes one write, records nothing, emits `ok` and completes errors with an `UnauditedWriteError` whose `surface` is `POST /x`.
- AC-5 [unit] In that case, the observable does not complete.
- AC-6 [unit] `ActionContextInterceptor.intercept` for a `POST /x` route handler that notes one write, calls `noteAuditEntry()`, emits `ok` and completes emits `ok` and completes.
- AC-7 [unit] `ActionContextInterceptor.intercept` for a handler routed `POST /me/notifications/read-all` that notes one write, records nothing, emits `ok` and completes emits `ok` and completes.
- AC-8 [unit] With `ENV_NAME` stubbed to `production`, a `POST /x` handler that notes one write, records nothing and emits three values before completing makes `Logger.prototype.error` log exactly once.
- AC-9 [unit] `ActionContextInterceptor.intercept` for a `POST /x` handler that completes without emitting, after noting one write and recording nothing, errors with an `UnauditedWriteError` in mode `throw`.
- AC-10 [unit] `ActionContextInterceptor.intercept` for a handler with no route metadata emits the handler's value, and inside the handler `currentAuditScope()` answers `undefined`.
- AC-11 [unit] `ActionContextInterceptor.intercept` for a `POST /x` handler whose observable errors with `E` errors with that same `E`.

### US-011

- AC-1 [unit] Inside `runAsSystem('budget', fn)`, `currentAuditScope()?.surface` answers `system:budget`.
- AC-2 [unit] In mode `throw`, a `fn` that notes one write, records nothing and resolves makes `runAsSystem('budget', fn)` reject with an `UnauditedWriteError` whose `surface` is `system:budget`.
- AC-3 [unit] Inside `runAsSystemWriter(writer, fn)` for an instance of a class decorated `@SystemWriter('system.schedule.dispatch')` and named `ScheduleTicker`, `currentAuditScope()?.surface` answers `writer:ScheduleTicker` and the actor is `SYSTEM/schedule`.
- AC-4 [unit] `runAsSystem('budget', () => 7)` answers `7` synchronously, not a promise.
- AC-5 [integration] Inside `withTestActor({ type: 'SYSTEM', id: 'seed' }, fn)`, the actor is `SYSTEM/seed` with origin `system`, and `currentAuditScope()` answers `undefined`.
- AC-6 [integration] `withTestActor({ type: 'SYSTEM', id: 'nope' }, fn)` rejects with `unknown system actor id: nope`, and `fn` is never called.
- AC-7 [integration] `fixtureDb(app).user.create(…)` resolves to the created row on the booted app.
- AC-8 [integration] `POST /fleet/runner/sync` from an enrolled runner whose boot id is unchanged since its last sync, with no jobs, no acks and no free slots, answers 200.
- AC-9 [integration] `POST /me/notifications/read-all` as a user with one unread notification answers 200 and writes no `AuditEntry`.
- AC-10 [integration] A second `NotificationRetentionProcessor` purge run, after the first one purged every eligible row, resolves without an `UnauditedWriteError` and writes no `AuditEntry`.
- AC-11 [integration] An `EnrollmentRetentionProcessor` purge run with `AuditRecorder.record` rejecting once resolves without an `UnauditedWriteError`, and the enrollments it targeted still exist.

### US-012

- AC-1 [unit] `findCoverageViolations` for an allowlist holding `POST /gone`, over declarations with no such route, answers `[{ kind: 'stale-surface', surface: 'POST /gone' }]`.
- AC-2 [unit] `findCoverageViolations` for an allowlist holding `GET /me/notifications`, over declarations with that `GET` route, answers `[{ kind: 'read-route-allowlisted', surface: 'GET /me/notifications' }]`.
- AC-3 [unit] `findCoverageViolations` answers `[]` for an allowlist holding `writer:EmailDispatcher` over declarations with a system writer named `EmailDispatcher`.
- AC-4 [unit] `findCoverageViolations` answers `[{ kind: 'stale-surface', surface: 'writer:Missing' }]` for `writer:Missing`.
- AC-5 [unit] `findCoverageViolations` answers `[]` for `system:outbox` when `systemIds` has `outbox`, and `[{ kind: 'stale-surface', surface: 'system:nope' }]` for `system:nope`.
- AC-6 [unit] `findCoverageViolations` for an allowlist mapping a live route to the reason `'  '` answers `[{ kind: 'empty-reason', surface: <that route> }]`.
- AC-7 [integration] On the booted API, `findCoverageViolations` over the collected declarations, `UNAUDITED_SURFACES` and `SYSTEM_ACTOR_IDS` answers `[]`, with more than 200 routes and at least 30 system writers collected.
- AC-8 [unit] `findCoverageViolations` for an allowlist holding `task:PrAttributionService.attribute` answers `[{ kind: 'stale-surface', surface: 'task:PrAttributionService.attribute' }]`.
