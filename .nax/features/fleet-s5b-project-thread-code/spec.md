# SPEC: Fleet S5b-1c-b — PROJECT threads read the project's code

## Summary

A PROJECT thread's agent can read the code of every GitHub fleet repository of its project. The API lists the
project's repositories in the session's ASSIGN and mints a read-only GitHub App token (contents read, metadata read)
per repository on request. The runner keeps one shallow bare mirror per repository (`<home>/project-code/<repoId>.git`),
fetches each listed repository's default-branch tip at session start, pins the tip sha for the whole session, and
gives the agent four tools that read git objects at the pinned sha: `list_repos`, `list_files`, `search_repo`,
`read_file`. Nothing is checked out. A runner that does not advertise the new `projectCode` capability keeps today's
code-less PROJECT session, and the web shows a notice.

This is feature 3b of fleet S5b (S5b-R15). Umbrella design:
`docs/superpowers/specs/2026-10-15-fleet-s5b-koda-assistant-design.md` (§2 S5b-R15, §10 row 3b). Features 1
(`fleet-s5b-project-threads`), 2 (`fleet-s5b-koda-read-core`) and 3a (`fleet-s5b-koda-knowledge-core`) are merged.
Later: 3c `fleet-s5b-koda-knowledge-index`, then 1d, 2a, 2b, 3.

## Motivation

A PROJECT thread is where a user brainstorms across the project, but its agent cannot see any code: the runner gives
it an empty scratch directory and only the skill and koda tools (`apps/runner/src/thread/thread-job-run.ts:369-415`,
`apps/runner/src/thread/tools/index.ts:15`), and its instructions tell it "You have no repository"
(`apps/api/src/fleet/threads/thread-instructions.ts:45`). A question such as "where is the token broker and how does
it cache?" needs a REPO thread on one repository, so cross-repository questions cannot be answered at all. S5b-R15
revised S5b-R13: PROJECT threads read code, read-only, from every fleet repository of the project.

## Design

### Rulings that bind every story

User, 2026-10-15 (S5b-R15) and 2026-10-16 (this brainstorm):

- S5b-R15: a PROJECT thread reads every fleet repository of its project at its default branch, read-only, with a
  read-only brokered token, through the REPO thread's read tools; there is no `write_doc`. A `projectCode` capability
  gates it. The anchor repository still decides placement and budget keys. WORKSPACE threads never clone.
- 1c-b-R1 (bare mirror, no checkout): the runner keeps one shallow bare mirror per repository, shared by every thread
  on the runner, and the tools read git objects at the sha pinned when the session started. No worktree, no checkout,
  no shared working files.
- 1c-b-R2 (GitHub only): only GitHub repositories with an App installation are read. GitLab repositories, and GitHub
  repositories without an installation, are listed as unavailable. GitLab read-only access is deferred.
- 1c-b-R3 (`list_repos` tool): the pinned repositories and shas reach the agent through a `list_repos` tool, not
  through the instructions. The instructions text stays independent of the runner.
- 1c-b-R4 (cap and degrade): at most 10 repositories are fetchable per session (`PROJECT_CODE_LIMITS.maxRepos`).
  Placement does not require `projectCode`; a session on a runner without it has no code tools and the web shows a
  notice, as for `kodaTools`.
- 1c-b-R5 (partial failure): a repository whose token or fetch fails is unavailable for that session; the session
  still starts with the rest. A session whose every repository failed starts with the skill and koda tools only.

### Decisions grounded in the code (this spec)

- 1c-b-D1 (protocol, additive): `@nathapp/fleet-protocol` gains, in `packages/fleet-protocol/src/threads.ts`,
  `ProjectRepoAssign { repoId: string; owner: string; name: string; defaultBranch: string; cloneUrl: string }`,
  `ProjectRepoUnavailable { owner: string; name: string; reason: 'not a GitHub repository' | 'no installation' | 'limit' }`,
  `PROJECT_CODE_LIMITS = { maxRepos: 10, maxUnavailable: 50 } as const`, and `ThreadAssign` gains the optional
  `projectRepos?: ProjectRepoAssign[]` and `projectReposUnavailable?: ProjectRepoUnavailable[]`. In
  `packages/fleet-protocol/src/index.ts`, `TokenRequest`, `GitToken` and `GitTokenError` gain an optional
  `repoId?: string`, and `RunnerCapabilities` gains `projectCode?: true`. The runner's `parseAssign` accepts a
  `projectRepos` entry only when `repoId` passes `assertSegment` and is at most 64 characters, `owner` passes
  `assertOwner`, `name` passes `assertSegment`, `defaultBranch` is a non-empty string of at most 255 characters (the
  rule `parseAssign` applies to `repo.defaultBranch`), and `cloneUrl` parses as a URL whose protocol is `https:`
  (stricter than `assertCloneUrl`, which also accepts `http:` and `file:`); a `projectReposUnavailable` entry needs an
  `owner` passing `assertOwner`, a `name` passing `assertSegment` and one of the three reasons. `FLEET_PROTOCOL_VERSION` is unchanged: every
  field is optional and an older peer ignores it. The API reads the package with `import type` only
  (`apps/api/src/fleet/common/protocol.spec.ts:36-41`), so `PROJECT_CODE_LIMITS` is mirrored as a runtime constant in
  `apps/api/src/fleet/common/thread-jobs.ts`, as `THREAD_LIMITS` is (`:24`), and a spec pins the two equal.
- 1c-b-D2 (capability): `parseCapabilitiesCore` (`apps/api/src/fleet/common/capabilities-core.ts:118-165`) accepts
  `projectCode` exactly as `kodaTools`: absent or `true`, anything else fails with reason `projectCode`, and only `true`
  is kept. The runner's `NaxCapabilityProbe` (`apps/runner/src/capabilities/nax-probe.ts:165-174`) reports
  `projectCode: true` next to `kodaTools: true`. The runner already refuses to start on git older than 2.30
  (`assertMinGitVersion`, `apps/runner/src/daemon/daemon.ts:102`), which covers every git command this feature runs,
  so the probe adds no version check. `StaticCapabilityProbe` is unchanged (it reports no thread capabilities).
- 1c-b-D3 (read-only mint): `GitHubAppClient` gains
  `mintReadOnlyToken(installationId: bigint, repoName: string): Promise<{ token: string; expiresAt: Date }>`, which
  posts to the same `access_tokens` endpoint as `mintInstallationToken` (`github-app-client.ts:61-72`) with
  `repositories: [repoName]` and `permissions: { contents: 'read', metadata: 'read' }`, and maps the response exactly
  as `mintInstallationToken` does (404 `app_not_installed`, 403/422 `app_permissions_insufficient`, other non-201 or a
  malformed body `provider_error`). `mintInstallationToken` is unchanged.
- 1c-b-D4 (broker): `GitTokenBroker.mint` (`git-token.broker.ts:30-45`) takes
  `{ jobId; leaseEpoch; repo; readOnly?: boolean }`. With `readOnly: true` the cache key is
  `${jobId}:${leaseEpoch}:ro:${repo.id}`, `fresh` calls `mintReadOnlyToken` for a GitHub repository, throws
  `RepoCheckException('app_not_installed')` when `githubInstallationId` is null, and throws
  `RepoCheckException('provider_error')` for any other provider; the returned `GitToken` and any `GitTokenError` carry
  `repoId: repo.id`. Without `readOnly` the key, the mint and the result are as today. `evict(jobId)` already drops every
  key starting `${jobId}:`, so it drops read-only entries too.
- 1c-b-D5 (token fence): there is no stored record of which repositories an ASSIGN listed (`FleetCommand.payload` is
  written once; `grantTokens` reads only the job row, `apps/api/src/fleet/sync/sync.service.ts:112-141`). The fence
  therefore recomputes the scope. `grantTokens`'s request type gains `repoId?: string`. A request with `repoId` passes
  today's checks first, unchanged (unknown job -> `unknownJobIds`; fence not held -> `FenceService.abandon`; state not in
  `RUNNER_HELD_STATES` -> `job_not_active`, with `repoId` echoed on the error). It is then granted only when also
  (a) `job.command` is `THREAD`, (b) a new `IFleetJobRepository.findThreadTokenScope(jobId): Promise<{ kind: 'REPO' | 'PROJECT'; action: string } | null>`
  resolves kind `PROJECT` and action `SESSION`, and (c) the request's `repoId` is one of
  `fetchableProjectRepos(await findProjectRepos(job.projectId))` (1c-b-D7), the same walk the ASSIGN used, so a
  repository the ASSIGN listed as unavailable (GitLab, no installation, beyond the cap) or a repository of another
  project is never granted. Any failure of (a)-(c) answers a `GitTokenError`
  `{ jobId, repoId, reason: 'repo_not_assigned' }` and mints nothing. Granted requests mint through
  `broker.mint({ jobId, leaseEpoch, repo, readOnly: true })`, `repo` being the matching `FleetRepoRef` from that list,
  outside the transaction, as today. The public entry point
  is `SyncService.sync(runnerId, raw)` (`sync.service.ts:54`), which calls `grantTokens` at `:96`.
- 1c-b-D6 (sync parser): `parseTokenRequest` (`apps/api/src/fleet/sync/sync-request.parser.ts:58-61`) keeps `repoId`
  when it is a string of 1 to 64 characters and fails with reason `tokenRequest` for any other present value. A request
  without `repoId` is exactly as today. The 64-request cap (`SYNC_LIMITS.tokenRequests`) is unchanged.
- 1c-b-D7 (ASSIGN repositories): `apps/api/src/fleet/jobs/project-repos-assign.ts` exports two pure functions.
  `fetchableProjectRepos(repos: readonly FleetRepoRef[]): FleetRepoRef[]` returns, in input order, the GitHub
  repositories with a non-null `githubInstallationId`, at most `PROJECT_CODE_LIMITS.maxRepos` of them.
  `withProjectRepos(thread: ThreadAssign, repos: readonly FleetRepoRef[], vcs: { githubApiUrl: string; gitlabApiUrl: string }): ThreadAssign`
  builds `projectRepos` from `fetchableProjectRepos(repos)` and walks `repos` in the given order: a non-GitHub repository is unavailable `not a GitHub repository`; a GitHub
  repository with a null `githubInstallationId` is unavailable `no installation`; any other repository is added to
  `projectRepos` as `{ repoId, owner, name, defaultBranch, cloneUrl: cloneUrlFor(repo, vcs) }` until `projectRepos`
  holds `PROJECT_CODE_LIMITS.maxRepos` entries, and each later one is unavailable `limit`. `projectReposUnavailable`
  keeps its first `PROJECT_CODE_LIMITS.maxUnavailable` entries. It returns the thread with both arrays set (possibly
  empty). `PlacementService.assign` (`apps/api/src/fleet/jobs/placement.service.ts:189-202`, private; reached from the
  public `placeJob(jobId)` at `:62`) applies it after `withKodaTools` only when the thread's `kind` is `PROJECT`, its
  `action` is `SESSION` and the runner's `capabilities.projectCode === true`; only then does it call a new
  `IFleetJobRepository.findProjectRepos(projectId): Promise<FleetRepoRef[]>` with `job.projectId`, ordered by
  `createdAt` ascending then `id` ascending (the anchor order, `apps/api/src/fleet/repos/prisma-fleet-repo.repository.ts:37-40`)
  and bounded by `take: PROJECT_CODE_LIMITS.maxRepos + PROJECT_CODE_LIMITS.maxUnavailable` (60; rule api-data).
  `vcs` is the `vcsConfig` `PlacementService` already injects (`:44`).
- 1c-b-D8 (session notice): `PrismaThreadIngestRepository` records `projectCodeUnavailableOn: <runner name>` in the
  stored session on `session_started` when the thread's kind, read in that branch with
  `chatThread.findUnique({ where: { id: threadId }, select: { kind: true } })` (`ChatThread.kind`, default `REPO`), is `PROJECT` and the hosting runner's capabilities lack
  `projectCode: true`, beside `kodaToolsUnavailableOn` (`prisma-thread-ingest.repository.ts:419-433, 472-480`), and
  keeps it on close or failure under the same rule as `kodaToolsUnavailableOn` (`:442-448`). A REPO thread never gets
  it. The field joins `StoredSession`, the domain session type (`chat-thread.domain.ts:50-51`) and the `session` schema
  in `thread.dto.ts:27`. The thread GET routes pass the stored session through unchanged.
- 1c-b-D9 (instructions): the line of `buildProjectThreadInstructions` after the role line and any brief lines (`thread-instructions.ts:45`) becomes:
  `Ask one question at a time. You have no shell and no web access. You read the project's code only through list_repos, list_files, search_repo and read_file when they are available (read-only, pinned at session start); cite code as owner/name:path@sha7 and never claim facts about code you have not read.`
  The role line and `KODA_TOOLS_LINE` are unchanged. REPO instructions are unchanged.
- 1c-b-D10 (runner tokens per repository): `TokenCache` (`apps/runner/src/credentials/token-cache.ts`) keys an entry
  by `${jobId}:${leaseEpoch}` without a repository and `${jobId}:${leaseEpoch}:${repoId}` with one; `want`, `wanted`,
  `drop` and `state` gain an optional last parameter `repoId?: string`. `requests` keeps the highest epoch per
  `(jobId, repoId)`, includes `repoId` in each request that has one, and orders the requests it returns: every entry
  without `repoId` first, then repository entries in the order they were first wanted; it still returns at most
  `MAX_TOKEN_REQUESTS` (64), and the rest wait for a later sync. `apply` matches a token or error to the requested
  entry by `(jobId, repoId)`, building its request-epoch lookup keyed by `(jobId, repoId)` as well. `buildSyncRequest` (`apps/runner/src/sync/batch.ts:74`) keeps `repoId` when present.
  Entries without `repoId` behave exactly as today.
- 1c-b-D11 (runner credentials per repository): `CredentialBroker` (`apps/runner/src/credentials/broker.ts`)
  implements a new interface `RepoCredentialProvider { acquireRepo(job: JobRow, repo: { repoId: string; cloneUrl: string }, options: AcquireOptions): Promise<AcquireResult>; releaseRepo(job: JobRow, repoId: string): Promise<void> }`.
  `acquireRepo` works as `acquire` but calls `tokens.want(jobId, leaseEpoch, repoId)`, serves a socket at
  `socketPathFor(socketDir, runnerId, jobId, leaseEpoch, repoId)` whose reply reads `wanted` and `state` with that
  `repoId` and answers only for the protocol and host of `repo.cloneUrl`, writes no `gh`/`glab` shims, and returns
  `binDir: null`; a wait that ends without a token returns the same reasons `acquire` does (`git token: <reason>`,
  `git token: timeout`, `cancelled`). The broker records each acquired `repoId` per `(jobId, leaseEpoch)`.
  `releaseRepo` drops that token, closes that socket and forgets the record; `release(job)` also releases every
  recorded repository of the job. `socketPathFor` (`apps/runner/src/credentials/socket-dir.ts:21-24`) hashes
  `${runnerId}:${jobId}:${leaseEpoch}` as today, and `${runnerId}:${jobId}:${leaseEpoch}:${repoId}` when `repoId` is
  given (sha256, first 16 hex characters, `.sock`). `ThreadHostDeps` (`thread-job-run.ts:67-88`) gains the optional
  `repoCredentials?: RepoCredentialProvider`; the daemon passes the broker (`daemon.ts:180-191`). Without it a PROJECT
  session runs as today.
- 1c-b-D12 (mirror store): a new `apps/runner/src/thread/project-code/mirror-store.ts` exports
  `projectCodeDirFor(homeDir: string, repoId: string): string` (`<homeDir>/project-code/<repoId>.git`, `repoId` passed
  through `assertSegment`) and
  `refreshMirror(input: { git: Git; mutex: Pick<RepoMutex, 'acquire'>; homeDir: string; repo: ProjectRepoAssign; credentialHelper: string | null; timeoutMs: number; nowMs: () => number; allowFileProtocol?: boolean }): Promise<{ ok: true; sha: string } | { ok: false; reason: 'fetch timeout' | 'fetch failed' }>`.
  Under `mutex.acquire('project-code:' + repoId)` (a key no job uses, so it never waits on a RUN job) it creates the
  directory with `git init --bare -q` when absent, runs
  `git -c core.hooksPath=/dev/null -c gc.auto=0 -c protocol.file.allow=<never|always> fetch --depth 1 --no-tags --no-recurse-submodules <cloneUrl> +refs/heads/<defaultBranch>:refs/koda/tip`
  with `cwd` the mirror, `env { GIT_CONFIG_NOSYSTEM: '1' }`, the helper and `timeoutMs`, then reads
  `git rev-parse refs/koda/tip`, records the pin with `git update-ref refs/koda/pins/<pinId> <sha>`, writes the
  current time to `<mirror>/koda-last-used`, and returns the sha. The input gains `pinId: string` (the job id, passed
  through `assertSegment`).
  `protocol.file.allow` is `always` only when `allowFileProtocol` is true, which only tests pass. A non-zero fetch
  whose elapsed time by `nowMs` is at least `timeoutMs` answers `fetch timeout` (the rule `search-repo.ts:44` uses);
  any other non-zero exit answers `fetch failed`. Every pinned sha stays reachable from its pin ref, so neither a newer
  fetch nor `git gc` removes the objects a live session reads.
- 1c-b-D13 (code tools): a new `apps/runner/src/thread/project-code/code-tools.ts` exports
  `buildProjectCodeTools(ctx: ProjectCodeToolContext): EmbedderTool[]` returning, in this order, `list_repos`,
  `list_files`, `search_repo`, `read_file`, with
  `ProjectCodeToolContext { pins: readonly ProjectCodePin[]; unavailable: readonly { repo: string; reason: string }[]; git: Git; searchTimeoutMs: number; nowMs: () => number }`
  and `ProjectCodePin { repo: string; sha: string; gitDir: string }` (`repo` is `owner/name`). Every tool has
  `approval: 'never'` and runs through `refuseInvalidInput` (`apps/runner/src/thread/tools/shared.ts:33`). Every git
  call uses `cwd: pin.gitDir`, `env { GIT_CONFIG_NOSYSTEM: '1' }` and `timeoutMs: searchTimeoutMs`. A `repo` that names
  no pin answers the error result `unknown repo`.
  - `list_repos {}`: one line per pin, `owner/name @ <sha first 7>`, then one line per unavailable entry,
    `owner/name unavailable (<reason>)`. With neither: `no repositories`.
  - `list_files { repo, dir?, glob? }`: `git ls-tree -r -z --name-only <sha>`; `dir` (checked with
    `assertRelativePath`) keeps paths under `dir/`; `glob` (checked with `checkGlob`) keeps paths that
    `new Bun.Glob(glob).match(path)` accepts; at most 2000 entries plus `[truncated: N more]`, then
    `joinCapped(lines, 262144, false)`, as `list-files.ts` does.
  - `search_repo { repo?, pattern, fixed?, glob?, max? }`: `pattern`, `fixed`, `max` and `glob` are checked as
    `search-repo.ts` checks them; runs
    `git -c core.quotePath=false grep -n -I --no-color (-F|-E) -e <pattern> <sha> [-- :(glob)<glob>]` on the named pin,
    or on every pin in pin order when `repo` is absent; exit 1 is no match. Each hit line `<sha>:<path>:<line>:<text>`
    is emitted as `owner/name:<path>:<line>:<text>`. Hits are capped at `max` (default 200, at most 200) in total and
    joined with `joinCapped(lines, 65536, total > max)` where `total` is the number of hits found before the cap; no hit answers `no matches`; a search whose elapsed time reaches
    `searchTimeoutMs` answers the error result `search timed out`.
  - `read_file { repo, path, startLine?, endLine? }`: `path` checked with `assertRelativePath`; `startLine` and
    `endLine` integers of at least 1 with `endLine >= startLine` (else `invalid lines`), `startLine` defaulting to 1;
    `git ls-tree -z <sha> -- <path>` printing no entry answers `not found`, and an entry whose type is not `blob` or
    whose mode is `120000` (a symlink) answers `not a file`; the content is read with `git cat-file blob <sha>:<path>`, and content that holds a NUL character in
    its first 8000 characters answers `binary file`. With `n` lines, a `startLine` above `n` answers `invalid lines`
    (for an empty file, any `startLine` above 1 does). The result is the header `owner/name:<path>@<sha7> lines <a>-<b> of <n>` followed by lines
    `a` to `b` (default the whole file, `b` clamped to `n`; an empty file gives `lines 0-0 of 0` and no lines),
    header and lines together joined with `joinCapped([header, ...lines], 65536, false)`.
- 1c-b-D14 (session start): `ThreadJobRun.runProject` (`thread-job-run.ts:369-415`), after `setUpSkills`, when
  `thread.projectRepos` is present and `deps.host.repoCredentials` is set:
  1. calls `repoCredentials.acquireRepo(row, { repoId, cloneUrl }, { wait: true, isCancelled })` for every listed
     repository concurrently, so every token is wanted before any wait, with `isCancelled` polling the cancel request
     and a halt as the REPO path does (`:275`);
  2. refreshes the repositories that got credentials, at most 3 at a time (`PROJECT_CODE_FETCH_CONCURRENCY = 3`),
     each through `deps.host.refreshMirror ?? refreshMirror` with `mutex: this.deps.mutex` (the run's existing
     `ThreadRunDeps.mutex`, `thread-job-run.ts:119-122`), `pinId` the job id, its own helper and
     `timeoutMs = tuning.projectCodeFetchTimeoutMs ?? 120000`;
  3. calls `releaseRepo` for every acquired repository whatever the fetch returned;
  4. builds the pins (`gitDir` = `projectCodeDirFor`) and the unavailable list: each failed repository with reason
     `token: <acquire reason>`, `fetch timeout` or `fetch failed`, followed by `thread.projectReposUnavailable`
     mapped to `{ repo: owner/name, reason }`;
  5. opens the session with `buildProjectThreadTools(...)`, then `buildProjectCodeTools(...)`, then the koda proxies.
  A halt during steps 1-3 releases the acquired repositories and ends with no transition; a cancel request during
  steps 1-3 releases them and ends the run `CANCELLED` with `cancelled before start`. Without `projectRepos`, or
  without `repoCredentials`, the run is exactly as today. `ThreadHostDeps` gains the optional
  `refreshMirror?: typeof refreshMirror` (tests inject a stub, as `prepareWorktree` is injected today) and
  `ThreadRunTuning` gains the optional `projectCodeFetchTimeoutMs?: number`. A PROJECT session with repositories is
  the one THREAD run that takes the repo mutex (only under `project-code:` keys); the comment at
  `thread-job-run.ts:115-117` is updated to say so.
- 1c-b-D15 (mirror prune): a new `pruneProjectCode(input: { homeDir: string; git: Git; mutex: Pick<RepoMutex, 'acquire'>; nowMs: number; ttlMs: number; activeJobIds: ReadonlySet<string> }): Promise<void>`
  in `apps/runner/src/thread/project-code/mirror-prune.ts` visits every `<homeDir>/project-code/<repoId>.git`
  directory under `mutex.acquire('project-code:' + repoId)` and, holding it: deletes each `refs/koda/pins/<pinId>`
  whose `pinId` is not in `activeJobIds`; then, when no pin ref is left and the mirror's `koda-last-used` time (or,
  when that file is missing, the directory's mtime) is older than `ttlMs`, deletes the mirror; otherwise runs
  `git gc --prune=now -q` in it, which keeps every object a remaining pin reaches. The daemon's `pruneThreadAssets`
  (`daemon.ts:137-148`) calls it with `activeJobIds` the ids of the active journal jobs whose `command` is `THREAD`,
  the daemon's single `RepoMutex`, and `ttlMs` from `tuning.projectCodeMirrorTtlMs` (default 14 days). A failure is
  logged as a warning `project code prune failed` and does not stop the thread prune. The daemon creates that one
  `RepoMutex` before `pruneThreadAssets` is defined (today it is created inline at `daemon.ts:193`) and passes the
  same instance to the `Supervisor`, which hands it to every `ThreadJobRun` as `ThreadRunDeps.mutex`, so refresh and
  prune exclude each other.
- 1c-b-D16 (web notice): `apps/web/lib/thread-handoff.ts` gains
  `showProjectCodeNotice(thread: ThreadDetailDto): boolean` (true when `thread.session?.state === 'live'` and
  `projectCodeUnavailableOn` is set), and a new `ThreadProjectCodeNotice.vue`, mounted on
  `pages/[project]/threads/[id].vue` next to `ThreadKodaToolsNotice`, renders
  `fleet.threads.projectCode.unavailable` with `{ runner }` (en: `project code is unavailable on runner {runner}; this session cannot read the project's repositories.`,
  zh: `此运行器 {runner} 上无法读取项目代码；此会话无法读取项目的代码仓库。`). `ThreadSession`
  (`apps/web/lib/thread-types.ts:48-60`) gains `projectCodeUnavailableOn?: string`.

### Integration

Read-only symbols (verified on main `07a2c205`):

- `IFleetJobRepository.findRepo(repoId): Promise<FleetRepoRef | null>` and `lockById(id)`
  (`apps/api/src/fleet/jobs/domain/fleet-job.domain.ts:214-240`); `FleetRepoRef` (`:196-203`) has `id`, `projectId`,
  `provider: 'github' | 'gitlab'`, `owner`, `name`, `defaultBranch`, `githubInstallationId: bigint | null`.
- `FenceService.holds` / `abandon` (`apps/api/src/fleet/sync/fence.service.ts:16-33`), `RUNNER_HELD_STATES`
  (`apps/api/src/fleet/jobs/job-state.ts:10`).
- `cloneUrlFor(repo, cfg)` (`apps/api/src/fleet/git-broker/clone-url.ts:10`).
- `RepoCheckException(reason)` (`apps/api/src/fleet/git-broker/repo-check.exception.ts:19-23`).
- `PlacementService.placeJob(jobId)` (`placement.service.ts:62`) and `withKodaTools` (`:211-214`).
- `Git` (`apps/runner/src/executor/git.ts:26-29`): `run(args, { cwd, timeoutMs?, env?, credentialHelper? })` resolves
  `{ code, stdout, stderr }`; stdin is always ignored.
- `RepoMutex.acquire(key): Promise<() => void>` (`apps/runner/src/supervisor/repo-mutex.ts:5`); `ThreadRunDeps.mutex`
  (`thread-job-run.ts:119-122`).
- `assertSegment`, `assertRelativePath` (`apps/runner/src/paths/safe-segment.ts:14,35`); `checkGlob`, `joinCapped`,
  `refused`, `refuseInvalidInput`, `fieldOf`, `InvalidToolInput` (`apps/runner/src/thread/tools/shared.ts`).
- `helperValue(self, sock)` (`apps/runner/src/credentials/job-files.ts:11-13`), `CredentialServer.listen`
  (`cred-server.ts:56`), `ensureSocketDir` (`socket-dir.ts:30`).
- Runner test helpers `isolateGit`, `git`, `makeOrigin`, `pushCommit` (`apps/runner/test/helpers/git-fixture.ts`) and
  `makeTempDirs` (`test/helpers/tmp.ts`); `test/unit/thread-job-run-project.spec.ts` builds the fake host.

Symbols this feature changes. The baseline only locates the code; implement the target.

- `TokenRequest` / `GitToken` / `GitTokenError` (`packages/fleet-protocol/src/index.ts:217,264,265`)
  - Baseline: `{ jobId; leaseEpoch }`, `{ jobId; token; expiresAt; username }`, `{ jobId; reason }`.
  - Target: each gains `repoId?: string`.
- `ThreadAssign` (`packages/fleet-protocol/src/threads.ts:43-59`): target gains `projectRepos?: ProjectRepoAssign[]`
  and `projectReposUnavailable?: ProjectRepoUnavailable[]`.
- `RunnerCapabilities` (`packages/fleet-protocol/src/index.ts:64-86`): target gains `projectCode?: true`.
- `GitTokenBroker.mint` (`apps/api/src/fleet/git-broker/git-token.broker.ts:30`)
  - Baseline: `mint(req: { jobId; leaseEpoch; repo }, now?)`.
  - Target: `mint(req: { jobId; leaseEpoch; repo; readOnly?: boolean }, now?)` (1c-b-D4).
- `SyncService.grantTokens` (`apps/api/src/fleet/sync/sync.service.ts:112`)
  - Baseline: `grantTokens(runnerId, requests: ReadonlyArray<{ jobId; leaseEpoch }>, now)`.
  - Target: `requests: ReadonlyArray<{ jobId; leaseEpoch; repoId?: string }>`, applying 1c-b-D5.
- `TokenCache.want` / `wanted` / `drop` / `state` (`apps/runner/src/credentials/token-cache.ts:51,58,62,68`)
  - Baseline: `(jobId, leaseEpoch)` and `state(jobId, leaseEpoch, nowMs)`.
  - Target: `(jobId, leaseEpoch, repoId?)` and `state(jobId, leaseEpoch, nowMs, repoId?)`.
- `socketPathFor` (`apps/runner/src/credentials/socket-dir.ts:21`)
  - Baseline: `socketPathFor(dir, runnerId, jobId, leaseEpoch)`.
  - Target: `socketPathFor(dir, runnerId, jobId, leaseEpoch, repoId?)`; without `repoId` the path is unchanged.
- `ThreadHostDeps` (`apps/runner/src/thread/thread-job-run.ts:67-88`): target gains the optional
  `repoCredentials?: RepoCredentialProvider` and `refreshMirror?: typeof refreshMirror`.
- `ThreadRunTuning` (`thread-job-run.ts:90-108`): target gains the optional `projectCodeFetchTimeoutMs?: number`.
- `Tuning` interface (`apps/runner/src/daemon/tuning.ts`) and the frozen `TUNING` object (`:57`): target gain
  `projectCodeFetchTimeoutMs: 120_000` and `projectCodeMirrorTtlMs: 1_209_600_000`.

### Failure Handling

| Case | Behaviour | Story |
|---|---|---|
| `projectCode` capability present with a value other than `true` | capability report rejected with reason `projectCode` | US-001 |
| Read-only mint answers 404 / 403 or 422 / other or malformed | `app_not_installed` / `app_permissions_insufficient` / `provider_error` | US-001 |
| Read-only mint for a repository with null `githubInstallationId` | `GitTokenError` reason `app_not_installed`, no GitHub call | US-001 |
| Token request `repoId` not a 1-64 character string | sync request rejected with reason `tokenRequest` | US-002 |
| `repoId` request for a non-THREAD job, a REPO thread, a non-SESSION turn, or a repository outside the session's fetchable set (unknown, another project's, GitLab, no installation, beyond the cap) | `GitTokenError` `{ jobId, repoId, reason: 'repo_not_assigned' }`, nothing minted | US-002 |
| `repoId` request whose job is held but not in `RUNNER_HELD_STATES` | `GitTokenError` `{ jobId, repoId, reason: 'job_not_active' }` | US-002 |
| `repoId` request whose fence does not hold | today's ABANDON path, nothing minted | US-002 |
| Runner without `projectCode` hosts a PROJECT session | no `projectRepos` in the ASSIGN; session stores `projectCodeUnavailableOn` | US-003 |
| Repository not GitHub / no installation / beyond 10 | listed in `projectReposUnavailable` with its reason | US-003 |
| ASSIGN `projectRepos` malformed (not an array, over 10 entries, a bad owner, name, branch, clone URL or id) | ASSIGN refused `invalid project repos` | US-004 |
| ASSIGN `projectReposUnavailable` malformed or over 50 entries | ASSIGN refused `invalid project repos` | US-004 |
| More than 64 wanted tokens | entries without `repoId` first, then repository entries in want order; the rest wait | US-004 |
| Tool `repo` not pinned | error result `unknown repo` | US-005 |
| `read_file` path missing / a tree / binary content | error result `not found` / `not a file` / `binary file` | US-005 |
| `read_file` lines invalid or past the end | error result `invalid lines` | US-005 |
| Search past its timeout | error result `search timed out` | US-005 |
| Fetch reaches the timeout / exits non-zero | `fetch timeout` / `fetch failed` | US-006 |
| Mirror prune fails | warning `project code prune failed`; thread prune continues | US-006 |
| Token for a repository refused or not served in time | that repository unavailable `token: <reason>`; session starts | US-007 |
| Every repository fails | session starts with skill and koda tools; `list_repos` lists each as unavailable | US-007 |
| Cancel request during token wait or fetch | repository tokens released; run ends `CANCELLED` | US-007 |
| Halt during token wait or fetch | repository tokens released; run ends with no transition | US-007 |

## Out of Scope

- GitLab repositories are not read by PROJECT threads (1c-b-R2): koda's GitLab access is a stored project token whose scope it cannot narrow, so GitLab read-only access is deferred to a later feature; GitLab repositories are listed as unavailable `not a GitHub repository`.
- WORKSPACE threads never read code (S5b-R13); they are feature S5b-1d.
- A session never re-fetches: the shas pinned at session start hold until the session ends.
- REPO threads are unchanged: they keep their worktree and their five tools, and see no other repository.
- PROJECT threads get no `write_doc`, no Publish, no Plan and no Run.
- Code indexing, embeddings, a reranker and repository docs search are feature S5b-1c-c and later.
- Tool results with code are neither masked nor fenced, as REPO thread tool results are not; code is repository content the project's writers control.
- Code citations (`owner/name:path@sha7`) are not rendered as links in the web.
- RUN, PLAN and REPO thread jobs keep their own clones and never use the mirror store.
- No new placement rule: a PROJECT session may land on a runner without `projectCode` and then has no code tools.
- The sync request's 64-token-request cap is unchanged.
- US-002 only: the read-only token is minted per request and cached per `(job, epoch, repository)`; no cross-job token sharing.
- US-006 only: two runners never share a mirror; each runner keeps its own under its home directory.
- The runner context file `.nax/mono/apps/runner/context.md` ("It never takes the repo mutex") is read-only to the run; it is updated by hand with this spec, not by a story.

## Stories

1. **US-001: Protocol contract, capability and read-only mint** — `Workdir: apps/api` — No dependencies.
2. **US-002: Read-only token fence on sync** — `Workdir: apps/api` — Depends on US-001, US-003.
3. **US-003: PROJECT ASSIGN repositories, session notice and instructions** — `Workdir: apps/api` — Depends on US-001.
4. **US-004: Runner ASSIGN parsing, per-repository tokens and capability** — `Workdir: apps/runner` — Depends on US-001.
5. **US-005: Runner code tools over pinned mirrors** — `Workdir: apps/runner` — Depends on US-001.
6. **US-006: Runner mirror store and prune** — `Workdir: apps/runner` — Depends on US-001.
7. **US-007: Runner PROJECT session start with code** — `Workdir: apps/runner` — Depends on US-004, US-005, US-006.
8. **US-008: Web project-code notice** — `Workdir: apps/web` — Depends on US-003.

Eight stories exceed the soft ceiling of seven: the runner work needs four stories because merging any two of
US-004 to US-007 exceeds 15 acceptance criteria, and US-008 is the only web story. US-001 also edits
`packages/fleet-protocol/src/threads.ts` and `packages/fleet-protocol/src/index.ts`; every change there is additive and
optional (1c-b-D1), so later stories in other packages compile against it. US-003 regenerates `openapi.json` with
`bun run api:export-spec` and the generated clients with `bun run generate` for the session field.

### Context Files

**US-001**

- `apps/api/src/fleet/git-broker/github-app-client.ts` — `mintInstallationToken` at `:61-72`.
- `apps/api/src/fleet/git-broker/git-token.broker.ts` — `mint`, `fresh`, `evict`.
- `apps/api/src/fleet/common/capabilities-core.ts` — `projectThreads` / `kodaTools` parsing at `:118-165`.
- `apps/api/src/fleet/common/thread-jobs.ts` — runtime protocol mirror (`THREAD_LIMITS` at `:24`).
- `apps/api/src/fleet/git-broker/github-app-client.spec.ts` — FakeForge mint test at `:85-94`.

**US-002**

- `apps/api/src/fleet/sync/sync.service.ts` — `sync` at `:54`, `grantTokens` at `:112-141`.
- `apps/api/src/fleet/sync/sync-request.parser.ts` — `parseTokenRequest` at `:58-61`.
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findRepo` at `:42-48`, `findThreadAssign` at `:201-217`.
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `IFleetJobRepository` at `:214`.
- `apps/api/src/fleet/jobs/project-repos-assign.ts` — created by US-003; `fetchableProjectRepos` is used here.

**US-003**

- `apps/api/src/fleet/jobs/placement.service.ts` — `placeJob` at `:62`, `assign` at `:189-202`, `withKodaTools` at `:211-214`.
- `apps/api/src/fleet/jobs/placement.service.koda-tools.spec.ts` — the placement test pattern for a thread ASSIGN.
- `apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.ts` — session start at `:419-433`, notice at `:472-480`.
- `apps/api/src/fleet/threads/thread-instructions.ts` — `buildProjectThreadInstructions` at `:41-49`.
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — gains `findProjectRepos`.

**US-004**

- `apps/runner/src/supervisor/assign-parser.ts` — `cleanKodaTools` at `:96-110`, thread block at `:173-224`.
- `apps/runner/src/credentials/token-cache.ts` — keying, `requests`, `apply`.
- `apps/runner/src/credentials/broker.ts` — `acquire`, `release`, `serve`, `reply`.
- `apps/runner/src/sync/batch.ts` — token request projection at `:74`.
- `apps/runner/src/capabilities/nax-probe.ts` — capability flags at `:165-174`.

**US-005**

- `apps/runner/src/thread/tools/list-files.ts` — caps and output.
- `apps/runner/src/thread/tools/search-repo.ts` — pattern checks, grep flags, timeout rule at `:44`.
- `apps/runner/src/thread/tools/shared.ts` — shared checks and `joinCapped`.
- `apps/runner/src/paths/safe-segment.ts` — `assertRelativePath`.
- `apps/runner/test/helpers/git-fixture.ts` — real-git test fixtures.

**US-006**

- `apps/runner/src/thread/skill-fetch.ts` — the existing `fetch --depth 1` into a fresh repository at `:118`.
- `apps/runner/src/thread/thread-prune.ts` — the thread prune the mirror prune sits beside.
- `apps/runner/src/daemon/daemon.ts` — `pruneThreadAssets` at `:137-148`.
- `apps/runner/test/unit/daemon-thread.spec.ts` — drives the daemon's thread prune.
- `apps/runner/test/helpers/git-fixture.ts` — `makeOrigin`, `pushCommit`.

**US-007**

- `apps/runner/src/thread/thread-job-run.ts` — `runProject` at `:369-415`, REPO credential wait at `:275`.
- `apps/runner/src/thread/project-code/code-tools.ts` — created by US-005, wired here.
- `apps/runner/src/thread/project-code/mirror-store.ts` — created by US-006, wired here.
- `apps/runner/src/daemon/daemon.ts` — thread host at `:180-191`.
- `apps/runner/test/unit/thread-job-run-project.spec.ts` — PROJECT run fake host.
- `apps/runner/test/unit/daemon-thread.spec.ts` — daemon thread host wiring.

**US-008**

- `apps/web/components/fleet/threads/ThreadKodaToolsNotice.vue` — the notice to mirror.
- `apps/web/lib/thread-handoff.ts` — `showKodaToolsNotice` at `:37-39`.
- `apps/web/pages/[project]/threads/[id].vue` — notice mount at `:89-91`.
- `apps/web/tests/pages/threads-detail-page.spec.ts` — mounts the thread page (US-008 AC 6 pattern).
- `apps/web/tests/components/thread-koda-tools-notice.spec.ts` — the test pattern.

### Creates

**US-002**

- `apps/api/src/fleet/sync/sync-token-fence.spec.ts` — unit tests of the `repoId` fence through `SyncService.sync` over a stubbed repository, fence and broker.

**US-003**

- `apps/api/src/fleet/jobs/project-repos-assign.ts` — `withProjectRepos`.
- `apps/api/src/fleet/jobs/project-repos-assign.spec.ts` — its unit tests.
- `apps/api/src/fleet/jobs/placement.service.project-code.spec.ts` — `placeJob` with and without `projectCode`.

**US-005**

- `apps/runner/src/thread/project-code/code-tools.ts` — `buildProjectCodeTools` and the four tools.
- `apps/runner/test/unit/project-code-tools.spec.ts` — the tools against real bare repositories in a temp directory.

**US-006**

- `apps/runner/src/thread/project-code/mirror-store.ts` — `projectCodeDirFor`, `refreshMirror`.
- `apps/runner/src/thread/project-code/mirror-prune.ts` — `pruneProjectCode`.
- `apps/runner/test/unit/project-code-mirror.spec.ts` — mirror refresh and prune against real git.

**US-007**

- `apps/runner/test/unit/thread-job-run-project-code.spec.ts` — PROJECT session start with repositories.

**US-008**

- `apps/web/components/fleet/threads/ThreadProjectCodeNotice.vue` — the notice.
- `apps/web/tests/components/thread-project-code-notice.spec.ts` — its unit tests.

### Modifies

Production files a story edits inside its own Workdir are named in Design and Context Files. This list holds only
files outside the story's Workdir and existing tests whose assertions the story's correct change breaks.

**US-001**

- `packages/fleet-protocol/src/threads.ts` — outside the api package: gains `ProjectRepoAssign`, `ProjectRepoUnavailable`, `PROJECT_CODE_LIMITS` and the optional `ThreadAssign` fields `projectRepos` and `projectReposUnavailable` (1c-b-D1); additive only.
- `packages/fleet-protocol/src/index.ts` — outside the api package: `TokenRequest`, `GitToken`, `GitTokenError` gain `repoId?: string`, `RunnerCapabilities` gains `projectCode?: true`, and the new threads exports are re-exported (1c-b-D1); additive only.

**US-002**

None. The parser, sync service and job repository changes are production edits inside the api package; the only implementer of `IFleetJobRepository` is `PrismaFleetJobRepository`, so the new method breaks no test fake, and existing parser and sync assertions cover requests without `repoId`, which are unchanged.

**US-003**

- `apps/api/src/fleet/threads/thread-instructions.spec.ts` — the exact second-line assertion at `:99-101` takes the 1c-b-D9 text, and the assertion at `:88-91` that `list_files` and `search_repo` never appear in PROJECT instructions is narrowed to `write_doc` and `Publish`, since the new line names the PROJECT code tools; other assertions unchanged.
- `openapi.json` — outside the api package: regenerated by `bun run api:export-spec` for the `session.projectCodeUnavailableOn` field.
- `apps/cli/src/generated/types.gen.ts` — outside the api package: regenerated by `bun run generate` for the same field; never hand-edited.
- `apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.spec.ts` — its fake thread row (`:33-41`) gains `kind` (default `REPO`) so the `session_started` branch can read it; the existing `kodaToolsUnavailableOn` expectations (`:459`, `:503`) are unchanged.

**US-004**

- `apps/runner/src/capabilities/nax-probe.spec.ts` — its whole-object capability expectation at `:68-109` gains `projectCode: true`; other expectations unchanged.

**US-006**

- `apps/runner/src/daemon/tuning.spec.ts` — its exact `TUNING` expectation (`toEqual` at `:6`) gains `projectCodeFetchTimeoutMs: 120000` and `projectCodeMirrorTtlMs: 1209600000`; the frozen-object assertion is unchanged.

### Seams

- SEAM-0 (US-003 -> US-002): the fence calls `fetchableProjectRepos` and `findProjectRepos`, which US-003 creates;
  a US-002 AC asserts a repository beyond the cap is refused.
- SEAM-1 (US-001 -> US-002; entry point `SyncService.sync`, behind `POST /api/fleet/runner/sync`): the fence mints
  through `GitTokenBroker.mint` with `readOnly: true`; a US-002 AC stubs the broker, calls `sync` with a `repoId`
  token request and asserts the call.
- SEAM-2 (US-001 -> US-003; entry point `PlacementService.placeJob`): `assign` reads `capabilities.projectCode` as
  parsed by US-001; US-003 ACs place a PROJECT session on a runner with and without it.
- SEAM-3 (US-004 -> US-007): `runProject` calls `repoCredentials.acquireRepo` and `releaseRepo`; US-007 ACs assert the
  calls on a stub, and a daemon wiring AC asserts the thread host carries the broker.
- SEAM-4 (US-005 -> US-007): `runProject` opens the session with the tools of `buildProjectCodeTools`; a US-007 AC
  asserts the opened session's tool names.
- SEAM-5 (US-006 -> US-007): `runProject` refreshes through `host.refreshMirror ?? refreshMirror`; US-007 ACs inject
  a stub and assert its calls.
- SEAM-6 (US-003 -> US-008): `session.projectCodeUnavailableOn`, returned by the thread GET route, is what the web
  notice reads.

## Acceptance Criteria

### US-001: Protocol contract, capability and read-only mint (`Workdir: apps/api`)

1. [unit] The API's runtime `PROJECT_CODE_LIMITS` from `apps/api/src/fleet/common/thread-jobs.ts` deep-equals the `PROJECT_CODE_LIMITS` exported by `@nathapp/fleet-protocol`, which is `{ maxRepos: 10, maxUnavailable: 50 }`.
2. [unit] `parseCapabilitiesCore` on a valid capability object with `projectCode: true` returns an object whose `projectCode` is `true`.
3. [unit] `parseCapabilitiesCore` on a valid capability object without `projectCode` returns an object with no `projectCode` key.
4. [unit] `parseCapabilitiesCore` on a valid capability object with `projectCode: false` throws `CapabilityValidationError` with reason `projectCode`.
5. [unit] `GitHubAppClient.mintReadOnlyToken(42n, 'sandbox')` against the fake forge posts to `/app/installations/42/access_tokens` a body whose `repositories` is `['sandbox']` and whose `permissions` is exactly `{ contents: 'read', metadata: 'read' }`, and resolves the forge's `token` and `expires_at` as `{ token, expiresAt }`.
6. [unit] `GitHubAppClient.mintReadOnlyToken` throws `RepoCheckException` with reason `app_not_installed` when the forge answers 404, `app_permissions_insufficient` when it answers 403 and when it answers 422, and `provider_error` when it answers 500 and when it answers 201 with a body lacking `token` (one table-driven test).
7. [unit] `GitTokenBroker.mint({ jobId: 'j1', leaseEpoch: 2, repo, readOnly: true })` for a GitHub repository with installation `7n` calls `mintReadOnlyToken(7n, repo.name)`, never `mintInstallationToken`, and resolves a token whose `jobId` is `j1` and `repoId` is `repo.id`.
8. [unit] After a read-only `mint` for job `j1` epoch 2, a `mint` for `j1` epoch 2 without `readOnly` calls `mintInstallationToken` (the read-only entry is not reused).
9. [unit] A second read-only `mint` for the same job, epoch and repository within the reuse margin calls no GitHub method and resolves the cached token.
10. [unit] `GitTokenBroker.mint` with `readOnly: true` for a GitHub repository whose `githubInstallationId` is null resolves `{ ok: false, error: { jobId, repoId, reason: 'app_not_installed' } }` and calls no GitHub method.
11. [unit] `GitTokenBroker.mint` with `readOnly: true` for a GitLab repository resolves an error with reason `provider_error` and calls neither `mintReadOnlyToken` nor the GitLab token source.
12. [unit] After a read-only `mint` and a write `mint` for job `j1`, `evict('j1')` makes the next `mint` of each call GitHub again.
13. [unit] Read-only `mint` for repository `r1` and then for repository `r2` of the same job and epoch calls `mintReadOnlyToken` twice, and each resolved token carries its own `repoId`.

### US-002: Read-only token fence on sync (`Workdir: apps/api`)

Every `SyncService.sync` case below runs with a stubbed job repository, fence and `GitTokenBroker`, a held RUNNING
`THREAD` job `j1` of project `p1` (epoch 1) whose `findThreadTokenScope` resolves `{ kind: 'PROJECT', action: 'SESSION' }`
unless stated, `findProjectRepos('p1')` resolving `[r1 (GitHub, installation 1)]` unless stated, and a sync body whose
`tokenRequests` holds the request.

1. [unit] `parseSyncRequest` keeps `repoId: 'r1'` on a token request that carries it, and returns a token request without a `repoId` key when it is absent.
2. [unit] `parseSyncRequest` throws a validation error with reason `tokenRequest` for a token request whose `repoId` is an empty string, a number, or a 65-character string (one table-driven test).
3. [unit] `SyncService.sync` with a request `{ jobId: 'j1', leaseEpoch: 1, repoId: 'r1' }` calls `findProjectRepos` with `p1` and calls `GitTokenBroker.mint` once with `{ jobId: 'j1', leaseEpoch: 1, repo, readOnly: true }` where `repo.id` is `r1`.
4. [unit] For that request, the sync response's `gitTokens` holds the broker's token, carrying `repoId: 'r1'`.
5. [unit] `SyncService.sync` with a `repoId` request naming a repository that `findProjectRepos('p1')` does not return (another project's) answers a `gitTokenErrors` entry `{ jobId: 'j1', repoId, reason: 'repo_not_assigned' }` and calls `GitTokenBroker.mint` zero times.
6. [unit] `SyncService.sync` with a `repoId` request on a job whose `findThreadTokenScope` resolves `{ kind: 'REPO', action: 'SESSION' }` answers `repo_not_assigned` and calls `mint` zero times.
7. [unit] `SyncService.sync` with a `repoId` request on a PROJECT thread job whose turn action is `PUBLISH` answers `repo_not_assigned`.
8. [unit] `SyncService.sync` with a `repoId` request on a held `RUN` job answers `repo_not_assigned` and never calls `findThreadTokenScope`.
9. [unit] With `findProjectRepos('p1')` resolving 11 installed GitHub repositories, a `repoId` request naming the 11th answers `repo_not_assigned`, and one naming the 10th is minted.
10. [unit] With `findProjectRepos('p1')` resolving a GitLab repository `g1` and a GitHub repository `n1` with no installation, `repoId` requests for `g1` and for `n1` each answer `repo_not_assigned`.
11. [unit] `SyncService.sync` with a `repoId` request on a job held by this runner in state `COMPLETED` answers `{ jobId: 'j1', repoId: 'r1', reason: 'job_not_active' }` and calls `mint` zero times.
12. [unit] `SyncService.sync` with a token request without `repoId` on a held RUN job calls `GitTokenBroker.mint` with `{ jobId, leaseEpoch, repo }` (no `readOnly` key), `repo` being `findRepo(job.repoId)`.
13. [unit] `SyncService.sync` with a `repoId` request whose fence does not hold (another runner's lease) calls `FenceService.abandon` and calls `mint` zero times.
14. [integration] `PrismaFleetJobRepository.findThreadTokenScope` for a THREAD job of a PROJECT thread whose turn action is `SESSION` resolves `{ kind: 'PROJECT', action: 'SESSION' }`, and for a RUN job with no thread turn resolves null.

### US-003: PROJECT ASSIGN repositories, session notice and instructions (`Workdir: apps/api`)

1. [unit] `withProjectRepos(thread, [a (GitHub, installation 1), b (GitLab), c (GitHub, no installation)], vcs)` returns a thread whose `projectRepos` is `[{ repoId: a.id, owner: a.owner, name: a.name, defaultBranch: a.defaultBranch, cloneUrl }]`, with `cloneUrl` equal to `cloneUrlFor(a, vcs)`.
2. [unit] For that input, `projectReposUnavailable` is `[{ owner: b.owner, name: b.name, reason: 'not a GitHub repository' }, { owner: c.owner, name: c.name, reason: 'no installation' }]`, in input order.
3. [unit] `withProjectRepos` with 12 installed GitHub repositories returns 10 `projectRepos` (the first 10 in input order) and 2 `projectReposUnavailable` entries with reason `limit`.
4. [unit] `withProjectRepos` with 60 GitLab repositories returns an empty `projectRepos` and exactly 50 `projectReposUnavailable` entries.
5. [integration] `PrismaFleetJobRepository.findProjectRepos(projectId)` returns the project's repositories ordered by `createdAt` ascending and, on equal `createdAt`, by `id` ascending, none of another project, and at most 60 of a project with 61.
6. [unit] `PlacementService.placeJob` of a queued PROJECT `SESSION` THREAD job onto the only eligible runner, whose capabilities hold `projectCode: true`, calls `findProjectRepos` with the job's `projectId` and creates an ASSIGN command whose `payload.thread.projectRepos` lists that stub's installed GitHub repositories.
7. [unit] `PlacementService.placeJob` of the same job onto a runner without `projectCode` creates an ASSIGN whose `payload.thread` has no `projectRepos` key and never calls `findProjectRepos`.
8. [unit] `PlacementService.placeJob` of a REPO `SESSION` THREAD job onto a runner with `projectCode: true` creates an ASSIGN whose `payload.thread` has no `projectRepos` key and never calls `findProjectRepos`.
9. [integration] Folding a `session_started` line for a PROJECT thread hosted by a runner whose capabilities lack `projectCode` stores a session whose `projectCodeUnavailableOn` is the runner's name.
10. [integration] Folding a `session_started` line for a PROJECT thread on a runner with `projectCode: true`, and for a REPO thread on a runner without it, stores a session with no `projectCodeUnavailableOn` key.
11. [integration] After a session with `projectCodeUnavailableOn` closes, the stored session of that job keeps `projectCodeUnavailableOn`.
12. [integration] `GET /api/projects/:slug/threads/:id` of a PROJECT thread whose stored session holds `projectCodeUnavailableOn: 'wk-mac'` answers a body whose `data.session.projectCodeUnavailableOn` is `wk-mac`.
13. [unit] `buildProjectThreadInstructions({ project: 'sandbox', skills: [] })` returns text whose line after the role line is exactly the 1c-b-D9 line, which names `list_repos`, `list_files`, `search_repo` and `read_file` and the citation form `owner/name:path@sha7`.
14. [unit] `buildProjectThreadInstructions` returns text with no `write_doc` and no `Publish`, and `buildThreadInstructions` for a REPO thread returns text with no `list_repos` and no `read_file`.

### US-004: Runner ASSIGN parsing, per-repository tokens and capability (`Workdir: apps/runner`)

1. [unit] `parseAssign` on a PROJECT `SESSION` THREAD ASSIGN with `projectRepos: [{ repoId: 'r1', owner: 'o', name: 'n', defaultBranch: 'main', cloneUrl: 'https://github.com/o/n.git' }]` and `projectReposUnavailable: [{ owner: 'o', name: 'g', reason: 'no installation' }]` returns `ok: true` with both arrays copied onto `assign.thread`.
2. [unit] `parseAssign` returns `{ ok: false, detail: 'invalid project repos' }` for `projectRepos` that is not an array, that holds 11 entries, or that holds an entry with repoId `../x`, owner `a//b`, name `a/b`, an empty `defaultBranch`, cloneUrl `file:///tmp/x`, or cloneUrl `http://github.com/o/n.git` (one table-driven test).
3. [unit] `parseAssign` returns `invalid project repos` for `projectReposUnavailable` with 51 entries or with an entry whose reason is `other`, and for `projectRepos` on a REPO thread ASSIGN.
4. [unit] `parseAssign` of a PROJECT ASSIGN without `projectRepos` returns `ok: true` with no `projectRepos` key on the thread.
5. [unit] A `TokenCache` with `want('j1', 1)` and `want('j1', 1, 'r1')` returns two requests from `requests`: one `{ jobId: 'j1', leaseEpoch: 1 }` with no `repoId` key and one `{ jobId: 'j1', leaseEpoch: 1, repoId: 'r1' }`.
6. [unit] A `TokenCache` with 70 repository entries wanted first and then one entry without `repoId` returns 64 requests from `requests`, the entry without `repoId` first, followed by the first 63 repository entries in want order.
7. [unit] `TokenCache.apply` with a token carrying `repoId: 'r1'` for job `j1` makes `state('j1', 1, now, 'r1')` a token and leaves `state('j1', 1, now)` pending.
8. [unit] `TokenCache.apply` with a `GitTokenError` `{ jobId: 'j1', repoId: 'r1', reason: 'repo_not_assigned' }` makes `state('j1', 1, now, 'r1')` the error `repo_not_assigned`; `drop('j1', 1, 'r1')` then makes `wanted('j1', 1, 'r1')` false and leaves `wanted('j1', 1)` true.
9. [unit] `buildSyncRequest` with a token request `{ jobId: 'j1', leaseEpoch: 1, repoId: 'r1' }` sends it with `repoId: 'r1'`, and a request without `repoId` is sent without the key.
10. [unit] `socketPathFor(dir, 'run', 'j1', 1)` is `dir` joined with the first 16 hex characters of the sha256 of `run:j1:1` plus `.sock`, and `socketPathFor(dir, 'run', 'j1', 1, 'r1')` uses the sha256 of `run:j1:1:r1`.
11. [integration] `CredentialBroker.acquireRepo(job, { repoId: 'r1', cloneUrl: 'https://github.com/o/n.git' }, { wait: true })` after the cache receives a token for `(j1, 1, 'r1')` resolves `ok: true` with a helper and `binDir: null`, and running that helper's `get` for `protocol=https` and `host=github.com` prints that token as the password.
12. [integration] The helper from `acquireRepo` prints no credentials for a `get` with `host=gitlab.com`.
13. [integration] After `releaseRepo(job, 'r1')`, `wanted('j1', 1, 'r1')` is false and the helper's `get` prints no credentials; `release(job)` on a job with two acquired repositories makes both repositories unwanted.
14. [unit] `NaxCapabilityProbe.probe` reports `projectCode: true` in its capabilities.

### US-005: Runner code tools over pinned mirrors (`Workdir: apps/runner`)

The tests build real bare repositories in a temp directory with `isolateGit` and `makeOrigin`, and pin a commit sha.

1. [unit] `buildProjectCodeTools` returns tools named, in order, `list_repos`, `list_files`, `search_repo`, `read_file`, each with `approval` `never`.
2. [unit] `list_repos` with pins `o/a` at sha `abcdef1234…` and an unavailable entry `{ repo: 'o/g', reason: 'no installation' }` returns the lines `o/a @ abcdef1` and `o/g unavailable (no installation)`; with no pins and no unavailable entries it returns `no repositories`.
3. [unit] `list_files { repo: 'o/a' }` returns every file path of the pinned commit, and a file added in a later commit of the same repository is not listed.
4. [unit] `list_files { repo: 'o/a', dir: 'src' }` returns only paths under `src/`, and `{ repo: 'o/a', glob: '**/*.md' }` returns only Markdown paths.
5. [unit] `list_files { repo: 'o/z' }` for an unpinned repository returns the error result `unknown repo`, and `{ repo: 'o/a', dir: '../x' }` returns an error result.
6. [unit] `search_repo { repo: 'o/a', pattern: 'needle' }` returns hit lines of the form `o/a:<path>:<line>:<text>` with no sha in them, including a hit in a file whose path holds a non-ASCII character, printed unquoted.
7. [unit] `search_repo { pattern: 'needle' }` without `repo` returns hits of both pins `o/a` and `o/b`, those of `o/a` first.
8. [unit] `search_repo` with a pattern that matches nowhere returns `no matches` as a non-error result.
9. [unit] `search_repo { pattern: 'x', max: 2 }` over a commit with five matching lines returns two hit lines followed by `[truncated]`.
10. [unit] With a fake `Git` whose grep exits 128 after the injected clock passes `searchTimeoutMs`, `search_repo` returns the error result `search timed out`.
11. [unit] `read_file { repo: 'o/a', path: 'src/a.ts', startLine: 2, endLine: 3 }` returns the header `o/a:src/a.ts@<sha7> lines 2-3 of <n>` followed by exactly lines 2 and 3 of the pinned file content.
12. [unit] `read_file` returns the error result `not found` for a missing path, `not a file` for the path `src`, and `binary file` for a file holding a NUL byte (one table-driven test).
13. [unit] `read_file` returns the error result `invalid lines` for `startLine` 0, for `startLine` 1.5, for `startLine` 5 with `endLine` 4, and for `startLine` 50 on a 10-line file; on an empty file it returns only the header `o/a:<path>@<sha7> lines 0-0 of 0`.
14. [unit] `read_file` on a file of 200000 bytes returns at most 65536 bytes counting the header, ending with `[truncated]`.

### US-006: Runner mirror store and prune (`Workdir: apps/runner`)

1. [unit] `refreshMirror` against a `file://` origin with `allowFileProtocol: true` creates `<home>/project-code/<repoId>.git` as a bare repository and resolves `{ ok: true, sha }` with `sha` the origin's `main` tip.
2. [unit] After a new commit is pushed to the origin, a second `refreshMirror` resolves the new tip sha, and the first sha's file content is still readable from the mirror with `git cat-file blob <first sha>:<path>`.
3. [unit] `refreshMirror` with `pinId` `j1` leaves the ref `refs/koda/pins/j1` pointing at the resolved sha and writes `koda-last-used` with the current time.
4. [unit] `refreshMirror` without `allowFileProtocol` against a `file://` origin resolves `{ ok: false, reason: 'fetch failed' }`.
5. [unit] `refreshMirror` with a fake `Git` whose fetch exits 137 once the injected clock has passed `timeoutMs` resolves `{ ok: false, reason: 'fetch timeout' }`.
6. [unit] `refreshMirror` acquires the mutex key `project-code:<repoId>` before its first git call and releases it after its last.
7. [unit] `refreshMirror` with `repoId` `../x` rejects with a path error and runs no git command.
8. [unit] A mirror refreshed with `pinId` `j1` at sha X and then with `pinId` `j2` at a newer sha Y still serves `git cat-file blob X:<path>` after `pruneProjectCode` runs with `activeJobIds` holding `j1`.
9. [unit] `pruneProjectCode` with `activeJobIds` empty deletes `refs/koda/pins/j1` and `refs/koda/pins/j2`, and runs `git gc --prune=now -q` in a mirror whose `koda-last-used` time is recent.
10. [unit] `pruneProjectCode` deletes a mirror with no remaining pin ref whose `koda-last-used` time is older than `ttlMs`.
11. [unit] `pruneProjectCode` keeps a mirror whose `koda-last-used` time is older than `ttlMs` while it holds the pin ref of a job in `activeJobIds`.
12. [unit] `pruneProjectCode` acquires the mutex key `project-code:<repoId>` for each mirror it visits.
13. [unit] The daemon's thread prune, with one active THREAD job `j1`, calls `pruneProjectCode` with `activeJobIds` holding `j1` and with the same `RepoMutex` instance the daemon gives its `Supervisor`.
14. [unit] When `pruneProjectCode` rejects, the daemon's thread prune logs the warning `project code prune failed` and still calls `pruneThreads`.

### US-007: Runner PROJECT session start with code (`Workdir: apps/runner`)

Every case below runs `ThreadJobRun` on a PROJECT `SESSION` ASSIGN with the fake host of
`test/unit/thread-job-run-project.spec.ts`, a stub `repoCredentials` and a stub `refreshMirror` on the host.

1. [unit] With two `projectRepos`, the run calls `acquireRepo` once per repository with its `repoId` and `cloneUrl`, and both calls start before either resolves.
2. [unit] With two `projectRepos` and both refreshes succeeding, the run calls `releaseRepo` once per repository before `sessions.open` is called.
3. [unit] With both refreshes succeeding, the session opens with tools named `load_skill`, `read_skill_file`, `list_repos`, `list_files`, `search_repo`, `read_file`, in that order, and its `worktree` is the thread's scratch directory.
4. [unit] Each `refreshMirror` call receives the run's `mutex`, `pinId` equal to the job id, the helper its `acquireRepo` returned, and `timeoutMs` 120000 when `projectCodeFetchTimeoutMs` is not set.
5. [unit] When `acquireRepo` resolves `{ ok: false, reason: 'git token: repo_not_assigned' }` for one repository, the session still opens, `refreshMirror` is not called for it, and `list_repos` returns it as `unavailable (token: git token: repo_not_assigned)` and the other as pinned.
6. [unit] When `acquireRepo` resolves `{ ok: false, reason: 'git token: timeout' }` for a repository, `list_repos` returns it as `unavailable (token: git token: timeout)`.
7. [unit] When every refresh resolves `{ ok: false, reason: 'fetch failed' }`, the session still opens, `list_repos` lists each repository as `unavailable (fetch failed)`, and the job transitions to RUNNING.
8. [unit] The ASSIGN's `projectReposUnavailable` entries appear in `list_repos` after the run's own failures, with their reasons.
9. [unit] A cancel request while `acquireRepo` is waiting ends the run `CANCELLED` with reason `cancelled before start`, calls `releaseRepo` for each repository, and opens no session.
10. [unit] A cancel request while `refreshMirror` is running ends the run `CANCELLED` with reason `cancelled before start` after the refresh settles, calls `releaseRepo` for each repository, and opens no session.
11. [unit] A halt while `refreshMirror` is running calls `releaseRepo` for each repository after the refresh settles, opens no session, and records no job transition.
12. [unit] A PROJECT ASSIGN without `projectRepos`, and one with `projectRepos` on a host without `repoCredentials`, open the session with only `load_skill` and `read_skill_file` plus koda proxies, and call no `acquireRepo`.
13. [unit] With five `projectRepos`, at most 3 `refreshMirror` calls are in flight at once.
14. [unit] The daemon builds the thread host with `repoCredentials` set to its `CredentialBroker`.
15. [unit] With a real bare origin from `makeOrigin` and a host `refreshMirror` that calls the real `refreshMirror` with `allowFileProtocol: true`, the opened session's `list_repos` reports the origin's tip sha and its `read_file` returns the origin's file content at that sha.

### US-008: Web project-code notice (`Workdir: apps/web`)

1. [unit] `showProjectCodeNotice` returns true for a thread whose session state is `live` and whose `projectCodeUnavailableOn` is `wk-mac`.
2. [unit] `showProjectCodeNotice` returns false when the session is `closed`, when `projectCodeUnavailableOn` is absent, and when there is no session (one table-driven test).
3. [unit] Mounting `ThreadProjectCodeNotice` with a live session whose `projectCodeUnavailableOn` is `wk-mac` renders an element with test id `thread-project-code-notice` whose text is the English `fleet.threads.projectCode.unavailable` message with `wk-mac` in place of `{runner}`.
4. [unit] Mounting `ThreadProjectCodeNotice` for a live session without `projectCodeUnavailableOn` renders no `thread-project-code-notice` element.
5. [unit] Translating `fleet.threads.projectCode.unavailable` with `{ runner: 'wk-mac' }` returns a message holding `wk-mac` in the `en` locale and in the `zh` locale.
6. [unit] Mounting the thread page `pages/[project]/threads/[id].vue` for a PROJECT thread whose live session holds `projectCodeUnavailableOn: 'wk-mac'` renders the `thread-project-code-notice` element.
