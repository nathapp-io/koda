# SPEC: Fleet PR review jobs (S6 K1, part A)

## Summary

koda can run `nax bot review <pr>` on a fleet runner as the `koda-fleet` GitHub App. A new fleet job
kind `REVIEW` carries a PR number and is dispatched through the existing dispatch route
(`POST /projects/:slug/fleet/jobs`). The runner checks out the repository's default branch detached,
writes the job's App token to a file that nax deletes on startup (`NAX_FORGE_TOKEN_FILE`), names the
App's bot login (`NAX_FORGE_LOGIN`), runs the review, and reports the job `COMPLETED` once nax reports
that the review posted. Only runners whose nax accepts an injected forge identity take `REVIEW` jobs.
Automatic dispatch on new PR heads is part B (feature `fleet-auto-review`), specified separately.

## Motivation

`nax bot review` reviews a PR, remembers its own earlier findings and threads, and (nax feature
`bot-forge-identity`, "K0") accepts a caller-supplied forge identity: `NAX_FORGE_TOKEN_FILE` (a file nax
reads and deletes at startup) and `NAX_FORGE_LOGIN`. The fleet design (§9.122, "S6 = K1 + K2") puts the
review loop in koda: koda owns the bot identity (the `koda-fleet` App, whose key lives only in koda),
triggers reviews, and later (K2) feeds project decisions in and stores review outcomes as memory.
Nothing in koda can run a review today:

- the fleet job kinds are `RUN`, `PLAN`, `CONFIG_EDIT`, `CONFIG_DRIFT`, `THREAD`; `DispatchFleetJobDto`
  accepts only `RUN` and `PLAN`;
- the runner builds only `nax plan` / `nax run` argv, and its checkout refuses any non-PLAN job without a
  `prd.json` (`executor/checkout.ts`, `checkout: no prd.json at ref`);
- the runner never gives nax a forge identity (rule D88: the credential shim serves `gh` and `git`).

## Design

### Calls made in this spec

1. **Token file (narrow exception to D88).** nax K0 rejects a login without a token file, and a GitHub
   App token cannot answer "who am I". For `REVIEW` only, the runner writes the job's current token to
   `<jobDir>/forge-token` (created with mode `0600`) and passes its path in `NAX_FORGE_TOKEN_FILE`. nax
   reads and deletes the file at startup; the runner removes a leftover when the spawn fails, at job
   cleanup, and in the attempt wipe. The token is never put in an environment variable or argv. The
   runner rule in `.nax/mono/apps/runner/context.md` ("A git token never goes to ... a file ...") already
   names this exception (amended on this branch before the run).
2. **One active review per PR, through the existing index.** A `REVIEW` job's `feature` is
   `review-pr-<number>`. The partial unique index `FleetJob_active_repo_feature_key` (`(repoId, feature)`
   over `QUEUED/ASSIGNED/RUNNING/UPLOADING`) already makes a second active job on one feature a 409. `RUN`
   and `PLAN` may no longer use a feature that starts with `review-pr-`.
3. **K0 detection.** The runner reports `botReview: true` only when nax has `bot review` and honours the K0
   contract: `<naxCommand> bot review --help` exits 0, and `<naxCommand> --version` run with
   `NAX_FORGE_TOKEN=probe` added to its environment exits 1 with stderr containing
   `NAX_FORGE_TOKEN is not supported`. A nax without K0 ignores that variable and exits 0. `NaxCli.run`
   gains a per-call `env` overlay for this. The static capability probe never reports `botReview`.
4. **Ambient forge-identity variables are stripped.** `NAX_FORGE_TOKEN`, `NAX_FORGE_TOKEN_FILE`,
   `NAX_FORGE_LOGIN` and `NAX_FORGE_USER_ID` join `CREDENTIAL_ENV_VARS`, so a value the daemon inherited
   never reaches any nax call (a K0 nax would refuse to start on an inherited `NAX_FORGE_TOKEN`). The
   `REVIEW` and probe overlays are applied after the strip.
5. **Verdict by nax's success line.** The runner has no nax exit code (nax runs detached), and nax writes
   `bot-review.json` before it posts, so the artifact alone does not mean the review posted. nax prints
   `nax bot review: artifact <path>` to stdout only when the review posted. A `REVIEW` is:
   - `CANCELLED` when a cancel was requested (checked first);
   - `COMPLETED` when `<jobDir>/nax.stdout` has a line starting `nax bot review: artifact `;
   - otherwise `FAILED` with reason `review not posted`.
   Ingesting the artifact into koda is K2.
6. **Cost.** A `REVIEW` writes no `status.json`. The runner reports its cost from the nax cost ledger in
   `<outDir>` with the existing `readPlanCost`, as for `PLAN`. `REVIEW` joins `BUDGET_STOP_COMMANDS`, so a
   budget hard stop cancels queued reviews like `RUN` and `PLAN`.
7. **Restart.** On readopt, a `REVIEW` takes the `PLAN` branch: watch it when the process is alive and ours,
   otherwise finish it (judge as above). It is never rejected for a missing `status.json`.
8. **GitHub only, checked first.** `FleetJobsService.dispatch` rejects a `REVIEW` for a repo whose provider is
   not `github`, before `normalizeDispatch` runs, with 422 `fleet.dispatchInput` reason
   `review is GitHub-only`.
9. **Trust.** koda does not check PR authorship or forks; nax classifies the PR's trust itself.
10. **Notifications.** A failed `REVIEW` notifies its requester through the existing job-outcome recorder,
    like any job.

### The `REVIEW` job

- Kind `REVIEW` in `FleetJobKind`, the protocol's `FleetJobKindName`, the job DTO `command` enum and the web
  `FleetJobKind`.
- Fields: `ref` = the repo's default branch; `feature` = `review-pr-<prNumber>`; `planFrom` null; `bashMode`
  `raw`; `profiles`, `maxCostUsd`, `selectorLabels` and `pinnedRunnerId` from the dispatch body.
- `AssignPayload` gains `review?: { prNumber: number; botLogin: string }`, present only for `REVIEW`; `botLogin`
  is the `name` of the `GitIdentity` passed to `buildAssignPayload` (for GitHub `<githubAppSlug>[bot]`,
  fallback `koda-fleet[bot]`).
- Runner capability `botReview?: true`. For a `REVIEW` job, `capabilityMisfit` checks `botReview` first
  (before profiles, interaction and tools): without it the misfit is `bot_review`, which is not permanent.
- Runner checkout: detached at the default branch's sha, no `prd.json` read, returned branch `null`.
- Runner argv: `<naxCommand> bot review <prNumber> --profile <chain>` (the job profiles plus `koda-job-<jobId>`,
  joined with commas).
- Runner env: the stripped job env plus `NAX_FORGE_TOKEN_FILE=<jobDir>/forge-token` and
  `NAX_FORGE_LOGIN=<review.botLogin>`.

### Integration

Read-only (verified at koda `main` `76c71549`):

- `FleetJobsService.dispatch(actorId, projectId, dto, opts)` (`apps/api/src/fleet/jobs/fleet-jobs.service.ts:67`):
  loads the repo, calls `normalizeDispatch`, inserts, maps `DuplicateActiveJobError` to
  `ConflictAppException(..., 'fleet.jobs')` (409).
- `firstMisfit` / `evaluateRunners` (`apps/api/src/fleet/jobs/placement-rules.ts`, exported) and the private
  `capabilityMisfit`; `PERMANENT_MISFITS`.
- `gitIdentityFor(provider, cfg)` (`apps/api/src/fleet/jobs/assign-payload.ts`); `buildAssignPayload`'s one caller
  is `placement.service.ts`.
- API i18n `fleet.dispatchInput` is `"Invalid dispatch: {reason}"` in both locales, so new reasons need no new key.
- `readNaxVersion` and `NaxCli` (`apps/runner/src/nax/nax-cli.ts`); the nax probe (`apps/runner/src/capabilities/nax-probe.ts`).
- `readPlanCost(outDir)` (`apps/runner/src/verdict/plan-cost.ts`); `TokenCache.state(jobId, leaseEpoch, nowMs)`
  (`credentials/token-cache.ts`), owned by `CredentialBroker` (`credentials/broker.ts`).
- `Supervisor.readopt(jobId, leaseEpoch)` (`apps/runner/src/supervisor/supervisor.ts:163`), PLAN branch at `:183`.
- `JobRun.prepareAndSpawn` maps a throw from `spawn` to `FAILED 'spawn failed: <message>'`.
- The API may import `@nathapp/fleet-protocol` with `import type` only (`fleet/common/protocol.spec.ts`); runtime
  helpers are mirrored in the API (`fleet/common/config-jobs.ts`). Protocol edits ride an `apps/api` story, as in
  `fleet-s5a-thread-core`.

Changed. The baseline locates the code; implement the target.

- `FleetJobKind` (`apps/api/src/common/enums.ts:143`): adds `REVIEW`.
- `packages/fleet-protocol/src/index.ts` (types only): `FleetJobKindName` adds `'REVIEW'`; `AssignPayload` adds
  `review?: { prNumber: number; botLogin: string }`; `RunnerCapabilities` adds `botReview?: true`.
- New `apps/api/src/fleet/common/review-jobs.ts`: `REVIEW_FEATURE_PREFIX = 'review-pr-'`,
  `reviewFeature(prNumber): string`, `prNumberOfReviewFeature(feature): number | null` (null unless the feature is
  the prefix followed by a positive safe integer written without a leading zero).
- `parseCapabilitiesCore` (`apps/api/src/fleet/common/capabilities-core.ts`): accepts `botReview: true`, fails
  `botReview` for any other present value, like `configJobs`.
- `MisfitReason`, `capabilityMisfit` (`placement-rules.ts`): add `'bot_review'` with the order above.
- Misfit enum lists: `'bot_review'` joins `PlacementMisfitDto`'s enum (`fleet-job.dto.ts:129`) and `MISFIT_REASONS`
  (`fleet/dashboard/dashboard.types.ts:109`). The job DTO command enum (`fleet-job.dto.ts:51`) adds `'REVIEW'`.
- `DispatchFleetJobDto` (`fleet/jobs/dto/dispatch-fleet-job.dto.ts`) — Baseline: `command` `@IsIn(['RUN','PLAN'])`,
  `feature` required. Target: `@IsIn(['RUN','PLAN','REVIEW'])`; `feature` optional; new optional `prNumber`
  (integer 1..2147483647).
- `normalizeDispatch(dto, defaultBranch)` (`fleet/jobs/dispatch-input.ts`), reasons in this order:
  - `RUN`/`PLAN`: missing `feature` fails `feature`; a `review-pr-` feature fails `feature is reserved for REVIEW`;
    a `prNumber` fails `prNumber is only for REVIEW`.
  - `REVIEW`: missing `prNumber` fails `prNumber required for REVIEW`; `feature` fails `feature is derived for
    REVIEW`; `planFrom` fails `planFrom is only for PLAN`; `ref` fails `ref is the default branch for REVIEW`; a
    non-raw `bashMode` fails `bashMode must be raw for REVIEW`; non-empty `ticketRefs` fails `ticketRefs is not for
    REVIEW`. The result has `feature` `reviewFeature(prNumber)` and `ref` = the default branch.
- `FleetJobsService.dispatch`: after loading the repo and before `normalizeDispatch`, a `REVIEW` for a non-`github`
  repo throws `ValidationAppException({ reason: 'review is GitHub-only' }, 'fleet.dispatchInput')`.
- `buildAssignPayload`: a `REVIEW` job gains `review: { prNumber: prNumberOfReviewFeature(job.feature), botLogin:
  gitIdentity.name }`; a `REVIEW` row whose feature does not parse throws `Error('invalid review feature')`.
- `BUDGET_STOP_COMMANDS` (`fleet/budgets/prisma-budget.repository.ts:22`, module-private): adds `REVIEW`.
- `CREDENTIAL_ENV_VARS` (`apps/runner/src/credentials/credential-env.ts:6`): adds the four `NAX_FORGE_*` names.
- `NaxCallOptions` / `createNaxCli` (`apps/runner/src/nax/nax-cli.ts`): `NaxCallOptions` gains
  `env?: Readonly<Record<string, string>>`, merged after `withoutCredentialVars(process.env)` and
  `NAX_GLOBAL_CONFIG_DIR`.
- `FakeNaxCli` (`apps/runner/test/helpers/fake-nax-cli.ts`): records each call's `env`; by default answers
  `--version` with exit 0 whatever the env (a non-K0 nax) and `bot review --help` as an unknown command.
- Nax probe: adds `botReview: true` per call 3.
- `parseAssign` (`apps/runner/src/supervisor/assign-parser.ts:159`): accepts `REVIEW` with a `review` object
  (`prNumber` positive safe integer; `botLogin` 1..100 characters matching `^[A-Za-z0-9][A-Za-z0-9-]*\[bot\]$`) and
  `bashMode` `raw`; rejects `REVIEW` without `review` (`bad('review')`), with another `bashMode`
  (`bad('bashMode')`), and `review` on any other command (`bad('review')`).
- `prepareCheckout` (`apps/runner/src/executor/checkout.ts`): a `REVIEW` resolves `assign.ref`, checks out
  `--detach <sha>` and returns `{ ok: true, branch: null, refSha }`, before the `prd.json` read.
- `buildNaxArgv` (`executor/nax-process.ts`): `REVIEW` returns
  `[...naxCommand, 'bot', 'review', String(assign.review.prNumber), '--profile', chain]`.
- `Supervisor.readopt`: `REVIEW` joins the `PLAN` branch.
- `CredentialProvider` (`credentials/broker.ts`): adds optional `currentToken?(job: JobRow): string | null`;
  `CredentialBroker` implements it from `TokenCache.state(job.jobId, job.leaseEpoch, nowMs())`.
- New `apps/runner/src/executor/review-token.ts`: `REVIEW_TOKEN_FILE = 'forge-token'`;
  `writeReviewToken(jobDir, token): Promise<string>` creates `<jobDir>/forge-token` in one call with mode `0600`
  and returns its path; `removeReviewToken(jobDir): Promise<void>` removes it if present.
- `HostExecutorDeps` (`executor/host-executor.ts`): gains optional `spawnNax?` (default the module's `spawnNax`) so
  specs observe argv and env without starting a process.
- `HostExecutor.spawn`: for `REVIEW`, `credentials.currentToken?.(job)`; null or absent throws
  `Error('git token: none')` before any write or start; otherwise `writeReviewToken`, then start nax with the two
  env variables; if the start throws, `removeReviewToken` runs before the error propagates.
- `HostExecutor.cleanup`: calls `removeReviewToken(jobDir)`. `ATTEMPT_FILES` (`host-executor.ts:52`) adds
  `forge-token`.
- `JobExecutor` (`executor/job-executor.ts`): adds `readReviewPosted(job: JobRow): Promise<boolean>`; `HostExecutor`
  implements it with `reviewPosted(stdoutPath)` from the new `apps/runner/src/verdict/review-posted.ts`, true when the
  file has a line starting `nax bot review: artifact `, false when it has none or does not exist.
- `JobRun.judge` (`supervisor/job-run.ts:410`, private): a `REVIEW` branch beside `PLAN` returns the call-5 verdict
  and a snapshot whose `costSpentUsd` is `readPlanCost(job)` when defined; it never calls `readStatus`.
- Web (`apps/web`): `FleetJobKind` and `MisfitReason` (`lib/fleet-types.ts`) add `REVIEW` and `bot_review`;
  `reviewPrNumber(feature): number | null` in `lib/fleet-jobs.ts`; the job list (`pages/[project]/fleet/index.vue`)
  and the job page header (`pages/[project]/fleet/jobs/[id]/index.vue`) show `PR #<n>` in place of the feature for a
  `REVIEW`; `fleet.command.REVIEW` = `PR review` (Chinese `PR 评审`); `fleet.misfit.bot_review` =
  `nax on this runner cannot run PR reviews` (Chinese `此运行器上的 nax 无法执行 PR 评审`).

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| `REVIEW` dispatch for a non-GitHub repo | 422 `fleet.dispatchInput`, reason `review is GitHub-only`. |
| Second active `REVIEW` for the same PR | 409 from the existing active-feature conflict. |
| `RUN` or `PLAN` with a `review-pr-` feature | 422, reason `feature is reserved for REVIEW`. |
| No runner with `botReview` | Dispatch answers 201; the job stays QUEUED with misfit `bot_review`. |
| The runner has no current token at spawn | `FAILED`, reason `spawn failed: git token: none`; nothing written, nax not started. |
| nax wrote `bot-review.json` but did not post | `FAILED`, reason `review not posted`. |
| nax never ran far enough to print the success line | `FAILED`, reason `review not posted`. |

## Out of Scope

- Automatic dispatch of reviews on new PR heads, per-repo auto-review settings and the auto-review switch; those are part B (feature `fleet-auto-review`).
- Ingesting `bot-review.json` into koda, passing project decisions to the review (`--decisions`), and storing review outcomes as memory; those are K2.
- `nax bot fix` jobs and GitLab review jobs.
- Dispatching a `REVIEW` through the assistant tool `koda_dispatch_job`; its `command` stays `RUN` or `PLAN`.
- Fleet analytics for `REVIEW` jobs; the analytics queries keep counting `RUN` and `PLAN` only.
- A cost cap enforced inside the review; nax `bot review` takes no cost flag, so `maxCostUsd` is not passed to nax.
- Refreshing the token during a review: the job token is minted at prepare and valid for an hour, so a review that runs past it fails at its next forge call.
- CLI commands for reviews; the generated CLI client is regenerated but no command is added.
- Fetching or storing the App bot's numeric user id; nax compares the injected login.
- Installing nax with the `bot-forge-identity` feature on runner hosts; until it is installed, no runner reports `botReview` and `REVIEW` jobs stay queued.
- A stderr tail in the failure reason of a `review not posted` job; the stderr log is still uploaded with the job.
- Correcting the stale `RUN`/`PLAN` doc enums in the dashboard, home and ticket job DTOs; they already omit the config and thread kinds.

## Stories

This is one capability (the `REVIEW` job kind end to end) in 8 stories, split per package and along seams.

### US-001 — The `REVIEW` kind in the protocol and the API model

Workdir: apps/api. No dependencies.

Edits `packages/fleet-protocol/src/index.ts` (types only); adds `FleetJobKind.REVIEW`, the mirror
`fleet/common/review-jobs.ts`, `botReview` in `parseCapabilitiesCore`, the `bot_review` misfit and its enum
lists, and the DTO command enum; regenerates `openapi.json` and the CLI client (`bun run generate` from the
repo root).

### US-002 — Dispatch input rules for `REVIEW`

Workdir: apps/api. Depends on US-001.

`DispatchFleetJobDto` accepts `REVIEW` and `prNumber`, `feature` becomes optional; `normalizeDispatch`
applies the rules above.

### US-003 — Dispatching and assigning a `REVIEW`

Workdir: apps/api. Depends on US-002.

`FleetJobsService.dispatch` enforces GitHub-only before `normalizeDispatch`; `buildAssignPayload` adds
`review`; `REVIEW` joins `BUDGET_STOP_COMMANDS`; regenerates `openapi.json` and the CLI client.

### US-004 — The runner detects K0 and strips ambient identity variables

Workdir: apps/runner. Depends on US-001.

`CREDENTIAL_ENV_VARS` gains the four `NAX_FORGE_*` names; `NaxCallOptions` gains `env`; `FakeNaxCli`
records env; the nax probe reports `botReview` per call 3.

### US-005 — The runner accepts, checks out and readopts a `REVIEW`

Workdir: apps/runner. Depends on US-004.

`parseAssign` accepts `REVIEW`; `prepareCheckout` checks out detached; `buildNaxArgv` builds the
`bot review` argv; `Supervisor.readopt` routes `REVIEW` through the `PLAN` branch.

### US-006 — The runner starts a review with the token file

Workdir: apps/runner. Depends on US-005.

`review-token.ts`; `CredentialProvider.currentToken` and its `CredentialBroker` implementation;
`HostExecutorDeps.spawnNax`; `HostExecutor.spawn` and `cleanup`; `ATTEMPT_FILES`.

### US-007 — The runner judges a review

Workdir: apps/runner. Depends on US-006.

`review-posted.ts`; `JobExecutor.readReviewPosted` and its `HostExecutor` implementation; the `REVIEW`
branch in `JobRun.judge` with the ledger cost.

### US-008 — Web: review jobs are labelled

Workdir: apps/web. Depends on US-001.

`FleetJobKind` and `MisfitReason` gain `REVIEW` and `bot_review`; `reviewPrNumber`; the job list and job
page show `PR #<n>`; both locales gain the two labels.

### Context Files

**US-001**

- `packages/fleet-protocol/src/index.ts` — the protocol types this story widens.
- `apps/api/src/fleet/common/config-jobs.ts` — the runtime-mirror pattern.
- `apps/api/src/fleet/common/capabilities-core.ts` — `parseCapabilitiesCore` (`configJobs` pattern).
- `apps/api/src/fleet/jobs/placement-rules.ts` — `MisfitReason`, `capabilityMisfit`, `firstMisfit`.
- `apps/api/src/fleet/dashboard/dashboard.types.ts` — `MISFIT_REASONS`.

**US-002**

- `apps/api/src/fleet/jobs/dispatch-input.ts` — `normalizeDispatch`.
- `apps/api/src/fleet/jobs/dto/dispatch-fleet-job.dto.ts` — `DispatchFleetJobDto`.
- `apps/api/src/fleet/jobs/dispatch-input.spec.ts` — existing rule tests.

**US-003**

- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `dispatch`.
- `apps/api/src/fleet/jobs/assign-payload.ts` — `buildAssignPayload`.
- `apps/api/src/fleet/budgets/prisma-budget.repository.ts` — `BUDGET_STOP_COMMANDS`.
- `apps/api/test/integration/fleet/fleet-budget-evaluator.integration.spec.ts` — hard-stop test pattern.

**US-004**

- `apps/runner/src/credentials/credential-env.ts` — `CREDENTIAL_ENV_VARS`.
- `apps/runner/src/nax/nax-cli.ts` — `NaxCli`, `createNaxCli`, `readNaxVersion`.
- `apps/runner/src/capabilities/nax-probe.ts` — the nax probe.
- `apps/runner/src/capabilities/capability-probe.ts` — the static probe.

**US-005**

- `apps/runner/src/supervisor/assign-parser.ts` — `parseAssign`.
- `apps/runner/src/executor/checkout.ts` — `prepareCheckout`.
- `apps/runner/src/executor/nax-process.ts` — `buildNaxArgv`.
- `apps/runner/src/supervisor/supervisor.ts` — `readopt`.

**US-006**

- `apps/runner/src/executor/host-executor.ts` — `spawn`, `cleanup`, `ATTEMPT_FILES`, `HostExecutorDeps`.
- `apps/runner/src/credentials/broker.ts` — `CredentialProvider`, `CredentialBroker`.
- `apps/runner/src/credentials/token-cache.ts` — `TokenCache.state`.
- `apps/runner/src/credentials/job-files.ts` — existing mode-restricted file writes.

**US-007**

- `apps/runner/src/supervisor/job-run.ts` — `judge`.
- `apps/runner/src/executor/job-executor.ts` — `JobExecutor`.
- `apps/runner/src/verdict/plan-cost.ts` — `readPlanCost`.

**US-008**

- `apps/web/lib/fleet-types.ts` — `FleetJobKind`, `MisfitReason`.
- `apps/web/lib/fleet-jobs.ts` — job kind labels and helpers.
- `apps/web/pages/[project]/fleet/index.vue` — the job list.
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` — the job page.
- `apps/web/i18n/locales/en.json` — English strings.

### Creates

**US-001**

- `apps/api/src/fleet/common/review-jobs.ts` — `REVIEW_FEATURE_PREFIX`, `reviewFeature`, `prNumberOfReviewFeature`.
- `apps/api/src/fleet/common/review-jobs.spec.ts` — unit tests.

**US-003**

- `apps/api/test/integration/fleet/fleet-review-dispatch.integration.spec.ts` — dispatch route tests.

**US-006**

- `apps/runner/src/executor/review-token.ts` — `REVIEW_TOKEN_FILE`, `writeReviewToken`, `removeReviewToken`.
- `apps/runner/src/executor/review-token.spec.ts` — unit tests.

**US-007**

- `apps/runner/src/verdict/review-posted.ts` — `reviewPosted(stdoutPath)`.
- `apps/runner/src/verdict/review-posted.spec.ts` — unit tests.

### Modifies

**US-001**

- `apps/api/src/fleet/common/protocol.spec.ts` — the exhaustive `Record<FleetJobKindName, true>` named `kinds` (line 50) stops compiling once `REVIEW` joins `FleetJobKindName`; it gains `REVIEW: true` and stays exhaustive over the union.

**US-004**

- `apps/runner/test/helpers/fake-nax-cli.ts` — the fake records each call's `env` and keeps its default answers (`--version` exits 0 whatever the env, `bot review --help` is an unknown command), so every existing nax-probe spec keeps its exact report.

**US-007**

- `apps/runner/test/helpers/fake-executor.ts` — the fake `JobExecutor` stops type-checking once `JobExecutor` gains `readReviewPosted`; it gains a `readReviewPosted` that resolves `false` unless a test sets it, so every existing job-run spec keeps its behaviour.

**US-008**

- `apps/web/tests/i18n/fleet-locale-parity.spec.ts` — the `ENUMS` table pins `fleet.command` to the four command keys (line 33) and `fleet.misfit` to its reason keys (line 23), asserting each locale covers exactly those keys; `fleet.command` gains `REVIEW`, `fleet.misfit` gains `bot_review`, and the parity assertion is unchanged.

### Seams

- `reviewFeature` / `prNumberOfReviewFeature` (US-001) are used by `normalizeDispatch` (US-002) and
  `buildAssignPayload` (US-003); the US-003 route AC asserts the stored feature through
  `POST /projects/:slug/fleet/jobs`, and its assign AC asserts `review.prNumber`.
- `AssignPayload.review` (US-001, filled by US-003) is read by `parseAssign` and `buildNaxArgv` (US-005).
- `NaxCallOptions.env` (US-004) is used by the nax probe (US-004); the probe ACs assert the env the fake recorded.
- `writeReviewToken` / `removeReviewToken` (US-006) are used by `HostExecutor.spawn` and `cleanup` (US-006); the
  spawn ACs drive `spawn` with an injected `spawnNax` and a provider whose `currentToken` returns a fixed token.
- `JobExecutor.readReviewPosted` (US-007) is used by `JobRun.judge`; the US-007 job-run ACs run a `REVIEW` job
  through `JobRun` with the fake executor and assert the terminal state it reports.

## Acceptance Criteria

### US-001 — The `REVIEW` kind in the protocol and the API model

- `[unit]` `reviewFeature(42)` returns `review-pr-42`.
- `[unit]` `prNumberOfReviewFeature('review-pr-42')` returns `42`.
- `[unit]` `prNumberOfReviewFeature('review-pr-042')` returns null.
- `[unit]` `prNumberOfReviewFeature('review-pr-99999999999999999999')` returns null.
- `[unit]` `prNumberOfReviewFeature('login')` returns null.
- `[unit]` `parseCapabilities` given a capabilities object with `botReview: true` returns an object whose `botReview` is `true`.
- `[unit]` `parseCapabilities` given `botReview: false` fails with `botReview`.
- `[unit]` `firstMisfit` for a `REVIEW` job and a runner whose capabilities lack `botReview` returns `bot_review`.
- `[unit]` `firstMisfit` for a `REVIEW` job and a runner that lacks `botReview` and also lacks the job's profile provider returns `bot_review`.
- `[unit]` `firstMisfit` for a `REVIEW` job and an otherwise matching runner with `botReview: true` returns null.
- `[unit]` `PERMANENT_MISFITS` has no `bot_review` entry.
- `[unit]` `MISFIT_REASONS` includes `bot_review`.

### US-002 — Dispatch input rules for `REVIEW`

- `[unit]` `normalizeDispatch` for `REVIEW` with `prNumber: 42` and default branch `main` returns `feature` `review-pr-42`.
- `[unit]` that `normalizeDispatch` result has `ref` `main`.
- `[unit]` `normalizeDispatch` for `REVIEW` without `prNumber` throws `fleet.dispatchInput` with reason `prNumber required for REVIEW`.
- `[unit]` `normalizeDispatch` for `REVIEW` with a `feature` throws reason `feature is derived for REVIEW`.
- `[unit]` `normalizeDispatch` for `REVIEW` with `planFrom` throws reason `planFrom is only for PLAN`.
- `[unit]` `normalizeDispatch` for `REVIEW` with a `ref` throws reason `ref is the default branch for REVIEW`.
- `[unit]` `normalizeDispatch` for `REVIEW` with `bashMode: 'escalate'` throws reason `bashMode must be raw for REVIEW`.
- `[unit]` `normalizeDispatch` for `REVIEW` with `ticketRefs: ['KD-1']` throws reason `ticketRefs is not for REVIEW`.
- `[unit]` `normalizeDispatch` for `RUN` without a `feature` throws reason `feature`.
- `[unit]` `normalizeDispatch` for `RUN` with feature `review-pr-5` throws reason `feature is reserved for REVIEW`.
- `[unit]` `normalizeDispatch` for `RUN` with `prNumber: 3` throws reason `prNumber is only for REVIEW`.
- `[unit]` `DispatchFleetJobDto` with `command: 'REVIEW'` and `prNumber: 0` fails validation on `prNumber`.

### US-003 — Dispatching and assigning a `REVIEW`

- `[integration]` `POST /projects/:slug/fleet/jobs` with `{ command: 'REVIEW', repoId, prNumber: 42, maxCostUsd: 1 }` for a GitHub repo answers 201.
- `[integration]` that job is stored with `feature` `review-pr-42`.
- `[integration]` `POST /projects/:slug/fleet/jobs` with `{ command: 'REVIEW', repoId, prNumber: 42, maxCostUsd: 1 }` for a GitLab repo answers 422.
- `[integration]` that 422 carries reason `review is GitHub-only`.
- `[integration]` a second `REVIEW` dispatch for the same repo and `prNumber: 42` while the first is QUEUED answers 409.
- `[integration]` a `REVIEW` dispatch while the only runner lacks `botReview` answers 201 with `bot_review` among the placement misfits.
- `[integration]` a `REVIEW` dispatch pinned to a runner that lacks `botReview` answers 201.
- `[integration]` a budget hard stop on the job's project cancels a QUEUED `REVIEW` job.
- `[unit]` `buildAssignPayload` for a `REVIEW` job with feature `review-pr-42` and a `GitIdentity` named `koda-fleet[bot]` returns `review` equal to `{ prNumber: 42, botLogin: 'koda-fleet[bot]' }`.
- `[unit]` `buildAssignPayload` for a `REVIEW` job with feature `review-pr-x` throws `invalid review feature`.
- `[unit]` `buildAssignPayload` for a `RUN` job returns a payload with no `review` key.

### US-004 — The runner detects K0 and strips ambient identity variables

- `[unit]` `withoutCredentialVars` given an env with `NAX_FORGE_TOKEN`, `NAX_FORGE_TOKEN_FILE`, `NAX_FORGE_LOGIN` and `NAX_FORGE_USER_ID` returns an env with none of them.
- `[unit]` `createNaxCli(...).run(args, { cwd, env: { A: '1' } })` spawns nax with `A` equal to `1` in its environment.
- `[unit]` `createNaxCli(...).run` with an inherited `NAX_FORGE_TOKEN` in `process.env` and no `env` option spawns nax without `NAX_FORGE_TOKEN`.
- `[unit]` the nax probe reports `botReview: true` when `bot review --help` exits 0 and `--version` called with env `NAX_FORGE_TOKEN=probe` exits 1 with stderr containing `NAX_FORGE_TOKEN is not supported`.
- `[unit]` the nax probe calls `--version` for that check with `NAX_FORGE_TOKEN` equal to `probe` in the call's `env` option.
- `[unit]` the nax probe omits `botReview` when `--version` with `NAX_FORGE_TOKEN=probe` exits 0.
- `[unit]` the nax probe omits `botReview` when `bot review --help` exits non-zero.
- `[unit]` the static capability probe reports no `botReview`.

### US-005 — The runner accepts, checks out and readopts a `REVIEW`

- `[unit]` `parseAssign` accepts a `REVIEW` payload with `review: { prNumber: 42, botLogin: 'koda-fleet[bot]' }` and returns it with that `review`.
- `[unit]` `parseAssign` rejects a `REVIEW` payload without `review`.
- `[unit]` `parseAssign` rejects a `REVIEW` payload whose `review.botLogin` is `koda fleet`.
- `[unit]` `parseAssign` rejects a `REVIEW` payload whose `review.prNumber` is `0`.
- `[unit]` `parseAssign` rejects a `REVIEW` payload whose `bashMode` is `escalate`.
- `[unit]` `parseAssign` rejects a `RUN` payload that carries a `review` object.
- `[integration]` `prepareCheckout` for a `REVIEW` assign whose `ref` is the default branch, in a clone with no `.nax/features/review-pr-42/prd.json`, returns `{ ok: true, branch: null }` with the branch's sha as `refSha`.
- `[integration]` after that `prepareCheckout`, the clone's `HEAD` is detached at the default branch's sha.
- `[unit]` `buildNaxArgv(['nax'], assign)` for a `REVIEW` assign with `review.prNumber` 42 and profiles `['native-ds']` returns `['nax', 'bot', 'review', '42', '--profile', 'native-ds,koda-job-<jobId>']`.
- `[unit]` `Supervisor.readopt` for a RUNNING `REVIEW` row whose process is alive and ours begins `watch`.
- `[unit]` `Supervisor.readopt` for a RUNNING `REVIEW` row whose process is gone begins `finish`.

### US-006 — The runner starts a review with the token file

- `[unit]` `writeReviewToken(jobDir, 'tok-review-9')` creates `<jobDir>/forge-token` containing `tok-review-9` and returns its path.
- `[unit]` the file `writeReviewToken` creates has mode `0600`.
- `[unit]` `removeReviewToken(jobDir)` removes `<jobDir>/forge-token`.
- `[unit]` `CredentialBroker.currentToken(job)` returns the token string when the token cache holds a token for the job's id and lease epoch.
- `[unit]` `CredentialBroker.currentToken(job)` returns null when the token cache holds none for the job.
- `[unit]` `HostExecutor.spawn` for a `REVIEW` job whose provider's `currentToken` returns `tok-review-9` calls the injected `spawnNax` with env `NAX_FORGE_TOKEN_FILE` equal to `<jobDir>/forge-token`.
- `[unit]` that call's env has `NAX_FORGE_LOGIN` equal to `koda-fleet[bot]`.
- `[unit]` no value in that call's env equals `tok-review-9`.
- `[unit]` `HostExecutor.spawn` for a `RUN` job calls `spawnNax` with no `NAX_FORGE_TOKEN_FILE` key in its env.
- `[unit]` `HostExecutor.spawn` for a `REVIEW` job whose provider's `currentToken` returns null throws `git token: none` and never calls `spawnNax`.
- `[unit]` when the injected `spawnNax` throws for a `REVIEW` job, `<jobDir>/forge-token` no longer exists afterwards.
- `[unit]` `HostExecutor.cleanup` for a `REVIEW` job removes a `<jobDir>/forge-token` that still exists.
- `[unit]` the attempt wipe in `HostExecutor.prepare` removes a `<jobDir>/forge-token` left by an earlier attempt.

### US-007 — The runner judges a review

- `[unit]` `reviewPosted(path)` returns true for a stdout file with a line `nax bot review: artifact /out/bot/pr-42/r1/bot-review.json`.
- `[unit]` `reviewPosted(path)` returns false for a stdout file without that line.
- `[unit]` `reviewPosted(path)` returns false when the file does not exist.
- `[unit]` `HostExecutor.readReviewPosted(job)` returns `reviewPosted(<jobDir>/nax.stdout)`.
- `[unit]` a `REVIEW` job run through `JobRun` with a fake executor whose `readReviewPosted` resolves true reports the terminal state `COMPLETED`.
- `[unit]` a `REVIEW` job run through `JobRun` with `readReviewPosted` resolving false reports `FAILED` with reason `review not posted`.
- `[unit]` a `REVIEW` job run through `JobRun` with a cancel requested and `readReviewPosted` resolving true reports `CANCELLED`.
- `[unit]` a `REVIEW` job run through `JobRun` with `readPlanCost` resolving `0.0421` reports `costSpentUsd` `0.0421` in its terminal snapshot.
- `[unit]` a `REVIEW` job run through `JobRun` never calls the fake executor's `readStatus`.

### US-008 — Web: review jobs are labelled

- `[unit]` `reviewPrNumber('review-pr-42')` returns `42`, and `reviewPrNumber('login')` returns null.
- `[unit]` the fleet job list renders a `REVIEW` job with feature `review-pr-42` with the kind label `PR review`.
- `[unit]` the fleet job list renders that job with the text `PR #42` in place of `review-pr-42`.
- `[unit]` the job page header for a `REVIEW` job with feature `review-pr-42` shows `PR #42`.
- `[unit]` a placement misfit `bot_review` renders the label `nax on this runner cannot run PR reviews`.
- `[unit]` the Chinese locale defines `fleet.command.REVIEW` and `fleet.misfit.bot_review`.
