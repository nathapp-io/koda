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
    console.log('CombinedAuthGuard: trying JWT...');
    return Promise.resolve(this.jwtAuthGuard.canActivate(context))
      .then((result) => {
        console.log('CombinedAuthGuard: JWT result:', result);
        if (result) return true;
        return false;
      })
      .catch((err) => {
        console.log('CombinedAuthGuard: JWT failed:', err.message);
        // JWT failed, try API key
        console.log('CombinedAuthGuard: trying API Key...');
        return Promise.resolve(this.apiKeyAuthGuard.canActivate(context))
          .then((result) => {
            console.log('CombinedAuthGuard: API Key result:', result);
            if (result) return true;
            return false;
          })
          .catch((err2) => {
            console.log('CombinedAuthGuard: Both failed. Last error:', err2.message);
            // Both failed
            throw new UnauthorizedException('Invalid credentials');
          });
      });
  }
}
