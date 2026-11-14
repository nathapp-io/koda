# SPEC: Auth sessions (one-time refresh tokens with reuse detection, per-session logout, invite email after commit)

## Summary

Feature 1 of the P1 auth bundle from the 2026-11-14 whole-repo review (`docs/20261114-review-whole-repo.md`, gap rows 5 and 6; ruling 12 decided by the owner on 2026-11-14). A follow-up feature, `auth-passwords` (password change and reset), builds on the session API added here.

1. **Sessions and one-time refresh tokens.** Each login, registration or invite acceptance starts an `AuthSession`, and each refresh token is one `RefreshToken` row. A refresh rotates the token. Presenting an already-used token after a 30-second grace window revokes the whole session (reuse detection).
2. **Per-session logout.** Access tokens carry the session id, and logout revokes only the current session, so the user's other devices stay signed in.
3. **Invite email after commit.** On the approval (deferred) path, the invite email is sent only after the approval transaction commits, so a rollback never leaves a sent link for an invite that does not exist.

## Motivation

- **SEC-8 (review A, LOW, open since 11-01):** `AuthService.refresh` (`apps/api/src/auth/auth.service.ts`) mints a new pair from any unexpired refresh token. A stolen refresh token stays usable for its whole 7-day life, and nothing detects a second use.
- **Logout kills every session:** `AuthService.logout` bumps `User.tokenVersion`, which revokes all of the user's sessions on every device.
- **A/BUG-1 remainder (MEDIUM, partial):** `ProjectInvitesService` sends the invite email synchronously. On the deferred path that runs inside `ApprovalExecutionService`'s transaction. A rollback leaves a sent link for an invite that was never stored, and a retry sends a second email.
- **Owner ruling 12 (2026-11-14):** one-time refresh with reuse detection, replacing the `tokenVersion`-only model.

## Design

### Session model

Two new Prisma models in `apps/api/prisma/schema.prisma`, created by migration `20261210090000_auth_sessions`:

```prisma
model AuthSession {
  id            String         @id            // randomUUID() from node:crypto, set by the service
  userId        String
  user          User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  createdAt     DateTime       @default(now())
  expiresAt     DateTime                      // the exp of the newest refresh token (sliding)
  revokedAt     DateTime?
  revokedReason String?                       // logout | reuse | password-change | password-reset
  tokens        RefreshToken[]

  @@index([userId])
}

model RefreshToken {
  id        String      @id                    // the refresh JWT's jti, randomUUID()
  sessionId String
  session   AuthSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  createdAt DateTime    @default(now())
  usedAt    DateTime?

  @@index([sessionId])
}
```

`User` gains the back-relation `authSessions AuthSession[]`. The `password-change` and `password-reset` reasons are written by the follow-up `auth-passwords` feature; this feature writes `logout` and `reuse`.


**Module.** A leaf `AuthSessionsModule` (`apps/api/src/auth/sessions/auth-sessions.module.ts`) imports `PrismaModule` and provides three things: the module-private `PrismaAuthSessionRepository` (extends `AbstractPrismaRepository`), its private `AUTH_SESSION_REPOSITORY` token, and `AuthSessionService`. It exports `AuthSessionService` only. `AuthModule` imports it in two places: in its own `imports`, and in the `imports` of `NathappAuthModule.forRootAsync(...)`. The second is needed because `JwtAuthProvider` is instantiated inside that submodule, which sees only providers from its own `imports`; `AuthRepositoryModule` exists for the same reason. `AuthModule` re-exports `AuthSessionsModule` for the follow-up feature.

**Service.** `AuthSessionService` (`apps/api/src/auth/sessions/auth-session.service.ts`):

```typescript
export const REFRESH_REUSE_GRACE_MS = 30_000;

export type SessionRevokeReason = 'logout' | 'reuse' | 'password-change' | 'password-reset';

export type RotateOutcome =
  | { kind: 'rotated' }
  | { kind: 'reused'; userId: string }
  | { kind: 'invalid' };

export class AuthSessionService {
  start(input: { userId: string; sessionId: string; tokenId: string; expiresAt: Date }): Promise<void>;
  rotate(input: {
    sessionId: string; presentedTokenId: string; nextTokenId: string; nextExpiresAt: Date; now: Date;
  }): Promise<RotateOutcome>;
  /** Revokes one session if it belongs to userId and is not yet revoked; false otherwise. */
  revoke(sessionId: string, userId: string, reason: SessionRevokeReason, now: Date): Promise<boolean>;
  isActive(sessionId: string, now: Date): Promise<boolean>;
}
```

**Audit coverage.** `start` and `rotate` write rows that no audit entry covers. Each runs its writes inside `bookkeeping(...)` from `src/action-context/audit-coverage.ts`, so the request write guard (`assertAuditCoverage`, which throws in test mode) accepts login and refresh. Two new reasons are added to `BOOKKEEPING_REASONS` in `src/action-context/audit-coverage.reasons.ts`:
- `'auth.session-start'`: "The session and first refresh token rows that a login, registration or invite acceptance writes; registration and invite acceptance record their own entries."
- `'auth.session-rotate'`: "A refresh token rotation: the used mark, the next token, the sliding expiry and the cleanup of old used tokens; a reuse revocation records `session.refresh` itself."

`revoke` has no bookkeeping wrapper; its caller records an entry in the same transaction.

**JWT claims.** The refresh JWT payload becomes `{ sub, tokenVersion, sid, jti }`, and the access JWT payload becomes `{ sub, email, role, tokenVersion, sid }`. `sid` is the `AuthSession.id`, and `jti` is the `RefreshToken.id`. The ids are generated with `randomUUID()` before signing, so the rows can be inserted with the ids the tokens carry.

**Session start.** `AuthService.issueSession(user)` (used by register, login and invite acceptance) generates `sid` and `jti`, signs both tokens, and calls `AuthSessionService.start({ userId, sessionId: sid, tokenId: jti, expiresAt })`, where `expiresAt` is the `exp` claim of the signed refresh token, read by decoding the token's payload segment (`JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())`; the token was just signed by this service, so no verification is needed). The response shape (`AuthResponseDto`) is unchanged. Until US-004 lands, `AuthService.refresh` keeps calling `issueSession`, so each refresh starts a new session; US-004 replaces that with rotation.

**Rotation.** `AuthService.refresh(principal)` reads `sessionId` and `tokenId` from the refresh principal's `extra`. It generates the next `jti`, signs the next pair, and calls `AuthSessionService.rotate({ sessionId, presentedTokenId, nextTokenId, nextExpiresAt, now })`. The rotate steps run in one transaction (`txManager.run` in the service), each step a method of `PrismaAuthSessionRepository` on the transaction client, so no Prisma call leaves the repository. The steps, in order:

1. **Slide the session, conditionally** (repository `slideExpiry`): one conditional update of the session row where `revokedAt` is null and `expiresAt > now`, setting `expiresAt = nextExpiresAt`. Count 0 (missing, revoked or expired) → `{ kind: 'invalid' }`, with nothing else written. The conditional update is what makes rotation safe against a concurrent logout: Postgres serialises the two updates on the session row, so a rotation can never commit a token for a session a logout already revoked.
2. **Mark the presented token used, atomically** (repository `markUsed`): one conditional update of the token row where `id = presentedTokenId`, `sessionId` matches and `usedAt` is null, setting `usedAt = now`; it answers the affected count.
3. **Count 1 (the token was unused):** insert the next token, then delete the session's tokens whose `usedAt` is before `now - REFRESH_REUSE_GRACE_MS`, and return `{ kind: 'rotated' }`. Unused tokens are never deleted, so a sibling issued by a concurrent refresh (step 4) stays valid.
4. **Count 0, and the presented token exists with `usedAt >= now - REFRESH_REUSE_GRACE_MS`:** a concurrent refresh from the same browser. Insert the next token and return `{ kind: 'rotated' }`; the session is not revoked. Both responses carry a valid refresh token, so whichever one the browser cookie ends up holding keeps working.
5. **Otherwise** (the token was used before the grace window, or the `jti` has no row) → set `revokedAt = now` and `revokedReason = 'reuse'` on the session, and return `{ kind: 'reused', userId }`. The `reused` branch returns normally (it does not throw), so the revocation commits.

The race between a rotation and a logout of the same session is not tested concurrently; US-001 AC-10 (a revoked session answers `invalid`) and US-004 AC-13 (refresh after logout answers 401) pin the predicate the conditional slide relies on.

The grace window exists because the web client refreshes in parallel: several requests that get a 401 at once each call `/api/auth/refresh` (`apps/web/composables/useApi.ts`, one retry per request), and two tabs share one cookie. Without the window, a normal page load would log the user out.

**Reuse handling in `refresh`.** On `reused`, `refresh`:
1. evicts `authSessionCacheKey(sessionId)`, so the stolen session's access tokens stop working at once;
2. records `{ key: 'session.refresh', resourceType: 'user', resourceId: <userId>, projectId: null, summary: 'refresh token reuse; session revoked' }` through `this.audit.audited` (or `txManager.run` around `audit.record`), because `AuditRecorder.record` must run inside a transaction and `rotate` has already committed. A failure here is logged with `Logger.warn` and does not change the outcome;
3. throws `AuthException({}, 'auth')` (401).

On `invalid`, it throws `AuthException({}, 'auth')` with no audit entry. The checks `refresh` already does, `principal.revoked` and then the user lookup that refuses missing and disabled users, run first and are unchanged.

**Legacy tokens.** A refresh token without a `sid` or `jti` claim (issued before this feature) is refused with 401 before any write, so every user logs in once after the deploy. An access token without `sid` stays valid until it expires (15 minutes) and is checked by `tokenVersion` only, as today.

**Refresh principal.** `KodaJwtRefreshStrategyProvider.validate` copies the `sid` and `jti` claims onto the principal as `extra: { sessionId, tokenId }`. When either claim is absent, `extra` carries neither key. Its `tokenVersion` and `disabled` checks are unchanged.

**Session check on access tokens.** `JwtAuthProvider.getPrincipal` copies `sid` onto the principal as `sessionId` (`sid` joins the claim allow-list in its SECURITY note). When `sid` is present, the principal is `revoked` if the session is not active. The answer comes from `AuthSessionService.isActive(sid, now)` and is cached 60 seconds as the object `{ active: boolean }`; an object, not a bare boolean, so a cached `false` is never read as a miss. The cache key is `authSessionCacheKey(sid)`, a new helper in `token-version.cache.ts` returning `['auth-session', sid]`. Every revoke in this feature evicts that key by direct key. Tag eviction is not enough, because the MEMORY cache strategy has no tag registry (see the note in `AuthService.logout`).

**Logout.** `AuthService.logout(userId, sessionId?)`:
- **With a `sessionId`:** runs `AuthSessionService.revoke(sessionId, userId, 'logout', now)` inside the existing `this.audit.audited(...)` call, so the revoke and the `session.logout` entry commit or roll back together. The entry is recorded whether `revoke` returned true or false (logging out an already-ended session answers 200). It then evicts `authSessionCacheKey(sessionId)`. `tokenVersion` is not bumped.
- **Without a `sessionId`** (a legacy access token, or an agent principal): bumps `tokenVersion` and evicts the user's caches, exactly as today.

The logout route's `@ApiOperation` summary becomes "Revoke the current session (all sessions for a token issued before sessions)"; after that change run `bun run generate` from the repo root so `openapi.json` and the CLI client stay current. `AuthController.logout` types its principal as `KodaPrincipal` (per `.nax/rules/api-core.md`) and calls `authService.logout(user.id, isUserPrincipal(user) ? user.sessionId : undefined)`.

**Unchanged all-session levers.** Admin disable and Owner binding changes still bump `tokenVersion`, and the refresh strategy and `UserAuthState` still refuse on it, so those levers still end every session.

### Invite email after commit

In `ProjectInvitesService` (`apps/api/src/projects/invites/project-invites.service.ts`), `create` (its new-address path, `inviteNewAddress`) and `resend` hand the email send to `AfterCommitService.defer`. This mirrors `TicketTransitionsService`: `if (!this.afterCommit.defer(task)) await task()`. `AfterCommitService` is exported by `PermissionsModule`, and the constructor gains `private readonly afterCommit: AfterCommitService` as its last parameter.

- **`defer` returns true:** an approval execution owns the transaction (`ApprovalExecutionService` wraps it in `afterCommit.scope`). The send runs after that transaction commits, a rollback drops it, and the result reports `emailed: false`.
- **`defer` returns false:** the immediate route path, where `ApprovalGateService.gate` calls `command.execute` with no scope open. The send is awaited inline as today, and `emailed` reports its outcome.

### Integration

Symbols this feature reads (verified on `main` @ `ef8bc6e9`):

- `PrismaAuthRepository.findUserById(id)` and `bumpTokenVersion(userId): Promise<number>`, in `apps/api/src/auth/prisma-auth.repository.ts`.
- `userAuthStateCacheKey(userId)` and `userTokenVersionCacheTag(userId)`, in `apps/api/src/auth/token-version.cache.ts`.
- `CacheManager.get(key, loader, ttlMs, opts)` and `invalidate(...)`, as already used in `jwt-auth.provider.ts` and `AuthService.logout`.
- `bookkeeping(reason, fn)` and `BOOKKEEPING_REASONS`, in `apps/api/src/action-context/audit-coverage.ts` and `audit-coverage.reasons.ts`.
- `AfterCommitService.scope(fn)` and `defer(task): boolean`, in `apps/api/src/permissions/after-commit.service.ts`.
- `AuditRecorder.record(entry)` and `audited(fn, entryOf)`, in `apps/api/src/audit/audit-recorder.service.ts`.
- `InviteMailer.sendInvite(input): Promise<boolean>`, in `apps/api/src/projects/invites/invite-mailer.ts`.
- `isUserPrincipal(principal)`, in `apps/api/src/auth/principal/koda-principal.types.ts`.
- `JwtRefreshStrategyProvider.sign(payload)` from `@nathapp/nestjs-auth`, which also stamps `typ: 'refresh'`.

Symbols this feature changes. Each **Baseline** exists only to locate the current code and is never the interface to implement; build the **Target**.

- `JwtPayload` (`auth.service.ts`)
  - Baseline: `{ sub: string; email: string; role: string; tokenVersion: number }`.
  - Target: adds `sid: string`.
- `AuthService.refresh(principal)`
  - Baseline: refuses `principal.revoked`, then `issueSession(user)`.
  - Target (US-004): refuses `principal.revoked` and principals without `extra.sessionId`/`extra.tokenId`, then rotates through `AuthSessionService.rotate` and answers an `AuthResponseDto` built from the rotated ids.
- `AuthService.issueSession(user)`
  - Baseline: signs two tokens, starts nothing.
  - Target: also starts an `AuthSession` with one `RefreshToken`; the response shape is unchanged.
- `AuthService.logout`
  - Baseline: `logout(userId: string)` bumps `tokenVersion`.
  - Target: `logout(userId: string, sessionId?: string)`.
- `AuthService.generateAccessToken` and `generateRefreshToken`
  - Baseline: `generateAccessToken(userId, email, role, tokenVersion)` and `generateRefreshToken(userId, tokenVersion)`.
  - Target: `generateAccessToken(userId, email, role, tokenVersion, sessionId)` and `generateRefreshToken(userId, tokenVersion, sessionId, tokenId)`.
- `KodaJwtRefreshStrategyProvider.validate`
  - Baseline: a principal `{ id, revoked, hashToken, ... }`.
  - Target: also `extra: { sessionId, tokenId }` when the claims are present.
- `JwtAuthProvider.getPrincipal`
  - Baseline: `revoked` from `UserAuthState` only.
  - Target: also `revoked` when `sid` is present and the session is not active; the principal carries `sessionId`.
- `UserPrincipal` (`auth/principal/koda-principal.types.ts`): Target adds `readonly sessionId?: string`.
- `AuthController.logout`
  - Baseline: `logout(@Principal() user: IPrincipal)` calling `authService.logout(user.id)`.
  - Target: `logout(@Principal() user: KodaPrincipal)` calling `authService.logout(user.id, isUserPrincipal(user) ? user.sessionId : undefined)`.
- `AuthModule` (`auth.module.ts`): Target imports `AuthSessionsModule` in its own `imports` and in `NathappAuthModule.forRootAsync({ imports })`.
- `ProjectInvitesService` constructor: Target adds `afterCommit: AfterCommitService` as its last parameter.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| Refresh token without `sid` or `jti` | 401 `auth`; no row written |
| Refresh for a revoked, expired or unknown session | 401 `auth`; no audit entry |
| Used refresh token presented within 30 s of its use | rotates again; session stays active |
| Used refresh token presented after 30 s, or an unknown `jti` for a live session | session revoked (`reuse`), its cache key evicted, audit `session.refresh`, 401 `auth` |
| The reuse audit entry fails to record | logged with `Logger.warn`; still 401 |
| A rotation racing a logout of the same session | the conditional slide in step 1 serialises them; no token is issued for a revoked session |
| Access token whose session is revoked | principal `revoked`, 401 on any authenticated route |
| Logout naming a session of another user | nothing revoked, `tokenVersion` not bumped, `session.logout` still recorded |
| The `session.logout` audit entry fails to record | the session revoke rolls back with it (one `audited` transaction) |
| Approval transaction rolls back after `ProjectInvitesService.create` ran | no invite email is sent |

## Out of Scope

- Self-service password change and password reset; they are the follow-up feature `auth-passwords`, which adds `AuthSessionService.revokeAllForUser` on top of this feature's store.
- A "log out of all devices" control and a list of active sessions per user; logout revokes the current session only.
- Purging expired or revoked `AuthSession` rows and abandoned unused sibling tokens; rotation deletes used tokens older than the grace window, so rows per live session stay at one unused token per chain plus tokens used in the last 30 seconds.
- Detecting a stolen refresh token that is replayed within 30 seconds of the owner's own use of it; inside the grace window a replay rotates into a second chain of the same session instead of revoking it. This is the accepted cost of the grace window that parallel web refreshes need.
- Accepting a refresh token issued before this feature; such tokens answer 401 and the user logs in once after the deploy.
- Refresh concurrency across API replicas; the API is single-replica by ruling, and the conditional updates cover concurrent refreshes and logouts in one database.
- Changing the CLI, which authenticates with agent API keys and never uses refresh tokens.
- Changing the web app; the Nuxt auth routes forward tokens opaquely and keep working with the new claims.
- Changing the `emailed` field's API description or the web invite panel's `notEmailed` copy; an approved (deferred) invite now reports `emailed: false` and the panel shows its not-emailed text, while the email itself goes out after commit.
- The web `/api/auth/me` outage handling (review D/BUG-6 residual) and the expired-cookie e2e; they are a separate bundle.

## Stories

**US-001: Session store.** Workdir: `apps/api`. No dependencies.
Adds the `AuthSession` and `RefreshToken` models and migration, the leaf `AuthSessionsModule`, the module-private `PrismaAuthSessionRepository`, and `AuthSessionService.start` and `rotate` (conditional slide, one-time tokens, the 30-second grace window, reuse revocation, cleanup of old used tokens), with the `auth.session-start` and `auth.session-rotate` bookkeeping reasons. No route changes.

**US-002: Session issuance.** Workdir: `apps/api`. Depends on US-001.
`AuthModule` imports `AuthSessionsModule` (its own imports and the `forRootAsync` imports). `issueSession` starts a session and signs `sid` into both tokens and `jti` into the refresh token, for login, registration and invite acceptance. `KodaJwtRefreshStrategyProvider` carries `extra.sessionId`/`extra.tokenId`. `refresh` keeps its current path until US-004.

**US-003: Session-scoped access tokens and per-session logout.** Workdir: `apps/api`. Depends on US-002.
Adds `AuthSessionService.revoke` and `isActive`, the `authSessionCacheKey` helper, the session check and `sessionId` in `JwtAuthProvider`, `UserPrincipal.sessionId`, and per-session `logout` inside one `audited` transaction.

**US-004: Refresh rotation with reuse detection.** Workdir: `apps/api`. Depends on US-003.
`AuthService.refresh` rotates through `AuthSessionService.rotate`, evicts the session cache key and audits on reuse, and refuses legacy tokens.

**US-005: Invite email after commit.** Workdir: `apps/api`. No dependencies.
`ProjectInvitesService.create` (new-address path) and `resend` defer the send through `AfterCommitService` when an approval transaction owns the call.

### Context Files

**US-001**
- `apps/api/prisma/schema.prisma` — the `User` model the new models relate to.
- `apps/api/src/auth/auth-repository.module.ts` — the leaf-module pattern for the nestjs-auth submodule.
- `apps/api/src/action-context/audit-coverage.ts` — `bookkeeping`.
- `apps/api/src/action-context/audit-coverage.reasons.ts` — `BOOKKEEPING_REASONS`.
- `apps/api/src/memory/memory.module.ts` — the module-private repository token pattern.

**US-002**
- `apps/api/src/auth/auth.service.ts` — `issueSession` and the token generators.
- `apps/api/src/auth/auth.module.ts` — `NathappAuthModule.forRootAsync` imports.
- `apps/api/src/auth/koda-jwt-refresh-strategy.provider.ts` — where `sid`/`jti` reach the refresh principal.
- `apps/api/src/projects/invites/invite-acceptance.service.ts` — the third `issueSession` caller.
- `apps/api/src/auth/sessions/auth-session.service.ts` — created by US-001, consumed here.

**US-003**
- `apps/api/src/auth/jwt-auth.provider.ts` — the claim allow-list and the cached `UserAuthState` check to mirror.
- `apps/api/src/auth/token-version.cache.ts` — cache key helpers.
- `apps/api/src/auth/auth.controller.ts` — the logout route.
- `apps/api/src/auth/principal/koda-principal.types.ts` — `UserPrincipal` and `isUserPrincipal`.
- `apps/api/src/auth/sessions/auth-session.service.ts` — created by US-001, extended here.

**US-004**
- `apps/api/src/auth/auth.service.ts` — `refresh`.
- `apps/api/src/audit/audit-recorder.service.ts` — `audited` and the transaction requirement of `record`.
- `apps/api/src/auth/sessions/auth-session.service.ts` — created by US-001; `rotate`.
- `apps/api/src/auth/token-version.cache.ts` — `authSessionCacheKey`, created by US-003.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the refresh and logout lifecycle steps.

**US-005**
- `apps/api/src/projects/invites/project-invites.service.ts` — `inviteNewAddress`, `resend`, `sendInvite`.
- `apps/api/src/permissions/after-commit.service.ts` — `defer`.
- `apps/api/src/tickets/state-machine/ticket-transitions.service.ts` — the `if (!this.afterCommit.defer(task)) await task()` pattern to mirror.
- `apps/api/src/approvals/approval-execution.service.ts` — the scope that owns the deferred path.
- `apps/api/test/integration/email/email-dispatcher.integration.spec.ts` — the email-on fixture (`SMTP_URL` set before boot, `NOTIFY_SERVICE.send` stubbed).

### Creates

**US-001**
- `apps/api/src/auth/sessions/auth-sessions.module.ts`
- `apps/api/src/auth/sessions/auth-session.service.ts`
- `apps/api/src/auth/sessions/prisma-auth-session.repository.ts`
- `apps/api/src/auth/sessions/auth-session.domain.ts`
- `apps/api/prisma/migrations/20261210090000_auth_sessions/migration.sql`

### Modifies

**US-001**
- `apps/api/src/action-context/audit-coverage.bookkeeping.spec.ts` — `EXPECTED_REASON_IDS` is compared with `BOOKKEEPING_REASONS` for equality; it gains `auth.session-start` and `auth.session-rotate`.

**US-002**
- `apps/api/src/auth/auth.service.spec.ts` — three groups of cases change. The `issueSession` cases assert the response only; `issueSession` now also calls `AuthSessionService.start`, so they gain an `AuthSessionService` mock. The "JWT token generation" cases call `generateAccessToken`/`generateRefreshToken` with the old arities and assert exact `sign` payloads; they now pass `sessionId` (and `tokenId`) and expect the payloads to carry `sid` (and `jti`). The `beforeEach` refresh `sign` mock returns `'mock-token'`, which cannot be decoded for its `exp`; it now returns a decodable JWT string (a base64url header, a payload with `exp`, and a signature segment).
- `apps/api/src/auth/koda-jwt-refresh-strategy.provider.spec.ts` — the principal-shape assertion pins the returned principal; it now also carries `extra: { sessionId, tokenId }` when the payload has `sid`/`jti`.

**US-003**
- `apps/api/src/auth/jwt-auth.provider.spec.ts` — the principal assertions pin the returned object; the principal now also carries `sessionId` when the payload has `sid`, and `revoked` also reflects `AuthSessionService.isActive`, so the provider gains an `AuthSessionService` mock.
- `apps/api/src/auth/auth.controller.spec.ts` — the logout case expects `authService.logout` called with the user id only; it is now called with the user id and the principal's `sessionId`.
- `apps/api/src/auth/auth.service.spec.ts` — the `logout` cases expect `bumpTokenVersion`; with a `sessionId` logout revokes that session inside `audited` and does not bump, and the no-`sessionId` case keeps the bump.
- `openapi.json` — regenerated by `bun run generate` after the logout summary changes.
- `apps/cli/src/generated/sdk.gen.ts` — regenerated by `bun run generate` with the new logout summary; never edited by hand.
- `apps/api/test/integration/audit/audit-logout.integration.spec.ts` — its rollback case asserts `tokenVersion` unchanged and a 500 when the audit record rejects; with a session-carrying access token the write is now the session revoke, so the case asserts the session's `revokedAt` stays null instead, and the success case keeps its `session.logout` assertion.

**US-004**
- `apps/api/src/auth/auth.service.spec.ts` — the `refresh` cases expect a new pair from any non-revoked principal via `issueSession`; refresh now requires `extra.sessionId`/`extra.tokenId` and goes through `AuthSessionService.rotate`, so the cases gain a `rotate` mock per outcome.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the endpoint e2e rule requires the reuse-after-grace 401 case for the refresh route here, and the comment before the post-logout refresh ("signed with a stale tokenVersion") is rewritten: the refusal now comes from the revoked session.

**US-005**
- `apps/api/src/projects/invites/project-invites.service.spec.ts` — the service is constructed with its current dependencies; it gains the `AfterCommitService` argument (a real `new AfterCommitService()`), and the existing `emailed` expectations on the immediate path stay.

### Seams

- US-001 creates `AuthSessionService.start`; US-002 drives it from `POST /api/auth/login` (US-002 AC-1).
- US-001 creates `AuthSessionsModule`; US-002 imports it into the `forRootAsync` submodule and US-003's `JwtAuthProvider` injects its service, proven by the app booting in every integration AC of US-003.
- US-003 creates `AuthSessionService.revoke` and `isActive` and drives them from `POST /api/auth/logout` and `JwtAuthProvider.getPrincipal` (US-003 AC-2, AC-6).
- US-001 creates `AuthSessionService.rotate`; US-004 drives it from `POST /api/auth/refresh` (US-004 AC-1).
- US-003 creates `authSessionCacheKey`; US-004 evicts it on reuse, proven through `GET /api/auth/me` after a warm call (US-004 AC-7).

## Acceptance Criteria

### US-001

- AC-1 [integration] `AuthSessionService.start({ userId, sessionId: 's1', tokenId: 't1', expiresAt })` inserts an `AuthSession` row `s1` with that `userId` and `expiresAt`, holding exactly one `RefreshToken` row `t1`.
- AC-2 [integration] `AuthSessionService.rotate({ sessionId: 's1', presentedTokenId: 't1', nextTokenId: 't2', nextExpiresAt, now })` with `t1` unused returns `{ kind: 'rotated' }`.
- AC-3 [integration] After that rotation, the `RefreshToken` row `t1` has `usedAt` equal to `now`.
- AC-4 [integration] After that rotation, the session's `expiresAt` equals `nextExpiresAt`.
- AC-5 [integration] After three successive rotations of one session, each `now` 31 seconds after the previous one, the session holds exactly two `RefreshToken` rows: the last presented token and the newest token.
- AC-6 [integration] `rotate` with a presented token whose `usedAt` is exactly `REFRESH_REUSE_GRACE_MS` (30 000 ms) before `now` returns `{ kind: 'rotated' }` and the session's `revokedAt` stays null.
- AC-7 [integration] `rotate` with a presented token whose `usedAt` is 31 seconds before `now` returns `{ kind: 'reused', userId }` with the session owner's id.
- AC-8 [integration] After that reuse, the session has `revokedAt` equal to `now` and `revokedReason` `'reuse'`.
- AC-9 [integration] `rotate` with a `presentedTokenId` that has no row returns `{ kind: 'reused', userId }` for an active session.
- AC-10 [integration] `rotate` on a session whose `revokedAt` is set returns `{ kind: 'invalid' }` and inserts no `RefreshToken` row.
- AC-11 [integration] `rotate` on a session whose `expiresAt` is at or before `now` returns `{ kind: 'invalid' }`.
- AC-12 [integration] Two `rotate` calls started together for one session with the same unused `presentedTokenId` (`t1`) and different `nextTokenId`s (`t2`, `t3`) both return `{ kind: 'rotated' }`.
- AC-13 [integration] After those two concurrent rotations, a later `rotate` presenting `t2` and another presenting `t3` each return `{ kind: 'rotated' }`.
- AC-14 [unit] `BOOKKEEPING_REASONS` has the keys `auth.session-start` and `auth.session-rotate`, each with a non-empty sentence.

**Out of scope:** concurrency across API replicas, and replay inside the grace window (feature Out of Scope).

### US-002

- AC-1 [integration] `POST /api/auth/login` with valid credentials answers 200 and creates exactly one `AuthSession` row for the user.
- AC-2 [integration] The refresh JWT returned by that login carries a `sid` claim equal to the new `AuthSession.id`.
- AC-3 [integration] The refresh JWT returned by that login carries a `jti` claim equal to the id of the session's only `RefreshToken` row.
- AC-4 [integration] The access JWT returned by that login carries a `sid` claim equal to the new `AuthSession.id`.
- AC-5 [integration] The new `AuthSession.expiresAt` equals the `exp` claim of the returned refresh JWT, to the second.
- AC-6 [integration] `POST /api/auth/register` for the first user creates exactly one `AuthSession` row for that user.
- AC-7 [integration] Accepting an invite through `POST /api/invites/:token/accept` creates exactly one `AuthSession` row for the new user.
- AC-8 [unit] `KodaJwtRefreshStrategyProvider.validate` with a payload carrying `sid: 's1'` and `jti: 't1'` returns a principal whose `extra` is `{ sessionId: 's1', tokenId: 't1' }`.
- AC-9 [unit] `KodaJwtRefreshStrategyProvider.validate` with a payload carrying neither `sid` nor `jti` returns a principal whose `extra` has no `sessionId` and no `tokenId`.
- AC-10 [unit] `Test.createTestingModule({ imports: [AuthSessionsModule] })`, with `PrismaService` and `TRANSACTION_MANAGER` provided as mocks, compiles and resolves `AuthSessionService`.

### US-003

- AC-1 [unit] `JwtAuthProvider.getPrincipal` with a payload carrying `sid: 's1'` returns a principal with `sessionId: 's1'`.
- AC-2 [unit] `JwtAuthProvider.getPrincipal` with `sid: 's1'` and `AuthSessionService.isActive` stubbed to resolve false returns a principal with `revoked: true`, and the stub was called with `'s1'`.
- AC-3 [unit] `JwtAuthProvider.getPrincipal` with a payload carrying no `sid` never calls `AuthSessionService.isActive`.
- AC-4 [unit] Two `getPrincipal` calls for the same `sid` within 60 seconds, with `isActive` resolving false, call `AuthSessionService.isActive` once and both return `revoked: true`.
- AC-5 [integration] `AuthSessionService.isActive('s1', now)` returns false after `revoke('s1', <owner>, 'logout', now)` returned true.
- AC-6 [integration] After `GET /api/auth/me` answered 200 with a session's access token, `POST /api/auth/logout` with that token sets the session's `revokedReason` to `'logout'`.
- AC-7 [integration] That logout leaves `User.tokenVersion` unchanged.
- AC-8 [integration] After that logout, `GET /api/auth/me` with the same access token answers 401.
- AC-9 [integration] After that logout, a second session of the same user (from a second login) still answers 200 on `GET /api/auth/me`.
- AC-10 [integration] `AuthSessionService.revoke('s1', 'u2', 'logout', now)` for a session owned by `u1` returns false and leaves `s1` with `revokedAt` null.
- AC-11 [integration] When the `session.logout` audit record rejects during `POST /api/auth/logout` with a session-carrying token, the response is 500 and the session's `revokedAt` stays null.
- AC-12 [unit] `AuthService.logout('u1')` with no `sessionId` calls `PrismaAuthRepository.bumpTokenVersion('u1')` and calls no `AuthSessionService` method.
- AC-13 [unit] `AuthService.logout('u1', 's1')` with `AuthSessionService.revoke` resolving false still records the `session.logout` entry and does not call `bumpTokenVersion`.

### US-004

- AC-1 [integration] `POST /api/auth/refresh` with the login's refresh token answers 200 with a refresh JWT whose `jti` differs from the presented one.
- AC-2 [integration] That refresh leaves the user with exactly one `AuthSession` row (rotation does not start a new session).
- AC-3 [integration] After that refresh, the presented token's `RefreshToken` row has `usedAt` set.
- AC-4 [integration] After the presented token's `usedAt` is set 31 seconds in the past, presenting it again to `POST /api/auth/refresh` answers 401.
- AC-5 [integration] After that reuse, an `AuditEntry` exists with key `session.refresh`, `resourceId` the user's id and summary `refresh token reuse; session revoked`.
- AC-6 [integration] After that reuse, `POST /api/auth/refresh` with the newest refresh token of the same session answers 401.
- AC-7 [integration] With `GET /api/auth/me` answered 200 for the session's newest access token before the reuse, the same call answers 401 after the reuse.
- AC-8 [integration] `POST /api/auth/refresh` with a token built by `JwtRefreshStrategyProvider.sign({ sub, tokenVersion })` (no `sid`, no `jti`) answers 401.
- AC-9 [integration] That legacy refresh writes no `AuthSession` and no `RefreshToken` row.
- AC-10 [integration] Two `POST /api/auth/refresh` calls started together with the same unused refresh token both answer 200.
- AC-11 [integration] After those two calls, `POST /api/auth/refresh` with the refresh token from the first response answers 200.
- AC-12 [integration] After those two calls, `POST /api/auth/refresh` with the refresh token from the second response answers 200.
- AC-13 [integration] After `POST /api/auth/logout` with a session's access token, `POST /api/auth/refresh` with that session's newest refresh token answers 401.
- AC-14 [unit] When `rotate` returns `{ kind: 'reused', userId }` and the audit write rejects, `AuthService.refresh` rejects with `AuthException` (401), not the audit error.

**Out of scope:** expiry of the refresh JWT itself is enforced by `JwtRefreshGuard`'s signature and `exp` check, which this story does not change; disabled users and `tokenVersion` bumps keep refusing through `KodaJwtRefreshStrategyProvider`'s existing check.

### US-005

- AC-1 [unit] `ProjectInvitesService.create` for a new address, called inside `AfterCommitService.scope`, does not call `InviteMailer.sendInvite` before the scope's callback resolves.
- AC-2 [unit] After that scope's callback resolves, `InviteMailer.sendInvite` has been called exactly once.
- AC-3 [unit] When the callback passed to `AfterCommitService.scope` throws after `ProjectInvitesService.create` ran, `InviteMailer.sendInvite` is never called.
- AC-4 [unit] `ProjectInvitesService.create` inside a scope returns `emailed: false`.
- AC-5 [unit] `ProjectInvitesService.create` outside any scope, with email configured and `InviteMailer.sendInvite` resolving true, returns `emailed: true`.
- AC-6 [unit] `ProjectInvitesService.resend` inside a scope calls `InviteMailer.sendInvite` only after the scope's callback resolves.
- AC-7 [integration] With `SMTP_URL` set before boot and `NOTIFY_SERVICE.send` stubbed to resolve, an agent's invite create held for approval and approved through `POST /api/approvals/:id/decisions` with `{ "decision": "approve" }` stores an approval result with `emailed: false`.
- AC-8 [integration] In that same flow, exactly one `EmailSchedule` row with `kind` `'INVITE'` and status `'SENT'` exists for the new invite after the decision returns.
