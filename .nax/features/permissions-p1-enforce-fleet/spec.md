# SPEC: Permissions P1d — Enforce Permission Keys on the Fleet Routes

## Summary

This feature moves authorization on the fleet REST routes of `apps/api` onto permission keys checked by `PermissionService.can`, and lets agents use every fleet route their keys allow:
- **The fleet routes switch over.** Jobs, job logs, bundles, analytics, dashboards, runners, repos, schedules, budgets, approvals (decide checked per approval type), repo config edits, knowledge, ticket fleet-jobs, ingest, enrollments, the fleet activity feed and the test hooks. Each loses its `@ProjectPermission`, `@RequiredPermission`, user-only (`isUserPrincipal`) refusal, `ctx.role` check or CASL ability check, and declares its catalog key with `@Requires`.
- **Agents act on the fleet as agents.** A new action context (the first slice of design §5, P2's `ActionContext`) carries the calling principal through each request, so a fleet write by an agent is recorded with actor type `AGENT`. Fleet jobs and schedules record their requester's type, and the code that assumed a requester is a user (job notifications, PR attribution, `responsibleUserId`) handles an agent requester.
- **R10 is retired.** Fleet job, log, spend, dashboard and approval reads are role keys that agents hold like users (design decision 9). The 600 requests/min log throttle stays.

This is the fourth of eight features implementing phase P1 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md`. The order is: roles (PR #308), membership (PR #310), enforce-core (PR #313), **enforce-fleet**, enforce-assistant, enforce-integrations, cleanup, and web in parallel. The design doc's phasing section lists five features and predates three splits: `permissions-p1-roles` split off membership; enforce-core's scoping (2026-10-19) moved the vcs, webhook, skills, code-intel, context and ci-webhook routes into `permissions-p1-enforce-integrations`; and this feature's scoping (2026-10-20) moved threads, the assistant and MCP tools, the knowledge base and memory into a new `permissions-p1-enforce-assistant`.

## Motivation

After `permissions-p1-enforce-core`, the core routes check permission keys, but every fleet route still decides through the legacy mechanisms: `@RequiredPermission('ADMIN')`, `@ProjectPermission` over the CASL factory, `ctx.role === 'ADMIN'`, and a user-only refusal ("R10: logs are for people; agents and runners get 403"). So a user bound to `reviewer` gets whatever the legacy role mapping gives, an agent can read over MCP what REST refuses it (review B/SEC-1), and no agent can dispatch, schedule or decide anything on the fleet, whatever role it is bound to.

Agents could not be let in before, because two fleet rows store their requester as a foreign key to `User` (`FleetJob.requestedById`, `JobSchedule.createdById`) and about fifty fleet writes record their actor as `USER` unconditionally.

**Rulings that bind this feature** (user, 2026-10-20):
- **Split.** enforce-fleet covers the fleet REST routes only. Threads, the assistant and MCP tool keys, the knowledge base (`/kb`) and memory move to `permissions-p1-enforce-assistant`.
- **Schedules check the owner's keys when they fire** (design decision 7): the owner must hold `fleet.job.dispatch` in the project, read through `PermissionService`.
- **The dispatch effect starts linked tickets with no edge-key check.** `fleet.job.dispatch` already authorised the RUN dispatch, so the auto-start of its CREATED or VERIFIED tickets is a consequence of that dispatch, like the other automatic fleet transitions.
- **Schedule edits stay owner-or-admin.** `fleet.schedule.update` and `fleet.schedule.delete` become ownable; Developer holds the `.own` keys and Project Admin the any-row keys.
- **Developer gains `fleet.repo.drift.check`**, which DEVELOPER+ holds today and Appendix A left out.
- **`fleet.activity.read` is re-scoped so project roles hold it** (to scope `project`; global admins keep it everywhere), and `GET /fleet/activity` and `GET /fleet/approval-counts` list only the projects where the caller holds the read key.
- **Agents may make fleet writes now**, through an early slice of P2's `ActionContext` (an `AsyncLocalStorage` actor set from the principal), plus a requester-type column on `FleetJob` and `JobSchedule` with the two user foreign keys dropped. No fleet service signature changes except those Design lists.

## Design

### Rulings that bind every story

1. **Conventions carry over** from `.nax/features/permissions-p1-enforce-core/spec.md` ("Rulings that bind every story" 1-10) unless this spec says otherwise. In short: `PermissionsModule` is `@Global()`; a refused key answers 403 `new ForbiddenAppException({}, 'permissions')` (message `permissions.403`, already present); `RequiresGuard` runs after `ProjectMembershipGuard` in one `@UseGuards(ProjectMembershipGuard, RequiresGuard)` call (method level, or both at class level); `enforcedBy: 'service'` moves the key check into the handler or service; exceptions are `new XAppException({}, '<namespace>.<code>')` with `en` and `zh` messages; repositories follow `.nax/rules/api-data.md`; DB-backed tests that need the system roles run `SystemRoleSeeder.onApplicationBootstrap()` after `resetDb`, or boot the app.
2. **Order of checks on every route** is enforce-core's: authentication; project resolution and access (`ProjectMembershipGuard`: 404 project, 403 `projects`); the route key (`RequiresGuard`: 403 `permissions`); input validation; handler lookups (404s); row-level key checks in the service (403 `permissions`); domain rules (409s, 400s). The first failing step decides the response.
3. **Only key refusals change their code.** A refusal that a key replaces answers 403 `permissions` instead of today's 403 `projects` (or Nest's generic 403 from `@RequiredPermission`). Unchanged: `ProjectMembershipGuard`'s 403 `projects`, every 404, and every non-permission refusal (for example `fleet.scheduleOwnerNoAccess`, `threads.notCreator`, `fleet.approvalNotPending`).
4. **No principal-type refusal is left on a fleet route this feature migrates.** Every `isUserPrincipal` / `assertUser` / `requireUser` refusal on those routes is removed; the key decides. Runner principals still never pass: `PermissionService.can` refuses them (`non-role-key`).
5. **Fleet service signatures do not change** except where a story says so (`ApprovalsService.decide` and `counts`, the schedule owner-access read). The actor type reaches the services through the action context (below).
6. **Project rules.** `.nax/rules/api-core.md` and `.nax/rules/api-auth.md` already describe `@Requires` and `RequiresGuard` (updated for enforce-core). Follow them over older guidance.
7. **`api-testing.md` endpoint e2e rule, ruled as for enforce-core:** the route-level allow and refuse cases are pinned by this spec's integration ACs; only existing `endpoint.e2e.spec.ts` cases a correct implementation breaks are edited (see Modifies).

### The action context (an early slice of P2)

New folder `apps/api/src/action-context/`. The context is module-level state, like `writeLayerContext` in `apps/api/src/policy/policy-gate.service.ts`, so services read it without a constructor parameter.

`apps/api/src/action-context/action-context.ts`:

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

export type ActorType = 'USER' | 'AGENT';
export interface ActionActor { type: ActorType; id: string }
export interface ActionContext { actor: ActionActor }

const storage = new AsyncLocalStorage<ActionContext>();

/** Runs fn with actor as the current actor; nested runs replace it for their extent. */
export function runWithActor<T>(actor: ActionActor, fn: () => T): T {
  return storage.run({ actor }, fn);
}

/** The current actor, or undefined outside any request or runWithActor. */
export function currentActor(): ActionActor | undefined {
  return storage.getStore()?.actor;
}

/** 'AGENT' when the current actor is the agent with this id; otherwise 'USER' (every fleet actor id was a user's before this feature). */
export function actorTypeFor(actorId: string): ActorType {
  const actor = currentActor();
  return actor !== undefined && actor.id === actorId ? actor.type : 'USER';
}
```

`apps/api/src/action-context/action-context.interceptor.ts` — a global interceptor. It must run the **subscription** of the handler's Observable inside the context; wrapping only the `next.handle()` call would leave the handler body outside it:

```ts
@Injectable()
export class ActionContextInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const principal = ctx.switchToHttp().getRequest<{ user?: KodaPrincipal }>().user;
    if (!principal || isRunnerPrincipal(principal)) return next.handle();
    const actor: ActionActor = { type: isAgentPrincipal(principal) ? 'AGENT' : 'USER', id: principal.id };
    return new Observable((subscriber) => runWithActor(actor, () => next.handle().subscribe(subscriber)));
  }
}
```

`apps/api/src/action-context/action-context.module.ts` registers it with `{ provide: APP_INTERCEPTOR, useClass: ActionContextInterceptor }`, and `AppModule` imports `ActionContextModule`. Interceptors run after guards, so `request.user` is set.

**What P2 adds later** (out of scope here): on-behalf-of, the approval block, the correlation id, system actor ids, `AuditEntry`, and the rule that a write with no context throws.

### Fleet activity labels agents

`FleetActorType` (`apps/api/src/common/enums.ts`) gains `'AGENT'`, and `FleetActivityDto.actorType` lists it. `FleetActivityService.record` writes `entry.actorType` unchanged, except that an entry with `actorType: 'USER'` whose `actorId` equals the current actor's id is written with the current actor's type. So the ~50 call sites that pass `'USER'` keep compiling and record an agent correctly, and a `'SYSTEM'` or `'RUNNER'` entry, or a `'USER'` entry about someone else (a schedule owner, a job requester), is never relabelled. The fleet `transitions.apply({ actor: { type: 'USER', id } })` path reaches `record` and is covered the same way.

### `PermissionService.projectIdsWithKey`

New public method for the two filtered listings:

```ts
/** `{ all: true }` when the principal holds `key` globally; otherwise the accessible projects where it holds `key`, ascending. */
async projectIdsWithKey(principal: KodaPrincipal, key: string): Promise<{ all: true } | { all: false; projectIds: string[] }>;
```

- A runner principal: `{ all: false, projectIds: [] }`.
- `effectiveKeys(ref, 'global')` holds `key` (global Owner, Admin, a legacy `User.role = 'ADMIN'`): `{ all: true }`.
- Otherwise the candidate projects are `accessibleProjectIds(db, ref)` (`apps/api/src/permissions/legacy-membership.queries.ts`), read through a new `PrismaRoleBindingRepository.findAccessibleProjectIds(principal: PrincipalRef): Promise<string[]>`, and a project is kept when `effectiveKeys(ref, { projectId })` holds `key`. The candidates are the roster and binding projects; with `AGENT_PROJECT_SCOPING=off` an agent's listing still covers only those (accepted).

### Catalog and seeded role changes

- **`fleet.activity.read`** changes from `['global']` to `['project']` in `INVENTORY_SCOPE_ROWS` (`apps/api/src/permissions/catalog.ts`), so its scope becomes `project`, and the TSV row of `GET /fleet/activity` (`docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv`) changes its `catalog_scope` from `global` to `project` (`catalog.spec.ts` re-reads the TSV, one scope per row). Every project role's `*.read` then includes it, and global Owner and Admin still hold it in every project and in the global set (they hold every project key there), so the ruling's "global and project" behaviour holds.
- **`OWNABLE_KEYS`** gains `fleet.schedule.update` and `fleet.schedule.delete`.
- **`developer`** in `apps/api/src/permissions/system-roles.ts`: the entry `fleet.schedule.*` is replaced by `fleet.schedule.read`, `fleet.schedule.create`, `fleet.schedule.update.own` and `fleet.schedule.delete.own`, and the entry `fleet.repo.drift.check` is added. `project-admin` keeps the any-row keys through `*`.
- `SystemRoleSeeder` writes these entries when it creates a role; an existing database keeps its stored entries until reset (koda-wk is reset when P1 ships, design §8).

### Fleet requesters can be agents

**Schema** (one Prisma migration, `apps/api/prisma/migrations/20261030090000_fleet_requester_type/migration.sql`):
- `FleetJob` gains `requestedByType String @default("USER")`; its `requestedBy User @relation("FleetJobRequestedBy", ...)` and `User.fleetJobs` are removed, so the foreign key `FleetJob_requestedById_fkey` is dropped.
- `JobSchedule` gains `createdByType String @default("USER")`; its `createdBy User @relation("JobScheduleCreatedBy", ...)` and `User.jobSchedules` are removed, so `JobSchedule_createdById_fkey` is dropped.
- Existing rows default to `USER`, which is what every existing row is. No index changes.

**Writes.**
- `FleetJobRecord` and `NewFleetJob` (`apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`) gain an optional `requestedByType?: 'USER' | 'AGENT'`: `createJob` stores `'USER'` when it is absent, the row mappers (`toJob`) always set it, and an absent value means a user (so the many existing `FleetJobRecord` fixtures stay valid). `ScheduleRecord` and `NewSchedule` gain an optional `createdByType` the same way.
- `FleetJobsService.dispatch` sets `requestedByType: actorTypeFor(actorId)`. `ConfigJobsService` (its `createJob` call) does the same. The thread repository's job insert keeps the default (a thread's creator is a user).
- `SchedulesService.create` sets `createdByType: actorTypeFor(actorId)`.
- Requeue keeps the job row, so its requester is unchanged.

**Readers that assumed a user:**
- `FleetJobOutcomeRecorder` (`apps/api/src/fleet/jobs/job-outcome.recorder.ts`) enqueues no `FLEET_JOB_OUTCOME` event, from `onTerminal` or `onIngestCorrection`, for a job whose `requestedByType` is `'AGENT'`: notifications are for users.
- `PrAttributionService` names an agent requester: `findAgentDisplayName(agentId)` (new on the fleet job repository; the agent's `name`) when `requestedByType` is `'AGENT'`, falling back to `'a koda agent'`; the user path and its `'a koda user'` fallback are unchanged.
- `responsibleUserOf(job: { requestedById: string; requestedByType?: string }): string | null` (new, `apps/api/src/fleet/common/responsible-user.ts`) answers null for `'AGENT'` and `requestedById` otherwise (an absent type is a user's). Every site that passes `job.requestedById` as `responsibleUserId` uses it instead: `bundle.service.ts`, `bundle-ingest.service.ts`, `job-report.processor.ts`, `job-transitions.service.ts`, `fence.service.ts`, `fleet-jobs.service.ts` (cancel), and `approval-closer.ts` (`runnerActor`, `jobSystemActor`). The selects that feed them carry `requestedByType`, and `ApprovalActor.responsibleUserId` becomes `string | null`. Sites that set `responsibleUserId` from the acting principal rather than the job's requester (`userActor`, the dispatch, config-job, schedule and budget activity rows) keep the actor's id: an agent's id there is intended until P2 replaces the column with on-behalf-of.
- `FleetTicketEventRecorder.record` takes an optional `actorType: 'user' | 'agent'`. When it is absent, the recorder uses `actorTypeFor(actorId)` (lower-cased), so an agent unlinking a job is recorded as `agent`. `FleetJobTicketEffects` runs after commit, often outside any request, so it passes `actorType: 'agent'` for a job whose `requestedByType` is `'AGENT'` and passes no `actorType` otherwise; the ticket events of its PR link and failure comment then name the agent.

### Route keys

`G` = `RequiresGuard` checks the key; `S` = `enforcedBy: 'service'` (the check named in the last column). Every project route keeps `ProjectMembershipGuard` before `RequiresGuard`; global routes have `RequiresGuard` only.

| Route | Key | | Replaces |
|:--|:--|:--|:--|
| `POST /projects/:slug/fleet/jobs` | `fleet.job.dispatch` | G | `@ProjectPermission(CREATE FleetJob)` |
| `POST …/fleet/jobs/:id/cancel` | `fleet.job.cancel` | S (controller computes `canOperate`; the requester may cancel its own job) | user-only + CASL `UPDATE FleetJob` |
| `POST …/fleet/jobs/:id/requeue` | `fleet.job.requeue` | G | `@ProjectPermission(UPDATE FleetJob)` |
| `GET …/fleet/jobs`, `…/:id`, `…/:id/events` | `fleet.job.read` | G | user-only |
| `GET /projects/:slug/tickets/:ref/fleet-jobs` | `fleet.ticket-job.read` | G | user-only |
| `DELETE …/tickets/:ref/fleet-jobs/:jobId` | `fleet.ticket-job.unlink` | G | `@ProjectPermission(CREATE FleetJob)` + user-only |
| `GET …/fleet/jobs/:id/logs`, `…/logs/:stream/entries`, `…/logs/:stream/raw` | `fleet.job.logs.read` | G (600/min throttle kept) | user-only (R10) |
| `GET …/fleet/jobs/:id/bundle` | `fleet.job.bundle.read` | G | guard only |
| `GET …/fleet/analytics/spend`, `/quality`, `/stories`, `/jobs`, `/ingest`, `GET …/fleet/jobs/:id/analytics` | `fleet.analytics.read` | G | user-only |
| `GET /projects/:slug/fleet/dashboard` | `fleet.dashboard.read` | G | user-only |
| `GET /projects/:slug/fleet/runners` | `fleet.runner.read` | G | guard only |
| `GET /projects/:slug/fleet/repos` | `fleet.repo.read` | G | guard only |
| `GET …/fleet/schedules`, `…/:id` | `fleet.schedule.read` | G | user-only |
| `POST …/fleet/schedules` | `fleet.schedule.create` | G | `@ProjectPermission(CREATE FleetJob)` |
| `PATCH …/:id`, `POST …/:id/enable`, `POST …/:id/disable` | `fleet.schedule.update` | G + S (ownership in `SchedulesService`) | `@ProjectPermission(UPDATE FleetJob)` + `ctx.role === 'ADMIN'` |
| `DELETE …/fleet/schedules/:id` | `fleet.schedule.delete` | G + S (ownership) | same |
| `GET …/fleet/approvals`, `…/:id` | `fleet.approval.read` | G | user-only |
| `POST …/fleet/approvals/:id/decide` | `fleet.approval.decide.bash`, `.budget`, `mode: 'any'` (metadata only) | S (`ApprovalsService.decide`, per approval type; `assistant_action` keeps its creator-only check) | user-only + `mayDecideBash` / `mayDecideBudget` on `ctx.role` |
| `GET /fleet/approvals`, `/:id` | `fleet.approval.read` | G | `@RequiredPermission('ADMIN')` |
| `POST /fleet/approvals/:id/decide` | `fleet.approval.read` (G, global, so only a global grant reaches it, as today), then the type's decide key | G + S (per type) | `@RequiredPermission('ADMIN')` |
| `GET /fleet/approval-counts` | `fleet.approval.read` | S (`projectIdsWithKey`) | user-only, member projects |
| `GET /projects/:slug/fleet/budgets` | `fleet.budget.read` | G | user-only |
| `POST`, `PATCH …/:id`, `DELETE …/:id`, `POST …/:id/resume` on `/projects/:slug/fleet/budgets` | `fleet.budget.create`, `.update`, `.delete`, `.resume` | G | user-only + `ctx.role === 'ADMIN'` |
| the same five routes on `/fleet/budgets` | `fleet.budget.read`, `.create`, `.update`, `.delete`, `.resume` | G | `@RequiredPermission('ADMIN')` |
| `GET …/fleet/jobs/:id/config-edit` | `fleet.job.config.read` | G | user-only |
| `GET …/fleet/repos/:repoId/nax-files`, `…/nax-files/content` | `fleet.repo.config.read` | G | user-only |
| `POST …/fleet/repos/:repoId/config-edits`, `…/config-edits/regenerate` | `fleet.job.config.edit` | G | `@ProjectPermission(CREATE FleetJob)` |
| `POST …/fleet/repos/:repoId/drift-checks` | `fleet.repo.drift.check` | G | `@ProjectPermission(CREATE FleetJob)` |
| `GET /projects/:slug/knowledge/repos`, `POST …/knowledge/search` | `fleet.knowledge.read` | G | guard only |
| `PUT …/knowledge/patterns` | `fleet.knowledge.patterns.update` | G | `@RequiredPermission('ADMIN')` |
| `POST …/knowledge/repos/:repoId/reindex` | `fleet.knowledge.repo.reindex` | G | `@RequiredPermission('ADMIN')` |
| `GET /fleet/activity` | `fleet.activity.read` | S (`projectIdsWithKey`) | user-only, member projects |
| `GET /fleet/analytics/spend`, `DELETE /fleet/analytics` | `fleet.analytics.read`, `fleet.analytics.delete` | G | `@RequiredPermission('ADMIN')` |
| `GET /fleet/dashboard`, `GET /fleet/credential-board` | `fleet.dashboard.read`, `fleet.credential.read` | G | `@RequiredPermission('ADMIN')` |
| `GET /fleet/ingest`, `POST …/backfill`, `POST …/jobs/:jobId/rerun`, `POST …/rerun-outdated` | `fleet.ingest.read`, `.backfill`, `.rerun`, `.rerun` | G | `@RequiredPermission('ADMIN')` |
| `GET /fleet/repos`, `POST`, `POST …/:id/check`, `DELETE …/:id` | `fleet.repo.read`, `.create`, `.check`, `.delete` | G | `@RequiredPermission('ADMIN')` |
| `POST /fleet/enrollments`, `GET` | `fleet.enrollment.create`, `.read` | G | `@RequiredPermission('ADMIN')` |
| `GET /fleet/runners`, `…/:id`, `PATCH …/:id`, `DELETE …/:id` | `fleet.runner.read`, `.read`, `.update`, `.delete` | G | `@RequiredPermission('ADMIN')` |
| `POST /fleet/test-hooks/schedules/:id/fire`, `PUT /fleet/test-hooks/repos/:repoId/nax-files` | `testhook.schedule.fire`, `testhook.nax-files.seed` | G (the 404 when hooks are off is unchanged) | `@RequiredPermission('ADMIN')` |

A key with scope `any` on a global route is checked with no project (`can(principal, key)`), so only global grants pass, as today's global-admin check did. The runner protocol routes (`/fleet/runner/*`) are unchanged.

### Jobs and the dispatch effect

- **Cancel.** The cancel route's controller computes `canOperate = (await permissions.can(principal, 'fleet.job.cancel', { projectId })).allowed` and calls `FleetJobsService.cancel(principal.id, projectId, id, canOperate)` unchanged, so the requester of a job may still cancel it without the key (the service's `requestedById === actorId` rule), and anyone else needs the key (403 `permissions`, replacing the service's 403 `projects` for that case).
- **Auto-start.** New `TicketTransitionsService.startForDispatch(projectSlug, ref, principal)`: the `start` transition without `assertEdgeAllowed`, everything else as `start` (validation, the conditional write, the activity row with the dispatcher as actor, the events). `FleetJobTicketEffects.onRunDispatched` calls it instead of `start`. No other caller may use it.

### Schedules

- **Ownership.** The four mutating routes compute `canAdminister = (await permissions.can(principal, '<route key>', { projectId })).allowed` and pass it to the unchanged `SchedulesService` methods. A Developer holds only the `.own` key, so `can` answers `not-owner` without a resource, `canAdminister` is false, and `assertManaged` keeps today's owner rule (`schedule.createdById === actorId`). `assertManaged`'s refusal becomes 403 `permissions`.
- **Owner access.** `IScheduleRepository.findOwnerAccess(projectId, owner: PrincipalRef): Promise<OwnerAccess>` replaces the user-only read, and `OwnerAccess` becomes `{ exists: boolean; disabled: boolean }`: a USER owner exists when its `User` row exists and is disabled when `User.disabled`; an AGENT owner exists when its `Agent` row exists and is never disabled (a PAUSED agent keeps its schedules; status is liveness, not access). `mayDispatch(access, keys: ReadonlySet<string>)` (`apps/api/src/fleet/schedules/schedule-access.ts`) answers `access.exists && !access.disabled && keys.has('fleet.job.dispatch')`, where `keys = await permissions.effectiveKeys({ type: schedule.createdByType ?? 'USER', id: schedule.createdById }, { projectId: schedule.projectId })`. The optional record fields are always read with `?? 'USER'`.
- `ScheduleTicker.dispatchFresh` and `SchedulesService.enable` read owner access that way. `SchedulesService` and `ScheduleTicker` each gain `PermissionService` as a required last constructor parameter.
- **The fire runs as the owner.** `ScheduleTicker.dispatchFresh` calls `FleetJobsService.dispatch` inside `runWithActor({ type: schedule.createdByType ?? 'USER', id: schedule.createdById }, ...)`, so the job's `requestedByType` and its activity rows name the owner's type. The ticker's own activity rows (`SYSTEM_ACTOR_ID`) are unaffected.

### Approvals

- **`ApprovalRoute`** is unchanged (the assistant's `koda_list_approvals` tool builds one with `role`), but `decide` no longer reads `role`. **`ApprovalCaller`** (`{ id, globalAdmin }`) is unchanged, because `AssistantActionPort.decide` shares it; `ApprovalsService.decide` takes `caller: ApprovalCaller & { principal: KodaPrincipal }`, and both decide controllers pass the request principal.
- **Decide.** `ApprovalsService.decide` checks, after `findVisible` and before any lock or write, `permissions.can(caller.principal, key, scope)`: `fleet.approval.decide.bash` for `nax_bash_escalate`, `fleet.approval.decide.budget` for `budget_override_required`, with `scope = { projectId: approval.projectId }` when the approval has a project and no project otherwise. A refusal is 403 `permissions`. `assistant_action` approvals keep their creator-only handler (`AssistantActionPort.decide`, 403 `threads.notCreator`) with no key check; their key belongs to `permissions-p1-enforce-assistant`. `mayDecideBash` and `mayDecideBudget` are deleted. `ApprovalsService` gains `PermissionService` as a required last constructor parameter.
- **Counts.** `ApprovalsService.counts(scope: { all: true } | { all: false; projectIds: string[] })` replaces `counts(caller)`; the controller passes `projectIdsWithKey(principal, 'fleet.approval.read')`. `{ all: true }` counts every project's pending approvals through a new `IApprovalRepository.countPendingAllProjects(): Promise<PendingCount[]>` (pending approvals of non-deleted projects grouped by `projectId`, the same row shape as `countPending`) and adds `countPendingUnscoped()`; `{ all: false }` calls `countPending(projectIds)` with `unscoped` 0, as a non-admin gets today.
- **No agent self-approval** (security ruling, user, 2026-10-20). In `decideBash`, right after the job and the approval are locked, a caller that is an agent principal and is the job's requester (`job.requestedById === caller.id` and `(job.requestedByType ?? 'USER') === 'AGENT'`) is refused with `new ForbiddenAppException({}, 'fleet.approvalSelfDecide')`, which rolls the transaction back, so nothing is written and the approval stays pending. A human may still decide an ask of a job they requested, as today. New messages `fleet.approvalSelfDecide.403` in `apps/api/src/i18n/en/fleet.json` ("An agent cannot decide an approval for a job it requested") and `zh/fleet.json` ("代理不能审批自己发起的任务的请求"). Budget asks are raised by the system and have no single requester, so they are unaffected. P3's approval engine replaces this rule with policy modes.
- The global decide controller keeps passing `globalAdmin: true`: only a principal with a global `fleet.approval.read` grant passes its guard. The project controller keeps passing `globalAdmin: principal.role === 'ADMIN'` as today (no reader decides on it after this feature).
- `decidedById` keeps the caller's id; for an agent it is the agent's id (the activity row records the type).

### Fleet activity listing

`GET /fleet/activity` calls `projectIdsWithKey(principal, 'fleet.activity.read')`: `{ all: true }` lists every row (today's global-admin view, including rows with no project); otherwise only rows whose `projectId` is in the list. `FleetActivityService.memberProjectIds` has no caller left after this feature; it stays, and `permissions-p1-cleanup` removes it.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| A route key the caller does not hold | 403 `permissions`; the handler does not run |
| A runner principal on a migrated route | Refused with 403 (`projects` from `ProjectMembershipGuard` on project routes, `permissions` on global routes); `GET /fleet/activity` and `GET /fleet/approval-counts` answer it an empty list (`projectIdsWithKey` gives it no project) |
| Cancelling a job the caller did not request, without `fleet.job.cancel` | 403 `permissions`; the job is unchanged |
| Editing, enabling, disabling or deleting another principal's schedule with only the `.own` key | 403 `permissions`; the schedule is unchanged |
| A schedule whose owner no longer holds `fleet.job.dispatch` in the project, or is gone or disabled, comes due | The tick disables it with reason `owner_lost_access` and dispatches nothing (as today) |
| Enabling such a schedule | 409 `fleet.scheduleOwnerNoAccess` (as today) |
| Deciding an approval without the key for its type | 403 `permissions` after the 404 visibility check; nothing is locked or written |
| An agent deciding a bash approval of a job it requested | 403 `fleet.approvalSelfDecide`; the approval stays pending and no command is created |
| An `assistant_action` approval decided by someone other than the thread's creator | 403 `threads.notCreator` (unchanged) |
| A job requested by an agent ends | No job-outcome notification is enqueued |
| A PR attribution for a job whose requesting agent is gone | The comment says `Dispatched by a koda agent via koda job <id>` |
| A fleet activity entry recorded outside any request context | Written with the actor type its caller passed (unchanged) |

### Integration

Symbols this feature **reads** (verified at `ff9e39b4`):
- `PermissionService.can(principal, key, { projectId?, resource? })`, `effectiveKeys(ref, scope)` — `apps/api/src/permissions/permission.service.ts`
- `Requires`, `REQUIRES_METADATA` — `apps/api/src/permissions/requires.decorator.ts`; `RequiresGuard` — `apps/api/src/permissions/requires.guard.ts`
- `findCatalogEntry`, `INVENTORY_SCOPE_ROWS`, `OWNABLE_KEYS` — `apps/api/src/permissions/catalog.ts`; `SYSTEM_ROLES` — `apps/api/src/permissions/system-roles.ts`; `SystemRoleSeeder`
- `accessibleProjectIds(db, ref)` — `apps/api/src/permissions/legacy-membership.queries.ts`
- `ProjectMembershipGuard`, `@CurrentProject()`, `ProjectContext` — `apps/api/src/projects/`
- `KodaPrincipal`, `isAgentPrincipal`, `isRunnerPrincipal`, `isUserPrincipal` — `apps/api/src/auth/principal/koda-principal.types.ts`
- `PrincipalRef` — `apps/api/src/permissions/permissions.types.ts`
- `TicketTransitionsService.start` — `apps/api/src/tickets/state-machine/ticket-transitions.service.ts`

Symbols this feature **changes**. The baseline only locates the code; implement the target.

| Symbol | Baseline (locate only) | Target |
|:--|:--|:--|
| `AppModule` | no action context | imports `ActionContextModule` |
| `FleetActorType` | `USER`, `RUNNER`, `SYSTEM` | plus `AGENT` |
| `FleetActivityService.record` | writes `entry.actorType` | relabels a `USER` entry whose id is the current actor's |
| `PermissionService` | `can`, `effectiveKeys` | plus `projectIdsWithKey` |
| `PrismaRoleBindingRepository` | binding reads | plus `findAccessibleProjectIds(principal)` |
| `INVENTORY_SCOPE_ROWS`, TSV | `fleet.activity.read` global | project |
| `OWNABLE_KEYS` | no schedule keys | plus `fleet.schedule.update`, `fleet.schedule.delete` |
| `SYSTEM_ROLES` developer | `fleet.schedule.*` | `fleet.schedule.read`, `.create`, `.update.own`, `.delete.own`, plus `fleet.repo.drift.check` |
| `FleetJob`, `JobSchedule` (schema) | `requestedBy` / `createdBy` relations to `User` | `requestedByType` / `createdByType`, no relation |
| `FleetJobRecord`, `NewFleetJob`, `ScheduleRecord`, `NewSchedule` | no requester type | `requestedByType` / `createdByType` |
| `FleetJobOutcomeRecorder` | enqueues for every requester | skips an agent requester |
| `PrAttributionService` | user display name | agent name for an agent requester |
| `FleetTicketEventRecorder.record` | `actorType: 'user'` | optional `actorType` |
| `TicketTransitionsService` | `start` | plus `startForDispatch` |
| `FleetJobTicketEffects.onRunDispatched` | calls `start` | calls `startForDispatch` |
| `IScheduleRepository.findOwnerAccess`, `OwnerAccess`, `mayDispatch` | user id; `globalRole`, `projectRole` | `PrincipalRef`; `{ exists, disabled }`; keys |
| `SchedulesService`, `ScheduleTicker` | no `PermissionService` | `PermissionService` appended |
| `ApprovalsService` | `decide(caller: ApprovalCaller, ...)`, `ApprovalRoute.role`, `counts(caller)` | `decide(caller: ApprovalCaller & { principal }, ...)` (keys, not `route.role`), `counts(scope)`, `PermissionService` appended |
| `IApprovalRepository`, `PrismaApprovalRepository` | `countPending(projectIds)`, `countPendingUnscoped()` | plus `countPendingAllProjects()` |
| `ApprovalActor.responsibleUserId` (`approval-closer.ts`) | `string` | `string \| null` |
| `FleetJobsController`, `ProjectFleetSchedulesController`, `ProjectFleetApprovalsController`, `FleetApprovalCountsController`, `FleetActivityController` | CASL ability / `ctx.role` / `principal.role` | `PermissionService` constructor parameter (`canOperate`, `canAdminister`, the decide principal, `projectIdsWithKey`) |
| The controllers in "Route keys" | legacy checks | `@Requires` + guards |

## Out of Scope

- Migrating the thread routes (`/projects/:slug/threads/*`, `/threads/*`), the assistant and MCP tool keys (including the `MCP tools/list` filter and `TicketTransitionsService.assertTransitionPermission`), the knowledge-base routes (`/projects/:slug/kb/*`, `/kb/evaluate/retrieval`) and the memory routes (`/memory*`, `/projects/:slug/memory`, `/projects/:slug/timeline`) is out of scope (`permissions-p1-enforce-assistant`).
- A permission key for deciding `assistant_action` approvals (`fleet.approval.decide.assistant`) is out of scope (`permissions-p1-enforce-assistant`); they keep their creator-only handler and its 403 `threads.notCreator`.
- Migrating the vcs, webhook, skills, code-intel, context and ci-webhook routes is out of scope (`permissions-p1-enforce-integrations`).
- The runner protocol routes (`/fleet/runner/*`) are out of scope; they stay fenced by the runner key and the job lease.
- The rest of P2's action context is out of scope: on-behalf-of, the approval block, the correlation id, system actor ids, `AuditEntry`, and throwing on a write with no context (P2). This feature adds only the actor.
- Recording an actor type on `BudgetPolicy.createdById` / `updatedById`, `FleetApproval.decidedById`, `JobSchedule.updatedById`, `Runner.createdById`, `RunnerEnrollment.createdById` and `FleetRepo.createdById` is out of scope (P2 `AuditEntry`). An agent's id may be stored there; the fleet activity row of the same write records its type.
- Exposing `requestedByType` or `createdByType` in `FleetJobDto`, `ScheduleDto` or any other response is out of scope (`permissions-p1-web`).
- Notifying an agent about its job's outcome is out of scope; an agent-requested job enqueues no outcome notification.
- Removing `FleetActivityService.memberProjectIds`, `KodaCaslAbilityFactory`, `@ProjectPermission`, `@RequiredPermission` and the other legacy mechanisms is out of scope (`permissions-p1-cleanup`).
- The catalog contract test and the full role allow/deny matrix test are out of scope (`permissions-p1-cleanup`).
- Rewriting the stored permissions of an existing database's `developer` role with the new schedule and drift-check entries is out of scope; the seeder writes them when it creates the role, and koda-wk is reset when P1 ships.
- Approval of any action (`ApprovalRequest`, policies) is out of scope (P3). A permitted request runs immediately.
- New `endpoint.e2e.spec.ts` cases for the migrated routes are out of scope; the integration ACs pin the allow and refuse cases, and only the existing knowledge reindex case changes (see Modifies).
- Web changes are out of scope (`permissions-p1-web`).
- A runner principal on a migrated fleet route stays refused, or gets an empty list from the two filtered listings (`PermissionService.can` and `projectIdsWithKey` give it nothing); a dedicated test for it is out of scope.
- US-003 only: a requester cancelling its own job without `fleet.job.cancel` stays allowed (today's rule); narrowing it is out of scope.
- US-005 only: a schedule owned by an agent is checked against the agent's keys at fire time; a per-agent dispatch quota or cost cap is out of scope.

## Stories

1. **US-001: The action context, fleet activity labels and the catalog changes** — `Workdir: apps/api` — No dependencies. Adds `apps/api/src/action-context/` (`runWithActor`, `currentActor`, `actorTypeFor`, `ActionContextInterceptor`, `ActionContextModule`) and imports the module in `AppModule`; `FleetActorType` gains `AGENT` and `FleetActivityService.record` relabels the current actor; adds `PermissionService.projectIdsWithKey` with `PrismaRoleBindingRepository.findAccessibleProjectIds`; re-scopes `fleet.activity.read` (catalog and TSV), makes `fleet.schedule.update` and `fleet.schedule.delete` ownable, and changes the seeded `developer` entries.
2. **US-002: Fleet jobs and schedules record an agent requester** — `Workdir: apps/api` — Depends on US-001. Adds the migration (`requestedByType`, `createdByType`, the two foreign keys dropped), the record fields, `actorTypeFor` at the job and schedule inserts, `responsibleUserOf` at its call sites, the agent branch in `FleetJobOutcomeRecorder`, `PrAttributionService` and `FleetTicketEventRecorder`, and the conditional `actorType` in `FleetJobTicketEffects`.
3. **US-003: Job and ticket fleet-job routes check keys, and the dispatch effect starts tickets without an edge key** — `Workdir: apps/api` — Depends on US-001, US-002. Moves the job and ticket fleet-job routes onto `@Requires`, computes `canOperate` with `can`, adds `TicketTransitionsService.startForDispatch` and calls it from `FleetJobTicketEffects.onRunDispatched`.
4. **US-004: Fleet project reads check keys (R10 retired)** — `Workdir: apps/api` — Depends on US-001. Moves the log, bundle, project analytics, project dashboard, project runner and project repo routes onto `@Requires` and removes their user-only refusals; the log throttle stays.
5. **US-005: Schedules check keys, ownership and the owner's dispatch key** — `Workdir: apps/api` — Depends on US-001, US-002. Moves the schedule routes onto `@Requires`, computes `canAdminister` with `can`, changes `findOwnerAccess`, `OwnerAccess` and `mayDispatch` to the owner's keys, adds `PermissionService` to `SchedulesService` and `ScheduleTicker`, and runs the fire inside `runWithActor` for the owner.
6. **US-006: Approvals and budgets check keys** — `Workdir: apps/api` — Depends on US-001. Moves the project and global approval and budget routes onto `@Requires`, checks the decide key per approval type in `ApprovalsService.decide`, and filters `GET /fleet/approval-counts` with `projectIdsWithKey`.
7. **US-007: Repo config and knowledge routes check keys** — `Workdir: apps/api` — Depends on US-001, US-002. Moves the config-edit, nax-files, drift-check and knowledge routes onto `@Requires`. (US-002 records an agent's drift-check job as the agent's, which AC 6 observes.)
8. **US-008: Global fleet admin routes declare keys and the activity feed filters by key** — `Workdir: apps/api` — Depends on US-001, US-003. Moves the global analytics, dashboard, credential-board, ingest, repo, enrollment, runner and test-hook routes onto `@Requires`, and filters `GET /fleet/activity` with `projectIdsWithKey`. (US-003's agent dispatch writes the activity row AC 12 reads.)

This is one capability, enforcing keys on the fleet surface, at eight stories; the user confirmed it as one feature on 2026-10-20.

### Context Files

**US-001**
- `apps/api/src/policy/policy-gate.service.ts` — the module-level `AsyncLocalStorage` pattern (`writeLayerContext`)
- `apps/api/src/fleet/activity/fleet-activity.service.ts` — `record`, changed here
- `apps/api/src/permissions/permission.service.ts` — `effectiveKeys`, beside which `projectIdsWithKey` is added
- `apps/api/src/permissions/catalog.ts` — `INVENTORY_SCOPE_ROWS`, `OWNABLE_KEYS`
- `apps/api/src/permissions/system-roles.ts` — the `developer` entries

**US-002**
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `FleetJobRecord`, `NewFleetJob`, the job repository interface
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `dispatch` and `cancel`
- `apps/api/src/fleet/jobs/job-outcome.recorder.ts` — the outcome event
- `apps/api/src/fleet/sync/pr-attribution.service.ts` — the attribution comment
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts` — the PR-link and failure-comment ticket events

**US-003**
- `apps/api/src/fleet/jobs/fleet-jobs.controller.ts` — the job routes
- `apps/api/src/fleet/tickets/ticket-fleet-jobs.controller.ts` — the ticket fleet-job routes
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts` — `onRunDispatched`
- `apps/api/src/tickets/state-machine/ticket-transitions.service.ts` — `start`, beside which `startForDispatch` is added
- `apps/api/src/permissions/requires.guard.ts` — the guard the routes use

**US-004**
- `apps/api/src/fleet/logs/fleet-job-logs.controller.ts` — the log routes and the throttle
- `apps/api/src/fleet/analytics/project-fleet-analytics.controller.ts` — the project analytics routes
- `apps/api/src/fleet/dashboard/project-fleet-dashboard.controller.ts` — the project dashboard route
- `apps/api/src/fleet/artifacts/job-bundle.controller.ts` — the bundle route
- `apps/api/src/fleet/runners/project-fleet-runners.controller.ts` — the project runner list

**US-005**
- `apps/api/src/fleet/schedules/project-fleet-schedules.controller.ts` — the schedule routes
- `apps/api/src/fleet/schedules/schedules.service.ts` — `assertManaged`, `enable`
- `apps/api/src/fleet/schedules/schedule-ticker.ts` — `dispatchFresh`
- `apps/api/src/fleet/schedules/schedule-access.ts` — `mayDispatch`
- `apps/api/src/fleet/schedules/prisma-schedule.repository.ts` — `findOwnerAccess`

**US-006**
- `apps/api/src/fleet/approvals/approvals.service.ts` — `decide`, `counts`
- `apps/api/src/fleet/approvals/project-fleet-approvals.controller.ts` — the project approval routes
- `apps/api/src/fleet/approvals/fleet-approvals.controller.ts` — the global approval routes
- `apps/api/src/fleet/approvals/fleet-approval-counts.controller.ts` — the counts route
- `apps/api/src/fleet/budgets/project-fleet-budgets.controller.ts` — the project budget routes

**US-007**
- `apps/api/src/fleet/repo-config/project-repo-config.controller.ts` — the nax-files, config-edit and drift-check routes
- `apps/api/src/fleet/repo-config/project-job-config-edit.controller.ts` — the job config-edit read
- `apps/api/src/fleet/knowledge/project-knowledge.controller.ts` — the knowledge routes
- `apps/api/src/permissions/requires.guard.ts` — the guard the routes use

**US-008**
- `apps/api/src/fleet/activity/fleet-activity.controller.ts` — the activity feed
- `apps/api/src/fleet/runners/runners.controller.ts` — the runner admin routes
- `apps/api/src/fleet/repos/fleet-repos.controller.ts` — the repo admin routes
- `apps/api/src/fleet/ingest/fleet-ingest.controller.ts` — the ingest routes
- `apps/api/src/fleet/analytics/fleet-analytics.controller.ts` — the global analytics routes

### Creates

**US-001**
- `apps/api/src/action-context/action-context.ts`
- `apps/api/src/action-context/action-context.interceptor.ts`
- `apps/api/src/action-context/action-context.module.ts`

**US-002**
- `apps/api/prisma/migrations/20261030090000_fleet_requester_type/migration.sql`
- `apps/api/src/fleet/common/responsible-user.ts`

### Modifies

**US-001**
- `apps/api/src/permissions/catalog.spec.ts` — its OWNABLE_KEY_LIST pins the ownable keys and is compared for set equality with OWNABLE_KEYS. The replacing invariant: the list gains fleet.schedule.update and fleet.schedule.delete, and every other assertion is unchanged.
- `apps/api/src/app.module.ts` — it does not import ActionContextModule. The replacing invariant: AppModule imports ActionContextModule, which registers ActionContextInterceptor as APP_INTERCEPTOR, and no other import changes.
- `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` — the catalog_scope cell of the GET /fleet/activity row (proposed_key fleet.activity.read) changes from global to project. The replacing invariant: catalog.spec.ts still proves the TSV and INVENTORY_SCOPE_ROWS agree, and no other cell or row changes.

**US-002**
- `apps/api/src/fleet/repo-config/config-jobs.service.spec.ts` — its submitEdit case asserts the exact createJob argument object, which now gains requestedByType. The replacing invariant: the expected object also has requestedByType 'USER' (no context in the unit test), and every other assertion is unchanged.
- `apps/api/src/fleet/schedules/schedules.service.spec.ts` — its create case asserts the exact repo.create argument object, which now gains createdByType. The replacing invariant: the expected object also has createdByType 'USER', and every other assertion is unchanged.

**US-003**
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.spec.ts` — its transitions double has only start, and the "starts CREATED and VERIFIED tickets only, as the requester" case asserts start's calls. The replacing invariant: the double has startForDispatch, onRunDispatched calls startForDispatch with the same arguments in the same order, and the failure-tolerance case is unchanged.

**US-004**
- `apps/api/src/fleet/logs/fleet-job-logs.controller.spec.ts` — its "refuses agent principals on every route (R10)" case expects 403 from the controller for an agent. The replacing invariant: that case is removed (the controller no longer refuses by principal type; the key is RequiresGuard's), and the defaults and throttle cases are unchanged.

**US-005**
- `apps/api/src/fleet/schedules/schedules.service.spec.ts` — it constructs SchedulesService with five arguments and stubs findOwnerAccess with globalRole and projectRole. The replacing invariant: a PermissionService double is appended as the sixth argument, findOwnerAccess answers { exists, disabled }, the enable cases decide on the double's effectiveKeys holding fleet.job.dispatch, the findOwnerAccess call assertion expects ('p1', { type: 'USER', id: 'owner' }), and every ownership assertion is unchanged.
- `apps/api/src/fleet/schedules/schedule-ticker.spec.ts` — it constructs ScheduleTicker with six arguments and stubs findOwnerAccess with globalRole and projectRole. The replacing invariant: a PermissionService double is appended as the seventh argument, findOwnerAccess answers { exists, disabled }, the owner_lost_access cases decide on the double's effectiveKeys, the direct mayDispatch(access) cases pass { exists, disabled } with a key set, and every tick-outcome assertion is unchanged.
- `apps/api/src/fleet/schedules/prisma-schedule.repository.spec.ts` — it calls findOwnerAccess(projectId, userId), asserts globalRole and projectRole, and its AC-5/AC-6 cases call mayDispatch with one argument. The replacing invariant: it calls findOwnerAccess(projectId, { type: 'USER', id }) and asserts { exists, disabled } only; the mayDispatch cases pass the owner's key set (a set with fleet.job.dispatch for the developer owner, an empty set for the viewer owner) and expect the same results.
- `apps/api/test/integration/fleet/fleet-schedule-repository.integration.spec.ts` — it calls findOwnerAccess(projectId, userId) and asserts globalRole and projectRole. The replacing invariant: it calls findOwnerAccess(projectId, { type: 'USER', id }) and asserts { exists, disabled }; an AGENT owner case is not required here.
- `apps/api/test/integration/permissions/membership-fleet-consumers.integration.spec.ts` — its AC-5 and AC-6 call mayDispatch(await repo.findOwnerAccess(p1Id, userId)). The replacing invariant: they call mayDispatch with findOwnerAccess(p1Id, { type: 'USER', id }) and the owner's effectiveKeys in p1, expecting the same true and false; every HTTP assertion is unchanged.

**US-006**
- `apps/api/src/fleet/approvals/approvals.service.spec.ts` — it constructs ApprovalsService without PermissionService, passes decide callers without principal, decides bash and budget asks from route.role, and calls counts(caller). The replacing invariant: a PermissionService double is appended to the construction; the ApprovalRoute values may keep role, which decide ignores; decide callers carry a principal and the bash and budget refusals come from the double refusing the type's key; counts takes { all: true } or { all: false, projectIds }; the repository double gains countPendingAllProjects, and the totals are unchanged.
- `apps/api/test/integration/fleet/fleet-approvals-api.integration.spec.ts` — its agent cases expect 403 for an agent (with all four legacy roles and a roster row) on list, get, bash decide and approval-counts, assert the decide service is never called for the budget decide, and its direct approvals.decide call near line 296 passes no principal. The replacing invariant: that agent gets 200 from list, get and approval-counts and 200 from the bash decide (Developer holds fleet.approval.decide.bash); the budget decide still answers 403 (no fleet.approval.decide.budget) with the approval pending, without the not-called assertion; the direct call passes the root principal.

**US-007**
- `apps/api/src/fleet/knowledge/project-knowledge.controller.spec.ts` — its cases "reindex is a global ADMIN route" and "patterns is a global ADMIN route like reindex" assert PERMISSION_KEY 'ADMIN' metadata. Its first describe also builds a TestingModule with only four stub providers and overrides ProjectMembershipGuard only, so RequiresGuard fails DI at compile. The replacing invariant: that module also provides a PermissionService stub (or overrides RequiresGuard); reindex carries REQUIRES_METADATA with fleet.knowledge.repo.reindex, patterns with fleet.knowledge.patterns.update, repos and search with fleet.knowledge.read; every other case body is unchanged.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — its knowledge case "AC-12: POST reindex answers 403 for a project DEVELOPER and enqueues nothing" assumes reindex is global-admin only. The replacing invariant: a project DEVELOPER gets 202 and one admin pass is enqueued (Developer holds fleet.knowledge.repo.reindex), and the PUT patterns refusal for the same DEVELOPER (403) is unchanged.

**US-008**
- `openapi.json` — it records the route descriptions this feature's stories edit (US-003 to US-008) (for example the user-only notes on the fleet routes). The replacing invariant: it is regenerated with bun run api:export-spec, and only operation summaries and response descriptions change.
No test changes: the global admin route tests assert only the status of non-admin refusals (403), which the keys keep; the activity and counts tests that pin filtering (`membership-fleet-consumers.integration.spec.ts` AC-1, AC-2) keep their outcomes.

### Seams

- **US-001 → US-003, US-005, US-007:** `ActionContextInterceptor` and `actorTypeFor` are reached from real routes: an agent's `POST /projects/p1/fleet/jobs` (US-003 ACs 3 and 4), `POST /projects/p1/fleet/schedules` (US-005 AC 3) and `POST …/drift-checks` (US-007 AC 6) store `AGENT` on the row and on its activity entry.
- **US-001 → US-006, US-008:** `projectIdsWithKey` is reached from `GET /fleet/approval-counts` (US-006 ACs 9 and 10) and `GET /fleet/activity` (US-008 ACs 9-11).
- **US-001 → US-005:** the `.own` schedule keys are observed at the routes (US-005 ACs 4-6).
- **US-002 → US-005:** `createdByType` is set at the schedule insert and read by the ticker (US-005 ACs 3, 9 and 10).
- **US-003:** `startForDispatch` is reached from `POST /projects/p1/fleet/jobs` with a RUN and `ticketRefs` (US-003 ACs 10 and 11).
- **Every route story** has, at the HTTP route, a refusal AC with error code `permissions` and an allow AC for a principal the legacy check refused or a binding-only principal.
- **Altitude note.** US-001 and US-002 test the context, the relabel, the requester fields and the readers as units or against the service; the route ACs in US-003, US-005, US-007 and US-008 cover the wiring through real requests.

## Acceptance Criteria

Fixture wording, as in enforce-core: "a user whose only source in `p1` is a `<role>` binding" means a user with that `RoleBinding` in project `p1`, no `ProjectMember` row and no global admin role; "an agent rostered in `p1`" means an agent with an `AgentProject` row in `p1`, with the `AgentRoleEntry` roles the AC names (none when it names none); "a custom role holding only `ticket.read`" is a `Role` row with scope `PROJECT`, `system` false and permissions `['ticket.read']`. DB-backed tests seed the system roles first. Agent project scoping is on.

### US-001: The action context, fleet activity labels and the catalog changes (`Workdir: apps/api`)

1. [unit] Inside `runWithActor({ type: 'AGENT', id: 'a1' }, fn)`, `currentActor()` called from `fn` (including after an `await`) returns `{ type: 'AGENT', id: 'a1' }`, and outside any run it returns `undefined`.
2. [unit] Inside `runWithActor({ type: 'AGENT', id: 'a1' }, fn)`, `actorTypeFor('a1')` returns `'AGENT'` and `actorTypeFor('u9')` returns `'USER'`; outside any run `actorTypeFor('a1')` returns `'USER'`.
3. [unit] `ActionContextInterceptor.intercept` for a request whose `user` is an agent principal with id `a1`, and a handler whose Observable reads `currentActor()` when it is subscribed, emits `{ type: 'AGENT', id: 'a1' }`.
4. [unit] `ActionContextInterceptor.intercept` for a request whose `user` is a runner principal, or that has no `user`, gives the handler `currentActor()` `undefined`.
5. [unit] `FleetActivityService.record({ actorType: 'USER', actorId: 'a1', ... })` inside `runWithActor({ type: 'AGENT', id: 'a1' }, ...)` calls the repository's `create` with `actorType: 'AGENT'`.
6. [unit] `FleetActivityService.record({ actorType: 'USER', actorId: 'u2', ... })` inside `runWithActor({ type: 'AGENT', id: 'a1' }, ...)` calls `create` with `actorType: 'USER'`.
7. [unit] `FleetActivityService.record({ actorType: 'SYSTEM', actorId: 'a1', ... })` inside `runWithActor({ type: 'AGENT', id: 'a1' }, ...)` calls `create` with `actorType: 'SYSTEM'`.
8. [unit] `findCatalogEntry('fleet.activity.read').scope` is `'project'`, and `findCatalogEntry('fleet.schedule.update').ownable` and `findCatalogEntry('fleet.schedule.delete').ownable` are `true`.
9. [integration] After seeding, for a user whose only source in `p1` is a `developer` binding, `PermissionService.can(<principal>, 'fleet.schedule.update', { projectId: p1 })` answers `{ allowed: false, reason: 'not-owner' }`, and with `resource: { createdBy: { type: 'USER', id: <its id> } }` answers `allowed` true.
10. [integration] After seeding, for a user whose only source in `p1` is a `developer` binding, `can(..., 'fleet.repo.drift.check', { projectId: p1 })` and `can(..., 'fleet.activity.read', { projectId: p1 })` answer `allowed` true.
11. [integration] After seeding, for a user whose only source in `p1` is a `project-admin` binding, `can(..., 'fleet.schedule.delete', { projectId: p1 })` with no resource answers `allowed` true.
12. [integration] For a user whose only source in `p1` is a `developer` binding and with no source in `p2`, `PermissionService.projectIdsWithKey(<principal>, 'fleet.activity.read')` answers `{ all: false, projectIds: [p1] }`.
13. [integration] For a user with a `viewer` binding in `p1` and a `developer` binding in `p2`, `projectIdsWithKey(<principal>, 'fleet.job.dispatch')` answers `{ all: false, projectIds: [p2] }`.
14. [integration] For a user with a global `admin` binding, `projectIdsWithKey(<principal>, 'fleet.activity.read')` answers `{ all: true }`.
15. [unit] `FleetActivityService.record({ actorType: 'USER', actorId: 'a1', ... })` called outside any context calls `create` with `actorType: 'USER'`.

### US-002: Fleet jobs and schedules record an agent requester (`Workdir: apps/api`)

1. [integration] `FleetJobsService.dispatch(agentId, p1, <valid DTO>)` called inside `runWithActor({ type: 'AGENT', id: agentId }, ...)` for an existing agent stores a `FleetJob` row with `requestedById` the agent's id and `requestedByType` `'AGENT'`.
2. [integration] `FleetJobsService.dispatch(userId, p1, <valid DTO>)` called outside any context stores `requestedByType` `'USER'`.
3. [integration] `SchedulesService.create(agentId, p1, <valid DTO>)` called inside `runWithActor({ type: 'AGENT', id: agentId }, ...)` stores a `JobSchedule` row with `createdById` the agent's id and `createdByType` `'AGENT'`.
4. [integration] `ConfigJobsService.submitDrift(agentId, p1, repoId)` called inside `runWithActor({ type: 'AGENT', id: agentId }, ...)` stores a job with `requestedByType` `'AGENT'`.
5. [integration] `FleetJobOutcomeRecorder.onTerminal` for a FAILED job with `requestedByType` `'AGENT'` writes no outbox row of type `FLEET_JOB_OUTCOME`, while the same call for a FAILED job with `requestedByType` `'USER'` writes one.
6. [unit] `PrAttributionService.attribute` for a job with `requestedByType` `'AGENT'` and an agent named `Builder` posts the body `Dispatched by Builder via koda job <id>`, and never calls `findUserDisplayName`.
7. [unit] `PrAttributionService.attribute` for a job with `requestedByType` `'AGENT'` whose `findAgentDisplayName` answers null posts the body `Dispatched by a koda agent via koda job <id>`.
8. [unit] `responsibleUserOf({ requestedById: 'a1', requestedByType: 'AGENT' })` returns `null`, `responsibleUserOf({ requestedById: 'u1', requestedByType: 'USER' })` returns `'u1'`, and `responsibleUserOf({ requestedById: 'u1' })` returns `'u1'`.
9. [integration] `FleetJobsService.cancel(agentId, p1, <QUEUED job requested by that agent>, true)` called inside `runWithActor({ type: 'AGENT', id: agentId }, ...)` writes a `FleetActivity` row for the job with `actorType` `'AGENT'`, `actorId` the agent's id and `responsibleUserId` null.
10. [integration] `FleetJobTicketEffects.onTerminal([jobId])` for a FAILED job with `requestedByType` `'AGENT'` linked to a ticket writes the failure comment's `TicketEvent` with `actorType` `'agent'` and `actorId` the agent's id.
11. [integration] `FleetTicketEventRecorder.record` called with no `actorType` inside `runWithActor({ type: 'AGENT', id: agentId }, ...)` with `actorId` the agent's id writes the `TicketEvent` with `actorType` `'agent'`.

### US-003: Job and ticket fleet-job routes check keys, and the dispatch effect starts tickets without an edge key (`Workdir: apps/api`)

1. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `POST /projects/p1/fleet/jobs` with a valid body, and no job is created.
2. [integration] A user whose only source in `p1` is a `developer` binding gets 201 from `POST /projects/p1/fleet/jobs` with a valid body.
3. [integration] An agent rostered in `p1` with `AgentRoleEntry` `DEVELOPER` gets 201 from `POST /projects/p1/fleet/jobs` with a valid body, and the stored job has `requestedById` the agent's id and `requestedByType` `'AGENT'`.
4. [integration] After that dispatch, the job's `job.dispatched` `FleetActivity` row has `actorType` `'AGENT'` and `actorId` the agent's id.
5. [integration] An agent rostered in `p1` with no `AgentRoleEntry` gets 200 from `GET /projects/p1/fleet/jobs`, `GET /projects/p1/fleet/jobs/<id>` and `GET /projects/p1/fleet/jobs/<id>/events`.
6. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `POST /projects/p1/fleet/jobs/<id>/requeue` on a FAILED job, which stays FAILED.
7. [integration] A user whose only source in `p1` is a `viewer` binding gets 200 from `POST /projects/p1/fleet/jobs/<id>/cancel` on a QUEUED job whose `requestedById` is that user, and the job becomes CANCELLED.
8. [integration] The same viewer gets 403 with error code `permissions` from `POST /projects/p1/fleet/jobs/<id>/cancel` on a QUEUED job another user requested, which stays QUEUED.
9. [integration] A user whose only source in `p1` is a `developer` binding gets 200 from `POST /projects/p1/fleet/jobs/<id>/cancel` on a QUEUED job another user requested.
10. [integration] A user whose only source in `p1` is a binding of a custom role holding `fleet.job.dispatch`, `fleet.job.read` and `ticket.read` (and no `ticket.transition.start`) gets 201 from `POST /projects/p1/fleet/jobs` with command `RUN` and `ticketRefs` naming a CREATED ticket, and the ticket becomes IN_PROGRESS.
11. [integration] After that dispatch, the ticket's STATUS_CHANGE `TicketActivity` row names the dispatching user as its actor.
12. [unit] `TicketTransitionsService.startForDispatch(slug, ref, principal)` moves a VERIFIED ticket to IN_PROGRESS without calling `PermissionService.can`.
13. [integration] A user whose only source in `p1` is a `viewer` binding gets 200 from `GET /projects/p1/tickets/<ref>/fleet-jobs` and 403 with error code `permissions` from `DELETE /projects/p1/tickets/<ref>/fleet-jobs/<jobId>`, and the link remains.
14. [integration] A user whose only source in `p1` is a `developer` binding gets 204 from `DELETE /projects/p1/tickets/<ref>/fleet-jobs/<jobId>`, and the link is gone.
15. [integration] A non-admin user with no source in `p1` gets 403 with error code `projects` from `GET /projects/p1/fleet/jobs`.

### US-004: Fleet project reads check keys (R10 retired) (`Workdir: apps/api`)

1. [integration] An agent rostered in `p1` with no `AgentRoleEntry` gets 200 from `GET /projects/p1/fleet/jobs/<id>/logs` for a job of `p1`.
2. [integration] The same agent gets 200 from `GET /projects/p1/fleet/jobs/<id>/logs/run/entries` and from `GET /projects/p1/fleet/jobs/<id>/logs/run/raw` for a job with an uploaded `run` log.
3. [integration] A user whose only source in `p1` is a binding of a custom role holding only `ticket.read` gets 403 with error code `permissions` from `GET /projects/p1/fleet/jobs/<id>/logs`.
4. [integration] The same custom-role user gets 403 with error code `permissions` from `GET /projects/p1/fleet/jobs/<id>/bundle`, and a user whose only source in `p1` is a `viewer` binding gets 200 from it for a job with a stored bundle.
5. [integration] An agent rostered in `p1` with no `AgentRoleEntry` gets 200 from `GET /projects/p1/fleet/analytics/spend` with a valid window and from `GET /projects/p1/fleet/jobs/<id>/analytics`.
6. [integration] The same custom-role user gets 403 with error code `permissions` from `GET /projects/p1/fleet/analytics/quality` with a valid window.
7. [integration] An agent rostered in `p1` with no `AgentRoleEntry` gets 200 from `GET /projects/p1/fleet/dashboard`.
8. [integration] The same custom-role user gets 403 with error code `permissions` from `GET /projects/p1/fleet/dashboard`.
9. [integration] A user whose only source in `p1` is a `viewer` binding gets 200 from `GET /projects/p1/fleet/runners` and from `GET /projects/p1/fleet/repos`.
10. [integration] The same custom-role user gets 403 with error code `permissions` from `GET /projects/p1/fleet/runners` and from `GET /projects/p1/fleet/repos`.
11. [unit] `FleetJobLogsController` still carries the class-level throttle of limit 600 per 60000 ms, and its list, entries and raw handlers each carry `REQUIRES_METADATA` with `fleet.job.logs.read`.

### US-005: Schedules check keys, ownership and the owner's dispatch key (`Workdir: apps/api`)

1. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `POST /projects/p1/fleet/schedules` with a valid body, and gets 200 from `GET /projects/p1/fleet/schedules`.
2. [integration] A user whose only source in `p1` is a `developer` binding gets 201 from `POST /projects/p1/fleet/schedules`, and the row has `createdById` that user and `createdByType` `'USER'`.
3. [integration] An agent rostered in `p1` with `AgentRoleEntry` `DEVELOPER` gets 201 from `POST /projects/p1/fleet/schedules`, and the row has `createdById` the agent's id and `createdByType` `'AGENT'`.
4. [integration] A user whose only source in `p1` is a `developer` binding gets 200 from `PATCH /projects/p1/fleet/schedules/<id>` with `{ name: 'Renamed' }` on a schedule it created.
5. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `PATCH /projects/p1/fleet/schedules/<id>`, `POST …/<id>/disable` and `DELETE …/<id>` on a schedule another user created, which is unchanged.
6. [integration] A user whose only source in `p1` is a `project-admin` binding gets 200 from `PATCH /projects/p1/fleet/schedules/<id>` and 204 from `DELETE /projects/p1/fleet/schedules/<id>` on a schedule another user created.
7. [integration] A due schedule whose owner's only source in `p1` is a `developer` binding (no `ProjectMember` row) is dispatched by `ScheduleTicker.runOnce`, creating one job with `scheduleId` that schedule.
8. [integration] A due schedule whose owner's only source in `p1` is a `viewer` binding is disabled by `ScheduleTicker.runOnce` with `disabledReason` `owner_lost_access`, and no job is created.
9. [integration] A due schedule owned by an agent rostered in `p1` with `AgentRoleEntry` `DEVELOPER` is dispatched by `ScheduleTicker.runOnce`, and the job has `requestedById` the agent's id and `requestedByType` `'AGENT'`.
10. [integration] A due schedule with `createdByType` `'AGENT'` whose `Agent` row no longer exists is disabled by `ScheduleTicker.runOnce` with `disabledReason` `owner_lost_access`.
11. [integration] `POST /projects/p1/fleet/schedules/<id>/enable` by a `project-admin` user on a disabled schedule whose owner's only source in `p1` is a `viewer` binding answers 409 with error code `fleet.scheduleOwnerNoAccess`.
12. [integration] `POST /projects/p1/fleet/schedules/<id>/enable` by its owner, whose only source in `p1` is a `developer` binding, on a disabled schedule answers 200, and the schedule is enabled.
13. [unit] `mayDispatch({ exists: true, disabled: false }, new Set(['fleet.job.dispatch']))` returns `true`; with `disabled: true`, or `exists: false`, or an empty key set, it returns `false`.

### US-006: Approvals and budgets check keys (`Workdir: apps/api`)

1. [integration] An agent rostered in `p1` with no `AgentRoleEntry` gets 200 from `GET /projects/p1/fleet/approvals` and `GET /projects/p1/fleet/approvals/<id>`.
2. [integration] An agent rostered in `p1` with `AgentRoleEntry` `DEVELOPER` gets 200 from `POST /projects/p1/fleet/approvals/<id>/decide` with `{ decision: 'allow' }` on a pending bash approval of a RUNNING job requested by a user, an `APPROVAL_ANSWER` command is created, and the approval's `decidedById` is the agent's id.
3. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `POST /projects/p1/fleet/approvals/<id>/decide` with `{ decision: 'allow' }` on a pending bash approval, which stays pending with no command.
4. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `POST /projects/p1/fleet/approvals/<id>/decide` with `{ decision: 'keep_paused' }` on a pending budget approval of a `p1` policy, which stays pending.
5. [integration] A user whose only source in `p1` is a `project-admin` binding gets 200 from the same decide with `{ decision: 'keep_paused' }`, and the approval becomes rejected.
6. [integration] A global admin gets 200 from `POST /fleet/approvals/<id>/decide` with `{ decision: 'allow' }` on a pending bash approval in `p1`.
7. [integration] A non-admin user gets 403 with error code `permissions` from `GET /fleet/approvals`, and a user whose only source in `p1` is a `project-admin` binding gets 403 with error code `permissions` from `POST /fleet/approvals/<id>/decide` on a pending budget approval of a `p1` policy, which stays pending.
8. [integration] A user who is not the thread's creator gets 403 with error code `threads.notCreator` from `POST /projects/p1/fleet/approvals/<id>/decide` on a pending `assistant_action` approval, which stays pending.
9. [integration] For a user whose only source in `p1` is a `developer` binding and with no source in `p2`, with one pending approval in each, `GET /fleet/approval-counts` answers `projects` with `p1` only, `unscoped` 0 and `total` 1.
10. [integration] An agent rostered in `p1`, with one pending approval in `p1`, gets 200 from `GET /fleet/approval-counts` listing `p1` with 1 pending.
11. [integration] A global admin gets `GET /fleet/approval-counts` with both projects and the pending approvals of global policies in `unscoped`, and without a soft-deleted project's pending approval.
12. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `POST /projects/p1/fleet/budgets` with a valid project budget, and a user whose only source in `p1` is a `project-admin` binding gets 201 from it.
13. [integration] A user whose only source in `p1` is a `viewer` binding gets 200 from `GET /projects/p1/fleet/budgets`.
14. [integration] A non-admin user gets 403 with error code `permissions` from `POST /fleet/budgets` with a valid global budget, and a global admin gets 201 from it.
15. [integration] An agent rostered in `p1` with `AgentRoleEntry` `DEVELOPER` gets 403 with error code `fleet.approvalSelfDecide` from `POST /projects/p1/fleet/approvals/<id>/decide` with `{ decision: 'allow' }` on a pending bash approval of a RUNNING job whose `requestedById` is the agent and `requestedByType` is `'AGENT'`; the approval stays pending and no `APPROVAL_ANSWER` command is created.

### US-007: Repo config and knowledge routes check keys (`Workdir: apps/api`)

1. [integration] A user whose only source in `p1` is a `viewer` binding gets 200 from `GET /projects/p1/fleet/repos/<repoId>/nax-files`.
2. [integration] An agent rostered in `p1` with no `AgentRoleEntry` gets 200 from `GET /projects/p1/fleet/jobs/<id>/config-edit` for a config job of `p1`.
3. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `POST /projects/p1/fleet/repos/<repoId>/config-edits` with a valid edit, and no job is created.
4. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `POST /projects/p1/fleet/repos/<repoId>/drift-checks`.
5. [integration] A user whose only source in `p1` is a `developer` binding gets 201 from `POST /projects/p1/fleet/repos/<repoId>/drift-checks`.
6. [integration] An agent rostered in `p1` with `AgentRoleEntry` `DEVELOPER` gets 201 from `POST /projects/p1/fleet/repos/<repoId>/drift-checks`, and the created job has `requestedByType` `'AGENT'`.
7. [integration] A user whose only source in `p1` is a `developer` binding gets 202 from `POST /projects/p1/knowledge/repos/<repoId>/reindex` while indexing is enabled.
8. [integration] The same developer gets 403 with error code `permissions` from `PUT /projects/p1/knowledge/patterns` with `{ patterns: ['handbook/*.md'] }`.
9. [integration] A user whose only source in `p1` is a `project-admin` binding gets 200 from `PUT /projects/p1/knowledge/patterns` with `{ patterns: ['handbook/*.md'] }`.
10. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `POST /projects/p1/knowledge/repos/<repoId>/reindex`.
11. [integration] An agent rostered in `p1` with no `AgentRoleEntry` gets 200 from `GET /projects/p1/knowledge/repos`.
12. [integration] A user whose only source in `p1` is a binding of a custom role holding only `ticket.read` gets 403 with error code `permissions` from `POST /projects/p1/knowledge/search` with `{ query: 'x' }`.

### US-008: Global fleet admin routes declare keys and the activity feed filters by key (`Workdir: apps/api`)

1. [integration] A non-admin user gets 403 with error code `permissions` from `GET /fleet/dashboard` and from `GET /fleet/credential-board`, and a global admin gets 200 from `GET /fleet/dashboard`.
2. [integration] A non-admin user gets 403 with error code `permissions` from `GET /fleet/ingest` and from `POST /fleet/ingest/backfill`.
3. [integration] A non-admin user gets 403 with error code `permissions` from `GET /fleet/repos` and from `POST /fleet/repos` with a valid body.
4. [integration] A non-admin user gets 403 with error code `permissions` from `GET /fleet/runners` and from `POST /fleet/enrollments`, and a global admin gets 200 from `GET /fleet/runners`.
5. [integration] A non-admin user gets 403 with error code `permissions` from `GET /fleet/analytics/spend` with a valid window and from `DELETE /fleet/analytics` with a valid `before` and `confirm`.
6. [integration] With the test hooks enabled, a non-admin user gets 403 with error code `permissions` from `POST /fleet/test-hooks/schedules/<id>/fire`.
7. [integration] An agent with a global `admin` binding gets 200 from `GET /fleet/runners`.
8. [integration] A user whose only source in `p1` is a `project-admin` binding gets 403 with error code `permissions` from `PATCH /fleet/runners/<id>` with a valid body.
9. [integration] For a user whose only source in `p1` is a `developer` binding and with no source in `p2`, `GET /fleet/activity` lists the activity rows of `p1` and none of `p2` or with no project.
10. [integration] A global admin's `GET /fleet/activity` lists rows of `p1`, of `p2` and with no project.
11. [integration] An agent rostered in `p1` with no `AgentRoleEntry` gets 200 from `GET /fleet/activity`, listing the rows of `p1` only.
12. [integration] After an agent rostered in `p1` with `AgentRoleEntry` `DEVELOPER` dispatched a job through `POST /projects/p1/fleet/jobs`, a global admin's `GET /fleet/activity` lists that job's `job.dispatched` row with `actorType` `'AGENT'`.
