# SPEC: Auth passwords (self-service password change and email reset) and client-bound lost-response recovery

Closes: #463

## Summary

F2 of the P1 auth bundle (owner rulings 11 and 12 on the 2026-11-14 whole-repo review, `docs/20261114-review-whole-repo.md`), bundled by the owner on 2026-11-15 with #463.

1. **Self-service password change.** `POST /api/auth/password` takes the current password, stores the new hash, keeps the caller's session and revokes every other session of the user.
2. **Password reset by email.** `POST /api/auth/password-reset` emails a one-time link valid for 30 minutes and always answers the same, so it cannot enumerate accounts. `POST /api/auth/password-reset/confirm` sets the new password and revokes every session of the user.
3. **Client-bound lost-response recovery (#463).** Rotation step 5 (#462) re-rotates a used refresh token inside a 20-minute window. It now also requires that the retry carries the same User-Agent as the token's first use; a different User-Agent is revoked as reuse. The client IP is recorded at first use and in the recovery audit entry, but not enforced.
4. **Web.** An account page with the change-password form, a "Forgot password?" link on the login page, the forgot-password and reset-password pages, and User-Agent forwarding from Nuxt to the API.

## Motivation

- **Gap rows 4 and 5 of the 11-14 review, ruling 11:** there is no self-service password change and no password reset. Users are admin-created with a temporary password, and a forgotten password needs an admin.
- **#463:** inside the 20-minute recovery window, a thief replaying the stolen newest-used refresh token cannot be told apart from a client whose refresh response was lost. Only the Nuxt server presents refresh tokens (httpOnly cookies, SSR refresh in `apps/web/server/middleware/session-refresh.ts`), so a DPoP-style browser key cannot sign SSR refreshes. The owner ruled 2026-11-15, after research, for a User-Agent binding of the recovery path, with the IP audited but not enforced: Okta, Auth0 and Supabase all cover lost responses with a short reuse window on the immediately superseded token, and IP binding logs users out on mobile handoffs, carrier NAT and IPv4/IPv6 switching, while the User-Agent rarely changes within a session.

## Design

### Password change

`POST /api/auth/password`, body `ChangePasswordDto { currentPassword: string; newPassword: string }`. `currentPassword` is `@IsString` + `@MinLength(1)`. `newPassword` uses the same validators as `RegisterDto.password` (`@IsString`, `@MinLength(8)`, `@Matches(PASSWORD_COMPLEXITY)`, same i18n messages). The route is authenticated (no `@Public()`), declares `@UseGuards(RequiresGuard)` + `@Requires('session.password.change')`, and is throttled with `@Throttle({ default: { limit: AUTH_LOGIN_LIMIT, ttl: AUTH_LOGIN_TTL_MS } })`.

`AuthService.changePassword(principal: KodaPrincipal, dto: ChangePasswordDto): Promise<void>`:
1. A principal that is not a user principal (`isUserPrincipal` false: an agent or runner), or a user principal without `sessionId` (an access token issued before sessions; none can still be valid, since access tokens live 15 minutes and sessions shipped in #460) → `AuthException({}, 'auth')` (401). Load the user with `authRepo.findUserById(principal.id)`; missing or `disabled` → `AuthException({}, 'auth')` (401).
2. `bcrypt.compare(dto.currentPassword, user.passwordHash)` false → `ForbiddenAppException({}, 'auth.currentPasswordWrong')` (403). A 403, not a 401, so the web's 401 refresh-and-retry does not run.
3. Hash the new password with `bcrypt.hash(dto.newPassword, 12)` before opening the transaction. Then, in one `audit.audited(...)` call (it opens the transaction): `authRepo.updatePasswordHash(user.id, hash)`, then `authSessions.revokeAllForUser(user.id, 'password-change', now, principal.sessionId)`. From US-003 on, the same transaction also deletes the user's unused `PasswordResetToken` rows (`PasswordResetTokenStore.discardUnusedFor(userId)`), so a reset link emailed before the change stops working. The audit entry is `{ key: 'session.password.change', resourceType: 'user', resourceId: user.id, projectId: null, summary: 'password changed' }`.
4. After the commit: for each revoked session id, `withAuthSessionCacheLock(id, () => cache.invalidate(authSessionCacheKey(id)))`; then `cache.invalidate(userAuthStateCacheKey(user.id))`.
5. The controller answers `JsonResponse.Ok({})` (200). The caller's session and cookies stay valid.

`AuthSessionService.revokeAllForUser(userId: string, reason: SessionRevokeReason, now: Date, exceptSessionId?: string): Promise<string[]>` revokes every active session of the user (`revokedAt: null`, `expiresAt > now`) except `exceptSessionId`, sets `revokedReason`, and answers the revoked ids. It runs no transaction of its own and records no audit entry: its caller runs it inside the audited transaction. It goes through a new repository method `PrismaAuthSessionRepository.revokeActiveSessionsOfUser(userId, reason, now, exceptSessionId?)` built on `updateManyAndReturn` (the same Prisma call `revokeSession` uses).

### Password reset

New model, migration `20261210100000_password_reset_tokens`:

```prisma
model PasswordResetToken {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash String    @unique // lowercase sha256 hex of the raw token
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime  @default(now())

  @@index([userId])
}
```

`User` gains the back-relation `passwordResetTokens PasswordResetToken[]`. The raw token is `randomBytes(32).toString('base64url')`, hashed with sha256 the way `generateInviteToken` / `hashInviteToken` (`apps/api/src/projects/invites/invite-token.ts`) do; only the hash is stored. `PASSWORD_RESET_TTL_MS = 30 * 60_000`. A new module-private `PrismaPasswordResetRepository` (`apps/api/src/auth/password-reset/prisma-password-reset.repository.ts`) owns the table with four methods: `replaceUnused(userId, tokenHash, expiresAt): Promise<void>` (deletes the user's unused rows and inserts the new one in one `txManager.run`), `findByHash(tokenHash): Promise<{ id; userId; expiresAt; usedAt; userDisabled } | null>`, `markUsed(id, now): Promise<number>` (`updateMany where { id, usedAt: null }`, the affected count) and `deleteUnusedOf(userId): Promise<number>`. `PasswordResetTokenStore` (below) is its only consumer and the public face of the table.

No `@nathapp/nestjs-*` package covers password reset (plugin catalog checked 2026-11-15: the closest match, `nestjs-iam`, is roles and policies), so the flow is built here on the existing email schedule.

**Modules.** Two modules, so `AuthModule` never imports `NotificationsModule` (that would close the cycle `AuthModule` → `NotificationsModule` → `LiveModule` → `AuthModule`; the repo avoids it the same way with `AuthRepositoryModule` and `AuthSessionsModule`):
- `PasswordResetStoreModule` (`apps/api/src/auth/password-reset/password-reset-store.module.ts`, US-002) is a leaf: it imports only `PrismaModule`, provides `PrismaPasswordResetRepository` and `PasswordResetTokenStore`, and exports `PasswordResetTokenStore`. `PasswordResetTokenStore` (`password-reset-token.store.ts`) is the public face of the table: `replaceUnused`, `findByHash`, `markUsed` and `discardUnusedFor(userId): Promise<number>`, each delegating to the repository.
- `PasswordResetModule` (`password-reset.module.ts`, US-003) declares `PasswordResetController`, provides `PasswordResetService`, and imports `PasswordResetStoreModule`, `AuthRepositoryModule` (`PrismaAuthRepository`), `AuthSessionsModule` (`AuthSessionService`) and `NotificationsModule` (`EmailDispatcher`); `EmailAvailability` and `EmailScheduleService` come from the global `EmailCoreModule`. `AppModule` imports `PasswordResetModule`.
- `AuthModule` imports `PasswordResetStoreModule` only, so `AuthService.changePassword` can call `PasswordResetTokenStore.discardUnusedFor`.

**Controller.** `PasswordResetController` (`apps/api/src/auth/password-reset/password-reset.controller.ts`, `@Controller('auth')`, `@ApiTags('auth')` like `AuthController`) hosts both reset routes: handler `requestReset` on `@Post('password-reset')` and handler `confirmReset` on `@Post('password-reset/confirm')`, each `@HttpCode(200)`. Both routes are public, so the controller carries no `@ApiBearerAuth` (an exception to `.nax/rules/api-controllers.md` for unauthenticated routes, like `register` and `login`). `AuthController` is unchanged by the reset routes.

**Request.** `POST /api/auth/password-reset`, body `PasswordResetRequestDto { email: string }` (`@IsEmail`, `@MaxLength(254)`, same messages as `RegisterDto.email`). The route is public (`@Public()`, `@UseGuards(RequiresGuard)`, `@Requires('session.password.reset.request')`), throttled with `AUTH_LOGIN_LIMIT` / `AUTH_LOGIN_TTL_MS`, and always answers `JsonResponse.Ok({})` (200).

`PasswordResetService.request(email: string, locale: EmailLocale): Promise<void>` returns after the user lookup. When the user exists, is not disabled and `EmailAvailability.configured` is true, it starts a detached task (not awaited; a rejection is caught and logged with `Logger.warn`). The whole task runs inside `bookkeeping('auth.password-reset-request', ...)`, a new reason in `BOOKKEEPING_REASONS` (`apps/api/src/action-context/audit-coverage.reasons.ts`, sentence: "A password reset token and its email schedule row, written for a public request that records no audit entry so it cannot reveal whether the address has an account."), so its writes never count against the request's audit scope, whether they land before or after the handler completes. The task:
1. calls `PasswordResetTokenStore.replaceUnused(userId, sha256(raw), now + PASSWORD_RESET_TTL_MS)`, which deletes the user's unused reset tokens and inserts the new one in one transaction, so two concurrent requests cannot leave two unused tokens;
2. calls `EmailScheduleService.startPasswordResetSend({ userId, toEmail, locale, now })`, which inserts a `PASSWORD_RESET` row in status `SENDING`;
3. sends it with `EmailDispatcher.sendOne(row, 'PASSWORD_RESET', { url: EmailAvailability.webUrl('/reset-password/<raw>'), expiresAt: <ISO> }, userId, now, false)`. Retry is off: only the hash is stored, so a failed send is final.

The controller resolves the locale from `Accept-Language` with a local helper that copies the rule of the module-private `inviteLocale` in `project-invites.controller.ts` (only a value starting with `zh` gives `zh`; anything else is `en`).

**Confirm.** `POST /api/auth/password-reset/confirm`, body `PasswordResetConfirmDto { token: string; newPassword: string }`, `token` `@IsString` + `@MinLength(1)` + `@MaxLength(128)`, `newPassword` validated like `RegisterDto.password`. Public (`@Requires('session.password.reset.confirm')`), throttled the same way.

`PasswordResetTokenStore.discardUnusedFor(userId)` deletes the user's unused reset tokens and runs inside its caller's transaction; `AuthService.changePassword` calls it from US-003 on.

`PasswordResetService.confirm(dto: PasswordResetConfirmDto, now: Date): Promise<void>`:
1. Hash the token and find the row with its user.
2. Missing, `usedAt` set, `expiresAt <= now`, or the user disabled → `ValidationAppException({}, 'auth.resetTokenInvalid')` (400).
3. Hash the new password before opening the transaction. In one `audit.audited(...)` call: mark the row used with `updateMany where { id, usedAt: null }` (count 0 → the same 400, thrown inside so the transaction rolls back), `updatePasswordHash`, `bumpTokenVersion`, `authSessions.revokeAllForUser(userId, 'password-reset', now)`, delete the user's other unused reset tokens. Audit entry `{ key: 'session.password.reset.confirm', resourceType: 'user', resourceId: userId, projectId: null, summary: 'password reset' }`.
4. After the commit: evict each revoked session's `authSessionCacheKey` under its lock, `cache.invalidate(userTokenVersionCacheTag(userId), { mode: 'tag' })` and `cache.invalidate(userAuthStateCacheKey(userId))`.
5. Answer `JsonResponse.Ok({})`. No session is issued; the web sends the user to `/login`.

**Email plumbing.**
- `EmailKind` (`email-schedule.types.ts`) and `EMAIL_TEMPLATE_CODES` (`templates/template-codes.ts`) gain `PASSWORD_RESET`.
- `EN_TEMPLATES` gains `PASSWORD_RESET`: subject `[koda] Reset your password`, html `<p>Someone asked to reset the password of your koda account.</p><p><a href="{{url}}">Choose a new password</a></p><p>This link works once and expires on {{expiresAt}}. If you did not ask for it, ignore this email.</p>`. `ZH_TEMPLATES` gains the Chinese equivalent.
- `EmailScheduleService.startPasswordResetSend(input: PasswordResetSend)` and `EmailScheduleRepository.startPasswordResetSend`, mirroring `startInviteSend` with `kind: 'PASSWORD_RESET'`, `userId` set and `inviteId` null. `PasswordResetSend = { userId: string; toEmail: string; locale: string; now: Date }`.
- `EmailScheduleRepository.closeAbandonedInvites(now)` closes abandoned `PASSWORD_RESET` rows too: its `where.kind` becomes `{ in: ['INVITE', 'PASSWORD_RESET'] }`. `claimDue` already claims only `NOTIFICATION` and `MEMBER_ADDED`, so reset rows are never re-sent.
- The `EmailSchedule.kind` schema comment lists `PASSWORD_RESET`.

### Client-bound lost-response recovery (#463)

Migration `20261210110000_refresh_token_client` adds two nullable columns to `RefreshToken`: `usedUaHash String?` (lowercase sha256 hex of the User-Agent header, empty string when absent) and `usedIp String?` (the client IP as Fastify resolves it through the trusted proxies configured in `main.ts`).

New type in `auth-session.service.ts`: `RefreshClient = { uaHash: string; ip: string | null }`. A pure helper `refreshClientOf(userAgent: string | undefined, ip: string | undefined): RefreshClient` in a new file `apps/api/src/auth/sessions/refresh-client.ts` hashes `userAgent ?? ''` with sha256 and maps a missing or empty ip to `null`.

Worked skeleton of the controller change (novel shape: no auth route reads the raw request today):

```ts
@Post('refresh')
// ...existing decorators unchanged...
async refresh(@Principal() user: IPrincipal, @Req() req: RefreshRequestLike) {
  const client = refreshClientOf(req.headers['user-agent'], req.ip);
  return JsonResponse.Ok(await this.authService.refresh(user, client));
}
```

`RefreshRequestLike` is a local interface in `refresh-client.ts`, `{ headers: Record<string, string | string[] | undefined>; ip?: string }` (the way `mcp.controller.ts` declares `McpHttpRequest`), because `fastify` is not a direct dependency of `apps/api`. A `user-agent` header given as an array uses its first value.

`AuthService.refresh(principal, client)` passes `client` into `AuthSessionService.rotate({ ..., client })`. In `rotate`:
- step 3 (first use): `markUsed(sessionId, presentedTokenId, now, client)` also writes `usedUaHash = client.uaHash` and `usedIp = client.ip`;
- step 4 (grace) is unchanged;
- step 5 (lost response) additionally requires `presented.usedUaHash === client.uaHash`. A `null` `usedUaHash` (a token first used before this migration) never matches. A mismatch falls through to step 6 (revoke as `reuse`);
- the `recovered` outcome carries the presenting IP: `{ kind: 'recovered'; ip: string | null }`.

`AuthService.refresh` records the recovery entry with summary `refresh token lost-response recovery; session kept; ip <ip>` (`ip unknown` when null). The reuse entry is unchanged.

**Web.** `forwardToApi` (`apps/web/server/utils/api.ts`) forwards the incoming request's `user-agent` header as `User-Agent` when present, so the SSR refresh middleware, `server/api/auth/refresh.post.ts` and `server/api/auth/logout.post.ts` all present the browser's User-Agent. `clientIpHeaders` and `proxyHeaders` are unchanged.

### Catalog keys

Three new keys, each added in four places: one REST row in the inventory TSV `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` (next to the `session.*` rows, same columns), `INVENTORY_SCOPE_ROWS` plus the access set in `apps/api/src/permissions/catalog.ts`, the key lists in `catalog.spec.ts`, and one cell per role in `src/permissions/__snapshots__/role-matrix.json`.

| Key | Route | TSV `catalog_scope` / `INVENTORY_SCOPE_ROWS` | Access set | role-matrix cell |
|:--|:--|:--|:--|:--|
| `session.password.change` | `POST /auth/password` | `own (see design §1)` in the TSV, `own` in `INVENTORY_SCOPE_ROWS` | `IMPLICIT_KEYS` | `["implicit","implicit"]` |
| `session.password.reset.request` | `POST /auth/password-reset` | `public` | `PUBLIC_KEYS` | `["public","public"]` |
| `session.password.reset.confirm` | `POST /auth/password-reset/confirm` | `public` | `PUBLIC_KEYS` | `["public","public"]` |

After the API contract changes, `bun run generate` from the repo root keeps `openapi.json` and the CLI client current.

### Web pages

- **Account page** `apps/web/pages/settings/account.vue`: a vee-validate + zod form with current password, new password and confirm new password (confirm must equal new; new must be at least 8 characters). It submits through `usePasswordActions().changePassword({ currentPassword, newPassword })` (`apps/web/composables/usePasswordActions.ts`), which calls `$api.post('/auth/password', ...)`. Success shows a `useAppToast()` success toast and resets the form. A 403 shows the `auth.account.currentPasswordWrong` message on the current-password field; any other error shows `extractApiError()`.
- **Layout:** the header in `apps/web/layouts/default.vue` gains an "Account" link (`data-testid="header-account-link"`) to `/settings/account`, next to the logout button.
- **Forgot password** `apps/web/pages/forgot-password.vue` (with `definePageMeta({ layout: 'auth' })`, as `login.vue` and `register.vue` do): an email form calling `usePasswordActions().requestReset(email)` (`$api.post('/auth/password-reset', { email })`); after the call settles it always shows the same "check your email" state.
- **Reset password** `apps/web/pages/reset-password/[token].vue` (layout `auth` too): new-password and confirm form calling `usePasswordActions().confirmReset(token, newPassword)` (`$api.post('/auth/password-reset/confirm', { token, newPassword })`). Success navigates to `/login?reset=1`; a 400 shows the "link invalid or expired" state with a link to `/forgot-password`.
- **Login page** `apps/web/pages/login.vue`: a "Forgot password?" link to `/forgot-password`, and a notice when the query has `reset=1`.
- **Routing:** `apps/web/middleware/auth.global.ts` treats `/forgot-password` and every path starting with `/reset-password/` as guest-only: anonymous visitors are not sent to `/login`, and authenticated users are redirected to `safeRedirectPath(to.query.redirect)`.
- **i18n:** every new string is in both `i18n/locales/en.json` and `zh.json`, under `auth.account`, `auth.forgot`, `auth.reset` and `nav.account`.
- The API calls go through the existing Nuxt catch-all proxy; none sets cookies, so no new Nitro route is needed.

### Integration

Symbols this feature reads (verified on `main` @ `1b4fc5b8`):

- `PrismaAuthRepository.findUserById(id)`, `findUserByEmail(email)`, `bumpTokenVersion(userId): Promise<number>` (`apps/api/src/auth/prisma-auth.repository.ts`).
- `userAuthStateCacheKey(userId)`, `userTokenVersionCacheTag(userId)`, `authSessionCacheKey(sessionId)`, `withAuthSessionCacheLock(sessionId, task)` (`apps/api/src/auth/token-version.cache.ts`).
- `SessionRevokeReason` already includes `'password-change' | 'password-reset'` (`apps/api/src/auth/sessions/auth-session.domain.ts`).
- `isUserPrincipal`, `KodaPrincipal`, `UserPrincipal.sessionId` (`apps/api/src/auth/principal/koda-principal.types.ts`).
- `PASSWORD_COMPLEXITY` (`apps/api/src/auth/dto/register.dto.ts`); `AUTH_LOGIN_LIMIT`, `AUTH_LOGIN_TTL_MS` (`apps/api/src/auth/auth-throttle.ts`).
- `AuditRecorder.audited(work, entriesOf)` and `record(entry)` (`apps/api/src/audit/audit-recorder.service.ts`).
- `EmailDispatcher.sendOne(row, templateCode, data, userId, now, retryable = true): Promise<SendOutcome>` (`apps/api/src/email/email-dispatcher.ts`); `EmailAvailability.configured` and `webUrl(path)` (`apps/api/src/email/email-availability.ts`).
- `generateInviteToken`, `hashInviteToken` (`apps/api/src/projects/invites/invite-token.ts`); `inviteLocale` in `project-invites.controller.ts` (pattern for the `Accept-Language` locale).
- `ForbiddenAppException`, `ValidationAppException`, `AuthException`, `JsonResponse` from `@nathapp/nestjs-common`.
- Web: `useApi().$api`, `extractApiError` (`composables/useApi.ts`), `useAppToast` (`composables/useAppToast.ts`), `safeRedirectPath` (`lib/safe-redirect.ts`).

Symbols this feature changes. Each **Baseline** exists only to locate the current code and is never the interface to implement; build the **Target**.

- `AuthController.refresh`
  - Baseline: `refresh(@Principal() user: IPrincipal)` calling `authService.refresh(user)`.
  - Target: `refresh(@Principal() user: IPrincipal, @Req() req: RefreshRequestLike)` calling `authService.refresh(user, refreshClientOf(req.headers['user-agent'], req.ip))`.
- `AuthService.changePassword` (new) and `AuthModule` imports
  - Target: `AuthModule` imports the leaf `PasswordResetStoreModule` (never `PasswordResetModule`) from US-003 on; `AuthService` gains the constructor dependency `PasswordResetTokenStore`.
- `AuthService.refresh`
  - Baseline: `refresh(principal: IPrincipal)`; on `recovered` records summary `refresh token lost-response recovery; session kept`.
  - Target: `refresh(principal: IPrincipal, client: RefreshClient)`; passes `client` to `rotate`; on `recovered` records `refresh token lost-response recovery; session kept; ip <ip|unknown>`.
- `AuthSessionService.rotate`
  - Baseline: input `{ sessionId, presentedTokenId, nextTokenId, nextExpiresAt, now }`; `RotateOutcome` member `{ kind: 'recovered' }`.
  - Target: input adds `client: RefreshClient`; `RotateOutcome` member `{ kind: 'recovered'; ip: string | null }`; step 5 also requires `presented.usedUaHash === client.uaHash`.
- `PrismaAuthSessionRepository.markUsed`
  - Baseline: `markUsed(sessionId, tokenId, now): Promise<number>` writes `usedAt`.
  - Target: `markUsed(sessionId, tokenId, now, client: RefreshClient)` also writes `usedUaHash` and `usedIp`.
- `PrismaAuthSessionRepository.findToken` and `RefreshTokenDomain`
  - Baseline: `{ id, sessionId, createdAt, usedAt }`.
  - Target: adds `usedUaHash: string | null`.
- `EmailKind` / `EMAIL_TEMPLATE_CODES`
  - Baseline: `'NOTIFICATION' | 'INVITE' | 'MEMBER_ADDED'`.
  - Target: adds `'PASSWORD_RESET'`.
- `EmailScheduleRepository.closeAbandonedInvites(now)`
  - Baseline: `where: { kind: 'INVITE', status: 'SENDING', lockedUntil: { lt: now } }`.
  - Target: `where.kind` is `{ in: ['INVITE', 'PASSWORD_RESET'] }`.
- `forwardToApi` (`apps/web/server/utils/api.ts`)
  - Baseline: headers `Accept`, client-ip headers, optional `Authorization`, `Content-Type`.
  - Target: also `User-Agent` when the incoming request has a `user-agent` header.
- `auth.global.ts` guest routes
  - Baseline: `guestOnlyRoutes = ['/login', '/register']`.
  - Target: also `/forgot-password` and any path starting with `/reset-password/`.

New symbols: `PasswordResetController` (`requestReset`, `confirmReset`), `RefreshRequestLike`, the bookkeeping reason `auth.password-reset-request`, `PasswordResetStoreModule`, `PasswordResetTokenStore` (`replaceUnused`, `findByHash`, `markUsed`, `discardUnusedFor`), `ChangePasswordDto`, `PasswordResetRequestDto`, `PasswordResetConfirmDto`, `AuthService.changePassword`, `AuthSessionService.revokeAllForUser`, `PrismaAuthSessionRepository.revokeActiveSessionsOfUser`, `PrismaAuthRepository.updatePasswordHash(userId, passwordHash): Promise<void>`, `PasswordResetService` (`request`, `confirm`), `PrismaPasswordResetRepository`, `PasswordResetModule`, `PASSWORD_RESET_TTL_MS`, `EmailScheduleService.startPasswordResetSend`, `PasswordResetSend`, `RefreshClient`, `refreshClientOf`, `usePasswordActions`.

**API messages.** The exception filter translates `<prefix>.<code>`, so both messages are nested under their exception codes in `apps/api/src/i18n/en/auth.json` and `zh/auth.json`, the way `invites.json` nests `roleGone`: `"currentPasswordWrong": { "40003": "The current password is incorrect" }` (`ForbiddenAppException`) and `"resetTokenInvalid": { "-2": "This reset link is invalid or has expired", "400": "This reset link is invalid or has expired" }` (`ValidationAppException`).

### Failure Handling

| Case | Behaviour |
|:--|:--|
| Password change by an agent or runner principal, or with an access token that carries no session | 401 `auth`; nothing written |
| Password change with a wrong current password | 403 `auth.currentPasswordWrong`; nothing written, no audit entry |
| Password change with a new password failing the complexity rule | 400 validation error; nothing written |
| Reset request for an unknown, disabled, or (email off) address | 200 `{}`; no token row, no email |
| Reset email send fails | logged with `Logger.warn`; the `EmailSchedule` row ends `FAILED`; the response is already 200 |
| Reset confirm with an unknown, used or expired token, or for a disabled user | 400 `auth.resetTokenInvalid`; nothing written |
| Two concurrent confirms with the same token | exactly one succeeds; the other answers 400 `auth.resetTokenInvalid` |
| Lost-response retry whose User-Agent differs from the token's first use | session revoked (`reuse`), audit `session.refresh` reuse entry, 401 |
| Lost-response retry for a token first used before the client columns existed (`usedUaHash` null) | treated as a User-Agent mismatch: revoked as reuse, 401 |
| Lost-response retry from a different IP with the same User-Agent | recovered (200); the IP goes into the recovery audit entry |
| Web reset page receives 400 | shows the invalid-or-expired state with a link to `/forgot-password` |
| Web account page receives 403 | shows `auth.account.currentPasswordWrong` on the current-password field |

## Out of Scope

- DPoP or any cryptographic binding of refresh tokens: koda's refresh tokens are presented by the Nuxt server (httpOnly cookies, SSR refresh), which holds no browser key; #463 is closed by the User-Agent binding of the recovery path.
- Enforcing the client IP on any refresh path; the IP is recorded and audited only, because enforcing it logs users out on mobile handoffs, carrier NAT and IPv4/IPv6 switching.
- Binding normal rotation (steps 3 and 4) to the User-Agent; only the lost-response recovery (step 5) checks it.
- A "log out of all devices" control and a list of active sessions per user.
- Rejecting a new password equal to the current one, password history, and breached-password checks.
- A reset path for agents or runners; they authenticate with API keys.
- Re-sending a password reset email from the schedule; only the hash is stored, so a failed send is final and the user requests another link.
- Rate limiting reset requests per email address beyond the per-client `AUTH_LOGIN_LIMIT` throttle.
- Purging expired or used `PasswordResetToken` rows beyond deleting a user's unused tokens on a new request and on a confirm.
- MFA, the Secure-cookie and TLS work of the prod deployment bundle, and email verification on registration.
- Changing the CLI, which authenticates with agent API keys and never uses refresh tokens.
- US-003 only: equal response time for known and unknown addresses beyond starting the token write and send detached; a timing side channel from the user lookup itself is accepted.
- US-001 only: a runner-principal case is not tested separately; the `isUserPrincipal` check that refuses agents (AC-8) refuses runners the same way.
- US-003 only: no test asserts the raw reset token is absent from log lines; the service logs only the user id and the failure reason, never the token or the URL.
- US-005 only: the different-IP recovery is pinned by unit ACs (AC-7, AC-9) only; the integration harness does not configure trusted proxies, so it cannot vary the client IP.
- US-005 only: refresh concurrency across API replicas; the API is single-replica by ruling.
- US-005 only: a request with no User-Agent on both the first use and the lost-response retry recovers (both hashes are of the empty string); scripts and CLIs that send no User-Agent are not browsers and never hit the lost-response path in practice.

## Stories

**US-001: Self-service password change.** Workdir: `apps/api`. No dependencies.
Adds `POST /auth/password`, `ChangePasswordDto`, `AuthService.changePassword` (user principals with a session only), `PrismaAuthRepository.updatePasswordHash`, `AuthSessionService.revokeAllForUser` with `PrismaAuthSessionRepository.revokeActiveSessionsOfUser`, the `session.password.change` catalog key and the `auth.currentPasswordWrong` API message (en and zh).

**US-002: Password reset store and email plumbing.** Workdir: `apps/api`. No dependencies.
Adds the `PasswordResetToken` model and migration `20261210100000_password_reset_tokens`, the leaf `PasswordResetStoreModule` with `PrismaPasswordResetRepository` and `PasswordResetTokenStore`, `PASSWORD_RESET_TTL_MS`, the `PASSWORD_RESET` email kind, template code and en/zh templates, `PasswordResetSend` with `EmailScheduleService.startPasswordResetSend`, and abandoned reset-row closing in `closeAbandonedInvites`. No route.

**US-003: Password reset request route.** Workdir: `apps/api`. Depends on US-001, US-002.
Adds `PasswordResetModule`, `PasswordResetController.requestReset` on `POST /auth/password-reset`, `PasswordResetRequestDto`, `PasswordResetService.request` (detached, under the new bookkeeping reason `auth.password-reset-request`), the public key `session.password.reset.request`, the module wiring (`AppModule` imports `PasswordResetModule`; `AuthModule` imports only `PasswordResetStoreModule`), and the deletion of outstanding reset tokens in `AuthService.changePassword` through `PasswordResetTokenStore.discardUnusedFor`.

**US-004: Password reset confirm.** Workdir: `apps/api`. Depends on US-001, US-003.
Adds `PasswordResetService.confirm`, `PasswordResetConfirmDto`, `PasswordResetController.confirmReset` on `POST /auth/password-reset/confirm`, its public key and the `auth.resetTokenInvalid` API message (en and zh).

**US-005: Client-bound lost-response recovery.** Workdir: `apps/api`. No dependencies.
Adds the `usedUaHash` / `usedIp` columns (migration `20261210110000_refresh_token_client`), `RefreshClient`, `RefreshRequestLike` and `refreshClientOf`, records the client at first use, requires a User-Agent match for rotation step 5, carries the IP on the `recovered` outcome and into the recovery audit summary, and passes the client from `AuthController.refresh`.

**US-006: Account page and User-Agent forwarding.** Workdir: `apps/web`. Depends on US-001, US-005.
Adds `pages/settings/account.vue`, `usePasswordActions().changePassword`, the header Account link and en/zh strings, and forwards the browser's User-Agent in `forwardToApi`.

**US-007: Forgot-password and reset-password pages.** Workdir: `apps/web`. Depends on US-003, US-004, US-006.
Adds `pages/forgot-password.vue`, `pages/reset-password/[token].vue`, `requestReset` and `confirmReset` on `usePasswordActions`, the login page link and reset notice, guest-only routing for both paths, and en/zh strings.

### Context Files

**US-001**
- `apps/api/src/auth/auth.controller.ts` — route decorator pattern (`register`, `logout`)
- `apps/api/src/auth/auth.service.ts` — `logout` (audited revoke + cache eviction pattern)
- `apps/api/src/auth/sessions/prisma-auth-session.repository.ts` — `revokeSession` (`updateManyAndReturn`)
- `apps/api/src/auth/dto/register.dto.ts` — password validators
- `apps/api/src/permissions/catalog.ts` — `IMPLICIT_KEYS`, `INVENTORY_SCOPE_ROWS`

**US-002**
- `apps/api/src/projects/invites/invite-token.ts` — token generation and hashing
- `apps/api/src/email/schedule/email-schedule.repository.ts` — `startInviteSend`, `closeAbandonedInvites`
- `apps/api/src/email/schedule/email-schedule.types.ts` — `EmailKind`, `InviteSend`
- `apps/api/src/email/templates/en.ts` — template shape
- `apps/api/src/email/templates/template-codes.ts` — `EMAIL_TEMPLATE_CODES`

**US-003**
- `apps/api/src/projects/invites/invite-mailer.ts` — one-time emailed token send pattern
- `apps/api/src/projects/invites/project-invites.module.ts` — module imports for `EmailDispatcher`
- `apps/api/src/action-context/audit-coverage.ts` — `bookkeeping`
- `apps/api/src/projects/invites/project-invites.controller.ts` — `inviteLocale` rule
- `apps/api/src/auth/password-reset/password-reset-token.store.ts` — created by US-002, used here

**US-004**
- `apps/api/src/auth/password-reset/password-reset.service.ts` — created by US-003, extended here
- `apps/api/src/auth/password-reset/password-reset.controller.ts` — created by US-003, extended here
- `apps/api/src/auth/sessions/auth-session.service.ts` — `revokeAllForUser` (created by US-001)
- `apps/api/src/auth/auth.service.ts` — `logout` cache eviction pattern
- `apps/api/src/i18n/en/auth.json` — message key layout

**US-005**
- `apps/api/src/auth/sessions/auth-session.service.ts` — `rotate` steps 3-6
- `apps/api/src/auth/sessions/prisma-auth-session.repository.ts` — `markUsed`, `findToken`
- `apps/api/src/auth/auth.controller.ts` — `refresh`
- `apps/api/src/fleet/assistant/mcp/mcp.controller.ts` — `McpHttpRequest` local request interface pattern

**US-006**
- `apps/web/server/utils/api.ts` — `forwardToApi`
- `apps/web/layouts/default.vue` — header logout button
- `apps/web/pages/register.vue` — vee-validate + zod form pattern
- `apps/web/composables/useApi.ts` — `$api`, `extractApiError`

**US-007**
- `apps/web/pages/login.vue` — login page
- `apps/web/middleware/auth.global.ts` — guest routes
- `apps/web/composables/usePasswordActions.ts` — created by US-006, extended here
- `apps/web/pages/settings/account.vue` — created by US-006, form pattern

### Creates

**US-001**
- `apps/api/src/auth/dto/change-password.dto.ts`

**US-002**
- `apps/api/prisma/migrations/20261210100000_password_reset_tokens/migration.sql`
- `apps/api/src/auth/password-reset/prisma-password-reset.repository.ts`
- `apps/api/src/auth/password-reset/password-reset-token.store.ts`
- `apps/api/src/auth/password-reset/password-reset-store.module.ts`
- `apps/api/src/auth/password-reset/password-reset.constants.ts`

**US-003**
- `apps/api/src/auth/password-reset/password-reset.module.ts`
- `apps/api/src/auth/password-reset/password-reset.service.ts`
- `apps/api/src/auth/password-reset/password-reset.controller.ts`
- `apps/api/src/auth/dto/password-reset-request.dto.ts`

**US-004**
- `apps/api/src/auth/dto/password-reset-confirm.dto.ts`

**US-005**
- `apps/api/prisma/migrations/20261210110000_refresh_token_client/migration.sql`
- `apps/api/src/auth/sessions/refresh-client.ts`

**US-006**
- `apps/web/pages/settings/account.vue`
- `apps/web/composables/usePasswordActions.ts`

**US-007**
- `apps/web/pages/forgot-password.vue`
- `apps/web/pages/reset-password/[token].vue`

### Modifies

**US-001**
- `apps/api/src/permissions/catalog.spec.ts` — the closed key lists gain `session.password.change` next to `session.logout`; every other assertion stays.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — every role block gains the cell `"session.password.change": ["implicit","implicit"]` in catalog order; no other cell changes.
- `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` — one REST row for route POST /auth/password (`session`, `own-resource`, `session.password.change`, `own (see design §1)` like the `session.logout` row).
- `openapi.json` — regenerated by `bun run generate` for the new route.

**US-002**
- `apps/api/src/email/schedule/email-schedule.repository.spec.ts` — the `closeAbandonedInvites` where-clause assertion becomes `kind: { in: ['INVITE', 'PASSWORD_RESET'] }`; the status and lock conditions stay.
- `apps/api/prisma/schema.prisma` — the `PasswordResetToken` model, the `User.passwordResetTokens` back-relation and the `EmailSchedule.kind` comment.

**US-003**
- `apps/api/src/action-context/audit-coverage.bookkeeping.spec.ts` — `EXPECTED_REASON_IDS` gains `auth.password-reset-request`; the exact-list assertion stays; the seven unaudited surfaces are unchanged.
- `apps/api/src/permissions/catalog.spec.ts` — the closed key lists gain `session.password.reset.request` next to `session.refresh`.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — every role block gains `"session.password.reset.request": ["public","public"]` in catalog order; no other cell changes.
- `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` — one REST row for route POST /auth/password-reset (`session`, `global`, `session.password.reset.request`, `public`).
- `apps/api/src/auth/auth.service.spec.ts` — the `AuthService` test module provides a `PasswordResetTokenStore` double; `changePassword` cases assert `discardUnusedFor(userId)` is called inside the audited work.
- `apps/api/src/auth/session-activity-fence.spec.ts` — its `Test.createTestingModule` provider list gains a `PasswordResetTokenStore` double for the new `AuthService` dependency; the fence assertions stay.
- `openapi.json` — regenerated by `bun run generate` for the new route.

**US-004**
- `apps/api/src/permissions/catalog.spec.ts` — the closed key lists gain `session.password.reset.confirm`.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — every role block gains `"session.password.reset.confirm": ["public","public"]` in catalog order; no other cell changes.
- `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` — one REST row for route POST /auth/password-reset/confirm (`session`, `global`, `session.password.reset.confirm`, `public`).
- `openapi.json` — regenerated by `bun run generate` for the new route.

**US-005**
- `apps/api/src/auth/sessions/auth-session.service.spec.ts` — `rotateInput` gains `client`; the first-use assertion becomes `markUsed('s1', 't1', now, client)`; the recovery case expects `{ kind: 'recovered', ip }` and needs a matching `usedUaHash` on the found token.
- `apps/api/src/auth/auth.service.spec.ts` — `refresh` is called with a client argument and `rotate` is asserted with it; the recovery entry's summary gains `; ip <ip>`.
- `apps/api/src/auth/auth.controller.spec.ts` — the refresh handler is called with a request object and asserted to pass the client built from its `user-agent` header and `ip`.
- `apps/api/src/auth/session-activity-fence.spec.ts` — the `service.refresh(...)` calls pass a client argument; the fence assertions stay.
- `apps/api/test/integration/auth/auth-sessions.integration.spec.ts` — the `rotate` helper and the concurrent-rotation case pass a `client`; every outcome assertion stays.
- `apps/api/test/integration/auth/refresh-rotation.integration.spec.ts` — the recovery summaries gain `; ip <ip>`; the lost-response cases send the same `User-Agent` on the original refresh and the retry.
- `apps/api/prisma/schema.prisma` — the two `RefreshToken` columns.

**US-006**
None. `forwardToApi` header assertions in `tests/server/forward-to-api.spec.ts` read single keys, never the whole object, and the layout specs in `tests/layouts/` do not pin the header's button list.

**US-007**
None. `tests/middleware/auth.spec.ts` asserts behaviour for `/login` and `/register` only; adding guest routes leaves those cases true.

### Seams

- US-003 and US-004 call `AuthSessionService.revokeAllForUser` (US-001) — pinned by US-004 AC-6, which triggers `POST /api/auth/password-reset/confirm` and asserts every session of the user is revoked as `password-reset`.
- US-003 writes reset tokens through `PasswordResetTokenStore` and sends through `EmailScheduleService.startPasswordResetSend` (US-002) — pinned by US-003 AC-1 and AC-4, triggered at `POST /api/auth/password-reset`.
- US-003 wires `PasswordResetTokenStore.discardUnusedFor` (US-002) into `AuthService.changePassword` (US-001) — pinned by US-003 AC-14, triggered at `POST /api/auth/password`.
- US-004 confirms tokens US-003's `request` writes — pinned by US-004 AC-1, which requests a reset through `POST /api/auth/password-reset` and confirms the emailed token.
- US-006 forwards `User-Agent` that US-005's `AuthController.refresh` reads — pinned by US-006 AC-1 and AC-2 (the forwarded header) and US-005 AC-12 (the route reads it).
- US-006 and US-007 call `POST /auth/password`, `/auth/password-reset` and `/auth/password-reset/confirm` with the bodies `{ currentPassword, newPassword }`, `{ email }` and `{ token, newPassword }` exactly.

## Acceptance Criteria

### US-001

- AC-1 [integration] `POST /api/auth/password` with the caller's correct `currentPassword` and a valid `newPassword` answers 200, and a later `POST /api/auth/login` succeeds with `newPassword` and answers 401 with the old password.
- AC-2 [integration] After that change, the caller's own access token still answers 200 on `GET /api/auth/me`, and its refresh token still rotates on `POST /api/auth/refresh`.
- AC-3 [integration] A second session of the same user whose access token answered 200 on `GET /api/auth/me` before the change (so its activity is cached) is revoked with `revokedReason` `password-change`, and that access token answers 401 on `GET /api/auth/me` right after the change.
- AC-4 [integration] After that change, a session of a different user stays active.
- AC-5 [integration] `POST /api/auth/password` with a wrong `currentPassword` answers 403 with the `auth.currentPasswordWrong` message, the stored hash is unchanged, and no session is revoked.
- AC-6 [integration] A wrong `currentPassword` records no `session.password.change` audit entry.
- AC-7 [integration] A successful change records exactly one audit entry `{ key: 'session.password.change', resourceType: 'user', resourceId: <userId>, projectId: null, summary: 'password changed' }`.
- AC-8 [integration] `POST /api/auth/password` with an agent API key answers 401 and writes nothing.
- AC-9 [unit] `AuthService.changePassword` with a user principal that has no `sessionId` throws `AuthException` and calls neither `updatePasswordHash` nor `revokeAllForUser`.
- AC-10 [integration] A `newPassword` of `short1!` (fewer than 8 characters) answers 400 and the stored hash is unchanged.
- AC-11 [integration] A `newPassword` without an uppercase letter (`lowercase1!`) answers 400 and the stored hash is unchanged.
- AC-12 [unit] `AuthSessionService.revokeAllForUser('u1', 'password-change', now, 's1')` answers the ids the repository's `revokeActiveSessionsOfUser('u1', 'password-change', now, 's1')` returned.
- AC-13 [integration] `PrismaAuthSessionRepository.revokeActiveSessionsOfUser` leaves an already-revoked session's `revokedReason` and `revokedAt` unchanged and does not return its id.
- AC-14 [unit] The catalog entry for `session.password.change` has access `implicit`.
- AC-15 [integration] `POST /api/auth/password` is throttled like `POST /api/auth/login`: after `AUTH_LOGIN_LIMIT` requests from one client inside `AUTH_LOGIN_TTL_MS`, the next answers 429.

### US-002

- AC-1 [integration] `PasswordResetTokenStore.replaceUnused(userId, tokenHash, expiresAt)` deletes the user's unused token rows and inserts the new one, so afterwards exactly one unused row exists for the user, carrying the given `tokenHash` and `expiresAt`.
- AC-2 [integration] `replaceUnused` leaves a used row (`usedAt` set) of the same user in place.
- AC-3 [integration] `replaceUnused` leaves another user's unused row in place.
- AC-4 [integration] `PasswordResetTokenStore.findByHash(tokenHash)` answers `{ id, userId, expiresAt, usedAt, userDisabled }` for a stored hash, or null for an unknown hash.
- AC-5 [integration] `PasswordResetTokenStore.markUsed(id, now)` answers 1 for an unused row and 0 when the row already has `usedAt`.
- AC-6 [unit] `PASSWORD_RESET_TTL_MS` equals 1,800,000 (30 minutes).
- AC-7 [integration] `EmailScheduleService.startPasswordResetSend({ userId, toEmail, locale: 'en', now })` writes one `EmailSchedule` row with kind `PASSWORD_RESET`, status `SENDING`, the `userId`, `inviteId` null and `lockedUntil` two minutes after `now`.
- AC-8 [unit] `EmailScheduleRepository.closeAbandonedInvites` marks a `PASSWORD_RESET` row in status `SENDING` with `lockedUntil` in the past as `FAILED` with `lastError` `abandoned`.
- AC-9 [integration] `EmailScheduleService.claimDue` never returns a `PASSWORD_RESET` row, even one in status `PENDING` with `dueAt` in the past.
- AC-10 [unit] `EN_TEMPLATES.PASSWORD_RESET` has the subject `[koda] Reset your password` and an html body containing the `{{url}}` and `{{expiresAt}}` placeholders.
- AC-11 [unit] `ZH_TEMPLATES.PASSWORD_RESET` has a non-empty subject and an html body containing the `{{url}}` and `{{expiresAt}}` placeholders.
- AC-12 [unit] The email template seeder seeds a `PASSWORD_RESET` template for both `en` and `zh`.

### US-003

- AC-1 [integration] `POST /api/auth/password-reset` for an existing, enabled user with email configured answers 200 `{}`, and (the test polls up to 5 s for the detached task) a `PasswordResetToken` row appears for that user with `expiresAt` 30 minutes after the request and `usedAt` null.
- AC-2 [integration] The stored `tokenHash` is the lowercase sha256 hex of the raw token in the emailed `/reset-password/<raw>` URL, and the raw token is stored in no column.
- AC-3 [integration] The email is sent through `EmailDispatcher.sendOne` with template code `PASSWORD_RESET`, `data.url` equal to `EmailAvailability.webUrl('/reset-password/<raw>')`, and the sixth argument `false` (no retry).
- AC-4 [integration] One `EmailSchedule` row of kind `PASSWORD_RESET` with the user's id is written and ends in status `SENT` when the send succeeds.
- AC-5 [integration] When the email channel throws on send, the response is still 200 `{}` and the `EmailSchedule` row ends in status `FAILED`.
- AC-6 [integration] A request for an unknown address answers 200 `{}` and, after the same 5 s wait, no `PasswordResetToken` row and no `EmailSchedule` row exist for it.
- AC-7 [integration] A request for a disabled user answers 200 `{}` and writes no token row.
- AC-8 [integration] A request while email is not configured answers 200 `{}` and writes no token row.
- AC-9 [integration] A known and an unknown address both answer 200 with the same body, and neither raises `UnauditedWriteError` (the test runs with audit-coverage checking on, as the integration harness does).
- AC-10 [integration] A second request for the same user leaves exactly one unused token row for that user.
- AC-11 [integration] A request with `Accept-Language: zh-CN` writes the `EmailSchedule` row with locale `zh`; one with `Accept-Language: fr` writes `en`.
- AC-12 [integration] `POST /api/auth/password-reset` is throttled like `POST /api/auth/login`: after `AUTH_LOGIN_LIMIT` requests from one client inside `AUTH_LOGIN_TTL_MS`, the next answers 429.
- AC-13 [unit] The catalog entry for `session.password.reset.request` has access `public`.
- AC-14 [integration] After a reset request, a successful `POST /api/auth/password` by that user deletes the outstanding unused reset token, so confirming it later answers 400.
- AC-15 [integration] A body whose `email` is not an email address answers 400 and writes nothing.

### US-004

- AC-1 [integration] After `POST /api/auth/password-reset` for a user, `POST /api/auth/password-reset/confirm` with the emailed raw token and a valid `newPassword` answers 200 `{}`, and `POST /api/auth/login` then succeeds with `newPassword`.
- AC-2 [integration] After that confirm, the token row has `usedAt` set, and a second confirm with the same token answers 400 with the `auth.resetTokenInvalid` message.
- AC-3 [integration] A confirm with a token whose `expiresAt` is in the past answers 400 `auth.resetTokenInvalid` and leaves the password unchanged.
- AC-4 [integration] A confirm with an unknown token answers 400 `auth.resetTokenInvalid` and writes nothing.
- AC-5 [integration] A confirm for a user disabled after the request answers 400 `auth.resetTokenInvalid` and leaves the password unchanged.
- AC-6 [integration] A session of the user whose access token answered 200 on `GET /api/auth/me` before the confirm (so its activity is cached) is revoked with `revokedReason` `password-reset`, and that access token answers 401 on `GET /api/auth/me` right after the confirm.
- AC-7 [integration] A successful confirm raises the user's `tokenVersion` by one.
- AC-8 [integration] A successful confirm deletes the user's other unused reset tokens.
- AC-9 [integration] A successful confirm records exactly one audit entry `{ key: 'session.password.reset.confirm', resourceType: 'user', resourceId: <userId>, projectId: null, summary: 'password reset' }`.
- AC-10 [integration] Two concurrent confirms with the same token: exactly one answers 200 and the other answers 400 `auth.resetTokenInvalid`, and exactly one audit entry is recorded.
- AC-11 [integration] A confirm whose `newPassword` fails the complexity rule answers 400, and the token stays unused.
- AC-12 [integration] `POST /api/auth/password-reset/confirm` is throttled like `POST /api/auth/login`: after `AUTH_LOGIN_LIMIT` requests from one client inside `AUTH_LOGIN_TTL_MS`, the next answers 429.
- AC-13 [unit] The catalog entry for `session.password.reset.confirm` has access `public`.
- AC-14 [integration] The confirm issues no tokens: its response body carries no `accessToken` and no `refreshToken`, and no `AuthSession` row is created.

### US-005

- AC-1 [unit] `refreshClientOf('Mozilla/5.0 X', '203.0.113.7')` answers `{ uaHash: <lowercase sha256 hex of 'Mozilla/5.0 X'>, ip: '203.0.113.7' }`.
- AC-2 [unit] `refreshClientOf(undefined, undefined)` answers the sha256 hex of the empty string and `ip` null.
- AC-3 [unit] `refreshClientOf('UA', '')` answers `ip` null.
- AC-4 [integration] A first-use refresh with `User-Agent: UA-1` writes `usedUaHash` = sha256(`UA-1`) and a non-null `usedIp` on the presented token row.
- AC-5 [integration] Lost response with a matching User-Agent: after a refresh with `User-Agent: UA-1` whose successor is never used, a retry of the same token with `User-Agent: UA-1`, its `usedAt` backdated 31 s, answers 200 and the session stays active.
- AC-6 [integration] Lost response with a different User-Agent: the same retry with `User-Agent: UA-2` answers 401 and the session is revoked with `revokedReason` `reuse`.
- AC-7 [unit] `AuthSessionService.rotate` on the lost-response path with a matching `usedUaHash` and a `client.ip` different from the token's `usedIp` answers `{ kind: 'recovered', ip: <client.ip> }`.
- AC-8 [integration] After a real first-use refresh, the test sets the presented token's `usedUaHash` to null and backdates its `usedAt` 31 s; the lost-response retry then answers 401 and revokes the session as `reuse`.
- AC-9 [unit] `AuthService.refresh` given a `{ kind: 'recovered', ip: '198.51.100.9' }` rotation records `session.refresh` with summary `refresh token lost-response recovery; session kept; ip 198.51.100.9`.
- AC-10 [unit] `AuthService.refresh` given a `{ kind: 'recovered', ip: null }` rotation records the summary ending in `; ip unknown`.
- AC-11 [unit] `AuthSessionService.rotate` on the lost-response path with a different `usedUaHash` calls `revokeSession(sessionId, 'reuse', now)` and answers `{ kind: 'reused', userId }`.
- AC-12 [unit] `AuthController.refresh` called with a request whose `user-agent` header is `UA-1` and `ip` is `198.51.100.9` calls `AuthService.refresh` with `refreshClientOf('UA-1', '198.51.100.9')`.
- AC-13 [integration] A refresh inside the 30 s grace with a different User-Agent still answers 200 (step 4 is not bound).
- AC-14 [integration] A first-use refresh with a different User-Agent than the login answers 200 (step 3 is not bound).
- AC-15 [integration] The User-Agent-mismatch revocation of AC-6 records one `session.refresh` audit entry with summary `refresh token reuse; session revoked`.

### US-006

- AC-1 [unit] `forwardToApi` called for an event whose request has `user-agent: Mozilla/5.0 Test` sends the header `User-Agent: Mozilla/5.0 Test` to the API.
- AC-2 [unit] The SSR session-refresh middleware calling `/auth/refresh` for a request with `user-agent: UA-1` forwards `User-Agent: UA-1`.
- AC-3 [unit] `forwardToApi` for a request without a `user-agent` header sends no `User-Agent` header.
- AC-4 [unit] `usePasswordActions().changePassword({ currentPassword: 'a', newPassword: 'B' })` calls `$api.post('/auth/password', { currentPassword: 'a', newPassword: 'B' })`.
- AC-5 [unit] Submitting the account form with matching new and confirm values calls `changePassword` once with the current and new password.
- AC-6 [unit] Submitting with a confirm value different from the new password shows a validation message and does not call `changePassword`.
- AC-7 [unit] A successful change shows a success toast and clears all three fields.
- AC-8 [unit] A 403 from `changePassword` shows the `auth.account.currentPasswordWrong` text next to the current-password field.
- AC-9 [unit] A 500 from `changePassword` shows the `extractApiError` message.
- AC-10 [unit] The default layout header renders a link with `data-testid="header-account-link"` pointing to `/settings/account`.
- AC-11 [unit] Every new key under `auth.account` and `nav.account` exists in both `en.json` and `zh.json`.

### US-007

- AC-1 [unit] `usePasswordActions().requestReset('a@b.c')` calls `$api.post('/auth/password-reset', { email: 'a@b.c' })`.
- AC-2 [unit] `usePasswordActions().confirmReset('tok', 'NewPass1!')` calls `$api.post('/auth/password-reset/confirm', { token: 'tok', newPassword: 'NewPass1!' })`.
- AC-3 [unit] Submitting the forgot-password form shows the "check your email" state after `requestReset` resolves.
- AC-4 [unit] Submitting the forgot-password form shows the same "check your email" state after `requestReset` rejects.
- AC-5 [unit] Submitting the reset-password form on `/reset-password/tok` calls `confirmReset('tok', <new password>)` and, on success, navigates to `/login?reset=1`.
- AC-6 [unit] A 400 from `confirmReset` shows the invalid-or-expired state with a link to `/forgot-password`.
- AC-7 [unit] The reset-password form with a confirm value different from the new password shows a validation message and does not call `confirmReset`.
- AC-8 [unit] The login page renders a "Forgot password?" link to `/forgot-password`.
- AC-9 [unit] The login page shows the password-changed notice when the route query has `reset=1`, and not otherwise.
- AC-10 [unit] The auth middleware lets an anonymous visitor reach `/forgot-password` without redirecting to `/login`.
- AC-11 [unit] The auth middleware lets an anonymous visitor reach `/reset-password/abc` without redirecting to `/login`.
- AC-12 [unit] The auth middleware redirects an authenticated user on `/forgot-password` to `safeRedirectPath(to.query.redirect)`.
- AC-13 [unit] Every new key under `auth.forgot` and `auth.reset` exists in both `en.json` and `zh.json`.
