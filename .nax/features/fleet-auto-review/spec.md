# SPEC: Fleet auto-review (S6 K1, part B)

## Summary

A global admin can turn on auto-review for a GitHub fleet repo. While it is on, an in-process poller
lists the repo's open pull requests through the `koda-fleet` GitHub App every few minutes and dispatches
one `REVIEW` fleet job (the job kind added by part A, feature `fleet-pr-review`) for each PR head it has
not reviewed yet. The setting is a new approval-gated route, `PATCH /fleet/repos/:id/auto-review`, under
the new global key `fleet.repo.review.configure`; `/admin/fleet/repos` gains a switch for it. Each
dispatched review is requested on behalf of the principal who turned auto-review on, and the poller
re-checks that principal's dispatch permission on every pass.

## Motivation

Part A (merged as #360) lets a person dispatch a `REVIEW` job by hand through
`POST /projects/:slug/fleet/jobs` with `command: 'REVIEW'` and a `prNumber`. The fleet design (§9.122,
"S6 = K1 + K2") wants koda to review PRs as they change without anyone dispatching. Nothing in koda
notices a new PR or a new push today:

- `FleetRepo` has no review settings;
- `GitHubAppClient` can read one PR (`getPullRequest`) but cannot list a repo's open PRs;
- no component dispatches `REVIEW` jobs.

## Design

### Calls made in this spec

1. **Polling, not a webhook.** The `koda-fleet` App is installed with no webhooks and the reference
   deployment listens on loopback only, so GitHub cannot call koda. The poller reads through the App, like
   `FleetPrStateRefresher`.
2. **The enabler is the requester.** Turning auto-review on stores the caller's principal (`type` and `id`)
   and needs the caller to hold `fleet.job.dispatch` in the repo's project at that moment. The poller
   dispatches each review with `actorId` = the enabler's id inside
   `runAsSystem('pr-review', ..., { onBehalfOf: enabler })`, the `ScheduleTicker` shape, so the job's
   `requestedByType` is the enabler's type.
3. **Re-check every pass.** Before polling a repo, the poller checks the enabler with the schedule rule,
   `mayDispatch(access, keys)` (`fleet/schedules/schedule-access.ts:12`):
   - `access` comes from `IFleetPrReviewRepository.findPrincipalAccess(enabler)`. A USER exists when its
     `User` row does and is disabled when `User.disabled` is true. An AGENT exists when its `Agent` row
     does and is never disabled.
   - `keys` is `PermissionService.effectiveKeys(enabler, { projectId: repo.projectId })`.
   The check lives in `EnablerGate.check(repo): Promise<PrincipalRef | null>`. It returns the enabler when
   the check passes. On a failed check it calls `FleetReposService.disableAutoReview(repo.id,
   'enabler_lost_access', enabler.id)` and returns null, and the pass does not dispatch for that repo.
4. **Compare-and-set turn-off.** `disableAutoReview(id, reason, expectedEnablerId)` changes the row only
   when `autoReview` is true and `autoReviewEnabledById` equals `expectedEnablerId`. It records its audit
   entry only when it changed the row, and returns whether it did. So a pass reading a stale repo list
   cannot turn off a repo someone else has just re-enabled.
5. **What a pass reviews.** For each enabled repo, the poller reads one page of up to 100 open PRs and
   skips a PR that:
   - is a draft;
   - has a `headRepoFullName` that is null or is not `<owner>/<name>` (compared case-insensitively), meaning
     it comes from a fork or a deleted repository;
   - was last updated before auto-review was turned on (`updatedAt < autoReviewEnabledAt`). When
     `autoReviewEnabledAt` is null, this rule skips nothing.
   The last rule stops the first pass after enabling from reviewing every old open PR at once.
6. **One row per PR head.** `FleetPrReview` has one row per `(repoId, prNumber, headSha)`. Its `outcome` is
   `pending` (inserted, dispatch not finished), `dispatched` (with `jobId`) or `failed:<reason>`. A head
   with a `dispatched` or `failed:` row is never dispatched again.
7. **Retry later, not never.** A dispatch that fails for a reason that can clear later deletes the head's
   row, so a later pass tries the head again:
   - `BudgetPausedException` (`fleet.budgetPaused`). Every PR of the repo shares the project's budget, so
     the dispatcher also stops the rest of that repo's PRs for this pass.
   - `ConflictAppException` with key `fleet.jobs` (409): a `REVIEW` for the PR is still active. This
     happens when a new head arrives while the last review runs.
   - Any other unexpected error. It is also logged at warn level with the repo id, the PR number and the
     error name.
   The exceptions are checked in that order, because `BudgetPausedException` is a `ConflictAppException`.
   A dispatch that fails for a reason a retry cannot fix keeps the row as `failed:<reason>`:
   - `ValidationAppException`: its `args.reason` when that is a string, else the class name;
   - `NotFoundAppException` or `FleetDispatchException`: the class name.
   The stored outcome is cut to 200 characters.
8. **Crash recovery.** A `pending` row older than one poll interval (`createdAt < now - prReviewPollMs`)
   is left over from a pass that stopped between insert and dispatch. The next pass deletes it and handles
   the head as new.
9. **Per-pass cap on attempts.** A pass makes at most `prReviewMaxDispatch` (default 10) `dispatch` calls,
   across all repos, whether they succeed or fail. Heads it did not reach are picked up by a later pass.
   This also bounds the load while a budget is paused.
10. **Token.** Listing PRs needs the Pull requests permission. `mintReadOnlyToken` grants only
    `contents: read` and `metadata: read`, so the poller uses `mintInstallationToken`, as
    `FleetPrStateRefresher` does.
11. **Audit.**
    - The settings change records audit key `fleet.repo.review.configure`.
    - The poller's writes to `FleetPrReview` run inside `bookkeeping('fleet.pr-review-bookkeeping', ...)`.
    - Each dispatch records audit key `system.pr-review.dispatch` through `FleetJobsService.dispatch`.
    - An automatic turn-off records audit key `system.pr-review.dispatch`.
12. **Soft-deleted projects are skipped.** `FleetJobsService.dispatch` does not check `Project.deletedAt`,
    so the repo query used by the poller excludes repos whose project is soft-deleted.
13. **Global switch defaults on.** `FLEET_PR_REVIEW_ENABLED` defaults to `true`, because every repo's
    `autoReview` defaults to `false`. The timer starts only when `sweepEnabled` is also true.
14. **No endpoint e2e entry.** No existing `fleet/repos` route is in
    `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts`; the gated fleet admin routes are covered by
    `fleet-admin-gates.spec.ts`, the approval OpenAPI contract and the route integration spec. This route
    follows that family.

### Auto-review settings

`FleetRepo` gains:

| Column | Type | Default |
|:--|:--|:--|
| `autoReview` | `Boolean` | `false` |
| `autoReviewProfiles` | `String[]` | `[]` |
| `autoReviewMaxCostUsd` | `Decimal(10,4)` | `1.0000` |
| `autoReviewEnabledById` | `String?` | null |
| `autoReviewEnabledByType` | `String?` (`USER` or `AGENT`) | null |
| `autoReviewEnabledAt` | `DateTime?` | null |

plus `@@index([autoReview])`.

`PATCH /fleet/repos/:id/auto-review` takes the body `UpdateAutoReviewDto`:
`{ enabled: boolean; profiles?: string[]; maxCostUsd?: number }`.
- `profiles` uses the `DispatchFleetJobDto.profiles` decorators: an array of at most 8 strings, each at
  most 64 characters.
- `maxCostUsd` is a number from 0.0001 to 10000 with at most 4 decimals.

The DTO validates both fields whatever `enabled` is.

`FleetReposService.configureAutoReview(principal: UserPrincipal | AgentPrincipal, id: string,
dto: UpdateAutoReviewDto): Promise<FleetRepoDto>` maps `principal.actorType` `'user'` to `USER` and
`'agent'` to `AGENT`, then applies the rules in this order:

1. An unknown id throws `NotFoundAppException({}, 'fleet.repos')` (404).
2. With `enabled: true`, each of these throws `AutoReviewException(<reason>)` (422, key `fleet.autoReview`):
   - a repo that is not `github`, or that has no `githubInstallationId`: reason `github app required`;
   - a profile that does not match `PROFILE_NAME_RE` or that starts with `RESERVED_PROFILE_PREFIX`:
     reason `profiles`;
   - duplicate profiles: reason `duplicate profile`;
   - a caller for whom `PermissionService.canHoldKey(<caller ref>, 'fleet.job.dispatch',
     { projectId: repo.projectId })` is false: reason `caller cannot dispatch in this project`.
3. `enabled: true` sets:
   - `autoReview` to true;
   - `profiles` and `maxCostUsd` when given. An omitted field keeps its stored value, and `profiles: []`
     stores `[]`;
   - `autoReviewEnabledById` and `autoReviewEnabledByType` to the caller;
   - `autoReviewEnabledAt` to now, only when `autoReview` was false before. Re-saving an enabled repo keeps
     the original time.
4. `enabled: false` sets `autoReview` false and the three `autoReviewEnabled*` columns to null. It ignores
   `profiles` and `maxCostUsd` and keeps the stored values.
5. It records the audit entry and returns the repo's `FleetRepoDto`.

The read, the update and the audit run in one `txManager.run`.

`FleetReposService` gains `PermissionService` as a new last constructor parameter (`PermissionsModule` is
global).

`FleetRepoDto` gains:
- `autoReview: boolean`;
- `autoReviewProfiles: string[]`;
- `autoReviewMaxCostUsd: string` (4 places, e.g. `1.0000`);
- `autoReviewEnabledById: string | null`;
- `autoReviewEnabledByType: 'USER' | 'AGENT' | null`;
- `autoReviewEnabledAt: string | null` (ISO).

The Prisma repository's shared row mapping (used by `create`, `findById`, `findAnchor`, `findPage` and the
new methods) maps `autoReviewMaxCostUsd` to a 4-place string and `autoReviewEnabledByType` to the union.

The controller method is `FleetReposController.configureAutoReview(id, dto)`. It follows the `check` route:
- `@Patch(':id/auto-review')`, `@HttpCode(200)`, `@UseGuards(RequiresGuard)`,
  `@Requires('fleet.repo.review.configure')`, `@ApprovalGated()`;
- `@ApiOperation({ summary: 'Configure auto-review for a registered repo (fleet.repo.review.configure, global)' })`,
  `@ApiResponse` entries for 200 (`FleetRepoDto`), 403, 404 and 422;
- `routeGate.run({ key: 'fleet.repo.review.configure', variant: FLEET_REPO_ROUTE_VARIANTS.autoReview,
  projectId: null, input: { id, patch: dto } })`.

The variant is `rest:fleet-repos.auto-review`. Its route command parses `{ id, patch }` like the role
update command (`permission-route.commands.ts:63-66`): the non-empty string `id`, plus
`parseBody(UpdateAutoReviewDto, patch)`. It runs `configureAutoReview(principal, input.id, input.patch)`
with the principal the loader rebuilds, so a deferred approval records the original requester as the
enabler.

### The PR list

`OpenPullRequest` (exported from `fleet/git-broker/github-app-client.ts`) has the shape
`{ number: number; headSha: string; draft: boolean; headRepoFullName: string | null; updatedAt: Date }`.

`GitHubAppClient.listOpenPullRequests(token, owner, name): Promise<OpenPullRequest[]>` sends
`GET /repos/{owner}/{name}/pulls?state=open&per_page=100` through `FleetHttpClient`, one page only.
- It maps each item from `number`, `head.sha`, `draft`, `head.repo?.full_name ?? null` and `updated_at`.
- A reply of exactly 100 items logs a warning, through a Nest `Logger` named `GitHubAppClient`, naming `<owner>/<name>`: PRs past the first page are not
  seen.
- A non-200 reply throws `RepoCheckException('provider_error')`, like `getPullRequest`.
- These replies also throw `RepoCheckException('provider_error')`:
  - a body that is not an array;
  - an item without a numeric `number`, a string `head.sha`, a boolean `draft` or a string `updated_at`.

### `FleetPrReview`

`FleetPrReview` columns:
- `id` (cuid);
- `repoId`, an FK to `FleetRepo` with cascade delete;
- `prNumber Int`, `headSha String`;
- `jobId String?`;
- `outcome String`;
- `createdAt DateTime @default(now())`, `updatedAt DateTime @updatedAt`.

It has a unique index on `(repoId, prNumber, headSha)`. It sits behind `FLEET_PR_REVIEW_REPOSITORY`
(interface `IFleetPrReviewRepository`), implemented by
`PrismaFleetPrReviewRepository extends AbstractPrismaRepository`, which adds:
- `findHead(repoId, prNumber, headSha): Promise<FleetPrReviewRecord | null>`;
- `insertPending(repoId, prNumber, headSha): Promise<FleetPrReviewRecord | null>`. It returns null on a
  unique violation (P2002), so a concurrent pass loses quietly;
- `markDispatched(id, jobId): Promise<void>`;
- `markFailed(id, outcome): Promise<void>`;
- `remove(id): Promise<void>`;
- `findPrincipalAccess(ref: PrincipalRef): Promise<{ exists: boolean; disabled: boolean }>`, the
  `PrismaScheduleRepository.findOwnerAccess` rules.

### The dispatcher

`ReviewHeadDispatcher.dispatchRepo(repo: FleetRepoRecord, prs: readonly OpenPullRequest[],
opts: { now: Date; pollMs: number; remaining: number }): Promise<number>` handles one repo. It returns the
number of `dispatch` calls it made. It walks `prs` in ascending `number`, and for each PR:

1. Skip it under the call-5 rules.
2. Read `findHead`.
   - A `dispatched` or `failed:` row: skip.
   - A `pending` row with `createdAt >= now - pollMs`: skip.
   - An older `pending` row: `remove` it and go on.
3. Stop when the number of calls made has reached `opts.remaining`.
4. `insertPending`. On null, skip.
5. Call `FleetJobsService.dispatch` with:
   - `actorId` = `repo.autoReviewEnabledById` and the repo's `projectId`;
   - the body `{ command: 'REVIEW', repoId, prNumber, profiles: repo.autoReviewProfiles,
     maxCostUsd: Number(repo.autoReviewMaxCostUsd) }`;
   - opts `{ auditKey: 'system.pr-review.dispatch' }`.
   On success, `markDispatched` with the result's job id. On a throw, apply call 7.

Every `FleetPrReview` write runs in `bookkeeping('fleet.pr-review-bookkeeping', ...)`.

### The pass and the poller

`FleetPrReviewPass` has `@SystemWriter('system.pr-review.dispatch')` and is the system writer for this
feature. `FleetPrReviewPass.run(now): Promise<void>` runs its whole body inside `runAsSystemWriter(this, ...)`.

`FleetPrReviewPoller` owns the lifecycle:
- On `onModuleInit`, when `sweepEnabled` and `prReviewEnabled` are both true, it starts an unref'd
  `setInterval` of `prReviewPollMs` that calls `poll()`.
- `onModuleDestroy` clears the interval.
- `poll()` calls `FleetPrReviewPass.run(new Date())` once. A `poll()` that starts while an earlier one is
  unresolved returns without calling `run`. `poll()` never rejects; an error escaping `run` is logged at
  error level by the poller's Nest `Logger`.

`FleetPrReviewPass.run(now)`:

1. Reads `FleetReposService.listAutoReviewRepos(50)`: repos with `autoReview` true, provider `github`, a
   non-null `githubInstallationId` and a project with `deletedAt` null, ordered by `id`, at most 50. A full
   page logs a warning.
2. For each repo, with `remaining = prReviewMaxDispatch - calls made so far`:
   1. Inside `runAsSystem('pr-review', ..., { onBehalfOf: <the stored enabler> })`, so the turn-off audit
      and the dispatch audit both carry the enabler:
   2. Call `EnablerGate.check(repo)`. On null, go to the next repo.
   3. Mint a token with `mintInstallationToken(installationId, name)` and read
      `listOpenPullRequests(token, owner, name)`.
   4. Run `dispatchRepo(repo, prs, { now, pollMs: prReviewPollMs, remaining })`.
3. A throw anywhere in step 2 for one repo is logged at warn level with the repo id and the error name, and
   the pass goes on to the next repo.
4. The pass ends when `remaining` reaches 0.

`FleetReposService.disableAutoReview(id: string, reason: string, expectedEnablerId: string):
Promise<boolean>` makes the call-4 compare-and-set update and records the audit entry
`{ key: 'system.pr-review.dispatch', resourceType: 'fleet-repo', resourceId: id, projectId, summary:
'auto-review disabled: <reason>' }`, both inside one `txManager.run`.

Config (`IFleetConfig`; `FleetConfigSchema` in `fleet.config.ts`; `env.validation.ts`):

| Field | Env | Default | Validation |
|:--|:--|:--|:--|
| `prReviewEnabled` | `FLEET_PR_REVIEW_ENABLED` | `true`; `false` (any case) turns it off | `Joi.string().pattern(/^(true\|false)$/i)` optional, like the other boolean flags |
| `prReviewPollMs` | `FLEET_PR_REVIEW_POLL_MS` | `300000` | integer 60000..86400000 |
| `prReviewMaxDispatch` | `FLEET_PR_REVIEW_MAX_DISPATCH` | `10` | integer 1..100 |

The pass, the poller, `EnablerGate` and `ReviewHeadDispatcher` live in a new `FleetReviewsModule`
(`apps/api/src/fleet/reviews/`), which `FleetModule` imports.
- It provides them plus `PrismaFleetPrReviewRepository` and `FLEET_PR_REVIEW_REPOSITORY`.
- `PrismaFleetPrReviewRepository.findPrincipalAccess` reads the `User` and `Agent` tables directly, as
  `PrismaScheduleRepository.findOwnerAccess` does; this is the accepted precedent, not a layering breach.
- It imports `FleetReposModule`, `FleetJobsModule` and `GitBrokerModule`, and exports nothing.
- `FleetReposModule` adds `FleetReposService` to its `exports`, so the poller can inject it. The
  repository token stays where it is.

### Integration

Read-only (verified at koda `main` `57af21e9`):

- `FleetJobsService.dispatch(actorId, projectId, dto, opts)` (`apps/api/src/fleet/jobs/fleet-jobs.service.ts:77`):
  - `requestedByType` is `actorTypeFor(actorId)`, which honours `onBehalfOf`;
  - it throws `NotFoundAppException({}, 'fleet.repos')`, `BudgetPausedException`,
    `ConflictAppException({ activeJobId }, 'fleet.jobs')`, `ValidationAppException({ reason }, 'fleet.dispatchInput')`
    and `FleetDispatchException`.
- `ScheduleTicker.dispatchFresh` / `disable` / `onDispatchError` (`fleet/schedules/schedule-ticker.ts:147-232`):
  the pattern for the re-check, `runAsSystem(..., { onBehalfOf })`, the `instanceof` chain and the audit on
  disable.
- `mayDispatch(access, keys)` (`fleet/schedules/schedule-access.ts:12`).
- `PrismaScheduleRepository.findOwnerAccess` (`fleet/schedules/prisma-schedule.repository.ts:114`): the
  access rules `findPrincipalAccess` copies.
- `PermissionService.canHoldKey(principal, key, scope)` and `effectiveKeys(principal, scope)`
  (`permissions/permission.service.ts:59,98`).
- `FleetPrStateRefresher` (`fleet/tickets/fleet-pr-state.refresher.ts`): the timer, `onModuleDestroy`,
  single-flight, `runAsSystemWriter` and `mintInstallationToken` pattern.
- `GitHubAppClient.mintInstallationToken(installationId, repoName)` and
  `getPullRequest(token, owner, name, number)` (`fleet/git-broker/github-app-client.ts:61,122`);
  `FleetHttpClient.request`.
- `FleetReposController.check` and `FleetRepoRouteCommands` (`fleet/repos/`): the gated global route
  pattern.
- `bookkeeping(reason, fn)` (`action-context/audit-coverage.ts:228`), `runAsSystemWriter`, `runAsSystem`
  (`action-context/action-context.ts:123,146`), `@SystemWriter(key)`.
- `PROFILE_NAME_RE` (`fleet/common/capabilities`), `RESERVED_PROFILE_PREFIX` (`fleet/jobs/dispatch-input.ts:14`).
- `UserPrincipal | AgentPrincipal` with `actorType: 'user' | 'agent'` (`approvals/route/route-command.ts:21`).
- `useGlobalPermissions()` (`apps/web/composables/usePermissions.ts:75`); `ApprovalRequestSummary`
  (`apps/web/lib/approval-requests.ts:42`, which has `permissionKey`); the `Switch` component
  (`apps/web/components/ui/switch`).

Changed. The baseline locates the code; implement the target.

- `FleetRepoRecord` (`fleet/repos/domain/fleet-repo.domain.ts:6`):
  - Baseline: 9 fields.
  - Target: adds `autoReview: boolean`, `autoReviewProfiles: string[]`, `autoReviewMaxCostUsd: string`,
    `autoReviewEnabledById: string | null`, `autoReviewEnabledByType: 'USER' | 'AGENT' | null` and
    `autoReviewEnabledAt: Date | null`.
  - `IFleetRepoRepository.create` keeps its input free of these six fields, and the database defaults
    fill them.
- `IFleetRepoRepository` adds:
  - `updateAutoReview(id: string, patch: AutoReviewPatch): Promise<FleetRepoRecord>`, where
    `AutoReviewPatch` is a partial of the six fields;
  - `disableAutoReviewIf(id: string, expectedEnablerId: string): Promise<boolean>`;
  - `findAutoReviewPage(limit: number): Promise<FleetRepoRecord[]>`.
- `FleetReposService`: adds `configureAutoReview`, `listAutoReviewRepos(limit)` and `disableAutoReview`,
  plus the `PermissionService` constructor parameter.
- `FleetReposModule` (`fleet/repos/fleet-repos.module.ts:20`):
  - Baseline: `exports: [FLEET_REPO_REPOSITORY]`.
  - Target: `exports: [FLEET_REPO_REPOSITORY, FleetReposService]`.
- `FleetRepoDto` (`fleet/repos/dto/fleet-repo.dto.ts`): adds the six fields above.
- `FLEET_REPO_ROUTE_VARIANTS` (`fleet/repos/fleet-repo-route.commands.ts:12`):
  - Baseline: `create`, `delete`, `check`.
  - Target: adds `autoReview: 'rest:fleet-repos.auto-review'`.
- `FleetJobsService.dispatch` `opts.auditKey`:
  - Baseline: `'fleet.job.dispatch' | 'thread.plan' | 'thread.run' | 'system.schedule.dispatch'`.
  - Target: adds `'system.pr-review.dispatch'`.
- `BOOKKEEPING_REASONS` (`action-context/audit-coverage.reasons.ts`): adds `'fleet.pr-review-bookkeeping'`.
- `INVENTORY_SCOPE_ROWS` (`permissions/catalog.ts:154`): adds `'fleet.repo.review.configure': ['global']`
  right after `'fleet.repo.check'`, and `'system.pr-review.dispatch': ['system']` right after
  `'system.schedule.dispatch'`. The role-matrix snapshot follows catalog order, so the new cells sit at the
  same positions.
- `IFleetConfig` (`config/fleet.config.ts`): adds the three fields above.
- `GitHubAppClient`: adds `listOpenPullRequests` and the `OpenPullRequest` type.
- `FakeRequest` (`apps/api/test/helpers/fake-forge.ts`): adds `query: string` (the raw query string, `''`
  when absent).
- Web `FleetRepo` (`apps/web/lib/fleet-types.ts:120`) adds the six fields. `useFleetRepos` adds
  `setAutoReview(id, body): Promise<{ kind: 'saved'; repo: FleetRepo } | { kind: 'pending'; request: ApprovalRequestSummary }>`.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| Turn on for a GitLab repo or a repo without an App installation | 422 `fleet.autoReview`, reason `github app required`. |
| Turn on with a reserved or malformed profile | 422 `fleet.autoReview`, reason `profiles`. |
| Turn on by a caller without `fleet.job.dispatch` in the repo's project | 422 `fleet.autoReview`, reason `caller cannot dispatch in this project`. |
| PATCH for an unknown repo id | 404 `fleet.repos`. |
| Caller without `fleet.repo.review.configure` | 403. |
| Agent caller under a policy that needs approval | 202 with the pending request; nothing changes until it is approved. |
| Enabler deleted, disabled or without `fleet.job.dispatch` in the project | Auto-review turned off for the repo (compare-and-set), audit `auto-review disabled: enabler_lost_access`, no dispatch. |
| Mint, list, the enabler check or the turn-off fails for one repo | Warn log with the repo id and error name; the pass continues. |
| A `REVIEW` for the PR is still active (409) | Row removed; the head is tried again by a later pass. |
| Budget paused | Row removed; the repo's other PRs wait for a later pass. |
| Dispatch validation fails, or the repo vanished (404) | Row kept as `failed:<reason>`; the head is not tried again. |
| Unexpected dispatch error | Warn log; row removed; the head is tried again by a later pass. |
| Pass stopped between insert and dispatch | The `pending` row is replaced after one poll interval. |
| PATCH answers 202 in the web | The switch keeps its old state and a pending-approval notice shows. |
| PATCH answers 422 in the web | The API's message shows through `extractApiError`. |

## Out of Scope

- A GitHub webhook trigger for reviews; reviews are found by polling through the App.
- Reviewing draft PRs and PRs from forks.
- Open PRs beyond the first page of 100 per repo per pass; a full page logs a warning.
- More than 50 auto-review repos per pass; repos past the first 50 by id are not polled, and a full page logs a warning.
- Reviewing a head whose PR was last updated before auto-review was turned on.
- Recording which head a `REVIEW` job actually reviewed; nax reviews the PR's current head when the job runs, so a head that arrives while a review is queued can be reviewed twice.
- Re-reviewing a head whose `REVIEW` job failed or was cancelled; its row stays `dispatched` until the PR gets a new head.
- A duplicate review when the API stops after `dispatch` commits and before `markDispatched`; the `pending` row is replaced after one poll interval and the head is dispatched again.
- A PATCH that turns auto-review off while a pass is running; that pass can still dispatch reviews for the repo.
- Suppressing failure notifications for poller-dispatched reviews; a failed review notifies its user requester like any job, and agent requesters get none, as today.
- Deleting old `FleetPrReview` rows; they are kept.
- An unexpected error thrown after `dispatch` has committed the job (placement, live publish or ticket effects) removes the head's row; later passes then get 409 until that job ends and review the head again.
- Fair sharing of the per-pass cap between repos; repos are polled in id order, so a low-id repo with many retrying heads can use the whole cap.
- A `fleet.repo.check` approval requested before an auto-review change and approved after it answers 409 `fleet.repos`, because `prepareCheck` compares the whole repo row; this is accepted.
- A narrower PR-read token; the poller uses the installation token that `FleetPrStateRefresher` uses.
- CLI commands for auto-review; the generated CLI client is regenerated but no command is added.
- Live verification against GitHub; it needs a nax with the `bot-forge-identity` feature on a runner and happens at deploy.
- GitLab auto-review.
- Showing a repo's review history (`FleetPrReview` rows) in the web.

## Stories

This is one capability in 11 stories, split to keep each story under the 15-AC gate. The system key, its
writer class and that class's module registration land together in US-009, because the permission
contract checks every catalog key against the writers of the booted module.

### US-001: API auto-review columns, repo listing and config

Workdir: apps/api. No dependencies.

Adds the six `FleetRepo` columns and the index in migration `20261112090000_fleet_auto_review`. Extends
`FleetRepoRecord`, the Prisma repository's shared row mapping and `FleetRepoDto`. Adds
`IFleetRepoRepository.findAutoReviewPage` and `FleetReposService.listAutoReviewRepos`. Adds the three
config fields with env validation and the `FleetConfigSchema` entries.

### US-002: API auto-review settings rules

Workdir: apps/api. Depends on US-001.

Adds `UpdateAutoReviewDto` and `AutoReviewException` (key `fleet.autoReview`, 422, with `{reason}`), with
its `en` and `zh` strings. Adds `IFleetRepoRepository.updateAutoReview` and
`FleetReposService.configureAutoReview` with the rules above, including the new `PermissionService`
constructor parameter.

### US-003: API auto-review route and permission key

Workdir: apps/api. Depends on US-002.

Adds the catalog key `fleet.repo.review.configure` (global, role access, approvable) through
`INVENTORY_SCOPE_ROWS` and a new inventory row. Adds `FleetReposController.configureAutoReview` with the
decorators above, the route command with variant `rest:fleet-repos.auto-review`, and the regenerated
`openapi.json` and CLI client (`bun run generate` from the repo root). Updates the specs that pin gated
routes, route variants and role-matrix key counts.

### US-004: API open-PR listing through the App

Workdir: apps/api. No dependencies.

Adds `OpenPullRequest` and `GitHubAppClient.listOpenPullRequests` with a Nest `Logger` named
`GitHubAppClient`, and gives the fake forge's `FakeRequest` a `query` field.

### US-005: API review-head table and automatic turn-off

Workdir: apps/api. Depends on US-001.

Adds the `FleetPrReview` model in migration `20261113090000_fleet_pr_review`, `FleetPrReviewRecord`,
`IFleetPrReviewRepository`, `FLEET_PR_REVIEW_REPOSITORY` and `PrismaFleetPrReviewRepository` with the
methods above, including `findPrincipalAccess`. Adds `IFleetRepoRepository.disableAutoReviewIf` and
`FleetReposService.disableAutoReview` (the call-4 compare-and-set with its audit).

### US-006: API review-head dispatcher, selection and recovery

Workdir: apps/api. Depends on US-004, US-005.

Adds `ReviewHeadDispatcher.dispatchRepo` with the skip rules, row lookups, stale `pending` recovery, the
`remaining` limit, the dispatch call on success, and the `bookkeeping` wrapping. Adds the bookkeeping
reason `fleet.pr-review-bookkeeping` and the widened `dispatch` `auditKey`.

### US-007: API review-head dispatcher, failure outcomes

Workdir: apps/api. Depends on US-006.

Adds the call-7 outcome mapping to `dispatchRepo`: which errors remove the row, which keep
`failed:<reason>`, the stop-the-repo rule on a paused budget, the warn log through the dispatcher's Nest
`Logger`, and the 200-character cut.

### US-008: API enabler gate

Workdir: apps/api. Depends on US-005.

Adds `EnablerGate.check(repo)` (`apps/api/src/fleet/reviews/enabler-gate.ts`): `findPrincipalAccess`,
`PermissionService.effectiveKeys` in the repo's project and `mayDispatch`, then the turn-off on a failed
check.

### US-009: API PR review pass and module

Workdir: apps/api. Depends on US-003, US-007, US-008.

Adds `FleetPrReviewPass` with `@SystemWriter('system.pr-review.dispatch')` and `run(now)`: the repo list,
`runAsSystem` with `onBehalfOf`, the enabler gate, per-repo mint and list, the dispatcher call, the cap
carried across repos and per-repo error containment. Adds the system catalog key
`system.pr-review.dispatch` (inventory row and `INVENTORY_SCOPE_ROWS`, system access). Adds
`FleetReviewsModule` with the pass, `EnablerGate`, the dispatcher and the repository, registered in
`FleetModule`, and exports `FleetReposService` from `FleetReposModule`.

### US-010: API PR review poller lifecycle

Workdir: apps/api. Depends on US-009.

Adds `FleetPrReviewPoller` to `FleetReviewsModule`: the timer on `onModuleInit`, the clear on
`onModuleDestroy`, and single-flight `poll()` that never rejects.

### US-011: Web auto-review switch

Workdir: apps/web. Depends on US-003.

On `/admin/fleet/repos`, each GitHub repo with an App installation gets an auto-review control, the
component `FleetRepoAutoReview` (file `components/fleet/RepoAutoReview.vue`, auto-imported by Nuxt under
that name). Its switch is enabled only when `useGlobalPermissions()` has `fleet.repo.review.configure`.
Turning it on, or choosing the edit button of an enabled repo, opens a dialog with:
- a profiles field (comma-separated);
- a max-cost field;
both validated with vee-validate and zod. Saving calls `useFleetRepos().setAutoReview` with
`enabled: true`; turning the switch off calls it with `{ enabled: false }`.

`setAutoReview` returns `{ kind: 'pending', request }` when the API's data has a `permissionKey` (the 202
approval summary), and `{ kind: 'saved', repo }` otherwise. Strings live under `fleet.repos.autoReview.*`
in `en` and `zh`.

### Context Files

**US-001**

- `apps/api/src/fleet/repos/domain/fleet-repo.domain.ts` — `FleetRepoRecord`, `IFleetRepoRepository`.
- `apps/api/src/fleet/repos/prisma-fleet-repo.repository.ts` — the mapping to extend.
- `apps/api/src/fleet/repos/dto/fleet-repo.dto.ts` — `FleetRepoDto.from`.
- `apps/api/src/config/fleet.config.ts` — config fields and `FleetConfigSchema`.
- `apps/api/src/config/env.validation.ts` — env validation, the boolean flag pattern at lines 76-78.

**US-002**

- `apps/api/src/fleet/repos/fleet-repos.service.ts` — the audit and transaction pattern in `create` and `remove`.
- `apps/api/src/fleet/jobs/dispatch-input.ts` — `RESERVED_PROFILE_PREFIX`, the profile checks.
- `apps/api/src/fleet/git-broker/repo-check.exception.ts` — an `AppException` with `{reason}`.
- `apps/api/src/permissions/permission.service.ts` — `canHoldKey`.

**US-003**

- `apps/api/src/fleet/repos/fleet-repos.controller.ts` — the `check` route.
- `apps/api/src/fleet/repos/fleet-repo-route.commands.ts` — route command registration.
- `apps/api/src/permissions/permission-route.commands.ts` — the `{ id, patch }` parse.
- `apps/api/src/permissions/catalog.ts` — `INVENTORY_SCOPE_ROWS`, `deriveScope`.
- `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` — the `fleet.repo.check` row (line 86) to mirror.

**US-004**

- `apps/api/src/fleet/git-broker/github-app-client.ts` — `getPullRequest`.
- `apps/api/src/fleet/git-broker/github-app-client.spec.ts` — `startFakeForge()` usage.
- `apps/api/src/fleet/git-broker/fleet-http-client.ts` — `FleetHttpClient.request`.

**US-005**

- `apps/api/prisma/schema.prisma` — `FleetRepo`.
- `apps/api/src/fleet/repos/prisma-fleet-repo.repository.ts` — the repository and P2002 pattern.
- `apps/api/src/fleet/schedules/prisma-schedule.repository.ts` — `findOwnerAccess`.
- `apps/api/src/fleet/schedules/schedule-ticker.ts` — the audit on disable.

**US-006**

- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `dispatch`.
- `apps/api/src/action-context/audit-coverage.reasons.ts` — `BOOKKEEPING_REASONS`.
- `apps/api/src/action-context/audit-coverage.ts` — `bookkeeping`.
- `apps/api/src/fleet/reviews/domain/fleet-pr-review.domain.ts` — created by US-005, used here.

**US-007**

- `apps/api/src/fleet/schedules/schedule-ticker.ts` — `onDispatchError`.
- `apps/api/src/fleet/budgets/budget.exceptions.ts` — `BudgetPausedException`.
- `apps/api/src/fleet/reviews/review-head-dispatcher.ts` — created by US-006, extended here.

**US-008**

- `apps/api/src/fleet/schedules/schedule-access.ts` — `mayDispatch`.
- `apps/api/src/fleet/schedules/schedule-ticker.ts` — `dispatchFresh`, the owner check.
- `apps/api/src/fleet/reviews/domain/fleet-pr-review.domain.ts` — created by US-005, used here.

**US-009**

- `apps/api/src/fleet/tickets/fleet-pr-state.refresher.ts` — `runAsSystemWriter` and `mintInstallationToken` use.
- `apps/api/src/fleet/repos/fleet-repos.module.ts` — the exports to extend.
- `apps/api/src/fleet/fleet.module.ts` — module imports.
- `apps/api/src/permissions/system-writer.decorator.spec.ts` — the writers map.
- `apps/api/src/fleet/reviews/enabler-gate.ts` — created by US-008, used here.

**US-010**

- `apps/api/src/fleet/tickets/fleet-pr-state.refresher.ts` — timer, destroy and single-flight.
- `apps/api/src/fleet/reviews/fleet-reviews.module.ts` — created by US-009, extended here.

**US-011**

- `apps/web/pages/admin/fleet/repos.vue` — the repo table.
- `apps/web/composables/useFleetRepos.ts` — the `check` call pattern.
- `apps/web/pages/admin/fleet/budgets.vue` — `useGlobalPermissions` gating.
- `apps/web/lib/approval-requests.ts` — `ApprovalRequestSummary`.
- `apps/web/tests/helpers/mount-sfc.ts` — `FleetComponentName`, `FLEET_COMPONENT_FILES`, auto-import globals.

### Creates

**US-001**

- `apps/api/prisma/migrations/20261112090000_fleet_auto_review/migration.sql` — the six columns and the index.
- `apps/api/test/integration/fleet/fleet-repo-auto-review.integration.spec.ts` — repository round-trip and page tests.

**US-002**

- `apps/api/src/fleet/repos/dto/update-auto-review.dto.ts` — `UpdateAutoReviewDto`.
- `apps/api/src/fleet/repos/auto-review.exception.ts` — `AutoReviewException`.
- `apps/api/src/fleet/repos/fleet-repos.auto-review.spec.ts` — service unit tests.

**US-003**

- `apps/api/test/integration/fleet/fleet-repo-auto-review-route.integration.spec.ts` — route tests.

**US-005**

- `apps/api/prisma/migrations/20261113090000_fleet_pr_review/migration.sql` — the `FleetPrReview` table.
- `apps/api/src/fleet/reviews/domain/fleet-pr-review.domain.ts` — `FleetPrReviewRecord`, the interface, the token.
- `apps/api/src/fleet/reviews/prisma-fleet-pr-review.repository.ts` — the repository.
- `apps/api/test/integration/fleet/fleet-pr-review.integration.spec.ts` — repository tests.
- `apps/api/src/fleet/repos/fleet-repos.disable-auto-review.spec.ts` — turn-off unit tests.

**US-006**

- `apps/api/src/fleet/reviews/review-head-dispatcher.ts` — `ReviewHeadDispatcher`.
- `apps/api/src/fleet/reviews/review-head-dispatcher.spec.ts` — unit tests.

**US-007**

- `apps/api/src/fleet/reviews/review-head-dispatcher.outcomes.spec.ts` — outcome unit tests.

**US-008**

- `apps/api/src/fleet/reviews/enabler-gate.ts` — `EnablerGate`.
- `apps/api/src/fleet/reviews/enabler-gate.spec.ts` — unit tests.

**US-009**

- `apps/api/src/fleet/reviews/fleet-pr-review.pass.ts` — `FleetPrReviewPass`.
- `apps/api/src/fleet/reviews/fleet-reviews.module.ts` — `FleetReviewsModule`.
- `apps/api/src/fleet/reviews/fleet-pr-review.pass.spec.ts` — unit tests.
- `apps/api/src/fleet/reviews/fleet-reviews.module.spec.ts` — DI wiring test.

**US-010**

- `apps/api/src/fleet/reviews/fleet-pr-review.poller.ts` — `FleetPrReviewPoller`.
- `apps/api/src/fleet/reviews/fleet-pr-review.poller.spec.ts` — unit tests.

**US-011**

- `apps/web/components/fleet/RepoAutoReview.vue` — `FleetRepoAutoReview`: the switch, edit button and dialog.
- `apps/web/tests/components/repo-auto-review.spec.ts` — component tests.

### Modifies

**US-001**

- `apps/api/prisma/schema.prisma` — the FleetRepo model gains the six auto-review columns and the autoReview index, matching the US-001 migration.
- `apps/api/src/fleet/threads/project-brief.service.spec.ts` — the repoRecord helper (lines 27-37) builds a full FleetRepoRecord literal; it gains the six auto-review fields (autoReview false, autoReviewProfiles empty, autoReviewMaxCostUsd '1.0000', three nulls) so it type-checks; no assertion changes.
- `apps/api/src/common/test-helpers/fleet-config.ts` — testFleetConfig builds a full IFleetConfig literal; it gains prReviewEnabled false, prReviewPollMs 300000 and prReviewMaxDispatch 10.

**US-002**

- `apps/api/src/i18n/en/fleet.json` — gains the autoReview key with its 422 message, Auto-review cannot be configured: {reason}.
- `apps/api/src/i18n/zh/fleet.json` — gains the autoReview key with the Chinese 422 message carrying {reason}.
- `apps/api/src/fleet/repos/fleet-repos.service.spec.ts` — it constructs FleetReposService with positional arguments; each construction gains a trailing PermissionService stub for the new last constructor parameter; no assertion changes.
- `apps/api/src/approvals/approval-execution.service.spec.ts` — line 303 constructs FleetReposService with positional arguments; it gains a trailing PermissionService stub; no assertion changes.

**US-003**

- `openapi.json` — regenerated by bun run generate; gains the PATCH /api/fleet/repos/{id}/auto-review operation and the six FleetRepoDto fields.
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — AC-12 (US-007) pins exactly 125 gated routes (line 68); the new gated PATCH makes it 126. Change the number and its comment; the assertion stays an exact count.
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — the gatedOperations list gains the entry patch /api/fleet/repos/{id}/auto-review; the describe title (line 175) and the it title (line 256) change from 125 to 126, and toHaveLength(125) (line 258) becomes 126.
- `apps/api/src/fleet/repos/fleet-repo-route.commands.spec.ts` — the variants length assertion (line 19) changes from 3 to 4, and any per-variant loop gains auto-review.
- `apps/api/src/fleet/repos/fleet-admin-gates.spec.ts` — the cases table gains a fleet.repo.review.configure case with variant rest:fleet-repos.auto-review, input with id r1 and patch enabled false, and a call through configureAutoReview; the service stub gains configureAutoReview.
- `apps/api/src/fleet/fleet-openapi.contract.spec.ts` — the permission rows gain one row: path /api/fleet/repos/{id}/auto-review, method patch, key fleet.repo.review.configure; the controller's summary and 403 response satisfy its per-row checks.
- `apps/api/src/permissions/role-matrix.spec.ts` — the per-role cell count (line 224) pins 219 catalog keys; the new key makes it 220; it stays an exact count.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — every role gains fleet.repo.review.configure, placed right after fleet.repo.check, with the same cell as fleet.repo.check for that role (granted, granted for owner and admin). Every other entry stays identical.
- `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` — the catalog spec re-derives the catalog from this file; it gains one REST row for PATCH /fleet/repos/:id/auto-review with key fleet.repo.review.configure and catalog scope global, every column mirroring the fleet.repo.check row at line 86.

**US-004**

- `apps/api/test/helpers/fake-forge.ts` — FakeRequest gains a query field holding the raw query string (empty when absent), set where the path is split from the URL (line 28); additive, no existing request field changes.

**US-005**

- `apps/api/prisma/schema.prisma` — gains the FleetPrReview model and the reverse relation on FleetRepo, matching the US-005 migration.

**US-006**

- `apps/api/src/action-context/audit-coverage.bookkeeping.spec.ts` — EXPECTED_REASON_IDS (lines 14-43) must equal BOOKKEEPING_REASONS; it gains fleet.pr-review-bookkeeping.

**US-009**

- `apps/api/src/permissions/system-writer.decorator.spec.ts` — the writers map (lines 39-75) gains FleetPrReviewPass with key system.pr-review.dispatch, and the length assertion (line 99) changes from 34 to 35; AC-5 then holds for the new system key.
- `apps/api/src/permissions/role-matrix.spec.ts` — the per-role cell count (line 224), 220 after US-003, becomes 221 for the new system key; it stays an exact count.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — every role gains system.pr-review.dispatch, placed right after system.schedule.dispatch, as non-role-key, non-role-key, like system.schedule.dispatch. Every other entry stays identical.
- `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` — it gains one system row for FleetPrReviewPass (run by FleetPrReviewPoller on a setInterval) with key system.pr-review.dispatch and catalog scope system, every column mirroring the ScheduleTicker row at line 258.

**US-011**

- `apps/web/pages/admin/fleet/repos.vue` — gains the FleetRepoAutoReview control per GitHub repo with an installation and reads useGlobalPermissions for fleet.repo.review.configure.
- `apps/web/composables/useFleetRepos.ts` — gains setAutoReview with the saved or pending result.
- `apps/web/lib/fleet-types.ts` — FleetRepo gains the six auto-review fields.
- `apps/web/i18n/locales/en.json` — gains the fleet.repos.autoReview keys.
- `apps/web/i18n/locales/zh.json` — gains the fleet.repos.autoReview keys, matching en.
- `apps/web/tests/helpers/mount-sfc.ts` — FleetComponentName and FLEET_COMPONENT_FILES (lines 286-312 and 428) gain FleetRepoAutoReview mapped to RepoAutoReview.vue, so pages can mount the real component; no other entry changes.
- `apps/web/tests/helpers/fleet-harness.ts` — the uiStubs list (lines 81-110) gains a Switch stub so the repos page and FleetRepoAutoReview mount under the harness; no other stub changes.
- `apps/web/tests/pages/admin-fleet-repos.spec.ts` — mountRepos passes a useGlobalPermissions stub in its globals (granting fleet.repo.review.configure unless a test overrides it) and adds FleetRepoAutoReview to its fleetComponents; its repo fixtures gain the six auto-review fields with autoReview false; existing assertions stay unchanged.

### Seams

- `FleetReposService.configureAutoReview` (US-002) is called by the route command (US-003). The US-003
  route ACs drive `PATCH /api/fleet/repos/:id/auto-review` and read the stored repo.
- `FleetReposService.disableAutoReview` (US-005) is called by `EnablerGate.check` (US-008), whose ACs stub it
  and call `check`.
- `IFleetPrReviewRepository` (US-005) is used by `ReviewHeadDispatcher` (US-006, US-007) and by
  `EnablerGate` (US-008), whose ACs use an in-memory fake of the interface.
- `FleetReposService.listAutoReviewRepos` (US-001), `GitHubAppClient.listOpenPullRequests` (US-004),
  `ReviewHeadDispatcher.dispatchRepo` (US-006) and `EnablerGate.check` (US-008) are called by
  `FleetPrReviewPass.run` (US-009). Its ACs stub them and call `run`.
- `FleetPrReviewPass.run` (US-009) is called by `FleetPrReviewPoller.poll()` (US-010), the timer's entry
  point. The US-010 ACs stub `run` and trigger `poll()`.
- `PATCH /fleet/repos/:id/auto-review` (US-003) is called by `useFleetRepos().setAutoReview` (US-011).

## Acceptance Criteria

### US-001: API auto-review columns, repo listing and config

- `[integration]` a repo created through `IFleetRepoRepository.create` reads back with `autoReview` false.
- `[integration]` a repo created through `IFleetRepoRepository.create` reads back with `autoReviewProfiles` `[]` and `autoReviewMaxCostUsd` `'1.0000'`.
- `[unit]` `FleetRepoDto.from` of a record with `autoReviewEnabledAt` `2026-11-01T00:00:00.000Z` returns `autoReviewEnabledAt` `'2026-11-01T00:00:00.000Z'`.
- `[unit]` `FleetRepoDto.from` of a record with `autoReviewMaxCostUsd` `'2.5'` returns `autoReviewMaxCostUsd` `'2.5000'`.
- `[unit]` `FleetRepoDto.from` copies `autoReview`, `autoReviewProfiles`, `autoReviewEnabledById` and `autoReviewEnabledByType` from the record.
- `[integration]` `findAutoReviewPage(50)` returns a repo with `autoReview` true, provider `github` and an installation id.
- `[integration]` `findAutoReviewPage(50)` omits an enabled repo whose project has `deletedAt` set.
- `[integration]` `findAutoReviewPage(50)` omits a repo with `autoReview` false.
- `[integration]` `findAutoReviewPage(50)` omits an enabled repo whose `githubInstallationId` is null.
- `[integration]` `findAutoReviewPage(2)` over three enabled repos returns the two with the lowest ids, in id order.
- `[unit]` `FleetReposService.listAutoReviewRepos(50)` returns what `findAutoReviewPage(50)` returns.
- `[unit]` resolving the fleet config with `FLEET_PR_REVIEW_ENABLED`, `FLEET_PR_REVIEW_POLL_MS` and `FLEET_PR_REVIEW_MAX_DISPATCH` unset gives `prReviewEnabled` true, `prReviewPollMs` 300000 and `prReviewMaxDispatch` 10.
- `[unit]` resolving the fleet config with `FLEET_PR_REVIEW_ENABLED=FALSE` gives `prReviewEnabled` false.
- `[unit]` env validation refuses `FLEET_PR_REVIEW_POLL_MS=59999`.
- `[unit]` env validation refuses `FLEET_PR_REVIEW_MAX_DISPATCH=0`.

### US-002: API auto-review settings rules

- `[unit]` `configureAutoReview` by user principal `u1` with `{ enabled: true, profiles: ['native-ds'], maxCostUsd: 2.5 }` on a GitHub repo with an installation id calls `updateAutoReview` with `autoReview` true and `autoReviewProfiles` `['native-ds']`.
- `[unit]` that call stores `autoReviewEnabledById` `u1` and `autoReviewEnabledByType` `USER`.
- `[unit]` `configureAutoReview` by agent principal `a1` stores `autoReviewEnabledByType` `AGENT`.
- `[unit]` `configureAutoReview` with `enabled: true` on a repo whose `autoReview` was false sets `autoReviewEnabledAt` to the current time.
- `[unit]` `configureAutoReview` with `enabled: true` on a repo already enabled at `2026-11-01T00:00:00Z` keeps `autoReviewEnabledAt` at that time.
- `[unit]` `configureAutoReview` with `{ enabled: true }` and no `profiles` or `maxCostUsd` keeps the stored `autoReviewProfiles` and `autoReviewMaxCostUsd`.
- `[unit]` `configureAutoReview` with `{ enabled: false, profiles: ['x'] }` stores `autoReview` false with `autoReviewEnabledById`, `autoReviewEnabledByType` and `autoReviewEnabledAt` all null.
- `[unit]` `configureAutoReview` with `{ enabled: false, profiles: ['x'] }` does not change `autoReviewProfiles`.
- `[unit]` `configureAutoReview` with `enabled: true` on a GitLab repo throws `AutoReviewException` with status 422 and reason `github app required`.
- `[unit]` `configureAutoReview` with `enabled: true` on a GitHub repo whose `githubInstallationId` is null throws reason `github app required`.
- `[unit]` `configureAutoReview` with `profiles: ['koda-job-x']` throws reason `profiles`.
- `[unit]` `configureAutoReview` with `profiles: ['a', 'a']` throws reason `duplicate profile`.
- `[unit]` `configureAutoReview` with `enabled: true` by a caller for whom `canHoldKey(<caller>, 'fleet.job.dispatch', { projectId })` is false throws reason `caller cannot dispatch in this project`.
- `[unit]` `configureAutoReview` for an unknown id throws `NotFoundAppException` with key `fleet.repos`.
- `[unit]` `configureAutoReview` records an audit entry with key `fleet.repo.review.configure` and the repo id inside the same `txManager.run` as `updateAutoReview`.

### US-003: API auto-review route and permission key

- `[integration]` `PATCH /api/fleet/repos/:id/auto-review` as a global admin with `{ enabled: true, profiles: ['native-ds'], maxCostUsd: 2.5 }` answers 200 with `autoReview` true and `autoReviewMaxCostUsd` `'2.5000'`.
- `[integration]` that 200 reply has `autoReviewEnabledById` equal to the admin's id.
- `[integration]` `PATCH /api/fleet/repos/:id/auto-review` with `{ enabled: false }` answers 200 with `autoReview` false and `autoReviewEnabledAt` null.
- `[integration]` `PATCH /api/fleet/repos/:id/auto-review` as a user without `fleet.repo.review.configure` answers 403.
- `[integration]` `PATCH /api/fleet/repos/:id/auto-review` with `{ enabled: true }` for a GitLab repo answers 422 with a message containing `github app required`.
- `[integration]` `PATCH /api/fleet/repos/:id/auto-review` for an unknown id answers 404.
- `[integration]` `PATCH /api/fleet/repos/:id/auto-review` with `{ enabled: 'yes' }` answers 400.
- `[integration]` `PATCH /api/fleet/repos/:id/auto-review` by an agent principal, whose role binding grants `fleet.job.dispatch` in the repo's project, under a policy that requires human approval for `fleet.repo.review.configure`, answers 202, and the repo's `autoReview` stays false.
- `[integration]` approving that pending request turns `autoReview` on with `autoReviewEnabledByType` `AGENT` and `autoReviewEnabledById` equal to the agent's id.
- `[integration]` `GET /api/fleet/repos` returns each repo with the field `autoReviewEnabledAt`.
- `[unit]` `findCatalogEntry('fleet.repo.review.configure')` returns an entry with scope `global` and access `role`.
- `[unit]` `findCatalogEntry('fleet.repo.review.configure')` returns an entry whose `approval.approvable` is true.

### US-004: API open-PR listing through the App

- `[unit]` `listOpenPullRequests('tok', 'o', 'n')` against `startFakeForge()` sends a request with method `GET`, path `/repos/o/n/pulls` and query `state=open&per_page=100`.
- `[unit]` that request carries the authorization header `Bearer tok`.
- `[unit]` `listOpenPullRequests` maps a reply item `{ number: 7, draft: false, updated_at: '2026-11-02T00:00:00Z', head: { sha: 'aaa', repo: { full_name: 'o/n' } } }` to `{ number: 7, headSha: 'aaa', draft: false, headRepoFullName: 'o/n', updatedAt: new Date('2026-11-02T00:00:00Z') }`.
- `[unit]` `listOpenPullRequests` maps an item whose `head.repo` is null to `headRepoFullName` null.
- `[unit]` `listOpenPullRequests` throws `RepoCheckException` with reason `provider_error` on a 500 reply.
- `[unit]` `listOpenPullRequests` throws `RepoCheckException` with reason `provider_error` when the reply body is an object instead of an array.
- `[unit]` `listOpenPullRequests` throws `RepoCheckException` with reason `provider_error` for an item without `head.sha`.
- `[unit]` `listOpenPullRequests` given a reply of 100 items logs a warning naming `o/n`, and given 99 items logs none.

### US-005: API review-head table and automatic turn-off

- `[integration]` `insertPending(repoId, 7, 'aaa')` returns a record with `outcome` `pending` and `jobId` null.
- `[integration]` a second `insertPending(repoId, 7, 'aaa')` returns null and leaves one row.
- `[integration]` `markDispatched(id, 'j1')` then `findHead(repoId, 7, 'aaa')` returns `outcome` `dispatched` and `jobId` `j1`.
- `[integration]` `markFailed(id, 'failed:profiles')` then `findHead` returns `outcome` `failed:profiles`.
- `[integration]` `remove(id)` then `findHead(repoId, 7, 'aaa')` returns null.
- `[integration]` deleting the `FleetRepo` deletes its `FleetPrReview` rows.
- `[integration]` `findPrincipalAccess({ type: 'USER', id })` for a user with `disabled` true returns `{ exists: true, disabled: true }`.
- `[integration]` `findPrincipalAccess({ type: 'USER', id: 'missing' })` returns `{ exists: false, disabled: false }`.
- `[integration]` `findPrincipalAccess({ type: 'AGENT', id })` for an existing agent returns `{ exists: true, disabled: false }`.
- `[integration]` `disableAutoReviewIf(id, 'u1')` on a repo enabled by `u1` returns true and leaves `autoReview` false.
- `[integration]` `disableAutoReviewIf(id, 'u1')` on a repo enabled by `u2` returns false and leaves `autoReview` true.
- `[unit]` `disableAutoReview('r1', 'enabler_lost_access', 'u1')` when `disableAutoReviewIf` returns true records an audit entry with key `system.pr-review.dispatch` and summary `auto-review disabled: enabler_lost_access`.
- `[unit]` `disableAutoReview` returns what `disableAutoReviewIf` returns.
- `[unit]` `disableAutoReview` when `disableAutoReviewIf` returns false records no audit entry.

### US-006: API review-head dispatcher, selection and recovery

- `[unit]` `dispatchRepo` for repo `o/n` enabled by `u1` at `2026-11-01T00:00:00Z`, with PR 7 at head `aaa` updated `2026-11-02T00:00:00Z` and no row, calls `FleetJobsService.dispatch` once with `u1`, the repo's project id, `{ command: 'REVIEW', repoId, prNumber: 7, profiles: <autoReviewProfiles>, maxCostUsd: 1 }` and `{ auditKey: 'system.pr-review.dispatch' }`.
- `[unit]` after that dispatch returns job id `j1`, the head's row has `outcome` `dispatched` and `jobId` `j1`, and `dispatchRepo` returns 1.
- `[unit]` `dispatchRepo` with a `dispatched` row for PR 7 head `aaa` does not call `dispatch`.
- `[unit]` `dispatchRepo` with a `dispatched` row for PR 7 head `aaa` and the PR now at head `bbb` calls `dispatch` once, for PR 7.
- `[unit]` `dispatchRepo` with a `failed:profiles` row for the head does not call `dispatch`.
- `[unit]` `dispatchRepo` does not call `dispatch` for a PR with `draft` true.
- `[unit]` `dispatchRepo` does not call `dispatch` for a PR whose `headRepoFullName` is `fork/n` or null.
- `[unit]` `dispatchRepo` calls `dispatch` for a PR whose `headRepoFullName` is `O/N` on repo `o/n`.
- `[unit]` `dispatchRepo` does not call `dispatch` for a PR whose `updatedAt` is before the repo's `autoReviewEnabledAt`.
- `[unit]` with a `pending` row for the head created 10 minutes before `now` and `pollMs` 300000, `dispatchRepo` removes that row and calls `dispatch`.
- `[unit]` with a `pending` row for the head created 1 minute before `now` and `pollMs` 300000, `dispatchRepo` does not call `dispatch`.
- `[unit]` `dispatchRepo` with three new PR heads, PRs 9, 3 and 5, and `remaining` 2 calls `dispatch` for PRs 3 and 5 only, and returns 2.
- `[unit]` when `insertPending` returns null, `dispatchRepo` does not call `dispatch`.
- `[unit]` every `FleetPrReview` write made by `dispatchRepo` runs inside `bookkeeping` with reason `fleet.pr-review-bookkeeping`.

### US-007: API review-head dispatcher, failure outcomes

- `[unit]` when `dispatch` throws `ConflictAppException({ activeJobId: 'j0' }, 'fleet.jobs')`, `dispatchRepo` removes the head's row.
- `[unit]` after that removal, a following `dispatchRepo` with the same PR head calls `dispatch` again.
- `[unit]` when `dispatch` throws `BudgetPausedException` for PR 3, `dispatchRepo` removes PR 3's row.
- `[unit]` when `dispatch` throws `BudgetPausedException` for PR 3, `dispatchRepo` makes no `dispatch` call for PR 5 in the same call, and returns 1.
- `[unit]` when `dispatch` throws `ValidationAppException({ reason: 'profiles' }, 'fleet.dispatchInput')`, the head's row is marked `failed:profiles`.
- `[unit]` after that, a following `dispatchRepo` with the same PR head does not call `dispatch`.
- `[unit]` when `dispatch` throws `ValidationAppException({}, 'fleet.dispatchInput')`, the row is marked `failed:ValidationAppException`.
- `[unit]` when `dispatch` throws `NotFoundAppException({}, 'fleet.repos')`, the row is marked `failed:NotFoundAppException`.
- `[unit]` when `dispatch` throws `FleetDispatchException`, the row is marked `failed:FleetDispatchException`.
- `[unit]` when `dispatch` throws `ValidationAppException` with a 300-character reason, the stored outcome is 200 characters long.
- `[unit]` when `dispatch` throws `Error('boom')`, `dispatchRepo` removes the row and resolves.
- `[unit]` when `dispatch` throws `Error('boom')` for PR 7, `dispatchRepo` logs a warning naming the repo id, PR 7 and `Error`.
- `[unit]` with two new heads and `remaining` 2, when the first `dispatch` throws `ConflictAppException`, `dispatchRepo` still calls `dispatch` for the second head and returns 2.

### US-008: API enabler gate

- `[unit]` `EnablerGate.check` for a repo enabled by USER `u1`, where `findPrincipalAccess` reports `{ exists: true, disabled: false }` and `effectiveKeys(u1, { projectId })` has `fleet.job.dispatch`, returns `{ type: 'USER', id: 'u1' }`.
- `[unit]` `EnablerGate.check` reads `effectiveKeys` with the repo's `projectId`.
- `[unit]` `EnablerGate.check` for a repo enabled by AGENT `a1` that holds the key returns `{ type: 'AGENT', id: 'a1' }`.
- `[unit]` when the enabler's effective keys lack `fleet.job.dispatch`, `EnablerGate.check` returns null.
- `[unit]` in that case `EnablerGate.check` calls `disableAutoReview(repoId, 'enabler_lost_access', 'u1')`.
- `[unit]` when `findPrincipalAccess` reports `{ exists: true, disabled: true }`, `EnablerGate.check` returns null and calls `disableAutoReview` with reason `enabler_lost_access`.
- `[unit]` when `findPrincipalAccess` reports `{ exists: false, disabled: false }`, `EnablerGate.check` returns null and calls `disableAutoReview`.

### US-009: API PR review pass and module

- `[unit]` `FleetPrReviewPass.run` calls `listAutoReviewRepos` with 50.
- `[unit]` `run` with one auto-review repo whose `EnablerGate.check` returns `{ type: 'USER', id: 'u1' }` calls `mintInstallationToken` with the repo's installation id and name.
- `[unit]` in that `run`, `listOpenPullRequests` is called with the minted token, the repo's owner and its name.
- `[unit]` in that `run`, `ReviewHeadDispatcher.dispatchRepo` is called with the repo, the listed PRs and `remaining` 10.
- `[unit]` the `dispatchRepo` call runs in an action context whose actor is `{ type: 'SYSTEM', id: 'pr-review' }`.
- `[unit]` the `dispatchRepo` call runs in an action context whose `onBehalfOf` is `{ type: 'USER', id: 'u1' }`.
- `[unit]` when the first repo's `dispatchRepo` returns 7 and `prReviewMaxDispatch` is 10, the second repo's `dispatchRepo` receives `remaining` 3.
- `[unit]` when `dispatchRepo` returns 10 for the first repo, `run` does not call `EnablerGate.check` for the second repo.
- `[unit]` when `EnablerGate.check` returns null, `run` does not mint a token for that repo.
- `[unit]` when `listOpenPullRequests` throws for the first of two repos, `run` still calls `dispatchRepo` for the second repo.
- `[unit]` in that case `run` logs a warning naming the first repo's id.
- `[unit]` when `EnablerGate.check` rejects for the first of two repos, `run` still calls `dispatchRepo` for the second repo.
- `[unit]` compiling `FleetReviewsModule` with mocked external collaborators resolves `FleetPrReviewPass`.
- `[unit]` the module metadata of `FleetModule` imports `FleetReviewsModule`.
- `[unit]` the module metadata of `FleetReposModule` exports `FleetReposService`.

### US-010: API PR review poller lifecycle

- `[unit]` `poll()` calls `FleetPrReviewPass.run` once with a `Date`.
- `[unit]` a `poll()` started while another `poll()` is unresolved returns without calling `run`.
- `[unit]` when `run` rejects, `poll()` resolves and logs an error.
- `[unit]` `onModuleInit` with `sweepEnabled` true and `prReviewEnabled` true starts an interval of `prReviewPollMs` that calls `poll()`.
- `[unit]` `onModuleDestroy` clears that interval.
- `[unit]` `onModuleInit` with `prReviewEnabled` false starts no interval.
- `[unit]` `onModuleInit` with `sweepEnabled` false starts no interval.
- `[unit]` compiling `FleetReviewsModule` with mocked external collaborators resolves `FleetPrReviewPoller`.

### US-011: Web auto-review switch

- `[unit]` `/admin/fleet/repos` renders a `FleetRepoAutoReview` switch for a GitHub repo with a `githubInstallationId`.
- `[unit]` `/admin/fleet/repos` renders no `FleetRepoAutoReview` for a GitLab repo.
- `[unit]` `/admin/fleet/repos` renders the auto-review switch disabled when `useGlobalPermissions()` lacks `fleet.repo.review.configure`.
- `[unit]` `FleetRepoAutoReview` for a repo with `autoReview` true renders the switch on and lists its profiles.
- `[unit]` saving the `FleetRepoAutoReview` dialog with profiles `native-ds, review` and max cost `2.5` calls `$api.patch` with path `/fleet/repos/<id>/auto-review` and body `{ enabled: true, profiles: ['native-ds', 'review'], maxCostUsd: 2.5 }`.
- `[unit]` the `FleetRepoAutoReview` dialog with max cost `0` does not call `$api.patch` and shows the `fleet.repos.autoReview.maxCostInvalid` message.
- `[unit]` choosing the edit button of an enabled repo opens the dialog prefilled with its profiles and max cost.
- `[unit]` turning an enabled switch off calls `$api.patch` with path `/fleet/repos/<id>/auto-review` and body `{ enabled: false }`.
- `[unit]` `setAutoReview` returns `{ kind: 'pending', request }` when the API data has a `permissionKey`.
- `[unit]` `setAutoReview` returns `{ kind: 'saved', repo }` when the API data is a repo.
- `[unit]` after a `pending` result, `FleetRepoAutoReview` keeps the switch in its previous state and shows the `fleet.repos.autoReview.pending` notice.
- `[unit]` when `$api.patch` rejects with a 422 `ApiError`, `FleetRepoAutoReview` shows the message from `extractApiError`.
- `[unit]` the English and Chinese locale files both define every `fleet.repos.autoReview.*` key.
