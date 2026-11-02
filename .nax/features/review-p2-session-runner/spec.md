# SPEC: Whole-repo review P2 (decision context cap, runner sync and liveness hardening, web session fixes)

## Summary

This feature fixes eight P2 findings of the 2026-11-01 whole-repo review (`docs/20261101-review-whole-repo.md`, Priority
Fix Order rows "C/PERF-1", "D/BUG-3, D/BUG-4, D/OPS-1" and "D web session bundle"). The detailed fixes for the carried
items are in the 2026-10-18 review (`docs/20261018-review-whole-repo.md`, Review D BUG-1, BUG-2, OPS-1 and Review E
SEC-1, BUG-2, BUG-3, SEC-2). The user chose one bundle on 2026-11-02.

1. **C/PERF-1 (api).** `findActiveDecisions` has no limit and no order, and K2 review events mint active DECISION rows
   on their own, so every `GET /api/context/:slug` returns all of them. The query now leaves out review-minted rows
   (`sourceType: 'review_event'`, which reach reviews through `findReviewDecisionRows`), orders by `updatedAt` desc, and
   takes at most 100.
2. **D/BUG-3 (runner).** A persistent 400 makes the sync loop retry with no sleep and replace a valid event per cycle.
   Before it blames an event, the loop now sends one probe with `jobs: []`; if the probe also fails, the event is kept
   and the loop backs off. Every path that ends a bad-batch cycle now backs off.
3. **D/BUG-4 (runner).** Watch liveness is `kill(pid, 0)`, and EPERM counts as alive, so a recycled pid keeps a
   readopted job RUNNING and its repo mutex held. EPERM now means "not ours", and a readopted pid is dropped on any watch tick where `ps` shows another
   process holding it.
4. **D/OPS-1 (runner).** The launchd plist restarts unconditionally and `runner.log` grows without bound. `KeepAlive`
   becomes `{ SuccessfulExit: false }`, a server stop exits 0 under launchd, and the daemon rotates `runner.log` by size.
5. **E/SEC-1 (web).** Logout skips server-side revocation when the access cookie has expired, and ignores a failed
   upstream logout. It now refreshes with the refresh cookie first and reports a failed revocation.
6. **E/BUG-2 (web).** `SameSite=Strict` on the access cookie plus no return-to sends every emailed deep link to the
   home page. The access cookie becomes `lax`, and `/login` carries a validated same-origin `redirect`.
7. **E/BUG-3 (web).** A brief API outage stops every live stream for the life of the page and clears the client user.
   Refresh now tells "unauthorized" from "unavailable", and streams keep retrying through an outage.
8. **E/SEC-2 (web).** The invite token is interpolated raw into API paths. It now goes through `apiPath` (or
   `encodeURIComponent` in the Nitro route), and the `apiPath` guard spec covers the `invites`, `approvals`, `me`,
   `memory`, `notifications`, `home` and `api/threads` roots.

## Motivation

- **C/PERF-1:** after months of auto-review, every `/context` call returns thousands of "Not a defect: ..." rows. That
  costs DB time and payload, and agents spend context on review noise unrelated to their ticket.
- **D/BUG-3:** a 400 that no event causes (an API parser regression, a proxy rejecting the body, a bad
  `tokenRequests` entry, which halving never shrinks) turns the runner into a zero-delay loop against the API, and each
  cycle replaces the head event, which may be a `state` transition that is then lost.
- **D/BUG-4:** after a daemon restart, readopted nax processes are not the daemon's children. If one exits and its pid is
  reused within a 2 s tick, the job stays RUNNING forever and every later job on that repo queues behind its mutex.
- **D/OPS-1:** with a revoked key, launchd restarts the runner every 10 s forever, each time calling the API with the
  revoked key (systemd stops on exit 2). `runner.log` is appended forever and slowly fills the disk.
- **E/SEC-1:** API logout bumps `tokenVersion` to revoke every outstanding token. After 15 idle minutes the access cookie
  is gone, so the proxy never calls upstream and a leaked refresh JWT stays valid for 7 days.
- **E/BUG-2:** notification emails link to `WEB_PUBLIC_URL` pages. A link opened from a mail client is a cross-site
  navigation, so Strict cookies are not sent, SSR bounces to `/login`, and after hydration the user lands on `/`.
- **E/BUG-3:** during an API deploy or restart, `refresh()` fails, sets the user to null and the stream stops for good;
  the layout hides user-only UI until the next navigation.
- **E/SEC-2:** `/invite/..%2Fprojects%2Fdemo%2Flabels%3F` decodes to a path that the browser normalizes to
  `POST /api/projects/demo/labels?/accept`, a same-origin POST with the victim's session to a path the attacker chose.

## Design

### Integration

Symbols the feature only reads (verified at `42554b6c`):

- `REVIEW_EVENT_SOURCE = 'review_event'` in `apps/api/src/memory/review-decisions.ts`.
- `PrismaMemoryItemRepository.findReviewDecisionRows` in `apps/api/src/memory/prisma-memory-item.repository.ts` already
  excludes review rows with `OR: [{ sourceType: null }, { sourceType: { not: REVIEW_EVENT_SOURCE } }]` and orders by
  `[{ updatedAt: 'desc' }, { id: 'desc' }]`; US-001 mirrors that shape. Prisma's `not` drops null rows, which is why
  the `OR` is needed.
- `ContextBuilderService` (`apps/api/src/context/context-builder.service.ts`) returns
  `canonicalState.activeDecisions` from `CanonicalStateService.getSnapshot`; `GET /api/context/:slug` is the route.
- `backoffDelay(attempt, random, maxMs = 60_000)` in `apps/runner/src/sync/backoff.ts`: full jitter,
  `floor(random() * min(maxMs, 1000 * 2^attempt))`.
- `buildSyncRequest`, `halveScale`, `FULL_SCALE` in `apps/runner/src/sync/batch.ts`.
- `JobExecutor.matchesProcess(job): Promise<boolean>` in `apps/runner/src/executor/job-executor.ts`;
  `HostExecutor.matchesProcess` checks the process's argv (from `ProcessInfo.command`, which answers null when `ps`
  prints nothing or fails) for `jobProfileName(job.jobId)`, which every PLAN, RUN, REVIEW and FIX argv carries. The
  readopt path in `supervisor.ts` keeps using it unchanged.
- `JobRun.chainFixStep(row, spawnedHere)` returns false when `spawnedHere` is false, so a readopted FIX never chains
  its fix step and watches one pid only.
- `FakeExecutor` (`apps/runner/test/helpers/fake-executor.ts`) models `alive`, `procMatches` (default true) and
  `matchesProcess` as `alive && procMatches`; US-003 adds `processIdentity` to it.
- `Tuning` and `TUNING` in `apps/runner/src/daemon/tuning.ts`; `startDaemon({ tuning })` merges a partial override.
- `RunnerHome.dir` in `apps/runner/src/config/runner-config.ts`; the plist writes `${runnerHome}/runner.log`.
- `forwardToApi`, `setAuthCookies`, `clearAuthCookies`, `unwrapAuth`, `ACCESS_COOKIE`, `REFRESH_COOKIE` in
  `apps/web/server/utils/api.ts`.
- `apiPath` tagged template in `apps/web/lib/api-path.ts`.
- `backoffMs(attempt) = min(1000 * 2^attempt, 30_000)` and `MAX_TERMINAL_FAILURES = 5` in
  `apps/web/lib/project-event-stream.ts`; `apps/web/lib/thread-event-stream.ts` has the same `recover` shape.

Symbols the feature changes. The baseline exists only to locate the code; it is never the interface to implement.

- `PrismaCanonicalStateRepository.findActiveDecisions(projectId)` (`apps/api/src/memory/prisma-canonical-state.repository.ts`)
  - Baseline: `findMany({ where: { projectId, kind: 'DECISION', status: 'active', deletedAt: null }, select })`.
  - Target: same signature; `where` adds `OR: [{ sourceType: null }, { sourceType: { not: REVIEW_EVENT_SOURCE } }]`,
    plus `orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }]` and `take: ACTIVE_DECISIONS_LIMIT`. New export
    `ACTIVE_DECISIONS_LIMIT = 100` from the same file.
- `SyncLoop.badBatch` (`apps/runner/src/sync/sync-loop.ts`)
  - Baseline: synchronous; at the smallest scale with no acks it replaces `jobs[0].events[0]` and returns `again`.
  - Target: asynchronous (`classify` awaits it). At the event-blame point (a 400 or a 413 at the smallest scale) it
    sends one probe request `{ ...request, jobs: [] }` through `deps.client.sync` with the same `AbortSignal`. Probe
    outcomes are listed under Approach. The returned outcome after a replacement is `retry`, never `again`.
- `isProcessAlive(pid)` (`apps/runner/src/executor/nax-process.ts`)
  - Baseline: `process.kill(pid, 0)`; EPERM returns true.
  - Target: `isProcessAlive(pid: number, kill: (pid: number, signal: 0) => void = process.kill): boolean`; any thrown
    error, EPERM included, returns false. The injectable `kill` exists for tests (real `process.kill` cannot be
    stubbed safely under Bun).
- `JobRun.watchUntilExit(spawnedHere)` (`apps/runner/src/supervisor/job-run.ts`)
  - Baseline: leaves the loop when `row.pid === null || !executor.isAlive(row.pid)`.
  - Target: when `spawnedHere` is false (a `watch` start), on every tick where `isAlive(row.pid)` is true the loop
    also awaits `executor.processIdentity(row)`. `'other'` is handled exactly like a dead process (leave the loop;
    a readopted FIX never chains). `'ours'` and `'unknown'` keep watching (fail closed: a failed `ps` never ends a
    live job's watch). A `JobRun` that spawned its process (`prepare` or `reprepare`) never calls
    `processIdentity`.
- `JobExecutor` gains `processIdentity(job): Promise<'ours' | 'other' | 'unknown'>`. `HostExecutor.processIdentity`:
  `job.pid` null or `ProcessInfo.command(pid)` null gives `'unknown'`; a command that `matchesProcess`' rule
  accepts gives `'ours'`; any other command gives `'other'`.
- `launchdPlist(spec)` (`apps/runner/src/service/units.ts`)
  - Baseline: `<key>KeepAlive</key>\n  <true/>`; `EnvironmentVariables` holds `HOME` and `PATH`.
  - Target: `<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>`; `EnvironmentVariables`
    adds `<key>KODA_RUNNER_SUPERVISOR</key>\n    <string>launchd</string>`. `systemdUnit` is unchanged.
- `runCommand(homeOverride, deps)` (`apps/runner/src/commands/run.ts`)
  - Baseline: a server stop (426 or 401) returns 2.
  - Target: returns 0 instead of 2 when `deps.env.KODA_RUNNER_SUPERVISOR === 'launchd'`, still logging
    `stopped by the server (...)` at error level. Every other exit code is unchanged.
- `Tuning` gains `runnerLogMaxBytes` (default `RUNNER_LOG_MAX_BYTES = 10 * 1024 * 1024`) and `runnerLogCheckMs`
  (default `300_000`; `pruneIntervalMs` is 24 h, too slow for a chatty log). `startDaemon` awaits
  `rotateLogFile(join(home.dir, 'runner.log'), tuning.runnerLogMaxBytes)` once before it resolves, and calls it
  again every `runnerLogCheckMs` (cleared on stop like the other intervals). Both the start-up call and every periodic
  call are wrapped in try/catch and log a warning on error; a rotation error never fails `startDaemon`.
  `rotateLogFile` rotates only when the file size is strictly greater than `maxBytes`.
- `forwardToApi(event, path, init)` (`apps/web/server/utils/api.ts`)
  - Baseline: `init: { method?, body?, cookieName? }`; the Bearer comes from the selected cookie.
  - Target: `init` adds `bearer?: string`; when set, the `Authorization` header is `Bearer <bearer>` and no cookie is
    read.
- `setAuthCookies` (`apps/web/server/utils/api.ts`): `koda_token` gets `sameSite: 'lax'`; `koda_refresh` keeps
  `sameSite: 'strict'`. Every other cookie option is unchanged.
- `apps/web/server/api/auth/logout.post.ts`: see Approach.
- `apps/web/middleware/auth.global.ts` and `apps/web/pages/login.vue`: see Approach.
- `useAuth()` (`apps/web/composables/useAuth.ts`)
  - Baseline: `refresh(): Promise<boolean>`, which sets `user` to null on any failure; `acceptInvite` builds
    `` `/api/invites/${token}/accept` ``.
  - Target: adds `refreshSession(): Promise<RefreshOutcome>` with exported type
    `RefreshOutcome = 'ok' | 'unauthorized' | 'unavailable'`. `refresh()` returns `(await refreshSession()) === 'ok'`.
    `user` is set to null only on `'unauthorized'`. `acceptInvite` builds the path with `apiPath`.
- `ProjectEventStreamDeps.refreshAuth` and the thread stream's `refreshAuth`: `() => Promise<RefreshOutcome>`
  (was `Promise<boolean>`). `useThread`, `useWorkspaceThread`, `useUserEvents` and `useProjectEvents` pass
  `refreshSession`; `useUserEvents` and `useProjectEvents` keep their `latestRefresh` variable name, whose default becomes `async () => 'unauthorized'`.

New module (US-006): `apps/web/lib/safe-redirect.ts` exports `safeRedirectPath(value: unknown): string`.
New module (US-004): `apps/runner/src/service/log-rotate.ts` exports `RUNNER_LOG_MAX_BYTES` and
`rotateLogFile(path: string, maxBytes: number): Promise<boolean>`.

### Approach

**US-002 bad-batch order.** `badBatch` applies its steps in this order, unchanged except for step 4 and later:

1. Capabilities rejected (400 with capabilities in the request): remember the hash, return `again` (once per hash).
2. `halveScale` gives a smaller scale: take it, return `again`.
3. 400 at the smallest scale with command acks: exclude acks once, return `again`.
4. No job or no event in the request: return `retry` (backoff).
5. Otherwise send the probe `{ ...request, jobs: [] }`:
   - probe throws `ServerError` 401 or 426: return `stop` exactly as `classify` would;
   - probe throws after `controller.signal` was aborted (`stop()` or `wake()`): return `woken`, as `classify` does; the
     event is kept;
   - probe throws anything else (another status, a network error): return `retry` from the probe's error; the event
     is kept;
   - probe answers: apply its response through `apply(probe, response, report)` (token answers, commands and acks as
     for any sync; `apply` resets `failures` to 0 and, when acks were excluded, resends them without detail, as on
     any success), replace `jobs[0].events[0]` with the lifecycle error event, log it at error level with
     `{ jobId, seq, type }`, set the scale to `FULL_SCALE`, and return `this.retry(error)` (the original 400 or 413),
     which sleeps `backoffDelay(0, random)` and sets `failures` to 1.

`syncOnce` returns `await this.classify(...)` inside its `try`, so `inflight` stays set (and `stop()` can abort the
probe) until the probe settles. Steps 1-3 are bounded (once per capabilities hash, at most eight halvings from `FULL_SCALE`, once per ack set), so every cycle ends in
`retry` within a bounded number of `again` steps, and each `retry` sleeps.

**US-003 composition.** EPERM-as-dead applies everywhere `isAlive` is used (watch loop and readopt). Per tick of a
`watch` start the loop checks, in order: `isAlive` false leaves; otherwise `processIdentity` `'other'` leaves;
otherwise it keeps watching. This adds one `ps` per 2 s tick for a readopted job only.

**US-005 logout flow.** `POST /api/auth/logout`:

| access cookie | refresh cookie | upstream calls | answer |
|:--|:--|:--|:--|
| present | any | `POST /auth/logout` with the access cookie | 204 when upstream status < 400, else 502 |
| absent | present | `POST /auth/refresh` (refresh cookie); on 2xx with an `accessToken`, `POST /auth/logout` with `bearer: <that token>` | 204 when logout status < 400; 204 when refresh answers 401 or 403 (nothing left to revoke); 502 otherwise, including a 2xx refresh with no `accessToken` |
| absent | absent | none | 204 |

Both auth cookies are cleared on every row, and the tokens from the refresh step are never set as cookies. A 502 body
is `{ revoked: false }`. The refresh call, the `unwrapAuth` of its body (which throws when `ret !== 0`) and the logout
call all run inside one `try`, so any throw there answers 502, never 401. A thrown upstream call counts as a failure (502). `useAuth().logout()` already catches a
failed call and still clears local state and goes to `/login`; it is unchanged.

**US-006 redirect rule.** `safeRedirectPath(value)` returns `value` when it is a string that starts with `/`, whose
second character is neither `/` nor `\`, that has no ASCII control character, and whose path (before `?` or `#`) is
not `/login` or `/register`. Anything else returns `/`. The middleware sends an unauthenticated visitor of a protected
route to `{ path: '/login', query: { redirect: to.fullPath } }`, or to `{ path: '/login' }` when `to.fullPath` is `/`.
An authenticated visitor of `/login` or `/register` goes to `safeRedirectPath(to.query.redirect)`. `login.vue` goes to
`safeRedirectPath(route.query.redirect)` after a successful login.

**US-007 refresh outcome.** `refreshSession()` calls `POST /api/auth/refresh`. Resolved: `'ok'`. Rejected with a status
of 401 or 403 (read from the error's `statusCode`, then `status`, then `response.status`): `'unauthorized'`, and
`user` is set to null. Any other rejection: `'unavailable'`, and `user` is kept.

**US-007 stream recovery.** Each stream keeps `failures` (drives the delay) and `authedFailures`. `recover()`:

1. If `authedFailures >= MAX_TERMINAL_FAILURES`: stop.
2. `delay = backoffMs(failures)`; `failures += 1`.
3. `outcome = await refreshAuth()`; if the stream was closed meanwhile, return.
4. `'unauthorized'`: stop (no reopen).
5. `'ok'`: `authedFailures += 1`, schedule a reopen after `delay`.
6. `'unavailable'`: schedule a reopen after `delay`; `authedFailures` is not changed, so an outage never stops the
   stream; the delay is capped at 30 s by `backoffMs`.
7. Any other value is handled as `'unauthorized'` (fail closed).

`onopen` resets both counters to 0. With only `'ok'` outcomes this keeps today's behaviour: the sixth consecutive
error stops the stream without a sixth refresh.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| US-001: a project with more than 100 active non-review decisions | the 100 most recently updated are returned |
| US-002: probe answers a 400 | event kept, `retry` with backoff |
| US-002: probe network error | event kept, `retry` with backoff |
| US-002: probe answers 401 or 426 | `stop` (auth or protocol) |
| US-003: `processIdentity` answers `'other'` for a readopted pid that is alive | treated as exited |
| US-003: `ps` fails or prints nothing for a readopted pid that is alive (`'unknown'`) | keeps watching |
| US-004: `runner.log` missing | rotation does nothing, returns false |
| US-004: rotation throws (permissions, disk) | the daemon logs a warning and keeps running |
| US-005: upstream logout answers >= 400 or throws | cookies cleared, 502 `{ revoked: false }` |
| US-005: refresh answers 401 or 403 | cookies cleared, 204 |
| US-005: refresh answers another error, throws, or answers 2xx with no `accessToken` | cookies cleared, 502 `{ revoked: false }` |
| US-006: `redirect` is absent, not a string, external, protocol-relative or a guest route | `/` |
| US-007: refresh rejects with 401 or 403 | `'unauthorized'`, user cleared, streams stop |
| US-007: refresh rejects any other way | `'unavailable'`, user kept, streams keep retrying |

## Out of Scope

- Deploying the new launchd plist on koda-wk is a manual step: the live runner uses a hand-edited plist with the `run-service.sh` wrapper, and `install-service` needs sudo. The user re-installs or hand-applies `KeepAlive` and `KODA_RUNNER_SUPERVISOR` after merge.
- The other P2 rows of the 2026-11-01 review (C carried BUG-1..5, the deploy bundle, A/BUG-2 and A/ENH-1) and the D LOW items (`pruneJobs` throwing outside its try, cancel-path identity check, journal permissions) are not part of this bundle.
- E/BUG-1 is not reopened; the P0 bundle (#381) added the SSR session refresh in `server/middleware/session-refresh.ts`.
- US-001 only: `findActiveDecisions` keeps ignoring `ttlAt`; expiring decisions in `/context` is a separate change.
- US-001 only: no per-call budget or separate cap for review-minted decisions in `/context`; they are left out entirely, because `findReviewDecisionRows` already hands them to the reviews that need them.
- US-002 only: a dropped `state` event is not parked or retried later; it is replaced and logged at error level, as before, but only after the probe shows the event is the cause.
- US-002 only: the sync loop does not count consecutive bad-batch cycles separately from `failures`; the existing backoff counter bounds the rate.
- US-002 only: a successful probe is a success for `apply`: it resets `failures` and resends held acks without detail, even though the probe did not prove the acks were the cause.
- `.nax/rules/web.md` says guest-only routes redirect authenticated users to `/`; after US-006 they go to a validated `redirect` or `/`. The rule file is read-only to the run; the user updates it after merge.
- US-003 only: a pid this daemon spawned is not identity-checked; Bun reaps its own children, and the readopt path is the reported failure.
- US-003 only: a readopted FIX still never chains its fix step (no surviving token cache); that is unchanged.
- US-003 only: no status.json heartbeat staleness check is added to the watch loop.
- US-004 only: rotation keeps one old file (`runner.log.1`) and uses copy-then-truncate, so lines written between the copy and the truncate can be lost.
- US-004 only: a newsyslog.d entry is not installed; launchd holds the log file open, so rename-based rotation would keep writing to the renamed file.
- US-004 only: exit 1 (bad config, not enrolled) still restarts under launchd every 10 s, as systemd's `Restart=always` does.
- US-005 only: no API route that accepts the refresh token for logout is added; the web refreshes first and logs out with the new access token.
- US-005 only: the client shows no message for a failed revocation; the 502 is visible to the logout call only.
- US-006 only: the refresh cookie keeps `sameSite: 'strict'` and `path: '/'`; path-scoping it (E/SEC-10) is not part of this bundle.
- US-006 only: CSRF behaviour of the `lax` access cookie is not re-tested; `lax` still withholds the cookie on cross-site POST and fetch requests.
- US-006 only: `register.vue` keeps navigating to `/` after registration.
- US-007 only: the live proxy keeps answering 502 on an upstream failure; a 503 with a retry hint is not added, because `EventSource` cannot read the status either way.
- US-007 only: no single-flight for concurrent refreshes (E/PERF-1).
- US-008 only: the invite page does not validate the token's alphabet; encoding keeps any token one path segment.
- US-008 only: the Nitro accept route answers 400 without calling the API when the router param is missing or empty; the invite page always has a non-empty route token, so `apiPath` never sees an empty value there.

## Stories

This bundle has 8 stories, one package each: 1 api, 3 runner, 4 web. It is a bundle of independent P2 fixes, not one
capability; the user chose one bundle on 2026-11-02, as for #381, #384 and #385. Every story has at most 15 AC bullets;
the resolved story-size gate is `maxAcCount` 15, `maxBulletPoints` 15, `action: warn`.

### US-001: Active decisions in context are capped and leave out review-minted rows

No dependencies. Workdir: apps/api. C/PERF-1: `ACTIVE_DECISIONS_LIMIT` and the new `findActiveDecisions` query.

### US-002: The sync loop probes before it blames an event and always backs off

No dependencies. Workdir: apps/runner. D/BUG-3: the asynchronous `badBatch` with the `jobs: []` probe.

### US-003: Watch liveness treats EPERM as dead and checks a readopted pid's identity

No dependencies. Workdir: apps/runner. D/BUG-4: `isProcessAlive` with an injectable `kill`, `JobExecutor.processIdentity`, and
the readopted-pid identity check in `JobRun.watchUntilExit`.

### US-004: launchd restarts only on failure and the daemon rotates runner.log

No dependencies. Workdir: apps/runner. D/OPS-1: the plist `KeepAlive` dict and `KODA_RUNNER_SUPERVISOR`, the exit-0
server stop under launchd, `rotateLogFile` and the `runnerLogMaxBytes` and `runnerLogCheckMs` tuning.

### US-005: Logout revokes the session even when the access cookie has expired

No dependencies. Workdir: apps/web. E/SEC-1: `forwardToApi`'s `bearer` option and the logout flow table.

### US-006: Deep links survive login

No dependencies. Workdir: apps/web. E/BUG-2: `safeRedirectPath`, the `redirect` query in the auth middleware and
`login.vue`, and the `lax` access cookie.

### US-007: An API outage does not log the user out or stop live streams

No dependencies. Workdir: apps/web. E/BUG-3: `refreshSession` and `RefreshOutcome`, and the recovery rule in both event
streams.

### US-008: The invite token stays one path segment

No dependencies. Workdir: apps/web. E/SEC-2: `apiPath` in the invite page and `acceptInvite`, `encodeURIComponent` in
the Nitro accept route, `apiPath` in `useApprovalRequests`, and the wider guard roots.

### Context Files

**US-001**

- `apps/api/src/memory/prisma-canonical-state.repository.ts`
- `apps/api/src/memory/review-decisions.ts`
- `apps/api/src/memory/prisma-memory-item.repository.ts`
- `apps/api/src/context/context-builder.service.ts`

**US-002**

- `apps/runner/src/sync/sync-loop.ts`
- `apps/runner/src/sync/batch.ts`
- `apps/runner/src/sync/backoff.ts`
- `apps/runner/src/sync/sync-loop.spec.ts`

**US-003**

- `apps/runner/src/executor/nax-process.ts`
- `apps/runner/src/supervisor/job-run.ts`
- `apps/runner/src/executor/host-executor.ts`
- `apps/runner/test/helpers/fake-executor.ts`
- `apps/runner/src/supervisor/job-run.spec.ts`

**US-004**

- `apps/runner/src/service/units.ts`
- `apps/runner/src/commands/run.ts`
- `apps/runner/src/daemon/daemon.ts`
- `apps/runner/src/daemon/tuning.ts`
- `apps/runner/test/unit/daemon.spec.ts`

**US-005**

- `apps/web/server/api/auth/logout.post.ts`
- `apps/web/server/utils/api.ts`
- `apps/web/server/api/auth/refresh.post.ts`
- `apps/web/tests/server/forward-to-api.spec.ts`

**US-006**

- `apps/web/middleware/auth.global.ts`
- `apps/web/pages/login.vue`
- `apps/web/server/utils/api.ts`
- `apps/web/tests/middleware/auth.spec.ts`

**US-007**

- `apps/web/composables/useAuth.ts`
- `apps/web/lib/project-event-stream.ts`
- `apps/web/lib/thread-event-stream.ts`
- `apps/web/composables/useThread.ts`
- `apps/web/composables/useUserEvents.ts`

**US-008**

- `apps/web/pages/invite/[token].vue`
- `apps/web/composables/useAuth.ts`
- `apps/web/server/api/invites/[token]/accept.post.ts`
- `apps/web/composables/useApprovalRequests.ts`
- `apps/web/tests/lib/api-path-guard.spec.ts`

### Creates

**US-004**

- `apps/runner/src/service/log-rotate.ts`
- `apps/runner/src/service/log-rotate.spec.ts`

**US-005**

- `apps/web/tests/server/logout-route.spec.ts`

**US-006**

- `apps/web/lib/safe-redirect.ts`
- `apps/web/tests/lib/safe-redirect.spec.ts`
- `apps/web/tests/pages/login-redirect.spec.ts`

### Modifies

**US-001**

- `apps/api/src/memory/prisma-canonical-state.repository.spec.ts` — the "returns mapped CanonicalDecision objects" test asserts `findMany` was called with exactly `{ where: { projectId, kind, status, deletedAt }, select }`; US-001 adds the `sourceType` `OR`, `orderBy` and `take: 100`, so the expected argument gains those three fields.

**US-002**

- `apps/runner/src/sync/sync-loop.spec.ts` — the D24 tests ("a 400 at {1,1} that persists without acks still blames the event" and the replaced-event delivery test) script one server response per `syncOnce`; the blame step now makes a second `client.sync` call (the `jobs: []` probe) and ends in `retry` instead of `again`, so their scripted step queues must answer the probe as well, and any expectation of `again` after a replacement becomes `retry`.

**US-003**

- `apps/runner/test/helpers/fake-executor.ts` — the fake implements `JobExecutor`, which gains `processIdentity`; it adds `processIdentity`, which does not record into `calls`, answering in this order: `'unknown'` when a new `identityUnknown` flag is set; `'other'` when `alive` is false or `procMatches` is false; `'ours'` otherwise; existing tests keep their meaning.

**US-004**

- `apps/runner/src/service/units.spec.ts` — the "UserName, AbandonProcessGroup, KeepAlive, the program arguments and the log file" test expects KeepAlive to be the plain true value; it now expects the dict whose SuccessfulExit key is false.
- `apps/runner/src/daemon/tuning.spec.ts` — the "carries the design constants" test compares `TUNING` with `toEqual` over the exact key set; the expected object gains `runnerLogMaxBytes: 10485760` and `runnerLogCheckMs: 300000`.

**US-006**

- `apps/web/tests/middleware/auth.spec.ts` — the AC3 test expects navigateTo with the bare login path string for an unauthenticated visit to the home route; with the redirect rule that visit sends the object form with path set to the login route and no query, so the expected argument becomes that object; the "no redirect when on /login" case asserts `navigateTo` was not called at all; every other test in this file that expects navigateTo with the bare login path for an unauthenticated visit to a protected route (the second AC3 test and the AC5 test use the projects route) now expects the object form whose query redirect is that route's full path, the navigateTo mock and the result assertions are updated to the object form, and any authenticated guest-route case expects navigation to the home route only when no valid redirect query is present.

**US-007**

- `apps/web/tests/useAuth.spec.ts` — the AC-8 test rejects the refresh with a plain `Error` and expects `user` cleared; a plain error is now `'unavailable'` and keeps the user, so that test rejects with a 401 status error, and the invariant is that only 401 or 403 clears the user.
- `apps/web/tests/lib/project-event-stream.spec.ts` — `refreshAuth` mocks resolve booleans; they resolve `'ok'` for true and `'unauthorized'` for false, keeping each test's meaning.
- `apps/web/tests/lib/thread-event-stream.spec.ts` — `refreshAuth` mocks resolve booleans; they resolve `'ok'` for true and `'unauthorized'` for false, keeping each test's meaning.
- `apps/web/tests/composables/useThread.spec.ts` — the `useAuth` mock provides only `refresh`; it gains `refreshSession` resolving `'ok'`, because the thread stream now calls `refreshSession`.
- `apps/web/tests/composables/useThread-lifecycle.spec.ts` — the `useAuth` mocks provide only `refresh`; they gain `refreshSession` resolving `'ok'`.
- `apps/web/tests/composables/useWorkspaceThread.spec.ts` — the `useAuth` mock provides only `refresh`; it gains `refreshSession` resolving `'ok'`.
- `apps/web/tests/composables/useProjectEvents.spec.ts` — the source assertion expects the line destructuring `refresh` from `useAuth()`; it now expects the line destructuring `refreshSession`, and the `latestRefresh` assignment from `refreshSession`; the `refreshAuth` delegation line through `latestRefresh` is unchanged.
- `apps/web/tests/composables/useUserEvents.spec.ts` — the source assertion expects the line destructuring `refresh` from `useAuth()`; it now expects the line destructuring `refreshSession`.
- `apps/web/tests/pages/workspace-thread-detail-page.spec.ts` — its `useAuth` mock provides only `refresh`; it gains `refreshSession` resolving `'ok'`.
- `apps/web/tests/lib/project-event-hub.spec.ts` — `refreshAuth` mocks resolve true; they resolve `'ok'`, because any other value is now handled as `'unauthorized'`.
- `apps/web/tests/lib/project-event-stream-fleet.spec.ts` — `refreshAuth` mocks resolve true; they resolve `'ok'`, because any other value is now handled as `'unauthorized'`.
- `apps/web/tests/lib/project-event-stream-notification.spec.ts` — `refreshAuth` mocks resolve true; they resolve `'ok'`, because any other value is now handled as `'unauthorized'`.
- `apps/web/tests/lib/project-event-stream-approval-request.spec.ts` — `refreshAuth` mocks resolve true; they resolve `'ok'`, because any other value is now handled as `'unauthorized'`.

**US-008**

- `apps/web/tests/lib/api-path-guard.spec.ts` — `API_ROOT` lists only `projects|agents|comments|admin|code-intel|fleet`; it adds `invites`, `approvals`, `me`, `memory`, `notifications` and `home`, plus `threads` only after the api prefix (the threads root without that prefix is also a page route), and the pattern self-test gains a case for each new root; `offenders` must stay empty.
- `apps/web/tests/server/invite-accept-route.spec.ts` — AC13 expects the forwarded invite accept path for token tok123, which encoding leaves unchanged; a token containing a slash is now forwarded encoded.

### Seams

- US-004: `startDaemon` calls `rotateLogFile` (created in the same story) at start; the daemon AC triggers `startDaemon`.
- US-005: `logout.post.ts` calls `forwardToApi` with the new `bearer` option (same story); the route ACs assert the
  captured `forwardToApi` calls.
- US-006: the auth middleware and `login.vue` call `safeRedirectPath` (same story); the middleware ACs trigger the
  middleware with a route.
- US-007: the four composables pass `refreshSession` to the streams (same story); the `useThread` AC triggers a stream
  error through the composable.

## Acceptance Criteria

### US-001: Active decisions in context are capped and leave out review-minted rows

- `[unit]` `ACTIVE_DECISIONS_LIMIT` is importable from `memory/prisma-canonical-state.repository` and equals `100`.
- `[unit]` `PrismaCanonicalStateRepository.findActiveDecisions('project-1')` calls `memoryItem.findMany` with `where` `{ projectId: 'project-1', kind: 'DECISION', status: 'active', deletedAt: null, OR: [{ sourceType: null }, { sourceType: { not: 'review_event' } }] }`.
- `[unit]` the same call passes `orderBy` `[{ updatedAt: 'desc' }, { id: 'desc' }]` and `take` `100`.
- `[integration]` with three active DECISION rows in one project, sourced `review_event`, `manual` and null, `findActiveDecisions` returns the `manual` and null rows and not the `review_event` row.
- `[integration]` with 105 active `manual` DECISION rows whose `updatedAt` values all differ, `findActiveDecisions` returns 100 rows, the 100 most recently updated, newest first.
- `[integration]` `GET /api/context/:slug` for a project holding one active `review_event` DECISION and one active `manual` DECISION answers 200 with `canonicalState.activeDecisions` holding only the `manual` decision's id.

### US-002: The sync loop probes before it blames an event and always backs off

- `[unit]` at the smallest scale with no command acks and event seq 5 of job `j1` pending, when a request carrying job `j1` event seq 5 (type `state`) answers `ServerError` 400 and the next `client.sync` call answers 400 too, `syncOnce` returns `kind: 'retry'`.
- `[unit]` in that case the second `client.sync` request has `jobs` `[]` and the same `tokenRequests` and `bootId` as the rejected request.
- `[unit]` in that case `journal.replaceEvent` is never called and event seq 5 of `j1` is still pending with type `state`.
- `[unit]` when the rejected request is followed by a probe that answers 200, `journal.replaceEvent` is called once for `j1` seq 5 with type `lifecycle`, and `syncOnce` returns `kind: 'retry'` with `delayMs` 500 when `random` is fixed at 0.5.
- `[unit]` in that replaced case the loop logs at error level a message containing `event 5 (state) dropped` with context `{ jobId: 'j1', seq: 5, type: 'state' }`.
- `[unit]` when the probe answers 200 with one command, `handleCommands` is called with that command.
- `[unit]` when the probe throws `ServerError` 401, `syncOnce` returns `kind: 'stop'` with reason kind `auth`, and the event is not replaced.
- `[unit]` when the probe throws a non-`ServerError` error, `syncOnce` returns `kind: 'retry'` and the event is not replaced.
- `[unit]` with one event pending, every request answering 400 and `random` fixed at 0.5, once the scale is at its smallest, three consecutive `syncOnce` calls return `retry` with `delayMs` 500, 1000 and 2000.
- `[unit]` in that persistent-400 case each of those three `syncOnce` calls makes exactly two `client.sync` calls.
- `[unit]` `stop()` called while the probe is pending makes that `syncOnce` return `kind: 'woken'` and the event is not replaced.
- `[unit]` a 413 at the smallest scale with an event pending sends the same `jobs: []` probe as a 400 does.
- `[unit]` `SyncLoop.run` with one event pending and `random` fixed at 0.5 over a client that answers 400 to every request calls `sleep` with a positive delay before its third `client.sync` call after the scale reaches its smallest.

### US-003: Watch liveness treats EPERM as dead and checks a readopted pid's identity

- `[unit]` `isProcessAlive(4242, kill)` with a `kill` that throws an error whose `code` is `EPERM` returns false.
- `[unit]` `isProcessAlive(4242, kill)` with a `kill` that throws an error whose `code` is `ESRCH` returns false.
- `[unit]` `isProcessAlive(4242, kill)` with a `kill` that returns normally returns true, and `kill` was called with `4242` and `0`.
- `[unit]` `isProcessAlive(0, kill)` returns false without calling `kill`.
- `[unit]` a `JobRun` for a RUN job started at `watch` over a `FakeExecutor` whose `processIdentity` answers `'other'` while `alive` is true resolves while `alive` stays true.
- `[unit]` a RUN job started at `watch` whose `processIdentity` answers `'ours'` for three ticks, then `alive` false, (the fake's `dieAfterTicks(4)`, since `onTick` runs before the liveness check) calls `processIdentity` three times.
- `[unit]` a RUN job started at `watch` whose `processIdentity` answers `'unknown'` keeps watching: it is still unresolved after five ticks while `alive` is true, and resolves once `alive` turns false.
- `[unit]` a RUN job started at `prepare` with `alive` true for three ticks never calls `processIdentity`.
- `[unit]` a FIX job started at `watch` whose `processIdentity` answers `'other'` while `alive` is true resolves without calling `spawnFixStep`.
- `[unit]` `HostExecutor.processIdentity` for a RUN job whose injected `ProcessInfo.command` answers a command containing the job's profile name returns `'ours'`.
- `[unit]` `HostExecutor.processIdentity` for a RUN job whose injected `ProcessInfo.command` answers `'/usr/bin/vim notes.txt'` returns `'other'`.
- `[unit]` `HostExecutor.processIdentity` for a RUN job whose injected `ProcessInfo.command` answers null returns `'unknown'`.

### US-004: launchd restarts only on failure and the daemon rotates runner.log

- `[unit]` `launchdPlist(spec)` returns a plist whose `KeepAlive` value is a dict holding `<key>SuccessfulExit</key>` followed by `<false/>`.
- `[unit]` `launchdPlist(spec)` returns a plist whose `EnvironmentVariables` dict maps `KODA_RUNNER_SUPERVISOR` to `launchd`, next to `HOME` and `PATH`.
- `[unit]` `systemdUnit(spec)` still returns a unit with `RestartPreventExitStatus=2` and no `KODA_RUNNER_SUPERVISOR` line.
- `[unit]` `runCommand` with `env.KODA_RUNNER_SUPERVISOR` `'launchd'` and a daemon stopped by the server (401) returns 0 and logs at error level a message starting `stopped by the server (auth)`.
- `[unit]` `runCommand` without `KODA_RUNNER_SUPERVISOR` and a daemon stopped by the server (426) returns 2.
- `[unit]` `runCommand` with `env.KODA_RUNNER_SUPERVISOR` `'launchd'` and a missing identity returns 1.
- `[unit]` `RUNNER_LOG_MAX_BYTES` is importable from `service/log-rotate` and equals `10485760`.
- `[unit]` `rotateLogFile(path, 10)` for a 25-byte file returns true, leaves `path + '.1'` holding those 25 bytes, and leaves `path` empty.
- `[unit]` `rotateLogFile(path, 10)` when `path + '.1'` already exists replaces it with the current file's contents.
- `[unit]` `rotateLogFile(path, 10)` for a missing `path` returns false and does not throw.
- `[unit]` `rotateLogFile(path, 25)` for a 25-byte file returns false and creates no `path + '.1'`.
- `[unit]` `TUNING.runnerLogMaxBytes` equals `RUNNER_LOG_MAX_BYTES` and `TUNING.runnerLogCheckMs` equals `300000`.
- `[integration]` `startDaemon` with `tuning.runnerLogMaxBytes` 10 and a 25-byte `runner.log` in the home directory leaves `runner.log.1` holding those 25 bytes and an empty `runner.log` when `startDaemon` resolves (test home: `apps/runner/test/unit/daemon.spec.ts`).
- `[integration]` `startDaemon` with `tuning.runnerLogCheckMs` 20 and `runnerLogMaxBytes` 10, after 25 bytes are appended to `runner.log` once it has started, creates `runner.log.1` within one second.
- `[integration]` `startDaemon` whose home holds a directory named `runner.log` still resolves and logs a warning.

### US-005: Logout revokes the session even when the access cookie has expired

- `[unit]` `forwardToApi(event, '/auth/logout', { bearer: 'tok-1' })` sends `Authorization: Bearer tok-1` even when the event carries a `koda_token` cookie with another value.
- `[unit]` `forwardToApi(event, '/auth/me', { method: 'GET' })` without `bearer` still sends the `koda_token` cookie value as the Bearer.
- `[unit]` `POST /api/auth/logout` with a `koda_token` cookie and an upstream logout answering 200 calls `forwardToApi` once with `/auth/logout` and answers 204.
- `[unit]` with a `koda_token` cookie and an upstream logout answering 500, the route answers 502 with body `{ revoked: false }`.
- `[unit]` with a `koda_token` cookie and an upstream logout that throws, the route answers 502 with body `{ revoked: false }`.
- `[unit]` with only a `koda_refresh` cookie, the route calls `forwardToApi` first with `/auth/refresh` and `cookieName: 'refresh'`, then with `/auth/logout` and `bearer` equal to the `accessToken` the refresh returned, and answers 204.
- `[unit]` in that refresh-then-logout case `setAuthCookies` is never called.
- `[unit]` with only a `koda_refresh` cookie and the refresh answering 401, the route makes no `/auth/logout` call and answers 204.
- `[unit]` with only a `koda_refresh` cookie and the refresh answering 503, the route makes no `/auth/logout` call and answers 502 with body `{ revoked: false }`.
- `[unit]` with only a `koda_refresh` cookie and the refresh answering 200 with no `accessToken`, the route makes no `/auth/logout` call and answers 502 with body `{ revoked: false }`.
- `[unit]` with only a `koda_refresh` cookie and the refresh call throwing, the route answers 502 with body `{ revoked: false }`.
- `[unit]` with neither cookie, the route makes no `forwardToApi` call and answers 204.
- `[unit]` in every case above `clearAuthCookies` is called once.

### US-006: Deep links survive login

- `[unit]` `safeRedirectPath('/demo/tickets/KODA-12?tab=activity')` returns `'/demo/tickets/KODA-12?tab=activity'`.
- `[unit]` `safeRedirectPath('//evil.example/x')` returns `'/'`.
- `[unit]` `safeRedirectPath('/\\evil.example')` returns `'/'`.
- `[unit]` `safeRedirectPath('https://evil.example/')` returns `'/'`.
- `[unit]` `safeRedirectPath(undefined)` and `safeRedirectPath(['/a'])` each return `'/'`.
- `[unit]` `safeRedirectPath('/login?redirect=/x')` and `safeRedirectPath('/register')` each return `'/'`.
- `[unit]` `safeRedirectPath('/a\nb')` returns `'/'`.
- `[unit]` the auth middleware for an unauthenticated visit to a route whose `fullPath` is `/demo/tickets/KODA-12` returns `navigateTo({ path: '/login', query: { redirect: '/demo/tickets/KODA-12' } })`.
- `[unit]` the auth middleware for an unauthenticated visit to `/` returns `navigateTo({ path: '/login' })`.
- `[unit]` the auth middleware for an authenticated visit to `/login` with `query.redirect` `'/demo/fleet'` returns `navigateTo('/demo/fleet')`.
- `[unit]` the auth middleware for an authenticated visit to `/login` with `query.redirect` `'//evil.example'` returns `navigateTo('/')`.
- `[unit]` `login.vue` mounted through `mountSfc` (with `vee-validate` aliased so `useForm().handleSubmit(fn)` returns a function calling `fn` with valid values, and globals `useRoute`, `useRegistrationStatus`, `useHead`, `useAuth`, `useAppToast`, `navigateTo`) on a route whose `query.redirect` is `'/demo/fleet'`: its submit handler, after `auth.login` resolves, calls `navigateTo('/demo/fleet')`.
- `[unit]` `setAuthCookies(event, { accessToken: 'a', refreshToken: 'r' })` sets `koda_token` with `sameSite: 'lax'` and `koda_refresh` with `sameSite: 'strict'`.

### US-007: An API outage does not log the user out or stop live streams

- `[unit]` `useAuth().refreshSession()` returns `'ok'` when `POST /api/auth/refresh` resolves.
- `[unit]` `refreshSession()` returns `'unauthorized'` and sets `user` to null when the refresh rejects with `statusCode` 401.
- `[unit]` `refreshSession()` returns `'unauthorized'` when the refresh rejects with `status` 403.
- `[unit]` `refreshSession()` returns `'unavailable'` and keeps `user` when the refresh rejects with `statusCode` 502.
- `[unit]` `refreshSession()` returns `'unavailable'` and keeps `user` when the refresh rejects with an error that has no status.
- `[unit]` `refresh()` returns false and keeps `user` when the refresh rejects with `statusCode` 500.
- `[unit]` a project event stream whose `refreshAuth` resolves `'unauthorized'` after an error schedules no reopen.
- `[unit]` a project event stream whose `refreshAuth` resolves `'unavailable'` after each of eight consecutive errors schedules a reopen after each, with delays 1000, 2000, 4000, 8000, 16000, 30000, 30000 and 30000.
- `[unit]` a project event stream whose `refreshAuth` resolves `'ok'` after five consecutive errors stops at the sixth error without calling `refreshAuth` a sixth time.
- `[unit]` a project event stream that reopens after `'unavailable'` errors and receives `onopen` uses a delay of 1000 for its next recovery.
- `[unit]` a project event stream whose `refreshAuth` resolves `true` (not a `RefreshOutcome`) after an error schedules no reopen.
- `[unit]` a thread event stream whose `refreshAuth` resolves `'unauthorized'` after an error schedules no reopen.
- `[unit]` a thread event stream whose `refreshAuth` resolves `'unavailable'` after each of seven consecutive errors schedules a reopen after each.
- `[unit]` `useThread`'s stream, on an `EventSource` error, calls the `refreshSession` of `useAuth()`.

### US-008: The invite token stays one path segment

- `[unit]` the invite page mounted with route token `'../projects/demo/labels?'` calls `$api.get` with `'/invites/..%2Fprojects%2Fdemo%2Flabels%3F'`.
- `[unit]` `useAuth().acceptInvite('a/b', { name: 'N', password: 'p' })` calls `$fetch` with `'/api/invites/a%2Fb/accept'`.
- `[unit]` the Nitro accept route for router param `'../x'` calls `forwardToApi` with `'/invites/..%2Fx/accept'`.
- `[unit]` the Nitro accept route for router param `'tok123'` calls `forwardToApi` with `'/invites/tok123/accept'`.
- `[unit]` `useApprovalRequests().decide('a/b', 'approve')` posts to `'/approvals/a%2Fb/decisions'`.
