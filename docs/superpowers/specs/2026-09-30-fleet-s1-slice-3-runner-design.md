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
  (`RUN_NAME_COLLISION`, `src/runtime/paths.ts:83-115`) unless `name` is set.
- **SP-4, what survives between runs:** nax's runtime files are gitignored (`NAX_GITIGNORE_ENTRIES`,
  `src/utils/gitignore.ts:32-97`, also written to `.git/info/exclude` at run start). `checkpoint.jsonl` is ignored
  but needed for resume; `prd.json`, `spec.md` and acceptance files are not ignored and are committed by a
  completed run's `git add -A` (`src/execution/runner-completion.ts:454-463`). A stale `nax.lock` is reclaimed by
  nax when its pid is dead (`src/execution/lock.ts:226`).

## 1. Architecture (3a)

`apps/runner` is a Bun workspace member (Bun-only APIs: `bun:sqlite`, `Bun.spawn`), tested with `bun test`,
type-importing `@nathapp/fleet-protocol`. Compiled with `bun build --compile` (darwin-arm64, darwin-x64,
linux-x64).

```
apps/runner/src/
  main.ts            koda-runner run | enroll | status   (3b adds install-service, uninstall-service, git-cred, shim)
  config/            runner.json: serverUrl (https unless loopback or --insecure-http), workspaceRoot, labels,
                     capacity, naxCommand (default ["nax"]), jobRetentionDays (default 7), capabilities (3a only)
  identity/          runnerId + apiKey file (mode 0600); bootId, new per daemon start
  journal/           bun:sqlite: jobs, outbound events (seq, leaseEpoch, payload, acked), applied commands.
                     Every row is written before the send that reports it.
  sync/              long-poll loop: SyncRequest from unacked journal rows, applies FleetCommandOut,
                     stores gitTokens in an in-memory TokenCache, sends tokenRequests 10 min before expiry;
                     a 426 stops the loop
  supervisor/        one per active job: owns its executor and watcher, receives ASSIGN/CANCEL/READOPT/ABANDON
  executor/          JobExecutor seam { prepare, spawn, watch, kill, collectBundle, cleanup } + HostExecutor
  watcher/           status.json poll (2s) + run JSONL tail -> journal events
  verdict/           pure functions: S1 spec §5.2 step 6 table (RUN), prd.json check (PLAN)
  bundle/            tar.gz of <jobDir>/nax-out (minus prompt-audit/) + upload with epoch, 3 attempts
  capabilities/      CapabilityProbe seam; 3a ships StaticCapabilityProbe (runner.json)
```

Boundaries: the runner calls only enroll, sync, bundle upload and `GET /fleet/runner/me`. The executor never
talks to the server; it writes journal events and the sync loop ships them. In 3a nothing reads the TokenCache
(3b adds the socket), so 3a's executor clones only remotes that need no credentials, such as `file://` in tests.

### 1.1 Protocol v1 edit (R-3.2)

`RunnerCapabilities.credentials` becomes a mirror of `nax auth list --json`, minus account labels:

```ts
export interface RunnerCredential {
  providerId: string;
  available: boolean;                                   // nax's own verdict; placement keys on it
  stored: { kind: 'api-key' | 'oauth'; expires?: string; expired: boolean } | null;
  exec?: 'served' | 'declined' | 'error';               // present when nax auth.source is exec
  ambient: boolean;
}
```

`ProfileNeeds` is unchanged; `protocol` is filled from nax's `requirements.transport`. Server changes in 3a:
the #161 validator (`apps/api/src/fleet/common/capabilities.ts`) accepts the new shape (same caps: at most 64
credentials, `expires` must parse), and placement (`apps/api/src/fleet/jobs/placement-rules.ts:48-50`) fails a
needed provider with `provider_missing` when absent and `provider_unavailable` when `available` is false. The
`provider_expired` reason is removed: a stored OAuth credential with a past access-token expiry is refreshable,
and nax's `available` already accounts for it. `openapi.json` and the CLI client are regenerated.

### 1.2 #157 folded into 3a

`GET /fleet/runner/me` returns `capacity`; `EnrollDto.enrollmentToken` rejects a value without the `ke_` prefix
using the existing bad-token convention.

## 2. Job execution (3a, HostExecutor)

Per `ASSIGN`, each step journaled before it is reported:

1. **Workspace.** One clone per repo at `<workspaceRoot>/<owner>/<repo>`, cloned from `cloneUrl` on first use,
   then reused. Placement allows one active job per repo per runner, so a clone never has two writers.
2. **Clean.** `git fetch --prune origin`, `git clean -ffd` (no `-x`: ignored `checkpoint.jsonl` survives),
   `git worktree prune`. No `git reset --hard` onto a remote branch, so unpushed run commits are never destroyed.
3. **Branch (R-3.3).**
   - RUN: read `branchName` from `git show <ref>:.nax/features/<f>/prd.json`. If `origin/<branchName>` exists,
     `git checkout -B <branchName> origin/<branchName>`; else `git checkout -B <branchName> <ref>`. A missing or
     unparsable PRD, or an empty `branchName`, is ASSIGNED→FAILED with `stateReason = 'checkout: <reason>'`.
   - PLAN: `git checkout --detach <ref>`; the branch is created after planning (step 8).
4. **Job profile.** Write `~/.nax/profiles/koda-job-<jobId>.json` =
   `{"outputDir": "<jobDir>/nax-out", "name": "<owner>__<repo>"}`, appended last to the chain. Deleted only after
   the nax process has exited (SP-1 caveat).
5. **Spawn.** `setsid` + the S1 spec's argv; pid and process group journaled; RUNNING.
6. **Watch.** Poll `<jobDir>/nax-out/status.json` every 2s, each change a `snapshot` event (parse failures retried,
   five in a row logged as a `lifecycle` warning). Tail `<jobDir>/nax-out/features/<f>/runs/latest.jsonl` as `log`
   events, rate-capped with `droppedLogs`. The process exit ends the watch. `events.jsonl` is not read (it is
   shared per repo basename under `~/.nax/events/`).
7. **Verdict.** The S1 spec §5.2 step 6 table, unchanged, as a pure function; cancel rows first.
8. **PLAN commit and push (R-3.4).** On a valid PRD: read its `branchName`; `git checkout -B <branchName>
   origin/<branchName>` when that exists, else `-B <branchName> HEAD`; commit `.nax/features/<f>/` as the ASSIGN
   `gitIdentity` with message `chore(plan): <feature> PRD via koda job <jobId>`; push with `--set-upstream`.
   `resultBranch` / `resultSha` point at it. A push failure is FAILED with `stateReason = 'plan push failed'`; the
   commit stays local. An invalid PRD is FAILED and nothing is committed.
9. **Bundle.** UPLOADING, then a tar.gz of `<jobDir>/nax-out` minus `prompt-audit/`; PLAN jobs add
   `.nax/features/<f>/plan/*.jsonl`. Upload keyed by epoch, three attempts with backoff (S1 spec §5.2 step 7).
10. **Cleanup.** Delete the job profile and (3b) the socket; keep `<jobDir>` for `jobRetentionDays`, pruned at
    daemon start and daily; mark the job done in the journal.

Control paths: **cancel** = SIGTERM to the process group, SIGKILL after 30s, reap `.nax-pids`, partial bundle,
CANCELLED. **ABANDON** = kill, drop the job's journal rows and socket, push nothing. **READOPT** = the S1 spec
§5.3 rule (pid alive, `naxRunId` matches, heartbeat under 2 minutes) else `rejected`. A stale `nax.lock` is left
for nax to reclaim once the pid is dead.

## 3. Edges (3b)

### 3.1 Git credential broker

- **Socket:** `<jobDir>/git-cred.sock`, mode 0600, served by the daemon from the TokenCache for that job only.
  Request: one line; reply: one JSON object `{username, token, expiresAt}`. Refuses once the job's epoch changes
  or the job ends.
- **Helper:** the compiled binary is the helper, `koda-runner git-cred <sock>`, speaking git's credential
  protocol (`username=x-access-token` for GitHub, `oauth2` for GitLab). At job start the runner sets
  `credential.helper`, `user.name` and `user.email` on the clone (safe: one active job per clone). The runner's
  own clone, fetch and PLAN push use the same helper.
- **Shims:** `<jobDir>/bin/gh` and `<jobDir>/bin/glab` are scripts that `exec koda-runner shim <gh|glab> <sock>
  -- "$@"`. The shim fetches the token, sets `GH_TOKEN` / `GITLAB_TOKEN` for that child only, and execs the real
  binary found on `PATH` with `<jobDir>/bin` removed. nax is spawned with `PATH=<jobDir>/bin:$PATH` and no token
  in its environment.

### 3.2 Capability probe (`NaxCapabilityProbe`)

Runs at boot, every 10 minutes and on SIGHUP; the report is sent in `sync` only when its hash changes.

- `nax --version`.
- Machine profiles: `~/.nax/profiles/*.json`, excluding `koda-job-*`, at most 64. For each,
  `nax config --profile <name> --json` run from an empty temp dir (no project config) ->
  `ProfileNeeds { protocol: requirements.transport, providers: requirements.providers, sandbox:
  requirements.sandbox }`. A profile that fails to resolve is skipped with a `lifecycle` warning.
- Credentials: `nax auth list --json <union of providers>` -> `RunnerCredential[]` (§1.1).
- `nax.protocols`: `native` always; `acp` when `acpx --version` succeeds.
- `tools`: `git`, `gh`, `glab` via `--version`.
- Sandbox: `nax sandbox probe --json` (R-3.6). Until that nax command exists, report
  `{ available: false, error: 'nax sandbox probe unavailable' }`, which keeps sandbox-requiring jobs off the
  machine.

### 3.3 Service units

- `koda-runner install-service` writes a systemd unit (`User=koda-runner`, `KillMode=process`, `Restart=always`)
  or a launchd plist (`UserName`, `AbandonProcessGroup=true`, `KeepAlive`). It requires the OS user to exist
  already; creating it is a documented step (macOS `dscl`, Linux `useradd`), not automated. `uninstall-service`
  reverses it.
- Linux 24.04+: detects `kernel.apparmor_restrict_unprivileged_userns=1` and, with `--apply-apparmor`, writes a
  targeted AppArmor profile for `bwrap`; the exact profile is verified on a real 24.04 host in the live check.
- A restart test per platform: a running nax child survives `systemctl restart` / `launchctl kickstart -k`.

## 4. Testing

TDD throughout, `bun test` in `apps/runner`.

- **Unit:** verdict rows (including cancel-first and finish `skipped`); branch selection (origin branch exists,
  does not exist, no PRD, empty `branchName`); clean and checkout argv; job profile content and delete-after-exit;
  journal persist-before-send, contiguous ack cursor, resend; sync request building and command dispatch;
  TokenCache expiry and refresh timing; credential protocol and shim parsing; PATH search excluding `<jobDir>/bin`;
  probe mapping from nax JSON fixtures (copied from nax `SPEC-cli-json-output.md`) to `RunnerCapabilities`, with
  spawn stubbed; unit/plist generation.
- **fake-nax fixture:** `test/fixtures/fake-nax.ts` via `naxCommand`. Reads `--profile`, resolves the job
  profile's `outputDir`, writes real-shaped `status.json` snapshots, `latest.jsonl` and `metrics.json`,
  auto-commits onto the current branch, and ends in a scenario: completed with PR, escalated, failed, crashed,
  hang (for cancel), plan valid, plan invalid. Remotes are temp `file://` bare repos.
- **Integration (`KODA_DB_TESTS=1`, real Postgres):** the suite starts the real koda API as a child process on a
  random port against the test database, seeds admin, project, repo and enrollment token over HTTP, and runs the
  daemon in process. 3a: RUN happy path, PLAN commit and push, cancel, daemon `kill -9` then readopt, network cut
  then resend from the ack cursor, stale epoch then `ABANDON`. 3b: clone, push and `gh pr create` through helper
  and shims against a `file://` remote and a fake `gh`; no token in nax's environment, the journal or logs.
- **CI:** no new required check. Runner `type-check`, `lint` and unit `test` join the existing turbo jobs; the
  runner integration suite is a step in the existing `integration` job (which has Postgres).
- **3b merge gate:** the probe runs once against released `nax config --json` and `nax auth list --json` to catch
  contract drift.
- **Live check (last, billed, user approval at launch):** one real two-machine run of a trivial feature through
  the GitHub App.

## 5. Delivery

1. nax: `cli-json-output` (in flight), then `nax sandbox probe --json` (small PR). Neither blocks 3a or 3b code.
2. koda 3a: §1.1, §1.2, runner core (§1-§2), `.nax/mono/apps/runner/context.md` + `nax generate`, S1 spec pointers.
3. koda 3b: §3; merge gate needs the nax PRs released.

## Out of scope

- Container and VM executors (S1 spec §5.5), C10 provider-credential broker (S1 spec §9.6).
- Server-side run history for nax's prior-run-failure context (S2).
- Automating OS-user creation.
- Account labels from `nax auth list` in the capability report.
