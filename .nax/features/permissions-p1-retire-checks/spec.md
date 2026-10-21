# SPEC: Permissions P1h — Retire the Legacy Checks

## Summary

This feature removes the last authorization decisions in `apps/api` that read a legacy role, and deletes the mechanisms nothing calls any more:
- **Project access becomes a key.** `ProjectAccessService.resolveMembership`, which `ProjectMembershipGuard` and every in-handler membership check use, decides with `PermissionService.can(principal, 'project.read', { projectId })` instead of `principal.role === 'ADMIN'` plus the access-source reads.
- **The remaining `principal.role === 'ADMIN'` decisions become keys** that only global Owners and Admins hold with the seeded roles:
  - listing every project, and the home dashboard's cross-project scope: `project.read` held globally;
  - triggering another agent's pickup: `agent.update`;
  - removing a project's last admin: `role.binding.global`;
  - a user assignee's eligibility: the assignee holds `project.read` in the project.
- **The domain writer** checks the actor's project access by key (`project.read`) instead of its own legacy role list.
- **The workspace thread stream** checks its declared key `thread.workspace.read` through `RequiresGuard`.
- **Deleted:**
  - the CASL factory (`KodaCaslAbilityFactory`, `KodaAction`) and its registration;
  - `@ProjectPermission`, `@ProjectRoles`, `exemptAgents` and the guard steps that read them;
  - `withProjectRole`, `ProjectContext.role` and `UserPrincipal.projectRole`;
  - `canOverrideClose`, `assertTransitionPermission`, `AssistantTool.permission` / `ToolPermission`;
  - `ProjectAccessService.assertProjectAdmin` / `canManageMembers`, and the `ProjectsService` wrappers;
  - `FleetActivityService.memberProjectIds`, `ApprovalCaller.globalAdmin`, `ApprovalRoute.role`;
  - the unreachable IN_PROGRESS → VERIFIED transition rule, and the unused `skills.principal` / `skills.projectPrincipal` messages.

This is the eighth feature implementing phase P1 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md`. The order is: roles (PR #308), membership (PR #310), enforce-core (PR #313), enforce-fleet (PR #314), enforce-assistant (PR #315), enforce-integrations (PR #316), then cleanup, split 2026-10-21 into four features: contract-tests (PR #317), **retire-checks**, fixtures-to-bindings and drop-legacy. `permissions-p1-web` runs in parallel and must land before drop-legacy. The design doc's phasing section lists five features and predates every split.

## Motivation

Every route family decides through a permission key since enforce-integrations, and the contract test proves each route declares one. Four kinds of decision still bypass the keys:
- **Project access.** `ProjectMembershipGuard` admits a user when `principal.role === 'ADMIN'` (the JWT claim), and otherwise when an access-source row exists. A custom project role cannot narrow or widen access. The same check sits in memory writes, the project and thread live streams, comments, the members list and the assistant executor.
- **Global-admin shortcuts.** Listing projects, the home dashboard, pickup on another agent's behalf, the last-admin override and assignee eligibility each read `role === 'ADMIN'` from a principal or a user row.
- **The domain writer** keeps its own role list (`ADMIN`, `DEVELOPER`, `REVIEWER`, `TRIAGER`, `AGENT`). It omits `VERIFIER`, so the `TICKET_SUGGESTED` event of a pickup by an agent whose only legacy role is `VERIFIER` is refused after the pickup itself was allowed.
- **Dead mechanisms.** The CASL factory, the project-permission decorators and their guard steps, the tool `permission` field, `assertTransitionPermission`, `canOverrideClose` and several helpers have no live caller. They still carry a parallel permission vocabulary, so a future change could revive one by accident.

The design (§3 "Removed in P1") removes all four. The catalog contract and role-matrix tests from contract-tests guard the deletion: a route left without a key, or a role whose effective keys change, fails CI.

**Rulings that bind this feature** (user, 2026-10-21):
- **Cleanup is four features**, in order: contract-tests, retire-checks, fixtures-to-bindings, drop-legacy. drop-legacy waits for `permissions-p1-web`.
- **Project access is the `project.read` key.** With the seeded roles nothing changes: every project role holds `project.read` in its project, and Owner and Admin hold it everywhere. A custom project role without `project.read` gives no access to its project.
- **Admin shortcuts map to keys:** `project.read` held globally (list every project, home scope), `agent.update` (pickup for another agent), `role.binding.global` (last-admin override), the assignee's `project.read` in the project (assignee eligibility).
- **One capability, five stories.** The plan approved as seven stories was merged to five during drafting. The workspace-stream key folds into US-002, and the two deletion stories fold into US-005 (they share files, and one had fewer than four ACs).

## Design

### Rulings that bind every story

1. **Conventions carry over** from `.nax/features/permissions-p1-enforce-core/spec.md` ("Rulings that bind every story"), unless this spec says otherwise:
   - `PermissionsModule` is `@Global()`; consumers inject `PermissionService` without `@Optional()`;
   - a refused key answers 403 `new ForbiddenAppException({}, 'permissions')`;
   - `ProjectMembershipGuard`'s 403 `projects` for a principal without access to the project is unchanged;
   - DB-backed tests that need the system roles run `SystemRoleSeeder.onApplicationBootstrap()` after `resetDb`, or boot the app;
   - effective keys are cached (`PermissionCache`), whereas the old access gate read rows live, so a DB-backed test that writes membership or binding rows directly between two requests calls `MembershipService.invalidatePermissions()` after the write, as the enforce-* suites do.
2. **Behaviour with the seeded roles is unchanged**, except:
   - the domain writer's legacy role list (US-003): a `VIEWER` or a legacy `VERIFIER`-only actor with access now writes, and an agent with no legacy role now needs `project.read` in the event's project (its only production caller, the pickup, already requires `agent.pickup` there);
   - a principal whose `role` claim disagrees with its bindings is now decided by its bindings;
   - a legacy `ProjectMember` row with a stored role outside `ADMIN`/`DEVELOPER`/`AGENT`/`VIEWER` (for example `MEMBER`) now has access, because the union reads it as `viewer`;
   - an **agent** with a global `owner` or `admin` binding (or a custom GLOBAL role holding `project.read`) now has access to every project and lists every project, exactly as a user with that binding does (design §2: Owner and Admin's `*` covers every project). Today the roster decides for every agent. `WorkspaceThreadsService.hasMembership` follows: such an agent may choose any project as a workspace thread's home;
   - `GET /threads/:id/events` refuses a caller holding neither `thread.workspace.read` nor `.own` with 403 `permissions` before the ownership fence. That includes every agent bound only to the baseline `agent` role, which today passes the fence for its own thread. This matches the workspace REST reads, which already declare the key with `RequiresGuard`;
   - `viewerRole` is unchanged for every user who had access before. It is `'ADMIN'` for any holder of a global `project.read`, including a custom GLOBAL role. A newly admitted user gets their stored legacy role (for example `'MEMBER'`) or `null` (access through a custom role only).
3. **Handler signatures stay.** `TicketsController` handlers keep their `@CurrentProject()` parameters even where they no longer read them (oxlint `no-unused-vars` is off), so positional calls in existing specs stay valid.
4. **The `role` claim on `UserPrincipal` stays.** drop-legacy derives it from bindings. This feature only stops deciding on it.
5. **`api-testing.md` endpoint e2e rule, ruled as for enforce-core:** this spec's integration ACs pin the route outcomes that change, and only existing e2e cases a correct implementation breaks are edited (see Modifies).
6. **No approval and no audit change** (P3 and P2).
7. **The project rules were updated on this branch before the run.** `.nax/rules/api-auth.md` and the Auth section of `.nax/rules/api-core.md` no longer describe the CASL factory or the legacy decorators. Follow them.

### Project access (US-001)

`apps/api/src/projects/project-access.service.ts`:

```ts
/** The key whose holding in a project is access to it (design §2 "Project access"; ruling 2026-10-21). */
export const PROJECT_ACCESS_KEY = 'project.read';

constructor(
  private projectRepo: PrismaProjectRepository,
  private readonly permissions: PermissionService,
  @Optional() @Inject(AUTH_CFG) private authConfig?: IAuthConfig,
) {}

/**
 * The access gate, and the caller's display role for the members page (`viewerRole`, read by the web until
 * permissions-p1-web). A runner is not checked (unchanged; `CombinedAuthGuard` keeps runners off project routes),
 * and an agent passes while AGENT_PROJECT_SCOPING is off (unchanged until drop-legacy).
 */
async resolveMembership(projectId: string, principal: KodaPrincipal): Promise<string | null> {
  if (principal.actorType === 'runner') return null;
  if (isAgentPrincipal(principal) && !this.agentScopingEnabled()) return null;
  const decision = await this.permissions.can(principal, PROJECT_ACCESS_KEY, { projectId });
  if (!decision.allowed) throw new ForbiddenAppException({}, 'projects');
  if (!isUserPrincipal(principal)) return null;
  if (await this.readsEveryProject(principal)) return ActorRole.ADMIN;
  return this.projectRepo.findMembershipRole(projectId, principal.id);
}

/** Whether the principal holds `project.read` globally (with the seeded roles: a global Owner or Admin). */
async readsEveryProject(principal: KodaPrincipal): Promise<boolean> {
  if (principal.actorType === 'runner') return false;
  return (await this.permissions.can(principal, PROJECT_ACCESS_KEY)).allowed;
}
```

- `assertProjectMembership` keeps delegating to `resolveMembership`, so every caller is unchanged: `ProjectMembershipGuard`, `CommentsService`, `ProjectMembersService.list`, `AssistantToolExecutor`, `WorkspaceThreadsService`, `MemoryController`, `LiveController` and `ThreadEventsGuard`.
- **Derivation, executed against the committed role matrix** (`apps/api/src/permissions/__snapshots__/role-matrix.json`, contract-tests):
  - `project.read` is `granted` globally only for `owner` and `admin`;
  - it is `granted` in `p1` for all seven PROJECT roles (and for `owner` and `admin`);
  - it is `not-granted` for `member` and `agent`.
- The legacy `User.role = 'ADMIN'` users keep access because `PermissionService` adds the `admin` role's keys for them (`isLegacyAdmin`).
- `findMembershipRole` stays: `resolveMembership` uses it for the display role, and `WorkspaceThreadsService.hasMembership` uses it as today. drop-legacy removes it.

### The remaining decisions (US-002)

| Site | Baseline (locate only) | Target |
|:--|:--|:--|
| `ProjectsService.findAllForPrincipal` | `principal.actorType === 'user' && principal.role === 'ADMIN'` → `findAll()` | `await this.access.readsEveryProject(principal)` → `findAll()`, checked first. The agent branch (roster, or every project when scoping is off) and the user branch (`findAllForUser`) are unchanged. |
| `HomeController.get` | `globalAdmin: principal.role === 'ADMIN'` | `globalAdmin: (await this.permissions.can(principal, 'project.read')).allowed`. The constructor gains `PermissionService` as its second parameter. The agent refusal is unchanged. |
| `AgentsService.suggestTicket` | `isGlobalAdmin = principal.actorType === 'user' && principal.role === 'ADMIN'` | A caller that is not the owning agent passes when `(await this.permissions.can(principal, 'agent.update')).allowed`; otherwise 403 `agents`, as today. `can` is not asked for the owning agent. |
| `TicketsService.assign`, user assignee | skip the check when `user.role === 'ADMIN'`, else 403 `tickets` when `findProjectMemberRole` is null | 403 `tickets` unless `(await this.permissions.effectiveKeys({ type: 'USER', id: user.id }, { projectId: project.id })).has('project.read')`. The not-found, disabled and agent-assignee checks are unchanged. |
| `ProjectMembersService.assertKeepsAnAdmin` | `isGlobalAdmin(principal)` (`principal.role === 'ADMIN'`) skips the last-admin count | Only when the change loses an active admin, `(await this.permissions.can(principal, 'role.binding.global')).allowed` skips the count; a change that loses no admin asks nothing. The module-level `isGlobalAdmin` is deleted. |
| `WorkspaceThreadEventsController` | `@UseGuards(WorkspaceThreadEventsGuard)`; `@Requires('thread.workspace.read', { enforcedBy: 'service' })` | `@UseGuards(RequiresGuard, WorkspaceThreadEventsGuard)` at the class level, in that order; `@Requires('thread.workspace.read')` (guard). `WorkspaceThreadEventsGuard`'s ownership fence (404 `threads.notFound`), JWT and stream-slot checks are unchanged. |

- The workspace REST reads already declare `thread.workspace.read` with `RequiresGuard`. `RequiresGuard` passes a caller holding only `thread.workspace.read.own` (reason `not-owner`), so a Member's own stream behaves as today.
- `agent.update` and `role.binding.global` are `granted` only for `owner` and `admin` in the role matrix, globally and in `p1`.

### The domain writer (US-003)

`apps/api/src/koda-domain-writer/koda-domain-writer.service.ts`:
- `KodaDomainWriter`'s fourth constructor parameter changes from `AgentAuthProvider` to `PermissionService`. The other parameters keep their positions.
- `assertActorHasEventRole` is replaced:

```ts
/** The actor must have access to the project the event belongs to: the same key project routes are gated on. */
private async assertActorInProject(actor: PrincipalRef, projectId: string): Promise<void> {
  const keys = await this.permissions.effectiveKeys(actor, { projectId });
  if (!keys.has(PROJECT_ACCESS_KEY)) throw new ForbiddenAppException({}, 'koda-domain-writer');
}
```

- The actor of each write:
  - `writeTicketEvent`: `{ type: data.actorType === 'agent' ? 'AGENT' : 'USER', id: data.actorId }`;
  - `writeAgentAction` and `writeDecisionEvent`: `{ type: 'AGENT', id: data.agentId }`.
- Each write checks the actor after `assertProjectExists` and before its transaction, as the role check did.
- `PrismaKodaDomainWriterRepository.findUserProjectRoles` is deleted.
- `KodaDomainWriterModule` drops its `AuthModule` import, which served only `AgentAuthProvider`.
- The legacy-membership compat doc already lists the domain writer as a reader of who may act in a project. The key is the same decision, so drop-legacy has nothing left to move here.

### The guard and the request without a project role (US-004)

`ProjectMembershipGuard` (`apps/api/src/projects/project-membership.guard.ts`):

Target:
```ts
constructor(
  private readonly access: ProjectAccessService,
  private readonly reflector: Reflector,
) {}

async canActivate(ctx: ExecutionContext): Promise<boolean> {
  const req = ctx.switchToHttp().getRequest<ProjectScopedRequest>();
  const slug = this.resolveSlug(ctx, req);
  if (!slug) return true;
  if (!req.user) throw new ForbiddenAppException({}, 'projects');
  const projectId = await this.access.findProjectIdBySlug(slug);
  await this.access.resolveMembership(projectId, req.user);
  req.projectContext = { project: { id: projectId, slug } };
  return true;
}
```

- `resolveSlug` (`params.slug`, else `@ProjectSlugFrom`) is unchanged.
- The guard keeps calling `resolveMembership` rather than `assertProjectMembership`, because route specs stub that method.
- Deleted:
  - `project-permission.decorator.ts` (`ProjectPermission`, `PROJECT_PERMISSION_KEY`, `ProjectPermissionMetadata`, `ProjectPermissionTuple`, `exemptAgents`);
  - `project-roles.decorator.ts` (`ProjectRoles`, `PROJECT_ROLES_KEY`);
  - the guard's `assertProjectRoles` / `assertProjectPermission` and its `KodaCaslAbilityFactory` parameter.
- `ProjectContext` (`apps/api/src/projects/project-context.ts`) becomes `{ project: { id: string; slug: string } }`, and `withProjectRole` is deleted.
- **Callers:**
  - `TicketsController` passes `principal` where it passed `withProjectRole(principal, project.role)` (eleven handlers);
  - `AssistantToolExecutor` uses the principal itself as the tool actor: the requester principal `actionScope` builds, and `caller.principal` at the two `execParsed` call sites. Its `userPrincipal()` builder no longer sets a `projectRole` property;
  - `ApprovalRoute`'s project variant becomes `{ kind: 'project'; projectId: string }`, so `ProjectFleetApprovalsController`'s `route()` and the `koda_list_approvals` tool (`fleet-tools.ts`) build it without a role.
- Doc comments that name the deleted symbols are reworded:
  - `allowed-actions.ts` (the comment above `canOverrideClose`, deleted in US-005);
  - `tickets.service.ts` (the `findByRefWithActions` doc);
  - `project-access.service.ts`.

### Dead mechanisms (US-005)

| Symbol | File(s) under `apps/api/src/` | Target |
|:--|:--|:--|
| `KodaCaslAbilityFactory`, its spec | `auth/casl/koda-casl-ability.factory.ts`, `auth/casl/koda-casl-ability.factory.spec.ts` | deleted |
| `KodaAction`, `KodaSubject` | `auth/casl/koda-action.enum.ts` | deleted |
| CASL registration | `auth/auth.module.ts` | `caslAbilityFactory` option, provider and export removed; nestjs-auth then provides its default `JwtCaslAbilityFactory` |
| CASL provider | `projects/project-access.module.ts` | `KodaCaslAbilityFactory` provider, export and comment removed |
| `UserPrincipal.projectRole` | `auth/principal/koda-principal.types.ts`, `auth/jwt-auth.provider.ts` | field removed; `JwtAuthProvider.getPrincipal` sets no `projectRole` property, and its SECURITY comments are reduced to the claim allow-list |
| `TicketTransitionsService.assertTransitionPermission`, `caslAbilityFactory` parameter | `tickets/state-machine/ticket-transitions.service.ts` | removed (the last constructor parameter, `@Optional()`) |
| `updateTicketTool` `transitions` dependency | `fleet/assistant/tools/update-ticket-tool.ts`, `fleet/assistant/tools/ticket-write-tools.ts` | `updateTicketTool({ tickets })`; `TicketWriteTools` drops its `TicketTransitionsService` parameter |
| `ToolPermission`, `AssistantTool.permission` | `fleet/assistant/assistant-tool.types.ts` and the 14 tool files under `fleet/assistant/tools/` that set `permission:` | removed; `ToolForbiddenError`'s doc names a key, not an ability |
| `canOverrideClose` | `tickets/state-machine/allowed-actions.ts` | deleted |
| `ProjectAccessService.assertProjectAdmin`, `canManageMembers` | `projects/project-access.service.ts` | deleted |
| `ProjectsService.assertProjectMembership`, `assertProjectAdmin`, `findMembershipRole` | `projects/projects.service.ts` | deleted (no caller) |
| `ITicketRepository.findProjectMemberRole` | `tickets/domain/ticket.domain.ts`, `tickets/prisma-tickets.repository.ts` | deleted (no caller after US-002) |
| `FleetActivityService.memberProjectIds`, `findMemberProjectIds` | `fleet/activity/fleet-activity.service.ts`, `fleet/activity/domain/fleet-activity.domain.ts`, `fleet/activity/prisma-fleet-activity.repository.ts` | deleted |
| `ApprovalsService`'s `activity` parameter | `fleet/approvals/approvals.service.ts` | removed (the seventh parameter, after `live`; `txManager` and the later ones move up one place) |
| `ApprovalCaller.globalAdmin` | `fleet/approvals/approvals.service.ts`, `fleet/approvals/fleet-approvals.controller.ts`, `fleet/approvals/project-fleet-approvals.controller.ts` | field removed; both controllers pass `{ id, principal }` |
| IN_PROGRESS → VERIFIED rule | `tickets/state-machine/ticket-transitions.ts` | removed from `TRANSITION_RULES` with its comment; the comments in `transition-keys.ts` and `ticket-transitions.service.ts` that name it are reworded |
| `skills.principal`, `skills.projectPrincipal` | `i18n/en/skills.json`, `i18n/zh/skills.json` | removed (no code reads them since enforce-integrations) |
| comments naming the factory | `common/enums.ts`, `ticket-links/ticket-links.module.ts` | reworded |

- `PATCH` with `status: 'VERIFIED'` on an `IN_PROGRESS` ticket still answers 400 `tickets`: `validateTransition` throws the same `ValidationAppException` for a missing rule as for a missing comment.
- The CASL-only test files are deleted (see Modifies). They test only the factory's grants.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| `PermissionService.can` rejects inside `resolveMembership` (database error) | The error propagates unchanged; no 403 is invented (US-001) |
| A user without `project.read` in the project, whatever their `role` claim, reaches a project route | 403 `projects` from `ProjectMembershipGuard`, before `RequiresGuard` (US-001) |
| A non-owning caller without `agent.update` asks `GET /agents/:slug/pickup` | 403 `agents`; no target-agent key read (US-002) |
| A user assignee without `project.read` in the project | 403 `tickets`; nothing assigned (US-002) |
| A domain-writer actor without `project.read` in the event's project | 403 `koda-domain-writer`; no event and no outbox row (US-003) |
| A caller holding neither `thread.workspace.read` nor `.own` opens `GET /threads/:id/events` | 403 `permissions` from `RequiresGuard`, before the ownership fence and before a stream slot is taken (US-002) |

### Integration

Symbols this feature **reads** (verified at `2c13a76f`):
- `PermissionService.can(principal, key, ctx?)`, `PermissionService.effectiveKeys(ref, scope)` — `apps/api/src/permissions/permission.service.ts`
- `PrincipalRef` — `apps/api/src/permissions/permissions.types.ts`
- `Requires`, `REQUIRES_METADATA`, `RequiresGuard` — `apps/api/src/permissions/requires.decorator.ts`, `requires.guard.ts`
- `WorkspaceThreadEventsGuard` — `apps/api/src/fleet/threads/workspace-thread-events.controller.ts`
- `AssistantToolRegistry.list()` — `apps/api/src/fleet/assistant/assistant-tool.registry.ts`
- `validateTransition`, `TRANSITION_RULES` — `apps/api/src/tickets/state-machine/ticket-transitions.ts`
- `CaslAbilityFactory`, `JwtCaslAbilityFactory` — `@nathapp/nestjs-auth`
- `bootHttpApp` — `apps/api/test/helpers/http-app.ts`

Symbols this feature **changes**. The baseline only locates the code; implement the target.

| Symbol | Baseline (locate only) | Target |
|:--|:--|:--|
| `ProjectAccessService` constructor | `(projectRepo, @Optional() authConfig?)` | `(projectRepo, permissions: PermissionService, @Optional() authConfig?)` |
| `ProjectAccessService.resolveMembership` | `principal.role === 'ADMIN'` → `'ADMIN'`; membership row or roster, else 403 | the US-001 code above |
| `ProjectAccessService.readsEveryProject` | absent | the US-001 code above |
| `ProjectsService.findAllForPrincipal`, `HomeController`, `AgentsService.suggestTicket`, `TicketsService.assign`, `ProjectMembersService.assertKeepsAnAdmin`, `WorkspaceThreadEventsController` | `role === 'ADMIN'` reads; service-mode workspace stream key | the US-002 table |
| `KodaDomainWriter` | `AgentAuthProvider` parameter, `assertActorHasEventRole` | `PermissionService` parameter, `assertActorInProject` |
| `ProjectMembershipGuard` | `(access, reflector, @Optional() casl?)`; reads role and permission metadata; attaches `{ project, role }` | the US-004 code above |
| `ProjectContext`, `withProjectRole`, `ApprovalRoute` | `role` field; helper present; project variant has `role` | no `role`; helper deleted; `{ kind: 'project'; projectId }` |
| The US-005 table | present | deleted or reduced as listed |

## Out of Scope

- Moving test fixtures from `ProjectMember`, `AgentProject`, `AgentRoleEntry` and `User.role` rows to role bindings is out of scope (`permissions-p1-fixtures-to-bindings`).
- Removing the legacy union and the baseline fallback in `PermissionService`, dropping the legacy tables and columns, `findMembershipRole`, `AgentPrincipal.agentRoles`, `AgentAuthProvider.loadAgentRoles`, `AGENT_PROJECT_SCOPING` and `PATCH /agents/:slug/update-roles` is out of scope (`permissions-p1-drop-legacy`).
- Rewriting the recipient selection of notifications and mentions (`notification-eligibility.ts`, `ticket-mention.resolver.ts`), which reads `User.role` of recipients rather than deciding for a caller, is out of scope (`permissions-p1-drop-legacy`).
- Replacing the members list's `viewerRole` and the web's role-based UI checks with keys is out of scope (`permissions-p1-web`); `viewerRole` keeps today's values for every user who had access.
- Moving the assignee search (`ProjectAssigneesService.search`), which still offers users by access source, onto `project.read` is out of scope (`permissions-p1-drop-legacy`); only `assign` checks the key.
- Making the home dashboard (`GET /home`) and `GET /me/events` serve agents is out of scope: both are user-only surfaces (users-only `/me/*` notifications), and their refusals stay.
- US-002 only: changing what the home dashboard shows beyond the source of its `globalAdmin` flag is out of scope.
- Changing the `role` claim in the JWT, `UsersAdminService`'s role writes and `MembershipService.isGlobalAdmin` is out of scope; this feature only stops deciding on the claim.
- The placeholder `test/integration/context/context-controller.integration.spec.ts`, which asserts on a string literal and imports nothing from the CASL files, is out of scope.
- Updating the design doc's phasing section for the four-way cleanup split is out of scope for the run; it is a manual doc edit.
- Approval policies, the audit log and `ActionContext` are out of scope (P3, P2).

## Stories

1. **US-001: Project access through `project.read`** — `Workdir: apps/api` — No dependencies. `ProjectAccessService` gains `PermissionService` and `readsEveryProject`. `resolveMembership` decides access with `can(principal, 'project.read', { projectId })` and keeps returning the display role.
2. **US-002: The remaining legacy decisions become keys** — `Workdir: apps/api` — Depends on US-001. Covers project listing, the home dashboard flag, pickup on another agent's behalf, assignee eligibility, the last-admin override and the workspace thread stream key, per the Design table.
3. **US-003: The domain writer checks project access by key** — `Workdir: apps/api` — Depends on US-001. `KodaDomainWriter` takes `PermissionService` in place of `AgentAuthProvider` and refuses an actor without `project.read` in the event's project. Deletes `findUserProjectRoles`.
4. **US-004: The guard and the request carry no project role** — `Workdir: apps/api` — Depends on US-001. `ProjectMembershipGuard` loses its role and permission steps. `ProjectContext.role`, `withProjectRole`, `ApprovalRoute.role` and the two decorator files are removed, and their callers pass the principal as it is.
5. **US-005: Retire the CASL factory and the dead legacy checks** — `Workdir: apps/api` — Depends on US-002, US-003, US-004. A deletion story: everything in the US-005 table, the CASL-only test files, and the `projectRole` field. Verification: `bun run --cwd apps/api type-check`, `bun run --cwd apps/api lint` and `bun run --cwd apps/api test` must pass with the deleted files absent. The ACs pin the runtime effects.

One capability: retiring the legacy permission checks.

### Context Files

**US-001**
- `apps/api/src/projects/project-access.service.ts` — `resolveMembership`, edited here
- `apps/api/src/permissions/permission.service.ts` — `can`, read
- `apps/api/src/projects/project-membership.guard.ts` — the gate's main caller, read
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — who holds `project.read`, read
- `apps/api/test/integration/permissions/membership-project-access.integration.spec.ts` — the access cases that must keep passing, read

**US-002**
- `apps/api/src/projects/projects.service.ts` — `findAllForPrincipal`, edited here
- `apps/api/src/home/home.controller.ts` — `get`, edited here
- `apps/api/src/agents/agents.service.ts` — `suggestTicket`, edited here
- `apps/api/src/tickets/tickets.service.ts` — `assign`, edited here
- `apps/api/src/projects/members/project-members.service.ts` — `assertKeepsAnAdmin`, edited here

Also edited: `apps/api/src/fleet/threads/workspace-thread-events.controller.ts` (the class guards and the route key).

**US-003**
- `apps/api/src/koda-domain-writer/koda-domain-writer.service.ts` — edited here
- `apps/api/src/koda-domain-writer/prisma-koda-domain-writer.repository.ts` — `findUserProjectRoles`, deleted here
- `apps/api/src/koda-domain-writer/koda-domain-writer.module.ts` — `AuthModule` import, removed here
- `apps/api/src/agents/agents.service.ts` — `recordAgentAction`, the pickup's writer call (read)
- `apps/api/src/projects/project-access.service.ts` — `PROJECT_ACCESS_KEY`, created by US-001 (read)

**US-004**
- `apps/api/src/projects/project-membership.guard.ts` — edited here
- `apps/api/src/projects/project-context.ts` — edited here
- `apps/api/src/tickets/tickets.controller.ts` — the eleven `withProjectRole` call sites, edited here
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — `actionScope`, `execParsed` call sites, `userPrincipal`, edited here
- `apps/api/src/fleet/approvals/approvals.service.ts` — `ApprovalRoute`, edited here

Also edited: `apps/api/src/fleet/approvals/project-fleet-approvals.controller.ts`, `apps/api/src/fleet/assistant/tools/fleet-tools.ts`, and the two decorator files, deleted.

**US-005**
- `apps/api/src/auth/auth.module.ts` — CASL registration, edited here
- `apps/api/src/auth/principal/koda-principal.types.ts` — `projectRole`, removed here
- `apps/api/src/tickets/state-machine/ticket-transitions.service.ts` — CASL parameter and method, removed here
- `apps/api/src/fleet/assistant/assistant-tool.types.ts` — `ToolPermission`, removed here
- `apps/api/src/tickets/state-machine/ticket-transitions.ts` — the IN_PROGRESS → VERIFIED rule, removed here

Every other file in the US-005 table is edited the same way.

### Creates

**US-001**

None.

**US-002**

None.

**US-003**

None.

**US-004**

None.

**US-005**

None. The story deletes files.

### Modifies

**US-001**
- `apps/api/src/projects/project-access.service.spec.ts` — it builds `new ProjectAccessService(mockProjectRepo)`, and its `assertProjectMembership` / `resolveMembership` cases decide through `findMembershipRole`, `isAgentOnRoster` and `role: 'ADMIN'`, for example "passes without checking membership for ADMIN user" and "returns ADMIN for a global ADMIN without a membership lookup". The replacing invariant: the service is built with a `PermissionService` double as its second argument. Access follows the double's answer for `('project.read', { projectId })`. `'ADMIN'` is returned when the double allows the global `'project.read'` ask. The member-role return still comes from `findMembershipRole`. Agents and runners keep their scoping-off and unchecked cases. The `assertProjectAdmin` / `canManageMembers` describes only get the new constructor argument here (US-005 deletes them).
- `apps/api/test/unit/projects/agent-project-access.spec.ts` — it builds `new ProjectAccessService(repo, config)`, AC4/AC5 admit or refuse through `isAgentOnRoster`, and AC8 surfaces a roster lookup error. The replacing invariant: the constructor takes a `PermissionService` double second. AC4/AC5 follow the double's `project.read` answer. AC8 surfaces a rejection of `can` unchanged. AC6 (scoping off) and AC7 (runner) still never call `can` or the roster.
- `apps/api/src/projects/projects.service.spec.ts` — it builds `new ProjectAccessService(...)` without a `PermissionService`, and "passes without checking membership for ADMIN user" relies on `role: 'ADMIN'` skipping the lookup. The replacing invariant: the access service gets a `PermissionService` double whose `can` answers per case, and the ADMIN case passes because the double allows `project.read`. The `ProjectsService` wrapper cases otherwise keep their outcomes until US-005.
- `apps/api/src/projects/project-membership.guard.spec.ts` — it builds the real `ProjectAccessService` from a repository stub, so member and non-member outcomes follow `findMembershipRole` / `isAgentOnRoster`, and the global ADMIN case expects no lookup. The replacing invariant: the access service gets a `PermissionService` double, and admit or refuse (403 `projects`) follows that double's `project.read` answer for the request's principal. The slug-resolution, 404 and `projectContext` cases are unchanged here (US-004 edits them).
- `apps/api/src/projects/project-membership.guard.routes.spec.ts` — its non-member cases (AC7, AC8, AC10, AC12 boundary, AC14 boundary) get 403 from `findMembershipRole` resolving `null`. The agent cases expect `isAgentOnRoster` to be called, and AC4 expects a global ADMIN to cause no lookup. The replacing invariant: a non-member is modelled by putting `'project.read'` in `refusedKeys`, and still gets 403. The rostered-agent and global-ADMIN cases are admitted by the stub's allowed `project.read`. The unrostered-agent case puts `'project.read'` in `refusedKeys`. Assertions on `isAgentOnRoster` / `findMembershipRole` calls become assertions that `can` was called with `'project.read'` and `{ projectId: 'proj-1' }`.
- `apps/api/src/retrieval/retrieval-membership.routes.spec.ts` — AC2's non-member gets 403 from `findMembershipRole` resolving `null`, and a case asserts `findMembershipRole` was called once with `('proj-1', 'user-project-admin')`. The replacing invariant: the non-member case refuses `'project.read'` through `refusedKeys` and still gets 403. The call assertion checks that `can` was asked `'project.read'` with `{ projectId: 'proj-1' }`. The US-007 key-refusal cases are unchanged.
- `apps/api/src/rag/kb-documents-membership.routes.spec.ts` — AC1's non-member gets 403 from `findMembershipRole` resolving `null`. The replacing invariant: the non-member case refuses `'project.read'` through `refusedKeys` and still gets 403. The VIEWER/DEVELOPER key cases are unchanged.
- `apps/api/test/unit/projects/projects-find-all-for-principal.spec.ts` — it builds `new ProjectAccessService(...)` without a `PermissionService`. The replacing invariant: the access service gets a `PermissionService` double. Every case keeps its expected rows in this story (US-002 changes the global-admin case).

**US-002**
- `apps/api/test/unit/projects/projects-find-all-for-principal.spec.ts` — AC7 and the AC9 boundary give "a global ADMIN user principal" every project through `role: 'ADMIN'`, and the repository double's `rowsForSelector` treats `role === 'ADMIN'` as cross-project. The replacing invariant: the global case is a principal for which the `PermissionService` double allows the global `'project.read'` ask, and it gets every non-deleted project. A user with `role: 'ADMIN'` whose global `project.read` is refused gets only their membership projects. The agent and member cases are unchanged.
- `apps/api/src/home/home.controller.spec.ts` — `setup()` builds `new HomeController(home)`, and the dashboard case expects `globalAdmin: false` from `role: 'MEMBER'`. The replacing invariant: the controller is built with a `PermissionService` double second, and `globalAdmin` equals that double's answer for `can(user, 'project.read')`. The agent refusal and the `home.read` declaration are unchanged.
- `apps/api/src/agents/agents-pickup.routes.spec.ts` — AC10 expects 403 for `agentPrincipal('other-agent')`, and AC11 expects 403 for `userPrincipal('MEMBER')`, while the `PermissionService` double's `can` allows every key. AC12 expects 200 for `userPrincipal('ADMIN')`. The replacing invariant: AC10's and AC11's double refuses `'agent.update'` (403 `agents`, no ticket read). AC12's double allows `'agent.update'` (200). The US-009 target-key cases are unchanged.
- `apps/api/test/integration/memory/outbox-envelope.integration.spec.ts` — it builds `TicketsService` positionally with a `PermissionService` double holding only `can`, and its assign case (`ticketsService.assign('h13-project', 'HKK-2', { userId: adminUserId }, principal)`) now reaches `effectiveKeys`. The replacing invariant: the double also has `effectiveKeys` resolving a set holding `'project.read'`, and every envelope assertion is unchanged.
- `apps/api/src/tickets/tickets.service.spec.ts` — the assign cases decide user-assignee eligibility through `findProjectMemberRole` and `role: 'ADMIN'`. Examples: "should return 403 when the assigned user is not a project member (BUG-2)", "should skip the membership check for ADMIN assignees (BUG-17)", and the cases asserting `findProjectMemberRole` was or was not called. `mockPermissions` has only `can`. The replacing invariant: `mockPermissions` also has `effectiveKeys`. A user assignee is eligible exactly when it resolves a set holding `'project.read'` for `({ type: 'USER', id }, { projectId })`. The BUG-17 case becomes "an assignee whose keys hold project.read is assigned without a membership read". BUG-2 becomes "an assignee whose keys lack project.read gets 403 tickets". Agent-assignee cases are unchanged.
- `apps/api/src/projects/members/project-members.service.spec.ts` — "a project admin cannot demote or remove the last project ADMIN" expects the count, and so 409 `members.lastAdmin`, for a principal with `role` other than `ADMIN`, while the `permissions` double allows every key. The replacing invariant: that case's double refuses `'role.binding.global'`, and the count and the 409 happen as before. "a global ADMIN may remove the last project ADMIN" passes because the double allows `'role.binding.global'`.
- `apps/api/src/permissions/remaining-route-declarations.spec.ts` — its table pins `[WorkspaceThreadEventsController, 'events', ['thread.workspace.read'], 'all', 'service']`. The replacing invariant: that row's mode is `'guard'`; every other row is unchanged.

**US-003**
- `apps/api/src/koda-domain-writer/koda-domain-writer.service.spec.ts` — its module provides an `AgentAuthProvider` double with `loadAgentRoles` and no `PermissionService`. The replacing invariant: the module provides a `PermissionService` double whose `effectiveKeys` resolves a set holding `'project.read'`. The project-not-found, validation and envelope cases keep their outcomes.
- `apps/api/test/unit/koda-domain-writer/koda-domain-writer-role-provenance.spec.ts` — its AC12-AC14 cases refuse or allow by legacy roles. Examples: "throws ForbiddenAppException for a non-ADMIN user actor with no ProjectMember row", "still loads agent roles through AgentAuthProvider for agent actors", and the `findUserProjectRoles` contract describe. The replacing invariant: the writer is decided by the `PermissionService` double's `effectiveKeys` for the actor ref in the event's project. A user actor with `project.read` writes, whatever its payload role. A user actor without it is refused 403 `koda-domain-writer` and writes no event. Agent actors are checked with `{ type: 'AGENT', id }`. The repository contract describe is deleted with `findUserProjectRoles`.
- `apps/api/test/unit/koda-domain-writer/find-user-project-roles.spec.ts` — it tests only `PrismaKodaDomainWriterRepository.findUserProjectRoles`, which this story deletes. The replacing invariant: the file is deleted.
- `apps/api/test/integration/events/event-write-operations.integration.spec.ts` — its module provides `AgentAuthProvider` and no `PermissionService`. "should allow actors with admin role" / "developer role" seed legacy rows, and "should deny actors without admin, developer, or agent role" expects 403 for a `MEMBER` user. The replacing invariant: the module provides a `PermissionService` double. The allow cases resolve a set holding `'project.read'`. The deny case resolves a set without it and still expects `ForbiddenAppException` and no event row. The project-not-found cases are unchanged.
- `apps/api/test/integration/koda-domain-writer/koda-domain-writer.integration.spec.ts` — its module provides an `AgentAuthProvider` double and no `PermissionService`. The replacing invariant: it provides a `PermissionService` double whose `effectiveKeys` resolves a set holding `'project.read'`, and every case keeps its outcome.
- `apps/api/test/integration/outbox/producer-atomicity.integration.spec.ts` — its `PermissionService` double has only `can`, and `writer.writeAgentAction` now calls `effectiveKeys`. The replacing invariant: the double also has `effectiveKeys` resolving a set holding `'project.read'`. Both `writeAgentAction` cases keep their commit and rollback outcomes.
- `apps/api/test/integration/permissions/membership-ticket-consumers.integration.spec.ts` — "AC-9: the writer refuses a user whose only source is a viewer binding and records no event" expects 403. The replacing invariant (ruling: the writer gates on project access): that user's `writeTicketEvent` records the event. A new refusal case uses a user with no source in the project, expecting 403 `koda-domain-writer` and no event. AC-8 is unchanged.

**US-004**
- `apps/api/src/projects/project-membership.guard.spec.ts` — its test controllers use `@ProjectRoles(...)` and `@ProjectPermission([...], { exemptAgents })` with `KodaAction`, and it builds guards with `new KodaCaslAbilityFactory()` as a third argument. Its `projectContext` assertions include `role`. The replacing invariant: the role-gate, permission-gate and CASL describes are deleted. The guard is built with `(access, reflector)`. `request.projectContext` equals `{ project: { id, slug } }` exactly. The slug-resolution, 404, missing-principal and access cases keep their outcomes.
- `apps/api/src/projects/project-context.spec.ts` — it tests only `withProjectRole`, which this story deletes. The replacing invariant: the file is deleted.
- `apps/api/src/tickets/tickets.controller.spec.ts` — it imports `withProjectRole` and `PROJECT_PERMISSION_KEY`. It expects `service.assign` and `transitions.start` to be called with `withProjectRole(user, 'ADMIN')` (lines 526, 640, 649), and lines 329, 591, 664 and 694 expect services to be called with `{ ...mockMemberUser, projectRole: <'DEVELOPER' or 'ADMIN'> }`. Its `projectContext` fixtures carry `role`. The replacing invariant: the handlers are called with the principal itself (`mockMemberUser` / `mockAdminUser`, no `projectRole`). The `PROJECT_PERMISSION_KEY` absence assertion and both imports are removed. The `REQUIRES_METADATA` assertions are unchanged.
- `apps/api/src/comments/comments.controller.spec.ts` — it imports `PROJECT_PERMISSION_KEY` from the deleted file to assert the key's absence. The replacing invariant: that import and assertion are removed, and the `REQUIRES_METADATA` assertions are unchanged.
- `apps/api/src/projects/projects.controller.spec.ts` — it imports `PROJECT_PERMISSION_KEY` from the deleted file to assert the key's absence, and its `projectContext` fixtures carry `role`. The replacing invariant: that import and assertion are removed, the fixtures drop `role`, and the `REQUIRES_METADATA` assertions are unchanged.
- `apps/api/src/projects/assignees/project-assignees.controller.spec.ts` — it imports `PROJECT_PERMISSION_KEY` from the deleted file to assert the key's absence. The replacing invariant: that import and assertion are removed, and the `REQUIRES_METADATA` assertions are unchanged.
- `apps/api/src/labels/labels.controller.spec.ts` — it imports `PROJECT_PERMISSION_KEY` from the deleted file to assert the key's absence. The replacing invariant: that import and assertion are removed, and the `REQUIRES_METADATA` assertions are unchanged.
- `apps/api/src/ticket-links/ticket-links.controller.spec.ts` — it imports `PROJECT_PERMISSION_KEY` from the deleted file to assert the key's absence. The replacing invariant: that import and assertion are removed, and the `REQUIRES_METADATA` assertions are unchanged.
- `apps/api/src/fleet/repo-config/project-job-config-edit.controller.spec.ts` — it imports `PROJECT_PERMISSION_KEY` from the deleted file to assert the key's absence. The replacing invariant: that import and assertion are removed, and the `REQUIRES_METADATA` assertions are unchanged.
- `apps/api/src/fleet/repo-config/project-repo-config.controller.spec.ts` — it imports `PROJECT_PERMISSION_KEY` from the deleted file to assert the key's absence. The replacing invariant: that import and assertion are removed, and the `REQUIRES_METADATA` assertions are unchanged.
- `apps/api/src/notifications/ticket-watch.controller.spec.ts` — it imports `PROJECT_PERMISSION_KEY` from the deleted file to assert the key's absence. The replacing invariant: that import and assertion are removed, and the `REQUIRES_METADATA` assertions are unchanged.
- `apps/api/test/integration/ast-index/code-intel-controller-permissions.integration.spec.ts` — it imports `PROJECT_PERMISSION_KEY` from the deleted file to assert the key's absence on two handlers. The replacing invariant: that import and those assertions are removed, and its `REQUIRES_METADATA` assertions are unchanged.
- `apps/api/src/fleet/assistant/tools/fleet-tools.spec.ts` — it expects `approvals.list` to be called with `{ kind: 'project', projectId: 'project-1', role: 'DEVELOPER' }`. The replacing invariant: the route is exactly `{ kind: 'project', projectId: 'project-1' }`.
- `apps/api/src/fleet/assistant/tools/origin-tools.spec.ts` — it expects `approvals.list` to be called with routes carrying `role: null` and `role: 'DEVELOPER'`. The replacing invariant: both routes are exactly `{ kind: 'project', projectId: 'p1' }`.
- `apps/api/src/fleet/assistant/assistant-tool.executor.spec.ts` — lines 234, 463 and 530 expect the tool context actor and the `can` principal to carry `projectRole: 'DEVELOPER'`. The replacing invariant: they are the caller principal with no `projectRole` property (the expectations drop `projectRole`). Every refusal and key-check outcome is unchanged.
- `apps/api/src/fleet/assistant/assistant-tool.executor.workspace.spec.ts` — line 165 expects `seen.actor.projectRole` to be `'VIEWER'`, line 214 expects `can` to be called with an actor carrying `projectRole: 'VIEWER'`, and line 253 matches `actor: { id: 'u1', projectRole: undefined }`. The replacing invariant: the actor has no `projectRole` property, `can` is called with the caller principal, and line 253 matches `actor: { id: 'u1' }`.
- `apps/api/src/fleet/assistant/assistant-tool.executor.actor.spec.ts` — line 141 expects the approved action's actor to carry `projectRole: 'DEVELOPER'`. The replacing invariant: the actor is the requester principal with no `projectRole` property.

**US-005**
- `apps/api/src/auth/casl/koda-casl-ability.factory.spec.ts` — it tests only the deleted factory. The replacing invariant: the file is deleted.
- `apps/api/test/unit/auth/koda-casl-ability.factory.spec.ts` — it tests only the deleted factory's `ProjectContext` grants. The replacing invariant: the file is deleted.
- `apps/api/test/integration/ast-index/ast-index-casl-permissions.integration.spec.ts` — it tests only the deleted factory's AstIndex grants. The replacing invariant: the file is deleted.
- `apps/api/test/integration/code-intel/codeintel-casl-permissions.integration.spec.ts` — it tests only the deleted factory's CodeIntel grants. The replacing invariant: the file is deleted.
- `apps/api/test/integration/rag/import-graphify-permission.integration.spec.ts` — it tests only the deleted factory and `KodaAction.IMPORT`. The replacing invariant: the file is deleted, since the route's key is pinned by the catalog contract test.
- `apps/api/src/webhook/webhook-routes.spec.ts` — it imports `KodaCaslAbilityFactory` and lists it as a provider. The replacing invariant: the import and provider entry are removed, and every case keeps its outcome.
- `apps/api/src/tickets/state-machine/ticket-transitions.service.spec.ts` — it imports `KodaCaslAbilityFactory`, lists it as a provider, and its describe "assertTransitionPermission (legacy CASL check, still used by the assistant tool)" tests the deleted method. The replacing invariant: the import, the provider entry and that describe are removed, and every other case keeps its outcome.
- `apps/api/src/projects/project-membership.guard.routes.spec.ts` — it imports `KodaCaslAbilityFactory` and lists it as a provider. The replacing invariant: the import and provider entry are removed, and every case keeps its outcome.
- `apps/api/test/integration/outbox/producer-atomicity.integration.spec.ts` — it imports `KodaCaslAbilityFactory` and lists it as a provider. The replacing invariant: the import and provider entry are removed, and every case keeps its outcome.
- `apps/api/test/integration/tickets/ticket-tenancy.integration.spec.ts` — it imports `KodaCaslAbilityFactory` and lists it as a provider. The replacing invariant: the import and provider entry are removed, and every case keeps its outcome.
- `apps/api/src/auth/jwt-auth.provider.spec.ts` — its SECURITY cases assert `principal.projectRole` is `undefined` for a forged or garbage `projectRole` claim. The replacing invariant: the principal has no own `projectRole` property for those claims, and the claim allow-list cases are unchanged.
- `apps/api/src/tickets/state-machine/allowed-actions.spec.ts` — it imports `canOverrideClose` and its describe tests it. The replacing invariant: the import and describe are removed, and the `allowedActions` cases are unchanged.
- `apps/api/src/tickets/state-machine/ticket-transitions.spec.ts` — "allows IN_PROGRESS → VERIFIED with GENERAL comment (sent back)" and "accepts GENERAL for IN_PROGRESS → VERIFIED" expect no throw. The replacing invariant: both expect `validateTransition` to throw `ValidationAppException`. The two IN_PROGRESS → VERIFIED throw cases still throw.
- `apps/api/src/fleet/assistant/tools/update-ticket-tool.spec.ts` — `toolDeps()` builds `updateTicketTool({ tickets, transitions })`, a case asserts `assertTransitionPermission` is not called, and line 152 asserts `tool.permission` equals `{ kind: 'ability', ... }`. The replacing invariant: the tool is built with `{ tickets }`, that case and the `permission` assertion are removed, the `key` assertion stands, and every other case keeps its outcome.
- `apps/api/src/fleet/assistant/tools/link-tickets-tool.spec.ts` — line 149 asserts `tool.permission` equals `{ kind: 'member' }`. The replacing invariant: the `permission` assertion is removed and the tool's `key` assertion stands (added if absent, with the key the tool file declares).
- `apps/api/src/fleet/assistant/tools/requeue-job-tool.spec.ts` — line 143 asserts `tool.permission` equals a `{ kind: 'ability', ... }` value. The replacing invariant: the `permission` assertion is removed and the tool's `key` assertion stands (added if absent, with the key the tool file declares).
- `apps/api/src/fleet/assistant/tools/action-tools.spec.ts` — lines 105 and 174 assert `tool.permission` values. The replacing invariant: both `permission` assertions are removed and the tools' `key` assertions stand (added if absent, with the keys the tool file declares).
- `apps/api/src/fleet/assistant/tools/create-tickets-tool.spec.ts` — line 122 asserts `tool.permission` equals a `{ kind: 'ability', ... }` value. The replacing invariant: the `permission` assertion is removed and the tool's `key` assertion stands (added if absent, with the key the tool file declares).
- `apps/api/src/fleet/assistant/tools/add-memory-tool.spec.ts` — line 149 asserts `tool.permission` equals `{ kind: 'member' }`. The replacing invariant: the `permission` assertion is removed and the tool's `key` assertion stands (added if absent, with the key the tool file declares).
- `apps/api/src/fleet/assistant/tools/knowledge-tools.spec.ts` — lines 110 and 124 assert the registered tools' `permission` equals `{ kind: 'member' }`. The replacing invariant: both `permission` assertions are removed and the tools' `key` assertions stand (added if absent, with the keys the tool file declares).
- `apps/api/src/fleet/assistant/tools/record-decision-tool.spec.ts` — line 143 asserts `tool.permission` equals `{ kind: 'member' }`. The replacing invariant: the `permission` assertion is removed and the tool's `key` assertion stands (added if absent, with the key the tool file declares).
- `apps/api/src/fleet/assistant/tools/dispatch-job-tool.spec.ts` — line 203 asserts `tool.permission` equals a `{ kind: 'ability', ... }` value. The replacing invariant: the `permission` assertion is removed and the tool's `key` assertion stands (added if absent, with the key the tool file declares).
- `apps/api/src/fleet/assistant/tools/cancel-job-tool.spec.ts` — line 139 asserts `tool.permission` equals a `{ kind: 'ability', ... }` value. The replacing invariant: the `permission` assertion is removed and the tool's `key` assertion stands (added if absent, with the key the tool file declares).
- `apps/api/src/fleet/assistant/tools/kb-tools.spec.ts` — line 561 asserts the registered `koda_kb_search` and `koda_get_doc` tools' `permission` values. The replacing invariant: the `permission` assertion is removed and the tools' `key` assertions stand (added if absent, with the keys the tool file declares).
- `apps/api/src/fleet/assistant/tools/fleet-tools.spec.ts` — line 108 asserts the registered fleet tools' `permission` values. The replacing invariant: the `permission` assertion is removed and the tools' `key` assertions stand (added if absent, with the keys the tool file declares).
- `apps/api/src/fleet/assistant/assistant.module.spec.ts` — it asserts `tool?.permission` equals a `{ kind: ... }` value for ten tools. The replacing invariant: those assertions are removed, and the tools' `key` assertions (added if absent, with the key each tool file declares) stand in their place.
- `apps/api/src/fleet/approvals/approvals.service.spec.ts` — it builds `new ApprovalsService(...)` positionally with an `activity` double (`memberProjectIds`) as the seventh argument (after `live`). The replacing invariant: the constructor calls drop that argument and the later ones move up one place, and every case keeps its outcome.
- `apps/api/src/fleet/activity/prisma-fleet-activity.repository.spec.ts` — its describe "PrismaFleetActivityRepository — findMemberProjectIds (US-004)" tests the deleted method. The replacing invariant: that describe is removed, and the other cases are unchanged.
- `apps/api/src/projects/project-access.service.spec.ts` — its `assertProjectAdmin` and `canManageMembers` describes test deleted methods. The replacing invariant: both describes are removed, and the US-001 cases are unchanged.
- `apps/api/src/projects/projects.service.spec.ts` — its cases for `ProjectsService.assertProjectMembership`, `assertProjectAdmin` and `findMembershipRole` test deleted wrappers. The replacing invariant: those cases are removed, and the other cases are unchanged.

### Seams

- **US-001 → US-002:** `ProjectAccessService.readsEveryProject` is consumed by `ProjectsService.findAllForPrincipal`. US-002 AC 1 stubs it and observes `findAll`; AC 15 reaches it from `GET /projects` in the booted app.
- **US-001 → US-003:** `PROJECT_ACCESS_KEY` is the key `KodaDomainWriter` checks. US-003 AC 2 observes `effectiveKeys` asked for the actor, and AC 3 the refusal when the returned set lacks `'project.read'`.
- **US-001 → every gate caller:** the guard, memory, live and thread-event callers reach the new gate through the unchanged `resolveMembership`. US-001 AC 11 observes it from `GET /projects/p1/tickets`.
- **US-004 → US-005:** US-004 removes the guard's CASL parameter and `withProjectRole`, so US-005 can delete the factory with no live importer left. US-005 AC 4 observes the default factory in the booted app.

## Acceptance Criteria

Fixture wording:
- "A user whose only source in `p1` is a `<role>` binding" means a user with that `RoleBinding` in project `p1`, no `ProjectMember` row, and `User.role = 'MEMBER'`.
- "A global admin" is a user with a global `admin` binding.
- "A custom PROJECT role with `[...]`" is a `Role` row with scope `PROJECT`, `system: false` and those permission entries.
- Unit cases use a `PermissionService` double whose answers each AC states.
- DB-backed tests seed the system roles first (ruling 1).

### US-001: Project access through `project.read` (`Workdir: apps/api`)

1. [unit] `ProjectAccessService.resolveMembership('p1', user)` for a user principal with `role: 'MEMBER'`, with `can` allowing `('project.read', { projectId: 'p1' })`, refusing the global `'project.read'` ask, and `findMembershipRole` resolving `'DEVELOPER'`, returns `'DEVELOPER'`.
2. [unit] `resolveMembership('p1', user)` for a user principal with `role: 'MEMBER'`, with `can` allowing both the project and the global `'project.read'` asks, returns `'ADMIN'`.
3. [unit] `resolveMembership('p1', user)` for a user principal with `role: 'ADMIN'`, with `can` refusing `('project.read', { projectId: 'p1' })`, rejects with `ForbiddenAppException` with code `projects`.
4. [unit] `resolveMembership('p1', agent)` for an agent principal with scoping on, whose repository stub's `isAgentOnRoster` resolves `false`, resolves `null` when `can` allows `('project.read', { projectId: 'p1' })`.
5. [unit] `resolveMembership('p1', agent)` for an agent principal with scoping on, whose repository stub's `isAgentOnRoster` resolves `true`, rejects with `ForbiddenAppException` with code `projects` when `can` refuses `('project.read', { projectId: 'p1' })`.
6. [unit] `resolveMembership('p1', agent)` for an agent principal, when the service's auth config sets `agentProjectScoping: false`, resolves `null` with a `can` double that throws when called.
7. [unit] `resolveMembership('p1', runner)` for a runner principal resolves `null` with a `can` double that throws when called.
8. [unit] `resolveMembership('p1', user)` when `can` rejects with an `Error('db down')` rejects with that same error.
9. [unit] `ProjectAccessService.readsEveryProject(user)` returns `true` when `can` allows exactly the two arguments `(user, 'project.read')`, and `false` when it refuses them.
10. [unit] `readsEveryProject(runner)` returns `false` with a `can` double that throws when called.
11. [integration] A user whose only source in `p1` is a binding to a custom PROJECT role with `['ticket.read']` gets 403 with error code `projects` from `GET /projects/p1/tickets`.
12. [integration] A global admin with no source in `p1` gets `viewerRole` `'ADMIN'` in the 200 response of `GET /projects/p1/members`.
13. [integration] A user whose only source in `p1` is a `viewer` binding gets `viewerRole` `'VIEWER'` in the 200 response of `GET /projects/p1/members`.

### US-002: The remaining legacy decisions become keys (`Workdir: apps/api`)

1. [unit] `ProjectsService.findAllForPrincipal` for a user principal with `role: 'MEMBER'`, when `ProjectAccessService.readsEveryProject` resolves `true`, returns the rows of `projectRepo.findAll()`.
2. [unit] `findAllForPrincipal` for a user principal with `role: 'ADMIN'`, when `readsEveryProject` resolves `false`, returns the rows of `findAllForUser(principal.id)`.
3. [unit] `findAllForPrincipal` for an agent principal with scoping on, when `readsEveryProject` resolves `true`, returns the rows of `projectRepo.findAll()`.
4. [unit] `HomeController.get` for a user principal with `role: 'MEMBER'`, when `can(user, 'project.read')` allows, calls `home.snapshot` with `{ id: user.id, globalAdmin: true }`.
5. [unit] `HomeController.get` for a user principal with `role: 'ADMIN'`, when `can(user, 'project.read')` refuses, calls `home.snapshot` with `{ id: user.id, globalAdmin: false }`.
6. [unit] `AgentsService.suggestTicket('bot', 'koda', user)` for a user principal with `role: 'MEMBER'`, when `can(user, 'agent.update')` allows and the target agent's effective keys hold `agent.pickup`, returns a suggestion.
7. [unit] `suggestTicket('bot', 'koda', user)` for a user principal with `role: 'ADMIN'`, when `can(user, 'agent.update')` refuses, rejects with `ForbiddenAppException` with code `agents`.
8. [unit] `suggestTicket('bot', 'koda', other)` for an agent principal whose slug is `other`, when `can(other, 'agent.update')` refuses, rejects with `ForbiddenAppException` with code `agents`.
9. [unit] `suggestTicket('bot', 'koda', bot)` for the agent principal whose slug is `bot`, with a `can` double that throws when called, returns a suggestion.
10. [unit] `TicketsService.assign('koda', 'KODA-1', { userId: 'u2' })` for an enabled user `u2` with `role: 'ADMIN'`, whose `effectiveKeys({ type: 'USER', id: 'u2' }, { projectId })` lacks `project.read`, rejects with `ForbiddenAppException` with code `tickets`.
11. [unit] `TicketsService.assign` for an enabled user `u2` with `role: 'MEMBER'`, whose effective keys hold `project.read`, calls `assignTicket` with `assignedToUserId: 'u2'`.
12. [unit] `ProjectMembersService.remove('proj', 'pa', caller)` of the only active project ADMIN by a caller with `role: 'MEMBER'`, when `can(caller, 'role.binding.global')` allows, deletes the member.
13. [unit] `ProjectMembersService.remove('proj', 'pa', caller)` of the only active project ADMIN by a caller with `role: 'ADMIN'`, when `can(caller, 'role.binding.global')` refuses and `countProjectAdmins` resolves 1, rejects with `ConflictAppException` with code `members.lastAdmin`.
14. [unit] On a Nest testing app serving `WorkspaceThreadEventsController` with a `PermissionService` double that refuses `thread.workspace.read` (reason `not-granted`), `GET /threads/t1/events` answers 403 with error code `permissions`, and the `WorkspaceThreadsService` double's `requireOwnedThread` is not called.
15. [integration] In the booted app, `GET /projects` by a user who has a `member` binding and a binding to a custom GLOBAL role with `['project.read']`, and no project source, lists every non-deleted project.

### US-003: The domain writer checks project access by key (`Workdir: apps/api`)

1. [unit] `KodaDomainWriter.writeTicketEvent` for a `user` actor, with `effectiveKeys` resolving a set holding `project.read`, calls `ticketEventService.create` once.
2. [unit] `writeTicketEvent` for a `user` actor `u1` in project `p1` calls `effectiveKeys` with exactly `({ type: 'USER', id: 'u1' }, { projectId: 'p1' })`.
3. [unit] `writeTicketEvent` for a `user` actor, with `effectiveKeys` resolving a set without `project.read`, rejects with `ForbiddenAppException` with code `koda-domain-writer` and does not call `ticketEventService.create`.
4. [unit] `writeTicketEvent` with `actorType` `'agent'` and `actorId` `a1` calls `effectiveKeys` with `({ type: 'AGENT', id: 'a1' }, { projectId })`.
5. [unit] `writeAgentAction` for agent `a1` in project `p1` calls `effectiveKeys` with `({ type: 'AGENT', id: 'a1' }, { projectId: 'p1' })` and, with `project.read` in the set, calls `agentEventService.create` once.
6. [unit] `writeAgentAction`, with `effectiveKeys` resolving a set without `project.read`, rejects with `ForbiddenAppException` with code `koda-domain-writer` and does not call `agentEventService.create`.
7. [unit] `writeDecisionEvent`, with `effectiveKeys` resolving a set without `project.read`, rejects with `ForbiddenAppException` with code `koda-domain-writer` and does not call `decisionEventService.create`.
8. [unit] `writeTicketEvent` for a project id that names no project rejects with `ForbiddenAppException` with code `koda-domain-writer` and does not call `effectiveKeys`.
9. [integration] In the booted app, `KodaDomainWriter.writeTicketEvent` for a user whose only source in `p1` is a `viewer` binding stores one `TicketEvent` row.
10. [integration] In the booted app, `writeTicketEvent` for a user with no source in `p1` rejects with `ForbiddenAppException` with code `koda-domain-writer`, and no `TicketEvent` row exists for it.
11. [integration] In the booted app, an agent whose only legacy role is an `AgentRoleEntry` `VERIFIER`, on `p1`'s `AgentProject` roster, gets 200 from `GET /agents/<its slug>/pickup?project=p1` with its own API key while `p1` has a VERIFIED unassigned ticket, and an `AgentEvent` with action `TICKET_SUGGESTED` exists for it.

### US-004: The guard and the request carry no project role (`Workdir: apps/api`)

1. [unit] `ProjectMembershipGuard.canActivate` for a member's request on a route with `params.slug` `'alpha'` sets `request.projectContext` to exactly `{ project: { id: 'proj-1', slug: 'alpha' } }`.
2. [unit] `ProjectMembershipGuard.canActivate` for a user principal with `role: 'MEMBER'` for which `resolveMembership` resolves `'VIEWER'`, on a handler carrying metadata `'koda:projectRoles'` = `['ADMIN']` set with `SetMetadata`, resolves `true`.
3. [unit] `ProjectMembershipGuard.canActivate` on a handler with no slug source and metadata `'koda:projectPermission'` set with `SetMetadata`, resolves `true` without calling `findProjectIdBySlug`.
4. [unit] `ProjectMembershipGuard.canActivate` for a principal that `resolveMembership` refuses with `ForbiddenAppException` code `projects` rejects with that exception, and `request.projectContext` stays unset.
5. [unit] `TicketsController.start('koda', 'KODA-1', principal, ctx)` calls `transitionsService.start` with `('koda', 'KODA-1', principal)`, where the third argument is the same object as the principal passed in.
6. [unit] `TicketsController.assign` calls `ticketsService.assign` with the received principal object itself as the last argument.
7. [unit] `ProjectFleetApprovalsController.list` with `ctx.project.id` `'p1'` calls `approvals.list` with a route equal to exactly `{ kind: 'project', projectId: 'p1' }`.
8. [unit] The `koda_list_approvals` tool's `execute` for a user actor in project `project-1` calls `approvals.list` with a route equal to exactly `{ kind: 'project', projectId: 'project-1' }`.
9. [unit] `AssistantToolExecutor` running a project tool for a user caller that `resolveMembership` admits passes the tool a `ToolContext` whose `actor` has no `projectRole` property.
10. [unit] `AssistantToolExecutor` approving a stored action passes the tool an `actor` that has no `projectRole` property.

### US-005: Retire the CASL factory and the dead legacy checks (`Workdir: apps/api`)

The deletions are verified by `bun run --cwd apps/api type-check`, `bun run --cwd apps/api lint` and `bun run --cwd apps/api test`. The ACs pin the runtime effects.

1. [unit] `validateTransition(TicketStatus.IN_PROGRESS, TicketStatus.VERIFIED, CommentType.GENERAL)` throws `ValidationAppException`.
2. [unit] The keys of `TRANSITION_RULES[TicketStatus.IN_PROGRESS]` equal exactly `[TicketStatus.VERIFY_FIX]`.
3. [unit] `JwtAuthProvider.getPrincipal` for a JWT payload `{ sub, email, role: 'MEMBER', tokenVersion: 0, projectRole: 'ADMIN' }` returns a principal equal to the one it returns for the same payload without `projectRole`.
4. [integration] In the app booted by `bootHttpApp`, `app.get(CaslAbilityFactory, { strict: false })` from `@nathapp/nestjs-auth` is an instance of `JwtCaslAbilityFactory`.
5. [integration] In the booted app, `PATCH /projects/p1/tickets/<ref>` with `{ status: 'VERIFIED' }` on an `IN_PROGRESS` ticket by a global admin answers 400 with error code `tickets`, and the ticket stays `IN_PROGRESS`.
