<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Permissions P1c — Enforce Permission Keys on the Core Routes

## Summary

This feature moves authorization on the core REST routes of `apps/api` onto permission keys checked by `PermissionService.can`:
- **One route mechanism.** A new `@Requires(key)` decorator and `RequiresGuard` check a route's catalog key(s) after `ProjectMembershipGuard` has resolved the project. Checks that need the target row (comment and link ownership, the ticket transition edge) run in the service through the same `PermissionService.can`.
- **Legacy rows count until cleanup.** `can` treats the legacy `ProjectMember`, `AgentProject` and `AgentRoleEntry` rows as virtual role bindings, and a principal with no baseline binding as holding its baseline role, so existing members and agents keep a working role.
- **The core routes switch over.** Tickets (with one key per transition edge and per-edge `allowedActions`), comments, labels, ticket labels, watchers, ticket links (with a new link creator), projects, the project agent roster, assignees, members, invites, agents, admin users, the outbox and SLO admin routes, and the public and implicit auth, home, notification and invite routes. Each loses its `@ProjectPermission`, `@RequiredPermission`, `assertProjectAdmin`, `canOverrideClose` or CASL service check.

This is the third of seven features implementing phase P1 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md`. The order is: roles (PR #308), membership (PR #310), **enforce-core**, enforce-fleet, enforce-integrations, cleanup, and web in parallel. The design doc's phasing section lists five features and predates both splits: `permissions-p1-roles` split off membership, and this feature's scoping (2026-10-19) moved the vcs, webhook, skills, code-intel, context and ci-webhook routes into a new `permissions-p1-enforce-integrations`.

## Motivation

`permissions-p1-roles` and `permissions-p1-membership` built the role model, but no route checks a permission key yet. Routes still decide through four disagreeing mechanisms: the CASL factory over the legacy project role, `@RequiredPermission('ADMIN')`, `assertProjectAdmin`, and ad-hoc checks such as `canOverrideClose` and the roster `isAdmin || isSelf`. A user bound to `reviewer` in a project gets the legacy `VIEWER` rights, because `legacyRoleForRoleKey` maps every role other than project-admin and developer to `VIEWER`. And any agent on a roster can still create and delete tickets and manage labels whatever its role, which the 2026-10-18 review flagged (ruling 2).

This feature makes the seeded roles real on the core surface: a principal can do on a core route exactly what its keys allow.

**Rulings that bind this feature** (user, 2026-10-19):
- **One feature**, not a split by surface.
- **Legacy rows are virtual bindings in `can`** until `permissions-p1-cleanup` (see "Legacy union").
- **Appendix A role contents are accepted as designed.** Notably: Developer gains `ticket.transition.close` and `label.update`; an agent whose only source is a roster row is a Viewer and loses ticket create and delete and label writes; an agent with legacy role `DEVELOPER` gets Developer, which has no `ticket.delete`.
- **`project.ci-token.read` and `invite.read` stay project-admin only.** The six non-admin project roles exclude them (see "Catalog and seeded role changes").
- **The five global agent-management keys are re-scoped to `global`** (see "Catalog and seeded role changes").
- **Ticket links record their creator,** so `ticket.link.remove.own` can match.
- The vcs, webhook, skills, code-intel, context and ci-webhook routes move to the new feature `permissions-p1-enforce-integrations`.

## Design

### Rulings that bind every story

1. **Conventions carry over** from `.nax/features/permissions-p1-roles/spec.md` (its "Rulings that bind every story"), unless this spec says otherwise: `PermissionsModule` is `@Global()`; consumers inject `PermissionService` and `MembershipService` without `@Optional()`; exceptions are `new XAppException({}, '<namespace>.<code>')` from `@nathapp/nestjs-common` (`ConflictAppException` is the repo's local class); new messages need `en` and `zh` entries; repositories follow `.nax/rules/api-data.md`; DB-backed tests that need the system roles run `SystemRoleSeeder.onApplicationBootstrap()` after `resetDb`, or boot the app.
2. **A refused key answers 403 with error code `permissions`**: `new ForbiddenAppException({}, 'permissions')`, message `permissions.403` (already present in `apps/api/src/i18n/{en,zh}/permissions.json`). This replaces whatever the legacy key checks answered (codes such as `projects`, `tickets`, `members`, `comments`, or Nest's generic 403 from `@RequiredPermission`) **on key refusals only**. Unchanged: `ProjectMembershipGuard`'s 403 `projects` for a principal with no access to the project, the 404s for missing projects, tickets and comments, and every existing non-permission refusal (for example `users.self`, `members.lastAdmin`, `projectAgents.hasOpenTickets`).
3. **Order of checks on every route:**
   1. authentication (the global guards);
   2. project resolution and access (`ProjectMembershipGuard`: 404 project, 403 `projects`);
   3. the route key (`RequiresGuard`: 403 `permissions`);
   4. input validation (the global `ValidationPipe`);
   5. lookups in the handler (404s);
   6. row-level key checks in the service (the ownership `.own` check, the transition edge key: 403 `permissions`);
   7. domain rules (409s, transition validity 400).

   The first failing step decides the response. A route whose key is checked in the service (`enforcedBy: 'service'`) moves step 3 to step 6.
4. **`RequiresGuard` runs after `ProjectMembershipGuard`.** On a route with a project-scoped key, both appear in one `@UseGuards(ProjectMembershipGuard, RequiresGuard)` call, at the method level, or both at the class level. Never class-level `RequiresGuard` with method-level `ProjectMembershipGuard`, because Nest runs class guards first.
5. **`ProjectMembershipGuard` is unchanged** and keeps resolving the project, the access check and `request.projectContext`. Its `@ProjectPermission` and `@ProjectRoles` branches stay for the routes this feature does not migrate.
6. **Agent keys are re-scoped, other catalog keys are used as they are.** The design's removed keys (`project.agent.add`, `project.agent.update`, `project.agent.remove`, `member.role.update`, `agent.roles.update`) are still in the catalog, and this feature uses them on their routes. `permissions-p1-cleanup` folds and removes them.
7. **Shared services stay safe for the assistant tools.** The assistant tools (`apps/api/src/fleet/assistant/tools/`) call `TicketsService.create`, `TicketsService.update`, `CommentsService.create`, `TicketLinksService.create` and `TicketTransitionsService.assertTransitionPermission`. This feature keeps those signatures callable as they are, and keeps `assertTransitionPermission` on the legacy CASL check. `permissions-p1-enforce-fleet` moves the tools onto keys.
8. **Project rules already describe this mechanism.** `.nax/rules/api-core.md` (Auth) and `.nax/rules/api-auth.md` ("Guard-Level vs Service-Level Authorization") were updated on this branch before the run: migrated routes use `@Requires` and `RequiresGuard`, and the legacy decorators stay only on routes not yet migrated. Follow them over any older guidance.
9. **`api-testing.md` endpoint e2e rule, ruled for this feature.** The rule asks endpoint changes to be reflected in `test/e2e/api-endpoint/endpoint.e2e.spec.ts`. For this feature the route-level allow and refuse cases are pinned by the integration ACs (each migrated route family has at least one allow and one 403 `permissions` case), which satisfies the rule's intent; only the existing e2e cases a correct implementation breaks are edited (see Modifies). The same ruling was made for `permissions-p1-membership`.
10. **The union also feeds anti-escalation.** `RoleAdminService` reads `PermissionService.effectiveKeys` as the caller's held set, so after this feature a legacy `ProjectMember` ADMIN row counts as `project-admin` there too (including `role.binding.manage` in that project), exactly as a `project-admin` binding does. This is intended: the union makes a legacy row equivalent to its mapped binding everywhere.

### `@Requires` and `RequiresGuard`

New file `apps/api/src/permissions/requires.decorator.ts`:

```ts
export const REQUIRES_METADATA = 'koda:requires';

export interface RequiresOptions {
  /** 'all' (default): every key must pass. 'any': at least one. */
  mode?: 'all' | 'any';
  /** 'guard' (default): RequiresGuard checks the keys. 'service': the handler or service checks them; the guard only records them. */
  enforcedBy?: 'guard' | 'service';
}

export interface RequiresMetadata {
  keys: readonly string[];
  mode: 'all' | 'any';
  enforcedBy: 'guard' | 'service';
}

export const Requires = (keys: string | readonly string[], options: RequiresOptions = {}) =>
  SetMetadata<string, RequiresMetadata>(REQUIRES_METADATA, {
    keys: typeof keys === 'string' ? [keys] : [...keys],
    mode: options.mode ?? 'all',
    enforcedBy: options.enforcedBy ?? 'guard',
  });
```

New file `apps/api/src/permissions/requires.guard.ts`. Both files are exported from the permissions folder by path (no barrel). `RequiresGuard` needs no provider entry: it depends only on `Reflector` and the global `PermissionService`.

```ts
@Injectable()
export class RequiresGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly permissions: PermissionService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<RequiresMetadata | undefined>(REQUIRES_METADATA, [ctx.getHandler(), ctx.getClass()]);
    if (!meta || meta.enforcedBy === 'service') return true;
    const req = ctx.switchToHttp().getRequest<ProjectScopedRequest>();
    const projectId = req.projectContext?.project.id;
    const results = await Promise.all(meta.keys.map((key) => this.passes(req.user, key, projectId)));
    const ok = meta.mode === 'all' ? results.every(Boolean) : results.some(Boolean);
    if (!ok) throw new ForbiddenAppException({}, 'permissions');
    return true;
  }

  private async passes(principal: KodaPrincipal | undefined, key: string, projectId: string | undefined): Promise<boolean> {
    const entry = findCatalogEntry(key);
    if (!entry) return false;                                   // unknown key: fail closed
    if (entry.access === 'public') return true;                 // no principal needed
    if (!principal) return false;
    if (entry.scope === 'project' && !projectId) return false;  // project key outside a resolved project: fail closed
    const decision = await this.permissions.can(principal, key, projectId ? { projectId } : {});
    // Holding only `key.own` passes the route; the service checks the row.
    return decision.allowed || decision.reason === 'not-owner';
  }
}
```

**Rules:**
- `Requires` throws an `Error` at decoration time when given an empty key list, so no route can declare `@Requires([])`.
- A route with no `@Requires` metadata passes the guard unchanged. Routes this feature does not migrate keep their legacy checks.
- `enforcedBy: 'service'` records the key for `permissions-p1-cleanup`'s catalog contract test. It is used where the check needs input the guard cannot see: the target row (ownership), the ticket's current status (transition edge), the agent's identity (roster self-update, pickup), or a filtered listing (`GET /projects`).

### Legacy union in `PermissionService`

`PermissionService.computeKeys(principal, projectId)` gains two sources after the bindings and before the global-admin expansion:

1. **Legacy role keys.** A new `PrismaRoleBindingRepository.findLegacyRoleKeys(principal, projectId, agentScoping)` returns system role keys. It calls a new query `legacyRoleKeys(db, principal, projectId, agentScoping)` in `apps/api/src/permissions/legacy-membership.queries.ts`. For each returned key, `computeKeys` loads the role with `this.roles.findOne({ key })` and adds its entries the way it does for bindings. A key with no role row adds nothing.
   - `projectId` null: no keys.
   - USER: the user's `ProjectMember` row in the project answers `ROLE_KEY_FOR_LEGACY_ROLE[role]` for `ADMIN` and `DEVELOPER` (`project-admin`, `developer`) and `viewer` for any other stored role. No row: no keys.
   - AGENT, scoping on: `viewer` when the agent has an `AgentProject` row in the project. Then, when `agentHasProjectAccess(db, agentId, projectId)` is true (any access source, binding or legacy), one key per `AgentRoleEntry` role: `DEVELOPER` → `developer`, `REVIEWER` → `reviewer`, `VERIFIER` → `verifier`, `TRIAGER` → `triager`. An unknown stored role adds nothing.
   - AGENT, scoping off: `viewer` plus the `AgentRoleEntry` keys in every non-deleted project. This mirrors today's `AGENT_PROJECT_SCOPING=off`, where every agent reaches every project.
2. **Baseline fallback.** If the principal's bindings include no `projectId`-null binding of a GLOBAL-scope role, `computeKeys` adds the entries of `member` (USER) or `agent` (AGENT). Principals created before `permissions-p1-roles` have no baseline binding, and test fixtures write users and agents directly.

`agentScoping` is `authConfig.agentProjectScoping !== false`, the rule `AgentsService.agentScopingEnabled` uses. `PermissionService` gains a required fourth constructor parameter, `@Inject(AUTH_CFG) authConfig: IAuthConfig`.

**Cache.** The union results are cached with the binding keys under the existing `permissions` entries. A new `MembershipService.invalidatePermissions(): Promise<void>` calls `PermissionCache.invalidate()`. `AgentsService.updateRoles` calls it after its `AgentRoleEntry` write commits, so a role change takes effect on the next request. The other legacy writes either already go through `MembershipService` (member and roster removals) or happen only in tests.

**Global admins are unchanged:** a legacy `User.role = 'ADMIN'` user or a global `owner` or `admin` binding still holds every key in every project.

### Catalog and seeded role changes

- **Agent keys re-scoped to global.** `agent.update`, `agent.delete`, `agent.key.rotate`, `agent.capabilities.update` and `agent.roles.update` change from `project` to `global` in `INVENTORY_SCOPE_ROWS` (`apps/api/src/permissions/catalog.ts`) and in the `catalog_scope` column of `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv`, whose rows `catalog.spec.ts` re-reads. Only global Owner and Admin then hold them, as today (global ADMIN only). `agent.pickup` stays project-scoped.
- **Secret and invitation reads stay admin-only.** The seeded roles `developer`, `reviewer`, `verifier`, `triager`, `approver` and `viewer` in `apps/api/src/permissions/system-roles.ts` each gain the entries `!project.ci-token.read` and `!invite.read`. `project-admin` keeps both through `*`. `SystemRoleSeeder` writes these entries when it creates a role, so a new or reset database (every DB-backed test) gets them. It does not rewrite an existing unlocked role's permissions, so an existing database keeps its stored entries until it is reset. koda-wk is reset when P1 ships (design §8).

### Route keys

`G` = `RequiresGuard` checks the key; `S` = `enforcedBy: 'service'` (the check named in the last column). Every project route has `ProjectMembershipGuard` before `RequiresGuard`. Global routes (no slug) have `RequiresGuard` only.

| Route | Key | | Replaces |
|:--|:--|:--|:--|
| `POST /projects/:slug/tickets` | `ticket.create` | G | `@ProjectPermission(CREATE Ticket)` |
| `GET /projects/:slug/tickets`, `GET …/tickets/:ref` | `ticket.read` | G | guard only |
| `PATCH …/tickets/:ref` | `ticket.update`; plus the edge key when `status` is sent | G + S (edge in `TicketTransitionsService`) | `@ProjectPermission(UPDATE)`, `assertTransitionPermission` |
| `DELETE …/tickets/:ref` | `ticket.delete` | G | `@ProjectPermission(DELETE)` |
| `POST …/tickets/:ref/assign` | `ticket.assign` | G | `@ProjectPermission(UPDATE)` |
| `POST …/:ref/verify`, `/start`, `/fix`, `/reject` | `ticket.transition.verify`, `.start`, `.fix`, `.reject`; plus the edge key | G + S (edge) | `@ProjectPermission(TRANSITION)` |
| `POST …/:ref/verify-fix` | `ticket.transition.verify-fix.approve` or `.return`, `mode: 'any'`; plus the edge key | G + S (edge) | `@ProjectPermission(TRANSITION)` |
| `POST …/:ref/close` | `ticket.transition.close` | G | `@ProjectPermission(TRANSITION)` + `canOverrideClose` |
| `POST …/:ref/comments` | `comment.create` | G | guard only |
| `GET …/:ref/comments` | `comment.read` | G | guard only |
| `PATCH /comments/:id` | `comment.update` | S (`CommentsService.update`, ownership) | `@RequiredPermission(UPDATE Comment)` + CASL |
| `DELETE /comments/:id` | `comment.delete` | S (`CommentsService.delete`, ownership) | `@RequiredPermission(DELETE Comment)` + CASL |
| `POST /projects/:slug/labels`, `GET`, `PATCH …/:id`, `DELETE …/:id` | `label.create`, `label.read`, `label.update`, `label.delete` | G | `@ProjectPermission(... Label)` |
| `POST …/:ref/labels`, `DELETE …/:ref/labels/:labelId` | `ticket.label.assign`, `ticket.label.remove` | G | `@ProjectPermission(UPDATE Ticket, exemptAgents)` |
| `GET …/:ref/watchers`, `PUT …/:ref/watch`, `DELETE …/:ref/watch` | `ticket.watch.read`, `.set`, `.unset` | G | guard only (users-only check kept) |
| `POST …/:ref/links`, `GET …/:ref/links` | `ticket.link.add`, `ticket.link.read` | G | controller `assertMembership` |
| `DELETE …/:ref/links/:linkId` | `ticket.link.remove` | S (`TicketLinksService.remove`, ownership) | controller `assertMembership` |
| `POST /projects` | `project.create` | G | `@RequiredPermission('ADMIN')` |
| `GET /projects` | `project.read` | S (listing filtered by access, unchanged) | none |
| `GET /projects/:slug` | `project.read` | G | guard only |
| `GET /projects/:slug/ci-webhook-token`, `PATCH /projects/:slug`, `DELETE /projects/:slug` | `project.ci-token.read`, `project.update`, `project.delete` | G | `@RequiredPermission('ADMIN')` |
| `GET /projects/:slug/agents` | `project.agent.read` | G | `assertProjectMembership` |
| `POST /projects/:slug/agents`, `DELETE …/agents/:agentSlug` | `project.agent.add`, `project.agent.remove` | G | `assertProjectAdmin` |
| `PATCH /projects/:slug/agents/:agentSlug` | `project.agent.update`, or the agent itself | S (controller) | `isAdmin \|\| isSelf` |
| `GET /projects/:slug/assignees` | `project.assignee.read` | G | guard only |
| `GET /projects/:slug/members`, `POST`, `PATCH …/:userId`, `DELETE …/:userId` | `member.read`, `member.add`, `member.role.update`, `member.remove` | G | `resolveMembership` / `assertProjectAdmin` in `ProjectMembersService` |
| `GET /projects/:slug/invites`, `POST`, `POST …/:id/resend`, `DELETE …/:id` | `invite.read`, `invite.create`, `invite.resend`, `invite.cancel` | G | `assertProjectAdmin` in `ProjectInvitesService` |
| `POST /agents` | `agent.create` | G | `@RequiredPermission('ADMIN')` |
| `GET /agents`, `GET /agents/:slug` | `agent.read` | G | none |
| `GET /agents/me` | `agent.self.read` | G (implicit) + agents-only check in the controller | `@RequiredPermission(READ AgentScope)` |
| `GET /agents/:slug/pickup` | `agent.pickup` (held by the target agent) | S (`AgentsService.suggestTicket`, after the project lookup) | self-or-admin check (kept); roster check |
| `PATCH /agents/:slug`, `…/update-roles`, `…/update-capabilities`, `DELETE /agents/:slug`, `POST …/rotate-key` | `agent.update`, `agent.roles.update`, `agent.capabilities.update`, `agent.delete`, `agent.key.rotate` | G | `@RequiredPermission('ADMIN')` |
| `GET /admin/users`, `POST`, `PATCH …/:id` | `user.read`, `user.create`, `user.update` | G | `@RequiredPermission('ADMIN')` |
| `GET /admin/outbox`, `POST /admin/outbox/:eventId/retry`, `GET /admin/slos` | `outbox.read`, `outbox.retry`, `admin.slo.read` | G | `@RequiredPermission('ADMIN')` |
| `POST /auth/register`, `GET /auth/registration-status`, `POST /auth/login`, `POST /auth/refresh` | `auth.register`, `auth.registration.read`, `session.login`, `session.refresh` | G (public) | `@Public()` (kept) |
| `GET /auth/me`, `POST /auth/logout`, `GET /home` | `auth.me.read`, `session.logout`, `home.read` | G (implicit) | none |
| `GET /me/notifications`, `…/unread-count`, `POST /me/notifications/:id/read`, `POST …/read-all`, `GET /me/notification-preferences`, `PUT …` | `notification.read`, `notification.read`, `notification.mark-read`, `notification.mark-read`, `notification.preference.read`, `notification.preference.update` | G (implicit) | users-only check (kept) |
| `GET /invites/:token`, `POST /invites/:token/accept` | `invite.preview`, `invite.accept` | G (public) | `@Public()` (kept) |

Every `@ProjectPermission`, `@RequiredPermission` and `@ProjectRoles` on these routes is removed, and so is each "Replaces" service or controller check. `GET /projects/:slug/codeintel/impact` keeps its `@ProjectPermission`: code-intel moves in `permissions-p1-enforce-integrations`.

### Ticket transitions

New file `apps/api/src/tickets/state-machine/transition-keys.ts`:

```ts
/** The permission key of a state-machine edge; undefined for a pair with no key (not an edge, or the unreachable IN_PROGRESS -> VERIFIED). */
export function transitionKeyFor(from: TicketStatus, to: TicketStatus): string | undefined;

/** The key(s) that offer each allowedActions entry; an action is offered when the caller holds any of them. */
export const TICKET_ACTION_KEYS: Readonly<Record<TicketAction, readonly string[]>>;
```

| From | To | `transitionKeyFor` |
|:--|:--|:--|
| CREATED | VERIFIED | `ticket.transition.verify` |
| CREATED, VERIFIED | IN_PROGRESS | `ticket.transition.start` |
| CREATED, VERIFIED | REJECTED | `ticket.transition.reject` |
| IN_PROGRESS | VERIFY_FIX | `ticket.transition.fix` |
| VERIFY_FIX | CLOSED | `ticket.transition.verify-fix.approve` |
| VERIFY_FIX | IN_PROGRESS | `ticket.transition.verify-fix.return` |
| any other pair (including IN_PROGRESS → VERIFIED) | | `undefined` |

`TICKET_ACTION_KEYS`: `verify` → `[ticket.transition.verify]`, `start` → `[.start]`, `fix` → `[.fix]`, `verify-fix` → `[.verify-fix.approve, .verify-fix.return]`, `reject` → `[.reject]`, `close` → `[ticket.transition.close]`.

**The edge check.** `TicketTransitionsService.executeTransitionInternal`, after it loads the project and the ticket (the 404s) and before `validateTransition`, computes `transitionKeyFor(ticket.status, toStatus)`. When the key is defined and `permissions.can(principal, key, { projectId: project.id })` is not allowed, it throws 403 `permissions`. When the key is undefined, nothing is checked and `validateTransition` answers 400 as today. So `POST …/verify` on a `VERIFY_FIX` ticket (which `verify` turns into VERIFY_FIX → CLOSED) needs both `ticket.transition.verify` (the route) and `ticket.transition.verify-fix.approve` (the edge).

**`close`.** The close route's key (`ticket.transition.close`) is checked by `RequiresGuard` only; `TicketTransitionsService.close` adds no key check (no other caller reaches it). The controller's `canOverrideClose` call is removed.

**PATCH with `status`.** `TicketsService.update` no longer calls `assertTransitionPermission`. Before any field write it calls a new `TicketTransitionsService.assertTransitionAllowed(projectSlug, ref, toStatus, principal)`. That method loads the project and ticket (404s) and applies the same edge check, without validating the transition, so a refused edge still writes no field. `executeTransitionPublic` drops its `assertTransitionPermission` call, because `executeTransitionInternal` now checks the edge.

**Constructor.** `TicketTransitionsService` gains `PermissionService` as a **required third parameter**, after `txManager` and before the nine `@Optional()` parameters (`.nax/rules/api-core.md`: no `@Optional()` for a required dependency; TypeScript also forbids a required parameter after optional ones). Every positional construction inserts it as the third argument, shifting the rest by one. The `@Optional() caslAbilityFactory` stays last, used only by the legacy `assertTransitionPermission` (ruling 7).

### `allowedActions`

`allowedActions(status, permitted)` in `apps/api/src/tickets/state-machine/allowed-actions.ts` changes its second parameter from `{ canTransition, canClose }` to `permitted: ReadonlySet<TicketAction>`. An action is returned when it is valid from `status` (the existing `ACTION_TARGETS` and `CLOSE_SOURCES` rules) and is in `permitted`. `TicketsService.findByRefWithActions` builds `permitted` as the actions whose `TICKET_ACTION_KEYS` entry has at least one key `can` allows in the ticket's project. `TicketsService` replaces its `KodaCaslAbilityFactory` constructor parameter with `PermissionService`, in the same position (US-004). Its `update` change (calling `assertTransitionAllowed`) is US-003's and needs no new `TicketsService` dependency.

### Ownership checks

- **Comments.** `CommentsService.update` and `delete` keep `assertCommentProjectMembership` (a non-member still gets 404). They then call `permissions.can(principal, 'comment.update' | 'comment.delete', { projectId, resource: { createdBy } })`, where `createdBy` is `{ type: 'USER', id: authorUserId }` or `{ type: 'AGENT', id: authorAgentId }`, or null when neither is set. A refusal is 403 `permissions`. `CommentsService` replaces `KodaCaslAbilityFactory` with `PermissionService`, in the same position.
- **Links.** `TicketLinksService.remove(slug, ref, linkId, principal)` gains the principal. After it finds the link (404 `ticket-links` when absent), it calls `can(principal, 'ticket.link.remove', { projectId, resource: { createdBy } })` with the link's creator. `TicketLinksService` gains `PermissionService` as a required last constructor parameter.

### Link creator

- **Schema.** `TicketLink` gains two nullable columns, `createdByUserId String?` and `createdByAgentId String?`, with no foreign key and no index (like `JobSchedule.repoId`, the value is compared and never joined). A new Prisma migration adds them. Existing rows keep null.
- **Writes.** `TicketLinksService.create(slug, ref, dto, createdBy?: PrincipalRef)` gains an optional last parameter. When it is given and a new link is created, it records `createdByUserId` or `createdByAgentId`. An existing link returned with status 200 is not changed. `POST …/links` passes the caller. The assistant's link tool and the VCS and fleet writers do not pass it, so their links have no creator, and only holders of the full `ticket.link.remove` key (Project Admin, global admins) can remove them.
- **Response.** `TicketLinkResponseDto` is unchanged. The creator is not exposed.

### Other service changes

- `ProjectMembersService.add`, `updateRole` and `remove`, and `ProjectInvitesService.create`, `list`, `resend` and `cancel`, stop calling `assertProjectAdmin`. The route keys replace it.
- `ProjectMembersService.list` keeps `resolveMembership` for `viewerRole`. `canManage` becomes `permissions.can(principal, 'member.add', { projectId }).allowed`, and `ProjectMembersService` gains `PermissionService` as a required last constructor parameter.
- `PATCH /projects/:slug/agents/:agentSlug` keeps its roster lookup. Its `isAdmin` becomes `permissions.can(principal, 'project.agent.update', { projectId }).allowed`, and `isSelf` is unchanged. Neither one: 403 `permissions`.
- `AgentsService.suggestTicket` keeps its owning-agent-or-global-admin check and its agent and project lookups. After the project lookup, the roster check (scoping on) is replaced by a check on the **target agent**: `(await permissions.effectiveKeys({ type: 'AGENT', id: agent.id }, { projectId })).has('agent.pickup')`, 403 `permissions` when false. This keeps today's meaning: the pickup is the target agent's act in the project, so a global ADMIN caller cannot pick up for an agent that holds no `agent.pickup` there (with scoping on, an agent with no source in the project holds no project key). `AgentsService` gains `PermissionService` as a required fifth constructor parameter, after `membership` and before the two `@Optional()` parameters.
- `AgentsService.updateRoles` calls `membership.invalidatePermissions()` after its write.
- `GET /agents/me` refuses a non-agent principal with 403 `agents` in the controller (the old `AgentScope` check answered a generic 403).
- The ticket links controller drops `assertMembership` and its `ProjectsService` dependency. The guards cover it.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| A route key the caller does not hold | 403 `ForbiddenAppException` `permissions`; the handler does not run |
| A route whose `@Requires` names a key absent from the catalog | 403 `permissions` (fail closed) |
| A project-scoped key on a route that resolved no project (`request.projectContext` absent) | 403 `permissions` (fail closed) |
| A public key and no principal | Allowed |
| A principal that holds only `X.own` on a guard-checked route | Passes the guard; the service decides on the row |
| Editing or deleting a comment that someone else wrote, holding only `comment.update.own` / `comment.delete.own` | 403 `permissions`; the comment is unchanged |
| Removing a link created by someone else, or with no creator, holding only `ticket.link.remove.own` | 403 `permissions`; the link stays |
| A transition edge whose key the caller lacks | 403 `permissions` after the ticket lookup; nothing written |
| `PATCH` with `status` whose edge key the caller lacks | 403 `permissions`; no field written |
| A transition pair with no key (not an edge) | No key check; `validateTransition` answers 400 `tickets` as today |
| A legacy `AgentRoleEntry` role with no seeded role | Adds nothing |
| A role row whose entries no longer expand | Adds nothing; logs a warning (existing `addEntries` behaviour) |
| `GET /agents/me` by a user | 403 `agents` |

### Integration

Symbols this feature **reads** (verified at `a32fb345`):
- `PermissionService.can(principal, key, { projectId?, resource? })` returning `{ allowed, reason }`, with reason `'not-owner'` for a held `X.own` and a non-matching creator — `apps/api/src/permissions/permission.service.ts`
- `findCatalogEntry`, `PermissionCatalogEntry` (`scope`, `access`) — `apps/api/src/permissions/catalog.ts`
- `ROLE_KEY_FOR_LEGACY_ROLE` — `apps/api/src/permissions/legacy-project-roles.ts`
- `agentHasProjectAccess(db, agentId, projectId)` — `apps/api/src/permissions/legacy-membership.queries.ts`
- `ProjectMembershipGuard`, `ProjectScopedRequest`, `ProjectContext`, `@CurrentProject()`, `@ProjectSlugFrom` — `apps/api/src/projects/`
- `KodaPrincipal`, `isAgentPrincipal`, `isUserPrincipal` — `apps/api/src/auth/principal/koda-principal.types.ts`
- `AUTH_CFG`, `IAuthConfig.agentProjectScoping` — `apps/api/src/config/auth.config.ts`
- `TRANSITION_RULES`, `validateTransition` — `apps/api/src/tickets/state-machine/ticket-transitions.ts`
- `SystemRoleSeeder` — `apps/api/src/permissions/system-role.seeder.ts`

Symbols this feature **changes**. The baseline only locates the code; implement the target.

| Symbol | Baseline (locate only) | Target |
|:--|:--|:--|
| `PermissionService` | `(roles, bindings, cache)`; `computeKeys` reads bindings and the legacy global admin | `(roles, bindings, cache, authConfig)`; `computeKeys` adds legacy role keys and the baseline fallback |
| `PrismaRoleBindingRepository` | binding reads and writes | plus `findLegacyRoleKeys(principal, projectId, agentScoping): Promise<string[]>` |
| `legacy-membership.queries.ts` | membership queries | plus `legacyRoleKeys(db, principal, projectId, agentScoping): Promise<string[]>` |
| `MembershipService` | binding writes | plus `invalidatePermissions(): Promise<void>` |
| `INVENTORY_SCOPE_ROWS` (catalog) and the inventory TSV | five agent keys `project` | those five `global` |
| `SYSTEM_ROLES` | six project roles without exclusions | each gains `!project.ci-token.read`, `!invite.read` |
| `TicketTransitionsService` | `(ticketRepo, txManager, ...nine optional)`; `executeTransitionPublic` calls `assertTransitionPermission` | `PermissionService` required third; edge check in `executeTransitionInternal`; new `assertTransitionAllowed`; `assertTransitionPermission` unchanged |
| `allowedActions` | `(status, { canTransition, canClose })` | `(status, permitted: ReadonlySet<TicketAction>)` |
| `TicketsService` | `caslAbilityFactory` constructor parameter; `update` calls `assertTransitionPermission` | `PermissionService` in that position; `update` calls `assertTransitionAllowed`; `findByRefWithActions` builds `permitted` |
| `CommentsService` | `caslAbilityFactory` parameter; CASL ownership checks | `PermissionService` in that position; `can` with `resource.createdBy` |
| `TicketLink` (schema) | no creator | `createdByUserId`, `createdByAgentId` nullable |
| `TicketLinksService` | `create(slug, ref, dto)`, `remove(slug, ref, linkId)` | `create(slug, ref, dto, createdBy?)`, `remove(slug, ref, linkId, principal)`; `PermissionService` appended |
| `TicketLinksController` | `(ticketLinksService, projectsService)`, `assertMembership` | `(ticketLinksService)`; guards |
| `ProjectMembersService` | `(membersRepo, access, txManager, membership)` | `PermissionService` appended; no `assertProjectAdmin`; `canManage` from `can` |
| `ProjectInvitesService` | `assertProjectAdmin` in four methods | none |
| `AgentsService` | `(agentRepo, authConfig, txManager, membership, kodaDomainWriter?, agentAuthProvider?)`; roster check in `suggestTicket` | `PermissionService` fifth, before the optionals; `agent.pickup` check; `updateRoles` invalidates |
| `ProjectsController` | `(projectsService, agentsService, ...)` | plus `PermissionService` (the roster PATCH `isAdmin`) |
| The controllers in "Route keys" | legacy decorators | `@Requires` + guards |

## Out of Scope

- Migrating the fleet routes, the assistant and MCP tools (including `TicketTransitionsService.assertTransitionPermission`, which keeps its legacy CASL check for the update-ticket tool), and the KB, memory and thread ownership rules is out of scope (`permissions-p1-enforce-fleet`).
- Migrating the vcs, webhook, skills, code-intel (including `GET /projects/:slug/codeintel/impact`), context and ci-webhook routes is out of scope (`permissions-p1-enforce-integrations`). They keep `@ProjectPermission`, `@ProjectRoles` or `@RequiredPermission`.
- Deleting `KodaCaslAbilityFactory`, `@RequiredPermission` uses outside this feature's routes, `@ProjectPermission`, `@ProjectRoles`, `exemptAgents`, `canOverrideClose`, `ProjectAccessService.assertProjectAdmin`, `canManageMembers`, `withProjectRole`, the legacy union in `PermissionService`, the baseline fallback, and the legacy tables is out of scope (`permissions-p1-cleanup`).
- Folding or removing the catalog keys the design marks as removed (`project.agent.add`, `project.agent.update`, `project.agent.remove`, `member.role.update`, `agent.roles.update`, `fleet.approval.decide.*`) is out of scope (`permissions-p1-cleanup`). This feature uses them on their routes.
- The catalog contract test (every route declares a key, every key is used) and the full role allow/deny matrix test are out of scope (`permissions-p1-cleanup`).
- Deleting the unreachable IN_PROGRESS → VERIFIED rule from `TRANSITION_RULES` is out of scope (`permissions-p1-cleanup`). `transitionKeyFor` gives it no key, and no route reaches it.
- A reopen edge (CLOSED or REJECTED back to an open status) is out of scope (design decision: no reopen edge).
- Approval of any action (`approvalMode`, `ApprovalRequest`, policies) is out of scope (P3). A permitted request runs immediately.
- Recording an actor context or audit entry for these writes is out of scope (P2).
- Web changes are out of scope (`permissions-p1-web`). The web reads `allowedActions`, `canManage` and the 403 responses as before.
- Rewriting the stored permissions of an existing database's unlocked system roles with the new `!project.ci-token.read` and `!invite.read` entries is out of scope. The seeder writes them when it creates a role, and koda-wk is reset when P1 ships.
- Exposing a ticket link's creator in `TicketLinkResponseDto`, and backfilling the creator of existing links, are out of scope.
- Invalidating the permission cache when a test fixture writes a legacy `ProjectMember`, `AgentProject` or `AgentRoleEntry` row directly is out of scope. Only `PATCH /agents/:slug/update-roles` writes `AgentRoleEntry` in production, and it invalidates.
- A legacy `AgentRoleEntry` role outside DEVELOPER, REVIEWER, VERIFIER and TRIAGER, a missing seeded role row for a mapped key, and a missing `member` or `agent` role row for the baseline fallback each add nothing; tests for these cases are out of scope (the seeder creates every system role at boot).
- The fleet RUN dispatch effect (`fleet-job-ticket.effects.ts`) auto-starts the ticket through `TicketTransitionsService.start` with the dispatcher's principal; after this feature that start needs `ticket.transition.start`, and a dispatcher without it leaves the ticket CREATED (the effect already catches and logs the failure). Changing the effect is out of scope (`permissions-p1-enforce-fleet`).
- A test for a role row whose entries no longer expand is out of scope; `PermissionService.addEntries` already logs and skips it (existing behaviour, unchanged).
- New `endpoint.e2e.spec.ts` cases for the migrated routes are out of scope. The route-level 403 and allow cases are pinned by this spec's integration ACs; only the existing agent ticket-delete case changes (see Modifies).
- Anti-escalation on member, invite and roster routes (an agent bound to `project-admin` adding members) is out of scope. These routes write only the legacy role mappings, and the escalation rules live on `/role-bindings`.

## Stories

1. **US-001: `@Requires`, `RequiresGuard`, and the catalog and seeded-role changes** — `Workdir: apps/api` — No dependencies. Adds `requires.decorator.ts` and `requires.guard.ts` in `apps/api/src/permissions/`, re-scopes the five agent-management keys to `global` (catalog and inventory TSV), and adds `!project.ci-token.read` and `!invite.read` to the six non-admin seeded project roles.
2. **US-002: Legacy rows and the baseline count in `PermissionService.can`** — `Workdir: apps/api` — No dependencies. Adds `legacyRoleKeys` (queries file), `PrismaRoleBindingRepository.findLegacyRoleKeys`, the union and baseline fallback in `PermissionService.computeKeys`, the `AUTH_CFG` constructor parameter, and `MembershipService.invalidatePermissions`.
3. **US-003: Ticket transitions check one key per edge** — `Workdir: apps/api` — Depends on US-001, US-002. Adds `transition-keys.ts` (`transitionKeyFor`, `TICKET_ACTION_KEYS`), the edge check in `TicketTransitionsService` (`executeTransitionInternal` and the new `assertTransitionAllowed`; `close` adds no check) with `PermissionService` as its required third constructor parameter, and `@Requires` on the six transition routes and on `PATCH /projects/:slug/tickets/:ref`. Makes `TicketsService.update` call `assertTransitionAllowed` (its constructor is unchanged here). Removes `canOverrideClose` from the close route.
4. **US-004: Ticket create, read, update, delete and assign check keys, and `allowedActions` follows the edge keys** — `Workdir: apps/api` — Depends on US-001, US-002, US-003. Moves the create, list, get, delete and assign ticket routes onto `@Requires`, switches `TicketsService` from `KodaCaslAbilityFactory` to `PermissionService` in the same constructor position, makes `TicketsService.findByRefWithActions` build the permitted actions with `can`, and changes `allowedActions` to take them.
5. **US-005: Comments, labels, ticket labels and watchers check keys** — `Workdir: apps/api` — Depends on US-001, US-002. Moves the comment, label, ticket-label and watch routes onto `@Requires`, and moves `CommentsService.update` and `delete` onto `can` with the comment author.
6. **US-006: Ticket links record their creator and check keys** — `Workdir: apps/api` — Depends on US-001, US-002. Adds the `TicketLink` creator columns and migration, the optional creator on `TicketLinksService.create`, the ownership check in `remove`, and the guards on the links controller.
7. **US-007: Projects, the agent roster and assignees check keys** — `Workdir: apps/api` — Depends on US-001, US-002. Moves the project, roster and assignee routes onto `@Requires`, and the roster self-update onto `can`.
8. **US-008: Members and invites check keys** — `Workdir: apps/api` — Depends on US-001, US-002. Moves the member and invite routes onto `@Requires`, drops `assertProjectAdmin` from `ProjectMembersService` and `ProjectInvitesService`, and computes `canManage` with `can`.
9. **US-009: Agent routes check keys** — `Workdir: apps/api` — Depends on US-001, US-002, US-004. (US-004 moves `POST /projects/:slug/tickets` onto `ticket.create`, which AC 6 relies on to observe the role change.) Moves the `/agents` routes onto `@Requires`, the pickup check onto `agent.pickup`, and makes `updateRoles` invalidate the permission cache.
10. **US-010: Admin, auth, home, notification and public invite routes declare keys** — `Workdir: apps/api` — Depends on US-001, US-002. Moves the admin users, outbox and SLO routes onto global keys, and declares the public and implicit keys on the auth (`auth.controller.ts`), home (`home/home.controller.ts`), `/me` notification (`notifications/me-notifications.controller.ts`) and public invite (`projects/invites/public-invites.controller.ts`) routes. Their existing principal-type refusals (home and notifications refuse agents) are kept.

This is one capability, enforcing keys on the core surface, at ten stories. The user confirmed it as one feature on 2026-10-19.

### Context Files

**US-001**
- `apps/api/src/permissions/permission.service.ts` — `can` and its `reason` values, which the guard reads
- `apps/api/src/permissions/catalog.ts` — `findCatalogEntry`, `INVENTORY_SCOPE_ROWS`
- `apps/api/src/permissions/system-roles.ts` — the seeded roles edited here
- `apps/api/src/projects/project-membership.guard.ts` — the guard pattern and `request.projectContext`
- `apps/api/src/projects/project-context.ts` — `ProjectScopedRequest`

**US-002**
- `apps/api/src/permissions/permission.service.ts` — `computeKeys`, the method extended here
- `apps/api/src/permissions/prisma-role-binding.repository.ts` — `findEffectiveBindings`, the pattern for the new read
- `apps/api/src/permissions/legacy-membership.queries.ts` — `agentHasProjectAccess` and the query-function pattern
- `apps/api/src/permissions/legacy-project-roles.ts` — `ROLE_KEY_FOR_LEGACY_ROLE`
- `apps/api/src/permissions/membership.service.ts` — the service gaining `invalidatePermissions`

**US-003**
- `apps/api/src/tickets/state-machine/ticket-transitions.service.ts` — the service changed here
- `apps/api/src/tickets/state-machine/ticket-transitions.ts` — `TRANSITION_RULES`
- `apps/api/src/tickets/tickets.controller.ts` — the transition and PATCH routes, and the close route's `canOverrideClose` call
- `apps/api/src/tickets/tickets.service.ts` — `update` and the constructor changed here
- `apps/api/src/permissions/requires.guard.ts` — created by US-001, used here

**US-004**
- `apps/api/src/tickets/tickets.controller.ts` — the ticket routes
- `apps/api/src/tickets/tickets.service.ts` — `update`, `findByRefWithActions`
- `apps/api/src/tickets/state-machine/allowed-actions.ts` — `allowedActions`
- `apps/api/src/tickets/state-machine/transition-keys.ts` — created by US-003, used here
- `apps/api/src/permissions/requires.guard.ts` — created by US-001, used here

**US-005**
- `apps/api/src/comments/comments.controller.ts` — the comment routes
- `apps/api/src/comments/comments.service.ts` — `update`, `delete`
- `apps/api/src/labels/labels.controller.ts` — the label and ticket-label routes
- `apps/api/src/notifications/ticket-watch.controller.ts` — the watch routes
- `apps/api/src/permissions/requires.guard.ts` — created by US-001, used here

**US-006**
- `apps/api/src/ticket-links/ticket-links.controller.ts` — the link routes
- `apps/api/src/ticket-links/ticket-links.service.ts` — `create`, `remove`
- `apps/api/src/ticket-links/prisma-ticket-link.repository.ts` — `createLink`, `findLinkByIdAndTicket`
- `apps/api/prisma/schema.prisma` — `TicketLink`
- `apps/api/src/ticket-links/domain/ticket-link.domain.ts` — `TicketLinkDomain`, which gains the creator fields read by the ownership check

**US-007**
- `apps/api/src/projects/projects.controller.ts` — the project and roster routes
- `apps/api/src/projects/assignees/project-assignees.controller.ts` — the assignee route
- `apps/api/src/projects/project-membership.guard.ts` — the resolver the new guard runs after
- `apps/api/src/projects/projects.service.ts` — `assertProjectAdmin`, `findMembershipRole`, which this story stops calling
- `apps/api/src/permissions/requires.guard.ts` — created by US-001, used here

**US-008**
- `apps/api/src/projects/members/project-members.controller.ts` — the member routes
- `apps/api/src/projects/members/project-members.service.ts` — `list`, `add`, `updateRole`, `remove`
- `apps/api/src/projects/invites/project-invites.controller.ts` — the invite routes
- `apps/api/src/projects/invites/project-invites.service.ts` — `create`, `list`, `resend`, `cancel`
- `apps/api/src/permissions/requires.guard.ts` — created by US-001, used here

**US-009**
- `apps/api/src/agents/agents.controller.ts` — the agent routes
- `apps/api/src/agents/agents.service.ts` — `suggestTicket`, `updateRoles`
- `apps/api/src/permissions/membership.service.ts` — `invalidatePermissions`, added by US-002
- `apps/api/src/permissions/permission.service.ts` — `can`, which `suggestTicket` calls for `agent.pickup`
- `apps/api/src/permissions/requires.guard.ts` — created by US-001, used here

**US-010**
- `apps/api/src/users/admin-users.controller.ts` — the admin user routes
- `apps/api/src/outbox/admin.controller.ts` — the outbox routes
- `apps/api/src/monitoring/slo-dashboard.controller.ts` — the SLO route
- `apps/api/src/auth/auth.controller.ts` — the auth routes
- `apps/api/src/permissions/requires.guard.ts` — created by US-001, used here

### Creates

**US-001**
- `apps/api/src/permissions/requires.decorator.ts`
- `apps/api/src/permissions/requires.guard.ts`

**US-003**
- `apps/api/src/tickets/state-machine/transition-keys.ts`

**US-006**
- `apps/api/prisma/migrations/20261028090000_ticket_link_creator/migration.sql`

### Modifies

**US-001**
- `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` — the `catalog_scope` column of the rows for PATCH /agents/:slug (agent.update), PATCH /agents/:slug/update-roles (agent.roles.update), PATCH /agents/:slug/update-capabilities (agent.capabilities.update), DELETE /agents/:slug (agent.delete) and POST /agents/:slug/rotate-key (agent.key.rotate) changes from project to global. The invariant: catalog.spec.ts still proves the TSV and INVENTORY_SCOPE_ROWS agree, and no other column or row changes.

**US-002**
- `apps/api/src/permissions/permission.service.spec.ts` — it constructs PermissionService with three arguments. The replacing invariant: a fourth authConfig argument ({ agentProjectScoping: true } unless a test says otherwise) is passed, and every existing assertion is unchanged.
- `apps/api/src/permissions/role-admin.service.spec.ts` — it constructs PermissionService with three arguments. The replacing invariant: the fourth authConfig argument is passed, and every existing assertion is unchanged.
- `apps/api/src/permissions/membership.service.spec.ts` — it constructs PermissionService with three arguments. The replacing invariant: the fourth authConfig argument is passed, and every existing assertion is unchanged.
- `apps/api/test/integration/permissions/membership-service.integration.spec.ts` — it constructs PermissionService with three arguments. The replacing invariant: the fourth authConfig argument is passed, and every existing assertion is unchanged.
- `apps/api/src/permissions/test-helpers/in-memory-permissions.ts` — its binding repository double lacks findLegacyRoleKeys, which computeKeys now calls. The replacing invariant: the double answers [] (no legacy rows), so the existing PermissionService unit assertions are unchanged.

**US-003**
- `apps/api/src/tickets/state-machine/ticket-transitions.service.spec.ts` — its providers give KodaCaslAbilityFactory and no PermissionService, its M2 block asserts executeTransitionPublic evaluates the CASL TRANSITION ability, and its four positional constructions (the 2-argument "fails closed" one and the three vcs-style ones) lack the new third argument. The replacing invariant: a PermissionService double is provided (in the TestingModule and inserted as the third argument of each positional construction, shifting the rest), executeTransitionPublic and the transition methods are refused with 403 permissions when the double refuses the edge key from transitionKeyFor, and assertTransitionPermission keeps its CASL assertions.
- `apps/api/src/tickets/tickets.service.spec.ts` — its providers build the real TicketTransitionsService, which now needs PermissionService, and the update tests expect assertTransitionPermission. The replacing invariant: a PermissionService double is provided, KodaCaslAbilityFactory stays provided (TicketsService still takes it until US-004), and update with a status calls assertTransitionAllowed before any field write; the findByRefWithActions rows are left to US-004.
- `apps/api/src/tickets/tickets.controller.spec.ts` — the #144 block asserts PROJECT_PERMISSION_KEY metadata on update and the six transition handlers, and the close block expects 403 from the controller for a DEVELOPER and an agent. The replacing invariant: those handlers carry REQUIRES_METADATA with the keys in the spec's route table (verify-fix with mode any), and the close handler no longer refuses by role (the key check is the guard's).
- `apps/api/test/integration/vcs/auto-create-pr-on-verified.integration.spec.ts` — it constructs TicketTransitionsService positionally twice (3 arguments near line 149, 8 near line 382) without the new third argument, and both paths run verify. The replacing invariant: an allow-all PermissionService double is inserted as the third argument of both constructions, shifting the rest, and the PR-creation assertions are unchanged.
- `apps/api/test/integration/memory/outbox-envelope.integration.spec.ts` — it constructs TicketTransitionsService positionally without the new third argument. The replacing invariant: an allow-all PermissionService double is inserted as the third argument, shifting the rest, and the envelope assertions are unchanged; its TicketsService construction is left to US-004.
- `apps/api/test/integration/tickets/tickets-status-update.integration.spec.ts` — its providers build TicketTransitionsService without PermissionService, so DI fails. The replacing invariant: PermissionService is provided (the real one with seeded roles, or an allow-all double), and the status-update assertions keep their outcomes for the roles they use, except where a legacy role's keys now differ, which the test re-expresses as the new key outcome.
- `apps/api/test/integration/tickets/ticket-tenancy.integration.spec.ts` — its providers build TicketTransitionsService without PermissionService, so DI fails. The replacing invariant: PermissionService is provided, and every cross-project tenancy assertion is unchanged.
- `apps/api/test/integration/outbox/producer-atomicity.integration.spec.ts` — its providers build TicketTransitionsService without PermissionService, so DI fails. The replacing invariant: PermissionService is provided, and every atomicity assertion is unchanged.
- `apps/api/test/integration/agent-permissions/tickets-agent-permissions.integration.spec.ts` — its providers build TicketTransitionsService without PermissionService, and it asserts agent outcomes from agentRoles through CASL. The replacing invariant: PermissionService is provided, and each agent case asserts the outcome of the agent's keys (its AgentRoleEntry roles as project roles in its roster project, per the legacy union).
- `apps/api/src/projects/project-membership.guard.routes.spec.ts` — it registers TicketsController and ProjectsController with no PermissionService provider, so RequiresGuard fails DI at init. The replacing invariant: a PermissionService double is provided (allowing the keys each case's principal held under the old checks), and the guard's project-resolution assertions are unchanged.
- `apps/api/test/integration/tickets/ticket-transition-race.integration.spec.ts` — its TestingModule provides TicketTransitionsService without PermissionService, so DI fails. The replacing invariant: an allow-all PermissionService double is provided, and the race assertions (one winner, one 409) are unchanged.
- `apps/api/test/integration/rag/rag-close-to-search.integration.spec.ts` — its TestingModule provides TicketTransitionsService without PermissionService, so DI fails. The replacing invariant: an allow-all PermissionService double is provided, and the close-then-search assertions are unchanged.
- `apps/api/src/tickets/state-machine/ticket-transitions.autoindex.spec.ts` — it constructs TicketTransitionsService with (repo, txManager, ragService), so ragService lands in the new third slot. The replacing invariant: a PermissionService double is inserted as the third argument and ragService moves to the fourth, and both autoIndexTicket assertions are unchanged.
- `apps/api/test/integration/projects/project-role-permissions.integration.spec.ts` — its close-override row expects 403 for a DEVELOPER. The replacing invariant: a DEVELOPER is allowed to close (Developer holds ticket.transition.close) and a VIEWER is still refused.

**US-004**
- `apps/api/src/tickets/tickets.service.spec.ts` — its providers give TicketsService KodaCaslAbilityFactory, and its findByRefWithActions rows expect ['start','reject'] for a DEVELOPER and for an agent REVIEWER from the CASL TRANSITION ability. The replacing invariant: TicketsService gets the PermissionService double in the factory's slot; allowedActions follows TICKET_ACTION_KEYS through the PermissionService double, so a DEVELOPER on CREATED gets ['verify','start','reject'] and a REVIEWER on CREATED gets [].
- `apps/api/src/tickets/tickets.controller.spec.ts` — the #144 block asserts PROJECT_PERMISSION_KEY metadata on create, softDelete and assign. The replacing invariant: those handlers carry REQUIRES_METADATA with ticket.create, ticket.delete and ticket.assign.
- `apps/api/test/integration/memory/outbox-envelope.integration.spec.ts` — it constructs TicketsService with new KodaCaslAbilityFactory() in the slot that becomes PermissionService. The replacing invariant: an allow-all PermissionService double is passed in that slot, and the envelope assertions are unchanged.
- `apps/api/src/tickets/state-machine/allowed-actions.spec.ts` — it calls allowedActions with { canTransition, canClose }. The replacing invariant: it passes a ReadonlySet of permitted TicketAction values, and the validity rules per status are unchanged.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — its Agent Permissions block runs after the update-roles case (near line 1118) has set the agent's roles to REVIEWER only, and AC-5 (agent POST label, 201) and AC-6 (agent DELETE ticket, 200) assume the old any-agent CASL rights. The replacing invariant: the block first restores the agent's roles to ['DEVELOPER'] through PATCH /api/agents/:slug/update-roles; AC-5 then still answers 201 (Developer holds label.create); AC-6 answers 403 permissions (Developer has no ticket.delete), and a project-admin caller deletes the ticket instead.
- `apps/api/test/integration/projects/project-role-permissions.integration.spec.ts` — its "GET ticket returns allowedActions for project DEVELOPER" row expects ['start','reject']. The replacing invariant: the DEVELOPER row includes every action valid from the ticket's status that Developer holds a key for.

**US-005**
- `apps/api/src/comments/comments.service.spec.ts` — its providers give KodaCaslAbilityFactory and no PermissionService, and the #144 block mocks createForUser. The replacing invariant: a PermissionService double is provided in the factory's slot, update and delete call can with comment.update / comment.delete, the project id and resource.createdBy from the author, and the not-member 404 assertions are unchanged.
- `apps/api/src/comments/comments.controller.spec.ts` — its providers have no PermissionService, so RequiresGuard fails DI at compile. The replacing invariant: a PermissionService double is provided, and the handler assertions are unchanged.
- `apps/api/src/labels/labels.controller.spec.ts` — its providers have no PermissionService (RequiresGuard fails DI at compile), and it asserts PROJECT_PERMISSION_KEY metadata on the five label handlers. The replacing invariant: a PermissionService double is provided; they carry REQUIRES_METADATA with label.create, label.update, label.delete, ticket.label.assign and ticket.label.remove, and findByProjectFromHttp with label.read.
- `apps/api/test/integration/projects/project-role-permissions.integration.spec.ts` — its update-label row expects 403 for a DEVELOPER. The replacing invariant: a DEVELOPER may update a label (Developer holds label.update) and a VIEWER is still refused.

**US-006**
- `apps/api/src/ticket-links/ticket-links.controller.spec.ts` — it constructs the controller with ProjectsService and asserts assertProjectMembership calls and rejections, and the controller now gets ProjectMembershipGuard and RequiresGuard. The replacing invariant: the harness provides PermissionService and ProjectAccessService doubles for the guards, the controller takes only TicketLinksService, create passes the caller as creator, remove passes the principal, and membership is the guards' (not asserted here).
- `apps/api/test/integration/tickets/ticket-tenancy.integration.spec.ts` — it calls ticketLinksService.remove with three arguments (near line 228), which type-check:spec rejects once remove takes the principal. The replacing invariant: a principal is passed as the fourth argument, and the cross-project 404 assertion is unchanged.
- `apps/api/src/ticket-links/ticket-links.service.spec.ts` — it calls remove(slug, ref, linkId) and constructs the service with the repository only. The replacing invariant: a PermissionService double is appended, remove takes the principal and is refused with 403 permissions when the double refuses ticket.link.remove for the link's creator, and the not-found assertions are unchanged.

**US-007**
- `apps/api/src/projects/projects.module.spec.ts` — its providers have no PermissionService, so RequiresGuard on ProjectsController fails DI at compile. The replacing invariant: a PermissionService double is provided and the module compiles.
- `apps/api/src/projects/projects.controller.spec.ts` — its providers have no PermissionService (RequiresGuard and the controller now need it); its getProjectAgents rows ("US-002 AC7" non-member forbidden, the assertProjectMembership call assertion) rely on the controller's own membership call, which moves to the guards; and its H4 rows authorise updateProjectAgent through findMembershipRole returning 'ADMIN'. The replacing invariant: a PermissionService double is provided; the getProjectAgents membership rows and the assertProjectMembership and findMembershipRole call assertions are removed; the H4 allow and forbid rows are re-expressed against the double's answer for project.agent.update (allowed admin, refused non-admin, the agent itself still allowed); every other handler assertion is unchanged.
- `apps/api/src/projects/projects-brief.routes.spec.ts` — it serves ProjectsController routes with no PermissionService. The replacing invariant: a PermissionService double allowing the global admin caller is provided, and the brief assertions are unchanged.
- `apps/api/test/unit/projects/projects-conflict-responses.spec.ts` — it serves ProjectsController routes with no PermissionService and no principal, so RequiresGuard refuses them. The replacing invariant: the harness provides a PermissionService double that allows the route keys and a principal on the request, and the 409 conflict assertions are unchanged.
- `apps/api/src/projects/assignees/project-assignees.module.spec.ts` — its local FakeGlobalsModule lacks PermissionService. The replacing invariant: the harness also provides a PermissionService double and the module compiles.

**US-008**
- `apps/api/src/projects/members/project-members.service.spec.ts` — it constructs ProjectMembersService with four parameters and asserts writes are gated by access.assertProjectAdmin. The replacing invariant: a PermissionService double is passed fifth, writes no longer call assertProjectAdmin, and canManage comes from the double's answer for member.add.
- `apps/api/src/projects/members/project-members.module.spec.ts` — its local FakeGlobalsModule lacks PermissionService. The replacing invariant: the harness also provides a PermissionService double and the module compiles.
- `apps/api/src/projects/invites/project-invites.service.spec.ts` — its AC-2 asserts a non-admin is refused through assertProjectAdmin. The replacing invariant: the service methods no longer call assertProjectAdmin (the route key refuses non-admins), and the other invite assertions are unchanged.

**US-009**
- `apps/api/src/agents/agents.service.spec.ts` — it builds AgentsService through Test.createTestingModule with no PermissionService provider; its local membership double lacks invalidatePermissions, which updateRoles now calls; and its pickup AC13/AC14 rows assert the isOnProjectRoster call (403 when not rostered, not called when scoping is off). The replacing invariant: a PermissionService double is provided; the local membership double gains invalidatePermissions; updateRoles asserts invalidatePermissions was called after the write; the AC13/AC14 rows are re-expressed against the double's effectiveKeys answer for the target agent (403 permissions without agent.pickup, allowed with it) and the isOnProjectRoster assertions are removed; every other assertion is unchanged.
- `apps/api/src/agents/agents-create.service.spec.ts` — it builds the real AgentsService in a TestingModule with a MembershipService mock and no PermissionService, so DI fails. The replacing invariant: a PermissionService double is provided, and the create assertions are unchanged.
- `apps/api/src/agents/agents-project-roster.service.spec.ts` — it constructs AgentsService positionally. The replacing invariant: a PermissionService double is passed as the fifth argument (before the optional parameters), and the roster assertions are unchanged.
- `apps/api/src/common/test-helpers/global-stubs.module.ts` — mockMembershipService lacks invalidatePermissions, which AgentsService.updateRoles now calls. The replacing invariant: it gains invalidatePermissions resolving undefined, and every module spec importing GlobalStubsModule still compiles.
- `apps/api/test/integration/agents/agents-create-rollback.integration.spec.ts` — it injects a principal with role ADMIN and id user-admin through a test guard but creates no User row, so PermissionService.can finds no legacy admin and refuses agent.create (403 instead of the expected 500). The replacing invariant: the test creates the user-admin User row with role ADMIN (or a global admin binding for it) before the requests, and both rollback assertions are unchanged.
- `apps/api/src/agents/agents.controller.spec.ts` — its providers have no PermissionService, so RequiresGuard on AgentsController fails DI at compile. The replacing invariant: a PermissionService double is provided, and the handler assertions are unchanged.
- `apps/api/src/agents/agents-pickup.routes.spec.ts` — it serves AgentsController with no PermissionService, and its roster rows (around lines 268-294: unrostered target 403, scoping off admits) read the roster. The replacing invariant: a PermissionService double is provided; the roster rows are re-expressed against the double's effectiveKeys answer for the target agent holding agent.pickup; the self-or-admin, 400 and 404 assertions are unchanged.
- `apps/api/src/agents/agents-create.routes.spec.ts` — it serves AgentsController with no PermissionService. The replacing invariant: a PermissionService double allowing agent.create for the admin caller is provided, and the create assertions are unchanged.
- `apps/api/src/agents/agent-create-canonical-dto.routes.spec.ts` — it serves AgentsController with no PermissionService. The replacing invariant: a PermissionService double allowing agent.create is provided, and the DTO assertions are unchanged.

**US-010**
- `apps/api/src/users/admin-users.controller.spec.ts` — it asserts PERMISSION_KEY 'ADMIN' on list, create and update. The replacing invariant: those handlers carry REQUIRES_METADATA with user.read, user.create and user.update.
- `apps/api/src/users/users.module.spec.ts` — its local FakeGlobalsModule lacks PermissionService. The replacing invariant: the harness also provides a PermissionService double and the module compiles.
- `apps/api/src/outbox/admin.controller.spec.ts` — its providers have no PermissionService. The replacing invariant: a PermissionService double is provided, and the handler assertions are unchanged.
- `apps/api/src/auth/auth.controller.spec.ts` — its providers have no PermissionService, so RequiresGuard on AuthController fails DI at compile. The replacing invariant: a PermissionService double is provided, and the auth assertions are unchanged.

### Seams

- **US-001 → US-003..US-010:** `RequiresGuard` and `@Requires` are reached from the routes each later story decorates, and each of those stories has a refusal AC with error code `permissions` at the HTTP route (US-003 AC 5, US-004 AC 1, US-005 AC 2, US-006 AC 9, US-007 AC 4, US-008 AC 1, US-009 AC 1, US-010 AC 1) and an allow AC on the same surface. A route that still carries a legacy decorator would answer a different code or outcome for a binding-only principal of a non-legacy role (reviewer, triager, approver), which these ACs use.
- **US-001 → US-007, US-008:** the seeded `!project.ci-token.read` and `!invite.read` entries are observed at the routes: US-007 AC 6 and US-008 AC 6.
- **US-002 → US-003..US-009:** the legacy union is reached through routes whose principal has only legacy rows: US-003 ACs 10 and 11, US-004 ACs 3 and 7, US-005 ACs 7 and 11, US-006 AC 2, US-008 AC 10, US-009 ACs 6, 8, 9 and 10. The baseline fallback is reached at US-009 AC 2 and US-010 AC 8.
- **US-002 → US-009:** `MembershipService.invalidatePermissions` is reached from `PATCH /agents/:slug/update-roles` (US-009 AC 6), whose next request must see the new role.
- **US-003 → US-004:** `TICKET_ACTION_KEYS` is consumed by `findByRefWithActions`, observed at `GET /projects/:slug/tickets/:ref` (US-004 ACs 10, 11 and 12).
- **Altitude note.** US-001 tests the guard as a unit with a stubbed `PermissionService`, and US-002 tests `PermissionService.can` directly. Neither has a production caller until US-003, and the route ACs in US-003..US-010 cover the wiring.

## Acceptance Criteria

Fixture wording: "a user whose only source in `p1` is a `<role>` binding" means a user with that `RoleBinding` in project `p1`, no `ProjectMember` row, and no global admin role. DB-backed tests seed the system roles first (ruling 1). Agent project scoping is on unless an AC says otherwise.

### US-001: `@Requires`, `RequiresGuard`, and the catalog and seeded-role changes (`Workdir: apps/api`)

1. [unit] A handler decorated with `@Requires('ticket.read')` exposes, under `REQUIRES_METADATA` through Nest's `Reflector`, the metadata `{ keys: ['ticket.read'], mode: 'all', enforcedBy: 'guard' }`.
2. [unit] `RequiresGuard.canActivate` for a handler with no `@Requires` metadata resolves `true` without calling `PermissionService.can`.
3. [unit] `RequiresGuard.canActivate` for `@Requires('ticket.read')`, a user principal and `request.projectContext.project.id` `'p1'` calls `PermissionService.can(principal, 'ticket.read', { projectId: 'p1' })` and resolves `true` when it answers `allowed` true.
4. [unit] The same call rejects with `ForbiddenAppException` whose error code is `permissions` when `can` answers `{ allowed: false, reason: 'not-granted' }`.
5. [unit] For `@Requires(['ticket.update', 'ticket.assign'])` (mode `all`), `RequiresGuard.canActivate` rejects with `ForbiddenAppException` `permissions` when `can` allows `ticket.update` and refuses `ticket.assign`.
6. [unit] For `@Requires(['ticket.transition.verify-fix.approve', 'ticket.transition.verify-fix.return'], { mode: 'any' })`, `RequiresGuard.canActivate` resolves `true` when `can` refuses the first key and allows the second.
7. [unit] For `@Requires('comment.update', { enforcedBy: 'service' })`, `RequiresGuard.canActivate` resolves `true` without calling `PermissionService.can`.
8. [unit] For `@Requires('no.such.key')`, `RequiresGuard.canActivate` rejects with `ForbiddenAppException` `permissions` without calling `PermissionService.can`.
9. [unit] For `@Requires('ticket.read')` (a project-scoped key) on a request with no `projectContext`, `RequiresGuard.canActivate` rejects with `ForbiddenAppException` `permissions` without calling `PermissionService.can`.
10. [unit] For `@Requires('session.login')` (a public key) on a request with no `user`, `RequiresGuard.canActivate` resolves `true`.
11. [unit] For `@Requires('agent.read')` (a role key) on a request with no `user`, `RequiresGuard.canActivate` rejects with `ForbiddenAppException` `permissions` without calling `PermissionService.can`.
12. [unit] For `@Requires('comment.delete')` with `projectContext` `p1`, `RequiresGuard.canActivate` resolves `true` when `can` answers `{ allowed: false, reason: 'not-owner' }`.
13. [unit] `findCatalogEntry(key).scope` is `'global'` for each of `agent.update`, `agent.delete`, `agent.key.rotate`, `agent.capabilities.update` and `agent.roles.update`, and is `'project'` for `agent.pickup`.
14. [integration] After `SystemRoleSeeder.onApplicationBootstrap()` on a reset database, `PermissionService.can` for a user whose only source in `p1` is a `developer` binding refuses `project.ci-token.read` and `invite.read` in `p1`, and allows `ticket.read` in `p1`.
15. [integration] After the same seeding, `PermissionService.can` for a user whose only source in `p1` is a `viewer` binding refuses `project.ci-token.read` and `invite.read` in `p1`, and for a user whose only source in `p1` is a `project-admin` binding allows both.

### US-002: Legacy rows and the baseline count in `PermissionService.can` (`Workdir: apps/api`)

1. [integration] For a user with no binding and a legacy `ProjectMember` row of role `DEVELOPER` in `p1`, `PermissionService.can(<user principal>, 'ticket.create', { projectId: p1 })` answers `allowed` true.
2. [integration] For a user with no binding and a legacy `ProjectMember` row of role `VIEWER` in `p1`, `can(..., 'ticket.create', { projectId: p1 })` answers `allowed` false and `can(..., 'comment.create', { projectId: p1 })` answers `allowed` true.
3. [integration] For a user with no binding and a legacy `ProjectMember` row of role `ADMIN` in `p1`, `can(..., 'ticket.delete', { projectId: p1 })` answers `allowed` true.
4. [integration] For a user with no binding and a legacy `ProjectMember` row of stored role `AGENT` in `p1`, `can(..., 'comment.create', { projectId: p1 })` answers `allowed` true and `can(..., 'ticket.create', { projectId: p1 })` answers `allowed` false.
5. [integration] For a user with a legacy `DEVELOPER` row in `p1` only, `can(..., 'ticket.create', { projectId: p2 })` answers `allowed` false.
6. [integration] For an agent with a legacy `AgentProject` row in `p1` and no `AgentRoleEntry`, `can(<agent principal>, 'comment.create', { projectId: p1 })` answers `allowed` true and `can(..., 'ticket.create', { projectId: p1 })` answers `allowed` false.
7. [integration] For an agent with a legacy `AgentProject` row in `p1` and an `AgentRoleEntry` `DEVELOPER`, `can(..., 'ticket.create', { projectId: p1 })` answers `allowed` true and `can(..., 'ticket.delete', { projectId: p1 })` answers `allowed` false.
8. [integration] For an agent whose only source in `p1` is a `viewer` binding and that has an `AgentRoleEntry` `DEVELOPER`, `can(..., 'ticket.create', { projectId: p1 })` answers `allowed` true.
9. [integration] For an agent with an `AgentRoleEntry` `REVIEWER` and no source in `p2`, `can(..., 'ticket.transition.close', { projectId: p2 })` answers `allowed` false.
10. [integration] With `PermissionService` constructed with `authConfig.agentProjectScoping` `false`, an agent with an `AgentRoleEntry` `DEVELOPER` and no source in `p2` gets `allowed` true from `can(..., 'ticket.create', { projectId: p2 })`.
11. [integration] For a user with no binding and no legacy row, `can(<user principal>, 'agent.read')` answers `allowed` true, and `can(<user principal>, 'project.create')` answers `allowed` false.
12. [integration] For an agent with no binding and no legacy row, `can(<agent principal>, 'agent.read')` answers `allowed` true.
13. [integration] For an agent with a legacy `AgentProject` row in `p1` and an `AgentRoleEntry` `TRIAGER`, `can(..., 'ticket.label.assign', { projectId: p1 })` answers `allowed` true and `can(..., 'ticket.create', { projectId: p1 })` answers `allowed` false.
14. [integration] For an agent with a legacy `AgentProject` row in `p1` and an `AgentRoleEntry` `VERIFIER`, `can(..., 'ticket.transition.verify', { projectId: p1 })` answers `allowed` true and `can(..., 'ticket.transition.start', { projectId: p1 })` answers `allowed` false.
15. [integration] For an agent with a legacy `AgentProject` row in `p1` and no `AgentRoleEntry`, after `can(..., 'ticket.create', { projectId: p1 })` answered `allowed` false, creating an `AgentRoleEntry` `DEVELOPER` for it and calling `MembershipService.invalidatePermissions()` makes the next identical `can` call answer `allowed` true.

### US-003: Ticket transitions check one key per edge (`Workdir: apps/api`)

1. [unit] `transitionKeyFor` from `apps/api/src/tickets/state-machine/transition-keys.ts` returns `'ticket.transition.verify'` for CREATED → VERIFIED, `'ticket.transition.start'` for VERIFIED → IN_PROGRESS, `'ticket.transition.reject'` for CREATED → REJECTED, `'ticket.transition.fix'` for IN_PROGRESS → VERIFY_FIX, `'ticket.transition.verify-fix.approve'` for VERIFY_FIX → CLOSED and `'ticket.transition.verify-fix.return'` for VERIFY_FIX → IN_PROGRESS.
2. [unit] `transitionKeyFor` returns `undefined` for IN_PROGRESS → VERIFIED and for CREATED → CLOSED.
3. [integration] A user whose only source in `p1` is a `reviewer` binding gets 200 from `POST /projects/p1/tickets/<ref>/verify-fix?approve=true` with a `body` on a VERIFY_FIX ticket, and the ticket becomes CLOSED.
4. [integration] The same reviewer gets 200 from `POST /projects/p1/tickets/<ref>/verify-fix` (no `approve`) with a `body` on a VERIFY_FIX ticket, and the ticket becomes IN_PROGRESS.
5. [integration] The same reviewer gets 403 with error code `permissions` from `POST /projects/p1/tickets/<ref>/verify` on a CREATED ticket, and the ticket stays CREATED.
6. [integration] A user whose only source in `p1` is a `triager` binding gets 403 with error code `permissions` from `POST /projects/p1/tickets/<ref>/verify` on a VERIFY_FIX ticket (the edge needs `ticket.transition.verify-fix.approve`), and the ticket stays VERIFY_FIX.
7. [integration] A user whose only source in `p1` is a `triager` binding gets 403 with error code `permissions` from `POST /projects/p1/tickets/<ref>/verify-fix?approve=true` with a `body`.
8. [integration] A user whose only source in `p1` is a `developer` binding gets 200 from `POST /projects/p1/tickets/<ref>/close` with a `body` on an IN_PROGRESS ticket, and the ticket becomes CLOSED.
9. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `POST /projects/p1/tickets/<ref>/close` with a `body` on an IN_PROGRESS ticket.
10. [integration] An agent with a legacy `AgentProject` row in `p1` and an `AgentRoleEntry` `REVIEWER` gets 403 with error code `permissions` from `POST /projects/p1/tickets/<ref>/start` on a VERIFIED ticket.
11. [integration] An agent with a legacy `AgentProject` row in `p1` and an `AgentRoleEntry` `DEVELOPER` gets 200 from `POST /projects/p1/tickets/<ref>/fix` with a `body` on an IN_PROGRESS ticket, and the ticket becomes VERIFY_FIX.
12. [integration] A user whose only source in `p1` is a `developer` binding gets 200 from `PATCH /projects/p1/tickets/<ref>` with `{ status: 'IN_PROGRESS' }` on a CREATED ticket, and the ticket becomes IN_PROGRESS.
13. [integration] A user whose only source in `p1` is a `triager` binding (which holds `ticket.update` but not `ticket.transition.start`) gets 403 with error code `permissions` from `PATCH /projects/p1/tickets/<ref>` with `{ status: 'IN_PROGRESS', title: 'Renamed' }` on a CREATED ticket, and the ticket keeps its title and status.
14. [integration] A user whose only source in `p1` is a `developer` binding gets 400 from `PATCH /projects/p1/tickets/<ref>` with `{ status: 'CLOSED' }` on an IN_PROGRESS ticket (no edge, so no key check).

### US-004: Ticket create, read, update, delete and assign check keys, and `allowedActions` follows the edge keys (`Workdir: apps/api`)

1. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `POST /projects/p1/tickets`, and no ticket is created.
2. [integration] A user whose only source in `p1` is a `developer` binding gets 201 from `POST /projects/p1/tickets`.
3. [integration] An agent with a legacy `AgentProject` row in `p1` and no `AgentRoleEntry` gets 403 with error code `permissions` from `POST /projects/p1/tickets`.
4. [integration] A user whose only source in `p1` is a `viewer` binding gets 200 from `GET /projects/p1/tickets` and from `GET /projects/p1/tickets/<ref>`.
5. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `DELETE /projects/p1/tickets/<ref>`, and the ticket is not soft-deleted.
6. [integration] A user whose only source in `p1` is a `project-admin` binding gets 200 from `DELETE /projects/p1/tickets/<ref>`, and the ticket is soft-deleted.
7. [integration] An agent with a legacy `AgentProject` row in `p1` and an `AgentRoleEntry` `DEVELOPER` gets 403 with error code `permissions` from `DELETE /projects/p1/tickets/<ref>`.
8. [integration] A user whose only source in `p1` is a `triager` binding gets 200 from `PATCH /projects/p1/tickets/<ref>` with `{ title: 'Renamed' }`, and gets 200 from `POST /projects/p1/tickets/<ref>/assign` with `{ userId }` for a user with a `developer` binding in `p1`.
9. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `PATCH /projects/p1/tickets/<ref>` with `{ title: 'Renamed' }` and from `POST /projects/p1/tickets/<ref>/assign`.
10. [integration] For a user whose only source in `p1` is a `developer` binding, `GET /projects/p1/tickets/<ref>` of an IN_PROGRESS ticket answers `allowedActions` exactly `['fix', 'close']`.
11. [integration] For a user whose only source in `p1` is a `reviewer` binding, `GET /projects/p1/tickets/<ref>` of a VERIFY_FIX ticket answers `allowedActions` exactly `['verify-fix', 'close']`, and of a CREATED ticket answers `[]`.
12. [integration] For a user whose only source in `p1` is a `viewer` binding, `GET /projects/p1/tickets/<ref>` of a CREATED ticket answers `allowedActions` `[]`.
13. [unit] `allowedActions(TicketStatus.CREATED, new Set(['start', 'fix']))` returns `['start']`, and `allowedActions(TicketStatus.IN_PROGRESS, new Set(['close']))` returns `['close']`.

### US-005: Comments, labels, ticket labels and watchers check keys (`Workdir: apps/api`)

1. [integration] A user whose only source in `p1` is a `viewer` binding gets 201 from `POST /projects/p1/tickets/<ref>/comments`.
2. [integration] A user whose only source in `p1` is an `approver` binding gets 403 with error code `permissions` from `POST /projects/p1/tickets/<ref>/comments`, and gets 200 from `GET /projects/p1/tickets/<ref>/comments`.
3. [integration] A user whose only source in `p1` is a `developer` binding gets 200 from `PATCH /comments/<id>` on a comment it wrote, and the body changes.
4. [integration] The same developer gets 403 with error code `permissions` from `PATCH /comments/<id>` on a comment another user wrote in `p1`, and the body is unchanged.
5. [integration] A user whose only source in `p1` is a `project-admin` binding gets 204 from `DELETE /comments/<id>` on a comment another user wrote in `p1`, and a user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `DELETE /comments/<id>` on a comment another user wrote, which remains.
6. [integration] A non-admin user with no source in `p1` gets 404 from `PATCH /comments/<id>` on a comment in `p1`.
7. [integration] An agent with a legacy `AgentProject` row in `p1` and no `AgentRoleEntry` gets 204 from `DELETE /comments/<id>` on a comment it wrote in `p1`.
8. [integration] A user whose only source in `p1` is a `developer` binding gets 201 from `POST /projects/p1/labels` and 200 from `PATCH /projects/p1/labels/<id>`.
9. [integration] The same developer gets 403 with error code `permissions` from `DELETE /projects/p1/labels/<id>`, and the label remains.
10. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `POST /projects/p1/labels`.
11. [integration] An agent with a legacy `AgentProject` row in `p1` and no `AgentRoleEntry` gets 403 with error code `permissions` from `POST /projects/p1/tickets/<ref>/labels`.
12. [integration] A user whose only source in `p1` is a `triager` binding gets 201 from `POST /projects/p1/tickets/<ref>/labels` with an existing label of `p1`.
13. [integration] A user whose only source in `p1` is a `reviewer` binding gets 403 with error code `permissions` from `PUT /projects/p1/tickets/<ref>/watch`, and a user whose only source in `p1` is a `viewer` binding gets 200 from it.

### US-006: Ticket links record their creator and check keys (`Workdir: apps/api`)

1. [integration] `POST /projects/p1/tickets/<ref>/links` with a new `url` by a user whose only source in `p1` is a `developer` binding answers 201, and the stored `TicketLink` row has `createdByUserId` the caller's id and `createdByAgentId` null.
2. [integration] The same call by an agent with a legacy `AgentProject` row in `p1` and an `AgentRoleEntry` `DEVELOPER` stores `createdByAgentId` the agent's id and `createdByUserId` null.
3. [integration] A second `POST /projects/p1/tickets/<ref>/links` with the same `url` by another `developer` user answers 200, and the row keeps its original `createdByUserId`.
4. [integration] `TicketLinksService.create(slug, ref, dto)` called without a creator, as the assistant link tool calls it, stores a link with `createdByUserId` and `createdByAgentId` both null.
5. [integration] A user whose only source in `p1` is a `developer` binding gets 204 from `DELETE /projects/p1/tickets/<ref>/links/<linkId>` on a link it created, and the link is gone.
6. [integration] The same developer gets 403 with error code `permissions` from `DELETE /projects/p1/tickets/<ref>/links/<linkId>` on a link another user created, and the link remains.
7. [integration] The same developer gets 403 with error code `permissions` from `DELETE /projects/p1/tickets/<ref>/links/<linkId>` on a link with no creator.
8. [integration] A user whose only source in `p1` is a `project-admin` binding gets 204 from `DELETE /projects/p1/tickets/<ref>/links/<linkId>` on a link another user created.
9. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 with error code `permissions` from `POST /projects/p1/tickets/<ref>/links`, and gets 200 from `GET /projects/p1/tickets/<ref>/links`.
10. [integration] A non-admin user with no source in `p1` gets 403 with error code `projects` from `GET /projects/p1/tickets/<ref>/links`.
11. [integration] `DELETE /projects/p1/tickets/<ref>/links/<unknown id>` by a `project-admin` user answers 404 with error code `ticket-links`.

### US-007: Projects, the agent roster and assignees check keys (`Workdir: apps/api`)

1. [integration] A non-admin user gets 403 with error code `permissions` from `POST /projects`, and a global admin gets 201.
2. [integration] A user whose only source in `p1` is a `viewer` binding gets 200 from `GET /projects/p1`, `GET /projects/p1/agents` and `GET /projects/p1/assignees`.
3. [integration] A user whose only source in `p1` is a `project-admin` binding gets 200 from `PATCH /projects/p1` with `{ name: 'Renamed' }`, and the project's name changes.
4. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `PATCH /projects/p1`.
5. [integration] A user whose only source in `p1` is a `project-admin` binding gets 204 from `DELETE /projects/p1`, and the project is soft-deleted.
6. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `GET /projects/p1/ci-webhook-token`, and a user whose only source in `p1` is a `project-admin` binding gets 200 from it.
7. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `POST /projects/p1/agents` with `{ agentSlug }`, and no binding is created for the agent.
8. [integration] A user whose only source in `p1` is a `project-admin` binding gets 201 from `POST /projects/p1/agents` and 204 from `DELETE /projects/p1/agents/<agent slug>` for an agent with no open tickets.
9. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `DELETE /projects/p1/agents/<agent slug>`.
10. [integration] An agent on the roster of `p1` gets 200 from `PATCH /projects/p1/agents/<its own slug>` with `{ status: 'OFFLINE' }`.
11. [integration] An agent on the roster of `p1` gets 403 with error code `permissions` from `PATCH /projects/p1/agents/<another rostered agent's slug>` with `{ status: 'OFFLINE' }`, and a user whose only source in `p1` is a `project-admin` binding gets 200 from the same call.
12. [integration] For a non-admin user with a `developer` binding in `p1` and no source in `p2`, `GET /projects` lists `p1` and not `p2`.

### US-008: Members and invites check keys (`Workdir: apps/api`)

1. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `POST /projects/p1/members` with `{ email }` of an existing user, and no binding is created.
2. [integration] A user whose only source in `p1` is a `project-admin` binding gets 201 from `POST /projects/p1/members` with `{ email, role: 'DEVELOPER' }`.
3. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `PATCH /projects/p1/members/<user id>` with `{ role: 'VIEWER' }` and from `DELETE /projects/p1/members/<user id>`.
4. [integration] A user whose only source in `p1` is a `viewer` binding gets 200 from `GET /projects/p1/members` with `canManage` `false`.
5. [integration] A user whose only source in `p1` is a `project-admin` binding gets 200 from `GET /projects/p1/members` with `canManage` `true`.
6. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `GET /projects/p1/invites`.
7. [integration] A user whose only source in `p1` is a `project-admin` binding gets 200 from `GET /projects/p1/invites` and 201 from `POST /projects/p1/invites` with `{ email, role: 'VIEWER' }` for an address with no account.
8. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `permissions` from `POST /projects/p1/invites/<id>/resend` and from `DELETE /projects/p1/invites/<id>`, and the invite stays pending.
9. [integration] A global admin with no source in `p1` gets 200 from `GET /projects/p1/members` with `canManage` `true`.
10. [integration] An agent with a legacy `AgentProject` row in `p1` gets 403 with error code `permissions` from `POST /projects/p1/members`.

### US-009: Agent routes check keys (`Workdir: apps/api`)

1. [integration] A non-admin user gets 403 with error code `permissions` from `POST /agents`, and a global admin gets 201.
2. [integration] A user with no binding gets 200 from `GET /agents` and from `GET /agents/<slug>`.
3. [integration] A user gets 403 with error code `agents` from `GET /agents/me`, and an agent gets 200 from it.
4. [integration] A user whose only source in `p1` is a `project-admin` binding gets 403 with error code `permissions` from `PATCH /agents/<slug>` with `{ name: 'Renamed' }`.
5. [integration] A non-admin user gets 403 with error code `permissions` from `DELETE /agents/<slug>`, from `POST /agents/<slug>/rotate-key` and from `PATCH /agents/<slug>/update-capabilities`.
6. [integration] For an agent with a legacy `AgentProject` row in `p1` and no `AgentRoleEntry`, after its `POST /projects/p1/tickets` answered 403, a global admin's `PATCH /agents/<slug>/update-roles` with `{ roles: ['DEVELOPER'] }` answers 200, and the agent's next `POST /projects/p1/tickets` answers 201.
7. [integration] A non-admin user gets 403 with error code `permissions` from `PATCH /agents/<slug>/update-roles`.
8. [integration] An agent with a legacy `AgentProject` row in `p1` and no `AgentRoleEntry` gets 403 with error code `permissions` from `GET /agents/<its slug>/pickup?project=p1`.
9. [integration] An agent with a legacy `AgentProject` row in `p1` and an `AgentRoleEntry` `DEVELOPER` gets 200 from `GET /agents/<its slug>/pickup?project=p1`.
10. [integration] An agent with an `AgentRoleEntry` `DEVELOPER` and no source in `p2` gets 403 with error code `permissions` from `GET /agents/<its slug>/pickup?project=p2`.
11. [integration] A user whose only source in `p1` is a `developer` binding gets 403 with error code `agents` from `GET /agents/<an agent's slug>/pickup?project=p1`.
12. [integration] An agent gets 400 from `GET /agents/<its slug>/pickup` with no `project` query.
13. [integration] A global admin gets 403 with error code `permissions` from `GET /agents/<slug>/pickup?project=p1` for an agent with an `AgentRoleEntry` `DEVELOPER` and no source in `p1`, and 200 for the same agent after it gains a legacy `AgentProject` row in `p1` and the permission cache is invalidated.

### US-010: Admin, auth, home, notification and public invite routes declare keys (`Workdir: apps/api`)

1. [integration] A non-admin user gets 403 with error code `permissions` from `GET /admin/users`, `POST /admin/users` and `PATCH /admin/users/<id>`.
2. [integration] A global admin gets 200 from `GET /admin/users`.
3. [integration] A global admin gets 403 with error code `users.self` from `PATCH /admin/users/<own id>` with `{ role: 'MEMBER' }`, as before.
4. [integration] A non-admin user gets 403 with error code `permissions` from `GET /admin/outbox` and from `POST /admin/outbox/<event id>/retry`, and a global admin gets 200 from `GET /admin/outbox`.
5. [integration] A non-admin user gets 403 with error code `permissions` from `GET /admin/slos`, and a global admin gets 200 from it.
6. [integration] `POST /auth/login` with valid credentials and no token answers 200.
7. [integration] `GET /invites/<token>` of a pending invite with no token answers 200.
8. [integration] A user with no binding gets 200 from `GET /home` and from `GET /auth/me`.
9. [integration] An agent gets 401 with error code `auth` from `GET /auth/me`, as before (the implicit key passes; the handler finds no user row for an agent id).
10. [integration] An agent gets 403 with error code `notifications` from `GET /me/notifications`, as before.
11. [integration] A user with no binding gets 200 from `PUT /me/notification-preferences` with a valid preferences body.
