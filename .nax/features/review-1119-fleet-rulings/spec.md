# SPEC: Review 2026-11-14 fleet rulings (forced job sandbox, disabled runner credentials and held jobs)

## Summary

This feature implements two owner rulings of 2026-11-19 on open items of the 2026-11-14 whole-repo review
(`docs/20261114-review-whole-repo.md`, "Rulings needed"). Both were re-checked against main `670c3070e` on 2026-11-19.

1. **Ruling 3 (D/SEC-2, sandbox for raw kinds).** The runner forces nax's OS sandbox on for RUN, REVIEW, FIX and AGENT
   jobs through the per-job profile, and refuses such a job on a host whose sandbox probe failed.
2. **Ruling 5 (B/SEC-4, disabled runner).** A disabled runner is refused git tokens and provider keys, and disabling a
   runner requests cancellation of the jobs it holds.

The other rulings of the same review are in the sibling feature `review-1119-data-rulings` and in hand edits.

## Motivation

- `apps/runner/src/executor/job-profile.ts` `jobProfileContent` writes no `execution.sandbox` key, so whether REVIEW,
  FIX, RUN and AGENT agents run sandboxed depends on each runner host's global nax config.
- `apps/api/src/fleet/sync/sync.service.ts` `grantTokens` and `grantProviderKeys` never check `Runner.enabled`, and
  `RunnersService.update` only flips the flag. A disabled runner gets no new work (placement reads `enabled`), but it
  keeps receiving credentials for the jobs it holds, and those jobs keep running.

## Design

### Calls made in this spec

- **Sandbox kinds.** The forced set is exactly RUN, REVIEW, FIX and AGENT, read from `job.assign.command`. PLAN,
  CONFIG_EDIT, CONFIG_DRIFT and THREAD keep today's behaviour.
- **Sandbox key.** nax reads its OS sandbox from `execution.sandbox` (`{ enabled, network }`), a root-only key the job
  profile may set: the profile already sets the root-only `execution.bashApproval`. The overlay sets only
  `execution.sandbox.enabled: true`; nax deep-merges profiles, so the host's `execution.sandbox.network` allowlist is
  kept.
- **Sandbox refusal.** `NaxJobCheck.check` resolves the job's own profile chain (`assign.profiles`), which never
  includes the koda job profile. For a forced kind it treats the requirement as `sandbox: true` whatever the chain
  reports, so a host whose last capability report has `sandbox.available: false` refuses the job with the existing
  reason `capability mismatch: sandbox`. With no report yet (`capabilities()` null) the check passes, as today.
- **Disabled runner, refusal order.** Inside each grant loop the order is: unknown job, fence (stale epoch queues the
  ABANDON), not runner-held (`job_not_active`), then the disabled check, then the existing branches. For git tokens
  those are the `repoId` branch, the THREAD WORKSPACE/PROJECT branch and the default repo, and the disabled check
  applies to every one. For provider keys the disabled check sits inside `providerRefusalOf`, after the state check and
  before the vault check, so a disabled runner with the vault off gets `job_not_active`, not `vault_off`.
- **Disabled runner, reasons.** A git-token refusal carries reason `runner_disabled` (`GitTokenError.reason` is a free
  string). The string is one exported constant `RUNNER_DISABLED_REASON` in `fleet-jobs.service.ts`, beside
  `PROJECT_DELETED_REASON`, used by the sync refusal and by `cancelForRunnerDisabled`. A provider-key refusal carries `job_not_active`, because `ProviderKeyErrorReason` is a closed union in
  `packages/fleet-protocol` and this feature does not change that package. The runner does not branch on either.
- **Disabled runner, snapshot.** `enabled` is read once per sync from `recordRunnerSync`. A disable that commits
  during that sync takes effect on the runner's next sync.
- **Disabled runner, jobs.** An `enabled: true -> false` change in `RunnersService.update` calls
  `FleetJobsService.cancelForRunnerDisabled(runnerId, responsibleUserId, now)` inside the update's transaction,
  after `updateRunner` has written `enabled: false`. Placement locks the runner row and re-reads `enabled`, so writing
  the flag first means a job placed concurrently either sees the runner disabled or is already held and is cancelled.
  It mirrors `cancelForBudget` (`fleet-jobs.service.ts`):
  - It acts on the runner's held jobs (`findRunnerHeld`) whose command is RUN, PLAN, REVIEW, FIX, THREAD or AGENT,
    the same set budget hard stops use. CONFIG_EDIT and CONFIG_DRIFT jobs are left to finish.
  - An ASSIGNED job whose ASSIGN command is still pending ends CANCELLED on the server, with reason
    `runner_disabled`.
  - An acked ASSIGNED job, or a RUNNING one, gets `cancelRequestedAt`, `cancelReason: 'runner_disabled'`, a CANCEL
    command at its `leaseEpoch`, and a `job.cancel_requested` activity. The actor is SYSTEM and the responsible user
    is the one who disabled the runner.
  - UPLOADING jobs, and jobs whose `cancelRequestedAt` is already set, are skipped.
  - It returns `{ cancelled, requested, live, wake }`.
  - After the transaction commits, `RunnersService.update` publishes `live` through `FleetJobLivePublisher` and calls
    `RunnerNotifier.notify` for each id in `wake`.
  - Re-enabling a runner cancels nothing.

### Integration

Symbols this feature only reads (verified at `670c3070e`):

- `apps/runner/src/capabilities/job-check.ts` `firstMismatch(requirements, caps, credentials)`: it returns
  `'capability mismatch: sandbox'` when `requirements.sandbox && !caps.sandbox.available`.
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` `findRunnerHeld(runnerId): Promise<FleetJobRecord[]>`.
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` `cancelForBudget(jobIds, policy, now)`, the pattern to mirror.
- `apps/api/src/fleet/budgets/budget-evaluator.ts` `evaluate`: it publishes `live` and notifies woken runners after its
  `txManager.run` returns.
- `apps/api/src/fleet/jobs/fleet-jobs.module.ts` exports `FleetJobsService`, `FleetJobLivePublisher` and
  `RunnerNotifier`, and does not import `RunnersModule`.

Symbols this feature changes. The baseline only locates the code; implement the target.

- `jobProfileContent` and `writeJobProfile` (`apps/runner/src/executor/job-profile.ts`)
  - Baseline: `jobProfileContent(outputDir, projectName, relay?, botCostLimitUsd?, modelAliases?, context?, publishPr?)`.
  - Target: a trailing `sandbox?: boolean`. When `true`, the result's `execution` holds `sandbox: { enabled: true }`,
    merged with the relay's `bashApproval` and `approvalTimeout` when a relay is present. `writeJobProfile` takes and
    passes the same trailing argument.
- `NaxJobCheck.check` (`apps/runner/src/capabilities/job-check.ts`)
  - Target: when `job.assign.command` is RUN, REVIEW, FIX or AGENT, `firstMismatch` receives the parsed requirements
    with `sandbox: true`.
- `HostExecutor` (`apps/runner/src/executor/host-executor.ts`)
  - Target: both `writeJobProfile` calls (in `prepare`, and in the FIX step) pass `sandbox: true` for a forced kind.
- `PrismaFleetJobRepository.recordRunnerSync`
  - Baseline: returns `{ previousBootId } | null`.
  - Target: returns `{ previousBootId, enabled } | null`.
- `SyncService.sync`, `grantTokens` and `grantProviderKeys`
  - Target: the grant methods receive `enabled` and apply the disabled check in the order above.
- `FleetJobsService` gains `cancelForRunnerDisabled(runnerId: string, responsibleUserId: string, now?: Date)`.
- `RunnersService`
  - Target: the constructor appends `FleetJobsService`, `FleetJobLivePublisher` and `RunnerNotifier`.
  - Target: `update` calls `cancelForRunnerDisabled` as above.
  - `RunnersModule` imports `FleetJobsModule`.

### Failure Handling

| Case | Behaviour |
|---|---|
| Forced kind on a host whose last report has `sandbox.available: false` | `prepare` fails with `capability mismatch: sandbox` before nax starts |
| No capability report yet | the check passes, as today |
| Git token request from a disabled runner | `gitTokenErrors` entry with reason `runner_disabled`; nothing minted |
| Provider key request from a disabled runner | `providerKeyErrors` entry with reason `job_not_active`; nothing issued or recorded |
| A held job already has `cancelRequestedAt` when its runner is disabled | skipped |

## Out of Scope

- Adding `runner_disabled` to `ProviderKeyErrorReason` in `packages/fleet-protocol`.
- A per-runner or per-repo opt-out from the forced sandbox.
- Forcing the sandbox for PLAN, CONFIG_EDIT, CONFIG_DRIFT or THREAD jobs.
- Placement awareness of the forced sandbox: `placement-rules.ts` still approximates from the job's profiles, and the runner's job check is the refusal point.
- Re-reading `Runner.enabled` inside the grant transaction: a disable that commits during a sync takes effect on the next sync.
- Revoking credentials already issued to a runner before it was disabled: they stay valid until they expire.
- Cancelling QUEUED jobs pinned to a disabled runner, its UPLOADING jobs, or its CONFIG_EDIT and CONFIG_DRIFT jobs.
- An HTTP-level integration test of `PATCH /fleet/runners/:id` with a held job.

## Stories

The feature is two independent ruled fixes sharing the fleet runtime. Four stories keep each under the 15-assertion
gate.

**US-001: Force the sandbox for RUN, REVIEW, FIX and AGENT jobs.** Workdir: `apps/runner`. No dependencies.

**US-002: Refuse credentials to a disabled runner.** Workdir: `apps/api`. No dependencies.

**US-003: Cancel a disabled runner's held jobs.** Workdir: `apps/api`. No dependencies.
Adds `FleetJobsService.cancelForRunnerDisabled`.

**US-004: Disabling a runner cancels its held jobs.** Workdir: `apps/api`. Depends on US-003.
`RunnersService.update` calls `cancelForRunnerDisabled` and publishes after commit.

### Context Files

**US-001**
- `apps/runner/src/executor/job-profile.ts`
- `apps/runner/src/capabilities/job-check.ts`
- `apps/runner/src/executor/host-executor.ts`

**US-002**
- `apps/api/src/fleet/sync/sync.service.ts`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts`
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `IFleetJobRepository.recordRunnerSync` gains the `enabled` return field

**US-003**
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts`

**US-004**
- `apps/api/src/fleet/runners/runners.service.ts`
- `apps/api/src/fleet/runners/runners.module.ts`
- `apps/api/src/fleet/budgets/budget-evaluator.ts`
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `cancelForRunnerDisabled` created by US-003, called here

### Creates

None.

### Modifies

**US-001**
- `apps/runner/src/capabilities/job-check.spec.ts` — its shared `CAPS` reports `sandbox.available: false` and its default row is a RUN job, so every case expecting `null` would now get `capability mismatch: sandbox`; the shared `CAPS` becomes `sandbox.available: true`, and the existing sandbox-unavailable case keeps its own unavailable capabilities and still expects the mismatch.
- `apps/runner/test/unit/host-executor.spec.ts` — the gated RUN case asserts `profile.execution` equals `{ bashApproval: 'gated', approvalTimeout: 60_000 }`; a RUN job's profile now also carries `sandbox: { enabled: true }`, so the expected object gains that key.

**US-002**
- `apps/api/src/fleet/sync/sync-provider-credentials.spec.ts` — `recordRunnerSync` is stubbed as `{ previousBootId: 'b1' }`; it must return `{ previousBootId: 'b1', enabled: true }` so the existing cases keep describing an enabled runner.
- `apps/api/src/fleet/sync/sync.service.token-purpose.spec.ts` — `recordRunnerSync` is stubbed as `{ previousBootId: ... }`; it must also return `enabled: true` so the existing cases keep describing an enabled runner.
- `apps/api/src/fleet/sync/sync-token-fence.spec.ts` — `recordRunnerSync` is stubbed as `{ previousBootId: 'b1' }` (twice); it must also return `enabled: true` so the existing cases keep describing an enabled runner.

**US-004**
- `apps/api/src/fleet/runners/runners.service.spec.ts` — the positional `new RunnersService(...)` construction gains stubs for `FleetJobsService`, `FleetJobLivePublisher` and `RunnerNotifier`; its existing `enabled: false` update case now also sees one `cancelForRunnerDisabled` call.

### Seams

- US-004 consumes US-003's `FleetJobsService.cancelForRunnerDisabled`. The entry point is `RunnersService.update`. US-004's ACs stub the method and assert it is called only on a true -> false change.

## Acceptance Criteria

### US-001

- AC-1 [unit] `jobProfileContent('/out', 'p', undefined, undefined, undefined, undefined, undefined, true)` returns an object whose `execution` is `{ sandbox: { enabled: true } }`.
- AC-2 [unit] `jobProfileContent` called with a gated relay overlay and `sandbox` `true` returns an `execution` whose `sandbox` is `{ enabled: true }`.
- AC-3 [unit] In the AC-2 case, the returned `execution.bashApproval` is the relay's `bashMode`.
- AC-4 [unit] `NaxJobCheck.check` for a job whose `assign.command` is `RUN`, whose resolved chain reports `sandbox: false`, on a host whose last capability report has `sandbox.available: false`, returns `capability mismatch: sandbox`.
- AC-5 [unit] `NaxJobCheck.check` in the AC-4 setup with `assign.command` `REVIEW` returns `capability mismatch: sandbox`.
- AC-6 [unit] `NaxJobCheck.check` in the AC-4 setup with `assign.command` `FIX` returns `capability mismatch: sandbox`.
- AC-7 [unit] `NaxJobCheck.check` in the AC-4 setup with `assign.command` `AGENT` returns `capability mismatch: sandbox`.
- AC-8 [unit] `NaxJobCheck.check` in the AC-4 setup with `assign.command` `PLAN` returns `null` (regression guard).
- AC-9 [unit] `NaxJobCheck.check` for a RUN job whose `capabilities()` answers `null` returns `null` (regression guard).
- AC-10 [unit] `HostExecutor.prepare` for a RUN job writes a job profile whose `execution.sandbox.enabled` is `true`.
- AC-11 [unit] `HostExecutor.prepare` for a PLAN job writes a job profile with no `execution.sandbox` key (regression guard).
- AC-12 [unit] The FIX step of a FIX job writes a job profile whose `execution.sandbox.enabled` is `true`.

### US-002

- AC-1 [integration] `PrismaFleetJobRepository.recordRunnerSync` for a runner row with `enabled: false` returns `enabled: false`.
- AC-2 [unit] `SyncService.sync` for a disabled runner with a token request for a RUNNING job it holds returns a `gitTokenErrors` entry `{ jobId, reason: 'runner_disabled' }`.
- AC-3 [unit] In the AC-2 case, `GitTokenBroker.mint` is never called.
- AC-4 [unit] `SyncService.sync` for a disabled runner with a token request carrying a `repoId` for a RUNNING THREAD job it holds returns a `gitTokenErrors` entry with reason `runner_disabled`.
- AC-5 [unit] `SyncService.sync` for a disabled runner with a provider-key request for a RUNNING job it holds returns a `providerKeyErrors` entry with reason `job_not_active`.
- AC-6 [unit] In the AC-5 case, `ProviderCredentialsService.issueKey` is never called.
- AC-7 [unit] In the AC-5 case, no `credential.issued` activity is recorded.
- AC-8 [unit] `SyncService.sync` for a disabled runner whose token request carries a stale `leaseEpoch` queues the fence's ABANDON and returns no `runner_disabled` entry for that job.
- AC-9 [unit] `SyncService.sync` for an enabled runner with the AC-2 token request calls `GitTokenBroker.mint` once for that job (regression guard).
- AC-10 [unit] `SyncService.sync` for a disabled runner with a token request (no `repoId`) for a RUNNING THREAD job whose token scope is `PROJECT` returns a `gitTokenErrors` entry with reason `runner_disabled`.
- AC-11 [unit] `SyncService.sync` for a disabled runner with the vault off and a provider-key request for a RUNNING job it holds returns reason `job_not_active`.

### US-003

- AC-1 [unit] `cancelForRunnerDisabled('r1', 'u1')` for a held RUNNING RUN job sets its `cancelRequestedAt`.
- AC-2 [unit] In the AC-1 case, the job's `cancelReason` becomes `runner_disabled`.
- AC-3 [unit] In the AC-1 case, a CANCEL command is created for runner `r1` at the job's `leaseEpoch`.
- AC-4 [unit] In the AC-1 case, a `job.cancel_requested` activity is recorded with actor type `SYSTEM`, `responsibleUserId` `u1`, and payload reason `runner_disabled`.
- AC-5 [unit] In the AC-1 case, the returned `wake` holds `r1` and the returned `requested` holds the job id.
- AC-6 [unit] `cancelForRunnerDisabled` for a held ASSIGNED job whose ASSIGN command is still pending applies the transition to `CANCELLED` with reason `runner_disabled`, and returns the job id in `cancelled`.
- AC-7 [unit] `cancelForRunnerDisabled` skips a held RUNNING job whose `cancelRequestedAt` is already set.
- AC-8 [unit] `cancelForRunnerDisabled` leaves a held UPLOADING job unchanged.
- AC-9 [unit] `cancelForRunnerDisabled` leaves a held RUNNING CONFIG_EDIT job unchanged.
- AC-10 [unit] `cancelForRunnerDisabled` sets `cancelRequestedAt` on a held RUNNING THREAD job.

### US-004

- AC-1 [unit] `RunnersService.update(actorId, id, { enabled: false })` on an enabled runner calls `FleetJobsService.cancelForRunnerDisabled` once with `id` and `actorId`, after the repository's `updateRunner` call.
- AC-2 [unit] `RunnersService.update(actorId, id, { enabled: false })` on a runner that is already disabled does not call `cancelForRunnerDisabled`.
- AC-3 [unit] `RunnersService.update(actorId, id, { enabled: true })` on a disabled runner does not call `cancelForRunnerDisabled`.
- AC-4 [unit] `RunnersService.update(actorId, id, { labels: ['x'] })` does not call `cancelForRunnerDisabled`.
- AC-5 [unit] After a disabling update whose `cancelForRunnerDisabled` returns one live event, `FleetJobLivePublisher.publish` receives that event after the update's transaction resolved.
- AC-6 [unit] After a disabling update whose `cancelForRunnerDisabled` returns `wake: ['r1']`, `RunnerNotifier.notify` is called with `r1`.
