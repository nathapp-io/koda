import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { IS_PUBLIC_KEY, JwtAuthGuard } from '@nathapp/nestjs-auth';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { createHmac } from 'crypto';

@Injectable()
export class CombinedAuthGuard extends JwtAuthGuard {
  private readonly combinedLogger = new Logger(CombinedAuthGuard.name);

  constructor(
    private readonly myReflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    super(myReflector);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const clazz = context.getClass();

    const isPublic = this.myReflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, clazz]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    const authHeader = ((request['headers'] as Record<string, string>)?.['authorization']) ?? '';
    this.combinedLogger.debug(`canActivate: handler=${handler.name}, class=${clazz.name}`);

    // Try API Key first (deterministic: no JWT structure = potential API key)
    try {
      const isAgent = await this.tryApiKey(context);
      this.combinedLogger.debug(`tryApiKey result: ${isAgent}`);
      if (isAgent) {
        this.combinedLogger.debug(`API key auth succeeded, req.user=${JSON.stringify(request['user'])}`);
        return true;
      }
    } catch (e: any) {
      this.combinedLogger.error(`API key error: ${e.message}`);
    }

    // Fall back to JWT
    this.combinedLogger.debug('Falling back to JWT auth...');
    try {
      const result = await super.canActivate(context);
      this.combinedLogger.debug(`JWT canActivate result: ${result}, req.user set: ${request['user'] !== undefined}`);
      return result as boolean;
    } catch (e: any) {
      this.combinedLogger.debug(`JWT auth threw: ${e.message} (status: ${e.status})`);
      // Re-throw so the original 401/403 exception propagates correctly
      throw e;
    }
  }

  private async tryApiKey(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    const headers = request['headers'] as Record<string, string>;
    const authHeader = headers?.['authorization'] ?? '';

    if (!authHeader.startsWith('Bearer ')) return false;

    const rawKey = authHeader.slice('Bearer '.length).trim();
    if (!rawKey) return false;

    // JWTs always have exactly 3 dot-separated parts; skip them
    if (rawKey.split('.').length === 3) return false;

    const secret = this.config.get<string>('API_KEY_SECRET');
    if (!secret) {
      this.combinedLogger.error('API_KEY_SECRET not configured');
      return false;
    }

    const keyHash = createHmac('sha256', secret).update(rawKey).digest('hex');

    const agent = await (this.prisma.client as unknown as PrismaClient).agent.findFirst({
      where: { apiKeyHash: keyHash },
    });

    if (!agent) return false;

    request['agent'] = agent;
    request['actorType'] = 'agent';
    request['user'] = {
      id: (agent as Record<string, unknown>)['id'],
      extra: { actorType: 'agent', ...(agent as Record<string, unknown>) },
    };

    return true;
  }
}
