# SPEC: Fleet PR fix jobs (S6 K3, part A)

## Summary

koda can run `nax bot fix <pr>` on a fleet runner as the `koda-fleet` GitHub App. A new fleet job kind `FIX`
carries a PR number and is dispatched through the existing dispatch route (`POST /projects/:slug/fleet/jobs`). In one
job directory the runner first runs `nax bot review <pr> --full --decisions <file>` (the project's decisions, as K2
sends them to a `REVIEW`), then, when that review posted, `nax bot fix <pr> --no-rereview`, which fixes what the
review agreed with, runs the repo gates and pushes to the PR branch with the job's brokered token. The runner reports
the fix outcome (`pushed` or `nothing`) and the pushed commit, and the review that ran inside the fix feeds K2's
review memory like any `REVIEW`. Only runners whose nax has `bot fix --no-rereview` take `FIX` jobs. The job's
`maxCostUsd` reaches nax for the first time, through the per-job profile's `bot.costLimit`, for both `REVIEW` and
`FIX`. The follow-up review after a push and the CLI, MCP and web dispatch surfaces are part B (feature
`fleet-pr-fix-surfaces`), specified separately.

## Motivation

The design `docs/superpowers/specs/2026-11-01-fleet-s6-k3-pr-fix-design.md` (approved 2026-11-01) adds the fix half
of the S6 PR loop. Today koda reviews a PR (K1), feeds decisions in and remembers withdrawn findings (K2), but the
findings the review agreed with are fixed by hand or by `nax bot fix` run from a person's machine under their own
login, outside koda's audit, budget and runner fleet.

Facts that shape this spec (verified against nax `0.91.7-canary.11` and koda `main` `1a7e3eb9`):

- `nax bot fix` refuses unless a `bot-review.json` of the PR's exact current head is under its own output dir
  (`loadLatestReview(outputDir, pr, headSha)`, nax `src/bot/fix-input.ts:69`). Every koda job has its own output dir,
  so a `FIX` must run its own review first.
- `nax bot fix`'s built-in post-push re-review takes no decisions (`BotFixOptions` omits `decisions`, nax
  `src/cli/bot.ts:58`), so the job passes `--no-rereview`; the follow-up review is koda's (part B). nax #2760 asks for
  `bot fix --decisions`.
- On a nax-workflow PR whose head was already reviewed, a review without `--full` re-checks only the conversation
  (`reviewRange` -> `conversationOnly`, nax `src/bot/review-rulings.ts:129`), so step 1 passes `--full`.
- `nax bot review|fix` take no cost flag; they read `bot.costLimit` from config (`botCostLimit`, nax
  `src/bot/cost.ts`). The runner's per-job profile (`jobProfileContent`, `apps/runner/src/executor/job-profile.ts:31`)
  writes no `bot` key, so a `REVIEW` job's `maxCostUsd` never reaches nax today.
- stdout contract: `nax bot review: artifact <path>` only when the review posted; `nax bot fix: PR #<n> — pushed
  <sha7>` or `nax bot fix: PR #<n> — nothing to fix` (optionally followed by `; pushed advisor ledger <sha7>`) on
  success; `nax bot fix: log <path>` names the fix run's `bot.jsonl`, whose directory holds `bot-state.json` with
  `pushedSha`. Every other fix outcome prints its reason on stderr.
- Every fleet job's brokered GitHub token is `contents: write, pull_requests: write` on the job's repo with no branch
  restriction (`GitHubAppClient.mintInstallationToken`, `apps/api/src/fleet/git-broker/github-app-client.ts:70`).

## Design

### Calls made in this spec

1. **One job, two nax processes, chained by the runner.** The runner spawns step 1 (the review) as today's `REVIEW`
   spawn does. When step 1's process has exited, the job is not cancelled and `nax.stdout` has the review `artifact`
   line, the runner spawns step 2 (the fix) in the same RUNNING phase, writes its output to `<jobDir>/fix.stdout` and
   `<jobDir>/fix.stderr`, records the new `pid`/`pgid` on the journal row and watches it to exit. Only then does the
   job go UPLOADING and terminal. No journal column is added: `fix.stdout` existing marks step 2 as started.
2. **Chaining only in the session that started step 1.** `JobRun` chains step 2 only when this `JobRun` spawned
   step 1 (`lifecycle` entered through `prepare` or `reprepare`). A readopted `FIX` (`watch` or `finish`) never starts
   step 2: when its step-1 process exits, or is already gone, it is judged (call 4), which gives `interrupted before
   fix` when the review posted. The token cache does not survive a restart, so a resumed step 2 could not be trusted
   to authenticate. A `FIX` joins the `PLAN`/`REVIEW` readopt branch (watch a live process that is ours, else finish).
   **Recording and signalling step 2.** The new `pid`/`pgid` are patched on the journal row as soon as
   `spawnFixStep` resolves, before any halt or cancel check, so `killIfOurs` and `sendTerm` always see the live
   process. If a cancel was requested while `spawnFixStep` ran, the runner sends SIGTERM to the new `pgid` even when
   step 1 was already signalled: both one-shot guards (`cancelSentAtMs` and `sigkilled`) reset for the new process
   group, so a step 2 that ignores SIGTERM is still escalated to SIGKILL. If the run halts
   (ABANDON, daemon stop) while `spawnFixStep` ran, the patch still happens and the loop then returns as any halted
   watch does.
3. **Cost.** The per-job profile gains `bot: { costLimit: <number> }`. For `REVIEW` and for `FIX` step 1 it is
   `Number(maxCostUsd)`. This is a behaviour change for `REVIEW`: a manual or auto-review's `maxCostUsd` (K1-B
   `autoReviewMaxCostUsd`) now bounds the review, where nax used its own default before. Before step 2 the runner
   rewrites the same profile with `fixBudgetRemainder(maxCostUsd, spentUsd)`, where `spentUsd` is `readPlanCost`'s
   result (a decimal string with exactly 4 fraction digits, or `undefined` when the ledger is unreadable; both steps
   share one output dir, so the ledger is cumulative). `fixBudgetRemainder(maxCostUsd: string, spentUsd: string |
   undefined): number | null` (new, pure, `apps/runner/src/verdict/fix-budget.ts`) parses both strings exactly into
   integer ten-thousandths (no floating-point arithmetic), returns `(max - spent) / 10000` when that is above 0, and
   `null` when it is not or when `spentUsd` is `undefined`. The chaining check, `spawnFixStep` and the verdict all
   call this one helper. `null` from the chaining check means step 2 is not started; the verdict is `budget spent by
   review` when the spend was known and `cost ledger unreadable` when it was `undefined`. If `spawnFixStep`'s own
   call returns `null` (the ledger moved between the check and the start), it throws `Error('budget spent')`
   without writing anything, which ends as `fix spawn failed: budget spent`. The job's reported `costSpentUsd` is
   `readPlanCost` after the last step, as for `REVIEW`.
4. **Verdict** (checked in order, from files; nax runs detached so there is no exit code):

   | condition | job state | reason / recorded |
   |:--|:--|:--|
   | cancel requested | `CANCELLED` | |
   | `nax.stdout` has no `nax bot review: artifact ` line | `FAILED` | `review not posted` |
   | step 2 failed to start | `FAILED` | `fix spawn failed: <message>` |
   | no `fix.stdout`, `fixBudgetRemainder` is `null` and the spend was known | `FAILED` | `budget spent by review` |
   | no `fix.stdout`, `fixBudgetRemainder` is `null` and the spend was `undefined` | `FAILED` | `cost ledger unreadable` |
   | no `fix.stdout` otherwise | `FAILED` | `interrupted before fix` |
   | `fix.stdout` has a line starting `nax bot fix: PR #<n> — pushed ` | `COMPLETED` | `fixOutcome` `pushed`, `resultSha` |
   | `fix.stdout` has a line starting `nax bot fix: PR #<n> — nothing to fix` | `COMPLETED` | `fixOutcome` `nothing`, `resultSha` when present |
   | otherwise | `FAILED` | first non-empty line of `fix.stderr`, trimmed to 200 characters; `fix not pushed` when there is none |

   `<n>` is the job's PR number. `resultSha` is the `pushedSha` of the fix run's `bot-state.json` (the directory of the
   path on the `nax bot fix: log ` line), only when it matches `^[0-9a-f]{40}$`; the 7-character stdout sha is never
   reported. A `nothing` outcome with an advisor-ledger push therefore reports that push's sha. The `log` path is used
   only when it resolves inside `<jobDir>/nax-out/bot/pr-<n>/`; any other path gives no `resultSha`. A requested
   cancel is checked before any file is read, so it always ends `CANCELLED`, as for `REVIEW`. Unlike `REVIEW` (whose
   judge lets a read error reach `failSafe`), a `FIX` read that throws is treated as that file saying nothing: a
   `readReviewPosted` throw gives `review not posted` (and never chains), and a `readFixOutcome` throw gives `fix not
   pushed`.
5. **`fixOutcome` is new state on the job.** Protocol `SnapshotEventPayload.fixOutcome?: 'pushed' | 'nothing'`; the
   API mirrors it into a new nullable `FleetJob.fixOutcome` column (any other value is dropped, like every bounded
   snapshot field) and exposes it on `FleetJobDto`. A requeue clears it with the other result fields.
6. **No `resultPrUrl` or `resultBranch` for `FIX`, and no commit link.** The design doc put the PR URL in
   `resultPrUrl` and asked for a commit link; this spec does neither. The job page already shows `resultSha` (its first
   12 characters, `jobs/[id]/index.vue:341`), which is enough for K3.
   `jobOutcomeOf` turns `COMPLETED` + `resultPrUrl` into a `pr_opened` notification, and PR attribution treats
   `resultPrUrl` as a PR the job opened. A `FIX` opens no PR. The web derives the PR from the job's feature, as for
   `REVIEW`.
7. **Same feature as `REVIEW`.** A `FIX`'s feature is `review-pr-<n>` (`reviewFeature`), so the existing active-feature
   index makes a `FIX` while a `REVIEW` or `FIX` of that PR is active a 409, and the reverse. `prNumberOfReviewFeature`
   keeps working for both.
8. **Decisions.** A `FIX` dispatch selects decisions exactly as a `REVIEW` does (`ReviewDecisionsService.selectForReview`)
   and stores them on `FleetJob.reviewDecisions`; the assign payload's `review` object carries them for both kinds.
9. **Review memory.** Bundle ingest reads the review artifact of a `REVIEW` in `COMPLETED` (unchanged) or of a `FIX` in
   `COMPLETED`, `FAILED` or `CANCELLED` (the review posted even when the fix failed), with the current lease epoch. A
   `FIX` in `ESCALATED` or `CRASHED` is not read (no runner verdict was reached). `parseBotReview`
   already refuses a bundle whose `nax.stdout` lacks the artifact line when several artifacts exist; with one
   artifact and no line it reads that one, unchanged.
10. **Capability.** `botFix: true` is reported only when `botReview` is reported, `nax bot review --help` stdout
    contains `--full`, and `nax bot fix --help` exits 0 with `--no-rereview` in its stdout (`--no-rereview` shipped a
    day before `--full`, so both are checked). A `FIX` needs both: `capabilityMisfit` returns `bot_review` without `botReview`,
    then `bot_fix` without `botFix`. `bot_fix` is not permanent.
11. **Token file.** Each step gets the job's current token freshly written to `<jobDir>/forge-token` (nax deletes it at
    startup) and `NAX_FORGE_LOGIN`. The runner context's token rule names `REVIEW` only; it is amended to `REVIEW` and
    `FIX` by hand on this branch before the run (a `.nax/` edit, see Out of Scope).
12. **Permission and budget.** `FIX` is dispatched under `fleet.job.dispatch` like `RUN` and `REVIEW`; no new key.
    `FIX` joins `BUDGET_STOP_COMMANDS`.

### Integration

Read-only (verified at koda `main` `1a7e3eb9`):

- `FleetJobsService.dispatch(actorId, projectId, dto, opts)` (`apps/api/src/fleet/jobs/fleet-jobs.service.ts:79`):
  the GitHub-only check at line 82 throws `ReviewProviderException` (lines 39-43, 422 `fleet.dispatchInput`, reason
  `review is GitHub-only`); `normalizeDispatch` at line 85; decisions at lines 109-111.
- `reviewFeature`, `prNumberOfReviewFeature`, `REVIEW_FEATURE_PREFIX` (`apps/api/src/fleet/common/review-jobs.ts`).
- `ReviewDecisionsService.selectForReview(projectId, repoId)` (`apps/api/src/memory/review-decisions.service.ts:12`).
- `parseBundle(files, naxRunId, opts)` (`apps/api/src/fleet/ingest/parse-bundle.ts:32`); `parseBotReview` and
  `selectArtifact` (`apps/api/src/fleet/ingest/parsers/bot-review.parser.ts:44-59`); reader slots `botReview` and
  `naxStdout` (`apps/api/src/fleet/ingest/bundle-reader.ts:24-26`).
- `jobOutcomeOf` (`apps/api/src/notifications/fleet/fleet-notification-events.ts:32`).
- Runner: `writeReviewToken` / `removeReviewToken` (`apps/runner/src/executor/review-token.ts`),
  `writeReviewDecisions` (`apps/runner/src/executor/review-decisions-file.ts:8`), `reviewPosted`
  (`apps/runner/src/verdict/review-posted.ts`), `readPlanCost` (`apps/runner/src/verdict/plan-cost.ts`),
  `isProcessAlive` and `spawnNax` (`apps/runner/src/executor/nax-process.ts`), `JobEvents.transition`.
- The API imports `@nathapp/fleet-protocol` with `import type` only; protocol edits ride an `apps/api` story.

Changed. The baseline locates the code; implement the target.

- `FleetJobKind` (`apps/api/src/common/enums.ts:143`): adds `FIX`. `FleetJobDto` command enum
  (`apps/api/src/fleet/jobs/dto/fleet-job.dto.ts:56`) adds `FIX`.
- `packages/fleet-protocol/src/index.ts` (types only): `FleetJobKindName` (line 123) adds `'FIX'`;
  `RunnerCapabilities` (lines 64-92) adds `botFix?: true`; `SnapshotEventPayload` (line ~143) adds
  `fixOutcome?: 'pushed' | 'nothing'`. `AssignPayload.review` is unchanged and is now sent for `FIX` too.
- `DispatchFleetJobDto.command` (`apps/api/src/fleet/jobs/dto/dispatch-fleet-job.dto.ts:10`) — Baseline:
  `@IsIn(['RUN','PLAN','REVIEW'])`. Target: `@IsIn(['RUN','PLAN','REVIEW','FIX'])`, typed
  `'RUN' | 'PLAN' | 'REVIEW' | 'FIX'`.
- `normalizeDispatch(dto, defaultBranch)` (`apps/api/src/fleet/jobs/dispatch-input.ts:27`) — Baseline: the
  `REVIEW` branch at line 30 derives `feature` and `ref` and rejects the other fields with `... for REVIEW` reasons;
  `RUN`/`PLAN` reject a `review-pr-` feature with `feature is reserved for REVIEW` and a `prNumber` with `prNumber is
  only for REVIEW`. Target: `FIX` takes the same branch with the same checks; each reason names the dispatched
  command (`prNumber required for FIX`, `feature is derived for FIX`, `planFrom is only for PLAN`, `ref is the default
  branch for FIX`, `bashMode must be raw for FIX`, `ticketRefs is not for FIX`); for `RUN`/`PLAN` the two reasons
  become `feature is reserved for REVIEW and FIX` and `prNumber is only for REVIEW and FIX`.
- `FleetJobsService.dispatch`: the GitHub-only check covers `FIX` with reason `fix is GitHub-only`; the decisions
  selection covers `FIX`.
- `parseCapabilitiesCore` (`apps/api/src/fleet/common/capabilities-core.ts:118`): accepts `botFix: true`, fails
  `botFix` for any other present value (as `botReview` at line 149).
- `MisfitReason` and `capabilityMisfit` (`apps/api/src/fleet/jobs/placement-rules.ts:10-13`, `:93-94`): adds
  `'bot_fix'`; order per call 10. `'bot_fix'` joins `PlacementMisfitDto`'s enum (`fleet-job.dto.ts`) and
  `MISFIT_REASONS` (`apps/api/src/fleet/dashboard/dashboard.types.ts:109`).
- `buildAssignPayload` (`apps/api/src/fleet/jobs/assign-payload.ts:29-30`, `review` built at 43-48) — Baseline: `review` built only for
  `job.command === 'REVIEW'`. Target: built for `REVIEW` and `FIX` alike; a `FIX` row whose feature does not parse
  throws `Error('invalid review feature')`.
- `BUDGET_STOP_COMMANDS` (`apps/api/src/fleet/budgets/prisma-budget.repository.ts:22`): adds `FIX`.
- Prisma `FleetJob` (`apps/api/prisma/schema.prisma:~995`): adds `fixOutcome String?`; migration
  `20261118090000_fleet_job_fix_outcome` (run `bun run db:generate` in `apps/api` after the schema and migration
  edits; the migration is tested like `fleet-thread-workspace-migration.integration.spec.ts`, with
  `apps/api/test/helpers/migration-schema.ts`). `FleetJobRecord` (`apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`)
  gains `fixOutcome?: 'pushed' | 'nothing' | null` (optional, like `reviewDecisions` at line 64, so typed record
  literals in existing specs keep compiling); the patchable field list (line 153) adds `fixOutcome`;
  `toJob` (`apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts:22`) maps the `String?` column with
  `fixOutcomeOf(value)`, exported from `fleet-job.domain.ts`, which returns `'pushed'`, `'nothing'` or `null` for anything else; `FleetJobDto` adds
  `fixOutcome: 'pushed' | 'nothing' | null`, mapped `r.fixOutcome ?? null` (as `reviewDecisions` at line 109).
- `mirror(p)` (`apps/api/src/fleet/sync/event-payloads.ts:81`): maps `fixOutcome` when it is `'pushed'` or
  `'nothing'`, drops it otherwise.
- The requeue reset in `FleetJobsService` (`fleet-jobs.service.ts:304`) adds `fixOutcome: null`.
- `BundleIngestService.write` (`apps/api/src/fleet/ingest/bundle-ingest.service.ts:103-104`) — Baseline:
  `job.command === 'REVIEW' && job.state === 'COMPLETED' && job.leaseEpoch === claim.leaseEpoch`. Target: that, or
  `job.command === 'FIX'` in `COMPLETED`, `FAILED` or `CANCELLED` with `job.leaseEpoch === claim.leaseEpoch`.
- Runner `NaxCapabilityProbe` (`apps/runner/src/capabilities/nax-probe.ts:152-178`, `botReview` at 258-264): adds a
  `botFix` probe per call 10, run only when `botReview` passed.
- Runner `parseAssign` (`apps/runner/src/supervisor/assign-parser.ts:172`, kind list at 177): accepts `FIX` with the same `review` and
  `bashMode` rules as `REVIEW`; rejects `FIX` without `review` (`bad('review')`).
- Runner `prepareCheckout` (`apps/runner/src/executor/checkout.ts:42-45`): `FIX` checks out detached like `REVIEW`.
- Runner `Supervisor.readopt` (`apps/runner/src/supervisor/supervisor.ts:183`): `FIX` joins the `PLAN`/`REVIEW`
  branch.
- Runner `jobProfileContent(outputDir, projectName, relay?)` (`apps/runner/src/executor/job-profile.ts:31`) —
  Target: `jobProfileContent(outputDir, projectName, relay?, botCostLimitUsd?)`; when `botCostLimitUsd` is given the
  result gains `bot: { costLimit: botCostLimitUsd }`; `writeJobProfile` gains the same trailing optional parameter.
  `HostExecutor.prepare` (`host-executor.ts:123`) passes `Number(assign.maxCostUsd)` for `REVIEW` and `FIX`.
- Runner `buildNaxArgv` (`apps/runner/src/executor/nax-process.ts:11`): `FIX` returns
  `[...naxCommand, 'bot', 'review', String(prNumber), '--full', '--profile', chain, ...decisions]` (the `REVIEW`
  argv plus `--full`). New `buildFixArgv(naxCommand, assign): string[]` returns
  `[...naxCommand, 'bot', 'fix', String(prNumber), '--no-rereview', '--profile', chain]`, with the same `review`
  validation (`PathError('invalid review')`).
- Runner `HostExecutor.spawn` (`host-executor.ts:160-183`) — Baseline: the decisions file (line 162) and the token
  file and env (line 172) and the token drop on a failed start (line 180) are gated on `job.command === 'REVIEW'`. Target: gated on
  `REVIEW` or `FIX`, so `FIX` step 1 is the `REVIEW` spawn with the `FIX` argv. New `JobExecutor.spawnFixStep(job): Promise<SpawnHandle>` on `HostExecutor` rewrites the job
  profile with the remainder (call 3), writes a fresh token file, and starts `buildFixArgv` with stdout
  `<jobDir>/fix.stdout`, stderr `<jobDir>/fix.stderr` and the `REVIEW` env; a start that throws removes the token
  file before the error propagates.
- Runner `ATTEMPT_FILES` (`host-executor.ts:59`) adds `fix.stdout` and `fix.stderr`; `buildBundle`
  (`collectBundleEntries`, `apps/runner/src/bundle/build-bundle.ts:41`) adds `fix.stdout` and `fix.stderr` when present.
- Runner `JobRun.watchUntilExit` (`apps/runner/src/supervisor/job-run.ts:384`) — Target: for a `FIX` whose step 1
  this `JobRun` spawned (call 2), when the watched process has exited, `hasFixStep` is false, no cancel is
  requested, `readReviewPosted` is true and `fixBudgetRemainder` is not `null`, it calls `executor.spawnFixStep(row)`
  once, patches `pid`/`pgid` per call 2 and keeps watching the new process; a throw is held as the step-2 failure
  for the verdict and the loop ends without a retry.
- Runner `JobRun.judge` (`job-run.ts:410`): a `FIX` branch beside `REVIEW` returns call 4's verdict and a snapshot
  with `costSpentUsd`, and, on `COMPLETED`, `fixOutcome` and `resultSha` when present.
- Runner `JobExecutor` (`apps/runner/src/executor/job-executor.ts`) gains `spawnFixStep(job): Promise<SpawnHandle>`,
  `hasFixStep(job): Promise<boolean>` (true when `<jobDir>/fix.stdout` exists) and
  `readFixOutcome(job): Promise<FixOutcome>`, `FixOutcome = { kind: 'pushed' | 'nothing' | 'none'; logPath: string |
  null; pushedSha: string | null; stderrLine: string | null }` (flat: `kind` and `logPath` from `readFixResult` of
  `fix.stdout`, `pushedSha` from `readPushedSha` of that `logPath`, `stderrLine` the first non-empty `fix.stderr`
  line trimmed to 200 characters);
  `HostExecutor` implements all three and `JobRun` reads the fix files only through them.
- New runner `apps/runner/src/verdict/fix-budget.ts`: `fixBudgetRemainder(maxCostUsd: string, spentUsd: string | undefined):
  number | null` per call 3.
- New runner `apps/runner/src/verdict/fix-result.ts`: `readFixResult(stdoutPath, prNumber): Promise<FixResult>`,
  `FixResult = { kind: 'pushed' | 'nothing' | 'none'; logPath: string | null }`, and
  `readPushedSha(logPath): Promise<string | null>`.
- Web (`apps/web`): `FleetJobKind` and `MisfitReason` (`lib/fleet-types.ts:159`) add `FIX` and `bot_fix`; the web
  `FleetJobDto` type (`lib/fleet-types.ts`, beside `resultSha` at line 240) gains `fixOutcome?: 'pushed' | 'nothing' |
  null` (optional, so existing typed fixtures keep type-checking); the job
  list (`pages/[project]/fleet/index.vue:97`) and the job page header (`pages/[project]/fleet/jobs/[id]/index.vue:85`)
  show `PR #<n>` for a `FIX` as for a `REVIEW`; the job page shows the fix outcome.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| `FIX` for a non-GitHub repo | 422 `fleet.dispatchInput`, reason `fix is GitHub-only`. |
| A `REVIEW` or `FIX` of the same PR is active | 409 from the existing active-feature conflict. |
| No runner with `botReview` and `botFix` | Dispatch answers 201; the job stays QUEUED with misfit `bot_review` or `bot_fix`. |
| No current token at step 1 | `FAILED`, reason `spawn failed: git token: none` (unchanged `REVIEW` path). |
| No current token at step 2, or step 2 fails to start | `FAILED`, reason `fix spawn failed: <message>`; token file removed. |
| Review did not post | `FAILED`, reason `review not posted`; step 2 never starts. |
| Review spent the whole budget | `FAILED`, reason `budget spent by review`; step 2 never starts. |
| Cost ledger unreadable after the review | `FAILED`, reason `cost ledger unreadable`; step 2 never starts. |
| A `FIX` file read throws (not cancelled) | Treated as the file saying nothing: `review not posted` or `fix not pushed`. |
| Daemon restart between the steps | `FAILED`, reason `interrupted before fix`. |
| nax refuses or the fix does not push (untrusted, no push access, gates failed, protected files, no change, head moved) | `FAILED`, reason = first line of `fix.stderr`. |
| Cancel during either step | `CANCELLED`; step 2 is never started after a cancel. |
| `bot-state.json` missing or its `pushedSha` malformed | `COMPLETED` with `fixOutcome`, no `resultSha`. |
| A readopted `FIX` after a runner restart | Step 2 is never started; judged `interrupted before fix` once step 1 is gone. |
| Cancel requested while step 2 is being started | The new process group gets SIGTERM; the job ends `CANCELLED`. |
| ABANDON or daemon stop while step 2 is being started | The new `pid`/`pgid` are recorded before the run returns. |


## Out of Scope

- The follow-up `REVIEW` koda queues after a `pushed` fix; part B (`fleet-pr-fix-surfaces`). Part B must also settle the K1-B head poller dispatching its own review of the pushed head.
- Dispatching `REVIEW` or `FIX` from the CLI, from the assistant tool `koda_dispatch_job`, or from the web dispatch form, and a `Fix` action on a `REVIEW` job page; part B. The generated CLI client is regenerated but no command is added.
- Streaming the fix step's output live: `fix.stdout` and `fix.stderr` are not registered with the log shipper, so a `FIX` job's live log ends with the review step; the fix output reaches the server in the bundle and its first stderr line in the `FAILED` reason.
- Refreshing the git token during the fix step: step 2 gets the token current at its start; a fix session that outlives that installation token fails at push with nax's reason, and there is no minimum-validity check before step 2.
- Automatic fix (a poller or a fix-on-review switch).
- GitLab fix jobs and fork or cross-repo PRs (nax refuses them).
- Resuming step 2 after a runner restart; such a job ends `interrupted before fix`.
- A second fix round in one job, and the nax post-push re-review (the job always passes `--no-rereview`).
- `resultPrUrl`, `resultBranch` and a commit link for `FIX` jobs; the PR is derived from the feature and the job page's existing sha display is kept.
- Fleet analytics, dashboard and home read models for `FIX`; they keep their current command lists.
- A separate permission key for `FIX`; it uses `fleet.job.dispatch`.
- Amending the runner context token rule by hand on this branch before the run (not by a story): the sentence in `.nax/mono/apps/runner/context.md` that names the fleet S6 REVIEW exception is rewritten to name REVIEW and FIX jobs and to say the token file is written once before each nax step instead of once, then `nax generate` is run.
- Installing a nax with `bot fix --no-rereview` and `bot review --full` on runner hosts; until it is installed no runner reports `botFix` and `FIX` jobs stay queued.

## Stories

### US-001: Dispatch input accepts FIX

Workdir: `apps/api`. No dependencies.

Adds the `FIX` kind to the API enums, the DTOs and the protocol types, and makes `normalizeDispatch` derive and check
a `FIX` like a `REVIEW`, with command-specific reasons.

### US-002: Dispatch service handles FIX

Workdir: `apps/api`. Depends on US-001.

`FleetJobsService.dispatch` applies the GitHub-only check and the decisions selection to `FIX`; `FIX` joins the budget
hard stop.

### US-003: Placement and assign for FIX

Workdir: `apps/api`. Depends on US-001.

Runners report `botFix`; a `FIX` is placed only on a runner with `botReview` and `botFix`; `bot_fix` joins the misfit
lists; the assign payload carries the `review` object for a `FIX`.

### US-004: Fix outcome on the job

Workdir: `apps/api`. Depends on US-001.

New nullable `FleetJob.fixOutcome` column, mapped by `toJob` through `fixOutcomeOf`, mirrored from the runner
snapshot, exposed on the job DTO and cleared on requeue.

### US-005: Review memory from FIX jobs

Workdir: `apps/api`. Depends on US-001.

Bundle ingest reads the review artifact of a `FIX` in `COMPLETED`, `FAILED` or `CANCELLED`, so withdrawn findings from
the review step mint decisions as K2 does for `REVIEW`.

### US-006: Runner accepts FIX

Workdir: `apps/runner`. Depends on US-003.

The capability probe reports `botFix`; the assign parser accepts `FIX`; checkout is detached; readopt treats `FIX`
like `REVIEW`.

### US-007: Cost cap and argv

Workdir: `apps/runner`. Depends on US-006.

The per-job profile carries `bot.costLimit` for `REVIEW` and `FIX`; `fixBudgetRemainder`; `buildNaxArgv` gives the
`FIX` review step (`--full`); `buildFixArgv` gives the fix step.

### US-008: Review step spawn and fix files

Workdir: `apps/runner`. Depends on US-007.

`HostExecutor.spawn` treats `FIX` step 1 as a `REVIEW` spawn; `fix.stdout` and `fix.stderr` join the attempt wipe and
the bundle.

### US-009: Fix step start

Workdir: `apps/runner`. Depends on US-008.

`HostExecutor.spawnFixStep` and `HostExecutor.hasFixStep`.

### US-010: Fix step chaining

Workdir: `apps/runner`. Depends on US-009.

The `JobRun.watchUntilExit` chaining per call 2: start the fix step in the same RUNNING phase, record and signal it,
or hold the reason it was not started.

### US-011: Fix file readers

Workdir: `apps/runner`. Depends on US-006.

`readFixResult`, `readPushedSha` and `HostExecutor.readFixOutcome`, reading `fix.stdout`, the fix run's
`bot-state.json` and `fix.stderr` from real files.

### US-012: FIX verdict

Workdir: `apps/runner`. Depends on US-010, US-011.

The `FIX` branch of `JobRun.judge` per call 4, reporting `fixOutcome`, `resultSha` and `costSpentUsd`.

### US-013: Web shows FIX jobs

Workdir: `apps/web`. Depends on US-004.

`FIX`, `bot_fix` and `fixOutcome` in the web types and locales; job list and job page show `PR #<n>` and the fix
outcome.

### Context Files

**US-001**
- `apps/api/src/fleet/jobs/dispatch-input.ts`
- `apps/api/src/fleet/common/review-jobs.ts`

**US-002**
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts`
- `apps/api/src/fleet/budgets/prisma-budget.repository.ts`
- `apps/api/src/memory/review-decisions.service.ts`

**US-003**
- `apps/api/src/fleet/jobs/placement-rules.ts`
- `apps/api/src/fleet/common/capabilities-core.ts`
- `apps/api/src/fleet/jobs/assign-payload.ts`

**US-004**
- `apps/api/src/fleet/sync/event-payloads.ts`
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts`
- `apps/api/test/helpers/migration-schema.ts`

**US-005**
- `apps/api/src/fleet/ingest/bundle-ingest.service.ts`
- `apps/api/src/fleet/ingest/parsers/bot-review.parser.ts`

**US-006**
- `apps/runner/src/capabilities/nax-probe.ts`
- `apps/runner/src/supervisor/assign-parser.ts`
- `apps/runner/src/executor/checkout.ts`
- `apps/runner/src/supervisor/supervisor.ts`

**US-007**
- `apps/runner/src/executor/job-profile.ts`
- `apps/runner/src/executor/nax-process.ts`
- `apps/runner/src/executor/host-executor.ts`

**US-008**
- `apps/runner/src/executor/host-executor.ts`
- `apps/runner/src/bundle/build-bundle.ts`
- `apps/runner/src/executor/review-token.ts`

**US-009**
- `apps/runner/src/executor/host-executor.ts`
- `apps/runner/src/executor/review-token.ts`
- `apps/runner/src/verdict/fix-budget.ts` — created by US-007, called here

**US-010**
- `apps/runner/src/supervisor/job-run.ts`
- `apps/runner/src/verdict/fix-budget.ts` — created by US-007, called here

**US-011**
- `apps/runner/src/executor/host-executor.ts`
- `apps/runner/src/verdict/review-posted.ts`

**US-012**
- `apps/runner/src/supervisor/job-run.ts`
- `apps/runner/src/verdict/fix-result.ts` — created by US-011, its `FixOutcome` is judged here
- `apps/runner/src/verdict/fix-budget.ts` — created by US-007, called here

**US-013**
- `apps/web/lib/fleet-jobs.ts`
- `apps/web/pages/[project]/fleet/index.vue`
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue`

### Creates

**US-004**
- `apps/api/prisma/migrations/20261118090000_fleet_job_fix_outcome/migration.sql`
- `apps/api/test/integration/fleet/fleet-job-fix-outcome-migration.integration.spec.ts`

**US-007**
- `apps/runner/src/verdict/fix-budget.ts`
- `apps/runner/src/verdict/fix-budget.spec.ts`

**US-011**
- `apps/runner/src/verdict/fix-result.ts`
- `apps/runner/src/verdict/fix-result.spec.ts`

### Modifies

**US-001**
- `apps/api/src/common/enums.ts` — `FleetJobKind` gains `FIX`.
- `packages/fleet-protocol/src/index.ts` — `FleetJobKindName` gains `'FIX'`, `RunnerCapabilities` gains `botFix?: true` and `SnapshotEventPayload` gains `fixOutcome?: 'pushed' | 'nothing'`; types only, so the US-003, US-004 and US-006 consumers compile.
- `apps/api/src/fleet/common/protocol.spec.ts` — its `Record<FleetJobKindName, true>` of every kind must list `FIX`, or the spec stops compiling once the protocol union gains it; the invariant (every protocol kind maps to an API `FleetJobKind` value) is unchanged.
- `apps/api/src/fleet/jobs/dto/dispatch-fleet-job.dto.ts` — `command` `@IsIn` and type gain `FIX`.
- `apps/api/src/fleet/jobs/dto/dispatch-fleet-job.dto.spec.ts` — its enum assertion pins `['RUN','PLAN','REVIEW']`; it becomes `['RUN','PLAN','REVIEW','FIX']`.
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` — the `FleetJobDto` command enum gains `FIX`.
- `apps/api/src/fleet/jobs/dispatch-input.spec.ts` — it pins the `RUN`/`PLAN` reasons `feature is reserved for REVIEW` and `prNumber is only for REVIEW`; they become `feature is reserved for REVIEW and FIX` and `prNumber is only for REVIEW and FIX`. The `REVIEW` reasons are unchanged.
- `openapi.json` — regenerated: `DispatchFleetJobDto.command` and `FleetJobDto.command` enums gain `FIX`.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate` from the new API spec; never hand-edited.

**US-002**
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — the GitHub-only check and the decisions selection cover `FIX`.
- `apps/api/src/fleet/budgets/prisma-budget.repository.ts` — `BUDGET_STOP_COMMANDS` gains `FIX`.
- `apps/api/src/fleet/jobs/fleet-jobs.service.spec.ts` — new `FIX` dispatch cases beside the `REVIEW` fixture at line 227; existing cases unchanged.

**US-003**
- `apps/api/src/fleet/jobs/placement-rules.spec.ts` — its `MISFIT_REASONS` and `REVIEW` placement assertions (lines 31-37) gain `bot_fix` and `FIX` cases; the `REVIEW` cases are unchanged.
- `apps/api/src/fleet/dashboard/dashboard.types.ts` — `MISFIT_REASONS` gains `'bot_fix'`.
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` — the `PlacementMisfitDto` enum gains `bot_fix`.
- `apps/api/src/fleet/jobs/assign-payload.spec.ts` — new `FIX` cases beside the `REVIEW` case at line 26; existing cases unchanged.
- `apps/api/src/fleet/common/capabilities.spec.ts` — new `botFix` accept and reject cases beside the `botReview` ones.
- `openapi.json` — regenerated: every misfit enum derived from `MISFIT_REASONS` (`PlacementMisfitDto`, the fleet dashboard DTO and the credential board DTO) gains `bot_fix`.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate` from the new API spec (the misfit enums gain `bot_fix`); never hand-edited.

**US-004**
- `apps/api/prisma/schema.prisma` — `FleetJob` gains `fixOutcome String?`.
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `FleetJobRecord` gains the optional `fixOutcome`, the patchable list adds it, and `fixOutcomeOf` is exported here.
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `toJob` maps the new column through `fixOutcomeOf`.
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` — `FleetJobDto` gains `fixOutcome`, mapped `r.fixOutcome ?? null`.
- `apps/api/src/fleet/sync/event-payloads.ts` — `mirror` maps `fixOutcome`.
- `apps/api/src/fleet/sync/event-payloads.spec.ts` — new `fixOutcome` mirror cases; existing cases unchanged.
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — the requeue reset at line 304 adds `fixOutcome: null`.
- `openapi.json` — regenerated: `FleetJobDto` gains `fixOutcome`.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate` from the new API spec (the job type gains `fixOutcome`); never hand-edited.

**US-005**
- `apps/api/src/fleet/ingest/bundle-ingest.service.spec.ts` — new `FIX` cases in `describe review event ingest` (line 192); the `REVIEW` cases are unchanged.

**US-006**
- `apps/runner/src/capabilities/nax-probe.spec.ts` — new `botFix` cases beside the US-004 `botReview` cases (lines 67-93); its fake nax answers `bot fix --help` as an unknown command by default, so existing cases report no `botFix`.
- `apps/runner/test/helpers/fake-nax-cli.ts` — answers `bot fix --help` as an unknown command by default and lets a spec supply its stdout, so probe specs choose whether `--no-rereview` is listed.
- `apps/runner/src/supervisor/supervisor.spec.ts` — new `FIX` readopt cases beside the `REVIEW` ones (lines 281-292).
- `apps/runner/test/unit/checkout.spec.ts` — new `FIX` detached-checkout case.

**US-007**
- `apps/runner/src/executor/job-profile.spec.ts` — new `bot.costLimit` cases; the existing exact-content cases without a cost limit are unchanged.
- `apps/runner/src/executor/nax-process.spec.ts` — new `FIX` and `buildFixArgv` cases; the `REVIEW` and `RUN` exact-argv cases are unchanged.
- `apps/runner/test/unit/host-executor.spec.ts` — new prepare cases asserting the written job profile's `bot` key for `REVIEW`, `FIX` and `RUN` jobs; the existing `RUN` profile reads (lines 175 and 494) are unchanged.

**US-008**
- `apps/runner/test/unit/host-executor.spec.ts` — new `FIX` spawn cases beside the `REVIEW` spawn cases and new attempt-wipe cases for `fix.stdout` and `fix.stderr`.
- `apps/runner/src/bundle/build-bundle.spec.ts` — new case for `fix.stdout` and `fix.stderr`; existing exact-list cases for job dirs without them are unchanged.

**US-009**
- `apps/runner/test/unit/host-executor.spec.ts` — new `spawnFixStep` and `hasFixStep` cases.
- `apps/runner/src/executor/job-executor.ts` — the `JobExecutor` seam gains `spawnFixStep` and `hasFixStep`.
- `apps/runner/test/helpers/fake-executor.ts` — implements `spawnFixStep` and `hasFixStep` so `JobRun` specs can script the second process.

**US-010**
- `apps/runner/src/supervisor/job-run.spec.ts` — new `FIX` chaining cases beside `describe('REVIEW verdicts (US-007)')` (line 96).

**US-011**
- `apps/runner/test/unit/host-executor.spec.ts` — new `readFixOutcome` cases over real files.
- `apps/runner/src/executor/job-executor.ts` — the `JobExecutor` seam gains `readFixOutcome`.
- `apps/runner/test/helpers/fake-executor.ts` — implements `readFixOutcome` so `JobRun` verdict specs can script the fix files.

**US-012**
- `apps/runner/src/supervisor/job-run.spec.ts` — new `FIX` verdict cases; the `REVIEW` verdict cases are unchanged.

**US-013**
- `apps/web/lib/fleet-types.ts` — `FleetJobKind` gains `FIX`, `MisfitReason` gains `bot_fix`, and the web `FleetJobDto` gains the optional `fixOutcome`.
- `apps/web/tests/pages/fleet-jobs-list.spec.ts` — new `FIX` row case beside the `REVIEW` case at line 21; its source-text case at line 154 pins `if (job.command !== 'REVIEW') return job.feature` and is replaced by a rendered case asserting that a `RUN` row shows its feature and `REVIEW` and `FIX` rows show `PR #<n>`.
- `apps/web/tests/pages/fleet-job-detail.spec.ts` — new `FIX` header and outcome cases beside the `REVIEW` header case (lines 381-382).
- `apps/web/tests/i18n/fleet-locale-parity.spec.ts` — its `ENUMS` map pins exact key lists: `fleet.command` gains `FIX`, `fleet.misfit` gains `bot_fix`, and a new entry `fleet.fixOutcome` is `['nothing', 'pushed']`; the exact-set assertion over each entry is unchanged.
- `apps/web/i18n/locales/en.json` — `fleet.command.FIX`, `fleet.misfit.bot_fix`, `fleet.fixOutcome.pushed` and `fleet.fixOutcome.nothing`.
- `apps/web/i18n/locales/zh.json` — the same keys in Chinese.

### Seams

- US-001 -> US-003, US-004, US-006: the protocol `FleetJobKindName` `'FIX'`, `RunnerCapabilities.botFix` and `SnapshotEventPayload.fixOutcome` types land in US-001; the consumers compile against them.
- US-007 -> US-009: `buildFixArgv`, `fixBudgetRemainder` and the `botCostLimitUsd` parameter of `writeJobProfile` are called by `HostExecutor.spawnFixStep` (US-009 AC-3, AC-4).
- US-007 -> US-010, US-012: `fixBudgetRemainder` decides whether step 2 starts (US-010 AC-4) and the budget verdicts (US-012 AC-5, AC-6).
- US-009 -> US-010: `JobRun.watchUntilExit` calls `executor.spawnFixStep` and `executor.hasFixStep` (US-010 AC-1).
- US-010 -> US-012: `JobRun.watchUntilExit` hands the held step-2 failure to `JobRun.judge` (US-012 AC-8).
- US-011 -> US-012: `JobRun.judge` reads the fix files only through `executor.readFixOutcome` (US-012 AC-1).
- US-012 -> US-004: the runner's `fixOutcome` snapshot field is mirrored by the API's `mirror` (US-004 AC-2).

## Acceptance Criteria

### US-001

1. [unit] `normalizeDispatch({ command: 'FIX', prNumber: 7, ... }, 'main')` returns an input whose `feature` is `review-pr-7`.
2. [unit] `normalizeDispatch({ command: 'FIX', prNumber: 7, ... }, 'main')` returns an input whose `ref` is `main`.
3. [unit] `normalizeDispatch` for `FIX` without `prNumber` fails with reason `prNumber required for FIX`.
4. [unit] `normalizeDispatch` for `FIX` with a `feature` fails with reason `feature is derived for FIX`.
5. [unit] `normalizeDispatch` for `FIX` with a `ref` fails with reason `ref is the default branch for FIX`.
6. [unit] `normalizeDispatch` for `FIX` with `bashMode` `gated` fails with reason `bashMode must be raw for FIX`.
7. [unit] `normalizeDispatch` for `FIX` with a non-empty `ticketRefs` fails with reason `ticketRefs is not for FIX`.
8. [unit] `normalizeDispatch` for `FIX` with a `planFrom` fails with reason `planFrom is only for PLAN`.
9. [unit] `normalizeDispatch` for `RUN` with feature `review-pr-3` fails with reason `feature is reserved for REVIEW and FIX`.
10. [unit] `normalizeDispatch` for `PLAN` with a `prNumber` fails with reason `prNumber is only for REVIEW and FIX`.
11. [unit] Validating a `DispatchFleetJobDto` with `command` `FIX` passes.
12. [unit] Validating a `DispatchFleetJobDto` with `command` `fix` fails on `command`.

### US-002

1. [integration] `POST /projects/:slug/fleet/jobs` with `{ command: 'FIX', prNumber: 7, ... }` on a `gitlab` repo answers 422 with `fleet.dispatchInput` reason `fix is GitHub-only`.
2. [integration] `POST /projects/:slug/fleet/jobs` with `{ command: 'FIX', prNumber: 7, ... }` on a GitHub repo answers 201 and stores a job with `command` `FIX` and `feature` `review-pr-7`.
3. [integration] A `FIX` dispatched on a project with one active `DECISION` stores `reviewDecisions` holding that decision's id.
4. [integration] With a `REVIEW` of PR 7 on the same repo in `QUEUED`, `POST /projects/:slug/fleet/jobs` with `{ command: 'FIX', prNumber: 7, ... }` answers 409.
5. [integration] With a `FIX` of PR 7 in `QUEUED`, a project budget hard stop cancels it as it cancels a queued `REVIEW`.

### US-003

1. [unit] `parseCapabilitiesCore({ ...valid, botFix: true })` returns capabilities with `botFix: true`.
2. [unit] `parseCapabilitiesCore({ ...valid, botFix: 'yes' })` fails on `botFix`.
3. [unit] `firstMisfit` for a `FIX` job on a runner with neither `botReview` nor `botFix` returns `bot_review`.
4. [unit] `firstMisfit` for a `FIX` job on a runner with `botReview: true` and no `botFix` returns `bot_fix`.
5. [unit] `firstMisfit` for a `FIX` job on a runner with `botReview: true`, `botFix: true` and matching profiles returns no misfit.
6. [unit] `firstMisfit` for a `REVIEW` job on a runner with `botReview: true` and no `botFix` returns no misfit.
7. [unit] `bot_fix` is not in `PERMANENT_MISFITS`, so a `FIX` misfit `bot_fix` leaves the job queued.
8. [unit] `MISFIT_REASONS` includes `bot_fix`.
9. [unit] `buildAssignPayload` for a `FIX` job with feature `review-pr-9`, git identity name `koda-fleet[bot]` and one stored decision returns `review` `{ prNumber: 9, botLogin: 'koda-fleet[bot]', decisions: [that decision] }`.
10. [unit] `buildAssignPayload` for a `FIX` job with feature `review-pr-x` throws `invalid review feature`.

### US-004

1. [integration] After the migration, the `FleetJob` table has a nullable `fixOutcome` column and a row inserted without it reads `null`.
2. [unit] `mirror` of a snapshot `{ fixOutcome: 'pushed' }` returns a patch with `fixOutcome` `pushed`.
3. [unit] `mirror` of a snapshot `{ fixOutcome: 'nothing' }` returns a patch with `fixOutcome` `nothing`.
4. [unit] `mirror` of a snapshot `{ fixOutcome: 'done' }` returns a patch without `fixOutcome`.
5. [unit] `fixOutcomeOf('pushed')` returns `pushed` and `fixOutcomeOf('nothing')` returns `nothing`.
6. [unit] `fixOutcomeOf('other')` and `fixOutcomeOf(null)` return `null`.
7. [integration] A runner sync whose snapshot for a `FIX` job carries `fixOutcome` `pushed` and a 40-hex `resultSha` stores both, and `GET` of the job returns `fixOutcome` `pushed`.
8. [integration] Requeueing a `FAILED` `FIX` job whose `fixOutcome` column the fixture set to `nothing` leaves the requeued job with `fixOutcome` `null`.
9. [unit] `FleetJobDto.from` of a job record without a `fixOutcome` key returns `fixOutcome` `null`.

### US-005

1. [integration] Draining a `FAILED` `FIX` bundle with the current lease epoch whose `nax.stdout` names a valid trusted `bot-review.json` with one `finding-withdrawn` event stores one pending `FleetReviewEvent` row for that job.
2. [integration] Draining a `COMPLETED` `FIX` bundle with the same artifact stores one pending `FleetReviewEvent` row.
3. [integration] Draining a `CANCELLED` `FIX` bundle whose `nax.stdout` has the artifact line stores the event row.
4. [integration] Draining a `FIX` bundle from an older lease epoch stores no `FleetReviewEvent` row.
5. [integration] Draining a `FAILED` `REVIEW` bundle with a valid withdrawal still stores no `FleetReviewEvent` row.
6. [unit] `BundleIngestService.write` for a `FAILED` `FIX` job with feature `review-pr-5` and the current epoch calls `parseBundle` with `reviewPrNumber` 5.
7. [unit] `BundleIngestService.write` for a `CRASHED` `FIX` job with feature `review-pr-5` calls `parseBundle` without `reviewPrNumber`.

### US-006

1. [unit] The nax probe reports `botFix: true` when the K1 `botReview` checks pass, `nax bot review --help` stdout contains `--full`, and `nax bot fix --help` exits 0 with `--no-rereview` in its stdout.
2. [unit] The nax probe omits `botFix` when `nax bot fix --help` exits 0 without `--no-rereview` in its stdout.
3. [unit] The nax probe omits `botFix` when `nax bot fix --help` exits non-zero.
4. [unit] The nax probe omits `botFix` and still reports `botReview: true` when `nax bot review --help` stdout lacks `--full`.
5. [unit] The nax probe omits `botFix` without calling `nax bot fix --help` when the `botReview` checks fail.
6. [unit] `parseAssign` accepts a `FIX` payload with `review` `{ prNumber: 3, botLogin: 'koda-fleet[bot]' }` and `bashMode` `raw`.
7. [unit] `parseAssign` rejects a `FIX` payload without `review` with `bad('review')`.
8. [unit] `parseAssign` rejects a `FIX` payload with `bashMode` `gated` with `bad('bashMode')`.
9. [unit] `prepareCheckout` for a `FIX` checks out the default branch detached and returns `branch` `null` without reading `prd.json`.
10. [unit] `Supervisor.readopt` of a `RUNNING` `FIX` whose pid is alive and matches the job watches it.
11. [unit] `Supervisor.readopt` of a `RUNNING` `FIX` whose pid is gone finishes it without reading `status.json`.

### US-007

1. [unit] `jobProfileContent('/out', 'p', undefined, 2.5)` returns `{ outputDir: '/out', name: 'p', bot: { costLimit: 2.5 } }`.
2. [unit] `jobProfileContent('/out', 'p')` returns an object without a `bot` key.
3. [unit] `HostExecutor.prepare` for a `REVIEW` job with `maxCostUsd` `"1.5000"` writes a job profile whose `bot.costLimit` is 1.5.
4. [unit] `HostExecutor.prepare` for a `FIX` job with `maxCostUsd` `"2"` writes a job profile whose `bot.costLimit` is 2.
5. [unit] `HostExecutor.prepare` for a `RUN` job writes a job profile without a `bot` key.
6. [unit] `fixBudgetRemainder("1", "0.3000")` returns 0.7.
7. [unit] `fixBudgetRemainder("1", "0.0700")` returns 0.93.
8. [unit] `fixBudgetRemainder("0.05", "0.0500")` returns `null`.
9. [unit] `fixBudgetRemainder("1", undefined)` returns `null`.
10. [unit] `buildNaxArgv` for a `FIX` with PR 4, profiles `['native-codex']` and a decisions path returns `[...nax, 'bot', 'review', '4', '--full', '--profile', 'native-codex,koda-job-<id>', '--decisions', <path>]`.
11. [unit] `buildFixArgv` for a `FIX` with PR 4 and profiles `['native-codex']` returns `[...nax, 'bot', 'fix', '4', '--no-rereview', '--profile', 'native-codex,koda-job-<id>']`.
12. [unit] `buildFixArgv` for a `FIX` whose `review.botLogin` is `koda-fleet` throws `PathError` `invalid review`.

### US-008

1. [unit] `HostExecutor.spawn` for a `FIX` with one decision writes `<jobDir>/review-decisions.json`.
2. [unit] `HostExecutor.spawn` for a `FIX` writes `<jobDir>/forge-token` and passes its path as `NAX_FORGE_TOKEN_FILE`.
3. [unit] `HostExecutor.spawn` for a `FIX` passes `review.botLogin` as `NAX_FORGE_LOGIN`.
4. [unit] `HostExecutor.spawn` for a `FIX` starts nax with the argv `buildNaxArgv` returns for that `FIX`.
5. [unit] When the nax start throws inside `HostExecutor.spawn` for a `FIX`, the token file is removed before the error propagates.
6. [unit] The attempt wipe in `HostExecutor.prepare` removes a `<jobDir>/fix.stdout` left by an earlier attempt.
7. [unit] The attempt wipe in `HostExecutor.prepare` removes a `<jobDir>/fix.stderr` left by an earlier attempt.
8. [unit] `buildBundle` for a job dir containing `fix.stdout` lists `fix.stdout` in the bundle.
9. [unit] `buildBundle` for a job dir containing `fix.stderr` lists `fix.stderr` in the bundle.

### US-009

1. [unit] `HostExecutor.spawnFixStep` with a current token writes `<jobDir>/forge-token` with mode 0600 and passes its path as `NAX_FORGE_TOKEN_FILE`.
2. [unit] `HostExecutor.spawnFixStep` passes `review.botLogin` as `NAX_FORGE_LOGIN`.
3. [unit] `HostExecutor.spawnFixStep` starts the argv `buildFixArgv` returns, with stdout `<jobDir>/fix.stdout` and stderr `<jobDir>/fix.stderr`.
4. [unit] `HostExecutor.spawnFixStep` for a job with `maxCostUsd` `"1"` whose ledger shows `0.3000` spent rewrites the job profile with `bot.costLimit` 0.7 before starting nax.
5. [unit] `HostExecutor.spawnFixStep` for a job whose `fixBudgetRemainder` is `null` throws `budget spent` without writing a token file or starting nax.
6. [unit] `HostExecutor.spawnFixStep` with no current token throws `git token: none` without writing a token file or starting nax.
7. [unit] When the nax start throws inside `HostExecutor.spawnFixStep`, the token file is removed before the error propagates.
8. [unit] `HostExecutor.hasFixStep` returns false for a job dir without `fix.stdout`.
9. [unit] `HostExecutor.hasFixStep` returns true for a job dir with `fix.stdout`.

### US-010

1. [unit] `JobRun` for a `FIX` it spawned, whose first process exits with `readReviewPosted` true, calls `spawnFixStep` once and records the new pid and pgid on the journal row.
2. [unit] `JobRun` for a `FIX` keeps the job `RUNNING` while the fix process is alive and moves to `UPLOADING` only after it exits.
3. [unit] `JobRun` for a `FIX` whose first process exits with `readReviewPosted` false never calls `spawnFixStep`.
4. [unit] `JobRun` for a `FIX` with `maxCostUsd` `"0.05"` whose ledger shows `0.0500` spent after the review step never calls `spawnFixStep`.
5. [unit] `JobRun` for a `FIX` whose `readReviewPosted` throws after the first process exits never calls `spawnFixStep`.
6. [unit] `JobRun` for a `FIX` with a cancel requested during the review step never calls `spawnFixStep`.
7. [unit] `JobRun` for a `FIX` readopted with `watch`, whose step-1 process is alive and then exits with `readReviewPosted` true, never calls `spawnFixStep`.
8. [unit] `JobRun` for a `FIX` whose cancel is requested while `spawnFixStep` is pending sends SIGTERM to the new pgid after step 1's group was already signalled.
9. [unit] `JobRun` for a `FIX` whose step 1 was escalated to SIGKILL and whose step 2 ignores SIGTERM after a cancel escalates step 2's group to SIGKILL after the kill grace.
10. [unit] `JobRun` for a `FIX` halted while `spawnFixStep` is pending records the new pid and pgid on the journal row before returning.
11. [unit] `JobRun` for a `FIX` whose `spawnFixStep` throws calls it once and leaves the watch loop without starting another process.

### US-011

1. [unit] `readFixResult` of a file with the line `nax bot fix: PR #4 — pushed abc1234` returns `kind` `pushed` for PR 4.
2. [unit] `readFixResult` of a file with the line `nax bot fix: PR #4 — nothing to fix; pushed advisor ledger abc1234` returns `kind` `nothing` for PR 4.
3. [unit] `readFixResult` of a file whose only fix line names PR #5 returns `kind` `none` for PR 4.
4. [unit] `readFixResult` returns the path on the `nax bot fix: log ` line as `logPath`, and `null` when there is none.
5. [unit] `readPushedSha('<dir>/bot.jsonl')` returns the `pushedSha` of `<dir>/bot-state.json` when it is 40 lowercase hex.
6. [unit] `readPushedSha('<dir>/bot.jsonl')` returns `null` when `<dir>/bot-state.json` is missing or its `pushedSha` is shorter than 40 characters.
7. [unit] `HostExecutor.readFixOutcome` for a job dir whose `fix.stdout` has the pushed line and a `log` line under `<jobDir>/nax-out/bot/pr-4/` with a valid `bot-state.json` returns `kind` `pushed` and that `pushedSha`.
8. [unit] `HostExecutor.readFixOutcome` for a `log` line naming a path outside `<jobDir>/nax-out/bot/pr-4/` returns `pushedSha` `null`.
9. [unit] `HostExecutor.readFixOutcome` for a `fix.stderr` whose first line is blank and second line is 300 characters returns a `stderrLine` of that second line's first 200 characters.
10. [unit] `HostExecutor.readFixOutcome` for a job dir without `fix.stdout` and `fix.stderr` returns `kind` `none`, `pushedSha` `null` and `stderrLine` `null`.

### US-012

1. [unit] `JobRun.judge` for a `FIX` whose `readFixOutcome` gives `kind` `pushed` and a `pushedSha` returns `COMPLETED` with a snapshot carrying `fixOutcome` `pushed` and that `resultSha`.
2. [unit] `JobRun.judge` for a `COMPLETED` `FIX` returns a snapshot whose `costSpentUsd` is `readPlanCost`'s value.
3. [unit] `JobRun.judge` for a `FIX` whose `readFixOutcome` gives `kind` `pushed` and `pushedSha` `null` returns `COMPLETED` with `fixOutcome` `pushed` and no `resultSha`.
4. [unit] `JobRun.judge` for a `FIX` whose `readFixOutcome` gives `kind` `nothing` and no `pushedSha` returns `COMPLETED` with `fixOutcome` `nothing` and no `resultSha`.
5. [unit] `JobRun.judge` for a `FIX` with the review posted, `hasFixStep` false and a spend of `maxCostUsd` returns `FAILED` with reason `budget spent by review`.
6. [unit] `JobRun.judge` for a `FIX` with the review posted, `hasFixStep` false and `readPlanCost` `undefined` returns `FAILED` with reason `cost ledger unreadable`.
7. [unit] `JobRun.judge` for a `FIX` with the review posted, `hasFixStep` false, budget left and no held spawn failure returns `FAILED` with reason `interrupted before fix`.
8. [unit] `JobRun.judge` for a `FIX` whose step-2 start threw `git token: none` returns `FAILED` with reason `fix spawn failed: git token: none`.
9. [unit] `JobRun.judge` for a `FIX` whose `readReviewPosted` is false returns `FAILED` with reason `review not posted`.
10. [unit] `JobRun.judge` for a `FIX` whose `readReviewPosted` throws returns `FAILED` with reason `review not posted`.
11. [unit] `JobRun.judge` for a `FIX` whose `readFixOutcome` gives `kind` `none` and `stderrLine` `untrusted PR: author is not a writer` returns `FAILED` with that reason.
12. [unit] `JobRun.judge` for a `FIX` whose `readFixOutcome` gives `kind` `none` and `stderrLine` `null` returns `FAILED` with reason `fix not pushed`.
13. [unit] `JobRun.judge` for a `FIX` whose `readFixOutcome` throws returns `FAILED` with reason `fix not pushed`.
14. [unit] `JobRun.judge` for a `FIX` with a cancel requested returns `CANCELLED` without reading `readReviewPosted` or `readFixOutcome`.

### US-013

1. [unit] The job list renders a `FIX` row for feature `review-pr-42` with the command label `PR fix`.
2. [unit] The job list renders a `FIX` row for feature `review-pr-42` with `PR #42` in place of the feature.
3. [unit] The job list renders a `RUN` row with its feature.
4. [unit] The job page header for a `FIX` job with feature `review-pr-42` shows `PR #42`.
5. [unit] The job page for a `COMPLETED` `FIX` with `fixOutcome` `pushed` shows the label `Fix pushed`.
6. [unit] The job page for a `COMPLETED` `FIX` with `fixOutcome` `nothing` shows the label `Nothing to fix`.
7. [unit] The job page for a `RUN` job shows no fix outcome label.
8. [unit] The misfit label for `bot_fix` renders `nax on this runner cannot run PR fixes`.
