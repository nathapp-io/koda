import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { AppException } from '../../common/app-exception';

@Injectable()
export class AgentApiKeyGuard implements CanActivate {
  constructor(
    @Inject('PrismaService') private readonly prismaService: { client: { agent: { findFirst: (args: unknown) => Promise<unknown> } } },
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    const headers = request['headers'] as Record<string, string>;
    const authHeader = headers?.['authorization'] ?? '';

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppException('errors.unauthorized', HttpStatus.UNAUTHORIZED);
    }

    const rawKey = authHeader.slice('Bearer '.length).trim();
    if (!rawKey) {
      throw new AppException('errors.unauthorized', HttpStatus.UNAUTHORIZED);
    }

    const secret = this.configService.get<string>('API_KEY_SECRET');
    if (!secret) {
      throw new AppException('errors.unauthorized', HttpStatus.UNAUTHORIZED);
    }

    const keyHash = createHmac('sha256', secret).update(rawKey).digest('hex');

    const agent = await this.prismaService.client.agent.findFirst({
      where: { apiKeyHash: keyHash },
    });

    if (!agent) {
      throw new AppException('errors.unauthorized', HttpStatus.UNAUTHORIZED);
    }

    delete headers['authorization'];

    request['agent'] = agent;
    request['actorType'] = 'agent';

    return true;
  }
}
