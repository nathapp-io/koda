import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { AuthException } from '@nathapp/nestjs-common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class AgentApiKeyGuard implements CanActivate {
  constructor(
    private readonly prismaService: PrismaService<PrismaClient>,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    const headers = request['headers'] as Record<string, string>;
    const authHeader = headers?.['authorization'] ?? '';

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthException({}, 'auth');
    }

    const rawKey = authHeader.slice('Bearer '.length).trim();
    if (!rawKey) {
      throw new AuthException({}, 'auth');
    }

    const secret = this.configService.get<string>('API_KEY_SECRET');
    if (!secret) {
      throw new AuthException({}, 'auth');
    }

    const keyHash = createHmac('sha256', secret).update(rawKey).digest('hex');

    const agent = await this.prismaService.client.agent.findFirst({
      where: { apiKeyHash: keyHash },
    });

    if (!agent) {
      throw new AuthException({}, 'auth');
    }

    delete headers['authorization'];

    request['agent'] = agent;
    request['actorType'] = 'agent';

    return true;
  }
}
