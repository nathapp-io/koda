import { Injectable, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AppException } from '../common/app-exception';
import { createHmac, randomBytes } from 'crypto';
import type { AgentRole } from '@prisma/client';

export interface CreateAgentDto {
  name: string;
  slug: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface UpdateAgentDto {
  name?: string;
  status?: string;
  maxConcurrentTickets?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface UpdateRolesDto {
  roles: string[];
}

export interface UpdateCapabilitiesDto {
  capabilities: string[];
}

@Injectable()
export class AgentsService {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async generateApiKey(agentId: string): Promise<{ apiKey: string; agent: any }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async findAll(): Promise<any[]> {
    return this.prisma.agent.findMany({
      include: {
        roles: true,
        capabilities: true,
      },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async findBySlug(slug: string): Promise<any> {
    const agent = await this.prisma.agent.findUnique({
      where: { slug },
      include: {
        roles: true,
        capabilities: true,
      },
    });

    if (!agent) {
      throw new AppException('agents.notFound', HttpStatus.NOT_FOUND);
    }

    return agent;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async findMe(agentId: string): Promise<any> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      include: {
        roles: true,
        capabilities: true,
      },
    });

    if (!agent) {
      throw new AppException('agents.notFound', HttpStatus.NOT_FOUND);
    }

    return agent;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async update(slug: string, updateData: UpdateAgentDto): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = {};
    if (updateData.name !== undefined) data.name = updateData.name;
    if (updateData.maxConcurrentTickets !== undefined) data.maxConcurrentTickets = updateData.maxConcurrentTickets;
    if (updateData.status !== undefined) data.status = updateData.status;

    return this.prisma.agent.update({
      where: { slug },
      data,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async updateRoles(agentId: string, updateData: UpdateRolesDto): Promise<any> {
    // Delete all existing roles
    await this.prisma.agentRoleEntry.deleteMany({
      where: { agentId },
    });

    // Create new roles if provided
    if (updateData.roles && updateData.roles.length > 0) {
      await this.prisma.agentRoleEntry.createMany({
        data: updateData.roles.map((role) => ({
          agentId,
          role: role as AgentRole,
        })),
      });
    }

    // Return updated agent with roles
    return this.prisma.agent.findUnique({
      where: { id: agentId },
      include: {
        roles: true,
        capabilities: true,
      },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async updateCapabilities(agentId: string, updateData: UpdateCapabilitiesDto): Promise<any> {
    // Delete all existing capabilities
    await this.prisma.agentCapability.deleteMany({
      where: { agentId },
    });

    // Create new capabilities if provided
    if (updateData.capabilities && updateData.capabilities.length > 0) {
      // Filter out duplicates
      const uniqueCapabilities = [...new Set(updateData.capabilities)];
      await this.prisma.agentCapability.createMany({
        data: uniqueCapabilities.map((capability) => ({
          agentId,
          capability,
        })),
      });
    }

    // Return updated agent with capabilities
    return this.prisma.agent.findUnique({
      where: { id: agentId },
      include: {
        roles: true,
        capabilities: true,
      },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async rotateApiKey(slug: string): Promise<{ apiKey: string; agent: any }> {
    // Find agent by slug to get the id
    const agent = await this.prisma.agent.findUnique({
      where: { slug },
    });

    if (!agent) {
      throw new AppException('agents.notFound', HttpStatus.NOT_FOUND);
    }

    // Rotate key using agent id
    return this.generateApiKey(agent.id);
  }
}
