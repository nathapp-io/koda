# SPEC: GitLab auto-review and trusted detected checks (GitLab parity F4a)

## Summary

Feature 4a of GitLab parity for the koda fleet. The design was approved by the owner on 2026-11-16:
`docs/superpowers/specs/2026-11-16-gitlab-parity-design.md` (section 5, rows "Auto-review PR listing" and "CI
checks for fix-checks and flows"). Features 1-3 are merged: per-repo GitLab credentials (#472), REVIEW, FIX and
AGENT jobs on GitLab (#473), and the read features (#474). The owner split the remaining feature 4 in two on
2026-11-17: this feature (auto-review and the fix-checks switch) first, then `gitlab-flows` (flows and the GitLab
setup guide).

This feature lets an admin turn on two repo settings that are still GitHub-only, and makes them work on GitLab:

- **auto-review**: the polling pass lists a GitLab repo's open merge requests with the repo's read token and
  dispatches a REVIEW for each eligible head, exactly as it does for a GitHub pull request;
- **trust detected checks** (`fixTrustDetectedChecks`): a FIX on a GitLab repo may run checks nax detects from
  package scripts. nax already reads GitLab pipelines (`packages/nax/src/forge/checks-read.ts`), so koda only has
  to allow the switch and pass it on, which `buildAssignPayload` already does for any provider.

Every GitHub path stays as it is.

## Motivation

After features 1-3, a connected GitLab repo can run every job kind, but two repo settings still refuse it:

- `FleetReposService.configureAutoReview` throws `AutoReviewException('github app required')` for any repo that
  is not a GitHub repo with an installation;
- `FleetReposService.configureFixChecks` throws `FixChecksException('github app required')` the same way.

Even with the guard removed, auto-review would not run: `PrismaFleetRepoRepository.findAutoReviewPage` selects only
`provider: 'github'` rows with an installation, and `FleetPrReviewPass.pollRepo` mints a GitHub installation token
and calls `GitHubAppClient.listOpenPullRequests`. The admin repos page mounts the two switches only for a GitHub repo
with an installation. So the owner cannot have koda review GitLab merge requests on its own.

## Design

### Approach

The GitLab path mirrors the GitHub one call for call:

| Step | GitHub today | GitLab after |
|:--|:--|:--|
| Which repos the pass reads | `provider: 'github'`, `githubInstallationId` not null | also `provider: 'gitlab'` with a `gitlabCredential` row |
| Token | `mintInstallationToken(installationId, name)` | `GitLabRepoCredentials.call(repo, 'read', fn)` |
| Open PR list | `listOpenPullRequests(token, owner, name)` | `GitLabAccessChecker.listOpenMergeRequests(access, fullName)` |
| Eligibility, claim, dispatch | `ReviewHeadDispatcher.dispatchRepo` | unchanged; it reads only `OpenPullRequest` fields |
| Enable guard | installation required | credential row required, refusal `gitlab credentials required` |

One `GitLabRepoCredentials.call` wraps the single listing request, so a 401 marks the read token invalid through
`call` (feature 1 behaviour) and a rotated token is not marked by another request.

`listOpenMergeRequests` returns the existing `OpenPullRequest` shape so that `ReviewHeadDispatcher` does not change.
The dispatcher skips a pull request whose `headRepoFullName` is null or differs from `<owner>/<name>` (forks and
deleted heads, `review-head-dispatcher.ts` `skips`). A GitLab merge request does not carry its source project's
path, only `source_project_id`, so the client takes the repo's full name and reports it for a merge request whose
`source_project_id` equals the access target's project id, and null for any other (a fork). The pass passes
`` `${repo.owner}/${repo.name}` ``, so the dispatcher's comparison holds for same-project merge requests.

The enable guard follows `configureFixUnprotected`, which feature 2 already opened to GitLab: a GitLab row needs a
`gitlabCredential` row (absent or null is refused `gitlab credentials required`); a GitHub row still needs an
installation (`github app required`). Disabling is never refused. The 422 message is the existing
`fleet.autoReview` / `fleet.fixChecks` template with `{reason}`, so no new i18n key is needed in the API.

### Integration

Read, unchanged:

- `ReviewHeadDispatcher.dispatchRepo(repo: FleetRepoRecord, prs: readonly OpenPullRequest[], opts: DispatchRepoOptions): Promise<number>` (`apps/api/src/fleet/reviews/review-head-dispatcher.ts`)
- `OpenPullRequest { number: number; headSha: string; draft: boolean; headRepoFullName: string | null; updatedAt: Date }` (`apps/api/src/fleet/git-broker/github-app-client.ts`)
- `GitLabRepoCredentials.call<T>(repo: { id: string; host?: string }, kind: 'read' | 'write', fn: (access: GitLabAccess) => Promise<T>): Promise<T>` (`apps/api/src/fleet/git-broker/gitlab-repo-credentials.ts`)
- `GitLabAccess { token: string; target: { apiBase: string; projectId: number } }`
- `EnablerGate.check(repo: FleetRepoRecord): Promise<PrincipalRef | null>`
- `buildAssignPayload` in `apps/api/src/fleet/jobs/assign-payload.ts`, which adds `trustDetectedChecks: true` to a FIX
  whose repo has `fixTrustDetectedChecks === true`, for any provider
- `GitBrokerModule` already exports `GitLabRepoCredentials` and `GitLabAccessChecker`, and `FleetReviewsModule`
  already imports `GitBrokerModule` (`ReviewEventMinter` uses both)

Changed. The baseline is listed only to find the code; implement the target.

- `GitLabAccessChecker` (`apps/api/src/fleet/git-broker/gitlab-access-checker.ts`)
  - Baseline: no merge-request listing method.
  - Target: adds `listOpenMergeRequests(access: GitLabAccess, fullName: string): Promise<OpenPullRequest[]>`. It runs
    the class's host check (`guard`) first, then sends `GET <apiBase>/projects/<projectId>/merge_requests?state=opened&per_page=100`
    with the `private-token` header. For each item: `number` = `iid`, `headSha` = `sha`, `draft` = `draft === true ||
    work_in_progress === true`, `updatedAt` = `new Date(updated_at)`, `headRepoFullName` = `fullName` when
    `source_project_id === access.target.projectId`, else null. Status mapping: 200 parses; 404 is
    `repo_not_found`; anything else goes through the class's `fail` (401 `gitlab_token_invalid`, 403
    `app_permissions_insufficient`, other `provider_error`). A body that is not an array, or an item whose `iid` is not
    a number, whose `updated_at` is not a string, or whose `sha` is neither a string nor null, is `provider_error`.
    An item whose `sha` is null (a merge request with no commits yet) is left out of the result, so it cannot block
    the review of the repo's other merge requests.
- `FleetPrReviewPass` (`apps/api/src/fleet/reviews/fleet-pr-review.pass.ts`)
  - Baseline: `constructor(repos, gate, github: GitHubAppClient, dispatcher, @Inject(FLEET_CFG) config)`; `pollRepo`
    always mints a GitHub installation token through the private `installationId(repo)`.
  - Target: `constructor(repos, gate, github, dispatcher, @Inject(FLEET_CFG) config, gitlabCredentials: GitLabRepoCredentials, gitlab: GitLabAccessChecker)`
    (new dependencies appended). Inside the same `runAsSystem` body and after the same `gate.check`, `pollRepo` reads
    the list with `this.gitlabCredentials.call(repo, 'read', (access) => this.gitlab.listOpenMergeRequests(access, `${repo.owner}/${repo.name}`))`
    when `repo.provider === 'gitlab'`, and with the existing GitHub mint and `listOpenPullRequests` otherwise. Both
    lists go to the same `dispatcher.dispatchRepo` call. The existing catch (warning naming the repo id and
    `errorName(error)`) covers both providers.
- `PrismaFleetRepoRepository.findAutoReviewPage(limit)` (`apps/api/src/fleet/repos/prisma-fleet-repo.repository.ts`)
  - Baseline: `where: { autoReview: true, provider: 'github', githubInstallationId: { not: null }, project: { deletedAt: null } }`.
  - Target: `where: { autoReview: true, project: { deletedAt: null }, OR: [{ provider: 'github', githubInstallationId: { not: null } }, { provider: 'gitlab', gitlabCredential: { isNot: null } }] }`,
    same `orderBy: { id: 'asc' }` and `take: limit`.
- `FleetReposService.configureAutoReview` and `FleetReposService.configureFixChecks` (`apps/api/src/fleet/repos/fleet-repos.service.ts`)
  - Baseline: enabling throws `github app required` when `row.provider !== 'github' || row.githubInstallationId === null`.
  - Target: enabling throws `github app required` when `row.provider === 'github' && row.githubInstallationId === null`,
    and `gitlab credentials required` when `row.provider === 'gitlab' && row.gitlabCredential == null`. Everything
    after the guard is unchanged.
- `apps/web/pages/admin/fleet/repos.vue`
  - Baseline: `FleetRepoAutoReview` and `FleetRepoFixChecks` mount under `v-if="repo.provider === 'github' && repo.githubInstallationId"`.
  - Target: both mount under the same condition `FleetRepoFixUnprotected` already uses:
    `(repo.provider === 'github' && repo.githubInstallationId) || (repo.provider === 'gitlab' && repo.gitlab !== null)`.

### Failure Handling

| Failure | Where | Behaviour |
|:--|:--|:--|
| Listing answers 401 | `listOpenMergeRequests` inside `call` | `gitlab_token_invalid`; `call` marks the read token invalid; the pass warns naming the repo id and the reason and polls the next repo |
| Listing answers 404 | `listOpenMergeRequests` | `repo_not_found`; the pass warns and polls the next repo |
| Listing answers 403 or another status, or a malformed body | `listOpenMergeRequests` | `app_permissions_insufficient` or `provider_error`; the pass warns and polls the next repo |
| Host resolves inside the deployment | `listOpenMergeRequests` host check | `gitlab_host_blocked` before any request; the pass warns and polls the next repo |
| Credential row gone between the page read and the poll | `GitLabRepoCredentials.resolve` | `gitlab_credentials_missing`; the pass warns and polls the next repo |
| Enabling auto-review or trusted checks on a GitLab repo without credentials | `configureAutoReview`, `configureFixChecks` | 422 with reason `gitlab credentials required`; nothing stored, no audit |

## Out of Scope

- Flows on GitLab, host-aware `findByIdentity` for the nax flow entry, and the GitLab setup guide in the docs (feature `gitlab-flows`, the second half of GitLab parity feature 4).
- Paging open merge requests past the first 100; the pass sees the first page only, as on GitHub.
- Reviewing merge requests from forks; they are skipped through `headRepoFullName: null`, as GitHub skips fork pull requests.
- Turning auto-review off when a GitLab token is marked invalid; the pass warns and skips the repo on every poll until an admin rotates the token.
- Inbound GitLab webhooks; the 2026-09-27 ruling stands and auto-review stays poll-driven.
- Minting short-lived GitLab tokens per job; deferred by the owner because gitlab.com Free does not offer them.
- Self-hosted GitLab hosts whose name lacks `gitlab`; they wait for nax #2957.
- Any change to nax's GitLab check reading; nax already reads merge-request pipelines and jobs.
- US-001 only: no test asserts token values are absent from log lines; the pass logs only the repo id and the error reason, never a message or token.
- US-001 only: the host check of the listing is not a separate acceptance criterion; the listing is added to the client spec's shared table "AC-12: %s blocks loopback hosts before requesting", which asserts `gitlab_host_blocked` and no request.
- US-001 only: 403 and 500 answers of the listing are not separate acceptance criteria; they go through the shared `fail` mapping, and the listing is added to the client spec's shared failure-mapping table.
- US-001 only: marking the read token invalid on a 401 is not asserted here; `GitLabRepoCredentials.call` does it, as the feature 1 `call` spec pins, and the pass tests mock `call`.
- US-002 only: a GitHub row without an installation keeps its `github app required` refusal for both settings; the existing `{ githubInstallationId: null }` rows of the two unit tables already pin it, and `### Modifies` keeps them.
- US-003 only: the unconnected GitLab row and the GitHub rows keep their current switches; the existing page test already asserts them, and `### Modifies` keeps those assertions.
- US-002 only: disabling auto-review or trusted checks is unchanged and never refused, for either provider; the existing "disabling" cases already pin it.
- US-002 only: `buildAssignPayload` already passes `trustDetectedChecks` for a FIX on any provider; no change and no new criterion.

## Stories

**US-001: GitLab merge-request listing in the auto-review pass.** Workdir: `apps/api`. No dependencies.
Adds `GitLabAccessChecker.listOpenMergeRequests`, opens `findAutoReviewPage` to connected GitLab repos, and gives
`FleetPrReviewPass.pollRepo` its GitLab branch through `GitLabRepoCredentials.call(repo, 'read', ...)`.

**US-002: Enable guards for auto-review and trusted detected checks on GitLab.** Workdir: `apps/api`. No dependencies.
`configureAutoReview` and `configureFixChecks` allow a GitLab repo with stored credentials and refuse one without
them as `gitlab credentials required`; GitHub refusals stay.

**US-003: Web switches for GitLab repos.** Workdir: `apps/web`. Depends on US-002.
The admin repos page mounts `FleetRepoAutoReview` and `FleetRepoFixChecks` for a GitLab repo with stored
credentials (`repo.gitlab !== null`), as it already does `FleetRepoFixUnprotected`.

### Context Files

**US-001**
- `apps/api/src/fleet/git-broker/gitlab-access-checker.ts` — the access-based client, `guard` and `fail`
- `apps/api/src/fleet/git-broker/gitlab-access-checker.spec.ts` — how the client's requests and host check are stubbed
- `apps/api/src/fleet/reviews/fleet-pr-review.pass.ts` — `pollRepo`
- `apps/api/src/fleet/reviews/review-head-dispatcher.ts` — `skips`, the fork rule the listing must satisfy
- `apps/api/src/fleet/repos/prisma-fleet-repo.repository.ts` — `findAutoReviewPage`

**US-002**
- `apps/api/src/fleet/repos/fleet-repos.service.ts` — `configureAutoReview`, `configureFixChecks`, and `configureFixUnprotected` as the pattern
- `apps/api/src/fleet/repos/auto-review.exception.ts` — `AutoReviewException`
- `apps/api/src/fleet/repos/fix-checks.exception.ts` — `FixChecksException`
- `apps/api/test/integration/fleet/fleet-repo-fix-unprotected-route.integration.spec.ts` — how a GitLab repo with a credential row is seeded for a route test

**US-003**
- `apps/web/pages/admin/fleet/repos.vue` — the switch mounts
- `apps/web/lib/fleet-types.ts` — `FleetRepo.gitlab`
- `apps/web/components/fleet/RepoAutoReview.vue` — the auto-review switch
- `apps/web/components/fleet/RepoFixChecks.vue` — the trusted-checks switch

### Creates

**US-001**
- `apps/api/src/fleet/reviews/fleet-pr-review.pass.gitlab.spec.ts` — the pass's GitLab branch (US-001 AC-12 to AC-15)

### Modifies

**US-001**
- `apps/api/src/fleet/reviews/fleet-pr-review.pass.spec.ts` — `build()` constructs `FleetPrReviewPass` with five arguments; it now passes `GitLabRepoCredentials` and `GitLabAccessChecker` mocks as the sixth and seventh. Every existing GitHub assertion stays.
- `apps/api/src/fleet/git-broker/gitlab-access-checker.spec.ts` — gains the `listOpenMergeRequests` cases; `listOpenMergeRequests` is also added as a row to the shared tables "AC-11: %s maps HTTP failures" (401, 403, 500) and "AC-12: %s blocks loopback hosts before requesting". The new cases are titled from `MR-1` on, so they do not reuse that file's `AC-n` titles. Every existing case and row stays.
- `apps/api/test/integration/fleet/fleet-repo-auto-review.integration.spec.ts` — gains the GitLab listing cases (AC-10, AC-11); "AC-9: excludes enabled repos without a GitHub installation" stays and still holds for a GitHub row.

**US-002**
- `apps/api/src/fleet/repos/fleet-repos.auto-review.spec.ts` — the shared table "AC-9/AC-10 requires installed GitHub app: %o" runs `{ provider: 'gitlab' }` and `{ githubInstallationId: null }` and asserts `github app required` for both; the `{ provider: 'gitlab' }` row is removed from that table (the `{ githubInstallationId: null }` row stays `github app required`), and separate GitLab cases are added: without a `gitlabCredential` (null, and absent) it is refused `gitlab credentials required`, with one it is enabled.
- `apps/api/src/fleet/repos/fleet-repos.fix-checks.spec.ts` — the shared table "refuses to enable on a repo without a GitHub App installation: %o" runs `{ provider: 'gitlab' }` and `{ githubInstallationId: null }` and asserts `github app required` for both; the `{ provider: 'gitlab' }` row is removed from that table (the `{ githubInstallationId: null }` row stays `github app required`), and separate GitLab cases are added: without a `gitlabCredential` it is refused `gitlab credentials required`, with one it is enabled.
- `apps/api/test/integration/fleet/fleet-repo-auto-review-route.integration.spec.ts` — "AC-5: enabling auto-review on a GitLab repo is 422 with the github app reason" pinned `github app required` for a GitLab repo without credentials; it now pins `gitlab credentials required`, and a GitLab repo with a credential row is enabled (200).
- `apps/api/test/integration/fleet/fleet-repo-fix-checks-route.integration.spec.ts` — "AC-3: enabling on a GitLab repo answers 422 with the github app reason and stores nothing" pinned `Detected checks cannot be trusted: github app required`; it now pins `Detected checks cannot be trusted: gitlab credentials required` for a GitLab repo without credentials, and a GitLab repo with a credential row is enabled (200). "AC-4" for a GitHub repo without an installation stays.

**US-003**
- `apps/web/tests/pages/admin-fleet-repos.spec.ts` — "GitLab FIX override mounts only for connected repos and keeps other controls GitHub-only (US-005 AC-1/2/3)" expects the connected GitLab row to hold one switch (`Allow fixes on an unprotected default branch`); it now holds three (`Enable automatic reviews`, `Trust detected checks for fixes`, `Allow fixes on an unprotected default branch`), so the whole-page `labels` list grows from four entries to six (three for the GitHub row, three for the connected GitLab row). The unconnected GitLab row still holds none, and the GitHub row without an installation still holds none.

### Seams

- US-001 adds `GitLabAccessChecker.listOpenMergeRequests`; its consumer is `FleetPrReviewPass.pollRepo` in the same story, pinned at the pass's entry point `FleetPrReviewPass.run(now)` (AC-12).
- US-003 reads `FleetRepo.gitlab`, which feature 1 already returns on `GET /api/fleet/repos`; no new field.

## Acceptance Criteria

### US-001: GitLab merge-request listing in the auto-review pass

- AC-1 [unit] `GitLabAccessChecker.listOpenMergeRequests(access, 'grp/app')` sends `GET <access.target.apiBase>/projects/<access.target.projectId>/merge_requests?state=opened&per_page=100` with the `private-token` header set to `access.token`.
- AC-2 [unit] For a 200 answer holding one item `{ iid: 7, sha: 'abc', draft: false, updated_at: '2026-11-17T00:00:00Z', source_project_id: <access.target.projectId> }`, `listOpenMergeRequests` returns `[{ number: 7, headSha: 'abc', draft: false, headRepoFullName: 'grp/app', updatedAt: new Date('2026-11-17T00:00:00Z') }]`.
- AC-3 [unit] An item with `draft: true` is returned with `draft: true`.
- AC-4 [unit] An item with `work_in_progress: true` and no `draft` field is returned with `draft: true`.
- AC-5 [unit] An item whose `source_project_id` differs from `access.target.projectId` is returned with `headRepoFullName: null`.
- AC-6 [unit] An item whose `sha` is the number `5` makes `listOpenMergeRequests` throw `RepoCheckException` with reason `provider_error`.
- AC-7 [unit] For a 200 answer holding one item with `sha: null` and one valid item, `listOpenMergeRequests` returns only the valid item.
- AC-8 [unit] A 401 answer makes `listOpenMergeRequests` throw `RepoCheckException` with reason `gitlab_token_invalid`.
- AC-9 [unit] A 404 answer makes `listOpenMergeRequests` throw `RepoCheckException` with reason `repo_not_found`.
- AC-10 [integration] `PrismaFleetRepoRepository.findAutoReviewPage(50)` returns a GitLab repo with `autoReview: true` and a `FleetRepoGitlabCredential` row.
- AC-11 [integration] `PrismaFleetRepoRepository.findAutoReviewPage(50)` does not return a GitLab repo with `autoReview: true` and no `FleetRepoGitlabCredential` row.
- AC-12 [unit] With one enabled GitLab repo `{ provider: 'gitlab', owner: 'grp', name: 'app' }` on the page, `FleetPrReviewPass.run(now)` calls `GitLabRepoCredentials.call` with the repo record itself (the page's row, carrying its `host`) and `'read'`, calls `GitLabAccessChecker.listOpenMergeRequests` with the access `call` resolved and `'grp/app'`, and calls `ReviewHeadDispatcher.dispatchRepo` with the repo and the list it returned.
- AC-13 [unit] For an enabled GitLab repo whose row also carries a non-null `githubInstallationId` (`9n`), `FleetPrReviewPass.run(now)` never calls `GitHubAppClient.mintInstallationToken` or `GitHubAppClient.listOpenPullRequests`.
- AC-14 [unit] When `GitLabRepoCredentials.call` rejects with `RepoCheckException('gitlab_token_invalid')` for the first of two enabled repos, `FleetPrReviewPass.run(now)` logs a warning containing the first repo's id and `gitlab_token_invalid`, and still calls `ReviewHeadDispatcher.dispatchRepo` for the second repo.
- AC-15 [unit] When `GitLabRepoCredentials.call` rejects with `RepoCheckException('gitlab_credentials_missing')` for the first of two enabled repos, `FleetPrReviewPass.run(now)` logs a warning containing the first repo's id and `gitlab_credentials_missing`, and still calls `ReviewHeadDispatcher.dispatchRepo` for the second repo.

### US-002: Enable guards for auto-review and trusted detected checks on GitLab

- AC-1 [unit] `FleetReposService.configureAutoReview(principal, id, { enabled: true })` for a GitLab row with a non-null `gitlabCredential` calls `updateAutoReview` with `autoReview: true` and the principal as `autoReviewEnabledById`.
- AC-2 [unit] `configureAutoReview(principal, id, { enabled: true })` for a GitLab row whose `gitlabCredential` is null throws `AutoReviewException` with reason `gitlab credentials required` and status 422, and calls neither `updateAutoReview` nor `audit.record`.
- AC-3 [unit] `configureAutoReview(principal, id, { enabled: true })` for a GitLab row with no `gitlabCredential` field throws `AutoReviewException` with reason `gitlab credentials required`.
- AC-4 [unit] `FleetReposService.configureFixChecks(principal, id, { trustDetectedChecks: true })` for a GitLab row with a non-null `gitlabCredential` calls `updateFixChecks(id, true)` and records the audit summary `fix detected checks enabled`.
- AC-5 [unit] `configureFixChecks(principal, id, { trustDetectedChecks: true })` for a GitLab row whose `gitlabCredential` is null throws `FixChecksException` with reason `gitlab credentials required` and status 422, and calls neither `updateFixChecks` nor `audit.record`.
- AC-6 [integration] `PATCH /api/fleet/repos/:id/auto-review` with `{ enabled: true }` as the global admin, for a GitLab repo with a `FleetRepoGitlabCredential` row, answers 200 with `autoReview: true`, and the stored row has `autoReview: true`.
- AC-7 [integration] `PATCH /api/fleet/repos/:id/auto-review` with `{ enabled: true }` for a GitLab repo without a credential row answers 422 whose body contains `gitlab credentials required`, and the stored row keeps `autoReview: false`.
- AC-8 [integration] `PATCH /api/fleet/repos/:id/fix-checks` with `{ trustDetectedChecks: true }` as the global admin, for a GitLab repo with a `FleetRepoGitlabCredential` row, answers 200 with `fixTrustDetectedChecks: true`.
- AC-9 [integration] `PATCH /api/fleet/repos/:id/fix-checks` with `{ trustDetectedChecks: true }` for a GitLab repo without a credential row answers 422 whose `message` is `Detected checks cannot be trusted: gitlab credentials required.`, and the stored row keeps `fixTrustDetectedChecks: false`.

### US-003: Web switches for GitLab repos

- AC-1 [unit] The admin repos page renders the `Enable automatic reviews` switch in the row of a GitLab repo whose `gitlab` is not null.
- AC-2 [unit] The admin repos page renders the `Trust detected checks for fixes` switch in the row of a GitLab repo whose `gitlab` is not null.
