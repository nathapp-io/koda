# SPEC: Permissions P1m — Drop the Legacy Schema

## Summary

The last of the three `permissions-p1-drop-legacy-*` features, and the last feature of P1. Every reader and route already works on role bindings (`permissions-p1-drop-legacy-reads`, `permissions-p1-drop-legacy-routes`); what is left of the legacy model is storage. This feature derives the user `role` claim from bindings, makes token revocation follow global-admin bindings instead of the `User.role` mirror, physically drops `User.role`, `ProjectInvite.role`, `ProjectMember`, `AgentProject` and `AgentRoleEntry` in two migrations, removes every remaining read and write of them in the API, its fixtures and its specs, and drops the `role` line from `koda auth me` and the `role` field from the web's `AuthUser` type.

## Motivation

The redesign (`docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` §8, decision 2) replaces `User.role`, `ProjectMember`, `AgentProject` and `AgentRoleEntry` with `Role` and `RoleBinding`, with no data migration, and drops the legacy tables and columns once nothing reads them. After `permissions-p1-drop-legacy-routes` (PR #322):

- Nothing decides on the legacy tables, but they still exist and are still written: `PrismaAuthRepository.findAnyUserAndCreate` stores `role: 'ADMIN'` for the first user, `UsersAdminService.create` and `PrismaProjectInvitesMembersRepository.createInvitedUser` store `role: 'MEMBER'`, `ProjectInvitesService.inviteNewAddress` stores the legacy enum in `ProjectInvite.role`, and `MembershipService` mirrors every global `owner`/`admin` binding into `User.role` through `PrismaRoleBindingRepository.setUserRole`.
- The JWT `role` claim, `UserPrincipal.role` and `UserResponseDto.role` (login, register, refresh, invite acceptance, `GET /auth/me`) are read from the `User.role` column, so they are only as right as the mirror.
- `PrismaProjectAssigneesRepository` is still built on the `ProjectMember` model, `PrismaProjectInvitesMembersRepository.createMember` still writes a `ProjectMember` row (no caller), and `MembershipService.removeProjectBindings` has had no production caller since PR #322.
- About 80 DB-backed specs still write `role` on user rows, assert the stored `User.role`, or seed and count legacy rows.

The user's rulings for this feature (2026-10-23): the `role` claim and `UserResponseDto.role` stay and are derived from bindings; a global `owner`/`admin` grant or revoke that flips the derived role still revokes the user's tokens; `removeProjectBindings` is deleted; `legacy-project-roles.ts` stays (it names display text, see Out of Scope); the web drops `AuthUser.role` and the CLI drops the `Role` row of `koda auth me`.

## Design

### Rulings that bind every story

1. **The derived role.** A user's role claim is `'ADMIN'` when the user holds at least one binding with `principalType` `USER`, `projectId` null and role key `owner` or `admin`; otherwise it is `'MEMBER'`. A `project-admin` binding, in one project or in all projects (`projectId` null with a PROJECT-scope role), does not make it `'ADMIN'`. The claim decides nothing (`.nax/rules/api-auth.md`, "No Decisions on Role Claims"); it is display and compatibility data.
2. **Revocation follows the flip.** A binding write revokes a user's tokens (bumps `tokenVersion`, then drops `userTokenVersionCacheTag(userId)` and `userAuthStateCacheKey(userId)` after commit) exactly when it changes that user's derived role: an insert of a global `owner`/`admin` binding for a user who held none, and a removal that leaves a user with none. This replaces "every change of `User.role` bumps `tokenVersion`" in the design doc's notes; the lock order of `MembershipService` (the `owner` Role row, then the user row) is unchanged.
3. **One migration per legacy object group.** US-003 drops the two columns (`User.role`, `ProjectInvite.role`) in `20261102090000_drop_legacy_role_columns`; US-004 drops the three tables in `20261102090100_drop_legacy_membership_tables`. No data is copied (design decision 2). Each migration ships with a scratch-schema test in the pattern of `test/integration/fleet/pending-action-drop-legacy-columns-migration.integration.spec.ts` (`scratchSchemaBefore`, `applyMigration` from `test/helpers/migration-schema.ts`).
4. **Order of the stories.** Stop reading the columns (US-001), stop writing the mirror (US-002), then drop the columns (US-003) and the tables (US-004). Specs are changed in the story whose code change first breaks them: a spec that asserts the stored `User.role` value changes in US-002 (the mirror goes), a spec that writes `role` on a user row or a legacy invite `role` changes in US-003, a spec that seeds or counts `ProjectMember`, `AgentProject` or `AgentRoleEntry` changes in US-004. One deliberate exception: US-002 removes every assertion on the stored `User.role` value, including those the fixture mirror or the column default would keep green until US-003, so no spec reads the column after the mirror goes.
5. **No API contract change.** `UserResponseDto` keeps `role`; no route, DTO or response field changes, so `openapi.json` and `apps/cli/src/generated/` are not regenerated.

### The session role claim comes from bindings (US-001)

`AuthService` gains two methods and changes one:

- `roleClaim(userId: string): Promise<KodaUserRole>` answers `'ADMIN'` when `MembershipService.isGlobalAdmin(userId)` resolves `true`, else `'MEMBER'`.
- `userResponse(user: UserDomain): Promise<UserResponseDto>` answers `UserResponseDto.from(user, await this.roleClaim(user.id))`.
- `issueSession(user: UserDomain)` becomes `async` and answers `Promise<AuthResponseDto>`: it signs the access token with `roleClaim(user.id)` and returns `user: await this.userResponse(user)`.

`AuthController.me` maps the validated user through `authService.userResponse(validatedUser)` instead of `UserResponseDto.from(validatedUser)`. `InviteAcceptanceService.accept` awaits `this.auth.issueSession(user)`.

**Registration re-reads the user.** `AuthService.register` issues the session from `authRepo.findUserById(created.id)` read after the registration transaction committed, not from the row `findAnyUserAndCreate` returned. Once the first-user write stops storing `role: 'ADMIN'`, the Owner binding `bindOwnerIfFirst` writes is a flip (ruling 2) and bumps `tokenVersion` inside the transaction, so a token signed with the pre-bump `tokenVersion` would be revoked on its first use.

`PrismaAuthRepository` stops reading and writing the column: `toDomain` has no `role`, `createUser` takes no `role`, and `findAnyUserAndCreate` writes `data` as given for the first user too. `PrismaProjectInvitesMembersRepository.createInvitedUser` writes and returns no `role`.

The assistant's user principal (`userPrincipal` in `assistant-tool.executor.ts`) keeps reading `creator.role`; `PrismaAssistantToolCallRepository.findUserActor` derives that `role` with ruling 1, reading the user's global `owner`/`admin` binding count from `roleBinding` in the same repository (as `PrismaUsersRepository.countActiveAdmins` already reads `roleBinding`), and stops selecting the `role` column.

### Revocation without the mirror (US-002)

`PrismaRoleBindingRepository.setUserRole(userId, role)` is replaced by `bumpTokenVersion(userId: string): Promise<boolean>`: one `user.updateMany({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } })`, answering `count > 0`.

In `MembershipService`:

- `insertBinding`, for a `USER` principal, `projectId` null and a role key in `GLOBAL_ADMIN_ROLE_KEYS`, reads `countGlobalAdminBindings(userId)` after the locks and the `findExisting` check and before `createBinding`; when it was `0`, it calls `bumpTokenVersion(userId)` and lists the user in `revokedUserIds` when that answers `true`. An existing identical binding (the `findExisting` early return) bumps nothing.
- `afterRemoval` keeps its candidate set (users whose removed bindings include a global `owner`/`admin` one); `syncLegacyRole` becomes `revokeIfNoGlobalAdmin(userId)`: when `countGlobalAdminBindings(userId)` is `0` it calls `bumpTokenVersion(userId)` and answers its result, else `false`.
- `setGlobalAdmin(userId, false, by)` (no production caller; kept) revokes only when it deleted the user's global `admin` binding (`existing !== null`) and `countGlobalAdminBindings(userId)` is then `0`; when it deleted nothing it bumps nothing, as today's `setUserRole` changed nothing for a plain member.
- `afterWrite` is unchanged: it invalidates the two cache entries of each `revokedUserIds` user after commit.

`PrismaRoleBindingRepository.findUserState` selects only `disabled` and answers `UserAccountState` (`{ disabled: boolean }`), which replaces `UserLegacyState` in `permissions.types.ts`. `InMemoryPermissionStore` follows: users are `{ disabled, tokenVersion }`, `addUser(id, disabled = false)`, and `bumpTokenVersion` increments `tokenVersion` and pushes `tokens:<userId>` onto `store.calls`; a `bumpTokenVersionFailure: Error | null` field makes the next call reject, like `openAgentTicketsFailure`.

### Drop `User.role` and `ProjectInvite.role` (US-003)

Migration `20261102090000_drop_legacy_role_columns`:

```sql
-- Permissions P1m US-003: the role claim is derived from role bindings, and an invite names its role by roleId.
ALTER TABLE "User" DROP COLUMN "role";
ALTER TABLE "ProjectInvite" DROP COLUMN "role";
```

`schema.prisma` loses `User.role` and `ProjectInvite.role`. Then, per file:

| File | Change |
|:--|:--|
| `src/users/domain/user-admin.domain.ts` | `GLOBAL_ROLES`, `GlobalRole`, `UserAdminRecord.role` and `UserAdminWrite.role` go |
| `src/users/prisma-users.repository.ts` | `toRecord` has no `role`; `createUser(data: { email; name; passwordHash })`; `updateUser` writes no `role` |
| `src/users/users-admin.service.ts` | `create` passes no `role` |
| `src/projects/invites/domain/project-invite.domain.ts` | `ProjectInviteRecord.role` goes; `roleKey` / `roleName` come from `roleId` only |
| `src/projects/invites/prisma-project-invites.repository.ts` | `CreateProjectInviteInput.role` goes and `create` writes no `role`; `legacyRoleNames` goes; `toRecord` answers `roleKey: row.assignedRole?.key ?? null` and `roleName: row.assignedRole?.name ?? null` |
| `src/projects/invites/project-invites.service.ts` | `legacyNameOf` goes; the invite mail `role` is `invite.roleName ?? ''` |
| `src/tickets/prisma-tickets.repository.ts`, `src/tickets/domain/ticket.domain.ts` | `findUserById` selects and answers `{ id, disabled }` |
| `src/permissions/test-helpers/permission-fixtures.ts` | `grantRole` writes only the binding (the `mirrorsAdmin` user update goes); `fixtureGrantReport` reads no `role` (`legacyMemberships` counts `ProjectMember` rows only) |
| `prisma/seed.ts` | prints `outcome.roleKey` for a created admin, and no role for an existing email |

An invite whose `roleId` is null (its custom role was deleted) names no role: it lists with `roleKey` and `roleName` null and its acceptance answers 409 `invites.roleGone`, as `InviteAcceptanceService.invitedRole` already does for a row with neither.

### Drop `ProjectMember`, `AgentProject` and `AgentRoleEntry` (US-004)

Migration `20261102090100_drop_legacy_membership_tables`:

```sql
-- Permissions P1m US-004: memberships, agent rosters and agent roles are role bindings.
DROP TABLE "ProjectMember";
DROP TABLE "AgentProject";
DROP TABLE "AgentRoleEntry";
```

`schema.prisma` loses the three models and the relation fields that name them: `User.projectMemberships`, `User.addedAgentProjects`, `Agent.roles`, `Agent.projects`, `Project.members`, `Project.agents`. Then:

- `PrismaProjectAssigneesRepository` stops extending `AbstractPrismaRepository<ProjectMembershipDomain, ProjectMember, string>`: it is a plain `@Injectable()` class with the constructor's `PrismaService` and its one method `search` (unchanged). `IProjectAssigneesRepository` no longer extends `IRepository<ProjectMembershipDomain, string>`, and `ProjectMembershipDomain` goes. The CRUD half had no caller; `ProjectAssigneesService` calls only `search`. The `PROJECT_ASSIGNEES_REPOSITORY` token and its module wiring stay.
- `PrismaProjectInvitesMembersRepository.createMember` goes.
- `MembershipService.removeProjectBindings`, `PrismaRoleBindingRepository.deleteProjectBindings`, the in-memory double's `deleteProjectBindings` and the `GlobalStubsModule` stub `removeProjectBindings` go (ruling 2026-10-23).
- `fixtureGrantReport` answers `FixtureGrantReport` with `hasGlobalBinding` and `globalProjectRoleBindings` only; `legacyMemberships` and `agentRoleEntries` go.
- `seedE2e`'s `wipe` drops the `agentRoleEntry.deleteMany()` line.

### The CLI and the web (US-005, US-006)

`koda auth me` prints the rows `ID`, `Email` and `Name`; `--json` keeps printing the API's `data` unchanged (which still carries `role`). The web's `AuthUser` interface in `apps/web/composables/useAuth.ts` loses `role?: string`; nothing in `apps/web` reads it.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| `MembershipService.isGlobalAdmin` rejects while a session is issued (login, register, refresh, invite accept) | the error propagates; no token is signed (US-001) |
| `bumpTokenVersion` rejects inside a binding write | the error propagates and the binding write's transaction rolls back (US-002) |
| `bumpTokenVersion` finds no user row | answers `false`; the user is not listed in `revokedUserIds` (US-002) |
| An invite whose `roleId` is null is accepted | 409 `invites.roleGone`; no user and no binding are created (US-003) |
| A migration runs on a database that holds legacy rows | the legacy columns or tables and their rows are dropped; every other row is kept (US-003, US-004) |

### Integration

Symbols this feature only reads:

- `MembershipService.isGlobalAdmin(userId: string): Promise<boolean>` (`apps/api/src/permissions/membership.service.ts`)
- `PrismaRoleBindingRepository.countGlobalAdminBindings(userId: string): Promise<number>`
- `userTokenVersionCacheTag(userId)`, `userAuthStateCacheKey(userId)` (`apps/api/src/auth/token-version.cache.ts`)
- `invitedRole` (module-level function in `invite-acceptance.service.ts`; a row with no `roleId` and no `roleKey` answers `null`, then 409 `invites.roleGone`)
- `scratchSchemaBefore(baseUrl, schema, target)`, `applyMigration(db, migration)` (`apps/api/test/helpers/migration-schema.ts`)
- `KodaUserRole` (`'MEMBER' | 'ADMIN'`, `apps/api/src/auth/principal/koda-principal.types.ts`), unchanged

Symbols this feature changes. The baseline exists only to locate the code; it is never the interface to implement.

- `AuthService.issueSession` — Baseline: `issueSession(user: UserDomain): AuthResponseDto`. Target: `issueSession(user: UserDomain): Promise<AuthResponseDto>`.
- `AuthService.roleClaim` — Target (new): `roleClaim(userId: string): Promise<KodaUserRole>`.
- `AuthService.userResponse` — Target (new): `userResponse(user: UserDomain): Promise<UserResponseDto>`.
- `UserResponseDto.from` — Baseline: `from(user: UserDomain)`. Target: `from(user: UserDomain, role: KodaUserRole)`.
- `UserDomain` (`apps/api/src/auth/domain/auth.domain.ts`) — Target: no `role` field.
- `PrismaAuthRepository.createUser` — Target: `createUser(data: { email: string; name: string; passwordHash: string })`.
- `UserToolCallCreator.role` — Target: `role: KodaUserRole`, derived by `findUserActor` (ruling 1).
- `PrismaRoleBindingRepository.setUserRole` — Baseline: `setUserRole(userId, role): Promise<boolean>`. Target: removed; `bumpTokenVersion(userId: string): Promise<boolean>` replaces it.
- `PrismaRoleBindingRepository.findUserState` — Target: `findUserState(userId: string): Promise<UserAccountState | null>` with `UserAccountState = { disabled: boolean }`.
- `InMemoryPermissionStore.addUser` — Baseline: `addUser(id, role = 'MEMBER', disabled = false)`. Target: `addUser(id: string, disabled = false)`.
- `PrismaUsersRepository.createUser` — Target: `createUser(data: { email: string; name: string; passwordHash: string }): Promise<UserAdminRecord>`.
- `TicketsRepository.findUserById` — Target: `findUserById(id: string): Promise<{ id: string; disabled: boolean } | null>`.
- `ProjectInviteRecord` — Target: no `role` field.
- `IProjectAssigneesRepository` — Target: `{ search(projectId, q, limit, ids): Promise<AssigneeDomain[]> }`, not an `IRepository`.
- `FixtureGrantReport` — Target: `{ hasGlobalBinding: boolean; globalProjectRoleBindings: number }`.

Patterns to follow: migration tests copy `pending-action-drop-legacy-columns-migration.integration.spec.ts`; DB fixtures grant access with `grantRole` / `grantBaseline` (`.nax/rules/api-testing.md`); exceptions and i18n keys are unchanged (no new error).

## Out of Scope

- Deleting `apps/api/src/permissions/legacy-project-roles.ts` and the display vocabulary it feeds (`userProjectRole`, `localProjectRole`, `findMembershipRole`, the member-added email's `{{role}}`, the invite "already a member" check) is out of scope (ruling 2026-10-23: display text, a later feature).
- Removing `KodaUserRole`, `UserPrincipal.role`, the JWT `role` claim or `UserResponseDto.role` is out of scope (ruling 2026-10-23: they stay, derived from bindings).
- Removing the `ProjectMemberRole`, `AgentRoleNames` and `KodaAgentRole` types from `src/common/enums.ts` and `koda-principal.types.ts`, and rewording comments that still mention the dropped tables, is out of scope.
- Copying legacy rows into bindings before the drop is out of scope (design decision 2: no data migration).
- Specs that stub a `projectMember`, `agentProject` or `agentRoleEntry` delegate on a mocked Prisma client (for example `membership.queries.spec.ts`, `agents-create.routes.spec.ts`, `prisma-agent.repository.spec.ts`, `prisma-project.repository.membership-reads.spec.ts`, `email-content.builder.spec.ts` and the RAG retrieval integration specs) are out of scope; they keep passing against their mocks.
- US-002 only: a test that races two concurrent global `owner`/`admin` grants of one user is out of scope; the user-row lock `insertBinding` takes before the count serializes them, and the existing B2 case exercises that lock.
- Request bodies in specs and helpers that still send `role` to `POST /api/admin/users` are out of scope; the global validation pipe strips the field.
- Regenerating `openapi.json` and `apps/cli/src/generated/` is out of scope; no contract changes.
- Resetting and redeploying koda-wk is out of scope for the run; it is a manual step after P1 (design decision 2).
- Approval policies, the audit log and `ActionContext` are out of scope (P3, P2).

## Stories

1. **US-001: The session role claim comes from bindings** — `Workdir: apps/api` — No dependencies. `AuthService.roleClaim` / `userResponse` and an async `issueSession` derive the `role` claim and `UserResponseDto.role` with ruling 1 for register, login, refresh, invite acceptance and `GET /auth/me`; registration issues the session from the re-read user; `PrismaAuthRepository` and `createInvitedUser` stop reading and writing `User.role`; `findUserActor` derives the assistant principal's role.
2. **US-002: Token revocation follows global-admin bindings** — `Workdir: apps/api` — Depends on US-001. `MembershipService` revokes a user's tokens on a derived-role flip (ruling 2) through `PrismaRoleBindingRepository.bumpTokenVersion`; `setUserRole` goes; `findUserState` answers `UserAccountState`; specs stop asserting the stored `User.role`. Verification for the removals: `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint`.
3. **US-003: Drop `User.role` and `ProjectInvite.role`** — `Workdir: apps/api` — Depends on US-002. Migration `20261102090000_drop_legacy_role_columns` and its test; the users, invites, tickets, fixture and seed code lose the columns; specs stop writing `role` on user rows and legacy invites. Verification for the removals: `bun run --cwd apps/api db:generate`, then `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint`.
4. **US-004: Drop `ProjectMember`, `AgentProject` and `AgentRoleEntry`** — `Workdir: apps/api` — Depends on US-003. Migration `20261102090100_drop_legacy_membership_tables` and its test; the assignee repository leaves `ProjectMember`; `createMember`, `removeProjectBindings` and the legacy fields of `fixtureGrantReport` go; specs stop seeding and counting legacy rows. Verification for the removals: `bun run --cwd apps/api db:generate`, then `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint`.
5. **US-005: `koda auth me` drops the Role row** — `Workdir: apps/cli` — No dependencies.
6. **US-006: The web's `AuthUser` drops `role`** — `Workdir: apps/web` — No dependencies. Deletion only, no acceptance criteria (user ruling 2026-10-23). Verification for the removal: `bun run --cwd apps/web type-check` and `bun run --cwd apps/web lint`.

One capability (user-confirmed scope, ruling 2026-10-23): removing the legacy permission storage and the claims derived from it. The six stories are its API, CLI and web parts; the two schema stories are split by migration so each story's spec sweep fits one session.

### Context Files

**US-001**
- `apps/api/src/auth/auth.service.ts` — `register`, `issueSession`, edited here
- `apps/api/src/auth/auth.controller.ts` — `me`, edited here
- `apps/api/src/auth/prisma-auth.repository.ts` — the `role` reads and the first-user write, edited here
- `apps/api/src/fleet/assistant/prisma-assistant-tool-call.repository.ts` — `findUserActor`, edited here
- `apps/api/src/permissions/membership.service.ts` — `isGlobalAdmin`, read

**US-002**
- `apps/api/src/permissions/membership.service.ts` — `insertBinding`, `afterRemoval`, `syncLegacyRole`, edited here
- `apps/api/src/permissions/prisma-role-binding.repository.ts` — `setUserRole`, `findUserState`, edited here
- `apps/api/src/permissions/test-helpers/in-memory-permissions.ts` — the binding repository double, edited here
- `apps/api/src/permissions/permissions.types.ts` — `UserLegacyState`, edited here
- `apps/api/src/auth/token-version.cache.ts` — the two cache keys, read

**US-003**
- `apps/api/prisma/schema.prisma` — `User.role`, `ProjectInvite.role`, edited here
- `apps/api/src/projects/invites/prisma-project-invites.repository.ts` — `create`, `toRecord`, `legacyRoleNames`, edited here
- `apps/api/src/projects/invites/project-invites.service.ts` — `legacyNameOf`, the invite mail data, edited here
- `apps/api/src/users/prisma-users.repository.ts` — `toRecord`, `createUser`, `updateUser`, edited here
- `apps/api/test/integration/fleet/pending-action-drop-legacy-columns-migration.integration.spec.ts` — the migration-test pattern, read

**US-004**
- `apps/api/prisma/schema.prisma` — the three models and their relation fields, edited here
- `apps/api/src/projects/assignees/prisma-project-assignees.repository.ts` — the base class, edited here
- `apps/api/src/projects/assignees/domain/project-assignee.domain.ts` — `ProjectMembershipDomain`, edited here
- `apps/api/src/permissions/test-helpers/permission-fixtures.ts` — `fixtureGrantReport`, edited here
- `apps/api/src/permissions/membership.service.ts` — `removeProjectBindings`, deleted here

**US-005**
- `apps/cli/src/commands/auth.ts` — the `me` action, edited here
- `apps/cli/src/commands/auth.spec.ts` — the `me` cases, edited here

**US-006**
- `apps/web/composables/useAuth.ts` — `AuthUser`, edited here

### Creates

**US-001**
- `apps/api/test/integration/auth/role-claim-from-bindings.integration.spec.ts` — the US-001 integration ACs

**US-002**
- `apps/api/src/permissions/membership.service.token-revocation.spec.ts` — the US-002 unit ACs on `MembershipService` and `PrismaRoleBindingRepository.bumpTokenVersion`
- `apps/api/test/integration/permissions/global-admin-token-revocation.integration.spec.ts` — the US-002 integration ACs

**US-003**
- `apps/api/prisma/migrations/20261102090000_drop_legacy_role_columns/migration.sql` — the column drop
- `apps/api/test/integration/permissions/drop-legacy-role-columns-migration.integration.spec.ts` — the US-003 migration ACs

**US-004**
- `apps/api/prisma/migrations/20261102090100_drop_legacy_membership_tables/migration.sql` — the table drop
- `apps/api/test/integration/permissions/drop-legacy-membership-tables-migration.integration.spec.ts` — the US-004 migration ACs

**US-005**
- None.

**US-006**
- None.

### Modifies

**US-001**
- `apps/api/src/auth/auth.service.spec.ts` — the session cases build AuthService with a MembershipService double that has no isGlobalAdmin, read the role claim from the user row (mockUser role ADMIN for the first user, generateAccessToken called with mockUser.role) and treat issueSession as synchronous. The replacing invariant: the double gains isGlobalAdmin, the claim and the response role follow it, issueSession is awaited, and register asserts the session comes from findUserById after the transaction; the other cases are unchanged.
- `apps/api/src/auth/auth.controller.spec.ts` — the me cases expect UserResponseDto.from(validatedUser) of a row that carries role. The replacing invariant: me answers authService.userResponse(validatedUser), stubbed on the AuthService double; the other cases are unchanged.
- `apps/api/src/auth/prisma-auth.repository.spec.ts` — 'the first user is created as ADMIN' asserts user.create got role ADMIN and result.user.role is ADMIN, and the later cases read result.user.role. The replacing invariant: the first and later users are created with the given email, name and passwordHash only, and the returned UserDomain has no role; firstUser keeps telling them apart.
- `apps/api/src/projects/invites/invite-acceptance.service.spec.ts` — the AuthService double's issueSession is synchronous and builds the session user from UserDomain role, and the createInvitedUser double returns role MEMBER; the session expectation pins role MEMBER. The replacing invariant: issueSession is an async double answering role MEMBER for the new account, createInvitedUser returns no role, and the accept flow awaits it; every refusal case is unchanged.
- `apps/api/test/integration/fleet/assistant-action-actor.integration.spec.ts` — the findUserActor case expects role equal to the stored user.role. The replacing invariant: findUserActor answers id, email, disabled and role MEMBER for a user with no global owner or admin binding, and role ADMIN after a global admin binding is granted with grantRole.

**US-002**
- `apps/api/src/permissions/test-helpers/in-memory-permissions.ts` — bindingRepo() has setUserRole and a findUserState answering role, and users carry role. The replacing invariant: users are disabled plus tokenVersion, addUser(id, disabled = false), findUserState answers disabled only or null, and bumpTokenVersion increments tokenVersion, pushes tokens:userId onto store.calls, answers false for an unknown user, and rejects once with bumpTokenVersionFailure when that is set.
- `apps/api/src/permissions/membership.service.spec.ts` — the AC-18/19, B2 and removal cases assert store.users role ADMIN or MEMBER and call addUser(id, 'ADMIN'). The replacing invariant: each case asserts the tokenVersion and tokens:userId calls ruling 2 gives (a bump only on a flip), and admin users are made with a global admin binding; the setGlobalAdmin cases (a removal that deletes the admin binding bumps once, false for a member without a binding writes nothing and keeps tokenVersion 0, the legacy admin who held no binding) assert tokenVersion and tokens:userId only, the legacy-admin case expecting no bump; in the removeProjectBindings block the case that leaves a global admin alone keeps only its tokenVersion 1 and cache assertions, and the other removeProjectBindings cases are unchanged here (US-004 deletes the block).
- `apps/api/src/permissions/membership.service.removal-guards.spec.ts` — store.addUser('off', 'MEMBER', true) passes the removed role argument. The replacing invariant: store.addUser('off', true); the cases are unchanged.
- `apps/api/src/permissions/role-matrix.spec.ts` — store.addUser(id, 'MEMBER') passes the removed role argument. The replacing invariant: store.addUser(id); the matrix is unchanged.
- `apps/api/src/permissions/role-admin.service.spec.ts` — the case at store.addUser('target-1', 'ADMIN') asserts the target's stored role becomes MEMBER. The replacing invariant: the target holds a global admin binding, and the case asserts its tokenVersion was bumped once after the removal.
- `apps/api/src/permissions/permission.service.spec.ts` — store.addUser('legacy', 'ADMIN') proves a stored ADMIN role grants nothing. The replacing invariant: the case and the legacy user go; a user with no binding holds no key is pinned by the other cases.
- `apps/api/test/integration/permissions/membership-service.integration.spec.ts` — the mirror cases assert userRow(...).role ADMIN or MEMBER and objectContaining role ADMIN with tokenVersion 1. The replacing invariant: each asserts the stored tokenVersion ruling 2 gives (grant to a user with no global admin binding bumps it, a second global admin binding or a project binding does not, the last removal bumps it); the legacy-admin setGlobalAdmin case (a user with no binding) asserts tokenVersion unchanged instead of role MEMBER; the newUser(role) helper's role argument is unchanged here (US-003 removes it).
- `apps/api/test/integration/permissions/role-bindings-api.integration.spec.ts` — the cases at userRow(adminTargetBId).role ADMIN then MEMBER, and userRow(target.id).role MEMBER, pin the mirror. The replacing invariant: the same requests assert the target's stored tokenVersion rose by one on the grant and again on the last removal.
- `apps/api/test/integration/permissions/membership-notification-consumers.integration.spec.ts` — the case asserting the admin's stored role is ADMIN pins the mirror. The replacing invariant: that assertion goes; the recipient assertions are unchanged.
- `apps/api/test/integration/auth/registration.integration.spec.ts` — users[0].role toBe ADMIN reads the mirror, and the open-registration case counts users with role ADMIN (expects 1). The replacing invariant: the first user holds a global owner binding, asserted on roleBinding, and the open-registration case counts users holding a global owner binding on roleBinding (exactly one).
- `apps/api/test/integration/seed/seed-admin.integration.spec.ts` — user.role toBe ADMIN reads the stored role the fixture mirror wrote. The replacing invariant: the created admin holds the owner (or admin) binding, already asserted on roleBinding; the stored-role assertions go.
- `apps/api/test/integration/permissions/permission-fixtures.integration.spec.ts` — the grantRole cases assert the user row's role is ADMIN or MEMBER after a grant. The replacing invariant: those assertions go; the binding assertions stay (US-003 removes the mirror itself and US-004 the legacy report fields).
- `apps/api/test/integration/permissions/core-admin-public-implicit.integration.spec.ts` — roleOf reads the stored role (AC-3 before and after, AC-5 gadmin ADMIN). The replacing invariant: roleOf goes; AC-3 asserts the target holds no global admin binding before and after, and AC-5 asserts gadmin still holds its global admin binding.
- `apps/api/test/integration/permissions/user-agent-no-legacy-roles.integration.spec.ts` — stored.role toBe MEMBER reads the column. The replacing invariant: the user holds only the global member binding, asserted on roleBinding.
- `apps/api/test/integration/projects/member-role-keys.integration.spec.ts` — stored.role toBe MEMBER reads the column. The replacing invariant: that assertion goes; the binding assertions stay.
- `apps/api/test/integration/projects/project-invites-public.integration.spec.ts` — users[0].role toBe MEMBER reads the column. The replacing invariant: that assertion goes; the accepted user's bindings are asserted as before.
- `apps/api/test/integration/permissions/project-read-recipients.integration.spec.ts` — roleAdminWithoutBinding.role toBe ADMIN reads the column. The replacing invariant: that assertion goes; the eligibility assertion is unchanged.
- `apps/api/test/integration/vcs/vcs-permissions.integration.spec.ts` — user.role toBe MEMBER reads the column. The replacing invariant: that assertion goes.
- `apps/api/test/integration/users/admin-users.integration.spec.ts` — two cases count users with role ADMIN and disabled false (expect 2, then 1), which the mirror and the column fed. The replacing invariant: both count the enabled users holding a global owner or admin binding, read from roleBinding as PrismaUsersRepository.countActiveAdmins reads it, with the same expected values 2 and 1.
- `apps/api/test/integration/fleet/fleet-fixtures-bindings.integration.spec.ts` — the admin's stored role toBe ADMIN reads the fixture mirror. The replacing invariant: the admin holds a global admin binding, asserted on roleBinding.

**US-003**
- `apps/api/test/integration/auth/role-claim-from-bindings.integration.spec.ts` — US-001 AC-4 and AC-13 create a user row with role ADMIN to prove the claim ignores it, which the dropped column refuses. The replacing invariant: those users are created without role, and the cases still assert the claim MEMBER for a user with no global owner or admin binding.
- `apps/api/src/users/users-admin.service.spec.ts` — 'create' expects repo.createUser called with role MEMBER. The replacing invariant: createUser is called with email, name and passwordHash only.
- `apps/api/src/projects/invites/project-invites.service.spec.ts` — the invite-create case expects invites.create with role ADMIN and roleId, and doubles carry role. The replacing invariant: invites.create gets roleId and no role; the mail data role is the role name, or empty when roleName is null.
- `apps/api/src/projects/invites/prisma-project-invites.repository.spec.ts` — the row fixture carries role DEVELOPER, the create case lists role among the written fields, the no-roleId case expects roleKey and roleName from the legacy role, and the role-fields case expects role null in the record. The replacing invariant: rows and records carry no role, create writes none, and a row without an assigned role answers roleKey and roleName null.
- `apps/api/src/projects/invites/domain/project-invite.domain.spec.ts` — the record fixture carries role DEVELOPER. The replacing invariant: the fixture has no role.
- `apps/api/test/integration/projects/invite-role-keys.integration.spec.ts` — AC-6 accepts an invite with roleId null and role VIEWER, and AC-7 creates one with role null; both write the dropped column. The replacing invariant: AC-6 goes (no legacy role can stand in), AC-7 creates the invite with roleId null and no role and still answers 409 invites.roleGone, and the stored-role reads (stored role toBeNull, and the invite rows mapped to role equal VIEWER) go while their roleId and roleKey assertions stay.
- `apps/api/test/integration/agents/agents-create-rollback.integration.spec.ts` — its user fixture is created with role ADMIN. The replacing invariant: the user is created without role and given a global admin binding with grantRole.
- `apps/api/test/integration/fleet/assistant-action-delivery.integration.spec.ts` — prisma.user.create sends role ADMIN. The replacing invariant: the user is created without role; any access it needs comes from grantRole.
- `apps/api/test/integration/fleet/assistant-action-send-delivery.integration.spec.ts` — prisma.user.create sends role ADMIN. The replacing invariant: the user is created without role; any access it needs comes from grantRole.
- `apps/api/test/integration/fleet/assistant-tool-executor.integration.spec.ts` — prisma.user.create sends role MEMBER. The replacing invariant: the user is created without role.
- `apps/api/test/integration/fleet/assistant-workspace-project-argument.integration.spec.ts` — prisma.user.create sends role MEMBER. The replacing invariant: the users are created without role.
- `apps/api/test/integration/fleet/assistant-workspace-tools.integration.spec.ts` — prisma.user.create sends role MEMBER. The replacing invariant: the user is created without role.
- `apps/api/test/integration/fleet/fleet-ingest-schema.integration.spec.ts` — prisma.user.create sends role ADMIN. The replacing invariant: the user is created without role.
- `apps/api/test/integration/fleet/fleet-job-logs-schema.integration.spec.ts` — prisma.user.create sends role ADMIN. The replacing invariant: the user is created without role.
- `apps/api/test/integration/fleet/fleet-job-repository.integration.spec.ts` — prisma.user.create sends role ADMIN. The replacing invariant: the user is created without role.
- `apps/api/test/integration/fleet/fleet-jobs-schema.integration.spec.ts` — prisma.user.create sends role ADMIN. The replacing invariant: the user is created without role.
- `apps/api/test/integration/fleet/fleet-project-code-repository.integration.spec.ts` — prisma.user.create sends role ADMIN. The replacing invariant: the user is created without role.
- `apps/api/test/integration/fleet/fleet-schedule-repository.integration.spec.ts` — prisma.user.create sends role MEMBER. The replacing invariant: the users are created without role.
- `apps/api/test/integration/fleet/fleet-schedule-ticker.integration.spec.ts` — the user helper's prisma.user.create sends role MEMBER. The replacing invariant: the helper creates users without role.
- `apps/api/test/integration/fleet/fleet-schedules-api.integration.spec.ts` — prisma.user.create sends role MEMBER. The replacing invariant: the user is created without role.
- `apps/api/test/integration/fleet/fleet-tickets-repository.integration.spec.ts` — prisma.user.create sends role ADMIN. The replacing invariant: the user is created without role.
- `apps/api/test/integration/fleet/fleet-tickets-schema.integration.spec.ts` — prisma.user.create sends role ADMIN. The replacing invariant: the user is created without role.
- `apps/api/test/integration/permissions/bindings-only-permissions.integration.spec.ts` — the user helper's create sends role. The replacing invariant: users are created without role; the legacy-row cases are unchanged here (US-004 removes them).
- `apps/api/test/integration/permissions/bootstrap-baselines.integration.spec.ts` — the createUser helper writes role MEMBER or ADMIN on the row. The replacing invariant: the helper takes no role; an admin is given a global admin binding with grantRole.
- `apps/api/test/integration/permissions/core-seeded-roles.integration.spec.ts` — the user helper's create sends role MEMBER. The replacing invariant: users are created without role.
- `apps/api/test/integration/permissions/enforce-fleet-foundations.integration.spec.ts` — the user helper's create sends role MEMBER. The replacing invariant: users are created without role.
- `apps/api/test/integration/permissions/enforce-fleet-requesters.integration.spec.ts` — prisma.user.create sends role MEMBER. The replacing invariant: the user is created without role.
- `apps/api/test/integration/permissions/membership-notification-consumers.integration.spec.ts` — the user helper's create sends role MEMBER. The replacing invariant: users are created without role.
- `apps/api/test/integration/permissions/membership-service.integration.spec.ts` — newUser(role) writes role on the row. The replacing invariant: newUser takes no role; admins are given a global admin binding.
- `apps/api/test/integration/permissions/permission-fixtures.integration.spec.ts` — the user helper's create sends role, and a case updates the user row to role MEMBER. The replacing invariant: users are created without role and the role update goes; the grantRole cases assert the user's tokenVersion is unchanged by a grant.
- `apps/api/test/integration/permissions/permission-service.integration.spec.ts` — newUser(role) writes role on the row. The replacing invariant: newUser takes no role; a case that relied on a stored ADMIN role granting nothing goes.
- `apps/api/test/integration/permissions/project-read-recipients.integration.spec.ts` — newUser(role, disabled) writes role on the row. The replacing invariant: newUser(disabled) creates users without role.
- `apps/api/test/integration/projects/member-bindings.integration.spec.ts` — db.user.create sends role MEMBER for three users. The replacing invariant: the users are created without role.
- `apps/api/test/integration/projects/project-invites-public.integration.spec.ts` — the taken-email user is created with role MEMBER. The replacing invariant: it is created without role.
- `apps/api/test/integration/projects/project-members-principals.integration.spec.ts` — the chip users are created with role MEMBER. The replacing invariant: they are created without role.
- `apps/api/test/integration/projects/project-members.integration.spec.ts` — the co-admin is created with role MEMBER. The replacing invariant: it is created without role.
- `apps/api/test/integration/tickets/ticket-tenancy.integration.spec.ts` — the user is created with role MEMBER. The replacing invariant: it is created without role.
- `apps/api/test/integration/fleet/thread-creator-type.integration.spec.ts` — the findCallContext case expects creator role equal to the stored user.role, a column that is gone. The replacing invariant: the expected creator role is the literal MEMBER (the dev user holds no global owner or admin binding); the raw INSERT on the older scratch schema is unchanged.
- `apps/api/test/integration/permissions/roles-api.integration.spec.ts` — a principal is built with role from the Prisma user row, a column that is gone. The replacing invariant: the principal role is the literal MEMBER.
- `apps/api/test/integration/permissions/membership-queries.integration.spec.ts` — a principal is built with role from the Prisma user row, a column that is gone. The replacing invariant: the principal role is the literal MEMBER; the legacy-row cases are unchanged here (US-004 removes them).
- `apps/api/test/integration/permissions/member-invite-role-keys-only.integration.spec.ts` — it expects the stored invite role DEVELOPER, a column that is gone. The replacing invariant: that assertion goes; the roleId assertion stays.

**US-004**
- `apps/api/src/permissions/membership.service.spec.ts` — the removeProjectBindings describe block tests the deleted method. The replacing invariant: the block goes; the other cases are unchanged.
- `apps/api/src/permissions/test-helpers/in-memory-permissions.ts` — bindingRepo() keeps deleteProjectBindings for the deleted method. The replacing invariant: deleteProjectBindings goes.
- `apps/api/src/common/test-helpers/global-stubs.module.ts` — the MembershipService stub has removeProjectBindings, and mockPrismaService stubs a projectMember delegate. The replacing invariant: both go.
- `apps/api/src/projects/members/project-members.service.spec.ts` — a double or assertion names removeProjectBindings. The replacing invariant: it goes; the add and list cases are unchanged.
- `apps/api/src/projects/invites/invite-acceptance.service.spec.ts` — the members repository double has createMember. The replacing invariant: createMember goes from the double.
- `apps/api/src/projects/assignees/prisma-project-assignees.repository.spec.ts` — it constructs PrismaProjectAssigneesRepository with a transaction manager first, the AbstractPrismaRepository constructor argument that goes. The replacing invariant: it constructs the repository with the PrismaService double only; the search cases are unchanged.
- `apps/api/prisma/seed-e2e-data.ts` — wipe calls agentRoleEntry.deleteMany on the dropped table. The replacing invariant: that line goes; the wipe order is otherwise unchanged.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the agent cases count agentRoleEntry and agentProject rows and read a projectMember row. The replacing invariant: those reads go; the cases assert the agent's and member's role bindings instead, or keep only their response assertions.
- `apps/api/test/integration/agents/agents-create-rollback.integration.spec.ts` — the rollback cases expect agentRoleEntry.count 0. The replacing invariant: those assertions go; the agent and binding counts stay.
- `apps/api/test/integration/email/email-schedule.integration.spec.ts` — it expects projectMember.count and agentRoleEntry.count 0. The replacing invariant: those assertions go.
- `apps/api/test/integration/fleet/fleet-fixtures-bindings.integration.spec.ts` — it expects agentRoleEntry.count 0 for a created agent. The replacing invariant: that assertion goes.
- `apps/api/test/integration/fleet/permissions-assistant-tools.integration.spec.ts` — it expects projectMember.count 0. The replacing invariant: that assertion goes.
- `apps/api/test/integration/fleet/permissions-mcp-tools.integration.spec.ts` — it expects agentProject and agentRoleEntry counts 0. The replacing invariant: those assertions go.
- `apps/api/test/integration/fleet/permissions-project-threads.integration.spec.ts` — it expects projectMember.count 0. The replacing invariant: that assertion goes.
- `apps/api/test/integration/fleet/permissions-workspace-threads.integration.spec.ts` — it expects projectMember.count 0 twice. The replacing invariant: those assertions go.
- `apps/api/test/integration/memory/permissions-memory-routes.integration.spec.ts` — it expects projectMember.count 0. The replacing invariant: that assertion goes.
- `apps/api/test/integration/permissions/bindings-only-permissions.integration.spec.ts` — the cases create projectMember, agentProject and agentRoleEntry rows to prove they grant nothing. The replacing invariant: those cases go; the binding cases stay.
- `apps/api/test/integration/permissions/core-agent-routes.integration.spec.ts` — it creates agentRoleEntry rows and counts agentProject rows. The replacing invariant: the legacy rows and counts go; the route assertions on bindings stay.
- `apps/api/test/integration/permissions/core-members-invites.integration.spec.ts` — it reads projectMember rows and creates an agentProject row. The replacing invariant: membership is read from roleBinding and the agentProject setup goes.
- `apps/api/test/integration/permissions/enforce-fleet-global.integration.spec.ts` — it expects projectMember and agentRoleEntry counts 0. The replacing invariant: those assertions go.
- `apps/api/test/integration/permissions/enforce-fleet-schedules.integration.spec.ts` — it expects projectMember.count 0 twice. The replacing invariant: those assertions go.
- `apps/api/test/integration/permissions/me-permissions.integration.spec.ts` — it counts projectMember and agentProject rows. The replacing invariant: those counts go.
- `apps/api/test/integration/permissions/membership-agent-roster.integration.spec.ts` — the legacy helper creates and updates agentProject rows and a case counts them. The replacing invariant: the legacy helper and its cases go; the binding roster cases stay.
- `apps/api/test/integration/permissions/membership-fleet-consumers.integration.spec.ts` — it expects projectMember.count 0. The replacing invariant: that assertion goes.
- `apps/api/test/integration/permissions/membership-notification-consumers.integration.spec.ts` — it expects projectMember.count 0 twice. The replacing invariant: those assertions go.
- `apps/api/test/integration/permissions/membership-project-access.integration.spec.ts` — it creates projectMember rows and counts them. The replacing invariant: the legacy setups and counts go; the binding access cases stay.
- `apps/api/test/integration/permissions/membership-queries.integration.spec.ts` — its helpers create projectMember and agentProject rows, a case deletes them, and a case calls removeProjectBindings. The replacing invariant: the legacy helpers, their cases and the removeProjectBindings case go; the binding query cases stay.
- `apps/api/test/integration/permissions/membership-ticket-consumers.integration.spec.ts` — it creates projectMember rows and counts them. The replacing invariant: the legacy setups and counts go; the binding cases stay.
- `apps/api/test/integration/permissions/permission-fixtures.integration.spec.ts` — it deletes agentRoleEntry, projectMember and agentProject rows and asserts legacyMemberships and agentRoleEntries. The replacing invariant: those deletes and fields go; fixtureGrantReport is asserted on hasGlobalBinding and globalProjectRoleBindings.
- `apps/api/test/integration/permissions/project-read-assignees.integration.spec.ts` — it creates projectMember and agentProject rows to prove they are not assignees. The replacing invariant: those cases go; the binding cases stay.
- `apps/api/test/integration/permissions/project-read-recipients.integration.spec.ts` — it creates projectMember rows to prove they are not recipients. The replacing invariant: those cases go.
- `apps/api/test/integration/permissions/user-agent-no-legacy-roles.integration.spec.ts` — it expects agentRoleEntry.count 0. The replacing invariant: that assertion goes.
- `apps/api/test/integration/projects/member-bindings.integration.spec.ts` — legacyCount and the cases that create projectMember rows read the dropped table. The replacing invariant: legacyCount and those cases go; the binding assertions stay.
- `apps/api/test/integration/projects/project-invites-admin.integration.spec.ts` — it expects projectMember.count 0. The replacing invariant: that assertion goes.
- `apps/api/test/integration/projects/project-invites-public.integration.spec.ts` — it expects projectMember.count values. The replacing invariant: those assertions go; the binding assertions stay.
- `apps/api/test/integration/projects/project-members-principals.integration.spec.ts` — it creates a projectMember row. The replacing invariant: that setup and the case built on it go.
- `apps/api/test/integration/projects/project-membership-gate.integration.spec.ts` — it expects projectMember.count 0 twice. The replacing invariant: those assertions go.
- `apps/api/test/integration/rag/permissions-kb-routes.integration.spec.ts` — it expects projectMember.count 0. The replacing invariant: that assertion goes.
- `apps/api/test/integration/skills/project-skills-routes.integration.spec.ts` — it expects projectMember.count 0. The replacing invariant: that assertion goes.
- `apps/api/test/integration/vcs/vcs-permissions.integration.spec.ts` — it expects projectMember, agentProject and agentRoleEntry counts 0. The replacing invariant: those assertions go.
- `apps/api/test/integration/vcs/vcs-webhook-secret.integration.spec.ts` — it expects agentProject and agentRoleEntry counts 0. The replacing invariant: those assertions go.

**US-005**
- None. The `me` cases in `auth.spec.ts` assert only the API call, the exit code and the JSON output, so the table change breaks none of them; US-005 adds its own cases to that file.

**US-006**
- None. Nothing in `apps/web` reads `AuthUser.role`.

### Seams

- **`AuthService.userResponse` (US-001 producer and consumer).** `AuthController.me` is its route caller; US-001 AC-5 reaches it through `GET /auth/me`.
- **`PrismaRoleBindingRepository.bumpTokenVersion` (US-002 producer and consumer).** `MembershipService` is its only caller; US-002 AC-9 to AC-11 reach it through `POST /role-bindings` and `DELETE /role-bindings/:id`.
- No symbol crosses a story boundary: US-003 and US-004 only remove code, and US-005 and US-006 read nothing the API stories add.

## Acceptance Criteria

Every DB-backed AC seeds the system roles (`ensureSystemRoles` or a booted app). "Decoded claim" is the `role` field of the access token's JWT payload. "A global admin binding" is a binding with `principalType` `USER`, `projectId` null and role key `admin`.

### US-001

1. [integration] `POST /auth/register` on an empty users table answers `data.user.role` `'ADMIN'`.
2. [integration] The access token from that response is accepted by `GET /auth/me` with 200.
3. [integration] With registration enabled (`bootHttpApp({ registrationEnabled: true })`), a second `POST /auth/register` answers the decoded claim `'MEMBER'`.
4. [integration] `POST /auth/login` of a user whose stored `User.role` is `'ADMIN'` and who holds no global `owner` or `admin` binding answers the decoded claim `'MEMBER'`.
5. [integration] `GET /auth/me` for a user holding a global admin binding (granted with `grantRole`) answers `data.role` `'ADMIN'`.
6. [integration] `POST /auth/login` of a user whose only non-baseline binding is `project-admin` in one project answers the decoded claim `'MEMBER'`.
7. [integration] After the user's global admin binding row is deleted directly with the Prisma client (no `tokenVersion` change), `POST /auth/refresh` with the user's refresh token answers the decoded claim `'MEMBER'`.
8. [integration] `POST /invites/:token/accept` for a new address answers `data.user.role` `'MEMBER'`.
9. [unit] `AuthService.roleClaim('u1')` answers `'ADMIN'` when the `MembershipService` double's `isGlobalAdmin` resolves `true`.
10. [unit] `AuthService.roleClaim('u1')` answers `'MEMBER'` when `isGlobalAdmin` resolves `false`.
11. [unit] `AuthService.login` rejects with the error `isGlobalAdmin` rejects with, and the access-token strategy's `sign` is not called.
12. [unit] `PrismaAuthRepository.findAnyUserAndCreate` on an empty table calls `user.create` with `data` equal to `{ email, name, passwordHash }` as given.
13. [integration] `PrismaAssistantToolCallRepository.findUserActor(userId)` for a user whose stored `User.role` is `'ADMIN'` and who holds no global `owner` or `admin` binding answers `role` `'MEMBER'`.
14. [integration] `findUserActor(userId)` for a user holding a global admin binding answers `role` `'ADMIN'`.

### US-002

1. [unit] Over `InMemoryPermissionStore`, `MembershipService.createBinding` of a global `admin` binding for a user holding no global `owner` or `admin` binding records `tokens:<userId>` once in `store.calls`.
2. [unit] The same call for a user already holding a global `owner` binding records no `tokens:<userId>`.
3. [unit] `createBinding` of a `project-admin` binding in a project records no `tokens:<userId>`.
4. [unit] `createBinding` that finds an identical existing global `admin` binding records no `tokens:<userId>`.
5. [unit] `MembershipService.removeBinding(id)` of a user's only global `owner`/`admin` binding records `tokens:<userId>` once.
6. [unit] `removeBinding(id)` of a user's global `admin` binding while it keeps a global `owner` binding records no `tokens:<userId>`.
7. [unit] `MembershipService.removeAllBindings` of a user holding a global `admin` binding records `tokens:<userId>` once.
8. [unit] After a `createBinding` that recorded `tokens:<userId>`, the `CacheManager` double's `invalidate` was called with `userAuthStateCacheKey(userId)`.
9. [integration] After `POST /role-bindings` grants a global admin binding to a member, `GET /auth/me` with the member's access token issued before the grant answers 401.
10. [integration] After `DELETE /role-bindings/:id` removes a user's last global admin binding, `GET /auth/me` with that user's access token issued before the removal answers 401.
11. [integration] After `POST /role-bindings` grants a `developer` binding in a project to a member, `GET /auth/me` with the member's access token issued before the grant answers 200.
12. [unit] With `store.bumpTokenVersionFailure` set to an error, `createBinding` of a global `admin` binding for a user holding none rejects with that error.
13. [unit] `PrismaRoleBindingRepository.bumpTokenVersion('u1')` calls `user.updateMany` with `{ where: { id: 'u1' }, data: { tokenVersion: { increment: 1 } } }`.
14. [unit] `bumpTokenVersion('u1')` answers `false` when `user.updateMany` resolves `{ count: 0 }`.
15. [unit] Over `InMemoryPermissionStore`, `MembershipService.setGlobalAdmin('u1', false, granter)` for a user holding no global `admin` binding records no `tokens:u1` in `store.calls`.

### US-003

1. [integration] On a scratch schema migrated up to `20261102090000_drop_legacy_role_columns` with one `User` row whose `role` is `'ADMIN'`, applying the migration leaves `information_schema.columns` with no `role` column for table `User`.
2. [integration] The same migration leaves no `role` column for table `ProjectInvite`.
3. [integration] The `User` row keeps its `id`, `email`, `tokenVersion` and `disabled` values.
4. [integration] A `ProjectInvite` row inserted before the migration keeps its `roleId`, `status` and `tokenHash` values.
5. [integration] `POST /admin/users` as an Owner answers 201, and `POST /auth/login` of the created user answers the decoded claim `'MEMBER'`.
6. [integration] `GET /projects/:slug/invites` lists an invite whose `roleId` is null with `roleKey` null and `roleName` null.
7. [integration] `POST /invites/:token/accept` for an invite whose `roleId` is null answers 409 `invites.roleGone` and creates no user.
8. [unit] `ProjectInvitesService` inviting a new address with `roleKey` `'developer'` calls the repository's `create` with the `developer` role's `roleId` and an input that has no `role` property.
9. [unit] The `InviteMailer.sendInvite` input for that invite carries `role` `'Developer'`, the invited role's name.
10. [unit] The `InviteMailer.sendInvite` input for an invite record whose `roleName` is null carries `role` `''`.
11. [integration] Regression pin (passes before the change too): `grantRole(db, user, 'admin')` creates one global admin binding and leaves the user's stored `tokenVersion` unchanged.
12. [integration] Regression pin (passes before the change too): `POST /projects/:slug/tickets/:ref/assign` with the `userId` of an enabled user holding a `developer` binding in the project answers the ticket with `assignedToUserId` equal to that user's id.

### US-004

1. [integration] On a scratch schema migrated up to `20261102090100_drop_legacy_membership_tables` with one row each in `ProjectMember`, `AgentProject` and `AgentRoleEntry`, applying the migration leaves no table named `ProjectMember` in `information_schema.tables`.
2. [integration] The same migration leaves no table named `AgentProject`.
3. [integration] The same migration leaves no table named `AgentRoleEntry`.
4. [integration] A `RoleBinding` row inserted before the migration is still there, with its `principalId`, `roleId` and `projectId` unchanged.
5. [integration] The `User`, `Agent` and `Project` rows the legacy rows referenced are still there.
6. [integration] Regression pin (passes before the change too): `GET /projects/:slug/assignees?q=` answers a user holding a `developer` binding in the project and an `ACTIVE` agent holding a `developer` binding there, users first.
7. [integration] `fixtureGrantReport(db, user)` for a user holding only the global `member` binding answers `{ hasGlobalBinding: true, globalProjectRoleBindings: 0 }`.
8. [integration] Regression pin (passes before the change too): `seedE2e(db)` run twice in a row leaves exactly one user with the email `admin@koda-e2e.test`.

### US-005

1. [unit] `koda auth me` without `--json` calls `table` with headers `['Field', 'Value']` and the rows `[['ID', 'u-1'], ['Email', 'user@example.com'], ['Name', 'Alice']]` when the API answers a user that also carries `role`.
2. [unit] `koda auth me --json` prints `JSON.stringify(data, null, 2)` of the API's `data`, `role` included.

### US-006

None (deletion only; verified by `bun run --cwd apps/web type-check` and `bun run --cwd apps/web lint`).
