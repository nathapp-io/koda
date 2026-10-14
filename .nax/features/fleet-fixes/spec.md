# SPEC: Fleet Fixes — Runner Test Isolation, Config Clone Cleanup, Email Delays, Requeue Guard, Approvals Polish

## Summary

One fix bundle that closes four koda issues: #275 (runner tests spawn the real `ps`), #238 (config jobs leave the runner
clone on their branch; Requeue is offered where it can only repeat the failure), #247 (`EMAIL_DELAY_SEC` /
`EMAIL_APPROVAL_DELAY_SEC` are parsed but ignored) and #198 (approvals web polish: timeout parser and the delivery-watch
clock). Four stories, one per package area: runner tests (US-001), runner config-job cleanup (US-002), API (US-003) and
web (US-004).

The items of these issues that have no runtime behaviour to test were applied by hand on this branch before the spec
(commit `507aa43b`): the `postgres-test` restart policy (#275), the nax config breadcrumb leaf (#238), the `ScheduleDto`
spec fixtures, `BASH_MODES satisfies readonly BashMode[]`, the typed `bashAsk` E2E fixture and a docs rewrap (#198). No
story repeats them.

## Motivation

- **#275.** `HostExecutor.matchesProcess` and `HostExecutor.reap` reach `readProcessCommand` / `readProcessStart` in
  `apps/runner/src/executor/pid-registry.ts`, which spawn `ps`. In a nax sandboxed session on macOS `ps` cannot be
  spawned (`EPERM`, nax#2520), so the HostExecutor unit tests fail in every runner story and the PR carries a
  cannot-verify item.
- **#238.** `runConfigJob` (`apps/runner/src/executor/config-job/config-job.ts`) checks out `nax-config/<jobId>` to
  commit and push, and never goes back: after four config jobs the sandbox clone was on a `nax-config/...` branch with
  three stale local branches and their remote-tracking refs; an `invalid` job left a rejected untracked rule file. And
  the job page offers **Requeue** on a config edit job that failed `conflict` or `invalid`, although the requeue re-runs
  the same edits: each edit pins the file's `baseSha`, so a `conflict` recurs every time, and the same edits fail lint
  the same way. **Reopen edits** is the action that can succeed.
- **#247.** `emailConfig()` parses `EMAIL_DELAY_SEC` / `EMAIL_APPROVAL_DELAY_SEC` into `delaySec` / `approvalDelaySec`,
  but `NotificationWriter.delayMs` uses the constants `EMAIL_DELAY_SEC = 300` / `EMAIL_APPROVAL_DELAY_SEC = 60` from
  `apps/api/src/email/email.constants.ts`. Setting either variable has no effect.
- **#198.** `parseTimeoutMinutes` accepts leading zeros (`05`). `ApprovalInbox.vue`'s `awaitingDelivery()` compares the
  browser clock with the server-set `decidedAt`, so client/server skew widens or narrows the 10-minute D295 window.

## Design

### Rulings (user, 2026-10-14)

- **R1 — Requeue guard is web + API.** A config edit job whose result outcome is `conflict` or `invalid` cannot be
  requeued: the web hides Requeue and the API answers 409. Only `mode === 'edit'`; a `regenerate` or `drift` job keeps
  Requeue (a newer default branch can change its result).
- **R2 — Delivery watch on one clock.** The D295 window starts when this browser first sees the open approval waiting
  for delivery, measured with the browser clock only. `decidedAt` is no longer read for it. No server-clock API.
- **R3 — #206 is not in this bundle** (blocked on nax#2356).

### Integration

> Symbols marked **Baseline** exist today only to locate the code; implement the **Target**.

**Runner (US-001)**

- `apps/runner/src/executor/pid-registry.ts` — read-only: `readProcessStart(pid: number): Promise<Date | null>`,
  `readProcessCommand(pid: number): Promise<string | null>`, `reapNaxPids(input: { repoDir: string; since: Date;
  startedAt?: (pid: number) => Promise<Date | null>; kill?: (pid: number) => void }): Promise<number[]>`.
  Target additions in the same file:

  ```ts
  /** The two process lookups the executor needs; production reads them from `ps`. */
  export interface ProcessInfo {
    start(pid: number): Promise<Date | null>;
    command(pid: number): Promise<string | null>;
  }
  export const PS_PROCESS_INFO: ProcessInfo = { start: readProcessStart, command: readProcessCommand };
  ```

- `apps/runner/src/executor/host-executor.ts` — `HostExecutorDeps`.
  Baseline: no process lookup field. Target: gains `readonly processInfo?: ProcessInfo;` (unset means
  `PS_PROCESS_INFO`).
- `HostExecutor.matchesProcess(job: JobRow): Promise<boolean>`.
  Baseline: calls `readProcessCommand(job.pid)`. Target: calls `processInfo.command(job.pid)`; the matching rules are
  unchanged (a config job matches its clone path or `configBranchName(jobId)`, any other job matches
  `jobProfileName(jobId)`; a null pid or a null command is false).
- `HostExecutor.reap(job: JobRow, since: Date): Promise<void>`.
  Baseline: `reapNaxPids({ repoDir, since })`. Target: `reapNaxPids({ repoDir, since, startedAt: processInfo.start })`.

**Runner (US-002)**

- `apps/runner/src/executor/config-job/config-job.ts` — `runConfigJob(deps: ConfigJobDeps, job: JobRow, dirs:
  ConfigJobDirs, ctx: ConfigJobContext): Promise<ConfigJobRun>`. Signature unchanged. Target: after the existing
  try/catch decides the `ConfigJobRun`, a cleanup step always runs before it is returned (see "Config clone cleanup").
- `apps/runner/src/executor/config-job/commit-push.ts` — read-only: `configBranchName(jobId)` (`nax-config/<jobId>`),
  `commitAndPushConfig` (does `checkout -B <branch>` then `push --force origin HEAD:refs/heads/<branch>`).
- `apps/runner/src/executor/config-job/checkout.ts` — read-only: `prepareConfigCheckout` (the pre-job checkout:
  `checkout -f --detach <sha of origin/<defaultBranch>>`).
- `apps/runner/src/executor/git.ts` — read-only: `Git.run(args, { cwd, timeoutMs?, credentialHelper? })`, `Git.ok`.
- `runConfigJob` is called by `HostExecutor.runConfigJob`, which the supervisor's `JobRun` calls while it holds the repo
  mutex for the clone, so the cleanup can never overlap another job on the same clone.

**API (US-003)**

- `apps/api/src/notifications/notification-writer.ts` — `NotificationWriter`, constructor already takes
  `email: EmailAvailability`.
  Baseline: `private delayMs(kind)` returns `EMAIL_APPROVAL_DELAY_SEC` (approval request) or `EMAIL_DELAY_SEC` seconds
  from `email.constants.ts`. Target: returns `this.email.config().approvalDelaySec` (for `APPROVAL_REQUESTED_KIND`) or
  `this.email.config().delaySec`, in milliseconds; the file no longer imports the two constants.
- `apps/api/src/email/email-availability.ts` — read-only: `EmailAvailability.config(): IEmailConfig`.
- `apps/api/src/config/email.config.ts` — Baseline: `intEnv('EMAIL_DELAY_SEC', 300, ...)`,
  `intEnv('EMAIL_APPROVAL_DELAY_SEC', 60, ...)`. Target: the fallbacks are the constants `EMAIL_DELAY_SEC` /
  `EMAIL_APPROVAL_DELAY_SEC` from `email.constants.ts` (still 300 / 60), so the constants are the config defaults only.
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `FleetJobsService.requeue(actorId, projectId, jobId):
  Promise<DispatchResultDto>`. Signature unchanged. Target: inside the existing `txManager.run`, after the THREAD-kind
  refusal and before the budget check, a config job (`isConfigKind(current.command)`) is refused when
  `this.configEdits.findByJobId(jobId)` returns an edit with `mode === 'edit'` and an outcome of `conflict` or
  `invalid`, where the outcome is `edit.result?.outcome ?? current.configResult?.outcome`. The refusal is
  `new ConflictAppException({ outcome }, 'fleet.configRequeue')`. The service already injects
  `@Inject(CONFIG_EDIT_REPOSITORY) configEdits: Pick<IConfigEditRepository, 'findByJobId'>`.
- `apps/api/src/i18n/en/fleet.json`, `apps/api/src/i18n/zh/fleet.json` — gain `"configRequeue": { "409": ... }` next to
  `"jobState"`, with an `{outcome}` placeholder (en: "This config edit failed with {outcome}; reopen the edits instead of
  requeueing").

**Web (US-004)**

- `apps/web/lib/fleet-jobs.ts` — `canRequeueJob`.
  Baseline: `canRequeueJob(job: Pick<FleetJobDto, 'state'>, viewer: JobViewer): boolean`. Target:
  `canRequeueJob(job: Pick<FleetJobDto, 'state' | 'configEdit'>, viewer: JobViewer): boolean`, false additionally when
  `job.configEdit?.mode === 'edit'` and `job.configEdit.result?.outcome` is `conflict` or `invalid`. Its caller
  `pages/[project]/fleet/jobs/[id]/index.vue` already passes the whole job.
- `apps/web/lib/fleet-bash-mode.ts` — `parseTimeoutMinutes(input: string): number | null`; `MINUTES_RE` today is
  `/^\d{1,2}(?:\.\d{1,2})?$/`. Target: the integer part is `0` or has no leading zero.
- `apps/web/components/fleet/ApprovalInbox.vue` — `awaitingDelivery()` and `DELIVERY_WATCH_MS = 600_000`.
  Baseline: elapsed = `Date.now() - Date.parse(detail.decidedAt)`. Target: per R2 (see "Delivery watch").
- Read-only: `deliveryView` (`apps/web/lib/fleet-approvals.ts`), `FleetJobConfigEditDto` / `ConfigJobOutcomeDto`
  (`apps/web/lib/fleet-types.ts`).

### Config clone cleanup (US-002)

A new module `apps/runner/src/executor/config-job/cleanup.ts` exports
`restoreConfigClone(git: Git, repoDir: string, defaultBranch: string, jobId: string): Promise<string | null>`
(null on success, otherwise a short failure reason). `runConfigJob` calls it once, after the outcome is decided, for
every outcome (`ok`, `no_changes`, `push_failed`, `pr_failed`, `conflict`, `invalid`, `drift`, `timeout`, `failed`,
`stopped`). In order:

1. Resolve `origin/<defaultBranch>` with `resolveRef` (`apps/runner/src/executor/refs.ts`, as `prepareConfigCheckout`
   does); only `kind: 'remote-branch'` counts as resolved. When it resolves, `checkout -f --detach <that sha>`.
2. When step 1 did not resolve, or its checkout failed, `checkout -f --detach HEAD` (detach at the current commit,
   dropping local changes), so the job branch is never left checked out. Either case is reported as a cleanup failure.
3. `clean -ffd` (no `-x`: gitignored files stay).
4. `branch -D nax-config/<jobId>` when that local branch exists (git refuses this while the branch is checked out,
   which step 2 prevents).
5. `update-ref -d refs/remotes/origin/nax-config/<jobId>` when that ref exists.

Each git call uses a fixed timeout `CLEANUP_TIMEOUT_MS = 30_000` (the job's own budget may be spent, as on `timeout`).
The branch on origin is never touched: it is the PR head. A failing step does not stop the later steps; any failure
is reported to `ctx.step` as `cleanup failed: <reason>` and never changes the returned `ConfigJobRun`.

### Delivery watch (US-004)

`ApprovalInbox.vue` keeps one watch record `{ id: string; startedAt: number } | null`. `detail` is assigned in two
places, `loadDetail` (a fetched detail) and `onDecide` (the decided approval returned by the decide call); both go
through the record rule, for example through one `watch(detail)` or one helper called at both sites:

- When the new detail is waiting for delivery (`deliveryView(detail)?.state === 'waiting'`) and the record is null or
  names another approval id, the record becomes `{ id: detail.id, startedAt: Date.now() }`.
- `awaitingDelivery()` is true when the open detail is waiting and `Date.now() - record.startedAt < DELIVERY_WATCH_MS`.
  If the open detail is waiting but the record is null or names another id, it starts the record now and returns true.
- `decidedAt` is not read.

Intentional consequences: closing and reopening the same approval keeps its record (no new window); opening another
approval and coming back starts a new window, and so does a page reload. Each costs at most a few extra GETs, the
same D295 bound.

### Failure Handling

| Case | Behaviour | Story |
|---|---|---|
| A cleanup git step fails | Later steps still run; `ctx.step('cleanup failed: <reason>')`; the job's result is unchanged | US-002 |
| `origin/<defaultBranch>` does not resolve at cleanup, or its checkout fails | Fallback `checkout -f --detach HEAD`; reported as a cleanup failure; branch and ref deletion still run | US-002 |
| Requeue of a config job with no `FleetConfigEdit` row, or a row with no result | Requeued as today | US-003 |
| A `ProcessInfo.command` lookup returns null | `matchesProcess` is false (unchanged) | US-001 |

## Out of Scope

- #206 (blank job phase): koda's side shipped in #219/#220; the rest is nax#2356. No change here.
- #238 item 1 (broken rule frontmatter not caught): fixed upstream in nax 0.83.6 (`nax rules lint` exits 1 on invalid frontmatter); no koda-side lint gate is added.
- #198 item 2 (E2E deny-button timing headroom): changed only if CI flakes; not touched.
- The `postgres-test` restart policy, the nax config breadcrumb leaf and its i18n key, the `ScheduleDto` spec fixtures, `BASH_MODES satisfies readonly BashMode[]`, the typed `bashAsk` E2E fixture and the `docs/deployment/runner.md` rewrap were applied by hand in commit `507aa43b`; no story edits those lines.
- Deleting `nax-config/<jobId>` branches on origin or closing their PRs: the remote branch is the PR head and stays.
- US-002 only: local `nax-config/*` branches and remote-tracking refs left by config jobs that ran before this change are not pruned; each job cleans up only its own branch.
- US-003 only: the requeue guard covers only `mode === 'edit'` with outcome `conflict` or `invalid`; `regenerate` and `drift` jobs and every other outcome requeue as today.
- US-003 only: the requeue route's OpenAPI 409 description is unchanged (it already says "Job not requeueable"), so `openapi.json` and the generated CLI client are not regenerated.
- US-003 only: `env.validation.ts` validation of `EMAIL_DELAY_SEC` / `EMAIL_APPROVAL_DELAY_SEC` and their 0..86400 range in `email.config.ts` are unchanged.
- US-004 only: no server-clock endpoint or server-time field; the delivery watch uses the browser clock only (R2).
- US-004 only: the job page keeps its existing Reopen edits link (`ConfigJobPanel.vue`); no new action is added.
- Production process lookups keep using `ps`; `readProcessStart` / `readProcessCommand` behaviour is unchanged.

## Stories

1. **US-001: Runner process lookups are injectable; unit tests need no `ps`** — `Workdir: apps/runner` — no dependencies. Closes #275 (item 1).
2. **US-002: Config jobs return the runner clone to the default branch** — `Workdir: apps/runner` — depends on US-001 (both edit `test/unit/config-job.spec.ts`). Closes #238 (item 2).
3. **US-003: Email delays come from config; config requeue guard** — `Workdir: apps/api` — no dependencies. Closes #247 and the API half of #238 item 4.
4. **US-004: Requeue hidden for unrecoverable config edits; approvals polish** — `Workdir: apps/web` — no dependencies. Closes the web half of #238 item 4 and #198 items 3-4.

### Context Files

> Existing files to read or change.

**US-001**

- `apps/runner/src/executor/pid-registry.ts` — `readProcessStart`, `readProcessCommand`, `reapNaxPids`, `selectReapable`; gains `ProcessInfo` / `PS_PROCESS_INFO`
- `apps/runner/src/executor/host-executor.ts` — `HostExecutorDeps`, `matchesProcess`, `reap`
- `apps/runner/test/unit/host-executor.spec.ts` — `world()` builds `HostExecutor` deps
- `apps/runner/test/unit/config-job.spec.ts` — the D486 `matchesProcess` test

**US-002**

- `apps/runner/src/executor/config-job/config-job.ts` — `runConfigJob`, `ConfigJobDeps`
- `apps/runner/src/executor/config-job/commit-push.ts` — `configBranchName`, `commitAndPushConfig`
- `apps/runner/src/executor/config-job/checkout.ts` — `prepareConfigCheckout`, the pattern for resolving origin's default branch
- `apps/runner/src/executor/refs.ts` — `resolveRef` and its `kind` values
- `apps/runner/test/unit/config-job.spec.ts` — `world()`, fake nax and fake gh setup for config jobs
- `apps/runner/test/helpers/git-fixture.ts` — `makeOrigin`, `pushCommit`, `git`

**US-003**

- `apps/api/src/notifications/notification-writer.ts` — `delayMs`
- `apps/api/src/notifications/notification-writer.spec.ts` — `setup()` stubs and dueAt assertions
- `apps/api/src/config/email.config.ts` — `emailConfig`, `intEnv`
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `requeue`, `configEditFor`
- `apps/api/src/fleet/jobs/fleet-jobs.thread-requeue.spec.ts` — direct-instantiation pattern for `FleetJobsService` requeue tests

**US-004**

- `apps/web/lib/fleet-jobs.ts` — `canRequeueJob`
- `apps/web/tests/lib/fleet-jobs.spec.ts` — `job()` / viewer fixtures
- `apps/web/lib/fleet-bash-mode.ts` — `parseTimeoutMinutes`, `MINUTES_RE`
- `apps/web/components/fleet/ApprovalInbox.vue` — `awaitingDelivery`, `loadDetail`, `toggle`
- `apps/web/tests/components/fleet-approval-inbox.spec.ts` — `mount()`, `bashRow()`, `m.poll()` pattern for the D295 tests

### Creates

**US-001**

- `apps/runner/test/integration/process-info.integration.spec.ts` — the real-`ps` checks, including the describes moved from `src/executor/pid-registry.spec.ts` together with the helpers they use (`entry`, `tmp`, `waitFor`, `isProcessAlive`)

**US-002**

- `apps/runner/src/executor/config-job/cleanup.ts` — `restoreConfigClone`

**US-003**

- `apps/api/src/fleet/jobs/fleet-jobs.config-requeue.spec.ts` — the requeue guard tests

**US-004**

None.

### Modifies

**US-001**

- `apps/runner/test/unit/host-executor.spec.ts` — the lifecycle test `prepare, spawn, watch the files, verdict, ledger, bundle, cleanup` asserts `matchesProcess` against the real `ps`; it now builds the executor with a fake `processInfo` whose `command(pid)` returns the spawned command, keeping the same three expectations (true for the job, false for another job id, false for a null pid).
- `apps/runner/test/unit/config-job.spec.ts` — the test `matchesProcess (D486): the clone path or the job branch in argv` spawns `sh` and reads its command with the real `ps`; it now injects a fake `processInfo.command` that returns a command containing the clone path, keeping its three expectations.
- `apps/runner/src/executor/pid-registry.spec.ts` — the describes `readProcessCommand`, `readProcessStart (BUG-5a: TZ-independent)` and `reapNaxPids with real processes` spawn the real `ps` inside the runner's default unit run; they move unchanged into the new integration spec process-info.integration.spec.ts (Creates), and the pure `parsePidEntries` and `selectReapable` describes stay in this file.

**US-002**

- `apps/runner/test/unit/config-job.spec.ts` — `world()` builds the `HostExecutor` with a fixed `git: createGit()`; it gains an optional `git` override so a test can pass a `Git` that fails one call, and the new cleanup tests are added. The existing assertions in this file and in the config-jobs integration spec on outcomes, pushed branches and PRs stay valid.

**US-003**

- `apps/api/src/notifications/notification-writer.spec.ts` — `setup()` stubs `EmailAvailability` as `{ configured: true }`; the writer now calls `email.config()`, so the stub gains `config()` returning `delaySec: 300` and `approvalDelaySec: 60`, and the existing 300 s / 60 s dueAt expectations stay as they are.

**US-004**

- `apps/web/tests/components/fleet-approval-inbox.spec.ts` — the test `a decided ask whose decidedAt is ahead of the clock is not re-fetched forever (D295 clock guard)` expects no re-fetch for a `decidedAt` in 2099; under R2 `decidedAt` is ignored and the ask is re-fetched while the watch is open, so the test now asserts the replacement invariant: the far-future `decidedAt` is re-fetched on the next poll, and no longer once the browser clock passes 10 minutes after the detail was first seen waiting.

### Seams

None across stories. `ProcessInfo` / `PS_PROCESS_INFO` (US-001) and `restoreConfigClone` (US-002) are consumed only
inside their own story, each through the production entry point named in its ACs (`HostExecutor.matchesProcess` /
`HostExecutor.reap`; `HostExecutor.runConfigJob`).

## Acceptance Criteria

### US-001: Runner process lookups are injectable; unit tests need no `ps`

1. [unit] `HostExecutor.matchesProcess` for a RUN job with `pid` 4242 calls the injected `processInfo.command` with 4242 and returns true when it returns a command containing `jobProfileName(jobId)`.
2. [unit] `HostExecutor.matchesProcess` for a RUN job returns false when the injected `processInfo.command` returns `nax run --profile koda-job-other` (the profile of another job).
3. [unit] `HostExecutor.matchesProcess` returns false when the injected `processInfo.command` returns null.
4. [unit] `HostExecutor.matchesProcess` for a job whose `pid` is null returns false without calling the injected `processInfo.command`.
5. [unit] `HostExecutor.matchesProcess` for a CONFIG_EDIT job returns true when the injected command contains the job's clone directory, and true when it contains `configBranchName(jobId)` instead.
6. [unit] `HostExecutor.reap(job, since)` with a `.nax-pids` entry registered after `since` for the job's clone calls the injected `processInfo.start` with that entry's pid.
7. [unit] `HostExecutor.reap` does not kill a registered pid when the injected `processInfo.start` returns null for it.
8. [unit] `HostExecutor.reap` kills a registered child process (spawned by the test) when the injected `processInfo.start` returns its registration time.
9. [unit] `PS_PROCESS_INFO.start` is `readProcessStart` and `PS_PROCESS_INFO.command` is `readProcessCommand`.
10. [integration] `readProcessCommand(process.pid)` returns a non-empty string, and `readProcessStart(process.pid)` returns a `Date` that is not later than now.
11. [integration] `readProcessCommand` and `readProcessStart` return null for a pid that does not exist.

Verification note: the runner's default unit run (`bun test src test/unit`, including `src/executor/pid-registry.spec.ts`, `test/unit/host-executor.spec.ts` and `test/unit/config-job.spec.ts`) passes with a failing `ps` stub (exits non-zero) first on `PATH`; the real-`ps` checks run in `bun run test:integration`.

### US-002: Config jobs return the runner clone to the default branch

1. [unit] After `HostExecutor.runConfigJob` ends an edit job with outcome `ok`, the clone's HEAD is detached at the commit of `origin/<defaultBranch>`.
2. [unit] After an `ok` edit job, the clone has no local branch `nax-config/<jobId>`.
3. [unit] After an `ok` edit job, the clone has no ref `refs/remotes/origin/nax-config/<jobId>`.
4. [unit] After an `ok` edit job, the origin repository still has the branch `nax-config/<jobId>` at the job's `resultSha`.
5. [unit] After an edit job ends `pr_failed`, the clone has no local `nax-config/<jobId>` branch, and the returned result still carries `resultBranch: nax-config/<jobId>`.
6. [unit] After an edit job ends `invalid` because nax lint rejects a new rule file, the clone's HEAD is detached at `origin/<defaultBranch>` and the rejected file is absent from the working tree.
7. [unit] An untracked file written into the clone after `prepareConfigJob` and before an edit job that ends `conflict` is absent after the job, and the clone's HEAD is detached at `origin/<defaultBranch>`.
8. [unit] An edit job stopped during its slow nax `generate` call, after its edits were applied, ends `stopped`, and afterwards the edited file in the clone has its `origin/<defaultBranch>` content.
9. [unit] A gitignored file present in the clone before an `invalid` edit job is still present after it.
10. [unit] An `ok` edit job run through `HostExecutor.runConfigJob` with a `Git` that, armed after `prepareConfigJob` returns, fails only the call `checkout -f --detach <sha of origin/<defaultBranch>>` still returns outcome `ok` with the same `resultPrUrl`.
11. [unit] The same run (the `checkout -f --detach <sha>` call failing) reports a step starting with `cleanup failed:` through `ctx.step`.
12. [unit] The same run (the `checkout -f --detach <sha>` call failing) leaves the clone's HEAD detached and the local branch `nax-config/<jobId>` deleted.
13. [unit] `restoreConfigClone`, on a clone whose HEAD is on `nax-config/<jobId>` and where `refs/remotes/origin/<defaultBranch>` was deleted, returns a non-null reason, leaves HEAD detached and deletes the local branch `nax-config/<jobId>`.

### US-003: Email delays come from config; config requeue guard

1. [unit] `NotificationWriter`, with `EmailAvailability.config()` returning `delaySec: 30`, schedules the email of a non-approval notification with `dueAt` equal to its `createdAt` plus 30 seconds.
2. [unit] `NotificationWriter`, with `EmailAvailability.config()` returning `approvalDelaySec: 5`, schedules the email of an `APPROVAL_REQUESTED_KIND` notification with `dueAt` equal to its `createdAt` plus 5 seconds.
3. [unit] With `EMAIL_DELAY_SEC=45` in the environment, a `NotificationWriter` built on an `EmailAvailability` backed by `emailConfig()` schedules a non-approval notification's email with `dueAt` equal to `createdAt` plus 45 seconds.
4. [unit] `FleetJobsService.requeue` for a FAILED `CONFIG_EDIT` job whose config edit has `mode: 'edit'` and result outcome `conflict` throws `ConflictAppException` with key `fleet.configRequeue` and params `{ outcome: 'conflict' }`.
5. [unit] `FleetJobsService.requeue` for a FAILED `CONFIG_EDIT` job whose edit has `mode: 'edit'` and result outcome `invalid` throws `ConflictAppException` with key `fleet.configRequeue` and params `{ outcome: 'invalid' }`.
6. [unit] A requeue refused with `fleet.configRequeue` performs no job state transition and no placement.
7. [unit] `FleetJobsService.requeue` for a FAILED `CONFIG_EDIT` job whose edit has `mode: 'edit'` and outcome `push_failed` moves the job to QUEUED.
8. [unit] `FleetJobsService.requeue` for a FAILED config job whose edit has `mode: 'drift'` and outcome `invalid` moves the job to QUEUED.
9. [unit] `FleetJobsService.requeue` for a FAILED config job whose edit row is missing, or whose edit has no result and no `configResult` on the job, moves the job to QUEUED.
10. [unit] `FleetJobsService.requeue` reads the outcome from the job's `configResult` when the edit's `result` is null.

Verification note: `email.config.ts` taking its 300 / 60 fallbacks from the `email.constants.ts` constants is a refactor with no behaviour change; it is covered by `bun run type-check` and the existing `email.config.spec.ts` defaults test.

### US-004: Requeue hidden for unrecoverable config edits; approvals polish

1. [unit] `canRequeueJob` for a FAILED job whose `configEdit` has `mode: 'edit'` and `result.outcome` `conflict` returns false for a DEVELOPER viewer.
2. [unit] `canRequeueJob` for a FAILED job whose `configEdit` has `mode: 'edit'` and `result.outcome` `invalid` returns false for a DEVELOPER viewer.
3. [unit] `canRequeueJob` for a FAILED job whose `configEdit` has `mode: 'edit'` and `result.outcome` `push_failed` returns true for a DEVELOPER viewer.
4. [unit] `canRequeueJob` for a FAILED job whose `configEdit` has `mode: 'drift'` and `result.outcome` `invalid` returns true for a DEVELOPER viewer.
5. [unit] `canRequeueJob` for a FAILED job with `configEdit: null` returns true for a DEVELOPER viewer.
6. [unit] `parseTimeoutMinutes` returns null for `05` and for `00.5`.
7. [unit] `parseTimeoutMinutes` returns 30 for `0.5` and 600 for `10`.
8. [unit] The approvals inbox, opened on a decided escalate ask waiting for delivery whose `decidedAt` is in 2099, fetches that approval's detail again on the next poll.
9. [unit] The approvals inbox, opened on a decided escalate ask waiting for delivery whose `decidedAt` is one year in the past, fetches that approval's detail again on the next poll.
10. [unit] Once the browser clock is 600 000 ms past the moment the inbox first loaded a waiting detail, the next poll does not fetch that approval's detail again.
11. [unit] After the window of ask A has passed, opening a different ask B that is waiting for delivery makes the next poll fetch B's detail again.
12. [unit] After the user allows an escalate ask in the inbox and the decided detail returned by the decide call is waiting for delivery with `decidedAt` `2026-10-03T10:05:00.000Z` (long before the test clock), the next poll fetches that approval's detail again.
13. [unit] An opened escalate ask whose delivery is `delivered` is not fetched again on the next poll.
