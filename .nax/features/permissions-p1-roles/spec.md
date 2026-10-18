<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Permissions P1a — Permission Catalog, Roles, Bindings and Their API

## Summary

This feature adds the data model and services for koda's new permission system to `apps/api`. It is purely additive:
- **`PERMISSION_CATALOG`** — one permission key per action, in code.
- **`Role`** — a named list of permission entries, stored in the database.
- **`RoleBinding`** — a role given to a user or an agent, in one project or globally.
- **Seeded system roles.**
- **`PermissionService`** — answers "may this principal use this key here?"
- **`MembershipService`** — owns every read and write of bindings.
- **Owner bootstrap and baseline bindings**, on registration, admin user creation and agent creation.
- **REST APIs** to manage roles (`/roles`) and bindings (`/role-bindings`), with rules against escalation, self-binding and Owner removal.

No existing permission decision moves to the new model in this feature, with one exception. Global admin bindings are kept in step with the legacy `User.role` column, so a global `owner` or `admin` binding made through the new API is honoured by today's checks.

Project and agent memberships, the compatibility layer and every existing membership reader move to bindings in the next feature, `permissions-p1-membership`.

This is the first of six features implementing phase P1 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md`.

## Motivation

koda decides permissions in four places that disagree:
- the CASL ability factory;
- `@ProjectRoles` with `exemptAgents`;
- the fleet `requireUser` helpers;
- the assistant tool `permission.kind`.

Agent roles are global (`AgentRoleEntry`), and agent project access is a role-less roster row (`AgentProject`). The whole-repo review (`docs/20261018-review-whole-repo.md`) traced several authorization gaps to this split.

The user ruled (2026-10-18) that these gaps are fixed by one redesign: one permission catalog, roles as data, and one binding model for users and agents. Roles and bindings must exist, and be manageable, before any check can move onto them. This feature builds that base.

**Rulings that bind this feature** (user, 2026-10-18; the design doc's Decisions table):
- **One role system** for users and agents. A binding is per project, or global (`projectId` null).
- **A PROJECT-scope role bound globally** (`projectId` null) applies in every project. Creating such a binding needs `role.binding.global`.
- **Baseline roles.** Every new user gets the global `member` role. Every new agent gets the global `agent` role.
- **No data migration.** koda has no production use. Old tables stay in place, nothing is copied into bindings, and `permissions-p1-cleanup` drops them later.
- **Owner bootstrap.**
  - The first user to register gets the `owner` role.
  - When `KODA_OWNER_EMAIL` is set, only that email may take the first registration.
  - With `NODE_ENV=production`, the API refuses to start without `KODA_OWNER_EMAIL`.
- **No privilege escalation through configuration.** Nobody can grant or write into a role a key they do not hold. Nobody can bind themselves. The last Owner cannot be removed.

## Design

### Rulings that bind every story

1. **All new code lives in `apps/api/src/permissions/`** as `PermissionsModule`.
   - It is `@Global()`. It exports only `PermissionService`, `MembershipService` and `RoleAdminService`.
   - Its repositories (ruling 6) are module-private and are the only code that touches `Role` or `RoleBinding` through Prisma.
   - Every consumer injects the services without `@Optional()`.
2. **Effective permissions are cached** in the existing in-memory `CacheManager`, under the tag `permissions`, with a 60 000 ms TTL. Every `Role` or `RoleBinding` write invalidates the tag inside the same service call. The API runs as a single instance.
3. **Global admin status is the union** of a `projectId`-null `owner` or `admin` binding and the legacy `User.role = 'ADMIN'`.
   - `MembershipService` keeps the two in step for USER principals. Creating such a binding sets `User.role = 'ADMIN'`. Deleting the user's last one sets `User.role = 'MEMBER'`.
   - So the legacy checks, which read the JWT `role` claim and `User.role`, honour new bindings, and a removed binding cannot leave a legacy admin behind.
4. **The new routes do not use the legacy decorators.** They call `PermissionService` through `RoleAdminService.assertCan`, instead of `@RequiredPermission` or `@ProjectPermission`, which `.nax/rules/api-core.md` would otherwise require.
   - This is a deliberate, scoped exception. These routes are the first ones on the new model, and the legacy CASL factory has no notion of roles or bindings.
   - Every other `.nax/rules/api-controllers.md` convention still applies: the JSON envelope, `@ApiTags`, `@ApiBearerAuth`, `@ApiOperation`, `@ApiResponse`, `@ApiProperty` on every response DTO field, and app exceptions.
5. **i18n and exceptions.**
   - Every new message lives in the new files `apps/api/src/i18n/en/permissions.json` and `apps/api/src/i18n/zh/permissions.json`, with English as the source.
   - A code written in this spec as `permissions.<code>` with status `<s>` means `new <XAppException>({}, 'permissions.<code>')` from `@nathapp/nestjs-common`. Its message lives at the nested i18n key `permissions.<code>.<s>`, the shape of `users.json` with `lastAdmin.409`.
   - A bare `permissions` 403 means `new ForbiddenAppException({}, 'permissions')`, with its message at `permissions.403`.
   - Each code's exception class and status are given in "Failure Handling".
6. **Repositories follow `.nax/rules/api-data.md`.**
   - `PrismaRoleRepository` and `PrismaRoleBindingRepository` each extend `AbstractPrismaRepository` from `@nathapp/nestjs-prisma`.
   - Their domain types are `RoleDomain` and `RoleBindingDomain`, plain interfaces.
   - Each is registered behind a symbol token: `ROLE_REPOSITORY`, `ROLE_BINDING_REPOSITORY`.
   - Escape-hatch methods (row locks, `User.role` writes, user and agent existence checks) live on the concrete classes.
7. **Bounded reads.**
   - `Role` is a small, admin-written table. `GET /roles` reads it with `take: 500`.
   - `GET /role-bindings` and `MembershipService.listBindings` are paginated with `IPageOption` (`current`, `size`; default size 50, max 200). They answer `IPageResult`, the shape of `GET /projects/:slug/members`.
8. **Order of checks on every new write route:**
   1. the route's permission key(s) (`assertCan`);
   2. input validation and lookups (DTO, role, project, principal, scope match, principal type);
   3. self-binding;
   4. escalation;
   5. Owner lock.

   The first failing step decides the response.
9. **Test setup.** `test/helpers/reset-db.ts` truncates every table, so a test that needs the system roles runs `SystemRoleSeeder.onApplicationBootstrap()` after the reset, or boots the app.

### Catalog

`apps/api/src/permissions/catalog.ts` exports `PERMISSION_CATALOG: readonly PermissionCatalogEntry[]` and `findCatalogEntry(key: string): PermissionCatalogEntry | undefined`.

```ts
export type ApprovalMode = 'none' | 'self' | 'agent' | 'human';
export type KeyScope = 'global' | 'project' | 'any';
export interface PermissionCatalogEntry {
  key: string;                               // resource.verb[.qualifier]
  scope: KeyScope;
  access: 'role' | 'implicit' | 'public' | 'runner' | 'system';
  risk: 'low' | 'medium' | 'high' | 'critical';
  principals: readonly ('user' | 'agent')[];
  ownable: boolean;
  approval: { approvable: boolean; floor: ApprovalMode; default: ApprovalMode }; // placeholders until phase P3
}
```

**Keys:**
- Every key in the `proposed_key` column of `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv`. A cell may hold several keys separated by `;`.
- Plus these new keys:
  - `role.read`, `role.manage`
  - `role.binding.manage`, `role.binding.global`, `role.binding.owner`
  - `approval.decide`, `approval.policy.read`, `approval.policy.manage`
  - `audit.read`
  - `memory.update`

**How fields are derived.** Rules apply in order; the first match decides `access`.

| Rule | Keys | `access` | `scope` | `ownable` |
|:--|:--|:--|:--|:--|
| 1 | key starts with `runner.` | `runner` | `any` | false |
| 2 | key starts with `system.` | `system` | `any` | false |
| 3 | `PUBLIC_KEYS`: `session.login`, `session.refresh`, `auth.register`, `auth.registration.read`, `health.read`, `invite.preview`, `invite.accept` | `public` | `any` | false |
| 4 | `IMPLICIT_KEYS`: `auth.me.read`, `session.logout`, `home.read`, `notification.read`, `notification.mark-read`, `notification.preference.read`, `notification.preference.update`, `agent.self.read`, `assistant.action.read`, `mcp.access` | `implicit` | `any` | false |
| 5 | every other key | `role` | see below | key is in `OWNABLE_KEYS` |

**Scope for `role` keys.**
- Keys in `OWNABLE_KEYS` take `any`.
- For other keys, take every TSV row of the key:
  - a row whose `catalog_scope` is `runner` counts as `global` (these are the admin runner routes, such as `fleet.runner.update`);
  - rows whose `catalog_scope` is `system`, `public` or `implicit` are ignored.

  Then:
- only `project` rows → `project`;
- only `global` rows → `global`;
- a mix of `project` and `global`, or any `own (see design §1)` row → `any`.

New keys take `global`, except `role.binding.manage`, `approval.decide` and `approval.policy.read`, which take `project`, and `approval.policy.manage`, which takes `any`. `memory.update` is in `OWNABLE_KEYS`, so it takes `any`.

The TSV `own (see design §1)` rows for `memory.create`, `memory.extract`, `memory.decision.record` and `thread.workspace.create` are **not** ownable: they create new rows, so there is no owner to compare. They take `any` under the rule above. `thread.workspace.read` is ownable on purpose, so a principal can be limited to reading its own workspace threads.

**`OWNABLE_KEYS`:**
- `comment.update`, `comment.delete`, `ticket.link.remove`, `memory.update`, `kb.document.delete`;
- `thread.cap.update`, `thread.plan`, `thread.run`, `thread.stop`, `thread.end-session`, `thread.answer`, `thread.archive`, `thread.publish`, `thread.discard`, `thread.message.send`;
- `thread.workspace.read`, `thread.workspace.message.send`, `thread.workspace.archive`.

**Other fields:**
- `risk`, decided by the first rule that matches:
  - `critical` for `role.*` and `approval.policy.*`, so `role.read` is `critical`;
  - `low` for keys whose last segment is `read`;
  - `high` for keys whose last segment is `delete` or `remove`, and for keys under `vcs.connection.`, `vcs.webhook-secret.`, `webhook.`, `fleet.repo.`, `fleet.runner.`, `fleet.budget.`, `fleet.enrollment.` and `fleet.credential.`;
  - `medium` otherwise.
- `principals`: `['user']` for `role.binding.owner`; `['user', 'agent']` otherwise.
- `approval`: `{ approvable: false, floor: 'none', default: 'none' }` when `access` is not `role` or `risk` is `low`; otherwise `{ approvable: true, floor: 'none', default: 'none' }`.

### Entry grammar and `expandEntries`

`apps/api/src/permissions/entry-matcher.ts` exports:

```ts
export class UnknownPermissionEntryError extends Error { constructor(readonly entry: string) { super(entry); } }
export class ScopeMismatchEntryError extends Error { constructor(readonly entry: string) { super(entry); } }
export function expandEntries(entries: readonly string[], roleScope: 'GLOBAL' | 'PROJECT'): ReadonlySet<string>;
```

- A key **fits** a role scope when its `scope` is the same (`global` ↔ `GLOBAL`, `project` ↔ `PROJECT`) or is `any`.
- A key is **role-grantable** when its `access` is `role`.
- The output set holds plain keys, `X.own` strings, and `approval.decide@<pattern>` strings.

| Entry | Expands to |
|:--|:--|
| `k` (exact) | `k`, if `k` is role-grantable and fits. If `k` is not in the catalog: `UnknownPermissionEntryError`. If it is in the catalog but not role-grantable, or does not fit: `ScopeMismatchEntryError`. |
| `k.own` | `k.own`, if `k` is in `OWNABLE_KEYS` and fits. Otherwise the same errors as an exact entry. |
| `p.*` | every role-grantable, fitting key that starts with `p.`. Zero matches: `UnknownPermissionEntryError`. |
| `p.*.own` | `k.own` for every ownable, fitting key that starts with `p.`. Zero matches: `UnknownPermissionEntryError`. |
| `*` | every role-grantable, fitting key |
| `*.read` | every role-grantable, fitting key whose last segment is `read` |
| `approval.decide@<pattern>` | the string itself, where `<pattern>` is an exact key or `p.*` that matches at least one catalog key. Otherwise `UnknownPermissionEntryError`. |
| `!e` | removes from the result everything `e` expands to. All exclusions apply after all inclusions. |

A key `k` in the set implies `k.own` when checking (see `PermissionService.can`).

### Schema

```prisma
/// Permissions P1a: a named set of permission entries.
model Role {
  id          String   @id @default(cuid())
  key         String   @unique // kebab-case, e.g. 'project-admin'
  name        String
  description String   @default("")
  scope       String   // GLOBAL | PROJECT
  system      Boolean  @default(false)
  locked      Boolean  @default(false)
  permissions Json     // string[] of entries
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  bindings RoleBinding[]
}

/// Permissions P1a: a role given to a user or an agent, in one project or globally (projectId null).
model RoleBinding {
  id            String   @id @default(cuid())
  principalType String   // USER | AGENT
  principalId   String
  roleId        String
  projectId     String?
  grantedByType String   // USER | AGENT | SYSTEM
  grantedById   String
  createdAt     DateTime @default(now())

  role    Role     @relation(fields: [roleId], references: [id], onDelete: Restrict)
  project Project? @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([principalType, principalId])
  @@index([projectId])
  @@index([roleId])
}
```

- **`Project` back-relation.** `model Project` gains `roleBindings RoleBinding[]`.
- **Migration.** `apps/api/prisma/migrations/20261027090000_role_bindings/migration.sql` creates both tables and ships these two statements verbatim. The same strings are appended to `PARTIAL_UNIQUE_INDEXES` in `apps/api/test/helpers/partial-indexes.ts`.

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "RoleBinding_principalId_roleId_projectId_key" ON "RoleBinding" ("principalType", "principalId", "roleId", "projectId") WHERE "projectId" IS NOT NULL
CREATE UNIQUE INDEX IF NOT EXISTS "RoleBinding_principalId_roleId_global_key" ON "RoleBinding" ("principalType", "principalId", "roleId") WHERE "projectId" IS NULL
```

- **Principal deletion.** `principalId` has no foreign key, because it points at a `User` or an `Agent`.
  - Agent deletion (`AgentsService.remove(slug)`, behind `DELETE /agents/:slug`) calls `MembershipService.removeAllBindings({ type: 'AGENT', id })`.
  - Users are never deleted, only disabled. Their bindings stay, and later readers check `disabled`.

### Seeded system roles

`apps/api/src/permissions/system-roles.ts` exports `SYSTEM_ROLES`. Each role has `system: true`; only `owner` also has `locked: true`.

| key | name | scope | permissions |
|:--|:--|:--|:--|
| `owner` | Owner | GLOBAL | `*` |
| `admin` | Admin | GLOBAL | `*`, `!role.binding.owner` |
| `member` | Member | GLOBAL | `agent.read`, `thread.workspace.read.own`, `thread.workspace.create`, `thread.workspace.message.send.own`, `thread.workspace.archive.own` |
| `agent` | Agent | GLOBAL | `agent.read` |
| `project-admin` | Project Admin | PROJECT | `*`, `approval.decide`, `approval.policy.manage` |
| `developer` | Developer | PROJECT | `*.read`, `ticket.create`, `ticket.update`, `ticket.assign`, `ticket.transition.*`, `ticket.label.*`, `ticket.link.add`, `ticket.link.remove.own`, `ticket.watch.*`, `comment.create`, `comment.update.own`, `comment.delete.own`, `label.create`, `label.update`, `agent.pickup`, `fleet.job.*`, `fleet.schedule.*`, `fleet.ticket-job.*`, `fleet.approval.decide.bash`, `fleet.knowledge.repo.reindex`, `thread.create`, `thread.*.own`, `kb.document.add`, `kb.document.delete.own`, `kb.search`, `memory.create`, `memory.extract`, `memory.decision.record`, `memory.update.own`, `codeintel.*`, `context.*` |
| `reviewer` | Reviewer | PROJECT | `*.read`, `comment.create`, `comment.update.own`, `comment.delete.own`, `ticket.transition.verify-fix.*`, `ticket.transition.close`, `agent.pickup`, `approval.decide` |
| `verifier` | Verifier | PROJECT | `*.read`, `comment.create`, `comment.update.own`, `comment.delete.own`, `ticket.transition.verify`, `ticket.transition.verify-fix.*`, `agent.pickup` |
| `triager` | Triager | PROJECT | `*.read`, `comment.create`, `comment.update.own`, `comment.delete.own`, `ticket.update`, `ticket.assign`, `ticket.transition.verify`, `ticket.transition.reject`, `ticket.label.*`, `label.create`, `agent.pickup` |
| `approver` | Approver | PROJECT | `*.read`, `approval.decide` |
| `viewer` | Viewer | PROJECT | `*.read`, `comment.create`, `comment.update.own`, `comment.delete.own`, `ticket.watch.*` |

**`SystemRoleSeeder`** is an `OnApplicationBootstrap` provider in `PermissionsModule`. It reads its seed list from the injection token `SYSTEM_ROLES_SEED`, which `PermissionsModule` provides as `SYSTEM_ROLES`, so tests can supply another list.

The seeded `agent` role leaves out the design's `mcp.access`, because `mcp.access` is an implicit key every authenticated principal holds and cannot appear in a role.

The seeder:
- Before any write, it validates every seeded role with `expandEntries`. An invalid entry throws, and the API does not start.
- It then upserts each role by `key`.
- A missing role is created.
- A **locked** role whose stored `permissions`, `name` or `scope` differ is overwritten with the seed.
- An unlocked system role keeps its stored `permissions`, because admins may edit them. Its `name` and `scope` are reset to the seed.
- It never deletes a row.

### Service signatures

```ts
export type PrincipalRef = { type: 'USER' | 'AGENT'; id: string };
export type Granter = { type: 'USER' | 'AGENT' | 'SYSTEM'; id: string };
export interface RoleBindingView {
  id: string; principalType: 'USER' | 'AGENT'; principalId: string;
  roleId: string; roleKey: string; projectId: string | null;
  grantedByType: string; grantedById: string; createdAt: Date;
}
export interface PermissionDecision {
  allowed: boolean;
  reason: 'implicit' | 'public' | 'granted' | 'not-granted' | 'not-owner' | 'non-role-key'
        | 'unknown-key' | 'no-project' | 'principal-type';
}

// PermissionService
can(principal: KodaPrincipal, key: string,
    ctx?: { projectId?: string; resource?: { createdBy: PrincipalRef | null } }): Promise<PermissionDecision>;
effectiveKeys(principal: PrincipalRef, scope: { projectId: string } | 'global'): Promise<ReadonlySet<string>>;

// MembershipService
isGlobalAdmin(userId: string): Promise<boolean>;
bindOwnerIfFirst(userId: string, wasFirstUser: boolean): Promise<void>;
bindBaseline(principal: PrincipalRef): Promise<void>;
setGlobalAdmin(userId: string, admin: boolean, by: Granter): Promise<void>;
createBinding(input: { principal: PrincipalRef; roleKey: string; projectId: string | null }, by: Granter): Promise<RoleBindingView>;
findBinding(id: string): Promise<RoleBindingView | null>;
listBindings(filter: { principal?: PrincipalRef; projectId?: string | null }): Promise<RoleBindingView[]>;
removeBinding(id: string): Promise<void>;
removeAllBindings(principal: PrincipalRef): Promise<void>;
```

**`PermissionService.can` rules, in order:**
1. A runner principal: `{ allowed: false, reason: 'non-role-key' }`.
2. A key not in the catalog: `unknown-key`, denied.
3. `public` or `implicit` access: allowed, with that reason.
4. `runner` or `system` access: `non-role-key`, denied.
5. The catalog `principals` excludes the principal's type: `principal-type`, denied.
6. A `project`-scope key with no `ctx.projectId`: `no-project`, denied.
7. **Effective keys** are the union of what `expandEntries` gives for:
   - every `projectId`-null binding of a GLOBAL role;
   - every `projectId`-null binding of a PROJECT role, and every binding of a PROJECT role in `ctx.projectId`, when `ctx.projectId` is given;
   - for a user whose legacy `User.role` is `'ADMIN'`, the `admin` role's entries, as if a `projectId`-null `admin` binding existed.
   - **Global admins in projects.** A principal with a `projectId`-null `owner` or `admin` binding (or legacy admin) also holds every key in `expandEntries(['*'], 'PROJECT')`. This holds in every project, and in the `'global'` set that `effectiveKeys(…, 'global')` returns for escalation checks. A global Owner or Admin can therefore do everything inside any project, including `role.binding.manage`, `approval.decide` and `approval.policy.manage`, and can write PROJECT roles containing project keys. `effectiveKeys(…, { projectId })` applies the same rule. (Rule 6 still denies a `project`-scope key in `can` when no `ctx.projectId` is given.)
8. Holding `key` (or any `approval.decide@…` whose pattern matches `key`, for `approval.decide`): `granted`.
9. Holding only `key.own`:
   - `granted` when `ctx.resource.createdBy` equals the principal;
   - `not-owner`, denied, when it doesn't;
   - `not-owner`, denied, when no `resource` is passed.
10. Otherwise: `not-granted`, denied.

**`MembershipService` rules:**
- **`createBinding`** is idempotent. An existing identical binding is returned, including when a concurrent insert loses on the partial unique index; that case is caught with `isUniqueViolation`.
- **Owner bindings.** `createBinding` and `removeBinding` lock the `owner` `Role` row with `SELECT … FOR UPDATE` inside `txManager.run` before changing an `owner` binding.
  - `removeBinding` refuses to delete the last `owner` binding, with `ForbiddenAppException('permissions.ownerLocked')`.
- **Legacy admin column, for USER principals:**
  - Creating a `projectId`-null `owner` or `admin` binding sets `User.role = 'ADMIN'` in the same transaction.
  - Removing one, when no other such binding is left, sets `User.role = 'MEMBER'`.
- **Token revocation.** Whenever a write changes a user's `User.role`, the same transaction bumps that user's `tokenVersion`, as `UsersRepository.updateUser({ bumpTokenVersion: true })` does today. After the transaction, the service invalidates `userTokenVersionCacheTag(userId)` (tag mode) and `userAuthStateCacheKey(userId)`, the same two invalidations `UsersAdminService.update` performs today. The user's existing access and refresh tokens stop working.
- **`setGlobalAdmin(userId, false, by)`** removes only the user's `projectId`-null `admin` binding. It never touches an `owner` binding: an Owner's `User.role` stays `'ADMIN'`, and removing an owner binding is possible only through `removeBinding`, which keeps the last-owner protection. When no `owner` or `admin` binding remains after the call, it sets `User.role = 'MEMBER'` (with the token revocation above). This includes a legacy admin who held no binding at all.
- **Unique violations.** A duplicate insert is recognised with `isUniqueViolation(error, 'principalId')`. Both partial index names contain `principalId`, and the helper substring-matches index names. The existing binding is then re-read and returned.
- **Role delete race.** A foreign key violation on `RoleBinding.roleId` during a role delete, from a binding inserted concurrently, is mapped to 409 `permissions.roleInUse`.
- **Re-posting a binding.** A `POST /role-bindings` identical to an existing binding answers 201 with the existing binding.
- **Unknown ids.** `PATCH` or `DELETE /roles/:id` with an unknown id answers 404 `permissions.roleNotFound`. `DELETE /role-bindings/:id` with an unknown id answers 404 `permissions.bindingNotFound`.
- **Counting Owners.** The last-owner check counts `owner` bindings of users that are not disabled.
- **Cache.** Every write invalidates the `permissions` cache tag.

### Owner bootstrap and baseline bindings

- **`IAuthConfig.ownerEmail`** is read from `KODA_OWNER_EMAIL`. `authConfig` trims and lower-cases the raw value **before** validation: it validates a copy of `process.env` whose `KODA_OWNER_EMAIL` is already trimmed and lower-cased. `AuthConfigSchema` gains `@IsOptional() @IsEmail() KODA_OWNER_EMAIL?: string`. An empty value after trimming is mapped to `undefined` in that copy, so it counts as unset.
- **Production check.** `PermissionsModule.onModuleInit` throws `Error('permissions.ownerEmailRequired')` when `NODE_ENV === 'production'` and `ownerEmail` is unset.
- **Registration.**
  - `AuthService.register` refuses before creating the user, with `ForbiddenAppException({}, 'registration')`, when:
    - the users table is empty,
    - `ownerEmail` is set, and
    - the canonical email differs from it.
  - After creating the user, it calls:
    - `MembershipService.bindOwnerIfFirst(userId, wasFirstUser)`. `wasFirstUser` is the `firstUser` flag that `PrismaAuthRepository.findAnyUserAndCreate` already returns, as `{ user, firstUser }`. That method keeps storing `role: 'ADMIN'` for the first user, unchanged.
    - `MembershipService.bindBaseline({ type: 'USER', id })`.
- **Admin user routes.**
  - `UsersAdminService.create(dto)` calls `bindBaseline`. When `dto.role` is `ADMIN`, it also calls `setGlobalAdmin(id, true, { type: 'SYSTEM', id: 'admin-users' })`.
  - `UsersAdminService.update(actorId, userId, patch)` with `patch.role` calls `setGlobalAdmin(userId, patch.role === 'ADMIN', { type: 'USER', id: actorId })` instead of writing `role` through `repo.updateUser`.
  - The existing last-admin guard keeps counting with `countActiveAdmins`. That still reads `User.role`, which `setGlobalAdmin` keeps in step.
- **Agents.** `AgentsService.generateApiKey(dto)`, the create path behind `POST /agents`, calls `bindBaseline({ type: 'AGENT', id })` inside its existing transaction.

### New REST routes

All routes take the global prefix and return the JSON envelope. Each route's check runs through `RoleAdminService.assertCan(principal, key, projectId?)`, which throws `ForbiddenAppException('permissions')` when `can` denies.

| Route | Key checked | Body / result |
|:--|:--|:--|
| `GET /roles` | `role.read` | `RoleDto[]` = `{ id, key, name, description, scope, system, locked, permissions }` |
| `POST /roles` | `role.manage` | `{ key, name, description?, scope, permissions }` → 201 `RoleDto` |
| `PATCH /roles/:id` | `role.manage` | `{ name?, description?, permissions? }` → 200 `RoleDto` |
| `DELETE /roles/:id` | `role.manage` | 204 |
| `GET /role-bindings?principalType=&principalId=&projectId=` | `role.read` | `RoleBindingDto[]` (the `RoleBindingView` fields) |
| `POST /role-bindings` | `role.binding.global` when `projectId` is absent or null; else `role.binding.manage` in that project; plus `role.binding.owner` when `roleKey` is `owner` | `{ principalType, principalId, roleKey, projectId? }` → 201 `RoleBindingDto` |
| `DELETE /role-bindings/:id` | the same keys as create, from the stored binding | 204 |

**Role write rules** (`RoleAdminService`):
- **Validation.** `permissions` must pass `expandEntries(permissions, scope)`. A failure answers 400 `ValidationAppException('permissions.unknownEntry')` or `('permissions.scopeMismatch')`.
- **Escalation.** Every key in `expandEntries(permissions, scope)`, with `X.own` counted as `X` and `approval.decide@…` counted as `approval.decide`, must be in the caller's `effectiveKeys(caller, 'global')`. Otherwise 403 `permissions.escalation`. This applies to POST and PATCH only.
- **Deleting a role** has no escalation check, because deleting a role grants nothing. Its checks run in the order: locked, then system role, then in use.
- **Duplicate key.** `POST /roles` with an existing `key` answers 409 `permissions.roleKeyTaken`. A concurrent duplicate insert, caught with `isUniqueViolation(error, 'key')`, answers the same.
- **Input format.**
  - `key` must match `^[a-z][a-z0-9-]{1,48}$`.
  - `scope` must be `GLOBAL` or `PROJECT`.
  - Both are checked by the DTO; a violation answers the standard 400 validation response.
  - An empty `permissions` list is allowed.
- **Fixed fields.** `key` and `scope` cannot change. PATCH accepts no such fields.
- **System roles.** PATCH on a system role may change only `permissions` and `description`. A `name` in the body answers 400 `ValidationAppException('permissions.systemRole')`.
- **Locked roles.** PATCH or DELETE on a locked role answers 403 `ForbiddenAppException('permissions.ownerLocked')`.
- **Deleting.**
  - DELETE on an unlocked system role answers 403 `permissions.systemRole`.
  - DELETE on a role with bindings answers 409 `permissions.roleInUse`.

**Binding write rules:**
- **Scope match.** A GLOBAL role with a non-null `projectId` answers 400 `permissions.scopeMismatch`.
- **Unknown inputs:**
  - an unknown `roleKey` answers 404 `NotFoundAppException('permissions.roleNotFound')`;
  - an unknown or soft-deleted `projectId` answers 404 `NotFoundAppException({}, 'projects')`;
  - a `principalId` that names no `User` (USER) or `Agent` (AGENT) answers 404 `permissions.principalNotFound`.
- **Principal type.** A role whose expanded keys include a key whose `principals` excludes the principal type answers 400 `permissions.principalType`. For example, `owner` to an AGENT.
- **Escalation.** Every key of the role must be in the caller's `effectiveKeys` at the binding's scope: `'global'` for a null `projectId`, else `{ projectId }`. Otherwise 403 `permissions.escalation`.
- **Self-binding.** Creating or deleting a binding whose principal is the caller answers 403 `permissions.selfBinding`.
- **Escalation on delete.** `DELETE /role-bindings/:id` applies the same escalation rule as create, against the stored binding's role and scope.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| Seeded role entry is invalid | `SystemRoleSeeder` throws during bootstrap; the API does not start |
| Production with no `KODA_OWNER_EMAIL` | `PermissionsModule.onModuleInit` throws `Error('permissions.ownerEmailRequired')` |
| First registration with a non-owner email while `KODA_OWNER_EMAIL` is set | 403 `registration`; no user is created |
| Unknown or out-of-scope role entry on POST or PATCH `/roles` | 400 `ValidationAppException` `permissions.unknownEntry` / `permissions.scopeMismatch`; nothing stored |
| Role create or edit, or binding create or delete, exceeds the caller's keys | 403 `ForbiddenAppException` `permissions.escalation`; nothing changed |
| Duplicate role key, including a concurrent duplicate | 409 `ConflictAppException` `permissions.roleKeyTaken` |
| Changing a system role's name / deleting an unlocked system role | 400 `ValidationAppException` / 403 `ForbiddenAppException`, both `permissions.systemRole` |
| Editing or deleting the locked `owner` role, or removing the last `owner` binding | 403 `ForbiddenAppException` `permissions.ownerLocked` |
| Deleting a role that has bindings | 409 `ConflictAppException` `permissions.roleInUse` |
| Binding with an unknown role, project or principal | 404 `NotFoundAppException` `permissions.roleNotFound` / `projects` / `permissions.principalNotFound` |
| Binding scope mismatch, or a role holding a key the principal type cannot hold | 400 `ValidationAppException` `permissions.scopeMismatch` / `permissions.principalType` |
| Binding to or unbinding oneself | 403 `ForbiddenAppException` `permissions.selfBinding` |
| Concurrent identical binding creates | both answer the same binding; one row exists |
| Caller lacks the route's permission key | 403 `ForbiddenAppException` `permissions` (prefix only) |
| Concurrent removal of the last two `owner` bindings | exactly one succeeds; the other answers 403 `permissions.ownerLocked` |

### Integration

Symbols this feature **reads** (verified at `81f71e7b`):
- `KodaPrincipal`, `isUserPrincipal`, `isAgentPrincipal`, `isRunnerPrincipal` — `apps/api/src/auth/principal/koda-principal.types.ts`
- `CacheManager` (`get(key, loader, ttlMs, { tags })`, tag invalidation) — the pattern in `apps/api/src/auth/jwt-auth.provider.ts`
- `TRANSACTION_MANAGER` / `ITransactionManager`, and `isUniqueViolation` — the patterns in `apps/api/src/agents/agents.service.ts`
- `PARTIAL_UNIQUE_INDEXES` — `apps/api/test/helpers/partial-indexes.ts`
- `AuthConfigSchema`, `IAuthConfig`, `authConfig` — `apps/api/src/config/auth.config.ts`
- The OpenAPI document as built by `apps/api/scripts/export-spec.ts` (`SwaggerModule.createDocument`)

Symbols this feature **changes**. The baseline only locates the code; implement the target.

| Symbol | Baseline (locate only) | Target |
|:--|:--|:--|
| `AuthService.register` (`auth/auth.service.ts`) | creates the user and issues a session | adds the `KODA_OWNER_EMAIL` refusal before creating, and the `bindOwnerIfFirst` and `bindBaseline` calls after |
| `UsersAdminService.create`, `update` (`users/users-admin.service.ts`) | write `role` through the repository, bump `tokenVersion` on a role change, and invalidate the two auth caches | `create` binds `member` (and `admin` for role `ADMIN`). `update` with a changed `role` goes through `MembershipService.setGlobalAdmin`, which now does the `tokenVersion` bump and cache invalidation for the role change. `update` keeps doing them itself for `disabled`. |
| `AgentsService.generateApiKey(dto)` (`agents/agents.service.ts`) | creates the agent, roles and capabilities | also binds the global `agent` role. `MembershipService` is a required constructor parameter, inserted as the **fourth** parameter after `txManager` and before the two `@Optional()` ones: `(agentRepo, authConfig, txManager, membership, kodaDomainWriter?, agentAuthProvider?)`. |
| `AgentsService.remove(slug)` (`agents/agents.service.ts`) | deletes the agent | also calls `removeAllBindings({ type: 'AGENT', id })` |
| `IAuthConfig`, `AuthConfigSchema` (`config/auth.config.ts`) | no owner email | `ownerEmail?: string` from `KODA_OWNER_EMAIL` |
| `model Project` (`prisma/schema.prisma`) | no role bindings | `roleBindings RoleBinding[]` |
| `PARTIAL_UNIQUE_INDEXES` (`test/helpers/partial-indexes.ts`) | six statements | plus the two `RoleBinding` statements |
| `AppModule` (`src/app.module.ts`) | no permissions module | imports `PermissionsModule` |
| `GlobalStubsModule` (`src/common/test-helpers/global-stubs.module.ts`) | stubs the global providers module specs need | also provides and exports stub `PermissionService` and `MembershipService` |

## Out of Scope

- Moving any existing route, guard or tool check (`@RequiredPermission`, `@ProjectPermission`, `@ProjectRoles`, `exemptAgents`, `requireUser`, `assertUser`, tool `permission.kind`) onto permission keys is out of scope (`permissions-p1-enforce-core`, `permissions-p1-enforce-fleet`). No existing permission decision changes, except that global admin bindings are mirrored into `User.role`.
- Project and agent membership on bindings is out of scope (`permissions-p1-membership`). That covers:
  - the compatibility layer that derives `projectRole` and `agentRoles` from bindings;
  - the readers of `ProjectMember`, `AgentProject` and `AgentRoleEntry`;
  - the member, invite and project-agent routes writing bindings.

  In this feature, project bindings created through `/role-bindings` grant nothing to the existing checks.
- Invalidating the cached agent principal (`AGENT:<id>` tags) on binding writes is out of scope (`permissions-p1-membership`). Agent principals do not read bindings in this feature.
- A live JWT `role` read from bindings on every request is out of scope (`permissions-p1-membership`). In this feature a change to a user's global admin status revokes their tokens (see `MembershipService` rules), so their next login carries the new `role` claim, as today.
- Dropping `ProjectMember`, `AgentProject`, `AgentRoleEntry`, `User.role` or `ProjectInvite.role` is out of scope (`permissions-p1-cleanup`).
- Copying existing membership data into bindings is out of scope (no data migration; koda-wk is reset by hand).
- Approval policies, floors and `approval.decide` enforcement are out of scope (design phase P3). The catalog `approval` fields are placeholders.
- Action context and audit rows are out of scope (design phase P2). Bindings record only `grantedByType` and `grantedById`.
- Regenerating the CLI client in `apps/cli/src/generated/` is out of scope; no CLI command uses the new routes yet. Only the repo-root `openapi.json` is updated.
- Web pages for roles and bindings are out of scope (`permissions-p1-web`).
- US-003 only: cross-instance cache invalidation is out of scope. The API runs as a single instance with the in-memory cache.
- US-005 only: rate limits on the new routes beyond the global throttler are out of scope.
- US-006 only: rate limits on the new routes beyond the global throttler are out of scope.
- US-006 only: changing an existing binding in place is out of scope. A binding is deleted and created again; there is no `PATCH /role-bindings/:id`.
- US-003 only: special handling of disabled principals in `PermissionService.can` is out of scope. A disabled user's tokens are already revoked by the existing auth guard, and disabled agents are refused by the agent auth provider.

## Stories

1. **US-001: Permission catalog and entry grammar** — `Workdir: apps/api` — No dependencies. Adds `PERMISSION_CATALOG`, `findCatalogEntry`, `OWNABLE_KEYS`, `IMPLICIT_KEYS`, `PUBLIC_KEYS` and `expandEntries` with its two error types. Pure code, no database.
2. **US-002: Role and RoleBinding schema, migration and system role seeder** — `Workdir: apps/api` — Depends on US-001. Adds the two models, the `Project` back-relation, the migration, the partial unique indexes, `SYSTEM_ROLES` and the `SYSTEM_ROLES_SEED` token, `SystemRoleSeeder`, the `PermissionsModule` shell, `PrismaRoleRepository` and `PrismaRoleBindingRepository`.
3. **US-003: PermissionService and MembershipService** — `Workdir: apps/api` — Depends on US-002. Implements every method in "Service signatures", with the `permissions` cache tag, the legacy admin union, the owner-row lock and `User.role` mirroring, plus the `GlobalStubsModule` stubs for both services.
4. **US-004: Owner bootstrap and baseline bindings** — `Workdir: apps/api` — Depends on US-003. Covers `KODA_OWNER_EMAIL` (config, production check, registration refusal), `bindOwnerIfFirst` and `bindBaseline` on registration, admin user create and update through `setGlobalAdmin`, the agent baseline on create, and binding removal on agent delete.
5. **US-005: Roles API** — `Workdir: apps/api` — Depends on US-003. Adds `GET`, `POST`, `PATCH` and `DELETE` on `/roles` through `RoleAdminService`, with validation, escalation and the system and locked role rules, plus the i18n keys and the `openapi.json` update.
6. **US-006: Role bindings API** — `Workdir: apps/api` — Depends on US-005. Adds `GET`, `POST` and `DELETE` on `/role-bindings`, with the scope, principal, escalation, self-binding and Owner rules.

### Context Files

**US-001**
- `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` — the key list and `catalog_scope` column
- `apps/api/src/common/enums.ts` — house style for exported constant sets

**US-002**
- `apps/api/prisma/schema.prisma` — `Project` model and neighbouring model conventions
- `apps/api/test/helpers/partial-indexes.ts` — the partial unique index list
- `apps/api/test/unit/fleet/partial-indexes.spec.ts` — the verbatim migration-match check the new statements must pass
- `apps/api/src/permissions/catalog.ts` — created by US-001, used by the seeder

**US-003**
- `apps/api/src/auth/jwt-auth.provider.ts` — `CacheManager` tag usage
- `apps/api/src/auth/principal/koda-principal.types.ts` — principal shapes
- `apps/api/src/agents/agents.service.ts` — `txManager.run` and `isUniqueViolation` usage
- `apps/api/src/permissions/entry-matcher.ts` — created by US-001
- `apps/api/src/permissions/prisma-role-binding.repository.ts` — created by US-002

**US-004**
- `apps/api/src/auth/auth.service.ts` — `register`
- `apps/api/src/auth/prisma-auth.repository.ts` — `findAnyUserAndCreate` first-user condition
- `apps/api/src/config/auth.config.ts` — config schema
- `apps/api/src/users/users-admin.service.ts` — admin create and update
- `apps/api/src/agents/agents.service.ts` — `generateApiKey` and `remove`

**US-005**
- `apps/api/src/users/admin-users.controller.ts` — controller conventions (envelope, Swagger, `@Principal`)
- `apps/api/src/i18n/en/users.json` — i18n file shape
- `apps/api/test/integration/openapi-spec/spec-integrity.integration.spec.ts` — the Swagger completeness checks every operation in `openapi.json` must pass
- `apps/api/scripts/export-spec.ts` — how the OpenAPI document is built
- `apps/api/src/permissions/permission.service.ts` — created by US-003

**US-006**
- `apps/api/src/permissions/role-admin.service.ts` — created by US-005, extended here
- `apps/api/src/permissions/membership.service.ts` — created by US-003
- `apps/api/test/integration/users/admin-users.integration.spec.ts` — the concurrency test pattern for last-admin protection

### Creates

**US-001**
- `apps/api/src/permissions/catalog.ts`
- `apps/api/src/permissions/entry-matcher.ts`

**US-002**
- `apps/api/src/permissions/permissions.module.ts`
- `apps/api/src/permissions/system-roles.ts`
- `apps/api/src/permissions/system-role.seeder.ts`
- `apps/api/src/permissions/prisma-role.repository.ts`
- `apps/api/src/permissions/prisma-role-binding.repository.ts`
- `apps/api/src/permissions/permissions.tokens.ts`
- `apps/api/prisma/migrations/20261027090000_role_bindings/migration.sql`

**US-003**
- `apps/api/src/permissions/permission.service.ts`
- `apps/api/src/permissions/membership.service.ts`

**US-005**
- `apps/api/src/permissions/role-admin.service.ts`
- `apps/api/src/permissions/roles.controller.ts`
- `apps/api/src/permissions/dto/role.dto.ts`
- `apps/api/src/i18n/en/permissions.json`
- `apps/api/src/i18n/zh/permissions.json`

**US-006**
- `apps/api/src/permissions/role-bindings.controller.ts`
- `apps/api/src/permissions/dto/role-binding.dto.ts`

### Modifies

**US-002**
- `apps/api/test/helpers/partial-indexes.ts` — PARTIAL_UNIQUE_INDEXES gains the two RoleBinding statements. The invariant: every entry matches a migration statement verbatim.
- `apps/api/src/app.module.ts` — AppModule adds PermissionsModule to its imports, so the seeder runs at bootstrap and the global services resolve.

**US-003**
- `apps/api/src/common/test-helpers/global-stubs.module.ts` — GlobalStubsModule provides and exports stub PermissionService and MembershipService, so every module spec compiles once modules inject them.

**US-004**
- `apps/api/src/auth/auth.service.spec.ts` — the register tests build AuthService without MembershipService or ownerEmail. The replacing invariant: the test module provides a MembershipService double, and register calls bindOwnerIfFirst and bindBaseline for the created user.
- `apps/api/src/users/users-admin.service.spec.ts` — the role tests expect repo.updateUser to receive role. The replacing invariant: update(..., { role }) calls a MembershipService.setGlobalAdmin double with role === 'ADMIN', and create calls bindBaseline.
- `apps/api/src/agents/agents.service.spec.ts` — the module and the direct new AgentsService( construction lack the now-required MembershipService. The replacing invariant: a MembershipService double is provided, and agent creation calls bindBaseline with { type: 'AGENT', id }.
- `apps/api/src/agents/agents-create.service.spec.ts` — the explicit provider list lacks MembershipService. The replacing invariant: a MembershipService double is provided and bindBaseline is called once per created agent.
- `apps/api/src/agents/agents-create.routes.spec.ts` — if its module wiring builds AgentsService without MembershipService, add a MembershipService double. Route behaviour assertions are unchanged.
- `apps/api/src/users/users.module.spec.ts` — its local FakeGlobalsModule provides only Prisma, TRANSACTION_MANAGER and CacheManager, so UsersModule fails DI once UsersAdminService injects MembershipService. The replacing invariant: the harness also provides a MembershipService double, and the module compiles.
- `apps/api/src/agents/agents-pickup.routes.spec.ts` — it provides a real AgentsService without MembershipService. The replacing invariant: a MembershipService double is provided; pickup route assertions are unchanged.
- `apps/api/src/agents/agents-project-roster.service.spec.ts` — it constructs new AgentsService(repo, authConfig, txManager) positionally, and MembershipService is now the required fourth parameter. The replacing invariant: the construction passes a MembershipService double fourth; roster assertions are unchanged.
- `apps/api/test/integration/agents/agents-create-rollback.integration.spec.ts` — if its test module provides a real AgentsService without PermissionsModule, add a MembershipService (or PermissionsModule) to it. The rollback assertions are unchanged, and a rolled-back create also leaves no RoleBinding row.
- `apps/api/test/integration/koda-domain-writer/koda-domain-writer.integration.spec.ts` — if its test module provides a real AgentsService without PermissionsModule, add a MembershipService double. Domain-writer assertions are unchanged.
- `apps/api/src/agents/agent-create-canonical-dto.routes.spec.ts` — if its module wiring builds AgentsService without MembershipService, add a MembershipService double. Route behaviour assertions are unchanged.

**US-005**
- `openapi.json` — regenerated with bun run api:export-spec from the repo root, to add the /roles operations. The invariant: the committed spec matches the API and passes spec-integrity.integration.spec.ts.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — gains a happy-path and one error case for each /roles route, per .nax/rules/api-testing.md. Existing cases are unchanged.

**US-006**
- `openapi.json` — regenerated with bun run api:export-spec from the repo root, to add the /role-bindings operations. The invariant: the committed spec matches the API and passes spec-integrity.integration.spec.ts.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — gains a happy-path and one error case for each /role-bindings route. Existing cases are unchanged.

### Seams

- **US-001 → US-002:** `SystemRoleSeeder` validates `SYSTEM_ROLES` with `expandEntries` before writing (US-002 AC 6).
- **US-003 → US-004:** `AuthService.register`, `UsersAdminService` and `AgentsService` call `MembershipService` (US-004 ACs 3, 4, 7, 9 and 11 trigger the HTTP routes).
- **US-003 → US-005 and US-006:** the routes check through `PermissionService.can` and `effectiveKeys` (US-005 ACs 2 and 6; US-006 ACs 2 and 7).
- **Altitude note.** `PermissionService.can` and `MembershipService` are new and have no production caller before US-004 to US-006. So US-003 tests them directly, and the route-level ACs in US-004 to US-006 cover the wiring.

## Acceptance Criteria

### US-001: Permission catalog and entry grammar (`Workdir: apps/api`)

1. [unit] Every key in the `proposed_key` column of `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv`, split on `;`, is returned by `findCatalogEntry(key)` from `apps/api/src/permissions/catalog.ts` as an entry with that `key`.
2. [unit] `findCatalogEntry` returns an entry for each of `role.read`, `role.manage`, `role.binding.manage`, `role.binding.global`, `role.binding.owner`, `approval.decide`, `approval.policy.read`, `approval.policy.manage`, `audit.read` and `memory.update`, and returns `undefined` for `no.such.key`.
3. [unit] `findCatalogEntry('runner.sync').access` is `'runner'` and `findCatalogEntry('system.schedule.dispatch').access` is `'system'`.
4. [unit] `findCatalogEntry('notification.read').access` is `'implicit'`, `findCatalogEntry('mcp.access').access` is `'implicit'`, and `findCatalogEntry('session.login').access` is `'public'`.
5. [unit] `findCatalogEntry('ticket.delete')` has `access` `'role'` and `scope` `'project'`; `findCatalogEntry('user.create')` and `findCatalogEntry('fleet.runner.update')` have `scope` `'global'`; `findCatalogEntry('agent.read')` and `findCatalogEntry('comment.update')` have `scope` `'any'`.
6. [unit] `findCatalogEntry('comment.update').ownable` and `findCatalogEntry('thread.stop').ownable` are `true`; `findCatalogEntry('ticket.delete').ownable` and `findCatalogEntry('thread.create').ownable` are `false`.
7. [unit] `findCatalogEntry('ticket.delete').risk` is `'high'`, `findCatalogEntry('ticket.read').risk` is `'low'`, `findCatalogEntry('role.read').risk` is `'critical'`, and `findCatalogEntry('ticket.create').risk` is `'medium'`.
8. [unit] `findCatalogEntry('role.binding.owner').principals` equals `['user']`, and `findCatalogEntry('ticket.create').principals` equals `['user', 'agent']`.
9. [unit] `expandEntries(['ticket.*'], 'PROJECT')` returns a set that includes `ticket.delete` and `ticket.transition.fix` and excludes `comment.create`.
10. [unit] `expandEntries(['*'], 'PROJECT')` returns a set that includes `ticket.delete` and `agent.read`, and excludes `runner.sync`, `notification.read` and `user.create`.
11. [unit] `expandEntries(['*.read'], 'PROJECT')` returns a set that includes `fleet.job.logs.read` and excludes `ticket.create`.
12. [unit] `expandEntries(['*', '!role.binding.owner'], 'GLOBAL')` returns a set that includes `role.binding.global` and excludes `role.binding.owner`.
13. [unit] `expandEntries(['thread.*.own', 'comment.update.own'], 'PROJECT')` returns a set that includes `thread.stop.own` and `comment.update.own`, and excludes `thread.create.own` and `comment.update`.
14. [unit] `expandEntries(['unknown.key'], 'PROJECT')` throws `UnknownPermissionEntryError` with `entry` `'unknown.key'`, and `expandEntries(['user.create'], 'PROJECT')` throws `ScopeMismatchEntryError` with `entry` `'user.create'`.
15. [unit] `expandEntries(['approval.decide@ticket.*'], 'PROJECT')` returns a set that includes the string `approval.decide@ticket.*`, and `expandEntries(['approval.decide@nope.*'], 'PROJECT')` throws `UnknownPermissionEntryError`.

### US-002: Role and RoleBinding schema, migration and system role seeder (`Workdir: apps/api`)

1. [integration] After application bootstrap on an empty test database, the `Role` table holds exactly the keys `owner`, `admin`, `member`, `agent`, `project-admin`, `developer`, `reviewer`, `verifier`, `triager`, `approver` and `viewer`, each with `system` true.
2. [integration] After bootstrap, the `owner` role is the only one with `locked` true.
3. [integration] A second bootstrap on the same database creates no new `Role` rows.
4. [integration] When the stored `developer` row's `permissions` was set to `['ticket.read']` before a second bootstrap, it reads `['ticket.read']` afterwards.
5. [integration] When the stored `owner` row's `permissions` was set to `['ticket.read']` before a second bootstrap, it reads `['*']` afterwards.
6. [unit] `SystemRoleSeeder.onApplicationBootstrap`, given a seed list containing a role with entry `no.such.key`, rejects with `UnknownPermissionEntryError` and calls no repository write.
7. [integration] Inserting two `RoleBinding` rows with the same `principalType`, `principalId` and `roleId` and a null `projectId` fails on the second insert with a unique violation.
8. [integration] Inserting two `RoleBinding` rows with the same `principalType`, `principalId`, `roleId` and non-null `projectId` fails on the second insert with a unique violation.
9. [integration] Hard-deleting a `Project` row deletes its `RoleBinding` rows (cascade).
10. [integration] Deleting a `Role` row that a `RoleBinding` references fails with a foreign key violation.

### US-003: PermissionService and MembershipService (`Workdir: apps/api`)

1. [integration] For a user with a `developer` binding in project `p1`, `PermissionService.can(user, 'ticket.create', { projectId: p1 })` answers `{ allowed: true, reason: 'granted' }`.
2. [integration] For the same user, `can(user, 'ticket.delete', { projectId: p1 })` answers `{ allowed: false, reason: 'not-granted' }`, and `can(user, 'ticket.create', { projectId: p2 })` for a project with no binding answers `allowed` false.
3. [integration] For an agent with a `projectId`-null `reviewer` binding, `can(agent, 'ticket.transition.close', { projectId: p2 })` answers `allowed` true although the agent has no binding in `p2`.
4. [integration] For a user with a `projectId`-null `admin` binding, `can(user, 'user.create')` answers `allowed` true and `can(user, 'role.binding.owner')` answers `allowed` false.
5. [integration] For a user with no bindings whose legacy `User.role` is `'ADMIN'`, `can(user, 'user.create')` answers `allowed` true.
6. [integration] For a user with no bindings, `can(user, 'notification.read')` answers `{ allowed: true, reason: 'implicit' }`, and `can(user, 'ticket.create', {})` answers `{ allowed: false, reason: 'no-project' }`.
7. [integration] For an agent with a `projectId`-null `owner` binding inserted directly, `can(agent, 'role.binding.owner')` answers `{ allowed: false, reason: 'principal-type' }`, and for a runner principal `can(runner, 'ticket.read', { projectId: p1 })` answers `allowed` false.
8. [integration] For a user with a `viewer` binding in `p1`, `can(user, 'comment.update', { projectId: p1, resource: { createdBy: { type: 'USER', id: <user id> } } })` answers `allowed` true.
9. [integration] The same call with `createdBy.id` set to another user's id answers `{ allowed: false, reason: 'not-owner' }`, and the call with no `resource` answers `not-owner`.
10. [integration] After `can(user, 'ticket.create', { projectId: p1 })` answered `allowed` true, `MembershipService.removeBinding(<the developer binding id>)` makes the next identical `can` call answer `allowed` false.
11. [integration] Two concurrent `MembershipService.createBinding` calls with the same principal, `roleKey` and `projectId` both resolve to a `RoleBindingView` with the same `id`, and one `RoleBinding` row exists.
12. [integration] `MembershipService.createBinding` of a `projectId`-null `admin` binding for a user sets that user's `User.role` to `'ADMIN'`, and `isGlobalAdmin` answers true.
13. [integration] `MembershipService.removeBinding` of a user's only `projectId`-null `admin` binding sets `User.role` to `'MEMBER'`, and `isGlobalAdmin` then answers false.
14. [integration] `MembershipService.removeBinding` of the only `owner` binding rejects with `ForbiddenAppException` carrying `permissions.ownerLocked`, and the binding remains.
15. [integration] With exactly two `owner` bindings, two concurrent `removeBinding` calls, one per binding, leave exactly one `owner` binding: one call resolves and the other rejects with `permissions.ownerLocked`.

### US-004: Owner bootstrap and baseline bindings (`Workdir: apps/api`)

1. [unit] With `KODA_OWNER_EMAIL=Owner@Koda.test `, the resolved `authConfig().ownerEmail` is `'owner@koda.test'`; with it unset, `ownerEmail` is `undefined`.
2. [unit] `PermissionsModule.onModuleInit` with `NODE_ENV` `production` and no `ownerEmail` throws an error whose message is `permissions.ownerEmailRequired`, and with `ownerEmail` set it does not throw.
3. [integration] `POST /auth/register` on an empty users table, with `KODA_OWNER_EMAIL` unset, creates the user with a `projectId`-null `owner` binding and a `projectId`-null `member` binding.
4. [integration] With `REGISTRATION_ENABLED=true` and one user present, `POST /auth/register` creates the new user with a `member` binding and no `owner` binding.
5. [integration] With `KODA_OWNER_EMAIL=owner@koda.test` and an empty users table, `POST /auth/register` with email `other@koda.test` answers 403, and the users table stays empty.
6. [integration] With `KODA_OWNER_EMAIL=owner@koda.test` and an empty users table, `POST /auth/register` with email `Owner@Koda.test` answers 200 and the user holds an `owner` binding.
7. [integration] `POST /admin/users` by a global admin creating a user with role `MEMBER` gives that user a `member` binding and no `admin` binding.
8. [integration] `POST /admin/users` creating a user with role `ADMIN` gives that user a `projectId`-null `admin` binding and stores `User.role` `'ADMIN'`.
9. [integration] With a second active admin present, `PATCH /admin/users/:id` with `{ role: 'MEMBER' }` for a user holding an `admin` binding removes that binding and stores `User.role` `'MEMBER'`.
10. [integration] `PATCH /admin/users/:id` with `{ role: 'MEMBER' }` for the last active admin answers the existing last-admin error, and the user's `admin` binding remains.
11. [integration] `POST /agents` by a global admin creates the agent with a `projectId`-null `agent` binding whose `principalType` is `AGENT`.
12. [integration] `DELETE /agents/:slug` leaves no `RoleBinding` row with `principalType` `AGENT` and that agent's id.
13. [integration] With a second active admin present, After `PATCH /admin/users/:id` with `{ role: 'MEMBER' }` demotes a user who held an `admin` binding, `GET /auth/me` with that user's access token issued before the change answers 401.
14. [integration] With a second active admin present, `PATCH /admin/users/:id` with `{ role: 'MEMBER' }` for a user holding both a `projectId`-null `owner` and a `projectId`-null `admin` binding removes the `admin` binding, keeps the `owner` binding, and leaves `User.role` `'ADMIN'`.
15. [integration] With a second active admin present, `PATCH /admin/users/:id` with `{ role: 'MEMBER' }` for a user whose legacy `User.role` is `'ADMIN'` and who holds no binding stores `User.role` `'MEMBER'`.

### US-005: Roles API (`Workdir: apps/api`)

1. [integration] `GET /roles` by a user with a `projectId`-null `admin` binding answers 200 with the eleven system roles, each carrying `key`, `scope`, `system`, `locked` and `permissions`.
2. [integration] `GET /roles` by a user whose only binding is `member` answers 403.
3. [integration] `POST /roles` by an `owner` with `{ key: 'qa', name: 'QA', scope: 'PROJECT', permissions: ['ticket.read', 'comment.create'] }` answers 201 with that role and `system` false.
4. [integration] `POST /roles` with `permissions: ['no.such.key']` answers 400 with `permissions.unknownEntry`, and with `scope: 'PROJECT'` and `permissions: ['user.create']` answers 400 with `permissions.scopeMismatch`; no role is stored in either case.
5. [integration] `POST /roles` with an existing `key` answers 409 with `permissions.roleKeyTaken`.
6. [integration] `POST /roles` by an `admin` with `scope: 'GLOBAL'` and `permissions: ['role.binding.owner']` answers 403 with `permissions.escalation`.
7. [integration] `PATCH /roles/:id` by an `admin` on the `member` role with `{ permissions: ['*'] }` answers 403 with `permissions.escalation`, and the `member` role's permissions are unchanged.
8. [integration] `PATCH /roles/:id` by an `admin` on the `developer` role with `{ permissions: ['ticket.read'] }` answers 200, and with `{ permissions: ['bad.key'] }` answers 400 with `permissions.unknownEntry`.
9. [integration] `PATCH /roles/:id` on the `developer` role with `{ name: 'Dev' }` answers 400 with `permissions.systemRole`.
10. [integration] `PATCH /roles/:id` and `DELETE /roles/:id` on the `owner` role each answer 403 with `permissions.ownerLocked`.
11. [integration] `DELETE /roles/:id` on the `viewer` role answers 403 with `permissions.systemRole`.
12. [integration] `DELETE /roles/:id` on the custom `qa` role while one binding uses it answers 409 with `permissions.roleInUse`, and after that binding is removed it answers 204 and the role is gone.
13. [integration] After `PATCH /roles/:id` by an `owner` sets a custom PROJECT role `qa` (bound to user `u` in `alpha`) to `['ticket.read', 'ticket.create']`, `PermissionService.can(u, 'ticket.create', { projectId: <alpha id> })` answers `allowed` true on the next call, where it answered false before the edit.
14. [integration] The OpenAPI document built the way `apps/api/scripts/export-spec.ts` builds it lists `GET /roles`, `POST /roles`, `PATCH /roles/{id}` and `DELETE /roles/{id}`, each with a tag, a summary and at least one response.
15. [integration] After the first registration, `GET /roles` with that user's token answers 200 (the `owner` binding grants `role.read`).

### US-006: Role bindings API (`Workdir: apps/api`)

1. [integration] `POST /role-bindings` by a user with a `project-admin` binding in `alpha`, body `{ principalType: 'AGENT', principalId: <agent id>, roleKey: 'developer', projectId: <alpha id> }`, answers 201 with the binding.
2. [integration] The same project admin posting the same body with `projectId` omitted answers 403, because the caller lacks `role.binding.global`.
3. [integration] `GET /role-bindings?principalType=AGENT&principalId=<agent id>` by an `admin` answers 200 with a page whose `size` is 50 and whose `records` list the `developer` binding in `alpha` and the agent's `projectId`-null `agent` binding.
4. [integration] `POST /role-bindings` with `roleKey: 'owner'` and no `projectId`, for another user, by an `admin` answers 403 (the caller lacks `role.binding.owner`), and no binding is stored.
5. [integration] `POST /role-bindings` with `roleKey: 'admin'` and a non-null `projectId` answers 400 with `permissions.scopeMismatch`.
6. [integration] `POST /role-bindings` with an unknown `roleKey` answers 404 with `permissions.roleNotFound`, and with a `principalId` naming no user answers 404 with `permissions.principalNotFound`.
7. [integration] A user with a `project-admin` binding in `alpha` posting a binding in `alpha` of a custom PROJECT role whose entries include `approval.policy.manage`, which the caller holds, answers 201; posting one of a custom GLOBAL role holding `user.create` with no `projectId` answers 403.
8. [integration] `POST /role-bindings` whose `principalId` is the caller's own user id answers 403 with `permissions.selfBinding`, and `DELETE /role-bindings/:id` on a binding of the caller answers 403 with `permissions.selfBinding`.
9. [integration] `DELETE /role-bindings/:id` by an `owner` on another user's `projectId`-null `admin` binding answers 204, and that user's `User.role` is then `'MEMBER'`.
10. [integration] `DELETE /role-bindings/:id` by one `owner` on the other `owner`'s binding, when exactly two `owner` bindings exist, answers 204; afterwards, the same call on the remaining `owner` binding by an `admin` answers 403.
11. [integration] `DELETE /role-bindings/:id` on a project binding in `alpha` by a user without `role.binding.manage` in `alpha` answers 403, and by the `alpha` project admin answers 204.
12. [integration] After `POST /role-bindings` grants `developer` in `alpha` to user `u`, `PermissionService.can(u, 'ticket.create', { projectId: <alpha id> })` answers `allowed` true on the next call.
13. [integration] `POST /role-bindings` with `roleKey: 'owner'`, `principalType: 'AGENT'` and no `projectId`, by an `owner`, answers 400 with `permissions.principalType`.
14. [integration] A user whose only bindings are `member` and a custom GLOBAL role with entries `['role.read', 'role.binding.global']` calling `DELETE /role-bindings/:id` on another user's `projectId`-null `admin` binding answers 403 with `permissions.escalation`, and the binding remains.
15. [integration] The OpenAPI document built the way `apps/api/scripts/export-spec.ts` builds it lists `GET /role-bindings`, `POST /role-bindings` and `DELETE /role-bindings/{id}`, each with a tag, a summary and at least one response.

