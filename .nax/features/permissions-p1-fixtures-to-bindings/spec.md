# SPEC: Permissions P1i — Test Fixtures Grant Through Role Bindings

## Summary

This feature moves the `apps/api` test fixtures that grant access through legacy rows onto role bindings. It changes no production behaviour:
- **One fixture module.** `apps/api/src/permissions/test-helpers/permission-fixtures.ts` seeds the system roles into a bare test database, grants and revokes roles by key, writes a principal's baseline binding, and reports what legacy rows still stand behind a principal.
- **DB fixtures stop writing legacy grants.** Every integration and e2e spec, the shared `test/helpers/fleet-fixtures.ts` and `prisma/seed-e2e.ts` that insert a `ProjectMember`, `AgentProject` or `AgentRoleEntry` row, or a `User.role = 'ADMIN'` user, to give an actor access, write the equivalent binding instead.
- **Direct principals get their baseline.** A user or agent a permission-deciding spec creates straight through Prisma gets the global `member` or `agent` binding that production writes on creation, instead of relying on the baseline fallback in `PermissionService`.
- **Unit doubles stop deciding on legacy state.** Five unit specs whose permission double grants on `principal.role === 'ADMIN'` or on `InMemoryPermissionStore.addUser(id, 'ADMIN')` grant on bindings or held keys instead.
- **A sentinel test per converted spec** asserts that its fixture principals hold no legacy grant, hold a global binding, and hold no global binding of a PROJECT-scope role.

This is the ninth feature implementing phase P1 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md`. The order is: roles (PR #308), membership (PR #310), enforce-core (PR #313), enforce-fleet (PR #314), enforce-assistant (PR #315), enforce-integrations (PR #316), then cleanup, split 2026-10-21 into four features: contract-tests (PR #317), retire-checks (PR #318), **fixtures-to-bindings** and drop-legacy. `permissions-p1-web` runs in parallel and must land before drop-legacy.

## Motivation

drop-legacy removes the legacy union (`PermissionService.computeKeys` reading `findLegacyRoleKeys` and `isLegacyAdmin`), the baseline fallback, and the legacy tables and columns. About fifty DB-backed specs grant their actors through those rows today, and about forty create users or agents through Prisma without the baseline binding production writes. If drop-legacy carried that conversion as well, one branch would mix a schema drop with a rewrite of most of the integration suite, and a failing spec could not tell a lost grant from a real regression.

Converting the fixtures first, while the union still answers, keeps both features reviewable. After this feature, a converted spec passes only on bindings, and drop-legacy can remove the union without touching these specs.

**Rulings that bind this feature** (user, 2026-10-22):
- **Scope is DB fixtures and unit doubles.** Unit doubles convert only where the double decides on legacy state; a unit spec whose subject is legacy code stays.
- **Compat-layer specs stay.** Specs that test the union, the legacy queries or the migration of legacy rows are untouched; drop-legacy deletes them with their subject.
- **A legacy global admin becomes a global `admin` binding.** The fixture mirrors `User.role = 'ADMIN'` exactly as `MembershipService.setGlobalAdmin` does, so `User.role` readers that drop-legacy has not yet rewritten (notification eligibility, the mention resolver, the active-admin count) still see the admin.
- **No test-only union switch.** Nothing turns the union off for the converted specs. The sentinel test proves the fixtures write no legacy grant; drop-legacy is the final proof.
- **The baseline sweep covers the whole suite**, except the specs drop-legacy rewrites or deletes with their subject (the compat and live-reader lists under Out of Scope).
- **Six stories**, split by directory, all `Workdir: apps/api`.

## Design

### Rulings that bind every story

1. **Conventions carry over** from `.nax/features/permissions-p1-retire-checks/spec.md` ("Rulings that bind every story"). In particular, effective keys are cached (`PermissionCache`), so a spec that writes or deletes a binding directly **after** the principal's first permission check calls `MembershipService.invalidatePermissions()` before the next request, as the enforce-* suites already do. A grant written before the principal's first request needs no invalidation.
2. **Assertions stay; stale comments do not.** Comments that describe a converted fixture as legacy rows (for example "roster row and legacy roles") are updated with it. A converted spec keeps every existing assertion and its outcome. Only fixture setup, mid-test grant changes and the new sentinel test change. Where a spec asserts that production wrote **no** legacy row (for example `prisma.agentProject.count(...)` equal to 0 after an API call), that assertion stays: it pins production behaviour drop-legacy removes.
3. **Production code does not change.** The only non-test files this feature edits are `apps/api/src/permissions/test-helpers/permission-fixtures.ts` (new), `apps/api/prisma/seed-e2e-data.ts` (new) and `apps/api/prisma/seed-e2e.ts`.
4. **Paths** in this spec are relative to the repository root.
5. **Every principal a converted spec creates is covered.** A converted spec gives **every** user and agent it creates through Prisma its baseline with `grantBaseline`, and converts **every** legacy grant it writes, not only the ones its Modifies entry names as examples. A principal is exempt only where its Modifies entry says so, because the spec asserts that principal's exact bindings.
6. **Agents created through `POST /api/agents` as fixtures carry no roles.** Production still writes an `AgentRoleEntry` per `roles` item on that route, and the union reads those rows as project roles. A fixture agent is created with `roles: []` and gets each role as a project binding (conversion table). An agent whose `roles` the spec asserts in an API response (the agent API is the subject) keeps them, and its sentinel exempts its `AgentRoleEntry` rows; its access grants still convert.

### The fixture module (US-001)

`apps/api/src/permissions/test-helpers/permission-fixtures.ts` sits next to `in-memory-permissions.ts` and `permission-contract.ts`, so `test/`, `src/**/*.spec.ts` and `prisma/seed-e2e-data.ts` can all import it. It takes a Prisma client, never a Nest module.

```ts
import type { PrismaClient } from '../../generated/prisma/client';
import type { PrincipalRef } from '../permissions.types';

/** The client the helpers write through: a PrismaClient, or `PrismaService.client`. */
export type FixtureDb = PrismaClient;

/** Seeds the eleven system roles exactly as an API boot does (idempotent). */
export async function ensureSystemRoles(db: FixtureDb): Promise<void>;

/**
 * Binds `principal` to the role `roleKey` in `projectId` (null = global). Seeds the system roles first
 * when `roleKey` has no row. Idempotent: an existing identical binding is returned, not duplicated.
 * A global `owner`/`admin` binding of a USER also sets `User.role = 'ADMIN'`, the mirror
 * `MembershipService.setGlobalAdmin` keeps.
 */
export async function grantRole(
  db: FixtureDb,
  principal: PrincipalRef,
  roleKey: string,
  projectId?: string | null,
): Promise<{ id: string }>;

/**
 * The global binding production writes when it creates a principal: `member` (USER) or `agent` (AGENT).
 * Idempotent like `grantRole`: a principal production already baselined gets its existing binding back.
 */
export async function grantBaseline(db: FixtureDb, principal: PrincipalRef): Promise<{ id: string }>;

/** Deletes every binding of `principal` in `projectId`; answers how many it deleted. */
export async function revokeProjectRoles(db: FixtureDb, principal: PrincipalRef, projectId: string): Promise<number>;

/** What still stands behind a fixture principal outside its bindings. */
export interface FixtureGrantReport {
  /** ProjectMember rows (USER) or AgentProject rows (AGENT), +1 for an unmirrored `User.role = 'ADMIN'`. */
  legacyMemberships: number;
  /** AgentRoleEntry rows (AGENT); 0 for a USER. */
  agentRoleEntries: number;
  /** Holds at least one global (projectId null) binding. */
  hasGlobalBinding: boolean;
  /** Global bindings of a PROJECT-scope role (they apply in every project). */
  globalProjectRoleBindings: number;
}
export async function fixtureGrantReport(db: FixtureDb, principal: PrincipalRef): Promise<FixtureGrantReport>;

/** Principals whose spec deliberately pins one of the report's fields. */
export interface FixtureExemptions {
  /** May hold no global binding (the spec asserts its exact bindings). */
  noBaseline?: readonly PrincipalRef[];
  /** May hold global bindings of PROJECT-scope roles (the spec's subject is such a binding). */
  globalProjectRoles?: readonly PrincipalRef[];
  /** May keep AgentRoleEntry rows (the spec asserts the agent's `roles` in an API response). */
  agentRoleEntries?: readonly PrincipalRef[];
}

/**
 * The sentinel: resolves when every principal's report is clean (0, 0, true, 0) apart from its
 * exemptions; otherwise rejects with one Error naming each failing principal id and field.
 */
export async function expectBindingOnlyFixtures(
  db: FixtureDb,
  principals: readonly PrincipalRef[],
  exempt?: FixtureExemptions,
): Promise<void>;
```

Rules:
- `ensureSystemRoles` runs the production `SystemRoleSeeder` with `SYSTEM_ROLES` over a small adapter on `db.role` that implements the three methods the seeder calls (`findOne`, `createRole`, `update`) and is cast to `RoleRepository` (whose `IRepository` base declares more). The rows it writes therefore match what an API boot writes, and a later boot of the API over the same database changes nothing.
- `grantRole` writes `grantedByType: 'SYSTEM'`, `grantedById: 'test'`. An unknown `roleKey` (no row after seeding) rejects with `Error('no role <roleKey>')` and writes nothing.
- An "unmirrored" `User.role = 'ADMIN'` is one on a user with no global `owner` or `admin` binding: that is the state the union reads as a legacy admin. A mirrored admin (binding plus `User.role`) counts 0.
- The helpers do not call `MembershipService` and do not invalidate the permission cache (ruling 1).

### The conversion table

| Legacy fixture | Binding written instead |
|:---|:---|
| `ProjectMember { role: 'ADMIN' }` in project P | `grantRole(db, USER, 'project-admin', P)` |
| `ProjectMember { role: 'DEVELOPER' }` in P | `grantRole(db, USER, 'developer', P)` |
| `ProjectMember { role: 'VIEWER' }` (or any other value) in P | `grantRole(db, USER, 'viewer', P)` |
| `AgentProject` row in P | `grantRole(db, AGENT, 'viewer', P)` |
| `AgentRoleEntry { role: R }` for an agent with access to P | `grantRole(db, AGENT, <r>, P)` for each project P the fixture rosters it in, where `<r>` is `developer`, `reviewer`, `verifier` or `triager`; **never** a global binding |
| `POST /api/agents` with `roles: [R, ...]` for a fixture agent | the same request with `roles: []`, then the row above for each role in each project the fixture rosters the agent in; an agent rostered nowhere gets no role binding (its roles applied in no project, `AGENT_PROJECT_SCOPING` being on) |
| `User { role: 'ADMIN' }` | `grantRole(db, USER, 'admin', null)` (also mirrors `User.role`) |
| `projectMember.update` / `updateMany` to a new role mid-test | `revokeProjectRoles` + `grantRole` with the new key, then `invalidatePermissions()` |
| `projectMember.delete` / `deleteMany`, `agentProject.delete` mid-test | `revokeProjectRoles`, then `invalidatePermissions()` |
| any user or agent created through Prisma in a permission-deciding spec | `grantBaseline(db, principal)` right after the create |

The mapping is the one the union applies today (`apps/api/src/permissions/legacy-project-roles.ts` `ROLE_KEY_FOR_LEGACY_ROLE`, the `AGENT_ROSTER_ROLE` in `legacy-membership.queries.ts`), so every converted principal holds the same effective keys as before.

### The sentinel test

Each spec listed under US-002 to US-005 in Modifies, except `apps/api/test/helpers/fleet-fixtures.ts` and the seed files (US-002 AC 2-4 and US-005 AC 1-2 check those directly), gains one test named `fixtures grant through bindings only`. It calls

```ts
await expectBindingOnlyFixtures(db, principals, exempt);
```

where `principals` lists every user and agent the spec creates (directly, or through `seedFleetBase`, `seedFleetHttpWorld` or `seedFleetHttpAgent`), and `exempt` names only the principals the spec's Modifies entry exempts.

Placement: the sentinel is the first test after the setup that creates the principals (the first `it` of the `describe` whose `beforeAll` builds the fixtures), and it lists the principals that setup created. In a sequential lifecycle spec whose principals are created across tests, it runs where every listed principal still exists: in `endpoint.e2e.spec.ts` it is the last test and omits `temp-agent`, which the file deletes; in `agents.e2e.spec.ts` it is placed immediately before the `DELETE /api/agents/:slug` test. Such a spec already depends on its test order (`api-test-isolation.md`). A principal created inside a single test (for example the agent of `home-api`'s `403s an agent key` test) is not listed.

A principal a spec creates to be refused (an outsider) is included: it holds its baseline binding and nothing else. The test fails today (the fixtures write legacy rows and no baseline) and passes after conversion.

### The unit doubles (US-006)

| Spec | Today | After |
|:---|:---|:---|
| `apps/api/src/projects/project-membership.guard.spec.ts` | the `can` double answers the global `project.read` ask with `principal.role === 'ADMIN'` | it answers from a `globalReaders: Set<string>` of principal ids; AC4's global reader is a `role: 'MEMBER'` user in the set |
| `apps/api/src/projects/project-membership.guard.routes.spec.ts` | same | same; AC4's caller is a `role: 'MEMBER'` user in `globalReaders` |
| `apps/api/src/fleet/assistant/assistant-tool.executor.spec.ts` | AC-7 "a global ADMIN creator" sets `creator: { role: 'ADMIN' }` | the creator has `role: 'MEMBER'`; `access.resolveMembership` resolving `'ADMIN'` (the display role of a global reader) admits it |
| `apps/api/src/permissions/role-admin.service.spec.ts` | AC-22 gives `grantor-2` its global authority with `addUser('grantor-2', 'ADMIN')` | `addUser('grantor-2')` plus `store.bind({ type: 'USER', id: 'grantor-2' }, 'admin')` |

`InMemoryPermissionStore.addUser(id, role)` keeps its `role` parameter: the compat unit specs use it.

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| `grantRole` with a role key that has no row after seeding | rejects with `Error('no role <roleKey>')`, writes no binding |
| `grantRole` repeated with identical arguments | returns the existing binding's id, writes no second row |
| `grantRole` on a database whose `Role` table was truncated by `resetDb` | seeds the system roles, then binds |
| `revokeProjectRoles` for a principal with no binding in the project | returns 0, deletes nothing |
| `fixtureGrantReport` for an id with no user or agent row | reports `{ legacyMemberships: 0, agentRoleEntries: 0, hasGlobalBinding: false, globalProjectRoleBindings: 0 }` |
| `expectBindingOnlyFixtures` with a principal whose report is not clean and not exempt | rejects with one `Error` whose message names that principal's id and each failing field |
| `ensureSystemRoles` when a locked system role's permissions were edited | restores them from the seed, as the API boot does |

### Integration

Read-only symbols (verified on `b382beb2`):
- `SystemRoleSeeder` (`apps/api/src/permissions/system-role.seeder.ts`): `constructor(seeds: readonly RoleSeed[], roles: RoleRepository)`, `onApplicationBootstrap(): Promise<void>`; reads `roles.findOne({ key })`, writes `roles.createRole(...)` and `roles.update(id, patch)`.
- `SYSTEM_ROLES` (`apps/api/src/permissions/system-roles.ts`): GLOBAL `owner`, `admin`, `member`, `agent`; PROJECT `project-admin`, `developer`, `reviewer`, `verifier`, `triager`, `approver`, `viewer`.
- `RoleRepository` (`apps/api/src/permissions/permissions.types.ts`): `IRepository<RoleDomain>` plus `createRole(input: Omit<RoleDomain, 'id'>)`.
- `PrincipalRef` (`permissions.types.ts`): `{ type: 'USER' | 'AGENT'; id: string }`.
- `RoleBinding` (`apps/api/prisma/schema.prisma`): `principalType`, `principalId`, `roleId`, `projectId?`, `grantedByType`, `grantedById`; unique per `(principalType, principalId, roleId, projectId)` through two partial indexes (`apps/api/test/helpers/partial-indexes.ts`).
- `MembershipService.invalidatePermissions()` and `setGlobalAdmin` (the `User.role` mirror) in `apps/api/src/permissions/membership.service.ts`.
- `InMemoryPermissionStore.bind(principal, roleKey, projectId?)` (`apps/api/src/permissions/test-helpers/in-memory-permissions.ts`).
- `resetDb()` (`apps/api/test/helpers/reset-db.ts`) truncates every table, `Role` included.

Changed symbols:
- `seedFleetBase` (`apps/api/test/helpers/fleet-fixtures.ts`). Baseline: creates `User { role: 'ADMIN' }`. Target: creates the user with the default role, then `grantBaseline` and `grantRole(db, USER, 'admin', null)`.
- `seedFleetHttpWorld` (same file). Baseline: `prisma.projectMember.create` for dev (`DEVELOPER`) and viewer (`VIEWER`) on `web`. Target: `grantRole(prisma, USER, 'developer' | 'viewer', web.id)`, written before either user's first project request. Return shape unchanged.
- `seedFleetHttpAgent` (same file). Baseline: `POST /api/agents` with `roles: [...AGENT_ROLES]`, which writes four `AgentRoleEntry` rows. Target: the same request with `roles: []`; signature and return unchanged.
- `rosterFleetAgent(db, agentId, projectId)` (same file, new export). Grants the agent `viewer` plus `developer`, `reviewer`, `verifier` and `triager` in `projectId` through `grantRole`: exactly what a `seedFleetHttpAgent` agent with an `AgentProject` row in that project held before. The callers of `seedFleetHttpAgent` that write an `AgentProject` row call it instead.
- `prisma/seed-e2e.ts`. Baseline: a script that creates its `PrismaClient` at module level and runs an inline `main()` that creates an ADMIN user and a `ProjectMember` ADMIN row, and does not delete `RoleBinding` rows. Target: a thin runner whose `main()` creates the client and calls `seedE2e(client)` from `apps/api/prisma/seed-e2e-data.ts`, printing the same messages; `bun run seed:e2e` behaves as before. (`import.meta.main` is not available under the API's CommonJS `module` setting, so the seed body moves to its own module instead of guarding the script.)
- `seedE2e(db: PrismaClient): Promise<void>` (`apps/api/prisma/seed-e2e-data.ts`, new). The old wipe plus `RoleBinding` rows (deleted before users); the admin created with the default role; the fleet project and its repo as before; then `member` and global `admin` for the admin and `project-admin` on `fleet-e2e`, through the fixture module.

## Out of Scope

- Production code under `apps/api/src` is not changed, except the new file `apps/api/src/permissions/test-helpers/permission-fixtures.ts`.
- Removing the legacy union, the baseline fallback, `isLegacyAdmin`, the legacy tables and columns, `AGENT_PROJECT_SCOPING` and `PATCH /agents/:slug/update-roles` is out of scope (`permissions-p1-drop-legacy`).
- The compat-layer specs stay unchanged; drop-legacy deletes them: `apps/api/test/integration/permissions/core-legacy-union.integration.spec.ts`, `legacy-membership-queries.integration.spec.ts`, `membership-service.integration.spec.ts`, `permission-service.integration.spec.ts`, `bootstrap-baselines.integration.spec.ts`, `apps/api/test/integration/projects/member-bindings.integration.spec.ts`, `apps/api/src/permissions/legacy-membership.queries.spec.ts`, `apps/api/src/permissions/permission.service.spec.ts`, `apps/api/test/unit/config/agent-project-scoping.spec.ts`, and the legacy cases of `role-admin.service.spec.ts` other than the US-006 edit.
- Specs whose subject is production code that still reads or writes legacy rows stay unchanged; drop-legacy rewrites them with that code: `apps/api/test/integration/permissions/membership-project-access.integration.spec.ts`, `membership-ticket-consumers.integration.spec.ts`, `membership-agent-roster.integration.spec.ts`, `core-members-invites.integration.spec.ts`, `core-agent-routes.integration.spec.ts`, `core-admin-public-implicit.integration.spec.ts`, `apps/api/test/integration/agents/*.integration.spec.ts`, `apps/api/test/integration/auth/registration.integration.spec.ts`, `apps/api/test/integration/users/admin-users.integration.spec.ts`, `apps/api/test/integration/projects/project-members.integration.spec.ts`, `project-role-permissions.integration.spec.ts`, and the unit specs of the agent repository, agent creation, auth repository, notification eligibility, mention resolver, email content builder, home repository, assignee repository and project repository membership reads.
- Repository and schema specs that create a user or agent only as a foreign-key owner, with no permission decision, get no baseline binding: `apps/api/test/integration/fleet/fleet-ingest-schema.integration.spec.ts`, `fleet-job-logs-schema`, `fleet-job-repository`, `fleet-jobs-schema`, `fleet-project-code-repository`, `fleet-tickets-repository`, `fleet-tickets-schema`, `assistant-action-delivery`, `assistant-action-send-delivery`, `apps/api/test/integration/db/unique-violation.integration.spec.ts`, `apps/api/test/integration/notifications/notifications-repository.integration.spec.ts`, `apps/api/test/integration/tickets/ticket-pagination.integration.spec.ts`.
- Raw SQL inserts of a pre-migration `'ADMIN'` row (`fleet-thread-kind.integration.spec.ts`, `thread-creator-type.integration.spec.ts`) stay: they pin a migration's input shape.
- `role: 'ADMIN'` on a `UserPrincipal` claim object stays everywhere it is only a claim: the claim remains until drop-legacy derives it from bindings.
- `apps/api/src/tickets/tickets.service.spec.ts` `findUserById` stubs returning `role: 'ADMIN'` stay: `TicketsService.assign` reads the assignee's keys, not that field.
- Assertions that production wrote no legacy row (for example `agentProject.count` equal to 0 after an API call) stay (ruling 2).
- A test-only switch that disables the legacy union is out of scope (user ruling).
- `apps/api/test/integration/permissions/role-bindings-api.integration.spec.ts` stays unchanged: it asserts the exact bindings of the principals it creates (for example zero global bindings for `agentBId`), its acting admin comes from `POST /api/admin/users`, and its `ADMIN` target users already hold their `admin` binding.
- `apps/api/test/integration/projects/project-invites-public.integration.spec.ts` stays unchanged: it asserts `roleBinding.count()` against a count captured before it creates its user directly.
- `apps/api/test/integration/permissions/core-project-routes.integration.spec.ts` stays unchanged: its rostered agent's `roles: ['DEVELOPER']` sits next to assertions on the roster route's binding set in `p1`; drop-legacy rewrites it with the roster route.
- Specs that use `seedFleetHttpAgent` but roster the agent in no project (`fleet-analytics-api`, `fleet-dashboard-api`, `thread-content-events`, `thread-creator-type`, `workspace-read`) are not edited: the helper's `roles: []` changes nothing for them, because the roles applied in no project.
- `apps/api/test/unit/projects/projects-find-all-for-principal.spec.ts` stays unchanged: its `rowsForSelector` `role === 'ADMIN'` branch is unreachable (`ProjectsService.findAllForPrincipal` passes a user id string), and the global-reader case already goes through `readsEveryProject`.
- `apps/api/src/permissions/membership.service.spec.ts` stays unchanged: its disabled `addUser('off', 'ADMIN', true)` case depends only on `disabled`.
- `apps/web`, `apps/cli` and `apps/runner` are not changed.
- Adding the fixture rule to `.nax/rules/api-testing.md` is a manual step outside the run, committed with this spec.

## Stories

1. **US-001: The permission fixture module** — `Workdir: apps/api` — No dependencies. Creates `permission-fixtures.ts` with its integration spec. It converts no existing spec.
2. **US-002: The shared fleet fixtures and the fleet integration specs grant through bindings** — `Workdir: apps/api` — Depends on US-001. Converts `seedFleetBase` and `seedFleetHttpWorld` (used by over ninety specs) together with the `test/integration/fleet/` specs in the US-002 Modifies list, because several of those specs update or delete the membership rows `seedFleetHttpWorld` writes; converting the helper alone would break them. Adds each converted spec's sentinel test.
3. **US-003: Permission integration specs grant through bindings** — `Workdir: apps/api` — Depends on US-001. Converts the `test/integration/permissions/` specs in the US-003 Modifies list and adds each one's sentinel test.
4. **US-004: The remaining integration specs grant through bindings** — `Workdir: apps/api` — Depends on US-001, US-002 (`home-api.integration.spec.ts` uses `seedFleetHttpWorld` and `seedFleetHttpAgent`). Converts the email, home, live, memory, notifications, outbox, projects, rag, skills, vcs, webhook, auth and tickets specs in the US-004 Modifies list and adds each one's sentinel test.
5. **US-005: E2E specs and the e2e seed grant through bindings** — `Workdir: apps/api` — Depends on US-001. Converts the five e2e specs, and moves the e2e seed body into `prisma/seed-e2e-data.ts` (`seedE2e`), which `prisma/seed-e2e.ts` runs.
6. **US-006: Unit doubles decide on bindings and keys** — `Workdir: apps/api` — No dependencies. The four edits in the unit-double table.

One capability: the test suite grants access through role bindings only.

### Context Files

**US-001**
- `apps/api/src/permissions/system-role.seeder.ts` — the seeder `ensureSystemRoles` runs, read
- `apps/api/src/permissions/system-roles.ts` — the seed list and role keys, read
- `apps/api/src/permissions/membership.service.ts` — `setGlobalAdmin`, the `User.role` mirror to copy, read
- `apps/api/src/permissions/test-helpers/in-memory-permissions.ts` — the sibling test helper's conventions, read
- `apps/api/test/helpers/reset-db.ts` — the truncation the helpers must survive, read

**US-002**
- `apps/api/src/permissions/test-helpers/permission-fixtures.ts` — created by US-001, used here
- `apps/api/test/helpers/fleet-fixtures.ts` — edited here
- `apps/api/test/integration/fleet/assistant-actions-approve.integration.spec.ts` — the mid-test revocation, edited here
- `apps/api/test/integration/fleet/workspace-turns.integration.spec.ts` — the mid-test role change, edited here
- `apps/api/test/integration/fleet/permissions-workspace-threads.integration.spec.ts` — a representative agent roster fixture, edited here

**US-003**
- `apps/api/src/permissions/test-helpers/permission-fixtures.ts` — created by US-001, used here
- `apps/api/src/permissions/legacy-project-roles.ts` — the legacy-to-key mapping, read
- `apps/api/test/integration/permissions/enforce-fleet-jobs.integration.spec.ts` — a representative AgentProject + AgentRoleEntry fixture, edited here
- `apps/api/test/integration/permissions/membership-notification-consumers.integration.spec.ts` — the admin users and the exempt global-viewer fixture, edited here

**US-004**
- `apps/api/src/permissions/test-helpers/permission-fixtures.ts` — created by US-001, used here
- `apps/api/src/notifications/notification-eligibility.ts` — the `User.role` reader the admin mirror keeps working, read
- `apps/api/test/integration/home/home-api.integration.spec.ts` — the nested membership create, edited here
- `apps/api/test/integration/projects/project-membership-gate.integration.spec.ts` — the roster `createMany`, edited here

**US-005**
- `apps/api/src/permissions/test-helpers/permission-fixtures.ts` — created by US-001, used here
- `apps/api/prisma/seed-e2e.ts` — edited here
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the largest conversion, edited here

**US-006**
- `apps/api/src/permissions/test-helpers/in-memory-permissions.ts` — `bind`, read
- `apps/api/src/projects/project-access.service.ts` — `PROJECT_ACCESS_KEY` and the global ask, read
- `apps/api/src/projects/projects.service.ts` — `findAllForPrincipal`, read

### Creates

**US-001**
- `apps/api/src/permissions/test-helpers/permission-fixtures.ts`
- `apps/api/test/integration/permissions/permission-fixtures.integration.spec.ts`

**US-002**
- `apps/api/test/integration/fleet/fleet-fixtures-bindings.integration.spec.ts`

**US-003**

None.

**US-004**

None.

**US-005**
- `apps/api/prisma/seed-e2e-data.ts`
- `apps/api/test/integration/seed/seed-e2e.integration.spec.ts`

**US-006**

None.

### Modifies

**US-001**

None. US-001 only creates the fixture module and its spec; no existing assertion changes.

**US-002**
- `apps/api/test/helpers/fleet-fixtures.ts` — `seedFleetBase` creates `User { role: 'ADMIN' }`, `seedFleetHttpWorld` writes `ProjectMember` rows (dev `DEVELOPER`, viewer `VIEWER` on `web`), and `seedFleetHttpAgent` creates its agent with `roles: [...AGENT_ROLES]`, which writes four `AgentRoleEntry` rows. The replacing invariant: `seedFleetBase`'s admin is created with the default role, then gets `grantBaseline` and a global `admin` binding through `grantRole`; `seedFleetHttpWorld` writes `developer` and `viewer` bindings on `web` with `grantRole` before either user's first project request; `seedFleetHttpAgent` sends `roles: []`; a new `rosterFleetAgent(db, agentId, projectId)` grants `viewer`, `developer`, `reviewer`, `verifier` and `triager` in the project. All existing exports keep their signatures and return shapes.
- `apps/api/test/integration/fleet/assistant-action-tools.integration.spec.ts` — writes a `ProjectMember` row (line ~92). The replacing invariant: a `developer` binding in `ops` through `grantRole`; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/assistant-actions-approve.integration.spec.ts` — inserts a `ProjectMember` row (line ~208) and revokes it mid-test with `projectMember.deleteMany` (line ~194). The replacing invariant: a `developer` binding through `grantRole`; the revocation is `revokeProjectRoles` followed by `MembershipService.invalidatePermissions()`; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/assistant-direct-action-record.integration.spec.ts` — creates its agent with `seedFleetHttpAgent` and writes an `AgentProject` row (lines ~45-46). The replacing invariant: `rosterFleetAgent` replaces the `AgentProject` write; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/assistant-direct-action.integration.spec.ts` — creates its agent with `seedFleetHttpAgent` and writes an `AgentProject` row (lines ~32-33). The replacing invariant: `rosterFleetAgent` replaces the `AgentProject` write; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/assistant-executor-caller.integration.spec.ts` — creates its agent with `seedFleetHttpAgent` and writes an `AgentProject` row (lines ~32-33). The replacing invariant: `rosterFleetAgent` replaces the `AgentProject` write; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/assistant-workspace-project-argument.integration.spec.ts` — `projectMember.createMany` (line ~55) and `deleteMany` (lines ~113, ~116), plus direct user creates. The replacing invariant: `developer` bindings through `grantRole`, removals through `revokeProjectRoles` plus `invalidatePermissions()`, `grantBaseline` for each created user; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/assistant-workspace-tools.integration.spec.ts` — writes a `ProjectMember` row without `await` (line ~53) and creates a user directly. The replacing invariant: an awaited `developer` binding and `grantBaseline`; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/assistant-tool-executor.integration.spec.ts` — creates an outsider user directly (line ~56) that relies on the baseline fallback. The replacing invariant: `grantBaseline` for it; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/assistant-actions-decide.integration.spec.ts` — promotes the viewer with `projectMember.updateMany({ role: 'ADMIN' })` (line ~86). The replacing invariant: `revokeProjectRoles` + `grantRole(..., 'project-admin', web)` + `invalidatePermissions()`; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/fleet-approvals-api.integration.spec.ts` — creates its agent with `seedFleetHttpAgent` and writes an `AgentProject` row (lines ~73-75). The replacing invariant: `rosterFleetAgent` replaces the `AgentProject` write; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/fleet-project-thread-placement.integration.spec.ts` — writes a `ProjectMember` row (line ~61). The replacing invariant: a `developer` binding; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/fleet-project-thread-send.integration.spec.ts` — writes a `ProjectMember` row (line ~45). The replacing invariant: a `developer` binding; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/fleet-project-threads.integration.spec.ts` — writes a `ProjectMember` row (line ~38). The replacing invariant: a `developer` binding; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/fleet-schedule-repository.integration.spec.ts` — writes a `ProjectMember` row (line ~127) and creates users directly. The replacing invariant: a `developer` binding and `grantBaseline`; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/fleet-schedule-ticker.integration.spec.ts` — writes a `ProjectMember` row of a parameterised role (line ~38) and creates users directly. The replacing invariant: the mapped binding per the conversion table and `grantBaseline`; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/fleet-schedules-api.integration.spec.ts` — writes a `ProjectMember` row (line ~141) and creates users directly. The replacing invariant: a `developer` binding and `grantBaseline`; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/mcp-route.integration.spec.ts` — creates its agent with `seedFleetHttpAgent` and writes an `AgentProject` row in `web` (lines ~68-69). The replacing invariant: `rosterFleetAgent(prisma, agent.id, world.projectId)` replaces the `AgentProject` write; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/permissions-assistant-tools.integration.spec.ts` — writes an `AgentProject` row conditionally (line ~104). The replacing invariant: the same condition writes a `viewer` binding; `grantBaseline` always; the legacy-absence assertion at line ~239 stays; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/permissions-project-threads.integration.spec.ts` — writes an `AgentProject` row (line ~97). The replacing invariant: `grantBaseline` and `viewer`; the legacy-absence assertion at line ~177 stays; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/permissions-workspace-threads.integration.spec.ts` — `agentProject.createMany` (line ~104). The replacing invariant: one `viewer` binding per rostered project and `grantBaseline`; the legacy-absence assertions at lines ~219 and ~231 stay; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/workspace-create.integration.spec.ts` — `projectMember` upsert, update, deleteMany and createMany for dev and root (lines ~30-58); AC-10 relies on root having no membership in `web`. The replacing invariant: each write becomes `grantRole` / `revokeProjectRoles` with the mapped key plus `invalidatePermissions()` where a request already ran; root keeps its global `owner` binding from registration, so AC-10 is decided by its project bindings as before; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/workspace-turns.integration.spec.ts` — `projectMember` find, update, delete and upsert (lines ~68-79). The replacing invariant: `revokeProjectRoles` / `grantRole` with the mapped key plus `invalidatePermissions()`; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/fleet/thread-scope.integration.spec.ts` — `projectMember.update({ role: 'ADMIN' })` for dev and viewer (lines ~33-34). The replacing invariant: `revokeProjectRoles` + `grantRole(..., 'project-admin', web)` + `invalidatePermissions()`; sentinel test added; outcomes unchanged.

**US-003**
- `apps/api/test/integration/permissions/core-comments-labels-watchers.integration.spec.ts` — its agent fixture writes an `AgentProject` row (line ~139). The replacing invariant: the agent is created, gets `grantBaseline` and a `viewer` binding in the project; a `fixtures grant through bindings only` test asserts the sentinel report for every fixture principal; all existing outcomes unchanged.
- `apps/api/test/integration/permissions/core-ticket-links.integration.spec.ts` — its agent fixture writes an `AgentProject` row and an `AgentRoleEntry` `DEVELOPER` (lines ~143-144). The replacing invariant: `grantBaseline`, then `viewer` and `developer` bindings in the fixture project (never global); sentinel test added; outcomes unchanged.
- `apps/api/test/integration/permissions/core-ticket-routes.integration.spec.ts` — its agent fixture writes an `AgentProject` row and an `AgentRoleEntry` of a parameterised role (lines ~121-122). The replacing invariant: `grantBaseline`, `viewer`, and a binding of the mapped role key in the fixture project; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/permissions/core-ticket-transitions.integration.spec.ts` — its agent fixture writes `AgentProject` + `AgentRoleEntry` (lines ~113-114). The replacing invariant: `grantBaseline`, `viewer` and the mapped role key bound in the fixture project; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/permissions/enforce-fleet-approvals-budgets.integration.spec.ts` — its `createAgent(slug, roles)` posts the given `roles` to POST /api/agents and writes an `AgentProject` row in `p1` (lines ~117-120); `p1-approval-dev-agent` is created with `['DEVELOPER']` (line ~251). The replacing invariant: `createAgent` sends `roles: []`, then grants `viewer` in `p1` and a binding of each mapped role key in `p1` (so `p1-approval-dev-agent` gets `viewer` and `developer`); sentinel test added; outcomes unchanged.
- `apps/api/test/integration/permissions/enforce-fleet-config-knowledge.integration.spec.ts` — its agent fixture writes `AgentProject` + `AgentRoleEntry` (lines ~113-114). The replacing invariant: `grantBaseline`, `viewer` and the mapped role key in the project; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/permissions/enforce-fleet-global.integration.spec.ts` — its agent fixture writes `AgentProject` + `AgentRoleEntry` (lines ~97-98). The replacing invariant: `grantBaseline`, `viewer` and the mapped role key in the project; sentinel test added; the legacy-absence assertions at lines ~268, ~322 and ~360 stay; outcomes unchanged.
- `apps/api/test/integration/permissions/enforce-fleet-jobs.integration.spec.ts` — its agent fixture writes `AgentProject` + `AgentRoleEntry` (lines ~93-94). The replacing invariant: `grantBaseline`, `viewer` and the mapped role key in the project; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/permissions/enforce-fleet-project-reads.integration.spec.ts` — its agent fixture writes an `AgentProject` row (line ~96). The replacing invariant: `grantBaseline` and `viewer` in the project; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/permissions/enforce-fleet-schedules.integration.spec.ts` — its `createAgent` sends POST /api/agents with `roles: ['DEVELOPER']` and writes an `AgentProject` row in `p1` (lines ~101-103). The replacing invariant: `roles: []`, then `viewer` and `developer` bindings in `p1` through `grantRole`, before the existing `invalidatePermissions()`; sentinel test added; the legacy-absence assertions at lines ~181 and ~281 stay; outcomes unchanged.
- `apps/api/test/integration/permissions/enforce-fleet-requesters.integration.spec.ts` — it creates a `User { role: 'ADMIN' }` (line ~110) and an agent through `prisma.agent.create` (line ~112). The replacing invariant: the user is created with the default role and gets `grantBaseline` plus a global `admin` binding; the agent gets `grantBaseline`; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/permissions/membership-notification-consumers.integration.spec.ts` — `makeUser` creates `role: 'ADMIN'` users (line ~145), and line ~151 binds the `globalBind` user to `viewer` with `projectId: null`, which is the fixture under test. The replacing invariant: the ADMIN users get `grantBaseline` plus a global `admin` binding (which mirrors `User.role`), every other created user gets `grantBaseline`; the sentinel exempts the `globalBind` user under `globalProjectRoles`; the `User.role` assertion at line ~174 stays; outcomes unchanged.
- `apps/api/test/integration/permissions/core-seeded-roles.integration.spec.ts` — it creates users through Prisma (line ~35) that rely on the baseline fallback. The replacing invariant: each created user gets `grantBaseline`; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/permissions/enforce-fleet-foundations.integration.spec.ts` — it creates users through Prisma (line ~35) that rely on the baseline fallback. The replacing invariant: each created user gets `grantBaseline`; sentinel test added; outcomes unchanged.

**US-004**
- `apps/api/test/integration/email/email-dispatcher.integration.spec.ts` — writes a `ProjectMember` `DEVELOPER` row (line ~58) and creates users directly. The replacing invariant: a `developer` binding and `grantBaseline`; recipient eligibility reads bindings through `principalIdsWithAccess`; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/email/email-schedule.integration.spec.ts` — creates a user directly (line ~142) that relies on the baseline fallback. The replacing invariant: `grantBaseline`; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/home/home-api.integration.spec.ts` — a nested `members: { create: { role: 'ADMIN' } }` on a deleted project (line ~93); it also uses `seedFleetHttpWorld` (line ~60) and, inside its last test, `seedFleetHttpAgent` (line ~135), both converted in US-002. The replacing invariant: the project is created without members, then `grantRole(..., 'project-admin', project)`; the sentinel test covers the world's principals and the project-admin user, not the agent created inside the last test; outcomes unchanged.
- `apps/api/test/integration/memory/permissions-memory-routes.integration.spec.ts` — writes an `AgentProject` row (line ~133). The replacing invariant: `grantBaseline` and `viewer`; the legacy-absence assertion at line ~210 stays; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/memory/outbox-envelope.integration.spec.ts` — creates a `User { role: 'ADMIN' }` (line ~176). The replacing invariant: default role, `grantBaseline`, global `admin` binding; the claim object at line ~184 stays; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/outbox/producer-atomicity.integration.spec.ts` — creates a `User { role: 'ADMIN' }` (line ~97). The replacing invariant: default role, `grantBaseline`, global `admin` binding; the claim object at line ~118 stays; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/projects/project-membership-gate.integration.spec.ts` — its agent is created through POST /api/agents with `roles: ['DEVELOPER']` (line ~239) and rostered with `agentProject.createMany` in `team` and `other` (lines ~245-250). The replacing invariant: `roles: []`, then `viewer` and `developer` bindings in both `team` and `other` and `grantBaseline` for every created principal; the legacy-absence assertions at lines ~372 and ~401 stay; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/projects/project-memory.integration.spec.ts` — `user.update({ role: 'ADMIN' })` (line ~74). The replacing invariant: `grantRole(..., 'admin', null)` plus `invalidatePermissions()` if a request already ran; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/rag/permissions-kb-routes.integration.spec.ts` — writes an `AgentProject` row (line ~103). The replacing invariant: `grantBaseline` and `viewer`; the legacy-absence assertion at line ~149 stays; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/rag/rag-close-to-search.integration.spec.ts` — creates a `User { role: 'ADMIN' }` (line ~150). The replacing invariant: default role, `grantBaseline`, global `admin` binding; the claim objects at lines ~181 and ~194 stay; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/skills/project-skills-routes.integration.spec.ts` — its agent is created through POST /api/agents with `roles: ['DEVELOPER']` (line ~165) and gets an `AgentProject` row (line ~170). The replacing invariant: `roles: []`, then `viewer` and `developer` bindings in that project; the legacy-absence assertion at line ~350 stays; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/webhook/webhook-routes.integration.spec.ts` — `user.update({ role: 'ADMIN' })` (line ~87). The replacing invariant: `grantRole(..., 'admin', null)` plus `invalidatePermissions()` if a request already ran; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/vcs/vcs-webhook-secret.integration.spec.ts` — creates `hook-agent` through POST /api/agents with `roles: ['DEVELOPER']` (line ~54), rostered in no project (scoping set on at line ~34); its two binding agents have every binding deleted (line ~70) and get one project binding, and the spec asserts they hold no legacy rows. The replacing invariant: `hook-agent` is created with `roles: []`; the sentinel exempts `binding-admin-agent` and `binding-developer-agent` under `noBaseline`; the assertions at lines ~71-72 stay; outcomes unchanged.
- `apps/api/test/integration/skills/skills-routes.integration.spec.ts` — creates its agent (`Skill Agent`) through POST /api/agents with `roles: ['DEVELOPER']` (line ~63) and rosters it in no project, so with scoping on the role applies nowhere. The replacing invariant: `roles: []`; every principal the spec creates through Prisma gets `grantBaseline`; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/skills/skill-source-update-delete.integration.spec.ts` — creates its agent (`Skill Update Agent`) through POST /api/agents with `roles: ['DEVELOPER']` (line ~124) and rosters it in no project, so with scoping on the role applies nowhere. The replacing invariant: `roles: []`; every principal the spec creates through Prisma gets `grantBaseline`; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/notifications/notifications-api.integration.spec.ts` — creates its agent (`Notif Bot`) through POST /api/agents with `roles: ['DEVELOPER']` (line ~70) and rosters it in no project, so with scoping on the role applies nowhere. The replacing invariant: `roles: []`; every principal the spec creates through Prisma gets `grantBaseline`; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/live/live-stream.integration.spec.ts` — creates its agent (`Live Bot`) through POST /api/agents with `roles: ['DEVELOPER']` (line ~103) and rosters it in no project, so with scoping on the role applies nowhere. The replacing invariant: `roles: []`; every principal the spec creates through Prisma gets `grantBaseline`; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/auth/disabled-user.integration.spec.ts` — creates users directly (lines ~27, ~52) that rely on the baseline fallback. The replacing invariant: `grantBaseline` for each; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/tickets/ticket-tenancy.integration.spec.ts` — creates a user directly (line ~120) that relies on the baseline fallback. The replacing invariant: `grantBaseline`; sentinel test added; outcomes unchanged.
- `apps/api/test/integration/tickets/ticket-transition-race.integration.spec.ts` — creates a user directly (line ~79) that relies on the baseline fallback. The replacing invariant: `grantBaseline`; sentinel test added; outcomes unchanged.

**US-005**
- `apps/api/prisma/seed-e2e.ts` — creates its `PrismaClient` at module level and runs `main()`, which creates `User { role: 'ADMIN' }` and a `ProjectMember` ADMIN row on `fleet-e2e` and leaves `RoleBinding` rows of deleted users behind. The replacing invariant: a thin runner whose `main()` creates the client and calls `seedE2e` from the new seed-e2e-data module (US-005 Creates); `bun run seed:e2e` prints the same messages and leaves the admin with `member`, global `admin` and `project-admin` on `fleet-e2e`.
- `apps/api/test/e2e/agents.e2e.spec.ts` — `user.update({ role: 'ADMIN' })` (line ~58); an agent created with `roles: ['DEVELOPER', 'REVIEWER']` (line ~96) whose roles the spec asserts in the response (line ~146) and through `update-roles` (lines ~217-221), and which it deletes at line ~330; and three `AgentProject` writes (lines ~110, ~175, ~308). The replacing invariant: a global `admin` binding through `grantRole`; `viewer` bindings for the rostered agent; the asserted agent keeps its `roles`; the sentinel is placed immediately before the DELETE /api/agents/:slug test and exempts that agent under `agentRoleEntries`; outcomes unchanged.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — a `role: 'ADMIN'` user, about fifteen `ProjectMember` writes including role updates between steps (lines ~3379-3742), about four `AgentProject` writes, and agents created through POST /api/agents with roles (lines ~297, ~1194, ~1917, ~2775, ~2827, ~2861). Only the line-297 agent (`agentSlug`) has its roles asserted through the agent API (lines ~333, ~1123-1127, ~1964-1966). The replacing invariant: every grant per the conversion table; role changes between steps are `revokeProjectRoles` + `grantRole` + `invalidatePermissions()`; the `agentSlug` agent keeps its roles and is the only principal exempt under `agentRoleEntries`; `pickup-empty-agent` (line ~1917) is created with `roles: []` and, where it is rostered (line ~1927), also gets a `developer` binding in that project, since its pickup needs `agent.pickup`; `temp-agent` (line ~1194) and the three agents rostered through the roster route under test (lines ~2775, ~2827, ~2861) are created with `roles: []` and get no pre-grant, because that route writes their `viewer` binding and its cases (including the 409 already-assigned case at line ~2885) assert it; the legacy-absence assertions at lines ~2797 and ~3011 stay; the sentinel is the file's last test; every existing case keeps its status and body assertions.
- `apps/api/test/e2e/ast-index.e2e.spec.ts` — agents created through POST /api/agents with `roles: ['DEVELOPER']` (line ~85) and `roles: ['REVIEWER']` (line ~264), and an `AgentProject` write (line ~112). The replacing invariant: both agents are created with `roles: []` and get `viewer` plus their mapped role binding in each project the spec rosters them in (none for an agent it does not roster); sentinel test added; outcomes unchanged.
- `apps/api/test/e2e/hybrid-retriever.e2e.spec.ts` — three `ProjectMember` rows (lines ~122, ~127, ~132). The replacing invariant: `project-admin`, `developer` and `viewer` bindings; sentinel test added; outcomes unchanged.
- `apps/api/test/e2e/context.e2e.spec.ts` — `user.update({ role: 'ADMIN' })` (line ~84). The replacing invariant: a global `admin` binding through `grantRole` plus `invalidatePermissions()` if a request already ran; sentinel test added; outcomes unchanged.

**US-006**
- `apps/api/src/projects/project-membership.guard.spec.ts` — the `can` double answers the global `project.read` ask with `principal.role === 'ADMIN'` (lines ~149-151), and AC4 builds its global reader as a `role: 'ADMIN'` principal. The replacing invariant: the double answers the global ask from a `globalReaders` set of principal ids; AC4's principal has `role: 'MEMBER'` and is in the set; every other case keeps its outcome.
- `apps/api/src/projects/project-membership.guard.routes.spec.ts` — the same double (line ~134) and the same AC4. The replacing invariant: the same `globalReaders` set; AC4's caller has `role: 'MEMBER'` and is in the set; every other case keeps its status.
- `apps/api/src/fleet/assistant/assistant-tool.executor.spec.ts` — AC-7 (lines ~184-187) is "a global ADMIN creator" built from `creator: { role: 'ADMIN' }`. The replacing invariant: the creator has `role: 'MEMBER'`, `access.resolveMembership` resolves `'ADMIN'`, the tool runs, and the `resolveMembership` call assertion matches `role: 'MEMBER'`; the title names the global reader, not the claim.
- `apps/api/src/permissions/role-admin.service.spec.ts` — AC-22 (line ~733) gives `grantor-2` global authority with `addUser('grantor-2', 'ADMIN')`. The replacing invariant: `addUser('grantor-2')` plus `store.bind({ type: 'USER', id: 'grantor-2' }, 'admin')`; the outcome is unchanged.

### Seams

- **US-001 → US-002..US-005:** `grantRole`, `grantBaseline`, `revokeProjectRoles` and `fixtureGrantReport` are consumed by every converted spec. US-001 AC 12 proves a binding written by `grantRole` is what `PermissionService` decides on, and US-002 AC 1 that an HTTP route decides on it; each consuming story's sentinel AC calls `fixtureGrantReport` on its fixtures.
- **US-002 → US-004:** `home-api.integration.spec.ts` uses `seedFleetHttpWorld` and `seedFleetHttpAgent`, converted in US-002; its sentinel test (US-004 AC 1) needs the converted helpers.
- **US-001 → US-005:** `seedE2e` uses `grantBaseline` and `grantRole`; US-005 AC 1 observes the admin's bindings after a run on a reset database.

## Acceptance Criteria

Fixture wording:
- "A reset database" is one `resetDb()` just emptied, so it holds no `Role` rows.
- "The sentinel report" of a principal is `fixtureGrantReport(db, principal)`, and "clean" means it equals `{ legacyMemberships: 0, agentRoleEntries: 0, hasGlobalBinding: true, globalProjectRoleBindings: 0 }`.
- "A converted spec" is a spec listed under the story in Modifies. "The sentinel test" is its test named `fixtures grant through bindings only`, placed as the Design section "The sentinel test" says.

### US-001: The permission fixture module (`Workdir: apps/api`)

1. [integration] `ensureSystemRoles(db)` on a reset database creates `Role` rows whose keys are exactly the eleven `SYSTEM_ROLES` keys.
2. [integration] After `ensureSystemRoles(db)`, every `Role` row's `scope`, `locked`, `system` and `permissions` equal its `SYSTEM_ROLES` seed, and a second call leaves the row count at eleven.
3. [integration] After `ensureSystemRoles(db)`, setting the locked `owner` role's `permissions` to `['ticket.read']` and calling `ensureSystemRoles(db)` again restores the seed's permissions.
4. [integration] `grantRole(db, { type: 'USER', id: u }, 'developer', p)` on a reset database writes one `RoleBinding` with the `developer` role's id, `projectId` `p`, `grantedByType` `'SYSTEM'` and `grantedById` `'test'`.
5. [integration] Calling `grantRole(db, user, 'developer', p)` twice returns the same `id` both times and leaves one matching `RoleBinding` row.
6. [integration] `grantRole(db, user, 'no-such-role', p)` rejects with an `Error` whose message is `no role no-such-role`, and no `RoleBinding` row exists for that user.
7. [integration] `grantRole(db, user, 'admin', null)` for a user created with `role: 'MEMBER'` sets that user's `User.role` to `'ADMIN'`, and `grantRole(db, user, 'developer', p)` leaves it `'MEMBER'`.
8. [integration] `grantBaseline(db, { type: 'USER', id: u })` writes a global binding of the `member` role, `grantBaseline(db, { type: 'AGENT', id: a })` a global binding of the `agent` role, and a second `grantBaseline` for the same user returns the first binding's id.
9. [integration] `revokeProjectRoles(db, user, p)` for a user bound to `developer` and `viewer` in `p`, `viewer` in `q` and `member` globally returns `2` and leaves exactly the `q` and global bindings.
10. [integration] `fixtureGrantReport` for a user with one `ProjectMember` row and `User.role = 'ADMIN'` but no global `admin` binding reports `legacyMemberships: 2`, and after a global `admin` binding is granted and the `ProjectMember` row deleted reports `legacyMemberships: 0`.
11. [integration] `fixtureGrantReport` for an agent with one `AgentProject` row, one `AgentRoleEntry` row and a global `developer` binding reports `{ legacyMemberships: 1, agentRoleEntries: 1, hasGlobalBinding: true, globalProjectRoleBindings: 1 }`.
12. [integration] `expectBindingOnlyFixtures(db, [user, agent])` rejects with an `Error` whose message contains the agent's id and `agentRoleEntries` when the agent has one `AgentRoleEntry` row, and resolves when the same call passes `{ agentRoleEntries: [agent] }` and both principals are otherwise clean.
13. [integration] `expectBindingOnlyFixtures(db, [user])` rejects with an `Error` whose message contains the user's id and `hasGlobalBinding` for a user with no binding, and resolves with `{ noBaseline: [user] }`.
14. [integration] In the booted application, `PermissionService.can(user, 'ticket.create', { projectId: p })` is allowed for a user whose only bindings are `grantBaseline` and `grantRole(db, user, 'developer', p)`, and refused for project `q`.

### US-002: The shared fleet fixtures and the fleet integration specs grant through bindings (`Workdir: apps/api`)

1. [integration] In `fleet-fixtures-bindings.integration.spec.ts`, after `seedFleetHttpWorld` in a booted application, `GET /api/projects/web/tickets` answers 200 for `dev` and for `viewer`, and 403 with error code `projects` for `outsider`.
2. [integration] After `seedFleetHttpWorld`, `expectBindingOnlyFixtures` resolves for `root`, `dev`, `viewer` and `outsider`, and `dev` holds a `developer` binding and `viewer` a `viewer` binding in `web`.
3. [integration] After `seedFleetBase`, `expectBindingOnlyFixtures` resolves for its admin, the admin holds a global `admin` binding, and its `User.role` is `'ADMIN'`.
4. [integration] An agent from `seedFleetHttpAgent` has no `AgentRoleEntry` row, and after `rosterFleetAgent(db, agent.id, world.projectId)` it holds exactly the `viewer`, `developer`, `reviewer`, `verifier` and `triager` bindings in `web`, its `PermissionService.effectiveKeys` in `web` hold `ticket.create`, its effective keys in `ops` do not, and `expectBindingOnlyFixtures` resolves for it.
5. [integration] Each converted fleet spec has a sentinel test that resolves `expectBindingOnlyFixtures` for every user and agent the spec creates.
6. [integration] In `assistant-actions-approve.integration.spec.ts`, in the test where a requester is removed from the action's project, after `revokeProjectRoles` of `dev`'s bindings in `web` and `invalidatePermissions()`, `dev`'s approve decision answers 403 and the action stays `PENDING`; the test then grants `developer` in `web` back and invalidates again.
7. [integration] In `assistant-actions-decide.integration.spec.ts`, after its setup replaces `viewer`'s `web` binding with `project-admin` and calls `invalidatePermissions()`, `viewer` holds exactly one binding in `web`, of the `project-admin` role.
8. [integration] In `thread-scope.integration.spec.ts`, after `beforeAll`, `dev` and `viewer` each hold exactly one binding in `web`, of the `project-admin` role.
9. [integration] In `workspace-turns.integration.spec.ts`, in the lost-hosting-permission test, after `dev`'s `web` bindings are replaced by a `viewer` binding (or revoked, for the `null` case) and `invalidatePermissions()` runs, sending to `dev`'s thread answers 403 with message `You do not have permissions to perform this action` and stores no message; the test then restores the `developer` binding and invalidates again.

### US-003: Permission integration specs grant through bindings (`Workdir: apps/api`)

1. [integration] Each converted permissions spec has a sentinel test that resolves `expectBindingOnlyFixtures` for every user and agent the spec creates, with only the exemptions its Modifies entry names.
2. [integration] In `enforce-fleet-jobs.integration.spec.ts`, an agent created by `createAgent(slug, 'DEVELOPER')` holds `ticket.create` in `PermissionService.effectiveKeys` for project `p1`, and does not hold it for a second project `p2` the test creates and binds it nowhere in.
3. [integration] In `membership-notification-consumers.integration.spec.ts`, the sentinel test exempts exactly the `globalBind` user under `globalProjectRoles`, and that user still holds its global `viewer` binding.

### US-004: The remaining integration specs grant through bindings (`Workdir: apps/api`)

1. [integration] Each converted spec has a sentinel test that resolves `expectBindingOnlyFixtures` for every user and agent the spec creates, with only the exemptions its Modifies entry names.
2. [integration] In `email-dispatcher.integration.spec.ts`, a recipient whose only project grant is a `developer` binding written by `grantRole` is delivered the email the spec asserted before the conversion.
3. [integration] In `home-api.integration.spec.ts`, the user bound `project-admin` on the deleted project by `grantRole` gets a home response in which the deleted project is absent.
4. [integration] In `vcs-webhook-secret.integration.spec.ts`, `hook-agent` has no `AgentRoleEntry` row, and the sentinel test exempts exactly `binding-admin-agent` and `binding-developer-agent` under `noBaseline`.

### US-005: E2E specs and the e2e seed grant through bindings (`Workdir: apps/api`)

1. [integration] `seedE2e(db)` on a reset database leaves `admin@koda-e2e.test` with bindings to exactly `member` and `admin` globally and `project-admin` on `fleet-e2e`, and `expectBindingOnlyFixtures` resolves for the admin.
2. [integration] `seedE2e(db)` run twice on the same database succeeds both times and leaves exactly one user and three `RoleBinding` rows.
3. [integration] After `seedE2e(db)` and an API boot, `admin@koda-e2e.test` logs in with `E2ePassword1!` and gets 200 from `GET /api/projects/fleet-e2e`.
4. [integration] Each converted e2e spec has a sentinel test that resolves `expectBindingOnlyFixtures` for every user and agent the spec creates, exempting under `agentRoleEntries` only the agents whose roles it asserts through the agent API.
5. [integration] In `agents.e2e.spec.ts`, the sentinel test runs before the `DELETE /api/agents/:slug` test and resolves with the file's agent listed and exempt only under `agentRoleEntries`.

### US-006: Unit doubles decide on bindings and keys (`Workdir: apps/api`)

1. [unit] `ProjectMembershipGuard` in `project-membership.guard.spec.ts` admits a user principal with `role: 'MEMBER'` and no membership row whose id is in the `can` double's `globalReaders` set.
2. [unit] In `project-membership.guard.spec.ts`, the `can` double refuses the global `project.read` ask for a user principal with `role: 'ADMIN'` whose id is not in `globalReaders`.
3. [unit] In `project-membership.guard.routes.spec.ts`, `GET /api/projects/:slug` answers 200 for a user with `role: 'MEMBER'` whose id is in `globalReaders` and who has no membership row.
4. [unit] The assistant tool executor runs a member tool for a creator with `role: 'MEMBER'` and no membership row when `ProjectAccessService.resolveMembership` resolves `'ADMIN'`, and `resolveMembership` was called with `'p1'` and a principal with `role: 'MEMBER'`.
5. [unit] In `role-admin.service.spec.ts`, in the case where `grantor-2` holds the `superuser` role, `grantor-2`, a `MEMBER` user bound to `admin` globally through `InMemoryPermissionStore.bind`, gets the outcome that case asserted before the conversion.
