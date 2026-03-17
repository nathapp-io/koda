import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { createHmac, randomBytes } from 'crypto';

export interface CreateAgentDto {
  name: string;
  slug: string;
}

@Injectable()
export class AgentsService {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  async generateApiKey(agentId: string): Promise<{ apiKey: string; agent: any }>;
  async generateApiKey(dto: CreateAgentDto): Promise<{ apiKey: string; agent: any }>;
  async generateApiKey(agentIdOrDto: string | CreateAgentDto) {
    // Generate random 32-byte hex key
    const rawKey = randomBytes(32).toString('hex');

    // Compute HMAC-SHA256 hash with API_KEY_SECRET
    const apiKeySecret = this.configService.get('API_KEY_SECRET');
    if (!apiKeySecret) {
      throw new Error('API_KEY_SECRET is not configured');
    }

    const apiKeyHash = createHmac('sha256', apiKeySecret).update(rawKey).digest('hex');

    // Determine if this is an update (string) or create (object)
    let agent;
    if (typeof agentIdOrDto === 'string') {
      // Update existing agent
      agent = await this.prisma.agent.update({
        where: { id: agentIdOrDto },
        data: { apiKeyHash },
      });
    } else {
      // Create new agent
      agent = await this.prisma.agent.create({
        data: {
          ...agentIdOrDto,
          apiKeyHash,
        },
      });
    }

    // Return raw key ONCE to client (never return the hash)
    return {
      apiKey: rawKey,
      agent,
    };
  }
}
