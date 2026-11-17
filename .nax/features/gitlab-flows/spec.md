<!-- spec-writing: completed-through-phase-5 -->
# SPEC: GitLab flows (GitLab parity F4b)

## Summary

Fleet flows run on a GitLab repo the way they run on a GitHub one. A nax flow entry with a GitLab remote URL
resolves to the registered GitLab repo, the spec-head and merge-request reads go through the repo's read token,
and the flow's own writes (the calls commit, the PRD edits commit, the feature branch) go through its write token.
The GitLab client gains the branch, commit and compare calls the flow writes need. A GitLab setup guide documents
the whole GitLab path for an operator.

## Motivation

GitLab parity design `docs/superpowers/specs/2026-11-16-gitlab-parity-design.md` §5 lists flows as GitHub-App
only. F1-F4a (merged #472-#475) made registration, jobs, reads and auto-review work on GitLab; flows are the last
GitHub-only feature. Today every flow forge call mints a GitHub App token, so a flow on a GitLab repo is refused
`fleet.flows.repoNotFound` (the remote URL parser accepts only github.com) or stopped `repo not connected`
(`githubInstallationId === null`). The design's §7 Docs item (the GitLab setup guide) is also still open.

## Design

### Rules shared by every story

- **GitLab branch iff `repo.provider === 'gitlab'`.** A GitLab row takes the GitLab path whatever its
  `githubInstallationId` holds, and never calls a `GitHubAppClient` method. A GitHub row keeps today's code path
  unchanged, including the `githubInstallationId === null` refusals.
- **One `GitLabRepoCredentials.call` per GitLab client method call.** `call(repo, kind, fn)` marks the token
  invalid on a 401; wrapping a whole pass in one `call` would mark a token rotated mid-pass.
- **Token kind per request (design §5):** reads (`getBranchHead`, `getFile`, `getFileForUpdate`, `getMergeRequest`,
  `isSingleFileCommit`, `isOwnCallsRun`) use `'read'`; writes (`createBranch`, `commitFile`) use `'write'`.
- **New constructor dependencies are appended** after the existing ones: `GitLabRepoCredentials`, then
  `GitLabAccessChecker`. `GitBrokerModule` already exports both and `FleetFlowsModule` already imports it.
- **Missing or invalid GitLab credentials stop a flow** like a GitHub App that is not installed:
  `callsOutcomeForForgeError` classifies `gitlab_credentials_missing` and `gitlab_token_invalid` as `'failed'`.
  `vcs_encryption_key_missing` and the host refusals keep the default `'retry'`.

### Integration

Read-only symbols (verified at main `cd4340e12`):

- `GitLabRepoCredentials.call<T>(repo: { id: string; host?: string }, kind: 'read' | 'write', fn: (access: GitLabAccess) => Promise<T>): Promise<T>` — `apps/api/src/fleet/git-broker/gitlab-repo-credentials.ts`; throws `RepoCheckException('gitlab_credentials_missing')` for a repo with no credential row.
- `GitLabAccessChecker.getBranchHead(access, branch): Promise<string>` (404 → `repo_not_found`), `getFile(access, path, ref): Promise<ForgeFile | null>` (`sha` is the GitLab `blob_id`), `getMergeRequest(access, iid): Promise<VcsPrStatus | null>` — `apps/api/src/fleet/git-broker/gitlab-access-checker.ts`. Private helpers `projectUrl(access)`, `guard(apiBase)` (host check before every request) and `fail(status)` (401 → `gitlab_token_invalid`, 403 → `app_permissions_insufficient`, else `provider_error`) are the pattern for the new methods.
- `PutFileResult` = `{ kind: 'committed'; commitSha } | { kind: 'conflict' } | { kind: 'refused' }` — `github-app-client.ts:13`.
- `prNumberFor(repo: Pick<FleetRepoRef, 'provider' | 'owner' | 'name' | 'host'>, url)` — `apps/api/src/fleet/sync/pr-attribution.service.ts:27`; already parses GitLab MR URLs including a host path prefix.
- `FleetReposService.findReviewRepo(id)` — returns `id, projectId, owner, name, githubInstallationId, defaultBranch, provider, host`.
- GitLab rows store `owner` as the full namespace path (`group/sub`) and `host` as the origin plus any path prefix (`https://gitlab.com`, `https://example.com/gitlab`); `@@unique([provider, host, owner, name])`.

Mutated symbols. The baseline exists only to locate the code; implement the target.

- `parseFlowInput` (`apps/api/src/fleet/flows/flow-input.ts:64-65`)
  - Baseline: validates `remoteUrl` with `parseGitHubUrl`.
  - Target: validates `remoteUrl` with the new `parseFlowRemoteUrl`; `normalized.remoteUrl` stays the input string.
- `FleetFlowsController.create` (`apps/api/src/fleet/flows/fleet-flows.controller.ts:73-124`)
  - Baseline: `parseGitHubUrl` → `findByIdentity('github', owner, name)` → GitHub mint and reads.
  - Target: `parseFlowRemoteUrl`; a `github` result keeps the baseline path; a `gitlab` result resolves the repo
    with `FleetReposService.findGitLabByRemoteUrl(url)`, runs the same permission checks, then reads the branch head
    and every spec through `call(repo, 'read', ...)`. Constructor gains `gitlabCredentials`, `gitlab` (appended).
- `FleetFlowAdvanceService.readSpecHead` (`fleet-flow-advance.service.ts:794-812`), `prNumberOf` (`:899-906`)
  - Baseline: GitHub mint + `getBranchHead`; `prNumberFor({ provider: 'github', ... })`.
  - Target: GitLab row reads the head through `call(repo, 'read', a => gitlab.getBranchHead(a, flow.branch))`;
    `prNumberOf` passes the repo's own `provider` and `host`. Constructor gains `gitlabCredentials`, `gitlab`
    (appended); `featurePassDeps()` passes both.
- `FeaturePassDeps` (`fleet-flow-feature-passes.ts:17`)
  - Target: gains `gitlabCredentials: GitLabRepoCredentials` and `gitlab: GitLabAccessChecker`.
- `runMergeWatch` / `pollAwaited` (`fleet-flow-feature-passes.ts:240-356`)
  - Target: a GitLab row skips the GitHub mint and reads each awaited MR with
    `call(repo, 'read', a => gitlab.getMergeRequest(a, prNumber))`; the outcome rules (merged, closed, gone, retry,
    stop) are unchanged.
- `runFeatureStart` / `createFeatureBranch` / `specMatchesApproved` (`fleet-flow-feature-passes.ts:77-163`)
  - Target: a GitLab row reads the default-branch head and both spec blobs with the read token and creates the
    branch with `call(repo, 'write', a => gitlab.createBranch(a, branch, baseSha))`; the decision rules are unchanged.
- `FleetFlowCallsService.apply` / `applyPrdEdits` / `isOwnEarlierCommit` (`fleet-flow-calls.service.ts:57-175`)
  - Target: a GitLab row runs the same algorithm with `getBranchHead`, `getFileForUpdate` (pinned to the head),
    `commitFile` (with the file's `lastCommitId` as the lock), `isSingleFileCommit` and `isOwnCallsRun` from
    `GitLabAccessChecker`. Constructor gains `gitlabCredentials`, `gitlab` (appended).
- `callsOutcomeForForgeError` (`apps/api/src/fleet/flows/flow-calls.ts:13`)
  - Target: also `'failed'` for `gitlab_credentials_missing` and `gitlab_token_invalid`.

### New GitLab client methods (US-001)

All on `GitLabAccessChecker`, each calling `guard(access.target.apiBase)` before every request and sending the
`private-token` header.

```ts
createBranch(access, branch: string, sha: string):
  Promise<{ kind: 'created' } | { kind: 'exists'; sha: string } | { kind: 'refused' }>
// POST <project>/repository/branches?branch=<enc>&ref=<enc sha>
// 201 -> created. 400 (exists or invalid name) -> getBranchHead: found -> exists(sha), repo_not_found -> refused.
// 404 -> RepoCheckException('repo_not_found'); other -> fail(status).

getFileForUpdate(access, path: string, ref: string):
  Promise<(ForgeFile & { lastCommitId: string }) | null>
// Same request and checks as getFile, plus `last_commit_id` (string, else provider_error). 404 -> null.

commitFile(access, path: string, input: { branch: string; content: Buffer; lastCommitId: string; message: string }):
  Promise<PutFileResult>
// POST <project>/repository/commits
//   { branch, commit_message: message,
//     actions: [{ action: 'update', file_path: path, content: <base64>, encoding: 'base64', last_commit_id }] }
// 201 -> committed(commitSha = body.id, string else provider_error).
// 400 or 409 -> conflict (GitLab answers a stale last_commit_id with 400; the caller re-reads the blob, exactly as
// it does for a GitHub 409). 404 -> repo_not_found. other -> fail(status).

isSingleFileCommit(access, base: string, head: string, path: string): Promise<boolean>
isOwnCallsRun(access, base: string, head: string, own: { paths: readonly string[]; marker: string }): Promise<boolean>
// Both: GET <project>/repository/compare?from=<base>&to=<head>&straight=false
//   404 -> repo_not_found, other non-200 -> fail(status). `compare_timeout: true` -> false.
// GitLab compare commits carry no parents and no full message, so each listed commit is read with
//   GET <project>/repository/commits/<id> (parent_ids, message); 404 there -> false.
// The run is valid only as a linear chain: walking from head through each commit's single parent reaches base,
// every listed commit is on that walk, and no other commit is.
// isSingleFileCommit: exactly one commit, id === head, parent_ids === [base], exactly one diff with
//   old_path === new_path === path and new_file, deleted_file, renamed_file all false.
// isOwnCallsRun: 1..FLOW_OWN_RUN_MAX_COMMITS commits (50; more -> false before any commit read), every message
//   contains own.marker, at least one diff, every diff modifies (not new/deleted/renamed) a path in own.paths.
```

### Remote URL resolution (US-002)

New `apps/api/src/fleet/flows/flow-remote-url.ts`:

```ts
export type FlowRemote =
  | { provider: 'github'; owner: string; name: string }
  | { provider: 'gitlab'; url: string };
export function parseFlowRemoteUrl(url: string): FlowRemote;
```

- A URL `parseGitHubUrl` accepts returns the `github` variant with its lowercased `owner` and `repo` (as `name`).
- Otherwise the URL must parse with `new URL`, use `https:`, carry no username, password, query or fragment, and have
  at least two non-empty path segments after a trailing `/` and then a trailing `.git` (case-insensitive) are removed,
  none of them `.` or `..`. It returns the `gitlab` variant with `url` = `(origin + path).toLowerCase()`.
- Anything else throws `ValidationAppException` `skills.unsupportedHost` (what `parseGitHubUrl` throws), so
  `parseFlowInput` reports `remoteUrl`.

New `FleetReposService.findGitLabByRemoteUrl(url: string): Promise<FleetRepoRecord | null>` backed by a new
`IFleetRepoRepository.findGitLabByName(name)` (provider `gitlab`, name equal case-insensitively, ordered by
`createdAt`, then `id`). The service keeps the first row whose `(host without trailing '/') + '/' + owner + '/' + name`,
lowercased, equals `url`. A host with a path prefix therefore matches only URLs under that prefix, and the same path
on another host never matches.

### Failure Handling

| Where | Condition | Outcome |
|:--|:--|:--|
| Controller, GitLab | `gitlab_credentials_missing`, `gitlab_token_invalid`, `app_permissions_insufficient` | 409 `fleet.flows.gitlabNotConnected` |
| Controller, GitLab | `repo_not_found` from the branch read | 409 `fleet.flows.branchNotFound` |
| Controller, GitLab | `provider_unreachable`, `provider_error`, `vcs_encryption_key_missing` | 503 `fleet.flows.forgeUnavailable` |
| Controller, GitLab | any other `RepoCheckException` reason | rethrown (422 `fleet.repoCheck`) |
| Calls / PRD edits / feature start / merge watch, GitLab | credentials missing or token invalid | `'failed'` per `callsOutcomeForForgeError` (calls `failed` with the reason as detail; start and watch stop `dispatch_refused`) |
| `commitFile` | 400/409 | `conflict`; caller re-reads, same blob sha → `failed` `spec write refused` / `prd.json write refused`, else `retry` |

New API i18n key `fleet.flows.gitlabNotConnected` (409) in `apps/api/src/i18n/en/fleet.json` and
`apps/api/src/i18n/zh/fleet.json`: en "Koda cannot read this GitLab repository: its tokens are missing or invalid;
rotate them with koda fleet repo credentials".

## Out of Scope

- An ssh remote URL (`git@host:group/app.git`) stays refused for GitLab, as it is for GitHub.
- Thread-entry flows: they already run one feature on the thread's project repo, and threads on GitLab shipped in F3; nothing in this feature changes the thread entry.
- nax-side flow support (`nax-flow__send` and the forge kind for self-hosted hosts, nax #2957) is nax work, not koda work.
- Per-job GitLab token minting stays deferred (design §6.4).
- Inbound GitLab webhooks stay ruled out (Track 3 ruling 2026-09-27); flows keep polling.
- The live check of design §9 step 5 (a flow end to end on `freqtrade/quant-crypto-trader`) is an operator step after deployment, not a story.
- US-003 only: a GitLab push rule or protected-branch refusal of the calls commit surfaces as `app_permissions_insufficient` and fails the calls pass; no separate `refused` mapping for GitLab 403 is added.
- US-001 only: `isOwnCallsRun` refuses a run longer than 50 commits even if it is the flow's own; a flow's set has at most 20 features, so a longer own run does not occur.

## Stories

**US-001: GitLab client calls for flow writes.** Workdir: `apps/api`. No dependencies.
Adds `createBranch`, `getFileForUpdate`, `commitFile`, `isSingleFileCommit` and `isOwnCallsRun` to
`GitLabAccessChecker`, per Design § New GitLab client methods.

**US-002: Flow reads on GitLab.** Workdir: `apps/api`. No dependencies.
`parseFlowRemoteUrl` and `findGitLabByRemoteUrl`; the nax flow entry route on a GitLab repo; the spec-head read and
the merge watch through the read token; `prNumberOf` with the repo's provider; `callsOutcomeForForgeError` for the
GitLab credential reasons; the `fleet.flows.gitlabNotConnected` key. Adds the GitLab dependencies to
`FleetFlowsController`, `FleetFlowAdvanceService` and `FeaturePassDeps`.

**US-003: Flow writes on GitLab.** Workdir: `apps/api`. Depends on US-001, US-002.
`FleetFlowCallsService.apply` and `applyPrdEdits`, and the feature-start pass, on a GitLab repo through the US-001
client calls. Adds the GitLab dependencies to `FleetFlowCallsService`.

**US-004: GitLab setup guide.** Workdir: `.`. No dependencies.
**No-test:** documentation only. Writes `docs/deployment/gitlab.md` for operators.

### Context Files

**US-001**
- `apps/api/src/fleet/git-broker/gitlab-access-checker.ts` — `projectUrl`, `guard`, `fail`, `getBranchHead`, `getFile` as the pattern
- `apps/api/src/fleet/git-broker/gitlab-access-checker.spec.ts` — how requests and the host check are stubbed; shared tables AC-11 and AC-12
- `apps/api/src/fleet/git-broker/github-app-client.ts` — `createBranch`, `isSingleFileCommit`, `isOwnCallsRun`, `putFile`, the GitHub rules the GitLab methods mirror

**US-002**
- `apps/api/src/fleet/flows/fleet-flows.controller.ts` — `create`
- `apps/api/src/fleet/flows/flow-input.ts` — `parseFlowInput` remote URL check
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — `readSpecHead`, `prNumberOf`, `featurePassDeps`
- `apps/api/src/fleet/flows/fleet-flow-feature-passes.ts` — `FeaturePassDeps`, `runMergeWatch`, `pollAwaited`
- `apps/api/src/fleet/repos/prisma-fleet-repo.repository.ts` — `findByIdentity` as the pattern for `findGitLabByName`

**US-003**
- `apps/api/src/fleet/flows/fleet-flow-calls.service.ts` — `apply`, `applyPrdEdits`, `isOwnEarlierCommit`
- `apps/api/src/fleet/flows/fleet-flow-calls.service.spec.ts` — how the repo and forge are stubbed
- `apps/api/src/fleet/flows/fleet-flow-feature-passes.ts` — `runFeatureStart`, `createFeatureBranch`, `specMatchesApproved`
- `apps/api/src/fleet/flows/fleet-flow-feature-start.spec.ts` — how the start pass is driven through `FleetFlowAdvanceService.advance`

**US-004**
- `docs/superpowers/specs/2026-11-16-gitlab-parity-design.md` — §6 credentials, §7 surfaces, §8 host rule
- `docs/deployment/runner.md` — the existing operator guide's tone and the `koda fleet repo add` example
- `apps/cli/src/commands/fleet-repo.ts` — the real `add` and `credentials` flags

### Creates

**US-001**
- `apps/api/src/fleet/git-broker/gitlab-access-checker.flow-writes.spec.ts` — US-001 AC-1 to AC-15

**US-002**
- `apps/api/src/fleet/flows/flow-remote-url.ts` — `parseFlowRemoteUrl`, `FlowRemote`
- `apps/api/src/fleet/flows/flow-remote-url.spec.ts` — US-002 AC-1 to AC-3
- `apps/api/src/fleet/flows/fleet-flows-gitlab.spec.ts` — the GitLab branches of the controller, the spec-head read, the merge watch and `prNumberOf`
- `apps/api/test/integration/fleet/fleet-repo-gitlab-remote.integration.spec.ts` — `findGitLabByRemoteUrl` against Postgres

**US-003**
- `apps/api/src/fleet/flows/fleet-flow-calls-gitlab.spec.ts` — the GitLab branches of `apply` and `applyPrdEdits`
- `apps/api/src/fleet/flows/fleet-flow-feature-start-gitlab.spec.ts` — the GitLab branch of the start pass

**US-004**
- `docs/deployment/gitlab.md` — the GitLab setup guide

### Modifies

US-003 and US-004 change no existing file: their cases live in new spec files, and the existing GitHub specs pass unchanged.

**US-001**
- `apps/api/src/fleet/git-broker/gitlab-access-checker.spec.ts` — gains rows for `createBranch`, `getFileForUpdate`, `commitFile`, `isSingleFileCommit` and `isOwnCallsRun` in the shared tables "AC-11: %s maps HTTP failures" and "AC-12: %s blocks loopback hosts before requesting"; every existing case and row stays.

**US-002**
- `apps/api/src/fleet/flows/flow-calls.spec.ts` — "marks known repository setup failures as failed" gains `gitlab_credentials_missing` and `gitlab_token_invalid`; "retries other forge failures" stays.
- `apps/api/src/i18n/en/fleet.json` — adds `flows.gitlabNotConnected.409`; every existing key stays.
- `apps/api/src/i18n/zh/fleet.json` — adds `flows.gitlabNotConnected.409`; every existing key stays.

### Seams

- US-001 adds `createBranch`, `getFileForUpdate`, `commitFile`, `isSingleFileCommit` and `isOwnCallsRun`; US-003 consumes them, pinned at `FleetFlowCallsService.apply` / `applyPrdEdits` (US-003 AC-1, AC-3, AC-5, AC-8) and at `FleetFlowAdvanceService.advance` for the start pass (US-003 AC-10, AC-11).
- US-002 adds `FeaturePassDeps.gitlabCredentials` and `FeaturePassDeps.gitlab`; US-003's start pass reads them.
- US-002 adds `parseFlowRemoteUrl` and `findGitLabByRemoteUrl`; their consumer `FleetFlowsController.create` is in the same story (US-002 AC-7).

## Acceptance Criteria

### US-001: GitLab client calls for flow writes

- AC-1 [unit] `GitLabAccessChecker.createBranch(access, 'feat/a', 'abc')` sends `POST <apiBase>/projects/<projectId>/repository/branches?branch=feat%2Fa&ref=abc` with the `private-token` header set to `access.token`, and returns `{ kind: 'created' }` for a 201 answer.
- AC-2 [unit] When the branch POST answers 400 and the follow-up `GET <apiBase>/projects/<projectId>/repository/branches/feat%2Fa` answers 200 with `commit.id: 'def'`, `createBranch` returns `{ kind: 'exists', sha: 'def' }`.
- AC-3 [unit] When the branch POST answers 400 and the follow-up branch GET answers 404, `createBranch` returns `{ kind: 'refused' }`.
- AC-4 [unit] `GitLabAccessChecker.getFileForUpdate(access, 'docs/a.md', 'c1')` returns `{ sha: 'b9', size: 2, content: Buffer.from('hi'), lastCommitId: 'lc1' }` for a 200 answer `{ blob_id: 'b9', size: 2, encoding: 'base64', content: 'aGk=', last_commit_id: 'lc1' }`, and null for a 404 answer.
- AC-5 [unit] A 200 file answer without a string `last_commit_id` makes `getFileForUpdate` throw `RepoCheckException` with reason `provider_error`.
- AC-6 [unit] `GitLabAccessChecker.commitFile(access, 'docs/a.md', { branch: 'feat/a', content: Buffer.from('hi'), lastCommitId: 'lc1', message: 'm' })` sends `POST <apiBase>/projects/<projectId>/repository/commits` with body `{ branch: 'feat/a', commit_message: 'm', actions: [{ action: 'update', file_path: 'docs/a.md', content: 'aGk=', encoding: 'base64', last_commit_id: 'lc1' }] }`, and returns `{ kind: 'committed', commitSha: 'n1' }` for a 201 answer `{ id: 'n1' }`.
- AC-7 [unit] `commitFile` returns `{ kind: 'conflict' }` for a 400 answer and for a 409 answer.
- AC-8 [unit] `commitFile` throws `RepoCheckException` with reason `app_permissions_insufficient` for a 403 answer.
- AC-9 [unit] `GitLabAccessChecker.isSingleFileCommit(access, 'b0', 'h1', 'docs/a.md')` sends `GET <apiBase>/projects/<projectId>/repository/compare?from=b0&to=h1&straight=false` and `GET <apiBase>/projects/<projectId>/repository/commits/h1`, and returns true when the compare lists commits `[{ id: 'h1' }]` and diffs `[{ old_path: 'docs/a.md', new_path: 'docs/a.md', new_file: false, deleted_file: false, renamed_file: false }]` and the commit answers `parent_ids: ['b0']`.
- AC-10 [unit] `isSingleFileCommit` returns false when the commit `h1` answers `parent_ids: ['x9']`, with the compare answer of AC-9.
- AC-11 [unit] `isSingleFileCommit` returns false when the compare answer of AC-9 has `renamed_file: true` on its one diff.
- AC-12 [unit] `isSingleFileCommit` returns false without reading any commit when the compare answers `compare_timeout: true`.
- AC-13 [unit] `GitLabAccessChecker.isOwnCallsRun(access, 'b0', 'h2', { paths: ['a.md', 'b.md'], marker: 'flow calls from SPEC_REVIEW job j1' })` returns true when the compare lists commits `h1` and `h2` and diffs modifying only `a.md` and `b.md`, commit `h1` answers `parent_ids: ['b0']` and commit `h2` answers `parent_ids: ['h1']`, and both messages contain the marker.
- AC-14 [unit] `isOwnCallsRun` returns false for the answers of AC-13 when commit `h2`'s message lacks the marker.
- AC-15 [unit] `isOwnCallsRun` returns false without reading any commit when the compare lists 51 commits.

### US-002: Flow reads on GitLab

- AC-1 [unit] `parseFlowRemoteUrl('https://github.com/Org/Repo.git')` returns `{ provider: 'github', owner: 'org', name: 'repo' }`.
- AC-2 [unit] `parseFlowRemoteUrl('https://GitLab.example.com/Grp/Sub/App.git/')` returns `{ provider: 'gitlab', url: 'https://gitlab.example.com/grp/sub/app' }`.
- AC-3 [unit] `parseFlowRemoteUrl` throws `ValidationAppException` for each of `'http://gitlab.com/grp/app'`, `'https://user:pw@gitlab.com/grp/app'`, `'https://gitlab.com/app'` and `'git@gitlab.com:grp/app.git'`.
- AC-4 [unit] `parseFlowInput` with entry `'NAX'` accepts `remoteUrl: 'https://gitlab.com/grp/app.git'` and returns it unchanged as `remoteUrl`.
- AC-5 [integration] With GitLab repos `{ host: 'https://gitlab.example.com', owner: 'Grp/Sub', name: 'App' }` and `{ host: 'https://gitlab.com', owner: 'Grp/Sub', name: 'App' }` stored, `FleetReposService.findGitLabByRemoteUrl('https://gitlab.example.com/grp/sub/app')` returns the first one.
- AC-6 [integration] With a GitLab repo `{ host: 'https://example.com/gitlab', owner: 'grp', name: 'app' }` stored, `findGitLabByRemoteUrl('https://example.com/gitlab/grp/app')` returns it and `findGitLabByRemoteUrl('https://example.com/grp/app')` returns null.
- AC-7 [unit] `FleetFlowsController.create` with `remoteUrl: 'https://gitlab.com/grp/app'`, a repo `{ provider: 'gitlab', githubInstallationId: 9n }` returned by `findGitLabByRemoteUrl`, and a caller holding `fleet.flow.create`, calls `GitLabRepoCredentials.call` with the repo and `'read'`, `GitLabAccessChecker.getBranchHead` with `branch`, `GitLabAccessChecker.getFile` with each `specPath` and `specSha`, then `ApprovalRouteGate.run` with input `{ projectId, repoId: repo.id, body }`, and never calls a `GitHubAppClient` method.
- AC-8 [unit] When `getBranchHead` resolves a sha other than `specSha` on that GitLab repo, `FleetFlowsController.create` throws 409 `fleet.flows.specShaNotHead` and never calls `ApprovalRouteGate.run`.
- AC-9 [unit] When `GitLabRepoCredentials.call` rejects with `RepoCheckException('gitlab_credentials_missing')`, `FleetFlowsController.create` throws 409 `fleet.flows.gitlabNotConnected`; the same holds for `gitlab_token_invalid`.
- AC-10 [unit] When `getBranchHead` rejects with `RepoCheckException('provider_error')` on a GitLab repo, `FleetFlowsController.create` throws 503 `fleet.flows.forgeUnavailable`.
- AC-11 [unit] `FleetFlowAdvanceService.advance` on an APPROVED NAX flow whose repo is `{ provider: 'gitlab' }` reads the spec head with `GitLabAccessChecker.getBranchHead(access, flow.branch)` through `call(repo, 'read', ...)` and never calls `GitHubAppClient.mintReadOnlyToken`.
- AC-12 [unit] `FleetFlowAdvanceService.advance` on a WAITING_MERGE flow on a GitLab repo, whose awaited feature has `prNumber: 12`, calls `GitLabAccessChecker.getMergeRequest` with the access and `12`, and when it resolves `merged: true` records the feature `MERGED`.
- AC-13 [unit] In that merge watch, when `GitLabRepoCredentials.call` rejects with `RepoCheckException('gitlab_token_invalid')`, the flow is stopped with reason `dispatch_refused` and detail `gitlab_token_invalid`.
- AC-14 [unit] `callsOutcomeForForgeError` returns `'failed'` for `'gitlab_credentials_missing'` and for `'gitlab_token_invalid'`.
- AC-15 [unit] For a finished RUN job of a flow on GitLab repo `{ provider: 'gitlab', host: 'https://gitlab.com', owner: 'grp', name: 'app' }` with `resultPrUrl: 'https://gitlab.com/grp/app/-/merge_requests/7'`, the decision input `FleetFlowAdvanceService.advance` builds carries `latestJob.prNumber: 7`.

### US-003: Flow writes on GitLab

- AC-1 [unit] `FleetFlowCallsService.apply(flow, action, 'h0', target)` on a GitLab repo whose branch head is `'h0'` calls `GitLabAccessChecker.getFileForUpdate` with `target.specPath` and `'h0'` through `call(repo, 'read', ...)`, then `GitLabAccessChecker.commitFile` through `call(repo, 'write', ...)` with `target.specPath`, the built calls text, the file's `lastCommitId`, `target.branch` and message `docs(<feature>): flow calls from <step> job <jobId>`, and returns `{ kind: 'committed', specSha: <commitSha> }`.
- AC-2 [unit] On that GitLab repo, when the branch head is not `expectedHead` and the spec does not yet carry the calls, `apply` returns `{ kind: 'stale', head }` and never calls `commitFile`.
- AC-3 [unit] When `commitFile` returns `{ kind: 'conflict' }` and the re-read of the spec on `target.branch` has the same blob sha, `apply` returns `{ kind: 'failed', detail: 'spec write refused' }`.
- AC-4 [unit] When `commitFile` returns `{ kind: 'conflict' }` and the re-read has a different blob sha, `apply` returns `{ kind: 'retry' }`.
- AC-5 [unit] When the spec at the branch head already carries the expected calls block and `GitLabAccessChecker.isSingleFileCommit(access, expectedHead, head, target.specPath)` resolves true, `apply` returns `{ kind: 'committed', specSha: head }` and never calls `commitFile`.
- AC-6 [unit] For a set replay target, when `isSingleFileCommit` resolves false, `apply` calls `GitLabAccessChecker.isOwnCallsRun` with `target.replay.reviewedHead`, the head, and `{ paths: target.replay.paths, marker: 'flow calls from <step> job <jobId>' }`.
- AC-7 [unit] When `GitLabRepoCredentials.call` rejects with `RepoCheckException('gitlab_credentials_missing')`, `apply` returns `{ kind: 'failed', detail: 'gitlab_credentials_missing' }`.
- AC-8 [unit] `FleetFlowCallsService.applyPrdEdits` on a GitLab repo whose head equals `expectedHead` commits `.nax/features/<feature>/prd.json` through `commitFile` with message `chore(<feature>): flow PRD edits from PRD_REVIEW job <jobId>` and returns `{ kind: 'committed', sha: <commitSha>, applied, refused }`.
- AC-9 [unit] For a GitLab repo row carrying `githubInstallationId: 9n`, neither `apply` nor `applyPrdEdits` calls `GitHubAppClient.mintInstallationToken`.
- AC-10 [unit] `FleetFlowAdvanceService.advance` starting a later feature `b` with base `'default'` on a GitLab repo reads the default-branch head with `getBranchHead` through `call(repo, 'read', ...)`, and when the spec blob sha is equal at that head and at the set sha, calls `GitLabAccessChecker.createBranch` through `call(repo, 'write', ...)` with `'feat/b'` and that head, and records the feature started on `feat/b`.
- AC-11 [unit] When `createBranch` returns `{ kind: 'exists', sha }` with a sha other than the base, the start pass stops the flow with reason `dispatch_refused` and detail `branch feat/b already exists`.
- AC-12 [unit] When the spec blob sha at the base differs from the one at the set sha on a GitLab repo, the start pass stops the flow with reason `spec_changed` and never calls `createBranch`.

### US-004: GitLab setup guide

**No-test:** documentation only.

- AC-1 [review] `docs/deployment/gitlab.md` has a section on the bot account stating that the write token should belong to a dedicated GitLab user, and that a human-account write token is accepted only with `--confirm-bot` and shown with a warning.
- AC-2 [review] The guide's tokens section states the read token needs scopes `read_api` and `read_repository`, the write token needs `api` and `write_repository`, and the bot user needs the Developer role (or above) on the project.
- AC-3 [review] The guide shows registration with `koda fleet repo add <group/app> --provider gitlab --read-token-file <f> --write-token-file <f>` (with `--host <url>` for self-hosted) and rotation with `koda fleet repo credentials <repoId>`.
- AC-4 [review] The guide's FIX section states that a FIX job needs a protected default branch the bot cannot push to, unless the repo's allow-unprotected override is on.
- AC-5 [review] The guide's self-hosted section states the host rule: https only, private and LAN hosts allowed, loopback, link-local and cloud-metadata addresses refused, no redirects, and a host name without `gitlab` refused with `gitlab_host_unclassified` until nax #2957 ships.
- AC-6 [review] The guide's token health section states that a 401 marks the token invalid until it is rotated and that a token expiring within 14 days shows as expiring.
- AC-7 [review] The guide's known differences section states that REVIEW jobs use the write token because GitLab has no comment-only token scope, and that koda polls GitLab instead of receiving webhooks.
