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
  `githubInstallationId` holds (a real GitLab row holds `null`), and never calls a `GitHubAppClient` method. The
  provider test comes before every `githubInstallationId === null` refusal; a GitHub row keeps today's code path
  unchanged, including those refusals. The private helpers typed `githubInstallationId: bigint`
  (`createFeatureBranch`, `pollAwaited`) are called only for GitHub rows; GitLab rows get their own helpers.
- **One `GitLabRepoCredentials.call` per GitLab client method call.** `call(repo, kind, fn)` marks the token
  invalid on a 401; wrapping a whole pass in one `call` would mark a token rotated mid-pass.
- **Token kind per request (design §5):** reads (`getBranchHead`, `getFile`, `getFileForUpdate`, `getMergeRequest`,
  `isSingleFileCommit`, `isOwnCallsRun`), including the re-read after a conflict, use `'read'`; writes
  (`createBranch`, `commitFile`) use `'write'`. `createBranch`'s own follow-up branch read runs inside the same
  `'write'` call, with the write token.
- **New constructor dependencies are appended** after the existing ones: `GitLabRepoCredentials`, then
  `GitLabAccessChecker`. `GitBrokerModule` already exports both and `FlowsModule` (`flows.module.ts`) already
  imports it.
- **Missing or invalid GitLab credentials stop a flow** where a GitHub App that is not installed stops it:
  `callsOutcomeForForgeError` classifies `gitlab_credentials_missing` and `gitlab_token_invalid` as `'failed'`.
  `vcs_encryption_key_missing` and the host refusals (`gitlab_host_blocked`, `gitlab_host_invalid`,
  `gitlab_host_unclassified`) keep the default `'retry'`: they are deployment or DNS faults an operator fixes, and
  the flow resumes on the next tick once fixed.
- **The spec-head read stays a preflight hint.** `FleetFlowAdvanceService.advance` catches every
  `RepoCheckException` from `readSpecHead` and ends the pass without a write (`fleet-flow-advance.service.ts:589-594`);
  a GitLab repo keeps that rule, exactly as a GitHub one does. The flow is stopped by the calls, start and watch
  passes, which classify the same failure.

### Integration

Read-only symbols (verified at main `cd4340e12`):

- `GitLabRepoCredentials.call<T>(repo: { id: string; host?: string }, kind: 'read' | 'write', fn: (access: GitLabAccess) => Promise<T>): Promise<T>` — `apps/api/src/fleet/git-broker/gitlab-repo-credentials.ts`; throws `RepoCheckException('gitlab_credentials_missing')` for a repo with no credential row.
- `GitLabAccessChecker.getBranchHead(access, branch): Promise<string>` (404 → `repo_not_found`), `getFile(access, path, ref): Promise<ForgeFile | null>` (`sha` is the GitLab `blob_id`), `getMergeRequest(access, iid): Promise<VcsPrStatus | null>` — `apps/api/src/fleet/git-broker/gitlab-access-checker.ts`. Private helpers `projectUrl(access)`, `guard(apiBase)` (host check before a request) and `fail(status)` (401 → `gitlab_token_invalid`, 403 → `app_permissions_insufficient`, else `provider_error`) are the pattern for the new methods.
- `PutFileResult` = `{ kind: 'committed'; commitSha } | { kind: 'conflict' } | { kind: 'refused' }` — `github-app-client.ts:13`.
- `prNumberFor(repo: Pick<FleetRepoRef, 'provider' | 'owner' | 'name' | 'host'>, url)` — `apps/api/src/fleet/sync/pr-attribution.service.ts:27`; already parses GitLab MR URLs including a host path prefix.
- `FleetReposService.findReviewRepo(id)` — returns `id, projectId, owner, name, githubInstallationId, defaultBranch, provider, host`.
- GitLab rows store `owner` as the full namespace path (`group/sub`) and `host` as the origin plus any path prefix (`https://gitlab.com`, `https://example.com/gitlab`); `@@unique([provider, host, owner, name])`.

Mutated symbols. The baseline exists only to locate the code; implement the target.

- `parseFlowInput` (`apps/api/src/fleet/flows/flow-input.ts:64-65`)
  - Baseline: validates `remoteUrl` with `parseGitHubUrl`.
  - Target: validates `remoteUrl` with the new `parseFlowRemoteUrl`; `normalized.remoteUrl` stays the input string.
- `FleetFlowsController.create` (`apps/api/src/fleet/flows/fleet-flows.controller.ts:73-121`)
  - Baseline: `parseGitHubUrl` → `findByIdentity('github', owner, name)` → GitHub mint and reads.
  - Target: `parseFlowRemoteUrl`; a `github` result keeps the baseline path; a `gitlab` result resolves the repo
    with `FleetReposService.findGitLabByRemoteUrl(url)`, runs the same project and permission checks, then reads the
    branch head and every spec through `call(repo, 'read', ...)`. Constructor gains `gitlabCredentials`, `gitlab`
    (appended).
- `FleetFlowAdvanceService.readSpecHead` (`fleet-flow-advance.service.ts:794-812`), `prNumberOf` (`:898-906`)
  - Baseline: GitHub mint + `getBranchHead`; `prNumberFor({ provider: 'github', ... })`.
  - Target: a GitLab row reads the head through `call(repo, 'read', a => gitlab.getBranchHead(a, flow.branch))`;
    `prNumberOf` passes the repo's own `provider` and `host`. Constructor gains `gitlabCredentials`, `gitlab`
    (appended); `featurePassDeps()` passes both.
- `FeaturePassDeps` (`fleet-flow-feature-passes.ts:17`)
  - Target: gains `gitlabCredentials: GitLabRepoCredentials` and `gitlab: GitLabAccessChecker`.
- `runMergeWatch` / `pollAwaited` (`fleet-flow-feature-passes.ts:240-359`)
  - Target: a GitLab row skips the GitHub mint and reads each awaited MR with
    `call(repo, 'read', a => gitlab.getMergeRequest(a, prNumber))`; the outcome rules (merged, closed, gone, retry,
    stop) are unchanged.
- `runFeatureStart` / `createFeatureBranch` / `specMatchesApproved` (`fleet-flow-feature-passes.ts:77-163`)
  - Target: a GitLab row reads the default-branch head and both spec blobs with the read token and creates the
    branch with `call(repo, 'write', a => gitlab.createBranch(a, branch, baseSha))`; the decision rules (`refused`,
    `exists` at the base, `exists` elsewhere) are unchanged.
- `FleetFlowCallsService.apply` / `applyPrdEdits` / `isOwnEarlierCommit` (`fleet-flow-calls.service.ts:57-175`)
  - Target: a GitLab row runs the same decision rules with `getBranchHead`, `getFileForUpdate` (pinned to the head),
    `commitFile` (with the file's `lastCommitId` as the lock), `isSingleFileCommit` and `isOwnCallsRun`. After a
    `conflict` the GitLab branch re-reads the file with `getFileForUpdate` on `target.branch` and compares
    `lastCommitId` (the lock it sent), not the blob sha: the same `lastCommitId` means nobody moved the file, so the
    branch refused the commit (`failed`); a moved or deleted file is `retry`. Constructor gains `gitlabCredentials`,
    `gitlab` (appended).
- `callsOutcomeForForgeError` (`apps/api/src/fleet/flows/flow-calls.ts:13`)
  - Target: also `'failed'` for `gitlab_credentials_missing` and `gitlab_token_invalid`.

### New GitLab client methods (US-001, US-002)

All on `GitLabAccessChecker`. Each calls `guard(access.target.apiBase)` before **every** request it sends (not only
the first) and sends the `private-token` header. Non-200/201 answers not listed below go through `fail(status)`.

The calls commit uses the commits API (`POST /repository/commits`), not the files API the design §5 table names,
because only the commits API answers with the new commit's id, which the flow records as the spec sha.

```ts
// US-001
createBranch(access, branch: string, sha: string):
  Promise<{ kind: 'created' } | { kind: 'exists'; sha: string } | { kind: 'refused' }>
// POST <project>/repository/branches?branch=<enc>&ref=<enc sha>
// 201 -> created. 400 (exists or invalid name) -> getBranchHead: found -> exists(sha), repo_not_found -> refused.
// 404 -> RepoCheckException('repo_not_found').

getFileForUpdate(access, path: string, ref: string):
  Promise<(ForgeFile & { lastCommitId: string }) | null>
// Same request and checks as getFile, plus `last_commit_id` (string, else provider_error). 404 -> null.

commitFile(access, path: string, input: { branch: string; content: Buffer; lastCommitId: string; message: string }):
  Promise<PutFileResult>
// POST <project>/repository/commits
//   { branch, commit_message: message,
//     actions: [{ action: 'update', file_path: path, content: <base64>, encoding: 'base64', last_commit_id }] }
// 201 -> committed(commitSha = body.id, string else provider_error).
// 400 or 409 -> conflict (GitLab answers a stale last_commit_id with 400). 404 -> repo_not_found.

// US-002
static readonly OWN_RUN_MAX_COMMITS = 50;
isSingleFileCommit(access, base: string, head: string, path: string): Promise<boolean>
isOwnCallsRun(access, base: string, head: string, own: { paths: readonly string[]; marker: string }): Promise<boolean>
// Both: GET <project>/repository/compare?from=<base>&to=<head>&straight=false
//   404 -> repo_not_found. `compare_timeout: true` -> false. Empty `commits` or empty `diffs` -> false.
// GitLab compare commits carry no parents and no full message, so each listed commit is read with
//   GET <project>/repository/commits/<id> (parent_ids, message); a 404 there -> false.
// Linear-chain rule: walking from head through each commit's parent reaches base; every commit on the walk has
//   exactly one parent; every listed commit is on the walk and the walk visits no unlisted commit.
// isSingleFileCommit: exactly one commit, its id === head, parent_ids === [base], exactly one diff with
//   old_path === new_path === path and new_file, deleted_file, renamed_file all false.
// isOwnCallsRun: 1..OWN_RUN_MAX_COMMITS commits (more -> false before any commit read), the linear-chain rule,
//   every message contains own.marker, and every diff has old_path === new_path, that path in own.paths, and
//   new_file, deleted_file, renamed_file all false.
```

### Remote URL resolution (US-003)

New `apps/api/src/fleet/flows/flow-remote-url.ts`:

```ts
export type FlowRemote =
  | { provider: 'github'; owner: string; name: string }
  | { provider: 'gitlab'; url: string };
export function parseFlowRemoteUrl(url: string): FlowRemote;
```

Rules, in order:

1. A URL `parseGitHubUrl` accepts returns the `github` variant with its lowercased `owner` and `repo` (as `name`).
2. The URL must parse with `new URL`; its protocol must be `https:`; it must carry no username, no password, no
   query and no fragment; its hostname must not be `github.com` or `www.github.com` (a github.com URL rule 1
   refused stays refused).
3. The path is normalised by removing one trailing `/`, then one trailing `.git` (case-insensitive). The normalised
   path must have at least two segments, none empty, `.` or `..`.
4. It returns the `gitlab` variant with `url` = `(origin + normalised path).toLowerCase()`.

Any URL failing rule 2 or 3 throws `ValidationAppException` `skills.unsupportedHost` (what `parseGitHubUrl`
throws), so `parseFlowInput` reports `remoteUrl`.

New `FleetReposService.findGitLabByRemoteUrl(url: string): Promise<FleetRepoRecord | null>` backed by a new
`IFleetRepoRepository.findGitLabByName(name)` (provider `gitlab`, name equal case-insensitively, ordered by
`createdAt`, then `id`). The service keeps the first row whose
`(host without trailing '/') + '/' + owner + '/' + name`, lowercased, equals `url`. A host with a path prefix
therefore matches only URLs under that prefix, and the same path on another host never matches.

### Failure Handling

| Where | Condition | Outcome |
|:--|:--|:--|
| Controller, GitLab | `gitlab_credentials_missing`, `gitlab_token_invalid`, `app_permissions_insufficient` | 409 `fleet.flows.gitlabNotConnected` |
| Controller, GitLab | `repo_not_found` from the branch read | 409 `fleet.flows.branchNotFound` |
| Controller, GitLab | `provider_unreachable`, `provider_error`, `vcs_encryption_key_missing` | 503 `fleet.flows.forgeUnavailable` |
| Controller, GitLab | any other `RepoCheckException` reason | rethrown (422 `fleet.repoCheck`) |
| Spec-head read, GitLab | any `RepoCheckException` | pass ends with no write (existing preflight rule) |
| Merge watch / start / calls / PRD edits, GitLab | credentials missing or token invalid | `'failed'` per `callsOutcomeForForgeError`: calls and PRD edits return `failed` with the reason as detail; start and watch stop `dispatch_refused` with the reason as detail |
| Merge watch / start / calls / PRD edits, GitLab | host refusal, encryption key missing, provider error | `retry` (next tick) |
| `commitFile` | 400/409 | `conflict`; re-read with the same `lastCommitId` → `failed` `spec write refused` / `prd.json write refused`, otherwise `retry` |

New API i18n key `flows.gitlabNotConnected.409` in `apps/api/src/i18n/en/fleet.json`
("Koda cannot read this GitLab repository: its tokens are missing or invalid; rotate them with koda fleet repo
credentials") and `apps/api/src/i18n/zh/fleet.json` ("Koda 无法读取此 GitLab 仓库：其令牌缺失或无效；请使用 koda fleet repo
credentials 轮换令牌").

## Out of Scope

- An ssh remote URL (`git@host:group/app.git`) stays refused for GitLab, as it is for GitHub.
- Thread-entry flows: they already run one feature on the thread's project repo, and threads on GitLab shipped in F3; nothing in this feature changes the thread entry.
- nax-side flow support (`nax-flow__send` and the forge kind for self-hosted hosts, nax #2957) is nax work, not koda work.
- Per-job GitLab token minting stays deferred (design §6.4).
- Inbound GitLab webhooks stay ruled out (Track 3 ruling 2026-09-27); flows keep polling.
- The live check of design §9 step 5 (a flow end to end on `freqtrade/quant-crypto-trader`) is an operator step after deployment, not a story.
- Sharing one forge-neutral implementation of the calls algorithm between GitHub and GitLab is not done: the GitHub path stays byte-for-byte as it is so its existing specs keep proving it.
- US-005 only: a GitLab spec-head read failure does not stop the flow; the read is a preflight hint and the existing catch ends the pass with no write, as on GitHub.
- US-006 only: a GitLab push rule or protected-branch refusal of the calls commit surfaces as `app_permissions_insufficient` and fails the calls pass; no separate `refused` mapping for a GitLab 403 is added.
- US-002 only: `isOwnCallsRun` refuses a run longer than 50 commits even if it is the flow's own; a flow's set has at most 20 features, so a longer own run does not occur.

## Stories

This is one capability (flows on GitLab) split along its seams: two client stories, the entry route in two parts,
the advance reads, the two write passes, and the guide.

**US-001: GitLab client write calls.** Workdir: `apps/api`. No dependencies.
Adds `createBranch`, `getFileForUpdate` and `commitFile` to `GitLabAccessChecker`.

**US-002: GitLab client compare checks.** Workdir: `apps/api`. No dependencies.
Adds `isSingleFileCommit`, `isOwnCallsRun` and `OWN_RUN_MAX_COMMITS` to `GitLabAccessChecker`.

**US-003: GitLab remote URL and repo lookup.** Workdir: `apps/api`. No dependencies.
Adds `parseFlowRemoteUrl`, switches `parseFlowInput` to it, and adds `FleetReposService.findGitLabByRemoteUrl` with
`IFleetRepoRepository.findGitLabByName`.

**US-004: Nax flow entry route on GitLab.** Workdir: `apps/api`. Depends on US-003.
`FleetFlowsController.create` resolves and reads a GitLab repo, and adds the `flows.gitlabNotConnected.409` key.

**US-005: Flow spec-head read, merge watch and PR number on GitLab.** Workdir: `apps/api`. Depends on US-004.
`readSpecHead`, the merge watch and `prNumberOf` on a GitLab repo; `FeaturePassDeps` gains the GitLab collaborators;
`callsOutcomeForForgeError` classifies the GitLab credential reasons.

**US-006: Flow calls and PRD edits commits on GitLab.** Workdir: `apps/api`. Depends on US-001, US-002, US-005.
`FleetFlowCallsService.apply` and `applyPrdEdits` on a GitLab repo.

**US-007: Feature start on GitLab.** Workdir: `apps/api`. Depends on US-001, US-005.
The feature-start pass creates the feature branch on a GitLab repo.

**US-008: GitLab setup guide.** Workdir: `.`. No dependencies.
**No-test:** documentation only. Writes `docs/deployment/gitlab.md` for operators.

### Context Files

**US-001**
- `apps/api/src/fleet/git-broker/gitlab-access-checker.ts` — `projectUrl`, `guard`, `fail`, `getBranchHead`, `getFile` as the pattern
- `apps/api/src/fleet/git-broker/gitlab-access-checker.spec.ts` — how requests and the host check are stubbed; shared tables AC-11 and AC-12
- `apps/api/src/fleet/git-broker/github-app-client.ts` — `createBranch` and `putFile`, the GitHub rules the GitLab methods mirror

**US-002**
- `apps/api/src/fleet/git-broker/gitlab-access-checker.ts` — `projectUrl`, `guard`, `fail`
- `apps/api/src/fleet/git-broker/gitlab-access-checker.spec.ts` — how requests and the host check are stubbed
- `apps/api/src/fleet/git-broker/github-app-client.ts` — `isSingleFileCommit` and `isOwnCallsRun`, the GitHub rules mirrored

**US-003**
- `apps/api/src/fleet/flows/flow-input.ts` — `parseFlowInput` remote URL check
- `apps/api/src/skills/github-url.ts` — `parseGitHubUrl` and its refusal
- `apps/api/src/fleet/repos/prisma-fleet-repo.repository.ts` — `findByIdentity` as the pattern for `findGitLabByName`
- `apps/api/src/fleet/repos/fleet-repos.service.ts` — `findByIdentity`
- `apps/api/test/integration/fleet/fleet-repo-fix-unprotected-route.integration.spec.ts` — how a GitLab repo row is seeded

**US-004**
- `apps/api/src/fleet/flows/fleet-flows.controller.ts` — `create`
- `apps/api/src/fleet/flows/fleet-flows.controller.spec.ts` — how the controller is stubbed
- `apps/api/src/fleet/flows/flows.module.spec.ts` — `StubGitBrokerModule`

**US-005**
- `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` — `readSpecHead`, `prNumberOf`, `featurePassDeps`
- `apps/api/src/fleet/flows/fleet-flow-feature-passes.ts` — `FeaturePassDeps`, `runMergeWatch`, `pollAwaited`
- `apps/api/src/fleet/flows/fleet-flow-merge-watch.spec.ts` — how the watch is driven through `advance`
- `apps/api/src/fleet/flows/fleet-flow-advance-review.spec.ts` — `RUN_PR` and the `markStep` PR-number assertion

**US-006**
- `apps/api/src/fleet/flows/fleet-flow-calls.service.ts` — `apply`, `applyPrdEdits`, `isOwnEarlierCommit`
- `apps/api/src/fleet/flows/fleet-flow-calls.service.spec.ts` — how the repo and forge are stubbed
- `apps/api/src/fleet/flows/flow-calls.ts` — `buildFlowCalls`, `callsOutcomeForForgeError`

**US-007**
- `apps/api/src/fleet/flows/fleet-flow-feature-passes.ts` — `runFeatureStart`, `createFeatureBranch`, `specMatchesApproved`
- `apps/api/src/fleet/flows/fleet-flow-feature-start.spec.ts` — how the start pass is driven through `FleetFlowAdvanceService.advance`

**US-008**
- `docs/superpowers/specs/2026-11-16-gitlab-parity-design.md` — §6 credentials, §7 surfaces, §8 host rule
- `docs/deployment/runner.md` — the existing operator guide's tone and the `koda fleet repo add` example
- `apps/cli/src/commands/fleet-repo.ts` — the real `add` and `credentials` flags

### Creates

**US-001**
- `apps/api/src/fleet/git-broker/gitlab-access-checker.flow-writes.spec.ts` — US-001 ACs

**US-002**
- `apps/api/src/fleet/git-broker/gitlab-access-checker.compare.spec.ts` — US-002 ACs

**US-003**
- `apps/api/src/fleet/flows/flow-remote-url.ts` — `parseFlowRemoteUrl`, `FlowRemote`
- `apps/api/src/fleet/flows/flow-remote-url.spec.ts` — US-003 AC-1 to AC-6
- `apps/api/test/integration/fleet/fleet-repo-gitlab-remote.integration.spec.ts` — `findGitLabByRemoteUrl` against Postgres

**US-004**
- `apps/api/src/fleet/flows/fleet-flows.controller.gitlab.spec.ts` — the controller's GitLab branch

**US-005**
- `apps/api/src/fleet/flows/fleet-flow-advance-gitlab.spec.ts` — the GitLab spec-head read, merge watch and PR number

**US-006**
- `apps/api/src/fleet/flows/fleet-flow-calls-gitlab.spec.ts` — the GitLab branches of `apply` and `applyPrdEdits`

**US-007**
- `apps/api/src/fleet/flows/fleet-flow-feature-start-gitlab.spec.ts` — the GitLab branch of the start pass

**US-008**
- `docs/deployment/gitlab.md` — the GitLab setup guide

### Modifies

US-002, US-003, US-006, US-007 and US-008 change no existing file beyond their target source files: their cases live in new spec files, and the existing GitHub specs pass unchanged.

**US-001**
- `apps/api/src/fleet/git-broker/gitlab-access-checker.spec.ts` — gains rows for `createBranch`, `getFileForUpdate` and `commitFile` in the shared tables "AC-11: %s maps HTTP failures" (401, 403, 500) and "AC-12: %s blocks loopback hosts before requesting"; every existing case and row stays.

**US-004**
- `apps/api/src/fleet/flows/flows.module.spec.ts` — `StubGitBrokerModule` provides and exports only `GitHubAppClient`; it now also provides and exports `GitLabRepoCredentials` and `GitLabAccessChecker` (`useValue: {}`), because `FleetFlowsController`, `FleetFlowAdvanceService` and `FleetFlowCallsService` now inject them. Every existing assertion stays.
- `apps/api/src/i18n/en/fleet.json` — adds `flows.gitlabNotConnected.409`; every existing key stays.
- `apps/api/src/i18n/zh/fleet.json` — adds `flows.gitlabNotConnected.409`; every existing key stays.

**US-005**
- `apps/api/src/fleet/flows/flow-calls.spec.ts` — "marks known repository setup failures as failed" gains `gitlab_credentials_missing` and `gitlab_token_invalid`; "retries other forge failures" stays.

### Seams

- US-001 adds `createBranch`, `getFileForUpdate` and `commitFile`; US-006 consumes `getFileForUpdate` and `commitFile` (pinned at `FleetFlowCallsService.apply` / `applyPrdEdits`, US-006 AC-1, AC-7); US-007 consumes `createBranch` (pinned at `FleetFlowAdvanceService.advance`, US-007 AC-1).
- US-002 adds `isSingleFileCommit` and `isOwnCallsRun`; US-006 consumes them (US-006 AC-4, AC-5).
- US-003 adds `parseFlowRemoteUrl` and `findGitLabByRemoteUrl`; US-004 consumes them at `FleetFlowsController.create` (US-004 AC-1).
- US-005 adds `FeaturePassDeps.gitlabCredentials` and `FeaturePassDeps.gitlab`; US-007's start pass reads them.

## Acceptance Criteria

### US-001: GitLab client write calls

- AC-1 [unit] `GitLabAccessChecker.createBranch(access, 'feat/a', 'abc')` sends `POST <apiBase>/projects/<projectId>/repository/branches?branch=feat%2Fa&ref=abc` with the `private-token` header set to `access.token`.
- AC-2 [unit] `createBranch` returns `{ kind: 'created' }` for a 201 answer.
- AC-3 [unit] When the branch POST answers 400 and the follow-up `GET <apiBase>/projects/<projectId>/repository/branches/feat%2Fa` answers 200 with `commit.id: 'def'`, `createBranch` returns `{ kind: 'exists', sha: 'def' }`.
- AC-4 [unit] When the branch POST answers 400 and the follow-up branch GET answers 404, `createBranch` returns `{ kind: 'refused' }`.
- AC-5 [unit] When the host check refuses the second request of `createBranch` (the follow-up branch GET after a 400), `createBranch` throws that refusal and sends no second request.
- AC-6 [unit] `GitLabAccessChecker.getFileForUpdate(access, 'docs/a.md', 'c1')` returns `{ sha: 'b9', size: 2, content: Buffer.from('hi'), lastCommitId: 'lc1' }` for a 200 answer `{ blob_id: 'b9', size: 2, encoding: 'base64', content: 'aGk=', last_commit_id: 'lc1' }`.
- AC-7 [unit] `getFileForUpdate` returns null for a 404 answer.
- AC-8 [unit] A 200 file answer without a string `last_commit_id` makes `getFileForUpdate` throw `RepoCheckException` with reason `provider_error`.
- AC-9 [unit] `GitLabAccessChecker.commitFile(access, 'docs/a.md', { branch: 'feat/a', content: Buffer.from('hi'), lastCommitId: 'lc1', message: 'm' })` sends `POST <apiBase>/projects/<projectId>/repository/commits` with body `{ branch: 'feat/a', commit_message: 'm', actions: [{ action: 'update', file_path: 'docs/a.md', content: 'aGk=', encoding: 'base64', last_commit_id: 'lc1' }] }`.
- AC-10 [unit] `commitFile` returns `{ kind: 'committed', commitSha: 'n1' }` for a 201 answer `{ id: 'n1' }`.
- AC-11 [unit] `commitFile` returns `{ kind: 'conflict' }` for a 400 answer.
- AC-12 [unit] `commitFile` returns `{ kind: 'conflict' }` for a 409 answer.
- AC-13 [unit] `commitFile` throws `RepoCheckException` with reason `app_permissions_insufficient` for a 403 answer.
- AC-14 [unit] `commitFile` throws `RepoCheckException` with reason `provider_error` for a 201 answer whose `id` is not a string.

### US-002: GitLab client compare checks

- AC-1 [unit] `GitLabAccessChecker.isSingleFileCommit(access, 'b0', 'h1', 'docs/a.md')` sends `GET <apiBase>/projects/<projectId>/repository/compare?from=b0&to=h1&straight=false` and `GET <apiBase>/projects/<projectId>/repository/commits/h1`, and returns true when the compare lists commits `[{ id: 'h1' }]` and diffs `[{ old_path: 'docs/a.md', new_path: 'docs/a.md', new_file: false, deleted_file: false, renamed_file: false }]` and the commit answers `parent_ids: ['b0']`.
- AC-2 [unit] `isSingleFileCommit` returns false when the commit `h1` answers `parent_ids: ['x9']`, with the compare answer of AC-1.
- AC-3 [unit] `isSingleFileCommit` returns false when the compare answer of AC-1 has a second diff for another path.
- AC-4 [unit] `isSingleFileCommit` returns false when the one diff of AC-1 has `new_path: 'docs/b.md'`.
- AC-5 [unit] `isSingleFileCommit` returns false when the one diff of AC-1 has `renamed_file: true`.
- AC-6 [unit] `isSingleFileCommit` returns false without reading any commit when the compare answers `compare_timeout: true`.
- AC-7 [unit] `GitLabAccessChecker.isOwnCallsRun(access, 'b0', 'h2', { paths: ['a.md', 'b.md'], marker: 'flow calls from SPEC_REVIEW job j1' })` returns true when the compare lists commits `h1` and `h2` and diffs modifying only `a.md` and `b.md` (each with `new_file`, `deleted_file`, `renamed_file` false), commit `h1` answers `parent_ids: ['b0']`, commit `h2` answers `parent_ids: ['h1']`, and both messages contain the marker.
- AC-8 [unit] `isOwnCallsRun` returns false for the answers of AC-7 when commit `h2`'s message lacks the marker.
- AC-9 [unit] `isOwnCallsRun` returns false for the answers of AC-7 when one diff modifies `c.md`, a path outside `own.paths`.
- AC-10 [unit] `isOwnCallsRun` returns false for the answers of AC-7 when the `a.md` diff has `new_file: true`.
- AC-11 [unit] `isOwnCallsRun` returns false for the answers of AC-7 when commit `h2` answers `parent_ids: ['h1', 'x9']` (a merge commit).
- AC-12 [unit] `isOwnCallsRun` returns false when the compare lists `h1`, `h2` and `h3` but the walk from `h2` through `h1` reaches `b0` without visiting `h3`.
- AC-13 [unit] `isOwnCallsRun` returns false without reading any commit when the compare lists 51 commits, and returns false when a commit read answers 404.
- AC-14 [unit] When the host check refuses the third request of `isOwnCallsRun` (the second commit read), `isOwnCallsRun` throws that refusal and sends no further request.

### US-003: GitLab remote URL and repo lookup

- AC-1 [unit] `parseFlowRemoteUrl('https://github.com/Org/Repo.git')` returns `{ provider: 'github', owner: 'org', name: 'repo' }`.
- AC-2 [unit] `parseFlowRemoteUrl('https://GitLab.example.com/Grp/Sub/App.git/')` returns `{ provider: 'gitlab', url: 'https://gitlab.example.com/grp/sub/app' }`.
- AC-3 [unit] `parseFlowRemoteUrl('http://gitlab.com/grp/app')` throws `ValidationAppException` `skills.unsupportedHost`.
- AC-4 [unit] `parseFlowRemoteUrl('https://user:pw@gitlab.com/grp/app')` throws `ValidationAppException` `skills.unsupportedHost`.
- AC-5 [unit] `parseFlowRemoteUrl('https://github.com/org/repo/tree/main')` throws `ValidationAppException` `skills.unsupportedHost` instead of returning a `gitlab` variant.
- AC-6 [unit] `parseFlowRemoteUrl('https://gitlab.com/app.git')` throws `ValidationAppException` `skills.unsupportedHost`, because one segment remains after `.git` is removed.
- AC-7 [unit] `parseFlowInput` with entry `'NAX'` accepts `remoteUrl: 'https://gitlab.com/grp/app.git'` and returns it unchanged as `remoteUrl`.
- AC-8 [unit] `parseFlowInput` with entry `'NAX'` reports the property `remoteUrl` for `remoteUrl: 'git@gitlab.com:grp/app.git'`.
- AC-9 [integration] With GitLab repos `{ host: 'https://gitlab.example.com', owner: 'Grp/Sub', name: 'App' }` and `{ host: 'https://gitlab.com', owner: 'Grp/Sub', name: 'App' }` stored, `FleetReposService.findGitLabByRemoteUrl('https://gitlab.example.com/grp/sub/app')` returns the first one.
- AC-10 [integration] With a GitLab repo `{ host: 'https://example.com/gitlab', owner: 'grp', name: 'app' }` stored, `findGitLabByRemoteUrl('https://example.com/gitlab/grp/app')` returns it.
- AC-11 [integration] With only that prefixed repo stored, `findGitLabByRemoteUrl('https://example.com/grp/app')` returns null.
- AC-12 [integration] With a GitHub repo `{ owner: 'grp', name: 'app' }` stored and no GitLab repo, `findGitLabByRemoteUrl('https://github.example.com/grp/app')` returns null.

### US-004: Nax flow entry route on GitLab

- AC-1 [unit] `FleetFlowsController.create` with `remoteUrl: 'https://gitlab.com/grp/app'`, a repo `{ provider: 'gitlab', githubInstallationId: null }` returned by `FleetReposService.findGitLabByRemoteUrl('https://gitlab.com/grp/app')`, and a caller holding `fleet.flow.create`, calls `GitLabRepoCredentials.call` with the repo and `'read'` and `GitLabAccessChecker.getBranchHead` with `branch`.
- AC-2 [unit] In the call of AC-1, when `getBranchHead` resolves `specSha`, `create` calls `GitLabAccessChecker.getFile` through `call(repo, 'read', ...)` with each feature's `specPath` and `specSha`, then `ApprovalRouteGate.run` with input `{ projectId, repoId: repo.id, body }`.
- AC-3 [unit] In the call of AC-1, `create` never calls a `GitHubAppClient` method and never calls `FleetReposService.findByIdentity`.
- AC-4 [unit] For a GitLab repo row carrying `githubInstallationId: 9n`, `create` still takes the GitLab path and never calls `GitHubAppClient.mintReadOnlyToken`.
- AC-5 [unit] When `findGitLabByRemoteUrl` resolves null, `create` throws 404 `fleet.flows.repoNotFound`.
- AC-6 [unit] When the repo's project is not among `ProjectsService.findAllForPrincipal(principal)`, `create` throws 404 `fleet.flows.repoNotFound` and makes no GitLab call.
- AC-7 [unit] When the caller lacks `fleet.flow.create` in the repo's project, `create` throws 403 and makes no GitLab call.
- AC-8 [unit] When `getBranchHead` resolves a sha other than `specSha`, `create` throws 409 `fleet.flows.specShaNotHead` and never calls `ApprovalRouteGate.run`.
- AC-9 [unit] When `getFile` resolves null for a feature's `specPath`, `create` throws 422 `fleet.flows.specMissing` naming that path.
- AC-10 [unit] When `GitLabRepoCredentials.call` rejects with `RepoCheckException('gitlab_credentials_missing')`, `create` throws 409 `fleet.flows.gitlabNotConnected`.
- AC-11 [unit] When `GitLabRepoCredentials.call` rejects with `RepoCheckException('gitlab_token_invalid')`, `create` throws 409 `fleet.flows.gitlabNotConnected`.
- AC-12 [unit] When `getBranchHead` rejects with `RepoCheckException('repo_not_found')`, `create` throws 409 `fleet.flows.branchNotFound`.
- AC-13 [unit] When `getBranchHead` rejects with `RepoCheckException('provider_error')`, `create` throws 503 `fleet.flows.forgeUnavailable`.

### US-005: Flow spec-head read, merge watch and PR number on GitLab

- AC-1 [unit] `FleetFlowAdvanceService.advance` on an APPROVED NAX flow whose repo is `{ provider: 'gitlab', githubInstallationId: null }` reads the spec head with `GitLabAccessChecker.getBranchHead(access, flow.branch)` through `call(repo, 'read', ...)` and never calls `GitHubAppClient.mintReadOnlyToken`.
- AC-2 [unit] On that flow, when `getBranchHead` rejects with `RepoCheckException('gitlab_token_invalid')`, `advance` ends the pass without stopping the flow and without a write.
- AC-3 [unit] `FleetFlowAdvanceService.advance` on a WAITING_MERGE flow on a GitLab repo `{ provider: 'gitlab', githubInstallationId: null }`, whose awaited feature has `prNumber: 12`, calls `GitLabAccessChecker.getMergeRequest` with the access and `12` through `call(repo, 'read', ...)`, and never calls `GitHubAppClient.mintThreadReadToken`.
- AC-4 [unit] In that merge watch, when `getMergeRequest` resolves `{ merged: true }`, the feature is recorded `MERGED`.
- AC-5 [unit] In that merge watch, when `getMergeRequest` resolves `{ merged: false, state: 'closed' }`, the flow is stopped with reason `pr_closed`.
- AC-6 [unit] In that merge watch, when `getMergeRequest` resolves null, the flow is stopped with reason `pr_closed`.
- AC-7 [unit] In that merge watch, when `GitLabRepoCredentials.call` rejects with `RepoCheckException('gitlab_token_invalid')`, the flow is stopped with reason `dispatch_refused` and detail `gitlab_token_invalid`.
- AC-8 [unit] In that merge watch, when `getMergeRequest` rejects with `RepoCheckException('provider_error')`, the pass writes nothing and the flow keeps waiting.
- AC-9 [unit] `callsOutcomeForForgeError('gitlab_credentials_missing')` returns `'failed'`.
- AC-10 [unit] `callsOutcomeForForgeError('gitlab_token_invalid')` returns `'failed'`.
- AC-11 [unit] `callsOutcomeForForgeError('gitlab_host_blocked')` returns `'retry'`.
- AC-12 [unit] For a RUNNING flow on GitLab repo `{ provider: 'gitlab', host: 'https://gitlab.com', owner: 'grp', name: 'app' }` whose finished RUN job has `resultPrUrl: 'https://gitlab.com/grp/app/-/merge_requests/7'` and a claimed review head, `FleetFlowAdvanceService.advance` records the REVIEW step with `steps.markStep(flowId, featureId, 'REVIEW', { flowState: 'RUNNING', prNumber: 7 })`.

### US-006: Flow calls and PRD edits commits on GitLab

- AC-1 [unit] `FleetFlowCallsService.apply(flow, action, 'h0', target)` on a GitLab repo `{ provider: 'gitlab', githubInstallationId: null }` whose branch head is `'h0'` reads the head and then the spec with `GitLabAccessChecker.getFileForUpdate(access, target.specPath, 'h0')`, each through `call(repo, 'read', ...)`, then calls `GitLabAccessChecker.commitFile` through `call(repo, 'write', ...)` with `target.specPath`, the built calls text, the file's `lastCommitId`, `target.branch` and message `docs(<feature>): flow calls from <step> job <jobId>`, and returns `{ kind: 'committed', specSha: <commitSha> }`.
- AC-2 [unit] On that GitLab repo, when the branch head is not `expectedHead` and the spec does not yet carry the calls, `apply` returns `{ kind: 'stale', head }` and never calls `commitFile`.
- AC-3 [unit] When `commitFile` returns `{ kind: 'conflict' }` and the re-read of the spec with `getFileForUpdate` on `target.branch` through `call(repo, 'read', ...)` has the same `lastCommitId`, `apply` returns `{ kind: 'failed', detail: 'spec write refused' }`; when the re-read has a different `lastCommitId`, `apply` returns `{ kind: 'retry' }`.
- AC-4 [unit] When the spec at the branch head already carries the expected calls block and `GitLabAccessChecker.isSingleFileCommit(access, expectedHead, head, target.specPath)` resolves true through `call(repo, 'read', ...)`, `apply` returns `{ kind: 'committed', specSha: head }` and never calls `commitFile`.
- AC-5 [unit] For a set replay target whose head carries the calls, when `isSingleFileCommit` resolves false and `GitLabAccessChecker.isOwnCallsRun` (called through `call(repo, 'read', ...)` with `target.replay.reviewedHead`, the head, and `{ paths: target.replay.paths, marker: 'flow calls from <step> job <jobId>' }`) resolves true, `apply` returns `{ kind: 'committed', specSha: head }`; when it resolves false, `apply` returns `{ kind: 'stale', head }`.
- AC-6 [unit] When `GitLabRepoCredentials.call` rejects with `RepoCheckException('gitlab_credentials_missing')`, `apply` returns `{ kind: 'failed', detail: 'gitlab_credentials_missing' }`.
- AC-7 [unit] `FleetFlowCallsService.applyPrdEdits` on a GitLab repo whose head equals `expectedHead` commits `.nax/features/<feature>/prd.json` through `commitFile` with `call(repo, 'write', ...)` and message `chore(<feature>): flow PRD edits from PRD_REVIEW job <jobId>`, and returns `{ kind: 'committed', sha: <commitSha>, applied, refused }`.
- AC-8 [unit] When the GitLab `prd.json` has no edit to apply (`applied === 0`), `applyPrdEdits` returns `{ kind: 'unchanged', refused }` and never calls `commitFile`.
- AC-9 [unit] When the GitLab head moved and `isSingleFileCommit(access, expectedHead, head, '.nax/features/<feature>/prd.json')` resolves false, `applyPrdEdits` returns `{ kind: 'stale', head }`.
- AC-10 [unit] When the GitLab head moved, the file at the head equals the edits applied to the file at `expectedHead`, and `isSingleFileCommit` resolves true, `applyPrdEdits` returns `{ kind: 'committed', sha: head, applied, refused }`.
- AC-11 [unit] When `commitFile` returns `{ kind: 'conflict' }` in `applyPrdEdits` and the re-read has the same `lastCommitId`, `applyPrdEdits` returns `{ kind: 'failed', detail: 'prd.json write refused' }`; with a different `lastCommitId` it returns `{ kind: 'retry' }`.
- AC-12 [unit] For a GitLab repo row carrying `githubInstallationId: 9n`, neither `apply` nor `applyPrdEdits` calls `GitHubAppClient.mintInstallationToken`.

### US-007: Feature start on GitLab

- AC-1 [unit] `FleetFlowAdvanceService.advance` starting a later feature `b` with base `'default'` on a GitLab repo `{ provider: 'gitlab', githubInstallationId: null }` reads the default-branch head with `getBranchHead` through `call(repo, 'read', ...)`, and when the spec blob sha read with `getFile` through `call(repo, 'read', ...)` is equal at that head and at the set sha, calls `GitLabAccessChecker.createBranch` through `call(repo, 'write', ...)` with `'feat/b'` and that head, and records the feature started on `feat/b`.
- AC-2 [unit] When `createBranch` returns `{ kind: 'exists', sha }` with the base sha, the start pass records the feature started on `feat/b` (a crash leftover of its own).
- AC-3 [unit] When `createBranch` returns `{ kind: 'exists', sha }` with a sha other than the base, the start pass stops the flow with reason `dispatch_refused` and detail `branch feat/b already exists`.
- AC-4 [unit] When `createBranch` returns `{ kind: 'refused' }`, the start pass stops the flow with reason `dispatch_refused` and detail `branch feat/b not created`.
- AC-5 [unit] When the spec blob sha at the base differs from the one at the set sha on a GitLab repo, the start pass stops the flow with reason `spec_changed` and never calls `createBranch`.
- AC-6 [unit] When `GitLabRepoCredentials.call` rejects with `RepoCheckException('gitlab_credentials_missing')`, the start pass stops the flow with reason `dispatch_refused` and detail `gitlab_credentials_missing`.
- AC-7 [unit] When `createBranch` rejects with `RepoCheckException('provider_error')`, the start pass writes nothing and the feature is started on a later tick.
- AC-8 [unit] For a GitLab repo row carrying `githubInstallationId: 9n`, the start pass never calls `GitHubAppClient.mintInstallationToken`.

### US-008: GitLab setup guide

**No-test:** documentation only.

- AC-1 [review] `docs/deployment/gitlab.md` has a section on the bot account stating that the write token should belong to a dedicated GitLab user, and that a human-account write token is accepted only with `--confirm-bot` and shown with a warning.
- AC-2 [review] The guide's tokens section states the read token needs scopes `read_api` and `read_repository`, the write token needs `api` and `write_repository`, and the bot user needs the Developer role (or above) on the project.
- AC-3 [review] The guide shows registration with `koda fleet repo add <group/app> --provider gitlab --read-token-file <f> --write-token-file <f>` (with `--host <url>` for self-hosted) and rotation with `koda fleet repo credentials <repoId>`.
- AC-4 [review] The guide's FIX section states that a FIX job needs a protected default branch the bot cannot push to, unless the repo's `fixAllowUnprotected` override is on.
- AC-5 [review] The guide's self-hosted section states the host rule: https only, private and LAN hosts allowed, loopback, link-local and cloud-metadata addresses refused, no redirects, and a host name without `gitlab` refused with `gitlab_host_unclassified` until nax #2957 ships.
- AC-6 [review] The guide's token health section states that a 401 marks the token invalid until it is rotated and that a token expiring within 14 days shows as expiring.
- AC-7 [review] The guide's known differences section states that REVIEW jobs use the write token because GitLab has no comment-only token scope, and that koda polls GitLab instead of receiving webhooks.
