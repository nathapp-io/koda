# SPEC: GitLab REVIEW, FIX and AGENT jobs (GitLab parity F2)

## Summary

Feature 2 of 4 of GitLab parity for the koda fleet. The design was approved by the owner on 2026-11-16:
`docs/superpowers/specs/2026-11-16-gitlab-parity-design.md` (sections 5, 6.2, 6.5 and 8). Feature 1
(`gitlab-repo-credentials`, PR #472) gave each GitLab fleet repo its own host, project id and two stored tokens,
and moved the RUN write mint onto them.

This feature opens the job kinds that are still GitHub-only to GitLab repos:

- REVIEW, FIX and AGENT dispatch from the dispatch route, and REVIEW and FIX from the assistant's `dispatch_job`
  tool (the tool has no AGENT path);
- the git broker's purpose mints (`review`, `read`, `fix`) and the per-repository read-only mint, each answered
  from the right stored token: read jobs get the read token, and nothing falls back to the write token;
- the FIX protected-branch gate, which asks GitLab whether the bot can push to the default branch;
- the bot identity: on GitLab, koda's own login is the write token's username, so the REVIEW/FIX `botLogin` and
  the RUN login-only identity use it;
- the runner, which today accepts only a `<slug>[bot]` review login and gives a GitLab RUN no forge identity;
- the FIX unprotected-branch override, which can now be turned on for a GitLab repo with stored credentials.

Every GitHub path stays as it is.

## Motivation

After feature 1, a GitLab repo has a read token and a write token, but only RUN uses them. REVIEW, FIX and AGENT
are refused at dispatch (`fleet-jobs.service.ts` `ReviewProviderException`, "review is GitHub-only"), the broker
refuses every GitLab purpose and read-only mint with `provider_error`, and the runner's assign parser rejects any
review login that does not end in `[bot]`, which a GitLab username never does. So koda cannot review or fix a
GitLab merge request, and an AGENT job cannot read a GitLab repo. The owner's first live target is
`freqtrade/quant-crypto-trader` on gitlab.com.

## Design

### Token per job kind (design section 6.2)

| Mint | Token | `repoId` on the result |
|:--|:--|:--|
| no purpose, no `readOnly` (RUN, PLAN) | write | no (unchanged) |
| `purpose: 'review'` (REVIEW) | write | no |
| `purpose: 'read'` (AGENT) | read | no |
| `readOnly: true`, no purpose (project/thread sessions) | read | yes |
| `purpose: 'fix'` (FIX) | write, after the protection check | no |

Every GitLab mint answers `username: 'oauth2'` and `expiresAt = now + gitlabTokenTtlSec`, as the RUN mint does
today. The cache keys do not change, so a `read` or `readOnly` entry can never answer a write request and the
other way round. REVIEW uses the write token because GitLab has no comment-only scope; nax bot review never
pushes, and the runner's review profile is unchanged.

The GitLab `readOnly` mint has no production caller in this feature: `fetchableProjectRepos`
(`jobs/project-repos-assign.ts`) still keeps only GitHub repos, so `SyncService` never requests one for a GitLab
repo. Feature 3 opens that path; this feature makes the broker answer it correctly when it does.

### FIX protected-branch gate

When `fixAllowUnprotected` is not true, the broker checks the default branch before it resolves the write token.
The question the gate answers is "can the bot push to the default branch?", so it asks GitLab as the bot:

1. Through `GitLabRepoCredentials.call(repo, 'write', fn)`, `fn` calls
   `GitLabAccessChecker.getBranchPushState(access, repo.defaultBranch)`, which sends
   `GET /projects/:id/repository/branches/:branch` (branch URL-encoded) and returns the body's `protected` and
   `can_push` booleans as `{ protected, canPush }`. `can_push` is GitLab's answer for the token's own user, so it
   already accounts for wildcard rules, per-user, per-group and deploy-key entries, force-push settings and
   inherited group roles.
2. The branch counts as protected only when `protected` is true and `canPush` is false. Otherwise the mint answers
   `default_branch_unprotected` and the write token is never resolved. The reason is deliberately the same for "no
   protection" and "protected, but the bot can push" (common when the bot holds Maintainer): in both cases the bot
   could push to the default branch. The web hint for a GitLab repo says so (US-005).
3. A failure of the check answers its reason (`repo_not_found` for 404, `gitlab_token_invalid` for 401, which also
   marks the write token invalid through `call`, `app_permissions_insufficient` for 403, `provider_error`
   otherwise) and the write token is never resolved.

This is a deliberate refinement of the design's section 5 row, which proposed reading `protected_branches` and
`members/all` with the read token. That approach needs a read-token role that may not see protected-branch
settings, misses wildcard rules, and must re-implement GitLab's push rules. The branch call is a read, and the
write token is used only by koda's own process here, never handed to a read job.

### Bot identity (design section 6.5)

`FleetRepoRef` gains `gitlabWriteUser?: { id: number; username: string } | null`, read from the repo's
`FleetRepoGitlabCredential` row (`writeTokenUserId`, `writeTokenUsername`) by `PrismaFleetJobRepository.findRepo`.
It is null for a GitHub repo and for a GitLab repo without a credential record. No token column is selected.
`findProjectRepos` is unchanged.

`gitIdentityFor` takes the repo instead of only its provider:

- GitHub: unchanged, `<githubAppSlug ?? 'koda-fleet'>[bot]` and its noreply email;
- GitLab with `gitlabWriteUser`: name = `gitlabWriteUser.username`, email = `gitlabBotEmail`;
- GitLab without it: name = `gitlabBotName`, email = `gitlabBotEmail` (today's value).

`buildAssignPayload` already sets `review.botLogin` and `gitIdentity` from that identity, so a GitLab REVIEW or
FIX carries the write token's username as its bot login, and a GitLab RUN carries it as `gitIdentity.name`.

### Runner (design section 8)

- A review login is valid when it matches its provider's pattern. GitHub keeps
  `^[A-Za-z0-9][A-Za-z0-9-]*\[bot\]$`. GitLab uses the GitLab username pattern
  `^[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?$`. Both keep the 1 to 100 length bound. One exported function
  `isValidBotLogin(provider, login)` in `executor/nax-process.ts` holds both patterns, and both the assign parser
  and `reviewPrNumber` call it.
- `runIdentityEnv` gives a GitLab RUN the same login-only identity as a GitHub RUN
  (`NAX_FORGE_IDENTITY=login-only`, `NAX_FORGE_LOGIN=gitIdentity.name`) when the job's shims are on PATH, and the
  same warning and no identity when they are not. nax's login-only mode supports glab; no user id is sent.
- `reviewEnv` and `spawnFixStep` are already provider-neutral (token file plus `NAX_FORGE_LOGIN`).

### Integration

Read only (verified at koda main `79ec0311`):

- `GitLabRepoCredentials.resolve(repo, kind)` and `call(repo, kind, fn)` (`git-broker/gitlab-repo-credentials.ts`),
  `GitLabAccess = { token, target: { apiBase, projectId } }`.
- `GitLabAccessChecker` private helpers `projectUrl(access)`, `guard(target)` and `fail(status)`
  (`git-broker/gitlab-access-checker.ts`); `getBranchHead` is the shape the new method mirrors.
- `RepoCheckException(reason)` and its `RepoCheckReason` union, which already holds `default_branch_unprotected`
  and `gitlab_host_blocked`.
- `FixUnprotectedException(reason)` (`repos/fix-unprotected.exception.ts`), 422.
- `FleetRepoRecord.gitlabCredential` (`repos/domain/fleet-repo.domain.ts`), optional: absent, null or the
  credential view without secrets.
- `SyncService` token requests (`sync/sync.service.ts`), which call `findRepo` and mint with `purpose` `read`,
  `review` or `fix` for AGENT, REVIEW and FIX jobs.
- Runner `credentials.acquire` and `binDir` in `HostExecutor.spawn` (`apps/runner/src/executor/host-executor.ts`).

The baseline exists only to locate the code. Implement the target, never the baseline.

- `GitTokenBroker.mint` / `fresh` (`git-broker/git-token.broker.ts`)
  - Baseline: `if (req.purpose && req.repo.provider !== 'github')` answers `provider_error`; `fresh` throws
    `provider_error` for any GitLab purpose or `readOnly`, and resolves only the write token.
  - Target: GitLab mints follow the token table above; the early purpose refusal and the GitLab `provider_error`
    branch are gone. The broker gains a `GitLabAccessChecker` constructor dependency for the gate, appended as the
    fourth constructor parameter, after `GitLabRepoCredentials`: `(fleetConfig, github, gitlab, gitlabChecker)`.
- `GitLabAccessChecker` gains `getBranchPushState(access, branch): Promise<{ protected: boolean; canPush: boolean }>`.
- `FleetRepoRef` (`jobs/domain/fleet-job.domain.ts`)
  - Baseline: no GitLab user field.
  - Target: gains `gitlabWriteUser?: { id: number; username: string } | null`, filled by `findRepo`.
- `gitIdentityFor` (`jobs/assign-payload.ts`)
  - Baseline: `gitIdentityFor(provider: 'github' | 'gitlab', cfg)`.
  - Target: `gitIdentityFor(repo: Pick<FleetRepoRef, 'provider' | 'gitlabWriteUser'>, cfg)`;
    `placement.service.ts` passes the repo it already holds.
- `FleetJobsService.dispatch` (`jobs/fleet-jobs.service.ts`)
  - Baseline: REVIEW, FIX and AGENT on a non-GitHub repo throw `ReviewProviderException` ("<kind> is GitHub-only").
  - Target: no provider refusal; `ReviewProviderException` is deleted.
- `dispatch_job` tool `preview` (`assistant/tools/dispatch-job-tool.ts`)
  - Baseline: REVIEW and FIX on a non-GitHub repo throw `ToolInputError('<kind> is GitHub-only')`.
  - Target: no provider refusal.
- `FleetReposService.configureFixUnprotected` (`repos/fleet-repos.service.ts`)
  - Baseline: enabling on any repo that is not GitHub with an installation throws
    `FixUnprotectedException('github app required')`.
  - Target: a GitHub repo keeps that rule; a GitLab repo may enable it when `gitlabCredential` is present and not
    null, and is refused with `FixUnprotectedException('gitlab credentials required')` otherwise. Disabling is
    always allowed. The exception's doc comment names both reasons.
- Runner `isValidBotLogin` is new; `parseAssign` (`supervisor/assign-parser.ts`) and `reviewPrNumber`
  (`executor/nax-process.ts`) replace their inline `[bot]` pattern with it. `HostExecutor.runIdentityEnv`
  (baseline: returns `{}` for any non-GitHub job) serves GitLab RUN jobs too.
- Web `apps/web/pages/admin/fleet/repos.vue`
  - Baseline: `FleetRepoFixUnprotected` mounts only for `provider === 'github' && githubInstallationId`.
  - Target: it also mounts for a GitLab repo whose `gitlab` field is not null. Auto-review and fix-checks stay
    GitHub-only (feature 4).
- Web `apps/web/components/fleet/RepoFixUnprotected.vue`
  - Baseline: always shows `fleet.repos.fixUnprotected.hint` ("... the default branch has no protection rule ...").
  - Target: a GitLab repo shows the new key `fleet.repos.fixUnprotected.hintGitlab` instead. English: "Override: FIX
    jobs may push even when the bot account can push to the default branch (it has no protection rule, or the rule
    lets the bot push). Leave off unless the repository cannot be protected." Chinese:
    "覆盖：即使机器人账号可以推送到默认分支（默认分支没有保护规则，或保护规则允许机器人推送），FIX 任务也可以推送。除非仓库无法设置保护，否则请保持关闭。"
    A GitHub repo keeps `hint`.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| GitLab REVIEW, AGENT or `readOnly` mint for a repo without a credential record | `gitlab_credentials_missing` (with `repoId` for `readOnly` only); no token issued |
| GitLab FIX mint for a repo without a credential record | `gitlab_credentials_missing` from `call`; no GitLab request, no token issued |
| Default branch not protected, or protected but the bot can push | `default_branch_unprotected`; write token never resolved |
| Branch check answers 404 | `repo_not_found`; write token never resolved |
| Branch check answers 401 | `gitlab_token_invalid`; the write token is marked invalid (through `call`); no token issued |
| Branch check answers 403 or another error, or a body without boolean `protected` and `can_push` | `app_permissions_insufficient` or `provider_error`; write token never resolved |
| Branch check on a host that now resolves to a blocked address | `gitlab_host_blocked`; no request sent |
| Enabling the FIX override on a GitLab repo without credentials | 422 `FixUnprotectedException('gitlab credentials required')`; nothing saved |
| ASSIGN with a GitLab review login that breaks the GitLab pattern | the runner refuses the assign as `review`, as it does a bad GitHub login today |
| GitLab RUN without the job's shims on PATH | no forge identity, warning `RUN starts without a forge identity` |

## Out of Scope

- Auto-review, fix-checks (`trustDetectedChecks`), CI pipeline status and flows on GitLab (feature 4 of GitLab parity); their GitHub-only guards stay.
- Threads with project code, the project brief, the knowledge index, PR rulings and review events on GitLab (feature 3 of GitLab parity), including opening `fetchableProjectRepos` to GitLab repos and adding `gitlabWriteUser` to `findProjectRepos`.
- PR rulings on a GitLab FIX: `FleetPrRulingsService.snapshotForFix` answers `notSent: 'head-unreadable'` for a GitLab repo (no installation), so a GitLab FIX dispatches without rulings until feature 3.
- The GitLab username pattern of the bot-review ingest parser (`ingest/parsers/bot-review.parser.ts` `LOGIN`), which belongs to review events (feature 3).
- Sending the bot's numeric user id to nax (`NAX_FORGE_USER_ID`); nax compares GitLab authors by username, which is unique on a host.
- A `gitlab_read_token_missing` reason; feature 1 stores both tokens at registration, so a credential record always has a read token.
- Minting short-lived GitLab tokens per job; deferred by the owner because gitlab.com Free does not offer them.
- The GitLab setup guide in the docs (bot account, token scopes, Developer role, protecting the default branch); written when feature 4 closes the arc.
- US-002 only: retrying the branch check; a transient failure answers its reason and the job fails its mint as a GitHub one does.
- US-002 only: no test asserts token values are absent from log lines; the broker already logs only the job id and the error name, never a message or token.
- US-003 only: changing the git commit email of GitLab jobs; it stays `gitlabBotEmail`.

## Stories

**US-001: GitLab branch push state and the write user on the repo ref.** Workdir: `apps/api`. No dependencies.
Adds `GitLabAccessChecker.getBranchPushState` and `FleetRepoRef.gitlabWriteUser` filled by
`PrismaFleetJobRepository.findRepo`.

**US-002: Broker purpose and read-only mints for GitLab.** Workdir: `apps/api`. Depends on US-001.
`GitTokenBroker` answers GitLab `review`, `read`, `fix` and `readOnly` mints from the stored tokens per the token
table, runs the FIX branch check through `GitLabRepoCredentials.call(repo, 'write', ...)`, and drops the GitLab
purpose refusals.

**US-003: GitLab dispatch, bot identity and the FIX override.** Workdir: `apps/api`. Depends on US-001.
Removes the GitHub-only refusals from `FleetJobsService.dispatch` and the `dispatch_job` tool, changes
`gitIdentityFor` to take the repo and use the write token's username on GitLab, passes the repo from
`PlacementService`, and lets `configureFixUnprotected` enable the override on a GitLab repo with credentials.

**US-004: Runner GitLab review login and RUN identity.** Workdir: `apps/runner`. Depends on US-003.
Adds `isValidBotLogin(provider, login)` and uses it in the assign parser and `reviewPrNumber`, and gives a GitLab
RUN the login-only identity.

**US-005: Web FIX override switch for GitLab repos.** Workdir: `apps/web`. Depends on US-003.
The admin repos page mounts `FleetRepoFixUnprotected` for a GitLab repo with stored credentials, and the switch
shows the GitLab hint (`hintGitlab`, en and zh) for a GitLab repo.

### Context Files

**US-001**
- `apps/api/src/fleet/git-broker/gitlab-access-checker.ts` — the access-based client and its helpers
- `apps/api/src/fleet/git-broker/gitlab-access-checker.spec.ts` — how the client's requests are stubbed
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findRepo` select
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `FleetRepoRef`
- `apps/api/prisma/schema.prisma` — `FleetRepoGitlabCredential`

**US-002**
- `apps/api/src/fleet/git-broker/git-token.broker.ts` — the broker
- `apps/api/src/fleet/git-broker/gitlab-repo-credentials.ts` — `resolve` and `call`
- `apps/api/src/fleet/git-broker/git-broker.module.ts` — provider wiring
- `apps/api/src/fleet/sync/sync.service.ts` — the token-request path that mints for REVIEW, FIX and AGENT
- `apps/api/src/fleet/sync/sync.service.token-purpose.spec.ts` — the sync-level purpose tests to extend

**US-003**
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `dispatch` and `ReviewProviderException`
- `apps/api/src/fleet/assistant/tools/dispatch-job-tool.ts` — `preview`
- `apps/api/src/fleet/jobs/assign-payload.ts` — `gitIdentityFor`, `buildAssignPayload`
- `apps/api/src/fleet/jobs/placement.service.ts` — the `gitIdentityFor` call site
- `apps/api/src/fleet/repos/fleet-repos.service.ts` — `configureFixUnprotected`

**US-004**
- `apps/runner/src/supervisor/assign-parser.ts` — the review block check
- `apps/runner/src/executor/nax-process.ts` — `reviewPrNumber`
- `apps/runner/src/executor/host-executor.ts` — `runIdentityEnv`, `reviewEnv`, `spawnFixStep`

**US-005**
- `apps/web/pages/admin/fleet/repos.vue` — the switch mounts
- `apps/web/components/fleet/RepoFixUnprotected.vue` — the hint
- `apps/web/i18n/locales/en.json` — `fleet.repos.fixUnprotected`
- `apps/web/i18n/locales/zh.json` — `fleet.repos.fixUnprotected`
- `apps/web/lib/fleet-types.ts` — `FleetRepo.gitlab`

### Creates

**US-003**
- `apps/api/src/fleet/jobs/assign-payload.git-identity.spec.ts` — `gitIdentityFor` cases for GitHub and GitLab
- `apps/api/src/fleet/jobs/placement.service.git-identity.spec.ts` — placement of a GitLab REVIEW carries the write token's username (AC-9)

### Modifies

**US-002**
- `apps/api/src/fleet/git-broker/git-token.broker.spec.ts` — the cases "US-003 AC-10: refuses a read-only GitLab mint without resolving a credential" and "US-001 AC11: a read-only mint for a GitLab repository fails provider_error without any provider call" pinned `provider_error`; a GitLab `readOnly` mint now resolves the read token and answers it with `repoId`. The broker gains a `GitLabAccessChecker` constructor argument. The GitLab write-mint, eviction and failure-mapping assertions stay.
- `apps/api/src/fleet/git-broker/git-token.broker.purpose.spec.ts` — the cases "AC-11, AC-12: rejects GitLab %s purpose", "US-003 AC-2: rejects a GitLab read purpose" and "AC-9: never falls back to a stored GitLab credential already cached by a write mint" pinned `provider_error` for GitLab purposes; they now pin the token table (review and fix answer the write token, read the read token, and a cached write entry never answers a read request). The broker gains a `GitLabAccessChecker` constructor argument. Every GitHub assertion stays.
- `apps/api/src/fleet/sync/sync.service.token-purpose.spec.ts` — the `GitTokenBroker` it builds gains a `GitLabAccessChecker` mock as its new constructor argument; every existing token-purpose assertion stays.

**US-003**
- `apps/api/src/fleet/jobs/fleet-jobs.service.spec.ts` — "US-002 AC-1/8: FIX and REVIEW retain command-specific GitHub-only rejection" (and any AGENT twin asserting `agent is GitHub-only`) pinned the refusal for a GitLab repo; a GitLab REVIEW, FIX or AGENT dispatch now creates the job.
- `apps/api/src/fleet/assistant/tools/dispatch-job-tool.pr.spec.ts` — "AC-2: refuses GitLab %s" pinned `ToolInputError`; a GitLab REVIEW or FIX preview now returns the preview text.
- `apps/api/test/integration/fleet/fleet-review-dispatch.integration.spec.ts` — "US-002 AC-1/8: rejects FIX and keeps the existing REVIEW GitLab rejection reason" pinned the 422 `is GitHub-only`; a GitLab REVIEW or FIX with a `prNumber` now answers 201 with features `review-pr-7` and `fix-pr-7`.
- `apps/api/test/integration/fleet/fleet-review-dispatch.integration.spec.ts` — "US-003 AC-3/4: rejects a REVIEW for a GitLab repo before dispatch normalization" pinned `review is GitHub-only` for a REVIEW without a `prNumber`; it now asserts that request is refused 422 by dispatch normalization, the same answer a GitHub repo gets.
- `apps/api/test/integration/fleet/assistant-dispatch-job-tool-pr.integration.spec.ts` — "AC-12: REVIEW and FIX on GitLab store no action" pinned the `is GitHub-only` refusal; a GitLab REVIEW or FIX now stores the pending action like a GitHub one.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the case asserting `agent is GitHub-only`, `review is GitHub-only` and `fix is GitHub-only` with no `fleetJob` row for a GitLab repo pinned the refusal; GitLab AGENT, REVIEW and FIX dispatches now create jobs.
- `apps/api/src/fleet/repos/fleet-repos.fix-unprotected.spec.ts` — the `github app required` refusal now applies to GitHub rows only; a GitLab row with `gitlabCredential` may enable the override, and one without it (absent or null) is refused `gitlab credentials required`.
- `apps/api/test/integration/fleet/fleet-repo-fix-unprotected-route.integration.spec.ts` — "enabling on a GitLab repo answers 422 with the github app reason" pinned `github app required` for a GitLab repo without a credential record; it now answers 422 with `gitlab credentials required`.

**US-004**
- `apps/runner/test/unit/host-executor.spec.ts` — "US-008 AC-5: GitLab RUN gets no injected identity" pinned no identity for a GitLab RUN with shims; it now gets `NAX_FORGE_IDENTITY=login-only` and `NAX_FORGE_LOGIN` equal to `gitIdentity.name`. The no-shim warning case stays.

**US-005**
- `apps/web/tests/pages/admin-fleet-repos.spec.ts` — "mounts fix-checks and fix-unprotected switches only for GitHub repos with installations (AC-8)" now also expects the unprotected-branch switch for a GitLab repo whose `gitlab` field is not null; a GitLab repo with `gitlab` null still gets no switch, and auto-review and fix-checks stay GitHub-only.

### Seams

- US-001 → US-002: `getBranchPushState` is called by the broker's FIX gate. Seam ACs: US-002 AC-6, AC-13.
- US-001 → US-003: `FleetRepoRef.gitlabWriteUser` is read by `gitIdentityFor` through placement. Seam AC: US-003 AC-9.
- US-003 → US-004: a GitLab ASSIGN carries the write token's username as `review.botLogin` and `gitIdentity.name`. Seam ACs: US-004 AC-1, AC-6.

## Acceptance Criteria

### US-001

- AC-1 [unit] `GitLabAccessChecker.getBranchPushState(access, 'main')` sends `GET <apiBase>/projects/<projectId>/repository/branches/main` with the access token and, for a 200 body with `protected: true` and `can_push: false`, returns `{ protected: true, canPush: false }`.
- AC-2 [unit] `getBranchPushState(access, 'release/1.0')` URL-encodes the branch as `release%2F1.0` in the request path.
- AC-3 [unit] `getBranchPushState` throws `RepoCheckException` with reason `repo_not_found` when GitLab answers 404.
- AC-4 [unit] `getBranchPushState` throws `RepoCheckException` with reason `gitlab_token_invalid` when GitLab answers 401.
- AC-5 [unit] `getBranchPushState` throws `RepoCheckException` with reason `app_permissions_insufficient` when GitLab answers 403.
- AC-6 [unit] `getBranchPushState` throws `RepoCheckException` with reason `provider_error` when GitLab answers 500.
- AC-7 [unit] `getBranchPushState` throws `RepoCheckException` with reason `provider_error` for a 200 body whose `can_push` is missing, and for one whose `protected` is the string `"true"`.
- AC-8 [unit] `getBranchPushState` for an access whose api base host resolves to a loopback address throws `RepoCheckException` with reason `gitlab_host_blocked` and sends no request.
- AC-9 [integration] `PrismaFleetJobRepository.findRepo` for a GitLab repo with a credential record returns `gitlabWriteUser` `{ id: <writeTokenUserId>, username: <writeTokenUsername> }` and no `encryptedReadToken` or `encryptedWriteToken` key.
- AC-10 [integration] `findRepo` returns `gitlabWriteUser` null for a GitHub repo.
- AC-11 [integration] `findRepo` returns `gitlabWriteUser` null for a GitLab repo without a credential record.

### US-002

- AC-1 [unit] A GitLab mint with `purpose: 'review'` calls `GitLabRepoCredentials.resolve(repo, 'write')` and answers `{ token: <write token>, username: 'oauth2', expiresAt: now + gitlabTokenTtlSec }` with no `repoId` key.
- AC-2 [unit] A GitLab mint with `purpose: 'read'` calls `resolve(repo, 'read')`, never `resolve(repo, 'write')`, and answers the read token with no `repoId` key.
- AC-3 [unit] A GitLab mint with `readOnly: true` and no purpose calls `resolve(repo, 'read')` and answers the read token with `repoId` equal to the repo id.
- AC-4 [unit] After a GitLab write mint (no purpose) for job `j1` epoch 1 is cached, a `purpose: 'read'` mint for the same job and epoch calls `resolve(repo, 'read')` and answers the read token, not the cached write token.
- AC-5 [unit] A GitLab mint with `purpose: 'review'` whose `resolve` rejects with `RepoCheckException('gitlab_credentials_missing')` answers `{ ok: false, error: { jobId, reason: 'gitlab_credentials_missing' } }` with no `repoId`.
- AC-6 [unit] A GitLab `purpose: 'fix'` mint with `fixAllowUnprotected` false calls `GitLabRepoCredentials.call(repo, 'write', fn)`, whose `fn` calls `getBranchPushState(access, repo.defaultBranch)`, and for `{ protected: true, canPush: false }` answers the token from `resolve(repo, 'write')`.
- AC-7 [unit] A GitLab `purpose: 'fix'` mint whose branch check answers `{ protected: false, canPush: true }` answers `default_branch_unprotected` and never calls `resolve(repo, 'write')`.
- AC-8 [unit] A GitLab `purpose: 'fix'` mint whose branch check answers `{ protected: true, canPush: true }` answers `default_branch_unprotected` and never calls `resolve(repo, 'write')`.
- AC-9 [unit] A GitLab `purpose: 'fix'` mint with `fixAllowUnprotected` true makes no `getBranchPushState` call and answers the write token.
- AC-10 [unit] A GitLab `purpose: 'fix'` mint whose `call` rejects with `RepoCheckException('gitlab_token_invalid')` answers `gitlab_token_invalid` and never calls `resolve(repo, 'write')`.
- AC-11 [unit] A GitLab `purpose: 'fix'` mint whose `getBranchPushState` rejects with `RepoCheckException('provider_error')` answers `provider_error` and never calls `resolve(repo, 'write')`.
- AC-12 [unit] A GitHub `purpose: 'review'` mint still calls `GitHubAppClient.mintReviewToken` and never calls `GitLabRepoCredentials.resolve`.
- AC-13 [unit] A `SyncService` sync whose runner requests the git token of its runner-held (ASSIGNED) GitLab FIX job, with a real `GitTokenBroker` over a stubbed `GitLabAccessChecker` answering `{ protected: true, canPush: false }` and a stubbed `GitLabRepoCredentials`, returns that job's write token in `gitTokens` and calls `getBranchPushState` with the repo's default branch.
- AC-14 [unit] The same `SyncService` sync for a runner-held (ASSIGNED) GitLab AGENT job returns the read token in `gitTokens` and never resolves the write token.

### US-003

- AC-1 [unit] `FleetJobsService.dispatch` with command `REVIEW` on a GitLab repo of the project creates a QUEUED job and throws no exception.
- AC-2 [unit] `dispatch` with command `FIX` on a GitLab repo creates a QUEUED job.
- AC-3 [unit] `dispatch` with command `AGENT` on a GitLab repo creates a QUEUED job.
- AC-4 [unit] The `dispatch_job` tool's `preview` for `REVIEW` with `prNumber` 12 on a GitLab repo returns text containing the line `pull request: #12` and throws no `ToolInputError`.
- AC-5 [unit] The `dispatch_job` tool's `preview` for `FIX` on a GitLab repo returns the preview text and throws no `ToolInputError`.
- AC-6 [unit] `gitIdentityFor({ provider: 'gitlab', gitlabWriteUser: { id: 77, username: 'koda-bot' } }, cfg)` returns `{ name: 'koda-bot', email: cfg.gitlabBotEmail }`.
- AC-7 [unit] `gitIdentityFor({ provider: 'gitlab', gitlabWriteUser: null }, cfg)` returns `{ name: cfg.gitlabBotName, email: cfg.gitlabBotEmail }`.
- AC-8 [unit] `gitIdentityFor({ provider: 'github', gitlabWriteUser: null }, cfg)` with `cfg.githubAppSlug` `koda-fleet` returns name `koda-fleet[bot]` and email `koda-fleet[bot]@users.noreply.github.com`.
- AC-9 [unit] `PlacementService` placing a GitLab REVIEW job whose repo from `findRepo` has `gitlabWriteUser.username` `koda-bot` sends an ASSIGN payload with `gitIdentity.name` `koda-bot` and `review.botLogin` `koda-bot`.
- AC-10 [unit] `FleetReposService.configureFixUnprotected` with `allowUnprotected: true` on a GitLab repo whose `gitlabCredential` is present and not null saves the flag and records the `fleet.repo.fix.unprotected` audit entry.
- AC-11 [unit] `configureFixUnprotected` with `allowUnprotected: true` on a GitLab repo whose `gitlabCredential` is null throws `FixUnprotectedException` with reason `gitlab credentials required` and saves nothing, and so does a GitLab repo whose `gitlabCredential` is absent.
- AC-12 [unit] `configureFixUnprotected` with `allowUnprotected: true` on a GitHub repo with `githubInstallationId` null still throws `FixUnprotectedException` with reason `github app required`.

### US-004

- AC-1 [unit] `parseAssign` accepts a `REVIEW` assign whose `repo.provider` is `gitlab` and whose `review.botLogin` is `koda-bot`, and the parsed job carries `review.botLogin` `koda-bot`.
- AC-2 [unit] `parseAssign` refuses as `review` a GitLab `REVIEW` assign whose `review.botLogin` is `koda bot` (contains a space).
- AC-3 [unit] `parseAssign` refuses as `review` a GitHub `REVIEW` assign whose `review.botLogin` is `koda-fleet` (no `[bot]` suffix).
- AC-4 [unit] `isValidBotLogin('gitlab', 'koda_fleet.bot-1')` returns true, and `isValidBotLogin('gitlab', 'koda-fleet[bot]')` and `isValidBotLogin('gitlab', 'bot.')` return false.
- AC-5 [unit] `buildNaxArgv` for a GitLab `REVIEW` assign with `review.botLogin` `koda-bot` returns the review argv and throws no `PathError`, and for a GitHub `REVIEW` assign with `koda-fleet` throws `PathError('invalid review')`.
- AC-6 [unit] `HostExecutor.spawn` for a GitLab `RUN` whose credentials give a `binDir` starts nax with `NAX_FORGE_IDENTITY` `login-only` and `NAX_FORGE_LOGIN` equal to `assign.gitIdentity.name`.
- AC-7 [unit] `HostExecutor.spawn` for a GitLab `RUN` without a `binDir` starts nax with no `NAX_FORGE_IDENTITY` or `NAX_FORGE_LOGIN` and logs the warning `RUN starts without a forge identity`.
- AC-8 [unit] `HostExecutor.spawn` for a GitLab `REVIEW` with `review.botLogin` `koda-bot` starts nax with `NAX_FORGE_LOGIN` `koda-bot` and a `NAX_FORGE_TOKEN_FILE` path.
- AC-9 [unit] `HostExecutor.spawnFixStep` for a GitLab `FIX` with `review.botLogin` `koda-bot` starts nax with `NAX_FORGE_LOGIN` `koda-bot` and a `NAX_FORGE_TOKEN_FILE` path.
- AC-10 [unit] `buildFixArgv` for a GitLab `FIX` assign with `review.botLogin` `koda-bot` returns the fix argv and throws no `PathError`.

### US-005

- AC-1 [unit] The admin fleet repos page mounts the switch labelled `Allow fixes on an unprotected default branch` for a GitLab repo whose `gitlab` field is not null.
- AC-2 [unit] The admin fleet repos page mounts no switch for a GitLab repo whose `gitlab` field is null.
- AC-3 [unit] For a GitLab repo whose `gitlab` field is not null, the page mounts neither the `Enable automatic reviews` switch nor the `Trust detected checks for fixes` switch.
- AC-4 [unit] `RepoFixUnprotected` for a GitLab repo renders the `fleet.repos.fixUnprotected.hintGitlab` text, and for a GitHub repo renders the `fleet.repos.fixUnprotected.hint` text.
- AC-5 [unit] The en and zh locale files both define `fleet.repos.fixUnprotected.hintGitlab` with the texts given in the Design.
