# SPEC: Permissions P3b — The Approval API

## Summary

This feature puts the approval engine of `permissions-p3-approval-core` behind the surfaces people and agents use. Nothing in production is gated yet, so these surfaces show and decide requests only once a later feature opens them; the integration ACs open requests with a test command, as approval-core did.
- **Change events.** Every status change of an `ApprovalRequest` (opened, approved, rejected, executed, failed, expired, cancelled) records one outbox event `approval_request_changed` in the transaction that made it.
- **Who sees a request.** A principal sees a request it could decide (it holds `approval.decide`, or an `approval.decide@<pattern>` that matches the key, at the request's scope) and every request it is the actor or the on-behalf-of principal of.
- **Request routes.** `GET /approvals`, `GET /approvals/:id`, `POST /approvals/:id/decisions` and `POST /approvals/:id/cancel`. Cancelling is the actor (or the on-behalf-of user) withdrawing its own pending request, under the new implicit key `approval.request.cancel`.
- **Retry.** The engine's sweeper re-runs a request left `approved` for more than 5 minutes (the process stopped between the decision and the execution).
- **Policy routes.** Global policies under `/approval-policies` (`approval.policy.manage`), project policies under `/projects/:slug/approval-policies` (read `approval.policy.read`, write `approval.policy.manage`), and the list of approvable keys with their floor and default on both.
- **Live and notifications.** A project request's change is pushed to the project's live stream as a content-free `approval_request` event. A newly opened request notifies the users who can decide it.
- **MCP.** `koda_list_approvals` and `koda_decide_approval`, for every agent on the MCP route.
- **CLI.** `koda approval list|show|approve|reject|cancel` and `koda approval policy list|keys|set|update|delete`.

This is the second of six features implementing phase P3 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§4 "Approval engine"). The order (ruled 2026-10-26): approval-core, **approval-api**, approval-assistant, approval-fleet, approval-gate, web.

## Motivation

`permissions-p3-approval-core` (PR #338, `38d435cb`) built the policy model, the resolver, the gate, deciding, executing and expiry, but it exposes services only. Its Out of Scope hands these items to this feature:
- REST routes, query DTOs, the MCP tool `koda_decide_approval`, CLI commands, live events and notifications for approvals and policies; `approval.decide`, `approval.policy.read` and `approval.policy.manage` stay in `PENDING_SURFACE_KEYS` until a surface declares them.
- Cancelling a request (the actor withdrawing it).
- The route permission checks (`approval.policy.manage`, the decide route's key): the services check only policy validity, anti-escalation and decide eligibility.
- A retry path for a request left `approved` when the process stopped between the decide commit and `execute`.

The later features (assistant, fleet, gate) each move a surface onto `ApprovalGate`. Each needs these routes, the inbox reads and the notifications to exist first, so that a request they open can be seen and decided.

**Rulings that bind this feature** (user, 2026-10-26): P3 is six features in the order above; approval-api is "routes, policy CRUD, MCP `koda_decide_approval`, live events, CLI". Design decisions 3-6 and 8 bind it through approval-core's services, which this feature calls unchanged: the approver must hold the action unless the policy says otherwise; Project Admin edits project policies within the floors; a timeout rejects; only `requiredApprovals: 1`; a human acting directly satisfies any mode.

This spec is one capability: the engine's external surface (REST, MCP, CLI and the events behind live updates and notifications), ruled as one feature. It has fifteen stories because the API, MCP and CLI parts are split for size and by `Workdir`.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **One set of request routes, not per project.** A request carries its own project, and the decide check runs at the request's scope (approval-core), so `/approvals` is global and takes an optional `projectId` filter. The design names `POST /approvals/:id/decisions`.
- **Visibility mirrors who can decide, plus the request's own principals.** A principal sees a request when it would pass decide-eligibility's decide-permission check (`holdsDecide` in `approval-eligibility.ts`) at the request's scope, or when it is the request's actor or on-behalf-of principal. The second half lets an agent watch and cancel its own request, and the actor confirm its own `self` request, without holding `approval.decide`. A request the caller cannot see answers 404, the same as a missing one.
- **The request routes declare `approval.decide` with `enforcedBy: 'service'`.** The service filters the rows, and the actor of a `self` request needs no decide key. The cancel route declares the new implicit key `approval.request.cancel`, which the guard passes for every authenticated principal.
- **A global Owner or Admin sees every request.** They hold every project key in every project and `approval.decide` globally (`PermissionService.computeKeys`). A custom GLOBAL role holding `approval.decide` (or a narrowed form) also counts inside every project, because `appliesIn` accepts a GLOBAL role's null-project binding at any scope, so its patterns apply to every request, with or without a project. Whether such a decider may then decide a project request is `decideEligibility`'s business (it usually also needs the action's key, which a GLOBAL role cannot grant for a project-scope key).
- **Cancel is a separate action with its own key.** `approval.request.cancel` (scope `any`, access `implicit`) is recorded as an audit entry with summary `cancelled <permissionKey>`. Only the actor, or the on-behalf-of user of an assistant request, may cancel. Anyone else rejects instead. A pending request past `expiresAt` may still be cancelled, because withdrawing it changes nothing the sweeper would not.
- **The list response carries no frozen input.** `GET /approvals` answers summaries. `GET /approvals/:id` answers the input, the result and the decisions. This mirrors the fleet approvals: the inbox lists, the detail shows what is being approved.
- **Change events go through the outbox.** The outbox event is recorded in the status change's own transaction, so a rolled-back change publishes nothing and a committed one is delivered after the commit. The live stream and the notifications are two fan-out handlers on the same event type, as `ticket_event` serves both today. Requests with no project are listed in `GLOBAL_OUTBOX_TYPES`. They have no live channel (as for fleet approvals), and their notification goes to the global admins.
- **Notifications go to eligible human deciders.** For a project request, the candidates are the users `PermissionService.principalIdsWithKey('USER', projectId, 'approval.decide')` answers. For a request with no project, they are the global admins (`NotificationEligibility.findGlobalAdminIds`). A candidate is notified only when `decideEligibility` accepts them at the request's scope. Users holding only a narrowed `approval.decide@<pattern>` are not found by `principalIdsWithKey` and are not notified (see Out of Scope). The category is the existing `FLEET_NEEDS_YOU`, and the subscriber reuses the system key `system.notification.fleet`.
- **The retry runs in the expiry sweeper.** It uses the same interval and the same `@SystemWriter('system.approval.expire')` class: that writer already settles requests. `retryStale` is a second method, so `tick`'s result shape is unchanged. 5 minutes (`STALE_APPROVED_AFTER_MS = 300_000`) is long past any in-flight execution.
- **The MCP tools are registered beside the assistant tools, not through them.** The assistant executor proposes thread writes and stores `PendingAction` rows. Deciding an approval is not an assistant tool (the assistant never satisfies a mode above `none`), so `koda_decide_approval` and `koda_list_approvals` are MCP-only registrations built by `ApprovalMcpTools` and appended to the server's registrations. Every agent on the MCP route sees both tools, because an agent may confirm its own `self` request without `approval.decide`. The service refuses what the agent may not do.
- **Project policy reads include the global policies.** A global policy applies in every project, so `GET /projects/:slug/approval-policies` lists the project's rows and the global rows (each with its `projectId`, null for global). Writes through the project routes reach only that project's rows. A global row answers 404 there.
- **The approvable keys list is a policy read.** `GET /approval-policies/keys` (global `approval.policy.manage`) and `GET /projects/:slug/approval-policies/keys` (`approval.policy.read`) answer every catalog entry with `approval.approvable === true`: key, scope, risk, floor and default. The P3 web pages build "floor, default and current mode" from it and the policy list.
- **Errors use a new `approvals` i18n namespace.** Exceptions are `new XAppException(args, 'approvals.<code>')`, with messages at `approvals.<code>.<status>` in `en` and `zh`, as in `permissions.json`.

### Change events (US-001, US-002)

`src/approvals/approval-request-events.ts`:

```ts
export const APPROVAL_REQUEST_CHANGED = 'approval_request_changed';

/** The outbox payload. Never the frozen input or the result (they may carry user content). */
export interface ApprovalRequestChangedPayload {
  requestId: string;
  status: ApprovalRequestStatus;
  projectId: string | null;
  permissionKey: string;
  requiredMode: ApprovalMode;
  actorType: 'USER' | 'AGENT' | 'SYSTEM';
  actorId: string;
  onBehalfOfType: 'USER' | 'AGENT' | null;
  onBehalfOfId: string | null;
  expiresAt: string;               // ISO 8601
}

/** null when `raw` is not an object, or requestId, status, permissionKey or actorId is not a non-empty string. */
export function parseApprovalRequestChangedPayload(raw: unknown): ApprovalRequestChangedPayload | null;

@Injectable()
export class ApprovalRequestEvents {
  constructor(private readonly outbox: OutboxService) {}
  /** Records one approval_request_changed outbox event. Must run inside the transaction that wrote the status. */
  record(request: ApprovalRequestRecord): Promise<void>;
}
```

`record` calls `outbox.record({ type: APPROVAL_REQUEST_CHANGED, payload, metadata })`, where `metadata` is `{ eventId: '<request id>:<status>' }` plus `projectId` when the request has one. `OutboxService` comes from `@nathapp/nestjs-outbox`, provided globally, as `ApprovalCloser` injects it (`src/fleet/approvals/approval-closer.ts`).

`GLOBAL_OUTBOX_TYPES` (`src/outbox/global-outbox-types.ts`) gains `APPROVAL_REQUEST_CHANGED`.

Call sites. Each is inside the transaction, and inside the same `bookkeeping` callback where there is one, right after the write that set the status:

| Service | Where | Status recorded |
|:--|:--|:--|
| `ApprovalGate.gate` | step 7, after the request row is created (not for a returned duplicate, nor when the command runs at once) | `pending` |
| `ApprovalDecisionService.decide` | after `transition(id, 'pending', …)` | `approved` or `rejected` |
| `ApprovalExecutionService.execute` | after each `transition(id, 'approved', …)`: the pre-check settle, the run's settle, and the failure settle; inside the `txManager.run` closure (which the private `settle` wraps in `bookkeeping`), and only when `transition` returned a record | `failed` or `executed` |
| `ApprovalRequestExpirySweeper.tick` | after each transition | `expired`, or `approved` on timeout |
| `ApprovalDecisionService.cancel` (US-006) | after its transition | `cancelled` |

Each of the four classes gains a constructor parameter `events: ApprovalRequestEvents`, placed last. `ApprovalEngineModule` provides `ApprovalRequestEvents`.

### Who sees a request (US-003)

`PermissionService` gains:

```ts
/** 'all' = holds approval.decide; otherwise the <pattern> of every approval.decide@<pattern> held, ascending. */
export type DecidePatterns = 'all' | readonly string[];
export interface DecideScopes {
  everywhere: boolean;                                                // a global Owner or Admin binding
  global: DecidePatterns;                                             // from effectiveKeys(principal, 'global')
  projects: ReadonlyArray<{ projectId: string; patterns: DecidePatterns }>;
}
approvalDecideScopes(principal: PrincipalRef): Promise<DecideScopes>;
```

- `everywhere` is true when `findEffectiveBindings(principal, null)` has a row `isGlobalAdminBinding` accepts. In that case `global` is `'all'` and `projects` is `[]`.
- Otherwise `global` comes from `effectiveKeys(principal, 'global')`. `projects` has one entry per id of `findAccessibleProjectIds(principal)` (ascending) whose `effectiveKeys(principal, { projectId })` yields non-empty patterns.
- Patterns from a key set: `'all'` when the set has `approval.decide`. Otherwise the suffixes after `approval.decide@`, ascending and distinct. An empty array when there are none.

`src/approvals/approval-eligibility.ts` exports its existing `matchesDecidePattern(pattern, permissionKey)` unchanged.

`src/approvals/approval-request.queries.ts`:

```ts
export interface ApprovalRequestFilter {
  status?: ApprovalRequestStatus;
  projectId?: string;
  permissionKey?: string;
  mine?: boolean;                 // only requests whose actor or on-behalf-of principal is the caller
}
export interface ApprovalRequestDetail { request: ApprovalRequestRecord; decisions: ApprovalDecisionRecord[] }

@Injectable()
export class ApprovalRequestQueries {
  list(principal: PrincipalRef, filter: ApprovalRequestFilter, page: { current: number; size: number }): Promise<IPageResult<ApprovalRequestRecord>>;
  /** Throws ApprovalRequestNotFoundError when the request is missing or the principal cannot see it. */
  get(principal: PrincipalRef, id: string): Promise<ApprovalRequestDetail>;
  /** Unscoped, for system readers (the notification subscriber). null when missing. */
  findById(id: string): Promise<ApprovalRequestRecord | null>;
}
```

A request is visible to `principal` when any of these holds:
- it is the request's own: the request's `actor` equals the principal, or its `onBehalfOf` does;
- `scopes.everywhere`;
- `scopes.global` matches its key (whatever the request's project: a GLOBAL role applies in every project);
- the request's project is `p`, and the patterns of `scopes.projects` for `p` match its key.

Patterns match a key when they are `'all'`, or when one of them satisfies `matchesDecidePattern(pattern, key)`.

`PrismaApprovalRequestRepository` gains `findVisiblePage(visibility, filter, page): Promise<IPageResult<ApprovalRequestRecord>>`. `visibility` is `{ principal: PrincipalRef; scopes: DecideScopes }`. The global patterns produce key clauses with no project condition, and each project's patterns produce key clauses ANDed with `projectId`. It builds one Prisma `where`: the filter fields ANDed with an OR of the visibility clauses. A pattern `p.*` becomes `permissionKey: { startsWith: 'p.' }`, an exact pattern `permissionKey: p`, and `'all'` no key condition. `mine: true` replaces the OR with the own clauses only. Rows are ordered `createdAt desc, id desc`, through `Paginate` as `PrismaApprovalPolicyRepository.findPage` does.

`ApprovalEngineModule` provides and exports `ApprovalRequestQueries`. The repository stays unexported (`.nax/rules/api-data.md`).

### Request routes (US-004, US-005, US-006)

`src/approvals/approval-requests.controller.ts`: `@ApiTags('approvals') @ApiBearerAuth() @Controller('approvals') export class ApprovalRequestsController`, with `@UseGuards(RequiresGuard)` on each route. Every route of this feature's controllers carries `@ApiOperation` and `@ApiResponse` for each status it answers (`.nax/rules/api-controllers.md`), and the project controller carries `@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })` as `ProjectFleetApprovalsController` does. The principal ref is `{ type: principal.actorType === 'user' ? 'USER' : 'AGENT', id: principal.id }`; a runner principal never reaches these routes, because `CombinedAuthGuard` admits runner keys only on `@RunnerRoute()` routes.

| Route | `@Requires` | Handler | Answer |
|:--|:--|:--|:--|
| `GET /approvals` (`list`) | `'approval.decide', { enforcedBy: 'service' }` | `queries.list(ref, filter, page)` | 200, page of `ApprovalRequestSummaryDto` |
| `GET /approvals/:id` (`get`) | same | `queries.get(ref, id)` | 200, `ApprovalRequestDto` |
| `POST /approvals/:id/decisions` (`decide`), `@HttpCode(200)` | same | `queries.get(ref, id)`, then `decisions.decide(id, dto.decision, dto.comment ?? null)` | 200, `ApprovalRequestDto` of the returned request with its decisions |
| `POST /approvals/:id/cancel` (`cancel`), `@HttpCode(200)` (US-006) | `'approval.request.cancel'` | `queries.get(ref, id)`, then `decisions.cancel(id)` | 200, `ApprovalRequestDto` |

DTOs in `src/approvals/dto/`:
- `ListApprovalRequestsQuery extends KodaPageQuery`: `status?` (one of the seven statuses, `@IsIn`), `projectId?` (non-empty string), `permissionKey?` (non-empty string, at most 200), and `mine?: boolean`, documented with `@ApiPropertyOptional({ type: Boolean })` and turned from the query strings `'true'`/`'false'` into a boolean by a `toBoolean` transform like `src/tickets/dto/list-tickets.query.ts` (so the generated CLI type is `boolean`). Any other value is a 400. The controller passes the raw query through `parseQuery`.
- `DecideApprovalRequestDto`: `decision` (`'approve' | 'reject'`, `@IsIn`) and `comment?` (string, at most 2000 characters).
- `ApprovalRequestSummaryDto.from(record)` has `id`, `permissionKey`, `projectId`, `actorType`, `actorId`, `onBehalfOfType`, `onBehalfOfId`, `origin`, `requiredMode`, `status`, `satisfiedBy`, `approverType`, `approverId`, `expiresAt`, `decidedAt`, `settledAt` and `createdAt` (dates as ISO strings). It has no `input` and no `result`.
- `ApprovalRequestDto.from(detail)` has the summary's fields plus `input`, `result` and `decisions: ApprovalDecisionDto[]` (`id`, `deciderType`, `deciderId`, `decision`, `comment`, `decidedAt`).

`src/approvals/approval-http-errors.ts` exports `rethrowApprovalError(error: unknown): never`. Every handler in this feature's approval and policy controllers catches and passes errors through it:

| Domain error | HTTP |
|:--|:--|
| `ApprovalRequestNotFoundError` | `NotFoundAppException({}, 'approvals.requestNotFound')` (404) |
| `ApprovalRequestNotPendingError(status)` | `ConflictAppException({ status }, 'approvals.notPending')` (409) |
| `ApprovalRequestExpiredError` | `ConflictAppException({}, 'approvals.expired')` (409) |
| `ApprovalDecideForbiddenError(reason)` | `ForbiddenAppException({ reason }, 'approvals.decideForbidden')` (403) |
| `ApprovalCancelForbiddenError` (US-006) | `ForbiddenAppException({}, 'approvals.cancelForbidden')` (403) |
| `InvalidApprovalPolicyError(violation)` (US-008) | `ValidationAppException({ violation }, 'approvals.invalidPolicy')` (400) |
| `ApprovalPolicyConflictError` (US-008) | `ConflictAppException({}, 'approvals.policyConflict')` (409) |
| `ApprovalPolicyNotFoundError` (US-009) | `NotFoundAppException({}, 'approvals.policyNotFound')` (404) |
| `ApprovalPolicySelfApplicationError` (US-008) | `ForbiddenAppException({}, 'approvals.policySelfApplication')` (403) |
| anything else | rethrown unchanged |

`src/i18n/en/approvals.json` and `src/i18n/zh/approvals.json` hold the messages, with `-2` and `400` keys for the validation codes, as `permissions.json` does. The English templates are fixed, and the args reach the client only through them (the global filter answers `JsonResponse.Error(code, message)` with no args):
  - `requestNotFound.404`: `Approval request not found`
  - `notPending.409`: `The approval request is already {status}`
  - `expired.409`: `The approval request has expired`
  - `decideForbidden.403`: `You cannot decide this approval request: {reason}`
  - `cancelForbidden.403`: `Only the requester can cancel this approval request`
  - `invalidPolicy.400` and `invalidPolicy.-2`: `Invalid approval policy: {violation}`
  - `policyConflict.409`: `An approval policy for this pattern and subject already exists`
  - `policyNotFound.404`: `Approval policy not found`
  - `policySelfApplication.403`: `An agent cannot change an approval policy that applies to itself`
  - `emptyPolicyPatch.400` and `emptyPolicyPatch.-2`: `The policy update sets no field`

  The `zh` file has the same keys and placeholders. The integration ACs compare `message` with the rendered template, as `roles-api.integration.spec.ts`'s `sentence()` helper does. Each story adds the codes it introduces: US-004 `requestNotFound`; US-005 `notPending`, `expired` and `decideForbidden`; US-006 `cancelForbidden`; US-008 `invalidPolicy`, `policyConflict` and `policySelfApplication`; US-009 `policyNotFound` and `emptyPolicyPatch`.

`src/approvals/approval-api.module.ts`: `ApprovalApiModule` imports `ApprovalEngineModule` and `ProjectAccessModule` (the project policy routes' `ProjectMembershipGuard` needs `ProjectAccessService`, as `src/fleet/approvals/approvals.module.ts` imports it) and declares `ApprovalRequestsController` (and the two policy controllers from US-008 and US-010). `AppModule` imports it.

`PENDING_SURFACE_KEYS` loses `approval.decide` (US-004), `approval.policy.manage` (US-008) and `approval.policy.read` (US-010).

### Cancel (US-006)

**Catalog.** `NEW_KEY_SCOPES` gains `'approval.request.cancel': 'any'`, and `IMPLICIT_KEYS` gains `'approval.request.cancel'`. It is not role-grantable and not approvable (access `implicit`).

**Error.** `src/approvals/domain/approval.errors.ts` gains `export class ApprovalCancelForbiddenError extends Error { constructor(readonly id: string) }`, in the same shape as its siblings.

**Service.** `ApprovalDecisionService.cancel(requestId: string, now?: Date): Promise<ApprovalRequestRecord>`. The caller is the current context's actor. In one `txManager.run`:
1. `lockById(requestId)`. When it is missing, throw `ApprovalRequestNotFoundError`.
2. A status other than `pending` throws `ApprovalRequestNotPendingError(status)`.
3. The caller must be a `USER` or `AGENT` equal to the request's actor, or equal to its `onBehalfOf` when the actor is `SYSTEM/assistant`. Otherwise throw `ApprovalCancelForbiddenError(requestId)`. A `SYSTEM` or `RUNNER` caller is always refused.
4. `transition(id, 'pending', { status: 'cancelled', settledAt: now })`.
5. `events.record(cancelled)`.
6. `AuditRecorder.record({ key: 'approval.request.cancel', resourceType: 'approval-request', resourceId: id, projectId, summary: 'cancelled <permissionKey>' })`.

Nothing is written when a step refuses.

### Retry of a stale approval (US-007)

`PrismaApprovalRequestRepository.findStaleApproved(before: Date, limit: number)` answers requests with status `approved` and `decidedAt <= before`, oldest `decidedAt` first, at most `limit`.

`ApprovalRequestExpirySweeper` gains:
```ts
export const STALE_APPROVED_AFTER_MS = 300_000;
retryStale(now = new Date()): Promise<{ retried: number; failed: number }>;
```
`retryStale` opens its own `runAsSystemWriter(this, …)` scope, as `tick` does, and inside it reads `findStaleApproved(new Date(now.getTime() - STALE_APPROVED_AFTER_MS), MAX_PER_TICK)` and calls `execution.execute(id, now)` for each request, one after another:
- `execute` returns (any terminal status): `retried + 1`.
- `execute` throws `ApprovalRequestNotPendingError` (someone else settled it): no count, and the loop continues.
- Any other throw: `failed + 1`, a `warn` log with the request id, and the loop continues.

The interval that `onModuleInit` starts runs `tick()`, then `retryStale()`, each with its errors caught and logged as today.

### Policy routes (US-008, US-009, US-010)

`ApprovalPolicyService` gains:
- `get(id: string): Promise<ApprovalPolicyRecord>`, which throws `ApprovalPolicyNotFoundError` for an unknown id (US-009);
- `page(filter: ApprovalPolicyFilter, page: { current; size }): Promise<IPageResult<ApprovalPolicyRecord>>`, which returns `findPage` as it is (US-008).

`ApprovalPolicyFilter` (`prisma-approval-policy.repository.ts`) gains `projectIds?: (string | null)[]` (US-010). When it is set, `findPage` replaces it with an OR of `{ projectId: id }` per entry (null included) instead of passing it as a column. `list` is unchanged.

DTOs in `src/approvals/dto/`:
- `ApprovalPolicySubjectDto`: `kind` (`'all' | 'type' | 'role' | 'principal'`, `@IsIn`), `principalType?` (`'USER' | 'AGENT' | 'ASSISTANT'`), `roleId?` and `principalId?` (non-empty strings).
- `CreateApprovalPolicyDto`:
  - `permissionPattern` (string, 1 to 200 characters);
  - `appliesTo` (`ApprovalPolicySubjectDto`, `@ValidateNested`);
  - `mode` (one of the four modes);
  - `timeoutSec?` (integer or null);
  - `onTimeout?` (`'reject' | 'approve'`);
  - `requiredApprovals?` (integer);
  - `approverMustHoldAction?` and `requireDistinctApprover?` (booleans).
- `UpdateApprovalPolicyDto` (US-009): the same fields as `CreateApprovalPolicyDto` from `mode` on, all optional. A body that sets none of them is refused with `ValidationAppException({}, 'approvals.emptyPolicyPatch')` (400); `timeoutSec: null` counts as set (it clears the timeout).
- `ApprovalPolicyDto.from(record)`: every `ApprovalPolicyRecord` field, with dates as ISO strings.
- `ApprovableKeyDto`: `key`, `scope`, `risk`, `floor` and `default`.
- `ListApprovalPoliciesQuery extends KodaPageQuery`: `permissionPattern?`.

`toPolicySubject(dto: ApprovalPolicySubjectDto)` (`src/approvals/dto/approval-policy-subject.dto.ts`) maps to `ApprovalPolicyInput['appliesTo']`:
- `all` → `{ kind: 'all' }`;
- `type` with a `principalType` → `{ kind: 'type', principalType }`;
- `role` with a `roleId` → `{ kind: 'role', roleId }`;
- `principal` with a `principalType` of `USER` or `AGENT` and a `principalId` → `{ kind: 'principal', … }`.

Any other combination throws `InvalidApprovalPolicyError('subject')`.

`approvableKeys(): ApprovableKeyDto[]` (`src/approvals/approvable-keys.ts`) maps every `PERMISSION_CATALOG` entry with `approval.approvable === true` to its DTO, sorted by key.

**Global routes** (US-008: `list`, `keys`, `create`; US-009: `update`, `remove`). `src/approvals/approval-policies.controller.ts`, `@Controller('approval-policies') export class ApprovalPoliciesController`. Every route uses `@UseGuards(RequiresGuard)` and resolves no project, so the key is checked at global scope:

| Route | `@Requires` | Handler | Answer |
|:--|:--|:--|:--|
| `GET /approval-policies` (`list`) | `approval.policy.manage` | `policies.page({ projectId: null, permissionPattern }, page)` | 200, page of `ApprovalPolicyDto` |
| `GET /approval-policies/keys` (`keys`) | `approval.policy.manage` | `approvableKeys()` | 200, `{ keys: ApprovableKeyDto[] }` |
| `POST /approval-policies` (`create`), `@HttpCode(201)` | `approval.policy.manage` | `policies.create({ ...dto, appliesTo: toPolicySubject(dto.appliesTo), projectId: null })` | 201, `ApprovalPolicyDto` |
| `PATCH /approval-policies/:id` (`update`) | `approval.policy.manage` | `policies.get(id)`; a row whose `projectId` is not null throws `ApprovalPolicyNotFoundError`; then `policies.update(id, dto)` | 200, `ApprovalPolicyDto` |
| `DELETE /approval-policies/:id` (`remove`), `@HttpCode(204)` | `approval.policy.manage` | the same `get` and project check, then `policies.remove(id)` | 204 |

**Project routes** (US-010). `src/approvals/project-approval-policies.controller.ts`, `@Controller('projects/:slug/approval-policies') export class ProjectApprovalPoliciesController`. Every route uses `@UseGuards(ProjectMembershipGuard, RequiresGuard)`, and `projectId` is `ctx.project.id` from `@CurrentProject()`:

| Route | `@Requires` | Handler |
|:--|:--|:--|
| `GET` (`list`) | `approval.policy.read` | `policies.page({ projectIds: [projectId, null], permissionPattern }, page)` |
| `GET keys` (`keys`) | `approval.policy.read` | `approvableKeys()` |
| `POST` (`create`) | `approval.policy.manage` | `policies.create({ …, projectId })` |
| `PATCH :id` (`update`) | `approval.policy.manage` | `policies.get(id)`; a row whose `projectId` is not this project (another project's, or a global row) throws `ApprovalPolicyNotFoundError`; then `update` |
| `DELETE :id` (`remove`) | `approval.policy.manage` | the same check, then `remove` |

The answers are the same as on the global routes. `openapi.json` is regenerated with `bun run api:export-spec` after US-010, the last REST change of the feature.

### Live events and notifications (US-011)

**Live.** `src/live/live-event.ts` gains:
```ts
/** P3b: content-free approval request change; the inbox refetches. Only requests with a project are published. */
export interface LiveApprovalRequestEvent {
  id: string; type: 'approval_request'; projectId: string; requestId: string; status: string; at: string;
}
```
It also adds the event to the `LiveEvent` union.

`src/live/approval-request-live.subscriber.ts`: `ApprovalRequestLiveSubscriber`, in the shape of `TicketLiveSubscriber`, provided in `LiveModule`. In `onModuleInit` it registers a `FanOutPublisher` handler for `APPROVAL_REQUEST_CHANGED`. The handler parses the payload and publishes one event on `ProjectEventBus`, with `id` = the outbox event id `'<requestId>:<status>'` and `at` = now. A malformed payload or a null `projectId` publishes nothing. The handler never throws: a failure is logged at `warn`.

**Notifications.** `NotificationSourceType` gains `'approval_request'`. `src/notifications/approvals/approval-request-drafts.ts`:
```ts
export function approvalRequestDrafts(userIds: readonly string[],
  r: { requestId: string; projectId: string | null; permissionKey: string }): NotificationDraft[];
```
Each draft has:
- `userId`: the recipient, and `projectId`: the request's project (null for none);
- `category: 'FLEET_NEEDS_YOU'`, `kind: 'approval_request'` (not the fleet kind `approval_requested`, which the web renders from `{ kind, repo }`);
- `title: 'Approval needed: <permissionKey>'` (truncated to `TITLE_MAX`), `body: null`;
- `link: '/approvals?id=<requestId>'`;
- `params: { key: permissionKey }`;
- `sourceType: 'approval_request'`, `sourceId: requestId`, `actorId: null`.

`src/notifications/approvals/approval-requested.subscriber.ts`: `@Injectable() @SystemWriter('system.notification.fleet') export class ApprovalRequestedSubscriber implements OnModuleInit`, provided in `NotificationsModule`, whose imports gain `ApprovalEngineModule`. It registers a handler for `APPROVAL_REQUEST_CHANGED`, which runs in whatever context the outbox relay gives fan-out handlers, as `FleetApprovalRequestedSubscriber.handle` does:
1. `parseApprovalRequestChangedPayload`. A malformed payload logs `warn` and stops without throwing. A status other than `pending` stops.
2. `queries.findById(requestId)`. When it is missing or no longer `pending`, stop.
3. Candidates: `PermissionService.principalIdsWithKey('USER', projectId, 'approval.decide')` for a project request, or `NotificationEligibility.findGlobalAdminIds()` for a request with no project.
4. Keep each candidate `u` for whom `decideEligibility(request, { type: 'USER', id: u }, effectiveKeys({ type: 'USER', id: u }, scope)).ok` is true, where `scope` is `{ projectId }`, or `'global'` for a request with no project.
5. `NotificationWriter.deliver(approvalRequestDrafts(kept, …))`, called only when `kept` is non-empty.

### MCP tools (US-012, US-013)

`src/approvals/mcp/approval-mcp-tools.ts`: `@Injectable() export class ApprovalMcpTools`, with constructor `(queries: ApprovalRequestQueries, decisions: ApprovalDecisionService)`. `ApprovalEngineModule` provides and exports it.

```ts
registrations(principal: AgentPrincipal): McpToolRegistration[];   // [koda_list_approvals, koda_decide_approval], in this order
```

Each handler runs inside `runWithActionContext({ actor: { type: 'AGENT', id: principal.id }, origin: 'mcp' }, …)`, and answers `toMcpToolResult({ content, isError })`. The principal ref is `{ type: 'AGENT', id: principal.id }`.

- **`koda_list_approvals`**:
  - Input schema `{ status?: one of the seven statuses, mine?: boolean, page?: integer >= 1 }`, `additionalProperties: false`.
  - It calls `queries.list(ref, { status, mine }, { current: page ?? 1, size: 20 })`.
  - The content has one line per request: `<id> <status> <permissionKey> project=<projectId or global> actor=<actorType>/<actorId> requires=<requiredMode> expires=<expiresAt ISO>`.
  - When more pages exist, the content ends with `next page: <n>`. An empty page answers `no approval requests`.
  - The tool checks its own input (the server passes every argument through): `status` outside the seven statuses answers `invalid_input: status`, `page` that is not an integer >= 1 answers `invalid_input: page`, and `mine` that is not a boolean answers `invalid_input: mine`, each with `isError: true` and no `queries.list` call. Any other error is logged at `error` and answered as `error: koda_list_approvals failed`.
- **`koda_decide_approval`**:
  - Input schema `{ id: string 1..64, decision: 'approve' | 'reject', comment?: string <= 2000 }`, required `id` and `decision`.
  - It calls `queries.get(ref, id)`, then `decisions.decide(id, decision, comment ?? null)`, and answers `<id> <status>` with `isError: false`.
  - The tool answers these errors with `isError: true`:
    - `invalid_input: id`, `invalid_input: decision` or `invalid_input: comment`, for input that breaks the schema. The tool checks the input itself, because the server passes every argument through (`DELEGATE_VALIDATION_TO_EXECUTOR`).
    - `not_found` for `ApprovalRequestNotFoundError`.
    - `not_pending: <status>` and `expired`.
    - `forbidden: <reason>` for `ApprovalDecideForbiddenError`.
    - Any other error is logged at `error` and answered as `error: koda_decide_approval failed`.

The tool descriptions:
- `koda_list_approvals`: "List approval requests this agent can decide or opened itself, newest first, 20 per page. Each line names the request id, its status, the permission key it needs approval for, its project, who asked, the mode it requires and when it expires."
- `koda_decide_approval`: "Approve or reject one pending approval request by its id. An approval runs the requested action at once; the answer is the request's new status. This agent may decide a request only when its permissions and the request's policy allow it; it may confirm its own request only when the request requires `self`."

`McpController` gains a constructor parameter `approvalTools: ApprovalMcpTools`, placed last. Its handler factory builds `createKodaMcpServer([...kodaMcpToolRegistrations(executor, principal, visible), ...approvalTools.registrations(principal)])`. `AssistantModule` imports `ApprovalEngineModule`.

### CLI (US-014, US-015)

New `apps/cli/src/commands/approval.ts` exporting `approvalCommand(program: Command): void`, called from `src/index.ts` beside the other command modules. It sets up the client with `withContext({}, { requireProject: false })`. `--project <slug>` resolves the id with `projectsControllerFindBySlug`. The generated functions follow the controller and method names above: `approvalRequestsControllerList`, `…Get`, `…Decide`, `…Cancel`, `approvalPoliciesControllerList`, `…Keys`, `…Create`, `…Update`, `…Remove`, and `projectApprovalPoliciesControllerList`, `…Keys`, `…Create`, `…Update`, `…Remove`.

**Requests** (US-014):

| Command | Calls | Output (non-`--json`) |
|:--|:--|:--|
| `approval list [--status <s>] [--project <slug>] [--key <permissionKey>] [--mine] [--page <n>] [--size <n>] [--json]` | `approvalRequestsControllerList({ query: { current, size, status?, projectId?, permissionKey?, mine? } })`, with `mine: true` only when `--mine` is given | `table(['ID', 'Status', 'Key', 'Project', 'Actor', 'Requires', 'Expires'], …)`, with `projectId ?? 'global'` and `<actorType>/<actorId>`; `Next: --page <n>` when `hasNext` |
| `approval show <id> [--json]` | `approvalRequestsControllerGet({ path: { id } })` | one `key: value` line per summary field, then `input:` and the input as indented JSON, then one line per decision `<decidedAt> <decision> by <deciderType>/<deciderId>[: <comment>]` |
| `approval approve <id> [--comment <text>] [--json]` | `approvalRequestsControllerDecide({ path: { id }, body: { decision: 'approve', comment? } })` | `<id> <status>` |
| `approval reject <id> [--comment <text>] [--json]` | the same with `decision: 'reject'` | `<id> <status>` |
| `approval cancel <id> [--json]` | `approvalRequestsControllerCancel({ path: { id } })` | `<id> <status>` |

**Policies** (US-015). `--project` selects the project routes, and no `--project` selects the global routes:

| Command | Calls | Output (non-`--json`) |
|:--|:--|:--|
| `approval policy list [--project <slug>] [--pattern <p>] [--page <n>] [--size <n>] [--json]` | `…List` with `query: { current, size, permissionPattern? }` | `table(['ID', 'Pattern', 'Applies to', 'Mode', 'Project', 'Timeout'], …)`, where "Applies to" is `all`, `type:<T>`, `role:<id>` or `<T>:<id>`, and Project is `projectId ?? 'global'` |
| `approval policy keys [--project <slug>] [--json]` | `…Keys` | `table(['Key', 'Scope', 'Risk', 'Floor', 'Default'], …)` |
| `approval policy set --pattern <p> --mode <m> [--project <slug>] [--type <USER\|AGENT\|ASSISTANT> \| --role <roleId> \| --user <userId> \| --agent <agentSlug>] [--timeout <sec>] [--on-timeout <reject\|approve>] [--approver-need-not-hold] [--distinct-approver] [--json]` | `--agent` resolves the id with `agentsControllerFindBySlug`; then `…Create` with `body: { permissionPattern, mode, appliesTo, timeoutSec?, onTimeout?, approverMustHoldAction: false when --approver-need-not-hold, requireDistinctApprover: true when --distinct-approver }`; `appliesTo` is `{ kind: 'all' }` when no subject option is given | `Set policy <id>: <pattern> <mode>` |
| `approval policy update <id> [--project <slug>] [--mode <m>] [--timeout <sec>] [--no-timeout] [--on-timeout <reject\|approve>] [--json]` | `…Update` with only the given fields (`timeoutSec: null` for `--no-timeout`) | `Updated policy <id>` |
| `approval policy delete <id> [--project <slug>] [--json]` | `…Remove` | `Deleted policy <id>` |

- Two subject options together (for example `--type` and `--role`) report `Choose at most one of --type, --role, --user or --agent` through `handleApiError(new Error(...), { validationError: true })` (exit 3), and no API function is called.
- `--mode` and `--on-timeout` values are passed through. The API answers 400 for an unknown one, which goes through `handleApiError` (exit 3).
- `update` with no field option reports `Nothing to update` through `handleApiError(new Error(...), { validationError: true })` (exit 3), and no API function is called.
- `--json` prints the unwrapped response (`delete`: `{ "deleted": "<id>" }`).

`apps/cli/src/generated/` is regenerated with `bun run generate:cli` (repo root) from the US-010 `openapi.json`. The directory is gitignored, and no generated file is edited by hand.

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| A status change rolls back | No `approval_request_changed` event exists for it | US-001 |
| Malformed `approval_request_changed` payload at a consumer | Live: nothing published, `warn`. Notifications: nothing delivered, `warn` | US-011 |
| Request missing or not visible on `GET /approvals/:id`, decide or cancel | 404 `approvals.requestNotFound`; nothing written | US-004, US-005, US-006 |
| Decide on a request that is not pending | 409 `approvals.notPending` | US-005 |
| Decide past `expiresAt` | 409 `approvals.expired` | US-005 |
| Decider not eligible | 403 `approvals.decideForbidden` with `reason` | US-005 |
| Invalid list query or decide body | 400 from the DTO validation | US-004, US-005 |
| Cancel by someone other than the actor or on-behalf-of user | 403 `approvals.cancelForbidden`; request stays pending | US-006 |
| Cancel of a request that is not pending | 409 `approvals.notPending` | US-006 |
| Retry finds a request another process already settled | Skipped, not counted | US-007 |
| Retry's `execute` throws | Counted in `failed`, `warn`, loop continues | US-007 |
| Invalid policy | 400 `approvals.invalidPolicy` with `violation` | US-008 |
| Duplicate policy selector | 409 `approvals.policyConflict` | US-008 |
| Unknown policy id, or a row outside the route's scope | 404 `approvals.policyNotFound` | US-009, US-010 |
| Agent writing a policy that applies to itself | 403 `approvals.policySelfApplication` | US-008 |
| Empty policy patch | 400 `approvals.emptyPolicyPatch` | US-009 |
| Notification for a request no longer pending | Nothing delivered | US-011 |
| MCP decide on a missing or invisible request | `not_found`, `isError: true`; nothing written | US-013 |
| MCP input breaking the schema | `invalid_input: <field>`; no service call | US-012, US-013 |
| CLI conflicting subject options or empty update | Exit 3, no API call | US-015 |

### Integration

Symbols this feature reads (verified on `main` at `38d435cb`):
- `ApprovalGate`, `ApprovalDecisionService.decide`, `ApprovalExecutionService.execute`, `ApprovalRequestExpirySweeper` (`tick`, `MAX_PER_TICK`), `ApprovalPolicyService` (`create`, `update`, `remove`, `list`), `ApprovalCommandRegistry`, `decideEligibility`: `src/approvals/`.
- Domain types and errors: `src/approvals/domain/approval.domain.ts`, `src/approvals/domain/approval.errors.ts`.
- `PermissionService.effectiveKeys`, `principalIdsWithKey`, `findEffectiveBindings`/`findAccessibleProjectIds` through `PrismaRoleBindingRepository`, and the module-private `isGlobalAdminBinding`: `src/permissions/permission.service.ts`, `src/permissions/prisma-role-binding.repository.ts`.
- `RequiresGuard`, `Requires`: `src/permissions/`. `ProjectMembershipGuard`, `CurrentProject`: `src/projects/`.
- `KodaPageQuery`, `parseQuery`, `toPageResult`: `src/common/dto/koda-page.query.ts`.
- `OutboxService` (`@nathapp/nestjs-outbox`); `FanOutPublisher.register`: `src/outbox/fan-out-publisher.ts`.
- `ProjectEventBus`: `src/live/project-event-bus.ts`. Pattern: `TicketLiveSubscriber` (`src/live/ticket-live.subscriber.ts`).
- `NotificationWriter.deliver`, `NotificationEligibility.findGlobalAdminIds`, `TITLE_MAX`, `truncate`: `src/notifications/`. Pattern: `FleetApprovalRequestedSubscriber` (`src/notifications/fleet/fleet-approval-requested.subscriber.ts`).
- `McpToolRegistration`, `kodaMcpToolRegistrations`, `createKodaMcpServer`: `src/fleet/assistant/mcp/mcp-server.factory.ts`; `toMcpToolResult`: `src/fleet/assistant/mcp/mcp-tool-catalog.ts`.
- `runWithActionContext`, `runAsSystemWriter`, `currentContext`: `src/action-context/action-context.ts`. `AuditRecorder.record`: `src/audit/audit-recorder.service.ts`.
- Test helpers: `bootHttpApp`, `data`, `loginToken` (`test/helpers/http-app.ts`); `withTestActor`, `fixtureDb` (`test/helpers/action-context.ts`); `grantKeys` (`src/approvals/test-helpers/approval-fixtures.ts`); `configurableTestCommand` (`src/approvals/test-helpers/test-approval-command.ts`); `grantRole` (`src/permissions/test-helpers/permission-fixtures.ts`).
- CLI: `withContext`, `handleApiError`, `table`, `unwrap`, `pageHint`; pattern `apps/cli/src/commands/fleet-approval.ts`.

Symbols this feature changes. The baseline only locates the code and is never the interface to implement:
- The constructors of `ApprovalGate`, `ApprovalDecisionService`, `ApprovalExecutionService` and `ApprovalRequestExpirySweeper`. Baseline: no `events` parameter. Target: a last parameter `events: ApprovalRequestEvents` (US-001 for the gate, US-002 for the other three).
- `GLOBAL_OUTBOX_TYPES`. Baseline: `FLEET_BUDGET_INCIDENT`, `FLEET_HEALTH_ALERT`. Target: plus `APPROVAL_REQUEST_CHANGED` (US-001).
- `PermissionService`. Baseline: no `approvalDecideScopes`. Target: gains it (US-003).
- `matchesDecidePattern` in `approval-eligibility.ts`. Baseline: module-private. Target: exported, unchanged (US-003).
- `ApprovalEngineModule`. Baseline: exports the policy service, registry, gate, decision and execution services. Target: also provides `ApprovalRequestEvents` (US-001), and provides and exports `ApprovalRequestQueries` (US-003) and `ApprovalMcpTools` (US-012).
- `PENDING_SURFACE_KEYS`. Baseline: `approval.decide`, `approval.policy.read`, `approval.policy.manage`, `fleet.approval.decide.assistant`, `member.remove`. Target: `fleet.approval.decide.assistant`, `member.remove` (US-004, US-008, US-010).
- `NEW_KEY_SCOPES` and `IMPLICIT_KEYS` gain `approval.request.cancel` (US-006).
- `ApprovalDecisionService`. Baseline: `decide` only. Target: gains `cancel` (US-006).
- `ApprovalRequestExpirySweeper`. Baseline: `tick` only, and the interval runs `tick`. Target: gains `retryStale`, and the interval runs both (US-007).
- `ApprovalPolicyService`. Baseline: no `get`, no `page`. Target: gains `page` (US-008) and `get` (US-009). `ApprovalPolicyFilter` gains `projectIds` (US-010).
- `LiveEvent`. Baseline: four members. Target: plus `LiveApprovalRequestEvent` (US-011). `NotificationSourceType` gains `'approval_request'` (US-011).
- `McpController`. Baseline: constructor `(executor, registry, permissions, cfg)`. Target: plus a last parameter `approvalTools: ApprovalMcpTools`; the server registers the approval tools after the assistant tools (US-012).

## Out of Scope

- No production code calls `ApprovalGate.gate` yet: `permissions-p3-approval-assistant`, `permissions-p3-approval-fleet` and `permissions-p3-approval-gate` move their surfaces onto it. Until then the request routes, MCP tools and CLI commands answer empty lists outside tests.
- The policy pages and the unified inbox are `permissions-p3-web`; the notification link `/approvals?id=<id>` points at that inbox and has no page until it ships.
- Notifying users who hold only a narrowed `approval.decide@<pattern>` is not built: `principalIdsWithKey` matches the exact key, and such users still see and decide the request in the inbox.
- Notifying the actor or the on-behalf-of user when a request is decided, executed, failed or expired is not built; the live event and `GET /approvals/:id` report the change.
- Outbound project webhooks for approval requests (as `fleet.approval.requested` has) are not added.
- Requests with no project publish no live event, as fleet approvals with no project publish none.
- A preview route that resolves which policy and mode would apply to a key, project and subject is not added; the web computes "current mode" from `GET …/keys` and the policy list.
- An admin cancelling someone else's request is not built: a decider rejects instead.
- US-005 only: the decide route checks visibility, then calls `decide`, in two steps; a request that becomes invisible between them (a binding removed) is still decided under `decide`'s own eligibility check, which re-reads the decider's keys.
- US-007 only: the retry is not distributed-safe beyond `execute`'s row lock; koda runs one API instance.
- US-012, US-013 only: the MCP tools have no per-tool permission visibility; both are registered for every agent and the services refuse what the agent may not do.
- The thread assistant does not get approval tools: the assistant never satisfies a mode above `none`.
- Moving `PendingAction` and `FleetApproval` onto `ApprovalRequest`, and closing #301, are the assistant and fleet features.
- Editing `.nax/rules/` or `.nax/mono/` context files is not part of any story.
- US-006 only: a cancel racing a decide or the expiry sweeper is serialised by `lockById` (the loser sees a non-pending status and gets `ApprovalRequestNotPendingError`, as decide does in approval-core); the race itself is not tested here.
- No index is added for the visibility filter on `onBehalfOfType`/`onBehalfOfId` or the stale-approved scan on `status`/`decidedAt`: `ApprovalRequest` stays small (one row per gated write, no production writer yet), and the existing `[actorType, actorId, onBehalfOfId, permissionKey, inputHash, status]` and `[status, expiresAt]` indexes lead with columns these queries filter on.
- US-003 only: `approvalDecideScopes` reads `effectiveKeys` once per accessible project (cached per principal and scope); a principal with a project binding in every project of a very large install pays one cached read per project per list call.
- The MCP approval tools are not in the permission contract test's tool-key check, which reads only the assistant tool registry; their services enforce the keys.
- Web rendering of the `approval_request` notification kind is `permissions-p3-web`; until then the web shows the draft's English title.
- The `approval_request` kind does not get the 60 s email delay that `APPROVAL_REQUESTED_KIND` (`approval_requested`, `src/email/email.constants.ts`) gets; it uses the default delay.
- The project live event carries the request id and status to every subscriber of the project stream, including members who cannot see the request: it is content-free (no key, no actor, no input), and the inbox refetch answers only what the caller may see.

## Stories

1. **US-001: The change event and the gate's open** — `Workdir: apps/api` — No dependencies. `ApprovalRequestEvents` and its payload parser, provided by `ApprovalEngineModule`; `GLOBAL_OUTBOX_TYPES` gains the type; `ApprovalGate` records `pending` when it opens a request.
2. **US-002: Decisions, executions and expiry record their changes** — `Workdir: apps/api` — Depends on US-001. `ApprovalDecisionService.decide`, `ApprovalExecutionService.execute` and `ApprovalRequestExpirySweeper.tick` record one `approval_request_changed` event per status change.
3. **US-003: Who sees a request** — `Workdir: apps/api` — No dependencies. `PermissionService.approvalDecideScopes`, the exported `matchesDecidePattern`, `PrismaApprovalRequestRepository.findVisiblePage` and `ApprovalRequestQueries` (`list`, `get`, `findById`), exported by `ApprovalEngineModule`.
4. **US-004: Listing and reading requests over REST** — `Workdir: apps/api` — Depends on US-003. `ApprovalRequestsController` with `GET /approvals` and `GET /approvals/:id`; the list query and request DTOs; `rethrowApprovalError` with `requestNotFound`; the `approvals` i18n files; `ApprovalApiModule` imported by `AppModule`; `approval.decide` leaves `PENDING_SURFACE_KEYS`; `endpoint.e2e.spec.ts` gains the request routes.
5. **US-005: Deciding a request over REST** — `Workdir: apps/api` — Depends on US-004. `POST /approvals/:id/decisions`, `DecideApprovalRequestDto`, and the `notPending`, `expired` and `decideForbidden` mappings.
6. **US-006: Cancelling one's own request** — `Workdir: apps/api` — Depends on US-002, US-005. The implicit key `approval.request.cancel`, `ApprovalCancelForbiddenError`, `ApprovalDecisionService.cancel` and `POST /approvals/:id/cancel`.
7. **US-007: Retrying a stale approval** — `Workdir: apps/api` — Depends on US-002. `findStaleApproved`, `ApprovalRequestExpirySweeper.retryStale` and the interval running it after `tick`.
8. **US-008: Global policy reads and creation** — `Workdir: apps/api` — Depends on US-004. `ApprovalPolicyService.page`, `CreateApprovalPolicyDto`, `toPolicySubject`, `approvableKeys`, `ApprovalPoliciesController` `list`, `keys` and `create`; `approval.policy.manage` leaves `PENDING_SURFACE_KEYS`.
9. **US-009: Global policy updates and deletion** — `Workdir: apps/api` — Depends on US-008. `ApprovalPolicyService.get`, `UpdateApprovalPolicyDto`, and the `update` and `remove` routes with the global-row check.
10. **US-010: Project policy routes and the OpenAPI document** — `Workdir: apps/api` — Depends on US-006, US-009. `ApprovalPolicyFilter.projectIds` and `ProjectApprovalPoliciesController`; `approval.policy.read` leaves `PENDING_SURFACE_KEYS`; `openapi.json` regenerated with `bun run api:export-spec`; `endpoint.e2e.spec.ts` gains the policy routes.
11. **US-011: Live events and notifications for requests** — `Workdir: apps/api` — Depends on US-001, US-003. `LiveApprovalRequestEvent` and `ApprovalRequestLiveSubscriber`; `approvalRequestDrafts` and `ApprovalRequestedSubscriber`; `NotificationSourceType` gains `approval_request`.
12. **US-012: The MCP list tool and the server wiring** — `Workdir: apps/api` — Depends on US-003. `ApprovalMcpTools` with `koda_list_approvals` (and its input checks), provided and exported by `ApprovalEngineModule`, appended to the MCP server's registrations; `AssistantModule` imports `ApprovalEngineModule`.
13. **US-013: The MCP decide tool** — `Workdir: apps/api` — Depends on US-012. `koda_decide_approval` in `ApprovalMcpTools.registrations`, with its input checks and error answers.
14. **US-014: The `koda approval` request commands** — `Workdir: apps/cli` — Depends on US-010. `list`, `show`, `approve`, `reject` and `cancel`, registered in `src/index.ts`; the generated client is regenerated.
15. **US-015: The `koda approval policy` commands** — `Workdir: apps/cli` — Depends on US-014. `list`, `keys`, `set`, `update` and `delete` on the global or project policy routes.

### Context Files

**US-001**
- `apps/api/src/approvals/approval-gate.service.ts` — the open path, edited here
- `apps/api/src/approvals/approval-engine.module.ts` — edited here
- `apps/api/src/fleet/approvals/approval-closer.ts` — the outbox record pattern, read
- `apps/api/src/outbox/global-outbox-types.ts` — edited here

**US-002**
- `apps/api/src/approvals/approval-decision.service.ts` — edited here
- `apps/api/src/approvals/approval-execution.service.ts` — edited here
- `apps/api/src/approvals/approval-request-expiry.sweeper.ts` — edited here
- `apps/api/src/approvals/approval-request-events.ts` — created by US-001, called here

**US-003**
- `apps/api/src/permissions/permission.service.ts` — edited here
- `apps/api/src/approvals/approval-eligibility.ts` — `matchesDecidePattern` exported here
- `apps/api/src/approvals/prisma-approval-request.repository.ts` — edited here
- `apps/api/src/approvals/prisma-approval-policy.repository.ts` — the `Paginate` pattern, read
- `apps/api/src/approvals/approval-engine.module.ts` — edited here

**US-004**
- `apps/api/src/audit/audit.controller.ts` — a list route to mirror, read
- `apps/api/src/approvals/approval-request.queries.ts` — created by US-003, called here
- `apps/api/src/i18n/en/permissions.json` — the message layout to mirror, read
- `apps/api/test/integration/audit/audit-route.integration.spec.ts` — the HTTP integration pattern, read
- `apps/api/src/tickets/dto/list-tickets.query.ts` — the boolean query transform, read

**US-005**
- `apps/api/src/fleet/approvals/fleet-approvals.controller.ts` — a decide route to mirror, read
- `apps/api/src/i18n/en/approvals.json` — created by US-004; this story adds its codes here and in `zh/approvals.json`
- `apps/api/src/approvals/approval-requests.controller.ts` — created by US-004, extended here
- `apps/api/src/approvals/approval-http-errors.ts` — created by US-004, extended here
- `apps/api/src/approvals/approval-decision.service.ts` — `decide`, read

**US-006**
- `apps/api/src/permissions/catalog.ts` — edited here
- `apps/api/src/i18n/en/approvals.json` — created by US-004; this story adds its code here and in `zh/approvals.json`
- `apps/api/src/approvals/approval-decision.service.ts` — edited here
- `apps/api/src/approvals/approval-requests.controller.ts` — created by US-004, extended here
- `apps/api/src/approvals/approval-http-errors.ts` — created by US-004, extended here

**US-007**
- `apps/api/src/approvals/approval-request-expiry.sweeper.ts` — edited here
- `apps/api/src/approvals/prisma-approval-request.repository.ts` — edited here
- `apps/api/src/approvals/approval-execution.service.ts` — `execute`, read

**US-008**
- `apps/api/src/approvals/approval-policy.service.ts` — edited here
- `apps/api/src/approvals/domain/approval.domain.ts` — `ApprovalPolicyInput`, read
- `apps/api/src/i18n/en/approvals.json` — created by US-004; this story adds its codes here and in `zh/approvals.json`
- `apps/api/src/approvals/approval-http-errors.ts` — created by US-004, extended here
- `apps/api/src/approvals/approval-api.module.ts` — created by US-004, extended here

**US-009**
- `apps/api/src/approvals/approval-policy.service.ts` — edited here
- `apps/api/src/approvals/approval-policies.controller.ts` — created by US-008, extended here
- `apps/api/src/approvals/approval-http-errors.ts` — created by US-004, extended here
- `apps/api/src/i18n/en/approvals.json` — created by US-004; this story adds its codes here and in `zh/approvals.json`

**US-010**
- `apps/api/src/approvals/prisma-approval-policy.repository.ts` — edited here
- `apps/api/src/fleet/approvals/project-fleet-approvals.controller.ts` — the project route guards, read
- `apps/api/src/approvals/approval-policies.controller.ts` — created by US-008, mirrored here
- `apps/api/src/approvals/approval-api.module.ts` — created by US-004, extended here

**US-011**
- `apps/api/src/live/ticket-live.subscriber.ts` — the subscriber pattern, read
- `apps/api/src/live/live-event.ts` — edited here
- `apps/api/src/notifications/fleet/fleet-approval-requested.subscriber.ts` — the notification subscriber pattern, read
- `apps/api/src/notifications/notifications.module.ts` — edited here
- `apps/api/src/approvals/approval-request-events.ts` — created by US-001, consumed here

**US-012**
- `apps/api/src/fleet/assistant/mcp/mcp-server.factory.ts` — `McpToolRegistration`, read
- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.ts` — `toMcpToolResult`, read
- `apps/api/src/fleet/assistant/mcp/mcp.controller.ts` — edited here
- `apps/api/src/fleet/assistant/assistant.module.ts` — edited here
- `apps/api/src/fleet/assistant/mcp/mcp.controller.routes.spec.ts` — the MCP route test pattern, read

**US-013**
- `apps/api/src/approvals/mcp/approval-mcp-tools.ts` — created by US-012, extended here
- `apps/api/src/approvals/approval-decision.service.ts` — `decide`, read
- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.ts` — `toMcpToolResult`, read

**US-014**
- `apps/cli/src/commands/fleet-approval.ts` — a command module to mirror, read
- `apps/cli/src/index.ts` — command registration, edited here
- `apps/cli/src/utils/error.ts` — `handleApiError`, read
- `apps/cli/src/commands/fleet-approval.spec.ts` — the command test pattern, read

**US-015**
- `apps/cli/src/commands/approval.ts` — created by US-014, extended here
- `apps/cli/src/commands/role-binding.ts` — exclusive-option validation to mirror, read
- `apps/cli/src/utils/error.ts` — `handleApiError`, read

### Creates

**US-001**
- `apps/api/src/approvals/approval-request-events.ts`
- `apps/api/src/approvals/approval-request-events.spec.ts`
- `apps/api/test/integration/approvals/approval-request-events.integration.spec.ts`

**US-002**
None: the cases go into the existing service specs listed under Modifies.

**US-003**
- `apps/api/src/approvals/approval-request.queries.ts`
- `apps/api/test/integration/approvals/approval-request-visibility.integration.spec.ts`

**US-004**
- `apps/api/src/approvals/approval-requests.controller.ts`
- `apps/api/src/approvals/approval-http-errors.ts`
- `apps/api/src/approvals/approval-api.module.ts`
- `apps/api/src/approvals/approval-api.module.spec.ts`
- `apps/api/src/approvals/dto/list-approval-requests.query.ts`
- `apps/api/src/approvals/dto/approval-request.dto.ts`
- `apps/api/src/i18n/en/approvals.json`
- `apps/api/src/i18n/zh/approvals.json`
- `apps/api/test/integration/approvals/approval-request-routes.integration.spec.ts`

**US-005**
- `apps/api/src/approvals/dto/decide-approval-request.dto.ts`
- `apps/api/test/integration/approvals/approval-decide-route.integration.spec.ts`

**US-006**
- `apps/api/test/integration/approvals/approval-cancel.integration.spec.ts`

**US-007**
- `apps/api/test/integration/approvals/approval-retry.integration.spec.ts`

**US-008**
- `apps/api/src/approvals/approval-policies.controller.ts`
- `apps/api/src/approvals/approvable-keys.ts`
- `apps/api/src/approvals/dto/approval-policy-subject.dto.ts`
- `apps/api/src/approvals/dto/approval-policy.dto.ts`
- `apps/api/src/approvals/dto/list-approval-policies.query.ts`
- `apps/api/test/integration/approvals/approval-policy-routes.integration.spec.ts`

**US-009**
- `apps/api/test/integration/approvals/approval-policy-update-routes.integration.spec.ts`

**US-010**
- `apps/api/src/approvals/project-approval-policies.controller.ts`
- `apps/api/test/integration/approvals/project-approval-policy-routes.integration.spec.ts`

**US-011**
- `apps/api/src/live/approval-request-live.subscriber.ts`
- `apps/api/src/live/approval-request-live.subscriber.spec.ts`
- `apps/api/src/notifications/approvals/approval-request-drafts.ts`
- `apps/api/src/notifications/approvals/approval-requested.subscriber.ts`
- `apps/api/src/notifications/approvals/approval-requested.subscriber.spec.ts`

**US-012**
- `apps/api/src/approvals/mcp/approval-mcp-tools.ts`
- `apps/api/src/approvals/mcp/approval-mcp-tools.spec.ts`
- `apps/api/test/integration/approvals/approval-mcp.integration.spec.ts`

**US-013**
- `apps/api/src/approvals/mcp/approval-mcp-decide.spec.ts`
- `apps/api/test/integration/approvals/approval-mcp-decide.integration.spec.ts`

**US-014**
- `apps/cli/src/commands/approval.ts`
- `apps/cli/src/commands/approval.spec.ts`

**US-015**
- `apps/cli/src/commands/approval-policy.spec.ts`

### Modifies

**US-001**
- `apps/api/src/approvals/approval-gate.service.ts` — the constructor gains a last parameter events: ApprovalRequestEvents, and step 7 calls events.record(created) inside the open transaction; nothing else in gate changes.
- `apps/api/src/approvals/approval-engine.module.ts` — provides ApprovalRequestEvents; the exports are unchanged.
- `apps/api/src/outbox/global-outbox-types.ts` — GLOBAL_OUTBOX_TYPES gains APPROVAL_REQUEST_CHANGED; the two fleet types stay.
- `apps/api/src/approvals/approval-gate.service.spec.ts` — both new ApprovalGate(...) calls pass a stub events object with a record spy as the new last argument; every existing expectation stays.
- `apps/api/src/approvals/approval-engine.module.spec.ts` — its ExternalStubsModule also provides and exports an OutboxService stub, because ApprovalRequestEvents injects it; every existing expectation stays.

**US-002**
- `apps/api/src/approvals/approval-decision.service.ts` — the constructor gains a last parameter events: ApprovalRequestEvents, and decide calls events.record after its transition, inside the same transaction.
- `apps/api/src/approvals/approval-execution.service.ts` — the constructor gains a last parameter events: ApprovalRequestEvents, and each of the three settle transitions calls events.record inside its bookkeeping callback.
- `apps/api/src/approvals/approval-request-expiry.sweeper.ts` — the constructor gains a last parameter events: ApprovalRequestEvents, and each transition in tick calls events.record inside its transaction; tick's result shape is unchanged.
- `apps/api/src/approvals/approval-decision.service.spec.ts` — new ApprovalDecisionService(...) passes a stub events object with a record spy as the new last argument; existing expectations stay, and the new record cases are added here.
- `apps/api/src/approvals/approval-execution.service.spec.ts` — both new ApprovalExecutionService(...) calls pass a stub events object with a record spy as the new last argument; existing expectations stay, and the new record cases are added here.
- `apps/api/src/approvals/approval-request-expiry.sweeper.spec.ts` — new ApprovalRequestExpirySweeper(...) passes a stub events object with a record spy as the new last argument; every tick result expectation stays, and the new record cases are added here.
- `apps/api/test/integration/approvals/approval-execute.integration.spec.ts` — the bare new ApprovalExecutionService(...) passes app.get(ApprovalRequestEvents, { strict: false }) as the new last argument; its expectations stay.

**US-003**
- `apps/api/src/permissions/permission.service.ts` — gains approvalDecideScopes(principal); can, effectiveKeys and the other methods are unchanged.
- `apps/api/src/permissions/permission.service.spec.ts` — gains the approvalDecideScopes global-admin case with stubbed bindings; existing cases keep their expectations.
- `apps/api/src/approvals/approval-eligibility.ts` — matchesDecidePattern becomes exported; its body and decideEligibility are unchanged.
- `apps/api/src/approvals/prisma-approval-request.repository.ts` — gains findVisiblePage; existing methods are unchanged.
- `apps/api/src/approvals/approval-engine.module.ts` — provides and exports ApprovalRequestQueries.

**US-004**
- `apps/api/src/app.module.ts` — imports ApprovalApiModule; no other import changes.
- `apps/api/src/permissions/catalog.ts` — PENDING_SURFACE_KEYS loses 'approval.decide'; no key is added or removed from the catalog.
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — expectedPending loses 'approval.decide', because the request routes now declare it; the other pending keys stay.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — gains an 'Approval requests' block: GET /api/approvals with the admin token answers 200, and without credentials answers 401 (.nax/rules/api-testing.md); existing blocks are unchanged.

**US-005**
None: every file it edits is created earlier in this feature (US-004).

**US-006**
- `apps/api/src/permissions/catalog.ts` — NEW_KEY_SCOPES gains 'approval.request.cancel': 'any' and IMPLICIT_KEYS gains 'approval.request.cancel'; no other key changes.
- `apps/api/src/permissions/catalog.spec.ts` — its own NEW_KEY_SCOPES copy gains 'approval.request.cancel': 'any' and its IMPLICIT_KEY_LIST gains 'approval.request.cancel', so the catalog-equals-derivation and length assertions hold with one more key.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — every role's row gains an 'approval.request.cancel' column with the implicit reason in both cells, as 'session.logout' has; regenerated with the role-matrix spec's update mode, and no other cell changes.
- `apps/api/src/approvals/domain/approval.errors.ts` — gains ApprovalCancelForbiddenError; the existing errors are unchanged.
- `apps/api/src/approvals/approval-decision.service.ts` — gains cancel(requestId, now); decide is unchanged.
- `apps/api/src/approvals/approval-decision.service.spec.ts` — gains the cancel unit cases; existing expectations stay.

**US-007**
- `apps/api/src/approvals/approval-request-expiry.sweeper.ts` — gains STALE_APPROVED_AFTER_MS and retryStale; the interval runs tick then retryStale; tick is unchanged.
- `apps/api/src/approvals/prisma-approval-request.repository.ts` — gains findStaleApproved; existing methods are unchanged.
- `apps/api/src/approvals/approval-request-expiry.sweeper.spec.ts` — gains retryStale cases and the interval case with a findStaleApproved stub; every tick expectation stays.

**US-008**
- `apps/api/src/approvals/approval-policy.service.ts` — gains page(filter, page); create, update, remove and list are unchanged.
- `apps/api/src/permissions/catalog.ts` — PENDING_SURFACE_KEYS loses 'approval.policy.manage'.
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — expectedPending loses 'approval.policy.manage', because the global policy routes now declare it; the other pending keys stay.

**US-009**
- `apps/api/src/approvals/approval-policy.service.ts` — gains get(id); the other methods are unchanged.

**US-010**
- `apps/api/src/approvals/prisma-approval-policy.repository.ts` — ApprovalPolicyFilter gains projectIds, which findPage turns into an OR of projectId equalities (null included); a filter without it queries as before.
- `apps/api/src/permissions/catalog.ts` — PENDING_SURFACE_KEYS loses 'approval.policy.read'.
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — expectedPending loses 'approval.policy.read', because the project policy routes now declare it; it keeps 'fleet.approval.decide.assistant' and 'member.remove'.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — gains an 'Approval policies' block: GET /api/approval-policies with the admin token answers 200, and without credentials answers 401 (.nax/rules/api-testing.md); existing blocks are unchanged.
- `openapi.json` — regenerated with bun run api:export-spec from the repo root after this story's changes; it gains the approval request and policy operations and changes no existing operation.

**US-011**
- `apps/api/src/live/live-event.ts` — gains LiveApprovalRequestEvent and adds it to the LiveEvent union; the existing members and toLiveEvent are unchanged.
- `apps/api/src/live/live.module.ts` — provides ApprovalRequestLiveSubscriber.
- `apps/api/src/notifications/notification.types.ts` — NotificationSourceType gains 'approval_request'; the categories are unchanged.
- `apps/api/src/notifications/notifications.module.ts` — imports ApprovalEngineModule and provides ApprovalRequestedSubscriber.

**US-012**
- `apps/api/src/approvals/approval-engine.module.ts` — provides and exports ApprovalMcpTools.
- `apps/api/src/fleet/assistant/mcp/mcp.controller.ts` — the constructor gains a last parameter approvalTools: ApprovalMcpTools, and the server factory appends approvalTools.registrations(principal) after the assistant registrations.
- `apps/api/src/fleet/assistant/assistant.module.ts` — imports ApprovalEngineModule.
- `apps/api/src/fleet/assistant/mcp/mcp.controller.routes.spec.ts` — its testing module provides an ApprovalMcpTools stub whose registrations answers [], so the existing route cases keep their expectations.
- `apps/api/test/integration/fleet/mcp-route.integration.spec.ts` — AC-5's tools/list expectation becomes the MCP descriptor names followed by 'koda_list_approvals' (and, after US-013, 'koda_decide_approval'), because the approval tools are registered after the assistant tools for every agent.
- `apps/api/test/integration/fleet/permissions-mcp-tools.integration.spec.ts` — AC-3's bare-agent list becomes ['koda_my_projects', 'koda_get_action', 'koda_list_approvals'] and AC-6's admin list becomes DESCRIPTOR_NAMES followed by 'koda_list_approvals', because every agent sees the approval tools after the assistant tools.

**US-013**
- `apps/api/test/integration/fleet/mcp-route.integration.spec.ts` — AC-5's tools/list expectation also ends with 'koda_decide_approval'.
- `apps/api/test/integration/fleet/permissions-mcp-tools.integration.spec.ts` — AC-3's and AC-6's expected lists also end with 'koda_decide_approval'.

**US-014**
- `apps/cli/src/index.ts` — calls approvalCommand(program) beside the other command modules.

**US-015**
None: `apps/cli/src/commands/approval.ts` is created by US-014 and extended here.

### Seams

- US-001's `ApprovalRequestEvents.record` is called by the gate (US-001) and by the decision, execution and sweeper (US-002). Unit ACs drive each service's own entry point with a stub `events` and assert `record` was called with the status. An integration AC opens a request through `ApprovalGate.gate` and finds the outbox row.
- US-003's `ApprovalRequestQueries` is consumed by US-004's and US-005's routes. The integration ACs call the routes over HTTP and assert which request ids come back.
- US-006 calls US-001's `events.record` from `cancel`. A unit AC asserts it with the status `cancelled`.
- US-007's `retryStale` is reached from the sweeper's interval. A unit AC advances fake timers and asserts `retryStale` was called after `tick`.
- US-011's two subscribers consume US-001's `approval_request_changed`. Unit ACs call the handler they registered on `FanOutPublisher` (captured from `register`) and assert the bus publish or the `deliver` call.
- US-012's `ApprovalMcpTools.registrations` is consumed by `McpController`. An integration AC calls `tools/list` and `tools/call` `koda_list_approvals` through `POST /api/mcp`. US-013 adds `koda_decide_approval`, and its integration AC calls it through `POST /api/mcp` and asserts the request ended `executed`.
- US-014 and US-015 call the generated client functions of US-004 to US-006 and US-008 to US-010. The CLI specs mock `../generated` and assert the function and its arguments.
- **Test command.** As in approval-core, the integration specs register `configurableTestCommand('label.delete', …)` once per file in `beforeAll` and `reset()` it in `beforeEach`. `label.delete` is approvable (risk `high`, agent default `agent`). A request is opened with `withTestActor({ type: 'AGENT', id }, () => app.get(ApprovalGate, { strict: false }).gate('label.delete', { labelId: 'l1' }, { projectId }))` for an agent holding `label.delete` there (`grantKeys`). Each case uses fresh principals, so no principal's effective keys are cached from an earlier case.
- **Named fixtures.** The ACs use these principals; each is created fresh per case:
  - *the P approver*: a user bound to the seeded `approver` role in project P **and** granted `['label.delete']` in P (`grantKeys`). The seeded `approver` role does not hold `label.delete`, and `approverMustHoldAction` defaults to true, so without the grant an approve would be refused with `missing-action-permission`.
  - *the P request* / *the Q request*: a pending `label.delete` request opened through the gate by an agent granted `['label.delete']` in P (or Q).
  - *a REST agent*: an agent created through `POST /api/agents` with the admin token, as `test/integration/fleet/permissions-mcp-tools.integration.spec.ts` creates its agents; its API key is the `Bearer` token of its REST or MCP calls, and its id is the actor of the requests it opens with `withTestActor`. Every AC that calls a route "as the agent that opened the request" uses one.
  - *a global policy*: `{ permissionPattern: 'label.delete', appliesTo: { kind: 'type', principalType: 'AGENT' }, mode: 'human' }`, created through `ApprovalPolicyService.create` inside `withTestActor` as the admin user; *a P policy* / *a Q policy* is the same body with `projectId` P (or Q).
  - *an expired request*: a P request whose `expiresAt` is then set to one minute in the past through `fixtureDb(app)`.
  - **Isolation.** Every integration spec of this feature deletes all `ApprovalDecision`, `ApprovalRequest` and `ApprovalPolicy` rows in `beforeEach`, as `approval-decide.integration.spec.ts` does, so an "exactly" AC sees only its own case's rows.
  - Requests for keys with no registered command (`ticket.delete` in US-003 AC-6, `role.manage` with no project in US-003 AC-7) are inserted directly as `ApprovalRequest` rows through `fixtureDb(app)`, with status `pending` and an `expiresAt` in the future, because visibility does not need a command.

## Acceptance Criteria

### US-001: The change event and the gate's open

1. [unit] `ApprovalRequestEvents.record` with a request of project `p1` and status `pending` calls `OutboxService.record` exactly once, with `type: 'approval_request_changed'`.
2. [unit] That call's `metadata` equals `{ eventId: '<request id>:pending', projectId: 'p1' }`.
3. [unit] For a request with `projectId` null and status `expired`, the call's `metadata` equals `{ eventId: '<request id>:expired' }`, with no `projectId` key.
4. [unit] That call's `payload` equals `{ requestId, status, projectId, permissionKey, requiredMode, actorType, actorId, onBehalfOfType, onBehalfOfId, expiresAt }` built from the record, with `expiresAt` as its ISO string, and nothing else.
5. [unit] `GLOBAL_OUTBOX_TYPES.has('approval_request_changed')` is true.
6. [unit] `parseApprovalRequestChangedPayload` returns null for a payload without `requestId`.
7. [unit] `parseApprovalRequestChangedPayload` returns an object equal to the payload `record` produced.
8. [unit] `ApprovalGate.gate` on its wait path, with no pending duplicate, calls `events.record` once with the created record (status `pending`) before its `txManager.run` callback returns.
9. [unit] `ApprovalGate.gate` returning a pending duplicate does not call `events.record`.
10. [unit] `ApprovalGate.gate` for a `USER` actor (the command runs at once) does not call `events.record`.
11. [integration] After an agent's `ApprovalGate.gate('label.delete', …)` opens a request, exactly one outbox event of type `approval_request_changed` exists whose payload `requestId` is that request's id.
12. [integration] An agent's `ApprovalGate.gate` whose command `parse` throws (`state.parseThrows`) leaves no `approval_request_changed` outbox event.
13. [unit] Compiling `ApprovalEngineModule` with its outside providers stubbed resolves an `ApprovalRequestEvents` instance.

### US-002: Decisions, executions and expiry record their changes

1. [unit] `ApprovalDecisionService.decide(id, 'reject', null)` calls `events.record` once with a record whose status is `rejected`.
2. [unit] `ApprovalDecisionService.decide(id, 'approve', null)` calls `events.record` with a record whose status is `approved` before it calls `execute`.
3. [unit] `ApprovalExecutionService.execute` whose command succeeds calls `events.record` with a record whose status is `executed`.
4. [unit] `ApprovalExecutionService.execute` whose command throws calls `events.record` with a record whose status is `failed`.
5. [unit] `ApprovalExecutionService.execute` with no registered command (`no-command`) calls `events.record` with a record whose status is `failed`.
6. [unit] `ApprovalRequestExpirySweeper.tick` on a due `onTimeout: 'reject'` request calls `events.record` with a record whose status is `expired`.
7. [unit] `ApprovalRequestExpirySweeper.tick` on a due `onTimeout: 'approve'` request calls `events.record` with a record whose status is `approved`.
8. [integration] After an approver's `decide(id, 'approve', null)` on a pending `label.delete` request, the request's `approval_request_changed` outbox events have the statuses `pending`, `approved` and `executed`, in that order of creation.

### US-003: Who sees a request

1. [unit] `approvalDecideScopes` for a principal whose effective global bindings include a global `owner` binding returns exactly `{ everywhere: true, global: 'all', projects: [] }`.
2. [integration] For a user bound to the seeded `approver` role in project P only, `approvalDecideScopes` returns exactly `{ everywhere: false, global: [], projects: [{ projectId: P, patterns: 'all' }] }`.
3. [integration] For a user granted `['approval.decide@label.*']` in project P (`grantKeys`), `approvalDecideScopes` returns `projects` equal to `[{ projectId: P, patterns: ['label.*'] }]`.
4. [integration] For a user granted `['approval.decide']` through a non-admin GLOBAL role (`grantKeys` with `projectId` null), `approvalDecideScopes` returns `global` `'all'` and `projects` `[]`.
5. [integration] `ApprovalRequestQueries.list` for the P approver returns exactly the ids of the requests opened in P, with a request opened in project Q present in the fixture.
6. [integration] `list` for the user holding `approval.decide@label.*` in P returns exactly the `label.delete` request in P, with a `ticket.delete` request in P present in the fixture.
7. [integration] `list` for the global non-admin decider returns exactly the request with no project (key `role.manage`, inserted directly) and the P request.
8. [integration] `list` for the agent that opened the P request, holding no decide key, returns exactly that request.
9. [integration] `list` for a global Owner returns exactly the P request and the Q request.
10. [integration] `list` with `mine: true` for the P approver returns no request, because the approver is neither actor nor on-behalf-of principal of any.
11. [integration] `list` with `status: 'rejected'` returns exactly the rejected requests the caller can see.
12. [integration] `list` returns visible requests ordered newest `createdAt` first.
13. [integration] `get(approverRef, id)` on a request with two decisions returns a detail whose `decisions` ids are the two decision ids in ascending `decidedAt` order.
14. [integration] `get` for a principal that cannot see the request throws `ApprovalRequestNotFoundError`.
15. [integration] `findById(id)` returns the request record for an id that exists, whoever opened it.

### US-004: Listing and reading requests over REST

1. [integration] `GET /api/approvals` as the P approver answers 200 with page items whose ids are exactly the P requests, with a Q request present in the fixture.
2. [integration] No item of the `GET /api/approvals` page has an `input` or a `result` field.
3. [integration] `GET /api/approvals?status=bogus` answers 400.
4. [integration] `GET /api/approvals?mine=yes` answers 400.
5. [integration] `GET /api/approvals?mine=true` as the REST agent that opened the P request answers exactly that request.
6. [integration] `GET /api/approvals/:id` as the P approver answers 200 with the request's frozen `input` and a `decisions` array.
7. [integration] `GET /api/approvals/:id` as a user with no binding in P answers 404 with the `approvals.requestNotFound` message.
8. [unit] `PENDING_SURFACE_KEYS.has('approval.decide')` is false.
9. [unit] Compiling `ApprovalApiModule` with `GlobalStubsModule` resolves `ApprovalRequestsController`.
10. [integration] `GET /api/approvals` without credentials answers 401.
11. [integration] `GET /api/approvals?projectId=<Q id>` as the P approver answers an empty page, with the Q request present in the fixture.

### US-005: Deciding a request over REST

1. [integration] `POST /api/approvals/:id/decisions` with `{ "decision": "approve" }` as the P approver answers 200 with `status` `executed`.
2. [integration] After that approve, the test command has recorded exactly one call.
3. [integration] `POST /api/approvals/:id/decisions` with `{ "decision": "reject", "comment": "no" }` answers 200 with `status` `rejected`.
4. [integration] After that reject, the answer's `decisions` holds one decision whose `comment` is `no` and whose `decision` is `reject`.
5. [integration] A decide by a user with no binding in P answers 404.
6. [integration] After that refused decide, the request is still `pending`.
7. [integration] The REST agent that opened a request requiring `agent`, deciding it with `approve`, answers 403 with the message rendered from `approvals.decideForbidden.403` with `reason` `tier-too-low`.
8. [integration] Deciding a request that is already `rejected` answers 409 with the `approvals.notPending` message.
9. [integration] Deciding a pending request whose `expiresAt` is in the past answers 409 with the `approvals.expired` message.
10. [integration] `POST /api/approvals/:id/decisions` with `{ "decision": "maybe" }` answers 400.
11. [integration] `POST /api/approvals/:id/decisions` with a 2001-character `comment` answers 400.
12. [integration] The global non-admin decider (a user granted `['approval.decide']` through a non-admin GLOBAL role) approving the P request answers 403 with the message rendered from `approvals.decideForbidden.403` with `reason` `missing-action-permission`, not 404.

### US-006: Cancelling one's own request

1. [unit] `findCatalogEntry('approval.request.cancel')`, reduced to its `access` and `scope`, equals `{ access: 'implicit', scope: 'any' }`.
2. [integration] The REST agent that opened a pending request calling `POST /api/approvals/:id/cancel` answers 200 with `status` `cancelled`.
3. [integration] After that cancel, the request's audit entries reduced to `{ key, actorType, summary }` equal exactly `[{ key: 'approval.request.cancel', actorType: 'AGENT', summary: 'cancelled label.delete' }]`.
4. [unit] `ApprovalDecisionService.cancel` on a pending request whose actor is the context's actor calls `events.record` with a record whose status is `cancelled`.
5. [unit] `ApprovalDecisionService.cancel` on a pending request whose actor is `SYSTEM/assistant` and whose `onBehalfOf` is user U returns a `cancelled` record when the context's actor is U.
6. [integration] The P approver (not the actor) calling cancel answers 403 with the `approvals.cancelForbidden` message.
7. [integration] After that refused cancel, the request is still `pending`.
8. [integration] A user with no binding in P calling cancel on the P request answers 404.
9. [integration] Cancelling a request that is already `executed` answers 409 with the `approvals.notPending` message.
10. [integration] Cancelling an unknown id answers 404.
11. [unit] `ApprovalDecisionService.cancel` with a `SYSTEM` actor in the context throws `ApprovalCancelForbiddenError`.
12. [unit] That refused `cancel` calls no `transition`.
13. [integration] After a cancel, deciding the same request answers 409.
14. [integration] The REST agent cancelling its own expired request (still `pending`) answers 200 with `status` `cancelled`.

### US-007: Retrying a stale approval

1. [unit] `retryStale(now)` calls `findStaleApproved` with `before` = `now` minus 300 000 ms and `limit` = `MAX_PER_TICK`.
2. [unit] `retryStale` calls `execution.execute(id, now)` once for each request `findStaleApproved` returns.
3. [unit] When both of two stale requests execute, `retryStale` answers `{ retried: 2, failed: 0 }`.
4. [unit] When `execute` throws `ApprovalRequestNotPendingError` for the only stale request, `retryStale` answers `{ retried: 0, failed: 0 }`.
5. [unit] When `execute` throws `Error('boom')` for the first of two requests, `retryStale` still executes the second and answers `{ retried: 1, failed: 1 }`.
6. [unit] With `sweepEnabled` true and fake timers, one `approvalSweepMs` after `onModuleInit` the sweeper has called `tick` and then `retryStale`.
7. [integration] A request set to `approved` with `decidedAt` 10 minutes before `now` is `executed` after `retryStale(now)`.
8. [integration] After that retry, the test command has recorded exactly one call.
9. [integration] A request set to `approved` with `decidedAt` 1 minute before `now` is still `approved` after `retryStale(now)`.
10. [integration] `findStaleApproved(before, 10)` returns no `pending` or `executed` request, whatever its `decidedAt`.

### US-008: Global policy reads and creation

1. [integration] `GET /api/approval-policies` as a global Admin answers 200 with item ids exactly the global policies, with a project policy present in the fixture.
2. [integration] `GET /api/approval-policies` as a user bound only to `project-admin` in P answers 403.
3. [integration] `GET /api/approval-policies/keys` as a global Admin answers a `keys` entry `{ key: 'label.delete', scope, risk, floor: 'none', default: 'agent' }` with the catalog's scope and risk.
4. [integration] That `keys` answer has no entry for `label.read`.
5. [integration] `POST /api/approval-policies` with `{ "permissionPattern": "label.delete", "appliesTo": { "kind": "type", "principalType": "AGENT" }, "mode": "human" }` as a global Admin answers 201 with `projectId` null.
6. [integration] `POST /api/approval-policies` with pattern `role.manage`, `appliesTo` `{ "kind": "all" }` and mode `none` answers 400 with the message rendered from `approvals.invalidPolicy.400` with `violation` `below-floor`.
7. [integration] A second `POST` with the same pattern and `appliesTo` answers 409 with the `approvals.policyConflict` message.
8. [integration] `POST` with `appliesTo` `{ "kind": "bogus" }` answers 400.
9. [unit] `toPolicySubject({ kind: 'type' })` (no `principalType`) throws `InvalidApprovalPolicyError` with violation `subject`.
10. [unit] `toPolicySubject({ kind: 'principal', principalType: 'ASSISTANT', principalId: 'x' })` throws `InvalidApprovalPolicyError` with violation `subject`.
11. [unit] `toPolicySubject({ kind: 'role', roleId: 'r1' })` returns `{ kind: 'role', roleId: 'r1' }`.
12. [integration] A REST agent granted `approval.policy.manage` globally posting the global policy body (`label.delete`, `appliesTo` `{ "kind": "type", "principalType": "AGENT" }`, mode `human`) answers 403 with the `approvals.policySelfApplication` message.
13. [unit] `PENDING_SURFACE_KEYS.has('approval.policy.manage')` is false.
14. [unit] `approvableKeys()` returns entries sorted by key, every one with an approvable catalog key.

### US-009: Global policy updates and deletion

1. [integration] `PATCH /api/approval-policies/:id` with `{ "mode": "agent" }` on a global policy answers 200 with `mode` `agent`.
2. [integration] `PATCH /api/approval-policies/:id` with `{}` answers 400 with the `approvals.emptyPolicyPatch` message.
3. [integration] `PATCH /api/approval-policies/:id` naming a project policy's id answers 404.
4. [integration] After that refused patch, the project policy's `mode` is unchanged.
5. [integration] `PATCH /api/approval-policies/:id` with an unknown id answers 404 with the `approvals.policyNotFound` message.
6. [integration] `DELETE /api/approval-policies/:id` of a global policy answers 204.
7. [integration] A second `DELETE` of the same id answers 404.
8. [integration] `DELETE /api/approval-policies/:id` naming a project policy's id answers 404.
9. [integration] `ApprovalPolicyService.get` with an unknown id throws `ApprovalPolicyNotFoundError`.

### US-010: Project policy routes and the OpenAPI document

1. [integration] `GET /api/projects/<P slug>/approval-policies` as P's Project Admin answers 200 with item ids exactly P's policy and the global policy, with project Q's policy present in the fixture.
2. [integration] The same route as a user bound to `viewer` in P answers 200.
3. [integration] The same route as a user with no binding in P answers 403.
4. [integration] `POST /api/projects/<P slug>/approval-policies` as a user bound to `developer` in P answers 403.
5. [integration] `POST /api/projects/<P slug>/approval-policies` with a valid body as P's Project Admin answers 201 with `projectId` = P's id.
6. [integration] `PATCH /api/projects/<P slug>/approval-policies/:id` naming a global policy's id answers 404.
7. [integration] `PATCH` on P's route naming project Q's policy id answers 404.
8. [integration] `DELETE /api/projects/<P slug>/approval-policies/:id` of P's policy answers 204.
9. [integration] `GET /api/projects/<P slug>/approval-policies/keys` as a user bound to `viewer` in P answers 200 with a `keys` entry for `label.delete`.
10. [integration] `ApprovalPolicyService.page({ projectIds: [P, null] }, …)` returns exactly P's rows and the global rows, with a row of project Q present.
11. [integration] `ApprovalPolicyService.page({ projectId: P }, …)` (no `projectIds`) returns exactly P's rows.
12. [unit] `PENDING_SURFACE_KEYS` equals the set `{ 'fleet.approval.decide.assistant', 'member.remove' }`.
13. [integration] `GET /api/approval-policies` without credentials answers 401.

Verification note: `openapi.json` is regenerated with `bun run api:export-spec` (repo root) after the story's changes; `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint` pass.

### US-011: Live events and notifications for requests

1. [unit] On module init, `ApprovalRequestLiveSubscriber` registers a handler for `approval_request_changed` on `FanOutPublisher`.
2. [unit] That handler, given a payload for request `r1` of project `p1` with status `approved`, calls `ProjectEventBus.publish` once with an event `{ type: 'approval_request', projectId: 'p1', requestId: 'r1', status: 'approved', id: 'r1:approved' }` plus an ISO `at`.
3. [unit] That handler, given a payload with `projectId` null, does not call `publish`.
4. [unit] That handler, given `{ foo: 1 }`, does not call `publish` and returns without throwing.
5. [unit] `approvalRequestDrafts(['u1'], { requestId: 'r1', projectId: 'p1', permissionKey: 'label.delete' })` returns exactly one draft, equal to `{ userId: 'u1', projectId: 'p1', category: 'FLEET_NEEDS_YOU', kind: 'approval_request', title: 'Approval needed: label.delete', body: null, link: '/approvals?id=r1', params: { key: 'label.delete' }, sourceType: 'approval_request', sourceId: 'r1', actorId: null }`.
6. [unit] On module init, `ApprovalRequestedSubscriber` registers a handler for `approval_request_changed` on `FanOutPublisher`.
7. [unit] Given a `pending` payload for a project request with `approverMustHoldAction: true`, with `principalIdsWithKey` answering `['u1', 'u2']` and only u1's effective keys holding `label.delete` and `approval.decide`, the handler calls `NotificationWriter.deliver` once with exactly one draft, for `u1`.
8. [unit] Given a payload whose status is `approved`, the handler calls neither `findById` nor `deliver`.
9. [unit] Given a `pending` payload whose request `findById` answers with status `cancelled`, the handler does not call `deliver`.
10. [unit] Given a `pending` payload with `projectId` null, the handler reads its candidates from `NotificationEligibility.findGlobalAdminIds` and does not call `principalIdsWithKey`.
11. [unit] When no candidate is eligible, the handler does not call `deliver`.
12. [unit] Given `{ foo: 1 }`, the notification handler calls neither `findById` nor `deliver`, and returns without throwing.

### US-012: The MCP list tool and the server wiring

1. [unit] `ApprovalMcpTools.registrations(agent)` returns registrations whose names are exactly `['koda_list_approvals']`.
2. [unit] The `koda_list_approvals` handler with `{ status: 'pending', mine: true, page: 2 }` calls `queries.list({ type: 'AGENT', id: <agent id> }, { status: 'pending', mine: true }, { current: 2, size: 20 })`.
3. [unit] The context captured inside `queries.list` during that call, reduced to `{ actorType, actorId, origin }`, equals `{ actorType: 'AGENT', actorId: <agent id>, origin: 'mcp' }`.
4. [unit] For a page holding one request with more pages after it, the handler answers a result whose content is exactly that request's line in the Design's format, a newline, and `next page: 3`.
5. [unit] For an empty page, the handler answers a result equal to `{ content: [{ type: 'text', text: 'no approval requests' }], isError: false }`.
6. [unit] The handler with `{ status: 'bogus' }` answers a result whose text is `invalid_input: status` and whose `isError` is true.
7. [unit] The handler with `{ page: 0 }` answers `invalid_input: page`.
8. [unit] The handler with `{ mine: 'yes' }` answers `invalid_input: mine`.
9. [unit] Across the three invalid calls above, `queries.list` is never called.
10. [unit] When `queries.list` throws `Error('db down')`, the handler answers `error: koda_list_approvals failed` with `isError` true.
11. [unit] `McpController`'s server factory, given an `ApprovalMcpTools` stub whose `registrations` answers one registration named `koda_list_approvals`, registers it after every assistant registration.
12. [integration] With `MCP_ENABLED` true, `tools/list` through `POST /api/mcp` for a REST agent holding no decide key lists `koda_list_approvals` as the last tool.
13. [integration] `tools/call` `koda_list_approvals` through `POST /api/mcp` by the REST agent that opened the P request answers text whose first line starts with that request's id.

### US-013: The MCP decide tool

1. [unit] `ApprovalMcpTools.registrations(agent)` returns registrations whose names are exactly `['koda_list_approvals', 'koda_decide_approval']`.
2. [unit] The `koda_decide_approval` handler with `{ id: 'r1', decision: 'approve' }` calls `decisions.decide('r1', 'approve', null)`.
3. [unit] The context captured inside `decide` during that call, reduced to `{ actorType, actorId, origin }`, equals `{ actorType: 'AGENT', actorId: <agent id>, origin: 'mcp' }`.
4. [unit] When `decide` returns a request with status `executed`, the handler answers a result equal to `{ content: [{ type: 'text', text: 'r1 executed' }], isError: false }`.
5. [unit] The handler with `{ id: 'r1', decision: 'maybe' }` answers a result whose text is `invalid_input: decision` and whose `isError` is true.
6. [unit] The handler with `{ id: '', decision: 'approve' }` answers `invalid_input: id`.
7. [unit] The handler with a 2001-character `comment` answers `invalid_input: comment`.
8. [unit] When `queries.get` throws `ApprovalRequestNotFoundError`, the handler answers a result whose text is `not_found` and whose `isError` is true.
9. [unit] Across the three invalid calls and the not-found call above, `decide` is never called.
10. [unit] When `decide` throws `ApprovalDecideForbiddenError('tier-too-low')`, the handler answers text `forbidden: tier-too-low`.
11. [unit] When `decide` throws `ApprovalRequestNotPendingError('rejected')`, the handler answers text `not_pending: rejected`.
12. [unit] When `decide` throws `ApprovalRequestExpiredError`, the handler answers text `expired`.
13. [unit] When `decide` throws `Error('boom')`, the handler answers text `error: koda_decide_approval failed` with `isError` true.
14. [integration] With `MCP_ENABLED` true, a REST agent granted `label.delete` and `approval.decide` in P calling `tools/call` `koda_decide_approval` through `POST /api/mcp` on another agent's pending P request leaves that request `executed`.
15. [integration] `tools/list` through `POST /api/mcp` for a REST agent holding no decide key lists `koda_decide_approval` as the last tool.

### US-014: The `koda approval` request commands

1. [unit] `approval list` calls `approvalRequestsControllerList` with `query` `{ current: 1, size: 20 }` when no option is given.
2. [unit] `approval list --status pending --key label.delete --mine` calls it with a `query` equal to `{ current: 1, size: 20, status: 'pending', permissionKey: 'label.delete', mine: true }`.
3. [unit] `approval list --project web` resolves the id with `projectsControllerFindBySlug` and calls the list with that `projectId`.
4. [unit] `approval list` prints a table with the headers `ID`, `Status`, `Key`, `Project`, `Actor`, `Requires` and `Expires`.
5. [unit] `approval list` prints `global` in the Project column for a request with no project.
6. [unit] `approval list --json` prints the unwrapped page as JSON.
7. [unit] `approval show r1` calls `approvalRequestsControllerGet({ path: { id: 'r1' } })`.
8. [unit] `approval show r1`, for a request whose input is `{ labelId: 'l1' }` with one reject decision, prints output whose lines after the summary fields are exactly `input:`, the indented input JSON, and that decision's line in the Design's format.
9. [unit] `approval approve r1 --comment ok` calls `approvalRequestsControllerDecide({ path: { id: 'r1' }, body: { decision: 'approve', comment: 'ok' } })`.
10. [unit] `approval approve r1` prints `r1 executed` for an answer whose status is `executed`.
11. [unit] `approval reject r1` calls `approvalRequestsControllerDecide` with `body: { decision: 'reject' }`.
12. [unit] `approval cancel r1` calls `approvalRequestsControllerCancel({ path: { id: 'r1' } })`.
13. [unit] `approval cancel r1` prints `r1 cancelled` for an answer whose status is `cancelled`.
14. [unit] An `ApiError` with status 403 from `approvalRequestsControllerDecide` goes through `handleApiError`, and the process exits with code 1.
15. [unit] The program built by `src/index.ts` has an `approval` command.

Verification note: `bun run generate:cli` (repo root) regenerates `apps/cli/src/generated/` from the US-010 `openapi.json`; `bun run --cwd apps/cli type-check` and `bun run --cwd apps/cli lint` pass.

### US-015: The `koda approval policy` commands

1. [unit] `approval policy list` calls `approvalPoliciesControllerList`.
2. [unit] `approval policy list --project web` calls `projectApprovalPoliciesControllerList` with `path: { slug: 'web' }`.
3. [unit] `approval policy list` prints `type:AGENT` in the Applies to column for a policy whose `principalType` is `AGENT` with no role and no principal id.
4. [unit] `approval policy keys` calls `approvalPoliciesControllerKeys`.
5. [unit] `approval policy set --pattern label.delete --mode human --type AGENT` calls `approvalPoliciesControllerCreate` with `body` `{ permissionPattern: 'label.delete', mode: 'human', appliesTo: { kind: 'type', principalType: 'AGENT' } }`.
6. [unit] `approval policy set --pattern label.delete --mode agent` (no subject option) sends `appliesTo: { kind: 'all' }`.
7. [unit] `approval policy set … --agent reviewer-bot` resolves the id with `agentsControllerFindBySlug` and sends `appliesTo: { kind: 'principal', principalType: 'AGENT', principalId: <that id> }`.
8. [unit] `approval policy set --pattern label.delete --mode human --approver-need-not-hold --distinct-approver --timeout 600 --on-timeout reject` sends a body equal to `{ permissionPattern: 'label.delete', mode: 'human', appliesTo: { kind: 'all' }, approverMustHoldAction: false, requireDistinctApprover: true, timeoutSec: 600, onTimeout: 'reject' }`.
9. [unit] `approval policy set … --type AGENT --role r1` exits with code 3.
10. [unit] That conflicting `set` calls no API function.
11. [unit] `approval policy update p1 --no-timeout` calls `approvalPoliciesControllerUpdate({ path: { id: 'p1' }, body: { timeoutSec: null } })`.
12. [unit] `approval policy update p1` with no field option exits with code 3.
13. [unit] That empty `update` calls no API function.
14. [unit] `approval policy delete p1 --project web` calls `projectApprovalPoliciesControllerRemove({ path: { slug: 'web', id: 'p1' } })`.
15. [unit] `approval policy set --pattern label.delete --mode human --project web` calls `projectApprovalPoliciesControllerCreate` with `path: { slug: 'web' }`.
