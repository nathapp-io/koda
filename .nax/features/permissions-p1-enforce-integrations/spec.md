# SPEC: Permissions P1f — Enforce Permission Keys on the Integration Routes

## Summary

This feature moves authorization on the remaining integration routes of `apps/api` onto permission keys checked by `PermissionService.can`, using the `@Requires(key)` decorator and `RequiresGuard` that `permissions-p1-enforce-core` built:
- **Code-intel.** The five `/code-intel` routes and `GET /projects/:slug/codeintel/impact` lose `@RequiredPermission([MANAGE, 'AstIndex'])` (index) and `@ProjectPermission([READ, 'CodeIntel'])` (the reads and impact). `codeintel.read` and `codeintel.index.write` are re-scoped from `global` to `project`, because every code-intel route acts inside one project. `POST /code-intel/index` resolves its project from the body through a new `@ProjectSlugFrom('body', 'projectSlug')`.
- **Context.** `GET /context/:slug` and `POST /context/:slug/query` lose `@RequiredPermission([READ, 'ProjectContext'])` and their in-controller membership check.
- **VCS.** The nine `/projects/:slug/vcs` routes lose `@RequiredPermission('ADMIN')` and `@ProjectRoles('ADMIN')`, their `assertProjectMembership` calls and the rotate route's user-only refusal.
- **Webhooks.** The five webhook routes lose `@RequiredPermission('ADMIN')`.
- **Skills.** The four `/admin/skills/sources` routes lose `@RequiredPermission('ADMIN')`, and `SkillsService.createSource` loses its user-only refusal; the three `/projects/:slug/skills` routes lose `assertUser`, `assertProjectMembership` and `assertProjectAdmin`.
- **Intake.** The HMAC-authenticated `POST /projects/:slug/ci-webhook` and `POST /projects/:slug/vcs-webhook` declare `ci.webhook.ingest` and `vcs.webhook.ingest`, which become public keys.

This is the sixth of eight features implementing phase P1 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md`. The order is: roles (PR #308), membership (PR #310), enforce-core (PR #313), enforce-fleet (PR #314), enforce-assistant (PR #315), **enforce-integrations**, cleanup, and web in parallel. The design doc's phasing section lists five features and predates three splits; enforce-core's scoping (2026-10-19) moved these six route families into this feature.

## Motivation

After enforce-assistant, these route families are the last REST surface still deciding through the legacy mechanisms: `@RequiredPermission('ADMIN')` (global ADMIN only, even on project routes), `@ProjectPermission` over the CASL factory, `@ProjectRoles('ADMIN')`, in-controller `assertProjectMembership` / `assertProjectAdmin`, and hard-coded user-only refusals. So today:
- a **Project Admin cannot manage their own project's webhooks or VCS connection**, or sync issues; only a global ADMIN can, because `@RequiredPermission('ADMIN')` ignores the project role;
- a **Developer-role agent can index code in any project it can reach** through the CASL `MANAGE AstIndex` grant, while a Developer user cannot;
- an **agent can never list or enable a project's skills, register a skill source, or rotate a VCS webhook secret**, whatever role an admin gives it, because the controllers refuse non-user principals outright.

`permissions-p1-cleanup` deletes the legacy decorators, CASL factory and helpers, so every route has to be on keys first. This feature makes the seeded roles real on these routes: a principal can do exactly what its keys allow.

**Rulings that bind this feature** (user, 2026-10-21):
- **The intake routes declare public keys.** `ci.webhook.ingest` and `vcs.webhook.ingest` join `PUBLIC_KEYS`. The routes keep `@Public()` and their HMAC signature check; a public key needs no principal, like the token-gated `invite.accept`.
- **Who may act is role data, not code.** The user-only refusals on `POST /projects/:slug/vcs/webhook-secret/rotate`, the three project-skills routes and `SkillsService.createSource` are removed. An agent rotates a secret or enables a skill only if an admin bound it to a role holding the key. Whether an agent's high-risk write must wait for approval is approval policy, delivered in P3; this feature adds no approval step.
- **Seeded roles stay as Appendix A.** In particular `context.query` is held only by Project Admin and Developer, so a Viewer keeps `GET /context/:slug` but loses `POST /context/:slug/query`. An admin who wants otherwise edits the Viewer role.

## Design

### Rulings that bind every story

1. **Conventions carry over** from `.nax/features/permissions-p1-enforce-core/spec.md` ("Rulings that bind every story"), unless this spec says otherwise: `PermissionsModule` is `@Global()`; `RequiresGuard` needs no provider entry; a refused key answers 403 `new ForbiddenAppException({}, 'permissions')` with message `permissions.403` (already in `apps/api/src/i18n/{en,zh}/permissions.json`); DB-backed tests that need the system roles run `SystemRoleSeeder.onApplicationBootstrap()` after `resetDb`, or boot the app.
2. **Order of checks on every migrated route:**
   1. authentication (the global guards; skipped by `@Public()`);
   2. project resolution and access (`ProjectMembershipGuard`: 404 `projects` for a missing project, 403 `projects` for a principal with no access);
   3. the route key (`RequiresGuard`: 403 `permissions`);
   4. input validation (the global `ValidationPipe`, then any handler-level parse);
   5. lookups and domain rules in the handler and services (404s, 409s, the HMAC 401s).

   The first failing step decides the response.
3. **Guard placement.** A route with a project key has `@UseGuards(ProjectMembershipGuard, RequiresGuard)` in one call, both at the method level or both at the class level; never class-level `RequiresGuard` with method-level `ProjectMembershipGuard`. A global route (no project) has `@UseGuards(RequiresGuard)` only. A public route keeps `@Public()` and adds `@UseGuards(RequiresGuard)`, the pattern in `apps/api/src/auth/auth.controller.ts`.
4. **Key refusals only change.** The 403 `permissions` replaces what the legacy key checks answered (Nest's generic 403 from `@RequiredPermission`, 403 `projects` from `@ProjectRoles`, `@ProjectPermission` and the rotate route's user-only refusal, 403 `skills.principal` and `skills.projectPrincipal`, 403 `context`, and the 403 from `ProjectAccessService.assertProjectMembership`). Unchanged: `ProjectMembershipGuard`'s 404 and 403 `projects`, the handlers' 404s and 409s, the VCS 400 for a missing encryption key, and the intake routes' 401s.
5. **Handlers keep their lookups.** A handler that loads its project through `ProjectsService.findBySlug`, `WebhookService.getProjectBySlug` or `ProjectAccessService.findProjectIdBySlug` may keep that lookup or switch to `@CurrentProject()`; both resolve the same project after the guard. What is removed is every membership, admin or principal-type check the guards now cover.
6. **No approval and no audit change.** A permitted request runs immediately (P3). No actor context or audit entry is recorded (P2).
7. **`api-testing.md` endpoint e2e rule, ruled as for enforce-core.** Route-level allow and refuse cases are pinned by this spec's integration ACs (each migrated route family has at least one allow and one 403 `permissions` case); only existing e2e cases a correct implementation breaks are edited (see Modifies).

### Catalog changes

All in `apps/api/src/permissions/catalog.ts` and the `catalog_scope` column of `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv`, whose rows `catalog.spec.ts` re-reads:

| Key | Baseline | Target | Effect on the seeded roles (by `expandEntries`) |
|:--|:--|:--|:--|
| `codeintel.read` | inventory `global` (4 rows) | `project` (all 4 rows) | Held by every project role through `*.read`, and by Developer through `codeintel.*`. Today: global ADMIN only through the catalog; project ADMIN, DEVELOPER and every rostered agent through CASL. |
| `codeintel.index.write` | inventory `global` (1 row) | `project` | Held by Project Admin and Developer. Today: global ADMIN and DEVELOPER-role agents. |
| `ci.webhook.ingest` | inventory `project`; role key | inventory `public`; added to `PUBLIC_KEYS` | Public: access `public`, scope `any`, in no role. Project Admin's `*` no longer reaches it (a public key is not role-grantable). |
| `vcs.webhook.ingest` | inventory `project`; role key | inventory `public`; added to `PUBLIC_KEYS` | Same as `ci.webhook.ingest`. |

The catalog stays at 226 keys; the public key count goes from 7 to 9. Every other key in this feature is used as it is:

| Key | Scope | Held by (seeded roles; global Owner and Admin hold every key) |
|:--|:--|:--|
| `codeintel.impact.read`, `context.read`, `skill.project.read`, `vcs.connection.read`, `webhook.read` | project | every project role (`*.read`) |
| `context.query` | project | Project Admin, Developer |
| `skill.project.enable`, `skill.project.disable`, `vcs.connection.create`, `.update`, `.delete`, `.test`, `vcs.webhook-secret.rotate`, `vcs.sync.issue`, `vcs.sync.all`, `vcs.sync.pr`, `webhook.create`, `webhook.update` | project | Project Admin |
| `webhook.delete` | any | Project Admin in its project; Owner and Admin globally |
| `skill.source.read`, `.create`, `.update`, `.delete` | global | Owner, Admin |

`vcs.connection.read` and `webhook.read` reaching Viewer exposes no secret: `VcsConnectionResponseDto` carries `webhookSecretConfigured: boolean`, never the token or secret, and `PrismaWebhookRepository.findByProject` selects `id`, `projectId`, `url`, `events` and `createdAt` only.

### `@ProjectSlugFrom('body', key)`

`apps/api/src/projects/project-slug-from.decorator.ts`:

Baseline (locate only):
```ts
export interface ProjectSlugSource { source: 'query'; key: string; }
export const ProjectSlugFrom = (source: 'query', key: string) => SetMetadata(...);
```

Target:
```ts
export interface ProjectSlugSource { source: 'query' | 'body'; key: string; }
export const ProjectSlugFrom = (source: 'query' | 'body', key: string) =>
  SetMetadata<string, ProjectSlugSource>(PROJECT_SLUG_FROM_KEY, { source, key });
```

`ProjectMembershipGuard.resolveSlug` reads `req.params.slug` first, as today. Otherwise, for `source: 'query'` it reads `req.query[key]` (unchanged) and for `source: 'body'` it reads `req.body[key]` when `req.body` is an object. Either way a value that is not a non-empty string is no slug. Fastify parses the JSON body before guards run, so `req.body` is available.

### Route keys

`G` = `RequiresGuard` checks the key. Every project route has `ProjectMembershipGuard` before `RequiresGuard`.

| Route | Key | Guards | Replaces |
|:--|:--|:--|:--|
| `POST /code-intel/index` | `codeintel.index.write` | project (slug from body `projectSlug`) | `@RequiredPermission([MANAGE, 'AstIndex'])` + controller `checkProjectMembership` |
| `GET /code-intel/symbols`, `…/symbols/:symbolId`, `…/:symbolId/callers`, `…/:symbolId/callees` | `codeintel.read` | project (slug from query `projectSlug`, unchanged) | `@ProjectPermission([READ, 'CodeIntel'])` |
| `GET /projects/:slug/codeintel/impact` | `codeintel.impact.read` | project | `@ProjectPermission([READ, 'CodeIntel'])` |
| `GET /context/:slug` | `context.read` | project | `@RequiredPermission([READ, 'ProjectContext'])` + controller `checkProjectMembership` |
| `POST /context/:slug/query` | `context.query` | project | same |
| `POST /projects/:slug/vcs` | `vcs.connection.create` | project | `@RequiredPermission('ADMIN')` + `assertProjectMembership` |
| `GET /projects/:slug/vcs` | `vcs.connection.read` | project | same |
| `PATCH /projects/:slug/vcs` | `vcs.connection.update` | project | same |
| `DELETE /projects/:slug/vcs` | `vcs.connection.delete` | project | same |
| `POST /projects/:slug/vcs/test` | `vcs.connection.test` | project | same |
| `POST /projects/:slug/vcs/webhook-secret/rotate` | `vcs.webhook-secret.rotate` | project | `@ProjectRoles('ADMIN')` + `isUserPrincipal` refusal |
| `POST /projects/:slug/vcs/sync/:issueNumber` | `vcs.sync.issue` | project | `@RequiredPermission('ADMIN')` + `assertProjectMembership` |
| `POST /projects/:slug/vcs/sync` | `vcs.sync.all` | project | same |
| `POST /projects/:slug/vcs/sync-pr` | `vcs.sync.pr` | project | same |
| `POST /projects/:slug/vcs-webhook` | `vcs.webhook.ingest` | public (`@Public()` kept) | none (HMAC in controller, unchanged) |
| `POST /projects/:slug/webhooks` | `webhook.create` | project | `@RequiredPermission('ADMIN')` |
| `GET /projects/:slug/webhooks` | `webhook.read` | project | same |
| `PATCH /projects/:slug/webhooks/:id` | `webhook.update` | project | same |
| `DELETE /projects/:slug/webhooks/:id` | `webhook.delete` | project | same |
| `DELETE /webhooks/:id` | `webhook.delete` | global (`RequiresGuard` only, no project) | same |
| `POST /projects/:slug/ci-webhook` | `ci.webhook.ingest` | public (`@Public()` kept) | none (HMAC in controller, unchanged) |
| `GET /admin/skills/sources`, `POST`, `POST …/:id/update`, `DELETE …/:id` | `skill.source.read`, `.create`, `.update`, `.delete` | global | `@RequiredPermission('ADMIN')`; `POST` also `SkillsService.createSource`'s `actorType !== 'user'` refusal |
| `GET /projects/:slug/skills` | `skill.project.read` | project | `assertUser` + `assertProjectMembership` |
| `PUT /projects/:slug/skills/:skillId` | `skill.project.enable` | project | `assertUser` + `assertProjectAdmin` |
| `DELETE /projects/:slug/skills/:skillId` | `skill.project.disable` | project | same |

**Notes:**
- `DELETE /webhooks/:id` resolves no project, so `RequiresGuard` asks `can` with no `projectId` for the `any`-scope `webhook.delete`; only a principal holding it globally (Owner, Admin, a legacy global ADMIN) passes. A Project Admin uses the project-scoped route.
- `POST /code-intel/index` and the four symbol reads with no `projectSlug` resolve no project: `ProjectMembershipGuard` passes, and `RequiresGuard` refuses the project key with 403 `permissions` (fail closed) before validation.
- `PUT /projects/:slug/skills/:skillId` records the caller's id in `ProjectSkill.enabledById`, a plain nullable string with no foreign key, so an agent caller's id is stored as is. `POST /admin/skills/sources` records it in `SkillSource.createdById` the same way.
- The class `ProjectSkillsController` keeps its class-level guard and becomes `@UseGuards(ProjectMembershipGuard, RequiresGuard)`. `VcsController` gains class-level `@UseGuards(ProjectMembershipGuard, RequiresGuard)`, and the rotate route's method-level `@UseGuards(ProjectMembershipGuard)` is removed (ruling 3).
- **Target handler signatures** (parameters not listed are unchanged): `CodeIntelController.indexCommit(@Body() dto, @CurrentProject() ctx)`; `ContextController.getContext(@Query() queryDto, @Principal() principal, @CurrentProject() ctx)` and `queryContext(@Body() body, @Principal() principal, @CurrentProject() ctx)`; `VcsController.rotateWebhookSecret(@CurrentProject() ctx)`. A VCS or webhook handler whose `@Principal()` parameter becomes unused once `assertProjectMembership` is removed drops it, and the unit specs that call it directly drop that argument too.
- **Module wiring.** `ProjectMembershipGuard` is provided by `ProjectAccessModule`. `WebhookModule` (`apps/api/src/webhook/webhook.module.ts`) gains `ProjectAccessModule` in its imports; `VcsModule` already reaches it through `ProjectsModule`, and `CodeIntelModule`, `ContextModule` and `SkillsModule` already import it.
- Constructors drop a dependency only when the removed checks were its last use: `CodeIntelController` and `ContextController` drop `ProjectAccessService` when they switch to `@CurrentProject()`; `ProjectSkillsController` drops `ProjectAccessService`. `VcsController` keeps `ProjectsService` (`findBySlug` still loads the full project, whose `key` the sync routes need).
- `openapi.json` is regenerated with `bun run api:export-spec` in the last story. Rewording the `@ApiResponse` 403 descriptions of the migrated routes (today "Global admin required", "admin role", "Project admin required") to name the key is optional: no AC tests the wording.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| A route key the caller does not hold | 403 `permissions`; the handler does not run and nothing is written |
| A principal with no access to the project (non-member user, agent with no source in the project) | 403 `projects` from `ProjectMembershipGuard`, unchanged |
| A missing or soft-deleted project slug | 404 `projects` from `ProjectMembershipGuard`, unchanged |
| A code-intel route with no `projectSlug` (query or body) | 403 `permissions` (project key with no resolved project, fail closed) |
| `DELETE /webhooks/:id` by a principal holding `webhook.delete` only in projects | 403 `permissions` |
| An intake route (`ci-webhook`, `vcs-webhook`) called with no principal | `RequiresGuard` allows the public key; the HMAC check decides (401 on a bad or missing signature, unchanged) |
| An agent bound to a role holding the key (for example Project Admin rotating a VCS secret or enabling a skill) | Allowed, like a user with the same role |

### Integration

Symbols this feature **reads** (verified at `f64cc813`):
- `Requires`, `REQUIRES_METADATA`, `RequiresMetadata` — `apps/api/src/permissions/requires.decorator.ts`
- `RequiresGuard` (public keys pass with no principal; project keys need `request.projectContext`) — `apps/api/src/permissions/requires.guard.ts`
- `PermissionService.can(principal, key, { projectId? })` — `apps/api/src/permissions/permission.service.ts`
- `findCatalogEntry`, `PERMISSION_CATALOG` — `apps/api/src/permissions/catalog.ts`
- `expandEntries` — `apps/api/src/permissions/entry-matcher.ts`
- `SYSTEM_ROLES`, `SystemRoleSeeder` — `apps/api/src/permissions/system-roles.ts`, `system-role.seeder.ts`
- `ProjectMembershipGuard`, `ProjectContext` (`project: { id, slug }`), `@CurrentProject()` — `apps/api/src/projects/`
- `Public` — `@nathapp/nestjs-auth`

Symbols this feature **changes**. The baseline only locates the code; implement the target.

| Symbol | Baseline (locate only) | Target |
|:--|:--|:--|
| `PUBLIC_KEYS` (catalog) | 7 keys | plus `ci.webhook.ingest`, `vcs.webhook.ingest` |
| `INVENTORY_SCOPE_ROWS` (catalog) and the inventory TSV | `codeintel.read`, `codeintel.index.write` `global`; `ci.webhook.ingest`, `vcs.webhook.ingest` `project` | first two `project`; last two `public` |
| `ProjectSlugSource`, `ProjectSlugFrom` | `source: 'query'` | `source: 'query' \| 'body'` |
| `ProjectScopedRequest` (`apps/api/src/projects/project-context.ts`) | `params?`, `query?`, `user?`, `projectContext?` | plus `body?: unknown` |
| `ProjectMembershipGuard.resolveSlug` | params, then query | params, then query or body by source |
| `CodeIntelController` | `(astIndexService, projectAccess)`; legacy decorators; `resolveProject` / `checkProjectMembership` | `(astIndexService)`; guards + `@Requires`; `@CurrentProject()` |
| `ProjectsController.getChangeImpact` | `@ProjectPermission([READ, 'CodeIntel'])` | `@Requires('codeintel.impact.read')` + `RequiresGuard` |
| `ContextController` | `(contextBuilderService, projectAccess)`; `@RequiredPermission`; `checkProjectMembership` | `(contextBuilderService)`; guards + `@Requires`; `@CurrentProject()` |
| `VcsController` | no class guards; `@RequiredPermission('ADMIN')` / `@ProjectRoles('ADMIN')`; `assertProjectMembership`; rotate `isUserPrincipal` | class `@UseGuards(ProjectMembershipGuard, RequiresGuard)`; `@Requires` per route; none of the removed checks |
| `VcsWebhookController.handleWebhook` | `@Public()` | `@Public()` + `@UseGuards(RequiresGuard)` + `@Requires('vcs.webhook.ingest')` |
| `WebhookController` | `@RequiredPermission('ADMIN')` on five routes | guards + `@Requires` per route |
| `CiWebhookController.handleCiWebhook` | `@Public()` | `@Public()` + `@UseGuards(RequiresGuard)` + `@Requires('ci.webhook.ingest')` |
| `AdminSkillsController` | `@RequiredPermission('ADMIN')` on four routes | `@UseGuards(RequiresGuard)` + `@Requires` per route |
| `ProjectSkillsController` | `(skills, projectAccess)`; `assertUser`, `assertProjectMembership`, `assertProjectAdmin` | `(skills)`; class `@UseGuards(ProjectMembershipGuard, RequiresGuard)`; `@Requires` per route |
| `SkillsService.createSource(input, principal)` | throws 403 `skills.principal` when `principal.actorType !== 'user'` | no principal-type check; records `principal.id` as `createdById` for a user or an agent |

## Out of Scope

- Deleting `KodaCaslAbilityFactory`, `@RequiredPermission`, `@ProjectPermission`, `@ProjectRoles`, `exemptAgents`, `ProjectAccessService.assertProjectMembership` / `assertProjectAdmin`, the CASL subjects `AstIndex`, `CodeIntel` and `ProjectContext`, the legacy union in `PermissionService`, and the legacy tables is out of scope (`permissions-p1-cleanup`).
- Removing the now-unused i18n messages `skills.principal` and `skills.projectPrincipal` is out of scope (`permissions-p1-cleanup`).
- The catalog contract test (every route declares a key, every key is used) and the full role allow/deny matrix test are out of scope (`permissions-p1-cleanup`).
- Declaring keys on routes outside the six route families (the runner protocol routes, `GET /health`, the roles and role-bindings routes) is out of scope.
- Approval of any action (`approvalMode`, `ApprovalRequest`, policies) is out of scope (P3). A permitted request, including an agent's VCS secret rotate, runs immediately.
- Recording an actor context or audit entry for these writes, including a creator for tickets created by VCS sync and CI intake, is out of scope (P2).
- Web and CLI changes are out of scope (`permissions-p1-web`). They read the 403 responses as before.
- Changing the HMAC signature, replay-guard or payload validation of the intake routes is out of scope; only the key declaration is added.
- Rewriting the stored permissions of an existing database's unlocked system roles is out of scope; this feature changes no role entries.
- Updating the design doc's §1 public-key list for the two intake keys is out of scope for the run; it is a manual doc edit.
- Rate limits on the migrated routes are unchanged and out of scope.

## Stories

1. **US-001: Catalog changes and a body slug source** — `Workdir: apps/api` — No dependencies. Re-scopes `codeintel.read` and `codeintel.index.write` to `project` and makes `ci.webhook.ingest` and `vcs.webhook.ingest` public keys (catalog and inventory TSV), and lets `@ProjectSlugFrom` read the slug from the request body.
2. **US-002: Code-intel routes check keys** — `Workdir: apps/api` — Depends on US-001. Moves the five `/code-intel` routes and `GET /projects/:slug/codeintel/impact` onto `@Requires`, with `POST /code-intel/index` resolving its project from the body; `CodeIntelController` drops `ProjectAccessService`.
3. **US-003: Context routes check keys** — `Workdir: apps/api` — No dependencies. Moves `GET /context/:slug` and `POST /context/:slug/query` onto `@Requires` and `ProjectMembershipGuard`; `ContextController` drops `ProjectAccessService`.
4. **US-004: VCS routes check keys** — `Workdir: apps/api` — Depends on US-001. Moves the nine `/projects/:slug/vcs` routes onto `@Requires` under class-level guards, removes the `assertProjectMembership` calls and the rotate route's user-only refusal, and declares `vcs.webhook.ingest` on the public intake route.
5. **US-005: Webhook routes check keys** — `Workdir: apps/api` — Depends on US-001. Moves the five webhook routes onto `@Requires` and declares `ci.webhook.ingest` on the public CI intake route.
6. **US-006: Skills routes check keys** — `Workdir: apps/api` — Depends on US-001, US-002, US-003, US-004, US-005. Moves the four admin skill-source routes and the three project-skills routes onto `@Requires`, removes `SkillsService.createSource`'s user-only refusal, removes `assertUser`, `assertProjectMembership` and `assertProjectAdmin` from `ProjectSkillsController`, and regenerates `openapi.json` after the last route change. (The dependencies on US-002 to US-005 exist only so that the `openapi.json` regeneration runs after every route change.)

This is one capability, enforcing keys on the last REST route families, at six stories.

### Context Files

**US-001**
- `apps/api/src/permissions/catalog.ts` — `PUBLIC_KEYS` and `INVENTORY_SCOPE_ROWS`, edited here
- `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` — the `catalog_scope` rows edited here, re-read by `catalog.spec.ts`
- `apps/api/src/projects/project-context.ts` — `ProjectScopedRequest`, which gains `body?: unknown` here
- `apps/api/src/projects/project-slug-from.decorator.ts` — the decorator widened here
- `apps/api/src/projects/project-membership.guard.ts` — `resolveSlug`, changed here

**US-002**
- `apps/api/src/code-intel/code-intel.controller.ts` — the five routes migrated here
- `apps/api/src/projects/projects.controller.ts` — `getChangeImpact`, migrated here
- `apps/api/src/permissions/requires.guard.ts` — the guard the routes add
- `apps/api/src/projects/project-membership.guard.ts` — body slug resolution from US-001
- `apps/api/src/code-intel/dto/index-commit.dto.ts` — the index body (`projectSlug`, `repoId`, `commitHash`, `files`)

**US-003**
- `apps/api/src/context/context.controller.ts` — the two routes migrated here
- `apps/api/src/context/context-builder.service.ts` — `getProjectContext` and `GetProjectContextQuery`
- `apps/api/src/permissions/requires.guard.ts` — the guard the routes add
- `apps/api/src/projects/current-project.decorator.ts` — `@CurrentProject()`

**US-004**
- `apps/api/src/vcs/vcs.controller.ts` — the nine routes migrated here
- `apps/api/src/vcs/vcs-webhook.controller.ts` — the public intake route
- `apps/api/src/vcs/dto/vcs-connection-response.dto.ts` — the read DTO (no secret fields)
- `apps/api/src/auth/auth.controller.ts` — the public-key pattern (`@Public()` + `RequiresGuard` + `@Requires`)
- `apps/api/src/permissions/requires.guard.ts` — the guard the routes add

**US-005**
- `apps/api/src/webhook/webhook.controller.ts` — the five routes migrated here
- `apps/api/src/webhook/webhook.service.ts` — `getProjectBySlug`, `removeForProject`
- `apps/api/src/ci-webhook/ci-webhook.controller.ts` — the public intake route
- `apps/api/src/auth/auth.controller.ts` — the public-key pattern
- `apps/api/src/permissions/requires.guard.ts` — the guard the routes add

**US-006**
- `apps/api/src/skills/admin-skills.controller.ts` — the four global routes migrated here
- `apps/api/src/skills/project-skills.controller.ts` — the three project routes migrated here
- `apps/api/src/skills/skills.service.ts` — `createSource`, whose principal refusal is removed
- `apps/api/src/skills/prisma-skill-catalog.repository.ts` — `enableProjectSkill` writes `enabledById`
- `apps/api/src/permissions/requires.guard.ts` — the guard the routes add

### Creates

None. Every story changes existing files; new test files are the implementer's choice and are not authorised changes to existing code.

### Modifies

Unit specs that compile a hand-built `TestingModule` around a migrated controller need a `PermissionService` provider (or an overridden `RequiresGuard`): the guard is constructed from the global `PermissionService`, which such a module does not have. Specs that import `GlobalStubsModule` already provide it and are not listed.

**US-001**
- `apps/api/src/permissions/catalog.spec.ts` — its `PUBLIC_KEY_LIST` holds the seven design public keys, and "exports the public, implicit and ownable key sets" asserts `PUBLIC_KEYS` equals it, while "derives access, scope, ownable, risk, principals and approval for every catalog key" derives `access` from the same list. The replacing invariant: `PUBLIC_KEY_LIST` holds those seven plus `ci.webhook.ingest` and `vcs.webhook.ingest`, and every other derivation (including `codeintel.read` and `codeintel.index.write` scoped `project` from the edited TSV rows) is unchanged.

**US-002**
- `apps/api/src/code-intel/code-intel.controller.spec.ts` — its `beforeEach` module provides no `PermissionService`, and its five `indexCommit()` cases call `indexCommit(dto, principal)` and stub or assert `ProjectAccessService.findProjectIdBySlug` / `assertProjectMembership` (admin, agent, unknown slug 404, non-member 403, member allowed). The replacing invariant: the module provides a `PermissionService` double; `indexCommit(dto, ctx)` calls `AstIndexService.indexCommit(repoId, commitHash, files, ctx.project.id)` and returns `JsonResponse.Ok` of its result; the 404 and non-member cases are removed here because `ProjectMembershipGuard` owns them (the unknown body slug 404 is pinned by US-001 AC 10, the non-member 403 by US-002 AC 5); the `getSymbol`, `getCallers` and `getCallees` cases are unchanged.
- `apps/api/src/code-intel/code-intel-search.controller.spec.ts` — its two modules (the controller module and the routing module that overrides only `ProjectMembershipGuard`) provide no `PermissionService`, so `RequiresGuard` cannot be built and the HTTP dispatch cases ("AC10: GET /code-intel/symbols dispatches…", "…/symbols/:symbolId dispatches to getSymbol") cannot run. The replacing invariant: both modules provide a `PermissionService` double that allows `codeintel.read` (or override `RequiresGuard`), and every dispatch and search assertion is unchanged.
- `apps/api/test/integration/ast-index/code-intel-controller-permissions.integration.spec.ts` — its module provides no `PermissionService`, and its five metadata cases assert `PERMISSION_KEY` (MANAGE AstIndex) on `indexCommit` and `PROJECT_PERMISSION_KEY` (READ CodeIntel) on the four reads. The replacing invariant: `REQUIRES_METADATA` keys are `['codeintel.index.write']` on `indexCommit` and `['codeintel.read']` on `searchSymbols`, `getSymbol`, `getCallers` and `getCallees`; `PERMISSION_KEY` and `PROJECT_PERMISSION_KEY` are undefined on all five; `indexCommit`'s project slug source is `{ source: 'body', key: 'projectSlug' }`.
- `apps/api/test/integration/code-intel/code-intel-project-roles.integration.spec.ts` — its `it.each(['pviewer', 'outsider'])('%s is refused on every code-intel route')` expects 403 for a project VIEWER on the five read routes. The replacing invariant: a project VIEWER gets 200 from the five read routes (Viewer holds `codeintel.read` and `codeintel.impact.read`); `outsider` still gets 403; the fail-closed missing, empty and repeated `projectSlug` cases still answer 403; the admin, developer, agent and root cases are unchanged.
- `apps/api/src/projects/projects.controller.spec.ts` — its case "code-intel impact keeps the legacy @ProjectPermission until the integrations story moves it" asserts `PROJECT_PERMISSION_KEY` is defined and `REQUIRES_METADATA` is undefined on `getChangeImpact`. The replacing invariant: `getChangeImpact` carries `REQUIRES_METADATA` keys `['codeintel.impact.read']` and no `PROJECT_PERMISSION_KEY`, and joins the file's table of migrated project-scoped routes; the `getChangeImpact` behaviour cases are unchanged.

**US-003**
- `apps/api/src/context/context.controller.spec.ts` — its module provides no `PermissionService`; its cases call `getContext(slug, dto, principal)` and `queryContext(slug, body, principal)`, stub `ProjectAccessService.findProjectIdBySlug` (slug resolution, unknown and soft-deleted slug 404s) and `assertProjectMembership` (non-member 403, member and agent allowed), and expect `ForbiddenAppException` for a null principal. The replacing invariant: the module provides a `PermissionService` double; `getContext(dto, principal, ctx)` and `queryContext(body, principal, ctx)` call `ContextBuilderService.getProjectContext` with `projectId` `ctx.project.id` and `actorId` `principal.id` and the same parsed query fields as before; the slug, 404, non-member and null-principal cases are removed because the guards own them (pinned at HTTP by US-003 ACs 5 to 8); the query-building and response assertions are unchanged.

**US-004**
- `apps/api/src/vcs/vcs.controller.spec.ts` — its module provides no `PermissionService`; eight cases assert `ProjectsService.assertProjectMembership` was called with `('proj-1', adminUser)`, eight "should reject when the principal is not a project member" cases make it reject, and "refuses agents: they never hold webhook secrets" expects `ForbiddenAppException` for an agent on `rotateWebhookSecret` with the service not called. The replacing invariant: the module provides a `PermissionService` double; no handler calls `assertProjectMembership` (those sixteen cases are removed or inverted to `not.toHaveBeenCalled`); `rotateWebhookSecret(ctx)` for an agent caller delegates to `VcsConnectionService.rotateWebhookSecret('proj-1')` and returns its result; the 409, `ValidationAppException` and not-found cases are unchanged.
- `apps/api/test/integration/vcs/vcs-controller.spec.ts` — its module provides no `PermissionService`, so `VcsController`'s class-level `RequiresGuard` cannot be built. The replacing invariant: the module provides a `PermissionService` double, and every delegation assertion is unchanged.
- `apps/api/test/integration/vcs/vcs-manual-sync.spec.ts` — its module provides no `PermissionService`, so `VcsController`'s class-level `RequiresGuard` cannot be built. The replacing invariant: the module provides a `PermissionService` double, and every sync assertion is unchanged.
- `apps/api/src/vcs/vcs-webhook.controller.spec.ts` — its module provides no `PermissionService`, so the `RequiresGuard` now on the public intake route cannot be built. The replacing invariant: the module provides a `PermissionService` double, and every signature, replay and ignore-reason assertion is unchanged.
- `apps/api/test/integration/vcs/vcs-webhook.integration.spec.ts` — its module provides no `PermissionService`, so the `RequiresGuard` now on the public intake route cannot be built. The replacing invariant: the module provides a `PermissionService` double, and every delivery assertion is unchanged.
- `apps/api/test/integration/vcs/vcs-webhook-pull-request.integration.spec.ts` — its module provides no `PermissionService`, so the `RequiresGuard` now on the public intake route cannot be built. The replacing invariant: the module provides a `PermissionService` double, and every pull-request delivery assertion is unchanged.

**US-005**
- `apps/api/src/webhook/webhook-routes.spec.ts` — its harness authorizes through a fake principal injector and the global `PermissionAuthGuard` over `@RequiredPermission('ADMIN')`, provides no `ProjectAccessService` or `PermissionService`, and its cases "AC13: PATCH by a user who is not a global ADMIN returns 403…" and "US-003: the ADMIN gate this harness installs is the production permission guard (POST as non-ADMIN returns 403)" rest on that ADMIN gate. The replacing invariant: the harness provides `ProjectMembershipGuard`'s dependencies (or overrides that guard) and a `PermissionService` double whose `can` refuses `webhook.*` keys for the member principal and allows them for the admin principal; a refused key answers 403 and writes nothing; the 400, 404 and 201 cases are unchanged; the file header describes the key gate instead of the ADMIN gate.
- `apps/api/src/ci-webhook/ci-webhook.controller.spec.ts` — its module provides no `PermissionService`, so the `RequiresGuard` now on the public intake route cannot be built. The replacing invariant: the module provides a `PermissionService` double, and the 401, replay 409 and 400 assertions are unchanged.

**US-006**
- `apps/api/test/integration/skills/project-skills-routes.integration.spec.ts` — its case "US-005 AC4: an agent API key on the project roster still gets 403" expects the rostered DEVELOPER-role agent to be refused the project-skills listing for project web with 403. The replacing invariant: that agent gets 200 from the listing (it holds `skill.project.read`); its enable is still refused with 403 and writes no row; the not-on-roster agent is still refused with 403 (error code `projects`); every other case is unchanged.
- `openapi.json` — it records the routes this feature migrates, whose 403 descriptions may be reworded. The replacing invariant: it is regenerated with `bun run api:export-spec` after the last route change, and every path and schema other than those descriptions is unchanged.

### Seams

- **US-001 → US-002:** `@ProjectSlugFrom('body', 'projectSlug')` is reached from `POST /code-intel/index`: US-002 AC 2 observes that the symbols indexed through the route are stored under the body slug's project, and AC 4 that a body with no slug fails closed.
- **US-001 → US-002:** the `project` scope of `codeintel.read` and `codeintel.index.write` is observed at the routes: a Developer binding indexes (US-002 AC 1) and a Viewer binding reads symbols but cannot index (US-002 ACs 3 and 6).
- **US-001 → US-004, US-005:** the public `vcs.webhook.ingest` and `ci.webhook.ingest` are observed at the intake routes with no principal: US-004 AC 14 and US-005 ACs 12 and 13. A role key there would answer 403 `permissions` instead.
- **Every route story:** each migrated route family has a refusal AC with error code `permissions` for a principal that has project access, and an allow AC for a principal whose only source is a role binding that a legacy check would have refused (a Project Admin binding on the VCS, webhook and skills routes; a Developer binding on code-intel indexing). A route still carrying a legacy decorator answers a different code or outcome for these principals.

## Acceptance Criteria

Fixture wording: "a user whose only source in `p1` is a `<role>` binding" means a user with that `RoleBinding` in project `p1`, no `ProjectMember` row, and no global admin role; "an agent whose only source in `p1` is a `<role>` binding" likewise, with no `AgentProject` or `AgentRoleEntry` row. "A user with no access to `p1`" has no binding, membership or global admin role touching `p1`. "A custom-role user" holds, in `p1`, only a custom PROJECT role whose permissions are `['ticket.read']`. DB-backed tests seed the system roles first (ruling 1). Agent project scoping is on.

### US-001: Catalog changes and a body slug source (`Workdir: apps/api`)

1. [unit] `findCatalogEntry('codeintel.read')` returns an entry with `scope` `'project'` and `access` `'role'`.
2. [unit] `findCatalogEntry('codeintel.index.write')` returns an entry with `scope` `'project'` and `access` `'role'`.
3. [unit] `findCatalogEntry('ci.webhook.ingest')` returns an entry with `access` `'public'`, and `PUBLIC_KEYS` has `'ci.webhook.ingest'`.
4. [unit] `findCatalogEntry('vcs.webhook.ingest')` returns an entry with `access` `'public'`, and `PUBLIC_KEYS` has `'vcs.webhook.ingest'`.
5. [unit] For the set returned by `expandEntries` of the seeded `developer` role's permissions with scope `'PROJECT'`, `has('codeintel.read')` and `has('codeintel.index.write')` are both `true`.
6. [unit] For the set returned by `expandEntries` of the seeded `viewer` role's permissions with scope `'PROJECT'`, `has('codeintel.read')` is `true` and `has('codeintel.index.write')` is `false`.
7. [unit] For the set returned by `expandEntries` of the seeded `project-admin` role's permissions with scope `'PROJECT'`, `has('ci.webhook.ingest')` and `has('vcs.webhook.ingest')` are both `false`.
8. [unit] `RequiresGuard.canActivate` on a handler decorated `@Requires('vcs.webhook.ingest')`, for a request with no `user`, resolves `true` without calling `PermissionService.can`.
9. [unit] `ProjectMembershipGuard.canActivate` on a handler decorated `@ProjectSlugFrom('body', 'projectSlug')`, for a request with no `params.slug`, no query slug and body `{ projectSlug: 'p1' }` from a principal with access to `p1`, sets `request.projectContext.project.id` to `p1`'s id.
10. [unit] `ProjectMembershipGuard.canActivate` on that handler with body `{ projectSlug: 'no-such-project' }` rejects with a 404 `NotFoundAppException` (code `projects`).
11. [unit] `ProjectMembershipGuard.canActivate` on that handler with an empty body resolves `true` and leaves `request.projectContext` unset.
12. [unit] `ProjectMembershipGuard.canActivate` on that handler with body `{ projectSlug: 42 }` resolves `true` and leaves `request.projectContext` unset.
13. [unit] `ProjectMembershipGuard.canActivate` on a handler decorated `@ProjectSlugFrom('query', 'projectSlug')` with query `{ projectSlug: 'p1' }` sets `request.projectContext.project.id` to `p1`'s id, as before.
14. [unit] On a handler decorated `@ProjectSlugFrom('body', 'projectSlug')`, a request with `params.slug` `'p1'` and body `{ projectSlug: 'p2' }` resolves project `p1`.

### US-002: Code-intel routes check keys (`Workdir: apps/api`)

1. [integration] A user whose only source in `p1` is a `developer` binding gets 201 from `POST /code-intel/index` with body `{ projectSlug: 'p1', repoId, commitHash, files }` holding one TypeScript file that declares a function.
2. [integration] After a user whose only sources are `developer` bindings in `p1` and `p2` indexes a file declaring function `fooFn` through `POST /code-intel/index` with body `projectSlug: 'p1'`, `GET /code-intel/symbols?projectSlug=p1&q=fooFn` by that user returns a `fooFn` symbol, and `GET /code-intel/symbols?projectSlug=p2&q=fooFn` returns no items.
3. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `POST /code-intel/index` with `projectSlug: 'p1'`, and no symbol is stored for `p1`.
4. [integration] A global admin gets 403 with error code `permissions` from `POST /code-intel/index` with a body that has no `projectSlug`.
5. [integration] A user with no access to `p1` gets 403 with error code `projects` from `POST /code-intel/index` with `projectSlug: 'p1'`.
6. [integration] A user whose only source in `p1` is a `viewer` binding gets 200 from `GET /code-intel/symbols?projectSlug=p1`.
7. [integration] A custom-role user gets 403 with error code `permissions` from `GET /code-intel/symbols?projectSlug=p1`.
8. [integration] A global admin gets 403 with error code `permissions` from `GET /code-intel/symbols` with no `projectSlug`.
9. [integration] A user whose only source in `p1` is a `viewer` binding gets 200 from `GET /code-intel/symbols/<id>?projectSlug=p1` for a symbol indexed in `p1`.
10. [integration] A custom-role user gets 403 with error code `permissions` from `GET /code-intel/symbols/<id>/callers?projectSlug=p1`.
11. [integration] A user whose only source in `p1` is a `viewer` binding gets 200 from `GET /code-intel/symbols/<id>/callees?projectSlug=p1`.
12. [integration] An agent whose only source in `p1` is a `developer` binding gets 201 from `POST /code-intel/index` with `projectSlug: 'p1'`.
13. [integration] A user whose only source in `p1` is a `viewer` binding gets 200 from `GET /projects/p1/codeintel/impact?repoId=<r>&commitHash=<c>&changedFiles=src/a.ts`.
14. [integration] A custom-role user gets 403 with error code `permissions` from `GET /projects/p1/codeintel/impact?repoId=<r>&commitHash=<c>&changedFiles=src/a.ts`.
15. [integration] A user whose only source in `p1` is a `viewer` binding gets 400 from `GET /projects/p1/codeintel/impact` with no query parameters (the key passes, then the handler's parameter check refuses).

### US-003: Context routes check keys (`Workdir: apps/api`)

1. [integration] A user whose only source in `p1` is a `viewer` binding gets 200 from `GET /context/p1`.
2. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `POST /context/p1/query` with body `{ query: 'auth' }`.
3. [integration] A user whose only source in `p1` is a `developer` binding gets 200 from `POST /context/p1/query` with body `{ query: 'auth' }`.
4. [integration] An agent whose only source in `p1` is a `developer` binding gets 200 from `POST /context/p1/query` with body `{ query: 'auth' }`.
5. [integration] A custom-role user gets 403 with error code `permissions` from `GET /context/p1`.
6. [integration] A user with no access to `p1` gets 403 with error code `projects` from `GET /context/p1`.
7. [integration] A global admin gets 404 with error code `projects` from `GET /context/no-such-project`.
8. [integration] A global admin gets 404 with error code `projects` from `GET /context/<slug>` for a soft-deleted project.
9. [integration] With `ContextBuilderService.getProjectContext` spied, `GET /context/p1` by a user whose only source in `p1` is a `viewer` binding calls it once with a query whose `projectId` is `p1`'s id and whose `actorId` is that user's id.

### US-004: VCS routes check keys (`Workdir: apps/api`)

These ACs run with `VCS_ENCRYPTION_KEY` set for the test, as `apps/api/test/integration/vcs/vcs-webhook-secret.integration.spec.ts` does.

1. [integration] A user whose only source in `p1` is a `project-admin` binding gets 201 from `POST /projects/p1/vcs` with a valid create body, and the response carries `webhookSecret`.
2. [integration] A user whose only source in `p1` is a `viewer` binding gets 200 from `GET /projects/p1/vcs`, and the response has `webhookSecretConfigured` and no `webhookSecret` or `encryptedToken` field.
3. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `PATCH /projects/p1/vcs` with `{ syncMode: 'polling' }`, and the stored connection's `syncMode` is unchanged.
4. [integration] A user whose only source in `p1` is a `project-admin` binding gets 200 from `PATCH /projects/p1/vcs` with `{ syncMode: 'polling' }`, and the stored `syncMode` is `polling`.
5. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `DELETE /projects/p1/vcs`, and the connection still exists.
6. [integration] A user whose only source in `p1` is a `project-admin` binding gets 204 from `DELETE /projects/p1/vcs`, and the connection no longer exists.
7. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `POST /projects/p1/vcs/test`.
8. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `POST /projects/p1/vcs/sync`, and no `VcsSyncLog` row is written for `p1`.
9. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `POST /projects/p1/vcs/sync/1`.
10. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `POST /projects/p1/vcs/sync-pr`.
11. [integration] An agent whose only source in `p1` is a `project-admin` binding gets 200 from `POST /projects/p1/vcs/webhook-secret/rotate`, and the stored `webhookSecret` differs from the one before the call.
12. [integration] An agent whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `POST /projects/p1/vcs/webhook-secret/rotate`, and the stored `webhookSecret` is unchanged.
13. [integration] A user with no access to `p1` gets 403 with error code `projects` from `GET /projects/p1/vcs`.
14. [integration] For a `p1` connection with a webhook secret and `syncMode` `polling`, `POST /projects/p1/vcs-webhook` with no `Authorization` header and a body signed with that secret in `x-hub-signature-256` answers 200 with a body whose `success` is `true` and `ignored` is `true`.
15. [integration] `POST /projects/p1/vcs-webhook` with no `Authorization` header and a bad signature answers 401 with error code `vcs_webhook`, as before.

### US-005: Webhook routes check keys (`Workdir: apps/api`)

1. [integration] A user whose only source in `p1` is a `project-admin` binding gets 201 from `POST /projects/p1/webhooks` with `{ url: 'https://93.184.215.14/hook', events: ['STATUS_CHANGE'] }` (a public IP literal, so the URL check needs no DNS).
2. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `POST /projects/p1/webhooks` with that body, and no webhook row is created.
3. [integration] A user whose only source in `p1` is a `viewer` binding gets 200 from `GET /projects/p1/webhooks`, and no listed item has a `secret` field.
4. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `PATCH /projects/p1/webhooks/<id>` with `{ active: false }`, and the row stays active.
5. [integration] A user whose only source in `p1` is a `project-admin` binding gets 200 from `PATCH /projects/p1/webhooks/<id>` with `{ active: false }`, and the row is inactive.
6. [integration] A user whose only source in `p1` is a `project-admin` binding gets 204 from `DELETE /projects/p1/webhooks/<id>`, and the row no longer exists.
7. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `DELETE /projects/p1/webhooks/<id>`, and the row still exists.
8. [integration] A user whose only source in `p1` is a `project-admin` binding gets 403 with error code `permissions` from `DELETE /webhooks/<id>` for a webhook of `p1`, and the row still exists.
9. [integration] A global admin gets 204 from `DELETE /webhooks/<id>`, and the row no longer exists.
10. [integration] A user with no access to `p1` gets 403 with error code `projects` from `GET /projects/p1/webhooks`.
11. [integration] A user whose only source in `p1` is a `project-admin` binding gets 404 from `PATCH /projects/p1/webhooks/<id>` for a webhook that belongs to `p2`, and that row is unchanged.
12. [integration] `POST /projects/p1/ci-webhook` with no `Authorization` header and a failing-pipeline body signed with `p1`'s CI webhook token answers 200 and creates one BUG ticket in `p1`.
13. [integration] `POST /projects/p1/ci-webhook` with no `Authorization` header and no `x-ci-signature` answers 401 with error code `ci_webhook`, as before.

### US-006: Skills routes check keys (`Workdir: apps/api`)

1. [integration] A user with no global admin role gets 403 with error code `permissions` from `GET /admin/skills/sources`.
2. [integration] A global admin gets 200 from `GET /admin/skills/sources`.
3. [integration] A user with no global admin role gets 403 with error code `permissions` from `POST /admin/skills/sources/<id>/update`, and from `DELETE /admin/skills/sources/<id>`, and the source still exists.
4. [integration] An agent with no global binding beyond its baseline gets 403 with error code `permissions` from `POST /admin/skills/sources` with a valid body.
5. [integration] An agent with a global `admin` binding gets 201 from `POST /admin/skills/sources` with a valid body (the skill resolver stubbed), and the stored `SkillSource.createdById` is the agent's id.
6. [unit] `SkillsService.createSource({ gitUrl, ref, path }, agentPrincipal)` with a stubbed catalog and resolver does not throw, and passes `createdById` equal to the agent principal's id to `SkillCatalogRepository.createSource`.
7. [integration] A user whose only source in `p1` is a `viewer` binding gets 200 from `GET /projects/p1/skills`.
8. [integration] An agent whose only source in `p1` is a `viewer` binding gets 200 from `GET /projects/p1/skills`.
9. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `PUT /projects/p1/skills/<skillId>`, and no `ProjectSkill` row exists for `(p1, skillId)`.
10. [integration] A user whose only source in `p1` is a `project-admin` binding gets 200 from `PUT /projects/p1/skills/<skillId>`, and the `ProjectSkill` row's `enabledById` is that user's id.
11. [integration] An agent whose only source in `p1` is a `project-admin` binding gets 200 from `PUT /projects/p1/skills/<skillId>`, and the `ProjectSkill` row's `enabledById` is the agent's id.
12. [integration] A user whose only source in `p1` is a `project-admin` binding gets 204 from `DELETE /projects/p1/skills/<skillId>` for an enabled skill, and the `ProjectSkill` row no longer exists.
13. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `DELETE /projects/p1/skills/<skillId>` for an enabled skill, and the row still exists.
14. [integration] A user with no access to `p1` gets 403 with error code `projects` from `GET /projects/p1/skills`.
