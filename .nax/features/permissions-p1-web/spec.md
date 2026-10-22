# SPEC: Permissions P1j — Web Pages and Key-Based UI Gating

## Summary

This feature brings the P1 role model to `apps/web`, and adds the four small API reads and writes the web needs to do so:
- **The caller's own keys.** `GET /me/permissions` (optionally `?project=<slug>`) returns the caller's effective keys. Two web composables, `useGlobalPermissions()` and `useProjectPermissions(slug)`, expose them as a `PermissionSet`, and every web control that today gates on `user.role === 'ADMIN'`, `viewerRole`, `canManage` or `canWorkOnFleet` gates on the key its API route checks instead.
- **Admin → Roles** (new page): role list and CRUD with a permission matrix grouped by resource, risk badges, and system and locked roles marked. It reads a new `GET /permissions/catalog` and a new `expandedKeys` field on each role.
- **Admin → Users and Admin → Agents:** the MEMBER/ADMIN select and `EditAgentRolesDialog` give way to one `PrincipalRolesDialog` that manages a principal's global and all-projects role bindings through `/role-bindings`.
- **Project → Members:** one list of users **and** agents with role chips, add, remove and a role picker. `GET /projects/:slug/members?principals=all` returns both kinds with their bindings, and a new `GET /projects/:slug/roles` lists the assignable PROJECT roles.
- **Invites:** an invite carries a project role key (`roleKey`, stored as `ProjectInvite.roleId`) instead of ADMIN/DEVELOPER/VIEWER.
- **Cleanup (web only):** the legacy role UI is deleted (`EditAgentRolesDialog.vue`, `lib/agent-roles.ts`, `AddProjectAgentDialog.vue`, `useProjectViewerRole.ts`, `canWorkOnFleet`, the project agent roster's add/remove).

This is the tenth feature implementing phase P1 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§6 "Web UI"). The order so far: roles (PR #308), membership (#310), enforce-core (#313), enforce-fleet (#314), enforce-assistant (#315), enforce-integrations (#316), contract-tests (#317), retire-checks (#318), fixtures-to-bindings (#319). `permissions-p1-drop-legacy` waits on this feature.

## Motivation

The API decides every request on permission keys since enforce-core, and roles are data: a Triager, an Approver or any custom role is a first-class binding. The web still speaks the legacy vocabulary:
- Controls are gated on role names. `canWorkOnFleet` is `canManage || viewerRole === 'DEVELOPER'`, the ticket page's `canWork` is the same rule, and the admin navigation, the command palette and the knowledge card check `auth.user.role === 'ADMIN'`. A Triager (who holds `ticket.assign` and `ticket.label.*`) sees no assign or label control; a custom role holding `fleet.job.*` cannot dispatch from the UI; a Developer who holds `fleet.knowledge.repo.reindex` cannot reindex.
- The role-management pages write the legacy shapes: the users page PATCHes `role: 'MEMBER' | 'ADMIN'`, `EditAgentRolesDialog` PATCHes `/agents/:slug/update-roles` with `AGENT_ROLES`, the members panel and the invites panel offer only ADMIN/DEVELOPER/VIEWER, and project agents are added through a separate roster dialog that grants no role.
- There is no page for roles at all, so custom roles exist only through the REST API.

drop-legacy removes `AgentRoleEntry`, `ProjectMember`, `User.role` and `PATCH /agents/:slug/update-roles`. Until the web stops depending on them, drop-legacy cannot land.

The web also lacks reads it needs. `role.read` is a global key, so a Project Admin cannot list roles or bindings; there is no route that tells a caller which keys it holds; the catalog (risk, scope, ownability) is code-only; and `GET /role-bindings` cannot list "every agent's global bindings" in one filter.

**Rulings that bind this feature** (user, 2026-10-22):
1. **One feature, mixed stories.** API stories first (`Workdir: apps/api`), then web stories (`Workdir: apps/web`).
2. **Key-based UI gating is in scope.** A new `GET /me/permissions` returns the caller's effective keys, and a web composable replaces every `viewerRole` / `canManage` / `canWorkOnFleet` / `user.role === 'ADMIN'` check.
3. **The members routes are rewritten.** `GET /projects/:slug/members` returns users and agents with their project bindings, and `GET /projects/:slug/roles` lists the assignable PROJECT roles for any `member.read` holder. Role changes go through `/role-bindings`; the legacy role-enum write routes stay for the CLI until drop-legacy deletes them.

**Designer's calls** (not ruled; change them in review if wrong):
- The members list stays CLI-compatible: `?principals=users` (the default) keeps today's user-only records, which gain `principalType`, `principalId`, `agentSlug` and `bindings`; only `?principals=all` adds agent rows.
- `POST /projects/:slug/members` and `POST /projects/:slug/invites` accept `roleKey` beside the legacy `role`, so the CLI keeps working; the web sends `roleKey`.
- Invite role keys are stored in a new nullable `ProjectInvite.roleId` (FK `Role`, `ON DELETE SET NULL`); `ProjectInvite.role` becomes nullable. This moves "invite carries a `roleId`" out of drop-legacy, which then only drops the `role` column.
- Adding a member or an invite with a role key runs the escalation rules through a new `RoleAdminService.assertMayGrant`, because a custom role may hold `member.add` or `invite.create` without holding every key of the role it hands out.
- The role editor edits explicit keys through a matrix and keeps any other entry (wildcards, exclusions) verbatim as removable chips; keys a stored wildcard already covers show checked and disabled, from the role's saved `expandedKeys`.
- All-projects bindings (a PROJECT role bound with `projectId` null) are managed only on Admin → Users and Admin → Agents, not in a project's member list.
- `assertMayGrant` also runs when a caller sends only the legacy `role` (mapped to its key through `ROLE_KEY_FOR_LEGACY_ROLE`), so the CLI path gets the same escalation and self-binding rules as `roleKey`. A caller whose role holds `member.add` but not every key of `viewer` can no longer add a viewer; a caller adding themself gets 403 `permissions.selfBinding` instead of 409.
- Only `openapi.json` is regenerated; `bun run generate` (the CLI client) is not run, because the CLI is unchanged until its follow-up.

## Design

### Rulings and decisions carried from earlier P1 features

- **Order of checks** on every write route: (1) the permission key, (2) input validation and lookups, (3) self-binding, (4) escalation, (5) Owner lock. ACs follow this order.
- **Global Owner and Admin** hold every key in `expandEntries(['*'], 'PROJECT')`, in every project and in the global set.
- **Legacy reads are unioned until drop-legacy.** Membership answers combine bindings with legacy `ProjectMember` / `AgentProject` rows; new writes go to bindings only.
- **Exceptions** are `new XAppException({}, '<namespace>.<code>')`, with messages at `<namespace>.<code>.<status>` in `apps/api/src/i18n/en` and `zh`.
- **The API stays the authority.** A web gate only hides or disables a control; every refusal from the API is still shown with `toast.error(extractApiError(err))`.
- **Web convention** (added to `.nax/rules/web.md` with this spec): gate UI controls on keys from `useProjectPermissions(slug)` / `useGlobalPermissions()`, never on role names, `user.role` or `viewerRole`.

### API: `GET /me/permissions` (US-001)

New controller `MePermissionsController` in `apps/api/src/projects/me-permissions.controller.ts`, registered in `ProjectsModule` (it needs `ProjectAccessService`; `PermissionsModule` is global, so the controller cannot live there without importing `ProjectsModule`).

```ts
@ApiTags('permissions')
@ApiBearerAuth()
@Controller('me/permissions')
export class MePermissionsController {
  constructor(private readonly access: ProjectAccessService, private readonly permissions: PermissionService) {}

  @Get()
  @UseGuards(RequiresGuard)
  @Requires('auth.me.read')            // implicit: every authenticated principal holds it
  async read(@Query() query: MePermissionsQuery, @Principal() principal: KodaPrincipal) { ... }
}
```

- `MePermissionsQuery { project?: string }` (a project slug, `IsString` and `IsNotEmpty` when present: `?project=` with an empty value is a 400 validation error). A runner never reaches this route: `CombinedAuthGuard` keeps runner keys on `@RunnerRoute()` routes.
- Without `project`: `PermissionService.effectiveKeys(ref, 'global')`.
- With `project`: `ProjectAccessService.findProjectIdBySlug(slug)` (404 `projects`), then `ProjectAccessService.resolveMembership(projectId, principal)` (403 `projects` when the caller lacks `project.read` there), then `PermissionService.effectiveKeys(ref, { projectId })`.
- Response `MePermissionsDto { scope: 'global' | 'project'; projectSlug: string | null; keys: string[] }`, `keys` sorted ascending. The set is exactly what `effectiveKeys` returns: role-derived keys and `X.own` entries, never implicit or public keys.
- `ref` is `{ type: 'USER' | 'AGENT', id }` from the principal, as `PermissionService.can` builds it.

### API: catalog, `expandedKeys`, binding filters (US-002)

- New controller `PermissionCatalogController` in `apps/api/src/permissions/permission-catalog.controller.ts`, registered in `PermissionsModule.controllers`: `GET /permissions/catalog`, `@UseGuards(RequiresGuard)`, `@Requires('role.read')`. It returns `PermissionCatalogEntryDto[]` for every `PERMISSION_CATALOG` entry whose `access` is `'role'`, sorted by `key`:

  ```ts
  class PermissionCatalogEntryDto { key: string; scope: 'global' | 'project' | 'any'; risk: 'low' | 'medium' | 'high' | 'critical'; principals: ('user' | 'agent')[]; ownable: boolean }
  ```

- `RoleDto` gains `expandedKeys: string[]`: `expandEntries(role.permissions, role.scope)` as a sorted array, or `[]` when the stored entries no longer expand (`expandEntries` throws). Every route that returns a `RoleDto` carries it.
- `ListRoleBindingsQuery` changes:
  - `principalType` alone is now accepted and filters by type; `principalId` alone is still refused (400 validation).
  - New `scope?: 'global'`: only `projectId`-null bindings. Any other value is a 400 validation error, and `scope=global` together with a non-empty `projectId` is a 400 validation error with key `permissions.scopeAndProject`.
  - `BindingFilter` gains `principalType?: PrincipalType`; `MembershipService.listBindings`, `PrismaRoleBindingRepository` and the test double `InMemoryPermissionStore` (`apps/api/src/permissions/test-helpers/in-memory-permissions.ts`) honour it. `projectId: null` in the filter already means "global bindings only".

### API: project roles and the unified members list (US-003)

- `RoleAdminService.listProjectRoles(): Promise<RoleDomain[]>` (new, public): every role with `scope = 'PROJECT'`, system roles first, then by `key`. It checks no key: its route's guard does.
- New controller `ProjectRolesController` in `apps/api/src/projects/members/project-roles.controller.ts`, registered in `ProjectMembersModule`: `GET /projects/:slug/roles`, `@UseGuards(ProjectMembershipGuard, RequiresGuard)`, `@Requires('member.read')`. It returns `ProjectRoleDto { id, key, name, description, system }[]` from `listProjectRoles()`.
- `GET /projects/:slug/members` takes `principals?: 'users' | 'all'` (default `users`; any other value is 400 validation).
  - `ProjectMemberDto` changes: `userId: string | null` (null for agents), `email: string | null` (null for agents), plus `principalType: 'USER' | 'AGENT'`, `principalId: string`, `agentSlug: string | null` (null for users), `bindings: MemberBindingDto[]`. `name`, `role`, `disabled` and `joinedAt` keep their meaning; for an agent `name` is `Agent.name`, `disabled` is `false`, and `role` is the strongest legacy role of its sources as `listProjectMemberships` reports it.
  - `MemberBindingDto { id: string | null; roleKey: string; roleName: string }`: one entry per `RoleBinding` of that principal **in this project** (`projectId` equal), ordered by `createdAt`. Then the legacy rows, read directly for the page's principals: a `ProjectMember` row (`projectMember.findMany` by `projectId` and the page's user ids) maps its `role` through `ROLE_KEY_FOR_LEGACY_ROLE` (`ADMIN` → `project-admin`, `DEVELOPER` → `developer`, `VIEWER` → `viewer`; any other value → `viewer`), and an `AgentProject` row (`agentProject.findMany`, which has no role column) maps to `viewer`. A legacy row adds one entry with `id: null` only when the principal has no binding of that key in the project. All-projects bindings are not listed here.
  - The single-record responses carry the same shape with `bindings` populated: `POST /projects/:slug/members`, the legacy `PATCH /projects/:slug/members/:userId`, and the `member` of an invite's `ADDED` outcome. `ProjectMemberRecord` (the shared domain type in `domain/project-member.domain.ts`) gains `principalType`, `principalId`, `agentSlug` and `bindings`, and `userId` / `email` become `string | null`; `ProjectMemberDto.from(record)` copies them.
  - With `principals=all`, the page is the user rows (in today's order) followed by the agent rows (`listProjectMemberships(db, projectId, 'AGENT')`, same order rule); `total` counts both.
  - `canManage` and `viewerRole` stay in the response unchanged (drop-legacy removes them).

### API: role keys on member, invite and user writes (US-004, US-005)

US-004 owns `assertMayGrant`, the member add and `CreateUserDto`; US-005 owns everything about invites and the `openapi.json` regeneration.


- `RoleAdminService.assertMayGrant(principal, target: { roleKey: string; projectId: string | null; principalType: PrincipalType; principalId: string | null }): Promise<RoleDomain>` (new, public). It runs the binding rules that do not need an existing target row, in this order, and returns the role:
  1. role lookup by key: 404 `permissions.roleNotFound`;
  2. a GLOBAL role with a project id: 400 `permissions.scopeMismatch`;
  3. principal type: 400 `permissions.principalType` (as `assertPrincipalType`);
  4. self: when `principalId` equals the caller's id and type, 403 `permissions.selfBinding`;
  5. escalation: 403 `permissions.escalation` (as `createBinding`'s `assertNoEscalation`, scope from `projectId`).

  It does not check `role.binding.manage` / `role.binding.global`: the calling route's own key (`member.add`, `invite.create`) is the gate. `createBinding` keeps its own checks unchanged.
- `POST /projects/:slug/members`: `AddMemberDto` gains `roleKey?: string` (`ROLE_KEY_PATTERN`); both fields are optional in the DTO. The service throws `ValidationAppException({}, 'members.roleAndRoleKey')` when both are sent; neither means `viewer`, as today. The effective key is `roleKey`, else `ROLE_KEY_FOR_LEGACY_ROLE[role]`, else `viewer`. After the user lookup (404 `members.user`, 409 `members.userDisabled`), `ProjectMembersService.add` calls `assertMayGrant(principal, { roleKey: <effective key>, projectId, principalType: 'USER', principalId: user.id })` on every path, then writes the binding with that key inside the existing transaction (409 `members` when already a member).
- `POST /projects/:slug/invites`: `CreateInviteDto.role` becomes optional and gains `roleKey?: string`; both are optional in the DTO, and the service requires exactly one (both: `ValidationAppException({}, 'invites.roleAndRoleKey')`; neither: `ValidationAppException({}, 'invites.roleRequired')`). The effective key is `roleKey`, else `ROLE_KEY_FOR_LEGACY_ROLE[role]`. Both write routes use one order: user lookup, then 409 for a disabled existing account (`invites.userDisabled` / `members.userDisabled`), then `assertMayGrant`, then 409 for an existing member (`invites.memberExists` / `members`). `ProjectInvitesService.create` calls `assertMayGrant(principal, { roleKey: <effective key>, projectId, principalType: 'USER', principalId: existingUserId ?? null })` at that point on both paths; `addExistingUser` binds that role key and `inviteNewAddress` stores the invite with `roleId`.
- Schema: `ProjectInvite.roleId String?` with `role Role? @relation(fields: [roleId], references: [id], onDelete: SetNull)` (and `invites ProjectInvite[]` on `Role`); `ProjectInvite.role String?` (nullable). Migration `apps/api/prisma/migrations/20261101090000_invite_role_id/migration.sql`. A new invite stores `roleId` and stores `role` only when its key is `project-admin`, `developer` or `viewer` (the legacy enum the key maps to), else null.
- Invite acceptance (`InviteAcceptanceService`) binds the role named by `roleId`; a row with `roleId` null binds `ROLE_KEY_FOR_LEGACY_ROLE[role]`; a row with both null answers 409 `invites.roleGone`.
- `InviteDto` and `InvitePreviewDto` gain `roleKey: string | null` and `roleName: string | null` (from `roleId`'s role, else from the legacy `role` mapping, else null); `role` becomes `string | null`. The invite email passes `roleName` as the existing `{{role}}` placeholder value; the templates are unchanged.
- `CreateUserDto.role` becomes optional (default `'MEMBER'`), so the web creates a user and then binds roles. `UsersAdminService.create` and its input type treat an absent `role` as `'MEMBER'`.
- New API error keys get messages in both `en` and `zh`, under both the `-2` and `400` status keys as `permissions.scopeMismatch` has them: `members.roleAndRoleKey` (`members.json`), `invites.roleAndRoleKey`, `invites.roleRequired`, `invites.roleGone` (`invites.json`), `permissions.scopeAndProject` (`permissions.json`).
- `openapi.json` is regenerated with `bun run api:export-spec` in US-005, after the last API contract change.

### Web: permission sets (US-006)

`apps/web/lib/permissions.ts` (new):

```ts
export interface PermissionSet {
  /** Holds the key for every row. */
  has(key: string): boolean
  /** Holds the key for every row, or only for rows the caller created (`key.own`). */
  hasOwn(key: string): boolean
}
export function permissionSet(keys: readonly string[]): PermissionSet
export const EMPTY_PERMISSIONS: PermissionSet   // has/hasOwn always false
```

`apps/web/composables/usePermissions.ts` (new; auto-imported, added to the `tests/helpers/mount-sfc.ts` override list):

```ts
export function useGlobalPermissions(): { permissions: ComputedRef<PermissionSet>; pending: Ref<boolean>; error: Ref<unknown>; refresh: () => Promise<void> }
export function useProjectPermissions(slug: string): /* same shape */
```

- Both use `useAsyncData` (SSR-friendly, so gates are set before hydration, like `useProjectViewerRole` today), keys `permissions-global` and `permissions-project-<slug>`, calling `$api.get('/me/permissions')` and `$api.get('/me/permissions', { query: { project: slug } })`.
- On a failed or pending fetch, `permissions` is `EMPTY_PERMISSIONS`: every gated control is hidden, as today's `{ canManage: false, viewerRole: null }` default does.
- Every new composable (`useGlobalPermissions`, `useProjectPermissions`, `useRoles`, `useRoleBindings`, `useProjectRoles`) is added to the `NUXT_AUTO_IMPORTS` override list in `tests/helpers/mount-sfc.ts` by the story that creates it. New components (`RoleEditorDialog`, `PermissionMatrix`, `PrincipalRolesDialog`) are imported explicitly in the SFCs that use them, as `pages/agents.vue` imports its dialogs.
- `layouts/default.vue` reads the global set once in setup and exposes one plain computed boolean per admin link (and one for the section label), so a test context without the binding renders the links hidden.
- Every web story that renders a new string adds its key to both `i18n/locales/en.json` and `zh.json` (`tests/i18n/used-keys-exist.spec.ts` and the locale-parity specs check both).

### Web: the gate table (US-006, US-007, US-008, US-009)

Each control below gates on the key its API route requires. "global" reads `useGlobalPermissions()`, "project" reads `useProjectPermissions(slug)`. Component props keep their names where a component has one gated control; the page binds the prop to the key.

| Story | Site | Control | Key (set) |
|:--|:--|:--|:--|
| US-006 | `layouts/default.vue` | the "Admin" section label | shown when at least one admin link is shown |
| US-006 | `layouts/default.vue` | admin links `/admin/users`, `/admin/fleet`, `/admin/fleet/runners`, `/admin/fleet/repos`, `/admin/fleet/budgets`, `/admin/fleet/approvals`, `/admin/fleet/analytics`, `/admin/skills` | `user.read`, `fleet.dashboard.read`, `fleet.runner.read`, `fleet.repo.read`, `fleet.budget.read`, `fleet.approval.read`, `fleet.analytics.read`, `skill.source.read` (global) |
| US-006 | `components/CommandPalette.vue` | the `skills` command | `skill.source.read` (global) |
| US-006 | `pages/[project]/fleet/analytics.vue` | `FleetAnalyticsIngestNotice` `admin` prop | `fleet.ingest.read` (global) |
| US-007 | `pages/[project]/tickets/[ref].vue` → `TicketProperties` | assignee picker and unassign; label select; label chip removal; link form; delete | `canAssign` = `ticket.assign`; `canLabel` = `ticket.label.assign`; `canUnlabel` = `ticket.label.remove`; `canLink` = `ticket.link.add`; `canDelete` = `ticket.delete` (project). These five props replace `canWork` and `canManage`. |
| US-007 | `pages/[project]/tickets/[ref].vue` | `TicketFleetRuns` `canWork` (unlink); the fleet dispatch suggestion | `fleet.ticket-job.unlink`; `fleet.job.dispatch` (project) |
| US-007 | `pages/[project]/labels.vue` | create form; edit; delete | `label.create`; `label.update`; `label.delete` (project) |
| US-007 | `pages/[project]/threads/index.vue` | new-thread link (still also needs `threadsEnabled`) | `thread.create` (project) |
| US-007 | `pages/[project]/threads/new.vue` | the create form (today `canWork`) | `thread.create` (project) |
| US-007 | `pages/[project]/threads/[id].vue` | `ThreadControls` `canManage` (archive any thread) | `thread.archive` via `has` (project) |
| US-007 | `components/ProjectSkillsPanel.vue` | enable toggle; disable toggle | `skill.project.enable`; `skill.project.disable` (project) |
| US-007 | `components/SettingsKnowledgeCard.vue` | pattern editing and save; reindex button | `fleet.knowledge.patterns.update`; `fleet.knowledge.repo.reindex` (project) |
| US-007 | `pages/[project]/agents.vue` | the status menu | `agent.update` (global) |
| US-008 | `lib/fleet-jobs.ts` `JobViewer` | cancel; requeue; dispatch-run | `{ userId, canCancel, canRequeue, canDispatch }` = `fleet.job.cancel`, `fleet.job.requeue`, `fleet.job.dispatch` (project). `canCancelJob` = unfinished and (`canCancel` or requester); `canRequeueJob` uses `canRequeue`. |
| US-008 | `pages/[project]/fleet/index.vue`, `dispatch.vue` | dispatch button / form | `fleet.job.dispatch` (project) |
| US-008 | `pages/[project]/fleet/jobs/[id]/index.vue` | viewer above; `ConfigJobPanel` `canWork` | `JobViewer` from keys; `fleet.job.config.edit` (project) |
| US-008 | `pages/[project]/fleet/repos/[id]/config.vue` | save, new file, editor; drift check | `fleet.job.config.edit`; `fleet.repo.drift.check` (project) |
| US-009 | `lib/fleet-schedules.ts` `ScheduleViewer` + `ScheduleTable` + both schedule pages | create; change (edit, enable, disable); delete | `{ userId, canCreate, canUpdateAny, canUpdateOwn, canDeleteAny, canDeleteOwn }` = `fleet.schedule.create`, `has('fleet.schedule.update')`, `hasOwn('fleet.schedule.update')`, `has('fleet.schedule.delete')`, `hasOwn('fleet.schedule.delete')` (project). `canChangeSchedule` = `canUpdateAny` or (`canUpdateOwn` and `userId === createdById`); new `canDeleteSchedule` = `canDeleteAny` or (`canDeleteOwn` and `userId === createdById`). |
| US-008 | `components/fleet/BudgetTable.vue` | resume; edit; delete | props `canResume`, `canEdit`, `canDelete` replace `editable` |
| US-008 | `pages/[project]/fleet/budgets.vue` | create; the table's resume, edit, delete (the create/edit and resume dialogs follow the same keys; the read-only notice shows when the set holds none of the four; the fleet-wide table gets all three props `false`) | `fleet.budget.create`; `fleet.budget.resume`, `fleet.budget.update`, `fleet.budget.delete` (project) |
| US-008 | `pages/admin/fleet/budgets.vue` | the table's resume, edit, delete (today `editable: true`) | `fleet.budget.resume`, `fleet.budget.update`, `fleet.budget.delete` (global) |
| US-009 | `lib/fleet-approvals.ts` `ApprovalViewer` (both kinds) + `pages/[project]/fleet/approvals.vue` + `pages/admin/fleet/approvals.vue` | decide | `{ kind, userId, canDecideBudget, canDecideBash }` = `fleet.approval.decide.budget`, `fleet.approval.decide.bash`, from the project set on a project page and from the global set on the admin page. `canDecide` no longer returns true for every admin-kind viewer. `assistant_action` stays requester-only. |
| US-009 | `composables/useApprovalNotifications.ts` | admin scan; per-project scan | inside `refresh()` (which runs outside setup, so no `useAsyncData`), a direct `$api.get('/me/permissions')` comes first: with `fleet.approval.read` it scans the admin inbox; otherwise, per project, `$api.get('/me/permissions', { query: { project: slug } })` decides the viewer (replaces the `members?size=1` read). No scan starts before the global read resolves; a failed global read scans nothing. |
| US-009 | `components/fleet/ApprovalBadge.vue` | `globalAdmin` link target | `fleet.approval.read` (global) |

### Web: Admin → Roles (US-010)

- `pages/admin/roles.vue` (new), `composables/useRoles.ts` (new: `load()`, `create(input)`, `update(id, patch)`, `remove(id)`, `loadCatalog()` over `/roles` and `/permissions/catalog`), `components/RoleEditorDialog.vue` (new), `components/PermissionMatrix.vue` (new).
- The list shows name, key, scope, a `system` badge and a `locked` badge. A 403 on `GET /roles` shows the page's admin-only message, like `pages/admin/users.vue`.
- The editor: key (create only, `ROLE_KEY_PATTERN`), name, description, scope (create only) and permissions.
  - Matrix rows: catalog entries whose `scope` fits the role (`GLOBAL` → `global` or `any`; `PROJECT` → `project` or `any`), grouped by the key's first segment, each with its `risk` as a badge.
  - A non-ownable row is a checkbox; an ownable row is a three-way choice none / own / any, writing `X.own` or `X`.
  - Entries that are not a plain key of a matrix row (wildcards like `*.read`, `prefix.*`, exclusions `!x`) are kept verbatim as removable chips, and a text input adds one.
  - For a saved role, a row whose key is in `expandedKeys` but not an explicit entry shows checked and disabled ("covered").
  - Save sends `permissions` as the chip entries in their stored order, then the checked keys sorted.
- A `locked` role opens read-only (no save, no delete). A `system` role's name is read-only and it has no delete; a save omits `name`.
- Create, edit and delete controls show only with `role.manage` (global); the nav link `/admin/roles` shows with `role.read` (global).

### Web: `PrincipalRolesDialog`, Admin → Users, Admin → Agents (US-011, US-012)

- `composables/useRoleBindings.ts` (new): `listGlobal(principalType)` pages `GET /role-bindings?principalType=<t>&scope=global&size=200` until `hasNext` is false; `create({ principalType, principalId, roleKey, projectId })` → `POST /role-bindings`; `remove(id)` → `DELETE /role-bindings/:id`.
- Binding chips get their role name and scope by joining `roleKey` against the roles from `GET /roles` (`useRoles`); `RoleBindingDto` is unchanged. The roles column and "Edit roles" need both `role.read` and `role.binding.global` (global); when `GET /roles` or `GET /role-bindings` fails, the column shows the load error through `extractApiError` and no chips.
- `components/PrincipalRolesDialog.vue` (new): props `principal: { type: 'USER' | 'AGENT'; id: string; label: string }`, `bindings` (its `projectId`-null bindings) and `roles` (from `GET /roles`). It lists one chip per binding (a PROJECT-scope role's chip reads "<name> (all projects)"), offers the roles not already bound in a select, posts with `projectId: null`, and removes chips. It hides the `owner` role unless the caller holds `role.binding.owner` and the principal is a user. It emits `changed`.
- `pages/admin/users.vue`: the role column shows the user's global binding chips; an "Edit roles" button opens the dialog, hidden for the signed-in user and without `role.binding.global`. `CreateUserDialog` no longer has a role field and posts without `role`.
- `pages/agents.vue`: the roles column shows the agent's global binding chips (no longer `agent.roles`); "Edit roles" opens the same dialog. Actions gate on `agent.create` (create), `role.read` and `role.binding.global` (edit roles), `agent.capabilities.update`, `agent.key.rotate`, `agent.delete`, `agent.update` (status), all global. `CreateAgentDialog` no longer has a roles field and posts without `roles`.

### Web: Project → Members and invites (US-013, US-014)

- `ProjectMembersPanel` takes `slug` and `projectId`; the settings page renders it only once the project has loaded and passes its id. It loads `GET /projects/:slug/members?principals=all` and `GET /projects/:slug/roles`.
  - Each row shows the name (users: name else email; agents: name with an agent badge and the slug) and one chip per binding (`roleName`). A chip with `id: null` (legacy) has no remove button.
  - Add a user: email + role select → `POST /projects/:slug/members { email, roleKey }`.
  - Add an agent: select from `GET /agents` minus agents already listed, plus a role → `POST /role-bindings { principalType: 'AGENT', principalId, roleKey, projectId }`.
  - Add a role to a row: `POST /role-bindings` for that principal; remove a chip: `DELETE /role-bindings/:id`; remove a row: `DELETE` each non-null binding id, then reload.
  - Gates (project set): the add-user form needs `member.add`; adding an agent, adding or removing a chip and removing a row need `role.binding.manage`. The signed-in user's own row shows no edit controls.
- `ProjectInvitesPanel` shows only with `invite.read`; its form only with `invite.create`, resend with `invite.resend`, cancel with `invite.cancel`. The role select lists the project roles and posts `{ email, roleKey }`; each invite shows `roleName`. `pages/invite/[token].vue` shows the preview's `roleName`.
- `useProjectMembers` loads the unified list as a new type `ProjectPrincipalRow { principalType; principalId; userId: string | null; email: string | null; agentSlug: string | null; name; disabled; joinedAt; bindings }`, and `add(email, roleKey)` posts `{ email, roleKey }`; its `changeRole` and `remove` and `ASSIGNABLE_MEMBER_ROLES` go away with the old panel (the panel writes through `useRoleBindings`). The existing `ProjectMember` type keeps `userId: string` and `email: string` for `useProjectMemberNames`, `lib/mentions.ts` and `MarkdownEditor`, which keep reading the default `principals=users` page.
- `composables/useProjectRoles.ts` (new, US-013): `useProjectRoles(slug)` loads `GET /projects/:slug/roles` once; both panels use it.
- `useProjectInvites` carries `InviteDto.roleKey`, `roleName`, and `create(email, roleKey)`.
- A row whose bindings are all legacy (`id: null`) shows no remove-row button.

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| `GET /me/permissions?project=` with an unknown slug | 404, error key `projects` |
| `GET /me/permissions?project=` by a principal without `project.read` there | 403, error key `projects` |
| `GET /permissions/catalog` without `role.read` | 403, error key `permissions` |
| `GET /role-bindings` with `principalId` and no `principalType` | 400 validation (unchanged) |
| `GET /role-bindings?scope=` other than `global` | 400 validation |
| `GET /role-bindings?scope=global&projectId=<id>` | 400, error key `permissions.scopeAndProject` |
| `GET /projects/:slug/roles` without `member.read` | 403 (the route's key) |
| `GET /projects/:slug/members?principals=` other than `users`/`all` | 400 validation |
| A role whose stored entries no longer expand | `expandedKeys: []`; the role still lists |
| `assertMayGrant` with an unknown role key | 404 `permissions.roleNotFound` |
| `assertMayGrant` with a GLOBAL role and a project | 400 `permissions.scopeMismatch` |
| `assertMayGrant` granting a role with a key the caller lacks | 403 `permissions.escalation` |
| `POST /projects/:slug/members` with both `role` and `roleKey` | 400 `members.roleAndRoleKey` |
| `POST /projects/:slug/members` or `/invites` (either role field) naming the caller's own account | 403 `permissions.selfBinding` |
| `GET /me/permissions?project=` with an empty value | 400 validation |
| `POST /projects/:slug/invites` with both, or neither, of `role` and `roleKey` | 400 `invites.roleAndRoleKey` / `invites.roleRequired` |
| Accepting an invite whose `roleId` and `role` are both null | 409 `invites.roleGone`; no user, no binding |
| Web: `/me/permissions` fails or is pending | `EMPTY_PERMISSIONS`: gated controls hidden |
| Web: any role, binding, member or invite write fails | `toast.error(extractApiError(err))`; the list keeps its last loaded state, the dialog stays open |
| Web: removing a member row where one binding delete fails | toast, then reload the members list |

### Integration

Symbols this feature reads (verified):
- `PermissionService.effectiveKeys(principal: PrincipalRef, scope: PermissionScope): Promise<ReadonlySet<string>>` — `apps/api/src/permissions/permission.service.ts`
- `ProjectAccessService.findProjectIdBySlug(slug)`, `resolveMembership(projectId, principal)` — `apps/api/src/projects/project-access.service.ts`
- `PERMISSION_CATALOG`, `findCatalogEntry` — `apps/api/src/permissions/catalog.ts`; `expandEntries(entries, scope)` — `entry-matcher.ts`
- `listProjectMemberships(db, projectId, type)` — `apps/api/src/permissions/legacy-membership.queries.ts`
- `ROLE_KEY_FOR_LEGACY_ROLE` — `apps/api/src/permissions/legacy-project-roles.ts`
- Web: `useApi()`, `apiPath`, `extractApiError`, `useAppToast()`, `useAuth()`

Symbols this feature changes. The baseline exists only to locate the code; it is never the interface to implement.

- `RoleDto` — baseline `{ id, key, name, description, scope, system, locked, permissions }`; target adds `expandedKeys: string[]`.
- `ListRoleBindingsQuery` / `BindingFilter` — baseline: `principalType` and `principalId` must travel together, `projectId` filter; target: `principalType` alone allowed, `scope?: 'global'`, `BindingFilter.principalType?`.
- `ProjectMemberDto` — baseline `{ userId: string; email: string; name; role; disabled; joinedAt }`; target `{ userId: string | null; email: string | null; name; role; disabled; joinedAt; principalType; principalId; agentSlug: string | null; bindings: MemberBindingDto[] }`.
- `ProjectMembersService.list(slug, principal, page)` — target `list(slug, principal, page, principals: 'users' | 'all')`.
- `ProjectMemberRecord` — baseline `{ userId: string; email: string; name; role; disabled; joinedAt }`; target adds `principalType`, `principalId`, `agentSlug`, `bindings`, with `userId` / `email` `string | null`.
- Web `BudgetTable` — baseline prop `editable: boolean`; target props `canResume`, `canEdit`, `canDelete`.
- `ProjectMembersService` / `ProjectInvitesService` constructors — target adds `RoleAdminService` as the last parameter.
- `AddMemberDto` — target adds `roleKey?: string`. `CreateInviteDto` — target `role?: ProjectMemberRole; roleKey?: string`. `CreateUserDto.role` — target optional.
- `InviteDto` / `InvitePreviewDto` — target `role: string | null; roleKey: string | null; roleName: string | null`.
- Web `JobViewer`, `ScheduleViewer`, `ApprovalViewer` (project kind) and `TicketProperties` props — targets in the gate table.
- Web `useProjectMembers(slug)` — target: rows of `ProjectPrincipalRow`; `add(email: string, roleKey: string)`. `ProjectMember` is unchanged.
- Web `useProjectInvites(slug)` — target `create(email: string, roleKey: string)`.

Patterns to follow: `pages/admin/users.vue` (admin page with 403 notice), `composables/useProjectViewerRole.ts` (SSR `useAsyncData` gate fetch), `components/CreateUserDialog.vue` (vee-validate + zod dialog), `apps/api/src/permissions/roles.controller.ts` (controller shape).

## Out of Scope

- Removing `canManage` and `viewerRole` from `GET /projects/:slug/members`, the legacy routes `PATCH /agents/:slug/update-roles`, `PATCH`/`DELETE /projects/:slug/members/:userId`, `POST`/`DELETE /projects/:slug/agents`, the `role` fields of `AddMemberDto` / `CreateInviteDto` / `CreateUserDto` / `UpdateUserDto`, the `ProjectInvite.role` column and the legacy tables is out of scope (`permissions-p1-drop-legacy`).
- The MEMBER_ADDED email (`email-content.builder.ts`) still shows the legacy role string; giving it the role name is out of scope.
- The CLI (`apps/cli`) and its generated client are not changed; the CLI keeps the legacy `role` flags until a CLI follow-up. `apps/cli/src/generated/` is not regenerated.
- All-projects bindings are not shown or edited in a project's member list; they are managed on Admin → Users and Admin → Agents.
- The P2 audit log page and the P3 approval policy pages and unified inbox are out of scope.
- Ticket transition buttons, comment edit/delete and the KB dialog are not gated in the web by this feature; the API still refuses what a principal may not do.
- A preview of an unsaved wildcard's effect in the role editor is out of scope; covered rows reflect the saved role's `expandedKeys`.
- Playwright e2e specs under `apps/web/tests/e2e/` are not changed: they drive the legacy API routes, which stay.
- `.nax/rules/web.md` gains its gating line as a manual step with this spec, not as story work.
- The last-project-admin rule of the legacy member routes is not applied to `/role-bindings` deletes; a project without a Project Admin stays reachable by global Owner and Admin.
- US-001 only: `/me/permissions` lists role-derived keys only; implicit and public keys are always allowed by the API and are not listed.
- US-005 only: an existing pending invite created before the migration keeps `roleId` null and is accepted through its legacy `role`; no backfill.

## Stories

1. **US-001: `GET /me/permissions` returns the caller's effective keys** — `Workdir: apps/api` — No dependencies. Creates `MePermissionsController` and its DTOs, registered in `ProjectsModule`.
2. **US-002: Permission catalog route, `RoleDto.expandedKeys`, binding list filters** — `Workdir: apps/api` — No dependencies. Creates `PermissionCatalogController`, adds `expandedKeys` to `RoleDto`, and extends `ListRoleBindingsQuery` / `BindingFilter`.
3. **US-003: Project roles route and the unified members list** — `Workdir: apps/api` — Depends on US-002. Adds `RoleAdminService.listProjectRoles`, `ProjectRolesController`, and the `principals` query and binding chips of `GET /projects/:slug/members`.
4. **US-004: Member adds take a role key through the grant rules** — `Workdir: apps/api` — Depends on US-003. Adds `RoleAdminService.assertMayGrant`, `roleKey` on `POST /projects/:slug/members`, and optional `CreateUserDto.role`.
5. **US-005: Invites carry a role key** — `Workdir: apps/api` — Depends on US-001, US-002, US-003, US-004. `roleKey` on `POST /projects/:slug/invites`, `ProjectInvite.roleId` with its migration, invite acceptance by `roleId`, the invite DTO role fields, and the `openapi.json` regeneration (the dependencies on US-001 to US-003 exist so the regeneration runs after every contract change).
6. **US-006: Web permission sets and the global gates** — `Workdir: apps/web` — Depends on US-001. Creates `lib/permissions.ts` and `composables/usePermissions.ts`; moves the admin navigation, the command palette and the analytics ingest link onto global keys.
7. **US-007: Web project gates** — `Workdir: apps/web` — Depends on US-006. The ticket, label, thread, project skills, knowledge card and project agents status gates of the gate table.
8. **US-008: Web fleet job, config and budget gates** — `Workdir: apps/web` — Depends on US-006. The `JobViewer`, dispatch, job detail, repo config and budget gates of the gate table, and the `BudgetTable` props.
9. **US-009: Web fleet schedule and approval gates** — `Workdir: apps/web` — Depends on US-006. The `ScheduleViewer` and `ApprovalViewer` gates of the gate table, `useApprovalNotifications` and `ApprovalBadge`.
10. **US-010: Admin → Roles page** — `Workdir: apps/web` — Depends on US-002, US-006. The roles page, editor, matrix and nav link.
11. **US-011: `PrincipalRolesDialog` and Admin → Users** — `Workdir: apps/web` — Depends on US-002, US-004, US-006. Creates `useRoleBindings` and `PrincipalRolesDialog`; the users page manages global bindings; `CreateUserDialog` drops its role field.
12. **US-012: Admin → Agents uses role bindings** — `Workdir: apps/web` — Depends on US-011. The agents page roles column and dialog, the action gates, and `CreateAgentDialog` without roles.
13. **US-013: Project → Members lists users and agents with role chips** — `Workdir: apps/web` — Depends on US-003, US-004, US-006, US-011. The rewritten `ProjectMembersPanel` and `useProjectMembers`, and the new `useProjectRoles`.
14. **US-014: Invites carry a project role key** — `Workdir: apps/web` — Depends on US-005, US-006, US-013. `ProjectInvitesPanel`, `useProjectInvites` and the invite page.
15. **US-015: Delete the legacy role UI** — `Workdir: apps/web` — Depends on US-007, US-008, US-009, US-011, US-012, US-013, US-014. Deletion only: `EditAgentRolesDialog.vue`, `lib/agent-roles.ts`, `AddProjectAgentDialog.vue`, `useProjectViewerRole.ts`, `canWorkOnFleet`, `useAdminUsers.setRole` and `GlobalRole`, `INVITE_ROLES`, `useProjectAgents.add`/`remove`, and the roster add/remove UI and its "added by"/"added at" columns in `pages/[project]/agents.vue`. Verified by `bun run type-check` and `bun run lint` in `apps/web`.

Fifteen stories; the user ruled this one feature (one capability: the web on the P1 role model).

### Context Files

**US-001**
- `apps/api/src/permissions/permission.service.ts` — `effectiveKeys`, read
- `apps/api/src/projects/project-access.service.ts` — slug lookup and access gate, read
- `apps/api/src/projects/projects.module.ts` — controller registration, read
- `apps/api/src/permissions/roles.controller.ts` — controller pattern, read

**US-002**
- `apps/api/src/permissions/catalog.ts` — `PERMISSION_CATALOG`, read
- `apps/api/src/permissions/entry-matcher.ts` — `expandEntries`, read
- `apps/api/src/permissions/dto/role.dto.ts` — `RoleDto`, edited
- `apps/api/src/permissions/dto/role-binding.dto.ts` — `ListRoleBindingsQuery`, edited
- `apps/api/src/permissions/role-bindings.controller.ts` — filter mapping, edited

**US-003**
- `apps/api/src/projects/members/project-members.service.ts` — `list`, edited
- `apps/api/src/projects/members/prisma-project-members.repository.ts` — `findMemberPage`, edited
- `apps/api/src/permissions/legacy-membership.queries.ts` — `listProjectMemberships`, read
- `apps/api/src/permissions/role-admin.service.ts` — gains `listProjectRoles`, edited
- `apps/api/src/projects/members/dto/project-member.dto.ts` — edited

**US-004**
- `apps/api/src/permissions/role-admin.service.ts` — gains `assertMayGrant`, edited
- `apps/api/src/projects/members/project-members.service.ts` — `add`, edited
- `apps/api/src/projects/members/dto/add-member.dto.ts` — edited
- `apps/api/src/users/dto/create-user.dto.ts` — edited

**US-005**
- `apps/api/src/projects/invites/project-invites.service.ts` — edited
- `apps/api/src/projects/invites/invite-acceptance.service.ts` — edited
- `apps/api/src/projects/invites/prisma-project-invites.repository.ts` — edited
- `apps/api/prisma/schema.prisma` — `ProjectInvite`, `Role`, edited
- `apps/api/src/permissions/role-admin.service.ts` — `assertMayGrant` added by US-004, used here

**US-006**
- `apps/web/composables/useProjectViewerRole.ts` — the SSR fetch pattern, read
- `apps/web/layouts/default.vue` — admin links, edited
- `apps/web/components/CommandPalette.vue` — edited
- `apps/web/tests/helpers/mount-sfc.ts` — auto-import overrides, edited

**US-007**
- `apps/web/lib/permissions.ts` — created by US-006, used here
- `apps/web/pages/[project]/tickets/[ref].vue` — edited
- `apps/web/components/TicketProperties.vue` — edited
- `apps/web/pages/[project]/labels.vue` — edited
- `apps/web/components/SettingsKnowledgeCard.vue` — edited

**US-008**
- `apps/web/lib/permissions.ts` — created by US-006, used here
- `apps/web/lib/fleet-jobs.ts` — `JobViewer`, edited
- `apps/web/components/fleet/BudgetTable.vue` — edited
- `apps/web/pages/[project]/fleet/budgets.vue` — edited
- `apps/web/pages/[project]/fleet/repos/[id]/config.vue` — edited

**US-009**
- `apps/web/lib/permissions.ts` — created by US-006, used here
- `apps/web/lib/fleet-schedules.ts` — `ScheduleViewer`, edited
- `apps/web/lib/fleet-approvals.ts` — `ApprovalViewer`, edited
- `apps/web/composables/useApprovalNotifications.ts` — edited
- `apps/web/pages/admin/fleet/approvals.vue` — edited

**US-010**
- `apps/web/pages/admin/users.vue` — admin page pattern, read
- `apps/web/components/CreateUserDialog.vue` — dialog pattern, read
- `apps/web/composables/usePermissions.ts` — created by US-006, used here
- `apps/web/layouts/default.vue` — nav link, edited

**US-011**
- `apps/web/pages/admin/users.vue` — edited
- `apps/web/composables/useAdminUsers.ts` — read
- `apps/web/components/CreateUserDialog.vue` — edited
- `apps/web/composables/usePermissions.ts` — created by US-006, used here

**US-012**
- `apps/web/pages/agents.vue` — edited
- `apps/web/components/CreateAgentDialog.vue` — edited
- `apps/web/components/PrincipalRolesDialog.vue` — created by US-011, used here
- `apps/web/composables/useRoleBindings.ts` — created by US-011, used here

**US-013**
- `apps/web/components/ProjectMembersPanel.vue` — edited
- `apps/web/composables/useProjectMembers.ts` — edited
- `apps/web/pages/[project]/settings.vue` — passes `projectId`, edited
- `apps/web/composables/useRoleBindings.ts` — created by US-011, used here

**US-014**
- `apps/web/components/ProjectInvitesPanel.vue` — edited
- `apps/web/composables/useProjectInvites.ts` — edited
- `apps/web/pages/invite/[token].vue` — edited
- `apps/web/composables/useProjectRoles.ts` — created by US-013, used here

**US-015**
- `apps/web/pages/[project]/agents.vue` — edited
- `apps/web/composables/useProjectAgents.ts` — edited
- `apps/web/lib/fleet-jobs.ts` — edited

### Creates

**US-001**
- `apps/api/src/projects/me-permissions.controller.ts`
- `apps/api/src/projects/dto/me-permissions.dto.ts`
- `apps/api/test/integration/permissions/me-permissions.integration.spec.ts`

**US-002**
- `apps/api/src/permissions/permission-catalog.controller.ts`
- `apps/api/src/permissions/dto/permission-catalog-entry.dto.ts`
- `apps/api/src/permissions/dto/role.dto.spec.ts`
- `apps/api/test/integration/permissions/permission-catalog.integration.spec.ts`

**US-003**
- `apps/api/src/projects/members/project-roles.controller.ts`
- `apps/api/src/projects/members/dto/project-role.dto.ts`
- `apps/api/src/projects/members/dto/member-binding.dto.ts`
- `apps/api/test/integration/projects/project-members-principals.integration.spec.ts`

**US-004**
- `apps/api/test/integration/projects/member-role-keys.integration.spec.ts`

**US-005**
- `apps/api/prisma/migrations/20261101090000_invite_role_id/migration.sql`
- `apps/api/test/integration/projects/invite-role-keys.integration.spec.ts`

**US-006**
- `apps/web/lib/permissions.ts`
- `apps/web/composables/usePermissions.ts`
- `apps/web/tests/lib/permissions.spec.ts`
- `apps/web/tests/composables/usePermissions.spec.ts`
- `apps/web/tests/layouts/default-permission-nav.spec.ts`

**US-007**
- `apps/web/tests/pages/project-permission-gates.spec.ts`

**US-008**
- `apps/web/tests/pages/fleet-job-budget-gates.spec.ts`

**US-009**
- `apps/web/tests/pages/fleet-schedule-approval-gates.spec.ts`

**US-010**
- `apps/web/pages/admin/roles.vue`
- `apps/web/composables/useRoles.ts`
- `apps/web/components/RoleEditorDialog.vue`
- `apps/web/components/PermissionMatrix.vue`
- `apps/web/tests/pages/admin-roles.spec.ts`
- `apps/web/tests/components/role-editor-dialog.spec.ts`

**US-011**
- `apps/web/composables/useRoleBindings.ts`
- `apps/web/components/PrincipalRolesDialog.vue`
- `apps/web/tests/composables/useRoleBindings.spec.ts`
- `apps/web/tests/components/principal-roles-dialog.spec.ts`

**US-012**
- `apps/web/tests/pages/agents-role-bindings.spec.ts`

**US-013**
- `apps/web/composables/useProjectRoles.ts`
- `apps/web/tests/components/project-members-principals.spec.ts`

**US-014**
- `apps/web/tests/components/project-invites-role-keys.spec.ts`

**US-015**

None.

### Modifies

**US-001**
- `apps/api/src/projects/projects.module.ts` — registers `MePermissionsController`; no test pins the controller list. The replacing invariant: every existing controller stays registered.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the api-testing rule requires every API endpoint change to be reflected here. The replacing invariant: it gains a case for the GET me permissions route; existing cases unchanged.

**US-002**
- `apps/api/src/permissions/permissions.module.ts` — registers `PermissionCatalogController` beside `RolesController` and `RoleBindingsController`. The replacing invariant: the existing providers and exports are unchanged.
- `apps/api/test/integration/permissions/role-bindings-api.integration.spec.ts` — any case asserting that `principalType` without `principalId` is a 400 now sees 200 filtered by type. The replacing invariant: `principalId` without `principalType` is still a 400; `principalType` alone lists only that type.
- `apps/api/src/permissions/membership.service.spec.ts` — `listBindings` cases pin the filter object passed to the repository. The replacing invariant: a filter with `principalType` reaches the repository unchanged; existing filters behave as before.
- `apps/api/src/permissions/test-helpers/in-memory-permissions.ts` — the in-memory binding list filters only by `principal` and `projectId` (line ~147). The replacing invariant: it also filters by `principalType`.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the api-testing rule requires every API endpoint change to be reflected here. The replacing invariant: it gains a case for the GET permissions catalog route; existing cases unchanged.

**US-003**
- `apps/api/src/projects/members/project-members.service.spec.ts` — `new ProjectMembersService(...)` and `list` cases pin today's record shape and three-argument `list`. The replacing invariant: records carry `principalType: 'USER'`, `principalId`, `agentSlug: null` and `bindings`; `list` takes `principals` (default `'users'`).
- `apps/api/src/projects/members/project-members.controller.spec.ts` — lines ~40 and ~50 assert `service.list` was called with exactly three arguments. The replacing invariant: the controller parses `principals` and passes it as the fourth argument, `'users'` when absent.
- `apps/api/src/projects/members/project-members.module.spec.ts` — compiles `ProjectMembersModule` with doubles for `MembershipService` and `PermissionService`; `ProjectRolesController` needs `RoleAdminService`. The replacing invariant: a `RoleAdminService` `useValue` double is provided and exported beside them.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the api-testing rule requires every API endpoint change to be reflected here. The replacing invariant: it gains a case for the project roles route (GET on a project slug's roles); existing cases unchanged.
- `apps/api/test/integration/projects/project-members.integration.spec.ts` — asserts members with `toEqual(expect.objectContaining({ userId, role }))`. The replacing invariant: unchanged assertions still pass; no case asserts the absence of the new fields.

**US-004**
- `apps/api/src/projects/members/project-members.service.spec.ts` — `new ProjectMembersService(...)` (line ~44) has no `RoleAdminService`, and `add` cases expect the binding to be written with no `assertMayGrant` call. A `RoleAdminService` double is passed as the last constructor argument. The replacing invariant: `assertMayGrant` is called with `{ roleKey, projectId, principalType: 'USER', principalId }` before the write, and a rejection writes nothing.
- `apps/api/src/users/dto/user-dto.spec.ts` — `CreateUserDto` cases pass `role: 'MEMBER'` as required. The replacing invariant: an omitted `role` validates; `role: 'OWNER'` is still refused.

**US-005**
- `apps/api/src/projects/invites/project-invites.service.spec.ts` — `new ProjectInvitesService(...)` at line ~92 has no `RoleAdminService`, and invite DTO expectations pin `role` only. The replacing invariant: a `RoleAdminService` double whose `assertMayGrant` resolves is passed last; DTOs carry `roleKey` and `roleName`.
- `apps/api/src/common/test-helpers/global-stubs.module.ts` — `GlobalStubsModule` (used by the invites module spec) exports no `RoleAdminService`, which `ProjectInvitesService` now injects. The replacing invariant: it provides and exports a `RoleAdminService` `useValue` double; every existing stub is unchanged.
- `apps/api/test/integration/projects/project-invites-admin.integration.spec.ts` — line ~196 pins an invite row's keys to exactly seven. The replacing invariant: exactly nine keys, adding `roleKey` and `roleName`, still with no `token` or `tokenHash`.
- `apps/api/src/projects/invites/dto/create-invite.dto.spec.ts` — `check(email, role = 'DEVELOPER')` and the case requiring `role`. The replacing invariant: both `role` and `roleKey` are optional in the DTO (the exactly-one rule is the service's); an unknown `role` is still `isIn` and a malformed `roleKey` fails `ROLE_KEY_PATTERN`.
- `apps/api/src/projects/invites/invite-acceptance.service.spec.ts` — acceptance binds `ROLE_KEY_FOR_LEGACY_ROLE[invite.role]`. The replacing invariant: a row with `roleId` binds that role's key; a row without `roleId` binds the legacy mapping.
- `apps/api/src/projects/invites/prisma-project-invites.repository.spec.ts` — the create input and record shape lack `roleId`. The replacing invariant: `create` takes `roleId` and `role: string | null`; records carry `roleId`, `roleKey` and `roleName`.
- `apps/api/src/projects/invites/invite-mailer.spec.ts` — the template input carries `role`. The replacing invariant: it carries `roleName`, which the email body shows.
- `apps/api/test/integration/projects/project-invites-public.integration.spec.ts` — line ~155 pins the preview keys to exactly six. The replacing invariant: exactly eight keys, adding `roleKey` and `roleName`.
- `openapi.json` — records the routes and DTOs this feature changes. The replacing invariant: regenerated with `bun run api:export-spec` after the last API change; every other path and schema unchanged.

**US-006**
- `apps/web/tests/helpers/mount-sfc.ts` — the auto-import override list (line ~125) lacks `useGlobalPermissions` and `useProjectPermissions`. The replacing invariant: both are overridable like the existing composables.
- `apps/web/tests/layouts/default-fleet-nav.spec.ts` — renders the admin fleet links for `user.role === 'ADMIN'`. The replacing invariant: each link renders when the global set holds its key, whatever `user.role` says.
- `apps/web/tests/layouts/default-skills-nav.spec.ts` — renders the skills link for a global ADMIN. The replacing invariant: it renders with `skill.source.read` in the global set.
- `apps/web/tests/layouts/default.spec.ts` — admin-link cases keyed on `role`. The replacing invariant: they are keyed on the global set.
- `apps/web/tests/layouts/threads-nav.spec.ts` — runs the layout script with a closed `__auto` bag (line ~48) that has no `useGlobalPermissions`. The replacing invariant: it supplies `useGlobalPermissions` (an empty set unless the case needs a key); its assertions are unchanged.
- `apps/web/tests/layouts/my-threads-nav.spec.ts` — runs the layout script with a closed `__auto` bag (line ~42) that has no `useGlobalPermissions`. The replacing invariant: it supplies `useGlobalPermissions` (an empty set unless the case needs a key); its assertions are unchanged.
- `apps/web/tests/layouts/default-slos-nav.spec.ts` — renders the layout with a fixed setup context. The replacing invariant: it supplies `useGlobalPermissions` (an empty set unless the case needs a key); its assertions are unchanged.
- `apps/web/tests/layouts/code-intel-nav.spec.ts` — renders the layout with a fixed setup context. The replacing invariant: it supplies `useGlobalPermissions` (an empty set unless the case needs a key); its assertions are unchanged.
- `apps/web/tests/layouts/memory-nav.spec.ts` — renders the layout with a fixed setup context. The replacing invariant: it supplies `useGlobalPermissions` (an empty set unless the case needs a key); its assertions are unchanged.
- `apps/web/tests/layouts/timeline-nav.spec.ts` — renders the layout with a fixed setup context. The replacing invariant: it supplies `useGlobalPermissions` (an empty set unless the case needs a key); its assertions are unchanged.
- `apps/web/tests/layouts/fleet-jobs-nav.spec.ts` — renders the layout with a fixed setup context. The replacing invariant: it supplies `useGlobalPermissions` (an empty set unless the case needs a key); its assertions are unchanged.
- `apps/web/tests/layouts/project-agents-nav.spec.ts` — renders the layout with a fixed setup context. The replacing invariant: it supplies `useGlobalPermissions` (an empty set unless the case needs a key); its assertions are unchanged.
- `apps/web/tests/components/command-palette-threads.spec.ts` — mounts `CommandPalette` (line ~77) with no `useGlobalPermissions` override. The replacing invariant: it supplies `useGlobalPermissions` (an empty set unless the case needs a key); its assertions are unchanged.
- `apps/web/tests/components/command-palette-my-threads.spec.ts` — mounts `CommandPalette` (line ~77) with no `useGlobalPermissions` override. The replacing invariant: it supplies `useGlobalPermissions` (an empty set unless the case needs a key); its assertions are unchanged.
- `apps/web/tests/components/command-palette-skills.spec.ts` — offers `skills` for `role: 'ADMIN'`. The replacing invariant: offered with `skill.source.read`.
- `apps/web/i18n/locales/en.json` — US-006 adds its new UI strings. The replacing invariant: existing keys unchanged; the used-keys-exist spec finds every new key.
- `apps/web/i18n/locales/zh.json` — US-006 adds its new UI strings. The replacing invariant: existing keys unchanged; the locale-parity specs pass.
- `apps/web/tests/pages/fleet-analytics-page.spec.ts` — the ingest link follows `role === 'ADMIN'`. The replacing invariant: it follows `fleet.ingest.read` in the global set.

**US-007**
- `apps/web/tests/pages/ticket-role-visibility.spec.ts` — drives `canWork` / `canManage` through `useProjectViewerRole`. The replacing invariant: each control follows its key from `useProjectPermissions`.
- `apps/web/tests/pages/ticket-detail.spec.ts` — mounts `TicketProperties` with `canWork`/`canManage`. The replacing invariant: it passes the five key props.
- `apps/web/tests/pages/ticket-fleet-wiring.spec.ts` — the dispatch suggestion and `TicketFleetRuns.canWork` follow DEVELOPER. The replacing invariant: they follow `fleet.job.dispatch` and `fleet.ticket-job.unlink`.
- `apps/web/tests/components/ticket-detail-redesign.spec.ts` — mounts `TicketProperties` with `canWork`/`canManage`. The replacing invariant: the five key props.
- `apps/web/tests/components/assignee-picker.spec.ts` — reaches the picker through `canWork`. The replacing invariant: through `canAssign`.
- `apps/web/tests/pages/labels.spec.ts` — create/edit/delete follow `canManage`/DEVELOPER. The replacing invariant: they follow `label.create`, `label.update`, `label.delete`.
- `apps/web/tests/pages/threads-page.spec.ts` — the new-thread link follows `canWorkOnFleet`. The replacing invariant: it follows `thread.create`.
- `apps/web/tests/pages/threads-detail-page.spec.ts` — `canManage` from `useProjectViewerRole`. The replacing invariant: from `thread.archive`.
- `apps/web/tests/pages/threads-detail-actions-page.spec.ts` — `canManage` from `useProjectViewerRole`. The replacing invariant: from `thread.archive`.
- `apps/web/tests/pages/threads-new-page.spec.ts` — mocks `useProjectViewerRole`. The replacing invariant: mocks `useProjectPermissions`.
- `apps/web/tests/components/ProjectSkillsPanel.spec.ts` — toggles follow `canManage`. The replacing invariant: they follow `skill.project.enable` / `skill.project.disable`.
- `apps/web/tests/components/settings-knowledge-card.spec.ts` — admin controls follow `role === 'ADMIN'`. The replacing invariant: they follow `fleet.knowledge.patterns.update` and `fleet.knowledge.repo.reindex` in the project set.
- `apps/web/tests/pages/settings-skills-tab.spec.ts` — mocks `useProjectViewerRole`. The replacing invariant: mocks `useProjectPermissions`.
- `apps/web/tests/pages/agents.spec.ts` — the project agents page's status menu follows `canManage`. The replacing invariant: it follows `agent.update` in the global set.

**US-008**
- `apps/web/tests/lib/fleet-jobs.spec.ts` — `canWorkOnFleet`, `canCancelJob`, `canRequeueJob` over `{ userId, canWork }`. The replacing invariant: over `{ userId, canCancel, canRequeue, canDispatch }`; `canWorkOnFleet` cases stay until US-015 deletes it.
- `apps/web/tests/pages/fleet-job-detail.spec.ts` — `JobViewer.canWork` and `ConfigJobPanel` `canWork`. The replacing invariant: key-derived viewer; `ConfigJobPanel` `canWork` = `fleet.job.config.edit`.
- `apps/web/tests/pages/fleet-job-detail-workflow.spec.ts` — mocks `useProjectViewerRole`. The replacing invariant: mocks `useProjectPermissions`.
- `apps/web/tests/pages/fleet-jobs-list.spec.ts` — the dispatch button follows `canWorkOnFleet`. The replacing invariant: it follows `fleet.job.dispatch`.
- `apps/web/tests/pages/fleet-dispatch-page.spec.ts` — the no-permission notice follows `canWorkOnFleet`. The replacing invariant: it follows `fleet.job.dispatch`.
- `apps/web/tests/pages/fleet-dispatch-placement-runtime.spec.ts` — mocks `useProjectViewerRole`. The replacing invariant: mocks `useProjectPermissions`.
- `apps/web/tests/pages/fleet-repo-config-page.spec.ts` — `canWork` from `useProjectViewerRole`. The replacing invariant: save/new-file/editor follow `fleet.job.config.edit`, drift follows `fleet.repo.drift.check`.
- `apps/web/tests/pages/fleet-budgets-project-page.spec.ts` — `canManage` from `useProjectViewerRole`. The replacing invariant: create/edit/resume follow `fleet.budget.create`/`update`/`resume`.
- `apps/web/tests/components/fleet-budget-table.spec.ts` — drives resume, edit and delete through `editable`. The replacing invariant: each action follows its own prop (`canResume`, `canEdit`, `canDelete`).
- `apps/web/tests/pages/admin-fleet-budgets.spec.ts` — the admin table is always editable. The replacing invariant: its actions follow `fleet.budget.resume`/`update`/`delete` in the global set.

**US-009**
- `apps/web/tests/lib/fleet-schedules.spec.ts` — `canChangeSchedule` over `{ canWork, canManage }`. The replacing invariant: over `{ canCreate, canUpdateAny, canUpdateOwn }`.
- `apps/web/tests/lib/fleet-approvals.spec.ts` — `canDecide` over `{ canManage, canWork }`, and admin viewers always decide (lines ~125-126). The replacing invariant: both kinds decide by `{ canDecideBudget, canDecideBash }`.
- `apps/web/tests/components/fleet-approval-inbox.spec.ts` — project viewers `{ canManage, canWork }` and admin fixtures `{ kind: 'admin', userId: null }` (lines ~505-540). The replacing invariant: both kinds carry `{ canDecideBudget, canDecideBash }`.
- `apps/web/tests/components/fleet-approval-action-panel.spec.ts` — builds an `ApprovalViewer`. The replacing invariant: the new project-kind shape.
- `apps/web/tests/components/fleet-approval-bash-panel.spec.ts` — builds an `ApprovalViewer`. The replacing invariant: the new project-kind shape.
- `apps/web/tests/components/fleet-approval-budget-panel.spec.ts` — builds an `ApprovalViewer`. The replacing invariant: the new project-kind shape.
- `apps/web/tests/components/thread-action-card.spec.ts` — builds an `ApprovalViewer`. The replacing invariant: the new project-kind shape.
- `apps/web/tests/components/fleet-approval-badge.spec.ts` — `globalAdmin` from `role === 'ADMIN'` and project viewers from the members read. The replacing invariant: `fleet.approval.read` in the global set; project viewers from the project-scoped me/permissions read.
- `apps/web/tests/components/fleet-schedule-table.spec.ts` — `ScheduleViewer` `{ canWork, canManage }`. The replacing invariant: the new shape.
- `apps/web/tests/pages/fleet-schedules-list-page.spec.ts` — viewer from `useProjectViewerRole`. The replacing invariant: from `useProjectPermissions`.
- `apps/web/tests/pages/fleet-schedule-detail.spec.ts` — viewer from `canWorkOnFleet`. The replacing invariant: from keys.
- `apps/web/tests/pages/fleet-approvals-pages.spec.ts` — project viewer from `useProjectViewerRole`. The replacing invariant: the project page builds its viewer from `useProjectPermissions`, and the admin page passes `{ kind: 'admin', userId, canDecideBudget, canDecideBash }` from the global set (lines ~131 and ~150).
- `apps/web/components/fleet/ScheduleTable.vue` — takes `ScheduleViewer`. The replacing invariant: the new shape, same rendering rules.
- `apps/web/components/fleet/ApprovalInbox.vue` — takes `ApprovalViewer`. The replacing invariant: the new viewer shape.

**US-010**
- `apps/web/tests/layouts/default.spec.ts` — the admin link list. The replacing invariant: it also renders the admin roles link with `role.read` in the global set.
- `apps/web/tests/helpers/mount-sfc.ts` — the `NUXT_AUTO_IMPORTS` override list lacks `useRoles`. The replacing invariant: it is overridable like the existing composables.
- `apps/web/i18n/locales/en.json` — US-010 adds its new UI strings. The replacing invariant: existing keys unchanged; the used-keys-exist spec finds every new key.
- `apps/web/i18n/locales/zh.json` — US-010 adds its new UI strings. The replacing invariant: existing keys unchanged; the locale-parity specs pass.

**US-011**
- `apps/web/tests/pages/admin-users.spec.ts` — the MEMBER/ADMIN select calls `setRole`. The replacing invariant: the role column renders binding chips and "Edit roles" opens `PrincipalRolesDialog`; no case expects a `role` PATCH.
- `apps/web/tests/helpers/mount-sfc.ts` — the `NUXT_AUTO_IMPORTS` override list lacks `useRoleBindings`. The replacing invariant: it is overridable like the existing composables.
- `apps/web/i18n/locales/en.json` — US-011 adds its new UI strings. The replacing invariant: existing keys unchanged; the used-keys-exist spec finds every new key.
- `apps/web/i18n/locales/zh.json` — US-011 adds its new UI strings. The replacing invariant: existing keys unchanged; the locale-parity specs pass.
- `apps/web/tests/components/create-user-dialog.spec.ts` — submits `role: 'ADMIN'` / `'MEMBER'`. The replacing invariant: the dialog has no role field and posts `{ email, name, password }`.

**US-012**
- `apps/web/tests/pages/agents.actions.spec.ts` — the "Edit roles" action opens `EditAgentRolesDialog`. The replacing invariant: it opens `PrincipalRolesDialog` for the agent.
- `apps/web/tests/pages/agents-standalone.spec.ts` — the roles column renders `agent.roles`. The replacing invariant: it renders the agent's global binding chips.
- `apps/web/tests/components/agents-page-wiring.spec.ts` — wires `EditAgentRolesDialog`. The replacing invariant: wires `PrincipalRolesDialog`.
- `apps/web/tests/components/CreateAgentDialog.spec.ts` — selects roles before submit. The replacing invariant: the dialog has no roles field and posts without `roles`.
- `apps/web/tests/components/create-agent-dialog-validation.spec.ts` — "roles required" validation. The replacing invariant: no roles validation; other validations unchanged.
- `apps/web/tests/components/api-submission.spec.ts` — the create body includes `roles`. The replacing invariant: it omits `roles`.
- `apps/web/i18n/locales/en.json` — US-012 adds its new UI strings. The replacing invariant: existing keys unchanged; the used-keys-exist spec finds every new key.
- `apps/web/i18n/locales/zh.json` — US-012 adds its new UI strings. The replacing invariant: existing keys unchanged; the locale-parity specs pass.

**US-013**
- `apps/web/tests/components/ProjectMembersPanel.spec.ts` — role buttons ADMIN/DEVELOPER/VIEWER and `changeRole`. The replacing invariant: binding chips, the role select from project roles, and role-binding writes.
- `apps/web/tests/components/project-members-disabled.spec.ts` — disabled users show no role switch. The replacing invariant: disabled users show no chip edit controls.
- `apps/web/tests/composables/useProjectMembers.spec.ts` — `add(email, role)` posts `{ email, role }` and records are `ProjectMember`. The replacing invariant: `add(email, roleKey)` posts `{ email, roleKey }`; rows are `ProjectPrincipalRow`; the `changeRole` and `remove` cases are deleted with those methods.
- `apps/web/tests/composables/useProjectMemberNames.spec.ts` — record fixtures. The replacing invariant: fixtures may carry the new fields; `nameOf` is unchanged.
- `apps/web/tests/helpers/mount-sfc.ts` — the `NUXT_AUTO_IMPORTS` override list lacks `useProjectRoles`. The replacing invariant: it is overridable like the existing composables.
- `apps/web/i18n/locales/en.json` — US-013 adds its new UI strings. The replacing invariant: existing keys unchanged; the used-keys-exist spec finds every new key.
- `apps/web/i18n/locales/zh.json` — US-013 adds its new UI strings. The replacing invariant: existing keys unchanged; the locale-parity specs pass.

**US-014**
- `apps/web/tests/components/ProjectInvitesPanel.spec.ts` — the role select offers `INVITE_ROLES` and posts `{ email, role }`. The replacing invariant: it offers project roles and posts `{ email, roleKey }`; invites show `roleName`.
- `apps/web/tests/composables/useProjectInvites.spec.ts` — `create(email, role)`. The replacing invariant: `create(email, roleKey)` posts `{ email, roleKey }`.
- `apps/web/tests/pages/invite-accept.spec.ts` — the preview shows `role`. The replacing invariant: it shows `roleName`.
- `apps/web/i18n/locales/en.json` — US-014 adds its new UI strings. The replacing invariant: existing keys unchanged; the used-keys-exist spec finds every new key.
- `apps/web/i18n/locales/zh.json` — US-014 adds its new UI strings. The replacing invariant: existing keys unchanged; the locale-parity specs pass.

**US-015**
- `apps/web/tests/components/edit-agent-roles-dialog.spec.ts` — tests the deleted dialog. Deleted with it.
- `apps/web/tests/components/AddProjectAgentDialog.spec.ts` — tests the deleted dialog. Deleted with it.
- `apps/web/tests/composables/useProjectAgents.spec.ts` — `add`/`remove` cases. The replacing invariant: the `load`, `refresh` and `changeStatus` cases stay; `add`/`remove` cases are deleted.
- `apps/web/tests/composables/useAdminUsers.spec.ts` — `setRole` cases. The replacing invariant: deleted; `load`, `createUser`, `setDisabled` cases stay.
- `apps/web/tests/lib/fleet-jobs.spec.ts` — `canWorkOnFleet` cases. The replacing invariant: deleted; the rest stay.
- `apps/web/tests/helpers/mount-sfc.ts` — lists `useProjectViewerRole`. The replacing invariant: the name is removed from the override list.
- `apps/web/tests/pages/loading-states.spec.ts` — reads the project agents page, whose roster add/remove UI is removed. The replacing invariant: its loading-state assertions still hold for the page.

### Seams

- **US-001 → US-006:** `GET /me/permissions` is consumed by `useGlobalPermissions` / `useProjectPermissions`. US-006 AC 4 and AC 6 assert the exact path and query the composables send; US-001 AC 1 and AC 2 assert the response shape they read.
- **US-002 → US-010, US-011:** `GET /permissions/catalog`, `RoleDto.expandedKeys` and `GET /role-bindings?principalType=&scope=global` are consumed by the roles page and `useRoleBindings`. US-010 AC 3 and AC 5 and US-011 AC 1 assert the requests and the fields read.
- **US-003 → US-013:** `GET /projects/:slug/members?principals=all` and `GET /projects/:slug/roles` are consumed by `ProjectMembersPanel`; US-013 AC 1 and AC 3 assert the requests and fields read.
- **US-003 `listProjectRoles` → its route:** US-003 AC 2 stubs `RoleAdminService.listProjectRoles`, calls `GET /projects/:slug/roles`, and asserts the stub was called once and its roles returned.
- **US-004 `assertMayGrant` → member and invite routes:** US-004 AC 2 and US-005 AC 2 enter at `POST /projects/:slug/members` and `POST /projects/:slug/invites` and assert the escalation refusal writes nothing; US-004 AC 3 asserts the call arguments with a spy.
- **US-004, US-005 → US-011, US-013, US-014:** the role-less `POST /admin/users`, `roleKey` on `POST /members` and `POST /invites`, and `InviteDto.roleName`; US-011 AC 9, US-013 AC 3 and US-014 AC 1 and AC 2 assert the bodies and fields.
- **US-006 → US-007 … US-014:** `permissionSet`, `useProjectPermissions`, `useGlobalPermissions`. Each consuming story's gate ACs mount the real page with `$api.get('/me/permissions', …)` answering the keys, not a stubbed `PermissionSet`.
- **US-011 → US-012:** `PrincipalRolesDialog` and `useRoleBindings`; US-012 AC 2 opens the dialog from the agents page and asserts its `POST /role-bindings` body.

## Acceptance Criteria

Wording:
- "As `<who>`" means the request carries that principal's token. "A developer of `p`" holds only the baseline `member` binding and a `developer` binding in project `p`.
- Web: "the set holds `k`" means `$api.get('/me/permissions', …)` answers `{ keys: [k, …] }` for that scope; "mounted" means the real SFC through `tests/helpers/mount-sfc.ts`.

### US-001: `GET /me/permissions` returns the caller's effective keys (`Workdir: apps/api`)

1. [integration] As a user holding only the baseline `member` binding, `GET /api/me/permissions` answers 200 with `scope: 'global'`, `projectSlug: null`, and `keys` equal to the ascending-sorted `expandEntries` of the `member` role's entries.
2. [integration] As a developer of `p`, `GET /api/me/permissions?project=<p.slug>` answers `scope: 'project'`, `projectSlug: p.slug`, and `keys` that include `ticket.create` and `comment.update.own` and exclude `ticket.delete`.
3. [integration] As a user with a global `admin` binding and no binding in `p`, `GET /api/me/permissions?project=<p.slug>` answers `keys` that include `ticket.delete` and `role.binding.manage`.
4. [integration] As an agent holding a `developer` binding in `p`, `GET /api/me/permissions?project=<p.slug>` answers `keys` that include `ticket.create`.
5. [integration] As a user with a global `owner` binding, `GET /api/me/permissions` answers `keys` that exclude the implicit key `auth.me.read` and the public key `session.login`.
6. [integration] `GET /api/me/permissions?project=no-such-project` answers 404 with error key `projects`.
7. [integration] As a user with no binding in `p` and no global admin binding, `GET /api/me/permissions?project=<p.slug>` answers 403 with error key `projects`.
8. [integration] `GET /api/me/permissions?project=` (an empty value) answers 400 validation.

### US-002: Permission catalog route, `RoleDto.expandedKeys`, binding list filters (`Workdir: apps/api`)

1. [integration] As a global `admin`, `GET /api/permissions/catalog` answers 200 with one entry per `PERMISSION_CATALOG` entry whose `access` is `'role'`, sorted by `key`.
2. [integration] In that catalog response, the `ticket.delete` entry equals `{ key: 'ticket.delete', scope: 'project', risk: 'high', principals: ['user', 'agent'], ownable: false }` and the `comment.update` entry has `ownable: true`.
3. [integration] As a user holding only the baseline `member` binding, `GET /api/permissions/catalog` answers 403 with error key `permissions`.
4. [integration] As a global `admin`, `GET /api/roles` returns the `developer` role with `expandedKeys` sorted ascending, including `ticket.create` and `comment.update.own` and excluding `ticket.delete`.
5. [unit] `RoleDto.from` for a role whose `permissions` is `['no.such.key']` returns `expandedKeys: []` and the stored `permissions` unchanged.
6. [integration] As a global `admin`, with two agents and one user each holding a global binding, `GET /api/role-bindings?principalType=AGENT` returns only the two agents' bindings.
7. [integration] As a global `admin`, with one user holding a global `admin` binding and a `developer` binding in `p`, `GET /api/role-bindings?principalType=USER&principalId=<id>&scope=global` returns only the global binding.
8. [integration] `GET /api/role-bindings?principalId=<id>` without `principalType` answers 400 validation.
9. [integration] `GET /api/role-bindings?scope=project` answers 400 validation.
10. [integration] `GET /api/role-bindings?scope=global&projectId=<p.id>` answers 400 with error key `permissions.scopeAndProject`.

### US-003: Project roles route and the unified members list (`Workdir: apps/api`)

1. [integration] As a viewer of `p`, `GET /api/projects/<p.slug>/roles` answers 200 with every PROJECT-scope role, system roles first then by `key`, each with exactly `id`, `key`, `name`, `description` and `system`, and no GLOBAL role.
2. [integration] With `RoleAdminService.listProjectRoles` spied to resolve one role, `GET /api/projects/<p.slug>/roles` as a viewer of `p` calls the spy once and answers that one role.
3. [integration] As a user with no access to `p`, `GET /api/projects/<p.slug>/roles` answers 403.
4. [integration] As a viewer of `p`, `GET /api/projects/<p.slug>/members` (no `principals`) returns only user rows, each with `principalType: 'USER'`, `principalId` equal to `userId`, and `agentSlug: null`.
5. [integration] With a user holding `developer` and `triager` bindings in `p`, that user's row has `bindings` of two entries, ordered by binding `createdAt`, with the bindings' ids, `roleKey` `developer` and `triager`, and each role's `name` as `roleName`.
6. [integration] With an agent holding a `reviewer` binding in `p`, `GET /api/projects/<p.slug>/members?principals=all` returns the user rows followed by one agent row with `principalType: 'AGENT'`, `userId: null`, `email: null`, the agent's `slug` as `agentSlug`, its `name`, `disabled: false` and one `reviewer` binding; `total` counts the users and the agent.
7. [integration] With an agent holding a `reviewer` binding in every project (`projectId` null) and none in `p`, `GET /api/projects/<p.slug>/members?principals=all` has no row for that agent.
8. [integration] With a user whose only source in `p` is a legacy `ProjectMember` row of role `DEVELOPER`, that user's row has one binding entry `{ id: null, roleKey: 'developer', roleName: <developer role name> }`.
9. [integration] `GET /api/projects/<p.slug>/members?principals=agents` answers 400 validation.
10. [integration] With `principals=all`, `size=1` and two users plus one agent in `p`, `current=3` returns the agent row and `hasNext: false`.

### US-004: Member adds take a role key through the grant rules (`Workdir: apps/api`)

1. [integration] As a Project Admin of `p`, `POST /api/projects/<p.slug>/members { email, roleKey: 'triager' }` answers 201 and the user holds a `triager` binding in `p` and no other binding there.
2. [integration] As a user holding a custom PROJECT role in `p` whose entries are `['member.add', 'member.read', 'project.read']`, `POST /api/projects/<p.slug>/members { email, roleKey: 'developer' }` answers 403 with error key `permissions.escalation`, and the target user has no binding in `p`.
3. [unit] `ProjectMembersService.add` with `{ email, roleKey: 'triager' }` calls `RoleAdminService.assertMayGrant` once with `{ roleKey: 'triager', projectId, principalType: 'USER', principalId: <user id> }` before `MembershipService.createBinding`, and when `assertMayGrant` rejects, `createBinding` is not called.
4. [integration] `POST /api/projects/<p.slug>/members { email, role: 'DEVELOPER', roleKey: 'developer' }` answers 400 with error key `members.roleAndRoleKey`.
5. [integration] `POST /api/projects/<p.slug>/members { email, roleKey: 'no-such-role' }` as a Project Admin answers 404 with error key `permissions.roleNotFound`.
6. [integration] As a user holding a custom PROJECT role in `p` whose entries are `['member.add', 'member.read', 'project.read']`, `POST /api/projects/<p.slug>/members { email, role: 'DEVELOPER' }` (legacy field only) answers 403 with error key `permissions.escalation`, and the target user has no binding in `p`.
7. [integration] As a Project Admin of `p`, `POST /api/projects/<p.slug>/members { email, roleKey: 'admin' }` (a GLOBAL role) answers 400 with error key `permissions.scopeMismatch`.
8. [integration] As a Project Admin of `p`, `POST /api/projects/<p.slug>/members { email: <the caller's own email>, roleKey: 'viewer' }` answers 403 with error key `permissions.selfBinding`.
9. [integration] The 201 response of AC 1 carries `principalType: 'USER'`, `principalId` equal to `userId`, and `bindings` of exactly one entry `{ id: <the new binding's id>, roleKey: 'triager', roleName: <triager role name> }`.
10. [integration] As a global `admin`, `POST /api/admin/users { email, name, password }` without `role` answers 201, and the user's `User.role` is `'MEMBER'`.

### US-005: Invites carry a role key (`Workdir: apps/api`)

1. [integration] As a Project Admin of `p`, `POST /api/projects/<p.slug>/invites { email: <new address>, roleKey: 'triager' }` answers `outcome: 'INVITED'`, the stored invite's `roleId` is the `triager` role's id and its `role` is null, and the returned `invite` has `roleKey: 'triager'` and `roleName` equal to that role's name.
2. [integration] As a user holding a custom PROJECT role in `p` whose entries are `['invite.create', 'invite.read', 'project.read']`, `POST /api/projects/<p.slug>/invites { email: <new address>, roleKey: 'developer' }` answers 403 with error key `permissions.escalation`, and no `ProjectInvite` row exists for that address.
3. [integration] `POST /api/projects/<p.slug>/invites { email }` with neither `role` nor `roleKey` answers 400 with error key `invites.roleRequired`, and with both answers 400 with error key `invites.roleAndRoleKey`.
4. [integration] As a Project Admin, `POST /api/projects/<p.slug>/invites { email: <existing user's email>, roleKey: 'verifier' }` answers `outcome: 'ADDED'`, and the user holds a `verifier` binding in `p`.
5. [integration] Accepting (`POST /api/invites/<token>/accept`) an invite created with `roleKey: 'triager'` creates the user with a `triager` binding in `p`.
6. [integration] Accepting an invite row with `roleId` null and `role` `'VIEWER'` creates the user with a `viewer` binding in `p`.
7. [integration] Accepting an invite whose `roleId` and `role` are both null answers 409 with error key `invites.roleGone`, and no user exists for the invite's email.
8. [integration] Deleting the custom role an unaccepted invite names (`DELETE /api/roles/<id>`) answers 204 and the invite's `roleId` becomes null.
9. [integration] `GET /api/invites/<token>` (the preview) answers exactly the keys `projectName`, `projectSlug`, `email`, `role`, `roleKey`, `roleName`, `inviterName` and `expiresAt`, with `roleKey: 'triager'` for an invite created with that key.
10. [integration] The `ADDED` response of AC 4 carries a `member` whose `bindings` hold exactly one entry with `roleKey: 'verifier'` and the new binding's id.
11. [integration] As a Project Admin of `p`, `POST /api/projects/<p.slug>/invites { email: <the caller's own email>, roleKey: 'viewer' }` answers 403 with error key `permissions.selfBinding`, and the caller's bindings are unchanged.
12. [integration] `POST /api/projects/<p.slug>/invites { email: <new address>, roleKey: 'no-such-role' }` as a Project Admin answers 404 with error key `permissions.roleNotFound`, and no `ProjectInvite` row exists for that address.

### US-006: Web permission sets and the global gates (`Workdir: apps/web`)

1. [unit] `permissionSet(['ticket.create']).has('ticket.create')` is true and `.has('ticket.delete')` is false.
2. [unit] `permissionSet(['comment.update.own'])` gives `hasOwn('comment.update')` true and `has('comment.update')` false, and `permissionSet(['comment.update']).hasOwn('comment.update')` is true.
3. [unit] `EMPTY_PERMISSIONS.has('ticket.read')` and `EMPTY_PERMISSIONS.hasOwn('ticket.read')` are both false.
4. [unit] `useProjectPermissions('web')` calls `$api.get('/me/permissions', { query: { project: 'web' } })` and its `permissions.value.has(k)` is true for a key `k` the response lists.
5. [unit] When `$api.get('/me/permissions', …)` rejects, `useProjectPermissions('web').permissions.value` is `EMPTY_PERMISSIONS` and `error.value` is the rejection.
6. [unit] `useGlobalPermissions()` calls `$api.get('/me/permissions')` with no query, under the `useAsyncData` key `permissions-global`, while `useProjectPermissions('web')` uses the key `permissions-project-web`.
7. [unit] `layouts/default.vue` mounted with the global set holding only `user.read` renders the `/admin/users` link and none of the `/admin/fleet*` or `/admin/skills` links.
8. [unit] `layouts/default.vue` mounted with `auth.user.role` `'ADMIN'` and an empty global set renders none of the admin links of the gate table and no "Admin" section label.
9. [unit] `layouts/default.vue` mounted with the global set holding `fleet.dashboard.read`, `fleet.runner.read`, `fleet.repo.read`, `fleet.budget.read`, `fleet.approval.read`, `fleet.analytics.read` and `skill.source.read`, and not `user.read`, renders the links `/admin/fleet`, `/admin/fleet/runners`, `/admin/fleet/repos`, `/admin/fleet/budgets`, `/admin/fleet/approvals`, `/admin/fleet/analytics` and `/admin/skills`, and no `/admin/users` link.
10. [unit] `CommandPalette` mounted with the global set holding `skill.source.read` lists a command with id `skills`, and with an empty set does not.
11. [unit] `pages/[project]/fleet/analytics.vue` passes `admin: true` to `FleetAnalyticsIngestNotice` when the global set holds `fleet.ingest.read`, and `admin: false` when it does not.

### US-007: Web project gates (`Workdir: apps/web`)

1. [unit] `pages/[project]/tickets/[ref].vue` mounted with the project set holding only `ticket.assign` renders the assignee picker and no label select, link form or delete button.
2. [unit] The ticket page with the project set holding `ticket.label.assign` and not `ticket.label.remove` renders the label select and renders the label chips as non-removable.
3. [unit] The ticket page with the project set holding `ticket.link.add` renders the link form, and with `ticket.delete` renders the delete button.
4. [unit] The ticket page with the project set holding `fleet.ticket-job.unlink` passes `canWork: true` to `TicketFleetRuns`, and without it `false`.
5. [unit] The ticket page offers the fleet dispatch suggestion only when the project set holds `fleet.job.dispatch` (and the project has a fleet repo and the ticket is linkable, as today).
6. [unit] `pages/[project]/labels.vue` mounted with the project set holding `label.create` only renders the create form and no edit or delete button.
7. [unit] `pages/[project]/labels.vue` with `label.update` renders each label's edit button, and with `label.delete` its delete button.
8. [unit] `pages/[project]/threads/index.vue` renders the new-thread link when the project set holds `thread.create` and threads are enabled, and not when `thread.create` is absent; `pages/[project]/threads/new.vue` enables its create form only when the project set holds `thread.create`.
9. [unit] `pages/[project]/threads/[id].vue` passes `canManage: true` to `ThreadControls` when the project set holds `thread.archive`, and `false` when it holds only `thread.archive.own`.
10. [unit] `ProjectSkillsPanel` with the project set holding `skill.project.enable` and not `skill.project.disable` enables the toggle of a disabled skill and disables the toggle of an enabled skill.
11. [unit] `SettingsKnowledgeCard` with the project set holding `fleet.knowledge.repo.reindex` and not `fleet.knowledge.patterns.update` renders the reindex button and renders the patterns field read-only with no save button.
12. [unit] `pages/[project]/agents.vue` renders the status menu when the global set holds `agent.update`, and not when it does not.

### US-008: Web fleet job, config and budget gates (`Workdir: apps/web`)

1. [unit] `canCancelJob` for an unfinished job is true for `{ userId: 'u2', canCancel: true }` with requester `u1`, true for `{ userId: 'u1', canCancel: false }` with requester `u1`, and false for `{ userId: 'u2', canCancel: false }` with requester `u1`.
2. [unit] `canRequeueJob` for a requeueable job is true for `{ canRequeue: true }` and false for `{ canRequeue: false }`.
3. [unit] `pages/[project]/fleet/index.vue` enables the dispatch button when the project set holds `fleet.job.dispatch`, and `pages/[project]/fleet/dispatch.vue` shows its no-permission notice when it does not.
4. [unit] `pages/[project]/fleet/jobs/[id]/index.vue` with the project set holding `fleet.job.requeue` and not `fleet.job.cancel` shows requeue for a requeueable job and shows cancel only when the signed-in user is the requester.
5. [unit] The job detail page passes `canWork: true` to `ConfigJobPanel` when the project set holds `fleet.job.config.edit`, and `false` when it does not.
6. [unit] `pages/[project]/fleet/repos/[id]/config.vue` with the project set holding `fleet.repo.drift.check` and not `fleet.job.config.edit` renders the drift button, no save or new-file button, and a read-only editor.
7. [unit] `BudgetTable` renders a paused policy's resume button only with `canResume`, the edit button only with `canEdit`, and the delete button only with `canDelete`.
8. [unit] `pages/[project]/fleet/budgets.vue` with the project set holding `fleet.budget.create` and `fleet.budget.resume` only renders the create button and passes `canResume: true`, `canEdit: false` and `canDelete: false` to the budget table; `pages/admin/fleet/budgets.vue` passes the same three props from the global set.
9. [unit] `pages/[project]/fleet/budgets.vue` with an empty project set renders the read-only notice and passes `canResume`, `canEdit` and `canDelete` all `false` to both its project table and its fleet-wide table.

### US-009: Web fleet schedule and approval gates (`Workdir: apps/web`)

1. [unit] `canChangeSchedule` is true for `{ canUpdateAny: true, canUpdateOwn: false }` on another user's schedule, true for `{ canUpdateAny: false, canUpdateOwn: true, userId: 'u1' }` on a schedule created by `u1`, and false for the same viewer on a schedule created by `u2`; `canDeleteSchedule` follows `canDeleteAny` / `canDeleteOwn` by the same rule.
2. [unit] `canDecide` on a pending `budget_override_required` approval follows `canDecideBudget`, on a pending bash approval follows `canDecideBash`, and on an `assistant_action` stays true only for its requester.
3. [unit] `pages/[project]/fleet/schedules/index.vue` renders the create button when the project set holds `fleet.schedule.create`, a row's edit control when the set holds `fleet.schedule.update.own` and the signed-in user created that schedule, and that row's delete button only when the set also holds `fleet.schedule.delete` or `fleet.schedule.delete.own`.
4. [unit] `pages/[project]/fleet/schedules/[id].vue` with the project set holding `fleet.schedule.update.own` and not `fleet.schedule.delete` or `fleet.schedule.delete.own` renders the edit, enable and disable controls for a schedule the signed-in user created and no delete button.
5. [unit] `pages/[project]/fleet/schedules/index.vue` with an empty project set renders its read-only notice and no create button.
6. [unit] `pages/[project]/fleet/approvals.vue` builds a project `ApprovalViewer` whose `canDecideBudget` and `canDecideBash` follow `fleet.approval.decide.budget` and `fleet.approval.decide.bash` in the project set, and `pages/admin/fleet/approvals.vue` builds an admin viewer from the same keys in the global set.
7. [unit] `canDecide` for an admin-kind viewer with `canDecideBudget: false` is false on a pending `budget_override_required` approval.
8. [unit] `useApprovalNotifications.refresh()` calls `$api.get('/me/permissions')` first; when its keys include `fleet.approval.read` it scans the admin inbox, otherwise it calls `$api.get('/me/permissions', { query: { project: <slug> } })` for each project and scans only projects whose keys include `fleet.approval.decide.budget` or `fleet.approval.decide.bash`.
9. [unit] `ApprovalBadge` targets the admin approvals page when the global set holds `fleet.approval.read`, and the project approvals page when it does not.

### US-010: Admin → Roles page (`Workdir: apps/web`)

1. [unit] `pages/admin/roles.vue` mounted with `GET /roles` answering two roles lists each role's name, key and scope, with a `system` badge on the system role and a `locked` badge on the locked one.
2. [unit] When `GET /roles` rejects with error code 40003, the page renders its admin-only message and no role list.
3. [unit] `RoleEditorDialog` for a new PROJECT role, given the catalog from `GET /permissions/catalog`, renders only entries whose scope is `project` or `any`, grouped under each key's first segment, each row showing its `risk` as a badge.
4. [unit] In the editor, checking `ticket.create` and choosing "own" on the ownable `comment.update` row, then saving a new role, posts `POST /roles` with `permissions: ['comment.update.own', 'ticket.create']`.
5. [unit] Editing a saved role with `permissions: ['*.read', 'ticket.create']` and `expandedKeys` including `ticket.read` shows `*.read` as an entry chip, the `ticket.read` row checked and disabled, and the `ticket.create` row checked and enabled.
6. [unit] Removing the `*.read` chip and adding the entry `ticket.transition.*` through the text input, then saving, sends `PATCH /roles/<id>` with `permissions: ['ticket.transition.*', 'ticket.create']`.
7. [unit] A `locked` role opens with every editor field disabled and no save or delete button.
8. [unit] Saving a `system` role keeps its name field read-only and sends a `PATCH` body without `name`; the role list shows no delete button for it.
9. [unit] Deleting a custom role after confirming sends `DELETE /roles/<id>` and reloads the list; a 409 rejection shows `toast.error(extractApiError(err))` and the role stays listed.
10. [unit] A rejected save (403 `permissions.escalation`) shows `toast.error(extractApiError(err))` and leaves the dialog open with the entered values.
11. [unit] With the global set holding `role.read` and not `role.manage`, the page renders no create, edit or delete control.
12. [unit] `layouts/default.vue` renders the `/admin/roles` link and the "Admin" section label when the global set holds only `role.read`, and no `/admin/roles` link when it does not.

### US-011: `PrincipalRolesDialog` and Admin → Users (`Workdir: apps/web`)

1. [unit] `useRoleBindings().listGlobal('USER')` calls `$api.get('/role-bindings', { query: { principalType: 'USER', scope: 'global', size: '200', current: '1' } })`, then `current: '2'` while `hasNext` is true, and returns the records of both pages.
2. [unit] `pages/admin/users.vue` renders, in a user's role column, one chip per global binding with the role's name, and a PROJECT-scope role's chip reads "<name> (all projects)" through its i18n key.
3. [unit] The users page renders the "Edit roles" button only for other users, and not at all when the global set lacks `role.binding.global` or `role.read`.
4. [unit] When `GET /role-bindings` rejects, the users page shows `toast.error(extractApiError(err))` and renders no role chips.
5. [unit] `PrincipalRolesDialog` for a user offers, in its role select, every role from `GET /roles` not already bound, and adding `developer` posts `POST /role-bindings { principalType: 'USER', principalId, roleKey: 'developer', projectId: null }` and emits `changed`.
6. [unit] Removing a chip in `PrincipalRolesDialog` sends `DELETE /role-bindings/<binding id>` and emits `changed`.
7. [unit] `PrincipalRolesDialog` offers the `owner` role only when the global set holds `role.binding.owner` and the principal is a user.
8. [unit] A rejected `POST /role-bindings` shows `toast.error(extractApiError(err))`, emits no `changed`, and keeps the chips as they were.
9. [unit] `CreateUserDialog` renders no role field, and submitting valid input posts `POST /admin/users { email, name, password }`.

### US-012: Admin → Agents uses role bindings (`Workdir: apps/web`)

1. [unit] `pages/agents.vue` renders each agent's roles column from `GET /role-bindings?principalType=AGENT&scope=global` (one chip per binding with the role's name), not from `agent.roles`.
2. [unit] Choosing "Edit roles" for an agent opens `PrincipalRolesDialog` with `principal.type` `'AGENT'` and that agent's id, and adding `reviewer` posts `POST /role-bindings { principalType: 'AGENT', principalId: <agent id>, roleKey: 'reviewer', projectId: null }`.
3. [unit] `PrincipalRolesDialog` opened for an agent does not offer the `owner` role, even when the global set holds `role.binding.owner`.
4. [unit] `pages/agents.vue` renders the create button only with `agent.create`, and each row's "Edit roles", "Edit capabilities", "Rotate key", "Delete" and status actions only with `role.binding.global`, `agent.capabilities.update`, `agent.key.rotate`, `agent.delete` and `agent.update` respectively, all in the global set.
5. [unit] `CreateAgentDialog` renders no roles field, and submitting a name and slug posts `POST /agents` with a body that has no `roles` property.

### US-013: Project → Members lists users and agents with role chips (`Workdir: apps/web`)

1. [unit] `ProjectMembersPanel` mounted with `slug` and `projectId` calls `$api.get('/projects/<slug>/members', { query: { principals: 'all' } })` and `$api.get('/projects/<slug>/roles')`, and renders one row per record: a user row with its name (else email), an agent row with its name, an agent badge and its `agentSlug`.
2. [unit] Each row renders one chip per `bindings` entry with its `roleName`; a chip whose `id` is null renders no remove button.
3. [unit] Submitting the add-user form with an email and the `triager` role posts `POST /projects/<slug>/members { email, roleKey: 'triager' }` and appends the returned member.
4. [unit] Adding an agent picked from `GET /agents` (agents already listed are not offered) with the `reviewer` role posts `POST /role-bindings { principalType: 'AGENT', principalId: <agent id>, roleKey: 'reviewer', projectId }` and reloads the members list.
5. [unit] Adding the `verifier` role to an existing user row posts `POST /role-bindings { principalType: 'USER', principalId: <user id>, roleKey: 'verifier', projectId }`, and removing a chip sends `DELETE /role-bindings/<binding id>` and removes that chip.
6. [unit] Removing a row whose bindings have ids `b1`, `b2` and one legacy `null` sends `DELETE /role-bindings/b1` and `DELETE /role-bindings/b2` and no other delete, then reloads the list.
7. [unit] When the second of those deletes rejects, the panel shows `toast.error(extractApiError(err))` and reloads the list.
8. [unit] With the project set holding `member.add` and not `role.binding.manage`, the panel renders the add-user form and no add-agent control, chip add or remove control, or row remove button.
9. [unit] The signed-in user's own row renders no chip add, chip remove or row remove control, even with `role.binding.manage`.
10. [unit] `useProjectMembers('web').add('a@b.io', 'triager')` posts `{ email: 'a@b.io', roleKey: 'triager' }`, and `useProjectMemberNames('web').load()` still calls the members route with only `{ size: '100' }`.
11. [unit] A row whose every binding has `id: null` renders no remove-row button, even with `role.binding.manage`.
12. [unit] A rejected `POST /projects/<slug>/members` shows `toast.error(extractApiError(err))` and appends no row.

### US-014: Invites carry a project role key (`Workdir: apps/web`)

1. [unit] `ProjectInvitesPanel` offers the project roles from `GET /projects/<slug>/roles` in its role select, and submitting an email with `developer` posts `POST /projects/<slug>/invites { email, roleKey: 'developer' }`.
2. [unit] `ProjectInvitesPanel` renders each listed invite's `roleName`.
3. [unit] `ProjectInvitesPanel` renders nothing when the project set lacks `invite.read`; with `invite.read` and not `invite.create` it renders the list and no form; resend and cancel buttons follow `invite.resend` and `invite.cancel`.
4. [unit] `pages/invite/[token].vue` renders the preview's `roleName`.
5. [unit] A rejected `POST /projects/<slug>/invites` shows `toast.error(extractApiError(err))` and the invite list is unchanged.

### US-015: Delete the legacy role UI (`Workdir: apps/web`)

1. [unit] Importing `~/lib/fleet-jobs` at runtime yields no `canWorkOnFleet` export, and importing `~/lib/agent-roles` fails because the module no longer exists.
2. [unit] `useAdminUsers()` returns no `setRole` member, and `useProjectAgents('web')` returns no `add` or `remove` member.
3. [unit] `pages/[project]/agents.vue` mounted with a roster renders no add-agent button, no remove control and no "added by" or "added at" column.

The deletions are otherwise verified by the build/static gate: `bun run type-check` and `bun run lint` in `apps/web` pass with `components/EditAgentRolesDialog.vue`, `lib/agent-roles.ts`, `components/AddProjectAgentDialog.vue` and `composables/useProjectViewerRole.ts` deleted; with `canWorkOnFleet`, `useAdminUsers.setRole`, `GlobalRole`, `INVITE_ROLES` and `useProjectAgents.add`/`remove` removed; and with the roster add/remove controls and the "added by"/"added at" columns removed from `pages/[project]/agents.vue`. `bun run test` in `apps/web` passes with the test edits listed under US-015 in Modifies.
