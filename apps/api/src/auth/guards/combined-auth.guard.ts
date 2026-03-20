import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ApiKeyAuthGuard } from './api-key-auth.guard';

@Injectable()
export class CombinedAuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private jwtAuthGuard: JwtAuthGuard,
    private apiKeyAuthGuard: ApiKeyAuthGuard,
  ) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    // Check if route is marked as public
    const isPublic = this.reflector.get<boolean>('isPublic', context.getHandler());
    if (isPublic) {
      return true;
    }

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
          .catch((err: Error) => {
            // Both failed
            throw new UnauthorizedException(err.message || 'Invalid credentials');
          });
      });
  }
}
