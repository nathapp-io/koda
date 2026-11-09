# SPEC: Fleet flow page

## Summary

A fleet flow has no web page. Its state, steps, jobs, PRs, cost and questions are visible only through the API
and the database. This feature adds the flow page the fleet flow design names in G8 and "Status page":
`/:project/flows/:flowId` shows the features in order with their state, current step, branch, PR link and jobs;
the cost spent against the cap, with the count of jobs whose cost is unknown; the approval record; the stop reason
and its ticket; open questions with an answer form; and a Stop button. A project flows list at `/:project/flows`,
a Flows link in the project nav, and a flows panel on the thread page link to it. The API gains the fields the
page needs: the stop detail and each feature's branch on the flow, a thread filter on the flow list, and one new
read route for the flow's repo, ticket ref and jobs.

## Motivation

The design (`docs/superpowers/specs/2026-11-04-fleet-flow-design.md`, G8 and "Status page") calls for a page that
shows each feature's current step, its jobs, its PR and the cost against the cap. F1-F5 built and verified the
engine; live flows 13 and 14 were followed with SQL, `gh` and a polling script, because nothing in the web app
shows a flow. The flow DTO already carries a `url` field that names this page (`fleet-flow.dto.ts`, "the web path
F6 renders"), and the web app has no route for it. A flow that stops or asks a question notifies the user, but the
notification has nowhere to send them.

## Design

### Calls made while drafting (not user rulings)

The user skipped the brainstorm for this feature (2026-11-09). Every choice below is the drafter's call, from the
fleet flow design and the existing web patterns.

- **Scope is reading and acting on an existing flow.** The thread's Start flow form and its per-thread auto-approve
  tickbox (design G2 thread entry, G4) are a separate feature; neither exists in the web app today.
- **The flow DTO gains only fields its record already carries:** `stopDetail` on the flow and `branch` on each
  feature. `FleetFlowRecord` and the flow repository's include are unchanged.
- **The thread filter** adds `threadId` to the `findPage` filters only when it is set
  (`{ projectId, ...(threadId ? { threadId } : {}) }`), so a list call without it passes the same filters as today.
- **One new read route, `GET /api/projects/:slug/flows/:flowId/overview`** (`fleet.flow.read`), answers what the
  record does not hold: the repo identity, the flow ticket's ref, the flow's jobs, and the unknown-cost count. It
  lives in a new `ProjectFlowOverviewController` (`@Controller('projects/:slug/flows')`) and a new
  `FleetFlowOverviewService`, so the constructors of `ProjectFlowsController` and `FleetFlowsService` do not
  change. Both are registered in `flows.module.ts`.
- **Cross-module reads go through services** (`.nax/rules/api-data.md`): the repo identity through a new
  `FleetReposService.findIdentity(id)`, the ticket ref through the existing `TicketsService.findRefsByIds`
  (`TicketsModule` is already imported by the flows module). The flow's jobs are read by the flow step repository,
  which already reads the flow's `FleetJob` rows (`latestJob`, `latestJobForStep`); the new
  `listFlowJobs(flowId, limit)` follows that precedent. `FleetJob.flowFeatureId` has no Prisma relation, so the
  feature name comes from the flow's own features (id to name map), not from a join.
- **Unknown cost** follows the design ("`AGENT`, `PLAN`, `REVIEW` and `FIX` jobs may report no cost"): a job whose
  `command` is `AGENT`, `PLAN`, `REVIEW` or `FIX`, whose state is in `TERMINAL_STATES`, and whose
  `costSpentUsd + costCarriedUsd` is zero. The page text is `cap excludes N jobs with unknown cost`.
- **Jobs are capped at the newest 500** (by `queuedAt` then `id`), returned oldest first, with `truncated: true`
  when the flow has more. The live flows have 12 jobs. The unknown-cost count covers the returned jobs.
- **PR links are built in the web app** from the overview's repo: `https://github.com/<owner>/<name>/pull/<n>`
  when `provider` is `github`; any other provider, or no overview, shows `#<n>` without a link.
- **A feature's branch** is `feature.branch` when set, else the flow's `branch` (feature 1 keeps the flow branch).
- **Flow jobs.** Jobs with no feature are shown in a "Flow jobs" section after the features, only when there are
  any. `jobsByFeature` returns an entry (possibly empty) for every feature.
- **Live updates by polling** use the existing `useVisiblePolling(task, 15_000)` (`composables/useVisiblePolling.ts`:
  one run at a time, a rejected run does not stop it, it pauses while the tab is hidden). The page starts it after the
  first successful load and calls `stop()` when the flow is no longer live or the page unmounts. The page re-reads the flow and its overview every 15 s while the flow is live
  (`PENDING`, `APPROVED`, `RUNNING`, `WAITING_MERGE`, `WAITING_ANSWER`), and stops polling once it is `COMPLETED`
  or `STOPPED`, when the first load fails, or when the page unmounts. No flow event exists on the project event
  stream, and adding one is out of scope.
- **Stop and Answer go through the existing gated routes.** Either may answer 202 with an approval request
  summary; the page tells the user an approval was requested and links to `/:project/approvals`. The pending check
  is the `useProviderCredentials` pattern (`'permissionKey' in data`).
- **Permissions** are read as `const { permissions } = useProjectPermissions(slug)` and checked with
  `permissions.value.has(key)`: `fleet.flow.stop` for Stop, `fleet.flow.answer` for the answer form,
  `fleet.flow.read` for the thread panel. The project nav's Flows link is not gated (the Threads link is not), and
  the layout gets no new setup bindings.
- **Agent-written text** (questions, `stopDetail`, `stopReason`) renders through interpolation only, never
  `v-html` (`.nax/mono/apps/web/context.md`).
- **States and steps render through literal maps** in `lib/fleet-flows.ts` from the code to an i18n key, with the
  raw code as the fallback for an unknown value: `flowStateKey` (`fleet.flows.state.<code>`: `PENDING`, `APPROVED`,
  `RUNNING`, `WAITING_MERGE`, `WAITING_ANSWER`, `COMPLETED`, `STOPPED`), `featureStateKey`
  (`fleet.flows.featureState.<code>`: `PENDING`, `RUNNING`, `WAITING_ANSWER`, `READY`, `MERGED`, `COMPLETED`,
  `STOPPED`) and `flowStepKey` (`fleet.flows.step.<code>`: `SPEC_REVIEW`, `PLAN`, `PRD_REVIEW`, `RUN`, `REVIEW`,
  `RULE`, `FIX`). The three groups are registered in the locale parity spec's `ENUMS`.
- **Web test harness:** pages and the panel import `useFleetFlows` explicitly
  (`import { useFleetFlows } from '~/composables/useFleetFlows'`), as `schedules/[id].vue` imports its
  composables, because `tests/helpers/mount-sfc.ts` injects only the Nuxt auto-imports it lists. Tests mock the
  composable by module path. `window.confirm` is stubbed on `globalThis.window`, as in the admin roles page tests.

### Integration

Read only (verified 2026-11-09 at `bd42963b`):

- `apps/api/src/fleet/flows/project-flows.controller.ts`: `ProjectFlowsController`, `@Controller('projects/:slug/flows')`,
  guards `ProjectMembershipGuard, RequiresGuard`; `get`, `stop` (`fleet.flow.stop`, 200 or 202) and `answer`
  (`fleet.flow.answer`, body `{ jobId, answers: [{ id, answer }] }`, 200 or 202, 409 `fleet.flows.notWaiting` /
  `fleet.flows.answersStale`).
- `apps/api/src/fleet/flows/fleet-flows.service.ts`: `FleetFlowsService.get(projectId, id): Promise<FleetFlowRecord>`
  (404 `fleet.flows.notFound` when the flow is in another project).
- `apps/api/src/fleet/flows/domain/fleet-flow.domain.ts`: `FleetFlowRecord` (`repoId`, `ticketId`, `stopDetail?`,
  `features`), `FleetFlowFeatureRecord` (`id`, `feature`, `branch?`).
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts`: `PrismaFleetFlowStepRepository` (`latestJob`
  reads `this.db.fleetJob`), behind `FLEET_FLOW_STEP_REPOSITORY`.
- `apps/api/src/fleet/repos/fleet-repos.service.ts`: `FleetReposService` (`findReviewRepo(id)` precedent).
- `apps/api/src/tickets/tickets.service.ts`: `TicketsService.findRefsByIds(projectId, ids): Promise<Map<string, string>>`.
- `apps/api/src/fleet/jobs/job-state.ts`: `TERMINAL_STATES`.
- `apps/web/composables/useApi.ts`: `useApi()` (`$api.get/post`), `extractApiError`, `ApiError` (`code`).
- `apps/web/composables/usePermissions.ts`: `useProjectPermissions(slug)` returns `{ permissions }`, a computed
  `PermissionSet` with `has(key)`.
- `apps/web/composables/useProjectMemberNames.ts`: `useProjectMemberNames(slug)` returns `{ members, load, nameOf }`.
- `apps/web/lib/fleet-jobs.ts`: `formatUsd(decimal)`.
- `apps/web/lib/approval-requests.ts`: `ApprovalRequestSummary`.
- `apps/web/tests/layouts/threads-nav.spec.ts`: `renderProjectLayout` and `breadcrumbItemsFor` test patterns.

Changed. The baseline only locates the code; implement the target.

- `FleetFlowDto` (`apps/api/src/fleet/flows/dto/fleet-flow.dto.ts`)
  - Baseline: no `stopDetail` field.
  - Target: `stopDetail: string | null` (`@ApiPropertyOptional({ type: String, nullable: true })`), from
    `record.stopDetail ?? null`.
- `FleetFlowFeatureDto` (same file)
  - Baseline: no `branch` field.
  - Target: `branch: string | null`, from `feature.branch ?? null`.
- `ProjectFlowsController.list`
  - Baseline: `list(rawQuery: KodaPageQuery, ctx)` calls `this.flows.list(ctx.project.id, { current, size })`.
  - Target: `list(rawQuery: ListFleetFlowsQuery, ctx)`; `ListFleetFlowsQuery extends KodaPageQuery` adds
    `threadId?: string` (`@IsOptional() @IsString() @MaxLength(64)`). It parses with
    `parseQuery(ListFleetFlowsQuery, rawQuery)` (which drops undeclared keys, so the class must be the new one) and
    calls `this.flows.list(ctx.project.id, { current, size }, { threadId })` with the parsed `threadId`.
- `FleetFlowsService.list`
  - Baseline: `list(projectId, page)` calls `this.flows.findPage({ projectId }, page)`.
  - Target: `list(projectId, page, filters: { threadId?: string } = {})` calls
    `this.flows.findPage({ projectId, ...(filters.threadId ? { threadId: filters.threadId } : {}) }, page)`.
- `PrismaFleetFlowRepository.findPage` and `IFleetFlowRepository.findPage`
  - Baseline: `findPage(filters: { projectId: string }, page)`.
  - Target: `findPage(filters: { projectId: string; threadId?: string }, page)`; when `threadId` is set the
    `where` adds `threadId`.

New:

```ts
// apps/api/src/fleet/repos/fleet-repos.service.ts
findIdentity(id: string): Promise<{ provider: string; owner: string; name: string } | null>

// apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts (IFleetFlowStepRepository) + Prisma implementation
listFlowJobs(flowId: string, limit: number): Promise<{ jobs: FlowJobRow[]; truncated: boolean }>
interface FlowJobRow {
  id: string; flowFeatureId: string | null; flowStep: string | null; command: string; state: string;
  costSpentUsd: string; costCarriedUsd: string; queuedAt: Date; finishedAt: Date | null;
}

// apps/api/src/fleet/flows/flow-overview.ts (pure)
export const UNKNOWN_COST_COMMANDS: readonly string[]   // AGENT PLAN REVIEW FIX
export function totalCostUsd(row: FlowJobRow): string    // costSpentUsd + costCarriedUsd, 4 decimals
export function countUnknownCost(rows: FlowJobRow[]): number

// apps/api/src/fleet/flows/fleet-flow-overview.service.ts
class FleetFlowOverviewService {
  overview(projectId: string, flowId: string): Promise<FleetFlowOverviewDto>
}

// apps/api/src/fleet/flows/project-flow-overview.controller.ts
@Controller('projects/:slug/flows') class ProjectFlowOverviewController {
  @Get(':flowId/overview') @Requires('fleet.flow.read') overview(flowId, ctx)
}

// apps/api/src/fleet/flows/dto/fleet-flow-overview.dto.ts
class FleetFlowOverviewDto {
  repo: { provider: string; owner: string; name: string } | null;  // null when the repo row is gone
  ticketRef: string | null;        // from TicketsService.findRefsByIds, null when the flow has no ticket
  jobs: FleetFlowJobDto[];         // newest 500 by queuedAt then id, returned oldest first
  truncated: boolean;
  unknownCostCount: number;
}
class FleetFlowJobDto {
  id: string;
  feature: string | null;          // the flow feature's name for flowFeatureId, null when flowFeatureId is null
  step: string | null;             // flowStep
  command: string;
  state: string;
  costUsd: string;                 // totalCostUsd
  queuedAt: string;                // ISO
  finishedAt: string | null;       // ISO
}
```

Web (new):

```ts
// apps/web/lib/fleet-flows.ts
export const LIVE_FLOW_STATES: readonly string[]      // PENDING APPROVED RUNNING WAITING_MERGE WAITING_ANSWER
export function isLiveFlow(state: string): boolean
export function flowStateKey(state: string): string | null   // literal map to fleet.flows.state.<code>, null if unknown
export function featureBranch(flow: FleetFlowDto, feature: FleetFlowFeatureDto): string
export function prUrl(repo: FlowRepo | null, prNumber: number | null): string | null
export function jobsByFeature(jobs: FleetFlowJobDto[], features: FleetFlowFeatureDto[]): { byFeature: Map<string, FleetFlowJobDto[]>; flowJobs: FleetFlowJobDto[] }
export function openQuestions(feature: FleetFlowFeatureDto): FleetFlowQuestionDto[]
export function isPendingFlowAnswer(data: unknown): data is ApprovalRequestSummary

// apps/web/composables/useFleetFlows.ts
export type FlowWrite = { kind: 'done'; flow: FleetFlowDto } | { kind: 'pending'; request: ApprovalRequestSummary }
export function useFleetFlows(slug: string): {
  list(page: number, threadId?: string): Promise<FleetFlowPage>
  get(flowId: string): Promise<FleetFlowDto>
  overview(flowId: string): Promise<FleetFlowOverviewDto>
  stop(flowId: string): Promise<FlowWrite>
  answer(flowId: string, jobId: string, answers: { id: string; answer: string }[]): Promise<FlowWrite>
}
```

`FlowFeatureSection` props: `slug`, `flow` (the flow DTO), `feature`, `repo` (the overview repo or null), `jobs`
(that feature's jobs), `canAnswer` (the page's `permissions.value.has('fleet.flow.answer')`); it emits `answered`,
re-emitted by its `FlowAnswerForm`. The page evaluates permissions; the section does not call `useProjectPermissions`.

`ProjectFlowOverviewController` carries the same class decorators as `ProjectFlowsController`: `@ApiTags('fleet')`,
`@ApiBearerAuth()`, `@ApiParam({ name: 'slug' })`, `@UseGuards(ProjectMembershipGuard, RequiresGuard)`; the route has
`@ApiOperation` and `@ApiResponse` for 200 (`FleetFlowOverviewDto`), 403 and 404. Every DTO field has `@ApiProperty`.

Pages and components: `apps/web/pages/[project]/flows/index.vue`, `apps/web/pages/[project]/flows/[id].vue`,
`apps/web/components/fleet/flows/FlowFeatureSection.vue`, `apps/web/components/fleet/flows/FlowAnswerForm.vue`,
`apps/web/components/fleet/threads/ThreadFlowsPanel.vue`.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| Overview for a flow in another project | 404 `fleet.flows.notFound` (the `get` fence) |
| `threadId` query longer than 64 characters | 400 from query validation |
| First flow GET answers 404 | the page shows `fleet.flows.detail.notFound` and does not poll |
| First flow GET fails otherwise | the page shows `fleet.flows.detail.loadFailed` and does not poll |
| Overview GET fails while the flow GET succeeds | the page shows the flow; the features show PR numbers without links and the `fleet.flows.detail.jobsFailed` text |
| A poll fails | the page keeps the data it shows and polls again at the next tick |
| Stop or Answer refused (403, 404, 409) | error toast `extractApiError(err)`, then reload the flow |
| Stop or Answer answers 202 | toast `fleet.flows.toast.approvalRequested` with a link to `/:project/approvals`, then reload the flow |
| Thread panel list fails (403 or other) | the panel renders nothing and shows no toast |

## Out of Scope

- The thread's Start flow form and the per-thread auto-approve tickbox (design G2 thread entry and G4) are a separate feature; this feature adds no flow-creating UI.
- Cloning a stopped flow into a new pending flow is not built here.
- A flow event on the project event stream (SSE); the flow page polls every 15 s instead.
- Approving or rejecting the flow's start request on the flow page; the page links to the existing approvals page.
- PR links for providers other than GitHub; a non-GitHub repo shows the PR number without a link.
- Paging the overview's jobs beyond the newest 500; the overview reports `truncated` instead.
- CLI commands for flows.
- Changing any flow step, state transition or stop rule in the API.
- An admin (cross-project) flows page.
- US-009 only: the human-only rule for answers is enforced by the API (`fleet.flows.answerHumanOnly`); the form adds no client-side actor check.

## Stories

### US-001: Flow DTO fields and the thread filter

No dependencies. Workdir: `apps/api`.

`FleetFlowDto` gains `stopDetail` and `FleetFlowFeatureDto` gains `branch`. `GET /api/projects/:slug/flows` takes
an optional `threadId` query (`ListFleetFlowsQuery`), passed through `FleetFlowsService.list` to `findPage`, which
filters on it when set. The endpoint e2e flows block gains a `threadId` case that seeds a thread-linked flow with the
file's `newThread` helper. `openapi.json` is regenerated with
`bun run api:export-spec`.

### US-002: Overview reads

Depends on US-001. Workdir: `apps/api`.

`FleetReposService.findIdentity(id)` returns the repo's `provider`, `owner` and `name`.
`PrismaFleetFlowStepRepository.listFlowJobs(flowId, limit)` (and `IFleetFlowStepRepository`) returns the flow's
newest `limit` jobs, oldest first, and `truncated`. The pure `flow-overview.ts` computes `totalCostUsd` and
`countUnknownCost`.

### US-003: Overview route

Depends on US-002. Workdir: `apps/api`.

`FleetFlowOverviewService.overview(projectId, flowId)` fences the flow with `FleetFlowsService.get`, then builds
`FleetFlowOverviewDto` from `findIdentity`, `findRefsByIds` and `listFlowJobs(flowId, 500)`, naming each job's
feature from the flow's features. `ProjectFlowOverviewController` serves
`GET /api/projects/:slug/flows/:flowId/overview`. Both are registered in `flows.module.ts`; the endpoint e2e file
gains the route; `openapi.json` is regenerated.

### US-004: Web flow helpers

Depends on US-003. Workdir: `apps/web`.

`lib/fleet-flows.ts` holds the DTO types and the pure helpers named in Design.

### US-005: Web flows composable

Depends on US-004. Workdir: `apps/web`.

`composables/useFleetFlows.ts` wraps the five calls through `useApi()`: `list` (`?current=&size=20`, plus
`threadId` when given), `get`, `overview`, `stop` and `answer`, the last two returning `FlowWrite`.

### US-006: Flow page shell

Depends on US-005. Workdir: `apps/web`.

`pages/[project]/flows/[id].vue` loads the flow and its overview and renders the header: state, entry, branch,
roles, created time, spend against cap with the unknown-cost line, the approval record, and the stop reason, stop
detail and ticket link. It shows not-found and load-failed states. Strings come from `fleet.flows.*` keys in
`en.json` and `zh.json`. Its tests live in `tests/pages/fleet-flow-detail.spec.ts`.

### US-007: Feature sections and jobs

Depends on US-006. Workdir: `apps/web`.

`components/fleet/flows/FlowFeatureSection.vue`, rendered by the flow page once per feature in position order,
shows the feature's name, state, current step, `dependsOn`, branch, PR link and its jobs. The page renders a
"Flow jobs" section for jobs with no feature, when there are any. Section tests live in
`tests/components/flow-feature-section.spec.ts`; page-level tests (ACs 1, 8, 9, 10) are added to
`tests/pages/fleet-flow-detail.spec.ts`, created by US-006.

### US-008: Stop a flow

Depends on US-006. Workdir: `apps/web`.

The flow page gains a Stop button, shown when the viewer has `fleet.flow.stop` and the flow is live, with a
`window.confirm` first. It calls `useFleetFlows.stop`, toasts the outcome and reloads the flow. Its tests live in
`tests/pages/fleet-flow-stop.spec.ts`.

### US-009: Answer a flow's questions

Depends on US-007. Workdir: `apps/web`.

`components/fleet/flows/FlowAnswerForm.vue`, rendered inside a feature section with open questions when the
viewer has `fleet.flow.answer` and the flow is `WAITING_ANSWER`, has one required text field per question
(`vee-validate` + `zod`). Submitting calls `useFleetFlows.answer` with the feature's `questionsJobId`, toasts the
outcome and asks the page to reload the flow. Form tests live in `tests/components/flow-answer-form.spec.ts`; the
section-level ACs 1-3 are added to `tests/components/flow-feature-section.spec.ts` (created by US-007) and AC 10 to
`tests/pages/fleet-flow-detail.spec.ts` (created by US-006).

### US-010: Flows list, nav link and thread panel

Depends on US-005. Workdir: `apps/web`.

`pages/[project]/flows/index.vue` lists the project's flows (newest first, 20 per page, previous and next) with
state, feature names, spend against cap and created time, each linking to its flow page.
`components/fleet/threads/ThreadFlowsPanel.vue`, mounted on
`pages/[project]/threads/[id].vue` and gated on `fleet.flow.read`, lists the thread's flows from
`list(1, threadId)`.

### US-011: Flow page polling

Depends on US-006. Workdir: `apps/web`.

The flow page polls the flow and its overview every 15 s through `useVisiblePolling` while the flow is live, and stops
when a load shows it is no longer live, when the first load failed, or when the page unmounts. Its tests live in
`tests/pages/fleet-flow-polling.spec.ts`.

### US-012: Breadcrumbs and Flows nav link

Depends on US-006. Workdir: `apps/web`.

The default layout's breadcrumbs gain the flows list (`Flows`) and the flow page (`Flows`, then the
`fleet.flows.detail.title` label), and the project nav gains an ungated Flows link after Threads, with no new setup
bindings. Its tests live in `tests/layouts/flows-nav.spec.ts`, following `renderProjectLayout` and
`breadcrumbItemsFor` in `tests/layouts/threads-nav.spec.ts`.

### Context Files

**US-001**
- `apps/api/src/fleet/flows/dto/fleet-flow.dto.ts`
- `apps/api/src/fleet/flows/project-flows.controller.ts`
- `apps/api/src/fleet/flows/fleet-flows.service.ts`
- `apps/api/src/fleet/flows/prisma-fleet-flow.repository.ts`
- `apps/api/src/common/dto/koda-page.query.ts`

**US-002**
- `apps/api/src/fleet/flows/prisma-fleet-flow-step.repository.ts`
- `apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts`
- `apps/api/src/fleet/repos/fleet-repos.service.ts`
- `apps/api/src/fleet/jobs/job-state.ts`
- `apps/api/test/integration/fleet/fleet-flow-step.repository.integration.spec.ts`

**US-003**
- `apps/api/src/fleet/flows/project-flows.controller.ts`
- `apps/api/src/fleet/flows/fleet-flows.service.ts`
- `apps/api/src/fleet/flows/flows.module.ts`
- `apps/api/src/tickets/tickets.service.ts`
- `apps/api/src/fleet/flows/flow-overview.ts` — created by US-002, consumed here

**US-004**
- `apps/web/composables/useProviderCredentials.ts`
- `apps/web/lib/approval-requests.ts`
- `apps/web/lib/fleet-jobs.ts`

**US-005**
- `apps/web/composables/useFleetSchedules.ts`
- `apps/web/composables/useApi.ts`
- `apps/web/lib/fleet-flows.ts` — created by US-004, consumed here

**US-006**
- `apps/web/pages/[project]/fleet/schedules/[id].vue`
- `apps/web/composables/useFleetFlows.ts` — created by US-005, consumed here
- `apps/web/tests/helpers/mount-sfc.ts`
- `apps/web/composables/useProjectMemberNames.ts`

**US-007**
- `apps/web/pages/[project]/flows/[id].vue` — created by US-006, extended here
- `apps/web/lib/fleet-flows.ts` — created by US-004, consumed here
- `apps/web/lib/fleet-jobs.ts`

**US-008**
- `apps/web/pages/[project]/flows/[id].vue` — created by US-006, extended here
- `apps/web/composables/useFleetScheduleActions.ts`
- `apps/web/composables/usePermissions.ts`

**US-009**
- `apps/web/components/fleet/flows/FlowFeatureSection.vue` — created by US-007, extended here
- `apps/web/composables/useFleetFlows.ts` — created by US-005, consumed here
- `apps/web/composables/usePermissions.ts`

**US-010**
- `apps/web/pages/[project]/fleet/schedules/index.vue`
- `apps/web/composables/useFleetFlows.ts` — created by US-005, consumed here
- `apps/web/pages/[project]/threads/[id].vue`

**US-011**
- `apps/web/pages/[project]/flows/[id].vue` — created by US-006, extended here
- `apps/web/composables/useVisiblePolling.ts`

**US-012**
- `apps/web/layouts/default.vue`
- `apps/web/tests/layouts/threads-nav.spec.ts`

### Creates

**US-001**
- `apps/api/src/fleet/flows/dto/list-fleet-flows.query.ts`
- `apps/api/src/fleet/flows/dto/list-fleet-flows.query.spec.ts`

**US-002**
- `apps/api/src/fleet/flows/flow-overview.ts`
- `apps/api/src/fleet/flows/flow-overview.spec.ts`

**US-003**
- `apps/api/src/fleet/flows/dto/fleet-flow-overview.dto.ts`
- `apps/api/src/fleet/flows/fleet-flow-overview.service.ts`
- `apps/api/src/fleet/flows/project-flow-overview.controller.ts`
- `apps/api/src/fleet/flows/fleet-flow-overview.spec.ts`

**US-004**
- `apps/web/lib/fleet-flows.ts`
- `apps/web/tests/lib/fleet-flows.spec.ts`

**US-005**
- `apps/web/composables/useFleetFlows.ts`
- `apps/web/tests/composables/useFleetFlows.spec.ts`

**US-006**
- `apps/web/pages/[project]/flows/[id].vue`
- `apps/web/tests/pages/fleet-flow-detail.spec.ts`

**US-007**
- `apps/web/components/fleet/flows/FlowFeatureSection.vue`
- `apps/web/tests/components/flow-feature-section.spec.ts`

**US-008**
- `apps/web/tests/pages/fleet-flow-stop.spec.ts`

**US-009**
- `apps/web/components/fleet/flows/FlowAnswerForm.vue`
- `apps/web/tests/components/flow-answer-form.spec.ts`

**US-010**
- `apps/web/pages/[project]/flows/index.vue`
- `apps/web/components/fleet/threads/ThreadFlowsPanel.vue`
- `apps/web/tests/pages/fleet-flows-list.spec.ts`
- `apps/web/tests/components/thread-flows-panel.spec.ts`

**US-011**
- `apps/web/tests/pages/fleet-flow-polling.spec.ts`

**US-012**
- `apps/web/tests/layouts/flows-nav.spec.ts`

### Modifies

**US-001**
- `apps/api/src/fleet/flows/dto/fleet-flow.dto.spec.ts` — its closed-world "toEqual" on the flow DTO and on the feature DTO pins their keys; the target adds `stopDetail` (null when the record has none) to the flow and `branch` (null when unset) to every feature, so the expected objects gain those two keys and nothing else changes.
- `apps/api/src/fleet/flows/fleet-flow-read-stop.spec.ts` — gains the list cases for the `threadId` filters (controller to service, service to `findPage`); its existing "findPage" assertion with `{ projectId }` stays green because the key is added only when set.
- `apps/api/test/integration/fleet-flow-repository.integration.spec.ts` — the "findPage" block gains a case for the `threadId` filter; the existing cases are unchanged.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the flows list block gains a case for the `threadId` query; existing flow cases stay as they are.
- `openapi.json` — regenerated by `bun run api:export-spec` to carry `stopDetail`, the features' `branch` and the `threadId` query on the flow list.

**US-002**
- `apps/api/src/fleet/flows/domain/fleet-flow-step.domain.ts` — `IFleetFlowStepRepository` gains `listFlowJobs(flowId, limit)` and the `FlowJobRow` type; existing members are unchanged.
- `apps/api/test/integration/fleet/fleet-flow-step.repository.integration.spec.ts` — gains the "listFlowJobs" cases; existing cases are unchanged.
- `apps/api/src/fleet/repos/fleet-repos.service.spec.ts` — gains the "findIdentity" cases; existing cases are unchanged.
- `apps/api/src/fleet/repos/fleet-repos.service.ts` — gains `findIdentity(id)`; existing methods are unchanged.

**US-003**
- `apps/api/src/fleet/flows/flows.module.ts` — registers `FleetFlowOverviewService` as a provider and `ProjectFlowOverviewController` as a controller; existing providers and controllers are unchanged.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — adds the overview route's happy path (200) and a 404 for an unknown flow id; existing cases stay as they are.
- `openapi.json` — regenerated by `bun run api:export-spec` to carry the overview route and `FleetFlowOverviewDto`.

**US-006**
- `apps/web/i18n/locales/en.json` — adds the `fleet.flows` key group (detail, state, step, toast); no existing key changes.
- `apps/web/i18n/locales/zh.json` — adds the `fleet.flows` key group in Chinese; no existing key changes.
- `apps/web/tests/i18n/fleet-locale-parity.spec.ts` — its "ENUMS" map gains `fleet.flows.state` (seven flow states), `fleet.flows.featureState` (seven feature states) and `fleet.flows.step` (seven steps); existing entries are unchanged.

**US-007**
- `apps/web/i18n/locales/en.json` — adds feature-section and flow-jobs keys under `fleet.flows`; no existing key changes.
- `apps/web/i18n/locales/zh.json` — adds the same keys in Chinese; no existing key changes.

**US-008**
- `apps/web/i18n/locales/en.json` — adds stop keys under `fleet.flows`; no existing key changes.
- `apps/web/i18n/locales/zh.json` — adds the same stop keys in Chinese; no existing key changes.

**US-009**
- `apps/web/i18n/locales/en.json` — adds answer-form keys under `fleet.flows.answer`; no existing key changes.
- `apps/web/i18n/locales/zh.json` — adds the same answer-form keys in Chinese; no existing key changes.

**US-010**
- `apps/web/pages/[project]/threads/[id].vue` — mounts the thread flows panel below the thread header; the rest of the page is unchanged.
- `apps/web/tests/pages/threads-detail-page.spec.ts` — gains a case that the thread page renders the flows panel with its slug and thread id; existing cases are unchanged.
- `apps/web/i18n/locales/en.json` — adds the list and panel keys under `fleet.flows`; no existing key changes.
- `apps/web/i18n/locales/zh.json` — adds the same keys in Chinese; no existing key changes.

**US-011**

None. The polling story adds behaviour to the page US-006 creates and a new test file; no existing file pins it.

**US-012**
- `apps/web/layouts/default.vue` — the breadcrumb builder gains crumbs for the project flows list and a flow page, and the project nav gains an ungated Flows link after the Threads link with no new setup bindings; existing crumbs and links stay as they are.
- `apps/web/i18n/locales/en.json` — adds `nav.flows`; no existing key changes.
- `apps/web/i18n/locales/zh.json` — adds `nav.flows` in Chinese; no existing key changes.

### Seams

- US-003 serves `FleetFlowOverviewDto`; US-005's `overview` returns it unchanged, and US-006/US-007 read `repo`,
  `ticketRef`, `jobs`, `truncated`, `unknownCostCount`, and per job `id`, `feature`, `step`, `command`, `state`,
  `costUsd`, `queuedAt`, `finishedAt`.
- US-001 adds `stopDetail` and the features' `branch`; US-006 and US-007 render them.
- US-001 adds the `threadId` query; US-010's thread panel sends it.
- US-005's `useFleetFlows` is called by US-006 (`get`, `overview`), US-008 (`stop`), US-009 (`answer`) and US-010
  (`list`).

## Acceptance Criteria

### US-001

1. [unit] `FleetFlowDto.from` on a record with `stopDetail: 'job j1 failed'` returns a DTO whose `stopDetail` is
   `'job j1 failed'`.
2. [unit] `FleetFlowDto.from` on a record whose `stopDetail` is undefined returns `stopDetail: null`.
3. [unit] `FleetFlowFeatureDto.from` on a feature with `branch: 'feat/f14-clamp'` returns `branch: 'feat/f14-clamp'`.
4. [unit] `FleetFlowFeatureDto.from` on a feature whose `branch` is undefined returns `branch: null`.
5. [unit] `ProjectFlowsController.list` with the query `{ threadId: 't1' }` calls `FleetFlowsService.list` with the
   project id, the page `{ current: 1, size: 20 }` and the filters `{ threadId: 't1' }`.
6. [unit] `FleetFlowsService.list('p1', page, {})` calls `findPage` with filters `{ projectId: 'p1' }` and no
   `threadId` key.
7. [unit] Validating `ListFleetFlowsQuery` with a `threadId` of 65 characters fails.
8. [integration] With flows of threads `t1` and `t2` in one project, `findPage({ projectId, threadId: 't1' }, page)`
   returns only the `t1` flows.
9. [integration] With a thread-linked flow seeded through `newThread`, `GET /api/projects/:slug/flows?threadId=<id>`
   answers 200 with only that thread's flows.

### US-002

1. [unit] `findIdentity` for an existing repo returns `{ provider: 'github', owner: 'nathapp-io', name: 'sandbox' }`
   for a repo with those values.
2. [unit] `findIdentity` for an unknown id returns `null`.
3. [integration] `listFlowJobs(flowId, 500)` returns only the flow's jobs, ordered by `queuedAt` ascending then `id`
   ascending, and `truncated: false`.
4. [integration] `listFlowJobs(flowId, 2)` on a flow with 3 jobs returns its 2 newest jobs, oldest of the two first,
   and `truncated: true`.
5. [integration] A row from `listFlowJobs` carries the job's `flowFeatureId`, `flowStep`, `command`, `state`,
   `queuedAt` and `finishedAt`, and its costs as 4-decimal strings.
6. [unit] `totalCostUsd` of a row with `costSpentUsd` `'0.1100'` and `costCarriedUsd` `'0.0020'` is `'0.1120'`.
7. [unit] `countUnknownCost` counts a `COMPLETED` `AGENT` job and a `FAILED` `PLAN` job, each at total cost zero, as 2.
8. [unit] `countUnknownCost` does not count a `CANCELLED` `RUN` job at total cost zero.
9. [unit] `countUnknownCost` does not count a `RUNNING` `REVIEW` job at zero, nor a `COMPLETED` `FIX` job at `'0.0500'`.

### US-003

1. [unit] `FleetFlowOverviewService.overview('p2', flowId)` for a flow in project `p1` rejects with
   `NotFoundAppException` key `fleet.flows.notFound` and does not call `listFlowJobs`.
2. [unit] `overview` returns `repo` equal to what `FleetReposService.findIdentity(flow.repoId)` returns.
3. [unit] `overview` for a flow with `ticketId: 'tk1'` calls `TicketsService.findRefsByIds(projectId, ['tk1'])` and
   returns `ticketRef: 'SB-7'` when the map holds `tk1 -> 'SB-7'`.
4. [unit] `overview` for a flow with a null `ticketId` returns `ticketRef: null` and does not call `findRefsByIds`.
5. [unit] `overview` calls `listFlowJobs(flowId, 500)` and returns its `truncated` value.
6. [unit] A job whose `flowFeatureId` is the id of the feature named `f14-min` is returned with `feature: 'f14-min'`,
   and a job with a null `flowFeatureId` with `feature: null`.
7. [unit] A returned job has `costUsd` equal to `totalCostUsd(row)`, `step` equal to the row's `flowStep`, and
   `queuedAt` and `finishedAt` as ISO strings (`finishedAt` null when unset).
8. [unit] `overview` returns `unknownCostCount` equal to `countUnknownCost` of the rows.
9. [unit] `ProjectFlowOverviewController.overview(flowId, ctx)` returns `JsonResponse.Ok` of
   `FleetFlowOverviewService.overview(ctx.project.id, flowId)`, and carries `@Requires('fleet.flow.read')`.
10. [integration] `GET /api/projects/:slug/flows/:flowId/overview` answers 200 with `repo`, `jobs` and
    `unknownCostCount` for an existing flow, and 404 for an unknown flow id.

### US-004

1. [unit] `isLiveFlow` returns `true` for `PENDING`, `APPROVED`, `RUNNING`, `WAITING_MERGE` and `WAITING_ANSWER`.
2. [unit] `isLiveFlow` returns `false` for `COMPLETED` and `STOPPED`.
3. [unit] `flowStateKey('RUNNING')` returns `'fleet.flows.state.RUNNING'`, and `flowStateKey('BOGUS')` returns `null`.
4. [unit] `featureBranch(flow, feature)` returns `feature.branch` when it is set, and `flow.branch` when it is null.
5. [unit] `prUrl({ provider: 'github', owner: 'o', name: 'r' }, 33)` returns `'https://github.com/o/r/pull/33'`.
6. [unit] `prUrl` returns `null` for a `gitlab` repo, for a null repo, and for a null PR number.
7. [unit] `jobsByFeature(jobs, features)` puts each job under its feature name in input order, and gives every
   feature an entry, empty when it has no jobs.
8. [unit] `jobsByFeature` returns the jobs whose `feature` is null in `flowJobs`.
9. [unit] `openQuestions(feature)` returns the questions when `answeredAt` is null, and `[]` when `answeredAt` is set
   or `questions` is null.
10. [unit] `isPendingFlowAnswer` returns `true` for an object with a `permissionKey` field and `false` for a flow DTO.
11. [unit] `featureStateKey('MERGED')` returns `'fleet.flows.featureState.MERGED'`, and `featureStateKey('BOGUS')`
    returns `null`.
12. [unit] `flowStepKey('PRD_REVIEW')` returns `'fleet.flows.step.PRD_REVIEW'`, and `flowStepKey(null)` returns `null`.

### US-005

1. [unit] `useFleetFlows('web').list(2, 't1')` calls `$api.get` with `/projects/web/flows?current=2&size=20&threadId=t1`.
2. [unit] `list(1)` calls `$api.get` with `/projects/web/flows?current=1&size=20`.
3. [unit] `get('f1')` calls `$api.get` with `/projects/web/flows/f1`, and `overview('f1')` with
   `/projects/web/flows/f1/overview`.
4. [unit] `stop('f1')` calls `$api.post` with `/projects/web/flows/f1/stop` and returns `{ kind: 'done', flow }` when
   the API answers a flow DTO.
5. [unit] `stop('f1')` returns `{ kind: 'pending', request }` when the API answers an approval request summary.
6. [unit] `answer('f1', 'j9', [{ id: 'q1', answer: 'yes' }])` calls `$api.post` with `/projects/web/flows/f1/answers`
   and the body `{ jobId: 'j9', answers: [{ id: 'q1', answer: 'yes' }] }`.
7. [unit] `answer` returns `{ kind: 'pending', request }` when the API answers an approval request summary.

### US-006

1. [unit] Mounting the flow page calls `useFleetFlows.get(flowId)` and `overview(flowId)` once each and renders the
   flow's state label and branch.
2. [unit] The page renders `formatUsd(spentUsd)` and `formatUsd(costCapUsd)`, and the `fleet.flows.detail.unknownCost`
   text with count 2 when `unknownCostCount` is 2.
3. [unit] When `unknownCostCount` is 0, the unknown-cost text is not rendered.
4. [unit] A `PENDING` flow with `approval.approvalRequestId` renders the pending-approval text and a link to
   `/:project/approvals`.
5. [unit] An approved flow renders the approval mode and the approver's name from `useProjectMemberNames`.
6. [unit] A `STOPPED` flow renders `stopReason` and `stopDetail`, and a link to `/:project/tickets/SB-7` when
   `ticketRef` is `'SB-7'`.
7. [unit] A `stopDetail` of `<b>x</b>` renders as that literal text, with no `b` element in the page.
8. [unit] When `get` rejects with a 404 `ApiError`, the page renders the `fleet.flows.detail.notFound` text.
9. [unit] When `get` rejects with a non-404 error, the page renders the `fleet.flows.detail.loadFailed` text.
10. [unit] The page renders the flow's `entry`, its reviewer and supervisor role models, and its `createdAt`.
11. [unit] An approved flow whose `approverId` has no member name renders the `approverId` itself.

### US-007

1. [unit] The flow page renders one `FlowFeatureSection` per feature in the DTO's order.
2. [unit] A feature section renders the feature's name, state label, current step and `dependsOn` names.
3. [unit] A feature section renders `featureBranch(flow, feature)`.
4. [unit] A feature with PR 33 on a `github` repo renders a link to `https://github.com/<owner>/<name>/pull/33`.
5. [unit] A feature with PR 33 and a null overview renders `#33` with no link.
6. [unit] A feature section lists that feature's jobs, each with step, command, state and `formatUsd(costUsd)`.
7. [unit] Each listed job links to `/:project/fleet/jobs/<id>`.
8. [unit] The page renders a "Flow jobs" section listing the jobs whose `feature` is null.
9. [unit] The page renders no "Flow jobs" section when every job has a feature.
10. [unit] When `overview` rejects and `get` succeeds, the page renders the feature sections and the
    `fleet.flows.detail.jobsFailed` text.

### US-008

1. [unit] The Stop button is shown for a `RUNNING` flow when `permissions.value.has('fleet.flow.stop')` is true.
2. [unit] The Stop button is not shown when `has('fleet.flow.stop')` is false.
3. [unit] The Stop button is not shown for a `COMPLETED` flow.
4. [unit] Clicking Stop with `window.confirm` returning `false` does not call `useFleetFlows.stop`.
5. [unit] Clicking Stop with `window.confirm` returning `true` calls `stop(flowId)`, shows a success toast and calls
   `get` again.
6. [unit] When `stop` returns `{ kind: 'pending' }`, the page shows the `fleet.flows.toast.approvalRequested` toast
   and renders a link to `/web/approvals` for project `web`.
7. [unit] When `stop` rejects with an `ApiError` 409, the page shows `extractApiError(err)` as an error toast and
   calls `get` again.

### US-009

1. [unit] For a `WAITING_ANSWER` flow whose feature has two open questions, the feature section renders
   `FlowAnswerForm` with one text field per question, labelled with the question text.
2. [unit] The answer form is not rendered when `permissions.value.has('fleet.flow.answer')` is false.
3. [unit] The answer form is not rendered for a `RUNNING` flow.
4. [unit] A question text of `<i>q</i>` renders as that literal text, with no `i` element.
5. [unit] Submitting with one field empty shows the `fleet.flows.answer.required` message and does not call `answer`.
6. [unit] Submitting both fields calls `answer(flowId, feature.questionsJobId, [{ id: 'q1', answer: 'A' },
   { id: 'q2', answer: 'B' }])` in question order.
7. [unit] When `answer` returns `{ kind: 'done' }`, the form shows a success toast and emits `answered`.
8. [unit] When `answer` returns `{ kind: 'pending' }`, the form shows the `fleet.flows.toast.approvalRequested`
   toast, renders a link to `/web/approvals` for project `web`, and emits `answered`.
9. [unit] When `answer` rejects with an `ApiError` 409, the form shows `extractApiError(err)` as an error toast and
   emits `answered`.
10. [unit] The flow page calls `get` again when a feature section's answer form emits `answered`.

### US-010

1. [unit] Mounting the flows list page calls `useFleetFlows.list(1)` and renders one row per flow with its state
   label, feature names and a link to `/:project/flows/<id>`.
2. [unit] A list row renders `formatUsd(spentUsd)` and `formatUsd(costCapUsd)`.
3. [unit] With `hasNext: true`, clicking Next calls `list(2)`; with `hasPrev: false`, the Previous control is disabled.
4. [unit] With no flows, the list page renders the `fleet.flows.list.empty` text.
5. [unit] When `list` rejects, the list page shows `extractApiError(err)` as an error toast and renders no rows.
6. [unit] `ThreadFlowsPanel` with `slug` `web` and `threadId` `t1` and `fleet.flow.read` calls `list(1, 't1')` and
   renders each flow's state label with a link to `/web/flows/<id>`.
7. [unit] `ThreadFlowsPanel` renders nothing when `list` returns no records.
8. [unit] `ThreadFlowsPanel` without `fleet.flow.read` renders nothing and does not call `list`.
9. [unit] `ThreadFlowsPanel` renders nothing and shows no toast when `list` rejects.
10. [unit] The thread page renders `ThreadFlowsPanel` with the page's slug and thread id.

### US-011

1. [unit] For a `RUNNING` flow, advancing fake timers by 15 s calls `get` and `overview` a second time.
2. [unit] When a poll's `get` returns the flow as `COMPLETED`, advancing fake timers by another 15 s calls `get` no
   further time.
3. [unit] For a flow that is `COMPLETED` at the first load, advancing fake timers by 15 s calls `get` no second time.
4. [unit] After a failed first `get`, advancing fake timers by 15 s calls `get` no second time.
5. [unit] After the page unmounts, advancing fake timers by 15 s calls `get` no second time.
6. [unit] When a poll's `get` rejects, the page still renders the flow's branch, and the next 15 s tick calls `get`
   again.

### US-012

1. [unit] The default layout's breadcrumbs for `/web/flows` are Koda, `web`, and `nav.flows`.
2. [unit] The default layout's breadcrumbs for `/web/flows/f1` are Koda, `web`, `nav.flows` linking `/web/flows`, and
   `fleet.flows.detail.title`.
3. [unit] The default layout renders a link to `/web/flows` labelled with `nav.flows` in the project nav of project
   `web`, after the Threads link.
