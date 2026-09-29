# Fleet S1 Slice 3a-1 — Protocol + Runner Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Numbering.** This is plan 3a-1, the first half of slice 3a. Task numbers are the combined slice-3a numbering: this plan holds Tasks 0-11 (plus 11b, repo wiring and PR text); Tasks 12-28 (git, executor, watcher, bundle, supervisor, daemon, CLI, integration harness and scenarios) are plan **3a-2**, a separate PR on its own branch cut after 3a-1 merges, and cite this plan's decision register. Decision numbers continue the fleet S1 register: D1-D20 live in the 2a and 2b plans and still govern the server; this plan adds **D21-D59** (3a-2 uses D60 and up). "3b" (git-cred socket, credential helper, shims, `NaxCapabilityProbe`, `install-service`, live check) is a separate plan and is out of scope here except for the seams named in the Self-review.

**Prerequisite:** slices 1, 2a and 2b are merged (`main` at `32b543d0`, the #166 squash of the slice 3 design, on top of `fa721a30`). This plan builds on branch `feat/fleet-s1-slice3a-1-runner-foundations`; the plan file is the only commit on top of `main`. The slice 3 design and the S1 spec pointer amendments (S1 spec §2.1, §5.2, §7.2, §10) are already on `main`; Task 0 verifies them. Server code is unchanged between `fa721a30` and `32b543d0` (only two spec documents differ), so every server line citation below was checked at `32b543d0`. Nothing else is in development in parallel.

**Goal:** Ship the protocol and runner foundations as one PR: the protocol v1 `credentials` edit with its server validator and placement `provider_unavailable`, #157 (runner capacity on `/fleet/runner/me`, `ke_` prefix on enroll), the regenerated contract, and a new `apps/runner` package (`@nathapp/koda-runner`) with its scaffold, foundations (logger, time, safe segments, test helpers), config and identity, the bun:sqlite journal, the server client with batching and backoff, the sync loop, and the pure verdict and snapshot mapping. Everything is unit-tested and database-free except Task 3 **[DB]**. Tasks 12-28 (git, executor, watcher, bundle, supervisor, daemon, CLI, integration against the real API) are plan 3a-2.

**Architecture:** Server first (protocol, validator, placement, DTO, contract, `/me`), so the runner compiles against the final types. The runner is a Bun-only ESM package of small modules behind narrow seams: a `Journal` (bun:sqlite, persist before send), a `SyncLoop` (one request in flight, abort on idle write, halving batches) and pure verdict and snapshot functions. The `JobExecutor` seam, `HostExecutor`, `JobRun` state machine and `Supervisor` that consume them arrive in 3a-2; no 3b code exists in 3a.

**Tech Stack:** Bun 1.4.2 (`bun:sqlite`, `Bun.spawn`, `bun test`, `bun build --compile`), TypeScript strict ESM, commander 12 (as `apps/cli`), system `git` and `tar`, `@nathapp/fleet-protocol` (types plus `FLEET_PROTOCOL_VERSION`). Server side: NestJS 11, Prisma 6, Jest (unchanged).

**Specs:** `docs/superpowers/specs/2026-09-30-fleet-s1-slice-3-runner-design.md` ("slice 3 design": rulings R-3.1..R-3.7, §1, §2, §4 are this plan; §3 is 3b) and `docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md` ("S1 spec", amended by the slice 3 design). Precedent plans: `docs/superpowers/plans/2026-09-29-fleet-s1-slice-2a-jobs.md`, `docs/superpowers/plans/2026-09-29-fleet-s1-slice-2b-runner-sync.md`.

## Global Constraints

From the specs, the repo rules (`.nax/context.md`, `.nax/rules/*.md`, `.nax/mono/apps/*/context.md`) and slices 1-2; every task includes them.

- **Protocol stays v1.** `FLEET_PROTOCOL_VERSION` is `1`; the `credentials` shape changes in place (R-3.2). The API imports `@nathapp/fleet-protocol` with `import type` only (slice 1 D3, enforced by `apps/api/src/fleet/common/protocol.spec.ts`); the runner may import the `FLEET_PROTOCOL_VERSION` value.
- **Server envelope.** Every server response is `JsonResponse.Ok` = `{ ret, data }`; the runner unwraps `data`. The API global prefix is `/api`.
- **nax exits 0 on failure**: the verdict is computed from `status.json` and files alone, never from an exit code, and never from a child-process handle (a readopted child is not a child).
- **Legal transitions only.** The runner emits exactly the S1 spec §5.4 runner-reported transitions: `ASSIGNED -> RUNNING|FAILED|CANCELLED`, `RUNNING -> UPLOADING|CANCELLED`, `UPLOADING -> COMPLETED|FAILED|ESCALATED|CANCELLED`. The server stores and acks an illegal one without applying it (plan D6), which would strand the job.
- **Persist before send.** Every event is written to the journal before the send that reports it; `seq` is per `(jobId, leaseEpoch)`, contiguous from 1.
- **Sync limits** (`apps/api/src/fleet/sync/sync-request.parser.ts:4`, body 1 MiB): at most 64 jobs, 500 events per job, 256 acks, 64 token requests, 16,384 serialised-JSON bytes per event payload; a log event carries at most 8 KiB of text (`event-payloads.ts`, `MAX_LOG_BYTES`).
- **No secrets in logs, journal or bundles.** The runner API key lives only in `identity.json` (mode 0600) and in the `Authorization` header; the `Logger` redacts keys named `*key*`, `*token*`, `*secret*`, `*password*`. 3a has no git credentials: an authentication failure ends the job with `stateReason = 'no git credentials (runner 3b)'`.
- **Path safety.** Owner, repo, feature and job id become path segments only through `assertSegment`; every branch or ref that reaches a git command is checked for a leading `-` and, for branches, `git check-ref-format --branch`.
- **Repo conventions.** Conventional commits, no attribution trailer, never push (a human pushes), no emojis, no `console.log` outside `src/main.ts` and `src/logger.ts`, no non-null assertions, no `any` (root `.eslintrc.js`), no `eslint-disable`. Immutable style: build new objects, never mutate arguments. Files stay under 400 lines typical, 800 max, functions under 50 lines.
- **Tests.** Unit specs are `*.spec.ts` co-located under `apps/runner/src/` (repo convention) or, for cross-module scenarios that spawn `git` and the fake `nax`, under `apps/runner/test/unit/`; integration specs are `*.integration.spec.ts` under `apps/runner/test/integration/`, gated by `describe.skipIf(process.env['KODA_DB_TESTS'] !== '1')`. No hardcoded absolute machine paths in tests: use `mkdtemp`, `__dirname` and `path.join`. Unit runs never need a database.
- **Generated files.** `openapi.json` is committed and regenerated (`bun run generate`); `apps/cli/src/generated/` is gitignored and never edited; agent files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `codex.md`) are generated by `nax generate` from `.nax/context.md` and `.nax/mono/apps/<app>/context.md`.
- **All ten CI checks are required on `main`** (`changes`, `type-check`, `lint`, `web build`, `policy-gates`, `test`, `integration`, `e2e`, `evaluate`, `smoke`); no new required check is added.

Plan-level rules:

- Branch `feat/fleet-s1-slice3a-1-runner-foundations` is already checked out in the main checkout (`repos/koda`). Never run `git checkout`, `git switch`, `git stash`, `git reset` or `git rebase` here; commit on the current branch only.
- Server specs: `cd apps/api && bun run test:scoped <paths>` (sets `KODA_DB_TESTS=1` for integration paths; the DB is `bun run test:db:up` once). Never two DB jest runs at once. ts-jest type-checks every spec: after a signature change run `cd apps/api && bunx tsc --noEmit -p tsconfig.json`.
- Runner specs: `cd apps/runner && bun test <path>`. Integration: `cd apps/runner && KODA_DB_TESTS=1 bun test test/integration` (needs the API built: `bunx turbo run build --filter=@nathapp/koda-api`).
- Tasks marked **[DB]** need `KODA_DB_TESTS=1` and the test Postgres; every other task runs without a database.
- Real `git` runs in unit tests (no mocked git); tests isolate it with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` (Task 6 helper).
- Do not run `nax run` or `nax plan` (billed). `nax generate` is local and free.

## Plan decisions beyond the spec

D1-D20 are in the 2a and 2b plans. New rows (D21-D59), each needed by a task below:

| # | Decision | Why |
|:--|:--|:--|
| D21 | The runner is an ESM Bun package `@nathapp/koda-runner` (`"type": "module"`, `verbatimModuleSyntax`, extensionless relative imports, `types: ["bun"]`). CLI parsing is commander `^12.0.0`, as `apps/cli`. `bun build --compile` runs from `scripts/build-binary.ts` (`bun run build:binary` = host target, `bun run build:binary all` = the three release targets; the script itself is created in 3a-2 Task 28); it is deliberately not a `build` script, so `turbo run build` and the CI build jobs stay unchanged. | Design §1 says Bun-only, compiled per platform; the repo already uses commander; a `build` script would add a compile to every `bun run build`. |
| D22 | Runner home is `KODA_RUNNER_HOME` (default `~/.koda-runner`, `--home` overrides): `runner.json`, `identity.json` (0600), `journal.db`. `serverUrl` is the origin; the client appends `/api`. Config key `allowInsecureHttp` (set by `enroll --insecure-http`) allows non-loopback `http://`. | Design gives the file names loosely (§1 `config/`, `identity/`); one directory keeps `install-service` (3b) simple. |
| D23 | Journal `jobs` gains `cancel_requested_at`, `result_branch`, `result_sha`; `applied_commands` gains `detail`. | The design's columns cannot survive a restart mid-cancel (the verdict's first row needs the cancel), a restart after the PLAN push (the final snapshot needs the pushed sha), or a replayed ack (needs its detail). |
| D24 | An event the server keeps rejecting (400/413 after the batch is halved to one event) is not deleted: its payload is **replaced** by a `lifecycle` error event under the same `seq`. | The server's ack is the highest *contiguous* stored seq (2b D2); a deleted seq is a hole that stalls the job's ack forever. The design's "drop that event with an `error` lifecycle entry" is read as replace. |
| D25 | A 400 on a request that carried `capabilities` is first retried without them (once); if that succeeds the runner logs an error and does not resend that capabilities hash. | Otherwise a bad `runner.json` capabilities block would be blamed on, and would erase, a healthy job event. |
| D26 | The request body is built under `MAX_BODY_BYTES = 900_000` (below the 1 MiB cap): events are added job by job until the next one would not fit. Batch scale `{ jobs, events }` starts at `{64, 500}` and halves on 400/413. | Spec caps are per field; the 1 MiB whole-body cap needs an explicit budget. |
| D27 | The bundle is built with the system `tar` (`tar -czf out -C <jobDir> -T <listfile>`; bsdtar and GNU tar both accept it), from an explicit file list: `nax-out/**` minus any path segment `prompt-audit`, `nax.stdout`, `nax.stderr`, and for PLAN `plan-logs/*.jsonl` (copied out of the clone). Symlinks are stored as links, never followed. SHA-256 is streamed with `Bun.CryptoHasher`. The upload body is `Bun.file(path)`, so `Content-Length` is always set (the server answers 413 before reading). | "tar implementation in Bun without new heavy deps": `tar` exists on every target, `Bun.Archive` holds the archive in memory (200 MiB cap). |
| D28 | The per-repo mutex is an in-memory FIFO promise chain keyed by `<owner>/<repo>` (`RepoMutex.acquire(key): Promise<release>`), held from the start of `prepare` to the end of cleanup. | Design §1 `supervisor/`; placement already allows one job per repo per runner, the mutex protects the window between one job's cleanup and the next `ASSIGN`. |
| D29 | `assertOwner` rejects a leading `.` on the owner (a `.jobs` owner would collide with `<workspaceRoot>/.jobs`); repo names may start with `.` (`.github`). | Design says segments match `[A-Za-z0-9._-]+`, not `.` or `..`; it does not see the `.jobs` collision. |
| D30 | The runner re-validates `feature` (`assertSegment`), `planFrom` (relative, no `..`, no leading `-`, at most 512 chars), `maxCostUsd` (`^\d+(\.\d{1,4})?$`), `cloneUrl` (`https:`, `http:` or `file:`), `command` and every path-bound `AssignPayload` field before touching the disk. An invalid payload is acked `rejected`. | The server is trusted for delivery, not for shape (a compromised or misconfigured server must not turn the runner into a path traversal). |
| D31 | `ref` resolution rejects a ref starting with `-`, and passes `--end-of-options` to `git rev-parse` and `git show`. Branch names additionally reject `@{`. | `git check-ref-format --branch '@{-1}'` prints the previous branch and exits 0 (spiked); a leading `-` is argument injection. |
| D32 | Prepare failure reasons are fixed strings: `checkout: ref not found`, `checkout: invalid ref`, `checkout: no prd.json at ref`, `checkout: prd.json is not valid JSON`, `checkout: prd.json has no branchName`, `checkout: invalid branchName`, `checkout: branch diverged`, `no .nax dir`, `workspace: <first stderr line, 200 chars>`, `no git credentials (runner 3b)`, `spawn failed: <message>`. | A stable vocabulary for the UI and the tests. |
| D33 | `READOPT` of a job the journal holds as `ASSIGNED` with no pid (the daemon died during prepare) is acked `ok` and the job re-runs `prepare` from the start. | The design's rule ("pid alive and `run.id` matches, else reject") would CRASH a job that never started; every prepare step is idempotent. |
| D34 | A readopted watcher starts its log tails at end of file (no replay) and re-emits a snapshot on its first tick. | Replaying a whole run log would flood the event stream (60 logs/min cap); logs are excerpts, the bundle has the full text (S1 spec §3.2). |
| D35 | Every spawned job, RUN or PLAN, cancelled or crashed, goes RUNNING -> UPLOADING -> terminal (the upload is accepted in both RUNNING and UPLOADING, `apps/api/src/fleet/artifacts/bundle.service.ts:15`, `UPLOAD_STATES`). A job that fails before spawn goes ASSIGNED -> FAILED, and one cancelled before spawn ASSIGNED -> CANCELLED, with no bundle. A runner-internal error while RUNNING goes through UPLOADING to FAILED. | One flow, only legal transitions (§5.4); design §1.3 "A RUN always goes RUNNING -> UPLOADING -> terminal", extended to PLAN and cancel. |
| D36 | Bundle outcomes: three failed uploads end in the verdict state with `stateReason = 'bundle upload failed'` (a FAILED verdict keeps its reason as a prefix: `<reason>; bundle upload failed`); 413 ends `'bundle too large'`; 409 (stale lease) parks the job silently until its `ABANDON`. | Design §2 step 9. |
| D37 | `.nax-pids` (JSON lines `{pid, spawnedAt, workdir}`, nax `src/execution/pid-registry.ts`) is reaped only for entries registered at or after the job's spawn whose process start time (`ps -o lstart=`) is not later than `spawnedAt + 2 s`; the file is truncated afterwards. | nax itself refuses to signal stale entries because pids recycle. |
| D38 | The integration harness owns database `koda_runner_test` on the compose test server (`postgresql://koda:koda@localhost:5433/koda_runner_test`, override `KODA_RUNNER_TEST_DATABASE_URL`; `DATABASE_URL` is ignored because importing `@prisma/client` loads `apps/api/.env` into `process.env`), checked with the API's `assertSafeTestDatabaseUrl`, created and migrated by `bunx prisma migrate reset --force --skip-seed --skip-generate` (the web e2e precedent; the Prisma AI-consent variable is set because the URL is guarded). The partial unique index ships in migration `20260930090000_fleet_jobs`, so the design's "apply the partial unique indexes" is a verification query, not a replay. | `db push --force-reset` (jest globalSetup) leaves no `_prisma_migrations`, so `migrate deploy` on `koda_test` would fail with P3005; a separate database also cannot clobber the API integration run. |
| D39 | The harness starts the API with `bun --no-env-file apps/api/dist/main` and an explicit env (never inheriting the developer's `.env`), waits on `/api/health`, and runs the daemon in process with an injected `fetch` (for the network-cut scenario) and a `tuning` override. The API test helpers `test-database-url.ts` and `fake-forge.ts` are imported by relative path from `apps/api/test/helpers`. | Design §4; the two helpers are dependency-free, so the runner package needs no new dependency. |
| D40 | "kill -9 of the daemon" is simulated in process by `daemon.crash()` (added in 3a-2 Task 23: stop timers, abort the loop, close the journal, no drain, touch no child) followed by a second `startDaemon` on the same home, which sends a new boot id. | The detached `nax` child is the only thing that must survive; a real SIGKILL of the test process is not testable. |
| D41 | `StaticCapabilityProbe` stamps `sandbox.probedAt` at each probe; `hashCapabilities` excludes it (S1 slice 3 design §3.2 rule, adopted now). | A changing timestamp must not make the report look changed. |
| D42 | Timing constants live in one `TUNING` object (`statusPollMs 2000`, `killGraceMs 30000`, `syncMinGapMs 250`, `syncTimeoutMs 35000`, `capacityRefreshMs 300000`, `pruneIntervalMs 86400000`, `readoptHeartbeatMs 120000`); only `startDaemon`'s options override them (tests), `runner.json` cannot. | Design fixes the values; tests need speed. |
| D43 | Unit specs live beside the code (`src/**/*.spec.ts`); specs that need real git and the fake `nax` live in `test/unit/`; shared helpers in `test/helpers/`; the fake in `test/fixtures/fake-nax.ts`. `bun test src test/unit` is the unit command (design §1). | Repo test-layout rules. |
| D44 | Spawned `nax` gets the daemon's environment plus `NAX_GLOBAL_CONFIG_DIR=<config.naxHome>` so nax's profile directory and the job profile the runner writes are the same directory. | Design §2 step 5 writes into `<naxHome>/profiles`; nax must read that one. |
| D45 | Log events are chunks of at most 8,000 bytes of text, at most 60 per job per minute (sliding window, all streams together); the excess is dropped and counted into the next snapshot's `droppedLogs`. | S1 spec §3.2. |
| D46 | Repo `origin` URL drift: an existing clone whose `origin` differs from `cloneUrl` is repointed with `git remote set-url`; a directory without `.git` (a crashed clone) is removed and recloned. `cloneUrl` reaches git after `--`. | Server-side host changes must not strand a runner; partial clones must not wedge a repo forever. |
| D47 | `enroll` writes `runner.json` when absent (`serverUrl`, `workspaceRoot`, `labels`, static `capabilities` with `tools` detected by `Bun.which`), refuses when `identity.json` exists, and never overwrites an existing `runner.json` (a differing `--server` is an error). | Re-enrolling would orphan the server-side runner row; hand edits to `runner.json` are the 3a way to declare capabilities. |
| D48 | `koda-runner status` reads config, identity and the journal (read only) and asks `GET /fleet/runner/me` with a 5 s timeout; it exits 0 whenever it could print. | Design §1 `main.ts`; a status command must work when the server is down. |
| D49 | Stale-epoch handling: an upload that answers 409 is not retried and emits nothing; the job stays parked in the journal until the server's `ABANDON` (which arrives on the next fenced sync). `unknownJobIds` abandon every epoch of that job. | Design §1.3. |
| D50 | The runner's default `tools` in a generated `runner.json` come from `Bun.which('git'|'gh'|'glab')`; `nax.version` defaults to `"unknown"` until the operator edits it (3b's `NaxCapabilityProbe` replaces the static block). | Placement requires `tools`; the static probe cannot ask nax. |
| D51 | When only the local branch exists (a run committed but never pushed) it is the fifth branch case: check it out as is (`git checkout <branch>`), never reset it, so a later run continues its commits. | A reset would discard commits the server was never told about; the other four cases (design §2 step 3) already fetch and fast-forward. |
| D52 | The PLAN commit is `chore(plan): <feature> PRD via koda job <jobId>`, authored as the ASSIGN `gitIdentity` with `--no-verify` and `-c commit.gpgsign=false`. It is idempotent: after a crash between commit and push a re-run stages nothing, commits nothing and pushes. `plan-out/` is write-once: the first stash is the source of truth. | Hooks and signing are host policy that would make an unattended commit fail; a second stash after a partial commit would mix two PRDs. |
| D53 | `prepare` first deletes the previous attempt's files under a reused `<jobDir>` (`nax-out`, `nax.stdout`, `nax.stderr`, `pre-plan`, `plan-out`, `plan-logs`, `bundle.tar.gz`, `bundle.list`, `bundle-manifest.json`). A requeued job reuses `jobDir` with a new epoch (R-3.5), and only after lower epochs of the job are abandoned. | A stale `status.json` or bundle from epoch N would otherwise be verdicted or uploaded as epoch N+1's result. |
| D54 | `READOPT` of a PLAN job (which has no `status.json`) decides by process: pid alive and its command line carries `koda-job-<jobId>` -> watch; otherwise finish, with the verdict computed from files. | PLAN has no `run.id` to compare (D33's RUN rule); the job id in the command line is the identity that survives pid recycling. |
| D55 | The journal uses `PRAGMA synchronous = FULL` (not NORMAL), and `onWrite` listeners fire once, after the outermost transaction commits (never for a rolled-back one). | Under WAL, NORMAL can lose the last committed transactions on power loss: a lost *reported* event would be re-issued after restart under the same `seq` with different content, and the server keeps the first. A listener woken inside an open transaction would build a sync request that cannot see the rows. |
| D56 | `buildSyncRequest` reports ONE entry per `jobId`, the highest pending epoch first; an older epoch of the same job waits for a later sync. The job cap counts distinct jobs. Body budget counts about 100 bytes per job wrapper and 64 per event wrapper. | The server's `parseSyncRequest` answers 400 `duplicate job` for two entries with one `jobId` (`sync-request.parser.ts:71`), which would wedge a requeued job. |
| D57 | `SyncLoop.wake()` aborts the in-flight request only when it is an idle poll (no jobs, no command acks, no token requests); otherwise it sets a `dirty` flag and `run()` starts the next sync immediately after the response, skipping the `minGapMs` sleep. | A request that carries data may already be applied by the server; aborting it drops the response (commands would be re-delivered) and re-sends the same events. |
| D58 | At batch `{1,1}`, a 400 on a request that carried command acks is retried once with `commandAcks: []` before any event is blamed; if that succeeds the acks are resent without their `detail`. D24 (replace with a lifecycle event) applies only if the acks-free request still fails. | An ack is the one free-text field the runner adds outside events; it must not cost a healthy event its content. |
| D59 | Runner-authored free text is clamped to the server's limits: command-ack `detail` to 200 characters (server 500) with NUL replaced, snapshot `escalationReason` to 2,000 (server `event-payloads.ts`), never inside a surrogate pair. `clampAck` is exported for the 3a-2 command handler. | An over-long or NUL-carrying field is a 400 for the whole request; 3a-2 also relies on this for log chunks (`chunkText`, Task 15). |
## Review Focus

The input classes or failure modes the specs imply but no task's happy path exercises, most likely first, limited to what 3a-1 exercises. Each has a named test in the task that owns the code.

1. **A hostile or damaged path segment.** An `owner`, `name`, `feature` or job id with `..`, `/`, a leading `-` or a leading `.` on the owner (D29); a `runner.json` whose `workspaceRoot` or `capabilities.credentials` is malformed fails at load with a clear error. Tasks 6, 7.
2. **The server cannot be reached, or rejects a batch.** A network cut resends from the ack cursor without a gap or a duplicate; 426 and 401 stop the loop without a retry storm; a poisoned event does not wedge the job's ack (D24); a bad capabilities block does not erase a job event (D25); a wake during a busy request never loses an ack; one job at two epochs never produces a `duplicate job` 400. Tasks 9, 10.
3. **A crash between persisting and sending.** The journal is durable at commit (`synchronous = FULL`), `seq` is contiguous per `(jobId, leaseEpoch)`, and `notify()` only fires after the transaction commits. Task 8.
4. **A credential the server would reject.** `stored` is required on the wire (`null` or an object, never absent); `provider_unavailable` follows nax's `available` flag. Tasks 1, 2.

Deferred to 3a-2 (git, executor, supervisor, integration): daemon restarts while `nax` keeps running, hostile `ASSIGN` payloads reaching git, a stale runner told `ABANDON`, and two things at once on one repo.

---

## File Structure

| File | Responsibility | Task |
|:--|:--|:--|
| `packages/fleet-protocol/src/index.ts`, `apps/api/src/fleet/common/protocol.ts`, `capabilities.ts`, `capabilities.spec.ts`, `apps/api/test/helpers/fleet-fixtures.ts` | `RunnerCredential` shape, validator | 1 |
| `apps/api/src/fleet/jobs/placement-rules.ts`, `placement-rules.spec.ts`, `dto/fleet-job.dto.ts`, `test/integration/fleet/placement.integration.spec.ts` | `provider_unavailable`, `provider_expired` removed | 2 |
| `apps/api/src/auth/**`, `apps/api/src/fleet/runners/**`, integration specs | #157 | 3 |
| `openapi.json` | Contract | 4 |
| `apps/runner/{package.json,tsconfig.json,.eslintrc.cjs}`, `src/main.ts`, `src/version.ts`, `bun.lock` | Package scaffold | 5 |
| `src/logger.ts`, `src/time.ts`, `src/paths/safe-segment.ts`, `test/helpers/{tmp,git-fixture}.ts` | Foundations | 6 |
| `src/config/runner-config.ts`, `src/identity/identity-store.ts` | Config and identity | 7 |
| `src/journal/{schema,types,journal}.ts` | Journal | 8 |
| `src/sync/{http,backoff,batch}.ts` | Server client, batching | 9 |
| `src/sync/sync-loop.ts` | Sync loop | 10 |
| `src/verdict/*`, `src/watcher/status-snapshot.ts` | Pure verdict and snapshot mapping | 11 |
| `.nax/mono/apps/runner/*`, `.nax/context.md`, generated agent files | Repo wiring, gates, PR text | 11b |

---

### Task 0: Baseline

**Files:** none.

- [ ] **Step 1: Confirm the branch, base and design commits**

```bash
git -C repos/koda status -sb | head -3
git -C repos/koda log --oneline -5
```
Expected: `## feat/fleet-s1-slice3a-1-runner-foundations` and, in order, the plan commit (`docs(fleet): slice 3a-1 runner foundations plan` or similar), `32b543d0 docs(fleet): S1 slice 3 runner design (3a/3b) (#166)`, `fa721a30 fix(fleet): slice 2 review fixes ...`. Untracked files elsewhere in the workspace repo are not this repo's business.

- [ ] **Step 2: Verify the S1 spec pointer amendments are present (do not redo them)**

```bash
cd repos/koda
grep -n "Amended 2026-09-30" docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md
grep -n "Resolved 2026-09-30" docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md
grep -n "amended 2026-09-30" docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md
```
Expected: pointers at S1 spec §2.1 (line 281), §5.2 (421), §7.2 (593), §10 (719) and the "amended 2026-09-30, slice 3 design §1" note in the §1 boundaries list. If one is missing, stop: the design is not on this branch's base.

- [ ] **Step 3: Start the test DB and record baselines**

```bash
cd apps/api && bun run test:db:up
bun run test 2>&1 | tail -5
bun run test:scoped test/integration/fleet 2>&1 | tail -5
bunx tsc --noEmit -p tsconfig.json
cd ../.. && bun --version && git --version && tar --version | head -1 && command -v nax
```
Record the suite and test counts for the PR description. Expected Bun `1.4.2`; `git`, `tar` and `nax` present (`nax generate` is used in Task 11b).

---

### Task 1: Protocol v1 `RunnerCredential` and the server validator

**Files:**
- Modify: `packages/fleet-protocol/src/index.ts` (the `RunnerCapabilities.credentials` block, lines 15-35)
- Modify: `apps/api/src/fleet/common/protocol.ts` (type re-export list, add `RunnerCredential`)
- Modify: `apps/api/src/fleet/common/capabilities.ts` (credential parsing, lines 45-63)
- Modify: `apps/api/src/fleet/common/capabilities.spec.ts`
- Modify: `apps/api/test/helpers/fleet-fixtures.ts:10` (`FLEET_CAPS`)
- Modify: `apps/api/src/fleet/jobs/placement-rules.spec.ts:9` and `:35` (fixture only in this task; the rule change is Task 2)

**Interfaces:**
- Produces (protocol, type-only for the API, type and value package for the runner):
  ```ts
  export type RunnerCredentialExec = 'served' | 'declined' | 'error';
  export interface RunnerCredentialStored { kind: 'api-key' | 'oauth'; expires?: string; expired: boolean }
  export interface RunnerCredential {
    providerId: string;
    available: boolean;
    stored: RunnerCredentialStored | null;
    exec?: RunnerCredentialExec;
    ambient: boolean;
  }
  // RunnerCapabilities.credentials: RunnerCredential[]
  ```
- Produces (API): `parseCapabilities` accepts exactly that shape (whitelist of keys `providerId, available, stored, exec, ambient`; `stored` keys `kind, expires, expired`; at most 64 credentials; `expires` must parse as a date) and rejects the pre-3a shape `{providerId, kind, expires?}`.

- [ ] **Step 1: Write the failing spec**

In `apps/api/src/fleet/common/capabilities.spec.ts` replace the `credentials` line of `valid` and the credential-related rows, and add the new cases. Full replacement of the head of the file through the `it.each` list:

```ts
import { ValidationAppException } from '@nathapp/nestjs-common';
import { parseCapabilities } from './capabilities';

const cred = (over: Record<string, unknown> = {}) => ({ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false, ...over });

const valid = {
  nax: { version: '0.83.0', protocols: ['native', 'acp'] },
  sandbox: { available: true, probedAt: '2026-09-30T00:00:00.000Z' },
  profiles: { native: { protocol: 'native', providers: ['deepseek'], sandbox: true } },
  credentials: [cred()],
  tools: { git: true, gh: true, glab: false },
  executors: ['host'],
};

describe('parseCapabilities', () => {
  it('accepts a valid report and returns a clean copy', () => {
    const parsed = parseCapabilities({ ...valid, extra: 'dropped' });
    expect(parsed).toEqual(valid);
  });

  it.each([
    ['not an object', 'x'],
    ['an array', []],
    ['unknown protocol', { ...valid, nax: { version: '1', protocols: ['ssh'] } }],
    ['string sandbox flag', { ...valid, sandbox: { available: 'yes', probedAt: 'x' } }],
    ['bad profile', { ...valid, profiles: { p: { protocol: 'native', providers: 'deepseek', sandbox: true } } }],
    ['the pre-3a credential shape {providerId, kind}', { ...valid, credentials: [{ providerId: 'x', kind: 'api-key' }] }],
    ['a credential with a key field', { ...valid, credentials: [cred({ key: 'sk-1' })] }],
    ['a credential without available', { ...valid, credentials: [{ providerId: 'x', stored: null, ambient: false }] }],
    ['a credential without stored (stored is required: an object or null)', { ...valid, credentials: [{ providerId: 'x', available: true, ambient: false }] }],
    ['a credential with stored undefined', { ...valid, credentials: [cred({ stored: undefined })] }],
    ['a credential without ambient', { ...valid, credentials: [{ providerId: 'x', available: true, stored: null }] }],
    ['a string available flag', { ...valid, credentials: [cred({ available: 'yes' })] }],
    ['a stored kind of password', { ...valid, credentials: [cred({ stored: { kind: 'password', expired: false } })] }],
    ['a stored entry without expired', { ...valid, credentials: [cred({ stored: { kind: 'oauth' } })] }],
    ['a stored entry with a secret field', { ...valid, credentials: [cred({ stored: { kind: 'oauth', expired: false, secret: 's' } })] }],
    ['an exec status of maybe', { ...valid, credentials: [cred({ exec: 'maybe' })] }],
    ['unknown executor', { ...valid, executors: ['vm'] }],
    ['missing tools', { ...valid, tools: undefined }],
    ['no protocols (#161)', { ...valid, nax: { version: '1', protocols: [] } }],
    ['duplicate protocols', { ...valid, nax: { version: '1', protocols: ['native', 'native'] } }],
    ['a profile name with a slash', { ...valid, profiles: { 'a/b': valid.profiles.native } }],
    ['a 65-character profile name', { ...valid, profiles: { ['p'.repeat(65)]: valid.profiles.native } }],
    ['65 profiles', { ...valid, profiles: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, valid.profiles.native])) }],
    ['17 providers in a profile', { ...valid, profiles: { p: { protocol: 'native', providers: Array.from({ length: 17 }, (_, i) => `x${i}`), sandbox: false } } }],
    ['65 credentials', { ...valid, credentials: Array.from({ length: 65 }, (_, i) => cred({ providerId: `x${i}` })) }],
    ['an unparseable expiry', { ...valid, credentials: [cred({ stored: { kind: 'oauth', expires: 'soon', expired: false } })] }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseCapabilities(raw)).toThrow(ValidationAppException);
  });

  it('keeps a stored oauth credential with its expiry, an exec verdict and the ambient flag', () => {
    const raw = {
      ...valid,
      credentials: [
        cred({ providerId: 'claude', stored: { kind: 'oauth', expires: '2026-10-01T00:00:00.000Z', expired: false }, exec: 'declined', ambient: true }),
        cred({ providerId: 'env-only', available: true, stored: null, ambient: true }),
        cred({ providerId: 'broken', available: false, stored: null, exec: 'error' }),
      ],
    };
    expect(parseCapabilities(raw).credentials).toEqual(raw.credentials);
  });

  it('rejects a report larger than 64 KiB', () => {
    const profiles: Record<string, unknown> = {};
    for (let i = 0; i < 2000; i += 1) profiles[`p${i}`] = { protocol: 'native', providers: ['x'.repeat(30)], sandbox: true };
    expect(() => parseCapabilities({ ...valid, profiles })).toThrow(ValidationAppException);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && bun run test:scoped src/fleet/common/capabilities.spec.ts`
Expected: FAIL (the new credential shape is rejected by the old validator; TypeScript may also report `RunnerCredential` does not exist once Step 3 starts).

- [ ] **Step 3: Edit the protocol types**

In `packages/fleet-protocol/src/index.ts`, replace the `credentials` field and add the types before `RunnerCapabilities`:

```ts
/** nax's verdict on one provider, mirroring `nax auth list --json` without account labels (slice 3 design §1.1). */
export type RunnerCredentialExec = 'served' | 'declined' | 'error';
export interface RunnerCredentialStored { kind: 'api-key' | 'oauth'; expires?: string; expired: boolean }
export interface RunnerCredential {
  providerId: string;
  /** nax's verdict: stored, exec-served or ambient. Placement follows it (it ignores access-token expiry on purpose). */
  available: boolean;
  stored: RunnerCredentialStored | null;
  /** Present when nax `auth.source` is exec. */
  exec?: RunnerCredentialExec;
  ambient: boolean;
}
```
and in `RunnerCapabilities`: `credentials: RunnerCredential[];` (update the doc comment: "at most 64 credentials; `stored.expires`, when present, must parse as a date"). In `apps/api/src/fleet/common/protocol.ts` add `RunnerCredential,` to the alphabetical `export type { ... }` list after `RunnerArch`.

- [ ] **Step 4: Edit the validator**

In `apps/api/src/fleet/common/capabilities.ts` change the import to include `RunnerCredential`, add these helpers above `parseCapabilities`, and replace the `parsedCredentials` block:

```ts
const CREDENTIAL_KEYS = new Set(['providerId', 'available', 'stored', 'exec', 'ambient']);
const STORED_KEYS = new Set(['kind', 'expires', 'expired']);
const STORED_KINDS: readonly string[] = ['api-key', 'oauth'];
const EXEC_STATUSES: readonly string[] = ['served', 'declined', 'error'];

function parseStored(v: unknown, i: number): RunnerCredential['stored'] {
  if (v === null) return null;
  // `stored` is required on the wire: an object or an explicit null. undefined (absent) is rejected.
  if (
    v === undefined || !isObj(v) || !STORED_KINDS.includes(v.kind as string) || !isBool(v.expired) ||
    (v.expires !== undefined && (!isStr(v.expires) || Number.isNaN(Date.parse(v.expires))))
  ) fail(`credential ${i} stored`);
  const stored = v as Obj;
  if (Object.keys(stored).some((k) => !STORED_KEYS.has(k))) fail(`credential ${i} stored has unexpected fields`);
  return {
    kind: stored.kind as 'api-key' | 'oauth',
    ...(stored.expires !== undefined ? { expires: stored.expires as string } : {}),
    expired: stored.expired as boolean,
  };
}

function parseCredential(c: unknown, i: number): RunnerCredential {
  if (!isObj(c) || !isStr(c.providerId) || !isBool(c.available) || !isBool(c.ambient)) fail(`credential ${i}`);
  const cred = c as Obj;
  if (Object.keys(cred).some((k) => !CREDENTIAL_KEYS.has(k))) fail(`credential ${i} has unexpected fields`);
  if (cred.exec !== undefined && !EXEC_STATUSES.includes(cred.exec as string)) fail(`credential ${i} exec`);
  return {
    providerId: cred.providerId as string,
    available: cred.available as boolean,
    stored: parseStored(cred.stored, i),
    ...(cred.exec !== undefined ? { exec: cred.exec as RunnerCredential['exec'] } : {}),
    ambient: cred.ambient as boolean,
  };
}
```
and in `parseCapabilities`: `const parsedCredentials = credentials.map(parseCredential);`. (`stored` is required on the wire: `parseStored(cred.stored, i)` rejects `undefined`, and only an explicit `null` means "nothing stored", which is what an ambient-only provider reports. The runner's own report builder in 3b always writes the key.) Delete the old `allowed` whitelist lines.

- [ ] **Step 5: Update the two fixtures**

`apps/api/test/helpers/fleet-fixtures.ts:10`: `credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false }],`. `apps/api/src/fleet/jobs/placement-rules.spec.ts:9`: the same literal. The `provider_expired` row at `:35` and its `credential.expires` usage do not compile against the new type; those `placement-rules.spec.ts` rows are fixed in Task 2 (Step 1 rewrites the row). Tasks 1 and 2 therefore land green together: do not commit after Task 1, and the type check in Step 6 is expected to fail only on `placement-rules.ts` and `placement-rules.spec.ts`.

- [ ] **Step 6: Run the specs and the type check**

```bash
cd apps/api
bun run test:scoped src/fleet/common/capabilities.spec.ts src/fleet/common/protocol.spec.ts src/fleet/runners/enrollment.service.spec.ts
bunx tsc --noEmit -p tsconfig.json 2>&1 | head
```
Expected: the three specs PASS; `tsc` reports only the `placement-rules.ts` / `placement-rules.spec.ts` errors that Task 2 removes (`provider_expired` and `credential.expires`). Do not commit yet.

- [ ] **Step 7: Commit together with Task 2**

Commit after Task 2 Step 6 (the tree is not type-clean between the two).

---

### Task 2: Placement follows nax's `available`; `provider_unavailable` replaces `provider_expired`

**Files:**
- Modify: `apps/api/src/fleet/jobs/placement-rules.ts` (`MisfitReason` lines 4-6, `PERMANENT_MISFITS` lines 9-11, `capabilityMisfit` lines 41-57)
- Modify: `apps/api/src/fleet/jobs/placement-rules.spec.ts`
- Modify: `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts:66` (reason enum)
- Modify: `apps/api/test/integration/fleet/placement.integration.spec.ts` **[DB]**
- Modify: `openapi.json` (generated, one enum hunk)

**Interfaces:**
- Consumes: Task 1 `RunnerCredential`.
- Produces: `MisfitReason` = `'disabled' | 'offline' | 'labels' | 'executor' | 'protocol' | 'provider_missing' | 'provider_unavailable' | 'sandbox' | 'tools' | 'busy_repo' | 'capacity'`; `PERMANENT_MISFITS` without `provider_expired` and **without** `provider_unavailable` (a later probe may fix it, so the job queues, and a pinned dispatch answers 201 not 422). `capabilityMisfit(job, caps)` (the `now` parameter is gone; it was only for expiry).

- [ ] **Step 1: Write the failing rows**

In `placement-rules.spec.ts` replace the `provider_expired` table row and add cases (keep the file's other rows):

```ts
const cred = (over: Record<string, unknown> = {}) => ({ providerId: 'deepseek', available: true, stored: null, ambient: false, ...over });
```
row list entries:

```ts
    ['provider_missing', job(), runner({ capabilities: caps({ credentials: [] }) })],
    ['provider_unavailable', job(), runner({ capabilities: caps({ credentials: [cred({ available: false })] }) })],
```
new tests:

```ts
  it('follows nax: an expired stored oauth token with available=true still fits (nax refreshes it itself)', () => {
    const credentials = [cred({ stored: { kind: 'oauth', expires: '2026-10-01T11:59:59.000Z', expired: true }, available: true })];
    expect(misfit(job(), runner({ capabilities: caps({ credentials }) }))).toBeNull();
  });

  it('treats an unavailable provider as a waiting reason, not a permanent one', () => {
    expect(PERMANENT_MISFITS.has('provider_unavailable')).toBe(false);
    expect(PERMANENT_MISFITS.has('provider_missing')).toBe(true);
    expect((PERMANENT_MISFITS as ReadonlySet<string>).has('provider_expired')).toBe(false);
  });

  it('reports the first failing provider in profile order, missing or unavailable', () => {
    const profile = (providers: string[]) => ({ p: { protocol: 'native', providers, sandbox: false } });
    const credentials = [cred({ available: false })]; // deepseek is present but unavailable, openai is absent
    const missingFirst = runner({ capabilities: caps({ profiles: profile(['openai', 'deepseek']), credentials }) });
    const unavailableFirst = runner({ capabilities: caps({ profiles: profile(['deepseek', 'openai']), credentials }) });
    expect(misfit(job({ profiles: ['p'] }), missingFirst)).toBe('provider_missing');
    expect(misfit(job({ profiles: ['p'] }), unavailableFirst)).toBe('provider_unavailable');
  });
```
Also change the `caps` fixture's credentials line (9) to `credentials: [cred()],` and define `cred` above it (move the helper to the top of the file).

- [ ] **Step 2: Run and watch it fail**

Run: `cd apps/api && bun run test:scoped src/fleet/jobs/placement-rules.spec.ts`
Expected: FAIL / type errors (`provider_unavailable` is not a `MisfitReason`, `expires` does not exist on `RunnerCredential`).

- [ ] **Step 3: Implement**

`placement-rules.ts`:

```ts
export type MisfitReason =
  | 'disabled' | 'offline' | 'labels' | 'executor' | 'protocol' | 'provider_missing'
  | 'provider_unavailable' | 'sandbox' | 'tools' | 'busy_repo' | 'capacity';

/** A pinned job whose runner fails one of these can never run there: 422 at dispatch (spec §4). */
export const PERMANENT_MISFITS: ReadonlySet<MisfitReason> = new Set<MisfitReason>([
  'disabled', 'executor', 'protocol', 'provider_missing', 'sandbox', 'tools',
]);
```
`capabilityMisfit(job, caps)`:

```ts
    for (const provider of needs.providers) {
      const credential = caps.credentials.find((c) => c.providerId === provider);
      if (!credential) return 'provider_missing';
      // nax's own verdict (slice 3 design §1.1): available deliberately ignores access-token expiry.
      if (!credential.available) return 'provider_unavailable';
    }
```
and in `firstMisfit` call `capabilityMisfit(job, runner.capabilities)`; add a comment above `PERMANENT_MISFITS` line: `provider_unavailable` is not permanent (a later probe may fix it). In `dto/fleet-job.dto.ts:66` replace `'provider_expired'` with `'provider_unavailable'` in the `enum:` array.

- [ ] **Step 4: Add the integration case** **[DB]**

In `placement.integration.spec.ts`, after the `keeps a job QUEUED` test:

```ts
  it('queues, rather than rejects, a job whose runner has the provider but nax cannot authenticate it', async () => {
    const unavailable = { ...FLEET_CAPS, credentials: [{ providerId: 'deepseek', available: false, stored: null, ambient: false }] };
    const r = await insertRunner(prisma, { capabilities: unavailable });
    const job = await queue('unavail', { pinnedRunnerId: r.id });
    const outcome = await placement.placeJob(job.id);
    expect(outcome.assigned).toBe(false);
    expect(outcome.misfits).toEqual([expect.objectContaining({ runnerId: r.id, reason: 'provider_unavailable' })]);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).state).toBe('QUEUED');
  });
```

- [ ] **Step 7: Run everything touched**

```bash
cd apps/api
bunx tsc --noEmit -p tsconfig.json
bun run test:scoped src/fleet test/integration/fleet
```
Expected: `tsc` clean; every fleet unit and integration spec PASS (Jest prints the count; compare with Task 0's baseline plus the new cases).

- [ ] **Step 8: Regenerate the contract so the tree is green at this commit**

The DTO enum change alters the committed `openapi.json`, and the CLI client is generated from it.

```bash
cd ../..   # repo root
bun run generate
git diff openapi.json | grep '^[+-]' | grep -v '^+++\|^---'
```
Expected: exit 0 and exactly one hunk: `provider_expired` replaced by `provider_unavailable` in the `PlacementMisfitDto.reason` enum (openapi.json around line 7891). Anything else is unrelated drift: stop and look. Then:

```bash
cd apps/api && bun run test:scoped test/integration/openapi-spec test/integration/openapi-client && cd ../cli && bunx tsc --noEmit && cd ../..
```
Expected: PASS, CLI clean (`apps/cli/src/generated/` is gitignored and not committed).

- [ ] **Step 9: Commit (Tasks 1 and 2 together)**

```bash
git add packages/fleet-protocol/src/index.ts apps/api/src/fleet apps/api/test openapi.json
git commit -m "feat(fleet): protocol v1 credentials mirror nax auth list; placement follows nax availability"
```

---

### Task 3: #157 — runner capacity on `/fleet/runner/me`, `ke_` prefix on enroll **[DB]**

**Files:**
- Modify: `apps/api/src/auth/domain/auth.domain.ts:22-27` (`RunnerDomain.capacity`)
- Modify: `apps/api/src/auth/prisma-auth.repository.ts:99-105` (select `capacity`)
- Modify: `apps/api/src/auth/principal/koda-principal.types.ts:27-35` (`RunnerPrincipal.capacity`)
- Modify: `apps/api/src/auth/guards/combined-auth.guard.ts:123-135` (`toRunnerPrincipal`) and `combined-auth.guard.spec.ts:214`
- Modify: `apps/api/src/fleet/runners/runner-api.controller.ts:32-37` (`me`)
- Modify: `apps/api/src/fleet/runners/enrollment.service.ts:46-50` and `enrollment.service.spec.ts`
- Modify: `apps/api/src/auth/principal/actor-foreign-keys.spec.ts:6,11`, `apps/api/src/auth/casl/koda-casl-ability.factory.spec.ts:236` (add `capacity: 1` to the runner literals)
- Modify: `apps/api/test/integration/fleet/runner-enrollment.integration.spec.ts:69-70`, `runner-admin.integration.spec.ts` **[DB]**

**Interfaces:**
- Produces: `RunnerPrincipal.capacity: number`; `GET /fleet/runner/me` returns `{ id, name, labels, capacity, enabled }` (`RunnerIdentity` in the protocol already declares `capacity`); `EnrollmentService.enroll` throws `AuthException({}, 'fleet.enroll')` (401) for a token without the `ke_` prefix, **before** hashing or touching the database.

- [ ] **Step 1: Write the failing unit tests**

`enrollment.service.spec.ts`, after the protocol-version test:

```ts
  it('rejects a token without the ke_ prefix with the bad-token 401 before any lookup (#157)', async () => {
    for (const enrollmentToken of ['abc', 'kr_' + 'a'.repeat(64), 'KE_abc', '']) {
      await expect(service.enroll({ ...body, enrollmentToken } as never)).rejects.toBeInstanceOf(AuthException);
    }
    expect(repo.consumeEnrollment).not.toHaveBeenCalled();
  });
```
`combined-auth.guard.spec.ts`: `const runnerRow = { id: 'run-1', name: 'mac-1', labels: ['darwin'], enabled: true, capacity: 3 };` and in the first runner test extend the assertion to `expect.objectContaining({ actorType: 'runner', id: 'run-1', runnerName: 'mac-1', enabled: true, capacity: 3 })`.

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/api && bun run test:scoped src/fleet/runners/enrollment.service.spec.ts src/auth/guards/combined-auth.guard.spec.ts`
Expected: FAIL (the prefix test reaches `consumeEnrollment`; the guard test has no `capacity`).

- [ ] **Step 3: Implement**

`auth.domain.ts`: `capacity: number;` in `RunnerDomain`. `prisma-auth.repository.ts`: `select: { id: true, name: true, labels: true, enabled: true, capacity: true },`. `koda-principal.types.ts` `RunnerPrincipal`: add `/** Slots the operator granted this runner (PATCH /fleet/runners/:id); the runner reads it from /fleet/runner/me. */ capacity: number;`. `toRunnerPrincipal`: add `capacity: runner.capacity,` after `enabled`. `runner-api.controller.ts`:

```ts
  @ApiResponse({ status: 200, description: '{ id, name, labels, capacity, enabled }' })
  async me(@Principal() runner: RunnerPrincipal) {
    return JsonResponse.Ok({ id: runner.id, name: runner.runnerName, labels: runner.labels, capacity: runner.capacity, enabled: runner.enabled });
  }
```
`enrollment.service.ts` at the top of `enroll`, after the protocol-version check and before `parseCapabilities`:

```ts
    // #157: only ke_ tokens are enrollment tokens; anything else is the same bad-token 401, before the hash lookup.
    if (!body.enrollmentToken.startsWith(ENROLLMENT_TOKEN_PREFIX)) throw new AuthException({}, 'fleet.enroll');
```
with `ENROLLMENT_TOKEN_PREFIX` added to the existing `../common/fleet-keys` import. Add `capacity: 1` to the runner literals in `actor-foreign-keys.spec.ts` (two) and `koda-casl-ability.factory.spec.ts:236`.

- [ ] **Step 4: Extend the integration specs** **[DB]**

`runner-enrollment.integration.spec.ts:69-70`:

```ts
    const me = data<Record<string, unknown>>(await request(server).get('/api/fleet/runner/me').set(auth(enrolled.apiKey)).expect(200));
    expect(me).toEqual({ id: enrolled.runnerId, name: 'box-1', labels: ['gpu', 'linux'], capacity: 1, enabled: true });
```
and a new test in the same file:

```ts
  it('answers the bad-token 401 for a non-ke_ token without consuming anything (#157)', async () => {
    const { token } = await newToken();
    await request(server).post('/api/fleet/runner/enroll').send(enrollBody(`x${token}`, 'box-bad')).expect(401);
    await request(server).post('/api/fleet/runner/enroll').send(enrollBody(token, 'box-good')).expect(201);
  });
```
`runner-admin.integration.spec.ts`, before `revokes the key on delete`:

```ts
  it('reports the operator-set capacity on /me (#157)', async () => {
    const read = async () => data<{ capacity: number }>(await request(server).get('/api/fleet/runner/me').set(auth(runner.apiKey)).expect(200)).capacity;
    expect(await read()).toBe(1);
    await request(server).patch(`/api/fleet/runners/${runner.runnerId}`).set(auth(admin)).send({ capacity: 3 }).expect(200);
    expect(await read()).toBe(3);
  });
```

- [ ] **Step 5: Run everything touched**

```bash
cd apps/api
bunx tsc --noEmit -p tsconfig.json
bun run test:scoped src/fleet/runners src/auth test/integration/fleet
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(fleet): runner capacity on /fleet/runner/me, ke_ prefix on enroll (#157)"
```

---

### Task 4: Contract regeneration after #157 and the server gate

**Files:**
- Modify: `openapi.json` (generated)
- Modify: `apps/cli/src/generated/**` (generated, gitignored, not committed)

**Interfaces:** none new. Task 2 already committed the `provider_unavailable` enum hunk; Task 3 changed the `/me` description, so the committed contract is now one hunk behind.

- [ ] **Step 1: Regenerate**

Run from the repo root: `bun run generate`
Expected: exit 0; the api build's `bun scripts/check-dist-requires.ts` reports no store paths.

- [ ] **Step 2: Verify the diff is exactly the `/me` description**

```bash
git diff --stat openapi.json
git diff openapi.json | grep '^[+-]' | grep -v '^+++\|^---'
```
Expected: one hunk, at `/api/fleet/runner/me` (`openapi.json` around line 5194): `"description": "{ id, name, labels, enabled }"` becomes `"description": "{ id, name, labels, capacity, enabled }"` (the `@ApiResponse` text Task 3 Step 3 wrote). Nothing else: the enum hunk is already committed by Task 2. Anything more is unrelated drift: stop and look.

- [ ] **Step 3: Run the contract tests and the CLI**

```bash
cd apps/api && bun run test:scoped test/integration/openapi-spec test/integration/openapi-client && cd ../cli && bunx tsc --noEmit && bunx jest 2>&1 | tail -4
```
Expected: PASS, CLI clean.

- [ ] **Step 4: Server-side gate**

```bash
cd ../api && bun run test 2>&1 | tail -5 && bun run test:integration 2>&1 | tail -5 && bun run lint && cd ../..
```
Expected: green; counts equal the Task 0 baseline plus the cases added in Tasks 1-3.

- [ ] **Step 5: Commit**

```bash
git add openapi.json
git commit -m "chore(fleet): regenerate openapi for runner capacity on /me"
```

---
### Task 5: Scaffold `apps/runner`

**Files:**
- Create: `apps/runner/package.json`, `apps/runner/tsconfig.json`, `apps/runner/.eslintrc.cjs`, `apps/runner/bunfig.toml`
- Create: `apps/runner/src/version.ts`, `apps/runner/src/version.spec.ts`, `apps/runner/src/main.ts`
- Modify: `bun.lock` (generated by `bun install`)

**Interfaces:**
- Produces: workspace `@nathapp/koda-runner` with scripts `test` (`bun test src test/unit`), `test:integration`, `type-check`, `lint`, `lint:json-error`, `lint:fix`, `start` (`build:binary` arrives with its script in 3a-2 Task 28); `DAEMON_VERSION: string` (from `package.json`); a `koda-runner --version` entry point.

- [ ] **Step 1: Write the failing spec**

`apps/runner/src/version.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import pkg from '../package.json' with { type: 'json' };
import { DAEMON_VERSION } from './version';

describe('DAEMON_VERSION', () => {
  test('is the package version, a plain semver', () => {
    expect(DAEMON_VERSION).toBe(pkg.version);
    expect(DAEMON_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 2: Create the package files**

`apps/runner/package.json`:

```json
{
  "name": "@nathapp/koda-runner",
  "version": "0.1.0",
  "private": true,
  "description": "Koda fleet runner daemon: executes nax jobs dispatched by the koda API",
  "type": "module",
  "scripts": {
    "start": "bun src/main.ts",
    "test": "bun test src test/unit",
    "test:integration": "bun test test/integration",
    "type-check": "tsc --noEmit",
    "lint": "eslint \"{src,test}/**/*.ts\" --max-warnings=0",
    "lint:json-error": "eslint -f json \"{src,test}/**/*.ts\" --max-warnings=0 --quiet",
    "lint:fix": "eslint \"{src,test}/**/*.ts\" --fix"
  },
  "dependencies": {
    "@nathapp/fleet-protocol": "workspace:*",
    "commander": "^12.0.0"
  },
  "devDependencies": {
    "@nathapp/typescript-config": "workspace:*",
    "@types/bun": "^1.4.2",
    "@types/node": "^22.0.0",
    "typescript": "^5.4.0"
  }
}
```

`apps/runner/tsconfig.json` (the base is CommonJS; the runner is Bun ESM, decision D21):

```json
{
  "extends": "@nathapp/typescript-config/base.json",
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ESNext"],
    "types": ["bun"],
    "noEmit": true,
    "declaration": false,
    "sourceMap": false,
    "verbatimModuleSyntax": true,
    "emitDecoratorMetadata": false,
    "experimentalDecorators": false
  },
  "include": ["src/**/*", "test/**/*", "scripts/**/*"]
}
```

`apps/runner/.eslintrc.cjs` (inherits the repo rules: no `any`, no non-null assertion, unused vars error):

```js
module.exports = {
  root: true,
  extends: ['../../.eslintrc.js'],
  globals: { Bun: 'readonly' },
};
```

`apps/runner/bunfig.toml` (the default 5 s test timeout is too tight for specs that spawn `git` or open SQLite files on a loaded CI runner):

```toml
[test]
timeout = 30000
```

The runner's `0.1.0` is **intentionally not** in `scripts/bump-version.sh` `TARGETS` (root, api, cli, web): the runner is a separately versioned, private binary and a repo-wide release bump must not silently change what `koda-runner --version` and the sync `daemonVersion` report. `DAEMON_VERSION` is read from `apps/runner/package.json` only. The `build:binary` script points at `scripts/build-binary.ts`, which is created in 3a-2 Task 28; until then the script exists but is not run by any gate.

`apps/runner/src/version.ts`:

```ts
import pkg from '../package.json' with { type: 'json' };

export const DAEMON_VERSION: string = pkg.version;
```

`apps/runner/src/main.ts` (a stub; 3a-2 Task 24 adds the commands):

```ts
import { Command } from 'commander';
import { DAEMON_VERSION } from './version';

const program = new Command().name('koda-runner').description('Koda fleet runner daemon').version(DAEMON_VERSION);
await program.parseAsync(process.argv);
```

- [ ] **Step 3: Install and update the lockfile**

Run from the repo root: `bun install`
Expected: `bun.lock` gains the `apps/runner` workspace entry, `@types/bun` and its dependency; nothing else changes.

```bash
git diff --stat bun.lock
bun install --frozen-lockfile
```
Expected: the diff touches only additions for `@nathapp/koda-runner`, `@types/bun`, `bun-types`; the frozen install succeeds.

- [ ] **Step 4: Run the spec, type check, lint and the entry point**

```bash
cd apps/runner
bun test src
bun run type-check
bun run lint
bun src/main.ts --version
```
Expected: 1 test passes; type check and lint clean (lint has no `test/` files yet, which eslint accepts because `src/**` matches); the last command prints `0.1.0`.

- [ ] **Step 5: Confirm turbo picks the app up**

```bash
bunx turbo run test type-check lint --filter=@nathapp/koda-runner --dry=json | jq -r '.tasks[].taskId' | sort
```
Expected: `@nathapp/koda-runner#lint`, `@nathapp/koda-runner#test`, `@nathapp/koda-runner#type-check` (plus `@nathapp/fleet-protocol` and config package tasks that have scripts, if any).

- [ ] **Step 6: Commit**

```bash
git add apps/runner bun.lock
git commit -m "feat(fleet): scaffold apps/runner (bun ESM package, scripts, lockfile)"
```

---

### Task 6: Foundations — logger, time, safe path segments, test helpers

**Files:**
- Create: `apps/runner/src/errors.ts`, `apps/runner/src/errors.spec.ts`
- Create: `apps/runner/src/logger.ts`, `apps/runner/src/logger.spec.ts`
- Create: `apps/runner/src/time.ts`, `apps/runner/src/time.spec.ts`
- Create: `apps/runner/src/paths/safe-segment.ts`, `apps/runner/src/paths/safe-segment.spec.ts`
- Create: `apps/runner/test/helpers/tmp.ts`, `apps/runner/test/helpers/git-fixture.ts`

**Interfaces:**
- Produces:
  ```ts
  // errors.ts
  export function errorMessage(error: unknown): string;
  export function firstLine(text: string, max?: number): string;        // first non-empty line, cut to max (default 200)
  // logger.ts
  export type LogFields = Readonly<Record<string, unknown>>;
  export interface Logger { info(message: string, fields?: LogFields): void; warn(message: string, fields?: LogFields): void; error(message: string, fields?: LogFields): void }
  export function redact(value: unknown): unknown;                       // keys matching /key|token|secret|password|authorization/i -> '[redacted]'
  export function createLogger(write: (line: string) => void, now?: () => Date): Logger;   // one JSON object per line
  export function createConsoleLogger(): Logger;                         // stderr
  export interface MemoryLogger extends Logger { readonly lines: ReadonlyArray<{ level: string; message: string; fields: LogFields }> }
  export function createMemoryLogger(): MemoryLogger;
  // time.ts
  export type Now = () => Date;
  export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;   // resolves early (never rejects) on abort
  export const systemNow: Now;
  export const systemSleep: Sleep;
  // paths/safe-segment.ts
  export class PathError extends Error {}
  export function assertSegment(label: string, value: unknown): string;     // /^[A-Za-z0-9._-]+$/, not '.' or '..', at most 100 chars
  export function assertOwner(value: unknown): string;                      // '/'-separated segments (GitLab subgroups), the first may not start with '.'
  export function assertFeature(value: unknown): string;                    // server FEATURE_RE: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/, no '..'
  export function assertRelativePath(label: string, value: unknown): string; // repo-relative: no leading '/', '-', backslash, NUL; no '', '.', '..' segments; at most 512
  export function repoDirFor(workspaceRoot: string, owner: string, name: string): string;
  export function jobDirFor(workspaceRoot: string, jobId: string): string;   // <root>/.jobs/<jobId>
  export function featureDirFor(repoDir: string, feature: string): string;   // <repoDir>/.nax/features/<feature>
  export function assertInside(root: string, candidate: string): string;     // resolved candidate must be strictly inside root
  ```
- Produces (test helpers): `makeTempDirs(): { make(prefix: string): Promise<string>; cleanup(): Promise<void> }`; `isolateGit(): void`; `makeOrigin(base, name, spec): Promise<Origin>`; `pushCommit(base, originUrl, branch, path, content): Promise<string>`; `git(cwd, ...args): Promise<string>` (throws on non-zero).

- [ ] **Step 1: Write the failing specs**

`src/errors.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { errorMessage, firstLine } from './errors';

describe('errors', () => {
  test('errorMessage reads Error, string and unknown values', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage({ a: 1 })).toBe('[object Object]');
  });

  test('firstLine takes the first non-empty line and cuts it', () => {
    expect(firstLine('\n\n  fatal: bad\nsecond')).toBe('fatal: bad');
    expect(firstLine('x'.repeat(300), 50)).toHaveLength(50);
    expect(firstLine('')).toBe('');
  });
});
```

`src/logger.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createLogger, createMemoryLogger, redact } from './logger';

describe('redact', () => {
  test('replaces secret-looking keys at any depth and leaves the rest', () => {
    expect(redact({ apiKey: 'kr_x', nested: { Authorization: 'Bearer y', ok: 1 }, list: [{ token: 't' }], name: 'n' })).toEqual({
      apiKey: '[redacted]', nested: { Authorization: '[redacted]', ok: 1 }, list: [{ token: '[redacted]' }], name: 'n',
    });
  });
  test('bounds recursion instead of overflowing on a cycle', () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    expect(() => JSON.stringify(redact(a))).not.toThrow();
  });
});

describe('createLogger', () => {
  test('writes one JSON object per line with level, message, time and redacted fields', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l), () => new Date('2026-10-01T00:00:00.000Z'));
    log.warn('sync failed', { status: 500, apiKey: 'kr_secret' });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ ts: '2026-10-01T00:00:00.000Z', level: 'warn', msg: 'sync failed', status: 500, apiKey: '[redacted]' });
    expect(lines[0]).not.toContain('kr_secret');
  });
  test('memory logger records what it was given', () => {
    const log = createMemoryLogger();
    log.info('a', { x: 1 });
    log.error('b');
    expect(log.lines).toEqual([{ level: 'info', message: 'a', fields: { x: 1 } }, { level: 'error', message: 'b', fields: {} }]);
  });
});
```

`src/time.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { systemSleep } from './time';

describe('systemSleep', () => {
  test('waits roughly the requested time', async () => {
    const start = performance.now();
    await systemSleep(40);
    expect(performance.now() - start).toBeGreaterThanOrEqual(30);
  });
  test('resolves early, without rejecting, when the signal aborts, and at once when already aborted', async () => {
    const controller = new AbortController();
    const start = performance.now();
    const pending = systemSleep(5_000, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await pending;
    expect(performance.now() - start).toBeLessThan(1_000);
    await systemSleep(5_000, AbortSignal.abort());
  });
});
```

`src/paths/safe-segment.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  PathError, assertFeature, assertInside, assertOwner, assertRelativePath, assertSegment, featureDirFor, jobDirFor, repoDirFor,
} from './safe-segment';

describe('assertSegment', () => {
  test.each(['app', 'my.repo', 'a_b-c', '.github', 'x'.repeat(100)])('accepts %s', (v) => {
    expect(assertSegment('repo', v)).toBe(v);
  });
  test.each(['', '.', '..', 'a/b', 'a\\b', 'a b', 'a\u0000b', 'x'.repeat(101), '../etc', 'a%2fb', 'é'])('rejects %j', (v) => {
    expect(() => assertSegment('repo', v)).toThrow(PathError);
  });
  test('rejects non-strings', () => {
    for (const v of [undefined, null, 1, {}, []]) expect(() => assertSegment('repo', v)).toThrow(PathError);
  });
});

describe('assertOwner', () => {
  test('accepts a plain owner and a GitLab subgroup path', () => {
    expect(assertOwner('acme')).toBe('acme');
    expect(assertOwner('infra/deploy-team')).toBe('infra/deploy-team');
  });
  test.each(['.jobs', '.hidden/x', 'a//b', 'a/../b', '/a', 'a/', 'a/.'])('rejects %j (D29: no leading dot on the first segment, no empty or dot segments)', (v) => {
    expect(() => assertOwner(v)).toThrow(PathError);
  });
});

describe('assertFeature', () => {
  test.each(['feat', 'a.b-c_d', 'F1'])('accepts %s', (v) => expect(assertFeature(v)).toBe(v));
  test.each(['', '.x', '-x', '_x', 'a/b', 'a..b', 'x'.repeat(129)])('rejects %j (server FEATURE_RE)', (v) => {
    expect(() => assertFeature(v)).toThrow(PathError);
  });
});

describe('assertRelativePath', () => {
  test('accepts a repo-relative spec path', () => {
    expect(assertRelativePath('planFrom', 'docs/specs/SPEC-x.md')).toBe('docs/specs/SPEC-x.md');
  });
  test.each(['', '/etc/passwd', '-rf', 'a/../b', 'a//b', './a', 'a/.', 'a\\b', 'a\u0000b', 'x'.repeat(513)])('rejects %j', (v) => {
    expect(() => assertRelativePath('planFrom', v)).toThrow(PathError);
  });
});

describe('path builders', () => {
  const root = join('/', 'work', 'space');
  test('build under the workspace root', () => {
    expect(repoDirFor(root, 'Acme', 'app')).toBe(join(root, 'Acme', 'app'));
    expect(repoDirFor(root, 'infra/team', 'deploy')).toBe(join(root, 'infra', 'team', 'deploy'));
    expect(jobDirFor(root, 'cabc123')).toBe(join(root, '.jobs', 'cabc123'));
    expect(featureDirFor(join(root, 'Acme', 'app'), 'feat')).toBe(join(root, 'Acme', 'app', '.nax', 'features', 'feat'));
  });
  test('refuse hostile pieces', () => {
    expect(() => repoDirFor(root, '..', 'app')).toThrow(PathError);
    expect(() => repoDirFor(root, 'acme', '..')).toThrow(PathError);
    expect(() => repoDirFor(root, '.jobs', 'x')).toThrow(PathError);
    expect(() => jobDirFor(root, '../x')).toThrow(PathError);
    expect(() => featureDirFor(root, 'a/b')).toThrow(PathError);
  });
  test('assertInside accepts a strict descendant only', () => {
    expect(assertInside(root, join(root, 'a', 'b'))).toBe(join(root, 'a', 'b'));
    expect(() => assertInside(root, root)).toThrow(PathError);
    expect(() => assertInside(root, join(root, '..', 'other'))).toThrow(PathError);
    expect(() => assertInside(root, join('/', 'work', 'space-evil', 'x'))).toThrow(PathError);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/runner && bun test src`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/errors.ts`:

```ts
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function firstLine(text: string, max = 200): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.slice(0, max);
}
```

`src/logger.ts`:

```ts
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const SECRET_KEY = /key|token|secret|password|authorization/i;
const MAX_DEPTH = 5;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[depth]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[redacted]' : redact(item, depth + 1)]),
    );
  }
  return value;
}

export function createLogger(write: (line: string) => void, now: () => Date = () => new Date()): Logger {
  const emit = (level: string, msg: string, fields: LogFields = {}): void => {
    write(JSON.stringify({ ...(redact(fields) as Record<string, unknown>), ts: now().toISOString(), level, msg }));
  };
  return {
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

export function createConsoleLogger(): Logger {
  return createLogger((line) => process.stderr.write(`${line}\n`));
}

export interface MemoryLogger extends Logger {
  readonly lines: ReadonlyArray<{ level: string; message: string; fields: LogFields }>;
}

export function createMemoryLogger(): MemoryLogger {
  const lines: Array<{ level: string; message: string; fields: LogFields }> = [];
  const push = (level: string) => (message: string, fields: LogFields = {}): void => {
    lines.push({ level, message, fields });
  };
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}
```

`src/time.ts`:

```ts
export type Now = () => Date;
/** Resolves after `ms`, or early (never rejecting) when the signal aborts. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const systemNow: Now = () => new Date();

export const systemSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
```

`src/paths/safe-segment.ts`:

```ts
import { join, relative, resolve, sep } from 'node:path';

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;
/** nax validateFeatureName, as the server's FEATURE_RE (apps/api/src/fleet/jobs/dispatch-input.ts). */
const FEATURE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function assertSegment(label: string, value: unknown): string {
  if (typeof value !== 'string' || value.length > 100 || !SEGMENT.test(value) || value === '.' || value === '..') {
    throw new PathError(`invalid ${label}`);
  }
  return value;
}

/** A GitLab owner may be a group/subgroup path; every piece is a checked segment (D29). */
export function assertOwner(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200) throw new PathError('invalid owner');
  const parts = value.split('/');
  parts.forEach((part) => assertSegment('owner', part));
  if (parts[0].startsWith('.')) throw new PathError('invalid owner');
  return value;
}

export function assertFeature(value: unknown): string {
  if (typeof value !== 'string' || !FEATURE.test(value) || value.includes('..')) throw new PathError('invalid feature');
  return value;
}

export function assertRelativePath(label: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.startsWith('/') || value.startsWith('-') || /[\\\0]/.test(value)) {
    throw new PathError(`invalid ${label}`);
  }
  if (value.split('/').some((piece) => piece === '' || piece === '.' || piece === '..')) throw new PathError(`invalid ${label}`);
  return value;
}

export function repoDirFor(workspaceRoot: string, owner: string, name: string): string {
  return join(resolve(workspaceRoot), ...assertOwner(owner).split('/'), assertSegment('repo', name));
}

export function jobDirFor(workspaceRoot: string, jobId: string): string {
  return join(resolve(workspaceRoot), '.jobs', assertSegment('jobId', jobId));
}

export function featureDirFor(repoDir: string, feature: string): string {
  return join(repoDir, '.nax', 'features', assertFeature(feature));
}

export function assertInside(root: string, candidate: string): string {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || resolve(candidate) === resolve(root)) {
    throw new PathError('path escapes its root');
  }
  return resolve(candidate);
}
```
(`assertInside` returns the resolved candidate; the spec compares with `join(root,'a','b')`, which equals the resolved path for an absolute root.)

- [ ] **Step 4: Write the test helpers** (used from 3a-2 Task 12 on)

`test/helpers/tmp.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function makeTempDirs(): { make(prefix: string): Promise<string>; cleanup(): Promise<void> } {
  const made: string[] = [];
  return {
    async make(prefix) {
      const dir = await mkdtemp(join(tmpdir(), `koda-runner-${prefix}-`));
      made.push(dir);
      return dir;
    },
    async cleanup() {
      await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    },
  };
}
```

`test/helpers/git-fixture.ts`:

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Real git in tests, isolated from the developer's global and system config. */
export function isolateGit(): void {
  process.env['GIT_CONFIG_GLOBAL'] = '/dev/null';
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  process.env['GIT_TERMINAL_PROMPT'] = '0';
  process.env['GIT_AUTHOR_NAME'] = 'Fixture';
  process.env['GIT_AUTHOR_EMAIL'] = 'fixture@koda.test';
  process.env['GIT_COMMITTER_NAME'] = 'Fixture';
  process.env['GIT_COMMITTER_EMAIL'] = 'fixture@koda.test';
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: { ...process.env, LC_ALL: 'C' } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed (${code}): ${err}`);
  return out.trim();
}

export interface Origin {
  /** Bare repository directory. */
  readonly dir: string;
  /** file:// URL of the bare repository (what a test passes as cloneUrl). */
  readonly url: string;
}

export interface OriginSpec {
  readonly files: Readonly<Record<string, string>>;
  /** Extra branches, each one commit on top of `main` with these files. */
  readonly branches?: ReadonlyArray<{ readonly name: string; readonly files: Readonly<Record<string, string>> }>;
  readonly tags?: readonly string[];
}

async function commitFiles(work: string, files: Readonly<Record<string, string>>, message: string): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), content);
  }
  await git(work, 'add', '-A');
  await git(work, 'commit', '-q', '-m', message);
}

/** Commits one file on `branch` of the origin from a throwaway clone and returns the new sha (advances origin from outside the runner's clone). */
export async function pushCommit(base: string, originUrl: string, branch: string, path: string, content: string): Promise<string> {
  const work = await mkdtemp(join(base, 'push-'));
  await git(work, 'clone', '-q', originUrl, '.');
  await git(work, 'checkout', '-q', '-B', branch, `origin/${branch}`).catch(() => git(work, 'checkout', '-q', '-b', branch));
  await mkdir(dirname(join(work, path)), { recursive: true });
  await writeFile(join(work, path), content);
  await git(work, 'add', '-A');
  await git(work, 'commit', '-q', '-m', `push ${path}`);
  await git(work, 'push', '-q', 'origin', branch);
  return git(work, 'rev-parse', 'HEAD');
}

/** A bare origin with `main` (the given files) plus optional branches and tags. */
export async function makeOrigin(base: string, name: string, spec: OriginSpec): Promise<Origin> {
  const dir = join(base, `${name}.git`);
  const work = join(base, `${name}-seed`);
  await mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q', '--bare', '-b', 'main');
  await mkdir(work, { recursive: true });
  await git(work, 'init', '-q', '-b', 'main');
  await git(work, 'remote', 'add', 'origin', dir);
  await commitFiles(work, spec.files, 'seed');
  await git(work, 'push', '-q', 'origin', 'main');
  for (const tag of spec.tags ?? []) {
    await git(work, 'tag', tag);
    await git(work, 'push', '-q', 'origin', tag);
  }
  for (const branch of spec.branches ?? []) {
    await git(work, 'checkout', '-q', '-b', branch.name, 'main');
    await commitFiles(work, branch.files, `on ${branch.name}`);
    await git(work, 'push', '-q', 'origin', branch.name);
    await git(work, 'checkout', '-q', 'main');
  }
  return { dir, url: `file://${dir}` };
}
```

- [ ] **Step 5: Run everything and lint**

```bash
cd apps/runner && bun test src && bun run type-check && bun run lint
```
Expected: all specs PASS; type check and lint clean.

- [ ] **Step 6: Commit**

```bash
git add apps/runner
git commit -m "feat(fleet): runner foundations (logger with redaction, time, safe path segments, git test fixtures)"
```

---

### Task 7: Config and identity

**Files:**
- Create: `apps/runner/src/config/runner-config.ts`, `apps/runner/src/config/runner-config.spec.ts`
- Create: `apps/runner/src/identity/identity-store.ts`, `apps/runner/src/identity/identity-store.spec.ts`

**Interfaces:**
- Consumes: Task 6 nothing (pure).
- Produces:
  ```ts
  // config/runner-config.ts
  export class ConfigError extends Error {}
  export interface StaticCapabilities {                       // runner.json "capabilities": RunnerCapabilities minus sandbox.probedAt
    readonly nax: { version: string; protocols: NaxProtocol[] };
    readonly sandbox: { available: boolean; error?: string };
    readonly profiles: Record<string, ProfileNeeds>;
    readonly credentials: RunnerCredential[];
    readonly tools: { git: boolean; gh: boolean; glab: boolean };
    readonly executors: RunnerExecutor[];
  }
  export interface RunnerConfig {
    readonly serverUrl: string;              // origin plus optional path prefix, no trailing slash
    readonly allowInsecureHttp: boolean;
    readonly workspaceRoot: string;          // absolute
    readonly labels: readonly string[];
    readonly naxCommand: readonly string[];  // default ['nax']
    readonly naxHome: string;                // default NAX_GLOBAL_CONFIG_DIR else ~/.nax
    readonly jobRetentionDays: number;       // default 7
    readonly capabilities: StaticCapabilities;
  }
  export interface RunnerHome { readonly dir: string; readonly configPath: string; readonly identityPath: string; readonly journalPath: string }
  export function resolveHome(env: NodeJS.ProcessEnv, override?: string): RunnerHome;
  export function isLoopbackHost(hostname: string): boolean;
  export function parseRunnerConfig(raw: unknown, env: NodeJS.ProcessEnv): RunnerConfig;
  export function loadRunnerConfig(path: string, env: NodeJS.ProcessEnv): Promise<RunnerConfig>;
  // identity/identity-store.ts
  export class IdentityError extends Error {}
  export interface RunnerIdentityFile { readonly runnerId: string; readonly apiKey: string; readonly serverUrl: string; readonly name: string; readonly enrolledAt: string }
  export function readIdentity(path: string): Promise<RunnerIdentityFile | null>;
  export function writeIdentity(path: string, identity: RunnerIdentityFile): Promise<void>;   // dir 0700, file 0600, tmp + rename
  export function newBootId(): string;
  ```

- [ ] **Step 1: Write the failing specs**

`config/runner-config.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, isLoopbackHost, parseRunnerConfig, resolveHome } from './runner-config';

const credential = { providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false };
const capabilities = {
  nax: { version: '0.83.0', protocols: ['native'] },
  sandbox: { available: true },
  profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: false } },
  credentials: [credential],
  tools: { git: true, gh: true, glab: false },
  executors: ['host'],
};
const base = { serverUrl: 'https://koda.example.com', workspaceRoot: '/srv/koda-runner/work', capabilities };
const parse = (over: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) => parseRunnerConfig({ ...base, ...over }, env);

describe('parseRunnerConfig', () => {
  test('applies the defaults', () => {
    const c = parse();
    expect(c).toMatchObject({
      serverUrl: 'https://koda.example.com', allowInsecureHttp: false, workspaceRoot: '/srv/koda-runner/work', labels: [],
      naxCommand: ['nax'], naxHome: join(homedir(), '.nax'), jobRetentionDays: 7,
    });
    expect(c.capabilities.tools.gh).toBe(true);
  });
  test('naxHome follows NAX_GLOBAL_CONFIG_DIR, and an explicit value wins', () => {
    expect(parse({}, { NAX_GLOBAL_CONFIG_DIR: '/opt/nax' }).naxHome).toBe('/opt/nax');
    expect(parse({ naxHome: '/x/nax' }, { NAX_GLOBAL_CONFIG_DIR: '/opt/nax' }).naxHome).toBe('/x/nax');
  });
  test('normalises the server url and keeps a path prefix', () => {
    expect(parse({ serverUrl: 'https://koda.example.com/' }).serverUrl).toBe('https://koda.example.com');
    expect(parse({ serverUrl: 'https://koda.example.com/koda/' }).serverUrl).toBe('https://koda.example.com/koda');
  });
  test('requires https unless loopback or explicitly allowed', () => {
    expect(() => parse({ serverUrl: 'http://koda.internal' })).toThrow(ConfigError);
    expect(parse({ serverUrl: 'http://koda.internal', allowInsecureHttp: true }).serverUrl).toBe('http://koda.internal');
    for (const url of ['http://localhost:3101', 'http://127.0.0.1:3101', 'http://[::1]:3101']) expect(parse({ serverUrl: url }).serverUrl).toBe(url);
  });
  test.each([
    ['not a url', { serverUrl: 'nope' }],
    ['a non-http scheme', { serverUrl: 'ftp://x.example.com' }],
    ['credentials in the url', { serverUrl: 'https://u:p@koda.example.com' }],
    ['a query string', { serverUrl: 'https://koda.example.com/?a=1' }],
    ['a relative workspaceRoot', { workspaceRoot: 'work' }],
    ['a label with capitals', { labels: ['Linux'] }],
    ['21 labels', { labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }],
    ['an empty naxCommand', { naxCommand: [] }],
    ['a non-string naxCommand entry', { naxCommand: ['nax', 1] }],
    ['retention 0', { jobRetentionDays: 0 }],
    ['retention 400', { jobRetentionDays: 400 }],
    ['a relative naxHome', { naxHome: 'nax' }],
    ['missing capabilities', { capabilities: undefined }],
    ['capabilities without protocols', { capabilities: { ...capabilities, nax: { version: '1', protocols: [] } } }],
    ['an unknown executor', { capabilities: { ...capabilities, executors: ['vm'] } }],
    ['tools not booleans', { capabilities: { ...capabilities, tools: { git: 'yes', gh: true, glab: false } } }],
    ['the pre-3a credential shape {providerId, kind}', { capabilities: { ...capabilities, credentials: [{ providerId: 'deepseek', kind: 'api-key' }] } }],
    ['a credential without stored', { capabilities: { ...capabilities, credentials: [{ providerId: 'deepseek', available: true, ambient: false }] } }],
    ['a credential with a key field', { capabilities: { ...capabilities, credentials: [{ ...credential, key: 'sk-1' }] } }],
    ['a string available flag', { capabilities: { ...capabilities, credentials: [{ ...credential, available: 'yes' }] } }],
    ['a stored kind of password', { capabilities: { ...capabilities, credentials: [{ ...credential, stored: { kind: 'password', expired: false } }] } }],
    ['an exec status of maybe', { capabilities: { ...capabilities, credentials: [{ ...credential, exec: 'maybe' }] } }],
    ['65 credentials', { capabilities: { ...capabilities, credentials: Array.from({ length: 65 }, (_, i) => ({ ...credential, providerId: `p${i}` })) } }],
    ['credentials that is not an array', { capabilities: { ...capabilities, credentials: {} } }],
  ])('rejects %s', (_label, over) => {
    expect(() => parse(over as Record<string, unknown>)).toThrow(ConfigError);
  });
  test('keeps a well-formed credentials block, including exec and an ambient-only entry', () => {
    const credentials = [
      { providerId: 'claude', available: true, stored: { kind: 'oauth', expires: '2026-10-01T00:00:00.000Z', expired: false }, exec: 'declined', ambient: true },
      { providerId: 'env-only', available: true, stored: null, ambient: true },
    ];
    expect(parse({ capabilities: { ...capabilities, credentials } }).capabilities.credentials).toEqual(credentials);
  });
  test('names the bad credential in the error, so the operator can find it in runner.json', () => {
    expect(() => parse({ capabilities: { ...capabilities, credentials: [credential, { providerId: 'x' }] } })).toThrow(/credentials\[1\]/);
  });
  test('rejects a non-object document', () => {
    expect(() => parseRunnerConfig('x', {})).toThrow(ConfigError);
  });
});

describe('isLoopbackHost', () => {
  test.each(['localhost', '127.0.0.1', '::1', '[::1]', '127.1.2.3'])('%s is loopback', (h) => expect(isLoopbackHost(h)).toBe(true));
  test.each(['example.com', '10.0.0.1', '0.0.0.0', 'localhost.evil.com'])('%s is not', (h) => expect(isLoopbackHost(h)).toBe(false));
});

describe('resolveHome', () => {
  test('override beats env beats the default', () => {
    expect(resolveHome({ KODA_RUNNER_HOME: '/a' }, '/b').dir).toBe('/b');
    expect(resolveHome({ KODA_RUNNER_HOME: '/a' }).dir).toBe('/a');
    expect(resolveHome({}).dir).toBe(join(homedir(), '.koda-runner'));
  });
  test('names the three files', () => {
    const h = resolveHome({}, '/h');
    expect([h.configPath, h.identityPath, h.journalPath]).toEqual(['/h/runner.json', '/h/identity.json', '/h/journal.db']);
  });
});
```

`identity/identity-store.spec.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { IdentityError, newBootId, readIdentity, writeIdentity } from './identity-store';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const identity = { runnerId: 'r1', apiKey: 'kr_abc', serverUrl: 'https://koda.example.com', name: 'box-1', enrolledAt: '2026-10-01T00:00:00.000Z' };

describe('identity store', () => {
  test('a missing file reads as null', async () => {
    expect(await readIdentity(join(await tmp.make('id'), 'identity.json'))).toBeNull();
  });
  test('round-trips, creating the directory 0700 and the file 0600', async () => {
    const path = join(await tmp.make('id'), 'sub', 'identity.json');
    await writeIdentity(path, identity);
    expect(await readIdentity(path)).toEqual(identity);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, '..'))).mode & 0o777).toBe(0o700);
  });
  test('a loose mode is tightened on read', async () => {
    const path = join(await tmp.make('id'), 'identity.json');
    await writeIdentity(path, identity);
    await Bun.$`chmod 644 ${path}`;
    await readIdentity(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  test.each(['{', '[]', '{"runnerId":"r"}', '{"runnerId":1,"apiKey":"k","serverUrl":"u","name":"n","enrolledAt":"t"}'])('rejects a damaged file %j', async (text) => {
    const path = join(await tmp.make('id'), 'identity.json');
    await writeFile(path, text);
    await expect(readIdentity(path)).rejects.toBeInstanceOf(IdentityError);
  });
  test('boot ids are distinct uuids', () => {
    expect(newBootId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(newBootId()).not.toBe(newBootId());
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/runner && bun test src/config src/identity`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`config/runner-config.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { NaxProtocol, ProfileNeeds, RunnerCredential, RunnerExecutor } from '@nathapp/fleet-protocol';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface StaticCapabilities {
  readonly nax: { version: string; protocols: NaxProtocol[] };
  readonly sandbox: { available: boolean; error?: string };
  readonly profiles: Record<string, ProfileNeeds>;
  readonly credentials: RunnerCredential[];
  readonly tools: { git: boolean; gh: boolean; glab: boolean };
  readonly executors: RunnerExecutor[];
}

export interface RunnerConfig {
  readonly serverUrl: string;
  readonly allowInsecureHttp: boolean;
  readonly workspaceRoot: string;
  readonly labels: readonly string[];
  readonly naxCommand: readonly string[];
  readonly naxHome: string;
  readonly jobRetentionDays: number;
  readonly capabilities: StaticCapabilities;
}

export interface RunnerHome {
  readonly dir: string;
  readonly configPath: string;
  readonly identityPath: string;
  readonly journalPath: string;
}

/** Same rule as the server's runner labels (apps/api/src/fleet/runners/dto/create-enrollment.dto.ts). */
const LABEL = /^[a-z0-9][a-z0-9._-]{0,31}$/;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function resolveHome(env: NodeJS.ProcessEnv, override?: string): RunnerHome {
  const dir = override ?? env['KODA_RUNNER_HOME'] ?? join(homedir(), '.koda-runner');
  return { dir, configPath: join(dir, 'runner.json'), identityPath: join(dir, 'identity.json'), journalPath: join(dir, 'journal.db') };
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

function parseServerUrl(value: unknown, allowInsecureHttp: boolean): string {
  if (typeof value !== 'string') throw new ConfigError('serverUrl must be a string');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError('serverUrl is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConfigError('serverUrl must be http or https');
  if (url.username || url.password) throw new ConfigError('serverUrl must not carry credentials');
  if (url.search || url.hash) throw new ConfigError('serverUrl must not carry a query or fragment');
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname) && !allowInsecureHttp) {
    throw new ConfigError('serverUrl must be https (loopback hosts, or allowInsecureHttp, may use http)');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const CREDENTIAL_KEYS = new Set(['providerId', 'available', 'stored', 'exec', 'ambient']);
const STORED_KEYS = new Set(['kind', 'expires', 'expired']);

/**
 * Local shape check of one `capabilities.credentials` entry against `RunnerCredential` (the server validator,
 * apps/api/src/fleet/common/capabilities.ts, rejects the whole report otherwise, and a bad block would then be
 * discovered only as a 400 on the first sync). `stored` is required: an object or null.
 */
function parseCredential(c: unknown, i: number): RunnerCredential {
  const where = `capabilities.credentials[${i}]`;
  if (!isObj(c) || typeof c.providerId !== 'string' || c.providerId === '' || typeof c.available !== 'boolean' || typeof c.ambient !== 'boolean') {
    throw new ConfigError(`${where} needs providerId, available and ambient`);
  }
  if (Object.keys(c).some((k) => !CREDENTIAL_KEYS.has(k))) throw new ConfigError(`${where} has unexpected fields (never put a key or token in runner.json)`);
  if (c.exec !== undefined && c.exec !== 'served' && c.exec !== 'declined' && c.exec !== 'error') throw new ConfigError(`${where}.exec must be served, declined or error`);
  const stored = c.stored;
  if (stored !== null) {
    if (!isObj(stored) || (stored.kind !== 'api-key' && stored.kind !== 'oauth') || typeof stored.expired !== 'boolean' ||
      (stored.expires !== undefined && (typeof stored.expires !== 'string' || Number.isNaN(Date.parse(stored.expires)))) ||
      Object.keys(stored).some((k) => !STORED_KEYS.has(k))) {
      throw new ConfigError(`${where}.stored must be null or { kind: "api-key"|"oauth", expires?, expired }`);
    }
  }
  return {
    providerId: c.providerId,
    available: c.available,
    stored: stored === null ? null : { kind: (stored as Obj).kind as 'api-key' | 'oauth', ...((stored as Obj).expires !== undefined ? { expires: (stored as Obj).expires as string } : {}), expired: (stored as Obj).expired as boolean },
    ...(c.exec !== undefined ? { exec: c.exec as NonNullable<RunnerCredential['exec']> } : {}),
    ambient: c.ambient,
  };
}

function parseCredentials(value: unknown): RunnerCredential[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError('capabilities.credentials must be an array');
  if (value.length > 64) throw new ConfigError('capabilities.credentials has at most 64 entries');
  return value.map(parseCredential);
}

function parseCapabilities(value: unknown): StaticCapabilities {
  if (!isObj(value)) throw new ConfigError('capabilities is required');
  const { nax, sandbox, profiles, credentials, tools, executors } = value;
  if (!isObj(nax) || typeof nax.version !== 'string' || nax.version === '' || !Array.isArray(nax.protocols) || nax.protocols.length === 0 ||
    !nax.protocols.every((p) => p === 'native' || p === 'acp')) throw new ConfigError('capabilities.nax needs a version and at least one protocol');
  if (!isObj(sandbox) || typeof sandbox.available !== 'boolean') throw new ConfigError('capabilities.sandbox.available must be a boolean');
  if (!isObj(tools) || typeof tools.git !== 'boolean' || typeof tools.gh !== 'boolean' || typeof tools.glab !== 'boolean') {
    throw new ConfigError('capabilities.tools needs git, gh and glab booleans');
  }
  if (!Array.isArray(executors) || executors.length === 0 || !executors.every((e) => e === 'host')) throw new ConfigError('capabilities.executors must be ["host"]');
  if (profiles !== undefined && !isObj(profiles)) throw new ConfigError('capabilities.profiles must be an object');
  return {
    nax: { version: nax.version, protocols: [...(nax.protocols as NaxProtocol[])] },
    sandbox: { available: sandbox.available, ...(typeof sandbox.error === 'string' ? { error: sandbox.error } : {}) },
    profiles: { ...((profiles as Record<string, ProfileNeeds> | undefined) ?? {}) },
    credentials: parseCredentials(credentials),
    tools: { git: tools.git, gh: tools.gh, glab: tools.glab },
    executors: ['host'],
  };
}

export function parseRunnerConfig(raw: unknown, env: NodeJS.ProcessEnv): RunnerConfig {
  if (!isObj(raw)) throw new ConfigError('runner.json must be a JSON object');
  const allowInsecureHttp = raw.allowInsecureHttp === true;
  if (typeof raw.workspaceRoot !== 'string' || !isAbsolute(raw.workspaceRoot)) throw new ConfigError('workspaceRoot must be an absolute path');
  const labels = raw.labels ?? [];
  if (!Array.isArray(labels) || labels.length > 20 || !labels.every((l) => typeof l === 'string' && LABEL.test(l))) {
    throw new ConfigError('labels must be at most 20 lowercase labels');
  }
  const naxCommand = raw.naxCommand ?? ['nax'];
  if (!Array.isArray(naxCommand) || naxCommand.length === 0 || naxCommand.length > 8 || !naxCommand.every((c) => typeof c === 'string' && c.length > 0)) {
    throw new ConfigError('naxCommand must be 1-8 non-empty strings');
  }
  const naxHome = raw.naxHome ?? env['NAX_GLOBAL_CONFIG_DIR'] ?? join(homedir(), '.nax');
  if (typeof naxHome !== 'string' || !isAbsolute(naxHome)) throw new ConfigError('naxHome must be an absolute path');
  const retention = raw.jobRetentionDays ?? 7;
  if (!Number.isInteger(retention) || (retention as number) < 1 || (retention as number) > 365) throw new ConfigError('jobRetentionDays must be 1-365');
  return {
    serverUrl: parseServerUrl(raw.serverUrl, allowInsecureHttp),
    allowInsecureHttp,
    workspaceRoot: raw.workspaceRoot,
    labels: [...(labels as string[])],
    naxCommand: [...(naxCommand as string[])],
    naxHome,
    jobRetentionDays: retention as number,
    capabilities: parseCapabilities(raw.capabilities),
  };
}

export async function loadRunnerConfig(path: string, env: NodeJS.ProcessEnv): Promise<RunnerConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new ConfigError(`cannot read ${path}; run "koda-runner enroll" first`);
  }
  try {
    return parseRunnerConfig(JSON.parse(text), env);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`${path} is not valid JSON`);
  }
}
```

`identity/identity-store.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

export interface RunnerIdentityFile {
  readonly runnerId: string;
  readonly apiKey: string;
  readonly serverUrl: string;
  readonly name: string;
  readonly enrolledAt: string;
}

const FIELDS = ['runnerId', 'apiKey', 'serverUrl', 'name', 'enrolledAt'] as const;

export async function readIdentity(path: string): Promise<RunnerIdentityFile | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new IdentityError(`${path} is not valid JSON`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || FIELDS.some((f) => typeof record[f] !== 'string' || record[f] === '')) {
    throw new IdentityError(`${path} is not a runner identity`);
  }
  await chmod(path, 0o600).catch(() => undefined);
  return { runnerId: record['runnerId'] as string, apiKey: record['apiKey'] as string, serverUrl: record['serverUrl'] as string, name: record['name'] as string, enrolledAt: record['enrolledAt'] as string };
}

export async function writeIdentity(path: string, identity: RunnerIdentityFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => undefined);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export function newBootId(): string {
  return randomUUID();
}
```
(`writeIdentity` chmods the parent to 0700 only when it created it; a pre-existing shared directory is tightened too, which is intended for `~/.koda-runner`. The spec test creates `sub/` fresh.)

- [ ] **Step 4: Run and lint**

```bash
cd apps/runner && bun test src/config src/identity && bun run type-check && bun run lint
```
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/runner
git commit -m "feat(fleet): runner config (https rule, defaults) and identity store (0600)"
```

---

### Task 8: Journal (bun:sqlite, WAL)

**Files:**
- Create: `apps/runner/src/journal/schema.ts`, `types.ts`, `journal.ts`, `journal.spec.ts`

**Interfaces:**
- Consumes: `Now` (Task 6), protocol types.
- Produces:
  ```ts
  // types.ts
  export interface JobRow {
    readonly jobId: string; readonly leaseEpoch: number; readonly command: FleetJobKindName; readonly state: FleetJobStateName;
    readonly repoKey: string; readonly branch: string | null; readonly pid: number | null; readonly pgid: number | null;
    readonly naxRunId: string | null; readonly logPath: string | null; readonly jobDir: string; readonly assign: AssignPayload;
    readonly cancelRequestedAt: string | null; readonly resultBranch: string | null; readonly resultSha: string | null;
    readonly createdAt: string; readonly updatedAt: string; readonly doneAt: string | null;
  }
  export interface NewJob { readonly assign: AssignPayload; readonly leaseEpoch: number; readonly repoKey: string; readonly jobDir: string }
  export type JobPatch = Partial<Pick<JobRow, 'state' | 'branch' | 'pid' | 'pgid' | 'naxRunId' | 'logPath' | 'cancelRequestedAt' | 'resultBranch' | 'resultSha'>>;
  export interface EventRow { readonly jobId: string; readonly leaseEpoch: number; readonly seq: number; readonly type: RunnerEventType; readonly payload: RunnerEvent['payload']; readonly createdAt: string; readonly acked: boolean }
  export interface CommandRecord { readonly commandId: string; readonly jobId: string; readonly leaseEpoch: number; readonly type: string; readonly result: 'ok' | 'rejected'; readonly detail: string | null; readonly appliedAt: string }
  // journal.ts
  export class Journal {
    static open(path: string, now?: Now): Journal;          // ':memory:' allowed
    close(): void;
    onWrite(listener: () => void): () => void;              // fired after an event is appended or replaced AND its outermost transaction committed (D55); returns unsubscribe
    tx<T>(fn: () => T): T;                                  // one sqlite transaction
    getMeta(key: string): string | null;  setMeta(key: string, value: string): void;
    insertJob(job: NewJob): { row: JobRow; created: boolean };   // idempotent on (jobId, leaseEpoch)
    getJob(jobId: string, leaseEpoch: number): JobRow | null;
    jobsById(jobId: string): JobRow[];
    activeJobs(): JobRow[];  activeCount(): number;         // done_at IS NULL
    updateJob(jobId: string, leaseEpoch: number, patch: JobPatch): JobRow | null;
    markDone(jobId: string, leaseEpoch: number): void;
    appendEvent(jobId: string, leaseEpoch: number, type: RunnerEventType, payload: RunnerEvent['payload'], patch?: JobPatch): number | null;  // seq, or null when the job row is gone; patch applies in the same transaction
    pendingEvents(jobId: string, leaseEpoch: number, limit: number): EventRow[];
    jobsWithPending(): Array<{ jobId: string; leaseEpoch: number }>;
    ackThrough(jobId: string, leaseEpoch: number, ackedSeq: number): void;
    replaceEvent(jobId: string, leaseEpoch: number, seq: number, type: RunnerEventType, payload: RunnerEvent['payload']): void;
    recordCommand(record: CommandRecord): boolean;  getCommand(commandId: string): CommandRecord | null;
    abandon(jobId: string, leaseEpoch: number): void;      // drops that epoch's job + event rows, keeps applied_commands
    prune(retentionDays: number): Array<{ jobId: string; leaseEpoch: number; jobDir: string }>;
    stats(): { activeJobs: number; pendingEvents: number };
  }
  ```

- [ ] **Step 1: Write the failing spec**

`journal/journal.spec.ts`:

```ts
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { AssignPayload } from '@nathapp/fleet-protocol';
import { makeTempDirs } from '../../test/helpers/tmp';
import { Journal } from './journal';

const assign = (jobId = 'j1'): AssignPayload => ({
  jobId, command: 'RUN', repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'https://github.com/acme/app.git' },
  ref: 'main', feature: 'feat', planFrom: null, profiles: [], maxCostUsd: '5', bashMode: 'raw', gitIdentity: { name: 'bot', email: 'bot@x' },
});
const job = (jobId = 'j1', leaseEpoch = 1) => ({ assign: assign(jobId), leaseEpoch, repoKey: 'acme/app', jobDir: `/w/.jobs/${jobId}` });

let clock = new Date('2026-10-01T00:00:00.000Z');
const now = () => clock;
let j: Journal;
beforeEach(() => {
  clock = new Date('2026-10-01T00:00:00.000Z');
  j = Journal.open(':memory:', now);
});
const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

describe('jobs', () => {
  test('insertJob is idempotent and starts ASSIGNED and active', () => {
    const first = j.insertJob(job());
    expect(first.created).toBe(true);
    expect(first.row).toMatchObject({ jobId: 'j1', leaseEpoch: 1, state: 'ASSIGNED', pid: null, doneAt: null, assign: assign() });
    const again = j.insertJob(job());
    expect(again.created).toBe(false);
    expect(j.activeCount()).toBe(1);
  });
  test('epochs of one job are separate rows', () => {
    j.insertJob(job('j1', 1));
    j.insertJob(job('j1', 2));
    expect(j.jobsById('j1').map((r) => r.leaseEpoch)).toEqual([1, 2]);
  });
  test('updateJob patches only the named columns and stamps updatedAt', () => {
    j.insertJob(job());
    clock = new Date('2026-10-01T00:05:00.000Z');
    const row = j.updateJob('j1', 1, { state: 'RUNNING', pid: 42, pgid: 42, naxRunId: 'run-1', cancelRequestedAt: '2026-10-01T00:04:00.000Z' });
    expect(row).toMatchObject({ state: 'RUNNING', pid: 42, pgid: 42, naxRunId: 'run-1', branch: null, updatedAt: '2026-10-01T00:05:00.000Z' });
    expect(j.updateJob('nope', 1, { pid: 1 })).toBeNull();
  });
  test('markDone removes the job from the active set', () => {
    j.insertJob(job());
    j.markDone('j1', 1);
    expect(j.activeCount()).toBe(0);
    expect(j.getJob('j1', 1)?.doneAt).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('events', () => {
  test('seq is per (job, epoch), contiguous from 1', () => {
    j.insertJob(job('a', 1));
    j.insertJob(job('b', 1));
    expect([1, 2, 3].map(() => j.appendEvent('a', 1, 'log', { stream: 'run', text: 'x' }))).toEqual([1, 2, 3]);
    expect(j.appendEvent('b', 1, 'lifecycle', { level: 'info', message: 'm' })).toBe(1);
  });
  test('an event for a job that is gone is refused, not orphaned', () => {
    expect(j.appendEvent('ghost', 1, 'log', { stream: 'run', text: 'x' })).toBeNull();
    expect(j.stats().pendingEvents).toBe(0);
  });
  test('a patch lands in the same transaction as the event', () => {
    j.insertJob(job());
    j.appendEvent('j1', 1, 'state', { to: 'RUNNING' }, { state: 'RUNNING', pid: 7, pgid: 7 });
    expect(j.getJob('j1', 1)).toMatchObject({ state: 'RUNNING', pid: 7 });
  });
  test('pending events come back in order and ackThrough marks a prefix only', () => {
    j.insertJob(job());
    for (let i = 0; i < 5; i += 1) j.appendEvent('j1', 1, 'log', { stream: 'run', text: `l${i}` });
    expect(j.pendingEvents('j1', 1, 3).map((e) => e.seq)).toEqual([1, 2, 3]);
    j.ackThrough('j1', 1, 2);
    expect(j.pendingEvents('j1', 1, 10).map((e) => e.seq)).toEqual([3, 4, 5]);
    j.ackThrough('j1', 1, 1); // the cursor never moves back
    expect(j.pendingEvents('j1', 1, 10).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(j.jobsWithPending()).toEqual([{ jobId: 'j1', leaseEpoch: 1 }]);
    j.ackThrough('j1', 1, 5);
    expect(j.jobsWithPending()).toEqual([]);
  });
  test('the next seq continues after acked rows', () => {
    j.insertJob(job());
    j.appendEvent('j1', 1, 'log', { stream: 'run', text: 'a' });
    j.ackThrough('j1', 1, 1);
    expect(j.appendEvent('j1', 1, 'log', { stream: 'run', text: 'b' })).toBe(2);
  });
  test('replaceEvent keeps the seq and swaps type and payload (D24)', () => {
    j.insertJob(job());
    j.appendEvent('j1', 1, 'snapshot', { costSpentUsd: '1.0000' });
    j.replaceEvent('j1', 1, 1, 'lifecycle', { level: 'error', message: 'dropped' });
    expect(j.pendingEvents('j1', 1, 5)).toMatchObject([{ seq: 1, type: 'lifecycle', payload: { level: 'error', message: 'dropped' } }]);
  });
  test('onWrite fires only after the outermost transaction commits, once, and never for a rollback (D55)', () => {
    j.insertJob(job());
    const seen: number[] = [];
    j.onWrite(() => { seen.push(j.pendingEvents('j1', 1, 10).length); });
    j.tx(() => {
      j.appendEvent('j1', 1, 'log', { stream: 'run', text: 'a' });
      j.appendEvent('j1', 1, 'log', { stream: 'run', text: 'b' });
      expect(seen).toEqual([]); // nothing announced while the transaction is open
    });
    expect(seen).toEqual([2]); // one wake-up, and the listener already sees both committed rows
    expect(() => j.tx(() => {
      j.appendEvent('j1', 1, 'log', { stream: 'run', text: 'c' });
      throw new Error('boom');
    })).toThrow('boom');
    expect(seen).toEqual([2]);
    expect(j.pendingEvents('j1', 1, 10)).toHaveLength(2);
  });
  test('onWrite fires for append and replace, and stops after unsubscribe', () => {
    j.insertJob(job());
    let n = 0;
    const off = j.onWrite(() => { n += 1; });
    j.appendEvent('j1', 1, 'log', { stream: 'run', text: 'x' });
    j.replaceEvent('j1', 1, 1, 'lifecycle', { level: 'info', message: 'y' });
    expect(n).toBe(2);
    off();
    j.appendEvent('j1', 1, 'log', { stream: 'run', text: 'z' });
    expect(n).toBe(2);
  });
});

describe('commands and abandon', () => {
  const rec = (commandId: string, result: 'ok' | 'rejected' = 'ok') => ({ commandId, jobId: 'j1', leaseEpoch: 1, type: 'ASSIGN', result, detail: result === 'ok' ? null : 'why', appliedAt: clock.toISOString() });
  test('recordCommand is first-write-wins and replays the stored result', () => {
    expect(j.recordCommand(rec('c1'))).toBe(true);
    expect(j.recordCommand(rec('c1', 'rejected'))).toBe(false);
    expect(j.getCommand('c1')).toMatchObject({ result: 'ok', detail: null });
    expect(j.getCommand('nope')).toBeNull();
  });
  test('abandon drops that epoch only and keeps the applied-command row', () => {
    j.insertJob(job('j1', 1));
    j.insertJob(job('j1', 2));
    j.appendEvent('j1', 1, 'log', { stream: 'run', text: 'x' });
    j.appendEvent('j1', 2, 'log', { stream: 'run', text: 'y' });
    j.recordCommand(rec('c1'));
    j.abandon('j1', 1);
    expect(j.getJob('j1', 1)).toBeNull();
    expect(j.getJob('j1', 2)).not.toBeNull();
    expect(j.pendingEvents('j1', 1, 5)).toEqual([]);
    expect(j.pendingEvents('j1', 2, 5)).toHaveLength(1);
    expect(j.getCommand('c1')).not.toBeNull();
  });
});

describe('persistence and retention', () => {
  test('rows survive a reopen of the file (persist before send)', async () => {
    const path = join(await tmp.make('journal'), 'journal.db');
    const a = Journal.open(path, now);
    a.insertJob(job());
    a.appendEvent('j1', 1, 'log', { stream: 'run', text: 'kept' });
    a.setMeta('boot_id', 'b1');
    a.close();
    const b = Journal.open(path, now);
    expect(b.pendingEvents('j1', 1, 5)).toMatchObject([{ seq: 1, payload: { text: 'kept' } }]);
    expect(b.getMeta('boot_id')).toBe('b1');
    expect(b.getMeta('missing')).toBeNull();
    b.close();
  });
  test('prune uses done_at (journal state), not file times, and returns the job dirs to delete', () => {
    j.insertJob(job('old', 1));
    j.insertJob(job('fresh', 1));
    j.insertJob(job('running', 1));
    j.appendEvent('old', 1, 'log', { stream: 'run', text: 'x' });
    j.markDone('old', 1);
    clock = new Date('2026-10-05T00:00:00.000Z');
    j.markDone('fresh', 1);
    clock = new Date('2026-10-09T00:00:00.000Z'); // old is 8 days done, fresh 4
    expect(j.prune(7)).toEqual([{ jobId: 'old', leaseEpoch: 1, jobDir: '/w/.jobs/old' }]);
    expect(j.getJob('old', 1)).toBeNull();
    expect(j.pendingEvents('old', 1, 5)).toEqual([]);
    expect(j.getJob('fresh', 1)).not.toBeNull();
    expect(j.getJob('running', 1)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/runner && bun test src/journal`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`journal/schema.ts`:

```ts
/** Slice 3 design §1.4 plus D23 (cancel_requested_at, result_branch, result_sha, applied_commands.detail). */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL,
  command TEXT NOT NULL,
  state TEXT NOT NULL,
  repo_key TEXT NOT NULL,
  branch TEXT,
  pid INTEGER,
  pgid INTEGER,
  nax_run_id TEXT,
  log_path TEXT,
  job_dir TEXT NOT NULL,
  assign_json TEXT NOT NULL,
  cancel_requested_at TEXT,
  result_branch TEXT,
  result_sha TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT,
  PRIMARY KEY (job_id, lease_epoch)
);
CREATE TABLE IF NOT EXISTS events (
  job_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, lease_epoch, seq)
);
CREATE INDEX IF NOT EXISTS events_pending ON events (acked, job_id, lease_epoch, seq);
CREATE TABLE IF NOT EXISTS applied_commands (
  command_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL,
  type TEXT NOT NULL,
  result TEXT NOT NULL,
  detail TEXT,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
```

`journal/types.ts`:

```ts
import type { AssignPayload, FleetJobKindName, FleetJobStateName, RunnerEvent, RunnerEventType } from '@nathapp/fleet-protocol';

export interface JobRow {
  readonly jobId: string;
  readonly leaseEpoch: number;
  readonly command: FleetJobKindName;
  readonly state: FleetJobStateName;
  readonly repoKey: string;
  readonly branch: string | null;
  readonly pid: number | null;
  readonly pgid: number | null;
  readonly naxRunId: string | null;
  readonly logPath: string | null;
  readonly jobDir: string;
  readonly assign: AssignPayload;
  readonly cancelRequestedAt: string | null;
  readonly resultBranch: string | null;
  readonly resultSha: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly doneAt: string | null;
}

export interface NewJob {
  readonly assign: AssignPayload;
  readonly leaseEpoch: number;
  readonly repoKey: string;
  readonly jobDir: string;
}

export type JobPatch = Partial<Pick<JobRow, 'state' | 'branch' | 'pid' | 'pgid' | 'naxRunId' | 'logPath' | 'cancelRequestedAt' | 'resultBranch' | 'resultSha'>>;

export interface EventRow {
  readonly jobId: string;
  readonly leaseEpoch: number;
  readonly seq: number;
  readonly type: RunnerEventType;
  readonly payload: RunnerEvent['payload'];
  readonly createdAt: string;
  readonly acked: boolean;
}

export interface CommandRecord {
  readonly commandId: string;
  readonly jobId: string;
  readonly leaseEpoch: number;
  readonly type: string;
  readonly result: 'ok' | 'rejected';
  readonly detail: string | null;
  readonly appliedAt: string;
}
```

`journal/journal.ts`:

```ts
import { Database } from 'bun:sqlite';
import type { RunnerEvent, RunnerEventType } from '@nathapp/fleet-protocol';
import { systemNow, type Now } from '../time';
import { SCHEMA_SQL } from './schema';
import type { CommandRecord, EventRow, JobPatch, JobRow, NewJob } from './types';

type Row = Record<string, unknown>;

const PATCH_COLUMNS: Readonly<Record<keyof JobPatch, string>> = {
  state: 'state', branch: 'branch', pid: 'pid', pgid: 'pgid', naxRunId: 'nax_run_id', logPath: 'log_path',
  cancelRequestedAt: 'cancel_requested_at', resultBranch: 'result_branch', resultSha: 'result_sha',
};

const toJob = (r: Row): JobRow => ({
  jobId: r['job_id'] as string, leaseEpoch: r['lease_epoch'] as number, command: r['command'] as JobRow['command'], state: r['state'] as JobRow['state'],
  repoKey: r['repo_key'] as string, branch: r['branch'] as string | null, pid: r['pid'] as number | null, pgid: r['pgid'] as number | null,
  naxRunId: r['nax_run_id'] as string | null, logPath: r['log_path'] as string | null, jobDir: r['job_dir'] as string,
  assign: JSON.parse(r['assign_json'] as string), cancelRequestedAt: r['cancel_requested_at'] as string | null,
  resultBranch: r['result_branch'] as string | null, resultSha: r['result_sha'] as string | null,
  createdAt: r['created_at'] as string, updatedAt: r['updated_at'] as string, doneAt: r['done_at'] as string | null,
});

const toEvent = (r: Row): EventRow => ({
  jobId: r['job_id'] as string, leaseEpoch: r['lease_epoch'] as number, seq: r['seq'] as number, type: r['type'] as RunnerEventType,
  payload: JSON.parse(r['payload_json'] as string), createdAt: r['created_at'] as string, acked: r['acked'] === 1,
});

const toCommand = (r: Row): CommandRecord => ({
  commandId: r['command_id'] as string, jobId: r['job_id'] as string, leaseEpoch: r['lease_epoch'] as number, type: r['type'] as string,
  result: r['result'] as CommandRecord['result'], detail: r['detail'] as string | null, appliedAt: r['applied_at'] as string,
});

/** Persist-before-send store (slice 3 design §1.4). Every write commits before the caller reports it. */
export class Journal {
  private readonly listeners = new Set<() => void>();
  private txDepth = 0;
  private dirty = false;

  private constructor(private readonly db: Database, private readonly now: Now) {}

  static open(path: string, now: Now = systemNow): Journal {
    const db = new Database(path, { create: true });
    // FULL, not NORMAL (D55): under WAL, NORMAL can lose the last committed transactions on power loss. A lost
    // *reported* event would be re-issued after restart under the same seq with different content, and the server
    // would keep the first one (its ack is the highest contiguous stored seq).
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    db.exec(SCHEMA_SQL);
    return new Journal(db, now);
  }

  close(): void {
    this.db.close();
  }

  onWrite(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** One sqlite transaction; nested calls join it. Listeners are told once, after the outermost commit (D55). */
  tx<T>(fn: () => T): T {
    this.txDepth += 1;
    let result: T;
    try {
      result = this.db.transaction(fn)();
    } catch (error) {
      if (this.txDepth === 1) this.dirty = false; // the outermost transaction rolled back: nothing was written
      throw error;
    } finally {
      this.txDepth -= 1;
    }
    if (this.txDepth === 0 && this.dirty) {
      this.dirty = false;
      this.notify();
    }
    return result;
  }

  /** Marks an event write; announces it now when no transaction is open, else at the outermost commit. */
  private wrote(): void {
    this.dirty = true;
    if (this.txDepth === 0) {
      this.dirty = false;
      this.notify();
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.query('SELECT value FROM meta WHERE key = ?').get(key) as Row | null;
    return row ? (row['value'] as string) : null;
  }

  setMeta(key: string, value: string): void {
    this.db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  insertJob(job: NewJob): { row: JobRow; created: boolean } {
    const stamp = this.now().toISOString();
    const result = this.db.query(
      `INSERT OR IGNORE INTO jobs (job_id, lease_epoch, command, state, repo_key, job_dir, assign_json, created_at, updated_at)
       VALUES (?, ?, ?, 'ASSIGNED', ?, ?, ?, ?, ?)`,
    ).run(job.assign.jobId, job.leaseEpoch, job.assign.command, job.repoKey, job.jobDir, JSON.stringify(job.assign), stamp, stamp);
    const row = this.getJob(job.assign.jobId, job.leaseEpoch);
    if (!row) throw new Error('journal: inserted job row not found');
    return { row, created: result.changes > 0 };
  }

  getJob(jobId: string, leaseEpoch: number): JobRow | null {
    const row = this.db.query('SELECT * FROM jobs WHERE job_id = ? AND lease_epoch = ?').get(jobId, leaseEpoch) as Row | null;
    return row ? toJob(row) : null;
  }

  jobsById(jobId: string): JobRow[] {
    return (this.db.query('SELECT * FROM jobs WHERE job_id = ? ORDER BY lease_epoch').all(jobId) as Row[]).map(toJob);
  }

  activeJobs(): JobRow[] {
    return (this.db.query('SELECT * FROM jobs WHERE done_at IS NULL ORDER BY created_at, job_id').all() as Row[]).map(toJob);
  }

  activeCount(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM jobs WHERE done_at IS NULL').get() as Row)['n'] as number;
  }

  updateJob(jobId: string, leaseEpoch: number, patch: JobPatch): JobRow | null {
    const keys = (Object.keys(patch) as Array<keyof JobPatch>).filter((k) => k in PATCH_COLUMNS);
    const sets = [...keys.map((k) => `${PATCH_COLUMNS[k]} = ?`), 'updated_at = ?'];
    const values = [...keys.map((k) => patch[k] ?? null), this.now().toISOString()];
    this.db.query(`UPDATE jobs SET ${sets.join(', ')} WHERE job_id = ? AND lease_epoch = ?`).run(...values, jobId, leaseEpoch);
    return this.getJob(jobId, leaseEpoch);
  }

  markDone(jobId: string, leaseEpoch: number): void {
    const stamp = this.now().toISOString();
    this.db.query('UPDATE jobs SET done_at = COALESCE(done_at, ?), updated_at = ? WHERE job_id = ? AND lease_epoch = ?').run(stamp, stamp, jobId, leaseEpoch);
  }

  appendEvent(jobId: string, leaseEpoch: number, type: RunnerEventType, payload: RunnerEvent['payload'], patch?: JobPatch): number | null {
    return this.tx(() => {
      if (!this.getJob(jobId, leaseEpoch)) return null;
      const next = ((this.db.query('SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE job_id = ? AND lease_epoch = ?').get(jobId, leaseEpoch) as Row)['m'] as number) + 1;
      this.db.query('INSERT INTO events (job_id, lease_epoch, seq, type, payload_json, created_at, acked) VALUES (?, ?, ?, ?, ?, ?, 0)')
        .run(jobId, leaseEpoch, next, type, JSON.stringify(payload), this.now().toISOString());
      if (patch) this.updateJob(jobId, leaseEpoch, patch);
      this.wrote();
      return next;
    });
  }

  pendingEvents(jobId: string, leaseEpoch: number, limit: number): EventRow[] {
    return (this.db.query('SELECT * FROM events WHERE job_id = ? AND lease_epoch = ? AND acked = 0 ORDER BY seq LIMIT ?').all(jobId, leaseEpoch, limit) as Row[]).map(toEvent);
  }

  jobsWithPending(): Array<{ jobId: string; leaseEpoch: number }> {
    const rows = this.db.query('SELECT job_id, lease_epoch FROM events WHERE acked = 0 GROUP BY job_id, lease_epoch ORDER BY MIN(created_at), job_id').all() as Row[];
    return rows.map((r) => ({ jobId: r['job_id'] as string, leaseEpoch: r['lease_epoch'] as number }));
  }

  ackThrough(jobId: string, leaseEpoch: number, ackedSeq: number): void {
    this.db.query('UPDATE events SET acked = 1 WHERE job_id = ? AND lease_epoch = ? AND seq <= ?').run(jobId, leaseEpoch, ackedSeq);
  }

  replaceEvent(jobId: string, leaseEpoch: number, seq: number, type: RunnerEventType, payload: RunnerEvent['payload']): void {
    this.db.query('UPDATE events SET type = ?, payload_json = ? WHERE job_id = ? AND lease_epoch = ? AND seq = ? AND acked = 0')
      .run(type, JSON.stringify(payload), jobId, leaseEpoch, seq);
    this.wrote();
  }

  recordCommand(record: CommandRecord): boolean {
    const result = this.db.query(
      'INSERT OR IGNORE INTO applied_commands (command_id, job_id, lease_epoch, type, result, detail, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(record.commandId, record.jobId, record.leaseEpoch, record.type, record.result, record.detail, record.appliedAt);
    return result.changes > 0;
  }

  getCommand(commandId: string): CommandRecord | null {
    const row = this.db.query('SELECT * FROM applied_commands WHERE command_id = ?').get(commandId) as Row | null;
    return row ? toCommand(row) : null;
  }

  abandon(jobId: string, leaseEpoch: number): void {
    this.tx(() => {
      this.db.query('DELETE FROM events WHERE job_id = ? AND lease_epoch = ?').run(jobId, leaseEpoch);
      this.db.query('DELETE FROM jobs WHERE job_id = ? AND lease_epoch = ?').run(jobId, leaseEpoch);
    });
  }

  prune(retentionDays: number): Array<{ jobId: string; leaseEpoch: number; jobDir: string }> {
    const cutoff = new Date(this.now().getTime() - retentionDays * 86_400_000).toISOString();
    return this.tx(() => {
      const old = this.db.query('SELECT job_id, lease_epoch, job_dir FROM jobs WHERE done_at IS NOT NULL AND done_at < ?').all(cutoff) as Row[];
      for (const r of old) {
        const key: [string, number] = [r['job_id'] as string, r['lease_epoch'] as number];
        this.db.query('DELETE FROM events WHERE job_id = ? AND lease_epoch = ?').run(...key);
        this.db.query('DELETE FROM jobs WHERE job_id = ? AND lease_epoch = ?').run(...key);
      }
      this.db.query('DELETE FROM applied_commands WHERE applied_at < ?').run(cutoff);
      return old.map((r) => ({ jobId: r['job_id'] as string, leaseEpoch: r['lease_epoch'] as number, jobDir: r['job_dir'] as string }));
    });
  }

  stats(): { activeJobs: number; pendingEvents: number } {
    return {
      activeJobs: this.activeCount(),
      pendingEvents: (this.db.query('SELECT COUNT(*) AS n FROM events WHERE acked = 0').get() as Row)['n'] as number,
    };
  }
}
```
(`this.db.transaction(fn)()` in Bun's sqlite returns a callable and nests through savepoints, so a caller may wrap several `appendEvent` calls in one `tx`; `appendEvent` itself calls `updateJob`, which opens no transaction. `insertJob` result `changes` is `0` for the ignored duplicate. The `dirty` flag is deliberately not reset by an inner failure that the outer caller catches: a committed outer transaction with at least one event write still announces once.)

- [ ] **Step 4: Run and lint**

```bash
cd apps/runner && bun test src/journal && bun run type-check && bun run lint
```
Expected: PASS (16 tests), clean.

- [ ] **Step 5: Commit**

```bash
git add apps/runner
git commit -m "feat(fleet): runner journal (persist-before-send sqlite, contiguous ack cursor, retention)"
```

---

### Task 9: Server client, backoff and batch building

**Files:**
- Create: `apps/runner/src/sync/http.ts`, `http.spec.ts`
- Create: `apps/runner/src/sync/backoff.ts`, `backoff.spec.ts`
- Create: `apps/runner/src/sync/batch.ts`, `batch.spec.ts`

**Interfaces:**
- Consumes: `Journal` (Task 8), `errorMessage` (Task 6), protocol types.
- Produces:
  ```ts
  // http.ts
  export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
  export class ServerError extends Error { readonly status: number; readonly body: unknown }
  export class NetworkError extends Error {}
  export interface ServerClientOptions { readonly serverUrl: string; readonly apiKey?: string; readonly fetchFn?: FetchFn; readonly syncTimeoutMs?: number; readonly requestTimeoutMs?: number }
  export class ServerClient {
    constructor(options: ServerClientOptions);
    enroll(body: EnrollRequest): Promise<EnrollResponse>;
    me(signal?: AbortSignal): Promise<RunnerIdentity>;
    sync(request: SyncRequest, signal?: AbortSignal): Promise<SyncResponse>;       // syncTimeoutMs default 35_000
    uploadBundle(args: { jobId: string; leaseEpoch: number; filePath: string; sha256: string; signal?: AbortSignal }): Promise<{ status: number }>;
  }
  // backoff.ts
  export function backoffDelay(attempt: number, random: () => number): number;   // full jitter, ceiling min(60_000, 1_000 * 2^attempt)
  // batch.ts
  export const SYNC_LIMITS: { readonly jobs: 64; readonly eventsPerJob: 500; readonly acks: 256; readonly tokenRequests: 64; readonly payloadBytes: 16_384 };
  export const MAX_BODY_BYTES: 900_000;
  export interface BatchScale { readonly jobs: number; readonly events: number }
  export const FULL_SCALE: BatchScale;
  export function halveScale(scale: BatchScale): BatchScale | null;               // null at {1,1}
  export function doubleScale(scale: BatchScale): BatchScale;                     // capped at FULL_SCALE
  export function byteLength(value: unknown): number;                             // serialised JSON bytes
  export interface BuildInput { journal: Pick<Journal, 'jobsWithPending' | 'pendingEvents'>; bootId: string; daemonVersion: string; freeSlots: number; acks: readonly CommandAck[]; capabilities?: RunnerCapabilities; scale: BatchScale }
  export function buildSyncRequest(input: BuildInput): SyncRequest;              // ONE entry per jobId, highest pending epoch first (D56)
  export const ACK_DETAIL_MAX: 200;
  export function clampAck(ack: CommandAck): CommandAck;                          // detail <= 200 chars, no NUL, no half surrogate pair (D59)
  ```

- [ ] **Step 1: Write the failing specs**

`sync/backoff.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { backoffDelay } from './backoff';

describe('backoffDelay (full jitter, 1 s to 60 s)', () => {
  test('the ceiling doubles from 1 s and stops at 60 s', () => {
    const top = () => 0.999999;
    expect([0, 1, 2, 3].map((a) => backoffDelay(a, top))).toEqual([999, 1999, 3999, 7999]);
    expect(backoffDelay(6, top)).toBeLessThan(60_000);
    expect(backoffDelay(6, top)).toBeGreaterThan(59_000);
    expect(backoffDelay(40, top)).toBeLessThan(60_000);
  });
  test('is uniform below the ceiling, so a zero draw is a zero delay', () => {
    expect(backoffDelay(5, () => 0)).toBe(0);
    expect(backoffDelay(0, () => 0.5)).toBe(500);
  });
});
```

`sync/batch.spec.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test';
import type { AssignPayload } from '@nathapp/fleet-protocol';
import { Journal } from '../journal/journal';
import { ACK_DETAIL_MAX, FULL_SCALE, MAX_BODY_BYTES, SYNC_LIMITS, buildSyncRequest, byteLength, clampAck, doubleScale, halveScale } from './batch';

const assign = (jobId: string): AssignPayload => ({
  jobId, command: 'RUN', repo: { provider: 'github', owner: 'a', name: 'b', defaultBranch: 'main', cloneUrl: 'https://x/a/b.git' },
  ref: 'main', feature: 'f', planFrom: null, profiles: [], maxCostUsd: '1', bashMode: 'raw', gitIdentity: { name: 'n', email: 'e' },
});
let j: Journal;
beforeEach(() => { j = Journal.open(':memory:'); });
const add = (jobId: string, leaseEpoch = 1) => j.insertJob({ assign: assign(jobId), leaseEpoch, repoKey: 'a/b', jobDir: `/w/${jobId}` });
const build = (over: Partial<Parameters<typeof buildSyncRequest>[0]> = {}) =>
  buildSyncRequest({ journal: j, bootId: 'boot', daemonVersion: '0.1.0', freeSlots: 1, acks: [], scale: FULL_SCALE, ...over });

describe('scale', () => {
  test('halves down to {1,1} and then reports null', () => {
    const seen: string[] = [];
    for (let s: ReturnType<typeof halveScale> = FULL_SCALE; s; s = halveScale(s)) seen.push(`${s.jobs}/${s.events}`);
    expect(seen).toEqual(['64/500', '32/250', '16/125', '8/62', '4/31', '2/15', '1/7', '1/3', '1/1']);
  });
  test('doubles back up and never beyond the limits', () => {
    expect(doubleScale({ jobs: 1, events: 1 })).toEqual({ jobs: 2, events: 2 });
    expect(doubleScale({ jobs: 40, events: 400 })).toEqual(FULL_SCALE);
  });
});

describe('clampAck (D59)', () => {
  const ack = (detail?: string) => ({ commandId: 'c', leaseEpoch: 1, result: 'rejected' as const, ...(detail !== undefined ? { detail } : {}) });
  test('leaves a short detail, and an absent one, alone', () => {
    expect(clampAck(ack('short'))).toEqual(ack('short'));
    expect(clampAck(ack())).toEqual(ack());
  });
  test('cuts a long detail to 200 characters', () => {
    expect(clampAck(ack('x'.repeat(600))).detail).toHaveLength(ACK_DETAIL_MAX);
  });
  test('never leaves half a surrogate pair, and replaces NUL (the server rejects it)', () => {
    const cut = clampAck(ack(`${'a'.repeat(199)}\u{1F600}tail`)).detail ?? '';
    expect(cut).toBe('a'.repeat(199));
    expect(clampAck(ack('a\u0000b')).detail).toBe('a�b');
  });
});

describe('buildSyncRequest', () => {
  test('reports pending events per job with their epoch, capped by the scale', () => {
    add('a');
    add('b');
    for (let i = 0; i < 5; i += 1) j.appendEvent('a', 1, 'log', { stream: 'run', text: `l${i}` });
    j.appendEvent('b', 1, 'lifecycle', { level: 'info', message: 'm' });
    const req = build({ scale: { jobs: 1, events: 3 } });
    expect(req.jobs).toHaveLength(1);
    expect(req.jobs[0]).toMatchObject({ jobId: 'a', leaseEpoch: 1 });
    expect(req.jobs[0].events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(req).toMatchObject({ protocolVersion: 1, bootId: 'boot', daemonVersion: '0.1.0', freeSlots: 1, commandAcks: [], tokenRequests: [] });
  });
  test('jobs with nothing pending are not reported', () => {
    add('a');
    expect(build().jobs).toEqual([]);
  });
  test('caps acks at 256, clamps freeSlots to 0..64, and carries capabilities when given', () => {
    const acks = Array.from({ length: 300 }, (_, i) => ({ commandId: `c${i}`, leaseEpoch: 1, result: 'ok' as const }));
    expect(build({ acks }).commandAcks).toHaveLength(SYNC_LIMITS.acks);
    expect(build({ freeSlots: -3 }).freeSlots).toBe(0);
    expect(build({ freeSlots: 500 }).freeSlots).toBe(64);
    expect(build({ freeSlots: 1.9 }).freeSlots).toBe(1);
    const caps = { nax: { version: '1', protocols: ['native' as const] }, sandbox: { available: true, probedAt: 'x' }, profiles: {}, credentials: [], tools: { git: true, gh: true, glab: true }, executors: ['host' as const] };
    expect(build({ capabilities: caps }).capabilities).toEqual(caps);
    expect(build().capabilities).toBeUndefined();
  });
  test('reports ONE entry per jobId, the highest pending epoch first; the older epoch waits (D56)', () => {
    // The server's parseSyncRequest answers 400 "duplicate job" for two entries with one jobId.
    add('a', 1);
    add('a', 2);
    add('b', 1);
    j.appendEvent('a', 1, 'log', { stream: 'run', text: 'old' });
    j.appendEvent('a', 2, 'log', { stream: 'run', text: 'new' });
    j.appendEvent('b', 1, 'log', { stream: 'run', text: 'b' });
    const first = build();
    expect(first.jobs.map((job) => `${job.jobId}@${job.leaseEpoch}`)).toEqual(['a@2', 'b@1']);
    expect(new Set(first.jobs.map((job) => job.jobId)).size).toBe(first.jobs.length);
    j.ackThrough('a', 2, 1);
    expect(build().jobs.map((job) => `${job.jobId}@${job.leaseEpoch}`)).toEqual(['a@1', 'b@1']);
  });
  test('the job cap counts distinct jobs, not (job, epoch) pairs', () => {
    add('a', 1);
    add('a', 2);
    add('b', 1);
    for (const [id, epoch] of [['a', 1], ['a', 2], ['b', 1]] as const) j.appendEvent(id, epoch, 'log', { stream: 'run', text: 'x' });
    expect(build({ scale: { jobs: 2, events: 5 } }).jobs.map((job) => job.jobId)).toEqual(['a', 'b']);
  });
  test('stays under the body budget, and under the real 1 MiB cap, with 64 jobs of large events (D26)', () => {
    for (let i = 0; i < 64; i += 1) {
      add(`job${i}`);
      for (let e = 0; e < 60; e += 1) j.appendEvent(`job${i}`, 1, 'log', { stream: 'run', text: 'x'.repeat(7_000) });
    }
    const req = build();
    expect(byteLength(req)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(byteLength(req)).toBeLessThanOrEqual(1_048_576); // the server's cap, whatever the wrapper estimate
    expect(req.jobs.flatMap((job) => job.events).length).toBeGreaterThan(50);
    for (const job of req.jobs) expect(job.events.length).toBeLessThanOrEqual(SYNC_LIMITS.eventsPerJob);
  });
  test('always includes at least the first event, however large the backlog', () => {
    add('a');
    j.appendEvent('a', 1, 'log', { stream: 'run', text: 'y'.repeat(8_000) });
    expect(build().jobs[0].events).toHaveLength(1);
  });
});
```

`sync/http.spec.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { NetworkError, ServerClient, ServerError, type FetchFn } from './http';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ ret: 0, data }), { status, headers: { 'content-type': 'application/json' } });
const client = (fetchFn: FetchFn, over: Record<string, unknown> = {}) => new ServerClient({ serverUrl: 'https://koda.example.com/koda', apiKey: 'kr_secret', fetchFn, ...over });

describe('ServerClient', () => {
  test('calls /api/fleet/runner/sync under the server path with the bearer key and unwraps data', async () => {
    let seen = null as { url: string; init: RequestInit | undefined } | null;
    const reply = { jobAcks: [], commands: [], gitTokens: [], gitTokenErrors: [], unknownJobIds: [] };
    const c = client(async (url, init) => { seen = { url, init }; return ok(reply); });
    const res = await c.sync({ protocolVersion: 1, bootId: 'b', daemonVersion: 'd', freeSlots: 0, jobs: [], commandAcks: [], tokenRequests: [] });
    expect(res).toEqual(reply);
    expect(seen?.url).toBe('https://koda.example.com/koda/api/fleet/runner/sync');
    expect(seen?.init?.method).toBe('POST');
    expect((seen?.init?.headers as Record<string, string>)['authorization']).toBe('Bearer kr_secret');
    expect((seen?.init?.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
  test('me reads the identity; enroll sends no Authorization header', async () => {
    const headers: Array<Record<string, string>> = [];
    const c = client(async (url, init) => {
      headers.push(init?.headers as Record<string, string>);
      return url.endsWith('/me') ? ok({ id: 'r', name: 'n', labels: [], capacity: 2, enabled: true }) : ok({ runnerId: 'r', apiKey: 'kr_new' }, 201);
    }, { apiKey: undefined });
    await expect(c.enroll({} as never)).resolves.toEqual({ runnerId: 'r', apiKey: 'kr_new' });
    expect(headers[0]['authorization']).toBeUndefined();
    await expect(new ServerClient({ serverUrl: 'https://x', fetchFn: async () => ok({ id: 'r', name: 'n', labels: [], capacity: 2, enabled: true }), apiKey: 'k' }).me()).resolves.toMatchObject({ capacity: 2 });
  });
  test('a non-2xx answer is a ServerError carrying status, server message and body', async () => {
    const c = client(async () => new Response(JSON.stringify({ ret: 1, message: 'Unsupported protocol version' }), { status: 426 }));
    const error = await c.me().catch((e) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect(error).toMatchObject({ status: 426, message: 'Unsupported protocol version', body: { ret: 1 } });
  });
  test('a 2xx body that is not an envelope is a ServerError', async () => {
    await expect(client(async () => new Response('<html>', { status: 200 })).me()).rejects.toBeInstanceOf(ServerError);
    await expect(client(async () => new Response(JSON.stringify({ ret: 5, message: 'x' }), { status: 200 })).me()).rejects.toBeInstanceOf(ServerError);
  });
  test('a fetch failure is a NetworkError; an abort passes through untouched', async () => {
    await expect(client(async () => { throw new TypeError('fetch failed'); }).me()).rejects.toBeInstanceOf(NetworkError);
    const controller = new AbortController();
    const hang: FetchFn = (_url, init) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(init?.signal?.reason ?? new DOMException('aborted', 'AbortError')));
    });
    const pending = client(hang).me(controller.signal).catch((e) => e);
    controller.abort();
    const error = await pending;
    expect(error).not.toBeInstanceOf(NetworkError);
  });
  test('the sync timeout fires as a TimeoutError, not a NetworkError', async () => {
    const hang: FetchFn = (_url, init) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(init?.signal?.reason));
    });
    const error = await client(hang, { syncTimeoutMs: 30 }).sync({} as never).catch((e) => e);
    expect(error.name).toBe('TimeoutError');
  });
  test('a missing api key is refused before any request', async () => {
    let called = false;
    const c = new ServerClient({ serverUrl: 'https://x', fetchFn: async () => { called = true; return ok({}); } });
    await expect(c.me()).rejects.toThrow(/api key/i);
    // sync() must reject, never throw synchronously: the sync loop awaits it inside try/catch.
    let thrown: unknown = null;
    let pending: Promise<unknown> = Promise.resolve();
    try {
      pending = c.sync({} as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeNull();
    await expect(pending).rejects.toThrow(/api key/i);
    expect(called).toBe(false);
  });
});

describe('uploadBundle', () => {
  test('PUTs the file with Content-Length, gzip type, sha header and the epoch, and returns the status', async () => {
    const file = join(await tmp.make('up'), 'bundle.tar.gz');
    await writeFile(file, Buffer.alloc(4096, 1));
    let seen = null as { method: string; url: string; headers: Headers; bytes: number } | null;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen = { method: req.method, url: req.url, headers: req.headers, bytes: (await req.arrayBuffer()).byteLength };
        return new Response('', { status: 201 });
      },
    });
    try {
      const c = new ServerClient({ serverUrl: `http://127.0.0.1:${server.port}`, apiKey: 'kr_x' });
      expect(await c.uploadBundle({ jobId: 'j1', leaseEpoch: 3, filePath: file, sha256: 'a'.repeat(64) })).toEqual({ status: 201 });
      expect(seen?.method).toBe('PUT');
      expect(new URL(seen?.url ?? '').pathname).toBe('/api/fleet/runner/jobs/j1/bundle');
      expect(new URL(seen?.url ?? '').searchParams.get('leaseEpoch')).toBe('3');
      expect(seen?.headers.get('content-length')).toBe('4096');
      expect(seen?.headers.get('content-type')).toBe('application/gzip');
      expect(seen?.headers.get('x-content-sha256')).toBe('a'.repeat(64));
      expect(seen?.headers.get('authorization')).toBe('Bearer kr_x');
      expect(seen?.bytes).toBe(4096);
    } finally {
      server.stop(true);
    }
  });
  test('returns a non-2xx status instead of throwing, and a network failure throws NetworkError', async () => {
    const file = join(await tmp.make('up'), 'b.tgz');
    await writeFile(file, 'x');
    const c = client(async () => new Response('', { status: 413 }));
    expect(await c.uploadBundle({ jobId: 'j', leaseEpoch: 1, filePath: file, sha256: 'b'.repeat(64) })).toEqual({ status: 413 });
    await expect(client(async () => { throw new TypeError('down'); }).uploadBundle({ jobId: 'j', leaseEpoch: 1, filePath: file, sha256: 'b'.repeat(64) })).rejects.toBeInstanceOf(NetworkError);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/runner && bun test src/sync`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`sync/backoff.ts`:

```ts
const BASE_MS = 1_000;
const MAX_MS = 60_000;

/** Full jitter: uniform in [0, min(60 s, 1 s * 2^attempt)). */
export function backoffDelay(attempt: number, random: () => number): number {
  const ceiling = Math.min(MAX_MS, BASE_MS * 2 ** Math.min(Math.max(attempt, 0), 16));
  return Math.floor(random() * ceiling);
}
```

`sync/http.ts`:

```ts
import type { EnrollRequest, EnrollResponse, RunnerIdentity, SyncRequest, SyncResponse } from '@nathapp/fleet-protocol';
import { errorMessage } from '../errors';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class ServerError extends Error {
  constructor(readonly status: number, message: string, readonly body: unknown) {
    super(message);
    this.name = 'ServerError';
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface ServerClientOptions {
  readonly serverUrl: string;
  readonly apiKey?: string;
  readonly fetchFn?: FetchFn;
  readonly syncTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const isAbort = (error: unknown): boolean => error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

function messageOf(body: unknown): string | null {
  return typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message : null;
}

export class ServerClient {
  constructor(private readonly options: ServerClientOptions) {}

  private url(path: string): string {
    return `${this.options.serverUrl}/api${path}`;
  }

  private bearer(): Record<string, string> {
    if (!this.options.apiKey) throw new Error('runner api key is not set');
    return { authorization: `Bearer ${this.options.apiKey}` };
  }

  private async send(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await (this.options.fetchFn ?? fetch)(url, { ...init, signal: merged });
    } catch (error) {
      if (isAbort(error) || merged.aborted) throw merged.reason instanceof Error ? merged.reason : error;
      throw new NetworkError(errorMessage(error));
    }
  }

  private async json<T>(response: Response): Promise<T> {
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) throw new ServerError(response.status, messageOf(body) ?? response.statusText, body);
    const envelope = body as { ret?: unknown; data?: unknown } | null;
    if (envelope === null || typeof envelope !== 'object' || envelope.ret !== 0) {
      throw new ServerError(response.status, messageOf(body) ?? 'unexpected response shape', body);
    }
    return envelope.data as T;
  }

  /** async on purpose: a missing api key (`bearer()` throws) must surface as a rejection, not a synchronous throw. */
  private async post<T>(path: string, body: unknown, auth: boolean, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(auth ? this.bearer() : {}) };
    const response = await this.send(this.url(path), { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs, signal);
    return this.json<T>(response);
  }

  enroll(body: EnrollRequest): Promise<EnrollResponse> {
    return this.post('/fleet/runner/enroll', body, false, this.options.requestTimeoutMs ?? 15_000);
  }

  async me(signal?: AbortSignal): Promise<RunnerIdentity> {
    const response = await this.send(this.url('/fleet/runner/me'), { method: 'GET', headers: this.bearer() }, this.options.requestTimeoutMs ?? 15_000, signal);
    return this.json<RunnerIdentity>(response);
  }

  sync(request: SyncRequest, signal?: AbortSignal): Promise<SyncResponse> {
    return this.post('/fleet/runner/sync', request, true, this.options.syncTimeoutMs ?? 35_000, signal);
  }

  async uploadBundle(args: { jobId: string; leaseEpoch: number; filePath: string; sha256: string; signal?: AbortSignal }): Promise<{ status: number }> {
    const url = `${this.url(`/fleet/runner/jobs/${encodeURIComponent(args.jobId)}/bundle`)}?leaseEpoch=${args.leaseEpoch}`;
    const headers = { ...this.bearer(), 'content-type': 'application/gzip', 'x-content-sha256': args.sha256 };
    const response = await this.send(url, { method: 'PUT', headers, body: Bun.file(args.filePath) }, UPLOAD_TIMEOUT_MS, args.signal);
    await response.arrayBuffer().catch(() => undefined);
    return { status: response.status };
  }
}
```
(The `Bun.file` body makes `fetch` send `Content-Length`, verified by the spec; the server answers 413 before reading the body when it is too large.)

`sync/batch.ts`:

```ts
import { FLEET_PROTOCOL_VERSION, type CommandAck, type JobReport, type RunnerCapabilities, type SyncRequest } from '@nathapp/fleet-protocol';
import type { Journal } from '../journal/journal';

export const SYNC_LIMITS = Object.freeze({ jobs: 64, eventsPerJob: 500, acks: 256, tokenRequests: 64, payloadBytes: 16_384 } as const);
/** Under the server's 1 MiB body cap (D26). */
export const MAX_BODY_BYTES = 900_000;
/** `{"seq":2147483647,"type":"lifecycle","payload":},` is 49 bytes around the payload; rounded up. */
const EVENT_OVERHEAD_BYTES = 64;
/** `{"jobId":"<36-char uuid>","leaseEpoch":2147483647,"events":[]},` is about 90 bytes around the events. */
const JOB_OVERHEAD_BYTES = 100;
export const ACK_DETAIL_MAX = 200;

export interface BatchScale {
  readonly jobs: number;
  readonly events: number;
}

export const FULL_SCALE: BatchScale = Object.freeze({ jobs: SYNC_LIMITS.jobs, events: SYNC_LIMITS.eventsPerJob });

export function halveScale(scale: BatchScale): BatchScale | null {
  if (scale.jobs <= 1 && scale.events <= 1) return null;
  return { jobs: Math.max(1, Math.floor(scale.jobs / 2)), events: Math.max(1, Math.floor(scale.events / 2)) };
}

export function doubleScale(scale: BatchScale): BatchScale {
  return { jobs: Math.min(FULL_SCALE.jobs, scale.jobs * 2), events: Math.min(FULL_SCALE.events, scale.events * 2) };
}

export const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

export interface BuildInput {
  readonly journal: Pick<Journal, 'jobsWithPending' | 'pendingEvents'>;
  readonly bootId: string;
  readonly daemonVersion: string;
  readonly freeSlots: number;
  readonly acks: readonly CommandAck[];
  readonly capabilities?: RunnerCapabilities;
  readonly scale: BatchScale;
}

/** The server allows 500 characters and no NUL; a runner-built detail is shorter and never poisons a request (D59). */
export function clampAck(ack: CommandAck): CommandAck {
  if (ack.detail === undefined) return ack;
  const clean = ack.detail.replaceAll('\u0000', '�');
  if (clean.length <= ACK_DETAIL_MAX) return clean === ack.detail ? ack : { ...ack, detail: clean };
  const last = clean.charCodeAt(ACK_DETAIL_MAX - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? ACK_DETAIL_MAX - 1 : ACK_DETAIL_MAX; // never leave half a surrogate pair
  return { ...ack, detail: clean.slice(0, end) };
}

/**
 * One entry per jobId (D56): the server's parseSyncRequest answers 400 "duplicate job" otherwise. A job that has
 * pending events at two epochs (a requeue) reports the highest epoch first; the older epoch waits for a later sync.
 * First-appearance order is kept, so the oldest waiting job still goes first.
 */
function onePerJob(pending: ReadonlyArray<{ jobId: string; leaseEpoch: number }>): Array<{ jobId: string; leaseEpoch: number }> {
  const highest = new Map<string, number>();
  for (const { jobId, leaseEpoch } of pending) highest.set(jobId, Math.max(highest.get(jobId) ?? 0, leaseEpoch));
  return [...highest].map(([jobId, leaseEpoch]) => ({ jobId, leaseEpoch }));
}

export function buildSyncRequest(input: BuildInput): SyncRequest {
  const freeSlots = Math.min(64, Math.max(0, Math.floor(input.freeSlots)));
  const commandAcks = input.acks.slice(0, SYNC_LIMITS.acks).map(clampAck);
  const head = {
    protocolVersion: FLEET_PROTOCOL_VERSION as number,
    bootId: input.bootId,
    daemonVersion: input.daemonVersion,
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    freeSlots,
    commandAcks,
    tokenRequests: [] as SyncRequest['tokenRequests'],
  };
  let budget = MAX_BODY_BYTES - byteLength({ ...head, jobs: [] });
  const jobs: JobReport[] = [];
  let included = 0;
  for (const { jobId, leaseEpoch } of onePerJob(input.journal.jobsWithPending()).slice(0, input.scale.jobs)) {
    const events: JobReport['events'] = [];
    for (const row of input.journal.pendingEvents(jobId, leaseEpoch, Math.min(input.scale.events, SYNC_LIMITS.eventsPerJob))) {
      const size = byteLength(row.payload) + EVENT_OVERHEAD_BYTES + (events.length === 0 ? JOB_OVERHEAD_BYTES : 0);
      if (included > 0 && size > budget) break;
      events.push({ seq: row.seq, type: row.type, payload: row.payload });
      budget -= size;
      included += 1;
    }
    if (events.length > 0) jobs.push({ jobId, leaseEpoch, events });
  }
  return { ...head, jobs };
}
```

- [ ] **Step 4: Run and lint**

```bash
cd apps/runner && bun test src/sync && bun run type-check && bun run lint
```
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/runner
git commit -m "feat(fleet): runner server client (envelope, bundle PUT), full-jitter backoff, body-budgeted sync batches"
```

---
### Task 10: Sync loop

**Files:**
- Create: `apps/runner/src/sync/sync-loop.ts`, `apps/runner/src/sync/sync-loop.spec.ts`

**Interfaces:**
- Consumes: `Journal` (8), `ServerError` and `buildSyncRequest`, scale helpers (9), `backoffDelay` (9), `Logger`, `Sleep` (6).
- Produces:
  ```ts
  export interface StopReason { readonly kind: 'protocol' | 'auth'; readonly message: string }
  export type SyncOutcome =
    | { kind: 'ok' } | { kind: 'woken' } | { kind: 'again' }
    | { kind: 'retry'; delayMs: number } | { kind: 'stop'; reason: StopReason };
  export interface CapabilityReport { readonly capabilities: RunnerCapabilities; readonly hash: string }
  export interface SyncLoopDeps {
    readonly client: { sync(request: SyncRequest, signal?: AbortSignal): Promise<SyncResponse> };
    readonly journal: Pick<Journal, 'jobsWithPending' | 'pendingEvents' | 'ackThrough' | 'replaceEvent' | 'onWrite'>;
    readonly bootId: string;
    readonly daemonVersion: string;
    readonly freeSlots: () => number;
    readonly capabilityReport: () => CapabilityReport | null;      // null: nothing to send this time
    readonly onCapabilitiesSent: (hash: string) => void;
    readonly handleCommands: (commands: readonly FleetCommandOut[]) => Promise<CommandAck[]>;   // never throws
    readonly abandonUnknown: (jobIds: readonly string[]) => Promise<void>;
    readonly onStop: (reason: StopReason) => void;
    readonly log: Logger;
    readonly sleep: Sleep;
    readonly random: () => number;
    readonly nowMs: () => number;
    readonly minGapMs: number;                                      // 250
  }
  export class SyncLoop {
    constructor(deps: SyncLoopDeps);
    syncOnce(): Promise<SyncOutcome>;
    run(): Promise<void>;          // resolves when stopped or after a stop outcome
    wake(): void;                  // journal onWrite: abort the in-flight request ONLY if it is an idle poll, else mark dirty (D57)
    stop(): void;
  }
  ```
  Semantics (slice 3 design §1.3): one request in flight; a journal write aborts an in-flight request only when it is an **idle poll** (no jobs, no command acks, no token requests): a request that carries data may already be applied by the server, so its response is not thrown away; instead a `dirty` flag is set and `run()` starts the next sync immediately after the response, without the `minGapMs` sleep (D57); at least `minGapMs` between syncs otherwise; 5xx and network errors back off 1 s..60 s with full jitter; 426 and 401 stop the loop; 400/413 halve the batch and, at `{1,1}`, first retry once with `commandAcks: []` when the request carried acks (D58), and only if it still fails replace that event (D24); a 400 on a request carrying `capabilities` is retried once without them (D25); command acks are clamped to 200 characters of detail as they are queued (D59); acks of commands stay queued until a sync carrying them succeeds; `jobAcks` advance the cursor of the epoch that was **reported** (a `JobAck` carries no epoch); after a success the batch scale doubles back toward full.

- [ ] **Step 1: Write the failing spec**

`sync/sync-loop.spec.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test';
import type { AssignPayload, CommandAck, FleetCommandOut, SyncRequest, SyncResponse } from '@nathapp/fleet-protocol';
import { Journal } from '../journal/journal';
import { createMemoryLogger } from '../logger';
import { ServerError, NetworkError } from './http';
import { SyncLoop, type CapabilityReport, type StopReason, type SyncLoopDeps } from './sync-loop';

const empty: SyncResponse = { jobAcks: [], commands: [], gitTokens: [], gitTokenErrors: [], unknownJobIds: [] };
const assign = (jobId: string): AssignPayload => ({
  jobId, command: 'RUN', repo: { provider: 'github', owner: 'a', name: 'b', defaultBranch: 'main', cloneUrl: 'https://x/a/b.git' },
  ref: 'main', feature: 'f', planFrom: null, profiles: [], maxCostUsd: '1', bashMode: 'raw', gitIdentity: { name: 'n', email: 'e' },
});
const caps = (v: string): CapabilityReport => ({
  hash: v,
  capabilities: { nax: { version: v, protocols: ['native'] }, sandbox: { available: true, probedAt: 't' }, profiles: {}, credentials: [], tools: { git: true, gh: true, glab: true }, executors: ['host'] },
});

type Step = (req: SyncRequest, signal?: AbortSignal) => Promise<SyncResponse>;
let journal: Journal;
let calls: SyncRequest[];
let script: Step[];
let sleeps: number[];
let stops: StopReason[];
let capsNow: CapabilityReport | null;
let sentHashes: string[];
let handled: FleetCommandOut[][];
let commandAcks: CommandAck[];
let abandoned: string[][];
let now: number;

function makeLoop(over: Partial<SyncLoopDeps> = {}): SyncLoop {
  return new SyncLoop({
    client: { sync: async (req, signal) => {
      calls.push(structuredClone(req));
      const step = script.shift();
      if (!step) throw new Error('script exhausted');
      return step(req, signal);
    } },
    journal, bootId: 'boot-1', daemonVersion: '0.1.0', freeSlots: () => 1,
    capabilityReport: () => capsNow, onCapabilitiesSent: (h) => { sentHashes.push(h); },
    handleCommands: async (cmds) => { handled.push([...cmds]); return commandAcks; },
    abandonUnknown: async (ids) => { abandoned.push([...ids]); },
    onStop: (r) => { stops.push(r); }, log: createMemoryLogger(),
    sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, nowMs: () => now, minGapMs: 250, ...over,
  });
}
const add = (jobId: string, epoch = 1) => journal.insertJob({ assign: assign(jobId), leaseEpoch: epoch, repoKey: 'a/b', jobDir: `/w/${jobId}` });
const log = (jobId: string, n: number, epoch = 1) => { for (let i = 0; i < n; i += 1) journal.appendEvent(jobId, epoch, 'log', { stream: 'run', text: `l${i}` }); };
const ok = (over: Partial<SyncResponse> = {}): Step => async () => ({ ...empty, ...over });
const assignCmd: FleetCommandOut = { commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: assign('j1') };

beforeEach(() => {
  journal = Journal.open(':memory:');
  calls = []; script = []; sleeps = []; stops = []; capsNow = null; sentHashes = []; handled = []; commandAcks = []; abandoned = []; now = 0;
});

describe('acks and the cursor', () => {
  test('advances the cursor of the epoch that was reported', async () => {
    add('j1', 2);
    log('j1', 3, 2);
    script.push(ok({ jobAcks: [{ jobId: 'j1', ackedSeq: 2 }] }));
    expect(await makeLoop().syncOnce()).toEqual({ kind: 'ok' });
    expect(calls[0].jobs).toMatchObject([{ jobId: 'j1', leaseEpoch: 2 }]);
    expect(journal.pendingEvents('j1', 2, 10).map((e) => e.seq)).toEqual([3]);
  });
  test('an ack for a job that was not in the request is ignored', async () => {
    add('j1');
    log('j1', 1);
    script.push(ok({ jobAcks: [{ jobId: 'other', ackedSeq: 9 }] }));
    await makeLoop().syncOnce();
    expect(journal.pendingEvents('j1', 1, 10)).toHaveLength(1);
  });
  test('sends free slots and identity on every request', async () => {
    script.push(ok());
    await makeLoop({ freeSlots: () => 3 }).syncOnce();
    expect(calls[0]).toMatchObject({ protocolVersion: 1, bootId: 'boot-1', daemonVersion: '0.1.0', freeSlots: 3, jobs: [] });
  });
});

describe('abort on write', () => {
  test('a journal write aborts an idle poll; the next sync carries the new event', async () => {
    add('j1');
    const idle: Step = (_req, signal) => new Promise((_res, rej) => signal?.addEventListener('abort', () => rej(signal.reason)));
    script.push(idle, ok({ jobAcks: [{ jobId: 'j1', ackedSeq: 1 }] }));
    const loop = makeLoop();
    const first = loop.syncOnce();
    log('j1', 1);
    loop.wake();
    expect(await first).toEqual({ kind: 'woken' });
    expect(await loop.syncOnce()).toEqual({ kind: 'ok' });
    expect(calls[1].jobs[0].events).toHaveLength(1);
  });
  test('a wake during a request that carries data does not abort it; the next sync starts with no min-gap sleep (D57)', async () => {
    add('j1');
    log('j1', 1);
    let aborted = false;
    let release: (response: SyncResponse) => void = () => undefined;
    const busy: Step = (_req, signal) => new Promise((res) => {
      release = res;
      signal?.addEventListener('abort', () => { aborted = true; });
    });
    script.push(busy, async () => { throw new ServerError(426, 'stop', null); });
    const loop = makeLoop();
    const done = loop.run();            // the first request is already in flight and carries event 1
    log('j1', 1);                       // the journal write calls wake() through the onWrite listener
    loop.wake();
    expect(aborted).toBe(false);
    expect(calls).toHaveLength(1);
    release({ ...empty, jobAcks: [{ jobId: 'j1', ackedSeq: 1 }] });
    await done;
    expect(calls).toHaveLength(2);
    expect(calls[1].jobs[0].events.map((e) => e.seq)).toEqual([2]); // the write made during the request goes out at once
    expect(sleeps).toEqual([]);                                     // without the minGap sleep
    expect(stops[0].kind).toBe('protocol');
  });
  test('a request that carries only command acks is not idle either: a wake does not abort it (D57)', async () => {
    commandAcks = [{ commandId: 'c1', leaseEpoch: 1, result: 'ok' }];
    let aborted = false;
    let release: (response: SyncResponse) => void = () => undefined;
    const busy: Step = (_req, signal) => new Promise((res) => {
      release = res;
      signal?.addEventListener('abort', () => { aborted = true; });
    });
    script.push(ok({ commands: [assignCmd] }), busy);
    const loop = makeLoop();
    await loop.syncOnce();                  // handles the command, queues its ack
    commandAcks = [];
    const second = loop.syncOnce();         // carries the ack and nothing else
    expect(calls[1].commandAcks).toHaveLength(1);
    loop.wake();
    expect(aborted).toBe(false);
    release(empty);
    expect(await second).toEqual({ kind: 'ok' });
  });
  test('the journal listener is wired: appending an event wakes the loop', async () => {
    add('j1');
    const seen: Array<() => void> = [];
    const fake = { ...journal, onWrite: (l: () => void) => { seen.push(l); return () => undefined; } } as unknown as SyncLoopDeps['journal'];
    makeLoop({ journal: fake });
    expect(seen).toHaveLength(1);
  });
});

describe('failures', () => {
  test('5xx and network errors back off with full jitter and a success resets the attempt', async () => {
    script.push(async () => { throw new ServerError(503, 'down', null); }, async () => { throw new NetworkError('reset'); }, ok(), async () => { throw new ServerError(500, 'x', null); });
    const loop = makeLoop();
    expect(await loop.syncOnce()).toEqual({ kind: 'retry', delayMs: 500 });
    expect(await loop.syncOnce()).toEqual({ kind: 'retry', delayMs: 1000 });
    expect(await loop.syncOnce()).toEqual({ kind: 'ok' });
    expect(await loop.syncOnce()).toEqual({ kind: 'retry', delayMs: 500 });
  });
  test('a client timeout is retried like a network error', async () => {
    script.push(async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
    expect((await makeLoop().syncOnce()).kind).toBe('retry');
  });
  test('426 stops the loop and names the message; 401 stops it as an auth failure; neither retries', async () => {
    script.push(async () => { throw new ServerError(426, 'Unsupported protocol version 2; supported: 1', null); });
    const loop = makeLoop();
    await loop.run();
    expect(stops).toEqual([{ kind: 'protocol', message: 'Unsupported protocol version 2; supported: 1' }]);
    expect(calls).toHaveLength(1);

    script.push(async () => { throw new ServerError(401, 'runner key rejected', null); });
    await makeLoop().run();
    expect(stops[1].kind).toBe('auth');
    expect(calls).toHaveLength(2);
  });
  test('run() leaves at least minGap between syncs and sleeps the backoff after a failure', async () => {
    script.push(ok(), async () => { throw new ServerError(500, 'x', null); }, async () => { throw new ServerError(426, 'old', null); });
    now = 100;
    await makeLoop().run();
    expect(sleeps).toEqual([250, 500]);
  });
});

describe('bad batches', () => {
  test('halves until the poisoned event is alone, replaces it, and everything else arrives in order (D24)', async () => {
    add('j1');
    for (let i = 1; i <= 8; i += 1) journal.appendEvent('j1', 1, 'snapshot', i === 5 ? { poison: true } as never : { costSpentUsd: String(i) });
    const received: number[] = [];
    const server: Step = async (req) => {
      const events = req.jobs.flatMap((j) => j.events);
      if (events.some((e) => (e.payload as { poison?: boolean }).poison)) throw new ServerError(400, 'bad event', null);
      received.push(...events.map((e) => e.seq));
      return { ...empty, jobAcks: [{ jobId: 'j1', ackedSeq: Math.max(...events.map((e) => e.seq)) }] };
    };
    const loop = makeLoop();
    for (let i = 0; i < 60 && journal.jobsWithPending().length > 0; i += 1) {
      script.push(server);
      await loop.syncOnce();
    }
    expect(received).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(journal.jobsWithPending()).toEqual([]);
    const all = journal.pendingEvents('j1', 1, 20);
    expect(all).toEqual([]); // all acked; the replaced one was delivered as a lifecycle error
    expect(calls.some((c) => c.jobs.some((j) => j.events.some((e) => e.seq === 5 && e.type === 'lifecycle')))).toBe(true);
  });
  test('with nothing to blame, a bad batch halves down to {1,1} and then backs off instead of dropping anything', async () => {
    const loop = makeLoop();
    const reject: Step = async () => { throw new ServerError(413, 'too large', null); };
    // No pending events, so the request has no job. 64/500 reaches 1/1 after eight halvings (500 needs nine steps to 1).
    for (let i = 0; i < 8; i += 1) {
      script.push(reject);
      expect((await loop.syncOnce()).kind).toBe('again');
    }
    script.push(reject);
    expect((await loop.syncOnce()).kind).toBe('retry');
    expect(script).toEqual([]);
  });
  test('at {1,1} a 400 on a request with command acks retries once without them before an event is blamed (D58)', async () => {
    add('j1');
    log('j1', 1);
    commandAcks = [{ commandId: 'c1', leaseEpoch: 1, result: 'ok', detail: 'bad-detail' }];
    script.push(ok({ commands: [assignCmd] }));
    const loop = makeLoop();
    await loop.syncOnce();                  // queues the ack; event 1 stays unacked
    commandAcks = [];
    // the server rejects any request whose acks carry a detail
    const server: Step = async (req) => {
      if (req.commandAcks.some((a) => a.detail !== undefined)) throw new ServerError(400, 'ack detail', null);
      const events = req.jobs.flatMap((job) => job.events);
      return { ...empty, jobAcks: events.length > 0 ? [{ jobId: 'j1', ackedSeq: Math.max(...events.map((e) => e.seq)) }] : [] };
    };
    for (let i = 0; i < 30; i += 1) {
      script.push(server);
      await loop.syncOnce();
    }
    expect(journal.jobsWithPending()).toEqual([]);
    const sent = calls.flatMap((c) => c.jobs.flatMap((job) => job.events));
    expect(sent.every((e) => e.type === 'log')).toBe(true);                       // the event was never replaced
    expect(calls.slice(1).some((c) => c.jobs.length > 0 && c.commandAcks.length === 0)).toBe(true); // the acks-free retry (calls[0] is the seed sync)
    expect(calls.some((c) => c.commandAcks.length === 1 && c.commandAcks[0].detail === undefined)).toBe(true); // acks resent without detail
    expect(calls[calls.length - 1].commandAcks).toEqual([]);                      // and delivered
  });
  test('a 400 at {1,1} that persists without acks still blames the event (D24 stays the last resort)', async () => {
    add('j1');
    journal.appendEvent('j1', 1, 'snapshot', { poison: true } as never);
    const server: Step = async (req) => {
      if (req.jobs.flatMap((job) => job.events).some((e) => (e.payload as { poison?: boolean }).poison)) throw new ServerError(400, 'bad event', null);
      return { ...empty, jobAcks: [{ jobId: 'j1', ackedSeq: 1 }] };
    };
    const loop = makeLoop();
    for (let i = 0; i < 20 && journal.jobsWithPending().length > 0; i += 1) {
      script.push(server);
      await loop.syncOnce();
    }
    expect(calls.some((c) => c.jobs.some((job) => job.events.some((e) => e.type === 'lifecycle')))).toBe(true);
    expect(journal.jobsWithPending()).toEqual([]);
  });
  test('a 400 on a request carrying capabilities retries without them, logs, and does not resend that hash (D25)', async () => {
    add('j1');
    log('j1', 1);
    capsNow = caps('h1');
    script.push(async () => { throw new ServerError(400, 'capabilities', null); }, ok({ jobAcks: [{ jobId: 'j1', ackedSeq: 1 }] }), ok());
    const loop = makeLoop();
    expect((await loop.syncOnce()).kind).toBe('again');
    expect(calls[0].capabilities).toBeDefined();
    expect(await loop.syncOnce()).toEqual({ kind: 'ok' });
    expect(calls[1].capabilities).toBeUndefined();
    expect(journal.pendingEvents('j1', 1, 5)).toEqual([]);      // the event was not blamed
    await loop.syncOnce();
    expect(calls[2].capabilities).toBeUndefined();
    expect(sentHashes).toEqual([]);
    capsNow = caps('h2');
    script.push(ok());
    await loop.syncOnce();
    expect(calls[3].capabilities?.nax.version).toBe('h2');
    expect(sentHashes).toEqual(['h2']);
  });
});

describe('capabilities', () => {
  test('are sent when the report says so and confirmed only after a successful sync', async () => {
    capsNow = caps('h1');
    script.push(async () => { throw new ServerError(500, 'x', null); }, ok());
    const loop = makeLoop();
    await loop.syncOnce();
    expect(sentHashes).toEqual([]);
    await loop.syncOnce();
    expect(calls[1].capabilities?.nax.version).toBe('h1');
    expect(sentHashes).toEqual(['h1']);
  });
});

describe('commands', () => {
  test('are handled, and their acks ride the next sync and stop riding once it succeeds', async () => {
    commandAcks = [{ commandId: 'c1', leaseEpoch: 1, result: 'ok' }];
    script.push(ok({ commands: [assignCmd] }), ok(), ok());
    const loop = makeLoop();
    await loop.syncOnce();
    expect(handled).toEqual([[assignCmd]]);
    commandAcks = [];
    await loop.syncOnce();
    expect(calls[1].commandAcks).toEqual([{ commandId: 'c1', leaseEpoch: 1, result: 'ok' }]);
    await loop.syncOnce();
    expect(calls[2].commandAcks).toEqual([]);
  });
  test('acks survive a failed sync and are resent', async () => {
    commandAcks = [{ commandId: 'c1', leaseEpoch: 1, result: 'ok' }];
    script.push(ok({ commands: [assignCmd] }), async () => { throw new ServerError(500, 'x', null); }, ok());
    const loop = makeLoop();
    await loop.syncOnce();
    commandAcks = [];
    await loop.syncOnce();
    await loop.syncOnce();
    expect(calls[1].commandAcks).toHaveLength(1);
    expect(calls[2].commandAcks).toHaveLength(1);
  });
  test('an ack detail longer than 200 characters is clamped as it is queued (D59)', async () => {
    commandAcks = [{ commandId: 'c1', leaseEpoch: 1, result: 'rejected', detail: 'x'.repeat(600) }];
    script.push(ok({ commands: [assignCmd] }), ok());
    const loop = makeLoop();
    await loop.syncOnce();
    await loop.syncOnce();
    expect(calls[1].commandAcks[0].detail).toHaveLength(200);
  });
  test('unknownJobIds are handed to the abandon hook', async () => {
    script.push(ok({ unknownJobIds: ['ghost'] }));
    await makeLoop().syncOnce();
    expect(abandoned).toEqual([['ghost']]);
  });
});
```
(The first bad-batch test below the poison test exercises the "nothing to blame" branch: with no pending events the request has no job, halving reaches `{1,1}` after eight rejections, and the ninth backs off.)

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/runner && bun test src/sync/sync-loop.spec.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`sync/sync-loop.ts`:

```ts
import type { CommandAck, FleetCommandOut, RunnerCapabilities, SyncRequest, SyncResponse } from '@nathapp/fleet-protocol';
import { errorMessage } from '../errors';
import type { Journal } from '../journal/journal';
import type { Logger } from '../logger';
import type { Sleep } from '../time';
import { backoffDelay } from './backoff';
import { FULL_SCALE, buildSyncRequest, clampAck, doubleScale, halveScale, type BatchScale } from './batch';
import { ServerError } from './http';

export interface StopReason {
  readonly kind: 'protocol' | 'auth';
  readonly message: string;
}

export type SyncOutcome =
  | { kind: 'ok' }
  | { kind: 'woken' }
  | { kind: 'again' }
  | { kind: 'retry'; delayMs: number }
  | { kind: 'stop'; reason: StopReason };

export interface CapabilityReport {
  readonly capabilities: RunnerCapabilities;
  readonly hash: string;
}

export interface SyncLoopDeps {
  readonly client: { sync(request: SyncRequest, signal?: AbortSignal): Promise<SyncResponse> };
  readonly journal: Pick<Journal, 'jobsWithPending' | 'pendingEvents' | 'ackThrough' | 'replaceEvent' | 'onWrite'>;
  readonly bootId: string;
  readonly daemonVersion: string;
  readonly freeSlots: () => number;
  readonly capabilityReport: () => CapabilityReport | null;
  readonly onCapabilitiesSent: (hash: string) => void;
  readonly handleCommands: (commands: readonly FleetCommandOut[]) => Promise<CommandAck[]>;
  readonly abandonUnknown: (jobIds: readonly string[]) => Promise<void>;
  readonly onStop: (reason: StopReason) => void;
  readonly log: Logger;
  readonly sleep: Sleep;
  readonly random: () => number;
  readonly nowMs: () => number;
  readonly minGapMs: number;
}

export class SyncLoop {
  private stopped = false;
  private scale: BatchScale = FULL_SCALE;
  private failures = 0;
  private capsRejected: string | null = null;
  private inflight: AbortController | null = null;
  private inflightIdle = false;
  private dirty = false;
  private acksExcluded = false;
  private readonly pendingAcks = new Map<string, CommandAck>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: SyncLoopDeps) {
    this.unsubscribe = deps.journal.onWrite(() => this.wake());
  }

  /**
   * Only an idle poll (nothing to deliver) is aborted: a request that carries events or acks may already be applied
   * by the server, and dropping its response would re-deliver commands. Otherwise the next sync just starts at once.
   */
  wake(): void {
    if (!this.inflight) return;
    if (this.inflightIdle) this.inflight.abort('wake');
    else this.dirty = true;
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    this.inflight?.abort('stop');
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      const started = this.deps.nowMs();
      const outcome = await this.syncOnce();
      if (outcome.kind === 'stop') {
        this.stopped = true;
        this.unsubscribe();
        this.deps.onStop(outcome.reason);
        return;
      }
      if (outcome.kind === 'retry') await this.deps.sleep(outcome.delayMs);
      else if (outcome.kind !== 'again' && !this.dirty) await this.deps.sleep(Math.max(0, this.deps.minGapMs - (this.deps.nowMs() - started)));
    }
  }

  private report(): CapabilityReport | null {
    const report = this.deps.capabilityReport();
    return report && report.hash !== this.capsRejected ? report : null;
  }

  async syncOnce(): Promise<SyncOutcome> {
    const report = this.report();
    this.dirty = false; // anything written from here on is either in this request or marks the next one
    const request = buildSyncRequest({
      journal: this.deps.journal, bootId: this.deps.bootId, daemonVersion: this.deps.daemonVersion, freeSlots: this.deps.freeSlots(),
      acks: this.acksExcluded ? [] : [...this.pendingAcks.values()], capabilities: report?.capabilities, scale: this.scale,
    });
    const controller = new AbortController();
    this.inflightIdle = request.jobs.length === 0 && request.commandAcks.length === 0 && request.tokenRequests.length === 0;
    this.inflight = controller;
    try {
      const response = await this.deps.client.sync(request, controller.signal);
      return await this.apply(request, response, report);
    } catch (error) {
      return this.classify(error, request, controller, report);
    } finally {
      this.inflight = null;
    }
  }

  private async apply(request: SyncRequest, response: SyncResponse, report: CapabilityReport | null): Promise<SyncOutcome> {
    this.inflightIdle = false; // writes made while commands are handled below must not be aborted, only marked dirty
    for (const ack of response.jobAcks ?? []) {
      const reported = request.jobs.find((job) => job.jobId === ack.jobId);
      if (reported) this.deps.journal.ackThrough(ack.jobId, reported.leaseEpoch, ack.ackedSeq);
    }
    for (const ack of request.commandAcks) this.pendingAcks.delete(ack.commandId);
    if (this.acksExcluded) this.stripPendingAckDetails();
    if (report && request.capabilities) this.deps.onCapabilitiesSent(report.hash);
    this.failures = 0;
    this.scale = doubleScale(this.scale);
    const unknown = response.unknownJobIds ?? [];
    if (unknown.length > 0) await this.deps.abandonUnknown(unknown);
    const commands = response.commands ?? [];
    if (commands.length > 0) {
      for (const ack of await this.deps.handleCommands(commands)) this.pendingAcks.set(ack.commandId, clampAck(ack));
    }
    return { kind: 'ok' };
  }

  private classify(error: unknown, request: SyncRequest, controller: AbortController, report: CapabilityReport | null): SyncOutcome {
    if (controller.signal.aborted) return { kind: 'woken' };
    if (error instanceof ServerError) {
      if (error.status === 426) return { kind: 'stop', reason: { kind: 'protocol', message: error.message } };
      if (error.status === 401) return { kind: 'stop', reason: { kind: 'auth', message: error.message } };
      if (error.status === 400 || error.status === 413) return this.badBatch(request, report, error);
    }
    return this.retry(error);
  }

  private badBatch(request: SyncRequest, report: CapabilityReport | null, error: ServerError): SyncOutcome {
    if (report && request.capabilities && error.status === 400) {
      this.capsRejected = report.hash;
      this.deps.log.error('server rejected the capabilities report; fix runner.json capabilities', { status: error.status });
      return { kind: 'again' };
    }
    const next = halveScale(this.scale);
    if (next) {
      this.scale = next;
      return { kind: 'again' };
    }
    if (error.status === 400 && request.commandAcks.length > 0) {
      // D58: the acks may be the poison, not the event; try once without them before blaming an event.
      this.acksExcluded = true;
      this.deps.log.warn('sync rejected at the smallest batch; retrying once without command acks');
      return { kind: 'again' };
    }
    const job = request.jobs[0];
    const event = job?.events[0];
    if (!job || !event) return this.retry(error);
    const message = `event ${event.seq} (${event.type}) dropped: the server rejected it (${error.status})`;
    this.deps.journal.replaceEvent(job.jobId, job.leaseEpoch, event.seq, 'lifecycle', { level: 'error', message });
    this.deps.log.error(message, { jobId: job.jobId });
    this.scale = FULL_SCALE;
    return { kind: 'again' };
  }

  /** The acks-free retry worked, so the acks were the problem: resend them without their free-text detail (D58). */
  private stripPendingAckDetails(): void {
    this.acksExcluded = false;
    this.deps.log.warn('sync succeeded once command acks were left out; resending them without detail', { acks: this.pendingAcks.size });
    for (const [id, ack] of [...this.pendingAcks]) this.pendingAcks.set(id, { commandId: ack.commandId, leaseEpoch: ack.leaseEpoch, result: ack.result });
  }

  private retry(error: unknown): SyncOutcome {
    const delayMs = backoffDelay(this.failures, this.deps.random);
    this.failures += 1;
    this.deps.log.warn('sync failed; backing off', { error: errorMessage(error), delayMs });
    return { kind: 'retry', delayMs };
  }
}
```

- [ ] **Step 4: Run and lint**

```bash
cd apps/runner && bun test src/sync && bun run type-check && bun run lint
```
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/runner
git commit -m "feat(fleet): runner sync loop (abort on write, backoff, 426/401 stop, batch halving, capabilities retry)"
```

---

### Task 11: Verdict and snapshot mapping (pure)

**Files:**
- Create: `apps/runner/src/prd.ts`, `apps/runner/src/prd.spec.ts`
- Create: `apps/runner/src/verdict/status-view.ts`, `run-verdict.ts`, `plan-verdict.ts`, `verdict.spec.ts`
- Create: `apps/runner/src/watcher/status-snapshot.ts`, `status-snapshot.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  // prd.ts
  export interface PrdInfo { readonly stories: number; readonly branchName: string | null }
  export function parsePrd(text: string): PrdInfo | null;              // null: not a JSON object; stories = userStories.length or 0; branchName trimmed non-empty string or null
  // verdict/status-view.ts
  export interface FinishView { readonly status?: string; readonly result?: string; readonly url?: string; readonly escalationReason?: string }
  export interface StatusView {
    readonly run: { readonly id: string; readonly status: string; readonly pid?: number };
    readonly progress?: Readonly<Record<string, number>>;
    readonly cost?: { readonly spent?: number };
    readonly current?: { readonly storyId?: string; readonly phase?: string } | null;
    readonly lastHeartbeat?: string;
    readonly updatedAt?: string;
    readonly postRun?: { readonly finish?: FinishView };
  }
  export function parseStatusView(raw: unknown): StatusView | null;    // null unless run.id and run.status are strings
  export const isFinalStatus: (status: StatusView) => boolean;         // run.status !== 'running'
  // verdict/run-verdict.ts, plan-verdict.ts
  export type VerdictState = 'COMPLETED' | 'FAILED' | 'ESCALATED' | 'CANCELLED';
  export interface Verdict { readonly state: VerdictState; readonly reason: string | null }
  export function runVerdict(input: { cancelRequested: boolean; status: StatusView | null }): Verdict;
  export interface PlanCheck { readonly ok: boolean; readonly reason: string | null; readonly branchName: string | null }
  export function checkPlanPrd(text: string | null): PlanCheck;
  export function planVerdict(input: { cancelRequested: boolean; check: PlanCheck }): Verdict;
  // watcher/status-snapshot.ts
  export interface SnapshotExtras { readonly logRunId?: string | null; readonly costRunId?: string | null; readonly resultBranch?: string; readonly resultSha?: string; readonly droppedLogs?: number }
  export function mapStatusToSnapshot(status: StatusView, extras?: SnapshotExtras): SnapshotEventPayload;   // escalationReason cut to 2,000 characters (D59)
  export function formatCost(spent: unknown): string | undefined;      // finite, 0 <= x < 1e8 -> toFixed(4)
  export function readStatusFile(path: string): Promise<{ status: StatusView | null; problem: 'missing' | 'invalid' | null }>;
  ```

- [ ] **Step 1: Write the failing specs**

`prd.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { parsePrd } from './prd';

describe('parsePrd', () => {
  test('reads the story count and the branch name', () => {
    expect(parsePrd('{"branchName":" feat/x ","userStories":[{"id":"US-001"},{"id":"US-002"}]}')).toEqual({ stories: 2, branchName: 'feat/x' });
  });
  test('missing or non-string branch names are null, missing stories are 0', () => {
    expect(parsePrd('{}')).toEqual({ stories: 0, branchName: null });
    expect(parsePrd('{"branchName":7,"userStories":"x"}')).toEqual({ stories: 0, branchName: null });
    expect(parsePrd('{"branchName":"  "}')).toEqual({ stories: 0, branchName: null });
  });
  test.each(['', 'not json', '[]', '"s"', 'null', '7'])('%j is not a PRD object', (text) => {
    expect(parsePrd(text)).toBeNull();
  });
});
```

`verdict/verdict.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { checkPlanPrd, planVerdict } from './plan-verdict';
import { runVerdict } from './run-verdict';
import { isFinalStatus, parseStatusView, type StatusView } from './status-view';

const status = (runStatus: string, finish?: StatusView['postRun'] extends infer P ? (P extends { finish?: infer F } ? F : never) : never): StatusView => ({
  run: { id: 'run-1', status: runStatus }, ...(finish ? { postRun: { finish } } : {}),
});

describe('runVerdict (S1 spec §5.2 step 6, first matching row wins)', () => {
  test('cancel comes first, whatever nax wrote (SIGTERM makes nax write crashed)', () => {
    expect(runVerdict({ cancelRequested: true, status: status('crashed') })).toEqual({ state: 'CANCELLED', reason: null });
    expect(runVerdict({ cancelRequested: true, status: null })).toEqual({ state: 'CANCELLED', reason: null });
    expect(runVerdict({ cancelRequested: true, status: status('completed', { status: 'passed', result: 'opened' }) }).state).toBe('CANCELLED');
  });
  test('an escalated finish is ESCALATED with nax reason, even when the run failed', () => {
    expect(runVerdict({ cancelRequested: false, status: status('completed', { status: 'passed', result: 'escalated', escalationReason: 'review blocked' }) })).toEqual({ state: 'ESCALATED', reason: 'review blocked' });
    expect(runVerdict({ cancelRequested: false, status: status('failed', { result: 'escalated' }) })).toEqual({ state: 'ESCALATED', reason: 'escalated' });
  });
  test.each([
    ['no finish block', undefined],
    ['finish skipped', { status: 'skipped', reason: 'branch' }],
    ['opened', { status: 'passed', result: 'opened' }],
    ['promoted', { status: 'passed', result: 'promoted' }],
    ['already-ready', { status: 'passed', result: 'already-ready' }],
    ['nothing-to-finish', { status: 'passed', result: 'nothing-to-finish' }],
  ])('completed with %s is COMPLETED', (_label, finish) => {
    expect(runVerdict({ cancelRequested: false, status: status('completed', finish as never) })).toEqual({ state: 'COMPLETED', reason: null });
  });
  test('a completed run whose finish failed is FAILED with that fact', () => {
    expect(runVerdict({ cancelRequested: false, status: status('completed', { status: 'failed' }) })).toEqual({ state: 'FAILED', reason: 'finish failed' });
  });
  test.each(['failed', 'stalled', 'crashed', 'precheck-failed', 'cost-limit', 'aborted', 'running'])('run status %s is FAILED with the status as reason', (s) => {
    expect(runVerdict({ cancelRequested: false, status: status(s) })).toEqual({ state: 'FAILED', reason: `run status: ${s}` });
  });
  test('no status.json is FAILED', () => {
    expect(runVerdict({ cancelRequested: false, status: null })).toEqual({ state: 'FAILED', reason: 'no status.json' });
  });
});

describe('checkPlanPrd and planVerdict', () => {
  test('a valid PRD passes and carries its branch name', () => {
    expect(checkPlanPrd('{"branchName":"feat/x","userStories":[{"id":"US-001"}]}')).toEqual({ ok: true, reason: null, branchName: 'feat/x' });
  });
  test.each([
    [null, 'no prd.json produced'],
    ['nope', 'prd.json is not valid JSON'],
    ['{"userStories":[]}', 'prd.json has no userStories'],
    ['{"branchName":"b"}', 'prd.json has no userStories'],
  ])('%j fails with %s', (text, reason) => {
    expect(checkPlanPrd(text)).toMatchObject({ ok: false, reason });
  });
  test('cancel wins, then failure, then success', () => {
    const good = checkPlanPrd('{"userStories":[{"id":"a"}]}');
    const bad = checkPlanPrd(null);
    expect(planVerdict({ cancelRequested: true, check: good })).toEqual({ state: 'CANCELLED', reason: null });
    expect(planVerdict({ cancelRequested: false, check: bad })).toEqual({ state: 'FAILED', reason: 'no prd.json produced' });
    expect(planVerdict({ cancelRequested: false, check: good })).toEqual({ state: 'COMPLETED', reason: null });
  });
});

describe('parseStatusView', () => {
  test('keeps the fields the runner uses and drops the rest', () => {
    const view = parseStatusView({
      version: 1, run: { id: 'run-1', status: 'running', pid: 42, feature: 'x' }, progress: { total: 3, passed: 1, note: 'x' }, cost: { spent: 1.5, limit: null },
      current: { storyId: 'US-001', phase: 'implement', title: 't' }, lastHeartbeat: '2026-10-01T00:00:00.000Z', updatedAt: 'u',
      postRun: { finish: { status: 'passed', result: 'opened', url: 'https://x/pr/1', extra: 1 } },
    });
    expect(view).toEqual({
      run: { id: 'run-1', status: 'running', pid: 42 }, progress: { total: 3, passed: 1 }, cost: { spent: 1.5 },
      current: { storyId: 'US-001', phase: 'implement' }, lastHeartbeat: '2026-10-01T00:00:00.000Z', updatedAt: 'u',
      postRun: { finish: { status: 'passed', result: 'opened', url: 'https://x/pr/1' } },
    });
  });
  test('current null is preserved; missing run.id or run.status is not a status file', () => {
    expect(parseStatusView({ run: { id: 'r', status: 'completed' }, current: null })?.current).toBeNull();
    for (const raw of [null, [], {}, { run: {} }, { run: { id: 'r' } }, { run: { id: 1, status: 's' } }]) expect(parseStatusView(raw)).toBeNull();
  });
  test('isFinalStatus is everything but running', () => {
    expect(isFinalStatus({ run: { id: 'r', status: 'running' } })).toBe(false);
    expect(isFinalStatus({ run: { id: 'r', status: 'crashed' } })).toBe(true);
  });
});
```

`watcher/status-snapshot.spec.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import type { StatusView } from '../verdict/status-view';
import { formatCost, mapStatusToSnapshot, readStatusFile } from './status-snapshot';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

const status: StatusView = {
  run: { id: 'run-2026-10-01T00-00-00-000Z', status: 'running' },
  progress: { total: 3, passed: 1, failed: 0, paused: 0, blocked: 0, pending: 2 },
  cost: { spent: 1.23456 }, current: { storyId: 'US-002', phase: 'implement' }, lastHeartbeat: '2026-10-01T00:01:00.000Z',
};

describe('mapStatusToSnapshot (slice 3 design §1.3)', () => {
  test('maps run id, progress, story, phase, cost and heartbeat', () => {
    expect(mapStatusToSnapshot(status, { logRunId: 'log-7', costRunId: 'cost-7' })).toEqual({
      naxRunId: 'run-2026-10-01T00-00-00-000Z', naxLogRunId: 'log-7', naxCostRunId: 'cost-7',
      progress: { total: 3, passed: 1, failed: 0, paused: 0, blocked: 0, pending: 2 },
      currentStoryId: 'US-002', currentPhase: 'implement', costSpentUsd: '1.2346', heartbeatAt: '2026-10-01T00:01:00.000Z',
    });
  });
  test('omits absent run ids, sends null story/phase between stories, and drops an unparseable heartbeat', () => {
    const snap = mapStatusToSnapshot({ run: { id: 'r', status: 'running' }, current: null, lastHeartbeat: 'garbage' });
    expect(snap).toEqual({ naxRunId: 'r', currentStoryId: null, currentPhase: null });
  });
  test('maps the finish block and the extras', () => {
    const snap = mapStatusToSnapshot(
      { run: { id: 'r', status: 'completed' }, postRun: { finish: { status: 'passed', result: 'opened', url: 'https://github.com/a/b/pull/1' } } },
      { resultBranch: 'feat/x', resultSha: 'a'.repeat(40), droppedLogs: 4 },
    );
    expect(snap).toMatchObject({ finishResult: 'opened', resultPrUrl: 'https://github.com/a/b/pull/1', resultBranch: 'feat/x', resultSha: 'a'.repeat(40), droppedLogs: 4 });
    const esc = mapStatusToSnapshot({ run: { id: 'r', status: 'completed' }, postRun: { finish: { result: 'escalated', escalationReason: 'blocked' } } });
    expect(esc).toMatchObject({ finishResult: 'escalated', escalationReason: 'blocked' });
    expect(esc).not.toHaveProperty('resultPrUrl');
  });
  test('escalationReason is cut to the server limit of 2,000 characters, never inside a surrogate pair (D59)', () => {
    const long = mapStatusToSnapshot({ run: { id: 'r', status: 'completed' }, postRun: { finish: { result: 'escalated', escalationReason: 'x'.repeat(5_000) } } });
    expect(long.escalationReason).toHaveLength(2_000);
    const pair = mapStatusToSnapshot({ run: { id: 'r', status: 'completed' }, postRun: { finish: { result: 'escalated', escalationReason: `${'y'.repeat(1_999)}\u{1F600}` } } });
    expect(pair.escalationReason).toBe('y'.repeat(1_999));
  });
  test('zero dropped logs are not reported', () => {
    expect(mapStatusToSnapshot({ run: { id: 'r', status: 'running' } }, { droppedLogs: 0 })).not.toHaveProperty('droppedLogs');
  });
});

describe('formatCost', () => {
  test.each([[0, '0.0000'], [1.5, '1.5000'], [0.00004, '0.0000'], [12.34567, '12.3457'], [99999999, '99999999.0000']])('%p -> %p', (input, out) => {
    expect(formatCost(input)).toBe(out);
  });
  test.each([[-1], [NaN], [Infinity], ['1'], [null], [undefined], [1e8]])('%p is dropped', (input) => {
    expect(formatCost(input)).toBeUndefined();
  });
});

describe('readStatusFile', () => {
  test('missing, invalid and valid files are told apart', async () => {
    const dir = await tmp.make('status');
    expect(await readStatusFile(join(dir, 'status.json'))).toEqual({ status: null, problem: 'missing' });
    await writeFile(join(dir, 'status.json'), '{"run":');
    expect(await readStatusFile(join(dir, 'status.json'))).toEqual({ status: null, problem: 'invalid' });
    await writeFile(join(dir, 'status.json'), JSON.stringify({ run: { id: 'r', status: 'running' } }));
    expect(await readStatusFile(join(dir, 'status.json'))).toEqual({ status: { run: { id: 'r', status: 'running' } }, problem: null });
    await mkdir(join(dir, 'sub'));
    expect((await readStatusFile(join(dir, 'sub'))).problem).toBe('invalid');
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/runner && bun test src/prd.spec.ts src/verdict src/watcher`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/prd.ts`:

```ts
export interface PrdInfo {
  readonly stories: number;
  readonly branchName: string | null;
}

export function parsePrd(text: string): PrdInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const branch = typeof record['branchName'] === 'string' ? record['branchName'].trim() : '';
  return { stories: Array.isArray(record['userStories']) ? record['userStories'].length : 0, branchName: branch === '' ? null : branch };
}
```

`verdict/status-view.ts`:

```ts
export interface FinishView {
  readonly status?: string;
  readonly result?: string;
  readonly url?: string;
  readonly escalationReason?: string;
}

export interface StatusView {
  readonly run: { readonly id: string; readonly status: string; readonly pid?: number };
  readonly progress?: Readonly<Record<string, number>>;
  readonly cost?: { readonly spent?: number };
  readonly current?: { readonly storyId?: string; readonly phase?: string } | null;
  readonly lastHeartbeat?: string;
  readonly updatedAt?: string;
  readonly postRun?: { readonly finish?: FinishView };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const defined = <T extends Obj>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** A structural read of nax's `status.json` (src/execution/status-file.ts); unknown fields are dropped. */
export function parseStatusView(raw: unknown): StatusView | null {
  if (!isObj(raw) || !isObj(raw['run']) || typeof raw['run']['id'] !== 'string' || typeof raw['run']['status'] !== 'string') return null;
  const run = raw['run'];
  const progress = isObj(raw['progress'])
    ? (Object.fromEntries(Object.entries(raw['progress']).filter(([, v]) => typeof v === 'number')) as Record<string, number>)
    : undefined;
  const cost = isObj(raw['cost']) && typeof raw['cost']['spent'] === 'number' ? { spent: raw['cost']['spent'] } : undefined;
  const current = raw['current'] === null ? null : isObj(raw['current']) ? defined({ storyId: str(raw['current']['storyId']), phase: str(raw['current']['phase']) }) : undefined;
  const finishRaw = isObj(raw['postRun']) && isObj(raw['postRun']['finish']) ? raw['postRun']['finish'] : undefined;
  const finish = finishRaw ? defined({ status: str(finishRaw['status']), result: str(finishRaw['result']), url: str(finishRaw['url']), escalationReason: str(finishRaw['escalationReason']) }) : undefined;
  return defined({
    run: defined({ id: run['id'] as string, status: run['status'] as string, pid: typeof run['pid'] === 'number' ? run['pid'] : undefined }),
    progress, cost, current, lastHeartbeat: str(raw['lastHeartbeat']), updatedAt: str(raw['updatedAt']), postRun: finish ? { finish } : undefined,
  }) as StatusView;
}

export const isFinalStatus = (status: StatusView): boolean => status.run.status !== 'running';
```

`verdict/run-verdict.ts`:

```ts
import type { StatusView } from './status-view';

export type VerdictState = 'COMPLETED' | 'FAILED' | 'ESCALATED' | 'CANCELLED';

export interface Verdict {
  readonly state: VerdictState;
  readonly reason: string | null;
}

const COMPLETING_RESULTS: ReadonlySet<string> = new Set(['opened', 'promoted', 'already-ready', 'nothing-to-finish']);

/** S1 spec §5.2 step 6 (slice 3 design §2 step 7): first matching row wins; the exit code is never consulted. */
export function runVerdict(input: { cancelRequested: boolean; status: StatusView | null }): Verdict {
  if (input.cancelRequested) return { state: 'CANCELLED', reason: null };
  const { status } = input;
  if (!status) return { state: 'FAILED', reason: 'no status.json' };
  const finish = status.postRun?.finish;
  if (finish?.result === 'escalated') return { state: 'ESCALATED', reason: finish.escalationReason ?? 'escalated' };
  if (status.run.status === 'completed') {
    if (!finish || finish.status === 'skipped' || (finish.result !== undefined && COMPLETING_RESULTS.has(finish.result))) {
      return { state: 'COMPLETED', reason: null };
    }
    return { state: 'FAILED', reason: `finish ${finish.status ?? 'unknown'}` };
  }
  return { state: 'FAILED', reason: `run status: ${status.run.status}` };
}
```

`verdict/plan-verdict.ts`:

```ts
import { parsePrd } from '../prd';
import type { Verdict } from './run-verdict';

export interface PlanCheck {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly branchName: string | null;
}

/** nax can exit 0 after writing an invalid PRD, so the file is checked, not the exit code (S1 spec §5.2). */
export function checkPlanPrd(text: string | null): PlanCheck {
  if (text === null) return { ok: false, reason: 'no prd.json produced', branchName: null };
  const prd = parsePrd(text);
  if (!prd) return { ok: false, reason: 'prd.json is not valid JSON', branchName: null };
  if (prd.stories === 0) return { ok: false, reason: 'prd.json has no userStories', branchName: prd.branchName };
  return { ok: true, reason: null, branchName: prd.branchName };
}

export function planVerdict(input: { cancelRequested: boolean; check: PlanCheck }): Verdict {
  if (input.cancelRequested) return { state: 'CANCELLED', reason: null };
  return input.check.ok ? { state: 'COMPLETED', reason: null } : { state: 'FAILED', reason: input.check.reason };
}
```

`watcher/status-snapshot.ts`:

```ts
import { readFile } from 'node:fs/promises';
import type { SnapshotEventPayload } from '@nathapp/fleet-protocol';
import { parseStatusView, type StatusView } from '../verdict/status-view';

export interface SnapshotExtras {
  readonly logRunId?: string | null;
  readonly costRunId?: string | null;
  readonly resultBranch?: string;
  readonly resultSha?: string;
  readonly droppedLogs?: number;
}

/** Decimal string with at most 4 fraction digits, the server's COST_RE (`event-payloads.ts`). */
export function formatCost(spent: unknown): string | undefined {
  if (typeof spent !== 'number' || !Number.isFinite(spent) || spent < 0 || spent >= 1e8) return undefined;
  return spent.toFixed(4);
}

/** The server's `escalationReason` limit (`event-payloads.ts`: `str(p.escalationReason, 2_000)`); a longer one would 400 the whole event. */
const ESCALATION_REASON_MAX = 2_000;

function clip(text: string | undefined, max: number): string | undefined {
  if (text === undefined || text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max); // never leave half a surrogate pair
}

export function mapStatusToSnapshot(status: StatusView, extras: SnapshotExtras = {}): SnapshotEventPayload {
  const finish = status.postRun?.finish;
  const heartbeat = status.lastHeartbeat !== undefined && !Number.isNaN(Date.parse(status.lastHeartbeat)) ? status.lastHeartbeat : undefined;
  const cost = formatCost(status.cost?.spent);
  const entries: Array<[string, unknown]> = [
    ['naxRunId', status.run.id],
    ['naxLogRunId', extras.logRunId ?? undefined],
    ['naxCostRunId', extras.costRunId ?? undefined],
    ['progress', status.progress],
    ['currentStoryId', status.current?.storyId ?? null],
    ['currentPhase', status.current?.phase ?? null],
    ['costSpentUsd', cost],
    ['heartbeatAt', heartbeat],
    ['finishResult', finish?.result],
    ['resultPrUrl', finish?.url],
    ['escalationReason', clip(finish?.escalationReason, ESCALATION_REASON_MAX)],
    ['resultBranch', extras.resultBranch],
    ['resultSha', extras.resultSha],
    ['droppedLogs', extras.droppedLogs && extras.droppedLogs > 0 ? extras.droppedLogs : undefined],
  ];
  return Object.fromEntries(entries.filter(([, v]) => v !== undefined)) as SnapshotEventPayload;
}

export async function readStatusFile(path: string): Promise<{ status: StatusView | null; problem: 'missing' | 'invalid' | null }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return { status: null, problem: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid' };
  }
  try {
    const status = parseStatusView(JSON.parse(text));
    return status ? { status, problem: null } : { status: null, problem: 'invalid' };
  } catch {
    return { status: null, problem: 'invalid' };
  }
}
```

- [ ] **Step 4: Run and lint**

```bash
cd apps/runner && bun test src && bun run type-check && bun run lint
```
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/runner
git commit -m "feat(fleet): runner verdicts (S1 table, PLAN check) and status.json snapshot mapping"
```

---


### Task 11b: Repo wiring, gates, PR text (3a-1)

**Files:**
- Create: `.nax/mono/apps/runner/context.md`, `.nax/mono/apps/runner/config.json`
- Modify: `.nax/context.md` (monorepo tree, `.nax/mono` line, "Workspace Responsibilities", "App-Specific Contexts")
- Modify: generated agent files (`nax generate`, `nax generate --all-packages`)
- No change to `.github/workflows/ci.yml` and none to `bun.lock` (unless a dependency changed since Task 5): the runner integration CI step, the compile script and the binary smoke belong to 3a-2.

**Interfaces:** none new; this task wires the app into the repo the way `apps/cli` and `apps/web` are wired (`type-check`, `lint` and the unit `test` join the existing turbo jobs automatically because `apps/runner` has those scripts).

- [ ] **Step 1: The per-app nax config**

`.nax/mono/apps/runner/config.json` mirrors the shape of `.nax/mono/apps/cli/config.json` but uses bun test commands, not the jest `test:scoped` wrapper (there is no `build` script; `type-check` is the closest gate):

```json
{
  "quality": {
    "commands": {
      "build": "bun run type-check",
      "test": "bun run test",
      "testScoped": "bun test {{files}}",
      "typecheck": "bun run type-check",
      "lint": "bun run lint:json-error",
      "lintFix": "bun run lint:fix",
      "formatFix": "bun run lint:fix"
    }
  },
  "execution": {
    "smartTestRunner": {
      "testFilePatterns": [
        "**/*.spec.ts",
        "**/*.integration.spec.ts",
        "**/*.test.ts"
      ]
    }
  }
}
```

- [ ] **Step 2: The per-app context**

`.nax/mono/apps/runner/context.md` (3a-2 extends the architecture block and the rules when the executor, supervisor and CLI land):

````markdown
# Koda Runner Context

This is the app-specific source-of-truth context for `apps/runner` (`@nathapp/koda-runner`).

## Role In The Monorepo

`apps/runner` is the fleet runner daemon. It enrolls with the koda API, long-polls `POST /fleet/runner/sync`, runs `nax run` / `nax plan` jobs on a host checkout, reports progress and a verdict, uploads the run bundle and re-adopts running jobs after a restart. This first slice holds the foundations: config, identity, journal, server client, sync loop and the pure verdict and snapshot mapping.

It should not:
- talk to the server from anywhere but `src/sync/` (other modules write journal events; the sync loop ships them)
- decide a job's outcome from an exit code (nax exits 0 on failure; verdicts come from `status.json` and files)
- hold git or provider credentials in 3a (3b adds the git-cred broker)

## Stack

- Bun-only ESM (`bun:sqlite`, `Bun.spawn`, `bun test`), TypeScript strict, commander 12
- `@nathapp/fleet-protocol` for wire types (the API imports it with `import type` only)
- `bun build --compile` per platform (script arrives with the CLI; deliberately not a `build` script)

## Architecture

```text
src/main.ts          koda-runner entry (commands arrive with the CLI)
src/config/          runner.json (https unless loopback or allowInsecureHttp; capabilities block shape-checked)
src/identity/        identity.json (0600) and the per-start boot id
src/journal/         bun:sqlite, WAL, synchronous FULL; every row is written BEFORE the send that reports it
src/sync/            ServerClient, batching (one entry per jobId, 1 MiB budget), SyncLoop (abort only an idle poll, backoff, 426/401 stop)
src/verdict/         pure verdict functions (S1 spec 5.2 step 6)
src/watcher/         status.json to snapshot mapping (the watcher itself arrives with the executor)
src/paths/           safe path segments
```

## Rules

- Every path segment (owner, repo, feature, job id, planFrom) goes through `paths/safe-segment.ts`; never build a path from server data by string concatenation.
- `seq` is per (jobId, leaseEpoch), contiguous from 1; a rejected event is replaced, never deleted (a hole stalls the job's ack).
- The sync request carries one entry per jobId (the server 400s a duplicate) and stays under the body budget.
- Never log or persist the runner API key outside `identity.json`; the `Logger` redacts secret-looking keys.
- No `console.log` outside `src/main.ts` and `src/logger.ts`.

## Testing

- Unit specs are `src/**/*.spec.ts`; run `bun run test` (no database).
- Integration specs (`test/integration/*.integration.spec.ts`, 3a-2) need `KODA_DB_TESTS=1`, the test Postgres and a built API.
- Prefer real files and real SQLite (`:memory:` or a temp file) over mocks; the sync loop takes an injected client.

## Generated Files

`AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and `codex.md` in this app are generated by `nax generate` from this file; do not edit them.
````

- [ ] **Step 3: The root context**

In `.nax/context.md`: in the `Monorepo Shape` tree add `│   ├── runner/  # Bun fleet runner daemon (executes nax jobs)` between `cli/` (line 21) and `web/`; change `mono/apps/{api,cli,web}/context.md` (line 29) to `mono/apps/{api,cli,runner,web}/context.md`; add a "Workspace Responsibilities" entry after `apps/cli`:

```markdown
### `apps/runner`
- fleet runner daemon: runs nax jobs dispatched by the API on a host checkout
- talks only to `/fleet/runner/*` and the bundle upload; never embeds business rules
- Bun-only; see `.nax/mono/apps/runner/context.md`
```
and in "App-Specific Contexts" (around line 153) add `- \`.nax/mono/apps/runner/context.md\``.

- [ ] **Step 4: Generate the agent files and check what changed**

```bash
nax generate
nax generate --all-packages
git status --short | head -20
```
Expected: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `codex.md` at the root updated, and the four files created under `apps/runner/`; no other app's generated files change (if an `apps/api`, `apps/cli` or `apps/web` generated file shows a diff, the generator version differs from the one that produced the committed files: do not commit that hunk; stop and look, and never run `git checkout` in this checkout). `nax generate` is local and free; do not run `nax run` or `nax plan`.

- [ ] **Step 5: Full gates**

```bash
bun install --frozen-lockfile
bun run type-check
bun run lint
bunx turbo run test
cd apps/api && bun run test:scoped test/integration/fleet test/integration/openapi-spec test/integration/openapi-client && cd ../..
cd apps/runner && bun run test && cd ../..
git add openapi.json && bun run generate && git diff --exit-code openapi.json
```
Expected: all green; the second `generate` leaves `openapi.json` unchanged (`test:scoped` sets `KODA_DB_TESTS=1` for integration paths; the DB is up from Task 0). Record counts against the Task 0 baseline: api unit, api integration (Task 3's cases are the only DB work in this plan), runner unit.

- [ ] **Step 6: Diff review**

```bash
git diff --stat 32b543d0...HEAD
```
Expected files only: the plan document (docs/superpowers/plans), `packages/fleet-protocol/src/index.ts`, `apps/api/src/{fleet,auth}/**` and `apps/api/test/**`, `openapi.json`, `apps/runner/**`, `bun.lock`, `.nax/context.md`, `.nax/mono/apps/runner/*`, the generated agent files. Anything else is unintended. Also run:

```bash
git diff --name-only 32b543d0 -- apps/runner/src | xargs grep -n "console\.log" || true
git diff 32b543d0 -- apps/runner apps/api | grep -nE "kr_[0-9a-f]{20}|ghs_|BEGIN (RSA )?PRIVATE" || true
```
Expected: no `console.log` outside `src/main.ts` and `src/logger.ts` (both use `process.std*` writes, so none at all); no key-looking literals other than obvious test fixtures.

- [ ] **Step 7: Review before push**

Dispatch a code reviewer over `git diff 32b543d0...HEAD` with this plan's Review Focus list, the decision register and the slice 3 design as the brief (repo rule: review before push). Fix CRITICAL and HIGH findings, then re-run Step 5.

- [ ] **Step 8: Commit, and stop before pushing**

```bash
git add .nax apps/runner AGENTS.md CLAUDE.md GEMINI.md codex.md bun.lock
git commit -m "chore(fleet): runner repo wiring (nax context and config, generated agent files)"
```
Never push (`.nax/rules/common.md`): a human reviews and pushes. The PR:

Title: `feat(fleet): S1 slice 3a-1 — protocol v1 credentials, #157, runner foundations`

```markdown
## Summary
Fleet S1 slice 3a-1 — protocol and runner foundations (design `docs/superpowers/specs/2026-09-30-fleet-s1-slice-3-runner-design.md`, plan `docs/superpowers/plans/2026-09-30-fleet-s1-slice-3a-1-runner-foundations.md`). Slice 3a-2 (git, executor, watcher, bundle, supervisor, daemon, CLI, integration) follows on its own branch.

- Protocol v1: `RunnerCapabilities.credentials` mirrors `nax auth list --json` (R-3.2); `stored` is required (object or null); validator, placement (`provider_unavailable`, `provider_expired` removed), DTO enum, openapi.
- #157: runner capacity on `/fleet/runner/me`; `ke_` prefix check on enroll.
- `apps/runner` (`@nathapp/koda-runner`): scaffold, logger, safe path segments, config (capabilities block shape-checked), identity, bun:sqlite journal (synchronous FULL, notify after commit), server client, body-budgeted batching (one entry per job), sync loop (abort only an idle poll, halving batches, capabilities and command-ack retries), verdict and snapshot mapping. Unit-tested, database-free.
- Repo wiring: nax context and config for `apps/runner`, generated agent files.

Closes #157.

## Decisions
D21-D59 in the plan (the decision register; 3a-2 continues at D60).

## Out of scope
3a-2 (git workspace, executor, watcher, bundle, supervisor, daemon, CLI, integration harness and scenarios, compile script, CI runner-integration step) and 3b (git-cred socket, credential helper, gh/glab shims, `NaxCapabilityProbe`, `install-service`, live check).
```

---

## Self-review (3a-1)

- **Spec coverage (slice 3 design, the 3a-1 part):** R-3.2 -> Tasks 1-2, 4 (shape, validator with `stored` required, placement `provider_unavailable`, contract regenerated in Task 2 and again in Task 4 for the `/me` description). §1.2 (#157) -> Task 3 (+ Task 4 contract). §1 package scaffold -> Task 5; foundations, config, identity -> Tasks 6-7; §1.4 journal -> Task 8 (D23, D24 support, D55); §1.3 client and rules (envelope, timeouts, backoff, batch limits, halving, 426/401, capabilities retry, ack cursor per reported epoch) -> Tasks 9-10 (D25, D26, D56-D59); status.json mapping and verdict table -> Task 11. R-3.1, R-3.3..R-3.7, §2 and §4 (executor, git, PLAN commit, bundle, supervisor, daemon, CLI, harness, scenarios) are 3a-2 and 3b; their decisions (D28-D54) are registered here so 3a-2 can cite them, and the tasks that use them say so.
- **Placeholder scan:** no open placeholders or "similar to" in Tasks 0-11b; every step has code or an exact command.
- **Type consistency:** `RunnerCredential` (Task 1) is consumed by placement (Task 2), the runner config (Task 7) and the sync request types (Tasks 9-10); `JobRow` and `CommandRecord` (Task 8) are the only journal shapes Tasks 9-10 use (`jobsWithPending`, `pendingEvents`, `ackThrough`, `replaceEvent`, `onWrite`); `StatusView` (Task 11) is the only status shape `mapStatusToSnapshot` and the verdict functions read; `clampAck` (Task 9) is used by `SyncLoop` (Task 10) and is exported for the 3a-2 command handler.
- **Review Focus mapping:** 1 (hostile segment, malformed config) -> Tasks 6, 7. 2 (unreachable or rejecting server) -> Tasks 9-10 (D24, D25, D56-D58). 3 (crash between persist and send) -> Task 8 (`synchronous = FULL`, notify after commit). 4 (credential the server would reject) -> Tasks 1-2. The restart, hostile-ASSIGN, stale-runner and same-repo focus items are 3a-2.
- **Server file:line citations** were checked at `32b543d0` (server code is identical to `fa721a30`; only two spec documents differ): `capabilities.ts` credential parsing, `placement-rules.ts:4-11,41-57`, `dto/fleet-job.dto.ts:66`, `koda-principal.types.ts:27-37`, `combined-auth.guard.ts:110-135`, `runner-api.controller.ts:32-37`, `enrollment.service.ts:46-50`, `prisma-auth.repository.ts:99-105`, `auth.domain.ts:22-27`, `sync-request.parser.ts:54,71` (ack detail 500, `duplicate job`), `event-payloads.ts` (`escalationReason` 2,000), `bundle.service.ts:15` (`UPLOAD_STATES`).
