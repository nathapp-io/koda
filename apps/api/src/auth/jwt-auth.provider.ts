import { Injectable } from '@nestjs/common';
import { AuthProvider, IPrincipal } from '@nathapp/nestjs-auth';

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
  async getPrincipal(jwtPayload: Record<string, unknown>): Promise<IPrincipal> {
    return {
      id: jwtPayload['sub'] as string,
      name: (jwtPayload['email'] as string) ?? (jwtPayload['sub'] as string),
      blacklisted: false,
      revoked: false,
      authorities: (jwtPayload['authorities'] as string[]) ?? [],
      extra: {
        sub: jwtPayload['sub'],
        email: jwtPayload['email'],
        role: jwtPayload['role'],
      },
    };
  }

  async isDuplicateLogin(): Promise<boolean> {
    return false;
  }
}
