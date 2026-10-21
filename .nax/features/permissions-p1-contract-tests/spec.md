# SPEC: Permissions P1g — Catalog Contract and Role Matrix Tests

## Summary

This feature makes the permission catalog of `apps/api` checkable as a whole, before the cleanup features delete the legacy mechanisms:
- **Every surface declares its keys.** Every surface carries its catalog key: the 22 HTTP routes that have no `@Requires` today (runner protocol, MCP, health, the four live streams, roles and role bindings), and the 30 kinds of system writer, through a new `@SystemWriter(key)` class decorator. `RequiresGuard` learns runner keys: a runner key passes only for a runner principal.
- **A catalog contract test** boots the app and walks every controller route, every assistant tool and every system writer. It checks that each one declares keys, that every declared key exists in the catalog, that every guard-enforced route lists `RequiresGuard`, and that every catalog key is declared somewhere. The only exceptions are the five keys whose surface arrives in P2 or P3.
- **A role allow/deny matrix test** records, for every seeded role and every catalog key, what `PermissionService.can` answers globally and in a project, in a committed file. It pins the Appendix A cells and the `.own` ownership cases.
- **The removed keys are folded**, as Appendix A of the design specifies:
  - `project.agent.add` → `member.add`;
  - `project.agent.remove` → `member.remove`;
  - `member.role.update` → `role.binding.manage`;
  - `project.agent.update` → `agent.update` (global);
  - `agent.roles.update` → `agent.update`.

This is the seventh feature implementing phase P1 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md`. The order is: roles (PR #308), membership (PR #310), enforce-core (PR #313), enforce-fleet (PR #314), enforce-assistant (PR #315), enforce-integrations (PR #316), then cleanup, split 2026-10-21 into four features: **contract-tests**, retire-checks, fixtures-to-bindings and drop-legacy. `permissions-p1-web` runs in parallel and must land before drop-legacy. The design doc's phasing section lists five features and predates every split.

## Motivation

Enforcement is complete: since enforce-integrations, every route family decides through a permission key. Nothing yet proves it stays that way:
- A new route without `@Requires` is silently open to any authenticated principal. No test notices.
- A seeded role whose entries drift, for example a wildcard that starts matching a new key, changes who may do what with no test failing.
- Five catalog keys (`project.agent.*`, `member.role.update`, `agent.roles.update`) duplicate what `member.*`, `role.binding.manage` and `agent.update` express. One of them lets a Project Admin edit an agent's global record (review finding A/SEC-2).

The next feature, retire-checks, deletes the CASL factory, the legacy decorators and the in-controller membership asserts. The contract and matrix tests are its safety net. A deletion that leaves a route without a key, or changes what a role can do, fails CI.

**Rulings that bind this feature** (user, 2026-10-21):
- **Cleanup is four features**, in order: contract-tests, retire-checks, fixtures-to-bindings, drop-legacy. drop-legacy waits for `permissions-p1-web`.
- **`project.agent.update` folds into the global `agent.update` now**, per the design. A Project Admin is refused `PATCH /projects/:slug/agents/:agentSlug` with 403 `permissions`. A global Owner or Admin may still update a rostered agent, and an agent may still update itself (graceful OFFLINE). Enforce-core's AC-17 ("a project-admin binding alone updates a rostered agent's status") is inverted.

## Design

### Rulings that bind every story

1. **Conventions carry over** from `.nax/features/permissions-p1-enforce-core/spec.md` ("Rulings that bind every story"), unless this spec says otherwise:
   - `PermissionsModule` is `@Global()`;
   - `RequiresGuard` needs no provider entry;
   - a refused key answers 403 `new ForbiddenAppException({}, 'permissions')`;
   - DB-backed tests that need the system roles run `SystemRoleSeeder.onApplicationBootstrap()` after `resetDb`, or boot the app.
2. **Declaring a key on a route.** `@Requires(keys, { enforcedBy: 'service' })` means the handler, its service or a route-specific guard checks the access, and `RequiresGuard` only records the keys. The roles and role-bindings routes, the four live streams and the memory writes use it. Every other route this feature touches is guard-enforced: `@UseGuards(RequiresGuard)` is in the same class or handler, as `apps/api/src/auth/auth.controller.ts` does it.
3. **No access changes except the fold.** Declaring a key on the runner, MCP, health, live, roles and memory routes changes no response for any caller. The runner rule (below) admits exactly the principals `CombinedAuthGuard` already admits on a runner route. `mcp.access` and `notification.read` are implicit keys, and `health.read` is public. Only US-001's fold changes who may call a route.
4. **`api-testing.md` endpoint e2e rule, ruled as for enforce-core.** This spec's integration ACs pin the route-level outcomes the fold changes. Only existing e2e cases that a correct implementation breaks are edited (see Modifies). The other route declarations change no response, so no e2e case is added for them.
5. **No approval and no audit change** (P3 and P2).

### Catalog changes (US-001)

All in `apps/api/src/permissions/catalog.ts` and the `proposed_key` / `catalog_scope` columns of `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv`, whose rows `catalog.spec.ts` re-reads:

| TSV row (route) | Baseline `proposed_key` / `catalog_scope` | Target |
|:--|:--|:--|
| `PATCH /agents/:slug/update-roles` | `agent.roles.update` / `global` | `agent.update` / `global` |
| `PATCH /projects/:slug/members/:userId` | `member.role.update` / `project` | `role.binding.manage` / `project` |
| `POST /projects/:slug/agents` | `project.agent.add` / `project` | `member.add` / `project` |
| `DELETE /projects/:slug/agents/:agentSlug` | `project.agent.remove` / `project` | `member.remove` / `project` |
| `PATCH /projects/:slug/agents/:agentSlug` | `project.agent.update` / `project` | `agent.update` / `global` |

- `role.binding.manage` now has an inventory row, so it moves out of `NEW_KEY_SCOPES` and into `INVENTORY_SCOPE_ROWS` (scope `project`). It must not appear in both: `CATALOG_KEYS` concatenates them, and the catalog must hold no duplicate.
- The catalog goes from 226 to 221 keys.
- `agent.update` keeps scope `global`: every row naming it is `global`.
- Seeded role contents are unchanged:
  - Project Admin's `*` covers `member.add`, `member.remove` and `role.binding.manage`, just as it covered the folded keys.
  - `agent.update` stays with global Owner and Admin.
  - No seeded role names a folded key explicitly.
- `ProjectsController.updateProjectAgent` asks `permissions.can(principal, 'agent.update')` (two arguments, no context), in place of `can(principal, 'project.agent.update', { projectId })`. Its parameter list is unchanged: `@CurrentProject() ctx` stays, so the existing unit cases keep calling it with five arguments. The self-update rule (`isAgentPrincipal(principal) && principal.slug === agentSlug`) and the roster lookup are unchanged.
- The `@ApiOperation` / `@ApiResponse` texts of the five routes name the new keys, and `openapi.json` is regenerated with `bun run api:export-spec`.

### Route declarations (US-002, US-003)

| Route | Key(s) | Enforced by | Notes |
|:--|:--|:--|:--|
| `PUT /fleet/runner/jobs/:jobId/bundle` (`BundleUploadController.upload`) | `runner.bundle.upload` | guard | class-level `@UseGuards(RequiresGuard)` next to `@RunnerRoute()` |
| `POST /fleet/runner/jobs/:jobId/tools/:name` (`RunnerToolController.call`) | `runner.tool.call` | guard | same |
| `PUT /fleet/runner/jobs/:jobId/logs/:stream` (`LogUploadController.append`) | `runner.log.append` | guard | same |
| `GET /fleet/runner/jobs/:jobId/config-edit` (`RunnerConfigEditController.get`) | `runner.config.read` | guard | same |
| `GET /fleet/runner/me` (`RunnerApiController.me`) | `runner.self.read` | guard | same |
| `POST /fleet/runner/enroll` (`RunnerApiController.enroll`) | `runner.enroll` | service | `@Public()`; `EnrollmentService.enroll` checks the enrollment token |
| `POST /fleet/runner/sync` (`RunnerSyncController.sync`) | `runner.sync` | guard | same as the first row |
| `POST`, `GET`, `DELETE /mcp` (`McpController.post/get/delete`) | `mcp.access` | guard | implicit key; the controller's user refusal is unchanged |
| `GET /health` (`HealthController.check`) | `health.read` | guard | `@Public()` kept, plus `@UseGuards(RequiresGuard)` |
| `GET /projects/:slug/threads/:id/events` (`ThreadEventsController.events`) | `thread.read` | service | `ThreadEventsGuard` already checks `thread.read` |
| `GET /threads/:id/events` (`WorkspaceThreadEventsController.events`) | `thread.workspace.read` | service | `WorkspaceThreadEventsGuard` checks the caller owns the thread |
| `GET /projects/:slug/events` (`LiveController.events`) | `project.read` | service | the handler's membership check stays |
| `GET /me/events` (`MeLiveController.events`) | `notification.read` | service | implicit key; the handler's user-only check stays |
| `GET /roles` (`RolesController.list`) | `role.read` | service | `RoleAdminService.assertCan` |
| `POST /roles`, `PATCH /roles/:id`, `DELETE /roles/:id` | `role.manage` | service | same |
| `GET /role-bindings` (`RoleBindingsController.list`) | `role.read` | service | same |
| `POST /role-bindings`, `DELETE /role-bindings/:id` | `role.binding.manage`, `role.binding.global`, `role.binding.owner` (mode `any`) | service | `RoleAdminService` picks the key from the binding's scope and role |
| `POST /memory` (`MemoryController.createMemory`) | `memory.create`, `memory.update` | service | unchanged check; `memory.update` is the attribution and replace key the service already asks |
| `POST /memory/decisions` (`MemoryController.recordDecision`) | `memory.decision.record`, `memory.update` | service | same |

`thread.workspace.read`, `project.read` and `notification.read` on the three live streams name the key their access corresponds to. Making those handlers ask `PermissionService.can` for it is out of scope (retire-checks replaces their membership checks).

### `RequiresGuard`: runner keys

`apps/api/src/permissions/requires.guard.ts`, `passes`:

Baseline (locate only):
```ts
const entry = findCatalogEntry(key);
if (!entry) return false;
if (entry.access === 'public') return true;
if (!principal) return false;
```

Target:
```ts
const entry = findCatalogEntry(key);
if (!entry) return false;
if (entry.access === 'public') return true;
// A runner key is held by runner principals only; PermissionService.can never grants one.
if (entry.access === 'runner') return principal?.actorType === 'runner';
if (!principal) return false;
```

### `@SystemWriter(key)` (US-004)

New file `apps/api/src/permissions/system-writer.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common';
import { findCatalogEntry } from './catalog';

export const SYSTEM_WRITER_METADATA = 'koda:system-writer';

/**
 * Declares the catalog key of a class that writes on the system's own behalf (a sweeper, a cron
 * processor, an outbox subscriber, a webhook intake). The catalog contract test reads it back.
 * Throws at decoration time unless `key` is a catalog key with access `system`.
 */
export const SystemWriter = (key: string): ClassDecorator => {
  if (findCatalogEntry(key)?.access !== 'system') {
    throw new Error(`@SystemWriter needs a system catalog key, got '${key}'`);
  }
  return SetMetadata(SYSTEM_WRITER_METADATA, key);
};
```

The 35 classes and their keys. Paths are under `apps/api/src/`; the inventory's `evidence` column names them:

| Class | File | Key |
|:--|:--|:--|
| `EmailDispatcher` | `email/email-dispatcher.ts` | `system.email.dispatch` |
| `ApprovalExpirySweeper` | `fleet/approvals/approval-expiry-sweeper.ts` | `system.approval.expire` |
| `PendingActionExpirySweeper` | `fleet/assistant/actions/pending-action-expiry.sweeper.ts` | `system.assistant-action.expire` |
| `BudgetSweeper` | `fleet/budgets/budget-sweeper.ts` | `system.budget.window-reset` |
| `BundleIngestSweeper` | `fleet/ingest/bundle-ingest.sweeper.ts` | `system.ingest.drain` |
| `KnowledgePoller` | `fleet/knowledge/knowledge-poller.ts` | `system.knowledge.poll` |
| `KnowledgeIndexQueue` | `fleet/knowledge/knowledge-index.queue.ts` | `system.knowledge.index` |
| `FleetLogRetentionProcessor` | `fleet/logs/fleet-log-retention.processor.ts` | `system.log.retention` |
| `EnrollmentRetentionProcessor` | `fleet/runners/enrollment-retention.processor.ts` | `system.enrollment.retention` |
| `ScheduleTicker` | `fleet/schedules/schedule-ticker.ts` | `system.schedule.dispatch` |
| `FleetSweeper` | `fleet/sync/fleet-sweeper.ts` | `system.job.crash-silent-runner` |
| `FleetPrStateRefresher` | `fleet/tickets/fleet-pr-state.refresher.ts` | `system.ticket-link.pr-refresh` |
| `FleetHealthDetector` | `notifications/fleet/fleet-health.detector.ts` | `system.health.detect` |
| `MemoryGovernanceProcessor` | `memory/memory-governance.processor.ts` | `system.memory.govern` |
| `NotificationRetentionProcessor` | `notifications/notification-retention.processor.ts` | `system.notification.retention` |
| `OutboxRetentionProcessor` | `outbox/outbox-retention.processor.ts` | `system.outbox.retention` |
| `CronOptimizeStrategy` | `rag/strategies/cron-optimize.strategy.ts` | `system.rag.optimize` |
| `CounterOptimizeStrategy` | `rag/strategies/counter-optimize.strategy.ts` | `system.rag.optimize` |
| `ManualOptimizeStrategy` | `rag/strategies/manual-optimize.strategy.ts` | `system.rag.optimize` |
| `VcsPollingService` | `vcs/vcs-polling.service.ts` | `system.vcs.poll-issues` |
| `VcsPrSyncService` | `vcs/vcs-pr-sync.service.ts` | `system.vcs.pr-merge-transition` |
| `VcsWebhookService` | `vcs/vcs-webhook.service.ts` | `system.vcs.webhook-intake` |
| `CiWebhookService` | `ci-webhook/ci-webhook.service.ts` | `system.ci.ticket-create` |
| `WebhookDeliveryHandler` | `webhook/webhook-delivery.handler.ts` | `system.webhook.deliver` |
| `MemoryOutboxSubscriber` | `memory/memory-outbox.subscriber.ts` | `system.memory.extract-from-event` |
| `KbTicketLifecycleSubscriber` | `rag/kb-ticket-lifecycle.subscriber.ts` | `system.kb.ticket-index` |
| `EntityGraphOutboxSubscriber` | `entity-graph/entity-graph-outbox.subscriber.ts` | `system.entity-graph.write` |
| `CodeIntelOutboxSubscriber` | `code-intel/code-intel-outbox.subscriber.ts` | `system.codeintel.index-commit` |
| `TicketNotificationSubscriber` | `notifications/ticket-notification.subscriber.ts` | `system.notification.ticket` |
| `FleetApprovalRequestedSubscriber` | `notifications/fleet/fleet-approval-requested.subscriber.ts` | `system.notification.fleet` |
| `FleetBudgetIncidentSubscriber` | `notifications/fleet/fleet-budget-incident.subscriber.ts` | `system.notification.fleet` |
| `FleetHealthAlertSubscriber` | `notifications/fleet/fleet-health-alert.subscriber.ts` | `system.notification.fleet` |
| `FleetJobOutcomeSubscriber` | `notifications/fleet/fleet-job-outcome.subscriber.ts` | `system.notification.fleet` |
| `ThreadIngestHook` | `fleet/threads/ingest/thread-ingest.module.ts` | `system.thread.ingest` |
| `FanOutPublisher` | `outbox/fan-out-publisher.ts` | `system.outbox.dispatch` |

- `ThreadIngestHook` is a module-local class today; it becomes `export class ThreadIngestHook` so a test can import it. Its module registration is unchanged.
- All three FTS optimize strategies are decorated. `RagModule`'s `FTS_OPTIMIZE_STRATEGY` factory builds exactly one of them from `FTS_OPTIMIZE_STRATEGY` (default `counter`), and each runs `optimizeInBackground` as the system, so `system.rag.optimize` is declared whatever the environment.
- The 35 classes cover exactly the 30 catalog keys with access `system`.

### Pending-surface keys (US-006)


`apps/api/src/permissions/catalog.ts` gains:

```ts
/**
 * Role keys whose surface arrives in a later phase: approvals and their policies (P3), the audit log (P2),
 * and deciding an assistant action as an approval type (P3). No route, tool or system writer declares
 * them yet; the catalog contract test refuses an undeclared key unless it is listed here, and refuses a
 * listed key once a surface declares it, so the list shrinks as P2 and P3 land.
 */
export const PENDING_SURFACE_KEYS: ReadonlySet<string> = new Set([
  'approval.decide',
  'approval.policy.read',
  'approval.policy.manage',
  'audit.read',
  'fleet.approval.decide.assistant',
]);
```

### The contract checker (US-006) and collector (US-007)

New file `apps/api/src/permissions/test-helpers/permission-contract.ts` (test support, next to `in-memory-permissions.ts`). US-006 creates it with the types and `findContractViolations`; US-007 adds `collectPermissionDeclarations`:

```ts
export interface RouteDeclaration {
  /** `"<METHOD> /<controller path>/<handler path>"`, for violation messages. */
  route: string;
  /** Handler metadata, else class metadata, as RequiresGuard reads it. */
  requires: RequiresMetadata | undefined;
  /** Whether RequiresGuard is among the class's or the handler's `@UseGuards`. */
  hasRequiresGuard: boolean;
}
export interface ToolDeclaration { tool: string; key: string }
export interface SystemWriterDeclaration { writer: string; key: string }
export interface PermissionDeclarations {
  routes: readonly RouteDeclaration[];
  tools: readonly ToolDeclaration[];
  systemWriters: readonly SystemWriterDeclaration[];
}

export type ContractViolation =
  | { kind: 'route-without-key'; route: string }
  | { kind: 'unknown-key'; source: string; key: string }
  | { kind: 'guard-missing'; route: string }
  | { kind: 'unused-key'; key: string }
  | { kind: 'pending-key-declared'; source: string; key: string };

/** Walks a booted Nest app's controllers and providers, and the tool registry. */
export function collectPermissionDeclarations(
  modules: ModulesContainer,
  registry: AssistantToolRegistry,
): PermissionDeclarations;

/** Every violation; callers compare as a set (the order is not part of the contract). */
export function findContractViolations(
  declarations: PermissionDeclarations,
  catalog: readonly PermissionCatalogEntry[] = PERMISSION_CATALOG,
  pending: ReadonlySet<string> = PENDING_SURFACE_KEYS,
): ContractViolation[];
```

**`collectPermissionDeclarations`:**
- For every module in `ModulesContainer`, each controller wrapper's `metatype` contributes one `RouteDeclaration` per prototype method carrying Nest's `METHOD_METADATA`. The path comes from `PATH_METADATA` on the class and the method, and the method name from `RequestMethod`.
- Each provider wrapper contributes a `SystemWriterDeclaration` when `SYSTEM_WRITER_METADATA` is set on its `metatype` or on `instance.constructor`. The second source covers factory-built providers such as the FTS optimize strategy.
- A class reached through several wrappers (`useExisting` aliases, re-exports) is reported once.
- Tools come from `registry.list()`, as `{ tool: descriptor.name, key }`.

**`findContractViolations` rules:**
1. A route whose `requires` is undefined is `route-without-key`.
2. Every key of a route, tool or writer that is not the `key` of an entry in the `catalog` argument is `unknown-key`, with `source` the route, tool name or writer class name. (The checker never calls the global `findCatalogEntry`, so a unit test can pass a small catalog of made-up keys.)
3. A route whose `requires.enforcedBy` is `'guard'` and whose `hasRequiresGuard` is false is `guard-missing`.
4. Every catalog key declared by no route, tool or writer, and not in `pending`, is `unused-key`.
5. Every key in `pending` that some route, tool or writer declares is `pending-key-declared`.

`AssistantToolRegistry` (`apps/api/src/fleet/assistant/assistant-tool.registry.ts`) gains `list(): readonly AssistantTool[]`, which returns the registered tools in registration order.

### The role matrix (US-005)

A unit spec, `apps/api/src/permissions/role-matrix.spec.ts`, builds a real `PermissionService` over `InMemoryPermissionStore` (as `permission.service.spec.ts` does), with project `p1` known to the store.
- **One row per seeded role R** (`SYSTEM_ROLES`, 11 roles).
- **The row's principal:**
  - for R = `agent`: an AGENT principal bound to `agent` globally;
  - otherwise: a USER principal (legacy role `MEMBER`) bound to the global `member` baseline, plus R itself — globally when R is a GLOBAL role (`owner`, `admin`), in `p1` when R is a PROJECT role. For R = `member`, the baseline binding alone.

  The baseline is bound explicitly, so the matrix does not depend on `PermissionService`'s no-binding fallback, which drop-legacy removes.
- **One column per catalog key K** (`PERMISSION_CATALOG`, 221 keys).
- **Each cell** is the pair `[can(principal, K, {}).reason, can(principal, K, { projectId: 'p1' }).reason]`. A fresh store and service are built per row, so no cached keys carry between rows.
- **The file.** The matrix is serialised as JSON, with roles in `SYSTEM_ROLES` order and keys in catalog order. It is compared with the committed file `apps/api/src/permissions/__snapshots__/role-matrix.json` through Vitest's file snapshot. A change to the catalog, a seeded role or `PermissionService.can` shows up as a reviewed diff of that file. `bunx vitest run -u` regenerates it.

**Pinned cells.** Taken from Appendix A, not from the file, so the committed matrix is checked against the design at least at these points. `g` is the `global` reason, `p1` the project reason; all were executed against `PermissionService` at `07b11c0a` (with the fold's two `project-admin` keys checked by their pre-fold holders):

| Role | Key | Context | Reason |
|:--|:--|:--|:--|
| `viewer` | `ticket.create` | p1 | `not-granted` |
| `viewer` | `comment.create` | p1 | `granted` |
| `developer` | `ticket.transition.start` | p1 | `granted` |
| `developer` | `ticket.delete` | p1 | `not-granted` |
| `developer` | `comment.update` | p1 | `not-owner` |
| `project-admin` | `member.add` | p1 | `granted` |
| `project-admin` | `role.binding.manage` | p1 | `granted` |
| `project-admin` | `agent.update` | g | `not-granted` |
| `admin` | `role.binding.owner` | g | `not-granted` |
| `owner` | `role.binding.owner` | g | `granted` |
| `agent` | `role.binding.owner` | g | `principal-type` |
| `agent` | `mcp.access` | g | `implicit` |
| `member` | `thread.workspace.create` | g | `granted` |
| `member` | `project.create` | g | `not-granted` |
| `reviewer` | `ticket.transition.close` | p1 | `granted` |
| `triager` | `ticket.transition.reject` | p1 | `granted` |
| `approver` | `approval.decide` | p1 | `granted` |

**Ownership.** The `.own` ACs loop over every cell whose `p1` reason is `not-owner`. `resource.createdBy` is a `PrincipalRef`: the row principal's own ref is `{ type: 'USER', id }` (or `'AGENT'` for the `agent` row); "another principal" is `{ type: 'USER', id: 'someone-else' }`.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| A runner key on a request with a user or agent principal, or with none | `RequiresGuard` refuses with 403 `permissions` (US-002). `CombinedAuthGuard` refuses non-runner keys on runner routes first, as today. |
| `@SystemWriter` given a key that is not a catalog key with access `system` | Throws `Error` at decoration time, so the API fails at import, not at run time (US-004) |
| A Project Admin (no global Owner or Admin binding) calling `PATCH /projects/:slug/agents/:agentSlug` for another agent | 403 `permissions`; the agent is unchanged (US-001) |
| `POST /fleet/runner/enroll` with no principal | `RequiresGuard` lets the service-enforced route through; `EnrollmentService.enroll` decides, as today (US-002) |

### Integration

Symbols this feature **reads** (verified at `07b11c0a`):
- `Requires`, `REQUIRES_METADATA`, `RequiresMetadata` — `apps/api/src/permissions/requires.decorator.ts`
- `PermissionService.can(principal, key, ctx)`, `PermissionDecision['reason']` — `apps/api/src/permissions/permission.service.ts`, `permissions.types.ts`
- `findCatalogEntry`, `PERMISSION_CATALOG`, `PermissionCatalogEntry`, `OWNABLE_KEYS` — `apps/api/src/permissions/catalog.ts`
- `expandEntries` — `apps/api/src/permissions/entry-matcher.ts`
- `SYSTEM_ROLES` — `apps/api/src/permissions/system-roles.ts`
- `InMemoryPermissionStore` (`bind`, `addUser`, `agents`, `projects`, `roleRepo()`, `bindingRepo()`), `FakeCacheManager` — `apps/api/src/permissions/test-helpers/in-memory-permissions.ts`
- `PermissionCache` — `apps/api/src/permissions/permission-cache.ts`
- `RunnerRoute` — `apps/api/src/auth/guards/runner-route.decorator.ts`
- `bootHttpApp` — `apps/api/test/helpers/http-app.ts`
- `ModulesContainer` — `@nestjs/core`; `PATH_METADATA`, `METHOD_METADATA`, `GUARDS_METADATA` — `@nestjs/common/constants`; `RequestMethod` — `@nestjs/common`

Symbols this feature **changes**. The baseline only locates the code; implement the target.

| Symbol | Baseline (locate only) | Target |
|:--|:--|:--|
| `INVENTORY_SCOPE_ROWS`, `NEW_KEY_SCOPES` (catalog) and the inventory TSV | five folded keys present; `role.binding.manage` in `NEW_KEY_SCOPES` | folded keys absent; `role.binding.manage` an inventory row (`project`), not a new key |
| `PENDING_SURFACE_KEYS` (catalog) | absent | the five keys above |
| `RequiresGuard.passes` | runner keys fall through to `PermissionService.can` (denied) | runner keys pass for a runner principal only |
| `ProjectsController.addProjectAgent` / `removeProjectAgent` | `@Requires('project.agent.add')` / `('project.agent.remove')` (guard, project) | `@Requires('member.add')` / `('member.remove')` (guard, project) |
| `ProjectsController.updateProjectAgent` | `@Requires('project.agent.update', service)`; `can(principal, 'project.agent.update', { projectId })` | `@Requires('agent.update', service)`; `can(principal, 'agent.update')` |
| `ProjectMembersController.updateRole` | `@Requires('member.role.update')` | `@Requires('role.binding.manage')` |
| `AgentsController.updateRoles` | `@Requires('agent.roles.update')` | `@Requires('agent.update')` |
| The 22 undeclared routes | no `REQUIRES_METADATA` | the route table above |
| `MemoryController.createMemory` / `recordDecision` | `@Requires('memory.create' \| 'memory.decision.record', svc)` | plus `memory.update` |
| `ThreadIngestHook` | module-local class | exported class |
| The 35 system writer classes | no metadata | `@SystemWriter(key)` |
| `AssistantToolRegistry` | `register`, `get` | plus `list()` |

## Out of Scope

- Deleting `KodaCaslAbilityFactory`, `@RequiredPermission`, `@ProjectPermission`, `@ProjectRoles`, `exemptAgents`, `canOverrideClose`, `withProjectRole`, `canManageMembers`, `ProjectAccessService.assertProjectMembership` / `assertProjectAdmin`, `AssistantTool.permission` / `ToolPermission`, `TicketTransitionsService.assertTransitionPermission`, `FleetActivityService.memberProjectIds`, the unreachable IN_PROGRESS → VERIFIED transition rule and the i18n messages `skills.principal` / `skills.projectPrincipal` is out of scope (`permissions-p1-retire-checks`).
- Making the live-stream handlers (`LiveController`, `MeLiveController`, `WorkspaceThreadEventsGuard`) ask `PermissionService.can` for their declared key in place of their membership, user-only or ownership checks is out of scope (`permissions-p1-retire-checks`).
- Moving test fixtures from `ProjectMember`, `AgentProject`, `AgentRoleEntry` and `User.role` rows to role bindings is out of scope (`permissions-p1-fixtures-to-bindings`).
- Removing the legacy union and the baseline fallback in `PermissionService`, dropping the legacy tables and columns, deleting `PATCH /agents/:slug/update-roles` and `AGENT_PROJECT_SCOPING` are out of scope (`permissions-p1-drop-legacy`).
- Replacing `PATCH /projects/:slug/agents/:agentSlug` with the binding routes, and the web pages for roles, bindings and the merged member list, are out of scope (`permissions-p1-web`).
- Surfaces for the five pending keys (approval decide and policies, the audit log, assistant-action approvals) are out of scope (P2, P3).
- Rewriting the stored permissions of an existing database's unlocked system roles or custom roles that name a folded key is out of scope: koda-wk is reset by decision 2, and `SystemRoleSeeder` re-seeds system roles.
- Regenerating the CLI client (`apps/cli/src/generated/`) is out of scope; only `openapi.json` is regenerated, and only route descriptions change.
- Updating the design doc's phasing section and Appendix A notes for the four-way cleanup split is out of scope for the run; it is a manual doc edit.
- US-002 only: changing how `CombinedAuthGuard` authenticates runner keys or fences jobs (`runnerId` + `leaseEpoch`) is out of scope; only the key declaration and the guard's runner rule are added.

## Stories

1. **US-001: Fold the removed keys** — `Workdir: apps/api` — No dependencies. Removes `project.agent.add`, `project.agent.remove`, `project.agent.update`, `member.role.update` and `agent.roles.update` from the catalog and the inventory TSV. Their five routes declare `member.add`, `member.remove`, `agent.update` (global, service-checked), `role.binding.manage` and `agent.update`. The catalog and route changes ship together because a route naming a removed key would fail closed. The route descriptions are reworded, and `openapi.json` is regenerated.
2. **US-002: Runner routes declare runner keys** — `Workdir: apps/api` — No dependencies. `RequiresGuard` passes a runner key for a runner principal only. The six runner-route controllers add class-level `RequiresGuard`, and each of their seven routes declares its `runner.*` key (enroll service-enforced).
3. **US-003: The remaining routes declare keys** — `Workdir: apps/api` — No dependencies. Covers the MCP, health, four live-stream, roles and role-bindings routes, and adds `memory.update` to the two memory write routes, per the route table.
4. **US-004: System writers declare keys** — `Workdir: apps/api` — No dependencies. Adds `@SystemWriter(key)`, exports `ThreadIngestHook`, and decorates the 35 system writer classes.
5. **US-005: Role allow/deny matrix** — `Workdir: apps/api` — Depends on US-001. Adds the matrix spec, its committed snapshot file, the Appendix A pinned cells and the `.own` cases.
6. **US-006: Contract checker** — `Workdir: apps/api` — Depends on US-001. Adds `PENDING_SURFACE_KEYS` and `findContractViolations` with its declaration types, unit-tested on synthetic declarations.
7. **US-007: Contract collector and the booted-app contract test** — `Workdir: apps/api` — Depends on US-002, US-003, US-004, US-006. Adds `AssistantToolRegistry.list()` and `collectPermissionDeclarations`, and an integration spec that boots the app and asserts no violations.

This is one capability, the catalog's contract and matrix, at seven stories. The checker and the collector are separate stories only to keep each under the AC cap.

### Context Files

**US-001**
- `apps/api/src/permissions/catalog.ts` — `INVENTORY_SCOPE_ROWS` and `NEW_KEY_SCOPES`, edited here
- `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` — the five rows edited here, re-read by `catalog.spec.ts`
- `apps/api/src/projects/projects.controller.ts` — the three roster routes, edited here
- `apps/api/src/projects/members/project-members.controller.ts` — `updateRole`, edited here
- `apps/api/src/agents/agents.controller.ts` — `updateRoles`, edited here

**US-002**
- `apps/api/src/permissions/requires.guard.ts` — `passes`, edited here
- `apps/api/src/fleet/runners/runner-api.controller.ts` — `enroll` (public) and `me`, edited here
- `apps/api/src/fleet/sync/runner-sync.controller.ts` — `sync`, edited here
- `apps/api/src/fleet/artifacts/bundle-upload.controller.ts` — `upload`, edited here
- `apps/api/src/fleet/logs/log-upload.controller.ts` — `append`, edited here

The other two runner controllers, `apps/api/src/fleet/assistant/runner-tool.controller.ts` and `apps/api/src/fleet/repo-config/runner-config-edit.controller.ts`, are edited the same way.

**US-003**
- `apps/api/src/fleet/assistant/mcp/mcp.controller.ts` — the three MCP routes, edited here
- `apps/api/src/health/health.controller.ts` — `check`, edited here
- `apps/api/src/live/live.controller.ts` — the project stream, edited here
- `apps/api/src/permissions/roles.controller.ts` — the four roles routes, edited here
- `apps/api/src/permissions/role-bindings.controller.ts` — the three binding routes, edited here

Also edited, per the route table: `apps/api/src/live/me-live.controller.ts`, `apps/api/src/fleet/threads/thread-events.controller.ts`, `apps/api/src/fleet/threads/workspace-thread-events.controller.ts` and `apps/api/src/memory/memory.controller.ts`.

**US-004**
- `apps/api/src/permissions/catalog.ts` — the `system.*` keys
- `apps/api/src/fleet/threads/ingest/thread-ingest.module.ts` — `ThreadIngestHook`, exported here
- `apps/api/src/rag/rag.module.ts` — the `FTS_OPTIMIZE_STRATEGY` factory (read only)
- `apps/api/src/notifications/notifications.module.ts` — registers seven of the writers (read only)
- `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` — the `system` rows naming each writer (read only)

**US-005**
- `apps/api/src/permissions/permission.service.spec.ts` — how a real `PermissionService` is built over the in-memory store
- `apps/api/src/permissions/test-helpers/in-memory-permissions.ts` — the store
- `apps/api/src/permissions/system-roles.ts` — the seeded roles (Appendix A)
- `apps/api/src/permissions/catalog.ts` — `PERMISSION_CATALOG`, `OWNABLE_KEYS`

**US-006**
- `apps/api/src/permissions/catalog.ts` — gains `PENDING_SURFACE_KEYS` here
- `apps/api/src/permissions/requires.decorator.ts` — `RequiresMetadata`, the route declaration shape

**US-007**
- `apps/api/src/permissions/test-helpers/permission-contract.ts` — created by US-006, extended here with the collector
- `apps/api/src/fleet/assistant/assistant-tool.registry.ts` — gains `list()` here
- `apps/api/src/permissions/system-writer.decorator.ts` — created by US-004, read here
- `apps/api/test/helpers/http-app.ts` — `bootHttpApp`

### Creates

**US-004**
- `apps/api/src/permissions/system-writer.decorator.ts`

**US-005**
- `apps/api/src/permissions/role-matrix.spec.ts`
- `apps/api/src/permissions/__snapshots__/role-matrix.json`

**US-006**
- `apps/api/src/permissions/test-helpers/permission-contract.ts`

**US-007**
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts`

### Modifies

**US-001**
- `apps/api/src/permissions/catalog.spec.ts` — its `NEW_KEY_SCOPES` copy lists `role.binding.manage`, so with the inventory now naming it, "holds exactly the inventory keys plus the keys the design adds, with no duplicates" would expect it twice. Separately, "US-001 AC-13: the five agent-management keys are scoped globally" lists `agent.roles.update`. The replacing invariant: `NEW_KEY_SCOPES` no longer holds `role.binding.manage`, which is derived from its inventory row with scope `project`; AC-13 checks the four remaining agent-management keys; every other derivation is unchanged.
- `apps/api/src/projects/projects.controller.spec.ts` — its table of migrated routes pins `['addProjectAgent', ['project.agent.add'], 'guard']`, `['removeProjectAgent', ['project.agent.remove'], 'guard']` and `['updateProjectAgent', ['project.agent.update'], 'service']`. Its `updateProjectAgent` cases assert `permissions.can` was called with `(principal, 'project.agent.update', { projectId: 'proj-1' })`. The replacing invariant: the table pins `member.add` (guard), `member.remove` (guard) and `agent.update` (service); the cases assert `can` was called with exactly `(principal, 'agent.update')`; the handler is still called with five arguments; the self-update, roster 404 and refusal outcomes are unchanged. The case titled "a project admin (global MEMBER with a project-admin binding) is admitted by its can answer" is renamed to say the caller holds `agent.update`.
- `apps/api/src/projects/members/project-members.controller.spec.ts` — its route table pins `['updateRole', 'member.role.update']`. The replacing invariant: `updateRole` declares `role.binding.manage`; the other rows are unchanged.
- `apps/api/test/integration/permissions/core-project-routes.integration.spec.ts` — "AC-17: a project-admin binding alone updates a rostered agent's status with 200" expects 200 for the `padmin` user. The replacing invariant (ruling 2026-10-21): that user gets 403 with error code `permissions` and the agent's status stays `ACTIVE`; AC-15 (self-update) and AC-16 (peer refused) are unchanged; the comments naming `project.agent.add` / `project.agent.remove` name `member.add` / `member.remove`.
- `apps/api/test/integration/permissions/core-members-invites.integration.spec.ts` — its comment above AC-3 says the PATCH/DELETE member routes "need member.role.update / member.remove". The replacing invariant: the comment names `role.binding.manage` / `member.remove`; every case is unchanged (Project Admin holds both keys, as before).
- `openapi.json` — the five routes' operation summaries and 403 descriptions name the folded keys. The replacing invariant: it is regenerated with `bun run api:export-spec`, and every path and schema other than those texts is unchanged.

**US-002**

None. The six runner controllers have no unit spec that builds them, and the integration specs that call runner routes boot the full app, whose global `PermissionService` the guard resolves.

**US-003**
- `apps/api/src/fleet/assistant/mcp/mcp.controller.routes.spec.ts` — its module provides `PermissionService` as `{ projectIdsWithKey }` only, and the `RequiresGuard` now on the MCP routes calls `can` for the implicit `mcp.access`, which would throw. The replacing invariant: the double also has `can` resolving `{ allowed: true, reason: 'implicit' }`; every case (409 when MCP is off, 403 for a user principal, initialize, tools/list, tools/call) keeps its expected outcome.

**US-004**

None. The decorator adds metadata only, and the module specs of the decorated classes compile as before.

**US-005**

None. The story adds a spec and its snapshot file.

**US-006**

None. `PENDING_SURFACE_KEYS` is additive and the checker file is new.

**US-007**

None. `list()` is additive, and the contract spec is new.

### Seams

- **US-001 → US-005:** the fold is observed in the matrix: every row has exactly the 221 post-fold catalog keys, so no folded key has a column (US-005 AC 2), and the pinned `project-admin` cells hold `member.add` and `role.binding.manage` in `p1` (US-005 AC 3).
- **US-006 → US-007:** `findContractViolations` and the declaration types are consumed by the booted-app test (US-007 AC 6).
- **US-002, US-003, US-004 → US-007:** the declarations are reached from the booted app by `collectPermissionDeclarations`. US-007 AC 6 observes no violation (so no runner, live, role or system key is unused), and AC 7 names keys from each story.
- **US-004 → US-007:** `SYSTEM_WRITER_METADATA` is the only channel between the decorator and the collector. US-007 AC 3 builds a provider with `@SystemWriter` and observes the collector report it; AC 8 observes a factory-built writer in the booted app.
- **US-007 producer/consumer:** `AssistantToolRegistry.list()` is consumed by `collectPermissionDeclarations` (US-007 AC 5).

## Acceptance Criteria

Fixture wording: "a user whose only source in `p1` is a `<role>` binding" means a user with that `RoleBinding` in project `p1`, no `ProjectMember` row, and no global admin role. "A global admin" is a user with a global `admin` binding. "A rostered agent" has a `viewer` binding in `p1`. DB-backed tests seed the system roles first (ruling 1).

### US-001: Fold the removed keys (`Workdir: apps/api`)

The fold keeps who holds `member.add`, `member.remove` and `role.binding.manage` (Project Admin through `*`, as for the folded keys), and the existing route specs `core-project-routes`, `core-members-invites` and `core-agent-routes` keep pinning those routes' allow and refuse cases. The ACs below pin what changes.

1. [unit] The set of `PERMISSION_CATALOG` keys and the set `{ project.agent.add, project.agent.remove, project.agent.update, member.role.update, agent.roles.update }` have no key in common.
2. [unit] `PERMISSION_CATALOG` holds exactly one entry with key `role.binding.manage`, and its `scope` is `'project'`.
3. [unit] `findCatalogEntry('agent.update')` returns an entry with `scope` `'global'`.
4. [unit] The set returned by `expandEntries` of the seeded `project-admin` role's permissions with scope `'PROJECT'` is a superset of `{ member.add, member.remove, role.binding.manage }`.
5. [unit] The `REQUIRES_METADATA` keys of `ProjectsController.addProjectAgent`, `ProjectsController.removeProjectAgent`, `ProjectsController.updateProjectAgent`, `ProjectMembersController.updateRole` and `AgentsController.updateRoles`, read into one map from handler name to keys, equal `{ addProjectAgent: ['member.add'], removeProjectAgent: ['member.remove'], updateProjectAgent: ['agent.update'], updateRole: ['role.binding.manage'], updateRoles: ['agent.update'] }`.
6. [unit] `ProjectsController.updateProjectAgent` for a rostered agent, with a `PermissionService` double, calls `can` exactly once, with exactly the two arguments `(principal, 'agent.update')`.
7. [integration] A user whose only source in `p1` is a `project-admin` binding gets 403 with error code `permissions` from `PATCH /projects/p1/agents/<slug>` with `{ status: 'OFFLINE' }` for a rostered agent, and the agent's status stays `ACTIVE`.
8. [integration] A global admin gets 200 from `PATCH /projects/p1/agents/<slug>` with `{ status: 'OFFLINE' }` for a rostered agent, and the agent's status is `OFFLINE`.
9. [integration] A rostered agent gets 200 from `PATCH /projects/p1/agents/<its own slug>` with `{ status: 'OFFLINE' }` using its own API key.

### US-002: Runner routes declare runner keys (`Workdir: apps/api`)

1. [unit] `RequiresGuard.canActivate` on a handler decorated `@Requires('runner.sync')`, for a request whose `user` is a runner principal, resolves `true` and does not call `PermissionService.can`.
2. [unit] `RequiresGuard.canActivate` on that handler, for a request whose `user` is a user principal, rejects with `ForbiddenAppException` with code `permissions`.
3. [unit] `RequiresGuard.canActivate` on that handler, for a request whose `user` is an agent principal, rejects with `ForbiddenAppException` with code `permissions`.
4. [unit] `RequiresGuard.canActivate` on that handler, for a request with no `user`, rejects with `ForbiddenAppException` with code `permissions`.
5. [unit] The `REQUIRES_METADATA` of the seven runner handlers, read into one map from `Class.handler` to metadata, equals the runner rows of the Design route table: `runner.bundle.upload`, `runner.tool.call`, `runner.log.append`, `runner.config.read`, `runner.self.read` and `runner.sync` each as `{ keys: [key], mode: 'all', enforcedBy: 'guard' }`, and `RunnerApiController.enroll` as `{ keys: ['runner.enroll'], mode: 'all', enforcedBy: 'service' }`.
6. [unit] Every one of the six classes `BundleUploadController`, `RunnerToolController`, `LogUploadController`, `RunnerConfigEditController`, `RunnerApiController` and `RunnerSyncController` has `RequiresGuard` in its class-level `GUARDS_METADATA`.
7. [integration] In the booted app, `GET /fleet/runner/me` with an enrolled runner's `kr_` key answers 200 with that runner's name.
8. [integration] In the booted app, `POST /fleet/runner/enroll` with no `Authorization` header and a valid unused enrollment token answers 201 with a body whose `apiKey` starts with `kr_`.

### US-003: The remaining routes declare keys (`Workdir: apps/api`)

1. [unit] The `REQUIRES_METADATA` of the fifteen non-runner handlers in the Design route table (the three MCP routes, `HealthController.check`, the four live streams, the four roles routes, the three role-bindings routes) and of `MemoryController.createMemory` and `MemoryController.recordDecision`, read into one map from `Class.handler` to `{ keys, mode, enforcedBy }`, equals that table's rows (mode `'all'` except the role-bindings writes, which are `'any'`).
2. [unit] `McpController` and `HealthController` each have `RequiresGuard` in their class-level or handler-level `GUARDS_METADATA` for every route they declare.
3. [integration] In the booted app, `GET /health` with no `Authorization` header answers 200 with `status` `'ok'`.
4. [integration] In the booted app, a user with only the `member` baseline gets 403 with error code `permissions` from `GET /roles`.
5. [integration] In the booted app, a global admin gets 200 from `GET /roles`.

### US-004: System writers declare keys (`Workdir: apps/api`)

1. [unit] A class decorated `@SystemWriter('system.outbox.retention')` carries `SYSTEM_WRITER_METADATA` `'system.outbox.retention'`.
2. [unit] Calling `SystemWriter('ticket.read')` throws an `Error` whose message contains `'ticket.read'` (a role key, not a system key).
3. [unit] Calling `SystemWriter('system.no-such-writer')` throws an `Error` whose message contains `'system.no-such-writer'`.
4. [unit] The map from each of the 35 classes in the Design table to the `SYSTEM_WRITER_METADATA` read off that class equals, as one map, the class-to-key mapping of that table.
5. [unit] The set of keys read off those 35 classes equals the set of `PERMISSION_CATALOG` keys whose `access` is `'system'`.

### US-005: Role allow/deny matrix (`Workdir: apps/api`)

Cells are written `R / K / global` or `R / K / p1`, meaning the reason `can` answers for the row principal of role R, key K, and the context `{}` or `{ projectId: 'p1' }` (Design, "The role matrix").

1. [unit] The serialised matrix equals the committed file `apps/api/src/permissions/__snapshots__/role-matrix.json`.
2. [unit] The matrix's role keys equal the `SYSTEM_ROLES` keys in order (11), and every row's cell keys equal the `PERMISSION_CATALOG` keys in order (221).
3. [unit] The list of the 17 pinned cells in the Design table, each read from the matrix, equals the list of their expected reasons.
4. [unit] In every row, the cells for `runner.sync` and `system.outbox.dispatch` are `['non-role-key', 'non-role-key']`.
5. [unit] In every row, the cell for `health.read` is `['public', 'public']`.
6. [unit] In every row, every project-scope role key has `global` reason `'no-project'`.
7. [unit] In every row, no project-scope role key has `p1` reason `'no-project'`.
8. [unit] For every row and key whose `p1` cell is `'not-owner'`, `can(principal, K, { projectId: 'p1', resource: { createdBy: <the row principal's own ref> } })` returns `{ allowed: true, reason: 'granted' }`.
9. [unit] For every row and key whose `p1` cell is `'not-owner'`, `can` with `resource.createdBy` `{ type: 'USER', id: 'someone-else' }` returns `{ allowed: false, reason: 'not-owner' }`.
10. [unit] For every row and every key in `OWNABLE_KEYS` whose `p1` cell is `'granted'`, `can` with `resource.createdBy` `{ type: 'USER', id: 'someone-else' }` returns `{ allowed: true, reason: 'granted' }`.

### US-006: Contract checker (`Workdir: apps/api`)

The unit cases pass a small `catalog` argument of made-up keys (Design rule 2), named below as `k.one` and `k.two`, and an empty `pending` set unless stated. Every route in these fixtures has `enforcedBy` `'guard'` and `hasRequiresGuard` true unless the AC says otherwise.

1. [unit] `PENDING_SURFACE_KEYS` equals the set `{ approval.decide, approval.policy.read, approval.policy.manage, audit.read, fleet.approval.decide.assistant }`.
2. [unit] Every key in `PENDING_SURFACE_KEYS` has a `PERMISSION_CATALOG` entry.
3. [unit] `findContractViolations` for a route `GET /x` with `requires` undefined returns a set containing `{ kind: 'route-without-key', route: 'GET /x' }`.
4. [unit] `findContractViolations` for a route `GET /x` declaring `['no.such.key']` returns a set containing `{ kind: 'unknown-key', source: 'GET /x', key: 'no.such.key' }`.
5. [unit] `findContractViolations` for a tool `{ tool: 'koda_x', key: 'no.such.key' }` returns a set containing `{ kind: 'unknown-key', source: 'koda_x', key: 'no.such.key' }`.
6. [unit] `findContractViolations` for a system writer `{ writer: 'XSweeper', key: 'no.such.key' }` returns a set containing `{ kind: 'unknown-key', source: 'XSweeper', key: 'no.such.key' }`.
7. [unit] `findContractViolations` for a route `GET /x` declaring `['k.one']` with `enforcedBy` `'guard'` and `hasRequiresGuard` false returns a set containing `{ kind: 'guard-missing', route: 'GET /x' }`.
8. [unit] `findContractViolations` for that route with `enforcedBy` `'service'` and `hasRequiresGuard` false returns no `guard-missing` violation.
9. [unit] `findContractViolations` with catalog `[k.one, k.two]` and a single route declaring `['k.one']` returns exactly `[{ kind: 'unused-key', key: 'k.two' }]`.
10. [unit] `findContractViolations` with that catalog, that route, and `pending` `{ k.two }` returns `[]`.
11. [unit] `findContractViolations` with catalog `[k.one, k.two]`, `pending` `{ k.two }` and a route `GET /x` declaring `['k.one', 'k.two']` returns a set containing `{ kind: 'pending-key-declared', source: 'GET /x', key: 'k.two' }`.
12. [unit] `findContractViolations` with catalog `[k.one, k.two]`, `k.one` declared only by a tool and `k.two` only by a system writer, returns `[]`.

### US-007: Contract collector and the booted-app contract test (`Workdir: apps/api`)

1. [unit] `AssistantToolRegistry.list()` after `register(a)` then `register(b)` returns `[a, b]`.
2. [unit] `AssistantToolRegistry.list()` on a new registry returns `[]`.
3. [unit] `collectPermissionDeclarations` over the `ModulesContainer` of an initialised testing module with one provider class decorated `@SystemWriter('system.outbox.retention')` returns `systemWriters` equal to `[{ writer: <that class's name>, key: 'system.outbox.retention' }]`.
4. [unit] `collectPermissionDeclarations` over the `ModulesContainer` of an initialised testing module with one controller, holding one handler decorated `@Requires('ticket.read')` and one handler covered only by a class-level `@Requires('ticket.update')`, returns two routes whose `requires.keys`, as a set of lists, is `{ ['ticket.read'], ['ticket.update'] }`.
5. [unit] `collectPermissionDeclarations` with a registry holding one tool whose descriptor name is `koda_x` and key `ticket.read` returns `tools` equal to `[{ tool: 'koda_x', key: 'ticket.read' }]`.
6. [integration] In the app booted by `bootHttpApp`, `findContractViolations(collectPermissionDeclarations(app.get(ModulesContainer), app.get(AssistantToolRegistry)))` returns `[]`.
7. [integration] In that app, the set of keys declared by the collected routes and system writers includes `runner.sync`, `thread.read`, `role.binding.owner` and `system.schedule.dispatch`.
8. [integration] In that app, with the default `FTS_OPTIMIZE_STRATEGY`, the collected system writers include `{ writer: 'CounterOptimizeStrategy', key: 'system.rag.optimize' }` (a factory-built provider).
9. [unit] `collectPermissionDeclarations` over a testing module where one `@SystemWriter` class is a provider and also aliased by a `useExisting` token returns that writer once.
