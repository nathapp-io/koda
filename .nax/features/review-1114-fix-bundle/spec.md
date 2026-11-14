# SPEC: Whole-repo review 2026-11-14 fix bundle (agent spend tiers, flow failure stop, RUN login-only identity, small fixes)

## Summary

This feature fixes the P0 findings and a set of small P2 findings of the 2026-11-14 whole-repo review
(`docs/20261114-review-whole-repo.md`), using the rulings the owner gave on 2026-11-14:

1. **A/SEC-12, A/SEC-6 remainder, A/SEC-13 (approval tiers).** `fleet.job.dispatch`, `fleet.job.config.edit`,
   `fleet.schedule.create` and `user.update` become risk `high`, so an agent performing them waits for an agent
   approval by default. `fleet.thread.preapprove` becomes risk `critical`, so the catalog matches the controller that
   already refuses agents. A human acting directly is unaffected (the gate lets a direct human satisfy every mode).
2. **B/BUG-4 (flow failure stop).** A flow whose advance throws on 5 consecutive ticks is stopped with the new stop
   reason `internal_error`, instead of being retried on every tick forever.
3. **B/BUG-5 (ticker fairness, merge polling).** The ticker resumes after the last flow it reached instead of
   restarting from the lowest id, and a waiting-merge flow polls GitHub at most once per `flowMergePollMs` after a
   watch that completed (outcome `watched`).
4. **B/PERF-2 (flow lookup).** `GET /fleet/flows/:flowId` checks the flow's own project instead of loading every
   project the caller can reach.
5. **C/BUG-6 (note write race).** Two concurrent writes of the same memory note slug no longer fail with an
   unhandled unique violation or serialization error: the losing write retries and lands on the no-op or supersede
   path.
6. **D/SEC-14 and D/BUG-9 (RUN forge identity).** A GitHub RUN gets a login-only nax forge identity
   (`NAX_FORGE_IDENTITY=login-only` plus the bot login). The runner no longer waits for a fresh token or writes a
   token file for RUN; nax's `gh` calls get the job's token from the runner's credential shim on every call.
7. **D/SEC-15 and D/BUG-10 (release and deploy).** The release workflow passes `TURBO_TOKEN` as a BuildKit secret,
   not a build-arg, and the example deploy script refuses a Postgres password that would break `DATABASE_URL`.

The bundle spans `apps/api`, `apps/runner` and repo-root files. It is a bundle of independent fixes; the owner chose
one bundle feature, as for the 2026-11-01 P0 bundle.

## Motivation

The 2026-11-14 review graded koda B- (76/100) with no HIGH findings and three MEDIUM findings, all checked by hand
against the source:

- **Agent spend keys at tier `none` (A/SEC-12).** `classifyRisk` in `apps/api/src/permissions/catalog.ts` returns
  `medium` for any key that matches no rule, and `medium` gives the approval default `none`. `fleet.job.dispatch`,
  `fleet.job.config.edit` (queues a job that opens a repo PR) and `fleet.schedule.create` (a recurring job) match no
  rule, so a Developer agent starts spend or repo writes with no approval; budgets are the only cap. The owner ruled
  (2026-11-14) that these keys become `high`: agent-approved by default.
- **`user.update` (A/SEC-6 remainder).** `user.update` is the key of `PATCH /admin/users/:id`, which can disable a
  user. It is `medium`, so an agent holding global Admin can disable other admins with no approval. It becomes `high`.
- **`fleet.thread.preapprove` (A/SEC-13).** The key is granted to the Developer role at default `none`, but
  `ThreadPreApprovalController` calls `assertHuman` before the gate. Making the key user-only is not possible:
  `RoleAdminService.assertPrincipalType` would then refuse binding the Developer role to any agent. Risk `critical`
  gives the key the `human` approval floor instead.
- **Flow retried forever (B/BUG-4).** `FleetFlowTicker.tick` catches an advance error and only logs it. A flow that
  hits an undeclared error never changes state, so `listAdvanceable` returns it again every `flowTickMs` (30 s). The
  user sees no stop and no reason. The owner ruled (2026-11-14): stop after 5 consecutive failures; a successful pass
  resets the count.
- **Ticker starvation and merge polling (B/BUG-5).** Each tick starts from the lowest flow id and stops at 500 flows,
  so flows beyond 500 are never reached while lower ids stay advanceable. Each `WAITING_MERGE` flow polls every
  awaited PR on GitHub every tick.
- **Flow lookup cost (B/PERF-2).** `FleetFlowsController.get` calls `ProjectsService.findAllForPrincipal` and searches
  the list for the flow's project, so its cost grows with the caller's project count.
- **Note slug race (C/BUG-6).** `PrismaMemoryItemRepository.upsert` reads the active row and inserts a new one in a
  `Serializable` transaction. Two concurrent writers of the same slug both see no active row; the loser fails with a
  unique violation on `activeKey` or a serialization failure (`P2034`), which reaches the caller as a 500.
- **RUN token file (D/SEC-14, downgraded to LOW).** Since #395, `HostExecutor.runIdentityEnv` waits for a token with
  50 minutes of remaining life and writes it to `<jobDir>/forge-token`. nax reads and deletes that file at startup
  (`captureForgeIdentity`, nax >= 0.91.7), so a raw RUN agent cannot read it later, as the review first assumed. The
  remaining costs are real: the API ignores `fresh` for RUN, so a readopted RUN waits the full 120 s token wait and
  then starts without an identity (D/BUG-9), and a RUN longer than the token's life cannot publish. nax >= 0.91.8
  accepts `NAX_FORGE_IDENTITY=login-only`, in which nax uses the host's own `gh` credentials and only needs the
  login. On a runner those credentials come from the job's `gh` shim, which asks the credential socket for the job's
  token on every call. The owner ruled (2026-11-14) for the login-only identity.
- **Release and deploy (D/SEC-15, D/BUG-10).** `.github/workflows/release.yml` passes `TURBO_TOKEN` as a build-arg
  that neither Dockerfile declares, while the Dockerfiles read it from `--mount=type=secret,id=TURBO_TOKEN`. The
  compose files build `DATABASE_URL` by interpolating `POSTGRES_PASSWORD`, so a password with `@`, `:`, `/`, `?`,
  `#` or `%` breaks the URL and the stack never comes up.

## Design

### Calls made in this spec

- Tiers follow the owner's 2026-11-14 rulings. Other spend-adjacent keys keep their tier (see Out of Scope).
- The flow failure counts, the ticker cursor and the merge-watch timestamps live in process memory. The API is
  single-replica by ruling, so no column or migration is added. A restart resets them. Each store is bounded, as
  `.nax/rules/api-core.md` requires for in-memory maps:
  - failure counts: after a tick that started at `afterId` `null` and reached a short page (so it listed every
    advanceable flow), the ticker deletes the count of every flow id that tick did not list. A tick that resumed from
    a cursor prunes nothing, because it never saw the lower ids;
  - merge-watch timestamps: each time a timestamp is recorded, entries older than `flowMergePollMs` are deleted (an
    expired entry means the same as no entry);
  - the cursor is a single value.
- A merge watch records its timestamp only when `runMergeWatch` resolves with outcome `kind: 'watched'`. A watch
  that throws, or resolves `retry` (a transient forge or token failure) or `idle`, records nothing, so the next tick
  runs it again; a throwing watch therefore still reaches the 5-failure stop. A skipped watch resolves `advance`
  normally and resets the count, which is correct because a skip only follows a completed watch.
- The flow-lookup reach check keeps today's semantics exactly: a project is reachable when it is live and the caller
  either reads every project or holds an access binding for it, the same rule `findAllForPrincipal` applies, now
  evaluated for one project id. A global Owner or Admin returns at the `readsEveryProject` check without reading any
  project list; a caller with a `projectId`-null PROJECT binding still pays the `accessibleProjectIds` read, so the
  gain is largest for global admins and for callers with few bindings.
- The RUN identity is login-only only when the job's credential shim directory is on nax's `PATH`. Without the shim,
  nax's `gh` would use the operator's own `gh` login, so the RUN starts with no injected identity.
- A note upsert retries in a new transaction with the same jittered backoff as `runWithTicketNumberRetry`
  (`attempt * round(10 + 40 * random())` ms). Each attempt re-runs the whole transaction callback, including
  `beforeWrite`, `beforeSupersede` and `onWritten`; their writes belong to the failed transaction and roll back with
  it.
- The retry cannot sit on `PrismaService.withTransaction`: that method maps every `P*` error through
  `PrismaErrorMapper.map` (`@nathapp/nestjs-prisma` 4.1 `prisma.service.js`), so a P2002 arrives as a
  `PrismaAppException` `DUPLICATE_ENTRY` and a P2034 as an unidentifiable `DATABASE_ERROR`. The attempts run through
  the repository's transaction manager, `this.tx.run(callback, { isolationLevel: 'Serializable' })`, which joins the
  same AsyncLocalStorage `AuditRecorder` reads and passes errors through unmapped; the callback writes through
  `this.tx.getClient()`. The error that finally leaves `upsert` is mapped with `PrismaErrorMapper.map` when it is a
  `P*` error, so callers see the same exception shapes as before.

### Integration

Symbols this feature reads (verified at `774ada53`):

- `apps/api/src/approvals/approval-gate.service.ts`: a direct human satisfies every mode; only non-human callers open
  an approval request.
- `apps/api/src/fleet/jobs/fleet-jobs.controller.ts`: `POST projects/:slug/fleet/jobs` is `@ApprovalGated()` and runs
  through `ApprovalRouteGate`, which returns `202` with the pending request.
- `apps/api/src/action-context/action-context.ts` `runAsSystem(name, fn, { onBehalfOf })` and `currentContext()`.
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts`: private `writeStop`, `lockLive` (APPROVED or RUNNING),
  `lockWaitingMerge`, `activeFeature`, `orderedFeatures`, and `writeDecision`, which bounds `detail` to
  `FLOW_STOP_DETAIL_MAX` and records the `flow.stopped` activity.
- `apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts`
  `listAdvanceable(limit: number, afterId: string | null): Promise<AdvanceableFlow[]>` (id ascending).
- `apps/api/src/permissions/membership.queries.ts` `accessibleProjectIds(db, principal)`;
  `apps/api/src/projects/project-access.service.ts` `readsEveryProject(principal)`.
- `apps/api/src/common/utils/ticket-number-retry.ts` `runWithTicketNumberRetry` (retry in a NEW transaction; one
  attempt when `txManager.isInTransaction()`).
- Prisma 7 with `@prisma/adapter-pg` maps Postgres SQLSTATE `40001` and `40P01` to the driver error kind
  `TransactionWriteConflict`, which the client reports as `PrismaClientKnownRequestError` code `P2034`.
- `apps/runner/src/credentials/shim.ts` `tokenEnv('gh', reply)`: the `gh` shim sets `GH_TOKEN` from the job's
  credential-socket reply.
- nax `packages/nax/src/forge/identity.ts` `captureForgeIdentity`: `NAX_FORGE_IDENTITY=login-only` requires
  `NAX_FORGE_LOGIN` and refuses `NAX_FORGE_TOKEN_FILE`.

Symbols this feature changes. The baseline exists only to locate the code; it is never the interface to implement.

- `classifyRisk(key)` in `apps/api/src/permissions/catalog.ts`.
  - Baseline: `fleet.flow.start` and role-grant/role/policy keys `critical`; reads `low`; `CREDENTIAL_KEYS`, deletes
    and `HIGH_RISK_PREFIXES` `high`; everything else `medium`.
  - Target: additionally `fleet.thread.preapprove` is `critical`, and the members of a new exported
    `SPEND_AND_ACCOUNT_WRITE_KEYS: ReadonlySet<string>` (`fleet.job.dispatch`, `fleet.job.config.edit`,
    `fleet.schedule.create`, `user.update`) are `high`. `buildEntry` is unchanged.
- `FlowStopReason` in `apps/api/src/fleet/flows/flow-step-decision.ts` gains `'internal_error'`.
- `awaitedFeatures(flow)` in `apps/api/src/fleet/flows/fleet-flow-feature-passes.ts`.
  - Baseline: module-private.
  - Target: exported, unchanged otherwise. The same file gains an exported pure function
    `failureStopFeature(flow: FleetFlowRecord): FleetFlowFeatureRecord`: for a WAITING_MERGE flow the first awaited
    feature, otherwise the active feature, and in both cases the first feature by position when there is none.
- `FleetFlowAdvanceService` gains `stopFailedFlow(flowId: string, detail: string, now: Date): Promise<boolean>`. It
  reads the flow; for APPROVED or RUNNING it writes the stop through `writeStop`, for WAITING_MERGE it takes
  `lockWaitingMerge` and writes the stop through `writeDecision`, in both cases with reason `internal_error` and the
  feature `failureStopFeature` picks. It returns `true` when a stop was written and `false` when the flow is gone or
  in any other state. An empty `detail` is stored as `internal error`.
- `FleetFlowTicker.tick(now)` in `apps/api/src/fleet/flows/fleet-flow.ticker.ts`.
  - Baseline: `afterId = null` at the start of every tick; an advance error is only logged.
  - Target: the first `listAdvanceable` call of a tick uses the cursor the previous tick left: the last listed id
    after a tick that hit the page limit, `null` after a tick that reached a short page. A `listAdvanceable` that
    throws leaves the cursor unchanged. The ticker counts consecutive advance failures per flow id; a resolved advance
    deletes the count. When a count reaches the exported `FLOW_FAILURE_STOP_AFTER` (`5`), the ticker calls
    `engine.stopFailedFlow(flowId, <that error's message>, now)` inside the same
    `runAsSystem('flow', ..., { onBehalfOf: <flow creator> })` it uses for `advance`, and deletes the count when the
    call resolves. A rejected `stopFailedFlow` is logged and the count kept.
- `IFleetConfig` gains `flowMergePollMs: number`, read from `FLEET_FLOW_MERGE_POLL_MS` (default `120_000`), with the
  same validation as `FLEET_FLOW_TICK_MS`: an integer from `1_000` to `3_600_000` in the Joi schema
  (`env.validation.ts`) and an optional string in the env DTO (`fleet.config.ts`). The advance service's `FLEET_CFG`
  pick gains `'flowMergePollMs'`.
- `FleetFlowAdvanceService.advance(flowId, now)`.
  - Baseline: a WAITING_MERGE flow runs `runMergeWatch` on every call.
  - Target: it skips `runMergeWatch` when a timestamp recorded for the flow is less than `flowMergePollMs` before
    `now`. The timestamp is recorded (as `now`) only when `runMergeWatch` resolves with `kind: 'watched'`.
- `ProjectsService` gains `findReachableById(principal: KodaPrincipal, projectId: string): Promise<ProjectDomain | null>`:
  the live project when `readsEveryProject(principal)` or `accessibleProjectIds` for the principal includes it, else
  `null`. A new `PrismaProjectRepository.findLiveById(id)` and `isAccessible(principal: PrincipalRef, projectId)`
  back it.
- `FleetFlowsController.get(flowId, principal)`: calls `projects.findReachableById(principal, flow.projectId)`
  instead of scanning `findAllForPrincipal`. `null` gives `404 fleet.flows.notFound` with no permission probe; a
  reachable project without `fleet.flow.read` gives `403`, as today.
- `isSerializationFailure(error: unknown): boolean` (new, `apps/api/src/common/utils/prisma-errors.ts`): `true` for a
  `PrismaClientKnownRequestError` with code `P2034`.
- `PrismaMemoryItemRepository.upsert(item, options)`.
  - Baseline: one `withTransaction` attempt; any error propagates.
  - Target: each attempt runs through `this.tx.run(callback, { isolationLevel: 'Serializable' })`. When an attempt
    rejects with `isUniqueViolation(error, 'activeKey')` or `isSerializationFailure(error)`, it waits
    `protected retryDelay(attempt: number): Promise<void>` (which sleeps `memoryUpsertBackoffMs(attempt, Math.random)`
    ms) and runs again, up to the exported `MEMORY_UPSERT_MAX_ATTEMPTS` (`3`) attempts. Inside an outer transaction
    (`this.tx.isInTransaction()`) it makes one attempt. The error that leaves `upsert` is
    `PrismaErrorMapper.map(error)` for a `P*` error and the error itself otherwise. The exported pure function
    `memoryUpsertBackoffMs(attempt: number, random: () => number): number` returns
    `attempt * Math.round(10 + 40 * random())`.
- `HostExecutor.runIdentityEnv(job, jobDir)` in `apps/runner/src/executor/host-executor.ts`.
  - Baseline: a GitHub RUN waits for a fresh token, writes it with `writeReviewToken`, and returns
    `{ NAX_FORGE_TOKEN_FILE, NAX_FORGE_LOGIN }`.
  - Target: a GitHub RUN whose acquired credentials carry a `binDir` returns
    `{ NAX_FORGE_IDENTITY: 'login-only', NAX_FORGE_LOGIN: job.assign.gitIdentity.name }`, calls no fresh-token method
    and writes no file. A GitHub RUN with no `binDir` returns `{}` and logs `RUN starts without a forge identity`. A
    GitLab RUN returns `{}`. REVIEW and FIX keep `reviewEnv` unchanged. The `binDir` is passed in from the spawn path
    that already acquires credentials.
- `CREDENTIAL_ENV_VARS` in `apps/runner/src/credentials/credential-env.ts` also lists `NAX_FORGE_IDENTITY`.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| A flow's advance throws on fewer than 5 consecutive ticks | Logged as today; advanced again on the next tick. |
| A flow's advance throws on the 5th consecutive tick | `stopFailedFlow` writes `STOPPED`, `internal_error`, the error message as `stopDetail`. |
| `stopFailedFlow` itself rejects | Logged; the count is kept; the next failing tick calls it again; the tick goes on. |
| The flow left APPROVED, RUNNING and WAITING_MERGE before the stop | `stopFailedFlow` returns `false` and writes nothing. |
| `listAdvanceable` throws | The tick rejects as today and the cursor is unchanged. |
| A merge watch throws, or resolves `retry` or `idle` | No timestamp is recorded; the next tick runs the watch again. |
| A note upsert fails with any other error | Propagates on the first attempt. |
| A note upsert still conflicts after 3 attempts | The last error propagates. |
| A GitHub RUN has no credential shim directory | No identity is injected; the RUN starts and the runner logs `RUN starts without a forge identity`. |
| `POSTGRES_PASSWORD` unset, or has a character outside `A-Z a-z 0-9 . _ ~ -` | `deploy.sh` exits 1 before any backup, pull or migration and names the rule. |

## Out of Scope

- Retiering `fleet.schedule.update`, `fleet.schedule.enable`, `fleet.job.requeue` or any key other than the five named in this spec; they keep their current risk.
- A database column or migration for the flow failure counts, the ticker cursor or the merge-watch timestamps; they are in-memory because the API is single-replica by ruling.
- Web i18n labels for the `internal_error` stop reason; the web flow page and notifications fall back to `humanizeCode`, which renders "Internal error".
- Changing the REVIEW or FIX forge identity (token file plus bot login); only RUN moves to login-only.
- Making the API honour `fresh` for RUN token requests in `sync.service.ts`; the login-only RUN no longer asks for a fresh token.
- A runner check of the installed nax version; login-only needs nax >= 0.91.8, and the runner already runs 0.92.x.
- Splitting `fleet-flow-advance.service.ts` (1008 lines) below the 800-line limit; new flow-stop selection logic goes into `fleet-flow-feature-passes.ts` instead of growing the service further.
- US-007 only: retrying any memory write other than `PrismaMemoryItemRepository.upsert`, and more than 3 concurrent same-slug writers (a 4th racer can exhaust its attempts and receive the error).
- Percent-encoding `POSTGRES_PASSWORD` inside the compose files; the deploy script refuses an unsafe password instead.
- The repo-root `docker-compose.yml`, which also interpolates `POSTGRES_PASSWORD` into `DATABASE_URL`; it is the local development stack, and only `deployments/example` gets the password check.
- The remaining 2026-11-14 review items (P1 auth, deploy and webhook bundles, the other rulings).

## Stories

**US-001: Catalog tiers for agent spend and account writes.** Workdir: `apps/api`. No dependencies.
`classifyRisk` gives `high` to the members of `SPEND_AND_ACCOUNT_WRITE_KEYS` and `critical` to
`fleet.thread.preapprove`; the test mirror `expectedRisk` follows.

**US-002: Routes honour the new tiers.** Workdir: `apps/api`. Depends on US-001.
An agent calling the dispatch, schedule-create or admin user PATCH route with no approval policy now gets `202` and a
pending request; a human still runs at once. The existing agent-dispatch and agent-schedule tests move to the new
expectation.

**US-003: Stop a flow with internal_error.** Workdir: `apps/api`. No dependencies.
Adds `internal_error`, exports `awaitedFeatures`, adds `failureStopFeature` and `FleetFlowAdvanceService.stopFailedFlow`.

**US-004: Ticker failure count and cursor.** Workdir: `apps/api`. Depends on US-003.
The ticker counts consecutive failures, calls `stopFailedFlow` at 5 inside the flow's system context, prunes counts,
and resumes from the cursor the previous tick left.

**US-005: Merge-watch poll interval.** Workdir: `apps/api`. Depends on US-004.
Adds `flowMergePollMs` and the per-flow timestamp recorded after a successful watch.

**US-006: Direct flow project lookup.** Workdir: `apps/api`. No dependencies.
Adds `ProjectsService.findReachableById` and uses it in `FleetFlowsController.get`.

**US-007: Retry a note write that lost a race.** Workdir: `apps/api`. No dependencies.
Adds `isSerializationFailure` and the bounded, jittered retry in `PrismaMemoryItemRepository.upsert`.

**US-008: Login-only forge identity for GitHub RUN.** Workdir: `apps/runner`. No dependencies.
`runIdentityEnv` returns the login-only identity when the shim directory is set; `NAX_FORGE_IDENTITY` joins
`CREDENTIAL_ENV_VARS`.

**US-009: Release secret, deploy password check, review doc correction.** Workdir: `.`. No dependencies.
**No-test:** a CI workflow, a deploy shell script and a review document; no test loads them.

### Context Files

**US-001**
- `apps/api/src/permissions/catalog.ts` — `classifyRisk`, `HIGH_RISK_PREFIXES`, `buildEntry`.
- `apps/api/src/permissions/catalog.spec.ts` — the `expectedRisk` mirror.

**US-002**
- `apps/api/test/integration/permissions/enforce-fleet-jobs.integration.spec.ts` — the agent dispatch cases.
- `apps/api/test/integration/permissions/enforce-fleet-schedules.integration.spec.ts` — the agent schedule cases.
- `apps/api/test/integration/permissions/gated-admin-write-routes.integration.spec.ts` — the agent `user.update` pattern.
- `apps/api/src/fleet/jobs/fleet-jobs.controller.ts` — the dispatch route.

**US-003**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — `writeStop`, `lockWaitingMerge`, `writeDecision`.
- `apps/api/src/fleet/flows/fleet-flow-feature-passes.ts` — `awaitedFeatures`, `FeaturePassDeps.stopLocked`.
- `apps/api/src/fleet/flows/flow-step-decision.ts` — `FlowStopReason`.
- `apps/api/test/integration/fleet/fleet-flow-advance.integration.spec.ts` — the flow fixture pattern.

**US-004**
- `apps/api/src/fleet/flows/fleet-flow.ticker.ts` — the tick loop.
- `apps/api/src/fleet/flows/fleet-flow.ticker.spec.ts` — the harness and the action-context assertion pattern (AC-9/10).

**US-005**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — `advance`, the WAITING_MERGE branch.
- `apps/api/src/config/fleet.config.ts` — `flowTickMs` parsing and the env DTO.
- `apps/api/src/config/env.validation.ts` — the `FLEET_FLOW_TICK_MS` Joi rule.
- `apps/api/src/fleet/flows/fleet-flow-merge-watch.spec.ts` — the merge-watch harness.

**US-006**
- `apps/api/src/fleet/flows/fleet-flows.controller.ts` — `get`.
- `apps/api/src/projects/projects.service.ts` — `findAllForPrincipal`.
- `apps/api/src/projects/prisma-project.repository.ts` — `findAllAccessible`.
- `apps/api/src/permissions/membership.queries.ts` — `accessibleProjectIds`.

**US-007**
- `apps/api/src/memory/prisma-memory-item.repository.ts` — `upsert`.
- `apps/api/src/common/utils/prisma-errors.ts` — `isUniqueViolation`.
- `apps/api/src/common/utils/ticket-number-retry.ts` — the retry precedent.

**US-008**
- `apps/runner/src/executor/host-executor.ts` — `runIdentityEnv` and the spawn env assembly.
- `apps/runner/src/credentials/credential-env.ts` — `CREDENTIAL_ENV_VARS`.
- `apps/runner/src/credentials/shim.ts` — what the `gh` shim sets.

**US-009**
- `.github/workflows/release.yml` — the api and web build steps.
- `apps/api/Dockerfile` — the `TURBO_TOKEN` secret mount.
- `deployments/example/deploy.sh` — the pre-deploy checks.

### Creates

**US-003**
- `apps/api/test/integration/fleet/fleet-flow-failure-stop.integration.spec.ts` — `stopFailedFlow` against Postgres.

**US-005**
- `apps/api/src/fleet/flows/fleet-flow-merge-poll.spec.ts` — the merge-watch interval unit tests.

**US-007**
- `apps/api/test/integration/memory/memory-note-concurrent-upsert.integration.spec.ts` — concurrent same-slug writes.

### Modifies

**US-001**
- `apps/api/src/permissions/catalog.spec.ts` — the test's own `expectedRisk(key)` mirror of `classifyRisk`, checked against every catalog key, must return `critical` for `fleet.thread.preapprove` and `high` for `fleet.job.dispatch`, `fleet.job.config.edit`, `fleet.schedule.create` and `user.update`; every other key's expected risk stays.

**US-002**
- `apps/api/test/integration/permissions/enforce-fleet-jobs.integration.spec.ts` — AC-4, AC-5 and AC-6 expect a DEVELOPER agent's dispatch to return `201`; with `fleet.job.dispatch` at `high` it returns `202`. AC-4 now expects `202` with a pending `fleet.job.dispatch` request and no job row; AC-5 and AC-6 keep their stored-actor and activity assertions by seeding a `none` approval policy for the agent in their setup.
- `apps/api/test/integration/permissions/enforce-fleet-schedules.integration.spec.ts` — AC-5 and AC-6 expect an agent's schedule create to return `201`; AC-5 now expects `202` with a pending `fleet.schedule.create` request, and AC-6 keeps its stored-creator assertion by seeding a `none` approval policy for the agent.
- `apps/api/test/integration/fleet/gated-fleet-job-routes.integration.spec.ts` — AC-15 ("agent dispatch without a policy is immediate with no request") expects `201` and no approval request; with `fleet.job.dispatch` at `high` it returns `202`. It now expects `202`, exactly one pending `fleet.job.dispatch` request and no job row for feature `ac-15`.
- `apps/api/test/integration/fleet/permissions-assistant-tools.integration.spec.ts` — AC-6 ("an MCP dispatch naming p1 by a developer binding creates a QUEUED job requested by the agent") expects `koda_dispatch_job` to queue a job at once; the MCP write goes through the gate, so it now returns pending. The case seeds a `none` approval policy for `fleet.job.dispatch` for that agent in p1 and keeps its job assertions.
- `apps/api/test/integration/permissions/gated-admin-write-routes.integration.spec.ts` — gains a case for an agent's admin user PATCH with no seeded policy (this story's AC-5); the existing cases, which seed a wait policy, stay.

**US-003**
None. The added union member and exports break no closed-world assertion; the advance-service specs do not call the new method.

**US-004**
None. The ticker spec builds a fresh ticker per case, so no existing case spans two ticks of one instance.

**US-005**
- `apps/api/test/integration/fleet/fleet-flow-features.integration.spec.ts` — its ticks are 1 s apart on one app and re-tick a WAITING_MERGE flow expecting a fresh `getPullRequest`; set `FLEET_FLOW_MERGE_POLL_MS=1000` before `bootHttpApp` (and restore it after), so every 1 s tick still polls. It also gains this story's AC-8 case (a WAITING_MERGE flow whose `getPullRequest` throws on every call), reusing the file's fixtures.
- `apps/api/src/common/test-helpers/fleet-config.ts` — `testFleetConfig` returns a full `IFleetConfig`; add `flowMergePollMs: 0` so unit specs that use it never skip a merge watch.
- `apps/api/src/config/fleet.config.spec.ts` — the parsing and rejection tables gain `FLEET_FLOW_MERGE_POLL_MS` rows mirroring the `FLEET_FLOW_TICK_MS` rows.

**US-006**
- `apps/api/src/fleet/flows/fleet-flow-read-stop.spec.ts` — AC-4 and AC-5 stub `projects.findAllForPrincipal`; they now stub `projects.findReachableById` (AC-4 resolves the project, AC-5 resolves `null`) and keep their assertions, including "no permission probe" in AC-5.

**US-007**
- `apps/api/src/memory/prisma-memory-item.repository.additional.spec.ts` — its upsert cases stub `prisma.withTransaction`; they now stub the transaction manager's `run` (the mock already declares `isInTransaction`) and `getClient`, and keep their no-op, supersede and audit assertions.
- `apps/api/test/integration/memory/outbox-fanout-extraction.integration.spec.ts` — its `TRANSACTION_MANAGER` mock (`run: (fn) => fn()`) has no `getClient`, and the upsert now writes through `this.tx.getClient()`; the mock gains `getClient` returning the test's `mockPrismaClient`, keeping its assertions.

**US-008**
- `apps/runner/test/unit/host-executor.spec.ts` — the `Injection` harness hardcodes `binDir: null` in `acquire`; add an `Injection.binDir` option that the stub returns.
- `apps/runner/test/unit/host-executor.spec.ts` — "#395: a GitHub RUN hands nax a fresh token file and the bot login from gitIdentity" becomes: with a `binDir`, nax gets `NAX_FORGE_IDENTITY` `login-only` and the bot login, no `NAX_FORGE_TOKEN_FILE`, and no fresh-token call.
- `apps/runner/test/unit/host-executor.spec.ts` — "#395: a GitHub RUN whose fresh token is refused still starts, without the identity, and warns" becomes the no-`binDir` case: no `NAX_FORGE_IDENTITY`, no `NAX_FORGE_LOGIN`, the warning logged, nax started.
- `apps/runner/test/unit/host-executor.spec.ts` — "#395: a GitHub RUN whose start fails removes the token file and propagates the error" becomes: a failed start of a GitHub RUN propagates the error, and no token file exists.
- `apps/runner/test/unit/host-executor.spec.ts` — "#395: a GitHub RUN whose token wait was cancelled (runner stopping) starts nothing" is removed: a RUN no longer waits for a token.
- `apps/runner/test/unit/host-executor.spec.ts` — "#395: a GitHub RUN with no fresh-token provider starts without the identity and warns" becomes: with a `binDir` and no fresh-token provider, the RUN still gets the login-only identity and logs no warning.
- `apps/runner/test/unit/host-executor.spec.ts` — "#395: a GitHub RUN whose token file cannot be written still starts, without the identity, and warns" is removed: a RUN writes no token file.
- `apps/runner/test/unit/host-executor.spec.ts` — "#395: cleanup removes a GitHub RUN token file nax never consumed" becomes: cleanup of a GitHub RUN finds no token file to remove.
- `apps/runner/test/unit/host-executor.spec.ts` — "AC-9: a %s RUN never passes an inherited NAX_FORGE_TOKEN_FILE through", github row: now expects no `NAX_FORGE_TOKEN_FILE` at all; the gitlab row stays.
- `apps/runner/src/credentials/credential-env.spec.ts` — the list of stripped variables gains `NAX_FORGE_IDENTITY`.

**US-009**
- `.github/workflows/release.yml` — remove the `TURBO_TOKEN=` line from both `build-args` blocks and add `secrets: |` with `TURBO_TOKEN=${{ secrets.TURBO_TOKEN }}` to both build steps.
- `deployments/example/deploy.sh` — add the `POSTGRES_PASSWORD` check to the pre-deploy safety checks.
- `deployments/example/README.md` — document the allowed `POSTGRES_PASSWORD` characters.
- `docs/20261114-review-whole-repo.md` — record D/SEC-14 as downgraded to LOW wherever it is listed or discussed as MEDIUM, update the MEDIUM and LOW counts, and correct the D gap row that says "See SEC-14" for the TURBO token to "See SEC-15".

### Seams

- US-003 creates `FleetFlowAdvanceService.stopFailedFlow`; US-004 stubs it and drives it from `FleetFlowTicker.tick`, the entry point the interval calls (US-004 AC-3).
- US-003 creates `failureStopFeature`; `stopFailedFlow` consumes it in the same story, driven through `stopFailedFlow` (US-003 AC-4).
- US-005 consumes US-004's count: a throwing merge watch must reach the stop through the real `tick` and `advance` (US-005 AC-8).
- US-006 creates `ProjectsService.findReachableById`, consumed by `FleetFlowsController.get` in the same story; driven through `GET /api/fleet/flows/:flowId` (US-006 AC-1).
- US-007 creates `isSerializationFailure`, consumed by `upsert` in the same story; driven through `upsert` (US-007 AC-5).

## Acceptance Criteria

### US-001

- AC-1 [unit] `findCatalogEntry('fleet.job.dispatch')` returns `risk: 'high'` and `approval.default: 'agent'`.
- AC-2 [unit] `findCatalogEntry('fleet.job.config.edit')` returns `risk: 'high'` and `approval.default: 'agent'`.
- AC-3 [unit] `findCatalogEntry('fleet.schedule.create')` returns `risk: 'high'` and `approval.default: 'agent'`.
- AC-4 [unit] `findCatalogEntry('user.update')` returns `risk: 'high'` and `approval.default: 'agent'`.
- AC-5 [unit] `findCatalogEntry('fleet.thread.preapprove')` returns `risk: 'critical'` and `approval.floor: 'human'`.
- AC-6 [unit] `findCatalogEntry('fleet.thread.preapprove').principals` equals `['user', 'agent']`.
- AC-7 [unit] `SPEND_AND_ACCOUNT_WRITE_KEYS` is importable from `permissions/catalog.ts` with exactly the members `fleet.job.dispatch`, `fleet.job.config.edit`, `fleet.schedule.create` and `user.update`.
- AC-8 [unit] `findCatalogEntry('fleet.schedule.update').risk` and `findCatalogEntry('fleet.job.requeue').risk` are both `'medium'`.

### US-002

- AC-1 [integration] An agent holding `fleet.job.dispatch` in the project, with no approval policy seeded, calling `POST /api/projects/:slug/fleet/jobs` with a valid RUN body gets `202` with a pending request whose `permissionKey` is `fleet.job.dispatch`.
- AC-2 [integration] After that `202`, no `FleetJob` row exists for the request.
- AC-3 [integration] A user holding `fleet.job.dispatch`, with no approval policy seeded, calling the same route with the same body gets `201`.
- AC-4 [integration] An agent holding `fleet.schedule.create` in the project, with no approval policy seeded, calling `POST /api/projects/:slug/fleet/schedules` with a valid body gets `202` with a pending `fleet.schedule.create` request.
- AC-5 [integration] An agent holding `user.update` globally, with no approval policy seeded, calling `PATCH /api/admin/users/:id` with `{ "disabled": true }` gets `202` with a pending `user.update` request, and the target user's `disabled` stays `false`.

### US-003

- AC-1 [integration] `stopFailedFlow(flowId, 'boom', now)` on a RUNNING flow returns `true`.
- AC-2 [integration] After that call the flow row has `state` `STOPPED`, `stopReason` `internal_error` and `stopDetail` `boom`.
- AC-3 [integration] After that call a `flow.stopped` activity row exists for the flow.
- AC-4 [integration] `stopFailedFlow` on a WAITING_MERGE flow returns `true` and leaves the row with `state` `STOPPED` and `stopReason` `internal_error`.
- AC-5 [integration] `stopFailedFlow` on a flow already in state `STOPPED` returns `false` and leaves its `stopReason` and `endedAt` unchanged.
- AC-6 [unit] `failureStopFeature` on a WAITING_MERGE flow whose features are MERGED at position 0 and awaiting at position 1 returns the position-1 feature.
- AC-7 [unit] `failureStopFeature` on a RUNNING flow with no active feature returns the feature at the lowest position.
- AC-8 [integration] `stopFailedFlow(flowId, '', now)` on a RUNNING flow stores `stopDetail` `internal error`.
- AC-9 [unit] `awaitedFeatures` is importable from `fleet-flow-feature-passes.ts` and returns the awaiting features of a flow in position order.

### US-004

- AC-1 [unit] `FLOW_FAILURE_STOP_AFTER` is importable from `fleet-flow.ticker.ts` and equals `5`.
- AC-2 [unit] With `engine.advance` rejecting for flow `F` on 4 consecutive `tick` calls, `engine.stopFailedFlow` is never called.
- AC-3 [unit] With `engine.advance` rejecting for flow `F` with message `boom-5` on the 5th consecutive `tick`, `engine.stopFailedFlow` is called once with `('F', 'boom-5', now)`.
- AC-4 [unit] Inside that `stopFailedFlow` call, `currentContext()` reports the system writer `flow` acting on behalf of the flow's creator.
- AC-5 [unit] Four rejecting ticks for `F`, one resolving tick, then four rejecting ticks call `engine.stopFailedFlow` zero times.
- AC-6 [unit] After `engine.stopFailedFlow` resolves for `F`, one more rejecting tick for `F` does not call `stopFailedFlow`.
- AC-7 [unit] When `engine.stopFailedFlow` rejects for `F`, `tick` resolves and still advances the next listed flow `G` in that tick.
- AC-8 [unit] After a rejected `stopFailedFlow` for `F`, the next rejecting tick for `F` calls `stopFailedFlow` again.
- AC-9 [unit] Five rejecting ticks for `F` interleaved with resolving advances for `G` call `stopFailedFlow` for `F` only.
- AC-10 [unit] A flow `F` with 4 recorded failures that a tick starting at `afterId` `null` and ending on a short page does not list, then listed and rejecting again, needs 5 more rejecting ticks before `stopFailedFlow` is called.
- AC-14 [unit] A flow `F` with 4 recorded failures that a tick resumed from a non-null cursor does not list keeps its count: the next rejecting tick for `F` calls `stopFailedFlow`.
- AC-11 [unit] After a tick whose `listAdvanceable` calls returned 10 full pages, the next tick's first `listAdvanceable` call has `afterId` equal to the id of the last flow of the 10th page.
- AC-12 [unit] After a tick whose `listAdvanceable` returned a short page, the next tick's first `listAdvanceable` call has `afterId` `null`.
- AC-13 [unit] After a tick in which `listAdvanceable` threw, the next tick's first `listAdvanceable` call has the same `afterId` as the tick that threw.

### US-005

- AC-1 [unit] `fleetConfig()` with `FLEET_FLOW_MERGE_POLL_MS` unset returns `flowMergePollMs: 120000`.
- AC-2 [unit] `fleetConfig()` with `FLEET_FLOW_MERGE_POLL_MS=60000` returns `flowMergePollMs: 60000`.
- AC-3 [unit] Env validation rejects `FLEET_FLOW_MERGE_POLL_MS=999` and `FLEET_FLOW_MERGE_POLL_MS=3600001`.
- AC-4 [unit] Two `advance` calls for one WAITING_MERGE flow with a resolving merge watch, the second `flowMergePollMs - 1` ms after the first, call `getPullRequest` on the first call only.
- AC-5 [unit] Two such calls, the second exactly `flowMergePollMs` ms after the first, call `getPullRequest` on both.
- AC-6 [unit] When the first `advance` for a WAITING_MERGE flow rejects because `getPullRequest` throws a non-forge `Error`, a second `advance` 1 ms later calls `getPullRequest` again.
- AC-7 [unit] `advance` for WAITING_MERGE flow `A` and then immediately for WAITING_MERGE flow `B` calls `getPullRequest` for both.
- AC-9 [unit] When the first `advance` for a WAITING_MERGE flow ends with merge-watch outcome `retry` (the PR read fails with `provider_unreachable`), a second `advance` 1 ms later calls `getPullRequest` again.
- AC-8 [integration] In `fleet-flow-features.integration.spec.ts`, driving the real `FleetFlowTicker.tick` with `FLEET_FLOW_MERGE_POLL_MS=1000`, ticks 1 s apart, and a WAITING_MERGE flow whose `getPullRequest` stub throws a non-forge `Error` on every call, the flow reaches `state` `STOPPED` with `stopReason` `internal_error` on the 5th tick.

### US-006

- AC-1 [integration] `GET /api/fleet/flows/:flowId` by a project member holding `fleet.flow.read` returns `200` with the flow's project slug.
- AC-2 [integration] `GET /api/fleet/flows/:flowId` by a user with no access binding to the flow's project returns `404` with `fleet.flows.notFound`.
- AC-3 [integration] `GET /api/fleet/flows/:flowId` for a flow whose project is soft-deleted returns `404` with `fleet.flows.notFound`.
- AC-4 [integration] `GET /api/fleet/flows/:flowId` by a member holding `project.read` but not `fleet.flow.read` returns `403`.
- AC-5 [unit] `FleetFlowsController.get` calls `projects.findReachableById(principal, flow.projectId)` and never calls `projects.findAllForPrincipal`.
- AC-6 [integration] `ProjectsService.findReachableById` for an agent with a project-scoped binding in project `P` returns `P`, and for the same agent and a project `Q` it has no binding in returns `null`.
- AC-7 [integration] `ProjectsService.findReachableById` for a global Admin user returns any live project and `null` for a soft-deleted one.

### US-007

- AC-1 [unit] `MEMORY_UPSERT_MAX_ATTEMPTS` is importable from `prisma-memory-item.repository.ts` and equals `3`.
- AC-2 [unit] `isSerializationFailure` returns `true` for a `PrismaClientKnownRequestError` with code `P2034`.
- AC-3 [unit] `isSerializationFailure` returns `false` for a `PrismaClientKnownRequestError` with code `P2002`.
- AC-4 [unit] When the transaction manager's first `run` rejects with a raw `P2002` unique violation on `activeKey` and the second resolves, `upsert` resolves with the second attempt's item.
- AC-5 [unit] When the first `run` rejects with a raw `P2034` error and the second resolves, `upsert` resolves after exactly 2 `run` calls, each with `isolationLevel` `Serializable`.
- AC-6 [unit] When all three `run` calls reject with a raw `P2002` violation on `activeKey`, `upsert` rejects after exactly 3 `run` calls with a `PrismaAppException` whose `code` is `DUPLICATE_ENTRY`.
- AC-7 [unit] When `run` rejects with a raw `P2003` foreign-key error, `upsert` rejects after exactly 1 `run` call with a `PrismaAppException` whose `code` is `INVALID_REFERENCE`.
- AC-8 [unit] When `isInTransaction()` is `true` and `run` rejects with a raw `P2002` violation on `activeKey`, `upsert` rejects after exactly 1 `run` call.
- AC-9 [unit] When the first `run` rejects with a raw `P2034` error, `upsert` calls `retryDelay(1)` once before the second `run`.
- AC-10 [unit] `memoryUpsertBackoffMs(2, () => 0.5)` returns `60`.
- AC-11 [integration] Three concurrent `upsert` calls for one project note slug with identical fields all resolve, and exactly one active row has that `activeKey` afterwards.
- AC-12 [integration] Two concurrent `upsert` calls for one project note slug with different descriptions both resolve, exactly one active row has that `activeKey`, and the other row has `status` `superseded`.

### US-008

- AC-1 [unit] Spawning a GitHub RUN whose credentials acquire returns a `binDir` passes nax an env with `NAX_FORGE_IDENTITY` `login-only` and `NAX_FORGE_LOGIN` equal to `job.assign.gitIdentity.name`.
- AC-2 [unit] Spawning that GitHub RUN passes no `NAX_FORGE_TOKEN_FILE` and never calls `credentials.freshToken`.
- AC-3 [unit] Spawning that GitHub RUN leaves no `forge-token` file in the job directory.
- AC-4 [unit] Spawning a GitHub RUN whose credentials acquire returns no `binDir` passes nax neither `NAX_FORGE_IDENTITY` nor `NAX_FORGE_LOGIN`, starts nax, and logs `RUN starts without a forge identity`.
- AC-5 [unit] Spawning a GitLab RUN passes nax neither `NAX_FORGE_IDENTITY` nor `NAX_FORGE_LOGIN`.
- AC-6 [unit] Spawning a REVIEW job still passes `NAX_FORGE_TOKEN_FILE` and the bot login as `NAX_FORGE_LOGIN`, and no `NAX_FORGE_IDENTITY`.
- AC-7 [unit] `withoutCredentialVars({ NAX_FORGE_IDENTITY: 'login-only', HOME: '/h' })` returns `{ HOME: '/h' }`.

### US-009

- AC-1 [review] `.github/workflows/release.yml`, api image build step: `build-args` has no `TURBO_TOKEN` entry, and the step has a `secrets` input with `TURBO_TOKEN=${{ secrets.TURBO_TOKEN }}`.
- AC-2 [review] `.github/workflows/release.yml`, web image build step: `build-args` has no `TURBO_TOKEN` entry, and the step has a `secrets` input with `TURBO_TOKEN=${{ secrets.TURBO_TOKEN }}`.
- AC-3 [review] `deployments/example/deploy.sh`: before the pre-deploy backup, the script takes `POSTGRES_PASSWORD` from the environment when set (compose gives the environment precedence), else from the `.env` file's `POSTGRES_PASSWORD=` line with surrounding quotes and any trailing `# comment` removed.
- AC-4 [review] `deployments/example/deploy.sh`: when that value is empty or has a character outside `A-Z a-z 0-9 . _ ~ -`, the script prints a message naming the allowed characters and exits 1 before the backup.
- AC-5 [review] `deployments/example/README.md`, the `POSTGRES_PASSWORD` line: it states the allowed characters and that `deploy.sh` refuses others.
- AC-6 [review] `docs/20261114-review-whole-repo.md`: every place that lists or discusses D/SEC-14 as MEDIUM (the consolidation notes, the summary, the MEDIUM index, the rulings, the Priority Fix Order and the area D finding heading) marks it downgraded to LOW, with the reason that nax reads and deletes the token file at startup.
- AC-7 [review] `docs/20261114-review-whole-repo.md`: the findings index reads `MEDIUM (2 new)` and `LOW (15 new)`.
- AC-8 [review] `docs/20261114-review-whole-repo.md`, area D gap table: the TURBO token row refers to SEC-15.
