# Fleet S1 Slice 3a-2 — Runner Execution and Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Numbering.** This is the second half of a split plan. Task numbers are kept from the combined plan: this plan is **Task 0b** and **Tasks 12-28**; plan 3a-1 owns Tasks 0-11 and 11b. Decision numbers: D1-D20 live in the 2a and 2b plans, **D21-D59 live in the 3a-1 plan's decision register and are not repeated here**; this plan adds **D60-D74** (the addendum below). "3b" (git-cred socket, credential helper, shims, `NaxCapabilityProbe`, `install-service`, live check) is a separate plan and is out of scope.

**Prerequisite:** plan 3a-1 (`docs/superpowers/plans/2026-09-30-fleet-s1-slice-3a-1-runner-foundations.md`, branch `feat/fleet-s1-slice3a-1-runner-foundations`) is merged into `main`. It ships the protocol v1 `credentials` edit and server changes, #157, and the `apps/runner` foundations (scaffold, `Logger`, safe segments, config, identity, journal, server client, batching, `SyncLoop`, verdict functions, and the repo wiring of Task 11b), and it **owns the decision register D21-D59**, which governs this plan. This plan builds on branch `feat/fleet-s1-slice3a-2-runner-execution`, cut from `main` after the 3a-1 merge (Task 0b); this plan file itself reached `main` through the 3a-1 PR.

**Goal:** Ship the runner's execution half as one PR: git workspace and checkout, the fake `nax` fixture, the detached `nax` process and pid reaping, the file-based watcher, PLAN commit, bundle build and upload, the `HostExecutor` behind the `JobExecutor` seam, the per-job `JobRun` lifecycle, the `Supervisor` (ASSIGN, CANCEL, ABANDON, READOPT), the static capability probe, the daemon, the `koda-runner enroll | run | status` CLI, and the integration harness with the 3a scenarios against the real API and Postgres.

**Architecture (3a-2 scope):** Small modules behind narrow seams, on top of the 3a-1 `Journal`, `SyncLoop` and pure verdict functions. A `JobExecutor` seam with `HostExecutor` (real git, detached `nax` process group, file-based watcher) never talks to the server: it writes journal events, the sync loop ships them. A per-job `JobRun` state machine emits only legal S1 spec 5.4 transitions through `JobEvents`; a `Supervisor` dispatches server commands; a `RepoMutex` serialises jobs per repo. The daemon wires it together and can be crashed in process (`daemon.crash()`), which is what the restart scenarios use. No 3b code exists here; each 3b seam is a named interface with a 3a implementation.

**Tech Stack:** Bun 1.4.2 (`bun:sqlite`, `Bun.spawn`, `bun test`, `bun build --compile`), TypeScript strict ESM, commander 12 (as `apps/cli`), system `git` (minimum 2.30) and `tar`, `@nathapp/fleet-protocol`. Integration harness only: the built API (NestJS 11, Prisma 6) and `@prisma/client` as a runner devDependency.

**Specs:** `docs/superpowers/specs/2026-09-30-fleet-s1-slice-3-runner-design.md` ("slice 3 design": rulings R-3.1..R-3.7; §1.3 rules, §2 steps 1-10 and control paths, §4 tests are this plan; §3 is 3b) and `docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md` ("S1 spec"). Precedent plans: the 3a-1 plan, `docs/superpowers/plans/2026-09-29-fleet-s1-slice-2a-jobs.md`, `docs/superpowers/plans/2026-09-29-fleet-s1-slice-2b-runner-sync.md`.

## Global Constraints

From the specs, the repo rules (`.nax/context.md`, `.nax/rules/*.md`, `.nax/mono/apps/*/context.md`) and slices 1-2 and 3a-1; every task includes them.

- **Protocol stays v1.** The runner may import the `FLEET_PROTOCOL_VERSION` value and wire types from `@nathapp/fleet-protocol`; the API imports it with `import type` only.
- **Server envelope.** Every server response is `JsonResponse.Ok` = `{ ret, data }`; the runner unwraps `data`. The API global prefix is `/api`. An error response carries `{ ret, message }` where `message` is the translated text (English unless `Accept-Language` says otherwise); the runner sends `Accept-Language: en` (D60).
- **nax's exit code is not the verdict** (a failed run exits 1, a fatal config or usage error exits 0): the verdict is computed from `status.json` and files alone, never from an exit code, and never from a child-process handle (a readopted child is not a child).
- **Legal transitions only.** The runner emits exactly the S1 spec 5.4 runner-reported transitions: `ASSIGNED -> RUNNING|FAILED|CANCELLED`, `RUNNING -> UPLOADING|CANCELLED`, `UPLOADING -> COMPLETED|FAILED|ESCALATED|CANCELLED`. The server stores and acks an illegal one without applying it, which would strand the job.
- **Persist before send.** Every event is written to the journal before the send that reports it; `seq` is per `(jobId, leaseEpoch)`, contiguous from 1.
- **Sync limits** (`apps/api/src/fleet/sync/sync-request.parser.ts:4`, body 1 MiB): at most 64 jobs, 500 events per job, 256 acks, 64 token requests, 16,384 serialised-JSON bytes per event payload; a log event carries at most 8 KiB of text.
- **No secrets in logs, journal or bundles.** The runner API key lives only in `identity.json` (mode 0600) and in the `Authorization` header; the `Logger` redacts keys named `*key*`, `*token*`, `*secret*`, `*password*`. 3a has no git credentials: an authentication failure ends the job with `stateReason = 'no git credentials (runner 3b)'`, and git never prompts (D69).
- **Path safety.** Owner, repo, feature and job id become path segments only through `assertSegment`; every branch or ref that reaches a git command is checked for a leading `-` and, for branches, `git check-ref-format --branch`.
- **System git is at least 2.30** (`git rev-parse --end-of-options`, D31 in the 3a-1 register). The daemon checks it at startup (Task 23) and refuses to start below that.
- **Repo conventions.** Conventional commits, no attribution trailer, never push (a human pushes), no emojis, no `console.log` outside `src/main.ts` and `src/logger.ts`, no non-null assertions, no `any` (root `.eslintrc.js`), no `eslint-disable`. Immutable style: build new objects, never mutate arguments. Files stay under 400 lines typical, 800 max, functions under 50 lines.
- **Tests.** Unit specs are `*.spec.ts` co-located under `apps/runner/src/` or, for cross-module scenarios that spawn `git` and the fake `nax`, under `apps/runner/test/unit/`; integration specs are `*.integration.spec.ts` under `apps/runner/test/integration/`, gated by `describe.skipIf(process.env['KODA_DB_TESTS'] !== '1')`. `apps/runner/bunfig.toml` (3a-1) sets the test timeout to 30000 ms. No hardcoded absolute machine paths in tests: use `mkdtemp`, `__dirname` and `path.join`. Unit runs never need a database. An `expect` inside a callback that a `try/catch` swallows (for example a `JobRun` `onTick`) proves nothing: record the value in the callback and assert after it returns.
- **Generated files.** `openapi.json` is committed and regenerated (`bun run generate`); agent files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `codex.md`) are generated by `nax generate` from `.nax/context.md` and `.nax/mono/apps/<app>/context.md`.
- **All ten CI checks are required on `main`** (`changes`, `type-check`, `lint`, `web build`, `policy-gates`, `test`, `integration`, `e2e`, `evaluate`, `smoke`); no new required check is added.

Plan-level rules:

- Branch `feat/fleet-s1-slice3a-2-runner-execution` is checked out in the main checkout (`repos/koda`). Apart from the single `git switch -c` of Task 0b, never run `git checkout`, `git switch`, `git stash` or `git reset` here; commit on the current branch only.
- Server specs: `cd apps/api && bun run test:scoped <paths>` (the DB is `bun run test:db:up` once). Never two DB jest runs at once.
- Runner specs: `cd apps/runner && bun test <path>`. Integration: `cd apps/runner && KODA_DB_TESTS=1 bun test test/integration` (needs the API built: `bunx turbo run build --filter=@nathapp/koda-api`).
- Tasks marked **[DB]** need `KODA_DB_TESTS=1` and the test Postgres; every other task runs without a database.
- Real `git` runs in unit tests (no mocked git); tests isolate it with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` (the 3a-1 Task 6 helper).
- Do not run `nax run` or `nax plan` (billed). `nax generate` is local and free.

## Decision addendum (D60-D74)

D21-D59 are in the 3a-1 plan and are cited here by number without repeating them. The ones this plan leans on most: D28 (repo mutex), D31 (ref rules), D32 (prepare failure reasons), D33 (READOPT of an `ASSIGNED` row with no pid), D34 (readopted tails start at end of file), D35 (every spawned job goes RUNNING -> UPLOADING -> terminal), D36 (bundle outcomes), D37 (`.nax-pids` reaping), D40 (restart simulated by `daemon.crash()`, added in Task 23), D49 (stale epoch), D51 (local-only branch kept), D52 (PLAN commit message, flags, idempotent; plan-out write-once), D53 (prepare wipes a previous attempt's files once lower epochs are abandoned), D54 (PLAN READOPT by process).

| # | Decision | Why |
|:--|:--|:--|
| D60 | The bundle upload endpoint answers 409 for two different causes (`bundle.service.ts:105-117` for the pre-check, `:64-75` for the re-check after the body streamed): `FleetFenceException` (message `This runner does not hold the job's current lease`; ABANDON is queued on the pre-check path) and `ConflictAppException` `fleet.jobState` (message `The job is <STATE>; this action is not allowed`; the job is not RUNNING/UPLOADING at this epoch; no ABANDON, `fence.service.ts` never sends `job_terminal`). `uploadWithRetry` returns `{kind: 'ok' \| 'stale' \| 'state-conflict' \| 'too-large' \| 'failed'}`, classifying a 409 by its `message` (the client sends `Accept-Language: en`); an unrecognised 409 is `stale`. `stale` parks the job for ABANDON (D49). `state-conflict` retries once after the next ack; if it repeats, the job is marked done locally with a lifecycle error and reports nothing more (slot released). Before uploading, `JobRun` waits (bounded, injected `sleep`/`now`) until the journal ack cursor covers the UPLOADING state event, so the server has applied it (`TUNING.ackPollMs` 250, `uploadAckWaitMs` 60000, Task 22). Known server-side gap, accepted for 3a: the re-check after the body streamed (`:64-75`) also raises the fence message when the job merely left RUNNING/UPLOADING at the same epoch, and queues no ABANDON, so that rare race parks the job until the runner restarts (a server follow-up should raise `fleet.jobState` there). | A runner that uploads before the server applied its UPLOADING event gets a spurious 409 and would park forever with no ABANDON coming. |
| D61 | `plan-out/` (the PLAN stash of `prd.json` and the plan logs) is write-once: the first successful stash is the source of truth and a retry never re-reads the checkout. The crash window after `checkout -f -B` and before copy-back is tested. | `checkout -f -B` discards the working-tree `prd.json`; re-reading it on retry would read the wrong file. |
| D62 | Before spawning `nax plan`, prepare moves `prd.json` and `prd.rejected.json` aside **and** deletes stale `.nax/features/<f>/plan/*.jsonl`. | `plan/` is gitignored, so `git clean -ffd` keeps it and a previous attempt's logs would be bundled as this one's. |
| D63 | A replayed `ASSIGN` whose prior applied command is `ok`, whose row is `ASSIGNED`, pid null and not done, calls `supervisor.begin(row, 'reprepare')` (a no-op if a run already exists). | The ack for the first `ASSIGN` may have been journaled but the run lost in a restart; without this the row is stranded. |
| D64 | `handler.assign` abandons lower-epoch rows of the same `jobId` before `begin`; `abandon` acquires the repo mutex, still SIGKILLs its own epoch's group (the journaled pid is that epoch's), and skips reap and cleanup when a non-done higher-epoch row exists for the job. | Job ids are reused across epochs on one runner; an old epoch's cleanup must not delete or kill the new epoch's workspace. |
| D65 | On `READOPT` reject and in `failSafe`, when a pid is set and `matchesProcess(row)` holds, the runner `kill(-pgid, 'SIGKILL')` before it reaps `.nax-pids`. A crash between spawn and the RUNNING event re-reaps before preparing again. | A live-but-stale `nax` would keep writing into the workspace the runner is about to reuse. |
| D66 | `CANCEL` for a job still waiting for the repo mutex emits `ASSIGNED -> CANCELLED` at once and the run never starts. `CANCEL` during prepare is honoured at the next step boundary (`prepare` polls `isCancelled`). | Otherwise a queued job holds its slot and its cancel is invisible until the mutex frees. |
| D67 | The daemon awaits `supervisor.idle()` before `journal.close()` on `stop()`; `DaemonHandle.crash()` (stop timers, abort the loop, close the journal, no drain, no child signalled) is the restart simulation of D40. | Closing the journal under a running job throws inside it; the crash must not drain. |
| D68 | Bundle: GNU tar exit 1 is accepted when every stderr line is `file changed as we read it` and the archive exists; a list entry whose name contains a newline or backslash is skipped with a lifecycle warn (`BundleFile.skipped`) (the `-T` list is line based); after 3 network failures on a bundle over 100 MiB the outcome is `bundle too large` instead of `bundle upload failed`. | A live `nax` may still write a log while tar reads it; the list file cannot express those names; a body a proxy silently drops is a size problem. |
| D69 | `createGit` runs git with `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_ASKPASS=true` and `-c credential.helper=`; the PLAN commit passes the assigned `gitIdentity` explicitly as `-c user.name=... -c user.email=...`. The daemon checks `git --version` >= 2.30 at startup. | A hanging credential prompt or a missing identity must fail fast, not stall a job. |
| D70 | The fake `nax` matches real `nax run`: it exits 1 when the run fails (`bin/nax.ts:383` on nax main: `process.exit(result.success ? 0 : 1)`), still writes the same files, registers its SIGTERM handler before the first flush, and writes `last.json` for `escalated` as well as `passed` and `failed`. | The verdict must not depend on an exit code; the fake must prove it. |
| D71 | The harness `world.net` has a `dropResponse` mode (the request is performed and its response thrown away) and a recorder of each sync's `jobs[].events[].seq`; the cut scenario holds the fake `nax` with `FAKE_NAX_GATE`, restores the network, then opens the gate. | The cut must be tested for resend continuity without a wall-clock race. |
| D72 | `enroll` with an existing `runner.json` warns when `--labels`, `--workspace` or `--insecure-http` are passed (they are ignored). `status` opens the journal read-only (`Journal.openReadOnly`). | A silent ignore misleads the operator; a status command must not create or lock a journal. |
| D73 | `createWorld` closes the API, the forge and Prisma before rethrowing a partial failure; the no-secret check reads `journal.db`, `journal.db-wal` and `journal.db-shm`; `@prisma/client` is a runner devDependency at the root version. | Leaked servers hang the next run; the WAL holds recent rows; the harness imports Prisma by name. |
| D74 | CI job `integration` `timeout-minutes` goes from 20 to 30 (the runner integration step adds an estimated 6-8 minutes: three spec files that each `prisma migrate reset` and boot the API, plus the scenarios). | The job sits close to its limit already. |

## Review Focus

The failure modes the specs imply but no task's happy path exercises, most likely first. Each has a named test in the task that owns the code.

1. **Daemon restarts while `nax` keeps running, or finishes while the daemon is down.** `READOPT` re-attaches only when the pid is alive, `status.json` `run.id` equals the journaled `naxRunId` and the heartbeat is under 2 minutes old; a finished-while-down run is verdicted, bundled and reported; a recycled pid or a stale `status.json` is rejected, killed and reaped (D65). A replayed `ASSIGN` restarts a stranded row (D63). Tasks 15, 20, 21, 27.
2. **A hostile or damaged `ASSIGN`.** A `feature`, `owner`, `name` or `planFrom` with `..`, `/`, a leading `-` or `@{`; a `cloneUrl` with an `ext::` scheme; a PRD `branchName` of `main`, `-x`, `a..b` or `@{-1}`. Nothing touches the disk outside `<workspaceRoot>`, no git command receives an option-shaped argument, and the job ends FAILED with a fixed reason. Tasks 12, 21.
3. **The server cannot be reached, or rejects an upload.** A network cut mid-run resends from the ack cursor without a gap or a duplicate (Task 27); an upload answered 409 is classified stale or state-conflict, never retried blindly (Task 17, 20).
4. **A stale runner keeps working, or two epochs share a job id.** After the server bumps the lease epoch, the fenced runner is told `ABANDON`: it kills the process group, drops that epoch's rows, pushes nothing and never touches a newer epoch's rows (D64). Tasks 21, 27.
5. **Two things at once on one repo, or a crash between two steps.** Two `ASSIGN`s for one repo serialise through the mutex; a crash after the PLAN commit but before the push, after `checkout -f -B` before copy-back, or after the terminal event but before cleanup, resumes without a second commit and without an illegal transition. Tasks 16, 19, 20.

---

## File Structure

| File | Responsibility | Task |
|:--|:--|:--|
| `apps/runner/src/executor/{git,workspace,refs,branch,checkout}.ts` | Steps 1-4, git env and version floor | 12 |
| `test/fixtures/fake-nax.ts` | Fake `nax` | 13 |
| `src/executor/{job-profile,nax-process,pid-registry}.ts` | Steps 5-6, kill, reap | 14 |
| `src/watcher/{run-log,file-tail,log-budget,watcher}.ts` | Step 7 | 15 |
| `src/executor/plan-commit.ts` | Step 8 | 16 |
| `src/bundle/{build-bundle,upload-bundle}.ts`; `src/sync/http.ts` (modified: `uploadBundle` returns the message) | Step 9 | 17 |
| `src/executor/{job-executor,host-executor}.ts` | Executor seam and host implementation | 18 |
| `src/supervisor/{repo-mutex,transitions,job-events}.ts` | Supervisor primitives | 19 |
| `src/supervisor/{kill-if-ours,job-run}.ts` | Per-job lifecycle | 20 |
| `src/supervisor/{supervisor,command-handler}.ts` | Commands, READOPT, ABANDON | 21 |
| `src/capabilities/capability-probe.ts`, `src/daemon/capacity.ts` | Static probe, capacity | 22 |
| `src/daemon/daemon.ts` | Wiring, `crash()` | 23 |
| `src/commands/*`, `src/main.ts`, `src/journal/journal.ts` (modified: `openReadOnly`) | `run`, `enroll`, `status` | 24 |
| `test/integration/harness/*`, `apps/runner/package.json`, `bun.lock` | Harness | 25 |
| `test/integration/*.integration.spec.ts` | 3a scenarios | 26, 27 |
| `.github/workflows/ci.yml`, `scripts/build-binary.ts`, `apps/runner/package.json`, `.nax/context.md`, `.nax/mono/apps/runner/context.md` | CI step, binary build, context | 28 |

---

### Task 0b: Baseline (branch from main after 3a-1 merged)

**Files:** none.

- [ ] **Step 1: Branch from main**

This plan file reached `main` inside the 3a-1 PR (it rode along as a document; 3a-1 did not execute it). After the 3a-1 PR merged, cut the branch from the new `main`:

```bash
git status --short | head        # expected: clean apart from untracked files outside apps/, docs/
git fetch origin
git switch -c feat/fleet-s1-slice3a-2-runner-execution origin/main
git log --oneline -3
ls docs/superpowers/plans/2026-09-30-fleet-s1-slice-3a-2-runner-execution.md
```
Expected: `HEAD` is the 3a-1 merge commit and this plan file exists. Review-gate diffs use `origin/main...HEAD`, which starts empty.

- [ ] **Step 2: Confirm 3a-1 is really there**

```bash
ls apps/runner/src apps/runner/bunfig.toml .nax/mono/apps/runner
grep -n "synchronous" apps/runner/src/journal/*.ts | head -3
grep -n "D5[1-9]" docs/superpowers/plans/2026-09-30-fleet-s1-slice-3a-1-runner-foundations.md | head
```
Expected: the foundations modules (`config`, `identity`, `journal`, `sync`, `verdict`, `paths`), `bunfig.toml`, the `.nax/mono/apps/runner` files, `synchronous = FULL` in the journal, and the register rows D51-D59.

- [ ] **Step 3: Run the 3a-1 gates**

```bash
bun install --frozen-lockfile
bun run type-check
bun run lint
cd apps/runner && bun test src && cd ../..
cd apps/api && bunx tsc --noEmit -p tsconfig.json && cd ../..
```
Expected: all green. Record the runner unit test count (`BASELINE_RUNNER_UNIT`) and the api unit count; Task 28 compares against them. If anything is red, stop: the base is broken, not this plan.

---

### Task 12: Git, workspace, ref resolution, branch selection, checkout (design §2 steps 1-4)

**Files:**
- Create: `apps/runner/src/executor/git.ts`, `git.spec.ts`
- Create: `apps/runner/src/executor/workspace.ts`, `refs.ts`, `branch.ts`, `checkout.ts`
- Create: `apps/runner/test/unit/workspace.spec.ts`, `apps/runner/test/unit/checkout.spec.ts`

**Interfaces:**
- Consumes: `assertRelativePath`, `assertFeature`, `PathError` (6), `parsePrd` (11), `firstLine`, `errorMessage` (6), `makeOrigin`, `pushCommit`, `isolateGit`, `git` (6 helpers).
- Produces:
  ```ts
  // git.ts
  export interface GitResult { readonly code: number; readonly stdout: string; readonly stderr: string }
  export interface GitOptions { readonly cwd: string; readonly timeoutMs?: number; readonly env?: Readonly<Record<string, string>> }
  export class GitError extends Error { readonly args: readonly string[]; readonly result: GitResult }
  export interface Git { run(args: readonly string[], options: GitOptions): Promise<GitResult>; ok(args: readonly string[], options: GitOptions): Promise<string> }
  export function createGit(): Git;                       // D69: GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never, GIT_ASKPASS=true, LC_ALL=C, `-c credential.helper=`, 10 min timeout
  export const MIN_GIT_VERSION: readonly [number, number];   // [2, 30]
  export function parseGitVersion(output: string): [number, number, number] | null;
  export function assertMinGitVersion(git: Git): Promise<void>;   // throws below 2.30; the daemon calls it at startup (Task 23)
  export const NO_CREDENTIALS_REASON = 'no git credentials (runner 3b)';
  export function isAuthFailure(stderr: string): boolean;
  export function reasonFromError(error: unknown): string;   // D32: auth -> NO_CREDENTIALS_REASON, else 'workspace: <first stderr line>'
  // workspace.ts
  export function assertCloneUrl(url: string): void;        // https:, http:, file: only
  export function ensureClone(git: Git, input: { repoDir: string; cloneUrl: string; identity: GitIdentity }): Promise<void>;   // D46
  export function cleanWorkspace(git: Git, repoDir: string): Promise<void>;   // fetch --prune; reset --hard HEAD; clean -ffd; worktree prune
  // refs.ts
  export const GIT_REF_RE: RegExp;                          // the server's dispatch regex (dispatch-input.ts)
  export type RefResult = { ok: true; sha: string; kind: 'remote-branch' | 'other' } | { ok: false; reason: 'invalid' | 'not-found' };
  export function resolveRef(git: Git, repoDir: string, ref: string): Promise<RefResult>;
  // branch.ts
  export type BranchAction = 'from-origin' | 'keep-local' | 'from-ref' | 'diverged';
  export function validateBranchName(git: Git, repoDir: string, name: string, defaultBranch: string): Promise<boolean>;
  export function planBranch(git: Git, repoDir: string, branch: string): Promise<BranchAction>;
  export function checkoutArgs(action: BranchAction, branch: string, refSha: string, force: boolean): string[] | null;
  // checkout.ts
  export type CheckoutResult = { ok: true; branch: string | null; refSha: string } | { ok: false; reason: string };
  export function prepareCheckout(input: { git: Git; repoDir: string; assign: AssignPayload }): Promise<CheckoutResult>;
  ```

- [ ] **Step 1: Write the failing specs**

`executor/git.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { NO_CREDENTIALS_REASON, GitError, assertMinGitVersion, createGit, isAuthFailure, parseGitVersion, reasonFromError, type Git } from './git';

describe('createGit', () => {
  const git = createGit();
  test('runs git and returns code, stdout and stderr without throwing', async () => {
    const version = await git.run(['--version'], { cwd: process.cwd() });
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(/^git version/);
    const bad = await git.run(['rev-parse', '--verify', 'nope^{commit}'], { cwd: process.cwd() });
    expect(bad.code).not.toBe(0);
  });
  test('ok throws a GitError naming the command and the first stderr line', async () => {
    const error = await git.ok(['rev-parse', '--verify', 'definitely-not-a-ref'], { cwd: process.cwd() }).catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.message).toMatch(/^git rev-parse failed: /);
  });
  test('never prompts (D69): no-prompt env is forced over a caller env, and the credential helper is emptied', async () => {
    const out = await git.ok(['-c', 'alias.probe=!echo "$GIT_TERMINAL_PROMPT|$GCM_INTERACTIVE|$GIT_ASKPASS|$LC_ALL"', 'probe'], {
      cwd: process.cwd(), env: { GIT_TERMINAL_PROMPT: '1', GCM_INTERACTIVE: 'always' },
    });
    expect(out.trim()).toBe('0|never|true|C');
    expect((await git.ok(['config', '--get', 'credential.helper'], { cwd: process.cwd() })).trim()).toBe('');
  });
});

describe('git version floor (D69)', () => {
  test('parseGitVersion reads the first three numbers, Apple and Windows suffixes included', () => {
    expect(parseGitVersion('git version 2.50.1 (Apple Git-155)\n')).toEqual([2, 50, 1]);
    expect(parseGitVersion('git version 2.30.0')).toEqual([2, 30, 0]);
    expect(parseGitVersion('git version 2.43.0.windows.1')).toEqual([2, 43, 0]);
    expect(parseGitVersion('not git')).toBeNull();
  });
  test('assertMinGitVersion accepts 2.30 and newer, refuses older or unparseable output', async () => {
    const fake = (stdout: string): Git => ({ run: async () => ({ code: 0, stdout, stderr: '' }), ok: async () => stdout });
    await expect(assertMinGitVersion(fake('git version 2.30.0\n'))).resolves.toBeUndefined();
    await expect(assertMinGitVersion(fake('git version 3.0.1\n'))).resolves.toBeUndefined();
    await expect(assertMinGitVersion(fake('git version 2.29.9\n'))).rejects.toThrow(/git 2\.30 or newer/);
    await expect(assertMinGitVersion(fake('garbage'))).rejects.toThrow(/git 2\.30 or newer/);
    await expect(assertMinGitVersion(createGit())).resolves.toBeUndefined();
  });
});

describe('isAuthFailure and reasonFromError (D32)', () => {
  test.each([
    'fatal: Authentication failed for \'https://github.com/a/b.git/\'',
    'fatal: could not read Username for \'https://github.com\': terminal prompts disabled',
    'fatal: could not read Password for \'https://x@github.com\'',
    'git@github.com: Permission denied (publickey).',
    'fatal: unable to access \'https://x/\': The requested URL returned error: 403',
    'remote: Invalid username or password.',
  ])('%s is an authentication failure', (stderr) => expect(isAuthFailure(stderr)).toBe(true));
  test.each(['fatal: repository not found', 'fatal: unable to access: Could not resolve host', ''])('%j is not', (stderr) => {
    expect(isAuthFailure(stderr)).toBe(false);
  });
  test('reasonFromError maps auth to the fixed reason, other git errors to workspace: <line>', () => {
    const auth = new GitError(['clone'], { code: 128, stdout: '', stderr: 'fatal: Authentication failed for x' });
    const other = new GitError(['fetch'], { code: 128, stdout: '', stderr: '\nfatal: repository not found\nmore' });
    expect(reasonFromError(auth)).toBe(NO_CREDENTIALS_REASON);
    expect(reasonFromError(other)).toBe('workspace: fatal: repository not found');
    expect(reasonFromError(new Error('disk full'))).toBe('workspace: disk full');
  });
});
```

`test/unit/workspace.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGit } from '../../src/executor/git';
import { assertCloneUrl, cleanWorkspace, ensureClone } from '../../src/executor/workspace';
import { git as sh, isolateGit, makeOrigin, pushCommit } from '../helpers/git-fixture';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());
const identity = { name: 'koda-fleet[bot]', email: 'koda-fleet[bot]@users.noreply.github.com' };
const g = createGit();

describe('assertCloneUrl', () => {
  test.each(['https://github.com/a/b.git', 'http://127.0.0.1:1234/a/b.git', 'file:///tmp/x.git'])('accepts %s', (u) => expect(() => assertCloneUrl(u)).not.toThrow());
  test.each(['ext::sh -c id', '-oProxyCommand=x', 'git://x/a.git', 'ssh://git@x/a.git', '/local/path', '', 'https://x/a b.git'])('rejects %j', (u) => {
    expect(() => assertCloneUrl(u)).toThrow();
  });
});

describe('ensureClone', () => {
  test('clones once, sets the commit identity, and reuses the clone', async () => {
    const base = await tmp.make('ws');
    const origin = await makeOrigin(base, 'origin', { files: { 'a.txt': '1' } });
    const repoDir = join(base, 'work', 'acme', 'app');
    await ensureClone(g, { repoDir, cloneUrl: origin.url, identity });
    expect(await readFile(join(repoDir, 'a.txt'), 'utf8')).toBe('1');
    expect(await sh(repoDir, 'config', 'user.name')).toBe(identity.name);
    expect(await sh(repoDir, 'config', 'user.email')).toBe(identity.email);
    await writeFile(join(repoDir, 'marker'), 'kept');
    await ensureClone(g, { repoDir, cloneUrl: origin.url, identity: { name: 'other', email: 'o@x' } });
    expect(await readFile(join(repoDir, 'marker'), 'utf8')).toBe('kept');
    expect(await sh(repoDir, 'config', 'user.name')).toBe('other');
  });
  test('repoints origin when the clone url changed (D46)', async () => {
    const base = await tmp.make('ws');
    const a = await makeOrigin(base, 'a', { files: { 'x': '1' } });
    const b = await makeOrigin(base, 'b', { files: { 'x': '1' } });
    const repoDir = join(base, 'work', 'r');
    await ensureClone(g, { repoDir, cloneUrl: a.url, identity });
    await ensureClone(g, { repoDir, cloneUrl: b.url, identity });
    expect(await sh(repoDir, 'remote', 'get-url', 'origin')).toBe(b.url);
  });
  test('removes a directory that has no .git (a crashed clone) and clones again', async () => {
    const base = await tmp.make('ws');
    const origin = await makeOrigin(base, 'o', { files: { 'a.txt': '1' } });
    const repoDir = join(base, 'work', 'r');
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, 'junk'), 'x');
    await ensureClone(g, { repoDir, cloneUrl: origin.url, identity });
    expect(await stat(join(repoDir, '.git'))).toBeDefined();
    await expect(stat(join(repoDir, 'junk'))).rejects.toThrow();
  });
  test('a clone that fails surfaces a GitError (unreachable origin)', async () => {
    const base = await tmp.make('ws');
    await expect(ensureClone(g, { repoDir: join(base, 'w', 'r'), cloneUrl: `file://${join(base, 'missing.git')}`, identity })).rejects.toThrow(/git clone failed/);
  });
});

describe('cleanWorkspace (design §2 step 2)', () => {
  test('discards tracked edits and untracked files, keeps ignored files, prunes deleted remote branches', async () => {
    const base = await tmp.make('ws');
    const origin = await makeOrigin(base, 'o', { files: { 'a.txt': '1', '.gitignore': 'checkpoint.jsonl\n' }, branches: [{ name: 'gone', files: { 'g': '1' } }] });
    const repoDir = join(base, 'work', 'r');
    await ensureClone(g, { repoDir, cloneUrl: origin.url, identity });
    await writeFile(join(repoDir, 'a.txt'), 'modified');
    await writeFile(join(repoDir, 'untracked.txt'), 'u');
    await mkdir(join(repoDir, 'nested', 'deep'), { recursive: true });
    await writeFile(join(repoDir, 'nested', 'deep', 'f'), 'f');
    await writeFile(join(repoDir, 'checkpoint.jsonl'), 'resume-me');
    await sh(origin.dir, 'branch', '-D', 'gone');
    await cleanWorkspace(g, repoDir);
    expect(await readFile(join(repoDir, 'a.txt'), 'utf8')).toBe('1');
    await expect(stat(join(repoDir, 'untracked.txt'))).rejects.toThrow();
    await expect(stat(join(repoDir, 'nested'))).rejects.toThrow();
    expect(await readFile(join(repoDir, 'checkpoint.jsonl'), 'utf8')).toBe('resume-me');
    expect(await sh(repoDir, 'branch', '-r')).not.toContain('origin/gone');
  });
  test('never moves the checked-out branch (reset --hard HEAD), and picks up new origin commits only as remote refs', async () => {
    const base = await tmp.make('ws');
    const origin = await makeOrigin(base, 'o', { files: { 'a.txt': '1' } });
    const repoDir = join(base, 'work', 'r');
    await ensureClone(g, { repoDir, cloneUrl: origin.url, identity });
    const before = await sh(repoDir, 'rev-parse', 'HEAD');
    const advanced = await pushCommit(base, origin.url, 'main', 'b.txt', '2');
    await cleanWorkspace(g, repoDir);
    expect(await sh(repoDir, 'rev-parse', 'HEAD')).toBe(before);
    expect(await sh(repoDir, 'rev-parse', 'origin/main')).toBe(advanced);
  });
  test('removes stale worktree metadata', async () => {
    const base = await tmp.make('ws');
    const origin = await makeOrigin(base, 'o', { files: { 'a.txt': '1' } });
    const repoDir = join(base, 'work', 'r');
    await ensureClone(g, { repoDir, cloneUrl: origin.url, identity });
    const wt = join(base, 'stale-worktree-7c1e9a');
    await sh(repoDir, 'worktree', 'add', '-q', '--detach', wt);
    expect(await sh(repoDir, 'worktree', 'list')).toContain('stale-worktree-7c1e9a');
    await rm(wt, { recursive: true, force: true });
    await cleanWorkspace(g, repoDir);
    expect(await sh(repoDir, 'worktree', 'list')).not.toContain('stale-worktree-7c1e9a');
  });
});
```

`test/unit/checkout.spec.ts` (all five branch cases of design §2 step 4, plus refs and validation):

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { AssignPayload } from '@nathapp/fleet-protocol';
import { validateBranchName } from '../../src/executor/branch';
import { prepareCheckout } from '../../src/executor/checkout';
import { createGit } from '../../src/executor/git';
import { resolveRef } from '../../src/executor/refs';
import { cleanWorkspace, ensureClone } from '../../src/executor/workspace';
import { git as sh, isolateGit, makeOrigin, pushCommit, type Origin } from '../helpers/git-fixture';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());
const g = createGit();
const identity = { name: 'bot', email: 'bot@x' };
const prd = (over: Record<string, unknown> = {}) => JSON.stringify({ branchName: 'feat/f', userStories: [{ id: 'US-001' }], ...over });

async function setup(files: Record<string, string> = { '.nax/features/f/prd.json': prd(), 'README.md': 'x' }, extra: Partial<Parameters<typeof makeOrigin>[2]> = {}) {
  const base = await tmp.make('co');
  const origin: Origin = await makeOrigin(base, 'origin', { files, tags: ['v1'], ...extra });
  const repoDir = join(base, 'clone');
  await ensureClone(g, { repoDir, cloneUrl: origin.url, identity });
  await cleanWorkspace(g, repoDir);
  return { base, origin, repoDir };
}
const assign = (over: Partial<AssignPayload> = {}): AssignPayload => ({
  jobId: 'j1', command: 'RUN', repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'x' },
  ref: 'main', feature: 'f', planFrom: null, profiles: [], maxCostUsd: '5', bashMode: 'raw', gitIdentity: identity, ...over,
});
const head = (repoDir: string) => sh(repoDir, 'rev-parse', 'HEAD');
const branchOf = (repoDir: string) => sh(repoDir, 'symbolic-ref', '--short', 'HEAD');

describe('resolveRef (design §2 step 3)', () => {
  test('prefers origin/<ref>, then a tag or commit', async () => {
    const { repoDir, origin, base } = await setup();
    const tip = await sh(repoDir, 'rev-parse', 'origin/main');
    expect(await resolveRef(g, repoDir, 'main')).toEqual({ ok: true, sha: tip, kind: 'remote-branch' });
    expect(await resolveRef(g, repoDir, 'v1')).toEqual({ ok: true, sha: tip, kind: 'other' });
    expect(await resolveRef(g, repoDir, tip)).toEqual({ ok: true, sha: tip, kind: 'other' });
    const advanced = await pushCommit(base, origin.url, 'main', 'n', '1');
    await cleanWorkspace(g, repoDir);
    expect(await resolveRef(g, repoDir, 'main')).toMatchObject({ ok: true, sha: advanced });
  });
  test('an unknown ref is not-found; option-shaped and odd refs are invalid (D31)', async () => {
    const { repoDir } = await setup();
    expect(await resolveRef(g, repoDir, 'no-such-branch')).toEqual({ ok: false, reason: 'not-found' });
    for (const ref of ['-x', '--upload-pack=sh', 'a..b', 'HEAD:README.md', 'a b', '', '/x', 'x/', 'a//b', 'x.lock', '@{-1}']) {
      expect(await resolveRef(g, repoDir, ref)).toEqual({ ok: false, reason: 'invalid' });
    }
  });
});

describe('validateBranchName', () => {
  test('accepts a feature branch and refuses the default branch, main, master and hostile shapes', async () => {
    const { repoDir } = await setup();
    expect(await validateBranchName(g, repoDir, 'feat/f', 'main')).toBe(true);
    for (const name of ['main', 'master', 'trunk', '-x', 'a..b', '@{-1}', '', 'a b', 'x.lock', 'a~1', 'a^b', 'a:b', '/x', 'x/']) {
      expect(await validateBranchName(g, repoDir, name, 'trunk')).toBe(false);
    }
  });
});

describe('prepareCheckout RUN: the five branch cases (R-3.3)', () => {
  test('neither branch exists: creates it from the ref', async () => {
    const { repoDir } = await setup();
    const result = await prepareCheckout({ git: g, repoDir, assign: assign() });
    expect(result).toMatchObject({ ok: true, branch: 'feat/f' });
    expect(await branchOf(repoDir)).toBe('feat/f');
    expect(await head(repoDir)).toBe(await sh(repoDir, 'rev-parse', 'origin/main'));
  });
  test('only origin has it: continues the origin branch (ref only supplies the branch name)', async () => {
    const { repoDir } = await setup(undefined, { branches: [{ name: 'feat/f', files: { 'from-origin.txt': '1' } }] });
    expect(await prepareCheckout({ git: g, repoDir, assign: assign() })).toMatchObject({ ok: true, branch: 'feat/f' });
    expect(await head(repoDir)).toBe(await sh(repoDir, 'rev-parse', 'origin/feat/f'));
  });
  test('both exist and origin is behind local: keeps the unpushed local commits', async () => {
    const { repoDir } = await setup(undefined, { branches: [{ name: 'feat/f', files: { 'from-origin.txt': '1' } }] });
    await prepareCheckout({ git: g, repoDir, assign: assign() });
    await sh(repoDir, 'commit', '-q', '--allow-empty', '-m', 'unpushed run commit');
    const local = await head(repoDir);
    await cleanWorkspace(g, repoDir);
    expect(await prepareCheckout({ git: g, repoDir, assign: assign() })).toMatchObject({ ok: true });
    expect(await head(repoDir)).toBe(local);
  });
  test('both exist and local is behind origin: fast-forwards to origin', async () => {
    const { repoDir, origin, base } = await setup(undefined, { branches: [{ name: 'feat/f', files: { 'a': '1' } }] });
    await prepareCheckout({ git: g, repoDir, assign: assign() });
    const advanced = await pushCommit(base, origin.url, 'feat/f', 'b', '2');
    await cleanWorkspace(g, repoDir);
    await prepareCheckout({ git: g, repoDir, assign: assign() });
    expect(await head(repoDir)).toBe(advanced);
  });
  test('both exist and diverged: FAILED, and nothing is discarded', async () => {
    const { repoDir, origin, base } = await setup(undefined, { branches: [{ name: 'feat/f', files: { 'a': '1' } }] });
    await prepareCheckout({ git: g, repoDir, assign: assign() });
    await sh(repoDir, 'commit', '-q', '--allow-empty', '-m', 'local only');
    const local = await head(repoDir);
    await pushCommit(base, origin.url, 'feat/f', 'c', '3');
    await cleanWorkspace(g, repoDir);
    expect(await prepareCheckout({ git: g, repoDir, assign: assign() })).toEqual({ ok: false, reason: 'checkout: branch diverged' });
    expect(await head(repoDir)).toBe(local);
  });
  test('only a local branch exists (never pushed): keeps it', async () => {
    const { repoDir } = await setup({ '.nax/features/f/prd.json': prd({ branchName: 'feat/local-only' }) });
    await prepareCheckout({ git: g, repoDir, assign: assign() });
    await sh(repoDir, 'commit', '-q', '--allow-empty', '-m', 'first run');
    const local = await head(repoDir);
    await sh(repoDir, 'checkout', '-q', 'main');
    expect(await prepareCheckout({ git: g, repoDir, assign: assign() })).toMatchObject({ ok: true, branch: 'feat/local-only' });
    expect(await head(repoDir)).toBe(local);
  });
});

describe('prepareCheckout RUN: bad PRDs and refs (fixed reasons, D32)', () => {
  test.each([
    ['no prd.json at the ref', { 'README.md': 'x' }, 'checkout: no prd.json at ref'],
    ['prd.json is not JSON', { '.nax/features/f/prd.json': 'nope' }, 'checkout: prd.json is not valid JSON'],
    ['no branchName', { '.nax/features/f/prd.json': '{"userStories":[]}' }, 'checkout: prd.json has no branchName'],
    ['branchName is the default branch', { '.nax/features/f/prd.json': prd({ branchName: 'main' }) }, 'checkout: invalid branchName'],
    ['branchName is master', { '.nax/features/f/prd.json': prd({ branchName: 'master' }) }, 'checkout: invalid branchName'],
    ['branchName starts with a dash', { '.nax/features/f/prd.json': prd({ branchName: '-x' }) }, 'checkout: invalid branchName'],
    ['branchName has ..', { '.nax/features/f/prd.json': prd({ branchName: 'a..b' }) }, 'checkout: invalid branchName'],
    ['branchName is @{-1}', { '.nax/features/f/prd.json': prd({ branchName: '@{-1}' }) }, 'checkout: invalid branchName'],
  ])('%s', async (_label, files, reason) => {
    const { repoDir } = await setup(files as Record<string, string>);
    expect(await prepareCheckout({ git: g, repoDir, assign: assign() })).toEqual({ ok: false, reason });
  });
  test('an unknown or hostile ref is a fixed reason', async () => {
    const { repoDir } = await setup();
    expect(await prepareCheckout({ git: g, repoDir, assign: assign({ ref: 'nope' }) })).toEqual({ ok: false, reason: 'checkout: ref not found' });
    expect(await prepareCheckout({ git: g, repoDir, assign: assign({ ref: '--upload-pack=x' }) })).toEqual({ ok: false, reason: 'checkout: invalid ref' });
  });
  test('a tag and a sha work as the ref', async () => {
    const { repoDir } = await setup();
    const tip = await sh(repoDir, 'rev-parse', 'origin/main');
    expect(await prepareCheckout({ git: g, repoDir, assign: assign({ ref: 'v1' }) })).toMatchObject({ ok: true, refSha: tip });
    await sh(repoDir, 'checkout', '-q', 'main');
    await sh(repoDir, 'branch', '-D', 'feat/f');
    expect(await prepareCheckout({ git: g, repoDir, assign: assign({ ref: tip }) })).toMatchObject({ ok: true, refSha: tip });
  });
});

describe('prepareCheckout PLAN', () => {
  const plan = (over: Partial<AssignPayload> = {}) => assign({ command: 'PLAN', planFrom: 'docs/spec.md', ...over });
  test('checks out the ref detached', async () => {
    const { repoDir } = await setup();
    const result = await prepareCheckout({ git: g, repoDir, assign: plan() });
    expect(result).toMatchObject({ ok: true, branch: null });
    expect((await sh(repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'))).toBe('HEAD');
    expect(await head(repoDir)).toBe(await sh(repoDir, 'rev-parse', 'origin/main'));
  });
  test('a repo without .nax/ is FAILED with the fixed reason', async () => {
    const { repoDir } = await setup({ 'README.md': 'x' });
    expect(await prepareCheckout({ git: g, repoDir, assign: plan() })).toEqual({ ok: false, reason: 'no .nax dir' });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/runner && bun test src/executor test/unit/workspace.spec.ts test/unit/checkout.spec.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `git.ts`**

`executor/git.ts`:

```ts
import { errorMessage, firstLine } from '../errors';

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
}

export class GitError extends Error {
  constructor(readonly args: readonly string[], readonly result: GitResult) {
    super(`git ${args[0] ?? ''} failed: ${firstLine(result.stderr) || `exit ${result.code}`}`);
    this.name = 'GitError';
  }
}

export interface Git {
  run(args: readonly string[], options: GitOptions): Promise<GitResult>;
  ok(args: readonly string[], options: GitOptions): Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const NO_CREDENTIALS_REASON = 'no git credentials (runner 3b)';
const AUTH_PATTERNS: readonly RegExp[] = [
  /authentication failed/i,
  /could not read (username|password)/i,
  /terminal prompts disabled/i,
  /permission denied \(publickey\)/i,
  /the requested url returned error: (401|403)/i,
  /invalid (credentials|username or password)/i,
];

export const isAuthFailure = (stderr: string): boolean => AUTH_PATTERNS.some((pattern) => pattern.test(stderr));

/** D32: a fixed vocabulary for the stateReason of a failed prepare. */
export function reasonFromError(error: unknown): string {
  if (error instanceof GitError) {
    return isAuthFailure(error.result.stderr) ? NO_CREDENTIALS_REASON : `workspace: ${firstLine(error.result.stderr, 200) || error.message}`;
  }
  return `workspace: ${errorMessage(error).slice(0, 200)}`;
}

/** D69: git must never wait for a person. These win over the caller's and the daemon's environment. */
const NO_PROMPT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: 'true', LC_ALL: 'C' } as const;
/** 3a has no git credentials: an empty helper stops a host credential manager from answering (3b replaces this). */
const NO_HELPER_ARGS = ['-c', 'credential.helper='] as const;

export const MIN_GIT_VERSION: readonly [number, number] = [2, 30];

/** The first three numeric components of `git --version` output (`git version 2.50.1 (Apple Git-155)`). */
export function parseGitVersion(output: string): [number, number, number] | null {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

/** `git rev-parse --end-of-options` (D31) needs git 2.30; the daemon refuses to start below that (Task 23). */
export async function assertMinGitVersion(git: Git): Promise<void> {
  const parsed = parseGitVersion((await git.run(['--version'], { cwd: process.cwd() })).stdout);
  const [major, minor] = MIN_GIT_VERSION;
  const tooOld = !parsed || parsed[0] < major || (parsed[0] === major && parsed[1] < minor);
  if (tooOld) throw new Error(`koda-runner needs git ${major}.${minor} or newer (found ${parsed ? parsed.join('.') : 'no parseable version'})`);
}

export function createGit(): Git {
  const run: Git['run'] = async (args, options) => {
    const proc = Bun.spawn(['git', ...NO_HELPER_ARGS, ...args], {
      cwd: options.cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, killSignal: 'SIGKILL',
      env: { ...process.env, ...options.env, ...NO_PROMPT_ENV },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  };
  return {
    run,
    async ok(args, options) {
      const result = await run(args, options);
      if (result.code !== 0) throw new GitError(args, result);
      return result.stdout;
    },
  };
}
```

- [ ] **Step 4: Implement `workspace.ts`, `refs.ts`, `branch.ts`, `checkout.ts`**

`executor/workspace.ts`:

```ts
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GitIdentity } from '@nathapp/fleet-protocol';
import type { Git } from './git';

const CLONE_SCHEMES = new Set(['https:', 'http:', 'file:']);

/** D30: only plain transports; no `ext::`, `git://`, ssh or option-shaped values reach `git clone`. */
export function assertCloneUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('invalid cloneUrl');
  }
  if (!CLONE_SCHEMES.has(parsed.protocol) || /\s/.test(url) || url.startsWith('-')) throw new Error('invalid cloneUrl');
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** Design §2 step 1 with D46: clone on first use, repoint a drifted origin, rebuild a crashed clone. */
export async function ensureClone(git: Git, input: { repoDir: string; cloneUrl: string; identity: GitIdentity }): Promise<void> {
  assertCloneUrl(input.cloneUrl);
  const parent = dirname(input.repoDir);
  await mkdir(parent, { recursive: true });
  if (await exists(join(input.repoDir, '.git'))) {
    const current = (await git.ok(['remote', 'get-url', 'origin'], { cwd: input.repoDir })).trim();
    if (current !== input.cloneUrl) await git.ok(['remote', 'set-url', 'origin', input.cloneUrl], { cwd: input.repoDir });
  } else {
    await rm(input.repoDir, { recursive: true, force: true });
    await git.ok(['clone', '--', input.cloneUrl, input.repoDir], { cwd: parent });
  }
  await git.ok(['config', 'user.name', input.identity.name], { cwd: input.repoDir });
  await git.ok(['config', 'user.email', input.identity.email], { cwd: input.repoDir });
}

/**
 * Design §2 step 2. `reset --hard HEAD` discards tracked edits (a crashed run's modified prd.json) and never
 * moves the branch; `clean -ffd` has no `-x`, so ignored files such as `checkpoint.jsonl` survive (SP-4).
 */
export async function cleanWorkspace(git: Git, repoDir: string): Promise<void> {
  await git.ok(['fetch', '--prune', 'origin'], { cwd: repoDir });
  await git.ok(['reset', '--hard', 'HEAD'], { cwd: repoDir });
  await git.ok(['clean', '-ffd'], { cwd: repoDir });
  await git.ok(['worktree', 'prune'], { cwd: repoDir });
}
```

`executor/refs.ts`:

```ts
import type { Git } from './git';

/** The server's dispatch rule for `ref` (apps/api/src/fleet/jobs/dispatch-input.ts GIT_REF_RE), repeated: the runner does not trust the server. */
export const GIT_REF_RE = /^(?![-./])(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*\/$)[A-Za-z0-9._/@+-]{1,255}$/;

export type RefResult =
  | { ok: true; sha: string; kind: 'remote-branch' | 'other' }
  | { ok: false; reason: 'invalid' | 'not-found' };

/** Design §2 step 3: origin/<ref> when that remote branch exists, else <ref> as a tag or commit. */
export async function resolveRef(git: Git, repoDir: string, ref: string): Promise<RefResult> {
  if (!GIT_REF_RE.test(ref)) return { ok: false, reason: 'invalid' };
  const remote = `refs/remotes/origin/${ref}`;
  if ((await git.run(['show-ref', '--verify', '--quiet', remote], { cwd: repoDir })).code === 0) {
    const sha = (await git.ok(['rev-parse', '--verify', `${remote}^{commit}`], { cwd: repoDir })).trim();
    return { ok: true, sha, kind: 'remote-branch' };
  }
  const other = await git.run(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { cwd: repoDir });
  return other.code === 0 ? { ok: true, sha: other.stdout.trim(), kind: 'other' } : { ok: false, reason: 'not-found' };
}
```

`executor/branch.ts`:

```ts
import type { Git } from './git';

export type BranchAction = 'from-origin' | 'keep-local' | 'from-ref' | 'diverged';

const BRANCH_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/+@-]{0,254}$/;
const PROTECTED = new Set(['main', 'master']);

/** R-3.3 and D31: a PRD-supplied branch name must be a plain feature branch. */
export async function validateBranchName(git: Git, repoDir: string, name: string, defaultBranch: string): Promise<boolean> {
  if (!BRANCH_SHAPE.test(name) || name.includes('@{') || name.includes('..') || name.endsWith('.lock') || name.endsWith('/')) return false;
  if (name === defaultBranch || PROTECTED.has(name)) return false;
  return (await git.run(['check-ref-format', '--branch', name], { cwd: repoDir })).code === 0;
}

/**
 * Design §2 step 4. The design lists four cases; a branch that exists only locally (a run committed but never
 * pushed) is the fifth and is kept (D51), so a later run continues its commits.
 */
export async function planBranch(git: Git, repoDir: string, branch: string): Promise<BranchAction> {
  const has = async (ref: string): Promise<boolean> => (await git.run(['show-ref', '--verify', '--quiet', ref], { cwd: repoDir })).code === 0;
  const local = `refs/heads/${branch}`;
  const origin = `refs/remotes/origin/${branch}`;
  const [hasLocal, hasOrigin] = [await has(local), await has(origin)];
  if (!hasLocal && !hasOrigin) return 'from-ref';
  if (!hasOrigin) return 'keep-local';
  if (!hasLocal) return 'from-origin';
  const ancestor = async (a: string, b: string): Promise<boolean> => (await git.run(['merge-base', '--is-ancestor', a, b], { cwd: repoDir })).code === 0;
  if (await ancestor(origin, local)) return 'keep-local';
  return (await ancestor(local, origin)) ? 'from-origin' : 'diverged';
}

/** `force` is for the PLAN commit, where untracked plan files must not block the switch. `null` for a diverged branch. */
export function checkoutArgs(action: BranchAction, branch: string, refSha: string, force: boolean): string[] | null {
  const f = force ? ['-f'] : [];
  switch (action) {
    case 'from-origin': return ['checkout', ...f, '-B', branch, `origin/${branch}`];
    case 'keep-local': return ['checkout', ...f, branch, '--'];
    case 'from-ref': return ['checkout', ...f, '-B', branch, refSha];
    case 'diverged': return null;
  }
}
```

`executor/checkout.ts`:

```ts
import type { AssignPayload } from '@nathapp/fleet-protocol';
import { parsePrd } from '../prd';
import { assertFeature } from '../paths/safe-segment';
import { checkoutArgs, planBranch, validateBranchName } from './branch';
import type { Git } from './git';
import { resolveRef } from './refs';

export type CheckoutResult = { ok: true; branch: string | null; refSha: string } | { ok: false; reason: string };

export interface CheckoutInput {
  readonly git: Git;
  readonly repoDir: string;
  readonly assign: AssignPayload;
}

/** Design §2 steps 3-4 (R-3.3): RUN continues or creates `prd.branchName`; PLAN detaches at the ref. */
export async function prepareCheckout(input: CheckoutInput): Promise<CheckoutResult> {
  const { git, repoDir, assign } = input;
  const ref = await resolveRef(git, repoDir, assign.ref);
  if (!ref.ok) return { ok: false, reason: ref.reason === 'invalid' ? 'checkout: invalid ref' : 'checkout: ref not found' };
  if (assign.command === 'PLAN') {
    if ((await git.run(['cat-file', '-e', `${ref.sha}:.nax`], { cwd: repoDir })).code !== 0) return { ok: false, reason: 'no .nax dir' };
    await git.ok(['checkout', '--detach', ref.sha], { cwd: repoDir });
    return { ok: true, branch: null, refSha: ref.sha };
  }
  const feature = assertFeature(assign.feature);
  const prdText = await git.run(['show', `${ref.sha}:.nax/features/${feature}/prd.json`], { cwd: repoDir });
  if (prdText.code !== 0) return { ok: false, reason: 'checkout: no prd.json at ref' };
  const prd = parsePrd(prdText.stdout);
  if (!prd) return { ok: false, reason: 'checkout: prd.json is not valid JSON' };
  if (prd.branchName === null) return { ok: false, reason: 'checkout: prd.json has no branchName' };
  if (!(await validateBranchName(git, repoDir, prd.branchName, assign.repo.defaultBranch))) return { ok: false, reason: 'checkout: invalid branchName' };
  const action = await planBranch(git, repoDir, prd.branchName);
  const args = checkoutArgs(action, prd.branchName, ref.sha, false);
  if (!args) return { ok: false, reason: 'checkout: branch diverged' };
  await git.ok(args, { cwd: repoDir });
  return { ok: true, branch: prd.branchName, refSha: ref.sha };
}
```

- [ ] **Step 5: Run and lint**

```bash
cd apps/runner && bun test src/executor test/unit/workspace.spec.ts test/unit/checkout.spec.ts && bun run type-check && bun run lint
```
Expected: PASS (roughly 50 tests), clean.

- [ ] **Step 6: Commit**

```bash
git add apps/runner
git commit -m "feat(fleet): runner git workspace, ref resolution, branch selection and checkout (R-3.3)"
```

---

### Task 13: The fake `nax` fixture

**Files:**
- Create: `apps/runner/test/fixtures/fake-nax.ts`
- Create: `apps/runner/test/unit/fake-nax.spec.ts`

**Interfaces:**
- Produces: a script run as `bun <abs>/fake-nax.ts run|plan|--version ...` (the runner's `naxCommand` in tests is `['bun', <abs path>]`). It reads `--profile <chain>`, finds the `koda-job-*` entry, reads `<NAX_GLOBAL_CONFIG_DIR ?? ~/.nax>/profiles/<it>.json` for `outputDir`, and behaves per env:
  - `FAKE_NAX_SCENARIO`: `completed` (default for `run`), `escalated`, `failed` (exits 1, like real `nax run` on a failed run; every other finishing scenario exits 0), `crashed`, `hang`, `plan-valid` (default for `plan`), `plan-invalid`.
  - `FAKE_NAX_STEPS` (default 3) and `FAKE_NAX_STEP_MS` (default 30): story steps and the delay between snapshots.
  - `FAKE_NAX_GATE=<path>`: after the steps, wait until that file exists before finishing (finished-while-down tests).
  - `FAKE_NAX_IGNORE_TERM=1`: `hang` ignores SIGTERM (SIGKILL escalation tests). The SIGTERM handler is registered before the first `status.json` flush.
  - `FAKE_NAX_PLAN_BRANCH`: the `branchName` written into a plan's `prd.json` (default `feat/<feature>`).
  - Files, all real-shaped: `<out>/status.json` (atomic tmp+rename, `run.id = run-<stamp>`, `run.pid`, `progress`, `cost.spent`, `current`, `lastHeartbeat`, `postRun.finish` at the end), `<out>/features/<f>/runs/log-<stamp>.jsonl`, `<out>/cost/cost-<stamp>.jsonl` (three distinct run-id namespaces), `<out>/prompt-audit/<f>/p.json`, `<out>/metrics.json`, `<out>/finish-audit/<f>/last.json` (`branch`, `headSha`, `status`; written for `completed` and `escalated`, not `failed`), `latest.jsonl` symlink **only at exit**. `run` scenarios that finish auto-commit `koda-fake-<feature>.txt` onto the current branch and `completed` pushes it (`git push --set-upstream origin <branch>`, the finish phase); a detached HEAD skips the push and reports `postRun.finish = { status: 'skipped', reason: 'branch' }`. `plan-*` scenarios write `.nax/features/<f>/{prd.json,spec.md,prd-fidelity-report.md,acceptance-meta.json,plan/plan-1.jsonl,sessions/s1.json}` (`plan-invalid`: `userStories: []` and a `prd.rejected.json`) and no `status.json`.

- [ ] **Step 1: Write the failing spec**

`test/unit/fake-nax.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, readdir, readlink, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git as sh, isolateGit, makeOrigin } from '../helpers/git-fixture';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
const FAKE = join(import.meta.dir, '..', 'fixtures', 'fake-nax.ts');
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());

interface Ctx { base: string; naxHome: string; outDir: string; work: string; originDir: string }

async function setup(branch: string | null = 'feat/x'): Promise<Ctx> {
  const base = await tmp.make('fake');
  const origin = await makeOrigin(base, 'origin', { files: { 'README.md': 'x', 'docs/spec.md': '# spec from repo\n' } });
  const work = join(base, 'work');
  await sh(base, 'clone', '-q', origin.url, work);
  await sh(work, 'config', 'user.name', 'bot');
  await sh(work, 'config', 'user.email', 'bot@x');
  if (branch) await sh(work, 'checkout', '-q', '-b', branch);
  else await sh(work, 'checkout', '-q', '--detach');
  const naxHome = join(base, 'naxhome');
  const outDir = join(base, 'out');
  await mkdir(join(naxHome, 'profiles'), { recursive: true });
  await writeFile(join(naxHome, 'profiles', 'koda-job-j1.json'), JSON.stringify({ outputDir: outDir, name: 'acme-app-12345678' }));
  return { base, naxHome, outDir, work, originDir: origin.dir };
}

function spawnFake(ctx: Ctx, args: string[], env: Record<string, string> = {}) {
  return Bun.spawn(['bun', FAKE, ...args], {
    cwd: ctx.work, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, NAX_GLOBAL_CONFIG_DIR: ctx.naxHome, FAKE_NAX_STEP_MS: '10', ...env },
  });
}
const RUN = ['run', '--headless', '--json', '-f', 'feat', '--profile', 'fast,koda-job-j1', '--max-cost', '5'];
const PLAN = ['plan', '--from', 'docs/spec.md', '-f', 'feat', '--profile', 'koda-job-j1'];
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const exists = (path: string) => stat(path).then(() => true, () => false);

describe('fake nax: run scenarios', () => {
  test('completed writes real-shaped state, three distinct run ids, latest.jsonl only at exit, commits and pushes the branch', async () => {
    const ctx = await setup();
    const proc = spawnFake(ctx, RUN);
    expect(await proc.exited).toBe(0);
    const status = await json(join(ctx.outDir, 'status.json'));
    expect(status).toMatchObject({
      version: 1, run: { status: 'completed', feature: 'feat' }, progress: { total: 3, passed: 3, pending: 0 }, current: null,
      postRun: { finish: { status: 'passed', result: 'opened', url: 'https://example.test/koda/pull/1' } },
    });
    expect(status.run.id).toMatch(/^run-/);
    expect(status.cost.spent).toBeGreaterThan(0);
    const runs = await readdir(join(ctx.outDir, 'features', 'feat', 'runs'));
    const log = runs.find((n) => n !== 'latest.jsonl');
    expect(log).toMatch(/^log-.*\.jsonl$/);
    expect(await readlink(join(ctx.outDir, 'features', 'feat', 'runs', 'latest.jsonl'))).toBe(log as string);
    expect((await readdir(join(ctx.outDir, 'cost')))[0]).toMatch(/^cost-.*\.jsonl$/);
    expect(await exists(join(ctx.outDir, 'prompt-audit', 'feat', 'p.json'))).toBe(true);
    expect(await exists(join(ctx.outDir, 'metrics.json'))).toBe(true);
    const ledger = await json(join(ctx.outDir, 'finish-audit', 'feat', 'last.json'));
    expect(ledger).toMatchObject({ branch: 'feat/x', status: 'opened' });
    expect(ledger.headSha).toBe(await sh(ctx.work, 'rev-parse', 'HEAD'));
    expect(await sh(ctx.originDir, 'rev-parse', 'feat/x')).toBe(ledger.headSha);
    expect(await sh(ctx.work, 'log', '-1', '--format=%s')).toContain('feat');
  });
  test('a detached HEAD skips the finish push, as nax does', async () => {
    const ctx = await setup(null);
    expect(await spawnFake(ctx, RUN).exited).toBe(0);
    expect((await json(join(ctx.outDir, 'status.json'))).postRun.finish).toMatchObject({ status: 'skipped', reason: 'branch' });
  });
  test('escalated and failed end with nax-shaped verdict inputs', async () => {
    const esc = await setup();
    expect(await spawnFake(esc, RUN, { FAKE_NAX_SCENARIO: 'escalated' }).exited).toBe(0);
    expect((await json(join(esc.outDir, 'status.json'))).postRun.finish).toMatchObject({ result: 'escalated', escalationReason: 'fake escalation' });
    const ledger = await json(join(esc.outDir, 'finish-audit', 'feat', 'last.json'));
    expect(ledger).toMatchObject({ branch: 'feat/x', status: 'escalated' });
    expect(ledger.headSha).toBe(await sh(esc.work, 'rev-parse', 'HEAD'));
    const failed = await setup();
    // Real `nax run` exits 1 when the run failed (nax bin/nax.ts:383, `process.exit(result.success ? 0 : 1)`); the runner never reads it (D70).
    expect(await spawnFake(failed, RUN, { FAKE_NAX_SCENARIO: 'failed' }).exited).toBe(1);
    expect((await json(join(failed.outDir, 'status.json'))).run.status).toBe('failed');
  });
  test('crashed dies by SIGKILL leaving status running', async () => {
    const ctx = await setup();
    const proc = spawnFake(ctx, RUN, { FAKE_NAX_SCENARIO: 'crashed' });
    await proc.exited;
    expect(proc.signalCode).toBe('SIGKILL');
    expect((await json(join(ctx.outDir, 'status.json'))).run.status).toBe('running');
  });
  test('hang keeps heartbeating until SIGTERM, then writes status crashed as nax does; the gate holds a finished run back', async () => {
    const ctx = await setup();
    const proc = spawnFake(ctx, RUN, { FAKE_NAX_SCENARIO: 'hang' });
    for (let i = 0; i < 100 && !(await exists(join(ctx.outDir, 'status.json'))); i += 1) await Bun.sleep(20);
    const first = await json(join(ctx.outDir, 'status.json'));
    expect(first.run.status).toBe('running');
    process.kill(proc.pid, 'SIGTERM');
    expect(await proc.exited).toBe(0);
    expect((await json(join(ctx.outDir, 'status.json'))).run).toMatchObject({ status: 'crashed', crashSignal: 'SIGTERM' });

    const gated = await setup();
    const gate = join(gated.base, 'gate');
    const p2 = spawnFake(gated, RUN, { FAKE_NAX_GATE: gate });
    // Poll for the state that proves the gate is what holds the run (all steps done, still running); no fixed sleep.
    let held = false;
    for (let i = 0; i < 500 && !held; i += 1) {
      held = await json(join(gated.outDir, 'status.json')).then((s) => s.progress.passed === 3, () => false);
      if (!held) await Bun.sleep(20);
    }
    expect(held).toBe(true);
    expect(p2.exitCode).toBeNull();
    expect((await json(join(gated.outDir, 'status.json'))).run.status).toBe('running');
    await writeFile(gate, '');
    expect(await p2.exited).toBe(0);
    expect((await json(join(gated.outDir, 'status.json'))).run.status).toBe('completed');
  });
  test('fails loudly without a job profile (the runner must always pass one)', async () => {
    const ctx = await setup();
    const proc = spawnFake(ctx, ['run', '-f', 'feat', '--profile', 'fast']);
    expect(await proc.exited).toBe(2);
  });
});

describe('fake nax: plan scenarios', () => {
  test('plan-valid writes the PRD and companions untracked, plus logs, and no status.json', async () => {
    const ctx = await setup(null);
    expect(await spawnFake(ctx, PLAN).exited).toBe(0);
    const dir = join(ctx.work, '.nax', 'features', 'feat');
    const prd = await json(join(dir, 'prd.json'));
    expect(prd).toMatchObject({ feature: 'feat', branchName: 'feat/feat' });
    expect(prd.userStories.length).toBeGreaterThan(0);
    expect(await readFile(join(dir, 'spec.md'), 'utf8')).toContain('spec from repo');
    for (const f of ['prd-fidelity-report.md', 'acceptance-meta.json', 'plan/plan-1.jsonl', 'sessions/s1.json']) expect(await exists(join(dir, f))).toBe(true);
    expect(await exists(join(dir, 'prd.rejected.json'))).toBe(false);
    expect(await exists(join(ctx.outDir, 'status.json'))).toBe(false);
    expect(await sh(ctx.work, 'status', '--porcelain')).toContain('.nax/');
  });
  test('plan-invalid writes an empty PRD and a rejected copy; the branch is configurable', async () => {
    const ctx = await setup(null);
    await spawnFake(ctx, PLAN, { FAKE_NAX_SCENARIO: 'plan-invalid' }).exited;
    const dir = join(ctx.work, '.nax', 'features', 'feat');
    expect((await json(join(dir, 'prd.json'))).userStories).toEqual([]);
    expect(await exists(join(dir, 'prd.rejected.json'))).toBe(true);
    const other = await setup(null);
    await spawnFake(other, PLAN, { FAKE_NAX_PLAN_BRANCH: 'plan/custom' }).exited;
    expect((await json(join(other.work, '.nax', 'features', 'feat', 'prd.json'))).branchName).toBe('plan/custom');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/runner && bun test test/unit/fake-nax.spec.ts`
Expected: FAIL (the fixture does not exist; `bun` exits non-zero).

- [ ] **Step 3: Write the fixture**

`test/fixtures/fake-nax.ts`:

```ts
/**
 * A stand-in for `nax run` / `nax plan` (slice 3 design §4). Behaviour is chosen by env, see the plan, Task 13.
 * It deliberately mimics the facts the runner depends on: the exit code is not the verdict (a failed run exits 1, a fatal config error exits 0), latest.jsonl appears only at exit,
 * a job profile supplies outputDir, SIGTERM makes nax write run.status = crashed, and `plan` leaves untracked files.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const args = process.argv.slice(2);
const flag = (...names: string[]): string | undefined => {
  for (let i = 0; i < args.length - 1; i += 1) if (names.includes(args[i])) return args[i + 1];
  return undefined;
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const git = (...a: string[]): string => execFileSync('git', a, { cwd: process.cwd(), encoding: 'utf8' }).trim();
const writeAtomic = (path: string, text: string): void => {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
};

if (args[0] === '--version') {
  console.log('0.0.0-fake');
  process.exit(0);
}

const command = args[0];
const feature = flag('-f', '--feature') ?? '';
const jobProfile = (flag('--profile') ?? '').split(',').find((p) => p.startsWith('koda-job-'));
if (!feature || !jobProfile) {
  console.error('fake-nax: needs -f <feature> and a koda-job-* profile in --profile');
  process.exit(2);
}
const naxHome = process.env['NAX_GLOBAL_CONFIG_DIR'] ?? join(homedir(), '.nax');
const profile = JSON.parse(readFileSync(join(naxHome, 'profiles', `${jobProfile}.json`), 'utf8')) as { outputDir?: string };
if (!profile.outputDir || !isAbsolute(profile.outputDir)) {
  console.error('fake-nax: the job profile has no absolute outputDir');
  process.exit(2);
}
const outDir = profile.outputDir;
const scenario = process.env['FAKE_NAX_SCENARIO'] ?? (command === 'plan' ? 'plan-valid' : 'completed');
const stepMs = Number(process.env['FAKE_NAX_STEP_MS'] ?? 30);
const steps = Number(process.env['FAKE_NAX_STEPS'] ?? 3);

async function plan(): Promise<void> {
  await sleep(stepMs * steps);
  const dir = join(process.cwd(), '.nax', 'features', feature);
  mkdirSync(join(dir, 'plan'), { recursive: true });
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const invalid = scenario === 'plan-invalid';
  const prd = { feature, branchName: process.env['FAKE_NAX_PLAN_BRANCH'] ?? `feat/${feature}`, userStories: invalid ? [] : [{ id: 'US-001', title: 'first story' }] };
  writeFileSync(join(dir, 'prd.json'), JSON.stringify(prd, null, 2));
  if (invalid) {
    writeFileSync(join(dir, 'prd.rejected.json'), JSON.stringify(prd));
  } else {
    const from = flag('--from');
    writeFileSync(join(dir, 'spec.md'), from && existsSync(join(process.cwd(), from)) ? readFileSync(join(process.cwd(), from), 'utf8') : '# spec\n');
    writeFileSync(join(dir, 'prd-fidelity-report.md'), '# fidelity\n');
    writeFileSync(join(dir, 'acceptance-meta.json'), '{"acs":1}');
  }
  writeFileSync(join(dir, 'plan', 'plan-1.jsonl'), '{"msg":"planned"}\n');
  writeFileSync(join(dir, 'sessions', 's1.json'), '{}');
  console.log(`planned ${feature}`);
}

async function run(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `run-${stamp}`;
  const logName = `log-${stamp}.jsonl`;
  const runsDir = join(outDir, 'features', feature, 'runs');
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(join(outDir, 'cost'), { recursive: true });
  mkdirSync(join(outDir, 'prompt-audit', feature), { recursive: true });
  writeFileSync(join(outDir, 'prompt-audit', feature, 'p.json'), '{"prompt":"secret prompt text"}');
  const startedAt = new Date().toISOString();
  let passed = 0;
  let spent = 0;
  let finish: Record<string, unknown> | undefined;
  let runStatus = 'running';
  let extra: Record<string, unknown> = {};
  const flush = (): void => writeAtomic(join(outDir, 'status.json'), JSON.stringify({
    version: 1,
    run: { id: runId, feature, workdir: process.cwd(), startedAt, status: runStatus, dryRun: false, pid: process.pid, ...extra },
    progress: { total: steps, passed, failed: 0, paused: 0, blocked: 0, pending: steps - passed },
    cost: { spent, limit: null },
    current: passed < steps ? { storyId: `US-00${passed + 1}`, title: 'story', complexity: 'simple', tddStrategy: 'test-after', model: 'fake', attempt: 1, phase: 'implement' } : null,
    iterations: passed, updatedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(startedAt), lastHeartbeat: new Date().toISOString(),
    ...(finish ? { postRun: { acceptance: { status: 'not-run' }, regression: { status: 'not-run' }, finish } } : {}),
  }));
  // The handler is registered BEFORE the first flush: a test that waits for status.json and then signals must never
  // hit the default SIGTERM action (D70).
  if (scenario === 'hang') {
    process.on('SIGTERM', () => {
      if (process.env['FAKE_NAX_IGNORE_TERM'] === '1') return;
      runStatus = 'crashed';
      extra = { crashedAt: new Date().toISOString(), crashSignal: 'SIGTERM' };
      flush();
      process.exit(0);
    });
  }
  flush();

  if (scenario === 'hang') {
    setInterval(flush, 100);
    await new Promise<void>(() => undefined);
  }

  for (let i = 1; i <= steps; i += 1) {
    await sleep(stepMs);
    passed = i;
    spent += 0.25;
    flush();
    appendFileSync(join(runsDir, logName), `${JSON.stringify({ level: 'info', msg: `story US-00${i} done` })}\n`);
    appendFileSync(join(outDir, 'cost', `cost-${stamp}.jsonl`), `${JSON.stringify({ runId, amount: 0.25 })}\n`);
    console.log(`story US-00${i} done`);
    console.error(`warn: story ${i}`);
    if (scenario === 'crashed' && i === 1) process.kill(process.pid, 'SIGKILL');
  }
  const gate = process.env['FAKE_NAX_GATE'];
  while (gate && !existsSync(gate)) await sleep(50);

  writeFileSync(join(process.cwd(), `koda-fake-${feature}.txt`), `${runId}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', `feat(${feature}): fake story work`);
  runStatus = scenario === 'failed' ? 'failed' : 'completed';
  if (scenario === 'escalated' || scenario === 'completed') {
    let branch = '';
    try {
      branch = git('symbolic-ref', '--short', '-q', 'HEAD');
    } catch {
      branch = '';
    }
    const opened = scenario === 'completed';
    if (branch && opened) git('push', '-q', '--set-upstream', 'origin', branch);
    if (branch) {
      const ledgerDir = join(outDir, 'finish-audit', feature);
      mkdirSync(ledgerDir, { recursive: true });
      const prUrl = 'https://example.test/koda/pull/1';
      writeFileSync(join(ledgerDir, 'last.json'), JSON.stringify({
        branch, headSha: git('rev-parse', 'HEAD'), status: opened ? 'opened' : 'escalated', ...(opened ? { prUrl } : {}), runId, finishedAt: new Date().toISOString(),
      }));
      finish = opened ? { status: 'passed', result: 'opened', url: prUrl } : { status: 'passed', result: 'escalated', escalationReason: 'fake escalation' };
    } else {
      finish = opened ? { status: 'skipped', reason: 'branch' } : { status: 'passed', result: 'escalated', escalationReason: 'fake escalation' };
    }
  }
  flush();
  writeFileSync(join(outDir, 'metrics.json'), JSON.stringify({ runId, cost: spent }));
  symlinkSync(logName, join(runsDir, 'latest.jsonl'));
}

await (command === 'plan' ? plan() : run());
// Real `nax run` exits 1 when the run failed, 0 otherwise (bin/nax.ts:383); a plan exits 0 here (D70).
process.exit(command !== 'plan' && scenario === 'failed' ? 1 : 0);
```

- [ ] **Step 4: Run and lint**

```bash
cd apps/runner && bun test test/unit/fake-nax.spec.ts && bun run type-check && bun run lint
```
Expected: PASS (7 tests), clean.

- [ ] **Step 5: Commit**

```bash
git add apps/runner
git commit -m "test(fleet): fake nax fixture (run and plan scenarios, real-shaped status, logs, ledger)"
```

---
### Task 14: Job profile, the `nax` process, and `.nax-pids` reaping (design §2 steps 5-6, cancel)

**Files:**
- Create: `apps/runner/test/helpers/wait.ts`
- Create: `apps/runner/src/executor/job-profile.ts`, `job-profile.spec.ts`
- Create: `apps/runner/src/executor/nax-process.ts`, `nax-process.spec.ts`
- Create: `apps/runner/src/executor/pid-registry.ts`, `pid-registry.spec.ts`

**Interfaces:**
- Consumes: `assertSegment`, `assertFeature`, `assertRelativePath`, `PathError` (6), `AssignPayload`.
- Produces:
  ```ts
  // test/helpers/wait.ts
  export function waitFor(cond: () => boolean | Promise<boolean>, opts?: { timeoutMs?: number; intervalMs?: number; message?: string }): Promise<void>;   // rejects on timeout
  // job-profile.ts
  export function projectNameFor(owner: string, repo: string): string;         // D-design §2 step 5
  export function jobProfileName(jobId: string): string;                       // koda-job-<jobId>
  export function jobProfilePath(naxHome: string, jobId: string): string;      // <naxHome>/profiles/koda-job-<jobId>.json
  export function writeJobProfile(naxHome: string, jobId: string, outputDir: string, projectName: string): Promise<string>;
  export function deleteJobProfile(naxHome: string, jobId: string): Promise<void>;
  export function sweepOrphanProfiles(naxHome: string, keepJobIds: ReadonlySet<string>): Promise<string[]>;
  // nax-process.ts
  export function buildNaxArgv(naxCommand: readonly string[], assign: AssignPayload): string[];
  export interface SpawnNaxOptions { readonly cwd: string; readonly stdoutPath: string; readonly stderrPath: string; readonly env: Record<string, string | undefined> }
  export function spawnNax(argv: readonly string[], options: SpawnNaxOptions): { pid: number; pgid: number };
  export function isProcessAlive(pid: number): boolean;
  export function signalGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean;   // refuses pgid <= 1 and non-integers
  // pid-registry.ts
  export interface PidEntry { readonly pid: number; readonly spawnedAt: string; readonly workdir: string }
  export function parsePidEntries(text: string): PidEntry[];
  export function selectReapable(entries: readonly PidEntry[], opts: { repoDir: string; since: Date; startedAt: (pid: number) => Promise<Date | null>; selfPid?: number }): Promise<number[]>;
  export function parseEtime(text: string): number | null;            // ps etime ([[dd-]hh:]mm:ss) -> seconds
  export function readProcessStart(pid: number): Promise<Date | null>;   // now - etime; independent of the time zone
  export function readProcessCommand(pid: number): Promise<string | null>;   // `ps -ww -o command=`, the full command line
  export function reapNaxPids(input: { repoDir: string; since: Date; startedAt?: (pid: number) => Promise<Date | null>; kill?: (pid: number) => void }): Promise<number[]>;
  ```

- [ ] **Step 1: Write the failing specs**

`executor/job-profile.spec.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { deleteJobProfile, jobProfileName, jobProfilePath, projectNameFor, sweepOrphanProfiles, writeJobProfile } from './job-profile';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const sha8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);
const NAX_NAME = /^[a-z0-9_-]+$/;

describe('projectNameFor (design §2 step 5)', () => {
  test('lowercases, replaces other characters with -, appends the first 8 hex of SHA-256(owner/repo)', () => {
    expect(projectNameFor('Foo.Bar', 'My.Repo')).toBe(`foo-bar-my-repo-${sha8('Foo.Bar/My.Repo')}`);
    expect(projectNameFor('infra/team', 'deploy')).toBe(`infra-team-deploy-${sha8('infra/team/deploy')}`);
  });
  test('a 100-character name is truncated to 55 characters plus -hash8 (at most 64) and stays valid for nax', () => {
    const name = projectNameFor('a'.repeat(50), 'r'.repeat(100));
    expect(name).toHaveLength(64);
    expect(name).toMatch(NAX_NAME);
    expect(name.endsWith(`-${sha8(`${'a'.repeat(50)}/${'r'.repeat(100)}`)}`)).toBe(true);
  });
  test('leading -, _ and . are stripped so the name never starts with . or _', () => {
    const name = projectNameFor('acme', '.github');
    expect(name).toBe(`acme--github-${sha8('acme/.github')}`);
    const dotted = projectNameFor('._x', '__y');
    expect(dotted[0]).not.toMatch(/[._]/);
    expect(dotted).toMatch(NAX_NAME);
  });
  test('an all-symbol name falls back to "repo"; distinct repos with the same slug get distinct names', () => {
    expect(projectNameFor('...', '---')).toMatch(/^repo-[0-9a-f]{8}$/);
    expect(projectNameFor('a.b', 'c')).not.toBe(projectNameFor('a-b', 'c'));
  });
});

describe('job profile file', () => {
  test('names and paths', () => {
    expect(jobProfileName('cabc123')).toBe('koda-job-cabc123');
    expect(jobProfilePath('/n', 'cabc123')).toBe(join('/n', 'profiles', 'koda-job-cabc123.json'));
    expect(() => jobProfileName('../x')).toThrow();
  });
  test('writes {outputDir, name}, replaces atomically, deletes idempotently', async () => {
    const home = await tmp.make('nax');
    const path = await writeJobProfile(home, 'j1', '/out/j1/nax-out', 'acme-app-12345678');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ outputDir: '/out/j1/nax-out', name: 'acme-app-12345678' });
    await writeJobProfile(home, 'j1', '/out/other', 'n');
    expect(JSON.parse(await readFile(path, 'utf8')).outputDir).toBe('/out/other');
    await deleteJobProfile(home, 'j1');
    await expect(stat(path)).rejects.toThrow();
    await deleteJobProfile(home, 'j1');
  });
  test('sweepOrphanProfiles removes koda-job profiles of unknown jobs and nothing else', async () => {
    const home = await tmp.make('nax');
    await mkdir(join(home, 'profiles'), { recursive: true });
    for (const f of ['koda-job-live.json', 'koda-job-dead.json', 'machine.json', 'koda-job-notes.txt']) await writeFile(join(home, 'profiles', f), '{}');
    expect(await sweepOrphanProfiles(home, new Set(['live']))).toEqual(['koda-job-dead.json']);
    await expect(stat(join(home, 'profiles', 'koda-job-dead.json'))).rejects.toThrow();
    for (const f of ['koda-job-live.json', 'machine.json', 'koda-job-notes.txt']) await stat(join(home, 'profiles', f));
    expect(await sweepOrphanProfiles(join(home, 'missing'), new Set())).toEqual([]);
  });
});
```

`executor/nax-process.spec.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssignPayload } from '@nathapp/fleet-protocol';
import { makeTempDirs } from '../../test/helpers/tmp';
import { waitFor } from '../../test/helpers/wait';
import { buildNaxArgv, isProcessAlive, signalGroup, spawnNax } from './nax-process';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const assign = (over: Partial<AssignPayload> = {}): AssignPayload => ({
  jobId: 'cj1', command: 'RUN', repo: { provider: 'github', owner: 'a', name: 'b', defaultBranch: 'main', cloneUrl: 'x' },
  ref: 'main', feature: 'feat', planFrom: null, profiles: ['fast', 'strict'], maxCostUsd: '5.25', bashMode: 'raw', gitIdentity: { name: 'n', email: 'e' }, ...over,
});

describe('buildNaxArgv (S1 spec §5.2 step 4)', () => {
  test('RUN: headless json run with the chain, the job profile last, and the cost cap', () => {
    expect(buildNaxArgv(['nax'], assign())).toEqual(['nax', 'run', '--headless', '--json', '-f', 'feat', '--profile', 'fast,strict,koda-job-cj1', '--max-cost', '5.25']);
  });
  test('PLAN: plan --from <spec> with the same chain rule; naxCommand may have several words', () => {
    expect(buildNaxArgv(['bun', '/x/fake.ts'], assign({ command: 'PLAN', planFrom: 'docs/spec.md', profiles: [] }))).toEqual(
      ['bun', '/x/fake.ts', 'plan', '--from', 'docs/spec.md', '-f', 'feat', '--profile', 'koda-job-cj1'],
    );
  });
  test.each([
    ['a feature with a slash', { feature: 'a/b' }],
    ['a profile with a comma', { profiles: ['a,b'] }],
    ['a profile using the reserved prefix', { profiles: ['koda-job-x'] }],
    ['a bad cost', { maxCostUsd: '5; rm -rf' }],
    ['a cost with 5 decimals', { maxCostUsd: '1.23456' }],
    ['a PLAN without planFrom', { command: 'PLAN' as const, planFrom: null }],
    ['a planFrom with ..', { command: 'PLAN' as const, planFrom: '../x' }],
    ['a job id with a slash', { jobId: 'a/b' }],
  ])('rejects %s', (_label, over) => {
    expect(() => buildNaxArgv(['nax'], assign(over as Partial<AssignPayload>))).toThrow();
  });
});

describe('spawnNax and signalGroup', () => {
  test('spawns detached with its own process group, output going to files, and survives the caller not awaiting it', async () => {
    const dir = await tmp.make('proc');
    const stdoutPath = join(dir, 'out');
    const stderrPath = join(dir, 'err');
    const { pid, pgid } = spawnNax(['sh', '-c', 'echo to-out; echo to-err >&2; sleep 30'], { cwd: dir, stdoutPath, stderrPath, env: { ...process.env } });
    expect(pgid).toBe(pid);
    expect(isProcessAlive(pid)).toBe(true);
    await waitFor(async () => (await readFile(stdoutPath, 'utf8')).includes('to-out') && (await readFile(stderrPath, 'utf8')).includes('to-err'));
    expect(signalGroup(pgid, 'SIGTERM')).toBe(true);
    await waitFor(() => !isProcessAlive(pid));
  });
  test('a group signal reaches grandchildren', async () => {
    const dir = await tmp.make('proc');
    const pidFile = join(dir, 'grandchild.pid');
    const { pid, pgid } = spawnNax(['sh', '-c', `sleep 60 & echo $! > ${pidFile}; wait`], { cwd: dir, stdoutPath: join(dir, 'o'), stderrPath: join(dir, 'e'), env: { ...process.env } });
    await waitFor(async () => (await readFile(pidFile, 'utf8').catch(() => '')).trim().length > 0);
    const grandchild = Number((await readFile(pidFile, 'utf8')).trim());
    expect(isProcessAlive(grandchild)).toBe(true);
    signalGroup(pgid, 'SIGKILL');
    await waitFor(() => !isProcessAlive(pid) && !isProcessAlive(grandchild));
  });
  test('never signals a reserved or malformed group (0, 1, negative, fractional, NaN)', () => {
    for (const bad of [0, 1, -1, -5, 1.5, NaN, Infinity]) expect(signalGroup(bad, 'SIGKILL')).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-3)).toBe(false);
  });
  test('signalling a dead group is false, not an exception', async () => {
    const dir = await tmp.make('proc');
    const { pid, pgid } = spawnNax(['sh', '-c', 'exit 0'], { cwd: dir, stdoutPath: join(dir, 'o'), stderrPath: join(dir, 'e'), env: { ...process.env } });
    await waitFor(() => !isProcessAlive(pid));
    expect(signalGroup(pgid, 'SIGTERM')).toBe(false);
  });
  test('the environment is exactly what the caller passes', async () => {
    const dir = await tmp.make('proc');
    const { pid } = spawnNax(['sh', '-c', 'echo "$KODA_T:$HOME_SHOULD_NOT_EXIST" > env.txt'], { cwd: dir, stdoutPath: join(dir, 'o'), stderrPath: join(dir, 'e'), env: { PATH: process.env['PATH'], KODA_T: 'yes' } });
    await waitFor(() => !isProcessAlive(pid));
    expect((await readFile(join(dir, 'env.txt'), 'utf8')).trim()).toBe('yes:');
  });
});
```

`executor/pid-registry.spec.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { waitFor } from '../../test/helpers/wait';
import { isProcessAlive } from './nax-process';
import { parseEtime, parsePidEntries, readProcessCommand, readProcessStart, reapNaxPids, selectReapable } from './pid-registry';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const T0 = new Date('2026-10-01T00:00:00.000Z');
const entry = (pid: number, over: Partial<{ spawnedAt: string; workdir: string }> = {}) => JSON.stringify({ pid, spawnedAt: over.spawnedAt ?? '2026-10-01T00:00:05.000Z', workdir: over.workdir ?? '/repo' });

describe('parsePidEntries (nax writes JSON lines)', () => {
  test('skips blank and damaged lines', () => {
    const text = `${entry(11)}\n\nnot json\n{"pid":"x"}\n${entry(12)}\n`;
    expect(parsePidEntries(text).map((e) => e.pid)).toEqual([11, 12]);
  });
});

describe('selectReapable (D37: pids recycle)', () => {
  const started = (map: Record<number, Date | null>) => async (pid: number) => map[pid] ?? null;
  test('keeps only entries of this checkout, registered since the spawn, whose process started before it registered', async () => {
    const entries = parsePidEntries([
      entry(21),                                                        // good
      entry(22, { workdir: '/other' }),                                 // another checkout
      entry(23, { spawnedAt: '2026-09-30T00:00:00.000Z' }),             // registered before this job
      entry(24),                                                        // recycled: process started after registration
      entry(25),                                                        // process gone
      entry(1), entry(0),                                               // reserved pids
      entry(999),                                                       // the daemon itself
    ].join('\n'));
    const startedAt = started({
      21: new Date('2026-10-01T00:00:04.000Z'), 22: new Date('2026-10-01T00:00:04.000Z'), 23: new Date('2026-09-30T00:00:00.000Z'),
      24: new Date('2026-10-01T02:00:00.000Z'), 25: null, 999: new Date('2026-10-01T00:00:04.000Z'),
    });
    expect(await selectReapable(entries, { repoDir: '/repo', since: T0, startedAt, selfPid: 999 })).toEqual([21]);
  });
});

describe('parseEtime', () => {
  test.each([['05:32', 332], ['01:02:03', 3723], ['1-02:03:04', 93_784], ['  00:07 ', 7], ['12-00:00:01', 1_036_801]])('%j is %d seconds', (text, seconds) => {
    expect(parseEtime(text)).toBe(seconds);
  });
  test.each(['', 'garbage', '5', '1:2:3:4', '-1:00'])('%j is not an elapsed time', (text) => {
    expect(parseEtime(text)).toBeNull();
  });
});

describe('readProcessCommand', () => {
  test('returns the full command line of a live process and null for none', async () => {
    const proc = Bun.spawn(['sh', '-c', 'sleep 30; true', 'koda-job-abc123'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      expect(await readProcessCommand(proc.pid)).toContain('koda-job-abc123');
      expect(await readProcessCommand(2 ** 22 + 12345)).toBeNull();
      expect(await readProcessCommand(0)).toBeNull();
    } finally {
      proc.kill();
    }
  });
});

describe('reapNaxPids with real processes', () => {
  test('kills a registered child of this checkout, spares a recycled entry, and truncates the file', async () => {
    const repoDir = await tmp.make('repo');
    const mine = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    const recycled = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      expect((await readProcessStart(mine.pid))?.getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(await readProcessStart(2 ** 22 + 12345)).toBeNull();
      const now = new Date();
      const lines = [
        entry(mine.pid, { spawnedAt: now.toISOString(), workdir: repoDir }),
        entry(recycled.pid, { spawnedAt: new Date(now.getTime() - 3_600_000).toISOString(), workdir: repoDir }),
      ];
      await writeFile(join(repoDir, '.nax-pids'), `${lines.join('\n')}\n`);
      const killed = await reapNaxPids({ repoDir, since: new Date(now.getTime() - 3_700_000) });
      expect(killed).toEqual([mine.pid]);
      await waitFor(() => !isProcessAlive(mine.pid));
      expect(isProcessAlive(recycled.pid)).toBe(true);
      expect(await readFile(join(repoDir, '.nax-pids'), 'utf8')).toBe('');
    } finally {
      mine.kill();
      recycled.kill();
    }
  });
  test('no registry file is a no-op', async () => {
    expect(await reapNaxPids({ repoDir: await tmp.make('repo'), since: T0 })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/runner && bun test src/executor/job-profile.spec.ts src/executor/nax-process.spec.ts src/executor/pid-registry.spec.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`test/helpers/wait.ts`:

```ts
export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(opts.message ?? 'waitFor: condition not met in time');
    await Bun.sleep(opts.intervalMs ?? 25);
  }
}
```

`executor/job-profile.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSegment } from '../paths/safe-segment';

/**
 * Design §2 step 5: `<owner>/<repo>` lowercased, every character outside [a-z0-9_-] replaced by `-`, leading
 * `-`, `_` and `.` stripped, truncated to 55, then `-` and the first 8 hex of SHA-256(`<owner>/<repo>`).
 * nax requires /^[a-z0-9_-]+$/, at most 64 characters, not starting with `.` or `_`.
 */
export function projectNameFor(owner: string, repo: string): string {
  const key = `${owner}/${repo}`;
  const base = key.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[-_.]+/, '').slice(0, 55);
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 8);
  return `${base === '' ? 'repo' : base}-${hash}`;
}

export const jobProfileName = (jobId: string): string => `koda-job-${assertSegment('jobId', jobId)}`;

export const jobProfilePath = (naxHome: string, jobId: string): string => join(naxHome, 'profiles', `${jobProfileName(jobId)}.json`);

/** A raw overlay (`{outputDir, name}`) appended last to the chain; it must exist until nax exits (SP-1). */
export async function writeJobProfile(naxHome: string, jobId: string, outputDir: string, projectName: string): Promise<string> {
  const path = jobProfilePath(naxHome, jobId);
  await mkdir(join(naxHome, 'profiles'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ outputDir, name: projectName }, null, 2)}\n`);
  await rename(tmp, path);
  return path;
}

export async function deleteJobProfile(naxHome: string, jobId: string): Promise<void> {
  await rm(jobProfilePath(naxHome, jobId), { force: true });
}

/** A crash can leave profiles of finished jobs behind; the daemon removes those at start. */
export async function sweepOrphanProfiles(naxHome: string, keepJobIds: ReadonlySet<string>): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(naxHome, 'profiles'));
  } catch {
    return [];
  }
  const orphans = names.filter((name) => {
    const m = /^koda-job-(.+)\.json$/.exec(name);
    return m !== null && !keepJobIds.has(m[1]);
  });
  await Promise.all(orphans.map((name) => rm(join(naxHome, 'profiles', name), { force: true })));
  return orphans;
}
```

`executor/nax-process.ts`:

```ts
import type { AssignPayload } from '@nathapp/fleet-protocol';
import { PathError, assertFeature, assertRelativePath } from '../paths/safe-segment';
import { jobProfileName } from './job-profile';

/** Same rule as the server's profile names (apps/api/src/fleet/common/capabilities.ts PROFILE_NAME_RE). */
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const COST_RE = /^\d+(\.\d{1,4})?$/;
export const RESERVED_PREFIX = 'koda-job-';

/** S1 spec §5.2 step 4. Every dynamic piece is checked again here (D30): the chain is joined with commas. */
export function buildNaxArgv(naxCommand: readonly string[], assign: AssignPayload): string[] {
  const feature = assertFeature(assign.feature);
  for (const profile of assign.profiles) {
    if (!PROFILE_NAME.test(profile) || profile.startsWith(RESERVED_PREFIX)) throw new PathError('invalid profile');
  }
  const chain = [...assign.profiles, jobProfileName(assign.jobId)].join(',');
  if (assign.command === 'PLAN') {
    return [...naxCommand, 'plan', '--from', assertRelativePath('planFrom', assign.planFrom), '-f', feature, '--profile', chain];
  }
  if (!COST_RE.test(assign.maxCostUsd)) throw new PathError('invalid maxCostUsd');
  return [...naxCommand, 'run', '--headless', '--json', '-f', feature, '--profile', chain, '--max-cost', assign.maxCostUsd];
}

export interface SpawnNaxOptions {
  readonly cwd: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly env: Record<string, string | undefined>;
}

/**
 * Detached: its own session and process group on macOS and Linux, so it survives a daemon restart; output goes to
 * files (a pipe would die with the daemon). pgid equals pid for a new session leader.
 */
export function spawnNax(argv: readonly string[], options: SpawnNaxOptions): { pid: number; pgid: number } {
  const proc = Bun.spawn([...argv], {
    cwd: options.cwd, env: options.env, stdin: 'ignore', detached: true,
    stdout: Bun.file(options.stdoutPath), stderr: Bun.file(options.stderrPath),
  });
  proc.unref();
  return { pid: proc.pid, pgid: proc.pid };
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Never signals pgid 0, 1, a negative or a non-integer: `kill(-1)` would signal every process we may signal. */
export function signalGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}
```

`executor/pid-registry.ts`:

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface PidEntry {
  readonly pid: number;
  readonly spawnedAt: string;
  readonly workdir: string;
}

/** `.nax-pids` is JSON lines (nax src/execution/pid-registry.ts). */
export function parsePidEntries(text: string): PidEntry[] {
  const entries: PidEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value['pid'] === 'number' && typeof value['spawnedAt'] === 'string' && typeof value['workdir'] === 'string') {
        entries.push({ pid: value['pid'], spawnedAt: value['spawnedAt'], workdir: value['workdir'] });
      }
    } catch {
      // a damaged line is skipped
    }
  }
  return entries;
}

const REGISTRATION_SLACK_MS = 2_000;

/** D37: nax itself refuses to signal stale entries because pids recycle; so does the runner. */
export async function selectReapable(
  entries: readonly PidEntry[],
  opts: { repoDir: string; since: Date; startedAt: (pid: number) => Promise<Date | null>; selfPid?: number },
): Promise<number[]> {
  const repo = resolve(opts.repoDir);
  const picked: number[] = [];
  for (const entry of entries) {
    const registered = Date.parse(entry.spawnedAt);
    if (!Number.isInteger(entry.pid) || entry.pid <= 1 || entry.pid === (opts.selfPid ?? process.pid)) continue;
    if (resolve(entry.workdir) !== repo || Number.isNaN(registered) || registered < opts.since.getTime() - 1_000) continue;
    const started = await opts.startedAt(entry.pid);
    if (started && started.getTime() <= registered + REGISTRATION_SLACK_MS) picked.push(entry.pid);
  }
  return picked;
}

/** `ps -o etime=` is `[[dd-]hh:]mm:ss` on macOS and Linux; `lstart` would depend on the time zone (bun test forces UTC). */
export function parseEtime(text: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!m) return null;
  const [days, hours, minutes, seconds] = [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3]), Number(m[4])];
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

export async function readProcessStart(pid: number): Promise<Date | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const proc = Bun.spawn(['ps', '-o', 'etime=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', env: { ...process.env, LC_ALL: 'C' } });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const elapsed = parseEtime(text);
  return elapsed === null ? null : new Date(Date.now() - elapsed * 1000);
}

/** The identity check for a process that is not our child: a job's argv carries `koda-job-<jobId>` (S1 spec §5.2 step 4). */
export async function readProcessCommand(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const proc = Bun.spawn(['ps', '-ww', '-o', 'command=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', env: { ...process.env, LC_ALL: 'C' } });
  const text = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return text === '' ? null : text;
}

export async function reapNaxPids(input: {
  repoDir: string;
  since: Date;
  startedAt?: (pid: number) => Promise<Date | null>;
  kill?: (pid: number) => void;
}): Promise<number[]> {
  const path = join(input.repoDir, '.nax-pids');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const kill = input.kill ?? ((pid: number) => process.kill(pid, 'SIGKILL'));
  const targets = await selectReapable(parsePidEntries(text), { repoDir: input.repoDir, since: input.since, startedAt: input.startedAt ?? readProcessStart });
  const killed: number[] = [];
  for (const pid of targets) {
    try {
      kill(pid);
      killed.push(pid);
    } catch {
      // already gone
    }
  }
  await writeFile(path, '');
  return killed;
}
```

- [ ] **Step 4: Run and lint**

```bash
cd apps/runner && bun test src/executor && bun run type-check && bun run lint
```
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/runner
git commit -m "feat(fleet): runner job profile, detached nax process control, guarded .nax-pids reaping"
```

---

### Task 15: Watcher — status polling, log tails, rate cap (design §2 step 7)

**Files:**
- Create: `apps/runner/src/watcher/run-log.ts`, `file-tail.ts`, `log-budget.ts`, `watcher.ts`
- Create: `apps/runner/src/watcher/watcher.spec.ts`

**Interfaces:**
- Consumes: `readStatusFile`, `mapStatusToSnapshot` (11), `SnapshotEventPayload`, `LogEventPayload`.
- Produces:
  ```ts
  // run-log.ts
  export function findRunLog(outDir: string, feature: string): Promise<string | null>;   // the one *.jsonl other than latest.jsonl under <out>/features/<f>/runs (newest mtime when several)
  export function runLogId(path: string): string;                                       // basename without .jsonl
  export function findCostRunId(outDir: string): Promise<string | null>;                // <out>/cost/<id>.jsonl
  // file-tail.ts
  export class FileTail { static fromStart(path: string): FileTail; static fromEnd(path: string): Promise<FileTail>; readNew(final?: boolean): Promise<string> }   // complete lines only unless final; resets when the file shrinks; at most 1 MiB per call
  // log-budget.ts
  export const LOG_TEXT_BYTES = 8_000; export const LOG_JSON_BYTES = 15_000; export const LOG_PER_MINUTE = 60;
  export function chunkText(text: string): string[];       // each chunk <= 8000 raw and <= 15000 JSON-escaped bytes, split on code points
  export class LogBudget { constructor(nowMs: () => number, perMinute?: number); take(): boolean; takeDropped(): number; get dropped(): number }
  // watcher.ts
  export interface WatcherSink { snapshot(payload: SnapshotEventPayload): void; lifecycle(level: 'info' | 'warn' | 'error', message: string): void; logLine(payload: LogEventPayload): void }
  export interface WatcherOptions { readonly outDir: string; readonly feature: string; readonly stdoutPath: string; readonly stderrPath: string; readonly startAtEnd: boolean; readonly nowMs: () => number; readonly onRunIds?: (ids: { naxRunId: string; logPath: string | null }) => void }
  export class Watcher { constructor(sink: WatcherSink, options: WatcherOptions); tick(final?: boolean): Promise<void> }
  ```
  Behaviour: each `tick` reads `status.json` and emits a `snapshot` only when the mapped payload changed; a run of five unreadable reads logs one `lifecycle` warning; the run log and the stdout/stderr files are tailed into `log` events (stream `run`, `stdout`, `stderr`), capped at 60 events a minute across all streams, the excess counted into the next snapshot's `droppedLogs` (D45); `startAtEnd` (readopt, D34) skips what is already on disk.

- [ ] **Step 1: Write the failing spec**

`watcher/watcher.spec.ts`:

```ts
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogEventPayload, SnapshotEventPayload } from '@nathapp/fleet-protocol';
import { makeTempDirs } from '../../test/helpers/tmp';
import { FileTail } from './file-tail';
import { LogBudget, chunkText } from './log-budget';
import { findCostRunId, findRunLog, runLogId } from './run-log';
import { Watcher, type WatcherOptions, type WatcherSink } from './watcher';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

let base: string;
let snaps: SnapshotEventPayload[];
let logs: LogEventPayload[];
let notes: Array<{ level: string; message: string }>;
let ids: Array<{ naxRunId: string; logPath: string | null }>;
let clock = 0;
const sink: WatcherSink = {
  snapshot: (p) => { snaps.push(p); },
  lifecycle: (level, message) => { notes.push({ level, message }); },
  logLine: (p) => { logs.push(p); },
};
const options = (over: Partial<WatcherOptions> = {}): WatcherOptions => ({
  outDir: join(base, 'out'), feature: 'feat', stdoutPath: join(base, 'nax.stdout'), stderrPath: join(base, 'nax.stderr'),
  startAtEnd: false, nowMs: () => clock, onRunIds: (i) => { ids.push(i); }, ...over,
});
const writeStatus = (over: Record<string, unknown> = {}) => writeFile(join(base, 'out', 'status.json'), JSON.stringify({
  version: 1, run: { id: 'run-1', status: 'running' }, progress: { total: 3, passed: 1, failed: 0, paused: 0, blocked: 0, pending: 2 },
  cost: { spent: 0.5 }, current: { storyId: 'US-002', phase: 'implement' }, lastHeartbeat: '2026-10-01T00:00:00.000Z', ...over,
}));
const runsDir = () => join(base, 'out', 'features', 'feat', 'runs');

beforeEach(async () => {
  base = await tmp.make('watch');
  await mkdir(join(base, 'out'), { recursive: true });
  snaps = []; logs = []; notes = []; ids = []; clock = 0;
});

describe('snapshots', () => {
  test('emits on the first read, again only when the mapped payload changes, and reports run ids once', async () => {
    const w = new Watcher(sink, options());
    await writeStatus();
    await w.tick();
    await w.tick();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ naxRunId: 'run-1', currentStoryId: 'US-002', costSpentUsd: '0.5000' });
    await writeStatus({ progress: { total: 3, passed: 2, failed: 0, paused: 0, blocked: 0, pending: 1 } });
    await w.tick();
    expect(snaps).toHaveLength(2);
    expect(ids).toEqual([{ naxRunId: 'run-1', logPath: null }]);
  });
  test('a missing status.json (PLAN, or not started yet) emits nothing and warns nothing', async () => {
    const w = new Watcher(sink, options());
    for (let i = 0; i < 8; i += 1) await w.tick();
    expect(snaps).toEqual([]);
    expect(notes).toEqual([]);
  });
  test('five unreadable reads in a row warn once; a good read recovers and emits', async () => {
    const w = new Watcher(sink, options());
    await writeFile(join(base, 'out', 'status.json'), '{"run":');
    for (let i = 0; i < 7; i += 1) await w.tick();
    expect(notes).toEqual([{ level: 'warn', message: 'status.json unreadable 5 times in a row' }]);
    await writeStatus();
    await w.tick();
    expect(snaps).toHaveLength(1);
    await writeFile(join(base, 'out', 'status.json'), '{"run":');
    for (let i = 0; i < 5; i += 1) await w.tick();
    expect(notes).toHaveLength(2); // a new streak warns again
  });
  test('the run log and cost ledger ids appear in the snapshot; latest.jsonl is never the run log', async () => {
    await mkdir(runsDir(), { recursive: true });
    await mkdir(join(base, 'out', 'cost'), { recursive: true });
    await writeFile(join(runsDir(), 'log-7.jsonl'), '');
    await symlink('log-7.jsonl', join(runsDir(), 'latest.jsonl'));
    await writeFile(join(base, 'out', 'cost', 'cost-7.jsonl'), '');
    await writeStatus();
    await new Watcher(sink, options()).tick();
    expect(snaps[0]).toMatchObject({ naxLogRunId: 'log-7', naxCostRunId: 'cost-7' });
    expect(ids[0].logPath).toBe(join(runsDir(), 'log-7.jsonl'));
  });
});

describe('run log discovery', () => {
  test('none, one, and several (newest wins)', async () => {
    expect(await findRunLog(join(base, 'out'), 'feat')).toBeNull();
    await mkdir(runsDir(), { recursive: true });
    await writeFile(join(runsDir(), 'a.jsonl'), '');
    expect(await findRunLog(join(base, 'out'), 'feat')).toBe(join(runsDir(), 'a.jsonl'));
    await Bun.sleep(15);
    await writeFile(join(runsDir(), 'b.jsonl'), '');
    expect(await findRunLog(join(base, 'out'), 'feat')).toBe(join(runsDir(), 'b.jsonl'));
    expect(runLogId(join(runsDir(), 'b.jsonl'))).toBe('b');
    expect(await findCostRunId(join(base, 'out'))).toBeNull();
  });
});

describe('log tails', () => {
  test('run log, stdout and stderr become log events on their streams, whole lines only until the final flush', async () => {
    await mkdir(runsDir(), { recursive: true });
    await writeFile(join(runsDir(), 'log-1.jsonl'), '{"msg":"a"}\n{"msg":"par');
    await writeFile(join(base, 'nax.stdout'), 'hello out\n');
    await writeFile(join(base, 'nax.stderr'), 'oops err\n');
    const w = new Watcher(sink, options());
    await w.tick();
    expect(logs).toEqual(expect.arrayContaining([
      { stream: 'run', text: '{"msg":"a"}\n' }, { stream: 'stdout', text: 'hello out\n' }, { stream: 'stderr', text: 'oops err\n' },
    ]));
    expect(logs.filter((l) => l.stream === 'run')).toHaveLength(1);
    await appendFile(join(runsDir(), 'log-1.jsonl'), 'tial"}\n');
    await w.tick();
    expect(logs.filter((l) => l.stream === 'run').map((l) => l.text)).toEqual(['{"msg":"a"}\n', '{"msg":"partial"}\n']);
    await appendFile(join(base, 'nax.stdout'), 'no newline at exit');
    await w.tick();
    expect(logs.filter((l) => l.stream === 'stdout')).toHaveLength(1);
    await w.tick(true);
    expect(logs.filter((l) => l.stream === 'stdout').map((l) => l.text)).toEqual(['hello out\n', 'no newline at exit']);
  });
  test('startAtEnd (readopt, D34) skips what is on disk, tails what is appended, and still snapshots', async () => {
    await mkdir(runsDir(), { recursive: true });
    await writeFile(join(runsDir(), 'log-1.jsonl'), 'old\n');
    await writeFile(join(base, 'nax.stdout'), 'old out\n');
    await writeStatus();
    const w = new Watcher(sink, options({ startAtEnd: true }));
    await w.tick();
    expect(logs).toEqual([]);
    expect(snaps).toHaveLength(1);
    await appendFile(join(runsDir(), 'log-1.jsonl'), 'new\n');
    await appendFile(join(base, 'nax.stdout'), 'new out\n');
    await w.tick();
    expect(logs.map((l) => l.text).sort()).toEqual(['new\n', 'new out\n']);
  });
  test('a file that shrinks is read again from the start', async () => {
    await writeFile(join(base, 'nax.stdout'), 'a-long-first-line\n');
    const w = new Watcher(sink, options());
    await w.tick();
    await writeFile(join(base, 'nax.stdout'), 'b\n');
    await w.tick();
    expect(logs.map((l) => l.text)).toEqual(['a-long-first-line\n', 'b\n']);
  });
});

describe('the log rate cap (D45)', () => {
  test('at most 60 log events a minute; the excess is counted into the next snapshot once', async () => {
    await writeStatus();
    const w = new Watcher(sink, options());
    await w.tick();
    for (let i = 0; i < 100; i += 1) {
      await appendFile(join(base, 'nax.stdout'), `line ${i}\n`);
      await w.tick();
    }
    expect(logs).toHaveLength(60);
    await writeStatus({ progress: { total: 3, passed: 3, failed: 0, paused: 0, blocked: 0, pending: 0 } });
    await w.tick();
    expect(snaps.at(-1)).toMatchObject({ droppedLogs: 40 });
    await writeStatus({ cost: { spent: 9 } });
    await w.tick();
    expect(snaps.at(-1)).not.toHaveProperty('droppedLogs');
  });
  test('the window slides: a minute later logging resumes', async () => {
    const budget = new LogBudget(() => clock, 2);
    expect([budget.take(), budget.take(), budget.take()]).toEqual([true, true, false]);
    expect(budget.dropped).toBe(1);
    clock = 61_000;
    expect(budget.take()).toBe(true);
    expect(budget.takeDropped()).toBe(1);
    expect(budget.takeDropped()).toBe(0);
  });
});

describe('chunkText', () => {
  test('keeps every chunk under 8000 raw and 15000 escaped bytes, splitting on code points', () => {
    const control = chunkText('\u0001'.repeat(9_000));
    expect(control.length).toBeGreaterThan(1);
    for (const c of control) {
      expect(Buffer.byteLength(c, 'utf8')).toBeLessThanOrEqual(8_000);
      expect(Buffer.byteLength(JSON.stringify({ stream: 'run', text: c }), 'utf8')).toBeLessThanOrEqual(16_384);
    }
    expect(control.join('')).toBe('\u0001'.repeat(9_000));
    const wide = chunkText('\u{1F600}'.repeat(4_000)); // 4-byte characters
    for (const c of wide) {
      expect(c).toMatch(/^(\u{1F600})+$/u);
      expect(Buffer.byteLength(c, 'utf8')).toBeLessThanOrEqual(8_000);
    }
    expect(wide.join('')).toBe('\u{1F600}'.repeat(4_000));
  });
  test('short and empty text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('abc\n')).toEqual(['abc\n']);
  });
});

describe('FileTail', () => {
  test('a missing file reads as empty; fromEnd starts after the current content', async () => {
    const path = join(base, 't.log');
    expect(await FileTail.fromStart(path).readNew()).toBe('');
    await writeFile(path, 'x\n');
    const tail = await FileTail.fromEnd(path);
    expect(await tail.readNew()).toBe('');
    await appendFile(path, 'y\n');
    expect(await tail.readNew()).toBe('y\n');
    await truncate(path, 0);
    await appendFile(path, 'z\n');
    expect(await tail.readNew()).toBe('z\n');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/runner && bun test src/watcher/watcher.spec.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`watcher/run-log.ts`:

```ts
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

async function listJsonl(dir: string, skip: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.jsonl') && name !== skip);
  } catch {
    return [];
  }
}

async function newest(dir: string, names: string[]): Promise<string | null> {
  if (names.length === 0) return null;
  if (names.length === 1) return join(dir, names[0]);
  const timed = await Promise.all(names.map(async (name) => ({ name, mtime: (await stat(join(dir, name))).mtimeMs })));
  timed.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  return join(dir, timed[0].name);
}

/**
 * During the run the log is `<out>/features/<f>/runs/<logRunId>.jsonl` (`latest.jsonl` is symlinked only after
 * the run returns), and a fresh output dir holds exactly one run; the newest wins if that ever fails.
 */
export async function findRunLog(outDir: string, feature: string): Promise<string | null> {
  const dir = join(outDir, 'features', feature, 'runs');
  return newest(dir, await listJsonl(dir, 'latest.jsonl'));
}

export const runLogId = (path: string): string => basename(path, '.jsonl');

export async function findCostRunId(outDir: string): Promise<string | null> {
  const dir = join(outDir, 'cost');
  const path = await newest(dir, await listJsonl(dir, ''));
  return path ? runLogId(path) : null;
}
```

`watcher/file-tail.ts`:

```ts
import { stat } from 'node:fs/promises';

const MAX_READ_BYTES = 1_048_576;
const sizeOf = (path: string): Promise<number> => stat(path).then((s) => s.size, () => 0);

/** Reads what was appended since the last call. Whole lines only, unless `final` (the process has exited). */
export class FileTail {
  private constructor(private readonly path: string, private offset: number) {}

  static fromStart(path: string): FileTail {
    return new FileTail(path, 0);
  }

  static async fromEnd(path: string): Promise<FileTail> {
    return new FileTail(path, await sizeOf(path));
  }

  async readNew(final = false): Promise<string> {
    const size = await sizeOf(this.path);
    if (size < this.offset) this.offset = 0;
    if (size === this.offset) return '';
    const end = Math.min(size, this.offset + MAX_READ_BYTES);
    const buffer = Buffer.from(await Bun.file(this.path).slice(this.offset, end).arrayBuffer());
    let cut = final ? buffer.length : buffer.lastIndexOf(0x0a) + 1;
    if (cut === 0 && buffer.length >= MAX_READ_BYTES) cut = buffer.length; // one enormous line: do not wait forever
    if (cut === 0) return '';
    this.offset += cut;
    return buffer.subarray(0, cut).toString('utf8');
  }
}
```

`watcher/log-budget.ts`:

```ts
export const LOG_TEXT_BYTES = 8_000;
/** Leaves room under the 16,384-byte payload limit for `{"stream":"stdout","text":""}`. */
export const LOG_JSON_BYTES = 15_000;
export const LOG_PER_MINUTE = 60;

const escapedBytes = (ch: string): number => Buffer.byteLength(JSON.stringify(ch), 'utf8') - 2;

/** Splits text into chunks whose serialised JSON stays under the limit even for control characters. */
export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  let raw = 0;
  let json = 0;
  for (const ch of text) {
    const r = Buffer.byteLength(ch, 'utf8');
    const j = escapedBytes(ch);
    if (current !== '' && (raw + r > LOG_TEXT_BYTES || json + j > LOG_JSON_BYTES)) {
      chunks.push(current);
      current = '';
      raw = 0;
      json = 0;
    }
    current += ch;
    raw += r;
    json += j;
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

/** A sliding one-minute window over log events; refusals are counted until reported (D45). */
export class LogBudget {
  private stamps: number[] = [];
  private lost = 0;

  constructor(private readonly nowMs: () => number, private readonly perMinute: number = LOG_PER_MINUTE) {}

  take(): boolean {
    const now = this.nowMs();
    this.stamps = this.stamps.filter((t) => now - t < 60_000);
    if (this.stamps.length >= this.perMinute) {
      this.lost += 1;
      return false;
    }
    this.stamps.push(now);
    return true;
  }

  get dropped(): number {
    return this.lost;
  }

  takeDropped(): number {
    const n = this.lost;
    this.lost = 0;
    return n;
  }
}
```

`watcher/watcher.ts`:

```ts
import { join } from 'node:path';
import type { LogEventPayload, SnapshotEventPayload } from '@nathapp/fleet-protocol';
import { mapStatusToSnapshot, readStatusFile } from './status-snapshot';
import { FileTail } from './file-tail';
import { LogBudget, chunkText } from './log-budget';
import { findCostRunId, findRunLog, runLogId } from './run-log';

export interface WatcherSink {
  snapshot(payload: SnapshotEventPayload): void;
  lifecycle(level: 'info' | 'warn' | 'error', message: string): void;
  logLine(payload: LogEventPayload): void;
}

export interface WatcherOptions {
  readonly outDir: string;
  readonly feature: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly startAtEnd: boolean;
  readonly nowMs: () => number;
  readonly onRunIds?: (ids: { naxRunId: string; logPath: string | null }) => void;
}

const UNREADABLE_STREAK = 5;

type Stream = LogEventPayload['stream'];

/** Polls nax's files and turns them into journal events (design §2 step 7). One tick per poll; the caller sleeps. */
export class Watcher {
  private readonly budget: LogBudget;
  private tails = new Map<Stream, FileTail>();
  private ticks = 0;
  private unreadable = 0;
  private lastKey = '';
  private lastIds = '';
  private runLogPath: string | null = null;

  constructor(private readonly sink: WatcherSink, private readonly options: WatcherOptions) {
    this.budget = new LogBudget(options.nowMs);
  }

  async tick(final = false): Promise<void> {
    const first = this.ticks === 0;
    this.ticks += 1;
    await this.pumpStatus();
    await this.pumpLogs(first, final);
  }

  private async pumpStatus(): Promise<void> {
    const { status, problem } = await readStatusFile(join(this.options.outDir, 'status.json'));
    if (problem === 'invalid') {
      this.unreadable += 1;
      if (this.unreadable === UNREADABLE_STREAK) this.sink.lifecycle('warn', 'status.json unreadable 5 times in a row');
      return;
    }
    if (!status) return;
    this.unreadable = 0;
    this.runLogPath ??= await findRunLog(this.options.outDir, this.options.feature);
    const payload = mapStatusToSnapshot(status, {
      logRunId: this.runLogPath ? runLogId(this.runLogPath) : null,
      costRunId: await findCostRunId(this.options.outDir),
      droppedLogs: this.budget.dropped,
    });
    const { droppedLogs: _dropped, ...stable } = payload;
    const key = JSON.stringify(stable);
    if (key === this.lastKey) return;      // lost logs ride the next snapshot that is emitted anyway (D45)
    this.lastKey = key;
    this.budget.takeDropped();
    this.sink.snapshot(payload);
    const ids = `${status.run.id}|${this.runLogPath ?? ''}`;
    if (ids !== this.lastIds) {
      this.lastIds = ids;
      this.options.onRunIds?.({ naxRunId: status.run.id, logPath: this.runLogPath });
    }
  }

  private async tailFor(stream: Stream, path: string, first: boolean): Promise<FileTail> {
    const existing = this.tails.get(stream);
    if (existing) return existing;
    const tail = this.options.startAtEnd && first ? await FileTail.fromEnd(path) : FileTail.fromStart(path);
    this.tails.set(stream, tail);
    return tail;
  }

  private async pumpLogs(first: boolean, final: boolean): Promise<void> {
    this.runLogPath ??= await findRunLog(this.options.outDir, this.options.feature);
    const sources: Array<[Stream, string | null]> = [
      ['run', this.runLogPath], ['stdout', this.options.stdoutPath], ['stderr', this.options.stderrPath],
    ];
    for (const [stream, path] of sources) {
      if (path === null) continue;
      const text = await (await this.tailFor(stream, path, first)).readNew(final);
      for (const chunk of chunkText(text)) {
        if (this.budget.take()) this.sink.logLine({ stream, text: chunk });
      }
    }
  }
}
```

- [ ] **Step 4: Run and lint**

```bash
cd apps/runner && bun test src/watcher && bun run type-check && bun run lint
```
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/runner
git commit -m "feat(fleet): runner watcher (status snapshots, log tails, rate cap with dropped-log accounting)"
```

---

### Task 16: PLAN commit and push (design §2 step 8, R-3.4)

**Files:**
- Create: `apps/runner/src/executor/plan-commit.ts`
- Create: `apps/runner/test/unit/plan-commit.spec.ts`

**Interfaces:**
- Consumes: `Git`, `reasonFromError`, `isAuthFailure`, `NO_CREDENTIALS_REASON` (12), `planBranch`, `checkoutArgs`, `validateBranchName` (12), `featureDirFor` (6), `GitIdentity` (`@nathapp/fleet-protocol`).
- Produces:
  ```ts
  export const PLAN_ALLOWLIST: readonly ['prd.json', 'spec.md', 'prd-fidelity-report.md', 'acceptance-meta.json'];
  export function stashPlanOutputs(repoDir: string, jobDir: string, feature: string): Promise<{ files: string[]; logs: string[] }>;
  //   WRITE-ONCE (D61): copies the present allowlisted files to <jobDir>/plan-out/ and plan/*.jsonl to <jobDir>/plan-logs/, built in
  //   `.tmp` siblings and renamed into place (plan-out last). When plan-out/ already exists it is the source of truth: the call
  //   returns its listing and never reads the checkout again. Nothing in the checkout (no allowlisted file, no plan log): nothing is published, {files: [], logs: []}. A failed plan's logs alone are stashed so they still reach the bundle.
  export interface PlanPushInput { readonly git: Git; readonly repoDir: string; readonly jobDir: string; readonly feature: string; readonly jobId: string; readonly branchName: string; readonly refSha: string; readonly defaultBranch: string; readonly identity: GitIdentity }
  export type PlanPushResult = { ok: true; branch: string; sha: string; committed: boolean } | { ok: false; reason: string };
  export function commitAndPushPlan(input: PlanPushInput): Promise<PlanPushResult>;
  ```
  Reasons (D32): `checkout: invalid branchName`, `checkout: branch diverged`, `plan output missing`, `plan commit failed`, `plan push failed`, `no git credentials (runner 3b)` (push only). The commit is `chore(plan): <feature> PRD via koda job <jobId>` with `--no-verify`, `commit.gpgsign=false` and the assigned identity passed explicitly as `-c user.name=<identity.name> -c user.email=<identity.email>` (D52, D69), so it never depends on repo or global git config. Idempotent: after a crash between commit and push, a second call finds the branch, stages nothing, commits nothing and pushes.

- [ ] **Step 1: Write the failing spec**

`test/unit/plan-commit.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGit } from '../../src/executor/git';
import { commitAndPushPlan, stashPlanOutputs } from '../../src/executor/plan-commit';
import { cleanWorkspace, ensureClone } from '../../src/executor/workspace';
import { git as sh, isolateGit, makeOrigin, pushCommit } from '../helpers/git-fixture';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());
const g = createGit();
const identity = { name: 'koda-fleet[bot]', email: 'koda-fleet[bot]@users.noreply.github.com' };
const NEW_PRD = JSON.stringify({ feature: 'f', branchName: 'feat/f', userStories: [{ id: 'US-001' }] });

async function setup(files: Record<string, string> = { 'README.md': 'x' }, extra: Parameters<typeof makeOrigin>[2]['branches'] = []) {
  const base = await tmp.make('plan');
  const origin = await makeOrigin(base, 'origin', { files, branches: extra });
  const repoDir = join(base, 'clone');
  const jobDir = join(base, 'job');
  await ensureClone(g, { repoDir, cloneUrl: origin.url, identity });
  await cleanWorkspace(g, repoDir);
  await sh(repoDir, 'checkout', '-q', '--detach', 'origin/main');
  return { base, origin, repoDir, jobDir, refSha: await sh(repoDir, 'rev-parse', 'HEAD') };
}
/** What `nax plan` leaves behind: untracked outputs beside decoys that must never be committed. */
async function planOutputs(repoDir: string, prd = NEW_PRD): Promise<void> {
  const dir = join(repoDir, '.nax', 'features', 'f');
  await mkdir(join(dir, 'plan'), { recursive: true });
  await mkdir(join(dir, 'sessions'), { recursive: true });
  await writeFile(join(dir, 'prd.json'), prd);
  await writeFile(join(dir, 'spec.md'), '# spec\n');
  await writeFile(join(dir, 'prd-fidelity-report.md'), '# fidelity\n');
  await writeFile(join(dir, 'acceptance-meta.json'), '{}');
  await writeFile(join(dir, 'prd.rejected.json'), '{"old":true}');
  await writeFile(join(dir, 'plan', 'plan-1.jsonl'), '{"m":1}\n');
  await writeFile(join(dir, 'sessions', 's1.json'), '{}');
}
const input = (s: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown> = {}) => ({
  git: g, repoDir: s.repoDir, jobDir: s.jobDir, feature: 'f', jobId: 'j1', branchName: 'feat/f', refSha: s.refSha, defaultBranch: 'main', identity, ...over,
});

describe('stashPlanOutputs', () => {
  test('copies the allowlisted files and the plan logs, nothing else', async () => {
    const s = await setup();
    await planOutputs(s.repoDir);
    const stashed = await stashPlanOutputs(s.repoDir, s.jobDir, 'f');
    expect(stashed.files.sort()).toEqual(['acceptance-meta.json', 'prd-fidelity-report.md', 'prd.json', 'spec.md']);
    expect(stashed.logs).toEqual(['plan-1.jsonl']);
    expect(await readFile(join(s.jobDir, 'plan-logs', 'plan-1.jsonl'), 'utf8')).toBe('{"m":1}\n');
    await expect(stat(join(s.jobDir, 'plan-out', 'prd.rejected.json'))).rejects.toThrow();
    await expect(stat(join(s.jobDir, 'plan-out', 's1.json'))).rejects.toThrow();
  });
  test('an absent feature directory stashes nothing and publishes no plan-out', async () => {
    const s = await setup();
    expect(await stashPlanOutputs(s.repoDir, s.jobDir, 'f')).toEqual({ files: [], logs: [] });
    await expect(stat(join(s.jobDir, 'plan-out'))).rejects.toThrow();
  });
  test('is write-once (D61): a second call returns the first stash and never re-reads the checkout', async () => {
    const s = await setup();
    await planOutputs(s.repoDir);
    const first = await stashPlanOutputs(s.repoDir, s.jobDir, 'f');
    await writeFile(join(s.repoDir, '.nax', 'features', 'f', 'prd.json'), '{"replaced":true}');
    await rm(join(s.repoDir, '.nax', 'features', 'f', 'spec.md'));
    const second = await stashPlanOutputs(s.repoDir, s.jobDir, 'f');
    expect(second.files.sort()).toEqual(first.files.sort());
    expect(second.logs).toEqual(first.logs);
    expect(await readFile(join(s.jobDir, 'plan-out', 'prd.json'), 'utf8')).toBe(NEW_PRD);
    expect(await readFile(join(s.jobDir, 'plan-out', 'spec.md'), 'utf8')).toBe('# spec\n');
  });
  test('a stash interrupted before the rename leaves no plan-out and is rebuilt', async () => {
    const s = await setup();
    await planOutputs(s.repoDir);
    await mkdir(join(s.jobDir, 'plan-out.tmp'), { recursive: true });
    await writeFile(join(s.jobDir, 'plan-out.tmp', 'prd.json'), 'half written');
    const stashed = await stashPlanOutputs(s.repoDir, s.jobDir, 'f');
    expect(stashed.files).toContain('prd.json');
    expect(await readFile(join(s.jobDir, 'plan-out', 'prd.json'), 'utf8')).toBe(NEW_PRD);
    await expect(stat(join(s.jobDir, 'plan-out.tmp'))).rejects.toThrow();
  });
});

describe('commitAndPushPlan', () => {
  test('creates the branch from the ref, commits only the allowlist as the assigned identity, and pushes', async () => {
    const s = await setup();
    await planOutputs(s.repoDir);
    // No identity anywhere but the input: the commit must pass it explicitly (D69).
    await sh(s.repoDir, 'config', '--unset', 'user.name');
    await sh(s.repoDir, 'config', '--unset', 'user.email');
    const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
    const saved = keys.map((k) => [k, process.env[k]] as const);
    for (const k of keys) delete process.env[k];
    try {
      const result = await commitAndPushPlan(input(s));
      expect(result).toMatchObject({ ok: true, branch: 'feat/f', committed: true });
      const sha = (result as { sha: string }).sha;
      expect(await sh(s.origin.dir, 'rev-parse', 'feat/f')).toBe(sha);
      expect(await sh(s.origin.dir, 'log', '-1', '--format=%an <%ae>|%s', 'feat/f')).toBe(`${identity.name} <${identity.email}>|chore(plan): f PRD via koda job j1`);
    } finally {
      for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
    }
    const files = (await sh(s.origin.dir, 'ls-tree', '-r', '--name-only', 'feat/f')).split('\n').sort();
    expect(files).toEqual(['.nax/features/f/acceptance-meta.json', '.nax/features/f/prd-fidelity-report.md', '.nax/features/f/prd.json', '.nax/features/f/spec.md', 'README.md']);
    expect(await sh(s.origin.dir, 'rev-parse', 'feat/f~1')).toBe(s.refSha);
  });
  test('a tracked stale PRD at the ref is replaced by the new one', async () => {
    const s = await setup({ 'README.md': 'x', '.nax/features/f/prd.json': '{"old":true,"userStories":[{"id":"OLD"}]}' });
    await planOutputs(s.repoDir);
    const result = await commitAndPushPlan(input(s));
    expect(result).toMatchObject({ ok: true });
    expect(JSON.parse(await sh(s.origin.dir, 'show', 'feat/f:.nax/features/f/prd.json')).branchName).toBe('feat/f');
  });
  test('crash after `checkout -f -B` and before the copy-back: the retry commits the stashed PRD, not the ref\'s stale one (D61)', async () => {
    const s = await setup({ 'README.md': 'x', '.nax/features/f/prd.json': '{"old":true,"userStories":[{"id":"OLD"}]}' });
    await planOutputs(s.repoDir);
    await stashPlanOutputs(s.repoDir, s.jobDir, 'f');                       // what the first attempt did before the switch
    await sh(s.repoDir, 'checkout', '-q', '-f', '-B', 'feat/f', s.refSha);   // ... and the crash: the tracked PRD is the old one again
    expect(await readFile(join(s.repoDir, '.nax', 'features', 'f', 'prd.json'), 'utf8')).toContain('OLD');
    const result = await commitAndPushPlan(input(s));
    expect(result).toMatchObject({ ok: true, committed: true });
    const pushed = JSON.parse(await sh(s.origin.dir, 'show', 'feat/f:.nax/features/f/prd.json'));
    expect(pushed.branchName).toBe('feat/f');
    expect(pushed.userStories[0].id).toBe('US-001');
  });
  test('is idempotent, and a crash between commit and push resumes without a second commit', async () => {
    const s = await setup();
    await planOutputs(s.repoDir);
    await sh(s.repoDir, 'remote', 'set-url', 'origin', `file://${join(s.base, 'nowhere.git')}`);
    const failed = await commitAndPushPlan(input(s));
    expect(failed).toEqual({ ok: false, reason: 'plan push failed' });
    const local = await sh(s.repoDir, 'rev-parse', 'feat/f');
    expect(local).not.toBe(s.refSha);                      // the commit is kept locally
    await sh(s.repoDir, 'remote', 'set-url', 'origin', s.origin.url);
    await cleanWorkspace(g, s.repoDir);
    const again = await commitAndPushPlan(input(s));
    expect(again).toMatchObject({ ok: true, committed: false, sha: local });
    expect(await sh(s.origin.dir, 'rev-parse', 'feat/f')).toBe(local);
    expect(await commitAndPushPlan(input(s))).toMatchObject({ ok: true, committed: false, sha: local });
  });
  test('continues an existing origin branch on top of its tip (fast-forward push)', async () => {
    const s = await setup({ 'README.md': 'x' }, [{ name: 'feat/f', files: { 'older.txt': '1' } }]);
    await planOutputs(s.repoDir);
    const tip = await sh(s.origin.dir, 'rev-parse', 'feat/f');
    const result = await commitAndPushPlan(input(s));
    expect(result).toMatchObject({ ok: true, committed: true });
    expect(await sh(s.origin.dir, 'rev-parse', 'feat/f~1')).toBe(tip);
  });
  test('a diverged branch fails without pushing or discarding', async () => {
    const s = await setup({ 'README.md': 'x' }, [{ name: 'feat/f', files: { 'older.txt': '1' } }]);
    await sh(s.repoDir, 'checkout', '-q', '-B', 'feat/f', 'origin/feat/f');
    await sh(s.repoDir, 'commit', '-q', '--allow-empty', '-m', 'local only');
    const local = await sh(s.repoDir, 'rev-parse', 'HEAD');
    await pushCommit(s.base, s.origin.url, 'feat/f', 'other.txt', '2');
    await cleanWorkspace(g, s.repoDir);
    await sh(s.repoDir, 'checkout', '-q', '--detach', s.refSha);
    await planOutputs(s.repoDir);
    expect(await commitAndPushPlan(input(s))).toEqual({ ok: false, reason: 'checkout: branch diverged' });
    expect(await sh(s.repoDir, 'rev-parse', 'feat/f')).toBe(local);
  });
  test.each(['main', 'master', '-x', 'a..b', '@{-1}'])('refuses the branch name %s', async (branchName) => {
    const s = await setup();
    await planOutputs(s.repoDir);
    expect(await commitAndPushPlan(input(s, { branchName }))).toEqual({ ok: false, reason: 'checkout: invalid branchName' });
  });
  test('no PRD in the feature directory is a fixed failure', async () => {
    const s = await setup();
    expect(await commitAndPushPlan(input(s))).toEqual({ ok: false, reason: 'plan output missing' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/runner && bun test test/unit/plan-commit.spec.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`executor/plan-commit.ts`:

```ts
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitIdentity } from '@nathapp/fleet-protocol';
import { featureDirFor } from '../paths/safe-segment';
import { checkoutArgs, planBranch, validateBranchName } from './branch';
import { NO_CREDENTIALS_REASON, isAuthFailure, type Git, GitError } from './git';

/** Design §2 step 8: never `plan/`, `sessions/` or `prd.rejected.json`. */
export const PLAN_ALLOWLIST = ['prd.json', 'spec.md', 'prd-fidelity-report.md', 'acceptance-meta.json'] as const;

async function present(dir: string, names: readonly string[]): Promise<string[]> {
  const have = new Set(await readdir(dir).catch(() => [] as string[]));
  return names.filter((name) => have.has(name));
}

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

/**
 * Copies the plan outputs out of the checkout so a branch switch cannot lose them (and the bundle can carry the logs).
 * Write-once (D61): the first stash is the source of truth. `checkout -f -B` overwrites a tracked stale `prd.json` in the
 * working tree, so a retry after a crash in that window must never read the checkout again. The stash is built in `.tmp`
 * siblings and renamed into place, `plan-out` last, so its existence means the stash is complete. A new attempt starts
 * from a wiped job directory (D53), which is what makes "once" safe.
 */
export async function stashPlanOutputs(repoDir: string, jobDir: string, feature: string): Promise<{ files: string[]; logs: string[] }> {
  const outDir = join(jobDir, 'plan-out');
  const logsDir = join(jobDir, 'plan-logs');
  if (await exists(outDir)) {
    return { files: await present(outDir, PLAN_ALLOWLIST), logs: (await readdir(logsDir).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl')) };
  }
  const dir = featureDirFor(repoDir, feature);
  const files = await present(dir, PLAN_ALLOWLIST);
  const logs = (await readdir(join(dir, 'plan')).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl'));
  if (files.length === 0 && logs.length === 0) return { files: [], logs: [] };
  const [outTmp, logsTmp] = [`${outDir}.tmp`, `${logsDir}.tmp`];
  await rm(outTmp, { recursive: true, force: true });
  await rm(logsTmp, { recursive: true, force: true });
  await mkdir(outTmp, { recursive: true });
  await mkdir(logsTmp, { recursive: true });
  for (const name of files) await copyFile(join(dir, name), join(outTmp, name));
  for (const name of logs) await copyFile(join(dir, 'plan', name), join(logsTmp, name));
  await rm(logsDir, { recursive: true, force: true });
  await rename(logsTmp, logsDir);
  await rename(outTmp, outDir);
  return { files, logs };
}

export interface PlanPushInput {
  readonly git: Git;
  readonly repoDir: string;
  readonly jobDir: string;
  readonly feature: string;
  readonly jobId: string;
  readonly branchName: string;
  readonly refSha: string;
  readonly defaultBranch: string;
  readonly identity: GitIdentity;
}

export type PlanPushResult = { ok: true; branch: string; sha: string; committed: boolean } | { ok: false; reason: string };

async function commitStep(input: PlanPushInput, files: readonly string[]): Promise<{ failure: string } | { committed: boolean }> {
  const { git, repoDir, feature, branchName, refSha } = input;
  const action = await planBranch(git, repoDir, branchName);
  const args = checkoutArgs(action, branchName, refSha, true);
  if (!args) return { failure: 'checkout: branch diverged' };
  await git.ok(args, { cwd: repoDir });
  const dir = featureDirFor(repoDir, feature);
  await mkdir(dir, { recursive: true });
  for (const name of files) await copyFile(join(input.jobDir, 'plan-out', name), join(dir, name));
  await git.ok(['add', '--', ...files.map((name) => `.nax/features/${feature}/${name}`)], { cwd: repoDir });
  const staged = await git.run(['diff', '--cached', '--quiet'], { cwd: repoDir });
  if (staged.code === 0) return { committed: false };
  if (staged.code !== 1) throw new GitError(['diff'], staged);
  const message = `chore(plan): ${feature} PRD via koda job ${input.jobId}`;
  // D69: the identity is passed explicitly, so a missing or different repo config cannot fail or alter the commit.
  const commit = ['-c', `user.name=${input.identity.name}`, '-c', `user.email=${input.identity.email}`, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', message];
  await git.ok(commit, { cwd: repoDir });
  return { committed: true };
}

/**
 * Design §2 step 8 (R-3.4): the plan outputs go onto the PRD's `branchName` (checked out by the step 4 rules with
 * `checkout -f`), are committed as the assigned identity and pushed. Safe to run again after a crash (D52).
 */
export async function commitAndPushPlan(input: PlanPushInput): Promise<PlanPushResult> {
  const { git, repoDir, branchName } = input;
  if (!(await validateBranchName(git, repoDir, branchName, input.defaultBranch))) return { ok: false, reason: 'checkout: invalid branchName' };
  const { files } = await stashPlanOutputs(input.repoDir, input.jobDir, input.feature);   // write-once: a retry reads the first stash
  if (!files.includes('prd.json')) return { ok: false, reason: 'plan output missing' };
  let committed = false;
  try {
    const step = await commitStep(input, files);
    if ('failure' in step) return { ok: false, reason: step.failure };
    committed = step.committed;
  } catch {
    return { ok: false, reason: 'plan commit failed' };
  }
  const push = await git.run(['push', '--set-upstream', 'origin', branchName], { cwd: repoDir });
  if (push.code !== 0) return { ok: false, reason: isAuthFailure(push.stderr) ? NO_CREDENTIALS_REASON : 'plan push failed' };
  const sha = (await git.ok(['rev-parse', 'HEAD'], { cwd: repoDir })).trim();
  return { ok: true, branch: branchName, sha, committed };
}
```

- [ ] **Step 4: Run and lint**

```bash
cd apps/runner && bun test test/unit/plan-commit.spec.ts && bun run type-check && bun run lint
```
Expected: PASS (all tests), clean.

- [ ] **Step 5: Commit**

```bash
git add apps/runner
git commit -m "feat(fleet): runner PLAN commit and push (R-3.4): allowlisted files, idempotent resume, safe branch rules"
```

---

### Task 17: Bundle — build and upload (design §2 step 9)

**Files:**
- Modify: `apps/runner/src/sync/http.ts`, `http.spec.ts` (3a-1 Task 9): `uploadBundle` also returns the response's `message`
- Create: `apps/runner/src/bundle/build-bundle.ts`, `build-bundle.spec.ts`
- Create: `apps/runner/src/bundle/upload-bundle.ts`, `upload-bundle.spec.ts`

**Interfaces:**
- Consumes: `ServerClient.uploadBundle`, `NetworkError` (3a-1 Task 9), `Sleep`, `Logger`, `errorMessage`.
- Produces:
  ```ts
  // sync/http.ts (changed): uploadBundle(args): Promise<{ status: number; message?: string }>   // message = the JSON body's `message` on a non-2xx; sends `accept-language: en` (D60)
  // build-bundle.ts
  export interface BundleFile { readonly path: string; readonly size: number; readonly sha256: string; readonly skipped?: readonly string[] }   // skipped: unsafe names left out (D68)
  export function collectBundleEntries(jobDir: string, command: FleetJobKindName): Promise<{ entries: string[]; skipped: string[] }>;
  export function listBundleEntries(jobDir: string, command: FleetJobKindName): Promise<string[]>;   // collectBundleEntries().entries: relative posix paths, sorted; no prompt-audit segment; symlinks listed, never followed; no name with a newline or backslash
  export function sha256File(path: string): Promise<string>;                                        // streamed, lowercase hex
  export function isBenignTarExit(code: number, stderr: string): boolean;                           // GNU tar exit 1 with only "file changed as we read it" lines
  export function buildBundle(input: { jobDir: string; command: FleetJobKindName }): Promise<BundleFile>;   // <jobDir>/bundle.tar.gz via system tar and a list file; includes bundle-manifest.json
  // upload-bundle.ts
  export type UploadOutcome =
    | { kind: 'ok' } | { kind: 'too-large' }
    | { kind: 'stale' }                                   // 409, the runner does not hold the lease: park for ABANDON (D49)
    | { kind: 'state-conflict'; detail: string }          // 409, the job is not RUNNING/UPLOADING at this epoch (D60)
    | { kind: 'failed'; detail: string };
  export interface UploadDeps { upload(args: { jobId: string; leaseEpoch: number; file: BundleFile }): Promise<{ status: number; message?: string }>; rebuild(): Promise<BundleFile>; sleep: Sleep; log: Logger }
  export const UPLOAD_ATTEMPTS = 3;
  export const LARGE_BUNDLE_BYTES = 100 * 1024 * 1024;
  export function classifyConflict(message: string | undefined): 'stale' | 'state-conflict';
  export function uploadWithRetry(deps: UploadDeps, jobId: string, leaseEpoch: number, file: BundleFile): Promise<UploadOutcome>;
  ```
  Contents (D27): `nax-out/**` minus any path segment `prompt-audit`; `nax.stdout`, `nax.stderr` when present; for PLAN `plan-logs/*.jsonl`; and a `bundle-manifest.json` `{ version: 1, command, entries, skipped }`. A name containing a newline or a backslash cannot be written to the line-based `-T` list: it is left out and reported in `skipped` (D68; `JobRun` turns that into a lifecycle warning, Task 20). Upload rules (design §2 step 9, D60, D68): 2xx ok; 413 too large, no retry; 409 is classified by the response message, never retried here: `stale` (message says the runner does not hold the lease; also any unrecognised 409) or `state-conflict` (message `The job is <STATE>; ...`); 422 rebuilds the archive once and retries without using an attempt; network errors and 5xx retry up to three attempts with backoff `[1000, 3000]` ms; three network failures on an archive over `LARGE_BUNDLE_BYTES` end as `too-large` (a proxy that silently drops a big body); other 4xx fail at once.

- [ ] **Step 0: `uploadBundle` returns the error message**

The server answers 409 for two causes whose only difference is the message (`bundle.service.ts`: `FleetFenceException` -> `This runner does not hold the job's current lease`; `ConflictAppException` `fleet.jobState` -> `The job is RUNNING; this action is not allowed`). In `sync/http.spec.ts`, extend the `uploadBundle` describe (3a-1 Task 9) with a failing test first:

```ts
  test('returns the error message of a non-2xx JSON body, and asks for English (D60)', async () => {
    const file = join(await tmp.make('up'), 'b.tgz');
    await writeFile(file, 'x');
    let language: string | null = null;
    const c = client(async (_url, init) => {
      language = new Headers(init?.headers).get('accept-language');
      return new Response(JSON.stringify({ ret: 409, message: 'The job is ASSIGNED; this action is not allowed' }), { status: 409 });
    });
    expect(await c.uploadBundle({ jobId: 'j', leaseEpoch: 1, filePath: file, sha256: 'b'.repeat(64) })).toEqual({ status: 409, message: 'The job is ASSIGNED; this action is not allowed' });
    expect(language).toBe('en');
    expect(await client(async () => new Response('not json', { status: 502 })).uploadBundle({ jobId: 'j', leaseEpoch: 1, filePath: file, sha256: 'b'.repeat(64) })).toEqual({ status: 502 });
  });
```

Then in `sync/http.ts` replace the `uploadBundle` method (the existing 201/413 tests keep passing: `toEqual` ignores an `undefined` `message`):

```ts
  async uploadBundle(args: { jobId: string; leaseEpoch: number; filePath: string; sha256: string; signal?: AbortSignal }): Promise<{ status: number; message?: string }> {
    const url = `${this.url(`/fleet/runner/jobs/${encodeURIComponent(args.jobId)}/bundle`)}?leaseEpoch=${args.leaseEpoch}`;
    const headers = { ...this.bearer(), 'content-type': 'application/gzip', 'x-content-sha256': args.sha256, 'accept-language': 'en' };
    const response = await this.send(url, { method: 'PUT', headers, body: Bun.file(args.filePath) }, UPLOAD_TIMEOUT_MS, args.signal);
    const text = await response.text().catch(() => '');
    if (response.ok) return { status: response.status };
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const message = messageOf(body);
    return message === null ? { status: response.status } : { status: response.status, message };
  }
```
Run: `cd apps/runner && bun test src/sync/http.spec.ts` (expected PASS), then continue.

- [ ] **Step 1: Write the failing specs**

`bundle/build-bundle.spec.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { buildBundle, collectBundleEntries, isBenignTarExit, listBundleEntries, sha256File } from './build-bundle';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

async function jobDirWith(): Promise<string> {
  const jobDir = await tmp.make('bundle');
  const out = join(jobDir, 'nax-out');
  await mkdir(join(out, 'features', 'feat', 'runs'), { recursive: true });
  await mkdir(join(out, 'prompt-audit', 'feat'), { recursive: true });
  await mkdir(join(out, 'features', 'feat', 'prompt-audit'), { recursive: true });
  await mkdir(join(out, 'cost'), { recursive: true });
  await mkdir(join(jobDir, 'plan-logs'), { recursive: true });
  await writeFile(join(out, 'status.json'), '{"run":{}}');
  await writeFile(join(out, 'metrics.json'), '{}');
  await writeFile(join(out, 'cost', 'cost-1.jsonl'), '{}\n');
  await writeFile(join(out, 'features', 'feat', 'runs', 'log-1.jsonl'), '{}\n');
  await symlink('log-1.jsonl', join(out, 'features', 'feat', 'runs', 'latest.jsonl'));
  await writeFile(join(out, 'file with spaces.txt'), 'x');
  await writeFile(join(out, 'prompt-audit', 'feat', 'p.json'), 'SECRET PROMPT');
  await writeFile(join(out, 'features', 'feat', 'prompt-audit', 'q.json'), 'SECRET PROMPT 2');
  await writeFile(join(jobDir, 'nax.stdout'), 'out');
  await writeFile(join(jobDir, 'nax.stderr'), 'err');
  await writeFile(join(jobDir, 'plan-logs', 'plan-1.jsonl'), '{"m":1}\n');
  await writeFile(join(jobDir, 'plan-logs', 'ignore.txt'), 'not a jsonl');
  return jobDir;
}
async function tarList(path: string): Promise<string[]> {
  const proc = Bun.spawn(['tar', '-tzf', path], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split('\n').filter(Boolean).sort();
}

describe('listBundleEntries (D27)', () => {
  test('RUN: nax-out minus prompt-audit at any depth, plus stdout and stderr; sorted, relative', async () => {
    const entries = await listBundleEntries(await jobDirWith(), 'RUN');
    expect(entries).toEqual([
      'nax-out/cost/cost-1.jsonl', 'nax-out/features/feat/runs/latest.jsonl', 'nax-out/features/feat/runs/log-1.jsonl',
      'nax-out/file with spaces.txt', 'nax-out/metrics.json', 'nax-out/status.json', 'nax.stderr', 'nax.stdout',
    ]);
  });
  test('PLAN adds the plan logs, jsonl only', async () => {
    const entries = await listBundleEntries(await jobDirWith(), 'PLAN');
    expect(entries).toContain('plan-logs/plan-1.jsonl');
    expect(entries).not.toContain('plan-logs/ignore.txt');
    expect(await listBundleEntries(await jobDirWith(), 'RUN')).not.toContain('plan-logs/plan-1.jsonl');
  });
  test('missing pieces are simply absent', async () => {
    expect(await listBundleEntries(await tmp.make('empty'), 'RUN')).toEqual([]);
  });
  test('a name with a newline or a backslash cannot go in the -T list: it is skipped and reported (D68)', async () => {
    const jobDir = await jobDirWith();
    await writeFile(join(jobDir, 'nax-out', 'two\nlines.txt'), 'x');
    await writeFile(join(jobDir, 'nax-out', 'back\\slash.txt'), 'x');
    const { entries, skipped } = await collectBundleEntries(jobDir, 'RUN');
    expect(skipped).toEqual(['nax-out/back\\slash.txt', 'nax-out/two\nlines.txt']);
    expect(entries.some((name) => name.includes('\n') || name.includes('\\'))).toBe(false);
    expect(entries).toContain('nax-out/file with spaces.txt');
    const file = await buildBundle({ jobDir, command: 'RUN' });
    expect(file.skipped).toEqual(skipped);
    expect((await tarList(file.path)).some((name) => name.includes('slash'))).toBe(false);
    expect(JSON.parse(await readFile(join(jobDir, 'bundle-manifest.json'), 'utf8')).skipped).toEqual(skipped);
  });
});

describe('isBenignTarExit (D68)', () => {
  test('accepts exit 0, and exit 1 only when tar merely saw a file change under it', () => {
    expect(isBenignTarExit(0, '')).toBe(true);
    expect(isBenignTarExit(1, 'tar: nax-out/features/f/runs/log-1.jsonl: file changed as we read it\n')).toBe(true);
    expect(isBenignTarExit(1, 'tar: a: file changed as we read it\ntar: b: file changed as we read it\n')).toBe(true);
  });
  test('refuses every other failure, including exit 1 with a real error and any higher exit code', () => {
    expect(isBenignTarExit(1, 'tar: nax-out/x: Cannot stat: No such file or directory\n')).toBe(false);
    expect(isBenignTarExit(1, 'tar: a: file changed as we read it\ntar: b: Cannot open: Permission denied\n')).toBe(false);
    expect(isBenignTarExit(1, '')).toBe(false);
    expect(isBenignTarExit(2, 'tar: a: file changed as we read it\n')).toBe(false);
  });
});

describe('buildBundle', () => {
  test('writes a tar.gz with the listed files, a manifest, the symlink as a link, and a matching size and sha256', async () => {
    const jobDir = await jobDirWith();
    const file = await buildBundle({ jobDir, command: 'PLAN' });
    expect(file.path).toBe(join(jobDir, 'bundle.tar.gz'));
    expect(file.size).toBe((await stat(file.path)).size);
    expect(file.sha256).toBe(createHash('sha256').update(await readFile(file.path)).digest('hex'));
    const names = await tarList(file.path);
    expect(names).toContain('bundle-manifest.json');
    expect(names).toContain('nax-out/status.json');
    expect(names).toContain('plan-logs/plan-1.jsonl');
    expect(names.some((n) => n.includes('prompt-audit'))).toBe(false);
    const verbose = Bun.spawn(['tar', '-tvzf', file.path], { stdout: 'pipe' });
    expect(await new Response(verbose.stdout).text()).toMatch(/latest\.jsonl -> log-1\.jsonl/);
    const manifest = JSON.parse(await readFile(join(jobDir, 'bundle-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ version: 1, command: 'PLAN' });
    expect(manifest.entries).toContain('nax.stdout');
  });
  test('an otherwise empty job dir still produces a valid archive (the manifest)', async () => {
    const file = await buildBundle({ jobDir: await tmp.make('empty'), command: 'RUN' });
    expect(await tarList(file.path)).toEqual(['bundle-manifest.json']);
  });
  test('rebuilding replaces the previous archive', async () => {
    const jobDir = await jobDirWith();
    const first = await buildBundle({ jobDir, command: 'RUN' });
    await writeFile(join(jobDir, 'nax-out', 'extra.txt'), 'later');
    const second = await buildBundle({ jobDir, command: 'RUN' });
    expect(second.path).toBe(first.path);
    expect(second.sha256).not.toBe(first.sha256);
    expect(await tarList(second.path)).toContain('nax-out/extra.txt');
  });
  test('sha256File streams a file', async () => {
    const path = join(await tmp.make('sha'), 'f');
    await writeFile(path, 'hello');
    expect(await sha256File(path)).toBe(createHash('sha256').update('hello').digest('hex'));
  });
});
```

`bundle/upload-bundle.spec.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test';
import { createMemoryLogger } from '../logger';
import { NetworkError } from '../sync/http';
import type { BundleFile } from './build-bundle';
import { LARGE_BUNDLE_BYTES, classifyConflict, uploadWithRetry, type UploadDeps } from './upload-bundle';

const file = (sha: string): BundleFile => ({ path: `/j/${sha}.tar.gz`, size: 10, sha256: sha });
type Step = number | Error | { status: number; message: string };
const BIG = 200 * 1024 * 1024;
let script: Step[];
let uploads: BundleFile[];
let rebuilds: number;
let sleeps: number[];
const deps = (): UploadDeps => ({
  upload: async ({ file: f }) => {
    uploads.push(f);
    const step = script.shift();
    if (step === undefined) throw new Error('script exhausted');
    if (step instanceof Error) throw step;
    return typeof step === 'number' ? { status: step } : step;
  },
  rebuild: async () => { rebuilds += 1; return file(`rebuilt${rebuilds}`); },
  sleep: async (ms) => { sleeps.push(ms); },
  log: createMemoryLogger(),
});
beforeEach(() => { script = []; uploads = []; rebuilds = 0; sleeps = []; });

describe('uploadWithRetry (design §2 step 9)', () => {
  test('201 is ok on the first attempt', async () => {
    script.push(201);
    expect(await uploadWithRetry(deps(), 'j', 3, file('a'))).toEqual({ kind: 'ok' });
    expect(sleeps).toEqual([]);
  });
  test('network errors and 5xx retry with backoff, three attempts in all', async () => {
    script.push(new NetworkError('reset'), 503, 201);
    expect(await uploadWithRetry(deps(), 'j', 3, file('a'))).toEqual({ kind: 'ok' });
    expect(sleeps).toEqual([1000, 3000]);
    script.push(500, 500, 500);
    expect((await uploadWithRetry(deps(), 'j', 3, file('a'))).kind).toBe('failed');
    expect(uploads).toHaveLength(6);
  });
  test('413 is too-large and is not retried', async () => {
    script.push(413);
    expect(await uploadWithRetry(deps(), 'j', 3, file('a'))).toEqual({ kind: 'too-large' });
    expect(uploads).toHaveLength(1);
  });
  test('a 409 is classified by its message and never retried (D60): lease lost is stale, a wrong job state is a state-conflict', async () => {
    script.push({ status: 409, message: "This runner does not hold the job's current lease" });
    expect(await uploadWithRetry(deps(), 'j', 3, file('a'))).toEqual({ kind: 'stale' });
    script.push({ status: 409, message: 'The job is ASSIGNED; this action is not allowed' });
    expect(await uploadWithRetry(deps(), 'j', 3, file('a'))).toEqual({ kind: 'state-conflict', detail: 'The job is ASSIGNED; this action is not allowed' });
    script.push({ status: 409, message: 'The job is COMPLETED; this action is not allowed' });
    expect((await uploadWithRetry(deps(), 'j', 3, file('a'))).kind).toBe('state-conflict');
    expect(uploads).toHaveLength(3);
    expect(sleeps).toEqual([]);
  });
  test('a 409 with no or an unrecognised message is stale: park and wait for ABANDON, the safe default', async () => {
    script.push(409);
    expect(await uploadWithRetry(deps(), 'j', 3, file('a'))).toEqual({ kind: 'stale' });
    script.push({ status: 409, message: 'Something else entirely' });
    expect(await uploadWithRetry(deps(), 'j', 3, file('a'))).toEqual({ kind: 'stale' });
    expect(classifyConflict(undefined)).toBe('stale');
    expect(classifyConflict('The job is RUNNING; this action is not allowed')).toBe('state-conflict');
  });
  test('three network failures on a bundle over 100 MiB are too-large; on a small bundle, or with 5xx, they are a failed upload (D68)', async () => {
    script.push(new NetworkError('reset'), new NetworkError('reset'), new NetworkError('reset'));
    expect(await uploadWithRetry(deps(), 'j', 3, { ...file('big'), size: BIG })).toEqual({ kind: 'too-large' });
    expect(BIG).toBeGreaterThan(LARGE_BUNDLE_BYTES);
    script.push(new NetworkError('reset'), new NetworkError('reset'), new NetworkError('reset'));
    expect((await uploadWithRetry(deps(), 'j', 3, file('small'))).kind).toBe('failed');
    script.push(500, 500, 500);
    expect((await uploadWithRetry(deps(), 'j', 3, { ...file('big'), size: BIG })).kind).toBe('failed');
    script.push(new NetworkError('reset'), 503, new NetworkError('reset'));
    expect((await uploadWithRetry(deps(), 'j', 3, { ...file('big'), size: BIG })).kind).toBe('failed');
  });
  test('422 rebuilds the archive once and retries it without spending an attempt; a second 422 fails', async () => {
    script.push(422, 500, 201);
    expect(await uploadWithRetry(deps(), 'j', 3, file('a'))).toEqual({ kind: 'ok' });
    expect(rebuilds).toBe(1);
    expect(uploads.map((u) => u.sha256)).toEqual(['a', 'rebuilt1', 'rebuilt1']);
    script.push(422, 422);
    rebuilds = 0;
    expect((await uploadWithRetry(deps(), 'j', 3, file('a'))).kind).toBe('failed');
    expect(rebuilds).toBe(1);
  });
  test.each([400, 401, 403, 415])('%d fails at once with the status', async (status) => {
    script.push(status);
    expect(await uploadWithRetry(deps(), 'j', 3, file('a'))).toEqual({ kind: 'failed', detail: `HTTP ${status}` });
    expect(uploads).toHaveLength(1);
  });
  test('a rebuild that throws fails the upload, not the daemon', async () => {
    script.push(422);
    const d = { ...deps(), rebuild: async () => { throw new Error('disk full'); } };
    expect(await uploadWithRetry(d, 'j', 3, file('a'))).toEqual({ kind: 'failed', detail: 'rebuild failed: disk full' });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/runner && bun test src/bundle`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`bundle/build-bundle.ts`:

```ts
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { FleetJobKindName } from '@nathapp/fleet-protocol';

export interface BundleFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  /** Names left out of the archive because the list file cannot express them (D68). */
  readonly skipped?: readonly string[];
}

const isPromptAudit = (name: string): boolean => name === 'prompt-audit';

/** Files and symlinks under `dir`, never following links, skipping any `prompt-audit` directory or file. */
async function walk(dir: string, prefix: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(join(dir), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (isPromptAudit(entry.name)) continue;
    const rel = posix.join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(join(dir, entry.name), rel)));
    else found.push(rel);
  }
  return found;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** The `-T` list is one name per line and GNU tar reads backslash escapes in it (D68): such names are left out. */
const isListSafe = (name: string): boolean => !/[\n\r\\]/.test(name);

/** D27: nax-out minus prompt-audit, stdout and stderr, and for PLAN the plan logs. Sorted; unsafe names reported (D68). */
export async function collectBundleEntries(jobDir: string, command: FleetJobKindName): Promise<{ entries: string[]; skipped: string[] }> {
  const all = await walk(join(jobDir, 'nax-out'), 'nax-out');
  for (const name of ['nax.stdout', 'nax.stderr']) if (await exists(join(jobDir, name))) all.push(name);
  if (command === 'PLAN') {
    const logs = (await readdir(join(jobDir, 'plan-logs')).catch(() => [] as string[])).filter((n) => n.endsWith('.jsonl'));
    all.push(...logs.map((n) => `plan-logs/${n}`));
  }
  return { entries: all.filter(isListSafe).sort(), skipped: all.filter((name) => !isListSafe(name)).sort() };
}

export async function listBundleEntries(jobDir: string, command: FleetJobKindName): Promise<string[]> {
  return (await collectBundleEntries(jobDir, command)).entries;
}

/**
 * D68: GNU tar exits 1 with `file changed as we read it` when a live writer (a nax still flushing a log) touches a file
 * mid-read; the archive is complete. Anything else on exit 1, and every higher code, is a real failure.
 */
export function isBenignTarExit(code: number, stderr: string): boolean {
  if (code === 0) return true;
  const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
  return code === 1 && lines.length > 0 && lines.every((line) => /: file changed as we read it$/.test(line));
}

export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest('hex');
}

/** System `tar -czf out -C <jobDir> -T <list>`: bsdtar and GNU tar both accept it; nothing is held in memory. */
export async function buildBundle(input: { jobDir: string; command: FleetJobKindName }): Promise<BundleFile> {
  const { jobDir } = input;
  await mkdir(jobDir, { recursive: true });
  const { entries, skipped } = await collectBundleEntries(jobDir, input.command);
  await writeFile(join(jobDir, 'bundle-manifest.json'), `${JSON.stringify({ version: 1, command: input.command, entries, skipped }, null, 2)}\n`);
  const listPath = join(jobDir, 'bundle.list');
  await writeFile(listPath, `${['bundle-manifest.json', ...entries].join('\n')}\n`);
  const out = join(jobDir, 'bundle.tar.gz');
  const tmp = `${out}.tmp`;
  const proc = Bun.spawn(['tar', '-czf', tmp, '-C', jobDir, '-T', listPath], {
    stdout: 'ignore', stderr: 'pipe', stdin: 'ignore', env: { ...process.env, COPYFILE_DISABLE: '1', LC_ALL: 'C' },
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (!isBenignTarExit(code, stderr) || (code !== 0 && !(await exists(tmp)))) throw new Error(`tar failed (${code}): ${stderr.trim().slice(0, 200)}`);
  await rename(tmp, out);
  return { path: out, size: (await stat(out)).size, sha256: await sha256File(out), skipped };
}
```

`bundle/upload-bundle.ts`:

```ts
import { errorMessage } from '../errors';
import type { Logger } from '../logger';
import { NetworkError } from '../sync/http';
import type { Sleep } from '../time';
import type { BundleFile } from './build-bundle';

export type UploadOutcome =
  | { kind: 'ok' }
  | { kind: 'too-large' }
  | { kind: 'stale' }
  | { kind: 'state-conflict'; detail: string }
  | { kind: 'failed'; detail: string };

export interface UploadDeps {
  upload(args: { jobId: string; leaseEpoch: number; file: BundleFile }): Promise<{ status: number; message?: string }>;
  rebuild(): Promise<BundleFile>;
  readonly sleep: Sleep;
  readonly log: Logger;
}

export const UPLOAD_ATTEMPTS = 3;
export const LARGE_BUNDLE_BYTES = 100 * 1024 * 1024;
const BACKOFF_MS = [1_000, 3_000];
const JOB_STATE_MESSAGE = /^The job is \S+; this action is not allowed/i;

/**
 * D60: the server answers 409 for a lost lease (`fleet.fence`, ABANDON queued) and for a job that is not RUNNING or
 * UPLOADING at this epoch (`fleet.jobState`, no ABANDON). Only the translated message tells them apart (the runner asks
 * for English); anything unrecognised is `stale`, the safe reading (park until the server says ABANDON).
 */
export function classifyConflict(message: string | undefined): 'stale' | 'state-conflict' {
  return message !== undefined && JOB_STATE_MESSAGE.test(message) ? 'state-conflict' : 'stale';
}

/** Design §2 step 9; the outcome decides the terminal state (D36, D60, D68). */
export async function uploadWithRetry(deps: UploadDeps, jobId: string, leaseEpoch: number, first: BundleFile): Promise<UploadOutcome> {
  let file = first;
  let rebuilt = false;
  let attempt = 1;
  let networkFailures = 0;
  for (;;) {
    let status = 0;
    let message: string | undefined;
    try {
      ({ status, message } = await deps.upload({ jobId, leaseEpoch, file }));
    } catch (error) {
      if (!(error instanceof NetworkError)) return { kind: 'failed', detail: errorMessage(error) };
      networkFailures += 1;
    }
    if (status >= 200 && status < 300) return { kind: 'ok' };
    if (status === 413) return { kind: 'too-large' };
    if (status === 409) {
      return classifyConflict(message) === 'stale' ? { kind: 'stale' } : { kind: 'state-conflict', detail: message ?? 'job state conflict' };
    }
    if (status === 422) {
      if (rebuilt) return { kind: 'failed', detail: 'HTTP 422' };
      rebuilt = true;
      try {
        file = await deps.rebuild();
      } catch (error) {
        return { kind: 'failed', detail: `rebuild failed: ${errorMessage(error)}` };
      }
      continue;
    }
    if (status !== 0 && status < 500) return { kind: 'failed', detail: `HTTP ${status}` };
    deps.log.warn('bundle upload attempt failed', { jobId, attempt, status });
    if (attempt >= UPLOAD_ATTEMPTS) {
      if (networkFailures >= UPLOAD_ATTEMPTS && file.size > LARGE_BUNDLE_BYTES) return { kind: 'too-large' };
      return { kind: 'failed', detail: status === 0 ? 'network error' : `HTTP ${status}` };
    }
    await deps.sleep(BACKOFF_MS[attempt - 1] ?? 3_000);
    attempt += 1;
  }
}
```

- [ ] **Step 4: Run and lint**

```bash
cd apps/runner && bun test src/bundle && bun run type-check && bun run lint
```
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/runner
git commit -m "feat(fleet): runner bundle (system tar from a file list, prompt-audit excluded) and upload retry rules"
```

---

### Task 18: The executor seam and `HostExecutor`

**Files:**
- Create: `apps/runner/src/executor/job-executor.ts`
- Create: `apps/runner/src/executor/host-executor.ts`
- Create: `apps/runner/test/unit/host-executor.spec.ts`

**Interfaces:**
- Consumes: everything in Tasks 6-17.
- Produces:
  ```ts
  // job-executor.ts
  export type PrepareOutcome = { ok: true; branch: string | null } | { ok: false; reason: string; cancelled?: true };   // cancelled: honoured at a step boundary (D66)
  export interface PrepareOptions { readonly isCancelled?: () => boolean }
  export interface SpawnHandle { readonly pid: number; readonly pgid: number }
  export interface WatchOptions { readonly startAtEnd: boolean; readonly onRunIds?: (ids: { naxRunId: string; logPath: string | null }) => void }
  export interface JobWatcher { tick(final?: boolean): Promise<void> }
  export type PlanPushOutcome = { ok: true; branch: string; sha: string } | { ok: false; reason: string };
  export interface JobExecutor {
    prepare(job: JobRow, options?: PrepareOptions): Promise<PrepareOutcome>;   // steps 1-5, D53 wipes the previous attempt's files; `isCancelled` is polled between steps (D66)
    spawn(job: JobRow): Promise<SpawnHandle>;                            // step 6
    isAlive(pid: number): boolean;
    matchesProcess(job: JobRow): Promise<boolean>;                       // is the journaled pid still this job's nax (argv carries koda-job-<jobId>)
    kill(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
    reap(job: JobRow, since: Date): Promise<void>;                       // .nax-pids
    createWatcher(job: JobRow, sink: WatcherSink, options: WatchOptions): JobWatcher;
    readStatus(job: JobRow): Promise<StatusView | null>;
    readPlan(job: JobRow): Promise<PlanCheck>;
    finishPlan(job: JobRow): Promise<PlanPushOutcome>;                   // step 8
    readFinishLedger(job: JobRow): Promise<{ branch: string; headSha: string } | null>;
    collectBundle(job: JobRow): Promise<BundleFile>;                     // step 9 (build)
    cleanup(job: JobRow): Promise<void>;                                 // step 10 (delete the job profile)
  }
  // host-executor.ts
  export interface HostExecutorDeps { readonly config: Pick<RunnerConfig, 'workspaceRoot' | 'naxCommand' | 'naxHome'>; readonly git: Git; readonly log: Logger; readonly nowMs: () => number }
  export class HostExecutor implements JobExecutor { constructor(deps: HostExecutorDeps) }
  ```
  `JobRow.jobDir` must lie inside `<workspaceRoot>/.jobs`; the repo directory is `repoDirFor(workspaceRoot, owner, name)`; the output directory is `<jobDir>/nax-out`; `nax.stdout` and `nax.stderr` sit in `<jobDir>`. `prepare` also moves the feature's `prd.json` and `prd.rejected.json` to `<jobDir>/pre-plan/` for a PLAN (so a stale file cannot pass the verdict) **and deletes `plan/*.jsonl` under the feature directory (D62)**: `plan/` is gitignored, so `git clean -ffd` keeps a previous attempt's plan logs and they would be bundled as this attempt's. `prepare` polls `options.isCancelled` before it writes anything and after each of clone, clean, checkout (D66): a cancel during prepare ends at the next boundary with `{ ok: false, reason: 'cancelled', cancelled: true }`, before the job profile is written. `readPlan` reads `<jobDir>/plan-out/prd.json` when the write-once stash exists (D61), else the checkout: after a crash following `checkout -f -B` the checkout holds the ref's stale PRD, and `finishPlan` must use the stashed one. `finishPlan` passes `job.assign.gitIdentity` to the commit (D69). D53: a requeued job (same `jobId`, new epoch) reuses `<jobDir>`, so `prepare` first deletes `nax-out`, `nax.stdout`, `nax.stderr`, `pre-plan`, `plan-out`, `plan-out.tmp`, `plan-logs`, `plan-logs.tmp`, `bundle.tar.gz`, `bundle.list` and `bundle-manifest.json` (R-3.5: retries lose nax's local history).

- [ ] **Step 1: Write the failing spec**

`test/unit/host-executor.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssignPayload } from '@nathapp/fleet-protocol';
import { HostExecutor } from '../../src/executor/host-executor';
import { createGit } from '../../src/executor/git';
import { jobProfilePath } from '../../src/executor/job-profile';
import { isProcessAlive } from '../../src/executor/nax-process';
import { Journal } from '../../src/journal/journal';
import type { JobRow } from '../../src/journal/types';
import { createMemoryLogger } from '../../src/logger';
import { jobDirFor } from '../../src/paths/safe-segment';
import { runVerdict } from '../../src/verdict/run-verdict';
import { git as sh, isolateGit, makeOrigin } from '../helpers/git-fixture';
import { makeTempDirs } from '../helpers/tmp';
import { waitFor } from '../helpers/wait';

const tmp = makeTempDirs();
const FAKE = join(import.meta.dir, '..', 'fixtures', 'fake-nax.ts');
const PRD = JSON.stringify({ branchName: 'feat/feat', userStories: [{ id: 'OLD-1' }] });
beforeAll(() => { isolateGit(); process.env['FAKE_NAX_STEP_MS'] = '10'; });
afterAll(() => { delete process.env['FAKE_NAX_STEP_MS']; delete process.env['FAKE_NAX_SCENARIO']; return tmp.cleanup(); });

async function world(command: 'RUN' | 'PLAN' = 'RUN', over: Partial<AssignPayload> = {}, extraFiles: Record<string, string> = {}) {
  const base = await tmp.make('host');
  const origin = await makeOrigin(base, 'origin', { files: { 'README.md': 'x', 'docs/spec.md': '# spec from repo\n', '.nax/features/feat/prd.json': PRD, ...extraFiles } });
  const workspaceRoot = join(base, 'ws');
  const naxHome = join(base, 'naxhome');
  const assign: AssignPayload = {
    jobId: 'cjob1', command, repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: origin.url },
    ref: 'main', feature: 'feat', planFrom: command === 'PLAN' ? 'docs/spec.md' : null, profiles: [], maxCostUsd: '5', bashMode: 'raw',
    gitIdentity: { name: 'koda-fleet[bot]', email: 'bot@x' }, ...over,
  };
  const journal = Journal.open(':memory:');
  const row: JobRow = journal.insertJob({ assign, leaseEpoch: 1, repoKey: 'acme/app', jobDir: jobDirFor(workspaceRoot, assign.jobId) }).row;
  const ex = new HostExecutor({ config: { workspaceRoot, naxCommand: ['bun', FAKE], naxHome }, git: createGit(), log: createMemoryLogger(), nowMs: () => Date.now() });
  return { base, origin, workspaceRoot, naxHome, assign, row, ex, journal };
}

describe('HostExecutor RUN', () => {
  test('prepare, spawn, watch the files, verdict, ledger, bundle, cleanup', async () => {
    const w = await world();
    expect(await w.ex.prepare(w.row)).toEqual({ ok: true, branch: 'feat/feat' });
    const profile = JSON.parse(await readFile(jobProfilePath(w.naxHome, 'cjob1'), 'utf8'));
    expect(profile.outputDir).toBe(join(w.row.jobDir, 'nax-out'));
    expect(profile.name).toMatch(/^acme-app-[0-9a-f]{8}$/);
    const handle = await w.ex.spawn(w.row);
    expect(w.ex.isAlive(handle.pid)).toBe(true);
    const running = w.journal.updateJob('cjob1', 1, { pid: handle.pid, pgid: handle.pgid }) as JobRow;
    expect(await w.ex.matchesProcess(running)).toBe(true);
    expect(await w.ex.matchesProcess({ ...running, jobId: 'other' })).toBe(false);
    expect(await w.ex.matchesProcess({ ...running, pid: null })).toBe(false);
    await waitFor(() => !w.ex.isAlive(handle.pid));
    const status = await w.ex.readStatus(w.row);
    expect(runVerdict({ cancelRequested: false, status })).toEqual({ state: 'COMPLETED', reason: null });
    const ledger = await w.ex.readFinishLedger(w.row);
    expect(ledger?.branch).toBe('feat/feat');
    expect(await sh(w.origin.dir, 'rev-parse', 'feat/feat')).toBe(ledger?.headSha as string);
    const bundle = await w.ex.collectBundle(w.row);
    const list = Bun.spawn(['tar', '-tzf', bundle.path], { stdout: 'pipe' });
    const names = (await new Response(list.stdout).text()).split('\n');
    expect(names).toContain('nax-out/status.json');
    expect(names).toContain('nax.stdout');
    expect(names.some((n) => n.includes('prompt-audit'))).toBe(false);
    await w.ex.cleanup(w.row);
    await expect(stat(jobProfilePath(w.naxHome, 'cjob1'))).rejects.toThrow();
  });
  test('the watcher sees snapshots and log lines from the real process', async () => {
    const w = await world();
    await w.ex.prepare(w.row);
    const handle = await w.ex.spawn(w.row);
    const snaps: unknown[] = [];
    const logs: string[] = [];
    const watcher = w.ex.createWatcher(w.row, { snapshot: (p) => { snaps.push(p); }, lifecycle: () => undefined, logLine: (l) => { logs.push(l.text); } }, { startAtEnd: false });
    while (w.ex.isAlive(handle.pid)) { await watcher.tick(); await Bun.sleep(15); }
    await watcher.tick(true);
    expect(snaps.length).toBeGreaterThan(1);
    expect(logs.join('')).toContain('story US-003 done');
  });
  test('prepare wipes a previous attempt of the same job (D53) and prepares again', async () => {
    const w = await world();
    await mkdir(join(w.row.jobDir, 'nax-out'), { recursive: true });
    await writeFile(join(w.row.jobDir, 'nax-out', 'status.json'), '{"run":{"id":"stale","status":"completed"}}');
    await writeFile(join(w.row.jobDir, 'nax.stdout'), 'stale');
    expect((await w.ex.prepare(w.row)).ok).toBe(true);
    expect(await w.ex.readStatus(w.row)).toBeNull();
    await expect(stat(join(w.row.jobDir, 'nax.stdout'))).rejects.toThrow();
  });
  test.each([
    [{ ref: 'nope' }, 'checkout: ref not found'],
    [{ feature: 'ghost' }, 'checkout: no prd.json at ref'],
  ])('prepare failures map to fixed reasons: %j', async (over, reason) => {
    const w = await world('RUN', over);
    expect(await w.ex.prepare(w.row)).toEqual({ ok: false, reason });
  });
  test('an unreachable clone url is a workspace: reason', async () => {
    const w = await world();
    const bad = { ...w.row, assign: { ...w.assign, repo: { ...w.assign.repo, cloneUrl: `file://${join(w.base, 'missing.git')}` } } };
    const out = await w.ex.prepare(bad);
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toMatch(/^workspace: /);
  });
  test('a cancel during prepare is honoured at the next step boundary and no job profile is written (D66)', async () => {
    const early = await world();
    expect(await early.ex.prepare(early.row, { isCancelled: () => true })).toEqual({ ok: false, reason: 'cancelled', cancelled: true });
    await expect(stat(early.row.jobDir)).rejects.toThrow();                       // before anything is written
    const later = await world();
    let polls = 0;
    const out = await later.ex.prepare(later.row, { isCancelled: () => (polls += 1) > 2 });   // after clone and clean
    expect(out).toEqual({ ok: false, reason: 'cancelled', cancelled: true });
    await expect(stat(jobProfilePath(later.naxHome, 'cjob1'))).rejects.toThrow();
  });
  test('a job dir outside <workspaceRoot>/.jobs is refused before anything is written', async () => {
    const w = await world();
    const outside = { ...w.row, jobDir: join(w.base, 'elsewhere') };
    const out = await w.ex.prepare(outside);
    expect(out).toEqual({ ok: false, reason: 'workspace: path escapes its root' });
    await expect(stat(join(w.base, 'elsewhere'))).rejects.toThrow();
  });
  test('kill sends the signal to the whole group and reap tolerates an absent registry', async () => {
    const w = await world();
    await w.ex.prepare(w.row);
    process.env['FAKE_NAX_SCENARIO'] = 'hang';
    const handle = await w.ex.spawn(w.row);
    delete process.env['FAKE_NAX_SCENARIO'];
    w.ex.kill(handle.pgid, 'SIGTERM');
    await waitFor(() => !isProcessAlive(handle.pid));
    await w.ex.reap(w.row, new Date(Date.now() - 60_000));
  });
});

describe('HostExecutor PLAN', () => {
  test('a stale PRD is moved aside, the new one is checked and pushed on its branch, logs reach the bundle', async () => {
    const w = await world('PLAN');
    expect(await w.ex.prepare(w.row)).toEqual({ ok: true, branch: null });
    expect(await readFile(join(w.row.jobDir, 'pre-plan', 'prd.json'), 'utf8')).toBe(PRD);
    const handle = await w.ex.spawn(w.row);
    await waitFor(() => !w.ex.isAlive(handle.pid));
    expect(await w.ex.readStatus(w.row)).toBeNull();
    const check = await w.ex.readPlan(w.row);
    expect(check).toMatchObject({ ok: true, branchName: 'feat/feat' });
    const pushed = await w.ex.finishPlan(w.row);
    expect(pushed).toMatchObject({ ok: true, branch: 'feat/feat' });
    expect(await sh(w.origin.dir, 'rev-parse', 'feat/feat')).toBe((pushed as { sha: string }).sha);
    const bundle = await w.ex.collectBundle(w.row);
    const list = Bun.spawn(['tar', '-tzf', bundle.path], { stdout: 'pipe' });
    expect((await new Response(list.stdout).text()).split('\n')).toContain('plan-logs/plan-1.jsonl');
  });
  test('prepare deletes a previous attempt\'s plan logs, which git clean keeps because plan/ is ignored (D62)', async () => {
    const w = await world('PLAN', {}, { '.gitignore': '.nax/features/*/plan/\n' });
    await w.ex.prepare(w.row);
    const stale = join(w.workspaceRoot, 'acme', 'app', '.nax', 'features', 'feat', 'plan', 'plan-stale.jsonl');
    await mkdir(join(stale, '..'), { recursive: true });
    await writeFile(stale, '{"stale":true}\n');
    await writeFile(join(stale, '..', 'notes.txt'), 'kept: not a jsonl');
    expect((await w.ex.prepare(w.row)).ok).toBe(true);
    await expect(stat(stale)).rejects.toThrow();
    expect(await readFile(join(stale, '..', 'notes.txt'), 'utf8')).toBe('kept: not a jsonl');
    const handle = await w.ex.spawn(w.row);
    await waitFor(() => !w.ex.isAlive(handle.pid));
    const bundle = await w.ex.collectBundle(w.row);
    const names = (await new Response(Bun.spawn(['tar', '-tzf', bundle.path], { stdout: 'pipe' }).stdout).text()).split('\n');
    expect(names).toContain('plan-logs/plan-1.jsonl');
    expect(names).not.toContain('plan-logs/plan-stale.jsonl');
  });
  test('readPlan and finishPlan use the write-once stash, not a checkout that a crash reverted (D61)', async () => {
    const w = await world('PLAN');
    await w.ex.prepare(w.row);
    const handle = await w.ex.spawn(w.row);
    await waitFor(() => !w.ex.isAlive(handle.pid));
    await w.ex.collectBundle(w.row);                                             // first stash, before any branch switch
    const checkoutPrd = join(w.workspaceRoot, 'acme', 'app', '.nax', 'features', 'feat', 'prd.json');
    await writeFile(checkoutPrd, JSON.stringify({ branchName: 'stale/other', userStories: [{ id: 'OLD' }] }));
    expect(await w.ex.readPlan(w.row)).toMatchObject({ ok: true, branchName: 'feat/feat' });
    const pushed = await w.ex.finishPlan(w.row);
    expect(pushed).toMatchObject({ ok: true, branch: 'feat/feat' });
    expect(JSON.parse(await sh(w.origin.dir, 'show', 'feat/feat:.nax/features/feat/prd.json')).userStories[0].id).toBe('US-001');
  });
  test('an invalid plan is not rescued by the stale PRD that was moved aside', async () => {
    const w = await world('PLAN');
    await w.ex.prepare(w.row);
    process.env['FAKE_NAX_SCENARIO'] = 'plan-invalid';
    const handle = await w.ex.spawn(w.row);
    delete process.env['FAKE_NAX_SCENARIO'];
    await waitFor(() => !w.ex.isAlive(handle.pid));
    expect(await w.ex.readPlan(w.row)).toMatchObject({ ok: false, reason: 'prd.json has no userStories' });
  });
  test('a repo without .nax fails with the fixed reason', async () => {
    const base = await tmp.make('host');
    const origin = await makeOrigin(base, 'origin', { files: { 'README.md': 'x' } });
    const workspaceRoot = join(base, 'ws');
    const assign: AssignPayload = {
      jobId: 'cjob2', command: 'PLAN', repo: { provider: 'github', owner: 'acme', name: 'bare', defaultBranch: 'main', cloneUrl: origin.url },
      ref: 'main', feature: 'feat', planFrom: 'docs/spec.md', profiles: [], maxCostUsd: '1', bashMode: 'raw', gitIdentity: { name: 'b', email: 'b@x' },
    };
    const journal = Journal.open(':memory:');
    const row = journal.insertJob({ assign, leaseEpoch: 1, repoKey: 'acme/bare', jobDir: jobDirFor(workspaceRoot, 'cjob2') }).row;
    const ex = new HostExecutor({ config: { workspaceRoot, naxCommand: ['bun', FAKE], naxHome: join(base, 'nh') }, git: createGit(), log: createMemoryLogger(), nowMs: () => Date.now() });
    expect(await ex.prepare(row)).toEqual({ ok: false, reason: 'no .nax dir' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/runner && bun test test/unit/host-executor.spec.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the seam**

`executor/job-executor.ts`:

```ts
import type { BundleFile } from '../bundle/build-bundle';
import type { JobRow } from '../journal/types';
import type { PlanCheck } from '../verdict/plan-verdict';
import type { StatusView } from '../verdict/status-view';
import type { WatcherSink } from '../watcher/watcher';

export type PrepareOutcome = { ok: true; branch: string | null } | { ok: false; reason: string; cancelled?: true };

/** D66: polled between prepare steps; true ends prepare at that boundary with `cancelled: true`. */
export interface PrepareOptions {
  readonly isCancelled?: () => boolean;
}

export interface SpawnHandle {
  readonly pid: number;
  readonly pgid: number;
}

export interface WatchOptions {
  readonly startAtEnd: boolean;
  readonly onRunIds?: (ids: { naxRunId: string; logPath: string | null }) => void;
}

export interface JobWatcher {
  tick(final?: boolean): Promise<void>;
}

export type PlanPushOutcome = { ok: true; branch: string; sha: string } | { ok: false; reason: string };

/**
 * Slice 3 design §1 `executor/`. 3a ships HostExecutor only; a container or VM executor implements the same seam
 * (S1 spec §5.5). Nothing here talks to the server: results are journal events written by the caller.
 */
export interface JobExecutor {
  prepare(job: JobRow, options?: PrepareOptions): Promise<PrepareOutcome>;
  spawn(job: JobRow): Promise<SpawnHandle>;
  isAlive(pid: number): boolean;
  matchesProcess(job: JobRow): Promise<boolean>;
  kill(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  reap(job: JobRow, since: Date): Promise<void>;
  createWatcher(job: JobRow, sink: WatcherSink, options: WatchOptions): JobWatcher;
  readStatus(job: JobRow): Promise<StatusView | null>;
  readPlan(job: JobRow): Promise<PlanCheck>;
  finishPlan(job: JobRow): Promise<PlanPushOutcome>;
  readFinishLedger(job: JobRow): Promise<{ branch: string; headSha: string } | null>;
  collectBundle(job: JobRow): Promise<BundleFile>;
  cleanup(job: JobRow): Promise<void>;
}
```

- [ ] **Step 4: Implement `HostExecutor`**

`executor/host-executor.ts`:

```ts
import { copyFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { buildBundle, type BundleFile } from '../bundle/build-bundle';
import type { RunnerConfig } from '../config/runner-config';
import type { JobRow } from '../journal/types';
import type { Logger } from '../logger';
import { assertInside, featureDirFor, repoDirFor } from '../paths/safe-segment';
import { checkPlanPrd, type PlanCheck } from '../verdict/plan-verdict';
import type { StatusView } from '../verdict/status-view';
import { Watcher, type WatcherSink } from '../watcher/watcher';
import { readStatusFile } from '../watcher/status-snapshot';
import { prepareCheckout } from './checkout';
import { reasonFromError, type Git } from './git';
import type { JobExecutor, JobWatcher, PlanPushOutcome, PrepareOptions, PrepareOutcome, SpawnHandle, WatchOptions } from './job-executor';
import { deleteJobProfile, jobProfileName, projectNameFor, writeJobProfile } from './job-profile';
import { buildNaxArgv, isProcessAlive, signalGroup, spawnNax } from './nax-process';
import { readProcessCommand, reapNaxPids } from './pid-registry';
import { commitAndPushPlan, stashPlanOutputs } from './plan-commit';
import { cleanWorkspace, ensureClone } from './workspace';

export interface HostExecutorDeps {
  readonly config: Pick<RunnerConfig, 'workspaceRoot' | 'naxCommand' | 'naxHome'>;
  readonly git: Git;
  readonly log: Logger;
  readonly nowMs: () => number;
}

const ATTEMPT_FILES = ['nax-out', 'nax.stdout', 'nax.stderr', 'pre-plan', 'plan-out', 'plan-out.tmp', 'plan-logs', 'plan-logs.tmp', 'bundle.tar.gz', 'bundle.list', 'bundle-manifest.json'];
const CANCELLED: PrepareOutcome = { ok: false, reason: 'cancelled', cancelled: true };
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

async function moveAside(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (code !== 'EXDEV') throw error;
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

/** Design §2, run on the machine that owns the checkout. Every step is idempotent, so a resumed job may repeat it. */
export class HostExecutor implements JobExecutor {
  constructor(private readonly deps: HostExecutorDeps) {}

  private dirs(job: JobRow): { repoDir: string; jobDir: string; outDir: string } {
    const { workspaceRoot } = this.deps.config;
    const jobDir = assertInside(join(workspaceRoot, '.jobs'), job.jobDir);
    return { repoDir: repoDirFor(workspaceRoot, job.assign.repo.owner, job.assign.repo.name), jobDir, outDir: join(jobDir, 'nax-out') };
  }

  async prepare(job: JobRow, options: PrepareOptions = {}): Promise<PrepareOutcome> {
    const cancelled = (): boolean => options.isCancelled?.() === true;   // D66: polled at every step boundary
    try {
      const { repoDir, jobDir, outDir } = this.dirs(job);
      const { assign } = job;
      if (cancelled()) return CANCELLED;
      await Promise.all(ATTEMPT_FILES.map((name) => rm(join(jobDir, name), { recursive: true, force: true })));
      await mkdir(jobDir, { recursive: true });
      await ensureClone(this.deps.git, { repoDir, cloneUrl: assign.repo.cloneUrl, identity: assign.gitIdentity });
      if (cancelled()) return CANCELLED;
      await cleanWorkspace(this.deps.git, repoDir);
      if (cancelled()) return CANCELLED;
      const checkout = await prepareCheckout({ git: this.deps.git, repoDir, assign });
      if (!checkout.ok) return { ok: false, reason: checkout.reason };
      if (assign.command === 'PLAN') await this.moveStalePlanFiles(repoDir, jobDir, assign.feature);
      if (cancelled()) return CANCELLED;
      await mkdir(outDir, { recursive: true });
      await writeJobProfile(this.deps.config.naxHome, job.jobId, outDir, projectNameFor(assign.repo.owner, assign.repo.name));
      return { ok: true, branch: checkout.branch };
    } catch (error) {
      return { ok: false, reason: reasonFromError(error) };
    }
  }

  /**
   * Design §2 step 4: a stale prd.json or prd.rejected.json must not pass the PLAN verdict. D62: `plan/` is gitignored,
   * so `clean -ffd` kept a previous attempt's `plan/*.jsonl`; they would be bundled as this attempt's, so they go too.
   */
  private async moveStalePlanFiles(repoDir: string, jobDir: string, feature: string): Promise<void> {
    const dir = featureDirFor(repoDir, feature);
    await mkdir(join(jobDir, 'pre-plan'), { recursive: true });
    for (const name of ['prd.json', 'prd.rejected.json']) await moveAside(join(dir, name), join(jobDir, 'pre-plan', name));
    const stale = (await readdir(join(dir, 'plan')).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl'));
    await Promise.all(stale.map((name) => rm(join(dir, 'plan', name), { force: true })));
  }

  async spawn(job: JobRow): Promise<SpawnHandle> {
    const { repoDir, jobDir } = this.dirs(job);
    const argv = buildNaxArgv(this.deps.config.naxCommand, job.assign);
    return spawnNax(argv, {
      cwd: repoDir, stdoutPath: join(jobDir, 'nax.stdout'), stderrPath: join(jobDir, 'nax.stderr'),
      env: { ...process.env, NAX_GLOBAL_CONFIG_DIR: this.deps.config.naxHome },
    });
  }

  isAlive(pid: number): boolean {
    return isProcessAlive(pid);
  }

  async matchesProcess(job: JobRow): Promise<boolean> {
    if (job.pid === null) return false;
    const command = await readProcessCommand(job.pid);
    return command !== null && command.includes(jobProfileName(job.jobId));
  }

  kill(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
    signalGroup(pgid, signal);
  }

  async reap(job: JobRow, since: Date): Promise<void> {
    const killed = await reapNaxPids({ repoDir: this.dirs(job).repoDir, since });
    if (killed.length > 0) this.deps.log.info('reaped registered pids', { jobId: job.jobId, killed });
  }

  createWatcher(job: JobRow, sink: WatcherSink, options: WatchOptions): JobWatcher {
    const { jobDir, outDir } = this.dirs(job);
    return new Watcher(sink, {
      outDir, feature: job.assign.feature, stdoutPath: join(jobDir, 'nax.stdout'), stderrPath: join(jobDir, 'nax.stderr'),
      startAtEnd: options.startAtEnd, nowMs: this.deps.nowMs, onRunIds: options.onRunIds,
    });
  }

  async readStatus(job: JobRow): Promise<StatusView | null> {
    return (await readStatusFile(join(this.dirs(job).outDir, 'status.json'))).status;
  }

  /** D61: once the write-once stash exists it is the PRD; the checkout may have been switched back to the ref's stale one. */
  async readPlan(job: JobRow): Promise<PlanCheck> {
    const { repoDir, jobDir } = this.dirs(job);
    const stashed = join(jobDir, 'plan-out', 'prd.json');
    const path = (await exists(stashed)) ? stashed : join(featureDirFor(repoDir, job.assign.feature), 'prd.json');
    return checkPlanPrd(await readFile(path, 'utf8').catch(() => null));
  }

  async finishPlan(job: JobRow): Promise<PlanPushOutcome> {
    const { repoDir, jobDir } = this.dirs(job);
    const check = await this.readPlan(job);
    if (!check.ok || check.branchName === null) return { ok: false, reason: check.branchName === null && check.ok ? 'checkout: invalid branchName' : 'plan output missing' };
    const refSha = (await this.deps.git.ok(['rev-parse', 'HEAD'], { cwd: repoDir })).trim();
    const result = await commitAndPushPlan({
      git: this.deps.git, repoDir, jobDir, feature: job.assign.feature, jobId: job.jobId,
      branchName: check.branchName, refSha, defaultBranch: job.assign.repo.defaultBranch, identity: job.assign.gitIdentity,
    });
    return result.ok ? { ok: true, branch: result.branch, sha: result.sha } : { ok: false, reason: result.reason };
  }

  async readFinishLedger(job: JobRow): Promise<{ branch: string; headSha: string } | null> {
    const path = join(this.dirs(job).outDir, 'finish-audit', job.assign.feature, 'last.json');
    try {
      const ledger = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      return typeof ledger['branch'] === 'string' && typeof ledger['headSha'] === 'string' ? { branch: ledger['branch'], headSha: ledger['headSha'] } : null;
    } catch {
      return null;
    }
  }

  async collectBundle(job: JobRow): Promise<BundleFile> {
    const { repoDir, jobDir } = this.dirs(job);
    if (job.command === 'PLAN') await stashPlanOutputs(repoDir, jobDir, job.assign.feature);
    return buildBundle({ jobDir, command: job.command });
  }

  async cleanup(job: JobRow): Promise<void> {
    await deleteJobProfile(this.deps.config.naxHome, job.jobId);
  }
}
```
(The `finishPlan` guard line reads: not ok, or no branch name -> a fixed reason. `collectBundle` for PLAN stashes so a failed plan's logs still travel; `stashPlanOutputs` is write-once (D61), so the call after `finishPlan` returns the same stash and never touches the checkout.)

- [ ] **Step 5: Run and lint**

```bash
cd apps/runner && bun test test/unit/host-executor.spec.ts && bun run type-check && bun run lint
```
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add apps/runner
git commit -m "feat(fleet): JobExecutor seam and HostExecutor (steps 1-10 over real git and a detached nax)"
```

---
### Task 19: Supervisor primitives — repo mutex, legal transitions, job events

**Files:**
- Create: `apps/runner/test/helpers/assign.ts`, `apps/runner/test/helpers/fake-time.ts`
- Create: `apps/runner/src/supervisor/repo-mutex.ts`, `repo-mutex.spec.ts`
- Create: `apps/runner/src/supervisor/transitions.ts`, `transitions.spec.ts`
- Create: `apps/runner/src/supervisor/job-events.ts`, `job-events.spec.ts`

**Interfaces:**
- Consumes: `Journal`, `JobPatch` (8), `WatcherSink` (15), `Logger` (6), `byteLength`, `SYNC_LIMITS` (9).
- Produces:
  ```ts
  // test helpers
  export function assignFor(command?: 'RUN' | 'PLAN', over?: Partial<AssignPayload>): AssignPayload;   // acme/app, job j1, feature feat
  export function fakeTime(startMs?: number): { now(): Date; nowMs(): number; sleep(ms: number): Promise<void>; advance(ms: number): void };   // sleep advances the clock and yields one macrotask
  // repo-mutex.ts
  export class RepoMutex { acquire(key: string): Promise<() => void>; isLocked(key: string): boolean }   // FIFO per key; release is idempotent
  // transitions.ts
  export const TERMINAL_STATES: readonly FleetJobStateName[];
  export function canEmit(from: FleetJobStateName, to: FleetJobStateName): boolean;   // S1 spec §5.4 runner-reported rows only
  export function isTerminalState(state: FleetJobStateName): boolean;
  // job-events.ts
  export class JobEvents implements WatcherSink {
    constructor(journal: Journal, jobId: string, leaseEpoch: number, log: Logger);
    currentState(): FleetJobStateName | null;                                        // null once the job row is gone
    transition(to: FleetJobStateName, reason?: string, patch?: JobPatch): boolean;   // false when refused or the job is gone
    snapshot(payload: SnapshotEventPayload): void;
    lifecycle(level: 'info' | 'warn' | 'error', message: string): void;
    logLine(payload: LogEventPayload): void;
  }
  ```
  Payload guards (16 KiB limit): `state.reason` at most 500 characters, `lifecycle.message` at most 2000, an oversize snapshot loses `progress`, an oversize log loses text down to 4000 characters. An illegal transition is refused: it appends a `lifecycle` error event and returns false (the server would store and ack it without applying, stranding the job: the 2b plan's illegal-transition rule).

- [ ] **Step 1: Write the failing specs**

`supervisor/repo-mutex.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { RepoMutex } from './repo-mutex';

/** One macrotask: every already-resolved promise chain has run by the time this resolves. Ordering, not timing. */
const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('RepoMutex (D28)', () => {
  test('serialises one key first-in first-out, whatever order the holders finish being ready', async () => {
    const mutex = new RepoMutex();
    const order: string[] = [];
    const hold = { a: deferred(), b: deferred(), c: deferred() };
    const worker = async (name: 'a' | 'b' | 'c') => {
      const release = await mutex.acquire('acme/app');
      order.push(`${name}:in`);
      await hold[name].promise;
      order.push(`${name}:out`);
      release();
    };
    const all = Promise.all([worker('a'), worker('b'), worker('c')]);
    await settle();
    expect(order).toEqual(['a:in']);                       // b and c wait behind a
    hold.c.resolve();
    await settle();
    expect(order).toEqual(['a:in']);                       // c is ready but may not jump the queue
    hold.a.resolve();
    await settle();
    expect(order).toEqual(['a:in', 'a:out', 'b:in']);
    hold.b.resolve();
    await all;
    expect(order).toEqual(['a:in', 'a:out', 'b:in', 'b:out', 'c:in', 'c:out']);
  });
  test('different keys do not wait for each other', async () => {
    const mutex = new RepoMutex();
    const releaseA = await mutex.acquire('a/x');
    let acquiredB = false;
    const pendingB = mutex.acquire('b/y').then((release) => { acquiredB = true; return release; });
    await settle();
    expect(acquiredB).toBe(true);                          // while a/x is still held
    expect(mutex.isLocked('a/x')).toBe(true);
    releaseA();
    (await pendingB)();
    expect(mutex.isLocked('a/x')).toBe(false);
    expect(mutex.isLocked('b/y')).toBe(false);
  });
  test('releasing twice is harmless and does not admit two holders', async () => {
    const mutex = new RepoMutex();
    const first = await mutex.acquire('k');
    const second = mutex.acquire('k');
    const third = mutex.acquire('k');
    first();
    first();
    const releaseSecond = await second;
    let thirdIn = false;
    void third.then(() => { thirdIn = true; });
    await settle();
    expect(thirdIn).toBe(false);
    releaseSecond();
    (await third)();
    expect(mutex.isLocked('k')).toBe(false);
  });
  test('a holder that throws still releases when the caller uses finally', async () => {
    const mutex = new RepoMutex();
    await (async () => {
      const release = await mutex.acquire('k');
      try { throw new Error('boom'); } finally { release(); }
    })().catch(() => undefined);
    expect(mutex.isLocked('k')).toBe(false);
  });
});
```

`supervisor/transitions.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { FleetJobStateName } from '@nathapp/fleet-protocol';
import { TERMINAL_STATES, canEmit, isTerminalState } from './transitions';

const ALL: FleetJobStateName[] = ['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING', 'COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED'];
const ALLOWED: Record<string, string[]> = {
  ASSIGNED: ['RUNNING', 'FAILED', 'CANCELLED'],
  RUNNING: ['UPLOADING', 'CANCELLED'],
  UPLOADING: ['COMPLETED', 'FAILED', 'ESCALATED', 'CANCELLED'],
};

describe('canEmit (S1 spec §5.4, runner-reported rows)', () => {
  test.each(ALL.flatMap((from) => ALL.map((to) => [from, to] as const)))('%s -> %s', (from, to) => {
    expect(canEmit(from, to)).toBe(ALLOWED[from]?.includes(to) ?? false);
  });
  test('terminal states are terminal and have no exits', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(['CANCELLED', 'COMPLETED', 'CRASHED', 'ESCALATED', 'FAILED']);
    for (const s of ALL) expect(isTerminalState(s)).toBe(TERMINAL_STATES.includes(s));
    for (const s of TERMINAL_STATES) for (const to of ALL) expect(canEmit(s, to)).toBe(false);
  });
});
```

`supervisor/job-events.spec.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test';
import { Journal } from '../journal/journal';
import { createMemoryLogger, type MemoryLogger } from '../logger';
import { assignFor } from '../../test/helpers/assign';
import { JobEvents } from './job-events';

let journal: Journal;
let log: MemoryLogger;
let events: JobEvents;
const all = () => journal.pendingEvents('j1', 1, 100);
beforeEach(() => {
  journal = Journal.open(':memory:');
  journal.insertJob({ assign: assignFor(), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/w/.jobs/j1' });
  log = createMemoryLogger();
  events = new JobEvents(journal, 'j1', 1, log);
});

describe('transition', () => {
  test('a legal transition appends a state event and moves the journal state in one step, with the patch', () => {
    expect(events.transition('RUNNING', undefined, { pid: 7, pgid: 7, branch: 'feat/x' })).toBe(true);
    expect(all()).toMatchObject([{ seq: 1, type: 'state', payload: { to: 'RUNNING' } }]);
    expect(journal.getJob('j1', 1)).toMatchObject({ state: 'RUNNING', pid: 7, pgid: 7, branch: 'feat/x' });
    expect(events.currentState()).toBe('RUNNING');
  });
  test('an illegal transition is refused: no state event, a lifecycle error, state unchanged', () => {
    expect(events.transition('COMPLETED')).toBe(false);
    expect(events.transition('UPLOADING')).toBe(false);
    expect(journal.getJob('j1', 1)?.state).toBe('ASSIGNED');
    expect(all().map((e) => e.type)).toEqual(['lifecycle', 'lifecycle']);
    expect(all()[0].payload).toMatchObject({ level: 'error', message: expect.stringContaining('ASSIGNED -> COMPLETED') });
    expect(log.lines.filter((l) => l.level === 'warn')).toHaveLength(2);
  });
  test('a full RUN path is accepted, a second terminal is not', () => {
    for (const to of ['RUNNING', 'UPLOADING', 'COMPLETED'] as const) expect(events.transition(to)).toBe(true);
    expect(events.transition('FAILED')).toBe(false);
    expect(all().filter((e) => e.type === 'state').map((e) => (e.payload as { to: string }).to)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
  });
  test('the reason is kept but cut to 500 characters', () => {
    events.transition('FAILED', 'x'.repeat(900));
    expect((all()[0].payload as { reason: string }).reason).toHaveLength(500);
  });
});

describe('payload guards', () => {
  test('lifecycle messages are cut to 2000 characters', () => {
    events.lifecycle('warn', 'm'.repeat(5000));
    expect((all()[0].payload as { message: string }).message).toHaveLength(2000);
  });
  test('an oversize snapshot drops progress so it fits the 16 KiB payload limit', () => {
    events.snapshot({ naxRunId: 'r', progress: { blob: 'x'.repeat(20_000) } as never });
    expect(all()[0].payload).toEqual({ naxRunId: 'r' });
    events.snapshot({ naxRunId: 'r', progress: { total: 3 } });
    expect(all()[1].payload).toEqual({ naxRunId: 'r', progress: { total: 3 } });
  });
  test('an oversize log line is cut down', () => {
    events.logLine({ stream: 'run', text: 'y'.repeat(20_000) });
    expect((all()[0].payload as { text: string }).text).toHaveLength(4000);
  });
});

describe('a job that is gone (abandoned)', () => {
  test('every call is a quiet no-op', () => {
    journal.abandon('j1', 1);
    expect(events.currentState()).toBeNull();
    expect(events.transition('RUNNING')).toBe(false);
    expect(() => { events.snapshot({ naxRunId: 'r' }); events.lifecycle('info', 'x'); events.logLine({ stream: 'run', text: 'x' }); }).not.toThrow();
    expect(journal.pendingEvents('j1', 1, 10)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/runner && bun test src/supervisor`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`test/helpers/assign.ts`:

```ts
import type { AssignPayload } from '@nathapp/fleet-protocol';

export function assignFor(command: 'RUN' | 'PLAN' = 'RUN', over: Partial<AssignPayload> = {}): AssignPayload {
  return {
    jobId: 'j1', command,
    repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'https://github.com/acme/app.git' },
    ref: 'main', feature: 'feat', planFrom: command === 'PLAN' ? 'docs/spec.md' : null, profiles: [], maxCostUsd: '5', bashMode: 'raw',
    gitIdentity: { name: 'koda-fleet[bot]', email: 'koda-fleet[bot]@users.noreply.github.com' }, ...over,
  };
}
```

`test/helpers/fake-time.ts`:

```ts
/** A clock the test moves: sleeping advances it and yields one macrotask, so loops make progress deterministically. */
export function fakeTime(startMs: number = Date.parse('2026-10-01T00:00:00.000Z')) {
  let t = startMs;
  return {
    now: (): Date => new Date(t),
    nowMs: (): number => t,
    sleep: async (ms: number): Promise<void> => {
      t += ms;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
    advance: (ms: number): void => { t += ms; },
  };
}
```

`supervisor/repo-mutex.ts`:

```ts
/** D28: an in-memory FIFO per repository key; held from the start of `prepare` to the end of cleanup. */
export class RepoMutex {
  private readonly tails = new Map<string, Promise<void>>();

  acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    let released = false;
    return previous.then(() => () => {
      if (released) return;
      released = true;
      open();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
  }

  isLocked(key: string): boolean {
    return this.tails.has(key);
  }
}
```

`supervisor/transitions.ts`:

```ts
import type { FleetJobStateName } from '@nathapp/fleet-protocol';

/** S1 spec §5.4, runner-reported rows only (server-owned transitions are never emitted by the runner). */
const RUNNER_TRANSITIONS: Readonly<Record<string, readonly FleetJobStateName[]>> = {
  ASSIGNED: ['RUNNING', 'FAILED', 'CANCELLED'],
  RUNNING: ['UPLOADING', 'CANCELLED'],
  UPLOADING: ['COMPLETED', 'FAILED', 'ESCALATED', 'CANCELLED'],
};

export const TERMINAL_STATES: readonly FleetJobStateName[] = ['COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED'];

export const canEmit = (from: FleetJobStateName, to: FleetJobStateName): boolean => RUNNER_TRANSITIONS[from]?.includes(to) ?? false;

export const isTerminalState = (state: FleetJobStateName): boolean => TERMINAL_STATES.includes(state);
```

`supervisor/job-events.ts`:

```ts
import type { FleetJobStateName, LogEventPayload, SnapshotEventPayload, StateEventPayload } from '@nathapp/fleet-protocol';
import type { Journal } from '../journal/journal';
import type { JobPatch } from '../journal/types';
import type { Logger } from '../logger';
import { SYNC_LIMITS, byteLength } from '../sync/batch';
import type { WatcherSink } from '../watcher/watcher';
import { canEmit } from './transitions';

const MAX_REASON = 500;
const MAX_MESSAGE = 2_000;
const MAX_LOG_TEXT = 4_000;

/** The only writer of a job's journal events: guards every payload and refuses illegal transitions. */
export class JobEvents implements WatcherSink {
  constructor(private readonly journal: Journal, private readonly jobId: string, private readonly leaseEpoch: number, private readonly log: Logger) {}

  currentState(): FleetJobStateName | null {
    return this.journal.getJob(this.jobId, this.leaseEpoch)?.state ?? null;
  }

  transition(to: FleetJobStateName, reason?: string, patch?: JobPatch): boolean {
    const from = this.currentState();
    if (from === null) return false;
    if (!canEmit(from, to)) {
      const message = `refused illegal transition ${from} -> ${to}`;
      this.log.warn(message, { jobId: this.jobId, leaseEpoch: this.leaseEpoch });
      this.lifecycle('error', message);
      return false;
    }
    const payload: StateEventPayload = { to, ...(reason ? { reason: reason.slice(0, MAX_REASON) } : {}) };
    return this.journal.appendEvent(this.jobId, this.leaseEpoch, 'state', payload, { ...patch, state: to }) !== null;
  }

  snapshot(payload: SnapshotEventPayload): void {
    const { progress: _progress, ...rest } = payload;   // `_`-prefixed: ignored by the root eslint varsIgnorePattern '^_'
    const fits = byteLength(payload) <= SYNC_LIMITS.payloadBytes;
    this.journal.appendEvent(this.jobId, this.leaseEpoch, 'snapshot', fits ? payload : rest);
  }

  lifecycle(level: 'info' | 'warn' | 'error', message: string): void {
    this.journal.appendEvent(this.jobId, this.leaseEpoch, 'lifecycle', { level, message: message.slice(0, MAX_MESSAGE) });
  }

  logLine(payload: LogEventPayload): void {
    const fits = byteLength(payload) <= SYNC_LIMITS.payloadBytes;
    this.journal.appendEvent(this.jobId, this.leaseEpoch, 'log', fits ? payload : { ...payload, text: payload.text.slice(0, MAX_LOG_TEXT) });
  }
}
```

- [ ] **Step 4: Run and lint**

```bash
cd apps/runner && bun test src/supervisor && bun run type-check && bun run lint
```
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/runner
git commit -m "feat(fleet): runner supervisor primitives (repo mutex, legal transition table, guarded job events)"
```

---

### Task 20: `JobRun` — one job's lifecycle (RUN and PLAN, cancel, crash, bundle outcomes, resume)

**Files:**
- Create: `apps/runner/test/helpers/fake-executor.ts`
- Create: `apps/runner/src/supervisor/kill-if-ours.ts`
- Create: `apps/runner/src/supervisor/job-run.ts`, `job-run.spec.ts`

**Interfaces:**
- Consumes: `JobExecutor` and friends (18), `JobEvents`, `RepoMutex`, `canEmit`/`isTerminalState` (19), `runVerdict`, `planVerdict` (11), `mapStatusToSnapshot` (11), `UploadOutcome`, `BundleFile` (17), `Journal`, `Logger`, `Now`, `Sleep`.
- Produces:
  ```ts
  // kill-if-ours.ts
  export function killIfOurs(executor: JobExecutor, row: JobRow, log: Logger): Promise<boolean>;   // D65: SIGKILL the group only while the journaled pid is still this job's nax
  export interface BundleUploader { upload(job: JobRow, file: BundleFile, rebuild: () => Promise<BundleFile>): Promise<UploadOutcome> }
  export interface JobRunTuning { readonly statusPollMs: number; readonly killGraceMs: number; readonly ackPollMs: number; readonly uploadAckWaitMs: number }   // uploadAckWaitMs 0 = do not wait for acks (unit tests)
  export interface JobRunDeps { readonly journal: Journal; readonly executor: JobExecutor; readonly mutex: RepoMutex; readonly uploader: BundleUploader; readonly log: Logger; readonly now: Now; readonly sleep: Sleep; readonly tuning: JobRunTuning }
  export type RunStart = 'prepare' | 'reprepare' | 'watch' | 'finish';   // reprepare: prepare again after a restart; reaps `.nax-pids` first (D65)
  export class JobRun {
    constructor(deps: JobRunDeps, jobId: string, leaseEpoch: number);
    start(from: RunStart): Promise<void>;     // never rejects; holds the repo mutex from the start to the end of cleanup
    requestCancel(): boolean;                 // false when the job is gone or already terminal; while queued for the repo mutex it ends ASSIGNED -> CANCELLED at once (D66)
    abandon(): Promise<void>;                 // stale lease: halt, wait for the repo mutex (D64), SIGKILL the group if it is still this job's nax, reap and clean up unless a live higher epoch of the job exists, drop the epoch's rows
    halt(): void;                             // daemon shutdown: emit nothing more, touch no child
  }
  ```
  Lifecycle (D35): `prepare` -> `RUNNING` (with pid, pgid, branch in the same transaction) -> watch until the pid is gone -> verdict from files -> (PLAN, verdict COMPLETED, not yet pushed: `finishPlan`) -> `UPLOADING` -> bundle -> final snapshot (`resultBranch`/`resultSha` from the finish ledger or the PLAN push) -> terminal state -> cleanup -> `markDone`. Before spawn: `ASSIGNED -> FAILED` (prepare failed, spawn failed) or `ASSIGNED -> CANCELLED`. A runner error while `RUNNING` goes through `UPLOADING` to `FAILED` (`runner error: ...`). Cancel: SIGTERM to the group as soon as the job is `RUNNING`, SIGKILL after `killGraceMs`, then the normal flow (verdict CANCELLED). Before the upload the run waits (bounded by `tuning.uploadAckWaitMs`, polling every `tuning.ackPollMs` through the injected `sleep`/`now`) until the journal no longer holds an unacked `UPLOADING` state event, so the server has applied it (D60); on timeout it uploads anyway and journals a warning. Upload outcomes: `ok` -> the verdict; `failed` -> the verdict state with reason `bundle upload failed` (a FAILED verdict keeps its reason as a prefix); `too-large` -> reason `bundle too large`; `stale` -> park silently (no terminal event, no `markDone`; the server's `ABANDON` comes next, D49); `state-conflict` -> journal a warning, wait (same bound) until every pending event is acked, upload once more; a second `state-conflict` journals a lifecycle error and ends the job locally (`cleanup`, `markDone`) with no terminal event and nothing more reported, which releases the slot (D60). A bundle that left out unsafe file names journals a lifecycle warning (D68). A resumed `finish` never re-emits `UPLOADING` and never repeats a PLAN push that already recorded `resultSha`. A cancel during `prepare` is passed to the executor as `isCancelled` and ends `ASSIGNED -> CANCELLED` (`cancelled before start`) at the next step boundary (D66). A runner error (`failSafe`) SIGKILLs the group first when the journaled pid is still this job's nax, then reaps (D65).

- [ ] **Step 1: Write the fake executor**

`test/helpers/fake-executor.ts`:

```ts
import type { BundleFile } from '../../src/bundle/build-bundle';
import type { JobExecutor, JobWatcher, PlanPushOutcome, PrepareOptions, PrepareOutcome, SpawnHandle, WatchOptions } from '../../src/executor/job-executor';
import type { JobRow } from '../../src/journal/types';
import type { PlanCheck } from '../../src/verdict/plan-verdict';
import type { StatusView } from '../../src/verdict/status-view';
import type { WatcherSink } from '../../src/watcher/watcher';

/** A scriptable JobExecutor: every call is recorded as `<name>:<jobId>`; nothing touches disk, git or a process. */
export class FakeExecutor implements JobExecutor {
  readonly calls: string[] = [];
  readonly killed: Array<{ pgid: number; signal: string }> = [];
  readonly watchOptions: WatchOptions[] = [];
  readonly prepareOptions: PrepareOptions[] = [];
  prepareResult: PrepareOutcome = { ok: true, branch: 'feat/x' };
  spawnError: Error | null = null;
  handle: SpawnHandle = { pid: 4242, pgid: 4242 };
  alive = false;
  aliveAfterSpawn = true;
  procMatches = true;
  status: StatusView | null = { run: { id: 'run-1', status: 'completed' }, postRun: { finish: { status: 'passed', result: 'opened', url: 'https://example.test/pr/1' } } };
  statusError: Error | null = null;
  plan: PlanCheck = { ok: true, reason: null, branchName: 'feat/x' };
  planPush: PlanPushOutcome = { ok: true, branch: 'feat/x', sha: 'a'.repeat(40) };
  ledger: { branch: string; headSha: string } | null = { branch: 'feat/x', headSha: 'b'.repeat(40) };
  bundle: BundleFile = { path: '/b.tgz', size: 1, sha256: 'c'.repeat(64) };
  bundleError: Error | null = null;
  ticks = 0;
  onTick: (n: number, final: boolean, sink: WatcherSink) => void = () => undefined;
  onKill: (signal: 'SIGTERM' | 'SIGKILL') => void = () => { this.alive = false; };

  private note(name: string, job: JobRow): void {
    this.calls.push(`${name}:${job.jobId}`);
  }

  /** The process ends on the n-th watcher tick. */
  dieAfterTicks(n: number): void {
    this.onTick = (tick) => { if (tick >= n) this.alive = false; };
  }

  async prepare(job: JobRow, options: PrepareOptions = {}): Promise<PrepareOutcome> {
    this.note('prepare', job);
    this.prepareOptions.push(options);
    return this.prepareResult;
  }

  async spawn(job: JobRow): Promise<SpawnHandle> {
    this.note('spawn', job);
    if (this.spawnError) throw this.spawnError;
    this.alive = this.aliveAfterSpawn;
    return this.handle;
  }

  isAlive(): boolean {
    return this.alive;
  }

  async matchesProcess(): Promise<boolean> {
    return this.alive && this.procMatches;
  }

  kill(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
    this.killed.push({ pgid, signal });
    this.onKill(signal);
  }

  async reap(job: JobRow): Promise<void> {
    this.note('reap', job);
  }

  createWatcher(_job: JobRow, sink: WatcherSink, options: WatchOptions): JobWatcher {
    this.watchOptions.push(options);
    return { tick: async (final = false) => { this.ticks += 1; this.onTick(this.ticks, final, sink); } };
  }

  async readStatus(job: JobRow): Promise<StatusView | null> {
    this.note('readStatus', job);
    if (this.statusError) throw this.statusError;
    return this.status;
  }

  async readPlan(job: JobRow): Promise<PlanCheck> {
    this.note('readPlan', job);
    return this.plan;
  }

  async finishPlan(job: JobRow): Promise<PlanPushOutcome> {
    this.note('finishPlan', job);
    return this.planPush;
  }

  async readFinishLedger(): Promise<{ branch: string; headSha: string } | null> {
    return this.ledger;
  }

  async collectBundle(job: JobRow): Promise<BundleFile> {
    this.note('collectBundle', job);
    if (this.bundleError) throw this.bundleError;
    return this.bundle;
  }

  async cleanup(job: JobRow): Promise<void> {
    this.note('cleanup', job);
  }
}
```

- [ ] **Step 2: Write the failing spec**

`supervisor/job-run.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { FleetJobKindName, SnapshotEventPayload, StateEventPayload } from '@nathapp/fleet-protocol';
import type { UploadOutcome } from '../bundle/upload-bundle';
import { Journal } from '../journal/journal';
import { createMemoryLogger } from '../logger';
import { assignFor } from '../../test/helpers/assign';
import { FakeExecutor } from '../../test/helpers/fake-executor';
import { fakeTime } from '../../test/helpers/fake-time';
import { waitFor } from '../../test/helpers/wait';
import type { EventRow } from '../journal/types';
import { JobRun, type BundleUploader, type JobRunDeps, type JobRunTuning } from './job-run';
import { RepoMutex } from './repo-mutex';

function build(command: FleetJobKindName = 'RUN', jobId = 'j1', tuning: Partial<JobRunTuning> = {}) {
  const time = fakeTime();
  const journal = Journal.open(':memory:', time.now);
  const ex = new FakeExecutor();
  const uploads: string[] = [];
  const outcomes: UploadOutcome[] = [];
  const uploader: BundleUploader = {
    upload: async (job, file) => {
      uploads.push(`${job.jobId}:${file.sha256.slice(0, 4)}`);
      return outcomes.shift() ?? { kind: 'ok' };
    },
  };
  const mutex = new RepoMutex();
  const log = createMemoryLogger();
  const deps: JobRunDeps = {
    journal, executor: ex, mutex, uploader, log, now: time.now, sleep: time.sleep,
    tuning: { statusPollMs: 2_000, killGraceMs: 30_000, ackPollMs: 250, uploadAckWaitMs: 0, ...tuning },   // 0: unit tests do not wait for acks unless they say so
  };
  journal.insertJob({ assign: assignFor(command, { jobId }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: `/w/.jobs/${jobId}` });
  return { time, journal, ex, outcomes, uploads, mutex, deps, log, acked: [] as EventRow[], run: new JobRun(deps, jobId, 1) };
}
type Built = ReturnType<typeof build>;
const events = (b: Built, jobId = 'j1') => b.journal.pendingEvents(jobId, 1, 1_000);
const states = (b: Built, jobId = 'j1') => events(b, jobId).filter((e) => e.type === 'state').map((e) => e.payload as StateEventPayload);
const stateNames = (b: Built) => states(b).map((s) => s.to);
/** What the server's ack does: the events leave `pendingEvents`, so they are kept in `b.acked` for the assertions. */
const ackAll = (b: Built) => {
  const pending = events(b);
  if (pending.length === 0) return;
  b.acked.push(...pending);
  b.journal.ackThrough('j1', 1, Math.max(...pending.map((e) => e.seq)));
};
const everything = (b: Built) => [...b.acked, ...events(b)];
const everyStateName = (b: Built) => everything(b).filter((e) => e.type === 'state').map((e) => (e.payload as StateEventPayload).to);
const pendingStates = (b: Built) => events(b).filter((e) => e.type === 'state').map((e) => (e.payload as StateEventPayload).to);
const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));
const lastSnapshot = (b: Built) => events(b).filter((e) => e.type === 'snapshot').at(-1)?.payload as SnapshotEventPayload | undefined;

describe('RUN happy path (D35)', () => {
  test('RUNNING -> UPLOADING -> COMPLETED, pid recorded with RUNNING, final snapshot with the ledger result, cleanup and done', async () => {
    const b = build();
    b.ex.dieAfterTicks(2);
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
    expect(b.journal.getJob('j1', 1)).toMatchObject({ state: 'COMPLETED', pid: 4242, pgid: 4242, branch: 'feat/x' });
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
    expect(lastSnapshot(b)).toMatchObject({ naxRunId: 'run-1', finishResult: 'opened', resultPrUrl: 'https://example.test/pr/1', resultBranch: 'feat/x', resultSha: 'b'.repeat(40) });
    expect(b.uploads).toEqual(['j1:cccc']);
    expect(b.ex.calls).toEqual(expect.arrayContaining(['prepare:j1', 'spawn:j1', 'reap:j1', 'collectBundle:j1', 'cleanup:j1']));
    expect(b.mutex.isLocked('acme/app')).toBe(false);
  });
  test('the watcher runs on every poll and once more after the process is gone', async () => {
    const b = build();
    b.ex.dieAfterTicks(3);
    await b.run.start('prepare');
    expect(b.ex.ticks).toBe(4);
    expect(b.time.nowMs() - Date.parse('2026-10-01T00:00:00.000Z')).toBe(2 * 2_000);
  });
  test('run ids the watcher reports are persisted for readopt', async () => {
    const b = build();
    b.ex.onTick = (n) => {
      if (n === 1) b.ex.watchOptions[0].onRunIds?.({ naxRunId: 'run-9', logPath: '/l.jsonl' });
      if (n >= 2) b.ex.alive = false;
    };
    await b.run.start('prepare');
    expect(b.journal.getJob('j1', 1)).toMatchObject({ naxRunId: 'run-9', logPath: '/l.jsonl' });
  });
});

describe('verdicts', () => {
  test('escalated keeps nax reason', async () => {
    const b = build();
    b.ex.status = { run: { id: 'r', status: 'completed' }, postRun: { finish: { result: 'escalated', escalationReason: 'blocked by review' } } };
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(states(b).at(-1)).toEqual({ to: 'ESCALATED', reason: 'blocked by review' });
  });
  test.each([
    ['failed', { run: { id: 'r', status: 'failed' } }, 'run status: failed'],
    ['crashed (status still running)', { run: { id: 'r', status: 'running' } }, 'run status: running'],
    ['no status.json', null, 'no status.json'],
  ])('%s is FAILED with the reason', async (_label, status, reason) => {
    const b = build();
    b.ex.status = status as never;
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason });
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'FAILED']);
  });
});

describe('failures before the process runs', () => {
  test('a failed prepare is ASSIGNED -> FAILED with the reason, no spawn, no bundle, cleanup, done', async () => {
    const b = build();
    b.ex.prepareResult = { ok: false, reason: 'checkout: ref not found' };
    await b.run.start('prepare');
    expect(states(b)).toEqual([{ to: 'FAILED', reason: 'checkout: ref not found' }]);
    expect(b.ex.calls).toEqual(['prepare:j1', 'cleanup:j1']);
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
    expect(b.uploads).toEqual([]);
  });
  test('a spawn that throws is FAILED with spawn failed', async () => {
    const b = build();
    b.ex.spawnError = new Error('ENOENT nax');
    await b.run.start('prepare');
    expect(states(b)).toEqual([{ to: 'FAILED', reason: 'spawn failed: ENOENT nax' }]);
  });
  test('a cancel while the job waits for the repo mutex ends ASSIGNED -> CANCELLED at once, holding nothing (D66)', async () => {
    const b = build();
    const release = await b.mutex.acquire('acme/app');            // another job holds the repo
    const started = b.run.start('prepare');
    expect(b.run.requestCancel()).toBe(true);
    // Still queued: the state event and the freed slot must already be there.
    expect(states(b)).toEqual([{ to: 'CANCELLED', reason: 'cancelled before start' }]);
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
    expect(b.run.requestCancel()).toBe(false);
    release();
    await started;
    expect(b.ex.calls).toEqual([]);                                // never prepared, spawned or cleaned
    expect(stateNames(b)).toEqual(['CANCELLED']);
    expect(b.mutex.isLocked('acme/app')).toBe(false);
  });
  test('a cancel that lands during prepare stops before the spawn', async () => {
    const b = build();
    const originalPrepare = b.ex.prepare.bind(b.ex);
    b.ex.prepare = async (job, options) => { b.run.requestCancel(); return originalPrepare(job, options); };
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['CANCELLED']);
    expect(b.ex.calls).not.toContain('spawn:j1');
  });
  test('prepare is given an isCancelled probe, and a prepare that reports cancelled is CANCELLED, not FAILED (D66)', async () => {
    const b = build();
    const originalPrepare = b.ex.prepare.bind(b.ex);
    let probeAfterCancel: boolean | undefined;
    b.ex.prepare = async (job, options) => {
      expect(options?.isCancelled?.()).toBe(false);
      b.run.requestCancel();
      probeAfterCancel = options?.isCancelled?.();
      await originalPrepare(job, options);
      return { ok: false, reason: 'cancelled', cancelled: true };
    };
    await b.run.start('prepare');
    expect(probeAfterCancel).toBe(true);
    expect(states(b)).toEqual([{ to: 'CANCELLED', reason: 'cancelled before start' }]);
    expect(b.ex.calls).not.toContain('spawn:j1');
  });
  test('reprepare reaps the registry before preparing again (a crash between spawn and RUNNING, D65)', async () => {
    const b = build();
    b.ex.dieAfterTicks(1);
    await b.run.start('reprepare');
    expect(b.ex.calls.slice(0, 2)).toEqual(['reap:j1', 'prepare:j1']);
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
  });
});

describe('cancel while running', () => {
  test('SIGTERM to the group, then the normal flow ends CANCELLED through UPLOADING with the partial bundle', async () => {
    const b = build();
    b.ex.status = { run: { id: 'r', status: 'crashed' } };       // nax writes crashed on SIGTERM
    let accepted: boolean | null = null;
    b.ex.onTick = (n) => { if (n === 2) accepted = b.run.requestCancel(); };   // no expect here: JobRun.tick swallows a throw
    await b.run.start('prepare');
    expect(accepted).toBe(true);
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGTERM' }]);
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'CANCELLED']);
    expect(b.uploads).toHaveLength(1);
    expect(b.ex.calls).toContain('reap:j1');
    expect(b.journal.getJob('j1', 1)?.cancelRequestedAt).not.toBeNull();
  });
  test('a process that ignores SIGTERM is killed after the grace period', async () => {
    const b = build();
    b.ex.onKill = (signal) => { if (signal === 'SIGKILL') b.ex.alive = false; };
    b.ex.onTick = (n) => { if (n === 1) b.run.requestCancel(); };
    await b.run.start('prepare');
    expect(b.ex.killed.map((k) => k.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(b.time.nowMs() - Date.parse('2026-10-01T00:00:00.000Z')).toBeGreaterThanOrEqual(30_000);
    expect(states(b).at(-1)?.to).toBe('CANCELLED');
  });
  test('cancelling twice sends one SIGTERM; cancelling a finished job is refused', async () => {
    const b = build();
    b.ex.onTick = (n) => { if (n === 1) { b.run.requestCancel(); b.run.requestCancel(); } if (n >= 3) b.ex.alive = false; };
    await b.run.start('prepare');
    expect(b.ex.killed.filter((k) => k.signal === 'SIGTERM')).toHaveLength(1);
    expect(b.run.requestCancel()).toBe(false);
  });
});

describe('PLAN', () => {
  test('a valid plan is pushed while RUNNING, then bundled; the push result rides the final snapshot', async () => {
    const b = build('PLAN');
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
    expect(b.ex.calls.indexOf('finishPlan:j1')).toBeLessThan(b.ex.calls.indexOf('collectBundle:j1'));
    expect(lastSnapshot(b)).toMatchObject({ resultBranch: 'feat/x', resultSha: 'a'.repeat(40) });
    expect(b.journal.getJob('j1', 1)).toMatchObject({ resultBranch: 'feat/x', resultSha: 'a'.repeat(40) });
  });
  test('a failed push is FAILED with its reason and the bundle is still uploaded', async () => {
    const b = build('PLAN');
    b.ex.planPush = { ok: false, reason: 'plan push failed' };
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'plan push failed' });
    expect(b.uploads).toHaveLength(1);
  });
  test('an invalid plan is FAILED and nothing is pushed', async () => {
    const b = build('PLAN');
    b.ex.plan = { ok: false, reason: 'prd.json has no userStories', branchName: null };
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'prd.json has no userStories' });
    expect(b.ex.calls).not.toContain('finishPlan:j1');
  });
  test('a resume after the push was recorded does not push again (Review focus 5)', async () => {
    const b = build('PLAN');
    b.journal.updateJob('j1', 1, { state: 'UPLOADING', resultBranch: 'feat/x', resultSha: 'd'.repeat(40), pid: 1, pgid: 1 });
    await b.run.start('finish');
    expect(b.ex.calls).not.toContain('finishPlan:j1');
    expect(stateNames(b)).toEqual(['COMPLETED']);
    expect(lastSnapshot(b)).toMatchObject({ resultSha: 'd'.repeat(40) });
  });
});

describe('bundle outcomes (D36, D49)', () => {
  test('a failed upload ends in the verdict state with a reason; a FAILED verdict keeps its reason first', async () => {
    const ok = build();
    ok.outcomes.push({ kind: 'failed', detail: 'HTTP 500' });
    ok.ex.dieAfterTicks(1);
    await ok.run.start('prepare');
    expect(states(ok).at(-1)).toEqual({ to: 'COMPLETED', reason: 'bundle upload failed' });
    const bad = build();
    bad.outcomes.push({ kind: 'failed', detail: 'HTTP 500' });
    bad.ex.status = { run: { id: 'r', status: 'failed' } };
    bad.ex.dieAfterTicks(1);
    await bad.run.start('prepare');
    expect(states(bad).at(-1)).toEqual({ to: 'FAILED', reason: 'run status: failed; bundle upload failed' });
  });
  test('413 ends with bundle too large', async () => {
    const b = build();
    b.outcomes.push({ kind: 'too-large' });
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(states(b).at(-1)).toEqual({ to: 'COMPLETED', reason: 'bundle too large' });
  });
  test('a stale lease parks the job: no terminal event, not done, the mutex is released', async () => {
    const b = build();
    b.outcomes.push({ kind: 'stale' });
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING']);
    expect(b.journal.getJob('j1', 1)?.doneAt).toBeNull();
    expect(b.mutex.isLocked('acme/app')).toBe(false);
  });
  test('a bundle that cannot be built fails the upload step, not the runner', async () => {
    const b = build();
    b.ex.bundleError = new Error('tar failed');
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(states(b).at(-1)).toEqual({ to: 'COMPLETED', reason: 'bundle upload failed' });
  });
  test('files left out of the bundle for an unsafe name are a lifecycle warning (D68)', async () => {
    const b = build();
    b.ex.bundle = { ...b.ex.bundle, skipped: ['nax-out/two\nlines.txt'] };
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(events(b).some((e) => e.type === 'lifecycle' && JSON.stringify(e.payload).includes('left out 1 file'))).toBe(true);
    expect(states(b).at(-1)?.to).toBe('COMPLETED');
  });
});

describe('the upload waits for the server to have applied UPLOADING (D60)', () => {
  /** A sleep that acks the journal on every ack-poll from the `n`-th on, like the sync loop would. */
  function withAckOnPoll(b: Built, n: number, seen: { polls: number }): JobRun {
    const sleep = async (ms: number) => {
      await b.time.sleep(ms);
      if (ms === 250) {
        seen.polls += 1;
        if (seen.polls >= n) ackAll(b);
      }
    };
    return new JobRun({ ...b.deps, sleep }, 'j1', 1);
  }
  test('polls until the UPLOADING event is acked, then uploads exactly once', async () => {
    const b = build('RUN', 'j1', { uploadAckWaitMs: 60_000 });
    let pendingAtUpload: string[] = [];
    const uploader: BundleUploader = { upload: async () => { pendingAtUpload = pendingStates(b); b.uploads.push('j1'); return { kind: 'ok' }; } };
    const seen = { polls: 0 };
    b.ex.dieAfterTicks(1);
    const run = withAckOnPoll({ ...b, deps: { ...b.deps, uploader } } as Built, 3, seen);
    await run.start('prepare');
    expect(seen.polls).toBe(3);
    expect(pendingAtUpload).not.toContain('UPLOADING');           // the ack had covered it
    expect(b.uploads).toEqual(['j1']);
    expect(everyStateName(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
  });
  test('gives up waiting after the bound, warns, and uploads anyway', async () => {
    const b = build('RUN', 'j1', { uploadAckWaitMs: 1_000 });
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');                                  // nobody acks
    expect(b.uploads).toHaveLength(1);
    expect(events(b).some((e) => e.type === 'lifecycle' && JSON.stringify(e.payload).includes('not acked in time'))).toBe(true);
    expect(states(b).at(-1)?.to).toBe('COMPLETED');
  });
  test('a state-conflict is retried once after the pending events are acked, and then the verdict stands', async () => {
    const b = build('RUN', 'j1', { uploadAckWaitMs: 60_000 });
    b.outcomes.push({ kind: 'state-conflict', detail: 'The job is ASSIGNED; this action is not allowed' }, { kind: 'ok' });
    b.ex.dieAfterTicks(1);
    const seen = { polls: 0 };
    await withAckOnPoll(b, 1, seen).start('prepare');
    expect(b.uploads).toHaveLength(2);
    expect(everything(b).some((e) => e.type === 'lifecycle' && JSON.stringify(e.payload).includes('retrying after the next ack'))).toBe(true);
    expect(everyStateName(b).at(-1)).toBe('COMPLETED');
  });
  test('a second state-conflict ends the job locally: lifecycle error, no terminal event, done, slot released', async () => {
    const b = build('RUN', 'j1', { uploadAckWaitMs: 60_000 });
    const conflict: UploadOutcome = { kind: 'state-conflict', detail: 'The job is COMPLETED; this action is not allowed' };
    b.outcomes.push(conflict, conflict);
    b.ex.dieAfterTicks(1);
    await withAckOnPoll(b, 1, { polls: 0 }).start('prepare');
    expect(b.uploads).toHaveLength(2);
    expect(everyStateName(b)).toEqual(['RUNNING', 'UPLOADING']);   // no COMPLETED, no FAILED
    expect(everything(b).filter((e) => e.type === 'lifecycle' && (e.payload as { level: string }).level === 'error')).toHaveLength(1);
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
    expect(b.journal.activeCount()).toBe(0);
    expect(b.ex.calls).toContain('cleanup:j1');
    expect(b.mutex.isLocked('acme/app')).toBe(false);
  });
});

describe('runner errors', () => {
  test('an exception while RUNNING goes through UPLOADING to FAILED with a reason', async () => {
    const b = build();
    b.ex.statusError = new Error('disk vanished');
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'FAILED']);
    expect(states(b).at(-1)?.reason).toBe('runner error: disk vanished');
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
  });
  test('a runner error with the nax still alive kills its group before reaping and failing the job (D65)', async () => {
    const b = build();
    const run = new JobRun({ ...b.deps, sleep: async () => { throw new Error('clock exploded'); } }, 'j1', 1);
    b.ex.onTick = () => undefined;                                  // nax never exits on its own
    await run.start('prepare');
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGKILL' }]);
    expect(b.ex.calls.indexOf('reap:j1')).toBeGreaterThan(-1);
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'FAILED']);
    expect(states(b).at(-1)?.reason).toBe('runner error: clock exploded');
  });
  test('a runner error whose pid is not this job\'s nax (recycled) signals nothing', async () => {
    const b = build();
    b.ex.procMatches = false;
    const run = new JobRun({ ...b.deps, sleep: async () => { throw new Error('clock exploded'); } }, 'j1', 1);
    b.ex.onTick = () => undefined;
    await run.start('prepare');
    expect(b.ex.killed).toEqual([]);
    expect(states(b).at(-1)?.to).toBe('FAILED');
  });
  test('a watcher that throws is logged as a lifecycle warning and the job continues', async () => {
    const b = build();
    b.ex.onTick = (n) => { if (n === 1) throw new Error('bad tick'); if (n >= 3) b.ex.alive = false; };
    await b.run.start('prepare');
    expect(events(b).some((e) => e.type === 'lifecycle' && JSON.stringify(e.payload).includes('watcher error: bad tick'))).toBe(true);
    expect(states(b).at(-1)?.to).toBe('COMPLETED');
  });
});

describe('resume (readopt)', () => {
  test('watch attaches with startAtEnd and never re-runs prepare or spawn; a cancel recorded while down is re-sent', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242, naxRunId: 'run-1', cancelRequestedAt: '2026-10-01T00:00:00.000Z' });
    b.ex.alive = true;
    b.ex.status = { run: { id: 'run-1', status: 'crashed' } };
    b.ex.dieAfterTicks(2);
    await b.run.start('watch');
    expect(b.ex.watchOptions[0].startAtEnd).toBe(true);
    expect(b.ex.calls).not.toContain('prepare:j1');
    expect(b.ex.calls).not.toContain('spawn:j1');
    expect(b.ex.killed[0]).toEqual({ pgid: 4242, signal: 'SIGTERM' });
    expect(stateNames(b)).toEqual(['UPLOADING', 'CANCELLED']);
  });
  test('finish from UPLOADING does not emit UPLOADING again', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'UPLOADING', pid: 4242, pgid: 4242 });
    await b.run.start('finish');
    expect(stateNames(b)).toEqual(['COMPLETED']);
    expect(events(b).some((e) => e.type === 'lifecycle')).toBe(false);
  });
  test('a job whose terminal event was journaled before the crash is only cleaned up', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'COMPLETED' });
    await b.run.start('finish');
    expect(b.uploads).toEqual([]);
    expect(b.ex.calls).toEqual(['cleanup:j1']);
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
  });
});

describe('abandon and halt', () => {
  test('abandon kills a group that is still this job, drops the epoch and stops the run quietly', async () => {
    const b = build();
    b.ex.onTick = () => undefined;
    const running = b.run.start('prepare');
    await waitFor(() => b.ex.calls.includes('spawn:j1') && b.ex.ticks >= 1);
    await b.run.abandon();
    await running;
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGKILL' }]);
    expect(b.journal.getJob('j1', 1)).toBeNull();
    expect(b.journal.pendingEvents('j1', 1, 100)).toEqual([]);
    expect(b.uploads).toEqual([]);
    expect(b.ex.calls).toContain('cleanup:j1');
  });
  test('abandon of a lower epoch kills its group but leaves the reap and the profile to the live higher epoch (D64)', async () => {
    const b = build();
    b.ex.onTick = () => undefined;
    const running = b.run.start('prepare');
    await waitFor(() => b.ex.calls.includes('spawn:j1') && b.ex.ticks >= 1);
    b.journal.insertJob({ assign: assignFor('RUN'), leaseEpoch: 2, repoKey: 'acme/app', jobDir: '/w/.jobs/j1' });   // the requeued attempt
    const callsBefore = b.ex.calls.length;
    await b.run.abandon();
    await running;
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGKILL' }]);       // that pid is epoch 1's
    expect(b.ex.calls.slice(callsBefore)).toEqual([]);                        // no reap, no cleanup: they would hit epoch 2's files
    expect(b.journal.getJob('j1', 1)).toBeNull();
    expect(b.journal.getJob('j1', 2)).not.toBeNull();
  });
  test('abandon waits for the repo mutex (D64): cleanup never overlaps another job\'s prepare', async () => {
    const b = build();
    b.ex.onTick = () => undefined;
    const running = b.run.start('prepare');
    await waitFor(() => b.ex.ticks >= 1);
    const outsider = b.mutex.acquire('acme/app');                              // another job queued behind the running one
    let abandoned = false;
    const done = b.run.abandon().then(() => { abandoned = true; });           // halts the run; its cleanup queues after the outsider
    await running;                                                             // the halted run lets go of the repo ...
    const release = await outsider;                                            // ... and the other job now holds it
    await settle();
    expect(abandoned).toBe(false);
    expect(b.ex.calls).not.toContain('cleanup:j1');
    release();
    await done;
    expect(abandoned).toBe(true);
    expect(b.ex.calls).toContain('cleanup:j1');
  });
  test('a recycled pid (not this job) is not signalled on abandon', async () => {
    const b = build();
    const running = b.run.start('prepare');
    await waitFor(() => b.ex.ticks >= 1);
    b.ex.procMatches = false;
    await b.run.abandon();
    await running;
    expect(b.ex.killed).toEqual([]);
  });
  test('halt stops emitting and leaves the child alone', async () => {
    const b = build();
    const running = b.run.start('prepare');
    await waitFor(() => b.ex.ticks >= 1);
    b.run.halt();
    await running;
    expect(b.ex.killed).toEqual([]);
    expect(stateNames(b)).toEqual(['RUNNING']);
    expect(b.journal.getJob('j1', 1)?.doneAt).toBeNull();
  });
});

describe('two jobs on one repo', () => {
  test('the second job does not prepare until the first has cleaned up', async () => {
    const first = build('RUN', 'j1');
    first.ex.dieAfterTicks(1);
    const journal = first.journal;
    journal.insertJob({ assign: assignFor('RUN', { jobId: 'j2', feature: 'other' }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/w/.jobs/j2' });
    const second = new JobRun({ ...first.deps }, 'j2', 1);
    const a = first.run.start('prepare');
    const b = second.start('prepare');
    await Promise.all([a, b]);
    const order = first.ex.calls.filter((c) => /^(prepare|cleanup):/.test(c));
    expect(order).toEqual(['prepare:j1', 'cleanup:j1', 'prepare:j2', 'cleanup:j2']);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd apps/runner && bun test src/supervisor/job-run.spec.ts`
Expected: FAIL (module missing).

- [ ] **Step 4: Implement**

`supervisor/kill-if-ours.ts`:

```ts
import { errorMessage } from '../errors';
import type { JobExecutor } from '../executor/job-executor';
import type { JobRow } from '../journal/types';
import type { Logger } from '../logger';

/**
 * D65: SIGKILL the job's whole process group, but only while the journaled pid is still this job's nax (its argv carries
 * `koda-job-<jobId>`). A recycled pid is never signalled. Used by abandon, a runner error and READOPT rejection.
 */
export async function killIfOurs(executor: JobExecutor, row: JobRow, log: Logger): Promise<boolean> {
  if (row.pid === null || row.pgid === null) return false;
  try {
    if (!(await executor.matchesProcess(row))) return false;
    executor.kill(row.pgid, 'SIGKILL');
    return true;
  } catch (error) {
    log.warn('kill of the job process failed', { jobId: row.jobId, error: errorMessage(error) });
    return false;
  }
}
```

`supervisor/job-run.ts`:

```ts
import type { SnapshotEventPayload, StateEventPayload } from '@nathapp/fleet-protocol';
import type { BundleFile } from '../bundle/build-bundle';
import type { UploadOutcome } from '../bundle/upload-bundle';
import { errorMessage } from '../errors';
import type { JobExecutor, JobWatcher } from '../executor/job-executor';
import type { Journal } from '../journal/journal';
import type { JobRow } from '../journal/types';
import type { Logger } from '../logger';
import type { Now, Sleep } from '../time';
import { planVerdict } from '../verdict/plan-verdict';
import { runVerdict, type Verdict } from '../verdict/run-verdict';
import { mapStatusToSnapshot } from '../watcher/status-snapshot';
import { JobEvents } from './job-events';
import { killIfOurs } from './kill-if-ours';
import type { RepoMutex } from './repo-mutex';
import { isTerminalState } from './transitions';

export interface BundleUploader {
  upload(job: JobRow, file: BundleFile, rebuild: () => Promise<BundleFile>): Promise<UploadOutcome>;
}

export interface JobRunTuning {
  readonly statusPollMs: number;
  readonly killGraceMs: number;
  /** D60: how often, and for how long, the run waits for the server to ack its UPLOADING event. 0 waits for nothing. */
  readonly ackPollMs: number;
  readonly uploadAckWaitMs: number;
}

export interface JobRunDeps {
  readonly journal: Journal;
  readonly executor: JobExecutor;
  readonly mutex: RepoMutex;
  readonly uploader: BundleUploader;
  readonly log: Logger;
  readonly now: Now;
  readonly sleep: Sleep;
  readonly tuning: JobRunTuning;
}

export type RunStart = 'prepare' | 'reprepare' | 'watch' | 'finish';

const TICK_WARN_EVERY = 30;
const PENDING_SCAN_LIMIT = 100_000;

function terminalReason(verdict: Verdict, outcome: UploadOutcome): string | undefined {
  if (outcome.kind === 'too-large') return 'bundle too large';
  if (outcome.kind === 'failed') return verdict.state === 'FAILED' && verdict.reason ? `${verdict.reason}; bundle upload failed` : 'bundle upload failed';
  return verdict.reason ?? undefined;
}

/** One job, from ASSIGN to cleanup (design §2). Only legal S1 §5.4 transitions are ever emitted (JobEvents refuses the rest). */
export class JobRun {
  private readonly events: JobEvents;
  private cancelSentAtMs: number | null = null;
  private sigkilled = false;
  private halted = false;
  private queued = false;
  private tickErrors = 0;

  constructor(private readonly deps: JobRunDeps, readonly jobId: string, readonly leaseEpoch: number) {
    this.events = new JobEvents(deps.journal, jobId, leaseEpoch, deps.log);
  }

  private row(): JobRow | null {
    return this.deps.journal.getJob(this.jobId, this.leaseEpoch);
  }

  private mustRow(): JobRow {
    const row = this.row();
    if (!row) throw new Error('job row is gone');
    return row;
  }

  async start(from: RunStart): Promise<void> {
    const first = this.row();
    if (!first) return;
    this.queued = from === 'prepare' || from === 'reprepare';
    const release = await this.deps.mutex.acquire(first.repoKey);
    this.queued = false;
    try {
      const current = this.row();
      if (current === null || current.doneAt !== null) return;   // abandoned, or cancelled while queued (D66)
      await this.lifecycle(from);
    } catch (error) {
      await this.failSafe(error);
    } finally {
      release();
    }
  }

  private async lifecycle(from: RunStart): Promise<void> {
    if ((from === 'prepare' || from === 'reprepare') && !(await this.prepareAndSpawn(from === 'reprepare'))) return;
    if (from !== 'finish') await this.watchUntilExit(from === 'watch');
    if (this.halted) return;
    await this.finish();
  }

  requestCancel(): boolean {
    const row = this.row();
    if (!row || isTerminalState(row.state)) return false;
    if (this.queued && row.state === 'ASSIGNED') {
      this.endWhileQueued();
      return true;
    }
    if (row.cancelRequestedAt === null) this.deps.journal.updateJob(this.jobId, this.leaseEpoch, { cancelRequestedAt: this.deps.now().toISOString() });
    if (row.state === 'RUNNING') this.sendTerm(row);
    return true;
  }

  /** D66: still waiting for the repo mutex, nothing prepared: end at once and free the slot. `start` sees `doneAt` and lets go. */
  private endWhileQueued(): void {
    this.deps.journal.updateJob(this.jobId, this.leaseEpoch, { cancelRequestedAt: this.deps.now().toISOString() });
    this.events.transition('CANCELLED', 'cancelled before start');
    this.deps.journal.markDone(this.jobId, this.leaseEpoch);
  }

  private sendTerm(row: JobRow): void {
    if (this.cancelSentAtMs !== null || row.pgid === null) return;
    this.deps.executor.kill(row.pgid, 'SIGTERM');
    this.cancelSentAtMs = this.deps.now().getTime();
  }

  private cancelRequested(): boolean {
    return this.row()?.cancelRequestedAt != null;
  }

  halt(): void {
    this.halted = true;
  }

  private async reapQuietly(row: JobRow): Promise<void> {
    await this.deps.executor.reap(row, new Date(row.createdAt)).catch((error) => {
      this.deps.log.warn('reap failed', { jobId: this.jobId, error: errorMessage(error) });
    });
  }

  private higherEpochLive(): boolean {
    return this.deps.journal.jobsById(this.jobId).some((other) => other.leaseEpoch > this.leaseEpoch && other.doneAt === null);
  }

  async abandon(): Promise<void> {
    this.halted = true;
    const row = this.row();
    if (!row) return;
    // The halted run lets go of the repo mutex as soon as it notices; cleanup must not overlap another job's prepare.
    const release = await this.deps.mutex.acquire(row.repoKey);
    try {
      const current = this.row();
      if (current) await this.abandonCleanup(current);
    } finally {
      this.deps.journal.abandon(this.jobId, this.leaseEpoch);
      release();
    }
  }

  private async abandonCleanup(row: JobRow): Promise<void> {
    try {
      await killIfOurs(this.deps.executor, row, this.deps.log);   // safe for a lower epoch too: that pid is this epoch's own
      if (this.higherEpochLive()) {
        this.deps.log.info('abandon leaves reap and cleanup to the live higher epoch', { jobId: this.jobId, leaseEpoch: this.leaseEpoch });
        return;
      }
      await this.deps.executor.reap(row, new Date(row.createdAt));
      await this.deps.executor.cleanup(row);
    } catch (error) {
      this.deps.log.warn('abandon cleanup failed', { jobId: this.jobId, error: errorMessage(error) });
    }
  }

  private async prepareAndSpawn(reprepare: boolean): Promise<boolean> {
    const row = this.mustRow();
    if (this.cancelRequested()) return this.endBeforeSpawn('CANCELLED', 'cancelled before start');
    if (reprepare) await this.reapQuietly(row);   // D65: a nax spawned just before the crash may have registered pids
    const prepared = await this.deps.executor.prepare(row, { isCancelled: () => this.cancelRequested() });
    if (this.halted) return false;
    if (!prepared.ok) return prepared.cancelled ? this.endBeforeSpawn('CANCELLED', 'cancelled before start') : this.endBeforeSpawn('FAILED', prepared.reason);
    if (this.cancelRequested()) return this.endBeforeSpawn('CANCELLED', 'cancelled before start');
    let handle;
    try {
      handle = await this.deps.executor.spawn(row);
    } catch (error) {
      return this.endBeforeSpawn('FAILED', `spawn failed: ${errorMessage(error)}`);
    }
    this.events.transition('RUNNING', undefined, { pid: handle.pid, pgid: handle.pgid, branch: prepared.branch });
    return true;
  }

  private async endBeforeSpawn(to: 'FAILED' | 'CANCELLED', reason: string): Promise<false> {
    this.events.transition(to, reason);
    await this.cleanup();
    return false;
  }

  private async tick(watcher: JobWatcher, final: boolean): Promise<void> {
    try {
      await watcher.tick(final);
    } catch (error) {
      this.tickErrors += 1;
      if (this.tickErrors % TICK_WARN_EVERY === 1) this.events.lifecycle('warn', `watcher error: ${errorMessage(error)}`);
    }
  }

  private escalateKill(row: JobRow): void {
    if (this.cancelSentAtMs === null || this.sigkilled || row.pgid === null) return;
    if (this.deps.now().getTime() - this.cancelSentAtMs < this.deps.tuning.killGraceMs) return;
    this.sigkilled = true;
    this.events.lifecycle('warn', 'process ignored SIGTERM; sending SIGKILL');
    this.deps.executor.kill(row.pgid, 'SIGKILL');
  }

  private async watchUntilExit(resumed: boolean): Promise<void> {
    const start = this.mustRow();
    const watcher = this.deps.executor.createWatcher(start, this.events, {
      startAtEnd: resumed,
      onRunIds: (ids) => { this.deps.journal.updateJob(this.jobId, this.leaseEpoch, { naxRunId: ids.naxRunId, logPath: ids.logPath }); },
    });
    if (start.cancelRequestedAt !== null && start.state === 'RUNNING') this.sendTerm(start);
    for (;;) {
      await this.tick(watcher, false);
      if (this.halted) return;
      const row = this.mustRow();
      if (row.pid === null || !this.deps.executor.isAlive(row.pid)) break;
      this.escalateKill(row);
      await this.deps.sleep(this.deps.tuning.statusPollMs);
      if (this.halted) return;
    }
    await this.tick(watcher, true);
    await this.reapQuietly(this.mustRow());
  }

  private async judge(row: JobRow): Promise<{ verdict: Verdict; snapshot: SnapshotEventPayload }> {
    const cancelled = row.cancelRequestedAt !== null;
    if (row.command === 'PLAN') {
      const check = await this.deps.executor.readPlan(row);
      return { verdict: planVerdict({ cancelRequested: cancelled, check }), snapshot: {} };
    }
    const status = await this.deps.executor.readStatus(row);
    return { verdict: runVerdict({ cancelRequested: cancelled, status }), snapshot: status ? mapStatusToSnapshot(status) : {} };
  }

  private async finish(): Promise<void> {
    const row = this.mustRow();
    if (isTerminalState(row.state)) {
      await this.cleanup();
      return;
    }
    const judged = await this.judge(row);
    let verdict = judged.verdict;
    let result = { branch: row.resultBranch, sha: row.resultSha };
    if (row.command === 'PLAN' && verdict.state === 'COMPLETED' && row.resultSha === null) {
      const pushed = await this.deps.executor.finishPlan(row);
      if (pushed.ok) {
        result = { branch: pushed.branch, sha: pushed.sha };
        this.deps.journal.updateJob(this.jobId, this.leaseEpoch, { resultBranch: pushed.branch, resultSha: pushed.sha });
      } else {
        verdict = { state: 'FAILED', reason: pushed.reason };
      }
    } else if (row.command === 'RUN') {
      const ledger = await this.deps.executor.readFinishLedger(row);
      if (ledger) result = { branch: ledger.branch, sha: ledger.headSha };
    }
    if (this.halted) return;
    if (this.events.currentState() === 'RUNNING') this.events.transition('UPLOADING');
    if (!(await this.waitUntil(() => !this.uploadingPending())) && !this.halted) {
      this.events.lifecycle('warn', 'UPLOADING event not acked in time; uploading anyway');
    }
    if (this.halted) return;
    const outcome = await this.uploadWithConflictRetry(row);
    if (this.halted) return;
    if (outcome.kind === 'stale') {
      this.deps.log.warn('bundle upload fenced (stale lease); waiting for ABANDON', { jobId: this.jobId, leaseEpoch: this.leaseEpoch });
      return;
    }
    if (outcome.kind === 'state-conflict') {
      // D60: the server will not take this job's bundle at this epoch and sends no ABANDON. It owns the job's state; report nothing more.
      this.events.lifecycle('error', `bundle upload refused twice (${outcome.detail}); ending the job locally, the server owns its state`);
      await this.cleanup();
      return;
    }
    const snapshot: SnapshotEventPayload = {
      ...judged.snapshot, ...(result.branch ? { resultBranch: result.branch } : {}), ...(result.sha ? { resultSha: result.sha } : {}),
    };
    if (Object.keys(snapshot).length > 0) this.events.snapshot(snapshot);
    this.events.transition(verdict.state, terminalReason(verdict, outcome));
    await this.cleanup();
  }

  /** D60: true when the journal holds no unacked UPLOADING state event (the server has applied it). */
  private uploadingPending(): boolean {
    return this.deps.journal.pendingEvents(this.jobId, this.leaseEpoch, PENDING_SCAN_LIMIT)
      .some((event) => event.type === 'state' && (event.payload as StateEventPayload).to === 'UPLOADING');
  }

  private hasPendingEvents(): boolean {
    return this.deps.journal.pendingEvents(this.jobId, this.leaseEpoch, 1).length > 0;
  }

  /** Bounded wait on the injected clock. `uploadAckWaitMs <= 0` waits for nothing and reports success. */
  private async waitUntil(done: () => boolean): Promise<boolean> {
    const { uploadAckWaitMs, ackPollMs } = this.deps.tuning;
    if (uploadAckWaitMs <= 0) return true;
    const deadline = this.deps.now().getTime() + uploadAckWaitMs;
    while (!done()) {
      if (this.halted || this.deps.now().getTime() >= deadline) return false;
      await this.deps.sleep(ackPollMs);
    }
    return true;
  }

  /** D60: a 409 that says "wrong job state" may just mean the server has not applied our events yet: retry once after they are acked. */
  private async uploadWithConflictRetry(row: JobRow): Promise<UploadOutcome> {
    const first = await this.uploadBundle(row);
    if (first.kind !== 'state-conflict') return first;
    this.events.lifecycle('warn', `bundle upload refused (${first.detail}); retrying after the next ack`);
    await this.waitUntil(() => !this.hasPendingEvents());
    return this.halted ? first : this.uploadBundle(row);
  }

  private async uploadBundle(row: JobRow): Promise<UploadOutcome> {
    let file: BundleFile;
    try {
      file = await this.deps.executor.collectBundle(row);
    } catch (error) {
      this.deps.log.error('bundle build failed', { jobId: this.jobId, error: errorMessage(error) });
      return { kind: 'failed', detail: `bundle build failed: ${errorMessage(error)}` };
    }
    if (file.skipped && file.skipped.length > 0) {
      this.events.lifecycle('warn', `bundle left out ${file.skipped.length} file(s) whose names have a newline or backslash: ${JSON.stringify(file.skipped.slice(0, 3))}`);
    }
    return this.deps.uploader.upload(row, file, () => this.deps.executor.collectBundle(row));
  }

  private async cleanup(): Promise<void> {
    const row = this.row();
    if (!row) return;
    try {
      await this.deps.executor.cleanup(row);
    } catch (error) {
      this.deps.log.warn('cleanup failed', { jobId: this.jobId, error: errorMessage(error) });
    }
    this.deps.journal.markDone(this.jobId, this.leaseEpoch);
  }

  /** A runner error must still end the job with a legal transition: RUNNING has no direct way to FAILED. */
  private async failSafe(error: unknown): Promise<void> {
    if (this.halted) return;
    this.deps.log.error('job run failed', { jobId: this.jobId, error: errorMessage(error) });
    try {
      // D65: a nax that is still running must not outlive the job's terminal report (the repo mutex is about to be released).
      const row = this.row();
      if (row) {
        await killIfOurs(this.deps.executor, row, this.deps.log);
        await this.reapQuietly(row);
      }
      if (this.events.currentState() === 'RUNNING') this.events.transition('UPLOADING');
      this.events.transition('FAILED', `runner error: ${errorMessage(error)}`);
      await this.cleanup();
    } catch (inner) {
      this.deps.log.error('job failure could not be recorded', { jobId: this.jobId, error: errorMessage(inner) });
    }
  }
}
```

- [ ] **Step 5: Run and lint**

```bash
cd apps/runner && bun test src/supervisor && bun run type-check && bun run lint
```
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add apps/runner
git commit -m "feat(fleet): JobRun (RUN and PLAN lifecycle, cancel, bundle outcomes, resume) over the executor seam"
```

---

### Task 21: Supervisor, ASSIGN validation, command handling, READOPT, ABANDON

**Files:**
- Create: `apps/runner/src/supervisor/assign-parser.ts`, `assign-parser.spec.ts`
- Create: `apps/runner/src/supervisor/supervisor.ts`, `supervisor.spec.ts`
- Create: `apps/runner/src/supervisor/command-handler.ts`, `command-handler.spec.ts`

**Interfaces:**
- Consumes: `JobRun`, `JobRunDeps`, `RunStart` (20), `Journal` (8), assign helpers (6, 14), `assertCloneUrl` (12), `isFinalStatus` (11), `FleetCommandOut`, `CommandAck`.
- Produces:
  ```ts
  // assign-parser.ts
  export type ParsedAssign = { ok: true; assign: AssignPayload } | { ok: false; detail: string };
  export function parseAssign(command: FleetCommandOut): ParsedAssign;            // D30: every path-bound field re-validated; returns a copy of the validated fields only
  // supervisor.ts
  export interface SupervisorDeps extends JobRunDeps { readonly readoptHeartbeatMs: number }
  export type ReadoptResult = { result: 'ok' | 'rejected'; detail?: string };
  export class Supervisor {
    constructor(deps: SupervisorDeps);
    begin(row: JobRow, from: RunStart): void;                                      // no-op when that (job, epoch) already has a run
    cancel(jobId: string, leaseEpoch: number): 'ok' | 'unknown';
    abandon(jobId: string, leaseEpoch: number): Promise<void>;                     // through JobRun.abandon (repo mutex, epoch-safe cleanup, D64)
    abandonAll(jobId: string): Promise<void>;                                     // every epoch of a job the server does not know
    readopt(jobId: string, leaseEpoch: number): Promise<ReadoptResult>;
    shutdown(): void;                                                             // halt every run, touch no child
    idle(): Promise<void>;                                                        // resolves when every run has ended (tests)
  }
  // command-handler.ts
  export interface CommandHandlerDeps { readonly journal: Journal; readonly supervisor: Supervisor; readonly workspaceRoot: string; readonly log: Logger; readonly now: Now }
  export class CommandHandler { constructor(deps: CommandHandlerDeps); handle(commands: readonly FleetCommandOut[]): Promise<CommandAck[]> }   // never throws; sequential
  ```
  Rules (slice 3 design §1.3): `ASSIGN` inserts the job row and the applied-command row in one transaction, acks `ok`, then abandons every lower-epoch row of the same `jobId` (D64: kill, drop; their files and profile are left to the new epoch's `prepare`, D53) and only then starts preparation; a repeated `commandId`, or the same `(jobId, leaseEpoch)` under a new one, is acked with the stored result and never re-run, **except** that when the journaled row is `ASSIGNED`, has no pid and is not done (a run lost in a restart) the run is started again from `reprepare` (D63; a no-op while a run exists); an invalid payload is acked `rejected` with a short fixed detail (the server then FAILs the job, per the 2b plan). `CANCEL` acks `ok` after the SIGTERM has been sent (or the cancel recorded), `rejected` with `does not hold job` for an unknown job. `ABANDON` is keyed by `(jobId, leaseEpoch)`. `READOPT` (D33, D54): unknown -> rejected; a run already attached -> ok; a terminal journal state -> cleanup, ok; `ASSIGNED` with no pid -> ok and `reprepare` (reaps first, D65); RUN: pid alive, `status.json` `run.id` equals the journaled `naxRunId` and the heartbeat is under `readoptHeartbeatMs` -> ok and watch; pid gone, status final and matching -> ok and finish; anything else -> `SIGKILL` the group when the pid is still this job's nax (D65), then reap, cleanup, mark done, rejected; PLAN (no `status.json`, D54): the pid is ours when alive and its command line carries `koda-job-<jobId>` -> watch, otherwise -> finish (the verdict comes from the files).

- [ ] **Step 1: Write the failing specs**

`supervisor/assign-parser.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { FleetCommandOut } from '@nathapp/fleet-protocol';
import { assignFor } from '../../test/helpers/assign';
import { parseAssign } from './assign-parser';

const cmd = (payload: unknown, over: Partial<FleetCommandOut> = {}): FleetCommandOut => ({ commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: payload as never, ...over });

describe('parseAssign (D30)', () => {
  test('accepts a well-formed RUN and PLAN payload and returns a clean copy', () => {
    const run = assignFor('RUN', { profiles: ['fast', 'strict'] });
    expect(parseAssign(cmd({ ...run, extra: 'dropped' }))).toEqual({ ok: true, assign: run });
    const plan = assignFor('PLAN');
    expect(parseAssign(cmd(plan))).toEqual({ ok: true, assign: plan });
  });
  test('accepts a GitLab subgroup owner and a dotted repo', () => {
    const a = assignFor('RUN', { repo: { provider: 'gitlab', owner: 'infra/team', name: '.github', defaultBranch: 'trunk', cloneUrl: 'https://gitlab.com/infra/team/.github.git' } });
    expect(parseAssign(cmd(a))).toEqual({ ok: true, assign: a });
  });
  test.each([
    ['a payload that is not an object', 'x', 'payload'],
    ['a job id that differs from the command', { ...assignFor(), jobId: 'other' }, 'jobId'],
    ['a job id with a slash', { ...assignFor(), jobId: '../j1' }, 'jobId'],
    ['an unknown command', { ...assignFor(), command: 'DEPLOY' }, 'command'],
    ['an unknown provider', { ...assignFor(), repo: { ...assignFor().repo, provider: 'bitbucket' } }, 'repo'],
    ['an owner with ..', { ...assignFor(), repo: { ...assignFor().repo, owner: '..' } }, 'owner'],
    ['an owner named .jobs', { ...assignFor(), repo: { ...assignFor().repo, owner: '.jobs' } }, 'owner'],
    ['a repo name with a slash', { ...assignFor(), repo: { ...assignFor().repo, name: 'a/b' } }, 'repo name'],
    ['an ext:: clone url', { ...assignFor(), repo: { ...assignFor().repo, cloneUrl: 'ext::sh -c id' } }, 'cloneUrl'],
    ['an option-shaped clone url', { ...assignFor(), repo: { ...assignFor().repo, cloneUrl: '--upload-pack=x' } }, 'cloneUrl'],
    ['an empty default branch', { ...assignFor(), repo: { ...assignFor().repo, defaultBranch: '' } }, 'defaultBranch'],
    ['a feature with a slash', { ...assignFor(), feature: 'a/b' }, 'feature'],
    ['a PLAN without planFrom', { ...assignFor('PLAN'), planFrom: null }, 'planFrom'],
    ['a planFrom with ..', { ...assignFor('PLAN'), planFrom: '../../etc/passwd' }, 'planFrom'],
    ['a planFrom on a RUN', { ...assignFor('RUN'), planFrom: 'docs/x.md' }, 'planFrom'],
    ['a profile with a comma', { ...assignFor(), profiles: ['a,b'] }, 'profiles'],
    ['the reserved profile prefix', { ...assignFor(), profiles: ['koda-job-x'] }, 'profiles'],
    ['nine profiles', { ...assignFor(), profiles: Array.from({ length: 9 }, (_, i) => `p${i}`) }, 'profiles'],
    ['a cost of 1e9', { ...assignFor(), maxCostUsd: '1e9' }, 'maxCostUsd'],
    ['a numeric cost', { ...assignFor(), maxCostUsd: 5 }, 'maxCostUsd'],
    ['bashMode gated', { ...assignFor(), bashMode: 'gated' }, 'bashMode'],
    ['an identity with a newline', { ...assignFor(), gitIdentity: { name: 'a\nb', email: 'e@x' } }, 'gitIdentity'],
    ['a missing identity', { ...assignFor(), gitIdentity: undefined }, 'gitIdentity'],
    ['a ref over 255 characters', { ...assignFor(), ref: 'r'.repeat(256) }, 'ref'],
  ])('rejects %s', (_label, payload, detail) => {
    const parsed = parseAssign(cmd(payload));
    expect(parsed.ok).toBe(false);
    expect((parsed as { detail: string }).detail).toBe(`invalid ${detail}`);
  });
  test('an odd but syntactically plain ref is not rejected here; prepare turns it into a fixed reason', () => {
    expect(parseAssign(cmd({ ...assignFor(), ref: '--upload-pack=x' })).ok).toBe(true);
  });
});
```

`supervisor/supervisor.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { AssignPayload } from '@nathapp/fleet-protocol';
import type { UploadOutcome } from '../bundle/upload-bundle';
import { Journal } from '../journal/journal';
import { createMemoryLogger } from '../logger';
import { assignFor } from '../../test/helpers/assign';
import { FakeExecutor } from '../../test/helpers/fake-executor';
import { fakeTime } from '../../test/helpers/fake-time';
import { waitFor } from '../../test/helpers/wait';
import { RepoMutex } from './repo-mutex';
import { Supervisor } from './supervisor';

function build() {
  const time = fakeTime();
  const journal = Journal.open(':memory:', time.now);
  const ex = new FakeExecutor();
  const outcomes: UploadOutcome[] = [];
  const supervisor = new Supervisor({
    journal, executor: ex, mutex: new RepoMutex(), log: createMemoryLogger(), now: time.now, sleep: time.sleep,
    uploader: { upload: async () => outcomes.shift() ?? { kind: 'ok' } },
    tuning: { statusPollMs: 2_000, killGraceMs: 30_000, ackPollMs: 250, uploadAckWaitMs: 0 }, readoptHeartbeatMs: 120_000,
  });
  const add = (over: Partial<AssignPayload> = {}, epoch = 1, command: 'RUN' | 'PLAN' = 'RUN') =>
    journal.insertJob({ assign: assignFor(command, over), leaseEpoch: epoch, repoKey: 'acme/app', jobDir: `/w/.jobs/${over.jobId ?? 'j1'}` }).row;
  return { time, journal, ex, outcomes, supervisor, add };
}
const stateNames = (b: ReturnType<typeof build>, id = 'j1', epoch = 1) =>
  b.journal.pendingEvents(id, epoch, 1_000).filter((e) => e.type === 'state').map((e) => (e.payload as { to: string }).to);

describe('begin and idle', () => {
  test('starts a run, ignores a second begin for the same (job, epoch), and idle waits for the end', async () => {
    const b = build();
    b.ex.dieAfterTicks(1);
    const row = b.add();
    b.supervisor.begin(row, 'prepare');
    b.supervisor.begin(row, 'prepare');
    await b.supervisor.idle();
    expect(b.ex.calls.filter((c) => c === 'prepare:j1')).toHaveLength(1);
    expect(stateNames(b).at(-1)).toBe('COMPLETED');
  });
});

describe('cancel', () => {
  test('signals a live run; unknown jobs are unknown; a job with no run only records the cancel (it is validated at readopt)', async () => {
    const b = build();
    const row = b.add();
    b.supervisor.begin(row, 'prepare');
    await waitFor(() => b.ex.ticks >= 1);
    expect(b.supervisor.cancel('j1', 1)).toBe('ok');
    await b.supervisor.idle();
    expect(b.ex.killed[0].signal).toBe('SIGTERM');
    expect(b.supervisor.cancel('ghost', 1)).toBe('unknown');
    const other = build();
    other.add({ jobId: 'idle' });
    expect(other.supervisor.cancel('idle', 1)).toBe('ok');
    expect(other.journal.getJob('idle', 1)?.cancelRequestedAt).not.toBeNull();
    expect(other.ex.killed).toEqual([]);
  });
  test('cancelling a finished job is ok and changes nothing', async () => {
    const b = build();
    b.add();
    b.journal.updateJob('j1', 1, { state: 'COMPLETED' });
    b.journal.markDone('j1', 1);
    expect(b.supervisor.cancel('j1', 1)).toBe('ok');
    expect(b.journal.getJob('j1', 1)?.cancelRequestedAt).toBeNull();
  });
});

describe('abandon (D49, Review focus 4)', () => {
  test('is keyed by epoch: the stale epoch is dropped and killed, the newer epoch is untouched', async () => {
    const b = build();
    b.add({}, 1);
    b.add({}, 2);
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    b.journal.appendEvent('j1', 1, 'log', { stream: 'run', text: 'old' });
    b.journal.appendEvent('j1', 2, 'log', { stream: 'run', text: 'new' });
    b.ex.alive = true;
    await b.supervisor.abandon('j1', 1);
    expect(b.journal.getJob('j1', 1)).toBeNull();
    expect(b.journal.getJob('j1', 2)).not.toBeNull();
    expect(b.journal.pendingEvents('j1', 2, 10)).toHaveLength(1);
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGKILL' }]);
  });
  test('does not signal a pid that is no longer this job (recycled), and tolerates an unknown job', async () => {
    const b = build();
    b.add();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    b.ex.alive = true;
    b.ex.procMatches = false;
    await b.supervisor.abandon('j1', 1);
    expect(b.ex.killed).toEqual([]);
    await b.supervisor.abandon('ghost', 9);
  });
  test('abandonAll drops every epoch of a job the server does not know', async () => {
    const b = build();
    b.add({}, 1);
    b.add({}, 2);
    await b.supervisor.abandonAll('j1');
    expect(b.journal.jobsById('j1')).toEqual([]);
  });
  test('abandoning a live run stops it without further events', async () => {
    const b = build();
    const row = b.add();
    b.supervisor.begin(row, 'prepare');
    await waitFor(() => b.ex.ticks >= 1);
    await b.supervisor.abandon('j1', 1);
    await b.supervisor.idle();
    expect(b.journal.getJob('j1', 1)).toBeNull();
  });
});

describe('readopt (design §2 control paths, D33, D54)', () => {
  const running = (b: ReturnType<typeof build>, over: Record<string, unknown> = {}, command: 'RUN' | 'PLAN' = 'RUN') => {
    b.add({}, 1, command);
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242, naxRunId: 'run-1', ...over });
    return b.journal.getJob('j1', 1);
  };
  const freshStatus = (b: ReturnType<typeof build>, over: Record<string, unknown> = {}) => ({
    run: { id: 'run-1', status: 'running' }, lastHeartbeat: b.time.now().toISOString(), ...over,
  });

  test('pid alive, run id matches, heartbeat fresh: ok, and the watcher attaches at end of file', async () => {
    const b = build();
    running(b);
    b.ex.alive = true;
    b.ex.status = freshStatus(b) as never;
    b.ex.dieAfterTicks(2);
    b.ex.status = { run: { id: 'run-1', status: 'running' }, lastHeartbeat: b.time.now().toISOString() };
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'ok' });
    await b.supervisor.idle();
    expect(b.ex.watchOptions[0].startAtEnd).toBe(true);
    expect(b.ex.calls).not.toContain('prepare:j1');
  });
  test('a second READOPT while attached is ok and starts nothing new', async () => {
    const b = build();
    running(b);
    b.ex.alive = true;
    b.ex.status = freshStatus(b) as never;
    await b.supervisor.readopt('j1', 1);
    await waitFor(() => b.ex.ticks >= 1);
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'ok' });
    expect(b.ex.watchOptions).toHaveLength(1);
    b.ex.alive = false;
    await b.supervisor.idle();
  });
  test('pid alive but the run id differs and the pid is not this job (a recycled pid): rejected, reaped, cleaned, done, nothing signalled', async () => {
    const b = build();
    running(b);
    b.ex.alive = true;
    b.ex.procMatches = false;
    b.ex.status = freshStatus(b, { run: { id: 'someone-else', status: 'running' } }) as never;
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'rejected', detail: 'run id mismatch' });
    expect(b.ex.calls).toEqual(expect.arrayContaining(['reap:j1', 'cleanup:j1']));
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
    expect(b.ex.killed).toEqual([]);
  });
  test('pid alive, run id matches, heartbeat older than 2 minutes: rejected, and the stale nax is SIGKILLed before the reap (D65)', async () => {
    const b = build();
    running(b);
    b.ex.alive = true;
    b.ex.onKill = (signal) => { b.ex.calls.push(`kill:${signal}`); b.ex.alive = false; };
    b.ex.status = freshStatus(b, { lastHeartbeat: new Date(b.time.nowMs() - 121_000).toISOString() }) as never;
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'rejected', detail: 'stale heartbeat' });
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGKILL' }]);
    expect(b.ex.calls.indexOf('kill:SIGKILL')).toBeGreaterThan(-1);
    expect(b.ex.calls.indexOf('kill:SIGKILL')).toBeLessThan(b.ex.calls.indexOf('reap:j1'));
    expect(b.ex.calls.indexOf('reap:j1')).toBeLessThan(b.ex.calls.indexOf('cleanup:j1'));
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
  });
  test('pid alive, it is this job\'s nax, but its run id is not the journaled one: rejected and killed', async () => {
    const b = build();
    running(b);
    b.ex.alive = true;
    b.ex.status = freshStatus(b, { run: { id: 'a-newer-run', status: 'running' } }) as never;
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'rejected', detail: 'run id mismatch' });
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGKILL' }]);
  });
  test('pid gone, status final and matching: ok, the run finishes and reports normally (finished while the daemon was down)', async () => {
    const b = build();
    running(b);
    b.ex.alive = false;
    b.ex.status = { run: { id: 'run-1', status: 'completed' }, postRun: { finish: { status: 'passed', result: 'opened', url: 'https://example.test/pr/1' } } };
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'ok' });
    await b.supervisor.idle();
    expect(stateNames(b)).toEqual(['UPLOADING', 'COMPLETED']);       // RUNNING was reported before the daemon went down
  });
  test('pid gone and status still running (nax died without a final write): rejected', async () => {
    const b = build();
    running(b);
    b.ex.alive = false;
    b.ex.status = freshStatus(b) as never;
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'rejected', detail: 'process gone' });
  });
  test('no status.json or no journaled run id: rejected', async () => {
    const a = build();
    running(a);
    a.ex.alive = true;
    a.ex.status = null;
    expect((await a.supervisor.readopt('j1', 1)).result).toBe('rejected');
    const c = build();
    running(c, { naxRunId: null });
    c.ex.alive = true;
    c.ex.status = freshStatus(c) as never;
    expect((await c.supervisor.readopt('j1', 1)).result).toBe('rejected');
  });
  test('a job still ASSIGNED with no pid reaps, re-runs prepare and is acked ok (D33, D65)', async () => {
    const b = build();
    b.add();
    b.ex.dieAfterTicks(1);
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'ok' });
    await b.supervisor.idle();
    expect(b.ex.calls.slice(0, 2)).toEqual(['reap:j1', 'prepare:j1']);
    expect(stateNames(b).at(-1)).toBe('COMPLETED');
  });
  test('a RUNNING job with no recorded pid is rejected', async () => {
    const b = build();
    b.add();
    b.journal.updateJob('j1', 1, { state: 'RUNNING' });
    expect((await b.supervisor.readopt('j1', 1)).result).toBe('rejected');
  });
  test('a terminal journal state is only cleaned up, ok', async () => {
    const b = build();
    b.add();
    b.journal.updateJob('j1', 1, { state: 'COMPLETED' });
    expect(await b.supervisor.readopt('j1', 1)).toEqual({ result: 'ok' });
    expect(b.ex.calls).toEqual(['cleanup:j1']);
    expect(b.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
  });
  test('an unknown job is rejected', async () => {
    expect(await build().supervisor.readopt('ghost', 1)).toEqual({ result: 'rejected', detail: 'unknown job' });
  });
  test('PLAN: a live process that is this job is watched; a dead or foreign one goes to the finish path (no status.json to judge by)', async () => {
    const live = build();
    running(live, { naxRunId: null }, 'PLAN');
    live.ex.alive = true;
    live.ex.dieAfterTicks(2);
    expect(await live.supervisor.readopt('j1', 1)).toEqual({ result: 'ok' });
    await live.supervisor.idle();
    expect(live.ex.watchOptions).toHaveLength(1);
    expect(stateNames(live).at(-1)).toBe('COMPLETED');

    const dead = build();
    running(dead, { naxRunId: null }, 'PLAN');
    dead.ex.alive = false;
    expect(await dead.supervisor.readopt('j1', 1)).toEqual({ result: 'ok' });
    await dead.supervisor.idle();
    expect(dead.ex.watchOptions).toHaveLength(0);
    expect(dead.ex.calls).toContain('readPlan:j1');

    const foreign = build();
    running(foreign, { naxRunId: null }, 'PLAN');
    foreign.ex.alive = true;
    foreign.ex.procMatches = false;
    expect(await foreign.supervisor.readopt('j1', 1)).toEqual({ result: 'ok' });
    expect(foreign.ex.watchOptions).toHaveLength(0);
    foreign.ex.alive = false;
    await foreign.supervisor.idle();
  });
});

describe('shutdown', () => {
  test('halts every run without touching a child', async () => {
    const b = build();
    const row = b.add();
    b.supervisor.begin(row, 'prepare');
    await waitFor(() => b.ex.ticks >= 1);
    b.supervisor.shutdown();
    await b.supervisor.idle();
    expect(b.ex.killed).toEqual([]);
    expect(stateNames(b)).toEqual(['RUNNING']);
  });
});
```

`supervisor/command-handler.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { FleetCommandOut } from '@nathapp/fleet-protocol';
import { Journal } from '../journal/journal';
import { createMemoryLogger } from '../logger';
import { assignFor } from '../../test/helpers/assign';
import { FakeExecutor } from '../../test/helpers/fake-executor';
import { fakeTime } from '../../test/helpers/fake-time';
import { waitFor } from '../../test/helpers/wait';
import { CommandHandler } from './command-handler';
import { RepoMutex } from './repo-mutex';
import { Supervisor } from './supervisor';

function build() {
  const time = fakeTime();
  const journal = Journal.open(':memory:', time.now);
  const ex = new FakeExecutor();
  const log = createMemoryLogger();
  const supervisor = new Supervisor({
    journal, executor: ex, mutex: new RepoMutex(), log, now: time.now, sleep: time.sleep,
    uploader: { upload: async () => ({ kind: 'ok' }) }, tuning: { statusPollMs: 2_000, killGraceMs: 30_000, ackPollMs: 250, uploadAckWaitMs: 0 }, readoptHeartbeatMs: 120_000,
  });
  const handler = new CommandHandler({ journal, supervisor, workspaceRoot: '/work/space', log, now: time.now });
  return { time, journal, ex, supervisor, handler };
}
const assignCmd = (id = 'c1', jobId = 'j1', epoch = 1): FleetCommandOut => ({ commandId: id, type: 'ASSIGN', jobId, leaseEpoch: epoch, payload: assignFor('RUN', { jobId }) });
const other = (type: FleetCommandOut['type'], id: string, epoch = 1): FleetCommandOut => ({ commandId: id, type, jobId: 'j1', leaseEpoch: epoch, payload: {} });

describe('ASSIGN', () => {
  test('inserts the job and the applied-command row, acks ok, and starts preparing', async () => {
    const b = build();
    b.ex.dieAfterTicks(1);
    expect(await b.handler.handle([assignCmd()])).toEqual([{ commandId: 'c1', leaseEpoch: 1, result: 'ok' }]);
    expect(b.journal.getJob('j1', 1)).toMatchObject({ command: 'RUN', repoKey: 'acme/app', jobDir: '/work/space/.jobs/j1', state: expect.any(String) });
    expect(b.journal.getCommand('c1')).toMatchObject({ result: 'ok', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1 });
    await b.supervisor.idle();
    expect(b.ex.calls).toContain('prepare:j1');
  });
  test('a repeated command is acked from the journal and never re-run (Review focus 1)', async () => {
    const b = build();
    b.ex.dieAfterTicks(1);
    await b.handler.handle([assignCmd()]);
    await b.supervisor.idle();
    const before = b.ex.calls.length;
    expect(await b.handler.handle([assignCmd()])).toEqual([{ commandId: 'c1', leaseEpoch: 1, result: 'ok' }]);
    expect(b.ex.calls).toHaveLength(before);
  });
  test('the same (job, epoch) under a new command id is acked ok without a second run', async () => {
    const b = build();
    b.ex.dieAfterTicks(1);
    await b.handler.handle([assignCmd('c1')]);
    await b.supervisor.idle();
    const before = b.ex.calls.length;
    expect((await b.handler.handle([assignCmd('c2')]))[0].result).toBe('ok');
    expect(b.ex.calls).toHaveLength(before);
    expect(b.journal.getCommand('c2')).not.toBeNull();
  });
  test('a replayed ASSIGN whose run was lost in a restart starts it again; a job that has moved on is left alone (D63)', async () => {
    const b = build();
    // What the journal looks like after a crash between "row + applied command committed" and "run started".
    b.journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1' }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/work/space/.jobs/j1' });
    b.journal.recordCommand({ commandId: 'c1', jobId: 'j1', leaseEpoch: 1, type: 'ASSIGN', result: 'ok', detail: null, appliedAt: b.time.now().toISOString() });
    b.ex.dieAfterTicks(1);
    expect(await b.handler.handle([assignCmd('c1')])).toEqual([{ commandId: 'c1', leaseEpoch: 1, result: 'ok' }]);
    await b.supervisor.idle();
    expect(b.ex.calls.slice(0, 2)).toEqual(['reap:j1', 'prepare:j1']);
    expect(b.journal.getJob('j1', 1)?.state).toBe('COMPLETED');

    const moved = build();                                       // RUNNING with a pid: not stranded
    moved.journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1' }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/work/space/.jobs/j1' });
    moved.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    moved.journal.recordCommand({ commandId: 'c1', jobId: 'j1', leaseEpoch: 1, type: 'ASSIGN', result: 'ok', detail: null, appliedAt: moved.time.now().toISOString() });
    await moved.handler.handle([assignCmd('c1')]);
    await moved.supervisor.idle();
    expect(moved.ex.calls).toEqual([]);

    const again = build();                                       // the same (job, epoch) under a new command id resumes as well
    again.journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1' }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/work/space/.jobs/j1' });
    again.ex.dieAfterTicks(1);
    expect((await again.handler.handle([assignCmd('c7')]))[0].result).toBe('ok');
    await again.supervisor.idle();
    expect(again.ex.calls).toContain('prepare:j1');
  });
  test('a higher epoch of the same job abandons the lower one first: it is killed and dropped, and its cleanup is left to the new epoch (D64)', async () => {
    const b = build();
    await b.handler.handle([assignCmd('c1', 'j1', 1)]);
    await waitFor(() => b.ex.ticks >= 1);                        // epoch 1 is running, pid 4242
    b.ex.dieAfterTicks(b.ex.ticks + 2);                          // epoch 2 will finish quickly once it runs
    expect((await b.handler.handle([assignCmd('c2', 'j1', 2)]))[0].result).toBe('ok');
    expect(b.journal.getJob('j1', 1)).toBeNull();
    expect(b.ex.killed).toEqual([{ pgid: 4242, signal: 'SIGKILL' }]);
    await b.supervisor.idle();
    expect(b.journal.getJob('j1', 2)?.state).toBe('COMPLETED');
    const secondPrepare = b.ex.calls.lastIndexOf('prepare:j1');
    expect(b.ex.calls.filter((c) => c === 'prepare:j1')).toHaveLength(2);
    expect(b.ex.calls.slice(0, secondPrepare)).not.toContain('cleanup:j1');   // the abandon of epoch 1 did not clean epoch 2's profile
  });
  test('a hostile payload is acked rejected with a fixed detail, creates no job, and the rejection is replayed', async () => {
    const b = build();
    const bad: FleetCommandOut = { ...assignCmd('c9'), payload: { ...assignFor(), feature: '../../etc' } as never };
    const [ack] = await b.handler.handle([bad]);
    expect(ack).toEqual({ commandId: 'c9', leaseEpoch: 1, result: 'rejected', detail: 'invalid feature' });
    expect(b.journal.getJob('j1', 1)).toBeNull();
    expect(b.ex.calls).toEqual([]);
    expect((await b.handler.handle([bad]))[0]).toEqual(ack);
  });
});

describe('CANCEL, ABANDON, READOPT and unknown types', () => {
  test('CANCEL of a held job is ok; of an unknown job is rejected with does not hold job', async () => {
    const b = build();
    await b.handler.handle([assignCmd()]);
    await waitFor(() => b.ex.ticks >= 1);
    const acks = await b.handler.handle([other('CANCEL', 'k1'), { ...other('CANCEL', 'k2'), jobId: 'ghost' }]);
    expect(acks).toEqual([
      { commandId: 'k1', leaseEpoch: 1, result: 'ok' },
      { commandId: 'k2', leaseEpoch: 1, result: 'rejected', detail: 'does not hold job' },
    ]);
    expect(b.ex.killed[0].signal).toBe('SIGTERM');
    await b.supervisor.idle();
  });
  test('ABANDON drops that epoch and acks ok even when nothing is held', async () => {
    const b = build();
    b.ex.dieAfterTicks(1);
    await b.handler.handle([assignCmd('c1', 'j1', 1)]);
    await b.supervisor.idle();
    const acks = await b.handler.handle([other('ABANDON', 'a1', 1), { ...other('ABANDON', 'a2', 7), jobId: 'ghost' }]);
    expect(acks.map((a) => a.result)).toEqual(['ok', 'ok']);
    expect(b.journal.getJob('j1', 1)).toBeNull();
  });
  test('READOPT is delegated and its ack replays', async () => {
    const b = build();
    b.journal.insertJob({ assign: assignFor(), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/work/space/.jobs/j1' });
    b.journal.updateJob('j1', 1, { state: 'COMPLETED' });
    const first = await b.handler.handle([other('READOPT', 'r1')]);
    expect(first).toEqual([{ commandId: 'r1', leaseEpoch: 1, result: 'ok' }]);
    expect(await b.handler.handle([other('READOPT', 'r1')])).toEqual(first);
    const rejected = await b.handler.handle([{ ...other('READOPT', 'r2'), jobId: 'ghost' }]);
    expect(rejected).toEqual([{ commandId: 'r2', leaseEpoch: 1, result: 'rejected', detail: 'unknown job' }]);
  });
  test('an unknown command type is rejected, and a throwing supervisor never escapes the handler', async () => {
    const b = build();
    const acks = await b.handler.handle([{ ...other('CANCEL', 'x1'), type: 'REBOOT' as never }]);
    expect(acks[0]).toMatchObject({ result: 'rejected', detail: 'unknown command type' });
    b.supervisor.cancel = () => { throw new Error('boom'); };
    const [ack] = await b.handler.handle([other('CANCEL', 'x2')]);
    expect(ack).toMatchObject({ commandId: 'x2', result: 'rejected', detail: 'runner error' });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/runner && bun test src/supervisor`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `assign-parser.ts`**

`supervisor/assign-parser.ts`:

```ts
import type { AssignPayload, FleetCommandOut } from '@nathapp/fleet-protocol';
import { assertCloneUrl } from '../executor/workspace';
import { COST_RE, PROFILE_NAME, RESERVED_PREFIX } from '../executor/nax-process';
import { PathError, assertFeature, assertOwner, assertRelativePath, assertSegment } from '../paths/safe-segment';

export type ParsedAssign = { ok: true; assign: AssignPayload } | { ok: false; detail: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (what: string): ParsedAssign => ({ ok: false, detail: `invalid ${what}` });
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const hasControl = (v: string): boolean => [...v].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
const plain = (v: unknown, max: number): v is string => text(v, max) && !hasControl(v);

function checked(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (error) {
    if (error instanceof PathError || error instanceof Error) return false;
    throw error;
  }
}

/**
 * D30: the server is trusted to deliver, not to be well formed. Every field that reaches a path, an argv or git config
 * is re-validated, and only the validated fields are copied. `ref` is only bounded here: an odd ref becomes a fixed
 * `checkout:` reason in prepare, not a rejected command.
 */
export function parseAssign(command: FleetCommandOut): ParsedAssign {
  const p = command.payload as unknown;
  if (!isObj(p)) return bad('payload');
  if (p['jobId'] !== command.jobId || !checked(() => assertSegment('jobId', p['jobId']))) return bad('jobId');
  if (p['command'] !== 'RUN' && p['command'] !== 'PLAN') return bad('command');
  const repo = p['repo'];
  if (!isObj(repo) || (repo['provider'] !== 'github' && repo['provider'] !== 'gitlab')) return bad('repo');
  if (!checked(() => assertOwner(repo['owner']))) return bad('owner');
  if (!checked(() => assertSegment('repo', repo['name']))) return bad('repo name');
  if (!text(repo['cloneUrl'], 2_000) || !checked(() => assertCloneUrl(repo['cloneUrl'] as string))) return bad('cloneUrl');
  if (!plain(repo['defaultBranch'], 255)) return bad('defaultBranch');
  if (!plain(p['ref'], 255)) return bad('ref');
  if (!checked(() => assertFeature(p['feature']))) return bad('feature');
  const isPlan = p['command'] === 'PLAN';
  if (isPlan ? !checked(() => assertRelativePath('planFrom', p['planFrom'])) : p['planFrom'] !== null && p['planFrom'] !== undefined) return bad('planFrom');
  const profiles = p['profiles'];
  if (!Array.isArray(profiles) || profiles.length > 8 || !profiles.every((n) => typeof n === 'string' && PROFILE_NAME.test(n) && !n.startsWith(RESERVED_PREFIX))) return bad('profiles');
  if (typeof p['maxCostUsd'] !== 'string' || !COST_RE.test(p['maxCostUsd'])) return bad('maxCostUsd');
  if (p['bashMode'] !== 'raw') return bad('bashMode');
  const identity = p['gitIdentity'];
  if (!isObj(identity) || !plain(identity['name'], 200) || !plain(identity['email'], 200)) return bad('gitIdentity');
  return {
    ok: true,
    assign: {
      jobId: p['jobId'] as string,
      command: p['command'],
      repo: {
        provider: repo['provider'], owner: repo['owner'] as string, name: repo['name'] as string,
        defaultBranch: repo['defaultBranch'] as string, cloneUrl: repo['cloneUrl'] as string,
      },
      ref: p['ref'] as string,
      feature: p['feature'] as string,
      planFrom: isPlan ? (p['planFrom'] as string) : null,
      profiles: [...(profiles as string[])],
      maxCostUsd: p['maxCostUsd'],
      bashMode: 'raw',
      gitIdentity: { name: identity['name'] as string, email: identity['email'] as string },
    },
  };
}
```

- [ ] **Step 4: Implement `supervisor.ts`**

`supervisor/supervisor.ts`:

```ts
import { isFinalStatus, type StatusView } from '../verdict/status-view';
import { JobRun, type JobRunDeps, type RunStart } from './job-run';
import { killIfOurs } from './kill-if-ours';
import { isTerminalState } from './transitions';
import type { JobRow } from '../journal/types';
import { errorMessage } from '../errors';

export interface SupervisorDeps extends JobRunDeps {
  readonly readoptHeartbeatMs: number;
}

export type ReadoptResult = { result: 'ok' | 'rejected'; detail?: string };

const OK: ReadoptResult = { result: 'ok' };

/** Owns one `JobRun` per active (job, epoch) and turns server commands into run operations (design §1). */
export class Supervisor {
  private readonly runs = new Map<string, JobRun>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: SupervisorDeps) {}

  private key(jobId: string, epoch: number): string {
    return `${jobId}:${epoch}`;
  }

  begin(row: JobRow, from: RunStart): void {
    const key = this.key(row.jobId, row.leaseEpoch);
    if (this.runs.has(key)) return;
    const run = new JobRun(this.deps, row.jobId, row.leaseEpoch);
    this.runs.set(key, run);
    const promise: Promise<void> = run.start(from).finally(() => {
      this.runs.delete(key);
      this.pending.delete(promise);
    });
    this.pending.add(promise);
  }

  cancel(jobId: string, leaseEpoch: number): 'ok' | 'unknown' {
    const run = this.runs.get(this.key(jobId, leaseEpoch));
    if (run) {
      run.requestCancel();
      return 'ok';
    }
    const row = this.deps.journal.getJob(jobId, leaseEpoch);
    if (!row) return 'unknown';
    // No run yet (the daemon just restarted): record the cancel; READOPT validates the process before anything is signalled.
    if (!isTerminalState(row.state) && row.cancelRequestedAt === null) {
      this.deps.journal.updateJob(jobId, leaseEpoch, { cancelRequestedAt: this.deps.now().toISOString() });
    }
    return 'ok';
  }

  async abandon(jobId: string, leaseEpoch: number): Promise<void> {
    const run = this.runs.get(this.key(jobId, leaseEpoch));
    if (run) {
      await run.abandon();
      return;
    }
    if (!this.deps.journal.getJob(jobId, leaseEpoch)) return;
    // No run in memory (after a restart): the same epoch-safe abandon, on a run that never started (D64).
    await new JobRun(this.deps, jobId, leaseEpoch).abandon();
  }

  async abandonAll(jobId: string): Promise<void> {
    for (const row of this.deps.journal.jobsById(jobId)) await this.abandon(jobId, row.leaseEpoch);
  }

  private fresh(status: StatusView, row: JobRow): boolean {
    const stamp = Date.parse(status.lastHeartbeat ?? status.updatedAt ?? row.updatedAt);
    return !Number.isNaN(stamp) && this.deps.now().getTime() - stamp < this.deps.readoptHeartbeatMs;
  }

  private async reject(row: JobRow, detail: string): Promise<ReadoptResult> {
    try {
      await killIfOurs(this.deps.executor, row, this.deps.log);   // D65: a live but stale nax must not keep writing into the workspace
      await this.deps.executor.reap(row, new Date(row.createdAt));
      await this.deps.executor.cleanup(row);
    } catch (error) {
      this.deps.log.warn('readopt cleanup failed', { jobId: row.jobId, error: errorMessage(error) });
    }
    this.deps.journal.markDone(row.jobId, row.leaseEpoch);
    return { result: 'rejected', detail };
  }

  /** S1 spec §5.3 and design §2 control paths; D33 and D54 cover the cases the design leaves open. */
  async readopt(jobId: string, leaseEpoch: number): Promise<ReadoptResult> {
    const row = this.deps.journal.getJob(jobId, leaseEpoch);
    if (!row) return { result: 'rejected', detail: 'unknown job' };
    if (this.runs.has(this.key(jobId, leaseEpoch))) return OK;
    if (isTerminalState(row.state)) {
      await this.deps.executor.cleanup(row).catch(() => undefined);
      this.deps.journal.markDone(jobId, leaseEpoch);
      return OK;
    }
    if (row.state === 'ASSIGNED' && row.pid === null) {
      this.begin(row, 'reprepare');   // D33, D65: every prepare step is idempotent; reap first in case a nax was spawned before the crash
      return OK;
    }
    if (row.pid === null) return this.reject(row, 'no process recorded');
    const alive = this.deps.executor.isAlive(row.pid);
    if (row.command === 'PLAN') {
      const ours = alive && (await this.deps.executor.matchesProcess(row));
      this.begin(row, ours ? 'watch' : 'finish');
      return OK;
    }
    const status = await this.deps.executor.readStatus(row);
    const matches = status !== null && row.naxRunId !== null && status.run.id === row.naxRunId;
    if (status && matches && alive && this.fresh(status, row)) {
      this.begin(row, 'watch');
      return OK;
    }
    if (status && matches && !alive && isFinalStatus(status)) {
      this.begin(row, 'finish');
      return OK;
    }
    return this.reject(row, !matches ? 'run id mismatch' : alive ? 'stale heartbeat' : 'process gone');
  }

  shutdown(): void {
    for (const run of this.runs.values()) run.halt();
  }

  async idle(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}
```

- [ ] **Step 5: Implement `command-handler.ts`**

`supervisor/command-handler.ts`:

```ts
import type { CommandAck, FleetCommandOut } from '@nathapp/fleet-protocol';
import { errorMessage } from '../errors';
import type { Journal } from '../journal/journal';
import type { Logger } from '../logger';
import { jobDirFor } from '../paths/safe-segment';
import type { Now } from '../time';
import { parseAssign } from './assign-parser';
import type { Supervisor } from './supervisor';

export interface CommandHandlerDeps {
  readonly journal: Journal;
  readonly supervisor: Supervisor;
  readonly workspaceRoot: string;
  readonly log: Logger;
  readonly now: Now;
}

type Outcome = { result: 'ok' | 'rejected'; detail?: string };

/** Turns server commands into acks (design §1.3). Every applied command is recorded so a re-sent one is acked, not re-run. */
export class CommandHandler {
  constructor(private readonly deps: CommandHandlerDeps) {}

  async handle(commands: readonly FleetCommandOut[]): Promise<CommandAck[]> {
    const acks: CommandAck[] = [];
    for (const command of commands) acks.push(await this.handleOne(command));
    return acks;
  }

  private ack(command: FleetCommandOut, outcome: Outcome): CommandAck {
    return { commandId: command.commandId, leaseEpoch: command.leaseEpoch, result: outcome.result, ...(outcome.detail ? { detail: outcome.detail } : {}) };
  }

  private record(command: FleetCommandOut, outcome: Outcome): void {
    this.deps.journal.recordCommand({
      commandId: command.commandId, jobId: command.jobId, leaseEpoch: command.leaseEpoch, type: String(command.type),
      result: outcome.result, detail: outcome.detail ?? null, appliedAt: this.deps.now().toISOString(),
    });
  }

  private async handleOne(command: FleetCommandOut): Promise<CommandAck> {
    const prior = this.deps.journal.getCommand(command.commandId);
    if (prior) {
      if (prior.type === 'ASSIGN' && prior.result === 'ok') this.resumeStranded(prior.jobId, prior.leaseEpoch);
      return this.ack(command, { result: prior.result, ...(prior.detail ? { detail: prior.detail } : {}) });
    }
    let outcome: Outcome;
    try {
      outcome = await this.apply(command);
    } catch (error) {
      this.deps.log.error('command failed', { commandId: command.commandId, type: command.type, error: errorMessage(error) });
      return this.ack(command, { result: 'rejected', detail: 'runner error' });
    }
    return this.ack(command, outcome);
  }

  private async apply(command: FleetCommandOut): Promise<Outcome> {
    const { journal, supervisor } = this.deps;
    switch (command.type) {
      case 'ASSIGN': return this.assign(command);
      case 'CANCEL': {
        const outcome: Outcome = supervisor.cancel(command.jobId, command.leaseEpoch) === 'ok' ? { result: 'ok' } : { result: 'rejected', detail: 'does not hold job' };
        this.record(command, outcome);
        return outcome;
      }
      case 'ABANDON': {
        await supervisor.abandon(command.jobId, command.leaseEpoch);
        this.record(command, { result: 'ok' });
        return { result: 'ok' };
      }
      case 'READOPT': {
        const outcome = await supervisor.readopt(command.jobId, command.leaseEpoch);
        this.record(command, outcome);
        return outcome;
      }
      default: {
        const outcome: Outcome = { result: 'rejected', detail: 'unknown command type' };
        journal.recordCommand({ commandId: command.commandId, jobId: command.jobId, leaseEpoch: command.leaseEpoch, type: String(command.type), result: 'rejected', detail: outcome.detail ?? null, appliedAt: this.deps.now().toISOString() });
        return outcome;
      }
    }
  }

  /** D63: an ASSIGN that was journaled and acked, but whose run was lost in a restart, starts again (a no-op while a run exists). */
  private resumeStranded(jobId: string, leaseEpoch: number): void {
    const row = this.deps.journal.getJob(jobId, leaseEpoch);
    if (row && row.state === 'ASSIGNED' && row.pid === null && row.doneAt === null) this.deps.supervisor.begin(row, 'reprepare');
  }

  private async assign(command: FleetCommandOut): Promise<Outcome> {
    const { journal, supervisor, workspaceRoot } = this.deps;
    const parsed = parseAssign(command);
    if (!parsed.ok) {
      const outcome: Outcome = { result: 'rejected', detail: parsed.detail };
      this.record(command, outcome);
      return outcome;
    }
    const { assign } = parsed;
    const inserted = journal.tx(() => {
      const result = journal.insertJob({ assign, leaseEpoch: command.leaseEpoch, repoKey: `${assign.repo.owner}/${assign.repo.name}`, jobDir: jobDirFor(workspaceRoot, assign.jobId) });
      this.record(command, { result: 'ok' });
      return result;
    });
    if (!inserted.created) {
      this.resumeStranded(assign.jobId, command.leaseEpoch);
      return { result: 'ok' };
    }
    // D64: the same job id at a lower epoch is the attempt this one replaces. Drop it (kill, reap and cleanup are left to this
    // epoch's prepare, which wipes the previous attempt's files, D53) BEFORE the new run can queue for the repo.
    for (const older of journal.jobsById(assign.jobId).filter((row) => row.leaseEpoch < command.leaseEpoch)) {
      await supervisor.abandon(assign.jobId, older.leaseEpoch);
    }
    supervisor.begin(inserted.row, 'prepare');
    return { result: 'ok' };
  }
}
```

- [ ] **Step 6: Run and lint**

```bash
cd apps/runner && bun test src/supervisor && bun run type-check && bun run lint
```
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add apps/runner
git commit -m "feat(fleet): runner supervisor and command handling (ASSIGN validation, CANCEL, epoch-keyed ABANDON, READOPT rules)"
```

---

### Task 22: Static capability probe, capability reporter, capacity, tuning

**Files:**
- Create: `apps/runner/src/capabilities/capability-probe.ts`, `capability-probe.spec.ts`
- Create: `apps/runner/src/daemon/capacity.ts`, `capacity.spec.ts`
- Create: `apps/runner/src/daemon/tuning.ts`, `tuning.spec.ts`

**Interfaces:**
- Consumes: `StaticCapabilities` (7), `RunnerCapabilities`, `CapabilityReport` (10), `Journal.setMeta` (8), `ServerClient.me` (9), `Now`, `Logger`.
- Produces:
  ```ts
  // capability-probe.ts   (the 3b seam: NaxCapabilityProbe implements CapabilityProbe)
  export interface CapabilityProbe { probe(): Promise<RunnerCapabilities> }
  export class StaticCapabilityProbe implements CapabilityProbe { constructor(capabilities: StaticCapabilities, now: Now) }   // stamps sandbox.probedAt (D41)
  export function stableStringify(value: unknown): string;                  // object keys sorted, arrays in order
  export function hashCapabilities(caps: RunnerCapabilities): string;       // sha256 hex of the stable JSON without sandbox.probedAt
  export class CapabilityReporter {
    constructor(probe: CapabilityProbe, journal: Pick<Journal, 'setMeta'>);
    refresh(): Promise<void>;
    report(): CapabilityReport | null;        // the report until markSent(hash) for that hash in this boot; the first sync after boot always sends
    markSent(hash: string): void;             // persists meta last_capabilities_hash
  }
  // capacity.ts
  export class CapacityTracker { constructor(client: Pick<ServerClient, 'me'>, log: Logger); get capacity(): number | null; refresh(): Promise<void> }   // keeps the last good value on a failed refresh
  export function freeSlots(capacity: number | null, active: number): number;   // unknown capacity = 0; clamped 0..64
  // tuning.ts
  export interface Tuning { readonly statusPollMs: number; readonly killGraceMs: number; readonly syncMinGapMs: number; readonly syncTimeoutMs: number; readonly capacityRefreshMs: number; readonly pruneIntervalMs: number; readonly readoptHeartbeatMs: number; readonly ackPollMs: number; readonly uploadAckWaitMs: number }
  export const TUNING: Tuning;              // 2000, 30000, 250, 35000, 300000, 86400000, 120000 (D42), then ackPollMs 250 and uploadAckWaitMs 60000 (D60)
  ```

- [ ] **Step 1: Write the failing specs**

`capabilities/capability-probe.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { StaticCapabilities } from '../config/runner-config';
import { CapabilityReporter, StaticCapabilityProbe, hashCapabilities, stableStringify } from './capability-probe';

const stat = (over: Partial<StaticCapabilities> = {}): StaticCapabilities => ({
  nax: { version: '0.83.0', protocols: ['native'] }, sandbox: { available: true },
  profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: false } },
  credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false }],
  tools: { git: true, gh: true, glab: false }, executors: ['host'], ...over,
});
let clock = new Date('2026-10-01T00:00:00.000Z');

describe('StaticCapabilityProbe', () => {
  test('reports the configured block and stamps sandbox.probedAt with the probe time (D41)', async () => {
    clock = new Date('2026-10-01T00:00:00.000Z');
    const probe = new StaticCapabilityProbe(stat(), () => clock);
    const first = await probe.probe();
    expect(first).toEqual({ ...stat(), sandbox: { available: true, probedAt: '2026-10-01T00:00:00.000Z' } });
    clock = new Date('2026-10-01T00:10:00.000Z');
    expect((await probe.probe()).sandbox.probedAt).toBe('2026-10-01T00:10:00.000Z');
  });
  test('returns a copy: mutating a report does not change the next one', async () => {
    const probe = new StaticCapabilityProbe(stat(), () => clock);
    const a = await probe.probe();
    a.tools.gh = false;
    expect((await probe.probe()).tools.gh).toBe(true);
  });
  test('a sandbox error string is carried through', async () => {
    expect((await new StaticCapabilityProbe(stat({ sandbox: { available: false, error: 'bwrap missing' } }), () => clock).probe()).sandbox).toEqual({ available: false, error: 'bwrap missing', probedAt: clock.toISOString() });
  });
});

describe('hashCapabilities', () => {
  test('ignores key order and sandbox.probedAt, and changes with anything else', async () => {
    const a = await new StaticCapabilityProbe(stat(), () => new Date(1)).probe();
    const b = await new StaticCapabilityProbe(stat(), () => new Date(99_999)).probe();
    expect(hashCapabilities(a)).toBe(hashCapabilities(b));
    expect(hashCapabilities({ ...a, tools: { glab: false, gh: true, git: true } })).toBe(hashCapabilities(a));
    expect(hashCapabilities({ ...a, tools: { ...a.tools, glab: true } })).not.toBe(hashCapabilities(a));
    expect(hashCapabilities({ ...a, sandbox: { ...a.sandbox, available: false } })).not.toBe(hashCapabilities(a));
    expect(hashCapabilities(a)).toMatch(/^[0-9a-f]{64}$/);
  });
  test('stableStringify sorts keys at every depth and keeps array order', () => {
    expect(stableStringify({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
  });
});

describe('CapabilityReporter', () => {
  test('sends until marked, stays quiet for unchanged content, and reports a change again', async () => {
    const meta: Record<string, string> = {};
    let current = stat();
    const probe = { probe: async () => new StaticCapabilityProbe(current, () => clock).probe() };
    const reporter = new CapabilityReporter(probe, { setMeta: (k, v) => { meta[k] = v; } });
    expect(reporter.report()).toBeNull();                       // nothing probed yet
    await reporter.refresh();
    const first = reporter.report();
    expect(first?.capabilities.nax.version).toBe('0.83.0');
    expect(reporter.report()?.hash).toBe(first?.hash as string);   // still not confirmed: keep sending
    reporter.markSent(first?.hash as string);
    expect(meta['last_capabilities_hash']).toBe(first?.hash as string);
    expect(reporter.report()).toBeNull();
    clock = new Date('2026-10-02T00:00:00.000Z');
    await reporter.refresh();
    expect(reporter.report()).toBeNull();                       // only probedAt moved
    current = stat({ tools: { git: true, gh: false, glab: false } });
    await reporter.refresh();
    expect(reporter.report()?.hash).not.toBe(first?.hash);
  });
});
```

`daemon/capacity.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createMemoryLogger } from '../logger';
import { CapacityTracker, freeSlots } from './capacity';

describe('freeSlots', () => {
  test.each([[null, 0, 0], [2, 0, 2], [2, 1, 1], [2, 2, 0], [2, 5, 0], [100, 0, 64], [0, 0, 0]])('capacity %p, active %p -> %p', (capacity, active, expected) => {
    expect(freeSlots(capacity, active)).toBe(expected);
  });
});

describe('CapacityTracker (#157)', () => {
  const me = (capacity: unknown) => ({ id: 'r', name: 'n', labels: [], capacity, enabled: true });
  test('unknown until the first successful refresh; keeps the last good value when a refresh fails', async () => {
    const answers: Array<() => Promise<unknown>> = [async () => { throw new Error('down'); }, async () => me(3), async () => { throw new Error('down'); }, async () => me(-2), async () => me('x')];
    const tracker = new CapacityTracker({ me: async () => answers.shift()?.() as never }, createMemoryLogger());
    expect(tracker.capacity).toBeNull();
    await tracker.refresh();
    expect(tracker.capacity).toBeNull();
    await tracker.refresh();
    expect(tracker.capacity).toBe(3);
    await tracker.refresh();
    expect(tracker.capacity).toBe(3);
    await tracker.refresh();
    expect(tracker.capacity).toBe(3);                       // a negative value is ignored
    await tracker.refresh();
    expect(tracker.capacity).toBe(3);                       // a non-number is ignored
  });
});
```

`daemon/tuning.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { TUNING } from './tuning';

describe('TUNING (D42, slice 3 design)', () => {
  test('carries the design constants', () => {
    expect(TUNING).toEqual({
      statusPollMs: 2_000, killGraceMs: 30_000, syncMinGapMs: 250, syncTimeoutMs: 35_000,
      capacityRefreshMs: 300_000, pruneIntervalMs: 86_400_000, readoptHeartbeatMs: 120_000,
      ackPollMs: 250, uploadAckWaitMs: 60_000,
    });
    expect(Object.isFrozen(TUNING)).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/runner && bun test src/capabilities src/daemon`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`capabilities/capability-probe.ts`:

```ts
import { createHash } from 'node:crypto';
import type { RunnerCapabilities } from '@nathapp/fleet-protocol';
import type { StaticCapabilities } from '../config/runner-config';
import type { Journal } from '../journal/journal';
import type { CapabilityReport } from '../sync/sync-loop';
import type { Now } from '../time';

/** The 3b seam: `NaxCapabilityProbe` (nax --version, config --profile --json, auth list --json, sandbox probe) implements it. */
export interface CapabilityProbe {
  probe(): Promise<RunnerCapabilities>;
}

/** 3a: the operator declares the capabilities in runner.json; only the probe time is dynamic (D41). */
export class StaticCapabilityProbe implements CapabilityProbe {
  constructor(private readonly capabilities: StaticCapabilities, private readonly now: Now) {}

  async probe(): Promise<RunnerCapabilities> {
    const { sandbox, ...rest } = structuredClone(this.capabilities);
    return { ...rest, sandbox: { ...sandbox, probedAt: this.now().toISOString() } };
  }
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function hashCapabilities(caps: RunnerCapabilities): string {
  const { probedAt: _probedAt, ...sandbox } = caps.sandbox;
  return createHash('sha256').update(stableStringify({ ...caps, sandbox })).digest('hex');
}

/** Slice 3 design §3.2: sent on the first sync after boot and whenever the hash (without probedAt) changes. */
export class CapabilityReporter {
  private current: CapabilityReport | null = null;
  private sentHash: string | null = null;

  constructor(private readonly probe: CapabilityProbe, private readonly journal: Pick<Journal, 'setMeta'>) {}

  async refresh(): Promise<void> {
    const capabilities = await this.probe.probe();
    this.current = { capabilities, hash: hashCapabilities(capabilities) };
  }

  report(): CapabilityReport | null {
    return this.current && this.current.hash !== this.sentHash ? this.current : null;
  }

  markSent(hash: string): void {
    this.sentHash = hash;
    this.journal.setMeta('last_capabilities_hash', hash);
  }
}
```

`daemon/capacity.ts`:

```ts
import type { RunnerIdentity } from '@nathapp/fleet-protocol';
import { errorMessage } from '../errors';
import type { Logger } from '../logger';

/** The server owns capacity (#157); the runner only reads it. `freeSlots = capacity - active jobs` (design §1). */
export class CapacityTracker {
  private value: number | null = null;

  constructor(private readonly client: { me(signal?: AbortSignal): Promise<RunnerIdentity> }, private readonly log: Logger) {}

  get capacity(): number | null {
    return this.value;
  }

  async refresh(): Promise<void> {
    try {
      const { capacity } = await this.client.me();
      if (typeof capacity === 'number' && Number.isInteger(capacity) && capacity >= 0) this.value = capacity;
      else this.log.warn('server reported an unusable capacity', { capacity });
    } catch (error) {
      this.log.warn('could not read runner capacity', { error: errorMessage(error) });
    }
  }
}

export function freeSlots(capacity: number | null, active: number): number {
  if (capacity === null) return 0;
  return Math.min(64, Math.max(0, capacity - active));
}
```

`daemon/tuning.ts`:

```ts
export interface Tuning {
  readonly statusPollMs: number;
  readonly killGraceMs: number;
  readonly syncMinGapMs: number;
  readonly syncTimeoutMs: number;
  readonly capacityRefreshMs: number;
  readonly pruneIntervalMs: number;
  readonly readoptHeartbeatMs: number;
  /** D60: how often and for how long a job waits for the server to ack its UPLOADING event before it uploads the bundle. */
  readonly ackPollMs: number;
  readonly uploadAckWaitMs: number;
}

/** D42: the design's constants in one place; only `startDaemon` options (tests) override them, runner.json cannot. */
export const TUNING: Tuning = Object.freeze({
  statusPollMs: 2_000,
  killGraceMs: 30_000,
  syncMinGapMs: 250,
  syncTimeoutMs: 35_000,
  capacityRefreshMs: 300_000,
  pruneIntervalMs: 86_400_000,
  readoptHeartbeatMs: 120_000,
  ackPollMs: 250,
  uploadAckWaitMs: 60_000,
});
```

- [ ] **Step 4: Run and lint**

```bash
cd apps/runner && bun test src/capabilities src/daemon && bun run type-check && bun run lint
```
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/runner
git commit -m "feat(fleet): static capability probe and reporter (3b seam), capacity tracker, tuning constants"
```

---

### Task 23: The daemon — wiring, startup housekeeping, stop

**Files:**
- Create: `apps/runner/src/daemon/daemon.ts`
- Create: `apps/runner/test/unit/daemon.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  export interface DaemonOptions {
    readonly home: RunnerHome;
    readonly config: RunnerConfig;
    readonly identity: RunnerIdentityFile;
    readonly fetchFn?: FetchFn;                        // tests inject a flaky fetch (network cut)
    readonly tuning?: Partial<Tuning>;
    readonly log?: Logger;
    readonly now?: Now;
    readonly sleep?: Sleep;
    readonly bootId?: string;
    readonly executorFactory?: () => JobExecutor;      // tests inject a FakeExecutor; default HostExecutor
    readonly git?: Git;                                // tests inject a git that reports another version; default createGit()
  }
  export interface DaemonHandle {
    readonly bootId: string;
    readonly journal: Journal;
    readonly supervisor: Supervisor;
    readonly stopped: Promise<StopReason | 'stopped'>;   // resolves when the sync loop ends
    stop(): Promise<void>;                               // idempotent; ends the loop, halts runs, AWAITS supervisor.idle(), then closes the journal; never touches a child
    crash(): void;                                       // D40, D67: a simulated kill -9 for tests: stop timers, abort the loop, halt runs (they emit nothing more), close the journal NOW; no drain, no child signalled
  }
  export function startDaemon(options: DaemonOptions): Promise<DaemonHandle>;
  ```
  Startup order: check `git --version` is at least 2.30 (`assertMinGitVersion`, D69; the start is refused before anything is created); create `<workspaceRoot>/.jobs`; open the journal (`boot_id`, `runner_id` meta); delete orphan `koda-job-*` profiles (jobs not active in the journal); prune jobs done more than `jobRetentionDays` ago and delete their job dirs (guarded to `<workspaceRoot>/.jobs`); read capacity from `/me` (an unreachable server is logged, capacity stays unknown and `freeSlots` is 0 until it answers); probe capabilities; start the sync loop. Timers (unref'd): capacity refresh every 5 minutes, prune daily. `freeSlots = capacity - journal.activeCount()`. Runs are never killed by `stop()` (D40): a second `startDaemon` on the same home is the restart. `stop()` waits for every halted run to end before it closes the journal (D67): a halted run in the middle of a slow `prepare` finishes that call first, and a log line says so after 5 s; closing the journal under a run would make its next write throw. `crash()` is the opposite on purpose: it closes the journal immediately, so the restart scenarios (Task 27) meet the state a real kill leaves behind.

- [ ] **Step 1: Write the failing spec**

`test/unit/daemon.spec.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssignPayload, FleetCommandOut, SyncRequest } from '@nathapp/fleet-protocol';
import { parseRunnerConfig, resolveHome } from '../../src/config/runner-config';
import { startDaemon } from '../../src/daemon/daemon';
import { Journal } from '../../src/journal/journal';
import type { Git } from '../../src/executor/git';
import { createMemoryLogger } from '../../src/logger';
import { assignFor } from '../helpers/assign';
import { FakeExecutor } from '../helpers/fake-executor';
import { makeTempDirs } from '../helpers/tmp';
import { waitFor } from '../helpers/wait';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

interface FakeServer {
  url: string;
  syncs: SyncRequest[];
  uploads: Array<{ path: string; epoch: string | null; sha: string | null; bytes: number }>;
  queue: FleetCommandOut[];
  mode: { status: number; capacity: number };
  stop(): void;
}

function fakeServer(): FakeServer {
  const acked = new Map<string, number>();
  const server: FakeServer = { url: '', syncs: [], uploads: [], queue: [], mode: { status: 200, capacity: 2 }, stop: () => undefined };
  const bun = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ ret: 0, data }), { status });
      if (url.pathname === '/api/fleet/runner/me') return envelope({ id: 'r1', name: 'box', labels: [], capacity: server.mode.capacity, enabled: true });
      if (url.pathname.endsWith('/bundle') && req.method === 'PUT') {
        const bytes = (await req.arrayBuffer()).byteLength;
        server.uploads.push({ path: url.pathname, epoch: url.searchParams.get('leaseEpoch'), sha: req.headers.get('x-content-sha256'), bytes });
        return envelope({}, 201);
      }
      if (url.pathname === '/api/fleet/runner/sync') {
        if (server.mode.status !== 200) return new Response(JSON.stringify({ ret: 1, message: 'Unsupported protocol version' }), { status: server.mode.status });
        const body = (await req.json()) as SyncRequest;
        server.syncs.push(body);
        const jobAcks = body.jobs.map((j) => {
          let next = (acked.get(j.jobId) ?? 0) + 1;
          for (const e of [...j.events].sort((a, b) => a.seq - b.seq)) if (e.seq === next) next += 1;
          acked.set(j.jobId, next - 1);
          return { jobId: j.jobId, ackedSeq: next - 1 };
        });
        const commands = server.queue.splice(0);
        if (jobAcks.length === 0 && commands.length === 0) await Bun.sleep(25);
        return envelope({ jobAcks, commands, gitTokens: [], gitTokenErrors: [], unknownJobIds: [] });
      }
      return new Response('nope', { status: 404 });
    },
  });
  server.url = `http://127.0.0.1:${bun.port}`;
  server.stop = () => bun.stop(true);
  return server;
}

async function setup(server: FakeServer) {
  const base = await tmp.make('daemon');
  const home = resolveHome({}, join(base, 'home'));
  const config = parseRunnerConfig({
    serverUrl: server.url, workspaceRoot: join(base, 'ws'), naxHome: join(base, 'naxhome'), jobRetentionDays: 1,
    capabilities: { nax: { version: '0.83.0', protocols: ['native'] }, sandbox: { available: true }, tools: { git: true, gh: true, glab: false }, executors: ['host'] },
  }, {});
  const identity = { runnerId: 'r1', apiKey: 'kr_test', serverUrl: server.url, name: 'box', enrolledAt: '2026-10-01T00:00:00.000Z' };
  const bundle = join(base, 'bundle.tar.gz');
  await writeFile(bundle, 'bundle-bytes');
  const ex = new FakeExecutor();
  ex.bundle = { path: bundle, size: 12, sha256: 'a'.repeat(64) };
  ex.dieAfterTicks(1);
  return { base, home, config, identity, ex };
}
const tuning = { syncMinGapMs: 5, statusPollMs: 5, syncTimeoutMs: 2_000, ackPollMs: 5 };
const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));
const events = (server: FakeServer) => server.syncs.flatMap((s) => s.jobs.flatMap((j) => j.events.map((e) => ({ ...e, jobId: j.jobId }))));

describe('startDaemon', () => {
  test('enrolled runner syncs with capabilities and free slots, takes an ASSIGN, runs it, uploads the bundle and gets every event acked', async () => {
    const server = fakeServer();
    const s = await setup(server);
    const log = createMemoryLogger();
    const daemon = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, log, executorFactory: () => s.ex });
    try {
      await waitFor(() => server.syncs.length >= 1);
      expect(server.syncs[0]).toMatchObject({ protocolVersion: 1, bootId: daemon.bootId, freeSlots: 2, jobs: [] });
      expect(server.syncs[0].capabilities).toMatchObject({ nax: { version: '0.83.0' }, tools: { gh: true }, executors: ['host'] });
      await waitFor(() => server.syncs.length >= 2);
      expect(server.syncs[1].capabilities).toBeUndefined();          // confirmed after the first success
      server.queue.push({ commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: assignFor('RUN') });
      await waitFor(() => events(server).some((e) => e.type === 'state' && (e.payload as { to: string }).to === 'COMPLETED'), { timeoutMs: 8_000 });
      expect(events(server).filter((e) => e.type === 'state').map((e) => (e.payload as { to: string }).to)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
      expect(server.syncs.some((sync) => sync.commandAcks.some((a) => a.commandId === 'c1' && a.result === 'ok'))).toBe(true);
      expect(server.uploads).toEqual([{ path: '/api/fleet/runner/jobs/j1/bundle', epoch: '1', sha: 'a'.repeat(64), bytes: 12 }]);
      await waitFor(() => daemon.journal.jobsWithPending().length === 0);
      expect(daemon.journal.getJob('j1', 1)?.doneAt).not.toBeNull();
      await waitFor(() => server.syncs.at(-1)?.freeSlots === 2);
      expect(JSON.stringify(log.lines)).not.toContain('kr_test');
    } finally {
      await daemon.stop();
      server.stop();
    }
  });

  test('a job in flight does not count as a free slot', async () => {
    const server = fakeServer();
    const s = await setup(server);
    s.ex.onTick = () => undefined;                                   // never exits on its own
    const daemon = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, executorFactory: () => s.ex });
    try {
      server.queue.push({ commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: assignFor('RUN') });
      await waitFor(() => server.syncs.some((sync) => sync.freeSlots === 1));
    } finally {
      s.ex.alive = false;
      await daemon.stop();
      server.stop();
    }
  });

  test('426 stops the loop and resolves stopped with the protocol reason', async () => {
    const server = fakeServer();
    server.mode.status = 426;
    const s = await setup(server);
    const daemon = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, executorFactory: () => s.ex });
    try {
      expect(await daemon.stopped).toMatchObject({ kind: 'protocol' });
    } finally {
      await daemon.stop();
      server.stop();
    }
  });

  test('an unreachable server at boot leaves capacity unknown: the daemon starts and reports freeSlots 0 until /me answers', async () => {
    const server = fakeServer();
    const s = await setup(server);
    let failMe = true;
    const fetchFn = async (url: string, init?: RequestInit) => {
      if (failMe && url.endsWith('/me')) throw new TypeError('connect ECONNREFUSED');
      return fetch(url, init);
    };
    const daemon = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning: { ...tuning, capacityRefreshMs: 30 }, fetchFn, executorFactory: () => s.ex });
    try {
      await waitFor(() => server.syncs.length >= 1);
      expect(server.syncs[0].freeSlots).toBe(0);
      failMe = false;
      await waitFor(() => server.syncs.at(-1)?.freeSlots === 2);
    } finally {
      await daemon.stop();
      server.stop();
    }
  });

  test('startup housekeeping: orphan job profiles are deleted, jobs done more than the retention ago are pruned with their directories, active jobs are kept', async () => {
    const server = fakeServer();
    const s = await setup(server);
    await mkdir(s.home.dir, { recursive: true });
    const old = Journal.open(s.home.journalPath, () => new Date('2026-01-01T00:00:00.000Z'));
    const oldDir = join(s.config.workspaceRoot, '.jobs', 'jold');
    const liveDir = join(s.config.workspaceRoot, '.jobs', 'jlive');
    for (const [id, dir] of [['jold', oldDir], ['jlive', liveDir]] as const) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'marker'), 'x');
      old.insertJob({ assign: assignFor('RUN', { jobId: id }) as AssignPayload, leaseEpoch: 1, repoKey: 'acme/app', jobDir: dir });
    }
    old.markDone('jold', 1);
    old.close();
    await mkdir(join(s.config.naxHome, 'profiles'), { recursive: true });
    for (const name of ['koda-job-jorphan.json', 'koda-job-jlive.json', 'machine.json']) await writeFile(join(s.config.naxHome, 'profiles', name), '{}');
    const daemon = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, executorFactory: () => s.ex });
    try {
      expect(daemon.journal.getJob('jold', 1)).toBeNull();
      expect(daemon.journal.getJob('jlive', 1)).not.toBeNull();
      await expect(stat(oldDir)).rejects.toThrow();
      expect(await readFile(join(liveDir, 'marker'), 'utf8')).toBe('x');
      await expect(stat(join(s.config.naxHome, 'profiles', 'koda-job-jorphan.json'))).rejects.toThrow();
      await stat(join(s.config.naxHome, 'profiles', 'koda-job-jlive.json'));
      await stat(join(s.config.naxHome, 'profiles', 'machine.json'));
      expect(daemon.journal.getMeta('runner_id')).toBe('r1');
      expect(daemon.journal.getMeta('boot_id')).toBe(daemon.bootId);
    } finally {
      await daemon.stop();
      server.stop();
    }
  });

  test('stop never kills a running job; a second daemon on the same home has a new boot id and finds the journal', async () => {
    const server = fakeServer();
    const s = await setup(server);
    s.ex.onTick = () => undefined;
    const first = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, executorFactory: () => s.ex });
    server.queue.push({ commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: assignFor('RUN') });
    await waitFor(() => s.ex.ticks >= 1);
    await first.stop();
    await first.stop();                                              // idempotent
    expect(s.ex.killed).toEqual([]);
    const second = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, executorFactory: () => new FakeExecutor() });
    try {
      expect(second.bootId).not.toBe(first.bootId);
      expect(second.journal.getJob('j1', 1)).toMatchObject({ state: 'RUNNING', pid: 4242 });
      await waitFor(() => server.syncs.some((sync) => sync.bootId === second.bootId));
    } finally {
      await second.stop();
      server.stop();
      s.ex.alive = false;
    }
  });

  test('stop waits for a halted run to end before it closes the journal (D67)', async () => {
    const server = fakeServer();
    const s = await setup(server);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let preparing = false;
    s.ex.prepare = async () => { preparing = true; await gate; return { ok: true, branch: 'feat/x' }; };
    const daemon = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, executorFactory: () => s.ex });
    try {
      server.queue.push({ commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: assignFor('RUN') });
      await waitFor(() => preparing);
      let closed = false;
      const close = daemon.journal.close.bind(daemon.journal);
      daemon.journal.close = () => { closed = true; close(); };
      const stopping = daemon.stop();
      await settle();
      await settle();
      expect(closed).toBe(false);                                     // the run is still inside prepare
      release();
      await stopping;
      expect(closed).toBe(true);
      expect(s.ex.calls).not.toContain('spawn:j1');                   // halted: it never went on to spawn
    } finally {
      release();
      server.stop();
    }
  });

  test('crash closes the journal at once, drains nothing and touches no child; the next daemon meets the RUNNING row (D40, D67)', async () => {
    const server = fakeServer();
    const s = await setup(server);
    s.ex.onTick = () => undefined;
    const first = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, executorFactory: () => s.ex });
    server.queue.push({ commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: assignFor('RUN') });
    await waitFor(() => s.ex.ticks >= 1);
    first.crash();
    expect(() => first.journal.getJob('j1', 1)).toThrow();            // closed, not drained
    expect(s.ex.killed).toEqual([]);
    await first.stopped;                                              // the aborted loop ends
    await first.stop();                                               // a stop after a crash is a no-op
    const second = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, executorFactory: () => new FakeExecutor() });
    try {
      expect(second.bootId).not.toBe(first.bootId);
      expect(second.journal.getJob('j1', 1)).toMatchObject({ state: 'RUNNING', pid: 4242 });
    } finally {
      await second.stop();
      server.stop();
      s.ex.alive = false;
    }
  });

  test('refuses to start with a git older than 2.30, before it creates anything (D69)', async () => {
    const server = fakeServer();
    const s = await setup(server);
    const oldGit: Git = { run: async () => ({ code: 0, stdout: 'git version 2.29.2\n', stderr: '' }), ok: async () => 'git version 2.29.2\n' };
    await expect(startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, git: oldGit, executorFactory: () => s.ex })).rejects.toThrow(/git 2\.30 or newer/);
    await expect(stat(s.home.journalPath)).rejects.toThrow();
    await expect(stat(join(s.config.workspaceRoot, '.jobs'))).rejects.toThrow();
    server.stop();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/runner && bun test test/unit/daemon.spec.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`daemon/daemon.ts`:

```ts
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { uploadWithRetry } from '../bundle/upload-bundle';
import { CapabilityReporter, StaticCapabilityProbe } from '../capabilities/capability-probe';
import type { RunnerConfig, RunnerHome } from '../config/runner-config';
import { errorMessage } from '../errors';
import { HostExecutor } from '../executor/host-executor';
import { assertMinGitVersion, createGit, type Git } from '../executor/git';
import type { JobExecutor } from '../executor/job-executor';
import { sweepOrphanProfiles } from '../executor/job-profile';
import { newBootId, type RunnerIdentityFile } from '../identity/identity-store';
import { Journal } from '../journal/journal';
import { createConsoleLogger, type Logger } from '../logger';
import { assertInside } from '../paths/safe-segment';
import { CommandHandler } from '../supervisor/command-handler';
import { RepoMutex } from '../supervisor/repo-mutex';
import { Supervisor } from '../supervisor/supervisor';
import type { BundleUploader } from '../supervisor/job-run';
import { ServerClient, type FetchFn } from '../sync/http';
import { SyncLoop, type StopReason } from '../sync/sync-loop';
import { systemNow, systemSleep, type Now, type Sleep } from '../time';
import { CapacityTracker, freeSlots } from './capacity';
import { DAEMON_VERSION } from '../version';
import { TUNING, type Tuning } from './tuning';

export interface DaemonOptions {
  readonly home: RunnerHome;
  readonly config: RunnerConfig;
  readonly identity: RunnerIdentityFile;
  readonly fetchFn?: FetchFn;
  readonly tuning?: Partial<Tuning>;
  readonly log?: Logger;
  readonly now?: Now;
  readonly sleep?: Sleep;
  readonly bootId?: string;
  readonly executorFactory?: () => JobExecutor;
  readonly git?: Git;
}

export interface DaemonHandle {
  readonly bootId: string;
  readonly journal: Journal;
  readonly supervisor: Supervisor;
  readonly stopped: Promise<StopReason | 'stopped'>;
  stop(): Promise<void>;
  crash(): void;
}

async function pruneJobs(journal: Journal, config: RunnerConfig, log: Logger): Promise<void> {
  const jobsRoot = join(config.workspaceRoot, '.jobs');
  for (const pruned of journal.prune(config.jobRetentionDays)) {
    try {
      await rm(assertInside(jobsRoot, pruned.jobDir), { recursive: true, force: true });
    } catch (error) {
      log.warn('could not remove a pruned job directory', { jobId: pruned.jobId, error: errorMessage(error) });
    }
  }
}

const SHUTDOWN_NOTICE_MS = 5_000;

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const { config, identity, home } = options;
  const tuning: Tuning = { ...TUNING, ...options.tuning };
  const log = options.log ?? createConsoleLogger();
  const now = options.now ?? systemNow;
  const sleep = options.sleep ?? systemSleep;
  const git = options.git ?? createGit();
  await assertMinGitVersion(git);   // D69: refuse to start before anything is created
  await mkdir(join(config.workspaceRoot, '.jobs'), { recursive: true });
  await mkdir(home.dir, { recursive: true });

  const journal = Journal.open(home.journalPath, now);
  const bootId = options.bootId ?? newBootId();
  journal.setMeta('boot_id', bootId);
  journal.setMeta('runner_id', identity.runnerId);
  await sweepOrphanProfiles(config.naxHome, new Set(journal.activeJobs().map((job) => job.jobId)));
  await pruneJobs(journal, config, log);

  const client = new ServerClient({ serverUrl: config.serverUrl, apiKey: identity.apiKey, fetchFn: options.fetchFn, syncTimeoutMs: tuning.syncTimeoutMs });
  const capacity = new CapacityTracker(client, log);
  await capacity.refresh();
  const reporter = new CapabilityReporter(new StaticCapabilityProbe(config.capabilities, now), journal);
  await reporter.refresh();

  const executor = options.executorFactory?.() ?? new HostExecutor({ config, git, log, nowMs: () => now().getTime() });
  const uploader: BundleUploader = {
    upload: (job, file, rebuild) => uploadWithRetry({
      upload: ({ jobId, leaseEpoch, file: f }) => client.uploadBundle({ jobId, leaseEpoch, filePath: f.path, sha256: f.sha256 }),
      rebuild, sleep, log,
    }, job.jobId, job.leaseEpoch, file),
  };
  const supervisor = new Supervisor({
    journal, executor, mutex: new RepoMutex(), uploader, log, now, sleep,
    tuning: { statusPollMs: tuning.statusPollMs, killGraceMs: tuning.killGraceMs, ackPollMs: tuning.ackPollMs, uploadAckWaitMs: tuning.uploadAckWaitMs },
    readoptHeartbeatMs: tuning.readoptHeartbeatMs,
  });
  const handler = new CommandHandler({ journal, supervisor, workspaceRoot: config.workspaceRoot, log, now });

  let stopReason: StopReason | null = null;
  const loop = new SyncLoop({
    client, journal, bootId, daemonVersion: DAEMON_VERSION,
    freeSlots: () => freeSlots(capacity.capacity, journal.activeCount()),
    capabilityReport: () => reporter.report(),
    onCapabilitiesSent: (hash) => reporter.markSent(hash),
    handleCommands: (commands) => handler.handle(commands),
    abandonUnknown: async (jobIds) => { for (const id of jobIds) await supervisor.abandonAll(id); },
    onStop: (reason) => {
      stopReason = reason;
      log.error(reason.kind === 'protocol' ? 'server does not support this runner protocol; stopped' : 'server rejected the runner key; stopped', { message: reason.message });
    },
    log, sleep, random: Math.random, nowMs: () => performance.now(), minGapMs: tuning.syncMinGapMs,
  });
  const running = loop.run().then((): StopReason | 'stopped' => stopReason ?? 'stopped');

  const timers = [
    setInterval(() => { void capacity.refresh(); }, tuning.capacityRefreshMs),
    setInterval(() => { void pruneJobs(journal, config, log); }, tuning.pruneIntervalMs),
  ];
  for (const timer of timers) timer.unref();

  let stopping: Promise<void> | null = null;
  let crashed = false;
  const stop = (): Promise<void> => {
    if (crashed) return Promise.resolve();
    stopping ??= (async () => {
      for (const timer of timers) clearInterval(timer);
      loop.stop();
      await running;
      supervisor.shutdown();
      // D67: a halted run ends at its next check, or when its current executor call returns. The journal must outlive it.
      const notice = setTimeout(() => log.warn('waiting for halted job runs to end before closing the journal'), SHUTDOWN_NOTICE_MS);
      try {
        await supervisor.idle();
      } finally {
        clearTimeout(notice);
      }
      journal.close();
    })();
    return stopping;
  };
  /** D40, D67: the in-process stand-in for `kill -9` of the daemon. Nothing is drained and no child is signalled. */
  const crash = (): void => {
    if (crashed || stopping) return;
    crashed = true;
    for (const timer of timers) clearInterval(timer);
    loop.stop();
    supervisor.shutdown();   // a real kill ends every run; in one process they must at least stop emitting
    journal.close();
  };
  return { bootId, journal, supervisor, stopped: running, stop, crash };
}
```

- [ ] **Step 4: Run and lint**

```bash
cd apps/runner && bun test test/unit/daemon.spec.ts && bun run type-check && bun run lint
```
Expected: PASS (9 tests), clean.

- [ ] **Step 5: Commit**

```bash
git add apps/runner
git commit -m "feat(fleet): runner daemon wiring (journal, housekeeping, capacity, sync loop, restart-safe stop)"
```

---

### Task 24: The CLI — `koda-runner enroll | run | status`

**Files:**
- Create: `apps/runner/src/commands/enroll.ts`, `enroll.spec.ts`
- Create: `apps/runner/src/commands/run.ts`, `run.spec.ts`
- Create: `apps/runner/src/commands/status.ts`, `status.spec.ts`
- Modify: `apps/runner/src/journal/journal.ts`, `journal.spec.ts` (3a-1 Task 8): add `Journal.openReadOnly` (D72)
- Modify: `apps/runner/src/main.ts`
- Create: `apps/runner/test/unit/main.spec.ts`

**Interfaces:**
- Consumes: `resolveHome`, `loadRunnerConfig`, `parseRunnerConfig`, `ConfigError`, `StaticCapabilities` (7), `readIdentity`, `writeIdentity`, `newBootId` (7), `ServerClient`, `ServerError`, `NetworkError` (9), `StaticCapabilityProbe` (22), `startDaemon` (23), `Journal` (8), `DAEMON_VERSION` (5), `FLEET_PROTOCOL_VERSION`.
- Produces:
  ```ts
  // enroll.ts
  export class EnrollError extends Error {}
  export interface EnrollOptions { readonly home: RunnerHome; readonly server?: string; readonly token: string; readonly name?: string; readonly labels: readonly string[]; readonly workspace?: string; readonly insecureHttp: boolean }
  export interface EnrollDeps { readonly env: NodeJS.ProcessEnv; readonly hostname: () => string; readonly platform: string; readonly arch: string; readonly which: (cmd: string) => string | null; readonly now: Now; readonly makeClient: (serverUrl: string) => Pick<ServerClient, 'enroll'>; readonly log: (line: string) => void }
  export function defaultRunnerName(hostname: string): string;                  // /^[a-z0-9][a-z0-9-]{0,62}$/, fallback "runner"
  export function defaultCapabilities(which: (cmd: string) => string | null): StaticCapabilities;   // D50
  export function enrollRunner(options: EnrollOptions, deps: EnrollDeps): Promise<{ runnerId: string; name: string }>;
  // run.ts
  export interface RunDeps { readonly env: NodeJS.ProcessEnv; readonly log: Logger; readonly start: (options: DaemonOptions) => Promise<DaemonHandle>; readonly onSignal: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void }
  export function runCommand(homeOverride: string | undefined, deps: RunDeps): Promise<number>;   // exit code: 0 clean stop, 1 not enrolled or bad config, 2 stopped by the server (426/401)
  // status.ts
  export interface StatusReport { home: string; enrolled: boolean; name?: string; runnerId?: string; serverUrl?: string; workspaceRoot?: string; journal?: { activeJobs: number; pendingEvents: number; jobs: Array<{ jobId: string; leaseEpoch: number; command: string; feature: string; state: string }> }; server?: { reachable: boolean; capacity?: number; enabled?: boolean; error?: string } }
  export function collectStatus(homeOverride: string | undefined, deps: { env: NodeJS.ProcessEnv; makeClient: (serverUrl: string, apiKey: string) => Pick<ServerClient, 'me'> }): Promise<StatusReport>;
  export function formatStatus(report: StatusReport): string;
  ```
  `Journal.openReadOnly(path: string, now?: Now): Journal` (D72): `new Database(path, { readonly: true })`, no schema statements, so `status` neither creates, migrates nor locks the journal of a running daemon; every write method throws on it. `enroll` with an existing `runner.json` never modifies it (D47); when `--labels`, `--workspace` or `--insecure-http` were passed it logs one warning naming them as ignored (D72).

  CLI (commander 12, as `apps/cli`): global `--home <dir>`; `enroll --token <t> [--server <url>] [--name <n>] [--labels a,b] [--workspace <dir>] [--insecure-http]` (token also from `KODA_RUNNER_ENROLL_TOKEN`, so it need not sit in `ps`); `run`; `status [--json]`. The enrollment token is never printed or stored.

- [ ] **Step 1: Write the failing specs**

`commands/enroll.spec.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FLEET_PROTOCOL_VERSION, type EnrollRequest } from '@nathapp/fleet-protocol';
import { loadRunnerConfig, resolveHome } from '../config/runner-config';
import { readIdentity } from '../identity/identity-store';
import { NetworkError, ServerError } from '../sync/http';
import { makeTempDirs } from '../../test/helpers/tmp';
import { EnrollError, defaultCapabilities, defaultRunnerName, enrollRunner, type EnrollDeps } from './enroll';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

function deps(over: Partial<EnrollDeps> & { enroll?: (body: EnrollRequest) => Promise<{ runnerId: string; apiKey: string }> } = {}) {
  const sent: EnrollRequest[] = [];
  const lines: string[] = [];
  const d: EnrollDeps = {
    env: {}, hostname: () => 'Mac-Mini.local', platform: 'darwin', arch: 'arm64', which: (c) => (c === 'gh' ? null : `/usr/bin/${c}`),
    now: () => new Date('2026-10-01T00:00:00.000Z'), log: (l) => { lines.push(l); },
    makeClient: () => ({ enroll: async (body) => { sent.push(body); return (over.enroll ?? (async () => ({ runnerId: 'r1', apiKey: 'kr_secret' })))(body); } }),
    ...over,
  };
  return { d, sent, lines };
}
async function opts(over: Record<string, unknown> = {}) {
  const dir = await tmp.make('enroll');
  return { home: resolveHome({}, join(dir, 'home')), server: 'https://koda.example.com', token: 'ke_token', labels: ['gpu'], insecureHttp: false, ...over } as Parameters<typeof enrollRunner>[0];
}

describe('helpers', () => {
  test.each([['Mac-Mini.local', 'mac-mini-local'], ['BOX_1', 'box-1'], ['---x', 'x'], ['', 'runner'], ['a'.repeat(100), 'a'.repeat(63)]])('defaultRunnerName(%j) = %j', (h, n) => {
    expect(defaultRunnerName(h)).toBe(n);
    expect(n).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
  });
  test('defaultCapabilities detects tools and declares the honest minimum (D50)', () => {
    const caps = defaultCapabilities((c) => (c === 'gh' ? null : `/bin/${c}`));
    expect(caps).toEqual({
      nax: { version: 'unknown', protocols: ['native'] }, sandbox: { available: false }, profiles: {}, credentials: [],
      tools: { git: true, gh: false, glab: true }, executors: ['host'],
    });
  });
});

describe('enrollRunner', () => {
  test('writes runner.json and identity.json (0600), sends the static capabilities and protocol version, and never stores the token', async () => {
    const o = await opts();
    const { d, sent } = deps();
    expect(await enrollRunner(o, d)).toEqual({ runnerId: 'r1', name: 'mac-mini-local' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      enrollmentToken: 'ke_token', name: 'mac-mini-local', os: 'darwin', arch: 'arm64', protocolVersion: FLEET_PROTOCOL_VERSION, labels: ['gpu'],
      capabilities: { nax: { version: 'unknown' }, sandbox: { available: false, probedAt: '2026-10-01T00:00:00.000Z' }, executors: ['host'] },
    });
    expect(sent[0].bootId).toMatch(/^[0-9a-f-]{36}$/);
    const identity = await readIdentity(o.home.identityPath);
    expect(identity).toMatchObject({ runnerId: 'r1', apiKey: 'kr_secret', serverUrl: 'https://koda.example.com', name: 'mac-mini-local', enrolledAt: '2026-10-01T00:00:00.000Z' });
    expect((await stat(o.home.identityPath)).mode & 0o777).toBe(0o600);
    const config = await loadRunnerConfig(o.home.configPath, {});
    expect(config).toMatchObject({ serverUrl: 'https://koda.example.com', labels: ['gpu'], workspaceRoot: join(o.home.dir, 'workspace') });
    expect(await readFile(o.home.configPath, 'utf8')).not.toContain('ke_token');
    expect(await readFile(o.home.identityPath, 'utf8')).not.toContain('ke_token');
  });
  test('honours --name, --workspace and --insecure-http for a non-loopback http server', async () => {
    const o = await opts({ server: 'http://koda.vpn:3101', insecureHttp: true, name: 'lab-1', workspace: join(await tmp.make('ws'), 'w') });
    const { d } = deps();
    expect((await enrollRunner(o, d)).name).toBe('lab-1');
    const config = await loadRunnerConfig(o.home.configPath, {});
    expect(config).toMatchObject({ allowInsecureHttp: true, serverUrl: 'http://koda.vpn:3101' });
  });
  test('refuses http on a non-loopback host without --insecure-http, before any request', async () => {
    const o = await opts({ server: 'http://koda.vpn:3101' });
    const { d, sent } = deps();
    await expect(enrollRunner(o, d)).rejects.toBeInstanceOf(EnrollError);
    expect(sent).toEqual([]);
  });
  test('refuses when already enrolled, naming the file to delete', async () => {
    const o = await opts();
    const { d } = deps();
    await enrollRunner(o, d);
    await expect(enrollRunner(o, d)).rejects.toThrow(/already enrolled.*identity\.json/s);
  });
  test('an existing runner.json is kept, and options it would have taken are named as ignored (D72)', async () => {
    const o = await opts({ labels: ['gpu'], workspace: join(await tmp.make('ws'), 'elsewhere'), insecureHttp: true });
    const { d, lines } = deps();
    await Bun.$`mkdir -p ${o.home.dir}`;
    const original = JSON.stringify({
      serverUrl: 'https://koda.example.com', workspaceRoot: join(o.home.dir, 'w'), labels: ['edited'],
      capabilities: { nax: { version: '0.83.0', protocols: ['native'] }, sandbox: { available: true }, tools: { git: true, gh: true, glab: true }, executors: ['host'] },
    });
    await writeFile(o.home.configPath, original);
    await enrollRunner(o, d);
    expect(await readFile(o.home.configPath, 'utf8')).toBe(original);
    const warning = lines.find((l) => /ignored/.test(l)) ?? '';
    for (const flag of ['--labels', '--workspace', '--insecure-http']) expect(warning).toContain(flag);
    expect(warning).toContain(o.home.configPath);
    const quiet = await opts({ labels: [], insecureHttp: false });
    const q = deps();
    await Bun.$`mkdir -p ${quiet.home.dir}`;
    await writeFile(quiet.home.configPath, original);
    await enrollRunner(quiet, q.d);
    expect(q.lines.some((l) => /ignored/.test(l))).toBe(false);
  });
  test('keeps an existing runner.json (hand-edited capabilities survive) and refuses a different --server', async () => {
    const o = await opts();
    const { d } = deps();
    await Bun.$`mkdir -p ${o.home.dir}`;
    await writeFile(o.home.configPath, JSON.stringify({
      serverUrl: 'https://koda.example.com', workspaceRoot: join(o.home.dir, 'w'), labels: ['edited'],
      capabilities: { nax: { version: '0.83.0', protocols: ['native', 'acp'] }, sandbox: { available: true }, tools: { git: true, gh: true, glab: true }, executors: ['host'] },
    }));
    await enrollRunner(o, d);
    expect(JSON.parse(await readFile(o.home.configPath, 'utf8')).labels).toEqual(['edited']);
    const other = await opts({ server: 'https://other.example.com' });
    await Bun.$`mkdir -p ${other.home.dir}`;
    await writeFile(other.home.configPath, await readFile(o.home.configPath, 'utf8'));
    await expect(enrollRunner(other, deps().d)).rejects.toThrow(/differs from/);
  });
  test('a missing server (no runner.json, no --server) is an error', async () => {
    await expect(enrollRunner(await opts({ server: undefined }), deps().d)).rejects.toThrow(/--server/);
  });
  test.each([
    [new ServerError(401, 'x', null), /invalid, used or expired/],
    [new ServerError(409, 'x', null), /already exists.*--name/s],
    [new ServerError(426, 'Unsupported protocol version 2', null), /does not support/],
    [new ServerError(400, 'bad capabilities', null), /rejected the request: bad capabilities/],
    [new NetworkError('ECONNREFUSED'), /cannot reach the server/],
  ])('maps %p to a readable EnrollError and writes no identity', async (failure, message) => {
    const o = await opts();
    const { d } = deps({ enroll: async () => { throw failure; } });
    await expect(enrollRunner(o, d)).rejects.toThrow(message);
    expect(await readIdentity(o.home.identityPath)).toBeNull();
  });
  test('an unsupported platform or architecture is refused', async () => {
    await expect(enrollRunner(await opts(), deps({ platform: 'win32' }).d)).rejects.toThrow(/unsupported platform/);
    await expect(enrollRunner(await opts(), deps({ arch: 'ia32' }).d)).rejects.toThrow(/unsupported platform/);
  });
});
```

`commands/run.spec.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveHome } from '../config/runner-config';
import { writeIdentity } from '../identity/identity-store';
import { createMemoryLogger } from '../logger';
import { makeTempDirs } from '../../test/helpers/tmp';
import { runCommand, type RunDeps } from './run';
import type { DaemonHandle } from '../daemon/daemon';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

async function enrolledHome(serverUrl = 'https://koda.example.com') {
  const dir = await tmp.make('run');
  const home = resolveHome({}, join(dir, 'home'));
  await mkdir(home.dir, { recursive: true });
  await writeFile(home.configPath, JSON.stringify({
    serverUrl, workspaceRoot: join(dir, 'ws'),
    capabilities: { nax: { version: '1', protocols: ['native'] }, sandbox: { available: false }, tools: { git: true, gh: true, glab: false }, executors: ['host'] },
  }));
  await writeIdentity(home.identityPath, { runnerId: 'r1', apiKey: 'kr_x', serverUrl, name: 'box', enrolledAt: 't' });
  return home;
}
function harness(stopper: (resolve: (v: 'stopped' | { kind: 'protocol' | 'auth'; message: string }) => void) => void) {
  const handlers: Array<() => void> = [];
  let stopped = 0;
  let stoppedOnce = false;
  const log = createMemoryLogger();
  const deps: RunDeps = {
    env: {}, log,
    start: async () => {
      let resolveStopped: (v: 'stopped' | { kind: 'protocol' | 'auth'; message: string }) => void = () => undefined;
      const stoppedPromise = new Promise<'stopped' | { kind: 'protocol' | 'auth'; message: string }>((r) => { resolveStopped = r; });
      stopper(resolveStopped);
      return { bootId: 'b', journal: null as never, supervisor: null as never, stopped: stoppedPromise as never, stop: async () => { if (!stoppedOnce) { stoppedOnce = true; stopped += 1; } resolveStopped('stopped'); }, crash: () => undefined } satisfies DaemonHandle;
    },
    onSignal: (_signal, handler) => { handlers.push(handler); },
  };
  return { deps, handlers, log, get stopped() { return stopped; } };
}

describe('runCommand', () => {
  test('returns 1 with a readable message when the machine is not enrolled', async () => {
    const h = harness(() => undefined);
    const dir = await tmp.make('run');
    expect(await runCommand(join(dir, 'nothing'), h.deps)).toBe(1);
    expect(h.log.lines.some((l) => l.level === 'error' && /enroll/.test(l.message))).toBe(true);
  });
  test('returns 1 when identity and config point at different servers', async () => {
    const home = await enrolledHome();
    await writeIdentity(home.identityPath, { runnerId: 'r1', apiKey: 'kr_x', serverUrl: 'https://elsewhere.example.com', name: 'box', enrolledAt: 't' });
    expect(await runCommand(home.dir, harness(() => undefined).deps)).toBe(1);
  });
  test('SIGTERM or SIGINT stops the daemon cleanly (exit 0) without killing jobs', async () => {
    const home = await enrolledHome();
    const h = harness(() => undefined);
    const finished = runCommand(home.dir, h.deps);
    await Bun.sleep(20);
    expect(h.handlers).toHaveLength(2);
    h.handlers[0]();
    expect(await finished).toBe(0);
    expect(h.stopped).toBe(1);
  });
  test('a stop imposed by the server (426 or 401) is exit code 2 and is logged', async () => {
    const home = await enrolledHome();
    const h = harness((resolve) => resolve({ kind: 'auth', message: 'runner key rejected' }));
    expect(await runCommand(home.dir, h.deps)).toBe(2);
    expect(h.log.lines.some((l) => l.level === 'error')).toBe(true);
  });
});
```

`commands/status.spec.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveHome } from '../config/runner-config';
import { writeIdentity } from '../identity/identity-store';
import { Journal } from '../journal/journal';
import { NetworkError } from '../sync/http';
import { assignFor } from '../../test/helpers/assign';
import { makeTempDirs } from '../../test/helpers/tmp';
import { collectStatus, formatStatus } from './status';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const client = (result: () => Promise<unknown>) => ({ makeClient: () => ({ me: result as never }), env: {} as NodeJS.ProcessEnv });

describe('collectStatus and formatStatus (D48)', () => {
  test('not enrolled: says so and touches nothing', async () => {
    const dir = await tmp.make('status');
    const report = await collectStatus(join(dir, 'home'), client(async () => { throw new Error('unused'); }));
    expect(report).toMatchObject({ enrolled: false });
    expect(formatStatus(report)).toMatch(/not enrolled/i);
  });
  test('enrolled: identity, journal counts and jobs, and the server view with capacity', async () => {
    const dir = await tmp.make('status');
    const home = resolveHome({}, join(dir, 'home'));
    await mkdir(home.dir, { recursive: true });
    await writeFile(home.configPath, JSON.stringify({
      serverUrl: 'https://koda.example.com', workspaceRoot: join(dir, 'ws'),
      capabilities: { nax: { version: '1', protocols: ['native'] }, sandbox: { available: false }, tools: { git: true, gh: true, glab: false }, executors: ['host'] },
    }));
    await writeIdentity(home.identityPath, { runnerId: 'r1', apiKey: 'kr_secret', serverUrl: 'https://koda.example.com', name: 'box', enrolledAt: 't' });
    const journal = Journal.open(home.journalPath);
    journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1' }), leaseEpoch: 2, repoKey: 'acme/app', jobDir: '/w/j1' });
    journal.appendEvent('j1', 2, 'log', { stream: 'run', text: 'x' });
    journal.close();
    const report = await collectStatus(home.dir, client(async () => ({ id: 'r1', name: 'box', labels: [], capacity: 2, enabled: true })));
    expect(report).toMatchObject({
      enrolled: true, name: 'box', runnerId: 'r1', serverUrl: 'https://koda.example.com',
      journal: { activeJobs: 1, pendingEvents: 1, jobs: [{ jobId: 'j1', leaseEpoch: 2, command: 'RUN', feature: 'feat', state: 'ASSIGNED' }] },
      server: { reachable: true, capacity: 2, enabled: true },
    });
    const text = formatStatus(report);
    expect(text).toContain('box');
    expect(text).toContain('j1');
    expect(text).not.toContain('kr_secret');
    expect(JSON.stringify(report)).not.toContain('kr_secret');
  });
  test('reads the journal read-only: a daemon may hold it open and keep writing (D72)', async () => {
    const dir = await tmp.make('status');
    const home = resolveHome({}, join(dir, 'home'));
    await mkdir(home.dir, { recursive: true });
    await writeFile(home.configPath, JSON.stringify({
      serverUrl: 'https://koda.example.com', workspaceRoot: join(dir, 'ws'),
      capabilities: { nax: { version: '1', protocols: ['native'] }, sandbox: { available: false }, tools: { git: true, gh: true, glab: false }, executors: ['host'] },
    }));
    await writeIdentity(home.identityPath, { runnerId: 'r1', apiKey: 'k', serverUrl: 'https://koda.example.com', name: 'box', enrolledAt: 't' });
    const daemonsJournal = Journal.open(home.journalPath);              // stays open, like the running daemon
    daemonsJournal.insertJob({ assign: assignFor('RUN', { jobId: 'j1' }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/w/j1' });
    const report = await collectStatus(home.dir, client(async () => ({ id: 'r1', name: 'box', labels: [], capacity: 1, enabled: true })));
    expect(report.journal?.activeJobs).toBe(1);
    daemonsJournal.insertJob({ assign: assignFor('RUN', { jobId: 'j2' }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/w/j2' });   // the writer is not blocked
    expect(daemonsJournal.activeCount()).toBe(2);
    daemonsJournal.close();
  });
  test('an unreachable server is reported, not thrown', async () => {
    const dir = await tmp.make('status');
    const home = resolveHome({}, join(dir, 'home'));
    await mkdir(home.dir, { recursive: true });
    await writeFile(home.configPath, JSON.stringify({
      serverUrl: 'https://koda.example.com', workspaceRoot: join(dir, 'ws'),
      capabilities: { nax: { version: '1', protocols: ['native'] }, sandbox: { available: false }, tools: { git: true, gh: true, glab: false }, executors: ['host'] },
    }));
    await writeIdentity(home.identityPath, { runnerId: 'r1', apiKey: 'k', serverUrl: 'https://koda.example.com', name: 'box', enrolledAt: 't' });
    const report = await collectStatus(home.dir, client(async () => { throw new NetworkError('ECONNREFUSED'); }));
    expect(report.server).toEqual({ reachable: false, error: 'ECONNREFUSED' });
    expect(formatStatus(report)).toContain('unreachable');
  });
});
```

`test/unit/main.spec.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const MAIN = join(import.meta.dir, '..', '..', 'src', 'main.ts');

async function cli(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', MAIN, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe('koda-runner CLI', () => {
  test('--version prints the package version', async () => {
    const { stdout, code } = await cli(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
  test('--help lists enroll, run and status', async () => {
    const { stdout } = await cli(['--help']);
    for (const word of ['enroll', 'run', 'status', '--home']) expect(stdout).toContain(word);
  });
  test('status on an empty home says not enrolled and exits 0; --json is machine readable', async () => {
    const home = join(await tmp.make('cli'), 'home');
    const text = await cli(['--home', home, 'status']);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/not enrolled/i);
    const json = await cli(['--home', home, 'status', '--json']);
    expect(JSON.parse(json.stdout)).toMatchObject({ enrolled: false });
  });
  test('run on an empty home exits 1 and tells the operator to enroll', async () => {
    const home = join(await tmp.make('cli'), 'home');
    const { stderr, code } = await cli(['--home', home, 'run']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/enroll/);
  });
  test('enroll without a token exits 1 and names the option and the environment variable', async () => {
    const home = join(await tmp.make('cli'), 'home');
    const { stderr, code } = await cli(['--home', home, 'enroll', '--server', 'https://koda.example.com'], { KODA_RUNNER_ENROLL_TOKEN: '' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/--token|KODA_RUNNER_ENROLL_TOKEN/);
  });
  test('an unreachable server on enroll is a readable error, not a stack trace', async () => {
    const home = join(await tmp.make('cli'), 'home');
    const { stderr, code } = await cli(['--home', home, 'enroll', '--server', 'http://127.0.0.1:9', '--token', 'ke_x']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/cannot reach the server/);
    expect(stderr).not.toMatch(/\n\s+at /);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/runner && bun test src/commands test/unit/main.spec.ts`
Expected: FAIL (modules missing; the stub `main.ts` has no subcommands).

- [ ] **Step 3: Implement `enroll.ts`**

`commands/enroll.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FLEET_PROTOCOL_VERSION } from '@nathapp/fleet-protocol';
import { StaticCapabilityProbe } from '../capabilities/capability-probe';
import { ConfigError, loadRunnerConfig, parseRunnerConfig, type RunnerHome, type StaticCapabilities } from '../config/runner-config';
import { errorMessage } from '../errors';
import { newBootId, readIdentity, writeIdentity } from '../identity/identity-store';
import { NetworkError, ServerError, type ServerClient } from '../sync/http';
import type { Now } from '../time';
import { DAEMON_VERSION } from '../version';

export class EnrollError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrollError';
  }
}

export interface EnrollOptions {
  readonly home: RunnerHome;
  readonly server?: string;
  readonly token: string;
  readonly name?: string;
  readonly labels: readonly string[];
  readonly workspace?: string;
  readonly insecureHttp: boolean;
}

export interface EnrollDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly hostname: () => string;
  readonly platform: string;
  readonly arch: string;
  readonly which: (cmd: string) => string | null;
  readonly now: Now;
  readonly makeClient: (serverUrl: string) => Pick<ServerClient, 'enroll'>;
  readonly log: (line: string) => void;
}

export function defaultRunnerName(hostname: string): string {
  const name = hostname.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '').slice(0, 63);
  return name === '' ? 'runner' : name;
}

/** D50: what a machine can honestly claim without asking nax; the operator edits runner.json for the rest. */
export function defaultCapabilities(which: (cmd: string) => string | null): StaticCapabilities {
  return {
    nax: { version: 'unknown', protocols: ['native'] }, sandbox: { available: false }, profiles: {}, credentials: [],
    tools: { git: which('git') !== null, gh: which('gh') !== null, glab: which('glab') !== null }, executors: ['host'],
  };
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(() => true, () => false);
}

async function ensureConfig(options: EnrollOptions, deps: EnrollDeps) {
  const { home } = options;
  if (await exists(home.configPath)) {
    const config = await loadRunnerConfig(home.configPath, deps.env);
    if (options.server && new URL(options.server).origin !== new URL(config.serverUrl).origin) {
      throw new EnrollError(`--server differs from the serverUrl in ${home.configPath}; edit or delete that file first`);
    }
    const ignored = [
      ...(options.labels.length > 0 ? ['--labels'] : []),
      ...(options.workspace ? ['--workspace'] : []),
      ...(options.insecureHttp ? ['--insecure-http'] : []),
    ];
    if (ignored.length > 0) deps.log(`warning: ${ignored.join(', ')} ignored: ${home.configPath} already exists and is not modified; edit that file instead`);
    return config;
  }
  if (!options.server) throw new EnrollError('--server <url> is required (no runner.json exists yet)');
  const raw = {
    serverUrl: options.server,
    ...(options.insecureHttp ? { allowInsecureHttp: true } : {}),
    workspaceRoot: options.workspace ?? join(home.dir, 'workspace'),
    labels: [...options.labels],
    naxCommand: ['nax'],
    capabilities: defaultCapabilities(deps.which),
  };
  const config = parseRunnerConfig(raw, deps.env);
  await mkdir(home.dir, { recursive: true, mode: 0o700 });
  await writeFile(home.configPath, `${JSON.stringify(raw, null, 2)}\n`);
  deps.log(`wrote ${home.configPath}; edit its "capabilities" block to declare nax version, profiles and credentials`);
  return config;
}

function explain(error: unknown, name: string): EnrollError {
  if (error instanceof ServerError) {
    if (error.status === 401) return new EnrollError('the enrollment token is invalid, used or expired');
    if (error.status === 409) return new EnrollError(`a runner named "${name}" already exists; pass --name to choose another`);
    if (error.status === 426) return new EnrollError(`the server does not support this runner: ${error.message}`);
    if (error.status === 400) return new EnrollError(`the server rejected the request: ${error.message}`);
    return new EnrollError(`the server answered ${error.status}: ${error.message}`);
  }
  if (error instanceof NetworkError) return new EnrollError(`cannot reach the server: ${error.message}`);
  return new EnrollError(errorMessage(error));
}

export async function enrollRunner(options: EnrollOptions, deps: EnrollDeps): Promise<{ runnerId: string; name: string }> {
  const { home } = options;
  if (await readIdentity(home.identityPath)) {
    throw new EnrollError(`this machine is already enrolled; delete ${home.identityPath} to enroll again (the old runner stays registered until an admin removes it)`);
  }
  if (deps.platform !== 'darwin' && deps.platform !== 'linux') throw new EnrollError(`unsupported platform ${deps.platform}`);
  if (deps.arch !== 'arm64' && deps.arch !== 'x64') throw new EnrollError(`unsupported platform architecture ${deps.arch}`);
  let config;
  try {
    config = await ensureConfig(options, deps);
  } catch (error) {
    if (error instanceof ConfigError) throw new EnrollError(error.message);
    throw error;
  }
  const name = options.name ?? defaultRunnerName(deps.hostname());
  const capabilities = await new StaticCapabilityProbe(config.capabilities, deps.now).probe();
  let enrolled: { runnerId: string; apiKey: string };
  try {
    enrolled = await deps.makeClient(config.serverUrl).enroll({
      enrollmentToken: options.token, name, os: deps.platform, arch: deps.arch, daemonVersion: DAEMON_VERSION,
      protocolVersion: FLEET_PROTOCOL_VERSION, bootId: newBootId(), labels: [...config.labels], capabilities,
    });
  } catch (error) {
    throw explain(error, name);
  }
  await writeIdentity(home.identityPath, { runnerId: enrolled.runnerId, apiKey: enrolled.apiKey, serverUrl: config.serverUrl, name, enrolledAt: deps.now().toISOString() });
  deps.log(`enrolled as ${name} (${enrolled.runnerId}); start it with: koda-runner run`);
  return { runnerId: enrolled.runnerId, name };
}
```

- [ ] **Step 4: Implement `run.ts` and `status.ts`**

`commands/run.ts`:

```ts
import { ConfigError, loadRunnerConfig, resolveHome } from '../config/runner-config';
import type { DaemonHandle, DaemonOptions } from '../daemon/daemon';
import { errorMessage } from '../errors';
import { IdentityError, readIdentity } from '../identity/identity-store';
import type { Logger } from '../logger';

export interface RunDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly log: Logger;
  readonly start: (options: DaemonOptions) => Promise<DaemonHandle>;
  readonly onSignal: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void;
}

/** Exit codes: 0 clean stop, 1 not enrolled or bad config, 2 stopped by the server (426 or 401). */
export async function runCommand(homeOverride: string | undefined, deps: RunDeps): Promise<number> {
  const home = resolveHome(deps.env, homeOverride);
  let daemon: DaemonHandle;
  try {
    const config = await loadRunnerConfig(home.configPath, deps.env);
    const identity = await readIdentity(home.identityPath);
    if (!identity) throw new ConfigError(`this machine is not enrolled; run "koda-runner enroll" first (looked for ${home.identityPath})`);
    if (new URL(identity.serverUrl).origin !== new URL(config.serverUrl).origin) {
      throw new ConfigError(`identity.json was issued by ${identity.serverUrl} but runner.json points at ${config.serverUrl}`);
    }
    daemon = await deps.start({ home, config, identity, log: deps.log });
  } catch (error) {
    if (error instanceof ConfigError || error instanceof IdentityError) {
      deps.log.error(error.message);
      return 1;
    }
    deps.log.error('could not start', { error: errorMessage(error) });
    return 1;
  }
  const stopOnSignal = (): void => { void daemon.stop(); };
  deps.onSignal('SIGTERM', stopOnSignal);
  deps.onSignal('SIGINT', stopOnSignal);
  const reason = await daemon.stopped;
  await daemon.stop();
  if (reason === 'stopped') return 0;
  deps.log.error(`stopped by the server (${reason.kind}): ${reason.message}`);
  return 2;
}
```

`commands/status.ts`:

```ts
import { access } from 'node:fs/promises';
import { loadRunnerConfig, resolveHome } from '../config/runner-config';
import { errorMessage } from '../errors';
import { readIdentity } from '../identity/identity-store';
import { Journal } from '../journal/journal';
import type { ServerClient } from '../sync/http';

export interface StatusReport {
  home: string;
  enrolled: boolean;
  name?: string;
  runnerId?: string;
  serverUrl?: string;
  workspaceRoot?: string;
  journal?: { activeJobs: number; pendingEvents: number; jobs: Array<{ jobId: string; leaseEpoch: number; command: string; feature: string; state: string }> };
  server?: { reachable: boolean; capacity?: number; enabled?: boolean; error?: string };
}

export async function collectStatus(
  homeOverride: string | undefined,
  deps: { env: NodeJS.ProcessEnv; makeClient: (serverUrl: string, apiKey: string) => Pick<ServerClient, 'me'> },
): Promise<StatusReport> {
  const home = resolveHome(deps.env, homeOverride);
  const identity = await readIdentity(home.identityPath).catch(() => null);
  if (!identity) return { home: home.dir, enrolled: false };
  const report: StatusReport = { home: home.dir, enrolled: true, name: identity.name, runnerId: identity.runnerId, serverUrl: identity.serverUrl };
  const config = await loadRunnerConfig(home.configPath, deps.env).catch(() => null);
  if (config) report.workspaceRoot = config.workspaceRoot;
  if (await access(home.journalPath).then(() => true, () => false)) {
    // D72: read-only, so status never creates, migrates or locks the journal a running daemon owns.
    try {
      const journal = Journal.openReadOnly(home.journalPath);
      try {
        report.journal = {
          ...journal.stats(),
          jobs: journal.activeJobs().map((j) => ({ jobId: j.jobId, leaseEpoch: j.leaseEpoch, command: j.command, feature: j.assign.feature, state: j.state })),
        };
      } finally {
        journal.close();
      }
    } catch {
      // an unreadable journal must not hide the rest of the report
    }
  }
  try {
    const me = await deps.makeClient(identity.serverUrl, identity.apiKey).me(AbortSignal.timeout(5_000));
    report.server = { reachable: true, capacity: me.capacity, enabled: me.enabled };
  } catch (error) {
    report.server = { reachable: false, error: errorMessage(error) };
  }
  return report;
}

export function formatStatus(report: StatusReport): string {
  if (!report.enrolled) return `not enrolled (home ${report.home}); run "koda-runner enroll --server <url> --token <token>"\n`;
  const lines = [`runner ${report.name} (${report.runnerId})`, `server ${report.serverUrl}`, `home   ${report.home}`];
  if (report.workspaceRoot) lines.push(`work   ${report.workspaceRoot}`);
  if (report.server) lines.push(report.server.reachable ? `server reachable: capacity ${report.server.capacity}, ${report.server.enabled ? 'enabled' : 'disabled'}` : `server unreachable: ${report.server.error}`);
  if (report.journal) {
    lines.push(`jobs   ${report.journal.activeJobs} active, ${report.journal.pendingEvents} events waiting to be acknowledged`);
    for (const job of report.journal.jobs) lines.push(`  ${job.jobId} epoch ${job.leaseEpoch} ${job.command} ${job.feature} ${job.state}`);
  }
  return `${lines.join('\n')}\n`;
}
```

`journal/journal.spec.ts` (3a-1 Task 8), add:

```ts
describe('openReadOnly (D72)', () => {
  test('reads what a writer committed, refuses every write, and creates nothing', async () => {
    const path = join(await tmp.make('ro'), 'journal.db');
    const writer = Journal.open(path, now);
    writer.insertJob(job());
    const reader = Journal.openReadOnly(path, now);
    expect(reader.getJob('j1', 1)?.state).toBe('ASSIGNED');
    expect(reader.stats().activeJobs).toBe(1);
    expect(() => reader.insertJob(job('j2'))).toThrow();
    expect(() => reader.setMeta('k', 'v')).toThrow();
    reader.close();
    writer.insertJob(job('j3'));                                          // the writer is unaffected
    writer.close();
    expect(() => Journal.openReadOnly(join(path, '..', 'missing.db'), now)).toThrow();
  });
});
```

and in `journal/journal.ts` (next to `open`):

```ts
  /** D72: for `koda-runner status`. No schema statements, no `create`: a missing or foreign file throws. */
  static openReadOnly(path: string, now: Now = systemNow): Journal {
    return new Journal(new Database(path, { readonly: true }), now);
  }
```
Run: `cd apps/runner && bun test src/journal src/commands` (expected PASS after Steps 3-4 below are in place; the journal part alone: `bun test src/journal`).

- [ ] **Step 5: Replace `main.ts`**

`src/main.ts`:

```ts
import { Command } from 'commander';
import { hostname } from 'node:os';
import { startDaemon } from './daemon/daemon';
import { EnrollError, enrollRunner } from './commands/enroll';
import { runCommand } from './commands/run';
import { collectStatus, formatStatus } from './commands/status';
import { resolveHome } from './config/runner-config';
import { createConsoleLogger } from './logger';
import { ServerClient } from './sync/http';
import { systemNow } from './time';
import { DAEMON_VERSION } from './version';

const say = (line: string): void => { process.stdout.write(`${line}\n`); };
const fail = (message: string): number => { process.stderr.write(`koda-runner: ${message}\n`); return 1; };

const program = new Command()
  .name('koda-runner')
  .description('Koda fleet runner daemon: executes nax jobs dispatched by the koda API')
  .version(DAEMON_VERSION)
  .option('--home <dir>', 'runner home (default $KODA_RUNNER_HOME or ~/.koda-runner)');

const home = (): string | undefined => program.opts<{ home?: string }>().home;

program
  .command('enroll')
  .description('Register this machine with a koda server using a single-use enrollment token')
  .option('--token <token>', 'enrollment token (or set KODA_RUNNER_ENROLL_TOKEN)')
  .option('--server <url>', 'koda server origin, https unless loopback or --insecure-http')
  .option('--name <name>', 'runner name (default: the host name)')
  .option('--labels <labels>', 'comma-separated labels', (v: string) => v.split(',').map((l) => l.trim()).filter(Boolean), [] as string[])
  .option('--workspace <dir>', 'workspace root for clones and job files')
  .option('--insecure-http', 'allow plain http to a non-loopback server (VPN phase)', false)
  .action(async (opts: { token?: string; server?: string; name?: string; labels: string[]; workspace?: string; insecureHttp: boolean }) => {
    const token = opts.token ?? process.env['KODA_RUNNER_ENROLL_TOKEN'];
    if (!token) {
      process.exitCode = fail('an enrollment token is required: pass --token or set KODA_RUNNER_ENROLL_TOKEN');
      return;
    }
    try {
      await enrollRunner(
        { home: resolveHome(process.env, home()), server: opts.server, token, name: opts.name, labels: opts.labels, workspace: opts.workspace, insecureHttp: opts.insecureHttp },
        {
          env: process.env, hostname, platform: process.platform, arch: process.arch, which: (c) => Bun.which(c), now: systemNow,
          makeClient: (serverUrl) => new ServerClient({ serverUrl }), log: say,
        },
      );
    } catch (error) {
      if (!(error instanceof EnrollError)) throw error;
      process.exitCode = fail(error.message);
    }
  });

program
  .command('run')
  .description('Run the daemon in the foreground (a service manager supervises it in production)')
  .action(async () => {
    process.exitCode = await runCommand(home(), {
      env: process.env, log: createConsoleLogger(), start: startDaemon, onSignal: (signal, handler) => { process.on(signal, handler); },
    });
  });

program
  .command('status')
  .description('Show enrollment, queued work and whether the server answers')
  .option('--json', 'machine-readable output', false)
  .action(async (opts: { json: boolean }) => {
    const report = await collectStatus(home(), { env: process.env, makeClient: (serverUrl, apiKey) => new ServerClient({ serverUrl, apiKey }) });
    process.stdout.write(opts.json ? `${JSON.stringify(report)}\n` : formatStatus(report));
  });

await program.parseAsync(process.argv);
```

- [ ] **Step 6: Run and lint**

```bash
cd apps/runner && bun test src test/unit && bun run type-check && bun run lint
```
Expected: PASS, clean. Then smoke the entry point: `bun src/main.ts --help`.

- [ ] **Step 7: Commit**

```bash
git add apps/runner
git commit -m "feat(fleet): koda-runner CLI (enroll, run, status) over injected dependencies"
```

---
### Task 25: Integration harness — real API, real Postgres, in-process daemon **[DB]**

**Files:**
- Create: `apps/runner/test/integration/harness/database.ts`
- Create: `apps/runner/test/integration/harness/api-process.ts`
- Create: `apps/runner/test/integration/harness/forge.ts`
- Create: `apps/runner/test/integration/harness/world.ts`
- Create: `apps/runner/test/integration/harness/index.ts`
- Create: `apps/runner/test/integration/harness.integration.spec.ts`
- Modify: `apps/runner/package.json` (devDependency `@prisma/client`), `bun.lock`

**Interfaces:**
- Consumes: the API test helpers `apps/api/test/helpers/test-database-url.ts` (`assertSafeTestDatabaseUrl`) and `apps/api/test/helpers/fake-forge.ts` (`startFakeForge`), imported by relative path (D39); the runner's own `enrollRunner`, `startDaemon`, `ServerClient`, `isolateGit`, `makeOrigin`.
- Produces:
  ```ts
  // database.ts
  export const API_DIR: string;                                      // <repo>/apps/api
  export function runnerTestDatabaseUrl(env?: NodeJS.ProcessEnv): string;   // KODA_RUNNER_TEST_DATABASE_URL, else postgresql://koda:koda@localhost:5433/koda_runner_test (DATABASE_URL is ignored, see database.ts)
  export function prepareDatabase(databaseUrl: string): Promise<void>;     // assertSafeTestDatabaseUrl, then prisma migrate reset --force
  export function assertPartialIndex(prisma: PrismaClient): Promise<void>;
  // api-process.ts
  export interface RunningApi { readonly url: string; output(): string; stop(): Promise<void> }
  export function startApi(env: Record<string, string>, cwd: string): Promise<RunningApi>;   // bun --no-env-file apps/api/dist/main.js, waits for /api/health
  // world.ts
  export interface JobView { id: string; state: string; stateReason: string | null; leaseEpoch: number; runnerId: string | null; resultBranch: string | null; resultSha: string | null; resultPrUrl: string | null; finishResult: string | null; naxRunId: string | null; naxLogRunId: string | null; naxCostRunId: string | null; costSpentUsd: string; cancelRequestedAt: string | null; currentStoryId: string | null }
  export interface EventView { seq: number; leaseEpoch: number; runnerSeq: number | null; type: string; payload: Record<string, unknown> }
  export interface SyncRecord { readonly outcome: 'delivered' | 'dropped' | 'refused'; readonly jobs: ReadonlyArray<{ readonly jobId: string; readonly seqs: readonly number[] }> }   // one per sync request: the jobs[].events[].seq it carried (D71)
  export interface NetControl { down: boolean; dropResponse: boolean; readonly syncs: SyncRecord[] }   // down: refuse before the request; dropResponse: perform the request, throw the response away
  export interface TestRunner { readonly name: string; readonly home: RunnerHome; readonly net: NetControl; readonly log: MemoryLogger; daemon: DaemonHandle | null; start(): Promise<DaemonHandle>; stop(): Promise<void>; crash(): void; journalBytes(): Promise<Buffer>; jobDir(jobId: string): string; identity(): Promise<RunnerIdentityFile> }
  export interface World {
    readonly base: string; readonly api: RunningApi; readonly prisma: PrismaClient; readonly origin: Origin;   // origin = bare acme/app
    dispatch(input: { feature: string; command?: 'RUN' | 'PLAN'; ref?: string; planFrom?: string }): Promise<string>;
    job(id: string): Promise<JobView>;
    events(id: string): Promise<EventView[]>;
    waitForJob(id: string, predicate: (job: JobView) => boolean, timeoutMs?: number): Promise<JobView>;
    cancel(id: string): Promise<void>;
    downloadBundle(id: string): Promise<{ status: number; bytes: Uint8Array }>;
    addRunner(name: string): Promise<TestRunner>;
    withFake<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T>;   // FAKE_NAX_* for processes spawned inside fn
    close(): Promise<void>;
  }
  export const FEATURES: readonly string[];                          // fa..fg, each with .nax/features/<f>/prd.json (branchName feat/<f>); fb carries a stale PRD (story OLD-1)
  export function createWorld(): Promise<World>;                     // a failure half way closes what was started (forge, API, Prisma, temp dir) before it rethrows (D73)
  ```
  `TestRunner.crash()` is `daemon.crash()` (Task 23): the journal closes at once, nothing drains, the child lives on, and the runner stays enabled server-side (a real kill does not tell the server). `stop()` still disables the runner row. `journalBytes()` is `journal.db`, `journal.db-wal` and `journal.db-shm` concatenated: recent rows live in the WAL until a checkpoint, so a secret scan of `journal.db` alone proves nothing (D73).
  Requests go through HTTP for register, project, repo, enrollment, dispatch, cancel and bundle download; polling (`job`, `events`, `waitForJob`) reads Prisma, because the API's global throttle is 100 requests a minute per IP.
  The world: a fresh `koda_runner_test` database (D38); a fake GitHub (`startFakeForge`) answering the App installation, repo and token routes; the API started from `apps/api/dist` with an explicit environment (D39) and `FLEET_SYNC_WAIT_MS=1500`; an admin (first registered user), project `web`, the GitHub repo `acme/app` registered over HTTP; a bare `acme/app.git` under `<base>/remotes` seeded with `README.md`, `docs/spec.md`, `.nax/config.json` and the `FEATURES` PRDs; `insteadOf` (via `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` in `process.env`, set after the API is spawned) maps the server's clone URL `http://127.0.0.1:<forge port>/acme/app.git` to that bare repo; and a fake `nax` (`naxCommand: ['bun', <abs>/fake-nax.ts]`) with `FAKE_NAX_STEP_MS=40`.

- [ ] **Step 1: Write the failing spec (it proves the harness, nothing runner-specific)**

`test/integration/harness.integration.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createWorld, assertPartialIndex, type World } from './harness';

setDefaultTimeout(120_000);
const enabled = process.env['KODA_DB_TESTS'] === '1';

describe.skipIf(!enabled)('integration harness', () => {
  let world: World;
  beforeAll(async () => { world = await createWorld(); }, 180_000);
  afterAll(async () => { await world?.close(); });

  test('the API answers, the partial unique index shipped by the migrations exists, and only *_test databases are touched', async () => {
    const health = await fetch(`${world.api.url}/api/health`);
    expect(health.status).toBe(200);
    await assertPartialIndex(world.prisma);
    const [db] = await world.prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
    expect(db.current_database).toBe('koda_runner_test');
  });

  test('a runner enrolls over HTTP, syncs, and shows up online with its capabilities', async () => {
    const runner = await world.addRunner('probe-1');
    await runner.start();
    try {
      const row = await world.prisma.runner.findUniqueOrThrow({ where: { name: 'probe-1' } });
      expect(row).toMatchObject({ enabled: true, capacity: 1, os: process.platform });
      const { waitFor } = await import('../helpers/wait');
      await waitFor(async () => (await world.prisma.runner.findUniqueOrThrow({ where: { name: 'probe-1' } })).bootId === runner.daemon?.bootId);
      expect((await world.prisma.runner.findUniqueOrThrow({ where: { name: 'probe-1' } })).capabilities).toMatchObject({ tools: { git: true, gh: true }, executors: ['host'] });
    } finally {
      await runner.stop();
    }
  });

  test('the net control records each sync\'s event seqs and can drop a response after the request was performed (D71)', async () => {
    const runner = await world.addRunner('probe-net');
    await runner.start();
    try {
      const { waitFor } = await import('../helpers/wait');
      await waitFor(() => runner.net.syncs.some((s) => s.outcome === 'delivered'));
      runner.net.dropResponse = true;
      await waitFor(() => runner.net.syncs.some((s) => s.outcome === 'dropped'));
      runner.net.down = true;
      runner.net.dropResponse = false;
      await waitFor(() => runner.net.syncs.some((s) => s.outcome === 'refused'));
      runner.net.down = false;
      const count = runner.net.syncs.length;
      await waitFor(() => runner.net.syncs.length > count && runner.net.syncs.at(-1)?.outcome === 'delivered');
    } finally {
      await runner.stop();
    }
  });

  test('a world that fails half way unwinds what it started (D73)', async () => {
    const { readdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const worlds = async () => (await readdir(tmpdir())).filter((name) => name.startsWith('koda-runner-it-')).length;
    const before = await worlds();
    const saved = process.env['KODA_RUNNER_TEST_DATABASE_URL'];
    process.env['KODA_RUNNER_TEST_DATABASE_URL'] = 'postgresql://koda:koda@db.example.com:5433/koda_runner_test';   // refused by assertSafeTestDatabaseUrl
    try {
      await expect(createWorld()).rejects.toThrow();
    } finally {
      if (saved === undefined) delete process.env['KODA_RUNNER_TEST_DATABASE_URL'];
      else process.env['KODA_RUNNER_TEST_DATABASE_URL'] = saved;
    }
    expect(await worlds()).toBe(before);                               // the temp directory was removed
  });

  test('the fake forge origin serves the seeded repository through the insteadOf mapping', async () => {
    const proc = Bun.spawn(['git', 'ls-remote', world.forgeCloneUrl], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
    expect(await new Response(proc.stdout).text()).toContain('refs/heads/main');
    expect(await proc.exited).toBe(0);
  });

  test('dispatch reaches a runner, the fake nax runs, and the job completes (a smoke test of every seam)', async () => {
    const runner = await world.addRunner('probe-2');
    await runner.start();
    try {
      const id = await world.dispatch({ feature: 'fa' });
      const job = await world.waitForJob(id, (j) => j.state === 'COMPLETED', 60_000);
      expect(job.resultPrUrl).toBe('https://example.test/koda/pull/1');
    } finally {
      await runner.stop();
    }
  });
});
```
(`World` also exposes `forgeCloneUrl: string`, the URL the server puts in ASSIGN payloads; add it to the interface above when implementing.)

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/runner && KODA_DB_TESTS=1 bun test test/integration/harness.integration.spec.ts`
Expected: FAIL (`./harness` does not exist). Without `KODA_DB_TESTS=1` the same command reports the tests as skipped: run that once too, expected `0 pass, 6 skip`.

- [ ] **Step 2b: Give the runner package `@prisma/client`**

`world.ts` imports `PrismaClient` by name; the runner must declare it rather than lean on hoisting from the root. In `apps/runner/package.json` add to `devDependencies`, at the root's own range (`package.json` root `dependencies`):

```json
    "@prisma/client": "^6.0.0",
```
Then:

```bash
bun install
git diff --stat bun.lock
git diff bun.lock | grep -E '^[+-]' | grep -v '^\(+++\|---\)'
```
Expected: `bun.lock` changes only inside the `apps/runner` workspace block (the new `"@prisma/client": "^6.0.0"` line); the resolved `@prisma/client@6.19.2` entry is untouched because the root already resolves it. Confirm `bun install --frozen-lockfile` passes afterwards. The client itself is generated by the API build (`prisma generate`), which the harness already requires.

- [ ] **Step 3: Implement `database.ts`**

`test/integration/harness/database.ts`:

```ts
import { resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { assertSafeTestDatabaseUrl } from '../../../../api/test/helpers/test-database-url';

export const API_DIR = resolve(import.meta.dir, '../../../../api');
const DATABASE_NAME = 'koda_runner_test';

/**
 * D38: a database of our own on the compose test server (`docker-compose.test.yml`, port 5433), so this suite never clobbers
 * the API integration database. `DATABASE_URL` is deliberately ignored: importing `@prisma/client` loads `apps/api/.env`
 * into `process.env`, so a developer's dev URL (or a stale SQLite one) would arrive here. Override with
 * `KODA_RUNNER_TEST_DATABASE_URL`; `assertSafeTestDatabaseUrl` still requires a local `*_test` database.
 */
export function runnerTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env['KODA_RUNNER_TEST_DATABASE_URL'] ?? `postgresql://koda:koda@localhost:5433/${DATABASE_NAME}`;
}

/**
 * `migrate reset` creates the database when it is missing and applies every migration (the web e2e precedent).
 * The consent variable exists because Prisma refuses destructive commands from AI agents without it; it is safe here
 * because the URL is checked to be a local `*_test` database first.
 */
export async function prepareDatabase(databaseUrl: string): Promise<void> {
  assertSafeTestDatabaseUrl(databaseUrl);
  const proc = Bun.spawn(['bunx', 'prisma', 'migrate', 'reset', '--force', '--skip-seed', '--skip-generate'], {
    cwd: API_DIR, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: 'yes' },
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`prisma migrate reset failed (${code}):\n${out}\n${err}`);
}

export async function assertPartialIndex(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`SELECT indexdef FROM pg_indexes WHERE indexname = 'FleetJob_active_repo_feature_key'`;
  if (rows.length !== 1 || !/WHERE/i.test(rows[0].indexdef)) {
    throw new Error('the partial unique index FleetJob_active_repo_feature_key is missing: migrate reset did not apply the fleet migrations');
  }
}
```

- [ ] **Step 4: Implement `api-process.ts`**

`test/integration/harness/api-process.ts`:

```ts
import { existsSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { API_DIR } from './database';

export interface RunningApi {
  readonly url: string;
  output(): string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** D39: the built API (`bunx turbo run build --filter=@nathapp/koda-api`), an explicit environment, no `.env` files. */
export async function startApi(env: Record<string, string>, cwd: string): Promise<RunningApi> {
  const entry = join(API_DIR, 'dist', 'main.js');
  if (!existsSync(entry)) throw new Error('apps/api/dist is missing; build it first: bunx turbo run build --filter=@nathapp/koda-api');
  const port = await freePort();
  const proc = Bun.spawn(['bun', '--no-env-file', entry], {
    cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'], NODE_ENV: 'test', API_HOST: '127.0.0.1', API_PORT: String(port), ...env },
  });
  let captured = '';
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) captured = (captured + decoder.decode(chunk)).slice(-20_000);
  };
  void collect(proc.stdout);
  void collect(proc.stderr);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`the API exited during start-up (${proc.exitCode}):\n${captured}`);
    try {
      if ((await fetch(`${url}/api/health`)).status === 200) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`the API did not become healthy in 90 s:\n${captured}`);
    }
    await Bun.sleep(250);
  }
  return {
    url,
    output: () => captured,
    async stop() {
      if (proc.exitCode !== null) return;
      proc.kill('SIGTERM');
      const exited = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => null)]);
      if (exited === null) proc.kill('SIGKILL');
    },
  };
}
```

- [ ] **Step 5: Implement `forge.ts`**

`test/integration/harness/forge.ts`:

```ts
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startFakeForge, type FakeForge } from '../../../../api/test/helpers/fake-forge';

export interface Forge {
  readonly forge: FakeForge;
  readonly keyFile: string;
}

/** A local GitHub: the App installation, the repo and the token route the API's registration check calls (fleet-repos.integration.spec.ts). */
export async function startForge(dir: string): Promise<Forge> {
  const forge = await startFakeForge();
  await mkdir(dir, { recursive: true });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyFile = join(dir, 'github-app.pem');
  await writeFile(keyFile, privateKey.export({ type: 'pkcs1', format: 'pem' }));
  forge.routes.set('GET /repos/acme/app/installation', () => ({ status: 200, body: { id: 77 } }));
  forge.routes.set('GET /repos/acme/app', () => ({ status: 200, body: { name: 'app', owner: { login: 'acme' }, default_branch: 'main' } }));
  forge.routes.set('POST /app/installations/77/access_tokens', () => ({ status: 201, body: { token: 'ghs_harness', expires_at: '2099-01-01T00:00:00Z' } }));
  return { forge, keyFile };
}
```

- [ ] **Step 6: Implement `world.ts`**

`test/integration/harness/world.ts`:

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { SyncRequest } from '@nathapp/fleet-protocol';
import { enrollRunner } from '../../../src/commands/enroll';
import { loadRunnerConfig, resolveHome, type RunnerHome } from '../../../src/config/runner-config';
import { startDaemon, type DaemonHandle } from '../../../src/daemon/daemon';
import { readIdentity, type RunnerIdentityFile } from '../../../src/identity/identity-store';
import { createMemoryLogger, type MemoryLogger } from '../../../src/logger';
import { jobDirFor } from '../../../src/paths/safe-segment';
import { ServerClient } from '../../../src/sync/http';
import { systemNow } from '../../../src/time';
import { isolateGit, makeOrigin, type Origin } from '../../helpers/git-fixture';
import { startApi, type RunningApi } from './api-process';
import { assertPartialIndex, prepareDatabase, runnerTestDatabaseUrl } from './database';
import { startForge, type Forge } from './forge';

const PASSWORD = 'Admin1234!Aa';
const FAKE_NAX = join(import.meta.dir, '..', '..', 'fixtures', 'fake-nax.ts');
export const FEATURES: readonly string[] = ['fa', 'fb', 'fc', 'fd', 'fe', 'ff', 'fg'];

export interface JobView {
  id: string; state: string; stateReason: string | null; leaseEpoch: number; runnerId: string | null;
  resultBranch: string | null; resultSha: string | null; resultPrUrl: string | null; finishResult: string | null;
  naxRunId: string | null; naxLogRunId: string | null; naxCostRunId: string | null; costSpentUsd: string;
  cancelRequestedAt: string | null; currentStoryId: string | null;
}
export interface EventView { seq: number; leaseEpoch: number; runnerSeq: number | null; type: string; payload: Record<string, unknown> }

/** One per sync request (D71): the seqs of the events it carried, and what the network did with it. */
export interface SyncRecord {
  readonly outcome: 'delivered' | 'dropped' | 'refused';
  readonly jobs: ReadonlyArray<{ readonly jobId: string; readonly seqs: readonly number[] }>;
}

/** `down` refuses before the request leaves; `dropResponse` performs the request and throws the response away. */
export interface NetControl {
  down: boolean;
  dropResponse: boolean;
  readonly syncs: SyncRecord[];
}

export interface TestRunner {
  readonly name: string;
  readonly home: RunnerHome;
  readonly net: NetControl;
  readonly log: MemoryLogger;
  daemon: DaemonHandle | null;
  start(): Promise<DaemonHandle>;
  stop(): Promise<void>;
  crash(): void;
  journalBytes(): Promise<Buffer>;
  jobDir(jobId: string): string;
  identity(): Promise<RunnerIdentityFile>;
}

export interface World {
  readonly base: string;
  readonly api: RunningApi;
  readonly prisma: PrismaClient;
  readonly origin: Origin;
  readonly forgeCloneUrl: string;
  dispatch(input: { feature: string; command?: 'RUN' | 'PLAN'; ref?: string; planFrom?: string }): Promise<string>;
  job(id: string): Promise<JobView>;
  events(id: string): Promise<EventView[]>;
  waitForJob(id: string, predicate: (job: JobView) => boolean, timeoutMs?: number): Promise<JobView>;
  cancel(id: string): Promise<void>;
  downloadBundle(id: string): Promise<{ status: number; bytes: Uint8Array }>;
  addRunner(name: string): Promise<TestRunner>;
  withFake<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const prd = (feature: string, story: string): string => `${JSON.stringify({ feature, branchName: `feat/${feature}`, userStories: [{ id: story, title: 'story' }] }, null, 2)}\n`;

type Cleanup = () => Promise<void>;

/** Reverse order, every step attempted: what a half-built world started must not outlive the failure (D73). */
async function unwind(cleanups: Cleanup[]): Promise<void> {
  for (const cleanup of [...cleanups].reverse()) await cleanup().catch(() => undefined);
}

export async function createWorld(): Promise<World> {
  const base = await mkdtemp(join(tmpdir(), 'koda-runner-it-'));
  const cleanups: Cleanup[] = [() => rm(base, { recursive: true, force: true })];
  try {
    return await buildWorld(base, cleanups);
  } catch (error) {
    await unwind(cleanups);
    throw error;
  }
}

async function buildWorld(base: string, cleanups: Cleanup[]): Promise<World> {
  isolateGit();
  const databaseUrl = runnerTestDatabaseUrl();
  await prepareDatabase(databaseUrl);
  const { forge, keyFile }: Forge = await startForge(join(base, 'forge'));
  cleanups.push(() => forge.close());
  const api = await startApi({
    DATABASE_URL: databaseUrl, JWT_SECRET: 'it-jwt-secret', JWT_REFRESH_SECRET: 'it-jwt-refresh-secret', API_KEY_SECRET: 'it-api-key-secret',
    RAG_IN_MEMORY_ONLY: 'true', EMBEDDING_PROVIDER: 'fake', REGISTRATION_ENABLED: 'true', AUTH_LOGIN_THROTTLE_LIMIT: '1000',
    FLEET_SYNC_WAIT_MS: '1500', FLEET_SWEEP_ENABLED: 'false', FLEET_ARTIFACT_DIR: join(base, 'artifacts'),
    VCS_ENCRYPTION_KEY: 'b'.repeat(64), GITHUB_APP_ID: '4242', GITHUB_APP_PRIVATE_KEY_FILE: keyFile, GITHUB_APP_SLUG: 'koda-fleet',
    GITHUB_API_URL: forge.url, VCS_GITLAB_API_URL: `${forge.url}/api/v4`,
  }, base);
  cleanups.push(() => api.stop());
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  cleanups.push(() => prisma.$disconnect());
  await assertPartialIndex(prisma);

  const http = async (method: string, path: string, opts: { body?: unknown; token?: string } = {}) => {
    const res = await fetch(`${api.url}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const registered = await http('POST', '/auth/register', { body: { email: 'root@koda.test', name: 'Root', password: PASSWORD } });
  if (registered.status !== 201) throw new Error(`register failed: ${JSON.stringify(registered.body)}`);
  const admin: string = registered.body.data.accessToken;
  await http('POST', '/projects', { token: admin, body: { name: 'Web', slug: 'web', key: 'WEB' } });
  const repo = await http('POST', '/fleet/repos', { token: admin, body: { projectSlug: 'web', provider: 'github', owner: 'acme', name: 'app' } });
  if (repo.status !== 201) throw new Error(`repo registration failed: ${JSON.stringify(repo.body)}\n${api.output()}`);
  const repoId: string = repo.body.data.id;

  const files: Record<string, string> = { 'README.md': '# app\n', 'docs/spec.md': '# spec\n', '.nax/config.json': '{}\n' };
  for (const f of FEATURES) files[`.nax/features/${f}/prd.json`] = prd(f, f === 'fb' ? 'OLD-1' : 'US-001');
  const remotes = join(base, 'remotes');
  const origin = await makeOrigin(join(remotes, 'acme'), 'app', { files });
  const forgeCloneUrl = `${forge.url}/acme/app.git`;
  // D39: the server's clone URL is the fake forge's; git rewrites it to the bare repository.
  process.env['GIT_CONFIG_COUNT'] = '1';
  process.env['GIT_CONFIG_KEY_0'] = `url.file://${remotes}/.insteadOf`;
  process.env['GIT_CONFIG_VALUE_0'] = `${forge.url}/`;
  process.env['FAKE_NAX_STEP_MS'] = '40';
  cleanups.push(async () => { for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'FAKE_NAX_STEP_MS']) delete process.env[k]; });

  const runners: TestRunner[] = [];
  const savedFake: Record<string, string | undefined> = {};

  // Polling reads the database: the API's global throttle is 100 requests a minute per IP and a 10 Hz poll would trip it.
  const job = async (id: string): Promise<JobView> => {
    const r = await prisma.fleetJob.findUniqueOrThrow({ where: { id } });
    return {
      id: r.id, state: r.state, stateReason: r.stateReason, leaseEpoch: r.leaseEpoch, runnerId: r.runnerId, resultBranch: r.resultBranch,
      resultSha: r.resultSha, resultPrUrl: r.resultPrUrl, finishResult: r.finishResult, naxRunId: r.naxRunId, naxLogRunId: r.naxLogRunId,
      naxCostRunId: r.naxCostRunId, costSpentUsd: r.costSpentUsd.toString(), cancelRequestedAt: r.cancelRequestedAt?.toISOString() ?? null,
      currentStoryId: r.currentStoryId,
    };
  };

  const world: World = {
    base, api, prisma, origin, forgeCloneUrl,
    async dispatch(input) {
      const res = await http('POST', '/projects/web/fleet/jobs', {
        token: admin,
        body: { repoId, command: input.command ?? 'RUN', feature: input.feature, ...(input.ref ? { ref: input.ref } : {}), ...(input.planFrom ? { planFrom: input.planFrom } : {}), maxCostUsd: 5 },
      });
      if (res.status !== 201) throw new Error(`dispatch failed: ${JSON.stringify(res.body)}`);
      return res.body.data.job.id as string;
    },
    job,
    async events(id) {
      const rows = await prisma.fleetJobEvent.findMany({ where: { jobId: id }, orderBy: { seq: 'asc' } });
      return rows.map((e) => ({ seq: e.seq, leaseEpoch: e.leaseEpoch, runnerSeq: e.runnerSeq, type: e.type, payload: e.payload as Record<string, unknown> }));
    },
    async waitForJob(id, predicate, timeoutMs = 45_000) {
      const deadline = Date.now() + timeoutMs;
      let last = await job(id);
      while (!predicate(last)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for job ${id}; last view: ${JSON.stringify(last)}\nAPI tail:\n${api.output().slice(-1500)}`);
        await Bun.sleep(100);
        last = await job(id);
      }
      return last;
    },
    async cancel(id) {
      const res = await http('POST', `/projects/web/fleet/jobs/${id}/cancel`, { token: admin });
      if (res.status !== 200) throw new Error(`cancel failed: ${JSON.stringify(res.body)}`);
    },
    async downloadBundle(id) {
      const res = await fetch(`${api.url}/api/projects/web/fleet/jobs/${id}/bundle`, { headers: { authorization: `Bearer ${admin}` } });
      return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
    },
    async addRunner(name) {
      const dir = await mkdtemp(join(base, `runner-${name}-`));
      const home = resolveHome({}, join(dir, 'home'));
      const workspaceRoot = join(dir, 'ws');
      await mkdir(home.dir, { recursive: true });
      await writeFile(home.configPath, JSON.stringify({
        serverUrl: api.url, workspaceRoot, naxHome: join(dir, 'naxhome'), naxCommand: ['bun', FAKE_NAX], labels: ['harness'],
        capabilities: { nax: { version: '0.0.0-fake', protocols: ['native'] }, sandbox: { available: true }, profiles: {}, credentials: [], tools: { git: true, gh: true, glab: false }, executors: ['host'] },
      }));
      const token: string = (await http('POST', '/fleet/enrollments', { token: admin, body: { labels: [] } })).body.data.token;
      await enrollRunner(
        { home, token, name, labels: [], insecureHttp: false },
        { env: {}, hostname: () => name, platform: process.platform, arch: process.arch, which: (c) => Bun.which(c), now: systemNow, makeClient: (serverUrl) => new ServerClient({ serverUrl }), log: () => undefined },
      );
      const net: NetControl = { down: false, dropResponse: false, syncs: [] };
      const log = createMemoryLogger();
      const runner: TestRunner = {
        name, home, net, log, daemon: null,
        async start() {
          const [config, identity] = [await loadRunnerConfig(home.configPath, {}), await readIdentity(home.identityPath)];
          if (!identity) throw new Error('runner is not enrolled');
          const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
            const seen = recordSync(url, init);
            if (net.down) {
              if (seen) net.syncs.push({ outcome: 'refused', jobs: seen });
              throw new TypeError('network down');
            }
            const response = await fetch(url, init);
            if (net.dropResponse) {
              await response.arrayBuffer().catch(() => undefined);      // the server did its work; the runner never hears
              if (seen) net.syncs.push({ outcome: 'dropped', jobs: seen });
              throw new TypeError('response lost');
            }
            if (seen) net.syncs.push({ outcome: 'delivered', jobs: seen });
            return response;
          };
          await prisma.runner.update({ where: { name }, data: { enabled: true } });
          runner.daemon = await startDaemon({ home, config, identity, log, fetchFn, tuning: { statusPollMs: 50, syncMinGapMs: 20, ackPollMs: 25 } });
          return runner.daemon;
        },
        async stop() {
          await runner.daemon?.stop();
          // A stopped runner stays "online" for 90 s; disable it so placement never picks a daemon that is not there.
          await prisma.runner.update({ where: { name }, data: { enabled: false } }).catch(() => undefined);
        },
        crash() {
          runner.daemon?.crash();   // D40, D67: journal closed at once, nothing drained, no child signalled; the server is not told
        },
        async journalBytes() {
          const parts = await Promise.all(['', '-wal', '-shm'].map((suffix) => readFile(`${home.journalPath}${suffix}`).catch(() => Buffer.alloc(0))));
          return Buffer.concat(parts);
        },
        jobDir: (jobId) => jobDirFor(workspaceRoot, jobId),
        identity: async () => {
          const identity = await readIdentity(home.identityPath);
          if (!identity) throw new Error('runner is not enrolled');
          return identity;
        },
      };
      runners.push(runner);
      return runner;
    },
    async withFake(env, fn) {
      for (const [k, v] of Object.entries(env)) {
        savedFake[k] = process.env[k];
        process.env[k] = v;
      }
      try {
        return await fn();
      } finally {
        for (const k of Object.keys(env)) {
          if (savedFake[k] === undefined) delete process.env[k];
          else process.env[k] = savedFake[k];
        }
      }
    },
    async close() {
      await Promise.all(runners.map((r) => r.stop().catch(() => undefined)));
      await unwind(cleanups);
    },
  };
  return world;
}

/** The seqs a sync request carries, per job (D71); null for any other request. */
function recordSync(url: string, init?: RequestInit): SyncRecord['jobs'] | null {
  if (!url.endsWith('/fleet/runner/sync') || typeof init?.body !== 'string') return null;
  const body = JSON.parse(init.body) as SyncRequest;
  return body.jobs.map((job) => ({ jobId: job.jobId, seqs: job.events.map((event) => event.seq) }));
}
```

`test/integration/harness/index.ts`:

```ts
export { assertPartialIndex } from './database';
export { createWorld, FEATURES, type EventView, type JobView, type NetControl, type SyncRecord, type TestRunner, type World } from './world';
```

- [ ] **Step 7: Build the API once, start the test database, run the spec**

```bash
bunx turbo run build --filter=@nathapp/koda-api
cd apps/api && bun run test:db:up && cd ../runner
KODA_DB_TESTS=1 bun test test/integration/harness.integration.spec.ts
```
Expected: 6 pass in well under two minutes. If the API cannot start, the failure message carries the API's captured output. Then `bun run test:integration` without the flag reports every test skipped.

- [ ] **Step 8: Lint, type check, commit**

```bash
bun run type-check && bun run lint
git add apps/runner
git commit -m "test(fleet): runner integration harness (own *_test database, built API, fake forge, in-process daemon)"
```

---

### Task 26: 3a scenarios — RUN, PLAN then RUN, cancel **[DB]**

**Files:**
- Create: `apps/runner/test/integration/run-plan.integration.spec.ts`

**Interfaces:**
- Consumes: the harness (25), the fake `nax` (13).
- Produces: three end-to-end scenarios of slice 3 design §4: RUN happy path; PLAN commit and push followed by a RUN on the pushed branch (R-3.3 and R-3.4 together); cancel.

- [ ] **Step 1: Write the failing spec**

`test/integration/run-plan.integration.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProcessAlive } from '../../src/executor/nax-process';
import { git as sh } from '../helpers/git-fixture';
import { waitFor } from '../helpers/wait';
import { createWorld, type EventView, type TestRunner, type World } from './harness';

setDefaultTimeout(120_000);
const enabled = process.env['KODA_DB_TESTS'] === '1';

const runnerStates = (events: EventView[]) => events.filter((e) => e.type === 'state').map((e) => (e.payload as { to: string }).to);
const inOrder = (all: string[], wanted: string[]) => wanted.every((s, i) => all.indexOf(s) >= 0 && (i === 0 || all.indexOf(s) > all.indexOf(wanted[i - 1])));

async function tarNames(bytes: Uint8Array): Promise<{ names: string[]; read: (path: string) => Promise<string> }> {
  const dir = await mkdtemp(join(tmpdir(), 'koda-bundle-'));
  const file = join(dir, 'bundle.tar.gz');
  await writeFile(file, bytes);
  const list = Bun.spawn(['tar', '-tzf', file], { stdout: 'pipe' });
  const names = (await new Response(list.stdout).text()).split('\n').filter(Boolean);
  const read = async (path: string) => {
    const proc = Bun.spawn(['tar', '-xzOf', file, path], { stdout: 'pipe' });
    return new Response(proc.stdout).text();
  };
  return { names, read };
}

describe.skipIf(!enabled)('runner 3a against the real API: RUN, PLAN, cancel', () => {
  let world: World;
  let runner: TestRunner;
  beforeAll(async () => {
    world = await createWorld();
    runner = await world.addRunner('run-plan');
    await runner.start();
  }, 180_000);
  afterAll(async () => { await world?.close(); });

  test('RUN happy path: branch from the PRD, verdict from status.json, result fields, ordered timeline, downloadable bundle, no secrets', async () => {
    const id = await world.dispatch({ feature: 'fa' });
    const job = await world.waitForJob(id, (j) => j.state === 'COMPLETED');
    expect(job).toMatchObject({ finishResult: 'opened', resultPrUrl: 'https://example.test/koda/pull/1', resultBranch: 'feat/fa', stateReason: null });
    expect(job.naxRunId).toMatch(/^run-/);
    expect(job.naxLogRunId).toMatch(/^log-/);
    expect(job.naxCostRunId).toMatch(/^cost-/);
    expect(Number(job.costSpentUsd)).toBeGreaterThan(0);

    const remoteTip = await sh(world.origin.dir, 'rev-parse', 'feat/fa');
    expect(job.resultSha).toBe(remoteTip);
    expect(await sh(world.origin.dir, 'rev-parse', 'feat/fa~1')).toBe(await sh(world.origin.dir, 'rev-parse', 'main'));
    expect(await sh(world.origin.dir, 'log', '-1', '--format=%s', 'feat/fa')).toContain('fake story work');

    const events = await world.events(id);
    expect(inOrder(runnerStates(events), ['ASSIGNED', 'RUNNING', 'UPLOADING', 'COMPLETED'])).toBe(true);
    expect(events.some((e) => e.type === 'snapshot')).toBe(true);
    expect(events.some((e) => e.type === 'log' && (e.payload as { stream: string }).stream === 'run')).toBe(true);
    const seqs = events.filter((e) => e.runnerSeq !== null).map((e) => e.runnerSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => (a as number) - (b as number)));

    const bundle = await world.downloadBundle(id);
    expect(bundle.status).toBe(200);
    const { names, read } = await tarNames(bundle.bytes);
    expect(names).toEqual(expect.arrayContaining(['bundle-manifest.json', 'nax-out/status.json', 'nax-out/metrics.json', 'nax.stdout', 'nax.stderr']));
    expect(names.some((n) => n.includes('prompt-audit'))).toBe(false);
    expect(JSON.parse(await read('nax-out/status.json')).run.status).toBe('completed');

    const identity = await runner.identity();
    const journalBytes = await runner.journalBytes();                   // journal.db, -wal and -shm: recent rows live in the WAL (D73)
    expect(journalBytes.length).toBeGreaterThan(0);
    expect(journalBytes.includes(Buffer.from(identity.apiKey))).toBe(false);
    expect(JSON.stringify(runner.log.lines)).not.toContain(identity.apiKey);
    expect(world.api.output()).not.toContain(identity.apiKey);
  });

  test('PLAN commits and pushes the plan outputs onto the PRD branch; a follow-up RUN on that branch continues it (R-3.3, R-3.4)', async () => {
    const planId = await world.dispatch({ feature: 'fb', command: 'PLAN', planFrom: 'docs/spec.md' });
    const plan = await world.waitForJob(planId, (j) => j.state === 'COMPLETED');
    expect(plan).toMatchObject({ resultBranch: 'feat/fb' });
    const planTip = await sh(world.origin.dir, 'rev-parse', 'feat/fb');
    expect(plan.resultSha).toBe(planTip);
    const tree = (await sh(world.origin.dir, 'ls-tree', '-r', '--name-only', 'feat/fb')).split('\n');
    expect(tree).toEqual(expect.arrayContaining(['.nax/features/fb/prd.json', '.nax/features/fb/spec.md', '.nax/features/fb/prd-fidelity-report.md', '.nax/features/fb/acceptance-meta.json']));
    expect(tree.some((p) => p.includes('/plan/') || p.includes('/sessions/') || p.includes('prd.rejected.json'))).toBe(false);
    const newPrd = JSON.parse(await sh(world.origin.dir, 'show', 'feat/fb:.nax/features/fb/prd.json'));
    expect(newPrd.userStories[0].id).toBe('US-001');                  // the stale OLD-1 PRD did not pass the verdict
    expect(await sh(world.origin.dir, 'log', '-1', '--format=%s', 'feat/fb')).toBe(`chore(plan): fb PRD via koda job ${planId}`);
    const bundle = await world.downloadBundle(planId);
    expect((await tarNames(bundle.bytes)).names).toContain('plan-logs/plan-1.jsonl');

    const runId = await world.dispatch({ feature: 'fb', ref: 'feat/fb' });
    const run = await world.waitForJob(runId, (j) => j.state === 'COMPLETED');
    expect(run.resultBranch).toBe('feat/fb');
    expect(await sh(world.origin.dir, 'rev-parse', 'feat/fb~1')).toBe(planTip);   // the run continued the plan's branch
    expect(run.resultSha).toBe(await sh(world.origin.dir, 'rev-parse', 'feat/fb'));
  });

  test('cancel: SIGTERM reaches the process group, the partial bundle is uploaded, the job ends CANCELLED', async () => {
    const id = await world.withFake({ FAKE_NAX_SCENARIO: 'hang' }, async () => {
      const jobId = await world.dispatch({ feature: 'fc' });
      await world.waitForJob(jobId, (j) => j.state === 'RUNNING' && j.naxRunId !== null);
      return jobId;
    });
    const pid = runner.daemon?.journal.getJob(id, 1)?.pid as number;
    expect(isProcessAlive(pid)).toBe(true);
    await world.cancel(id);
    const job = await world.waitForJob(id, (j) => j.state === 'CANCELLED');
    expect(job.cancelRequestedAt).not.toBeNull();
    await waitFor(() => !isProcessAlive(pid));
    expect(runnerStates(await world.events(id))).toEqual(expect.arrayContaining(['RUNNING', 'UPLOADING', 'CANCELLED']));
    const bundle = await world.downloadBundle(id);
    expect(bundle.status).toBe(200);
    expect((await tarNames(bundle.bytes)).names).toContain('nax-out/status.json');
    expect(await world.prisma.fleetCommand.count({ where: { jobId: id, type: 'CANCEL', ackResult: 'ok' } })).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail or pass honestly**

Run: `cd apps/runner && KODA_DB_TESTS=1 bun test test/integration/run-plan.integration.spec.ts`
Expected: the harness exists (Task 25), so the scenarios run against the real API; any failure here is a real defect in Tasks 12-24 (or in 3a-1's modules) or in the harness. Read the failure message (it carries the last job view and the API tail), fix the cause in the owning module, add a unit test there that would have caught it, and re-run. All three PASS before Step 3.

- [ ] **Step 3: Lint, type check, and the whole runner suite**

```bash
bun run type-check && bun run lint && bun run test
KODA_DB_TESTS=1 bun run test:integration
```
Expected: unit suite green; integration green.

- [ ] **Step 4: Commit**

```bash
git add apps/runner
git commit -m "test(fleet): runner scenarios against the real API (RUN, PLAN then RUN on the pushed branch, cancel)"
```

---

### Task 27: 3a scenarios — daemon crash (READOPT), network cut, stale epoch **[DB]**

**Files:**
- Create: `apps/runner/test/integration/recovery.integration.spec.ts`

**Interfaces:**
- Consumes: the harness (25), `TestRunner.crash/start/net`, the fake `nax` gate (13).
- Produces: the four recovery scenarios of design §4: daemon crash (`daemon.crash()`, D40) then READOPT of a running job; READOPT of a job that finished while the daemon was down; a network cut (responses lost) then resend from the ack cursor with no gap, no duplicate and no extra row; a stale epoch then `ABANDON`.

- [ ] **Step 1: Write the spec**

`test/integration/recovery.integration.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isProcessAlive } from '../../src/executor/nax-process';
import { waitFor } from '../helpers/wait';
import { createWorld, type TestRunner, type World } from './harness';

setDefaultTimeout(120_000);
const enabled = process.env['KODA_DB_TESTS'] === '1';

describe.skipIf(!enabled)('runner 3a against the real API: recovery', () => {
  let world: World;
  beforeAll(async () => { world = await createWorld(); }, 180_000);
  afterAll(async () => { await world?.close(); });

  const readopts = (jobId: string) => world.prisma.fleetCommand.findMany({ where: { jobId, type: 'READOPT' } });

  async function startHeld(runner: TestRunner, feature: string, gate: string) {
    const id = await world.withFake({ FAKE_NAX_GATE: gate }, async () => {
      const jobId = await world.dispatch({ feature });
      await world.waitForJob(jobId, (j) => j.state === 'RUNNING' && j.naxRunId !== null && j.currentStoryId === null && Number(j.costSpentUsd) > 0);
      return jobId;
    });
    const row = runner.daemon?.journal.getJob(id, 1);
    return { id, pid: row?.pid as number };
  }

  test('daemon crash while nax keeps running: READOPT is acked ok, the same process finishes the job, nothing is lost (Review focus 1)', async () => {
    const runner = await world.addRunner('recover-1');
    await runner.start();
    const gate = join(world.base, 'gate-fd');
    const { id, pid } = await startHeld(runner, 'fd', gate);
    const firstBoot = runner.daemon?.bootId;
    runner.crash();
    expect(isProcessAlive(pid)).toBe(true);                       // crash() drains nothing and touches no child (D40, D67)
    const second = await runner.start();
    expect(second.bootId).not.toBe(firstBoot);
    await waitFor(async () => (await readopts(id)).some((c) => c.ackResult === 'ok'), { timeoutMs: 30_000, message: 'READOPT was not acked ok' });
    expect((await world.job(id)).state).toBe('RUNNING');
    expect(second.journal.getJob(id, 1)?.pid).toBe(pid);
    await writeFile(gate, '');
    const job = await world.waitForJob(id, (j) => j.state === 'COMPLETED');
    expect(job.resultBranch).toBe('feat/fd');
    expect((await world.events(id)).some((e) => e.type === 'state' && (e.payload as { to: string }).to === 'CRASHED')).toBe(false);
    expect((await world.downloadBundle(id)).status).toBe(200);
    await runner.stop();
  });

  test('a run that finishes while the daemon is down is verdicted, bundled and reported after READOPT, not lost', async () => {
    const runner = await world.addRunner('recover-2');
    await runner.start();
    const gate = join(world.base, 'gate-fe');
    const { id, pid } = await startHeld(runner, 'fe', gate);
    runner.crash();
    await writeFile(gate, '');
    await waitFor(() => !isProcessAlive(pid), { message: 'the held nax did not finish' });
    const status = JSON.parse(await readFile(join(runner.jobDir(id), 'nax-out', 'status.json'), 'utf8'));
    expect(status.run.status).toBe('completed');
    expect((await world.job(id)).state).toBe('RUNNING');          // the server has heard nothing since the daemon went down
    await runner.start();
    const job = await world.waitForJob(id, (j) => j.state === 'COMPLETED', 60_000);
    expect(job).toMatchObject({ resultBranch: 'feat/fe', resultPrUrl: 'https://example.test/koda/pull/1' });
    expect((await readopts(id)).some((c) => c.ackResult === 'ok')).toBe(true);
    expect((await world.downloadBundle(id)).status).toBe(200);
    await runner.stop();
  });

  test('a network cut mid-run (responses lost): the first resent seq is ackedSeq+1, nothing is stored twice, there is no gap (Review focus 3, D71)', async () => {
    const runner = await world.addRunner('recover-3');
    await runner.start();
    const gate = join(world.base, 'gate-ff');
    const id = await world.withFake({ FAKE_NAX_GATE: gate, FAKE_NAX_STEPS: '14', FAKE_NAX_STEP_MS: '150' }, async () => {
      const jobId = await world.dispatch({ feature: 'ff' });
      await world.waitForJob(jobId, (j) => j.state === 'RUNNING' && j.naxRunId !== null);
      return jobId;
    });
    const journal = runner.daemon?.journal;
    // The cut: requests still reach the server, the runner never hears the answers. Every response is dropped, so its ack cursor freezes.
    runner.net.dropResponse = true;
    await waitFor(() => runner.net.syncs.some((s) => s.outcome === 'dropped' && s.jobs.some((j) => j.jobId === id && j.seqs.length > 0)), { message: 'no sync with events was performed during the cut' });
    await waitFor(() => (journal?.pendingEvents(id, 1, 1_000).length ?? 0) > 3, { message: 'events did not stay unacknowledged during the cut' });
    const ackedAtCut = (journal?.pendingEvents(id, 1, 1)[0]?.seq ?? 0) - 1;
    const storedDuringCut = await world.prisma.fleetJobEvent.findMany({ where: { jobId: id, runnerSeq: { not: null } }, orderBy: { runnerSeq: 'asc' }, select: { id: true, runnerSeq: true } });
    expect(storedDuringCut.length).toBeGreaterThan(ackedAtCut);          // the server kept events the runner could not confirm
    const cutSyncs = runner.net.syncs.length;
    runner.net.dropResponse = false;                                     // the network is back ...
    await writeFile(gate, '');                                           // ... and only now may the held nax finish: no wall-clock race
    const job = await world.waitForJob(id, (j) => j.state === 'COMPLETED', 60_000);
    expect(job.stateReason).toBeNull();
    await waitFor(() => (journal?.jobsWithPending().length ?? 1) === 0, { message: 'the journal was not fully acknowledged' });

    const firstAfter = runner.net.syncs.slice(cutSyncs).find((s) => s.outcome === 'delivered' && s.jobs.some((j) => j.jobId === id && j.seqs.length > 0));
    const resent = firstAfter?.jobs.find((j) => j.jobId === id)?.seqs ?? [];
    expect(resent[0]).toBe(ackedAtCut + 1);                              // resent from the ack cursor, not from 1 and not past it
    expect(resent).toEqual(resent.map((_, i) => resent[0] + i));         // contiguous: nothing skipped inside the batch

    const rows = await world.prisma.fleetJobEvent.findMany({ where: { jobId: id, runnerSeq: { not: null } }, orderBy: { runnerSeq: 'asc' }, select: { id: true, runnerSeq: true } });
    const seqs = rows.map((r) => r.runnerSeq as number);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));   // no gap and no duplicate
    expect(rows.slice(0, storedDuringCut.length)).toEqual(storedDuringCut);       // re-sent seqs created no extra row and replaced none
    expect(seqs.length).toBeGreaterThan(storedDuringCut.length);                   // what happened after the cut arrived as well
    await runner.stop();
  });

  test('a stale epoch: the fenced runner is told ABANDON, kills the group, drops that epoch and pushes nothing (Review focus 4)', async () => {
    const runner = await world.addRunner('recover-4');
    await runner.start();
    const id = await world.withFake({ FAKE_NAX_SCENARIO: 'hang' }, async () => {
      const jobId = await world.dispatch({ feature: 'fg' });
      await world.waitForJob(jobId, (j) => j.state === 'RUNNING' && j.naxRunId !== null);
      return jobId;
    });
    const journal = runner.daemon?.journal;
    const pid = journal?.getJob(id, 1)?.pid as number;
    expect(isProcessAlive(pid)).toBe(true);
    // What the silence sweep does to a job whose runner it gave up on (the 2b plan's sweep): CRASHED and a bumped lease epoch.
    await world.prisma.fleetJob.update({ where: { id }, data: { state: 'CRASHED', leaseEpoch: { increment: 1 } } });
    await waitFor(async () => (await world.prisma.fleetCommand.count({ where: { jobId: id, type: 'ABANDON', ackResult: 'ok' } })) === 1, { timeoutMs: 30_000, message: 'ABANDON was not acked ok' });
    await waitFor(() => !isProcessAlive(pid), { message: 'the fenced process was not killed' });
    expect(journal?.getJob(id, 1)).toBeNull();
    expect(journal?.pendingEvents(id, 1, 100)).toEqual([]);
    const after = await world.job(id);
    expect(after.state).toBe('CRASHED');
    expect(await world.prisma.fleetJobArtifact.count({ where: { jobId: id } })).toBe(0);
    await runner.stop();
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd apps/runner && KODA_DB_TESTS=1 bun test test/integration/recovery.integration.spec.ts`
Expected: 4 PASS. As in Task 26, a failure is a real defect: fix it in the owning module with a unit test. Known timing to keep in mind when debugging: the server reconciles boot ids on every sync (`sync.service.ts`), so `READOPT` arrives on the second sync after the restart; the fake `nax` only heartbeats while it steps or hangs, so a gated run's `lastHeartbeat` is fresh for the two-minute readopt window only because the tests are quick.

- [ ] **Step 3: Run the whole integration suite twice (order independence, database reset)**

```bash
KODA_DB_TESTS=1 bun run test:integration
KODA_DB_TESTS=1 bun run test:integration
```
Expected: all green both times (each file resets `koda_runner_test`).

- [ ] **Step 4: Lint, type check, commit**

```bash
bun run type-check && bun run lint
git add apps/runner
git commit -m "test(fleet): runner recovery scenarios (READOPT running and finished-while-down, network cut resend, stale epoch ABANDON)"
```

---

### Task 28: CI step, binary build, context extension, full gates, PR text

**Files:**
- Modify: `.nax/mono/apps/runner/context.md` (3a-1 Task 11b created it for the foundations; this task extends it for what 3a-2 adds)
- Modify: `.nax/context.md` (one Tech Stack row)
- Modify: generated agent files (`nax generate`, `nax generate --all-packages`)
- Modify: `.github/workflows/ci.yml` (integration job: one step, and `timeout-minutes` 20 -> 30)
- Create: `apps/runner/scripts/build-binary.ts`
- Modify: `apps/runner/package.json` (`build:binary`, `build:all`)
- Modify: `bun.lock` only if a dependency changed since Task 25 (it should not)

**Interfaces:** none new. The wiring of `apps/runner` into the repo (`.nax/mono/apps/runner/config.json`, the root context tree and Workspace Responsibilities entry, `type-check`, `lint` and the unit `test` in the turbo jobs) was done in 3a-1 Task 11b; this task keeps only what 3a-2 adds.

- [ ] **Step 1: Extend the per-app context (the guidance the next author reads)**

In `.nax/mono/apps/runner/context.md` make these edits.

Role paragraph: replace the sentence `This first slice holds the foundations: config, identity, journal, server client, sync loop and the pure verdict and snapshot mapping.` with:

```markdown
The foundations (config, identity, journal, server client, sync loop, verdicts) sit beside the execution half: git workspace, executor, watcher, bundle, supervisor, daemon and the CLI.
```

Replace the credentials bullet under "It should not" with:

```markdown
- hold git or provider credentials in 3a (3b adds the git-cred broker; a clone or push authentication failure fails the job with `no git credentials (runner 3b)`, and git never prompts)
```

Replace the Stack bullet about `bun build --compile` with:

```markdown
- compiled with `bun build --compile` (`bun run build:binary`; deliberately not a `build` script)
```

Replace the whole Architecture code block with:

```text
src/main.ts          koda-runner run | enroll | status
src/commands/        enroll, run, status over injected dependencies
src/config/          runner.json (https unless loopback or allowInsecureHttp)
src/identity/        identity.json (0600) and the per-start boot id
src/journal/         bun:sqlite, WAL, synchronous FULL; every row is written BEFORE the send that reports it
src/sync/            ServerClient, batching (one entry per jobId, 1 MiB budget), SyncLoop (abort only an idle poll, backoff, 426/401 stop)
src/supervisor/      RepoMutex, JobEvents (legal transitions only), JobRun (one job), Supervisor, CommandHandler
src/executor/        JobExecutor seam + HostExecutor (git workspace, branch rules, detached nax, PLAN commit)
src/watcher/         status.json poll, run-log and stdout/stderr tails, rate cap
src/verdict/         pure verdict functions (S1 spec 5.2 step 6)
src/bundle/          tar.gz from a file list, upload retry rules (409 is stale or state-conflict)
src/capabilities/    CapabilityProbe seam; StaticCapabilityProbe in 3a
src/daemon/          startDaemon (stop drains, crash does not), tuning constants, capacity
src/paths/           safe path segments
```

Append to Rules:

```markdown
- Emit only the S1 spec 5.4 runner transitions (`JobEvents.transition` refuses the rest). A spawned job always goes RUNNING -> UPLOADING -> terminal; a job that never spawned goes ASSIGNED -> FAILED or CANCELLED.
- The nax child is detached (own process group) and its output goes to files, so it survives a daemon restart. `stop()` never signals a child. Signal only `-pgid`, and only after `matchesProcess` confirms the pid is still this job (argv carries `koda-job-<jobId>`).
- `git clean` has no `-x`: ignored nax files (`checkpoint.jsonl`) must survive between runs; `plan/` is ignored too, so prepare deletes stale `plan/*.jsonl` itself.
- git runs with `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_ASKPASS=true` and an empty credential helper; the daemon refuses git older than 2.30.
- `plan-out/` (the PLAN stash) is write-once: a retry never re-reads the checkout that `checkout -f -B` may have reverted.
- Two epochs of one job id can coexist on a runner: abandoning the lower one never reaps or cleans while a live higher epoch exists.
- Timing constants live in `src/daemon/tuning.ts`; only tests override them. In tests an `expect` inside a callback that a `try/catch` swallows proves nothing.
```

Append to Testing:

```markdown
- Specs that need real git and the fake nax are `test/unit/*.spec.ts`; `test/fixtures/fake-nax.ts` is the fake nax (scenarios via `FAKE_NAX_*` env; a failed run exits 1 like the real one, and the verdict never reads the exit code). Real git runs in tests, isolated by `isolateGit()`.
- Integration specs run the built API against their own database `koda_runner_test`: `cd apps/runner && KODA_DB_TESTS=1 bun run test:integration`. `daemon.crash()` is the in-process kill; `TestRunner.net` cuts the network (`down`, or `dropResponse` to lose only the answers).
- Use `FakeExecutor` only for `JobRun` and `Supervisor` state-machine tests.
```

- [ ] **Step 2: The root context**

In `.nax/context.md`, Tech Stack table: add one row after `| CLI | Commander.js 12 |`, and leave the `CLI` row itself as it is:

```markdown
| Runner | Bun-only ESM (`bun:sqlite`, `bun build --compile`), Commander.js 12 |
```

- [ ] **Step 3: Generate the agent files and check what changed**

```bash
nax generate
nax generate --all-packages
git status --short | head -20
git diff --stat -- AGENTS.md CLAUDE.md GEMINI.md codex.md apps/api apps/cli apps/web | tail -5
```
Expected: the root `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `codex.md` and the four files under `apps/runner/` regenerate from the two context edits above; no `apps/api`, `apps/cli` or `apps/web` generated file changes. If one does, the generator version differs from the one that produced the committed files: do not commit that hunk, stop and look, and never run `git checkout` in this checkout. (`nax generate` is local and free; do not run `nax run` or `nax plan`.)

- [ ] **Step 4: The compile script**

`apps/runner/scripts/build-binary.ts` (D21: separate from `turbo build`):

```ts
/** `bun run build:binary` builds for this host; `bun run build:binary all` builds the three release targets. */
const TARGETS = ['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-x64'] as const;
const arg = process.argv[2];
const targets = arg === 'all' ? TARGETS : [undefined];

for (const target of targets) {
  const suffix = target ? `-${target.replace('bun-', '')}` : '';
  const proc = Bun.spawn(['bun', 'build', './src/main.ts', '--compile', ...(target ? [`--target=${target}`] : []), `--outfile=dist/koda-runner${suffix}`], {
    cwd: `${import.meta.dir}/..`, stdout: 'inherit', stderr: 'inherit',
  });
  if ((await proc.exited) !== 0) process.exit(1);
}
```
In `apps/runner/package.json` `scripts` add `"build:binary": "bun scripts/build-binary.ts"` and `"build:all": "bun scripts/build-binary.ts all"` (no `build` script: `turbo run build` and the CI build jobs stay unchanged). Smoke it:

```bash
cd apps/runner && bun run build:binary
./dist/koda-runner --version
HOME_DIR="$(mktemp -d)"; ./dist/koda-runner --home "$HOME_DIR" status; ./dist/koda-runner --home "$HOME_DIR" run; echo "exit $?"
git check-ignore dist/koda-runner && cd ../..
```
Expected: `0.1.0`; `not enrolled ...`; the `run` refusal naming `koda-runner enroll` with `exit 1`; `dist/koda-runner` printed by `git check-ignore` (it is ignored, nothing to commit).

- [ ] **Step 5: The CI step**

In `.github/workflows/ci.yml`, job `integration`: change `timeout-minutes: 20` to `timeout-minutes: 30` (D74: the runner suite adds an estimated 6-8 minutes, three spec files that each `prisma migrate reset` a fresh `koda_runner_test` and boot the API, plus the scenarios), and after the step `Integration + e2e (Postgres)` add:

```yaml
      - name: Runner integration (Postgres, built API)
        run: cd apps/runner && bun run test:integration
        env:
          KODA_DB_TESTS: "1"
```
(The `Generate Prisma client` and `Build API` steps already run earlier in that job, and the job's Postgres service is the harness's default `localhost:5433`, on which it creates `koda_runner_test`; `git` and `tar` are on `ubuntu-latest`. `type-check`, `lint` and the unit `test` join the existing turbo jobs automatically. No new required check is added: `integration` already is one.)

- [ ] **Step 6: Full gates**

```bash
bun install --frozen-lockfile
bun run type-check
bun run lint
bun run test
bunx turbo run build --filter=@nathapp/koda-api
cd apps/api && bun run test:integration && cd ../..
cd apps/runner && KODA_DB_TESTS=1 bun run test:integration && cd ../..
git add openapi.json && bun run generate && git diff --exit-code openapi.json
```
Expected: all green; the second `generate` leaves `openapi.json` unchanged. Compare counts with the Task 0b baseline: api unit and api integration unchanged (this PR touches no server code), runner unit up by the specs of Tasks 12-24, runner integration 13 tests (6 harness, 3 run-plan, 4 recovery).

- [ ] **Step 7: Security self-check**

```bash
git diff --name-only origin/main...HEAD -- apps/runner/src | xargs grep -n "console\.log" || true
git diff origin/main...HEAD -- apps/runner | grep -nE "kr_[0-9a-f]{20}|ghs_|BEGIN (RSA )?PRIVATE" || true
```
`origin/main` is the 3a-1 merge commit noted in Task 0b, so these ranges hold only this PR. Expected: no `console.log` outside `src/main.ts` and `src/logger.ts` (both use `process.std*` writes, so none at all); no key-looking literals other than the obvious test fixtures (`ghs_harness` in the harness forge is one).

- [ ] **Step 8: Review before push**

Dispatch a code reviewer over `git diff origin/main...HEAD` with this plan's Review Focus list, the decision registers (3a-1 D21-D59, this plan D60-D74) and the slice 3 design as the brief (repo rule: review before push). Fix CRITICAL and HIGH findings, then re-run Step 6.

- [ ] **Step 9: Commit, and stop before pushing**

```bash
git add .nax .github apps/runner AGENTS.md CLAUDE.md GEMINI.md codex.md bun.lock
git commit -m "chore(fleet): runner CI integration step, binary build, context for the execution half"
```
Never push (`.nax/rules/common.md`): a human reviews and pushes. The PR title and body, for when they do:

```markdown
feat(fleet): S1 slice 3a-2 — runner execution and integration

## Summary
Second half of fleet S1 slice 3a (design `docs/superpowers/specs/2026-09-30-fleet-s1-slice-3-runner-design.md`, plan `docs/superpowers/plans/2026-09-30-fleet-s1-slice-3a-2-runner-execution.md`); builds on 3a-1 (foundations: protocol, #157, config, identity, journal, sync loop, verdicts).

- Git workspace, ref resolution, the PRD-branch rules and checkout; a fake `nax` fixture (a failed run exits 1 like the real one).
- Detached `nax` process group, `.nax-pids` reaping, file-based watcher, PLAN commit and push (write-once stash, explicit identity, idempotent), bundle build and upload (409 classified as stale or state-conflict, GNU tar tolerance, unsafe names skipped).
- `HostExecutor` behind the `JobExecutor` seam, `JobRun` (only legal transitions, waits for the server to apply UPLOADING before uploading), `Supervisor` and `CommandHandler` (ASSIGN validation, CANCEL, epoch-safe ABANDON, READOPT with a kill before reap).
- Daemon (`stop` drains before closing the journal, `crash` for restart tests, git >= 2.30 check), static capabilities, `koda-runner enroll | run | status` (status opens the journal read-only).
- Integration harness (own `koda_runner_test` database, built API, fake forge) and seven end-to-end scenarios: RUN, PLAN then RUN on the pushed branch, cancel, daemon crash then READOPT, finished-while-down READOPT, network cut with lost responses, stale epoch ABANDON.
- CI: runner integration step, `integration` job timeout 20 -> 30 minutes; `build:binary` compile script.

## Decisions
D60-D74 in this plan's addendum; D21-D59 in the 3a-1 plan's register (`docs/superpowers/plans/2026-09-30-fleet-s1-slice-3a-1-runner-foundations.md`).

## Out of scope (3b)
git-cred socket, credential helper, gh/glab shims, `NaxCapabilityProbe`, `install-service`, live check. In 3a a clone or push authentication failure ends the job with `no git credentials (runner 3b)`; the integration suite runs against `file://` remotes.
```

---

## Summary

Plan 3a-2 ships the execution half of the runner: Tasks 12-17 (git workspace, fake nax, process control, watcher, PLAN commit, bundle), 18-21 (executor seam, supervisor primitives, `JobRun`, `Supervisor` and commands), 22-24 (capabilities and tuning, daemon, CLI), 25-27 (integration harness and seven scenarios) and 28 (CI step, compile script, context, gates, PR). Task 0b branches from main after the 3a-1 merge and proves that base green first. Nothing in 3a-1 changes except three small, tested additions the execution half needs: `ServerClient.uploadBundle` returns the error message (Task 17), `Journal.openReadOnly` (Task 24), and `@prisma/client` as a runner devDependency (Task 25).

## Decisions

D21-D59 are in the 3a-1 plan and govern this one. This plan adds D60-D74 (top of this document): the 409 split and the ack wait before the upload (D60), write-once `plan-out` and stale plan-log removal (D61, D62), replayed-ASSIGN restart and epoch safety (D63, D64), kill before reap and cancel paths (D65, D66), `crash()` and stop-drains (D67), bundle robustness (D68), git no-prompt and version floor (D69), fake-nax fidelity (D70), harness net control (D71), CLI read-only status and warnings (D72), harness cleanup and WAL-aware secret scan (D73), CI timeout (D74).

## Self-review (done while writing)

- **Spec coverage (slice 3 design):** R-3.3 -> Task 12 (five branch cases, local-only kept, D51) and the Task 26 PLAN-then-RUN scenario; R-3.4 -> Task 16 (allowlist, explicit identity, idempotent, write-once stash) and Task 26; R-3.5 -> Tasks 14, 18 (D53 wipe, `pre-plan`, stale plan logs); §1.3 rules for commands, legal transitions and snapshot mapping -> Tasks 19-21 (the sync-side rules are 3a-1); §2 steps 1-10 and the control paths (cancel, crash, ABANDON, READOPT) -> Tasks 12, 14-18, 20, 21; `runner enroll | run | status` -> Task 24; §4 tests (unit list, fake nax, integration harness and scenarios, CI step) -> Tasks 13, 25-28. The 3b seams stay named interfaces: Task 22 `CapabilityProbe`, Task 21 `ASSIGN` ignores `gitTokens`, Task 12 `NO_CREDENTIALS_REASON`.
- **Placeholder scan:** no unfinished markers and no "similar to"; every step has code or an exact command. Where this plan changes a 3a-1 file (`sync/http.ts`, `journal/journal.ts`, `.nax/mono/apps/runner/context.md`) the exact edit is given.
- **Type consistency:** `JobExecutor` (Task 18, 13 methods, `prepare` now takes `PrepareOptions`) is implemented by `HostExecutor` and `FakeExecutor` (Task 20); `PrepareOutcome.cancelled` is produced by `HostExecutor` and consumed by `JobRun`; `UploadOutcome` gained `state-conflict` (Task 17) and is handled in `JobRun` (Task 20); `JobRunTuning` gained `ackPollMs` and `uploadAckWaitMs` (Task 20), added to `Tuning` (Task 22), passed by the daemon (Task 23) and by both supervisor specs; `RunStart` gained `reprepare` (Task 20), used by `Supervisor.readopt` and `CommandHandler` (Task 21); `PlanPushInput.identity` (Task 16) is supplied by `HostExecutor.finishPlan` (Task 18); `BundleFile.skipped` (Task 17) is read by `JobRun`; `DaemonHandle.crash` (Task 23) is used by `TestRunner.crash` (Task 25) and Task 27; `NetControl`/`SyncRecord` (Task 25) are used by Task 27.
- **Review Focus mapping:** 1 -> Tasks 15 (startAtEnd), 20 (resume), 21 (readopt table, replayed ASSIGN), 27 (crash scenarios). 2 -> Tasks 12, 21 (hostile payload tables). 3 -> Task 17 (409 classification), Task 20 (ack wait, state-conflict), Task 27 (network cut). 4 -> Tasks 20, 21 (two-epoch tests), 27 (stale epoch). 5 -> Tasks 16 (crash windows), 19 (mutex ordering), 20 (resume without repeating the push).
- **Decision references:** every D-number cited in this document is D21-D59 (3a-1's register) or D60-D74 (the addendum above).
- **Server file:line citations** in this plan were checked against the tree at the 3a-1 merge: `bundle.service.ts:105-117,64-75` (the two 409 causes and the `UPLOAD_STATES` re-check), `fence.service.ts:25` (only `stale_lease` is ever sent), `bundle.exceptions.ts` (`fleet.fence` versus `fleet.jobState` messages), `sync-request.parser.ts:4`, and nax `bin/nax.ts:383` (`process.exit(result.success ? 0 : 1)`).
