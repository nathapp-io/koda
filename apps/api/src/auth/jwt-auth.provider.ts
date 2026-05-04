import { Injectable } from '@nestjs/common';
import { AuthProvider } from '@nathapp/nestjs-auth';
import { UserPrincipal, KodaUserRole } from './principal/koda-principal.types';

/**
 * Custom AuthProvider that preserves JWT claims (role, email) in the principal.
 *
 * The default SimpleAuthProvider builds { id, name, blacklisted, revoked } and
 * drops role/email — causing req.user.role to be undefined in guards/controllers.
 *
 * We store role + email in IPrincipal.extra so they survive the principal pipeline
 * without breaking the IPrincipal contract.
 */
@Injectable()
export class JwtAuthProvider implements AuthProvider {
  async getPrincipal(jwtPayload: Record<string, unknown>): Promise<UserPrincipal> {
    const role = ((jwtPayload['role'] as KodaUserRole | undefined) ?? 'MEMBER') as KodaUserRole;
    const id = (jwtPayload['sub'] as string) ?? '';
    const email = (jwtPayload['email'] as string) ?? id;

    return {
      actorType: 'user',
      id,
      name: email,
      email,
      role,
      blacklisted: false,
      revoked: false,
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
