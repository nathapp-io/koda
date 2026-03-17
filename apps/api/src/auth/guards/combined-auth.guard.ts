import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ApiKeyAuthGuard } from './api-key-auth.guard';

@Injectable()
export class CombinedAuthGuard implements CanActivate {
  constructor(
    private jwtAuthGuard: JwtAuthGuard,
    private apiKeyAuthGuard: ApiKeyAuthGuard,
  ) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    // Try JWT first
    return Promise.resolve(this.jwtAuthGuard.canActivate(context))
      .then((result) => {
        if (result) return true;
        return false;
      })
      .catch(() => {
        // JWT failed, try API key
        return Promise.resolve(this.apiKeyAuthGuard.canActivate(context))
          .then((result) => {
            if (result) return true;
            return false;
          })
          .catch(() => {
            // Both failed
            throw new UnauthorizedException('Invalid credentials');
          });
      });
  }
}
