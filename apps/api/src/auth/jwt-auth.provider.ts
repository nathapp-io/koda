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
 * SECURITY: `projectRole` is NEVER read from the JWT. The CASL ability factory
 * honours `UserPrincipal.projectRole`, but the project membership role is
 * always resolved from the DB by ProjectMembershipGuard and re-attached via
 * `withProjectRole`. Allowing a forged JWT claim (e.g. `projectRole: 'ADMIN'`)
 * to leak into the principal would let a non-admin principal satisfy
 * `@ProjectPermission` checks that rely on the factory reading `projectRole`
 * before the guard runs (the global permission guard sees the principal
 * directly). We pick a curated allow-list of safe claims here so the threat
 * model stays explicit, even if a future contributor adds a JWT-driven role.
 */
@Injectable()
export class JwtAuthProvider implements AuthProvider {
  constructor(
    private readonly authRepo: PrismaAuthRepository,
    private readonly cache: CacheManager,
  ) {}

  async getPrincipal(jwtPayload: Record<string, unknown>): Promise<UserPrincipal> {
    // SECURITY: drop `projectRole` (and any future claim the CASL factory
    // trusts) so a forged JWT cannot escalate. Only the explicit list below
    // survives onto the principal.
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
      // Explicitly NOT carrying `projectRole` from the JWT — see SECURITY note
      // above. The factory would otherwise honour a forged claim on routes
      // guarded only by the global CASL permission guard (e.g. PATCH/DELETE
      // /api/comments/:id, where a project-role ADMIN claim would grant
      // unconditional DELETE Comment).
      projectRole: undefined,
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
