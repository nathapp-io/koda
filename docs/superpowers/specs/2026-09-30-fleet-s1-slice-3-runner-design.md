# Fleet S1 Slice 3 — Runner Daemon — Design

Amends and details the fleet S1 spec (`2026-09-29-fleet-s1-dispatch-design.md`, "the S1 spec") for slice 3,
`apps/runner`. Where this document and the S1 spec disagree, this document wins; the S1 spec carries short
pointers here in §2.1, §5.2 and §10.

## Goal

A runner daemon that enrolls with koda, long-polls `POST /fleet/runner/sync`, executes `nax run` / `nax plan`
jobs on a host checkout, reports progress and a verdict, uploads the run bundle, and brokers git credentials so
the machine holds none.

## Rulings (user, 2026-09-30)

- **R-3.1 Split:** slice 3 ships as two PRs. **3a core**: protocol v1 edit, server validator and placement change,
  #157, runner config, enroll, journal, sync loop, `HostExecutor`, watcher, verdicts, PLAN push, bundle, readopt,
  cancel, `ABANDON`, static capabilities, fake-nax tests. **3b edges**: git-cred socket, credential helper and
  `gh`/`glab` shims, `NaxCapabilityProbe`, `install-service` with launchd/systemd units and the AppArmor check,
  live check.
- **R-3.2 Protocol:** the capability report's `credentials` shape changes **in place in v1**
  (`FLEET_PROTOCOL_VERSION` stays `1`). No runner has shipped and koda is not deployed, so no client depends on
  the old shape.
- **R-3.3 Branch:** a RUN job runs on `prd.branchName`, continued from `origin/<branchName>` when it exists,
  otherwise created from `ref`.
- **R-3.4 PLAN output:** a PLAN job commits `.nax/features/<feature>/` onto the generated PRD's `branchName` and
  pushes it; a follow-up RUN dispatches with `ref` = that branch.
- **R-3.5 Output dir:** per job, `<workspaceRoot>/.jobs/<jobId>/nax-out` (as the S1 spec). Retries lose nax's
  local prior-run-failure history; server-side history can feed it later (S2).
- **R-3.6 Sandbox probe:** a small nax PR adds `nax sandbox probe --json`; the runner never re-implements the
  probe.
- **R-3.7 No wait on nax:** 3a and 3b are built against the nax JSON contracts as specified
  (nax `docs/specs/SPEC-cli-json-output.md`); only the 3b merge gate and the live check need released nax.

## Findings behind the rulings (spikes, 2026-09-30, nax main `93cc926a7`)

- **nax does not create a feature branch.** The finish phase pushes the current branch
  (`resolveBranch(workdir)`, `src/execution/runner-completion.ts:476`) and skips itself on a non-feature branch
  (`src/finish/phase.ts:81-112`); `prd.branchName` is never checked out. The S1 spec's "detached HEAD, nax creates
  its own feature branch" (§5.2 step 2) would auto-commit onto a detached HEAD and end in finish `skipped` with no
  push. Hence R-3.3.
- **`nax plan` output is untracked.** `.nax/features/<f>/prd.json` is deliberately not gitignored
  (`src/utils/gitignore.ts:18-31`) and not committed by `plan`, so the next job's clean would delete it. Hence R-3.4.
- **SP-1, per-job `outputDir`: works with caveats.** `outputDir` is a plain root key a profile may set
  (`src/config/schemas.ts:87-92`; only `auth` is global-only, `src/config/global-only-keys.ts`); absolute paths are
  used as-is (`src/runtime/paths.ts:25-27`); `koda-job-<uuid>` is a valid profile name (`src/config/profile.ts:57-74`);
  `nax plan` honours the chain and `outputDir` (`src/cli/plan-runtime/index.ts:82`). Moved under `outputDir`:
  `status.json`, run logs and `latest.jsonl`, cost ledger, review/prompt/tool audit, `metrics.json`, feature lock,
  finish-audit, approvals. **Not moved:** `events.jsonl` (`~/.nax/events/<basename(workdir)>/`, shared),
  run registry, project identity, the checkout `nax.lock`, and the repo's `.nax/features/<f>/` (prd, checkpoint,
  plan log). Caveats: the job profile must exist until nax exits (the chain is re-read on per-package reloads,
  `src/config/profile.ts:206-219`); two repos with the same basename collide on project identity
  (`RUN_NAME_COLLISION`, `src/runtime/paths.ts:83-115`) unless `name` is set; `name` must match
  `/^[a-z0-9_-]+$/`, at most 64 characters, not starting with `.` or `_` (`src/config/schemas.ts:72-86`).
  `latest.jsonl` is symlinked only after the run returns (`bin/nax.ts:362-375`); during the run the log is
  `<outputDir>/features/<f>/runs/<logRunId>.jsonl` (`bin/run-action.ts:427-432`).
- **SP-4, what survives between runs:** nax's runtime files are gitignored (`NAX_GITIGNORE_ENTRIES`,
  `src/utils/gitignore.ts:32-97`, also written to `.git/info/exclude` at run start). `checkpoint.jsonl` is ignored
  but needed for resume; `prd.json`, `spec.md` and acceptance files are not ignored and are committed by a
  completed run's `git add -A` (`src/execution/runner-completion.ts:454-463`). A stale `nax.lock` is reclaimed by
  nax when its pid is dead (`src/execution/lock.ts:226`).

## 1. Architecture (3a)

`apps/runner` is a Bun workspace member, package `@nathapp/koda-runner` (Bun-only APIs: `bun:sqlite`,
`Bun.spawn`; `@types/bun`; its own `.eslintrc.cjs`), tested with `bun test`, type-importing
`@nathapp/fleet-protocol`. Compiled with `bun build --compile` (darwin-arm64, darwin-x64, linux-x64). Scripts
`test` (`bun test src test/unit`, no database), `test:integration`, `type-check` and `lint` exist so turbo picks
the app up. Repo wiring: `.nax/mono/apps/runner/context.md` and `.nax/mono/apps/runner/config.json` (bun test
commands, not the jest `test:scoped` wrapper), the `.nax/context.md` app tree and list, `nax generate`, `bun.lock`.

```
apps/runner/src/
  main.ts            koda-runner run | enroll | status   (3b adds install-service, uninstall-service, git-cred, shim)
  config/            runner.json: serverUrl (https unless loopback or --insecure-http), workspaceRoot,
                     labels (sent at enroll only), naxCommand (default ["nax"]), naxHome (default: nax's
                     globalConfigDir, NAX_GLOBAL_CONFIG_DIR else ~/.nax), jobRetentionDays (default 7),
                     socketDir (default /tmp/koda-runner-<uid>, 3b),
                     capabilities (3a only). No capacity: the server owns it (GET /fleet/runner/me, #157).
  identity/          runnerId + apiKey file (mode 0600); bootId, new per daemon start
  journal/           bun:sqlite, see §1.4
  sync/              the sync client, see §1.3
  supervisor/        one per active job: owns its executor and watcher; a per-repo mutex serialises a repo's
                     jobs across ASSIGN and cleanup
  executor/          JobExecutor seam { prepare, spawn, watch, kill, collectBundle, cleanup } + HostExecutor
  watcher/           status.json poll (2s) + run log tail + nax stdout/stderr files -> journal events
  verdict/           pure functions: S1 spec §5.2 step 6 table (RUN), PLAN check (§2 step 7)
  bundle/            tar.gz + upload, see §2 step 9
  capabilities/      CapabilityProbe seam; 3a ships StaticCapabilityProbe (runner.json)
  paths/             validated path building: owner, repo name and jobId must match [A-Za-z0-9._-]+, not . or ..
```

Boundaries: the runner calls only enroll, sync, bundle upload and `GET /fleet/runner/me`. The executor never
talks to the server; it writes journal events and the sync loop ships them. `freeSlots = me.capacity - active
jobs`, with `capacity` refreshed from `/me` at start and every 5 minutes.

**3a depends on nothing from 3b, and says so where it matters:** 3a sets `user.name` / `user.email` from the
ASSIGN `gitIdentity` on the clone (the RUN auto-commit and the PLAN commit need them). 3a has no credential
helper, so it never sends `tokenRequests` and ignores `gitTokens`; a clone, fetch or push that fails with an
authentication error fails the job with `stateReason = 'no git credentials (runner 3b)'`. 3a is exercised end
to end only against `file://` remotes (tests map the server's `https://<host>/<owner>/<repo>.git` clone URL with
`url.<file-url>.insteadOf` through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`).

> **Superseded in 3b-1 (D89, D91):** an authentication failure is now `git auth failed`, and the integration
> harness no longer maps clone URLs to `file://`: an authenticated git-HTTP front (`git http-backend`) serves the
> repositories, so every scenario authenticates through the credential helper.

### 1.1 Protocol v1 edit (R-3.2)

`RunnerCapabilities.credentials` becomes a mirror of `nax auth list --json`, minus account labels:

```ts
export interface RunnerCredential {
  providerId: string;
  available: boolean;                                   // nax's verdict: stored, exec-served or ambient
  stored: { kind: 'api-key' | 'oauth'; expires?: string; expired: boolean } | null;
  exec?: 'served' | 'declined' | 'error';               // present when nax auth.source is exec
  ambient: boolean;
}
```

`ProfileNeeds` is unchanged; `protocol` is filled from nax's `requirements.transport`. Server changes in 3a:

- `apps/api/src/fleet/common/capabilities.ts:45-55`: the #161 validator accepts the new shape with a new
  key whitelist (same caps: at most 64 credentials, `expires` must parse).
- `apps/api/src/fleet/jobs/placement-rules.ts` (`MisfitReason`, `PERMANENT_MISFITS`, lines 48-50): a needed
  provider fails with `provider_missing` when absent and `provider_unavailable` when `available` is false.
  `provider_unavailable` is **not** permanent (the job queues; a later probe may fix it). `provider_expired` is
  removed: nax's `available` deliberately ignores access-token expiry because a stored OAuth credential
  refreshes itself, so placement follows nax's own verdict rather than second-guessing it.
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts:66` (reason enum), `openapi.json`, `apps/cli/src/generated`
  (`bun run generate`; the `openapi-spec` integration test pins the committed spec).
- Tests updated in the same story: `capabilities.spec.ts`, `placement-rules.spec.ts`, and the shared
  `apps/api/test/helpers/fleet-fixtures.ts` `FLEET_CAPS` used by ten integration specs. No Prisma migration
  (`Runner.capabilities` is `Json`); no web consumer exists yet.

### 1.2 #157 folded into 3a

`RunnerPrincipal` (`auth/principal/koda-principal.types.ts:27`) and `toRunnerPrincipal`
(`combined-auth.guard.ts:123`) gain `capacity`, and `GET /fleet/runner/me` (`runner-api.controller.ts:36`) returns
it. `EnrollmentService.enroll` rejects a token without the `ke_` prefix with the existing bad-token
convention, `AuthException({}, 'fleet.enroll')` (401), before the hash lookup.

### 1.3 Sync client

- **Envelope:** every response is `JsonResponse.Ok` (`{ret, data}`); the client unwraps `data`.
- **Loop:** one request in flight. The server holds an idle request up to `syncWaitMs` (25s) and never sets
  `nextPollAfterMs`. When a journal row is written while a poll is idle-waiting, the client aborts that poll and
  syncs immediately (safe: unacked commands are re-sent). Client timeout 35s. Minimum 250 ms between syncs.
  Network errors and 5xx back off exponentially from 1s to 60s with full jitter.
- **Stops:** 426 stops the loop and logs the supported range; 401 (`fleet.runnerAuth`) stops the loop and logs
  that the runner key was rejected (disabled or deleted runner). A 400 or 413 on a batch is a runner bug: log
  it, halve the batch and retry, and after a one-event batch still fails, drop that event with an `error`
  lifecycle entry (never resend it forever).
- **Batch limits** (`sync-request.parser.ts:4`, body 1 MiB): at most 64 jobs, 500 events per job, 256 acks,
  64 token requests, 16,384 bytes per event payload measured as serialised JSON bytes. `log` text is truncated
  to fit, counting escaped bytes.
- **Response handling:** `jobAcks` advance each job's contiguous acked seq; `commands` go to supervisors;
  `unknownJobIds` are abandoned locally (kill, drop, push nothing); `gitTokens` / `gitTokenErrors` are ignored in
  3a and handled in 3b (§3.1).
- **Commands:**
  - `ASSIGN`: insert the job row (durable), ack `ok`, then start workspace preparation. A repeated ASSIGN for a
    `(jobId, leaseEpoch)` already applied is acked `ok` without re-running.
  - `CANCEL`: ack after the SIGTERM has been sent (the cancel outcome is reported as a state event).
  - `ABANDON` (`stale_lease` or `job_terminal`): keyed by `(jobId, leaseEpoch)`, so a requeued job at a newer
    epoch is untouched. Kill if running, drop that epoch's journal rows except the applied-command row, ack `ok`.
  - `READOPT`: §2 control paths.
- **Legal transitions only.** The runner emits exactly the S1 spec §5.4 runner-reported transitions. The server
  stores and acks an illegal transition without applying it (plan D6), which would strand the job, so the
  supervisor's state machine refuses to emit one and logs a `lifecycle` error instead. A RUN always goes
  RUNNING -> UPLOADING -> terminal.
- **Snapshot mapping** from `status.json`: `run.id` -> `naxRunId`; the run log basename -> `naxLogRunId`;
  the cost ledger file's run id -> `naxCostRunId` (omitted when absent); `progress`; `currentStoryId`;
  `currentPhase`; `cost.spent` -> `costSpentUsd` (string, at most 4 decimals); `lastHeartbeat` -> `heartbeatAt`;
  `postRun.finish.{result,url,escalationReason}` -> `finishResult`, `resultPrUrl`, `escalationReason`;
  `resultBranch` / `resultSha` from finish-audit `last.json` (RUN) or the PLAN push (§2 step 8), sent in a final
  snapshot before the terminal state event.

### 1.4 Journal (bun:sqlite, WAL)

```
jobs(job_id, lease_epoch, command, state, repo_key, branch, pid, pgid, nax_run_id, log_path, job_dir,
     assign_json, created_at, updated_at, done_at)            PK (job_id, lease_epoch)
events(job_id, lease_epoch, seq, type, payload_json, created_at, acked)   PK (job_id, lease_epoch, seq)
applied_commands(command_id PK, job_id, lease_epoch, type, result, applied_at)
meta(key PK, value)                                           boot_id, runner_id, last_capabilities_hash
```

Every row is written before the send that reports it. `seq` is per `(job_id, lease_epoch)`, contiguous from 1.
Retention: a job's rows and its `<jobDir>` are pruned `jobRetentionDays` after `done_at` (journal state, not
file mtime), at daemon start and daily.

## 2. Job execution (3a, HostExecutor)

Per `ASSIGN`, under the repo's mutex, each step journaled before it is reported:

1. **Workspace.** One clone per repo at `<workspaceRoot>/<owner>/<repo>` (validated path segments), cloned
   from `cloneUrl` on first use, then reused. `user.name` / `user.email` set from `gitIdentity`.
2. **Clean.** `git fetch --prune origin`; `git reset --hard HEAD` (discards tracked edits such as a crashed
   run's modified `prd.json`; never moves the branch); `git clean -ffd` (no `-x`: ignored `checkpoint.jsonl`
   survives); `git worktree prune`.
3. **Resolve `ref`.** `origin/<ref>` if that remote branch exists, else `<ref>` as a tag or commit
   (`git rev-parse --verify <x>^{commit}`). Unresolvable: ASSIGNED -> FAILED, `stateReason = 'checkout: ref not
   found'`.
4. **Branch (RUN, R-3.3).** Read `branchName` from `git show <resolved-ref>:.nax/features/<f>/prd.json`.
   Validate it: `git check-ref-format --branch` accepts it, it does not start with `-`, and it is not
   `repo.defaultBranch`, `main` or `master`. Then:
   - `origin/<branchName>` exists and the local branch does not: `git checkout -B <branchName>
     origin/<branchName>`.
   - both exist, origin is an ancestor of local: `git checkout <branchName>` (keeps unpushed run commits).
   - both exist, local is an ancestor of origin: `git checkout -B <branchName> origin/<branchName>`.
   - both exist and diverged: FAILED, `stateReason = 'checkout: branch diverged'` (never discards commits).
   - neither exists: `git checkout -B <branchName> <resolved-ref>`.
   When `origin/<branchName>` exists, `ref` only supplies the `branchName`; the run continues the branch.
   Missing or unparsable PRD, empty or invalid `branchName`: FAILED, `stateReason = 'checkout: <reason>'`.
   PLAN: `git checkout --detach <resolved-ref>`. A repo without `.nax/` is FAILED, `stateReason = 'no .nax
   dir'` (`nax plan` needs it). Before spawning, `prd.json` and `prd.rejected.json` of the feature are moved to
   `<jobDir>/pre-plan/` so a stale file cannot pass the verdict.
5. **Job profile.** Write `<naxHome>/profiles/koda-job-<jobId>.json` =
   `{"outputDir": "<jobDir>/nax-out", "name": "<projectName>"}`, appended last to the chain, deleted only after
   the nax process has exited. `projectName` = `<owner>/<repo>` lowercased, every character outside `[a-z0-9_-]`
   replaced by `-`, leading `-`, `_` and `.` stripped, truncated to 55 characters, then `-` and the first 8 hex
   characters of SHA-256(`<owner>/<repo>`). Example: `Foo.Bar/My.Repo` -> `foo-bar-my-repo-<8 hex>`.
6. **Spawn.** `Bun.spawn({ detached: true })` (own session and process group on macOS and Linux; no `setsid`
   binary) with the S1 spec's argv, cwd = the clone, stdout/stderr redirected to `<jobDir>/nax.stdout` and
   `<jobDir>/nax.stderr` (a pipe would die with the daemon). pid and pgid journaled; RUNNING.
7. **Watch and verdict.** Poll `<jobDir>/nax-out/status.json` every 2s, each change a `snapshot` event (parse
   failures retried; five in a row logged as a `lifecycle` warning). The run log is the one `*.jsonl` other than
   `latest.jsonl` under `<jobDir>/nax-out/features/<f>/runs/` (a fresh output dir holds exactly one run),
   tailed as `log` events with `stream: 'run'`; the stdout/stderr files are tailed as `stream: 'stdout' |
   'stderr'`; logs are rate-capped with `droppedLogs`. Liveness is `kill(pid, 0)`; the verdict is computed from
   `status.json` and files alone, never from an exit code (a readopted child is not a child process).
   - RUN: the S1 spec §5.2 step 6 table, unchanged, cancel rows first.
   - PLAN: COMPLETED when the process has exited and a new `prd.json` exists (the old one was moved aside),
     parses, and has a non-empty `userStories`; otherwise FAILED.
8. **PLAN commit and push (R-3.4).** Read the new PRD's `branchName` (validated as in step 4). Copy the plan
   outputs to `<jobDir>/plan-out/`, then check out the branch by the step 4 rules, using `checkout -f` so
   untracked plan files cannot block it, and copy the outputs back. `git add` an explicit allowlist under
   `.nax/features/<f>/`: `prd.json`, `spec.md`, `prd-fidelity-report.md`, `acceptance-meta.json` (those present);
   never `plan/`, `sessions/` or `prd.rejected.json`. Commit as `gitIdentity` with message `chore(plan): <feature>
   PRD via koda job <jobId>`; `git push --set-upstream origin <branchName>`. `resultBranch` / `resultSha` point at
   it. Push failure: FAILED, `stateReason = 'plan push failed'`, commit kept locally.
9. **Bundle.** UPLOADING, then a tar.gz of `<jobDir>/nax-out` minus `prompt-audit/`, plus `nax.stdout`,
   `nax.stderr`, and for PLAN `.nax/features/<f>/plan/*.jsonl`. `PUT /fleet/runner/jobs/<jobId>/bundle
   ?leaseEpoch=<epoch>` with Bearer runner key, `Content-Type: application/gzip`, `Content-Length`, and
   `X-Content-SHA256` (lowercase hex). Three attempts with backoff on network errors and 5xx; 422 rebuilds the
   archive once; 413 is not retried (terminal state with `stateReason = 'bundle too large'`); 409 means a stale
   lease and is handled as `ABANDON`. After three failures: the verdict state with `stateReason = 'bundle upload
   failed'`, bundle kept on disk.
10. **Cleanup.** Delete the job profile and (3b) the socket, mark the job done in the journal, release the repo
    mutex. `<jobDir>` is kept until retention prunes it.

Control paths:

- **Cancel:** SIGTERM to the process group, SIGKILL after 30s, reap `.nax-pids` (at the checkout root), partial
  bundle, CANCELLED.
- **ABANDON:** §1.3.
- **READOPT** (after a daemon restart, per job): ack `ok` and re-attach the watcher when `kill(pid, 0)` succeeds,
  `status.json` `run.id` equals the journaled `naxRunId`, and `lastHeartbeat` is under 2 minutes old. Also ack
  `ok` when the pid is gone but `status.json` is final and its `run.id` matches: compute the verdict, bundle and
  report normally (a run that finished while the daemon was down is not lost). Otherwise reap `.nax-pids` and
  ack `rejected`.
- A stale checkout `nax.lock` is left for nax to reclaim once the pid is dead.
- The S1 spec §2.1 post-checkout `capability mismatch` check needs the nax probe and moves to 3b (§3.2).

## 3. Edges (3b)

### 3.1 Git credential broker

> **Amended by plan 3b-1 (D78, D79, D82):** the socket is `<socketDir>/<16 hex>.sock` (default
> `/tmp/koda-runner-<uid>`, mode 0700, checked at start), not `<jobDir>/git-cred.sock`, because a unix socket path
> is limited to 104 bytes on macOS. The wire words and the token-error rule are in the plan's decision register.

- **Tokens:** a `tokenRequest` is sent on ASSIGN, and again when the cached token is within 240 s of
  `expiresAt` (the server reuses a cached token until 300 s before expiry, `git-token.broker.ts:34`, so an earlier
  request returns the same token), repeating until `expiresAt` changes. `gitTokenErrors` fail a job that has no
  usable token with `stateReason = 'git token: <reason>'`.
- **Socket:** `<jobDir>/git-cred.sock`, mode 0600, served by the daemon from the TokenCache for that job only.
  Request: one line; reply: one JSON object `{username, token, expiresAt}`. Refuses once the job's epoch changes
  or the job ends.
- **Helper:** the compiled binary is the helper, `koda-runner git-cred <sock>`, speaking git's credential
  protocol (`username=x-access-token` for GitHub, `oauth2` for GitLab), set as `credential.helper` on the clone
  at job start (one active job per clone). The runner's own clone, fetch and PLAN push use it.
- **Shims:** `<jobDir>/bin/gh` and `<jobDir>/bin/glab` are scripts that `exec koda-runner shim <gh|glab> <sock>
  -- "$@"`. The shim fetches the token, sets `GH_TOKEN` / `GITLAB_TOKEN` for that child only, and execs the real
  binary found on `PATH` with `<jobDir>/bin` removed. nax runs with `PATH=<jobDir>/bin:$PATH` and no token in
  its environment.

### 3.2 Capability probe (`NaxCapabilityProbe`)

Runs at boot, every 10 minutes and on SIGHUP; the report is sent in `sync` only when its hash (excluding
`sandbox.probedAt`) changes.

- `nax --version`.
- Machine profiles: `<naxHome>/profiles/*.json`, excluding `koda-job-*`, at most 64. For each,
  `nax config --profile <name> --json` run from an empty temp dir (no project config) ->
  `ProfileNeeds { protocol: requirements.transport, providers: requirements.providers, sandbox:
  requirements.sandbox }`. A profile that fails to resolve is skipped with a `lifecycle` warning.
- Credentials: `nax auth list --json <union of providers>` -> `RunnerCredential[]` (§1.1).
- `nax.protocols`: `native` always; `acp` when `acpx --version` succeeds.
- `tools`: `git`, `gh`, `glab` via `--version`.
- Sandbox: `nax sandbox probe --json` (R-3.6). Until that command exists, report
  `{ available: false, error: 'nax sandbox probe unavailable' }`.
- Post-checkout check (S1 spec §2.1): after checkout, the runner resolves the job's full chain in the clone with
  `nax config --profile <chain> --json`; a need the machine does not meet fails the job with `stateReason =
  'capability mismatch: <detail>'`.

### 3.3 Service units

- `koda-runner install-service` writes a systemd unit (`User=koda-runner`, `KillMode=process`, `Restart=always`)
  or a launchd plist (`UserName`, `AbandonProcessGroup=true`, `KeepAlive`). It requires the OS user to exist;
  creating it is a documented step (macOS `dscl`, Linux `useradd`), not automated. `uninstall-service` reverses
  it.
- Linux 24.04+: detects `kernel.apparmor_restrict_unprivileged_userns=1` and, with `--apply-apparmor`, writes a
  targeted AppArmor profile for `bwrap`; verified on a real 24.04 host in the live check.
- A restart test per platform: a running nax child survives `systemctl restart` / `launchctl kickstart -k`.

## 4. Testing

TDD throughout, `bun test` in `apps/runner`.

- **Unit (`bun test src test/unit`, no database):** verdict rows (cancel-first, finish `skipped`, PLAN stale
  file); ref resolution; branch selection (all five cases of §2 step 4) and `branchName` validation; clean and
  checkout argv; `projectName` derivation (`Foo.Bar/My.Repo`, a 100-character name, a name starting with `.`);
  job profile content and delete-after-exit; path validation; journal persist-before-send, contiguous ack cursor,
  resend; sync loop (abort-on-write, timeout, backoff, 401/426 stop, batch halving); command handling (ASSIGN
  replay, ABANDON by epoch, legal-transition guard); snapshot mapping; bundle headers and status handling; run-log
  discovery; READOPT rules including the finished-while-down case; in 3b TokenCache timing, credential protocol,
  shim PATH search, probe mapping from nax JSON fixtures (copied from nax `SPEC-cli-json-output.md`), unit/plist
  generation.
- **fake-nax fixture:** `test/fixtures/fake-nax.ts` via `naxCommand`. Reads `--profile`, resolves the job
  profile's `outputDir`, writes real-shaped `status.json` snapshots, `features/<f>/runs/<logRunId>.jsonl`
  (`latest.jsonl` only at exit, as nax does) and `metrics.json`, auto-commits onto the current branch, and ends
  in a scenario: completed with PR, escalated, failed, crashed, hang (for cancel), plan valid, plan invalid.
- **Integration (`test/integration`, `describe.skipIf(!process.env.KODA_DB_TESTS)`):** a harness modelled on the
  Playwright `webServer` block (`apps/web/playwright.config.ts:39-63`):
  - guards the database URL with the API's `assertSafeTestDatabaseUrl`, runs `prisma migrate deploy` against
    it, then applies the partial unique indexes the jest `globalSetup` adds (`apps/api/test/global-setup.ts`);
  - starts `bun apps/api/dist/main` (built by `bunx turbo run build --filter=@nathapp/koda-api`) on a random
    port with `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `API_KEY_SECRET`, `API_PORT`,
    `RAG_IN_MEMORY_ONLY=true`, `EMBEDDING_PROVIDER=fake`, `REGISTRATION_ENABLED=true`, a high
    `AUTH_LOGIN_THROTTLE_LIMIT`, a short `FLEET_SYNC_WAIT_MS`, a temp `FLEET_ARTIFACT_DIR`, `VCS_ENCRYPTION_KEY`
    and `GITHUB_APP_*` pointing at an in-test fake forge (the API's `test/helpers/fake-forge.ts` pattern);
  - seeds admin, project, repo and enrollment token over HTTP, and runs the daemon in process against an
    authenticated git-HTTP front of the bare remotes (3b-1 D91; 3a used an insteadOf mapping to file://).
  - 3a scenarios: RUN happy path, PLAN commit and push, cancel, daemon kill then READOPT (both the running and
    the finished-while-down case), network cut then resend from the ack cursor, stale epoch then `ABANDON`.
    3b: clone, push and `gh pr create` through helper and shims with a fake `gh`; no token in nax's environment,
    the journal or logs.
- **CI:** no new required check. Runner `type-check`, `lint` and unit `test` join the existing turbo jobs; the
  runner integration suite is a step in the existing `integration` job (Postgres and the API build are already
  there).
- **3b merge gate:** the probe runs once against released `nax config --json` and `nax auth list --json`.
- **Live check (last, billed, user approval at launch):** one real two-machine run of a trivial feature through
  the GitHub App.

## 5. Delivery

1. nax: `cli-json-output` (in flight), then `nax sandbox probe --json` (small PR). Neither blocks 3a or 3b code.
2. koda 3a: §1 (including §1.1-§1.4), §2, repo wiring, S1 spec pointers.
3. koda 3b: §3; merge gate needs the nax PRs released.

## Out of scope

- Container and VM executors (S1 spec §5.5), C10 provider-credential broker (S1 spec §9.6).
- Server-side run history for nax's prior-run-failure context (S2).
- Automating OS-user creation.
- Account labels from `nax auth list` in the capability report.
