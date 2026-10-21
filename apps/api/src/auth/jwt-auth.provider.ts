import { Injectable } from '@nestjs/common';
import { AuthProvider } from '@nathapp/nestjs-auth';
import { CacheManager } from '@nathapp/nestjs-cache';
import { UserPrincipal, KodaUserRole } from './principal/koda-principal.types';
import { PrismaAuthRepository } from './prisma-auth.repository';
import { UserAuthState, userAuthStateCacheKey, userTokenVersionCacheTag } from './token-version.cache';

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
 * from `PermissionService`, never a claim; this provider still copies only `role`, `email`, `sub`
 * and `tokenVersion` so a claim a future contributor might trust cannot reach the principal.
 */
@Injectable()
export class JwtAuthProvider implements AuthProvider {
  constructor(
    private readonly authRepo: PrismaAuthRepository,
    private readonly cache: CacheManager,
  ) {}

  async getPrincipal(jwtPayload: Record<string, unknown>): Promise<UserPrincipal> {
    // The claim allow-list — see the SECURITY note above. Nothing else survives onto the principal.
    const role = ((jwtPayload['role'] as KodaUserRole | undefined) ?? 'MEMBER') as KodaUserRole;
    const id = (jwtPayload['sub'] as string) ?? '';
    const email = (jwtPayload['email'] as string) ?? id;
    const tokenVersion = (jwtPayload['tokenVersion'] as number | undefined) ?? 0;

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

    return {
      actorType: 'user',
      id,
      name: email,
      email,
      role,
      blacklisted: false,
      revoked: !state || state.disabled || state.tokenVersion > tokenVersion,
      authorities: [role],
      extra: {
        sub: id,
        email,
        role,
      },
    };
  }

  async isDuplicateLogin(): Promise<boolean> {
    return false;
  }
}
