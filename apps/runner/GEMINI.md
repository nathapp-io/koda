# Gemini CLI Context

This file is auto-generated from `.nax/context.md`.
DO NOT EDIT MANUALLY — run `nax generate` to regenerate.

---

## Project Metadata

> Auto-injected by `nax generate`

**Project:** `@nathapp/koda-runner`

**Language:** TypeScript

**Key dependencies:** @nathapp/typescript-config, @types/bun, typescript

**Commands:** test: `npx turbo test` | lint: `bunx turbo lint` | typecheck: `bunx turbo type-check`

---
# Koda Runner Context

This is the app-specific source-of-truth context for `apps/runner` (`@nathapp/koda-runner`).

## Role In The Monorepo

`apps/runner` is the fleet runner daemon. It enrolls with the koda API, long-polls `POST /fleet/runner/sync`, runs `nax run` / `nax plan` jobs on a host checkout, reports progress and a verdict, streams the run log, stdout and stderr, uploads the run bundle and re-adopts running jobs after a restart. The foundations (config, identity, journal, server client, sync loop, verdicts) sit beside the execution half: git workspace, executor, watcher, bundle, supervisor, daemon and the CLI.

It should not:
- talk to the server from anywhere but `src/sync/` (other modules write journal events; the sync loop ships them; the bundle and log uploads get transports built in `daemon.ts` over `ServerClient`)
- decide a job's outcome from an exit code (nax exits 0 on failure; verdicts come from `status.json` and files)
- hold git credentials of its own: a per-job token comes over sync, lives only in daemon memory, and reaches git and gh/glab through the job's socket (3b-1); an authentication failure fails the job with `git auth failed`, and git never prompts

## Stack

- Bun-only ESM (`bun:sqlite`, `Bun.spawn`, `bun test`), TypeScript strict, commander 12
- `@nathapp/fleet-protocol` for wire types (the API imports it with `import type` only)
- compiled with `bun build --compile` (`bun run build:binary`; deliberately not a `build` script)

## Architecture

```text
src/main.ts          koda-runner run | enroll | status | install-service | uninstall-service (git-cred and shim are internal: git and the job shims call them)
src/commands/        enroll, run, status over injected dependencies
src/config/          runner.json (https unless loopback or allowInsecureHttp)
src/identity/        identity.json (0600) and the per-start boot id
src/journal/         bun:sqlite, WAL, synchronous FULL; every row is written BEFORE the send that reports it
src/sync/            ServerClient, batching (one entry per jobId, 1 MiB budget), SyncLoop (abort only an idle poll, backoff, 426/401 stop)
src/supervisor/      RepoMutex, JobEvents (legal transitions only), JobRun (one job), Supervisor, CommandHandler
src/executor/        JobExecutor seam + HostExecutor (git workspace, branch rules, detached nax, PLAN commit)
src/executor/config-job/  S3 config jobs: payload re-validation, staleness, apply, nax generate / lint / config, commit, push, PR
src/credentials/     TokenCache, CredentialBroker (one unix socket per job epoch in socketDir), git-cred helper, gh/glab shim
src/watcher/         status.json poll and run ids; RUN only: prd.json story list (S1b 1b), capped 100 stories / 8 KiB
src/logs/            LogShipper (S2a): raw byte windows of the run log, stdout and stderr PUT at exact offsets, 2 in flight, drained with final=1 before UPLOADING
src/verdict/         pure verdict functions (S1 spec 5.2 step 6)
src/bundle/          tar.gz from a file list, upload retry rules (409 is stale or state-conflict)
src/capabilities/    CapabilityProbe seam: NaxCapabilityProbe (nax JSON) or StaticCapabilityProbe (runner.json override); JobCheck after checkout
src/nax/            NaxCli (read-only JSON commands, 30 s timeout), the 0.83.1 floor, trust check
src/service/        systemd unit, launchd plist, AppArmor profile for bwrap (install-service)
src/daemon/          startDaemon (stop drains, crash does not), tuning constants, capacity
src/paths/           safe path segments
```

## Rules

- Every path segment (owner, repo, feature, job id, planFrom) goes through `paths/safe-segment.ts`; never build a path from server data by string concatenation.
- `seq` is per (jobId, leaseEpoch), contiguous from 1; a rejected event is replaced, never deleted (a hole stalls the job's ack).
- The sync request carries one entry per jobId (the server 400s a duplicate) and stays under the body budget.
- Never log or persist the runner API key outside `identity.json`; the `Logger` redacts secret-looking keys.
- No `console.log` outside `src/main.ts` and `src/logger.ts`.
- Emit only the S1 spec 5.4 runner transitions (`JobEvents.transition` refuses the rest). A spawned job always goes RUNNING -> UPLOADING -> terminal; a job that never spawned goes ASSIGNED -> FAILED or CANCELLED. A config job (S3: `CONFIG_EDIT`, `CONFIG_DRIFT`) spawns no nax run: it fetches its edit set and checks out while ASSIGNED, then RUNNING -> UPLOADING (no bundle) -> COMPLETED | FAILED with `reason = outcome`, or RUNNING -> CANCELLED.
- Config jobs (`src/executor/config-job/`) re-check every path against the shared `.nax/` allowlist (never a `.env` profile) and never follow a symlink; each nax / gh / glab call is detached and its pid and pgid are journaled while it runs. READOPT rejects a config job that was RUNNING (the server marks it CRASHED).
- The nax child is detached (own process group) and its output goes to files, so it survives a daemon restart. `stop()` never signals a child. Signal only `-pgid`, and only after `matchesProcess` confirms the pid is still this job (argv carries `koda-job-<jobId>`).
- `git clean` has no `-x`: ignored nax files (`checkpoint.jsonl`) must survive between runs; `plan/` is ignored too, so prepare deletes stale `plan/*.jsonl` itself.
- git runs with `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_ASKPASS=true`; a call that may authenticate passes the job helper (`credentialHelper`), every other call keeps an empty helper list; the clone's own helper list is `''` then the job helper. The daemon refuses git older than 2.30.
- A git token never goes to a logger, the journal, a file, a bundle or nax's environment; only the shim puts it into its one gh/glab child. The socket directory (default `/tmp/koda-runner-<uid>`) must be ours and mode 0700, or the daemon does not start.
- `plan-out/` (the PLAN stash) is write-once: a retry never re-reads the checkout that `checkout -f -B` may have reverted.
- Two epochs of one job id can coexist on a runner: abandoning the lower one never reaps or cleans while a live higher epoch exists.
- Capabilities come from nax (`config --profile --json`, `auth list --json`, `sandbox probe --json`); the runner maps nax's documents and never re-derives nax's rules. A report must pass the server validator whole (64 profiles, 16 providers each, 64 credentials, 64 KiB in total), so the probe drops what does not fit and warns instead.
- Unreadable is not the same as absent: a profiles directory, `/etc/apparmor.d` or a profile in it that cannot be read is a warning or a refusal, never "none found". An nax call that fails to spawn is `NAX_SPAWN_FAILED`, not a missing nax.
- nax 0.83.1 or newer. The daemon refuses to start without it, or while nax does not trust `workspaceRoot`; the runner never trusts a folder itself. After checkout, a job whose needs the machine does not meet fails with `project untrusted` or `capability mismatch: ...` before nax spawns.
- `install-service` and `uninstall-service` do every effect through `ServiceDeps`; tests never write /etc or /Library and never run systemctl, launchctl, sudo or apparmor_parser.
- Timing constants live in `src/daemon/tuning.ts`; only tests override them. In tests an `expect` inside a callback that a `try/catch` swallows proves nothing.
- Logs travel only through the `LogShipper` (protocol v3): never as `log` sync events. A job run registers its streams after spawn or re-adopt, wakes the shipper each tick, drains before UPLOADING (bounded by `logDrainTimeoutMs`), and stops its streams on halt, abandon and cleanup. Nothing in the watch tick awaits the network.
- A log stream that shrinks, that the server holds more of than the file, or whose acked size the server answers below, is `diverged`: it stops and the bundle fills it. The shipper never rewinds. A `final` PUT the server acks without `complete` backs off; it is never re-sent at once.

## Testing

- Unit specs are `src/**/*.spec.ts`; run `bun run test` (no database).
- Integration specs (`test/integration/*.integration.spec.ts`, 3a-2) need `KODA_DB_TESTS=1`, the test Postgres and a built API.
- Prefer real files and real SQLite (`:memory:` or a temp file) over mocks; the sync loop takes an injected client.
- Specs that need real git and the fake nax are `test/unit/*.spec.ts`; `test/fixtures/fake-nax.ts` is the fake nax (scenarios via `FAKE_NAX_*` env; a failed run exits 1 like the real one, and the verdict never reads the exit code). Real git runs in tests, isolated by `isolateGit()`.
- Authenticated git in specs uses `test/helpers/git-http.ts` (`git http-backend` behind Basic auth); `file://` origins never call a credential helper. `startDaemon` in tests needs `selfCommand: [process.execPath, <src/main.ts>]`.
- Integration specs run the built API against their own database `koda_runner_test`: `cd apps/runner && KODA_DB_TESTS=1 bun run test:integration`. `daemon.crash()` is the in-process kill; `TestRunner.net` cuts the network (`down`, or `dropResponse` to lose only the answers).
- Use `FakeExecutor` only for `JobRun` and `Supervisor` state-machine tests.
- Unit tests inject nax (`FakeNaxCli`, `test/helpers/fake-nax-cli.ts`) and `toolWorks`; they never depend on what the machine has installed. The fake nax process answers the probe commands from files in its nax home (`test/fixtures/fake-nax-probe.ts`). `test/live/` (`KODA_NAX_LIVE=1 bun run test:live`) is the merge gate against the installed nax, never in CI. `test/live/log-shipping.live.spec.ts` (`KODA_DB_TESTS=1 KODA_LOG_LIVE=1`, S2a) runs `koda-runner run` as its own process against the built API with a paced fake nax (`FAKE_NAX_PACE_MS`, `FAKE_NAX_STDIO_BYTES`), SIGKILLs it twice and compares every stored log stream's SHA-256; unbilled, never in CI.

## Generated Files

`AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and `codex.md` in this app are generated by `nax generate` from this file; do not edit them.
