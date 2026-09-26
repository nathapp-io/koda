# Deep Code Review: Track 1 Slice 4 — Users, Registration and Membership

**Date:** 2026-09-26
**Reviewer:** Subrina (AI)
**Branch:** `feat/track1-users-membership` (merge-base `main` @ `6a06031f`; head `156b754a`, includes `origin/main` merge with #138 outbox retention)
**Plan:** `docs/superpowers/plans/2026-09-26-track-1-slice-4-users-membership.md`
**Spec:** `docs/superpowers/specs/2026-09-25-track-1-foundations-design.md` § "Slice 4 — Users and membership"
**Scope:** 119 files changed (~8.6k insertions) across `apps/api`, `apps/cli`, `apps/web`, `openapi.json`, docs; includes the merged #138 outbox-retention commit (reviewed here as part of the branch)
**Stack:** NestJS 11 + Fastify, Prisma 6 / Postgres 16, `@nathapp/nestjs-*` 3.3.0, Nuxt 3, Commander CLI, Jest

---

## Overall Grade: A- (88/100)

This is a strong, carefully verified slice. The two hard problems — the bootstrap-admin race and the
"last admin must remain" invariants — are solved with transaction-scoped Postgres advisory locks taken
through the Prisma transaction proxy, and both races are pinned by DB-backed integration tests that
actually exercise concurrency. Session kill for demoted/disabled users is real and tested end-to-end:
the 60 s auth-state cache is invalidated by tag **and** by direct key, which is the correct workaround
for the app's `MEMORY` cache strategy. The registration gate is closed by default with a working
fresh-install bootstrap, the clock-free contract is regenerated, and the CLI/web layers stay thin.

I found no CRITICAL or HIGH defect. The remaining findings are one pre-existing session-revocation gap
on `logout` that this branch should close for consistency, an email-normalization gap that the new
"create user / add member by email" flows make more visible, and a set of small correctness/test-quality
items. All five plan review-focus items are verified by tests I ran locally.

**Verified locally (evidence, not assertion):**

| Check | Result |
|:--|:--|
| `bun run lint` (3 packages, `--max-warnings=0`) | clean |
| `bun run type-check` (api + cli + web) | clean |
| `bun run test` — api unit (DB stopped) | **169 suites / 2044 tests pass** |
| `bun run test` — web | **102 suites / 1959 tests pass** |
| `bun run test` — cli | pass (turbo: 3/3 tasks successful) |
| `bun run test:integration` (PG16 on 5433) | **96 suites passed, 1 skipped; 1603 tests passed, 20 skipped** |
| Slice-4 integration suites re-run explicitly | 5 suites / 24 tests pass |
| `prisma migrate diff --from-migrations … --to-schema-datamodel … --exit-code` | **No difference detected** |

**Plan review-focus mapping (all confirmed):**

| # | Item | Test that pins it | Result |
|:--|:--|:--|:--|
| 1 | Demoted/disabled token 401 immediately, even with warm cache | `admin-users.integration.spec.ts:97-119` | pass |
| 2 | JWT for a no-longer-resolvable user is revoked | `jwt-auth.provider.spec.ts` ("treats a user that no longer exists as revoked") | pass |
| 3 | Legacy HTTP suites registering multiple users | `.env.test` `REGISTRATION_ENABLED=true`; full integration run | pass |
| 4 | Fresh-install `registration-status` reports `open: true` | `registration.integration.spec.ts:38-41` | pass |
| 5 | Two admins demoting each other leave exactly one | `admin-users.integration.spec.ts:126-142` | pass |

---

## Fixes applied (review follow-up, 2026-09-26)

All findings below were fixed in one follow-up commit on this branch.

| ID | Status | Change |
|:--|:--|:--|
| SEC-1 | **Fixed** | `AuthService.logout` now also evicts `userAuthStateCacheKey(userId)`. Pinned by a new integration test that warms the cache, logs out, then replays the old access token (401; 200 without the fix). |
| SEC-2 | **Fixed** | Emails are canonicalised to lower-case on register and admin create; `findUserByEmail`/`findUserIdByEmail` match case-insensitively; both create paths pre-check case-variant duplicates and return 409 (new `auth.409` message); a P2002 race still maps to 409. |
| BUG-1 | **Fixed** | `GET /projects/:slug/members` returns `canManage` (global ADMIN, or live project ADMIN role) with the page; the panel gates on that flag instead of scanning the loaded rows. `canManageMembers` helper removed. |
| BUG-2 | **Fixed** | `countProjectAdmins` counts members whose user is not disabled, and the guard skips a disabled admin as `losesAdmin`; `ProjectMemberRecord` carries `disabled`. |
| BUG-3 | **Fixed** | Non-assignable roles (legacy `AGENT`) render as a role label; only assignable roles get a `<select>`. |
| STYLE-1 | **Fixed** | Both module specs now import the real `UsersModule`/`ProjectMembersModule` with fake global `PrismaService`/`TRANSACTION_MANAGER` (and `CacheManager`), and assert controller/service/repository wiring. |
| ENH-1 | **Fixed** | `GET /auth/registration-status` is throttled at 30/min. |
| ENH-2 | **Fixed** | `@MaxLength(254)` added to `RegisterDto.email` and `CreateUserDto.email`; `openapi.json` regenerated (CLI output unchanged). |
| ENH-3 | **Fixed** | `useProjectMembers.reload()` refetches the current page; the panel uses it on a failed role change instead of resetting to page 1. |
| SEC-3 | **Fixed** | `UserResponseDto.from` maps an explicit field list, so `tokenVersion` (and any future extra column) is no longer serialized by `/auth/login`, `/auth/register` or `/auth/me`. |

**Re-verified after the fixes:** lint + type-check clean; API unit **169 suites / 2054 tests**;
web **102 suites / 1959 tests**; CLI green; full integration+e2e **96 suites / 1605 tests pass**
(1 skipped); targeted Slice-4 suites **5 / 26 pass**; `prisma migrate diff` **No difference detected**;
`openapi.json` diff is exactly the response description plus the two `maxLength: 254` additions.

**Deliberately not changed:** adding a disabled user to a project is still permitted (they hold no
authority until re-enabled, and an admin explicitly granted the role); the guard now correctly ignores
them. Existing mixed-case rows are still resolvable because lookups are case-insensitive — a data
migration to rewrite them is left as an optional follow-up.

---

## Findings

### 🔴 CRITICAL

None.

### 🟠 HIGH

None.

### 🟡 MEDIUM

#### SEC-1: `POST /auth/logout` does not actually evict the cached auth state under the configured cache strategy

**Severity:** MEDIUM (pre-existing on `main`, but this branch introduced the correct pattern one file away) | **Category:** Security / Session revocation

`app.module.ts:69-76` configures `CacheStrategy.MEMORY`. Under that strategy `@nathapp/nestjs-cache`
has no tag registry, so `invalidate(key, { mode: 'tag' })` degrades to a *prefix delete* of the
literal key (`cache-manager.js:302-320` → `invalidateWithDirect` → `cacheProvider.delByPattern`;
`pattern-match.utils.js:79-82` treats a glob-less pattern as a prefix). `AuthService.logout` only
does the tag invalidation:

```ts
// apps/api/src/auth/auth.service.ts:130-133
async logout(userId: string): Promise<void> {
  await this.authRepo.bumpTokenVersion(userId);
  await this.cache.invalidate(userTokenVersionCacheTag(userId), { mode: 'tag' });
}
```

The cache entry that `JwtAuthProvider` reads/writes is keyed `USER-AUTH-STATE:<id>`
(`token-version.cache.ts:7-9`), which never matches the `USER:<id>` prefix. Consequence: for up to
**60 s** after logout, a still-circulating access token keeps authenticating (`state.tokenVersion`
is stale, so `revoked` is false).

The branch is demonstrably aware of this exact trap: `users-admin.service.ts:67-71` additionally
evicts the direct key, with a comment explaining the MEMORY-strategy no-op. The same one-line fix
was not applied to `logout` (nor to the pre-existing tag call there).

**Risk:** Post-logout replay window for stolen access tokens; inconsistent with the branch's own
guarantee for disable/demote.
**Fix:**
```ts
await this.cache.invalidate(userTokenVersionCacheTag(userId), { mode: 'tag' });
await this.cache.invalidate(userAuthStateCacheKey(userId)); // MEMORY-strategy fallback
```
Add an integration assertion mirroring the disable test (`/auth/me` with a pre-logout token → 401).

#### SEC-2: Emails are stored and matched case-sensitively; the new admin/member flows surface it

**Severity:** MEDIUM | **Category:** Security / Data integrity

`User.email` is a plain `@unique` text column (`prisma/schema.prisma:24-38`), and nothing normalizes
case on write or read: `RegisterDto`/`CreateUserDto` store the raw value, `findUserByEmail`
(`prisma-auth.repository.ts:71-74`) and `findUserIdByEmail`
(`prisma-project-members.repository.ts:41-44`) compare exactly, and login is exact. Postgres btree
uniqueness is case-sensitive, so `alice@koda.test` and `Alice@koda.test` are two distinct accounts
with two different passwords.

**Risk:** Near-duplicate admin accounts (confusing for the last-admin guard and audit), and the new
"add member by email" flow can silently 404 a user whose email differs only in case, while the admin
list filter (`mode: 'insensitive'`) shows both rows. Not an account-takeover vector (login is
exact-case), but a real identity-integrity gap this slice's features make concrete.
**Fix:** normalize to lower-case in all write paths and lookups (and migrate existing rows), or make
uniqueness case-insensitive (`citext` / functional unique index).

### 🟢 LOW

#### BUG-1: `canManageMembers` hides all membership controls from a project ADMIN who is not on the loaded page

**Severity:** LOW | **Category:** Bug / UX

```ts
// apps/web/composables/useProjectMembers.ts:22-26
return members.some((m) => m.userId === user.id && m.role === 'ADMIN')
```

`ProjectMembersPanel.vue:18` derives `canManage` from the *currently loaded page* of members. The list
is ordered `joinedAt asc` with a default size of 20, so a project admin who joined late (beyond page 1)
sees no add/role/remove controls even though the API would authorize them. Global admins are unaffected.
**Fix:** have the API expose the capability (e.g. `canManage` on the page envelope) or probe the
caller's own membership role directly instead of scanning the visible page.

#### BUG-2: Project last-admin counts include disabled users, and disabled users can be added as project admins

**Severity:** LOW | **Category:** Bug / Consistency

`countProjectAdmins` counts every `role = 'ADMIN'` row
(`prisma-project-members.repository.ts:64-66`) with no join to `User.disabled`, unlike the global
guard's `countActiveAdmins` (`prisma-users.repository.ts:41-43`). A disabled project admin therefore
"satisfies" the last-admin check, letting the project end up with zero *active* admins. Additionally,
`add` looks users up by email with no disabled filter, so a disabled account can be granted project
ADMIN.
The spec's wording ("zero project `ADMIN` members") is literal here, so this is hardening rather than
a spec violation — but it is inconsistent with the global side of the same slice.
**Fix:** filter disabled users in `countProjectAdmins`/`add`, or document the choice explicitly.

#### BUG-3: Legacy `AGENT` project members render with an unselected/misleading role dropdown

**Severity:** LOW | **Category:** Bug / UI

`ProjectMemberDto` acknowledges legacy `AGENT` rows
(`project-member.dto.ts:12`; spec comment "legacy `AGENT` rows from seed data"), but the panel binds
`:value="member.role"` to a `<select>` whose options are only `ASSIGNABLE_MEMBER_ROLES`
(`ProjectMembersPanel.vue:80-87`). For an `AGENT` row the select has no matching option, so it renders
blank or falls back to the first option ("Admin") — misrepresenting the member's role.
**Fix:** render the read-only role label for non-assignable roles, or add a disabled `AGENT` option.

#### STYLE-1: The two new `*.module.spec.ts` files do not compile the modules they claim to cover

**Severity:** LOW | **Category:** Test quality / Conventions

`users.module.spec.ts` and `project-members.module.spec.ts` build a controller plus a stubbed service
and never import `UsersModule` / `ProjectMembersModule`. They therefore cannot catch broken imports,
missing providers or module-scope mistakes — the exact failures
`.nax/mono/apps/api/context.md` says these tests exist to catch ("compile the module with
`Test.createTestingModule({ imports: [FeatureModule] })`"). The slice-2 `outbox.module.spec.ts` in this
same branch shows the intended pattern (real module + fake `PrismaService`/`TRANSACTION_MANAGER`).
The weak shape matches the older `projects.module.spec.ts`, so it is a consistency issue, not a new
invention. `app.module.spec.ts` is likewise vacuous (pre-existing).

#### ENH-1: `GET /auth/registration-status` is public, unthrottled and hits the DB when the flag is off

`auth.controller.ts:39-47` + `auth.service.ts:68-71`: anonymous callers can drive a `user.findFirst`
per request. The query is trivial and the endpoint is genuinely needed pre-login, but it is the only
new unauthenticated DB-backed route without a `@Throttle`.
**Fix:** reuse the auth throttle (e.g. 30/min) or cache the `{ open }` answer briefly.

#### ENH-2: No length bound on email at write time

`CreateUserDto.email` (`create-user.dto.ts:6-9`) and `RegisterDto.email` have `@IsEmail` but no
`@MaxLength`, while the list filter bounds email at 254 (`list-users.query.ts:9`). `User.email` is
unbounded text. **Fix:** add `@MaxLength(254)` to both DTOs.

#### ENH-3: A failed member role change reloads page 1

`ProjectMembersPanel.vue:39-43` calls `run(load)` on failure, which resets the list to page 1 and
discards the operator's paging position. Minor; refetch the current page instead.

### Pre-existing (not introduced here, recorded for context)

- **SEC-3:** `UserResponseDto.from` spreads the whole domain object and strips only `passwordHash`
  (`auth-response.dto.ts:25-30`), so `/auth/login`, `/auth/register` and `/auth/me` serialize
  `tokenVersion` at runtime even though the DTO does not declare it. Internal revocation counter only;
  worth tightening while touching the DTO (this branch only added `disabled`).
- **`apps/web/pages/[project]/settings.vue:27`** captures `const slug = route.params.project` once;
  Nuxt re-keys the page on param changes (`generateRouteKey` interpolates params), so this is safe.

---

## By-Design / Known Residuals (acknowledged, not defects against this branch)

1. **CLI user commands need a user access token.** Agent keys never carry the global `ADMIN`
   authority (`AGENT_ROLES` = DEVELOPER/REVIEWER/VERIFIER/TRIAGER; `PermissionAuthGuard` compares
   string authorities exactly), so `koda user …` documents the `KODA_API_KEY=<token>` override and a
   `koda login --email` flow is explicitly out of scope. Verified against
   `agent-auth.provider.ts` and the permission provider source.
2. **Multi-instance cache invalidation is best-effort.** Under `MEMORY` cache an admin disable only
   evicts the instance that served the PATCH; another replica could honour a stale 60 s auth state.
   The deployment is a single composed service, and the Redis/tag path is already correct — fine for
   now, but a deployment-scaling constraint to remember.
3. **`GET /projects/:slug/tickets` membership enforcement (M5) and the remaining whole-repo review
   items are out of scope** per the plan; nothing in this slice makes them worse.
4. **#138 outbox retention (merged into this branch)** closes the slice-2 `PERF-1` follow-up:
   index-backed delete (`OutboxEvent_status_updatedAt_idx`), nightly `@Cron('0 4 * * *')`, kill
   switch, drift-checked migration, and a real-module DI test. No issues found.

---

## Positives worth recording

- **The advisory-lock design is correct and subtle in the right places.** Locks are taken inside
  `txManager.run`, the Prisma proxy (`patchWithTransactionProxy`) routes `prisma.client` to the
  transaction client, and each invariant has its own lock class/key (bootstrap vs administration vs
  per-project `hashtext`). The mutual-demotion integration test is exactly the right probe.
- **Cache invalidation after commit covers both strategies** for the admin path: tag mode for Redis,
  direct key for MEMORY (`users-admin.service.ts:67-71`) — with a comment that explains why.
- **Session kill is pinned end-to-end**, including the warm-cache case (call `/auth/me` first) that
  the naive DB-check implementation would miss.
- **Registration semantics are right**: fail-closed fast path avoids paying bcrypt, the in-transaction
  locked check stays authoritative for the empty-table race, and `open = flag || empty-table` keeps a
  fresh install bootstrappable.
- **Testing discipline**: 5 DB-backed integration suites, unit tests for the new guards/exception
  helpers, non-empty en/zh parity test for every new locale subtree, and a `migrate diff` clean tree.
- **Conventions**: no `console.log`, no `process.env` outside config/test files, no new `any` in
  production code, nested i18n prefixes resolve correctly (`users.self.40003`, `members.lastAdmin.409`),
  DTOs reuse `KODA_PAGE_QUERY`/`parseQuery`/`toPageResult` and the regenerated OpenAPI/CLI client
  matches (`AdminUsersController_*`, `ProjectMembersController_*`, `AuthController_registrationStatus`).
- **The outbox-retention commit (#138)** is a clean close-out of the previous review's follow-up.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:--|:--|:--|:--|
| P0 | SEC-1 | XS | Also evict `userAuthStateCacheKey(userId)` in `AuthService.logout`; add a pre-logout-token integration test |
| P1 | SEC-2 | M | Normalize email (lowercase) on write/lookup, or make uniqueness case-insensitive |
| P2 | BUG-1 | S | Stop deriving `canManage` from the loaded members page |
| P3 | BUG-2 | S | Exclude disabled users from project-admin counting/adding (or document) |
| P4 | STYLE-1 | S | Compile the real `UsersModule`/`ProjectMembersModule` in their DI specs (fake Prisma/tx) |
| P5 | BUG-3 | XS | Render legacy `AGENT` member roles as a label |
| P6 | ENH-1/2/3 | XS each | Throttle the registration probe; bound email length; keep paging on failed role change |

---

## Verification appendix

- Evidence gathered from source, installed `@nathapp/*` package code (`nestjs-cache` manager,
  `nestjs-auth` guards/providers, `nestjs-prisma` transaction proxy), and live runs — not inferred.
- The `MEMORY`-strategy tag no-op was confirmed by reading
  `nestjs-cache/dist/service/cache-manager.js` (`invalidate` → `invalidateWithDirect`),
  `utils/pattern-match.utils.js` (`delByPattern` prefix semantics) and `app.module.ts` (MEMORY).
- Every cited path was checked against the repository index and re-read from source where needed.
- Commands were run from the branch head `156b754a`; test Postgres was started with
  `bun run test:db:up` and left running.
- No push, PR, or deployment was performed.
