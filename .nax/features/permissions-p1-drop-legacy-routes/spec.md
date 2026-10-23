# SPEC: Permissions P1l — Drop the Legacy Routes

## Summary

This feature removes every API route and DTO field that still speaks the legacy role model, and moves the CLI and the web onto role keys and role bindings:
- **Two membership guards move onto the binding route.** `DELETE /role-bindings/:id` refuses to remove the last active Project Admin of a project (409 `members.lastAdmin`, unless the caller holds `role.binding.global`), and refuses to remove an agent's last binding in a project while it holds open tickets there (409 `projectAgents.hasOpenTickets`). Until now only the legacy member and roster routes checked them.
- **The legacy write routes are deleted:** `PATCH` and `DELETE /projects/:slug/members/:userId`, `POST /projects/:slug/agents`, `DELETE /projects/:slug/agents/:agentSlug` and `PATCH /agents/:slug/update-roles`. Their writes go through `POST` / `DELETE /role-bindings`.
- **The legacy request fields are removed:** `AddMemberDto.role`, `CreateInviteDto.role`, `CreateUserDto.role`, `UpdateUserDto.role` and `CreateAgentDto.roles`.
- **The legacy response fields are removed:** `ProjectMemberDto.role`, the members page's `canManage` and `viewerRole`, `ProjectAgentListDto.scoping`, `ProjectAgentDto.roles`, `AgentResponseDto.roles`, `InviteDto.role`, `InvitePreviewDto.role` and `UserAdminDto.role`. `openapi.json` is regenerated.
- **The CLI works on role keys:** a new `koda role-binding list|grant|revoke` group; `member add` and `member invite` send `--role <key>` as `roleKey`; `member remove` revokes every binding the user holds in the project; `member role`, `project agent-add` and `project agent-remove` are deleted; `user create` and `agent create` lose `--role` / `--roles`. The generated client is regenerated.
- **The web stops reading the removed fields:** the project roster's roles column and scoping note, the agent `roles` normalization, the member, invite and admin-user `role` fields, and `auth.user.role` in `useApprovalNotifications`.

This is the twelfth feature implementing phase P1 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md`. The order is: roles (PR #308), membership (#310), enforce-core (#313), enforce-fleet (#314), enforce-assistant (#315), enforce-integrations (#316), contract-tests (#317), retire-checks (#318), fixtures-to-bindings (#319), web (#320), drop-legacy-reads (#321), then **drop-legacy-routes** (this feature) and drop-legacy-schema.

## Motivation

Since drop-legacy-reads, no legacy row grants anything, but the API still offers ways to write and show the legacy model:
- **Five routes write legacy-shaped state.** `PATCH /projects/:slug/members/:userId` takes an `ADMIN` / `DEVELOPER` / `VIEWER` enum, `POST /projects/:slug/agents` writes an `AgentProject` roster row, and `PATCH /agents/:slug/update-roles` writes `AgentRoleEntry` rows that grant nothing.
- **Request DTOs still accept legacy enums**, so a client can create an `ADMIN` user, a `DEVELOPER` member or an agent with `REVIEWER` roles without naming a role key.
- **Responses still carry legacy values**: a member's display `role` and the page's `viewerRole` (mapped from bindings back to the enum), `canManage`, an always-`true` `scoping`, and agent `roles` that are always empty in new data.
- **The CLI only speaks the enums.** It cannot grant a custom role, a reviewer, verifier or triager role, or any global role.
- **Two invariants live only on the routes being deleted.** The web members panel already removes principals with `DELETE /role-bindings/:id`, which checks neither the last-Project-Admin rule nor the agent's open tickets. Today a project can lose its last admin, and an agent can lose access while it still holds tickets.

drop-legacy-schema can then remove the remaining legacy writes and drop the tables, with no route or client left that names them.

**Rulings that bind this feature** (user):
- 2026-10-22: **drop-legacy is three features**: drop-legacy-reads (#321), drop-legacy-routes (this one: legacy write routes, DTO `role` fields, CLI on role keys, web leftovers), drop-legacy-schema (remaining legacy writes, the tables and columns, the JWT `role` claim). **The CLI `--role` takes role keys only**, with no legacy enum aliases.
- 2026-10-23: **the last-Project-Admin and open-ticket guards move onto `DELETE /role-bindings/:id`**. The roster add's refusal of an `OFFLINE` agent is dropped: status is liveness, not access (ruling 2026-10-20).
- 2026-10-23: **every legacy response field is removed here**, including `InviteDto.role`, `InvitePreviewDto.role` and `UserAdminDto.role`. `UserResponseDto.role` (`GET /auth/me`) and the JWT `role` claim stay until drop-legacy-schema (ruling 2026-10-22).
- 2026-10-23: **the CLI gains a `role-binding` command group**; `member role`, `project agent-add` and `project agent-remove` are deleted; `member remove` revokes the user's bindings in the project; `user create` and `agent create` lose their role options.
- **No data migration** (design decision 2).

## Design

### Rulings that bind every story

1. **Conventions carry over** from `.nax/features/permissions-p1-drop-legacy-reads/spec.md` ("Rulings that bind every story"): `PermissionsModule` is `@Global()`; DB-backed tests seed the system roles; a DB-backed test that writes binding rows directly between two requests calls `MembershipService.invalidatePermissions()` after the write.
2. **An unknown request field is stripped, not refused.** The global `ValidationPipe` runs with `whitelist: true` and without `forbidNonWhitelisted`, so a client that still sends `role` or `roles` gets the request handled as if the field were absent. This feature does not change the pipe.
3. **Test setups name role keys.** A test that adds a member or creates an invite sends `roleKey` with the key the legacy value maps to (`ADMIN` → `project-admin`, `DEVELOPER` → `developer`, `VIEWER` → `viewer`). A test that needs a global admin creates the user through `POST /api/admin/users` and then gives it the global `admin` binding, with `grantRole(prisma, { type: 'USER', id }, 'admin')` from `src/permissions/test-helpers/permission-fixtures.ts` or with `POST /api/role-bindings` (`roleKey: 'admin'`, `projectId: null`). The route write bumps the user's `tokenVersion`, so the test binds first and logs in after; `grantRole` does not bump it. A test that changes a role does it with `POST` / `DELETE /api/role-bindings`.
4. **`legacy-project-roles.ts` stays.** Invites keep writing the `ProjectInvite.role` column (`legacyNameOf`), invite acceptance keeps resolving a pre-migration row's legacy role, and `membership.queries.ts` keeps answering `ProjectMembership.role` for `ProjectAccessService.resolveMembership`. drop-legacy-schema removes them with the columns.
5. **No schema change, no migration.** `AgentRoleEntry`, `AgentProject`, `ProjectMember`, `User.role` and `ProjectInvite.role` stay as tables and columns.
6. **No approval or audit change** (P3 and P2).

### The guards on binding removal (US-001, US-002)

`MembershipService.removeBinding` gains an options argument (US-001), and `RoleAdminService.removeBinding` passes it:

```ts
// apps/api/src/permissions/membership.service.ts
export interface RemoveBindingOptions {
  /** The caller may remove a project's last active Project Admin (it holds role.binding.global). */
  lastProjectAdminOverride?: boolean;
}

async removeBinding(id: string, options: RemoveBindingOptions = {}): Promise<void>
```

Inside the existing transaction, in this order:
1. `first = bindings.findViewById(id)`; absent → 404 `permissions.bindingNotFound` (unchanged).
2. **Project locks, before the existing locks.** When `first.binding.projectId` is a project id P: a `USER` binding whose `roleKey` is `project-admin` takes `bindings.lockProjectMembers(P)` (US-001); an `AGENT` binding takes `bindings.lockProjectAgents(P)` (US-002). These are the advisory locks the deleted member and roster routes took, in the same order: the project lock first, then `lockUser`. Ticket assignment takes the agent lock too (`TicketsService`), so an agent-binding removal and an assign stay serialized. An `owner` binding is always global, so no removal takes both a project lock and the `owner` Role lock.
3. The `owner` Role lock and `lockUser` (unchanged).
4. **Re-read** `current = bindings.findViewById(id)` whenever step 2 or the owner lock took a lock; absent → 404 `permissions.bindingNotFound`.
5. **Last Project Admin (US-001).** For a `USER` `project-admin` binding in P, the removal is refused with `ConflictAppException({}, 'members.lastAdmin')` when all of these hold: `options.lastProjectAdminOverride` is not `true`; `bindings.findUserState(userId)` answers a row whose `disabled` is `false` (a missing user row — the binding's `principalId` has no foreign key — is not an active admin, so the guard does not apply); and `bindings.countActiveProjectAdmins(P) <= 1`.
6. **Open tickets (US-002).** For an `AGENT` binding in P, the removal is refused with `ConflictAppException({ count, refs: refs.join(', ') }, 'projectAgents.hasOpenTickets')` when `bindings.countOtherProjectBindings({ type: 'AGENT', id }, P, id)` is 0 and `bindings.countOpenAgentTickets(agentId, P).count > 0`. No caller overrides it.
7. The owner check, the delete and the after-removal mirror (unchanged).

- `RoleAdminService.removeBinding(principal, id)` keeps its order (lookup, binding keys, self-binding, escalation). Right before `membership.removeBinding`, it computes `lastProjectAdminOverride` as `(await this.permissions.can(principal, 'role.binding.global')).allowed` when the binding is a `USER` `project-admin` binding with a project id, and `false` otherwise, and passes `{ lastProjectAdminOverride }` (US-001).
- `PrismaRoleBindingRepository` gains:
  - US-001: `lockProjectMembers(projectId)` (delegates to `lockProjectMembers` in `common/utils/advisory-lock.ts`) and `countActiveProjectAdmins(projectId)` (delegates to `countActiveProjectAdmins` from `membership.queries.ts`; it counts per project);
  - US-002: `lockProjectAgents(projectId)` (delegates to `lockProjectAgents`), `countOtherProjectBindings(principal, projectId, excludingId)` (the PROJECT-scope bindings of the principal with that `projectId` and an id other than `excludingId`) and `countOpenAgentTickets(agentId, projectId)` (delegates to the query below).
- **`countOpenAgentTickets(db, agentId, projectId)`** (US-002) lives in a new `apps/api/src/permissions/open-agent-tickets.queries.ts`, beside `membership.queries.ts`, so `permissions/` never imports from `agents/`. It is the body of today's `PrismaAgentRepository.countOpenProjectTickets`, moved: tickets assigned to the agent in the project, not `CLOSED` or `REJECTED`, not soft-deleted; `count`, plus the refs (`<project key>-<number>`) of the oldest `MAX_OPEN_TICKET_REFS` (10, exported from the new module; `PrismaAgentRepository` imports it from there instead of keeping its own constant, which `findProjectRoster` still uses); a project row that disappears while refs are built throws `KodaError('PROJECT_NOT_FOUND', …)`. `PrismaAgentRepository.countOpenProjectTickets` delegates to it until US-003 deletes it.
- "The agent's last binding" counts only the agent's PROJECT-scope bindings with `projectId` P. A `projectId`-null binding is not a binding in P, so it neither blocks nor allows the refusal.
- The guards apply only to `DELETE /role-bindings/:id`. `MembershipService.removeProjectBindings`, `removeAllBindings` and `setGlobalAdmin` are unchanged.
- `InMemoryPermissionStore`'s binding repository double (`src/permissions/test-helpers/in-memory-permissions.ts`) gains the new methods; it records every call in `store.calls`, as it does today.

### The legacy routes go (US-003)

| Site | Baseline (locate only) | Target |
|:--|:--|:--|
| `ProjectMembersController` | `@Patch(':userId')` `updateRole`, `@Delete(':userId')` `remove` | both handlers deleted; `GET` and `POST` stay |
| `ProjectMembersService` | `updateRole`, `remove`, `lockAndFind`, `assertKeepsAnAdmin` | deleted |
| `ProjectsController` | `@Post(':slug/agents')` `addProjectAgent`, `@Delete(':slug/agents/:agentSlug')` `removeProjectAgent` | both handlers deleted; `GET :slug/agents` and `PATCH :slug/agents/:agentSlug` stay |
| `AgentsController` | `@Patch(':slug/update-roles')` `updateRoles` and `updateAgentRoles` | deleted |
| `AgentsService` | `addToProject`, `removeFromProject`, `updateRoles` | deleted; `isOnProjectRosterBySlug` stays |
| `PrismaAgentRepository` | `addToProjectRoster`, `removeFromProjectRoster`, `replaceRoles`, `countOpenProjectTickets`, `hasLocalMembership` | deleted |
| `PrismaProjectMembersRepository` | `createMember`, `updateMemberRole`, `deleteMemberIfPresent`, `deleteMember` | deleted (`lockMembers`, `findMember`, `findUserByEmail` stay) |
| DTOs | `UpdateMemberRoleDto`, `UpdateRolesDto`, `AddProjectAgentDto` | files deleted |
| `scripts/smoke-test-cli.sh` | `POST /api/projects/koda/agents` | replaced by a `viewer` `POST /api/role-bindings` for the agent in the project, placed after the `PROJECT_ID` / `AGENT_ID` extraction and before the four workflow role bindings |

- **`member.remove` keeps its catalog entry and joins `PENDING_SURFACE_KEYS`** (`src/permissions/catalog.ts`). The two deleted handlers were the only surfaces that declared it, and the catalog contract test refuses an undeclared key that is not pending. Removing a principal from a project is now deleting its bindings, which `role.binding.manage` gates; the key stays held by the seeded roles that hold it (Appendix A), and the list's doc comment says it waits for P3 policy to decide whether it gates binding removal.
- **A duplicate roster add is no longer a 409.** `POST /role-bindings` answers an existing binding with 201 and the same binding (`MembershipService.createBinding`), so the roster route's 409 `projectAgents.alreadyAssigned` goes with the route.
- Comments and `@ApiResponse` texts that name the deleted routes or methods are reworded: `MembershipService.removeProjectBindings`' doc, the stale `AgentsService.updateRoles` comment in `common/test-helpers/global-stubs.module.ts`, and the `AgentsService.removeFromProject` mentions in `tickets/tickets.service.ts`, `tickets/prisma-tickets.repository.ts`, `tickets/domain/ticket.domain.ts` and `projects/members/project-member.queries.ts`.
- `MembershipService.removeProjectBindings` keeps no production caller after this story and stays (drop-legacy-schema decides it).

### The legacy request fields go (US-004, US-005)

| Site | Baseline (locate only) | Target |
|:--|:--|:--|
| `AddMemberDto` / `ProjectMembersService.add` (US-004) | `role?` and `roleKey?` (`@IsOptional`); the `members.roleAndRoleKey` refusal | `roleKey?` only, validated with `@ValidateIf((dto) => dto.roleKey !== undefined)` + the key pattern as `CreateInviteDto` does, so an explicit `null` is a 400 validation error; `add` takes `roleKey = dto.roleKey ?? 'viewer'`; the refusal is deleted |
| `CreateInviteDto` / `ProjectInvitesService` (US-004) | `role?` and `roleKey?`; `effectiveRoleKey` maps the enum and refuses both | `roleKey?` only; an absent `roleKey` answers 400 `invites.roleRequired` (unchanged key); `invites.roleAndRoleKey` deleted |
| i18n (US-004) | `members.roleAndRoleKey`, `invites.roleAndRoleKey` in `src/i18n/{en,zh}` | deleted |
| `CreateUserDto` / `UsersAdminService.create` (US-005) | `role?: GlobalRole`; an `ADMIN` gets the global `admin` binding | field removed; every created user gets the `member` baseline only, and the row is written with `role: 'MEMBER'` |
| `UpdateUserDto` / `UsersAdminService.update` (US-005) | `role?` and `disabled?`; `demotes` and `setGlobalAdmin` on a role change | `disabled?` only; `update` never calls `setGlobalAdmin`; the self rule refuses only a self-disable (403 `users.self`); the last-admin guard keeps applying to a disable |
| `CreateAgentDto` / `AgentsService.generateApiKey` (US-005) | `roles?: string[]`; `validateAgentRoles`, `assertAgentRole` | field and both helpers removed; creation writes no `AgentRoleEntry` row |
| `PrismaAgentRepository` (US-005) | `createRolesAndCapabilities(agentId, roles, capabilities)` | `createCapabilities(agentId, capabilities)`: writes only `AgentCapabilityEntry` rows, on the ambient client as today |
| `scripts/smoke-test-cli.sh` (US-005) | creates the agent with `roles` | the agent create body has no `roles` |

- Granting a global admin is `POST /role-bindings` with `roleKey: 'admin'` and `projectId` null; demoting is the `DELETE` of that binding. Neither changes here.
- `AGENT_ROLES` stays in `common/enums.ts` while anything imports it.

### The legacy response fields go (US-006, US-007)

| Response | Baseline (locate only) | Target |
|:--|:--|:--|
| `GET /projects/:slug/members` (US-006) | `{ ...page, canManage, viewerRole }` | the page alone: `{ total, current, size, hasNext, hasPrev, records }`; `ProjectMembersService.list` returns `IPageResult<ProjectMemberDto>`, still calls `ProjectAccessService.resolveMembership` (the 403 `projects` of a principal without access) and no longer calls `can`; the now unused `PermissionService` constructor parameter of `ProjectMembersService` is removed |
| `ProjectMemberDto` (members list, member add, invite `ADDED`) (US-006) | `role` and `bindings[].id: string \| null` | no `role`; `MemberBindingDto.id: string` (non-null in the schema and the type); `ProjectMemberRecord.role` and `MemberBinding.id`'s `null` are removed |
| `GET /projects/:slug/agents` (`ProjectAgentListDto`) (US-006) | `{ scoping, items }`; `from(records, scoping)` | `{ items }`; `from(records)` |
| `ProjectAgentDto` / `ProjectAgentRecord` (US-006) | `roles: string[]` | removed; the roster read selects no `AgentRoleEntry` rows |
| `AgentResponseDto` (`GET /agents`, `GET /agents/:slug`, `GET /agents/me`, `PATCH /agents/:slug`, `POST /agents` `agent`, `DELETE /agents/:slug`) (US-006) | `roles: AgentRoleDto[]`; `AgentRoleDto` | `roles` and `AgentRoleDto` removed; `AgentProfileRecord.roles` removed; `PrismaAgentRepository` reads stop including `roles` |
| `InviteDto` (`GET` / `POST` / resend invites) (US-007) | `role: string \| null` | removed; `roleKey` and `roleName` stay |
| `InvitePreviewDto` (`GET /invites/:token`) (US-007) | `role: string \| null` | removed; the doc's field count becomes seven |
| `UserAdminDto` (`GET` / `POST` / `PATCH /admin/users`) (US-007) | `role: string` | removed |
| `openapi.json` (US-007) | records every field above | regenerated with `bun run api:export-spec` after the last API change. US-007 runs only `api:export-spec`: `bun run generate` / `generate:cli` waits for US-010, because the CLI files that still use the removed operations change in US-009 and US-010 |

- **Unchanged:** `UserResponseDto.role` (`GET /auth/me`, login and register), the JWT `role` claim, the invite email's role text (`roleName`, falling back to the stored legacy role), and the internal records `ProjectInviteRecord.role`, `UserAdminRecord.role` and `ProjectMembership.role`.
- The doc comments of the changed DTOs stop describing the removed fields.

### The CLI on role bindings (US-008 to US-010)

**`koda role-binding`** (US-008, new `apps/cli/src/commands/role-binding.ts` exporting `roleBindingCommand(program: Command): void` like the other command modules, and called from `src/index.ts` beside them). It sets up the client with `withContext({}, { requireProject: false })`, as `user list` does, and never reads the context's `projectSlug`: no `--project` means a global binding or no project filter.

| Command | Calls | Output (non-`--json`) |
|:--|:--|:--|
| `role-binding list [--project <slug>] [--global] [--type <USER\|AGENT>] [--principal <id>] [--page <n>] [--size <n>] [--json]` | `--project` resolves the id with `projectsControllerFindBySlug`; then `roleBindingsControllerList` with `query: { current, size, projectId?, scope: 'global'?, principalType?, principalId? }` | `table(['ID', 'Type', 'Principal', 'Role', 'Project', 'Granted'], …)` with `projectId ?? 'global'` in the Project column; `Next: --page <n>` when `hasNext` |
| `role-binding grant --role <key> (--user <userId> \| --agent <agentSlug>) [--project <slug>] [--json]` | `--agent` resolves the id with `agentsControllerFindBySlug`; `--project` with `projectsControllerFindBySlug`; then `roleBindingsControllerCreate` with `body: { principalType, principalId, roleKey, projectId }` (`projectId: null` without `--project`) | `Granted <roleKey> to <userId or agentSlug> (binding <id>)` |
| `role-binding revoke <bindingId> [--json]` | `roleBindingsControllerRemove({ path: { id } })` | `Revoked <bindingId>` |

- `list` passes its flags through: a combination the API refuses (`--global` with `--project`, `--principal` without `--type`) reaches the API, and its 400 goes through `handleApiError` (exit 3).
- `grant` with both `--user` and `--agent`, or neither, reports `Choose exactly one of --user or --agent` through `handleApiError(new Error(...), { validationError: true })` (exit 3, `.nax/rules/cli.md`) and calls no API function.
- API refusals (403, 404, 409) go through `handleApiError` unchanged, so the server's message is what the user reads.
- `--json` prints the unwrapped response (`list`: the page; `grant`: the `RoleBindingDto`; `revoke`: `{ "revoked": "<id>" }`).

**The `member` commands (US-009)** keep the generated client as it is (every function they call already exists):

| Command | Target |
|:--|:--|
| `member list [--all]` | `--all` sends `principals: 'all'`; the table is `['Type', 'ID', 'Email/Slug', 'Name', 'Roles']` with `principalType`, `principalId`, `email ?? agentSlug`, `name ?? ''` and the bindings as `<roleKey> (<id>)` joined by `, ` |
| `member add --email <email> --role <key>` | `projectMembersControllerAdd` with `body: { email, roleKey }`; prints `Added <email> as <roleName joined by ', '>` |
| `member invite --email <email> --role <key>` | `projectInvitesControllerCreate` with `body: { email, roleKey }`; the `ADDED` line prints the member's bindings' `roleName`s; the `INVITED` lines are unchanged |
| `member invites` | the table's `Role` column shows `roleName ?? roleKey ?? ''` |
| `member remove <userId>` | pages `projectMembersControllerList` (`size: 100`, default principals) until a record has `principalType: 'USER'` and `principalId === userId`, then calls `roleBindingsControllerRemove` once per binding id of that record, in order; prints `Removed <userId>`. No such record → `handleApiError(new Error('Not a member: <userId>'))` (exit 1) and no delete. A refused delete stops the loop and goes through `handleApiError` |
| `member role` | deleted |

**The `project`, `user` and `agent` commands and the generated client (US-010):**

| Command | Target |
|:--|:--|
| `project agents` | the `Agent scoping is off on this server` warning is deleted; the table is unchanged |
| `project agent-add`, `project agent-remove` | deleted |
| `user create` | the `--role` option is deleted; the body has no `role` |
| `user list` | the `Role` column is deleted |
| `agent create` | the `--roles` option is deleted; the body has no `roles` |
| `apps/cli/src/generated/` | regenerated with `bun run generate:cli` (repo root) from the US-007 `openapi.json`, so the CLI `type-check` runs against the new contract; no generated file is edited by hand. The directory is gitignored (`.gitignore`), so the output is in no diff; CI regenerates it the same way |

- `--role` takes a role key verbatim (`project-admin`, `developer`, `viewer`, a custom key). The CLI does not validate or map it; the API answers 404 `permissions.roleNotFound` for an unknown key.
- The `member` group's description says writes need `member.add` / `role.binding.manage`, not "project-admin".

### The web stops reading the removed fields (US-011)

| Site | Baseline (locate only) | Target |
|:--|:--|:--|
| `composables/useProjectAgents.ts` | `ProjectAgent.roles`; `ProjectAgentListDto.scoping`; `scoping` ref, returned | `roles` and `scoping` removed from the types and the return value |
| `pages/[project]/agents.vue` | the scoping-off note (`data-testid="project-agents-scoping-off"`) and the Roles column | both removed; the other columns, the status select and its gate are unchanged |
| `pages/agents.vue` | `AgentRow.roles` and its normalization of `agent.roles` | removed; the roles column keeps rendering binding chips |
| `composables/useProjectMembers.ts` | `ProjectMember.role`; `MemberBinding.id: string \| null` | `role` removed; `id: string` |
| `components/ProjectMembersPanel.vue` | skips null binding ids; doc says a null chip is a legacy row | every chip is removable when the gate allows; the null filter and the legacy wording are removed |
| `composables/useProjectInvites.ts`, `pages/invite/[token].vue` | `role?: string \| null` on the invite and preview types | removed |
| `composables/useAdminUsers.ts` | `AdminUser.role` | removed |
| `composables/useApprovalNotifications.ts` | identity = `[auth.user.id, auth.user.role]` in `refresh`'s `current()` and the `watch` | identity = the user id alone |
| `i18n/locales/{en,zh}.json` | `agents.project.scopingOff` | removed |
| `tests/e2e/fixtures/api-client.ts` (Playwright only, not run by the story's gates) | `createAgent` sends `roles`; `createUser` sends `role`; `addProjectMember(token, slug, email, role)` sends `{ email, role }` | no `roles`; no `role`; `addProjectMember(token, slug, email, roleKey)` sends `{ email, roleKey }`, and its callers pass the mapped key |

- `AuthUser.role` in `composables/useAuth.ts` stays (`GET /auth/me` still answers it).

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| `DELETE /role-bindings/:id` would remove the last active Project Admin of P and the caller lacks `role.binding.global` | 409 `members.lastAdmin`; the binding stays (US-001) |
| Two concurrent removals of the two remaining Project Admin bindings of P | the project lock serializes them; exactly one answers 204 and the other 409 `members.lastAdmin` (US-001) |
| The `project-admin` binding names a user row that no longer exists | the guard does not apply; the removal proceeds (US-001) |
| `countActiveProjectAdmins` rejects (database error) | the error propagates and the transaction rolls back; the binding stays (US-001) |
| `DELETE /role-bindings/:id` would remove an agent's last binding in P while it holds open tickets in P | 409 `projectAgents.hasOpenTickets` with `count` and `refs`, for every caller (no override); the binding stays (US-002) |
| `countOpenAgentTickets` rejects (database error) | the error propagates and nothing is deleted (US-002) |
| The project row disappears while `countOpenAgentTickets` builds refs | `KodaError('PROJECT_NOT_FOUND', …)` (US-002) |
| A client calls a deleted route | 404 (no route) (US-003) |
| A client still sends `role` in a member add or invite body | stripped: a member add without `roleKey` grants `viewer`; an invite without `roleKey` answers 400 `invites.roleRequired` (US-004) |
| A member add sends `roleKey: null` | 400 validation error (US-004) |
| A client still sends `role` / `roles` in a user create, user patch or agent create body | stripped: a user is created as a plain member, a user patch changes nothing but `disabled`, an agent is created without roles (US-005) |
| `koda role-binding grant` with both or neither of `--user` / `--agent` | `Choose exactly one of --user or --agent`, exit 3, no API call (US-008) |
| `koda role-binding grant --agent <slug>` for an unknown slug | the 404 from `agentsControllerFindBySlug` goes through `handleApiError`; no binding is created (US-008) |
| `koda member remove <userId>` for a user who is not listed | `Not a member: <userId>`, exit 1, no delete (US-009) |
| `koda member remove` when a binding delete is refused (for example 409 `members.lastAdmin`) | the loop stops at that delete, earlier deletes stay done, and the refusal goes through `handleApiError` (US-009) |

### Integration

Symbols this feature **reads** (verified at `dd6c973d`):
- `RoleAdminService.removeBinding(principal, id)`, `assertMayGrant`, `createBinding` — `apps/api/src/permissions/role-admin.service.ts`
- `PermissionService.can(principal, key, ctx?)` — `apps/api/src/permissions/permission.service.ts`
- `countActiveProjectAdmins(db, projectId)` — `apps/api/src/permissions/membership.queries.ts`
- `lockProjectMembers(db, projectId)`, `lockProjectAgents(db, projectId)` — `apps/api/src/common/utils/advisory-lock.ts`
- `PrismaRoleBindingRepository.findViewById`, `lockOwnerRole`, `lockUser`, `findUserState` (answers `UserLegacyState | null`), `deleteById` — `apps/api/src/permissions/prisma-role-binding.repository.ts`
- `InMemoryPermissionStore` (`store.calls`) — `apps/api/src/permissions/test-helpers/in-memory-permissions.ts`
- `ProjectAccessService.resolveMembership`, `findProjectIdBySlug` — `apps/api/src/projects/project-access.service.ts`
- `grantRole`, `grantBaseline`, `ensureSystemRoles` — `apps/api/src/permissions/test-helpers/permission-fixtures.ts`
- CLI: `roleBindingsControllerList`, `roleBindingsControllerCreate`, `roleBindingsControllerRemove`, `agentsControllerFindBySlug`, `projectsControllerFindBySlug`, `projectMembersControllerList`, `projectMembersControllerAdd`, `projectInvitesControllerCreate` — `apps/cli/src/generated/sdk.gen.ts`; `unwrap`, `handleApiError`, `table`, `withContext` — `apps/cli/src/utils/`
- Web: `useRoleBindings().remove(id)` — `apps/web/composables/useRoleBindings.ts`

Symbols this feature **changes**. The baseline only locates the code; implement the target.

| Symbol | Baseline (locate only) | Target |
|:--|:--|:--|
| `MembershipService.removeBinding` | `(id)`; owner lock and user lock only | `(id, options = {})`; the US-001 / US-002 steps |
| `RoleAdminService.removeBinding` | calls `membership.removeBinding(id)` | passes `{ lastProjectAdminOverride }` |
| `PrismaRoleBindingRepository` | no project locks or counters | the five methods above |
| `countOpenAgentTickets` | `PrismaAgentRepository.countOpenProjectTickets` | `apps/api/src/permissions/open-agent-tickets.queries.ts` |
| The five legacy routes, their service and repository methods, three DTO files | present | deleted (US-003 table) |
| `AddMemberDto`, `CreateInviteDto`, `CreateUserDto`, `UpdateUserDto`, `CreateAgentDto`, `createRolesAndCapabilities` | legacy role fields | the US-004 / US-005 table |
| `ProjectMembersService.list`, `ProjectMemberDto`, `MemberBindingDto`, `ProjectAgentListDto`, `ProjectAgentDto`, `AgentResponseDto`, `InviteDto`, `InvitePreviewDto`, `UserAdminDto` | legacy response fields | the US-006 / US-007 table |
| CLI `member`, `project`, `user`, `agent` commands | legacy enums and routes | the US-009 / US-010 tables |
| Web composables and pages | read the removed fields | the US-011 table |

## Out of Scope

- Dropping `AgentRoleEntry`, `AgentProject`, `ProjectMember`, `User.role` and `ProjectInvite.role`, stopping the remaining legacy writes (the `User.role` mirror in `MembershipService`, `role: 'ADMIN'` for the first user, `role: 'MEMBER'` for created and invited users, `ProjectInvite.role` on invite create), deleting `legacy-project-roles.ts`, and deciding `MembershipService.removeProjectBindings` (no production caller after US-003), are out of scope (`permissions-p1-drop-legacy-schema`).
- Deriving the JWT `role` claim and `UserResponseDto.role` (`GET /auth/me`, login, register) from bindings, and removing `AuthUser.role` from the web and the `role` line of `koda auth me`, are out of scope (`permissions-p1-drop-legacy-schema`).
- Refusing a binding for an `OFFLINE` agent on `POST /role-bindings` is out of scope (ruling 2026-10-23: status is liveness, not access).
- A last-global-admin guard on `DELETE /role-bindings/:id` of a global `admin` binding is out of scope: the `users.lastAdmin` guard keeps applying only to `PATCH /admin/users/:id` disables, and the last `owner` binding stays protected by the existing owner lock.
- Applying the last-Project-Admin rule to a user disable (`PATCH /admin/users/:id` `{ disabled: true }`), to `MembershipService.removeAllBindings`, or to deleting a custom role, is out of scope; only `DELETE /role-bindings/:id` gains it.
- Applying the open-ticket rule to agent deletion (`DELETE /agents/:slug`) and to `MembershipService.removeProjectBindings` is out of scope.
- US-002 only: a test that races a ticket assign against an agent-binding removal is out of scope; both take the same `PROJECT_AGENTS` advisory lock, which `TicketsService.assign` already takes and US-002 AC-7 pins on the removal side.
- Answering a duplicate roster add with 409 `projectAgents.alreadyAssigned` is out of scope: it goes with `POST /projects/:slug/agents`, and `POST /role-bindings` answers an existing binding with 201.
- US-008 only: tests for `role-binding list --json`, `revoke --json`, the `Revoked <id>` line, the `Next: --page <n>` hint and the default page and size are out of scope; they follow the pattern of `user list` and the other command modules.
- US-009 only: a test for `member remove --json` (it keeps printing `{ "removed": "<userId>" }`) is out of scope.
- A test that drives the new `DELETE /role-bindings/:id` 409 `members.lastAdmin` through the e2e suite is out of scope beyond the US-001 Modifies entry for `endpoint.e2e.spec.ts`.
- Rejecting a request that still sends `role` / `roles` with 400 (`forbidNonWhitelisted`) is out of scope; the global pipe keeps stripping unknown fields.
- CLI aliases that map `ADMIN` / `DEVELOPER` / `VIEWER` onto role keys are out of scope (ruling 2026-10-22: role keys only).
- `koda role-binding list` resolving principal ids to names or emails, and checking flag combinations before the API does, are out of scope; it prints the ids the API answers and passes its flags through.
- The stale root `apps/web/.nax-acceptance.test.ts` (it matches no jest `testMatch` and pins the removed `EditAgentRolesDialog.vue`) is out of scope; it is not run.
- Re-seeding or resetting koda-wk is out of scope for the run; it is a manual step after P1 (design decision 2).
- Approval policies, the audit log and `ActionContext` are out of scope (P3, P2).

## Stories

1. **US-001: The last-Project-Admin guard moves onto binding removal** — `Workdir: apps/api` — No dependencies. `MembershipService.removeBinding(id, options)` takes the project-members lock for a `USER` `project-admin` binding and refuses the last active Project Admin; `RoleAdminService.removeBinding` passes the `role.binding.global` override; `PrismaRoleBindingRepository` gains `lockProjectMembers` and `countActiveProjectAdmins`.
2. **US-002: The open-ticket guard moves onto binding removal** — `Workdir: apps/api` — Depends on US-001. `MembershipService.removeBinding` takes the project-agents lock for an `AGENT` binding and refuses the agent's last binding in a project while it holds open tickets there; `countOpenAgentTickets` moves to `permissions/open-agent-tickets.queries.ts`; `PrismaRoleBindingRepository` gains `lockProjectAgents`, `countOtherProjectBindings` and `countOpenAgentTickets`.
3. **US-003: The legacy write routes are deleted** — `Workdir: apps/api` — Depends on US-002. Per the US-003 table: the five routes, their service and repository methods and three DTO files go; tests that drove the routes move to `/role-bindings`; the smoke script stops using the roster route. Verification for the removals: `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint`.
4. **US-004: Member adds and invites take role keys only** — `Workdir: apps/api` — Depends on US-003. Per the US-004 rows: `AddMemberDto.role` and `CreateInviteDto.role` go, with the two `roleAndRoleKey` refusals and keys; test setups send `roleKey`. Verification for the removals: `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint`.
5. **US-005: User and agent creation carry no legacy roles** — `Workdir: apps/api` — Depends on US-004. Per the US-005 rows: `CreateUserDto.role`, `UpdateUserDto.role` and `CreateAgentDto.roles` go; `createRolesAndCapabilities` becomes `createCapabilities`; test setups give admins a global `admin` binding. Verification for the removals: `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint`.
6. **US-006: Member, roster and agent responses lose their legacy fields** — `Workdir: apps/api` — Depends on US-005. Per the US-006 rows. Verification for the removals: `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint`.
7. **US-007: Invite and admin-user responses lose their legacy fields, and the OpenAPI document is regenerated** — `Workdir: apps/api` — Depends on US-006. Per the US-007 rows; `openapi.json` is regenerated with `bun run api:export-spec` after this story's changes, the last API change of the feature; it does not run `generate:cli`. Verification for the removals: `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint`.
8. **US-008: A `koda role-binding` command group** — `Workdir: apps/cli` — Depends on US-007. `list`, `grant` and `revoke` over the generated role-binding functions, registered in `src/index.ts`.
9. **US-009: The `member` commands on role keys and bindings** — `Workdir: apps/cli` — Depends on US-007. Per the US-009 table; `member role` is deleted. Verification for the removals: `bun run --cwd apps/cli type-check` and `bun run --cwd apps/cli lint`.
10. **US-010: The `project`, `user` and `agent` commands drop the legacy options, and the client is regenerated** — `Workdir: apps/cli` — Depends on US-008, US-009. Per the US-010 table. Verification for the removals: `bun run --cwd apps/cli type-check` and `bun run --cwd apps/cli lint`.
11. **US-011: The web stops reading the removed fields** — `Workdir: apps/web` — Depends on US-007. Per the US-011 table. Verification for the removals: `bun run --cwd apps/web type-check` and `bun run --cwd apps/web lint`.

One capability (user-confirmed scope, rulings 2026-10-22 and 2026-10-23): removing the legacy routes and fields from the API and its two clients. The eleven stories are its API, CLI and web parts split for size.

### Context Files

**US-001**
- `apps/api/src/permissions/membership.service.ts` — `removeBinding`, edited here
- `apps/api/src/permissions/role-admin.service.ts` — `removeBinding`, edited here
- `apps/api/src/permissions/prisma-role-binding.repository.ts` — gains the lock and counter
- `apps/api/src/permissions/test-helpers/in-memory-permissions.ts` — the binding repository double, edited here
- `apps/api/src/common/utils/advisory-lock.ts` — `lockProjectMembers`, read

**US-002**
- `apps/api/src/permissions/membership.service.ts` — `removeBinding`, edited here
- `apps/api/src/permissions/prisma-role-binding.repository.ts` — gains the lock and counters
- `apps/api/src/agents/prisma-agent.repository.ts` — `countOpenProjectTickets`, the body that moves
- `apps/api/src/permissions/test-helpers/in-memory-permissions.ts` — the binding repository double, edited here
- `apps/api/src/tickets/tickets.service.ts` — the assign path's `lockProjectAgents`, read

**US-003**
- `apps/api/src/projects/members/project-members.service.ts` — `updateRole` / `remove`, deleted here
- `apps/api/src/agents/agents.service.ts` — `addToProject` / `removeFromProject` / `updateRoles`, deleted here
- `apps/api/src/projects/projects.controller.ts` — the roster handlers, deleted here
- `apps/api/src/agents/agents.controller.ts` — `updateRoles`, deleted here
- `apps/api/src/projects/members/project-members.controller.ts` — `updateRole` / `remove`, deleted here

Also edited: `apps/api/src/agents/prisma-agent.repository.ts`, `apps/api/src/projects/members/prisma-project-members.repository.ts`, `apps/api/src/permissions/membership.service.ts` (doc), `apps/api/src/common/test-helpers/global-stubs.module.ts` (comment).

**US-004**
- `apps/api/src/projects/members/dto/add-member.dto.ts` — `role`, removed here
- `apps/api/src/projects/members/project-members.service.ts` — `add`, edited here
- `apps/api/src/projects/invites/dto/create-invite.dto.ts` — `role`, removed here
- `apps/api/src/projects/invites/project-invites.service.ts` — `effectiveRoleKey`, edited here
- `apps/api/src/i18n/en/members.json` — `roleAndRoleKey`, removed here

Also edited: `apps/api/src/i18n/zh/members.json`, `apps/api/src/i18n/en/invites.json`, `apps/api/src/i18n/zh/invites.json`.

**US-005**
- `apps/api/src/users/users-admin.service.ts` — `create` / `update`, edited here
- `apps/api/src/users/dto/create-user.dto.ts` — `role`, removed here
- `apps/api/src/users/dto/update-user.dto.ts` — `role`, removed here
- `apps/api/src/agents/agents.service.ts` — `generateApiKey`, edited here
- `apps/api/src/agents/prisma-agent.repository.ts` — `createRolesAndCapabilities`, renamed here

Also edited: `apps/api/src/agents/dto/create-agent.dto.ts`.

**US-006**
- `apps/api/src/projects/members/project-members.service.ts` — `list`, edited here
- `apps/api/src/projects/members/dto/project-member.dto.ts` — `role`, removed here
- `apps/api/src/agents/dto/agent-response.dto.ts` — `roles`, removed here
- `apps/api/src/agents/dto/project-agent.dto.ts` — `roles` and `scoping`, removed here
- `apps/api/src/agents/prisma-agent.repository.ts` — the `roles` includes, removed here

Also edited: `apps/api/src/projects/members/project-members.controller.ts`, `apps/api/src/projects/members/dto/member-binding.dto.ts`, `apps/api/src/projects/members/domain/project-member.domain.ts`, `apps/api/src/projects/members/project-member.queries.ts`, `apps/api/src/projects/members/prisma-project-members.repository.ts`, `apps/api/src/agents/dto/agent-me-response.dto.ts`, `apps/api/src/agents/agents.service.ts`.

**US-007**
- `apps/api/src/projects/invites/dto/invite.dto.ts` — `role`, removed here
- `apps/api/src/projects/invites/dto/invite-preview.dto.ts` — `role`, removed here
- `apps/api/src/projects/invites/project-invites.service.ts` — `toDto`, edited here
- `apps/api/src/projects/invites/invite-acceptance.service.ts` — the preview, edited here
- `apps/api/src/users/dto/user-admin.dto.ts` — `role`, removed here

Also edited: `openapi.json`.

**US-008**
- `apps/cli/src/index.ts` — command registration, edited here
- `apps/cli/src/commands/label.ts` — a command module to mirror, read
- `apps/cli/src/commands/user.ts` — `withContext({}, { requireProject: false })`, read
- `apps/cli/src/utils/error.ts` — `handleApiError`, read
- `apps/cli/src/generated/sdk.gen.ts` — the role-binding functions, read

**US-009**
- `apps/cli/src/commands/member.ts` — edited here
- `apps/cli/src/commands/member.spec.ts` — edited here
- `apps/cli/src/utils/error.ts` — `handleApiError`, read
- `apps/cli/src/generated/types.gen.ts` — `ProjectMemberDto`, `MemberBindingDto`, `InviteDto`, read

**US-010**
- `apps/cli/src/commands/project.ts` — edited here
- `apps/cli/src/commands/user.ts` — edited here
- `apps/cli/src/commands/agent.ts` — edited here
- `openapi.json` — the US-007 contract, read
- `apps/cli/src/generated/sdk.gen.ts` — regenerated here (gitignored), read

**US-011**
- `apps/web/composables/useProjectAgents.ts` — edited here
- `apps/web/pages/[project]/agents.vue` — edited here
- `apps/web/composables/useApprovalNotifications.ts` — edited here
- `apps/web/components/ProjectMembersPanel.vue` — edited here
- `apps/web/composables/useProjectMembers.ts` — edited here

Also edited: `apps/web/pages/agents.vue`, `apps/web/composables/useProjectInvites.ts`, `apps/web/pages/invite/[token].vue`, `apps/web/composables/useAdminUsers.ts`, `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`.

### Creates

**US-001**
- `apps/api/test/integration/permissions/last-project-admin-guard.integration.spec.ts` — the US-001 integration ACs
- `apps/api/src/permissions/membership.service.removal-guards.spec.ts` — the US-001 and US-002 unit ACs on `MembershipService`
- `apps/api/src/permissions/role-admin.service.removal-override.spec.ts` — US-001 AC-9 and AC-10

**US-002**
- `apps/api/src/permissions/open-agent-tickets.queries.ts` — `countOpenAgentTickets`, `MAX_OPEN_TICKET_REFS`
- `apps/api/test/integration/permissions/open-ticket-guard.integration.spec.ts` — the US-002 integration ACs

**US-003**
- `apps/api/test/integration/permissions/legacy-routes-removed.integration.spec.ts` — the US-003 ACs

**US-004**
- `apps/api/test/integration/permissions/member-invite-role-keys-only.integration.spec.ts` — the US-004 ACs

**US-005**
- `apps/api/test/integration/permissions/user-agent-no-legacy-roles.integration.spec.ts` — the US-005 ACs

**US-006**
- `apps/api/test/integration/permissions/member-agent-response-fields.integration.spec.ts` — the US-006 ACs

**US-007**
- `apps/api/test/integration/permissions/invite-user-response-fields.integration.spec.ts` — the US-007 ACs

**US-008**
- `apps/cli/src/commands/role-binding.ts` — the command group
- `apps/cli/src/commands/role-binding.spec.ts` — the US-008 ACs

**US-009**
- None.

**US-010**
- None.

**US-011**
- None.

### Modifies

**US-001**
- `apps/api/src/permissions/test-helpers/in-memory-permissions.ts` — bindingRepo() has no lockProjectMembers or countActiveProjectAdmins, so a MembershipService built on it throws when removeBinding reaches a project-admin binding, and it cannot be set to reject for AC-13. The replacing invariant: the double gains both methods; the lock resolves and is recorded in store.calls; the counter answers the enabled users holding a project-admin binding in the project from the store, and a test can make it reject; every existing case is unchanged.

- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — .nax/rules/api-testing.md asks endpoint changes to be reflected here, and DELETE /role-bindings/:id gains a 409. The replacing invariant: one case is added in the role-bindings section: the last enabled Project Admin's project-admin binding, deleted by a caller without role.binding.global, answers 409 members.lastAdmin; every existing case is unchanged.

**US-002**
- `apps/api/src/permissions/test-helpers/in-memory-permissions.ts` — bindingRepo() has no lockProjectAgents, countOtherProjectBindings or countOpenAgentTickets, so removeBinding throws for an AGENT binding in a project. The replacing invariant: the double gains the three methods; the lock resolves and is recorded in store.calls; countOtherProjectBindings answers from the store; countOpenAgentTickets answers count 0 and no refs unless a test sets it or makes it reject.
- `apps/api/src/agents/prisma-agent.repository.project-roster-writes.spec.ts` — 'countOpenProjectTickets counts...' pins the body that moves to permissions/open-agent-tickets.queries.ts. The replacing invariant: the same counting and ref assertions run against countOpenAgentTickets(db, agentId, projectId); the other cases are unchanged here (US-003 deletes the roster-write cases).

**US-003**
- `apps/api/src/agents/agents-project-roster.service.spec.ts` — the whole file tests AgentsService.addToProject and removeFromProject, which are deleted. The replacing invariant: the file is deleted; roster writes are POST and DELETE on the role-bindings route, and the open-ticket refusal is pinned by US-002.
- `apps/api/src/projects/members/project-members.service.spec.ts` — the doubles createMember, updateMemberRole and deleteMemberIfPresent and the cases 'updateRole/remove 404 a non-member', 'a project admin cannot demote or remove the last project ADMIN', AC-12, AC-13, 'a global ADMIN may remove the last project ADMIN', 'keeping ADMIN, or changing a non-admin...' and 'a disabled ADMIN does not trigger the last-admin guard' test the deleted updateRole and remove. The replacing invariant: those cases and doubles are removed; the add and list cases are unchanged here (US-004 and US-006 change them).
- `apps/api/src/projects/members/project-members.controller.spec.ts` — the it.each row ['updateRole', 'role.binding.manage'] and 'remove returns an empty Ok' name deleted handlers. The replacing invariant: the row and the case are removed; the guard-order and list cases are unchanged here.
- `apps/api/src/projects/members/dto/member-dto.spec.ts` — it imports the deleted UpdateMemberRoleDto, and 'UpdateMemberRoleDto accepts ADMIN | DEVELOPER | VIEWER only' tests it. The replacing invariant: the import and the case are removed; the AddMemberDto cases are unchanged here (US-004 changes them).
- `apps/api/src/agents/agents.service.spec.ts` — the describe('updateRoles') block and the replaceRoles mocks test a deleted method. The replacing invariant: the block and the mocks are removed; every other case is unchanged here.
- `apps/api/src/agents/agents.controller.spec.ts` — describe('PATCH /api/agents/:slug/update-roles') (four cases) and the updateRoles mock name the deleted handler. The replacing invariant: the block and the mock are removed.
- `apps/api/src/agents/prisma-agent.repository.project-roster-writes.spec.ts` — 'addToProjectRoster inserts...', 'addToProjectRoster reports alreadyAssigned...', 'removeFromProjectRoster deletes...' and any hasLocalMembership case test deleted methods, and the countOpenProjectTickets case targets a deleted delegate. The replacing invariant: those cases are removed (the counting is pinned on countOpenAgentTickets by US-002); 'lockProjectAgents takes the PROJECT_AGENTS advisory lock' is unchanged.
- `apps/api/src/permissions/folded-keys.spec.ts` — FOLDED_ROUTES and FOLDED_OPERATIONS name addProjectAgent, removeProjectAgent, ProjectMembersController.updateRole and AgentsController.updateRoles, so AC-5 and AC-6 fail. The replacing invariant: the tables hold only PATCH /projects/:slug/agents/:agentSlug with agent.update; AC-1 to AC-4 are unchanged.
- `apps/api/src/projects/projects.controller.spec.ts` — the it.each rows addProjectAgent and removeProjectAgent in requiresCases and projectScoped name deleted handlers. The replacing invariant: the four rows are removed.
- `apps/api/test/integration/projects/member-bindings.integration.spec.ts` — AC-6, AC-7, AC-8 and AC-14 (PATCH on the member route), AC-9 (DELETE on the member route) and the F1 it.each (PATCH and DELETE) use deleted routes. The replacing invariant: a role change is a POST of the new binding plus a DELETE of the old one on the role-bindings route; a removal deletes each of the member's bindings there; F1 finds the member beyond the listing cap through the members list and removes it through the role-bindings route; the last-admin refusal is asserted on the binding DELETE (409 members.lastAdmin).
- `apps/api/test/integration/projects/project-members.integration.spec.ts` — 'a project admin adds a viewer and changes their role', 'the last project ADMIN cannot demote or remove themselves', 'removal takes effect on the next request' and 'a disabled project ADMIN does not count as an active admin' use the deleted PATCH and DELETE. The replacing invariant: the same outcomes through the role-bindings route (a role change is grant then revoke; the last-admin case answers 409 members.lastAdmin on the binding DELETE by the custom co-admin; a self-removal answers the self-binding 403).
- `apps/api/test/integration/permissions/core-members-invites.integration.spec.ts` — AC-3 (PATCH on the member route answers 403), AC-4 (DELETE on the member route answers 403) and 'B2: removing a member ... ends its warmed project keys' (DELETE on the member route) use deleted routes. The replacing invariant: AC-3 and AC-4 assert that a developer's DELETE of another member's binding on the role-bindings route answers 403 permissions; B2 removes the member's binding there and its warmed keys end at once.
- `apps/api/test/integration/permissions/membership-agent-roster.integration.spec.ts` — its add and remove helpers drive the deleted roster routes, so AC-1, AC-3, AC-4, AC-6, AC-7, AC-8, AC-9 and AC-13 fail (AC-2 and AC-5 through the same setup). The replacing invariant: add is a viewer binding POST for the agent on the role-bindings route and remove deletes the agent's bindings in the project there; a duplicate add answers 201 with the same binding id (the old 409 projectAgents.alreadyAssigned case, AC-3, becomes that assertion); AC-8 asserts 409 projectAgents.hasOpenTickets on the binding DELETE and the viewer binding stays; the pickup and me cases are unchanged.
- `apps/api/test/integration/permissions/core-agent-routes.integration.spec.ts` — 'AC-13: a non-admin user is refused by PATCH /agents/<slug>/update-roles...', 'AC-11: a global admin updates the roles of a roster-only agent' and 'AC-12: updating legacy roles grants no key on the next ticket create' test the deleted route. The replacing invariant: the three cases are removed; the pickup cases are unchanged.
- `apps/api/test/integration/permissions/core-project-routes.integration.spec.ts` — AC-11 to AC-14 test POST and DELETE on the project roster route. The replacing invariant: AC-11 asserts that a developer's viewer binding POST for an agent in p1 on the role-bindings route answers 403 permissions; AC-12 that a project admin's answers 201; AC-13 that a project admin's DELETE of the binding of an agent with no open tickets answers 204; AC-14 that a developer's DELETE answers 403.
- `apps/api/test/integration/permissions/membership-queries.integration.spec.ts` — 'legacy-only member PATCH is 404 and adding a legacy-only roster agent succeeds' expects 201 from the roster POST. The replacing invariant: the roster add is a viewer binding POST for the agent on the role-bindings route (201); the PATCH half is removed.
- `apps/api/test/integration/projects/project-membership-gate.integration.spec.ts` — 'AC4: PATCH /api/comments/:id returns 404... after their project membership is removed' removes the member with the deleted member DELETE (expects 200). The replacing invariant: the member's bindings are deleted through the role-bindings route (204) and the comment PATCH still answers 404.
- `apps/api/test/integration/live/live-stream.integration.spec.ts` — 'removing the member closes their stream within one heartbeat' removes the member with the deleted member DELETE. The replacing invariant: the member's binding is deleted through the role-bindings route and the stream closes within one heartbeat.
- `apps/api/test/integration/openapi-spec/spec-integrity.integration.spec.ts` — the update-roles PATCH row generates a failing presence case. The replacing invariant: the row is removed; the other rows are unchanged.
- `apps/api/test/e2e/agents.e2e.spec.ts` — 'PATCH /api/agents/:slug/update-roles — replaces roles' tests the deleted route. The replacing invariant: the case is removed.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — 'PATCH /api/agents/:slug/update-roles — replaces agent roles' tests the deleted route; the 'Agent Permissions (AC-5 & AC-6)' beforeAll gives the agent its roles through update-roles, so the whole describe fails in setup; the roster cases AC2, AC4, AC12, AC13, AC7 and AC8 use the deleted roster routes. The replacing invariant: the update-roles case is removed; the beforeAll grants the agent the matching project role bindings through the role-bindings route; roster adds are viewer binding POSTs (201; AC4's duplicate add answers 201 with the same binding id); an agent's own key is refused by POST and DELETE on the role-bindings route (403); AC7 answers 409 projectAgents.hasOpenTickets on the binding DELETE; AC8 answers 204 and the viewer binding is gone.
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — its expectedPending set pins PENDING_SURFACE_KEYS to the five approval and audit keys. The replacing invariant: the set also holds member.remove; every other case is unchanged.
- `scripts/smoke-test-cli.sh` — it calls the roster POST for koda, which answers 404 after this story, so the CI Smoke test step fails at 'Add agent to project roster'. The replacing invariant: the roster call is replaced by a viewer binding POST for the agent in the project on the role-bindings route (HTTP 201 checked like the four workflow bindings after it); every later step is unchanged.

**US-004**
- `apps/api/src/projects/members/project-members.service.spec.ts` — 'writes never assert the caller's admin role', 'add maps DEVELOPER to developer and reads the written member', 'the legacy role field is granted through the same rules' and 'both fields is 400 members.roleAndRoleKey' add with the legacy role field. The replacing invariant: adds pass roleKey; an add with no roleKey grants viewer through assertMayGrant and createBinding; the both-fields case is removed.
- `apps/api/src/projects/members/dto/member-dto.spec.ts` — 'AddMemberDto needs an email and an assignable role' expects a role error, and 'AddMemberDto accepts a role key, a legacy role, both, or neither' validates the legacy field. The replacing invariant: AddMemberDto validates email and an optional roleKey only; a role value produces no error; an explicit roleKey null is a validation error.
- `apps/api/src/projects/invites/dto/create-invite.dto.spec.ts` — 'rejects a role outside ADMIN | DEVELOPER | VIEWER (including AGENT)' and 'US-005: role and roleKey may both be absent here...' (its nullRole expectation) test the removed field. The replacing invariant: CreateInviteDto has no role; roleKey stays optional at the DTO with its key-grammar check; the trim and email cases are unchanged.
- `apps/api/src/projects/invites/project-invites.service.spec.ts` — US-008 AC-2, AC-3, 'US-003: the ADDED outcome...', AC-13, AC-4, AC-5, AC-6, the three B4 inviter cases, AC-7, AC-10, AC-11 and both AC-12 cases create with role and no roleKey; 'maps the legacy role to its key...' and 'refuses a request that sends both role and roleKey...' test the removed mapping and invites.roleAndRoleKey. The replacing invariant: every create passes the mapped roleKey with the same expectations; the two mapping cases become one case that a create without roleKey rejects with invites.roleRequired.
- `apps/api/test/unit/i18n/members-translation-keys.spec.ts` — the members.roleAndRoleKey (US-004) describe pins a key this story deletes. The replacing invariant: the describe is removed; the other key cases are unchanged.
- `apps/api/test/integration/projects/member-bindings.integration.spec.ts` — AC-1 (an add with role DEVELOPER expects developer), AC-4 and AC-11/AC-12 (invites with role) use the removed fields. The replacing invariant: those requests send the mapped roleKey with the same expectations.
- `apps/api/test/integration/projects/project-members.integration.spec.ts` — 'a global admin adds a project admin and a developer' and 'rejects an unassignable role with 400' send the legacy role. The replacing invariant: the adds send roleKey project-admin and developer; the unassignable case sends roleKey agent and expects the permissions.scopeMismatch 400.
- `apps/api/test/integration/projects/member-role-keys.integration.spec.ts` — 'AC-4: sending both role and roleKey is 400 members.roleAndRoleKey' and 'AC-6: the legacy role field only goes through the same rules' test the removed field, and the case around its line 149 expects role ADMIN from a legacy-field add. The replacing invariant: a body with both answers 201 with the roleKey role; a body with only role grants viewer; the line-149 case sends roleKey project-admin.
- `apps/api/test/integration/projects/invite-role-keys.integration.spec.ts` — 'AC-3: neither role nor roleKey is 400...; both is 400 invites.roleAndRoleKey' and 'AC-3: an explicit null roleKey or role is a 400 validation error' test the removed field, and its member-add setup sends role. The replacing invariant: neither is 400 invites.roleRequired; both answers 201 with the roleKey role; an explicit roleKey null is a 400 validation error and role null is stripped; the setup sends roleKey.
- `apps/api/test/integration/projects/project-invites-admin.integration.spec.ts` — the setup adds members with role (they come out viewer), and US-004 AC-2 to AC-8 create invites with role. The replacing invariant: the setup and the creates send the mapped roleKey; AC-1 and AC-9 are unchanged.
- `apps/api/test/integration/projects/project-invites-public.integration.spec.ts` — its invite creates, including 'US-005 AC-10: resending an invite id from another project 404...', send role. The replacing invariant: the creates send the mapped roleKey.
- `apps/api/test/integration/permissions/core-members-invites.integration.spec.ts` — AC-2 (expects developer from a role add), AC-9 and B4 (invites with role) and the setups send the legacy role. The replacing invariant: those requests send the mapped roleKey with the same expectations.
- `apps/api/test/integration/permissions/core-admin-public-implicit.integration.spec.ts` — its beforeAll creates the AC-12 invite with role VIEWER and no roleKey, which now answers 400, so the whole file fails in setup. The replacing invariant: the invite sends roleKey viewer.
- `apps/api/test/integration/fleet/fleet-approvals-api.integration.spec.ts` — its setup adds members with role ADMIN or DEVELOPER, which now grants viewer, so padmin cannot decide approvals. The replacing invariant: the setup sends the mapped roleKey; every assertion is unchanged.
- `apps/api/test/integration/fleet/fleet-budgets-api.integration.spec.ts` — its setup adds members with a legacy role, which now grants viewer. The replacing invariant: the setup sends the mapped roleKey; every assertion is unchanged.
- `apps/api/test/integration/fleet/fleet-repos.integration.spec.ts` — its setup adds members with a legacy role, which now grants viewer. The replacing invariant: the setup sends the mapped roleKey; every assertion is unchanged.
- `apps/api/test/integration/fleet/fleet-schedules-api.integration.spec.ts` — its setup adds members with a legacy role, which now grants viewer. The replacing invariant: the setup sends the mapped roleKey; every assertion is unchanged.
- `apps/api/test/integration/live/live-stream.integration.spec.ts` — its setup adds members with a legacy role, which now grants viewer. The replacing invariant: the setup sends the mapped roleKey; every assertion is unchanged.
- `apps/api/test/integration/notifications/mentions.integration.spec.ts` — its setup adds members with a legacy role, which now grants viewer. The replacing invariant: the setup sends the mapped roleKey; every assertion is unchanged.
- `apps/api/test/integration/notifications/notifications-api.integration.spec.ts` — its setup adds members with a legacy role, which now grants viewer. The replacing invariant: the setup sends the mapped roleKey; every assertion is unchanged.
- `apps/api/test/integration/permissions/membership-queries.integration.spec.ts` — its member adds send a legacy role. The replacing invariant: they send the mapped roleKey; every assertion is unchanged.
- `apps/api/test/integration/projects/project-members-principals.integration.spec.ts` — its member adds send a legacy role. The replacing invariant: they send the mapped roleKey; every assertion is unchanged.
- `apps/api/test/integration/projects/project-membership-gate.integration.spec.ts` — its member adds send a legacy role. The replacing invariant: they send the mapped roleKey; every assertion is unchanged.
- `apps/api/test/integration/projects/project-role-permissions.integration.spec.ts` — its addMember(slug, who, role) helper sends the legacy role. The replacing invariant: the helper takes and sends a roleKey and its callers pass the mapped key; every assertion is unchanged here (US-006 changes the viewerRole case).
- `apps/api/test/integration/skills/project-skills-routes.integration.spec.ts` — its member adds send a legacy role. The replacing invariant: they send the mapped roleKey; every assertion is unchanged.
- `apps/api/test/integration/vcs/vcs-webhook-secret.integration.spec.ts` — its padmin/pdev/pviewer setup loop adds members with a legacy role. The replacing invariant: the loop sends the mapped roleKey; every assertion is unchanged.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — its member adds and invites send a legacy role. The replacing invariant: they send the mapped roleKey; every assertion is unchanged.

**US-005**
- `apps/api/src/users/dto/user-dto.spec.ts` — 'CreateUserDto accepts a valid user and rejects... unknown roles', 'US-004: CreateUserDto accepts an absent role...' and 'UpdateUserDto allows an empty patch...' expect role errors. The replacing invariant: neither DTO validates a role and a role value produces no error; the disabled and ListUsersQuery cases are unchanged.
- `apps/api/src/users/users-admin.service.spec.ts` — 'grants a global admin binding through setGlobalAdmin when the DTO asks for ADMIN', 'refuses to remove the last active admin, under the lock' (patch role MEMBER), 'grants the admin binding through setGlobalAdmin and leaves the role to it', 'removes the admin binding through setGlobalAdmin on a demotion', 'returns the stored role after a requested demotion of an Owner' and 'bumps tokenVersion on re-enable, not on a role change' create or patch with role. The replacing invariant: create never calls setGlobalAdmin; the last-admin case disables the target and still asserts lockUserAdministration before countActiveAdmins and the 409; the role-change cases are removed; update never calls setGlobalAdmin; re-enable still bumps tokenVersion.
- `apps/api/src/agents/agents.service.spec.ts` — 'should reject invalid roles before creating the agent' tests the removed validation, and the create cases expect createRolesAndCapabilities. The replacing invariant: the case is removed; create calls createCapabilities(agentId, capabilities).
- `apps/api/src/agents/agents-create.routes.spec.ts` — 'AC7: a failing roles/capabilities write ... HTTP 500' and 'AC7 boundary: a failing capability write...' expect agentRoleEntry.createMany to be called. The replacing invariant: no agentRoleEntry write is expected; the injected failure is the agentCapabilityEntry.createMany write, and the 500 and the rolled-back agent row are unchanged.
- `apps/api/src/agents/agents-create.service.spec.ts` — 'AC6: rejects with the createRolesAndCapabilities error...' and 'AC6 boundary' assert the write order with createRolesAndCapabilities. The replacing invariant: the same order and rejection with createCapabilities(agentId, capabilities).
- `apps/api/src/agents/prisma-agent.repository.spec.ts` — describe('PrismaAgentRepository.createRolesAndCapabilities (US-003)') tests the renamed method and its agentRoleEntry write. The replacing invariant: the describe tests createCapabilities(agentId, capabilities): one agentCapabilityEntry.createMany on the ambient client, no agentRoleEntry write, no nested transaction.
- `apps/api/src/agents/agent-create-canonical-dto.routes.spec.ts` — it mocks agentRepo.createRolesAndCapabilities, so after the rename POST /api/agents answers 500. The replacing invariant: the mock is createCapabilities; every assertion is unchanged.
- `apps/api/test/integration/agents/agents-create-rollback.integration.spec.ts` — 'AC7: a failing agentRoleEntry.createMany rolls back the agent row' injects a failure into a write that no longer happens. The replacing invariant: the failure is injected into agentCapabilityEntry.createMany and the agent row is rolled back; the other cases are unchanged.
- `apps/api/test/integration/users/admin-users.integration.spec.ts` — 'demoting an admin revokes their ADMIN token immediately', 'an admin cannot demote or disable themselves' and 'two admins demoting each other at once...' patch role, and its admin users are created with role. The replacing invariant: admins get a global admin binding after creation; demotion is the DELETE of the target's global admin binding on the role-bindings route (token revoked immediately); the self case asserts only the self-disable 403 users.self; the concurrent case is two concurrent disables of the two admins, of which exactly one answers 409 users.lastAdmin.
- `apps/api/test/integration/permissions/bootstrap-baselines.integration.spec.ts` — 'AC-14: demoting an admin removes the admin binding', 'AC-22: an Owner keeps User.role ADMIN...' and the cases that patch role MEMBER (one expecting 409) use the removed field, and admins are created with role. The replacing invariant: admins get a global admin binding after creation; demotion deletes the admin binding on the role-bindings route; AC-22 deletes an Owner's admin binding and the Owner keeps User.role ADMIN; the 409 case is a disable of the last admin; AC-19 is unchanged.
- `apps/api/test/integration/permissions/core-admin-public-implicit.integration.spec.ts` — 'AC-5: a global admin gets 403 users.self from PATCH /admin/users/<own id> with { role: MEMBER }' now answers 200, and its admins are created with role. The replacing invariant: AC-5 sends disabled true for the admin's own id and expects 403 users.self; admins get a global admin binding after creation.
- `apps/api/test/integration/permissions/core-agent-routes.integration.spec.ts` — its users are created through POST /api/admin/users with a role field, and the ones meant as global admins get no admin binding. The replacing invariant: those users get a global admin binding after creation; every assertion is unchanged.
- `apps/api/test/integration/permissions/core-members-invites.integration.spec.ts` — its users are created with a role field, and the ones meant as global admins get no admin binding. The replacing invariant: those users get a global admin binding after creation; every assertion is unchanged.
- `apps/api/test/integration/permissions/core-project-routes.integration.spec.ts` — its users are created with a role field, and the ones meant as global admins get no admin binding. The replacing invariant: those users get a global admin binding after creation; every assertion is unchanged.
- `apps/api/test/integration/permissions/me-permissions.integration.spec.ts` — its user helper sends a role field, so a user meant as a global admin gets no admin binding. The replacing invariant: the helper gives a global admin binding after creation when asked for an admin; every assertion is unchanged.
- `apps/api/test/integration/permissions/permission-catalog.integration.spec.ts` — its users are created with a role field, and the ones meant as global admins get no admin binding. The replacing invariant: those users get a global admin binding after creation; every assertion is unchanged.
- `apps/api/test/integration/permissions/remaining-route-permissions.integration.spec.ts` — its users are created with a role field, and the ones meant as global admins get no admin binding. The replacing invariant: those users get a global admin binding after creation; every assertion is unchanged.
- `apps/api/test/integration/permissions/retired-casl-factory.integration.spec.ts` — its users are created with a role field, and the ones meant as global admins get no admin binding. The replacing invariant: those users get a global admin binding after creation; every assertion is unchanged.
- `apps/api/test/integration/permissions/role-bindings-api.integration.spec.ts` — its users are created with a role field, and the ones meant as global admins get no admin binding. The replacing invariant: those users get a global admin binding after creation; every assertion is unchanged.
- `apps/api/test/integration/permissions/role-bindings-filters.integration.spec.ts` — its user helper sends a role field, so a user meant as a global admin gets no admin binding. The replacing invariant: the helper gives a global admin binding after creation when asked for an admin; every assertion is unchanged.
- `apps/api/test/integration/permissions/roles-api.integration.spec.ts` — its user helper sends a role field, so a user meant as a global admin gets no admin binding. The replacing invariant: the helper gives a global admin binding after creation when asked for an admin; every assertion is unchanged.
- `apps/api/test/integration/projects/project-membership-gate.integration.spec.ts` — its users are created with a role field, and the ones meant as global admins get no admin binding. The replacing invariant: those users get a global admin binding after creation; every assertion is unchanged.
- `apps/api/test/integration/webhook/webhook-permissions.integration.spec.ts` — its users are created with a role field, and the ones meant as global admins get no admin binding. The replacing invariant: those users get a global admin binding after creation; every assertion is unchanged.
- `apps/api/test/integration/fleet/fleet-approvals-api.integration.spec.ts` — its users are created with a role field, and the ones meant as global admins get no admin binding. The replacing invariant: those users get a global admin binding after creation; every assertion is unchanged.
- `apps/api/test/integration/fleet/fleet-budgets-api.integration.spec.ts` — its users are created with a role field, and the ones meant as global admins get no admin binding. The replacing invariant: those users get a global admin binding after creation; every assertion is unchanged.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — it creates an agent with roles DEVELOPER and REVIEWER and asserts them on GET /api/agents/:slug, and the agentRoleNames / syncAgentRoles helpers are built around those roles. The replacing invariant: the agent is created without roles and the case asserts its capabilities; the helpers grant project role bindings instead of legacy roles.
- `apps/api/src/agents/dto/create-agent.dto.spec.ts` — 'roles and capabilities stay optional' passes roles to a DTO that no longer has them (it still passes, since the pipe strips it, but pins a removed field). The replacing invariant: the case is titled for capabilities and passes no roles.
- `scripts/smoke-test-cli.sh` — it creates the agent with a roles array that the API now strips. The replacing invariant: the create body has no roles; every later step is unchanged.

**US-006**
- `apps/api/src/projects/members/project-members.service.spec.ts` — the four list cases assert canManage and viewerRole, and the service is built with a PermissionService double. The replacing invariant: list resolves to the page alone, still calls resolveMembership (a refusal propagates) and never calls can; the service is built without the PermissionService argument.
- `apps/api/src/projects/members/project-members.controller.spec.ts` — 'list parses paging strings and returns the page envelope with canManage' expects canManage. The replacing invariant: the envelope is the page fields alone.
- `apps/api/src/agents/agents.service.spec.ts` — the shared mockAgentDto fixtures carry roles, so 'should return all agents with roles and capabilities', 'should include role entries for each agent', 'should return agent by slug with roles and capabilities', 'should include roles in response', the findMe case, 'should include roles with all AgentRole enum values' and 'returns the scoped project roster as ProjectAgentListDto' (scoping, roles) fail. The replacing invariant: the fixtures and expectations have no roles; the roster answer is { items } without roles; the role-enum case is removed.
- `apps/api/src/agents/agents.controller.spec.ts` — 'should include roles and capabilities for each agent', 'should include roles and capabilities in profile' and 'should include roles and capabilities' expect roles. The replacing invariant: the same cases assert capabilities and no roles property.
- `apps/api/src/projects/projects.controller.spec.ts` — 'US-002 AC1: returns the scoped project roster...' (data.scoping), 'US-002 AC2: exposes roster metadata, roles, capabilities' and 'US-002 AC9: reports roster scoping disabled' pin removed fields. The replacing invariant: AC1 asserts { items }, AC2 asserts the metadata and capabilities with no roles, AC9 is removed.
- `apps/api/src/agents/prisma-agent.repository.find-roster.spec.ts` — its fixtures carry roles and it expects roles DEVELOPER on the roster record. The replacing invariant: the fixtures and the record have no roles; every other field is unchanged.
- `apps/api/test/integration/permissions/core-members-invites.integration.spec.ts` — AC-5, AC-6 and AC-12 assert canManage and viewerRole. The replacing invariant: AC-5 and AC-6 assert the members list answers 200 or 403 as before, without the two fields; AC-12 is removed (its gate is the me-permissions route, pinned by p1-web).
- `apps/api/test/integration/projects/project-role-permissions.integration.spec.ts` — 'members page reports viewerRole for the caller'. The replacing invariant: the case is removed.
- `apps/api/test/integration/permissions/agent-scoping-removed.integration.spec.ts` — 'AC-6: project admin sees scoping true'. The replacing invariant: the roster answer for that Project Admin is { items } with no scoping key.
- `apps/api/test/integration/permissions/membership-project-access.integration.spec.ts` — the member-page case that asserts canManage and viewerRole ADMIN, 'US-001 AC-12: a global admin with no source... viewerRole ADMIN' and 'US-001 AC-13: a viewer binding gets viewerRole VIEWER'. The replacing invariant: the member-page case asserts 200 without the two fields; AC-12 and AC-13 assert the members list answers 200 for those principals.
- `apps/api/test/integration/agents/agent-project-roster.integration.spec.ts` — 'AC1+AC2: returns a roster row with ... roles, capabilities, addedBy' expects roles DEVELOPER. The replacing invariant: the row has no roles property; the other fields are unchanged.
- `apps/api/test/integration/projects/project-members-principals.integration.spec.ts` — its local response type declares canManage and viewerRole. The replacing invariant: the two fields are removed from the type; every assertion is unchanged.
- `apps/api/test/e2e/agents.e2e.spec.ts` — 'GET /api/agents/:slug — returns agent details' expects roles. The replacing invariant: it expects no roles property.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — 'GET /api/projects/:slug/agents — 200 returns agents with assigned tickets' asserts scoping. The replacing invariant: the answer has only items.

**US-007**
- `apps/api/src/projects/invites/project-invites.service.spec.ts` — 'AC-8: an invite DTO exposes exactly the public fields' lists role. The replacing invariant: the field list has no role.
- `apps/api/src/projects/invites/invite-acceptance.service.spec.ts` — the preview field-set case (its key list includes role) and 'US-005: a custom role key shows with a null legacy role'. The replacing invariant: the preview keys have no role; the custom-role case asserts roleKey and roleName only.
- `apps/api/test/integration/projects/invite-role-keys.integration.spec.ts` — 'AC-1: ...the DTO names the role' (asserts role null) and 'AC-9: the preview answers exactly eight fields'. The replacing invariant: AC-1 asserts roleKey and roleName and no role; AC-9 expects exactly seven fields.
- `apps/api/test/integration/projects/project-invites-public.integration.spec.ts` — 'US-005 AC-1: previews a pending invite with exactly the eight public fields' and 'US-005 AC-1: previews an invite role that differs from the default'. The replacing invariant: seven fields, no role; the second case asserts roleKey and roleName.
- `apps/api/test/integration/users/admin-users.integration.spec.ts` — the create case expects role MEMBER in the created user. The replacing invariant: the created user has no role property; email and disabled are unchanged.
- `openapi.json` — records the routes and DTOs this feature removes. The replacing invariant: regenerated with bun run api:export-spec after the last API change; every other path and schema unchanged.

**US-008**
None. The story only adds role-binding.ts, its spec and one registration line in apps/cli/src/index.ts; no existing CLI test asserts the registered command list.

**US-009**
- `apps/cli/src/commands/member.spec.ts` — 'add sends email and role' and 'AC11: member add still calls projectMembersControllerAdd with the resolved slug and body' expect a body with role; 'role changes a member role' tests the deleted command; 'remove targets the --project override' expects projectMembersControllerRemove; 'AC1: member invite sends ... the email/role body' expects role; 'AC4: member invite prints the added message when the user already existed' prints member.role; 'AC6: member invites prints a table with ID/Email/Role/Status/Expires' fills the Role cell from invite.role; the generated-module mock lacks roleBindingsControllerRemove. The replacing invariant: adds and invites send email and roleKey; the role command case is removed; remove pages the members list for the --project slug and calls roleBindingsControllerRemove per binding id; the added message prints the bindings' role names; the Role cell is roleName; the mock gains roleBindingsControllerRemove.

**US-010**
- `apps/cli/src/commands/project.spec.ts` — 'US-005 AC-3: warns when agent scoping is off' tests the removed warning; 'US-005 AC-4: adds an agent to the project', 'US-005: prints the server-returned agent slug after adding', 'US-005: prints the added agent DTO as JSON', 'US-005: prints the removal result as JSON', 'US-005 AC-5: removes an agent from the project' and 'US-005 AC-6: reports an API conflict when removing an agent' test the deleted commands; fixtures carry scoping and roles. The replacing invariant: those cases are removed; the roster fixtures are { items } without roles; AC-1 and AC-2 are unchanged.
- `apps/cli/src/commands/user.spec.ts` — 'create sends the body with role MEMBER by default' expects role MEMBER. The replacing invariant: the create body is email, name and password with no role.
- `apps/cli/src/commands/agent.spec.ts` — 'creates an agent and prints the generated API key' passes --roles DEVELOPER,AGENT and expects roles, and 'defaults roles to an empty array when --roles is omitted' expects an empty roles array. The replacing invariant: the create case passes no --roles and its body has no roles; the defaults case is removed.

**US-011**
- `apps/web/tests/composables/useProjectAgents.spec.ts` — 'load populates items and scoping', 'load uses scoping false when response says false' and 'load defaults scoping to true for an empty response' assert the removed scoping ref; the list helper builds { scoping, items }. The replacing invariant: the helper builds { items }; the first case asserts items and no scoping; the scoping-false case is removed; the empty-response case asserts items is empty.
- `apps/web/tests/pages/agents.spec.ts` — 'AC1: GET /projects/:slug/agents populates one row per item with name, slug, roles, capabilities, status, and open-ticket count' expects CODER and REVIEWER from roles, and 'AC9: a roster response with scoping: false renders the scoping-off note' tests the removed note; fixtures carry scoping and roles. The replacing invariant: AC1's item has no roles and the row text asserts name, slug, capabilities, status and open-ticket count; AC9 is removed; the fixtures drop both fields.
- `apps/web/tests/components/project-members-principals.spec.ts` — 'AC-2: one chip per binding, legacy chips are not removable' and 'a legacy same-key chip the API suppressed appears once the real binding is deleted' use null-id chips, and the base fixture has one. The replacing invariant: every fixture chip has a string id; AC-2 asserts one remove control per chip; the legacy-chip case is removed.
- `apps/web/tests/e2e/fixtures/api-client.ts` — createAgent sends roles, createUser sends role, and addProjectMember sends email and role (the API now strips both and grants viewer). The replacing invariant: no roles, no role, and addProjectMember(token, slug, email, roleKey) posts email and roleKey.
- `apps/web/tests/e2e/fleet-config.e2e.spec.ts` — calls addProjectMember with VIEWER. The replacing invariant: it passes viewer.
- `apps/web/tests/e2e/fleet-threads.e2e.spec.ts` — calls addProjectMember with VIEWER. The replacing invariant: it passes viewer.
- `apps/web/tests/e2e/live-board.spec.ts` — calls addProjectMember with DEVELOPER. The replacing invariant: it passes developer.
- `apps/web/tests/e2e/ticket-project-roles.spec.ts` — calls addProjectMember with ADMIN and DEVELOPER. The replacing invariant: it passes project-admin and developer.
- `apps/web/tests/e2e/ticket-detail-operations.e2e.spec.ts` — calls addProjectMember with DEVELOPER. The replacing invariant: it passes developer.
- `apps/web/tests/e2e/notifications.e2e.spec.ts` — calls addProjectMember with DEVELOPER. The replacing invariant: it passes developer.

### Seams

- **`RemoveBindingOptions` (US-001 producer and consumer).** `RoleAdminService.removeBinding` is its only production caller; US-001 AC-9 and AC-10 trigger `RoleAdminService.removeBinding` over `InMemoryPermissionStore` and assert the options `MembershipService.removeBinding` receives, and AC-1 / AC-2 pin the outcome through `DELETE /role-bindings/:id`.
- **`countOpenAgentTickets` (US-002 producer and consumer).** `PrismaRoleBindingRepository.countOpenAgentTickets` is its production caller; US-002 AC-1 reaches it through `DELETE /role-bindings/:id`.
- **`openapi.json` (US-007) → US-010.** US-010 regenerates `apps/cli/src/generated/` from the file US-007 writes.
- **`roleBindingCommand` (US-008) → `src/index.ts`.** US-008 AC-15 pins what the module registers; the one call in `src/index.ts` is checked by review (the file parses `process.argv` on import and exports nothing to test).
- **`roleBindingsControllerRemove` (generated) → US-008, US-009.** `role-binding revoke` and `member remove` both call it; `member remove` does not import the US-008 module.

## Acceptance Criteria

Every DB-backed AC seeds the system roles (`ensureSystemRoles` or a booted app). "The custom co-admin" is a user holding, in P, a binding of a custom PROJECT role whose permissions are `['*']` (written with the Prisma client) and no `project-admin` binding: it holds every project key in P, so the escalation check lets it remove a `project-admin` binding, and it is not counted as a Project Admin. "A global admin" is a user with a global `admin` binding.

### US-001

1. [integration] P has exactly one enabled user U with a `project-admin` binding. The custom co-admin's `DELETE /role-bindings/:id` for U's `project-admin` binding answers 409 `members.lastAdmin`.
2. [integration] After that refused `DELETE`, U's `project-admin` binding in P still exists.
3. [integration] In the same data, a global admin's `DELETE /role-bindings/:id` for U's `project-admin` binding answers 204.
4. [integration] P has two enabled users with a `project-admin` binding. The custom co-admin's `DELETE` of one of them answers 204.
5. [integration] P has two users with a `project-admin` binding, one of them disabled. The custom co-admin's `DELETE` of the enabled one's binding answers 409 `members.lastAdmin`.
6. [integration] P's only `project-admin` binding belongs to a disabled user. The custom co-admin's `DELETE` of that binding answers 204.
7. [integration] P's only enabled Project Admin is U, and project P2 has another enabled Project Admin. The custom co-admin of P's `DELETE` of U's `project-admin` binding in P answers 409 `members.lastAdmin`.
8. [integration] P has exactly two enabled users with a `project-admin` binding. Two custom co-admin `DELETE /role-bindings/:id` requests, one for each binding, sent concurrently, leave exactly one `project-admin` binding in P.
9. [unit] Over `InMemoryPermissionStore`, with the caller holding a global `admin` binding, `RoleAdminService.removeBinding(caller, id)` for a `USER` `project-admin` binding in P calls `MembershipService.removeBinding` with `(id, { lastProjectAdminOverride: true })`.
10. [unit] Over `InMemoryPermissionStore`, with the caller holding only a project role whose permissions are `['*']` in P, the same call passes `{ lastProjectAdminOverride: false }`.
11. [unit] Over `InMemoryPermissionStore`, `MembershipService.removeBinding(id)` for a `USER` `project-admin` binding in P records `lockProjectMembers` for P in `store.calls` before `lockUser` for that user.
12. [unit] Over `InMemoryPermissionStore`, `MembershipService.removeBinding(id)` for a `project-admin` binding whose user row does not exist (`findUserState` answers `null`) and that is P's only `project-admin` binding resolves.
13. [unit] Over `InMemoryPermissionStore`, with `countActiveProjectAdmins` set to reject with an error, `MembershipService.removeBinding(id)` for an enabled user's `project-admin` binding rejects with that error.

### US-002

1. [integration] Agent A's only binding in P is `viewer`, and one ticket of P that is not `CLOSED` or `REJECTED` is assigned to A. A global admin's `DELETE /role-bindings/:id` for that binding answers 409 `projectAgents.hasOpenTickets`.
2. [integration] After that refused `DELETE`, A's `viewer` binding in P still exists.
3. [integration] Agent A holds `viewer` and `developer` bindings in P and one open ticket of P. A global admin's `DELETE` of the `developer` binding answers 204.
4. [integration] Agent A's only binding in P is `viewer`, and its only ticket in P is `CLOSED`. A global admin's `DELETE` of the binding answers 204.
5. [integration] Agent A's only binding in P is `viewer`, and its only open ticket is in another project P2. A global admin's `DELETE` of the P binding answers 204.
6. [integration] Agent A's only binding in P is `viewer` and it also holds a `projectId`-null binding, with one open ticket in P. A global admin's `DELETE` of the P binding answers 409 `projectAgents.hasOpenTickets`.
7. [unit] Over `InMemoryPermissionStore`, `MembershipService.removeBinding(id)` for an `AGENT` binding in P records `lockProjectAgents` for P in `store.calls`.
8. [unit] Over `InMemoryPermissionStore`, with `countOpenAgentTickets` set to reject with an error, `MembershipService.removeBinding(id)` for an agent's only binding in P rejects with that error, and the binding still exists.
9. [integration] `countOpenAgentTickets(db, agentId, P)` answers `count: 2` for an agent with two open tickets in P, one `CLOSED` ticket in P and one soft-deleted open ticket in P.
10. [integration] For that agent, `countOpenAgentTickets(db, agentId, P).refs` is `[<older ticket's ref>, <newer ticket's ref>]`, each `<project key>-<number>`.
11. [unit] `countOpenAgentTickets(db, agentId, P)`, with a client double whose ticket count answers 1, whose ticket list answers one ticket and whose project lookup answers `null`, rejects with a `KodaError` whose code is `'PROJECT_NOT_FOUND'`.

### US-003

1. [integration] `PATCH /projects/:slug/members/:userId` with `{ role: 'VIEWER' }`, sent by a global admin, answers 404.
2. [integration] `DELETE /projects/:slug/members/:userId`, sent by a global admin for a user with a `developer` binding in P, answers 404.
3. [integration] After that `DELETE`, the user's `developer` binding in P still exists.
4. [integration] `POST /projects/:slug/agents` with `{ agentSlug }`, sent by a global admin, answers 404.
5. [integration] `DELETE /projects/:slug/agents/:agentSlug`, sent by a global admin for an agent with a `viewer` binding in P, answers 404.
6. [integration] `PATCH /agents/:slug/update-roles` with `{ roles: ['DEVELOPER'] }`, sent by a global admin, answers 404.
7. [integration] `PATCH /projects/:slug/agents/:agentSlug` with `{ status: 'PAUSED' }`, sent by a global admin for an agent with a `viewer` binding in P, still answers 200.
8. [unit] `PENDING_SURFACE_KEYS` from `src/permissions/catalog.ts` contains `'member.remove'`.
9. [integration] A Project Admin's second `POST /role-bindings` of the same `viewer` binding for an agent in P answers 201 with the binding id the first answered.

### US-004

1. [integration] `POST /projects/:slug/members` with `{ email, role: 'ADMIN' }` and no `roleKey`, sent by a Project Admin of P, answers 201.
2. [integration] After that add, the added user's bindings in P are exactly one `viewer` binding.
3. [integration] `POST /projects/:slug/members` with `{ email, roleKey: 'developer', role: 'VIEWER' }`, sent by a Project Admin of P, leaves the added user with exactly one `developer` binding in P.
4. [integration] `POST /projects/:slug/members` with `{ email, roleKey: null }`, sent by a Project Admin of P, answers 400.
5. [integration] `POST /projects/:slug/invites` with `{ email, role: 'DEVELOPER' }` for an address with no account, sent by a Project Admin of P, answers 400 `invites.roleRequired`.
6. [integration] After that refused invite, no `ProjectInvite` row exists for the address.
7. [integration] `POST /projects/:slug/invites` with `{ email, roleKey: 'developer', role: 'ADMIN' }` for an address with no account answers 201 with `outcome: 'INVITED'`.
8. [integration] The invite that create answered has `roleKey: 'developer'`.

### US-005

1. [integration] `POST /admin/users` with `{ email, name, password, role: 'ADMIN' }`, sent by a global admin, answers 201.
2. [integration] After that create, the created user's `projectId`-null bindings are exactly one `member` binding.
3. [integration] `PATCH /admin/users/:id` with `{ role: 'ADMIN' }` for a user with only the `member` baseline, sent by a global admin, answers 200.
4. [integration] After that patch, the user has no `admin` or `owner` binding.
5. [integration] `PATCH /admin/users/:id` with `{ role: 'MEMBER' }` for a user with a global `admin` binding, sent by another global admin, leaves the target's `admin` binding in place.
6. [integration] `PATCH /admin/users/:id` with `{ disabled: true }` sent by a global admin for their own id answers 403 `users.self`.
7. [integration] `PATCH /admin/users/:id` with `{ role: 'MEMBER' }` sent by a global admin for their own id answers 200.
8. [integration] `POST /agents` with `{ name, slug, roles: ['DEVELOPER'], capabilities: ['nax'] }`, sent by a global admin, answers 201.
9. [integration] After that create, no `AgentRoleEntry` row exists for the created agent.
10. [integration] After that create, the agent's capability rows are exactly `['nax']`.

### US-006

1. [integration] `GET /projects/:slug/members`, sent by a Project Admin of P, answers a `data` object whose keys are exactly `total`, `current`, `size`, `hasNext`, `hasPrev` and `records`.
2. [integration] In that answer, no record has a `role` property.
3. [integration] In that answer, every item of every record's `bindings` has a string `id`.
4. [integration] `GET /projects/:slug/members`, sent by a user without access to P, answers 403 `projects`.
5. [integration] `GET /projects/:slug/agents`, sent by a Project Admin of P with one `viewer`-bound agent in P, answers a `data` object whose only key is `items`.
6. [integration] In that answer, the one item has no `roles` property.
7. [integration] `GET /agents`, sent by a global admin, answers agents none of which has a `roles` property.
8. [integration] `GET /agents/me`, sent with an agent's API key, answers a profile with no `roles` property.
9. [integration] `POST /agents`, sent by a global admin, answers an `agent` object with no `roles` property.
10. [integration] `POST /projects/:slug/members` with `{ email, roleKey: 'developer' }` answers a member with no `role` property.

### US-007

1. [integration] `GET /projects/:slug/invites`, sent by a Project Admin of P with one pending `developer` invite, answers an invite with no `role` property.
2. [integration] In that answer, the invite has `roleKey: 'developer'` and `roleName: 'Developer'`.
3. [integration] `POST /projects/:slug/invites` with `{ email, roleKey: 'viewer' }` for an existing user answers `outcome: 'ADDED'` with a `member` that has no `role` property.
4. [integration] `GET /invites/:token` for a pending `developer` invite answers a preview with no `role` property.
5. [integration] In that preview, `roleKey` is `'developer'` and `roleName` is `'Developer'`.
6. [integration] `GET /admin/users`, sent by a global admin, answers records none of which has a `role` property.
7. [integration] `POST /admin/users`, sent by a global admin, answers a user with no `role` property.
8. [integration] `GET /auth/me`, sent by a user with a global `admin` binding, still answers `role: 'ADMIN'`.
9. [integration] The OpenAPI document built from the booted app has no `/agents/{slug}/update-roles` path.
10. [integration] In that document, `/projects/{slug}/members/{userId}` has no `patch` and no `delete` operation, and `/projects/{slug}/agents` has no `post` operation.
11. [integration] In that document, none of the `ProjectMemberDto`, `InviteDto`, `InvitePreviewDto` and `UserAdminDto` schemas has a `role` property.

### US-008

1. [unit] `koda role-binding list --project koda`, with `projectsControllerFindBySlug` answering a project with id `p1`, calls `roleBindingsControllerList` with a `query` whose `projectId` is `'p1'`.
2. [unit] `koda role-binding list --global` calls `roleBindingsControllerList` with a `query` whose `scope` is `'global'`.
3. [unit] `koda role-binding list --type AGENT --principal a1 --page 2 --size 50` calls `roleBindingsControllerList` with a `query` equal to `{ principalType: 'AGENT', principalId: 'a1', current: 2, size: 50 }`.
4. [unit] `koda role-binding list` prints a table with the header `['ID', 'Type', 'Principal', 'Role', 'Project', 'Granted']`.
5. [unit] `koda role-binding list` prints `'global'` in the Project cell of a binding whose `projectId` is null.
6. [unit] `koda role-binding grant --role developer --user u1 --project koda`, with the project lookup answering id `p1`, calls `roleBindingsControllerCreate` with `body: { principalType: 'USER', principalId: 'u1', roleKey: 'developer', projectId: 'p1' }`.
7. [unit] `koda role-binding grant --role reviewer --agent bot-1 --project koda`, with `agentsControllerFindBySlug` answering id `a1` and the project lookup id `p1`, calls `roleBindingsControllerCreate` with `body: { principalType: 'AGENT', principalId: 'a1', roleKey: 'reviewer', projectId: 'p1' }`.
8. [unit] `koda role-binding grant --role admin --user u1` (no `--project`), with a local project config that names a project, calls `roleBindingsControllerCreate` with `projectId: null`.
9. [unit] `koda role-binding grant --role admin --user u1` prints `Granted admin to u1 (binding <id>)` with the id `roleBindingsControllerCreate` answered.
10. [unit] `koda role-binding grant --role developer --user u1 --agent bot-1` exits with code 3 and calls no API function.
11. [unit] `koda role-binding grant --role developer` (neither principal flag) exits with code 3 and calls no API function.
12. [unit] `koda role-binding grant --role developer --agent nope`, with `agentsControllerFindBySlug` rejecting with a 404 error, does not call `roleBindingsControllerCreate`.
13. [unit] `koda role-binding revoke b1` calls `roleBindingsControllerRemove` with `{ path: { id: 'b1' } }`.
14. [unit] `koda role-binding grant --role admin --user u1 --json` prints the `RoleBindingDto` that `roleBindingsControllerCreate` answered, as JSON.
15. [unit] `roleBindingCommand(program)` on a new `Command` registers a `role-binding` command whose subcommands are `list`, `grant` and `revoke`.

### US-009

1. [unit] `koda member add --email dev@x.io --role developer` calls `projectMembersControllerAdd` with `body: { email: 'dev@x.io', roleKey: 'developer' }`.
2. [unit] `koda member add`, with the add answering a member whose bindings are `[{ id: 'b1', roleKey: 'developer', roleName: 'Developer' }]`, prints `Added dev@x.io as Developer`.
3. [unit] `koda member invite --email new@x.io --role triager` calls `projectInvitesControllerCreate` with `body: { email: 'new@x.io', roleKey: 'triager' }`.
4. [unit] `koda member invite`, with the create answering `outcome: 'ADDED'` and a member whose one binding has the role name `Viewer`, prints `Added <email> as Viewer`.
5. [unit] `koda member list --all` calls `projectMembersControllerList` with a `query` whose `principals` is `'all'`.
6. [unit] `koda member list` prints a table with the header `['Type', 'ID', 'Email/Slug', 'Name', 'Roles']`.
7. [unit] `koda member list --all` prints an agent row whose Email/Slug cell is its `agentSlug`.
8. [unit] `koda member list` prints `developer (b1), viewer (b2)` in the Roles cell of a record with those two bindings.
9. [unit] `koda member invites` prints the `Role` cell of an invite as its `roleName`.
10. [unit] `koda member remove u2`, with the first members page lacking `u2` and `hasNext: true` and the second page holding `u2` with bindings `b1` and `b2`, calls `roleBindingsControllerRemove` with `b1` and then `b2`.
11. [unit] `koda member remove u9`, with a single members page that lacks `u9`, exits with code 1 and calls no `roleBindingsControllerRemove`.
12. [unit] `koda member remove u2`, with `roleBindingsControllerRemove` rejecting for `b1` with a 409 error, does not call it for `b2`.
13. [unit] `memberCommand(program)` on a new `Command` registers no `role` subcommand under `member`.

### US-010

1. [unit] `koda project agents`, with the roster answering `{ items: [] }`, prints no `Agent scoping is off` message.
2. [unit] `koda user create --email e@x.io --name E --password StrongPass123!` calls `adminUsersControllerCreate` with a body that has no `role` property.
3. [unit] `koda user list` prints a table whose header is `['ID', 'Email', 'Name', 'Disabled']`.
4. [unit] `koda agent create --name Bot` calls `agentsControllerGenerateApiKey` with a body that has no `roles` property.
5. [unit] `projectCommand(program)` on a new `Command` registers no `agent-add` subcommand under `project`.
6. [unit] `projectCommand(program)` on a new `Command` registers no `agent-remove` subcommand under `project`.

### US-011

1. [unit] `useProjectAgents('p').load()`, with `$api.get` answering `{ items: [<one agent>] }`, sets `items` to that one agent.
2. [unit] The return value of `useProjectAgents('p')` has no `scoping` property.
3. [unit] The project agents page, mounted with one roster agent, renders no element with `data-testid="project-agents-scoping-off"`.
4. [unit] The project agents page's table header cells are name, slug, capabilities, status and open tickets, plus actions when `agent.update` is held.
5. [unit] The global agents page, with `GET /agents` answering an agent that has no `roles` property and `GET /role-bindings` answering one `developer` binding for it, renders that agent's `Developer` chip.
6. [unit] `ProjectMembersPanel`, given a member row whose bindings are `[{ id: 'b1', … }, { id: 'b2', … }]`, calls `useRoleBindings().remove` with `b1` and then `b2` when the row is removed and confirmed.
7. [unit] `useApprovalNotifications`, after a refresh started for user `u1`, keeps the refresh's result when `auth.user` changes only its `role` value while the id stays `u1`.
8. [unit] `useApprovalNotifications` discards a running refresh's result when `auth.user`'s id changes from `u1` to `u2`.
9. [unit] The invite page, given a preview with `roleName: 'Developer'` and no `role` property, renders `data-testid="invite-role-name"` with the role name.
