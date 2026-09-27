# SPEC: Track 3 Slice 1 — Tenancy & principals

## Summary

Make project membership a consistent visibility gate on every project-scoped API route, close the agent
mass-assignment and duplicate-slug defects, and fix the project/auth LOWs from the 2026-09-25 whole-repo
review. All work is in `apps/api`. Permissions stay on the principal's global role; agents stay
cross-project.

## Motivation

The 2026-09-25 review (`docs/20260925-review-whole-repo.md`) found membership enforced on links, VCS,
memory, context and code-intel but not on tickets, comments, labels or the project list (M7). Since #139
created real `ProjectMember` rows, a non-member DEVELOPER can still read and write every ticket in every
project. Agent creation spreads the request body into Prisma (M8) and a duplicate slug returns 500. Six
LOWs in the same modules remain open. This is slice 1 of Track 3
(`docs/superpowers/specs/2026-09-27-track-3-review-remediation-design.md`).

## Design

Partial extension of existing `apps/api` modules. No new package. Monorepo: every story has
`Workdir: apps/api`.

### Integration

Read-only symbols (verified at `c5a955af`):

- `ProjectAccessService.findProjectIdBySlug(slug): Promise<string>` — throws `NotFoundAppException` for an
  unknown or soft-deleted project (`projects/project-access.service.ts`).
- `ProjectAccessService.assertProjectMembership(projectId, principal): Promise<void>` — returns for agents
  and global ADMIN users; throws `ForbiddenAppException` for a user with no `ProjectMember` row.
- `ProjectAccessModule` (`projects/project-access.module.ts`) exports `ProjectAccessService`.
- `@Principal()` from `@nathapp/nestjs-auth` reads `request.user`; the global `CombinedAuthGuard` is
  registered in `main.ts` before route guards run.
- `ConflictAppException` (`common/exceptions/conflict-app.exception.ts`) — the 409 exception.
- Test harness: PG-backed supertest integration specs gated by `KODA_DB_TESTS=1`
  (pattern: `test/integration/live/live-stream.integration.spec.ts`).

Mutated symbols. The baseline exists only to locate the code; implement the target.

- `TicketsController.assign` (`tickets/tickets.controller.ts`)
  - Baseline: calls `projectsService.findProjectIdBySlug` + `assertProjectMembership` inline.
  - Target: the inline calls are removed; the class-level `ProjectMembershipGuard` covers the route.
- `RagController` (`rag/rag.controller.ts`)
  - Baseline: private `checkProjectMembership` reimplements the membership rule; `allowedRoles` for writes
    includes `'VIEWER'`.
  - Target: `ProjectMembershipGuard` on the controller; the write routes (`POST documents`,
    `DELETE documents/:sourceId`, `POST import/graphify`, `POST optimize`) carry
    `@ProjectRoles('ADMIN', 'DEVELOPER', 'AGENT')`, so a project VIEWER is refused; the private method is
    deleted (US-005).
- `ProjectsService.findAll()` → `findAllForPrincipal(principal: KodaPrincipal): Promise<ProjectDomain[]>`
  - Baseline: `findAll()` returns every non-deleted project.
  - Target: agents and global ADMIN users get every non-deleted project; other users get only projects
    where they have a `ProjectMember` row.
- `CommentsService.update(commentId, dto, principal)` / `delete(commentId, principal)`
  - Baseline: CASL check only, no project resolution.
  - Target: resolve comment → ticket → project first; a user who is not a member of that project gets
    `NotFoundAppException` (404) before any CASL check.
- `AgentsService` create path (`agents/agents.service.ts`, the `else` branch that spreads `...scalarFields`)
  - Target: builds the create data from `name`, `slug`, `maxConcurrentTickets` only; writes the agent row,
    roles and capabilities inside one `txManager.run`. The constructor gains
    `@Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager` (the pattern used by
    `comments.service.ts`).
- `PrismaAgentRepository.createRolesAndCapabilities` — Target: sequential `createMany` calls on the
  ambient transaction client (no nested `$transaction([...])`).
- `AgentsController.suggestTicket` (`GET agents/:slug/pickup`) gains a `@Principal() principal: KodaPrincipal`
  parameter and passes it through.
- `AgentsService.suggestTicket(agentSlug, projectSlug)` → `suggestTicket(agentSlug, projectSlug, principal)`
  - Target: 403 unless the principal is that agent or a global ADMIN user; 404 when the project is missing
    or soft-deleted.
- `ProjectsService.create` / `update` — Target: duplicate slug or key → `ConflictAppException` (409);
  `update` on a soft-deleted project → `NotFoundAppException`.
- `envSchema` (`config/env.validation.ts`) — Target: validation fails when `JWT_REFRESH_SECRET` equals
  `JWT_SECRET`.
- `KodaDomainWriter.writeTicketEvent` (`koda-domain-writer/koda-domain-writer.service.ts`)
  - Baseline: for user actors, `projectRoles` comes from `data.data.actorRole` / `data.data.role`.
  - Target: for user actors, `projectRoles` is the actor's `ProjectMember.role` for `data.projectId`
    (plus `'ADMIN'` when the user's global role is ADMIN); payload role fields are ignored. The data comes
    from a new `PrismaKodaDomainWriterRepository.findUserProjectRoles(projectId, userId): Promise<string[]>`
    (reads `User.role` and `ProjectMember.role`); `WriteTicketEventInput` is unchanged.

### New code

`ProjectMembershipGuard` (`projects/project-membership.guard.ts`), provided and exported by
`ProjectAccessModule`:

```ts
// projects/project-roles.decorator.ts
export const PROJECT_ROLES_KEY = 'koda:projectRoles';
export const ProjectRoles = (...roles: string[]) => SetMetadata(PROJECT_ROLES_KEY, roles);

// projects/project-membership.guard.ts
@Injectable()
export class ProjectMembershipGuard implements CanActivate {
  constructor(private readonly access: ProjectAccessService, private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const slug = req.params?.slug;
    if (!slug) return true; // routes without :slug are gated elsewhere
    const projectId = await this.access.findProjectIdBySlug(slug); // 404
    await this.access.assertProjectMembership(projectId, req.user); // 403
    const roles = this.reflector.getAllAndOverride<string[]>(PROJECT_ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (roles?.length && isUserPrincipal(req.user) && req.user.role !== 'ADMIN') {
      const role = await this.access.findMembershipRole(projectId, req.user.id);
      if (!role || !roles.includes(role)) throw new ForbiddenAppException({}, 'projects'); // 403
    }
    return true;
  }
}
```

`ProjectAccessService.findMembershipRole(projectId, userId): Promise<string | null>` is new (a thin
wrapper over the existing `PrismaProjectRepository.findMembershipRole`). Agents and global ADMIN users skip
the role check. `@ProjectRoles` is used only on the KB write routes in this slice.

Applied with `@UseGuards(ProjectMembershipGuard)`:

| Target | Level |
|:--|:--|
| `TicketsController` (`projects/:slug/tickets`) | class |
| `LabelsController` routes under `projects/:slug/...` | method |
| `CommentsController` `projects/:slug/tickets/:ref/comments` (POST, GET) | method |
| `RagController` (`projects/:slug/kb`) | class |
| `RetrievalController` (`projects/:slug/kb/evaluate/retrieval`) | class (applied in US-005 with the private copy's removal) |
| `ProjectsController` `GET :slug`, `PATCH :slug/agents/:agentSlug` | method |

Not changed: routes already gated (links, vcs, memory, timeline, context, retrieval, code-intel, live,
members, `GET :slug/codeintel/impact`, `GET :slug/agents`), and ADMIN-permission routes
(`ci-webhook-token`, `PATCH :slug`, `DELETE :slug`, `projects/:slug/webhooks*`).

### Failure Handling

| Condition | Result |
|:--|:--|
| Unknown or soft-deleted `:slug` on a guarded route | 404 |
| User without membership on a guarded route | 403 |
| User without membership on `PATCH/DELETE comments/:id` | 404 |
| Duplicate agent slug on create | 409 |
| Duplicate project slug or key on create/update | 409 |
| Role/capability write fails during agent create | whole create rolls back; no agent row |
| `JWT_REFRESH_SECRET === JWT_SECRET` at boot | env validation throws; app does not start |

## Out of Scope

- Project-role-based permissions: write permissions stay on the principal's global role and `ProjectMember.role` gates visibility only (Track 3 ruling 2026-09-27), with one exception ruled 2026-09-27: KB write routes refuse a project VIEWER via `@ProjectRoles`. Tickets, comments and labels do not use `@ProjectRoles`.
- Agent project membership: agent principals remain cross-project and bypass the membership gate (revisited in fleet S1).
- Hiding project existence from authenticated non-members: an unknown slug returns 404 while a non-member gets 403, matching the modules already gated.
- The webhook, ticket-workflow, VCS, RAG and web/CLI findings of Track 3 slices 2-6.
- US-003 only: the agent `update()` path, which already whitelists its fields.

## Stories

### US-001 — Membership guard on ticket, label, comment, KB and project routes

Workdir: `apps/api`. Depends on: none.

Adds `ProjectMembershipGuard` and `@ProjectRoles`, applies the guard to every ungated `:slug` route in the
table above, removes the inline check in `TicketsController.assign`, and refuses a project VIEWER on the KB
write routes.

### US-002 — Slug-less comment routes and the project list

Workdir: `apps/api`. Depends on: US-001.

Gates `PATCH/DELETE comments/:id` by resolving the owning project, replaces `ProjectsService.findAll` with
`findAllForPrincipal`, and adds the route-matrix integration spec that exercises every guarded route as a
non-member and as a member.

### US-003 — Agent create hardening

Workdir: `apps/api`. Depends on: none.

Whitelists create fields, validates the slug, maps a duplicate slug to 409, makes create atomic, and
restricts `pickup`.

### US-004 — Project LOWs

Workdir: `apps/api`. Depends on: none.

409 on duplicate project slug/key, 404 on updating a soft-deleted project, and the three missing i18n keys.

### US-006 — Auth secret and domain-writer role hardening

Workdir: `apps/api`. Depends on: none.

The JWT secret refinement and `KodaDomainWriter` role derivation.

### US-005 — Remove duplicated membership and agent DTO code

Workdir: `apps/api`. Depends on: US-001, US-003.

Deletion-only: delete `RagController.checkProjectMembership`, `RetrievalController.checkProjectMembership`
(both private copies of the membership rule, replaced by `ProjectMembershipGuard` on those controllers),
the now-unused `PrismaRagRepository.findProjectMembership`, and
delete the service-local `CreateAgentDto` / `UpdateAgentDto` classes in `agents/agents.service.ts` so every
caller imports `agents/dto/*`.

Verification: build/static gate `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint`.

### Context Files

**US-001**
- `apps/api/src/projects/project-access.service.ts`
- `apps/api/src/projects/project-access.module.ts`
- `apps/api/src/tickets/tickets.controller.ts`
- `apps/api/src/rag/rag.controller.ts`
- `apps/api/src/labels/labels.controller.ts`

**US-002**
- `apps/api/src/comments/comments.service.ts`
- `apps/api/src/projects/projects.service.ts`
- `apps/api/src/projects/prisma-project.repository.ts`
- `apps/api/test/integration/live/live-stream.integration.spec.ts`
- `apps/api/src/projects/project-membership.guard.ts` — created by US-001, read here

**US-003**
- `apps/api/src/agents/agents.service.ts`
- `apps/api/src/agents/prisma-agent.repository.ts`
- `apps/api/src/agents/agents.controller.ts`
- `apps/api/src/agents/dto/create-agent.dto.ts`

**US-004**
- `apps/api/src/projects/projects.service.ts`
- `apps/api/src/projects/dto/create-project.dto.ts`
- `apps/api/src/i18n/en/projects.json`
- `apps/api/src/i18n/en/common.json`

**US-006**
- `apps/api/src/config/env.validation.ts`
- `apps/api/src/koda-domain-writer/koda-domain-writer.service.ts`
- `apps/api/src/koda-domain-writer/prisma-koda-domain-writer.repository.ts`

**US-005**
- `apps/api/src/rag/rag.controller.ts`
- `apps/api/src/retrieval/retrieval.controller.ts`
- `apps/api/src/rag/prisma-rag.repository.ts`
- `apps/api/src/agents/agents.service.ts`

### Creates

**US-001**
- `apps/api/src/projects/project-membership.guard.ts`
- `apps/api/src/projects/project-membership.guard.spec.ts`
- `apps/api/src/projects/project-roles.decorator.ts`

**US-002**
- `apps/api/test/integration/projects/project-membership-gate.integration.spec.ts`

**US-003**
- `apps/api/src/agents/prisma-agent.repository.spec.ts`

### Modifies

**US-001**
- `apps/api/src/tickets/tickets.controller.spec.ts` — assertions that `assign` calls `projectsService.assertProjectMembership` inline are replaced by the invariant that the membership check runs in `ProjectMembershipGuard` before the handler.
- `apps/api/src/rag/rag.controller.spec.ts` — tests that stub `checkProjectMembership` / `ragRepository.findProjectMembership` for `addDocument` and `search` are rewritten for the guard: the controller no longer performs the membership check itself, and new tests cover the VIEWER write rule.
- `apps/api/src/comments/comments.module.ts` — imports `ProjectAccessModule` so the guard resolves.
- `apps/api/src/labels/labels.module.ts` — imports `ProjectAccessModule` so the guard resolves.
- `apps/api/src/rag/rag.module.ts` — imports `ProjectAccessModule` so the guard resolves.

**US-002**
- `apps/api/src/projects/projects.controller.spec.ts` — assertions that the project list route calls `projectsService.findAll()` with no arguments are replaced by the invariant that it calls `findAllForPrincipal(principal)`.
- `apps/api/src/comments/comments.service.spec.ts` — assertions that `update`/`delete` go straight to the CASL check are replaced by the invariant that project membership is resolved first and a non-member gets 404.

**US-003**
- `apps/api/src/agents/agents.service.spec.ts` — assertions that `agentRepo.create` receives the spread body are replaced by the invariant that it receives only `name`, `slug`, `apiKeyHash`, `maxConcurrentTickets`.

**US-004**
- `apps/api/src/projects/projects.service.spec.ts` — assertions that a duplicate slug or key throws `ValidationAppException` are replaced by the invariant that it throws `ConflictAppException` (409).

**US-006**
- `apps/api/src/koda-domain-writer/koda-domain-writer.service.spec.ts` — assertions that a user actor's role is read from `data.actorRole` are replaced by the invariant that it is read from `ProjectMember`.

**US-005**
- `apps/api/src/rag/rag.controller.spec.ts` — tests of the private `checkProjectMembership` are deleted; guard behaviour is covered by US-001.
- `apps/api/src/retrieval/retrieval.controller.spec.ts` — tests of the private `checkProjectMembership` are deleted; the invariant becomes that a non-member user gets 403 from `ProjectMembershipGuard`.

### Seams

- US-002's integration spec exercises the guard created by US-001 through real HTTP routes (entry point:
  `GET /api/projects/:slug/tickets` and the other routes in the matrix).
- No other story consumes a symbol created by another story.

## Acceptance Criteria

### US-001

1. [unit] `ProjectMembershipGuard.canActivate` with a request whose `params.slug` names a project the user principal is a member of returns `true`.
2. [unit] `ProjectMembershipGuard.canActivate` with a user principal that has no `ProjectMember` row for the project throws `ForbiddenAppException`.
3. [unit] `ProjectMembershipGuard.canActivate` with an agent principal returns `true` without a membership lookup.
4. [unit] `ProjectMembershipGuard.canActivate` with a global ADMIN user principal that has no membership row returns `true`.
5. [unit] `ProjectMembershipGuard.canActivate` with a `params.slug` naming a soft-deleted project throws `NotFoundAppException`.
6. [unit] `ProjectMembershipGuard.canActivate` with no `params.slug` returns `true` without calling `ProjectAccessService`.
7. [integration] `GET /api/projects/:slug/tickets` by a DEVELOPER user who is not a member returns 403.
8. [integration] `POST /api/projects/:slug/tickets/:ref/assign` by a non-member DEVELOPER returns 403.
9. [integration] `POST /api/projects/:slug/kb/documents` by a member whose project role is VIEWER returns 403.
10. [integration] `POST /api/projects/:slug/kb/documents` by a member whose project role is DEVELOPER returns a 2xx status.
11. [integration] `POST /api/projects/:slug/kb/search` by a member whose project role is VIEWER returns 200.
12. [unit] `ProjectMembershipGuard.canActivate` on a handler carrying `@ProjectRoles('ADMIN', 'DEVELOPER', 'AGENT')` returns `true` for an agent principal and for a global ADMIN user without calling `ProjectAccessService.findMembershipRole`.

### US-002

1. [unit] `CommentsService.update` for a comment whose ticket belongs to a project the user principal is not a member of throws `NotFoundAppException` and does not call the comment repository's `update`.
2. [unit] `CommentsService.delete` for a comment in a project the user principal is not a member of throws `NotFoundAppException`.
3. [unit] `CommentsService.update` by an agent principal skips the membership resolution and proceeds to the CASL check.
4. [integration] `PATCH /api/comments/:id` by the comment's author after their project membership is removed returns 404.
5. [integration] `DELETE /api/comments/:id` by a global ADMIN who is not a member returns 204.
6. [unit] `ProjectsService.findAllForPrincipal` for a user principal with memberships in projects A and B, and a third project C existing, returns exactly A and B.
7. [unit] `ProjectsService.findAllForPrincipal` for a global ADMIN user principal returns every non-deleted project.
8. [unit] `ProjectsService.findAllForPrincipal` for an agent principal returns every non-deleted project.
9. [unit] `ProjectsService.findAllForPrincipal` never returns a soft-deleted project, even for a member of it.
10. [integration] `GET /api/projects` by a DEVELOPER who is a member of one of two projects returns exactly that one project.
11. [integration] For every route in the route matrix (tickets list/create/get/patch/delete, each ticket transition, assign, comments list/create, labels list/create/update/delete, ticket-label assign/remove, KB documents list/add, KB search, KB graphify import, `GET /projects/:slug`, `PATCH /projects/:slug/agents/:agentSlug`), a non-member DEVELOPER receives 403.
12. [integration] For the same route matrix, the same request by a member DEVELOPER receives a status other than 403 and 404.

### US-003

1. [unit] `AgentsService` create with a body containing `status: 'OFFLINE'` and `id: 'x'` calls `PrismaAgentRepository.create` with an object whose keys are exactly `name`, `slug`, `apiKeyHash`, `maxConcurrentTickets`.
2. [integration] `POST /api/agents` with a body containing `status: 'OFFLINE'` creates an agent whose persisted status is the schema default, not `OFFLINE`.
3. [unit] `CreateAgentDto` validation rejects a `slug` of `Bad Slug!` and accepts `good-slug-1`.
4. [integration] `POST /api/agents` with a slug that already exists returns 409.
5. [unit] When `PrismaAgentRepository.createRolesAndCapabilities` rejects during create, `AgentsService` create rejects with that error and both `PrismaAgentRepository.create` and `createRolesAndCapabilities` were called inside the same `txManager.run` callback.
6. [integration] When `PrismaAgentRepository.createRolesAndCapabilities` is made to reject during `POST /api/agents`, no agent row with the requested slug exists afterwards.
7. [unit] `PrismaAgentRepository.createRolesAndCapabilities` issues one `agentRoleEntry.createMany` and one `agentCapabilityEntry.createMany` on the ambient client and does not call `$transaction`.
8. [integration] `GET /api/agents/:slug/pickup?project=<slug>` authenticated as that agent returns 200.
9. [integration] `GET /api/agents/:slug/pickup?project=<slug>` authenticated as a different agent returns 403.
10. [integration] `GET /api/agents/:slug/pickup?project=<slug>` by a non-ADMIN user returns 403, and by a global ADMIN user returns 200.
11. [integration] `GET /api/agents/:slug/pickup?project=<slug>` for a soft-deleted project returns 404.

### US-004

1. [integration] `POST /api/projects` with a slug that already exists returns 409.
2. [integration] `POST /api/projects` with a key that already exists returns 409.
3. [integration] `PATCH /api/projects/:slug` for a soft-deleted project returns 404.
4. [unit] Translating `projects.slugInvalid`, `projects.keyInvalid` and `common.validation.isIn` in both `en` and `zh` returns a string different from the key itself.
5. [integration] `PATCH /api/projects/:slug` with a slug or key already used by another project returns 409.

### US-006

1. [unit] Validating an env object where `JWT_REFRESH_SECRET` equals `JWT_SECRET` throws a validation error naming `JWT_REFRESH_SECRET`.
2. [unit] Validating an env object with distinct `JWT_SECRET` and `JWT_REFRESH_SECRET` passes.
3. [unit] `KodaDomainWriter.writeTicketEvent` for a user actor whose payload carries `actorRole: 'ADMIN'` but who has no `ProjectMember` row and a non-ADMIN global role throws `ForbiddenAppException`.
4. [unit] `KodaDomainWriter.writeTicketEvent` for a user actor with `ProjectMember.role` `DEVELOPER` and no payload role succeeds.
5. [unit] `KodaDomainWriter.writeTicketEvent` for a user actor whose global role is ADMIN and who has no membership row succeeds.

### US-005

1. [integration] `POST /api/projects/:slug/kb/documents` by a non-member DEVELOPER still returns 403 after `RagController.checkProjectMembership` is deleted.
2. [integration] `POST /api/projects/:slug/kb/evaluate/retrieval` by a non-member DEVELOPER returns 403 with `ProjectMembershipGuard` applied to `RetrievalController`.
3. [integration] `POST /api/agents` with a valid body still returns 201 after the service-local DTO classes are deleted.
