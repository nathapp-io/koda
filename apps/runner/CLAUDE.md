# Project Context

This file is auto-generated from `.nax/context.md`.
DO NOT EDIT MANUALLY — run `nax generate` to regenerate.

---

## Project Metadata

> Auto-injected by `nax generate`

**Project:** `@nathapp/koda-runner`

**Language:** TypeScript

**Key dependencies:** @prisma/client, @nathapp/typescript-config, @types/bun, typescript

**Commands:** test: `npx turbo test` | lint: `bunx turbo lint` | typecheck: `bunx turbo type-check`

---
# Koda Runner Context

This is the app-specific source-of-truth context for `apps/runner` (`@nathapp/koda-runner`).

## Role In The Monorepo

`apps/runner` is the fleet runner daemon. It enrolls with the koda API, long-polls `POST /fleet/runner/sync`, runs `nax run` / `nax plan` jobs on a host checkout, reports progress and a verdict, uploads the run bundle and re-adopts running jobs after a restart. The foundations (config, identity, journal, server client, sync loop, verdicts) sit beside the execution half: git workspace, executor, watcher, bundle, supervisor, daemon and the CLI.

It should not:
- talk to the server from anywhere but `src/sync/` (other modules write journal events; the sync loop ships them)
- decide a job's outcome from an exit code (nax exits 0 on failure; verdicts come from `status.json` and files)
- hold git or provider credentials in 3a (3b adds the git-cred broker; a clone or push authentication failure fails the job with `no git credentials (runner 3b)`, and git never prompts)

## Stack

- Bun-only ESM (`bun:sqlite`, `Bun.spawn`, `bun test`), TypeScript strict, commander 12
- `@nathapp/fleet-protocol` for wire types (the API imports it with `import type` only)
- compiled with `bun build --compile` (`bun run build:binary`; deliberately not a `build` script)

## Architecture

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

## Rules

- Every path segment (owner, repo, feature, job id, planFrom) goes through `paths/safe-segment.ts`; never build a path from server data by string concatenation.
- `seq` is per (jobId, leaseEpoch), contiguous from 1; a rejected event is replaced, never deleted (a hole stalls the job's ack).
- The sync request carries one entry per jobId (the server 400s a duplicate) and stays under the body budget.
- Never log or persist the runner API key outside `identity.json`; the `Logger` redacts secret-looking keys.
- No `console.log` outside `src/main.ts` and `src/logger.ts`.
- Emit only the S1 spec 5.4 runner transitions (`JobEvents.transition` refuses the rest). A spawned job always goes RUNNING -> UPLOADING -> terminal; a job that never spawned goes ASSIGNED -> FAILED or CANCELLED.
- The nax child is detached (own process group) and its output goes to files, so it survives a daemon restart. `stop()` never signals a child. Signal only `-pgid`, and only after `matchesProcess` confirms the pid is still this job (argv carries `koda-job-<jobId>`).
- `git clean` has no `-x`: ignored nax files (`checkpoint.jsonl`) must survive between runs; `plan/` is ignored too, so prepare deletes stale `plan/*.jsonl` itself.
- git runs with `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_ASKPASS=true` and an empty credential helper; the daemon refuses git older than 2.30.
- `plan-out/` (the PLAN stash) is write-once: a retry never re-reads the checkout that `checkout -f -B` may have reverted.
- Two epochs of one job id can coexist on a runner: abandoning the lower one never reaps or cleans while a live higher epoch exists.
- Timing constants live in `src/daemon/tuning.ts`; only tests override them. In tests an `expect` inside a callback that a `try/catch` swallows proves nothing.

## Testing

- Unit specs are `src/**/*.spec.ts`; run `bun run test` (no database).
- Integration specs (`test/integration/*.integration.spec.ts`, 3a-2) need `KODA_DB_TESTS=1`, the test Postgres and a built API.
- Prefer real files and real SQLite (`:memory:` or a temp file) over mocks; the sync loop takes an injected client.
- Specs that need real git and the fake nax are `test/unit/*.spec.ts`; `test/fixtures/fake-nax.ts` is the fake nax (scenarios via `FAKE_NAX_*` env; a failed run exits 1 like the real one, and the verdict never reads the exit code). Real git runs in tests, isolated by `isolateGit()`.
- Integration specs run the built API against their own database `koda_runner_test`: `cd apps/runner && KODA_DB_TESTS=1 bun run test:integration`. `daemon.crash()` is the in-process kill; `TestRunner.net` cuts the network (`down`, or `dropResponse` to lose only the answers).
- Use `FakeExecutor` only for `JobRun` and `Supervisor` state-machine tests.

## Generated Files

`AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and `codex.md` in this app are generated by `nax generate` from this file; do not edit them.
