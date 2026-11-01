# SPEC: Whole-repo review P0 bundle (agent escalation, raw-job isolation, review/fix token scope, SSR session refresh)

## Summary

This feature fixes the P0 findings of the 2026-11-01 whole-repo review (`docs/20261101-review-whole-repo.md`). It
closes five holes:

1. **A/SEC-2.** An agent's self-update on the project roster route skips parsing and the approval gate. The self path
   now accepts only a shutdown (`status` `PAUSED` or `OFFLINE`, no other field). Also, `maxConcurrentTickets` must be
   a whole number of at least 1.
2. **A/SEC-1.** An agent holding Project Admin can create a human Project Admin, with no human approval, through
   `member.add`, `invite.create` or `invite.resend`. These three keys become critical risk, so they carry the design's
   `human` approval floor that role-binding keys already carry. A human acting directly still runs at once.
3. **D/SEC-1 (Ruling 5).** A raw job's agent runs as the runner's OS user, so it can read every other job's git
   credentials on that runner. Placement now refuses to put a raw agent job on a runner holding another project's job,
   and refuses to put any job beside another project's raw agent job. The new misfit reason is `trust_domain`.
4. **B/SEC-1 and D/SEC-3.** REVIEW jobs now get a review-scoped token with read-only contents. FIX jobs get their
   write token only when the repo's default branch is protected against direct pushes.
5. **D/BUG-1.** A full page load with a valid refresh cookie but no access cookie no longer sends the user to /login.
   A Nitro server middleware refreshes the session before rendering.

The bundle spans `apps/api` and `apps/web`. The runner is unchanged: when a token request returns an error, its
credential request fails, so the step that needs the token cannot start.

## Motivation

The 2026-11-01 review graded koda C+ (74/100), with four HIGH findings and one design gap that became exposed once
S6 K1-K3 shipped:

- **Agent self-update (A/SEC-2).** `ProjectsController.updateProjectAgent` passes the raw body to
  `AgentsService.update` when an agent targets itself. The comment says this is for "self shutdown", but the code
  applies any field. An admin pauses a misbehaving agent; the agent sends
  `PATCH /api/projects/p/agents/<self> {"status":"ACTIVE","maxConcurrentTickets":1000}` and is active again, with no
  approval request and no audit of an approver.
- **Role grants by agents (A/SEC-1).** The redesign design (`docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md`,
  "Role, binding and policy keys: floor `human`") puts a `human` floor on role-binding keys. But `member.add` and
  `invite.create` grant roles without being binding keys (`RoleAdminService.assertMayGrant` says the calling route's
  own key is the gate), and `classifyRisk` rates them `medium`, so their floor is `none`. An agent with Project Admin
  invites an address it controls as Project Admin, gets the raw `invitePath` back, and accepts it. The result is a
  human-tier account that can approve the agent's own requests. `invite.resend` returns a fresh raw link the same way.
- **Raw job isolation (D/SEC-1).** Ruling 5 (accepted 2026-10-18) said one runner is one trust domain, and that no
  raw job may run beside another project's job. Placement never enforced this. Since K1/K3, every REVIEW and FIX job
  is forced to `bashMode: raw`, and FIX writes its write-capable forge token to `<jobDir>/forge-token`. Every job runs
  as the same OS user, so a raw agent can read that file and connect to any job's credential socket. The per-job
  socket nonce from the original ruling is dropped: it cannot protect a token that also sits in a same-user-readable
  file. Placement isolation is the control that works (user ruling, 2026-11-01).
- **REVIEW/FIX token scope (B/SEC-1, D/SEC-3).** `SyncService.grantTokens` mints the same
  `contents: write, pull_requests: write` token for REVIEW and FIX as for RUN. A REVIEW only reads code and writes PR
  comments. A FIX must push, but GitHub cannot limit an installation token to one branch, so the only server-side
  bound is protection on the default branch. The user ruled (2026-11-01) that a FIX token is minted only when the
  default branch is protected.
- **SSR session (D/BUG-1).** The access cookie lives 15 minutes and the refresh cookie 7 days. On a full page load the
  middleware calls `/api/auth/me`, which returns `{ user: null }` when the access cookie is missing and never tries
  the refresh cookie. So every reload more than 15 minutes after the last refresh lands on /login. This was the only
  HIGH finding of the 2026-10-18 review, and it is still open.

## Design

### Calls made in this spec

1. **Self path = shutdown only.** In `updateProjectAgent`, when the principal is an agent whose slug equals
   `agentSlug`, the body is parsed with `parseBody(UpdateAgentDto, ...)`. A body that fails validation (for example
   `status: 'GONE'` or `maxConcurrentTickets: 0`) keeps the existing 400 from `parseBody`. `parseBody` strips unknown
   keys (`whitelist: true`), so `{ status: 'OFFLINE', junk: 1 }` parses to a clean shutdown. Only keys whose value
   is not `undefined` count (`parseBody` returns `instanceToPlain` output, which may carry declared fields as
   `undefined`). If the parsed patch has exactly one defined key, `status`, with value `PAUSED` or `OFFLINE`, then
   `{ status }` is applied through `agentsService.update` with no
   permission check and no approval, as today. Any other parsed patch on the self path (another status, any other
   DTO field, or an empty body) throws `ForbiddenAppException({}, 'projectAgents')`, the existing i18n key, and
   changes nothing. The self path
   never falls through to the gated path: the redesign's rule is that a principal does not hold `agent.update` over
   itself.
2. **`maxConcurrentTickets` validation.** `UpdateAgentDto.maxConcurrentTickets` changes from `@IsNumber()` to
   `@IsInt() @Min(1)`. This is the shared DTO, so the global `PATCH /api/agents/:slug` route gets the same rule.
3. **Role-granting keys are critical.** `classifyRisk` in `permissions/catalog.ts` returns `'critical'` for the keys in
   a new exported set `ROLE_GRANT_KEYS = new Set(['member.add', 'invite.create', 'invite.resend'])`. It checks this
   set first, beside the existing `role.` and `approval.policy.` prefix rule. The existing `buildEntry` formula then
   gives these keys `approval.floor: 'human'` and `approval.default: 'human'` with no other change. Effects:
   - Existing approval policies below the floor are clamped up by the resolver, which already happens for every key.
   - A human acting directly satisfies a `human` requirement (design: "a human acting directly satisfies any mode"),
     so the web and owner flows are unchanged.
   - An agent caller gets `202` with a pending request. After a human approves, the agent redeems the result through
     the existing redeem flow (`@ApprovalGated({ redeem: true })`). The raw link is shown once to the requester, whose
     action a human has now approved.
4. **Placement trust domain.** "Raw agent job" means a job with `bashMode === 'raw'` whose command is not a config
   kind (`isConfigKind`). A config job runs no agent. The rule:
   - `RunnerLoad` gains two sets: `projectIds`, the projects of all held jobs including threads, and `rawProjectIds`,
     the projects of held raw agent jobs. `EMPTY_LOAD` gets both, empty.
   - `PlacementJob` gains `projectId`. `toPlacementJob(job, repo, thread?)` takes it from the repo argument, whose type
     becomes `Pick<FleetRepoRef, 'provider' | 'projectId'>`. The dispatch-time callers (`fleet-jobs.service.ts:100`,
     `schedules.service.ts:218`) pass a normalized input with no `projectId` but a full `FleetRepoRef`, and the
     dashboard passes a `DashboardJobRow` that carries both, so no caller changes.
   - `firstMisfit` returns the new `MisfitReason` `'trust_domain'` in two cases:
     - (a) the job is a raw agent job and `load.projectIds` holds a project other than `job.projectId`;
     - (b) `load.rawProjectIds` holds a project other than `job.projectId`, whatever the job's kind (config jobs
       included).
   - The check runs after every permanent or capability misfit, so it can never hide one:
     - on the non-thread path, after `capabilityMisfit` and before `busy_repo`;
     - on the thread path, just before `thread_capacity`.
   - `'trust_domain'` is not in `PERMANENT_MISFITS`: it clears when the other project's job ends, so a pinned dispatch
     queues and does not get a 422.
   - Same-project jobs never misfit on it.
5. **Load plumbing.** `ActiveJobRef` gains `projectId: string` and `bashMode: string`.
   - `PrismaFleetJobRepository.findActiveLoads` and `PrismaDashboardRepository.findHeldRefs` select both fields.
   - `toLoads` folds them into the two sets through a new exported pure helper,
     `addJobToLoad(load, ref): RunnerLoad`.
   - `PlacementService.fillRunner` and `fillRunnerThreads` call `addJobToLoad` after each assignment inside their
     loops, so the sets also hold the jobs placed earlier in the same pass.
   - `fillRunnerThreads` today builds `currentLoad` from a load that never changes. It now carries the updated sets
     forward.
6. **Misfit enums.** `'trust_domain'` joins `MISFIT_REASONS` (`dashboard/dashboard.types.ts`) and the
   `PlacementMisfitDto` enum (`jobs/dto/fleet-job.dto.ts`). The dashboard's `WAITING_REASONS` gains `'trust_domain'`,
   so a job held only by it reads as waiting, like `capacity`. `openapi.json` is regenerated. The web adds the label.
7. **REVIEW token.** `GitHubAppClient.mintReviewToken(installationId, repoName)` mints with
   `{ contents: 'read', pull_requests: 'write', metadata: 'read', checks: 'read', statuses: 'read', actions: 'read' }`.
   - `pull_requests: write` covers review comments and PR conversation comments.
   - The broker request type gains `purpose?: 'review' | 'fix'`.
   - `purpose: 'review'` mints through `mintReviewToken` and caches under its own key,
     `${jobId}:${leaseEpoch}:review`.
   - A `purpose` on a GitLab repo throws `RepoCheckException('provider_error')` and never falls back to the
     write-capable stored GitLab token. This matches the existing read-only precedent; dispatch already refuses
     REVIEW and FIX for non-GitHub repos (`fleet-jobs.service.ts:82`), so this path is defensive.
8. **FIX branch guard.** For `purpose: 'fix'` the broker first mints a read-only token (`mintReadOnlyToken`), then
   calls `GitHubAppClient.isBranchProtected(token, owner, name, repo.defaultBranch)`.
   - When that returns `false`, the mint fails with the new `RepoCheckReason` `'default_branch_unprotected'` and no
     write token is minted.
   - When it returns `true`, the existing write token is minted through `mintInstallationToken` and cached under the
     existing write key.
   - A reused cached FIX token does not re-run the check, which runs once per job epoch per fresh mint.
   - `isBranchProtected` returns `true` when either:
     - `GET /repos/{owner}/{name}/rules/branches/{branch}` answers 200 with an array holding a rule whose `type` is
       `pull_request` or `update`;
     - or `GET /repos/{owner}/{name}/branches/{branch}` answers 200 with `protected: true`.
   - The branch name is passed through `encodeURIComponent` in both paths, and the rules call asks for
     `?per_page=100`; only that first page is read.
   - It returns `false` when both answer 200 and neither condition holds. Any other status, or a network error, throws
     `RepoCheckException('provider_error')`.
   - This is a best-effort guard. Bypass actors on a ruleset, and classic protection whose only settings do not block
     a push (for example only "block force pushes"), are not detectable with the read-only token, which lacks the
     Administration permission. The guard catches the common case, a default branch with no protection at all.
9. **Purpose wiring.** `SyncService.grantTokens` passes `purpose: 'review'` for a REVIEW job and `purpose: 'fix'` for
   a FIX job on the default (repo-less) token branch. The key is added by a conditional spread, so RUN, PLAN, CONFIG
   and THREAD requests keep exactly today's shape (no `purpose` key).
10. **SSR refresh middleware.** A new Nitro server middleware, `apps/web/server/middleware/session-refresh.ts`, runs on
    each request and only acts when all of these hold:
    - the method is `GET`;
    - the path does not start with `/api/`, `/_nuxt/` or `/__nuxt`;
    - the request's `accept` header includes `text/html` (a page load, not an asset or favicon fetch);
    - the `koda_token` cookie is absent;
    - the `koda_refresh` cookie is present.

    It then calls `forwardToApi(event, '/auth/refresh', { method: 'POST', cookieName: 'refresh' })`, all inside one
    `try/catch`:
    - **On a 2xx whose envelope unwraps:** it reads the tokens with `unwrapAuth` and sets both cookies on the response
      with `setAuthCookies`. It also rewrites the request's `cookie` header (`event.node.req.headers.cookie`): the
      `koda_token` and `koda_refresh` values are replaced (added when absent), every other cookie is kept unchanged,
      and no cookie name appears twice. SSR `useRequestFetch` calls later in the same render forward that header, so
      they see the new session.
    - **On a 401 or 403, or a 2xx whose envelope has `ret !== 0` (`unwrapAuth` throws):** it calls
      `clearAuthCookies(event)` and returns. The page then renders logged out, as today.
    - **On any other status (for example 429 or 5xx), or a thrown network error:** it leaves the cookies untouched and
      returns, so a throttled or failing API never logs the user out.

    The middleware never throws. Nitro runs `server/middleware` files in name order, so `client-ip.ts` has already set
    `event.context.clientIp`, which `forwardToApi` reads. `me.get.ts` and `auth.global.ts` are unchanged.

    Two pure helpers in a new `apps/web/server/utils/session-refresh.ts` carry the decision and the header rewrite,
    and the middleware calls both:
    - `shouldRefreshSession(event): boolean` returns `true` exactly when all five activation conditions above hold.
    - `withAuthCookies(cookieHeader: string | undefined, tokens: { accessToken: string; refreshToken: string }): string`
      returns the rewritten `cookie` header value.

### Integration

Read-only symbols this feature calls (verified at `61052931`):

- `parseBody(UpdateAgentDto, body)` — the existing parse helper `ProjectsController` already uses on the gated path.
- `isAgentPrincipal(principal)`, `ForbiddenAppException({}, 'projectAgents')` — `projects/projects.controller.ts`.
- `ApprovalRouteGate.run` / `@ApprovalGated({ redeem: true })` — `projects/invites/project-invites.controller.ts:52,67,74`;
  `projects/members/project-members.controller.ts:62,74`.
- `isConfigKind(command)` — `fleet/common/config-jobs.ts`; `isThreadKind(command)` — `fleet/common/thread-jobs.ts`.
- `GitHubAppClient.mintReadOnlyToken(installationId, repoName)`, `mintInstallationToken(...)`, private `mintScopedToken(installationId, repoName, permissions)`, private `headers(bearer)`, `repoPath(owner, name)` — `fleet/git-broker/github-app-client.ts`.
- `RepoCheckException(reason)` — `fleet/git-broker/repo-check.exception.ts`.
- `FleetRepoRef.defaultBranch` — `fleet/jobs/domain/fleet-job.domain.ts:222`.
- Web: `forwardToApi(event, path, { method, cookieName })`, `setAuthCookies`, `clearAuthCookies`, `unwrapAuth`,
  `ACCESS_COOKIE = 'koda_token'`, `REFRESH_COOKIE = 'koda_refresh'` — `apps/web/server/utils/api.ts`.

Symbols this feature changes. Each baseline exists only to locate the code. It is never the interface to implement;
implement the target.

- `ProjectsController.updateProjectAgent` self branch (`projects/projects.controller.ts:261-264`).
  Baseline: `if (isAgentPrincipal(principal) && principal.slug === agentSlug) return JsonResponse.Ok(await this.agentsService.update(agentSlug, updateDto));`
  Target: parse, accept only `{ status: 'PAUSED' | 'OFFLINE' }`, else `ForbiddenAppException({}, 'projectAgents')`.
- `UpdateAgentDto.maxConcurrentTickets` (`agents/dto/update-agent.dto.ts`). Baseline: `@IsNumber()`. Target: `@IsInt() @Min(1)`.
- `classifyRisk(key)` (`permissions/catalog.ts:406`). Target: returns `'critical'` for every key in the exported `ROLE_GRANT_KEYS`.
- `MisfitReason` (`fleet/jobs/placement-rules.ts:10`). Target: the union includes `'trust_domain'`.
- `PlacementJob`. Target: gains `projectId: string`. `toPlacementJob(job, repo: Pick<FleetRepoRef, 'provider' | 'projectId'>, thread?)` sets `projectId` from `repo.projectId`.
- `RunnerLoad`. Target: `{ active: number; repoIds: ReadonlySet<string>; projectIds: ReadonlySet<string>; rawProjectIds: ReadonlySet<string>; threads?: number }`.
- `ActiveJobRef` (`fleet/jobs/domain/fleet-job.domain.ts:226`). Target: `{ runnerId: string; repoId: string; command?: string; projectId: string; bashMode: string }`.
- `toLoads(refs)`. Target: takes `ActiveJobRef`-shaped refs and returns loads with both new sets filled through `addJobToLoad`.
- `GitTokenBroker.mint(req, now)` (`fleet/git-broker/git-token.broker.ts:36`). Target: `req` is `{ jobId; leaseEpoch; repo; readOnly?: boolean; purpose?: 'review' | 'fix' }`.
- `RepoCheckReason`. Target: the union includes `'default_branch_unprotected'`.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| Self path body fails `UpdateAgentDto` validation | Existing 400 from `parseBody`; agent row unchanged. |
| Self path parsed patch is not exactly `{ status: PAUSED or OFFLINE }` | 403 `ForbiddenAppException({}, 'projectAgents')`; agent row unchanged. |
| Agent calls `member.add` / `invite.create` / `invite.resend` with no stricter policy | 202 pending approval; nothing is written until a human approves. |
| Every runner misfits only on `trust_domain` | The job stays QUEUED; the dashboard verdict is `waiting_capacity`. |
| FIX mint, default branch unprotected | Token error `default_branch_unprotected`; no write token. The runner's credential request fails, so the FIX step cannot start; its token cache retries after its cooldown. |
| FIX mint, the protection check gets a non-200 or network error | Token error `provider_error` (fail closed); no write token. |
| REVIEW or FIX mint on a GitLab repo | Token error `provider_error`; the stored GitLab token is never used. |
| REVIEW mint, GitHub refuses (403/422) | Existing mapping: `app_permissions_insufficient`. |
| SSR refresh: upstream 401/403, or `ret !== 0` | Both auth cookies cleared; the page renders logged out. |
| SSR refresh: other status (429, 5xx) or network error | Cookies untouched; the request continues. |

## Out of Scope

- The per-job credential-socket nonce from Ruling 5: dropped by user ruling 2026-11-01, because the FIX/REVIEW token also sits in a same-user-readable file; placement isolation is the control.
- Isolating two jobs of the same project on one runner from each other: Ruling 5 treats one project on one runner as one trust domain.
- Running raw jobs as a per-job OS user or in a VM: Ruling 5's long-term option, not built here.
- A dispatch-time check that a FIX repo's default branch is protected: the guard runs at token mint; dispatch accepts the job and the job fails with `default_branch_unprotected`.
- Limiting a FIX push to the PR head branch in the runner (git shim or refspec allowlist): GitHub cannot scope the token, and the user chose the branch-protection guard.
- Re-running the branch-protection check on a cached FIX token reused within one job epoch.
- Detecting ruleset bypass actors or classic protection that does not block a push: the read-only token cannot read either, so the FIX branch guard is best-effort and catches only an unprotected default branch.
- Reading more than the first 100 rules from the branch-rules endpoint.
- The server-side review-attribution mint (`GitHubAppClient` attribution path calling `GitTokenBroker.mint` without `purpose`): it never leaves the API, so it keeps the write token.
- Forge-token lifetime for long FIX runs (review D/BUG-2): a separate fix.
- Runner git hook and config hardening (review D/SEC-2): a separate fix.
- Refusing a repo-less write token to PROJECT-thread jobs (review B/SEC-2): a separate fix.
- Making refresh tokens one-time or rotating them with reuse detection (review A/SEC-8): concurrent SSR refreshes stay valid because refresh tokens are reusable today.
- Refreshing an access cookie that is present but holds an expired JWT: the cookie's 15-minute lifetime matches the access token, so the missing-cookie case is the one that occurs.
- An upper bound on `maxConcurrentTickets`: only integer and at-least-1 validation is added.
- Blocking PAUSED agents at the auth guard (review ruling 10): PAUSED agents still authenticate; only the self path is closed.
- Other risk tiers the review flagged (`agent.key.rotate`, `agent.create`, `user.create`, CI token rotation, review A/SEC-6): a separate fix.
- Logout revocation, return-to after login, and treating an API outage as a reconnect (review E/SEC-1, E/BUG-2, E/BUG-3): a separate web session fix.
- CLI wording of the new `trust_domain` misfit: the CLI prints the API's reason code as it is.

## Stories

This bundle has 9 stories. It is a bundle of independent P0 fixes, not one capability. The user explicitly chose a
single bundle spec on 2026-11-01, over splitting it into per-package features.

### US-001: Agent self-update is shutdown-only

No dependencies. Workdir: apps/api. Calls 1 and 2: the self branch of `ProjectsController.updateProjectAgent` accepts
only `{ status: 'PAUSED' }` or `{ status: 'OFFLINE' }`, keeps the 400 for a body that fails validation, and refuses
any other parsed patch with 403. `UpdateAgentDto` validates `maxConcurrentTickets` as an integer of at least 1.

### US-002: Role-granting keys carry the human approval floor

No dependencies. Workdir: apps/api. Call 3: `ROLE_GRANT_KEYS` (`member.add`, `invite.create`, `invite.resend`) are
classified `critical`, so an agent's member add, invite or resend waits for a human approval, and a human acting
directly is unaffected.

### US-003: Trust-domain placement rule (pure)

No dependencies. Workdir: apps/api. Call 4 and the pure half of call 5: the `trust_domain` misfit in `firstMisfit` and
its ordering, `PlacementJob.projectId` through `toPlacementJob`, the new `RunnerLoad` sets, `EMPTY_LOAD`,
`addJobToLoad`, `toLoads`, and the `ActiveJobRef` shape.

### US-004: Trust-domain placement plumbing

Depends on US-003. Workdir: apps/api. The rest of calls 5 and 6:
- the repository selects in `findActiveLoads` and `findHeldRefs`;
- the in-loop load updates in `fillRunner` and `fillRunnerThreads`;
- the misfit enums and the dashboard waiting verdict;
- the regenerated `openapi.json` and CLI types.

### US-005: GitHub client review token and branch-protection check

No dependencies. Workdir: apps/api. Calls 7 and 8, client side: `GitHubAppClient.mintReviewToken` and
`GitHubAppClient.isBranchProtected`, plus the new `RepoCheckReason`.

### US-006: Token broker mints by job purpose

Depends on US-005. Workdir: apps/api. Calls 7 and 8, broker side: `purpose` on `GitTokenBroker.mint`, the review
cache key, the FIX branch guard with the `default_branch_unprotected` reason, and the GitLab refusal.

### US-007: Sync passes the job purpose to the broker

Depends on US-006. Workdir: apps/api. Call 9: `SyncService.grantTokens` adds `purpose: 'review'` for REVIEW and
`purpose: 'fix'` for FIX on the repo-less branch, by conditional spread.

### US-008: Web session-refresh helpers and the trust_domain label

Depends on US-003. Workdir: apps/web. Call 10's pure helpers, `shouldRefreshSession` and `withAuthCookies`, in
`server/utils/session-refresh.ts`. Also call 6 on the web side: the `trust_domain` misfit type and its
`fleet.misfit.trust_domain` label in both locales.

### US-009: Web SSR session refresh middleware

Depends on US-008. Workdir: apps/web. Call 10: the `session-refresh` server middleware. It covers the upstream
refresh, the response cookies, the request cookie-header rewrite through `withAuthCookies`, the failure paths (clear
on 401/403 or `ret !== 0`, keep on 429/5xx/network) and the Playwright reload check.

### Context Files

**US-001**

- `apps/api/src/projects/projects.controller.ts` — the self branch at lines 262-264 and the gated path below it.
- `apps/api/src/projects/projects.controller.spec.ts` — AC-8/AC-9 show how the controller is driven with agent principals.
- `apps/api/src/agents/dto/update-agent.dto.ts` — the DTO being tightened.
- `apps/api/src/approvals/route/parse-body.ts` — `parseBody` (whitelist, `instanceToPlain`, the 400 it throws).

**US-002**

- `apps/api/src/permissions/catalog.ts` — `classifyRisk`, `buildEntry`, `PERMISSION_CATALOG`.
- `apps/api/src/permissions/catalog.spec.ts` — `expectedRisk()` and the floor/default formula test.
- `apps/api/test/integration/projects/gated-invite-secret-routes.integration.spec.ts` — the agent invite and resend flows, with the helpers `createAsAgent`, `decidePending`, `approve` and `seedWaitPolicy`.
- `apps/api/src/projects/invites/project-invites.controller.ts` — `@ApprovalGated({ redeem: true })` on create and resend.
- `apps/api/src/projects/members/project-members.controller.ts` — the gated `member.add` route.

**US-003**

- `apps/api/src/fleet/jobs/placement-rules.ts` — `firstMisfit`, `capabilityMisfit`, `RunnerLoad`, `EMPTY_LOAD`, `toLoads`, `toPlacementJob`, `PERMANENT_MISFITS`.
- `apps/api/src/fleet/jobs/placement-rules.spec.ts` — the existing fixtures for runners, loads and jobs.
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `ActiveJobRef`, `FleetRepoRef`.
- `apps/api/src/fleet/common/config-jobs.ts` — `isConfigKind`.

**US-004**

- `apps/api/src/fleet/jobs/placement.service.ts` — `placeJob`, `fillRunner` and `fillRunnerThreads`.
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findActiveLoads`.
- `apps/api/src/fleet/dashboard/attention-unplaceable.ts` — `WAITING_REASONS` and `classify`.
- `apps/api/src/fleet/dashboard/prisma-dashboard.repository.ts` — `findHeldRefs`.
- `apps/api/src/fleet/sync/sync.service.ts` — where `sync` calls `fillRunner` (line ~78).

**US-005**

- `apps/api/src/fleet/git-broker/github-app-client.ts` — `mintScopedToken`, `getRepoRole`, `listOpenPullRequests` (the GET-with-token and `per_page` patterns to mirror).
- `apps/api/src/fleet/git-broker/github-app-client.spec.ts` — how the HTTP client is stubbed.
- `apps/api/src/fleet/git-broker/repo-check.exception.ts` — `RepoCheckReason`.

**US-006**

- `apps/api/src/fleet/git-broker/git-token.broker.ts` — `mint`, `fresh`, the cache key.
- `apps/api/src/fleet/git-broker/git-token.broker.spec.ts` — how the broker is driven with stub clients.
- `apps/api/src/fleet/git-broker/github-app-client.ts` — `mintReviewToken` and `isBranchProtected` — created by US-005, called here.

**US-007**

- `apps/api/src/fleet/sync/sync.service.ts` — `sync` and `grantTokens` (lines 108-148).
- `apps/api/src/fleet/sync/sync-token-fence.spec.ts` — the existing harness that constructs `SyncService` with stubs and pins the mint request shape.
- `apps/api/src/fleet/git-broker/git-token.broker.ts` — the `purpose` field — added by US-006, passed here.

**US-008**

- `apps/web/server/utils/api.ts` — `ACCESS_COOKIE`, `REFRESH_COOKIE` (cookie names the helpers use).
- `apps/web/server/utils/client-ip.ts` — a sibling pure server util and its test style.
- `apps/web/tests/server/client-ip.spec.ts` — how a pure server util is tested.
- `apps/web/tests/i18n/fleet-locale-parity.spec.ts` — the `fleet.misfit` pin list.

**US-009**

- `apps/web/server/utils/session-refresh.ts` — `shouldRefreshSession` and `withAuthCookies` — created by US-008, called here.
- `apps/web/server/utils/api.ts` — `forwardToApi`, `setAuthCookies`, `clearAuthCookies`, `unwrapAuth`.
- `apps/web/server/api/auth/refresh.post.ts` — the existing refresh call this middleware mirrors.
- `apps/web/server/middleware/client-ip.ts` — the sibling middleware (order and shape).
- `apps/web/tests/e2e/auth.spec.ts` — the existing sign-in helpers and fixtures for Playwright.

### Creates

**US-001**

- `apps/api/src/projects/projects.controller.self-update.spec.ts`
- `apps/api/test/integration/projects/agent-self-update.integration.spec.ts`

**US-002**

- `apps/api/test/integration/permissions/role-grant-human-floor.integration.spec.ts`

**US-003**

- `apps/api/src/fleet/jobs/placement-rules.trust-domain.spec.ts`

**US-004**

- `apps/api/test/integration/fleet/placement-trust-domain.integration.spec.ts`

**US-005**

- `apps/api/src/fleet/git-broker/github-app-client.branch-protection.spec.ts`

**US-006**

- `apps/api/src/fleet/git-broker/git-token.broker.purpose.spec.ts`

**US-007**

- `apps/api/src/fleet/sync/sync.service.token-purpose.spec.ts`

**US-008**

- `apps/web/server/utils/session-refresh.ts`
- `apps/web/tests/server/session-refresh-utils.spec.ts`

**US-009**

- `apps/web/server/middleware/session-refresh.ts`
- `apps/web/tests/server/session-refresh.spec.ts`
- `apps/web/tests/e2e/session-refresh.e2e.spec.ts`

### Modifies

**US-001**

- `apps/api/src/projects/projects.controller.ts` — the self branch of `updateProjectAgent` parses the body and accepts only a patch whose single defined key is `status` with `PAUSED` or `OFFLINE`, else throws `ForbiddenAppException({}, 'projectAgents')`; a body failing validation keeps the 400.
- `apps/api/src/agents/dto/update-agent.dto.ts` — `maxConcurrentTickets` becomes `@IsInt() @Min(1)` instead of `@IsNumber()`.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — add one case beside the existing project-agent PATCH tests: the agent's own API key sending `{ "status": "ACTIVE" }` for itself gets 403 (rule: endpoint changes are reflected here). Existing cases stay.

**US-002**

- `apps/api/src/permissions/catalog.ts` — adds the exported `ROLE_GRANT_KEYS` set and makes `classifyRisk` return `'critical'` for its keys.
- `apps/api/src/permissions/catalog.spec.ts` — the independent oracle helper `expectedRisk()` (lines ~167-174) must return `'critical'` for the keys of `ROLE_GRANT_KEYS` (import the set or inline the three literals), so the "derives access, scope, ownable, risk, principals and approval for every catalog key" test keeps passing; the generic floor/default formula stays.
- `apps/api/test/integration/permissions/core-members-invites.integration.spec.ts` — test "B4: an agent with a project-admin binding invites an unknown address with 201, and is named as the inviter" becomes: the agent's invite answers 202 with `permissionKey` `'invite.create'`; after the root user approves the request, the agent's redeem (`X-Koda-Approval-Request`) answers 201 and the invite row and `inviterName` assertions hold as before.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — add one case: an agent holding `project-admin` posting a project invite gets 202 (rule: endpoint changes are reflected here). Existing cases stay.
- `apps/api/test/integration/projects/gated-invite-secret-routes.integration.spec.ts` — the test titled "AC-8/12: default-none create and resend execute immediately without approval rows" (an agent's create and resend under the default policy run at once with `201`/`200` and no approval rows) becomes: under the default policy an agent's create and resend answer `202` and create one approval request each; the root user's direct create still answers `201`. Every other test in the file stays, because its approvals are decided by the root user.

**US-003**

- `apps/api/src/fleet/jobs/placement-rules.ts` — `MisfitReason` gains `'trust_domain'`; `PlacementJob` gains `projectId`; `toPlacementJob`'s repo parameter becomes `Pick<FleetRepoRef, 'provider' | 'projectId'>`; `RunnerLoad` and `EMPTY_LOAD` gain `projectIds` and `rawProjectIds`; adds the exported `addJobToLoad`; `toLoads` uses it; `firstMisfit` applies the trust-domain rule after `capabilityMisfit` (before `busy_repo`) and, on the thread path, before `thread_capacity`.
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `ActiveJobRef` gains `projectId` and `bashMode`.
- `apps/api/src/fleet/jobs/placement-rules.spec.ts` — every hand-built `RunnerLoad` literal gains `projectIds` and `rawProjectIds`; every `toLoads` input ref (lines ~215 and ~296) gains `projectId` and `bashMode`, and every `toLoads` expectation gains the two sets; every `PlacementJob` literal gains `projectId`; the `toPlacementJob` calls at lines ~196 and ~302-303 that pass a bare `{ provider }` repo pass `{ provider, projectId }`, and the "copies the placement fields" expectation gains that `projectId`. Existing misfit expectations stay.
- `apps/api/src/fleet/dashboard/attention-unplaceable.spec.ts` — every hand-built `RunnerLoad` gains empty `projectIds` and `rawProjectIds` so it type-checks; existing verdicts stay.
- `apps/api/src/fleet/dashboard/attention-rules.spec.ts` — the hand-built load at line ~22 (`{ active: 1, repoIds: ... }`) gains empty `projectIds` and `rawProjectIds` so it type-checks; its verdicts stay.
- `apps/api/test/unit/fleet/thread-placement.spec.ts` — every hand-built `RunnerLoad` or `PlacementJob` literal gains the new fields; existing verdicts stay.

**US-004**

- `apps/api/src/fleet/jobs/placement.service.ts` — `fillRunner` and `fillRunnerThreads` update their load with `addJobToLoad` after each assignment.
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findActiveLoads` selects and returns `projectId` and `bashMode`.
- `apps/api/src/fleet/dashboard/prisma-dashboard.repository.ts` — `findHeldRefs` selects and returns `projectId` and `bashMode`.
- `apps/api/src/fleet/dashboard/domain/dashboard.domain.ts` — the `findHeldRefs` return type gains `projectId` and `bashMode`.
- `apps/api/src/fleet/dashboard/attention-unplaceable.ts` — `WAITING_REASONS` gains `'trust_domain'`.
- `apps/api/src/fleet/dashboard/dashboard.types.ts` — `MISFIT_REASONS` gains `'trust_domain'`.
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` — the `PlacementMisfitDto` reason enum gains `'trust_domain'`.
- `apps/api/test/integration/fleet/fleet-dashboard-repository.integration.spec.ts` — the `findHeldRefs` expectations at lines ~86 (`toEqual([{ runnerId, repoId, command: 'RUN' }])`) and ~129 (`toContainEqual({ ..., command: 'THREAD' })`) gain the held job's `projectId` and `bashMode`; nothing else changes.
- `openapi.json` — regenerated: every misfit enum derived from `MISFIT_REASONS` and `PlacementMisfitDto` gains `trust_domain`.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate` from the new API spec (the misfit enums gain `trust_domain`); never hand-edited.

**US-005**

- `apps/api/src/fleet/git-broker/github-app-client.ts` — adds `mintReviewToken` and `isBranchProtected`.
- `apps/api/src/fleet/git-broker/repo-check.exception.ts` — `RepoCheckReason` gains `'default_branch_unprotected'`.

**US-006**

- `apps/api/src/fleet/git-broker/git-token.broker.ts` — `mint` takes `purpose`; review mints use `mintReviewToken` under key `${jobId}:${leaseEpoch}:review`; fix mints run the branch guard before `mintInstallationToken`; any `purpose` on a GitLab repo throws `RepoCheckException('provider_error')` before `gitlab.resolve`.
- `apps/api/src/fleet/git-broker/git-token.broker.spec.ts` — any stub GitHub client object gains `mintReviewToken`, `isBranchProtected` and `mintReadOnlyToken` members so the broker type-checks against the stub. Existing assertions stay.

**US-007**

- `apps/api/src/fleet/sync/sync.service.ts` — `grantTokens` adds `purpose: 'review'` for REVIEW and `purpose: 'fix'` for FIX on the repo-less branch by conditional spread; other request shapes are unchanged.

**US-008**

- `apps/web/lib/fleet-types.ts` — the misfit reason union gains `'trust_domain'`.
- `apps/web/i18n/locales/en.json` — `fleet.misfit.trust_domain`: "Runner holds another project's job (isolation)".
- `apps/web/i18n/locales/zh.json` — `fleet.misfit.trust_domain`: "执行机正在运行其他项目的任务（隔离）".
- `apps/web/tests/i18n/fleet-locale-parity.spec.ts` — the `'fleet.misfit'` pin list gains `'trust_domain'`; every other pin stays.

### Seams

- `addJobToLoad`, the `RunnerLoad` sets and the `trust_domain` rule (US-003) are consumed by `PlacementService` (US-004). The US-004 integration ACs enter through `POST /api/fleet/jobs` dispatch and `POST /api/fleet/runner/sync`, and assert on the job row's state and runner.
- `mintReviewToken` and `isBranchProtected` (US-005) are consumed by `GitTokenBroker.mint` (US-006), whose ACs stub the client and assert which method was called with which arguments.
- `purpose` (US-006) is consumed by `SyncService.grantTokens` (US-007). The US-007 seam ACs enter through `SyncService.sync`, the handler behind `POST /api/fleet/runner/sync` (the controller is a pass-through), with a stub `GitHubAppClient` behind the real broker, and assert which client method was called.
- `shouldRefreshSession` and `withAuthCookies` (US-008) are consumed by the `session-refresh` middleware (US-009). Its unit seam ACs drive the middleware handler with stubbed helpers; its Playwright AC enters through a full page reload of `/projects`, which reaches the middleware through Nitro's `server/middleware` convention.
- `'trust_domain'` (US-003, API enum) is consumed by the web misfit label (US-008), whose AC asserts that the locale value resolves for the new code.

## Acceptance Criteria

### US-001: Agent self-update is shutdown-only

- `[unit]` `updateProjectAgent('alpha', 'agent-a', { status: 'OFFLINE' }, <agent principal with slug 'agent-a'>, ctx)` calls `agentsService.update` once with `('agent-a', { status: 'OFFLINE' })` and never calls `routeGate.run`.
- `[unit]` `updateProjectAgent` with a self agent principal and body `{ status: 'PAUSED' }` calls `agentsService.update` once with `('agent-a', { status: 'PAUSED' })`.
- `[unit]` `updateProjectAgent` with a self agent principal and body `{ status: 'OFFLINE', junk: 1 }` calls `agentsService.update` once with `('agent-a', { status: 'OFFLINE' })`.
- `[unit]` table-driven: `updateProjectAgent` with a self agent principal and each body of `{ status: 'ACTIVE' }`, `{ status: 'OFFLINE', maxConcurrentTickets: 5 }`, `{ name: 'Owner' }` and `{}` throws `ForbiddenAppException` without calling `agentsService.update`.
- `[unit]` `updateProjectAgent` with a self agent principal and body `{ status: 'GONE' }` throws the 400 validation exception that `parseBody` raises, and does not call `agentsService.update`.
- `[integration]` an agent whose status is `PAUSED` sending `PATCH /api/projects/:slug/agents/<its own slug>` with its API key and body `{ "status": "ACTIVE" }` gets HTTP 403, and the agent row's `status` is still `PAUSED` afterwards.
- `[unit]` validating `UpdateAgentDto` with `{ maxConcurrentTickets: 1.5 }` yields a validation error on `maxConcurrentTickets`.
- `[unit]` validating `UpdateAgentDto` with `{ maxConcurrentTickets: 0 }` yields a validation error on `maxConcurrentTickets`.
- `[unit]` validating `UpdateAgentDto` with `{ maxConcurrentTickets: 3 }` yields no validation errors.

### US-002: Role-granting keys carry the human approval floor

- `[unit]` `ROLE_GRANT_KEYS` is importable from `permissions/catalog` and equals the set `{ 'member.add', 'invite.create', 'invite.resend' }`.
- `[unit]` for each key in `ROLE_GRANT_KEYS`, its `PERMISSION_CATALOG` entry has `risk` `'critical'`.
- `[unit]` for each key in `ROLE_GRANT_KEYS`, its `PERMISSION_CATALOG` entry has `approval.floor` `'human'`.
- `[integration]` an agent holding `project-admin` in a project with no approval policy rows sends `POST /api/projects/:slug/invites` for a new address with role `project-admin`; it gets HTTP 202 with `permissionKey` `'invite.create'`, and no `ProjectInvite` row exists for that address.
- `[integration]` the same agent sends `POST /api/projects/:slug/members` for an existing non-member user; it gets HTTP 202 with `permissionKey` `'member.add'`, and the user holds no role binding in that project.
- `[integration]` the same agent sends `POST /api/projects/:slug/invites/:id/resend` for a pending invite the root user created; it gets HTTP 202 with `permissionKey` `'invite.resend'`.
- `[integration]` the root user (Owner, JWT) sends `POST /api/projects/:slug/invites` for a new address; it gets HTTP 201 and no `ApprovalRequest` row is created.

### US-003: Trust-domain placement rule (pure)

- `[unit]` `firstMisfit` for a `RUN` job with `bashMode` `'raw'` and `projectId` `'p1'`, on an otherwise-fitting runner whose load has `projectIds` `{'p2'}` and `rawProjectIds` `{}`, returns `'trust_domain'`.
- `[unit]` `firstMisfit` for a `RUN` job with a non-raw `bashMode` and `projectId` `'p1'`, on an otherwise-fitting runner whose load has `rawProjectIds` `{'p2'}`, returns `'trust_domain'`.
- `[unit]` `firstMisfit` for a `RUN` job with a non-raw `bashMode` and `projectId` `'p1'`, on an otherwise-fitting runner whose load has `projectIds` `{'p2'}` and `rawProjectIds` `{}`, returns `null`.
- `[unit]` `firstMisfit` for a raw `REVIEW` job with `projectId` `'p1'`, on an otherwise-fitting runner whose load has `projectIds` `{'p1'}` and `rawProjectIds` `{'p1'}`, returns `null`.
- `[unit]` `firstMisfit` for a config-kind job with `bashMode` `'raw'` and `projectId` `'p1'`, on an otherwise-fitting runner whose load has `projectIds` `{'p2'}` and `rawProjectIds` `{}`, returns `null`.
- `[unit]` `firstMisfit` for a config-kind job with `bashMode` `'raw'` and `projectId` `'p1'`, on an otherwise-fitting runner whose load has `rawProjectIds` `{'p2'}`, returns `'trust_domain'`.
- `[unit]` `firstMisfit` for a raw `RUN` job with `projectId` `'p1'`, on a runner that lacks the `gh` tool and whose load has `projectIds` `{'p2'}` and `rawProjectIds` `{'p2'}`, returns `'tools'`.
- `[unit]` `firstMisfit` for a PROJECT `THREAD` job with `bashMode` `'raw'` and `projectId` `'p1'`, on an otherwise-fitting thread runner whose load has `projectIds` `{'p2'}`, returns `'trust_domain'`.
- `[unit]` `toPlacementJob({ command: 'RUN', repoId: 'x', profiles: [], selectorLabels: [], pinnedRunnerId: null, bashMode: 'raw' }, { provider: 'github', projectId: 'p1' }).projectId` is `'p1'`.
- `[unit]` `PERMANENT_MISFITS.has('trust_domain')` is `false`.
- `[unit]` `addJobToLoad(EMPTY_LOAD, { runnerId: 'r1', repoId: 'repo1', command: 'RUN', projectId: 'p1', bashMode: 'raw' }).rawProjectIds` equals the set `{'p1'}`.
- `[unit]` `addJobToLoad(EMPTY_LOAD, { runnerId: 'r1', repoId: 'repo1', command: 'CONFIG', projectId: 'p1', bashMode: 'raw' })` returns a load with `projectIds` `{'p1'}` and `rawProjectIds` empty.

### US-004: Trust-domain placement plumbing

- `[unit]` `jobUnplaceableItems` for a queued job past the warn threshold whose every runner verdict is `trust_domain` emits one `job_unplaceable` item with verdict `'waiting_capacity'`.
- `[integration]` `PrismaFleetJobRepository.findActiveLoads([runnerId])` for a runner holding a RUNNING raw `RUN` job returns a ref carrying that job's `projectId` and `bashMode` `'raw'`.
- `[integration]` with one enabled online runner of capacity 2 that already holds a RUNNING raw `RUN` job of project A, a raw `RUN` job dispatched for project B through `POST /api/fleet/jobs` stays `QUEUED`, and the dispatch response's misfits name that runner with reason `trust_domain`.
- `[integration]` with one enabled online runner of capacity 2 holding no jobs, and two QUEUED raw `RUN` jobs of projects A and B, one `POST /api/fleet/runner/sync` from that runner leaves exactly one of the two jobs `ASSIGNED` to it and the other `QUEUED`.

### US-005: GitHub client review token and branch-protection check

- `[unit]` `GitHubAppClient.mintReviewToken(42n, 'app')` sends `POST /app/installations/42/access_tokens` with body `{ repositories: ['app'], permissions: { contents: 'read', pull_requests: 'write', metadata: 'read', checks: 'read', statuses: 'read', actions: 'read' } }` and returns the token and expiry from the 201 response.
- `[unit]` `GitHubAppClient.mintReviewToken` answering 403 throws `RepoCheckException` with reason `'app_permissions_insufficient'`.
- `[unit]` `isBranchProtected('t', 'acme', 'app', 'main')` returns `true` when `GET /repos/acme/app/rules/branches/main?per_page=100` answers 200 with `[{ type: 'pull_request' }]`.
- `[unit]` `isBranchProtected` returns `true` when the rules endpoint answers 200 with `[{ type: 'update' }]`.
- `[unit]` `isBranchProtected` returns `true` when the rules endpoint answers 200 with `[]` and `GET /repos/acme/app/branches/main` answers 200 with `{ protected: true }`.
- `[unit]` `isBranchProtected` returns `false` when the rules endpoint answers 200 with `[{ type: 'required_status_checks' }]` and the branches endpoint answers 200 with `{ protected: false }`.
- `[unit]` `isBranchProtected` throws `RepoCheckException` with reason `'provider_error'` when the rules endpoint answers 500.
- `[unit]` `isBranchProtected` throws `RepoCheckException` with reason `'provider_error'` when the rules endpoint answers 200 with `[]` and the branches endpoint answers 404.
- `[unit]` `isBranchProtected('t', 'acme', 'app', 'release/v2')` requests the rules path `/repos/acme/app/rules/branches/release%2Fv2?per_page=100`.

### US-006: Token broker mints by job purpose

- `[unit]` `GitTokenBroker.mint({ jobId: 'j1', leaseEpoch: 1, repo, purpose: 'review' })` on a GitHub repo calls `github.mintReviewToken(repo.githubInstallationId, repo.name)` once and never calls `github.mintInstallationToken`.
- `[unit]` after a `purpose: 'review'` mint for job `j1` epoch 1, a `mint` for the same job and epoch with no `purpose` calls `github.mintInstallationToken`, because the review token is not reused for a write request.
- `[unit]` `mint({ ..., purpose: 'fix' })` with `github.isBranchProtected` resolving `false` returns `{ ok: false, error: { jobId: 'j1', reason: 'default_branch_unprotected' } }` and never calls `github.mintInstallationToken`.
- `[unit]` `mint({ ..., purpose: 'fix' })` calls `github.isBranchProtected` with `(<the token returned by mintReadOnlyToken>, repo.owner, repo.name, repo.defaultBranch)`.
- `[unit]` `mint({ ..., purpose: 'fix' })` with `github.isBranchProtected` resolving `true` calls `github.mintInstallationToken` once and returns `ok: true`.
- `[unit]` `mint({ ..., purpose: 'fix' })` with `github.isBranchProtected` rejecting with `RepoCheckException('provider_error')` returns an error with reason `'provider_error'` and never calls `github.mintInstallationToken`.
- `[unit]` table-driven: `mint` with `purpose` `'review'` and with `purpose` `'fix'` on a GitLab repo returns an error with reason `'provider_error'` and never calls `gitlab.resolve`.

### US-007: Sync passes the job purpose to the broker

- `[unit]` `SyncService.sync` for a runner holding an `ASSIGNED` `REVIEW` job, with a request carrying a token request `{ jobId, leaseEpoch }` and no `repoId`, results in `github.mintReviewToken` being called once and `github.mintInstallationToken` never.
- `[unit]` `SyncService.sync` for a runner holding an `ASSIGNED` `FIX` job on a repo whose default branch the stub reports unprotected, with a repo-less token request, returns a response whose `gitTokenErrors` contains `{ jobId, reason: 'default_branch_unprotected' }` and whose `gitTokens` is empty.
- `[unit]` `SyncService.sync` for a runner holding an `ASSIGNED` `RUN` job, with a repo-less token request, calls `broker.mint` with a request that has no `purpose` key.

### US-008: Web session-refresh helpers and the trust_domain label

- `[unit]` `shouldRefreshSession` for a `GET /projects` event with `accept: text/html`, cookie `koda_refresh=r1` and no `koda_token` returns `true`.
- `[unit]` `shouldRefreshSession` returns `false` for the same event when it also carries `koda_token`.
- `[unit]` `shouldRefreshSession` returns `false` for a `GET /projects` event with `accept: text/html` and no `koda_refresh` cookie.
- `[unit]` `shouldRefreshSession` returns `false` for a `GET /api/projects` event with `koda_refresh` and no `koda_token`.
- `[unit]` `shouldRefreshSession` returns `false` for a `POST /projects` event with `koda_refresh` and no `koda_token`.
- `[unit]` `shouldRefreshSession` returns `false` for a `GET /favicon.ico` event with `accept: image/*`, `koda_refresh` and no `koda_token`.
- `[unit]` `withAuthCookies('koda_refresh=r1; koda_locale=zh', { accessToken: 'a2', refreshToken: 'r2' })` returns a header that parses to exactly the cookies `koda_refresh=r2`, `koda_locale=zh` and `koda_token=a2`, each once.
- `[unit]` `withAuthCookies(undefined, { accessToken: 'a2', refreshToken: 'r2' })` returns a header that parses to exactly `koda_token=a2` and `koda_refresh=r2`.
- `[unit]` the `en` and `zh` locales each resolve `fleet.misfit.trust_domain` to a non-empty string.

### US-009: Web SSR session refresh middleware

- `[unit]` the `session-refresh` middleware handler, with `shouldRefreshSession` stubbed to return `false`, makes no upstream call.
- `[unit]` with `shouldRefreshSession` returning `true` on an event with cookie `koda_refresh=r1`, the middleware calls the upstream `POST /api/auth/refresh` once with header `Authorization: Bearer r1`.
- `[unit]` when that upstream call answers 200 with `{ ret: 0, data: { accessToken: 'a2', refreshToken: 'r2' } }`, the response carries `Set-Cookie` headers for `koda_token=a2` and `koda_refresh=r2`.
- `[unit]` on that successful refresh, the middleware sets `event.node.req.headers.cookie` to the value `withAuthCookies(<the original cookie header>, { accessToken: 'a2', refreshToken: 'r2' })` returns.
- `[unit]` table-driven: when the upstream refresh answers 401, 403, or 200 with `{ ret: 401, message: 'expired' }`, the response carries `Set-Cookie` headers that expire both `koda_token` and `koda_refresh`.
- `[unit]` when the upstream refresh answers 429, the middleware resolves without throwing and sets no `Set-Cookie` header.
- `[unit]` when the upstream refresh call rejects with a network error, the middleware resolves without throwing and sets no `Set-Cookie` header.
- `[integration]` Playwright: a signed-in browser context whose `koda_token` cookie is deleted (keeping `koda_refresh`) and which then reloads `/projects` ends on `/projects`, not `/login`.
