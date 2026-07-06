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
      authorities: (payload.authorities ?? []).filter((a): a is string => typeof a === 'string'),
    };
    return principal as unknown as T;
  }
}
