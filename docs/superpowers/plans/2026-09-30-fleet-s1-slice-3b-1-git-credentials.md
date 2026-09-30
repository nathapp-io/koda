# Fleet S1 Slice 3b-1 — Git Credential Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Numbering.** This is plan 3b-1, the first half of slice 3b (user ruling 2026-09-30: split 3b into 3b-1 and 3b-2, one plan per PR). 3b-1 is the git credential broker of design §3.1: token requests over sync, the per-job socket, the `git-cred` helper and the `gh`/`glab` shims. **3b-2** (a separate plan and PR, written after this one merges) is `NaxCapabilityProbe` (§3.2), the post-checkout capability check, `install-service`/`uninstall-service` with the AppArmor check (§3.3), the 3b merge gate and the live check. Decision numbers continue the fleet S1 register: D1-D20 (slice 2 plans), D21-D59 (3a-1), D60-D74 (3a-2), D75-D77 (`2026-09-30-fleet-s1-slice-3a-deviations.md`); this plan adds **D78-D94**.

**Prerequisite:** slice 3a is merged, with its fixes (`main` at `19ac4fc7`, #173). This plan is the only commit on branch `feat/fleet-s1-slice3b-1-git-credentials`, cut from that `main`. No server change is needed: the server already mints tokens on `tokenRequests` (`apps/api/src/fleet/sync/sync.service.ts:98-127`, `apps/api/src/fleet/git-broker/git-token.broker.ts`). Nothing else is in development on the runner in parallel.

**Goal:** A runner that holds no git credentials of its own: it asks the server for a per-job token over sync, serves it to git and to `gh`/`glab` from a per-job unix socket through the runner binary itself, and never puts a token into nax's environment, the journal, a log or a file.

**Architecture:** A pure `TokenCache` (in memory) decides which jobs need a token and takes what the sync response delivers. A `CredentialBroker` owns one `CredentialServer` (unix socket) per `(jobId, leaseEpoch)` and writes the job's shims; `HostExecutor` acquires credentials at prepare, passes the helper to the runner's own network git calls, installs it in the clone's config for nax, and prefixes nax's `PATH` with the shims. `koda-runner git-cred` and `koda-runner shim` are thin clients of the socket, dispatched in `main.ts` before the CLI parser.

**Tech Stack:** Bun 1.4.2 (`node:net` unix sockets, `Bun.spawn`, `Bun.which`, `Bun.serve`, `bun test`), TypeScript strict ESM, system `git` (credential helper protocol, `git http-backend` in tests), `@nathapp/fleet-protocol` (`TokenRequest`, `GitToken`, `GitTokenError`).

**Specs:** `docs/superpowers/specs/2026-09-30-fleet-s1-slice-3-runner-design.md` ("slice 3 design"; this plan is its §3.1 and the 3b lines of §4) and `docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md` ("S1 spec": §5.5 isolation, §6.3 broker fence, §7.2 runner, §7.3 known limits). Precedent plans: `docs/superpowers/plans/2026-09-30-fleet-s1-slice-3a-1-runner-foundations.md`, `docs/superpowers/plans/2026-09-30-fleet-s1-slice-3a-2-runner-execution.md`.

## Global Constraints

From the specs, the repo rules (`.nax/context.md`, `.nax/mono/apps/runner/context.md`) and slice 3a; every task includes them.

- **No token at rest or in nax's environment.** A git token lives only in the `TokenCache` (daemon memory), the socket reply, the helper's stdout to git, and the environment of the one `gh`/`glab` child a shim starts. Never in the journal, a log line, a file, a bundle, nax's environment or a command line. The `Logger` redacts keys named `*token*`; do not rely on it: never pass a token to a logger at all.
- **Broker fence (S1 spec §6.3):** the server mints only for the job's current `(runnerId, leaseEpoch)` in ASSIGNED, RUNNING or UPLOADING; a stale epoch gets `ABANDON`. The runner keys everything by `(jobId, leaseEpoch)`.
- **Refresh (design §3.1):** request again when the cached token is within 240 s of `expiresAt`; the server reuses its cached token until 300 s before expiry (`FLEET_GIT_TOKEN_REUSE_MARGIN_SEC`, default 300), so a request inside 240 s gets a new token.
- **Sync limits** (`apps/api/src/fleet/sync/sync-request.parser.ts:4`): at most 64 token requests per sync.
- **Token usernames:** `x-access-token` (GitHub), `oauth2` (GitLab), as the server sends them (`GitToken.username`).
- **git never prompts:** `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_ASKPASS=true` stay (3a D69); git 2.30 or newer.
- **Path safety.** Job ids and repo segments reach the file system only through `paths/safe-segment.ts`; every path handed to a shell (helper value, shim script) is single-quoted by `shellQuote`.
- **Legal transitions only** and **persist before send** (3a Global Constraints) are unchanged; a token failure before spawn is `ASSIGNED -> FAILED`.
- **Repo conventions.** Conventional commits, no attribution trailer, never push (a human pushes), no emojis, no `console.log` outside `src/main.ts` and `src/logger.ts`, no non-null assertions, no `any`, no `eslint-disable`. Immutable style: build new objects and maps, never mutate arguments. Files under 400 lines typical, 800 max; functions under 50 lines.
- **Tests.** Unit specs `src/**/*.spec.ts`; specs that spawn real `git`, sockets or `bun` subprocesses live in `test/unit/`; integration specs `test/integration/*.integration.spec.ts`, gated by `describe.skipIf(process.env['KODA_DB_TESTS'] !== '1')`. Real git is isolated with `isolateGit()` (`test/helpers/git-fixture.ts`). No hardcoded absolute machine paths in tests: `makeTempDirs()`, `import.meta.dir`, `path.join`.
- **All ten CI checks are required on `main`**; no new required check. `git http-backend` ships with git on macOS and in Ubuntu's `git` package, which CI already installs.

Plan-level rules:

- Branch `feat/fleet-s1-slice3b-1-git-credentials` is checked out in the main checkout (`repos/koda`). Never run `git checkout`, `git switch`, `git stash`, `git reset` or `git rebase` here; commit on the current branch only.
- Runner specs: `cd apps/runner && bun test <path>`; all unit specs: `bun run test`; types: `bun run type-check`; lint: `bun run lint`. Integration: `cd apps/runner && KODA_DB_TESTS=1 bun run test:integration` (needs the test Postgres, `cd apps/api && bun run test:db:up`, and the built API, `bunx turbo run build --filter=@nathapp/koda-api`).
- Do not run `nax run` or `nax plan` (billed). `nax generate` is local and free.

## Plan decisions beyond the spec

New rows D78-D94, each needed by a task below.

| # | Decision | Why |
|:--|:--|:--|
| D78 | The socket is `<socketDir>/<key>.sock`, not `<jobDir>/git-cred.sock`. `key` = the first 16 hex characters of SHA-256(`<runnerId>:<jobId>:<leaseEpoch>`). `socketDir` defaults to `/tmp/koda-runner-<uid>`, and runner.json `socketDir` (absolute) overrides it. The daemon creates it with mode 0700, or refuses to start when it is not a real directory, is owned by another uid, or has any group or other permission bit. It also refuses when a socket path would exceed 100 bytes. | A unix socket path is limited to 104 bytes on macOS (108 on Linux). `<workspaceRoot>/.jobs/<25-char id>/git-cred.sock` already exceeds that for ordinary workspace roots and for every macOS temp dir. The runner id in the key keeps two daemons on one machine, and the in-process test runners, apart. |
| D79 | Wire protocol: the client writes the one line `get\n`. The server answers one JSON line and closes: `{ ok: true, username, token, expiresAt, protocol, host }` or `{ ok: false, reason }`. `protocol` (without the colon) and `host` (with the port) come from the job's `cloneUrl`. Before a token exists the server waits up to `tokenServeWaitMs` (30 s), then answers `no token`. It answers `job ended` once the job no longer wants a token, and `bad request` to any other line or to more than 64 bytes without a newline. | The design fixes "one line in, one JSON object out" but not the words. The wait lets a readopted nax's push succeed while the first token after a restart is still on its way. |
| D80 | The helper answers only `get`, and only when git's `protocol` and `host` equal the reply's. It then writes `username=...\npassword=...\n`. For `store`, `erase`, any mismatch, an unreachable socket, a `{ ok: false }` reply, or a token or username containing a newline or NUL, it prints nothing and exits 0. It always reads stdin to the end first. | A token must never leave for another host, such as a submodule, a redirect or an LFS server. git treats silence as "no credential"; with prompts disabled (D69) it authenticates with nothing and the server's refusal fails the command. Reading stdin first avoids a SIGPIPE in git. |
| D81 | `TokenCache.requests(now)` lists every wanted `(jobId, epoch)` that has no token, or whose token expires within `tokenRefreshMarginMs` (240 s), and that is not cooling down. It sends one entry per job id, the highest wanted epoch, and at most 64. A `GitToken` carries no epoch, so it is matched to the epoch its job id had in the request that asked for it. A delivered token that is already inside the margin (which covers a refresh returning the same token), and any `gitTokenErrors` entry, start a `tokenCooldownMs` (30 s) cool-down for that key. | Without a cool-down, a server that keeps returning the same token (clock skew) or an error would make every sync non-idle and turn the long poll into a 250 ms loop. |
| D82 | Token errors: while prepare waits for its first token, an error fails the job with `stateReason = 'git token: <reason>'` (the server's fixed reason code). Waiting ends after `tokenWaitMs` (120 s) with `git token: timeout`. Once a job has a token, a later error only shows in the socket reply after that token expires. The current token keeps serving until then, and nax's push then fails and nax escalates (S1 spec §7.3). | Design §3.1 fails "a job that has no usable token". Killing a running nax over a refresh error would lose work that a later refresh can still save. |
| D83 | Only `http:` and `https:` clone URLs use credentials. A `file:` clone URL (unit tests, local mirrors) gets no token request, no socket, no shims and no helper. | The server only ever sends https URLs; the 3a unit tests run against `file://` origins and stay as they are. |
| D84 | The helper and the shims run the runner itself. `selfCommand()` is `[process.execPath]` when compiled (`Bun.main` starts with `/$bunfs/`) and `[process.execPath, Bun.main]` otherwise (spiked 2026-09-30). `startDaemon` takes `selfCommand` as an option; tests pass `['bun', <apps/runner/src/main.ts>]`, because under `bun test` `Bun.main` is the test file. `main.ts` dispatches `git-cred` and `shim` before commander parses. | The design names the binary as the helper (`koda-runner git-cred <sock>`). A shim's arguments belong to `gh` (`--title`, `-R`) and must never be parsed as runner options. |
| D85 | At prepare the clone's local config gets `credential.helper` = `''` then `!<quoted selfCommand> git-cred <quoted sock>` (`git config --local --replace-all`, then `--add`). It is not unset at cleanup: the next prepare overwrites it, and a dead socket yields no credential. | The empty entry resets system and global helpers (git-credential(7)), so a host keychain can never answer for a job (spiked 2026-09-30). An unset at cleanup could race a readopt reject against a live job on the same clone. |
| D86 | The runner's own network git (clone, fetch, PLAN push) passes the helper per call as `-c credential.helper= -c credential.helper=<value>`. Every other git call keeps 3a's empty helper. | One code path for "this call may authenticate" (spiked: a command-line empty helper clears the repo's list). |
| D87 | Shims are `<jobDir>/bin/gh` and `<jobDir>/bin/glab`, mode 0700: `#!/bin/sh` then `exec <self> shim <tool> <sock> <binDir> -- "$@"`, with every word quoted. The shim removes `<binDir>` from `PATH`, finds the real binary with `Bun.which`, runs it with inherited stdio, forwards SIGINT, SIGTERM and SIGHUP, and exits with its code (128 plus the signal number when the child was signalled). gh gets `GH_TOKEN`, plus `GH_HOST` and `GH_ENTERPRISE_TOKEN` when the host is not `github.com`. glab gets `GITLAB_TOKEN`, plus `GITLAB_HOST` when the host is not `gitlab.com`. Without a token the real binary still runs, with no token variable and a one-line warning on stderr, so version probes work. With no real binary it exits 127 with `koda-runner: <tool> not found on PATH`. | Design §3.1 fixes the shape. nax probes `gh`/`glab` for forge detection (S1 spec §7.2) and must not break when a token is briefly missing. |
| D88 | nax is spawned with `PATH=<binDir>:<daemon PATH>` and no token variable. The daemon's own environment is never changed. | Design §3.1: "no token in its environment". |
| D89 | `NO_CREDENTIALS_REASON` becomes `git auth failed` (it was `no git credentials (runner 3b)`). | 3b now brokers credentials; an authentication failure is a real failure, not a missing feature. |
| D90 | The `JobExecutor` seam gains `resumeCredentials(job)` and `releaseCredentials(job)`. `JobRun` calls `resumeCredentials` before watching a `watch` start (a readopted nax may still push). It calls `releaseCredentials` from abandon even when a higher epoch is live (the socket is per epoch), and `HostExecutor.cleanup` releases too. The broker closes every socket on daemon stop and crash. | Design §3.1: the socket "refuses once the job's epoch changes or the job ends". A restarted daemon must serve a job it readopted. |
| D91 | Integration harness: a git-HTTP front (`Bun.serve` plus `git http-backend`) serves `/<owner>/<repo>.git/*` only with Basic auth `x-access-token:<minted token>` and proxies every other path to the fake forge. `GITHUB_API_URL` points at the front, so clone URLs are real `http://` URLs and the `insteadOf` mapping of 3a (D39) is removed. Every scenario then authenticates through the helper. | Git never calls a credential helper for `file://`, so 3a's mapping could not exercise 3b at all. |
| D92 | Tuning adds `tokenRefreshMarginMs 240000`, `tokenCooldownMs 30000`, `tokenWaitMs 120000`, `tokenServeWaitMs 30000`, `tokenPollMs 250` (D42: `startDaemon` options only). | One place for the timing, as 3a. |
| D93 | `<jobDir>` is created with mode 0700. | It holds the shims, which carry the socket path. |
| D94 | The fake nax mirrors nax's finish: a failed push becomes `postRun.finish` `{ result: 'escalated', escalationReason: 'push failed' }` instead of a crash. `FAKE_NAX_GH=1` opens the PR with `gh pr create` and takes its URL from gh's stdout; `FAKE_NAX_ENV_DUMP=<path>` writes nax's environment to that file. The 3a recovery test "finished while the daemon is down" therefore now ends ESCALATED: a nax that pushes while its daemon is down has no credentials. | S1 spec §7.3: "if koda is unreachable ... the finish push fails and nax escalates". The integration test has to show that behaviour, not a crash of the fake. |

## Review Focus

The inputs and failure modes the specs imply but a happy-path test would never meet, most likely first. Each has a test in the task that owns the code.

1. **A token that arrives already near or past expiry** (clock skew between koda and the runner). Expected: it is served while still valid, and requested again only after the cool-down, never in a tight loop. The test is in Task 1.
2. **git asks for another host** (a submodule on another forge, a redirect). Expected: the helper prints nothing and the token never leaves. The test is in Task 4.
3. **The daemon restarts while nax runs.** A stale socket file from the dead daemon is in the way. Expected: the broker replaces it, and nax's later push gets a token. The tests are in Task 7 (stale file) and Task 11 (readopt end to end).
4. **`gh` arguments with quotes, `$`, spaces and newlines.** Expected: they reach the real binary byte for byte through the shim script. The test is in Task 6.
5. **A socket directory planted by another user, or a symlink.** Expected: the daemon refuses to start and never listens there. The tests are in Task 3 and Task 10.

## File Structure

```
apps/runner/src/
  credentials/
    token-cache.ts        TokenCache: which jobs need a token, what sync delivered (pure, in memory)       Task 1
    socket-dir.ts         socket directory checks, socket path per (runner, job, epoch)                    Task 3
    cred-server.ts        CredentialServer: one unix socket, one JSON reply per connection                 Task 3
    git-credential.ts     requestCredential (socket client), runGitCred (git's credential protocol)       Task 4
    shim.ts               runShim: token env, PATH without the shim dir, run the real gh/glab              Task 5
    job-files.ts          shellQuote, helperValue, shimScript, writeShims                                   Task 6
    broker.ts             CredentialBroker: acquire/release/closeAll over TokenCache + CredentialServer     Task 7
  internal-commands.ts    dispatchInternal: `git-cred` and `shim` before commander                          Task 6
  self-command.ts         selfCommand(): how to run this runner again                                      Task 6
  main.ts                 (modified) early dispatch                                                         Task 6
  sync/batch.ts           (modified) tokenRequests in the request                                           Task 2
  sync/sync-loop.ts       (modified) tokenRequests / onTokens deps                                          Task 2
  daemon/tuning.ts        (modified) token timing                                                           Task 2
  daemon/daemon.ts        (modified) TokenCache, broker, socketDir, selfCommand, closeAll                   Tasks 2, 10
  config/runner-config.ts (modified) socketDir                                                              Task 10
  executor/git.ts         (modified) per-call credentialHelper, D89 reason                                  Task 8
  executor/workspace.ts   (modified) clone/fetch with helper, configureRepoHelper                           Task 8
  executor/plan-commit.ts (modified) push with helper                                                       Task 8
  executor/job-executor.ts(modified) resumeCredentials / releaseCredentials                                 Task 9
  executor/host-executor.ts (modified) acquire, spawn PATH, release                                         Task 9
  supervisor/job-run.ts   (modified) resume on watch, release on abandon                                    Task 9
apps/runner/test/
  helpers/git-http.ts     gitHttpHandler / startGitHttp: authenticated smart HTTP over `git http-backend`    Task 8
  helpers/fake-gh.ts      installFakeGh: a `gh` on PATH that logs argv and GH_TOKEN                         Task 6
  fixtures/fake-gh.ts     the fake gh program                                                               Task 6
  fixtures/fake-nax.ts    (modified) D94: push failure escalates, FAKE_NAX_GH, FAKE_NAX_ENV_DUMP             Task 9
  helpers/fake-executor.ts (modified) the two new seam methods                                              Task 9
  unit/credential-cli.spec.ts   real git + real shim through `bun src/main.ts`                              Task 6
  unit/workspace-auth.spec.ts   clone, fetch, push over authenticated HTTP                                  Task 8
  unit/host-executor-auth.spec.ts HostExecutor with a real broker over HTTP                                 Task 9
  integration/harness/git-front.ts  the git-HTTP front of the fake forge (D91)                              Task 11
  integration/harness/world.ts      (modified) front, fake gh, selfCommand; no insteadOf                    Task 11
  integration/credentials.integration.spec.ts                                                               Task 11
```

---

### Task 0: Verify the starting point

**Files:** none (read only).

- [ ] **Step 1: Confirm the branch and base**

Run: `cd repos/koda && git branch --show-current && git log --oneline -2`
Expected: `feat/fleet-s1-slice3b-1-git-credentials`; the top commit is this plan, and the one below it is `19ac4fc7 fix(fleet): runner READOPT freshness and PLAN push recovery (D77) (#173)`.

- [ ] **Step 2: Confirm the tools this plan depends on**

Run: `bun --version && git --version && ls "$(git --exec-path)/git-http-backend"`
Expected: Bun `1.4.2`, git 2.30 or newer, and the `git-http-backend` path printed (no "No such file").

- [ ] **Step 3: Baseline**

Run: `cd apps/runner && bun run type-check && bun run lint && bun run test`
Expected: clean type-check and lint; `662 pass, 0 fail` (the count at `19ac4fc7`).

- [ ] **Step 4: Read the design text this plan implements**

Read `docs/superpowers/specs/2026-09-30-fleet-s1-slice-3-runner-design.md` §3.1 and §4 (the "3b:" integration line), and S1 spec §7.2-§7.3. No commit.

---

### Task 1: TokenCache

**Files:**
- Create: `apps/runner/src/credentials/token-cache.ts`
- Test: `apps/runner/src/credentials/token-cache.spec.ts`

**Interfaces:**
- Consumes: `TokenRequest`, `GitToken`, `GitTokenError` from `@nathapp/fleet-protocol`.
- Produces:
  - `class TokenCache { constructor(timing: TokenCacheTiming); onNeed(listener: () => void): () => void; want(jobId: string, leaseEpoch: number): void; wanted(jobId: string, leaseEpoch: number): boolean; drop(jobId: string, leaseEpoch: number): void; state(jobId: string, leaseEpoch: number, nowMs: number): TokenState; requests(nowMs: number): TokenRequest[]; apply(requested: readonly TokenRequest[], tokens: readonly GitToken[], errors: readonly GitTokenError[], nowMs: number): void }`
  - `interface TokenCacheTiming { readonly refreshMarginMs: number; readonly cooldownMs: number }`
  - `interface CachedToken { readonly token: string; readonly username: GitToken['username']; readonly expiresAt: string }`
  - `type TokenState = { kind: 'token'; token: CachedToken } | { kind: 'error'; reason: string } | { kind: 'pending' }`
  - `const MAX_TOKEN_REQUESTS = 64`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/runner/src/credentials/token-cache.spec.ts
import { describe, expect, test } from 'bun:test';
import type { GitToken } from '@nathapp/fleet-protocol';
import { MAX_TOKEN_REQUESTS, TokenCache } from './token-cache';

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const timing = { refreshMarginMs: 240_000, cooldownMs: 30_000 };
const tok = (jobId: string, expiresAt: string, token = 'ghs_1'): GitToken => ({ jobId, token, expiresAt, username: 'x-access-token' });

describe('TokenCache requests (D81)', () => {
  test('a wanted job with no token is requested; an unwanted one never is', () => {
    const cache = new TokenCache(timing);
    expect(cache.requests(T0)).toEqual([]);
    cache.want('j1', 1);
    expect(cache.requests(T0)).toEqual([{ jobId: 'j1', leaseEpoch: 1 }]);
  });
  test('a fresh token is not requested again; one within 240 s of expiry is', () => {
    const cache = new TokenCache(timing);
    cache.want('j1', 1);
    cache.apply([{ jobId: 'j1', leaseEpoch: 1 }], [tok('j1', iso(T0 + 3_600_000))], [], T0);
    expect(cache.requests(T0)).toEqual([]);
    expect(cache.requests(T0 + 3_600_000 - 240_001)).toEqual([]);
    expect(cache.requests(T0 + 3_600_000 - 240_000)).toEqual([{ jobId: 'j1', leaseEpoch: 1 }]);
  });
  test('one request per job id, the highest wanted epoch', () => {
    const cache = new TokenCache(timing);
    cache.want('j1', 1);
    cache.want('j1', 2);
    cache.want('j2', 1);
    expect(cache.requests(T0)).toEqual([{ jobId: 'j1', leaseEpoch: 2 }, { jobId: 'j2', leaseEpoch: 1 }]);
  });
  test(`at most ${MAX_TOKEN_REQUESTS} requests (the sync limit)`, () => {
    const cache = new TokenCache(timing);
    for (let i = 0; i < 70; i += 1) cache.want(`j${i}`, 1);
    expect(cache.requests(T0)).toHaveLength(MAX_TOKEN_REQUESTS);
  });
});

describe('TokenCache apply (D81, D82)', () => {
  test('a token lands on the epoch the request asked for, not on another epoch of the same job', () => {
    const cache = new TokenCache(timing);
    cache.want('j1', 1);
    cache.want('j1', 2);
    cache.apply([{ jobId: 'j1', leaseEpoch: 2 }], [tok('j1', iso(T0 + 3_600_000))], [], T0);
    expect(cache.state('j1', 2, T0)).toMatchObject({ kind: 'token', token: { token: 'ghs_1', username: 'x-access-token' } });
    expect(cache.state('j1', 1, T0)).toEqual({ kind: 'pending' });
  });
  test('a token for a job that was not requested, or was dropped meanwhile, is ignored', () => {
    const cache = new TokenCache(timing);
    cache.want('j1', 1);
    cache.apply([], [tok('j1', iso(T0 + 3_600_000))], [], T0);
    expect(cache.state('j1', 1, T0)).toEqual({ kind: 'pending' });
    cache.drop('j1', 1);
    cache.apply([{ jobId: 'j1', leaseEpoch: 1 }], [tok('j1', iso(T0 + 3_600_000))], [], T0);
    expect(cache.wanted('j1', 1)).toBe(false);
    expect(cache.state('j1', 1, T0)).toEqual({ kind: 'pending' });
  });
  test('a refresh that returns the same token (still inside the margin) cools the job down for 30 s', () => {
    const cache = new TokenCache(timing);
    cache.want('j1', 1);
    const exp = iso(T0 + 600_000);   // fresh when it first arrives: no cool-down
    cache.apply([{ jobId: 'j1', leaseEpoch: 1 }], [tok('j1', exp)], [], T0);
    const refresh = T0 + 400_000;    // now inside the margin, so the job asks again ...
    expect(cache.requests(refresh)).toEqual([{ jobId: 'j1', leaseEpoch: 1 }]);
    cache.apply([{ jobId: 'j1', leaseEpoch: 1 }], [tok('j1', exp)], [], refresh);   // ... and gets the same token back
    expect(cache.requests(refresh + 29_999)).toEqual([]);
    expect(cache.requests(refresh + 30_000)).toEqual([{ jobId: 'j1', leaseEpoch: 1 }]);
  });
  test('Review focus 1: a token that arrives already inside the margin is served but not asked for again at once', () => {
    const cache = new TokenCache(timing);
    cache.want('j1', 1);
    cache.apply([{ jobId: 'j1', leaseEpoch: 1 }], [tok('j1', iso(T0 + 60_000))], [], T0);
    expect(cache.state('j1', 1, T0)).toMatchObject({ kind: 'token' });
    expect(cache.requests(T0 + 1)).toEqual([]);
    expect(cache.requests(T0 + 30_000)).toEqual([{ jobId: 'j1', leaseEpoch: 1 }]);
  });
  test('an expired token is not served', () => {
    const cache = new TokenCache(timing);
    cache.want('j1', 1);
    cache.apply([{ jobId: 'j1', leaseEpoch: 1 }], [tok('j1', iso(T0 + 1_000))], [], T0);
    expect(cache.state('j1', 1, T0 + 1_000)).toEqual({ kind: 'pending' });
  });
  test('an error with no token is the state; with a live token the token still serves (D82); both cool down', () => {
    const cache = new TokenCache(timing);
    cache.want('j1', 1);
    cache.apply([{ jobId: 'j1', leaseEpoch: 1 }], [], [{ jobId: 'j1', reason: 'app_not_installed' }], T0);
    expect(cache.state('j1', 1, T0)).toEqual({ kind: 'error', reason: 'app_not_installed' });
    expect(cache.requests(T0 + 1)).toEqual([]);
    cache.want('j2', 1);
    cache.apply([{ jobId: 'j2', leaseEpoch: 1 }], [tok('j2', iso(T0 + 100_000))], [], T0);
    cache.apply([{ jobId: 'j2', leaseEpoch: 1 }], [], [{ jobId: 'j2', reason: 'provider_error' }], T0 + 30_000);
    expect(cache.state('j2', 1, T0 + 30_000)).toMatchObject({ kind: 'token' });
    expect(cache.state('j2', 1, T0 + 100_000)).toEqual({ kind: 'error', reason: 'provider_error' });
  });
  test('a new token clears an earlier error', () => {
    const cache = new TokenCache(timing);
    cache.want('j1', 1);
    cache.apply([{ jobId: 'j1', leaseEpoch: 1 }], [], [{ jobId: 'j1', reason: 'provider_error' }], T0);
    cache.apply([{ jobId: 'j1', leaseEpoch: 1 }], [tok('j1', iso(T0 + 3_600_000))], [], T0 + 30_000);
    expect(cache.state('j1', 1, T0 + 30_000)).toMatchObject({ kind: 'token' });
  });
});

describe('TokenCache want, drop and listeners', () => {
  test('want notifies once per new key; the unsubscribe stops it', () => {
    const cache = new TokenCache(timing);
    let calls = 0;
    const off = cache.onNeed(() => { calls += 1; });
    cache.want('j1', 1);
    cache.want('j1', 1);
    cache.want('j1', 2);
    expect(calls).toBe(2);
    off();
    cache.want('j2', 1);
    expect(calls).toBe(2);
  });
  test('drop forgets the token and the want', () => {
    const cache = new TokenCache(timing);
    cache.want('j1', 1);
    cache.apply([{ jobId: 'j1', leaseEpoch: 1 }], [tok('j1', iso(T0 + 3_600_000))], [], T0);
    cache.drop('j1', 1);
    expect(cache.wanted('j1', 1)).toBe(false);
    expect(cache.state('j1', 1, T0)).toEqual({ kind: 'pending' });
    expect(cache.requests(T0)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/runner && bun test src/credentials/token-cache.spec.ts`
Expected: FAIL, `Cannot find module './token-cache'`.

- [ ] **Step 3: Implement**

```ts
// apps/runner/src/credentials/token-cache.ts
import type { GitToken, GitTokenError, TokenRequest } from '@nathapp/fleet-protocol';

export interface CachedToken {
  readonly token: string;
  readonly username: GitToken['username'];
  readonly expiresAt: string;
}

export type TokenState =
  | { readonly kind: 'token'; readonly token: CachedToken }
  | { readonly kind: 'error'; readonly reason: string }
  | { readonly kind: 'pending' };

export interface TokenCacheTiming {
  /** Design §3.1: ask again this long before `expiresAt` (the server reuses its token until 300 s before it). */
  readonly refreshMarginMs: number;
  /** D81: after a token that is already inside the margin, or an error, wait this long before asking for that job again. */
  readonly cooldownMs: number;
}

interface Entry {
  readonly jobId: string;
  readonly leaseEpoch: number;
  readonly token: CachedToken | null;
  readonly error: string | null;
  readonly coolUntilMs: number;
}

/** The server accepts at most 64 token requests per sync (apps/api/src/fleet/sync/sync-request.parser.ts). */
export const MAX_TOKEN_REQUESTS = 64;

const keyOf = (jobId: string, leaseEpoch: number): string => `${jobId}:${leaseEpoch}`;

/**
 * Per (jobId, leaseEpoch) git tokens, in memory only (design §3.1, D81): never journaled, logged or written to disk.
 * A restarted daemon starts empty and asks again for every job that still wants one.
 */
export class TokenCache {
  private entries: ReadonlyMap<string, Entry> = new Map();
  private listeners: ReadonlyArray<() => void> = [];

  constructor(private readonly timing: TokenCacheTiming) {}

  /** Called when a job starts wanting a token, so the sync loop can end an idle poll and ask at once. */
  onNeed(listener: () => void): () => void {
    this.listeners = [...this.listeners, listener];
    return () => { this.listeners = this.listeners.filter((other) => other !== listener); };
  }

  want(jobId: string, leaseEpoch: number): void {
    const key = keyOf(jobId, leaseEpoch);
    if (this.entries.has(key)) return;
    this.entries = new Map([...this.entries, [key, { jobId, leaseEpoch, token: null, error: null, coolUntilMs: 0 }]]);
    for (const listener of this.listeners) listener();
  }

  wanted(jobId: string, leaseEpoch: number): boolean {
    return this.entries.has(keyOf(jobId, leaseEpoch));
  }

  drop(jobId: string, leaseEpoch: number): void {
    const key = keyOf(jobId, leaseEpoch);
    if (this.entries.has(key)) this.entries = new Map([...this.entries].filter(([other]) => other !== key));
  }

  /** An expired token is never served; an error only shows when there is no live token (D82). */
  state(jobId: string, leaseEpoch: number, nowMs: number): TokenState {
    const entry = this.entries.get(keyOf(jobId, leaseEpoch));
    if (entry?.token && Date.parse(entry.token.expiresAt) > nowMs) return { kind: 'token', token: entry.token };
    if (entry?.error) return { kind: 'error', reason: entry.error };
    return { kind: 'pending' };
  }

  /** D81: one request per job (its highest wanted epoch) for a missing or nearly expired token, outside any cool-down. */
  requests(nowMs: number): TokenRequest[] {
    const highest = new Map<string, Entry>();
    for (const entry of this.entries.values()) {
      const seen = highest.get(entry.jobId);
      if (!seen || entry.leaseEpoch > seen.leaseEpoch) highest.set(entry.jobId, entry);
    }
    return [...highest.values()]
      .filter((entry) => entry.coolUntilMs <= nowMs && (entry.token === null || !this.fresh(entry.token.expiresAt, nowMs)))
      .slice(0, MAX_TOKEN_REQUESTS)
      .map((entry) => ({ jobId: entry.jobId, leaseEpoch: entry.leaseEpoch }));
  }

  /** A GitToken names only its job: it belongs to the epoch this sync asked for (D81). */
  apply(requested: readonly TokenRequest[], tokens: readonly GitToken[], errors: readonly GitTokenError[], nowMs: number): void {
    const epochOf = new Map(requested.map((r) => [r.jobId, r.leaseEpoch] as const));
    const next = new Map(this.entries);
    const cool = nowMs + this.timing.cooldownMs;
    for (const token of tokens) {
      const epoch = epochOf.get(token.jobId);
      const entry = epoch === undefined ? undefined : next.get(keyOf(token.jobId, epoch));
      if (!entry) continue;
      const cached: CachedToken = { token: token.token, username: token.username, expiresAt: token.expiresAt };
      // A token already inside the margin (a refresh that returned the same token, or clock skew) would be asked for
      // again at once: cool down instead (D81).
      next.set(keyOf(entry.jobId, entry.leaseEpoch), { ...entry, token: cached, error: null, coolUntilMs: this.fresh(token.expiresAt, nowMs) ? 0 : cool });
    }
    for (const error of errors) {
      const epoch = epochOf.get(error.jobId);
      const entry = epoch === undefined ? undefined : next.get(keyOf(error.jobId, epoch));
      if (entry) next.set(keyOf(entry.jobId, entry.leaseEpoch), { ...entry, error: error.reason, coolUntilMs: cool });
    }
    this.entries = next;
  }

  private fresh(expiresAt: string, nowMs: number): boolean {
    const at = Date.parse(expiresAt);
    return !Number.isNaN(at) && at - nowMs > this.timing.refreshMarginMs;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/runner && bun test src/credentials/token-cache.spec.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/credentials/token-cache.ts apps/runner/src/credentials/token-cache.spec.ts
git commit -m "feat(fleet): runner token cache for per-job git tokens (3b-1, D81)"
```

---

### Task 2: Token requests over sync, token timing, daemon plumbing

**Files:**
- Modify: `apps/runner/src/sync/batch.ts` (`BuildInput`, `buildSyncRequest`)
- Modify: `apps/runner/src/sync/sync-loop.ts` (`SyncLoopDeps`, `syncOnce`, `apply`)
- Modify: `apps/runner/src/daemon/tuning.ts`, `apps/runner/src/daemon/tuning.spec.ts`
- Modify: `apps/runner/src/daemon/daemon.ts` (a `TokenCache` wired to the loop)
- Test: `apps/runner/src/sync/batch.spec.ts`, `apps/runner/src/sync/sync-loop.spec.ts`

**Interfaces:**
- Consumes: `TokenCache` (Task 1).
- Produces:
  - `BuildInput.tokenRequests?: readonly TokenRequest[]`.
  - `SyncLoopDeps.tokenRequests: () => readonly TokenRequest[]`.
  - `SyncLoopDeps.onTokens: (requested: readonly TokenRequest[], tokens: readonly GitToken[], errors: readonly GitTokenError[]) => void`.
  - `Tuning` gains `tokenRefreshMarginMs`, `tokenCooldownMs`, `tokenWaitMs`, `tokenServeWaitMs`, `tokenPollMs` (D92).

- [ ] **Step 1: Write the failing tests**

Append to `apps/runner/src/sync/batch.spec.ts` (it already imports `buildSyncRequest`, `FULL_SCALE`, `Journal`; add `SYNC_LIMITS` to the import from `./batch` if absent):

```ts
describe('token requests (design §3.1)', () => {
  test('are carried as given, capped at the sync limit of 64', () => {
    const journal = Journal.open(':memory:');
    const tokenRequests = Array.from({ length: 70 }, (_, i) => ({ jobId: `j${i}`, leaseEpoch: 1 }));
    const request = buildSyncRequest({ journal, bootId: 'b', daemonVersion: 'v', freeSlots: 1, acks: [], scale: FULL_SCALE, tokenRequests });
    expect(request.tokenRequests).toHaveLength(SYNC_LIMITS.tokenRequests);
    expect(request.tokenRequests[0]).toEqual({ jobId: 'j0', leaseEpoch: 1 });
  });
  test('are empty when none are given', () => {
    const request = buildSyncRequest({ journal: Journal.open(':memory:'), bootId: 'b', daemonVersion: 'v', freeSlots: 1, acks: [], scale: FULL_SCALE });
    expect(request.tokenRequests).toEqual([]);
  });
});
```

In `apps/runner/src/sync/sync-loop.spec.ts`, make `makeLoop` supply the two new deps (they come before `...over`), and add a `delivered` recorder:

```ts
// module-level, beside the other recorders
let tokenAsks: Array<{ jobId: string; leaseEpoch: number }>;
let delivered: Array<{ requested: unknown; tokens: unknown; errors: unknown }>;
// in beforeEach: tokenAsks = []; delivered = [];
// in makeLoop's deps object, before `...over`:
    tokenRequests: () => tokenAsks,
    onTokens: (requested, tokens, errors) => { delivered.push({ requested: [...requested], tokens: [...tokens], errors: [...errors] }); },
```

and append:

```ts
describe('git tokens (design §3.1, D81)', () => {
  test('the request carries the cache\'s token requests and the answer goes back with them', async () => {
    tokenAsks = [{ jobId: 'j1', leaseEpoch: 2 }];
    const token = { jobId: 'j1', token: 'ghs_x', expiresAt: '2026-10-01T01:00:00.000Z', username: 'x-access-token' as const };
    script.push(ok({ gitTokens: [token], gitTokenErrors: [{ jobId: 'j9', reason: 'job_not_active' }] }));
    await makeLoop().syncOnce();
    expect(calls[0].tokenRequests).toEqual([{ jobId: 'j1', leaseEpoch: 2 }]);
    expect(delivered).toEqual([{ requested: [{ jobId: 'j1', leaseEpoch: 2 }], tokens: [token], errors: [{ jobId: 'j9', reason: 'job_not_active' }] }]);
  });
  test('a failed sync delivers nothing, so the next one asks again', async () => {
    tokenAsks = [{ jobId: 'j1', leaseEpoch: 1 }];
    script.push(async () => { throw new NetworkError('down'); });
    await makeLoop().syncOnce();
    expect(delivered).toEqual([]);
  });
  test('a request that asks for tokens is not an idle poll: wake() does not abort it', async () => {
    tokenAsks = [{ jobId: 'j1', leaseEpoch: 1 }];
    let aborted = false;
    let release: () => void = () => undefined;
    script.push((_req, signal) => new Promise((resolve) => {
      signal?.addEventListener('abort', () => { aborted = true; });
      release = () => resolve(empty);
    }));
    const loop = makeLoop();
    const pending = loop.syncOnce();
    await Promise.resolve();
    loop.wake();
    release();
    await pending;
    expect(aborted).toBe(false);
  });
});
```

If `NetworkError`'s constructor in `src/sync/http.ts` takes different arguments, construct it the way the existing specs in this file do.

In `apps/runner/src/daemon/tuning.spec.ts`, replace the expected object:

```ts
    expect(TUNING).toEqual({
      statusPollMs: 2_000, killGraceMs: 30_000, syncMinGapMs: 250, syncTimeoutMs: 35_000,
      capacityRefreshMs: 300_000, pruneIntervalMs: 86_400_000, readoptHeartbeatMs: 120_000,
      ackPollMs: 250, uploadAckWaitMs: 60_000,
      tokenRefreshMarginMs: 240_000, tokenCooldownMs: 30_000, tokenWaitMs: 120_000, tokenServeWaitMs: 30_000, tokenPollMs: 250,
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/runner && bun test src/sync src/daemon/tuning.spec.ts`
Expected: FAIL. `tokenRequests` is empty in the request, `delivered` is empty, and the TUNING object lacks the token keys. Type errors in `makeLoop` are expected until Step 3.

- [ ] **Step 3: Implement**

`apps/runner/src/sync/batch.ts`:

```ts
import { FLEET_PROTOCOL_VERSION, type CommandAck, type JobReport, type RunnerCapabilities, type SyncRequest, type TokenRequest } from '@nathapp/fleet-protocol';
// ...
export interface BuildInput {
  readonly journal: Pick<Journal, 'jobsWithPending' | 'pendingEvents'>;
  readonly bootId: string;
  readonly daemonVersion: string;
  readonly freeSlots: number;
  readonly acks: readonly CommandAck[];
  readonly capabilities?: RunnerCapabilities;
  readonly scale: BatchScale;
  /** Design §3.1: from the TokenCache; the server allows 64. */
  readonly tokenRequests?: readonly TokenRequest[];
}
// in buildSyncRequest, the head's tokenRequests line becomes:
    tokenRequests: (input.tokenRequests ?? []).slice(0, SYNC_LIMITS.tokenRequests).map((r) => ({ jobId: r.jobId, leaseEpoch: r.leaseEpoch })),
```

`apps/runner/src/sync/sync-loop.ts`:

```ts
import type { CommandAck, FleetCommandOut, GitToken, GitTokenError, RunnerCapabilities, SyncRequest, SyncResponse, TokenRequest } from '@nathapp/fleet-protocol';
// in SyncLoopDeps, after abandonUnknown:
  /** Design §3.1: which jobs need a git token now (TokenCache.requests). */
  readonly tokenRequests: () => readonly TokenRequest[];
  /** The server's answer to this request's token requests (TokenCache.apply). */
  readonly onTokens: (requested: readonly TokenRequest[], tokens: readonly GitToken[], errors: readonly GitTokenError[]) => void;
// in syncOnce, buildSyncRequest gains:
      tokenRequests: this.deps.tokenRequests(),
// in apply, right after `this.scale = doubleScale(this.scale);`:
    this.deps.onTokens(request.tokenRequests, response.gitTokens ?? [], response.gitTokenErrors ?? []);
```

`apps/runner/src/daemon/tuning.ts`:

```ts
export interface Tuning {
  // ...existing fields...
  /** D92, design §3.1: ask for a new git token this long before the current one expires. */
  readonly tokenRefreshMarginMs: number;
  /** D81: pause after a token already inside the refresh margin, or a token error. */
  readonly tokenCooldownMs: number;
  /** D82: how long prepare waits for a job's first token. */
  readonly tokenWaitMs: number;
  /** D79: how long the socket holds a request open for a token that has not arrived. */
  readonly tokenServeWaitMs: number;
  readonly tokenPollMs: number;
}
// TUNING gains:
  tokenRefreshMarginMs: 240_000,
  tokenCooldownMs: 30_000,
  tokenWaitMs: 120_000,
  tokenServeWaitMs: 30_000,
  tokenPollMs: 250,
```

`apps/runner/src/daemon/daemon.ts`, after `const reporter = ...; await reporter.refresh();`:

```ts
  const tokens = new TokenCache({ refreshMarginMs: tuning.tokenRefreshMarginMs, cooldownMs: tuning.tokenCooldownMs });
```

In the `new SyncLoop({...})` deps add:

```ts
    tokenRequests: () => tokens.requests(Date.now()),
    onTokens: (requested, granted, errors) => {
      tokens.apply(requested, granted, errors, Date.now());
      for (const error of errors) log.warn('git token refused', { jobId: error.jobId, reason: error.reason });
    },
```

and right after the loop is constructed:

```ts
  const stopNeedListener = tokens.onNeed(() => loop.wake());
```

Call `stopNeedListener()` in `stop()` and in `crash()`, next to `loop.stop()`. Import `TokenCache` from `../credentials/token-cache`. Token expiry is wall-clock time from the server, so the cache is always given `Date.now()`, never the injected `now` (which tests may freeze).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/runner && bun test src/sync src/daemon && bun run type-check`
Expected: PASS; the type-check is clean.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/sync apps/runner/src/daemon
git commit -m "feat(fleet): runner asks for git tokens over sync (3b-1, D81, D92)"
```

---

### Task 3: Socket directory and CredentialServer

**Files:**
- Create: `apps/runner/src/credentials/socket-dir.ts`, `apps/runner/src/credentials/cred-server.ts`
- Test: `apps/runner/test/unit/cred-server.spec.ts` (real sockets and file modes)

**Interfaces:**
- Produces:
  - `class SocketDirError extends Error`
  - `const MAX_SOCKET_PATH_BYTES = 100`
  - `function defaultSocketDir(uid: number): string` (returns `/tmp/koda-runner-<uid>`)
  - `function socketPathFor(dir: string, runnerId: string, jobId: string, leaseEpoch: number): string`
  - `function ensureSocketDir(dir: string, uid: number): Promise<void>`
  - `type CredentialReply = { ok: true; username: string; token: string; expiresAt: string; protocol: string; host: string } | { ok: false; reason: string }`
  - `const MAX_REQUEST_BYTES = 64`
  - `class CredentialServer { static listen(path: string, reply: () => Promise<CredentialReply>): Promise<CredentialServer>; readonly path: string; close(): Promise<void> }`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/runner/test/unit/cred-server.spec.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, stat, symlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { CredentialServer, type CredentialReply } from '../../src/credentials/cred-server';
import { MAX_SOCKET_PATH_BYTES, SocketDirError, defaultSocketDir, ensureSocketDir, socketPathFor } from '../../src/credentials/socket-dir';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const uid = process.getuid?.() ?? 0;
const TOKEN: CredentialReply = { ok: true, username: 'x-access-token', token: 'ghs_t', expiresAt: '2099-01-01T00:00:00Z', protocol: 'https', host: 'github.com' };

/** A raw client: send `line`, collect everything until the server closes. */
function ask(path: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let out = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(line));
    socket.on('data', (chunk: string) => { out += chunk; });
    socket.on('end', () => resolve(out));
    socket.on('error', reject);
  });
}

describe('socket directory (D78)', () => {
  test('defaults to /tmp/koda-runner-<uid>', () => {
    expect(defaultSocketDir(501)).toBe('/tmp/koda-runner-501');
  });
  test('socket paths are 16 hex characters per (runner, job, epoch) and differ by each', () => {
    const a = socketPathFor('/s', 'r1', 'j1', 1);
    expect(a).toMatch(/^\/s\/[0-9a-f]{16}\.sock$/);
    expect(socketPathFor('/s', 'r1', 'j1', 1)).toBe(a);
    expect(socketPathFor('/s', 'r1', 'j1', 2)).not.toBe(a);
    expect(socketPathFor('/s', 'r2', 'j1', 1)).not.toBe(a);
  });
  test('an absent directory is created with mode 0700', async () => {
    const dir = join(await tmp.make('sd'), 'socks');
    await ensureSocketDir(dir, uid);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
  test('Review focus 5: a group- or world-accessible directory is refused', async () => {
    const dir = join(await tmp.make('sd'), 'open');
    await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o755);
    await expect(ensureSocketDir(dir, uid)).rejects.toThrow(SocketDirError);
  });
  test('Review focus 5: a symlink is refused even when it points at a good directory', async () => {
    const base = await tmp.make('sd');
    const real = join(base, 'real');
    await mkdir(real, { mode: 0o700 });
    await symlink(real, join(base, 'link'));
    await expect(ensureSocketDir(join(base, 'link'), uid)).rejects.toThrow(/not a link/);
  });
  test('a directory owned by another uid is refused', async () => {
    const dir = join(await tmp.make('sd'), 'mine');
    await ensureSocketDir(dir, uid);
    await expect(ensureSocketDir(dir, uid + 1)).rejects.toThrow(/owned by uid/);
  });
  test('a relative or too-long directory is refused', async () => {
    await expect(ensureSocketDir('socks', uid)).rejects.toThrow(/absolute/);
    const long = join(await tmp.make('sd'), 'x'.repeat(MAX_SOCKET_PATH_BYTES));
    await expect(ensureSocketDir(long, uid)).rejects.toThrow(/too long/);
  });
  test('a plain file at the path is refused', async () => {
    const file = join(await tmp.make('sd'), 'file');
    await writeFile(file, '');
    await expect(ensureSocketDir(file, uid)).rejects.toThrow(SocketDirError);
  });
});

describe('CredentialServer (D79)', () => {
  const socketIn = async (): Promise<string> => join(await tmp.make('cs'), 'c.sock');

  test('answers `get` with one JSON line, and the socket file is mode 0600', async () => {
    const path = await socketIn();
    const server = await CredentialServer.listen(path, async () => TOKEN);
    try {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await ask(path, 'get\n'))).toEqual(TOKEN);
    } finally {
      await server.close();
    }
  });
  test('any other line, or 64 bytes without a newline, is a bad request', async () => {
    const path = await socketIn();
    const server = await CredentialServer.listen(path, async () => TOKEN);
    try {
      expect(JSON.parse(await ask(path, 'store\n'))).toEqual({ ok: false, reason: 'bad request' });
      expect(JSON.parse(await ask(path, 'g'.repeat(65)))).toEqual({ ok: false, reason: 'bad request' });
    } finally {
      await server.close();
    }
  });
  test('a provider that throws answers `error` and never leaks the message', async () => {
    const path = await socketIn();
    const server = await CredentialServer.listen(path, async () => { throw new Error('ghs_secret in a message'); });
    try {
      expect(JSON.parse(await ask(path, 'get\n'))).toEqual({ ok: false, reason: 'error' });
    } finally {
      await server.close();
    }
  });
  test('Review focus 3: a stale file at the path (a daemon that died) is replaced', async () => {
    const path = await socketIn();
    await writeFile(path, 'stale');
    const server = await CredentialServer.listen(path, async () => TOKEN);
    try {
      expect(JSON.parse(await ask(path, 'get\n'))).toEqual(TOKEN);
    } finally {
      await server.close();
    }
  });
  test('close leaves alone a socket file that a newer server took over (a restarted daemon on the same path)', async () => {
    const path = await socketIn();
    const old = await CredentialServer.listen(path, async () => ({ ok: false, reason: 'old' }));
    const fresh = await CredentialServer.listen(path, async () => TOKEN);   // removes the old file, listens anew
    try {
      await old.close();
      expect(JSON.parse(await ask(path, 'get\n'))).toEqual(TOKEN);
    } finally {
      await fresh.close();
    }
  });
  test('close removes the socket file and does not wait for a reply that never comes', async () => {
    const path = await socketIn();
    const server = await CredentialServer.listen(path, () => new Promise<CredentialReply>(() => undefined));
    const pending = ask(path, 'get\n').catch(() => 'closed');
    await Bun.sleep(20);
    await server.close();
    expect(['', 'closed']).toContain(await pending);   // FIN or reset, depending on timing; never a reply
    await expect(stat(path)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/runner && bun test test/unit/cred-server.spec.ts`
Expected: FAIL, the modules do not exist.

- [ ] **Step 3: Implement**

```ts
// apps/runner/src/credentials/socket-dir.ts
import { createHash } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export class SocketDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocketDirError';
  }
}

/** Under the 104-byte `sun_path` of macOS (108 on Linux), with room to spare (D78). */
export const MAX_SOCKET_PATH_BYTES = 100;

export function defaultSocketDir(uid: number): string {
  return `/tmp/koda-runner-${uid}`;
}

/** D78: one socket per (runner, job, epoch); the runner id keeps two daemons of one uid apart. */
export function socketPathFor(dir: string, runnerId: string, jobId: string, leaseEpoch: number): string {
  const key = createHash('sha256').update(`${runnerId}:${jobId}:${leaseEpoch}`).digest('hex').slice(0, 16);
  return join(dir, `${key}.sock`);
}

/**
 * D78: created 0700 when absent. An existing one must be a real directory (not a link) owned by `uid` with no group or
 * other permission bit: a directory another user planted, or one they can list or write, could capture a token.
 */
export async function ensureSocketDir(dir: string, uid: number): Promise<void> {
  if (!isAbsolute(dir)) throw new SocketDirError('socketDir must be an absolute path');
  if (Buffer.byteLength(socketPathFor(dir, 'r', 'j', 1)) > MAX_SOCKET_PATH_BYTES) {
    throw new SocketDirError(`socketDir ${dir} is too long for a unix socket path (at most ${MAX_SOCKET_PATH_BYTES} bytes with the socket name)`);
  }
  await mkdir(dir, { recursive: true, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST' && error.code !== 'ENOTDIR') throw error;
  });
  const info = await lstat(dir);
  if (info.isSymbolicLink()) throw new SocketDirError(`socketDir ${dir} must be a directory, not a link`);
  if (!info.isDirectory()) throw new SocketDirError(`socketDir ${dir} is not a directory`);
  if (info.uid !== uid) throw new SocketDirError(`socketDir ${dir} is owned by uid ${info.uid}, not ${uid}`);
  if ((info.mode & 0o077) !== 0) throw new SocketDirError(`socketDir ${dir} must not be accessible to group or others (chmod 700 it)`);
}
```

```ts
// apps/runner/src/credentials/cred-server.ts
import { randomBytes } from 'node:crypto';
import { chmod, lstat, rename, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';

export type CredentialReply =
  | { ok: true; username: string; token: string; expiresAt: string; protocol: string; host: string }
  | { ok: false; reason: string };

/** D79: `get\n` is 4 bytes; anything this long without a newline is not a client of ours. */
export const MAX_REQUEST_BYTES = 64;

function serve(socket: Socket, reply: () => Promise<CredentialReply>): void {
  let buffered = '';
  let answered = false;
  const answer = (value: CredentialReply): void => {
    if (answered) return;
    answered = true;
    socket.end(`${JSON.stringify(value)}\n`);
  };
  socket.setEncoding('utf8');
  socket.on('error', () => undefined);   // a client that hangs up early is not our problem
  socket.on('data', (chunk: string) => {
    if (answered) return;
    buffered += chunk;
    const newline = buffered.indexOf('\n');
    if (newline < 0) {
      if (buffered.length > MAX_REQUEST_BYTES) answer({ ok: false, reason: 'bad request' });
      return;
    }
    if (buffered.slice(0, newline).trim() !== 'get') {
      answer({ ok: false, reason: 'bad request' });
      return;
    }
    // Never the error's message: it could carry a token (Global Constraints).
    reply().then(answer, () => answer({ ok: false, reason: 'error' }));
  });
}

/** One job's credential socket (design §3.1, D79). */
export class CredentialServer {
  private constructor(
    private readonly server: Server,
    private readonly open: Set<Socket>,
    readonly path: string,
    private readonly inode: number,
  ) {}

  /**
   * Listens on a private staging name in the same directory, makes it 0600, then renames it onto `path`. Closing a
   * node:net unix server unlinks the name it was bound to, so a server bound to `path` itself would delete a newer
   * server's socket when it closes late (a crashed daemon's servers close while the restarted one listens, D90).
   * The rename also replaces a stale file a dead daemon left at `path`.
   */
  static async listen(path: string, reply: () => Promise<CredentialReply>): Promise<CredentialServer> {
    const open = new Set<Socket>();
    const server = createServer((socket) => {
      open.add(socket);
      socket.on('close', () => open.delete(socket));
      serve(socket, reply);
    });
    const staging = join(dirname(path), `.${randomBytes(3).toString('hex')}`);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(staging, () => {
        server.off('error', reject);
        resolve();
      });
    });
    try {
      await chmod(staging, 0o600);
      await rename(staging, path);
    } catch (error) {
      server.close();
      throw error;
    }
    return new CredentialServer(server, open, path, (await lstat(path)).ino);
  }

  /**
   * Ends every open connection (a reply still waiting for a token is dropped) and stops listening (which unlinks only
   * the staging name, long renamed away). The public file is removed only while its inode is still this server's, so a
   * newer server on the same path keeps its socket (D90).
   */
  async close(): Promise<void> {
    for (const socket of this.open) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    const current = await lstat(this.path).catch(() => null);
    if (current?.ino === this.inode) await rm(this.path, { force: true });
  }
}
```

The `open` set is the server's own connection registry and is internal state, not an argument, so it is updated in place. That is the one deliberate exception to the immutable style in this plan: `net.Server` hands out sockets one at a time.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/runner && bun test test/unit/cred-server.spec.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/credentials/socket-dir.ts apps/runner/src/credentials/cred-server.ts apps/runner/test/unit/cred-server.spec.ts
git commit -m "feat(fleet): runner credential socket and socket directory checks (3b-1, D78, D79)"
```

---

### Task 4: The git credential helper

**Files:**
- Create: `apps/runner/src/credentials/git-credential.ts`
- Test: `apps/runner/test/unit/git-credential.spec.ts`

**Interfaces:**
- Consumes: `CredentialServer`, `CredentialReply` (Task 3).
- Produces:
  - `const CLIENT_TIMEOUT_MS = 40_000`
  - `function requestCredential(path: string, timeoutMs?: number): Promise<CredentialReply>`
  - `function parseReply(text: string): CredentialReply`
  - `function parseCredentialInput(text: string): Readonly<Record<string, string>>`
  - `interface GitCredIo { readonly readStdin: () => Promise<string>; readonly write: (text: string) => void; readonly request: (path: string) => Promise<CredentialReply> }`
  - `function runGitCred(args: readonly string[], io: GitCredIo): Promise<number>` (args = `[<sock>, <action>]`, as git appends the action)

- [ ] **Step 1: Write the failing tests**

```ts
// apps/runner/test/unit/git-credential.spec.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CredentialServer, type CredentialReply } from '../../src/credentials/cred-server';
import { parseCredentialInput, parseReply, requestCredential, runGitCred, type GitCredIo } from '../../src/credentials/git-credential';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const REPLY: CredentialReply = { ok: true, username: 'x-access-token', token: 'ghs_t', expiresAt: '2099-01-01T00:00:00Z', protocol: 'https', host: 'github.com' };

function io(stdin: string, reply: CredentialReply): GitCredIo & { out: string[]; asked: string[] } {
  const out: string[] = [];
  const asked: string[] = [];
  return { out, asked, readStdin: async () => stdin, write: (text) => { out.push(text); }, request: async (path) => { asked.push(path); return reply; } };
}
const input = (fields: Record<string, string>): string => `${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n')}\n\n`;

describe('parseCredentialInput', () => {
  test('reads key=value lines up to the blank line; a value may contain =', () => {
    expect(parseCredentialInput('protocol=https\nhost=github.com\npath=a=b\n\nignored=1\n')).toEqual({ protocol: 'https', host: 'github.com', path: 'a=b' });
  });
});

describe('runGitCred (D80)', () => {
  test('get for the job\'s own protocol and host prints username and password and exits 0', async () => {
    const x = io(input({ protocol: 'https', host: 'github.com' }), REPLY);
    expect(await runGitCred(['/s.sock', 'get'], x)).toBe(0);
    expect(x.out.join('')).toBe('username=x-access-token\npassword=ghs_t\n');
    expect(x.asked).toEqual(['/s.sock']);
  });
  test('Review focus 2: another host gets nothing, and the socket is still only asked once', async () => {
    const x = io(input({ protocol: 'https', host: 'gitlab.com' }), REPLY);
    expect(await runGitCred(['/s.sock', 'get'], x)).toBe(0);
    expect(x.out).toEqual([]);
    expect(x.asked).toEqual(['/s.sock']);   // the host is only known from the reply
  });
  test('the same host over another protocol gets nothing', async () => {
    const x = io(input({ protocol: 'http', host: 'github.com' }), REPLY);
    await runGitCred(['/s.sock', 'get'], x);
    expect(x.out).toEqual([]);
  });
  test.each(['store', 'erase'])('%s reads stdin, prints nothing, never asks the socket', async (action) => {
    const x = io(input({ protocol: 'https', host: 'github.com', password: 'p' }), REPLY);
    expect(await runGitCred(['/s.sock', action], x)).toBe(0);
    expect(x.out).toEqual([]);
    expect(x.asked).toEqual([]);
  });
  test('a refused reply prints nothing', async () => {
    const x = io(input({ protocol: 'https', host: 'github.com' }), { ok: false, reason: 'no token' });
    await runGitCred(['/s.sock', 'get'], x);
    expect(x.out).toEqual([]);
  });
  test('a token or username with a newline or NUL is never printed (it would inject credential lines)', async () => {
    for (const bad of [{ ...REPLY, token: 'a\nusername=evil' }, { ...REPLY, username: 'x\u0000' }]) {
      const x = io(input({ protocol: 'https', host: 'github.com' }), bad);
      await runGitCred(['/s.sock', 'get'], x);
      expect(x.out).toEqual([]);
    }
  });
  test('missing arguments exit 0 with nothing', async () => {
    const x = io('', REPLY);
    expect(await runGitCred([], x)).toBe(0);
    expect(x.out).toEqual([]);
  });
});

describe('requestCredential', () => {
  test('talks to a real CredentialServer', async () => {
    const path = join(await tmp.make('gc'), 'c.sock');
    const server = await CredentialServer.listen(path, async () => REPLY);
    try {
      expect(await requestCredential(path)).toEqual(REPLY);
    } finally {
      await server.close();
    }
  });
  test('a missing socket is `unavailable`', async () => {
    expect(await requestCredential(join(await tmp.make('gc'), 'none.sock'))).toEqual({ ok: false, reason: 'unavailable' });
  });
  test('a server that never answers is `timeout`', async () => {
    const path = join(await tmp.make('gc'), 'c.sock');
    const server = await CredentialServer.listen(path, () => new Promise<CredentialReply>(() => undefined));
    try {
      expect(await requestCredential(path, 50)).toEqual({ ok: false, reason: 'timeout' });
    } finally {
      await server.close();
    }
  });
  test('parseReply refuses anything that is not exactly one of the two shapes', () => {
    expect(parseReply('not json')).toEqual({ ok: false, reason: 'bad reply' });
    expect(parseReply('{"ok":true,"token":"t"}')).toEqual({ ok: false, reason: 'bad reply' });
    expect(parseReply('{"ok":false,"reason":"job ended"}\n')).toEqual({ ok: false, reason: 'job ended' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/runner && bun test test/unit/git-credential.spec.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement**

```ts
// apps/runner/src/credentials/git-credential.ts
import { createConnection } from 'node:net';
import type { CredentialReply } from './cred-server';

/** Longer than the server's own wait for a token (D79, 30 s), so the server's answer wins. */
export const CLIENT_TIMEOUT_MS = 40_000;
const MAX_REPLY_BYTES = 16_384;
const REPLY_FIELDS = ['username', 'token', 'expiresAt', 'protocol', 'host'] as const;

export function parseReply(text: string): CredentialReply {
  try {
    const value = JSON.parse(text.trim()) as Record<string, unknown>;
    if (value['ok'] === true && REPLY_FIELDS.every((field) => typeof value[field] === 'string')) {
      const [username, token, expiresAt, protocol, host] = REPLY_FIELDS.map((field) => value[field] as string);
      return { ok: true, username, token, expiresAt, protocol, host };
    }
    if (value['ok'] === false && typeof value['reason'] === 'string') return { ok: false, reason: value['reason'] };
  } catch {
    // fall through: not JSON
  }
  return { ok: false, reason: 'bad reply' };
}

/** D79: one `get` line, one JSON reply. Every failure is a reply, never a throw. */
export function requestCredential(path: string, timeoutMs: number = CLIENT_TIMEOUT_MS): Promise<CredentialReply> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let out = '';
    let done = false;
    const finish = (value: CredentialReply): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write('get\n'));
    socket.on('data', (chunk: string) => {
      out += chunk;
      if (out.length > MAX_REPLY_BYTES) finish({ ok: false, reason: 'reply too large' });
    });
    socket.on('end', () => finish(parseReply(out)));
    socket.on('close', () => finish(parseReply(out)));   // a close without FIN must not wait for the timeout
    socket.on('error', () => finish({ ok: false, reason: 'unavailable' }));
  });
}

/** git-credential(1) input: `key=value` lines up to a blank line. */
export function parseCredentialInput(text: string): Readonly<Record<string, string>> {
  const lines = text.split('\n');
  const end = lines.indexOf('');
  return Object.fromEntries(
    (end < 0 ? lines : lines.slice(0, end))
      .filter((line) => line.indexOf('=') > 0)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const),
  );
}

export interface GitCredIo {
  readonly readStdin: () => Promise<string>;
  readonly write: (text: string) => void;
  readonly request: (path: string) => Promise<CredentialReply>;
}

const SAFE = /^[^\n\r\0]+$/;

/**
 * `koda-runner git-cred <sock> <action>` (design §3.1, D80). git appends the action. Always exits 0: printing nothing
 * means "no credential"; git then authenticates with nothing and fails with its own authentication error.
 */
export async function runGitCred(args: readonly string[], io: GitCredIo): Promise<number> {
  const [sock, action] = args;
  const fields = parseCredentialInput(await io.readStdin());   // read first: git writes before it reads (no SIGPIPE)
  if (action !== 'get' || !sock) return 0;
  const reply = await io.request(sock);
  if (!reply.ok) return 0;
  if (fields['protocol'] !== reply.protocol || fields['host'] !== reply.host) return 0;
  if (!SAFE.test(reply.username) || !SAFE.test(reply.token)) return 0;
  io.write(`username=${reply.username}\npassword=${reply.token}\n`);
  return 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/runner && bun test test/unit/git-credential.spec.ts`
Expected: PASS, 13 tests (each `test.each` row counts).

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/credentials/git-credential.ts apps/runner/test/unit/git-credential.spec.ts
git commit -m "feat(fleet): runner git credential helper over the job socket (3b-1, D80)"
```

---
### Task 5: The gh/glab shim

**Files:**
- Create: `apps/runner/src/credentials/shim.ts`
- Test: `apps/runner/src/credentials/shim.spec.ts`

**Interfaces:**
- Consumes: `CredentialReply` (Task 3).
- Produces:
  - `type ShimTool = 'gh' | 'glab'`; `const SHIM_TOOLS: readonly ShimTool[]`
  - `function tokenEnv(tool: ShimTool, reply: Extract<CredentialReply, { ok: true }>): Readonly<Record<string, string>>`
  - `function pathWithout(pathValue: string, dir: string): string`
  - `interface ShimChild { readonly exited: Promise<number>; kill(signal: NodeJS.Signals): void }`
  - `interface ShimDeps { readonly env: Readonly<Record<string, string | undefined>>; readonly request: (path: string) => Promise<CredentialReply>; readonly which: (command: string, path: string) => string | null; readonly spawn: (argv: readonly string[], env: Readonly<Record<string, string | undefined>>) => ShimChild; readonly warn: (line: string) => void; readonly onSignal: (signal: NodeJS.Signals, handler: () => void) => void }`
  - `function runShim(args: readonly string[], deps: ShimDeps): Promise<number>` (args = `[<tool>, <sock>, <binDir>, '--', ...toolArgs]`)

- [ ] **Step 1: Write the failing tests**

```ts
// apps/runner/src/credentials/shim.spec.ts
import { describe, expect, test } from 'bun:test';
import type { CredentialReply } from './cred-server';
import { pathWithout, runShim, tokenEnv, type ShimDeps } from './shim';

const granted = (host: string): Extract<CredentialReply, { ok: true }> => ({ ok: true, username: 'x-access-token', token: 'ghs_s', expiresAt: '2099-01-01T00:00:00Z', protocol: 'https', host });

function fake(reply: CredentialReply, over: Partial<ShimDeps> = {}) {
  const spawned: Array<{ argv: readonly string[]; env: Readonly<Record<string, string | undefined>> }> = [];
  const warnings: string[] = [];
  const handlers = new Map<string, () => void>();
  const killed: string[] = [];
  const asked: string[] = [];
  const deps: ShimDeps = {
    env: { PATH: '/job/bin:/usr/local/bin:/usr/bin', HOME: '/h' },
    request: async (path) => { asked.push(path); return reply; },
    which: (command, path) => (path.split(':').includes('/usr/local/bin') ? `/usr/local/bin/${command}` : null),
    spawn: (argv, env) => { spawned.push({ argv, env }); return { exited: Promise.resolve(3), kill: (signal) => { killed.push(signal); } }; },
    warn: (line) => { warnings.push(line); },
    onSignal: (signal, handler) => { handlers.set(signal, handler); },
    ...over,
  };
  return { deps, spawned, warnings, handlers, killed, asked };
}

describe('tokenEnv (D87)', () => {
  test('gh on github.com gets GH_TOKEN only; another host also gets GH_HOST and GH_ENTERPRISE_TOKEN', () => {
    expect(tokenEnv('gh', granted('github.com'))).toEqual({ GH_TOKEN: 'ghs_s' });
    expect(tokenEnv('gh', granted('ghe.corp:8443'))).toEqual({ GH_TOKEN: 'ghs_s', GH_ENTERPRISE_TOKEN: 'ghs_s', GH_HOST: 'ghe.corp:8443' });
  });
  test('glab on gitlab.com gets GITLAB_TOKEN only; another host also gets GITLAB_HOST', () => {
    expect(tokenEnv('glab', granted('gitlab.com'))).toEqual({ GITLAB_TOKEN: 'ghs_s' });
    expect(tokenEnv('glab', granted('git.corp'))).toEqual({ GITLAB_TOKEN: 'ghs_s', GITLAB_HOST: 'git.corp' });
  });
});

describe('pathWithout', () => {
  test('drops the shim dir however it is spelled, and empty entries', () => {
    expect(pathWithout('/job/bin::/usr/bin:/job/bin/:/job/./bin', '/job/bin')).toBe('/usr/bin');
  });
});

describe('runShim (D87)', () => {
  test('runs the real gh with the token, the arguments verbatim, and PATH without the shim dir; returns its exit code', async () => {
    const f = fake(granted('github.com'));
    const code = await runShim(['gh', '/s.sock', '/job/bin', '--', 'pr', 'create', '--title', "it's $HOME"], f.deps);
    expect(code).toBe(3);
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0].argv).toEqual(['/usr/local/bin/gh', 'pr', 'create', '--title', "it's $HOME"]);
    expect(f.spawned[0].env).toMatchObject({ GH_TOKEN: 'ghs_s', PATH: '/usr/local/bin:/usr/bin', HOME: '/h' });
    expect(f.asked).toEqual(['/s.sock']);
  });
  test('without a token the real binary still runs, with no token variable and one warning', async () => {
    const f = fake({ ok: false, reason: 'no token' });
    await runShim(['glab', '/s.sock', '/job/bin', '--', '--version'], f.deps);
    expect(f.spawned[0].env['GITLAB_TOKEN']).toBeUndefined();
    expect(f.warnings).toEqual(['koda-runner: no git token for this job (no token); running glab without one']);
  });
  test('no real binary on PATH exits 127 and never asks the socket', async () => {
    const f = fake(granted('github.com'), { which: () => null });
    expect(await runShim(['gh', '/s.sock', '/job/bin', '--', 'pr', 'view'], f.deps)).toBe(127);
    expect(f.warnings).toEqual(['koda-runner: gh not found on PATH']);
    expect(f.asked).toEqual([]);
    expect(f.spawned).toEqual([]);
  });
  test.each([
    [['hub', '/s', '/b', '--']],
    [['gh', '/s', '/b', 'pr']],
    [['gh']],
  ])('bad usage %j exits 2', async (args) => {
    const f = fake(granted('github.com'));
    expect(await runShim(args, f.deps)).toBe(2);
    expect(f.spawned).toEqual([]);
  });
  test('SIGINT, SIGTERM and SIGHUP are forwarded to the child', async () => {
    const f = fake(granted('github.com'));
    await runShim(['gh', '/s.sock', '/job/bin', '--', 'pr', 'create'], f.deps);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) f.handlers.get(signal)?.();
    expect(f.killed).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/runner && bun test src/credentials/shim.spec.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement**

```ts
// apps/runner/src/credentials/shim.ts
import { delimiter, resolve } from 'node:path';
import type { CredentialReply } from './cred-server';

export type ShimTool = 'gh' | 'glab';
export const SHIM_TOOLS: readonly ShimTool[] = ['gh', 'glab'];
const isTool = (value: string | undefined): value is ShimTool => SHIM_TOOLS.some((tool) => tool === value);

type Granted = Extract<CredentialReply, { ok: true }>;

/** D87: the variable each CLI reads its token from; a host other than the public one must also be named. */
export function tokenEnv(tool: ShimTool, reply: Granted): Readonly<Record<string, string>> {
  if (tool === 'gh') {
    return reply.host === 'github.com'
      ? { GH_TOKEN: reply.token }
      : { GH_TOKEN: reply.token, GH_ENTERPRISE_TOKEN: reply.token, GH_HOST: reply.host };
  }
  return reply.host === 'gitlab.com' ? { GITLAB_TOKEN: reply.token } : { GITLAB_TOKEN: reply.token, GITLAB_HOST: reply.host };
}

/** `PATH` without the shim directory (compared after `resolve`, so `bin/` and `./bin` match) and without empty entries. */
export function pathWithout(pathValue: string, dir: string): string {
  const target = resolve(dir);
  return pathValue.split(delimiter).filter((entry) => entry !== '' && resolve(entry) !== target).join(delimiter);
}

export interface ShimChild {
  /** The exit code, or 128 plus the signal number when the child was killed by a signal. */
  readonly exited: Promise<number>;
  kill(signal: NodeJS.Signals): void;
}

export interface ShimDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly request: (path: string) => Promise<CredentialReply>;
  readonly which: (command: string, path: string) => string | null;
  readonly spawn: (argv: readonly string[], env: Readonly<Record<string, string | undefined>>) => ShimChild;
  readonly warn: (line: string) => void;
  readonly onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
}

const FORWARDED: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * `koda-runner shim <gh|glab> <sock> <binDir> -- <args...>` (design §3.1, D87). The token goes into this one child's
 * environment and nowhere else; the shim directory leaves PATH so the child cannot find the shim again.
 */
export async function runShim(args: readonly string[], deps: ShimDeps): Promise<number> {
  const [tool, sock, binDir, separator, ...rest] = args;
  if (!isTool(tool) || !sock || !binDir || separator !== '--') {
    deps.warn('koda-runner shim: usage: shim <gh|glab> <sock> <binDir> -- <args...>');
    return 2;
  }
  const path = pathWithout(deps.env['PATH'] ?? '', binDir);
  const real = deps.which(tool, path);
  if (!real) {
    deps.warn(`koda-runner: ${tool} not found on PATH`);
    return 127;
  }
  const reply = await deps.request(sock);
  if (!reply.ok) deps.warn(`koda-runner: no git token for this job (${reply.reason}); running ${tool} without one`);
  const child = deps.spawn([real, ...rest], { ...deps.env, PATH: path, ...(reply.ok ? tokenEnv(tool, reply) : {}) });
  for (const signal of FORWARDED) deps.onSignal(signal, () => child.kill(signal));
  return child.exited;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/runner && bun test src/credentials/shim.spec.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/credentials/shim.ts apps/runner/src/credentials/shim.spec.ts
git commit -m "feat(fleet): runner gh/glab shim that injects the job token (3b-1, D87)"
```

---

### Task 6: `git-cred` and `shim` as runner commands, job files, the fake gh

**Files:**
- Create: `apps/runner/src/self-command.ts`, `apps/runner/src/credentials/job-files.ts`, `apps/runner/src/internal-commands.ts`
- Modify: `apps/runner/src/main.ts` (early dispatch, before `new Command()`)
- Create: `apps/runner/test/fixtures/fake-gh.ts`, `apps/runner/test/helpers/fake-gh.ts`
- Test: `apps/runner/src/credentials/job-files.spec.ts`, `apps/runner/src/self-command.spec.ts`, `apps/runner/test/unit/credential-cli.spec.ts`

**Interfaces:**
- Consumes: `runGitCred`, `requestCredential` (Task 4); `runShim`, `SHIM_TOOLS`, `ShimTool`, `ShimChild` (Task 5); `CredentialServer` (Task 3).
- Produces:
  - `function selfCommand(execPath?: string, main?: string): string[]`
  - `function shellQuote(value: string): string`
  - `function helperValue(self: readonly string[], sock: string): string`
  - `function shimScript(self: readonly string[], tool: ShimTool, sock: string, binDir: string): string`
  - `function writeShims(binDir: string, self: readonly string[], sock: string): Promise<void>`
  - `function dispatchInternal(argv: readonly string[]): Promise<number | null>`
  - test helper `installFakeGh(dir: string): Promise<{ binDir: string; logPath: string }>`; the fake gh reads `FAKE_GH_LOG`, `FAKE_GH_EXIT`, `FAKE_GH_PR_URL`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/runner/src/self-command.spec.ts
import { describe, expect, test } from 'bun:test';
import { selfCommand } from './self-command';

describe('selfCommand (D84)', () => {
  test('a compiled binary runs itself', () => {
    expect(selfCommand('/usr/local/bin/koda-runner', '/$bunfs/root/koda-runner')).toEqual(['/usr/local/bin/koda-runner']);
  });
  test('from source it is bun plus the entry file', () => {
    expect(selfCommand('/home/u/.bun/bin/bun', '/repo/apps/runner/src/main.ts')).toEqual(['/home/u/.bun/bin/bun', '/repo/apps/runner/src/main.ts']);
  });
});
```

```ts
// apps/runner/src/credentials/job-files.spec.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { helperValue, shellQuote, shimScript, writeShims } from './job-files';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

describe('job files (D85, D87)', () => {
  test('shellQuote wraps in single quotes and escapes a single quote', () => {
    expect(shellQuote('plain')).toBe("'plain'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('$HOME `x` "y"')).toBe("'$HOME `x` \"y\"'");
  });
  test('the helper value is a quoted `!` command that ends at the socket (git appends the action)', () => {
    expect(helperValue(['/b/bun', "/r/it's/main.ts"], '/s/a.sock')).toBe("!'/b/bun' '/r/it'\\''s/main.ts' 'git-cred' '/s/a.sock'");
  });
  test('a shim script execs the runner with its tool, socket and bin dir, then every argument', () => {
    expect(shimScript(['/k/koda-runner'], 'gh', '/s/a.sock', '/j/bin')).toBe("#!/bin/sh\nexec '/k/koda-runner' 'shim' 'gh' '/s/a.sock' '/j/bin' -- \"$@\"\n");
  });
  test('writeShims writes gh and glab, mode 0700, in a 0700 directory', async () => {
    const binDir = join(await tmp.make('jf'), 'bin');
    await writeShims(binDir, ['/k/koda-runner'], '/s/a.sock');
    expect((await stat(binDir)).mode & 0o777).toBe(0o700);
    for (const tool of ['gh', 'glab']) {
      expect((await stat(join(binDir, tool))).mode & 0o777).toBe(0o700);
      expect(await readFile(join(binDir, tool), 'utf8')).toContain(`'shim' '${tool}'`);
    }
  });
});
```

```ts
// apps/runner/test/fixtures/fake-gh.ts
/** A stand-in for `gh` (plan 3b-1 Task 6): logs what it was given, answers `pr create` with a PR URL. */
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const log = process.env['FAKE_GH_LOG'];
if (log) {
  appendFileSync(log, `${JSON.stringify({ argv: args, ghToken: process.env['GH_TOKEN'] ?? null, ghHost: process.env['GH_HOST'] ?? null, path: process.env['PATH'] ?? '' })}\n`);
}
if (args[0] === '--version') console.log('gh version 0.0.0-fake');
else if (args[0] === 'pr' && args[1] === 'create') console.log(process.env['FAKE_GH_PR_URL'] ?? 'https://example.test/koda/pull/7');
process.exit(Number(process.env['FAKE_GH_EXIT'] ?? 0));
```

```ts
// apps/runner/test/helpers/fake-gh.ts
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { shellQuote } from '../../src/credentials/job-files';

const FAKE_GH = join(import.meta.dir, '..', 'fixtures', 'fake-gh.ts');

/** A directory holding an executable `gh` that runs the fake; put it on PATH behind the job's shims. */
export async function installFakeGh(dir: string): Promise<{ binDir: string; logPath: string }> {
  const binDir = join(dir, 'fake-gh-bin');
  await mkdir(binDir, { recursive: true });
  const path = join(binDir, 'gh');
  await writeFile(path, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(FAKE_GH)} "$@"\n`);
  await chmod(path, 0o755);
  return { binDir, logPath: join(dir, 'fake-gh.log') };
}
```

```ts
// apps/runner/test/unit/credential-cli.spec.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { CredentialServer, type CredentialReply } from '../../src/credentials/cred-server';
import { helperValue, writeShims } from '../../src/credentials/job-files';
import { installFakeGh } from '../helpers/fake-gh';
import { isolateGit } from '../helpers/git-fixture';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());
const MAIN = join(import.meta.dir, '..', '..', 'src', 'main.ts');
const SELF = [process.execPath, MAIN];
const REPLY: CredentialReply = { ok: true, username: 'x-access-token', token: 'ghs_cli', expiresAt: '2099-01-01T00:00:00Z', protocol: 'https', host: 'github.com' };

async function run(argv: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawn(argv, {
    stdin: opts.stdin === undefined ? 'ignore' : new TextEncoder().encode(opts.stdin), stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, ...opts.env },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe('koda-runner git-cred through real git (design §3.1, D80, D84)', () => {
  test('`git credential fill` gets the job token for the job host', async () => {
    const sock = join(await tmp.make('cli'), 'c.sock');
    const server = await CredentialServer.listen(sock, async () => REPLY);
    try {
      const out = await run(['git', '-c', 'credential.helper=', '-c', `credential.helper=${helperValue(SELF, sock)}`, 'credential', 'fill'], { stdin: 'protocol=https\nhost=github.com\n\n' });
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('username=x-access-token\n');
      expect(out.stdout).toContain('password=ghs_cli\n');
    } finally {
      await server.close();
    }
  });
  test('Review focus 2: for another host git gets nothing and, with prompts disabled, fails', async () => {
    const sock = join(await tmp.make('cli'), 'c.sock');
    const server = await CredentialServer.listen(sock, async () => REPLY);
    try {
      const out = await run(['git', '-c', 'credential.helper=', '-c', `credential.helper=${helperValue(SELF, sock)}`, 'credential', 'fill'], { stdin: 'protocol=https\nhost=evil.example\n\n', env: { GIT_ASKPASS: 'false' } });   // no askpass fallback from the shell
      expect(out.code).not.toBe(0);
      expect(out.stdout).not.toContain('ghs_cli');
    } finally {
      await server.close();
    }
  });
});

describe('koda-runner shim through a real shim script (D87)', () => {
  test('Review focus 4: gh gets the token, every argument byte for byte, a PATH without the shims; its exit code comes back', async () => {
    const dir = await tmp.make('cli');
    const sock = join(dir, 'c.sock');
    const binDir = join(dir, 'bin');
    const server = await CredentialServer.listen(sock, async () => REPLY);
    try {
      await writeShims(binDir, SELF, sock);
      const fake = await installFakeGh(dir);
      const title = `it's "$HOME" \`x\` a  b\nline two`;
      const out = await run([join(binDir, 'gh'), 'pr', 'create', '--title', title], {
        env: { PATH: [binDir, fake.binDir, process.env['PATH'] ?? ''].join(delimiter), FAKE_GH_LOG: fake.logPath, FAKE_GH_EXIT: '3' },
      });
      expect(out.code).toBe(3);
      expect(out.stdout.trim()).toBe('https://example.test/koda/pull/7');
      const [entry] = (await readFile(fake.logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(entry.argv).toEqual(['pr', 'create', '--title', title]);
      expect(entry.ghToken).toBe('ghs_cli');
      expect(entry.path.split(delimiter)).not.toContain(binDir);
    } finally {
      await server.close();
    }
  });
  test('with the socket gone gh still runs, without a token, and the shim warns once', async () => {
    const dir = await tmp.make('cli');
    const binDir = join(dir, 'bin');
    await writeShims(binDir, SELF, join(dir, 'gone.sock'));
    const fake = await installFakeGh(dir);
    const out = await run([join(binDir, 'gh'), '--version'], { env: { PATH: [binDir, fake.binDir, process.env['PATH'] ?? ''].join(delimiter), FAKE_GH_LOG: fake.logPath } });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('gh version 0.0.0-fake');
    expect(out.stderr).toContain('no git token for this job (unavailable)');
    expect(JSON.parse((await readFile(fake.logPath, 'utf8')).trim()).ghToken).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/runner && bun test src/self-command.spec.ts src/credentials/job-files.spec.ts test/unit/credential-cli.spec.ts`
Expected: FAIL, the modules do not exist.

- [ ] **Step 3: Implement**

```ts
// apps/runner/src/self-command.ts
/** D84: how the git helper and the shims run this runner again. A compiled binary's entry lives under `/$bunfs/`. */
export function selfCommand(execPath: string = process.execPath, main: string = Bun.main): string[] {
  return main.startsWith('/$bunfs/') ? [execPath] : [execPath, main];
}
```

```ts
// apps/runner/src/credentials/job-files.ts
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SHIM_TOOLS, type ShimTool } from './shim';

/** POSIX single quotes: inside them only the quote itself needs care. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** D85: git runs a `!` helper through the shell and appends the action (`get`, `store`, `erase`). */
export function helperValue(self: readonly string[], sock: string): string {
  return `!${[...self, 'git-cred', sock].map(shellQuote).join(' ')}`;
}

/** D87: `exec` keeps the pid, so a signal nax sends reaches the shim, which forwards it. */
export function shimScript(self: readonly string[], tool: ShimTool, sock: string, binDir: string): string {
  return `#!/bin/sh\nexec ${[...self, 'shim', tool, sock, binDir].map(shellQuote).join(' ')} -- "$@"\n`;
}

export async function writeShims(binDir: string, self: readonly string[], sock: string): Promise<void> {
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  await chmod(binDir, 0o700);
  for (const tool of SHIM_TOOLS) {
    const path = join(binDir, tool);
    await writeFile(path, shimScript(self, tool, sock, binDir), { mode: 0o700 });
    await chmod(path, 0o700);   // writeFile's mode applies only when it creates the file
  }
}
```

```ts
// apps/runner/src/internal-commands.ts
import { constants } from 'node:os';
import { requestCredential, runGitCred } from './credentials/git-credential';
import { runShim, type ShimChild } from './credentials/shim';

function spawnInherited(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): ShimChild {
  const proc = Bun.spawn([...argv], { env: { ...env }, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  return {
    exited: proc.exited.then((code) => (proc.signalCode ? 128 + (constants.signals[proc.signalCode] ?? 0) : code)),
    kill: (signal) => { proc.kill(signal); },
  };
}

/**
 * D84: git and the shim scripts call the runner binary with these words first. They are handled before commander, so
 * a `gh` flag such as `--title` or `-R` is never read as a runner option. `null`: not an internal command.
 */
export async function dispatchInternal(argv: readonly string[]): Promise<number | null> {
  const [command, ...rest] = argv;
  if (command === 'git-cred') {
    return runGitCred(rest, {
      readStdin: () => Bun.stdin.text(),
      write: (text) => { process.stdout.write(text); },
      request: (path) => requestCredential(path),
    });
  }
  if (command === 'shim') {
    return runShim(rest, {
      env: process.env,
      request: (path) => requestCredential(path),
      which: (cmd, path) => Bun.which(cmd, { PATH: path }),
      spawn: spawnInherited,
      warn: (line) => { process.stderr.write(`${line}\n`); },
      onSignal: (signal, handler) => { process.on(signal, handler); },
    });
  }
  return null;
}
```

`apps/runner/src/main.ts`: add the import and, directly after the imports (before `const say = ...`):

```ts
import { dispatchInternal } from './internal-commands';
// ...
const internal = await dispatchInternal(process.argv.slice(2));
if (internal !== null) process.exit(internal);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/runner && bun test src/self-command.spec.ts src/credentials/job-files.spec.ts test/unit/credential-cli.spec.ts && bun run type-check && bun run lint`
Expected: PASS, 10 tests; type-check and lint clean.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/self-command.ts apps/runner/src/self-command.spec.ts apps/runner/src/credentials/job-files.ts apps/runner/src/credentials/job-files.spec.ts apps/runner/src/internal-commands.ts apps/runner/src/main.ts apps/runner/test/fixtures/fake-gh.ts apps/runner/test/helpers/fake-gh.ts apps/runner/test/unit/credential-cli.spec.ts
git commit -m "feat(fleet): koda-runner git-cred and shim commands, job shim files (3b-1, D84, D85, D87)"
```

---

### Task 7: CredentialBroker

**Files:**
- Create: `apps/runner/src/credentials/broker.ts`
- Test: `apps/runner/test/unit/broker.spec.ts`

**Interfaces:**
- Consumes: `TokenCache` (Task 1), `CredentialServer`/`CredentialReply` (Task 3), `socketPathFor` (Task 3), `helperValue`/`writeShims` (Task 6), `requestCredential` (Task 4, tests only), `JobRow` (`src/journal/types.ts`).
- Produces:
  - `interface JobCredentials { readonly helper: string | null; readonly binDir: string | null }`
  - `type AcquireResult = { ok: true; credentials: JobCredentials } | { ok: false; reason: string; cancelled?: true }`
  - `interface AcquireOptions { readonly wait: boolean; readonly isCancelled?: () => boolean }`
  - `interface CredentialProvider { acquire(job: JobRow, options: AcquireOptions): Promise<AcquireResult>; release(job: JobRow): Promise<void> }`
  - `interface BrokerTiming { readonly waitMs: number; readonly serveWaitMs: number; readonly pollMs: number }`
  - `interface BrokerDeps { readonly tokens: TokenCache; readonly socketDir: string; readonly runnerId: string; readonly selfCommand: readonly string[]; readonly nowMs: () => number; readonly sleep: Sleep; readonly timing: BrokerTiming }`
  - `class CredentialBroker implements CredentialProvider { constructor(deps: BrokerDeps); acquire(...); release(...); closeAll(): Promise<void> }`

- [ ] **Step 1: Write the failing tests**

The broker is timed on the real clock with short timings. Token expiry is wall-clock time, and the socket side runs across processes, so a fake clock would spin through the server's wait before the test can act.

```ts
// apps/runner/test/unit/broker.spec.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CredentialBroker, type BrokerTiming } from '../../src/credentials/broker';
import { requestCredential } from '../../src/credentials/git-credential';
import { helperValue } from '../../src/credentials/job-files';
import { socketPathFor } from '../../src/credentials/socket-dir';
import { TokenCache } from '../../src/credentials/token-cache';
import { Journal } from '../../src/journal/journal';
import type { JobRow } from '../../src/journal/types';
import { assignFor } from '../helpers/assign';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const SELF = ['/k/koda-runner'];
const FAST: BrokerTiming = { waitMs: 2_000, serveWaitMs: 2_000, pollMs: 5 };

async function world(timing: BrokerTiming = FAST) {
  const base = await tmp.make('br');
  const socketDir = join(base, 's');
  await mkdir(socketDir, { mode: 0o700 });
  const tokens = new TokenCache({ refreshMarginMs: 240_000, cooldownMs: 30_000 });
  const broker = new CredentialBroker({ tokens, socketDir, runnerId: 'r1', selfCommand: SELF, nowMs: () => Date.now(), sleep: (ms) => Bun.sleep(ms), timing });
  const journal = Journal.open(':memory:');
  const job = (cloneUrl = 'https://github.com/acme/app.git', leaseEpoch = 1, jobId = 'j1'): JobRow => {
    const repo = { provider: 'github' as const, owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl };
    return journal.insertJob({ assign: assignFor('RUN', { jobId, repo }), leaseEpoch, repoKey: 'acme/app', jobDir: join(base, '.jobs', jobId) }).row;
  };
  const grant = (row: JobRow, token = 'ghs_b') => tokens.apply(
    [{ jobId: row.jobId, leaseEpoch: row.leaseEpoch }],
    [{ jobId: row.jobId, token, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), username: 'x-access-token' }], [], Date.now(),
  );
  return { base, socketDir, tokens, broker, job, grant, sock: (row: JobRow) => socketPathFor(socketDir, 'r1', row.jobId, row.leaseEpoch) };
}

describe('CredentialBroker (design §3.1, D78-D83, D90)', () => {
  test('D83: a file: clone URL needs no token, socket, shims or helper', async () => {
    const w = await world();
    const row = w.job('file:///srv/acme/app.git');
    expect(await w.broker.acquire(row, { wait: true })).toEqual({ ok: true, credentials: { helper: null, binDir: null } });
    expect(w.tokens.requests(Date.now())).toEqual([]);
  });
  test('prepare waits for the first token, then gets the helper value and the shims; the socket answers for the clone host', async () => {
    const w = await world();
    const row = w.job();
    setTimeout(() => w.grant(row), 30);
    const result = await w.broker.acquire(row, { wait: true });
    expect(result).toEqual({ ok: true, credentials: { helper: helperValue(SELF, w.sock(row)), binDir: join(row.jobDir, 'bin') } });
    expect((await stat(join(row.jobDir, 'bin', 'gh'))).mode & 0o777).toBe(0o700);
    expect(await requestCredential(w.sock(row))).toMatchObject({ ok: true, token: 'ghs_b', username: 'x-access-token', protocol: 'https', host: 'github.com' });
    await w.broker.closeAll();
  });
  test('D82: a token error while waiting fails with `git token: <reason>`', async () => {
    const w = await world();
    const row = w.job();
    setTimeout(() => w.tokens.apply([{ jobId: 'j1', leaseEpoch: 1 }], [], [{ jobId: 'j1', reason: 'app_not_installed' }], Date.now()), 30);
    expect(await w.broker.acquire(row, { wait: true })).toEqual({ ok: false, reason: 'git token: app_not_installed' });
    await w.broker.closeAll();
  });
  test('D82: no token within the wait is `git token: timeout`', async () => {
    const w = await world({ ...FAST, waitMs: 50 });
    expect(await w.broker.acquire(w.job(), { wait: true })).toEqual({ ok: false, reason: 'git token: timeout' });
    await w.broker.closeAll();
  });
  test('a cancel while waiting ends the wait as cancelled', async () => {
    const w = await world();
    expect(await w.broker.acquire(w.job(), { wait: true, isCancelled: () => true })).toEqual({ ok: false, reason: 'cancelled', cancelled: true });
    await w.broker.closeAll();
  });
  test('closeAll ends a prepare that is still waiting for its first token (daemon stop)', async () => {
    const w = await world({ ...FAST, waitMs: 60_000 });
    const waiting = w.broker.acquire(w.job(), { wait: true });
    setTimeout(() => { void w.broker.closeAll(); }, 30);
    expect(await waiting).toEqual({ ok: false, reason: 'cancelled', cancelled: true });
  });
  test('D79: without waiting, a socket request made before the token exists is answered once it arrives', async () => {
    const w = await world();
    const row = w.job('http://127.0.0.1:8080/acme/app.git');
    expect((await w.broker.acquire(row, { wait: false })).ok).toBe(true);
    const pending = requestCredential(w.sock(row));
    setTimeout(() => w.grant(row, 'ghs_late'), 30);
    expect(await pending).toMatchObject({ ok: true, token: 'ghs_late', protocol: 'http', host: '127.0.0.1:8080' });
    await w.broker.closeAll();
  });
  test('D79: a request that waits past serveWaitMs is `no token`', async () => {
    const w = await world({ ...FAST, serveWaitMs: 40 });
    const row = w.job();
    await w.broker.acquire(row, { wait: false });
    expect(await requestCredential(w.sock(row))).toEqual({ ok: false, reason: 'no token' });
    await w.broker.closeAll();
  });
  test('release closes the socket, forgets the token and removes the shims', async () => {
    const w = await world();
    const row = w.job();
    w.tokens.want('j1', 1);
    w.grant(row);
    await w.broker.acquire(row, { wait: true });
    await w.broker.release(row);
    expect(await requestCredential(w.sock(row))).toEqual({ ok: false, reason: 'unavailable' });
    expect(w.tokens.wanted('j1', 1)).toBe(false);
    await expect(stat(join(row.jobDir, 'bin'))).rejects.toThrow();
  });
  test('Review focus 3: a stale socket file left by a dead daemon is replaced', async () => {
    const w = await world();
    const row = w.job();
    await writeFile(w.sock(row), 'stale');
    w.tokens.want('j1', 1);
    w.grant(row);
    expect((await w.broker.acquire(row, { wait: true })).ok).toBe(true);
    expect(await requestCredential(w.sock(row))).toMatchObject({ ok: true });
    await w.broker.closeAll();
  });
  test('acquire twice is the same socket and does not fail', async () => {
    const w = await world();
    const row = w.job();
    w.tokens.want('j1', 1);
    w.grant(row);
    const [a, b] = await Promise.all([w.broker.acquire(row, { wait: true }), w.broker.acquire(row, { wait: true })]);
    expect(a).toEqual(b);
    expect(await requestCredential(w.sock(row))).toMatchObject({ ok: true });
    await w.broker.closeAll();
  });
  test('D90: two epochs have two sockets; releasing the older leaves the newer serving, shims included', async () => {
    const w = await world();
    const one = w.job(undefined, 1);
    const two = w.job(undefined, 2);
    for (const row of [one, two]) {
      w.tokens.want(row.jobId, row.leaseEpoch);
      w.grant(row);
      await w.broker.acquire(row, { wait: true });
    }
    expect(w.sock(one)).not.toBe(w.sock(two));
    await w.broker.release(one);
    expect(await requestCredential(w.sock(one))).toEqual({ ok: false, reason: 'unavailable' });
    expect(await requestCredential(w.sock(two))).toMatchObject({ ok: true });
    await expect(stat(join(two.jobDir, 'bin', 'gh'))).resolves.toBeDefined();   // the shared shims stay for epoch 2
    await w.broker.closeAll();
  });
  test('D90: closeAll closes every socket but keeps the tokens wanted (a restarted daemon readopts)', async () => {
    const w = await world();
    const row = w.job();
    w.tokens.want('j1', 1);
    w.grant(row);
    await w.broker.acquire(row, { wait: true });
    await w.broker.closeAll();
    expect(await requestCredential(w.sock(row))).toEqual({ ok: false, reason: 'unavailable' });
    expect(w.tokens.wanted('j1', 1)).toBe(true);
  });
});
```

`w.tokens.apply` only accepts a token for a key that is already wanted. The tests that grant before `acquire` therefore call `w.tokens.want` first, just as `acquire` does.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/runner && bun test test/unit/broker.spec.ts`
Expected: FAIL, `Cannot find module '../../src/credentials/broker'`.

- [ ] **Step 3: Implement**

```ts
// apps/runner/src/credentials/broker.ts
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobRow } from '../journal/types';
import type { Sleep } from '../time';
import { CredentialServer, type CredentialReply } from './cred-server';
import { helperValue, writeShims } from './job-files';
import { socketPathFor } from './socket-dir';
import type { TokenCache } from './token-cache';

export interface JobCredentials {
  /** The `credential.helper` value, or null when the clone URL needs no credentials (D83). */
  readonly helper: string | null;
  /** `<jobDir>/bin` with the gh and glab shims, or null (D83). */
  readonly binDir: string | null;
}

export type AcquireResult = { ok: true; credentials: JobCredentials } | { ok: false; reason: string; cancelled?: true };

export interface AcquireOptions {
  /** Wait for the job's first token (prepare, the PLAN push), or not (a readopted run, D90). */
  readonly wait: boolean;
  readonly isCancelled?: () => boolean;
}

/** What `HostExecutor` needs from the broker. */
export interface CredentialProvider {
  acquire(job: JobRow, options: AcquireOptions): Promise<AcquireResult>;
  release(job: JobRow): Promise<void>;
}

export interface BrokerTiming {
  readonly waitMs: number;
  readonly serveWaitMs: number;
  readonly pollMs: number;
}

export interface BrokerDeps {
  readonly tokens: TokenCache;
  readonly socketDir: string;
  readonly runnerId: string;
  readonly selfCommand: readonly string[];
  /** Wall-clock milliseconds: a token's expiry is the server's wall clock. */
  readonly nowMs: () => number;
  readonly sleep: Sleep;
  readonly timing: BrokerTiming;
}

const NONE: JobCredentials = { helper: null, binDir: null };
const keyOf = (job: JobRow): string => `${job.jobId}:${job.leaseEpoch}`;

function credentialTarget(cloneUrl: string): URL | null {
  const url = new URL(cloneUrl);
  return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
}

async function closeQuietly(pending: Promise<CredentialServer>): Promise<void> {
  try {
    await (await pending).close();
  } catch {
    // never listened, or already gone
  }
}

/** Design §3.1: one socket per (job, epoch), answered from the TokenCache, and the job's shims. */
export class CredentialBroker implements CredentialProvider {
  private servers: ReadonlyMap<string, Promise<CredentialServer>> = new Map();
  private closing = false;

  constructor(private readonly deps: BrokerDeps) {}

  async acquire(job: JobRow, options: AcquireOptions): Promise<AcquireResult> {
    const target = credentialTarget(job.assign.repo.cloneUrl);
    if (!target) return { ok: true, credentials: NONE };
    const { tokens, socketDir, runnerId, selfCommand } = this.deps;
    tokens.want(job.jobId, job.leaseEpoch);
    const sock = socketPathFor(socketDir, runnerId, job.jobId, job.leaseEpoch);
    await this.serve(job, sock, target);
    const binDir = join(job.jobDir, 'bin');
    await writeShims(binDir, selfCommand, sock);
    const credentials: JobCredentials = { helper: helperValue(selfCommand, sock), binDir };
    if (!options.wait) return { ok: true, credentials };
    const refused = await this.firstToken(job, options.isCancelled);
    return refused ?? { ok: true, credentials };
  }

  /** D90: this epoch's socket closes, its token is forgotten, its shims go. Other epochs are untouched. */
  async release(job: JobRow): Promise<void> {
    const key = keyOf(job);
    this.deps.tokens.drop(job.jobId, job.leaseEpoch);
    const pending = this.servers.get(key);
    this.servers = new Map([...this.servers].filter(([other]) => other !== key));
    if (pending) await closeQuietly(pending);
    // `<jobDir>/bin` is shared by every epoch of the job (one job dir): keep it while another epoch is served.
    const sibling = [...this.servers.keys()].some((other) => other.startsWith(`${job.jobId}:`));
    if (!sibling) await rm(join(job.jobDir, 'bin'), { recursive: true, force: true });
  }

  /** D90: daemon stop or crash. The sockets go; the tokens stay wanted and the shims stay, for a readopt. */
  async closeAll(): Promise<void> {
    this.closing = true;   // a prepare still waiting for its first token stops at once (daemon stop must not wait 120 s)
    const pending = [...this.servers.values()];
    this.servers = new Map();
    await Promise.all(pending.map(closeQuietly));
  }

  private async serve(job: JobRow, sock: string, target: URL): Promise<void> {
    const key = keyOf(job);
    const existing = this.servers.get(key);
    if (existing) {
      await existing;
      return;
    }
    const pending = CredentialServer.listen(sock, () => this.reply(job, target));
    this.servers = new Map([...this.servers, [key, pending]]);
    try {
      await pending;
    } catch (error) {
      this.servers = new Map([...this.servers].filter(([other]) => other !== key));
      throw error;
    }
  }

  /** D79: the socket's answer; waits up to serveWaitMs for a token that has not arrived yet. */
  private async reply(job: JobRow, target: URL): Promise<CredentialReply> {
    const { tokens, nowMs, sleep, timing } = this.deps;
    const deadline = nowMs() + timing.serveWaitMs;
    for (;;) {
      if (!tokens.wanted(job.jobId, job.leaseEpoch)) return { ok: false, reason: 'job ended' };
      const state = tokens.state(job.jobId, job.leaseEpoch, nowMs());
      if (state.kind === 'token') {
        const { username, token, expiresAt } = state.token;
        return { ok: true, username, token, expiresAt, protocol: target.protocol.slice(0, -1), host: target.host };
      }
      if (state.kind === 'error') return { ok: false, reason: state.reason };
      if (nowMs() >= deadline) return { ok: false, reason: 'no token' };
      await sleep(timing.pollMs);
    }
  }

  /** D82: null once the first token is there; otherwise why prepare must stop. */
  private async firstToken(job: JobRow, isCancelled?: () => boolean): Promise<Extract<AcquireResult, { ok: false }> | null> {
    const { tokens, nowMs, sleep, timing } = this.deps;
    const deadline = nowMs() + timing.waitMs;
    for (;;) {
      const state = tokens.state(job.jobId, job.leaseEpoch, nowMs());
      if (state.kind === 'token') return null;
      if (state.kind === 'error') return { ok: false, reason: `git token: ${state.reason}` };
      if (this.closing || isCancelled?.()) return { ok: false, reason: 'cancelled', cancelled: true };
      if (nowMs() >= deadline) return { ok: false, reason: 'git token: timeout' };
      await sleep(timing.pollMs);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/runner && bun test test/unit/broker.spec.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/credentials/broker.ts apps/runner/test/unit/broker.spec.ts
git commit -m "feat(fleet): runner credential broker, one socket per job epoch (3b-1, D79, D82, D83, D90)"
```

---

### Task 8: Git calls that authenticate, and an authenticated git server for tests

**Files:**
- Modify: `apps/runner/src/executor/git.ts` (`GitOptions`, `createGit`, `NO_CREDENTIALS_REASON`)
- Modify: `apps/runner/src/executor/workspace.ts` (`ensureClone`, `cleanWorkspace`, new `configureRepoHelper`)
- Modify: `apps/runner/src/executor/plan-commit.ts` (`PlanPushInput.credentialHelper`, `pushWithRetry`)
- Modify: `apps/runner/src/executor/git.spec.ts`
- Create: `apps/runner/test/helpers/git-http.ts`
- Test: `apps/runner/test/unit/workspace-auth.spec.ts`

**Interfaces:**
- Consumes: `CredentialServer` (Task 3), `helperValue` (Task 6).
- Produces:
  - `GitOptions.credentialHelper?: string | null` (D86).
  - `NO_CREDENTIALS_REASON = 'git auth failed'` (D89).
  - `ensureClone(git, { repoDir, cloneUrl, identity, credentialHelper?: string | null })`.
  - `cleanWorkspace(git, repoDir, credentialHelper?: string | null)`.
  - `configureRepoHelper(git: Git, repoDir: string, helper: string): Promise<void>` (D85).
  - `PlanPushInput.credentialHelper?: string | null`.
  - Test helper: `interface GitHttpRequest { readonly path: string; readonly withAuth: boolean; readonly authorized: boolean }`, `createGitHttp(root: string, auth: { username: string; password: () => string }): { handle(req: Request): Promise<Response | null>; readonly requests: readonly GitHttpRequest[] }`, `startGitHttp(root, auth): { url: string; requests: readonly GitHttpRequest[]; stop(): void }`.

- [ ] **Step 1: Write the test helper and the failing tests**

```ts
// apps/runner/test/helpers/git-http.ts
/** Smart HTTP over `git http-backend` (CGI) with Basic auth: the only way a test can make git call a credential helper. */
export interface GitHttpRequest {
  readonly path: string;
  readonly withAuth: boolean;
  readonly authorized: boolean;
}

export interface GitHttpAuth {
  readonly username: string;
  readonly password: () => string;
}

const GIT_PATH = /^\/.+\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/;

function splitCgi(out: Uint8Array): { head: string; body: Uint8Array } {
  for (const sep of ['\r\n\r\n', '\n\n']) {
    const bytes = new TextEncoder().encode(sep);
    for (let i = 0; i + bytes.length <= out.length; i += 1) {
      if (bytes.every((b, j) => out[i + j] === b)) return { head: new TextDecoder().decode(out.slice(0, i)), body: out.slice(i + bytes.length) };
    }
  }
  return { head: '', body: out };
}

async function runBackend(root: string, req: Request, url: URL, user: string): Promise<Response> {
  const body = new Uint8Array(await req.arrayBuffer());
  const proc = Bun.spawn(['git', 'http-backend'], {
    stdin: body, stdout: 'pipe', stderr: 'pipe',
    env: {
      PATH: process.env['PATH'], GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers.get('content-type') ?? '',
      CONTENT_LENGTH: String(body.length), HTTP_CONTENT_ENCODING: req.headers.get('content-encoding') ?? '',
      REMOTE_USER: user, REMOTE_ADDR: '127.0.0.1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  const { head, body: rest } = splitCgi(out);
  const headers = new Headers();
  let status = 200;
  for (const line of head.split(/\r?\n/).filter(Boolean)) {
    const colon = line.indexOf(':');
    const [name, value] = [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
    else headers.set(name, value);
  }
  return new Response(rest, { status, headers });
}

/** `handle` answers git paths (401 without the right Basic auth) and returns null for anything else. */
export function createGitHttp(root: string, auth: GitHttpAuth): { handle(req: Request): Promise<Response | null>; readonly requests: readonly GitHttpRequest[] } {
  const requests: GitHttpRequest[] = [];
  return {
    requests,
    async handle(req) {
      const url = new URL(req.url);
      if (!GIT_PATH.test(url.pathname)) return null;
      const header = req.headers.get('authorization');
      const authorized = header === `Basic ${Buffer.from(`${auth.username}:${auth.password()}`).toString('base64')}`;
      requests.push({ path: `${url.pathname}${url.search}`, withAuth: header !== null, authorized });
      if (!authorized) return new Response('authentication required\n', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="git"' } });
      return runBackend(root, req, url, auth.username);
    },
  };
}

export function startGitHttp(root: string, auth: GitHttpAuth): { url: string; requests: readonly GitHttpRequest[]; stop(): void } {
  const git = createGitHttp(root, auth);
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (req) => (await git.handle(req)) ?? new Response('not found', { status: 404 }) });
  return { url: `http://127.0.0.1:${server.port}`, requests: git.requests, stop: () => { server.stop(true); } };
}
```

The `requests` array is the helper's own recorder, returned read-only; test code only reads it.

```ts
// apps/runner/test/unit/workspace-auth.spec.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CredentialServer } from '../../src/credentials/cred-server';
import { helperValue } from '../../src/credentials/job-files';
import { createGit, GitError, NO_CREDENTIALS_REASON, reasonFromError } from '../../src/executor/git';
import { commitAndPushPlan } from '../../src/executor/plan-commit';
import { cleanWorkspace, configureRepoHelper, ensureClone } from '../../src/executor/workspace';
import { git as sh, isolateGit, makeOrigin } from '../helpers/git-fixture';
import { startGitHttp } from '../helpers/git-http';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());
const g = createGit();
const identity = { name: 'koda-fleet[bot]', email: 'bot@koda.test' };
const MAIN = join(import.meta.dir, '..', '..', 'src', 'main.ts');
/** Not `sh()`: it trims, which would drop the leading empty entry. */
const helperList = async (repoDir: string): Promise<string[]> =>
  (await g.ok(['config', '--local', '--get-all', 'credential.helper'], { cwd: repoDir })).split('\n').slice(0, -1);

async function world() {
  const root = await tmp.make('auth');
  await makeOrigin(join(root, 'acme'), 'app', { files: { 'README.md': 'x', '.nax/config.json': '{}' } });
  const http = startGitHttp(root, { username: 'x-access-token', password: () => 'ghs_ws' });
  const cloneUrl = `${http.url}/acme/app.git`;
  const sock = join(root, 'c.sock');
  const server = await CredentialServer.listen(sock, async () => ({
    ok: true, username: 'x-access-token', token: 'ghs_ws', expiresAt: '2099-01-01T00:00:00Z', protocol: 'http', host: new URL(http.url).host,
  }));
  const helper = helperValue([process.execPath, MAIN], sock);
  const repoDir = join(root, 'ws', 'acme', 'app');
  return {
    root, http, cloneUrl, helper, repoDir,
    async close() { await server.close(); http.stop(); },
  };
}

describe('network git through the job helper (D85, D86, D89)', () => {
  test('clone authenticates through the helper and leaves the helper list ["", helper] in the clone', async () => {
    const w = await world();
    try {
      await ensureClone(g, { repoDir: w.repoDir, cloneUrl: w.cloneUrl, identity, credentialHelper: w.helper });
      expect(await helperList(w.repoDir)).toEqual(['', w.helper]);
      expect(w.http.requests.some((r) => r.authorized && r.path.includes('git-upload-pack'))).toBe(true);
    } finally {
      await w.close();
    }
  });
  test('D89: without a helper the clone fails as `git auth failed`', async () => {
    const w = await world();
    try {
      const error = await ensureClone(g, { repoDir: w.repoDir, cloneUrl: w.cloneUrl, identity }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitError);
      expect(reasonFromError(error)).toBe(NO_CREDENTIALS_REASON);
      expect(NO_CREDENTIALS_REASON).toBe('git auth failed');
    } finally {
      await w.close();
    }
  });
  test('fetch authenticates with the helper and fails without it', async () => {
    const w = await world();
    try {
      await ensureClone(g, { repoDir: w.repoDir, cloneUrl: w.cloneUrl, identity, credentialHelper: w.helper });
      await cleanWorkspace(g, w.repoDir, w.helper);
      await expect(cleanWorkspace(g, w.repoDir)).rejects.toBeInstanceOf(GitError);   // the runner's own offline calls clear the helper list
    } finally {
      await w.close();
    }
  });
  test('D85: the clone\'s own config authenticates plain git, and its empty entry silences a global helper that would answer', async () => {
    const w = await world();
    try {
      await ensureClone(g, { repoDir: w.repoDir, cloneUrl: w.cloneUrl, identity, credentialHelper: w.helper });
      const globalConfig = join(w.root, 'global.gitconfig');
      await writeFile(globalConfig, '[credential]\n\thelper = "!f() { echo username=x-access-token; echo password=wrong; }; f"\n');
      const before = w.http.requests.length;
      const proc = Bun.spawn(['git', 'fetch', 'origin'], { cwd: w.repoDir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig } });
      expect(await proc.exited).toBe(0);
      const during = w.http.requests.slice(before);
      expect(during.some((r) => r.authorized)).toBe(true);
      expect(during.some((r) => r.withAuth && !r.authorized)).toBe(false);   // the wrong password was never sent
    } finally {
      await w.close();
    }
  });
  test('configureRepoHelper replaces any earlier helper entries', async () => {
    const w = await world();
    try {
      await ensureClone(g, { repoDir: w.repoDir, cloneUrl: w.cloneUrl, identity, credentialHelper: w.helper });
      await sh(w.repoDir, 'config', '--local', '--add', 'credential.helper', '!echo stale');
      await configureRepoHelper(g, w.repoDir, w.helper);
      expect(await helperList(w.repoDir)).toEqual(['', w.helper]);
    } finally {
      await w.close();
    }
  });
  test('the PLAN push authenticates through the helper; without it the reason is `git auth failed` and it is not retried', async () => {
    const w = await world();
    try {
      await ensureClone(g, { repoDir: w.repoDir, cloneUrl: w.cloneUrl, identity, credentialHelper: w.helper });
      const refSha = await sh(w.repoDir, 'rev-parse', 'HEAD');
      await sh(w.repoDir, 'checkout', '-q', '--detach', refSha);
      const dir = join(w.repoDir, '.nax', 'features', 'f');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'prd.json'), JSON.stringify({ feature: 'f', branchName: 'feat/f', userStories: [{ id: 'US-001' }] }));
      const input = { git: g, repoDir: w.repoDir, jobDir: join(w.root, 'job'), feature: 'f', jobId: 'j1', branchName: 'feat/f', refSha, defaultBranch: 'main', identity, sleep: async () => undefined };
      let pushes = 0;
      const counting = { run: async (args: readonly string[], options: Parameters<typeof g.run>[1]) => { if (args[0] === 'push') pushes += 1; return g.run(args, options); }, ok: g.ok };
      expect(await commitAndPushPlan({ ...input, git: counting })).toEqual({ ok: false, reason: NO_CREDENTIALS_REASON });
      expect(pushes).toBe(1);
      const pushed = await commitAndPushPlan({ ...input, credentialHelper: w.helper });
      expect(pushed).toMatchObject({ ok: true, branch: 'feat/f' });
      expect(await sh(join(w.root, 'acme', 'app.git'), 'rev-parse', 'feat/f')).toBe((pushed as { sha: string }).sha);
    } finally {
      await w.close();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/runner && bun test test/unit/workspace-auth.spec.ts`
Expected: FAIL. `configureRepoHelper` is not exported, `credentialHelper` is not an accepted option, and `NO_CREDENTIALS_REASON` is still the 3a text.

- [ ] **Step 3: Implement**

`apps/runner/src/executor/git.ts`:

```ts
export interface GitOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  /** D86: this call may authenticate, through the job's helper; every other call keeps an empty helper list. */
  readonly credentialHelper?: string | null;
}
// ...
export const NO_CREDENTIALS_REASON = 'git auth failed';
// ...
/** D86: an empty helper clears system, global and repo helpers, so a host credential manager never answers for a job. */
const NO_HELPER_ARGS = ['-c', 'credential.helper='] as const;
const helperArgs = (helper: string | null | undefined): readonly string[] =>
  helper ? ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`] : NO_HELPER_ARGS;
// in createGit's run:
    const proc = Bun.spawn(['git', ...helperArgs(options.credentialHelper), ...args], {
```

`apps/runner/src/executor/workspace.ts`:

```ts
/**
 * D85: the clone's own helper list for nax's git (the finish push): an empty entry resets system and global helpers,
 * then the job's helper. Replaced, never appended, at every prepare; not removed at cleanup.
 */
export async function configureRepoHelper(git: Git, repoDir: string, helper: string): Promise<void> {
  await git.ok(['config', '--local', '--replace-all', 'credential.helper', ''], { cwd: repoDir });
  await git.ok(['config', '--local', '--add', 'credential.helper', helper], { cwd: repoDir });
}

export async function ensureClone(git: Git, input: { repoDir: string; cloneUrl: string; identity: GitIdentity; credentialHelper?: string | null }): Promise<void> {
  assertCloneUrl(input.cloneUrl);
  const credentialHelper = input.credentialHelper ?? null;
  const parent = dirname(input.repoDir);
  await mkdir(parent, { recursive: true });
  if (await exists(join(input.repoDir, '.git'))) {
    const current = (await git.ok(['remote', 'get-url', 'origin'], { cwd: input.repoDir })).trim();
    if (current !== input.cloneUrl) await git.ok(['remote', 'set-url', 'origin', input.cloneUrl], { cwd: input.repoDir });
  } else {
    await rm(input.repoDir, { recursive: true, force: true });
    await git.ok(['clone', '--', input.cloneUrl, input.repoDir], { cwd: parent, credentialHelper });
  }
  await git.ok(['config', 'user.name', input.identity.name], { cwd: input.repoDir });
  await git.ok(['config', 'user.email', input.identity.email], { cwd: input.repoDir });
  if (credentialHelper) await configureRepoHelper(git, input.repoDir, credentialHelper);
}

export async function cleanWorkspace(git: Git, repoDir: string, credentialHelper: string | null = null): Promise<void> {
  await git.ok(['fetch', '--prune', 'origin'], { cwd: repoDir, credentialHelper });
  await git.ok(['reset', '--hard', 'HEAD'], { cwd: repoDir });
  await git.ok(['clean', '-ffd'], { cwd: repoDir });
  await git.ok(['worktree', 'prune'], { cwd: repoDir });
}
```

`apps/runner/src/executor/plan-commit.ts`: add `readonly credentialHelper?: string | null;` to `PlanPushInput`. In `pushWithRetry`, the push call becomes:

```ts
    const push = await input.git.run(['push', '--set-upstream', 'origin', input.branchName], { cwd: input.repoDir, credentialHelper: input.credentialHelper ?? null });
```

`apps/runner/src/executor/git.spec.ts`: add

```ts
  test('D89: an authentication failure is `git auth failed`', () => {
    expect(NO_CREDENTIALS_REASON).toBe('git auth failed');
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/runner && bun test test/unit/workspace-auth.spec.ts src/executor test/unit/plan-commit.spec.ts test/unit/workspace.spec.ts && bun run type-check`
Expected: PASS; type-check clean. The 3a workspace and plan-commit specs still pass: they use `file://` origins, which never call a helper.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/executor/git.ts apps/runner/src/executor/git.spec.ts apps/runner/src/executor/workspace.ts apps/runner/src/executor/plan-commit.ts apps/runner/test/helpers/git-http.ts apps/runner/test/unit/workspace-auth.spec.ts
git commit -m "feat(fleet): runner network git authenticates through the job helper (3b-1, D85, D86, D89)"
```

---
### Task 9: HostExecutor and JobRun use the broker

**Files:**
- Modify: `apps/runner/src/executor/job-executor.ts` (two seam methods)
- Modify: `apps/runner/src/executor/host-executor.ts` (`HostExecutorDeps.credentials`, `prepare`, `spawn`, `finishPlan`, `cleanup`, the two seam methods)
- Modify: `apps/runner/src/supervisor/job-run.ts` (`lifecycle`, `abandonCleanup`)
- Modify: `apps/runner/src/daemon/daemon.ts` (a minimal broker for the executor; Task 10 completes it)
- Modify: `apps/runner/test/helpers/fake-executor.ts`, `apps/runner/test/fixtures/fake-nax.ts` (D94)
- Create: `apps/runner/test/helpers/no-credentials.ts`
- Modify: `apps/runner/test/unit/host-executor.spec.ts` (both `new HostExecutor` calls get `credentials: NO_CREDENTIALS`)
- Test: `apps/runner/test/unit/host-executor-auth.spec.ts`, `apps/runner/src/supervisor/job-run.spec.ts`

**Interfaces:**
- Consumes: `CredentialProvider`, `CredentialBroker` (Task 7); `TokenCache` (Task 1); `startGitHttp` (Task 8); `installFakeGh` (Task 6).
- Produces:
  - `JobExecutor.resumeCredentials(job: JobRow): Promise<void>`.
  - `JobExecutor.releaseCredentials(job: JobRow): Promise<void>`.
  - `HostExecutorDeps.credentials: CredentialProvider`.
  - Test helper `NO_CREDENTIALS: CredentialProvider`.
  - fake-nax env `FAKE_NAX_GH`, `FAKE_NAX_ENV_DUMP` (D94).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/runner/test/helpers/no-credentials.ts
import type { CredentialProvider } from '../../src/credentials/broker';

/** For HostExecutor specs against `file://` origins, which never need credentials (D83). */
export const NO_CREDENTIALS: CredentialProvider = {
  acquire: async () => ({ ok: true, credentials: { helper: null, binDir: null } }),
  release: async () => undefined,
};
```

In `apps/runner/test/unit/host-executor.spec.ts`, import `NO_CREDENTIALS` and add `credentials: NO_CREDENTIALS` to both `new HostExecutor({...})` calls (in `world()` and in the "repo without .nax" test).

```ts
// apps/runner/test/unit/host-executor-auth.spec.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { AssignPayload } from '@nathapp/fleet-protocol';
import { CredentialBroker } from '../../src/credentials/broker';
import { requestCredential } from '../../src/credentials/git-credential';
import { socketPathFor } from '../../src/credentials/socket-dir';
import { TokenCache } from '../../src/credentials/token-cache';
import { createGit } from '../../src/executor/git';
import { HostExecutor } from '../../src/executor/host-executor';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { jobDirFor } from '../../src/paths/safe-segment';
import { installFakeGh } from '../helpers/fake-gh';
import { git as sh, isolateGit, makeOrigin } from '../helpers/git-fixture';
import { startGitHttp } from '../helpers/git-http';
import { makeTempDirs } from '../helpers/tmp';
import { waitFor } from '../helpers/wait';

const tmp = makeTempDirs();
const FAKE = join(import.meta.dir, '..', 'fixtures', 'fake-nax.ts');
const MAIN = join(import.meta.dir, '..', '..', 'src', 'main.ts');
const TOKEN = 'ghs_hostexec';
const PRD = JSON.stringify({ branchName: 'feat/feat', userStories: [{ id: 'US-001' }] });
const savedPath = process.env['PATH'];
beforeAll(() => { isolateGit(); process.env['FAKE_NAX_STEP_MS'] = '10'; });
afterAll(() => {
  for (const key of ['FAKE_NAX_STEP_MS', 'FAKE_NAX_GH', 'FAKE_NAX_ENV_DUMP', 'FAKE_GH_LOG']) delete process.env[key];
  process.env['PATH'] = savedPath;
  return tmp.cleanup();
});

async function world(command: 'RUN' | 'PLAN' = 'RUN') {
  const base = await tmp.make('hxa');
  const origin = await makeOrigin(join(base, 'remotes', 'acme'), 'app', {
    files: { 'README.md': 'x', 'docs/spec.md': '# spec\n', '.nax/config.json': '{}', '.nax/features/feat/prd.json': PRD },
  });
  const http = startGitHttp(join(base, 'remotes'), { username: 'x-access-token', password: () => TOKEN });
  const socketDir = join(base, 's');
  await mkdir(socketDir, { mode: 0o700 });
  const tokens = new TokenCache({ refreshMarginMs: 240_000, cooldownMs: 30_000 });
  const broker = new CredentialBroker({
    tokens, socketDir, runnerId: 'r1', selfCommand: [process.execPath, MAIN], nowMs: () => Date.now(), sleep: (ms) => Bun.sleep(ms),
    timing: { waitMs: 5_000, serveWaitMs: 5_000, pollMs: 5 },
  });
  const workspaceRoot = join(base, 'ws');
  const assign: AssignPayload = {
    jobId: 'cjob1', command, repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: `${http.url}/acme/app.git` },
    ref: 'main', feature: 'feat', planFrom: command === 'PLAN' ? 'docs/spec.md' : null, profiles: [], maxCostUsd: '5', bashMode: 'raw',
    gitIdentity: { name: 'koda-fleet[bot]', email: 'bot@x' },
  };
  const row = Journal.open(':memory:').insertJob({ assign, leaseEpoch: 1, repoKey: 'acme/app', jobDir: jobDirFor(workspaceRoot, assign.jobId) }).row;
  const ex = new HostExecutor({
    config: { workspaceRoot, naxCommand: ['bun', FAKE], naxHome: join(base, 'naxhome') }, git: createGit(), log: createMemoryLogger(),
    nowMs: () => Date.now(), sleep: async () => undefined, credentials: broker,
  });
  const grant = (): void => {
    tokens.want(row.jobId, row.leaseEpoch);
    tokens.apply([{ jobId: row.jobId, leaseEpoch: 1 }], [{ jobId: row.jobId, token: TOKEN, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), username: 'x-access-token' }], [], Date.now());
  };
  return { base, origin, http, tokens, broker, row, ex, grant, repoDir: join(workspaceRoot, 'acme', 'app'), sock: socketPathFor(socketDir, 'r1', row.jobId, 1) };
}

describe('HostExecutor with the credential broker (design §3.1)', () => {
  test('RUN end to end over authenticated HTTP: clone through the helper, nax with shims first and no token, finish push and gh through the broker', async () => {
    const w = await world();
    try {
      w.grant();
      expect(await w.ex.prepare(w.row)).toEqual({ ok: true, branch: 'feat/feat' });
      expect((await stat(w.row.jobDir)).mode & 0o777).toBe(0o700);                              // D93
      const fake = await installFakeGh(w.base);
      const dump = join(w.base, 'nax-env.json');
      process.env['PATH'] = `${fake.binDir}${delimiter}${savedPath ?? ''}`;
      Object.assign(process.env, { FAKE_NAX_GH: '1', FAKE_NAX_ENV_DUMP: dump, FAKE_GH_LOG: fake.logPath });
      const handle = await w.ex.spawn(w.row);
      await waitFor(() => !w.ex.isAlive(handle.pid), { timeoutMs: 30_000 });
      const status = JSON.parse(await readFile(join(w.row.jobDir, 'nax-out', 'status.json'), 'utf8'));
      expect(status.postRun.finish).toMatchObject({ result: 'opened', url: 'https://example.test/koda/pull/7' });
      const env = JSON.parse(await readFile(dump, 'utf8')) as Record<string, string>;
      expect(env['PATH'].split(delimiter)[0]).toBe(join(w.row.jobDir, 'bin'));                  // D88
      expect(JSON.stringify(env)).not.toContain(TOKEN);                                          // no token in nax's environment
      const gh = JSON.parse((await readFile(fake.logPath, 'utf8')).trim().split('\n').at(-1) ?? '{}');
      expect(gh).toMatchObject({ ghToken: TOKEN, argv: expect.arrayContaining(['pr', 'create', '--head', 'feat/feat']) });
      expect(await sh(w.origin.dir, 'rev-parse', 'feat/feat')).toBe(await sh(w.repoDir, 'rev-parse', 'HEAD'));
      expect(w.http.requests.some((r) => r.authorized && r.path.includes('git-receive-pack'))).toBe(true);
      await w.ex.cleanup(w.row);
      expect(await requestCredential(w.sock)).toEqual({ ok: false, reason: 'unavailable' });   // D90
    } finally {
      await w.broker.closeAll();
      w.http.stop();
    }
  });
  test('D82: a token error ends prepare with `git token: <reason>` before anything is cloned', async () => {
    const w = await world();
    try {
      w.tokens.want(w.row.jobId, 1);
      w.tokens.apply([{ jobId: w.row.jobId, leaseEpoch: 1 }], [], [{ jobId: w.row.jobId, reason: 'app_permissions_insufficient' }], Date.now());
      expect(await w.ex.prepare(w.row)).toEqual({ ok: false, reason: 'git token: app_permissions_insufficient' });
      await expect(stat(w.repoDir)).rejects.toThrow();
    } finally {
      await w.broker.closeAll();
      w.http.stop();
    }
  });
  test('PLAN: the plan commit is pushed through the helper', async () => {
    const w = await world('PLAN');
    try {
      w.grant();
      expect((await w.ex.prepare(w.row)).ok).toBe(true);
      const handle = await w.ex.spawn(w.row);
      await waitFor(() => !w.ex.isAlive(handle.pid), { timeoutMs: 30_000 });
      const pushed = await w.ex.finishPlan(w.row);
      expect(pushed).toMatchObject({ ok: true, branch: 'feat/feat' });
      expect(await sh(w.origin.dir, 'log', '-1', '--format=%s', 'feat/feat')).toBe('chore(plan): feat PRD via koda job cjob1');
    } finally {
      await w.broker.closeAll();
      w.http.stop();
    }
  });
});
```

In `apps/runner/src/supervisor/job-run.spec.ts`:

1. In the existing test "abandon of a lower epoch kills its group but leaves the reap and the profile to the live higher epoch (D64)", change
   `expect(b.ex.calls.slice(callsBefore)).toEqual([]);` to
   `expect(b.ex.calls.slice(callsBefore)).toEqual(['releaseCredentials:j1']);   // D90: epoch 1's socket closes; no reap, no cleanup`.
2. Append:

```ts
describe('git credentials across a restart (D90)', () => {
  test('a watch start restores the job\'s credentials before the first watcher tick', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    b.ex.alive = true;
    let restoredFirst = false;
    b.ex.onTick = (n) => {
      if (n === 1) restoredFirst = b.ex.calls.includes('resumeCredentials:j1');
      if (n >= 1) b.ex.alive = false;
    };
    await b.run.start('watch');
    expect(restoredFirst).toBe(true);
  });
  test('a prepare start does not resume (prepare acquires them itself)', async () => {
    const b = build();
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(b.ex.calls).not.toContain('resumeCredentials:j1');
  });
  test('a failing resume is a warning and the run is still watched to its end', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    b.ex.alive = true;
    b.ex.resumeError = new Error('socket dir gone');
    b.ex.dieAfterTicks(1);
    await b.run.start('watch');
    expect(events(b).some((e) => e.type === 'lifecycle' && JSON.stringify(e.payload).includes('git credentials could not be restored'))).toBe(true);
    expect(stateNames(b)).toEqual(['UPLOADING', 'COMPLETED']);
  });
  test('abandon releases this epoch\'s credentials', async () => {
    const b = build();
    b.ex.onTick = () => undefined;
    const running = b.run.start('prepare');
    await waitFor(() => b.ex.calls.includes('spawn:j1') && b.ex.ticks >= 1);
    await b.run.abandon();
    await running;
    expect(b.ex.calls).toContain('releaseCredentials:j1');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/runner && bun test test/unit/host-executor-auth.spec.ts src/supervisor/job-run.spec.ts`
Expected: FAIL. `credentials` is not a `HostExecutorDeps` field, `resumeCredentials`/`resumeError` do not exist on `FakeExecutor`, and the D64 test sees no `releaseCredentials:j1`.

- [ ] **Step 3: Implement**

`apps/runner/src/executor/job-executor.ts`, add to `JobExecutor`:

```ts
  /** D90: after a daemon restart, re-open this job's credential socket (a readopted nax may still push). */
  resumeCredentials(job: JobRow): Promise<void>;
  /** D90: close this epoch's credential socket and forget its token; other epochs of the job are untouched. */
  releaseCredentials(job: JobRow): Promise<void>;
```

`apps/runner/test/helpers/fake-executor.ts`: add the field `resumeError: Error | null = null;` and

```ts
  async resumeCredentials(job: JobRow): Promise<void> {
    this.note('resumeCredentials', job);
    if (this.resumeError) throw this.resumeError;
  }

  async releaseCredentials(job: JobRow): Promise<void> {
    this.note('releaseCredentials', job);
  }
```

`apps/runner/src/executor/host-executor.ts`:

```ts
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { CredentialProvider } from '../credentials/broker';
// ...
export interface HostExecutorDeps {
  readonly config: Pick<RunnerConfig, 'workspaceRoot' | 'naxCommand' | 'naxHome'>;
  readonly git: Git;
  readonly log: Logger;
  readonly nowMs: () => number;
  /** D77: the PLAN push back-off; tests inject a no-op. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Design §3.1: per-job git credentials (the broker; a stub in `file://` specs). */
  readonly credentials: CredentialProvider;
}
```

In `prepare`, replace the lines from `await mkdir(jobDir, { recursive: true });` through `await cleanWorkspace(this.deps.git, repoDir);` with:

```ts
      await mkdir(jobDir, { recursive: true, mode: 0o700 });
      await chmod(jobDir, 0o700);   // D93: it holds the shims
      const acquired = await this.deps.credentials.acquire(job, { wait: true, isCancelled: cancelled });
      if (!acquired.ok) return acquired.cancelled ? CANCELLED : { ok: false, reason: acquired.reason };
      const { helper } = acquired.credentials;
      await ensureClone(this.deps.git, { repoDir, cloneUrl: assign.repo.cloneUrl, identity: assign.gitIdentity, credentialHelper: helper });
      if (cancelled()) return CANCELLED;
      await cleanWorkspace(this.deps.git, repoDir, helper);
```

`spawn` becomes:

```ts
  async spawn(job: JobRow): Promise<SpawnHandle> {
    const { repoDir, jobDir } = this.dirs(job);
    const argv = buildNaxArgv(this.deps.config.naxCommand, job.assign);
    const acquired = await this.deps.credentials.acquire(job, { wait: false });
    const binDir = acquired.ok ? acquired.credentials.binDir : null;
    const inherited = process.env['PATH'] ?? '';
    // D88: the shims come first on nax's PATH; no token variable is ever set here.
    const path = binDir ? `${binDir}${delimiter}${inherited}` : inherited;
    return spawnNax(argv, {
      cwd: repoDir, stdoutPath: join(jobDir, 'nax.stdout'), stderrPath: join(jobDir, 'nax.stderr'),
      env: { ...process.env, NAX_GLOBAL_CONFIG_DIR: this.deps.config.naxHome, PATH: path },
    });
  }
```

In `finishPlan`, after the `check` guard and before `refSha`:

```ts
    const acquired = await this.deps.credentials.acquire(job, { wait: true });
    if (!acquired.ok) return { ok: false, reason: acquired.reason };
```

and pass `credentialHelper: acquired.credentials.helper,` to `commitAndPushPlan({...})`.

`cleanup` and the seam methods:

```ts
  async cleanup(job: JobRow): Promise<void> {
    try {
      await deleteJobProfile(this.deps.config.naxHome, job.jobId);
    } finally {
      await this.deps.credentials.release(job);
    }
  }

  async resumeCredentials(job: JobRow): Promise<void> {
    await this.deps.credentials.acquire(job, { wait: false });
  }

  async releaseCredentials(job: JobRow): Promise<void> {
    await this.deps.credentials.release(job);
  }
```

`apps/runner/src/supervisor/job-run.ts`:

```ts
  private async lifecycle(from: RunStart): Promise<void> {
    if ((from === 'prepare' || from === 'reprepare') && !(await this.prepareAndSpawn(from === 'reprepare'))) return;
    if (from === 'watch') await this.resumeCredentials();
    if (from !== 'finish') await this.watchUntilExit(from === 'watch');
    if (this.halted) return;
    await this.finish();
  }

  /** D90: a readopted nax may still push; its socket died with the previous daemon. A failure is reported, not fatal. */
  private async resumeCredentials(): Promise<void> {
    const row = this.row();
    if (!row) return;
    try {
      await this.deps.executor.resumeCredentials(row);
    } catch (error) {
      this.events.lifecycle('warn', `git credentials could not be restored: ${errorMessage(error)}`);
    }
  }
```

In `abandonCleanup`, directly after `await killIfOurs(...)`:

```ts
      // D90: the socket is per epoch, so it closes even when a live higher epoch keeps the reap and the profile.
      await this.deps.executor.releaseCredentials(row).catch((error: unknown) => {
        this.deps.log.warn('credential release failed', { jobId: this.jobId, error: errorMessage(error) });
      });
```

`apps/runner/src/daemon/daemon.ts`: the executor now needs a `CredentialProvider`. Add, after the `TokenCache` from Task 2 (imports: `CredentialBroker` from `../credentials/broker`, `defaultSocketDir` from `../credentials/socket-dir`, `selfCommand` from `../self-command`):

```ts
  const broker = new CredentialBroker({
    tokens, socketDir: defaultSocketDir(process.getuid?.() ?? 0), runnerId: identity.runnerId, selfCommand: selfCommand(),
    nowMs: () => Date.now(), sleep,
    timing: { waitMs: tuning.tokenWaitMs, serveWaitMs: tuning.tokenServeWaitMs, pollMs: tuning.tokenPollMs },
  });
```

and pass `credentials: broker` to `new HostExecutor({...})`. Task 10 adds the configurable, checked directory, the `selfCommand` option and `closeAll`.

`apps/runner/test/fixtures/fake-nax.ts` (D94). Directly after `const outDir = profile.outputDir;` add:

```ts
const envDump = process.env['FAKE_NAX_ENV_DUMP'];
if (envDump) writeFileSync(envDump, JSON.stringify(process.env));
```

Add, beside the `git` helper:

```ts
/** D94: `FAKE_NAX_GH=1` opens the PR through `gh` on PATH (the job's shim), as nax's finish phase does. */
const openPr = (branch: string): string => {
  if (process.env['FAKE_NAX_GH'] !== '1') return 'https://example.test/koda/pull/1';
  return execFileSync('gh', ['pr', 'create', '--head', branch, '--title', `${feature}: fake`, '--body', 'fake'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
};
```

Replace the whole `if (scenario === 'escalated' || scenario === 'completed') { ... }` block in `run()` with:

```ts
  if (scenario === 'escalated' || scenario === 'completed') {
    let branch = '';
    try {
      branch = git('symbolic-ref', '--short', '-q', 'HEAD');
    } catch {
      branch = '';
    }
    let pushed = false;
    if (branch && scenario === 'completed') {
      try {
        git('push', '-q', '--set-upstream', 'origin', branch);
        pushed = true;
      } catch {
        pushed = false;   // D94: nax escalates a finish push that fails (no credentials, network)
      }
    }
    const opened = scenario === 'completed' && pushed;
    const escalationReason = scenario === 'completed' ? 'push failed' : 'fake escalation';
    if (branch) {
      const ledgerDir = join(outDir, 'finish-audit', feature);
      mkdirSync(ledgerDir, { recursive: true });
      const prUrl = opened ? openPr(branch) : undefined;
      writeFileSync(join(ledgerDir, 'last.json'), JSON.stringify({
        branch, headSha: git('rev-parse', 'HEAD'), status: opened ? 'opened' : 'escalated', ...(prUrl ? { prUrl } : {}), runId, finishedAt: new Date().toISOString(),
      }));
      finish = opened ? { status: 'passed', result: 'opened', url: prUrl } : { status: 'passed', result: 'escalated', escalationReason };
    } else {
      finish = scenario === 'completed' ? { status: 'skipped', reason: 'branch' } : { status: 'passed', result: 'escalated', escalationReason: 'fake escalation' };
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/runner && bun test test/unit/host-executor-auth.spec.ts test/unit/host-executor.spec.ts src/supervisor && bun run type-check && bun run lint`
Expected: PASS; type-check and lint clean.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/executor apps/runner/src/supervisor apps/runner/src/daemon/daemon.ts apps/runner/test/helpers apps/runner/test/fixtures/fake-nax.ts apps/runner/test/unit/host-executor.spec.ts apps/runner/test/unit/host-executor-auth.spec.ts
git commit -m "feat(fleet): runner jobs acquire, resume and release git credentials (3b-1, D88, D90, D93, D94)"
```

---

### Task 10: Daemon wiring, `socketDir` config

**Files:**
- Modify: `apps/runner/src/config/runner-config.ts` (`RunnerConfig.socketDir`, `parseRunnerConfig`)
- Modify: `apps/runner/src/daemon/daemon.ts` (`DaemonOptions.selfCommand`, the checked socket dir, `closeAll`)
- Modify: `apps/runner/test/unit/daemon.spec.ts` (its `setup` config gets a private `socketDir`)
- Test: `apps/runner/src/config/runner-config.spec.ts`, `apps/runner/test/unit/daemon-socket-dir.spec.ts`

**Interfaces:**
- Consumes: `ensureSocketDir`, `defaultSocketDir`, `SocketDirError` (Task 3); `CredentialBroker` (Task 7); `selfCommand` (Task 6); `TokenCache` wiring (Task 2).
- Produces: `RunnerConfig.socketDir: string | null`; `DaemonOptions.selfCommand?: readonly string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/runner/src/config/runner-config.spec.ts`, using the file's `parse(over)` helper (line 17: a full valid config spread with `over`):

```ts
describe('socketDir (D78)', () => {
  test('absent is null (the daemon uses /tmp/koda-runner-<uid>)', () => {
    expect(parse().socketDir).toBeNull();
  });
  test('an absolute path is kept', () => {
    expect(parse({ socketDir: '/run/koda' }).socketDir).toBe('/run/koda');
  });
  test.each(['run/koda', 42, ''])('%p is refused', (socketDir) => {
    expect(() => parse({ socketDir })).toThrow('socketDir must be an absolute path');
  });
});
```

```ts
// apps/runner/test/unit/daemon-socket-dir.spec.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parseRunnerConfig, resolveHome } from '../../src/config/runner-config';
import { SocketDirError } from '../../src/credentials/socket-dir';
import { startDaemon } from '../../src/daemon/daemon';
import type { RunnerIdentityFile } from '../../src/identity/identity-store';
import { createMemoryLogger } from '../../src/logger';
import type { FetchFn } from '../../src/sync/http';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const identity: RunnerIdentityFile = { runnerId: 'r1', apiKey: 'kr_test', serverUrl: 'http://127.0.0.1:9', name: 'n', enrolledAt: '2026-10-01T00:00:00.000Z' };
const capabilities = { nax: { version: '0.0.0-fake', protocols: ['native'] }, sandbox: { available: true }, profiles: {}, credentials: [], tools: { git: true, gh: true, glab: false }, executors: ['host'] };

describe('the daemon refuses an unsafe socket directory (D78)', () => {
  test.each(['symlink', 'world-readable'])('Review focus 5: a %s socketDir stops the start before the server is called', async (kind) => {
    const base = await tmp.make('dsd');
    const real = join(base, 'real');
    await mkdir(real, { mode: 0o700 });
    let socketDir = real;
    if (kind === 'symlink') {
      socketDir = join(base, 'link');
      await symlink(real, socketDir);
    } else {
      await chmod(real, 0o755);
    }
    const config = parseRunnerConfig({ serverUrl: 'http://127.0.0.1:9', workspaceRoot: join(base, 'ws'), socketDir, capabilities }, {});
    let calls = 0;
    const fetchFn: FetchFn = async () => { calls += 1; throw new TypeError('not reached'); };
    await expect(startDaemon({ home: resolveHome({}, join(base, 'home')), config, identity, fetchFn, log: createMemoryLogger() })).rejects.toThrow(SocketDirError);
    expect(calls).toBe(0);
  });
});
```

In `apps/runner/test/unit/daemon.spec.ts` `setup()`, add `socketDir: join(base, 's'),` to the `parseRunnerConfig({...})` object, so the daemon specs never touch the shared `/tmp/koda-runner-<uid>`. Keep the name short (D78: the socket path must stay under 100 bytes inside a macOS temp dir).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/runner && bun test src/config/runner-config.spec.ts test/unit/daemon-socket-dir.spec.ts`
Expected: FAIL. `socketDir` is not parsed, and `startDaemon` does not check the directory.

- [ ] **Step 3: Implement**

`apps/runner/src/config/runner-config.ts`, in `RunnerConfig`:

```ts
  /** D78: where the per-job credential sockets live; null means `/tmp/koda-runner-<uid>`. */
  readonly socketDir: string | null;
```

In `parseRunnerConfig`, before the `return`:

```ts
  const socketDir = raw.socketDir ?? null;
  if (socketDir !== null && (typeof socketDir !== 'string' || !isAbsolute(socketDir))) throw new ConfigError('socketDir must be an absolute path');
```

and add `socketDir: socketDir as string | null,` to the returned object.

`apps/runner/src/daemon/daemon.ts`:

```ts
import { defaultSocketDir, ensureSocketDir } from '../credentials/socket-dir';   // ensureSocketDir is new here
// DaemonOptions gains:
  /** D84: how git and the shims run this runner; tests pass ['bun', <src/main.ts>]. */
  readonly selfCommand?: readonly string[];
```

In `startDaemon`, directly after the `chmod(home.dir, 0o700)` line (before `Journal.open`):

```ts
  const uid = process.getuid?.() ?? 0;
  const socketDir = config.socketDir ?? defaultSocketDir(uid);
  await ensureSocketDir(socketDir, uid);   // D78: refuse to start before anything could listen in an unsafe place
```

In the `new CredentialBroker({...})` from Task 9, change `socketDir: defaultSocketDir(process.getuid?.() ?? 0)` to `socketDir` and `selfCommand: selfCommand()` to `selfCommand: options.selfCommand ?? selfCommand()`.

In `stop()`, directly after `supervisor.shutdown();` (before the wait for `supervisor.idle()`):

```ts
      await broker.closeAll();   // D90: sockets close; a prepare waiting for its first token ends now instead of in 120 s
```

A run halted during prepare then returns without a transition (`prepareAndSpawn` checks `halted` right after `prepare`).

In `crash()`, after `supervisor.shutdown();`:

```ts
    void broker.closeAll();   // D90: a killed daemon's listeners die with it; the files stay (the next daemon replaces them)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/runner && bun run type-check && bun run lint && bun run test`
Expected: type-check and lint clean; every unit spec passes (662 at the base plus this plan's new tests).

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/config apps/runner/src/daemon apps/runner/test/unit/daemon-socket-dir.spec.ts apps/runner/test/unit/daemon.spec.ts
git commit -m "feat(fleet): runner daemon serves git credentials from a checked socket dir (3b-1, D78, D84, D90)"
```

---

### Task 11: Integration against the real API through an authenticated git front

**Files:**
- Create: `apps/runner/test/integration/harness/git-front.ts`
- Modify: `apps/runner/test/integration/harness/forge.ts` (export `HARNESS_TOKEN`)
- Modify: `apps/runner/test/integration/harness/world.ts` (front, fake gh, `selfCommand`; no `insteadOf`)
- Modify: `apps/runner/test/integration/harness.integration.spec.ts` (the forge test)
- Modify: `apps/runner/test/integration/recovery.integration.spec.ts` (the finished-while-down test, D94)
- Test: `apps/runner/test/integration/credentials.integration.spec.ts`

**Interfaces:**
- Consumes: `createGitHttp`, `GitHttpRequest` (Task 8); `installFakeGh` (Task 6); everything above through the daemon.
- Produces: `startGitFront(forgeUrl: string, reposRoot: string, token: () => string): { url: string; requests: readonly GitHttpRequest[]; stop(): void }`; `World` gains `forge: FakeForge`, `gitRequests: readonly GitHttpRequest[]`, `fakeGh: { binDir: string; logPath: string }`; `HARNESS_TOKEN = 'ghs_harness'`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/runner/test/integration/credentials.integration.spec.ts
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { defaultSocketDir, socketPathFor } from '../../src/credentials/socket-dir';
import { git as sh } from '../helpers/git-fixture';
import { waitFor } from '../helpers/wait';
import { createWorld, type TestRunner, type World } from './harness';
import { HARNESS_TOKEN } from './harness/forge';

setDefaultTimeout(120_000);
const enabled = process.env['KODA_DB_TESTS'] === '1';

describe.skipIf(!enabled)('runner 3b-1 against the real API: git credentials', () => {
  let world: World;
  let runner: TestRunner;
  beforeAll(async () => {
    world = await createWorld();
    runner = await world.addRunner('creds');
    await runner.start();
  }, 180_000);
  afterAll(async () => { await world?.close(); });

  const receivePacks = () => world.gitRequests.filter((r) => r.authorized && r.path.includes('git-receive-pack')).length;

  test('RUN: clone, fetch, the finish push and gh pr create go through the broker; the token is never in nax\'s env, the journal or the logs', async () => {
    const dump = join(world.base, 'nax-env-fa.json');
    const id = await world.withFake({ FAKE_NAX_GH: '1', FAKE_NAX_ENV_DUMP: dump }, async () => {
      const jobId = await world.dispatch({ feature: 'fa' });
      await world.waitForJob(jobId, (j) => j.state === 'COMPLETED', 60_000);
      return jobId;
    });
    const job = await world.job(id);
    expect(job).toMatchObject({ resultPrUrl: 'https://example.test/koda/pull/7', resultBranch: 'feat/fa', finishResult: 'opened' });
    expect(job.resultSha).toBe(await sh(world.origin.dir, 'rev-parse', 'feat/fa'));
    expect(world.gitRequests.some((r) => r.authorized && r.path.includes('git-upload-pack'))).toBe(true);
    expect(receivePacks()).toBeGreaterThan(0);

    const env = JSON.parse(await readFile(dump, 'utf8')) as Record<string, string>;
    expect(JSON.stringify(env)).not.toContain(HARNESS_TOKEN);
    expect(env['PATH'].split(delimiter)[0]).toBe(join(runner.jobDir(id), 'bin'));
    const gh = (await readFile(world.fakeGh.logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((e) => e.argv[0] === 'pr');
    expect(gh.at(-1)).toMatchObject({ ghToken: HARNESS_TOKEN, argv: expect.arrayContaining(['pr', 'create', '--head', 'feat/fa']) });

    expect((await runner.journalBytes()).includes(Buffer.from(HARNESS_TOKEN))).toBe(false);
    expect(JSON.stringify(runner.log.lines)).not.toContain(HARNESS_TOKEN);
  });

  test('PLAN: the plan commit reaches origin through the helper', async () => {
    const id = await world.dispatch({ feature: 'fb', command: 'PLAN', planFrom: 'docs/spec.md' });
    const job = await world.waitForJob(id, (j) => j.state === 'COMPLETED', 60_000);
    expect(job.resultBranch).toBe('feat/fb');
    expect(await sh(world.origin.dir, 'log', '-1', '--format=%s', 'feat/fb')).toBe(`chore(plan): fb PRD via koda job ${id}`);
  });

  test('D82: a token the forge refuses fails the job before any clone, with the server\'s reason', async () => {
    const route = 'POST /app/installations/77/access_tokens';
    const saved = world.forge.routes.get(route);
    world.forge.routes.set(route, () => ({ status: 403, body: { message: 'Resource not accessible by integration' } }));
    try {
      const id = await world.dispatch({ feature: 'fc' });
      const job = await world.waitForJob(id, (j) => j.state === 'FAILED', 60_000);
      expect(job.stateReason).toBe('git token: app_permissions_insufficient');
    } finally {
      if (saved) world.forge.routes.set(route, saved);
    }
  });

  test('Review focus 3: after a daemon crash the readopted run still pushes: the new daemon serves the job socket again', async () => {
    const gate = join(world.base, 'gate-fd');
    const id = await world.withFake({ FAKE_NAX_GATE: gate }, async () => {
      const jobId = await world.dispatch({ feature: 'fd' });
      await world.waitForJob(jobId, (j) => j.state === 'RUNNING' && j.naxRunId !== null && j.currentStoryId === null && Number(j.costSpentUsd) > 0);
      return jobId;
    });
    runner.crash();
    await runner.start();
    await waitFor(async () => (await world.prisma.fleetCommand.findMany({ where: { jobId: id, type: 'READOPT' } })).some((c) => c.ackResult === 'ok'), { timeoutMs: 30_000, message: 'READOPT was not acked ok' });
    const { runnerId } = await runner.identity();
    const sock = socketPathFor(defaultSocketDir(process.getuid?.() ?? 0), runnerId, id, 1);
    await waitFor(() => existsSync(sock), { timeoutMs: 30_000, message: 'the restarted daemon did not re-open the job socket' });
    const before = receivePacks();
    await writeFile(gate, '');
    const job = await world.waitForJob(id, (j) => j.state === 'COMPLETED' || j.state === 'ESCALATED', 60_000);
    expect(job.state).toBe('COMPLETED');                                   // ESCALATED here means the push had no credentials
    expect(job.resultBranch).toBe('feat/fd');
    expect(receivePacks()).toBeGreaterThan(before);
  });
});
```

`harness.integration.spec.ts`: replace the test "the fake forge origin serves the seeded repository through the insteadOf mapping" with:

```ts
  test('D91: the git front serves the seeded repository only with the minted token', async () => {
    const ls = async (helper: string) => {
      const proc = Bun.spawn(['git', '-c', 'credential.helper=', ...(helper ? ['-c', `credential.helper=${helper}`] : []), 'ls-remote', world.forgeCloneUrl], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
      return { out: await new Response(proc.stdout).text(), code: await proc.exited };
    };
    expect((await ls('')).code).not.toBe(0);
    const good = await ls('!f() { echo username=x-access-token; echo password=ghs_harness; }; f');
    expect(good.code).toBe(0);
    expect(good.out).toContain('refs/heads/main');
  });
```

`recovery.integration.spec.ts`, the test "a run that finishes while the daemon is down ...": rename it to `'a run that finishes while the daemon is down is verdicted, bundled and reported after READOPT; its push had no credentials, so it escalates (D94, S1 spec §7.3)'` and replace

```ts
    const job = await world.waitForJob(id, (j) => j.state === 'COMPLETED', 60_000);
    expect(job).toMatchObject({ resultBranch: 'feat/fe', resultPrUrl: 'https://example.test/koda/pull/1' });
```

with

```ts
    const job = await world.waitForJob(id, (j) => j.state === 'ESCALATED', 60_000);
    expect(job).toMatchObject({ resultBranch: 'feat/fe', finishResult: 'escalated', resultPrUrl: null });
```

- [ ] **Step 2: Run them to verify they fail**

Run (once: `cd apps/api && bun run test:db:up`, then from the repo root `bunx turbo run build --filter=@nathapp/koda-api`): `cd apps/runner && KODA_DB_TESTS=1 bun test test/integration/credentials.integration.spec.ts test/integration/harness.integration.spec.ts test/integration/recovery.integration.spec.ts`
Expected: FAIL. The credentials spec does not type-check against the unchanged `World` (`forge`, `gitRequests` and `fakeGh` are missing) and `HARNESS_TOKEN` is not exported. The harness test still sees the `file://` mapping answer without a token. The recovery test still ends COMPLETED, because under the 3a `insteadOf` mapping the push needs no credentials.

- [ ] **Step 3: Build the harness**

```ts
// apps/runner/test/integration/harness/git-front.ts
import { createGitHttp, type GitHttpRequest } from '../../helpers/git-http';

export interface GitFront {
  readonly url: string;
  readonly requests: readonly GitHttpRequest[];
  stop(): void;
}

/**
 * D91: the fake forge as the runner sees it. Git paths go to `git http-backend` and need the minted token as Basic
 * auth; every other path is proxied to the fake forge (the API's GitHub calls).
 */
export function startGitFront(forgeUrl: string, reposRoot: string, token: () => string): GitFront {
  const git = createGitHttp(reposRoot, { username: 'x-access-token', password: token });
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const answered = await git.handle(req);
      if (answered) return answered;
      const url = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
      return fetch(`${forgeUrl}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests: git.requests, stop: () => { server.stop(true); } };
}
```

`harness/forge.ts`: add `export const HARNESS_TOKEN = 'ghs_harness';` and use it in the `access_tokens` route body (`token: HARNESS_TOKEN`).

`harness/world.ts`:

- Imports: `import { delimiter, join } from 'node:path';`, `import { startGitFront } from './git-front';`, `import { HARNESS_TOKEN, startForge, type Forge } from './forge';`, `import type { FakeForge } from '../../../../api/test/helpers/fake-forge';`, `import type { GitHttpRequest } from '../../helpers/git-http';`, `import { installFakeGh } from '../../helpers/fake-gh';`.
- `const SELF = [process.execPath, join(import.meta.dir, '..', '..', '..', 'src', 'main.ts')];` beside `FAKE_NAX`.
- `World` gains `readonly forge: FakeForge; readonly gitRequests: readonly GitHttpRequest[]; readonly fakeGh: { binDir: string; logPath: string };`.
- In `buildWorld`, right after the forge starts:

```ts
  const remotes = join(base, 'remotes');
  const front = startGitFront(forge.url, remotes, () => HARNESS_TOKEN);
  cleanups.push(async () => front.stop());
```

- API env: `GITHUB_API_URL: front.url, VCS_GITLAB_API_URL: `${front.url}/api/v4``.
- Delete the `const remotes = join(base, 'remotes');` further down, delete the three `GIT_CONFIG_*` assignments and their comment, and reduce the cleanup's key list to `['FAKE_NAX_STEP_MS']`.
- `const forgeCloneUrl = `${front.url}/acme/app.git`;`
- After `process.env['FAKE_NAX_STEP_MS'] = '40';`:

```ts
  const fakeGh = await installFakeGh(join(base, 'gh'));
  const savedPath = process.env['PATH'];
  process.env['PATH'] = `${fakeGh.binDir}${delimiter}${savedPath ?? ''}`;   // behind each job's shims (D88)
  process.env['FAKE_GH_LOG'] = fakeGh.logPath;
  cleanups.push(async () => { process.env['PATH'] = savedPath; delete process.env['FAKE_GH_LOG']; });
```

- The `world` object gains `forge, gitRequests: front.requests, fakeGh,`.
- `runner.start()`: `startDaemon({ home, config, identity, log, fetchFn, selfCommand: SELF, tuning: { statusPollMs: 50, syncMinGapMs: 20, ackPollMs: 25 } })`.

- [ ] **Step 4: Run the whole integration suite**

Run: `cd apps/runner && KODA_DB_TESTS=1 bun run test:integration`
Expected: PASS, every file. `harness`, `run-plan` and `recovery` now authenticate through the helper with no change to their bodies, except the two edits above. A failure in `run-plan` or `recovery` here points at the broker, not at those tests.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/test/integration
git commit -m "test(fleet): runner integration authenticates through the git broker and shims (3b-1, D91, D94)"
```

---

### Task 12: Context, design pointer, PR text

**Files:**
- Modify: `.nax/mono/apps/runner/context.md`
- Modify: `docs/superpowers/specs/2026-09-30-fleet-s1-slice-3-runner-design.md` (a pointer under §3.1)
- Modify: generated agent files (`nax generate`, `nax generate --all-packages`)

- [ ] **Step 1: Update the runner context**

In `.nax/mono/apps/runner/context.md`:

- "It should not:" list, replace the third bullet with:
  `- hold git credentials of its own: a per-job token comes over sync, lives only in daemon memory, and reaches git and gh/glab through the job's socket (3b-1); an authentication failure fails the job with `git auth failed`, and git never prompts`
- Architecture block: after the `src/executor/` line add
  `src/credentials/     TokenCache, CredentialBroker (one unix socket per job epoch in socketDir), git-cred helper, gh/glab shim`
  and change the `src/main.ts` line to
  `src/main.ts          koda-runner run | enroll | status (git-cred and shim are internal: git and the job shims call them)`
- Rules, replace the git bullet with:
  `- git runs with `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_ASKPASS=true`; a call that may authenticate passes the job helper (`credentialHelper`), every other call keeps an empty helper list; the clone's own helper list is `''` then the job helper. The daemon refuses git older than 2.30.`
- Rules, add:
  `- A git token never goes to a logger, the journal, a file, a bundle or nax's environment; only the shim puts it into its one gh/glab child. The socket directory (default `/tmp/koda-runner-<uid>`) must be ours and mode 0700, or the daemon does not start.`
- Testing, add:
  `- Authenticated git in specs uses `test/helpers/git-http.ts` (`git http-backend` behind Basic auth); `file://` origins never call a credential helper. `startDaemon` in tests needs `selfCommand: [process.execPath, <src/main.ts>]`.`

- [ ] **Step 2: Bring the design up to date (D78, D89, D91)**

In `docs/superpowers/specs/2026-09-30-fleet-s1-slice-3-runner-design.md`:

1. Under the `### 3.1 Git credential broker` heading, add:

```markdown
> **Amended by plan 3b-1 (D78, D79, D82):** the socket is `<socketDir>/<16 hex>.sock` (default
> `/tmp/koda-runner-<uid>`, mode 0700, checked at start), not `<jobDir>/git-cred.sock`, because a unix socket path
> is limited to 104 bytes on macOS. The wire words and the token-error rule are in the plan's decision register.
```

2. In the §1 `config/` block (the `runner.json:` key list), after `jobRetentionDays (default 7),` insert `socketDir (default /tmp/koda-runner-<uid>, 3b),`.

3. After the paragraph that begins `**3a depends on nothing from 3b, and says so where it matters:**` (it ends with the `GIT_CONFIG_VALUE_n` mapping), add:

```markdown
> **Superseded in 3b-1 (D89, D91):** an authentication failure is now `git auth failed`, and the integration
> harness no longer maps clone URLs to `file://`: an authenticated git-HTTP front (`git http-backend`) serves the
> repositories, so every scenario authenticates through the credential helper.
```

4. In §4, the integration bullet that says the harness "runs the daemon in process with `insteadOf` mapping to `file://` bare remotes": replace that phrase with `runs the daemon in process against an authenticated git-HTTP front of the bare remotes (3b-1 D91; 3a used an insteadOf mapping to file://)`.

- [ ] **Step 3: Regenerate the agent files**

Run: `nax generate && nax generate --all-packages` (from the repo root; local and free)
Expected: `apps/runner/AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `codex.md` change to match the context; the root files do not change.

- [ ] **Step 4: Full verification**

Run: `cd apps/runner && bun run type-check && bun run lint && bun run test && KODA_DB_TESTS=1 bun run test:integration`
Expected: all clean and passing.

- [ ] **Step 5: Commit**

```bash
git add .nax/mono/apps/runner/context.md docs/superpowers/specs/2026-09-30-fleet-s1-slice-3-runner-design.md apps/runner/AGENTS.md apps/runner/CLAUDE.md apps/runner/GEMINI.md apps/runner/codex.md
git commit -m "docs(fleet): runner context and design updates for the git broker (3b-1)"
```

- [ ] **Step 6: PR text (a human opens the PR)**

Title: `feat(fleet): S1 slice 3b-1 — runner git credential broker`

Body:

```markdown
## Summary

Slice 3b-1 (design §3.1): the runner holds no git credentials of its own.

- Per-job tokens are requested over sync (`tokenRequests`), refreshed within 240 s of expiry, kept only in memory (`TokenCache`).
- One unix socket per job epoch (`CredentialBroker`) in a checked `socketDir` (default `/tmp/koda-runner-<uid>`, 0700).
- `koda-runner git-cred` is the git credential helper: the runner's own clone, fetch and PLAN push, and nax's finish push through the clone's helper list (`''` then ours).
- `<jobDir>/bin/gh` and `glab` shims put the token into that one child's environment; nax's PATH starts with them and its environment never holds a token.
- Token errors before the first token fail the job with `git token: <reason>`; an auth failure is `git auth failed`.

Decisions D78-D94 are in the plan's register. D78 moves the socket out of `<jobDir>`, because of the macOS 104-byte socket path limit; the design carries a pointer.

## Test plan

- [x] Unit: token cache timing and cool-down, socket server and directory checks, helper protocol (host match, newline injection), shim env and PATH, broker lifecycle (stale socket, two epochs, closeAll), executor and job-run seams.
- [x] Real git over authenticated HTTP (`git http-backend`): clone, fetch, the clone's own helper list silencing a global helper, PLAN push.
- [x] Integration against the real API through an authenticated git front: RUN with `gh pr create` through the shim, PLAN push, a refused token, readopt after a daemon crash; no token in nax's env, the journal or the logs.
- [ ] 3b-2 carries the capability probe, install-service, the merge gate and the live check.
```

---

## Self-review

**Spec coverage (design §3.1, §4 3b lines; S1 spec §7.2):**

| Requirement | Task |
|:--|:--|
| `tokenRequest` on ASSIGN, again within 240 s of `expiresAt`, repeating until `expiresAt` changes | Tasks 1, 2 (D81 adds the cool-down) |
| `gitTokenErrors` fail a job with no usable token, `git token: <reason>` | Tasks 1, 7, 9, 11 (D82) |
| Socket per job, mode 0600, `{username, token, expiresAt}` reply, refuses once the epoch changes or the job ends | Tasks 3, 7, 9 (D78 moves it, D79 adds `protocol`/`host`, D90) |
| Helper is the binary, `koda-runner git-cred <sock>`, `x-access-token`/`oauth2`, set as `credential.helper` on the clone at job start | Tasks 4, 6, 8, 9 (D84, D85) |
| The runner's own clone, fetch and PLAN push use it | Tasks 8, 9 (D86) |
| Shims `<jobDir>/bin/gh`, `glab`: fetch the token, `GH_TOKEN`/`GITLAB_TOKEN` for that child only, real binary from PATH without `<jobDir>/bin` | Tasks 5, 6 (D87) |
| nax runs with `PATH=<jobDir>/bin:$PATH` and no token in its environment | Task 9 (D88), Task 11 |
| Cleanup deletes the socket (design §2 step 10) | Tasks 7, 9 |
| §4 unit: TokenCache timing, credential protocol, shim PATH search | Tasks 1, 4, 5, 6 |
| §4 integration 3b: clone, push and `gh pr create` through helper and shims with a fake gh; no token in nax's env, the journal or logs | Task 11 |
| S1 spec §7.3: a finish push without koda escalates | Task 11 (D94) |

**Not in 3b-1 (plan 3b-2):** `NaxCapabilityProbe` and the capability report from nax JSON (§3.2), the post-checkout `capability mismatch` check, `install-service`/`uninstall-service` with the AppArmor check (§3.3), the 3b merge gate (the probe against released `nax config --json` and `nax auth list --json`, nax 0.83.0 or newer on each runner machine) and the live check.

**Type consistency:**
- `CredentialReply` (Task 3) is used unchanged by Tasks 4, 5, 7.
- `CredentialProvider.acquire(job, { wait, isCancelled? })` returns `AcquireResult`. That is the shape used by `HostExecutor` (Task 9) and `NO_CREDENTIALS`.
- `TokenCache.state(jobId, leaseEpoch, nowMs)` is called with wall-clock `Date.now()` everywhere (daemon, broker).
- `helperValue(self, sock)` is used for both the per-call helper and the clone config.
- `JobExecutor.resumeCredentials` / `releaseCredentials` are implemented by `HostExecutor` and `FakeExecutor`.
