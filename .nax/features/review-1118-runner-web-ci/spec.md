# SPEC: Review 2026-11-14 runner, web and CI fixes (https-only clone URLs, identity-checked cancel, sanitized failure reasons, page-load outage, invisible characters in approvals, CI and Docker hardening)

## Summary

This feature fixes the runner, web and CI items of the 2026-11-14 whole-repo review (`docs/20261114-review-whole-repo.md`)
that are still open on main `64fea7d27` and need no further owner ruling. Its sibling feature
`review-1118-api-fixes` (#479) fixed the API items. Each item was re-checked against the code on 2026-11-18.

1. **D/BUG-8 and D/SEC-2 remainder (clone URL schemes).** The runner clones only `https:` URLs, and the job clone's
   clone and fetch run with `protocol.file.allow=never`. `http:` and `file:` URLs and the file transport are allowed
   only when the daemon is started with the test-only option `allowLocalCloneUrls`.
2. **D/BUG-4 remainder (cancel signals a recycled process group).** A cancel of a job this daemon did not spawn
   (a readopted job) sends SIGTERM and SIGKILL only on a watch tick where `processIdentity` reports the process as `ours`.
3. **D/SEC-13 (raw stderr in failure reasons).** The FIX and AGENT failure reasons built from nax stderr go through
   `sanitizeDiagnostic` before they are clipped.
4. **D/BUG-6 remainder (a page load during an outage logs the user out).** A failing `/api/auth/me` upstream that is
   not a `401` or `403` shows a "koda is unavailable" page with a retry button instead of sending the user to `/login`.
5. **D/SEC-12 (invisible characters in approvals).** The fleet bash approval panel and the thread approval card show
   bidi controls, zero-width characters and other control characters as visible `<U+XXXX>` markers and warn when
   any are present.
6. **E/SEC-13 and D/SEC-16 (CI and Docker hygiene).** `ci.yml` gets a read-only token, per-job TURBO secrets and
   SHA-pinned actions; `.dockerignore` excludes every `.env` file in the tree except `.env.example`.

## Motivation

The 2026-11-14 review graded area D (runner, protocol, CLI, web, CI and deploy) 74 and 73. The items below are still
reachable on main `64fea7d27`:

- D/BUG-8: `CLONE_SCHEMES` in `apps/runner/src/executor/workspace.ts` accepts `https:`, `http:` and `file:`. A server
  (or anyone who can shape an ASSIGN) can point the runner's clone at a local path or a plain-HTTP remote, and the
  shared clone then fetches from it on every job. `parseAssign` already refuses non-`https` URLs for a thread's
  project repositories (`assign-parser.ts`, the `projectRepos` check), but not for the job's own repository.
- D/SEC-2: `HARDENING_ARGS` in `apps/runner/src/executor/git.ts` sets `core.hooksPath`, `core.fsmonitor` and
  `submodule.recurse`, but not `protocol.file.allow`. `mirror-store.ts` already passes
  `protocol.file.allow=never` per call, with an `allowFileProtocol` input its unit spec sets.
- D/BUG-4: `JobRun.sendTerm` and `JobRun.escalateKill` signal `row.pgid` without an identity check. The watch loop
  checks `processIdentity` for a readopted job, but `requestCancel` and the watch start call `sendTerm` first, so a
  pid that was recycled after a runner restart can receive SIGTERM and then SIGKILL.
- D/SEC-13: `HostExecutor.readFixOutcome` turns the first line of `fix.stderr` into `stderrLine` with only
  `.slice(0, 200)`. `JobRun` writes it as the FAILED reason, which the server stores and the web shows. The AGENT
  path's `stderrLine` in `agent-result.ts` is the same. A token or URL credential printed by nax reaches the UI.
- D/BUG-6: `apps/web/server/api/auth/me.get.ts` answers `{ user: null }` for every upstream status of 400 or more,
  `useAuth().fetchUser` sets `user` to null on any rejection, and `middleware/auth.global.ts` redirects to `/login`.
  A 502 during a deploy logs out every user who navigates. The event streams already survive an outage
  (`refreshSession` is tri-state).
- D/SEC-12: `ApprovalRequestBashPanel.vue` and `ThreadApprovalCard.vue` render the command an approver allows as
  plain text. A right-to-left override or a zero-width character can make the shown command differ from the one
  that runs.
- E/SEC-13: `.github/workflows/ci.yml` has no `permissions:` block, gives `TURBO_TOKEN` to every job through a
  workflow-level `env:`, and uses tag-pinned actions. `release.yml` already uses `permissions: {}` and SHA pins.
- D/SEC-16: `.dockerignore` matches `.env` and `.env.*` at the root only; the tracked `apps/api/.env.test` reaches the
  API image's builder stage.

## Design

### Owner rulings (2026-11-18)

- Clone URLs: `https` only; `http:` and `file:` only behind a test-only option. The option is an injected value
  (`allowLocalCloneUrls`) passed from `DaemonOptions` down to every consumer, default `false`, and never read from
  `runner.json`, a CLI flag or an environment variable.
- `/api/auth/me` failure: show an error page and keep the session; only `401`, `403` or no access cookie leads to
  `/login`.
- ci.yml actions are SHA-pinned like `release.yml`.
- Deferred: live streaming of FIX step-2 output (D/ENH-1), the deploy smoke CI job, and the split of
  `thread-job-run.ts`. See Out of Scope.

### Integration: runner clone URL policy (US-001)

Symbols the feature reads:

- `parseAssign(command: FleetCommandOut): ParsedAssign` in `apps/runner/src/supervisor/assign-parser.ts`; refusals
  are `{ ok: false, detail: 'invalid <what>' }` (the `bad` helper). Its `projectRepos` check already refuses a
  non-`https:` URL with `invalid project repos`; that check is unchanged.
- `refreshMirror` in `apps/runner/src/thread/project-code/mirror-store.ts`: the precedent for
  `protocol.file.allow=<always|never>` per call. Unchanged.
- `GitError` in `apps/runner/src/executor/git.ts`: its message names `args[0]`. The `args` of every call stay as they
  are, so the message and the fake gits in the specs that match `args[0] === 'clone'` keep working.

Symbols the feature changes. The baseline only locates the code; the target is the interface to implement.

- `GitOptions` and `createGit` in `apps/runner/src/executor/git.ts`
  - Baseline: `GitOptions` is `{ cwd, timeoutMs?, env?, credentialHelper? }`; `createGit().run` spawns
    `['git', ...HARDENING_ARGS, ...helperArgs(options.credentialHelper), ...args]`.
  - Target: `GitOptions` gains `readonly fileProtocol?: 'always' | 'never'`. When it is set, `createGit().run` spawns
    `['git', ...HARDENING_ARGS, '-c', 'protocol.file.allow=<value>', ...helperArgs(...), ...args]`; when unset, the
    argv is unchanged. `HARDENING_ARGS` itself is unchanged.
- `assertCloneUrl`
  - Baseline: `assertCloneUrl(url: string): void`, accepting `https:`, `http:` and `file:`.
  - Target: `assertCloneUrl(url: string, options?: { allowLocalCloneUrls?: boolean }): void`. Accepts `https:`
    always; accepts `http:` and `file:` only when `options.allowLocalCloneUrls === true`; keeps the whitespace and
    leading-`-` refusals. Throws `PathError('invalid cloneUrl')` otherwise.
- `parseAssign`
  - Target: `parseAssign(command: FleetCommandOut, options?: { allowLocalCloneUrls?: boolean }): ParsedAssign`,
    passing the option to `assertCloneUrl` for `repo.cloneUrl`. The refusal stays `{ ok: false, detail: 'invalid cloneUrl' }`.
- `ensureClone`
  - Baseline: `ensureClone(git, { repoDir, cloneUrl, identity?, credentialHelper? })`.
  - Target: the input gains `allowLocalCloneUrls?: boolean`. It is passed to `assertCloneUrl` (so a refused URL throws
    before any git call), and the `clone` call's options carry `fileProtocol: 'never'`, or `'always'` when
    `allowLocalCloneUrls === true`. The `args` stay `['clone', '--', cloneUrl, repoDir]`.
- `cleanWorkspace`
  - Target: `cleanWorkspace(git, repoDir, credentialHelper = null, options?: { allowLocalCloneUrls?: boolean })`. The
    `fetch --prune origin` call's options carry `fileProtocol: 'never'`, or `'always'` when the option is true.
- `CommandHandlerDeps` gains `readonly allowLocalCloneUrls?: boolean`; `CommandHandler.assign` calls
  `parseAssign(command, { allowLocalCloneUrls: this.deps.allowLocalCloneUrls === true })`.
- `HostExecutorDeps` gains `readonly allowLocalCloneUrls?: boolean`; `HostExecutor.prepareWorkspace` passes it to
  `ensureClone` and `cleanWorkspace`.
- `ThreadHostDeps` (in `thread-job-run.ts`) and `PrepareThreadWorktreeInput` (in `thread-worktree.ts`) each gain
  `readonly allowLocalCloneUrls?: boolean`. `ThreadJobRun.prepare` copies the host's value into the prepare input, and
  `prepareThreadWorktree` passes it to `ensureClone`.
- `DaemonOptions` gains `readonly allowLocalCloneUrls?: boolean` (doc comment: test-only). `startDaemon` passes it to
  `CommandHandler`, to the `HostExecutor` it builds, and to the thread host. `apps/runner/src/main.ts` and
  `commands/run.ts` never set it.

### Integration: cancel identity (US-002)

Read-only symbols:

- `JobExecutor.processIdentity(job): Promise<'ours' | 'other' | 'unknown'>` and `JobExecutor.kill(pgid, signal)`.
- `killIfOurs` in `apps/runner/src/supervisor/kill-if-ours.ts`: the existing "signal only while the pid is ours" rule
  for abandon and readopt rejection.

`JobRun` in `apps/runner/src/supervisor/job-run.ts`:

- Baseline: `start(from)` computes a local `spawnedHere` (`from === 'prepare' || from === 'reprepare'`);
  `requestCancel`, `chainFixStep` and the start of `watchUntilExit` call `sendTerm(row)` directly; `watchUntilExit`
  calls `escalateKill(row)` on every live tick.
- Target: a private instance field `spawnedHere`, default `false`, set in `start` from the same expression before
  `prepareAndSpawn` runs. Config jobs are unaffected (their path returns before the watch and their `pgid` is null).
  For a job spawned here, signalling is unchanged. For a job not spawned here, `requestCancel` and the watch start
  record the cancel but send no signal; the watch loop, on each tick where the job is alive and `processIdentity`
  (already called there for such a job) returns `ours`, calls `sendTerm` when a cancel is requested and then
  `escalateKill`. A tick whose identity is `unknown` sends no signal and keeps watching, as today; `other` ends the
  watch, as today. No extra `processIdentity` call is added per tick.

### Integration: failure reasons (US-003)

- `sanitizeDiagnostic(text, env = process.env)` in `apps/runner/src/diagnostics.ts` (read-only): strips ANSI escapes and
  control characters, redacts secret env values, URL credentials, `Bearer`/`Basic` values, `token=`-style pairs and
  GitHub, `sk-` and bot tokens, and caps at 800 characters.
- `HostExecutor.readFixOutcome`
  - Baseline: `stderrLine` is the first non-empty trimmed line of `fix.stderr`, `.slice(0, 200)`.
  - Target: that line passed through `sanitizeDiagnostic`, then `.slice(0, 200)`; an empty result is `null`.
- `stderrLine` in `apps/runner/src/executor/agent-job/agent-result.ts`
  - Baseline: `inspect()` stops collecting at 301 characters and returns `clip(line, 300)`, so the line is cut before
    anything could sanitize it.
  - Target: `inspect()` collects up to 4,000 characters of the first non-empty line; the line is passed through
    `sanitizeDiagnostic` and then clipped to 300. An empty result is `undefined`.

### Integration: page-load outage (US-004, US-005)

- `apps/web/server/api/auth/me.get.ts` (US-004)
  - Baseline: no access cookie, any upstream status of 400 or more, or a body without a user all answer
    `{ user: null }`. A rejected `forwardToApi` (network failure) becomes Nitro's 500.
  - Target: no access cookie, upstream `401` or `403`, or a 2xx body without a user answer `{ user: null }`. Any other
    upstream status of 400 or more, and a rejected `forwardToApi`, throw
    `createError({ statusCode: 503, statusMessage: 'Service Unavailable' })`.
- `useAuth()` in `apps/web/composables/useAuth.ts` (US-004)
  - Baseline: `fetchUser(): Promise<boolean>` sets `user` from `/api/auth/me` and sets it to `null` on any rejection.
  - Target: `useAuth()` also returns `sessionUnavailable`, a `useState<boolean>('koda_session_unavailable', () => false)`.
    `fetchUser` keeps its boolean result. On success it sets `user` and `sessionUnavailable = false`. A rejection whose
    status (`errorStatus`) is `401` or `403` sets `user = null` and `sessionUnavailable = false`. Any other rejection
    leaves `user` unchanged, sets `sessionUnavailable = true` and returns `false`. `login`, `register` and
    `acceptInvite` set `sessionUnavailable = false` when they set `user`, so a flag left by an outage on `/login` never
    blocks the signed-in user.
- `middleware/auth.global.ts` (US-005): after `fetchUser`, when `!auth.isAuthenticated.value` and
  `auth.sessionUnavailable.value` are both true and the route is not guest-only, it returns
  `abortNavigation(createError({ statusCode: 503, statusMessage: 'Service Unavailable', fatal: true, data: { redirect: to.fullPath } }))`
  instead of redirecting. Nuxt's `abortNavigation` throws the error and shows the error page only for a `fatal` error,
  on SSR and on a client navigation alike, so `fatal: true` is required. A guest-only route renders as today. The
  `/invite/` early return is unchanged.
- New `apps/web/components/AppErrorPage.vue` (US-005) holds the page; new `apps/web/error.vue` (the Nuxt root error
  page, which also replaces the default page for other errors) only renders `<AppErrorPage :error="error" />`. The
  component lives under `components/` so `tests/i18n/used-keys-exist.spec.ts` checks its keys in both locales. Its
  props are declared inline as `{ error: { statusCode: number; data?: { redirect?: string } | null } }` (no `#app`
  type import):
  - `error.statusCode === 503`: a title and body from `errorPage.unavailable.title` and `errorPage.unavailable.body`,
    and a retry button (`data-testid="error-page-retry"`, `errorPage.retry`) that calls
    `clearError({ redirect: error.data?.redirect ?? '/' })`.
  - Any other status: a title from `errorPage.generic.title` with the status code, and a home button
    (`data-testid="error-page-home"`, `errorPage.home`) that calls `clearError({ redirect: '/' })`.
  - New keys go into `i18n/locales/en.json` and `i18n/locales/zh.json` under a top-level `errorPage` group.
  - `tests/helpers/mount-sfc.ts` gains `clearError` in `NUXT_AUTO_IMPORTS`, so a test can supply it through `globals`.

### Integration: invisible characters (US-006)

New module `apps/web/lib/reveal-invisible.ts`:

```ts
export interface RevealedText { text: string; count: number }

/** Replaces each invisible or control character with a visible `<U+XXXX>` marker (uppercase hex, at least 4 digits). */
export function revealInvisible(input: string): RevealedText
```

The replaced set: U+0000-U+0008, U+000B-U+001F (this includes CR, U+000D), U+007F, U+061C, U+200B-U+200F,
U+202A-U+202E, U+2060-U+2064, U+2066-U+2069 and U+FEFF. Tab (U+0009) and line feed (U+000A) stay as they are. `count`
is the number of characters replaced. The function takes a string only; a component never calls it with `null` or
`undefined` and renders an absent field as it does today.

- `ApprovalRequestBashPanel.vue` renders the fields it shows through `revealInvisible`: `command` (or `rawDetail`,
  which the panel shows only when `command` is empty), `reason`, `root` and `featureName`. When the sum of the counts of
  the rendered fields is above zero it shows a warning line
  (`data-testid="approval-request-bash-invisible"`, key `approvals.fleet.bash.invisible` with `{ count }`).
- `ThreadApprovalCard.vue` renders `tool`, `summary`, `command` and `reason` (each when present) through
  `revealInvisible`, with a warning line (`data-testid="thread-approval-invisible"`, key
  `fleet.threads.approval.invisible` with `{ count }`).
- Both keep rendering through `{{ }}` interpolation only (the card's B4-D1 note), never `v-html`.
- The new strings must not contain `@`, `$` or `|` (`tests/i18n/approvals-locale-parity.spec.ts` refuses them in
  `approvals.*`). `tests/i18n/used-keys-exist.spec.ts` checks that both keys exist in both locales.

### Integration: CI and Docker (US-007)

- `.github/workflows/ci.yml`: a top-level `permissions:` block with `contents: read`. The workflow-level `env:` that
  holds `TURBO_TEAM` and `TURBO_TOKEN` is removed; the two variables are set in the `env:` of each job that installs
  dependencies (`quality`, `test`, `integration-shards`, `runner-integration`, `e2e`, `evaluate`, `smoke`) and not in
  `changes` or `integration`.
- `apps/api/test/unit/tooling/ci-integration-shards.spec.ts` slices `ci.yml` from the line `  integration-shards:` to
  the next `\n  integration:` and checks the shard matrix there. Both job header lines and the `integration-shards`
  matrix keep their exact text.
- Every `uses:` in `ci.yml` names a commit SHA with the version as a trailing comment. The SHAs (resolved
  2026-11-18; the first three match `release.yml`):

  | Action | Pin |
  |:--|:--|
  | `actions/checkout` | `3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1` |
  | `actions/setup-node` | `949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0` |
  | `oven-sh/setup-bun` | `0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0` |
  | `actions/cache` | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0` |
  | `actions/upload-artifact` | `cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2` |

- `.dockerignore`: `**/.env` and `**/.env.*` patterns, followed by `!**/.env.example`, so that every `.env*` file in
  the tree except the examples stays out of the build context. The existing root rules may stay.

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| ASSIGN `repo.cloneUrl` is `http:` or `file:` and the option is off | ack `rejected` with detail `invalid cloneUrl`; no job row | US-001 |
| `ensureClone` given an `http:` or `file:` URL with the option off | throws `PathError('invalid cloneUrl')` before any git call | US-001 |
| Readopted job's identity is `unknown` while a cancel is pending | no signal this tick; watch continues | US-002 |
| Readopted job's identity is `other` while a cancel is pending | no signal; the watch ends as today | US-002 |
| `fix.stderr` first line is all control characters | `stderrLine` is `null`; the reason falls back to `fix not pushed` | US-003 |
| `/auth/me` upstream answers any status of 400 or more other than 401 and 403, or the request fails | `503` from `/api/auth/me`; `sessionUnavailable` true; error page; cookies untouched | US-004, US-005 |
| `/auth/me` upstream answers 401 or 403 | `{ user: null }`; redirect to `/login` with `redirect` as today | US-004, US-005 |

## Out of Scope

- Live streaming of FIX step-2 output (D/ENH-1): it needs new stream names in `@nathapp/fleet-protocol`, the API log
  store and the web log viewer; FIX output stays in the job bundle.
- The deploy smoke CI job (compose up, migrate, `/api/health`, web login): deferred until the production deployment
  decision.
- Splitting `apps/runner/src/thread/thread-job-run.ts` (1114 lines) and the API files over 800 lines: a separate
  refactor feature.
- The API items not in `review-1118-api-fixes`: `GET /agents/:slug/pickup` to POST (A/SEC-11), actors on merged-PR
  rows (C/ENH-1), and the OpenAPI consumer audit.
- The raw invite token in client paths (D/SEC-5): `apiPath` already percent-encodes the token; moving it out of the
  page URL would change the emailed link.
- D/BUG-10 for the root `docker-compose.yml`: the example deploy's `deploy.sh` already refuses a URL-unsafe
  `POSTGRES_PASSWORD`; the root compose is a local stack.
- The refresh cookie's `secure: true`, `sameSite: 'strict'` and `path: '/'`, CSP and security headers, and
  `NODE_ENV=production` in the images: they belong to the production TLS and deploy work.
- `protocol.file.allow` for git calls other than the clone in `ensureClone` and the fetch in `cleanWorkspace` (for
  example the config-job checkout and thread publish); `HARDENING_ARGS` is unchanged.
- US-006 only: U+0085, U+00AD and U+2028/U+2029 are not replaced, and the panel's `stage` and `storyId` are not passed
  through `revealInvisible`.
- Rejecting an approval that contains invisible characters; the web only makes them visible.
- Rotating or changing the values in `apps/api/.env.test`; only the Docker build context changes.
- US-002 only: an identity check before SIGTERM or SIGKILL for a job spawned by this daemon; its pid cannot have been
  recycled while this daemon watched it.

## Stories

The feature is a bundle of small independent fixes in three areas, split from the API bundle at the owner's choice
(2026-11-18). Seven stories, one package each; US-005 consumes US-004's `sessionUnavailable`.

**US-001: https-only clone URLs and no file transport for the job clone.** Workdir: `apps/runner`. No dependencies.
Adds the `allowLocalCloneUrls` option from `DaemonOptions` down to `parseAssign`, `ensureClone`, `cleanWorkspace`,
`HostExecutor` and the thread worktree, adds `GitOptions.fileProtocol`, and sets the option in every runner test that
clones from a local origin through those paths.

**US-002: Identity-checked cancel signals for readopted jobs.** Workdir: `apps/runner`. No dependencies.
In `job-run.spec.ts` the fake's `identityUnknown` is a static flag, so a changing identity needs a `processIdentity`
override (the readopt cases near line 81 do this), and a process that must outlive SIGTERM needs `onKill` set to a no-op.

**US-003: Sanitized FIX and AGENT failure reasons.** Workdir: `apps/runner`. No dependencies.

**US-004: `/api/auth/me` and `useAuth` tell an outage from a logout.** Workdir: `apps/web`. No dependencies.

**US-005: Error page instead of a logout during an outage.** Workdir: `apps/web`. Depends on US-004.

**US-006: Reveal invisible characters in approvals.** Workdir: `apps/web`. No dependencies.

**US-007: CI token, TURBO secrets, action pins and Docker context.** Workdir: `.`. No dependencies.
**No-test:** CI workflow and Docker ignore configuration that no runtime test loads.

### Context Files

**US-001**
- `apps/runner/src/executor/workspace.ts` — `assertCloneUrl`, `ensureClone`, `cleanWorkspace`.
- `apps/runner/src/executor/git.ts` — `GitOptions`, `createGit`, `HARDENING_ARGS`, `GitError`.
- `apps/runner/src/supervisor/assign-parser.ts` — `parseAssign`, `bad`, the `projectRepos` https check.
- `apps/runner/src/daemon/daemon.ts` — `DaemonOptions`, the `HostExecutor`, thread host and `CommandHandler` construction.
- `apps/runner/src/thread/thread-worktree.ts` — `PrepareThreadWorktreeInput`, `prepareThreadWorktree`, `ensureRepoClone`.

**US-002**
- `apps/runner/src/supervisor/job-run.ts` — `start`, `requestCancel`, `sendTerm`, `escalateKill`, `watchUntilExit`, `chainFixStep`.
- `apps/runner/src/supervisor/kill-if-ours.ts` — the identity rule for other kills.
- `apps/runner/src/supervisor/job-run.spec.ts` — the fake executor (`procMatches`, `identityUnknown`, `killed`) and the readopt cases.

**US-003**
- `apps/runner/src/executor/host-executor.ts` — `readFixOutcome`.
- `apps/runner/src/executor/agent-job/agent-result.ts` — `stderrLine`, `inspect`, `readAgentResult`.
- `apps/runner/src/diagnostics.ts` — `sanitizeDiagnostic`.

**US-004**
- `apps/web/server/api/auth/me.get.ts` — the `/me` proxy.
- `apps/web/composables/useAuth.ts` — `fetchUser`, `refreshSession`, `errorStatus`.
- `apps/web/server/utils/api.ts` — `forwardToApi`.
- `apps/web/tests/server/logout-route.spec.ts` — the pattern for testing a server handler with mocked globals.
- `apps/web/tests/useAuth.spec.ts` — the pattern for testing `useAuth` with a fake `$fetch` and state.

**US-005**
- `apps/web/middleware/auth.global.ts` — the redirect.
- `apps/web/tests/middleware/auth.spec.ts` — how the middleware is tested with mocked globals.
- `apps/web/tests/helpers/mount-sfc.ts` — `loadSfc`, `mountSfc` and `NUXT_AUTO_IMPORTS`.

**US-006**
- `apps/web/components/approvals/ApprovalRequestBashPanel.vue` — the bash panel.
- `apps/web/components/fleet/threads/ThreadApprovalCard.vue` — the thread approval card.
- `apps/web/lib/fleet-approvals.ts` — `BashApprovalPayload`.
- `apps/web/tests/components/approval-request-fleet-panels.spec.ts` — how the bash panel is mounted in tests.
- `apps/web/tests/components/thread-approval-card.spec.ts` — how the card is mounted in tests.

**US-007**
- `.github/workflows/release.yml` — the existing SHA pins and `permissions` layout.
- `apps/api/test/unit/tooling/ci-integration-shards.spec.ts` — the `ci.yml` anchors it slices on.

### Creates

**US-004**
- `apps/web/tests/server/auth-me-route.spec.ts` — the `/api/auth/me` handler cases.

**US-005**
- `apps/web/components/AppErrorPage.vue` — the error page content.
- `apps/web/error.vue` — the root error page; renders `AppErrorPage`.
- `apps/web/tests/components/app-error-page.spec.ts` — the `AppErrorPage` cases.

**US-006**
- `apps/web/lib/reveal-invisible.ts` — `revealInvisible`.
- `apps/web/tests/lib/reveal-invisible.spec.ts` — the `revealInvisible` cases.

### Modifies

**US-001**
- `apps/runner/test/unit/workspace.spec.ts` — the `assertCloneUrl` `test.each` that accepts the local http URL and the file URL with no option now passes `{ allowLocalCloneUrls: true }` for those two; its `ensureClone` and `cleanWorkspace` cases that use a local origin pass `allowLocalCloneUrls: true`, including the case (about line 57) that expects `git clone failed` for a file URL to a missing path, which keeps that expectation by passing the option. No other assertion changes.
- `apps/runner/test/unit/checkout.spec.ts` — fixtures that clone a local origin through `ensureClone` or `cleanWorkspace` pass `allowLocalCloneUrls: true`; no assertion changes.
- `apps/runner/test/unit/plan-commit.spec.ts` — fixtures that clone a local origin through `ensureClone` or `cleanWorkspace` pass `allowLocalCloneUrls: true`; no assertion changes.
- `apps/runner/test/unit/workspace-auth.spec.ts` — fixtures that clone a local origin through `ensureClone` or `cleanWorkspace` pass `allowLocalCloneUrls: true`; no assertion changes.
- `apps/runner/test/unit/host-executor.spec.ts` — every `HostExecutor` construction that reaches `prepare` or `prepareConfig` with a local origin (the shared `world()` helper and the direct constructions after it) passes `allowLocalCloneUrls: true` in the executor deps; no assertion changes.
- `apps/runner/test/unit/host-executor-auth.spec.ts` — `HostExecutor` constructions whose job repository is a local origin pass `allowLocalCloneUrls: true` in the executor deps; no assertion changes.
- `apps/runner/test/unit/config-job.spec.ts` — `HostExecutor` constructions whose job repository is a local origin pass `allowLocalCloneUrls: true` in the executor deps; no assertion changes.
- `apps/runner/test/unit/job-check.spec.ts` — `HostExecutor` constructions whose job repository is a local origin pass `allowLocalCloneUrls: true` in the executor deps; no assertion changes.
- `apps/runner/test/unit/thread-worktree.spec.ts` — `prepareThreadWorktree` inputs that clone a local origin through the real git pass `allowLocalCloneUrls: true`; no assertion changes.
- `apps/runner/test/unit/thread-stale-start.spec.ts` — `prepareThreadWorktree` inputs that clone a local origin pass `allowLocalCloneUrls: true`; no assertion changes.
- `apps/runner/test/unit/daemon-thread.spec.ts` — `startDaemon` calls whose jobs clone a local origin pass `allowLocalCloneUrls: true`; no assertion changes.
- `apps/runner/test/integration/harness/world.ts` — its `startDaemon` call passes `allowLocalCloneUrls: true`, because the harness's git front serves plain http on 127.0.0.1.

**US-002**
None. The readopt cases in `job-run.spec.ts` that expect a SIGTERM (for example "a cancel recorded while down is re-sent") report identity `ours` on the first live tick, so they still see it; cases started with `prepare` are unchanged.

**US-003**
None. No existing case feeds a secret, an ANSI escape or a line over 300 characters through these readers.

**US-004**
None. `tests/useAuth.spec.ts` and `tests/composables/useAuth.spec.ts` keep passing: a rejection without a status leaves an already-null `user` null, and a `401` still clears it.

**US-005**
- `apps/web/tests/middleware/auth.spec.ts` — the mocked `useAuth()` objects gain `sessionUnavailable: ref(false)`, and the mocked globals gain `abortNavigation` and `createError`; every existing assertion stays.
- `apps/web/tests/helpers/mount-sfc.ts` — `NUXT_AUTO_IMPORTS` gains `'clearError'`; nothing else changes.
- `apps/web/i18n/locales/en.json` — gains the `errorPage` group.
- `apps/web/i18n/locales/zh.json` — gains the `errorPage` group.

**US-006**
- `apps/web/tests/i18n/fleet-locale-parity.spec.ts` — the `approvalKeys` list in "the thread page mode and approval keys cover exactly what the controls render (US-012)" gains `'invisible'`; the per-locale non-empty checks and the `approve` wording assertions stay.
- `apps/web/i18n/locales/en.json` — gains `approvals.fleet.bash.invisible` and `fleet.threads.approval.invisible`.
- `apps/web/i18n/locales/zh.json` — gains `approvals.fleet.bash.invisible` and `fleet.threads.approval.invisible`.

**US-007**
None. `ci-integration-shards.spec.ts` reads `ci.yml`, and the Design keeps the anchors and the matrix it checks.

### Seams

- US-001: `DaemonOptions.allowLocalCloneUrls` reaches `parseAssign` through `CommandHandler` (AC-10, AC-11 through
  `startDaemon`); `HostExecutorDeps.allowLocalCloneUrls` reaches `ensureClone` (AC-12, AC-13 through
  `HostExecutor.prepare`); `ThreadHostDeps.allowLocalCloneUrls` reaches the prepare input (AC-14 through the thread
  run).
- US-005 consumes US-004's `useAuth().sessionUnavailable` (US-005 AC-1 to AC-3 drive the middleware with a `fetchUser`
  that sets it).
- US-006: `revealInvisible` is called by both components (AC-6 and AC-11 mount them with a payload holding U+202E).

## Acceptance Criteria

### US-001

- AC-1 [unit] `assertCloneUrl('http://127.0.0.1:1234/a/b.git')`, called without options, throws a `PathError` with message `invalid cloneUrl`.
- AC-2 [unit] `assertCloneUrl('file:///tmp/x.git')`, called without options, throws a `PathError` with message `invalid cloneUrl`.
- AC-3 [unit] `assertCloneUrl('file:///tmp/x.git', { allowLocalCloneUrls: true })` returns without throwing.
- AC-4 [unit] `assertCloneUrl('ssh://host/a.git', { allowLocalCloneUrls: true })` throws `invalid cloneUrl`.
- AC-5 [unit] `createGit().run(['clone', '--', <local file-URL origin>, <dir>], { cwd, fileProtocol: 'never' })` resolves with a non-zero `code`.
- AC-6 [unit] `ensureClone` given a file-URL `cloneUrl` and no `allowLocalCloneUrls` rejects with `PathError('invalid cloneUrl')` before its recording `git` stub is called.
- AC-7 [unit] `ensureClone` given an `https:` `cloneUrl` for a missing clone makes its `clone` call with options whose `fileProtocol` is `'never'`.
- AC-8 [unit] `ensureClone` with `allowLocalCloneUrls: true` and the real `createGit()` leaves a `<repoDir>/.git` cloned from a local file-URL origin.
- AC-9 [unit] `cleanWorkspace(git, repoDir)` makes its `fetch --prune origin` call with options whose `fileProtocol` is `'never'`.
- AC-10 [unit] A daemon started with `startDaemon` without `allowLocalCloneUrls`, given an ASSIGN whose `repo.cloneUrl` is `file:///tmp/x.git`, acks that command with `{ result: 'rejected', detail: 'invalid cloneUrl' }`.
- AC-11 [unit] A daemon started with `startDaemon({ ..., allowLocalCloneUrls: true })`, given the same ASSIGN, acks it with `result: 'ok'`.
- AC-12 [unit] `HostExecutor.prepare` for a RUN job whose repository is a local origin, with executor deps that leave `allowLocalCloneUrls` unset, makes no `clone` call on its recording `git` stub.
- AC-13 [unit] `HostExecutor.prepare` for the same job, with executor deps that set `allowLocalCloneUrls: true` and the real `createGit()`, leaves a clone at the job's repository directory.
- AC-14 [unit] A thread run whose host deps set `allowLocalCloneUrls: true` calls its injected `prepareWorktree` with an input whose `allowLocalCloneUrls` is `true`.

### US-002

- AC-1 [unit] A `JobRun` started with `start('prepare')` whose job is RUNNING records exactly one `SIGTERM` to the job's pgid when `requestCancel()` is called.
- AC-2 [unit] A `JobRun` started with `start('watch')` on a RUNNING row with `cancelRequestedAt` set, whose fake executor reports the process alive and identity `other`, records no signal in the fake's `killed` list.
- AC-3 [unit] The same readopted watch whose identity is `ours` records one `SIGTERM` to the row's pgid.
- AC-4 [unit] A readopted watch with a pending cancel whose identity answers `unknown` for the first ticks records no signal during those ticks.
- AC-5 [unit] In the AC-4 case, once the identity turns `ours`, the next tick records one `SIGTERM`.
- AC-6 [unit] A readopted watch that is `ours`, received `SIGTERM`, and whose process outlives `killGraceMs` records a `SIGKILL` on a tick whose identity is `ours`.
- AC-7 [unit] A readopted watch that received `SIGTERM` and whose identity turns `other` before `killGraceMs` ends records no `SIGKILL`.
- AC-8 [unit] A readopted watch that received `SIGTERM`, whose `killGraceMs` has elapsed and whose identity answers `unknown`, records no `SIGKILL` on those ticks.
- AC-9 [unit] `requestCancel()` during a readopted watch (`start('watch')`, no cancel at start) records no signal before the next watch tick.
- AC-10 [unit] In the AC-9 case, the next live tick whose identity is `ours` records one `SIGTERM`.

### US-003

- AC-1 [unit] `HostExecutor.readFixOutcome` for a job whose `fix.stderr` first non-empty line is `push failed: https://x-access-token:ghs_abcdefghij@github.com/o/r.git` returns a `stderrLine` that includes `[redacted]`.
- AC-2 [unit] In the AC-1 case, the token `ghs_abcdefghij` is absent from the returned `stderrLine`.
- AC-3 [unit] `HostExecutor.readFixOutcome` for a `fix.stderr` line holding the ANSI sequence ESC `[31m` returns a `stderrLine` with the escape sequence removed.
- AC-4 [unit] `HostExecutor.readFixOutcome` for a 500-character `fix.stderr` line returns a `stderrLine` of at most 200 characters.
- AC-5 [unit] `HostExecutor.readFixOutcome` whose `fix.stderr` first non-empty line consists only of control characters returns `stderrLine: null`.
- AC-6 [unit] `readAgentResult` for an AGENT job dir with no result file and a `nax.stderr` first line `Authorization: Bearer abc.def.ghi` returns `ok: false` with a `stderrLine` from which `abc.def.ghi` is absent.
- AC-7 [unit] `readAgentResult` for a `nax.stderr` first line of 290 filler characters followed by `token=SECRETVALUE123456` returns a `stderrLine` in which `SECRETVALUE` is absent.
- AC-8 [unit] `readAgentResult` for a 1,000-character `nax.stderr` first line returns a `stderrLine` of at most 300 characters.

### US-004

- AC-1 [unit] The `/api/auth/me` handler with an access cookie whose upstream `/auth/me` answers `401` returns `{ user: null }`.
- AC-2 [unit] The `/api/auth/me` handler whose upstream answers `403` returns `{ user: null }`.
- AC-3 [unit] The `/api/auth/me` handler whose upstream answers `502` throws an H3 error with `statusCode` `503`.
- AC-4 [unit] The `/api/auth/me` handler whose upstream answers `429` throws an H3 error with `statusCode` `503`.
- AC-5 [unit] The `/api/auth/me` handler whose `forwardToApi` call rejects with a network error throws an H3 error with `statusCode` `503`.
- AC-6 [unit] The `/api/auth/me` handler with no access cookie returns `{ user: null }` without calling `forwardToApi`.
- AC-7 [unit] `useAuth().fetchUser()` whose `/api/auth/me` call rejects with `statusCode` `503`, while `user` holds a user, returns `false`.
- AC-8 [unit] In the AC-7 case, `user` still holds the same user afterwards.
- AC-9 [unit] In the AC-7 case, `sessionUnavailable` is `true` afterwards.
- AC-10 [unit] `useAuth().fetchUser()` whose `/api/auth/me` call rejects with `statusCode` `401` after an unavailable probe sets `sessionUnavailable` to `false`.
- AC-11 [unit] `useAuth().fetchUser()` that resolves `{ user }` after an unavailable probe sets `sessionUnavailable` to `false`.
- AC-12 [unit] `useAuth().login(...)` that succeeds after an unavailable probe sets `sessionUnavailable` to `false`.

### US-005

- AC-1 [unit] `auth.global.ts` for route `/projects` with no user, whose `fetchUser` sets `sessionUnavailable` to `true`, calls `abortNavigation` with an error whose `statusCode` is `503`.
- AC-2 [unit] In the AC-1 case, the error passed to `abortNavigation` has `fatal: true`.
- AC-3 [unit] In the AC-1 case, the error passed to `abortNavigation` has `data.redirect` equal to `'/projects'`.
- AC-4 [unit] In the AC-1 case, `navigateTo` is never called.
- AC-5 [unit] `auth.global.ts` for route `/login` with no user, whose `fetchUser` sets `sessionUnavailable` to `true`, never calls `abortNavigation`.
- AC-6 [unit] `auth.global.ts` for route `/projects` with a signed-in user and `sessionUnavailable` left `true`, never calls `abortNavigation`.
- AC-7 [unit] `auth.global.ts` for route `/projects` with no user, whose `fetchUser` leaves `sessionUnavailable` `false`, returns `navigateTo({ path: '/login', query: { redirect: '/projects' } })`.
- AC-8 [unit] `AppErrorPage` mounted with `error` `{ statusCode: 503 }` renders the `errorPage.unavailable.title` key.
- AC-9 [unit] Clicking `error-page-retry` of `AppErrorPage` mounted with `error` `{ statusCode: 503, data: { redirect: '/projects/acme' } }` calls `clearError` with `{ redirect: '/projects/acme' }`.
- AC-10 [unit] `AppErrorPage` mounted with `error` `{ statusCode: 404 }` renders the `errorPage.generic.title` key.
- AC-11 [unit] Clicking `error-page-home` of `AppErrorPage` mounted with a `404` error calls `clearError` with `{ redirect: '/' }`.

### US-006

- AC-1 [unit] `revealInvisible('rm -rf /tmp/\u202Ex')` returns `{ text: 'rm -rf /tmp/<U+202E>x', count: 1 }`.
- AC-2 [unit] `revealInvisible('a\u200Bb\u200Dc\u2060d\u2066e\uFEFF')` returns `{ text: 'a<U+200B>b<U+200D>c<U+2060>d<U+2066>e<U+FEFF>', count: 5 }`.
- AC-3 [unit] `revealInvisible('a\u0007b\u007Fc')` returns `{ text: 'a<U+0007>b<U+007F>c', count: 2 }`.
- AC-4 [unit] `revealInvisible('a\tb\nc')` returns `{ text: 'a\tb\nc', count: 0 }`.
- AC-5 [unit] `revealInvisible('\u061C\u200E\u200F\r')` returns `{ text: '<U+061C><U+200E><U+200F><U+000D>', count: 4 }`.
- AC-6 [unit] `ApprovalRequestBashPanel` mounted with a bash payload whose `command` is `rm -rf /tmp/\u202Ex` renders `rm -rf /tmp/<U+202E>x` in `approval-request-bash-command`.
- AC-7 [unit] In the AC-6 case, the panel renders `approval-request-bash-invisible`.
- AC-8 [unit] `ApprovalRequestBashPanel` mounted with a payload whose rendered fields hold no invisible characters does not render `approval-request-bash-invisible`.
- AC-9 [unit] `ApprovalRequestBashPanel` mounted with a plain `command` and a `reason` holding `\u200B` renders `approval-request-bash-invisible`.
- AC-10 [unit] `ApprovalRequestBashPanel` mounted with an empty `command` and a `rawDetail` holding `\u202E` renders the `<U+202E>` marker in `approval-request-bash-raw`.
- AC-11 [unit] `ThreadApprovalCard` mounted with an approval whose `command` holds `\u202E` renders the `<U+202E>` marker in the command.
- AC-12 [unit] In the AC-11 case, the card renders `thread-approval-invisible`.
- AC-13 [unit] `ThreadApprovalCard` mounted with an approval with no invisible characters does not render `thread-approval-invisible`.

### US-007

- AC-1 [review] `.github/workflows/ci.yml` has a top-level `permissions:` block whose only entry is `contents: read`.
- AC-2 [review] `.github/workflows/ci.yml` has no workflow-level `env:` block; `TURBO_TEAM` and `TURBO_TOKEN` are set in the job-level `env:` of `quality`, `test`, `integration-shards`, `runner-integration`, `e2e`, `evaluate` and `smoke`.
- AC-3 [review] The `changes` and `integration` jobs in `.github/workflows/ci.yml` set neither `TURBO_TEAM` nor `TURBO_TOKEN`.
- AC-4 [review] Every `uses:` line in `.github/workflows/ci.yml` names the 40-character commit SHA from the Design pin table for its action, followed by a `# vX.Y.Z` comment.
- AC-5 [review] `.dockerignore` has the patterns `**/.env` and `**/.env.*` and, after them, `!**/.env.example`.
