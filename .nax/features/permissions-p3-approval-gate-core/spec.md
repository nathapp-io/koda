# SPEC: Permissions P3e-1 — The REST Approval Gate and the Permission Routes

## Summary

This feature makes agent REST writes wait for approval, starting with the routes that change who may do what.
- **Command variants.** A permission key can now have more than one registered command. A REST route registers its own command under a named variant (`rest:roles.create`), next to the key's primary command (the assistant tool's, the fleet ask's). `ApprovalRequest.variant` records which command an approval runs.
- **The route gate.** `ApprovalRouteGate.run` checks that the caller holds the key, then runs the route's command through `ApprovalGate.gate`. A human, or a policy mode of `none`, runs the write at once, as today. An agent whose policy needs approval gets `202 Accepted` with the pending request instead.
- **Deferred runs rebuild the caller.** `ActorPrincipalLoader` rebuilds the `UserPrincipal` or `AgentPrincipal` of the request's actor when an approved request executes, so a service that takes a principal runs the same code at once or later.
- **The first gated routes.** The 12 REST write routes on the permission and approval keys:
  - `POST/PATCH/DELETE /roles` (`role.manage`);
  - `POST/DELETE /role-bindings` (`role.binding.manage`, `.global`, `.owner`);
  - `POST/PATCH/DELETE /approval-policies` and `/projects/:slug/approval-policies` (`approval.policy.manage`);
  - `POST /approvals/:id/decisions` (`approval.decide`).
- **The gate contract.** The permission contract test also fails on an approvable write route that is not gated, unless the route is on the `PENDING_GATE_ROUTES` allowlist. The allowlist names the later feature that gates each remaining route.
- **The CLI.** Any command that receives a `202` prints the pending request and exits with code 5.

This is the first part of feature 5 of P3 (`p3-approval-gate`) in `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§4 "Approval engine", "Shipped defaults"; §7 "Safety rails").

## Motivation

The engine decides, executes and expires requests, and the assistant, MCP and fleet asks already go through it. An agent calling the REST API or the `koda` CLI does not: it can delete a project, rotate a webhook secret or grant itself a role the moment it holds the key, whatever the policy says. The design's shipped defaults make high-risk agent writes wait for another agent (`agent`) and role, binding and policy writes wait for a human (`human`); today nothing on REST enforces them.

A policy on any approvable key can already be written through `/approval-policies`, and it already takes effect on assistant and MCP writes. On REST it changes nothing.

**Rulings that bind this feature** (user):
- 2026-10-26: P3 is six features in order; feature 5 makes agent REST/CLI writes on approvable keys wait, and may be split by domain. The deferred run is the command registry: a per-key executor (a service method and a validated input); the route calls `gate(key, input, executor)` and answers `202` with the request id; on approval the permission is re-checked and the executor runs with `status = executed` in one transaction.
- 2026-10-28: the gate covers **every** approvable REST write route (about 114 keys behind about 155 routes), not only the 35 keys that wait by default, so a policy on any approvable key applies to REST the same way it applies to assistant and MCP writes. Feature 5 is split in about four features ordered by risk. This one carries the mechanism and the permission and approval routes; the CI contract tracks the rest.
- Design decision 8: a human acting directly satisfies any mode. A human caller never gets `202`.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **One key, several commands: the variant.**
  - `ApprovalCommand` gains an optional `variant?: string`. The registry keys commands by `(key, variant ?? null)`: one primary command (no variant) and any number of named variants per key.
  - `ApprovalRequest` gains a nullable `variant` column. Null means the key's primary command, so every request opened before this feature, and every assistant and fleet request after it, keeps running the command it ran before.
  - The alternatives were worse: one command per key with an operation union cannot coexist with the assistant tool's command on the 9 keys both use (`ticket.create`, `comment.create`, …); renaming requests to command ids needs a backfill.
  - REST variants are named `rest:<controller path>.<verb>` (`rest:roles.create`). Only REST commands use variants in this feature.
- **`ApprovalRequestRecord.variant` is optional and absent when null.** The repository maps the column into the record only when it is not null. Existing record literals in specs and exact-equality assertions on records stay valid.
- **No request is opened for a key the caller does not hold.** `ApprovalRouteGate.run` checks the key (or its `.own` form) at the request's scope before calling the gate, and answers `403 permissions` when the check fails. Without this, a service-enforced route (`@Requires(…, { enforcedBy: 'service' })`: the five role and binding routes and the decide route) would let an agent with no key fill the inbox with requests that fail at execution. The six policy routes are guard-enforced, so their guard already answers 403 first; the gate's check is then redundant and harmless.
- **The decide route skips the key check.** A decider usually holds `approval.decide@<pattern>`, not the bare key, so the bare-key check would refuse legitimate deciders. The decide route passes `keyCheck: false`: its visibility read and `decideEligibility` (inside `ApprovalDecisionService`) stay its authority, and an ineligible decider keeps today's `403 approvals.decideForbidden`. To keep that answer when a policy makes decisions wait, the handler first calls `ApprovalDecisionService.assertMayDecide(requestId)` (the eligibility step of a decision, with no write and no lock), so an ineligible agent gets 403 before any request opens. And because a decider may hold only the narrowed form, the execution re-check (`ApprovalExecutionService.stillHoldsKey`) accepts any `approval.decide@…` key for an `approval.decide` request, as `PermissionService.can` already does through `holdsNarrowedDecide`.
- **Domain checks run when the command runs, not before the request opens.** A pending request is opened after the key check and the input validation only. Lookups, self-binding, escalation, owner lock and policy self-application run inside the service when the command executes (at once, or after approval), and a failing check settles the request `failed`. Running them twice (preflight and execute) is a later improvement, listed in Out of Scope.
- **The route command always loads the principal.** A route command's `execute` builds the principal from the action context through `ActorPrincipalLoader`, on the immediate path as well as the deferred one. One code path; the cost is two reads per gated write.
- **A pending answer is `202` with the request summary, sent by an exception filter.** Nest re-applies a route's static status (`@HttpCode`, or the method default) after the interceptors run (`RouterExecutionContext` → `RouterResponseController.apply`, which both adapters honour), so neither an interceptor nor the handler can turn a `201`/`204`/`200` route into `202`. A gated handler therefore **throws** `ApprovalPending` for a pending outcome. `ApprovalPendingFilter` (`@Catch(ApprovalPending)`, applied to the handler by `@ApprovalGated()` with `UseFilters`, so it runs before the global filter) replies through `HttpAdapterHost`: `httpAdapter.reply(response, JsonResponse.Ok(ApprovalRequestSummaryDto.from(request)), 202)`. It works on Fastify (production) and Express. The request was already committed by the gate (its own bookkeeping transaction) before the throw, and `ActionContextInterceptor`'s error path only closes the audit scope, so nothing is rolled back or flagged as unaudited.
- **The binding routes pick their gate key from the target.** `role.binding.owner` when the role is the owner role, else `role.binding.global` when the binding has no project, else `role.binding.manage`. For `DELETE` the target is the stored binding, read before the gate (a missing binding is 404 before any request).
- **Permission routes move to `PermissionsApiModule`.** `RolesController` and `RoleBindingsController` leave the global `PermissionsModule` for a new `PermissionsApiModule`, which imports `ApprovalEngineModule` and `AuthRepositoryModule`. `PermissionsModule` stays free of an engine import.
- **Each API module registers its route commands.** `PermissionRouteCommands` (in `PermissionsApiModule`) and `ApprovalRouteCommands` (in `ApprovalApiModule`) register their variants in `onModuleInit`, as `AssistantToolCommands` does.
- **A deferred decision records the decision only.** The `decide` variant's run calls `ApprovalDecisionService.recordDecision`, the decision step of `decide` without the execution step, and its `afterCommit` runs `ApprovalExecutionService.execute(innerId)` when the decision approved. The outer request's own action is "record a decision"; the inner request then executes in its own transaction after the outer one commits, as every engine execution does, and a failure there is the inner request's (`failed`, or left `approved` for the sweeper's stale-approved retry). A decided request that settled while the decision waited makes the run throw `DeferredDecisionRefusedError`, not `ApprovalRequestNotPendingError`, because the execution service rethrows the latter instead of settling the outer request `failed`.
- **A project policy's route checks run again at execution.** The project policy `PATCH` and `DELETE` commands check that the policy still belongs to the route's project before writing, because a deferred run happens later than the route's own check.
- **The CLI exits 5 for a pending write.** One response interceptor in `configureApiClient` turns any `202` into an `ApprovalPendingError`; `handleApiError` prints it and exits 5. No command module changes.

### Shared names

| Name | Where | What |
|:--|:--|:--|
| `ApprovalCommand.variant?: string` | `approvals/approval-command.registry.ts` | the command's variant; absent for a primary command |
| `ApprovalCommandRegistry.get(key, variant?)` | same | the primary command when `variant` is omitted or null |
| `ApprovalRequestRecord.variant?: string` | `approvals/domain/approval.domain.ts` | absent when the column is null |
| `ApprovalGate.gate(key, input, { projectId, variant? })` | `approvals/approval-gate.service.ts` | |
| `ActorPrincipalLoader` | `auth/principal/actor-principal.loader.ts` | `load(actor)`, `forContext()` |
| `ActorUnavailableError` | same | the actor is missing, disabled or paused |
| `routeCommand(spec, loader)`, `RouteCommandSpec` | `approvals/route/route-command.ts` | |
| `parseBody(cls, raw)` | `approvals/route/parse-body.ts` | |
| `ApprovalRouteGate` | `approvals/route/approval-route-gate.ts` | `run({ key, variant, projectId, input, keyCheck? })` |
| `ApprovalPending` | `approvals/route/approval-pending.ts` | the pending outcome a handler throws |
| `ApprovalPendingFilter`, `ApprovalGated()` | `approvals/route/approval-gated.decorator.ts` | |
| `ApprovalDecisionService.recordDecision` | `approvals/approval-decision.service.ts` | `decide` without the execution step |
| `DeferredDecisionRefusedError` | `approvals/approval-route.commands.ts` | |
| `APPROVAL_GATED_METADATA` | same | `'koda:approval-gated'` |
| `PermissionRouteCommands`, `PERMISSION_ROUTE_VARIANTS` | `permissions/permission-route.commands.ts` | |
| `ApprovalRouteCommands`, `APPROVAL_ROUTE_VARIANTS` | `approvals/approval-route.commands.ts` | |
| `PermissionsApiModule` | `permissions/permissions-api.module.ts` | |
| `PENDING_GATE_ROUTES` | `permissions/pending-gate-routes.ts` | route label → later feature (`gate-high`, `gate-core-domains`, `gate-fleet`) |
| `ApprovalPendingError` | `apps/cli/src/utils/approval-pending.ts` | |

### Variants on the engine (US-001)

- `schema.prisma`: `ApprovalRequest` gains `variant String?` after `permissionKey`. Migration `20261108090000_approval_request_variant`: `ALTER TABLE "ApprovalRequest" ADD COLUMN "variant" TEXT;`. No index change.
- `ApprovalCommandRegistry`:
  - `register(command)` refuses a key that is not approvable (unchanged), a `variant` that is the empty string or longer than 100 characters (`approval command variant is invalid: <key>`), and a second command for the same `(key, variant)` (`approval command already registered: <key>` for a primary, `approval command already registered: <key>#<variant>` for a variant).
  - `get(key, variant?)` answers the command registered for `(key, variant ?? null)`. A primary and a variant of one key never answer for each other.
- `ApprovalGate.gate(key, input, opts)`: `opts.variant?: string`. The command is `registry.get(key, opts.variant)`; an unregistered pair throws `UnregisteredApprovalCommandError(key)` (unchanged). `newRequest` sets `variant` when given. The duplicate lookup (`PendingApprovalMatch`) gains `variant: string | null` and `findPendingDuplicate` matches it (`variant: null` matches a null column).
- `PrismaApprovalRequestRepository`: `create` writes `variant: record.variant ?? null`; the row-to-record mapping adds `variant` only when the column is not null.
- `ApprovalExecutionService.precheck` and `ApprovalDecisionService` (its `parseDecisionParams` lookup) use `registry.get(request.permissionKey, request.variant)`.
- `ApprovalAskService.open` sets no variant (fleet asks run their primary command).

### Rebuilding the caller (US-002)

`ActorPrincipalLoader` (`@Injectable()`, provided and exported by `AuthRepositoryModule`, constructor `(PrismaAuthRepository)`):
- `load({ type: 'USER', id })`:
  - reads `findUserById(id)`. A missing or `disabled` user throws `ActorUnavailableError`.
  - The role is `'ADMIN'` when `PrismaAuthRepository.hasGlobalAdminBinding(id)` (new: a `RoleBinding` with `principalType: 'USER'`, `principalId: id`, `projectId: null` and role key `owner` or `admin` exists), else `'MEMBER'`. This is the same rule as `PrismaAssistantToolCallRepository.findUserActor`.
  - Answers `{ actorType: 'user', id, name: email, email, role, blacklisted: false, revoked: false, authorities: [role], extra: { sub: id, email, role } }`.
- `load({ type: 'AGENT', id })`:
  - reads the new `PrismaAuthRepository.findAgentById(id)` (`{ id, slug, status, apiKeyHash }` or null). A missing agent, or one with status `PAUSED`, throws `ActorUnavailableError`.
  - Answers `{ actorType: 'agent', id, name: slug, slug, status, capabilities: [], blacklisted: false, revoked: false, authorities: [], extra: { slug } }`. Capabilities are not read: no permission decision uses them.
- `forContext()`: the current action context's actor when it is `USER` or `AGENT`, loaded as above. Any other actor, or no context, throws `ActorUnavailableError`.
- `ActorUnavailableError extends Error` with `readonly actor: { type: string; id: string } | null`, name `ActorUnavailableError`, prototype preserved.

### The route gate (US-003)

- `parseBody<T extends object>(cls: new () => T, raw: unknown): T`:
  - `plainToInstance(cls, raw)`, then `validateSync` with the app pipe's options (`whitelist: true`, `stopAtFirstError: true`, `forbidUnknownValues: false`). Any error throws `new ValidationAppException({}, 'approvals.invalidInput')`.
  - Answers `instanceToPlain` of the instance: the plain, whitelisted object the global pipe hands a handler.
  - A non-object `raw` (null, an array, a primitive) throws the same exception.
- `RouteCommandSpec<TInput, TResult>`: `{ key; variant; parse(input: unknown): TInput; run(principal: UserPrincipal | AgentPrincipal, input: TInput): Promise<TResult>; toResult?(result: TResult): unknown }`.
- `routeCommand(spec, loader): ApprovalCommand<TInput, TResult>`: `key` and `variant` from the spec, `parse` from the spec, `execute(input)` is `spec.run(await loader.forContext(), input)`, `toResult` from the spec when given.
- `ApprovalRouteGate` (`@Injectable()`, provided and exported by `ApprovalEngineModule`, constructor `(ApprovalGate, PermissionService)`):
  - `run<TResult>({ key, variant, projectId, input, keyCheck = true }): Promise<GateOutcome<TResult>>`.
  - Step 1: the current context's actor must be `USER` or `AGENT`. A `RUNNER` actor (a runner key reaching a service-enforced route) throws `new ForbiddenAppException({}, 'permissions')`, today's answer for runners; any other actor, or no context, throws `Error('approval route gate needs a principal actor')`.
  - Step 2 (skipped when `keyCheck` is false): the actor's `effectiveKeys` at `projectId` (or `'global'` when null) must hold `key` or `key.own`. Otherwise it throws `new ForbiddenAppException({}, 'permissions')`, and no request is written.
  - Step 3: `gate.gate(key, input, { projectId, variant })`.
- `ApprovalPending extends Error` with one field `readonly request: ApprovalRequestRecord`, name `ApprovalPending`, prototype preserved, message `approval pending: <id>`.
- `ApprovalGated()` is `applyDecorators(SetMetadata(APPROVAL_GATED_METADATA, true), UseFilters(ApprovalPendingFilter), ApiExtraModels(ApprovalRequestSummaryDto), ApiResponse({ status: 202, description: 'The write waits for approval', schema: <{ ret, data: $ref ApprovalRequestSummaryDto }> }))`.
- `ApprovalPendingFilter implements ExceptionFilter` (`@Catch(ApprovalPending)`, constructor `(HttpAdapterHost)`): `catch(error, host)` calls `httpAdapter.reply(host.switchToHttp().getResponse(), JsonResponse.Ok(ApprovalRequestSummaryDto.from(error.request)), 202)`. It catches nothing else.
- A gated handler's shape:

  ```ts
  const outcome = await this.routeGate.run<RoleDomain>({ key: 'role.manage', variant: PERMISSION_ROUTE_VARIANTS.roleCreate, projectId: null, input: dto });
  if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
  return JsonResponse.Ok(RoleDto.from(outcome.result));
  ```

  A `DELETE` handler returns `undefined` on `executed` (204 as today).

### The permission routes (US-004, US-005)

`PermissionRouteCommands implements OnModuleInit` (constructor `(ApprovalCommandRegistry, RoleAdminService, ActorPrincipalLoader)`) registers five `routeCommand`s:

| Variant (`PERMISSION_ROUTE_VARIANTS`) | Key | Input | Run |
|:--|:--|:--|:--|
| `roleCreate` = `rest:roles.create` | `role.manage` | `parseBody(CreateRoleDto, input)` | `roles.createRole(principal, input)` |
| `roleUpdate` = `rest:roles.update` | `role.manage` | `{ id: non-empty string, patch: parseBody(UpdateRoleDto, input.patch) }` | `roles.updateRole(principal, id, patch)` |
| `roleDelete` = `rest:roles.delete` | `role.manage` | `{ id: non-empty string }` | `roles.deleteRole(principal, id)`; result null |
| `bindingCreate` = `rest:role-bindings.create` | `role.binding.owner`, `.global`, `.manage` (one registration each) | `parseBody(CreateRoleBindingDto, input)` | `roles.createBinding(principal, input)` |
| `bindingDelete` = `rest:role-bindings.delete` | the same three keys | `{ id: non-empty string }` | `roles.removeBinding(principal, id)`; result null |

- The binding variants are registered once per key (three `register` calls each), because the route picks the key from the target. All three share one `parse` and one `run`.
- An `{ id }` input that is not an object with a non-empty string `id` (other members are dropped) throws `ValidationAppException({}, 'approvals.invalidInput')`.
- `toResult` of the create and update commands is the DTO (`RoleDto.from`, `RoleBindingDto.from`), so `ApprovalRequest.result` holds what the route would have answered.
- `bindingGateKey({ roleKey, projectId }): string` (exported from `permission-route.commands.ts`): the owner role key `'owner'` (the value of the module-private `OWNER_ROLE_KEY` in `role-admin.service.ts`; export it from there rather than repeating the literal) → `role.binding.owner`; else a null `projectId` → `role.binding.global`; else `role.binding.manage`.
- `RolesController` (constructor `(RoleAdminService, ApprovalRouteGate)`): `create`, `update`, `remove` are `@ApprovalGated()` and run the gate with `projectId: null`. `list` is unchanged. `update`'s input is `{ id, patch: dto }`.
- `RoleBindingsController` (constructor `(RoleAdminService, MembershipService, ApprovalRouteGate)`):
  - `create`: key `bindingGateKey({ roleKey: dto.roleKey, projectId: dto.projectId ?? null })`, `projectId: dto.projectId ?? null`.
  - `remove`: `membership.findBinding(id)`, a missing binding is `404 permissions.bindingNotFound` (as today, but now before the gate); key `bindingGateKey` of the stored binding, `projectId` the stored binding's.
- `@Requires` metadata and the `@ApiResponse`s already declared stay; each gated handler gains the 202 response through `@ApprovalGated()`.

### The approval routes (US-006 to US-009)

`ApprovalRouteCommands implements OnModuleInit` (constructor `(ApprovalCommandRegistry, ApprovalPolicyService, ApprovalDecisionService, ApprovalExecutionService, ApprovalRequestQueries, ActorPrincipalLoader)`) registers seven `routeCommand`s, all on `approval.policy.manage` except the last:

| Variant (`APPROVAL_ROUTE_VARIANTS`) | Input | Run |
|:--|:--|:--|
| `policyCreate` = `rest:approval-policies.create` | `parseBody(CreateApprovalPolicyDto, input)` | `policies.create({ ...input, appliesTo: toPolicySubject(input.appliesTo), projectId: null })` |
| `policyUpdate` = `rest:approval-policies.update` | `{ id, patch: parseBody(UpdateApprovalPolicyDto, …) }`; an empty patch throws `ValidationAppException({}, 'approvals.emptyPolicyPatch')` | `policies.update(id, patch)` after the policy's `projectId` is checked null (else `ApprovalPolicyNotFoundError`) |
| `policyDelete` = `rest:approval-policies.delete` | `{ id }` | `policies.remove(id)` after the same check |
| `projectPolicyCreate` = `rest:project-approval-policies.create` | `{ projectId, policy: parseBody(CreateApprovalPolicyDto, …) }` | `policies.create({ ...policy, appliesTo: toPolicySubject(policy.appliesTo), projectId })` |
| `projectPolicyUpdate` = `rest:project-approval-policies.update` | `{ projectId, id, patch }`, empty patch refused as above | `policies.get(id)`; a policy of another project throws `ApprovalPolicyNotFoundError(id)`; then `policies.update(id, patch)` |
| `projectPolicyDelete` = `rest:project-approval-policies.delete` | `{ projectId, id }` | the same check, then `policies.remove(id)` |
| `decide` = `rest:approvals.decide` (key `approval.decide`) | `{ requestId, decision, comment, params }`: `requestId` a non-empty string, `decision` `'approve'` or `'reject'`, `comment` a string or null, `params` any JSON value or absent | `decisions.recordDecision(requestId, decision, comment, new Date(), params)`, then `ApprovalRequestDto.from({ request, decisions: await queries.decisionsFor(request.id) })`; an `ApprovalRequestNotPendingError` or `ApprovalRequestExpiredError` from `recordDecision` is rethrown as `DeferredDecisionRefusedError` (its `reason` is `'not-pending'` or `'expired'`, and `status` the inner request's status for `'not-pending'`). `toResult` is `ApprovalRequestSummaryDto.from(request)` (the outer row does not copy the inner request's input or decisions). `afterCommit`: when `decision` is `'approve'`, `execution.execute(requestId)`; a throw is logged by the engine only |

- `ApprovalDecisionService.recordDecision(requestId, decision, comment, now, params?)` is today's private `record` made public under that name (the decision transaction, eligibility included, with no execution); `decide` becomes `recordDecision` then, for an approval, `execution.execute`. `ApprovalRouteCommands` uses `ApprovalExecutionService` for the `afterCommit`.
- `DeferredDecisionRefusedError extends Error` with `readonly reason: 'not-pending' | 'expired'` and `readonly status?: string`, name and prototype preserved. On the immediate path the decide handler maps it back: `not-pending` → `409 approvals.notPending` with `{ status }`, `expired` → `409 approvals.expired`, so an immediate decide answers exactly as today.
- `ApprovalDecisionService.assertMayDecide(requestId): Promise<void>`: reads the request (`requests.findById`), answers `ApprovalRequestNotFoundError` when missing, reads the decider from the context and its effective keys at the request's scope exactly as the decision step does, and throws `ApprovalDecideForbiddenError(reason)` when `decideEligibility` refuses. It does not check the status (the decision step still does, under its lock).
- The `approval.decide` audit row a deferred decision writes carries the inner request's approval (`recordDecision` runs the decision under the inner request's approval block, as today); the outer approval is on the outer `ApprovalRequest` row. This is intended; it is not pinned.
- On the immediate path (`none` mode, the default), the handler calls `execution.execute(requestId)` itself after the gate answers `executed` with an approve, then answers the request DTO it reads back, so the response is today's (`status: 'executed'`). The command's `afterCommit` only runs for a request the engine executed.
- The global policy commands check the policy is global, matching what the global `PATCH` and `DELETE` routes already reach through `ApprovalPolicyService` (a project policy through a global route is a 404 there today; keep that answer).
- Errors thrown inside these runs are domain errors (`ApprovalPolicyNotFoundError`, `ApprovalDecideForbiddenError`, …). On the immediate path the controller's `rethrowApprovalError` maps them as today. On the deferred path the request is settled `failed` with `{ error: 'execution-failed', name: <the error's name> }`.
- Controllers:
  - `ApprovalPoliciesController`: `create`, `update`, `remove` are `@ApprovalGated()`, gate with `projectId: null`. `update` refuses an empty patch with 400 before the gate (unchanged order), and `update` and `remove` read the policy and answer 404 for a missing or project policy before the gate, as they do today.
  - `ProjectApprovalPoliciesController`: the same, with `projectId: ctx.project.id`. `update` and `remove` read the policy and answer 404 for another project's policy before the gate (unchanged), and the command checks again.
  - `ApprovalRequestsController.decide`: the visibility read (`queries.get`) stays first; then `decisions.assertMayDecide(id)`; then the gate with key `approval.decide`, `projectId` = the decided request's `projectId`, `keyCheck: false`. On `executed` it runs the inner execution as above and answers 200 with the request DTO.
- `ApprovalApiModule` imports `AuthRepositoryModule` and provides `ApprovalRouteCommands`.

### The gate contract (US-010)

- `RouteDeclaration` gains `method: string` (upper case) and `gated: boolean` (the handler's `APPROVAL_GATED_METADATA`).
- `ContractViolation` gains:
  - `{ kind: 'ungated-approvable-write'; route }`: a `POST`, `PUT`, `PATCH` or `DELETE` route, one of whose `@Requires` keys is approvable (`findCatalogEntry(key)?.approval.approvable`), that is neither gated nor listed in `PENDING_GATE_ROUTES`;
  - `{ kind: 'gated-without-approvable-key'; route }`: a gated route with no approvable key;
  - `{ kind: 'stale-pending-gate-route'; route }`: a `PENDING_GATE_ROUTES` entry that is gated, or that names no collected approvable write route.
- `findContractViolations(declarations, catalog = PERMISSION_CATALOG, pending = PENDING_SURFACE_KEYS, pendingGateRoutes = PENDING_GATE_ROUTES)`: the allowlist is a new fourth parameter so specs pass their own, and approvability is read from the `catalog` argument (an entry of `catalog` with `approval.approvable`), never from the global catalog.
- `PENDING_GATE_ROUTES: ReadonlyMap<string, 'gate-high' | 'gate-core-domains' | 'gate-fleet'>`, keyed by `routeSurface` label (`'DELETE /projects/:slug'`):
  - `gate-high` (feature `permissions-p3-approval-gate-high`): a route with at least one approvable key whose catalog `approval.default` is not `none`;
  - else `gate-fleet` (`permissions-p3-approval-gate-fleet`): every approvable key of the route starts with `fleet.`, `thread.` or `testhook.`;
  - else `gate-core-domains` (`permissions-p3-approval-gate-core-domains`).
- The entries are exactly the approvable write routes of the booted app minus this feature's 12. Generate them with the collector and the rule above, and commit the result sorted by label.

### The CLI (US-012)

- `apps/cli/src/utils/approval-pending.ts`: `class ApprovalPendingError extends Error` with `readonly request: { id: string; permissionKey: string; requiredMode: string; expiresAt: string; status: string }`, message `approval pending: <id>`.
- `configureApiClient` adds one response interceptor (registered once per process, not once per call): a `202` response's JSON body `{ ret, data }` throws `new ApprovalPendingError(data)`. Any other status returns the response unchanged.
- `handleApiError`:
  - checks `ApprovalPendingError` first.
  - Text mode: stderr `Approval required: <permissionKey> waits for <requiredMode> approval (request <id>, expires <expiresAt>).` then `Follow it with: koda approval show <id>`.
  - `--json` mode: stdout `JSON.stringify({ pending: { id, permissionKey, requiredMode, status, expiresAt } }, null, 2)`. Stdout, not stderr: a pending write is not an error, and a script reads the request id from it.
  - Exits 5.
- The exit-code comment in `error.ts` gains `5: approval pending`. (`.nax/rules/cli.md`, which lists only 0 to 3, is updated outside the nax run, as a follow-up.)

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| `register` with an empty or over-long variant | Throws `approval command variant is invalid: <key>` | US-001 |
| A second command for one `(key, variant)` | Throws `approval command already registered: …` | US-001 |
| `gate` for an unregistered `(key, variant)` | Throws `UnregisteredApprovalCommandError`; no request | US-001 |
| Executing a request whose variant is no longer registered | Request `failed`, result `{ error: 'no-command' }` | US-001 |
| Loading a missing, disabled user or a missing, paused agent | `ActorUnavailableError` | US-002 |
| A deferred run whose actor became unavailable | Request `failed`, `{ error: 'execution-failed', name: 'ActorUnavailableError' }` | US-002 |
| Route gate: caller lacks the key | 403 `permissions`; no request | US-003 |
| Route gate: a SYSTEM actor | Throws `approval route gate needs a principal actor`; no request | US-003 |
| Route gate: a RUNNER actor | 403 `permissions`; no request | US-003 |
| Global policy `PATCH`/`DELETE` for a missing or project policy | 404 `approvals.policyNotFound` before the gate | US-006 |
| `parseBody` on invalid or non-object input | 400 `approvals.invalidInput` | US-003 |
| Agent asks for an owner binding | 403 `permissions` (agents can never hold `role.binding.owner`); no request | US-005 |
| `DELETE /role-bindings/:id` for a missing binding | 404 `permissions.bindingNotFound`; no request | US-005 |
| Approved role or binding write refused by the service (escalation, self-binding, unknown role) | Request `failed`, result names the error class | US-004, US-005 |
| Policy patch that sets no field | 400 `approvals.emptyPolicyPatch` before the gate | US-006, US-007 |
| Project policy of another project | 404 `approvals.policyNotFound` before the gate; `failed` if it differs at execution | US-007 |
| Approved agent policy write that applies to itself | Request `failed`, `ApprovalPolicySelfApplicationError` | US-006 |
| Decide route: request invisible to the caller | 404 before the gate (unchanged) | US-009 |
| Deferred decision on a request that settled meanwhile | Outer request `failed`, `result.name` `DeferredDecisionRefusedError` | US-009 |
| Decide route: decider not eligible | 403 `approvals.decideForbidden` before the gate, with or without a policy on `approval.decide` | US-008, US-009 |
| Deferred decide by a holder of only `approval.decide@<pattern>` | Re-check passes; the decision runs | US-008 |
| Immediate decide on a request already decided | 409 `approvals.notPending` with its status (unchanged) | US-009 |
| Inner execution after a deferred approve fails | Inner request `failed`; the outer stays `executed` | US-009 |
| A new approvable write route that is neither gated nor allowlisted | Contract test fails | US-010 |
| CLI receives 202 | Message, exit 5 | US-012 |

### Integration

**Read-only, verified:**
- `ApprovalGate.gate`, `GateOutcome`: a USER actor executes at once with `approval = { requiredMode, satisfiedBy: 'human', approverType: 'USER', approverId }`; a `none` mode executes with `{ requiredMode: 'none', satisfiedBy: 'none' }`; any other actor gets a pending request.
- `ApprovalExecutionService.execute`: key-only re-check; a throwing command settles `failed` with `{ error: 'execution-failed', name }`.
- `ApprovalDecisionService.decide(requestId, decision, comment, now?, params?)` reads the decider from the action context; its private `record` is the decision transaction.
- `ApprovalRequestExpirySweeper.retryStale` re-executes requests left `approved`.
- `ApprovalExecutionService.executeOnce` rethrows an `ApprovalRequestNotPendingError` from the command instead of settling `failed`.
- `ApprovalPolicyService.create/update/remove/get` read the actor from the action context.
- `RoleAdminService.createRole/updateRole/deleteRole/createBinding/removeBinding(principal, …)` run every check in the documented order.
- `MembershipService.findBinding(id)`.
- `PermissionService.effectiveKeys(principal, scope)`.
- `routeSurface(controller, handler)`.
- `rethrowApprovalError`, `toPolicySubject`.
- Test helpers: `grantKeys`, `grantRole`, `seedFleetHttpWorld`, `seedFleetHttpAgent`, `bootHttpApp({ adapter })`, `data`, `withTestActor`, `configurableTestCommand`.

**Changed** (the baseline only locates the code; implement the target):

| Symbol | Baseline | Target |
|:--|:--|:--|
| `ApprovalCommandRegistry` | one command per key | one per `(key, variant)` |
| `ApprovalGate.gate` opts | `{ projectId }` | `{ projectId, variant? }` |
| `PendingApprovalMatch` | no variant | `variant: string \| null` |
| `PermissionsModule.controllers` | `RolesController`, `RoleBindingsController`, `PermissionCatalogController` | `PermissionCatalogController` |
| `findContractViolations` | `(declarations, catalog = PERMISSION_CATALOG, pending = PENDING_SURFACE_KEYS)` | gains a fourth parameter `pendingGateRoutes = PENDING_GATE_ROUTES` |
| `ApprovalDecisionService.record` | private | public, renamed `recordDecision`; new `assertMayDecide` |
| `ApprovalExecutionService.stillHoldsKey` | bare key or `.own` | also a narrowed `approval.decide@…` key for an `approval.decide` request |

## Out of Scope

- Gating the other approvable write routes: `permissions-p3-approval-gate-high`, `-gate-core-domains` and `-gate-fleet`, as `PENDING_GATE_ROUTES` records.
- Running a route's domain checks (lookups, escalation, self-binding, policy self-application) before a request opens. They run when the command runs.
- Showing `variant` in `ApprovalRequestSummaryDto`, `ApprovalRequestDto`, MCP outputs or the web: P3 web.
- Any change to `apps/web`.
- Assistant or MCP writes on keys that also have REST variants: they keep the primary command.
- `koda approval wait` or any CLI polling of a pending request.
- Updating `.nax/rules/cli.md` (exit codes 4 and 5): a follow-up outside the nax run.
- Notifying the deciders of a pending REST request beyond what `ApprovalRequestedSubscriber` already does for non-fleet keys.
- Updating `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv`.
- An index on `ApprovalRequest.variant`.
- US-002 only: loading agent capabilities into a rebuilt principal.
- US-003 only: pinning the SYSTEM-actor throw of `ApprovalRouteGate.run` through HTTP (no SYSTEM actor reaches a REST route).
- US-009 only: a policy on `approval.decide` that makes agent decisions wait is not seeded or pinned beyond one case.

## Stories

1. **US-001: Command variants on the engine** — `Workdir: apps/api` — No dependencies. The `variant` column and migration, the registry keyed by `(key, variant)`, `gate`'s `variant` option and duplicate match, and the variant-aware lookups in decide and execute.
2. **US-002: Rebuilding the caller** — `Workdir: apps/api` — No dependencies. `ActorPrincipalLoader`, `ActorUnavailableError`, `PrismaAuthRepository.findAgentById` and `hasGlobalAdminBinding`.
3. **US-003: The route gate** — `Workdir: apps/api` — Depends on US-001, US-002. `parseBody`, `routeCommand`, `ApprovalRouteGate`, `ApprovalPending`, `ApprovalGated` and `ApprovalPendingFilter`; the `approvals.invalidInput` messages.
4. **US-004: Gated role routes** — `Workdir: apps/api` — Depends on US-003. `PermissionsApiModule`, `PermissionRouteCommands` (role variants), the three role handlers.
5. **US-005: Gated binding routes** — `Workdir: apps/api` — Depends on US-004. `bindingGateKey`, the binding variants, the two binding handlers.
6. **US-006: Gated global policy routes** — `Workdir: apps/api` — Depends on US-003. `ApprovalRouteCommands` (global policy variants), the three global policy handlers.
7. **US-007: Gated project policy routes** — `Workdir: apps/api` — Depends on US-006. The project policy variants and handlers.
8. **US-008: The decision service for deferred decisions** — `Workdir: apps/api` — No dependencies. `recordDecision` public, `assertMayDecide`, `holdsNarrowedDecide` exported and used by the execution re-check for `approval.decide`.
9. **US-009: Gated decisions** — `Workdir: apps/api` — Depends on US-004, US-006, US-008. `DeferredDecisionRefusedError`, the `decide` variant and handler.
10. **US-010: The gate contract** — `Workdir: apps/api` — Depends on US-005, US-007, US-009. `method` and `gated` on route declarations, the three violations, `PENDING_GATE_ROUTES`.
11. **US-011: OpenAPI document and endpoint coverage** — `Workdir: apps/api` — Depends on US-010. `openapi.json` regenerated; `endpoint.e2e.spec.ts` gains the 202 cases.
12. **US-012: The CLI on a pending write** — `Workdir: apps/cli` — Depends on US-011. `ApprovalPendingError`, the response interceptor, `handleApiError`, the rule file.

### Context Files

- `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§4, §7)
- `apps/api/src/approvals/approval-command.registry.ts`
- `apps/api/src/approvals/approval-gate.service.ts`
- `apps/api/src/approvals/approval-execution.service.ts`
- `apps/api/src/approvals/approval-decision.service.ts`
- `apps/api/src/approvals/approval-ask.service.ts`
- `apps/api/src/approvals/prisma-approval-request.repository.ts`
- `apps/api/src/approvals/domain/approval.domain.ts`
- `apps/api/src/approvals/approval-requests.controller.ts`
- `apps/api/src/approvals/approval-policies.controller.ts`
- `apps/api/src/approvals/project-approval-policies.controller.ts`
- `apps/api/src/approvals/approval-http-errors.ts`
- `apps/api/src/approvals/dto/approval-request.dto.ts`
- `apps/api/src/approvals/test-helpers/test-approval-command.ts`
- `apps/api/src/fleet/assistant/commands/assistant-tool-commands.ts` (the `onModuleInit` registration pattern)
- `apps/api/src/fleet/assistant/prisma-assistant-tool-call.repository.ts` (`findUserActor`)
- `apps/api/src/auth/jwt-auth.provider.ts`, `apps/api/src/auth/agent-auth.provider.ts`, `apps/api/src/auth/prisma-auth.repository.ts`, `apps/api/src/auth/auth-repository.module.ts`
- `apps/api/src/permissions/roles.controller.ts`, `role-bindings.controller.ts`, `role-admin.service.ts`, `permissions.module.ts`
- `apps/api/src/permissions/test-helpers/permission-contract.ts`
- `apps/api/test/integration/approvals/approval-decide-route.integration.spec.ts` (HTTP fixtures)
- `apps/cli/src/utils/api-client.ts`, `apps/cli/src/utils/error.ts`

### Creates

- `apps/api/prisma/migrations/20261108090000_approval_request_variant/migration.sql` — US-001
- `apps/api/test/integration/approvals/approval-variants.integration.spec.ts` — US-001
- `apps/api/src/auth/principal/actor-principal.loader.ts` — US-002
- `apps/api/src/auth/principal/actor-principal.loader.spec.ts` — US-002
- `apps/api/test/integration/auth/actor-principal-loader.integration.spec.ts` — US-002
- `apps/api/src/approvals/route/parse-body.ts` — US-003
- `apps/api/src/approvals/route/parse-body.spec.ts` — US-003
- `apps/api/src/approvals/route/route-command.ts` — US-003
- `apps/api/src/approvals/route/route-command.spec.ts` — US-003
- `apps/api/src/approvals/route/approval-route-gate.ts` — US-003
- `apps/api/src/approvals/route/approval-route-gate.spec.ts` — US-003
- `apps/api/src/approvals/route/approval-pending.ts` — US-003
- `apps/api/src/approvals/route/approval-gated.decorator.ts` — US-003
- `apps/api/src/approvals/route/approval-gated.decorator.spec.ts` — US-003
- `apps/api/test/integration/approvals/approval-pending-status.integration.spec.ts` — US-004
- `apps/api/src/permissions/permissions-api.module.ts` — US-004
- `apps/api/src/permissions/permissions-api.module.spec.ts` — US-004
- `apps/api/src/permissions/permission-route.commands.ts` — US-004
- `apps/api/src/permissions/permission-route.commands.spec.ts` — US-004
- `apps/api/test/integration/permissions/gated-role-routes.integration.spec.ts` — US-004
- `apps/api/test/integration/permissions/gated-binding-routes.integration.spec.ts` — US-005
- `apps/api/src/approvals/approval-route.commands.ts` — US-006
- `apps/api/src/approvals/approval-route.commands.spec.ts` — US-006
- `apps/api/test/integration/approvals/gated-policy-routes.integration.spec.ts` — US-006
- `apps/api/test/integration/approvals/gated-project-policy-routes.integration.spec.ts` — US-007
- `apps/api/test/integration/approvals/gated-decide-route.integration.spec.ts` — US-009
- `apps/api/src/permissions/pending-gate-routes.ts` — US-010
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — US-011
- `apps/cli/src/utils/approval-pending.ts` — US-012
- `apps/cli/src/utils/approval-pending.spec.ts` — US-012

Files created by one story and extended by a later one are credited to the first (the lint refuses a Modifies entry for a path that does not exist yet): `permission-route.commands.ts` and its spec gain the binding variants in US-005; `approval-route.commands.ts` and its spec gain the project policy variants in US-007 and `decide` (with `DeferredDecisionRefusedError`) in US-009; `approval-pending-status.integration.spec.ts` gains the decide case in US-009.

### Modifies

**US-001**
- `apps/api/prisma/schema.prisma` — `ApprovalRequest.variant String?`
- `apps/api/src/approvals/domain/approval.domain.ts` — `ApprovalRequestRecord.variant?: string`
- `apps/api/src/approvals/prisma-approval-request.repository.ts` — `create` writes `variant`; the mapping adds it when not null; `PendingApprovalMatch.variant` and its match in `findPendingDuplicate`
- `apps/api/src/approvals/approval-command.registry.ts` — `ApprovalCommand.variant`; `register` and `get` by `(key, variant)`
- `apps/api/src/approvals/approval-command.registry.spec.ts` — the variant cases
- `apps/api/src/approvals/approval-gate.service.ts` — `opts.variant`; the lookup, the duplicate match and the new row carry it
- `apps/api/src/approvals/approval-gate.service.spec.ts` — the `registry.get` and `findPendingDuplicate` expectations gain the variant argument (`undefined` → `null` for existing cases)
- `apps/api/src/approvals/approval-execution.service.ts` — `registry.get(permissionKey, variant)`
- `apps/api/src/approvals/approval-execution.service.spec.ts` — the registry double answers by `(key, variant)`; one variant case
- `apps/api/src/approvals/approval-decision.service.ts` — `registry.get(permissionKey, variant)`
- `apps/api/src/approvals/approval-decision.service.spec.ts` — the registry double's expectation gains the variant argument
- `apps/api/src/approvals/approval-decision-params.spec.ts` — the same
- `apps/api/src/approvals/test-helpers/test-approval-command.ts` — `configurableTestCommand(key, deps)` accepts `deps.variant?: string`; when given, the command object carries a `variant` getter (a plain own property alongside the existing getters, never a spread of them)
- `apps/api/test/integration/approvals/approval-repositories.integration.spec.ts` — the `PendingApprovalMatch` literal gains `variant: null`

**US-002**
- `apps/api/src/auth/prisma-auth.repository.ts` — `findAgentById`, `hasGlobalAdminBinding`
- `apps/api/src/auth/prisma-auth.repository.spec.ts` — the two methods' query shapes
- `apps/api/src/auth/auth-repository.module.ts` — provides and exports `ActorPrincipalLoader`

**US-003**
- `apps/api/src/approvals/approval-engine.module.ts` — provides and exports `ApprovalRouteGate`
- `apps/api/src/approvals/approval-engine.module.spec.ts` — resolves `ApprovalRouteGate`
- `apps/api/src/i18n/en/approvals.json` — `invalidInput` (`400` and `-2`: `Invalid input for the approval request`)
- `apps/api/src/i18n/zh/approvals.json` — `invalidInput` (`400` and `-2`: `审批请求的输入无效`)

**US-004**
- `apps/api/src/permissions/permissions.module.ts` — drops `RolesController` and `RoleBindingsController` from `controllers`
- `apps/api/src/app.module.ts` — imports `PermissionsApiModule`
- `apps/api/src/permissions/roles.controller.ts` — constructor gains `ApprovalRouteGate`; `create`, `update`, `remove` gated
- `apps/api/src/permissions/role-bindings.controller.ts` — constructor gains `MembershipService` and `ApprovalRouteGate` (the handlers change in US-005)
- `apps/api/src/permissions/remaining-route-declarations.spec.ts` — unchanged assertions; listed because it imports the two controllers, which must still compile under the new module

**US-005**
- `apps/api/src/permissions/role-bindings.controller.ts` — `create` and `remove` gated
- `apps/api/src/permissions/role-admin.service.ts` — exports `OWNER_ROLE_KEY`; nothing else changes

**US-006**
- `apps/api/src/approvals/approval-api.module.ts` — imports `AuthRepositoryModule`, provides `ApprovalRouteCommands`
- `apps/api/src/approvals/approval-api.module.spec.ts` — resolves `ApprovalRouteCommands`
- `apps/api/src/approvals/approval-policies.controller.ts` — constructor gains `ApprovalRouteGate`; `create`, `update`, `remove` gated
- `apps/api/test/integration/approvals/approval-policy-routes.integration.spec.ts` — its AC-12 (an agent's self-applying create answers 403 at once) now expects 202, then `failed` with `ApprovalPolicySelfApplicationError` after the root user approves

**US-007**
- `apps/api/src/approvals/project-approval-policies.controller.ts` — constructor gains `ApprovalRouteGate`; `create`, `update`, `remove` gated

**US-008**
- `apps/api/src/approvals/approval-decision.service.ts` — `record` becomes public `recordDecision`; `decide` calls it; `assertMayDecide`
- `apps/api/src/approvals/approval-decision.service.spec.ts` — the `recordDecision` and `assertMayDecide` cases
- `apps/api/src/permissions/permission.service.ts` — exports `holdsNarrowedDecide`; nothing else changes
- `apps/api/src/approvals/approval-execution.service.ts` — `stillHoldsKey` accepts a narrowed decide key for an `approval.decide` request
- `apps/api/src/approvals/approval-execution.service.spec.ts` — the narrowed re-check cases

**US-009**
- `apps/api/src/approvals/approval-requests.controller.ts` — constructor gains `ApprovalRouteGate` and `ApprovalExecutionService`; `decide` gated; maps `DeferredDecisionRefusedError`

**US-010**
- `apps/api/src/permissions/test-helpers/permission-contract.ts` — `method`, `gated`, the three violations, the `pendingGateRoutes` parameter
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — the new violation cases on hand-built declarations
- `apps/api/src/permissions/test-helpers/permission-contract.collector.spec.ts` — `method` and `gated` collected
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the gate assertions over the booted app

**US-011**
- `openapi.json` — regenerated with `bun run api:export-spec` from the repo root; the 12 gated operations gain a `202` response and nothing else changes (the CLI's generated client is gitignored and regenerated with `bun run generate:cli`, not committed)
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the 202 cases below

**US-012**
- `apps/cli/src/utils/api-client.ts` — the response interceptor
- `apps/cli/src/utils/error.ts` — the `ApprovalPendingError` branch and the exit-code comment
- `apps/cli/src/utils/error.spec.ts` — the pending cases

### Seams

- US-001 → US-003 to US-009: `gate(…, { variant })` and `get(key, variant)`. US-004 AC-4 approves a `rest:roles.create` request, which the engine finds by its variant.
- US-002 → US-003: `loader.forContext()`. US-003 AC-6 runs a route command's `execute` under an agent context.
- US-003 → US-004 to US-009: `ApprovalRouteGate`, `@ApprovalGated()`, `ApprovalPending`. US-004 AC-1 is the first 202 over HTTP; US-004 AC-13/AC-14 pin it on Fastify.
- US-004 → US-005: `PermissionRouteCommands` and `PermissionsApiModule`. US-005 AC-1 opens a binding request through the route.
- US-008 → US-009: `recordDecision`, `assertMayDecide` and the narrowed re-check. US-009 AC-4 approves a deferred decision; US-009 AC-15 is refused by `assertMayDecide`.
- US-006 → US-007, US-009: `ApprovalRouteCommands`. US-007 AC-1 and US-009 AC-2 open requests through their routes.
- US-010 → US-011: the contract passes with the allowlist; US-011's regenerated document reflects the 12 gated routes.

## Acceptance Criteria

Integration tests run with `bun run test:db:up` in `apps/api` first. HTTP fixtures follow `approval-decide-route.integration.spec.ts`: `seedFleetHttpWorld` gives the Owner (`root`) token, `seedFleetHttpAgent` an agent and its API key, and `grantKeys` binds keys. "Approve" means `POST /api/approvals/:id/decisions` `{ decision: 'approve' }` with the root token. Each AC is one assertion.

### US-001: Command variants on the engine

- AC-1 [unit] `register` of a primary command and a `variant: 'rest:labels.delete'` command for `label.delete` both succeed.
- AC-2 [unit] `get('label.delete')` answers the primary command and `get('label.delete', 'rest:labels.delete')` answers the variant command.
- AC-3 [unit] `get('label.delete', 'rest:other')` answers undefined while only the primary and `rest:labels.delete` are registered.
- AC-4 [unit] A second `register` of `label.delete` with variant `rest:labels.delete` throws `approval command already registered: label.delete#rest:labels.delete`.
- AC-5 [unit] `register` with `variant: ''` throws `approval command variant is invalid: label.delete`.
- AC-6 [unit] `register` with a 101-character variant throws the same message.
- AC-7 [integration] `ApprovalGate.gate('label.delete', input, { projectId, variant: 'rest:labels.delete' })` by an agent whose resolved mode is `agent` stores a pending request whose `variant` column is `rest:labels.delete`.
- AC-8 [integration] The same call without `variant` stores a request whose `variant` column is null, and the record answered has no `variant` property.
- AC-9 [integration] With a variant request pending, the same agent calling `gate` with the same input and no `variant` opens a second request (the duplicate match includes the variant).
- AC-10 [integration] Approving a pending `rest:labels.delete` request runs the variant command (a `configurableTestCommand('label.delete', { variant: 'rest:labels.delete' })`) once and the primary command zero times.
- AC-11 [integration] Approving a pending request whose `variant` names no registered command settles it `failed` with result `{ error: 'no-command' }`.
- AC-12 [integration] Approving a pending request whose `variant` column is null runs the primary command (regression pin for requests opened before this feature).
- AC-13 [unit] `ApprovalDecisionService.decide` on a request with `variant: 'v1'` looks the command up with `registry.get(key, 'v1')`.
- AC-14 [unit] `ApprovalGate.gate('label.delete', input, { projectId, variant: 'rest:none' })` with no command registered for that pair throws `UnregisteredApprovalCommandError` and never calls `requests.create`.

### US-002: Rebuilding the caller

- AC-1 [integration] `load({ type: 'USER', id })` for a user with a global `admin` binding answers an object matching `{ actorType: 'user', id, email, role: 'ADMIN', revoked: false }`.
- AC-2 [integration] `load` for a user with only a project `developer` binding answers `role: 'MEMBER'`.
- AC-3 [integration] `load` for a disabled user throws `ActorUnavailableError`.
- AC-4 [integration] `load({ type: 'USER', id: 'missing' })` throws `ActorUnavailableError`.
- AC-5 [integration] `load({ type: 'AGENT', id })` for an `ACTIVE` agent answers an object matching `{ actorType: 'agent', id, slug, status: 'ACTIVE', blacklisted: false }`.
- AC-6 [integration] `load` for a `PAUSED` agent throws `ActorUnavailableError`.
- AC-7 [unit] `forContext()` under a `SYSTEM/assistant` actor throws `ActorUnavailableError` without calling the repository.
- AC-8 [unit] `forContext()` with no action context throws `ActorUnavailableError`.
- AC-9 [unit] `ActorUnavailableError` is an `Error` whose prototype is `ActorUnavailableError.prototype` and whose `actor` is the value passed.
- AC-10 [integration] An agent's pending request for a test command (registered by the spec under an approvable key) whose `execute` calls `loader.forContext()`, approved after the agent is set `PAUSED`, settles `failed` with `result` `{ error: 'execution-failed', name: 'ActorUnavailableError' }`.

### US-003: The route gate

- AC-1 [unit] `parseBody(CreateRoleDto, { key: 'qa', name: 'QA', scope: 'GLOBAL', permissions: ['role.read'], extra: 1 })` answers a plain object without `extra` whose prototype is `Object.prototype`.
- AC-2 [unit] `parseBody(CreateRoleDto, { name: 'QA', scope: 'GLOBAL', permissions: [] })` (no key) throws `ValidationAppException` with key `approvals.invalidInput`.
- AC-3 [unit] `parseBody(CreateRoleDto, null)` throws the same exception.
- AC-4 [unit] `routeCommand({ key: 'role.manage', variant: 'rest:x', parse, run }, loader)` answers a command whose `key` is `role.manage` and `variant` is `rest:x`.
- AC-5 [unit] Its `execute(input)` calls `run` with the principal `loader.forContext()` answered and the input.
- AC-6 [integration] Under an agent's action context, the `execute` of a `routeCommand` whose `run` returns `principal.actorType` answers `'agent'`.
- AC-7 [unit] `ApprovalRouteGate.run` for an agent whose effective keys lack `role.manage` throws `ForbiddenAppException` with key `permissions` and never calls `gate.gate`.
- AC-8 [unit] `run` for an agent holding `ticket.update.own` (and not `ticket.update`) calls `gate.gate('ticket.update', input, { projectId, variant })`.
- AC-9 [unit] `run` reads the effective keys at `'global'` when `projectId` is null and at `{ projectId }` otherwise.
- AC-10 [unit] `run` with `keyCheck: false` for an agent holding no key calls `gate.gate` and never calls `effectiveKeys`.
- AC-11 [unit] `run` under a `SYSTEM/budget` actor throws `approval route gate needs a principal actor` and never calls `gate.gate`.
- AC-12 [unit] `ApprovalPendingFilter.catch(new ApprovalPending(record), host)` calls `httpAdapter.reply(response, JsonResponse.Ok(ApprovalRequestSummaryDto.from(record)), 202)`.
- AC-13 [unit] `run` under a `RUNNER/r1` actor throws `ForbiddenAppException` with key `permissions` and never calls `gate.gate`.
- AC-14 [unit] A handler decorated with `@ApprovalGated()` carries `APPROVAL_GATED_METADATA` `true` and `ApprovalPendingFilter` in its exception filters metadata.
- AC-15 [unit] The same handler's swagger responses include status 202 whose `data` schema references `ApprovalRequestSummaryDto`.

### US-004: Gated role routes

The agent in these ACs holds global `role.manage` and `role.read` (`grantKeys(db, agent, ['role.manage', 'role.read'], null)`): a GLOBAL role can carry only global keys, and `createRole` checks escalation at the global scope.

- AC-1 [integration] `POST /api/roles` with the agent's key, body `{ key: 'qa', name: 'QA', scope: 'GLOBAL', permissions: ['role.read'] }`, answers 202.
- AC-2 [integration] That response's `data` matches `{ permissionKey: 'role.manage', status: 'pending', requiredMode: 'human', actorType: 'AGENT', actorId: <the agent> }`.
- AC-3 [integration] After AC-1 no role with key `qa` exists.
- AC-4 [integration] After approving AC-1's request, a role with key `qa` exists and the request's status is `executed`.
- AC-5 [integration] That executed request's `result` matches `{ key: 'qa', name: 'QA' }`.
- AC-6 [integration] The audit entry of AC-4's role create matches `{ actorType: 'AGENT', actorId: <the agent>, key: 'role.manage', satisfiedBy: 'human', approverType: 'USER', approverId: <root>, approvalRequestId: <the request> }`.
- AC-7 [integration] `POST /api/roles` with the root token answers 201 with the role, and no `ApprovalRequest` row exists.
- AC-8 [integration] The audit entry of AC-7's create has `requiredMode: 'human'`, `satisfiedBy: 'human'` and `approverId: <root>`.
- AC-9 [integration] `POST /api/roles` with the key of an agent that holds no `role.manage` answers 403 with key `permissions`, and no `ApprovalRequest` row exists.
- AC-10 [integration] `PATCH /api/roles/:id` `{ name: 'Renamed' }` by the agent answers 202, and after approval the role's name is `Renamed`.
- AC-11 [integration] `DELETE /api/roles/:id` of an unbound custom role by the agent answers 202 with a body whose `data.status` is `pending`, and after approval the role no longer exists.
- AC-12 [integration] An approved agent request to create a PROJECT-scope role granting `project.delete` (a key the agent holds nowhere) settles `failed` with `result.name` `ForbiddenAppException`, and no role is created.
- AC-13 [integration] In `approval-pending-status.integration.spec.ts`, booted with `bootHttpApp({ adapter: 'fastify' })`, the agent's `POST /api/roles` (an `@HttpCode(201)` route) answers status 202 with `data.status` `pending`.
- AC-14 [integration] In the same Fastify app, the agent's `DELETE /api/roles/:id` (an `@HttpCode(204)` route) answers status 202 with `data.permissionKey` `role.manage`.
- AC-15 [unit] `PermissionsApiModule` compiles with `GlobalStubsModule` and resolves `RolesController`, `RoleBindingsController` and `PermissionRouteCommands`, and after `onModuleInit` the registry answers `role.manage` commands for `rest:roles.create`, `rest:roles.update` and `rest:roles.delete`.

### US-005: Gated binding routes

- AC-1 [integration] `POST /api/role-bindings` by an agent holding `role.binding.manage` in project P and bound `viewer` in P (`grantRole`), body `{ principalType: 'USER', principalId: <dev>, roleKey: 'viewer', projectId: P }`, answers 202 with `data.permissionKey` `role.binding.manage` and `data.projectId` P.
- AC-2 [integration] After approving AC-1's request, `dev` holds a `viewer` binding in P.
- AC-3 [integration] `POST /api/role-bindings` by an agent holding only global `role.binding.global`, body `{ principalType: 'USER', principalId: <dev>, roleKey: 'admin' }` (no `projectId`), answers 202 with `data.permissionKey` `role.binding.global` and `data.projectId` null.
- AC-4 [integration] `POST /api/role-bindings` with `roleKey: 'owner'` by the AC-3 agent answers 403 with key `permissions`, and no `ApprovalRequest` row exists.
- AC-5 [integration] `DELETE /api/role-bindings/:id` of `dev`'s P binding by the AC-1 agent answers 202 with `data.permissionKey` `role.binding.manage`.
- AC-6 [integration] After approving AC-5's request, the binding no longer exists.
- AC-7 [integration] `DELETE /api/role-bindings/missing` by the AC-1 agent answers 404 with key `permissions.bindingNotFound`, and no `ApprovalRequest` row exists.
- AC-8 [integration] `POST /api/role-bindings` by the AC-1 agent binding itself `viewer` in P, approved, settles `failed`, and the agent holds no new binding.
- AC-9 [integration] `POST /api/role-bindings` with the root token answers 201 with the binding (regression pin).
- AC-10 [unit] `bindingGateKey({ roleKey: 'owner', projectId: null })` answers `role.binding.owner`.
- AC-11 [unit] `bindingGateKey({ roleKey: 'admin', projectId: null })` answers `role.binding.global`.
- AC-12 [unit] `bindingGateKey({ roleKey: 'viewer', projectId: 'p1' })` answers `role.binding.manage`.
- AC-13 [unit] After `onModuleInit`, each of `role.binding.owner`, `role.binding.global` and `role.binding.manage` has commands with variants `rest:role-bindings.create` and `rest:role-bindings.delete`.

### US-006: Gated global policy routes

Agent-written policies in these ACs use `appliesTo: { kind: 'type', principalType: 'USER' }`: `ApprovalPolicyService` refuses an agent a policy whose subject is `all`, `AGENT` or itself.

- AC-1 [integration] `POST /api/approval-policies` by an agent holding global `approval.policy.manage`, body `{ permissionPattern: 'label.delete', appliesTo: { kind: 'type', principalType: 'USER' }, mode: 'agent' }`, answers 202 with `data.permissionKey` `approval.policy.manage` and `data.requiredMode` `human`.
- AC-2 [integration] After AC-1 no `ApprovalPolicy` row exists.
- AC-3 [integration] After approving AC-1's request, one global policy for `label.delete` with mode `agent` exists, and its `updatedByType` is `AGENT`.
- AC-4 [integration] `PATCH /api/approval-policies/:id` `{ mode: 'human' }` on that policy by that agent answers 202, and after approval the policy's mode is `human`.
- AC-5 [integration] `PATCH /api/approval-policies/:id` `{}` by that agent answers 400 with key `approvals.emptyPolicyPatch`, and no `ApprovalRequest` row exists.
- AC-6 [integration] `DELETE /api/approval-policies/:id` by that agent answers 202, and after approval the policy no longer exists.
- AC-7 [integration] An approved agent request to create a policy whose `appliesTo` is `{ kind: 'all' }` settles `failed` with `result.name` `ApprovalPolicySelfApplicationError`.
- AC-8 [integration] `POST /api/approval-policies` with the root token answers 201 with the policy (regression pin).
- AC-9 [unit] After `onModuleInit`, `approval.policy.manage` has commands with variants `rest:approval-policies.create`, `.update` and `.delete`.
- AC-10 [unit] The `rest:approval-policies.update` command's `parse({ id: 'p1', patch: {} })` throws `ValidationAppException` with key `approvals.emptyPolicyPatch`.
- AC-11 [unit] The `rest:approval-policies.delete` command's run on a policy whose `projectId` is `'p1'` throws `ApprovalPolicyNotFoundError` and never calls `policies.remove`.
- AC-12 [unit] `ApprovalApiModule` compiles with `GlobalStubsModule` and resolves `ApprovalRouteCommands`.
- AC-13 [integration] `DELETE /api/approval-policies/missing` by the agent answers 404 with key `approvals.policyNotFound`, and no `ApprovalRequest` row exists.
- AC-14 [integration] (updated existing test, `approval-policy-routes.integration.spec.ts` AC-12) The globally granted agent's self-applying `POST /api/approval-policies` answers 202, and after approval the request is `failed` with `result.name` `ApprovalPolicySelfApplicationError`.

### US-007: Gated project policy routes

The agent holds `approval.policy.manage` in project P; its policies use `appliesTo: { kind: 'type', principalType: 'USER' }`.

- AC-1 [integration] `POST /api/projects/:slug/approval-policies` by the agent answers 202 with `data.projectId` P.
- AC-2 [integration] After approving AC-1's request, one policy with `projectId` P exists.
- AC-3 [integration] `PATCH /api/projects/:slug/approval-policies/:id` `{ mode: 'human' }` by the agent answers 202, and after approval the policy's mode is `human`.
- AC-4 [integration] `DELETE /api/projects/:slug/approval-policies/:id` by the agent answers 202, and after approval the policy no longer exists.
- AC-5 [integration] `PATCH /api/projects/:slug/approval-policies/:id` for another project's policy answers 404 with key `approvals.policyNotFound`, and no `ApprovalRequest` row exists.
- AC-6 [integration] `PATCH /api/projects/:slug/approval-policies/:id` `{}` by the agent answers 400 with key `approvals.emptyPolicyPatch`, and no `ApprovalRequest` row exists.
- AC-7 [integration] `POST /api/projects/:slug/approval-policies` with the root token answers 201 (regression pin).
- AC-8 [unit] The `rest:project-approval-policies.update` command's run on a policy whose `projectId` differs from the input's throws `ApprovalPolicyNotFoundError` and never calls `policies.update`.
- AC-9 [unit] The `rest:project-approval-policies.create` command's run calls `policies.create` with `projectId` the input's `projectId`.
- AC-10 [unit] After `onModuleInit`, `approval.policy.manage` also has variants `rest:project-approval-policies.create`, `.update` and `.delete`.

### US-008: The decision service for deferred decisions

- AC-1 [unit] `recordDecision(id, 'approve', null, now)` records the decision, transitions the request to `approved`, and never calls `execution.execute`.
- AC-2 [unit] `decide(id, 'approve', null)` calls `recordDecision` and then `execution.execute(id)` (regression pin).
- AC-3 [unit] `assertMayDecide(id)` for a decider whose `decideEligibility` answers `{ ok: false, reason: 'tier-too-low' }` throws `ApprovalDecideForbiddenError` with reason `tier-too-low`.
- AC-4 [unit] `assertMayDecide(id)` for an eligible decider resolves and writes nothing (`createDecision` and `transition` never called).
- AC-5 [unit] `assertMayDecide('missing')` throws `ApprovalRequestNotFoundError`.
- AC-6 [unit] `ApprovalExecutionService` pre-check of an approved `approval.decide` request whose actor's effective keys are `{ 'approval.decide@label.*' }` passes the key re-check (the command runs).
- AC-7 [unit] The same pre-check for a `label.delete` request whose actor holds only `approval.decide@label.*` settles `failed` with `{ error: 'permission-revoked' }`.
- AC-8 [unit] `holdsNarrowedDecide(new Set(['approval.decide@fleet.*']))` answers true, and `holdsNarrowedDecide(new Set(['approval.decide']))` answers false.

### US-009: Gated decisions

Fixtures follow `approval-decide-route.integration.spec.ts`: a `label.delete` test command is registered as the primary command; agent B (the requester) holds `label.delete` in P and opens the inner request through `ApprovalGate.gate` under `withTestActor`, mode `agent`; agent A (the decider) holds `approval.decide` and `label.delete` in P.

- AC-1 [integration] With no policy on `approval.decide`, agent A's `POST /api/approvals/:id/decisions` `{ decision: 'approve' }` answers 200 with `data.status` `executed` (regression pin: the default mode is `none`).
- AC-2 [integration] With a global policy `{ permissionPattern: 'approval.decide', appliesTo: { kind: 'type', principalType: 'AGENT' }, mode: 'human' }` (created by root), the same call answers 202 with `data.permissionKey` `approval.decide`.
- AC-3 [integration] After AC-2, the inner request is still `pending`.
- AC-4 [integration] After the root user approves AC-2's request, the inner request's status is `executed` and its `approverId` is agent A.
- AC-5 [integration] After AC-4, AC-2's request is `executed`.
- AC-6 [integration] If agent B cancels the inner request (`POST /api/approvals/:id/cancel`) while AC-2's request waits, approving AC-2's request settles it `failed` with `result.name` `DeferredDecisionRefusedError`.
- AC-7 [integration] If the inner command throws when the deferred approve runs, AC-2's request is `executed` and the inner request is `failed`.
- AC-8 [integration] Agent A's decision on a request invisible to it answers 404 with key `approvals.requestNotFound`, and no `approval.decide` request exists.
- AC-9 [integration] (regression pin, the existing `approval-decide-route.integration.spec.ts` AC-7) An agent below the request's tier still gets 403 `approvals.decideForbidden` with reason `tier-too-low`.
- AC-10 [integration] In `approval-pending-status.integration.spec.ts` on Fastify, the AC-2 call (an `@HttpCode(200)` route) answers status 202.
- AC-11 [unit] The `rest:approvals.decide` command's `parse({ requestId: 'r1', decision: 'maybe', comment: null })` throws `ValidationAppException` with key `approvals.invalidInput`.
- AC-12 [unit] The `rest:approvals.decide` command's run calls `decisions.recordDecision('r1', 'reject', 'no', <a Date>, undefined)` and never calls `execution.execute`.
- AC-13 [unit] Its `afterCommit` for an approve input calls `execution.execute('r1')`.
- AC-14 [integration] Agent A's immediate decision on a request already `rejected` answers 409 with key `approvals.notPending` and the message naming `rejected` (regression pin).
- AC-15 [integration] With the AC-2 policy in force, an agent below the inner request's tier answers 403 `approvals.decideForbidden` with reason `tier-too-low`, and no `approval.decide` request exists.

### US-010: The gate contract

- AC-1 [unit] `findContractViolations` reports `ungated-approvable-write` for a hand-built `DELETE /labels/:id` declaration requiring `label.delete`, not gated, with an empty gate allowlist as the fourth argument.
- AC-2 [unit] The same declaration listed in the fourth argument yields no violation.
- AC-3 [unit] A gated `POST` declaration requiring only `ticket.read` yields `gated-without-approvable-key`.
- AC-4 [unit] An allowlist entry for a gated route yields `stale-pending-gate-route`.
- AC-5 [unit] An allowlist entry naming no collected route yields `stale-pending-gate-route`.
- AC-6 [unit] A `GET` declaration requiring `approval.decide`, not gated, yields no violation.
- AC-7 [unit] A catalog passed as the second argument in which `label.delete` is not approvable makes the AC-1 declaration yield no violation.
- AC-8 [unit] The collector reports `method: 'POST'` and `gated: true` for `RolesController.create`.
- AC-9 [unit] `PENDING_GATE_ROUTES` has no entry starting with `POST /roles`, `PATCH /roles`, `DELETE /roles`, `POST /role-bindings`, `DELETE /role-bindings`, `POST /approval-policies`, `PATCH /approval-policies`, `DELETE /approval-policies`, `POST /projects/:slug/approval-policies`, `PATCH /projects/:slug/approval-policies`, `DELETE /projects/:slug/approval-policies` or `POST /approvals/:id/decisions`.
- AC-10 [unit] `PENDING_GATE_ROUTES.get('DELETE /projects/:slug')` is `gate-high`.
- AC-11 [unit] `PENDING_GATE_ROUTES.get('POST /projects/:slug/tickets')` is `gate-core-domains`.
- AC-12 [unit] `PENDING_GATE_ROUTES.get('POST /projects/:slug/threads')` is `gate-fleet`.
- AC-13 [integration] Over the booted app, the collected routes contain exactly 12 gated routes.
- AC-14 [integration] Over the booted app, `findContractViolations` reports no violation (the existing AC-6 assertion, now including the gate rules).

### US-011: OpenAPI document and endpoint coverage

- AC-1 [unit] `openapi.json`'s `post /api/roles` operation has a `202` response.
- AC-2 [unit] `openapi.json`'s `delete /api/role-bindings/{id}` operation has a `202` response.
- AC-3 [unit] `openapi.json`'s `post /api/approvals/{id}/decisions` operation has a `202` response.
- AC-4 [unit] The operations of `openapi.json` with a `202` response are exactly the 12 gated ones plus the existing `post /api/projects/{slug}/knowledge/repos/{repoId}/reindex`.
- AC-5 [integration] In `endpoint.e2e.spec.ts`, `POST /api/roles` with the key of an agent holding global `role.manage` answers exactly 202.
- AC-6 [integration] In `endpoint.e2e.spec.ts`, `POST /api/approval-policies` with the key of an agent holding global `approval.policy.manage` answers exactly 202.
- AC-7 [integration] In `endpoint.e2e.spec.ts`, `DELETE /api/role-bindings/:id` with the key of an agent holding `role.binding.manage` in the binding's project answers exactly 202.

Verification note: `openapi.json` is regenerated with `bun run api:export-spec` (repo root); `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint` pass. AC-1 to AC-4 live in `src/approvals/approval-openapi.contract.spec.ts`, which reads `openapi.json`.

### US-012: The CLI on a pending write

- AC-1 [unit] The response interceptor installed by `configureApiClient`, given a `Response` with status 202 and body `{ ret: 0, data: { id: 'r1', permissionKey: 'role.manage', requiredMode: 'human', status: 'pending', expiresAt: '2026-11-09T00:00:00.000Z' } }`, rejects with an `ApprovalPendingError` whose `request.id` is `r1`.
- AC-2 [unit] The interceptor returns a 200 response unchanged.
- AC-3 [unit] Calling `configureApiClient` twice leaves one response interceptor installed.
- AC-4 [unit] `handleApiError(new ApprovalPendingError(request))` in text mode writes `Approval required: role.manage waits for human approval (request r1, expires 2026-11-09T00:00:00.000Z).` to stderr.
- AC-5 [unit] In text mode it also writes `Follow it with: koda approval show r1` to stderr.
- AC-6 [unit] It exits with code 5.
- AC-7 [unit] In `--json` mode it writes `{ "pending": { "id": "r1", "permissionKey": "role.manage", "requiredMode": "human", "status": "pending", "expiresAt": "2026-11-09T00:00:00.000Z" } }` (2-space indented) to stdout and nothing to stderr.
- AC-8 [unit] `ApprovalPendingError` is an `Error` whose message is `approval pending: r1`.

Verification note: `bun run --cwd apps/cli type-check`, `lint` and `test` pass. The generated client is not regenerated by hand; `bun run generate:cli` (repo root) regenerates it from the US-011 `openapi.json`, and no command module changes.
