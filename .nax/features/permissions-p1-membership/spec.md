# SPEC: Permissions P1b — Project and Agent Membership on Role Bindings

## Summary

This feature moves project membership in `apps/api` onto the `RoleBinding` model that `permissions-p1-roles` added:
- **One set of compatibility queries.** Every question "is this principal in this project, and with which legacy role?" is answered from bindings **unioned with** the legacy `ProjectMember` and `AgentProject` rows, by query functions in `apps/api/src/permissions/legacy-membership.queries.ts`.
- **Every membership reader moves to those queries.** The legacy repository methods keep their names and contracts and change only what they read. That covers the project access check, the project and home lists, ticket assignment, assignee search, the domain writer, fleet activity scoping, schedule owner checks, notification eligibility, mentions and the member-added email.
- **The membership routes write bindings.** The member, invite and agent roster routes create and remove `RoleBinding` rows instead of `ProjectMember` and `AgentProject` rows. Removals also clear the legacy row.

No permission decision changes for an existing member: a principal that had access through a legacy row keeps it, and a principal whose access now comes from a binding gets the legacy role the matching legacy row would have given it.

This is the second of six features implementing phase P1 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md`. The design doc's phasing section lists five features; it predates the split of `permissions-p1-roles` into roles and membership, and `.nax/features/permissions-p1-roles/spec.md` is the authority for the order: roles, **membership**, enforce-core, enforce-fleet, cleanup, and web in parallel.

## Motivation

`permissions-p1-roles` (PR #308) added roles, bindings and the `/role-bindings` API, but no existing reader looks at bindings yet. A user bound to `developer` in a project through `/role-bindings` is still refused by that project's routes, because `ProjectAccessService.resolveMembership` reads only `ProjectMember`.

The next features move route checks onto permission keys (`permissions-p1-enforce-core`, `permissions-p1-enforce-fleet`), and `PermissionService.can` reads only bindings. If those checks moved first, every member whose access lives in a legacy row would be refused. This feature closes the gap from both sides: readers see bindings, and the routes that grant membership write bindings.

**Rulings that bind this feature** (user, 2026-10-18 and 2026-10-19):
- **No data migration.** Legacy rows stay and are read through a union until `permissions-p1-cleanup` drops them. New writes go to bindings only. Removals and demotions also clear the legacy row.
- **Global agent roles stay legacy** (2026-10-19). `PATCH /agents/:slug/update-roles` keeps writing `AgentRoleEntry`, and the agent principal's `agentRoles` keep coming from it. The web replaces that dialog with bindings (`permissions-p1-web`), and cleanup deletes the route and the table.
- **Roster add writes a `viewer` binding** (2026-10-19). The roster grants project access, as today. The agent's work rights inside the project still come from its global `AgentRoleEntry` roles until enforce-core.
- **One feature** (2026-10-19), not a reads/writes split.

## Design

### Rulings that bind every story

1. **The union lives in one file.** `apps/api/src/permissions/legacy-membership.queries.ts` holds every compatibility query. Its functions take the Prisma client as their first argument, like `lockProjectMembers(db, projectId)` in `apps/api/src/common/utils/advisory-lock.ts`, so a caller inside `txManager.run` passes `this.prisma.client` and the query joins the transaction. The file is persistence-mapping code in the sense of `.nax/rules/api-data.md`: it may import the generated Prisma client type, and only repositories and the three legacy direct-Prisma classes below call it.
2. **The callers are persistence code.** The queries are called from repositories, and from the three classes that already read Prisma directly (`NotificationEligibility`, `TicketMentionResolver`, `EmailContentBuilder`, tolerated legacy per `.nax/rules/api-data.md`). No service changes its constructor to read membership.
3. **Legacy repository methods keep their names, parameters and return types.** Only what they read changes. Their callers, and the specs that stub them, are unaffected. `permissions-p1-cleanup` deletes the queries file together with these methods.
4. **A binding write inside a caller's transaction** goes through `MembershipService.afterCommit(() => this.txManager.run(...))`, as `permissions-p1-roles` requires, so the permission cache is invalidated after the commit.
5. **Granter.** A route write records the calling user: `{ type: 'USER', id: principal.id }`. These routes already refuse agents (`assertProjectAdmin`). An invite acceptance records `{ type: 'SYSTEM', id: 'invite' }`.
6. **Constructor order.** A service that gains `MembershipService` takes it as a required parameter appended last (none of them has an `@Optional()` parameter).
7. **Test setup.** `test/helpers/reset-db.ts` truncates every table, so a DB-backed test that creates bindings runs `SystemRoleSeeder.onApplicationBootstrap()` after the reset, or boots the app. Tests create bindings through `MembershipService.createBinding`.
8. **Global admins are unchanged.** Global `owner` and `admin` bindings are mirrored into `User.role = 'ADMIN'` by `permissions-p1-roles`, and every reader keeps its existing `User.role === 'ADMIN'` / `principal.role === 'ADMIN'` short-cut. GLOBAL-scope roles are never a membership source (see "Sources").

### Sources

These definitions are used by every rule below.

- A **legacy row** of a principal in project `P`: its `ProjectMember(projectId P, userId)` row for a USER, or its `AgentProject(agentId, projectId P)` row for an AGENT.
- A **project binding** of a principal in `P`: a `RoleBinding` of that principal with `projectId = P` whose role has scope `PROJECT`.
- A **global project binding** of a principal: a `RoleBinding` with `projectId` null whose role has scope `PROJECT`. Per the design, it applies in every project.
- The **local sources** of a principal in `P` are its legacy row and its project bindings in `P`.
- The **access sources** of a principal in `P` are its local sources plus its global project bindings.
- A binding of a GLOBAL-scope role (`owner`, `admin`, `member`, `agent`, or a custom GLOBAL role) is never a source.

**Two readings, used consistently:**
- "Who **belongs** to this project" (the members page, the roster page, the duplicate and not-found checks of the membership routes, the last-admin count) uses **local** sources.
- "Who **may act** in this project" (route access, project lists, ticket assignment, assignee search, pickup, notifications, mentions, email, schedules, the domain writer) uses **access** sources.

**The legacy role of a source:**
- a binding: `legacyRoleForRoleKey(roleKey)`;
- a `ProjectMember` row: its stored `role` string, unchanged (it may be a legacy value such as `AGENT` or `MEMBER`);
- an `AgentProject` row: `'VIEWER'`.

A principal's legacy role over a set of sources is `strongestProjectRole` of their roles.

### Legacy role mapping

`apps/api/src/permissions/legacy-project-roles.ts` (new) exports:

```ts
export type LegacyProjectRole = 'ADMIN' | 'DEVELOPER' | 'VIEWER';

/** The binding a legacy role is written as. */
export const ROLE_KEY_FOR_LEGACY_ROLE: Readonly<Record<LegacyProjectRole, string>> = {
  ADMIN: 'project-admin',
  DEVELOPER: 'developer',
  VIEWER: 'viewer',
};

/** 'project-admin' -> 'ADMIN', 'developer' -> 'DEVELOPER', every other role key -> 'VIEWER'. */
export function legacyRoleForRoleKey(roleKey: string): LegacyProjectRole;

/**
 * The strongest of several legacy roles: ADMIN > DEVELOPER > VIEWER > any other string.
 * Among other strings, the lexicographically smallest wins. An empty list answers null.
 */
export function strongestProjectRole(roles: readonly string[]): string | null;
```

Mapping every other role key to `'VIEWER'` is deliberate. The legacy CASL factory knows only ADMIN, DEVELOPER and VIEWER, so `reviewer`, `verifier`, `triager`, `approver` and custom PROJECT roles get the least-privileged legacy set until `permissions-p1-enforce-core` checks their real keys.

### Compatibility queries

`apps/api/src/permissions/legacy-membership.queries.ts` (new). `PrincipalRef` and `PrincipalType` are the existing types in `apps/api/src/permissions/permissions.types.ts`; `ProjectMembership` is added there.

```ts
export interface ProjectMembership {
  principalId: string;
  /** strongestProjectRole over the principal's LOCAL sources in the project. */
  role: string;
  /** The earliest of: the legacy row's date (ProjectMember.joinedAt, AgentProject.createdAt) and the createdAt of each project binding. */
  since: Date;
  /** From the earliest source: AgentProject.addedById; a binding's grantedById when its grantedByType is 'USER'; otherwise null. */
  addedByUserId: string | null;
}

/** Most rows one query of a listing reads (.nax/rules/api-data.md: every findMany takes `take`). */
export const MEMBERSHIP_READ_CAP = 5000;

export function userProjectRole(db: PrismaClient, userId: string, projectId: string): Promise<string | null>;
export function localProjectRole(db: PrismaClient, principal: PrincipalRef, projectId: string): Promise<string | null>;
export function agentHasProjectAccess(db: PrismaClient, agentId: string, projectId: string): Promise<boolean>;
export function accessibleProjectIds(db: PrismaClient, principal: PrincipalRef): Promise<string[]>;
export function principalIdsWithAccess(db: PrismaClient, projectId: string, type: PrincipalType): Promise<string[]>;
export function listProjectMemberships(db: PrismaClient, projectId: string, type: PrincipalType): Promise<ProjectMembership[]>;
export function countActiveProjectAdmins(db: PrismaClient, projectId: string): Promise<number>;
```

`PrismaClient` is the generated client type (`src/generated/prisma/client`); callers pass `this.prisma.client`.

**Rules:**
- **`userProjectRole`**: `strongestProjectRole` over the user's **access** sources in the project; `null` when it has none.
- **`localProjectRole`**: `strongestProjectRole` over the principal's **local** sources; `null` when it has none.
- **`agentHasProjectAccess`**: `true` when the agent has at least one **access** source in the project.
- **`accessibleProjectIds`**: the ids of non-deleted projects in which the principal has an access source, ascending. A principal with a global project binding gets every non-deleted project.
- **`principalIdsWithAccess`**: the ids of principals of `type` with an access source in the project, ascending, distinct. Disabled users are included; callers that exclude them already filter on `disabled`.
- **`listProjectMemberships`**: one entry per principal of `type` with a **local** source in the project, ordered by `since` ascending, then `principalId` ascending.
- **`countActiveProjectAdmins`**: the number of distinct non-disabled users whose **local** sources include role `'ADMIN'` (a legacy `ADMIN` row or a `project-admin` binding in the project).
- **Unknown ids.** A `projectId`, `userId` or `agentId` that names no row has no sources: the queries answer `null`, `false`, `[]` or `0`, and never throw.
- **Read cap.** `accessibleProjectIds`, `principalIdsWithAccess` and `listProjectMemberships` read at most `MEMBERSHIP_READ_CAP` rows per underlying query. When a query returns the cap, the function logs a warning naming itself and the project or principal, and returns what it read.
- **No caching.** The queries run on every call, as the legacy reads do today.

### `MembershipService.removeProjectBindings`

```ts
removeProjectBindings(principal: PrincipalRef, projectId: string, roleKeys?: readonly string[]): Promise<number>;
```

It deletes the principal's bindings whose `projectId` is the given project, restricted to `roleKeys` when given, and returns the number deleted. The delete goes through a new `PrismaRoleBindingRepository.deleteProjectBindings(principal, projectId, roleKeys?)`. It never touches a legacy row or a `projectId`-null binding. It runs inside `txManager.run`, joining a caller's transaction, and invalidates the permission cache like the other `MembershipService` writes (after commit, through `afterCommit` when a caller owns the transaction).

### Readers moved to the compatibility queries

Each row keeps the method's name, parameters and return type.

| Reader | Today reads | Target |
|:--|:--|:--|
| `PrismaProjectRepository.findMembershipRole(projectId, userId)` | `ProjectMember.role` | `userProjectRole` |
| `PrismaProjectRepository.isAgentOnRoster(projectId, agentId)` | `AgentProject` row | `agentHasProjectAccess` |
| `PrismaProjectRepository.findAllForUser(userId)`, `findAllForAgent(agentId)` | `members` / `agents: { some }` | non-deleted projects whose id is in `accessibleProjectIds` |
| `PrismaHomeRepository.findProjects(caller)` (non-admin) | `members: { some }` | `id` in `accessibleProjectIds({ type: 'USER', id: caller.id })` |
| `PrismaTicketsRepository.findProjectMemberRole(projectId, userId)` | `ProjectMember.role` | `userProjectRole` |
| `PrismaTicketsRepository.isAgentOnProjectRoster(projectId, agentId)` | `AgentProject` row | `agentHasProjectAccess` (still called under `lockProjectAgents`) |
| `PrismaProjectAssigneesRepository.search(projectId, q, limit)` | `ProjectMember` and `AgentProject` | users and agents whose id is in `principalIdsWithAccess`, with the same filters (enabled users, assignable agent statuses, `q`), order and `limit` |
| `PrismaKodaDomainWriterRepository.findUserProjectRoles(projectId, userId)` | `User.role` and `ProjectMember.role` | the same two entries as today (`'ADMIN'` when `User.role` is `'ADMIN'`, and the legacy row's raw role), plus `userProjectRole` when non-null, de-duplicated. Keeping the raw legacy role means a legacy `AGENT` row still satisfies the writer's allowed roles when a `viewer` binding outranks it in `strongestProjectRole` |
| `PrismaFleetActivityRepository.findMemberProjectIds(userId)` | `ProjectMember` | `accessibleProjectIds({ type: 'USER', id: userId })` |
| `PrismaScheduleRepository.findOwnerAccess(projectId, userId)` | `projectRole` from `ProjectMember` | `projectRole` from `userProjectRole` |
| `NotificationEligibility.filter` | `projectMember.findMany` | for each distinct `projectId` in the drafts, `principalIdsWithAccess(projectId, 'USER')` |
| `TicketMentionResolver.mentionedUserIds` | `projectMemberships: { some }` | enabled users that are global `ADMIN` or in `principalIdsWithAccess(projectId, 'USER')` |
| `EmailContentBuilder` (MEMBER_ADDED) | `projectMember.findUnique` | `userProjectRole`; `null` keeps `skip: 'SOURCE_GONE'`, otherwise it is the template's `role` |
| `PrismaAgentRepository.isOnProjectRoster(agentId, projectId)` | `AgentProject` row | `agentHasProjectAccess`. Its callers are pickup (`suggestTicket`) and `isOnProjectRosterBySlug`; `removeFromProject` stops calling it (see "Agent roster") |
| `PrismaAgentRepository.findRosterProjects(agentId)` | `AgentProject` | non-deleted projects whose id is in `accessibleProjectIds({ type: 'AGENT', id })`, ordered by slug |

`ProjectAccessService`, `ProjectsService`, `HomeService`, `TicketsService`, `ProjectAssigneesService`, `KodaDomainWriter`, `FleetActivityService`, `SchedulesService` and `ScheduleTicker` are unchanged: they reach the new reads through these methods. The agent principal's `agentRoles` (`AgentAuthProvider`, `AgentRoleEntry`) and the CASL factory are unchanged.

### Membership routes write bindings

All routes keep their paths, request DTOs, response DTOs, status codes and error codes. The OpenAPI contract does not change.

**Members** (`ProjectMembersService`, `/projects/:slug/members`). Each write runs inside `membership.afterCommit(() => txManager.run(...))` and takes the existing `lockMembers(projectId)` advisory lock first.
- **Repository reads.** `PrismaProjectMembersRepository.findMemberPage(projectId, page)` builds the page from `listProjectMemberships(db, projectId, 'USER')`, joined with each user's `email`, `name` and `disabled`, and sliced by `IPageOption`; `role` is the membership's `role`, `joinedAt` its `since`, and `total` counts the memberships. `findMember(projectId, userId)` answers the user's record when `localProjectRole` is non-null (with that role and the membership's `since`), else `null`. `countProjectAdmins(projectId)` answers `countActiveProjectAdmins`. A new `deleteMemberIfPresent(projectId, userId)` deletes the legacy row when there is one.
- **List.** Unchanged in the service: the page from `findMemberPage`, `canManage` and `viewerRole` from `resolveMembership`.
- **Add.** After the existing user lookups, a user for whom `findMember` answers a record gets 409 `members`. Otherwise the service creates a binding of `ROLE_KEY_FOR_LEGACY_ROLE[dto.role ?? 'VIEWER']` in the project. The response is the new member, as `findMember` answers it.
- **Update role.** A user for whom `findMember` answers `null` gets 404 `members`. The last-admin rule keeps its meaning: the change is refused with 409 `members.lastAdmin` when the user's current role is `ADMIN`, the user is not disabled, the new role is not `ADMIN`, the caller is not a global admin, and `countProjectAdmins` is at most 1. Otherwise the service calls `removeProjectBindings(user, projectId, ['project-admin', 'developer', 'viewer'])`, `deleteMemberIfPresent`, and creates the binding for the new role. Other project bindings (for example `reviewer`) are kept. The response is the member as `findMember` answers it after the write. Because the old binding is replaced, the member's `joinedAt` (`since`) becomes the new binding's `createdAt` unless another local source is older; this re-dating is accepted.
- **Remove.** A user for whom `findMember` answers `null` gets 404 `members`. The same last-admin rule applies with no new role. Otherwise the service calls `removeProjectBindings(user, projectId)` and `deleteMemberIfPresent`.

**Invites.**
- `ProjectInvitesService.addExistingUser(projectId, userId, role, principal)` gains the calling principal, for the granter (its caller `create` already has it). Inside its transaction it first takes the project members lock (a new `PrismaProjectInvitesMembersRepository.lockMembers(projectId)`, the same `lockProjectMembers` advisory lock `ProjectMembersService` takes), then checks: a user whose `localProjectRole` is non-null answers 409 `invites.memberExists`. Otherwise it creates a binding of `ROLE_KEY_FOR_LEGACY_ROLE[role]` instead of a `ProjectMember` row. The ADDED response's `member` is built from the user's `email` and `name` (`PrismaProjectInvitesMembersRepository.findUserState` also returns `name`), `role` is the mapped legacy role, `joinedAt` the created binding's `createdAt`, and `disabled` false. The MEMBER_ADDED schedule stays in the same transaction, and the transaction runs inside `membership.afterCommit`. The local check goes through a new `PrismaProjectInvitesMembersRepository.findLocalRole(projectId, userId)`.
- `InviteAcceptanceService.accept`: inside the existing transaction, after creating the user, it creates a binding of `ROLE_KEY_FOR_LEGACY_ROLE[invite.role]` in the invite's project and calls `membership.bindBaseline({ type: 'USER', id })`, instead of creating a `ProjectMember` row. The transaction runs inside `membership.afterCommit`. A rejected acceptance writes no binding.

**Agent roster** (`AgentsService`, `/projects/:slug/agents`). `AgentsService` already takes `MembershipService` (fourth constructor parameter). Writes keep the existing `lockProjectAgents(projectId)` lock and run inside `membership.afterCommit`.
- **List.** `PrismaAgentRepository.findProjectRoster(projectId)` keeps its return type and order (agent name ascending) and builds its rows from `listProjectMemberships(db, projectId, 'AGENT')`: `addedAt` is the membership's `since`, `addedById` its `addedByUserId`, and `addedByName` that user's name (or null). The agent fields and the open-ticket summary are computed as today.
- **Add** (`addToProject`). After the existing project, agent and OFFLINE checks, an agent with a local source (new `PrismaAgentRepository.hasLocalMembership(agentId, projectId)`, true when `localProjectRole` is non-null) answers 409 `projectAgents.alreadyAssigned`. Otherwise the service creates a `viewer` binding in the project, granted by the adding user. The response is the new row as `findProjectRoster` answers it.
- **Two readings, on purpose.** An agent whose only source is a global project binding passes the access checks (`isOnProjectRoster`, so pickup and `PATCH /projects/:slug/agents/:agentSlug`; `/agents/me`) but is not listed by `findProjectRoster` and cannot be removed through the roster route, which use local sources.
- **Remove** (`removeFromProject`). An agent without a local source (`hasLocalMembership` false) answers 404 `projectAgents`. The open-ticket refusal (409 `projectAgents.hasOpenTickets`) is unchanged. Otherwise the service calls `removeProjectBindings(agent, projectId)` and the existing `removeFromProjectRoster`, which deletes the legacy row if there is one.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| A compatibility query for an id that names no row | Answers no sources (`null`, `false`, `[]`, `0`); never throws |
| A capped listing query returns `MEMBERSHIP_READ_CAP` rows | Logs a warning naming the function and the project or principal; returns the capped result |
| Adding a member who already has a local source | 409 `ConflictAppException` `members`; nothing written |
| Inviting an existing user who already has a local source | 409 `ConflictAppException` `invites.memberExists`; nothing written |
| Adding an agent that already has a local source | 409 `ConflictAppException` `projectAgents.alreadyAssigned`; nothing written |
| Updating or removing a user with no local source | 404 `NotFoundAppException` `members` |
| Removing an agent with no local source | 404 `NotFoundAppException` `projectAgents` |
| Demoting or removing the last active project admin (caller not a global admin) | 409 `ConflictAppException` `members.lastAdmin`; nothing changed |
| Two concurrent adds of the same user to one project | Serialized by `lockMembers`; one answers 201, the other 409 `members`; one binding exists |
| Two concurrent invites adding the same existing user to one project | Serialized by the members lock; one answers 201 ADDED, the other 409 `invites.memberExists`; one binding and one MEMBER_ADDED schedule exist |
| Two concurrent roster adds of the same agent to one project | Serialized by `lockProjectAgents`; one answers 201, the other 409 `projectAgents.alreadyAssigned`; one binding exists |
| A rejected invite acceptance (account exists, used token) | Its transaction rolls back; no user, no binding |

### Integration

Symbols this feature **reads** (verified at `32d31212`):
- `MembershipService.createBinding`, `bindBaseline`, `afterCommit` and `PermissionService.can` — `apps/api/src/permissions/`
- `PrincipalRef`, `PrincipalType` — `apps/api/src/permissions/permissions.types.ts`
- `SystemRoleSeeder` — `apps/api/src/permissions/system-role.seeder.ts`
- `lockProjectMembers`, `lockProjectAgents` — `apps/api/src/common/utils/advisory-lock.ts` (the pattern the queries file follows)
- `ProjectAccessService`, `withProjectRole`, `mayDispatch` — unchanged; they consume the repository methods below

Symbols this feature **changes**. The baseline only locates the code; implement the target.

| Symbol | Baseline (locate only) | Target |
|:--|:--|:--|
| `MembershipService` | binding writes and reads | plus `removeProjectBindings` |
| `PrismaRoleBindingRepository` | ends at `deleteForPrincipal` and the user/owner locks | plus `deleteProjectBindings(principal, projectId, roleKeys?)`: deletes the principal's bindings with that `projectId`, filtered by the roles' keys when given, and returns the count |
| `permissions.types.ts` | no membership listing type | plus `ProjectMembership` |
| The readers in "Readers moved to the compatibility queries" | read `ProjectMember` / `AgentProject` | read through the queries; same signatures |
| `ProjectMembersService` (`projects/members/project-members.service.ts`) | `(membersRepo, access, txManager)` | `(membersRepo, access, txManager, membership)`; writes as in "Members" |
| `PrismaProjectMembersRepository` | legacy `findMemberPage`, `findMember`, `countProjectAdmins` | the same methods over the queries, plus `deleteMemberIfPresent(projectId, userId)` |
| `ProjectInvitesService` (`projects/invites/project-invites.service.ts`) | seven constructor parameters | `MembershipService` appended as the eighth; `addExistingUser` as in "Invites" |
| `PrismaProjectInvitesMembersRepository` | `createMember`; `findUserState` returns id, email, disabled | plus `findLocalRole(projectId, userId)` and `lockMembers(projectId)`; `findUserState` also returns `name` |
| `InviteAcceptanceService` (`projects/invites/invite-acceptance.service.ts`) | `(invites, members, auth, txManager)` | `MembershipService` appended as the fifth; `accept` as in "Invites" |
| `AgentsService.addToProject`, `removeFromProject` | `AgentProject` writes and the `isOnProjectRoster` check | as in "Agent roster" |
| `PrismaAgentRepository` | `findProjectRoster`, `isOnProjectRoster`, `findRosterProjects` over `AgentProject` | the same methods over the queries, plus `hasLocalMembership(agentId, projectId)` |
| `mockMembershipService` (`common/test-helpers/global-stubs.module.ts`) | stubs the P1a methods | also stubs `removeProjectBindings` |

## Out of Scope

- Moving any route, guard or tool check onto permission keys is out of scope (`permissions-p1-enforce-core`, `permissions-p1-enforce-fleet`). The CASL factory, `@ProjectPermission`, `@ProjectRoles`, `exemptAgents` and the tool `permission.kind` are unchanged.
- Deriving an agent's legacy `agentRoles` from bindings is out of scope. A project or global binding gives an agent project access in this feature, but its keys take effect only when `permissions-p1-enforce-core` moves the checks onto `PermissionService`. `AgentAuthProvider` keeps reading `AgentRoleEntry`, so invalidating the `AGENT:<id>` principal cache on binding writes is not needed.
- Changing `PATCH /agents/:slug/update-roles` is out of scope (ruling 2026-10-19). It keeps writing `AgentRoleEntry`.
- Changing the member, invite or roster request and response contracts is out of scope. The routes keep taking `ADMIN`, `DEVELOPER` and `VIEWER`. Invites carrying a `roleId`, and binding any other PROJECT role through these routes, are out of scope (`permissions-p1-cleanup` and `permissions-p1-web`; `/role-bindings` already binds any role).
- Deleting the legacy repository methods that stop being called (`PrismaProjectMembersRepository.createMember`, `updateMemberRole`, `deleteMember`, `PrismaProjectInvitesMembersRepository.createMember`, `PrismaAgentRepository.addToProjectRoster`), deleting `legacy-membership.queries.ts`, and dropping `ProjectMember`, `AgentProject`, `AgentRoleEntry`, `User.role` or `ProjectInvite.role`, is out of scope (`permissions-p1-cleanup`).
- Reading the JWT `role` claim from bindings on every request is out of scope (`permissions-p1-cleanup`). The `User.role` mirror and token revocation from `permissions-p1-roles` keep the claim correct.
- Copying legacy rows into bindings is out of scope (no data migration).
- Serializing a binding removal made through `DELETE /role-bindings/:id` with ticket assignment (the `lockProjectAgents` lock) is out of scope. Only the roster route takes that lock.
- Caching the compatibility queries is out of scope; they run on every call, as the legacy reads do.
- US-001 only: a test that fills a source past `MEMBERSHIP_READ_CAP` is out of scope. The cap is a safety bound, and its warning is checked by review.
- US-006 only: a new AC for a rejected invite acceptance writing no binding is out of scope. The binding write sits inside the acceptance transaction, and the existing rejected-acceptance tests in `project-invites-public.integration.spec.ts` are extended to count `RoleBinding` rows (see Modifies).
- US-006 only: a test that the permission cache is invalidated after the route's transaction commits, not before, is out of scope. The routes wrap their transactions in `MembershipService.afterCommit`, and `MembershipService` logs an error when a binding write runs inside an unwrapped transaction.
- US-007 only: a test that the permission cache is invalidated after the roster route's transaction commits, not before, is out of scope, for the same reason.
- Web changes are out of scope (`permissions-p1-web`).
- US-001 only: an AC for each query's unknown-id answer is out of scope beyond `agentHasProjectAccess` (US-001 AC 7). The other queries share its source lookups.
- US-006 only: new ACs for the last-admin rule on `DELETE` and for the global-admin exemption are out of scope. `project-members.integration.spec.ts` already covers both over HTTP and keeps passing, because the rule's inputs now come from the same union.
- US-006 only: a separate AC for adding a member who has only a legacy `ProjectMember` row is out of scope. `findMember` reads the same union for both kinds of local source, and AC 3 pins the 409.
- US-006 only: new `endpoint.e2e.spec.ts` cases are out of scope. The member and invite routes keep their contracts.
- US-007 only: new `endpoint.e2e.spec.ts` cases are out of scope. The roster routes keep their contracts; only the existing roster cases' row assertions change (see Modifies).

## Stories

1. **US-001: Compatibility queries and project binding removal** — `Workdir: apps/api` — No dependencies. Adds `legacy-project-roles.ts` (`LegacyProjectRole`, `ROLE_KEY_FOR_LEGACY_ROLE`, `legacyRoleForRoleKey`, `strongestProjectRole`), `legacy-membership.queries.ts` (the seven queries and `MEMBERSHIP_READ_CAP`), the `ProjectMembership` type, `MembershipService.removeProjectBindings`, and its `GlobalStubsModule` stub.
2. **US-002: Project access and project lists read bindings** — `Workdir: apps/api` — Depends on US-001. Moves `PrismaProjectRepository.findMembershipRole`, `isAgentOnRoster`, `findAllForUser` and `findAllForAgent`, and `PrismaHomeRepository.findProjects`, onto the queries.
3. **US-003: Ticket assignment, assignee search and the domain writer read bindings** — `Workdir: apps/api` — Depends on US-001. Moves `PrismaTicketsRepository.findProjectMemberRole` and `isAgentOnProjectRoster`, `PrismaProjectAssigneesRepository.search` and `PrismaKodaDomainWriterRepository.findUserProjectRoles` onto the queries.
4. **US-004: Fleet activity scoping and schedule owners read bindings** — `Workdir: apps/api` — Depends on US-001. Moves `PrismaFleetActivityRepository.findMemberProjectIds` and `PrismaScheduleRepository.findOwnerAccess` onto the queries.
5. **US-005: Notifications, mentions and the member-added email read bindings** — `Workdir: apps/api` — Depends on US-001. Moves `NotificationEligibility`, `TicketMentionResolver` and `EmailContentBuilder` (MEMBER_ADDED) onto the queries.
6. **US-006: Member and invite routes write bindings** — `Workdir: apps/api` — Depends on US-001, US-002. (US-002 makes a caller whose project admin role is a binding pass `assertProjectAdmin`, which AC 8 relies on, and makes a removed member fail the project routes, which AC 9 relies on.) Rewrites the members repository reads, the `ProjectMembersService` writes, `ProjectInvitesService.addExistingUser` and `InviteAcceptanceService.accept` onto bindings.
7. **US-007: Agent roster routes and agent reach read and write bindings** — `Workdir: apps/api` — Depends on US-001, US-002. (US-002 makes a binding-only agent pass the project routes, which AC 6 relies on.) Moves `PrismaAgentRepository.findProjectRoster`, `isOnProjectRoster` and `findRosterProjects` onto the queries, adds `hasLocalMembership`, and rewrites `addToProject` and `removeFromProject` onto bindings.

### Context Files

**US-001**
- `apps/api/src/permissions/membership.service.ts` — the service extended here, and its `afterWrite` and `afterCommit` pattern
- `apps/api/src/permissions/prisma-role-binding.repository.ts` — how bindings and roles are queried today
- `apps/api/src/permissions/permissions.types.ts` — `PrincipalRef`, `PrincipalType`
- `apps/api/src/common/utils/advisory-lock.ts` — the "Prisma client as first argument" helper pattern
- `apps/api/src/common/test-helpers/global-stubs.module.ts` — `mockMembershipService`

**US-002**
- `apps/api/src/projects/prisma-project.repository.ts` — the four reads moved here
- `apps/api/src/projects/project-access.service.ts` — the consumer of `findMembershipRole` and `isAgentOnRoster` (unchanged)
- `apps/api/src/projects/projects.service.ts` — the consumer of `findAllForUser` and `findAllForAgent` (unchanged)
- `apps/api/src/home/prisma-home.repository.ts` — `findProjects`
- `apps/api/src/permissions/legacy-membership.queries.ts` — created by US-001, used here

**US-003**
- `apps/api/src/tickets/prisma-tickets.repository.ts` — `findProjectMemberRole`, `isAgentOnProjectRoster`
- `apps/api/src/tickets/tickets.service.ts` — the assign checks that call them (unchanged)
- `apps/api/src/projects/assignees/prisma-project-assignees.repository.ts` — `search`
- `apps/api/src/koda-domain-writer/prisma-koda-domain-writer.repository.ts` — `findUserProjectRoles`
- `apps/api/src/permissions/legacy-membership.queries.ts` — created by US-001, used here

**US-004**
- `apps/api/src/fleet/activity/prisma-fleet-activity.repository.ts` — `findMemberProjectIds`
- `apps/api/src/fleet/schedules/prisma-schedule.repository.ts` — `findOwnerAccess`
- `apps/api/src/fleet/schedules/schedule-access.ts` — `mayDispatch` (unchanged)
- `apps/api/src/fleet/schedules/schedule-ticker.ts` — `dispatchFresh` (unchanged)
- `apps/api/src/permissions/legacy-membership.queries.ts` — created by US-001, used here

**US-005**
- `apps/api/src/notifications/notification-eligibility.ts` — `filter`
- `apps/api/src/notifications/ticket-mention.resolver.ts` — `mentionedUserIds`
- `apps/api/src/email/email-content.builder.ts` — `buildMemberAdded`
- `apps/api/src/notifications/notification-writer.ts` — `deliver`, the entry point the ACs use (unchanged)
- `apps/api/src/permissions/legacy-membership.queries.ts` — created by US-001, used here

**US-006**
- `apps/api/src/projects/members/project-members.service.ts` — the member routes' service
- `apps/api/src/projects/members/prisma-project-members.repository.ts` — the members repository
- `apps/api/src/projects/invites/project-invites.service.ts` — `addExistingUser`
- `apps/api/src/projects/invites/invite-acceptance.service.ts` — `accept`
- `apps/api/src/projects/invites/prisma-project-invites-members.repository.ts` — the invite-side membership reads and user writes

**US-007**
- `apps/api/src/agents/agents.service.ts` — `addToProject`, `removeFromProject`, `isOnProjectRosterBySlug`, `suggestTicket`, `findMe`
- `apps/api/src/agents/prisma-agent.repository.ts` — the roster reads and writes
- `apps/api/src/agents/dto/project-agent.dto.ts` — the roster row shape
- `apps/api/src/permissions/legacy-membership.queries.ts` — created by US-001, used here

### Creates

**US-001**
- `apps/api/src/permissions/legacy-project-roles.ts`
- `apps/api/src/permissions/legacy-membership.queries.ts`

### Modifies

**US-001**
- `apps/api/src/common/test-helpers/global-stubs.module.ts` — mockMembershipService gains a removeProjectBindings stub that resolves 0. The invariant: every module spec that imports GlobalStubsModule compiles and inits; mockPrismaService gains no roleBinding delegate, because module specs only init and never reach a moved reader.
- `apps/api/src/permissions/test-helpers/in-memory-permissions.ts` — the repository double membership.service.spec uses gains an in-memory deleteProjectBindings, because removeProjectBindings calls it. The invariant: the existing MembershipService unit assertions are unchanged.

**US-002**
None. The four project-repository reads and `findProjects` keep their signatures and return types, so the specs that stub them (`project-access.service.spec.ts`, the guard specs, `projects.service.spec.ts`, `test/unit/projects/*`) are unaffected. The DB-backed specs create legacy rows, which the union still reads, and `projects-brief.routes.spec.ts` (real repository, mocked Prisma) calls as a global admin, which never reads membership.

**US-003**
- `apps/api/src/projects/assignees/prisma-project-assignees.repository.spec.ts` — it stubs prisma.client.projectMember.findMany and agentProject.findMany to drive search. The replacing invariant: the stubs drive the compatibility queries (roleBinding, projectMember and agentProject reads) instead, and search keeps its filters, its users-then-agents order and its limit.
- `apps/api/test/unit/koda-domain-writer/find-user-project-roles.spec.ts` — it stubs user.findUnique and projectMember.findUnique and expects exactly those reads. The replacing invariant: findUserProjectRoles still answers ['ADMIN'] for a global admin and the legacy row's role, plus the user's userProjectRole when non-null, de-duplicated, with the binding reads stubbed too; a user with a legacy AGENT row and a viewer binding answers both 'AGENT' and 'VIEWER'.
- `apps/api/test/unit/koda-domain-writer/koda-domain-writer-role-provenance.spec.ts` — its Prisma mock stubs projectMember.findUnique and findFirst only, and asserts they were not called for agent actors. The replacing invariant: the mock also stubs the binding reads the queries make, agent actors still trigger no membership read, and user actors' roles come from the union.
- `apps/api/test/integration/events/event-write-operations.integration.spec.ts` — its Prisma mock stubs projectMember only. The replacing invariant: the mock also answers the binding reads the queries make; event assertions are unchanged.

**US-004**
None. `findMemberProjectIds` and `findOwnerAccess` keep their signatures and return types, so the unit specs that stub them (`fleet-activity.service.spec.ts`, `approvals.service.spec.ts`, `schedules.service.spec.ts`, `schedule-ticker.spec.ts`) are unaffected, and `fleet-schedule-repository.integration.spec.ts` creates legacy rows, which the union still reads.

**US-005**
- `apps/api/src/notifications/notification-eligibility.spec.ts` — it stubs prisma.client.projectMember.findMany to decide membership. The replacing invariant: the stubs answer the compatibility queries' reads instead, and the asserted filtering (never the actor, never disabled or unknown users, members or global admins only for project drafts) is unchanged.
- `apps/api/src/notifications/ticket-mention.resolver.spec.ts` — it stubs user.findMany with a projectMemberships filter. The replacing invariant: membership comes from the compatibility queries' reads, global ADMINs still pass, and the result keeps the text's order.
- `apps/api/src/email/email-content.builder.spec.ts` — it stubs projectMember.findUnique for MEMBER_ADDED. The replacing invariant: the role comes from the compatibility queries' reads, and no source still skips with SOURCE_GONE.

**US-006**
- `apps/api/src/projects/members/project-members.service.spec.ts` — it constructs ProjectMembersService with three parameters and expects createMember, updateMemberRole and deleteMember calls. The replacing invariant: a MembershipService double is passed fourth; add calls its createBinding with the mapped role key, update and remove call its removeProjectBindings and the repository's deleteMemberIfPresent, and the last-admin and not-found outcomes are unchanged.
- `apps/api/src/projects/members/project-members.module.spec.ts` — its local FakeGlobalsModule lacks MembershipService, which ProjectMembersService now requires. The replacing invariant: the harness also provides a MembershipService double, and the module compiles.
- `apps/api/src/projects/invites/project-invites.service.spec.ts` — it expects addExistingUser to call members.createMember. The replacing invariant: a MembershipService double is passed eighth, addExistingUser calls its createBinding with the mapped role key, and a non-null findLocalRole answers 409 invites.memberExists.
- `apps/api/src/projects/invites/invite-acceptance.service.spec.ts` — it expects accept to call members.createMember. The replacing invariant: a MembershipService double is passed fifth, and accept calls its createBinding with the mapped role key and bindBaseline for the new user.
- `apps/api/test/integration/projects/project-invites-public.integration.spec.ts` — the accept happy-path test (US-005 AC-4) and the concurrent-accept test read the accepted user's ProjectMember row, and the rejected-acceptance tests count only ProjectMember rows. The replacing invariant: the accepted user holds exactly one RoleBinding in the invite's project, of the invite's mapped role, and no ProjectMember row, and each rejected acceptance leaves no RoleBinding for the invited address.
- `apps/api/test/integration/projects/project-invites-admin.integration.spec.ts` — its beforeAll adds members through POST /projects/:slug/members, and the ADDED and already-member tests read them with projectMember.findFirstOrThrow. The replacing invariant: the ADDED test asserts the user's developer RoleBinding in the project and no ProjectMember row, the already-member test finds its DEVELOPER member through a RoleBinding read, and the status and body assertions are unchanged.
- `apps/api/test/helpers/fleet-fixtures.ts` — seedFleetHttpWorld adds dev and viewer to project web through POST /api/projects/web/members, and thread-scope, workspace-create, workspace-turns, assistant-actions-approve and assistant-actions-decide integration specs then update or delete those ProjectMember rows. The replacing invariant: seedFleetHttpWorld creates the dev (DEVELOPER) and viewer (VIEWER) memberships as legacy ProjectMember rows through its prisma client, so those specs keep editing real rows, and the union still reads them.

**US-007**
- `apps/api/src/agents/agents-project-roster.service.spec.ts` — it stubs addToProjectRoster and isOnProjectRoster for add and remove. The replacing invariant: hasLocalMembership decides the 409 and 404 outcomes, add calls the MembershipService double's createBinding with roleKey viewer, remove calls its removeProjectBindings and the repository's removeFromProjectRoster, and the asserted error codes are unchanged.
- `apps/api/src/agents/prisma-agent.repository.find-roster.spec.ts` — it stubs prisma.client.agentProject.findMany to drive findProjectRoster. The replacing invariant: the stubs answer the compatibility queries' reads, and findProjectRoster keeps its row shape, its name order and its open-ticket summary.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the roster cases assert AgentProject rows (and addedById) after POST and DELETE /projects/:slug/agents. The replacing invariant: those cases assert the agent's viewer RoleBinding in the project (grantedById the caller) instead, and the refused DELETE keeps it.

### Seams

- **US-001 → US-002..US-007:** each query added in US-001 is reached from a production entry point in the story that adopts it, and those ACs create a **binding-only** principal (no legacy row), so a test passes only when the entry point really reads the binding: US-002 ACs 1, 2, 6, 8, 9, 10, 11, 13 and 14; US-003 ACs 1, 3, 5, 6 and 8; US-004 ACs 1, 2, 3 and 5; US-005 ACs 1, 3, 4 and 6; US-006 ACs 5 and 8; US-007 ACs 2, 5, 10 and 12.
- **US-001 → US-006, US-007:** `MembershipService.removeProjectBindings` is reached from `DELETE` and `PATCH /projects/:slug/members/:userId` (US-006 ACs 6 and 9) and `DELETE /projects/:slug/agents/:agentSlug` (US-007 ACs 6 and 7).
- **Union preserved:** US-002, US-003 and US-007 each keep at least one AC whose principal has only a **legacy row** (US-002 AC 5; US-003 AC 7; US-007 AC 4), and US-006 AC 7 updates a legacy-row member. US-004 and US-005 rely on the unchanged DB-backed specs that seed legacy rows (`fleet-schedule-repository.integration.spec.ts`, the notification and email integration specs).
- **Altitude note.** The US-001 queries have no production caller until US-002..US-007, so US-001 tests them directly against the database, and the route- and entry-point-level ACs in the later stories cover the wiring. US-005 enters at `NotificationWriter.deliver` (the only notification insert path), `EmailContentBuilder.build` (what the email processor calls per row) and `TicketMentionResolver.mentionedUserIds` (whose ticket subscriber callers are unchanged).

## Acceptance Criteria

### US-001: Compatibility queries and project binding removal (`Workdir: apps/api`)

1. [unit] `legacyRoleForRoleKey` from `apps/api/src/permissions/legacy-project-roles.ts` returns `'ADMIN'` for `project-admin`, `'DEVELOPER'` for `developer`, and `'VIEWER'` for each of `viewer`, `reviewer` and `qa-lead`.
2. [unit] `strongestProjectRole(['VIEWER', 'ADMIN', 'DEVELOPER'])` returns `'ADMIN'`, `strongestProjectRole(['AGENT', 'VIEWER'])` returns `'VIEWER'`, and `strongestProjectRole([])` returns `null`.
3. [integration] For a user whose only source in project `p1` is a `developer` binding (no `ProjectMember` row), `userProjectRole(prisma.client, <user id>, p1)` from `legacy-membership.queries.ts` resolves `'DEVELOPER'`.
4. [integration] For a user with a legacy `ProjectMember` row of role `VIEWER` in `p1` and a `project-admin` binding in `p1`, `userProjectRole(prisma.client, <user id>, p1)` resolves `'ADMIN'`.
5. [integration] For a user whose only binding is a `projectId`-null `reviewer` binding, `userProjectRole(prisma.client, <user id>, p2)` resolves `'VIEWER'` for a project `p2` it has no other source in, and `localProjectRole(prisma.client, { type: 'USER', id: <user id> }, p2)` resolves `null`.
6. [integration] For a user whose only binding is a `projectId`-null `admin` binding, `userProjectRole(prisma.client, <user id>, p1)` resolves `null`.
7. [integration] For an agent whose only source is a `viewer` binding in `p1`, `agentHasProjectAccess(prisma.client, <agent id>, p1)` resolves `true`, and `agentHasProjectAccess(prisma.client, <agent id>, 'no-such-project')` resolves `false`.
8. [integration] For an agent with a legacy `AgentProject` row in `p1`, a `viewer` binding in `p2`, and a `viewer` binding in a soft-deleted project `p3`, `accessibleProjectIds(prisma.client, { type: 'AGENT', id: <agent id> })` resolves exactly `[p1, p2]` in ascending order.
9. [integration] For a user with a `projectId`-null `developer` binding, `accessibleProjectIds(prisma.client, { type: 'USER', id: <user id> })` resolves the ids of every non-deleted project.
10. [integration] `principalIdsWithAccess(prisma.client, p1, 'USER')` resolves exactly the ids of: a user with a legacy row in `p1`, a user with a binding in `p1`, and a user with a `projectId`-null `viewer` binding. It excludes a user whose only binding is a `projectId`-null `admin` binding and a user bound only in `p2`.
11. [integration] For an agent with a legacy `AgentProject` row in `p1` (`createdAt` `t1`, `addedById` `u1`) and a later `viewer` binding in `p1`, `listProjectMemberships(prisma.client, p1, 'AGENT')` returns one entry for it with `since` `t1`, `addedByUserId` `u1` and `role` `'VIEWER'`, and returns no entry for an agent whose only binding is `projectId`-null.
12. [integration] In `p1`, with user `a` holding a legacy `ADMIN` row, user `b` holding a `project-admin` binding, user `c` holding both, and disabled user `d` holding a `project-admin` binding, `countActiveProjectAdmins(prisma.client, p1)` resolves `3`.
13. [integration] For a user with `developer` and `reviewer` bindings in `p1`, a `developer` binding in `p2` and a legacy row in `p1`, `MembershipService.removeProjectBindings({ type: 'USER', id: <user id> }, p1, ['developer'])` resolves `1`. Afterwards the user still holds the `reviewer` binding in `p1`, the `developer` binding in `p2` and the legacy row.
14. [integration] For a user whose only source in `p1` is a `developer` binding, after `PermissionService.can(<user principal>, 'ticket.create', { projectId: p1 })` answered `allowed` true, `MembershipService.removeProjectBindings({ type: 'USER', id: <user id> }, p1)` makes the next identical `can` call answer `allowed` false.

### US-002: Project access and project lists read bindings (`Workdir: apps/api`)

1. [integration] A user whose only source in project `p1` is a `developer` binding gets 200 from `GET /projects/p1/tickets`.
2. [integration] The same user gets 201 from `POST /projects/p1/tickets`, so the request carried project role `DEVELOPER` into the ticket create check.
3. [integration] A user whose only source in `p1` is a `viewer` binding gets 403 from `POST /projects/p1/tickets`.
4. [integration] A non-admin user with no source in `p1` gets 403 from `GET /projects/p1/tickets`.
5. [integration] A user whose only source in `p1` is a legacy `ProjectMember` row of role `DEVELOPER` gets 200 from `GET /projects/p1/tickets`.
6. [integration] With agent project scoping on, an agent whose only source in `p1` is a `viewer` binding gets 200 from `GET /projects/p1/tickets`.
7. [integration] With agent project scoping on, an agent with no source in `p1` gets 403 from `GET /projects/p1/tickets`.
8. [integration] A user whose only source in `p1` is a `projectId`-null `reviewer` binding gets 200 from `GET /projects/p1/tickets`.
9. [integration] A user whose only source in `p1` is a `project-admin` binding gets 200 from `GET /projects/p1/members` with `canManage` `true` and `viewerRole` `'ADMIN'`.
10. [integration] For a non-admin user with a `developer` binding in `p1`, a legacy row in `p2` and no source in `p3`, `GET /projects` lists exactly `p1` and `p2`.
11. [integration] With agent project scoping on, for an agent with a `projectId`-null `developer` binding, `GET /projects` lists every non-deleted project.
12. [integration] With agent project scoping off, an agent with no source in any project gets every non-deleted project from `GET /projects`.
13. [integration] For a non-admin user whose only source in `p1` is a `developer` binding, `GET /home` includes `p1` in its projects.
14. [integration] A user whose only source in `p1` is a `project-admin` binding gets 200 from `PATCH /projects/p1/agents/<agent slug>` for an agent with a legacy `AgentProject` row in `p1`.

### US-003: Ticket assignment, assignee search and the domain writer read bindings (`Workdir: apps/api`)

1. [integration] `POST /projects/p1/tickets/<ref>/assign` with `{ userId }` for an enabled user whose only source in `p1` is a `developer` binding answers 200, and the ticket's `assignedToUserId` is that user.
2. [integration] The same call for an enabled non-admin user with no source in `p1` answers 403.
3. [integration] `POST /projects/p1/tickets/<ref>/assign` with `{ agentId }` for an ACTIVE agent whose only source in `p1` is a `viewer` binding answers 200, and the ticket's `assignedToAgentId` is that agent.
4. [integration] The same call for an ACTIVE agent with no source in `p1` answers 409 with error code `tickets.agentNotInProject`.
5. [integration] `GET /projects/p1/assignees` returns, among its items, a `type: 'user'` item for an enabled user whose only source in `p1` is a `developer` binding, and a `type: 'agent'` item for an ACTIVE agent whose only source in `p1` is a `viewer` binding.
6. [integration] `GET /projects/p1/assignees` returns a `type: 'user'` item for an enabled user whose only source is a `projectId`-null `viewer` binding, and no item for a disabled user whose only source in `p1` is a `developer` binding.
7. [integration] `GET /projects/p1/assignees` returns a `type: 'user'` item for an enabled user whose only source in `p1` is a legacy `ProjectMember` row.
8. [integration] `KodaDomainWriter.writeTicketEvent` with a user actor whose only source in `p1` is a `developer` binding records the ticket event and answers its `canonicalId`.
9. [integration] `KodaDomainWriter.writeTicketEvent` with a user actor whose only source in `p1` is a `viewer` binding rejects with `ForbiddenAppException` and records no event.

### US-004: Fleet activity scoping and schedule owners read bindings (`Workdir: apps/api`)

1. [integration] For a non-admin user whose only source in `p1` is a `developer` binding and who has no source in `p2`, `GET /fleet/activity` returns the activity rows of `p1` and none of `p2`.
2. [integration] For the same user, `GET /fleet/approval-counts` counts `p1`'s pending approvals and not `p2`'s.
3. [integration] `POST /projects/p1/fleet/schedules/<id>/enable` for a disabled schedule whose owner's only source in `p1` is a `developer` binding answers 200, and the schedule is enabled.
4. [integration] The same call for a schedule whose owner's only source in `p1` is a `viewer` binding answers 409 with error code `fleet.scheduleOwnerNoAccess`.
5. [integration] A `ScheduleTicker` tick over a due schedule whose owner's only source in `p1` is a `developer` binding dispatches a job for the schedule.
6. [integration] A `ScheduleTicker` tick over a due schedule whose owner's only source in `p1` is a `viewer` binding dispatches no job and disables the schedule with reason `owner_lost_access`.

### US-005: Notifications, mentions and the member-added email read bindings (`Workdir: apps/api`)

1. [integration] `NotificationWriter.deliver` with a draft for project `p1` addressed to an enabled user whose only source in `p1` is a `developer` binding inserts a `Notification` row for that user.
2. [integration] `NotificationWriter.deliver` with drafts for project `p1` inserts no `Notification` row for an enabled non-admin user with no source in `p1`, and inserts one for an enabled global `ADMIN` user with no source in `p1`.
3. [integration] `NotificationWriter.deliver` with a draft for project `p1` addressed to an enabled user whose only source is a `projectId`-null `viewer` binding inserts a `Notification` row for that user.
4. [integration] `TicketMentionResolver.mentionedUserIds(p1, text)`, where `text` mentions an enabled user whose only source in `p1` is a `developer` binding, returns that user's id.
5. [integration] `TicketMentionResolver.mentionedUserIds(p1, text)`, where `text` mentions an enabled non-admin user with no source in `p1`, returns an empty list.
6. [integration] `EmailContentBuilder.build` of a `MEMBER_ADDED` email row for a user whose only source in `p1` is a `developer` binding answers template data whose `role` is `'DEVELOPER'`.
7. [integration] `EmailContentBuilder.build` of a `MEMBER_ADDED` email row for a user with no source in `p1` answers `skip` `'SOURCE_GONE'`.

### US-006: Member and invite routes write bindings (`Workdir: apps/api`)

1. [integration] `POST /projects/p1/members` with `{ email, role: 'DEVELOPER' }` by a project admin answers 201 with `role` `'DEVELOPER'`. Afterwards the user holds a `developer` binding in `p1` with `grantedByType` `'USER'` and `grantedById` the caller's id, and has no `ProjectMember` row in `p1`.
2. [integration] `POST /projects/p1/members` with `{ email }` and no `role` creates a `viewer` binding in `p1`.
3. [integration] `POST /projects/p1/members` for a user who already holds a binding in `p1` answers 409 with error code `members`, and no binding is added.
4. [integration] Two concurrent `POST /projects/p1/invites` calls adding the same existing active user with no source in `p1` answer one 201 (outcome `ADDED`) and one 409 (`invites.memberExists`), and the user holds exactly one binding in `p1`, and, when email scheduling is configured, exactly one MEMBER_ADDED email schedule exists for that user and project.
5. [integration] Called by a global admin with no source in `p1`, `GET /projects/p1/members` for a project whose only members are a user added through `POST /projects/p1/members` and a user with a legacy `ProjectMember` row lists exactly those two, ordered by `joinedAt` ascending, with `total` `2`.
6. [integration] `PATCH /projects/p1/members/<user id>` with `{ role: 'ADMIN' }` for a user holding `developer` and `reviewer` bindings in `p1` answers 200 with `role` `'ADMIN'`. Afterwards the user's bindings in `p1` are exactly `project-admin` and `reviewer`.
7. [integration] `PATCH /projects/p1/members/<user id>` with `{ role: 'VIEWER' }` for a user with a legacy `DEVELOPER` row in `p1` deletes that row and leaves the user holding a `viewer` binding in `p1`.
8. [integration] When the caller is the only active project admin of `p1` (through a `project-admin` binding) and not a global admin, `PATCH /projects/p1/members/<caller id>` with `{ role: 'DEVELOPER' }` answers 409 with error code `members.lastAdmin`, and the caller keeps the `project-admin` binding.
9. [integration] `DELETE /projects/p1/members/<user id>` for a user with a legacy row and `developer` and `reviewer` bindings in `p1` answers 200. Afterwards the user has no binding and no legacy row in `p1`, and gets 403 from `GET /projects/p1/tickets`.
10. [integration] `DELETE /projects/p1/members/<user id>` for a user with no local source in `p1` answers 404 with error code `members`.
11. [integration] `POST /projects/p1/invites` with `{ email, role: 'DEVELOPER' }` by a project admin, for an existing active user with no source in `p1`, answers outcome `ADDED` with `member.email` the user's email and `member.role` `'DEVELOPER'`. Afterwards the user holds a `developer` binding in `p1` with `grantedById` the caller's id, and no `ProjectMember` row.
12. [integration] `POST /projects/p1/invites` for an existing active user who holds a binding in `p1` answers 409 with error code `invites.memberExists`.
13. [integration] `POST /invites/<token>/accept` for a pending `DEVELOPER` invite to `p1` answers 201. The new user holds a `developer` binding in `p1` with `grantedByType` `'SYSTEM'` and `grantedById` `'invite'`, and a `projectId`-null `member` binding.
14. [integration] `PATCH /projects/p1/members/<user id>` with `{ role: 'DEVELOPER' }` for a user with no local source in `p1` answers 404 with error code `members`.
15. [integration] Two concurrent `POST /projects/p1/members` calls for the same user answer one 201 and one 409 (`members`), and the user holds exactly one binding in `p1`.

### US-007: Agent roster routes and agent reach read and write bindings (`Workdir: apps/api`)

1. [integration] `POST /projects/p1/agents` with `{ agentSlug }` by a project admin answers 201 with that `slug`. Afterwards the agent holds a `viewer` binding in `p1` with `grantedById` the caller's id, and has no `AgentProject` row in `p1`.
2. [integration] After that add, `GET /projects/p1/agents` returns an item for the agent whose `addedBy.id` is the caller's id and `addedBy.name` the caller's name.
3. [integration] A second `POST /projects/p1/agents` for the same agent answers 409 with error code `projectAgents.alreadyAssigned`.
4. [integration] `POST /projects/p1/agents` for an agent with a legacy `AgentProject` row in `p1` answers 409 with error code `projectAgents.alreadyAssigned`.
5. [integration] `GET /projects/p1/agents` lists an agent added through `POST /projects/p1/agents` and an agent with a legacy `AgentProject` row, ordered by name ascending, and does not list an agent whose only binding is a `projectId`-null `developer` binding.
6. [integration] `DELETE /projects/p1/agents/<agent slug>` for an agent added through `POST /projects/p1/agents` with no open tickets answers 204. Afterwards the agent has no binding in `p1` and, with agent project scoping on, gets 403 from `GET /projects/p1/tickets`.
7. [integration] `DELETE /projects/p1/agents/<agent slug>` for an agent with a legacy `AgentProject` row and a `viewer` binding in `p1` answers 204 and removes both.
8. [integration] `DELETE /projects/p1/agents/<agent slug>` for an agent added through `POST /projects/p1/agents` that holds an open ticket in `p1` answers 409 with error code `projectAgents.hasOpenTickets`, and the agent keeps its `viewer` binding.
9. [integration] `DELETE /projects/p1/agents/<agent slug>` for an agent with no local source in `p1` answers 404 with error code `projectAgents`.
10. [integration] With agent project scoping on, `GET /agents/<slug>/pickup?project=p1` for an agent whose only source in `p1` is a `viewer` binding answers 200.
11. [integration] With agent project scoping on, `GET /agents/<slug>/pickup?project=p1` for an agent with no source in `p1` answers 403.
12. [integration] `GET /agents/me` for an agent with a `viewer` binding in `p-beta` and a legacy `AgentProject` row in `p-alpha` lists `projects` exactly `p-alpha` then `p-beta`.
13. [integration] Two concurrent `POST /projects/p1/agents` calls for the same agent answer one 201 and one 409 (`projectAgents.alreadyAssigned`), and the agent holds exactly one binding in `p1`.
