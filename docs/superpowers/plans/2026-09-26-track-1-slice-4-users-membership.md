# Track 1 Slice 4 — Users and Membership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close self-registration by default (first user still bootstraps as global ADMIN, race-free on Postgres), let a global ADMIN create, disable and re-role users, and let project admins manage project membership, over API, CLI and web.

**Architecture:** Registration and every "at least one admin must remain" check run inside `txManager.run` behind a transaction-scoped Postgres advisory lock (`pg_advisory_xact_lock`), so concurrent requests serialize on the check-then-write. A new `User.disabled` column and the existing `tokenVersion` revocation (H1) carry session kills: disabling or re-roling a user bumps `tokenVersion` and invalidates the per-user auth-state cache, and the JWT provider, the refresh strategy and login all reject disabled users. Two new API modules (`src/users/` for `/admin/users`, `src/projects/members/` for `/projects/:slug/members`) follow repository → service → controller layering and page with the Slice 3 `KodaPageQuery` / `IPageResult<T>` primitives.

**Tech Stack:** NestJS 11 + Fastify, Prisma 6 on Postgres 16, `@nathapp/nestjs-*` 3.3.0 (auth, common, data, prisma, cache), class-validator, bcrypt, Jest (ts-jest) + supertest, Nuxt 3 web (Jest, source-level and composable tests), Commander CLI with a `@hey-api/openapi-ts` generated client, Bun 1.3.x.

**Spec:** `docs/superpowers/specs/2026-09-25-track-1-foundations-design.md`, section "Slice 4 — Users and membership". Read it before starting.

**Branch:** `feat/track1-users-membership` (already created off `main` @ `6a06031f`).

## Global Constraints

- Registration (verbatim from the spec): config `auth.registrationEnabled` from `REGISTRATION_ENABLED` (default `false`). `POST /auth/register` is allowed when the user table is empty (bootstrap; that user becomes global ADMIN); otherwise `ForbiddenAppException` unless the flag is true. `GET /auth/registration-status` is `@Public` and returns `{ open: boolean }`.
- `REGISTRATION_ENABLED` accepts only the strings `true` / `false` (anything else fails config validation at boot). `open` is `registrationEnabled || no user exists`, so a fresh install can always bootstrap.
- Global roles: `MEMBER | ADMIN`. Project member roles accepted by the new membership API: `ADMIN | DEVELOPER | VIEWER` (the `AGENT` and `MEMBER` values in `ActorRole` are not assignable to users through this API).
- No user deletion. Disabling is the removal mechanism (spec).
- **Every global role change and every disable bumps `tokenVersion` in the same UPDATE, then invalidates the user's cache tag after commit.** The access token carries the `role` claim, so a demoted ADMIN would otherwise keep ADMIN rights until the token expires. Re-enabling does not bump.
- Advisory locks: two-int form, class `72400` for global keys (`1` = user bootstrap, `2` = user administration), class `72401` with `hashtext(projectId)` for per-project membership. Only ever call them inside `txManager.run` (outside a transaction the `xact` lock releases immediately). Never call them with a directly-constructed `PrismaService`: only the app's `PrismaModule.forRoot({ transaction: true })` proxies `prisma.client` onto the transaction client.
- Errors: 403 = `ForbiddenAppException` (`ret` 40003), 404 = `NotFoundAppException` (`ret` 404), 409 = the new koda `ConflictAppException` (`ret` 409, HTTP 409). Messages resolve from `src/i18n/<lang>/<prefix>.json` at key `<prefix>.<code>`, so each distinct message gets its own prefix (e.g. `users.lastAdmin` → `users.json` → `{ "lastAdmin": { "409": "…" } }`). Every new key exists in both `en` and `zh`.
- `GET /projects/:slug/members` requires project membership (`assertProjectMembership`: any member or global ADMIN). `POST` / `PATCH` / `DELETE` require `assertProjectAdmin`: global ADMIN, or a user whose project role is `ADMIN`. Agent principals are refused on all membership writes.
- Last-ADMIN guards (spec): the last active global ADMIN cannot be demoted or disabled; an admin cannot disable or demote themselves; a project role change or removal that leaves zero project `ADMIN` members is refused unless the actor is a global ADMIN. Each count-and-write runs in one transaction behind its advisory lock.
- The global `ValidationPipe` runs with `transform: false`. Paginated controllers convert the query with `parseQuery(Cls, raw)` and return `toPageResult(page)` (both in `src/common/dto/koda-page.query.ts`, Slice 3). Never read `query.current` straight off `@Query()`.
- Follow `nathapp-nestjs-patterns`: `JsonResponse.Ok`, repository → service → controller, config via `AUTH_CFG` injection (never `process.env` outside config files and test harnesses), no `console.log` in the API.
- `bun run test` (unit) must pass with **no database running**. DB-backed tests live under `test/integration/`, gated by `KODA_DB_TESTS === '1'`. Run them with `bun run test:db:up && bun run test:integration` from `apps/api` (PG16 on port 5433).
- Jest runs test files in one process (`maxWorkers: 1`), so `process.env` is shared across files. A test that changes `REGISTRATION_ENABLED` restores it (the Task 1 `bootHttpApp` helper does this).
- Never edit generated files (`apps/cli/src/generated/`, root `openapi.json`) by hand. Regenerate with `bun run generate` from the repo root.
- Web: every user-facing string lives in `apps/web/i18n/locales/{en,zh}.json` (the `tests/i18n/locale-parity.spec.ts` gate enforces parity).
- Do not push, open a PR, or touch `projects/koda/deployments/koda-local` without the user's explicit approval at that moment.
- Git: the rtk hook rewrites git commands. If one misbehaves, prefix it with `RTK_DISABLED=1`.

## Review Focus

1. **A demoted or disabled user's still-valid access token.** The JWT carries `role`, and the auth state is cached for 60 s. After `PATCH /admin/users/:id { role: 'MEMBER' }` or `{ disabled: true }`, that user's next request with the old token must be 401 immediately, even when the token was used (and the state cached) a moment before. Pinned in Task 3 integration (`/auth/me` before and after, `/admin/users` with a demoted admin's token).
2. **A JWT for a user that no longer resolves.** The old provider treated a missing user as `tokenVersion 0` (never revoked). The new auth state treats a missing user as disabled. Pinned in Task 2 unit.
3. **Existing HTTP suites that register a second user.** Six suites under `test/integration` and `test/e2e` (project-memory, context, agents, ast-index, hybrid-retriever, api-endpoint) call `POST /auth/register` more than once per app. With the gate closed by default they would get 403. `.env.test` sets `REGISTRATION_ENABLED=true`, and only suites that test the closed gate boot with it off. Pinned in Task 1 (full `bun run test:integration` run).
4. **The registration-status probe on a fresh install.** An empty database with `REGISTRATION_ENABLED=false` must report `open: true` (otherwise the web hides the only way to bootstrap). Pinned in Task 1 integration.
5. **Two admins demoting each other at the same instant.** Without the lock both see two active admins and both succeed, leaving zero. Exactly one request may succeed. Pinned in Task 3 integration.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/api/src/common/utils/advisory-lock.ts` (+ `.spec.ts`) | `lockGlobal`, `lockProjectMembers`, lock keys | 1 |
| `apps/api/src/config/auth.config.ts` (+ spec) | `registrationEnabled` from `REGISTRATION_ENABLED` | 1 |
| `apps/api/src/common/test-helpers/global-stubs.module.ts` | `mockAuthConfig.registrationEnabled` | 1 |
| `apps/api/src/auth/prisma-auth.repository.ts` (+ spec) | locked bootstrap create; returns `null` when closed | 1, 2 |
| `apps/api/src/auth/auth.service.ts` (+ spec) | registration gate, `registrationStatus()`; disabled users rejected at login/refresh | 1, 2 |
| `apps/api/src/auth/auth.controller.ts` (+ spec) | `GET /auth/registration-status` | 1 |
| `apps/api/src/auth/dto/registration-status.dto.ts` | `{ open }` | 1 |
| `apps/api/src/i18n/{en,zh}/registration.json` | "registration closed" | 1 |
| `apps/api/.env.test`, `apps/api/.env.example` | `REGISTRATION_ENABLED` | 1 |
| `apps/api/test/helpers/http-app.ts` | `bootHttpApp`, `data`, `loginToken`, `TEST_PASSWORD` | 1 |
| `apps/api/test/integration/auth/registration.integration.spec.ts` | bootstrap race, closed/open gate | 1 |
| `apps/api/prisma/schema.prisma`, `prisma/migrations/20260926130000_user_disabled/migration.sql` | `User.disabled` | 2 |
| `apps/api/src/auth/domain/auth.domain.ts` | `UserDomain.disabled` | 2 |
| `apps/api/src/auth/token-version.cache.ts` | `UserAuthState`, `userAuthStateCacheKey` | 2 |
| `apps/api/src/auth/jwt-auth.provider.ts` (+ spec) | revoked when disabled / missing / stale | 2 |
| `apps/api/src/auth/koda-jwt-refresh-strategy.provider.ts` (+ spec) | refresh revoked when disabled | 2 |
| `apps/api/src/auth/dto/auth-response.dto.ts` | `disabled` documented | 2 |
| `apps/api/test/integration/auth/disabled-user.integration.spec.ts` | login / refresh / fresh access token rejected | 2 |
| `apps/api/src/common/exceptions/conflict-app.exception.ts` (+ spec) | 409 `AppException` | 3 |
| `apps/api/src/common/utils/prisma-errors.ts` (+ spec) | `isUniqueViolation(error, field)` | 3 |
| `apps/api/src/common/utils/ticket-number-retry.ts` | `isTicketNumberConflict` delegates to `isUniqueViolation` | 3 |
| `apps/api/src/auth/dto/register.dto.ts` | exports `PASSWORD_COMPLEXITY` | 3 |
| `apps/api/src/users/**` | `/admin/users` module: domain, repository, service, DTOs, controller, module | 3 |
| `apps/api/src/i18n/{en,zh}/users.json` | user-admin messages | 3 |
| `apps/api/test/integration/users/admin-users.integration.spec.ts` | admin CRUD, session kill, self and mutual-demotion guards | 3 |
| `apps/api/src/projects/project-access.service.ts` (+ spec) | `assertProjectAdmin` | 4 |
| `apps/api/src/projects/members/**` | `/projects/:slug/members` module | 4 |
| `apps/api/src/i18n/{en,zh}/members.json` | membership messages | 4 |
| `apps/api/src/app.module.ts` | imports `UsersModule`, `ProjectMembersModule` | 3, 4 |
| `apps/api/test/integration/projects/project-members.integration.spec.ts` | membership CRUD + last-ADMIN guard | 4 |
| `apps/api/src/tickets/tickets.controller.ts` (+ spec), `tickets.service.ts`, `domain/ticket.domain.ts`, `prisma-tickets.repository.ts` | `assignedTo=self` resolves to the caller | 5 |
| `apps/api/test/integration/tickets/ticket-pagination.integration.spec.ts` | agent-assignee filter | 5 |
| `openapi.json`, `apps/cli/src/generated/**` | regenerated | 6 |
| `apps/cli/src/commands/user.ts` (+ spec), `member.ts` (+ spec), `apps/cli/src/index.ts` | `koda user …`, `koda member …` | 6 |
| `apps/web/composables/useRegistrationStatus.ts` (+ test) | registration probe | 7 |
| `apps/web/pages/login.vue`, `pages/register.vue` (+ tests) | hide register link / show closed notice | 7 |
| `apps/web/composables/useAdminUsers.ts` (+ test), `pages/admin/users.vue`, `components/CreateUserDialog.vue`, `layouts/default.vue` | admin users page | 7 |
| `apps/web/composables/useProjectMembers.ts` (+ test), `components/ProjectMembersPanel.vue`, `pages/[project]/settings.vue` | members section | 8 |
| `apps/web/i18n/locales/{en,zh}.json` | strings | 7, 8 |
| `docs/architecture.md`, spec status line, `docker-compose.yml` | docs + deploy knob | 9 |

**Known limitation (recorded, not fixed here):** the CLI authenticates with an agent API key (`koda login` validates via `GET /agents/me`), and agent principals never hold the global `ADMIN` authority. The new `koda user …` commands therefore need a global-admin **user access token** supplied per call through the existing override: `KODA_API_KEY=<access token> koda user list`. The token lives 15 minutes. A proper `koda login --email` user-session flow is out of scope for this slice. `koda member list` also works with an agent key (membership check exempts agents), but member writes need a user token.

---

### Task 1: Registration gate, bootstrap lock, and registration status

**Files:**
- Create: `apps/api/src/common/utils/advisory-lock.ts`, `apps/api/src/common/utils/advisory-lock.spec.ts`
- Modify: `apps/api/src/config/auth.config.ts`, `apps/api/src/config/auth.config.spec.ts`
- Modify: `apps/api/src/common/test-helpers/global-stubs.module.ts:40-46`
- Modify: `apps/api/src/auth/prisma-auth.repository.ts:46-67`, `apps/api/src/auth/prisma-auth.repository.spec.ts`
- Modify: `apps/api/src/auth/auth.service.ts`, `apps/api/src/auth/auth.service.spec.ts`
- Create: `apps/api/src/auth/dto/registration-status.dto.ts`
- Modify: `apps/api/src/auth/auth.controller.ts`, `apps/api/src/auth/auth.controller.spec.ts`
- Create: `apps/api/src/i18n/en/registration.json`, `apps/api/src/i18n/zh/registration.json`
- Modify: `apps/api/.env.test`, `apps/api/.env.example`
- Create: `apps/api/test/helpers/http-app.ts`
- Create: `apps/api/test/integration/auth/registration.integration.spec.ts`

**Interfaces:**
- Produces: `lockGlobal(db: Pick<PrismaClient, '$queryRaw'>, key: GlobalLockKey): Promise<void>`, `lockProjectMembers(db, projectId: string): Promise<void>`, `GlobalLock = { USER_BOOTSTRAP: 1, USER_ADMINISTRATION: 2 }` (Tasks 3, 4).
- Produces: `IAuthConfig.registrationEnabled: boolean`.
- Produces: `PrismaAuthRepository.findAnyUserAndCreate(data, options: { allowWhenUsersExist: boolean }): Promise<{ user: UserDomain; firstUser: boolean } | null>`.
- Produces: `AuthService.registrationStatus(): Promise<{ open: boolean }>`.
- Produces (test helper, Tasks 2-4): `bootHttpApp(opts: { registrationEnabled: boolean }): Promise<NathApplication>`, `data<T>(res: request.Response): T`, `loginToken(server, email: string, password?: string): Promise<string>`, `TEST_PASSWORD = 'Admin1234!Aa'`.

- [ ] **Step 1: Write the failing advisory-lock test**

Create `apps/api/src/common/utils/advisory-lock.spec.ts`:

```ts
import { GlobalLock, KODA_LOCK_CLASS, lockGlobal, lockProjectMembers } from './advisory-lock';

describe('advisory locks', () => {
  function fakeDb() {
    const $queryRaw = jest.fn().mockResolvedValue([{ locked: 1 }]);
    return { db: { $queryRaw } as never, $queryRaw };
  }

  it('lockGlobal takes pg_advisory_xact_lock(GLOBAL, key)', async () => {
    const { db, $queryRaw } = fakeDb();
    await lockGlobal(db, GlobalLock.USER_BOOTSTRAP);

    expect($queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = $queryRaw.mock.calls[0];
    expect((strings as string[]).join('?')).toContain('pg_advisory_xact_lock');
    expect(values).toEqual([KODA_LOCK_CLASS.GLOBAL, GlobalLock.USER_BOOTSTRAP]);
  });

  it('lockProjectMembers hashes the project id under the PROJECT_MEMBERS class', async () => {
    const { db, $queryRaw } = fakeDb();
    await lockProjectMembers(db, 'proj-1');

    const [strings, ...values] = $queryRaw.mock.calls[0];
    expect((strings as string[]).join('?')).toContain('hashtext(');
    expect(values).toEqual([KODA_LOCK_CLASS.PROJECT_MEMBERS, 'proj-1']);
  });

  it('never selects the void lock result directly', async () => {
    const { db, $queryRaw } = fakeDb();
    await lockGlobal(db, GlobalLock.USER_ADMINISTRATION);
    const sql = ($queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toMatch(/SELECT 1 AS locked FROM \(SELECT pg_advisory_xact_lock/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bunx jest src/common/utils/advisory-lock.spec.ts`
Expected: FAIL, `Cannot find module './advisory-lock'`.

- [ ] **Step 3: Implement the advisory-lock helper**

Create `apps/api/src/common/utils/advisory-lock.ts`:

```ts
import type { PrismaClient } from '@prisma/client';

/**
 * Transaction-scoped Postgres advisory locks (two-int form).
 *
 * Call only inside txManager.run: pg_advisory_xact_lock is released at
 * COMMIT/ROLLBACK, so outside a transaction it would release immediately.
 * The lock serializes a check-then-write (e.g. "is this the last admin?")
 * that a unique index cannot express.
 */
export const KODA_LOCK_CLASS = { GLOBAL: 72400, PROJECT_MEMBERS: 72401 } as const;

export const GlobalLock = { USER_BOOTSTRAP: 1, USER_ADMINISTRATION: 2 } as const;
export type GlobalLockKey = (typeof GlobalLock)[keyof typeof GlobalLock];

type RawQueryClient = Pick<PrismaClient, '$queryRaw'>;

// The lock function returns `void`, which Prisma cannot deserialize, so it
// runs in a subquery and the statement returns a constant instead.
export async function lockGlobal(db: RawQueryClient, key: GlobalLockKey): Promise<void> {
  await db.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(${KODA_LOCK_CLASS.GLOBAL}::int4, ${key}::int4)) AS l`;
}

export async function lockProjectMembers(db: RawQueryClient, projectId: string): Promise<void> {
  await db.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(${KODA_LOCK_CLASS.PROJECT_MEMBERS}::int4, hashtext(${projectId}))) AS l`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && bunx jest src/common/utils/advisory-lock.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing config tests**

Append to `apps/api/src/config/auth.config.spec.ts` (inside the file, after the existing `describe`):

```ts
describe('authConfig registrationEnabled', () => {
  const prev = process.env['REGISTRATION_ENABLED'];

  afterEach(() => {
    if (prev === undefined) delete process.env['REGISTRATION_ENABLED'];
    else process.env['REGISTRATION_ENABLED'] = prev;
  });

  it('defaults to false when unset', () => {
    delete process.env['REGISTRATION_ENABLED'];
    expect(authConfig().registrationEnabled).toBe(false);
  });

  it('is true only for the string "true"', () => {
    process.env['REGISTRATION_ENABLED'] = 'true';
    expect(authConfig().registrationEnabled).toBe(true);
    process.env['REGISTRATION_ENABLED'] = 'false';
    expect(authConfig().registrationEnabled).toBe(false);
  });

  it('rejects any other value at boot', () => {
    process.env['REGISTRATION_ENABLED'] = 'yes';
    expect(() => authConfig()).toThrow();
  });
});
```

(`test-setup.ts` loads `.env.test`, so `JWT_SECRET` and the other required keys are present.)

- [ ] **Step 6: Run to verify they fail**

Run: `cd apps/api && bunx jest src/config/auth.config.spec.ts`
Expected: FAIL, `registrationEnabled` is `undefined`, and `'yes'` does not throw.

- [ ] **Step 7: Implement the config flag**

In `apps/api/src/config/auth.config.ts`: add `IsIn` to the `class-validator` import, then

```ts
export interface IAuthConfig {
  jwtSecret: string;
  jwtExpiresIn: string;
  jwtRefreshSecret: string;
  jwtRefreshExpiresIn: string;
  apiKeySecret: string | undefined;
  /** Self-registration after the bootstrap user. Default false (admin creates users). */
  registrationEnabled: boolean;
}
```

Add to `AuthConfigSchema`:

```ts
  @IsOptional()
  @IsIn(['true', 'false'])
  REGISTRATION_ENABLED?: string;
```

And to the returned object:

```ts
    registrationEnabled: process.env['REGISTRATION_ENABLED'] === 'true',
```

In `apps/api/src/common/test-helpers/global-stubs.module.ts`, add `registrationEnabled: false,` to `mockAuthConfig`.

- [ ] **Step 8: Run to verify they pass**

Run: `cd apps/api && bunx jest src/config/auth.config.spec.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing repository tests**

In `apps/api/src/auth/prisma-auth.repository.spec.ts`, inside `describe('PrismaAuthRepository.findAnyUserAndCreate bootstrap race'`:
1. Add `$queryRaw: jest.fn().mockResolvedValue([{ locked: 1 }])` to the mocked `client` in `makePrisma`, and return it as `queryRaw`.
2. Change every existing `repo.findAnyUserAndCreate(data)` call to `repo.findAnyUserAndCreate(data, { allowWhenUsersExist: true })`.
3. Add:

```ts
  it('returns null without creating when users exist and registration is closed', async () => {
    const { prisma, findFirst, create } = makePrisma();
    findFirst.mockResolvedValueOnce({ id: 'existing' });
    const repo = new PrismaAuthRepository(prisma as any, txManager);

    const result = await repo.findAnyUserAndCreate(
      { email: 'b@example.com', name: 'B', passwordHash: 'h' },
      { allowWhenUsersExist: false },
    );

    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('bootstraps on an empty table even when registration is closed', async () => {
    const { prisma, findFirst, create } = makePrisma();
    findFirst.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({
      id: 'u1', email: 'a@example.com', name: 'A', passwordHash: 'h', role: 'ADMIN',
      tokenVersion: 0, createdAt: new Date(), updatedAt: new Date(),
    });
    const repo = new PrismaAuthRepository(prisma as any, txManager);

    const result = await repo.findAnyUserAndCreate(
      { email: 'a@example.com', name: 'A', passwordHash: 'h' },
      { allowWhenUsersExist: false },
    );

    expect(result?.firstUser).toBe(true);
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ role: 'ADMIN' }) });
  });

  it('takes the bootstrap lock before the existence check', async () => {
    const { prisma, findFirst, queryRaw } = makePrisma();
    findFirst.mockResolvedValueOnce({ id: 'existing' });
    const repo = new PrismaAuthRepository(prisma as any, txManager);

    await repo.findAnyUserAndCreate({ email: 'c@example.com', name: 'C', passwordHash: 'h' }, { allowWhenUsersExist: false });

    expect(queryRaw).toHaveBeenCalled();
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(findFirst.mock.invocationCallOrder[0]);
  });
```

(Declare a `txManager` in this `describe` the same way the first `describe` does, if it is not already in scope.)

- [ ] **Step 10: Run to verify they fail**

Run: `cd apps/api && bunx jest src/auth/prisma-auth.repository.spec.ts`
Expected: FAIL (closed case creates a user; lock not called).

- [ ] **Step 11: Implement the locked bootstrap create**

In `apps/api/src/auth/prisma-auth.repository.ts`, add `import { GlobalLock, lockGlobal } from '../common/utils/advisory-lock';` and replace `findAnyUserAndCreate` (lines 46-67) with:

```ts
  /**
   * Bootstrap-safe user creation. A transaction-scoped advisory lock taken
   * before the existence check serializes concurrent registrations, so on an
   * empty table exactly one caller becomes ADMIN (Postgres has no SQLite-style
   * write serialization). Returns null and writes nothing when users already
   * exist and `allowWhenUsersExist` is false (registration closed).
   */
  async findAnyUserAndCreate(
    data: { email: string; name: string; passwordHash: string },
    options: { allowWhenUsersExist: boolean },
  ): Promise<{ user: UserDomain; firstUser: boolean } | null> {
    return this.txManager.run(async () => {
      await lockGlobal(this.db, GlobalLock.USER_BOOTSTRAP);
      const existing = await this.db.user.findFirst({ select: { id: true } });
      const firstUser = existing === null;
      if (!firstUser && !options.allowWhenUsersExist) return null;
      const m = await this.db.user.create({
        data: firstUser ? { ...data, role: 'ADMIN' } : data,
      });
      return { user: this.toDomain(m), firstUser };
    });
  }
```

- [ ] **Step 12: Run to verify they pass**

Run: `cd apps/api && bunx jest src/auth/prisma-auth.repository.spec.ts`
Expected: PASS.

- [ ] **Step 13: Write the failing service tests**

In `apps/api/src/auth/auth.service.spec.ts`:
1. Import `ForbiddenAppException` from `@nathapp/nestjs-common` and `AUTH_CFG` from `../config/auth.config`.
2. Add `const mockAuthConfig = { registrationEnabled: false };` next to the other mocks, and `{ provide: AUTH_CFG, useValue: mockAuthConfig },` to the testing module providers.
3. In `beforeEach`, reset it: `mockAuthConfig.registrationEnabled = false;`.
4. Add:

```ts
  describe('registration gate', () => {
    const dto = { email: 'late@example.com', name: 'Late', password: 'Password123!' };

    it('refuses before hashing when registration is closed and users exist', async () => {
      mockAuthRepository.findAnyUser.mockResolvedValueOnce({ id: 'existing' });
      const hashSpy = jest.spyOn(bcrypt, 'hash');

      await expect(service.register(dto)).rejects.toBeInstanceOf(ForbiddenAppException);
      expect(mockAuthRepository.findAnyUserAndCreate).not.toHaveBeenCalled();
      expect(hashSpy).not.toHaveBeenCalled();
      hashSpy.mockRestore();
    });

    it('refuses when a concurrent registration won the bootstrap race', async () => {
      mockAuthRepository.findAnyUser.mockResolvedValueOnce(null);
      mockAuthRepository.findAnyUserAndCreate.mockResolvedValueOnce(null);

      await expect(service.register(dto)).rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it('passes the flag to the repository', async () => {
      mockAuthConfig.registrationEnabled = true;
      mockAuthRepository.findAnyUser.mockResolvedValueOnce({ id: 'existing' });
      mockAuthRepository.findAnyUserAndCreate.mockResolvedValueOnce({ user: mockUser, firstUser: false });

      await service.register(dto);

      expect(mockAuthRepository.findAnyUserAndCreate).toHaveBeenCalledWith(
        expect.objectContaining({ email: dto.email }),
        { allowWhenUsersExist: true },
      );
    });
  });

  describe('registrationStatus', () => {
    it('is open on an empty user table even when the flag is off', async () => {
      mockAuthRepository.findAnyUser.mockResolvedValueOnce(null);
      expect(await service.registrationStatus()).toEqual({ open: true });
    });

    it('is closed when users exist and the flag is off', async () => {
      mockAuthRepository.findAnyUser.mockResolvedValueOnce({ id: 'u1' });
      expect(await service.registrationStatus()).toEqual({ open: false });
    });

    it('is open when the flag is on', async () => {
      mockAuthConfig.registrationEnabled = true;
      expect(await service.registrationStatus()).toEqual({ open: true });
    });
  });
```

- [ ] **Step 14: Run to verify they fail**

Run: `cd apps/api && bunx jest src/auth/auth.service.spec.ts`
Expected: FAIL (`registrationStatus is not a function`, no `ForbiddenAppException`).

- [ ] **Step 15: Implement the gate in the service**

In `apps/api/src/auth/auth.service.ts`:
- Change the imports: `import { Inject, Injectable } from '@nestjs/common';`, `import { AuthException, ForbiddenAppException } from '@nathapp/nestjs-common';`, `import { AUTH_CFG, IAuthConfig } from '../config/auth.config';`.
- Add `@Inject(AUTH_CFG) private readonly authConfig: IAuthConfig,` as the last constructor parameter.
- Replace `register` with:

```ts
  async register(registerDto: RegisterDto) {
    const { email, password } = registerDto;
    // BUG-8: never leak the email local-part into the display name
    const name = registerDto.name ?? 'User';
    const allowWhenUsersExist = this.authConfig.registrationEnabled;

    // Fast path: refuse before paying for bcrypt. The locked check in the
    // repository stays authoritative for the empty-table race.
    if (!allowWhenUsersExist && (await this.authRepo.findAnyUser()) !== null) {
      throw new ForbiddenAppException({}, 'registration');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const created = await this.authRepo.findAnyUserAndCreate(
      { email, name, passwordHash },
      { allowWhenUsersExist },
    );
    if (!created) {
      throw new ForbiddenAppException({}, 'registration');
    }
    const { user } = created;

    const accessToken = this.generateAccessToken(user.id, user.email, user.role, user.tokenVersion);
    const refreshToken = this.generateRefreshToken(user.id, user.tokenVersion);

    return {
      accessToken,
      refreshToken,
      user: UserResponseDto.from(user),
    };
  }

  async registrationStatus(): Promise<{ open: boolean }> {
    if (this.authConfig.registrationEnabled) return { open: true };
    return { open: (await this.authRepo.findAnyUser()) === null };
  }
```

- [ ] **Step 16: Run to verify they pass**

Run: `cd apps/api && bunx jest src/auth/auth.service.spec.ts`
Expected: PASS (existing tests still pass: `findAnyUser` defaults to `null`).

- [ ] **Step 17: Write the failing controller test**

In `apps/api/src/auth/auth.controller.spec.ts`, add `registrationStatus: jest.fn(),` to `mockAuthService`, import `IS_PUBLIC_KEY` from `@nathapp/nestjs-auth`, then add inside the top-level `describe`:

```ts
  describe('registrationStatus', () => {
    it('returns the service result wrapped in JsonResponse', async () => {
      mockAuthService.registrationStatus.mockResolvedValue({ open: false });
      const res = await controller.registrationStatus();
      expect(res).toEqual(expect.objectContaining({ ret: 0, data: { open: false } }));
    });

    it('is public', () => {
      const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, AuthController.prototype.registrationStatus);
      expect(isPublic).toBe(true);
    });
  });
```

- [ ] **Step 18: Run to verify it fails**

Run: `cd apps/api && bunx jest src/auth/auth.controller.spec.ts`
Expected: FAIL, `controller.registrationStatus is not a function`.

- [ ] **Step 19: Implement the DTO and route**

Create `apps/api/src/auth/dto/registration-status.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';

export class RegistrationStatusDto {
  @ApiProperty({ description: 'True when POST /auth/register will accept a new user' })
  declare open: boolean;
}
```

In `apps/api/src/auth/auth.controller.ts`, import it, add `@ApiResponse({ status: 403, description: 'Registration is closed' })` to `register`, and add after `register`:

```ts
  @Get('registration-status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Whether self-registration is open' })
  @ApiResponse({ status: 200, type: RegistrationStatusDto })
  @Public()
  async registrationStatus() {
    const data = await this.authService.registrationStatus();
    return JsonResponse.Ok(data);
  }
```

Create `apps/api/src/i18n/en/registration.json`:

```json
{
  "40003": "Registration is closed. Ask an administrator to create your account."
}
```

Create `apps/api/src/i18n/zh/registration.json`:

```json
{
  "40003": "注册已关闭，请联系管理员为您创建账号。"
}
```

- [ ] **Step 20: Run the auth unit tests**

Run: `cd apps/api && bunx jest src/auth src/config src/common/utils`
Expected: PASS.

- [ ] **Step 21: Environment files**

Append to `apps/api/.env.test`:

```
# Legacy HTTP suites register several users per app. Suites that test the
# closed registration gate boot with bootHttpApp({ registrationEnabled: false }).
REGISTRATION_ENABLED=true
```

Append to `apps/api/.env.example` (after the JWT block):

```
# Self-registration after the first (bootstrap ADMIN) user. Default false:
# a global ADMIN creates users under /admin/users. Accepts only true|false.
REGISTRATION_ENABLED=false
```

- [ ] **Step 22: Create the shared HTTP test helper**

Create `apps/api/test/helpers/http-app.ts`:

```ts
/**
 * Boot the full API (AppFactory + real guards/pipes/filters) for HTTP-level
 * integration tests. Same wiring as test/integration/projects/project-memory.
 */
import request from 'supertest';
import { AppFactory, NathApplication } from '@nathapp/nestjs-app';
import { AppModule } from '../../src/app.module';
import { CombinedAuthGuard } from '../../src/auth/guards/combined-auth.guard';

export const TEST_PASSWORD = 'Admin1234!Aa';

/**
 * Config factories read process.env during AppFactory.create, so the flag is
 * set only for the create call and restored afterwards (test files share one
 * process under maxWorkers: 1).
 */
export async function bootHttpApp(opts: { registrationEnabled: boolean }): Promise<NathApplication> {
  const previous = process.env.REGISTRATION_ENABLED;
  process.env.REGISTRATION_ENABLED = String(opts.registrationEnabled);
  try {
    const app = await AppFactory.create(AppModule);
    app.setJwtAuthGuard(app.get(CombinedAuthGuard));
    app.useAppGlobalPrefix().useAppGlobalPipes().useAppGlobalFilters().useAppGlobalGuards();
    await app.init();
    return app;
  } finally {
    if (previous === undefined) delete process.env.REGISTRATION_ENABLED;
    else process.env.REGISTRATION_ENABLED = previous;
  }
}

/** Unwrap JsonResponse { ret: 0, data: T } → data */
export function data<T = unknown>(res: request.Response): T {
  expect(res.body).toHaveProperty('ret', 0);
  return res.body.data as T;
}

export async function loginToken(
  server: Parameters<typeof request>[0],
  email: string,
  password: string = TEST_PASSWORD,
): Promise<string> {
  const res = await request(server).post('/api/auth/login').send({ email, password }).expect(200);
  return data<{ accessToken: string }>(res).accessToken;
}
```

- [ ] **Step 23: Write the registration integration test**

Create `apps/api/test/integration/auth/registration.integration.spec.ts`:

```ts
/**
 * Slice 4 — registration gate and the bootstrap-admin race on real Postgres.
 * Each describe boots its own app: the register route is throttled to
 * 5 requests / minute per app instance.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/auth/registration
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

function registerAll(server: Parameters<typeof request>[0], count: number) {
  return Promise.all(
    Array.from({ length: count }, (_, i) =>
      request(server).post('/api/auth/register').send({ email: `race${i}@koda.test`, name: `R${i}`, password: TEST_PASSWORD }),
    ),
  );
}

describeIntegration('registration closed (default)', () => {
  let app: NathApplication;
  let prisma: PrismaService<PrismaClient>;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports open while the user table is empty', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/registration-status').expect(200);
    expect(data<{ open: boolean }>(res)).toEqual({ open: true });
  });

  it('5 concurrent registrations on an empty DB: exactly one ADMIN, the rest 403', async () => {
    const results = await registerAll(app.getHttpServer(), 5);
    const statuses = results.map((r) => r.status).sort();

    expect(statuses).toEqual([201, 403, 403, 403, 403]);
    const users = await prisma.client.user.findMany();
    expect(users).toHaveLength(1);
    expect(users[0].role).toBe('ADMIN');
  });

  it('reports closed once a user exists', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/registration-status').expect(200);
    expect(data<{ open: boolean }>(res)).toEqual({ open: false });
  });
});

describeIntegration('registration open (REGISTRATION_ENABLED=true)', () => {
  let app: NathApplication;
  let prisma: PrismaService<PrismaClient>;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('5 concurrent registrations: all succeed, exactly one ADMIN', async () => {
    const results = await registerAll(app.getHttpServer(), 5);

    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(await prisma.client.user.count()).toBe(5);
    expect(await prisma.client.user.count({ where: { role: 'ADMIN' } })).toBe(1);
  });
});
```

- [ ] **Step 24: Run it**

Run: `cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/auth/registration`
Expected: PASS (4 tests). If the closed suite returns five 201s, the flag did not reach the config: check that `bootHttpApp` sets the env var before `AppFactory.create`. If it returns more than one ADMIN, the lock is not inside the transaction.

- [ ] **Step 25: Run the full integration suite (Review Focus 3)**

Run: `cd apps/api && bun run test:integration`
Expected: PASS, same suite count as `main` plus the new file. No suite fails with 403 on `/api/auth/register`.

- [ ] **Step 26: Commit**

```bash
git add apps/api/src/common/utils/advisory-lock.ts apps/api/src/common/utils/advisory-lock.spec.ts \
  apps/api/src/config/auth.config.ts apps/api/src/config/auth.config.spec.ts \
  apps/api/src/common/test-helpers/global-stubs.module.ts \
  apps/api/src/auth/prisma-auth.repository.ts apps/api/src/auth/prisma-auth.repository.spec.ts \
  apps/api/src/auth/auth.service.ts apps/api/src/auth/auth.service.spec.ts \
  apps/api/src/auth/auth.controller.ts apps/api/src/auth/auth.controller.spec.ts \
  apps/api/src/auth/dto/registration-status.dto.ts apps/api/src/i18n/en/registration.json apps/api/src/i18n/zh/registration.json \
  apps/api/.env.test apps/api/.env.example apps/api/test/helpers/http-app.ts \
  apps/api/test/integration/auth/registration.integration.spec.ts
git commit -m "feat(auth): close registration by default, advisory-locked bootstrap admin"
```

---

### Task 2: `User.disabled` and disabled-user rejection

**Files:**
- Modify: `apps/api/prisma/schema.prisma:24-38`
- Create: `apps/api/prisma/migrations/20260926130000_user_disabled/migration.sql`
- Modify: `apps/api/src/auth/domain/auth.domain.ts`
- Modify: `apps/api/src/auth/prisma-auth.repository.ts` (`toDomain`)
- Modify: `apps/api/src/auth/token-version.cache.ts`
- Modify: `apps/api/src/auth/jwt-auth.provider.ts`, `apps/api/src/auth/jwt-auth.provider.spec.ts`
- Modify: `apps/api/src/auth/koda-jwt-refresh-strategy.provider.ts`, `apps/api/src/auth/koda-jwt-refresh-strategy.provider.spec.ts`
- Modify: `apps/api/src/auth/auth.service.ts` (`login`, `refresh`), `apps/api/src/auth/auth.service.spec.ts`
- Modify: `apps/api/src/auth/dto/auth-response.dto.ts`
- Create: `apps/api/test/integration/auth/disabled-user.integration.spec.ts`

**Interfaces:**
- Consumes: `bootHttpApp`, `data`, `loginToken`, `TEST_PASSWORD` (Task 1).
- Produces: `UserDomain.disabled: boolean`; `interface UserAuthState { tokenVersion: number; disabled: boolean }`; `userAuthStateCacheKey(userId): string[]`; `userTokenVersionCacheTag(userId)` unchanged (Task 3 invalidates it).

- [ ] **Step 1: Schema and migration**

In `apps/api/prisma/schema.prisma`, model `User`, after `tokenVersion`:

```prisma
  disabled     Boolean   @default(false)
```

Create `apps/api/prisma/migrations/20260926130000_user_disabled/migration.sql`:

```sql
-- Slice 4: disabling replaces user deletion (tickets, comments and activity reference users).
ALTER TABLE "User" ADD COLUMN "disabled" BOOLEAN NOT NULL DEFAULT false;
```

Run: `cd apps/api && bunx prisma generate`
Expected: `Generated Prisma Client`.

- [ ] **Step 2: Prove the migrations match the schema (no drift)**

Run:
```bash
cd apps/api
docker compose -f ../../docker-compose.test.yml exec -T postgres-test createdb -U koda koda_shadow 2>/dev/null || true
bunx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url postgresql://koda:koda@localhost:5433/koda_shadow --exit-code
```
Expected: `No difference detected.` and exit code 0. If it prints a diff, fix `migration.sql` (not the schema).

- [ ] **Step 3: Write the failing provider tests**

Replace the body of `apps/api/src/auth/jwt-auth.provider.spec.ts` tests (keep the module setup) with:

```ts
  const payload = (tokenVersion: number) => ({ sub: 'user-1', email: 'a@b.com', role: 'MEMBER', tokenVersion });

  it('is not revoked when the state matches the token', async () => {
    mockCacheManager.get.mockResolvedValue({ tokenVersion: 0, disabled: false });
    expect((await provider.getPrincipal(payload(0))).revoked).toBe(false);
  });

  it('is revoked when the current tokenVersion is ahead of the token', async () => {
    mockCacheManager.get.mockResolvedValue({ tokenVersion: 2, disabled: false });
    expect((await provider.getPrincipal(payload(1))).revoked).toBe(true);
  });

  it('is revoked when the user is disabled, even with a current tokenVersion', async () => {
    mockCacheManager.get.mockResolvedValue({ tokenVersion: 0, disabled: true });
    expect((await provider.getPrincipal(payload(0))).revoked).toBe(true);
  });

  it('loads the state from the repository on a cache miss', async () => {
    mockCacheManager.get.mockImplementation(async (_keys: unknown, resolver: () => Promise<unknown>) => resolver());
    mockAuthRepository.findUserById.mockResolvedValue({ tokenVersion: 1, disabled: false });

    const principal = await provider.getPrincipal(payload(1));

    expect(mockAuthRepository.findUserById).toHaveBeenCalledWith('user-1');
    expect(principal.revoked).toBe(false);
    expect(mockCacheManager.get).toHaveBeenCalledWith(
      ['user-auth-state', 'user-1'], expect.any(Function), 60_000, { tags: ['USER:user-1'] },
    );
  });

  it('treats a user that no longer exists as revoked', async () => {
    mockCacheManager.get.mockImplementation(async (_keys: unknown, resolver: () => Promise<unknown>) => resolver());
    mockAuthRepository.findUserById.mockResolvedValue(null);
    expect((await provider.getPrincipal(payload(0))).revoked).toBe(true);
  });
```

Append to `apps/api/src/auth/koda-jwt-refresh-strategy.provider.spec.ts` (existing fixtures without `disabled` stay valid: `undefined` is falsy):

```ts
  it('is revoked when the user is disabled, even with a current tokenVersion', async () => {
    mockAuthRepository.findUserById.mockResolvedValue({ tokenVersion: 0, disabled: true });

    const principal = await provider.validate({ headers: {} }, { sub: 'user-1', tokenVersion: 0 });

    expect(principal.revoked).toBe(true);
  });
```

- [ ] **Step 4: Run to verify they fail**

Run: `cd apps/api && bunx jest src/auth/jwt-auth.provider.spec.ts src/auth/koda-jwt-refresh-strategy.provider.spec.ts`
Expected: FAIL (disabled not honored; old cache key).

- [ ] **Step 5: Implement the auth state**

`apps/api/src/auth/domain/auth.domain.ts`: add `disabled: boolean;` to `UserDomain` after `tokenVersion`.

`apps/api/src/auth/prisma-auth.repository.ts` `toDomain`: add `disabled: m.disabled,`.

Replace `apps/api/src/auth/token-version.cache.ts` with:

```ts
/** Per-user revocation state, cached for 60 s by JwtAuthProvider. */
export interface UserAuthState {
  tokenVersion: number;
  disabled: boolean;
}

export function userAuthStateCacheKey(userId: string): string[] {
  return ['user-auth-state', userId];
}

/** Invalidate after any write to tokenVersion, disabled or role. */
export function userTokenVersionCacheTag(userId: string): string {
  return `USER:${userId}`;
}
```

Run `grep -rn "userTokenVersionCacheKey" apps/api/src apps/api/test` and replace any remaining use (there should be none after the next edit).

In `apps/api/src/auth/jwt-auth.provider.ts`, import `UserAuthState, userAuthStateCacheKey, userTokenVersionCacheTag` and replace the cache lookup and `revoked` line:

```ts
    const state = await this.cache.get<UserAuthState>(
      userAuthStateCacheKey(id),
      async () => {
        const user = await this.authRepo.findUserById(id);
        // A user that no longer resolves must not keep a valid session.
        return { tokenVersion: user?.tokenVersion ?? 0, disabled: user?.disabled ?? true };
      },
      60_000,
      { tags: [userTokenVersionCacheTag(id)] },
    );
    const revoked = !state || state.disabled || state.tokenVersion > tokenVersion;
```

and use `revoked,` in the returned principal.

In `apps/api/src/auth/koda-jwt-refresh-strategy.provider.ts`:

```ts
    const revoked = !user || user.disabled || user.tokenVersion > tokenVersion;
```

In `apps/api/src/auth/dto/auth-response.dto.ts`, add to `UserResponseDto` after `role`:

```ts
  @ApiProperty()
  disabled!: boolean;
```

- [ ] **Step 6: Run to verify they pass**

Run: `cd apps/api && bunx jest src/auth/jwt-auth.provider.spec.ts src/auth/koda-jwt-refresh-strategy.provider.spec.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing service tests**

In `apps/api/src/auth/auth.service.spec.ts`, add `disabled: false` to `mockUser`, then:

```ts
  describe('disabled users', () => {
    it('login rejects a disabled user with the same error as a bad password', async () => {
      const passwordHash = await bcrypt.hash('Password123!', 4);
      mockAuthRepository.findUserByEmail.mockResolvedValueOnce({ ...mockUser, passwordHash, disabled: true });

      await expect(service.login({ email: mockUser.email, password: 'Password123!' })).rejects.toBeInstanceOf(AuthException);
    });

    it('refresh refuses to mint tokens for a disabled user', async () => {
      mockAuthRepository.findUserById.mockResolvedValueOnce({ ...mockUser, disabled: true });

      await expect(service.refresh({ id: mockUser.id, revoked: false } as IPrincipal)).rejects.toBeInstanceOf(AuthException);
    });
  });
```

- [ ] **Step 8: Run to verify they fail**

Run: `cd apps/api && bunx jest src/auth/auth.service.spec.ts`
Expected: FAIL (tokens issued for disabled users).

- [ ] **Step 9: Implement**

In `apps/api/src/auth/auth.service.ts` `login`, replace the password check with:

```ts
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    // A disabled account answers exactly like a wrong password (no enumeration).
    if (!isPasswordValid || user.disabled) {
      throw new AuthException({}, 'auth');
    }
```

In `refresh`, change `if (!user) {` to `if (!user || user.disabled) {`.

- [ ] **Step 10: Run to verify they pass**

Run: `cd apps/api && bunx jest src/auth`
Expected: PASS.

- [ ] **Step 11: Write the integration test**

Create `apps/api/test/integration/auth/disabled-user.integration.spec.ts`:

```ts
/**
 * Slice 4 — a disabled user cannot log in, refresh, or use a fresh access token.
 * (Disabling through PATCH /admin/users, including cache invalidation for a
 * session already in use, is covered in test/integration/users.)
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/auth/disabled-user
 */
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('disabled users (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaService<PrismaClient>;
  let server: ReturnType<NathApplication['getHttpServer']>;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
    await prisma.client.user.create({
      data: { email: 'dis@koda.test', name: 'Dis', passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('an access token issued before the disable is rejected on first use', async () => {
    const login = await request(server).post('/api/auth/login').send({ email: 'dis@koda.test', password: TEST_PASSWORD }).expect(200);
    const { accessToken, refreshToken } = data<{ accessToken: string; refreshToken: string }>(login);

    await prisma.client.user.update({ where: { email: 'dis@koda.test' }, data: { disabled: true } });

    await request(server).get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
    await request(server).post('/api/auth/refresh').set('Authorization', `Bearer ${refreshToken}`).expect(401);
  });

  it('a disabled user cannot log in', async () => {
    await request(server).post('/api/auth/login').send({ email: 'dis@koda.test', password: TEST_PASSWORD }).expect(401);
  });
});
```

- [ ] **Step 12: Run it**

Run: `cd apps/api && bun run test:integration -- test/integration/auth`
Expected: PASS (Task 1 and Task 2 files).

- [ ] **Step 13: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260926130000_user_disabled \
  apps/api/src/auth apps/api/test/integration/auth/disabled-user.integration.spec.ts
git commit -m "feat(auth): User.disabled rejected at login, refresh and the JWT strategy"
```

---

### Task 3: Global user administration (`/admin/users`)

**Files:**
- Create: `apps/api/src/common/exceptions/conflict-app.exception.ts` (+ `.spec.ts`)
- Create: `apps/api/src/common/utils/prisma-errors.ts` (+ `.spec.ts`)
- Modify: `apps/api/src/common/utils/ticket-number-retry.ts:28-36`
- Modify: `apps/api/src/auth/dto/register.dto.ts`
- Create: `apps/api/src/users/domain/user-admin.domain.ts`
- Create: `apps/api/src/users/dto/list-users.query.ts`, `create-user.dto.ts`, `update-user.dto.ts`, `user-admin.dto.ts`, `user-dto.spec.ts`
- Create: `apps/api/src/users/prisma-users.repository.ts`
- Create: `apps/api/src/users/users-admin.service.ts` (+ `.spec.ts`)
- Create: `apps/api/src/users/admin-users.controller.ts` (+ `.spec.ts`)
- Create: `apps/api/src/users/users.module.ts` (+ `.spec.ts`)
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/src/i18n/en/users.json`, `apps/api/src/i18n/zh/users.json`
- Create: `apps/api/test/integration/users/admin-users.integration.spec.ts`

**Interfaces:**
- Consumes: `lockGlobal`, `GlobalLock.USER_ADMINISTRATION` (Task 1); `userTokenVersionCacheTag` (Task 2); `KodaPageQuery`, `parseQuery`, `toPageResult`, `remapPage` (Slice 3).
- Produces: `ConflictAppException(args?, prefix?)` (Task 4); `isUniqueViolation(error: unknown, field: string): boolean` (Task 4); `PASSWORD_COMPLEXITY: RegExp`.
- Produces: `UsersAdminService.list(filters: UserListFilters, page: IPageOption): Promise<IPageResult<UserAdminDto>>`, `.create(dto: CreateUserDto): Promise<UserAdminDto>`, `.update(actorId: string, userId: string, patch: UpdateUserDto): Promise<UserAdminDto>`.
- Produces (wire): `UserAdminDto = { id, email, name, role, disabled, createdAt, updatedAt }`. OpenAPI operation ids `AdminUsersController_list|create|update` (Task 6 CLI).

- [ ] **Step 1: Write the failing shared-helper tests**

Create `apps/api/src/common/exceptions/conflict-app.exception.spec.ts`:

```ts
import { AppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from './conflict-app.exception';

describe('ConflictAppException', () => {
  it('is an AppException with code 409 and HTTP 409', () => {
    const ex = new ConflictAppException({}, 'users');
    expect(ex).toBeInstanceOf(AppException);
    expect(ex.code).toBe(409);
    expect(ex.httpStatus).toBe(409);
    expect(ex.prefix).toBe('users');
  });
});
```

Create `apps/api/src/common/utils/prisma-errors.spec.ts`:

```ts
import { Prisma } from '@prisma/client';
import { isUniqueViolation } from './prisma-errors';

function p2002(target: unknown) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002', clientVersion: 'test', meta: { target },
  });
}

describe('isUniqueViolation', () => {
  it('matches P2002 on the named field (array or string target)', () => {
    expect(isUniqueViolation(p2002(['email']), 'email')).toBe(true);
    expect(isUniqueViolation(p2002('User_email_key'), 'email')).toBe(true);
  });

  it('ignores other fields, other codes and non-Prisma errors', () => {
    expect(isUniqueViolation(p2002(['number']), 'email')).toBe(false);
    expect(isUniqueViolation(new Error('boom'), 'email')).toBe(false);
    expect(isUniqueViolation(
      new Prisma.PrismaClientKnownRequestError('x', { code: 'P2025', clientVersion: 'test' }), 'email',
    )).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && bunx jest src/common/exceptions src/common/utils/prisma-errors.spec.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement them**

Create `apps/api/src/common/exceptions/conflict-app.exception.ts`:

```ts
import { AppException } from '@nathapp/nestjs-common';

/**
 * 409 for state conflicts (duplicate email, last admin). @nathapp/nestjs-common
 * has no conflict AppException; this one keeps the i18n `<prefix>.409` lookup
 * that plain HttpException(…, CONFLICT) skips.
 */
export class ConflictAppException extends AppException {
  constructor(args: Record<string, unknown> = {}, prefix?: string) {
    super(409, args, prefix, 409);
  }
}
```

Create `apps/api/src/common/utils/prisma-errors.ts`:

```ts
import { Prisma } from '@prisma/client';

/** True for a Postgres unique violation (P2002) whose target names `field`. */
export function isUniqueViolation(error: unknown, field: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) return target.includes(field);
  if (typeof target === 'string') return target.includes(field);
  return false;
}
```

In `apps/api/src/common/utils/ticket-number-retry.ts`, replace the body of `isTicketNumberConflict` with `return isUniqueViolation(error, 'number');` (import it; drop the now-unused `Prisma` import if nothing else uses it).

In `apps/api/src/auth/dto/register.dto.ts`, hoist the regex:

```ts
export const PASSWORD_COMPLEXITY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).+$/;
```

and use `@Matches(PASSWORD_COMPLEXITY, { … })` in `RegisterDto`.

Run: `cd apps/api && bunx jest src/common src/auth/dto`
Expected: PASS (including the existing ticket-number-retry and register DTO specs).

- [ ] **Step 4: Write the failing DTO tests**

Create `apps/api/src/users/dto/user-dto.spec.ts`:

```ts
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateUserDto } from './create-user.dto';
import { UpdateUserDto } from './update-user.dto';
import { ListUsersQuery } from './list-users.query';
import { parseQuery } from '../../common/dto/koda-page.query';

const errorsOf = async (cls: new () => object, raw: object) =>
  (await validate(plainToInstance(cls, raw))).map((e) => e.property);

describe('user admin DTOs', () => {
  it('CreateUserDto accepts a valid user and rejects weak passwords and unknown roles', async () => {
    const ok = { email: 'a@koda.test', name: 'A', password: 'Admin1234!Aa', role: 'MEMBER' };
    expect(await errorsOf(CreateUserDto, ok)).toEqual([]);
    expect(await errorsOf(CreateUserDto, { ...ok, password: 'short' })).toContain('password');
    expect(await errorsOf(CreateUserDto, { ...ok, role: 'OWNER' })).toContain('role');
    expect(await errorsOf(CreateUserDto, { ...ok, email: 'nope' })).toContain('email');
  });

  it('UpdateUserDto allows an empty patch and rejects non-boolean disabled', async () => {
    expect(await errorsOf(UpdateUserDto, {})).toEqual([]);
    expect(await errorsOf(UpdateUserDto, { disabled: 'yes' })).toContain('disabled');
    expect(await errorsOf(UpdateUserDto, { role: 'VIEWER' })).toContain('role');
  });

  it('ListUsersQuery parses paging and keeps the email filter', () => {
    expect(parseQuery(ListUsersQuery, { current: '2', size: '5', email: 'bob' }))
      .toEqual(expect.objectContaining({ current: 2, size: 5, email: 'bob' }));
  });
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `cd apps/api && bunx jest src/users/dto`
Expected: FAIL, modules not found.

- [ ] **Step 6: Implement domain and DTOs**

Create `apps/api/src/users/domain/user-admin.domain.ts`:

```ts
export const GLOBAL_ROLES = ['MEMBER', 'ADMIN'] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

export interface UserAdminRecord {
  id: string;
  email: string;
  name: string | null;
  role: string;
  disabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserListFilters {
  email?: string;
}

export interface UserAdminWrite {
  role?: GlobalRole;
  disabled?: boolean;
  /** Revoke outstanding tokens in the same UPDATE. */
  bumpTokenVersion: boolean;
}
```

Create `apps/api/src/users/dto/list-users.query.ts`:

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { KodaPageQuery } from '../../common/dto/koda-page.query';

export class ListUsersQuery extends KodaPageQuery {
  @ApiPropertyOptional({ description: 'Case-insensitive substring match on email' })
  @IsOptional()
  @IsString()
  @MaxLength(254)
  email?: string;
}
```

Create `apps/api/src/users/dto/create-user.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_COMPLEXITY } from '../../auth/dto/register.dto';
import { GLOBAL_ROLES, GlobalRole } from '../domain/user-admin.domain';

export class CreateUserDto {
  @ApiProperty({ example: 'dev@example.com' })
  @IsEmail({}, { message: '$t(common.validation.isEmail)' })
  declare email: string;

  @ApiProperty({ example: 'Dev User' })
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(1, { message: '$t(common.validation.minLength)' })
  @MaxLength(100, { message: '$t(common.validation.maxLength)' })
  declare name: string;

  @ApiProperty({ description: 'Temporary password, handed over out of band', example: 'StrongPass123!' })
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(8, { message: '$t(common.validation.minLength)' })
  @Matches(PASSWORD_COMPLEXITY, { message: '$t(common.validation.passwordComplexity)' })
  declare password: string;

  @ApiProperty({ enum: GLOBAL_ROLES })
  @IsIn(GLOBAL_ROLES, { message: '$t(common.validation.isEnum)' })
  declare role: GlobalRole;
}
```

Create `apps/api/src/users/dto/update-user.dto.ts`:

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { GLOBAL_ROLES, GlobalRole } from '../domain/user-admin.domain';

export class UpdateUserDto {
  @ApiPropertyOptional({ enum: GLOBAL_ROLES })
  @IsOptional()
  @IsIn(GLOBAL_ROLES, { message: '$t(common.validation.isEnum)' })
  role?: GlobalRole;

  @ApiPropertyOptional({ description: 'Disabling revokes every session of the user' })
  @IsOptional()
  @IsBoolean({ message: '$t(common.validation.isBoolean)' })
  disabled?: boolean;
}
```

Create `apps/api/src/users/dto/user-admin.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserAdminRecord } from '../domain/user-admin.domain';

export class UserAdminDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare email: string;
  @ApiPropertyOptional({ nullable: true, type: String }) declare name: string | null;
  @ApiProperty({ enum: ['MEMBER', 'ADMIN'] }) declare role: string;
  @ApiProperty() declare disabled: boolean;
  @ApiProperty() declare createdAt: Date;
  @ApiProperty() declare updatedAt: Date;

  static from(r: UserAdminRecord): UserAdminDto {
    return {
      id: r.id, email: r.email, name: r.name, role: r.role,
      disabled: r.disabled, createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
  }
}
```

- [ ] **Step 7: Run to verify it passes**

Run: `cd apps/api && bunx jest src/users/dto`
Expected: PASS.

- [ ] **Step 8: Implement the repository**

Create `apps/api/src/users/prisma-users.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Paginate, PrismaService } from '@nathapp/nestjs-prisma';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { Prisma, PrismaClient, User } from '@prisma/client';
import { GlobalLock, lockGlobal } from '../common/utils/advisory-lock';
import { GlobalRole, UserAdminRecord, UserAdminWrite, UserListFilters } from './domain/user-admin.domain';

@Injectable()
export class PrismaUsersRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  private toRecord(m: User): UserAdminRecord {
    return {
      id: m.id, email: m.email, name: m.name, role: m.role,
      disabled: m.disabled, createdAt: m.createdAt, updatedAt: m.updatedAt,
    };
  }

  async findUserPage(filters: UserListFilters, page: IPageOption): Promise<IPageResult<UserAdminRecord>> {
    const where: Prisma.UserWhereInput = filters.email
      ? { email: { contains: filters.email, mode: 'insensitive' } }
      : {};
    const rows = await Paginate(this.db.user, page, { where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.remap((m: User) => this.toRecord(m));
  }

  async findById(id: string): Promise<UserAdminRecord | null> {
    const m = await this.db.user.findUnique({ where: { id } });
    return m ? this.toRecord(m) : null;
  }

  async createUser(data: { email: string; name: string; passwordHash: string; role: GlobalRole }): Promise<UserAdminRecord> {
    return this.toRecord(await this.db.user.create({ data }));
  }

  async countActiveAdmins(): Promise<number> {
    return this.db.user.count({ where: { role: 'ADMIN', disabled: false } });
  }

  async updateUser(id: string, write: UserAdminWrite): Promise<UserAdminRecord> {
    const m = await this.db.user.update({
      where: { id },
      data: {
        ...(write.role !== undefined && { role: write.role }),
        ...(write.disabled !== undefined && { disabled: write.disabled }),
        ...(write.bumpTokenVersion && { tokenVersion: { increment: 1 } }),
      },
    });
    return this.toRecord(m);
  }

  /** Serializes last-admin checks. Call inside txManager.run only. */
  async lockUserAdministration(): Promise<void> {
    await lockGlobal(this.db, GlobalLock.USER_ADMINISTRATION);
  }
}
```

(Repository behavior is covered by the Task 3 integration test: it needs real Postgres for `mode: 'insensitive'`, the lock and `increment`.)

- [ ] **Step 9: Write the failing service tests**

Create `apps/api/src/users/users-admin.service.spec.ts`:

```ts
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { Prisma } from '@prisma/client';
import { UsersAdminService } from './users-admin.service';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import type { UserAdminRecord } from './domain/user-admin.domain';

const user = (over: Partial<UserAdminRecord> = {}): UserAdminRecord => ({
  id: 'u2', email: 'u2@koda.test', name: 'U2', role: 'MEMBER', disabled: false,
  createdAt: new Date(0), updatedAt: new Date(0), ...over,
});

describe('UsersAdminService', () => {
  let repo: Record<string, jest.Mock>;
  let cache: { invalidate: jest.Mock };
  let service: UsersAdminService;

  beforeEach(() => {
    repo = {
      findUserPage: jest.fn(),
      findById: jest.fn(),
      createUser: jest.fn(),
      countActiveAdmins: jest.fn(),
      updateUser: jest.fn(async (id: string, w: { role?: string; disabled?: boolean }) => user({ id, ...w })),
      lockUserAdministration: jest.fn(),
    };
    cache = { invalidate: jest.fn() };
    const txManager = { run: <T>(fn: () => Promise<T>) => fn(), isInTransaction: () => false };
    service = new UsersAdminService(repo as never, txManager as never, cache as never);
  });

  describe('create', () => {
    it('hashes the password and never returns it', async () => {
      // A record carrying an extra passwordHash proves UserAdminDto.from drops it.
      repo.createUser.mockImplementation(async (d: { passwordHash: string }) => ({ ...user(), passwordHash: d.passwordHash }));
      const dto = await service.create({ email: 'n@k.t', name: 'N', password: 'Admin1234!Aa', role: 'MEMBER' });
      const written = repo.createUser.mock.calls[0][0];
      expect(written.passwordHash).not.toBe('Admin1234!Aa');
      expect(dto).not.toHaveProperty('passwordHash');
    });

    it('maps a duplicate email to ConflictAppException', async () => {
      repo.createUser.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002', clientVersion: 'test', meta: { target: ['email'] },
      }));
      await expect(service.create({ email: 'd@k.t', name: 'D', password: 'Admin1234!Aa', role: 'MEMBER' }))
        .rejects.toBeInstanceOf(ConflictAppException);
    });
  });

  describe('update', () => {
    it('refuses to demote or disable yourself', async () => {
      await expect(service.update('u1', 'u1', { disabled: true })).rejects.toBeInstanceOf(ForbiddenAppException);
      await expect(service.update('u1', 'u1', { role: 'MEMBER' })).rejects.toBeInstanceOf(ForbiddenAppException);
      expect(repo.updateUser).not.toHaveBeenCalled();
    });

    it('404s an unknown user', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.update('u1', 'nope', { disabled: true })).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('refuses to remove the last active admin, under the lock', async () => {
      repo.findById.mockResolvedValue(user({ role: 'ADMIN' }));
      repo.countActiveAdmins.mockResolvedValue(1);

      await expect(service.update('u1', 'u2', { role: 'MEMBER' })).rejects.toBeInstanceOf(ConflictAppException);
      expect(repo.lockUserAdministration).toHaveBeenCalled();
      expect(repo.lockUserAdministration.mock.invocationCallOrder[0]).toBeLessThan(repo.countActiveAdmins.mock.invocationCallOrder[0]);
      expect(repo.updateUser).not.toHaveBeenCalled();
    });

    it('disables an admin when another active admin remains, bumping tokenVersion', async () => {
      repo.findById.mockResolvedValue(user({ role: 'ADMIN' }));
      repo.countActiveAdmins.mockResolvedValue(2);

      await service.update('u1', 'u2', { disabled: true });

      expect(repo.updateUser).toHaveBeenCalledWith('u2', { role: undefined, disabled: true, bumpTokenVersion: true });
      expect(cache.invalidate).toHaveBeenCalledWith('USER:u2', { mode: 'tag' });
    });

    it('bumps tokenVersion on a role change, not on re-enable', async () => {
      repo.findById.mockResolvedValueOnce(user({ role: 'MEMBER' }));
      await service.update('u1', 'u2', { role: 'ADMIN' });
      expect(repo.updateUser).toHaveBeenLastCalledWith('u2', expect.objectContaining({ bumpTokenVersion: true }));

      repo.findById.mockResolvedValueOnce(user({ disabled: true }));
      await service.update('u1', 'u2', { disabled: false });
      expect(repo.updateUser).toHaveBeenLastCalledWith('u2', expect.objectContaining({ bumpTokenVersion: false }));
    });

    it('does not count admins for a MEMBER target', async () => {
      repo.findById.mockResolvedValue(user({ role: 'MEMBER' }));
      await service.update('u1', 'u2', { disabled: true });
      expect(repo.countActiveAdmins).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 10: Run to verify it fails**

Run: `cd apps/api && bunx jest src/users/users-admin.service.spec.ts`
Expected: FAIL, module not found.

- [ ] **Step 11: Implement the service**

Create `apps/api/src/users/users-admin.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import { IPageResult, ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { CacheManager } from '@nathapp/nestjs-cache';
import * as bcrypt from 'bcrypt';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { remapPage } from '../common/dto/koda-page.query';
import { isUniqueViolation } from '../common/utils/prisma-errors';
import { userTokenVersionCacheTag } from '../auth/token-version.cache';
import { PrismaUsersRepository } from './prisma-users.repository';
import { UserListFilters } from './domain/user-admin.domain';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserAdminDto } from './dto/user-admin.dto';

@Injectable()
export class UsersAdminService {
  constructor(
    private readonly usersRepo: PrismaUsersRepository,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly cache: CacheManager,
  ) {}

  async list(filters: UserListFilters, page: IPageOption): Promise<IPageResult<UserAdminDto>> {
    return remapPage(await this.usersRepo.findUserPage(filters, page), UserAdminDto.from);
  }

  async create(dto: CreateUserDto): Promise<UserAdminDto> {
    const passwordHash = await bcrypt.hash(dto.password, 12);
    try {
      const user = await this.usersRepo.createUser({ email: dto.email, name: dto.name, passwordHash, role: dto.role });
      return UserAdminDto.from(user);
    } catch (error) {
      if (isUniqueViolation(error, 'email')) throw new ConflictAppException({}, 'users');
      throw error;
    }
  }

  async update(actorId: string, userId: string, patch: UpdateUserDto): Promise<UserAdminDto> {
    const demotes = patch.role !== undefined && patch.role !== 'ADMIN';
    const disables = patch.disabled === true;
    if (actorId === userId && (demotes || disables)) {
      throw new ForbiddenAppException({}, 'users.self');
    }

    const updated = await this.txManager.run(async () => {
      await this.usersRepo.lockUserAdministration();
      const target = await this.usersRepo.findById(userId);
      if (!target) throw new NotFoundAppException({}, 'users');

      const removesActiveAdmin = target.role === 'ADMIN' && !target.disabled && (demotes || disables);
      if (removesActiveAdmin && (await this.usersRepo.countActiveAdmins()) <= 1) {
        throw new ConflictAppException({}, 'users.lastAdmin');
      }

      // The access token carries `role`, so a role change revokes it as well.
      const roleChanged = patch.role !== undefined && patch.role !== target.role;
      const newlyDisabled = disables && !target.disabled;
      return this.usersRepo.updateUser(userId, {
        role: patch.role,
        disabled: patch.disabled,
        bumpTokenVersion: roleChanged || newlyDisabled,
      });
    });

    await this.cache.invalidate(userTokenVersionCacheTag(userId), { mode: 'tag' });
    return UserAdminDto.from(updated);
  }
}
```

- [ ] **Step 12: Run to verify it passes**

Run: `cd apps/api && bunx jest src/users/users-admin.service.spec.ts`
Expected: PASS.

- [ ] **Step 13: Write the failing controller and module tests**

Create `apps/api/src/users/admin-users.controller.spec.ts`:

```ts
import { PERMISSION_KEY } from '@nathapp/nestjs-auth';
import { AdminUsersController } from './admin-users.controller';

describe('AdminUsersController', () => {
  const service = { list: jest.fn(), create: jest.fn(), update: jest.fn() };
  const controller = new AdminUsersController(service as never);
  const page = { total: 1, current: 2, size: 5, hasNext: false, hasPrev: true, records: [{ id: 'u1' }] };

  afterEach(() => jest.clearAllMocks());

  it('parses paging strings and forwards the email filter', async () => {
    service.list.mockResolvedValue(page);
    const res = await controller.list({ current: '2', size: '5', email: 'bob' } as never);
    expect(service.list).toHaveBeenCalledWith({ email: 'bob' }, { current: 2, size: 5 });
    expect(res).toEqual(expect.objectContaining({ ret: 0, data: page }));
  });

  it('passes the acting principal id to update', async () => {
    service.update.mockResolvedValue({ id: 'u2' });
    await controller.update('u2', { disabled: true }, { id: 'u1', actorType: 'user' } as never);
    expect(service.update).toHaveBeenCalledWith('u1', 'u2', { disabled: true });
  });

  it.each(['list', 'create', 'update'] as const)('%s requires the global ADMIN permission', (method) => {
    const perms = Reflect.getMetadata(PERMISSION_KEY, AdminUsersController.prototype[method]);
    expect(JSON.stringify(perms)).toContain('ADMIN');
  });
});
```

Create `apps/api/src/users/users.module.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { AdminUsersController } from './admin-users.controller';
import { UsersAdminService } from './users-admin.service';

describe('UsersModule — DI wiring', () => {
  it('AdminUsersController resolves with its service', async () => {
    const module = await Test.createTestingModule({
      controllers: [AdminUsersController],
      providers: [{ provide: UsersAdminService, useValue: {} }],
    }).compile();
    expect(module.get(AdminUsersController)).toBeDefined();
    await module.close();
  });
});
```

(If `PERMISSION_KEY` metadata is stored under a different shape, assert against what `Reflect.getMetadata` returns for the existing `ProjectsController.prototype.create`, which uses the same `@RequiredPermission('ADMIN')`.)

- [ ] **Step 14: Run to verify they fail**

Run: `cd apps/api && bunx jest src/users`
Expected: FAIL, controller not found.

- [ ] **Step 15: Implement controller and module, register it**

Create `apps/api/src/users/admin-users.controller.ts`:

```ts
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { parseQuery, toPageResult } from '../common/dto/koda-page.query';
import { UsersAdminService } from './users-admin.service';
import { ListUsersQuery } from './dto/list-users.query';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserAdminDto } from './dto/user-admin.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: UsersAdminService) {}

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'List users (global admin)' })
  @ApiResponse({ status: 200, description: 'Page of users: { total, current, size, hasNext, hasPrev, records }' })
  @ApiResponse({ status: 403, description: 'Global admin role required' })
  async list(@Query() rawQuery: ListUsersQuery) {
    const { current, size, email } = parseQuery(ListUsersQuery, rawQuery);
    const page = await this.users.list({ email }, { current, size });
    return JsonResponse.Ok(toPageResult(page));
  }

  @Post()
  @HttpCode(201)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Create a user with a temporary password (global admin)' })
  @ApiResponse({ status: 201, type: UserAdminDto })
  @ApiResponse({ status: 409, description: 'Email already in use' })
  async create(@Body() dto: CreateUserDto) {
    return JsonResponse.Ok(await this.users.create(dto));
  }

  @Patch(':id')
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Change a user\'s global role or disable/enable them (global admin)' })
  @ApiResponse({ status: 200, type: UserAdminDto })
  @ApiResponse({ status: 403, description: 'Cannot demote or disable yourself' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 409, description: 'Would leave no active global admin' })
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.users.update(principal.id, id, dto));
  }
}
```

Create `apps/api/src/users/users.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { AdminUsersController } from './admin-users.controller';
import { UsersAdminService } from './users-admin.service';
import { PrismaUsersRepository } from './prisma-users.repository';

// CacheManager and TRANSACTION_MANAGER come from the global CacheModule / PrismaModule.forRoot.
@Module({
  imports: [PrismaModule],
  controllers: [AdminUsersController],
  providers: [PrismaUsersRepository, UsersAdminService],
})
export class UsersModule {}
```

In `apps/api/src/app.module.ts`, import `UsersModule` and add it to `imports` next to `AuthModule`.

Create `apps/api/src/i18n/en/users.json`:

```json
{
  "404": "User not found",
  "409": "Email address is already in use",
  "-2": "Validation error",
  "self": { "40003": "You cannot demote or disable your own account" },
  "lastAdmin": { "409": "At least one active administrator must remain" }
}
```

Create `apps/api/src/i18n/zh/users.json`:

```json
{
  "404": "未找到用户",
  "409": "该邮箱已被使用",
  "-2": "验证错误",
  "self": { "40003": "不能降级或停用自己的账号" },
  "lastAdmin": { "409": "必须保留至少一名有效的管理员" }
}
```

- [ ] **Step 16: Run the unit tests**

Run: `cd apps/api && bunx jest src/users src/app.module.spec.ts`
Expected: PASS.

- [ ] **Step 17: Write the integration test**

Create `apps/api/test/integration/users/admin-users.integration.spec.ts`:

```ts
/**
 * Slice 4 — /admin/users on real Postgres over HTTP.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/users
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

interface UserRow { id: string; email: string; role: string; disabled: boolean }

describeIntegration('/admin/users (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaService<PrismaClient>;
  let rootToken: string;
  let rootId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const createUser = async (email: string, role: 'MEMBER' | 'ADMIN' = 'MEMBER') =>
    data<UserRow>(
      await request(server).post('/api/admin/users').set(auth(rootToken))
        .send({ email, name: email.split('@')[0], password: TEST_PASSWORD, role }).expect(201),
    );

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService);
    const res = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    rootToken = data<{ accessToken: string; user: { id: string } }>(res).accessToken;
    rootId = data<{ user: { id: string } }>(res).user.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a user without leaking the hash; a duplicate email is 409', async () => {
    const created = await createUser('alice@koda.test');
    expect(created).toEqual(expect.objectContaining({ email: 'alice@koda.test', role: 'MEMBER', disabled: false }));
    expect(created).not.toHaveProperty('passwordHash');

    await request(server).post('/api/admin/users').set(auth(rootToken))
      .send({ email: 'alice@koda.test', name: 'A2', password: TEST_PASSWORD, role: 'MEMBER' }).expect(409);
  });

  it('a MEMBER cannot use the admin routes', async () => {
    const token = await loginToken(server, 'alice@koda.test');
    await request(server).get('/api/admin/users').set(auth(token)).expect(403);
  });

  it('lists with a case-insensitive email filter and paging', async () => {
    await createUser('bob1@koda.test');
    await createUser('BOB2@koda.test');
    const res = await request(server).get('/api/admin/users').query({ email: 'bob', size: '1' }).set(auth(rootToken)).expect(200);
    const page = data<{ total: number; hasNext: boolean; records: UserRow[] }>(res);
    expect(page.total).toBe(2);
    expect(page.records).toHaveLength(1);
    expect(page.hasNext).toBe(true);
  });

  it('disabling kills a session that is already in use (cached state)', async () => {
    const carol = await createUser('carol@koda.test');
    const token = await loginToken(server, 'carol@koda.test');
    await request(server).get('/api/auth/me').set(auth(token)).expect(200);

    await request(server).patch(`/api/admin/users/${carol.id}`).set(auth(rootToken)).send({ disabled: true }).expect(200);

    await request(server).get('/api/auth/me').set(auth(token)).expect(401);
    await request(server).post('/api/auth/login').send({ email: 'carol@koda.test', password: TEST_PASSWORD }).expect(401);

    await request(server).patch(`/api/admin/users/${carol.id}`).set(auth(rootToken)).send({ disabled: false }).expect(200);
    await loginToken(server, 'carol@koda.test');
  });

  it('demoting an admin revokes their ADMIN token immediately', async () => {
    const dave = await createUser('dave@koda.test', 'ADMIN');
    const daveToken = await loginToken(server, 'dave@koda.test');
    await request(server).get('/api/admin/users').set(auth(daveToken)).expect(200);

    await request(server).patch(`/api/admin/users/${dave.id}`).set(auth(rootToken)).send({ role: 'MEMBER' }).expect(200);

    await request(server).get('/api/admin/users').set(auth(daveToken)).expect(401);
  });

  it('an admin cannot demote or disable themselves', async () => {
    await request(server).patch(`/api/admin/users/${rootId}`).set(auth(rootToken)).send({ disabled: true }).expect(403);
    await request(server).patch(`/api/admin/users/${rootId}`).set(auth(rootToken)).send({ role: 'MEMBER' }).expect(403);
  });

  it('two admins demoting each other at once leave exactly one active admin', async () => {
    const eve = await createUser('eve@koda.test', 'ADMIN');
    const eveToken = await loginToken(server, 'eve@koda.test');
    // Root and Eve are the only active admins (Dave was demoted above).
    expect(await prisma.client.user.count({ where: { role: 'ADMIN', disabled: false } })).toBe(2);

    const [a, b] = await Promise.all([
      request(server).patch(`/api/admin/users/${eve.id}`).set(auth(rootToken)).send({ role: 'MEMBER' }),
      request(server).patch(`/api/admin/users/${rootId}`).set(auth(eveToken)).send({ role: 'MEMBER' }),
    ]);

    // The loser is refused: 409 (lost the locked count) or 401 (its token was
    // revoked by the winner before its request authenticated).
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    expect([a.status, b.status].every((s) => [200, 401, 409].includes(s))).toBe(true);
    expect(await prisma.client.user.count({ where: { role: 'ADMIN', disabled: false } })).toBe(1);
  });
});
```

- [ ] **Step 18: Run it**

Run: `cd apps/api && bun run test:integration -- test/integration/users`
Expected: PASS (7 tests).

- [ ] **Step 19: Commit**

```bash
git add apps/api/src/common/exceptions apps/api/src/common/utils/prisma-errors.ts apps/api/src/common/utils/prisma-errors.spec.ts \
  apps/api/src/common/utils/ticket-number-retry.ts apps/api/src/auth/dto/register.dto.ts \
  apps/api/src/users apps/api/src/app.module.ts apps/api/src/i18n/en/users.json apps/api/src/i18n/zh/users.json \
  apps/api/test/integration/users
git commit -m "feat(users): global user administration under /admin/users"
```

---

### Task 4: Project membership (`/projects/:slug/members`)

**Files:**
- Modify: `apps/api/src/projects/project-access.service.ts`, `apps/api/src/projects/project-access.service.spec.ts`
- Create: `apps/api/src/projects/members/domain/project-member.domain.ts`
- Create: `apps/api/src/projects/members/dto/list-members.query.ts`, `add-member.dto.ts`, `update-member-role.dto.ts`, `project-member.dto.ts`, `member-dto.spec.ts`
- Create: `apps/api/src/projects/members/prisma-project-members.repository.ts`
- Create: `apps/api/src/projects/members/project-members.service.ts` (+ `.spec.ts`)
- Create: `apps/api/src/projects/members/project-members.controller.ts` (+ `.spec.ts`)
- Create: `apps/api/src/projects/members/project-members.module.ts` (+ `.spec.ts`)
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/src/i18n/en/members.json`, `apps/api/src/i18n/zh/members.json`
- Create: `apps/api/test/integration/projects/project-members.integration.spec.ts`

**Interfaces:**
- Consumes: `lockProjectMembers` (Task 1); `ConflictAppException`, `isUniqueViolation` (Task 3); `ProjectAccessService.findProjectIdBySlug`, `.assertProjectMembership` (existing).
- Produces: `ProjectAccessService.assertProjectAdmin(projectId: string, principal: KodaPrincipal): Promise<void>` (Slice 5 may reuse).
- Produces (wire): `ProjectMemberDto = { userId, email, name, role, joinedAt }`; operation ids `ProjectMembersController_list|add|updateRole|remove` (Task 6 CLI).

- [ ] **Step 1: Write the failing `assertProjectAdmin` tests**

Append inside `describe('ProjectAccessService'` in `apps/api/src/projects/project-access.service.spec.ts`:

```ts
  describe('assertProjectAdmin', () => {
    const globalAdmin = { actorType: 'user', id: 'g1', role: 'ADMIN', email: 'g@g.com' } as KodaPrincipal;
    const member = { actorType: 'user', id: 'm1', role: 'MEMBER', email: 'm@m.com' } as KodaPrincipal;
    const agent = { actorType: 'agent', id: 'a1', slug: 'bot', status: 'ACTIVE', agentRoles: [], capabilities: [] } as unknown as KodaPrincipal;

    it('passes a global ADMIN without a membership lookup', async () => {
      await expect(service.assertProjectAdmin('p1', globalAdmin)).resolves.toBeUndefined();
      expect(mockProjectRepo.findMembershipRole).not.toHaveBeenCalled();
    });

    it('passes a project ADMIN member', async () => {
      mockProjectRepo.findMembershipRole.mockResolvedValue('ADMIN');
      await expect(service.assertProjectAdmin('p1', member)).resolves.toBeUndefined();
    });

    it.each(['DEVELOPER', 'VIEWER', null])('refuses a member whose project role is %s', async (role) => {
      mockProjectRepo.findMembershipRole.mockResolvedValue(role);
      await expect(service.assertProjectAdmin('p1', member)).rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it('refuses agents', async () => {
      await expect(service.assertProjectAdmin('p1', agent)).rejects.toBeInstanceOf(ForbiddenAppException);
    });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bunx jest src/projects/project-access.service.spec.ts`
Expected: FAIL, `assertProjectAdmin is not a function`.

- [ ] **Step 3: Implement**

Add to `ProjectAccessService` in `apps/api/src/projects/project-access.service.ts`:

```ts
  /**
   * Membership management: global ADMIN, or a user whose project role is ADMIN.
   * Agents never manage membership. Reads the role live (membership is not cached).
   */
  async assertProjectAdmin(projectId: string, principal: KodaPrincipal): Promise<void> {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'members');
    if (principal.role === 'ADMIN') return;
    const role = await this.projectRepo.findMembershipRole(projectId, principal.id);
    if (role !== ActorRole.ADMIN) throw new ForbiddenAppException({}, 'members');
  }
```

Run: `cd apps/api && bunx jest src/projects/project-access.service.spec.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing DTO tests**

Create `apps/api/src/projects/members/dto/member-dto.spec.ts`:

```ts
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AddMemberDto } from './add-member.dto';
import { UpdateMemberRoleDto } from './update-member-role.dto';

const errorsOf = async (cls: new () => object, raw: object) =>
  (await validate(plainToInstance(cls, raw))).map((e) => e.property);

describe('member DTOs', () => {
  it('AddMemberDto needs an email and an assignable role', async () => {
    expect(await errorsOf(AddMemberDto, { email: 'a@k.t', role: 'DEVELOPER' })).toEqual([]);
    expect(await errorsOf(AddMemberDto, { email: 'a@k.t', role: 'AGENT' })).toContain('role');
    expect(await errorsOf(AddMemberDto, { email: 'nope', role: 'VIEWER' })).toContain('email');
  });

  it('UpdateMemberRoleDto accepts ADMIN | DEVELOPER | VIEWER only', async () => {
    for (const role of ['ADMIN', 'DEVELOPER', 'VIEWER']) {
      expect(await errorsOf(UpdateMemberRoleDto, { role })).toEqual([]);
    }
    expect(await errorsOf(UpdateMemberRoleDto, { role: 'MEMBER' })).toContain('role');
    expect(await errorsOf(UpdateMemberRoleDto, {})).toContain('role');
  });
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `cd apps/api && bunx jest src/projects/members/dto`
Expected: FAIL, modules not found.

- [ ] **Step 6: Implement domain and DTOs**

Create `apps/api/src/projects/members/domain/project-member.domain.ts`:

```ts
import { ActorRole } from '../../../common/enums';

/** Roles a user can hold through the membership API (AGENT/MEMBER are not assignable). */
export const PROJECT_MEMBER_ROLES = [ActorRole.ADMIN, ActorRole.DEVELOPER, ActorRole.VIEWER] as const;
export type ProjectMemberRole = (typeof PROJECT_MEMBER_ROLES)[number];

export interface ProjectMemberRecord {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  joinedAt: Date;
}
```

Create `apps/api/src/projects/members/dto/list-members.query.ts`:

```ts
import { KodaPageQuery } from '../../../common/dto/koda-page.query';

export class ListMembersQuery extends KodaPageQuery {}
```

Create `apps/api/src/projects/members/dto/add-member.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn } from 'class-validator';
import { PROJECT_MEMBER_ROLES, ProjectMemberRole } from '../domain/project-member.domain';

export class AddMemberDto {
  @ApiProperty({ description: 'Email of an existing user', example: 'dev@example.com' })
  @IsEmail({}, { message: '$t(common.validation.isEmail)' })
  declare email: string;

  @ApiProperty({ enum: PROJECT_MEMBER_ROLES })
  @IsIn(PROJECT_MEMBER_ROLES, { message: '$t(common.validation.isEnum)' })
  declare role: ProjectMemberRole;
}
```

Create `apps/api/src/projects/members/dto/update-member-role.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { PROJECT_MEMBER_ROLES, ProjectMemberRole } from '../domain/project-member.domain';

export class UpdateMemberRoleDto {
  @ApiProperty({ enum: PROJECT_MEMBER_ROLES })
  @IsIn(PROJECT_MEMBER_ROLES, { message: '$t(common.validation.isEnum)' })
  declare role: ProjectMemberRole;
}
```

Create `apps/api/src/projects/members/dto/project-member.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectMemberRecord } from '../domain/project-member.domain';

export class ProjectMemberDto {
  @ApiProperty() declare userId: string;
  @ApiProperty() declare email: string;
  @ApiPropertyOptional({ nullable: true, type: String }) declare name: string | null;
  @ApiProperty({ enum: ['ADMIN', 'DEVELOPER', 'AGENT', 'VIEWER'] }) declare role: string;
  @ApiProperty() declare joinedAt: Date;

  static from(r: ProjectMemberRecord): ProjectMemberDto {
    return { userId: r.userId, email: r.email, name: r.name, role: r.role, joinedAt: r.joinedAt };
  }
}
```

(`role` on the wire may still show legacy `AGENT` rows from seed data; only writes are restricted.)

Run: `cd apps/api && bunx jest src/projects/members/dto`
Expected: PASS.

- [ ] **Step 7: Implement the repository**

Create `apps/api/src/projects/members/prisma-project-members.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Paginate, PrismaService } from '@nathapp/nestjs-prisma';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { PrismaClient, ProjectMember, User } from '@prisma/client';
import { ActorRole } from '../../common/enums';
import { lockProjectMembers } from '../../common/utils/advisory-lock';
import { ProjectMemberRecord, ProjectMemberRole } from './domain/project-member.domain';

type MemberRow = ProjectMember & { user: User };

@Injectable()
export class PrismaProjectMembersRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  private toRecord(m: MemberRow): ProjectMemberRecord {
    return { userId: m.userId, email: m.user.email, name: m.user.name, role: m.role, joinedAt: m.joinedAt };
  }

  async findMemberPage(projectId: string, page: IPageOption): Promise<IPageResult<ProjectMemberRecord>> {
    const rows = await Paginate(this.db.projectMember, page, {
      where: { projectId },
      include: { user: true },
      orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.remap((m: MemberRow) => this.toRecord(m));
  }

  async findMember(projectId: string, userId: string): Promise<ProjectMemberRecord | null> {
    const m = await this.db.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      include: { user: true },
    });
    return m ? this.toRecord(m) : null;
  }

  async findUserIdByEmail(email: string): Promise<string | null> {
    const u = await this.db.user.findUnique({ where: { email }, select: { id: true } });
    return u?.id ?? null;
  }

  async createMember(projectId: string, userId: string, role: ProjectMemberRole): Promise<ProjectMemberRecord> {
    const m = await this.db.projectMember.create({ data: { projectId, userId, role }, include: { user: true } });
    return this.toRecord(m);
  }

  async updateMemberRole(projectId: string, userId: string, role: ProjectMemberRole): Promise<ProjectMemberRecord> {
    const m = await this.db.projectMember.update({
      where: { projectId_userId: { projectId, userId } },
      data: { role },
      include: { user: true },
    });
    return this.toRecord(m);
  }

  async deleteMember(projectId: string, userId: string): Promise<void> {
    await this.db.projectMember.delete({ where: { projectId_userId: { projectId, userId } } });
  }

  async countProjectAdmins(projectId: string): Promise<number> {
    return this.db.projectMember.count({ where: { projectId, role: ActorRole.ADMIN } });
  }

  /** Serializes last-project-admin checks. Call inside txManager.run only. */
  async lockMembers(projectId: string): Promise<void> {
    await lockProjectMembers(this.db, projectId);
  }
}
```

- [ ] **Step 8: Write the failing service tests**

Create `apps/api/src/projects/members/project-members.service.spec.ts`:

```ts
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { Prisma } from '@prisma/client';
import { ProjectMembersService } from './project-members.service';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';

const globalAdmin = { actorType: 'user', id: 'g1', role: 'ADMIN', email: 'g@k.t' } as KodaPrincipal;
const projectAdmin = { actorType: 'user', id: 'pa', role: 'MEMBER', email: 'pa@k.t' } as KodaPrincipal;
const member = (userId: string, role: string) => ({ userId, email: `${userId}@k.t`, name: userId, role, joinedAt: new Date(0) });

describe('ProjectMembersService', () => {
  let repo: Record<string, jest.Mock>;
  let access: Record<string, jest.Mock>;
  let service: ProjectMembersService;

  beforeEach(() => {
    repo = {
      findMemberPage: jest.fn(),
      findMember: jest.fn(),
      findUserIdByEmail: jest.fn(),
      createMember: jest.fn(async (_p: string, userId: string, role: string) => member(userId, role)),
      updateMemberRole: jest.fn(async (_p: string, userId: string, role: string) => member(userId, role)),
      deleteMember: jest.fn(),
      countProjectAdmins: jest.fn(),
      lockMembers: jest.fn(),
    };
    access = {
      findProjectIdBySlug: jest.fn().mockResolvedValue('p1'),
      assertProjectMembership: jest.fn(),
      assertProjectAdmin: jest.fn(),
    };
    const txManager = { run: <T>(fn: () => Promise<T>) => fn(), isInTransaction: () => false };
    service = new ProjectMembersService(repo as never, access as never, txManager as never);
  });

  it('list checks membership, not admin rights', async () => {
    repo.findMemberPage.mockResolvedValue({ total: 0, current: 1, size: 20, hasNext: false, hasPrev: false, records: [] });
    await service.list('proj', projectAdmin, { current: 1, size: 20 });
    expect(access.assertProjectMembership).toHaveBeenCalledWith('p1', projectAdmin);
    expect(access.assertProjectAdmin).not.toHaveBeenCalled();
  });

  it('writes are gated by assertProjectAdmin', async () => {
    access.assertProjectAdmin.mockRejectedValue(new ForbiddenAppException({}, 'members'));
    await expect(service.add('proj', { email: 'x@k.t', role: 'VIEWER' }, projectAdmin)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(service.updateRole('proj', 'u1', { role: 'VIEWER' }, projectAdmin)).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(service.remove('proj', 'u1', projectAdmin)).rejects.toBeInstanceOf(ForbiddenAppException);
    expect(repo.createMember).not.toHaveBeenCalled();
  });

  it('add: unknown email is 404, duplicate member is 409', async () => {
    repo.findUserIdByEmail.mockResolvedValueOnce(null);
    await expect(service.add('proj', { email: 'ghost@k.t', role: 'VIEWER' }, globalAdmin)).rejects.toBeInstanceOf(NotFoundAppException);

    repo.findUserIdByEmail.mockResolvedValueOnce('u1');
    repo.createMember.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002', clientVersion: 'test', meta: { target: ['projectId', 'userId'] },
    }));
    await expect(service.add('proj', { email: 'u1@k.t', role: 'VIEWER' }, globalAdmin)).rejects.toBeInstanceOf(ConflictAppException);
  });

  it('updateRole/remove 404 a non-member', async () => {
    repo.findMember.mockResolvedValue(null);
    await expect(service.updateRole('proj', 'nobody', { role: 'VIEWER' }, globalAdmin)).rejects.toBeInstanceOf(NotFoundAppException);
    await expect(service.remove('proj', 'nobody', globalAdmin)).rejects.toBeInstanceOf(NotFoundAppException);
  });

  it('a project admin cannot demote or remove the last project ADMIN', async () => {
    repo.findMember.mockResolvedValue(member('pa', 'ADMIN'));
    repo.countProjectAdmins.mockResolvedValue(1);

    await expect(service.updateRole('proj', 'pa', { role: 'DEVELOPER' }, projectAdmin)).rejects.toBeInstanceOf(ConflictAppException);
    await expect(service.remove('proj', 'pa', projectAdmin)).rejects.toBeInstanceOf(ConflictAppException);
    expect(repo.lockMembers.mock.invocationCallOrder[0]).toBeLessThan(repo.countProjectAdmins.mock.invocationCallOrder[0]);
    expect(repo.updateMemberRole).not.toHaveBeenCalled();
    expect(repo.deleteMember).not.toHaveBeenCalled();
  });

  it('a global ADMIN may remove the last project ADMIN', async () => {
    repo.findMember.mockResolvedValue(member('pa', 'ADMIN'));
    repo.countProjectAdmins.mockResolvedValue(1);

    await service.remove('proj', 'pa', globalAdmin);

    expect(repo.deleteMember).toHaveBeenCalledWith('p1', 'pa');
    expect(repo.countProjectAdmins).not.toHaveBeenCalled();
  });

  it('keeping ADMIN, or changing a non-admin, needs no count', async () => {
    repo.findMember.mockResolvedValue(member('d1', 'DEVELOPER'));
    await service.updateRole('proj', 'd1', { role: 'VIEWER' }, projectAdmin);
    expect(repo.countProjectAdmins).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 9: Run to verify it fails**

Run: `cd apps/api && bunx jest src/projects/members/project-members.service.spec.ts`
Expected: FAIL, module not found.

- [ ] **Step 10: Implement the service**

Create `apps/api/src/projects/members/project-members.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import { IPageResult, ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { KodaPrincipal, isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { ActorRole } from '../../common/enums';
import { remapPage } from '../../common/dto/koda-page.query';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { isUniqueViolation } from '../../common/utils/prisma-errors';
import { ProjectAccessService } from '../project-access.service';
import { PrismaProjectMembersRepository } from './prisma-project-members.repository';
import { ProjectMemberRecord, ProjectMemberRole } from './domain/project-member.domain';
import { AddMemberDto } from './dto/add-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { ProjectMemberDto } from './dto/project-member.dto';

const isGlobalAdmin = (principal: KodaPrincipal): boolean =>
  isUserPrincipal(principal) && principal.role === 'ADMIN';

@Injectable()
export class ProjectMembersService {
  constructor(
    private readonly membersRepo: PrismaProjectMembersRepository,
    private readonly access: ProjectAccessService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  async list(slug: string, principal: KodaPrincipal, page: IPageOption): Promise<IPageResult<ProjectMemberDto>> {
    const projectId = await this.access.findProjectIdBySlug(slug);
    await this.access.assertProjectMembership(projectId, principal);
    return remapPage(await this.membersRepo.findMemberPage(projectId, page), ProjectMemberDto.from);
  }

  async add(slug: string, dto: AddMemberDto, principal: KodaPrincipal): Promise<ProjectMemberDto> {
    const projectId = await this.access.findProjectIdBySlug(slug);
    await this.access.assertProjectAdmin(projectId, principal);
    const userId = await this.membersRepo.findUserIdByEmail(dto.email);
    if (!userId) throw new NotFoundAppException({}, 'members.user');
    try {
      return ProjectMemberDto.from(await this.membersRepo.createMember(projectId, userId, dto.role));
    } catch (error) {
      if (isUniqueViolation(error, 'userId')) throw new ConflictAppException({}, 'members');
      throw error;
    }
  }

  async updateRole(slug: string, userId: string, dto: UpdateMemberRoleDto, principal: KodaPrincipal): Promise<ProjectMemberDto> {
    const projectId = await this.access.findProjectIdBySlug(slug);
    await this.access.assertProjectAdmin(projectId, principal);
    const updated = await this.txManager.run(async () => {
      const current = await this.lockAndFind(projectId, userId);
      await this.assertKeepsAnAdmin(projectId, current, dto.role, principal);
      return this.membersRepo.updateMemberRole(projectId, userId, dto.role);
    });
    return ProjectMemberDto.from(updated);
  }

  async remove(slug: string, userId: string, principal: KodaPrincipal): Promise<void> {
    const projectId = await this.access.findProjectIdBySlug(slug);
    await this.access.assertProjectAdmin(projectId, principal);
    await this.txManager.run(async () => {
      const current = await this.lockAndFind(projectId, userId);
      await this.assertKeepsAnAdmin(projectId, current, null, principal);
      await this.membersRepo.deleteMember(projectId, userId);
    });
  }

  private async lockAndFind(projectId: string, userId: string): Promise<ProjectMemberRecord> {
    await this.membersRepo.lockMembers(projectId);
    const current = await this.membersRepo.findMember(projectId, userId);
    if (!current) throw new NotFoundAppException({}, 'members');
    return current;
  }

  /** A change that drops the last project ADMIN is refused unless a global ADMIN makes it. */
  private async assertKeepsAnAdmin(
    projectId: string,
    current: ProjectMemberRecord,
    nextRole: ProjectMemberRole | null,
    principal: KodaPrincipal,
  ): Promise<void> {
    const losesAdmin = current.role === ActorRole.ADMIN && nextRole !== ActorRole.ADMIN;
    if (!losesAdmin || isGlobalAdmin(principal)) return;
    if ((await this.membersRepo.countProjectAdmins(projectId)) <= 1) {
      throw new ConflictAppException({}, 'members.lastAdmin');
    }
  }
}
```

(Membership is read live by `assertProjectMembership` on every call, so writes need no cache invalidation.)

- [ ] **Step 11: Run to verify it passes**

Run: `cd apps/api && bunx jest src/projects/members/project-members.service.spec.ts`
Expected: PASS.

- [ ] **Step 12: Write the failing controller and module tests**

Create `apps/api/src/projects/members/project-members.controller.spec.ts`:

```ts
import { ProjectMembersController } from './project-members.controller';

describe('ProjectMembersController', () => {
  const service = { list: jest.fn(), add: jest.fn(), updateRole: jest.fn(), remove: jest.fn() };
  const controller = new ProjectMembersController(service as never);
  const principal = { actorType: 'user', id: 'u1' } as never;

  afterEach(() => jest.clearAllMocks());

  it('list parses paging strings and returns the six-field page', async () => {
    const page = { total: 0, current: 2, size: 5, hasNext: false, hasPrev: true, records: [] };
    service.list.mockResolvedValue(page);
    const res = await controller.list('proj', { current: '2', size: '5' } as never, principal);
    expect(service.list).toHaveBeenCalledWith('proj', principal, { current: 2, size: 5 });
    expect(res).toEqual(expect.objectContaining({ ret: 0, data: page }));
  });

  it('list ignores undeclared query keys', async () => {
    service.list.mockResolvedValue({ total: 0, current: 1, size: 20, hasNext: false, hasPrev: false, records: [] });
    await controller.list('proj', { projectId: 'other' } as never, principal);
    expect(service.list).toHaveBeenCalledWith('proj', principal, { current: 1, size: 20 });
  });

  it('remove returns an empty Ok', async () => {
    const res = await controller.remove('proj', 'u2', principal);
    expect(service.remove).toHaveBeenCalledWith('proj', 'u2', principal);
    expect(res).toEqual(expect.objectContaining({ ret: 0 }));
  });
});
```

Create `apps/api/src/projects/members/project-members.module.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { ProjectMembersController } from './project-members.controller';
import { ProjectMembersService } from './project-members.service';

describe('ProjectMembersModule — DI wiring', () => {
  it('ProjectMembersController resolves with its service', async () => {
    const module = await Test.createTestingModule({
      controllers: [ProjectMembersController],
      providers: [{ provide: ProjectMembersService, useValue: {} }],
    }).compile();
    expect(module.get(ProjectMembersController)).toBeDefined();
    await module.close();
  });
});
```

- [ ] **Step 13: Run to verify they fail**

Run: `cd apps/api && bunx jest src/projects/members`
Expected: FAIL, controller not found.

- [ ] **Step 14: Implement controller and module, register it, i18n**

Create `apps/api/src/projects/members/project-members.controller.ts`:

```ts
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import { ProjectMembersService } from './project-members.service';
import { ListMembersQuery } from './dto/list-members.query';
import { AddMemberDto } from './dto/add-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { ProjectMemberDto } from './dto/project-member.dto';

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects/:slug/members')
export class ProjectMembersController {
  constructor(private readonly members: ProjectMembersService) {}

  @Get()
  @ApiOperation({ summary: 'List project members (any member)' })
  @ApiResponse({ status: 200, description: 'Page of members: { total, current, size, hasNext, hasPrev, records }' })
  @ApiResponse({ status: 403, description: 'Not a project member' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async list(@Param('slug') slug: string, @Query() rawQuery: ListMembersQuery, @Principal() principal: KodaPrincipal) {
    const { current, size } = parseQuery(ListMembersQuery, rawQuery);
    const page = await this.members.list(slug, principal, { current, size });
    return JsonResponse.Ok(toPageResult(page));
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Add an existing user by email (project admin)' })
  @ApiResponse({ status: 201, type: ProjectMemberDto })
  @ApiResponse({ status: 403, description: 'Project admin role required' })
  @ApiResponse({ status: 404, description: 'Project or user not found' })
  @ApiResponse({ status: 409, description: 'Already a member' })
  async add(@Param('slug') slug: string, @Body() dto: AddMemberDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.members.add(slug, dto, principal));
  }

  @Patch(':userId')
  @ApiOperation({ summary: 'Change a member\'s project role (project admin)' })
  @ApiResponse({ status: 200, type: ProjectMemberDto })
  @ApiResponse({ status: 404, description: 'Not a member' })
  @ApiResponse({ status: 409, description: 'Would leave the project without an ADMIN' })
  async updateRole(
    @Param('slug') slug: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateMemberRoleDto,
    @Principal() principal: KodaPrincipal,
  ) {
    return JsonResponse.Ok(await this.members.updateRole(slug, userId, dto, principal));
  }

  @Delete(':userId')
  @ApiOperation({ summary: 'Remove a member (project admin)' })
  @ApiResponse({ status: 200, description: 'Removed' })
  @ApiResponse({ status: 404, description: 'Not a member' })
  @ApiResponse({ status: 409, description: 'Would leave the project without an ADMIN' })
  async remove(@Param('slug') slug: string, @Param('userId') userId: string, @Principal() principal: KodaPrincipal) {
    await this.members.remove(slug, userId, principal);
    return JsonResponse.Ok({});
  }
}
```

Create `apps/api/src/projects/members/project-members.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../project-access.module';
import { ProjectMembersController } from './project-members.controller';
import { ProjectMembersService } from './project-members.service';
import { PrismaProjectMembersRepository } from './prisma-project-members.repository';

@Module({
  imports: [PrismaModule, ProjectAccessModule],
  controllers: [ProjectMembersController],
  providers: [PrismaProjectMembersRepository, ProjectMembersService],
})
export class ProjectMembersModule {}
```

In `apps/api/src/app.module.ts`, import `ProjectMembersModule` and add it to `imports` after `ProjectsModule`.

Create `apps/api/src/i18n/en/members.json`:

```json
{
  "404": "Member not found",
  "409": "User is already a member of this project",
  "40003": "Project admin role required",
  "-2": "Validation error",
  "user": { "404": "No user with that email address" },
  "lastAdmin": { "409": "A project must keep at least one admin" }
}
```

Create `apps/api/src/i18n/zh/members.json`:

```json
{
  "404": "未找到成员",
  "409": "该用户已是项目成员",
  "40003": "需要项目管理员权限",
  "-2": "验证错误",
  "user": { "404": "没有使用该邮箱的用户" },
  "lastAdmin": { "409": "项目必须保留至少一名管理员" }
}
```

Run: `cd apps/api && bunx jest src/projects src/app.module.spec.ts`
Expected: PASS.

- [ ] **Step 15: Write the integration test**

Create `apps/api/test/integration/projects/project-members.integration.spec.ts`:

```ts
/**
 * Slice 4 — /projects/:slug/members on real Postgres over HTTP.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/projects/project-members
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

interface Member { userId: string; email: string; role: string }
interface Page<T> { total: number; records: T[] }

describeIntegration('/projects/:slug/members (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const base = '/api/projects/team/members';
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;

    await request(server).post('/api/projects').set(auth('root'))
      .send({ name: 'Team', slug: 'team', key: 'TEAM' }).expect(201);

    for (const who of ['pa', 'dev', 'viewer', 'outsider']) {
      const res = await request(server).post('/api/admin/users').set(auth('root'))
        .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
      ids[who] = data<{ id: string }>(res).id;
      tokens[who] = await loginToken(server, `${who}@koda.test`);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('a global admin adds a project admin and a developer', async () => {
    const pa = data<Member>(await request(server).post(base).set(auth('root')).send({ email: 'pa@koda.test', role: 'ADMIN' }).expect(201));
    expect(pa).toEqual(expect.objectContaining({ userId: ids.pa, role: 'ADMIN' }));
    await request(server).post(base).set(auth('root')).send({ email: 'dev@koda.test', role: 'DEVELOPER' }).expect(201);
  });

  it('unknown email is 404; an existing member is 409', async () => {
    await request(server).post(base).set(auth('root')).send({ email: 'ghost@koda.test', role: 'VIEWER' }).expect(404);
    await request(server).post(base).set(auth('root')).send({ email: 'dev@koda.test', role: 'VIEWER' }).expect(409);
  });

  it('a DEVELOPER can list but cannot add members', async () => {
    const page = data<Page<Member>>(await request(server).get(base).set(auth('dev')).expect(200));
    expect(page.total).toBe(2);
    await request(server).post(base).set(auth('dev')).send({ email: 'viewer@koda.test', role: 'VIEWER' }).expect(403);
  });

  it('a non-member cannot list members', async () => {
    await request(server).get(base).set(auth('outsider')).expect(403);
  });

  it('a project admin adds a viewer and changes their role', async () => {
    await request(server).post(base).set(auth('pa')).send({ email: 'viewer@koda.test', role: 'VIEWER' }).expect(201);
    const updated = data<Member>(await request(server).patch(`${base}/${ids.viewer}`).set(auth('pa')).send({ role: 'DEVELOPER' }).expect(200));
    expect(updated.role).toBe('DEVELOPER');
  });

  it('the last project ADMIN cannot demote or remove themselves; a global admin can', async () => {
    await request(server).patch(`${base}/${ids.pa}`).set(auth('pa')).send({ role: 'DEVELOPER' }).expect(409);
    await request(server).delete(`${base}/${ids.pa}`).set(auth('pa')).expect(409);

    await request(server).patch(`${base}/${ids.pa}`).set(auth('root')).send({ role: 'DEVELOPER' }).expect(200);
  });

  it('removal takes effect on the next request (membership is not cached)', async () => {
    await request(server).get(base).set(auth('viewer')).expect(200);
    await request(server).delete(`${base}/${ids.viewer}`).set(auth('root')).expect(200);
    await request(server).get(base).set(auth('viewer')).expect(403);
    await request(server).delete(`${base}/${ids.viewer}`).set(auth('root')).expect(404);
  });

  it('rejects an unassignable role with 400', async () => {
    await request(server).post(base).set(auth('root')).send({ email: 'outsider@koda.test', role: 'AGENT' }).expect(400);
  });
});
```

- [ ] **Step 16: Run it**

Run: `cd apps/api && bun run test:integration -- test/integration/projects/project-members`
Expected: PASS (8 tests).

- [ ] **Step 17: Commit**

```bash
git add apps/api/src/projects apps/api/src/app.module.ts apps/api/src/i18n/en/members.json apps/api/src/i18n/zh/members.json \
  apps/api/test/integration/projects/project-members.integration.spec.ts
git commit -m "feat(projects): project membership management with last-admin guard"
```

---

### Task 5: `assignedTo=self` resolves to the caller

`koda ticket mine` sends `assignedTo=self`, which the API has matched literally against `assignedToUserId` since it was written, so the command always returns nothing (deferred to this slice by PR #137). `self` means the caller: a user id for a user principal, the agent id (`assignedToAgentId`) for an agent principal (the CLI authenticates as an agent).

**Files:**
- Modify: `apps/api/src/tickets/domain/ticket.domain.ts:60-67`
- Modify: `apps/api/src/tickets/prisma-tickets.repository.ts:145-157`
- Modify: `apps/api/src/tickets/tickets.service.ts:22,132-150`
- Modify: `apps/api/src/tickets/tickets.controller.ts` (`findAll`), `apps/api/src/tickets/tickets.controller.spec.ts`
- Modify: `apps/api/test/integration/tickets/ticket-pagination.integration.spec.ts`

**Interfaces:**
- Produces: `TicketListFilters.assignedToAgentId?: string`; `TicketListFilterInput = Omit<ListTicketsQuery, 'current' | 'size'> & { assignedToAgentId?: string }`; `resolveSelfAssignee(filters: TicketListFilterInput, principal: KodaPrincipal | undefined): TicketListFilterInput` exported from `tickets.controller.ts`.

- [ ] **Step 1: Write the failing controller tests**

In `apps/api/src/tickets/tickets.controller.spec.ts`, inside the ticket-list `describe` (the one containing "defaults to page 1 of 20"), add:

```ts
    it('assignedTo=self resolves to the calling user', async () => {
      mockTicketsService.findAll.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));
      const user = { actorType: 'user', id: 'user-7', role: 'MEMBER', email: 'u@k.t' } as never;

      await controller.findAll('koda', { assignedTo: 'self' } as never, user);

      const filters = mockTicketsService.findAll.mock.calls[0][1];
      expect(filters.assignedTo).toBe('user-7');
      expect(filters.assignedToAgentId).toBeUndefined();
    });

    it('assignedTo=self resolves to the calling agent', async () => {
      mockTicketsService.findAll.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));
      const agent = { actorType: 'agent', id: 'agent-3', slug: 'bot', status: 'ACTIVE', agentRoles: [], capabilities: [] } as never;

      await controller.findAll('koda', { assignedTo: 'self' } as never, agent);

      const filters = mockTicketsService.findAll.mock.calls[0][1];
      expect(filters.assignedTo).toBeUndefined();
      expect(filters.assignedToAgentId).toBe('agent-3');
    });

    it('any other assignedTo value passes through unchanged', async () => {
      mockTicketsService.findAll.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));
      await controller.findAll('koda', { assignedTo: 'user-9' } as never, { actorType: 'user', id: 'user-7' } as never);
      expect(mockTicketsService.findAll.mock.calls[0][1].assignedTo).toBe('user-9');
    });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && bunx jest src/tickets/tickets.controller.spec.ts`
Expected: FAIL (`assignedTo` is the literal `'self'`).

- [ ] **Step 3: Implement**

`apps/api/src/tickets/domain/ticket.domain.ts`, `TicketListFilters`: add `assignedToAgentId?: string;` after `assignedToUserId`.

`apps/api/src/tickets/prisma-tickets.repository.ts`, `findTicketPage`: replace the assignee spread with

```ts
      ...(filters.unassigned
        ? { assignedToUserId: null, assignedToAgentId: null }
        : {
            ...(filters.assignedToUserId && { assignedToUserId: filters.assignedToUserId }),
            ...(filters.assignedToAgentId && { assignedToAgentId: filters.assignedToAgentId }),
          }),
```

`apps/api/src/tickets/tickets.service.ts`: change the type to

```ts
export type TicketListFilterInput = Omit<ListTicketsQuery, 'current' | 'size'> & { assignedToAgentId?: string };
```

and add `assignedToAgentId: filters.assignedToAgentId,` next to `assignedToUserId: filters.assignedTo,` in `findAll`.

`apps/api/src/tickets/tickets.controller.ts`: import `isAgentPrincipal` from `../auth/principal/koda-principal.types` and `TicketListFilterInput` from `./tickets.service`. Add above the class:

```ts
/** `assignedTo=self` means the caller: its user id, or its agent id for an agent. */
export function resolveSelfAssignee(
  filters: TicketListFilterInput,
  principal: KodaPrincipal | undefined,
): TicketListFilterInput {
  if (filters.assignedTo !== 'self' || !principal) return filters;
  const { assignedTo: _self, ...rest } = filters;
  return isAgentPrincipal(principal)
    ? { ...rest, assignedToAgentId: principal.id }
    : { ...rest, assignedTo: principal.id };
}
```

and change `findAll`:

```ts
  async findAll(
    @Param('slug') slug: string,
    @Query() rawQuery: ListTicketsQuery,
    @Principal() principal: KodaPrincipal,
  ) {
    const { current, size, ...filters } = parseQuery(ListTicketsQuery, rawQuery);
    const page = await this.ticketsService.findAll(slug, resolveSelfAssignee(filters, principal), { current, size });
    return JsonResponse.Ok(toPageResult(page));
  }
```

Also document it on the query DTO: in `apps/api/src/tickets/dto/list-tickets.query.ts`, set the `assignedTo` `@ApiPropertyOptional` description to `'User id of the assignee, or "self" for the caller (user or agent)'`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && bunx jest src/tickets`
Expected: PASS (the existing two-argument `findAll` calls still pass: `principal` is `undefined`).

- [ ] **Step 5: Extend the integration test**

Append as the **last** `it` in `apps/api/test/integration/tickets/ticket-pagination.integration.spec.ts` (it adds a ticket, so earlier totals stay valid):

```ts
  it('filters by agent assignee', async () => {
    const agent = await prisma.client.agent.create({ data: { name: 'Bot', slug: 'paging-bot', apiKeyHash: 'paging-bot-hash' } });
    await prisma.client.ticket.create({
      data: { projectId, number: 9, type: 'TASK', title: 't9', status: 'CREATED', priority: 'LOW', assignedToAgentId: agent.id },
    });

    const page = await repo.findTicketPage({ projectId, assignedToAgentId: agent.id }, { current: 1, size: 20 });

    expect(page.records.map((t) => t.number)).toEqual([9]);
  });
```

Run: `cd apps/api && bun run test:integration -- test/integration/tickets/ticket-pagination`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/tickets apps/api/test/integration/tickets/ticket-pagination.integration.spec.ts
git commit -m "fix(tickets): assignedTo=self resolves to the calling user or agent"
```

---

### Task 6: OpenAPI regeneration and CLI `user` / `member`

**Files:**
- Regenerate: `openapi.json`, `apps/cli/src/generated/**`
- Create: `apps/cli/src/commands/user.ts`, `apps/cli/src/commands/user.spec.ts`
- Create: `apps/cli/src/commands/member.ts`, `apps/cli/src/commands/member.spec.ts`
- Modify: `apps/cli/src/index.ts`

**Interfaces:**
- Consumes (generated, from Tasks 1, 3, 4): `authControllerRegistrationStatus`, `adminUsersControllerList`, `adminUsersControllerCreate`, `adminUsersControllerUpdate`, `projectMembersControllerList`, `projectMembersControllerAdd`, `projectMembersControllerUpdateRole`, `projectMembersControllerRemove`.
- Produces: `userCommand(program: Command): void`, `memberCommand(program: Command): void`.

- [ ] **Step 1: Regenerate and confirm the operation names**

Run:
```bash
bun run generate
grep -o "export const \(adminUsersController\|projectMembersController\|authControllerRegistrationStatus\)[A-Za-z]*" -r apps/cli/src/generated | sort -u
```
Expected: the eight names listed under **Interfaces** above. If the generator produced different names, use the generated ones in Steps 2-5 (the tests mock `../generated`, so both files must agree).

Run: `cd apps/api && bun run test:integration -- test/integration/openapi-spec`
Expected: PASS (the committed spec matches the running app).

- [ ] **Step 2: Write the failing `user` command tests**

Create `apps/cli/src/commands/user.spec.ts`:

```ts
jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  adminUsersControllerList: jest.fn(),
  adminUsersControllerCreate: jest.fn(),
  adminUsersControllerUpdate: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { userCommand } from './user';
import { adminUsersControllerCreate, adminUsersControllerList, adminUsersControllerUpdate } from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'http://localhost:3100/api', projectSlug: 'p' };
const page = { total: 1, current: 1, size: 20, hasNext: false, hasPrev: false, records: [{ id: 'u1', email: 'a@k.t', name: 'A', role: 'MEMBER', disabled: false }] };

describe('userCommand', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    userCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.clearAllMocks());

  it('list sends paging and the email filter', async () => {
    (adminUsersControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: page });
    await program.parseAsync(['node', 'koda', 'user', 'list', '--email', 'a@', '--page', '2', '--size', '5']);
    expect(adminUsersControllerList).toHaveBeenCalledWith({ query: { email: 'a@', current: 2, size: 5 } });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('list --json prints the page', async () => {
    (adminUsersControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: page });
    await program.parseAsync(['node', 'koda', 'user', 'list', '--json']);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(page, null, 2));
  });

  it('create sends the body with role MEMBER by default', async () => {
    (adminUsersControllerCreate as jest.Mock).mockResolvedValue({ ret: 0, data: { id: 'u2', email: 'b@k.t' } });
    await program.parseAsync(['node', 'koda', 'user', 'create', '--email', 'b@k.t', '--name', 'B', '--password', 'Admin1234!Aa']);
    expect(adminUsersControllerCreate).toHaveBeenCalledWith({ body: { email: 'b@k.t', name: 'B', password: 'Admin1234!Aa', role: 'MEMBER' } });
  });

  it('disable patches disabled=true', async () => {
    (adminUsersControllerUpdate as jest.Mock).mockResolvedValue({ ret: 0, data: { id: 'u2', disabled: true } });
    await program.parseAsync(['node', 'koda', 'user', 'disable', 'u2']);
    expect(adminUsersControllerUpdate).toHaveBeenCalledWith({ path: { id: 'u2' }, body: { disabled: true } });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/cli && bunx jest src/commands/user.spec.ts`
Expected: FAIL, `Cannot find module './user'`.

- [ ] **Step 4: Implement `user`**

Create `apps/cli/src/commands/user.ts`:

```ts
import { Command } from 'commander';
import { adminUsersControllerCreate, adminUsersControllerList, adminUsersControllerUpdate } from '../generated';
import { table } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';
import { withContext } from '../utils/context';

interface UserRow {
  id: string;
  email: string;
  name?: string | null;
  role: string;
  disabled: boolean;
}

interface UserPage {
  total: number;
  current: number;
  hasNext: boolean;
  records: UserRow[];
}

// Agent API keys never hold the global ADMIN authority; these routes need a
// global-admin user's access token (15 min) passed through KODA_API_KEY.
const TOKEN_HINT = 'Requires a global-admin user access token: KODA_API_KEY=<token> koda user …';

export function userCommand(program: Command): void {
  const user = program.command('user');
  user.description(`Global user administration. ${TOKEN_HINT}`);

  user
    .command('list')
    .description('List users')
    .option('--email <text>', 'Filter by email substring (case-insensitive)')
    .option('--page <n>', 'Page number', '1')
    .option('--size <n>', 'Page size (1-100)', '20')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        await withContext({}, { requireProject: false });
        const response = await adminUsersControllerList({
          query: { email: options.email, current: parseInt(options.page, 10), size: parseInt(options.size, 10) },
        });
        const page = unwrap<UserPage>(response);
        if (options.json) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          const rows = page.records.map((u) => [u.id, u.email, u.name ?? '', u.role, u.disabled ? 'yes' : 'no']);
          table(['ID', 'Email', 'Name', 'Role', 'Disabled'], rows);
          if (page.hasNext) console.log(`Next: --page ${page.current + 1}`);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  user
    .command('create')
    .description('Create a user with a temporary password')
    .requiredOption('--email <email>', 'Email address')
    .requiredOption('--name <name>', 'Display name')
    .requiredOption('--password <password>', 'Temporary password (min 8 chars, mixed case, digit, symbol)')
    .option('--role <role>', 'Global role: MEMBER or ADMIN', 'MEMBER')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        await withContext({}, { requireProject: false });
        const response = await adminUsersControllerCreate({
          body: { email: options.email, name: options.name, password: options.password, role: options.role },
        });
        const created = unwrap<UserRow>(response);
        if (options.json) console.log(JSON.stringify(created, null, 2));
        else console.log(`User created: ${created.email} (${created.id})`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  user
    .command('disable <userId>')
    .description('Disable a user and revoke all of their sessions')
    .option('--json', 'Output as JSON')
    .action(async (userId: string, options) => {
      try {
        await withContext({}, { requireProject: false });
        const response = await adminUsersControllerUpdate({ path: { id: userId }, body: { disabled: true } });
        const updated = unwrap<UserRow>(response);
        if (options.json) console.log(JSON.stringify(updated, null, 2));
        else console.log(`User disabled: ${userId}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `User not found: ${userId}` });
      }
    });
}
```

If `tsc` rejects `role: options.role` against the generated union type, cast it: `role: options.role as 'MEMBER' | 'ADMIN'`.

Run: `cd apps/cli && bunx jest src/commands/user.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing `member` tests, then implement**

Create `apps/cli/src/commands/member.spec.ts`:

```ts
jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  projectMembersControllerList: jest.fn(),
  projectMembersControllerAdd: jest.fn(),
  projectMembersControllerUpdateRole: jest.fn(),
  projectMembersControllerRemove: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { memberCommand } from './member';
import {
  projectMembersControllerAdd,
  projectMembersControllerList,
  projectMembersControllerRemove,
  projectMembersControllerUpdateRole,
} from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'k', apiUrl: 'http://localhost:3100/api', projectSlug: 'my-proj' };

describe('memberCommand', () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    memberCommand(program);
    // withContext passes the flags straight to resolveContext; honor --project.
    (resolveContext as jest.Mock).mockImplementation(async (flags: { projectSlug?: string }) => ({
      ...CTX,
      projectSlug: flags.projectSlug ?? CTX.projectSlug,
    }));
    jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.clearAllMocks());

  it('list pages members of the context project', async () => {
    (projectMembersControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: { total: 0, current: 1, size: 20, hasNext: false, hasPrev: false, records: [] } });
    await program.parseAsync(['node', 'koda', 'member', 'list', '--page', '2']);
    expect(projectMembersControllerList).toHaveBeenCalledWith({ path: { slug: 'my-proj' }, query: { current: 2, size: 20 } });
  });

  it('add sends email and role', async () => {
    (projectMembersControllerAdd as jest.Mock).mockResolvedValue({ ret: 0, data: { userId: 'u1', email: 'a@k.t', role: 'DEVELOPER' } });
    await program.parseAsync(['node', 'koda', 'member', 'add', '--email', 'a@k.t', '--role', 'DEVELOPER']);
    expect(projectMembersControllerAdd).toHaveBeenCalledWith({ path: { slug: 'my-proj' }, body: { email: 'a@k.t', role: 'DEVELOPER' } });
  });

  it('role changes a member role', async () => {
    (projectMembersControllerUpdateRole as jest.Mock).mockResolvedValue({ ret: 0, data: { userId: 'u1', email: 'a@k.t', role: 'VIEWER' } });
    await program.parseAsync(['node', 'koda', 'member', 'role', 'u1', '--role', 'VIEWER']);
    expect(projectMembersControllerUpdateRole).toHaveBeenCalledWith({ path: { slug: 'my-proj', userId: 'u1' }, body: { role: 'VIEWER' } });
  });

  it('remove targets the --project override', async () => {
    (projectMembersControllerRemove as jest.Mock).mockResolvedValue({ ret: 0, data: {} });
    await program.parseAsync(['node', 'koda', 'member', 'remove', 'u1', '--project', 'other']);
    expect(projectMembersControllerRemove).toHaveBeenCalledWith({ path: { slug: 'other', userId: 'u1' } });
  });
});
```

Run: `cd apps/cli && bunx jest src/commands/member.spec.ts`
Expected: FAIL, `Cannot find module './member'`.

Create `apps/cli/src/commands/member.ts`:

```ts
import { Command } from 'commander';
import {
  projectMembersControllerAdd,
  projectMembersControllerList,
  projectMembersControllerRemove,
  projectMembersControllerUpdateRole,
} from '../generated';
import { table } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';
import { withContext } from '../utils/context';

interface MemberRow {
  userId: string;
  email: string;
  name?: string | null;
  role: string;
  joinedAt?: string;
}

interface MemberPage {
  total: number;
  current: number;
  hasNext: boolean;
  records: MemberRow[];
}

type AssignableRole = 'ADMIN' | 'DEVELOPER' | 'VIEWER';

// Listing works with an agent key. Add/role/remove need a project-admin or
// global-admin user access token passed through KODA_API_KEY.
export function memberCommand(program: Command): void {
  const member = program.command('member');
  member.description('Project membership. Writes need a project-admin user access token (KODA_API_KEY=<token>).');

  member
    .command('list')
    .description('List project members')
    .option('--project <slug>', 'Project slug')
    .option('--page <n>', 'Page number', '1')
    .option('--size <n>', 'Page size (1-100)', '20')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const response = await projectMembersControllerList({
          path: { slug: ctx.projectSlug },
          query: { current: parseInt(options.page, 10), size: parseInt(options.size, 10) },
        });
        const page = unwrap<MemberPage>(response);
        if (options.json) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          table(['User ID', 'Email', 'Name', 'Role'], page.records.map((m) => [m.userId, m.email, m.name ?? '', m.role]));
          if (page.hasNext) console.log(`Next: --page ${page.current + 1}`);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  member
    .command('add')
    .description('Add an existing user to the project by email')
    .requiredOption('--email <email>', 'Email of an existing user')
    .requiredOption('--role <role>', 'ADMIN, DEVELOPER or VIEWER')
    .option('--project <slug>', 'Project slug')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const response = await projectMembersControllerAdd({
          path: { slug: ctx.projectSlug },
          body: { email: options.email, role: options.role as AssignableRole },
        });
        const added = unwrap<MemberRow>(response);
        if (options.json) console.log(JSON.stringify(added, null, 2));
        else console.log(`Added ${added.email} as ${added.role}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `No user with email ${options.email} (or project not found)` });
      }
    });

  member
    .command('role <userId>')
    .description('Change a member\'s project role')
    .requiredOption('--role <role>', 'ADMIN, DEVELOPER or VIEWER')
    .option('--project <slug>', 'Project slug')
    .option('--json', 'Output as JSON')
    .action(async (userId: string, options) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const response = await projectMembersControllerUpdateRole({
          path: { slug: ctx.projectSlug, userId },
          body: { role: options.role as AssignableRole },
        });
        const updated = unwrap<MemberRow>(response);
        if (options.json) console.log(JSON.stringify(updated, null, 2));
        else console.log(`${updated.email} is now ${updated.role}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Not a member: ${userId}` });
      }
    });

  member
    .command('remove <userId>')
    .description('Remove a member from the project')
    .option('--project <slug>', 'Project slug')
    .option('--json', 'Output as JSON')
    .action(async (userId: string, options) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        await projectMembersControllerRemove({ path: { slug: ctx.projectSlug, userId } });
        if (options.json) console.log(JSON.stringify({ removed: userId }, null, 2));
        else console.log(`Removed ${userId}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Not a member: ${userId}` });
      }
    });
}
```

In `apps/cli/src/index.ts`, import both commands next to `adminCommand` and register them after `adminCommand(program);`:

```ts
// User administration command
userCommand(program);

// Project membership command
memberCommand(program);
```

- [ ] **Step 6: Run the CLI suite and type-check**

Run: `cd apps/cli && bunx jest && cd ../.. && bun run type-check`
Expected: PASS, including any test that snapshots the top-level command list (update it if it enumerates commands).

- [ ] **Step 7: Commit**

```bash
git add openapi.json apps/cli/src/generated apps/cli/src/commands/user.ts apps/cli/src/commands/user.spec.ts \
  apps/cli/src/commands/member.ts apps/cli/src/commands/member.spec.ts apps/cli/src/index.ts
git commit -m "feat(cli): koda user and koda member commands; regenerate client"
```

---

### Task 7: Web — registration visibility and the admin users page

**Files:**
- Create: `apps/web/composables/useRegistrationStatus.ts`, `apps/web/tests/composables/useRegistrationStatus.spec.ts`
- Modify: `apps/web/pages/login.vue`, `apps/web/pages/register.vue`, `apps/web/tests/pages/register.spec.ts`, `apps/web/tests/pages/login.spec.ts`
- Create: `apps/web/composables/useAdminUsers.ts`, `apps/web/tests/composables/useAdminUsers.spec.ts`
- Create: `apps/web/pages/admin/users.vue`, `apps/web/components/CreateUserDialog.vue`, `apps/web/tests/pages/admin-users.spec.ts`
- Modify: `apps/web/layouts/default.vue`
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`

**Interfaces:**
- Consumes (API wire): `GET /auth/registration-status → { open }`; `GET /admin/users?email&current → { records: AdminUser[], total, current, size, hasNext, hasPrev }`; `POST /admin/users`; `PATCH /admin/users/:id { role? , disabled? } → AdminUser`.
- Produces: `useRegistrationStatus(): { open: Ref<boolean>; loaded: Ref<boolean>; load(): Promise<void> }`; `useAdminUsers()` as below; `buildUserQuery(filters: { email?: string; page?: number }): Record<string, string>`.

- [ ] **Step 1: Write the failing composable tests**

Create `apps/web/tests/composables/useRegistrationStatus.spec.ts`:

```ts
import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useRegistrationStatus.ts')

function withApi(get: jest.Mock) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: { get } })
}

describe('useRegistrationStatus', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('reads { open } from /auth/registration-status', async () => {
    const get = jest.fn(async () => ({ open: true }))
    withApi(get)
    const { useRegistrationStatus } = await import(composablePath)
    const status = useRegistrationStatus()

    await status.load()

    expect(get).toHaveBeenCalledWith('/auth/registration-status')
    expect(status.open.value).toBe(true)
    expect(status.loaded.value).toBe(true)
  })

  test('a failed probe reads as closed', async () => {
    withApi(jest.fn(async () => { throw new Error('down') }))
    const { useRegistrationStatus } = await import(composablePath)
    const status = useRegistrationStatus()

    await status.load()

    expect(status.open.value).toBe(false)
    expect(status.loaded.value).toBe(true)
  })
})
```

Create `apps/web/tests/composables/useAdminUsers.spec.ts`:

```ts
import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useAdminUsers.ts')
const u = (id: string, over: Record<string, unknown> = {}) => ({ id, email: `${id}@k.t`, name: id, role: 'MEMBER', disabled: false, createdAt: '2026-09-26T00:00:00Z', ...over })

function withApi(api: Record<string, jest.Mock>) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

describe('useAdminUsers', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('buildUserQuery trims the email and sends current only past page 1', async () => {
    const { buildUserQuery } = await import(composablePath)
    expect(buildUserQuery({})).toEqual({})
    expect(buildUserQuery({ email: '  bob ', page: 1 })).toEqual({ email: 'bob' })
    expect(buildUserQuery({ page: 3 })).toEqual({ current: '3' })
  })

  test('load reads records, total, current and hasNext', async () => {
    const get = jest.fn(async () => ({ records: [u('a')], total: 21, current: 1, size: 20, hasNext: true, hasPrev: false }))
    withApi({ get })
    const { useAdminUsers } = await import(composablePath)
    const users = useAdminUsers()

    await users.load({ email: 'a' })

    expect(get).toHaveBeenCalledWith('/admin/users', { query: { email: 'a' } })
    expect(users.users.value).toHaveLength(1)
    expect(users.total.value).toBe(21)
    expect(users.hasNext.value).toBe(true)
  })

  test('setDisabled patches and replaces the row without mutating the old array', async () => {
    const get = jest.fn(async () => ({ records: [u('a'), u('b')], total: 2, current: 1, size: 20, hasNext: false, hasPrev: false }))
    const patch = jest.fn(async () => u('b', { disabled: true }))
    withApi({ get, patch })
    const { useAdminUsers } = await import(composablePath)
    const users = useAdminUsers()
    await users.load()
    const before = users.users.value

    await users.setDisabled('b', true)

    expect(patch).toHaveBeenCalledWith('/admin/users/b', { disabled: true })
    expect(users.users.value[1].disabled).toBe(true)
    expect(before[1].disabled).toBe(false)
  })

  test('setRole patches the role', async () => {
    const get = jest.fn(async () => ({ records: [u('a')], total: 1, current: 1, size: 20, hasNext: false, hasPrev: false }))
    const patch = jest.fn(async () => u('a', { role: 'ADMIN' }))
    withApi({ get, patch })
    const { useAdminUsers } = await import(composablePath)
    const users = useAdminUsers()
    await users.load()

    await users.setRole('a', 'ADMIN')

    expect(patch).toHaveBeenCalledWith('/admin/users/a', { role: 'ADMIN' })
    expect(users.users.value[0].role).toBe('ADMIN')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && bunx jest tests/composables/useRegistrationStatus.spec.ts tests/composables/useAdminUsers.spec.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the composables**

Create `apps/web/composables/useRegistrationStatus.ts`:

```ts
import { ref } from 'vue'

/**
 * Whether self-registration is open (GET /auth/registration-status).
 * A failed probe reads as closed: the register link hides instead of
 * leading to a form the API would refuse.
 */
export function useRegistrationStatus() {
  const { $api } = useApi()
  const open = ref(false)
  const loaded = ref(false)

  async function load(): Promise<void> {
    try {
      const res = await $api.get<{ open: boolean }>('/auth/registration-status')
      open.value = res?.open === true
    } catch {
      open.value = false
    } finally {
      loaded.value = true
    }
  }

  return { open, loaded, load }
}
```

Create `apps/web/composables/useAdminUsers.ts`:

```ts
import { ref } from 'vue'

export type GlobalRole = 'MEMBER' | 'ADMIN'

export interface AdminUser {
  id: string
  email: string
  name: string | null
  role: GlobalRole
  disabled: boolean
  createdAt: string
}

export interface AdminUserPage {
  records: AdminUser[]
  total: number
  current: number
  size: number
  hasNext: boolean
  hasPrev: boolean
}

export interface NewUser {
  email: string
  name: string
  password: string
  role: GlobalRole
}

export function buildUserQuery(filters: { email?: string; page?: number }): Record<string, string> {
  const query: Record<string, string> = {}
  const email = filters.email?.trim()
  if (email) query.email = email
  if (filters.page && filters.page > 1) query.current = String(filters.page)
  return query
}

export function useAdminUsers() {
  const { $api } = useApi()
  const users = ref<AdminUser[]>([])
  const total = ref(0)
  const page = ref(1)
  const hasNext = ref(false)
  const pending = ref(false)

  async function load(filters: { email?: string; page?: number } = {}): Promise<void> {
    pending.value = true
    try {
      const res = await $api.get<AdminUserPage>('/admin/users', { query: buildUserQuery(filters) })
      users.value = res.records ?? []
      total.value = res.total ?? 0
      page.value = res.current ?? 1
      hasNext.value = res.hasNext === true
    } finally {
      pending.value = false
    }
  }

  function replace(updated: AdminUser): void {
    users.value = users.value.map((u) => (u.id === updated.id ? updated : u))
  }

  async function createUser(input: NewUser): Promise<AdminUser> {
    return $api.post<AdminUser>('/admin/users', { ...input })
  }

  async function setDisabled(id: string, disabled: boolean): Promise<void> {
    replace(await $api.patch<AdminUser>(`/admin/users/${encodeURIComponent(id)}`, { disabled }))
  }

  async function setRole(id: string, role: GlobalRole): Promise<void> {
    replace(await $api.patch<AdminUser>(`/admin/users/${encodeURIComponent(id)}`, { role }))
  }

  return { users, total, page, hasNext, pending, load, createUser, setDisabled, setRole }
}
```

Run: `cd apps/web && bunx jest tests/composables/useRegistrationStatus.spec.ts tests/composables/useAdminUsers.spec.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing page wiring tests**

Append to `apps/web/tests/pages/register.spec.ts`:

```ts
describe('Slice 4: register page follows the registration status', () => {
  const source = () => readFileSync(registerPath, 'utf-8')

  test('probes the registration status on mount', () => {
    expect(source()).toContain('useRegistrationStatus()')
    expect(source()).toMatch(/onMounted\(/)
  })

  test('renders the form only while registration is open', () => {
    expect(source()).toMatch(/<form[^>]*v-if="registrationOpen"/)
  })

  test('shows the closed notice with a way back to sign in', () => {
    expect(source()).toContain("t('auth.register.closedTitle')")
    expect(source()).toMatch(/v-else-if="registrationLoaded"/)
  })
})
```

Append to `apps/web/tests/pages/login.spec.ts` (it reads `pages/login.vue` the same way; reuse its path constant):

```ts
describe('Slice 4: login page hides the register link when registration is closed', () => {
  test('the create-account paragraph is conditional on the registration status', () => {
    const source = readFileSync(loginPath, 'utf-8')
    expect(source).toContain('useRegistrationStatus()')
    expect(source).toMatch(/<p[^>]*v-if="registrationOpen"/)
  })
})
```

(If `login.spec.ts` names its path constant differently, use that name.)

Create `apps/web/tests/pages/admin-users.spec.ts`:

```ts
import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const read = (...p: string[]) => readFileSync(join(webDir, ...p), 'utf-8')

describe('Slice 4: admin users page wiring', () => {
  test('page loads through useAdminUsers and handles the admin-only 403', () => {
    const page = read('pages', 'admin', 'users.vue')
    expect(page).toContain('useAdminUsers()')
    expect(page).toContain('isForbidden(')
    expect(page).toContain('<CreateUserDialog')
  })

  test('an admin cannot disable or demote their own row from the UI', () => {
    const page = read('pages', 'admin', 'users.vue')
    expect(page).toMatch(/:disabled="isSelf\(user\)"/)
  })

  test('dialog posts through useAdminUsers().createUser', () => {
    const dialog = read('components', 'CreateUserDialog.vue')
    expect(dialog).toContain('createUser(')
    expect(dialog).toContain("emit('created')")
  })

  test('sidebar shows Users only to global admins', () => {
    const layout = read('layouts', 'default.vue')
    expect(layout).toMatch(/v-if="isGlobalAdmin"[^>]*to="\/admin\/users"|to="\/admin\/users"[^>]*v-if="isGlobalAdmin"/)
  })
})
```

Run: `cd apps/web && bunx jest tests/pages/register.spec.ts tests/pages/login.spec.ts tests/pages/admin-users.spec.ts`
Expected: FAIL.

- [ ] **Step 5: Wire login and register**

`apps/web/pages/login.vue`, script: add

```ts
const { open: registrationOpen, load: loadRegistrationStatus } = useRegistrationStatus()
onMounted(loadRegistrationStatus)
```

and put `v-if="registrationOpen"` on the `<p class="text-center text-sm text-muted-foreground">` that holds the "Create one" link.

`apps/web/pages/register.vue`, script: add

```ts
const {
  open: registrationOpen,
  loaded: registrationLoaded,
  load: loadRegistrationStatus,
} = useRegistrationStatus()
onMounted(loadRegistrationStatus)
```

Template: keep the outer `<div class="w-full max-w-md space-y-8">` and the title block. Add `v-if="registrationOpen"` to the `<form>`, and directly after the form insert:

```vue
    <div v-else-if="registrationLoaded" class="rounded-md border border-border p-6 text-center space-y-2">
      <h3 class="text-lg font-semibold">{{ t('auth.register.closedTitle') }}</h3>
      <p class="text-sm text-muted-foreground">{{ t('auth.register.closedBody') }}</p>
    </div>
```

(The existing "Already have an account? Sign in" paragraph stays and is the way back.)

- [ ] **Step 6: Admin users page, dialog and nav**

Create `apps/web/components/CreateUserDialog.vue`:

```vue
<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{{ t('admin.users.form.title') }}</DialogTitle>
      </DialogHeader>

      <form class="space-y-4" @submit="onSubmit">
        <FormField v-slot="{ componentField }" name="email">
          <FormItem>
            <FormLabel>{{ t('admin.users.form.email') }}</FormLabel>
            <FormControl><Input type="email" v-bind="componentField" /></FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="name">
          <FormItem>
            <FormLabel>{{ t('admin.users.form.name') }}</FormLabel>
            <FormControl><Input v-bind="componentField" /></FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="password">
          <FormItem>
            <FormLabel>{{ t('admin.users.form.password') }}</FormLabel>
            <FormControl><Input type="password" autocomplete="new-password" v-bind="componentField" /></FormControl>
            <p class="text-xs text-muted-foreground">{{ t('admin.users.form.passwordHint') }}</p>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="role">
          <FormItem>
            <FormLabel>{{ t('admin.users.form.role') }}</FormLabel>
            <FormControl>
              <select v-bind="componentField" class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="MEMBER">{{ t('admin.users.roles.MEMBER') }}</option>
                <option value="ADMIN">{{ t('admin.users.roles.ADMIN') }}</option>
              </select>
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="isSubmitting">
            {{ isSubmitting ? t('admin.users.form.creating') : t('admin.users.form.submit') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { extractApiError } from '~/composables/useApi'

defineProps<{ open: boolean }>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'created'): void
}>()

const { t } = useI18n()
const toast = useAppToast()
const { createUser } = useAdminUsers()

// Mirrors the API's PASSWORD_COMPLEXITY so the user sees the rule before submitting.
const PASSWORD_COMPLEXITY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).+$/

const formSchema = toTypedSchema(z.object({
  email: z.string().min(1, t('auth.validation.emailRequired')).email(t('auth.validation.emailInvalid')),
  name: z.string().min(1, t('auth.validation.nameRequired')),
  password: z.string().min(8, t('auth.validation.passwordMin')).regex(PASSWORD_COMPLEXITY, t('admin.users.form.passwordComplexity')),
  role: z.enum(['MEMBER', 'ADMIN']),
}))

const { handleSubmit, isSubmitting, resetForm } = useForm({
  validationSchema: formSchema,
  initialValues: { email: '', name: '', password: '', role: 'MEMBER' as const },
})

const onSubmit = handleSubmit(async (values) => {
  try {
    await createUser(values)
    toast.success(t('admin.users.toast.created'))
    emit('created')
    emit('update:open', false)
    resetForm()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
})
</script>
```

(If `auth.validation.nameRequired` does not exist in `en.json`, add it in Step 7 — `register.vue` already calls it with a fallback.)

Create `apps/web/pages/admin/users.vue`:

```vue
<script setup lang="ts">
import { UserPlus } from 'lucide-vue-next'
import { ApiError, extractApiError } from '~/composables/useApi'
import type { AdminUser, GlobalRole } from '~/composables/useAdminUsers'

definePageMeta({ layout: 'default' })

const { t } = useI18n()
const toast = useAppToast()
const { user: currentUser } = useAuth()
const { users, page, hasNext, pending, load, setDisabled, setRole } = useAdminUsers()

const emailFilter = ref('')
const createOpen = ref(false)
const adminOnly = ref(false)

function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 403 || err.code === 40003)
}

function isSelf(user: AdminUser): boolean {
  return user.id === currentUser.value?.id
}

async function reload(targetPage = 1): Promise<void> {
  adminOnly.value = false
  try {
    await load({ email: emailFilter.value, page: targetPage })
  } catch (err: unknown) {
    if (isForbidden(err)) {
      adminOnly.value = true
      return
    }
    toast.error(extractApiError(err))
  }
}

async function toggleDisabled(user: AdminUser): Promise<void> {
  try {
    await setDisabled(user.id, !user.disabled)
    toast.success(t(user.disabled ? 'admin.users.toast.enabled' : 'admin.users.toast.disabled'))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

async function changeRole(user: AdminUser, role: GlobalRole): Promise<void> {
  if (role === user.role) return
  try {
    await setRole(user.id, role)
    toast.success(t('admin.users.toast.roleChanged'))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
    await reload(page.value)
  }
}

onMounted(() => reload())
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('admin.users.title')" :subtitle="t('admin.users.subtitle')">
      <template #actions>
        <Button :disabled="adminOnly" @click="createOpen = true">
          <UserPlus class="mr-2 h-4 w-4" />{{ t('admin.users.create') }}
        </Button>
      </template>
    </PageHeader>

    <p v-if="adminOnly" class="text-sm text-muted-foreground">{{ t('admin.users.adminOnly') }}</p>

    <template v-else>
      <form class="flex max-w-md gap-2" @submit.prevent="reload()">
        <Input v-model="emailFilter" :placeholder="t('admin.users.filterPlaceholder')" />
        <Button type="submit" variant="outline">{{ t('admin.users.filter') }}</Button>
      </form>

      <LoadingState v-if="pending && users.length === 0" />
      <Table v-else>
        <TableHeader>
          <TableRow>
            <TableHead>{{ t('admin.users.table.email') }}</TableHead>
            <TableHead>{{ t('admin.users.table.name') }}</TableHead>
            <TableHead>{{ t('admin.users.table.role') }}</TableHead>
            <TableHead>{{ t('admin.users.table.status') }}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="user in users" :key="user.id">
            <TableCell>
              {{ user.email }}
              <span v-if="isSelf(user)" class="ml-1 text-xs text-muted-foreground">({{ t('admin.users.you') }})</span>
            </TableCell>
            <TableCell>{{ user.name }}</TableCell>
            <TableCell>
              <select
                :value="user.role"
                :disabled="isSelf(user)"
                class="h-8 rounded-md border border-input bg-background px-2 text-sm"
                @change="changeRole(user, ($event.target as HTMLSelectElement).value as GlobalRole)"
              >
                <option value="MEMBER">{{ t('admin.users.roles.MEMBER') }}</option>
                <option value="ADMIN">{{ t('admin.users.roles.ADMIN') }}</option>
              </select>
            </TableCell>
            <TableCell>{{ user.disabled ? t('admin.users.status.disabled') : t('admin.users.status.active') }}</TableCell>
            <TableCell class="text-right">
              <Button size="sm" variant="outline" :disabled="isSelf(user)" @click="toggleDisabled(user)">
                {{ user.disabled ? t('admin.users.enable') : t('admin.users.disable') }}
              </Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>

      <div class="flex gap-2">
        <Button variant="outline" size="sm" :disabled="page <= 1" @click="reload(page - 1)">{{ t('admin.users.prev') }}</Button>
        <Button variant="outline" size="sm" :disabled="!hasNext" @click="reload(page + 1)">{{ t('admin.users.next') }}</Button>
      </div>
    </template>

    <CreateUserDialog v-model:open="createOpen" @created="reload(page)" />
  </div>
</template>
```

The `:disabled="isSelf(user)"` attribute on the enable/disable button is what the Step 4 test matches.

`apps/web/layouts/default.vue`: add `Users` to the `lucide-vue-next` import, add

```ts
const isGlobalAdmin = computed(() => auth.user.value?.role === 'ADMIN')
```

and after the SLOs `NuxtLink`:

```vue
        <NuxtLink v-if="isGlobalAdmin" to="/admin/users" :class="navLinkClass" :active-class="activeClass"><Users class="h-4 w-4 shrink-0" />{{ t('nav.users') }}</NuxtLink>
```

- [ ] **Step 7: Strings (en and zh)**

In `apps/web/i18n/locales/en.json`:
- `auth.register`: add `"closedTitle": "Registration is closed"`, `"closedBody": "Ask an administrator to create an account for you."`
- `auth.validation`: add `"nameRequired": "Name is required"` if missing.
- `nav`: add `"users": "Users"`.
- New top-level `admin`:

```json
"admin": {
  "users": {
    "title": "Users",
    "subtitle": "Create accounts, change global roles and disable access.",
    "create": "New user",
    "filter": "Filter",
    "filterPlaceholder": "Filter by email",
    "adminOnly": "Only global administrators can manage users.",
    "you": "you",
    "enable": "Enable",
    "disable": "Disable",
    "prev": "Previous",
    "next": "Next",
    "table": { "email": "Email", "name": "Name", "role": "Role", "status": "Status" },
    "status": { "active": "Active", "disabled": "Disabled" },
    "roles": { "MEMBER": "Member", "ADMIN": "Admin" },
    "toast": { "created": "User created", "disabled": "User disabled", "enabled": "User enabled", "roleChanged": "Role updated" },
    "form": {
      "title": "New user",
      "email": "Email",
      "name": "Name",
      "password": "Temporary password",
      "passwordHint": "Share it with the user out of band.",
      "passwordComplexity": "Use upper and lower case letters, a number and a symbol",
      "role": "Global role",
      "submit": "Create user",
      "creating": "Creating…"
    }
  }
}
```

In `apps/web/i18n/locales/zh.json`, the same keys:
- `auth.register`: `"closedTitle": "注册已关闭"`, `"closedBody": "请联系管理员为您创建账号。"`; `auth.validation.nameRequired`: `"请输入姓名"` if missing; `nav.users`: `"用户"`.
- `admin.users`: `title` 用户, `subtitle` 创建账号、调整全局角色、停用访问。, `create` 新建用户, `filter` 筛选, `filterPlaceholder` 按邮箱筛选, `adminOnly` 只有全局管理员可以管理用户。, `you` 你, `enable` 启用, `disable` 停用, `prev` 上一页, `next` 下一页, `table` {email 邮箱, name 姓名, role 角色, status 状态}, `status` {active 正常, disabled 已停用}, `roles` {MEMBER 成员, ADMIN 管理员}, `toast` {created 用户已创建, disabled 用户已停用, enabled 用户已启用, roleChanged 角色已更新}, `form` {title 新建用户, email 邮箱, name 姓名, password 临时密码, passwordHint 请通过其他渠道告知用户。, passwordComplexity 需包含大小写字母、数字和符号, role 全局角色, submit 创建用户, creating 创建中…}.

- [ ] **Step 8: Run the web suite and type-check**

Run: `cd apps/web && bunx jest && cd ../.. && bun run type-check`
Expected: PASS, including `tests/i18n/locale-parity.spec.ts` and the existing `register.spec.ts` structure tests.

- [ ] **Step 9: Commit**

```bash
git add apps/web/composables/useRegistrationStatus.ts apps/web/composables/useAdminUsers.ts \
  apps/web/pages/login.vue apps/web/pages/register.vue apps/web/pages/admin/users.vue \
  apps/web/components/CreateUserDialog.vue apps/web/layouts/default.vue apps/web/i18n/locales \
  apps/web/tests/composables/useRegistrationStatus.spec.ts apps/web/tests/composables/useAdminUsers.spec.ts \
  apps/web/tests/pages/register.spec.ts apps/web/tests/pages/login.spec.ts apps/web/tests/pages/admin-users.spec.ts
git commit -m "feat(web): admin users page; register link follows registration status"
```

---

### Task 8: Web — project members section

**Files:**
- Create: `apps/web/composables/useProjectMembers.ts`, `apps/web/tests/composables/useProjectMembers.spec.ts`
- Create: `apps/web/components/ProjectMembersPanel.vue`, `apps/web/tests/components/ProjectMembersPanel.spec.ts`
- Modify: `apps/web/pages/[project]/settings.vue:266-300`
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`

**Interfaces:**
- Consumes (API wire): `GET /projects/:slug/members?current` → page of `{ userId, email, name, role, joinedAt }`; `POST` `{ email, role }`; `PATCH /:userId { role }`; `DELETE /:userId`.
- Produces: `useProjectMembers(slug)`; `canManageMembers(user: { id: string; role?: string } | null, members: ProjectMember[]): boolean`; `ASSIGNABLE_MEMBER_ROLES`.

- [ ] **Step 1: Write the failing composable tests**

Create `apps/web/tests/composables/useProjectMembers.spec.ts`:

```ts
import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useProjectMembers.ts')
const m = (userId: string, role = 'DEVELOPER') => ({ userId, email: `${userId}@k.t`, name: userId, role, joinedAt: '2026-09-26T00:00:00Z' })
const pageOf = (records: unknown[], over: Record<string, unknown> = {}) => ({ records, total: records.length, current: 1, size: 20, hasNext: false, hasPrev: false, ...over })

function withApi(api: Record<string, jest.Mock>) {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

describe('useProjectMembers', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>).useApi = undefined })

  test('load fetches page 1; loadMore appends the next page', async () => {
    const get = jest.fn()
      .mockImplementationOnce(async () => pageOf([m('a')], { total: 2, hasNext: true }))
      .mockImplementationOnce(async () => pageOf([m('b')], { total: 2, current: 2, hasPrev: true }))
    withApi({ get })
    const { useProjectMembers } = await import(composablePath)
    const members = useProjectMembers('team')

    await members.load()
    await members.loadMore()

    expect(get).toHaveBeenNthCalledWith(1, '/projects/team/members', { query: {} })
    expect(get).toHaveBeenNthCalledWith(2, '/projects/team/members', { query: { current: '2' } })
    expect(members.members.value.map((x: { userId: string }) => x.userId)).toEqual(['a', 'b'])
    expect(members.hasNext.value).toBe(false)
  })

  test('add appends, changeRole replaces, remove filters', async () => {
    const get = jest.fn(async () => pageOf([m('a', 'ADMIN')]))
    const post = jest.fn(async () => m('b', 'VIEWER'))
    const patch = jest.fn(async () => m('b', 'DEVELOPER'))
    const del = jest.fn(async () => ({}))
    withApi({ get, post, patch, delete: del })
    const { useProjectMembers } = await import(composablePath)
    const members = useProjectMembers('team')
    await members.load()

    await members.add('b@k.t', 'VIEWER')
    await members.changeRole('b', 'DEVELOPER')
    await members.remove('a')

    expect(post).toHaveBeenCalledWith('/projects/team/members', { email: 'b@k.t', role: 'VIEWER' })
    expect(patch).toHaveBeenCalledWith('/projects/team/members/b', { role: 'DEVELOPER' })
    expect(del).toHaveBeenCalledWith('/projects/team/members/a')
    expect(members.members.value).toEqual([m('b', 'DEVELOPER')])
    expect(members.total.value).toBe(1)
  })

  test('canManageMembers: global admin or project ADMIN member only', async () => {
    const { canManageMembers } = await import(composablePath)
    const list = [m('pa', 'ADMIN'), m('dev', 'DEVELOPER')]
    expect(canManageMembers({ id: 'root', role: 'ADMIN' }, list)).toBe(true)
    expect(canManageMembers({ id: 'pa', role: 'MEMBER' }, list)).toBe(true)
    expect(canManageMembers({ id: 'dev', role: 'MEMBER' }, list)).toBe(false)
    expect(canManageMembers(null, list)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && bunx jest tests/composables/useProjectMembers.spec.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the composable**

Create `apps/web/composables/useProjectMembers.ts`:

```ts
import { ref } from 'vue'

export const ASSIGNABLE_MEMBER_ROLES = ['ADMIN', 'DEVELOPER', 'VIEWER'] as const
export type AssignableMemberRole = (typeof ASSIGNABLE_MEMBER_ROLES)[number]

export interface ProjectMember {
  userId: string
  email: string
  name: string | null
  role: string
  joinedAt: string
}

interface MemberPage {
  records: ProjectMember[]
  total: number
  current: number
  hasNext: boolean
}

/** The API enforces this too; the UI only hides controls a user cannot use. */
export function canManageMembers(user: { id: string; role?: string } | null, members: ProjectMember[]): boolean {
  if (!user) return false
  if (user.role === 'ADMIN') return true
  return members.some((m) => m.userId === user.id && m.role === 'ADMIN')
}

export function useProjectMembers(slug: string) {
  const { $api } = useApi()
  const base = `/projects/${encodeURIComponent(slug)}/members`
  const members = ref<ProjectMember[]>([])
  const total = ref(0)
  const current = ref(1)
  const hasNext = ref(false)

  async function fetchPage(pageNumber: number): Promise<MemberPage> {
    const query: Record<string, string> = pageNumber > 1 ? { current: String(pageNumber) } : {}
    return $api.get<MemberPage>(base, { query })
  }

  async function load(): Promise<void> {
    const res = await fetchPage(1)
    members.value = res.records ?? []
    total.value = res.total ?? 0
    current.value = 1
    hasNext.value = res.hasNext === true
  }

  async function loadMore(): Promise<void> {
    const res = await fetchPage(current.value + 1)
    members.value = [...members.value, ...(res.records ?? [])]
    total.value = res.total ?? total.value
    current.value = res.current ?? current.value + 1
    hasNext.value = res.hasNext === true
  }

  async function add(email: string, role: AssignableMemberRole): Promise<void> {
    const added = await $api.post<ProjectMember>(base, { email, role })
    members.value = [...members.value, added]
    total.value += 1
  }

  async function changeRole(userId: string, role: AssignableMemberRole): Promise<void> {
    const updated = await $api.patch<ProjectMember>(`${base}/${encodeURIComponent(userId)}`, { role })
    members.value = members.value.map((m) => (m.userId === userId ? updated : m))
  }

  async function remove(userId: string): Promise<void> {
    await $api.delete(`${base}/${encodeURIComponent(userId)}`)
    members.value = members.value.filter((m) => m.userId !== userId)
    total.value = Math.max(0, total.value - 1)
  }

  return { members, total, hasNext, load, loadMore, add, changeRole, remove }
}
```

Run: `cd apps/web && bunx jest tests/composables/useProjectMembers.spec.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing panel wiring test**

Create `apps/web/tests/components/ProjectMembersPanel.spec.ts`:

```ts
import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const panel = () => readFileSync(join(webDir, 'components', 'ProjectMembersPanel.vue'), 'utf-8')
const settings = () => readFileSync(join(webDir, 'pages', '[project]', 'settings.vue'), 'utf-8')

describe('Slice 4: project members panel', () => {
  test('loads through useProjectMembers(slug) on mount', () => {
    expect(panel()).toContain('useProjectMembers(props.slug)')
    expect(panel()).toMatch(/onMounted\(/)
  })

  test('management controls are gated by canManageMembers', () => {
    expect(panel()).toContain('canManageMembers(')
    expect(panel()).toMatch(/v-if="canManage"/)
  })

  test('removal asks for confirmation', () => {
    expect(panel()).toContain("t('projects.members.removeConfirm'")
    expect(panel()).toContain('window.confirm(')
  })

  test('settings renders the panel in the project tab', () => {
    expect(settings()).toMatch(/<ProjectMembersPanel :slug="slug" \/>/)
  })
})
```

Run: `cd apps/web && bunx jest tests/components/ProjectMembersPanel.spec.ts`
Expected: FAIL.

- [ ] **Step 5: Implement the panel and mount it**

Create `apps/web/components/ProjectMembersPanel.vue`:

```vue
<script setup lang="ts">
import { extractApiError } from '~/composables/useApi'
import { ASSIGNABLE_MEMBER_ROLES, canManageMembers } from '~/composables/useProjectMembers'
import type { AssignableMemberRole, ProjectMember } from '~/composables/useProjectMembers'

const props = defineProps<{ slug: string }>()

const { t } = useI18n()
const toast = useAppToast()
const { user } = useAuth()
const { members, total, hasNext, load, loadMore, add, changeRole, remove } = useProjectMembers(props.slug)

const loading = ref(true)
const newEmail = ref('')
const newRole = ref<AssignableMemberRole>('DEVELOPER')
const adding = ref(false)

const canManage = computed(() => canManageMembers(user.value, members.value))

async function run(action: () => Promise<void>, successKey?: string): Promise<boolean> {
  try {
    await action()
    if (successKey) toast.success(t(successKey))
    return true
  } catch (err: unknown) {
    toast.error(extractApiError(err))
    return false
  }
}

async function onAdd(): Promise<void> {
  const email = newEmail.value.trim()
  if (!email) return
  adding.value = true
  if (await run(() => add(email, newRole.value), 'projects.members.toast.added')) newEmail.value = ''
  adding.value = false
}

async function onRoleChange(member: ProjectMember, role: AssignableMemberRole): Promise<void> {
  if (role === member.role) return
  const ok = await run(() => changeRole(member.userId, role), 'projects.members.toast.roleChanged')
  if (!ok) await run(load)
}

async function onRemove(member: ProjectMember): Promise<void> {
  if (!window.confirm(t('projects.members.removeConfirm', { email: member.email }))) return
  await run(() => remove(member.userId), 'projects.members.toast.removed')
}

onMounted(async () => {
  await run(load)
  loading.value = false
})
</script>

<template>
  <div class="rounded-md border border-border p-6 space-y-4">
    <div>
      <h2 class="text-lg font-semibold">{{ t('projects.members.title') }} <span class="text-sm text-muted-foreground">({{ total }})</span></h2>
      <p class="text-sm text-muted-foreground">{{ t('projects.members.subtitle') }}</p>
    </div>

    <form v-if="canManage" class="flex flex-wrap gap-2" @submit.prevent="onAdd">
      <Input v-model="newEmail" type="email" class="max-w-xs" :placeholder="t('projects.members.addEmail')" />
      <select v-model="newRole" class="h-9 rounded-md border border-input bg-background px-2 text-sm">
        <option v-for="role in ASSIGNABLE_MEMBER_ROLES" :key="role" :value="role">{{ t(`projects.members.roles.${role}`) }}</option>
      </select>
      <Button type="submit" :disabled="adding">{{ adding ? t('common.loading') : t('projects.members.add') }}</Button>
    </form>

    <LoadingState v-if="loading" />
    <p v-else-if="members.length === 0" class="text-sm text-muted-foreground">{{ t('projects.members.empty') }}</p>
    <ul v-else class="divide-y divide-border">
      <li v-for="member in members" :key="member.userId" class="flex items-center justify-between gap-4 py-2">
        <div>
          <div class="text-sm font-medium">{{ member.name || member.email }}</div>
          <div class="text-xs text-muted-foreground">{{ member.email }}</div>
        </div>
        <div class="flex items-center gap-2">
          <select
            v-if="canManage"
            :value="member.role"
            class="h-8 rounded-md border border-input bg-background px-2 text-sm"
            @change="onRoleChange(member, ($event.target as HTMLSelectElement).value as AssignableMemberRole)"
          >
            <option v-for="role in ASSIGNABLE_MEMBER_ROLES" :key="role" :value="role">{{ t(`projects.members.roles.${role}`) }}</option>
          </select>
          <span v-else class="text-sm">{{ t(`projects.members.roles.${member.role}`) }}</span>
          <Button v-if="canManage" size="sm" variant="outline" @click="onRemove(member)">{{ t('projects.members.remove') }}</Button>
        </div>
      </li>
    </ul>

    <Button v-if="hasNext" variant="outline" size="sm" @click="run(loadMore)">{{ t('projects.members.loadMore') }}</Button>
  </div>
</template>
```

In `apps/web/pages/[project]/settings.vue`, inside `<TabsContent value="project" class="space-y-4">`, after the closing `</div>` of the project-details card (just before `</TabsContent>`), add:

```vue
        <ProjectMembersPanel :slug="slug" />
```

- [ ] **Step 6: Strings (en and zh)**

`apps/web/i18n/locales/en.json`, under `projects`, add:

```json
"members": {
  "title": "Members",
  "subtitle": "People who can see and work on this project.",
  "addEmail": "Email of an existing user",
  "add": "Add member",
  "remove": "Remove",
  "removeConfirm": "Remove {email} from this project?",
  "empty": "No members yet.",
  "loadMore": "Load more",
  "roles": { "ADMIN": "Admin", "DEVELOPER": "Developer", "VIEWER": "Viewer", "AGENT": "Agent" },
  "toast": { "added": "Member added", "removed": "Member removed", "roleChanged": "Role updated" }
}
```

`apps/web/i18n/locales/zh.json`, under `projects.members`: `title` 成员, `subtitle` 可以查看和参与此项目的人员。, `addEmail` 已有用户的邮箱, `add` 添加成员, `remove` 移除, `removeConfirm` 确定将 {email} 移出此项目？, `empty` 暂无成员。, `loadMore` 加载更多, `roles` {ADMIN 管理员, DEVELOPER 开发者, VIEWER 查看者, AGENT 代理}, `toast` {added 已添加成员, removed 已移除成员, roleChanged 角色已更新}.

- [ ] **Step 7: Run the web suite and type-check**

Run: `cd apps/web && bunx jest && cd ../.. && bun run type-check`
Expected: PASS (including locale parity and the existing settings tab tests).

- [ ] **Step 8: Commit**

```bash
git add apps/web/composables/useProjectMembers.ts apps/web/components/ProjectMembersPanel.vue \
  apps/web/pages/[project]/settings.vue apps/web/i18n/locales \
  apps/web/tests/composables/useProjectMembers.spec.ts apps/web/tests/components/ProjectMembersPanel.spec.ts
git commit -m "feat(web): project members section in settings"
```

---

### Task 9: Docs, deploy knob, and final verification

**Files:**
- Modify: `docs/architecture.md` ("Auth Architecture" section)
- Modify: `docs/superpowers/specs/2026-09-25-track-1-foundations-design.md` (status line)
- Modify: `docker-compose.yml` (api `environment`)

- [ ] **Step 1: Architecture doc**

Append to the "Auth Architecture" section of `docs/architecture.md`:

```markdown
### Users, registration and membership (Track 1 Slice 4)

- **Registration is closed by default** (`REGISTRATION_ENABLED=false`). The first
  user to register on an empty database becomes global `ADMIN`; the check and the
  insert run in one transaction behind a Postgres advisory lock
  (`src/common/utils/advisory-lock.ts`), so concurrent first registrations produce
  exactly one admin. `GET /auth/registration-status` (public) reports `{ open }`.
- **Global admins manage users** under `/admin/users` (list, create with a
  temporary password, change role, disable). There is no deletion. Disabling or
  changing a role bumps `tokenVersion` and invalidates the per-user auth-state
  cache, so outstanding access and refresh tokens stop working on the next request.
  The last active global admin cannot be demoted or disabled, and nobody can
  demote or disable themselves.
- **Project membership** lives under `/projects/:slug/members`. Any member can
  list; a global admin or a project `ADMIN` can add (by email of an existing
  user), change roles (`ADMIN | DEVELOPER | VIEWER`) and remove. A change that
  would leave a project with no `ADMIN` member is refused unless a global admin
  makes it. Membership is read live on every request (never cached).
- **CLI**: `koda user …` and member writes need a user access token
  (`KODA_API_KEY=<token>`); agent API keys never hold the global `ADMIN` authority.
```

- [ ] **Step 2: Spec status and compose**

In `docs/superpowers/specs/2026-09-25-track-1-foundations-design.md`, update the `**Status:**` line to record Slice 3 merged (#137) and Slice 4 implemented on `feat/track1-users-membership`.

In `docker-compose.yml`, api service `environment`, after `JWT_REFRESH_EXPIRES_IN`:

```yaml
      REGISTRATION_ENABLED: ${REGISTRATION_ENABLED:-false}
```

- [ ] **Step 3: Full verification from the repo root**

Run:
```bash
bun run lint
bun run type-check
bun run test
cd apps/api && bun run test:db:up && bun run test:integration && cd ../..
```
Expected: all green. `bun run test` must pass with the test database stopped (`cd apps/api && bun run test:db:down` first to prove it).

- [ ] **Step 4: Re-verify the spec's Slice 4 checklist against source**

For each item, point at the file that implements it and the test that pins it:
- registration flag + bootstrap + status: `auth.service.ts`, `prisma-auth.repository.ts`; `registration.integration.spec.ts`
- `User.disabled`, disable kills sessions, login/JWT reject: `jwt-auth.provider.ts`, `auth.service.ts`; `disabled-user.integration.spec.ts`, `admin-users.integration.spec.ts`
- `/admin/users` + self/last-admin guards: `users-admin.service.ts`; `admin-users.integration.spec.ts`
- `/projects/:slug/members` + `assertProjectAdmin` + last-ADMIN guard: `project-members.service.ts`, `project-access.service.ts`; `project-members.integration.spec.ts`
- web admin page, settings Members, register hidden: Tasks 7-8 files
- CLI `user create|list|disable`, `member list|add|role|remove`: Task 6 files
- bootstrap-admin race LOW: closed by the advisory lock

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md docs/superpowers/specs/2026-09-25-track-1-foundations-design.md docker-compose.yml
git commit -m "docs: users, registration and membership (Track 1 Slice 4)"
```

Do not push or open a PR without the user's explicit approval.

---

## Out of scope (recorded, not fixed here)

- A CLI user-session login (`koda login --email` with refresh). The new `koda user` commands take a user access token through `KODA_API_KEY` for now.
- Invite links and email delivery (spec).
- Creating a membership row for the creator of a new project (projects are created by global admins, who already have access; project admins are added explicitly).
- `GET /projects/:slug/tickets` membership enforcement and the remaining review items (M5, M7-M13, M15-M19, M21, M24-M28).
- Web Playwright e2e for these pages (the spec's Slice 4 tests are integration + unit; the Slice 5 e2e will cover the board).
