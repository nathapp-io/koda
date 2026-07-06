import { Inject, Injectable } from '@nestjs/common';
import { JWT_OPTIONS, JwtRefreshStrategyProvider } from '@nathapp/nestjs-auth';
import type { IPrincipal } from '@nathapp/nestjs-auth';
import type { JwtOptions, Req } from '@nathapp/nestjs-auth/dist/strategy/type-interface';
import type { JwtPayload as RefreshJwtPayload } from '@nathapp/nestjs-auth/dist/strategy/type-interface';
import { PrismaAuthRepository } from './prisma-auth.repository';

/**
 * @nathapp/nestjs-auth's DefaultJwtRefreshStrategyProvider hardcodes `revoked: false`
 * and cannot be customized through the `authProvider` option (that only covers the
 * access-token strategy). We extend the refresh strategy directly so logout can also
 * invalidate outstanding refresh tokens via the same tokenVersion check.
 */
@Injectable()
export class KodaJwtRefreshStrategyProvider extends JwtRefreshStrategyProvider {
  constructor(
    @Inject(JWT_OPTIONS) jwtOptions: { refreshJwtOptions?: JwtOptions; jwtOptions: JwtOptions },
    private readonly authRepo: PrismaAuthRepository,
  ) {
    // Simplified version of the library's private resolveJwtRefreshOption: it also falls back
    // to jwtOptions when refreshJwtOptions has no secret/key, and inherits isBase64AsymmetricKey.
    // Our config always sets an explicit refreshJwtOptions.secret and never sets
    // isBase64AsymmetricKey, so those extra fallbacks are moot here.
    super(jwtOptions.refreshJwtOptions ?? jwtOptions.jwtOptions);
  }

  async validate<T = IPrincipal>(req: Req, payload: RefreshJwtPayload): Promise<T> {
    const refreshToken = this.jwtFromRequestFunction(req);
    const tokenVersion = (payload.tokenVersion as number | undefined) ?? 0;

    const user = await this.authRepo.findUserById(payload.sub);
    const revoked = !user || user.tokenVersion > tokenVersion;

    const principal: IPrincipal = {
      id: payload.sub,
      username: payload.username,
      name: payload.name,
      blacklisted: false,
      revoked,
      hashToken: refreshToken,
      // Matches the library's own DefaultJwtRefreshStrategyProvider: authorities are passed
      // through as-is, not narrowed to strings, since IPrincipal allows object-shaped entries too.
      authorities: (payload.authorities ?? []) as IPrincipal['authorities'],
    };
    return principal as unknown as T;
  }
}
