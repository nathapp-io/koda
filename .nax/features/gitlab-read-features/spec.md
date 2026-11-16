<!-- spec-writing: completed-through-phase-5 -->
# SPEC: GitLab read features (GitLab parity F3)

## Summary

Feature 3 of 4 of GitLab parity for the koda fleet. The owner approved the design on 2026-11-16:
`docs/superpowers/specs/2026-11-16-gitlab-parity-design.md` (sections 5, 6.2 and 6.5). Feature 1
(`gitlab-repo-credentials`, PR #472) gave each GitLab fleet repo its own host, project id and two stored tokens.
Feature 2 (`gitlab-jobs`, PR #473) opened REVIEW, FIX and AGENT jobs on GitLab and made the git broker answer the
per-repository read-only mint of a GitLab repo with its read token.

This feature opens to GitLab repos the fleet features that read a repo or a merge request, where today each one
refuses GitLab:

- threads with project code: a PROJECT session lists a GitLab repo with stored credentials as fetchable, and the
  runner's token request for it is granted;
- the project brief: a thread's repository context is read from a GitLab repo's default branch;
- the knowledge index: a GitLab repo's default-branch Markdown is indexed, and the poller queues GitLab repos;
- PR rulings: a draft RUN on a GitLab merge request can be ruled, the item-index check reads the MR's notes, and a
  FIX on a GitLab MR carries the pending rulings;
- review events: a reviewer's disagreement on a GitLab MR thread can mint a review decision.

Every read uses the repo's **read** token and never the write token. No GitHub behaviour changes: the GitHub
paths make the same forge calls and return the same results (some projections gain fields that are `null` or
`false` for a GitHub repo).

## Motivation

After features 1 and 2, a GitLab repo can be registered and can run every job kind, but the features that read
its code or its merge requests still check `provider === 'github'` or `githubInstallationId !== null` and stop:

- `project-repos-assign.ts` lists every GitLab repo as `not a GitHub repository`, so a PROJECT thread never reads
  GitLab code, and the token fence refuses its token request with `repo_not_assigned`.
- `ProjectBriefService` answers `Repository context: unavailable (not a GitHub repository)`.
- `KnowledgeRepoIndexer` records every GitLab repo `skipped` with `not a GitHub repository`, and the poller reads
  only GitHub repos.
- `PrismaFleetPrRulingRepository` computes no PR number for a GitLab job, so `POST .../rulings` answers 409
  "Only draft RUN jobs with a GitHub pull request can be ruled"; `snapshotForFix` answers
  `notSent: 'head-unreadable'` for every GitLab FIX.
- `ReviewEventMinter` skips every GitLab review event as `repo-unavailable`, and the bot-review parser drops a
  GitLab username that carries a `.` or `_`.

The owner's live target, `freqtrade/quant-crypto-trader` on gitlab.com, needs all five (design section 9, live
check steps 4, 6 and 7).

## Design

### What "connected" means for a read

A GitLab repo is readable when it has a `FleetRepoGitlabCredential` row (feature 1). A repo without one is "not
connected". Each feature reports that state in its own vocabulary:

| Feature | GitHub "no installation" today | GitLab with no credential row |
|:--|:--|:--|
| Thread project code (`ProjectRepoUnavailable.reason`) | `no installation` | `no installation` (owner ruling 2026-11-16: the reason list is closed in `@nathapp/fleet-protocol` and the runner's assign parser, so no new reason is added) |
| Project brief | `unavailable (no installation)` | `unavailable (no credentials)` |
| Knowledge index (`lastError`, status `skipped`) | `no installation` | `no credentials` |
| Rulings item-index check | fails open | fails open |
| Review events | skip `repo-unavailable` | skip `repo-unavailable` |

A read that resolves the credential and finds no row gets `RepoCheckException('gitlab_credentials_missing')`
from `GitLabRepoCredentials.call` (through `resolve`). Threads and knowledge check the row first from their
projection. The brief, rulings and review events recognise that refusal from their first `call`.

Every GitLab read goes through `GitLabRepoCredentials.call(repo, 'read', fn)`, **one `call` per forge request**,
never one `call` wrapped around a whole pass or a sequence of requests. A `fn` lets every `RepoCheckException`
propagate out of `call`, and the caller degrades outside it. So a 401 marks the read token invalid (feature 1
behaviour) even where the feature then degrades, and a token rotated in the middle of a long knowledge pass is
never marked invalid by a refusal of the old one. No read ever passes `'write'` to `call` or `resolve`.

### GitLab client additions (design section 5)

`GitLabAccessChecker` (`apps/api/src/fleet/git-broker/gitlab-access-checker.ts`) gains four reads and one field.
Every new method calls `assertGitLabHostAllowed` before each request and maps 401 to `gitlab_token_invalid`, 403
to `app_permissions_insufficient`, and any other unexpected status to `provider_error`, through the existing
private `fail`.

| Method | Request | Answer |
|:--|:--|:--|
| `getMergeRequest` (existing) | unchanged | adds `headSha` when the body's `sha` is a string; leaves it absent otherwise |
| `getTree(access, ref)` | `GET <project>/repository/tree?ref=<ref>&recursive=true&per_page=100&page=<n>`, n = 1.. | `{ entries: ForgeTreeEntry[]; truncated: boolean }`, mapped as `listTree` maps them (`size: null`). Paging stops at the first page shorter than 100. When page `TREE_FULL_MAX_PAGES` (100) is full, the method stops and answers `truncated: true` with the entries read so far. 404 throws `repo_not_found`; a 200 whose body is not an array throws `provider_error`. |
| `listMergeRequestNotes(access, iid)` | `GET <project>/merge_requests/<iid>/notes?per_page=100` (one page) | the `body` strings of the notes, in response order; 404 throws `repo_not_found`; a 200 whose body is not an array throws `provider_error` |
| `getMergeRequestDiscussion(access, iid, discussionId)` | `GET <project>/merge_requests/<iid>/discussions/<encodeURIComponent(discussionId)>` | `{ authors: string[] }`, the `author.username` of each note that has one; 404 answers `null`; a 200 whose `notes` is not an array throws `provider_error` |
| `getMemberAccessLevel(access, username)` | `GET <project>/members/all?query=<encodeURIComponent(username)>&per_page=100` | the `access_level` of the entry whose `username` equals `username` case-insensitively; `0` when none matches; 404 throws `repo_not_found`; a 200 whose body is not an array throws `provider_error` |

`members/all` includes inherited group membership, so a group Developer counts as a Developer on the project.
The design names `members/all/:user_id`, but a review event carries only logins, so the lookup queries by
username and confirms the exact match itself (`query` matches fuzzily).

### Threads with project code

`PrismaFleetJobRepository.findProjectRepos` also selects `gitlabCredential: { select: { writeTokenUserId,
writeTokenUsername } }` and projects `gitlabWriteUser` exactly as `findRepo` does (null when there is no row).
`fetchableProjectRepos` keeps a repo when it is GitHub with an installation, **or** GitLab with a truthy
`gitlabWriteUser`. `unavailableReason` answers `no installation` for a GitLab repo whose `gitlabWriteUser` is
null or absent, and null for one that has it. A ref built without the field (older fixtures and callers) is
therefore not connected. `withProjectRepos` already builds the clone URL with `cloneUrlFor`, which
uses a GitLab repo's own host.

The token fence in `SyncService` recomputes the fetchable list with the same `fetchableProjectRepos`, so a granted
GitLab repo reaches `GitTokenBroker.mint` with `readOnly: true`. Feature 2 already answers that mint with the
repo's **read** token, `username: 'oauth2'` and the `repoId`. This feature adds no broker code.

### Project brief

`ProjectBriefService.attempt` keeps its GitHub branch unchanged. A GitLab repo:

1. reads the head with `GitLabAccessChecker.getBranchHead(access, defaultBranch)`, then `.nax/context.md` and
   then `AGENTS.md` with `getFile(access, path, sha)`, each in its own `GitLabRepoCredentials.call(repo, 'read', fn)`;
2. answers `Repository context: unavailable (no credentials)` when that first `call` throws
   `gitlab_credentials_missing`. It answers this even when a cached entry exists, since a repo without
   credentials has no read access to serve. There is no separate `resolve` before the reads;
3. shares the GitHub path's cache (keyed by repo id and checked against the head sha), the 3000 ms deadline, the
   masking and capping, and the `, cached` fallback.

`UnavailableReason` gains `no credentials`.

### Knowledge index

- `KnowledgeRepoRef` gains `host?: string` and `gitlabConnected?: boolean` (absent counts as not connected, so
  refs built without it stay valid). `REPO_SELECT` adds `host` and
  `gitlabCredential: { select: { repoId: true } }`. `toRepo` sets `gitlabConnected` to whether that relation is
  non-null, and does not copy the relation itself onto the ref.
- `IKnowledgeIndexRepository` gains `findAllGitlabRepos(): Promise<KnowledgeRepoRef[]>`: GitLab repos that have a
  credential row, ordered `createdAt` then `id`, at most 500. `findAllGithubRepos` is unchanged.
- `KnowledgePoller.poll` enqueues the repos from `findAllGithubRepos` and then from `findAllGitlabRepos`, each
  with reason `'poll'`. Each read has its own `try`, so a failure of one source still enqueues the other's repos
  and logs one warning.
- `KnowledgeRepoIndexer.indexRepo`, for a GitLab repo:
  - without `gitlabConnected`, it records `skipped` with `lastError` `no credentials` and claims nothing;
  - otherwise it runs the same pass as GitHub, with one `GitLabRepoCredentials.call(repo, 'read', fn)` per forge
    request: `getBranchHead` for the head, `getTree(access, head)` for the tree (`truncated` fails the pass with
    `tree truncated`, as on GitHub), and `getFile(access, path, head)` for each kept file;
  - a GitLab tree entry has `size: null`, so the allowlist cannot skip a large file before it is fetched. A
    fetched file whose `ForgeFile.size` is above `MAX_KNOWLEDGE_FILE_BYTES` is therefore counted in
    `skippedCount`, any earlier rows for its path are deleted as for a removed file, and it is not chunked.
- The provider check moves: a GitHub repo with no installation still records `no installation`, and the
  `not a GitHub repository` reason goes away.

### PR rulings

- `RulingTargetRepo` gains `id: string` and `host?: string`; `targetRepo` copies them from the job's repo row.
- `PrismaFleetPrRulingRepository.lockTarget` and `findTarget` compute `prNumber` with
  `prNumberFor(job.repo, job.resultPrUrl)` for both providers. `prNumberFor` already parses a GitLab MR URL,
  including a host path prefix.
- `latestRunForPr` and `runsForPr` accept a GitLab repo. `latestRunForPr`'s pre-filter is
  `resultPrUrl: { endsWith: '/merge_requests/<n>' }` for GitLab (it stays `/pull/<n>` for GitHub), and every match
  is still confirmed with `prNumberFor`.
- `replaceOlderRuns` accepts a GitLab RUN.
- `FleetPrRulingsService.snapshotForFix`, for a GitLab repo, reads the MR with
  `GitLabRepoCredentials.call(repo, 'read', a => GitLabAccessChecker.getMergeRequest(a, prNumber))`:
  - `null`, or a state other than `open`, answers `notSent: 'pr-not-open'`;
  - a missing `headSha` or any thrown error answers `notSent: 'head-unreadable'`;
  - otherwise it answers the same `{ headSha, rulings }` as GitHub.
- `assertItemIndex`, for a GitLab repo, reads `listMergeRequestNotes` through `call(repo, 'read', fn)`. It applies
  the GitHub rules: fail open on any error and on a full page of 100, and refuse with `fleet.rulings.noItemIndex`
  when no note body contains `NAX_ITEM_INDEX_MARKER`.
- The `fleet.rulings.notDraft` message drops "GitHub":
  - en: "Only draft RUN jobs with a pull or merge request can be ruled";
  - zh: "只能裁定具有拉取请求或合并请求的草稿 RUN 作业".

### Review events

- The bot-review parser's `LOGIN` accepts either the GitHub login pattern (unchanged) or a GitLab username:
  `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$`.
- `FleetReposService.findReviewRepo` adds `provider` and `host` to its projection.
- `ReviewEventMinter.mintOne`, for a GitHub repo:
  - first drops every login that does not match the GitHub login pattern;
  - then runs exactly as today. A GitHub event whose logins pass the old pattern makes the same calls.
- For a GitLab repo, each forge request runs in its own `GitLabRepoCredentials.call(repo, 'read', fn)`:
  - `writers` keeps each login whose `getMemberAccessLevel` is at least `GITLAB_DEVELOPER_ACCESS` (30) (owner
    ruling 2026-11-16);
  - `verifiedWriter` reads `getMergeRequestDiscussion(access, row.prNumber, row.threadId)`. `null` or a thrown
    error is unverified. Otherwise the first writer, in `writers` order, whose login equals a thread author
    case-insensitively (`normalizeLogin`, as on GitHub) is verified;
  - the approver id is `gitlab:<login>`;
  - the access-level lookups decide the row's failure path from the `RepoCheckException` reason `call` throws:
    - `gitlab_credentials_missing` skips the row as `repo-unavailable`, as a GitHub repo with no installation
      does, because a disconnected repo does not heal on retry;
    - `vcs_encryption_key_missing` takes the existing `retry` path (`bumpAttempt`, then `mint-failed` after 3);
    - any other failure, `gitlab_token_invalid` included, skips the row as `permission-check-failed`, as on
      GitHub. Its `call` has already marked the read token invalid.
- The `[bot]` filter stays. On GitLab, nax already drops its own login from `disagreedBy` (nax
  `bot/post-earlier.ts` `withdrawalEvents`).

### Integration

Symbols this feature reads, verified at main `8739fef92`:

- `GitLabRepoCredentials.call(repo: { id: string; host?: string }, kind: 'read' | 'write', fn: (access: GitLabAccess) => Promise<T>): Promise<T>` and `resolve(repo, kind): Promise<GitLabAccess>` (`apps/api/src/fleet/git-broker/gitlab-repo-credentials.ts`).
- `GitLabAccessChecker.getBranchHead(access, branch): Promise<string>`, `getFile(access, path, ref): Promise<ForgeFile | null>`, `listTree(access, path, ref): Promise<ForgeTreeEntry[]>`, `GITLAB_DEVELOPER_ACCESS = 30`.
- `prNumberFor(repo: Pick<FleetRepoRef, 'provider' | 'owner' | 'name' | 'host'>, url): number | null` (`apps/api/src/fleet/sync/pr-attribution.service.ts`).
- `cloneUrlFor(repo, cfg)` (`apps/api/src/fleet/git-broker/clone-url.ts`).
- `GitTokenBroker.mint` GitLab `readOnly` branch (`apps/api/src/fleet/git-broker/git-token.broker.ts`, from feature 2).
- `MAX_KNOWLEDGE_FILE_BYTES = 262_144` (`apps/api/src/fleet/knowledge/knowledge-allowlist.ts`).
- `NAX_ITEM_INDEX_MARKER` (`apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts`).

Symbols this feature changes. The baseline only locates the code. Implement the target.

- `GitLabAccessChecker.getMergeRequest`. Baseline: returns `VcsPrStatus` without `headSha`. Target: also sets `headSha` from the body's `sha` when it is a string.
- `fetchableProjectRepos(repos)`. Baseline: keeps GitHub repos with an installation. Target: also keeps GitLab repos with a non-null `gitlabWriteUser`.
- `PrismaFleetJobRepository.findProjectRepos(projectId)`. Baseline: no `gitlabWriteUser`. Target: projects `gitlabWriteUser` as `findRepo` does.
- `KnowledgeRepoRef`. Baseline: `{ id, projectId, provider, owner, name, defaultBranch, githubInstallationId }`. Target: adds `host?: string` and `gitlabConnected?: boolean`.
- `RulingTargetRepo`. Baseline: `{ provider, owner, name, githubInstallationId }`. Target: adds `id: string` and `host?: string`.
- `FleetReposService.findReviewRepo(id)`. Baseline: `{ id, projectId, owner, name, githubInstallationId, defaultBranch }`. Target: adds `provider` and `host`.

Patterns to mirror: the GitHub branch of each changed method, and feature 1's `fleet-repo-files.router.ts`, which
answers a GitLab read through `GitLabRepoCredentials.call`.

### Failure Handling

| Case | Behaviour | Story |
|:--|:--|:--|
| GitLab answers 401 to a read | the read token is marked invalid (`call`), and the feature takes its existing failure path | US-002..US-006 |
| Brief read fails or times out | the cached text marked `, cached`, else `unavailable (read failed)` / `unavailable (timeout)` | US-003 |
| Knowledge tree over 100 pages | the pass fails with `tree truncated` | US-004 |
| Rulings MR read fails | `snapshotForFix` answers `head-unreadable`; `assertItemIndex` fails open | US-005 |
| Review discussion read fails | the decision is minted unverified | US-006 |
| Review access-level read fails | `gitlab_credentials_missing`: skip `repo-unavailable`; `vcs_encryption_key_missing`: `retry`; otherwise skip `permission-check-failed` | US-006 |

## Out of Scope

- Flows, auto-review, fix-checks (`trustDetectedChecks`), CI pipeline status and host-aware `findByIdentity` on GitLab (feature 4 of GitLab parity); their GitHub-only guards stay.
- A new `ProjectRepoUnavailable` reason for a GitLab repo without credentials; it reuses `no installation` so that `@nathapp/fleet-protocol` and the runner's assign parser do not change (owner ruling 2026-11-16).
- Paging MR notes past the first 100 in the rulings item-index check; a full page fails open, as on GitHub.
- Excluding the write token's username from a GitLab review event's `disagreedBy` in koda; nax already drops its own login.
- Minting short-lived GitLab tokens per job; deferred by the owner because gitlab.com Free does not offer them.
- The GitLab setup guide in the docs; written when feature 4 closes the arc.
- Self-hosted GitLab hosts whose name lacks `gitlab`; they wait for nax #2957.
- US-002 only: no test asserts token values are absent from log lines; `SyncService` and the broker log only job ids and error names.
- US-004 only: retrying a GitLab call inside a knowledge pass; a failed call fails the pass, and the next poll or merge event runs it again.
- US-004 only: the GitHub tree cap and the GitHub pass are unchanged; only the GitLab pass reads `getTree`.
- US-004 only: a GitLab repo whose recursive tree holds more than 10000 entries always fails its pass with `tree truncated`; a narrower tree read is a later change.
- US-004 only: a GitLab file skipped after fetch for its size keeps no `KnowledgeRepoFile` row, so it is fetched again on the next pass that sees a new head; a skip marker is a later change.
- US-005 only: concurrent rulings on one GitLab MR; the existing repo-first row locks of `lockTarget` apply unchanged.
- US-006 only: paging `members/all` past the first 100 matches of the username query; an exact match beyond them counts as access level 0 (not a writer).

## Stories

**US-001: GitLab client reads for merge requests, trees and members.** Workdir: `apps/api`. No dependencies.
Adds `getTree`, `listMergeRequestNotes`, `getMergeRequestDiscussion` and `getMemberAccessLevel` to
`GitLabAccessChecker`, and `headSha` to `getMergeRequest`, per the Design table.

**US-002: Threads read GitLab project code.** Workdir: `apps/api`. Depends on US-001. `findProjectRepos`
projects `gitlabWriteUser`. `fetchableProjectRepos` and `withProjectRepos` treat a GitLab repo with credentials as
fetchable and one without as `no installation`. The sync token fence then grants it the read token.

**US-003: Project brief from a GitLab repo.** Workdir: `apps/api`. Depends on US-001. `ProjectBriefService`
reads a GitLab repo's context file with its read token, and answers `unavailable (no credentials)` without one.

**US-004: Knowledge index of GitLab repos.** Workdir: `apps/api`. Depends on US-001. `KnowledgeRepoRef` carries
`host` and `gitlabConnected`. The repository gains `findAllGitlabRepos`, and the poller queues those repos.
`KnowledgeRepoIndexer` indexes a GitLab repo through its read token, with the 100-page tree cap and the
post-fetch size skip.

**US-005: PR rulings on GitLab merge requests.** Workdir: `apps/api`. Depends on US-001. The ruling repository
computes GitLab MR numbers and accepts GitLab repos. `snapshotForFix` and `assertItemIndex` read the MR and its
notes with the read token. The `notDraft` message drops "GitHub".

**US-006: Review events on GitLab merge requests.** Workdir: `apps/api`. Depends on US-001. The bot-review
parser accepts GitLab usernames, `findReviewRepo` carries `provider` and `host`, and `ReviewEventMinter` checks
GitLab writers and threads with the read token. The GitHub path drops non-GitHub logins first and is otherwise
unchanged.

### Context Files

**US-001**

- `apps/api/src/fleet/git-broker/gitlab-access-checker.ts`
- `apps/api/src/fleet/git-broker/gitlab-access-checker.spec.ts`
- `apps/api/src/fleet/git-broker/forge-tree.ts`
- `apps/api/src/vcs/types.ts`

**US-002**

- `apps/api/src/fleet/jobs/project-repos-assign.ts`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts`
- `apps/api/src/fleet/sync/sync.service.ts`
- `apps/api/src/fleet/git-broker/git-token.broker.ts`
- `apps/api/test/integration/fleet/fleet-project-code-token-fence.integration.spec.ts`

**US-003**

- `apps/api/src/fleet/threads/project-brief.service.ts`
- `apps/api/src/fleet/threads/project-brief.service.spec.ts`
- `apps/api/src/fleet/git-broker/gitlab-repo-credentials.ts`
- `apps/api/src/fleet/repo-config/fleet-repo-files.router.ts`

**US-004**

- `apps/api/src/fleet/knowledge/knowledge-repo-indexer.ts`
- `apps/api/src/fleet/knowledge/knowledge-index.domain.ts`
- `apps/api/src/fleet/knowledge/prisma-knowledge-index.repository.ts`
- `apps/api/src/fleet/knowledge/knowledge-poller.ts`
- `apps/api/src/fleet/knowledge/knowledge-allowlist.ts`

**US-005**

- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts`
- `apps/api/src/fleet/rulings/prisma-fleet-pr-ruling.repository.ts`
- `apps/api/src/fleet/rulings/fleet-pr-ruling.domain.ts`
- `apps/api/src/fleet/sync/pr-attribution.service.ts`
- `apps/api/test/integration/fleet/fleet-pr-rulings.integration.spec.ts`

**US-006**

- `apps/api/src/fleet/reviews/review-event.minter.ts`
- `apps/api/src/fleet/ingest/parsers/bot-review.parser.ts`
- `apps/api/src/fleet/repos/fleet-repos.service.ts`
- `apps/api/src/fleet/reviews/review-event.minter.spec.ts`

### Creates

None. Every story changes existing files and adds its tests to the existing spec files.

### Modifies

**US-002**

- `apps/api/src/fleet/jobs/project-repos-assign.spec.ts` — the cases that build GitLab repos with no `gitlabWriteUser` assert the reason `not a GitHub repository`; with this story such a repo is unavailable with reason `no installation`, and a GitLab repo with a `gitlabWriteUser` is fetchable. Replace each `not a GitHub repository` expectation with `no installation` and keep the order and cap assertions unchanged.
- `apps/api/src/fleet/jobs/placement.service.project-code.spec.ts` — line 108 expects a GitLab repo with no credential to be unavailable with reason `not a GitHub repository`; with this story it is `no installation`. Replace that reason and keep the rest of the expectation unchanged.
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.find-project-repos.spec.ts` — the mapped-row `toEqual` (lines 43-46) and the exact `select` assertion (lines 59-66) pin the projection before this story; the row now also carries `gitlabWriteUser` (null for a repo without a credential row) and the select adds `gitlabCredential: { select: { writeTokenUserId: true, writeTokenUsername: true } }`. Add both to the expectations.
- `apps/api/test/integration/fleet/fleet-project-code-repository.integration.spec.ts` — lines 78-83 `toEqual` whole rows from `findProjectRepos`; each row now also carries `gitlabWriteUser` (null for both rows there, since neither has a credential row). Add `gitlabWriteUser: null` to each expected row.
- `apps/api/test/integration/fleet/fleet-project-code-token-fence.integration.spec.ts` — the `pc-gitlab` repo has no credential row and stays refused with `repo_not_assigned`; add a GitLab repo with a credential row whose request is granted. The existing refusal assertion stays valid and must not be weakened.

**US-003**

- `apps/api/src/fleet/threads/project-brief.service.spec.ts` — the table case "a GitLab repository" expects `not a GitHub repository`; with this story a GitLab repo with no credential row answers `unavailable (no credentials)`. Replace that row's reason and give its fixture a credential store that has no row for the repo. Its `new ProjectBriefService(github, repos, clock)` constructions also gain the two GitLab dependencies, placed before the optional clock.

**US-004**

- `apps/api/src/fleet/knowledge/knowledge-repo-indexer.spec.ts` — AC-9's `['gitlab', 5n, 'not a GitHub repository']` row and the test at line 228 that sets `provider: 'gitlab'` expect a GitLab repo to be skipped as not GitHub; with this story a GitLab repo without `gitlabConnected` is skipped with `no credentials`, and one with it is indexed. Change the GitLab row's expected reason to `no credentials`, set `gitlabConnected: false` on its fixture, and keep the GitHub `no installation` row unchanged. Its `KnowledgeRepoIndexer` constructions also gain the two GitLab dependencies, placed before the defaulted clock.
- `apps/api/src/fleet/knowledge/knowledge-poller.spec.ts` — a stub repository without `findAllGitlabRepos` makes `poll` fail; add `findAllGitlabRepos` returning an empty list to the existing stubs, so the GitHub-only enqueue assertions keep their meaning.

**US-005**

- `apps/api/test/integration/fleet/fleet-pr-rulings.integration.spec.ts` — AC-2's `gitlab` case expects a draft RUN on a GitLab MR to be refused with 409 and the text "with a GitHub pull request"; with this story that target is eligible. Remove `gitlab` from AC-2's refused kinds, change the message text AC-2 checks to "with a pull or merge request", and add the GitLab draft target as an accepted case.
- `apps/api/src/fleet/rulings/fleet-pr-rulings.preflight.spec.ts` — "AC-6: assertItemIndex reads nothing for a GitLab repo" asserts no forge read for GitLab; with this story a GitLab repo's notes are read. Replace that case with one asserting a GitLab repo without a credential row fails open and reads no GitHub method.
- `apps/api/src/i18n/en/fleet.json` — `fleet.rulings.notDraft` "409" text changes to "Only draft RUN jobs with a pull or merge request can be ruled".
- `apps/api/src/i18n/zh/fleet.json` — `fleet.rulings.notDraft` "409" text changes to "只能裁定具有拉取请求或合并请求的草稿 RUN 作业".

**US-006**

- `apps/api/src/fleet/repos/fleet-repos.service.spec.ts` — "findReviewRepo exposes only the review projection" asserts the exact object `{ id, projectId, owner, name, githubInstallationId, defaultBranch }`; with this story the projection also carries `provider` and `host`. Add both fields to the expected object.
- `apps/api/src/fleet/reviews/review-event.minter.spec.ts` — the repo fixtures carry no `provider`; with this story the minter branches on it. Give the existing fixtures `provider: 'github'`, so every existing GitHub assertion keeps its meaning.
### Seams

- US-001 -> US-002..US-006: `getTree`, `listMergeRequestNotes`, `getMergeRequestDiscussion`, `getMemberAccessLevel` and `getMergeRequest().headSha` are consumed by the consumer stories; each consumer's AC stubs the method and asserts it was called through its own entry point.

## Acceptance Criteria

### US-001

- AC-1 [unit] `GitLabAccessChecker.getMergeRequest(access, 7)` for a 200 body whose `sha` is `"abc123"` returns an object with `headSha: 'abc123'`, and for a body with no `sha` returns an object with no `headSha` property.
- AC-2 [unit] `getTree(access, 'h1')` requests `GET <apiBase>/projects/<projectId>/repository/tree?ref=h1&recursive=true&per_page=100&page=1`, then page 2 when page 1 holds 100 entries, and stops after a page of fewer than 100, returning `{ entries, truncated: false }` with the blob and tree entries of both pages mapped as `{ path, type, sha: id, size: null }`.
- AC-3 [unit] `getTree` when each of 100 pages holds 100 entries makes exactly 100 requests and returns `truncated: true` with the 10000 entries read.
- AC-4 [unit] `getTree` throws `RepoCheckException` with reason `repo_not_found` when GitLab answers 404 to page 1.
- AC-5 [unit] `listMergeRequestNotes(access, 4)` requests `GET <apiBase>/projects/<projectId>/merge_requests/4/notes?per_page=100` and returns the `body` strings of the notes in response order, ignoring an entry whose `body` is not a string.
- AC-6 [unit] `listMergeRequestNotes` throws `RepoCheckException` with reason `provider_error` for a 200 response whose body is an object instead of an array.
- AC-7 [unit] `getMergeRequestDiscussion(access, 4, 'd/1')` requests `GET <apiBase>/projects/<projectId>/merge_requests/4/discussions/d%2F1` and returns `{ authors: ['alice', 'bob'] }` for a body whose `notes` carry authors `alice` and `bob` and one note with no author.
- AC-8 [unit] `getMergeRequestDiscussion` returns `null` when GitLab answers 404.
- AC-9 [unit] `getMemberAccessLevel(access, 'Alice.B')` requests `GET <apiBase>/projects/<projectId>/members/all?query=Alice.B&per_page=100` and returns 30 when the response holds `{ username: 'alice.b', access_level: 30 }` and `{ username: 'alice.bx', access_level: 50 }`.
- AC-10 [unit] `getMemberAccessLevel` returns 0 when no entry's `username` equals the queried username case-insensitively.
- AC-11 [unit] Each of `getTree`, `listMergeRequestNotes`, `getMergeRequestDiscussion` and `getMemberAccessLevel` throws `RepoCheckException` with reason `gitlab_token_invalid` on 401, `app_permissions_insufficient` on 403 and `provider_error` on 500 (one table-driven test).
- AC-12 [unit] Each of the four new methods, for an access whose api base host resolves to a loopback address, throws `RepoCheckException` with reason `gitlab_host_blocked` and sends no request (one table-driven test).
- AC-13 [unit] `getTree`, `listMergeRequestNotes` and `getMemberAccessLevel` throw `RepoCheckException` with reason `provider_error` for a 200 whose body is an object instead of an array, `getMergeRequestDiscussion` throws it for a 200 whose `notes` is missing, and `listMergeRequestNotes` and `getMemberAccessLevel` throw `repo_not_found` on 404 (one table-driven test).

### US-002

- AC-1 [integration] `PrismaFleetJobRepository.findProjectRepos(projectId)` returns, for a GitLab repo with a `FleetRepoGitlabCredential` row whose write user is `(7, 'kodabot')`, `gitlabWriteUser: { id: 7, username: 'kodabot' }`, and `gitlabWriteUser: null` for a GitLab repo without a row.
- AC-2 [unit] `fetchableProjectRepos` keeps, in input order, a GitHub repo with an installation and a GitLab repo with a non-null `gitlabWriteUser`, and drops a GitLab repo whose `gitlabWriteUser` is null, a GitLab repo with no `gitlabWriteUser` property, and a GitHub repo whose `githubInstallationId` is null.
- AC-3 [unit] `withProjectRepos` lists a GitLab repo with a non-null `gitlabWriteUser` and host `https://gitlab.example.com` in `projectRepos` with `cloneUrl` `https://gitlab.example.com/<owner>/<name>.git`.
- AC-4 [unit] `withProjectRepos` lists a GitLab repo whose `gitlabWriteUser` is null in `projectReposUnavailable` with reason `no installation`.
- AC-5 [unit] `withProjectRepos` with 10 fetchable GitHub repos followed by one GitLab repo with a `gitlabWriteUser` lists the GitLab repo as unavailable with reason `limit`.
- AC-6 [integration] A runner sync whose token request names a PROJECT SESSION job and a GitLab repo of its project that has a credential row is granted a git token with `username: 'oauth2'`, `repoId` equal to that repo's id, and `token` equal to the stored read token's plaintext.
- AC-7 [integration] The same sync never answers that request with the stored write token's plaintext: a repo whose read and write tokens differ yields the read token only.
- AC-8 [integration] A runner sync whose token request names a GitLab repo of the project without a credential row answers a `gitTokenErrors` entry with reason `repo_not_assigned` for that `repoId`.

### US-003

- AC-1 [unit] `ProjectBriefService.resolveRepoContext(repoId)` for a GitLab repo with credentials, whose `getBranchHead` answers `abcdef1234` and whose `getFile` answers `.nax/context.md` with text `hello`, returns `Repository context (<owner>/<name> .nax/context.md @ abcdef1):\nhello`.
- AC-2 [unit] For that repo the head is read with `GitLabAccessChecker.getBranchHead` on the repo's default branch and the file with `getFile(access, '.nax/context.md', 'abcdef1234')`, each called with the access a separate `GitLabRepoCredentials.call(repo, 'read', fn)` passes to `fn`. `call` is never invoked with `'write'`, and no `GitHubAppClient` method is called.
- AC-3 [unit] For a GitLab repo whose `.nax/context.md` is absent and whose `AGENTS.md` holds `agents`, `resolveRepoContext` returns the `AGENTS.md` section.
- AC-4 [unit] For a GitLab repo whose first `GitLabRepoCredentials.call` throws `RepoCheckException('gitlab_credentials_missing')`, `resolveRepoContext` returns `Repository context: unavailable (no credentials)` and calls no `GitLabAccessChecker` method.
- AC-5 [unit] A second `resolveRepoContext` for the same GitLab repo within 300000 ms returns the cached section and calls `getBranchHead` only once in total.
- AC-6 [unit] For a GitLab repo whose cached entry exists and whose next `getBranchHead` throws `RepoCheckException('gitlab_token_invalid')` after the TTL, `resolveRepoContext` returns the cached text marked `, cached`.
- AC-7 [unit] For a GitLab repo with no cached entry and a `getFile` that throws, `resolveRepoContext` returns `Repository context: unavailable (read failed)`.
- AC-8 [unit] For a GitHub repo, `resolveRepoContext` calls `GitHubAppClient.mintInstallationToken`, `getBranchHead` and `getFile` with the same arguments as before and never calls `GitLabRepoCredentials.resolve` or `call`.

### US-004

- AC-1 [integration] `PrismaKnowledgeIndexRepository.findRepo(id)` returns `gitlabConnected: true` and the repo's `host` for a GitLab repo with a credential row, and `gitlabConnected: false` for a GitLab repo without one.
- AC-2 [integration] `findAllGitlabRepos()` returns the GitLab repos with a credential row, ordered by `createdAt` then `id`, and omits GitLab repos without a row and every GitHub repo.
- AC-3 [unit] `KnowledgePoller.poll()` enqueues every repo id from `findAllGithubRepos` and then every repo id from `findAllGitlabRepos`, each with reason `'poll'`.
- AC-4 [unit] `KnowledgePoller.poll()` when `findAllGithubRepos` rejects still enqueues every repo id from `findAllGitlabRepos`, and resolves without throwing.
- AC-5 [unit] `KnowledgeRepoIndexer.indexRepo` for a GitLab repo with `gitlabConnected: false` finishes with status `skipped` and `lastError` `no credentials`, resolves `{ status: 'skipped', reason: 'no credentials' }`, and calls neither `claim` nor any forge method.
- AC-6 [unit] `indexRepo` for a GitHub repo whose `githubInstallationId` is null resolves `{ status: 'skipped', reason: 'no installation' }`.
- AC-7 [unit] `indexRepo` for a connected GitLab repo reads the head with `GitLabAccessChecker.getBranchHead(access, defaultBranch)`, the tree with `getTree(access, head)` and each kept file with `getFile(access, path, head)`, each through its own `GitLabRepoCredentials.call(repo, 'read', fn)` (never `'write'`), writes the files' chunks with `replaceFile`, and resolves `{ status: 'indexed' }`.
- AC-8 [unit] `indexRepo` for a connected GitLab repo calls no `GitHubAppClient` method.
- AC-9 [unit] `indexRepo` for a connected GitLab repo whose head equals the stored `indexedSha`, with no unembedded files and an unchanged patterns key, resolves `{ status: 'unchanged' }` and does not call `getTree`.
- AC-10 [unit] `indexRepo` for a connected GitLab repo whose `getTree` answers `truncated: true` finishes `failed` with `lastError` `tree truncated` and resolves `{ status: 'failed', reason: 'tree truncated' }`.
- AC-11 [unit] `indexRepo` for a connected GitLab repo where `getFile` answers a `docs/big.md` whose `size` is 262145 does not call `replaceFile` for it, adds 1 to the finished `skippedCount`, and indexes the other kept files.
- AC-12 [unit] `indexRepo` for a connected GitLab repo whose `docs/big.md` had stored rows and now fetches with `size` 262145 calls `deleteFile` for `repo:<repoId>:docs/big.md` and deletes its `KnowledgeRepoFile` row.
- AC-13 [unit] `indexRepo` for a connected GitLab repo whose `getBranchHead` throws `RepoCheckException('gitlab_token_invalid')` finishes `failed` with `lastError` `gitlab_token_invalid`.

### US-005

- AC-1 [integration] `PrismaFleetPrRulingRepository.findTarget(projectId, jobId)` for a RUN job on a GitLab repo `acme/app` whose `resultPrUrl` is `https://gitlab.com/acme/app/-/merge_requests/12` returns `prNumber: 12` and a `repo` carrying the repo's `id` and `host`.
- AC-2 [integration] `latestRunForPr(repoId, 12)` for a GitLab repo returns the id of the newest RUN job whose `resultPrUrl` is that repo's MR 12, and ignores a RUN job of the same repo whose URL is MR 112.
- AC-3 [integration] `runsForPr(repoId, 12)` for a GitLab repo returns the ids of every RUN job whose `resultPrUrl` is that repo's MR 12.
- AC-4 [integration] `replaceOlderRuns(newerRunId)` for a GitLab RUN on MR 12 marks an older GitLab RUN's pending ruling on MR 12 `replaced`.
- AC-5 [integration] `POST /projects/:slug/fleet/jobs/:id/rulings` for a draft RUN job on a GitLab MR whose open items include `D-1`, with a valid ruling text, answers 201 with a `pending` ruling.
- AC-6 [integration] The same route for a non-draft RUN job answers 409 with the text "Only draft RUN jobs with a pull or merge request can be ruled".
- AC-7 [unit] `FleetPrRulingsService.snapshotForFix(repo, 12)` for a GitLab repo with a pending ruling, whose `getMergeRequest` answers `state: 'open'` and `headSha: 'h1'`, returns `{ headSha: 'h1', rulings: [...] }` with that ruling, and calls `getMergeRequest` with the access `GitLabRepoCredentials.call(repo, 'read', fn)` passes; `call` is never invoked with `'write'`.
- AC-8 [unit] `snapshotForFix` for a GitLab repo answers `{ notSent: 'pr-not-open' }` when `getMergeRequest` returns `null`, and also when it returns `state: 'closed'`.
- AC-9 [unit] `snapshotForFix` for a GitLab repo answers `{ notSent: 'head-unreadable' }` when `getMergeRequest` returns an open MR with no `headSha`, and also when `GitLabRepoCredentials.call` throws.
- AC-10 [unit] `assertItemIndex` for a GitLab target whose `listMergeRequestNotes` answers bodies none of which contains `NAX_ITEM_INDEX_MARKER` throws the `fleet.rulings.noItemIndex` conflict.
- AC-11 [unit] `assertItemIndex` for a GitLab target resolves without throwing when one note body contains `NAX_ITEM_INDEX_MARKER`, and also when `listMergeRequestNotes` answers 100 bodies none of which contains it.
- AC-12 [unit] `assertItemIndex` for a GitLab target resolves without throwing when `GitLabRepoCredentials.call` throws `RepoCheckException('gitlab_credentials_missing')`.
- AC-13 [unit] `snapshotForFix` and `assertItemIndex` for a GitHub repo call `GitHubAppClient.mintThreadReadToken` as before and never call `GitLabRepoCredentials.call`.

### US-006

- AC-1 [unit] `parseBotReview` keeps the logins `jane.doe`, `j_d` and `octo-cat[bot]` in an event's `disagreedBy` and drops `bad login` and `.dot`.
- AC-2 [unit] `FleetReposService.findReviewRepo(id)` returns `provider` and `host` along with the existing projection fields.
- AC-3 [unit] `ReviewEventMinter.run()` for a GitLab repo's pending row with `disagreedBy: ['alice', 'bob']`, where `getMemberAccessLevel` answers 30 for `alice` and 20 for `bob` and `getMergeRequestDiscussion` answers authors `['alice']`, mints with approver `gitlab:alice` and `satisfiedBy: 'human'`.
- AC-4 [unit] For that row, `getMemberAccessLevel` and `getMergeRequestDiscussion(access, row.prNumber, row.threadId)` are each called with the access a separate `GitLabRepoCredentials.call(repo, 'read', fn)` passes, `call` is never invoked with `'write'`, and no `GitHubAppClient` method is called.
- AC-5 [unit] A GitLab row whose discussion authors are `['ALICE']` and whose writers are `['alice']` mints with `satisfiedBy: 'human'`.
- AC-6 [unit] A GitLab row where every `disagreedBy` login has access level below 30 is skipped with reason `no-writer` and mints nothing.
- AC-7 [unit] A GitLab row where `getMergeRequestDiscussion` returns `null` mints with approver `gitlab:<first writer>` and `satisfiedBy: 'none'`.
- AC-8 [unit] A GitLab row where `getMergeRequestDiscussion` throws mints with `satisfiedBy: 'none'`.
- AC-9 [unit] A GitLab row where `getMemberAccessLevel` throws `RepoCheckException('gitlab_token_invalid')` is skipped with reason `permission-check-failed`, mints nothing, and the read token is marked invalid through `call`.
- AC-10 [unit] A GitLab row where the access-level `GitLabRepoCredentials.call` throws `RepoCheckException('gitlab_credentials_missing')` is skipped with reason `repo-unavailable`, does not call `bumpAttempt`, and mints nothing.
- AC-11 [unit] A GitLab row where the access-level `call` throws `RepoCheckException('vcs_encryption_key_missing')` calls `bumpAttempt` for the row and mints nothing.
- AC-12 [unit] A GitHub row with `disagreedBy: ['jane.doe', 'alice']` calls `GitHubAppClient.getRepoRole` for `alice` only.
- AC-13 [unit] A GitHub row with `disagreedBy: ['alice']` makes the same `mintThreadReadToken`, `getRepoRole` and `getReviewThread` calls as before and mints with approver `github:alice`.
- AC-14 [unit] A GitHub row with `disagreedBy: ['jane.doe']` only is skipped with reason `no-writer` and calls no `GitHubAppClient` method.
