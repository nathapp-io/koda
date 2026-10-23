# SPEC: Permissions P1k — Drop the Legacy Reads

## Summary

This feature makes every authorization and membership read in `apps/api` answer from `RoleBinding` rows alone. The legacy `ProjectMember`, `AgentProject`, `AgentRoleEntry` rows and `User.role` stop granting or describing anything:
- **`PermissionService` reads bindings only.** The legacy union (`findLegacyRoleKeys`), the baseline fallback (a principal with no global binding was given `member` / `agent`) and `isLegacyAdmin` are removed. `MembershipService.isGlobalAdmin` and the admin-users last-admin guard decide from global `owner` / `admin` bindings.
- **The membership queries read bindings only.** `apps/api/src/permissions/legacy-membership.queries.ts` becomes `apps/api/src/permissions/membership.queries.ts`, with the same exported functions minus `legacyRoleKeys`. Its twelve importers (members, roster, invites, projects, home, tickets, agents, email, notifications, mentions, assignees, the binding repository) keep their call shapes. `project-member.queries.ts` drops its legacy chips and dates.
- **`AGENT_PROJECT_SCOPING` is removed.** Agent project access is always decided by `project.read`. The env flag, `IAuthConfig.agentProjectScoping` and both `agentScopingEnabled()` methods go; the roster response keeps `scoping: true`.
- **Agent principals carry no legacy roles.** `AgentPrincipal.agentRoles`, `AgentAuthProvider.loadAgentRoles` and `PrismaAuthRepository.findAgentRoles` are removed.
- **Recipients and assignees are `project.read` holders.** Notification eligibility, mention resolution and the assignee search offer exactly the principals that hold `project.read` in the project. The global-admin notification list reads global `owner` / `admin` bindings. A new `PermissionService.principalIdsWithKey` answers the assignee search.
- **The compat-layer specs are deleted** with the code they test.

This is the eleventh feature implementing phase P1 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md`. The order is: roles (PR #308), membership (#310), enforce-core (#313), enforce-fleet (#314), enforce-assistant (#315), enforce-integrations (#316), contract-tests (#317), retire-checks (#318), fixtures-to-bindings (#319), web (#320), then drop-legacy, split 2026-10-22 into three features: **drop-legacy-reads**, drop-legacy-routes and drop-legacy-schema.

## Motivation

Since fixtures-to-bindings, every test fixture writes bindings, and since web, no client needs a legacy row to show or change a role. The union still runs on every permission check:
- **A stale legacy row still grants.** A `ProjectMember` row, an `AgentProject` roster row or an `AgentRoleEntry` row adds the keys of the role it maps to, and `User.role = 'ADMIN'` adds every project key everywhere. Removing a binding does not remove access a legacy row still gives.
- **A principal with no binding still holds the baseline.** `PermissionService` adds `member` / `agent` to a principal with no GLOBAL-role binding, so deleting a principal's baseline binding changes nothing.
- **`AGENT_PROJECT_SCOPING=off`** lets every agent into every project without any key, bypassing `project.read`.
- **Recipients and assignees use a second definition of access.** Notifications and mentions admit a user with `User.role = 'ADMIN'` or an access source; the assignee search offers access sources. A custom project role without `project.read` is offered; a holder of a custom GLOBAL role with `project.read` is not.

The schema feature cannot drop the legacy tables while anything reads them. This feature removes the reads; drop-legacy-routes removes the legacy write routes and fields; drop-legacy-schema removes the remaining writes and the tables.

**Rulings that bind this feature** (user, 2026-10-22):
- **drop-legacy is three features**, in order: drop-legacy-reads (this one), drop-legacy-routes (legacy write routes, DTO `role` fields, CLI on role keys), drop-legacy-schema (remaining legacy writes, the tables and columns).
- **No data migration** (design decision 2). koda-wk is reset and re-seeded after P1. A legacy row that exists without a binding loses its effect here.
- **Assignee search and recipient selection move onto `project.read`** (deferred to drop-legacy by retire-checks).

## Design

### Rulings that bind every story

1. **Conventions carry over** from `.nax/features/permissions-p1-retire-checks/spec.md` ("Rulings that bind every story"):
   - `PermissionsModule` is `@Global()`; consumers inject `PermissionService` without `@Optional()`;
   - DB-backed tests that need the system roles run `SystemRoleSeeder.onApplicationBootstrap()` after `resetDb`, or boot the app;
   - a DB-backed test that writes binding rows directly between two requests calls `MembershipService.invalidatePermissions()` after the write.
2. **Behaviour with production-written data is unchanged.** Every API path that creates a principal writes its baseline binding (`AuthService.register`, `UsersAdminService.create`, `AgentsService.create`, `InviteAcceptanceService`), and every membership route writes bindings (membership, PR #310). The one script that does not, the production seed `apps/api/prisma/seed.ts` (`bun run seed:prod`, run by koda-wk's setup script), writes a `User { role: 'ADMIN' }` row with no binding; US-003 makes it write bindings. What changes is only for rows no production path writes alone any more:
   - a legacy `ProjectMember`, `AgentProject` or `AgentRoleEntry` row grants nothing and makes nobody a member, roster entry, recipient or assignee;
   - a user whose `User.role` is `'ADMIN'` without a global `owner` / `admin` binding is not a global admin;
   - a principal without a GLOBAL-role binding holds no global key (it had `member` / `agent`);
   - an agent with no binding in a project has no access to it, whatever the env says.
3. **Two legacy write paths keep running and stop granting.** `POST /agents` `roles` and `PATCH /agents/:slug/update-roles` still write `AgentRoleEntry` rows, and `AgentResponseDto.roles` still lists them, but they grant no key from this feature on. drop-legacy-routes deletes both.
4. **`User.role` keeps being written and displayed.** `MembershipService` keeps mirroring global `owner` / `admin` bindings into `User.role` (with the `tokenVersion` bump), the JWT `role` claim and `UserResponseDto.role` keep reading it, and the first user keeps `role: 'ADMIN'`. No decision reads it after this feature. drop-legacy-schema derives the claim from bindings and drops the column.
5. **The display role strings stay.** `ProjectMembership.role`, `viewerRole` and the member records keep answering `ADMIN` / `DEVELOPER` / `VIEWER` through `legacyRoleForRoleKey` (`legacy-project-roles.ts`, unchanged). drop-legacy-routes removes them from the responses.
6. **No route, DTO or OpenAPI change.** `ProjectAgentListDto.scoping` stays and is always `true`; drop-legacy-routes removes it with the CLI and web readers.
7. **No approval and no audit change** (P3 and P2).

### `PermissionService` on bindings only (US-001)

`apps/api/src/permissions/permission.service.ts`, target:

```ts
constructor(
  @Inject(ROLE_REPOSITORY) private readonly roles: PrismaRoleRepository,
  @Inject(ROLE_BINDING_REPOSITORY) private readonly bindings: PrismaRoleBindingRepository,
  private readonly cache: PermissionCache,
) {}

private async computeKeys(principal: PrincipalRef, projectId: string | null): Promise<Set<string>> {
  const rows = await this.bindings.findEffectiveBindings(principal, projectId);
  const keys = new Set<string>();
  let globalAdmin = false;
  for (const row of rows) {
    if (!appliesIn(row, projectId)) continue;
    this.addEntries(keys, row.roleKey, row.roleScope, row.rolePermissions);
    if (isGlobalAdminBinding(row)) globalAdmin = true;
  }
  // A global Owner or Admin can do everything inside any project.
  if (globalAdmin) for (const key of expandEntries(['*'], 'PROJECT')) keys.add(key);
  return keys;
}
```

- Removed: the `AUTH_CFG` constructor parameter, `BASELINE_ROLE_KEYS`, `addRoleKeys`, `isLegacyAdmin`, and the `findLegacyRoleKeys` call. `can`, `effectiveKeys`, `projectIdsWithKey`, `appliesIn` and the cache are unchanged.
- The class doc says effective keys are the principal's bindings alone.
- `PrismaRoleBindingRepository.findLegacyRoleKeys` is deleted. `findAccessibleProjectIds` keeps delegating to `accessibleProjectIds` (now from `membership.queries.ts`, US-002).
- `MembershipService.isGlobalAdmin(userId)` answers `(await this.bindings.countGlobalAdminBindings(userId)) > 0`. `findUserState` stays (its `disabled` field is read by `setGlobalAdmin`).
- Doc comments that describe `User.role = 'ADMIN'` as granting keys are reworded: `role-admin.service.ts` (around lines 366 and 423) and the `isGlobalAdmin` doc in `membership.service.ts`.
- **Admin-users last-admin guard** (`apps/api/src/users/users-admin.service.ts`, `update`): the target counts as an active admin when it is not disabled and `MembershipService.isGlobalAdmin(target.id)`; `PrismaUsersRepository.countActiveAdmins()` counts the distinct non-disabled users with a `projectId`-null `owner` or `admin` binding (the binding read takes `take: MEMBERSHIP_READ_CAP`, `.nax/rules/api-data.md`). The 409 it answers and when it asks are unchanged.

### Bindings-only membership queries (US-002)

`apps/api/src/permissions/legacy-membership.queries.ts` is renamed `apps/api/src/permissions/membership.queries.ts` (and its spec `membership.queries.spec.ts`). Every legacy source is removed:
- **Sources** are now: a **project binding** of the principal in `P` (a `RoleBinding` with `projectId = P` whose role has scope `PROJECT`), and a **global project binding** (the same with `projectId` null, counted only in a live project). Local sources = project bindings; access sources = project bindings plus global project bindings. A GLOBAL-scope role's binding is still never a source.
- **Exports kept, with the same signatures:** `MEMBERSHIP_READ_CAP`, `userProjectRole`, `localProjectRole`, `agentHasProjectAccess`, `accessibleProjectIds`, `readAccessibleProjectIds`, `principalIdsWithAccess`, `listProjectMemberships`, `countActiveProjectAdmins`, and the `ProjectMembership` type re-export.
- **Removed:** `legacyRoleKeys` and its helpers (`userLegacyRoleKeys`, `agentLegacyRoleKeys`, `agentOnRoster`, `agentRoleEntryKeys`, `ROLE_KEY_BY_LEGACY_ROLE`, `ROLE_KEY_BY_AGENT_ROLE`), the legacy halves `legacyRowRole`, `legacyProjectIds`, `legacyPrincipalIds`, `legacyMembershipSources`, and `AGENT_ROSTER_ROLE` with the `ActorRole` import once nothing reads them. `principalIdsWithAccess` stays exported after US-004 and US-005 although no production code calls it then; its specs keep pinning it for drop-legacy-schema.
- **`ProjectMembership`** (`permissions.types.ts`): `since` is the earliest `createdAt` of the principal's project bindings in `P`; `addedByUserId` is that binding's `grantedById` when `grantedByType` is `'USER'`, else `null`. The doc comments stop naming legacy rows.
- **`countActiveProjectAdmins`** counts the distinct non-disabled users with a `project-admin` binding in the project.
- **`apps/api/src/projects/members/project-member.queries.ts`**: `readMemberBindings` returns only binding chips (no null-`id` legacy chip), and `readMemberRecord`'s `since` is the earliest project binding `createdAt`. The header comment stops describing the union, and helpers that only served the legacy chips are removed. The import moves to `membership.queries.ts`. `MemberBinding.id` keeps its type.
- **Importers** switch the module path and keep their calls: `email/email-content.builder.ts`, `home/prisma-home.repository.ts`, `notifications/ticket-mention.resolver.ts` (until US-005), `notifications/notification-eligibility.ts` (until US-005), `permissions/prisma-role-binding.repository.ts`, `agents/prisma-agent.repository.ts`, `projects/invites/prisma-project-invites-members.repository.ts`, `projects/members/prisma-project-members.repository.ts`, `projects/assignees/prisma-project-assignees.repository.ts` (until US-004), `projects/members/project-member.queries.ts`, `projects/prisma-project.repository.ts`, `tickets/prisma-tickets.repository.ts`. Doc comments in them that describe the legacy union are reworded.

### No agent scoping switch, no agent roles on the principal (US-003)

| Site | Baseline (locate only) | Target |
|:--|:--|:--|
| `config/env.validation.ts` | `AGENT_PROJECT_SCOPING: Joi.string().valid('on', 'off').default('on')` | key removed; the schema keeps `.unknown(true)`, so a deployment that still sets it starts and ignores it |
| `config/auth.config.ts` | `agentProjectScoping?` in `IAuthConfig`, `AGENT_PROJECT_SCOPING_VALUES`, `IsOnOrOff`, `AuthConfigSchema.AGENT_PROJECT_SCOPING`, the factory field | all removed |
| `ProjectAccessService` | `(projectRepo, permissions, @Optional() @Inject(AUTH_CFG) authConfig?)`; `agentScopingEnabled()`; `resolveMembership` returns `null` for an agent when scoping is off | `(projectRepo, permissions)`; `agentScopingEnabled` deleted; every agent is decided by `can(principal, 'project.read', { projectId })` |
| `ProjectsService.findAllForPrincipal` | agent: `agentScopingEnabled() ? findAllForAgent(id) : findAll()` | agent: `findAllForAgent(id)`; the `readsEveryProject` branch first is unchanged |
| `AgentsService` | `agentScopingEnabled()`; `ProjectAgentListDto.from(records, this.agentScopingEnabled())` | method deleted; `ProjectAgentListDto.from(records, true)`. `AUTH_CFG` stays injected (`create` reads `apiKeySecret`), so the constructor is unchanged |
| `AgentPrincipal` (`auth/principal/koda-principal.types.ts`) | `agentRoles: readonly KodaAgentRole[]` | field removed; `KodaAgentRole` is deleted if nothing else imports it |
| `AgentAuthProvider.buildPrincipal` | loads `agentRoles`; `authorities: agentRoles` | loads only capabilities; `authorities: []`; `loadAgentRoles` deleted |
| `PrismaAuthRepository.findAgentRoles` | reads `AgentRoleEntry` | deleted |
| `AssistantToolExecutor` `agentPrincipal()` | `agentRoles: []` | field removed |
| comments naming the flag or the union | `tickets/tickets.service.ts` (`AGENT_PROJECT_SCOPING modes (D528)`), `permission.service.ts` (`projectIdsWithKey` doc), `agents.service.ts` (`suggestTicket` doc; the `updateRoles` comment that calls `AgentRoleEntry` a row the permission union reads), `project-access.service.ts` (the `resolveMembership` doc) | reworded |

### The production seed writes bindings (US-003)

`apps/api/prisma/seed.ts` keeps its env inputs (`KODA_ADMIN_EMAIL`, `KODA_ADMIN_PASSWORD`, `KODA_ADMIN_NAME`), its messages and the evaluation project, and moves the admin-user body into a new import-safe module, as `prisma/seed-e2e.ts` does with `prisma/seed-e2e-data.ts`:

```ts
// apps/api/prisma/seed-admin-data.ts
export type SeedAdminOutcome = { created: true; userId: string; roleKey: 'owner' | 'admin' } | { created: false };

/**
 * Creates the admin user when no user has `email`, with the global `member` baseline and a global
 * `owner` binding when no `owner` binding exists yet, else a global `admin` binding. An existing email
 * answers `{ created: false }` and writes nothing. The system roles are seeded first when missing.
 */
export async function seedAdminUser(db: PrismaClient, input: { email: string; name: string; password: string }): Promise<SeedAdminOutcome>
```

- It writes the bindings with `grantBaseline` and `grantRole` from `src/permissions/test-helpers/permission-fixtures.ts` (the helpers `seed-e2e-data.ts` already uses; `grantRole` seeds the system roles when a role row is missing and mirrors `User.role = 'ADMIN'` for `owner` / `admin`).
- The user row is created without a `role` field; the mirror sets it.
- Designer call: a seed run into an installation that already has an Owner binds `admin`, never a second Owner.

### Recipients and assignees by key (US-004, US-005)

`PermissionService` gains:

```ts
/**
 * The ids of the principals of `type` that hold `key` in the project, ascending and distinct.
 * Candidates are the principals with a binding that can apply there: a PROJECT-role binding in the
 * project or in every project, or a projectId-null binding of `owner`, `admin` or a GLOBAL role whose
 * entries expand to `key`. Each candidate is kept when `effectiveKeys(ref, { projectId })` has `key`.
 */
async principalIdsWithKey(type: PrincipalType, projectId: string, key: string): Promise<string[]>
```

- `PrismaRoleBindingRepository.findCandidatePrincipalIds(type, projectId, globalRoleIds)` returns the distinct `principalId`s of `type` whose binding has `projectId = P` (PROJECT role), `projectId` null with a PROJECT role, or `projectId` null with a role id in `globalRoleIds`, ascending, at most `MEMBERSHIP_READ_CAP` (a full read logs the cap warning, as the membership queries do).
- `globalRoleIds` are the GLOBAL roles (for example as read by `PrismaRoleRepository.findRolesByScope('GLOBAL')`) whose key is `owner` or `admin`, or whose `expandEntries(permissions, 'GLOBAL')` contains `key`. A role whose entries do not expand counts as not holding `key`.

Readers (`ProjectAssigneesService` in US-004; `NotificationEligibility` and `TicketMentionResolver` in US-005):

| Site | Baseline (locate only) | Target |
|:--|:--|:--|
| `NotificationEligibility.filter` | enabled users; a project draft passes for `role === 'ADMIN'` or `principalIdsWithAccess(projectId, 'USER')` | enabled users; a project draft passes when `(await this.permissions.effectiveKeys({ type: 'USER', id }, { projectId })).has('project.read')`, asked once per distinct (user, project); a draft with no project passes for any enabled user, as today |
| `NotificationEligibility.findGlobalAdminIds` | enabled users with `role: 'ADMIN'`, by `createdAt` ascending | the distinct enabled users with a `projectId`-null `owner` or `admin` binding (binding read capped at `MEMBERSHIP_READ_CAP`), by user `createdAt` ascending |
| `TicketMentionResolver.mentionedUserIds` | enabled mentioned users with `role === 'ADMIN'` or an access source | enabled mentioned users holding `project.read` in the project (`effectiveKeys`), in text order |
| `ProjectAssigneesService.search` → `PrismaProjectAssigneesRepository.search` | the repository reads `principalIdsWithAccess` for users and agents | the service asks `principalIdsWithKey('USER', projectId, 'project.read')` and `('AGENT', …)` and passes both id lists; the repository signature becomes `search(projectId, q, limit, ids: { userIds: string[]; agentIds: string[] })` and keeps its filters, order and limit |

- `NotificationEligibility` and `TicketMentionResolver` take `PermissionService` as their second constructor parameter, after `PrismaService`.
- `ProjectAssigneesService` takes `PermissionService` after its existing parameters.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| A principal has no binding at all (no baseline) | `effectiveKeys` answers the empty set, so the principal holds no role key (US-001) |
| A legacy `ProjectMember` / `AgentProject` / `AgentRoleEntry` row exists with no binding | it grants nothing, and the principal is not listed as a member, roster entry, recipient or assignee (US-001, US-002, US-004) |
| `AGENT_PROJECT_SCOPING=off` is still set in the environment | startup succeeds and the value is ignored; agents are decided by `project.read` (US-003) |
| A GLOBAL role row's entries do not expand (hand-edited) | `principalIdsWithKey` treats it as not holding the key; `computeKeys` keeps logging and granting nothing for it, as today (US-004) |
| A database read fails inside `principalIdsWithKey` | the error propagates unchanged; no partial list is answered (US-004). The membership queries' error handling is unchanged by US-002 |
| `effectiveKeys` rejects inside `NotificationEligibility.filter` or `TicketMentionResolver.mentionedUserIds` (database error) | the error propagates unchanged; no draft or mention is kept or dropped on a guess (US-005) |
| `findCandidatePrincipalIds`, `countActiveAdmins` or `findGlobalAdminIds` reads its `MEMBERSHIP_READ_CAP` | it answers from the first `MEMBERSHIP_READ_CAP` rows and logs the cap warning (US-001, US-004, US-005) |
| `seedAdminUser` runs for an email that already exists | it writes nothing and answers `{ created: false }` (US-003) |

### Integration

Symbols this feature **reads** (verified at `3d6f2bb3`):
- `PermissionService.can(principal, key, ctx?)`, `effectiveKeys(ref, scope)`, `projectIdsWithKey(principal, key)` — `apps/api/src/permissions/permission.service.ts`
- `expandEntries(entries, scope)` — `apps/api/src/permissions/entry-matcher.ts`
- `PrismaRoleRepository.findRolesByScope(scope)` — `apps/api/src/permissions/prisma-role.repository.ts`
- `PrismaRoleBindingRepository.findEffectiveBindings`, `countGlobalAdminBindings`, `findUserState` — `apps/api/src/permissions/prisma-role-binding.repository.ts`
- `legacyRoleForRoleKey`, `strongestProjectRole`, `ROLE_KEY_FOR_LEGACY_ROLE` — `apps/api/src/permissions/legacy-project-roles.ts`
- `MembershipService.bindBaseline`, `setGlobalAdmin`, `invalidatePermissions` — `apps/api/src/permissions/membership.service.ts`
- `SystemRoleSeeder` — `apps/api/src/permissions/system-role.seeder.ts`
- `grantRole`, `grantBaseline`, `expectBindingOnlyFixtures` — `apps/api/src/permissions/test-helpers/permission-fixtures.ts`

Symbols this feature **changes**. The baseline only locates the code; implement the target.

| Symbol | Baseline (locate only) | Target |
|:--|:--|:--|
| `PermissionService` constructor, `computeKeys` | 4 parameters incl. `AUTH_CFG`; union + baseline + legacy admin | 3 parameters; the US-001 code above |
| `PermissionService.principalIdsWithKey` | absent | the US-004 method above |
| `PrismaRoleBindingRepository.findLegacyRoleKeys` / `findCandidatePrincipalIds` | present / absent | deleted / added (US-004) |
| `MembershipService.isGlobalAdmin` | `User.role === 'ADMIN'` or a global admin binding | a global `owner` / `admin` binding |
| `PrismaUsersRepository.countActiveAdmins`, `UsersAdminService.update` admin test | `User.role = 'ADMIN'` | global `owner` / `admin` bindings |
| `legacy-membership.queries.ts` | legacy rows unioned with bindings | renamed `membership.queries.ts`, bindings only |
| `project-member.queries.ts` | legacy chips and dates | bindings only |
| `ProjectAccessService`, `ProjectsService.findAllForPrincipal`, `AgentsService`, `IAuthConfig`, env schema | `AGENT_PROJECT_SCOPING` | the US-003 table |
| `AgentPrincipal`, `AgentAuthProvider`, `PrismaAuthRepository.findAgentRoles` | `agentRoles` | the US-003 table |
| `ProjectAssigneesService`, `PrismaProjectAssigneesRepository.search` | access sources | the US-004 / US-005 table (US-004) |
| `NotificationEligibility`, `TicketMentionResolver` | `User.role` and access sources | the US-004 / US-005 table (US-005) |

## Out of Scope

- Deleting `PATCH /agents/:slug/update-roles`, `PATCH` / `DELETE /projects/:slug/members/:userId`, `POST` / `DELETE /projects/:slug/agents`, the `role` fields of `AddMemberDto` / `CreateInviteDto` / `CreateUserDto` / `UpdateUserDto`, `AgentResponseDto.roles`, `CreateAgentDto.roles`, `canManage` / `viewerRole` and `ProjectAgentListDto.scoping`, and moving the CLI to role keys, is out of scope (`permissions-p1-drop-legacy-routes`).
- Stopping the remaining legacy writes (`AgentRoleEntry` rows from `POST /agents` and `update-roles`, the `User.role` mirror in `MembershipService`, `role: 'ADMIN'` for the first user, `role: 'MEMBER'` for invited users, `ProjectMember` deletes on member removal, `AgentProject` deletes on roster removal) and dropping `ProjectMember`, `AgentProject`, `AgentRoleEntry`, `User.role` and `ProjectInvite.role` are out of scope (`permissions-p1-drop-legacy-schema`).
- Deriving the JWT `role` claim, `UserResponseDto.role` and the admin user list's `role` from bindings is out of scope (`permissions-p1-drop-legacy-schema`); `User.role` stays mirrored from the global `owner` / `admin` bindings until then.
- Changing the display role strings (`ADMIN` / `DEVELOPER` / `VIEWER`) of `ProjectMembership.role`, the member records and `viewerRole`, and deleting `legacy-project-roles.ts`, is out of scope (`permissions-p1-drop-legacy-routes`).
- `PrismaProjectAssigneesRepository` extending `AbstractPrismaRepository` over the `ProjectMember` model, and the fixture sentinel `fixtureGrantReport` reading the legacy tables, stay; they change with the tables (`permissions-p1-drop-legacy-schema`).
- Changing which principals the project and home lists show beyond dropping the legacy sources (they keep reading access sources, not `project.read`) is out of scope.
- Exercising `findCandidatePrincipalIds`, `countActiveAdmins` and `findGlobalAdminIds` at their `MEMBERSHIP_READ_CAP` of 5,000 rows is out of scope for tests in every story; the cap warning follows the membership queries' existing pattern.
- Agent-assignee eligibility in `TicketsService.assign` keeps `isAgentOnProjectRoster` (now bindings-only through `agentHasProjectAccess`) and is out of scope: it runs under the `lockProjectAgents` roster lock, which serializes it against a concurrent roster removal, and a cached `project.read` read would not. Only the assignee search moves to `project.read`, so an agent with a custom GLOBAL role holding `project.read` is offered but answers 409 `tickets.agentNotInProject` on assign until a later feature aligns them.
- Checking that the project is live in `effectiveKeys` is out of scope: a global project binding or a global admin holds `project.read` in a soft-deleted project id, so a draft or mention for a soft-deleted project is decided by keys like any other (producers already end quietly when the source is gone, and project routes answer 404 before any key).
- Re-seeding or resetting koda-wk is out of scope for the run; it is a manual step after P1 (design decision 2).
- Approval policies, the audit log and `ActionContext` are out of scope (P3, P2).

## Stories

1. **US-001: `PermissionService` reads bindings only** — `Workdir: apps/api` — No dependencies. `computeKeys` drops the legacy union, the baseline fallback and the legacy admin; the constructor drops `AUTH_CFG`; `findLegacyRoleKeys` is deleted. `MembershipService.isGlobalAdmin`, `UsersAdminService.update`'s last-admin guard and `PrismaUsersRepository.countActiveAdmins` read global `owner` / `admin` bindings. The compat specs of the union are deleted.
2. **US-002: Bindings-only membership queries** — `Workdir: apps/api` — Depends on US-001. `legacy-membership.queries.ts` is renamed `membership.queries.ts` and loses every legacy source; `project-member.queries.ts` loses its legacy chips and dates; the twelve importers move to the new path.
3. **US-003: No agent scoping switch, no agent roles on the principal, a seed that binds** — `Workdir: apps/api` — Depends on US-001. `AGENT_PROJECT_SCOPING`, `IAuthConfig.agentProjectScoping`, both `agentScopingEnabled()` methods, `AgentPrincipal.agentRoles`, `AgentAuthProvider.loadAgentRoles` and `PrismaAuthRepository.findAgentRoles` are removed, per the US-003 table; the production seed writes bindings through `seedAdminUser`. Verification for the removals: `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint`.
4. **US-004: Assignees are `project.read` holders** — `Workdir: apps/api` — Depends on US-001, US-002. Adds `PermissionService.principalIdsWithKey` and `PrismaRoleBindingRepository.findCandidatePrincipalIds`; the assignee search offers exactly their answer, per the US-004 / US-005 table.
5. **US-005: Notification and mention recipients are `project.read` holders** — `Workdir: apps/api` — Depends on US-001, US-002. `NotificationEligibility.filter` and `TicketMentionResolver.mentionedUserIds` decide by `effectiveKeys` having `project.read`; `findGlobalAdminIds` reads global `owner` / `admin` bindings.

One capability: removing the legacy reads.

### Context Files

**US-001**
- `apps/api/src/permissions/permission.service.ts` — `computeKeys`, edited here
- `apps/api/src/permissions/prisma-role-binding.repository.ts` — `findLegacyRoleKeys`, deleted here
- `apps/api/src/permissions/membership.service.ts` — `isGlobalAdmin`, edited here
- `apps/api/src/users/users-admin.service.ts` — `update`, edited here
- `apps/api/src/users/prisma-users.repository.ts` — `countActiveAdmins`, edited here

**US-002**
- `apps/api/src/permissions/legacy-membership.queries.ts` — renamed and reduced here
- `apps/api/src/projects/members/project-member.queries.ts` — legacy chips and dates, removed here
- `apps/api/src/permissions/permissions.types.ts` — `ProjectMembership` docs, edited here
- `apps/api/src/permissions/legacy-project-roles.ts` — `legacyRoleForRoleKey`, read
- `apps/api/src/projects/members/prisma-project-members.repository.ts` — an importer, edited here

The other importers listed in the US-002 Design section are edited the same way.

**US-003**
- `apps/api/src/config/auth.config.ts` — the flag, removed here
- `apps/api/src/config/env.validation.ts` — the flag, removed here
- `apps/api/src/projects/project-access.service.ts` — `agentScopingEnabled`, removed here
- `apps/api/src/agents/agents.service.ts` — `agentScopingEnabled`, removed here
- `apps/api/src/auth/agent-auth.provider.ts` — `loadAgentRoles`, removed here

Also edited: `apps/api/prisma/seed.ts` (calls `seedAdminUser`), `apps/api/src/projects/projects.service.ts`, `apps/api/src/auth/principal/koda-principal.types.ts`, `apps/api/src/auth/prisma-auth.repository.ts`, `apps/api/src/fleet/assistant/assistant-tool.executor.ts`, `apps/api/src/tickets/tickets.service.ts` (comment).

**US-004**
- `apps/api/src/permissions/permission.service.ts` — `principalIdsWithKey`, added here
- `apps/api/src/permissions/prisma-role-binding.repository.ts` — `findCandidatePrincipalIds`, added here
- `apps/api/src/permissions/entry-matcher.ts` — `expandEntries`, read
- `apps/api/src/projects/assignees/project-assignees.service.ts` — edited here
- `apps/api/src/projects/assignees/prisma-project-assignees.repository.ts` — `search`, edited here

Also edited: `apps/api/src/projects/assignees/domain/project-assignee.domain.ts` (the `search` signature).

**US-005**
- `apps/api/src/notifications/notification-eligibility.ts` — edited here
- `apps/api/src/notifications/ticket-mention.resolver.ts` — edited here
- `apps/api/src/permissions/permission.service.ts` — `effectiveKeys`, read
- `apps/api/src/notifications/fleet/fleet-approval-requested.subscriber.ts` — a `findGlobalAdminIds` caller, read
- `apps/api/src/notifications/notifications.module.ts` — the providers, read

### Creates

**US-001**
- `apps/api/test/integration/permissions/bindings-only-permissions.integration.spec.ts` — the US-001 integration ACs

**US-002**
- `apps/api/src/permissions/membership.queries.ts` — the renamed module (`legacy-membership.queries.ts` is deleted)
- `apps/api/src/permissions/membership.queries.spec.ts` — the renamed unit spec
- `apps/api/test/integration/permissions/membership-queries.integration.spec.ts` — the US-002 integration ACs

**US-003**
- `apps/api/test/integration/permissions/agent-scoping-removed.integration.spec.ts` — the US-003 integration ACs
- `apps/api/test/unit/config/agent-scoping-flag-ignored.spec.ts` — US-003 AC-1 and AC-2
- `apps/api/src/auth/agent-auth.provider.spec.ts` — US-003 AC-7
- `apps/api/prisma/seed-admin-data.ts` — `seedAdminUser`
- `apps/api/test/integration/seed/seed-admin.integration.spec.ts` — the seed ACs

**US-004**
- `apps/api/test/integration/permissions/project-read-assignees.integration.spec.ts` — the US-004 integration ACs

**US-005**
- `apps/api/test/integration/permissions/project-read-recipients.integration.spec.ts` — the US-005 integration ACs

### Modifies

**US-001**
- `apps/api/src/permissions/permission.service.spec.ts` — 'AC-7: legacy User.role ADMIN with no bindings grants user.create' (`store.addUser('legacy', 'ADMIN')`, expects `allowed: true`) and 'the global set of an owner or legacy admin also holds project keys' (loops over `['owner1', 'legacy']`; the legacy id has no binding) rely on `isLegacyAdmin`, and the constructor passes a fourth `AUTH_CONFIG` argument. The replacing invariant: the service is built with three arguments; a user with `User.role = 'ADMIN'` and no `owner` / `admin` binding is refused `user.create` with `not-granted` and holds no project key; only `owner1` keeps `ticket.delete` globally and `role.binding.manage` in `p1`; a principal with no binding has an empty `effectiveKeys` set.
- `apps/api/src/permissions/membership.service.spec.ts` — describe `isGlobalAdmin`, it 'is the union of an owner or admin binding and legacy User.role ADMIN' (`store.addUser('legacy', 'ADMIN')` expects `true`), and describe `removeProjectBindings`, it 'B2: a legacy-only removal leaves the next decision without access' (stubs `findLegacyRoleKeys`; its first `can` expects `allowed: true`). Three `PermissionService` constructions pass a fourth `{ agentProjectScoping: true }` argument. The replacing invariant: `isGlobalAdmin` is `false` for a `User.role = 'ADMIN'` user without a binding and `true` only for a global `owner` / `admin` binding (a `project-admin` binding stays `false`); the B2 case is deleted (AC-14 stays as the cache-invalidation proof); the constructions take three arguments.
- `apps/api/src/users/users-admin.service.spec.ts` — its `membership` double has no `isGlobalAdmin`, so every `update` case that reaches the last-admin guard throws: 'refuses to remove the last active admin, under the lock', 'disables an admin when another active admin remains', 'removes the admin binding through setGlobalAdmin on a demotion', 'returns the stored role after a requested demotion of an Owner', 'bumps tokenVersion on re-enable, not on a role change'. They make the target an admin with `user({ role: 'ADMIN' })`. The replacing invariant: the double gains `isGlobalAdmin: vi.fn()`; the target is an active admin when it is not disabled and `isGlobalAdmin(id)` resolves `true`, whatever its `role`; the 409 case still asserts `lockUserAdministration` before `countActiveAdmins` and no `setGlobalAdmin` / `updateUser`; 'does not count admins for a MEMBER target' becomes "does not count admins for a target whose isGlobalAdmin is false".
- `apps/api/src/permissions/test-helpers/in-memory-permissions.ts` — `bindingRepo()` defines a `findLegacyRoleKeys` stub that only serves the deleted method. The replacing invariant: the stub is removed; `findUserState` and `countGlobalAdminBindings` stay.
- `apps/api/test/integration/permissions/core-legacy-union.integration.spec.ts` — every case tests the union this story removes: legacy `ProjectMember` / `AgentProject` / `AgentRoleEntry` rows granting keys (AC-1 to AC-14, AC-18 to AC-22, AC-14 building `PermissionService` with `agentProjectScoping: false`) and the baseline keys of a principal with no binding (AC-15 to AC-17). The replacing invariant: the file is deleted; US-001's new integration spec pins that legacy rows and a missing baseline grant nothing.
- `apps/api/test/integration/permissions/permission-service.integration.spec.ts` — 'AC-7: legacy User.role ADMIN with no bindings grants user.create' (`newUser('ADMIN')` without a binding, expects `allowed: true`). The replacing invariant: that user is refused `user.create` with `not-granted`.
- `apps/api/test/integration/permissions/membership-service.integration.spec.ts` — 'the commit boundary of a nested write (B3)', it 'a nested demotion invalidates the permission cache only after the outer transaction commits', builds `newUser('ADMIN')` with no binding and expects `effectiveKeys(global)` to hold `user.create` before the commit; `PermissionService` is built with a fourth argument. The replacing invariant: the user is given a global `admin` binding first, so the key is held before the commit and disappears only after the outer transaction commits; the construction takes three arguments. The other `isGlobalAdmin` and `setGlobalAdmin` cases are unchanged.
- `apps/api/test/integration/permissions/bootstrap-baselines.integration.spec.ts` — 'AC-16: demoting the last active admin answers the existing last-admin error' and 'AC-17: the refused demotion leaves the target's admin binding in place' use `withOnlyActiveAdmin`, which makes the target the only admin by setting the other users' `User.role` to `MEMBER` while their `owner` / `admin` bindings stay; `activeAdminCount()` and its comment count `User.role`. The replacing invariant: AC-16 and AC-17 send their PATCH as an actor with no `owner` / `admin` binding that holds the global `member` baseline and a custom GLOBAL role whose permissions are `['user.update']` (root holds the `owner` binding, so root cannot stay the actor once it stops counting as an admin); `withOnlyActiveAdmin` removes every `projectId`-null `owner` / `admin` binding except the target's for the case and restores them after; `activeAdminCount()` counts those bindings; AC-16 still answers 409 `users.lastAdmin` and AC-17 still finds the binding. Every other case is unchanged.
- `apps/api/test/integration/permissions/core-members-invites.integration.spec.ts` — 'B2: removing a member whose only source is a legacy ProjectMember row ends its warmed project keys' creates a `ProjectMember` `DEVELOPER` row and expects `can(ticket.create)` to be allowed before the removal. The replacing invariant: the member gets a `developer` binding written directly, its keys are warmed, and `ProjectMembersService.remove` ends them at once. AC-13 is unchanged.
- `apps/api/test/integration/permissions/core-agent-routes.integration.spec.ts` — its fixture `createAgent(slug, { roster: 'p1', legacyRole: 'DEVELOPER' })` writes `AgentProject` and `AgentRoleEntry` rows, so 'AC-12 ... next POST .../tickets answers 201 after the role write', 'AC-15: an agent with a roster row and an AgentRoleEntry DEVELOPER gets 200 from its own pickup', 'AC-20: ... admin pickup answers 200 after the target gains a p1 roster row' and 'B2: a warmed-up rostered agent is refused its own pickup right after a legacy-only roster removal' (first pickup expects 200) are refused. The replacing invariant: in the fixture, `roster: 'p1'` becomes a `viewer` binding in `p1` (`grantRole`), and `legacyRole` adds a `developer` binding in `p1` only when `roster` is also set; an agent created with `legacyRole` alone gets no `p1` binding (its `AgentRoleEntry` row stays as inert data), so AC-16 and AC-19 keep their refusals. AC-20 writes the `viewer` and `developer` bindings in `p1` where it now writes the roster row. AC-15 and AC-20 get their 200 from those bindings; AC-12 asserts that the update-roles route grants no key (the next ticket create of that agent stays 403); B2 removes the agent through the roster route and its warmed pickup is refused right after. AC-11, AC-14, AC-16 and AC-19 are unchanged.
- `apps/api/test/integration/permissions/membership-agent-roster.integration.spec.ts` — 'US-003 AC-11: a rostered VERIFIER-only agent picks up ...' gives the agent only an `AgentProject` row and an `AgentRoleEntry` `VERIFIER` row and expects pickup 200 and a `TICKET_SUGGESTED` event. The replacing invariant: the agent holds a `viewer` and a `verifier` binding in the project, and the pickup and event are unchanged.
- `apps/api/test/integration/permissions/membership-project-access.integration.spec.ts` — 'AC-5: a legacy ProjectMember DEVELOPER row keeps its access' expects 200 for a user whose only source is a `ProjectMember` row (seeded around line 166). The replacing invariant: that user gets 403 `projects` (a legacy row grants nothing).

**US-002**
- `apps/api/src/permissions/legacy-membership.queries.spec.ts` — renamed to membership.queries.spec.ts in the same directory, importing the renamed module. Its legacy cases fail: 'AC-4: the strongest of a legacy row and a project binding wins'; `localProjectRole` 'reads the legacy row for a USER and the roster row for an AGENT' and 'takes the strongest of a legacy row and the project bindings'; the whole `legacyRoleKeys` describe; `accessibleProjectIds` 'AC-8: legacy roster row and project bindings'; `principalIdsWithAccess` 'AC-10' (expects `['bound', 'global', 'legacy']`); `listProjectMemberships` 'keeps a legacy role that is not one of the three' and the legacy-dated AC-11 cases; `countActiveProjectAdmins` 'AC-12'. The replacing invariant: the same exports minus `legacyRoleKeys`, every case written with bindings only, plus one case per export that a `ProjectMember` / `AgentProject` row with no binding is no source; `since` is the earliest project binding `createdAt` and `addedByUserId` that binding's USER granter, else `null`. The binding-only and read-cap cases are unchanged.
- `apps/api/test/integration/permissions/legacy-membership-queries.integration.spec.ts` — renamed to membership-queries.integration.spec.ts in the same directory (the US-002 Creates entry; the new US-002 ACs are added to it), importing the renamed module. 'AC-8: accessible project ids union the roster row and the bindings', 'AC-10: principal ids with access', 'AC-11: a membership entry carries the earliest source date and its granter' (roster row date and granter) and 'AC-12: the active project admins' (counts legacy `ADMIN` rows, expects 3) use `addLegacyMember` / `addRosterRow`. The replacing invariant: the legacy fixtures are removed; AC-8 expects only the bound projects, AC-10 the bound and globally bound ids, AC-11 the date and granter of the earliest binding, AC-12 counts 2. The other cases are unchanged.
- `apps/api/test/integration/projects/member-bindings.integration.spec.ts` — imports `legacy-membership.queries`, so the file fails to load. 'AC-5: local union lists binding and legacy members in since order, excluding global admin' (total 2 with a legacy member), 'AC-7: role update migrates a legacy row to viewer' (PATCH on a legacy-only member) and the `it.each` 'F1: finds and mutates a $source member beyond the project listing cap' rows `legacy-only` and `legacy-earliest` rely on legacy sources. The replacing invariant: the import moves to `membership.queries`; AC-5 lists only the binding member (total 1); AC-7 expects 404 `members` for a member whose only source is a `ProjectMember` row; the F1 table keeps only its binding rows. The other cases are unchanged.
- `apps/api/test/integration/projects/project-members-principals.integration.spec.ts` — 'AC-8: a user whose only source in p is a legacy ProjectMember row of DEVELOPER carries exactly one binding { id: null, roleKey: developer }' asserts the legacy chip. The replacing invariant: that user is absent from the members list, and every listed member's `bindings` items carry a non-null `id`.
- `apps/api/test/integration/permissions/membership-ticket-consumers.integration.spec.ts` — 'AC-7: a user whose only source is a legacy ProjectMember row is still offered' expects that user in the assignee list. The replacing invariant: the user whose only source is a `ProjectMember` row is not offered, and assigning a ticket to them answers 403 `tickets`.
- `apps/api/test/integration/permissions/membership-project-access.integration.spec.ts` — imports `legacy-membership.queries`. 'AC-10: GET /projects lists exactly the projects a user has a source in' expects `['p1', 'p2']` with `p2` reached through a `ProjectMember` row, and 'AC-14: a global admin may update an agent that is on the legacy roster' uses an `AgentProject` row only. The replacing invariant: the import moves to `membership.queries`; AC-10 lists `['p1']`; AC-14's agent holds a `viewer` binding in the project.
- `apps/api/test/integration/permissions/membership-agent-roster.integration.spec.ts` — `legacy()` writes `AgentProject` rows: 'AC-4: duplicate legacy add is a conflict', 'AC-5: list merges local sources', 'earliest local source determines provenance' (expects the legacy 2020 date) and 'AC-12: me lists legacy and bound projects in slug order' rely on them. The replacing invariant: a roster add for an agent whose only source is an `AgentProject` row answers 201; the list omits roster-only agents; provenance comes from the earliest binding; `me` lists only bound projects.
- `apps/api/test/integration/agents/agent-project-roster.integration.spec.ts` — its fixture writes an `AgentProject` row with no binding, so 'AC1+AC2: returns a roster row with slug, name, status, roles, capabilities, addedBy' and 'AC5: counts open tickets ... refs oldest first' get no record. The replacing invariant: the roster agent gets a `viewer` binding in the project granted by the adder, written with `prisma.roleBinding.create` (`grantedByType: 'USER'`, `grantedById` the adder; `grantRole` always writes a SYSTEM granter), and `addedById` / `addedByName` come from that binding; AC4 and AC6 are unchanged.
- `apps/api/test/integration/agents/agent-roster-repository.integration.spec.ts` — the roster is built with `agentProject.createMany`, so 'AC15: lists only the agent's non-deleted roster projects, ordered by slug', both 'AC15 boundary' cases and 'isOnProjectRoster answers per (agent, project) row' get empty answers. The replacing invariant: the same assertions over `viewer` bindings (a soft-deleted project is still excluded, another agent's bindings never leak in, `isOnProjectRoster` is `true` only for a bound agent and project).
- `apps/api/src/projects/prisma-project.repository.membership-reads.spec.ts` — imports the old module path. `findMembershipRole` 'keeps a legacy ProjectMember role', `isAgentOnRoster` 'keeps a legacy AgentProject row', `findAllForUser` 'unions a legacy row with a binding' and `findAllForAgent` 'lists the projects of the agent bindings and of its roster row' (expects `['p1', 'p2']`) rely on legacy stub rows. The replacing invariant: the import moves to `membership.queries`; legacy stub rows answer a `null` role, `false`, and no listed project.
- `apps/api/src/home/prisma-home.repository.find-projects.spec.ts` — imports `legacy-membership.queries`; 'orders by name ascending and unions the legacy row with the bindings' expects `['p1', 'p2']` with `p1` from a legacy row. The replacing invariant: the import moves to `membership.queries`, the `members` argument of `stubClient` is dropped, and only `p2` is listed.
- `apps/api/src/email/email-content.builder.spec.ts` — 'AC-14: an active user, project and developer binding yield { projectName, role, url } data' asserts a `projectMember.findUnique` call, and 'AC-14: a legacy ProjectMember row still answers its own role' expects role `ADMIN` from `setMembership('ADMIN')`. The replacing invariant: no `projectMember` read is asserted; a user whose only source is a legacy row yields `{ skip: 'SOURCE_GONE' }`; the binding cases are unchanged.
- `apps/api/src/agents/prisma-agent.repository.find-roster.spec.ts` — the roster is supplied through `agentProject.findMany` with `roleBinding.findMany` answering `[]`, so 'US-002 AC1: returns a roster record per local membership', 'AC2: surfaces the adding user id and name on each row' and the open-ticket cases get no record. The replacing invariant: the same rows are supplied as PROJECT-scope `viewer` bindings through the `roleBinding` stub (`grantedByType: 'USER'`, `grantedById` the adder, `createdAt` the joined date), and the `agentProject.findMany` stub is removed.
- `apps/api/src/notifications/notification-eligibility.spec.ts` — its fake client has `projectMember`; 'keeps a user whose only source in the project is a project binding' and 'reads the compatibility sources once per distinct draft project' assert `projectMember.findMany` calls, and the first case uses a `legacy: { p1: ['actor'] }` source. The replacing invariant: no `projectMember` read is asserted and the legacy sources are removed; access comes from the binding stubs. (US-005 rewrites the file for the new constructor.)
- `apps/api/src/notifications/ticket-mention.resolver.spec.ts` — its fake client has `projectMember`; 'keeps visible ids in token order', 'drops a token for a user who is neither a project member nor a global admin' and 'drops a disabled user even when the project names them' use `legacy:` sources, 'keeps a user whose only source in the project is a project binding' asserts a `projectMember.findMany` call, and the no-token case asserts `projectMember` was not called. The replacing invariant: the legacy sources and `projectMember` assertions are removed; project access comes from the binding stubs. (US-005 rewrites the file for the new constructor.)
- `apps/api/src/projects/assignees/prisma-project-assignees.repository.spec.ts` — its `projectMember` / `agentProject` stubs feed `principalIdsWithAccess`, so 'reads non-disabled users whose id has access', 'falls back to the email when a user has no name' and 'puts every user before every agent and caps the combined list at limit' get `id: { in: [] }`. The replacing invariant: access comes from the `roleBinding` stubs only. (US-004 rewrites the file for the new `search` signature.)

**US-003**
- `apps/api/test/unit/config/agent-project-scoping.spec.ts` — it asserts `authConfig()` answers `agentProjectScoping: true` by default and that `AGENT_PROJECT_SCOPING='maybe'` is rejected by `validate()` and `authConfig()`. The replacing invariant: the file is deleted; US-003's ACs pin that the value is accepted and ignored.
- `apps/api/src/auth/prisma-auth.repository.spec.ts` — 'findAgentRoles returns role strings' calls the deleted `findAgentRoles`, and the `agentRoleEntry.findMany` stub serves only it. The replacing invariant: that case and stub are removed; `findAgentCapabilities` and `findAgentByKeyHash` cases are unchanged.
- `apps/api/src/projects/project-access.service.spec.ts` — 'AC-6: admits an agent without asking when agent project scoping is off' builds `new ProjectAccessService(repo, permissions, { agentProjectScoping: false })` and expects `can` not to be called. The replacing invariant: the case is deleted; the service is built with two arguments and every agent case asks `can(agent, 'project.read', { projectId })`.
- `apps/api/test/unit/projects/agent-project-access.spec.ts` — `setup(authConfig?)` passes a third constructor argument, and 'US-001 AC6: bypasses the permission check when agent project scoping is disabled' expects `can` not to be called. The replacing invariant: `setup()` takes no config and builds the service with two arguments; AC6 and its boundary case are deleted; AC4, AC5, AC7 and AC8 are unchanged.
- `apps/api/test/unit/projects/projects-find-all-for-principal.spec.ts` — 'AC12 (S4c US-001): with scoping off an agent gets every non-deleted project' builds `ProjectAccessService` with `{ agentProjectScoping: false }` and expects `findAll` rows. The replacing invariant: the case is deleted and the header comment stops naming the flag; the agent branch always calls `findAllForAgent(agentId)` (AC11).
- `apps/api/src/agents/agents.service.spec.ts` — describe `listProjectRoster`, it 'returns scoping: false when AGENT_PROJECT_SCOPING is off' (`AUTH_CFG` with `agentProjectScoping: false`) expects `result.scoping` to be `false`. The replacing invariant: the case is deleted; the neighbouring case keeps `scoping: true`. The pickup case 'still asks the target agent keys when agent project scoping is off (US-009)' is renamed to drop the flag.
- `apps/api/src/agents/agents-pickup.routes.spec.ts` — 'US-009: still asks the target agent keys when agent project scoping is off' boots `bootApp({ agentProjectScoping: false })`; it still passes, but pins a flag that no longer exists. The replacing invariant: the case is deleted (the scoped case next to it asks the target agent's keys).
- `apps/api/src/fleet/assistant/assistant-tool.executor.agent-caller.spec.ts` — 'the agent principal carries its slug, status and capabilities, and is only blacklisted while PAUSED' compares `ctx.actor` with an object that has `agentRoles: []`. The replacing invariant: the same comparison without `agentRoles`.
- `apps/api/test/integration/permissions/membership-project-access.integration.spec.ts` — the describe 'project lists with agent project scoping off (US-002 AC-12)', 'AC-12: with scoping off, an unscoped agent lists every non-deleted project', sets `AGENT_PROJECT_SCOPING=off`. The replacing invariant: the describe is deleted (US-003's integration ACs pin the ignored flag).

**US-004**
- `apps/api/src/permissions/permission.service.spec.ts` — it builds `PermissionService` with doubles that have no `findCandidatePrincipalIds` and no `findRolesByScope`. The replacing invariant: the doubles gain both methods, and US-004 AC-10's rejection cases are added here; the US-001 cases are unchanged.
- `apps/api/src/projects/assignees/project-assignees.service.spec.ts` — `new ProjectAssigneesService({ search })` has no `PermissionService`, and 'passes the validated q and limit through to the repository' and 'defaults to the no-filter query' expect three-argument `search` calls (`('proj-1', 'ALI', 2)`, `('proj-1', '', 20)`). The replacing invariant: the service is built with a `{ principalIdsWithKey }` double second; it asks `('USER', projectId, 'project.read')` and `('AGENT', projectId, 'project.read')` and calls `search(projectId, q, limit, { userIds, agentIds })`; mapping and order are unchanged.
- `apps/api/src/projects/assignees/prisma-project-assignees.repository.spec.ts` — every `repository.search(PROJECT_ID, q, limit)` call has three arguments, and the membership stubs feed a read the repository no longer makes. The replacing invariant: `search(PROJECT_ID, q, limit, { userIds, agentIds })`; `where.id.in` equals the passed ids; the disabled, status and `OR` filters, the name order, `take = limit` and users-before-agents are unchanged; the membership stubs are removed.

**US-005**
- `apps/api/src/notifications/notification-eligibility.spec.ts` — `new NotificationEligibility({ client })` has no `PermissionService`, the `user.findMany` stub answers `role` rows that decide admission, and 'finds active global admins' asserts `where: { role: 'ADMIN', disabled: false }`. The replacing invariant: the service is built with a `{ effectiveKeys }` double second; a project draft passes when the double's set has `'project.read'`, asked once per distinct (user, project); a draft with no project passes for any enabled user; `findGlobalAdminIds` reads enabled users with a `projectId`-null `owner` or `admin` binding, by `createdAt` ascending.
- `apps/api/src/notifications/ticket-mention.resolver.spec.ts` — `new TicketMentionResolver({ client })` has no `PermissionService`, and 'keeps a global ADMIN who is in no project' admits a user by `role: 'ADMIN'`. The replacing invariant: the resolver is built with an `{ effectiveKeys }` double second; an enabled mentioned user is kept when the double's set for the project has `'project.read'`, in text order; disabled users are dropped before asking; a text with no tokens answers `[]` with no user read and no `effectiveKeys` call.

### Seams

- **`principalIdsWithKey` (US-004 producer and consumer).** `ProjectAssigneesService.search` is its only production caller; US-004 AC-11 triggers `GET /projects/:slug/assignees` and asserts on the answer (AC-13, AC-14), and AC-15 pins the call arguments with a spy.
- **`membership.queries.ts` (US-002) → US-004, US-005.** US-004 drops `principalIdsWithAccess` from the assignee repository and US-005 from the eligibility and the mention resolver; the function itself stays exported (no remaining production caller is required).
- **`PermissionService` constructor (US-001) → US-003.** US-001 removes the `AUTH_CFG` parameter; US-003 then removes `IAuthConfig.agentProjectScoping`, which nothing reads any more.

## Acceptance Criteria

Every DB-backed AC seeds the system roles (`ensureSystemRoles` or a booted app) and writes the legacy rows it names directly with the Prisma client. "Only a global `member` binding" means the principal's sole `RoleBinding` is `member` with `projectId` null (for an agent, `agent`).

### US-001

1. [integration] A user whose rows are a `ProjectMember` row of role `ADMIN` in project P and only a global `member` binding: `PermissionService.can(user principal, 'project.read', { projectId: P })` answers `{ allowed: false, reason: 'not-granted' }`.
2. [integration] An agent with an `AgentProject` row for P, an `AgentRoleEntry` row `DEVELOPER` and only a global `agent` binding: `PermissionService.effectiveKeys({ type: 'AGENT', id }, { projectId: P }).has('ticket.create')` is `false`.
3. [integration] The same agent: `effectiveKeys({ type: 'AGENT', id }, { projectId: P }).has('project.read')` is `false`.
4. [integration] A user with `User.role = 'ADMIN'` and only a global `member` binding: `can(user principal, 'project.read')` (no project) answers `allowed: false`.
5. [integration] The same user: `can(user principal, 'ticket.create', { projectId: P })` answers `allowed: false`.
6. [integration] A user with no `RoleBinding` row at all: `effectiveKeys({ type: 'USER', id }, 'global')` is the empty set.
7. [integration] A user with a global `admin` binding and no project binding: `can(user principal, 'ticket.create', { projectId: P })` answers `allowed: true`.
8. [unit] A `PermissionService` built with three arguments (a role repository double, a binding repository double that has only `findEffectiveBindings` and `findAccessibleProjectIds`, and a pass-through `PermissionCache` double) answers `can(user principal, 'agent.read')` with `allowed: true` when `findEffectiveBindings` returns one global `member` binding whose permissions include `agent.read`, without calling any other repository method.
9. [integration] `MembershipService.isGlobalAdmin(userId)` answers `false` for a user with `User.role = 'ADMIN'` and only a global `member` binding.
10. [integration] `MembershipService.isGlobalAdmin(userId)` answers `true` for a user with a global `owner` binding.
11. [integration] The actor C holds a global `member` binding and a custom GLOBAL role whose permissions are `['user.update']`. U1 is the only user with a global `owner` or `admin` binding (an `admin` binding, `User.role = 'ADMIN'`), and U2 has `User.role = 'ADMIN'` with only a global `member` binding. C's `PATCH /admin/users/:id` with `{ disabled: true }` for U1 answers 409 `users.lastAdmin`.
12. [integration] With the same actor C, no user holding a global `owner` or `admin` binding, and U2 with `User.role = 'ADMIN'` and only a global `member` binding, C's `PATCH /admin/users/:id` with `{ disabled: true }` for U2 answers 200 (U2 is not an admin, so the last-admin guard does not apply).
13. [integration] `PrismaUsersRepository.countActiveAdmins()` answers 1 when one enabled user holds a global `admin` binding, a disabled user holds a global `owner` binding, and a third enabled user has `User.role = 'ADMIN'` without a binding.

### US-002

1. [integration] `listProjectMemberships(db, P, 'USER')` from `membership.queries.ts` omits a user whose only source in P is a `ProjectMember` row.
2. [integration] `listProjectMemberships(db, P, 'USER')` returns, for a user with a `developer` binding in P granted by user G (written with `grantedByType: 'USER'`, `grantedById: G`), `{ principalId, role: 'DEVELOPER', since: <the binding's createdAt>, addedByUserId: G }`.
3. [integration] `listProjectMemberships(db, P, 'AGENT')` omits an agent whose only source in P is an `AgentProject` row.
4. [integration] `agentHasProjectAccess(db, agentId, P)` answers `false` for an agent with an `AgentProject` row for P and no binding in P.
5. [integration] `agentHasProjectAccess(db, agentId, P)` answers `true` for an agent with a `viewer` binding in P.
6. [integration] `accessibleProjectIds(db, { type: 'USER', id })` answers exactly `[P2]` for a user with a `ProjectMember` row in P1 and a `developer` binding in P2.
7. [integration] `principalIdsWithAccess(db, P, 'USER')` answers exactly `[<the viewer-bound user's id>]` when P has one user with a `viewer` binding and one user whose only source is a `ProjectMember` row.
8. [integration] `countActiveProjectAdmins(db, P)` answers 1 when P has one enabled user with a `project-admin` binding, one disabled user with a `project-admin` binding, and one enabled user with a `ProjectMember` row of role `ADMIN` and no binding.
9. [integration] `userProjectRole(db, userId, P)` answers `null` for a user whose only source in P is a `ProjectMember` row.
10. [integration] `userProjectRole(db, userId, P)` answers `'DEVELOPER'` for a user with a `projectId`-null `developer` binding when P is live.
11. [integration] `userProjectRole(db, userId, P)` answers `null` for that user when P is soft-deleted.
12. [integration] `GET /projects/:slug/members?principals=all`, sent by a Project Admin of P, lists exactly the principals with a binding in P (the Project Admin and one `viewer`-bound agent), when P also has a user whose only source is a `ProjectMember` row and an agent whose only source is an `AgentProject` row.
13. [integration] For a user with a `viewer` binding in P and a `ProjectMember` row of role `DEVELOPER`, the `id`s of the member entry's `bindings` in `GET /projects/:slug/members` are exactly `[<the viewer binding's id>]`.
14. [integration] `GET /projects`, sent by a user whose only source in P1 is a `ProjectMember` row and who has a `viewer` binding in P2, lists exactly the slug of P2.

### US-003

1. [unit] The env `validate` function accepts a config that sets every required variable and `AGENT_PROJECT_SCOPING: 'bogus'` without throwing.
2. [unit] The `authConfig` factory, called with `AGENT_PROJECT_SCOPING` set to `'bogus'` and the required JWT and API-key variables set, returns without throwing.
3. [integration] With `AGENT_PROJECT_SCOPING=off` in the environment at boot, an agent with only a global `agent` binding gets 403 `projects` from `GET /projects/:slug` for project P.
4. [integration] In that app, the same agent's `GET /projects` lists only the projects where it has a binding (one `viewer` binding in P2 lists exactly P2).
5. [integration] In that app, an agent with a `viewer` binding in P gets 200 from `GET /projects/:slug` for P.
6. [integration] In that app, `GET /projects/:slug/agents`, sent by a Project Admin of P, answers `scoping: true`.
7. [unit] `AgentAuthProvider.buildPrincipal(agent)`, with a `CacheManager` double whose `get` calls its loader and an auth repository double that has only `findAgentCapabilities` (returning `['nax']`), answers a principal whose `capabilities` are `['nax']` and whose `authorities` are `[]`.
8. [unit] A `ProjectAccessService` built with two arguments (a project repository double and a `PermissionService` double) calls the double's `can` with `('project.read', { projectId: 'p1' })` for an agent principal in `resolveMembership('p1', agent)`, and throws `ForbiddenAppException` when that answer is `allowed: false`.
9. [integration] `seedAdminUser(db, { email, name, password })` on an empty database answers `{ created: true, roleKey: 'owner' }`, and the created user's `projectId`-null bindings are exactly the `member` and `owner` roles.
10. [integration] `seedAdminUser` run when another user already holds an `owner` binding answers `roleKey: 'admin'`, and the created user's `projectId`-null bindings are exactly the `member` and `admin` roles.
11. [integration] `seedAdminUser` run for an email that already exists answers `{ created: false }` and the user and binding counts are unchanged.

### US-004

1. [integration] `PermissionService.principalIdsWithKey('USER', P, 'project.read')` includes a user with a `developer` binding in P.
2. [integration] `principalIdsWithKey('USER', P, 'project.read')` includes a user with a global `admin` binding and no project binding.
3. [integration] `principalIdsWithKey('USER', P, 'project.read')` includes a user holding a custom GLOBAL role whose permissions are `['project.read']`, bound with `projectId` null.
4. [integration] `principalIdsWithKey('USER', P, 'project.read')` omits a user whose only binding in P is a custom PROJECT role whose permissions do not include `project.read`.
5. [integration] `principalIdsWithKey('USER', P, 'project.read')` omits a user whose only source in P is a `ProjectMember` row.
6. [integration] For a project whose only holders are one `developer`-bound user and one user holding a custom GLOBAL role whose permissions entry does not expand (written directly as `['not.a.key']`), `principalIdsWithKey('USER', P, 'project.read')` answers exactly `[<the developer's id>]`.
7. [integration] `principalIdsWithKey('AGENT', P, 'project.read')` includes an agent with a `viewer` binding in P.
8. [integration] `principalIdsWithKey('AGENT', P, 'project.read')` omits an agent whose only source in P is an `AgentProject` row.
9. [integration] For users A and B (A's id sorts first), where B holds a `developer` binding in P and a `projectId`-null `viewer` binding and A a `viewer` binding in P, `principalIdsWithKey('USER', P, 'project.read')` answers exactly `[A, B]`.
10. [unit] `principalIdsWithKey` rejects with the same error when a candidate's `effectiveKeys` read rejects (a database error).
11. [integration] `principalIdsWithKey('USER', P, 'project.read')` omits a user whose only project binding is a `developer` binding in another project P2.
12. [integration] `principalIdsWithKey('USER', P, 'project.read')` omits an agent holding a `viewer` binding in P.
13. [integration] `GET /projects/:slug/assignees` with an empty `q`, sent by a developer of P, lists a user holding a custom GLOBAL role whose permissions are `['project.read']`.
14. [integration] `GET /projects/:slug/assignees` with an empty `q`, sent by a developer of P, omits a user whose only binding in P is a custom PROJECT role without `project.read`.
15. [unit] With a `PermissionService` double whose `principalIdsWithKey` answers `['u1']` for `('USER', P, 'project.read')`, `['a1']` for `('AGENT', P, 'project.read')` and `[]` for anything else, `ProjectAssigneesService.search(P, { q: 'a', limit: 10 })` calls the repository double's `search` with `(P, 'a', 10, { userIds: ['u1'], agentIds: ['a1'] })`.

### US-005

1. [integration] `NotificationEligibility.filter` keeps a draft for project P addressed to a user holding a custom GLOBAL role whose permissions are `['project.read']`.
2. [integration] `NotificationEligibility.filter` drops a draft for project P addressed to a user with `User.role = 'ADMIN'` and only a global `member` binding.
3. [integration] `NotificationEligibility.filter` drops a draft for project P addressed to a user whose only binding in P is a custom PROJECT role whose permissions do not include `project.read`.
4. [integration] `NotificationEligibility.filter` keeps a draft with no project addressed to an enabled user with only a global `member` binding.
5. [unit] `NotificationEligibility.filter` with three drafts for two users in one project calls the `PermissionService` double's `effectiveKeys` exactly once per distinct (user, project) pair.
6. [integration] `NotificationEligibility.findGlobalAdminIds()` answers exactly the enabled users with a global `owner` or `admin` binding, in user `createdAt` order, when the data also holds a disabled `admin` binding holder and a user with `User.role = 'ADMIN'` and no admin binding.
7. [integration] `NotificationEligibility.filter` drops a draft for project P addressed to a user whose only project binding is a `developer` binding in another project P2.
8. [unit] `NotificationEligibility.filter` rejects with the same error when the `PermissionService` double's `effectiveKeys` rejects.
9. [unit] `TicketMentionResolver.mentionedUserIds` rejects with the same error when the `PermissionService` double's `effectiveKeys` rejects for a mentioned enabled user.
10. [integration] `TicketMentionResolver.mentionedUserIds(P, text)` for a text mentioning, in this order, a user with a `viewer` binding in P, a user with `User.role = 'ADMIN'` and only a global `member` binding, and a user with a global `admin` binding, answers the first and the third user ids in that order.
