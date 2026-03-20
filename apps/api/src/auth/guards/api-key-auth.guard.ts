import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { createHmac } from 'crypto';

@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService<PrismaClient>,
  ) {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get db(): PrismaClient { return (this.prisma as any).client ?? (this.prisma as unknown as PrismaClient); }


  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // Extract Bearer token from Authorization header
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      throw new UnauthorizedException('Missing Authorization header');
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/);
    if (!match) {
      throw new UnauthorizedException('Invalid Authorization header format');
    }

    const rawKey = match[1];
    if (!rawKey) {
      throw new UnauthorizedException('Missing API key');
    }

    // Compute HMAC-SHA256 hash with API_KEY_SECRET
    const apiKeySecret = this.configService.get('API_KEY_SECRET');
    if (!apiKeySecret) {
      throw new Error('API_KEY_SECRET is not configured');
    }

    const hash = createHmac('sha256', apiKeySecret).update(rawKey).digest('hex');

    // Look up Agent by apiKeyHash
    const agent = await this.db.agent.findUnique({
      where: { apiKeyHash: hash },
    });

    if (!agent) {
      throw new UnauthorizedException('Invalid API key');
    }

    // Only ACTIVE agents allowed
    if (agent.status !== 'ACTIVE') {
      throw new UnauthorizedException('Agent is not active');
    }

    // Attach agent to request and set actorType
    request.agent = agent;
    request.actorType = 'agent';

    return true;
  }
}
