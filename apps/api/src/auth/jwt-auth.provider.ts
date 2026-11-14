import { Injectable } from '@nestjs/common';
import { AuthProvider } from '@nathapp/nestjs-auth';
import { CacheManager } from '@nathapp/nestjs-cache';
import { UserPrincipal, KodaUserRole } from './principal/koda-principal.types';
import { PrismaAuthRepository } from './prisma-auth.repository';
import {
  SessionActivity,
  UserAuthState,
  authSessionCacheKey,
  userAuthStateCacheKey,
  userTokenVersionCacheTag,
  withAuthSessionCacheLock,
} from './token-version.cache';
import { AuthSessionService } from './sessions/auth-session.service';

/**
 * Custom AuthProvider that preserves JWT claims (role, email) in the principal.
 *
 * The default SimpleAuthProvider builds { id, name, blacklisted, revoked } and
 * drops role/email — causing req.user.role to be undefined in guards/controllers.
 *
 * We store role + email in IPrincipal.extra so they survive the principal pipeline
 * without breaking the IPrincipal contract.
 *
 * SECURITY: the claim allow-list below is the whole threat model. Permission decisions read keys
 * from `PermissionService`, never a claim; this provider still copies only `role`, `email`, `sub`,
 * `tokenVersion` and `sid` so a claim a future contributor might trust cannot reach the principal.
 * `sid` reaches the principal only as `sessionId`, and only to ask the session store whether that
 * session is still live (auth-sessions US-003): revoking one device must not need a `tokenVersion` bump
 * that ends every device.
 */
@Injectable()
export class JwtAuthProvider implements AuthProvider {
  constructor(
    private readonly authRepo: PrismaAuthRepository,
    private readonly cache: CacheManager,
    private readonly authSessions: AuthSessionService,
  ) {}

  async getPrincipal(jwtPayload: Record<string, unknown>): Promise<UserPrincipal> {
    // The claim allow-list — see the SECURITY note above. Nothing else survives onto the principal.
    const role = ((jwtPayload['role'] as KodaUserRole | undefined) ?? 'MEMBER') as KodaUserRole;
    const id = (jwtPayload['sub'] as string) ?? '';
    const email = (jwtPayload['email'] as string) ?? id;
    const tokenVersion = (jwtPayload['tokenVersion'] as number | undefined) ?? 0;
    // A legacy access token (issued before sessions) has no `sid`; it stays valid until it expires and
    // is checked by `tokenVersion` alone, exactly as before.
    const sid = typeof jwtPayload['sid'] === 'string' && jwtPayload['sid'].length > 0
      ? jwtPayload['sid']
      : undefined;

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

    // Cached as an object, not a boolean: a cached `false` would otherwise read as a miss. Every revoke
    // evicts this key directly, and the fill runs under the same per-session lock the evictions take, so
    // a lookup that read the store before a revoke cannot write its stale answer after the eviction
    // (see `withAuthSessionCacheLock`). A logout therefore takes effect on the next request.
    const activity = sid === undefined
      ? null
      : await withAuthSessionCacheLock(sid, () => this.cache.get<SessionActivity>(
        authSessionCacheKey(sid),
        async () => ({ active: await this.authSessions.isActive(sid, new Date()) }),
        60_000,
      ));

    return {
      actorType: 'user',
      id,
      name: email,
      email,
      role,
      blacklisted: false,
      revoked: !state || state.disabled || state.tokenVersion > tokenVersion || activity?.active === false,
      authorities: [role],
      extra: {
        sub: id,
        email,
        role,
      },
      ...(sid === undefined ? {} : { sessionId: sid }),
    };
  }

  async isDuplicateLogin(): Promise<boolean> {
    return false;
  }
}
