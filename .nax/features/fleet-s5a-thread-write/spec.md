<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Fleet S5a-C1 — Thread Write Path on the Runner (write_doc, Publish, Stale Start, Discard)

## Summary

The koda fleet runner lets a brainstorm thread's agent write Markdown documents into the thread's checkout and turns
them into a local commit on the thread's feature branch. A new `write_doc` tool writes allowlisted `.md` files
(`docs/**` and the thread's own `.nax/features/<feature>/**`) without committing; `list_files` and `search_repo` start
seeing those files. A `THREAD_PUBLISH` command on a live session, or a `THREAD` job with `action: 'PUBLISH'` when no
session is live, commits exactly the allowlisted files the thread changed onto `refs/heads/feat/<feature>` in the
runner's clone and pushes nothing. A session whose worktree cannot move to the branch's new tip now starts "stale" on
its old commit instead of failing, and a `THREAD` job with `action: 'DISCARD'` resets the thread's unpublished files and
re-detaches the worktree at the branch tip. The runner reports `threadWrite: true` so the API can tell it supports all
of this.

This is feature C1 of fleet S5a phase C (umbrella `docs/superpowers/specs/2026-10-10-fleet-s5a-chat-threads-design.md`
§3.1, §3.2, §4.3, §4.4, §5.2). Phase B (B1 #256, B3a #259, B3b #260, B2 #262, B4 #263, #267) is merged and deployed.
C2 `fleet-s5a-thread-handoff` (API: Publish / Plan / Run / Discard routes, the one-active-job rule, ingest of the new
stream lines, the PLAN `branch_mismatch` verdict, the `write_doc` system-prompt text, `threadWrite` gating) and C3
(web action bar, commit markers, PLAN / RUN cards) follow.

## Motivation

Phase B threads are read-only: the agent can list, search and read the repo and load skills, but the brainstorm ends
as chat text the user has to copy into a spec by hand. Phase C's goal is that the thread ends with
`.nax/features/<feature>/spec.md` committed on the runner's local `feat/<feature>` branch, ready for a PLAN pinned to
the same runner. The runner is where the checkout, the git identity and the repo mutex live, so the write path and
the commit belong here; building and testing them against fakes first (as B3 did for phase B) keeps C2 to API wiring.
Today the runner rejects `THREAD_PUBLISH` as `unsupported`, rejects a `PUBLISH` ASSIGN as `invalid thread action`, and
fails a session start with `worktree_conflict` whenever a PLAN or RUN has moved the feature branch under unpublished
thread files.

## Design

### Rulings that bind every story

- **C1-R1 (user, 2026-10-13):** phase C is three features in order C1 runner -> C2 API -> C3 web. C1 changes no API or
  web code and the deployed API keeps working with a C1 runner: the API never queues `THREAD_PUBLISH` or a
  `PUBLISH` / `DISCARD` job before C2, and its stream parser counts the new line types as bad lines and skips them.
- **C1-R2 (user):** Discard is only a `THREAD` job action (`DISCARD`) that runs when no session is live (the UI ends
  the session first). There is no `THREAD_DISCARD` command.
- **C1-R3 (user):** the runner advertises the write path with a capability flag, `threadWrite: true` in its capability
  report. `FLEET_PROTOCOL_VERSION` stays `4`.
- **C1-R4 (user):** Publish never waits on the repo mutex. If another job holds the repo's mutex, Publish fails at once
  with `repo_busy`; the user retries later.
- **C1-D1:** Publish keeps `refs/heads/feat/<feature>` and the worktree's `HEAD` together. It compares the branch with
  the worktree `HEAD` at publish time: an absent branch is created, a branch equal to `HEAD` is advanced, any other
  value is `branch_moved`. No session-start state is persisted.
- **C1-D2:** a `PUBLISH` or `DISCARD` job opens no session, acquires no git credentials, fetches nothing and prepares
  no skills. It goes `RUNNING`, writes exactly one result line to its `thread` stream (no `session_started`), drains
  the stream, then `UPLOADING` -> `COMPLETED` with `stateReason` equal to the result line's `type`.
- **C1-D3:** the commit title is the thread title, which `ThreadAssign` now carries as optional `title`; without it the
  commit uses the feature name.

### Integration

Read-only symbols (verified on main `edc9b488`):

- `ThreadAssign`, `ThreadRunnerLine`, `THREAD_COMMAND_TYPES` (includes `THREAD_PUBLISH`), `THREAD_LIMITS` —
  `packages/fleet-protocol/src/threads.ts`.
- `naxPathGroup` / `isAllowedNaxPath` — `packages/fleet-protocol/src/nax-config-paths.ts`: the pattern to mirror for a
  pure path allowlist (segment regex, no `\`, NUL or leading `/`, length cap).
- `RepoMutex.acquire(key)` and `RepoMutex.isLocked(key)` — `apps/runner/src/supervisor/repo-mutex.ts`. A PLAN or RUN
  holds the mutex for its whole job (`supervisor/job-run.ts:107`).
- `symlinkOnPath` / `applyEdits` — `apps/runner/src/executor/config-job/apply-edits.ts`: the symlink and real-path
  checks to mirror for `write_doc`.
- `commitAndPushConfig` — `apps/runner/src/executor/config-job/commit-push.ts:45`: the explicit-identity commit
  (`-c user.name=… -c user.email=… -c commit.gpgsign=false commit --no-verify` plus the `GIT_AUTHOR_*` /
  `GIT_COMMITTER_*` env) to mirror.
- `threadWorktreeDir(homeDir, threadId)` — `apps/runner/src/thread/thread-paths.ts`.
- `CommandHandler.handle` routes `THREAD_PUBLISH` to `Supervisor.threadCommand`, which calls `ThreadJobRun.command`
  (`apps/runner/src/supervisor/command-handler.ts:97`, `supervisor.ts:70`); this routing is unchanged.

Symbols this feature changes. The baseline only locates the code; implement the target.

| Symbol | Baseline | Target |
|---|---|---|
| `ThreadAction` (`threads.ts:24`) | `'SESSION' \| 'PUBLISH'` | `'SESSION' \| 'PUBLISH' \| 'DISCARD'` (US-001) |
| `ThreadAssign` | no title | gains `title?: string` (at most 200 characters) (US-001) |
| `ThreadRunnerLine` | four runner lines | adds `write_doc`, `published`, `publish_failed`, `discarded`, `discard_failed`; `session_started` gains optional `stale: true` (US-001) |
| `RunnerCapabilities` (`index.ts:63`) | no write flag | gains `threadWrite?: true` (US-001); reported by `NaxCapabilityProbe.probe` (US-007) |
| `parseAssign` (`supervisor/assign-parser.ts:145`) | `action !== 'SESSION'` -> `invalid thread action` | accepts `SESSION`, `PUBLISH`, `DISCARD`; `PUBLISH` / `DISCARD` require `initialMessage: null`; copies `title` (US-001) |
| `ThreadEventWriter` (`thread/thread-event-writer.ts`) | `started`, `inputConsumed`, `closed`, `failed` | `started` takes optional `stale`; gains `docWritten`, `published`, `publishFailed`, `discarded`, `discardFailed` (US-002) |
| `ThreadToolContext` (`thread/tools/types.ts`) | no feature | gains optional `feature?: string` (absent: only `docs/**` is allowlisted, because no `.nax/features/<feature>/` prefix can match) and `onDocWritten?: (path: string, bytes: number) => void` (US-003); optional so the existing tool-test contexts still type-check |
| `buildThreadTools` (`thread/tools/index.ts`) | four tools | five, `write_doc` last (US-003) |
| `listFilesTool` / `searchRepoTool` | tracked files only | tracked files plus untracked, non-ignored files that pass `isAllowedThreadDocPath` (US-003) |
| `prepareThreadWorktree` (`thread/thread-worktree.ts`) | checkout refused -> `{ ok: false, reason: 'worktree_conflict' }` | checkout refused in an existing worktree -> `{ ok: true, worktree, tipSha: <HEAD>, stale: true }`; every `ok: true` carries `stale` (US-005) |
| `ThreadPrepareResult` (`thread/thread-job-run.ts:40`) | `{ ok: true; worktree; tipSha }` | `{ ok: true; worktree; tipSha; stale?: boolean }`, absent meaning `false` (US-005); optional so the existing `prepareWorktree` test stubs still type-check |
| `ThreadHostDeps` (`thread/thread-job-run.ts:60`) | `prepareWorktree?`, `ensureSkills?` seams | also `publish?` and `discard?` seams, defaulting to `publishThreadDocs` / `discardThreadChanges` (US-006, US-007) |
| `ThreadJobRun.command` (`thread-job-run.ts:638`) | `THREAD_PUBLISH` -> `rejected` `unsupported` | live-session publish (US-006) |
| `ThreadJobRun.run` (`thread-job-run.ts:208`) | always opens a session | `PUBLISH` / `DISCARD` actions run without one (US-007) |

### Protocol additions (US-001)

In `packages/fleet-protocol` (new file `src/thread-doc-paths.ts`, exported from `src/index.ts`):

```ts
export const THREAD_DOC_LIMITS = { maxFileBytes: 524_288, maxPathChars: 512 } as const;
/** Pure, no I/O. `feature` is the thread's feature slug. */
export function isAllowedThreadDocPath(path: string, feature: string): boolean;
```

`isAllowedThreadDocPath(path, feature)` is `true` exactly when all hold:

1. `path` is a string of 1..`maxPathChars` characters with no `\`, no NUL and no leading `/`;
2. every `/`-separated segment matches `/^[A-Za-z0-9._-]+$/` and is not `.` or `..`, and no segment equals `.git`
   (any letter case);
3. the last segment ends in `.md` and is longer than `.md`;
4. either the first segment is `docs` and there are at least 2 segments, or the path starts with
   `.nax/features/<feature>/` and there are at least 4 segments.

In `src/threads.ts`:

```ts
export type ThreadAction = 'SESSION' | 'PUBLISH' | 'DISCARD';
export type ThreadPublishFailReason = 'branch_moved' | 'repo_busy' | 'no_worktree' | 'git_error';
export type ThreadDiscardFailReason = 'no_worktree' | 'git_error';
// ThreadAssign gains: title?: string;
export type ThreadRunnerLine =
  | { type: 'session_started'; at: string; resumed: boolean; backend: ThreadBackend; skillShas: string[]; stale?: true }
  | { type: 'session_closed'; at: string; reason: ThreadCloseReason }
  | { type: 'input_consumed'; at: string; messageId: string }
  | { type: 'session_failed'; at: string; reason: ThreadFailReason }
  | { type: 'write_doc'; at: string; path: string; bytes: number }
  | { type: 'published'; at: string; sha: string; paths: string[]; ignored: string[]; specPresent: boolean }
  | { type: 'publish_failed'; at: string; reason: ThreadPublishFailReason }
  | { type: 'discarded'; at: string; tipSha: string }
  | { type: 'discard_failed'; at: string; reason: ThreadDiscardFailReason };
```

`RunnerCapabilities` in `src/index.ts` gains `threadWrite?: true`. The `THREAD_PUBLISH` payload is `{}`; the runner
ignores its content.

### ASSIGN parsing (US-001)

`parseAssign` accepts `thread.action` `SESSION`, `PUBLISH` or `DISCARD`; any other value is `invalid thread action`.
For `PUBLISH` and `DISCARD`, a non-null `initialMessage` is `invalid initialMessage`. `thread.title`, when present, must
be a string of 1..200 characters (else `invalid thread title`) and is copied; when absent the parsed `ThreadAssign` has
no `title` key. All other `thread` fields keep the B3b rules for every action.

### Event writer lines (US-002)

`ThreadEventWriter` gains, each writing one runner line with `at` from the writer's clock after releasing held text
(as `closed` does today):

- `started({ resumed, backend, skillShas, stale })` writes `stale: true` only when `stale` is `true`; otherwise the line
  is unchanged from B3b.
- `docWritten(path, bytes)` -> `{ type: 'write_doc', at, path, bytes }`.
- `published({ sha, paths, ignored, specPresent })` -> `{ type: 'published', at, sha, paths, ignored, specPresent }`.
- `publishFailed(reason)` -> `{ type: 'publish_failed', at, reason }`.
- `discarded(tipSha)` -> `{ type: 'discarded', at, tipSha }`.
- `discardFailed(reason)` -> `{ type: 'discard_failed', at, reason }`.

### `write_doc` and allowlisted untracked files (US-003)

`writeDocTool(ctx)` in new `apps/runner/src/thread/tools/write-doc.ts`, input `{ path: string, content: string }`
(both required, `additionalProperties: false`), `approval: 'never'`. Steps, in order, the first failure returning an
`isError: true` result and writing nothing:

1. `path` must pass `isAllowedThreadDocPath(path, ctx.feature ?? '')`, else `path not allowed: <path>`;
2. `content` must be a string, else `content must be a string`;
3. `content` must be at most `THREAD_DOC_LIMITS.maxFileBytes` UTF-8 bytes, else `content too large`;
4. no existing segment of `<worktree>/<path>` (each directory, then the file) may be a symlink, else
   `refused symlink: <relative path>`;
5. create the parent directories; the parent's real path must be inside the worktree's real path, else
   `path escapes the worktree`;
6. write `content` as UTF-8, replacing an existing file; return `wrote <path> (<bytes> bytes)`; then call
   `ctx.onDocWritten?.(path, bytes)`.

The tool never runs git: the file stays untracked or modified until Publish.

`list_files` also lists untracked, non-ignored files (`git ls-files --others --exclude-standard`) that pass
`isAllowedThreadDocPath(path, ctx.feature)`, after the tracked ones, with the same `dir` / `glob` filter and the same
entry and byte caps. `search_repo` also returns hits in those files. Untracked files outside the allowlist and ignored
files never appear in either tool. The tool descriptions say so.

### Publish (US-004)

`publishThreadDocs(input)` in new `apps/runner/src/thread/thread-publish.ts`:

```ts
export interface PublishThreadDocsInput {
  readonly git: Git;
  readonly mutex: Pick<RepoMutex, 'acquire' | 'isLocked'>;
  readonly repoKey: string;
  readonly worktree: string;
  readonly feature: string;
  readonly threadId: string;
  readonly title: string;
  readonly identity: GitIdentity;
}
export type PublishThreadDocsResult =
  | { ok: true; sha: string; paths: string[]; ignored: string[]; specPresent: boolean }
  | { ok: false; reason: ThreadPublishFailReason; detail?: string };
export async function publishThreadDocs(input: PublishThreadDocsInput): Promise<PublishThreadDocsResult>;
```

Steps, all git calls with `cwd: input.worktree`:

1. If `worktree` does not exist or `git rev-parse --is-inside-work-tree` fails there: `no_worktree`.
2. If `mutex.isLocked(repoKey)`: `repo_busy`, and `acquire` is not called. Otherwise acquire it (granted at once) and
   release it in a `finally`.
3. Dirty set: entries of `git status --porcelain -z --untracked-files=all`. `paths` = entries that pass
   `isAllowedThreadDocPath(entry, feature)` and are not symlinks (`lstat`); `ignored` = every other entry. Both sorted.
4. `head` = `git rev-parse HEAD`; `current` = the sha of `refs/heads/feat/<feature>`, or `null` when it does not exist.
   `current !== null && current !== head` -> `branch_moved`.
5. `paths` empty: when `current === null`, `git update-ref refs/heads/feat/<feature> <head> <zero sha>`; result `sha`
   = `head`.
6. `paths` not empty: `git add -- <paths>`, then commit with the explicit identity (as `commitAndPushConfig`), message
   `docs(<feature>): spec from koda thread "<title>"`, a blank line, and the trailer `Koda-Thread: <threadId>`. `title`
   has CR / LF replaced by spaces and is cut to 200 characters. `newSha` = `git rev-parse HEAD`; then
   `git update-ref refs/heads/feat/<feature> <newSha> <current ?? zero sha>`; a non-zero exit is `branch_moved`.
7. `specPresent` = `git cat-file -e <sha>:.nax/features/<feature>/spec.md` exits 0.
8. A git call that fails outside the rules above is `git_error` with `detail` passed through `sanitizeDiagnostic`. No
   step pushes, fetches or touches a remote.

### Stale start and Discard (US-005)

`prepareThreadWorktree`: when the existing worktree's `git checkout --detach <tipSha>` exits non-zero, the result is
`{ ok: true, worktree, tipSha: <the worktree's HEAD sha>, stale: true }`, the worktree is left as it was, and the
returned `tipSha` is what the session starts on. A checkout that succeeds, and a freshly added worktree, give
`stale: false`. Every other failure keeps its B3a reason.

`discardThreadChanges(input)` in new `apps/runner/src/thread/thread-discard.ts`:

```ts
export interface DiscardThreadChangesInput {
  readonly git: Git;
  readonly homeDir: string;
  readonly repoDir: string;
  readonly threadId: string;
  readonly feature: string;
  readonly baseRef: string;
}
export type DiscardThreadChangesResult =
  | { ok: true; tipSha: string }
  | { ok: false; reason: ThreadDiscardFailReason; detail?: string };
export async function discardThreadChanges(input: DiscardThreadChangesInput): Promise<DiscardThreadChangesResult>;
```

Steps, in `threadWorktreeDir(homeDir, threadId)`: the directory must exist and be a git work tree, else `no_worktree`;
`git reset --hard HEAD`; `git clean -fd` (no `-x`, so ignored files survive); resolve the tip in the order
`prepareThreadWorktree` uses (local `refs/heads/feat/<feature>`, then `refs/remotes/origin/<baseRef>`, then
`<baseRef>^{commit}`, all read in `repoDir`); `git checkout --detach <tip>`; return `tipSha`. No fetch and no repo
mutex: only the thread's own worktree changes. A git failure is `git_error` with a sanitized `detail`.

### ThreadJobRun: live session (US-006)

- The tool context gets `feature: thread.feature` and `onDocWritten` that writes `writer.docWritten(path, bytes)` when
  the writer exists.
- `openStream` passes `stale: prepared.stale` to `writer.started`.
- `command('THREAD_PUBLISH', payload)` on a `RUNNING` session, after the existing `session_closed` /
  `session_not_ready` checks: a running turn -> `rejected` `turn_running`; a publish already in flight -> `rejected`
  `publishing`; otherwise `ok`, and the publish runs in the background through `host.publish` (default
  `publishThreadDocs`) with `git: host.git`, `mutex: deps.mutex`, `repoKey: row.repoKey`, the prepared worktree,
  `feature` and `threadId` from the ASSIGN's `thread`, `title: thread.title ?? thread.feature` and
  `identity: row.assign.gitIdentity`.
- While a publish is in flight the idle timer is stopped and `THREAD_INPUT` answers `rejected` `publishing`. When it
  settles, the writer gets `published(...)` or `publishFailed(reason)` and the idle timer is armed again.
- A close (idle, `THREAD_CLOSE`, cancel, cost or stream cap) that starts while a publish is in flight waits for it, so
  the result line comes before `session_closed`. After a halt nothing is written.
- `ThreadRunDeps.mutex` becomes `Pick<RepoMutex, 'acquire'> & Partial<Pick<RepoMutex, 'isLocked'>>`, so the eight
  existing thread-run test fixtures (`mutex: { acquire }`) still type-check. The run hands `publishThreadDocs` a mutex
  whose `isLocked` is `deps.mutex.isLocked` when present and `() => false` otherwise. Production always has it: the
  Supervisor passes the daemon's real `RepoMutex` (`supervisor.ts:44`).

### ThreadJobRun: PUBLISH and DISCARD jobs, capability (US-007)

- `action: 'PUBLISH'` or `'DISCARD'` (C1-D2): after the cancel check, no `credentials.acquire`, no `prepareWorktree`,
  no `ensureSkills`, no `sessions.open`. The row goes `RUNNING`, the stream file is created and registered as for a
  session, and no `session_started` line is written.
- `PUBLISH`: `host.publish` with the same input as US-006, `worktree: threadWorktreeDir(homeDir, threadId)`; the
  writer gets `published` / `publishFailed`.
- `DISCARD`: `host.discard` (default `discardThreadChanges`) with `homeDir`, `repoDir` (as `prepare` builds it),
  `threadId`, `feature` and `baseRef: row.assign.ref`; the writer gets `discarded(tipSha)` / `discardFailed(reason)`.
- Then the stream drains (as `finishRun`), `UPLOADING`, `COMPLETED` with `stateReason` the line type (`published`,
  `publish_failed`, `discarded`, `discard_failed`), `markDone`.
- Any thread command to a `PUBLISH` / `DISCARD` job answers `rejected` `no_session`. `requestCancel` before `RUNNING`
  ends it `CANCELLED` as today; once its git work has started the job finishes it.
- `NaxCapabilityProbe.probe` adds `threadWrite: true` to the report it builds.

### Failure Handling

| Case | Behaviour | Story |
|---|---|---|
| ASSIGN with an unknown `thread.action` | `invalid thread action` | US-001 |
| `PUBLISH` / `DISCARD` ASSIGN with an initial message | `invalid initialMessage` | US-001 |
| `thread.title` not a 1..200-character string | `invalid thread title` | US-001 |
| `write_doc` path outside the allowlist | `isError` `path not allowed: <path>`, nothing written | US-003 |
| `write_doc` content too large | `isError` `content too large`, nothing written | US-003 |
| `write_doc` through an existing symlink | `isError` `refused symlink: <path>`, nothing written | US-003 |
| `write_doc` parent resolves outside the worktree | `isError` `path escapes the worktree` | US-003 |
| Publish with no worktree | `publish_failed` `no_worktree` | US-004 |
| Publish while the repo mutex is held | `publish_failed` `repo_busy`, no wait | US-004 |
| Branch moved since the worktree's HEAD | `publish_failed` `branch_moved`, nothing committed onto the branch | US-004 |
| `update-ref` compare fails | `publish_failed` `branch_moved` | US-004 |
| A git call fails | `publish_failed` / `discard_failed` `git_error` | US-004, US-005 |
| Nothing to commit | `published` with `paths: []` and the current `HEAD` | US-004 |
| Session start cannot move to the new tip | session starts on the old HEAD, `session_started.stale: true` | US-005, US-006 |
| Discard with no worktree | `discard_failed` `no_worktree` | US-005 |
| `THREAD_PUBLISH` during a turn | `rejected` `turn_running` | US-006 |
| `THREAD_PUBLISH` while a publish runs | `rejected` `publishing` | US-006 |
| `THREAD_INPUT` while a publish runs | `rejected` `publishing` | US-006 |
| Close while a publish runs | close waits; result line before `session_closed` | US-006 |
| Thread command to a `PUBLISH` / `DISCARD` job | `rejected` `no_session` | US-007 |

## Out of Scope

- The API side of phase C belongs to feature C2 `fleet-s5a-thread-handoff`: queueing `THREAD_PUBLISH`, creating
  `PUBLISH` / `DISCARD` jobs, sending `thread.title`, gating on `threadWrite`, the `writtenPaths` / `publishedSha` /
  `specPublished` columns, folding the `write_doc`, `published`, `publish_failed`, `discarded`, `discard_failed` lines
  and `session_started.stale`, the one-active-job rule, Plan and Run dispatch from a thread, the PLAN
  `branch_mismatch` verdict and the system-prompt text about `write_doc`.
- The web side of phase C (action bar, Discard banner, commit markers, PLAN / RUN cards) belongs to feature C3.
- The runner never pushes a published commit; the thread's PLAN pushes `feat/<feature>` later.
- `write_doc` cannot delete or rename files and writes only `.md` files under the allowlist; there is no binary write.
- There is no `THREAD_DISCARD` command and no in-session discard (C1-R2).
- `FLEET_PROTOCOL_VERSION` stays 4 (C1-R3).
- Publish does not wait for the repo mutex (C1-R4).
- ACP backends belong to phase D; `write_doc` is a native-session tool only.
- Base-ref drift is not rebased; a stale session stays on its old HEAD until Discard.
- The runner `context.md` (`.nax/mono/apps/runner/context.md`) is updated by hand after merge.
- US-001 only: the allowlist's backslash, NUL, empty-stem (`docs/.md`), bare `docs.md` and 512-character boundary
  cases, a `title` that is absent (the parsed thread has no `title` key) and `THREAD_DOC_LIMITS` itself share the
  rules in Design without a dedicated acceptance criterion; `ThreadRunnerLine` and the two fail-reason unions are types,
  checked by `bun run type-check`.
- US-003 only: the exact 524288-byte boundary, `list_files`' `dir` / `glob` filter on untracked files, an ignored
  file in either tool, `search_repo`'s `fixed`, `max` and timeout rules for untracked files, a `write_doc` parent that
  resolves outside the worktree without a symlink, and the absent-`feature` context share the rules in Design without
  a dedicated acceptance criterion.
- US-004 only: an untracked symlink under the allowlist (it goes to `ignored`), the commit's single parent, the
  nothing-to-commit result's `paths: []`, `specPresent: false`, a non-zero `update-ref` exit after the compare and a
  failing git call (`git_error` with a sanitized `detail`) share the steps in Design without a dedicated acceptance
  criterion; so do the `title` CR / LF replacement, the 200-character cut and the `GIT_AUTHOR_*` /
  `GIT_COMMITTER_*` env, which follow `commitAndPushConfig`.
- US-005 only: the tip-resolution fallbacks after the local branch reuse `prepareThreadWorktree`'s order, and a
  failing git call during Discard is `git_error`, without a dedicated acceptance criterion.
- US-006 only: a `publish_failed` result leaving the row `RUNNING`, `stale: false` writing no `stale` key (pinned on
  the writer in US-002), a `THREAD_PUBLISH` during a turn not calling `host.publish`, a publish settling after a halt
  and a `host.publish` that throws (treated as `git_error`) share the rules in Design without a dedicated acceptance
  criterion.
- US-007 only: the row's `doneAt`, a `DISCARD` job's `discard_failed` stateReason, and a halt or ABANDON while a
  `PUBLISH` / `DISCARD` job runs (the existing halt path: no line, no transition) share the rules in Design without a
  dedicated acceptance criterion.

## Stories

1. **US-001: Doc-path allowlist and ASSIGN actions** — `Workdir: apps/runner` — no dependencies.
2. **US-002: Event writer lines** — `Workdir: apps/runner` — depends on US-001.
3. **US-003: `write_doc` tool and allowlisted untracked files** — `Workdir: apps/runner` — depends on US-001.
4. **US-004: Publish** — `Workdir: apps/runner` — depends on US-001.
5. **US-005: Stale start and Discard** — `Workdir: apps/runner` — depends on US-001.
6. **US-006: ThreadJobRun live publish, `write_doc` lines and stale announce** — `Workdir: apps/runner` — depends on
   US-002, US-003, US-004, US-005.
7. **US-007: PUBLISH and DISCARD jobs and the `threadWrite` capability** — `Workdir: apps/runner` — depends on US-006.

US-001 also edits `packages/fleet-protocol/src/threads.ts` and `packages/fleet-protocol/src/index.ts`. Build gate for
every story: `bun run type-check` and `bun run lint` in `apps/runner`; US-001 also `bun run type-check` at the repo
root.

### Context Files

> Existing files to read or change, or files an upstream dependency creates (annotated).

**US-001**

- `packages/fleet-protocol/src/threads.ts` — `ThreadAction`, `ThreadAssign`, `ThreadRunnerLine`
- `packages/fleet-protocol/src/nax-config-paths.ts` — the allowlist pattern to mirror
- `packages/fleet-protocol/src/index.ts` — `RunnerCapabilities`, the package exports
- `apps/runner/src/supervisor/assign-parser.ts` — `parseAssign`, the THREAD branch
- `apps/runner/src/supervisor/assign-parser-thread.spec.ts` — the THREAD ASSIGN fixture

**US-002**

- `apps/runner/src/thread/thread-event-writer.ts` — `ThreadEventWriter.started`, `closed`, `appendRunner`
- `apps/runner/test/unit/thread-event-writer.spec.ts` — the writer setup to copy

**US-003**

- `apps/runner/src/thread/tools/list-files.ts` — `listFilesTool`
- `apps/runner/src/thread/tools/search-repo.ts` — `searchRepoTool`
- `apps/runner/src/thread/tools/index.ts` — `buildThreadTools`
- `apps/runner/src/thread/tools/types.ts` — `ThreadToolContext`, `ThreadTool`
- `apps/runner/src/executor/config-job/apply-edits.ts` — `symlinkOnPath`, the real-path check

**US-004**

- `apps/runner/src/executor/config-job/commit-push.ts` — `commitAndPushConfig`, the explicit-identity commit
- `apps/runner/src/supervisor/repo-mutex.ts` — `acquire`, `isLocked`
- `apps/runner/src/executor/git.ts` — `Git`, `createGit`, `GitError`
- `apps/runner/test/helpers/git-fixture.ts` — `git`, `isolateGit`
- `packages/fleet-protocol/src/thread-doc-paths.ts` — created by US-001, `isAllowedThreadDocPath`

**US-005**

- `apps/runner/src/thread/thread-worktree.ts` — `prepareThreadWorktree`, `placeWorktree`, `resolveTip`
- `apps/runner/src/thread/thread-paths.ts` — `threadWorktreeDir`
- `apps/runner/test/unit/thread-worktree.spec.ts` — the `fakeGit` setup to reuse
- `apps/runner/test/helpers/git-fixture.ts` — `git`, `isolateGit`

**US-006**

- `apps/runner/src/thread/thread-job-run.ts` — `command`, `openStream`, `runTurn`, `finishRun`, `ThreadHostDeps`
- `apps/runner/test/unit/thread-job-run-commands.spec.ts` — the run setup (journal, fake session, fake logs) to copy
- `apps/runner/src/thread/thread-publish.ts` — created by US-004, `publishThreadDocs`
- `apps/runner/src/thread/tools/write-doc.ts` — created by US-003, `writeDocTool`

**US-007**

- `apps/runner/src/thread/thread-job-run.ts` — `run`, `stopped`, `endBeforeRunning`, `finishRun`
- `apps/runner/test/unit/thread-job-run.spec.ts` — the start setup to copy
- `apps/runner/src/capabilities/nax-probe.ts` — `NaxCapabilityProbe.probe`
- `apps/runner/src/thread/thread-discard.ts` — created by US-005, `discardThreadChanges`

### Creates

> New files each story authors.

**US-001**

- `packages/fleet-protocol/src/thread-doc-paths.ts` — `THREAD_DOC_LIMITS`, `isAllowedThreadDocPath`
- `apps/runner/test/unit/thread-write-contract.spec.ts` — the allowlist and the ASSIGN actions

**US-002**

- `apps/runner/test/unit/thread-event-writer-write.spec.ts` — the new writer lines

**US-003**

- `apps/runner/src/thread/tools/write-doc.ts` — `writeDocTool`
- `apps/runner/test/unit/thread-write-doc.spec.ts` — `write_doc` and the untracked listing, on real temporary git repos

**US-004**

- `apps/runner/src/thread/thread-publish.ts` — `publishThreadDocs`, `PublishThreadDocsInput`, `PublishThreadDocsResult`
- `apps/runner/test/unit/thread-publish.spec.ts` — publish on real temporary git repos

**US-005**

- `apps/runner/src/thread/thread-discard.ts` — `discardThreadChanges`, `DiscardThreadChangesInput`, `DiscardThreadChangesResult`
- `apps/runner/test/unit/thread-discard.spec.ts` — stale start and discard

**US-006**

- `apps/runner/test/unit/thread-job-run-publish.spec.ts` — live publish, `write_doc` lines, stale announce

**US-007**

- `apps/runner/test/unit/thread-job-run-actions.spec.ts` — `PUBLISH` and `DISCARD` jobs

### Modifies

**US-001**

- `apps/runner/src/supervisor/assign-parser-thread.spec.ts` — the test at line 68 asserting that `thread.action: 'PUBLISH'` returns `{ ok: false, detail: 'invalid thread action' }` becomes a test that `thread.action: 'PUBLISH'` with `initialMessage: null` returns an `assign.thread` whose `action` is `'PUBLISH'`, because this story makes `PUBLISH` a valid action; an unknown action such as `'REVIEW'` still returns `invalid thread action`.

**US-002**

None. The new writer methods are additions; `started` without `stale` writes the same line as before.

**US-003**

None. The existing `list_files` test (`thread-tools.spec.ts` line 76) uses an untracked `b.ts`, which is outside the allowlist and stays unlisted.

**US-004**

None. Publish is a new module.

**US-005**

- `apps/runner/test/unit/thread-worktree.spec.ts` — the test at line 174 expecting `{ ok: false, reason: 'worktree_conflict' }` when the existing worktree's checkout is refused becomes a test expecting a result matching `{ ok: true, stale: true }` with `tipSha` equal to the worktree's HEAD, because this story turns a refused checkout into a stale start; a refused `worktree add` still fails.

**US-006**

None. The publish command is added to `thread-job-run.ts`; no existing test asserts `THREAD_PUBLISH` -> `unsupported`.

**US-007**

- `apps/runner/src/capabilities/nax-probe.spec.ts` — the exact `capabilities` object at line 76 gains `threadWrite: true`, because this story makes the nax probe always report the thread write path; every other field stays as asserted.

### Seams

- US-001 -> US-003, US-004: `isAllowedThreadDocPath` decides what `write_doc` writes (US-003 AC-3) and what Publish
  commits (US-004 AC-6, AC-7).
- US-002 -> US-006, US-007: the new writer methods are reached through `ThreadJobRun` (US-006 AC-2, AC-6, AC-14;
  US-007 AC-3, AC-10).
- US-003 -> US-006: `writeDocTool` is in the tool set a session opens with, and its `onDocWritten` reaches the stream
  (US-006 AC-1, AC-2).
- US-004 -> US-006, US-007: `publishThreadDocs` is the default `host.publish`, reached through
  `ThreadJobRun.command('THREAD_PUBLISH')` (US-006 AC-4) and a `PUBLISH` ASSIGN (US-007 AC-2).
- US-005 -> US-006, US-007: `prepareThreadWorktree`'s `stale` reaches `session_started` (US-006 AC-14);
  `discardThreadChanges` is the default `host.discard`, reached through a `DISCARD` ASSIGN (US-007 AC-9).

## Acceptance Criteria

### US-001: Doc-path allowlist and ASSIGN actions

Allowlist criteria call `isAllowedThreadDocPath` imported from `@nathapp/fleet-protocol` with feature `'divide'`.
ASSIGN criteria call `parseAssign` with the THREAD fixture of `src/supervisor/assign-parser-thread.spec.ts`
(`thread.action: 'SESSION'`, `feature: 'brainstorm-x'`, `initialMessage: { messageId: 'm1', text: 'hi' }`), changing
only the fields the criterion names.

- AC-1 [unit] `isAllowedThreadDocPath('docs/specs/divide.md', 'divide')` returns `true`.
- AC-2 [unit] `isAllowedThreadDocPath('.nax/features/divide/spec.md', 'divide')` returns `true`.
- AC-3 [unit] `isAllowedThreadDocPath('.nax/features/other/spec.md', 'divide')` returns `false`.
- AC-4 [unit] `isAllowedThreadDocPath('docs/../src/a.md', 'divide')` returns `false`.
- AC-5 [unit] `isAllowedThreadDocPath('/docs/a.md', 'divide')` returns `false`.
- AC-6 [unit] `isAllowedThreadDocPath('docs/.GIT/a.md', 'divide')` returns `false`.
- AC-7 [unit] `isAllowedThreadDocPath('docs/a.ts', 'divide')` returns `false`.
- AC-8 [unit] `isAllowedThreadDocPath('src/docs/a.md', 'divide')` returns `false`.
- AC-9 [unit] `isAllowedThreadDocPath` of a `docs/`-prefixed `.md` path 513 characters long returns `false`.
- AC-10 [unit] `parseAssign` of the fixture with `thread.action: 'PUBLISH'` and `initialMessage: null` returns an
  `assign.thread` whose `action` is `'PUBLISH'`.
- AC-11 [unit] `parseAssign` of the fixture with `thread.action: 'DISCARD'` and `initialMessage: null` returns an
  `assign.thread` whose `action` is `'DISCARD'`.
- AC-12 [unit] `parseAssign` of the fixture with `thread.action: 'PUBLISH'` and the fixture's initial message returns
  `{ ok: false, detail: 'invalid initialMessage' }`.
- AC-13 [unit] `parseAssign` of the fixture with `thread.action: 'REVIEW'` returns `{ ok: false, detail: 'invalid
  thread action' }`.
- AC-14 [unit] `parseAssign` of the fixture with `thread.title: 'Divide brainstorm'` returns an `assign.thread` whose
  `title` is `'Divide brainstorm'`.
- AC-15 [unit] `parseAssign` of the fixture with a `thread.title` of 201 characters returns `{ ok: false, detail:
  'invalid thread title' }`.

### US-002: Event writer lines

Each criterion creates a `ThreadEventWriter` on a temporary stream file with a fixed clock at
`2026-10-13T00:00:00.000Z`, calls the method named, and reads the last line of the file as JSON.

- AC-1 [unit] `started({ resumed: false, backend: { kind: 'native' }, skillShas: [], stale: true })` writes a
  `session_started` line whose `stale` is `true`.
- AC-2 [unit] `started({ resumed: false, backend: { kind: 'native' }, skillShas: [], stale: false })` writes a
  `session_started` line that has no `stale` key.
- AC-3 [unit] `docWritten('docs/a.md', 12)` writes a line deep-equal to `{ type: 'write_doc', at:
  '2026-10-13T00:00:00.000Z', path: 'docs/a.md', bytes: 12 }`.
- AC-4 [unit] `published({ sha: 'abc', paths: ['docs/a.md'], ignored: ['src/x.ts'], specPresent: false })` writes a
  line deep-equal to `{ type: 'published', at: '2026-10-13T00:00:00.000Z', sha: 'abc', paths: ['docs/a.md'], ignored:
  ['src/x.ts'], specPresent: false }`.
- AC-5 [unit] `publishFailed('repo_busy')` writes a line deep-equal to `{ type: 'publish_failed', at:
  '2026-10-13T00:00:00.000Z', reason: 'repo_busy' }`.
- AC-6 [unit] `discarded('def')` writes a line deep-equal to `{ type: 'discarded', at: '2026-10-13T00:00:00.000Z',
  tipSha: 'def' }`.
- AC-7 [unit] `discardFailed('no_worktree')` writes a line deep-equal to `{ type: 'discard_failed', at:
  '2026-10-13T00:00:00.000Z', reason: 'no_worktree' }`.

### US-003: `write_doc` tool and allowlisted untracked files

Each criterion uses a real temporary git repository as the worktree (one tracked commit with `README.md`,
`docs/guide.md` and a `.gitignore` ignoring `*.log`), a `ThreadToolContext` with `feature: 'divide'` and a recording
`onDocWritten`.

- AC-1 [unit] After `writeDocTool(ctx).run({ path: '.nax/features/divide/spec.md', content: '# Divide' })`, the file
  `.nax/features/divide/spec.md` in the worktree holds `# Divide`.
- AC-2 [unit] `writeDocTool(ctx).run({ path: '.nax/features/divide/spec.md', content: '# Divide' })` returns `{
  content: 'wrote .nax/features/divide/spec.md (8 bytes)' }` with no `isError`.
- AC-3 [unit] `writeDocTool(ctx).run({ path: 'src/index.md', content: 'x' })` returns `{ content: 'path not allowed:
  src/index.md', isError: true }`.
- AC-4 [unit] `writeDocTool(ctx).run({ path: 'docs/a.md', content: 7 })` returns `{ content: 'content must be a
  string', isError: true }`.
- AC-5 [unit] `writeDocTool(ctx).run` with `path: 'docs/a.md'` and a `content` of 524289 ASCII characters returns `{
  content: 'content too large', isError: true }`.
- AC-6 [unit] With `docs` replaced by a symlink to a directory outside the worktree,
  `writeDocTool(ctx).run({ path: 'docs/a.md', content: 'x' })` returns `{ content: 'refused symlink: docs', isError:
  true }`.
- AC-7 [unit] With `docs/a.md` an existing symlink, `writeDocTool(ctx).run({ path: 'docs/a.md', content: 'x' })`
  returns `{ content: 'refused symlink: docs/a.md', isError: true }`.
- AC-8 [unit] After `writeDocTool(ctx).run({ path: 'docs/guide.md', content: 'new' })`, `git status --porcelain` in
  the worktree reports `docs/guide.md` as modified in the working tree and nothing staged or committed.
- AC-9 [unit] `writeDocTool(ctx).run({ path: 'docs/a.md', content: 'hello' })` calls `onDocWritten` exactly once, with
  `('docs/a.md', 5)`.
- AC-10 [unit] `writeDocTool(ctx).run({ path: 'src/index.md', content: 'x' })` does not call `onDocWritten`.
- AC-11 [unit] `buildThreadTools(ctx)` returns tools whose names are, in order, `list_files`, `search_repo`,
  `load_skill`, `read_skill_file`, `write_doc`.
- AC-12 [unit] With an untracked `docs/a.md` in the worktree, `listFilesTool(ctx).run({})` lists `docs/a.md`.
- AC-13 [unit] With an untracked `notes.md` in the worktree, `listFilesTool(ctx).run({})` does not list `notes.md`.
- AC-14 [unit] With an untracked `docs/a.md` holding `needle`, `searchRepoTool(ctx).run({ pattern: 'needle' })` returns
  a line starting `docs/a.md:1:`.
- AC-15 [unit] With an untracked `notes.md` holding `needle` and no tracked file holding it,
  `searchRepoTool(ctx).run({ pattern: 'needle' })` returns no line starting `notes.md`.

### US-004: Publish

Each criterion uses a real temporary clone (`repoDir`) of an origin at `main`, a thread worktree added from it with
`git worktree add --detach <wt> main`, feature `'divide'`, threadId `'t1'`, title `'Divide brainstorm'`, identity `{
name: 'koda-fleet[bot]', email: 'bot@koda.test' }`, `repoKey` `'r1'` and a real `RepoMutex`, and calls
`publishThreadDocs` once unless the criterion says otherwise.

- AC-1 [unit] With `.nax/features/divide/spec.md` written in the worktree and no `feat/divide` branch, the result
  matches `{ ok: true, paths: ['.nax/features/divide/spec.md'], ignored: [], specPresent: true }`.
- AC-2 [unit] In the AC-1 setup, `refs/heads/feat/divide` in `repoDir` afterwards equals the result's `sha`.
- AC-3 [unit] In the AC-1 setup, the commit at the result's `sha` has the subject `docs(divide): spec from koda thread
  "Divide brainstorm"`.
- AC-4 [unit] In the AC-1 setup, the last line of the commit message at the result's `sha` is `Koda-Thread: t1`.
- AC-5 [unit] In the AC-1 setup, the commit at the result's `sha` has the author `koda-fleet[bot] <bot@koda.test>`.
- AC-6 [unit] With `docs/a.md` and an untracked `src/x.ts` written in the worktree, the result matches `{ ok: true,
  paths: ['docs/a.md'], ignored: ['src/x.ts'] }`.
- AC-7 [unit] In the AC-6 setup, the commit at the result's `sha` changes exactly one file, `docs/a.md`.
- AC-8 [unit] With `feat/divide` already equal to the worktree's HEAD and `docs/a.md` written, `refs/heads/feat/divide`
  afterwards points at the result's `sha`.
- AC-9 [unit] With `feat/divide` pointing at a commit other than the worktree's HEAD and `docs/a.md` written, the
  result is `{ ok: false, reason: 'branch_moved' }`.
- AC-10 [unit] In the AC-9 setup, `refs/heads/feat/divide` afterwards still points at its earlier commit.
- AC-11 [unit] With `mutex.acquire('r1')` held by another caller and never released, the call resolves to `{ ok:
  false, reason: 'repo_busy' }`.
- AC-12 [unit] After a successful call, `mutex.isLocked('r1')` is `false`.
- AC-13 [unit] With nothing written and no `feat/divide` branch, `refs/heads/feat/divide` afterwards equals the
  worktree's HEAD.
- AC-14 [unit] With a `worktree` path that does not exist, the result is `{ ok: false, reason: 'no_worktree' }`.
- AC-15 [unit] A recording `Git` wrapping `createGit()`, passed to a successful call, receives no call whose first
  argument is `push` or `fetch`.

### US-005: Stale start and Discard

Stale-start criteria AC-1 to AC-5 use the `fakeGit` of `test/unit/thread-worktree.spec.ts` with an existing registered
worktree; AC-6 and AC-7 and the Discard criteria use a real temporary clone with a thread worktree added detached at
`main`, feature `'divide'`, threadId `'t1'` and baseRef `'main'`.

- AC-1 [unit] `prepareThreadWorktree` whose worktree `checkout --detach <tip>` exits 1 returns a result matching `{
  ok: true, stale: true }`.
- AC-2 [unit] In the AC-1 setup, the result's `tipSha` equals the worktree's `rev-parse HEAD` output.
- AC-3 [unit] `prepareThreadWorktree` whose worktree checkout exits 0 returns a result matching `{ ok: true, stale:
  false }`.
- AC-4 [unit] `prepareThreadWorktree` that adds a new worktree returns a result matching `{ ok: true, stale: false }`.
- AC-5 [unit] `prepareThreadWorktree` whose `worktree add` exits 1 returns a result with `ok` `false`.
- AC-6 [unit] On a real clone where `feat/divide` moved to a commit that changes `docs/a.md` while the worktree holds an
  uncommitted edit to the same `docs/a.md`, `prepareThreadWorktree` returns a result matching `{ ok: true, stale:
  true }`.
- AC-7 [unit] In the AC-6 setup, the worktree's `docs/a.md` still holds the uncommitted edit afterwards.
- AC-8 [unit] `discardThreadChanges` with an untracked `docs/a.md` in the worktree leaves no `docs/a.md` in the
  worktree.
- AC-9 [unit] `discardThreadChanges` with an uncommitted edit to the tracked `README.md` leaves `README.md` holding its
  committed content.
- AC-10 [unit] `discardThreadChanges` with an ignored `debug.log` in the worktree leaves `debug.log` in place.
- AC-11 [unit] `discardThreadChanges` with `feat/divide` at commit X in the clone returns `{ ok: true, tipSha: X }`.
- AC-12 [unit] In the AC-11 setup, the worktree's `HEAD` afterwards is X and detached.
- AC-13 [unit] `discardThreadChanges` with no `feat/divide` branch returns a `tipSha` equal to `origin/main` in the
  clone.
- AC-14 [unit] `discardThreadChanges` for a threadId with no worktree directory returns `{ ok: false, reason:
  'no_worktree' }`.
- AC-15 [unit] A recording `Git` wrapping `createGit()`, passed to `discardThreadChanges`, receives no call whose
  first argument is `fetch`.

### US-006: ThreadJobRun live publish, `write_doc` lines and stale announce

Each criterion runs a `ThreadJobRun` set up as in `test/unit/thread-job-run-commands.spec.ts` (real `:memory:`
journal, a scripted fake session, fake log shipping, manual clock), with a SESSION ASSIGN whose `thread.feature` is
`'divide'` and `thread.title` `'Divide brainstorm'`, a `prepareWorktree` stub returning `{ ok: true, worktree: <tmp>,
tipSha: 'aaa', stale: false }`, and a recording `host.publish` stub that resolves `{ ok: true, sha: 'bbb', paths:
['docs/a.md'], ignored: [], specPresent: false }` unless the criterion says otherwise. "Once `RUNNING`" means the row
is `RUNNING` and the first turn has ended.

- AC-1 [unit] The tools `sessions.open` receives include one named `write_doc`.
- AC-2 [unit] Once `RUNNING`, running the opened `write_doc` tool with `{ path: 'docs/a.md', content: 'hi' }` appends
  a stream line matching `{ type: 'write_doc', path: 'docs/a.md', bytes: 2 }`.
- AC-3 [unit] Once `RUNNING`, `command('THREAD_PUBLISH', {})` returns `{ result: 'ok' }`.
- AC-4 [unit] Once `RUNNING`, `command('THREAD_PUBLISH', {})` calls `host.publish` once with an input matching `{
  worktree: <tmp>, feature: 'divide', threadId: <ASSIGN thread.threadId>, title: 'Divide brainstorm', repoKey: <row
  repoKey>, identity: <ASSIGN gitIdentity> }`.
- AC-5 [unit] With the ASSIGN's `thread.title` absent, `command('THREAD_PUBLISH', {})` calls `host.publish` with
  `title` `'divide'`.
- AC-6 [unit] After `host.publish` resolves, the stream holds a line matching `{ type: 'published', sha: 'bbb',
  paths: ['docs/a.md'], ignored: [], specPresent: false }`.
- AC-7 [unit] With `host.publish` resolving `{ ok: false, reason: 'branch_moved' }`, the stream holds a line matching
  `{ type: 'publish_failed', reason: 'branch_moved' }`.
- AC-8 [unit] While a turn is running, `command('THREAD_PUBLISH', {})` returns `{ result: 'rejected', detail:
  'turn_running' }`.
- AC-9 [unit] While a first `host.publish` is pending, a second `command('THREAD_PUBLISH', {})` returns `{ result:
  'rejected', detail: 'publishing' }`.
- AC-10 [unit] While `host.publish` is pending, `command('THREAD_INPUT', { messageId: 'm2', text: 'x' })` returns `{
  result: 'rejected', detail: 'publishing' }`.
- AC-11 [unit] After `host.publish` resolves, `command('THREAD_INPUT', { messageId: 'm2', text: 'x' })` returns `{
  result: 'ok' }`.
- AC-12 [unit] With `host.publish` pending, `command('THREAD_CLOSE', {})` followed by resolving `host.publish` leaves
  the stream's `published` line before its `session_closed` line.
- AC-13 [unit] With `host.publish` pending, advancing the manual clock past `threadIdleMs` leaves the row `RUNNING`.
- AC-14 [unit] With `prepareWorktree` returning `stale: true`, the stream's `session_started` line has `stale` `true`.

### US-007: PUBLISH and DISCARD jobs and the `threadWrite` capability

Each criterion runs a `ThreadJobRun` set up as in `test/unit/thread-job-run.spec.ts`, with a THREAD ASSIGN whose
`thread.action` is the criterion's, `initialMessage: null`, `feature: 'divide'` and `title: 'Divide brainstorm'`;
recording `credentials`, `prepareWorktree`, `ensureSkills` and `sessions.open` stubs writing to one shared recorder;
and recording `host.publish` / `host.discard` stubs resolving `{ ok: true, sha: 'bbb', paths: ['docs/a.md'], ignored:
[], specPresent: true }` / `{ ok: true, tipSha: 'ccc' }` unless the criterion says otherwise. `start('prepare')`
resolves when the job ends.

- AC-1 [unit] A `PUBLISH` job's `start('prepare')` leaves the shared recorder with no `credentials.acquire`,
  `prepareWorktree`, `ensureSkills` or `sessions.open` call.
- AC-2 [unit] A `PUBLISH` job's `start('prepare')` calls `host.publish` once with an input matching `{ worktree:
  threadWorktreeDir(homeDir, threadId), feature: 'divide', title: 'Divide brainstorm' }`.
- AC-3 [unit] A `PUBLISH` job's stream file holds exactly one line, matching `{ type: 'published', sha: 'bbb', paths:
  ['docs/a.md'], ignored: [], specPresent: true }`.
- AC-4 [unit] A `PUBLISH` job's state events are exactly `RUNNING`, `UPLOADING`, then `COMPLETED` with reason
  `published`.
- AC-5 [unit] A `PUBLISH` job whose `host.publish` resolves `{ ok: false, reason: 'repo_busy' }` writes a stream line
  matching `{ type: 'publish_failed', reason: 'repo_busy' }`.
- AC-6 [unit] A `PUBLISH` job whose `host.publish` resolves `{ ok: false, reason: 'repo_busy' }` ends `COMPLETED` with
  reason `publish_failed`.
- AC-7 [unit] A `PUBLISH` job calls `logs.drain` for its job and epoch before its `UPLOADING` state event.
- AC-8 [unit] A `DISCARD` job's `start('prepare')` leaves the shared recorder with no `credentials.acquire`,
  `prepareWorktree`, `ensureSkills` or `sessions.open` call.
- AC-9 [unit] A `DISCARD` job's `start('prepare')` calls `host.discard` once with an input matching `{ homeDir:
  <host homeDir>, threadId: <ASSIGN thread.threadId>, feature: 'divide', baseRef: <ASSIGN ref> }`.
- AC-10 [unit] A `DISCARD` job's stream file holds exactly one line, matching `{ type: 'discarded', tipSha: 'ccc' }`.
- AC-11 [unit] A `DISCARD` job ends `COMPLETED` with reason `discarded`.
- AC-12 [unit] A `DISCARD` job whose `host.discard` resolves `{ ok: false, reason: 'no_worktree' }` writes a stream
  line matching `{ type: 'discard_failed', reason: 'no_worktree' }`.
- AC-13 [unit] While a `PUBLISH` job's `host.publish` is pending, `command('THREAD_INPUT', { messageId: 'm2', text:
  'x' })` returns `{ result: 'rejected', detail: 'no_session' }`.
- AC-14 [unit] A `PUBLISH` job whose row has `cancelRequestedAt` set before `start('prepare')` ends with state events
  exactly `CANCELLED`.
- AC-15 [unit] `NaxCapabilityProbe.probe` with the fake nax of `src/capabilities/nax-probe.spec.ts` returns
  capabilities whose `threadWrite` is `true`.
