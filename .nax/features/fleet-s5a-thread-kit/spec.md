<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Fleet S5a-B3a — Thread Kit (Runner Building Blocks: Tools, Skills, Worktree, Session Factory, Event Writer)

## Summary

The koda fleet runner gains the building blocks of a brainstorm-thread session host, each tested on its own and
wired into nothing yet: the thread stream contract and constants in `@nathapp/fleet-protocol`, a reader of the native
models the runner's nax config can serve and of the nax credentials config, the four agent tools (`list_files`,
`search_repo`, `load_skill`, `read_skill_file`), a skill fetcher and cache for SHA-pinned public GitHub skill sources,
a detached and locked git worktree per thread with an archive prune, a session factory over `@nathapp/nax-agent`
0.86.0 that only ever opens profile `read`, and an event writer that turns session events into redacted, size-capped
JSON lines for the `thread` log stream.

This is feature B3a of fleet S5a phase B (umbrella `docs/superpowers/specs/2026-10-10-fleet-s5a-chat-threads-design.md`
§1.5, §3.2, §4, §8). B1 `fleet-s5a-thread-core` (API) is merged. The next feature, B3b `fleet-s5a-thread-host`, wires
these blocks into the daemon: protocol v4, `THREAD` ASSIGN parsing, the `threadBackends` report, the thread job run
and its commands, Supervisor handling, free slots and the heartbeat. B2 `fleet-s5a-thread-ingest` (API) and B4
`fleet-s5a-thread-web` follow.

## Motivation

B1 lets the API create threads and place `THREAD` jobs on a v4 runner, but the runner has nothing that can host one:
no agent session library, no way to keep the agent inside a repo checkout without disturbing the PLAN and RUN jobs
that share the clone, no code-search or skill tools (Claude's `read` mode has no Grep or Glob, D544), and no safe way
to report what the agent says. Building these as independent, tested units first keeps the host feature (B3b) small
and lets the runner keep reporting protocol 3, so no `THREAD` job reaches it before it can run one.

## Design

### Rulings that bind every story

- D543 (umbrella): sessions always use nax-agent profile `read`.
- B3-R1 (user, 2026-10-11): B3 lands before B2. The API refuses a `thread` stream PUT until B2; nothing in this
  feature uploads one.
- B3-R2 (user): native model ids come from the `models.native` tiers of `<naxHome>/config.json`, reported bare (a
  trailing `[effort]` removed), only for providers with an available credential; a thread without a model gets the
  `balanced` tier's model, else the first.
- B3-R3 (user): `@nathapp/nax-agent` is pinned at exactly `0.86.0`; there is no runtime version-floor constant.
- B3-R4 (user): the thread host takes the `RepoMutex` only to create a missing clone; with a clone present it never
  takes the mutex, never rewrites the clone's config, passes its credential helper per git command, and creates the
  worktree locked. A fetch that loses a ref-lock race with another fetch in the clone is retried once.
- B3-R6 (correction of umbrella §4.2): nax-agent's `ProtectedPathsPolicy` is not a directory deny-list. Sessions pass
  `{ gitExcludePathspecs: [], gitIgnorePatterns: [], credentialDir: <naxHome> }`; the native read tools' realpath jail
  to `workdir` (the worktree) keeps `~/.nax`, `~/.ssh` and `~/.koda-runner` outside it unreachable.
- B3-R8: phase C owns writes; `list_files` and `search_repo` cover tracked files only. That is not a boundary on the
  agent: in profile `read` its own nax-agent `Read`, `Glob` and `Grep` tools see untracked files in the worktree, its
  read-only `Git` tool (`diff`, `log`, `show`, `status`, `blame`, `rev-parse`) reaches the repo's history, and its
  scratchpad tools write under `.nax/scratchpad` in the worktree.
- B3-R9: phase D owns ACP; the session factory refuses an `acp` backend with `backend_unavailable`.
- B3-R10 (2026-10-11, review): a thread's backend may leave `model` unset, so the default can change between
  sessions; the factory passes `carryHistoryAcrossModels: true` so a resumed thread never fails with
  `AGENT_SESSION_MODEL_MISMATCH`.
- B3-R11 (2026-10-11, review): deltas stream in small pieces, so redacting each `text_delta` alone misses a secret
  split across deltas. The writer keeps raw delta text per round, writes only a prefix that ends at whitespace at
  least 256 characters before the buffer's end, and redacts what it writes. A secret that contains whitespace or is
  longer than the hold-back can still be cut (Out of Scope).
- Server-supplied identifiers (skill `sourceId`, `owner`, `repo`, `sha`, `dir`; thread `threadId` and `feature`) pass
  `apps/runner/src/paths/safe-segment.ts` before they reach a path, a ref or a git argument (runner context rule).

### Integration

Read-only symbols (verified on main `21add9e5`, nax-agent tag `v0.86.0`):

- `Git.run(args, { cwd, timeoutMs?, env?, credentialHelper? })` → `{ code, stdout, stderr }` and `Git.ok`
  (`apps/runner/src/executor/git.ts:26`); `createGit()` kills a child with `SIGKILL` at `timeoutMs` (exit code 137)
  and reports no separate timeout signal. `reasonFromError(error)` (`git.ts:52`).
- `RepoMutex.acquire(key): Promise<() => void>` (`apps/runner/src/supervisor/repo-mutex.ts`).
- `ensureClone(git, { repoDir, cloneUrl, identity, credentialHelper })` (`apps/runner/src/executor/workspace.ts:34`) —
  writes the clone's `user.*` and `credential.helper` config, so it is called only for a missing clone.
- `resolveRef(git, repoDir, ref): Promise<RefResult>` (`apps/runner/src/executor/refs.ts:11`).
- `assertSegment`, `assertOwner`, `assertFeature`, `assertRelativePath`, `assertInside`
  (`apps/runner/src/paths/safe-segment.ts`).
- `LogShipping.wake(jobId, leaseEpoch)` (`apps/runner/src/logs/types.ts`); `Now`, `Sleep` (`apps/runner/src/time.ts`).
- nax-agent 0.86.0: `createAgentSession(options)`, `resumeAgentSession(sessionId, options)`, `nativeBackend({ model,
  hostPorts, carryHistoryAcrossModels })`, `createFileTranscriptStore(absDir)`, `redactSecrets(text)`,
  `AgentSessionError` with `code` (`AGENT_SESSION_NOT_FOUND`, `AGENT_SESSION_EXISTS`, `AGENT_SESSION_AUTH_REQUIRED`,
  `AGENT_SESSION_BACKEND_UNAVAILABLE`, `AGENT_SESSION_INVALID_OPTIONS`), `AgentSession`, `EmbedderTool` (`name`,
  `description`, `inputSchema`, `approval`, `run(input, ctx)` → `{ content, isError? }`), `SessionEvent`
  (`turn_start`, `text_delta { round, text }`, `thinking_delta { round, text }`, `stream_reset { round, attempt }`,
  `tool_call`, `tool_result`, `approval_requested`, `approval_resolved`, `question`, `usage`, `compaction`, `turn_end
  { status, output, error? }`), and `CredentialsConfig` (`configDir()`, `readAuthConfig()`). nax-agent also exports a
  `nativeTierProviders`; this feature's helper has another name.
- `ThreadAssign`, `ThreadBackend`, `ThreadSkillSource`, `THREAD_LIMITS` (`packages/fleet-protocol/src/threads.ts`,
  from B1).
- Test helpers: `isolateGit()` and the git fixture (`apps/runner/test/helpers/git-fixture.ts`), `tmp.ts`,
  `manual-clock.ts`.

Mutated symbols. **The baseline exists only to locate the code; implement the target.**

| Symbol | Baseline | Target |
|---|---|---|
| `packages/fleet-protocol/src/threads.ts` | B1 contract | gains `THREAD_STREAM`, `THREAD_STREAM_LIMITS`, `THREAD_MODEL_ID_RE`, `ThreadCloseReason`, `ThreadFailReason`, `ThreadRunnerLine` (below); `THREAD_LIMITS` and `FLEET_PROTOCOL_VERSION` (3) unchanged |
| `TUNING` (`apps/runner/src/daemon/tuning.ts`) | 24 keys | gains `threadIdleMs: 900_000`, `threadWakeGapMs: 250`, `threadSearchTimeoutMs: 10_000`, `threadSkillFetchTimeoutMs: 120_000` |
| `apps/runner/package.json` | no nax-agent | `dependencies` gains `"@nathapp/nax-agent": "0.86.0"` (exact; `bun.lock` updated) |

### Protocol additions (`packages/fleet-protocol/src/threads.ts`)

```ts
/** The log stream a THREAD job writes (PUT /fleet/runner/jobs/:jobId/logs/thread). */
export const THREAD_STREAM = 'thread' as const;
export const THREAD_STREAM_LIMITS = { lineMaxBytes: 65_536, streamMaxBytes: 209_715_200 } as const;
/** Same rule as the API's MODEL_ID_RE (apps/api/src/fleet/common/thread-jobs.ts). */
export const THREAD_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@-]{0,127}$/;

export type ThreadCloseReason = 'idle' | 'closed' | 'cost_cap' | 'stream_cap' | 'cancelled';
export type ThreadFailReason = 'backend_unavailable' | 'agent_not_logged_in' | 'model_unknown' | 'skill_fetch_failed' | 'worktree_conflict' | 'session_error';

/** Lines the runner writes itself. Every other line of the stream is a nax-agent SessionEvent serialized as JSON. */
export type ThreadRunnerLine =
  | { type: 'session_started'; at: string; resumed: boolean; backend: ThreadBackend; skillShas: string[] }
  | { type: 'session_closed'; at: string; reason: ThreadCloseReason }
  | { type: 'input_consumed'; at: string; messageId: string }
  | { type: 'session_failed'; at: string; reason: ThreadFailReason };
```

Stream contract (for B2): one JSON object per line, UTF-8, `\n`-terminated; a line's size is the byte length of its
serialized JSON plus the newline, at most `THREAD_STREAM_LIMITS.lineMaxBytes`. Session lines keep nax-agent's
`SessionEvent` fields (`type`, `sessionId`, `turnId`, `at`, `metadata`, body), in the order the session produced them.
`text_delta.text`, `thinking_delta.text`, `turn_end.output` and `turn_end.error.message` are redacted as below;
`tool_call.input`, `tool_result.preview`, `question.text` and approval summaries carry nax-agent's own best-effort
redaction. A `text_delta` too long for one line becomes several `text_delta` lines with the same `turnId` and `round`,
in order. A `turn_end` too long for one line is written with `output: ""` and `outputTruncated: true`. Any other
session line too long for one line is dropped and reported through the writer's `onWarn`. `stream_reset` lines are
written.

### Paths, native models and nax credentials (US-001)

Paths (`apps/runner/src/thread/thread-paths.ts`): `threadDirFor(homeDir, threadId)` = `<homeDir>/threads/<threadId>`
(`threadId` through `assertSegment`), with `threadWorktreeDir`, `threadTranscriptDir` and `threadMetaPath` for its
children `wt`, `transcript` and `thread.json`; `skillCacheDirFor(skillsRoot, sourceId, sha)` =
`<skillsRoot>/<sourceId>/<sha>`.

`readNativeModels(naxHome, available: ReadonlySet<string>): Promise<NativeModelSet>`
(`apps/runner/src/thread/native-models.ts`), `NativeModelSet = { models: string[]; defaultModel: string | null }`.
It reads `<naxHome>/config.json`; a missing, unreadable or non-JSON file, or no `models.native` object, gives
`{ models: [], defaultModel: null }`. Each value of `models.native` is a model string or an object with a string
`model`. The bare id is the model string with a trailing `[...]` removed; its provider is the text before its first
`/`. A tier is kept when its bare id contains a `/`, matches `THREAD_MODEL_ID_RE`, and its provider is in `available`.
`models` keeps the tiers' order, without duplicates, at most `THREAD_LIMITS.maxNativeModels`. `defaultModel` is the
`balanced` tier's bare id when kept, else `models[0]`, else null. `nativeModelProviders(naxHome): Promise<string[]>`
returns the distinct providers of those tiers, sorted, so B3b can ask `nax auth list` for them (a provider with only
an ambient credential is listed only when asked for).

`naxCredentialsConfig(naxHome): CredentialsConfig` (`apps/runner/src/thread/nax-credentials.ts`) returns
`{ configDir: () => naxHome, readAuthConfig }`; `readAuthConfig` re-reads `<naxHome>/config.json` on every call and
returns its `auth` block when it is `{ source: 'file' | 'exec', exec?: { command: string[]; timeoutMs: number },
onChange: 'warn' | 'refuse' }`, else `{ source: 'file', onChange: 'warn' }`.

### Repo tools (US-002)

`ThreadToolContext = { worktree: string; skillsRoot: string; skills: ThreadSkillSource[]; git: Git;
searchTimeoutMs: number; nowMs: () => number }` (`apps/runner/src/thread/tools/types.ts`). A refused call returns
`{ content: <reason>, isError: true }`; every tool has `approval: 'never'`.

- `listFilesTool(ctx)` → `list_files({ dir?, glob? })` (`tools/list-files.ts`): `git ls-files -z` in the worktree
  with one pathspec: `:(glob)<dir>/<glob>` when both are given, `:(glob)<dir>/**` for `dir` alone, `:(glob)<glob>` for
  `glob` alone, none for neither. `dir` passes `assertRelativePath`; `glob` matches
  `/^[A-Za-z0-9._*?\/\[\]{},-]{1,200}$/` and holds no `..`; a failing value is refused. Content: one path per line;
  above 2000 entries, the first 2000 and a last line `[truncated: <n> more]`; at most 262144 bytes (a cut list ends
  with `[truncated]`).
- `searchRepoTool(ctx)` → `search_repo({ pattern, glob?, max?, fixed? })` (`tools/search-repo.ts`): `pattern` 1..1000
  characters; `glob` the `list_files` rule; `max` an integer 1..200, default 200; another value of either is refused.
  `git -c core.quotePath=false grep -n -I --no-color` with `-F` when `fixed` is true, else `-E`, then `-e <pattern>`,
  then `-- :(glob)<glob>` when given; `env` `GIT_CONFIG_NOSYSTEM=1`; `timeoutMs` `searchTimeoutMs`. Exit 0: hit lines
  `path:line:text`, at most `max` lines and at most 65536 bytes, a cut list ending with `[truncated]`. Exit 1: content
  `no matches`, no `isError`. Any other result: when `nowMs()` after the call is at least `searchTimeoutMs` past
  `nowMs()` before it, `isError` with content `search timed out`; else `isError` with git's first stderr line.

### Skill fetch and cache (US-003)

`ensureSkills({ skills, skillsRoot, git, timeoutMs, origin?, maxTreeBytes? }): Promise<{ ok: true } | { ok: false;
reason: 'skill_fetch_failed' }>` (`apps/runner/src/thread/skill-fetch.ts`). `skillsRoot` is
`<RunnerHome.dir>/skills`; `origin` defaults to `https://github.com` (tests pass a `file://` origin); `maxTreeBytes`
defaults to 52428800. First every source is validated: `sourceId` `assertSegment`, `owner` `assertOwner`, `repo`
`assertSegment`, `sha` `/^[0-9a-f]{40}$/`, each skill `dir` `assertRelativePath`; a failure returns
`skill_fetch_failed` before any git call. Then for each source, `skillCacheDirFor(...)` holding a `.koda-complete`
marker is reused and its mtime set to now. Otherwise, in a sibling temporary directory: `git init`; `git -c
credential.helper= -c core.hooksPath=/dev/null fetch --depth 1 --no-recurse-submodules <origin>/<owner>/<repo>
<sha>`; `git checkout --detach <sha>`; every call with `env` `{ GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }`
and `timeoutMs`; then the `.git` directory is deleted, the tree's total file size is checked against `maxTreeBytes`
(after the fetch, not during it), the marker is written, and the directory is renamed into place (a target that
appeared meanwhile wins; the temporary directory is deleted). Any failure deletes the temporary directory and returns
`skill_fetch_failed`.

`pruneSkillCache(skillsRoot, now, maxAgeDays = 30)` deletes `<sourceId>/<sha>` directories whose mtime is more than
`maxAgeDays` days before `now`.

### Skill tools and the tool set (US-004)

- `loadSkillTool(ctx)` → `load_skill({ name })` (`tools/load-skill.ts`): `name` must be a skill of `ctx.skills` (the
  first source listing it, in snapshot order), else `isError` with content `unknown skill <name>; available: <names,
  comma-separated>`. Returns the text of `<skill directory>/SKILL.md` under the `read_skill_file` file rules.
- `readSkillFileTool(ctx)` → `read_skill_file({ name, relPath })` (`tools/read-skill-file.ts`): `relPath` passes
  `assertRelativePath`; the file's realpath is inside the skill directory's realpath; a symbolic link (`lstat`) is
  refused; above 262144 bytes is refused; a NUL byte or invalid UTF-8 is refused as binary. Each refusal is `isError`
  with a reason naming the rule.
- `buildThreadTools(ctx): EmbedderTool[]` (`tools/index.ts`) returns, in order, `list_files`, `search_repo`,
  `load_skill`, `read_skill_file`.

### Thread workspace (US-005)

`prepareThreadWorktree({ git, mutex, repoKey, repoDir, cloneUrl, identity, credentialHelper, homeDir, threadId,
baseRef, feature }): Promise<{ ok: true; worktree: string; tipSha: string } | { ok: false; reason: string }>`
(`apps/runner/src/thread/thread-worktree.ts`); `feature` passes `assertFeature`. In order:

1. Clone missing (no `<repoDir>/.git`): acquire `mutex` for `repoKey`, check again, `ensureClone(...)`, release.
   Clone present: neither the mutex nor `ensureClone`.
2. `git fetch origin` in `repoDir` with `credentialHelper` passed on the command; a failure whose stderr contains
   `cannot lock ref` or `unable to lock` is retried once.
3. Tip: `refs/heads/feat/<feature>` when it exists in the clone, else `resolveRef(git, repoDir, baseRef)`; not found
   → `checkout: ref not found`; invalid → `checkout: invalid ref`.
4. Write `thread.json` `{ repoDir }` (before the worktree exists, so a crash never leaves a registration prune cannot
   find).
5. `git worktree list --porcelain`; an entry matches when `realpath(dirname(entry)) + '/' + basename(entry)` equals
   the same form of `wt` (a deleted directory cannot be realpathed itself):
   - registered and directory present → `git checkout --detach <tipSha>` inside it; git refusing →
     `worktree_conflict`;
   - registered and directory missing → `git worktree remove --force --force <wt>`, then add as below;
   - not registered → remove any leftover directory, then `git worktree add --detach --lock --reason koda-thread <wt>
     <tipSha>`.

Other git failures map through `reasonFromError`.

`pruneArchivedThreads({ git, homeDir, threadIds, activeThreadIds })` handles each id not in `activeThreadIds` (an id
that fails `assertSegment` is skipped): it reads `thread.json`, and when `repoDir` is an absolute path with a `.git`
it runs `git worktree remove --force --force <wt>` there (a failure ignored); then it deletes the thread directory.

### Session factory (US-006)

`ThreadSessionFactory` (`apps/runner/src/thread/session-factory.ts`), constructed with `{ homeDir, naxHome,
nativeModels: () => Promise<NativeModelSet>, agent? }`; `agent` defaults to nax-agent's `{ createAgentSession,
resumeAgentSession, nativeBackend, createFileTranscriptStore }`. `open({ jobId, thread: ThreadAssign, worktree, tools,
approvalTimeoutSec }): Promise<{ ok: true; session: AgentSession; resumed: boolean } | { ok: false; reason:
ThreadFailReason }>`:

1. `backend.kind === 'acp'` → `backend_unavailable` (B3-R9); nothing else is called.
2. Model: `backend.model ?? defaultModel`; null, not in `models`, or a `backend.effort` that fails `/^[a-z]{1,16}$/`
   → `model_unknown`.
3. `threadId` must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/` (nax-agent's session id rule), else `session_error`.
4. `backend = nativeBackend({ model: effort ? '<model>[<effort>]' : model, carryHistoryAcrossModels: true, hostPorts: {
   protectedPaths: { gitExcludePathspecs: [], gitIgnorePatterns: [], credentialDir: naxHome } } })`.
5. Options: `backend`, `profile: 'read'` (no input changes it), `workdir: worktree`, `instructions:
   thread.instructions`, `tools`, `transcriptStore: createFileTranscriptStore(threadTranscriptDir(homeDir,
   threadId))`, `approvalTimeoutMs` = `approvalTimeoutSec * 1000` clamped to 30000..3600000, `turnTimeoutSeconds: 900`,
   `metadata: { threadId, jobId }`.
6. `resume: false` → `createAgentSession({ ...options, sessionId: threadId })`; `AGENT_SESSION_EXISTS` →
   `resumeAgentSession(threadId, options)`, `resumed: true`. `resume: true` → `resumeAgentSession(threadId, options)`;
   `AGENT_SESSION_NOT_FOUND` (runner home wiped) → `createAgentSession`, `resumed: false`.
7. Errors from steps 4-6 (including a throw from `nativeBackend`): `AGENT_SESSION_AUTH_REQUIRED` →
   `agent_not_logged_in`; `AGENT_SESSION_BACKEND_UNAVAILABLE` → `backend_unavailable`; any other → `session_error`.

### Event writer (US-007)

`new ThreadEventWriter({ path, jobId, leaseEpoch, logs, wakeGapMs, now, sleep, streamMaxBytes?, onCap, onWarn })`
(`apps/runner/src/thread/thread-event-writer.ts`); `path` is the stream file, created with mode 0600 if absent and
appended to otherwise; `streamMaxBytes` defaults to `THREAD_STREAM_LIMITS.streamMaxBytes`; `bytes()` is the file's
size. Methods, all returning `void`: `event(e: SessionEvent)`, `started({ resumed, backend, skillShas })`,
`inputConsumed(messageId)`, `closed(reason)`, `failed(reason)`, `flush()`.

- Held delta text (B3-R11): `text_delta` text is appended to a raw buffer keyed by `(turnId, round)`. After each
  append, the writable prefix ends at the last whitespace character that sits at least 256 characters before the
  buffer's end (none → nothing is written yet, unless the buffer passes 4096 characters, when the prefix is all but
  its last 256 characters). The prefix is passed through `redactSecrets` and written as `text_delta` lines; the rest
  stays raw. The held text is written, redacted, before any other session line (a `text_delta` of another round,
  `tool_call`, `tool_result`, `usage`, `turn_end` and the rest), and on `flush()`; a `stream_reset` of the round drops
  it and is then written.
- `thinking_delta.text`, `turn_end.output` and `turn_end.error.message` are each passed through `redactSecrets` whole.
  Splitting into lines happens after redaction.
- Wake: after each append `logs.wake(jobId, leaseEpoch)`, at most once per `wakeGapMs`, plus one trailing wake after
  the gap for appends inside it.
- Cap: before each session line, `bytes() + lineBytes > streamMaxBytes - 4096` → that line and the rest of its event
  are not written and `onCap()` is called (once per writer); runner lines (`started`, `inputConsumed`, `closed`,
  `failed`) are always written.

### Failure Handling

| Case | Behaviour | Story |
|---|---|---|
| nax `config.json` missing or invalid | no native models, no default; default auth config | US-001 |
| Path outside the worktree, bad `glob` | `isError` with the rule | US-002 |
| Search runs past its timeout | `isError` `search timed out` | US-002 |
| No search match | content `no matches`, not an error | US-002 |
| Invalid server-supplied skill identifier | `skill_fetch_failed`, no git call | US-003 |
| Skill fetch fails or the tree is too large | `skill_fetch_failed`, no cache directory left | US-003 |
| Unknown skill, path escape, symlink, binary or oversized skill file | `isError` with the rule | US-004 |
| Base ref missing | `checkout: ref not found` | US-005 |
| git refuses the worktree checkout | `worktree_conflict` | US-005 |
| Worktree registered but its directory is gone | registration removed, worktree re-added | US-005 |
| Fetch loses a ref-lock race | retried once | US-005 |
| git authentication fails on fetch | `git auth failed` (`reasonFromError`) | US-005 |
| ACP backend | `backend_unavailable` | US-006 |
| Model unknown, or unset with no default | `model_unknown` | US-006 |
| Provider not logged in | `agent_not_logged_in` | US-006 |
| Transcript missing on resume | fresh session, `resumed: false` | US-006 |
| Transcript already exists for a first session | resumed, `resumed: true` | US-006 |
| Secret split across deltas | redacted from the held raw text | US-007 |
| Session line longer than one line | `text_delta` split; `turn_end` truncated; others dropped with `onWarn` | US-007 |
| Stream reaches its cap | rest of the event not written, `onCap` once | US-007 |

## Out of Scope

- Wiring these blocks into the daemon (protocol v4, `THREAD` ASSIGN parsing, the `threadBackends` capability report,
  the thread job run, thread commands, Supervisor READOPT and ABANDON for `THREAD` rows, free slots, the heartbeat,
  `configureCredentials`, registering the `thread` stream with `LogShipper`, running `pruneArchivedThreads` and
  `pruneSkillCache`) belongs to feature `fleet-s5a-thread-host` (B3b).
- The API accepting and folding the `thread` stream, and an API parity test pinning `THREAD_MODEL_ID_RE` to the API's
  `MODEL_ID_RE`, belong to feature `fleet-s5a-thread-ingest` (B2).
- `write_doc`, Publish, untracked docs in `list_files` and `search_repo`, a stale session start and Discard belong to
  phase C.
- ACP session backends belong to phase D.
- A runtime nax-agent version-floor constant is not added (B3-R3); raising the pin is a manual dependency change.
- A secret that contains whitespace (a PEM block, a cookie line) or is longer than the 256-character hold-back can
  still be cut between two written `text_delta` lines; `turn_end.output` is redacted whole.
- `tool_call.input`, `tool_result.preview`, `question.text` and approval summaries rely on nax-agent's best-effort
  redaction; this feature adds none.
- `search_repo` reads git's whole stdout before capping it; output size is bounded only by the search timeout.
- Compiling the runner binary (`bun run build:binary`) with nax-agent has no acceptance criterion; the 2026-10-11
  probe compiled and loaded nax-agent 0.85.1 in a `bun build --compile` binary.
- US-001 only: `threadDirFor` and the other path helpers are exercised through US-005 and US-006 without a dedicated
  acceptance criterion; so is an `auth` block that is present but invalid.
- US-002 only: `list_files` with `dir` and `glob` together, its 262144-byte cap and symlinked entries, a `pattern` or
  `max` outside its range, and git failures other than no-match and timeout share the tool rules without a dedicated
  acceptance criterion.
- US-003 only: two jobs fetching the same skill SHA at once are resolved by the rename rule without a dedicated
  acceptance criterion; so is `GIT_LFS_SKIP_SMUDGE`.
- US-004 only: `load_skill` file rules are the `read_skill_file` rules, and a skill name listed by two sources resolves
  to the first; neither has a dedicated acceptance criterion; neither does invalid UTF-8.
- US-005 only: `git auth failed`, `checkout: invalid ref`, the ref-lock retry and a leftover unregistered `wt`
  directory share `reasonFromError`, `resolveRef` and the worktree rules without a dedicated acceptance criterion; so
  does `pruneArchivedThreads` skipping a bad id or a `thread.json` whose `repoDir` is not a clone.
- US-006 only: the `AGENT_SESSION_BACKEND_UNAVAILABLE`, invalid session id and generic `session_error` mappings,
  `instructions`, `approvalTimeoutMs`, `metadata`, `turnTimeoutSeconds` and `hostPorts` share the option building
  without a dedicated acceptance criterion.
- US-007 only: the leading wake, `flush()`, `failed()`, the 4096-character forced cut and the drop of an oversized
  non-delta line share the writer rules without a dedicated acceptance criterion.

## Stories

1. **US-001: Thread protocol constants, paths, native models and nax credentials** — `Workdir: apps/runner` — no
   dependencies.
2. **US-002: Repo tools `list_files` and `search_repo`** — `Workdir: apps/runner` — depends on US-001.
3. **US-003: Skill fetch and cache** — `Workdir: apps/runner` — depends on US-001.
4. **US-004: Skill tools and the tool set** — `Workdir: apps/runner` — depends on US-002, US-003.
5. **US-005: Thread worktree and archived prune** — `Workdir: apps/runner` — depends on US-001.
6. **US-006: Session factory** — `Workdir: apps/runner` — depends on US-001.
7. **US-007: Thread event writer** — `Workdir: apps/runner` — depends on US-001.

US-001 also edits `packages/fleet-protocol/src/threads.ts`. Build gate for every story: `bun run type-check` and
`bun run lint` in `apps/runner`; US-001 also `bun run type-check` at the repo root.

### Context Files

> Existing files to read or change, or files an upstream dependency creates (annotated).

**US-001**

- `packages/fleet-protocol/src/threads.ts` — gains the stream constants, the model id rule and the line types
- `apps/runner/src/daemon/tuning.ts` — gains the four thread keys
- `apps/runner/package.json` — gains `@nathapp/nax-agent` 0.86.0
- `apps/runner/src/paths/safe-segment.ts` — `assertSegment` for the path helpers

**US-002**

- `apps/runner/src/executor/git.ts` — `Git.run` and its options
- `apps/runner/src/paths/safe-segment.ts` — `assertRelativePath`
- `apps/runner/test/helpers/git-fixture.ts` — real temp repositories

**US-003**

- `apps/runner/src/thread/thread-paths.ts` — created by US-001, `skillCacheDirFor`
- `apps/runner/src/paths/safe-segment.ts` — `assertSegment`, `assertOwner`, `assertRelativePath`
- `apps/runner/test/helpers/git-fixture.ts` — a `file://` skill origin

**US-004**

- `apps/runner/src/thread/tools/types.ts` — created by US-002, `ThreadToolContext`
- `apps/runner/src/thread/tools/list-files.ts` — created by US-002, part of the tool set
- `apps/runner/src/thread/tools/search-repo.ts` — created by US-002, part of the tool set
- `apps/runner/src/thread/thread-paths.ts` — created by US-001, `skillCacheDirFor`

**US-005**

- `apps/runner/src/executor/workspace.ts` — `ensureClone`
- `apps/runner/src/executor/refs.ts` — `resolveRef`
- `apps/runner/src/supervisor/repo-mutex.ts` — `RepoMutex`
- `apps/runner/src/thread/thread-paths.ts` — created by US-001, the thread directory layout

**US-006**

- `apps/runner/src/thread/native-models.ts` — created by US-001, `NativeModelSet`
- `apps/runner/src/thread/thread-paths.ts` — created by US-001, `threadTranscriptDir`
- `apps/runner/src/config/runner-config.ts` — `RunnerHome.dir`, `naxHome`

**US-007**

- `apps/runner/src/logs/types.ts` — `LogShipping.wake`
- `apps/runner/test/helpers/manual-clock.ts` — manual clock for wake pacing

### Creates

> New files each story authors.

**US-001**

- `apps/runner/src/thread/thread-paths.ts` — `threadDirFor`, `threadWorktreeDir`, `threadTranscriptDir`, `threadMetaPath`, `skillCacheDirFor`
- `apps/runner/src/thread/native-models.ts` — `readNativeModels`, `nativeModelProviders`, `NativeModelSet`
- `apps/runner/src/thread/nax-credentials.ts` — `naxCredentialsConfig`
- `apps/runner/src/thread/thread-kit-foundation.spec.ts` — protocol constants, native models, credentials config

**US-002**

- `apps/runner/src/thread/tools/types.ts` — `ThreadToolContext`
- `apps/runner/src/thread/tools/list-files.ts` — `listFilesTool`
- `apps/runner/src/thread/tools/search-repo.ts` — `searchRepoTool`
- `apps/runner/test/unit/thread-repo-tools.spec.ts` — both tools on real temp git repositories

**US-003**

- `apps/runner/src/thread/skill-fetch.ts` — `ensureSkills`, `pruneSkillCache`
- `apps/runner/test/unit/thread-skill-fetch.spec.ts` — fetch from a `file://` origin, cache, validation, prune

**US-004**

- `apps/runner/src/thread/tools/load-skill.ts` — `loadSkillTool`
- `apps/runner/src/thread/tools/read-skill-file.ts` — `readSkillFileTool`
- `apps/runner/src/thread/tools/index.ts` — `buildThreadTools`
- `apps/runner/src/thread/tools/skill-tools.spec.ts` — skill file jails and the tool set over a prepared skill directory

**US-005**

- `apps/runner/src/thread/thread-worktree.ts` — `prepareThreadWorktree`, `pruneArchivedThreads`
- `apps/runner/test/unit/thread-worktree.spec.ts` — worktree cases on real temp git repositories

**US-006**

- `apps/runner/src/thread/session-factory.ts` — `ThreadSessionFactory`
- `apps/runner/src/thread/session-factory.spec.ts` — option building and error mapping over fake agent functions

**US-007**

- `apps/runner/src/thread/thread-event-writer.ts` — `ThreadEventWriter`
- `apps/runner/src/thread/thread-event-writer.spec.ts` — redaction, ordering, splitting, cap, wake pacing

### Modifies

**US-001**

- `apps/runner/src/daemon/tuning.spec.ts` — the exact `TUNING` object gains `threadIdleMs: 900_000`, `threadWakeGapMs: 250`, `threadSearchTimeoutMs: 10_000` and `threadSkillFetchTimeoutMs: 120_000`, because this story adds the thread timing constants; it stays frozen.
- `bun.lock` — gains `@nathapp/nax-agent` 0.86.0 and its dependencies, because this story adds the runner dependency.

**US-002**

None. The tools are new files.

**US-003**

None. The skill fetcher is a new file.

**US-004**

None. The skill tools and `tools/index.ts` are new files.

**US-005**

None. The worktree code is a new file.

**US-006**

None. The factory is a new file.

**US-007**

None. The writer is a new file.

### Seams

- US-002, US-003 → US-004: `listFilesTool` and `searchRepoTool` are returned by `buildThreadTools` (US-004 AC-8);
  the skill tools read the directory layout `ensureSkills` produces (US-004 AC-1).
- US-001 → US-006: `NativeModelSet.defaultModel` is the model `open` uses when the backend has none (US-006 AC-8).
- Every exported block is consumed by B3b `fleet-s5a-thread-host`, whose thread-job seams enter through
  `CommandHandler.handle`; this feature has no production caller by design.

## Acceptance Criteria

### US-001: Thread protocol constants, paths, native models and nax credentials

- AC-1 [unit] `THREAD_STREAM_LIMITS` imported from `@nathapp/fleet-protocol` equals `{ lineMaxBytes: 65536,
  streamMaxBytes: 209715200 }`.
- AC-2 [unit] `THREAD_MODEL_ID_RE` imported from `@nathapp/fleet-protocol` accepts `'minimax/MiniMax-M3'`.
- AC-3 [unit] `THREAD_MODEL_ID_RE` imported from `@nathapp/fleet-protocol` rejects
  `'opencode-go/deepseek-v4.1-flash[high]'`.
- AC-4 [unit] `readNativeModels` over a `config.json` with `models.native` `{ fast: 'minimax/MiniMax-M2.7', balanced:
  { model: 'minimax/MiniMax-M3' }, powerful: 'opencode-go/deepseek-v4.1-flash[high]' }` and `available` `{ 'minimax'
  }` returns `models` `['minimax/MiniMax-M2.7', 'minimax/MiniMax-M3']`.
- AC-5 [unit] `readNativeModels` over the AC-4 config with `available` `{ 'minimax' }` returns `defaultModel`
  `'minimax/MiniMax-M3'`.
- AC-6 [unit] `readNativeModels` over the AC-4 config with `available` `{ 'opencode-go' }` returns `models`
  `['opencode-go/deepseek-v4.1-flash']`.
- AC-7 [unit] `readNativeModels` over the AC-4 config with `available` `{ 'opencode-go' }` returns `defaultModel`
  `'opencode-go/deepseek-v4.1-flash'`.
- AC-8 [unit] `readNativeModels` with no `config.json` in `naxHome` returns `{ models: [], defaultModel: null }`.
- AC-9 [unit] `readNativeModels` over a `config.json` that is not valid JSON returns `{ models: [], defaultModel:
  null }`.
- AC-10 [unit] `readNativeModels` over a `config.json` whose two tiers name the same bare id returns `models` holding
  that id once.
- AC-11 [unit] `readNativeModels` over a `config.json` whose only tier is `'MiniMax-M3'` (no `/`) with `available` `{
  'MiniMax-M3' }` returns `models` `[]`.
- AC-12 [unit] `nativeModelProviders` over the AC-4 config returns `['minimax', 'opencode-go']`.
- AC-13 [unit] `naxCredentialsConfig(naxHome).readAuthConfig()` with no `config.json` in `naxHome` resolves to `{
  source: 'file', onChange: 'warn' }`.
- AC-14 [unit] `naxCredentialsConfig(naxHome).readAuthConfig()` with a `config.json` whose `auth` is `{ source: 'file',
  onChange: 'refuse' }` resolves to `{ source: 'file', onChange: 'refuse' }`.
- AC-15 [unit] `naxCredentialsConfig(naxHome).readAuthConfig()` called again after `config.json`'s `auth.onChange`
  changes from `'warn'` to `'refuse'` resolves to `onChange` `'refuse'`.

### US-002: Repo tools `list_files` and `search_repo`

- AC-1 [unit] `listFilesTool(ctx).run({})` in a temp repository with tracked `a.ts`, untracked `b.ts` and ignored
  `c.log` returns content whose lines are exactly `['a.ts']`.
- AC-2 [unit] `listFilesTool(ctx).run({ dir: 'src' })` with tracked `src/x.ts` and `docs/y.md` returns content whose
  lines are exactly `['src/x.ts']`.
- AC-3 [unit] `listFilesTool(ctx).run({ glob: '**/*.md' })` with tracked `src/x.ts` and `docs/y.md` returns content
  whose lines are exactly `['docs/y.md']`.
- AC-4 [unit] `listFilesTool(ctx).run({ dir: '../outside' })` returns `isError` `true`.
- AC-5 [unit] `listFilesTool(ctx).run({ glob: 'src/../..' })` returns `isError` `true`.
- AC-6 [unit] `listFilesTool(ctx).run({})` with 2005 tracked files returns 2001 lines whose last is `[truncated: 5
  more]`.
- AC-7 [unit] `searchRepoTool(ctx).run({ pattern: 'needle' })` with tracked `src/a.ts` holding `needle` on line 3
  returns content whose first line starts with `src/a.ts:3:`.
- AC-8 [unit] `searchRepoTool(ctx).run({ pattern: 'a.b', fixed: true })` with tracked lines `a.b` and `axb` returns
  exactly one hit line.
- AC-9 [unit] `searchRepoTool(ctx).run({ pattern: 'x', max: 5 })` with 20 matching lines returns exactly 5 hit lines
  followed by `[truncated]`.
- AC-10 [unit] `searchRepoTool(ctx).run({ pattern: 'x' })` with 300 matching lines returns exactly 200 hit lines
  followed by `[truncated]`.
- AC-11 [unit] `searchRepoTool(ctx).run({ pattern: 'x' })` with 150 matching lines of 1000 characters returns content
  of at most 65536 bytes.
- AC-12 [unit] `searchRepoTool(ctx).run({ pattern: 'x' })` with 150 matching lines of 1000 characters returns content
  whose last line is `[truncated]`.
- AC-13 [unit] `searchRepoTool(ctx).run({ pattern: 'absent' })` with no match returns content `no matches` and
  `isError` not `true`.
- AC-14 [unit] `searchRepoTool(ctx).run({ pattern: 'x' })` whose `ctx.git.run` resolves `{ code: 137 }` while
  `ctx.nowMs` advances by `searchTimeoutMs` returns `isError` `true` with content `search timed out`.
- AC-15 [unit] `searchRepoTool(ctx).run({ pattern: 'needle' })` where only a tracked binary file contains `needle`
  returns content `no matches`.

### US-003: Skill fetch and cache

- AC-1 [unit] `ensureSkills` with one source at a SHA of a `file://` origin repository returns `{ ok: true }`.
- AC-2 [unit] After `ensureSkills` with one source, `<skillsRoot>/<sourceId>/<sha>/<dir>/SKILL.md` exists.
- AC-3 [unit] `ensureSkills` run a second time for the same source makes no `git.run` call whose arguments include
  `fetch`.
- AC-4 [unit] `ensureSkills` run a second time for a source whose cache directory's mtime was set 10 days back sets
  that mtime to the current time.
- AC-5 [unit] `ensureSkills` calls `git.run` for `fetch` with `env.GIT_TERMINAL_PROMPT` `'0'`.
- AC-6 [unit] `ensureSkills` calls `git.run` for `fetch` with arguments that include `credential.helper=` after a
  `-c`.
- AC-7 [unit] After `ensureSkills`, `<skillsRoot>/<sourceId>/<sha>/.git` does not exist.
- AC-8 [unit] `ensureSkills` with a SHA the origin does not have returns `{ ok: false, reason: 'skill_fetch_failed'
  }`.
- AC-9 [unit] After `ensureSkills` with a SHA the origin does not have, `<skillsRoot>/<sourceId>` holds no entry.
- AC-10 [unit] `ensureSkills` with `maxTreeBytes` 10 over a skill tree larger than 10 bytes returns `{ ok: false,
  reason: 'skill_fetch_failed' }`.
- AC-11 [unit] `ensureSkills` with a source whose `sha` is `'--upload-pack=x'` returns `{ ok: false, reason:
  'skill_fetch_failed' }` without any `git.run` call.
- AC-12 [unit] `ensureSkills` with a source whose skill `dir` is `'../escape'` returns `{ ok: false, reason:
  'skill_fetch_failed' }` without any `git.run` call.
- AC-13 [unit] `pruneSkillCache(skillsRoot, now)` deletes a `<sourceId>/<sha>` directory whose mtime is 31 days
  before `now`.
- AC-14 [unit] `pruneSkillCache(skillsRoot, now)` keeps a `<sourceId>/<sha>` directory whose mtime is 1 day before
  `now`.

### US-004: Skill tools and the tool set

Each criterion runs over a skill directory laid out as `ensureSkills` leaves it (`<skillsRoot>/<sourceId>/<sha>/<dir>`).

- AC-1 [unit] `loadSkillTool(ctx).run({ name: 'spec-writing' })` returns content equal to that skill's `SKILL.md`.
- AC-2 [unit] `loadSkillTool(ctx).run({ name: 'missing' })` returns `isError` `true` with content that names every
  skill of `ctx.skills`.
- AC-3 [unit] `readSkillFileTool(ctx).run({ name, relPath: 'references/guide.md' })` returns content equal to that
  file's text.
- AC-4 [unit] `readSkillFileTool(ctx).run({ name, relPath: '../other/SKILL.md' })` returns `isError` `true`.
- AC-5 [unit] `readSkillFileTool(ctx).run(...)` on a symbolic link inside the skill directory returns `isError`
  `true`.
- AC-6 [unit] `readSkillFileTool(ctx).run(...)` on a file containing a NUL byte returns `isError` `true`.
- AC-7 [unit] `readSkillFileTool(ctx).run(...)` on a 262145-byte text file returns `isError` `true`.
- AC-8 [unit] `buildThreadTools(ctx)` returns tools whose names are, in order, `list_files`, `search_repo`,
  `load_skill`, `read_skill_file`.
- AC-9 [unit] Every tool `buildThreadTools(ctx)` returns has `approval` `'never'`.

### US-005: Thread worktree and archived prune

- AC-1 [unit] `prepareThreadWorktree` over a temp clone without `feat/<feature>` returns `ok: true` with `tipSha`
  equal to the sha of `origin/<baseRef>`.
- AC-2 [unit] After `prepareThreadWorktree`, `git worktree list --porcelain` in the clone marks the `wt` entry
  `locked`.
- AC-3 [unit] After `prepareThreadWorktree`, `git symbolic-ref -q HEAD` in the worktree exits non-zero.
- AC-4 [unit] `prepareThreadWorktree` over a temp clone whose local `refs/heads/feat/<feature>` exists returns
  `tipSha` equal to that branch's sha.
- AC-5 [unit] A second `prepareThreadWorktree` after `origin/<baseRef>` moved returns `tipSha` equal to the new sha.
- AC-6 [unit] After a second `prepareThreadWorktree` with a moved `origin/<baseRef>`, the worktree's `HEAD` equals the
  new sha.
- AC-7 [unit] `prepareThreadWorktree` with a `wt` registered as a worktree but deleted from disk returns `ok: true`.
- AC-8 [unit] `prepareThreadWorktree` with a `baseRef` the clone does not have returns `{ ok: false, reason:
  'checkout: ref not found' }`.
- AC-9 [unit] `prepareThreadWorktree` whose worktree holds an untracked file that the new tip tracks with other
  content returns `{ ok: false, reason: 'worktree_conflict' }`.
- AC-10 [unit] `prepareThreadWorktree` over an existing clone never calls `mutex.acquire`.
- AC-11 [unit] `prepareThreadWorktree` without a clone calls `mutex.acquire` with its `repoKey`.
- AC-12 [unit] `prepareThreadWorktree` with a `credentialHelper` over an existing clone leaves the clone's `git config
  --get-all credential.helper` output unchanged.
- AC-13 [unit] `pruneArchivedThreads` with `threadIds` `['t1']` and empty `activeThreadIds` deletes
  `<homeDir>/threads/t1`.
- AC-14 [unit] After `pruneArchivedThreads` with `threadIds` `['t1']` and empty `activeThreadIds`, `git worktree list
  --porcelain` in the clone lists no entry for `t1`'s `wt`.
- AC-15 [unit] `pruneArchivedThreads` with `threadIds` `['t1']` and `activeThreadIds` `['t1']` keeps
  `<homeDir>/threads/t1`.

### US-006: Session factory

- AC-1 [unit] `ThreadSessionFactory.open` with `resume: false` calls the injected `createAgentSession` with `profile`
  `'read'`.
- AC-2 [unit] `ThreadSessionFactory.open` with `resume: true` calls the injected `resumeAgentSession` with `profile`
  `'read'`.
- AC-3 [unit] `ThreadSessionFactory.open` calls `createAgentSession` with `workdir` equal to the given `worktree`.
- AC-4 [unit] `ThreadSessionFactory.open` calls the injected `createFileTranscriptStore` with
  `<homeDir>/threads/<threadId>/transcript`.
- AC-5 [unit] `ThreadSessionFactory.open` with `resume: false` calls `createAgentSession` with `sessionId` equal to
  the thread's `threadId`.
- AC-6 [unit] `ThreadSessionFactory.open` calls `createAgentSession` with `backend` equal to the value the injected
  `nativeBackend` returned.
- AC-7 [unit] `ThreadSessionFactory.open` with backend `{ kind: 'native', model: 'm/x', effort: 'high' }` and `m/x` in
  `models` calls the injected `nativeBackend` with `model` `'m/x[high]'`.
- AC-8 [unit] `ThreadSessionFactory.open` with backend `{ kind: 'native' }` and `defaultModel` `'m/b'` calls
  `nativeBackend` with `model` `'m/b'`.
- AC-9 [unit] `ThreadSessionFactory.open` calls `nativeBackend` with `carryHistoryAcrossModels` `true`.
- AC-10 [unit] `ThreadSessionFactory.open` with backend model `'m/z'` not in `models` returns `{ ok: false, reason:
  'model_unknown' }` without calling `createAgentSession`.
- AC-11 [unit] `ThreadSessionFactory.open` with backend `{ kind: 'native' }` and `defaultModel` `null` returns `{ ok:
  false, reason: 'model_unknown' }`.
- AC-12 [unit] `ThreadSessionFactory.open` with backend `{ kind: 'acp', agent: 'claude' }` returns `{ ok: false,
  reason: 'backend_unavailable' }` without calling `nativeBackend`.
- AC-13 [unit] `ThreadSessionFactory.open` with `resume: true` whose `resumeAgentSession` throws an
  `AgentSessionError` with code `AGENT_SESSION_NOT_FOUND` returns `ok: true` with `resumed` `false`.
- AC-14 [unit] `ThreadSessionFactory.open` with `resume: false` whose `createAgentSession` throws an
  `AgentSessionError` with code `AGENT_SESSION_EXISTS` returns `ok: true` with `resumed` `true`.
- AC-15 [unit] `ThreadSessionFactory.open` whose `createAgentSession` throws an `AgentSessionError` with code
  `AGENT_SESSION_AUTH_REQUIRED` returns `{ ok: false, reason: 'agent_not_logged_in' }`.

### US-007: Thread event writer

- AC-1 [unit] `ThreadEventWriter.event` given two `text_delta` events of one round, `'key: '` plus the first half of
  an Anthropic-style API key and then its second half, then that turn's `turn_end`, writes `text_delta` lines whose
  texts joined in file order equal nax-agent `redactSecrets` of the whole text.
- AC-2 [unit] `ThreadEventWriter.event` given one `text_delta` of 1000 characters made of 9-letter words separated by
  single spaces writes `text_delta` lines whose texts joined are a prefix of the original ending in a space and at
  most 744 characters long, before any further event.
- AC-3 [unit] `ThreadEventWriter.event` given a `text_delta` of 100 characters, then a `tool_call` of the same turn,
  writes the line carrying those 100 characters before the `tool_call` line.
- AC-4 [unit] `ThreadEventWriter.event` given a `stream_reset` of a round after a 100-character `text_delta` of that
  round writes no line carrying those 100 characters.
- AC-5 [unit] `ThreadEventWriter.event` given a `turn_end` whose `output` contains an Anthropic-style API key writes
  a line whose `output` equals nax-agent `redactSecrets` of that output.
- AC-6 [unit] `ThreadEventWriter.event` given a `turn_end` whose `error.message` contains an Anthropic-style API key
  writes a line whose `error.message` equals nax-agent `redactSecrets` of that message.
- AC-7 [unit] `ThreadEventWriter.event` given a `thinking_delta` whose `text` contains an Anthropic-style API key
  writes a line whose `text` equals nax-agent `redactSecrets` of that text.
- AC-8 [unit] `ThreadEventWriter.event` given a 200000-character `text_delta` of words containing the character `é`,
  then its `turn_end`, writes only lines whose UTF-8 byte length including the newline is at most 65536.
- AC-9 [unit] `ThreadEventWriter.event` given a 200000-character `text_delta` of words separated by spaces, then its
  `turn_end`, writes `text_delta` lines whose texts joined in file order equal the original text.
- AC-10 [unit] `ThreadEventWriter.event` given a `turn_end` whose `output` is 100000 characters writes one `turn_end`
  line with `output` `""` and `outputTruncated` `true`.
- AC-11 [unit] `ThreadEventWriter.started({ resumed: false, backend: { kind: 'native', model: 'm/x' }, skillShas:
  ['<sha>'] })` writes a line whose object deep-equals `{ type: 'session_started', at: <now ISO>, resumed: false,
  backend: { kind: 'native', model: 'm/x' }, skillShas: ['<sha>'] }`.
- AC-12 [unit] `ThreadEventWriter.inputConsumed('msg1')` writes a line whose object deep-equals `{ type:
  'input_consumed', at: <now ISO>, messageId: 'msg1' }`.
- AC-13 [unit] Ten `ThreadEventWriter.event` calls with `thinking_delta` events within one `wakeGapMs` on a manual
  clock, followed by advancing the clock past `wakeGapMs`, call `logs.wake` exactly twice.
- AC-14 [unit] A `ThreadEventWriter` with `streamMaxBytes` 8192 over a pre-seeded 4200-byte stream file, given two
  `thinking_delta` events of 100 characters, writes neither line and calls `onCap` exactly once.
- AC-15 [unit] A `ThreadEventWriter` with `streamMaxBytes` 8192 over a pre-seeded 4200-byte stream file writes the
  `session_closed` line of `closed('stream_cap')`.
