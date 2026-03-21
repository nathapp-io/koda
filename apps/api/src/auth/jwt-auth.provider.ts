import { Injectable } from '@nestjs/common';

/**
 * Custom AuthProvider that preserves the JWT payload as the principal.
 * SimpleAuthProvider (default) only carries { id, name, blacklisted, revoked }
 * and drops role/email — causing req.user.role to be undefined.
 * This provider maps the raw JWT payload directly to the principal shape
 * while still satisfying the blacklist/revoke contract.
 */
@Injectable()
export class JwtAuthProvider {
  getPrincipal(jwtPayload: Record<string, unknown>) {
    return Promise.resolve({
      id: jwtPayload['sub'] as string,
      sub: jwtPayload['sub'] as string,   // keep sub so legacy .sub access works
      email: jwtPayload['email'] as string,
      role: jwtPayload['role'] as string,
      blacklisted: false,
      revoked: false,
      authorities: (jwtPayload['authorities'] as string[]) || [],
      extra: jwtPayload['extra'],
    });
  }

  isDuplicateLogin() {
    return Promise.resolve(false);
  }
}
